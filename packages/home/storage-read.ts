import { realpathSync } from "node:fs";
import type Database from "better-sqlite3";
import { addDays, BLOCKS, civilDay, FILES_END, KEEP_BYTES, readTables, STORED_MARK, type DaySettings, type StoredMark } from "@lifestreamprotocol/core";
import type { Connector } from "@lifestreamprotocol/connect";
import { catalogOf } from "./catalog.js";
import { driveOf } from "./lifecycle.js";
import { shownOf } from "./connectors.js";
import { forecast, FREE_BYTES, photosStart, readDiskOf, type FreeDay } from "./status.js";
import type { StartSettings } from "./start.js";
import { ownFiles, ownNow, readRest, STORED_AT, STORED_REST } from "./stored.js";

export interface StorageRead {
  position: string;
  disk: { name: string | null; total_bytes: number; free_bytes: number; keep_bytes: number; coming_bytes: number };
  counting: { map: boolean; left_ms: number | null } | null;
  home: {
    bytes: number;
    streams: { connector: string; bytes: number; week_bytes: number | null }[];
    own: { bytes: number; week_bytes: number | null };
  };
  series: { first_day: string; parts: { part: string; bytes: number[] }[] } | null;
  growth: { readings: number; bytes_a_day: number | null; days_left: number | null };
}

export const OTHER = "other";
export const OWN = "own";
const PARTS = 5;
const STOPPED_MS = 5 * 60_000;

export interface StorageInput {
  root: string;
  now_ms: number;
  settings: StartSettings & { day: DaySettings };
  connectors: readonly Connector[];
}

export function readStorage(db: Database.Database, input: StorageInput): Omit<StorageRead, "position"> {
  const { root, now_ms } = input;
  const today = civilDay(now_ms, input.settings.day);
  const meta = db.prepare("SELECT value FROM meta WHERE key = ?").pluck();
  const counting = countingOf(JSON.parse(meta.get(STORED_MARK) as string) as StoredMark, meta.get(STORED_AT) as string | undefined, now_ms);

  const catalog = catalogOf(input.connectors);
  const rows = new Map(readTables(db).sources.list().map((row) => [row.id, row]));
  const parts = new Map<string, string>();
  const partOf = (source: string): string => {
    let part = parts.get(source);
    if (part === undefined) parts.set(source, part = streamOf(catalog.of(rows.get(source) ?? { id: source })) ?? OWN);
    return part;
  };
  const stored = db.prepare("SELECT day, source, text, files FROM stored_days ORDER BY day").all() as { day: string; source: string; text: number; files: number }[];
  const own = db.prepare("SELECT day, bytes FROM own_days ORDER BY day").all() as { day: string; bytes: number }[];
  const weekBefore = addDays(today, -7);
  let text = 0;
  const totals = new Map<string, number>();
  const earlier = new Map<string, number>();
  for (const row of stored) {
    text += row.text;
    const part = partOf(row.source);
    totals.set(part, (totals.get(part) ?? 0) + row.text + row.files);
    if (row.day <= weekBefore) earlier.set(part, (earlier.get(part) ?? 0) + row.text + row.files);
  }
  const unstreamed = totals.get(OWN) ?? 0;
  const ownBytes = ownNow(ownFiles(root), readRest(meta.get(STORED_REST) as string | undefined)?.bytes ?? 0, text) + unstreamed;
  const ranked = [...totals].filter(([part, bytes]) => part !== OWN && bytes > 0).sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0));

  const first = [stored[0]?.day, own[0]?.day, today].filter((day): day is string => day !== undefined).sort()[0]!;
  const days: string[] = [];
  for (let day = first; day <= today; day = addDays(day, 1)) days.push(day);
  const index = new Map(days.map((day, at) => [day, at]));
  const drawn = new Set(ranked.slice(0, PARTS).map(([part]) => part));
  const sums = new Map<string, number[]>();
  const sumOf = (part: string) => {
    let sum = sums.get(part);
    if (sum === undefined) sums.set(part, sum = new Array<number>(days.length).fill(0));
    return sum;
  };
  for (const row of stored) {
    const part = partOf(row.source);
    sumOf(part === OWN || drawn.has(part) ? part : OTHER)[index.get(row.day) ?? days.length - 1]! += row.text + row.files;
  }
  for (const sum of sums.values()) for (let at = 1; at < sum.length; at++) sum[at]! += sum[at - 1]!;
  const unstreamedSum = sums.get(OWN) ?? new Array<number>(days.length).fill(0);
  let next = 0;
  let held = own[0]?.bytes ?? ownBytes - unstreamed;
  const ownSeries = days.map((day, at) => {
    while (next < own.length && own[next]!.day <= day) held = own[next++]!.bytes;
    return at === days.length - 1 ? ownBytes : held + unstreamedSum[at]!;
  });
  const others = sums.get(OTHER);
  const series = {
    first_day: first,
    parts: [
      ...ranked.slice(0, PARTS).map(([part]) => ({ part, bytes: sums.get(part)! })),
      ...(others !== undefined && others.some((bytes) => bytes !== 0) ? [{ part: OTHER, bytes: others }] : []),
      { part: OWN, bytes: ownSeries },
    ],
  };

  const ownBefore = weekBefore < first ? 0 : ownSeries[index.get(weekBefore)!]!;

  const read = readDiskOf(db, root, now_ms, photosStart(input.settings, input.connectors, now_ms));
  const cast = forecast(db, read.disk, read.photos.bytes);
  const kept = JSON.parse((meta.get(FREE_BYTES) as string | undefined) ?? "[]") as FreeDay[];
  return {
    disk: { name: volumeOf(root), total_bytes: read.total_bytes, free_bytes: cast.free_bytes, keep_bytes: KEEP_BYTES, coming_bytes: cast.coming },
    counting,
    home: {
      bytes: ranked.reduce((sum, [, bytes]) => sum + bytes, ownBytes),
      streams: ranked.map(([connector, bytes]) => ({ connector, bytes, week_bytes: counting === null ? bytes - (earlier.get(connector) ?? 0) : null })),
      own: { bytes: ownBytes, week_bytes: counting === null ? ownBytes - ownBefore : null },
    },
    series: counting === null ? series : null,
    growth: { readings: kept.filter((each) => each.disk === read.disk.disk).length, bytes_a_day: cast.steady_bytes_a_day, days_left: cast.days_left },
  };
}

export function streamOf(connector: Connector | undefined): string | null {
  if (connector === undefined || connector.label !== undefined) return null;
  return connector.type !== undefined || shownOf(connector) !== null ? connector.id : null;
}

function countingOf(mark: StoredMark, at: string | undefined, now_ms: number): StorageRead["counting"] {
  if ("complete" in mark) return null;
  if (mark.blocks === 0 && mark.after === null) return { map: true, left_ms: null };
  const done = doneOf(mark.blocks, mark.after);
  const going = at !== undefined && now_ms - Number(at) <= STOPPED_MS;
  return { map: false, left_ms: going && done > 0 ? Math.round((mark.slab_ms * (1 - done)) / done) : null };
}

export function doneOf(blocks: number, after: string | null): number {
  const files = after === null ? 0 : after === FILES_END ? 1 : (Number.parseInt(after.slice("sha256:".length, "sha256:".length + 8), 16) + 1) / 2 ** 32;
  return (blocks / BLOCKS + (Number.isFinite(files) ? files : 0)) / 2;
}

function volumeOf(root: string): string | null {
  return driveOf(realpathSync(root));
}
