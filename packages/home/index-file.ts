import { DAYS_MARK, instantIn, type BlobReader, type DaySettings, type HomeFolder, type JsonObject, type OpenView, type RecordRef, type Tx } from "@lifestreamprotocol/core";
import type Database from "better-sqlite3";
import type { Family } from "@lifestreamprotocol/families";
import type { HelperEnv } from "./jobs.js";
import type { MarkQueue } from "./marking.js";
import { refuse, RETRY_SOON_S } from "./refusal.js";
import type { Work } from "./work.js";
import { busy, metaOf, readScreen, screenPositionOf } from "./screen-index.js";
import { daysOf, search, stretchGroups, type ScreenPage, type ScreenSearch, type StretchGroups } from "./screen-query.js";
import { SearchIndex, type Attached, type RecordRead } from "./search-index.js";

export interface Index<Result = unknown> {
  readonly name: IndexName;
  fileOf(root: string, machine: string): string;
  take(env: HelperEnv, from: IndexCursor): AsyncGenerator<IndexCursor, Result, undefined>;
  settled(result: Result): Settled;
  unmarked(folder: HomeFolder, machine: string): MarkQueue;
  state(folder: HomeFolder, file: string, of: number): IndexState | null;
  build(tx: Tx, now_ms: number): number;
  forget(on: Forgetting, records: readonly RecordRef[], days: readonly string[]): void;
}

export interface Forgetting {
  folder: HomeFolder;
  machine: string;
  blobs: BlobReader;
  settings: { day: DaySettings; screen_cutover_ms: number };
  families: readonly Family[];
  forgetMarks(texts: readonly string[]): void;
  wait_ms: number;
  kept: string[];
}

export type IndexName = "search" | "screen";

export interface IndexCursor {
  seq: number;
  reread: number;
}

export interface Settled {
  more: boolean;
  again_in_ms: number | null;
  again_at_ms: number | null;
  counts: JsonObject | null;
}

export interface IndexState {
  seq: number;
  behind: number;
  building: { done: number; of: number } | null;
  bytes: number;
}

export function indexAnswer<T>(answer: T | "none" | "busy", which: IndexName, building: JsonObject = {}): T {
  const named = which === "search" ? "the search index" : "the screen index";
  if (answer === "none") return refuse(503, "INDEX_BUILDING", `${named} is being built`, RETRY_SOON_S, building);
  if (answer === "busy") return refuse(503, "NOT_NOW", `${named} is being written`, RETRY_SOON_S);
  return answer;
}

export function recordRead<T>(folder: HomeFolder, file: string, attached: Readonly<Record<string, Attached>>, work: (read: RecordRead) => T, waitMs?: number): T | "none" | "busy" {
  let index: SearchIndex | undefined;
  try {
    index = SearchIndex.read(folder, file, waitMs);
    if (index === undefined) return "none";
    return index.snapshot(attached, work);
  } catch (error) {
    if (busy(error)) return "busy";
    throw error;
  } finally {
    index?.close();
  }
}

export function recordHold(folder: HomeFolder, file: string, attached: Readonly<Record<string, Attached>>, within: Work, waitMs?: number): { read: RecordRead; end(): void } | "none" | "busy" {
  let index: SearchIndex | undefined;
  try {
    index = SearchIndex.read(folder, file, waitMs);
    if (index === undefined) return "none";
    const held = index.hold(attached, within);
    const open = index;
    return {
      read: held.read,
      end: () => {
        try {
          held.end();
        } finally {
          open.close();
        }
      },
    };
  } catch (error) {
    index?.close();
    if (busy(error)) return "busy";
    throw error;
  }
}

export interface ScreenRead {
  readonly clock: DaySettings;
  readonly file: string;
  readonly seq: number;
  search(ask: ScreenSearch): ScreenPage;
  groups(ask: ScreenSearch): StretchGroups;
  readonly db: Database.Database;
  readonly folder: HomeFolder;
}

