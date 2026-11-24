import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  addDays,
  civilDay,
  dayBounds,
  dayRuns,
  daysOf,
  instant,
  instantIn,
  offsetMinutes,
  render,
  span,
  TimeError,
  type DayRun,
  type TimeOptions,
  type TimeRule,
} from "./time.js";
import { canonical } from "./format.js";
import type { DaySettings, Instant, Json } from "./types.js";

const H = 3_600_000;
const utc = (iso: string): number => {
  const ms = Date.parse(iso);
  if (!Number.isSafeInteger(ms)) throw new Error(`bad fixture ${iso}`);
  return ms;
};
const day0 = (zone: string): DaySettings => ({ zone, day_start_hour: 0 });
const day4 = (zone: string): DaySettings => ({ zone, day_start_hour: 4 });

function refused(run: () => unknown, code?: TimeError["code"]): TimeError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TimeError);
    if (code !== undefined) expect((error as TimeError).code).toBe(code);
    return error as TimeError;
  }
  throw new Error("expected a TimeError, nothing was thrown");
}

describe("time: what must be impossible", () => {
  it("a spelling read wrong by an hour across a DST change", () => {
    const ny = { zone: "America/New_York" };
    expect(instant("2026-03-08T01:30:00", "local", ny).start_ms).toBe(utc("2026-03-08T06:30:00Z"));
    expect(instant("2026-03-08T03:30:00", "local", ny).start_ms).toBe(utc("2026-03-08T07:30:00Z"));
    expect(instant("2026-03-08T02:30:00", "local", ny).start_ms).toBe(utc("2026-03-08T07:30:00Z"));
    expect(instant("2026-11-01T01:30:00", "local", ny).start_ms).toBe(utc("2026-11-01T05:30:00Z"));
    expect(instant("2026-11-01T02:30:00", "local", ny).start_ms).toBe(utc("2026-11-01T07:30:00Z"));
    const london = { zone: "Europe/London" };
    expect(instant("2026-03-29 00:30", "local", london).start_ms).toBe(utc("2026-03-29T00:30:00Z"));
    expect(instant("2026-03-29 02:30", "local", london).start_ms).toBe(utc("2026-03-29T01:30:00Z"));
    expect(instant("2026-10-25T01:30:00+01:00", "rfc3339").start_ms).toBe(utc("2026-10-25T00:30:00Z"));
    expect(instant("2026-10-25T01:30:00+00:00", "rfc3339").start_ms).toBe(utc("2026-10-25T01:30:00Z"));
    expect(instant("2026-10-25 01:30:00 +0100", "healthkit").start_ms).toBe(utc("2026-10-25T00:30:00Z"));
    expect(instant("Sun, 25 Oct 2026 01:30:00 +0000", "rfc2822").start_ms).toBe(utc("2026-10-25T01:30:00Z"));
    expect(instant("20260307T120000", "ical", ny).start_ms).toBe(utc("2026-03-07T17:00:00Z"));
    expect(instant("20260309T120000", "ical", ny).start_ms).toBe(utc("2026-03-09T16:00:00Z"));
  });

  it("a naive time read without a zone", () => {
    refused(() => instant("2026-10-03T14:05:09", "local", {} as never), "naive");
    refused(() => instant("20261003T140509", "ical"), "naive");
    refused(() => instant("Sat Oct  3 14:05:09 2026", "mbox"), "naive");
    refused(() => instant("2026-10-03T14:05:09", "rfc3339", { zone: "Asia/Kolkata" }), "spelling");
    refused(() => instant("2026-10-03T14:05:09+05:30", "local", { zone: "Asia/Kolkata" }), "spelling");
    expect(instant("2026-10-03T14:05:09", "local", { zone: "Asia/Kolkata" })).toEqual({
      start_ms: utc("2026-10-03T08:35:09Z"),
      precision: "s",
    });
    expect(instant("2026-10-03T14:05:09", "local", { offset: "+05:30" })).toEqual({
      start_ms: utc("2026-10-03T08:35:09Z"),
      offset_min: 330,
      precision: "s",
    });
  });

  it("an Apple epoch off by 978307200 s", () => {
    expect(instant(1, "apple-s").start_ms).toBe(978_307_201_000);
    expect(instant(781_187_109, "apple-s").start_ms).toBe(utc("2025-10-03T12:25:09Z"));
    expect(instant(781_187_109.5, "apple-s").start_ms).toBe(utc("2025-10-03T12:25:09.500Z"));
    expect(instant("781187109123456789", "apple-ns").start_ms).toBe(utc("2025-10-03T12:25:09.123Z"));
    expect(instant(781_187_109_123_456_789, "apple-ns").start_ms).toBe(utc("2025-10-03T12:25:09.123Z"));
    expect(instant(781_187_109, "unix-s").start_ms).toBe(utc("1994-10-03T12:25:09Z"));
    expect(instant(-86_400, "apple-s").start_ms).toBe(utc("2000-12-31T00:00:00Z"));
    refused(() => instant(0, "apple-s"), "zero");
    refused(() => instant("0", "apple-ns"), "zero");
    refused(() => instant(0, "unix-ms"), "zero");
    refused(() => instant(0.0, "unix-s"), "zero");
  });

  it("a date-only value shifted to the previous day in a negative-offset zone", () => {
    const date = instant("2026-09-03", "date");
    expect(date).toEqual({
      start_ms: utc("2026-09-03T00:00:00Z"),
      end_ms: utc("2026-09-04T00:00:00Z"),
      precision: "day",
    });
    for (const zone of ["America/Los_Angeles", "Pacific/Pago_Pago", "Pacific/Kiritimati", "Asia/Kolkata", "-11:00"]) {
      expect(daysOf(date, day4(zone))).toEqual(["2026-09-03"]);
      expect(daysOf(date, day0(zone))).toEqual(["2026-09-03"]);
      expect(render(date.start_ms, zone, "day")).toBe("2026-09-03");
    }
    expect(instant("03/09/26", "dmy", { century: 2000 }).start_ms).toBe(date.start_ms);
    expect(instant("03/09/2026", "dmy").start_ms).toBe(date.start_ms);
    expect(instant("20260903", "ical").start_ms).toBe(date.start_ms);
    expect(instant("2026-09-03", "date", { zone: "America/Los_Angeles", offset: "-07:00" })).toEqual(date);
    const trip = span(instant("2026-09-03", "date"), instant("2026-09-05", "date"));
    expect(trip).toEqual({ start_ms: date.start_ms, end_ms: utc("2026-09-06T00:00:00Z"), precision: "day" });
    expect(daysOf(trip, day4("America/Los_Angeles"))).toEqual(["2026-09-03", "2026-09-04", "2026-09-05"]);
    expect(daysOf(instant("2026-09", "month"), day4("America/Los_Angeles"))).toEqual([]);
    expect(daysOf(instant("2026", "year"), day4("America/Los_Angeles"))).toEqual([]);
  });

  it("a span over midnight placed on one day", () => {
    const night = span(
      instant("2026-10-03T22:00:00+05:30", "rfc3339"),
      instant("2026-10-04T02:00:00+05:30", "rfc3339"),
    );
    expect(daysOf(night, day0("Asia/Kolkata"))).toEqual(["2026-10-03", "2026-10-04"]);
    expect(daysOf(night, day4("Asia/Kolkata"))).toEqual(["2026-10-03"]);
    const toBoundary = span(
      instant("2026-10-03T22:00:00+05:30", "rfc3339"),
      instant("2026-10-04T04:00:00+05:30", "rfc3339"),
    );
    expect(daysOf(toBoundary, day4("Asia/Kolkata"))).toEqual(["2026-10-03"]);
    expect(daysOf(instant("2026-10-04T04:00:00+05:30", "rfc3339"), day4("Asia/Kolkata"))).toEqual(["2026-10-04"]);
    expect(daysOf(instant("2026-10-04T03:59:59.999+05:30", "rfc3339"), day4("Asia/Kolkata"))).toEqual(["2026-10-03"]);
    const long = span(instant("2026-10-01T12:00:00Z", "rfc3339"), instant("2026-10-03T12:00:00Z", "rfc3339"));
    expect(daysOf(long, day0("UTC"))).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    refused(() => span(instant("2026-10-04T00:00:00Z", "rfc3339"), instant("2026-10-03T00:00:00Z", "rfc3339")), "order");
    refused(() => span(instant("2026-10-03", "date"), instant("2026-10-03T00:00:00Z", "rfc3339")), "order");
  });

  it("a 23 h or 25 h civil day computed as 24 h", () => {
    const length = (day: string, settings: DaySettings) => {
      const bounds = dayBounds(day, settings);
      return (bounds.end_ms - bounds.start_ms) / H;
    };
    expect(length("2026-03-07", day4("America/New_York"))).toBe(23);
    expect(length("2026-03-08", day4("America/New_York"))).toBe(24);
    expect(length("2026-10-31", day4("America/New_York"))).toBe(25);
    expect(length("2026-03-28", day4("Europe/London"))).toBe(23);
    expect(length("2026-10-24", day4("Europe/London"))).toBe(25);
    expect(length("2026-03-08", day0("America/New_York"))).toBe(23);
    expect(length("2026-11-01", day0("America/New_York"))).toBe(25);
    expect(length("2026-10-04", day0("Australia/Lord_Howe"))).toBe(23.5);
    expect(dayBounds("2018-11-04", day0("America/Sao_Paulo"))).toEqual({
      start_ms: utc("2018-11-04T03:00:00Z"),
      end_ms: utc("2018-11-05T02:00:00Z"),
    });
    expect(length("2026-10-03", day4("Asia/Kolkata"))).toBe(24);
    expect(dayBounds("2026-10-03", day4("Asia/Kolkata"))).toEqual({
      start_ms: utc("2026-10-02T22:30:00Z"),
      end_ms: utc("2026-10-03T22:30:00Z"),
    });
    expect(dayBounds("9999-12-31", day4("Asia/Kolkata"))).toEqual({
      start_ms: utc("9999-12-30T22:30:00Z"),
      end_ms: utc("9999-12-31T22:30:00Z"),
    });
    expect(dayRuns("9999-12-30", "9999-12-31", day4("Asia/Kolkata"))).toEqual([{ day: "9999-12-30", start_ms: utc("9999-12-29T22:30:00Z"), days: 2, zone: "Asia/Kolkata" }]);
    for (const settings of [day4("America/New_York"), day0("America/Sao_Paulo"), day0("Australia/Lord_Howe")]) {
      for (let day = "2026-02-25"; day <= "2026-11-10"; day = addDays(day, 1)) {
        const bounds = dayBounds(day, settings);
        expect(dayBounds(addDays(day, 1), settings).start_ms).toBe(bounds.end_ms);
        expect(civilDay(bounds.start_ms, settings)).toBe(day);
        expect(civilDay(bounds.end_ms - 1, settings)).toBe(day);
      }
    }
  });

  it("a precision overstated", () => {
    const precision = (value: string | number, rule: TimeRule, opts?: TimeOptions) =>
      instant(value, rule as "rfc3339", opts).precision;
    expect(precision("2026-10-03T14:05+05:30", "rfc3339")).toBe("minute");
    expect(precision("2026-10-03T14:05:09+05:30", "rfc3339")).toBe("s");
    expect(precision("2026-10-03T14:05:09.5Z", "rfc3339")).toBe("s");
    expect(instant("2026-10-03T14:05:09.5Z", "rfc3339").start_ms).toBe(utc("2026-10-03T14:05:09.500Z"));
    expect(precision("2026-10-03T14:05:09.123Z", "rfc3339")).toBe("ms");
    expect(instant("2026-10-03T14:05:09.123999Z", "rfc3339")).toEqual({
      start_ms: utc("2026-10-03T14:05:09.123Z"),
      precision: "ms",
    });
    expect(precision("Sat, 3 Oct 2026 14:05 +0530", "rfc2822")).toBe("minute");
    expect(precision("Sat, 3 Oct 2026 14:05:09 +0530", "rfc2822")).toBe("s");
    expect(precision(1_791_025_509, "unix-s")).toBe("s");
    expect(precision("1791025509.123456", "unix-s")).toBe("ms");
    expect(precision(1_791_025_509_123, "unix-ms")).toBe("ms");
    expect(precision(781_187_109, "apple-s")).toBe("s");
    expect(precision(781_187_109.25, "apple-s")).toBe("s");
    expect(precision(781_187_109.125, "apple-s")).toBe("ms");
    expect(precision("20261003T083509Z", "ical")).toBe("s");
    expect(precision("2026-10-03", "date")).toBe("day");
    expect(precision("2026-10", "month")).toBe("month");
    expect(precision("2026", "year")).toBe("year");
    const ms = utc("2026-10-03T08:35:09.123Z");
    expect(render(ms, "Asia/Kolkata", "ms")).toBe("2026-10-03 14:05:09.123");
    expect(render(ms, "Asia/Kolkata", "s")).toBe("2026-10-03 14:05:09");
    expect(render(ms, "Asia/Kolkata", "minute")).toBe("2026-10-03 14:05");
    expect(render(utc("2026-10-01T00:00:00Z"), "Asia/Kolkata", "month")).toBe("2026-10");
    expect(render(utc("2026-01-01T00:00:00Z"), "Asia/Kolkata", "year")).toBe("2026");
  });

  it("render printing a different date than civilDay", () => {
    const zones = ["Asia/Kolkata", "America/New_York", "Europe/London", "Australia/Lord_Howe",
      "Pacific/Kiritimati", "Pacific/Pago_Pago", "Asia/Kathmandu", "UTC", "+05:30", "-03:00"];
    const instants = [
      "2026-10-03T18:29:59.999Z", "2026-10-03T18:30:00Z", "2026-10-03T23:59:59Z", "2026-10-04T00:00:00Z",
      "2026-03-08T04:59:59Z", "2026-03-08T05:00:00Z", "2026-03-08T06:59:59Z", "2026-03-08T07:00:00Z",
      "2026-11-01T04:00:00Z", "2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z",
      "2026-10-03T13:29:59Z", "2026-10-03T13:30:00Z", "2026-10-04T10:00:00Z", "2026-10-04T11:00:00Z",
    ].map(utc);
    for (const zone of zones) {
      for (const ms of instants) {
        expect(render(ms, zone, "minute").slice(0, 10)).toBe(civilDay(ms, day0(zone)));
      }
    }
    const late = utc("2026-10-03T20:00:00Z");
    expect(civilDay(late, day4("Asia/Kolkata"))).toBe("2026-10-03");
    expect(render(late, "Asia/Kolkata", "minute", "2026-10-03")).toBe("2026-10-04 01:30");
    expect(render(late, "Asia/Kolkata", "minute", "2026-10-04")).toBe("01:30");
    const date = instant("2026-10-04", "date");
    for (const zone of zones) expect(render(date.start_ms, zone, "day")).toBe("2026-10-04");
  });

  it("a garbage value accepted", () => {
    const garbage: [string | number, TimeRule, TimeOptions?][] = [
      ["", "rfc3339"], ["yesterday", "rfc3339"], ["2026-10-03", "rfc3339"],
      ["2026-02-29T00:00:00Z", "rfc3339"], ["2026-13-01T00:00:00Z", "rfc3339"],
      ["2026-10-03T24:00:00Z", "rfc3339"], ["2026-10-03T14:60:00Z", "rfc3339"],
      ["2026-10-03T14:05:60Z", "rfc3339"], ["2026-10-03T14:05:09+24:00", "rfc3339"],
      ["2026-10-03T14:05:09+0530", "rfc3339"], [" 2026-10-03T14:05:09Z", "rfc3339"],
      ["0999-10-03T14:05:09Z", "rfc3339"], [1_791_025_509, "rfc3339"],
      ["2026-10-03T14:05:09", "local", { zone: "Mars/Olympus_Mons" }],
      ["2026-10-03T14:05:09", "local", { offset: "IST" }],
      ["2026-10-03T14:05:09+05:30", "rfc3339", { offset: "-04:00" }],
      ["2026-02-30", "date"], ["2026-1-03", "date"], ["03-10-2026", "date"], ["2026-00", "month"],
      ["26", "year"], ["0000", "year"], ["32/10/26", "dmy", { century: 2000 }],
      ["03/10/26", "dmy"], ["03/10/26", "dmy", { century: 1950 }], ["3/10/2026", "dmy"],
      ["Sat, 32 Oct 2026 14:05:09 +0530", "rfc2822"], ["Sat, 3 Okt 2026 14:05:09 +0530", "rfc2822"],
      ["Sat, 3 Oct 2026 14:05:09 IST", "rfc2822"], ["Sat, 3 Oct 2026 14:05:09 +05:30", "rfc2822"],
      ["Sat, 3 Oct 2026", "rfc2822"], ["Sat Oct  3 14:05:09 +0000", "mbox"],
      ["2026-10-03 14:05:09 +05:30", "healthkit"], ["2026-10-03T14:05:09+0530", "healthkit"],
      ["20261003T1405Z", "ical"], ["2026-10-03", "ical"],
      [Number.NaN, "unix-ms"], [Number.POSITIVE_INFINITY, "unix-s"], ["1e400", "unix-s"],
      ["0x10", "unix-ms"], ["12abc", "unix-ms"], [" 1791025509", "unix-s"],
      [1.791025509123e15, "unix-s"], [1.791025509123e18, "unix-ms"], ["", "apple-ns"],
    ];
    for (const [value, rule, opts] of garbage) {
      const error = refused(() => instant(value, rule as "rfc3339", opts));
      expect(error.message.length).toBeGreaterThan(0);
    }
    refused(() => civilDay(0, { zone: "Mars/Olympus_Mons", day_start_hour: 4 }), "zone");
    refused(() => civilDay(utc("2026-10-03T00:00:00Z"), { zone: "Asia/Kolkata", day_start_hour: 24 }), "settings");
    refused(() => civilDay(Number.NaN, day4("Asia/Kolkata")), "range");
    refused(() => dayBounds("2026-02-29", day4("Asia/Kolkata")), "calendar");
    refused(() => addDays("2026-10-3", 1), "spelling");
    refused(() => addDays("2026-10-03", 0.5), "range");
    refused(() => render(1.5, "Asia/Kolkata", "s"), "range");
    refused(() => render(0, "Asia/Kolkata", "fortnight" as never), "spelling");
  });

  it("an export's own spelling read only by a regex its connector writes, or a pattern read loosely", () => {
    const strava = { pattern: "MMM d, yyyy, h:mm:ss a" };
    expect(instant("Oct 1, 2024, 11:35:00 AM", strava, { zone: "UTC" })).toEqual({ start_ms: utc("2024-10-01T11:35:00Z"), precision: "s" });
    expect(instant("Oct 01, 2024, 11:35:00\u202fpm", strava, { zone: "UTC" }).start_ms).toBe(utc("2024-10-01T23:35:00Z"));
    expect(instant("Oct 1, 2024, 12:05:00 AM", strava, { zone: "UTC" }).start_ms).toBe(utc("2024-10-01T00:05:00Z"));
    expect(instant("Oct 1, 2024, 12:05:00 PM", strava, { zone: "UTC" }).start_ms).toBe(utc("2024-10-01T12:05:00Z"));
    expect(instant("3/8/2026 3:30 AM", { pattern: "M/d/yyyy h:mm a" }, { zone: "America/New_York" })).toEqual(instant("2026-03-08T03:30", "local", { zone: "America/New_York" }));
    expect(instant("October 1, 2024", { pattern: "MMMM d, yyyy" })).toEqual(instant("2024-10-01", "date"));
    expect(instant("1 Sept 2024", { pattern: "d MMM yyyy" })).toEqual(instant("2024-09-01", "date"));
    expect(instant("Sep 2024", { pattern: "MMM yyyy" })).toEqual(instant("2024-09", "month"));
    expect(instant("2024-10-01 at 11:35 +0530", { pattern: "yyyy-MM-dd 'at' HH:mm XX" })).toEqual(instant("2024-10-01T11:35+05:30", "rfc3339"));
    expect(instant("2024-10-01T11:35:00.123Z", { pattern: "yyyy-MM-dd'T'HH:mm:ss.SSSXXX" })).toEqual(instant("2024-10-01T11:35:00.123Z", "rfc3339"));
    const clock = { pattern: "yyyy-MM-dd 'o''clock' HH:mm''" };
    expect(instant("2024-10-01 o'clock 11:35'", clock, { zone: "UTC" }).start_ms).toBe(utc("2024-10-01T11:35:00Z"));
    refused(() => instant("2024-10-01 oclock 11:35'", clock, { zone: "UTC" }), "spelling");
    expect(instant("Tue, 1 Oct 2024 11:35", { pattern: "EEE, d MMM yyyy HH:mm" }, { zone: "UTC" }).precision).toBe("minute");
    expect(instant("01.10.24 11:35", { pattern: "dd.MM.yy HH:mm" }, { century: 2000, offset: "+02:00" })).toEqual(instant("2024-10-01T11:35+02:00", "rfc3339"));
    const wrong: [string | number, string, TimeOptions | undefined, TimeError["code"]][] = [
      ["Oct 1, 2024, 13:35:00 PM", strava.pattern, { zone: "UTC" }, "calendar"],
      ["Oct 32, 2024, 11:35:00 AM", strava.pattern, { zone: "UTC" }, "calendar"],
      ["Okt 1, 2024, 11:35:00 AM", strava.pattern, { zone: "UTC" }, "spelling"],
      ["Oct 1, 2024, 11:35:00 AM UTC", strava.pattern, { zone: "UTC" }, "spelling"],
      [" Oct 1, 2024, 11:35:00 AM", strava.pattern, { zone: "UTC" }, "spelling"],
      ["Oct 1, 2024, 11:35:00 AM", strava.pattern, undefined, "naive"],
      [1_727_782_500, strava.pattern, { zone: "UTC" }, "spelling"],
      ["Wed, 1 Oct 2024 11:35", "EEE, d MMM yyyy HH:mm", { zone: "UTC" }, "calendar"],
      ["01.10.24 11:35", "dd.MM.yy HH:mm", { zone: "UTC" }, "century"],
      ["2024-10-01 11:35 +2400", "yyyy-MM-dd HH:mm XX", undefined, "offset"],
    ];
    for (const [value, pattern, opts, code] of wrong) refused(() => instant(value, { pattern }, opts), code);
    for (const [pattern, why] of [
      ["MMM d", "no year"], ["yyyy-MM-dd h:mm", "12-hour clock"], ["yyyy-MM-dd HH", "its hour and its minutes"], ["yyyy-MM-dd Q", "QQ".slice(1)],
      ["yyyy yyyy", "the year twice"], ["MM/dd/yyyy 'at HH:mm", "never closes"], ["EEE MMM yyyy", "a weekday (EEE) is read with its day"],
      ["MMM yyyy HH:mm", "a clock and no day"], ["yyyy-MM-dd at HH:mm", "quote literal text"],
    ] as const) {
      const error = (() => {
        try {
          instant("2024", { pattern });
        } catch (thrown) {
          return thrown as Error;
        }
        throw new Error(`${pattern} was read`);
      })();
      expect(error, pattern).not.toBeInstanceOf(TimeError);
      expect(error.message, pattern).toContain(why);
    }
  });

  it("the golden table reads and renders as recorded", () => {
    const path = fileURLToPath(new URL("./test/time-golden.json", import.meta.url));
    const zones = ["Asia/Kolkata", "America/New_York", "UTC"];
    const rows = GOLDEN_INPUTS.map(([value, rule, opts]) => {
      const read: Instant = instant(value, rule as "rfc3339", opts);
      return {
        value,
        rule,
        ...(opts === undefined ? {} : { opts }),
        instant: read,
        iso: new Date(read.start_ms).toISOString(),
        render: Object.fromEntries(zones.map((zone) => [zone, render(read.start_ms, zone, read.precision)])),
        days: daysOf(read, day4("Asia/Kolkata")),
      };
    });
    const text = `${JSON.stringify({ zones, day_settings: day4("Asia/Kolkata"), rows }, null, 2)}\n`;
    if (process.env.LIFESTREAM_UPDATE_GOLDEN === "1") writeFileSync(path, text);
    expect(text).toBe(readFileSync(path, "utf8"));
  });
});

