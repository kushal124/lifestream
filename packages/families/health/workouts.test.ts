import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ExtractRow, Json } from "@lifestreamprotocol/core";
import type { DayInput, Labels } from "../family.js";
import type { HealthWorkoutContent, WorkoutContent } from "./family.js";
import { healthDay } from "./lines.js";

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "test", "workouts.json");
const UPDATE = process.env.LIFESTREAM_UPDATE_GOLDEN === "1";
const DAY = "2031-03-04";
const AT = Date.UTC(2031, 2, 4, 7, 0);
const MINUTE = 60_000;

const record = (key: string) => ({ source: "synthetic:1:cloud", key, kind: "workout" });
const tracker = (key: string, minutes: number, sport: string | null, strain: number | null): WorkoutContent =>
  ({ kind: "workout", record: record(key), start_ms: AT, end_ms: AT + minutes * MINUTE, sport, strain,
    average_heart_rate: null, max_heart_rate: null, kilojoule: null, distance_m: null });
const stated = (key: string, minutes: number, moving_s: number | null, distance: string | null): HealthWorkoutContent =>
  ({ kind: "health-workout", record: record(key), instrument: "strava", start_ms: AT, end_ms: AT + minutes * MINUTE,
    activity: "running", duration_s: moving_s, distance, energy: null, average_heart_rate: null, max_heart_rate: null, strain: null });

const WORKOUTS: readonly { content: WorkoutContent | HealthWorkoutContent; ms: number }[] = [
  { content: tracker("w-1", 45, "running", 11.2), ms: 45 * MINUTE },
  { content: tracker("w-2", 65, null, 9), ms: 65 * MINUTE },
  { content: tracker("w-3", 30, "cycling", null), ms: 30 * MINUTE },
  { content: stated("w-4", 45, 35 * 60 + 20, "6.60 km"), ms: 35 * MINUTE },
  { content: stated("w-5", 50, null, null), ms: 50 * MINUTE },
];

const LABELS: Labels = { person: () => undefined, place: () => undefined, nearest: () => undefined, mine: () => false, quiet: () => false };

function lineOf(content: WorkoutContent | HealthWorkoutContent): string {
  const extract: ExtractRow = { family: "health", unit: `workout/${content.record.key}`, reading: "", code: "", seq: 0,
    content: content as unknown as Json, start_ms: content.start_ms, end_ms: content.end_ms, days: [DAY] };
  const input: DayInput = { day: DAY, settings: { zone: "UTC", day_start_hour: 0 }, extracts: [extract], enrichments: new Map(),
    labels: LABELS, sources: new Map(), device: () => "" };
  const { lines } = healthDay(input, { named: (instrument) => (instrument === "strava" ? "Strava" : instrument), owners: () => undefined, own: () => "Synthetic" });
  expect(lines).toHaveLength(1);
  return lines[0]!.text;
}

describe("a workout's line", () => {
  it("is the one test/workouts.json holds for the clients, with the length it states", () => {
    const printed = `${JSON.stringify(WORKOUTS.map(({ content, ms }) => ({ text: lineOf(content), ms })), null, 2)}\n`;
    if (UPDATE) writeFileSync(GOLDEN, printed);
    expect(printed).toBe(readFileSync(GOLDEN, "utf8"));
  });
});
