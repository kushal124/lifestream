import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dayBounds, DAYS_MARK, openHome, openHomeFolder, type DaySettings } from "@lifestreamprotocol/core";
import type { DayFileFact } from "@lifestreamprotocol/families";
import { CALLS_COLLECTIONS, healthFamily, MESSAGES_COLLECTIONS, MONEY_COLLECTIONS, type Family } from "@lifestreamprotocol/families";
import { HomeFile } from "./home-file.js";
import { HOME_FILE, HOME_FORMAT } from "./lifecycle.js";
import { openReads, type Reply } from "./reads.js";
import { Refusal } from "./refusal.js";
import type { Registry } from "./registry.js";
import type { Settings } from "./settings.js";
import type { Fresh, HeldDays } from "./index-file.js";
import { SearchIndex, searchFileOf } from "./search-index.js";
import type { CountContext, PeopleMap } from "./counting.js";
import { makeRef, personRef, readRef, REF_CHARS } from "./refs.js";
import { answerOf, countAnswer, type CountParams } from "./search-contract.js";
import { countAskedOf, countAskOf, countShown, openRowIn, rowAskedOf, countAttached, VALUE_KEPT } from "./count.js";
import { countAsked, rowOf, countOf, shown } from "./test/record-reads.js";
import { sealed } from "./cursor-text.js";


const SETTINGS: DaySettings = { zone: "UTC", day_start_hour: 0 };
const D = (day: string, time = "00:00") => Date.parse(`${day}T${time}:00Z`);
const MIN = 60_000;
const dir = mkdtempSync(join(tmpdir(), "lifestream-count-"));
let index: SearchIndex;

const ADA = ["+15550000001", "15550000001@s.whatsapp.net", "ada@example.com"];
const RAJ = ["+15550000002"];
const PEOPLE: PeopleMap = {
  version: "people-1",
  idOf: (id) => (id === "person:ada" || ADA.includes(id) ? "person:ada" : id === "person:raj" || RAJ.includes(id) ? "person:raj" : undefined),
  person: (id) => (id === "person:ada" ? { name: "Ada Example", handles: ADA } : id === "person:raj" ? { name: "Raj Example", handles: RAJ } : undefined),
  find: (name) => ["person:ada", "person:raj"].filter((id) => (id === "person:ada" ? "Ada Example" : "Raj Example").toLowerCase().includes(name.toLowerCase())),
};
const COLLECTIONS = new Map(Object.entries({ ...CALLS_COLLECTIONS, ...MONEY_COLLECTIONS, ...healthFamily([]).collections }));
const context = (over: Partial<CountContext> = {}): CountContext => ({ collections: COLLECTIONS, settings: SETTINGS, now_ms: D("2026-10-10", "12:00"), people: () => PEOPLE, ...over });

const call = (key: string, start: number, minutes: number | null, who: string[], keys: Record<string, string> = {}): DayFileFact => ({
  id: `calls:${key.padStart(24, "0")}`, family: "calls", of: "calls", time_ms: start, start_ms: start, end_ms: start + (minutes ?? 0) * MIN,
  keys: { service: "whatsapp", direction: "outgoing", outcome: "connected", ...keys }, measures: minutes === null ? {} : { minutes },
  who: who.map((handle) => ({ handle, role: "receiver" as const })), from: { units: [`calls/${key}`], record: { source: "wa:local:a", kind: "call", key }, alone: true }, lines: [],
});
const payment = (key: string, day: string, payee: string, amount: string, currency: string, line = 1): DayFileFact => ({
  id: `payments:${key.padStart(24, "0")}`, family: "money", of: "payments", time_ms: D(day), start_ms: D(day), end_ms: D(day), date_only: true,
  keys: { payee, direction: "debit", currency }, measures: { amount }, who: [], from: { units: [`money/${key}`], record: { source: "bank:acct:a", kind: "payment", key }, alone: true }, lines: [line],
});
const health = (day: string, instrument: string, measures: Record<string, number>): DayFileFact => ({
  id: `days:${`${day}${instrument}`.replace(/\W/gu, "").padStart(24, "0").slice(-24)}`, family: "health", of: "days", time_ms: D(day), start_ms: D(day), end_ms: D(day), date_only: true,
  keys: { instrument }, measures, who: [], from: { units: [`health/${day}`], instrument }, lines: [],
});

const DAYS: Record<string, DayFileFact[]> = {
  "2026-10-01": [
    call("c1", D("2026-10-01", "09:00"), 10, [ADA[0]!, ADA[1]!]),
    call("c2", D("2026-10-01", "10:00"), 5, [ADA[2]!]),
    call("c3", D("2026-10-01", "11:00"), 30, [ADA[0]!, RAJ[0]!], { group: "family" }),
    { ...call("c4", D("2026-10-01", "23:40"), 60, [RAJ[0]!]), end_ms: D("2026-10-02", "00:40") },
    call("c5", D("2026-10-01", "12:00"), null, ["+15550000099"], { outcome: "missed" }),
    payment("p1", "2026-10-01", "ACME CABS LIMITED", "50.00", "EUR", 1),
    payment("p2", "2026-10-01", "Acme Cabs", "12.50", "EUR", 2),
    payment("p3", "2026-10-01", "SYNTHETIC GROCER", "1999.00", "INR", 3),
    health("2026-10-01", "Watch", { asleep_min: 420, in_bed_min: 470, steps: 9000 }),
    health("2026-10-01", "Ring", { asleep_min: 450, in_bed_min: 480 }),
    health("2026-10-01", "Phone", {}),
  ],
  "2026-10-02": [
    payment("p4", "2026-10-02", "ACME CABS LIMITED", "7.25", "EUR"),
  ],
  "2026-10-03": [payment("p5", "2026-10-03", "CORNER BAKERY", "3.10", "EUR")],
  "2026-10-04": [health("2026-10-04", "Watch", { asleep_min: 400, steps: 6000 })],
};


beforeAll(() => {
  index = SearchIndex.write(openHomeFolder(dirname(join(dir, "index.db"))), join(dir, "index.db"), () => true, 0, SETTINGS);
  index.records([
    { record: { source: "bank:acct:a", kind: "payment", key: "p1" }, family: "money", version: "v1", start_ms: D("2026-10-01"), end_ms: null, title: "", text: "UPI-ACME CABS LIMITED-ride to the airport", who: [], link: null },
    { record: { source: "bank:acct:a", kind: "payment", key: "p3" }, family: "money", version: "v1", start_ms: D("2026-10-01"), end_ms: null, title: "", text: "POS SYNTHETIC GROCER weekly groceries", who: [], link: null },
  ], [], { position: { seq: 1, statement: "s-1", reread: 0 } });
  for (const [day, facts] of Object.entries(DAYS)) {
    index.day(day, { inputs: `in-${day}`, mtime_us: 1, atoms: [], facts: { window: { start_ms: D(day), end_ms: D(day) + 86_400_000 }, facts } });
  }
});

afterAll(() => {
  index.close();
  rmSync(dir, { recursive: true, force: true });
});

const ask = (params: Record<string, string | string[]>) => countAsked(params, COLLECTIONS);
type Shown = {
  asked: string; matched: Record<string, unknown>; population: Record<string, unknown>; total: Record<string, unknown> | Record<string, unknown>[];
  columns: string[]; rows: unknown[][]; next: string | null;
};
const run = (params: Record<string, string | string[]>, over: Partial<CountContext> = {}) => shown(countOf(index, ask(params), context(over))) as Shown;
const openedIn = (of: SearchIndex, ref: unknown, over: Partial<CountContext> = {}) => shown(rowOf(of, String(ref), context(over))) as Shown;
const opening = (ref: unknown, over: Partial<CountContext> = {}) => openedIn(index, ref, over);
const recordKey = (ref: unknown) => readRef(String(ref), "ref", ["record"]).parts.key;
const refusal = (work: () => unknown): Refusal => {
  try {
    work();
  } catch (error) {
    if (error instanceof Refusal) return error;
    throw error;
  }
  throw new Error("not refused");
};