const GOLDEN_INPUTS: [string | number, TimeRule, TimeOptions?][] = [
  ["2026-10-03T14:05:09+05:30", "rfc3339"],
  ["2026-10-03T14:05:09.123+05:30", "rfc3339"],
  ["2026-10-03T08:35:09.123Z", "rfc3339"],
  ["2026-10-03T08:35:09.123456Z", "rfc3339"],
  ["2026-10-03T08:35:09+00:00", "rfc3339"],
  ["2026-10-03T08:35:09-00:00", "rfc3339"],
  ["2026-10-03T08:35:09.123Z", "rfc3339", { offset: "+05:30" }],
  ["2026-10-03t04:35:09-04:00", "rfc3339"],
  ["2026-10-03 14:05:09+05:30", "rfc3339"],
  ["2026-10-03T14:05:09", "local", { zone: "Asia/Kolkata" }],
  ["2026-10-03 14:05", "local", { zone: "America/New_York" }],
  ["2026-10-03T14:05:09", "local", { zone: "+05:30" }],
  ["2026-10-03 14:05:09 +0530", "healthkit"],
  ["2026-10-03 04:35:09 -0400", "healthkit"],
  ["Sat, 3 Oct 2026 14:05:09 +0530 (IST)", "rfc2822"],
  ["Sat, 03 Oct 2026 08:35:09 GMT", "rfc2822"],
  ["3 Oct 2026 04:35 EDT", "rfc2822"],
  ["Sat, 3 Oct 26 08:35:09 -0000", "rfc2822"],
  ["Sat Oct  3 08:35:09 +0000 2026", "mbox"],
  ["20261003T083509Z", "ical"],
  ["20261003T140509", "ical", { zone: "Asia/Kolkata" }],
  ["20261003", "ical"],
  [812_709_309, "apple-s"],
  [812_709_309.123, "apple-s"],
  ["812709309123456789", "apple-ns"],
  [1_791_016_509, "unix-s"],
  ["1791016509", "unix-s"],
  [1_791_016_509.123456, "unix-s"],
  [1_791_016_509_123, "unix-ms"],
  ["2026-10-03", "date"],
  ["2026-10", "month"],
  ["2026", "year"],
  ["03/10/26", "dmy", { century: 2000 }],
  ["03/10/2026", "dmy"],
];


