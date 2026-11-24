import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { digest, openHomeFolder, type DaySettings, type ExtractRow, type Json } from "@lifestreamprotocol/core";
import { buildLabels, CALLS_COLLECTIONS, healthFamily, labelsFrom, MONEY_COLLECTIONS, PHYSICAL, physicalFamily, presence, where, type DayFileFact, type Piece } from "@lifestreamprotocol/families";
import { presenceTablesOf, restsOnIn } from "./places.js";

const ALONE = restsOnIn([], []);
import { PLACES, writePrepared } from "./prepared.js";
import { Refusal } from "./refusal.js";
import { SearchIndex } from "./search-index.js";
import type { PresenceSource } from "./presence.js";
import type { CountContext } from "./counting.js";
import { presenceSource, writePresenceFile } from "./test/presence-file.js";
import { countAsked, rowOf, countOf, shown } from "./test/record-reads.js";


const SETTINGS: DaySettings = { zone: "Europe/Paris", day_start_hour: 0 };
const PARIS = { latitude: 48.8566, longitude: 2.3522 };
const NEW_YORK = { latitude: 40.7128, longitude: -74.006 };
const CHICAGO = { latitude: 41.8781, longitude: -87.6298 };
const MIN = 60_000;
const at = (local: string) => Date.parse(`${local}+01:00`);
const ny = (local: string) => Date.parse(`${local}-05:00`);

const BUILT = buildLabels({
  places: [{ slug: "home", name: "Home", latitude: PARIS.latitude, longitude: PARIS.longitude, radius_m: 100, also: [], ids: [] }],
  cameras: [["synthetic-make/own-camera", { mine_by_count: true }]],
});
const LABELS = labelsFrom((unit) => {
  const content = BUILT.contents.get(unit);
  return content === undefined ? undefined : { content };
}, SETTINGS);

function stay(start: number, end: number, point: typeof PARIS, how: Piece["how"] = "observed", level: Piece["level"] = "place"): Piece {
  return { kind: "stay", level, how, point, from: null, to: null, units: [`stay/location:local:iphone-aa01/${start}`], start_ms: start, end_ms: end };
}
function move(start: number, end: number, from: typeof PARIS, to: typeof PARIS): Piece {
  return { kind: "move", level: "place", how: "observed", point: null, from, to, units: [`trip/location:local:iphone-aa01/${start}`, `seen/photos:local:iphone-aa01/${start}`], start_ms: start, end_ms: end };
}

const LINE: Piece[] = [
  stay(at("2025-12-20T00:00"), at("2025-12-28T10:00"), PARIS),
  move(at("2025-12-28T10:00"), ny("2025-12-28T12:00"), PARIS, NEW_YORK),
  stay(ny("2025-12-28T12:00"), ny("2025-12-30T06:00"), NEW_YORK),
  stay(ny("2025-12-30T06:00"), at("2026-01-01T00:30"), NEW_YORK, "guessed", "city"),
  stay(at("2026-01-01T00:30"), ny("2026-01-03T04:00"), NEW_YORK),
  move(ny("2026-01-03T04:00"), at("2026-01-03T20:00"), NEW_YORK, PARIS),
  stay(at("2026-01-03T20:00"), at("2026-01-10T00:00"), PARIS),
  stay(at("2026-01-10T00:00"), at("2026-01-10T12:00"), CHICAGO, "observed", "country"),
  stay(at("2026-01-10T12:00"), at("2026-01-12T00:00"), PARIS),
];
const DAYS = Array.from({ length: 23 }, (_, at) => new Date(Date.UTC(2025, 11, 20 + at)).toISOString().slice(0, 10));
const NOW = at("2026-01-12T00:00");
const TABLES = presenceTablesOf(LINE, DAYS, LABELS, new Map(), SETTINGS, NOW, ALONE);
const dir = mkdtempSync(join(tmpdir(), "lifestream-count-places-"));
writePresenceFile(join(dir, "places.db"), TABLES);
const PRESENCE: PresenceSource = presenceSource(join(dir, "places.db"));

