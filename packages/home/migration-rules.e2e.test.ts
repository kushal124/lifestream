import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeSchema, Schema, type Migration } from "@lifestreamprotocol/core";
import { ledgerSchema } from "@lifestreamprotocol/model";
import { afterAll, describe, expect, it } from "vitest";
import { migrationRules, type Values } from "./test/migration-rules.js";

const HOME: Values = {
  deliveries: { facts: '{"left":1}' },
  extracts: { days: '["2026-09-20"]', items: '["item-a"]' },
  extracts_next: { days: "[]", items: "[]" },
  rereads: { family: null, unit: null },
};
const LEDGER: Values = { requests: { prompt_hash: "synthetic prompts.hash" } };

const found: Record<string, unknown> = {};
afterAll(() => writeFileSync(join(tmpdir(), "home-migration-rules.json"), `${JSON.stringify(found, null, 2)}\n`));

function withMore(schema: Schema, ...more: Migration[]): Schema {
  return new Schema({
    name: schema.name, file: schema.file, base: schema.base, baseline: schema.baseline, migrations: [...schema.migrations, ...more],
    small: [...schema.small], indexed: [...schema.indexed], foreignKeys: schema.foreignKeys,
  });
}

describe("a migration is small", () => {
  it("a migration of home.db or of the ledger does big-table work", () => {
    found.home = migrationRules(homeSchema, HOME);
    found.ledger = migrationRules(ledgerSchema, LEDGER);
    expect(found.home).toEqual([]);
    expect(found.ledger).toEqual([]);
  });

  it("the ledger's call items are a big table, made empty by an index migration", () => {
    expect(ledgerSchema.small.has("call_items")).toBe(false);
    expect(ledgerSchema.indexed.has(15)).toBe(true);
    expect(migrationRules(new Schema({
      name: ledgerSchema.name, file: ledgerSchema.file, base: ledgerSchema.base, baseline: ledgerSchema.baseline, migrations: ledgerSchema.migrations,
      small: [...ledgerSchema.small], indexed: [...ledgerSchema.indexed].filter((version) => version !== 15), foreignKeys: ledgerSchema.foreignKeys,
    }), LEDGER).sort()).toEqual(["migration 15 indexes call_items, a big table (call_items_day), and is not on the list of index migrations", "migration 15 indexes call_items, a big table (call_items_record), and is not on the list of index migrations"]);
  });

  it("the helper passes big-table work on home.db", () => {
    const next = homeSchema.latest + 1;
    const cases: Record<string, [Migration, string[]]> = {
      "rows of one state": [(db) => db.exec("DELETE FROM enrichments WHERE state = 'pending'"), [`migration ${next} writes the rows of enrichments, a big table`]],
      "a column added": [(db) => db.exec("ALTER TABLE statements ADD COLUMN synthetic TEXT"), [`migration ${next} changes the columns of statements, a big table`]],
      "a table made again": [(db) => db.exec(`CREATE TABLE days_new (day TEXT NOT NULL, inputs TEXT NOT NULL, counts TEXT NOT NULL, PRIMARY KEY (day)) STRICT, WITHOUT ROWID;
        INSERT INTO days_new SELECT * FROM days;
        DROP TABLE days;
        ALTER TABLE days_new RENAME TO days`), [`migration ${next} makes days, a big table, again`]],
      "a big table made and filled": [(db) => db.exec("CREATE TABLE synthetic_beside (seq INTEGER PRIMARY KEY) STRICT; INSERT INTO synthetic_beside SELECT seq FROM statements"),
        [`migration ${next} fills synthetic_beside, a big table it makes`]],
      "an index off the list": [(db) => db.exec("CREATE INDEX synthetic_late ON statements (late)"),
        [`migration ${next} indexes statements, a big table (synthetic_late), and is not on the list of index migrations`]],
    };
    const seen: Record<string, string[]> = {};
    for (const [name, [migration, expected]] of Object.entries(cases)) {
      seen[name] = migrationRules(withMore(homeSchema, migration), HOME);
      expect(seen[name], name).toEqual(expect.arrayContaining(expected));
    }
    found.homeCaught = seen;
  });

  it("the helper passes big-table work on the ledger, or fails a big table made empty", () => {
    const next = ledgerSchema.latest + 1;
    expect(migrationRules(withMore(ledgerSchema, (db) => db.exec("UPDATE requests SET body = 'synthetic body'")), LEDGER))
      .toEqual([`migration ${next} writes the rows of requests, a big table`]);
    expect(migrationRules(withMore(ledgerSchema, (db) => db.exec("ALTER TABLE requests ADD COLUMN synthetic TEXT")), LEDGER))
      .toEqual(expect.arrayContaining([`migration ${next} changes the columns of requests, a big table`]));
    expect(migrationRules(withMore(ledgerSchema, (db) => db.exec("CREATE TABLE request_notes (key TEXT PRIMARY KEY); INSERT INTO request_notes SELECT key FROM requests")), LEDGER))
      .toEqual([`migration ${next} fills request_notes, a big table it makes`]);
    expect(migrationRules(withMore(ledgerSchema, (db) => db.exec("CREATE TABLE request_notes (key TEXT PRIMARY KEY, note TEXT NOT NULL)")), LEDGER)).toEqual([]);
    expect(migrationRules(withMore(homeSchema, (db) => db.exec("CREATE TABLE synthetic_beside (seq INTEGER PRIMARY KEY, note TEXT NOT NULL) STRICT")), HOME)).toEqual([]);
  });

  it("the outbound list's what widened in place is small; a list narrowed in place, or a table made again to widen it, is caught", () => {
    const next = ledgerSchema.latest + 1;
    const rewritten = (now: string): Migration => (db) => {
      const stored = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'outbound'").pluck().get() as string;
      const version = db.pragma("schema_version", { simple: true }) as number;
      db.unsafeMode(true);
      db.pragma("writable_schema = ON");
      db.prepare("UPDATE sqlite_schema SET sql = ? WHERE type = 'table' AND name = 'outbound'").run(stored.replace(/CHECK\(what IN \([^)]*\)\)/u, now));
      db.pragma(`schema_version = ${version + 1}`);
      db.pragma("writable_schema = OFF");
      db.unsafeMode(false);
    };
    expect(migrationRules(ledgerSchema, LEDGER)).toEqual([]);
    expect(migrationRules(withMore(ledgerSchema, rewritten("CHECK(what IN ('ask','read','text','link','lookup','feedback','synthetic'))")), LEDGER)).toEqual([]);
    expect(migrationRules(withMore(ledgerSchema, rewritten("CHECK(what IN ('ask','read','text','link','lookup'))")), LEDGER))
      .toEqual([`migration ${next} changes the stored text of outbound, a big table`]);
    expect(migrationRules(withMore(ledgerSchema, rewritten("CHECK(what IN ('ask','read','text','link','lookup','feedback')) CHECK(chars >= 0)")), LEDGER))
      .toEqual([`migration ${next} changes the stored text of outbound, a big table`]);
    expect(migrationRules(withMore(ledgerSchema, (db) => db.exec(`CREATE TABLE outbound_next(seq INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL, receiver TEXT NOT NULL, route TEXT, by TEXT,
        what TEXT NOT NULL CHECK(what IN ('ask','read','text','link','lookup','feedback','synthetic')), tool TEXT, level TEXT NOT NULL, counts TEXT NOT NULL,
        chars INTEGER NOT NULL, pictures INTEGER NOT NULL, detector TEXT, key TEXT, attempt INTEGER);
      INSERT INTO outbound_next (seq, at_ms, receiver, route, by, what, tool, level, counts, chars, pictures, detector, key, attempt)
        SELECT seq, at_ms, receiver, route, by, what, tool, level, counts, chars, pictures, detector, key, attempt FROM outbound;
      DROP TABLE outbound;
      ALTER TABLE outbound_next RENAME TO outbound;
      CREATE INDEX outbound_at ON outbound(at_ms);
      CREATE INDEX outbound_key ON outbound(key) WHERE key IS NOT NULL`)), LEDGER)).toEqual(expect.arrayContaining([`migration ${next} makes outbound, a big table, again`]));
  });
});