const DAY_MS = 24 * H;

interface Filed {
  day: string;
  start_ms: number;
  end_ms: number;
  zone: string;
}

function lookup(runs: readonly DayRun[], ms: number): Filed & { outside: boolean } {
  let at = 0;
  while (at + 1 < runs.length && runs[at + 1]!.start_ms <= ms) at += 1;
  const run = runs[at]!;
  const next = runs[at + 1];
  let k = Math.floor((ms - run.start_ms) / DAY_MS);
  if (next !== undefined) k = Math.min(k, run.days - 1);
  const start_ms = run.start_ms + k * DAY_MS;
  const end_ms = next !== undefined && k === run.days - 1 ? next.start_ms : start_ms + DAY_MS;
  return { day: addDays(run.day, k), start_ms, end_ms, zone: run.zone, outside: k < 0 || k >= run.days };
}

function ruled(ms: number, settings: DaySettings): Filed {
  const day = civilDay(ms, settings);
  return { day, ...dayBounds(day, settings), zone: settings.zone };
}

const lastDay = (runs: readonly DayRun[]): string => addDays(runs.at(-1)!.day, runs.at(-1)!.days - 1);

const CLOCKS: { name: string; settings: DaySettings; first: string; last: string; windows?: [string, string][] }[] = [
  { name: "london-4", settings: { zone: "Europe/London", day_start_hour: 4 }, first: "1970-01-01", last: "2036-12-31", windows: [["1970-01-01", "1972-12-31"], ["2026-01-01", "2027-12-31"], ["2036-01-01", "2036-12-31"]] },
  ...[0, 2, 23].map((hour) => ({ name: `london-${hour}`, settings: { zone: "Europe/London", day_start_hour: hour }, first: "2026-01-01", last: "2026-12-31" })),
  ...[0, 2, 4, 23].map((hour) => ({ name: `new-york-${hour}`, settings: { zone: "America/New_York", day_start_hour: hour }, first: "2026-01-01", last: "2026-12-31" })),
  { name: "apia-4", settings: { zone: "Pacific/Apia", day_start_hour: 4 }, first: "2011-12-01", last: "2012-01-31" },
  { name: "lord-howe-2", settings: { zone: "Australia/Lord_Howe", day_start_hour: 2 }, first: "2026-01-01", last: "2026-12-31" },
];

