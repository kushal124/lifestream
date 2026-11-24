import type { DaySettings, Instant, Precision } from "./types.js";
import { textHead } from "./words.js";

/** A spelling of time that sources write, named so that `instant` knows how to read it. */
export type TimeRule =
  /** An ISO 8601 date and time with its offset or `Z`, as `2026-10-03T14:05:09+05:30`. */
  | "rfc3339"
  /** An ISO 8601 date and time with no offset, read in a zone, as `2026-10-03T14:05:09`. */
  | "local"
  /** Apple Health's export spelling, as `2026-10-03 14:05:09 +0530`. */
  | "healthkit"
  /** A mail header's date, as `Sat, 3 Oct 2026 14:05:09 +0530`. */
  | "rfc2822"
  /** The date of an mbox `From ` line, as `Sat Oct  3 08:35:09 +0000 2026`, whose offset is the mail store's and is not kept. */
  | "mbox"
  /** An iCalendar DATE or DATE-TIME, as `20261003` or `20261003T083509Z`, one with no `Z` read in a zone. */
  | "ical"
  /** Seconds since the start of 2001 in UTC, as Core Data stores them, a number or a decimal string. */
  | "apple-s"
  /** Nanoseconds since the start of 2001 in UTC, a number or a decimal string. */
  | "apple-ns"
  /** Seconds since the Unix epoch, a number or a decimal string. */
  | "unix-s"
  /** Milliseconds since the Unix epoch, a number or a decimal string. */
  | "unix-ms"
  /** A calendar date, as `2026-10-03`. */
  | "date"
  /** A calendar month, as `2026-10`. */
  | "month"
  /** A calendar year, as `2026`. */
  | "year"
  /** A day, month and year, as `03/10/2026`, or `03/10/26` read with a century. */
  | "dmy";

/** A spelling of time no named rule reads, given by its pattern. */
export interface TimePattern {
  /** The pattern in the letters of Unicode TR35, as date-fns, ICU and Java write them, as `MMM d, yyyy, h:mm:ss a`. */
  readonly pattern: string;
}

/** The rule for a wall clock that states no offset, which reads only with a zone or an offset. */
export type LocalRule = "local";

/** What reading a time may need besides its rule: the zone or offset of a wall clock, and the century of a two-digit year. */
export interface TimeOptions {
  /** The zone a wall clock with no offset is read in, an IANA name or a fixed `±HH:MM`. */
  zone?: string;
  /** An offset the source stated in another field, as `±HH:MM` or `±HHMM`, which the time keeps as its own. */
  offset?: string;
  /** The century added to a two-digit year, as 2000. */
  century?: number;
}

/** Where a wall clock with no offset is placed: in a zone, at an offset another field stated, or both. */
export type Zoned =
  | {
    /** The zone the wall clock is read in, an IANA name or a fixed `±HH:MM`. */
    zone: string;
    /** An offset the source stated in another field, which places the wall clock and which the time keeps as its own. */
    offset?: string;
  }
  | {
    /** An offset the source stated in another field, which places the wall clock and which the time keeps as its own. */
    offset: string;
    /** The zone the wall clock is read in, an IANA name or a fixed `±HH:MM`. */
    zone?: string;
  };

/** The kind of fault a `TimeError` reports. */
export type TimeErrorCode =
  /** The value is not spelled as its rule reads, or names a rule or precision there is none of. */
  | "spelling"
  /** The date or clock is not one the calendar has, such as 30 February or a weekday that is not its date's. */
  | "calendar"
  /** The time lies outside the years 1000 to 9999, or a count is not a whole number. */
  | "range"
  /** An epoch value of zero, which a column states for unset rather than a time. */
  | "zero"
  /** A wall clock with no offset was given no zone or offset to read it in. */
  | "naive"
  /** An offset that does not read, or two stated offsets that disagree. */
  | "offset"
  /** A zone that is not a fixed offset or one the runtime knows. */
  | "zone"
  /** A two-digit year with no century, or a century that is not a whole hundred. */
  | "century"
  /** A span that ends before it starts or mixes a date with an instant, or days asked for in the wrong order. */
  | "order"
  /** Day settings whose start hour is not an hour of the day. */
  | "settings"
  /** A duration word that does not read. */
  | "duration";

/** The error a time function throws for a value it cannot read, rather than guess. */
export class TimeError extends Error {
  /** Always `TimeError`, by which `instanceof` knows one thrown by another copy of core. */
  override readonly name = "TimeError";

  static override [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof Error && value.name === "TimeError";
  }

