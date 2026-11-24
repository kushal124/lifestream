import { describe, expect, it } from "vitest";
import { dayBounds, type DaySettings } from "@lifestreamprotocol/core";
import { areasAt, at, dayOf, placeDaysOf, placeNamed, placeStretches, placeTermsOf, presenceOver, type PresenceAreaRow, type PresenceTables } from "./presence.js";
import { stretchesOf } from "./search-scan.js";


const H = 3_600_000;
const D = (day: string, hour = 0) => Date.parse(`${day}T00:00:00Z`) + hour * H;
const area = (id: number, city: string, country: string): PresenceAreaRow => ({ id, place: null, city, city_id: city.toLowerCase(), region: null, country, country_code: null, zone: "UTC" });
const PARIS = 0;
const LYON = 1;
const ROME = 2;
const TABLES: PresenceTables = {
  version: "v1",
  areas: [area(PARIS, "Paris", "France"), area(LYON, "Lyon", "France"), area(ROME, "Rome", "Italy")],
  pieces: [
    [D("2026-01-01", 0), D("2026-01-01", 8), PARIS, null, "UTC", ["location:local"]],
    [D("2026-01-01", 8), D("2026-01-01", 12), PARIS, null, "UTC", ["location:local"]],
    [D("2026-01-01", 12), D("2026-01-01", 14), null, null, null, []],
    [D("2026-01-01", 14), D("2026-01-01", 18), null, PARIS, "UTC", []],
    [D("2026-01-01", 18), D("2026-01-02", 6), LYON, ROME, "UTC", ["location:local"]],
    [D("2026-01-02", 6), D("2026-01-02", 20), ROME, null, "UTC", ["location:local"]],
  ],
  placed: [["2026-01-01", PARIS, false], ["2026-01-01", LYON, false], ["2026-01-02", ROME, false], ["2026-01-02", LYON, true], ["2026-01-03", PARIS, true]],
};
const WHERE = presenceOver(TABLES);
const CLOCK: DaySettings = { zone: "Asia/Kolkata", day_start_hour: 4 };
const S = (day: string) => dayBounds(day, CLOCK).start_ms;

describe("S1 a place's stretches of clock time", () => {
  it("joins the pieces in the place that meet, a piece only guessed there too, and leaves out one also in an area left out", () => {
    expect(placeStretches(WHERE, { in: [PARIS], out: [] }, CLOCK).clock).toEqual([[D("2026-01-01", 0), D("2026-01-01", 12)], [D("2026-01-01", 14), D("2026-01-01", 18)]]);
    expect(placeStretches(WHERE, { in: [LYON], out: [] }, CLOCK).clock).toEqual([[D("2026-01-01", 18), D("2026-01-02", 6)]]);
    expect(placeStretches(WHERE, { in: [LYON], out: [ROME] }, CLOCK).clock).toEqual([]);
    expect(placeStretches(WHERE, { in: [ROME, LYON], out: [] }, CLOCK).clock).toEqual([[D("2026-01-01", 18), D("2026-01-02", 20)]]);
  });

  it("keeps nothing of a place no piece and no day is in", () => {
    expect(placeStretches(presenceOver({ ...TABLES, areas: [...TABLES.areas, area(3, "Oslo", "Norway")] }), { in: [3], out: [] }, CLOCK)).toEqual({ clock: [], date: [] });
  });
});

describe("S2 a place's days, for an entry with only a date", () => {
  it("is each placed day's whole civil day on the home's clock, a day also in an area left out not one, two days that meet one", () => {
    expect(S("2026-01-01")).toBe(Date.parse("2025-12-31T22:30:00Z"));
    expect(placeStretches(WHERE, { in: [PARIS], out: [] }, CLOCK).date).toEqual([[S("2026-01-01"), S("2026-01-02")], [S("2026-01-03"), S("2026-01-04")]]);
    expect(placeStretches(WHERE, { in: [PARIS], out: [LYON] }, CLOCK).date).toEqual([[S("2026-01-03"), S("2026-01-04")]]);
    expect(placeStretches(WHERE, { in: [LYON], out: [] }, CLOCK).date).toEqual([[S("2026-01-01"), S("2026-01-03")]]);
  });
});

describe("S3 only areas left out", () => {
  it("keeps all time but theirs, from before every time to after it", () => {
    expect(placeStretches(WHERE, { out: [PARIS] }, CLOCK)).toEqual({
      clock: [[null, D("2026-01-01", 0)], [D("2026-01-01", 12), D("2026-01-01", 14)], [D("2026-01-01", 18), null]],
      date: [[null, S("2026-01-01")], [S("2026-01-02"), S("2026-01-03")], [S("2026-01-04"), null]],
    });
    expect(placeStretches(WHERE, { out: [ROME] }, CLOCK).clock).toEqual([[null, D("2026-01-01", 18)], [D("2026-01-02", 20), null]]);
    expect(placeStretches(WHERE, { out: [] }, CLOCK)).toEqual({ clock: [[null, null]], date: [[null, null]] });
  });
});

describe("S4 the stretches a scan walks", () => {
  it("are the line cut where either kind's stretches begin or end, each piece with the kinds kept there, inside the range", () => {
    const clock = [[100, 200], [300, 400]] as const;
    const date = [[150, 160], [400, 410], [500, 510]] as const;
    expect(stretchesOf(clock, date, 0, 1_000)).toEqual([
      { from: 100, to: 150, clock: true, date: false },
      { from: 150, to: 160, clock: true, date: true },
      { from: 160, to: 200, clock: true, date: false },
      { from: 300, to: 400, clock: true, date: false },
      { from: 400, to: 410, clock: false, date: true },
      { from: 500, to: 510, clock: false, date: true },
    ]);
    expect(stretchesOf(clock, date, 155, 405)).toEqual([
      { from: 155, to: 160, clock: true, date: true },
      { from: 160, to: 200, clock: true, date: false },
      { from: 300, to: 400, clock: true, date: false },
      { from: 400, to: 405, clock: false, date: true },
    ]);
    expect(stretchesOf([[0, 100]], [[0, 100]], 0, 1_000)).toEqual([{ from: 0, to: 100, clock: true, date: true }]);
    expect(stretchesOf([], [], 0, 1_000)).toEqual([]);
  });
});

