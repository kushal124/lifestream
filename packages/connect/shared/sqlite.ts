import Database from "better-sqlite3";
import { hostFault, type BlobReader, type DeliveryFile, type JsonObject } from "@lifestreamprotocol/core";
import { refuse } from "./refused.js";

/** A value SQLite returns, with every integer as a bigint so none loses a digit. */
export type SqliteValue = null | bigint | number | string | Buffer;
/** One row SQLite returns, its values by column name. */
export type SqliteRow = Record<string, SqliteValue>;

/** One row `rows` hands over, read only when asked so that a row SQLite cannot return refuses alone. */
export interface TableRow {
  /** Where the row sits, as its table, key column and key value. */
  readonly where: string;
  /** The row's values, or Refused when SQLite cannot return them from a damaged file. */
  read(): SqliteRow;
}

/** Which rows of a table a delivered database stands for, as its delivery's facts state it. */
export type DatabaseWindow =
  | {
    /** Every row of the table. */
    kind: "snapshot";
  }
  | {
    /** Only the rows whose key is above `after` and at most `through`. */
    kind: "delta";
    /** The key the window starts after. */
    after: bigint;
    /** The last key the window holds. */
    through: bigint;
  };

/** A delivered SQLite file, opened read-only, whose lookups refuse a damaged file with Refused. */
export interface Sqlite {
  /** The file on the home's disk the database is opened from. */
  readonly path: string;
  /** The names of its tables, in the order its schema declares them. */
  tables(): string[];
  /** A table's column names in order, none for a table it does not have. */
  columns(table: string): string[];
  /** The first row a query returns, or undefined when it returns none. */
  get(sql: string, ...params: SqliteValue[]): SqliteRow | undefined;
  /** Every row a query returns, at once. */
  all(sql: string, ...params: SqliteValue[]): SqliteRow[];
  /** The rows a query returns, one at a time, the connection running nothing else until they end. */
  query(sql: string, ...params: SqliteValue[]): Generator<SqliteRow>;
  /** A table's rows in the order of a unique indexed key, read a page at a time and only within the window given, each handed over as a row read on its own. */
  rows(table: string, key: string, options?: { window?: DatabaseWindow; columns?: string[]; page?: number }): Generator<TableRow>;
  /** Closes the database and frees the copy it was read from. */
  close(): void;
}

const PAGE = 1000;

function delivered<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof Database.SqliteError && /^SQLITE_(?:CORRUPT|NOTADB)/u.test(error.code)) refuse(`SQLite cannot return it: ${error.code}: ${error.message}`);
    throw error;
  }
}

