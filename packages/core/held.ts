import type Database from "better-sqlite3";
import { RELEASE } from "./schema.js";
import type { Sql } from "./sql.js";

const LIVE_TIMED = "source = @source AND kind = @kind AND version <> 'gone' AND start_ms IS NOT NULL";
export const ENDS = {
  oldest_ms: `(SELECT start_ms FROM heads INDEXED BY heads_time WHERE ${LIVE_TIMED} ORDER BY start_ms LIMIT 1)`,
  newest_ms: `(SELECT start_ms FROM heads INDEXED BY heads_time WHERE ${LIVE_TIMED} ORDER BY start_ms DESC LIMIT 1)`,
  newest_dated: `(SELECT v.precision IS 'day' FROM (SELECT version FROM heads INDEXED BY heads_time WHERE ${LIVE_TIMED} ORDER BY start_ms DESC LIMIT 1) h JOIN versions v ON v.id = h.version)`,
} as const;

export const HELD_MARK = "held:live";
export const FILL_HEADS = 4096;

export interface HeldAt {
  source: string;
  kind: string;
  key: string;
  live: number;
}

export type HeldMark = { at: HeldAt } | { complete: string };

export function heldMark(sql: Sql): HeldMark | null {
  const value = sql.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", HELD_MARK)?.value;
  return value === undefined ? null : JSON.parse(value) as HeldMark;
}

function setMark(sql: Sql, mark: HeldMark | null): void {
  if (mark === null) sql.run("DELETE FROM meta WHERE key = ?", HELD_MARK);
  else sql.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", HELD_MARK, JSON.stringify(mark));
}

export function heldAt(sql: Sql): HeldAt | null {
  const mark = heldMark(sql);
  return mark !== null && "at" in mark ? mark.at : null;
}

export function passed(at: HeldAt, key: string): boolean {
  return Buffer.compare(Buffer.from(key, "utf8"), Buffer.from(at.key, "utf8")) <= 0;
}

export function movePassed(sql: Sql, at: HeldAt, change: number): void {
  setMark(sql, { at: { ...at, live: at.live + change } });
}

export function forgotKind(sql: Sql, source: string, kind: string): void {
  sql.run("UPDATE spans SET live = 0, oldest_ms = NULL, newest_ms = NULL, newest_dated = NULL WHERE source = ? AND kind = ?", source, kind);
  const at = heldAt(sql);
  if (at !== null && at.source === source && at.kind === kind) setMark(sql, null);
}

export function fillHeld(sql: Sql): boolean {
  sql.writing();
  const mark = heldMark(sql);
  if (mark !== null && "complete" in mark) return true;
  let at: { source: string; kind: string; key: string | null; live: number } | null = mark?.at ?? null;
  for (let budget = FILL_HEADS; budget > 0;) {
    if (at === null) {
      const next = sql.get<{ source: string; kind: string }>("SELECT source, kind FROM spans WHERE live IS NULL ORDER BY source, kind LIMIT 1");
      if (next === undefined) {
        setMark(sql, { complete: RELEASE });
        return true;
      }
      at = { ...next, key: null, live: 0 };
    }
    const after = at.key === null ? "" : " AND key > ?";
    const range = sql.get<{ heads: number; live: number; last: string | null }>(
      `SELECT count(*) AS heads, coalesce(sum(version <> 'gone'), 0) AS live, max(key) AS last
       FROM (SELECT key, version FROM heads WHERE source = ? AND kind = ?${after} ORDER BY key LIMIT ?)`,
      at.source, at.kind, ...(at.key === null ? [] : [at.key]), budget,
    )!;
    if (range.heads < budget) {
      sql.run("UPDATE spans SET live = ? WHERE source = ? AND kind = ?", at.live + range.live, at.source, at.kind);
      budget -= Math.max(range.heads, 1);
      at = null;
    } else {
      at = { source: at.source, kind: at.kind, key: range.last!, live: at.live + range.live };
      budget = 0;
    }
  }
  setMark(sql, at === null ? null : { at: { source: at.source, kind: at.kind, key: at.key!, live: at.live } });
  return false;
}

export interface Span {
  kind: string;
  live: number | null;
  oldest_ms: number | null;
  newest_ms: number | null;
  newest_dated: number | null;
}

export function spansOf(db: Database.Database): ReadonlyMap<string, readonly Span[]> {
  const spans = new Map<string, Span[]>();
  for (const { source, ...span } of db.prepare("SELECT source, kind, live, oldest_ms, newest_ms, newest_dated FROM spans ORDER BY source, kind").all() as (Span & { source: string })[]) {
    const of = spans.get(source);
    if (of === undefined) spans.set(source, [span]);
    else of.push(span);
  }
  return spans;
}

export function heldOf(spans: readonly Span[]): number | null {
  let live = 0;
  for (const span of spans) {
    if (span.live === null) return null;
    live += span.live;
  }
  return live;
}

export function itemSpanOf(spans: readonly Span[]): { oldest_ms: number | null; newest_ms: number | null; newest_dated: boolean } {
  let oldest_ms: number | null = null;
  let newest: Span | null = null;
  for (const span of spans) {
    if (span.oldest_ms !== null && (oldest_ms === null || span.oldest_ms < oldest_ms)) oldest_ms = span.oldest_ms;
    if (span.newest_ms !== null && (newest === null || span.newest_ms > newest.newest_ms!)) newest = span;
  }
  return { oldest_ms, newest_ms: newest?.newest_ms ?? null, newest_dated: newest?.newest_dated === 1 };
}
