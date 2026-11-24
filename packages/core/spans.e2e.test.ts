import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { openHome, openHomeFolder, type ExtractAfter, type Guard, type Head, type HeadAfter, type HomeDb, type Instant, type ReaderOutput } from "./index.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 0, 1);
const object: Guard = (content) => (typeof content === "object" && content !== null && !Array.isArray(content) ? [] : ["not an object"]);
const GUARDS = { msg: object };

const dir = mkdtempSync(join(tmpdir(), "core-spans-"));
const found: Record<string, unknown> = {};
afterAll(() => {
  writeFileSync(join(tmpdir(), "core-spans.json"), `${JSON.stringify(found, null, 2)}\n`);
  rmSync(dir, { recursive: true, force: true });
});

let files = 0;
const fresh = (): string => join(mkdtempSync(join(dir, `home-${files++}-`)), "home.db");
function raw<T>(path: string, work: (db: Database.Database) => T): T {
  const db = new Database(path);
  try {
    return work(db);
  } finally {
    db.close();
  }
}

type Range = { start_ms?: number; end_ms?: number };
type Spec = { key: string; start_ms?: number; length?: number } | { key: string; gone: true };

let stated = T0;
function land(db: HomeDb, source: string, specs: Spec[]): void {
  stated += 1_000;
  db.commit((tx) => {
    const run = tx.tables.runs.start({ kind: "import", subject: source, started_ms: stated });
    const rows: ReaderOutput[] = specs.map((spec) => {
      if ("gone" in spec) return { kind: "msg", key: spec.key, content: null, gone: true };
      const content = { synthetic: spec.key, length: spec.length ?? null };
      if (spec.start_ms === undefined) return { kind: "msg", key: spec.key, content };
      const time: Instant = { start_ms: spec.start_ms, precision: "ms", ...(spec.length === undefined ? {} : { end_ms: spec.start_ms + spec.length }) };
      return { kind: "msg", key: spec.key, content, time };
    });
    tx.records.land(run, { id: `${source}@${stated}`, source, stated_ms: stated }, rows, GUARDS, { has: () => true });
    tx.tables.runs.end(run, { ended_ms: stated, outcome: "ok" });
  });
}

function read<T>(db: HomeDb, work: (view: ReturnType<HomeDb["view"]>) => T): T {
  const view = db.view();
  try {
    return work(view);
  } finally {
    view.close();
  }
}

const ids = (heads: Head[]) => heads.map((head) => head.key);
function oracle(db: HomeDb, source: string, range: Range): string[] {
  const start = range.start_ms ?? -Infinity;
  const end = range.end_ms ?? Infinity;
  const all = read(db, (view) => [...view.heads(source, "msg")]);
  return ids(all
    .filter((head) => head.start_ms !== null && head.start_ms < end && (head.start_ms >= start || (head.end_ms !== null && head.end_ms > start)))
    .sort((a, b) => a.start_ms! - b.start_ms! || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)));
}
const ranged = (db: HomeDb, source: string, range: Range, after?: HeadAfter) => read(db, (view) => [...view.heads(source, "msg", range, after)]);
const spansOf = (path: string, source: string) => raw(path, (sql) => sql.prepare("SELECT day_ms FROM spans WHERE source = ? AND kind = 'msg'").get(source) as { day_ms: number });

const RANGES: Range[] = [
  ...Array.from({ length: 40 }, (_, day) => ({ start_ms: T0 + (day - 10) * DAY, end_ms: T0 + (day - 9) * DAY })),
  { start_ms: T0 + 2 * DAY + 7 * HOUR, end_ms: T0 + 9 * DAY },
  { start_ms: T0 + 12 * DAY },
  { end_ms: T0 + 3 * DAY },
  {},
  { start_ms: T0 - 400 * DAY, end_ms: T0 - 399 * DAY },
];

function agrees(db: HomeDb, source: string): { ranges: number; heads: number; resumes: number } {
  let heads = 0;
  let resumes = 0;
  for (const range of RANGES) {
    const want = oracle(db, source, range);
    const got = ranged(db, source, range);
    expect(ids(got), JSON.stringify(range)).toEqual(want);
    heads += got.length;
    for (let at = 0; at < got.length; at += 97) {
      const after: HeadAfter = { key: got[at]!.key, start_ms: got[at]!.start_ms };
      expect(ids(ranged(db, source, range, after)), `${JSON.stringify(range)} after ${at}`).toEqual(want.slice(at + 1));
      resumes++;
    }
  }
  return { ranges: RANGES.length, heads, resumes };
}

