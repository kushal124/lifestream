import { artifact, collect, damageOverflow, temp } from "../test/drive.js";
import { closeSync, openSync, readdirSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { each, refuse, Refused } from "./refused.js";
import { databaseWindow, openSqlite, rowJson, type DatabaseWindow, type TableRow } from "./sqlite.js";
import { chatStore } from "./sqlite.test-support.js";

function sealDelta(source: string, path: string, after: number): void {
  const db = new Database(source, { readonly: true });
  db.prepare("VACUUM INTO ?").run(path);
  db.close();
  const delta = new Database(path);
  delta.exec(`DELETE FROM ZWAMESSAGE WHERE NOT (Z_PK > ${after}
    OR Z_PK IN (SELECT ZPARENTMESSAGE FROM ZWAMESSAGE WHERE Z_PK > ${after}))`);
  delta.exec("VACUUM");
  delta.close();
}

const keys = (rows: Iterable<TableRow>): bigint[] => [...rows].map((row) => row.read().Z_PK as bigint);

describe("SQLite snapshot and delta readers: each of these is impossible", () => {
  it("a file that is no database leaves its handle open, or is disposed of while open", () => {
    const dir = temp();
    const path = join(dir, "not-a-database.db");
    writeFileSync(path, Buffer.alloc(8192, "not a sqlite file "));
    const open = () => readdirSync("/dev/fd").length;
    const before = open();
    let disposed = 0;
    for (let attempt = 0; attempt < 30; attempt++) {
      expect(() => openSqlite(path, () => {
        expect(open()).toBe(before);
        disposed++;
      })).toThrow(Refused);
    }
    expect(disposed).toBe(30);
    expect(open()).toBe(before);
    artifact(dir, "rejected.json", { before, after: open(), disposed });
  });


  it("a delta read yields a row outside its window, or misses one inside it", () => {
    const dir = temp();
    const source = join(dir, "ChatStorage.sqlite");
    const deltaPath = join(dir, "delta.sqlite");
    chatStore(source, 200);
    sealDelta(source, deltaPath, 180);
    const window = databaseWindow({ kind: "delta", after: 180, through: 200 });
    const db = openSqlite(deltaPath);
    try {
      const read = keys(db.rows("ZWAMESSAGE", "Z_PK", { window, page: 7 }));
      expect(read).toEqual(Array.from({ length: 20 }, (_, index) => BigInt(181 + index)));
      const parent = db.get("SELECT Z_PK FROM ZWAMESSAGE WHERE Z_PK = ?", 175n);
      expect(parent?.Z_PK).toBe(175n);
      expect(keys(db.rows("ZWACHATSESSION", "Z_PK"))).toEqual([1n, 2n]);
      artifact(dir, "delta-window.json", { window: { after: 180, through: 200 }, read: read.map(String), context: ["175", "185", "195"] });
    } finally {
      db.close();
    }
  });

  it("a delta read reads the whole database", () => {
    const dir = temp();
    const path = join(dir, "ChatStorage.sqlite");
    const total = 60_000;
    const after = 59_000;
    chatStore(path, total);
    const probe = new Database(path, { readonly: true });
    const pageSize = Number(probe.pragma("page_size", { simple: true }));
    const leaves = probe
      .prepare("SELECT pageno, ncell FROM dbstat WHERE name = 'ZWAMESSAGE' AND pagetype = 'leaf' ORDER BY path")
      .all() as { pageno: number; ncell: number }[];
    probe.close();
    let last = 0;
    const zeroed: number[] = [];
    const fd = openSync(path, "r+");
    try {
      for (const leaf of leaves) {
        last += leaf.ncell;
        if (last >= after - 100) break;
        writeSync(fd, Buffer.alloc(pageSize), 0, pageSize, (leaf.pageno - 1) * pageSize);
        zeroed.push(leaf.pageno);
      }
    } finally {
      closeSync(fd);
    }
    expect(zeroed.length).toBeGreaterThan(leaves.length * 0.9);
    const db = openSqlite(path);
    try {
      const window: DatabaseWindow = { kind: "delta", after: BigInt(after), through: BigInt(total) };
      const read = keys(db.rows("ZWAMESSAGE", "Z_PK", { window }));
      expect(read.length).toBe(total - after);
      expect(read[0]).toBe(BigInt(after + 1));
      expect(() => [...db.rows("ZWAMESSAGE", "Z_PK")]).toThrow(/malformed/u);
      artifact(dir, "delta-pages.json", { leaves: leaves.length, zeroed: zeroed.length, read: read.length });
    } finally {
      db.close();
    }
  });

  it("a page read scans its table instead of searching the key, or skips rows that share a key", () => {
    const dir = temp();
    const path = join(dir, "ChatStorage.sqlite");
    chatStore(path, 50);
    const indexed = new Database(path);
    indexed.exec("CREATE INDEX ZWAMESSAGE_CHAT ON ZWAMESSAGE (ZCHATSESSION); CREATE UNIQUE INDEX ZWAMESSAGE_ORDER ON ZWAMESSAGE (ZMESSAGEDATE)");
    indexed.close();
    const db = openSqlite(path);
    try {
      const codes = [
        "ZSORT",
        "ZCHATSESSION",
      ].map((key) => {
        try {
          [...db.rows("ZWAMESSAGE", key, { page: 4 })];
          return "read";
        } catch (error) {
          return error instanceof Refused ? error.message : "threw";
        }
      });
      expect(codes).toEqual([
        expect.stringMatching(/^ZWAMESSAGE\.ZSORT has no index to seek by; /u),
        "ZWAMESSAGE.ZCHATSESSION is not unique: rows sharing a value at a page's edge would be skipped",
      ]);
      expect([...db.rows("ZWAMESSAGE", "ZMESSAGEDATE", { page: 4 })]).toHaveLength(50);
      expect([...db.rows("ZWAMESSAGE", "rowid", { page: 4 })]).toHaveLength(50);
      artifact(dir, "keys.json", codes);
    } finally {
      db.close();
    }
  });

  it("a delta holding a row past its through, or none inside its window, is read", () => {
    const dir = temp();
    const source = join(dir, "ChatStorage.sqlite");
    const deltaPath = join(dir, "delta.sqlite");
    chatStore(source, 40);
    sealDelta(source, deltaPath, 30);
    const db = openSqlite(deltaPath);
    const refusals: string[] = [];
    try {
      for (const window of [
        { kind: "delta", after: 30n, through: 35n },
        { kind: "delta", after: 40n, through: 45n },
      ] as const) {
        try {
          [...db.rows("ZWAMESSAGE", "Z_PK", { window })];
        } catch (error) {
          expect(error).toBeInstanceOf(Refused);
          refusals.push((error as Refused).message);
        }
      }
      expect(refusals).toEqual([
        expect.stringMatching(/^a delta through 35 holds ZWAMESSAGE\.Z_PK \d+$/u),
        "a delta after 40 through 45 holds no ZWAMESSAGE row inside its window",
      ]);
      artifact(dir, "window-refusals.json", refusals);
    } finally {
      db.close();
    }
  });

  it("a window is read from facts that state none or a broken one", () => {
    const dir = temp();
    expect(databaseWindow({ snapshot_taken_at: "2026-10-03T14:00:00Z" })).toEqual({ kind: "snapshot" });
    expect(databaseWindow({ kind: "snapshot", through: 120 })).toEqual({ kind: "snapshot" });
    expect(databaseWindow({ kind: "delta", after: "9007199254740993", through: "9007199254740995" })).toEqual({
      kind: "delta",
      after: 9007199254740993n,
      through: 9007199254740995n,
    });
    const broken = [
      { kind: "delta", after: 5, through: 5 },
      { kind: "delta", after: 1.5, through: 5 },
      { kind: "delta", through: 5 },
      { kind: "delta", after: -1, through: 5 },
      { kind: "delta", after: "07", through: "9" },
      { kind: "full" },
    ];
    const refusals = broken.map((facts) => {
      try {
        databaseWindow(facts);
        return "accepted";
      } catch (error) {
        return error instanceof Refused ? error.message : "threw";
      }
    });
    const after = "facts.after must be a non-negative integer row id, as a number or decimal text";
    expect(refusals).toEqual(["a delta ends after it starts; after 5 is not below through 5", after, after, after, after, 'facts.kind must be snapshot or delta, not "full"']);
    artifact(dir, "cuts.json", refusals);
  });

  it("a cell changes on its way to JSON", () => {
    const dir = temp();
    const path = join(dir, "cells.sqlite");
    const db0 = new Database(path);
    db0.exec("CREATE TABLE c (id INTEGER PRIMARY KEY, big INTEGER, real REAL, text TEXT, blob BLOB, empty, inf REAL)");
    db0.prepare("INSERT INTO c VALUES (1, ?, ?, ?, ?, NULL, 9e999)").run(
      9007199254740993n,
      781000000.125,
      "fake text, person-a@example.com \u{1F600}",
      Buffer.from([0, 1, 2, 250, 255]),
    );
    db0.close();
    const db = openSqlite(path);
    try {
      const row = db.get("SELECT * FROM c");
      expect(row).toBeDefined();
      const cells = rowJson(row!);
      expect(cells).toEqual({
        id: 1,
        big: "9007199254740993",
        real: 781000000.125,
        text: "fake text, person-a@example.com \u{1F600}",
        blob: { $bytes64: "AAEC+v8=" },
        empty: null,
        inf: "Infinity",
      });
      artifact(dir, "cells.json", cells);
    } finally {
      db.close();
    }
  });

  it("a row SQLite cannot return, or one its reader refuses, stops the read, takes its page with it, or goes unnamed", async () => {
    const dir = temp();
    const path = join(dir, "damaged.sqlite");
    const db0 = new Database(path);
    db0.pragma("page_size = 1024");
    db0.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT)");
    const insert = db0.prepare("INSERT INTO t VALUES (?, ?)");
    for (let id = 1; id <= 9; id++) insert.run(id, id === 5 ? "x".repeat(8000) : `row ${id}`);
    db0.close();
    damageOverflow(path, "t");
    const db = openSqlite(path);
    try {
      const rows = await collect(each(db.rows("t", "id", { page: 4 }), (part) => part.where, (part) => {
        const row = part.read();
        if (row.id === 7n) refuse("row 7 fails the reader's check");
        return [{ kind: "row", key: String(row.id), content: String(row.body) }];
      }));
      const read = rows.map((row) => (row.refused === undefined ? { id: row.key, body: row.content } : { key: row.key, refused: row.refused }));
      expect(read).toEqual([
        ...[1, 2, 3, 4].map((id) => ({ id: String(id), body: `row ${id}` })),
        { key: "t id 5", refused: expect.stringMatching(/^SQLite cannot return it: SQLITE_CORRUPT/u) },
        { id: "6", body: "row 6" },
        { key: "t id 7", refused: "row 7 fails the reader's check" },
        ...[8, 9].map((id) => ({ id: String(id), body: `row ${id}` })),
      ]);
      artifact(dir, "damaged-row.json", read);
    } finally {
      db.close();
    }
  });

  it("a stranger's database is read trusting its schema, or without checking its cells", () => {
    const dir = temp();
    const path = join(dir, "ChatStorage.sqlite");
    chatStore(path, 3);
    let pragmas: unknown[] = [];
    const prepare = Database.prototype.prepare;
    Database.prototype.prepare = function (this: Database.Database, sql: string) {
      if (sql === "SELECT count(*) FROM sqlite_master") pragmas = [this.pragma("trusted_schema", { simple: true }), this.pragma("cell_size_check", { simple: true })];
      return prepare.call(this, sql);
    } as typeof prepare;
    let db;
    try {
      db = openSqlite(path);
    } finally {
      Database.prototype.prepare = prepare;
    }
    db.close();
    expect(pragmas).toEqual([0, 1]);
  });

  it("a fault of the machine under a page read is the file's", () => {
    const dir = temp();
    const path = join(dir, "rows.sqlite");
    const db0 = new Database(path);
    db0.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT)");
    for (let id = 1; id <= 6; id++) db0.prepare("INSERT INTO t VALUES (?, ?)").run(id, `row ${id}`);
    db0.close();
    const outcome = (fails: Record<string, string>, read: (db: ReturnType<typeof openSqlite>) => unknown): string => {
      const prepare = Database.prototype.prepare;
      Database.prototype.prepare = function (this: Database.Database, sql: string) {
        const statement = prepare.call(this, sql);
        const code = Object.entries(fails).find(([pick]) => sql.startsWith(pick))?.[1];
        if (code === undefined) return statement;
        const thrown = (): never => {
          throw new Database.SqliteError(`stood-in ${code}`, code);
        };
        if (sql.startsWith("EXPLAIN")) thrown();
        return Object.assign(statement, { all: thrown, get: thrown });
      } as typeof prepare;
      const db = openSqlite(path);
      try {
        read(db);
        return "read";
      } catch (error) {
        return error instanceof Refused ? `refused ${error.message}` : `threw ${(error as { code?: string }).code}`;
      } finally {
        Database.prototype.prepare = prepare;
        db.close();
      }
    };
    const page = 'SELECT "id" AS "id", * FROM "t"';
    const one = 'SELECT "id" AS "id", * FROM "t" WHERE "id" = ?';
    const all = (db: ReturnType<typeof openSqlite>) => [...db.rows("t", "id", { page: 4 })].map((row) => row.read());
    expect([
      outcome({ "EXPLAIN QUERY PLAN": "SQLITE_IOERR" }, all),
      outcome({}, (db) => [...db.rows("t", "no_such_column")]),
      outcome({ [page]: "SQLITE_NOMEM" }, all),
      outcome({ [one]: "SQLITE_NOMEM", [page]: "SQLITE_CORRUPT" }, all),
      outcome({ [one]: "SQLITE_CORRUPT", [page]: "SQLITE_CORRUPT" }, all),
    ]).toEqual([
      "threw SQLITE_IOERR",
      expect.stringMatching(/^refused t\.no_such_column cannot be read in key order: /u),
      "threw SQLITE_NOMEM",
      "threw SQLITE_NOMEM",
      "refused SQLite cannot return it: SQLITE_CORRUPT: stood-in SQLITE_CORRUPT",
    ]);
  });

  it("a lookup between rows of a page read finds the connection busy", () => {
    const dir = temp();
    const path = join(dir, "ChatStorage.sqlite");
    chatStore(path, 30);
    const db = openSqlite(path);
    try {
      const partners: string[] = [];
      for (const part of db.rows("ZWAMESSAGE", "Z_PK", { page: 4 })) {
        const message = part.read();
        const session = db.get("SELECT ZPARTNERNAME FROM ZWACHATSESSION WHERE Z_PK = ?", message.ZCHATSESSION!);
        partners.push(String(session?.ZPARTNERNAME));
      }
      expect(partners).toHaveLength(30);
      artifact(dir, "lookups.json", partners);
    } finally {
      db.close();
    }
  });
});
