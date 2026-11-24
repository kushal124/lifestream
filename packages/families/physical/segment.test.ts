import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { distanceMeters, type Point } from "../shared/places.js";
import { motionSpans, segment, type Fix, type Motion } from "./segment.js";

const MINUTE = 60_000;
const FLAGS = ["stationary", "walking", "running", "automotive", "cycling", "unknown"] as const;
type Flag = (typeof FLAGS)[number];
type Reading = Omit<Motion, "end_ms">;

interface Window { fixes: Fix[]; readings: Reading[] }
interface Stored { fixes: [number, number, number, number, number | null, number][]; motion: [number, string][] }

const windows = JSON.parse(readFileSync(new URL("./test/phone-windows.json", import.meta.url), "utf8")) as { cases: Record<string, Stored> };
const ORIGIN: Point = { latitude: 10, longitude: 20 };

function real(name: string): Window {
  const stored = windows.cases[name]!;
  return {
    fixes: stored.fixes.map(([at_ms, latitude, longitude, accuracy_m, speed_mps, altitude_m]) => ({ key: "", at_ms, latitude, longitude, accuracy_m, speed_mps, altitude_m })),
    readings: stored.motion.map(([at_ms, flags]) => reading(at_ms, ...(flags === "" ? [] : flags.split("+") as Flag[]))),
  };
}

function begunEarlier(window: Window, home_ms: number): Window {
  const fixes = window.fixes.filter((fix) => fix.at_ms < home_ms);
  const readings = window.readings.filter((each) => each.at_ms >= 0 && each.at_ms < home_ms);
  const out: Window = { fixes: [...window.fixes], readings: [...window.readings] };
  for (let back = home_ms; back <= 6 * 60 * MINUTE; back += home_ms) {
    out.fixes.push(...fixes.map((fix) => ({ ...fix, at_ms: fix.at_ms - back })));
    out.readings.push(...readings.map((each) => ({ ...each, at_ms: each.at_ms - back })));
  }
  return out;
}

function run(window: Window) {
  const fixes = window.fixes.map((fix, index) => ({ ...fix, key: `fix-${String(index).padStart(6, "0")}` }));
  const readings = window.readings.map((each, index) => ({ ...each, key: `motion-${String(index).padStart(6, "0")}` }));
  return segment(fixes, motionSpans(readings));
}

function reading(at_ms: number, ...flags: Flag[]): Reading {
  return { key: "", at_ms, ...Object.fromEntries(FLAGS.map((flag) => [flag, flags.includes(flag)])) as Record<Flag, boolean> };
}

function at(east: number, north = 0): Point {
  return { latitude: ORIGIN.latitude + north / 111_320, longitude: ORIGIN.longitude + east / (111_320 * Math.cos(ORIGIN.latitude * Math.PI / 180)) };
}

function fixes(from: number, to: number, every: number, where: (at_ms: number) => Point, accuracy_m = 5, speed_mps: number | null = null): Fix[] {
  const out: Fix[] = [];
  for (let at_ms = from; at_ms < to; at_ms += every) out.push({ key: "", at_ms, ...where(at_ms), accuracy_m, speed_mps, altitude_m: 10 });
  return out;
}

function readings(from: number, to: number, every: number, ...flags: Flag[]): Reading[] {
  const out: Reading[] = [];
  for (let at_ms = from; at_ms < to; at_ms += every) out.push(reading(at_ms, ...flags));
  return out;
}

const HOME = at(0);
const still = (point: Point) => () => point;
const near = (east: number) => (at_ms: number) => at(east + (at_ms / 10_000) % 3);
const jitter = near(0);

function away(east: number, motion: Reading[], to: (at_ms: number) => Point = near(east)): Window {
  return {
    fixes: [...fixes(0, 30 * MINUTE, 10_000, jitter), ...fixes(30 * MINUTE, 50 * MINUTE, 10_000, to), ...fixes(50 * MINUTE, 80 * MINUTE, 10_000, jitter)],
    readings: motion,
  };
}

