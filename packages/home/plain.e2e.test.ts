import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openHome, openHomeFolder } from "@lifestreamprotocol/core";
import type { DayDocument } from "@lifestreamprotocol/families";
import { dayPath } from "./derive.js";
import { startHome, type Home } from "./home.js";
import { searchFileOf } from "./search-index.js";
import { artifact, makeRoot, readHome, removeRoot, until, TICK_MS } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { count, quiet } from "./test/derived.js";
import { PLAIN_FILE } from "./test/plain-registry.js";

const REGISTRY = new URL("./test/plain-registry.ts", import.meta.url).pathname;
const SOURCE = "example-log:local:test";
const AT = Date.UTC(2026, 8, 28, 10, 0);
const DAY = "2026-09-28";
const PAIR = `${SOURCE}\0line`;

function plainAtoms(root: string): DayDocument["atoms"] {
  try {
    return (JSON.parse(readFileSync(dayPath(root, DAY, "json"), "utf8")) as DayDocument).atoms.filter((atom) => atom.family === "plain");
  } catch {
    return [];
  }
}

function counted(root: string): Record<string, number> {
  try {
    return (JSON.parse(readFileSync(dayPath(root, DAY, "json"), "utf8")) as DayDocument).counts.per_family;
  } catch {
    return {};
  }
}

function indexed(root: string): { entry?: Record<string, unknown>; owner?: string } {
  let db: Database.Database;
  try {
    db = new Database(searchFileOf(root, process.env.LIFESTREAM_MACHINE_DIR!), { readonly: true, fileMustExist: true, timeout: 10_000 });
  } catch {
    return {};
  }
  try {
    const entry = db.prepare("SELECT family, title, text, link FROM records WHERE source = ? AND kind = 'line'").get(SOURCE) as Record<string, unknown> | undefined;
    const texts = db.prepare("SELECT value FROM meta WHERE key = 'texts'").pluck().get() as string | undefined;
    const owner = texts === undefined ? undefined : (JSON.parse(texts) as { owners: Record<string, string> }).owners[PAIR];
    return { ...(entry === undefined ? {} : { entry }), ...(owner === undefined ? {} : { owner }) };
  } finally {
    db.close();
  }
}

function generations(root: string): Record<string, number> {
  return Object.fromEntries((readHome(root, (db) => db.prepare("SELECT name, generation FROM cursors WHERE name LIKE 'extract:%' OR name LIKE 'rebuild:%'").all()) as { name: string; generation: number }[])
    .map((row) => [row.name, row.generation]));
}

describe("the plain line", () => {
  let root: string;
  let home: Home | undefined;

  beforeAll(async () => {
    root = makeRoot("lifestream-plain-", { sources: {} });
    writeFileSync(join(root, PLAIN_FILE), JSON.stringify({ digest: "sha256:folder-a" }));
    const db = openHome(openHomeFolder(root), "migrate");
    db.commit((tx) => tx.tables.sources.add({ id: SOURCE, vendor: "example", connector: "example-log-lines", added_ms: 0 }));
    db.close();
    home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: REGISTRY, log: () => undefined });
  });

  afterAll(async () => {
    await home?.stop().catch(() => undefined);
    if (root !== undefined) removeRoot(root);
  });

  it("a home connector's line reaches no day file or no search entry, or its pair is owned without its folder's digest", async () => {
    await ship(root, { source: SOURCE, fetched_ms: AT + 60_000, rows: [{ kind: "line", key: "deploy-1", content: { at: AT, words: "deployed the site", title: "Deploy", link: "https://example.com/deploys/1" }, at: AT }] as never });
    await until("the day file prints the line", () => plainAtoms(root).length === 1);
    const [atom] = plainAtoms(root);
    expect({ text: atom!.text, record: atom!.record, block: atom!.block, type: atom!.type }).toEqual({
      text: "Deploy: deployed the site", record: { source: SOURCE, kind: "line", key: "deploy-1" }, block: { key: SOURCE, title: "Example log" }, type: "notes",
    });
    await until("the index holds the line", () => indexed(root).entry !== undefined && indexed(root).owner !== undefined);
    expect(indexed(root)).toEqual({
      entry: { family: "plain", title: "Deploy", text: "deployed the site", link: "https://example.com/deploys/1" },
      owner: "plain/1/sha256:folder-a",
    });
    artifact(root, "plain-line", { atom, indexed: indexed(root) });
  });

  it("an edit of the folder walks no plain extract, or walks another family, or leaves its search pair owned by the old digest", async () => {
    await until("the home at rest", () => quiet(root));
    const before = generations(root);
    await home!.stop();
    home = undefined;
    writeFileSync(join(root, PLAIN_FILE), JSON.stringify({ digest: "sha256:folder-b" }));
    home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: REGISTRY, log: () => undefined });
    await until("the plain family walked and published", () => quiet(root) && generations(root)["rebuild:plain"] === before["rebuild:plain"]! + 1 &&
      count(root, "SELECT count(*) FROM cursors WHERE name = 'rebuild:plain' AND seq > 0") === 0);
    const after = generations(root);
    expect(Object.keys(after).filter((name) => after[name] !== before[name])).toEqual(["rebuild:plain"]);
    await until("the index owns the pair by the new digest", () => indexed(root).owner === "plain/1/sha256:folder-b");
    expect(indexed(root).entry).toEqual({ family: "plain", title: "Deploy", text: "deployed the site", link: "https://example.com/deploys/1" });
    expect(plainAtoms(root).map((atom) => atom.text)).toEqual(["Deploy: deployed the site"]);
    artifact(root, "folder-edited", { before, after, indexed: indexed(root) });
  });

  it("a release that adds or drops a family leaves a day's file as it was, or builds an extract again", async () => {
    await until("the home at rest", () => quiet(root));
    const before = generations(root);
    expect(counted(root).plain).toBe(1);
    const restart = async (file: { digest: string; without?: string }) => {
      await home!.stop();
      home = undefined;
      writeFileSync(join(root, PLAIN_FILE), JSON.stringify(file));
      home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: REGISTRY, log: () => undefined });
    };
    await restart({ digest: "sha256:folder-b", without: "plain" });
    await until("the day rendered without the plain family", () => quiet(root) && !("plain" in counted(root)));
    const dropped = counted(root);
    await restart({ digest: "sha256:folder-b" });
    await until("the day rendered with the plain family", () => quiet(root) && counted(root).plain === 1);
    expect(generations(root)).toEqual(before);
    expect(plainAtoms(root).map((atom) => atom.text)).toEqual(["Deploy: deployed the site"]);
    artifact(root, "families-changed", { before, dropped, added: counted(root), after: generations(root) });
  });
});
