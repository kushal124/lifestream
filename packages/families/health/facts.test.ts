import { describe, expect, it } from "vitest";
import type { DaySettings } from "@lifestreamprotocol/core";
import { collectionsFault } from "../family.js";
import { dayFacts } from "../days.js";
import { factsConform, insertKeepsFacts } from "../test/facts.js";
import { dayInput, type Content } from "../test/day-input.js";
import type { HealthAdapter } from "@lifestreamprotocol/core";
import type { Given } from "../family.js";
import { healthFamily, type CycleContent, type SpanContent, type StageContent, type WorkoutContent } from "./family.js";

const SETTINGS: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
const HEALTH = healthFamily([]);
const PROVIDER = "apple-health:person-a@example.com:cloud";
const TRACKER = "whoop:1:cloud";
const at = (local: string) => Date.parse(`${local}-04:00`);
const MINUTE = 60_000;

function steps(instrument: string, local: string, count: number): Content {
  const start_ms = at(local);
  const span: SpanContent = {
    kind: "span", source: PROVIDER, start_ms, end_ms: start_ms + 15 * MINUTE, own: false,
    lanes: [{ metric: "steps", instrument, unit: "count", count: 1, sum: count, min: count, max: count }],
  };
  return { unit: `span/${PROVIDER}/${instrument}/${start_ms}`, content: span, start_ms, end_ms: span.end_ms };
}

function stage(instrument: string, key: string, word: string, from: string, to: string): Content {
  const content: StageContent = { kind: "stage", source: PROVIDER, instrument, stage: word, start_ms: at(from), end_ms: at(to), recovery: null };
  return { unit: `stage/${PROVIDER}/${key}`, content, start_ms: content.start_ms, end_ms: content.end_ms };
}

function workout(key: string, from: string, to: string): Content {
  const content: WorkoutContent = {
    kind: "workout", record: { source: TRACKER, key, kind: "workout" }, start_ms: at(from), end_ms: at(to),
    sport: "running", strain: 11.5, average_heart_rate: 140, max_heart_rate: 171, kilojoule: 2092, distance_m: 8000,
  };
  return { unit: `workout/${TRACKER}/${key}`, content, start_ms: content.start_ms, end_ms: content.end_ms };
}

const RECORD: Content[] = [
  steps("Apple Watch", "2026-09-18T09:00", 6000), steps("Apple Watch", "2026-09-18T17:00", 3000),
  steps("iPhone", "2026-09-18T09:00", 5000), steps("iPhone", "2026-09-18T17:00", 2500),
  stage("Apple Watch", "aw-1", "core", "2026-09-17T23:30", "2026-09-18T03:30"),
  stage("Apple Watch", "aw-2", "deep", "2026-09-18T03:30", "2026-09-18T05:00"),
  stage("Apple Watch", "aw-3", "in bed", "2026-09-17T23:00", "2026-09-18T07:00"),
  stage("Oura Ring", "or-1", "asleep", "2026-09-17T23:45", "2026-09-18T06:45"),
  workout("w1", "2026-09-18T03:30", "2026-09-18T04:30"),
];

const input = (day: string, contents: readonly Content[] = RECORD) => dayInput(HEALTH, day, contents, SETTINGS);
const days = (day: string) => HEALTH.day(input(day)).facts.filter((fact) => fact.of === "days");