export function openSqlite(path: string, dispose?: () => void, name = path): Sqlite {
  let opened: Database.Database | undefined;
  try {
    opened = new Database(path, { readonly: true, fileMustExist: true });
    opened.pragma("trusted_schema = OFF");
    opened.pragma("cell_size_check = ON");
    opened.prepare("SELECT count(*) FROM sqlite_master").get();
  } catch (error) {
    opened?.close();
    dispose?.();
    if (hostFault(error)) throw error;
    const { code, message } = error as { code?: string; message: string };
    return refuse(`${name} does not open as a SQLite database: ${code === undefined ? message : `${code}: ${message}`}`);
  }
  const db = opened;
  const cache = new Map<string, Database.Statement>();
  const statement = (sql: string): Database.Statement => {
    let prepared = cache.get(sql);
    if (prepared === undefined) {
      prepared = db.prepare(sql).safeIntegers(true);
      cache.set(sql, prepared);
    }
    return prepared;
  };

  const sqlite: Sqlite = {
    path,
    tables() {
      return (statement("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY rowid").all() as { name: string }[]).map(
        (row) => row.name,
      );
    },
    columns(table) {
      return (statement("SELECT name FROM pragma_table_info(?) ORDER BY cid").all(table) as { name: string }[]).map(
        (row) => row.name,
      );
    },
    get(sql, ...params) {
      return delivered(() => statement(sql).get(...params) as SqliteRow | undefined);
    },
    all(sql, ...params) {
      return delivered(() => statement(sql).all(...params) as SqliteRow[]);
    },
    *query(sql, ...params) {
      const rows = delivered(() => db.prepare(sql).safeIntegers(true).iterate(...params) as IterableIterator<SqliteRow>);
      try {
        for (;;) {
          const next = delivered(() => rows.next());
          if (next.done === true) return;
          yield next.value;
        }
      } finally {
        rows.return?.();
      }
    },
    *rows(table, key, options = {}) {
      const page = options.page ?? PAGE;
      if (!Number.isSafeInteger(page) || page < 1) throw new RangeError(`page must be a positive integer, not ${page}`);
      const window = options.window ?? { kind: "snapshot" };
      const from = quote(table);
      const k = quote(key);
      const list = options.columns === undefined ? "*" : options.columns.map(quote).join(", ");
      const columns = `${k} AS ${k}, ${list}`;
      const select = `SELECT ${columns} FROM ${from}`;
      const upper = window.kind === "delta" ? ` AND ${k} <= ?` : "";
      const next = `${select} WHERE ${k} > ?${upper} ORDER BY ${k} LIMIT ?`;
      assertSearch(db, next, window.kind === "delta" ? [0n, 0n, 1] : [0n, 1], `${table}.${key}`);
      if (!uniqueKey(db, table, key)) refuse(`${table}.${key} is not unique: rows sharing a value at a page's edge would be skipped`);
      if (window.kind === "delta") {
        const past = statement(`SELECT ${k} AS k FROM ${from} WHERE ${k} > ? ORDER BY ${k} LIMIT 1`).get(window.through) as
          | { k: SqliteValue }
          | undefined;
        if (past !== undefined) {
          refuse(`a delta through ${window.through} holds ${table}.${key} ${String(past.k)}`);
        }
        if (statement(`SELECT 1 FROM ${from} WHERE ${k} > ? AND ${k} <= ? LIMIT 1`).get(window.after, window.through) === undefined) {
          refuse(`a delta after ${window.after} through ${window.through} holds no ${table} row inside its window`);
        }
      } else if (statement(`SELECT 1 FROM ${from} WHERE ${k} IS NULL LIMIT 1`).get() !== undefined) {
        refuse(`${table}.${key} is NULL in some row, which a read in key order cannot reach`);
      }
      const read = (stated: string, last: SqliteValue | undefined): SqliteRow[] => {
        const bounds = [...(last === undefined ? [] : [`${k} > ?`]), ...(window.kind === "delta" ? [`${k} <= ?`] : [])];
        const sql = `SELECT ${stated} FROM ${from}${bounds.length === 0 ? "" : ` WHERE ${bounds.join(" AND ")}`} ORDER BY ${k} LIMIT ?`;
        return statement(sql).all(...(last === undefined ? [] : [last]), ...(window.kind === "delta" ? [window.through] : []), page) as SqliteRow[];
      };
      const part = (value: SqliteValue, row: () => SqliteRow): TableRow => ({ where: `${table} ${key} ${String(value)}`, read: row });
      const one = (value: SqliteValue): TableRow => {
        let row: SqliteRow;
        try {
          row = statement(`${select} WHERE ${k} = ?`).get(value) as SqliteRow;
        } catch (error) {
          if (!(error instanceof Database.SqliteError) || hostFault(error)) throw error;
          const why = `SQLite cannot return it: ${error.code}: ${error.message}`;
          return part(value, () => refuse(why));
        }
        return part(value, () => row);
      };
      const pageAfter = (last: SqliteValue | undefined): { parts: (TableRow | undefined)[]; last: SqliteValue | undefined } => {
        let keys: SqliteValue[];
        let parts: TableRow[];
        try {
          const whole = read(columns, last);
          keys = whole.map((row) => row[key] as SqliteValue);
          parts = whole.map((row, index) => part(keys[index]!, () => row));
        } catch (error) {
          if (!(error instanceof Database.SqliteError) || hostFault(error)) throw error;
          keys = read(`${k} AS ${k}`, last).map((row) => row[key] as SqliteValue);
          parts = keys.map(one);
        }
        return { parts, last: keys.at(-1) };
      };
      let last: SqliteValue | undefined = window.kind === "delta" ? window.after : undefined;
      for (;;) {
        const next = pageAfter(last);
        const { parts } = next;
        if (parts.length === 0) return;
        last = next.last;
        for (let index = 0; index < parts.length; index++) {
          const handed = parts[index]!;
          parts[index] = undefined;
          yield handed;
        }
        if (parts.length < page) return;
      }
    },
    close() {
      cache.clear();
      try {
        db.close();
      } finally {
        dispose?.();
      }
    },
  };
  return sqlite;
}

