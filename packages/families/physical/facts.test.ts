import { describe, expect, it } from "vitest";
import { dayBounds, type DaySettings } from "@lifestreamprotocol/core";
import { dayFacts } from "../days.js";
import { collectionsFault } from "../family.js";
import { buildLabels } from "../shared/labels.js";
import { FED } from "../test/fed.js";
import { factsConform, insertKeepsFacts } from "../test/facts.js";
import { dayInput, type Content } from "../test/day-input.js";
import type { SeenContent, StayContent, TripContent } from "./evidence.js";
import { physicalFamily, witnessSourcesOf } from "./family.js";
import { presence, where, type Piece } from "./where.js";

const ALONE = (unit: string): string[] => witnessSourcesOf(FED.physical)(unit, new Map());

const SETTINGS: DaySettings = { zone: "Europe/Paris", day_start_hour: 4 };
const PHYSICAL = physicalFamily({ photos: FED.photos })(FED.physical);
const PHONE = "location:local:iphone-0001";
const PHOTOS = "photos:local:mac-0001";
const CAMERA = "synthetic-make/own-camera";
const at = (local: string) => Date.parse(`${local}+02:00`);

const HOME = { latitude: 48.8566, longitude: 2.3522 };
const OFFICE = { latitude: 48.8738, longitude: 2.295 };
const CAFE = { latitude: 48.8530, longitude: 2.3499 };
const VERSAILLES = { latitude: 48.8049, longitude: 2.1204 };
const NEW_YORK = { latitude: 40.7128, longitude: -74.006 };
const LABELS = buildLabels({
  places: [
    { slug: "home", name: "Home", latitude: HOME.latitude, longitude: HOME.longitude, radius_m: 100, also: [], ids: [] },
    { slug: "office", name: "Office", latitude: OFFICE.latitude, longitude: OFFICE.longitude, radius_m: 100, also: [], ids: [] },
  ],
  cameras: [[CAMERA, { mine_by_count: true }]],
});

function stay(from: string, to: string, centre: typeof HOME): Content {
  const content: StayContent = {
    kind: "stay", source: PHONE, start_ms: at(from), end_ms: at(to), open: false, centre, level: "observed", silences: [], bouts: [],
    rank: 10, how: "observed", by: "Phone",
  };
  return { unit: `stay/${PHONE}/${at(from)}`, content, start_ms: at(from), end_ms: at(to) };
}

function trip(from: string, to: string, start: typeof HOME, end: typeof HOME): Content {
  const content: TripContent = {
    kind: "trip", source: PHONE, start_ms: at(from), end_ms: at(to), from: start, to: end, distance_m: 4_500,
    legs: [{ start_ms: at(from), end_ms: at(to), mode: "walk", distance_m: 4_500, motion: null, stated: null }], rank: 10, how: "observed", by: "Phone",
  };
  return { unit: `trip/${PHONE}/${at(from)}`, content, start_ms: at(from), end_ms: at(to) };
}

function photo(local: string, point: typeof HOME): Content {
  const content: SeenContent = {
    kind: "seen", source: PHOTOS, date: local.slice(0, 10), start_ms: at(local), end_ms: at(local),
    photos: [{ at_ms: at(local), point, accuracy_m: null, camera: CAMERA }], rank: 20, how: "seen", by: "Photos",
  };
  return { unit: `seen/${PHOTOS}/${local.slice(0, 10)}`, content, start_ms: at(local), end_ms: at(local) };
}

const RECORD: Content[] = [
  stay("2026-10-20T20:00", "2026-10-21T09:00", HOME),
  trip("2026-10-21T09:00", "2026-10-21T09:30", HOME, OFFICE),
  stay("2026-10-21T09:30", "2026-10-21T13:00", OFFICE),
  stay("2026-10-21T14:00", "2026-10-21T18:00", CAFE),
];
const input = (day: string, contents: readonly Content[] = RECORD) => dayInput(PHYSICAL, day, contents, SETTINGS, { labels: LABELS });
const stated = (day: string, contents?: readonly Content[]) => dayFacts(PHYSICAL, PHYSICAL.day(input(day, contents)), day, SETTINGS, (line) => line);

