import type { Connector } from "@lifestreamprotocol/connect";
import { civilDay, type DaySettings, type Json, type JsonObject } from "@lifestreamprotocol/core";

export interface Start {
  day: string | null;
  ms: number | null;
  own: boolean;
}

export interface StartSettings {
  history: { start: string };
  connectors: Readonly<Record<string, JsonObject>>;
}

export const START_SPAN = { months: 6 } as const;

export const ALL = "all";

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const RULE = "is all or a day (2026-05-19)";

export function startRule(value: Json): string | null {
  return value === ALL || (typeof value === "string" && isDay(value)) ? null : RULE;
}

export function startSetRule(value: Json, now_ms: number): string | null {
  const rule = startRule(value);
  if (rule !== null || value === ALL) return rule;
  const today = utcDay(now_ms);
  return (value as string) > today ? `is after today (${today}): a start is a day already begun` : null;
}

export function startOf(settings: StartSettings, connector: Pick<Connector, "id" | "backfill">, now_ms = Date.now()): Start {
  const written = connector.backfill === undefined ? undefined : settings.connectors[connector.id]?.start;
  const own = written !== undefined && startRule(written) === null;
  const word = own ? written as string : settings.history.start;
  if (word === ALL) return { day: null, ms: null, own };
  const today = utcDay(now_ms);
  const day = word > today ? today : word;
  return { day, ms: Date.parse(`${day}T00:00:00Z`), own };
}

export function madeStart(now_ms: number, day: DaySettings): string {
  return monthsBefore(civilDay(now_ms, day), START_SPAN.months);
}

export function monthsBefore(day: string, months: number): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const at = year * 12 + (month - 1) - months;
  const [y, m] = [Math.floor(at / 12), at % 12];
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return `${String(y).padStart(4, "0")}-${String(m + 1).padStart(2, "0")}-${String(Math.min(date, last)).padStart(2, "0")}`;
}

function isDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const at = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
