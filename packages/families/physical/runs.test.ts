import { describe, expect, it } from "vitest";
import type { DaySettings } from "@lifestreamprotocol/core";
import { placesBy, readDays } from "./runs.js";
import { placedDays, type Piece } from "./where.js";

const SETTINGS: DaySettings = { zone: "Europe/Paris", day_start_hour: 4 };
const PARIS = { latitude: 48.8566, longitude: 2.3522 };
const LYON = { latitude: 45.764, longitude: 4.8357 };
const LONDON = { latitude: 51.5074, longitude: -0.1278 };
const NEW_YORK = { latitude: 40.7128, longitude: -74.006 };
const at = (local: string) => Date.parse(`${local}+01:00`);

function stay(from: string, to: string, point: typeof PARIS, how: Piece["how"] = "observed", level: Piece["level"] = "place"): Piece {
  return { kind: "stay", level, how, point, from: null, to: null, units: [`stay/${from}`], start_ms: at(from), end_ms: at(to) };
}

function days(pieces: Piece[], from: string, to: string) {
  return readDays([placedDays(pieces, { start_ms: at(`${from}T04:00`), end_ms: at(`${to}T04:00`) }, SETTINGS)]);
}

describe("runs", () => {
  it("a trip across a year's edge is one run; a guessed day continues it, counted apart", () => {
    const pieces = [
      stay("2025-12-28T10:00", "2025-12-30T12:00", LONDON),
      stay("2025-12-30T12:00", "2025-12-31T20:00", LONDON, "guessed", "city"),
      stay("2025-12-31T20:00", "2026-01-03T10:00", LONDON),
    ];
    const [london] = placesBy(days(pieces, "2025-12-28", "2026-01-04"), "country").filter((area) => area.place.country === "United Kingdom");
    expect(london!.runs.map((run) => [run.from_day, run.to_day, run.days, run.guessed_days, run.sure, run.zone]))
      .toEqual([["2025-12-28", "2026-01-03", 7, 0, "known", "Europe/London"]]);
    const guessed = placesBy(days([pieces[0]!, pieces[1]!], "2025-12-28", "2026-01-01"), "city").find((area) => area.place.city === "London")!;
    expect(guessed.runs.map((run) => [run.days, run.guessed_days, run.sure])).toEqual([[4, 1, "partly guessed"]]);
  });

  it("a travel day is in both countries; a day laid elsewhere ends a run", () => {
    const pieces = [
      stay("2026-03-01T10:00", "2026-03-03T09:00", PARIS),
      stay("2026-03-03T12:00", "2026-03-04T20:00", LONDON),
      stay("2026-03-05T10:00", "2026-03-06T20:00", PARIS),
    ];
    const read = days(pieces, "2026-03-01", "2026-03-07");
    expect(placesBy(read, "country").map((area) => [area.place.country, area.runs.map((run) => `${run.from_day}..${run.to_day}`)]))
      .toEqual([["France", ["2026-03-01..2026-03-03", "2026-03-05..2026-03-06"]], ["United Kingdom", ["2026-03-03..2026-03-04"]]]);
    expect(placesBy(read, "city").find((area) => area.place.city === "Paris")!.days).toBe(5);
    const france = placesBy(days([stay("2026-03-01T10:00", "2026-03-03T09:00", PARIS), stay("2026-03-03T12:00", "2026-03-03T20:00", LYON)], "2026-03-01", "2026-03-04"), "country").find((area) => area.place.country === "France")!;
    expect(france.runs[0]!.cities).toEqual(["Paris", "Lyon"]);
  });

  it("a day known only by a country of several zones keeps none; a city's is its own", () => {
    const pieces = [stay("2026-04-01T10:00", "2026-04-01T20:00", NEW_YORK, "observed", "country"), stay("2026-04-02T10:00", "2026-04-02T20:00", NEW_YORK)];
    const read = days(pieces, "2026-04-01", "2026-04-03");
    expect(read.slice(0, 2).map((day) => day.known.map((area) => [area.city, area.zone]))).toEqual([[[null, null]], [["New York City", "America/New_York"]]]);
  });
});
