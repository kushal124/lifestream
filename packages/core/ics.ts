import { instant, TimeError } from "./time.js";

const REFUSED: unique symbol = Symbol.for("lifestream.refused") as never;

export class IcsError extends Error {
  readonly [REFUSED] = true as const;

  constructor(message: string) {
    super(message);
    this.name = "IcsError";
  }
}

function fail(message: string): never {
  throw new IcsError(message);
}

export interface IcsProperty {
  name: string;
  params: Readonly<Record<string, string>>;
  value: string;
}

export interface IcsLine {
  content: string;
  where: string;
}

export interface IcsComponent {
  name: string;
  lines: IcsLine[];
  children: IcsComponent[];
  content: string;
  startByte: number;
  endByte: number;
}

export interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

interface Onset {
  offsetFrom: number;
  offsetTo: number;
  start: LocalDateTime;
  yearly?: OnsetRule;
}

interface OnsetRule {
  text: string;
  where: string;
  month: number;
  weekdays: { weekday: number; nth: number }[];
  monthDays: number[];
  until?: number;
}

export interface VTimezone {
  tzid: string;
  onsets: Onset[];
}

export interface IcsCalendar {
  root: IcsComponent;
  events: IcsComponent[];
  zones: Map<string, VTimezone>;
}

export type IcsTime =
  | {
    form: "utc";
    text: string;
  }
  | {
    form: "local";
    local: LocalDateTime;
    tzid: string;
  }
  | {
    form: "date";
    date: string;
  };

const SAFE_FROM_YEAR = 2007;
const FRAME = /^(?:BEGIN|END)[;:]/iu;
const WEEKDAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

export function parseCalendar(bytes: Uint8Array, where: string): IcsCalendar {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail(`${where}: is not valid UTF-8`);
  }
  if (!/^BEGIN:VCALENDAR\r?\n/u.test(text)) fail(`${where}: does not begin with a BEGIN:VCALENDAR line`);
  const root = readComponent(text, where);
  if (root.name !== "VCALENDAR") fail(`${where}: the root component is not VCALENDAR`);
  if (root.startByte !== 0 || root.endByte !== bytes.byteLength) fail(`${where}: holds bytes outside its one VCALENDAR`);
  const zones = new Map<string, VTimezone>();
  const events: IcsComponent[] = [];
  for (const child of root.children) {
    if (child.name === "VTIMEZONE") {
      const zone = parseZone(child, where);
      if (zones.has(zone.tzid)) fail(`${where}: states two VTIMEZONEs for ${zone.tzid}`);
      zones.set(zone.tzid, zone);
    } else if (child.name === "VEVENT") {
      events.push(child);
    }
  }
  const file = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const event of events) {
    if (!file.subarray(event.startByte, event.endByte).equals(Buffer.from(event.content, "utf8"))) fail(`${where}: a VEVENT's text is not its byte slice`);
  }
  return { root, events, zones };
}

export function readComponent(text: string, where: string): IcsComponent {
  const eol = /^BEGIN[;:][^\r\n]*(\r?\n)/iu.exec(text)?.[1] ?? fail(`${where}: does not begin with a BEGIN line`);
  const lines = unfold(text, eol, where);
  const stack: { component: IcsComponent; line: number }[] = [];
  let root: IcsComponent | undefined;
  for (const [index, line] of lines.entries()) {
    const at = `${where} line ${index + 1}`;
    const open = stack[stack.length - 1];
    if (!FRAME.test(line.content)) {
      if (open === undefined) fail(`${at}: a content line is outside a component`);
      open.component.lines.push({ content: line.content, where: at });
      continue;
    }
    const property = readProperty(line.content, at);
    if (property.name === "BEGIN") {
      if (Object.keys(property.params).length > 0 || property.value.length === 0) fail(`${at}: malformed BEGIN`);
      if (open === undefined && root !== undefined) fail(`${where}: holds more than one top-level component`);
      const component: IcsComponent = { name: property.value.toUpperCase(), lines: [], children: [], content: "", startByte: line.offset, endByte: line.end };
      open?.component.children.push(component);
      stack.push({ component, line: index });
      continue;
    }
    if (Object.keys(property.params).length > 0 || open === undefined || open.component.name !== property.value.toUpperCase()) {
      fail(`${at}: END:${property.value} closes no open component of that name`);
    }
    open.component.content = lines.slice(open.line, index + 1).map((candidate) => candidate.raw).join("");
    open.component.endByte = line.end;
    stack.pop();
    if (stack.length === 0) root = open.component;
  }
  if (stack.length > 0) fail(`${where}: BEGIN:${stack[stack.length - 1]!.component.name} is never closed`);
  return root ?? fail(`${where}: holds no component`);
}