const TRIP: { name: string; clock: { zone: string; start_hour: number; runs: DayRun[] }; cases: { utc: string; why: string; day: string; start: string; end: string; zone: string }[] } = {
  name: "trip",
  clock: {
    zone: "Asia/Kolkata",
    start_hour: 4,
    runs: [
      { day: "2026-01-01", start_ms: utc("2025-12-31T22:30:00Z"), days: 9, zone: "Asia/Kolkata" },
      { day: "2026-01-10", start_ms: utc("2026-01-10T04:00:00Z"), days: 10, zone: "Europe/London" },
      { day: "2026-01-20", start_ms: utc("2026-01-19T22:30:00Z"), days: 12, zone: "Asia/Kolkata" },
    ],
  },
  cases: [
    { utc: "2026-01-05T00:00:00.000Z", why: "a Kolkata day before the trip", day: "2026-01-05", start: "2026-01-04T22:30:00.000Z", end: "2026-01-05T22:30:00.000Z", zone: "Asia/Kolkata" },
    { utc: "2026-01-09T12:00:00.000Z", why: "the day flown west, at its usual hours", day: "2026-01-09", start: "2026-01-08T22:30:00.000Z", end: "2026-01-10T04:00:00.000Z", zone: "Asia/Kolkata" },
    { utc: "2026-01-10T03:59:59.999Z", why: "the last millisecond of the 29.5-hour day", day: "2026-01-09", start: "2026-01-08T22:30:00.000Z", end: "2026-01-10T04:00:00.000Z", zone: "Asia/Kolkata" },
    { utc: "2026-01-10T04:00:00.000Z", why: "the first London day starts", day: "2026-01-10", start: "2026-01-10T04:00:00.000Z", end: "2026-01-11T04:00:00.000Z", zone: "Europe/London" },
    { utc: "2026-01-19T12:00:00.000Z", why: "the day flown back", day: "2026-01-19", start: "2026-01-19T04:00:00.000Z", end: "2026-01-19T22:30:00.000Z", zone: "Europe/London" },
    { utc: "2026-01-19T22:29:59.999Z", why: "the last millisecond of the 18.5-hour day", day: "2026-01-19", start: "2026-01-19T04:00:00.000Z", end: "2026-01-19T22:30:00.000Z", zone: "Europe/London" },
    { utc: "2026-01-19T22:30:00.000Z", why: "Kolkata again", day: "2026-01-20", start: "2026-01-19T22:30:00.000Z", end: "2026-01-20T22:30:00.000Z", zone: "Asia/Kolkata" },
    { utc: "2026-01-31T21:00:00.000Z", why: "the table's final day", day: "2026-01-31", start: "2026-01-30T22:30:00.000Z", end: "2026-01-31T22:30:00.000Z", zone: "Asia/Kolkata" },
  ],
};

