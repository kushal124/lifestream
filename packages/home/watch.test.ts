import { describe, expect, it } from "vitest";
import { lookOf, quietWaits, READ_QUIET_MS, serialAfter, type Seen, type Watch } from "./pool.js";

const LOOK = lookOf(READ_QUIET_MS);
const SLEEP = 35 * 60_000;

const seen = (helper: string, job: number | null, serial: bigint): Seen<string> => ({ helper, job, serial });

function looks(times: readonly number[], at: (index: number) => readonly Seen<string>[], quiet_ms = READ_QUIET_MS): { index: number; end: number[] } {
  let watch: Watch<string> = { at: null, waits: new Map() };
  for (const [index, now] of times.entries()) {
    const looked = quietWaits(watch, now, at(index), quiet_ms);
    watch = looked.watch;
    if (looked.end.length > 0) return { index, end: looked.end };
  }
  return { index: -1, end: [] };
}

const onTime = (count: number, start = 0): number[] => Array.from({ length: count }, (_, index) => start + index * LOOK);

describe("the watch counts looks of time the home ran", () => {
  it("a wait is ended before ten minutes of on-time looks, or never", () => {
    expect(LOOK).toBe(15_000);
    const ended = looks(onTime(60), () => [seen("a", 1, 1n)]);
    expect(ended).toEqual({ index: READ_QUIET_MS / LOOK, end: [1] });
    expect(lookOf(1_000)).toBe(250);
    expect(looks(Array.from({ length: 10 }, (_, index) => index * 250), () => [seen("a", 1, 1n)], 1_000)).toEqual({ index: 4, end: [1] });
  });

  it("a jump of the clock of 35 minutes between two looks ends a wait, or counts toward it", () => {
    const times = [...onTime(3), ...onTime(60, 2 * LOOK + SLEEP)];
    expect(looks(times, () => [seen("a", 1, 1n)])).toEqual({ index: 1 + READ_QUIET_MS / LOOK, end: [1] });
    expect(looks([0, 2 * LOOK + 1, ...onTime(60, 3 * LOOK)], () => [seen("a", 1, 1n)]).index).toBe(1 + READ_QUIET_MS / LOOK);
    expect(looks([0, 2 * LOOK, ...onTime(60, 3 * LOOK)], () => [seen("a", 1, 1n)]).index).toBe(READ_QUIET_MS / LOOK);
  });

  it("a late look takes away what a wait had counted", () => {
    const times = [...onTime(4), ...onTime(60, 3 * LOOK + SLEEP)];
    expect(looks(times, () => [seen("a", 1, 1n)]).index).toBe(1 + READ_QUIET_MS / LOOK);
    expect(looks(Array.from({ length: 100 }, (_, index) => index * SLEEP), () => [seen("a", 1, 1n)])).toEqual({ index: -1, end: [] });
  });

  it("two waits read as one", () => {
    const ended = looks(onTime(100), (index) => [seen("a", 1, index < 20 ? 1n : 2n)]);
    expect(ended).toEqual({ index: 20 + READ_QUIET_MS / LOOK, end: [1] });
    expect(looks(onTime(100), (index) => [seen("a", 1, BigInt(1 + Math.floor(index / 30)))]).index).toBe(-1);
  });

  it("a helper replaced, or a new job on the same helper, keeps the count though the serial reads the same", () => {
    expect(looks(onTime(100), (index) => [seen(index < 20 ? "a" : "a again", 1, 1n)]).index).toBe(20 + READ_QUIET_MS / LOOK);
    expect(looks(onTime(100), (index) => [seen("a", index < 20 ? 1 : 2, 1n)])).toEqual({ index: 20 + READ_QUIET_MS / LOOK, end: [2] });
  });

  it("a helper with no job, or on no wait, is ended; or one wait's end ends another", () => {
    expect(looks(onTime(100), () => [seen("a", null, 1n), seen("b", 2, 0n)])).toEqual({ index: -1, end: [] });
    expect(looks(onTime(100), (index) => [seen("a", 1, index % 30 === 29 ? 0n : BigInt(1 + Math.floor(index / 30)))]).index).toBe(-1);
    expect(looks(onTime(100), (index) => [seen("a", 1, 1n), seen("b", 2, index < 10 ? 0n : 1n)])).toEqual({ index: READ_QUIET_MS / LOOK, end: [1] });
  });
});

describe("the helper's serial", () => {
  it("is 0 for a wait, or wraps to 0 at its end", () => {
    expect(serialAfter(0n)).toBe(1n);
    expect(serialAfter(41n)).toBe(42n);
    const end = 2n ** 63n - 1n;
    expect(BigInt.asIntN(64, end)).toBe(end);
    expect(serialAfter(end - 1n)).toBe(end);
    expect(serialAfter(end)).toBe(1n);
  });
});
