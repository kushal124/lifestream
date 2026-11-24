import { describe, expect, it } from "vitest";
import type { DaySettings } from "@lifestreamprotocol/core";
import { dayFacts } from "../days.js";
import { collectionsFault } from "../family.js";
import { FED } from "../test/fed.js";
import { factsConform, insertKeepsFacts } from "../test/facts.js";
import { dayInput, type Content } from "../test/day-input.js";
import { screenFamily, type SittingContent } from "./family.js";

const SETTINGS: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
const SCREEN = screenFamily({ zone: SETTINGS.zone })(FED.screen);
const MACHINE = "macbook-pro-0001";
const at = (local: string) => Date.parse(`${local}-04:00`);

function sitting(start: string, end: string, apps: [string, number][], closed = true): Content {
  const [start_ms, end_ms] = [at(start), at(end)];
  const content: SittingContent = closed
    ? { machine: MACHINE, start_ms, end_ms, closed: true, frames: 10, text_missing: 0, apps, blocks: [] }
    : { machine: MACHINE, start_ms, end_ms, closed: false };
  return { unit: `${MACHINE}/${start_ms}`, content, start_ms, end_ms };
}

const RECORD: Content[] = [
  sitting("2026-10-25T03:00", "2026-10-25T05:00", [["Safari", 3600], ["Mail", 1800], ["Notes", 0]]),
  sitting("2026-10-25T10:00", "2026-10-25T11:00", [["Xcode", 1800], ["Terminal", 900], ["Safari", 600]]),
  sitting("2026-10-25T20:00", "2026-10-25T20:30", [], false),
];
const input = (day: string, contents: readonly Content[] = RECORD) => dayInput(SCREEN, day, contents, SETTINGS);

describe("screen facts", () => {
  it("declares collections that hold together", () => {
    expect(collectionsFault([SCREEN])).toEqual([]);
  });

  it("a sitting with three apps is three facts, each citing the sitting's one line", () => {
    const projection = SCREEN.day(input("2026-10-25"));
    const morning = projection.facts.filter((fact) => fact.from.units.includes(`${MACHINE}/${at("2026-10-25T10:00")}`));
    expect(morning.map((fact) => [fact.keys["app"], fact.measures["minutes"]])).toEqual([["Xcode", 30], ["Terminal", 15], ["Safari", 10]]);
    expect(new Set(morning.map((fact) => fact.lines.join())).size).toBe(1);
    expect(projection.lines[morning[0]!.lines[0]!]!.start_ms).toBe(at("2026-10-25T10:00"));
    expect(new Set(morning.map((fact) => fact.id)).size).toBe(3);
    expect(morning[0]!.keys).toEqual({ app: "Xcode", machine: MACHINE });
  });

  it("an app's minutes stay whole at the sitting's start across the day's edge, stated by that day alone; no seconds and an open sitting state none", () => {
    const before = dayFacts(SCREEN, SCREEN.day(input("2026-10-24")), "2026-10-24", SETTINGS, (line) => line);
    const after = dayFacts(SCREEN, SCREEN.day(input("2026-10-25")), "2026-10-25", SETTINGS, (line) => line);
    expect(Object.fromEntries(before.map((fact) => [fact.keys["app"], fact.measures]))).toEqual({ Safari: { minutes: 60 }, Mail: { minutes: 30 } });
    expect(after.filter((fact) => before.some((each) => each.id === fact.id))).toEqual([]);
    expect(after.filter((fact) => fact.keys["app"] === "Notes")).toEqual([]);
    expect(after).toHaveLength(3);
  });

  it("holds to F1's conformance: order, one day's statement and an inserted line", () => {
    expect(factsConform(SCREEN, ["2026-10-24", "2026-10-25"].map((day) => input(day)))).toEqual([]);
    const earlier = sitting("2026-10-25T08:00", "2026-10-25T08:20", [["Messages", 600]]);
    expect(insertKeepsFacts(SCREEN, input("2026-10-25"), input("2026-10-25", [earlier, ...RECORD]))).toEqual([]);
  });
});
