import { instant, span, TimeError, type Delivery, type Instant, type JsonObject, type LocalRule, type TimeOptions, type TimePattern, type TimeRule } from "@lifestreamprotocol/core";
import { refuse } from "./refused.js";
import type { SqliteValue } from "./sqlite.js";

export const SOURCE_TIME_FACTS = ["snapshot_taken_at", "exported_at", "created_at"] as const;
const STATEMENT_FACTS = [...SOURCE_TIME_FACTS, "fetched_at"] as const;

export function statedAt(facts: JsonObject): number {
  for (const fact of STATEMENT_FACTS) {
    const value = facts[fact];
    if (value === undefined) continue;
    const at = typeof value === "string" ? instantMs(value) : undefined;
    if (at === undefined) refuse(`facts.${fact} must be a full RFC 3339 instant, not ${JSON.stringify(value)}`);
    return at;
  }
  return refuse(`the delivery states no ${STATEMENT_FACTS.join(", ")}`);
}

/** Reads a time by the rule given into an instant, refusing it, named by the place given, when it does not read. */
export function instantOf(value: string | number, rule: Exclude<TimeRule, LocalRule> | TimePattern, where: string, opts?: TimeOptions): Instant {
  return readable(() => instant(value, rule, opts), `${where} ${JSON.stringify(value)}`);
}

/** Reads an Apple time, seconds or nanoseconds since the start of 2001, into an instant, or undefined for a null, missing or zero value. */
export function appleInstant(value: SqliteValue | undefined, rule: "apple-s" | "apple-ns", where: string): Instant | undefined {
  if (value === null || value === undefined || value === 0 || value === 0n) return undefined;
  if (typeof value === "number") return instantOf(value, rule, where);
  if (typeof value === "bigint") return instantOf(value.toString(), rule, where);
  return refuse(`${where} is not a number`);
}

/** Reads a wall-clock time, written as RFC 3339 without its offset, and a zone abbreviation such as `IST` into the earliest instant they name in the IANA zone given. */
export function abbreviatedInstantOf(wall: string, abbreviation: string, zone: string, where: string): Instant {
  const naive = Date.parse(`${wall}Z`);
  if (Number.isNaN(naive)) refuse(`${where} ${JSON.stringify(wall)} is not a wall clock`);
  const offsets = new Set([naive - DAY_MS, naive, naive + DAY_MS].map((at) => offsetIn(zone, at)));
  const read = [...offsets].map((offset) => instantOf(`${wall}${offset}`, "rfc3339", where))
    .filter((at) => offsetIn(zone, at.start_ms) === signed(at.offset_min!) && namesIn(zone, at.start_ms).has(abbreviation))
    .sort((left, right) => left.start_ms - right.start_ms);
  return read[0] ?? refuse(`${where} ${JSON.stringify(abbreviation)} is no abbreviation of ${zone} at ${wall}`);
}

const DAY_MS = 86_400_000;
const ENGLISH = ["en-US", "en-GB", "en-IN", "en-AU", "en-CA", "en-NZ", "en-IE", "en-ZA", "en-SG"];
const offsetFormats = new Map<string, Intl.DateTimeFormat>();
const nameFormats = new Map<string, Intl.DateTimeFormat[]>();
const names = new Map<string, ReadonlySet<string>>();

function offsetIn(zone: string, at_ms: number): string {
  let format = offsetFormats.get(zone);
  if (format === undefined) offsetFormats.set(zone, (format = new Intl.DateTimeFormat("en", { timeZone: zone, timeZoneName: "longOffset" })));
  const stated = format.formatToParts(at_ms).find((part) => part.type === "timeZoneName")!.value;
  return stated === "GMT" ? "+00:00" : stated.slice("GMT".length);
}

function namesIn(zone: string, at_ms: number): ReadonlySet<string> {
  const kept = `${zone} ${offsetIn(zone, at_ms)}`;
  let found = names.get(kept);
  if (found !== undefined) return found;
  let formats = nameFormats.get(zone);
  if (formats === undefined) nameFormats.set(zone, (formats = ENGLISH.map((locale) => new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: "short" }))));
  found = new Set(formats.map((format) => format.formatToParts(at_ms).find((part) => part.type === "timeZoneName")!.value));
  names.set(kept, found);
  return found;
}

function signed(minutes: number): string {
  const whole = Math.abs(minutes);
  return `${minutes < 0 ? "-" : "+"}${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

/** The instant from the start of one instant to the end of another, refused, named by the place given, when it ends before it starts or mixes a date with a time. */
export function spanOf(start: Instant, end: Instant, where: string): Instant {
  return readable(() => span(start, end), where);
}

function readable(read: () => Instant, where: string): Instant {
  try {
    return read();
  } catch (error) {
    if (error instanceof TimeError) refuse(`${where}: ${error.message}`);
    throw error;
  }
}

/** Reads a time by the rule given into an instant, or undefined when it does not read. */
export function tryInstant(value: string | number, rule: Exclude<TimeRule, LocalRule> | TimePattern, opts?: TimeOptions): Instant | undefined {
  try {
    return instant(value, rule, opts);
  } catch (error) {
    if (error instanceof TimeError) return undefined;
    throw error;
  }
}

/** The Unix milliseconds an RFC 3339 instant names, or undefined when the text is not one. */
export function instantMs(text: string): number | undefined {
  return tryInstant(text, "rfc3339")?.start_ms;
}

/** Writes Unix milliseconds as an RFC 3339 instant in UTC, to the millisecond or, given `s`, to the second. */
export function rfc3339(ms: number, precision: "ms" | "s" = "ms"): string {
  const text = new Date(precision === "s" ? Math.floor(ms / 1000) * 1000 : ms).toISOString();
  return precision === "s" ? `${text.slice(0, 19)}Z` : text;
}

/** The facts naming the one source a delivery feeds and the connector that reads it. */
export function feeds(source: string, connector: string): { sources: JsonObject[] } {
  return { sources: [{ id: source, connector }] };
}