describe("the population", () => {
  it("P7 a count over days still being read answers what the index holds and names them, as the freshness asked after its read says", () => {
    const asked: [string, string][] = [];
    const fresh = (_seq: number, held: HeldDays): Fresh => {
      asked.push([held.from, held.to]);
      return { as_of: "2026-10-10T11:00+00:00", pending: [{ day: "2026-10-02", why: "new" }, { day: "2026-10-01", why: "failed" }] };
    };
    const answer = run({ of: "calls", from: "2026-10-01", to: "2026-10-04" }, { fresh }) as unknown as Record<string, unknown>;
    expect(answer.total).toMatchObject({ n: 5 });
    expect(answer).toMatchObject({ as_of: "2026-10-10T11:00+00:00", pending: [{ day: "2026-10-02", why: "new" }, { day: "2026-10-01", why: "failed" }] });
    expect(asked).toEqual([["2026-10-01", "2026-10-04"]]);
    expect(run({ of: "calls" }, { fresh: () => ({ as_of: null, pending: [] }) })).not.toHaveProperty("pending");
  });

  it("P1 people are resolved first: two handles of one person once, three handles one row, a group call once in the total and under each", () => {
    const byPerson = run({ of: "calls", by: "person" });
    expect(byPerson.columns).toEqual(["person", "n", "ref"]);
    expect(byPerson.rows.map((row) => row.slice(0, 2))).toEqual([["Ada Example", 3], ["Raj Example", 2], ["+15550000099", 1]]);
    expect(byPerson.total).toMatchObject({ n: 5 });
    const hers = run({ of: "calls", person: ADA[0]! });
    expect(hers.total).toMatchObject({ n: 3 });
    expect(hers.matched).toMatchObject({ person: { [ADA[0]!]: "Ada Example" } });
    expect(run({ of: "calls", person: "ada" }).total).toMatchObject({ n: 3 });
    expect(run({ of: "calls", by: "group" }).rows.map((row) => row.slice(0, 2))).toEqual([[null, 4], ["family", 1]]);
  });

  it("P2 a 60-minute call across midnight is one call of 60 for avg", () => {
    const avg = run({ of: "calls", measure: "minutes", op: "avg", person: RAJ[0]! });
    expect(avg.total).toMatchObject({ n: 2, avg: 45 });
    const day2 = run({ of: "calls", measure: "minutes", op: "avg", from: "2026-10-02", to: "2026-10-02" });
    expect(day2.total).toMatchObject({ n: 0 });
    const all = run({ of: "calls", measure: "minutes", op: "avg" });
    expect(all.total).toMatchObject({ n: 4, avg: (10 + 5 + 30 + 60) / 4 });
    expect(all.population).toMatchObject({ facts: 5, valued: 4, missing: 1 });
  });

  it("P3 a day with no health line is missing, never zero and never absent", () => {
    const steps = run({ of: "days", measure: "steps", by: "day", from: "2026-10-01", to: "2026-10-04" });
    expect(steps.rows.map((row) => row.slice(0, 4))).toEqual([["2026-10-01", 1, 9000, 0], ["2026-10-02", 1, null, 1], ["2026-10-03", 1, null, 1], ["2026-10-04", 1, 6000, 0]]);
    expect(steps.total).toMatchObject({ n: 4, sum: 15000 });
    expect(steps.population).toMatchObject({ facts: 4, valued: 2, missing: 2, missing_days: "2026-10-02 → 2026-10-03" });
    expect(run({ of: "days", from: "2026-10-01", to: "2026-10-04" }).total).toMatchObject({ n: 4 });
  });

  it("P5 two currencies are two totals, summed as decimals", () => {
    const spend = run({ of: "payments", measure: "amount" });
    expect(spend.total).toEqual([
      expect.objectContaining({ of: "EUR", n: 4, sum: "72.85 EUR" }),
      expect.objectContaining({ of: "INR", n: 1, sum: "1999.00 INR" }),
    ]);
    const byMonth = run({ of: "payments", measure: "amount", by: "month" });
    expect(byMonth.columns).toEqual(["month", "currency", "n", "sum", "missing", "ref"]);
    expect(byMonth.rows.map((row) => row.slice(0, 4))).toEqual([["2026-10", "EUR", 4, "72.85"], ["2026-10", "INR", 1, "1999.00"]]);
  });

  it("P6 a score refuses sum, naming the ops it takes; an unknown key names the keys; place is read, a place key matched only where the collection states it", () => {
    expect(refusal(() => ask({ of: "days", measure: "recovery", op: "sum" })).message).toContain("recovery does not add up: use avg, min, max, first, last");
    expect(refusal(() => ask({ of: "payments", by: "sport" })).message).toContain("payments has no key sport; its keys: payee, account, direction, channel, currency");
    expect(ask({ of: "payments", place: "Lisbon" }).place).toBe("Lisbon");
    expect(ask({ of: "payments", by: "country" }).by).toEqual(["country"]);
    expect(refusal(() => ask({ of: "payments", "match.country": "Portugal" })).message).toContain("ask where the person was with place=words");
    expect(refusal(() => ask({ of: "days", by: "hour" })).message).toContain("days have no hour");
    expect(refusal(() => ask({ of: "calls", by: ["run", "person"] })).message).toContain("by run stands alone");
    expect(ask({ of: "days", measure: "recovery" }).op).toBe("avg");
    expect(ask({ of: "payments", measure: "amount" }).op).toBe("sum");
  });

  it("P8 a cursor pages on; given with another query it is refused; People's map moving moves none", () => {
    const first = run({ of: "calls", by: "person", limit: "1" });
    expect(first.rows).toHaveLength(1);
    const second = run({ of: "calls", by: "person", limit: "1", cursor: first.next! });
    expect(second.rows[0]![0]).toBe("Raj Example");
    expect(refusal(() => run({ of: "calls", by: "day", limit: "1", cursor: first.next! })).code).toBe("BAD_PARAMETER");
    expect(run({ of: "calls", by: "person", limit: "1", cursor: first.next! }, { people: () => ({ ...PEOPLE, version: "people-2" }) }).rows[0]![0]).toBe("Raj Example");
  });

  it("P9 match takes every spelling, named with its count; an exclusion drops; words reach a fact through its record", () => {
    const acme = run({ of: "payments", measure: "amount", "match.payee": "acme" });
    expect(acme.matched).toMatchObject({ payee: { acme: ["ACME CABS LIMITED (2)", "Acme Cabs (1)"] } });
    expect(acme.total).toEqual([expect.objectContaining({ of: "EUR", n: 3, sum: "69.75 EUR" })]);
    expect(run({ of: "payments", "match.payee": "acme -limited" }).total).toMatchObject({ n: 1 });
    expect(run({ of: "payments", "match.payee": "acme OR bakery" }).total).toMatchObject({ n: 4 });
    expect(run({ of: "payments", "match.payee": "acmecabs" }).total).toMatchObject({ n: 3 });
    expect(run({ of: "payments", words: "groceries" }).total).toMatchObject({ n: 1 });
    expect(run({ of: "payments", words: "-airport" }).total).toMatchObject({ n: 4 });
  });

  it("P10 the calendar grouped by time keys: weekday names, week by its Monday", () => {
    const weeks = run({ of: "calls", by: "week" });
    expect(weeks.rows.map((row) => row.slice(0, 2))).toEqual([["2026-09-28", 5]]);
    const days = run({ of: "calls", by: ["weekday", "outcome"] });
    expect(days.rows.map((row) => row.slice(0, 3))).toEqual([["Thursday", "connected", 4], ["Thursday", "missed", 1]]);
  });
});