describe("health facts", () => {
  it("declares collections that hold together", () => {
    expect(collectionsFault([HEALTH])).toEqual([]);
  });

  it("a day no instrument states anything of has no fact, never a zero", () => {
    expect(HEALTH.day(input("2026-09-25")).facts).toEqual([]);
    const night = [stage("Oura Ring", "or-9", "asleep", "2026-09-21T23:00", "2026-09-22T06:00")];
    const [fact] = HEALTH.day(input("2026-09-22", night)).facts;
    expect(fact!.measures).toEqual({ asleep_min: 420 });
  });

  it("two instruments' steps: the largest instrument's total stands, named, and the other's is stated by none", () => {
    const stated = days("2026-09-18").filter((fact) => "steps" in fact.measures);
    expect(stated).toHaveLength(1);
    expect(stated[0]!.measures["steps"]).toBe(9000);
    expect(stated[0]!.keys).toEqual({ instrument: "Apple Watch" });
    expect(stated[0]!.from.instrument).toBe("Apple Watch");
    expect(days("2026-09-18").find((fact) => fact.keys["instrument"] === "iPhone")).toBeUndefined();
  });

  it("two instruments' different nights are two readings, each named, never one chosen", () => {
    const nights = days("2026-09-18").map((fact) => [fact.keys["instrument"], fact.measures["asleep_min"], fact.measures["in_bed_min"]]);
    expect(nights.sort()).toEqual([["Apple Watch", 330, 480], ["Oura Ring", 420, undefined]]);
    const facts = days("2026-09-18");
    expect(new Set(facts.map((fact) => fact.id)).size).toBe(facts.length);
    const projection = HEALTH.day(input("2026-09-18"));
    for (const fact of facts.filter((each) => "asleep_min" in each.measures)) {
      expect(fact.date_only).toBe(true);
      expect(fact.lines.map((line) => projection.lines[line]!.text).join()).toContain(`(${fact.keys["instrument"]})`);
    }
  });

  it("a workout across the day's edge is one workout, whole, on the day it began, and no fact of the next day", () => {
    const stated = ["2026-09-17", "2026-09-18"].map((day) => {
      const projection = HEALTH.day(input(day));
      return dayFacts(HEALTH, projection, day, SETTINGS, (line) => line).filter((fact) => fact.of === "workouts");
    });
    expect(stated.map((facts) => facts.map((fact) => fact.measures))).toEqual([
      [{ minutes: 60, km: 8, kcal: 500, strain: 11.5, avg_hr: 140, max_hr: 171 }],
      [],
    ]);
    expect([stated[0]![0]!.start_ms, stated[0]![0]!.end_ms, "part" in stated[0]![0]!]).toEqual([at("2026-09-18T03:30"), at("2026-09-18T04:30"), false]);
    expect(stated[0]![0]!.keys).toEqual({ sport: "running", instrument: "whoop" });
  });

  it("a night's sleep that began the day before is stated whole by the day it ends, and by no other", () => {
    const nights = ["2026-09-17", "2026-09-18"].map((day) => {
      const projection = HEALTH.day(input(day));
      return dayFacts(HEALTH, projection, day, SETTINGS, (line) => line)
        .filter((fact) => fact.of === "days" && "asleep_min" in fact.measures).map((fact) => [fact.keys["instrument"], fact.measures["asleep_min"]]);
    });
    expect([nights[0], nights[1]!.sort()]).toEqual([[], [["Apple Watch", 330], ["Oura Ring", 420]]]);
  });

  it("a workout whose content leaves a measure out states the rest, never a measure as no number", () => {
    const old = workout("w2", "2026-09-18T18:00", "2026-09-18T18:30");
    const { distance_m: _distance, strain: _strain, ...kept } = old.content as WorkoutContent;
    const projection = HEALTH.day(input("2026-09-18", [{ ...old, content: kept as unknown as WorkoutContent }]));
    const facts = dayFacts(HEALTH, projection, "2026-09-18", SETTINGS, (line) => line).filter((fact) => fact.of === "workouts");
    expect(facts.map((fact) => fact.measures)).toEqual([{ minutes: 30, kcal: 500, avg_hr: 140, max_hr: 171 }]);
  });

  it("holds to F1's conformance: order, one day's statement and an inserted line", () => {
    expect(factsConform(HEALTH, ["2026-09-17", "2026-09-18", "2026-09-19"].map((day) => input(day)))).toEqual([]);
    expect(insertKeepsFacts(HEALTH, input("2026-09-18"), input("2026-09-18", [...RECORD, workout("w0", "2026-09-18T06:00", "2026-09-18T06:30")]))).toEqual([]);
  });
  it("a tracker's copy states no recovery where the tracker's own cycle covers its night and states none; with no cycle there, the copy's stands", () => {
    const whoop = { product: "whoop", name: "WHOOP", type: null, adapter: { kinds: ["cycle"], instrument: ["WHOOP"], item: () => null } } as unknown as Given<HealthAdapter>;
    const family = healthFamily([whoop]);
    const night = (key: string, from: string, to: string): Content => {
      const content: StageContent = { kind: "stage", source: PROVIDER, instrument: "WHOOP", stage: "asleep", start_ms: at(from), end_ms: at(to), recovery: 15 };
      return { unit: `stage/${PROVIDER}/${key}`, content, start_ms: content.start_ms, end_ms: content.end_ms };
    };
    const cycle = (key: string, from: string, to: string, workoutFrom: string, workoutTo: string): Content => {
      const record = { source: TRACKER, key, kind: "cycle" as const };
      const content: CycleContent = {
        kind: "cycle", record, start_ms: at(from), end_ms: at(to), sleeps: [], recovery: null,
        workouts: [{ ...(workout(`${key}-w`, workoutFrom, workoutTo).content as WorkoutContent), record }],
      };
      return { unit: `cycle/${TRACKER}/${key}`, content, start_ms: content.start_ms, end_ms: content.end_ms };
    };
    const recoveryOf = (day: string, contents: Content[]) => {
      const projection = family.day(dayInput(family, day, contents, SETTINGS));
      const fact = projection.facts.find((each) => each.of === "days" && each.keys["instrument"] === "WHOOP");
      return { measures: fact?.measures, lines: projection.lines.map((line) => line.text).filter((text) => text.startsWith("Sleep")) };
    };
    const copy = night("n1", "2026-09-20T00:50", "2026-09-20T06:30");
    expect(recoveryOf("2026-09-20", [copy, cycle("c1", "2026-09-20T00:50", "2026-09-20T23:20", "2026-09-20T17:00", "2026-09-20T17:30")])).toEqual({
      measures: { asleep_min: 340 }, lines: ["Sleep 00:50–06:30, wake at 06:30: asleep 5:40 (WHOOP)"],
    });
    expect(recoveryOf("2026-09-20", [copy, cycle("c2", "2026-09-20T00:50", "2026-09-23T01:00", "2026-09-22T20:00", "2026-09-22T20:30")]).measures).toEqual({ asleep_min: 340 });
    expect(recoveryOf("2026-09-20", [copy]).measures).toEqual({ asleep_min: 340, recovery: 15 });
  });
});
