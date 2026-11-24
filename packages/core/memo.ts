import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type Database from "better-sqlite3";
import { canonical } from "./format.js";
import type { HomeFolder, StoreKind } from "./home-folder.js";
import { isSqliteError } from "./sql.js";
import type { Json } from "./types.js";

export interface Memo {
  values<T>(space: string, keys: readonly string[], make: (key: string) => T | undefined): Map<string, T>;
  close(): void;
}

const SPACE = /^[A-Za-z0-9-]+$/u;

const MEMO: StoreKind = { role: "memo", remade: true };

export function openMemo(folder: HomeFolder, path: string, version: string): Memo {
  mkdirSync(dirname(path), { recursive: true });
  return new FileMemo(folder, path, version);
}

interface Space {
  read: Database.Statement;
  put: Database.Statement;
  drop: Database.Statement;
}

class FileMemo implements Memo {
  #db: Database.Database;
  readonly #spaces = new Map<string, Space>();

  constructor(private readonly folder: HomeFolder, private readonly path: string, private readonly version: string) {
    try {
      this.#db = start(folder, path, version);
    } catch (error) {
      if (!corrupt(error)) throw error;
      remove(path);
      this.#db = start(folder, path, version);
    }
  }

  values<T>(space: string, keys: readonly string[], make: (key: string) => T | undefined): Map<string, T> {
    if (!SPACE.test(space)) throw new Error(`a memo space is named in letters, digits and "-", never ${JSON.stringify(space)}`);
    const kept = this.#on(() => new Map(this.#space(space).read.raw().all() as [string, string][]), () => new Map<string, string>());
    const asked = new Set(keys);
    const answer = new Map<string, T>();
    const made: [string, string][] = [];
    for (const key of asked) {
      const text = kept.get(key);
      if (text !== undefined) {
        answer.set(key, JSON.parse(text) as T);
        continue;
      }
      const value = make(key);
      if (value === undefined) continue;
      answer.set(key, value);
      made.push([key, canonical(value as Json)]);
    }
    const dropped = [...kept.keys()].filter((key) => !asked.has(key));
    if (made.length > 0 || dropped.length > 0) {
      this.#on(() => {
        const statements = this.#space(space);
        this.#db.transaction(() => {
          for (const [key, text] of made) statements.put.run(key, text);
          for (const key of dropped) statements.drop.run(key);
        }).immediate();
      }, () => undefined);
    }
    return answer;
  }

  close(): void {
    this.#db.close();
  }

  #space(name: string): Space {
    let space = this.#spaces.get(name);
    if (space === undefined) {
      const table = `"space:${name}"`;
      this.#db.exec(`CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`);
      space = {
        read: this.#db.prepare(`SELECT key, value FROM ${table}`),
        put: this.#db.prepare(`INSERT INTO ${table} (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`),
        drop: this.#db.prepare(`DELETE FROM ${table} WHERE key = ?`),
      };
      this.#spaces.set(name, space);
    }
    return space;
  }

  #on<R>(work: () => R, empty: () => R): R {
    try {
      return work();
    } catch (error) {
      if (!corrupt(error)) throw error;
      this.#spaces.clear();
      if (this.#db.open) this.#db.close();
      remove(this.path);
      this.#db = start(this.folder, this.path, this.version);
      return empty();
    }
  }
}

function start(folder: HomeFolder, path: string, version: string): Database.Database {
  const db = folder.store(MEMO, path, { sync: "NORMAL" });
  try {
    db.transaction(() => {
      db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID");
      if (db.prepare("SELECT value FROM meta WHERE key = 'version'").pluck().get() === version) return;
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'meta'").pluck().all() as string[];
      for (const table of tables) db.exec(`DROP TABLE "${table.replaceAll('"', '""')}"`);
      db.prepare("INSERT INTO meta (key, value) VALUES ('version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(version);
    }).immediate();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function remove(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
}

function corrupt(error: unknown): boolean {
  return isSqliteError(error) && /^SQLITE_(CORRUPT|NOTADB)/u.test(error.code);
}