describe("the population, one reader (fix round 1, part B)", () => {
  it("F7 two instruments' nights are averaged apart, each named; by=instrument keeps each one's own reading in the total", () => {
    const asleep = run({ of: "days", measure: "asleep_min", op: "avg", by: "instrument", from: "2026-10-01", to: "2026-10-04" });
    expect(asleep.columns).toEqual(["instrument", "n", "avg", "missing", "min", "min_day", "max", "max_day", "in_bed_min", "ref"]);
    expect(asleep.rows.map((row) => row.slice(0, 3))).toEqual([["Ring", 1, 450], ["Watch", 2, 410]]);
    expect(asleep.total).toEqual([expect.objectContaining({ of: "Ring", n: 1, avg: 450 }), expect.objectContaining({ of: "Watch", n: 2, avg: 410 })]);
    expect(run({ of: "days", measure: "asleep_min", op: "avg", from: "2026-10-01", to: "2026-10-04" }).asked).toContain("each instrument apart");
  });

  it("F8 a cursor is bound to its whole query, a nested match too", () => {
    const first = run({ of: "payments", "match.payee": "acme", by: "day", limit: "1" });
    expect(first.next).not.toBeNull();
    expect(refusal(() => run({ of: "payments", "match.payee": "bakery", by: "day", limit: "1", cursor: first.next! })).code).toBe("BAD_PARAMETER");
    expect(run({ of: "payments", "match.payee": "acme", by: "day", limit: "1", cursor: first.next! }).rows).toHaveLength(1);
  });

  it("F9 a grouped sum keeps the facts that state no value, each row stating its missing", () => {
    const byOutcome = run({ of: "calls", measure: "minutes", op: "sum", by: "outcome" });
    expect(byOutcome.rows.map((row) => row.slice(0, 4))).toEqual([["connected", 4, 105, 0], ["missed", 1, null, 1]]);
    const byPerson = run({ of: "calls", measure: "minutes", op: "sum", by: "person" });
    expect(byPerson.rows.find((row) => row[0] === "+15550000099")!.slice(0, 4)).toEqual(["+15550000099", 1, null, 1]);
  });

  it("F10 the calendar ends today; a range with no instrument stating the measure is one partition of missing days", () => {
    expect(run({ of: "days", from: "2026-10-01", to: "2026-12-31" }).total).toMatchObject({ n: 10 });
    expect(run({ of: "days", from: "2026-10-01", to: "9999-12-31" }).total).toMatchObject({ n: 10 });
    const none = run({ of: "days", measure: "asleep_min", op: "avg", from: "2026-10-02", to: "2026-10-03" });
    expect(none.population).toMatchObject({ by: [expect.objectContaining({ facts: 2, valued: 0, missing: 2, missing_days: "2026-10-02 → 2026-10-03" })] });
  });

  it("F15 a row's ref holds who by their handles, never a name, a handle People does not know as itself", () => {
    const byPerson = run({ of: "calls", by: "person" });
    const keys = (row: unknown[]) => { const { scope } = readRef(String(row.at(-1)), "ref", ["row"]).parts; return "g" in scope ? scope.g : undefined; };
    expect(keys(byPerson.rows[0]!)).toEqual([ADA]);
    expect(keys(byPerson.rows[2]!)).toEqual([["+15550000099"]]);
  });

  it("F2 a clock sum of a later day owes the day a fact crossing into it began", () => {
    const own = mkdtempSync(join(tmpdir(), "lifestream-count-crossing-"));
    const crossing = SearchIndex.write(openHomeFolder(dirname(join(own, "index.db"))), join(own, "index.db"), () => true, 0, SETTINGS);
    try {
      crossing.records([], [], { position: { seq: 1, statement: "s-1", reread: 0 } });
      const c4 = DAYS["2026-10-01"]!.find((fact) => fact.id.endsWith("c4"))!;
      crossing.day("2026-10-01", { inputs: "in-1", mtime_us: 1, atoms: [], facts: { window: { start_ms: D("2026-10-01"), end_ms: D("2026-10-02") }, facts: [c4] } });
      crossing.day("2026-10-02", { inputs: "in-2", mtime_us: 1, atoms: [], facts: { window: { start_ms: D("2026-10-02"), end_ms: D("2026-10-03") }, facts: [] } });
      const range = (params: Record<string, string>) => {
        let asked: [string, string] | undefined;
        countOf(crossing, ask(params), context({ fresh: (_seq, held) => ((asked = [held.from, held.to]), { as_of: null, pending: [] }) }));
        return asked!;
      };
      expect(range({ of: "calls", measure: "minutes", op: "sum", from: "2026-10-02", to: "2026-10-02" })[0] <= "2026-10-01").toBe(true);
      expect(range({ of: "calls", from: "2026-10-02", to: "2026-10-02" })).toEqual(["2026-10-02", "2026-10-02"]);
    } finally {
      crossing.close();
      rmSync(own, { recursive: true, force: true });
    }
  });

  it("F12 a date-only payment and a call across the day's start, in a zone behind UTC with the day starting at 04:00", () => {
    const zone: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
    const own = mkdtempSync(join(tmpdir(), "lifestream-count-zone-"));
    const zoned = SearchIndex.write(openHomeFolder(dirname(join(own, "index.db"))), join(own, "index.db"), () => true, 0, SETTINGS);
    const start = Date.parse("2026-10-02T07:40:00Z"), end = Date.parse("2026-10-02T08:40:00Z");
    const late = { ...call("z1", start, 60, [RAJ[0]!]), end_ms: end };
    const files: Record<string, DayFileFact[]> = {
      "2026-10-01": [payment("z2", "2026-10-01", "CORNER BAKERY", "4.00", "USD"), late],
      "2026-10-02": [],
    };
    try {
      zoned.records([], [], { position: { seq: 1, statement: "s-1", reread: 0 } });
      const readDay = (day: string) => zoned.day(day, { inputs: `in-${day}`, mtime_us: 1, atoms: [], facts: { window: dayBounds(day, zone), facts: files[day]! } });
      readDay("2026-10-01");
      const at = context({ settings: zone, now_ms: Date.parse("2026-10-05T12:00:00Z") });
      const zonedRun = (params: Record<string, string>) => shown(countOf(zoned, ask(params), at)) as { total: unknown; rows: unknown[][] };
      expect(zonedRun({ of: "calls", from: "2026-10-01", to: "2026-10-01" }).total).toMatchObject({ n: 1 });
      readDay("2026-10-02");
      expect(zonedRun({ of: "payments", from: "2026-10-01", to: "2026-10-01" }).total).toMatchObject({ n: 1 });
      expect(zonedRun({ of: "payments", from: "2026-10-02", to: "2026-10-02" }).total).toMatchObject({ n: 0 });
      expect(zonedRun({ of: "calls", measure: "minutes", op: "sum", by: "day" }).rows.map((row) => row.slice(0, 3))).toEqual([["2026-10-01", 1, 20], ["2026-10-02", 1, 40]]);
      expect(zonedRun({ of: "calls", measure: "minutes", op: "avg", from: "2026-10-01", to: "2026-10-01" }).total).toMatchObject({ n: 1, avg: 60 });
    } finally {
      zoned.close();
      rmSync(own, { recursive: true, force: true });
    }
  });
});

function factReads(work: () => unknown): { sql: string; args: unknown[] }[] {
  const probe = new Database(":memory:");
  const statement = Object.getPrototypeOf(probe.prepare("SELECT 1")) as Record<string, (...args: unknown[]) => unknown>;
  probe.close();
  const originals = Object.fromEntries((["get", "all", "iterate"] as const).map((name) => [name, statement[name]!]));
  const reads: { sql: string; args: unknown[] }[] = [];
  for (const [name, original] of Object.entries(originals)) {
    statement[name] = function (this: Database.Statement, ...args: unknown[]) {
      if (/\bFROM fact\b/u.test(this.source) && !/^EXPLAIN\b/u.test(this.source)) reads.push({ sql: this.source, args });
      return original.apply(this, args);
    };
  }
  try {
    work();
  } finally {
    Object.assign(statement, originals);
  }
  return reads;
}