/** Opens a delivered file as a read-only SQLite database from a copy on disk, refusing a file that is no database. */
export async function openDeliveredSqlite(files: BlobReader, file: DeliveryFile): Promise<Sqlite> {
  const materialised = await files.materialise(file.blob);
  return openSqlite(materialised.path, () => materialised.dispose(), file.path);
}

/** Refuses the database, under the file name given, when it lacks a table named or a column listed for it. */
export function requireColumns(db: Sqlite, file: string, required: Readonly<Record<string, readonly string[]>>): void {
  for (const [table, columns] of Object.entries(required)) {
    const declared = db.columns(table);
    if (declared.length === 0) refuse(`${file} has no ${table} table`);
    const missing = [...new Set(columns.filter((column) => !declared.includes(column)))];
    if (missing.length > 0) refuse(`${file} ${table} lacks columns this connector reads: ${missing.join(", ")}`);
  }
}

/** The window a delivery's facts state: a delta from their `kind`, `after` and `through`, or else the whole table. */
export function databaseWindow(facts: JsonObject): DatabaseWindow {
  const kind = facts.kind;
  if (kind === undefined || kind === "snapshot") return { kind: "snapshot" };
  if (kind !== "delta") refuse(`facts.kind must be snapshot or delta, not ${JSON.stringify(kind)}`);
  const after = rowId(facts.after, "after");
  const through = rowId(facts.through, "through");
  if (after >= through) refuse(`a delta ends after it starts; after ${after} is not below through ${through}`);
  return { kind: "delta", after, through };
}

/** A row as JSON, with an integer past the safe range as decimal text, a non-finite number as text and bytes as `{ $bytes64 }`. */
export function rowJson(row: SqliteRow): JsonObject {
  const out: JsonObject = {};
  for (const [column, value] of Object.entries(row)) {
    if (value === null || typeof value === "string") out[column] = value;
    else if (typeof value === "bigint") out[column] = Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
    else if (typeof value === "number") out[column] = Number.isFinite(value) ? value : String(value);
    else if (Buffer.isBuffer(value)) out[column] = { $bytes64: value.toString("base64") };
    else refuse(`column ${column} holds a value SQLite does not return`);
  }
  return out;
}

function uniqueKey(db: Database.Database, table: string, key: string): boolean {
  const columns = db.prepare("SELECT name, type, pk FROM pragma_table_info(?)").all(table) as { name: string; type: string; pk: number }[];
  const column = columns.find((candidate) => candidate.name.toLowerCase() === key.toLowerCase());
  if (column === undefined) return ["rowid", "_rowid_", "oid"].includes(key.toLowerCase());
  if (column.pk === 1 && column.type.toUpperCase() === "INTEGER" && columns.filter((candidate) => candidate.pk > 0).length === 1) return true;
  const unique = db
    .prepare(
      `SELECT 1 FROM pragma_index_list(?) AS list WHERE list."unique" = 1
         AND (SELECT count(*) FROM pragma_index_info(list.name)) = 1
         AND (SELECT name FROM pragma_index_info(list.name)) = ? COLLATE NOCASE`,
    )
    .get(table, column.name);
  return unique !== undefined;
}

function assertSearch(db: Database.Database, sql: string, params: SqliteValue[], where: string): void {
  let plan: { detail: string }[];
  try {
    plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[];
  } catch (error) {
    if (hostFault(error)) throw error;
    return refuse(`${where} cannot be read in key order: ${(error as Error).message}`);
  }
  const details = plan.map((row) => row.detail);
  if (!details.some((detail) => detail.startsWith("SEARCH ")) || details.some((detail) => detail.startsWith("SCAN ") || detail.includes("TEMP B-TREE"))) {
    refuse(`${where} has no index to seek by; each page would read the whole table (${details.join("; ")})`);
  }
}

function rowId(value: unknown, member: string): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value)) return BigInt(value);
  return refuse(`facts.${member} must be a non-negative integer row id, as a number or decimal text`);
}

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