const STRAY_DAY = "2026-02-01";
function extract(unit: string, content: Record<string, unknown>, start_ms: number, end_ms: number, seq: number): ExtractRow {
  return { family: PHYSICAL, unit, reading: digest(content as Json), code: "", content: content as Json, start_ms, end_ms, days: [STRAY_DAY], seq };
}
const phoneStay = (from: string, to: string, seq: number) => extract(`stay/location:local:iphone-0001/${from}`, {
  kind: "stay", source: "location:local:iphone-0001", start_ms: at(from), end_ms: at(to), open: false, centre: PARIS, level: "observed", silences: [], bouts: [], rank: 10, how: "observed", by: "Phone",
}, at(from), at(to), seq);
const STRAY_EXTRACTS = [
  phoneStay("2026-02-01T00:00", "2026-02-01T13:00", 0),
  phoneStay("2026-02-01T14:00", "2026-02-02T00:00", 1),
  extract(`seen/photos:local:mac-0001/${STRAY_DAY}`, {
    kind: "seen", source: "photos:local:mac-0001", date: STRAY_DAY, start_ms: at("2026-02-01T13:30"), end_ms: at("2026-02-01T13:30"),
    photos: [{ at_ms: at("2026-02-01T13:30"), point: NEW_YORK, accuracy_m: null, camera: "synthetic-make/own-camera" }], rank: 20, how: "seen", by: "Photos",
  }, at("2026-02-01T13:30"), at("2026-02-01T13:30"), 2),
];
const STRAY_PIECES = where(STRAY_EXTRACTS, { start_ms: at("2026-02-01T00:00"), end_ms: at("2026-02-02T00:00") }, LABELS, 0, SETTINGS);
writePresenceFile(join(dir, "stray.db"), presenceTablesOf(STRAY_PIECES, [STRAY_DAY], LABELS, new Map(), SETTINGS, at("2026-02-02T00:00"), ALONE));
const STRAY_PRESENCE = presenceSource(join(dir, "stray.db"));

const TRIP: Piece[] = [
  stay(at("2026-03-01T00:00"), ny("2026-03-02T08:00"), PARIS),
  move(ny("2026-03-02T08:00"), ny("2026-03-02T10:00"), PARIS, NEW_YORK),
  stay(ny("2026-03-02T10:00"), ny("2026-03-03T22:00"), NEW_YORK),
  stay(ny("2026-03-03T22:00"), ny("2026-03-05T02:00"), NEW_YORK, "guessed", "city"),
  stay(ny("2026-03-05T02:00"), ny("2026-03-06T22:00"), NEW_YORK),
  move(ny("2026-03-06T22:00"), at("2026-03-07T12:00"), NEW_YORK, PARIS),
  stay(at("2026-03-07T12:00"), at("2026-03-10T00:00"), PARIS),
];
const TRIP_DAYS = Array.from({ length: 9 }, (_, at) => `2026-03-0${at + 1}`);
writePresenceFile(join(dir, "trip.db"), presenceTablesOf(TRIP, TRIP_DAYS, LABELS, new Map(), SETTINGS, at("2026-03-10T00:00"), ALONE));
const TRIP_PRESENCE = presenceSource(join(dir, "trip.db"));
const TRIP_RANGE = { from: "2026-03-01", to: "2026-03-09" };

let index: SearchIndex;
const COLLECTIONS = new Map(Object.entries({ ...CALLS_COLLECTIONS, ...MONEY_COLLECTIONS, ...healthFamily([]).collections, ...physicalFamily({ photos: [] })([]).collections }));
const context = (over: Partial<CountContext> = {}): CountContext => ({
  collections: COLLECTIONS, settings: SETTINGS, now_ms: at("2026-02-10T12:00"), people: () => ({ version: "people-0", idOf: () => undefined, person: () => undefined, find: () => [] }), presence: PRESENCE, ...over,
});