  constructor(
    /** The kind of fault, for a caller that treats some apart. */
    readonly code: TimeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const APPLE_EPOCH_MS = 978_307_200_000n;
const MIN_MS = Date.UTC(1000, 0, 1);
const MAX_MS = Date.UTC(10_000, 0, 1) - 1;

const UNIT_MS = { s: 1000, m: MINUTE, h: HOUR, d: DAY } as const;

/** The milliseconds in a duration word, a whole number and one unit, as `30s`, `10m`, `1h` or `2d`. */
export function duration(word: string): number {
  const match = /^([1-9]\d{0,8})([smhd])$/u.exec(word);
  if (match === null) throw new TimeError("duration", `${JSON.stringify(word)}: a duration is a whole number and one unit, s, m, h or d: 30s, 10m, 1h, 2d`);
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}

/** Reads a wall clock that states no offset into an instant, placed in the zone or at the offset given. */
export function instant(value: string, rule: LocalRule, opts: Zoned): Instant;
/** Reads one time a source states, by its named rule or its pattern, into an instant at the precision its spelling states. */
export function instant(value: string | number, rule: Exclude<TimeRule, LocalRule> | TimePattern, opts?: TimeOptions): Instant;
export function instant(value: string | number, rule: TimeRule | TimePattern, opts: TimeOptions = {}): Instant {
  if (typeof rule === "object") return readPattern(value, rule.pattern, opts);
  switch (rule) {
    case "rfc3339":
    case "local":
      return readIso(text(value, rule), rule, opts);
    case "healthkit":
      return readHealthkit(text(value, rule), opts);
    case "rfc2822":
      return readRfc2822(text(value, rule), opts);
    case "mbox":
      return readMbox(text(value, rule), opts);
    case "ical":
      return readIcal(text(value, rule), opts);
    case "apple-s":
      return readEpoch(value, rule, 3, APPLE_EPOCH_MS, opts);
    case "apple-ns":
      return readEpoch(value, rule, -6, APPLE_EPOCH_MS, opts);
    case "unix-s":
      return readEpoch(value, rule, 3, 0n, opts);
    case "unix-ms":
      return readEpoch(value, rule, 0, 0n, opts);
    case "date":
      return readDate(text(value, rule));
    case "month":
      return readMonth(text(value, rule));
    case "year":
      return readYear(text(value, rule));
    case "dmy":
      return readDmy(text(value, rule), opts);
    default:
      return fail("spelling", `unknown time rule ${JSON.stringify(rule)}`);
  }
}

/** One time from the start of `start` to the end of `end`, at the coarser of their precisions and with the start's offset. */
export function span(start: Instant, end: Instant): Instant {
  if (isDate(start.precision) !== isDate(end.precision)) {
    fail("order", "a span is two dates or two instants, never one of each");
  }
  const endMs = end.end_ms ?? end.start_ms;
  if (endMs < start.start_ms) fail("order", "a span ends before it starts");
  const precision = RANK[start.precision] >= RANK[end.precision] ? start.precision : end.precision;
  return made(start.start_ms, endMs, start.offset_min, precision);
}

/** An instant as text in `zone` at a precision, as `2026-10-03 14:05` or a date alone, its date left out when it is `within`. */
export function render(ms: number, zone: string, precision: Precision, within?: string): string {
  checkMs(ms);
  if (!(precision in RANK)) fail("spelling", `unknown precision ${JSON.stringify(precision)}`);
  if (isDate(precision)) {
    const date = utcDate(ms);
    return precision === "day" ? date : precision === "month" ? date.slice(0, 7) : date.slice(0, 4);
  }
  const wall = new Date(ms + offsetMs(ms, zone));
  const date = utcDate(wall.getTime());
  let clock = minutes(wall);
  if (precision !== "minute") clock += `:${pad(wall.getUTCSeconds())}`;
  if (precision === "ms") clock += `.${pad(wall.getUTCMilliseconds(), 3)}`;
  return date === within ? clock : `${date} ${clock}`;
}

export function wallClock(ms: number, zone: string): string {
  checkMs(ms);
  return minutes(new Date(ms + offsetMs(ms, zone)));
}

const minutes = (wall: Date): string => `${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}`;

export function instantIn(ms: number, zone: string): string {
  const offset = offsetMinutes(ms, zone);
  const sign = offset < 0 ? "-" : "+";
  return `${render(ms, zone, "minute").replace(" ", "T")}${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

export function offsetMinutes(ms: number, zone: string): number {
  return Math.round(offsetMs(ms, zone) / MINUTE);
}

/** The civil day, as `YYYY-MM-DD`, an instant falls in, each day starting at the settings' hour in their zone. */
export function civilDay(ms: number, settings: DaySettings): string {
  checkMs(ms);
  checkSettings(settings);
  const wall = ms + offsetMs(ms, settings.zone);
  const day = utcDate(wall - settings.day_start_hour * HOUR);
  const bounds = dayBounds(day, settings);
  if (ms < bounds.start_ms) return addDays(day, -1);
  if (ms >= bounds.end_ms) return addDays(day, 1);
  return day;
}

/** The instant a civil day starts at and the instant it ends before, by the settings' zone and start hour. */
export function dayBounds(day: string, settings: DaySettings): { start_ms: number; end_ms: number } {
  checkSettings(settings);
  const key = `${settings.zone}\u0000${settings.day_start_hour}\u0000${day}`;
  let bounds = boundsCache.get(key);
  if (bounds === undefined) {
    bounds = { start_ms: dayStart(day, 0, settings, offsetCache), end_ms: dayStart(day, 1, settings, offsetCache) };
    remember(boundsCache, key, bounds);
  }
  return { ...bounds };
}

function dayStart(day: string, after: number, settings: DaySettings, offsets: Map<string, number>): number {
  return wallToMs(dateMs(day) + after * DAY + settings.day_start_hour * HOUR, settings.zone, offsets);
}

export function daysOf(time: Instant, settings: DaySettings): string[] {
  checkSettings(settings);
  if (time.precision === "month" || time.precision === "year") return [];
  let first: string;
  let last: string;
  if (time.precision === "day") {
    first = utcDate(time.start_ms);
    last = time.end_ms !== undefined && time.end_ms > time.start_ms ? utcDate(time.end_ms - 1) : first;
  } else {
    first = civilDay(time.start_ms, settings);
    last = time.end_ms !== undefined && time.end_ms > time.start_ms ? civilDay(time.end_ms - 1, settings) : first;
  }
  const days: string[] = [];
  for (let day = first; day <= last; day = addDays(day, 1)) days.push(day);
  return days;
}

export interface DayRun {
  day: string;
  start_ms: number;
  days: number;
  zone: string;
}

export function dayRuns(first: string, last: string, settings: DaySettings): DayRun[] {
  checkSettings(settings);
  if (last < first) fail("order", `${quote(last)} is before ${quote(first)}`);
  const key = `${settings.zone}\u0000${settings.day_start_hour}\u0000${first}\u0000${last}`;
  const cached = runsCache.get(key);
  if (cached !== undefined) return cached.map((each) => ({ ...each }));
  const firstMs = dateMs(first);
  const lastMs = dateMs(last);
  const totalDays = (lastMs - firstMs) / DAY + 1;
  const fixed = fixedZone(settings.zone);
  if (fixed !== undefined) {
    const runs: DayRun[] = [{ day: first, start_ms: firstMs + settings.day_start_hour * HOUR - fixed, days: totalDays, zone: settings.zone }];
    remember(runsCache, key, runs);
    return runs.map((each) => ({ ...each }));
  }
  const baseWall = firstMs + settings.day_start_hour * HOUR;
  const startAt = (index: number) => wallToMs(baseWall + index * DAY, settings.zone, offsetCache);
  let start = startAt(0);
  const runs: DayRun[] = [];
  let run: DayRun = { day: first, start_ms: start, days: 0, zone: settings.zone };
  for (let index = 0; index < totalDays;) {
    const jump = Math.min(14, totalDays - index);
    const after = startAt(index + jump);
    if (after - start === jump * DAY) {
      run.days += jump;
      start = after;
    } else {
      for (let step = 0; step < jump; step++) {
        const end = step === jump - 1 ? after : startAt(index + step + 1);
        run.days += 1;
        if (end - start !== DAY && index + step < totalDays - 1) {
          runs.push(run);
          run = { day: utcDate(firstMs + (index + step + 1) * DAY), start_ms: end, days: 0, zone: settings.zone };
        }
        start = end;
      }
    }
    index += jump;
  }
  runs.push(run);
  remember(runsCache, key, runs);
  return runs.map((each) => ({ ...each }));
}

/** The `YYYY-MM-DD` date a number of days after a date, or before it for a negative count. */
export function addDays(day: string, count: number): string {
  if (!Number.isSafeInteger(count)) fail("range", `a day count must be an integer, not ${count}`);
  return utcDate(dateMs(day) + count * DAY);
}


const ISO =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?([Zz]|[+-]\d{2}:\d{2})?$/u;
const HEALTHKIT = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})$/u;
const ICAL = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/u;
const MONTHS = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ");
const MONTH_NAME = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)";
const WEEKDAY = "(?:mon|tue|wed|thu|fri|sat|sun)";
const RFC2822 = new RegExp(
  `^\\s*(?:${WEEKDAY}\\s*,\\s*)?(\\d{1,2})\\s+${MONTH_NAME}\\s+(\\d{2,4})\\s+(\\d{2}):(\\d{2})(?::(\\d{2}))?` +
    `\\s+([+-]\\d{4}|ut|gmt|[ecmp][sd]t)\\s*(?:\\([^()]*\\)\\s*)?$`,
  "iu",
);
const NAMED_ZONES: Record<string, number> = { ut: 0, gmt: 0, est: -300, edt: -240, cst: -360, cdt: -300, mst: -420, mdt: -360, pst: -480, pdt: -420 };
const MBOX = new RegExp(
  `^${WEEKDAY}\\s+${MONTH_NAME}\\s+(\\d{1,2})\\s+(\\d{2}):(\\d{2}):(\\d{2})(?:\\s+([+-]\\d{4}))?\\s+(\\d{4})$`,
  "iu",
);
const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u;

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second?: number;
  fraction?: string;
}

function readIso(value: string, rule: "rfc3339" | "local", opts: TimeOptions): Instant {
  const m = ISO.exec(value) ?? fail("spelling", `${quote(value)} is not an ISO 8601 date and time`);
  const wall = wallOf(m[1], m[2], m[3], m[4], m[5], m[6], m[7]);
  const spelled = m[8];
  if (rule === "rfc3339" && spelled === undefined) {
    fail("spelling", `${quote(value)} states no offset; a wall clock is read with the 'local' rule and a zone`);
  }
  if (rule === "local" && spelled !== undefined) {
    fail("spelling", `${quote(value)} states an offset; it is read with the 'rfc3339' rule`);
  }
  return spelled === undefined ? fromWall(wall, opts) : fromStated(wall, offsetOf(spelled, value), opts);
}

function readHealthkit(value: string, opts: TimeOptions): Instant {
  const m = HEALTHKIT.exec(value) ?? fail("spelling", `${quote(value)} is not HealthKit's 'YYYY-MM-DD HH:MM:SS ±HHMM'`);
  return fromStated(wallOf(m[1], m[2], m[3], m[4], m[5], m[6]), offsetOf(m[7]!, value), opts);
}

function readRfc2822(value: string, opts: TimeOptions): Instant {
  const m = RFC2822.exec(value) ?? fail("spelling", `${quote(value)} is not an RFC 5322 date`);
  const digits = m[3]!;
  const spelledYear = Number(digits);
  const year = digits.length === 4 ? spelledYear : digits.length === 3 ? spelledYear + 1900 : spelledYear < 50 ? spelledYear + 2000 : spelledYear + 1900;
  const wall = wallOf(String(year), String(MONTHS.indexOf(m[2]!.toLowerCase()) + 1), m[1], m[4], m[5], m[6]);
  const zone = m[7]!.toLowerCase();
  const offset = zone in NAMED_ZONES ? NAMED_ZONES[zone] : offsetOf(zone, value);
  return fromStated(wall, offset, opts);
}

function readMbox(value: string, opts: TimeOptions): Instant {
  const m = MBOX.exec(value) ?? fail("spelling", `${quote(value)} is not an mbox 'From ' line date`);
  const wall = wallOf(m[7], String(MONTHS.indexOf(m[1]!.toLowerCase()) + 1), m[2], m[3], m[4], m[5]);
  if (m[6] === undefined) return fromWall(wall, opts);
  const offset = offsetOf(m[6], value) ?? 0;
  return fromUtc(wallMs(wall) - offset * MINUTE, precisionOf(wall), opts);
}

function readIcal(value: string, opts: TimeOptions): Instant {
  const m = ICAL.exec(value) ?? fail("spelling", `${quote(value)} is not an iCalendar DATE or DATE-TIME`);
  if (m[4] === undefined) return dateSpan(Number(m[1]), Number(m[2]), Number(m[3]), "day", value);
  const wall = wallOf(m[1], m[2], m[3], m[4], m[5], m[6]);
  return m[7] === undefined ? fromWall(wall, opts) : fromStated(wall, undefined, opts);
}

function readDate(value: string): Instant {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value) ?? fail("spelling", `${quote(value)} is not a 'YYYY-MM-DD' date`);
  return dateSpan(Number(m[1]), Number(m[2]), Number(m[3]), "day", value);
}

function readMonth(value: string): Instant {
  const m = /^(\d{4})-(\d{2})$/u.exec(value) ?? fail("spelling", `${quote(value)} is not a 'YYYY-MM' month`);
  return dateSpan(Number(m[1]), Number(m[2]), 1, "month", value);
}

function readYear(value: string): Instant {
  const m = /^(\d{4})$/u.exec(value) ?? fail("spelling", `${quote(value)} is not a 'YYYY' year`);
  return dateSpan(Number(m[1]), 1, 1, "year", value);
}

function readDmy(value: string, opts: TimeOptions): Instant {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}|\d{2})$/u.exec(value) ?? fail("spelling", `${quote(value)} is not 'DD/MM/YYYY' or 'DD/MM/YY'`);
  let year = Number(m[3]);
  if (m[3]!.length === 2) {
    const century = opts.century;
    if (century === undefined) fail("century", `${quote(value)} has a two-digit year and no century`);
    if (!Number.isSafeInteger(century) || century % 100 !== 0) fail("century", `century ${century} is not a multiple of 100`);
    year += century;
  }
  return dateSpan(year, Number(m[2]), Number(m[1]), "day", value);
}

