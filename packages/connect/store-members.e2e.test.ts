import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import type { Delivery, JsonObject, ReaderOutput } from "@lifestreamprotocol/core";
import { describe, expect, it } from "vitest";
import { roadsOf, type Connector, type SqliteStore } from "./declaration.js";
import { FOLDERS } from "./folders.js";
import type { Reader } from "./seams.js";
import { openZip } from "./shared/zip.js";
import { artifact, CONNECT_ROOT, deliver, openTestHome, temp, type Fixture, type TestHome } from "./test/drive.js";

interface Read {
  source: string;
  facts: JsonObject;
  files: Record<string, Buffer>;
}

function storeOf(stores: readonly SqliteStore[], path: string): SqliteStore | undefined {
  return stores.find((store) => store.member === path) ??
    stores.find((store) => store.member === "<name>" && store.match !== undefined && new RegExp(store.match, "u").test(path));
}

function declaredOnly(bytes: Buffer, store: SqliteStore, dir: string): { bytes: Buffer; left: string[] } {
  const path = join(mkdtempSync(join(dir, "member-")), "member.sqlite");
  writeFileSync(path, bytes);
  const db = new Database(path);
  try {
    db.pragma("journal_mode = DELETE");
    db.pragma("foreign_keys = OFF");
    const declared = new Set(store.tables.map((table) => table.name));
    const objects = db.prepare("SELECT type, name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'").all() as { type: string; name: string }[];
    const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
    for (const { type, name } of objects) if (type === "trigger") db.exec(`DROP TRIGGER ${quoted(name)}`);
    for (const { type, name } of objects) if (type === "view") db.exec(`DROP VIEW ${quoted(name)}`);
    const left = objects.filter(({ type, name }) => type === "table" && !declared.has(name)).map(({ name }) => name);
    for (const name of left) db.exec(`DROP TABLE ${quoted(name)}`);
    db.exec("VACUUM");
    return { bytes: readFileSync(path), left };
  } finally {
    db.close();
  }
}

async function rows(reader: Reader, home: TestHome, read: Read): Promise<string[]> {
  const delivery: Delivery = deliver(home, read.source, read.files, read.facts);
  const out: string[] = [];
  for await (const row of reader.read(delivery, home.blobs)) out.push(spelled(row));
  return out;
}

function spelled(row: ReaderOutput): string {
  const { kind, key, content, time, blobs, gone, refused, member } = row;
  return JSON.stringify({ kind, key, content, time, blobs, gone, refused, member }, (_, value: unknown) => (typeof value === "bigint" ? `${value}n` : value));
}

function bundle(home: TestHome, zip: string): Read {
  const opened = openZip(zip);
  try {
    const files: Record<string, Buffer> = {};
    let manifest: { source_id: string; facts: JsonObject } | undefined;
    for (const entry of opened.entries()) {
      if (entry.name === "manifest.json") manifest = JSON.parse(entry.bytes().toString("utf8")) as typeof manifest;
      else if (entry.name.startsWith("blobs/")) home.blobs.put(entry.bytes());
      else files[entry.name] = entry.bytes();
    }
    if (manifest === undefined) throw new Error(`${zip} holds no manifest`);
    return { source: manifest.source_id, facts: manifest.facts, files };
  } finally {
    opened.close();
  }
}

function fixtureRead(home: TestHome, fixture: Fixture, dir: string): Read {
  const folder = mkdtempSync(join(dir, "fixture-"));
  const stated = fixture(folder);
  const carried = join(folder, "blobs");
  for (const hex of existsSync(carried) ? readdirSync(carried) : []) home.blobs.put(readFileSync(join(carried, hex)));
  const files = Object.fromEntries(Object.keys(stated.files).map((path) => [path, readFileSync(join(folder, path))]));
  return { source: stated.source, facts: { fetched_at: "2026-09-23T04:00:00.000Z", ...stated.facts }, files };
}

describe("a store's file holds only its declared tables: each of these is impossible", () => {
  it("a release store's reader reads more than its store declares, or goes unheld", async () => {
    const dir = temp("store-members-");
    const held: Record<string, Record<string, string[]>> = {};
    const unheld: string[] = [];
    for (const { folder, module } of FOLDERS) {
      const provider = module as { connectors?: readonly Connector[]; readers?: readonly Reader[] };
      for (const connector of provider.connectors ?? []) {
        const engine = connector.mac?.store?.engine;
        if (engine?.kind !== "sqlite") continue;
        const fixtures = ((await import(pathToFileURL(join(CONNECT_ROOT, folder, "test", "fixture.ts")).href)) as { fixtures?: Record<string, Fixture> }).fixtures ?? {};
        const zip = join(CONNECT_ROOT, folder, "test", "changes-bundle.zip");
        for (const name of new Set(connector.sources.filter((source) => roadsOf(source).includes("mac")).map((source) => source.read))) {
          const reader = provider.readers?.find((each) => each.name === name);
          const fixture = fixtures[name];
          if (reader === undefined || fixture === undefined) {
            unheld.push(`${connector.id}: ${reader === undefined ? "no reader" : "no fixture"} ${name}`);
            continue;
          }
          const home = openTestHome("store-members-");
          const reads: [string, Read][] = [["fixture", fixtureRead(home, fixture, dir)], ...(existsSync(zip) ? [["changes-bundle.zip", bundle(home, zip)] as [string, Read]] : [])];
          for (const [what, read] of reads) {
            const files: Record<string, Buffer> = {};
            const left: string[] = [];
            for (const [path, bytes] of Object.entries(read.files)) {
              const store = storeOf(engine.stores, path);
              if (store === undefined) files[path] = bytes;
              else {
                const pruned = declaredOnly(bytes, store, dir);
                files[path] = pruned.bytes;
                left.push(...pruned.left.map((table) => `${path}:${table}`));
              }
            }
            const label = `${connector.id} ${name} over its ${what}`;
            const whole = await rows(reader, home, read);
            expect(whole.length, `${label}: the whole delivery yields rows`).toBeGreaterThan(0);
            expect(await rows(reader, home, { ...read, files }), `${label}, its undeclared tables dropped (${left.join(", ") || "none"})`).toEqual(whole);
            (held[connector.id] ??= {})[what] = left;
          }
        }
      }
    }
    artifact(dir, "store-members.json", { held, unheld });
    expect(unheld).toEqual([]);
    expect(Object.keys(held).length, "the release's sqlite stores").toBeGreaterThan(0);
    expect(Object.values(held).flatMap((each) => Object.values(each).flat()).length, "a fixture holds a table its store does not declare").toBeGreaterThan(0);
  });
});