const call = (key: string, start: number, minutes: number): DayFileFact => ({
  id: `calls:${key.padStart(24, "0")}`, family: "calls", of: "calls", time_ms: start, start_ms: start, end_ms: start + minutes * MIN,
  keys: { service: "whatsapp", direction: "outgoing", outcome: "connected" }, measures: { minutes },
  who: [], from: { units: [`calls/${key}`], record: { source: "wa:local:a", kind: "call", key } }, lines: [],
});
const healthDay = (day: string, measures: Record<string, number>, instrument = "Watch"): DayFileFact => ({
  id: `days:${`${day}${instrument === "Watch" ? "" : instrument}`.replace(/\W/gu, "").padStart(24, "0")}`, family: "health", of: "days", time_ms: at(`${day}T00:00`), start_ms: at(`${day}T00:00`), end_ms: at(`${day}T00:00`), date_only: true,
  keys: { instrument }, measures, who: [], from: { units: [`health/${day}`], instrument }, lines: [],
});
const WATCH_NIGHTS: Record<string, number> = { "2026-01-05": 400, "2026-01-06": 410, "2026-01-07": 420 };
const RING_NIGHTS: Record<string, number> = { "2026-01-06": 450, "2026-01-07": 460, "2026-01-09": 470 };
const payment = (key: string, day: string, amount: string, currency: string): DayFileFact => ({
  id: `payments:${key.padStart(24, "0")}`, family: "money", of: "payments", time_ms: Date.parse(`${day}T00:00:00Z`), start_ms: Date.parse(`${day}T00:00:00Z`), end_ms: Date.parse(`${day}T00:00:00Z`), date_only: true,
  keys: { payee: `PAYEE ${key}`, direction: "debit", currency }, measures: { amount }, who: [], from: { units: [`money/${key}`], record: { source: "bank:acct:a", kind: "payment", key }, alone: true }, lines: [],
});
const PAYMENTS: DayFileFact[] = [
  payment("m1", "2026-01-05", "10.00", "EUR"), payment("m2", "2026-01-05", "5.00", "EUR"), payment("m3", "2026-01-06", "1500", "JPY"), payment("m4", "2026-01-08", "2.50", "EUR"),
];
const LATE = at("2026-02-05T23:30");
const LATE_CALL: DayFileFact = { ...call("k6", LATE, 60), end_ms: LATE + 60 * MIN };
const SPRING = Date.parse("2026-03-29T01:30:00+01:00");
const CLOCK_DAYS: Record<string, DayFileFact[]> = {
  "2026-02-05": [LATE_CALL],
  "2026-02-06": [],
  "2026-03-29": [call("k7", SPRING, 60)],
};
const CALLS: DayFileFact[] = [
  call("k1", ny("2025-12-29T23:30"), 20),
  call("k2", at("2026-01-10T07:00"), 5),
  call("k3", at("2026-01-05T10:00"), 10),
  call("k4", at("2025-12-28T09:00"), 15),
  call("k5", at("2026-02-01T13:30"), 3),
];
const stayFact = (key: string, start: number, minutes: number): DayFileFact => ({
  id: `stays:${key.padStart(24, "0")}`, family: "physical", of: "stays", time_ms: start, start_ms: start, end_ms: start + minutes * MIN,
  keys: { city: "New York City", country: "United States", how: "observed" }, measures: { minutes }, who: [], from: { units: [`stay/${key}`], instrument: "Phone" }, lines: [],
});
const STAYS_FACTS: DayFileFact[] = [stayFact("s1", ny("2026-03-03T12:00"), 60), stayFact("s2", ny("2026-03-06T20:00"), 60)];
const WORKOUT: DayFileFact = {
  id: `workouts:${"r1".padStart(24, "0")}`, family: "health", of: "workouts", time_ms: at("2026-01-06T22:00"), start_ms: at("2026-01-06T22:00"), end_ms: at("2026-01-08T02:00"),
  keys: { sport: "rowing", instrument: "Watch" }, measures: { minutes: 28 * 60 }, who: [], from: { units: ["health/r1"], instrument: "Watch" }, lines: [],
};

