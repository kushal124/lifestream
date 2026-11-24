import { createHash } from "node:crypto";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { constants, crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import type Database from "better-sqlite3";
import { canonical, isObject, isSqliteError, type HomeFolder, type JsonObject, type StoreKind } from "@lifestreamprotocol/core";
import { readHome } from "./lifecycle.js";


export const PREPARED_STORE: StoreKind = { role: "prepared", remade: true };

export function preparedDirOf(root: string, machine: string, name: "people" | "places"): string {
  return join(machine, name, readHome(root).id);
}

export function preparedFileOf(dir: string, name: "people" | "places"): string {
  return join(dir, `${name}.db`);
}

export interface Shape {
  readonly format: string;
  readonly tables: readonly string[];
  readonly own: readonly string[];
}

export const PEOPLE: Shape = {
  format: "7",
  tables: ["answer", "person", "alias", "names", "photos", "image", "named", "groups", "heads", "who"],
  own: ["CREATE TABLE card (key TEXT PRIMARY KEY, type TEXT NOT NULL, bytes BLOB NOT NULL)"],
};

export const PLACES: Shape = {
  format: "13",
  tables: ["answer", "place", "year", "trips", "owed", "spans", "head"],
  own: [
    "CREATE TABLE photo (slug TEXT NOT NULL, at_ms INTEGER NOT NULL, image TEXT NOT NULL, PRIMARY KEY (slug, at_ms DESC, image)) WITHOUT ROWID",
    "CREATE INDEX photo_image ON photo (image)",
    "CREATE TABLE photo_list (slug TEXT PRIMARY KEY, etag TEXT NOT NULL) WITHOUT ROWID",
    "CREATE TABLE spotted (unit TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL, key TEXT NOT NULL, PRIMARY KEY (unit, start_ms, end_ms, latitude, longitude)) WITHOUT ROWID",
    "CREATE TABLE area (id INTEGER PRIMARY KEY, place TEXT, city TEXT, city_id TEXT, region TEXT, country TEXT NOT NULL, country_code TEXT, zone TEXT)",
    "CREATE TABLE presence (start_ms INTEGER PRIMARY KEY, end_ms INTEGER NOT NULL, known INTEGER, guessed INTEGER, zone TEXT, accounts TEXT NOT NULL)",
    "CREATE TABLE placed (day TEXT NOT NULL, area INTEGER NOT NULL, guessed INTEGER NOT NULL, PRIMARY KEY (day, area)) WITHOUT ROWID",
  ],
};

interface Row {
  readonly etag: string;
  readonly body: Buffer;
  readonly crc: number;
  readonly size: number;
}

export interface Run {
  readonly rows: ReadonlyMap<string, ReadonlyMap<string, JsonObject>>;
  readonly position: string;
  own?(db: Database.Database): { written: number; removed: number };
  readonly meta?: Readonly<Record<string, string>>;
}

export interface Written {
  written: number;
  removed: number;
  bytes: number;
  changed: string;
}

const READ_WAIT_MS = 50;
export const JOB_WAIT_MS = 60_000;
const GZIP_HEAD = Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff]);

export function writePrepared(folder: HomeFolder, file: string, shape: Shape, run: Run): Written {
  try {
    return write(folder, file, shape, run);
  } catch (error) {
    if (!damaged(error)) throw error;
    discardPrepared(file);
    return write(folder, file, shape, run);
  }
}

export function damaged(error: unknown): boolean {
  if (isSqliteError(error)) return /^SQLITE_(CORRUPT|NOTADB)/u.test(error.code);
  return error instanceof Error && "code" in error && /^Z_(DATA|BUF)_ERROR$/u.test(String(error.code));
}

export function discardPrepared(file: string): void {
  letReadersGo(file);
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true });
}

const heldForReaders = new Map<string, { db: Database.Database; inode: number }>();

function holdForReaders(folder: HomeFolder, file: string): void {
  const inode = statSync(file).ino;
  if (heldForReaders.get(file)?.inode === inode) return;
  letReadersGo(file);
  const db = folder.store(PREPARED_STORE, file, { mode: "read", mustExist: true, timeout: JOB_WAIT_MS });
  try {
    db.prepare("SELECT count(*) FROM sqlite_master").get();
  } catch (error) {
    db.close();
    throw error;
  }
  heldForReaders.set(file, { db, inode });
}

function letReadersGo(file: string): void {
  heldForReaders.get(file)?.db.close();
  heldForReaders.delete(file);
}

export function releasePreparedReaders(): void {
  for (const held of heldForReaders.values()) held.db.close();
  heldForReaders.clear();
}