type PatternField = "year" | "year2" | "month" | "monthName" | "day" | "weekday" | "hour" | "hour12" | "meridiem" | "minute" | "second" | "fraction" | "offset";

interface CompiledPattern {
  regex: RegExp;
  fields: PatternField[];
}

const MONTH_NAMES = "january february march april may june july august september october november december".split(" ");
const WEEKDAY_NAMES = "sunday monday tuesday wednesday thursday friday saturday".split(" ");
const NUMBER = (count: number, most: number): string => (count === 1 ? `(\\d{1,${most}})` : `(\\d{${count}})`);
const LETTERS: Record<string, (count: number) => [PatternField, string] | undefined> = {
  y: (count) => (count === 2 ? ["year2", "(\\d{2})"] : count === 1 || count === 4 ? ["year", "(\\d{4})"] : undefined),
  M: (count) => (count <= 2 ? ["month", NUMBER(count, 2)] : count <= 4 ? ["monthName", "([a-z]{3,9})"] : undefined),
  d: (count) => (count <= 2 ? ["day", NUMBER(count, 2)] : undefined),
  E: (count) => (count <= 4 ? ["weekday", "([a-z]{3,9})"] : undefined),
  H: (count) => (count <= 2 ? ["hour", NUMBER(count, 2)] : undefined),
  h: (count) => (count <= 2 ? ["hour12", NUMBER(count, 2)] : undefined),
  a: (count) => (count === 1 ? ["meridiem", "(am|pm)"] : undefined),
  m: (count) => (count <= 2 ? ["minute", NUMBER(count, 2)] : undefined),
  s: (count) => (count <= 2 ? ["second", NUMBER(count, 2)] : undefined),
  S: (count) => ["fraction", `(\\d{${count}})`],
  X: (count) => (count === 1 ? ["offset", "(z|[+-]\\d{2}(?:\\d{2})?)"] : count === 2 ? ["offset", "(z|[+-]\\d{4})"] : count === 3 ? ["offset", "(z|[+-]\\d{2}:\\d{2})"] : undefined),
  Z: (count) => (count <= 3 ? ["offset", "([+-]\\d{4})"] : count === 5 ? ["offset", "(z|[+-]\\d{2}:\\d{2})"] : undefined),
};
const ONE_OF: Partial<Record<PatternField, string>> = { year2: "year", monthName: "month", hour12: "hour" };
const compiledPatterns = new Map<string, CompiledPattern>();