export async function screenRead<T>(folder: HomeFolder, file: string, work: (read: ScreenRead) => T | Promise<T>, waitMs?: number): Promise<T | "none" | "busy"> {
  const held = screenHold(folder, file, waitMs);
  if (held === "none" || held === "busy") return held;
  try {
    return await work(held.read);
  } catch (error) {
    if (busy(error)) return "busy";
    throw error;
  } finally {
    held.end();
  }
}

export function screenHold(folder: HomeFolder, file: string, waitMs?: number): { read: ScreenRead; end(): void } | "none" | "busy" {
  let db: Database.Database | undefined;
  try {
    db = readScreen(folder, file, waitMs);
    if (db === undefined) return "none";
    const open = db;
    const read: ScreenRead = { clock: daysOf(open), file: metaOf(open, "generation") ?? "", seq: screenPositionOf(open)?.seq ?? 0, search: (ask) => search(open, ask), groups: (ask) => stretchGroups(open, ask), db: open, folder };
    return { read, end: () => open.close() };
  } catch (error) {
    db?.close();
    if (busy(error)) return "busy";
    throw error;
  }
}

export interface HeldDays {
  from: string;
  to: string;
  days: ReadonlyMap<string, { inputs: string; erased: boolean }>;
}

export interface PendingDay {
  day: string;
  why: "new" | "erased" | "failed";
}

export interface Fresh {
  as_of: string | null;
  pending: PendingDay[];
  pending_more?: number;
}

export function freshMembers(fresh: Fresh | undefined): { as_of?: string; pending?: PendingDay[]; pending_more?: number } {
  if (fresh === undefined) return {};
  return {
    ...(fresh.as_of === null ? {} : { as_of: fresh.as_of }),
    ...(fresh.pending.length === 0 ? {} : { pending: fresh.pending }),
    ...(fresh.pending_more === undefined ? {} : { pending_more: fresh.pending_more }),
  };
}

export const OPEN_FROM = "0000-01-01";
export const PENDING_NAMED = 100;
const LIST_PAGE = 1_000;

export function asOfIn(seq: number, home: OpenView, zone: string): string | null {
  const stated = seq === 0 ? undefined : home.tables.statements.statedAt(seq);
  return stated === undefined ? null : instantIn(stated, zone);
}

export function freshOf(seq: number, held: HeldDays | undefined, home: OpenView, today: string, zone: string): Fresh | null {
  const as_of = asOfIn(seq, home, zone);
  if (held === undefined) return { as_of, pending: [] };
  if (home.tables.meta.get(DAYS_MARK) === undefined) return null;
  const why = new Map<string, PendingDay["why"]>();
  const lost = (day: string): PendingDay["why"] => (held.days.get(day)?.erased === true ? "erased" : "new");
  const begun = held.to < today ? held.to : today;
  if (held.from <= begun) for (const { day, aside } of home.tables.dirty.between(held.from, begun)) why.set(day, aside ? "failed" : lost(day));
  const listed = new Set<string>();
  for (let after: string | undefined; ;) {
    const page = home.derived.days.page(held.from, held.to, after, LIST_PAGE);
    for (const { day, inputs } of page) {
      listed.add(day);
      if (!why.has(day) && held.days.get(day)?.inputs !== inputs) why.set(day, lost(day));
    }
    if (page.length < LIST_PAGE) break;
    after = page.at(-1)!.day;
  }
  for (const [day, { inputs }] of held.days) if (inputs !== "" && !listed.has(day) && !why.has(day)) why.set(day, "new");
  const pending = [...why].sort(([left], [right]) => (left < right ? 1 : -1)).map(([day, reason]) => ({ day, why: reason }));
  return {
    as_of,
    pending: pending.slice(0, PENDING_NAMED),
    ...(pending.length > PENDING_NAMED ? { pending_more: pending.length - PENDING_NAMED } : {}),
  };
}
