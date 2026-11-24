import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { FILL_ASKS, FILL_HEADS, HELD_MARK, homeSchema, LEFT_MARK, openHome, openHomeFolder, type DaySettings, type Guard, type HomeDb, type OpenView, type ReaderOutput } from "./index.js";
import { Records } from "./records.js";
import { ReadView } from "./view.js";

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const MINUTE = 60_000;
const DAY_MS = 86_400_000;
const DAY: DaySettings = { zone: "UTC", day_start_hour: 0 };
const object: Guard = (content) => (typeof content === "object" && content !== null ? [] : ["not an object"]);
const GUARDS = { msg: object, chat: object, bulk: object };
const A = "whatsapp:+15550000001:macbook-pro-0001";
const B = "gmail:person-a@example.com:cloud";
const FAMILY = "messages";
const BLOB = "a".repeat(64);

const SMALL = homeSchema.small;
const LOOSE = new Set(["source", "kind", "family"]);

const WALKS: { of: RegExp; plan?: RegExp; why: string }[] = [
  { of: /^SELECT coalesce\(max\(seq\), 0\) AS seq FROM statements$/u, why: "max(seq): one entry, the newest" },
  { of: /^SELECT coalesce\(max\(rowid\), 0\) AS rowid FROM versions$/u, why: "max(rowid): one entry, the newest (Storage's M, stored.ts)" },
  { of: /^WITH RECURSIVE walk\(kind\) AS \( SELECT min\(kind\) FROM statements WHERE source = \?/u, why: "a source's kinds by min(kind): one entry per kind" },
  { of: /^SELECT version, min\(seq\) AS seq FROM statements WHERE source = \? AND kind = \? GROUP BY version$/u, why: "a forget of a whole kind" },
  { of: /^DELETE FROM (?:statements|heads|start_minutes|wanted_blobs|rereads) WHERE source = \? AND kind = \?(?: RETURNING blob)?$/u, why: "a forget of a whole kind" },
  { of: /^DELETE FROM rereads WHERE source = \? AND kind = \? AND key = \?$/u, why: "an erasure's rereads: a queue pruned as it is read" },
  { of: /^SELECT count\(\*\) AS heads, .* FROM \(SELECT key, version FROM heads WHERE source = \? AND kind = \? ORDER BY key LIMIT \?\)$/u, why: "the held fill's bounded range: FILL_HEADS heads a commit" },
  { of: /^DELETE FROM start_minutes WHERE minute < \?$/u, why: "the tally's daily prune of its eight days" },
  { of: /^SELECT unit, days FROM extracts WHERE family = \? ORDER BY unit$/u, why: "every unit of a family, marked again whole" },
  { of: /^SELECT DISTINCT day FROM extract_days ORDER BY day$/u, why: "every day an extract feeds, for the one-day fixture (home/fixture-day.ts)" },
  { of: /^SELECT n\.unit FROM extracts_next n LEFT JOIN extracts e/u, why: "a rebuild's compare reads its generation whole" },
  { of: /^SELECT e\.unit FROM extracts e WHERE e\.family = \? AND NOT EXISTS \(SELECT 1 FROM extracts_next n/u, why: "a rebuild's compare reads the served rows whole" },
  { of: /^DELETE FROM extracts_next WHERE family = \?$/u, why: "the start's forget of a family the release does not run: its next rows whole" },
  { of: /^SELECT .* FROM runs WHERE outcome IS NULL ORDER BY id$/u, plan: /^SCAN runs USING INDEX runs_open$/u, why: "the open runs: `runs_open` holds them alone" },
  { of: /^UPDATE runs SET outcome = 'interrupted', ended_ms = \? WHERE outcome IS NULL$/u, plan: /^SCAN runs USING INDEX runs_open$/u,
    why: "the start's end of the open runs: `runs_open` holds them alone" },
  { of: /^SELECT family, unit, error, at_ms FROM extracts_aside WHERE family = \? ORDER BY unit$/u, why: "a family's set-aside units" },
  { of: /^DELETE FROM extracts_aside WHERE family = \?$/u, why: "a family's set-aside units cleared" },
];

interface Planned {
  text: string;
  plan: string[];
  walks: string[];
}

describe("every core statement's plan", () => {
  const dir = mkdtempSync(join(tmpdir(), "core-plans-"));
  const artifact: Record<string, unknown> = {};
  afterAll(() => {
    writeFileSync(join(dir, "plans.json"), `${JSON.stringify(artifact, null, 2)}\n`);
    if (process.env.LIFESTREAM_KEEP_ARTIFACTS !== "1") rmSync(dir, { recursive: true, force: true });
  });

  it("walks no growing table but on the list, a trigger's join included, and calls every view method and records writer", () => {
    const path = join(dir, "home.db");
    const ran = new Map<string, unknown[]>();
    const called = new Set<string>();
    const during: Window = { runs: null };
    const restore = [watchPrepare(ran, during), watchCalls(ReadView.prototype, "view", called), watchCalls(Records.prototype, "records", called)];
    let restated: string[];
    try {
      restated = exercise(path, during);
    } finally {
      for (const undo of restore) undo();
    }

    const reached = (part: string) => [...ran.keys()].some((text) => text.includes(part));
    expect({
      head_by: reached("AS ours FROM (SELECT run FROM statements INDEXED BY statements_record"),
      stated_by_delivery: reached("JOIN runs r ON r.id = s.run WHERE s.kind = ?"),
      fill_resumed: reached("AND key > ? ORDER BY key LIMIT ?"),
      asks_fill_resumed: reached("AND (work_id, started, at_key, unit, item, prompt, family) > (?, ?, ?, ?, ?, ?, ?) ORDER BY"),
      asks_counted_passed: reached("prompt = ?) AND (work_id, started, at_key, unit, item, prompt, family) <= ("),
      item_route: reached("INSERT INTO dirty_units (family, unit, end_ms, woken) SELECT e.family"),
    }).toEqual({ head_by: true, stated_by_delivery: true, fill_resumed: true, asks_fill_resumed: true, asks_counted_passed: true, item_route: true });
    expect(restated.filter((text) => /\bversions\b/u.test(text)), "a restated row reads versions").toEqual([]);
    expect(restated.length).toBeGreaterThan(0);

    const missed = [...names(ReadView.prototype, "view"), ...names(Records.prototype, "records")].filter((name) => !called.has(name));
    expect(missed, "a ReadView method or Records writer the census did not call").toEqual([]);

    const planner = new Database(path, { readonly: true });
    let planned: Planned[];
    try {
      const schema = schemaOf(planner);
      const statements = [...ran].map(([text, params]) => plan(planner, schema, text, params));
      const triggers = (planner.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name").all() as { name: string; sql: string }[])
        .flatMap(({ name, sql }) => bodyOf(sql).map((statement) => {
          let count = 0;
          const text = statement.replace(/\b(?:new|old)\.\w+/gu, () => (count++, "?"));
          return { ...plan(planner, schema, text, Array.from({ length: count }, () => null)), text: `${name}: ${text}` };
        }));
      planned = [...statements, ...triggers];
    } finally {
      planner.close();
    }

    const walking = planned.filter((each) => each.walks.length > 0);
    const excused = (walk: (typeof WALKS)[number], each: Planned) => walk.of.test(each.text) && (walk.plan === undefined || each.walks.every((step) => walk.plan!.test(step)));
    const unlisted = walking.filter((each) => !WALKS.some((walk) => excused(walk, each))).map((each) => `${each.text}\n  ${each.plan.join("\n  ")}`);
    const stale = WALKS.filter((walk) => !walking.some((each) => excused(walk, each))).map((walk) => `${walk.of} (${walk.why})`);
    artifact.statements = planned;
    artifact.walks = walking.map((each) => ({ text: each.text, walks: each.walks, why: WALKS.find((walk) => walk.of.test(each.text))?.why ?? null }));
    expect(unlisted, "a statement walks a growing table").toEqual([]);
    expect(stale, "an exception no statement needs").toEqual([]);
    expect(planned.length).toBeGreaterThan(100);
  });

  it("reads a walk on a left join's right side, a line it cannot read, a LIMIT inside a subquery and a LIMIT past an unbound test as walks", () => {
    const path = join(mkdtempSync(join(dir, "rule-")), "home.db");
    openHome(openHomeFolder(dirname(path)), "migrate").close();
    const planner = new Database(path, { readonly: true });
    try {
      const schema = schemaOf(planner);
      const left = plan(planner, schema, "SELECT d.unit, e.start_ms FROM extract_days d LEFT JOIN extracts e ON e.family = d.family AND e.content = d.unit WHERE d.family = ? AND d.day = ?", [null, null]);
      expect(left.walks, left.plan.join("; ")).toEqual([expect.stringMatching(/^SEARCH e .*\(family=\?\) LEFT-JOIN$/u)]);
      const inner = plan(planner, schema, "SELECT h.key FROM heads h WHERE h.source = ? AND EXISTS (SELECT 1 FROM statements s WHERE s.source = h.source AND s.kind = h.kind AND s.key = h.key LIMIT 1)", [null]);
      expect(inner.walks, inner.plan.join("; ")).toEqual(["SEARCH h USING PRIMARY KEY (source=?)"]);
      const tested = plan(planner, schema, "SELECT 1 FROM statements WHERE source = ? AND origin = ? LIMIT 1", [null, null]);
      expect(tested.walks, tested.plan.join("; ")).toEqual([expect.stringMatching(/^SEARCH statements .*\(source=\?\)$/u)]);
      const counted = plan(planner, schema, "SELECT 1 FROM statements WHERE source = ? LIMIT 1", [null]);
      expect(counted.walks, counted.plan.join("; ")).toEqual([]);
      const newest = plan(planner, schema, "SELECT seq FROM events ORDER BY seq DESC LIMIT 1", []);
      expect(newest.walks, newest.plan.join("; ")).toEqual([]);
      for (const where of ["source = ? AND lower(origin) = ?", "source = ? AND (origin = ? OR late = ?)"]) {
        const unread = plan(planner, schema, `SELECT 1 FROM statements WHERE ${where} LIMIT 1`, [null, null, null].slice(0, where.split("?").length - 1));
        expect(unread.walks, `${where}: ${unread.plan.join("; ")}`).toEqual([expect.stringMatching(/^SEARCH statements .*\(source=\?\)$/u)]);
      }
      expect(walks("SEARCH heads IN SOME FORM SQLITE ADDS LATER", "SELECT 1 FROM heads", schema)).toBe(true);
      expect(walks("SCAN json_each VIRTUAL TABLE INDEX 1:", "SELECT 1", schema)).toBe(false);
    } finally {
      planner.close();
    }
  });
});

describe("a publish from lists", () => {
  const dir = mkdtempSync(join(tmpdir(), "core-publish-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("writes what the compare names, and a list only says where to look: a wrong name, a unit set aside now and the asks and marks of a row that did not change stay", () => {
    const path = join(dir, "home.db");
    const db: HomeDb = openHome(openHomeFolder(dirname(path)), "migrate");
    const row = (unit: string, reading: string, end_ms: number, days = ["2026-10-26"]) => ({
      family: FAMILY, unit, reading, code: "c1", content: { unit, reading }, start_ms: NOW - DAY_MS, end_ms, days, items: [`i-${unit}`], seq: 1,
    });
    const ask = (unit: string) => ({
      family: FAMILY, item: `i-${unit}`, prompt: "p1", version: 1, input_hash: "h", unit, work_id: "w", at_key: NOW, started: false,
      waits: null, retry_ms: null, given_up: null, unhideable: null, state: "pending" as const,
    });
    const SERVED = ["equal", "changed", "days", "gone", "aside-now", "aside-before"];
    try {
      db.commit((tx) => {
        for (const unit of SERVED) {
          tx.derived.extracts.put(row(unit, "r1", NOW));
          tx.tables.asks.put(ask(unit));
        }
        tx.derived.next.put(row("equal", "r1", NOW));
        tx.derived.next.put(row("changed", "r2", NOW + MINUTE));
        tx.derived.next.put(row("days", "r1", NOW, ["2026-10-25"]));
        tx.derived.next.put(row("new", "r1", NOW));
        tx.derived.extracts.aside.put(FAMILY, "aside-before", "it threw", NOW);
        tx.derived.extracts.aside.clear(FAMILY);
        tx.derived.extracts.aside.put(FAMILY, "aside-now", "it threw", NOW);
      });
      const raw = new Database(path, { readonly: true });
      const state = () => ({
        served: raw.prepare("SELECT unit, reading, days, end_ms FROM extracts WHERE family = ? ORDER BY unit").all(FAMILY),
        asks: raw.prepare("SELECT unit, at_key FROM asks WHERE family = ? ORDER BY unit").all(FAMILY) as { unit: string; at_key: number }[],
        marks: Object.fromEntries((raw.prepare("SELECT unit, marks FROM dirty_units WHERE family = ?").all(FAMILY) as { unit: string; marks: number }[]).map((each) => [each.unit, each.marks])),
        next: raw.prepare("SELECT count(*) FROM extracts_next WHERE family = ?").pluck().get(FAMILY),
      });
      try {
        const lists = db.commit((tx) => tx.derived.extracts.compare(FAMILY));
        expect(lists).toEqual({ changed: ["changed", "days", "new"], gone: ["aside-before", "aside-now", "gone"] });
        const before = state();
        const published = db.commit((tx) => tx.derived.extracts.publish(FAMILY, {
          changed: [...lists.changed, "equal", "nowhere"], gone: [...lists.gone, "changed", "new", "nowhere"],
        }));
        expect({ written: published.written, deleted: published.deleted }).toEqual({ written: ["changed", "days", "new"], deleted: ["aside-before", "gone"] });
        const after = state();
        expect(after.served).toEqual([
          { unit: "aside-now", reading: "r1", days: '["2026-10-26"]', end_ms: NOW },
          { unit: "changed", reading: "r2", days: '["2026-10-26"]', end_ms: NOW + MINUTE },
          { unit: "days", reading: "r1", days: '["2026-10-25"]', end_ms: NOW },
          { unit: "equal", reading: "r1", days: '["2026-10-26"]', end_ms: NOW },
          { unit: "new", reading: "r1", days: '["2026-10-26"]', end_ms: NOW },
        ]);
        expect(after.next).toBe(4);
        expect(after.asks).toEqual(before.asks.filter((each) => each.unit !== "gone" && each.unit !== "aside-before")
          .map((each) => each.unit === "changed" ? { ...each, at_key: NOW + MINUTE } : each));
        const marked = Object.keys(after.marks).filter((unit) => after.marks[unit] !== before.marks[unit]).sort();
        expect(marked).toEqual(["changed", "days", "new"]);
        expect(Object.keys(after.marks).filter((unit) => unit === "gone" || unit === "aside-before")).toEqual([]);
      } finally {
        raw.close();
      }
    } finally {
      db.close();
    }
  });
});

describe("a walk's emptying", () => {
  const dir = mkdtempSync(join(tmpdir(), "core-empty-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("deletes at most its limit a commit, first by the key, of its family alone, and says how many went", () => {
    const db: HomeDb = openHome(openHomeFolder(dir), "migrate");
    const row = (family: string, n: number) => ({
      family, unit: `u${String(n).padStart(3, "0")}`, reading: "r", code: "c1", content: { n }, start_ms: NOW, end_ms: NOW, days: [], items: [], seq: 1,
    });
    try {
      db.commit((tx) => {
        for (let n = 0; n < 120; n++) tx.derived.next.put(row(FAMILY, n));
        tx.derived.next.put(row("other", 0));
      });
      const left = () => db.commit((tx) => ({ any: tx.derived.next.any(FAMILY), first: tx.derived.next.units(FAMILY, null, 1), other: tx.derived.next.any("other") }));
      const went = [db.commit((tx) => tx.derived.next.empty(FAMILY, 50)), db.commit((tx) => tx.derived.next.empty(FAMILY, 50))];
      expect({ went, left: left() }).toEqual({ went: [50, 50], left: { any: true, first: ["u100"], other: true } });
      expect(db.commit((tx) => tx.derived.next.units(FAMILY, "u110", 50))).toEqual(["u111", "u112", "u113", "u114", "u115", "u116", "u117", "u118", "u119"]);
      expect(db.commit((tx) => [tx.derived.next.empty(FAMILY, 50), tx.derived.next.empty(FAMILY, 50)])).toEqual([20, 0]);
      expect(left()).toEqual({ any: false, first: [], other: true });
      expect(db.commit((tx) => tx.derived.next.clear("other"))).toBe(1);
    } finally {
      db.close();
    }
  });
});

interface Window {
  runs: string[] | null;
}

function watchPrepare(ran: Map<string, unknown[]>, during: Window): () => void {
  const prepare = Database.prototype.prepare;
  Database.prototype.prepare = function (this: Database.Database, sql: string) {
    const statement = prepare.call(this, sql) as unknown as Record<"get" | "all" | "run" | "iterate", (...params: unknown[]) => unknown>;
    for (const method of ["get", "all", "run", "iterate"] as const) {
      const real = statement[method].bind(statement);
      statement[method] = (...params: unknown[]) => {
        const text = sql.replace(/\s+/gu, " ").trim();
        if (!ran.has(text)) ran.set(text, params);
        during.runs?.push(text);
        return real(...params);
      };
    }
    return statement as unknown as Database.Statement;
  } as typeof prepare;
  return () => { Database.prototype.prepare = prepare; };
}

function names(prototype: object, of: string): string[] {
  return Object.getOwnPropertyNames(prototype).filter((name) => name !== "constructor").map((name) => `${of}.${name}`);
}

function watchCalls(prototype: object, of: string, called: Set<string>): () => void {
  const kept = Object.getOwnPropertyNames(prototype).filter((name) => name !== "constructor")
    .map((name) => [name, Object.getOwnPropertyDescriptor(prototype, name)!] as const);
  for (const [name, descriptor] of kept) {
    const note = () => called.add(`${of}.${name}`);
    if (typeof descriptor.value === "function") {
      const real = descriptor.value as (...args: unknown[]) => unknown;
      Object.defineProperty(prototype, name, { ...descriptor, value: function (this: unknown, ...args: unknown[]) { note(); return real.apply(this, args); } });
    } else if (descriptor.get !== undefined) {
      const real = descriptor.get;
      Object.defineProperty(prototype, name, { ...descriptor, get: function (this: unknown) { note(); return real.call(this); } });
    }
  }
  return () => { for (const [name, descriptor] of kept) Object.defineProperty(prototype, name, descriptor); };
}

interface Schema {
  tables: Set<string>;
  indexes: Map<string, string>;
}

function schemaOf(db: Database.Database): Schema {
  const rows = db.prepare("SELECT type, name, tbl_name FROM sqlite_schema WHERE type IN ('table', 'index')").all() as { type: string; name: string; tbl_name: string }[];
  return {
    tables: new Set(rows.filter((row) => row.type === "table").map((row) => row.name)),
    indexes: new Map(rows.filter((row) => row.type === "index").map((row) => [row.name, row.tbl_name])),
  };
}

function bodyOf(sql: string): string[] {
  const body = sql.slice(sql.search(/\bBEGIN\b/u) + "BEGIN".length, sql.search(/\bEND\s*$/u));
  return body.split(";").map((statement) => statement.replace(/\s+/gu, " ").trim()).filter((statement) => statement !== "");
}

function plan(db: Database.Database, schema: Schema, text: string, params: unknown[]): Planned {
  let rows: { detail: string }[];
  try {
    rows = db.prepare(`EXPLAIN QUERY PLAN ${text}`).all(...params) as { detail: string }[];
  } catch (error) {
    return { text, plan: [`could not be planned: ${(error as Error).message}`], walks: [`could not be planned: ${(error as Error).message}`] };
  }
  const plan = rows.map((row) => row.detail);
  const limited = ENDS_LIMITED.test(text) && !plan.some((detail) => detail.includes("USE TEMP B-TREE"));
  return { text, plan, walks: plan.filter((detail) => walks(detail, text, schema) && !(limited && boundWhole(detail, text))) };
}

function boundWhole(detail: string, text: string): boolean {
  const shape = /^SELECT\b.*?\bFROM\s+(\w+(?:\s+(?:AS\s+)?(?!WHERE\b|ORDER\b|LIMIT\b)\w+)?)(?:\s+WHERE\s+(.*?))?(?:\s+ORDER BY\b.*)?\s+LIMIT\b[^()]*$/isu
    .exec(text.replace(/\s+/gu, " "));
  if (shape === null) return false;
  const where = shape[2];
  if (where === undefined) return true;
  if (/\bJOIN\b|\bSELECT\b|\bOR\b|[()]/iu.test(where)) return false;
  const bound = new Set(columnsOf(/ \((.*)\)$/u.exec(detail.replace(/ LEFT-JOIN$/u, ""))?.[1] ?? ""));
  return where.split(/\s+AND\s+/iu).every((term) => {
    const test = /^(?:\w+\.)?(\w+)\s*(?:=|==|<|>|<=|>=|!=|<>|IS(?:\s+NOT)?)\s*(?:\?|'[^']*'|-?\d+|NULL)$/iu.exec(term.trim());
    return test !== null && bound.has(test[1]!);
  });
}

const ENDS_LIMITED = /\bLIMIT\s+(?:\?|\d+)(?:\s+OFFSET\s+(?:\?|\d+))?\s*$/iu;

function walks(detail: string, text: string, schema: Schema): boolean {
  if (!/^(?:SEARCH|SCAN) /u.test(detail)) return false;
  const line = detail.replace(/ LEFT-JOIN$/u, "");
  if (/^SCAN \S+ VIRTUAL TABLE\b/u.test(line) || line === "SCAN CONSTANT ROW") return false;
  const step = /^(?:SEARCH|SCAN) (\S+)(?: USING (?:(?:AUTOMATIC )?(?:PARTIAL )?COVERING INDEX|INDEX) (\S+)| USING (?:INTEGER )?PRIMARY KEY)?(?: \((.*)\))?$/u.exec(line);
  if (step === null) return true;
  const [, name, index, bound] = step;
  const table = tableOf(name!, index, text, schema);
  if (table === undefined || SMALL.has(table) || table.startsWith("sqlite_")) return false;
  return columnsOf(bound ?? "").every((column) => LOOSE.has(column));
}

function tableOf(name: string, index: string | undefined, text: string, schema: Schema): string | undefined {
  if (index !== undefined && schema.indexes.has(index)) return schema.indexes.get(index);
  if (schema.tables.has(name)) return name;
  if (!/^\w+$/u.test(name)) return undefined;
  for (const match of text.matchAll(new RegExp(`\\b(\\w+)\\s+(?:AS\\s+)?${name}\\b`, "gu"))) {
    if (schema.tables.has(match[1]!)) return match[1];
  }
  return undefined;
}

function columnsOf(bound: string): string[] {
  if (bound === "") return [];
  return bound.split(" AND ").filter((term) => !term.startsWith("ANY(")).flatMap((term) =>
    term.split(/[=<>]| IN\b| IS\b/u)[0]!.replace(/[()]/gu, "").split(",").map((column) => column.trim()).filter((column) => column !== ""));
}

function exercise(path: string, during: Window): string[] {
  let restated: string[] = [];
  const db = openHome(openHomeFolder(dirname(path)), "migrate");
  try {
    let stated = NOW;
    const land = (source: string, rows: ReaderOutput[], has = true) => db.commit((tx) => {
      stated += 1_000;
      const run = tx.tables.runs.start({ kind: "import", subject: source, started_ms: stated });
      const landed = tx.records.land(run, { id: `${source}@${stated}`, source, stated_ms: stated }, rows, GUARDS, { has: () => has });
      tx.tables.runs.end(run, { ended_ms: stated, outcome: "ok" });
      return { run, landed };
    });
    const msg = (key: string, start_ms: number, extra: Partial<ReaderOutput> = {}): ReaderOutput => ({ kind: "msg", key, content: { text: key }, time: { start_ms, precision: "ms" }, ...extra });

    db.commit((tx) => {
      tx.tally.prune(DAY, NOW);
      tx.tables.sources.add({ id: A, vendor: "meta", connector: "whatsapp", added_ms: NOW });
      tx.tables.sources.add({ id: B, vendor: "google", connector: "gmail", added_ms: NOW });
    });
    const first = land(A, [
      ...Array.from({ length: 20 }, (_, n) => msg(`m${String(n).padStart(2, "0")}`, NOW - n * MINUTE)),
      msg("long", NOW - 3 * DAY_MS, { time: { start_ms: NOW - 3 * DAY_MS, end_ms: NOW, precision: "ms" } }),
      msg("dated", Date.UTC(2026, 9, 26), { time: { start_ms: Date.UTC(2026, 9, 26), precision: "day" } }),
      { kind: "chat", key: "c1", content: { name: "a chat" } },
    ]);
    land(A, [msg("linked", NOW - MINUTE, { blobs: [BLOB] })], false);
    land(A, [msg("m01", NOW - MINUTE, { content: { text: "changed" } }), msg("m02", NOW - 2 * MINUTE), { kind: "msg", key: "m03", content: null, gone: true }]);
    land(B, [msg("b1", NOW - MINUTE), msg("b2", NOW - 2 * MINUTE)]);

    during.runs = [];
    const again = land(A, Array.from({ length: 10 }, (_, n) => msg(`m${n + 10}`, NOW - (n + 10) * MINUTE)));
    restated = during.runs;
    during.runs = null;
    if (again.landed.restated !== 10) throw new Error(`restated ${again.landed.restated} of 10`);

    const twice = { id: `${A}@twice`, source: A, stated_ms: NOW + 500 };
    const slices = db.commit((tx) => tx.tables.runs.start({ kind: "import", subject: `${A} ${twice.id}`, started_ms: NOW }));
    db.commit((tx) => tx.records.land(slices, twice, [msg("twice", NOW - 30 * MINUTE, { content: { text: "one" } })], GUARDS, { has: () => true }));
    const second = db.commit((tx) => tx.records.land(slices, twice, [msg("twice", NOW - 30 * MINUTE, { content: { text: "two" } })], GUARDS, { has: () => true }));
    const reread = db.commit((tx) => tx.records.land(tx.tables.runs.start({ kind: "import", subject: `${A} ${twice.id}`, started_ms: NOW }), { ...twice, reread: true },
      [msg("twice", NOW - 30 * MINUTE, { content: { text: "one" } })], GUARDS, { has: () => true }));
    if (second.duplicated !== 1 || reread.duplicated !== 1) throw new Error(`repeats: ${second.duplicated}, ${reread.duplicated}`);

    land(A, Array.from({ length: FILL_HEADS + 10 }, (_, n): ReaderOutput => ({ kind: "bulk", key: `k${String(n).padStart(5, "0")}`, content: { n } })));

    db.commit((tx) => {
      tx.records.starts();
      tx.records.start(A, "msg");
      tx.records.top();
      tx.records.newestReread();
      tx.records.blobsArrived([BLOB], {});
      tx.records.rereadUnits(FAMILY, ["u1"]);
      tx.records.carryUnits(FAMILY, ["u2"]);
      tx.records.pruneRereads(1);
    });

    db.commit((tx) => {
      for (let n = 0; n < 5; n++) {
        tx.derived.extracts.put({
          family: FAMILY, unit: `u${n}`, reading: `r${n}`, code: "c1", content: { n }, start_ms: NOW - n * MINUTE, end_ms: NOW - n * MINUTE + 1,
          days: ["2026-10-26"], items: [`i${n}`], seq: 1,
        });
      }
      tx.derived.extracts.get(FAMILY, "u0");
      tx.derived.extracts.units(FAMILY);
      tx.derived.extracts.unitsOn(FAMILY, "2026-10-01", "2026-10-31");
      tx.derived.extracts.days();
      tx.derived.extracts.delete(FAMILY, "u4");
      tx.derived.next.put({ family: FAMILY, unit: "u0", reading: "r0-next", code: "c1", content: { n: 0 }, start_ms: NOW, end_ms: NOW + 1, days: ["2026-10-26"], items: ["i0"], seq: 2 });
      tx.derived.next.put({ family: FAMILY, unit: "u9", reading: "r9", code: "c1", content: { n: 9 }, start_ms: NOW, end_ms: NOW + 1, days: ["2026-10-25"], items: [], seq: 2 });
      tx.derived.next.delete(FAMILY, "u9");
      tx.derived.extracts.aside.put(FAMILY, "u3", "it threw", NOW);
      tx.derived.extracts.aside.list(FAMILY);
      tx.derived.extracts.publish(FAMILY, tx.derived.extracts.compare(FAMILY));
      tx.derived.extracts.aside.built(FAMILY, "u3");
      tx.derived.extracts.aside.clear(FAMILY);
      tx.derived.next.any(FAMILY);
      tx.derived.next.units(FAMILY, null, 50);
      tx.derived.next.units(FAMILY, "u0", 50);
      tx.derived.next.empty(FAMILY, 50);
      tx.derived.next.clear(FAMILY);
      tx.derived.dayUnits.put("2026-10-26", [{ family: FAMILY, unit: "u0", reading: "r0", code: "c1", shown: true }]);
      tx.derived.dayUnits.stale("2026-10-26");
      tx.derived.dayUnits.days(FAMILY, "u0");
      tx.derived.days.put("2026-10-26", "inputs", { total: 1, per_family: { [FAMILY]: 1 } });
      tx.derived.days.page(undefined, undefined, undefined, 10);
      for (const item of ["i0", "i1", "i2"]) {
        tx.derived.enrichments.put({ family: FAMILY, item, prompt: "p1", input_hash: "h", reply_key: "k", reused_from: null, content: { said: item }, state: "done" });
      }
      tx.derived.enrichments.put({ family: FAMILY, item: "i0", prompt: "p1", input_hash: "h2", reply_key: "k2", reused_from: null, content: { said: "again" }, state: "done" });
      tx.derived.enrichments.get(FAMILY, "i0", "p1");
      tx.derived.enrichments.list(FAMILY, { state: "done", item: "i0" });
      tx.derived.enrichments.delete(FAMILY, "i2", "p1");
      tx.derived.days.delete("2026-10-25");
    });

    const view: OpenView = db.view();
    try {
      const head = view.head({ source: A, kind: "msg", key: "m00" })!;
      view.position();
      view.statementAt(1);
      [...view.heads(A, "msg")];
      [...view.heads(A, "msg", undefined, { key: "m05", start_ms: null })];
      [...view.heads(A, "msg", { start_ms: NOW - 10 * MINUTE, end_ms: NOW })];
      [...view.heads(A, "msg", { start_ms: NOW - 10 * MINUTE }, { key: "m05", start_ms: NOW - 5 * MINUTE })];
      [...view.records(A, "msg", { end_ms: NOW })];
      [...view.byStart(A, "msg")];
      view.keyedUnder(A, "msg", "m0");
      view.erasedUnder(A, "msg", "m0");
      view.erasures(A);
      view.naming(BLOB);
      view.blobsOf(head.version);
      [...view.linked(A, "msg")];
      view.version(head.version);
      [...view.statements(0)];
      [...view.statements(0, { sources: [A] })];
      [...view.statements(0, { sources: [A, B], kinds: ["msg"] })];
      view.history({ source: A, kind: "msg", key: "m01" });
      view.sources();
      view.source(A);
      view.since(A, ["msg", "chat"]);
      view.extract(FAMILY, "u0");
      [...view.extracts(FAMILY)];
      [...view.extracts(FAMILY, { start_ms: NOW - 10 * MINUTE, end_ms: NOW + MINUTE })];
      [...view.extractsUnder(FAMILY, "u")];
      view.next.extract(FAMILY, "u0");
      [...view.next.extracts(FAMILY)];
      [...view.next.extracts(FAMILY, { start_ms: NOW - 10 * MINUTE, end_ms: NOW + MINUTE })];
      [...view.next.extractsUnder(FAMILY, "u")];
      [...view.horizon(NOW, FAMILY, view.next, 0).heads(A, "msg", { start_ms: NOW - DAY_MS })];
      view.horizon(NOW, FAMILY, view.next, 0).unitsPending(FAMILY);
      [...view.extractReadings(FAMILY)];
      [...view.extractReadings(FAMILY, "u")];
      view.extractsOn(FAMILY, "2026-10-26");
      view.unitsPending(FAMILY);
      view.extractPage(FAMILY, { unit: "u0" }, null, 10);
      view.extractPage(FAMILY, { day: "2026-10-26" }, null, 10);
      view.extractPage(FAMILY, { day: "2026-10-26" }, { unit: "u0", start_ms: null }, 10);
      view.extractPage(FAMILY, { start_ms: NOW - 10 * MINUTE, end_ms: NOW + MINUTE }, null, 10);
      view.extractPage(FAMILY, { start_ms: NOW - 10 * MINUTE, end_ms: NOW + MINUTE }, { unit: "u1", start_ms: NOW - MINUTE }, 10);
      view.dayUnits(FAMILY, "u0");
      view.rereads(0, 10);
      view.newestReread();
      view.holds(BLOB);
      view.enrichment(FAMILY, "i0", "p1");
      view.kinds(A);
      view.count(A, "msg");
      void view.snapshot;
      view.derived.days.page(undefined, undefined, undefined, 10);
      view.derived.next.units(FAMILY, null, 50);
      view.planUndo(first.run);
    } finally {
      view.close();
    }

    const planned = db.view();
    let plan: ReturnType<OpenView["planRepair"]>;
    try {
      plan = planned.planRepair({
        source: A, kinds: ["msg"],
        fix: (version) => version.key === "m05" ? { content: version.content, key: "m05-moved" } : { content: { ...(version.content as object), fixed: true } },
      });
    } finally {
      planned.close();
    }
    db.commit((tx) => tx.records.applyRepair(tx.tables.runs.start({ kind: "repair", subject: A, started_ms: NOW }), plan, { has: () => true }));
    const moved = db.view();
    try {
      if (moved.head({ source: A, kind: "msg", key: "m05-moved" }) === undefined) throw new Error("the repair moved no record to its new key");
    } finally {
      moved.close();
    }
    db.commit((tx) => tx.tables.itemRoutes.set({ family: FAMILY, item: "i0", prompt: "p1", route: "openrouter:a-model", model: "a-model" }));
    db.commit((tx) => tx.records.erase({ records: [{ source: A, kind: "msg", key: "m04" }], items: [{ family: FAMILY, item: "i1" }], units: [{ family: FAMILY, unit: "u1" }], reason: "the owner's", at_ms: NOW }));
    db.commit((tx) => tx.records.forget({ sources: [{ source: B, kinds: ["msg"] }], blobs: [BLOB] }));

    const raw = new Database(path);
    raw.exec(`UPDATE spans SET live = NULL; DELETE FROM meta WHERE key = '${HELD_MARK}'`);
    raw.close();
    db.commit((tx) => tx.records.heldMark());
    if (db.commit((tx) => tx.records.fillHeld())) throw new Error("the fill ended in one commit");
    const mark = db.commit((tx) => tx.records.heldMark());
    if (mark === null || !("at" in mark) || mark.at.kind !== "bulk") throw new Error(`the fill stands at ${JSON.stringify(mark)}`);
    land(A, [{ kind: "bulk", key: "k00001", content: null, gone: true }, { kind: "bulk", key: "k99999", content: { n: -1 } }]);
    while (!db.commit((tx) => tx.records.fillHeld()));
    const asks = new Database(path);
    const insert = asks.prepare(`INSERT INTO asks (family, item, prompt, prompt_hash, prompt_version, input_hash, unit, work_id, at_key, started, state)
      VALUES (?, ?, 'p1', '', 1, 'h', 'u0', 'w', ?, 0, 'pending')`);
    asks.transaction(() => {
      for (let n = 0; n < FILL_ASKS + 10; n++) insert.run(FAMILY, `a${n}`, NOW - n * MINUTE);
    })();
    asks.prepare("DELETE FROM asks_left").run();
    asks.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(LEFT_MARK, JSON.stringify({ at: null }));
    asks.close();
    if (db.commit((tx) => tx.tables.asks.fill())) throw new Error("the asks-left fill ended in one commit");
    db.commit((tx) => tx.tables.asks.put({
      family: FAMILY, item: "a0", prompt: "p1", version: 1, input_hash: "h", unit: "u0", work_id: "w", at_key: NOW + MINUTE, started: true,
      waits: null, retry_ms: null, given_up: null, unhideable: null, state: "pending",
    }));
    while (!db.commit((tx) => tx.tables.asks.fill()));
    db.commit((tx) => tx.tables.asks.left("w", [NOW - DAY_MS / 2]));
    db.commit((tx) => {
      tx.tally.mark();
      for (const chunk of tx.tally.chunks(DAY)) tx.tally.rebuild(chunk);
      tx.tally.complete();
    });
    db.commit((tx) => {
      tx.tables.runs.ended("import", `${A} ${twice.id}`);
      tx.tables.runs.unfinished("import", `${A} ${twice.id}`, slices);
      tx.tables.runs.running();
      tx.tables.runs.interrupt(NOW);
    });
  } finally {
    db.close();
  }
  return restated;
}
