import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addDays, civilDay, dayBounds, dayRuns, instant, TimeError, type DayRun, type DaySettings } from "@lifestreamprotocol/core";
import { CLOCK_FIRST, CLOCK_YEARS, clockId, clockOf, homeClock, readTime, timeOf, timeParameter } from "./home-clock.js";
import { Refusal } from "./refusal.js";

const LONDON: DaySettings = { zone: "Europe/London", day_start_hour: 4 };
const NEW_YORK: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
const utc = (iso: string): number => Date.parse(iso);

describe("the clock", () => {
  it("names each clock of the case file by the id the case file states", () => {
    const file = JSON.parse(readFileSync(new URL("../core/test/clock-cases.json", import.meta.url), "utf8")) as {
      clocks: { name: string; clock: { id: string; zone: string; start_hour: number; runs: DayRun[] } }[];
    };
    expect(file.clocks.length).toBeGreaterThan(5);
    for (const { name, clock } of file.clocks) expect(clockId(clock.zone, clock.start_hour, clock.runs), name).toBe(clock.id);
  });

  it("covers 1970 to the tenth year after the start, and a new start hour is a new id", () => {
    const clock = homeClock(LONDON);
    const end = `${new Date().getUTCFullYear() + CLOCK_YEARS}-12-31`;
    const last = clock.runs.at(-1)!;
    expect([clock.runs[0]!.day, CLOCK_FIRST, addDays(last.day, last.days - 1)]).toEqual(["1970-01-01", "1970-01-01", end]);
    expect(clock).toEqual({ id: clockId("Europe/London", 4, clock.runs), zone: "Europe/London", start_hour: 4, runs: dayRuns("1970-01-01", end, LONDON) });
    expect(clock.id).toMatch(/^[0-9a-f]{16}$/u);
    expect(clockOf(LONDON, end).id).toBe(clock.id);
    expect(clockOf({ zone: "Europe/London", day_start_hour: 6 }, end).id).not.toBe(clock.id);
  });
});

describe("a time parameter's forms", () => {
  it("reads whole milliseconds, an instant with its offset, a home-local time, a day and a clock in a day as core reads each", () => {
    const at = (ms: number) => ({ start_ms: ms, end_ms: ms + 1, day: false });
    const whole = (start: number, end: number) => ({ start_ms: start, end_ms: end, day: true });
    const nine = utc("2026-10-07T08:00:00Z");
    expect(timeOf(String(nine), LONDON)).toEqual(at(nine));
    expect(timeOf("2026-10-07T09:00+05:30", LONDON)).toEqual(at(utc("2026-10-07T03:30:00Z")));
    expect(timeOf("2026-10-07T08:00Z", LONDON).start_ms).toBe(nine);
    for (const local of ["2026-10-07T09:00", "2026-10-07 09:00", "2026-10-07T09:00:00"]) expect(timeOf(local, LONDON)).toEqual(at(nine));
    expect(timeOf("2026-10-07T09:00:30.250", LONDON).start_ms).toBe(nine + 30_250);
    expect(timeOf("2026-10-07", LONDON)).toEqual(whole(...spanOf("2026-10-07", LONDON)));
    expect(timeOf("01:30", LONDON, "2026-10-07")).toEqual(at(utc("2026-10-08T00:30:00Z")));
    expect(timeOf("04:00", LONDON, "2026-10-07").start_ms).toBe(dayBounds("2026-10-07", LONDON).start_ms);
    expect(civilDay(timeOf("23:59:59", LONDON, "2026-10-07").start_ms, LONDON)).toBe("2026-10-07");
    expect(timeOf("2026-10-24", LONDON)).toEqual(whole(utc("2026-10-24T03:00:00Z"), utc("2026-10-25T04:00:00Z")));
    expect(timeOf("2026-03-28", LONDON)).toEqual(whole(utc("2026-03-28T04:00:00Z"), utc("2026-03-29T03:00:00Z")));
  });

  it("reads a local time in a clock change's gap or overlap as core's local reading does", () => {
    for (const local of ["2026-03-08T02:30", "2026-11-01T01:30"]) {
      const ms = instant(local, "local", { zone: NEW_YORK.zone }).start_ms;
      expect(timeOf(local, NEW_YORK)).toEqual({ start_ms: ms, end_ms: ms + 1, day: false });
    }
    expect(timeOf("2026-11-01T01:30", NEW_YORK).start_ms).toBe(utc("2026-11-01T05:30:00Z"));
    expect(timeOf("02:30", NEW_YORK, "2026-03-07").start_ms).toBe(instant("2026-03-08T02:30", "local", { zone: NEW_YORK.zone }).start_ms);
  });

  it("reads whole milliseconds as the routes always did, whatever their year; a span is what was named", () => {
    expect(timeOf("-9999999999999", LONDON)).toEqual({ start_ms: -9_999_999_999_999, end_ms: -9_999_999_999_998, day: false });
    expect(timeOf("9007199254740990", LONDON).start_ms).toBe(9_007_199_254_740_990);
    expect(timeOf("2026-10-07", LONDON)).toEqual({ ...dayBounds("2026-10-07", LONDON), day: true });
  });

  it("refuses what no form reads, and a clock with no day", () => {
    for (const value of ["yesterday", "", "2026-02-30", "2026-10-07T25:00", "2026-10-07T09:00+25:00", "9:00", "12345678901234567", "9007199254740993", "2026-10"]) {
      expect(() => timeOf(value, LONDON), JSON.stringify(value)).toThrow(TimeError);
    }
    expect(() => timeOf("01:30", LONDON)).toThrow(/name the day with in/u);
    expect(() => timeOf("01:30", LONDON, "2026-13-01")).toThrow(TimeError);
  });

  it("refuses a value it cannot read naming the parameter, its forms and why, and a day where a moment is named", () => {
    const refusal = (read: () => unknown): string => {
      try {
        read();
      } catch (error) {
        if (error instanceof Refusal && error.status === 422 && error.code === "BAD_PARAMETER") return error.words;
        throw error;
      }
      throw new Error("not refused");
    };
    const words = refusal(() => readTime("from", "2026-02-30T09:00", LONDON));
    expect(words).toMatch(/^from is whole milliseconds since the epoch, .* or a day \(2026-10-07\): /u);
    expect(words).toMatch(/2026-02-30 09:00:00 is not a calendar date and clock$/u);
    expect(refusal(() => readTime("at", "01:30", LONDON))).toMatch(/name the day with in$/u);
    const day = dayBounds("2026-10-07", LONDON);
    expect([timeParameter("from", "2026-10-07", LONDON, "start"), timeParameter("to", "2026-10-07", LONDON, "end")]).toEqual([day.start_ms, day.end_ms]);
    expect(timeParameter("to", "2026-10-07T09:00", LONDON, "end")).toBe(utc("2026-10-07T08:00:00Z"));
    expect(timeParameter("at", "2026-10-07T09:00", LONDON, "moment")).toBe(utc("2026-10-07T08:00:00Z"));
    expect(refusal(() => timeParameter("at", "2026-10-07", LONDON, "moment"))).toBe("at names a moment, not a day");
  });
});

function spanOf(day: string, settings: DaySettings): [number, number] {
  const bounds = dayBounds(day, settings);
  return [bounds.start_ms, bounds.end_ms];
}
