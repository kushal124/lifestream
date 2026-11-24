import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { dayBounds, digest, openHomeFolder, type DaySettings, type ExtractRow, type Json, type SourceRow } from "@lifestreamprotocol/core";
import { providers } from "@lifestreamprotocol/connect";
import {
  buildLabels, calendarFamily, healthFamily, labelsFrom, physicalFamily, renderDay, tableUnits, type CalendarEvent, type DayDocument, type DayFileFact,
  type Piece, MESSAGES_COLLECTIONS, MONEY_COLLECTIONS,
} from "@lifestreamprotocol/families";
import { presenceTablesOf, restsOnIn } from "./places.js";

const ALONE = restsOnIn([], []);
import { Refusal } from "./refusal.js";
import { fedBy } from "./registry-home.js";
import { SearchIndex } from "./search-index.js";
import { FETCH_ROWS, Ledger, type CountContext } from "./counting.js";
import { Work } from "./work.js";
import { collectionsOf } from "./count.js";
import { presenceSource, writePresenceFile } from "./test/presence-file.js";
import { countAsked, rowOf, countOf, shown } from "./test/record-reads.js";


const MIN = 60_000;
const dir = mkdtempSync(join(tmpdir(), "lifestream-counting-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function indexOf(name: string, days: Record<string, { window: { start_ms: number; end_ms: number }; facts: DayFileFact[] }>, clock: DaySettings = { zone: "UTC", day_start_hour: 0 }): SearchIndex {
  const index = SearchIndex.write(openHomeFolder(dirname(join(dir, `${name}.db`))), join(dir, `${name}.db`), () => true, 0, clock);
  index.records([], [], { position: { seq: 1, statement: "s-1", reread: 0 } });
  for (const [day, { window, facts }] of Object.entries(days)) index.day(day, { inputs: `in-${day}`, mtime_us: 1, atoms: [], facts: { window, facts } });
  return index;
}

function presenceOf(name: string, settings: DaySettings, days: readonly string[]): ReturnType<typeof presenceSource> {
  const NEW_YORK = { latitude: 40.7128, longitude: -74.006 };
  const start_ms = Date.parse(`${days[0]}T00:00:00Z`) - 86_400_000, end_ms = Date.parse(`${days.at(-1)}T00:00:00Z`) + 2 * 86_400_000;
  const stay: Piece = { kind: "stay", level: "place", how: "observed", point: NEW_YORK, from: null, to: null, units: [`stay/location:local:iphone-aa01/${start_ms}`], start_ms, end_ms };
  writePresenceFile(join(dir, `${name}-places.db`), presenceTablesOf([stay], days, labelsFrom(() => undefined, settings), new Map(), settings, end_ms, ALONE));
  return presenceSource(join(dir, `${name}-places.db`));
}

const people = () => ({ version: "people-0", idOf: () => undefined, person: () => undefined, find: () => [] });
type Answer = { total: Record<string, unknown>; rows: unknown[][]; population: Record<string, unknown> };
const refusal = (work: () => unknown): Refusal => {
  try {
    work();
  } catch (error) {
    if (error instanceof Refusal) return error;
    throw error;
  }
  throw new Error("not refused");
};

describe("a fact across a day's edge, through the render", () => {
  const SETTINGS: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
  const OWNER = "person-a@example.com";
  const SOURCE = `google-calendar:${OWNER}:macbook-pro-0001`;
  const SOURCES: SourceRow[] = [{
    id: SOURCE, product: "google-calendar", vendor: "google", account: OWNER, copy: "macbook-pro-0001", connector: "google-calendar", options: {}, read_through_ms: null, added_ms: 0,
  }];
  const fed = fedBy(providers());
  const calendar = calendarFamily({ books: fed.labels })(fed.calendar);
  const at = (local: string) => Date.parse(`${local}-04:00`);
  const flight: CalendarEvent = {
    source: SOURCE, key: "flight", title: "Flight", date_only: false, zone: "America/New_York", status: "CONFIRMED", organizer: null, attendees: 0,
    response: null, video: false, location: null, repeats: null, start_ms: at("2026-10-01T23:00"), end_ms: at("2026-10-02T07:00"),
  };
  const row: ExtractRow = {
    family: calendar.name, unit: `${OWNER}/flight`, reading: digest(flight as Json), code: calendar.code, content: flight as Json,
    start_ms: flight.start_ms, end_ms: flight.end_ms, days: [], seq: 0,
  };
  const rows = [{ ...row, days: calendar.days(row, SETTINGS) }];
  const reader = { extractsOn: (_family: string, on: string) => rows.filter((each) => each.days.includes(on)), enrichment: () => undefined, sources: () => SOURCES, since: () => undefined };
  const rendered = (day: string) => JSON.parse(renderDay(day, [calendar], reader, SETTINGS, tableUnits(buildLabels({ people: [], contacts: [], places: [] }))).json) as DayDocument;
  const days = Object.fromEntries(["2026-10-01", "2026-10-02"].map((day) => [day, rendered(day)]));
  const index = indexOf("flight", Object.fromEntries(Object.entries(days).map(([day, document]) => [day, { window: document.window, facts: document.facts }])));
  afterAll(() => index.close());
  const COLLECTIONS = collectionsOf([calendar]);
  const context: CountContext = { collections: COLLECTIONS, settings: SETTINGS, now_ms: at("2026-10-05T12:00"), people };
  const run = (params: Record<string, string>) => shown(countOf(index, countAsked(params, COLLECTIONS), context)) as unknown as Answer;
  const sum = { of: "events", measure: "minutes", op: "sum" };

  it("C1 the day it began states it whole and the next nothing; summed from the next day 180, by day 300 and 180, from the first 300; counted once", () => {
    expect(rows[0]!.days).toEqual(["2026-10-01", "2026-10-02"]);
    expect(days["2026-10-01"]!.facts.map((fact) => [fact.of, fact.measures])).toEqual([["events", { minutes: 480 }]]);
    expect(days["2026-10-02"]!.facts).toEqual([]);
    expect(run({ ...sum, from: "2026-10-02", to: "2026-10-02" }).total).toMatchObject({ n: 1, sum: 180 });
    expect(run({ ...sum, from: "2026-10-01", to: "2026-10-02", by: "day" }).rows.map((each) => each.slice(0, 3))).toEqual([["2026-10-01", 1, 300], ["2026-10-02", 1, 180]]);
    expect(run({ ...sum, from: "2026-10-01", to: "2026-10-01" }).total).toMatchObject({ n: 1, sum: 300 });
    expect(run({ of: "events", from: "2026-10-01", to: "2026-10-02" }).total).toMatchObject({ n: 1 });
    expect(run({ of: "events", measure: "minutes", op: "avg", from: "2026-10-02", to: "2026-10-02" }).total).toMatchObject({ n: 0 });
    expect(run({ of: "events", measure: "minutes", op: "avg", from: "2026-10-01", to: "2026-10-01" }).total).toMatchObject({ n: 1, avg: 480 });
  });

  it("C2 from an hour inside the flight, its minutes after that hour; population and total are the same facts", () => {
    const after = run({ ...sum, from: "2026-10-02T05:00-04:00", to: "2026-10-02" });
    expect(after.total).toMatchObject({ n: 1, sum: 120 });
    expect(after.population).toMatchObject({ facts: 1, valued: 1, missing: 0 });
    expect(run({ ...sum, from: "2026-10-01T22:00-04:00", to: "2026-10-02T00:00-04:00" }).total).toMatchObject({ n: 1, sum: 60 });
  });
});

describe("the calendar of days", () => {
  const SETTINGS: DaySettings = { zone: "UTC", day_start_hour: 0 };
  const D = (day: string) => Date.parse(`${day}T00:00:00Z`);
  const health = healthFamily([]);
  const COLLECTIONS = new Map(Object.entries(health.collections!));
  const night = (day: string, instrument: string, asleep_min: number): DayFileFact => ({
    id: `days:${`${day}${instrument}`.replace(/\W/gu, "").padStart(24, "0")}`, family: "health", of: "days", time_ms: D(day), start_ms: D(day), end_ms: D(day), date_only: true,
    keys: { instrument }, measures: { asleep_min }, who: [], from: { units: [`health/${day}`], instrument }, lines: [],
  });
  const days = Array.from({ length: 7 }, (_, at) => `2026-10-0${at + 1}`);
  const index = indexOf("calendar", Object.fromEntries(days.map((day) => [day, {
    window: { start_ms: D(day), end_ms: D(day) + 86_400_000 }, facts: day === "2026-10-04" ? [night(day, "Watch", 420), night(day, "Ring", 450)] : [],
  }])));
  afterAll(() => index.close());
  const context: CountContext = { collections: COLLECTIONS, settings: SETTINGS, now_ms: D("2026-10-10"), people };
  const run = (params: Record<string, string>) => shown(countOf(index, countAsked(params, COLLECTIONS), context)) as unknown as Answer;

  it("C3 seven days with two instruments on one are seven days; each instrument's nights are its own, the days it states nothing missing", () => {
    expect(run({ of: "days", from: "2026-10-01", to: "2026-10-07" }).total).toMatchObject({ n: 7 });
    const asleep = run({ of: "days", measure: "asleep_min", op: "avg", from: "2026-10-01", to: "2026-10-07" });
    expect(asleep.population).toMatchObject({ by: [
      expect.objectContaining({ instrument: "Ring", facts: 7, valued: 1, missing: 6 }), expect.objectContaining({ instrument: "Watch", facts: 7, valued: 1, missing: 6 }),
    ] });
    expect(run({ of: "days", by: "item", from: "2026-10-01", to: "2026-10-07" }).rows).toHaveLength(8);
  });

  it("C10 each day of the calendar is a row of the meter: seven days past a budget of four are TOO_BROAD, their fits the newest days, which answer", () => {
    const asked = { of: "days", from: "2026-10-01", to: "2026-10-07" };
    const small: CountContext = { ...context, budget: { fetch: 4 } };
    const refused = refusal(() => countOf(index, countAsked(asked, COLLECTIONS), small));
    expect(refused.code).toBe("TOO_BROAD");
    const fits = (refused.extra as { fits?: { from: string; to: string } }).fits!;
    expect(fits.to).toBe("2026-10-07");
    expect(fits.from > "2026-10-01").toBe(true);
    const over = shown(countOf(index, countAsked({ ...asked, ...fits }, COLLECTIONS), small)) as unknown as Answer;
    expect(over.total).toMatchObject({ n: days.filter((day) => day >= fits.from).length });
  });
  it("C14 the catalog says each days measure's days from one walk of the facts; a walk past the budget says none of them, and answers", () => {
    type Catalog = { catalog: Record<string, { measures: Record<string, { held?: string }> }> };
    const catalog = (budget?: number) => (shown(countOf(index, countAsked({}, COLLECTIONS), budget === undefined ? context : { ...context, budget: { fetch: budget } })) as unknown as Catalog).catalog.days!.measures;
    const measures = catalog();
    expect(measures.asleep_min!.held).toBe("2026-10-04 → 2026-10-04, 1 of 1 days");
    expect(measures.recovery!.held).toBe("none");
    expect(Object.values(catalog(3)).every((measure) => measure.held === undefined)).toBe(true);
  });
});

describe("a stay begun before the range", () => {
  const SETTINGS: DaySettings = { zone: "UTC", day_start_hour: 0 };
  const D = (day: string, time = "00:00") => Date.parse(`${day}T${time}:00Z`);
  const COLLECTIONS = new Map(Object.entries(physicalFamily({ photos: [] })([]).collections!));
  const stay = (key: string, place: string, start: number, end: number): DayFileFact => ({
    id: `stays:${key.padStart(24, "0")}`, family: "physical", of: "stays", time_ms: start, start_ms: start, end_ms: end,
    keys: { place, city: "Sample City", country: "Sample Country", how: "observed" }, measures: { minutes: (end - start) / MIN }, who: [], from: { units: [`stay/${key}`], instrument: "Phone" }, lines: [],
  });
  const long = stay("long", "Place Longstay", D("2026-10-01", "12:00"), D("2026-10-29", "12:00"));
  const short = stay("short", "Place Other", D("2026-10-10", "09:00"), D("2026-10-10", "10:00"));
  const window = (day: string) => ({ start_ms: D(day), end_ms: D(day) + 86_400_000 });
  const index = indexOf("stays", Object.fromEntries(Array.from({ length: 31 }, (_, at) => {
    const day = `2026-10-${String(at + 1).padStart(2, "0")}`;
    return [day, { window: window(day), facts: day === "2026-10-01" ? [long] : day === "2026-10-10" ? [short] : [] }];
  })));
  afterAll(() => index.close());
  const context: CountContext = { collections: COLLECTIONS, settings: SETTINGS, now_ms: D("2026-11-05"), people };
  const run = (params: Record<string, string>) => shown(countOf(index, countAsked(params, COLLECTIONS), context)) as unknown as Answer;

  it("C4 a sum of minutes inside a four-week stay counts the minutes of the range it overlaps, each day its own share", () => {
    const asked = { of: "stays", measure: "minutes", op: "sum", by: "day", "match.place": "Longstay", from: "2026-10-08", to: "2026-10-14" };
    const answer = run(asked);
    expect(answer.total).toMatchObject({ n: 1, sum: 7 * 1_440 });
    expect(answer.rows.map((each) => each.slice(0, 3))).toEqual(Array.from({ length: 7 }, (_, at) => [`2026-10-${String(8 + at).padStart(2, "0")}`, 1, 1_440]));
    expect(run({ of: "stays", measure: "minutes", op: "sum", "match.place": "Longstay", from: "2026-10-20", to: "2026-10-31" }).total).toMatchObject({ n: 1, sum: 9 * 1_440 + 720 });
  });
});

describe("a night in New York from a UTC home, by run", () => {
  const SETTINGS: DaySettings = { zone: "UTC", day_start_hour: 0 };
  const ny = (local: string) => Date.parse(`${local}-04:00`);
  const DAYS = ["2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03"];
  const presence = presenceOf("night", SETTINGS, DAYS);
  const start = ny("2026-10-01T23:00"), end = ny("2026-10-02T07:00");
  const night: DayFileFact = {
    id: `stays:${"night".padStart(24, "0")}`, family: "physical", of: "stays", time_ms: start, start_ms: start, end_ms: end,
    keys: { place: "Place Hotel", city: "New York City", country: "United States", how: "observed" }, measures: { minutes: (end - start) / MIN }, who: [], from: { units: ["stay/night"], instrument: "Phone" }, lines: [],
  };
  const window = (day: string) => ({ start_ms: Date.parse(`${day}T00:00:00Z`), end_ms: Date.parse(`${day}T00:00:00Z`) + 86_400_000 });
  const index = indexOf("night", Object.fromEntries(DAYS.map((day) => [day, { window: window(day), facts: day === "2026-10-02" ? [night] : [] }])));
  afterAll(() => index.close());
  const COLLECTIONS = new Map(Object.entries(physicalFamily({ photos: [] })([]).collections!));
  const context: CountContext = { collections: COLLECTIONS, settings: SETTINGS, now_ms: Date.parse("2026-10-05T12:00:00Z"), people, presence };
  const run = (params: Record<string, string>) => shown(countOf(index, countAsked(params, COLLECTIONS), context)) as unknown as Answer;

  it("C5 a run of days in a place is the place's days whatever the measure: two of New York's days counted, and summed", () => {
    const asked = { of: "stays", place: "New York", by: "run", from: "2026-10-01", to: "2026-10-02" };
    expect(run(asked).rows.map((row) => row.slice(0, 3))).toEqual([["2026-10-01", "2026-10-02", 2]]);
    const summed = run({ ...asked, measure: "minutes", op: "sum" });
    expect(summed.rows.map((row) => row.slice(0, 3))).toEqual([["2026-10-01", "2026-10-02", 2]]);
    expect(summed.total).toMatchObject({ n: 1, sum: 480 });
  });
});

describe("a fact timed at its end, begun before the range", () => {
  const SETTINGS: DaySettings = { zone: "UTC", day_start_hour: 0 };
  const D = (day: string, time = "00:00") => Date.parse(`${day}T${time}:00Z`);
  const COLLECTIONS = new Map(Object.entries(physicalFamily({ photos: [] })([]).collections!));
  const start = D("2026-09-30", "23:00"), end = D("2026-10-03", "12:00");
  const long: DayFileFact = {
    id: `stays:${"ended".padStart(24, "0")}`, family: "physical", of: "stays", time_ms: end, start_ms: start, end_ms: end,
    keys: { place: "Place Longstay", city: "Sample City", country: "Sample Country", how: "observed" }, measures: { minutes: (end - start) / MIN }, who: [], from: { units: ["stay/ended"], instrument: "Phone" }, lines: [],
  };
  const DAYS = ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"];
  const index = indexOf("ended", Object.fromEntries(DAYS.map((day) => [day, { window: { start_ms: D(day), end_ms: D(day) + 86_400_000 }, facts: day === "2026-10-03" ? [long] : [] }])));
  afterAll(() => index.close());
  const context: CountContext = { collections: COLLECTIONS, settings: SETTINGS, now_ms: D("2026-10-05"), people, presence: presenceOf("ended", SETTINGS, DAYS) };
  const run = (params: Record<string, string>) => shown(countOf(index, countAsked(params, COLLECTIONS), context)) as unknown as Answer;

  it("C6 its run is the days it touches inside the range, from the day it began: 1 to 2 Oct, never its own 3 Oct", () => {
    expect(run({ of: "stays", by: "run", from: "2026-10-01", to: "2026-10-02" }).rows.map((row) => row.slice(0, 3))).toEqual([["2026-10-01", "2026-10-02", 2]]);
    expect(run({ of: "stays", by: "run", from: "2026-09-29", to: "2026-10-04" }).rows.map((row) => row.slice(0, 3))).toEqual([["2026-09-30", "2026-10-03", 4]]);
  });

  it("C8 a clock sum and a run to the calendar's last day answer", () => {
    expect(run({ of: "stays", measure: "minutes", op: "sum", from: "2026-10-01", to: "9999-12-31" }).total).toMatchObject({ n: 1, sum: (end - D("2026-10-01")) / MIN });
    expect(run({ of: "stays", by: "run", from: "2026-10-01", to: "9999-12-31" }).rows.map((row) => row.slice(0, 3))).toEqual([["2026-10-01", "2026-10-03", 3]]);
  });
});

describe("workouts of a whole span across New York's spring change", () => {
  const SETTINGS: DaySettings = { zone: "America/New_York", day_start_hour: 0 };
  const COLLECTIONS = new Map(Object.entries(healthFamily([]).collections!));
  const start = Date.parse("2026-03-07T23:30:00-05:00"), end = Date.parse("2026-03-09T00:30:00-04:00");
  const workout = (at: number): DayFileFact => ({
    id: `workouts:${`w${at}`.padStart(24, "0")}`, family: "health", of: "workouts", time_ms: start, start_ms: start, end_ms: end,
    keys: { sport: "rowing", instrument: "Watch" }, measures: { minutes: 24 * 60 }, who: [], from: { units: [`health/w${at}`], instrument: "Watch" }, lines: [],
  });
  const local = (day: string) => ({ start_ms: Date.parse(`${day}T00:00:00-05:00`), end_ms: Date.parse(`${day}T00:00:00-05:00`) + 86_400_000 });
  const DAYS = ["2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10", "2026-03-11"];
  const index = indexOf("spring", Object.fromEntries(DAYS.map((day) => [day, { window: local(day), facts: day === "2026-03-07" ? Array.from({ length: 20 }, (_, at) => workout(at)) : [] }])));
  afterAll(() => index.close());
  const presence = presenceOf("spring", SETTINGS, DAYS);
  const context = (rows: number): CountContext => ({ collections: COLLECTIONS, settings: SETTINGS, now_ms: Date.parse("2026-03-20T12:00:00-04:00"), people, presence, budget: { fetch: rows } });
  const run = (params: Record<string, string>, rows = 100_000) => shown(countOf(index, countAsked(params, COLLECTIONS), context(rows))) as unknown as Answer;
  const asked = { of: "workouts", by: "run", from: "2026-03-09", to: "2026-03-09" };

  it("C7 a run of 9 March reads the twenty workouts its window holds, on 7 March: past a small budget, refused, and no day fits", () => {
    const answered = run(asked);
    expect(answered.rows.map((row) => row.slice(0, 3))).toEqual([["2026-03-09", "2026-03-09", 1]]);
    expect(answered.total).toMatchObject({ n: 20 });
    const refused = refusal(() => run(asked, 10));
    expect(refused.code).toBe("TOO_BROAD");
    expect(refused.extra).toEqual({});
  });

  it("C8 a run and a clock sum to the calendar's last day answer in a zone west of UTC", () => {
    expect(run({ ...asked, to: "9999-12-31" }).rows.map((row) => row.slice(0, 3))).toEqual([["2026-03-09", "2026-03-09", 1]]);
    expect(run({ of: "workouts", measure: "minutes", op: "sum", from: "2026-03-09", to: "9999-12-31" }).total).toMatchObject({ n: 20, sum: 20 * 30 });
  });
});

describe("two instruments' steps on one day, through the render", () => {
  const SETTINGS: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
  const PROVIDER = "apple-health:person-a@example.com:cloud";
  const SOURCES: SourceRow[] = [{
    id: PROVIDER, product: "apple-health", vendor: "apple", account: "person-a@example.com", copy: "cloud", connector: "apple-health", options: {}, read_through_ms: null, added_ms: 0,
  }];
  const fed = fedBy(providers());
  const health = healthFamily(fed.health);
  const at = (local: string) => Date.parse(`${local}-04:00`);
  const steps = (instrument: string, local: string, count: number): ExtractRow => {
    const start_ms = at(local);
    const content = { kind: "span", source: PROVIDER, start_ms, end_ms: start_ms + 15 * MIN, own: false, lanes: [{ metric: "steps", instrument, unit: "count", count: 1, sum: count, min: count, max: count }] };
    const row: ExtractRow = { family: health.name, unit: `span/${PROVIDER}/${instrument}/${start_ms}`, reading: digest(content), code: health.code, content, start_ms, end_ms: content.end_ms, days: [], seq: 0 };
    return { ...row, days: health.days(row, SETTINGS) };
  };
  const rows = [steps("Watch", "2026-10-01T09:00", 4_000), steps("Watch", "2026-10-01T15:00", 3_000), steps("iPhone", "2026-10-01T09:00", 6_000)];
  const reader = { extractsOn: (_family: string, on: string) => rows.filter((each) => each.days.includes(on)), enrichment: () => undefined, sources: () => SOURCES, since: () => undefined };
  const document = JSON.parse(renderDay("2026-10-01", [health], reader, SETTINGS, tableUnits(buildLabels({ people: [], contacts: [], places: [] }))).json) as DayDocument;
  const index = indexOf("steps", { "2026-10-01": { window: document.window, facts: document.facts } }, SETTINGS);
  afterAll(() => index.close());
  const COLLECTIONS = collectionsOf([health]);
  const context: CountContext = { collections: COLLECTIONS, settings: SETTINGS, now_ms: at("2026-10-05T12:00"), people };
  const run = (params: Record<string, string>) => shown(countOf(index, countAsked(params, COLLECTIONS), context)) as unknown as Answer;

  it("C9 the day's steps are the largest instrument's total, once: 7,000, never 13,000 or 6,000", () => {
    expect(document.facts.filter((fact) => fact.of === "days" && fact.measures.steps !== undefined).map((fact) => fact.measures.steps)).toEqual([7_000]);
    const summed = run({ of: "days", measure: "steps", op: "sum", from: "2026-10-01", to: "2026-10-01" });
    expect(summed.total).toMatchObject({ n: 1, sum: 7_000 });
    expect(summed.population).toMatchObject({ facts: 1, valued: 1, missing: 0 });
  });
});

describe("one person's messages on a home past the budget", () => {
  const SETTINGS: DaySettings = { zone: "UTC", day_start_hour: 0 };
  const D = (day: string, time = "00:00") => Date.parse(`${day}T${time}:00Z`);
  const ADA = "+15550000001", RAJ = "+15550000002";
  const COLLECTIONS = new Map(Object.entries(MESSAGES_COLLECTIONS));
  const persons: Record<string, { name: string; handles: string[] }> = { "person:ada": { name: "Ada Example", handles: [ADA] }, "person:raj": { name: "Raj Example", handles: [RAJ] } };
  const map = () => ({
    version: "people-1", person: (id: string) => persons[id],
    idOf: (id: string) => (persons[id] !== undefined ? id : Object.entries(persons).find(([, person]) => person.handles.includes(id))?.[0]),
    find: (name: string) => Object.keys(persons).filter((id) => persons[id]!.name.toLowerCase().includes(name.toLowerCase())),
  });
  const message = (key: string, at: number, handle: string): DayFileFact => ({
    id: `messages:${key.padStart(24, "0")}`, family: "messages", of: "messages", time_ms: at, start_ms: at, end_ms: at,
    keys: { chat: `whatsapp:${handle.slice(1)}@s.whatsapp.net`, direction: "received", product: "whatsapp", searchable: "yes" }, measures: {},
    who: [{ handle, role: "sender" }], from: { units: [`messages/${key}`], record: { source: "wa:local:a", kind: "msg", key }, alone: true }, lines: [],
  });
  const days = Array.from({ length: 20 }, (_, at) => `2026-10-${String(at + 1).padStart(2, "0")}`);
  const index = indexOf("past-budget", Object.fromEntries(days.map((day) => [day, {
    window: { start_ms: D(day), end_ms: D(day) + 86_400_000 },
    facts: [message(`ada${day}`, D(day, "12:00"), ADA), ...Array.from({ length: 30 }, (_, at) => message(`raj${day}${at}`, D(day) + at * 40 * MIN + MIN, RAJ))],
  }])));
  afterAll(() => index.close());
  const context: CountContext = { collections: COLLECTIONS, settings: SETTINGS, now_ms: D("2026-10-25"), people: map, budget: { fetch: 100 } };
  const run = (params: Record<string, string>) => shown(countOf(index, countAsked(params, COLLECTIONS), context)) as unknown as Answer;
  const refused = (params: Record<string, string>) => refusal(() => countOf(index, countAsked(params, COLLECTIONS), context));
  const opened = (ref: unknown) => shown(rowOf(index, String(ref), context)) as unknown as Answer;

  it("C11 their count over a life answers, and so do their facts (by item): one walk of their crew, never the collection's", () => {
    expect(run({ of: "messages", person: ADA }).total).toMatchObject({ n: 20 });
    const items = run({ of: "messages", person: ADA, by: "item", limit: "50" });
    expect(items.rows).toHaveLength(20);
    expect(JSON.stringify(items.rows)).not.toContain("Raj");
    expect(refused({ of: "messages", by: "item" }).code).toBe("TOO_BROAD");
  });

  it("C12 a range inside days: theirs by their crew's walk; everyone's past the budget, refused with whole days the tallies answer", () => {
    const range = { from: "2026-10-05T13:00:00Z", to: "2026-10-15T11:00:00Z" };
    expect(run({ of: "messages", person: ADA, ...range }).total).toMatchObject({ n: 9 });
    const everyone = refused({ of: "messages", ...range });
    expect(everyone.code).toBe("TOO_BROAD");
    const fits = (everyone.extra as { fits: { from: string; to: string } }).fits;
    expect(fits.from).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(fits.to).toBe("2026-10-14");
    expect(run({ of: "messages", ...fits }).total).toMatchObject({ n: 31 * (Date.parse(fits.to) - Date.parse(fits.from) + 86_400_000) / 86_400_000 });
  });

  it("C15 a count by person or by chat over a life answers, and the row of one person or one chat opens: its facts alone, every one it counted", () => {
    const byPerson = run({ of: "messages", by: "person", limit: "50" });
    expect(byPerson.rows.map((row) => [row[0], row[1]])).toEqual([["Raj Example", 600], ["Ada Example", 20]]);
    const ada = opened(byPerson.rows[1]!.at(-1));
    expect(ada.rows).toHaveLength(20);
    expect(JSON.stringify(ada.rows)).not.toContain("Raj");
    const byChat = run({ of: "messages", by: "chat", limit: "50" });
    const adaChat = byChat.rows.find((row) => JSON.stringify(row[0]).includes(ADA.slice(1)))!;
    expect(adaChat[1]).toBe(20);
    const hers = opened(adaChat.at(-1));
    expect(hers.rows).toHaveLength(20);
    expect(JSON.stringify(hers.rows)).not.toContain("Raj");
    expect(refusal(() => rowOf(index, String(byPerson.rows[0]!.at(-1)), context)).code).toBe("TOO_BROAD");
  });
});

describe("a year of messages on a home past the budget, by month", () => {
  const SETTINGS: DaySettings = { zone: "UTC", day_start_hour: 0 };
  const D = (day: string, time = "00:00") => Date.parse(`${day}T${time}:00Z`);
  const COLLECTIONS = new Map(Object.entries(MESSAGES_COLLECTIONS));
  const message = (key: string, at: number): DayFileFact => ({
    id: `messages:${key.padStart(24, "0")}`, family: "messages", of: "messages", time_ms: at, start_ms: at, end_ms: at,
    keys: { chat: "whatsapp:15550000003@s.whatsapp.net", direction: "received", product: "whatsapp", searchable: "yes" }, measures: {},
    who: [{ handle: "+15550000003", role: "sender" }], from: { units: [`messages/${key}`], record: { source: "wa:local:a", kind: "msg", key }, alone: true }, lines: [],
  });
  const days = Array.from({ length: 12 }, (_, at) => {
    const first = `2025-${String(at + 1).padStart(2, "0")}-01`;
    return [first, new Date(Date.UTC(2025, at + 1, 0)).toISOString().slice(0, 10)];
  }).flat();
  const index = indexOf("past-budget-months", Object.fromEntries(days.map((day) => [day, {
    window: { start_ms: D(day), end_ms: D(day) + 86_400_000 },
    facts: Array.from({ length: 40 }, (_, at) => message(`m${day}${at}`, D(day) + at * 30 * MIN)),
  }])));
  afterAll(() => index.close());
  const context: CountContext = { collections: COLLECTIONS, settings: SETTINGS, now_ms: D("2026-01-15"), people, budget: { fetch: 100 } };
  const run = (params: Record<string, string>) => shown(countOf(index, countAsked(params, COLLECTIONS), context)) as unknown as Answer;

  it("C15 a count by month over a life answers, and each month's row opens: its own days' facts, the edges of the months beside it unread (80 of them would pass the budget)", () => {
    const byMonth = run({ of: "messages", by: "month", limit: "100" });
    expect(byMonth.rows).toHaveLength(12);
    for (const row of byMonth.rows) {
      expect(row[1]).toBe(80);
      const opened = shown(rowOf(index, String(row.at(-1)), context)) as unknown as Answer;
      expect(opened.total, String(row[0])).toMatchObject({ n: 80 });
    }
  });
});

describe("a payment with only a date, under a clock whose days start at 04:00 in India", () => {
  const SETTINGS: DaySettings = { zone: "Asia/Kolkata", day_start_hour: 4 };
  const COLLECTIONS = new Map(Object.entries(MONEY_COLLECTIONS));
  const A = "2026-10-02";
  const midnight = Date.parse(`${A}T00:00:00Z`);
  const payment: DayFileFact = {
    id: `payments:${"p1".padStart(24, "0")}`, family: "money", of: "payments", time_ms: midnight, start_ms: midnight, end_ms: midnight, date_only: true,
    keys: { payee: "CORNER BAKERY", direction: "debit", currency: "EUR" }, measures: { amount: "4.50" }, who: [],
    from: { units: ["money/p1"], record: { source: "bank:acct:a", kind: "payment", key: "p1" }, alone: true }, lines: [],
  };
  const index = indexOf("dated", { [A]: { window: dayBounds(A, SETTINGS), facts: [payment] } }, SETTINGS);
  afterAll(() => index.close());
  const context: CountContext = { collections: COLLECTIONS, settings: SETTINGS, now_ms: Date.parse("2026-10-10T12:00:00Z"), people };
  const run = (params: Record<string, string>) => shown(countOf(index, countAsked(params, COLLECTIONS), context)) as unknown as Answer;

  it("C13 it is of its day, counted by its day's start: a range of its day holds it, one starting inside its day or ending before it none", () => {
    const { start_ms, end_ms } = dayBounds(A, SETTINGS);
    expect(run({ of: "payments", from: A, to: A }).total).toMatchObject({ n: 1 });
    expect(run({ of: "payments", from: new Date(start_ms + 60 * MIN).toISOString(), to: new Date(end_ms).toISOString() }).total).toMatchObject({ n: 0 });
    expect(run({ of: "payments", from: new Date(start_ms - 60 * MIN).toISOString(), to: new Date(start_ms).toISOString() }).total).toMatchObject({ n: 0 });
    expect(run({ of: "payments", from: new Date(start_ms).toISOString(), to: new Date(start_ms + 60 * MIN).toISOString() }).total).toMatchObject({ n: 1 });
    expect(run({ of: "payments", measure: "amount", op: "sum", by: "day", from: "2026-10-01", to: "2026-10-03" }).rows).toEqual([expect.arrayContaining([A])]);
  });
});

describe("payments of a month on a home past the budget, first and last", () => {
  const SETTINGS: DaySettings = { zone: "UTC", day_start_hour: 0 };
  const D = (day: string, time = "00:00") => Date.parse(`${day}T${time}:00Z`);
  const COLLECTIONS = new Map(Object.entries(MONEY_COLLECTIONS));
  const payment = (key: string, at: number, amount?: string): DayFileFact => ({
    id: `payments:${key.padStart(24, "0")}`, family: "money", of: "payments", time_ms: at, start_ms: at, end_ms: at,
    keys: { payee: `PAYEE ${key.toUpperCase()}`, direction: "debit", currency: "EUR" }, measures: amount === undefined ? {} : { amount }, who: [],
    from: { units: [`money/${key}`], record: { source: "bank:acct:a", kind: "payment", key }, alone: true }, lines: [],
  });
  const days = Array.from({ length: 30 }, (_, at) => `2026-09-${String(at + 1).padStart(2, "0")}`);
  const factsOf = (day: string): DayFileFact[] => {
    if (day === days[0]) return [payment("a0", D(day, "07:00")), payment("a1", D(day, "08:00"), "11.00"), payment("a2", D(day, "08:00"), "12.00"), ...Array.from({ length: 7 }, (_, at) => payment(`a${day}${at}`, D(day, `1${at}:00`), "1.00"))];
    if (day === days.at(-1)) return [...Array.from({ length: 7 }, (_, at) => payment(`z${day}${at}`, D(day, `1${at}:00`), "1.00")), payment("z1", D(day, "20:00"), "21.00"), payment("z2", D(day, "20:00"), "22.00"), payment("z0", D(day, "21:00"))];
    return Array.from({ length: 10 }, (_, at) => payment(`p${day}${at}`, D(day, `1${at}:00`), "2.00"));
  };
  const index = indexOf("past-budget-payments", Object.fromEntries(days.map((day) => [day, { window: { start_ms: D(day), end_ms: D(day) + 86_400_000 }, facts: factsOf(day) }])));
  afterAll(() => index.close());
  const context: CountContext = { collections: COLLECTIONS, settings: SETTINGS, now_ms: D("2026-10-10"), people, budget: { fetch: 100 } };
  const run = (params: Record<string, string>) => shown(countOf(index, countAsked(params, COLLECTIONS), context)) as unknown as Answer;
  const refused = (params: Record<string, string>) => refusal(() => countOf(index, countAsked(params, COLLECTIONS), context));

  it("C16 the first payment ever and the last answer, no filter: the fact stating an amount nearest each end and its tie, and no count", () => {
    expect(refused({ of: "payments", measure: "amount", op: "sum" }).code).toBe("TOO_BROAD");
    for (const [op, tied] of [["first", ["PAYEE A1", "PAYEE A2"]], ["last", ["PAYEE Z1", "PAYEE Z2"]]] as const) {
      const answer = run({ of: "payments", measure: "amount", op });
      const [total] = answer.total as unknown as Record<string, unknown>[];
      expect(total, op).toMatchObject({ of: "EUR", [op]: op === "first" ? "11.00 EUR" : "21.00 EUR", tied: 2 });
      expect((total!.facts as { payee: string }[]).map((fact) => fact.payee).sort(), op).toEqual(tied);
      expect(total, op).not.toHaveProperty("n");
      expect(answer.population, op).toEqual({});
      expect(answer, op).not.toHaveProperty("counted");
    }
  });
});

describe("payments in two currencies on a home past the budget, first and last", () => {
  const SETTINGS: DaySettings = { zone: "UTC", day_start_hour: 0 };
  const D = (day: string, time = "00:00") => Date.parse(`${day}T${time}:00Z`);
  const COLLECTIONS = new Map(Object.entries(MONEY_COLLECTIONS));
  const EUR_HANDLE = "+15550000001", USD_HANDLE = "+15550000002";
  const persons: Record<string, { name: string; handles: string[] }> = { "person:ada": { name: "Ada Example", handles: [EUR_HANDLE, USD_HANDLE] } };
  const map = () => ({
    version: "people-1", person: (id: string) => persons[id],
    idOf: (id: string) => (persons[id] !== undefined ? id : Object.entries(persons).find(([, person]) => person.handles.includes(id))?.[0]),
    find: (name: string) => Object.keys(persons).filter((id) => persons[id]!.name.toLowerCase().includes(name.toLowerCase())),
  });
  const payment = (key: string, at: number, currency: "EUR" | "USD", amount?: string, payee = `PAYEE ${key.toUpperCase()}`): DayFileFact => ({
    id: `payments:${key.padStart(24, "0")}`, family: "money", of: "payments", time_ms: at, start_ms: at, end_ms: at,
    keys: { payee, direction: "debit", currency }, measures: amount === undefined ? {} : { amount },
    who: [{ handle: currency === "EUR" ? EUR_HANDLE : USD_HANDLE, role: "sender" }],
    from: { units: [`money/${key}`], record: { source: "bank:acct:a", kind: "payment", key }, alone: true }, lines: [],
  });
  const days = Array.from({ length: 30 }, (_, at) => `2026-09-${String(at + 1).padStart(2, "0")}`);
  const shop = (day: string, at: number) => payment(`s${day}${at}`, D(day, `1${at}:00`), "EUR", "2.00", `PAYEE R${at}`);
  const factsOf = (day: string): DayFileFact[] => {
    if (day === days[0]) return [payment("e0", D(day, "07:00"), "EUR"), payment("u1", D(day, "07:30"), "USD", "5.00"), payment("e1", D(day, "08:00"), "EUR", "11.00"), payment("e2", D(day, "08:00"), "EUR", "12.00"), ...Array.from({ length: 6 }, (_, at) => shop(day, at))];
    if (day === days[28]) return [payment("u9", D(day, "12:00"), "USD", "9.00"), ...Array.from({ length: 9 }, (_, at) => shop(day, at))];
    if (day === days.at(-1)) return [...Array.from({ length: 7 }, (_, at) => shop(day, at)), payment("z1", D(day, "20:00"), "EUR", "21.00"), payment("z2", D(day, "20:00"), "EUR", "22.00"), payment("z0", D(day, "21:00"), "EUR")];
    return Array.from({ length: 10 }, (_, at) => shop(day, at));
  };
  const index = indexOf("past-budget-currencies", Object.fromEntries(days.map((day) => [day, { window: { start_ms: D(day), end_ms: D(day) + 86_400_000 }, facts: factsOf(day) }])));
  afterAll(() => index.close());
  const context: CountContext = { collections: COLLECTIONS, settings: SETTINGS, now_ms: D("2026-10-10"), people: map, budget: { fetch: 100 } };
  const run = (params: Record<string, string>) => shown(countOf(index, countAsked(params, COLLECTIONS), context)) as unknown as Answer;
  const refused = (params: Record<string, string>) => refusal(() => countOf(index, countAsked(params, COLLECTIONS), context));
  const totalOf = (answer: Answer) => (answer.total as unknown as Record<string, unknown>[]).map((row) => ({
    of: row.of, first: row.first, last: row.last, tied: row.tied, payees: (row.facts as { payee: string }[]).map((fact) => fact.payee).sort(),
  }));

  it("C16 each currency's first and last is its own, past a payment stating no amount, and a filter keeping the same payments answers the same", () => {
    expect(refused({ of: "payments", measure: "amount", op: "sum" }).code).toBe("TOO_BROAD");
    const expected = {
      first: [
        { of: "EUR", first: "11.00 EUR", last: undefined, tied: 2, payees: ["PAYEE E1", "PAYEE E2"] },
        { of: "USD", first: "5.00 USD", last: undefined, tied: 1, payees: ["PAYEE U1"] },
      ],
      last: [
        { of: "EUR", first: undefined, last: "21.00 EUR", tied: 2, payees: ["PAYEE Z1", "PAYEE Z2"] },
        { of: "USD", first: undefined, last: "9.00 USD", tied: 1, payees: ["PAYEE U9"] },
      ],
    };
    for (const op of ["first", "last"] as const) {
      const whole = run({ of: "payments", measure: "amount", op });
      expect(totalOf(whole), op).toEqual(expected[op]);
      expect(whole.population, op).toEqual({});
      const theirs = run({ of: "payments", measure: "amount", op, person: EUR_HANDLE });
      expect(totalOf(theirs), `${op} of their payments`).toEqual(expected[op]);
      expect(theirs.population, op).toEqual({});
    }
  });

  it("C16 a currency the range does not hold is none of its partitions: a range of EUR alone past the budget, the USD payments outside it, answers after the first EUR and its tie, whoever's crews", () => {
    const range = { from: "2026-09-02", to: "2026-09-28" };
    expect(refused({ of: "payments", measure: "amount", op: "sum", ...range }).code).toBe("TOO_BROAD");
    const expected = {
      first: [{ of: "EUR", first: "2.00 EUR", last: undefined, tied: 1, payees: ["PAYEE R0"] }],
      last: [{ of: "EUR", first: undefined, last: "2.00 EUR", tied: 1, payees: ["PAYEE R9"] }],
    };
    for (const op of ["first", "last"] as const) {
      const whole = run({ of: "payments", measure: "amount", op, ...range });
      expect(totalOf(whole), op).toEqual(expected[op]);
      expect(whole.population, op).toEqual({});
      const theirs = run({ of: "payments", measure: "amount", op, person: EUR_HANDLE, ...range });
      expect(totalOf(theirs), `${op} of their payments`).toEqual(expected[op]);
    }
  });

  it("C16 a grouped first counts nothing: its population is {}", () => {
    const answer = run({ of: "payments", measure: "amount", op: "first", by: "day", from: "2026-09-01", to: "2026-09-02" });
    expect(answer.rows.length).toBeGreaterThan(0);
    expect(answer.population).toEqual({});
  });
});

describe.each([
  ["to ten payees every day of it", (day: string) => Array.from({ length: 10 }, (_, at) => ({ key: `o${day}${at}`, time: `1${at}:00`, payee: `PAYEE R${at}` }))],
  ["to one payee, all at one instant", (day: string) => (day === "2026-09-15" ? Array.from({ length: 270 }, (_, at) => ({ key: `o${at}`, time: "12:00", payee: "PAYEE R0" })) : [])],
] as const)("one person's first and last of a range where another's payments in a currency they did not use there are many, %s", (_layout, othersOn) => {
  const SETTINGS: DaySettings = { zone: "UTC", day_start_hour: 0 };
  const D = (day: string, time = "00:00") => Date.parse(`${day}T${time}:00Z`);
  const COLLECTIONS = new Map(Object.entries(MONEY_COLLECTIONS));
  const ADA = "+15550000001", OTHER = "+15550000003";
  const persons: Record<string, { name: string; handles: string[] }> = { "person:ada": { name: "Ada Example", handles: [ADA] } };
  const map = () => ({
    version: "people-1", person: (id: string) => persons[id],
    idOf: (id: string) => (persons[id] !== undefined ? id : Object.entries(persons).find(([, person]) => person.handles.includes(id))?.[0]),
    find: () => [],
  });
  const payment = (key: string, at: number, currency: "EUR" | "USD", handle: string, amount: string, payee = `PAYEE ${key.toUpperCase()}`): DayFileFact => ({
    id: `payments:${key.padStart(24, "0")}`, family: "money", of: "payments", time_ms: at, start_ms: at, end_ms: at,
    keys: { payee, direction: "debit", currency }, measures: { amount }, who: [{ handle, role: "sender" }],
    from: { units: [`money/${key}`], record: { source: "bank:acct:a", kind: "payment", key }, alone: true }, lines: [],
  });
  const days = Array.from({ length: 28 }, (_, at) => `2026-09-${String(at + 1).padStart(2, "0")}`);
  const factsOf = (day: string): DayFileFact[] => {
    if (day === days[0]) return [payment("u1", D(day, "09:00"), "USD", ADA, "5.00")];
    const others = othersOn(day).map(({ key, time, payee }) => payment(key, D(day, time), "USD", OTHER, "3.00", payee));
    if (day === days[1]) return [payment("e1", D(day, "08:00"), "EUR", ADA, "11.00"), ...others];
    if (day === days[14]) return [payment("e2", D(day, "08:00"), "EUR", ADA, "12.00"), ...others];
    if (day === days.at(-1)) return [payment("e3", D(day, "08:00"), "EUR", ADA, "13.00"), ...others];
    return others;
  };
  const index = indexOf(`crew-or-currency-${othersOn("2026-09-15").length}`, Object.fromEntries(days.map((day) => [day, { window: { start_ms: D(day), end_ms: D(day) + 86_400_000 }, facts: factsOf(day) }])));
  afterAll(() => index.close());
  const context: CountContext = { collections: COLLECTIONS, settings: SETTINGS, now_ms: D("2026-10-10"), people: map, budget: { fetch: 100 } };
  const run = (params: Record<string, string>) => shown(countOf(index, countAsked(params, COLLECTIONS), context)) as unknown as Answer;

  it("C16 asked whether Ada's crew holds USD in the range, the race reads her few payments, never the 270 of USD, however many share an instant: her EUR first and last answer", () => {
    const range = { from: "2026-09-02", to: "2026-09-28" };
    for (const [op, amount, payee] of [["first", "11.00 EUR", "PAYEE E1"], ["last", "13.00 EUR", "PAYEE E3"]] as const) {
      const answer = run({ of: "payments", measure: "amount", op, person: ADA, ...range });
      const total = (answer.total as unknown as Record<string, unknown>[]).map((row) => ({ of: row.of, at: row[op], payees: (row.facts as { payee: string }[]).map((fact) => fact.payee) }));
      expect(total, op).toEqual([{ of: "EUR", at: amount, payees: [payee] }]);
    }
  });
});

describe("a probe for a currency over a tie of five hundred of its payments", () => {
  const D = (day: string, time: string) => Date.parse(`${day}T${time}:00Z`);
  const payment = (key: string, at: number, currency: "EUR" | "USD", amount: string): DayFileFact => ({
    id: `payments:${key.padStart(24, "0")}`, family: "money", of: "payments", time_ms: at, start_ms: at, end_ms: at,
    keys: { payee: `PAYEE ${currency}`, direction: "debit", currency }, measures: { amount }, who: [{ handle: "+15550000001", role: "sender" }],
    from: { units: [`money/${key}`], record: { source: "bank:acct:a", kind: "payment", key }, alone: true }, lines: [],
  });
  const window = (day: string) => ({ start_ms: D(day, "00:00"), end_ms: D(day, "00:00") + 86_400_000 });
  const index = indexOf("probe-tie", {
    "2026-09-01": { window: window("2026-09-01"), facts: [payment("e1", D("2026-09-01", "08:00"), "EUR", "4.00")] },
    "2026-09-02": { window: window("2026-09-02"), facts: Array.from({ length: 500 }, (_, at) => payment(`u${at}`, D("2026-09-02", "12:00"), "USD", "6.00")) },
  });
  afterAll(() => index.close());

  it("C16 the unfiltered probe accepts the tie's first payment within a round's rows, never expanding the tie: the walk reads it as the answer", () => {
    let probed = 0;
    const found = index.snapshot({}, (record) => record.facts((read) => {
      const counted = {
        walk: <T,>(sql: string, params: readonly unknown[], limit: number, by?: Work) => {
          const rows = read.walk<T>(sql, params, limit, by);
          if (sql.includes("fact_combo")) probed += rows.rows.length;
          return rows;
        },
        point: <T,>(sql: string, params: readonly unknown[], by?: Work) => read.point<T>(sql, params, by),
      };
      const fetch = new Ledger(counted, new Work(FETCH_ROWS)).fetch(FETCH_ROWS, "oldest");
      return fetch.facts("payments", D("2026-09-01", "00:00"), D("2026-09-03", "00:00"), ["amount"], "all", {
        settles: (fact) => fetch.measure(fact, "amount") !== null, key: "currency", in: undefined, out: new Set(),
      });
    }));
    expect(found.length).toBe(501);
    expect(probed).toBeGreaterThan(0);
    expect(probed).toBeLessThanOrEqual(2);
  });
});

describe("a day start moved, the index under the new one holding day files rendered under the old", () => {
  const OLD: DaySettings = { zone: "UTC", day_start_hour: 0 };
  const SETTINGS: DaySettings = { zone: "UTC", day_start_hour: 4 };
  const COLLECTIONS = new Map(Object.entries(MONEY_COLLECTIONS));
  const ADA = "+15550000001";
  const persons: Record<string, { name: string; handles: string[] }> = { "person:ada": { name: "Ada Example", handles: [ADA] } };
  const map = () => ({ version: "people-1", person: (id: string) => persons[id], idOf: (id: string) => (id === ADA ? "person:ada" : persons[id] !== undefined ? id : undefined), find: () => [] });
  const payment = (key: string, at: number, currency: "EUR" | "USD", amount: string): DayFileFact => ({
    id: `payments:${key.padStart(24, "0")}`, family: "money", of: "payments", time_ms: at, start_ms: at, end_ms: at,
    keys: { payee: `PAYEE ${key.toUpperCase()}`, direction: "debit", currency }, measures: { amount }, who: [{ handle: ADA, role: "sender" }],
    from: { units: [`money/${key}`], record: { source: "bank:acct:a", kind: "payment", key }, alone: true }, lines: [],
  });
  const index = indexOf("clock-moved", {
    "2026-09-01": { window: dayBounds("2026-09-01", OLD), facts: [payment("e1", Date.parse("2026-09-01T12:00:00Z"), "EUR", "4.00")] },
    "2026-09-02": { window: dayBounds("2026-09-02", OLD), facts: [payment("u1", Date.parse("2026-09-02T02:00:00Z"), "USD", "6.00")] },
  }, SETTINGS);
  afterAll(() => index.close());
  const context: CountContext = { collections: COLLECTIONS, settings: SETTINGS, now_ms: Date.parse("2026-10-10T12:00:00Z"), people: map };
  const run = (params: Record<string, string>) => shown(countOf(index, countAsked(params, COLLECTIONS), context)) as unknown as Answer;

  it("C16 a first and a last of 1 Sep answer both currencies, the USD payment's tally kept on 2 Sep, whoever's crews", () => {
    const expected = [{ of: "EUR", amount: "4.00 EUR" }, { of: "USD", amount: "6.00 USD" }];
    for (const op of ["first", "last"] as const) {
      for (const person of [{}, { person: ADA }]) {
        const answer = run({ of: "payments", measure: "amount", op, from: "2026-09-01", to: "2026-09-01", ...person });
        const total = (answer.total as unknown as Record<string, unknown>[]).map((row) => ({ of: row.of, amount: row[op] }));
        expect(total, `${op} ${JSON.stringify(person)}`).toEqual(expected);
      }
    }
  });
});