function compiled(pattern: string): CompiledPattern {
  const kept = compiledPatterns.get(pattern);
  if (kept !== undefined) return kept;
  const wrong = (why: string): never => {
    throw new Error(`time pattern ${JSON.stringify(pattern)}: ${why}`);
  };
  const fields: PatternField[] = [];
  let source = "";
  for (let at = 0; at < pattern.length;) {
    const char = pattern[at]!;
    if (char === "'" && pattern[at + 1] === "'") {
      source += "'";
      at += 2;
    } else if (char === "'") {
      let text = "";
      for (at++; pattern[at] !== "'" || pattern[at + 1] === "'"; at++) {
        if (at >= pattern.length) wrong("a quote opens literal text it never closes");
        text += pattern[at];
        if (pattern[at] === "'") at++;
      }
      source += escaped(text);
      at++;
    } else if (/\s/u.test(char)) {
      while (at < pattern.length && /\s/u.test(pattern[at]!)) at++;
      source += "\\s+";
    } else if (/[a-z]/iu.test(char)) {
      let count = 1;
      while (pattern[at + count] === char) count++;
      const read = LETTERS[char]?.(count) ?? wrong(`${char.repeat(count)} is no letter of a time pattern here; quote literal text ('at')`);
      const field = ONE_OF[read[0]] ?? read[0];
      if (fields.some((each) => (ONE_OF[each] ?? each) === field)) wrong(`it states the ${field} twice`);
      fields.push(read[0]);
      source += read[1];
      at += count;
    } else {
      source += escaped(char);
      at++;
    }
  }
  const has = (...wanted: PatternField[]) => wanted.some((field) => fields.includes(field));
  if (!has("year", "year2")) wrong("it states no year (yyyy)");
  if (has("day", "weekday") && !has("month", "monthName")) wrong("it states a day and no month (MM, MMM)");
  if (has("hour", "hour12") && !has("day")) wrong("it states a clock and no day (d)");
  if (has("weekday") && !has("day")) wrong("a weekday (EEE) is read with its day (d)");
  if (has("hour12") !== has("meridiem")) wrong("a 12-hour clock (h) is read with its AM or PM (a), and only it");
  if (has("hour", "hour12") !== has("minute")) wrong("a clock states its hour and its minutes (H:mm, h:mm a)");
  if (has("second") && !has("minute")) wrong("seconds (ss) need minutes (mm)");
  if (has("fraction") && !has("second")) wrong("a fraction (SSS) needs seconds (ss)");
  if (has("offset") && !has("minute")) wrong("an offset (XXX) needs a clock");
  const made = { regex: new RegExp(`^${source}$`, "iu"), fields };
  compiledPatterns.set(pattern, made);
  return made;
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&").replace(/\s+/gu, "\\s+");
}