beforeAll(() => {
  index = SearchIndex.write(openHomeFolder(dirname(join(dir, "index.db"))), join(dir, "index.db"), () => true, 0, SETTINGS);
  index.records([], [], { position: { seq: 1, statement: "s-1", reread: 0 } });
  const byDay = new Map<string, DayFileFact[]>();
  for (const day of [...DAYS, STRAY_DAY]) {
    byDay.set(day, [healthDay(day, { steps: 1000, ...(WATCH_NIGHTS[day] === undefined ? {} : { asleep_min: WATCH_NIGHTS[day] }) }),
      ...(RING_NIGHTS[day] === undefined ? [] : [healthDay(day, { asleep_min: RING_NIGHTS[day] }, "Ring")])]);
  }
  for (const day of TRIP_DAYS) byDay.set(day, [healthDay(day, { steps: 1000 })]);
  for (const each of [...CALLS, ...PAYMENTS, ...STAYS_FACTS, WORKOUT]) {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: SETTINGS.zone }).format(each.time_ms);
    byDay.set(day, [...byDay.get(day) ?? [], each]);
  }
  for (const [day, facts] of Object.entries(CLOCK_DAYS)) byDay.set(day, facts);
  for (const [day, facts] of byDay) {
    const start = at(`${day}T00:00`);
    index.day(day, { inputs: `in-${day}`, mtime_us: 1, atoms: [], facts: { window: { start_ms: start, end_ms: start + 86_400_000 }, facts } });
  }
});

afterAll(() => {
  index.close();
  rmSync(dir, { recursive: true, force: true });
});

const ask = (params: Record<string, string>) => countAsked(params, COLLECTIONS);
type Answer = { asked: string; matched: Record<string, unknown>; population: Record<string, unknown>; total: Record<string, unknown>; columns: string[]; rows: unknown[][] };
const run = (params: Record<string, string>, over: Partial<CountContext> = {}) => shown(countOf(index, ask(params), context(over))) as Answer;
const rowOpened = (ref: unknown, over: Partial<CountContext> = {}) => shown(rowOf(index, String(ref), context(over))) as Answer;
const refusal = (work: () => unknown): Refusal => {
  try {
    work();
  } catch (error) {
    if (error instanceof Refusal) return error;
    throw error;
  }
  throw new Error("not refused");
};
const RANGE = { from: "2025-12-20", to: "2026-01-11" };
const column = (answer: Answer, name: string) => answer.rows.map((row) => row[answer.columns.indexOf(name)]);

