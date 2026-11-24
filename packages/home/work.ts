import type Database from "better-sqlite3";
import { refused } from "./refusal.js";

export const READ_TOO_BROAD = "this asks more of the record's index than one call reads: ask for less at once, or narrow it by a filter";

export class Work {
  #spent = 0;
  #stopped = false;
  readonly #within: Work | undefined;

  constructor(readonly budget: number, readonly reads = true, within?: Work) {
    if (budget !== Infinity && !wholeRows(budget)) throw new Error(`a read's budget is a whole number of rows, not ${budget}`);
    this.#within = reads ? within : undefined;
  }

  inner(budget: number): Work {
    return new Work(budget, true, this);
  }

  beside(budget: number, reads = true): Work {
    return new Work(budget, reads, this.#within);
  }

  get spent(): number {
    return this.#spent;
  }

  get left(): number {
    return Math.min(this.budget - this.#spent, this.#within?.left ?? Infinity);
  }

  get out(): boolean {
    return this.#stopped || this.left <= 0;
  }

  walk<T>(statement: Database.Statement, params: readonly unknown[], limit: number): { rows: T[]; more: boolean } {
    if (!wholeRows(limit)) throw new Error(`a walk's limit is a whole number of rows, not ${limit}`);
    if (GUARDED) guard(statement, "walk");
    if (limit === 0) return { rows: [], more: false };
    const take = this.#stopped ? 0 : Math.min(limit, this.left - 1);
    if (take <= 0) {
      this.#stopped = true;
      return { rows: [], more: true };
    }
    const rows = statement.all(...params, take + 1) as T[];
    this.#count(rows.length);
    return rows.length > take ? { rows: rows.slice(0, take), more: true } : { rows, more: false };
  }

  replay<T>(rows: readonly T[], more: boolean, limit: number): { rows: T[]; more: boolean } {
    if (!wholeRows(limit)) throw new Error(`a walk's limit is a whole number of rows, not ${limit}`);
    if (limit === 0) return { rows: [], more: false };
    const take = this.#stopped ? 0 : Math.min(limit, this.left - 1);
    if (take <= 0) {
      this.#stopped = true;
      return { rows: [], more: true };
    }
    if (rows.length > take) {
      this.#count(take + 1);
      return { rows: rows.slice(0, take), more: true };
    }
    this.#count(rows.length + (more ? 1 : 0));
    return { rows: [...rows], more };
  }

  point<T>(statement: Database.Statement, params: readonly unknown[]): T | undefined {
    if (GUARDED) guard(statement, "point");
    if (this.left < 1) {
      if (this.budget - this.#spent >= 1) refused("TOO_BROAD", READ_TOO_BROAD);
      throw new Error(`a lookup with no row left of a budget of ${this.budget}: reserve its unit first`);
    }
    const row = statement.get(...params) as T | undefined;
    this.#count(1);
    return row;
  }

  reserve(rows: number): boolean {
    if (!wholeRows(rows)) throw new Error(`a reservation is a whole number of rows, not ${rows}`);
    if (this.left >= rows) return true;
    this.#stopped = true;
    return false;
  }

  made(rows: number): boolean {
    if (!wholeRows(rows)) throw new Error(`units made are a whole number of rows, not ${rows}`);
    if (this.#stopped || this.left < rows) {
      this.#stopped = true;
      return false;
    }
    this.#count(rows);
    return true;
  }

  end(): void {
    if (this.#spent > this.budget) throw new Error(`a read spent ${this.#spent} rows of a budget of ${this.budget}`);
  }

  #count(rows: number): void {
    this.#spent += rows;
    if (this.#within !== undefined) this.#within.#count(rows);
    else if (this.reads) counted += rows;
  }
}

const wholeRows = (rows: number): boolean => Number.isInteger(rows) && rows >= 0;

let counted = 0;
export function rowsCounted(): number {
  return counted;
}

export const GUARDED = process.env.LIFESTREAM_TEST_WALKS === "1";
const passed = new Set<string>();
const guard = (statement: Database.Statement, as: "walk" | "point"): void => {
  const key = `${as} ${statement.source}`;
  if (passed.has(key)) return;
  (as === "walk" ? assertWalk : assertPoint)(statement.database, statement.source);
  passed.add(key);
};

const REFUSED = /SUBQUERY|CO-ROUTINE|MATERIALIZE|TEMP B-TREE|BLOOM FILTER|MERGE|AUTOMATIC|MULTI-INDEX|COMPOUND|UNION/;
const FOLDS = new Set(["AggStep", "AggStep1", "AggFinal", "AggValue", "AggInverse", "Count", "SorterOpen"]);
const FOLDED = /\bDISTINCT\b|\bGROUP\s+BY\b/i;
const NOT_ALIAS = new Set(["indexed", "not", "where", "join", "on", "left", "inner", "cross", "natural", "order", "group", "limit", "using", "as", "outer"]);

export function assertWalk(db: Database.Database, sql: string): void {
  if (!/\bLIMIT\s+\?\s*$/i.test(sql)) throw new Error(`not a walk, its text does not end in LIMIT ?: ${sql}`);
  const [first, ...rest] = planned(db, sql);
  if (first === undefined || !(/^SEARCH /.test(first) || /^SCAN \S+ VIRTUAL TABLE/.test(first))) {
    throw new Error(`not a walk, it enters no index at a bound (${first}): ${sql}`);
  }
  for (const line of rest) if (!lookupByWholeKey(db, sql, line)) throw new Error(`not a walk, a step reads more than one row (${line}): ${sql}`);
}

export function assertPoint(db: Database.Database, sql: string): void {
  for (const line of planned(db, sql)) if (!lookupByWholeKey(db, sql, line)) throw new Error(`not a point, a step reads more than one row (${line}): ${sql}`);
}

function planned(db: Database.Database, sql: string): string[] {
  if (FOLDED.test(sql)) throw new Error(`not a walk, it folds rows: ${sql}`);
  const params = new Array((sql.match(/\?/g) ?? []).length).fill(null);
  const lines = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((each) => each.detail);
  const refused = lines.find((line) => REFUSED.test(line));
  if (refused !== undefined) throw new Error(`not a walk, it builds a list aside (${refused}): ${sql}`);
  const fold = (db.prepare(`EXPLAIN ${sql}`).all(...params) as { opcode: string }[]).find((each) => FOLDS.has(each.opcode));
  if (fold !== undefined) throw new Error(`not a walk, it aggregates or sorts (${fold.opcode}): ${sql}`);
  return lines;
}

function lookupByWholeKey(db: Database.Database, sql: string, planLine: string): boolean {
  const line = planLine.replace(/ LEFT-JOIN$/u, "");
  if (/^SEARCH \S+ USING INTEGER PRIMARY KEY \(rowid=\?\)$/.test(line)) return true;
  const found = /^SEARCH (\S+) USING (?:(?:COVERING )?INDEX (\S+)|PRIMARY KEY) \(([^)]*)\)$/.exec(line);
  if (found === null) return false;
  const [, alias, index, bound] = found as unknown as [string, string, string | undefined, string];
  const equal = new Set(bound.split(" AND ").filter((each) => /^\w+=\?$/.test(each)).map((each) => each.slice(0, -2)));
  const [schema, table] = tableOf(sql, alias);
  let key: string[];
  if (index === undefined) {
    key = (db.prepare(`SELECT name FROM pragma_table_info(?, ?) WHERE pk > 0`).pluck().all(table, schema) as string[]);
  } else {
    const unique = db.prepare(`SELECT "unique" FROM pragma_index_list(?, ?) WHERE name = ?`).pluck().get(table, schema, index);
    if (unique !== 1) return false;
    key = db.prepare(`SELECT name FROM pragma_index_info(?, ?)`).pluck().all(index, schema) as string[];
  }
  return key.length > 0 && key.every((column) => equal.has(column));
}

function tableOf(sql: string, alias: string): [schema: string, table: string] {
  for (const [, named, as] of sql.matchAll(/\b(?:FROM|JOIN)\s+([\w.]+)(?:\s+(?:AS\s+)?(\w+))?/gi)) {
    const given = as !== undefined && !NOT_ALIAS.has(as.toLowerCase()) ? as : undefined;
    const [schema, table] = named!.includes(".") ? named!.split(".", 2) as [string, string] : ["main", named!];
    if ((given ?? table) === alias) return [schema, table];
  }
  throw new Error(`no table is named ${alias} in: ${sql}`);
}