function readPattern(value: string | number, pattern: string, opts: TimeOptions): Instant {
  const { regex, fields } = compiled(pattern);
  if (typeof value !== "string") fail("spelling", `a value read by the pattern ${JSON.stringify(pattern)} is a string, not ${typeof value}`);
  const m = regex.exec(value) ?? fail("spelling", `${quote(value)} is not spelled ${JSON.stringify(pattern)}`);
  const read: Partial<Record<PatternField, string>> = {};
  fields.forEach((field, index) => (read[field] = m[index + 1]!.toLowerCase()));
  let year = Number(read.year ?? read.year2);
  if (read.year2 !== undefined) {
    const century = opts.century;
    if (century === undefined) fail("century", `${quote(value)} has a two-digit year and no century`);
    if (!Number.isSafeInteger(century) || century % 100 !== 0) fail("century", `century ${century} is not a multiple of 100`);
    year += century;
  }
  const month = read.monthName === undefined ? Number(read.month ?? 1) : named(MONTH_NAMES, read.monthName, value, "month");
  const day = Number(read.day ?? 1);
  if (read.weekday !== undefined) {
    const weekday = named(WEEKDAY_NAMES, read.weekday, value, "weekday") - 1;
    if (month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month) && new Date(utcMs(year, month, day)).getUTCDay() !== weekday) {
      fail("calendar", `${quote(value)} names a weekday that is not its date's`);
    }
  }
  if (read.minute === undefined) return dateSpan(year, month, day, read.day !== undefined ? "day" : read.month !== undefined || read.monthName !== undefined ? "month" : "year", value);
  let hour = Number(read.hour ?? read.hour12);
  if (read.hour12 !== undefined) {
    if (hour < 1 || hour > 12) fail("calendar", `${quote(value)} has no 12-hour clock: its hour is ${hour}`);
    hour = (hour % 12) + (read.meridiem === "pm" ? 12 : 0);
  }
  const wall = wallOf(String(year), String(month), String(day), String(hour), read.minute, read.second, read.fraction);
  if (read.offset === undefined) return fromWall(wall, opts);
  const offset = read.offset === "z" ? "Z" : read.offset.length === 3 ? `${read.offset}00` : read.offset;
  return fromStated(wall, offsetOf(offset, value), opts);
}

