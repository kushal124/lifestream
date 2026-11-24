import { describe, expect, it } from "vitest";
import { madeStart, monthsBefore, START_SPAN, startOf, startRule, startSetRule } from "./start.js";

const NOW = Date.UTC(2026, 10, 19, 12);
const BACKFILLS = { id: "gmail", backfill: { about: "Collects the emails already in your mailbox." } };
const LIVE = { id: "location" };

describe("the start", () => {
  it("a day runs from its UTC midnight; all is no start; settings that hold none run at all", () => {
    expect(startOf({ history: { start: "2026-05-19" }, connectors: {} }, BACKFILLS, NOW)).toEqual({ day: "2026-05-19", ms: Date.UTC(2026, 4, 19), own: false });
    expect(startOf({ history: { start: "all" }, connectors: {} }, BACKFILLS, NOW)).toEqual({ day: null, ms: null, own: false });
  });

  it("a stream's own start wins over the home's, either way, and only where its connector reads history", () => {
    const settings = (own: string) => ({ history: { start: "2026-05-19" }, connectors: { gmail: { start: own }, location: { start: own } } });
    expect(startOf(settings("2019-01-01"), BACKFILLS, NOW)).toEqual({ day: "2019-01-01", ms: Date.UTC(2019, 0, 1), own: true });
    expect(startOf(settings("all"), BACKFILLS, NOW)).toEqual({ day: null, ms: null, own: true });
    expect(startOf(settings("2026-10-01"), BACKFILLS, NOW)).toEqual({ day: "2026-10-01", ms: Date.UTC(2026, 9, 1), own: true });
    expect(startOf(settings("2019-01-01"), LIVE, NOW)).toEqual({ day: "2026-05-19", ms: Date.UTC(2026, 4, 19), own: false });
    expect(startOf({ history: { start: "all" }, connectors: { gmail: { start: "lately" } } }, BACKFILLS, NOW)).toEqual({ day: null, ms: null, own: false });
  });

  it("a day after today runs as today, the UTC day, never a later instant", () => {
    const late = Date.UTC(2026, 10, 19, 23, 30);
    expect(startOf({ history: { start: "2027-01-01" }, connectors: {} }, BACKFILLS, late)).toEqual({ day: "2026-11-19", ms: Date.UTC(2026, 10, 19), own: false });
    expect(startOf({ history: { start: "2026-11-20" }, connectors: { gmail: { start: "2030-01-01" } } }, BACKFILLS, late).ms).toBeLessThanOrEqual(late);
  });

  it("its rule takes all or a real day; a day after today is refused only where it is set", () => {
    for (const value of ["all", "2019-01-01", "2026-11-19", "2030-01-01"]) expect([value, startRule(value)]).toEqual([value, null]);
    for (const value of ["none", "90d", "2019-02-30", "2019-1-1", "", 7, null]) expect([value, startRule(value)]).toEqual([value, "is all or a day (2026-05-19)"]);
    expect(startSetRule("2026-11-19", NOW)).toBeNull();
    expect(startSetRule("all", NOW)).toBeNull();
    expect(startSetRule("2026-11-20", NOW)).toBe("is after today (2026-11-19): a start is a day already begun");
    expect(startSetRule("90d", NOW)).toBe("is all or a day (2026-05-19)");
  });

  it("a new home starts six months before the day it is made, in its zone and day start, on the month's last day where the day is past it", () => {
    expect(START_SPAN).toEqual({ months: 6 });
    expect(madeStart(NOW, { zone: "UTC", day_start_hour: 4 })).toBe("2026-05-19");
    expect(madeStart(Date.UTC(2026, 10, 19, 2), { zone: "UTC", day_start_hour: 4 })).toBe("2026-05-18");
    expect(madeStart(Date.UTC(2026, 10, 18, 20), { zone: "Asia/Kolkata", day_start_hour: 0 })).toBe("2026-05-19");
    expect(madeStart(Date.UTC(2026, 7, 31, 12), { zone: "UTC", day_start_hour: 0 })).toBe("2026-02-28");
    expect(madeStart(Date.UTC(2028, 7, 31, 12), { zone: "UTC", day_start_hour: 0 })).toBe("2028-02-29");
    expect(madeStart(Date.UTC(2026, 2, 15, 12), { zone: "UTC", day_start_hour: 0 })).toBe("2025-09-15");
    expect([monthsBefore("2026-11-19", 1), monthsBefore("2026-03-31", 1), monthsBefore("2026-11-19", 120)]).toEqual(["2026-10-19", "2026-02-28", "2016-11-19"]);
  });
});