describe("a stay the phone never left", () => {
  it("S1: an outlier stated twice is a stray: three such a minute apart make no trip from home to home", () => {
    const outlier = at(143, 5);
    const window: Window = { fixes: fixes(0, 40 * MINUTE, 20_000, jitter, 10), readings: [] };
    for (const minute of [20, 21, 22]) {
      for (const offset of [0, 5_000]) window.fixes.push({ key: "", at_ms: minute * MINUTE + offset, ...outlier, accuracy_m: 45.7, speed_mps: null, altitude_m: 10 });
    }
    const { stays, trips } = run(window);
    expect(trips).toEqual([]);
    expect(stays.map(({ start_ms, end_ms }) => ({ start_ms, end_ms }))).toEqual([{ start_ms: 0, end_ms: 40 * MINUTE - 20_000 }]);
    expect(distanceMeters(stays[0]!.centre, HOME)).toBeLessThan(3);
  });

  it("S1: indoors, fixes bouncing 2 to 190 m with the outliers stated twice make no walk from home to home", () => {
    const { stays, trips } = run(begunEarlier(real("indoor-jitter"), 17 * MINUTE));
    expect(trips).toEqual([]);
    expect(stays).toHaveLength(1);
    expect(stays[0]!.open).toBe(true);
    expect(distanceMeters(stays[0]!.centre, HOME)).toBeLessThan(10);
  });

  it("S2: a still phone's fix stated again every minute for half an hour is no silence, and the stay ends at its last statement", () => {
    const window: Window = {
      fixes: [
        ...fixes(0, 20 * MINUTE, 30_000, jitter),
        ...fixes(20 * MINUTE, 50 * MINUTE + 1, MINUTE, still(jitter(19 * MINUTE + 30_000))),
        ...fixes(50 * MINUTE + 10_000, 50 * MINUTE + 200_000 + 1, 10_000, (at_ms) => at((at_ms - 50 * MINUTE) * 0.015), 5, 15),
        ...fixes(53 * MINUTE + 30_000, 70 * MINUTE, 30_000, still(at(3_000))),
      ],
      readings: [reading(0, "stationary"), reading(50 * MINUTE, "automotive"), reading(54 * MINUTE, "stationary")],
    };
    const { stays, trips } = run(window);
    expect(stays.map(({ start_ms, end_ms, silences }) => ({ start_ms, end_ms, silences }))).toEqual([
      { start_ms: 0, end_ms: 50 * MINUTE, silences: [] },
      { start_ms: 53 * MINUTE + 20_000, end_ms: 70 * MINUTE - 30_000, silences: [] },
    ]);
    expect(trips.map(({ start_ms, legs }) => ({ start_ms, modes: legs.map((leg) => leg.mode) }))).toEqual([{ start_ms: 50 * MINUTE, modes: ["road_vehicle"] }]);
  });

  it("S2: a stay whose last fixes are one position stated again is open to its last statement", () => {
    const window: Window = { fixes: [...fixes(0, 20 * MINUTE, 30_000, jitter), ...fixes(20 * MINUTE, 40 * MINUTE + 1, 2 * MINUTE, still(jitter(19 * MINUTE + 30_000)))], readings: [] };
    const { stays } = run(window);
    expect(stays.map(({ start_ms, end_ms, open, silences }) => ({ start_ms, end_ms, open, silences }))).toEqual([{ start_ms: 0, end_ms: 40 * MINUTE, open: true, silences: [] }]);
  });

  it("S2: a spot held twenty minutes as one position stated again is a stay there, not a stray", () => {
    const { stays, trips } = run(away(90, [], still(at(90))));
    expect(stays.map(({ start_ms }) => start_ms)).toEqual([0, 30 * MINUTE, 50 * MINUTE]);
    expect(trips).toHaveLength(2);
  });

  it("S3: iOS moving a still phone's position 89 m for twenty minutes makes one home stay, centred at home, and no trip", () => {
    const window = begunEarlier(real("position-jump"), 20 * MINUTE);
    const { stays, trips } = run(window);
    expect(trips).toEqual([]);
    expect(stays).toHaveLength(1);
    expect(stays[0]!.start_ms).toBe(Math.min(...window.fixes.map((fix) => fix.at_ms)));
    expect(stays[0]!.open).toBe(true);
    expect(distanceMeters(stays[0]!.centre, HOME)).toBeLessThan(5);
  });

  it("S3: a synthetic still phone's position moved 90 m and held, motion heard still every ten seconds, is one stay at home", () => {
    const { stays, trips } = run(away(90, readings(-MINUTE, 80 * MINUTE, 10_000, "stationary")));
    expect(trips).toEqual([]);
    expect(stays).toHaveLength(1);
    expect(distanceMeters(stays[0]!.centre, HOME)).toBeLessThan(3);
  });

  it("S3: readings of no activity between the still ones neither prove nor break stillness", () => {
    const motion = readings(-MINUTE, 80 * MINUTE, 10_000, "stationary").flatMap((each) => [each, reading(each.at_ms + 3_000)]);
    expect(run(away(90, motion)).trips).toEqual([]);
  });

  it("S4: the walk in laps within 20 m of home stays the home stay's bout", () => {
    const { stays, trips } = run(real("walk-inside-stay"));
    expect(trips).toEqual([]);
    expect(stays.map(({ start_ms, end_ms, open, bouts, silences }) => ({ start_ms, end_ms, open, bouts, silences }))).toEqual([{
      start_ms: 0, end_ms: 19_170_557, open: true,
      bouts: [{ start_ms: 14_478_316, end_ms: 18_426_602 }],
      silences: [{ start_ms: 0, end_ms: 12_573_952 }, { start_ms: 13_624_845, end_ms: 13_810_179 }],
    }]);
  });
});