export function readEvent(text: string): IcsProperty[] | null {
  try {
    const event = readComponent(text, "the event");
    return event.name === "VEVENT" ? properties(event) : null;
  } catch (error) {
    if (error instanceof IcsError) return null;
    throw error;
  }
}

interface Line {
  content: string;
  raw: string;
  offset: number;
  end: number;
}

function unfold(text: string, eol: string, where: string): Line[] {
  const sources = text.split(eol);
  if (sources[sources.length - 1] === "") sources.pop();
  const unterminated = text.endsWith(eol) ? -1 : sources.length - 1;
  const out: Line[] = [];
  let offset = 0;
  for (const [index, source] of sources.entries()) {
    const raw = index === unterminated ? source : `${source}${eol}`;
    const length = Buffer.byteLength(raw, "utf8");
    const previous = out[out.length - 1];
    if (source.startsWith(" ") || source.startsWith("\t")) {
      if (previous === undefined) fail(`${where}: begins with a folded continuation`);
      previous.content += source.slice(1);
      previous.raw += raw;
      previous.end = offset + length;
    } else {
      out.push({ content: source, raw, offset, end: offset + length });
    }
    offset += length;
  }
  return out;
}

export function properties(component: IcsComponent): IcsProperty[] {
  return component.lines.map((line) => readProperty(line.content, line.where));
}

export function single(component: IcsComponent, name: string, where: string): IcsProperty | undefined {
  const found = properties(component).filter((property) => property.name === name);
  if (found.length > 1) fail(`${where}: ${found.length} ${name} properties make the value ambiguous`);
  return found[0];
}

export function readProperty(content: string, where: string): IcsProperty {
  let quoted = false;
  let colon = -1;
  for (let index = 0; index < content.length; index++) {
    if (content[index] === '"') quoted = !quoted;
    else if (content[index] === ":" && !quoted) {
      colon = index;
      break;
    }
  }
  if (colon < 1) fail(`${where}: a content line has no unquoted value separator`);
  const head = content.slice(0, colon);
  const semicolon = head.indexOf(";");
  const name = semicolon === -1 ? head : head.slice(0, semicolon);
  if (!/^[A-Za-z0-9-]+$/u.test(name)) fail(`${where}: malformed property name ${JSON.stringify(name)}`);
  return { name: name.toUpperCase(), params: semicolon === -1 ? {} : parameters(head.slice(semicolon), where), value: content.slice(colon + 1) };
}

function parameters(text: string, where: string): Record<string, string> {
  const out: Record<string, string> = {};
  let index = 0;
  while (index < text.length) {
    if (text[index] !== ";") fail(`${where}: malformed parameters`);
    index++;
    const equals = text.indexOf("=", index);
    if (equals === -1) fail(`${where}: a parameter has no equals sign`);
    const key = text.slice(index, equals).toUpperCase();
    if (!/^[A-Z0-9-]+$/u.test(key)) fail(`${where}: malformed parameter name ${JSON.stringify(key)}`);
    index = equals + 1;
    const values: string[] = [];
    for (;;) {
      if (text[index] === '"') {
        const end = text.indexOf('"', index + 1);
        if (end === -1) fail(`${where}: an unterminated quoted parameter`);
        values.push(text.slice(index + 1, end));
        index = end + 1;
      } else {
        let end = index;
        while (end < text.length && text[end] !== ";" && text[end] !== ",") {
          if (text[end] === '"') fail(`${where}: parameter ${key} holds a quote outside quotes`);
          end++;
        }
        values.push(text.slice(index, end));
        index = end;
      }
      if (text[index] !== ",") break;
      index++;
    }
    if (index < text.length && text[index] !== ";") fail(`${where}: characters follow a quoted parameter`);
    if (Object.hasOwn(out, key)) fail(`${where}: parameter ${key} appears twice`);
    out[key] = values.map(rfc6868).join(",");
  }
  return out;
}