function named(names: readonly string[], word: string, value: string, what: string): number {
  const index = names.findIndex((name) => name === word || name.slice(0, 3) === word || (name === "september" && word === "sept"));
  if (index < 0) fail("spelling", `${quote(value)} names no ${what}: ${JSON.stringify(word)}`);
  return index + 1;
}

function readEpoch(value: string | number, rule: TimeRule, shift: number, epochMs: bigint, opts: TimeOptions): Instant {
  let spelled: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("spelling", `${value} is not a finite ${rule} value`);
    spelled = String(value);
  } else if (typeof value === "string") {
    spelled = value;
  } else {
    return fail("spelling", `a ${rule} value is a number or a decimal string`);
  }
  const m = DECIMAL.exec(spelled) ?? fail("spelling", `${quote(spelled)} is not a decimal ${rule} value`);
  const exponent = Number(m[4] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 40) fail("range", `${quote(spelled)} is out of range`);
  const fraction = m[3] ?? "";
  let digits = BigInt(`${m[2]}${fraction}`);
  if (digits === 0n) fail("zero", `${rule} ${quote(spelled)} is zero, a column's "unset", not a time`);
  if (m[1] === "-") digits = -digits;
  const scale = exponent - fraction.length + shift;
  const ms = scale >= 0 ? digits * 10n ** BigInt(scale) : floorDiv(digits, 10n ** BigInt(-scale));
  const total = ms + epochMs;
  if (total < BigInt(MIN_MS) || total > BigInt(MAX_MS)) fail("range", `${rule} ${quote(spelled)} lies outside the years 1000 to 9999`);
  const fractionDigits = Math.max(0, fraction.length - exponent);
  const precision: Precision = shift <= 0 || fractionDigits >= 3 ? "ms" : "s";
  return fromUtc(Number(total), precision, opts);
}


