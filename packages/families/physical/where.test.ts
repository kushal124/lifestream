import { describe, expect, it } from "vitest";
import { addDays, civilDay, dayBounds, digest, type DaySettings, type ExtractRow, type Json } from "@lifestreamprotocol/core";
import { buildLabels, labelsFrom } from "../shared/labels.js";
import { tableUnits } from "../days.js";
import { zoneOf } from "../shared/geography.js";
import type { Point } from "../shared/places.js";
import { FED } from "../test/fed.js";
import type { Photo, SeenContent, StayContent, TripContent } from "./evidence.js";
import { physicalFamily, witnessSourcesOf } from "./family.js";
import { presence, where, type Piece, type PresencePiece } from "./where.js";

const ALONE = (unit: string): string[] => witnessSourcesOf(FED.physical)(unit, new Map());

const PHYSICAL = physicalFamily({ photos: FED.photos })(FED.physical);
const SETTINGS: DaySettings = { zone: "Europe/Paris", day_start_hour: 0 };
const LIBRARY = "photos:local:mac-0001";
const EXPORT = "google-photos:person-a@example.com:export";
const TIMELINE = "google-timeline:person-a@example.com:export";
const PHONE = "location:local:phone-aa01";
const CAMERA = "synthetic-make/own-camera";
const LABELS = labelsFrom(tableUnits(buildLabels({ places: [], cameras: [[CAMERA, { mine_by_count: true }]] })), SETTINGS);

const HOME: Point = { latitude: 46.3, longitude: 2.6 };
const HOME_TOO: Point = { latitude: 46.309, longitude: 2.604 };
const FAR: Point = { latitude: 41.9, longitude: -100.3 };
const FAR_TOO: Point = { latitude: 41.918, longitude: -100.3 };
const THIRD: Point = { latitude: 36.5, longitude: 138.5 };
const STAY: Point = { latitude: 38.6, longitude: -99.8 };
const OVER: Point = { latitude: 44.2, longitude: -101.6 };

const MINUTE = 60_000;
const winter = (local: string) => Date.parse(`${local}+01:00`);
const summer = (local: string) => Date.parse(`${local}+02:00`);

let seq = 0;
function row(unit: string, content: Record<string, unknown>, start_ms: number, end_ms: number): ExtractRow {
  const made: ExtractRow = { family: PHYSICAL.name, unit, reading: digest(content as Json), code: PHYSICAL.code, content: content as Json, start_ms, end_ms, days: [], seq: seq++ };
  return { ...made, days: PHYSICAL.days(made, SETTINGS) };
}

function photos(source: string, shots: readonly [number, Point][]): ExtractRow[] {
  const byDate = new Map<string, Photo[]>();
  for (const [at_ms, point] of shots) {
    const date = new Date(at_ms).toISOString().slice(0, 10);
    byDate.set(date, [...byDate.get(date) ?? [], { at_ms, point, accuracy_m: null, camera: CAMERA }]);
  }
  return [...byDate].map(([date, list]) => {
    const content: SeenContent = {
      kind: "seen", source, date, start_ms: list[0]!.at_ms, end_ms: list.at(-1)!.at_ms, photos: list, rank: 20, how: "seen", by: "Photos",
    };
    return row(`seen/${source}/${date}`, content as unknown as Record<string, unknown>, content.start_ms, content.end_ms);
  });
}

function stated(start_ms: number, end_ms: number, centre: Point): ExtractRow {
  const content: StayContent = { kind: "stay", source: TIMELINE, start_ms, end_ms, open: false, centre, level: "stated", silences: [], bouts: [], rank: 40, how: "stated", by: "Timeline" };
  return row(`stay/${TIMELINE}/${start_ms}`, content as unknown as Record<string, unknown>, start_ms, end_ms);
}

function flight(start_ms: number, end_ms: number, from: Point, to: Point, distance_m: number): ExtractRow {
  const content: TripContent = {
    kind: "trip", source: TIMELINE, start_ms, end_ms, from, to, distance_m,
    legs: [{ start_ms, end_ms, mode: "flight", distance_m, motion: null, stated: "FLYING" }], rank: 40, how: "stated", by: "Timeline",
  };
  return row(`trip/${TIMELINE}/${start_ms}`, content as unknown as Record<string, unknown>, start_ms, end_ms);
}

