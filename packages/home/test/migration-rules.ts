import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Schema } from "@lifestreamprotocol/core";

export type Values = Record<string, Record<string, unknown>>;

interface Table {
  sql: string;
  rootpage: number;
  columns: unknown[];
  rows: string;
}

interface Index {
  table: string;
  sql: string;
  rootpage: number;
}

export function migrationRules(schema: Schema, values: Values = {}): string[] {
  const dir = mkdtempSync(join(tmpdir(), "migration-rules-"));
  const found: string[] = [];
  try {
    for (let version = schema.base + 1; version <= schema.latest; version++) {
      const path = join(dir, `${version}.db`);
      const db = new Database(path);
      try {
        db.pragma("journal_mode = WAL");
        upTo(schema, version - 1).open(db, "migrate");
        seed(db, values);
        const before = { tables: tables(db), indexes: indexes(db) };
        upTo(schema, version).open(db, "migrate");
        const after = { tables: tables(db), indexes: indexes(db) };
        const big = (table: string) => !schema.small.has(table);
        for (const [name, table] of Object.entries(after.tables).filter(([name]) => big(name))) {
          const was = before.tables[name];
          if (was === undefined) {
            if (table.rows !== EMPTY) found.push(`migration ${version} fills ${name}, a big table it makes`);
            continue;
          }
          if (JSON.stringify(table.columns) !== JSON.stringify(was.columns)) found.push(`migration ${version} changes the columns of ${name}, a big table`);
          if (table.sql !== was.sql && !widened(was.sql, table.sql)) found.push(`migration ${version} changes the stored text of ${name}, a big table`);
          if (table.rootpage !== was.rootpage) found.push(`migration ${version} makes ${name}, a big table, again`);
          if (table.rows !== was.rows) found.push(`migration ${version} writes the rows of ${name}, a big table`);
        }
        for (const [name, index] of Object.entries(after.indexes).filter(([, index]) => big(index.table))) {
          const was = before.indexes[name];
          const made = was === undefined || was.sql !== index.sql || was.rootpage !== index.rootpage;
          if (made && !schema.indexed.has(version)) found.push(`migration ${version} indexes ${index.table}, a big table (${name}), and is not on the list of index migrations`);
        }
      } finally {
        db.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return found;
}

function upTo(schema: Schema, version: number): Schema {
  return new Schema({
    name: schema.name, file: schema.file, base: schema.base, baseline: schema.baseline, migrations: schema.migrations.slice(0, version - schema.base),
    small: [...schema.small], indexed: [...schema.indexed], foreignKeys: schema.foreignKeys,
  });
}

const CHECK_LIST = /CHECK\s*\(\s*(\w+)\s+IN\s*\(([^)]*)\)\s*\)/giu;

function lists(sql: string): Map<string, unknown[]> {
  const found = new Map<string, unknown[]>();
  for (const [, column, list] of sql.matchAll(CHECK_LIST)) {
    found.set(column!, list!.split(",").map((value) => value.trim()).map((value) => (value.startsWith("'") ? value.slice(1, -1) : Number(value))));
  }
  return found;
}

function widened(was: string, now: string): boolean {
  if (was.replace(CHECK_LIST, "CHECK($1)") !== now.replace(CHECK_LIST, "CHECK($1)")) return false;
  const after = lists(now);
  return [...lists(was)].every(([column, list]) => list.every((value) => after.get(column)?.includes(value) === true));
}

function seed(db: Database.Database, values: Values): void {
  const all = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; sql: string }[];
  for (const { name: table, sql } of all) {
    const columns = db.prepare("SELECT name, type FROM pragma_table_info(?)").all(table) as { name: string; type: string }[];
    const checked = lists(sql);
    const insert = db.prepare(`INSERT INTO "${table}" (${columns.map((column) => `"${column.name}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
    const row = (n: number, varied?: { column: string; value: unknown }) => insert.run(...columns.map((column) => {
      if (varied?.column === column.name) return varied.value;
      const stated = values[table]?.[column.name];
      if (stated !== undefined) return stated;
      const list = checked.get(column.name);
      if (list !== undefined) return list[0];
      return /INT/iu.test(column.type) ? 7 + n : /REAL/iu.test(column.type) ? 1.5 + n : `synthetic ${table}.${column.name}${n === 0 ? "" : ` ${n}`}`;
    }));
    row(0);
    let n = 0;
    for (const [column, list] of checked) for (const value of list.slice(1)) row(++n, { column, value });
  }
}

function digest(rows: unknown[]): string {
  const ordered = rows.map((row) => JSON.stringify(row)).sort();
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}
const EMPTY = digest([]);

function tables(db: Database.Database): Record<string, Table> {
  const rows = db.prepare("SELECT name, sql, rootpage FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string; sql: string; rootpage: number }[];
  return Object.fromEntries(rows.map((row) => [row.name, {
    sql: row.sql,
    rootpage: row.rootpage,
    columns: db.prepare("SELECT * FROM pragma_table_xinfo(?)").all(row.name),
    rows: digest(db.prepare(`SELECT * FROM "${row.name}"`).raw().all()),
  }]));
}

function indexes(db: Database.Database): Record<string, Index> {
  const rows = db.prepare("SELECT name, tbl_name AS \"table\", sql, rootpage FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL").all() as ({ name: string } & Index)[];
  return Object.fromEntries(rows.map(({ name, ...index }) => [name, index]));
}
