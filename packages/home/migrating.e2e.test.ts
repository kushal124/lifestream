import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { homeSchema, openHomeFolder, STORED_MARK, type JsonObject } from "@lifestreamprotocol/core";
import { ledgerSchema } from "@lifestreamprotocol/model";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { startHome } from "./home.js";
import { report } from "./report.js";
import { artifact, FAKES, makeRoot, removeRoot } from "./test/harness-root.js";
import { REPO } from "./test/support.js";

interface Fixture { meta: { key: string; value: string }[]; objects: { sql: string }[] }
const fixture = (path: string) => JSON.parse(readFileSync(join(REPO, path), "utf8")) as Fixture;
const HOME_V22 = fixture("packages/core/test/home-v22.json");
const LEDGER_V3 = fixture("packages/model/test/ledger-v3.json");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) removeRoot(root);
});

function oldScheme(path: string, of: Fixture, more: { key: string; value: string }[]): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  const db = new Database(path);
  try {
    db.pragma("journal_mode = WAL");
    db.exec(of.objects.map((object) => `${object.sql};`).join("\n"));
    const meta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
    for (const row of [...of.meta, ...more]) meta.run(row.key, row.value);
  } finally {
    db.close();
  }
}

function oldRoot(prefix: string): string {
  const root = makeRoot(prefix, { sources: {} });
  roots.push(root);
  const home = join(root, "home.db");
  const db = new Database(home, { readonly: true });
  const meta = db.prepare("SELECT key, value FROM meta WHERE key NOT IN ('floor', ?)").all(STORED_MARK) as { key: string; value: string }[];
  db.close();
  oldScheme(home, HOME_V22, [...meta, { key: "floor", value: "3963" }]);
  oldScheme(join(root, "replies", "replies.db"), LEDGER_V3, []);
  return root;
}

function versions(root: string): { home: number; ledger: number } {
  const read = (path: string) => {
    const db = new Database(path, { readonly: true });
    try {
      return db.pragma("user_version", { simple: true }) as number;
    } finally {
      db.close();
    }
  };
  return { home: read(join(root, "home.db")), ledger: read(join(root, "replies", "replies.db")) };
}

const migrations = (lines: JsonObject[]) => lines.filter((line) => ["migrating", "migrated", "migration_failed"].includes(String(line.home)))
  .map(({ ms, at: _at, ...rest }) => ({ ...rest, ...(ms === undefined ? {} : { ms: Object.keys(ms as JsonObject) }) }));
const EXPECTED = [
  { home: "migrating", file: "home.db", from: 22, to: homeSchema.latest },
  { home: "migrated", file: "home.db", from: 22, to: homeSchema.latest, ms: Array.from({ length: homeSchema.latest - 22 }, (_, at) => String(23 + at)) },
  { home: "migrating", file: "replies.db", from: 3, to: ledgerSchema.latest },
  { home: "migrated", file: "replies.db", from: 3, to: ledgerSchema.latest, ms: [...Array.from({ length: ledgerSchema.latest - 3 }, (_, at) => String(4 + at)), "foreign_key_check"] },
];

function raw(path: string, work: (db: Database.Database) => void): void {
  const db = new Database(path);
  try {
    work(db);
  } finally {
    db.close();
  }
}

function bytes(root: string): { home: string; ledger: string } {
  const of = (path: string) => {
    const hash = createHash("sha256").update(readFileSync(path));
    if (existsSync(`${path}-wal`)) hash.update(readFileSync(`${path}-wal`));
    return hash.digest("hex");
  };
  return { home: of(join(root, "home.db")), ledger: of(join(root, "replies", "replies.db")) };
}

function shortLedger(prefix: string): string {
  const root = oldRoot(prefix);
  raw(join(root, "replies", "replies.db"), (db) => db.exec("DROP INDEX requests_unit"));
  return root;
}
const SHORT = `the ledger is not this release's at version 3 (index requests_unit is missing): this release cannot read it`;