function told(evidence: readonly ExtractRow[], from: string, to: string): PresencePiece[] {
  const span = { start_ms: dayBounds(from, SETTINGS).start_ms, end_ms: dayBounds(to, SETTINGS).end_ms };
  return presence(where(evidence, span, LABELS, 30, SETTINGS), LABELS, ALONE).filter((piece) => piece.end_ms > span.start_ms && piece.start_ms < span.end_ms);
}

function placeDays(pieces: readonly PresencePiece[], country: string): string[] {
  const days = new Set<string>();
  for (const piece of pieces) {
    for (const area of [piece.known, piece.guessed]) {
      if (area === null || area.country !== country) continue;
      const local = { zone: piece.zone ?? area.zone ?? SETTINGS.zone, day_start_hour: SETTINGS.day_start_hour };
      for (let day = civilDay(piece.start_ms, local), last = civilDay(piece.end_ms - 1, local); day <= last; day = addDays(day, 1)) days.add(day);
    }
  }
  return [...days].sort();
}

const US = "United States";
const at = (pieces: readonly PresencePiece[], ms: number) => pieces.find((piece) => piece.start_ms <= ms && ms < piece.end_ms);

describe("a lone far point between two near ones minutes apart is a stray", () => {
  const day = "2026-01-02";
  const home = (clock: string) => winter(`${day}T${clock}`);

  it("S1: two sightings abroad a minute from the owner's at home either side make no piece and no day there", () => {
    const evidence = [
      ...photos(LIBRARY, [[home("09:00"), HOME], [home("13:15"), HOME_TOO], [home("13:30"), HOME], [home("16:00"), HOME_TOO]]),
      ...photos(EXPORT, [[home("13:20"), FAR], [home("13:25"), FAR_TOO]]),
    ];
    const pieces = told(evidence, day, day);
    expect(pieces.filter((piece) => piece.known?.country === US || piece.guessed?.country === US)).toEqual([]);
    expect([placeDays(pieces, US), placeDays(pieces, "France")]).toEqual([[], [day]]);
    expect([home("13:15"), home("13:30")].map((ms) => [at(pieces, ms)?.how, at(pieces, ms)?.known?.country])).toEqual([["seen", "France"], ["seen", "France"]]);
  });

  it("S2: a far run is kept when its sides leave time to reach it, when a side is missing, and when its sides disagree", () => {
    const reached = told([...photos(LIBRARY, [[home("02:00"), HOME], [home("23:00"), HOME_TOO]]), ...photos(EXPORT, [[home("12:00"), FAR]])], day, day);
    expect(placeDays(reached, US)).toEqual([day]);
    const oneSide = told([...photos(LIBRARY, [[home("12:00"), HOME]]), ...photos(EXPORT, [[home("12:05"), FAR]])], day, day);
    expect(placeDays(oneSide, US)).toEqual([day]);
    const disagree = told([...photos(LIBRARY, [[home("12:00"), HOME], [home("12:10"), THIRD]]), ...photos(EXPORT, [[home("12:05"), FAR]])], day, day);
    expect([at(disagree, home("12:05"))?.known?.country, at(disagree, home("12:10"))?.known?.country]).toEqual([US, "Japan"]);
  });

  it("S3: a stray doubts nothing: a stated stay at home holding it stays at its place", () => {
    const evidence = [
      stated(home("10:00"), home("16:00"), HOME),
      ...photos(LIBRARY, [[home("12:00"), HOME], [home("12:10"), HOME]]),
      ...photos(EXPORT, [[home("12:05"), FAR]]),
    ];
    const stay = at(told(evidence, day, day), home("12:05"))!;
    expect([stay.kind, stay.level, stay.how, stay.known?.country, stay.start_ms, stay.end_ms]).toEqual(["stay", "place", "stated", "France", home("10:00"), home("16:00")]);
  });
});