describe("reading the range alone", () => {
  it("P15 a count over a range walks that range of the facts alone, every statement a walk or a lookup (the meter checks each); one the tallies answer reads no fact", () => {
    const engine = [
      { of: "calls", from: "2026-10-01", to: "2026-10-01", by: "item" },
      { of: "calls", from: "2026-10-01", to: "2026-10-01", measure: "minutes", op: "avg", by: "week" },
      { of: "payments", from: "2026-10-02", to: "2026-10-03", measure: "amount", op: "sum", by: "month" },
    ];
    const fromTallies = [
      { of: "calls", from: "2026-10-01", to: "2026-10-01", by: "week" },
      { of: "payments", from: "2026-10-02", to: "2026-10-03", by: "month" },
      { of: "calls", from: "2026-10-01", to: "2026-10-01", by: "person" },
    ];
    for (const params of [...engine, ...fromTallies]) {
      const reads = factReads(() => run(params));
      const walks = reads.filter(({ sql }) => /\bWHERE of = \? AND time_ms >= \? AND time_ms <= \?/u.test(sql)).map(({ args }) => args as [string, number, number]);
      const inRange = walks.filter(([, from, to]) => from >= D(params.from) - 86_400_000 && to <= D(params.to) + 2 * 86_400_000);
      expect(inRange.length > 0, JSON.stringify(params)).toBe(engine.includes(params));
      if (!engine.includes(params)) expect(reads, JSON.stringify(params)).toEqual([]);
    }
  });
});

describe("the route", () => {
  it("R1 /v1/count answers a sum by currency from the index the door reads, names the days home.db has not handed it, and refuses while none is published", () => {
    const root = join(dir, "home");
    const machine = join(dir, "machine");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, HOME_FILE), JSON.stringify({ format: HOME_FORMAT, id: "home-test", created: "2026-10-01T00:00:00Z" }));
    const home = openHome(openHomeFolder(root), "migrate");
    home.commit((tx) => {
      tx.derived.days.put("2026-10-01", "in-2026-10-01", { total: 2, per_family: { money: 2 } });
      tx.derived.days.put("2026-10-02", "in-2026-10-02-newer", { total: 1, per_family: { money: 1 } });
      tx.tables.meta.set(DAYS_MARK, "test");
    });
    home.close();
    const families = [{ name: "calls", collections: CALLS_COLLECTIONS }, { name: "money", collections: MONEY_COLLECTIONS }, healthFamily([])] as unknown as Family[];
    const reads = openReads({
      folder: openHomeFolder(root), home: new HomeFile(openHomeFolder(root)), blobs: undefined as never, settings: () => ({ day: SETTINGS }) as Settings,
      registry: { connectors: [], readers: [], families } as unknown as Registry,
    });
    const asked = (url: string) => {
      const reply = reads.reply("/v1/count")!({ url, now_ms: D("2026-10-10", "12:00"), held: { machine } as never }) as Reply;
      const body = JSON.parse(String(reply.body)) as Record<string, unknown>;
      answerOf("/v1/count", 200, body);
      return body;
    };
    expect(refusal(() => asked("/v1/count?of=payments")).code).toBe("INDEX_BUILDING");
    const file = searchFileOf(root, machine);
    const built = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, SETTINGS);
    built.records([], [], { position: { seq: 1, statement: "s-1", reread: 0 } });
    for (const day of ["2026-10-01", "2026-10-02"]) {
      built.day(day, { inputs: `in-${day}`, mtime_us: 1, atoms: [], facts: { window: { start_ms: D(day), end_ms: D(day) + 86_400_000 }, facts: DAYS[day]!.filter((fact) => fact.of === "payments") } });
    }
    built.finish();
    const answer = asked("/v1/count?of=payments&measure=amount&by=day&match.payee=acme");
    expect(answer).toMatchObject({
      asked: "sum of amount over payments, by day, each currency apart, never converted",
      total: { n: 3, sum: "69.75 EUR", ref: expect.stringMatching(/^row\./u) }, columns: ["day", "currency", "n", "sum", "missing", "ref"],
      rows: [["2026-10-01", "EUR", 2, "62.50", 0, expect.any(String)], ["2026-10-02", "EUR", 1, "7.25", 0, expect.any(String)]],
      pending: [{ day: "2026-10-02", why: "new" }],
    });
    expect(answer).not.toHaveProperty("as_of");
    expect((asked("/v1/count").collections as { of: string }[]).map((each) => each.of)).toEqual(["calls", "days", "payments", "workouts"]);
    const unlisted = openHome(openHomeFolder(root), "migrate");
    unlisted.commit((tx) => tx.tables.meta.delete(DAYS_MARK));
    unlisted.close();
    const busy = refusal(() => asked("/v1/count?of=payments&measure=amount&from=2026-10-01&to=2026-10-02"));
    expect({ status: busy.status, code: busy.code, retry: busy.retryAfter !== undefined }).toEqual({ status: 503, code: "NOT_NOW", retry: true });
  });
});

function ownIndex(files: Record<string, DayFileFact[]>): { index: SearchIndex; close: () => void } {
  const own = mkdtempSync(join(tmpdir(), "lifestream-count-own-"));
  const built = SearchIndex.write(openHomeFolder(dirname(join(own, "index.db"))), join(own, "index.db"), () => true, 0, SETTINGS);
  built.records([], [], { position: { seq: 1, statement: "s-1", reread: 0 } });
  for (const [day, facts] of Object.entries(files)) built.day(day, { inputs: `in-${day}`, mtime_us: 1, atoms: [], facts: { window: { start_ms: D(day), end_ms: D(day) + 86_400_000 }, facts } });
  return { index: built, close: () => { built.close(); rmSync(own, { recursive: true, force: true }); } };
}