function instantsOf(runs: readonly DayRun[], windows: [string, string][]): { ms: number; why: string }[] {
  const asked = new Map<number, string>();
  const ask = (ms: number, why: string) => {
    if (!asked.has(ms)) asked.set(ms, why);
  };
  const inside = (ms: number) => windows.some(([from, to]) => ms >= utc(`${from}T00:00:00Z`) - DAY_MS && ms < utc(`${to}T00:00:00Z`) + 2 * DAY_MS);
  const first = runs[0]!;
  ask(first.start_ms - 1, "the last millisecond before the table");
  ask(first.start_ms, "the table's first day starts");
  runs.forEach((run, at) => {
    const next = runs[at + 1];
    const last = run.start_ms + (run.days - 1) * DAY_MS;
    if (next === undefined) {
      ask(last, "the table's final day starts");
      ask(last + DAY_MS - 1, "the table's final millisecond");
      ask(last + DAY_MS, "the first millisecond past the table");
      return;
    }
    if (!inside(next.start_ms)) return;
    if (last + 23 * H < next.start_ms) ask(last + 23 * H, "a run's last day, in its 24th hour");
    if (last + DAY_MS < next.start_ms) ask(last + DAY_MS, "a run's last day, in its 25th hour");
    ask(next.start_ms - 1, "the last millisecond of a run's last day");
    ask(next.start_ms, "a run's first day starts");
    ask(next.start_ms + 90 * 60_000, "a run's first day, 90 minutes in");
  });
  return [...asked].map(([ms, why]) => ({ ms, why })).sort((left, right) => left.ms - right.ms);
}