describe("a photo's point takes its place's zone", () => {
  const shot = summer("2026-07-22T03:50");
  const trip = (copies: readonly ExtractRow[]) => [
    stated(summer("2026-07-19T15:00"), summer("2026-07-22T03:00"), STAY),
    flight(summer("2026-07-22T03:00"), summer("2026-07-22T12:00"), STAY, HOME, 7_800_000),
    ...copies,
    stated(summer("2026-07-22T12:30"), summer("2026-07-24T12:00"), HOME),
  ];

  it("Z1: a photo from a plane over a region of two zones keeps the zone it was taken in, so the trip's days there end on its own last day", () => {
    expect(civilDay(shot, SETTINGS)).toBe("2026-07-22");
    const pieces = told(trip(photos(LIBRARY, [[shot, OVER], [shot + 10_000, OVER]])), "2026-07-19", "2026-07-23");
    expect([at(pieces, shot)?.how, at(pieces, shot)?.known?.country, at(pieces, shot)?.zone]).toEqual(["seen", US, "America/Denver"]);
    expect(placeDays(pieces, US)).toEqual(["2026-07-19", "2026-07-20", "2026-07-21"]);
  });

  it("Z1: two copies of the photo, one timed to the second and one to the millisecond, leave no gap in the flight and no day more", () => {
    const pieces = told(trip([...photos(EXPORT, [[shot, OVER], [shot + 5_000, OVER]]), ...photos(LIBRARY, [[shot + 57, OVER], [shot + 5_057, OVER]])]), "2026-07-19", "2026-07-23");
    const around = pieces.filter((piece) => piece.end_ms > summer("2026-07-22T03:00") && piece.start_ms < summer("2026-07-22T12:00"));
    expect(around.map((piece) => [piece.kind, piece.zone])).toEqual([["move", null], ["stay", "America/Denver"], ["move", null]]);
    expect(placeDays(pieces, US)).toEqual(["2026-07-19", "2026-07-20", "2026-07-21"]);
  });

  it("Z2: a point known at place with no city keeps its region's nearest place's zone; known only to the region or country, none", () => {
    expect([zoneOf(OVER, "place"), zoneOf(OVER, "city"), zoneOf(OVER, "region"), zoneOf(OVER, "country")]).toEqual(["America/Denver", null, null, null]);
    expect(zoneOf(FAR, "place")).toBe("America/Chicago");
    expect(zoneOf({ latitude: 0, longitude: -30 }, "place")).toBeNull();
  });
});

describe("a stretch cut under a minute goes to the next candidate covering it", () => {
  const start = winter("2026-01-02T12:00");
  const second = (n: number) => start + n * 1_000;

  it("L1: a phone move, a photo over its end and a Timeline move under both: the Timeline move covers what the photo left", () => {
    const content: TripContent = {
      kind: "trip", source: PHONE, start_ms: second(0), end_ms: second(100), from: HOME, to: HOME_TOO, distance_m: 1_000,
      legs: [{ start_ms: second(0), end_ms: second(100), mode: "road_vehicle", distance_m: 1_000, motion: null, stated: null }], rank: 10, how: "observed", by: "Phone",
    };
    const evidence = [
      row(`trip/${PHONE}/${second(0)}`, content as unknown as Record<string, unknown>, second(0), second(100)),
      ...photos(LIBRARY, [[second(50), HOME_TOO], [second(130), HOME_TOO]]),
      flight(second(0), second(160), HOME, HOME_TOO, 1_000),
    ];
    const pieces = where(evidence, dayBounds("2026-01-02", SETTINGS), LABELS, 0, SETTINGS);
    const laid = (piece: Piece) => [piece.kind, piece.by ?? null, piece.start_ms - start, piece.end_ms - start];
    expect(pieces.filter((piece) => piece.end_ms > second(0) && piece.start_ms < second(160)).map(laid))
      .toEqual([["move", "Phone", 0, 100_000], ["move", "Timeline", 100_000, 160_000]]);
  });
});