describe("the rest of the answer (D3a)", () => {
  it("E1 max, min, first and last give their fact: its time, keys, people and handle; a missing value is never one", () => {
    const longest = run({ of: "calls", measure: "minutes", op: "max" });
    expect(longest.total).toMatchObject({ n: 4, max: 60, tied: 1, facts: [{ time: "2026-10-01T23:40+00:00", service: "whatsapp", outcome: "connected", person: "Raj Example", people: 1, ref: expect.any(String) }] });
    expect(run({ of: "calls", measure: "minutes", op: "min" }).total).toMatchObject({ min: 5, facts: [{ time: "2026-10-01T10:00+00:00", person: "Ada Example" }] });
    expect(run({ of: "calls", measure: "minutes", op: "first" }).total).toMatchObject({ first: 10, facts: [{ time: "2026-10-01T09:00+00:00" }] });
    expect(run({ of: "calls", measure: "minutes", op: "last" }).total).toMatchObject({ last: 60, facts: [{ time: "2026-10-01T23:40+00:00" }] });
    const byOutcome = run({ of: "calls", measure: "minutes", op: "max", by: "outcome" });
    expect(byOutcome.columns).toEqual(["outcome", "n", "max", "missing", "tied", "time", "service", "direction", "group", "chat", "person", "people", "ref"]);
    expect(byOutcome.rows.map((row) => row.slice(0, 6))).toEqual([["connected", 4, 60, 0, 1, "2026-10-01T23:40+00:00"], ["missed", 0, null, 1, 0, null]]);
    expect(refusal(() => ask({ of: "payments", measure: "balance", op: "sum" })).message).toContain("balance does not add up");
    expect(ask({ of: "payments", measure: "balance", op: "last" }).op).toBe("last");
  });

  it("E1 money's extremes are per currency; avg gives its count and the least and most with their days", () => {
    const least = run({ of: "payments", measure: "amount", op: "min" });
    expect(least.total).toEqual([
      expect.objectContaining({ of: "EUR", n: 4, min: "3.10 EUR", facts: [expect.objectContaining({ time: "2026-10-03", payee: "CORNER BAKERY" })] }),
      expect.objectContaining({ of: "INR", n: 1, min: "1999.00 INR" }),
    ]);
    const avg = run({ of: "calls", measure: "minutes", op: "avg" });
    expect(avg.total).toMatchObject({ n: 4, avg: 26.25, min: 5, min_day: "2026-10-01", max: 60, max_day: "2026-10-01" });
  });

  it("E1 a tie shows three facts and counts them all", () => {
    const tied = ownIndex({
      "2026-10-01": [1, 2, 3].map((n) => payment(`t${n}`, "2026-10-01", `SHOP ${n}`, "4.00", "EUR", n)),
      "2026-10-02": [payment("t4", "2026-10-02", "SHOP 4", "4.00", "EUR"), payment("t5", "2026-10-02", "SHOP 5", "4.00", "EUR", 2), payment("t6", "2026-10-02", "SHOP 6", "9.00", "EUR", 3)],
    });
    try {
      const least = shown(countOf(tied.index, ask({ of: "payments", measure: "amount", op: "min" }), context())) as { total: Record<string, unknown>[] };
      expect(least.total[0]).toMatchObject({ of: "EUR", min: "4.00 EUR", tied: 5 });
      expect((least.total[0]!.facts as unknown[]).length).toBe(3);
      const byDay = shown(countOf(tied.index, ask({ of: "payments", measure: "amount", op: "min", by: "day" }), context())) as { rows: unknown[][] };
      expect(byDay.rows.map((row) => [row[0], row[5]])).toEqual([["2026-10-01", 3], ["2026-10-01", 3], ["2026-10-01", 3], ["2026-10-02", 2], ["2026-10-02", 2]]);
    } finally {
      tied.close();
    }
  });

  it("E2 by item lists the facts with their keys and measures, paged by cursor, the total over every match unchanged", () => {
    const first = run({ of: "payments", measure: "amount", by: "item", limit: "2" });
    expect(first.columns).toEqual(["time", "payee", "account", "direction", "channel", "currency", "amount", "balance", "ref"]);
    expect(first.rows.map((row) => row.slice(0, 2))).toEqual([["2026-10-01", "ACME CABS LIMITED"], ["2026-10-01", "Acme Cabs"]]);
    expect(first.rows[0]!.slice(5, 7)).toEqual(["EUR", "50.00"]);
    const second = run({ cursor: first.next! });
    const again = run({ of: "payments", measure: "amount", by: "item", limit: "2", cursor: first.next! });
    expect(second.rows).toEqual(again.rows);
    expect(second.total).toEqual(first.total);
    const third = run({ cursor: second.next!, limit: "2" });
    const pages = [...first.rows, ...second.rows, ...third.rows].map((row) => row[1]);
    expect(pages).toEqual(["ACME CABS LIMITED", "Acme Cabs", "SYNTHETIC GROCER", "ACME CABS LIMITED", "CORNER BAKERY"]);
    expect(third.next).toBeNull();
    expect(run({ of: "payments", measure: "amount", by: "item", order: "value" }).rows.map((row) => row[6])).toEqual(["50.00", "12.50", "7.25", "3.10", "1999.00"]);
  });

  it("E2 at_least and at_most bound the fact whole, in the currency's decimals, and population names what they left out", () => {
    const big = run({ of: "payments", measure: "amount", at_least: "10" });
    expect(big.total).toEqual([expect.objectContaining({ of: "EUR", n: 2, sum: "62.50 EUR" }), expect.objectContaining({ of: "INR", n: 1 })]);
    expect(big.population).toMatchObject({ facts: 3, excluded: { "amount outside the bounds": 2 } });
    expect(run({ of: "payments", measure: "amount", at_least: "7.25", at_most: "12.50" }).total).toEqual([expect.objectContaining({ of: "EUR", n: 2, sum: "19.75 EUR" })]);
    const long = run({ of: "calls", measure: "minutes", op: "sum", at_least: "50", by: "day" });
    expect(long.rows.map((row) => row.slice(0, 3))).toEqual([["2026-10-01", 1, 20], ["2026-10-02", 1, 40]]);
    expect(long.population).toMatchObject({ excluded: { "no minutes": 1, "minutes outside the bounds": 3 } });
    expect(refusal(() => ask({ of: "calls", at_least: "5" })).message).toContain("at_least bounds a measure");
  });

  it("E3 sleep's two readings answer, each named: in bed is its own column beside asleep", () => {
    const asleep = run({ of: "days", measure: "asleep_min", op: "avg", from: "2026-10-01", to: "2026-10-04" }) as ReturnType<typeof run> & { readings: string[] };
    expect(asleep.readings).toEqual(["in_bed_min: another reading of asleep_min, its avg in its own column"]);
    expect(asleep.total).toEqual([
      expect.objectContaining({ of: "Ring", avg: 450, in_bed_min: 480 }),
      expect.objectContaining({ of: "Watch", avg: 410, in_bed_min: 470 }),
    ]);
    const byDay = run({ of: "days", measure: "asleep_min", op: "sum", by: "day", from: "2026-10-01", to: "2026-10-01" });
    expect(byDay.columns).toEqual(["day", "instrument", "n", "sum", "missing", "in_bed_min", "ref"]);
    expect(byDay.rows.map((row) => row.slice(0, 6))).toEqual([["2026-10-01", "Ring", 1, 450, 0, 480], ["2026-10-01", "Watch", 1, 420, 0, 470]]);
  });

  it("E3 held states the days the record holds when the range runs past them or nothing matched; covers what was read, per instrument", () => {
    const wide = run({ of: "payments", from: "2026-09-01", to: "2026-10-31" }) as ReturnType<typeof run> & { held?: string; covers: string[] };
    expect(wide.held).toBe("payments 2026-10-01 → 2026-10-03");
    expect(wide.covers).toEqual(["bank:acct:a, read to 2026-10-03"]);
    const none = run({ of: "calls", from: "2026-11-01", to: "2026-11-05" }) as ReturnType<typeof run> & { held?: string };
    expect(none.held).toBe("calls 2026-10-01 → 2026-10-01");
    const inside = run({ of: "payments", from: "2026-10-01", to: "2026-10-02" }) as ReturnType<typeof run> & { held?: string };
    expect(inside.held).toBeUndefined();
    expect((run({ of: "payments", "match.payee": "bakery", from: "2026-09-01", to: "2026-10-31" }) as { held?: string }).held).toBe("payments 2026-10-03 → 2026-10-03");
    const sleep = run({ of: "days", measure: "asleep_min", op: "avg", from: "2026-10-01", to: "2026-10-04" }) as ReturnType<typeof run> & { covers: string[] };
    expect(sleep.covers).toEqual(["Ring, read to 2026-10-01", "Watch, read to 2026-10-04"]);
  });

  it("E5 the catalog lists every declared collection with its keys, its measures (units, ops, readings) and the days held", () => {
    const catalog = shown(countOf(index, ask({}), context())) as { catalog: Record<string, { keys: string[]; measures: Record<string, Record<string, unknown>>; held: string }> };
    expect(Object.keys(catalog.catalog)).toEqual([...COLLECTIONS.keys()].sort());
    expect(catalog.catalog.calls).toMatchObject({ keys: ["service", "direction", "outcome", "group", "chat", "person"], held: "2026-10-01 → 2026-10-01", measures: { minutes: { unit: "min", ops: ["sum", "avg", "min", "max", "first", "last"] } } });
    expect(catalog.catalog.payments!.keys).not.toContain("person");
    expect(catalog.catalog.payments!.measures.balance).toMatchObject({ unit: "currency", ops: ["min", "max", "first", "last"] });
    expect(catalog.catalog.days!.measures.asleep_min).toMatchObject({ readings: ["days.in_bed_min"], held: "2026-10-01 → 2026-10-04, 2 of 4 days" });
    expect(catalog.catalog.days!.held).toBe("2026-10-01 → 2026-10-10");
    expect(catalog.catalog.workouts!.held).toBe("none");
    expect(refusal(() => ask({ measure: "amount" })).message).toContain("with no of, count answers the catalog");
  });

  it("E5 a measure of days whose walk stops says no days held, never none: a stopped walk proves no absence", () => {
    const catalog = shown(countOf(index, ask({}), context({ budget: { fetch: 2 } }))) as { catalog: Record<string, { measures: Record<string, Record<string, unknown>>; held: string }> };
    expect(catalog.catalog.days!.measures.asleep_min).toMatchObject({ readings: ["days.in_bed_min"] });
    expect(catalog.catalog.days!.measures.asleep_min!.held).toBeUndefined();
    expect(Object.values(catalog.catalog.days!.measures).map((measure) => measure.held)).not.toContain("none");
  });

  it("E5 the catalog's families: each the index holds an entry of, Ask's own answers left out, with its sources' products, its oldest day and the day they were read through", () => {
    const own = mkdtempSync(join(tmpdir(), "lifestream-count-families-"));
    const built = SearchIndex.write(openHomeFolder(dirname(join(own, "index.db"))), join(own, "index.db"), () => true, 0, SETTINGS);
    const note = (source: string, family: string, key: string, start_ms: number | null) => ({
      record: { source, kind: "note", key }, family, version: "v1", start_ms, end_ms: null, title: "", text: `synthetic entry ${key}`, who: [], link: null,
    });
    built.records([
      note("ask:local:home-a", "ai", "a1", D("2026-01-02")),
      note("chatgpt:acct:a", "ai", "g1", D("2026-03-04")),
      note("chatgpt:acct:b", "ai", "g2", D("2026-05-06")),
      note("ask:local:home-a", "answers", "a2", D("2026-03-05")),
      note("apple-notes:local:mac-a", "notes", "n1", null),
    ], [], { position: { seq: 1, statement: "s-1", reread: 0 } });
    built.finish();
    const read = SearchIndex.read(openHomeFolder(dirname(join(own, "index.db"))), join(own, "index.db"))!;
    try {
      const sources: Record<string, { id: string; product: string; read_through_ms: number | null }[]> = {
        ai: [
          { id: "chatgpt:a", product: "chatgpt", read_through_ms: D("2026-10-08", "09:00") }, { id: "ask:home", product: "ask", read_through_ms: D("2026-10-10", "11:00") },
          { id: "chatgpt:b", product: "chatgpt", read_through_ms: D("2026-10-09", "23:30") },
        ],
        answers: [{ id: "ask:home", product: "ask", read_through_ms: D("2026-10-10", "11:00") }],
        notes: [{ id: "apple-notes:a", product: "apple-notes", read_through_ms: null }],
      };
      const asked: string[] = [];
      const answer = shown(countOf(read, ask({}), context({ sources: (family) => (asked.push(family), sources[family] ?? []) }))) as { families: Record<string, unknown>; catalog: Record<string, unknown> };
      expect(answer.families).toEqual({
        ai: { products: ["chatgpt"], first: "2026-03-04", read_through: "2026-10-09" },
        notes: { products: ["apple-notes"] },
      });
      expect(asked.sort()).toEqual(["ai", "notes"]);
      expect(Object.keys(answer.catalog)).toEqual([...COLLECTIONS.keys()].sort());
    } finally {
      read.close();
      rmSync(own, { recursive: true, force: true });
    }
  });

  it("E4 a row's ref lists the facts behind its number, the total the row's; a fact's ref is its record's", () => {
    const byDay = run({ of: "calls", measure: "minutes", op: "sum", by: "day" });
    const day2 = byDay.rows.find((row) => row[0] === "2026-10-02")!;
    const opened = opening(day2.at(-1));
    expect(opened.asked).toContain("the calls behind one row of");
    expect(opened.columns).toEqual(["time", "service", "direction", "outcome", "group", "chat", "person", "people", "minutes", "ref"]);
    expect(opened.rows.map((row) => [row[0], row[6], row[8]])).toEqual([["2026-10-01T23:40+00:00", "Raj Example", 60]]);
    expect(opened.total).toMatchObject({ n: 1, sum: 40 });
    const byPerson = run({ of: "calls", by: "person" });
    const hers = opening(byPerson.rows[0]!.at(-1));
    expect(hers.rows).toHaveLength(3);
    expect(hers.total).toMatchObject({ n: 3 });
    const longest = run({ of: "calls", measure: "minutes", op: "max" });
    expect(recordKey(((longest.total as Record<string, unknown>).facts as Record<string, unknown>[])[0]!.ref)).toBe("c4");
    expect(refusal(() => run({ cursor: String(day2.at(-1)) })).code).toBe("BAD_PARAMETER");
  });

  it("E4 a row's ref outlives a new revision: it is bound to no index", () => {
    const moving = ownIndex({ "2026-10-01": [payment("m1", "2026-10-01", "SHOP ONE", "4.00", "EUR")] });
    try {
      const at = (params: Record<string, string>) => shown(countOf(moving.index, ask(params), context())) as { rows: unknown[][]; total: unknown };
      const row = at({ of: "payments", by: "day" }).rows[0]!;
      expect(openedIn(moving.index, row.at(-1)).rows).toHaveLength(1);
      moving.index.day("2026-10-02", { inputs: "in-2026-10-02", mtime_us: 1, atoms: [], facts: { window: { start_ms: D("2026-10-02"), end_ms: D("2026-10-03") }, facts: [payment("m2", "2026-10-02", "SHOP TWO", "5.00", "EUR")] } });
      expect(openedIn(moving.index, row.at(-1)).rows).toHaveLength(1);
    } finally {
      moving.close();
    }
  });

});