const NAMED: Record<string, [string, string][]> = {
  "london-4": [
    ["1969-07-20T20:17:00.000Z", "before 1970, counted back in 24-hour days"],
    ["2026-03-29T03:30:00.000Z", "04:30 on 29 March, the morning the clocks went forward"],
    ["2026-10-25T03:30:00.000Z", "the 25th hour of 24 October, 03:30 after the clocks went back"],
    ["2026-10-07T03:30:00.000Z", "04:30 on 7 October"],
    ["2037-03-29T03:30:00.000Z", "the first clock change past the table, counted on in 24-hour days"],
  ],
  "apia-4": [["2011-12-30T12:00:00.000Z", "02:00 on 31 December, before its day starts: under the 29th, the 30th being skipped"]],
};

function caseClock(name: string, settings: DaySettings, first: string, last: string, windows: [string, string][]) {
  const runs = dayRuns(first, last, settings);
  const asked = [...instantsOf(runs, windows), ...(NAMED[name] ?? []).map(([iso, why]) => ({ ms: utc(iso), why }))].sort((left, right) => left.ms - right.ms);
  const cases = asked.map(({ ms, why }) => {
    const found = lookup(runs, ms);
    const expected = found.outside ? found : ruled(ms, settings);
    return { at: ms, utc: new Date(ms).toISOString(), why, day: expected.day, start_ms: expected.start_ms, end_ms: expected.end_ms, zone: expected.zone, ...(found.outside ? { outside: true } : {}) };
  });
  return { name, clock: { id: idOf(settings.zone, settings.day_start_hour, runs), zone: settings.zone, start_hour: settings.day_start_hour, runs }, cases };
}