function fromStated(wall: Wall, offset: number | undefined, opts: TimeOptions): Instant {
  const extra = opts.offset === undefined ? undefined : offsetOf(opts.offset, opts.offset);
  if (offset !== undefined && extra !== undefined && offset !== extra) {
    fail("offset", `the value states offset ${offset} min and another field states ${extra} min`);
  }
  const ms = wallMs(wall) - (offset ?? 0) * MINUTE;
  return checked(made(ms, undefined, offset ?? extra, precisionOf(wall)));
}

function fromWall(wall: Wall, opts: TimeOptions): Instant {
  const offset = opts.offset === undefined ? undefined : offsetOf(opts.offset, opts.offset);
  if (offset !== undefined) return checked(made(wallMs(wall) - offset * MINUTE, undefined, offset, precisionOf(wall)));
  if (opts.zone === undefined) fail("naive", "a wall clock with no offset needs the zone it was read in");
  return checked(made(wallToMs(wallMs(wall), opts.zone), undefined, undefined, precisionOf(wall)));
}

function fromUtc(ms: number, precision: Precision, opts: TimeOptions): Instant {
  const offset = opts.offset === undefined ? undefined : offsetOf(opts.offset, opts.offset);
  return checked(made(ms, undefined, offset, precision));
}

function dateSpan(year: number, month: number, day: number, precision: "day" | "month" | "year", value: string): Instant {
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    fail("calendar", `${quote(value)} is not a calendar date`);
  }
  const start = utcMs(year, month, day);
  const end = precision === "day" ? start + DAY : precision === "month" ? utcMs(year, month + 1, 1) : utcMs(year + 1, 1, 1);
  if (start < MIN_MS || end - 1 > MAX_MS) fail("range", `${quote(value)} lies outside the years 1000 to 9999`);
  return made(start, end, undefined, precision);
}

function wallOf(y?: string, mo?: string, d?: string, h?: string, mi?: string, s?: string, fraction?: string): Wall {
  const wall: Wall = { year: Number(y), month: Number(mo), day: Number(d), hour: Number(h), minute: Number(mi) };
  if (s !== undefined) wall.second = Number(s);
  if (fraction !== undefined) wall.fraction = fraction;
  const valid =
    wall.month >= 1 && wall.month <= 12 && wall.day >= 1 && wall.day <= daysInMonth(wall.year, wall.month) &&
    wall.hour <= 23 && wall.minute <= 59 && (wall.second ?? 0) <= 59;
  if (!valid) fail("calendar", `${wall.year}-${pad(wall.month)}-${pad(wall.day)} ${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second ?? 0)} is not a calendar date and clock`);
  return wall;
}

function wallMs(wall: Wall): number {
  const ms = Number((wall.fraction ?? "").slice(0, 3).padEnd(3, "0"));
  return utcMs(wall.year, wall.month, wall.day, wall.hour, wall.minute, wall.second ?? 0, ms);
}

function utcMs(year: number, month: number, day: number, hour = 0, minute = 0, second = 0, ms = 0): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, ms);
  return date.getTime();
}

function precisionOf(wall: Wall): Precision {
  if (wall.second === undefined) return "minute";
  return (wall.fraction ?? "").length >= 3 ? "ms" : "s";
}

function offsetOf(spelled: string, value: string): number | undefined {
  if (spelled === "Z" || spelled === "z") return undefined;
  const m = /^([+-])(\d{2}):?(\d{2})$/u.exec(spelled) ?? fail("offset", `${quote(spelled)} in ${quote(value)} is not an offset`);
  const hours = Number(m[2]);
  const minutes = Number(m[3]);
  if (hours > 23 || minutes > 59) fail("offset", `${quote(spelled)} in ${quote(value)} is out of range`);
  if (m[1] === "-" && hours === 0 && minutes === 0) return undefined;
  return (m[1] === "-" ? -1 : 1) * (hours * 60 + minutes);
}

function made(start: number, end: number | undefined, offset: number | undefined, precision: Precision): Instant {
  return {
    start_ms: start,
    ...(end === undefined ? {} : { end_ms: end }),
    ...(offset === undefined ? {} : { offset_min: offset }),
    precision,
  };
}

function checked(time: Instant): Instant {
  if (time.start_ms < MIN_MS || time.start_ms > MAX_MS) fail("range", `${new Date(time.start_ms).toISOString()} lies outside the years 1000 to 9999`);
  return time;
}