describe("one snapshot, one ref (fix round 2)", () => {
  it("G4 a currency bound is the decimal as written, in the currency's minor units: 0.29 EUR is inside at_most=0.29 and at_least=0.29", () => {
    const small = ownIndex({ "2026-10-01": [payment("b1", "2026-10-01", "SHOP ONE", "0.29", "EUR"), payment("b2", "2026-10-01", "SHOP TWO", "0.30", "EUR", 2), payment("b3", "2026-10-01", "SHOP JP", "1", "JPY", 3)] });
    try {
      const at = (params: Record<string, string>) => shown(countOf(small.index, ask(params), context())) as { total: Record<string, unknown>[] };
      expect(at({ of: "payments", measure: "amount", at_most: "0.29" }).total).toEqual([expect.objectContaining({ of: "EUR", n: 1, sum: "0.29 EUR" })]);
      expect(at({ of: "payments", measure: "amount", at_least: "0.29", at_most: "0.29" }).total).toEqual([expect.objectContaining({ of: "EUR", n: 1, sum: "0.29 EUR" })]);
      expect(at({ of: "payments", measure: "amount", at_least: "0.29" }).total).toEqual([expect.objectContaining({ of: "EUR", n: 2 }), expect.objectContaining({ of: "JPY", n: 1 })]);
      expect(at({ of: "payments", measure: "amount", at_least: "0.291" }).total).toEqual([expect.objectContaining({ of: "EUR", n: 1, sum: "0.30 EUR" }), expect.objectContaining({ of: "JPY", n: 1 })]);
      expect(at({ of: "payments", measure: "amount", at_most: "1.9" }).total).toEqual([expect.objectContaining({ of: "EUR", n: 2 }), expect.objectContaining({ of: "JPY", n: 1 })]);
      expect(at({ of: "payments", measure: "amount", at_least: "0.5", at_most: "0.9" }).total).toEqual([expect.objectContaining({ n: 0 })]);
    } finally {
      small.close();
    }
  });

  it("G7 a grouped answer's total ref opens every fact of the population, each group's", () => {
    const byDay = run({ of: "calls", measure: "minutes", op: "sum", by: "day" });
    const opened = opening((byDay.total as Record<string, unknown>).ref);
    expect(opened.rows).toHaveLength(5);
    expect(opened.total).toMatchObject({ n: 5, sum: (byDay.total as Record<string, unknown>).sum });
    const byPerson = run({ of: "calls", by: "person" });
    expect(opening((byPerson.total as Record<string, unknown>).ref).total).toMatchObject({ n: (byPerson.total as Record<string, unknown>).n });
  });

  it("P12 chat counts that chat's messages alone, and its calls, resolved as search resolves it, and its row's ref opens them", () => {
    const message = (key: string, day: string, time: string, chat: string, direction: string): DayFileFact => ({
      id: `messages:${key.padStart(24, "0")}`, family: "messages", of: "messages", time_ms: D(day, time), start_ms: D(day, time), end_ms: D(day, time),
      keys: { chat, direction, product: "whatsapp", searchable: "yes" }, measures: {}, who: [{ handle: ADA[1]!, role: direction === "in" ? "sender" as const : "receiver" as const }],
      from: { units: [`messages/${key}`], record: { source: "wa:local:a", kind: "message", key }, alone: true }, lines: [],
    });
    const HERS = "whatsapp:15550000001@s.whatsapp.net", GROUP = "whatsapp:120363@g.us";
    const files: Record<string, DayFileFact[]> = {
      "2026-10-01": [message("m1", "2026-10-01", "09:00", HERS, "in"), message("m2", "2026-10-01", "09:05", HERS, "out"), message("m3", "2026-10-01", "10:00", GROUP, "in")],
      "2026-10-02": [message("m4", "2026-10-02", "09:00", HERS, "in"), message("m5", "2026-10-02", "11:00", GROUP, "out"),
        call("c9", D("2026-10-02", "12:00"), 7, [ADA[1]!], { chat: HERS }), call("c10", D("2026-10-02", "13:00"), 30, [ADA[1]!, RAJ[0]!], { group: "120363@g.us", chat: GROUP }),
        call("c11", D("2026-10-02", "14:00"), 2, [ADA[0]!])],
    };
    const own = mkdtempSync(join(tmpdir(), "lifestream-count-chat-"));
    const built = SearchIndex.write(openHomeFolder(dirname(join(own, "index.db"))), join(own, "index.db"), () => true, 0, SETTINGS);
    built.records([], [], { position: { seq: 1, statement: "s-1", reread: 0 } });
    for (const [day, facts] of Object.entries(files)) built.day(day, { inputs: `in-${day}`, mtime_us: 1, atoms: [], facts: { window: { start_ms: D(day), end_ms: D(day) + 86_400_000 }, facts } });
    const collections = new Map([...COLLECTIONS, ...Object.entries(MESSAGES_COLLECTIONS)]);
    const resolved: string[] = [];
    const chat = (asked: string) => {
      resolved.push(asked);
      return asked === "whatsapp:alias-of-her" ? HERS : asked;
    };
    const chatRef = (key: string) => makeRef("chat", { key });
    const asking = (params: Record<string, string>) => countAsked(params, collections);
    const counted = (params: Record<string, string>) => shown(countOf(built, asking(params), context({ collections, chat }))) as {
      asked: string; total: Record<string, unknown>; columns: string[]; rows: unknown[][];
    };
    try {
      const hers = counted({ of: "messages", chat: chatRef(HERS), by: "day" });
      expect(hers.total).toMatchObject({ n: 3 });
      expect(hers.asked).toContain("in the chat asked");
      expect(hers.rows.map((row) => row.slice(0, 2))).toEqual([["2026-10-01", 2], ["2026-10-02", 1]]);
      const opened = openedIn(built, hers.rows[0]!.at(-1), { collections, chat });
      expect(opened.total).toMatchObject({ n: 2 });
      expect(opened.rows.map((row) => row[opened.columns.indexOf("chat")])).toEqual([HERS, HERS]);
      expect(counted({ of: "messages", chat: chatRef("whatsapp:alias-of-her") }).total).toMatchObject({ n: 3 });
      expect(resolved).toContain("whatsapp:alias-of-her");
      expect(counted({ of: "messages", chat: chatRef(GROUP) }).total).toMatchObject({ n: 2 });
      expect(counted({ of: "messages", chat: chatRef("whatsapp:999@g.us") }).total).toMatchObject({ n: 0 });
      expect(counted({ of: "calls", chat: chatRef("whatsapp:alias-of-her"), measure: "minutes", op: "sum" }).total).toMatchObject({ n: 1, sum: 7 });
      expect(counted({ of: "calls", chat: chatRef(GROUP) }).total).toMatchObject({ n: 1 });
      expect(refusal(() => asking({ of: "payments", chat: chatRef(HERS) })).message).toBe("[BAD_PARAMETER] payments states no chat: a chat's facts are of=calls, of=messages");
    } finally {
      built.close();
      rmSync(own, { recursive: true, force: true });
    }
  });
});

