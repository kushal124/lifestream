import type Database from "better-sqlite3";
import { RELEASE } from "./schema.js";
import type { Sql } from "./sql.js";
import { addDays, civilDay, dayBounds, daysOf } from "./time.js";
import type { DaySettings, Precision } from "./types.js";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

function dateMs(day: string): number {
  return Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
}
export const WINDOW_DAYS = 8;
export const WEEK_DAYS = 7;
export const TALLY_FLOOR = "tally:start_minutes:floor";
export const TALLY_MARK = "tally:start_minutes";
export const TALLY_DAY = "tally:start_minutes:day";

export interface Window {
  floor_ms: number;
  day: DaySettings;
}

export interface Counted {
  version: string;
  start_ms: number | null;
  precision: Precision | null;
}

export type Mark = { after: [string, string, string] } | { complete: string };

export interface Chunk {
  source: string;
  kind: string;
  day: string;
  from_ms: number;
  to_ms: number | null;
}

export function startMinute(head: Counted | undefined, window: Window | null): number | null {
  if (head === undefined || head.version === "gone" || head.start_ms === null || window === null) return null;
  const at = placed(head.start_ms, head.precision, window.day);
  return at === null || at < window.floor_ms ? null : Math.floor(at / MINUTE_MS);
}

function placed(start_ms: number, precision: Precision | null, day: DaySettings): number | null {
  if (precision === "month" || precision === "year") return null;
  if (precision === "day") return dayBounds(dateOf(start_ms, day), day).start_ms;
  return start_ms;
}

function dateOf(start_ms: number, day: DaySettings): string {
  return daysOf({ start_ms, precision: "day" }, day)[0]!;
}

export function windowFloor(day: DaySettings, now: number): number {
  return dayBounds(addDays(civilDay(now, day), 1 - WINDOW_DAYS), day).start_ms;
}

function floorOf(read: (key: string) => string | undefined): number | null {
  const value = read(TALLY_FLOOR);
  return value === undefined ? null : Number(value);
}

export function windowOf(read: (key: string) => string | undefined): Window | null {
  const floor_ms = floorOf(read);
  const day = read(TALLY_DAY);
  return floor_ms === null || day === undefined ? null : { floor_ms, day: JSON.parse(day) as DaySettings };
}

function spelled(day: DaySettings): string {
  return JSON.stringify({ zone: day.zone, day_start_hour: day.day_start_hour });
}

function markOf(value: string | undefined): Mark | null {
  return value === undefined ? null : JSON.parse(value) as Mark;
}

export type Weeks = ReadonlyMap<string, ReadonlyMap<string, readonly number[]>>;

export function weeksOf(db: Database.Database, kinds: readonly (readonly [source: string, kind: string])[], day: DaySettings, now: number): Weeks | null {
  const mark = markOf(db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(TALLY_MARK) as string | undefined);
  if (mark === null || !("complete" in mark)) return null;
  const today = civilDay(now, day);
  const starts = Array.from({ length: WEEK_DAYS + 1 }, (_, index) => dayBounds(addDays(today, index - WEEK_DAYS + 1), day).start_ms / MINUTE_MS);
  const rows = db.prepare(`SELECT m.source, m.kind, ${starts.slice(1, WEEK_DAYS).map(() => "(m.minute >= ?)").join(" + ")} AS day, sum(m.records) AS n
    FROM json_each(?) k CROSS JOIN start_minutes m ON m.source = k.value ->> 0 AND m.kind = k.value ->> 1 AND m.minute >= ? AND m.minute < ?
    GROUP BY m.source, m.kind, day`).all(...starts.slice(1, WEEK_DAYS), JSON.stringify(kinds), starts[0], starts[WEEK_DAYS]) as { source: string; kind: string; day: number; n: number }[];
  const weeks = new Map<string, Map<string, number[]>>();
  for (const row of rows) {
    const kinds = weeks.get(row.source) ?? weeks.set(row.source, new Map()).get(row.source)!;
    const week = kinds.get(row.kind) ?? kinds.set(row.kind, new Array<number>(WEEK_DAYS).fill(0)).get(row.kind)!;
    week[row.day] = row.n;
  }
  return weeks;
}

export function weekOf(weeks: Weeks, source: string): number[] {
  const week = new Array<number>(WEEK_DAYS).fill(0);
  for (const days of weeks.get(source)?.values() ?? []) days.forEach((n, at) => { week[at] = week[at]! + n; });
  return week;
}