function idOf(zone: string, start_hour: number, runs: readonly DayRun[]): string {
  return createHash("sha256").update(canonical({ zone, start_hour, runs } as unknown as Json)).digest("hex").slice(0, 16);
}

describe("dayRuns: the clock's table", () => {
  it("files every instant of every table as civilDay and dayBounds do, and the runs tile", () => {
    const walks: { settings: DaySettings; first: string; last: string }[] = [
      ...CLOCKS.filter((clock) => clock.name !== "london-4"),
      { settings: { zone: "Europe/London", day_start_hour: 4 }, first: "2024-01-01", last: "2027-12-31" },
      { settings: { zone: "Australia/Lord_Howe", day_start_hour: 4 }, first: "2026-01-01", last: "2026-12-31" },
      { settings: { zone: "Asia/Kolkata", day_start_hour: 4 }, first: "2026-01-01", last: "2026-12-31" },
    ];
    for (const { settings, first, last } of walks) {
      const runs = dayRuns(first, last, settings);
      const label = `${settings.zone} at ${settings.day_start_hour}`;
      expect(runs[0]!.day, label).toBe(first);
      expect(lastDay(runs), label).toBe(last);
      runs.forEach((run, at) => {
        expect(run.days, label).toBeGreaterThan(0);
        expect(run.zone, label).toBe(settings.zone);
        const next = runs[at + 1];
        if (next !== undefined) {
          expect(addDays(run.day, run.days), label).toBe(next.day);
          expect(dayBounds(addDays(run.day, run.days - 1), settings).end_ms, label).toBe(next.start_ms);
        }
      });
      for (let day = first; day <= last; day = addDays(day, 1)) {
        const bounds = dayBounds(day, settings);
        if (bounds.end_ms === bounds.start_ms) continue;
        for (const ms of [bounds.start_ms, bounds.start_ms + 12 * H, bounds.end_ms - 1]) {
          expect(lookup(runs, ms), `${label}: ${new Date(ms).toISOString()}`).toEqual({ day, ...bounds, zone: settings.zone, outside: false });
        }
      }
    }
  });

  it("makes one run for a zone that never changes its clocks, two a year for one that does", () => {
    expect(dayRuns("1970-01-01", "2036-12-31", { zone: "Asia/Kolkata", day_start_hour: 4 })).toEqual([
      { day: "1970-01-01", start_ms: utc("1969-12-31T22:30:00Z"), days: 24_472, zone: "Asia/Kolkata" },
    ]);
    expect(dayRuns("2026-01-01", "2026-12-31", { zone: "Europe/London", day_start_hour: 4 })).toEqual([
      { day: "2026-01-01", start_ms: utc("2026-01-01T04:00:00Z"), days: 87, zone: "Europe/London" },
      { day: "2026-03-29", start_ms: utc("2026-03-29T03:00:00Z"), days: 210, zone: "Europe/London" },
      { day: "2026-10-25", start_ms: utc("2026-10-25T04:00:00Z"), days: 68, zone: "Europe/London" },
    ]);
    const apia = dayRuns("2011-12-28", "2012-01-02", { zone: "Pacific/Apia", day_start_hour: 4 });
    expect(apia).toEqual([
      { day: "2011-12-28", start_ms: utc("2011-12-28T14:00:00Z"), days: 3, zone: "Pacific/Apia" },
      { day: "2011-12-31", start_ms: utc("2011-12-30T14:00:00Z"), days: 3, zone: "Pacific/Apia" },
    ]);
    expect(dayRuns("2026-05-01", "2026-05-01", { zone: "UTC", day_start_hour: 0 })).toEqual([{ day: "2026-05-01", start_ms: utc("2026-05-01T00:00:00Z"), days: 1, zone: "UTC" }]);
    refused(() => dayRuns("2026-05-02", "2026-05-01", { zone: "UTC", day_start_hour: 0 }), "order");
    refused(() => dayRuns("2026-05-01", "2026-05-02", { zone: "Mars/Olympus", day_start_hour: 0 }), "zone");
  });

  it("the trip files by its rule: each run's days are its own zone's, and the trip's days start where the next zone's do", () => {
    for (const run of TRIP.clock.runs) {
      expect(dayRuns(run.day, addDays(run.day, run.days - 1), { zone: run.zone, day_start_hour: TRIP.clock.start_hour })).toEqual([run]);
    }
    const [kolkata, london] = TRIP.clock.runs;
    const long = london!.start_ms - (kolkata!.start_ms + (kolkata!.days - 1) * DAY_MS);
    expect(long / H).toBe(29.5);
    const back = TRIP.clock.runs[2]!.start_ms - (london!.start_ms + (london!.days - 1) * DAY_MS);
    expect(back / H).toBe(18.5);
    for (const each of TRIP.cases) {
      expect(lookup(TRIP.clock.runs, utc(each.utc)), each.why).toEqual({ day: each.day, start_ms: utc(each.start), end_ms: utc(each.end), zone: each.zone, outside: false });
    }
  });

  it("the case file holds each case's day and bounds as core and the lookup make them, and HomeLink's copy is the same bytes", () => {
    const path = fileURLToPath(new URL("./test/clock-cases.json", import.meta.url));
    const copy = fileURLToPath(new URL("../../homelink/Tests/Fixtures/clock-cases.json", import.meta.url));
    const clocks = [
      ...CLOCKS.map(({ name, settings, first, last, windows }) => caseClock(name, settings, first, last, windows ?? [[first, last]])),
      {
        name: TRIP.name,
        clock: { id: idOf(TRIP.clock.zone, TRIP.clock.start_hour, TRIP.clock.runs), ...TRIP.clock },
        cases: TRIP.cases.map((each) => ({ at: utc(each.utc), utc: each.utc, why: each.why, day: each.day, start_ms: utc(each.start), end_ms: utc(each.end), zone: each.zone })),
      },
    ];
    for (const clock of clocks) {
      for (const each of clock.cases) {
        const found = lookup(clock.clock.runs, each.at);
        expect({ ...found, outside: undefined }, `${clock.name} ${each.utc}`).toEqual({ day: each.day, start_ms: each.start_ms, end_ms: each.end_ms, zone: each.zone, outside: undefined });
      }
    }
    const london = clocks.find((clock) => clock.name === "london-4")!;
    const past = london.cases.find((each) => each.utc === "2037-03-29T03:30:00.000Z")!;
    expect(past).toMatchObject({ day: "2037-03-28", outside: true });
    expect(civilDay(past.at, { zone: "Europe/London", day_start_hour: 4 })).toBe("2037-03-29");
    expect(london.cases.filter((each) => "outside" in each).map((each) => each.utc)).toEqual([
      "1969-07-20T20:17:00.000Z", "1970-01-01T02:59:59.999Z", "2037-01-01T04:00:00.000Z", "2037-03-29T03:30:00.000Z",
    ]);
    const text = `${JSON.stringify({
      about: "The clock's cases (docs/operating/door.md, GET /v1/clock): each clock as the door answers it, and instants with the day, bounds and zone a reader's lookup must file each under. Made by packages/core/time.test.ts from core's civilDay and dayBounds; `outside` marks an instant outside the table, filed by the lookup's own count of 24-hour days. The trip is hand-written.",
      clocks,
    }, null, 2)}\n`;
    if (process.env.LIFESTREAM_UPDATE_GOLDEN === "1") {
      writeFileSync(path, text);
      writeFileSync(copy, text);
    }
    expect(text).toBe(readFileSync(path, "utf8"));
    expect(readFileSync(copy, "utf8")).toBe(text);
  });
});

describe("instantIn: a moment as the zone's wall clock, to the minute, with its offset", () => {
  it("writes the zone's minute and offset, a half-hour offset, a negative one, and UTC as +00:00", () => {
    const ms = Date.UTC(2026, 9, 7, 4, 2, 59);
    expect(instantIn(ms, "Asia/Kolkata")).toBe("2026-10-07T09:32+05:30");
    expect(instantIn(ms, "America/St_Johns")).toBe("2026-10-07T01:32-02:30");
    expect(instantIn(ms, "UTC")).toBe("2026-10-07T04:02+00:00");
    expect(offsetMinutes(ms, "Asia/Kolkata")).toBe(330);
    expect(offsetMinutes(ms, "America/St_Johns")).toBe(-150);
  });
});