describe("the contract's count (R5a)", () => {
  const counted = (params: CountParams, over: Partial<CountContext> = {}): any => {
    const asked = countAskOf(params, COLLECTIONS);
    return countAnswer.parse(JSON.parse(JSON.stringify(countShown(countOf(index, asked, context(over)), asked))));
  };
  const opened = (ref: string, over: Partial<CountContext> = {}) => {
    const { ask, kept, scope, n } = readRef(ref, "ref", ["row"]).parts;
    const asked = countAskOf(ask, COLLECTIONS);
    const { answer, now } = index.snapshot(countAttached(asked, context(over)), (read) => openRowIn(read, asked, kept, scope, undefined, context(over)));
    return { n, now: now === n ? undefined : now, refs: answer.rows.map((row) => row.at(-1)!.value as string).sort() };
  };
  const refusal = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      if (error instanceof Refusal) return { status: error.status, code: error.code, words: error.words, extra: error.extra };
      throw error;
    }
    throw new Error("not refused");
  };

  it("C1 answers the contract's three shapes: a count, a first, the catalog; one total, its refs a row's", () => {
    const byPerson = counted({ of: "calls", by: ["person"] });
    expect(byPerson.columns.at(-1)).toBe("ref");
    expect(byPerson.rows.every((row: unknown[]) => String(row.at(-1)).startsWith("row."))).toBe(true);
    expect(byPerson.total).toMatchObject({ n: 5, ref: expect.stringMatching(/^row\./u) });
    expect(byPerson).not.toHaveProperty("zone");
    const money = counted({ of: "payments", measure: "amount" });
    expect(money.total).toMatchObject({ n: 5, sum: "72.85 EUR; 1999.00 INR", ref: expect.stringMatching(/^row\./u) });
    expect(money.columns).toEqual(["currency", "n", "sum", "ref"]);
    expect(money.rows.map((row: unknown[]) => row.slice(0, 3))).toEqual([["EUR", 4, "72.85 EUR"], ["INR", 1, "1999.00 INR"]]);
    const first = counted({ of: "calls", measure: "minutes", op: "first" });
    expect(first).toMatchObject({ op: "first", found: { value: 10, at: "2026-10-01T09:00+00:00", day: "2026-10-01", ref: expect.stringMatching(/^record\./u) } });
    expect(first).not.toHaveProperty("population");
    const least = counted({ of: "calls", measure: "minutes", op: "min" });
    expect(least.total).toMatchObject({ min: 5 });
    expect(least.rows).toHaveLength(1);
    expect(least.rows[0].at(-1)).toMatch(/^record\./u);
    const items = counted({ of: "payments", by: ["item"], match: { payee: "corner" } });
    expect(items.rows.map((row: unknown[]) => row[0])).toEqual(["2026-10-03"]);
    const catalog = counted({});
    expect(catalog.collections.map((each: { of: string }) => each.of)).toEqual(["calls", "days", "payments", "workouts"]);
    expect(catalog.screen).toHaveProperty("unread");
  });

  it("C2 a row's ref opens as the facts it counted, each with the ref a by-item count gives it", () => {
    const byPayee = counted({ of: "payments", measure: "amount", by: ["payee"], match: { payee: "acme" } });
    const row = byPayee.rows.find((each: unknown[]) => each[0] === "ACME CABS LIMITED");
    const items = counted({ of: "payments", by: ["item"], match: { payee: "acme" } });
    const theirs = items.rows.filter((each: unknown[]) => each[items.columns.indexOf("payee")] === "ACME CABS LIMITED").map((each: unknown[]) => each.at(-1)).sort();
    expect(opened(row.at(-1))).toEqual({ n: 2, now: undefined, refs: theirs });
    expect(theirs).toHaveLength(2);
  });

  it("C3 a grouped count's total reopens as its total; a currency's total as that currency's, never a group", () => {
    const byPerson = counted({ of: "calls", by: ["person"] });
    expect(opened(byPerson.total.ref)).toMatchObject({ n: 5, now: undefined });
    expect(opened(byPerson.total.ref).refs).toHaveLength(5);
    const money = counted({ of: "payments", measure: "amount", by: ["payee"] });
    const eur = counted({ of: "payments", measure: "amount" }).rows.find((row: unknown[]) => row[0] === "EUR");
    expect(opened(eur.at(-1))).toMatchObject({ n: 4, now: undefined });
    expect(opened(money.total.ref)).toMatchObject({ n: 5, now: undefined });
  });

  it("C4 a person's row opens as that person's facts after People named them by another id, never another's", () => {
    const byPerson = counted({ of: "calls", by: ["person"] });
    const ada = byPerson.rows.find((row: unknown[]) => row[0] === "Ada Example");
    const before = opened(ada.at(-1));
    expect(before).toMatchObject({ n: 3, now: undefined });
    const moved: PeopleMap = {
      ...PEOPLE, version: "people-2",
      idOf: (id) => (id === "person:ada-2" || ADA.includes(id) ? "person:ada-2" : PEOPLE.idOf(id) === "person:raj" ? "person:raj" : undefined),
      person: (id) => (id === "person:ada-2" ? { name: "Ada Example", handles: ADA } : id === "person:ada" ? undefined : PEOPLE.person(id)),
    };
    expect(opened(ada.at(-1), { people: () => moved })).toEqual(before);
  });

  it("C6 a row of a value thousands of characters long: its ref within REF_CHARS, opening its own group's facts though another starts alike; its words as read states them", () => {
    const long = (tail: string) => `SYNTHETIC PAYEE ${"WITH A VERY LONG NAME ".repeat(150)}${tail}`;
    const own = SearchIndex.write(openHomeFolder(dirname(join(dir, "long-values.db"))), join(dir, "long-values.db"), () => true, 0, SETTINGS);
    try {
      own.records([], [], { position: { seq: 1, statement: "s-1", reread: 0 } });
      own.day("2026-10-01", { inputs: "in-long", mtime_us: 1, atoms: [], facts: { window: { start_ms: D("2026-10-01"), end_ms: D("2026-10-02") }, facts: [
        payment("l1", "2026-10-01", long("ONE"), "10.00", "EUR", 1), payment("l2", "2026-10-01", long("ONE"), "11.00", "EUR", 2), payment("l3", "2026-10-01", long("TWO"), "12.00", "EUR", 3),
      ] } });
      const params: CountParams = { of: "payments", by: ["payee"] };
      const asked = countAskOf(params, COLLECTIONS);
      const answer = countAnswer.parse(JSON.parse(JSON.stringify(countShown(countOf(own, asked, context()), asked)))) as { rows: unknown[][]; columns: string[] };
      expect(answer.rows).toHaveLength(2);
      for (const row of answer.rows) {
        const ref = String(row.at(-1));
        expect(ref.length).toBeLessThanOrEqual(REF_CHARS);
        const { ask, kept, scope, n } = readRef(ref, "ref", ["row"]).parts;
        expect("g" in scope && typeof scope.g[0] === "object" && scope.g[0] !== null && !Array.isArray(scope.g[0]) ? [...(scope.g[0] as { v: string }).v].length : 0).toBe(VALUE_KEPT);
        const rowAsk = countAskOf(ask, COLLECTIONS);
        const opened = own.snapshot(countAttached(rowAsk, context()), (read) => openRowIn(read, rowAsk, kept, scope, undefined, context()));
        expect(opened.answer.rows.map((each) => each[opened.answer.columns.indexOf("payee")]!.value)).toEqual(Array(n).fill(row[0]));
        expect(rowAskedOf(ask, scope, COLLECTIONS)).toBe(opened.answer.asked.value);
      }
      expect(answer.rows.map((row) => row[answer.columns.indexOf("n")])).toEqual([2, 1]);
    } finally {
      own.close();
    }
  });

  it("C5 a person no one is, or a name several people go by, is PERSON_UNKNOWN; several with their matches", () => {
    expect(refusal(() => counted({ of: "calls", person: ["Nobody Example"] }))).toMatchObject({ status: 404, code: "PERSON_UNKNOWN", words: expect.stringContaining("search_people") });
    const several = refusal(() => counted({ of: "calls", person: ["Example"] }));
    expect(several).toMatchObject({ status: 404, code: "PERSON_UNKNOWN" });
    expect((several.extra.matches as { name: string }[]).map((each) => each.name)).toEqual(["Ada Example", "Raj Example"]);
    const ada = counted({ of: "calls", person: ["Ada"] }).total.n;
    for (const value of [personRef({ id: "person:ada", handles: ADA }), ADA[2]!, "Ada Example"]) expect(counted({ of: "calls", person: [value] }).total.n, value).toBe(ada);
    expect(refusal(() => counted({ of: "calls", person: ["person:ada"] }))).toMatchObject({ status: 404, code: "PERSON_UNKNOWN" });
  });
});

