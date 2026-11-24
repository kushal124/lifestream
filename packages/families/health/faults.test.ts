import { describe, expect, it } from "vitest";
import type { HealthAdapter } from "@lifestreamprotocol/core";
import { AT_MS, recordOf, statedOf } from "../test/stated.js";
import { healthFaults } from "./faults.js";

const HOUR = Date.UTC(2026, 10, 2, 9);
const item = (value: object, record = recordOf("item-1", { start_ms: AT_MS })) => healthFaults(statedOf<HealthAdapter>({}, "item", value, record));
const USAGE = { item: "usage", captured_ms: HOUR, seconds: 600, categories: [] };
const WORKOUT = { item: "instrument-workout", instrument: "example-watch", activity: "Run", duration_s: 1_800, distance: "5.2 km", energy: "310 kcal", strain: null };

describe("healthFaults", () => {
  it("passes each item that keeps every rule", () => {
    expect(item(USAGE, recordOf("usage-1", { start_ms: HOUR, end_ms: HOUR + 3_600_000 }))).toEqual([]);
    expect(item({ item: "stage", instrument: "example-watch", stage: "REM", recovery: null })).toEqual([]);
    expect(item({ item: "sample", metric: "heart_rate", instrument: "example-watch", unit: "count/min", value: 61, series: 0 })).toEqual([]);
    expect(item({ item: "day-summary", date: "2026-11-02", move: ["300", "500", "kcal"], exercise: ["20", "30"], stand: ["8", "12"] })).toEqual([]);
    expect(item(WORKOUT)).toEqual([]);
    expect(item({ ...WORKOUT, distance: null, energy: undefined })).toEqual([]);
  });

  it("names each rule an item breaks", () => {
    expect(item(USAGE, recordOf("usage-1", { start_ms: HOUR, end_ms: HOUR + 1_800_000 }))).toEqual([`a usage record's time spans exactly one hour: it states ${HOUR} to ${HOUR + 1_800_000}`]);
    expect(item(USAGE, recordOf("usage-1"))).toEqual(["a usage record's time spans exactly one hour: it states no time"]);
    expect(item({ item: "stage", instrument: "example-watch", stage: "rem", recovery: null })).toEqual(["`stage` is one of `in bed`, `asleep`, `core`, `deep`, `REM`, `awake`: `rem` is none"]);
    expect(item({ item: "sample", metric: "heart_rate", instrument: "example-watch", unit: "count/min", value: 61, series: 1.5 })).toEqual(["`series` is a whole number counted from 0 for the finest: 1.5 is none"]);
    expect(item({ item: "sample", metric: "heart_rate", instrument: "example-watch", unit: "count/min", value: 61, series: -1 })).toEqual(["`series` is a whole number counted from 0 for the finest: -1 is none"]);
    expect(item({ item: "day-summary", date: "2026-11-2", move: ["300", "500", "kcal"], exercise: ["20", "30"], stand: ["8", "12"] })).toEqual(["`date` is the day it sums as `YYYY-MM-DD`: `2026-11-2` is none"]);
    expect(item({ ...WORKOUT, distance: "5.2km" })).toEqual(["`distance` is a number, a space and its unit, such as `5.2 km`: `5.2km` is none"]);
    expect(item({ ...WORKOUT, energy: "about 300 kcal" })).toEqual(["`energy` is a number, a space and its unit, such as `5.2 km`: `about 300 kcal` is none"]);
  });
});