describe("physical facts", () => {
  it("declares collections that hold together", () => {
    expect(collectionsFault([PHYSICAL])).toEqual([]);
  });

  it("a stay across the day's start is one stay of 780, whole, on the day it began, and no fact of the next day, whose line still prints its part", () => {
    const before = stated("2026-10-20").find((fact) => fact.keys["place"] === "Home")!;
    expect([before.measures, before.start_ms, "part" in before]).toEqual([{ minutes: 780 }, at("2026-10-20T20:00"), false]);
    expect(stated("2026-10-21").some((fact) => fact.id === before.id)).toBe(false);
    const next = PHYSICAL.day(input("2026-10-21"));
    expect(next.lines.some((line) => line.start_ms !== null && line.start_ms <= dayBounds("2026-10-21", SETTINGS).start_ms && (line.end_ms ?? 0) > dayBounds("2026-10-21", SETTINGS).start_ms)).toBe(true);
    const whole = next.facts.find((fact) => fact.id === before.id)!;
    expect(whole.measures).toEqual({ minutes: 780 });
    expect(whole.time_ms).toBe(at("2026-10-20T20:00"));
    expect(whole.keys).toEqual({ place: "Home", city: "Paris", country: "France", how: "observed" });
    expect(whole.from.instrument).toBe("Phone");
  });

  it("each printed stay is one fact citing its line; a move is none", () => {
    const projection = PHYSICAL.day(input("2026-10-21"));
    expect(projection.facts.map((fact) => [fact.keys["place"], projection.lines[fact.lines[0]!]!.text]))
      .toEqual([["Home", "At Home"], ["Office", "At Office"], [undefined, "At an unnamed place 0.4 km from Home"]]);
  });

  it("a photo abroad the phone leaves no time to reach is no stay there: not laid, printed or stated", () => {
    const record = [...RECORD, photo("2026-10-21T13:30", NEW_YORK)];
    const projection = PHYSICAL.day(input("2026-10-21", record));
    expect(projection.facts.map((fact) => fact.keys["country"])).toEqual(["France", "France", "France"]);
    expect(projection.lines.map((line) => line.text).filter((text) => text.includes("from photos"))).toEqual([]);
    const day = input("2026-10-21", record);
    const pieces = where(day.extracts, { start_ms: at("2026-10-21T04:00"), end_ms: at("2026-10-22T04:00") }, day.labels, 0, SETTINGS);
    expect(presence(pieces, day.labels, ALONE).flatMap((piece) => piece.point?.area.country ?? [])).not.toContain("United States");
  });

  it("a photo the phone leaves time to reach is laid, printed and stated as a stay seen", () => {
    const projection = PHYSICAL.day(input("2026-10-21", [...RECORD, photo("2026-10-21T13:30", VERSAILLES)]));
    const seen = projection.facts.filter((fact) => fact.keys["how"] === "seen");
    expect(seen.map((fact) => [fact.keys["country"], projection.lines[fact.lines[0]!]!.text.endsWith("(from photos)")])).toEqual([["France", true]]);
  });

  it("presence's pieces carry the zone their level knows: a city's its own, a country of several none", () => {
    const day = input("2026-10-21");
    const pieces = where(day.extracts, { start_ms: at("2026-10-21T04:00"), end_ms: at("2026-10-22T04:00") }, day.labels, 0, SETTINGS);
    const told = presence(pieces, day.labels, ALONE);
    expect(told.filter((piece) => piece.kind === "stay").map((piece) => [piece.zone, piece.sure])).toEqual([["Europe/Paris", true], ["Europe/Paris", true], ["Europe/Paris", true]]);
    const piece = (level: Piece["level"], how: Piece["how"]): Piece => ({
      kind: "stay", level, how, point: NEW_YORK, from: null, to: null, units: [], start_ms: 0, end_ms: 1,
    });
    expect(presence([piece("city", "observed"), piece("country", "guessed")], day.labels, ALONE).map((each) => [each.zone, each.sure]))
      .toEqual([["America/New_York", true], [null, false]]);
  });

  it("holds to F1's conformance: order, one day's statement and an inserted line", () => {
    expect(factsConform(PHYSICAL, ["2026-10-20", "2026-10-21"].map((day) => input(day)))).toEqual([]);
    expect(insertKeepsFacts(PHYSICAL, input("2026-10-21"), input("2026-10-21", [...RECORD, stay("2026-10-21T13:10", "2026-10-21T13:50", VERSAILLES)]))).toEqual([]);
  });
});
