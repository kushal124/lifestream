import { describe, expect, it } from "vitest";
import type { Witness } from "@lifestreamprotocol/core";
import { AT_MS, statedOf } from "../test/stated.js";
import { physicalFaults } from "./faults.js";

const said = (member: string, value: object) => physicalFaults(statedOf<Witness>({}, member, value));
const FIX = { at_ms: AT_MS, latitude: 51.5, longitude: -0.12, accuracy_m: 12, altitude_m: 20, speed_mps: null };
const MOTION = { at_ms: AT_MS, stationary: true, walking: false, running: false, automotive: false, cycling: false, unknown: false };
const ACTIVITY = { start_ms: AT_MS, end_ms: AT_MS + 600_000, stated: "WALKING", mode: "walk", distance_m: 800, from: null, to: null };

describe("physicalFaults", () => {
  it("passes each value that keeps every rule", () => {
    expect(said("fix", { ...FIX, at_ms: AT_MS + 14 * 60_000 })).toEqual([]);
    expect(said("motion", MOTION)).toEqual([]);
    expect(said("visit", { start_ms: AT_MS, end_ms: AT_MS, centre: { latitude: 51.5, longitude: -0.12 }, place: null })).toEqual([]);
    expect(said("activity", ACTIVITY)).toEqual([]);
    expect(said("report", { at_ms: AT_MS, form: "mood", items: [{ id: "mood", value: 4, scale: 5 }, { id: "note", value: "fine", scale: 0 }], note: null })).toEqual([]);
    expect(said("vigilance", { at_ms: AT_MS, completed: true, trials: [{ outcome: "response", rt_ms: 0 }, { outcome: "timeout" }] })).toEqual([]);
  });

  it("names each rule a value breaks", () => {
    expect(said("fix", { ...FIX, at_ms: AT_MS + 20 * 60_000 })).toEqual([`a fix's \`at_ms\` is its record's time, within 15 minutes: ${AT_MS + 20 * 60_000} is 20 minutes from ${AT_MS}`]);
    expect(said("motion", { ...MOTION, at_ms: AT_MS - 60 * 60_000 })).toEqual([`a motion's \`at_ms\` is its record's time, within 15 minutes: ${AT_MS - 60 * 60_000} is -60 minutes from ${AT_MS}`]);
    expect(said("visit", { start_ms: AT_MS, end_ms: AT_MS - 1, centre: { latitude: 51.5, longitude: -0.12 }, place: null })).toEqual([`a visit's \`end_ms\` is at or after its \`start_ms\`: ${AT_MS - 1} is before ${AT_MS}`]);
    expect(said("activity", { ...ACTIVITY, end_ms: AT_MS })).toEqual([`an activity's \`end_ms\` is after its \`start_ms\`: ${AT_MS} is not after ${AT_MS}`]);
    expect(said("activity", { ...ACTIVITY, mode: "run" })).toEqual(["`mode` is one of `walk`, `cycle`, `road_vehicle`, `flight`: `run` is none"]);
    expect(said("report", { at_ms: AT_MS, form: "mood", items: [{ id: "mood", value: 4, scale: 0 }], note: null })).toEqual(["a number answer's `scale` is more than 0, the value printed as `value/scale`: mood's is 0"]);
    expect(said("vigilance", { at_ms: AT_MS, completed: true, trials: [{ outcome: "response", rt_ms: -20 }] })).toEqual(["a response's `rt_ms` is 0 or more: -20 is not"]);
  });
});