function offsetMs(ms: number, zone: string, offsets: Map<string, number> = offsetCache): number {
  const fixed = fixedZone(zone);
  if (fixed !== undefined) return fixed;
  const hour = Math.floor(ms / HOUR);
  const key = `${zone}\u0000${hour}`;
  const cached = offsets.get(key);
  if (cached !== undefined) return cached;
  const start = intlOffset(hour * HOUR, zone);
  if (start === intlOffset(hour * HOUR + HOUR - 1, zone)) {
    remember(offsets, key, start);
    return start;
  }
  return intlOffset(ms, zone);
}

function fixedZone(zone: string): number | undefined {
  if (zone === "UTC" || zone === "Etc/UTC" || zone === "GMT" || zone === "Etc/GMT") return 0;
  const m = /^([+-])(\d{2}):(\d{2})$/u.exec(zone);
  if (m === null) return undefined;
  const hours = Number(m[2]);
  const minutes = Number(m[3]);
  if (hours > 23 || minutes > 59) fail("zone", `${quote(zone)} is not a zone`);
  return (m[1] === "-" ? -1 : 1) * (hours * 60 + minutes) * MINUTE;
}

function intlOffset(ms: number, zone: string): number {
  const fmt = formatter(zone);
  const text = fmt.format(ms);
  const wall = text.length === 20
    ? Date.UTC(Number(text.slice(6, 10)), Number(text.slice(0, 2)) - 1, Number(text.slice(3, 5)), Number(text.slice(12, 14)), Number(text.slice(15, 17)), Number(text.slice(18, 20)))
    : (() => {
      const parts = fmt.formatToParts(ms);
      const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
      return utcMs(get("year"), get("month"), get("day"), get("hour"), get("minute"), get("second"));
    })();
  return wall - (ms - mod(ms, 1000));
}

function wallToMs(wall: number, zone: string, offsets: Map<string, number> = offsetCache): number {
  const before = offsetMs(wall - DAY, zone, offsets);
  const after = offsetMs(wall + DAY, zone, offsets);
  if (before === after) {
    const ms = wall - before;
    if (offsetMs(ms, zone, offsets) === before) return ms;
  }
  const candidates = new Set([before, after, offsetMs(wall - before, zone, offsets), offsetMs(wall - after, zone, offsets)]);
  let found: number | undefined;
  for (const offset of candidates) {
    const ms = wall - offset;
    if (offsetMs(ms, zone, offsets) === offset && (found === undefined || ms < found)) found = ms;
  }
  return found ?? wall - before;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let found = formatters.get(zone);
  if (found === undefined) {
    try {
      found = new Intl.DateTimeFormat("en-US", {
        timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
      });
    } catch {
      return fail("zone", `${quote(zone)} is not a zone this runtime knows`);
    }
    formatters.set(zone, found);
  }
  return found;
}

const offsetCache = new Map<string, number>();
const boundsCache = new Map<string, { start_ms: number; end_ms: number }>();
const runsCache = new Map<string, DayRun[]>();

function remember<V>(cache: Map<string, V>, key: string, value: V): void {
  if (cache.size >= 200_000) cache.clear();
  cache.set(key, value);
}


const RANK: Record<Precision, number> = { ms: 0, s: 1, minute: 2, day: 3, month: 4, year: 5 };

function isDate(precision: Precision): boolean {
  return precision === "day" || precision === "month" || precision === "year";
}

function checkMs(ms: number): void {
  if (!Number.isSafeInteger(ms) || ms < MIN_MS || ms > MAX_MS) fail("range", `${ms} is not an integer millisecond in the years 1000 to 9999`);
}

function checkSettings(settings: DaySettings): void {
  const hour = settings.day_start_hour;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) fail("settings", `day_start_hour ${hour} is not an hour 0 to 23`);
  if (fixedZone(settings.zone) === undefined) formatter(settings.zone);
}

function dateMs(day: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(day) ?? fail("spelling", `${quote(day)} is not a 'YYYY-MM-DD' day`);
  return dateSpan(Number(m[1]), Number(m[2]), Number(m[3]), "day", day).start_ms;
}

function utcDate(ms: number): string {
  const date = new Date(ms);
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function daysInMonth(year: number, month: number): number {
  return month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function text(value: string | number, rule: TimeRule): string {
  if (typeof value !== "string") fail("spelling", `a ${rule} value is a string, not ${typeof value}`);
  return value;
}

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n ? q - 1n : q;
}

function mod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function quote(value: string): string {
  return JSON.stringify(value.length > 64 ? `${textHead(value, 64)}…` : value);
}

function fail(code: TimeErrorCode, message: string): never {
  throw new TimeError(code, message);
}