describe("Z1 one zone rule", () => {
  const NY = 7;
  const tables: PresenceTables = {
    version: "z1",
    areas: [{ id: NY, place: null, city: "New York", city_id: "nyc", region: null, country: "United States", country_code: "US", zone: "America/New_York" }],
    pieces: [
      [D("2026-03-01", 2), D("2026-03-01", 6), NY, null, null, ["location:local"]],
      [D("2026-03-02", 2), D("2026-03-02", 6), null, NY, "America/Chicago", []],
      [D("2026-03-03", 2), D("2026-03-03", 6), null, null, null, []],
    ],
    placed: [],
  };
  const where = presenceOver(tables);
  const UTC: DaySettings = { zone: "UTC", day_start_hour: 0 };

  it("is a piece's zone, else its area's (known, else only guessed), else none, the home's used then and said", () => {
    expect(where.zoneAt(D("2026-03-01", 3))).toBe("America/New_York");
    expect(where.zoneAt(D("2026-03-02", 3))).toBe("America/Chicago");
    expect(where.zoneAt(D("2026-03-03", 3))).toBeNull();
    expect(where.dayAt(D("2026-03-01", 3), UTC)).toBe("2026-02-28");
    expect(where.dayAt(D("2026-03-03", 3), UTC)).toBe("2026-03-03");
  });

  it("T1 the one time rule: where the person was, else the clock's zone; none for a thing with only a date", () => {
    expect(at(D("2026-03-01", 3), false, where, UTC)).toBe("2026-02-28T22:00-05:00");
    expect(at(D("2026-03-03", 3), false, where, UTC)).toBe("2026-03-03T03:00+00:00");
    expect(at(D("2026-03-01", 3), undefined, undefined, { zone: "Asia/Kolkata" })).toBe("2026-03-01T08:30+05:30");
    expect(at(D("2026-03-01", 0), true, where, UTC)).toBeUndefined();
  });

  it("is the one the offset timeline and the place's days read: the place's day of a fact is a day of its calendar", () => {
    const offsets = where.offsets("UTC");
    const at = (ms: number) => [...offsets].reverse().find(([start]) => start <= ms)![1];
    expect(at(D("2026-03-01", 3))).toBe(-300);
    expect(at(D("2026-03-03", 3))).toBe(0);
    const { days } = placeDaysOf(where, [NY], "2026-02-27", "2026-03-04", UTC);
    expect([...days.keys()]).toEqual(["2026-02-28", "2026-03-01"]);
    for (const ms of [D("2026-03-01", 3), D("2026-03-02", 3)]) expect(days.has(where.dayAt(ms, UTC))).toBe(true);
  });
});

describe("Z2 one day rule", () => {
  it("a date is its own date in every zone and day start; an instant its civil day; no time, none", () => {
    const newYork: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
    const midnight = Date.parse("2026-10-04T00:00:00Z");
    expect(dayOf(midnight, true, newYork)).toBe("2026-10-04");
    expect(dayOf(midnight, false, newYork)).toBe("2026-10-03");
    expect(dayOf(midnight, true, { zone: "Asia/Tokyo", day_start_hour: 0 })).toBe("2026-10-04");
    expect(dayOf(null, false, newYork)).toBeUndefined();
  });
});

describe("P1 a place's words", () => {
  const areas: PresenceAreaRow[] = [
    { id: 1, place: null, city: "Paris", city_id: "paris-fr", region: "Ile-de-France", country: "France", country_code: "FR", zone: "Europe/Paris" },
    { id: 2, place: "Home", city: "Paris", city_id: "paris-fr", region: "Ile-de-France", country: "France", country_code: "FR", zone: "Europe/Paris" },
    { id: 3, place: null, city: "Paris", city_id: "paris-us", region: "Texas", country: "United States", country_code: "US", zone: "America/Chicago" },
    { id: 4, place: null, city: "London", city_id: "london-gb", region: null, country: "United Kingdom", country_code: "GB", zone: "Europe/London" },
  ];

  it("folds a name one way, names a country by its short name or code, and two cities of one name two places", () => {
    const [uk] = placeTermsOf("UK");
    expect(placeNamed(areas, uk!).filter((value) => value.whole).map((value) => [value.at.level, value.ids])).toEqual([["country", [4]]]);
    const paris = placeNamed(areas, placeTermsOf("  paris ")[0]!).filter((value) => value.at.level === "city");
    expect(paris.map((value) => value.ids)).toEqual([[1, 2], [3]]);
    expect(placeTermsOf("-Lyon OR Rome").map(({ text, negated }) => [text, negated])).toEqual([["Lyon", true], ["Rome", false]]);
  });

  it("keeps a place by its level and identity, bound to each version's own ids", () => {
    const [france] = placeNamed(areas, placeTermsOf("France")[0]!).filter((value) => value.at.level === "country");
    const again = [...areas.map((each) => ({ ...each, id: each.id + 10 })), { ...areas[0]!, id: 30, city: "Lyon", city_id: "lyon-fr" }];
    expect(areasAt(again, france!.at)).toEqual([11, 12, 30]);
  });
});