describe("a range read of heads", () => {
  it("misses, repeats or misorders a head of any span, whole or resumed, before and after heads move", () => {
    const path = fresh();
    const db = openHome(openHomeFolder(dirname(path)), "migrate");
    const source = "chat:spans";
    try {
      const specs: Spec[] = [];
      for (let n = 0; n < 600; n++) specs.push({ key: `tie-${String(n).padStart(4, "0")}`, start_ms: T0 + 5 * DAY });
      for (let n = 0; n < 20 * 72; n++) {
        specs.push({ key: `short-${String(n).padStart(5, "0")}`, start_ms: T0 + n * 20 * MINUTE, ...(n % 3 === 0 ? {} : { length: (n % 9) * 20 * MINUTE }) });
      }
      specs.push(
        { key: "day-exact", start_ms: T0 + 3 * DAY + HOUR, length: DAY },
        { key: "long-21d", start_ms: T0 - 7 * DAY, length: 21 * DAY },
        { key: "long-just", start_ms: T0 + 8 * DAY, length: DAY + 1 },
        { key: "long-inside", start_ms: T0 + 5 * DAY + 3 * HOUR, length: 4 * DAY },
        { key: "tie-long", start_ms: T0 + 5 * DAY, length: 9 * DAY },
        { key: "grows", start_ms: T0 + 2 * DAY, length: HOUR },
        { key: "moves", start_ms: T0 + 6 * DAY, length: 2 * HOUR },
        { key: "shrinks", start_ms: T0 - 30 * DAY, length: 60 * DAY },
        { key: "goes", start_ms: T0 + 4 * DAY, length: 10 * DAY },
        { key: "timeless" },
      );
      land(db, source, specs);
      expect(spansOf(path, source)).toEqual({ day_ms: DAY });
      const before = agrees(db, source);

      land(db, source, [
        { key: "grows", start_ms: T0 + 2 * DAY, length: 12 * DAY },
        { key: "moves", start_ms: T0 + 6 * DAY, length: 3 * DAY + HOUR },
        { key: "shrinks", start_ms: T0 - 30 * DAY, length: HOUR },
        { key: "goes", gone: true },
        { key: "long-early", start_ms: T0 - 300 * DAY, length: 330 * DAY },
      ]);
      expect(spansOf(path, source)).toEqual({ day_ms: DAY });
      const after = agrees(db, source);
      const day = (n: number) => ids(ranged(db, source, { start_ms: T0 + n * DAY, end_ms: T0 + (n + 1) * DAY }));
      expect(day(13)).toEqual(expect.arrayContaining(["grows", "long-early", "tie-long"]));
      expect(day(8)).toContain("moves");
      expect(day(8)).not.toContain("goes");
      expect(ids(ranged(db, source, { start_ms: T0 - 20 * DAY, end_ms: T0 - 19 * DAY }))).not.toContain("shrinks");
      found.correctness = { before, after, spans: spansOf(path, source), day_13: day(13).filter((key) => !key.startsWith("short-")) };
    } finally {
      db.close();
    }
  });

  it("a one-day read among three days of short heads and one of three days steps more than about a day of rows", () => {
    const path = fresh();
    const db = openHome(openHomeFolder(dirname(path)), "migrate");
    const source = "chat:cost";
    const EVERY = 30_000;
    const SHORT = (3 * DAY) / EVERY;
    try {
      for (let at = 0; at < SHORT; at += DAY / EVERY) {
        land(db, source, Array.from({ length: DAY / EVERY }, (_, n) => ({ key: `m${String(at + n).padStart(6, "0")}`, start_ms: T0 + (at + n) * EVERY, length: (n % 10) * MINUTE })));
      }
      land(db, source, [{ key: "tab-left-open", start_ms: T0 + HOUR, length: 3 * DAY }]);
      const range = { start_ms: T0 + 2 * DAY, end_ms: T0 + 3 * DAY };
      const { result: heads, ran } = recorded(() => ranged(db, source, range));
      expect(ids(heads)).toEqual(oracle(db, source, range));
      expect(ids(heads)).toContain("tab-left-open");

      const plans = raw(path, (sql) => ran.map(({ source: text, args }) => (sql.prepare(`EXPLAIN QUERY PLAN ${text}`).all(...args) as { detail: string }[]).map((row) => row.detail)));
      for (const plan of plans) {
        expect(plan.filter((detail) => /^SCAN |TEMP B-TREE/u.test(detail))).toEqual([]);
      }
      const merged = plans.find((plan) => plan.includes("MERGE (UNION ALL)"))!;
      expect(merged.some((detail) => /^SEARCH heads USING INDEX heads_time \(source=\? AND kind=\? AND \(start_ms,key\)>\(\?,\?\) AND start_ms<\?\)/u.test(detail)), merged.join("; ")).toBe(true);
      expect(merged.some((detail) => /^SEARCH heads USING INDEX heads_long \(source=\? AND kind=\?/u.test(detail))).toBe(true);

      const spans = spansOf(path, source);
      const stepped = steppedBy(path, ran);
      const dayOfRows = DAY / EVERY;
      expect(spans).toEqual({ day_ms: 9 * MINUTE });
      expect(stepped).toBeGreaterThanOrEqual(heads.length);
      expect(stepped).toBeLessThan(dayOfRows * 1.02);
      found.cost = { heads: SHORT + 1, read: heads.length, statements: ran.length, stepped, day_of_rows: dayOfRows, spans, plans: merged };
    } finally {
      db.close();
    }
  });

  it("a page inside a run of equal starts steps the run again from its first head", () => {
    const path = fresh();
    const db = openHome(openHomeFolder(dirname(path)), "migrate");
    const source = "chat:ties";
    try {
      land(db, source, Array.from({ length: 600 }, (_, n) => ({ key: `tie-${String(n).padStart(4, "0")}`, start_ms: T0 + 5 * DAY })));
      const range = { start_ms: T0 + 4 * DAY, end_ms: T0 + 6 * DAY };
      const { result: heads, ran } = recorded(() => ranged(db, source, range));
      expect(ids(heads)).toEqual(oracle(db, source, range));
      expect(ran.length).toBeGreaterThan(1);
      const stepped = steppedBy(path, ran);
      expect(stepped).toBeLessThan(heads.length + 50);
      found.ties = { heads: heads.length, statements: ran.length, stepped };
    } finally {
      db.close();
    }
  });

  it("a page that ended on a long head starting years before the range steps the short heads between it and the range", () => {
    const path = fresh();
    const db = openHome(openHomeFolder(dirname(path)), "migrate");
    const source = "chat:pair";
    try {
      land(db, source, [
        ...Array.from({ length: 520 }, (_, n): Spec => ({ key: `long-${String(n).padStart(4, "0")}`, start_ms: T0 - 3 * 365 * DAY + n * MINUTE, length: 3 * 365 * DAY + 2 * DAY })),
        ...Array.from({ length: 2_000 }, (_, n): Spec => ({ key: `before-${String(n).padStart(5, "0")}`, start_ms: T0 - 2 * 365 * DAY + n * HOUR })),
        ...Array.from({ length: 100 }, (_, n): Spec => ({ key: `inside-${String(n).padStart(4, "0")}`, start_ms: T0 + DAY + n * MINUTE })),
      ]);
      const range = { start_ms: T0 + DAY, end_ms: T0 + 2 * DAY };
      const { result: heads, ran } = recorded(() => ranged(db, source, range));
      expect(ids(heads)).toEqual(oracle(db, source, range));
      expect(heads.length).toBe(620);
      const stepped = steppedBy(path, ran);
      expect(stepped).toBeLessThan(heads.length + 50);
      found.pair = { heads: heads.length, statements: ran.length, stepped };
    } finally {
      db.close();
    }
  });
});

describe("a range page of a family's extracts", () => {
  it("steps the range from its start again on every page, or returns a row before the range from a wider read's cursor", () => {
    const path = fresh();
    const db = openHome(openHomeFolder(dirname(path)), "migrate");
    const family = "messages";
    try {
      db.commit((tx) => {
        for (let n = 0; n < 1_000; n++) {
          tx.derived.extracts.put({
            family, unit: `u${String(n).padStart(4, "0")}`, reading: "r", code: "c", content: { n }, start_ms: T0 + n * MINUTE, end_ms: T0 + n * MINUTE + 1,
            days: [], items: [], seq: 1,
          });
        }
      });
      const select = { start_ms: T0 + 200 * MINUTE, end_ms: T0 + 800 * MINUTE };
      const pages = (from: ExtractAfter | null) => read(db, (view) => {
        const rows: string[] = [];
        for (let after = from; ;) {
          const page = view.extractPage(family, select, after, 50);
          rows.push(...page.map((row) => row.unit));
          if (page.length < 50) return rows;
          after = page.at(-1)!;
        }
      });
      const want = Array.from({ length: 600 }, (_, n) => `u${String(n + 200).padStart(4, "0")}`);
      const { result: rows, ran } = recorded(() => pages(null), /\bextracts\b/u);
      expect(rows).toEqual(want);
      const stepped = steppedBy(path, ran);
      expect(stepped).toBeLessThan(rows.length + 2 * ran.length);
      expect(pages({ unit: "u0100", start_ms: T0 + 100 * MINUTE })).toEqual(want);
      found.extracts = { rows: rows.length, pages: ran.length, stepped };
    } finally {
      db.close();
    }
  });
});

function steppedBy(path: string, ran: { source: string; args: unknown[] }[]): number {
  return raw(path, (sql) => {
    let count = 0;
    sql.function("stepped", { deterministic: false }, () => {
      count++;
      return 1;
    });
    for (const { source: text, args } of ran) sql.prepare(text.replace(/\bWHERE\b/gu, "WHERE stepped() AND")).all(...args);
    return count;
  });
}

function recorded<T>(work: () => T, table = /\bheads\b/u): { result: T; ran: { source: string; args: unknown[] }[] } {
  const probe = new Database(":memory:");
  const statement = Object.getPrototypeOf(probe.prepare("SELECT 1")) as Record<string, (...args: unknown[]) => unknown>;
  probe.close();
  const originals = Object.fromEntries((["run", "get", "all", "iterate"] as const).map((name) => [name, statement[name]!]));
  const ran: { source: string; args: unknown[] }[] = [];
  for (const [name, original] of Object.entries(originals)) {
    statement[name] = function (this: Database.Statement, ...args: unknown[]) {
      if (table.test(this.source)) ran.push({ source: this.source, args });
      return original.apply(this, args);
    };
  }
  try {
    return { result: work(), ran };
  } finally {
    Object.assign(statement, originals);
  }
}
