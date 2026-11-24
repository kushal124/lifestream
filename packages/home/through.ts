import { UNDATED, type JsonObject, type Months, type ReadTables, type Tx } from "@lifestreamprotocol/core";

export interface Value {
  read_through_ms: number;
  stated_ms: number;
  left?: number;
  start_ms?: number | null;
  months?: Months;
}

export interface Counted {
  months: Months;
  counted_ms: number;
}

export type Received = Readonly<Record<string, number>>;

export interface Statement {
  value: Value;
  received: Received;
  at_ms: number;
}

export interface Left {
  left: number;
  start_ms?: number | null;
  stated_ms: number;
  from: "delivery" | "value";
}

export interface Kept {
  applied: { read_through_ms: number; stated_ms: number } | null;
  left: Left | null;
  heard_ms: number | null;
}

export interface Gap {
  pass: string;
  seal: number;
}

export interface Waiting extends Statement {
  since_ms: number;
  lost?: Gap & { at_ms: number };
}

export type Applied = "applied" | "kept" | "old";

export const keptKey = (source: string): string => `through:${source}`;
export const waitingKey = (source: string): string => `through-waiting:${source}`;
export const MONTHS_PREFIX = "months:";
export const monthsKey = (source: string): string => `${MONTHS_PREFIX}${source}`;
const MAX_MONTHS = 12 * 200;

const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/u;

const NONE: Kept = { applied: null, left: null, heard_ms: null };

export function keptOf(meta: Pick<ReadTables["meta"], "get">, source: string): Kept {
  const text = meta.get(keptKey(source));
  return text === undefined ? NONE : (JSON.parse(text) as Kept);
}

export function waitingOf(meta: ReadTables["meta"], source: string): Waiting | undefined {
  const text = meta.get(waitingKey(source));
  return text === undefined ? undefined : (JSON.parse(text) as Waiting);
}

const keep = (tx: Tx, source: string, kept: Kept): void => tx.tables.meta.set(keptKey(source), JSON.stringify(kept));
const wait = (tx: Tx, source: string, waiting: Waiting): void => tx.tables.meta.set(waitingKey(source), JSON.stringify(waiting));

export interface SealReads {
  custody: Pick<ReadTables["custody"], "imported">;
  deliveries: Pick<ReadTables["deliveries"], "held">;
}

export function gapOf(read: SealReads, source: string, received: Received): Gap | undefined {
  for (const pass of Object.keys(received).sort()) {
    const imported = read.custody.imported(pass, source);
    if (imported < received[pass]! && !read.deliveries.held(pass, source, imported + 1)) return { pass, seal: imported + 1 };
  }
  return undefined;
}

function admits(tx: Tx, source: string, received: Received): boolean {
  if (tx.tables.deliveries.waiting(source) !== undefined) return false;
  return Object.entries(received).every(([pass, seal]) => tx.tables.custody.imported(pass, source) >= seal);
}

function apply(tx: Tx, source: string, kept: Kept, statement: Statement, waiting: Waiting | undefined): void {
  const { value } = statement;
  tx.tables.sources.advance(source, value.read_through_ms);
  keep(tx, source, { ...kept, applied: { read_through_ms: value.read_through_ms, stated_ms: value.stated_ms }, heard_ms: Math.max(kept.heard_ms ?? statement.at_ms, statement.at_ms) });
  if (waiting !== undefined && waiting.value.stated_ms <= value.stated_ms) tx.tables.meta.delete(waitingKey(source));
}

export function applyThrough(tx: Tx, source: string, stating: Statement, now_ms: number): Applied {
  const { months, ...value } = stating.value;
  const statement: Statement = { ...stating, value };
  if (months !== undefined) stateMonths(tx, source, { months, counted_ms: value.stated_ms });
  if (value.left !== undefined) stateLeft(tx, source, { left: value.left, ...(value.start_ms === undefined ? {} : { start_ms: value.start_ms }), stated_ms: value.stated_ms, from: "value" });
  const kept = keptOf(tx.tables.meta, source);
  if (kept.applied !== null && value.stated_ms <= kept.applied.stated_ms) return "old";
  const waiting = waitingOf(tx.tables.meta, source);
  if (admits(tx, source, statement.received)) {
    apply(tx, source, kept, statement, waiting);
    return "applied";
  }
  if (waiting !== undefined && value.stated_ms <= waiting.value.stated_ms) return "old";
  const next: Waiting = { ...statement, since_ms: waiting?.since_ms ?? now_ms };
  const lost = waiting?.lost;
  if (lost !== undefined) {
    const gap = gapOf(tx.tables, source, statement.received);
    if (gap !== undefined && gap.pass === lost.pass && gap.seal === lost.seal) next.lost = lost;
  }
  wait(tx, source, next);
  hear(tx, source, statement.at_ms);
  return "kept";
}

export function judgeThrough(tx: Tx, source: string): boolean {
  const waiting = waitingOf(tx.tables.meta, source);
  if (waiting === undefined || !admits(tx, source, waiting.received)) return false;
  apply(tx, source, keptOf(tx.tables.meta, source), waiting, waiting);
  return true;
}

export function stateLeft(tx: Tx, source: string, left: Left): boolean {
  const kept = keptOf(tx.tables.meta, source);
  const was = kept.left;
  if (was !== null && !(left.stated_ms > was.stated_ms || (left.stated_ms === was.stated_ms && left.from === "delivery" && was.from === "value"))) return false;
  keep(tx, source, { ...kept, left });
  return true;
}

export function countedOf(meta: Pick<ReadTables["meta"], "get">, source: string): Counted | undefined {
  const text = meta.get(monthsKey(source));
  return text === undefined ? undefined : (JSON.parse(text) as Counted);
}

export function stateMonths(tx: Tx, source: string, counted: Counted): boolean {
  const was = countedOf(tx.tables.meta, source);
  if (was !== undefined && was.counted_ms >= counted.counted_ms) return false;
  tx.tables.meta.set(monthsKey(source), JSON.stringify(counted));
  return true;
}

export function monthsIn(value: unknown): Months | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_MONTHS + 1) return null;
  const months: Months = {};
  for (const [month, held] of entries) {
    if (month !== UNDATED && !MONTH.test(month)) return null;
    if (!Array.isArray(held) || held.length !== 2) return null;
    const [items, bytes] = held as unknown[];
    if (!isCount(items) || !(bytes === null || isCount(bytes))) return null;
    months[month] = [items, bytes];
  }
  return months;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function leftOf(facts: JsonObject): Pick<Left, "left" | "start_ms"> | null {
  const { left, start_ms } = facts;
  if (typeof left !== "number" || !Number.isSafeInteger(left) || left < 0) return null;
  const stated = startIn(start_ms);
  return stated === undefined ? { left } : { left, start_ms: stated };
}

export function startIn(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

export function hear(tx: Tx, source: string, at_ms: number): boolean {
  const kept = keptOf(tx.tables.meta, source);
  if (kept.heard_ms !== null && kept.heard_ms >= at_ms) return false;
  keep(tx, source, { ...kept, heard_ms: at_ms });
  return true;
}

export function markLost(tx: Tx, source: string, gap: Gap, at_ms: number): boolean {
  const waiting = waitingOf(tx.tables.meta, source);
  if (waiting === undefined || (waiting.lost?.pass === gap.pass && waiting.lost.seal === gap.seal)) return false;
  wait(tx, source, { ...waiting, lost: { ...gap, at_ms } });
  return true;
}