describe("a count's pages by place (R5b)", () => {
  const SIX = Array.from({ length: 6 }, (_, n) => call(`r${n}`, D("2026-10-03", `0${n + 1}:00`), 5, [RAJ[0]!]));

  it("P1 a row's facts, a fact inserted before its place and one erased past it between two pages: each fact once", () => {
    const own = ownIndex({ "2026-10-03": SIX });
    try {
      const asked = countAskOf({ of: "calls", limit: 2 }, COLLECTIONS);
      const page = (place?: Parameters<typeof openRowIn>[4]) => own.index.snapshot(countAttached(asked, context()), (read) => openRowIn(read, asked, {}, {}, place, context())).answer;
      const keyOf = (row: { value: unknown }[]) => readRef(String(row.at(-1)!.value), "ref", ["record"]).parts.key;
      const first = page();
      expect(first.rows.map(keyOf)).toEqual(["r0", "r1"]);
      own.index.day("2026-10-03", { inputs: "in-2", mtime_us: 2, atoms: [], facts: { window: { start_ms: D("2026-10-03"), end_ms: D("2026-10-04") }, facts: [
        call("r-early", D("2026-10-03", "00:30"), 5, [RAJ[0]!]), ...SIX.filter((fact) => !fact.id.endsWith("r3")),
      ] } });
      const keys = first.rows.map(keyOf);
      for (let at = first.place, n = 0; at !== undefined && n < 10; n++) {
        const next = page(at);
        keys.push(...next.rows.map(keyOf));
        at = next.place;
      }
      expect(keys).toEqual(["r0", "r1", "r2", "r4", "r5"]);
    } finally {
      own.close();
    }
  });

  it("P2 a count's groups page by what they gave, sealed: the rest once; a next of another route refused", () => {
    const own = ownIndex({ "2026-10-03": Array.from({ length: 5 }, (_, n) => call(`g${n}`, D("2026-10-03", `0${n + 1}:00`), n + 1, [RAJ[0]!], { outcome: `o${n}` })) });
    try {
      const paged = (params: CountParams) => countAnswer.parse(JSON.parse(JSON.stringify(countShown(countOf(own.index, countAskedOf(params, COLLECTIONS), context()), countAskedOf(params, COLLECTIONS))))) as any;
      const first = paged({ of: "calls", by: ["outcome"], limit: 2 });
      const outcomes = first.rows.map((row: unknown[]) => row[0]);
      for (let next = first.next, n = 0; next !== undefined && next !== null && n < 5; n++) {
        const page = paged({ cursor: next });
        outcomes.push(...page.rows.map((row: unknown[]) => row[0]));
        next = page.next;
      }
      expect([...outcomes].sort()).toEqual(["o0", "o1", "o2", "o3", "o4"]);
      expect(refusal(() => paged({ cursor: sealed("record", [1], { query: "x" }, {}) }))).toMatchObject({ code: "BAD_PARAMETER" });
    } finally {
      own.close();
    }
  });
});
