import { addDays, canonical, dayBounds, dayRuns, instant, sha256, TimeError, type DayRun, type DaySettings, type Json } from "@lifestreamprotocol/core";
import { refuse } from "./refusal.js";

export interface HomeClock {
  id: string;
  zone: string;
  start_hour: number;
  runs: DayRun[];
}

export const CLOCK_FIRST = "1970-01-01";
export const CLOCK_YEARS = 10;

const clocks = new Map<string, HomeClock>();

export function clockOf(day: DaySettings, last: string): HomeClock {
  const key = `${day.zone}\u0000${day.day_start_hour}\u0000${last}`;
  const cached = clocks.get(key);
  if (cached !== undefined) return { ...cached, runs: cached.runs.map((run) => ({ ...run })) };
  const runs = dayRuns(CLOCK_FIRST, last, day);
  const made: HomeClock = { id: clockId(day.zone, day.day_start_hour, runs), zone: day.zone, start_hour: day.day_start_hour, runs };
  if (clocks.size >= 256) clocks.clear();
  clocks.set(key, made);
  return { ...made, runs: made.runs.map((run) => ({ ...run })) };
}

export function clockId(zone: string, start_hour: number, runs: readonly DayRun[]): string {
  return sha256(canonical({ zone, start_hour, runs } as unknown as Json)).slice("sha256:".length, "sha256:".length + 16);
}

export function homeClock(day: DaySettings): HomeClock {
  return clockOf(day, `${new Date().getUTCFullYear() + CLOCK_YEARS}-12-31`);
}

export interface TimeRead {
  start_ms: number;
  end_ms: number;
  day: boolean;
}

export const TIME_FORMS = "is whole milliseconds since the epoch, an instant with its offset (2026-10-07T09:00+05:30), a home-local time (2026-10-07T09:00) or a day (2026-10-07)";

const MS = /^-?\d{1,16}$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const CLOCK = /^(\d{2}):\d{2}(?::\d{2}(?:\.\d+)?)?$/u;
const OFFSET = /(?:[Zz]|[+-]\d{2}:\d{2})$/u;

export function timeOf(value: string, day: DaySettings, within?: string): TimeRead {
  if (MS.test(value)) {
    const ms = Number(value);
    if (!Number.isSafeInteger(ms)) throw new TimeError("range", `${value} is not a safe integer`);
    return { start_ms: ms, end_ms: ms + 1, day: false };
  }
  if (DAY.test(value)) {
    const { start_ms, end_ms } = dayBounds(value, day);
    return { start_ms, end_ms, day: true };
  }
  let wall = value;
  const clock = CLOCK.exec(value);
  if (clock !== null) {
    if (within === undefined) throw new TimeError("spelling", `${JSON.stringify(value)} is a clock with no day: name the day with in`);
    wall = `${Number(clock[1]) >= day.day_start_hour ? within : addDays(within, 1)}T${value}`;
  }
  const ms = OFFSET.test(wall) ? instant(wall, "rfc3339").start_ms : instant(wall, "local", { zone: day.zone }).start_ms;
  return { start_ms: ms, end_ms: ms + 1, day: false };
}

export function readTime(name: string, value: string, day: DaySettings, within?: string): TimeRead {
  try {
    return timeOf(value, day, within);
  } catch (error) {
    if (error instanceof TimeError) bad(name, `${TIME_FORMS}: ${error.message}`);
    throw error;
  }
}

export function timeParameter(name: string, value: string, day: DaySettings, edge: "start" | "end" | "moment"): number {
  const time = readTime(name, value, day);
  if (time.day && edge === "moment") bad(name, "names a moment, not a day");
  return time.day && edge === "end" ? time.end_ms : time.start_ms;
}

function bad(name: string, rule: string): never {
  return refuse(422, "BAD_PARAMETER", `${name} ${rule}`);
}