function rfc6868(value: string): string {
  let out = "";
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== "^" || index + 1 >= value.length) {
      out += value[index];
      continue;
    }
    const escaped = value[++index]!;
    out += escaped === "^" ? "^" : escaped === "'" ? '"' : escaped === "n" || escaped === "N" ? "\n" : `^${escaped}`;
  }
  return out;
}

export function unescapeText(value: string): string {
  return value.replace(/\\(.)/gsu, (whole, escaped: string) =>
    escaped === "n" || escaped === "N" ? "\n" : escaped === "," || escaped === ";" || escaped === "\\" ? escaped : whole);
}

function parseZone(component: IcsComponent, where: string): VTimezone {
  const tzid = single(component, "TZID", `${where} VTIMEZONE`)?.value;
  if (tzid === undefined || tzid.length === 0) fail(`${where}: a VTIMEZONE states no TZID`);
  const onsets: Onset[] = [];
  for (const child of component.children) {
    if (child.name !== "STANDARD" && child.name !== "DAYLIGHT") continue;
    const at = `${where} VTIMEZONE ${tzid} ${child.name}`;
    const from = single(child, "TZOFFSETFROM", at)?.value;
    const to = single(child, "TZOFFSETTO", at)?.value;
    const start = single(child, "DTSTART", at)?.value;
    if (from === undefined || to === undefined || start === undefined) fail(`${at}: needs TZOFFSETFROM, TZOFFSETTO and DTSTART`);
    const rule = single(child, "RRULE", at)?.value;
    const onset: Onset = { offsetFrom: utcOffset(from, at), offsetTo: utcOffset(to, at), start: localDateTime(start, at) };
    if (rule !== undefined) onset.yearly = onsetRule(rule, onset, at);
    onsets.push(onset);
  }
  if (onsets.length === 0) fail(`${where}: VTIMEZONE ${tzid} states no STANDARD or DAYLIGHT rule`);
  return { tzid, onsets };
}

function utcOffset(value: string, where: string): number {
  const match = /^([+-])(\d{2})(\d{2})(\d{2})?$/u.exec(value) ?? fail(`${where}: ${JSON.stringify(value)} is not [+-]HHMM`);
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 23 || minutes > 59) fail(`${where}: the UTC offset is out of range`);
  if (match[4] !== undefined && Number(match[4]) !== 0) fail(`${where}: an offset in seconds cannot be stated in RFC 3339`);
  return (match[1] === "-" ? -1 : 1) * (hours * 60 + minutes);
}

export function localDateTime(value: string, where: string): LocalDateTime {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/u.exec(value) ?? fail(`${where}: ${JSON.stringify(value)} is not YYYYMMDDTHHMMSS`);
  const local = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6]) };
  if (!reads(`${localText(local)}Z`, "rfc3339")) fail(`${where}: ${JSON.stringify(value)} is not a real calendar time`);
  return local;
}