describe("where the person was, in /v1/count (D3b)", () => {
  it("W1 a trip abroad across a year's edge is one run, its days New York's; a day elsewhere ends a run", () => {
    const trips = run({ of: "days", place: "United States", by: "run", ...RANGE });
    expect(trips.columns.slice(0, 6)).toEqual(["from_day", "to_day", "days", "guessed_days", "cities", "country"]);
    expect(trips.rows.map((row) => row.slice(0, 6))).toEqual([
      ["2025-12-28", "2026-01-03", 7, 0, "New York City", "United States"],
      ["2026-01-10", "2026-01-10", 1, 0, "", "United States"],
    ]);
    expect(trips.asked).toContain("(a trip)");
    const opened = rowOpened(trips.rows[0]!.at(-1));
    expect(opened.total).toMatchObject({ n: 7 });
    expect(run({ of: "days", place: "new york city", by: "run", ...RANGE }).rows.map((row) => row.slice(0, 4))).toEqual([["2025-12-28", "2026-01-03", 7, 0]]);
    expect(run({ of: "days", place: "US", ...RANGE }).total).toMatchObject({ n: 8 });
  });

  it("W2 a stray photo abroad inside a day at home is no day there, and puts no call there", () => {
    expect(STRAY_PIECES.flatMap((piece) => piece.units)).not.toContain(`seen/photos:local:mac-0001/${STRAY_DAY}`);
    const over = { presence: STRAY_PRESENCE };
    expect(run({ of: "days", place: "United States", from: STRAY_DAY, to: STRAY_DAY }, over).total).toMatchObject({ n: 0 });
    expect(run({ of: "days", place: "France", from: STRAY_DAY, to: STRAY_DAY }, over).total).toMatchObject({ n: 1 });
    expect(run({ of: "calls", place: "New York", from: STRAY_DAY, to: STRAY_DAY }, over).total).toMatchObject({ n: 0 });
  });

  it("W3 a travel day is in both countries, once in the total, with overlap stated", () => {
    const byCountry = run({ of: "days", by: "country", ...RANGE });
    expect(Object.fromEntries(byCountry.rows.map((row) => [row[0], row[1]]))).toEqual({ France: 18, "United States": 8 });
    expect(byCountry.total).toMatchObject({ n: 23 });
    expect(byCountry.population.overlap).toBe(3);
    expect(byCountry.asked).toContain("overlap counts them");
    const calls = run({ of: "calls", by: "country", ...RANGE });
    expect(Object.fromEntries(calls.rows.map((row) => [row[0], row[1]]))).toEqual({ France: 2, "United States": 2 });
    expect(run({ of: "calls", place: "France", ...RANGE }).total).toMatchObject({ n: 2 });
    expect(run({ of: "days", place: "-United States", ...RANGE }).total).toMatchObject({ n: 15 });
    expect(run({ of: "calls", place: "Home", ...RANGE }).total).toMatchObject({ n: 2 });
    expect(run({ of: "calls", by: "place", ...RANGE }).rows.map((row) => row.slice(0, 2))).toEqual(expect.arrayContaining([["Home", 2]]));
  });

  it("W4 a call at 23:30 in New York is shown in New York's time, the one time rule's (presence.ts `at`), and grouped by New York's hour", () => {
    const items = run({ of: "calls", by: "item", order: "time", ...RANGE });
    expect(column(items, "time")[1]).toBe("2025-12-29T23:30-05:00");
    expect(column(items, "time")[0]).toBe("2025-12-28T09:00+01:00");
    const byHour = run({ of: "calls", by: "hour", ...RANGE });
    expect(byHour.rows.map((row) => row.slice(0, 2))).toEqual(expect.arrayContaining([[23, 1], [10, 1], [9, 1]]));
    expect(byHour.rows.some((row) => row[0] === 5)).toBe(false);
  });

  it("W5 a piece known only by a country of several zones shows the home's time, marked", () => {
    const longest = run({ of: "calls", measure: "minutes", op: "min", ...RANGE });
    expect(longest.total).toMatchObject({ min: 5, facts: [{ time: "2026-01-10T07:00+01:00" }] });
    expect(run({ of: "calls", by: "hour", from: "2026-01-10", to: "2026-01-10" }).rows.map((row) => row.slice(0, 2))).toEqual([[7, 1]]);
  });

  it("W6 presence being prepared: a query that needs it refuses INDEX_BUILDING; a time shown without it is the home's, marked", () => {
    writePrepared(openHomeFolder(dirname(join(dir, "empty.db"))), join(dir, "empty.db"), PLACES, { rows: new Map(), position: "1" });
    for (const preparing of [{ presence: presenceSource(join(dir, "none.db")) }, { presence: presenceSource(join(dir, "empty.db")) }]) {
      for (const params of [{ of: "days", place: "France" }, { of: "days", by: "country" }, { of: "calls", by: "hour" }, { of: "days", by: "run" }]) {
        expect(refusal(() => run({ ...params, ...RANGE }, preparing)).code).toBe("INDEX_BUILDING");
      }
      const items = run({ of: "calls", by: "item", order: "time", ...RANGE }, preparing);
      expect(column(items, "time")[1]).toBe("2025-12-30T05:30+01:00");
    }
  });

  it("W7 a presence piece names every unit it rests on, each with its reading, and the account of each", () => {
    const pieces = presence(LINE, LABELS, ALONE, new Map([[`trip/location:local:iphone-aa01/${LINE[1]!.start_ms}`, "r-trip"]]));
    expect(pieces.map((piece) => piece.units.map((each) => each.unit))).toEqual(LINE.map((piece) => piece.units));
    expect(pieces[1]!.units).toEqual([
      { unit: `trip/location:local:iphone-aa01/${LINE[1]!.start_ms}`, reading: "r-trip" }, { unit: `seen/photos:local:iphone-aa01/${LINE[1]!.start_ms}`, reading: null },
    ]);
    expect([pieces[0]!.accounts, pieces[1]!.accounts]).toEqual([["location:local"], ["location:local", "photos:local"]]);
    expect(TABLES.pieces.find((piece) => piece[0] === LINE[1]!.start_ms)?.[5]).toEqual(["location:local", "photos:local"]);
    expect(pieces.map((piece) => piece.zone)).toEqual(["Europe/Paris", null, "America/New_York", "America/New_York", "America/New_York", null, "Europe/Paris", null, "Europe/Paris"]);
  });

  it("W8 place names whole before parts; an unknown place matches nothing", () => {
    const york = run({ of: "days", place: "New York", ...RANGE });
    expect(york.total).toMatchObject({ n: 7 });
    expect(JSON.stringify(york.matched)).toContain("New York");
    expect(run({ of: "days", place: "Atlantis", ...RANGE }).total).toMatchObject({ n: 0 });
    expect(run({ of: "days", place: "France OR United States", ...RANGE }).total).toMatchObject({ n: 23 });
  });

  it("W9 a measured run sums per currency through the one engine, and each run's ref opens exactly its facts", () => {
    const runs = run({ of: "payments", measure: "amount", by: "run", ...RANGE });
    expect(runs.columns).toEqual(["from_day", "to_day", "days", "guessed_days", "cities", "currency", "n", "sum", "missing", "ref"]);
    expect(runs.rows.map((row) => row.slice(0, -1))).toEqual([
      ["2026-01-05", "2026-01-05", 1, 0, "Paris", "EUR", 2, "15.00", 0],
      ["2026-01-06", "2026-01-06", 1, 0, "Paris", "JPY", 1, "1500", 0],
      ["2026-01-08", "2026-01-08", 1, 0, "Paris", "EUR", 1, "2.50", 0],
    ]);
    expect(runs.total).toEqual([expect.objectContaining({ of: "EUR", n: 3, sum: "17.50 EUR" }), expect.objectContaining({ of: "JPY", n: 1, sum: "1500 JPY" })]);
    const opened = runs.rows.map((row) => rowOpened(row.at(-1)));
    expect(opened.map((each) => each.rows.length)).toEqual([2, 1, 1]);
    expect(opened.map((each) => each.total)).toEqual([
      [expect.objectContaining({ of: "EUR", n: 2, sum: "15.00 EUR" })], [expect.objectContaining({ of: "JPY", n: 1, sum: "1500 JPY" })], [expect.objectContaining({ of: "EUR", n: 1, sum: "2.50 EUR" })],
    ]);
    const euros = run({ of: "payments", measure: "amount", by: "run", "match.currency": "EUR", ...RANGE });
    expect(euros.rows.map((row) => row.slice(0, 2))).toEqual([["2026-01-05", "2026-01-05"], ["2026-01-08", "2026-01-08"]]);
    const replayed = rowOpened(euros.rows[1]!.at(-1));
    expect(replayed.rows).toHaveLength(1);
    expect(replayed.total).toEqual([expect.objectContaining({ of: "EUR", n: 1, sum: "2.50 EUR" })]);
    const most = run({ of: "payments", measure: "amount", op: "max", by: "run", ...RANGE });
    expect(most.rows.map((row) => [row[0], row[most.columns.indexOf("max")]])).toEqual([["2026-01-05", "10.00"], ["2026-01-06", "1500"], ["2026-01-08", "2.50"]]);
  });

  it("W10 a clock sum by hour follows elapsed time across midnight and a clock change; a count stays at its starting hour", () => {
    const late = run({ of: "calls", measure: "minutes", op: "sum", by: "hour", from: "2026-02-05", to: "2026-02-06" });
    expect(late.rows.map((row) => row.slice(0, 3))).toEqual([[0, 1, 30], [23, 1, 30]]);
    expect(late.total).toMatchObject({ n: 1, sum: 60 });
    expect(run({ of: "calls", by: "hour", from: "2026-02-05", to: "2026-02-06" }).rows.map((row) => row.slice(0, 2))).toEqual([[23, 1]]);
    const spring = run({ of: "calls", measure: "minutes", op: "sum", by: "hour", from: "2026-03-29", to: "2026-03-29" }, { now_ms: at("2026-04-01T12:00") });
    expect(spring.rows.map((row) => row.slice(0, 3))).toEqual([[1, 1, 30], [3, 1, 30]]);
    const opened = rowOpened(spring.rows[1]!.at(-1), { now_ms: at("2026-04-01T12:00") });
    expect(opened.total).toMatchObject({ n: 1, sum: 30 });
  });
  it("W10b a clock sum in a place refused for size names the count that answers how long there: its days by run", () => {
    const refused = refusal(() => countOf(index, ask({ of: "calls", measure: "minutes", op: "sum", place: "United States", ...RANGE }), context({ budget: { fetch: 5 } })));
    expect(refused.code).toBe("TOO_BROAD");
    expect(refused.message).toContain("of=days with the same place, by=run");
    expect(refused.message).not.toContain("avg, min or max");
    expect(run({ of: "days", place: "United States", by: "run", ...RANGE }).rows).toHaveLength(2);
  });

  it("W11 Places' file attached to the read: an answer is of one version though Places publishes mid-answer; its row opened after counts by the next", () => {
    const file = join(dir, "publish.db");
    writePresenceFile(file, TABLES);
    const HOME = presenceTablesOf([stay(at("2025-12-20T00:00"), at("2026-01-12T00:00"), PARIS)], DAYS, LABELS, new Map(), SETTINGS, NOW, ALONE);
    const plain = presenceSource(file);
    let published = 0;
    const publishing: PresenceSource = {
      file,
      held: (version, load) => {
        const held = plain.held(version, load);
        if (published++ === 0) writePresenceFile(file, HOME, "2");
        return held;
      },
    };
    const trip = run({ of: "days", place: "New York", by: "run", ...RANGE }, { presence: publishing });
    expect(published).toBeGreaterThan(0);
    expect(trip.rows.map((row) => row.slice(0, 4))).toEqual([["2025-12-28", "2026-01-03", 7, 0]]);
    expect(trip.total).toMatchObject({ n: 7 });
    expect(run({ of: "days", place: "New York", ...RANGE }, { presence: plain }).total).toMatchObject({ n: 0 });
    expect(rowOpened(trip.rows[0]!.at(-1), { presence: plain }).total).toMatchObject({ n: 0 });
    expect(column(run({ of: "calls", by: "item", order: "time", ...RANGE }, { presence: plain }), "time")[1]).toBe("2025-12-30T05:30+01:00");
  });

  it("W12 two instruments' nights by run: each instrument's own runs, each day once in each, each ref its own facts", () => {
    const runs = run({ of: "days", measure: "asleep_min", op: "avg", by: "run", from: "2026-01-04", to: "2026-01-10" });
    const at = (name: string) => runs.columns.indexOf(name);
    expect(runs.rows.map((row) => [row[at("from_day")], row[at("to_day")], row[at("days")], row[at("instrument")], row[at("n")], row[at("avg")]])).toEqual([
      ["2026-01-05", "2026-01-07", 3, "Watch", 3, 410],
      ["2026-01-06", "2026-01-07", 2, "Ring", 2, 455],
      ["2026-01-09", "2026-01-09", 1, "Ring", 1, 470],
    ]);
    const opened = runs.rows.map((row) => rowOpened(row.at(-1)));
    expect(opened.map((each) => each.rows.map((row) => [row[0], row[each.columns.indexOf("instrument")]]))).toEqual([
      [["2026-01-05", "Watch"], ["2026-01-06", "Watch"], ["2026-01-07", "Watch"]],
      [["2026-01-06", "Ring"], ["2026-01-07", "Ring"]],
      [["2026-01-09", "Ring"]],
    ]);
  });

  it("W13 a range given by home day over a New York week from a Paris home says abroad: the zone and the instants of the local days", () => {
    const week = run({ of: "calls", from: "2025-12-29", to: "2026-01-02" }) as Answer & { abroad?: Record<string, string>[] };
    expect(week.abroad).toEqual([{ zone: "America/New_York", days: "2025-12-29 → 2026-01-02", from: "2025-12-29T00:00-05:00", to: "2026-01-03T00:00-05:00" }]);
    expect(run({ of: "calls", from: week.abroad![0]!.from!, to: week.abroad![0]!.to! }).total).toMatchObject({ n: 1 });
    expect(run({ of: "calls", by: "day", from: "2025-12-29", to: "2025-12-29" }).total).toMatchObject({ n: 0 });
    expect((run({ of: "days", ...RANGE }) as { abroad?: unknown }).abroad).toEqual([expect.objectContaining({ zone: "America/New_York", days: "2025-12-28 → 2026-01-03" })]);
    expect((run({ of: "days", from: "2026-01-05", to: "2026-01-11" }) as { abroad?: unknown }).abroad).toBeUndefined();
    expect((run({ of: "calls", from: "2025-12-29", to: "9999-12-31" }) as { abroad?: unknown }).abroad).toEqual([expect.objectContaining({ zone: "America/New_York", days: "2025-12-29 → 2026-01-03" })]);
    expect((run({ of: "calls", from: "2025-12-29T00:00-05:00", to: "2026-01-03T00:00-05:00" }) as { abroad?: unknown }).abroad).toBeUndefined();
  });
  it("W14 a count of days in a place, and a run of them, counts the place's own days, and says so with the first and the last", () => {
    const over = { presence: TRIP_PRESENCE, now_ms: at("2026-03-10T12:00") };
    const there = run({ of: "days", place: "New York", ...TRIP_RANGE }, over) as Answer & { days_there?: string };
    expect(there.total).toMatchObject({ n: 5 });
    expect(there.days_there).toBe("each day counted is the place's own civil day, as its clock keeps it (America/New_York): 2026-03-02 → 2026-03-06");
    const trips = run({ of: "days", place: "United States", by: "run", ...TRIP_RANGE }, over);
    expect(trips.rows.map((row) => row.slice(0, 6))).toEqual([["2026-03-02", "2026-03-06", 5, 1, "New York City", "United States"]]);
    expect((trips as { abroad?: unknown }).abroad).toEqual([expect.objectContaining({ zone: "America/New_York", days: "2026-03-02 → 2026-03-06" })]);
    expect(rowOpened(trips.rows[0]!.at(-1), over).rows.map((row) => row[0])).toEqual(["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06"]);
    const home = run({ of: "days", place: "Paris", ...TRIP_RANGE }, over) as Answer & { days_there?: string };
    expect(home.total).toMatchObject({ n: 5 });
    expect(home.days_there).toBeUndefined();
  });

  it("W15 a run of stays in a place is of the place's own days: the last evening's stay is on the trip's last day there", () => {
    const over = { presence: TRIP_PRESENCE, now_ms: at("2026-03-10T12:00") };
    const runs = run({ of: "stays", place: "New York", by: "run", ...TRIP_RANGE }, over);
    expect(runs.rows.map((row) => row.slice(0, 3))).toEqual([["2026-03-03", "2026-03-03", 1], ["2026-03-06", "2026-03-06", 1]]);
    expect(runs.total).toMatchObject({ n: 2 });
    expect(runs.rows.map((row) => rowOpened(row.at(-1), over).total)).toEqual([expect.objectContaining({ n: 1 }), expect.objectContaining({ n: 1 })]);
  });
  it("W17 a run takes every day a fact's span touches, and a fact begun before the range reaches into it", () => {
    const runs = run({ of: "workouts", by: "run", from: "2026-01-05", to: "2026-01-09" });
    expect(runs.rows.map((row) => row.slice(0, 3))).toEqual([["2026-01-06", "2026-01-08", 3]]);
    expect(runs.total).toMatchObject({ n: 1 });
    expect(run({ of: "workouts", by: "run", from: "2026-01-07", to: "2026-01-09" }).rows.map((row) => row.slice(0, 3))).toEqual([["2026-01-07", "2026-01-08", 2]]);
    expect(run({ of: "workouts", measure: "minutes", op: "sum", by: "day", from: "2026-01-07", to: "2026-01-09" }).rows.map((row) => row.slice(0, 3))).toEqual([["2026-01-07", 1, 1_440], ["2026-01-08", 1, 120]]);
  });

  it("W16 stays say what they are: time spent at a place, not where the person slept, a photo's stay near the place it names", () => {
    const words = "time the person spent at a place, as the day's timeline lays it; not where they slept or lodged (read the days or search for that); a stay seen only in a photo (how seen) was near the place it names";
    const over = { presence: TRIP_PRESENCE, now_ms: at("2026-03-10T12:00") };
    expect(run({ of: "stays", by: "item", ...TRIP_RANGE }, over).asked).toContain(words);
    const catalog = shown(countOf(index, ask({}), context(over))) as { catalog: Record<string, { about?: string }> };
    expect(catalog.catalog["stays"]!.about).toBe(words);
    expect(catalog.catalog["calls"]!.about).toBeUndefined();
  });
});
