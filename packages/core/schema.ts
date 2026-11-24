import Database from "better-sqlite3";
import type { JsonObject } from "./types.js";

declare const LIFESTREAM_RELEASE: string | undefined;
declare const LIFESTREAM_GENERATION: number | undefined;

export const RELEASE = typeof LIFESTREAM_RELEASE === "string" ? LIFESTREAM_RELEASE : "checkout";
export const GENERATION = typeof LIFESTREAM_GENERATION === "number" ? LIFESTREAM_GENERATION : null;

export type Migration = (db: Database.Database) => void;

export type OpenMode = "migrate" | "write" | "read";

export interface Migrated {
  from: number;
  to: number;
  ms: Record<string, number>;
}

export type SchemaLog = (line: JsonObject) => void;

type Stamp = (file: string, version: number) => void;

const stamps = new WeakMap<Database.Database, Stamp>();

export function stampsTo(db: Database.Database, stamp: Stamp): void {
  stamps.set(db, stamp);
}

export interface SchemaSpec {
  name: string;
  file: string;
  base: number;
  baseline: string;
  migrations: readonly Migration[];
  small: readonly string[];
  indexed?: readonly number[];
  foreignKeys?: boolean;
}

export class Schema {
  readonly name: string;
  readonly file: string;
  readonly base: number;
  readonly baseline: string;
  readonly migrations: readonly Migration[];
  readonly small: ReadonlySet<string>;
  readonly indexed: ReadonlySet<number>;
  readonly foreignKeys: boolean;
  readonly #expected = new Map<number, ReadonlyMap<string, string>>();

  constructor(spec: SchemaSpec) {
    this.name = spec.name;
    this.file = spec.file;
    this.base = spec.base;
    this.baseline = spec.baseline;
    this.migrations = spec.migrations;
    this.small = new Set(spec.small);
    this.indexed = new Set(spec.indexed ?? []);
    this.foreignKeys = spec.foreignKeys === true;
  }

  get latest(): number {
    return this.base + this.migrations.length;
  }

