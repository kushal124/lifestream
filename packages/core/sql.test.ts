import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { homeError, isSqliteError } from "./sql.js";

const dir = mkdtempSync(join(tmpdir(), "lifestream-sql-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function open(name: string, options?: Database.Options): Database.Database {
  const db = new Database(join(dir, name), options);
  onTestFinished(() => { db.close(); });
  return db;
}

function thrown(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("the operation threw nothing");
}

describe("isSqliteError", () => {
  it("reads SQLITE_BUSY the plain engine throws while another connection holds the write lock", () => {
    const holder = open("busy.db");
    holder.exec("CREATE TABLE t (n INTEGER)");
    holder.exec("BEGIN IMMEDIATE");
    const waiter = open("busy.db", { timeout: 0 });
    const error = thrown(() => waiter.exec("INSERT INTO t VALUES (1)"));
    holder.exec("ROLLBACK");
    expect(error).toBeInstanceOf(Database.SqliteError);
    expect(isSqliteError(error)).toBe(true);
    expect((error as { code: string }).code).toBe("SQLITE_BUSY");
  });

  it("reads SQLITE_CONSTRAINT the plain engine throws on a duplicate key", () => {
    const db = open("constraint.db");
    db.exec("CREATE TABLE t (n INTEGER PRIMARY KEY)");
    db.exec("INSERT INTO t VALUES (1)");
    const error = thrown(() => db.exec("INSERT INTO t VALUES (1)"));
    expect(error).toBeInstanceOf(Database.SqliteError);
    expect(isSqliteError(error)).toBe(true);
    expect((error as { code: string }).code).toMatch(/^SQLITE_CONSTRAINT/u);
  });

  it("reads SQLITE_NOTADB the plain engine throws on a file that is not a database", () => {
    const path = join(dir, "notadb.db");
    writeFileSync(path, "this file is not a database, and is long enough to hold a header of one hundred bytes or so.");
    const error = thrown(() => {
      const db = new Database(path);
      try {
        db.prepare("SELECT * FROM sqlite_master").all();
      } finally {
        db.close();
      }
    });
    expect(error).toBeInstanceOf(Database.SqliteError);
    expect(isSqliteError(error)).toBe(true);
    expect((error as { code: string }).code).toBe("SQLITE_NOTADB");
  });

  it("refuses what is not a SQLite error", () => {
    expect(isSqliteError(new Error("plain"))).toBe(false);
    expect(isSqliteError(Object.assign(new Error("coded"), { code: "SQLITE_BUSY" }))).toBe(false);
    expect(isSqliteError({ name: "SqliteError" })).toBe(false);
    expect(isSqliteError({ name: "SqliteError", code: 5 })).toBe(false);
    expect(isSqliteError(null)).toBe(false);
    expect(isSqliteError(undefined)).toBe(false);
    expect(isSqliteError("SqliteError")).toBe(false);
  });

  it("reads a SQLite error by its shape, so another engine's class answers too", () => {
    class OtherSqliteError extends Error {
      constructor(message: string, readonly code: string) {
        super(message);
        this.name = "SqliteError";
      }
    }
    const error = new OtherSqliteError("database is locked", "SQLITE_BUSY");
    expect(error).not.toBeInstanceOf(Database.SqliteError);
    expect(isSqliteError(error)).toBe(true);
    expect(homeError(error)).toMatchObject({ database: "home.db" });
  });
});