export interface Tally {
  prune(day: DaySettings, now: number): number;
  mark(): Mark | null;
  chunks(day: DaySettings): Chunk[];
  rebuild(chunk: Chunk): void;
  complete(): void;
}

export function tallyOf(sql: Sql): Tally {
  const meta = (key: string) => sql.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value;
  const set = (key: string, value: string) => sql.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
  const days = (day: DaySettings): string[] => {
    const floor = floorOf(meta);
    if (floor === null) return [];
    const first = civilDay(floor, day);
    return Array.from({ length: WINDOW_DAYS }, (_, index) => addDays(first, index));
  };
  return {
    prune(day, now) {
      sql.writing();
      const floor = windowFloor(day, now);
      set(TALLY_FLOOR, String(floor));
      if (meta(TALLY_DAY) !== spelled(day)) {
        set(TALLY_DAY, spelled(day));
        sql.run("DELETE FROM meta WHERE key = ?", TALLY_MARK);
      }
      return sql.run("DELETE FROM start_minutes WHERE minute < ?", floor / MINUTE_MS).changes;
    },
    mark: () => markOf(meta(TALLY_MARK)),
    chunks(day) {
      const mark = markOf(meta(TALLY_MARK));
      if (mark !== null && "complete" in mark) return [];
      const after = mark === null ? null : mark.after.join("\0");
      const floor = floorOf(meta);
      const window = days(day);
      const bounded = window.map((each, at) => ({
        day: each, from_ms: Math.max(dayBounds(each, day).start_ms, floor ?? 0), to_ms: at === window.length - 1 ? null : dayBounds(addDays(each, 1), day).start_ms,
      }));
      return sql.all<{ source: string; kind: string }>("SELECT source, kind FROM spans ORDER BY source, kind")
        .flatMap(({ source, kind }) => bounded.map((each) => ({ source, kind, ...each })))
        .filter((chunk) => after === null || [chunk.source, chunk.kind, chunk.day].join("\0") > after);
    },
    rebuild(chunk) {
      sql.writing();
      const from = Math.max(chunk.from_ms, floorOf(meta) ?? chunk.from_ms);
      const to = chunk.to_ms;
      if (to === null || from < to) {
        const below = to === null ? "" : " AND minute < ?";
        sql.run(`DELETE FROM start_minutes WHERE source = ? AND kind = ? AND minute >= ?${below}`, chunk.source, chunk.kind, from / MINUTE_MS, ...(to === null ? [] : [to / MINUTE_MS]));
        sql.run(
          `INSERT INTO start_minutes (source, kind, minute, records)
           SELECT h.source, h.kind, h.start_ms / ${MINUTE_MS}, count(*) FROM heads h INDEXED BY heads_time JOIN versions v ON v.id = h.version
           WHERE h.source = ? AND h.kind = ? AND h.version <> 'gone' AND h.start_ms >= ?${to === null ? "" : " AND h.start_ms < ?"}
             AND v.precision NOT IN ('day', 'month', 'year') GROUP BY h.start_ms / ${MINUTE_MS}`,
          chunk.source, chunk.kind, from, ...(to === null ? [] : [to]),
        );
        const window = windowOf(meta);
        const first = dateMs(chunk.day);
        const dates = window === null ? [] : sql.all<{ start_ms: number }>(
          `SELECT h.start_ms FROM heads h INDEXED BY heads_time JOIN versions v ON v.id = h.version
           WHERE h.source = ? AND h.kind = ? AND h.version <> 'gone' AND h.start_ms >= ?${to === null ? "" : " AND h.start_ms < ?"} AND v.precision = 'day'`,
          chunk.source, chunk.kind, first, ...(to === null ? [] : [first + DAY_MS]),
        );
        for (const { start_ms } of dates) {
          const minute = startMinute({ version: "live", start_ms, precision: "day" }, window);
          if (minute === null) continue;
          sql.run(
            `INSERT INTO start_minutes (source, kind, minute, records) VALUES (?, ?, ?, 1)
             ON CONFLICT (source, kind, minute) DO UPDATE SET records = records + 1`,
            chunk.source, chunk.kind, minute,
          );
        }
      }
      set(TALLY_MARK, JSON.stringify({ after: [chunk.source, chunk.kind, chunk.day] } satisfies Mark));
    },
    complete() {
      sql.writing();
      set(TALLY_MARK, JSON.stringify({ complete: RELEASE } satisfies Mark));
    },
  };
}