function onsetRule(value: string, onset: Onset, where: string): OnsetRule {
  const at = `${where} RRULE ${value}`;
  const parts = new Map<string, string>();
  for (const part of value.split(";")) {
    const equals = part.indexOf("=");
    if (equals < 1) fail(`${at}: malformed RRULE part ${JSON.stringify(part)}`);
    const name = part.slice(0, equals).toUpperCase();
    if (parts.has(name)) fail(`${at}: the RRULE repeats ${name}`);
    parts.set(name, part.slice(equals + 1).toUpperCase());
  }
  const freq = parts.get("FREQ");
  if (freq !== "YEARLY") fail(`${at}: a zone's onset turns once a year, FREQ=YEARLY; ${freq === undefined ? "the rule states no FREQ" : `FREQ=${freq} is not read`}`);
  const unread = [...parts.keys()]
    .filter((name) => !["FREQ", "INTERVAL", "UNTIL", "WKST", "BYMONTH", "BYDAY", "BYMONTHDAY"].includes(name) || (name === "INTERVAL" && parts.get(name) !== "1"))
    .map((name) => (name === "INTERVAL" ? `INTERVAL=${parts.get(name)}` : name));
  if (unread.length > 0) {
    fail(`${at}: ${unread.join(", ")} cannot state a zone's onset; it is read from FREQ=YEARLY, INTERVAL=1, UNTIL, WKST, BYMONTH, BYDAY and BYMONTHDAY`);
  }
  const integers = (name: string, low: number, high: number): number[] => {
    const text = parts.get(name);
    if (text === undefined) return [];
    return text.split(",").map((item) => {
      const number = /^[+-]?\d{1,3}$/u.test(item) ? Number(item) : Number.NaN;
      if (!Number.isInteger(number) || number === 0 || number < low || number > high) fail(`${at}: ${name}=${text} is not a list of whole numbers from ${low} to ${high}, never 0`);
      return number;
    });
  };
  const months = integers("BYMONTH", 1, 12);
  if (months.length > 1) fail(`${at}: BYMONTH=${parts.get("BYMONTH")} turns the zone in more than one month a year; an onset rule names one`);
  const wkst = parts.get("WKST");
  if (wkst !== undefined && WEEKDAYS[wkst] === undefined) fail(`${at}: WKST=${wkst} is not a weekday (SU, MO, …)`);
  const weekdays = (parts.get("BYDAY")?.split(",") ?? []).map((item) => {
    const match = /^([+-]?\d{1,2})?([A-Z]{2})$/u.exec(item);
    const weekday = match === null ? undefined : WEEKDAYS[match[2]!];
    const nth = match?.[1] === undefined ? 0 : Number(match[1]);
    if (weekday === undefined || (match![1] !== undefined && (nth === 0 || Math.abs(nth) > 5))) {
      fail(`${at}: BYDAY=${parts.get("BYDAY")} is not a list of weekdays, each with an ordinal in the month from -5 to 5 or none (-1SU, 2SU, SU)`);
    }
    return { weekday, nth };
  });
  const monthDays = integers("BYMONTHDAY", -31, 31);
  if (months.length === 0 && (weekdays.length > 0 || monthDays.length > 0)) {
    fail(`${at}: BYDAY or BYMONTHDAY with no BYMONTH names a day of every month or of the whole year; an onset rule names its month by BYMONTH`);
  }
  const rule: OnsetRule = { text: value, where, month: months[0] ?? onset.start.month, weekdays, monthDays };
  const until = parts.get("UNTIL");
  if (until !== undefined) {
    if (!until.endsWith("Z")) fail(`${at}: UNTIL=${until} is no UTC time; RFC 5545 ends a zone's onset rule at one (YYYYMMDDTHHMMSSZ)`);
    rule.until = utcMs(localDateTime(until.slice(0, -1), `${at} UNTIL`));
  }
  return rule;
}

function onsetDays(onset: Onset, year: number): number[] {
  const rule = onset.yearly!;
  const length = new Date(Date.UTC(year, rule.month, 0)).getUTCDate();
  let days = Array.from({ length }, (_, index) => index + 1);
  if (rule.weekdays.length === 0 && rule.monthDays.length === 0) days = days.filter((day) => day === onset.start.day);
  if (rule.monthDays.length > 0) days = days.filter((day) => rule.monthDays.some((stated) => (stated > 0 ? stated : length + 1 + stated) === day));
  if (rule.weekdays.length > 0) {
    days = days.filter((day) => rule.weekdays.some(({ weekday, nth }) =>
      new Date(Date.UTC(year, rule.month - 1, day)).getUTCDay() === weekday
      && (nth === 0 || (nth > 0 ? Math.ceil(day / 7) === nth : Math.ceil((length + 1 - day) / 7) === -nth))));
  }
  return days;
}

function turnWall(onset: Onset, year: number, day: number): number {
  return Date.UTC(year, onset.yearly!.month - 1, day, onset.start.hour, onset.start.minute, onset.start.second);
}

function yearTurn(onset: Onset, year: number): number | null {
  const rule = onset.yearly!;
  if (year < onset.start.year) return null;
  if (rule.until !== undefined && Date.UTC(year, rule.month - 1, 1) - 86_400_000 > rule.until) return null;
  const days = onsetDays(onset, year);
  if (days.length !== 1) {
    fail(`${rule.where}: the RRULE ${rule.text} names ${days.length === 0 ? "no day" : `${days.length} days`} in ${year}-${String(rule.month).padStart(2, "0")}; a zone turns once a year by each rule`);
  }
  const wall = turnWall(onset, year, days[0]!);
  if (wall < utcMs(onset.start)) return null;
  if (rule.until !== undefined && wall - onset.offsetFrom * 60_000 > rule.until) return null;
  return wall;
}