  version(db: Database.Database): number {
    const own = db.prepare("SELECT user_version FROM pragma_user_version").pluck().get() as number;
    if (own !== 0) return own;
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get() === undefined) return 0;
    const meta = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'meta'").get() !== undefined;
    const steps = meta ? db.prepare("SELECT value FROM meta WHERE key = 'steps'").pluck().get() as string | undefined : undefined;
    const version = Number(steps);
    if (steps === undefined || !Number.isSafeInteger(version) || version < 1) {
      throw new Error(`${this.name} holds tables but records no version, so no release can tell what it holds`);
    }
    return version;
  }

  expected(version: number): ReadonlyMap<string, string> {
    if (!Number.isSafeInteger(version) || version < this.base || version > this.latest) {
      throw new Error(`${this.name} has no version ${version} in this release: it knows ${this.base} to ${this.latest}`);
    }
    let known = this.#expected.get(version);
    if (known === undefined) {
      const memory = new Database(":memory:");
      try {
        memory.exec(this.baseline);
        for (const migration of this.migrations.slice(0, version - this.base)) migration(memory);
        known = objectsOf(memory);
      } finally {
        memory.close();
      }
      this.#expected.set(version, known);
    }
    return known;
  }

  difference(db: Database.Database, version: number): string | null {
    const want = this.expected(version);
    const found = objectsOf(db);
    for (const [name, sql] of want) {
      const there = found.get(name);
      if (there === undefined) return `${name} is missing`;
      if (there !== sql) return `${name} differs`;
    }
    for (const name of found.keys()) if (!want.has(name)) return `${name} is not one of version ${version}'s`;
    return null;
  }

  refusal(version: number): string | null {
    if (version === this.latest) return null;
    if (version === 0) return `${this.name} holds no schema yet: the home has not started this release yet`;
    return version > this.latest
      ? `${this.name} is at version ${version}; this release reads ${this.latest}: a newer release wrote it`
      : `${this.name} is at version ${version}; this release reads ${this.latest}: the home has not started this release yet`;
  }

  check(db: Database.Database): number {
    const version = this.version(db);
    this.#admits(db, version);
    if (this.foreignKeys && version !== 0 && version < this.latest) this.#keysHold(db, `${this.name} at version ${version}`);
    return version;
  }

  #admits(db: Database.Database, version: number): void {
    if (version === 0) return;
    if (version > this.latest) throw new Error(this.refusal(version)!);
    if (version < this.base) {
      throw new Error(`${this.name} is at version ${version}; this release reads ${this.latest} and moves a file forward from ${this.base} at the oldest: a release between them moves it first`);
    }
    const difference = this.difference(db, version);
    if (difference !== null) throw new Error(`${this.name} is not this release's at version ${version} (${difference}): this release cannot read it`);
  }

  #keysHold(db: Database.Database, what: string): void {
    const broken = db.pragma("foreign_key_check") as { table: string; parent: string }[];
    if (broken.length > 0) throw new Error(`${what} has a row of ${broken[0]!.table} whose ${broken[0]!.parent} is gone`);
  }

  open(db: Database.Database, mode: OpenMode, log: SchemaLog = () => {}): Migrated | null {
    if (mode === "migrate") return this.#migrate(db, log, stamps.get(db) ?? (() => {}));
    const why = this.refusal(this.version(db));
    if (why !== null) throw new Error(why);
    if (this.foreignKeys && mode === "write") db.pragma("foreign_keys = ON");
    return null;
  }

  #migrate(db: Database.Database, log: SchemaLog, stamp: Stamp): Migrated | null {
    const to = this.latest;
    db.pragma("foreign_keys = OFF");
    let begun: { from: number } | null = null;
    let migrated: Migrated | null = null;
    try {
      db.exec("BEGIN IMMEDIATE");
      const from = this.version(db);
      if (from > to) throw new Error(this.refusal(from)!);
      stamp(this.file, to);
      if (from < to) {
        begun = { from };
        log({ home: "migrating", file: this.file, from, to });
      }
      if (from === 0) db.exec(this.baseline);
      else this.#admits(db, from);
      const ms: Record<string, number> = {};
      for (let version = Math.max(from, this.base) + 1; version <= to; version++) {
        const started = performance.now();
        this.migrations[version - this.base - 1]!(db);
        ms[String(version)] = Math.round(performance.now() - started);
      }
      if (from < to) {
        db.pragma(`user_version = ${to}`);
        const after = this.difference(db, to);
        if (after !== null) throw new Error(`${this.name} migrated to version ${to} is not this release's (${after})`);
        if (this.foreignKeys) {
          const started = performance.now();
          this.#keysHold(db, `${this.name} migrated to version ${to}`);
          ms.foreign_key_check = Math.round(performance.now() - started);
        }
        migrated = { from, to, ms };
      }
      db.exec("COMMIT");
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK");
      if (begun !== null) log({ home: "migration_failed", file: this.file, from: begun.from, to, error: (error as Error).message });
      throw error;
    } finally {
      if (this.foreignKeys) db.pragma("foreign_keys = ON");
    }
    stamp(this.file, to);
    if (migrated !== null) log({ home: "migrated", file: this.file, from: migrated.from, to, ms: migrated.ms });
    return migrated;
  }
}

function objectsOf(db: Database.Database): Map<string, string> {
  const rows = db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type, name").all() as
    { type: string; name: string; sql: string }[];
  return new Map(rows.map((row) => [`${row.type} ${row.name}`, normalised(row.sql)]));
}

export function normalised(sql: string): string {
  return sql.replace(/--[^\n]*/gu, " ").replace(/\s+/gu, " ").replace(/\s*([(),])\s*/gu, "$1").trim();
}