function write(folder: HomeFolder, file: string, shape: Shape, run: Run): Written {
  mkdirSync(dirname(file), { recursive: true });
  const db = folder.store(PREPARED_STORE, file, { sync: "NORMAL", timeout: JOB_WAIT_MS });
  try {
    const done = db.transaction(() => {
      if (metaOf(db, "format") !== shape.format) {
        for (const name of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all() as string[]) db.exec(`DROP TABLE "${name}"`);
        db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
        for (const table of shape.tables) db.exec(`CREATE TABLE ${table} (key TEXT PRIMARY KEY, etag TEXT NOT NULL, crc INTEGER NOT NULL, size INTEGER NOT NULL, body BLOB NOT NULL)`);
        for (const statement of shape.own) db.exec(statement);
        setMeta(db, "format", shape.format);
      }
      let written = 0, removed = 0, bytes = 0;
      for (const table of shape.tables) {
        let moved = 0;
        const held = new Map(db.prepare(`SELECT key, etag FROM ${table}`).raw().all() as [string, string][]);
        const put = db.prepare(`INSERT INTO ${table} (key, etag, crc, size, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET etag = excluded.etag, crc = excluded.crc, size = excluded.size, body = excluded.body`);
        const drop = db.prepare(`DELETE FROM ${table} WHERE key = ?`);
        const rows = run.rows.get(table) ?? new Map<string, JsonObject>();
        for (const [key, value] of rows) {
          if (!isObject(value) || Object.keys(value).length === 0) throw new Error(`a prepared row is a non-empty object, never ${table} ${JSON.stringify(key)}: ${canonical(value)}`);
          const text = canonical(value);
          const etag = etagOf(text);
          if (held.get(key) === etag) continue;
          const open = Buffer.from(text.slice(0, -1));
          const body = deflateRawSync(open, { finishFlush: constants.Z_SYNC_FLUSH });
          put.run(key, etag, crc32(open), open.length, body);
          bytes += body.length;
          moved++;
        }
        written += moved;
        for (const key of held.keys()) {
          if (rows.has(key)) continue;
          drop.run(key);
          removed++;
          moved++;
        }
        if (moved > 0) setMeta(db, `changed:${table}`, run.position);
      }
      const own = run.own?.(db) ?? { written: 0, removed: 0 };
      written += own.written;
      removed += own.removed;
      const changed = written + removed > 0 ? run.position : metaOf(db, "changed") ?? run.position;
      setMeta(db, "position", run.position);
      setMeta(db, "changed", changed);
      for (const [key, value] of Object.entries(run.meta ?? {})) setMeta(db, key, value);
      return { written, removed, bytes, changed };
    }).immediate();
    holdForReaders(folder, file);
    return done;
  } finally {
    db.close();
  }
}

export interface PreparedRead {
  readonly position: string;
  readonly db: Database.Database;
  etag(table: string, key: string): string | undefined;
  answer(table: string, key: string, gzip: boolean, position: string): { body: Buffer; headers: Record<string, string> } | undefined;
  value<T>(table: string, key: string): T | undefined;
  rows<T>(table: string): [string, T][];
  meta(key: string): string | undefined;
}

export function readPrepared<T>(folder: HomeFolder, file: string, format: string, read: (file: PreparedRead) => T, wait_ms = READ_WAIT_MS): { value: T } | undefined {
  const held = openPrepared(folder, file, format, wait_ms);
  if (held === undefined) return undefined;
  try {
    return { value: read(held.read) };
  } finally {
    held.end();
  }
}

export function openPrepared(folder: HomeFolder, file: string, format: string, wait_ms = READ_WAIT_MS): { read: PreparedRead; end(): void } | undefined {
  let db: Database.Database;
  try {
    db = folder.store(PREPARED_STORE, file, { mode: "read", mustExist: true, timeout: wait_ms });
  } catch (error) {
    if (isSqliteError(error) && error.code === "SQLITE_CANTOPEN") return undefined;
    if (error instanceof TypeError && error.message.includes("directory does not exist")) return undefined;
    throw error;
  }
  const end = () => {
    if (!db.open) return;
    if (db.inTransaction) db.exec("COMMIT");
    db.close();
  };
  try {
    db.exec("BEGIN");
    const position = metaOf(db, "position");
    if (position === undefined || metaOf(db, "format") !== format) {
      end();
      return undefined;
    }
    const row = (table: string, key: string) => db.prepare(`SELECT etag, body, crc, size FROM ${table} WHERE key = ?`).get(key) as Row | undefined;
    return {
      end,
      read: {
        position, db,
        answer(table, key, gzip, at) {
          const found = row(table, key);
          return found === undefined ? undefined : answerOf(found, at, gzip);
        },
        etag: (table, key) => db.prepare(`SELECT etag FROM ${table} WHERE key = ?`).pluck().get(key) as string | undefined,
        value<V>(table: string, key: string) {
          const found = row(table, key);
          return found === undefined ? undefined : JSON.parse(`${inflated(found)}}`) as V;
        },
        rows<V>(table: string) {
          return (db.prepare(`SELECT key, etag, body, crc, size FROM ${table} ORDER BY key`).all() as (Row & { key: string })[])
            .map((found): [string, V] => [found.key, JSON.parse(`${inflated(found)}}`) as V]);
        },
        meta: (key) => metaOf(db, key),
      },
    };
  } catch (error) {
    end();
    throw error;
  }
}

function answerOf(row: Row, position: string, gzip: boolean): { body: Buffer; headers: Record<string, string> } {
  const tail = Buffer.from(`,"position":${JSON.stringify(position)}}`);
  if (!gzip) return { body: Buffer.concat([inflatedBytes(row), tail]), headers: {} };
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(tail, row.crc), 0);
  trailer.writeUInt32LE((row.size + tail.length) % 2 ** 32, 4);
  return { body: Buffer.concat([GZIP_HEAD, row.body, deflateRawSync(tail), trailer]), headers: { "content-encoding": "gzip" } };
}

function etagOf(text: string): string {
  return `"${createHash("sha256").update(text).digest("hex")}"`;
}

function inflatedBytes(row: Row): Buffer {
  return inflateRawSync(row.body, { finishFlush: constants.Z_SYNC_FLUSH });
}

function inflated(row: Row): string {
  return inflatedBytes(row).toString("utf8");
}

function metaOf(db: Database.Database, key: string): string | undefined {
  try {
    return db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(key) as string | undefined;
  } catch (error) {
    if (isSqliteError(error) && /no such table/u.test(error.message)) return undefined;
    throw error;
  }
}

function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
}