describe("a trip the phone made", () => {
  const outAndBack = (window: Window) => {
    const { stays, trips } = run(window);
    expect(stays).toHaveLength(3);
    expect(trips).toHaveLength(2);
    return { stays, trips };
  };

  it("S5: a two-minute walk to a spot 120 m away, motion saying stationary all through, stays a trip", () => {
    const walk = (at_ms: number) => at(Math.min(120, (at_ms - 30 * MINUTE) / 1_000) + (at_ms / 10_000) % 3);
    const { stays } = outAndBack(away(120, readings(-MINUTE, 80 * MINUTE, 10_000, "stationary"), walk));
    expect(distanceMeters(stays[1]!.centre, at(120))).toBeLessThan(10);
  });

  it("S5: the same walk with walking reported only once there stays a trip", () => {
    const walk = (at_ms: number) => at(Math.min(120, (at_ms - 30 * MINUTE) / 1_000) + (at_ms / 10_000) % 3);
    const motion = [...readings(-MINUTE, 32 * MINUTE, 10_000, "stationary"), reading(32 * MINUTE + 20_000, "walking"), ...readings(33 * MINUTE, 80 * MINUTE, 10_000, "stationary")];
    outAndBack(away(120, motion, walk));
  });

  it("S6: a drive 2 km out and back while one stationary reading is held stays a trip", () => {
    const window: Window = {
      fixes: [
        ...fixes(0, 30 * MINUTE, 10_000, still(HOME)),
        ...fixes(30 * MINUTE, 50 * MINUTE, 10_000, (at_ms) => at(2_000 * Math.sin(Math.PI * (at_ms - 30 * MINUTE) / (20 * MINUTE))), 5, 10),
        ...fixes(50 * MINUTE, 80 * MINUTE, 10_000, still(HOME)),
      ],
      readings: [...readings(-MINUTE, 30 * MINUTE, 10_000, "stationary"), ...readings(51 * MINUTE, 80 * MINUTE, 10_000, "stationary")],
    };
    const { stays, trips } = run(window);
    expect(stays).toHaveLength(2);
    expect(trips).toHaveLength(1);
    expect(trips[0]!.distance_m).toBeGreaterThan(3_500);
  });

  it("S6: an excursion 250 m out on the way to a spot 90 m away, motion stationary all through, stays a trip", () => {
    const excursion = (at_ms: number) => {
      const minutes = (at_ms - 30 * MINUTE) / MINUTE;
      return minutes >= 2 ? near(90)(at_ms) : at(minutes <= 1 ? 250 * minutes : 250 - 160 * (minutes - 1));
    };
    const { stays, trips } = run(away(90, readings(-MINUTE, 80 * MINUTE, 10_000, "stationary"), excursion));
    expect(stays).toHaveLength(2);
    expect(trips.map(({ start_ms, end_ms, distance_m }) => ({ start_ms, end_ms, out: distance_m > 300 }))).toEqual([{ start_ms: 30 * MINUTE + 20_000, end_ms: 32 * MINUTE, out: true }]);
  });

  it("S7: a 90 m jump held twenty minutes stays two trips when motion was not heard saying still", () => {
    const cases: Record<string, Reading[]> = {
      "a reading held": [reading(25 * MINUTE, "stationary")],
      "a silence": readings(-MINUTE, 30 * MINUTE, 10_000, "stationary"),
      "no activity": readings(-MINUTE, 80 * MINUTE, 10_000),
      "unknown": readings(-MINUTE, 80 * MINUTE, 10_000, "unknown"),
      "stationary and unknown": readings(-MINUTE, 80 * MINUTE, 10_000, "stationary", "unknown"),
      "a gap past two minutes": readings(-MINUTE, 80 * MINUTE, 10_000, "stationary")
        .filter((each) => !([29, 49].some((minute) => each.at_ms > minute * MINUTE + 20_000 && each.at_ms < (minute + 3) * MINUTE + 30_000))),
    };
    for (const [name, motion] of Object.entries(cases)) {
      const { stays, trips } = run(away(90, motion));
      expect({ name, stays: stays.length, trips: trips.length }).toEqual({ name, stays: 3, trips: 2 });
    }
  });

  it("S7: the app killed mid-trip, its fixes and motion silent fifteen minutes, then a stay 90 m away, stays a trip", () => {
    const window: Window = {
      fixes: [...fixes(0, 30 * MINUTE, 10_000, still(HOME)), ...fixes(45 * MINUTE, 80 * MINUTE, 10_000, still(at(90)))],
      readings: [...readings(-MINUTE, 30 * MINUTE, 10_000, "stationary"), ...readings(45 * MINUTE, 80 * MINUTE, 10_000, "stationary")],
    };
    const { stays, trips } = run(window);
    expect(stays).toHaveLength(2);
    expect(trips).toHaveLength(1);
  });

  it("S8: a walk to a spot 90 m away with walking heard a minute late, once there, stays a trip", () => {
    const walk = (at_ms: number) => at(Math.min(90, (at_ms - 30 * MINUTE) / 1_000) + (at_ms / 10_000) % 3);
    const motion = readings(-MINUTE, 80 * MINUTE, 10_000, "stationary")
      .map((each) => [32 * MINUTE + 30_000, 51 * MINUTE].includes(each.at_ms) ? reading(each.at_ms, "walking") : each);
    outAndBack(away(90, motion, walk));
  });

  it("S8: a walk to a spot 90 m away with walking heard stays a trip", () => {
    const walk = (at_ms: number) => at(Math.min(90, (at_ms - 30 * MINUTE) / 1_000) + (at_ms / 10_000) % 3);
    const motion = [
      ...readings(-MINUTE, 30 * MINUTE, 10_000, "stationary"), reading(30 * MINUTE + 8_000, "walking"),
      ...readings(32 * MINUTE, 50 * MINUTE, 10_000, "stationary"), reading(50 * MINUTE + 8_000, "walking"),
      ...readings(52 * MINUTE, 80 * MINUTE, 10_000, "stationary"),
    ];
    outAndBack(away(90, motion, walk));
  });

  it("S9: a position 2 km out stated twice six seconds apart, the phone gone from home four minutes, stays a trip", () => {
    const far = at(2_000);
    const window: Window = {
      fixes: [
        ...fixes(-30 * MINUTE, 1, 10_000, still(HOME)),
        ...[2 * MINUTE, 2 * MINUTE + 6_000].map((at_ms) => ({ key: "", at_ms, ...far, accuracy_m: 5, speed_mps: null, altitude_m: 10 })),
        ...fixes(4 * MINUTE, 34 * MINUTE, 10_000, still(HOME)),
      ],
      readings: [...readings(-31 * MINUTE, 1, 10_000, "stationary"), ...readings(10_000, 4 * MINUTE, 10_000), ...readings(4 * MINUTE, 34 * MINUTE, 10_000, "stationary")],
    };
    const { stays, trips } = run(window);
    expect(stays).toHaveLength(2);
    expect(trips.map(({ start_ms, end_ms }) => ({ start_ms, end_ms }))).toEqual([{ start_ms: 0, end_ms: 4 * MINUTE }]);
    expect(trips[0]!.distance_m).toBeGreaterThan(3_500);
  });

  it("S10: four minutes away at a spot 90 m off, stationary heard every minute, stays a trip", () => {
    const window: Window = {
      fixes: [
        ...fixes(-30 * MINUTE, 1, 10_000, still(HOME)),
        { key: "", at_ms: 2 * MINUTE, ...at(90), accuracy_m: 5, speed_mps: null, altitude_m: 10 },
        { key: "", at_ms: 3 * MINUTE, ...at(91), accuracy_m: 5, speed_mps: null, altitude_m: 10 },
        ...fixes(4 * MINUTE, 34 * MINUTE, 10_000, still(HOME)),
      ],
      readings: readings(-31 * MINUTE, 34 * MINUTE, MINUTE, "stationary").flatMap((each) => [each, reading(each.at_ms + 30_000)]),
    };
    const { stays, trips } = run(window);
    expect(stays).toHaveLength(2);
    expect(trips.map(({ start_ms, end_ms }) => ({ start_ms, end_ms }))).toEqual([{ start_ms: 0, end_ms: 4 * MINUTE }]);
  });

  it("S10: a walk to a spot 90 m away and back, a fix every ten seconds, stationary heard all through, stays a trip", () => {
    const walk = (at_ms: number) => at(Math.max(0, Math.min(90, at_ms / 1_000, 90 - (at_ms - 20 * MINUTE) / 1_000)) + (at_ms / 10_000) % 3);
    const window: Window = { fixes: fixes(-30 * MINUTE, 50 * MINUTE, 10_000, walk), readings: readings(-31 * MINUTE, 50 * MINUTE, 10_000, "stationary") };
    const { stays } = outAndBack(window);
    expect(distanceMeters(stays[1]!.centre, at(90))).toBeLessThan(10);
  });

  it("S11: a slow walk 90 m away that ends in one fast 11 m hop, stationary heard every minute, stays a trip", () => {
    const slow = [[40_000, 40], [60_000, 60], [80_000, 79], [81_000, 90]].map(([at_ms, east]) => ({ key: "", at_ms: at_ms!, ...at(east!), accuracy_m: 5, speed_mps: null, altitude_m: 10 }));
    const window: Window = {
      fixes: [...fixes(-30 * MINUTE, 0, 10_000, still(HOME)), ...slow, ...fixes(91_000, 21 * MINUTE, 10_000, still(at(90)))],
      readings: readings(-31 * MINUTE, 22 * MINUTE, MINUTE, "stationary"),
    };
    const { stays, trips } = run(window);
    expect(stays).toHaveLength(2);
    expect(trips).toHaveLength(1);
  });
});