export function zoneOffset(zone: VTimezone, local: LocalDateTime, where: string): number {
  if (local.year < SAFE_FROM_YEAR) {
    fail(`${where}: a local time before ${SAFE_FROM_YEAR} is refused: the export's VTIMEZONE states no earlier transitions`);
  }
  const transitions: { at: number; offsetTo: number }[] = [];
  for (const onset of zone.onsets) {
    if (onset.yearly === undefined) {
      transitions.push({ at: utcMs(onset.start) - onset.offsetFrom * 60_000, offsetTo: onset.offsetTo });
      continue;
    }
    const turned = (year: number): boolean => {
      const wall = yearTurn(onset, year);
      if (wall !== null) transitions.push({ at: wall - onset.offsetFrom * 60_000, offsetTo: onset.offsetTo });
      return wall !== null;
    };
    for (let year = local.year - 1; year <= local.year + 1; year++) turned(year);
    const until = onset.yearly.until;
    const last = Math.min(local.year - 2, until === undefined ? Number.POSITIVE_INFINITY : new Date(until).getUTCFullYear());
    for (let year = last; year >= onset.start.year && !turned(year); year--);
  }
  transitions.sort((left, right) => left.at - right.at);
  const earliest = zone.onsets.reduce((left, right) =>
    utcMs(left.start) - left.offsetFrom * 60_000 <= utcMs(right.start) - right.offsetFrom * 60_000 ? left : right,
  );
  const base = earliest.offsetFrom;
  const offsetAt = (at: number): number => {
    let offset = base;
    for (const transition of transitions) {
      if (transition.at > at) break;
      offset = transition.offsetTo;
    }
    return offset;
  };
  const wall = utcMs(local);
  const candidates = [...new Set([base, ...transitions.map((item) => item.offsetTo)])].filter((offset) => offsetAt(wall - offset * 60_000) === offset);
  if (candidates.length !== 1) fail(`${where}: the local time is ${candidates.length === 0 ? "in a gap" : "ambiguous in a fold"}`);
  return candidates[0]!;
}

function utcMs(local: LocalDateTime): number {
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
}

export function timeValue(property: IcsProperty, where: string): IcsTime {
  const type = property.params.VALUE?.toUpperCase();
  const tzid = property.params.TZID;
  if (type === "DATE") {
    if (tzid !== undefined) fail(`${where}: VALUE=DATE carries a TZID`);
    if (!/^\d{8}$/u.test(property.value)) fail(`${where}: the date is not YYYYMMDD`);
    const date = `${property.value.slice(0, 4)}-${property.value.slice(4, 6)}-${property.value.slice(6, 8)}`;
    if (!isDate(date)) fail(`${where}: ${date} is not a calendar date`);
    return { form: "date", date };
  }
  if (type !== undefined && type !== "DATE-TIME") fail(`${where}: VALUE=${type} is not read`);
  if (property.value.endsWith("Z")) {
    if (tzid !== undefined) fail(`${where}: a UTC value carries a TZID`);
    return { form: "utc", text: `${localText(localDateTime(property.value.slice(0, -1), where))}Z` };
  }
  if (tzid === undefined) fail(`${where}: a floating local time states neither Z nor TZID`);
  return { form: "local", local: localDateTime(property.value, where), tzid };
}

export function timedText(value: Exclude<IcsTime, { form: "date" }>, zones: ReadonlyMap<string, VTimezone>, where: string): string {
  if (value.form === "utc") return value.text;
  const zone = zones.get(value.tzid) ?? fail(`${where}: TZID=${value.tzid} has no VTIMEZONE in this file`);
  const offset = zoneOffset(zone, value.local, where);
  const sign = offset < 0 ? "-" : "+";
  const magnitude = Math.abs(offset);
  return `${localText(value.local)}${sign}${String(Math.floor(magnitude / 60)).padStart(2, "0")}:${String(magnitude % 60).padStart(2, "0")}`;
}

function localText(local: LocalDateTime): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return `${pad(local.year, 4)}-${pad(local.month)}-${pad(local.day)}T${pad(local.hour)}:${pad(local.minute)}:${pad(local.second)}`;
}

export function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) && reads(value, "date");
}

function reads(value: string, rule: "rfc3339" | "date"): boolean {
  try {
    instant(value, rule);
    return true;
  } catch (error) {
    if (error instanceof TimeError) return false;
    throw error;
  }
}