describe("a migration's lines", () => {
  it("the home's start migrates unlogged, after it says it started, or leaves a file at another version", async () => {
    const root = oldRoot("lifestream-migrating-start-");
    const lines: JsonObject[] = [];
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: (line) => lines.push(JSON.parse(line) as JsonObject) });
    await home.stop();
    expect(migrations(lines)).toEqual(EXPECTED);
    const started = lines.findIndex((line) => line.home === "started");
    expect(started).toBeGreaterThan(lines.findIndex((line) => line.home === "migrated" && line.file === "replies.db"));
    expect(versions(root)).toEqual({ home: homeSchema.latest, ledger: ledgerSchema.latest });
    artifact(root, "migrating", { start: migrations(lines) });
  });

  it("a verb with no home running migrates unlogged, or leaves a file at another version", async () => {
    const root = oldRoot("lifestream-migrating-verb-");
    const out: string[] = [];
    expect(await runCli(["pause", "kind:repair", "--reason", "a test", "--root", root], { write: (text) => out.push(text) })).toBe(0);
    const lines = out.join("").split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as JsonObject);
    expect(migrations(lines)).toEqual(EXPECTED);
    expect(versions(root)).toEqual({ home: homeSchema.latest, ledger: ledgerSchema.latest });
    const again: string[] = [];
    expect(await runCli(["resume", "kind:repair", "--root", root], { write: (text) => again.push(text) })).toBe(0);
    expect(again.join("")).not.toMatch(/"migrat/u);
    artifact(root, "migrating", { verb: migrations(lines) });
  });

  it("the home's start migrates home.db when it cannot migrate the ledger, and status migrates what it reports on", async () => {
    const root = shortLedger("lifestream-migrating-short-start-");
    const before = bytes(root);
    const lines: JsonObject[] = [];
    await expect(startHome(root, { stopGraceMs: 50, registry: FAKES, log: (line) => lines.push(JSON.parse(line) as JsonObject) })).rejects.toThrow(SHORT);
    expect(migrations(lines)).toEqual([]);
    expect(bytes(root)).toEqual(before);
    const out: string[] = [];
    expect(await runCli(["status", "--root", root], { write: (text) => out.push(text) })).toBe(1);
    expect(out.join("").trim().split("\n")).toEqual([
      `home.db is at version 22; this release reads ${homeSchema.latest}: the home has not started this release yet`,
      `the ledger is at version 3; this release reads ${ledgerSchema.latest}: the home has not started this release yet`,
      SHORT,
    ]);
    expect(bytes(root)).toEqual(before);
    artifact(root, "migrating", { start: lines.filter((line) => line.home !== undefined), status: out.join("").trim() });
  });

  it("a verb with no home running migrates home.db when it cannot migrate the ledger", async () => {
    const root = shortLedger("lifestream-migrating-short-verb-");
    const before = bytes(root);
    const out: string[] = [];
    expect(await runCli(["pause", "kind:repair", "--reason", "a test", "--root", root], { write: (text) => out.push(text) })).toBe(1);
    expect(out.join("")).toContain(SHORT);
    expect(out.join("")).not.toMatch(/"migrat/u);
    expect(bytes(root)).toEqual(before);
    expect(versions(root)).toEqual({ home: 0, ledger: 0 });
    artifact(root, "migrating", { verb: out.join("").trim() });
  });

  it("the report reads a home.db or a ledger at another version than this release's", async () => {
    const window = { from_ms: 0, to_ms: 1 };
    const lower = oldRoot("lifestream-migrating-report-lower-");
    await expect(report(openHomeFolder(lower), window)).rejects.toThrow(`home.db is at version 22; this release reads ${homeSchema.latest}: the home has not started this release yet`);
    const higher = makeRoot("lifestream-migrating-report-higher-", { sources: {} });
    roots.push(higher);
    raw(join(higher, "replies", "replies.db"), (db) => db.pragma(`user_version = ${ledgerSchema.latest + 1}`));
    await expect(report(openHomeFolder(higher), window)).rejects.toThrow(`the ledger is at version ${ledgerSchema.latest + 1}; this release reads ${ledgerSchema.latest}: a newer release wrote it`);
    raw(join(higher, "home.db"), (db) => db.pragma(`user_version = ${homeSchema.latest + 1}`));
    await expect(report(openHomeFolder(higher), window)).rejects.toThrow(`home.db is at version ${homeSchema.latest + 1}; this release reads ${homeSchema.latest}: a newer release wrote it`);
  });
});
