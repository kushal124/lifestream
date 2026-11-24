import type { PhoneGrant } from "@lifestreamprotocol/connect";
import { civilDay, type DaySettings } from "@lifestreamprotocol/core";
import type { Requirement } from "./health.js";
import type { Allowed, Cause, Recorder, RecorderState } from "./stated.js";

export const NB = "\u00a0";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const PLURAL = new Intl.PluralRules("en-US");

const formatters = new Map<string, Intl.DateTimeFormat>();
const SHOWS: Record<"day" | "clock", [string, Intl.DateTimeFormatOptions]> = {
  day: ["en-CA", {}],
  clock: ["en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }],
};

function shown(kind: keyof typeof SHOWS, ms: number, zone: string): string {
  const key = `${kind} ${zone}`;
  let formatter = formatters.get(key);
  if (formatter === undefined) {
    const [locale, options] = SHOWS[kind];
    formatters.set(key, formatter = new Intl.DateTimeFormat(locale, { ...options, timeZone: zone }));
  }
  return formatter.format(ms);
}

const dayIn = (ms: number, zone: string): string => shown("day", ms, zone);
const clock = (ms: number, zone: string): string => shown("clock", ms, zone);

export const number = (count: number): string => count.toLocaleString("en-US");
export const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
export const listWords = (titles: readonly string[]): string =>
  titles.length > 1 ? `${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}` : titles[0] ?? "";

export const amount = (count: number, noun: readonly [string, string] | null): string =>
  noun === null ? number(count) : `${number(count)}${NB}${noun[PLURAL.select(count) === "one" ? 0 : 1]}`;

export const leftWords = (left: number, unit: readonly [string, string] | null): string => `${amount(left, unit)} left`;

export const progressWords = (done: number, total: number): string => `${number(done)} of about${NB}${number(total)}`;

export const CAP = 1_000;
export const cappedWords = (count: number, noun: readonly [string, string]): string => (count > CAP ? `over ${amount(CAP, noun)}` : amount(count, noun));
export const filesWords = (count: number): string => cappedWords(count, ["file", "files"]);

export function sizeWords(bytes: number): string {
  if (bytes >= 10e9) return `${number(Math.round(bytes / 1e9))}${NB}GB`;
  if (bytes >= 1e9) return `${(Math.round(bytes / 1e8) / 10).toFixed(1)}${NB}GB`;
  if (bytes >= 999_500) return `${number(Math.round(bytes / 1e6))}${NB}MB`;
  return `${number(Math.max(1, Math.round(bytes / 1e3)))}${NB}KB`;
}

export const monthNamed = (month: string): string => `${MONTHS[Number(month.slice(5, 7)) - 1]!} ${month.slice(0, 4)}`;

export const monthWords = (ms: number, day: DaySettings): string => monthNamed(civilDay(ms, day).slice(0, 7));

export function when(ms: number, now: number, day: DaySettings): string {
  const [then, today] = [civilDay(ms, day), civilDay(now, day)];
  const days = Math.round((Date.parse(today) - Date.parse(then)) / DAY_MS);
  const at = clock(ms, day.zone);
  if (days === 0 || dayIn(ms, day.zone) === dayIn(now, day.zone)) return at;
  if (days === 1) return `yesterday ${at}`;
  if (days === -1) return `tomorrow ${at}`;
  const [y, m, d] = then.split("-").map(Number) as [number, number, number];
  if (Math.abs(days) < 7) return WEEKDAY_NAMES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
  return dayWords(ms, now, day);
}

export function whenItem(ms: number, dated: boolean, now: number, day: DaySettings): string {
  if (!dated) return when(ms, now, day);
  const [then, today] = [new Date(ms).toISOString().slice(0, 10), civilDay(now, day)];
  const days = Math.round((Date.parse(today) - Date.parse(then)) / DAY_MS);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days === -1) return "tomorrow";
  const [y, m, d] = then.split("-").map(Number) as [number, number, number];
  if (Math.abs(days) < 7) return WEEKDAY_NAMES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
  return [String(d), MONTHS[m - 1]!, y === Number(today.slice(0, 4)) ? "" : String(y)].filter(Boolean).join(" ");
}

export function dayWords(ms: number, now: number, day: DaySettings): string {
  const [y, m, d] = civilDay(ms, day).split("-").map(Number) as [number, number, number];
  return [String(d), MONTHS[m - 1]!, y === Number(civilDay(now, day).slice(0, 4)) ? "" : String(y)].filter(Boolean).join(" ");
}

function dateWords(ms: number, zone: string, { weekday = true, year }: { weekday?: boolean; year?: number } = {}): string {
  const [y, m, d] = dayIn(ms, zone).split("-").map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d));
  return [weekday ? WEEKDAYS[at.getUTCDay()]! : "", String(d), MONTHS[m - 1]!, y === year ? "" : String(y)].filter(Boolean).join(" ");
}

const UNITS: Record<string, [string, string, number]> = {
  s: ["second", "seconds", 1_000], m: ["minute", "minutes", 60_000], h: ["hour", "hours", HOUR_MS], d: ["day", "days", DAY_MS],
};

export function unitOf(word: string): { count: number; unit: string; ms: number } | null {
  const match = /^(\d+)([smhd])$/u.exec(word);
  return match === null ? null : { count: Number(match[1]), unit: match[2]!, ms: Number(match[1]) * UNITS[match[2]!]![2] };
}

export function durationWords(word: string): string {
  const of = unitOf(word);
  return of === null ? word : `${number(of.count)} ${UNITS[of.unit]![of.count === 1 ? 0 : 1]}`;
}

export function everyWords(word: string): string {
  const of = unitOf(word);
  if (of === null) return word;
  if (of.count === 1) return of.unit === "d" ? "Daily" : `Every ${UNITS[of.unit]![0]}`;
  return `Every ${durationWords(word)}`;
}

const SHORT: Record<string, [string, string]> = { s: ["second", "sec"], m: ["minute", "min"], h: ["hour", "hours"], d: ["day", "days"] };

export function paceWords(word: string): string {
  const of = unitOf(word);
  if (of === null) return word;
  return of.count === 1 ? `Every ${SHORT[of.unit]![0]}` : `Every ${number(of.count)} ${SHORT[of.unit]![1]}`;
}

const LADDER = ["1s", "2s", "5s", "10s", "30s", "1m", "2m", "5m", "10m", "15m", "30m", "1h", "6h", "12h", "1d"];

export function ladderOf(at: string, fallback: string | null, min: string | null, max: string | null): string[] {
  const low = min === null ? 0 : unitOf(min)?.ms ?? 0;
  const high = max === null ? Infinity : unitOf(max)?.ms ?? Infinity;
  const steps = LADDER.filter((step) => unitOf(step)!.ms >= low && unitOf(step)!.ms <= high);
  for (const own of [at, fallback]) if (own !== null && own !== "" && !steps.includes(own)) steps.push(own);
  return steps.sort((a, b) => (unitOf(a)?.ms ?? Infinity) - (unitOf(b)?.ms ?? Infinity));
}

export function startWords(day: string | null): string {
  return day === null ? "All time" : `From ${dateWords(Date.parse(`${day}T12:00:00Z`), "UTC", { weekday: false })}`;
}

export function zoneWords(zone: string, now: number): string {
  const city = zone.split("/").at(-1)?.replaceAll("_", " ") ?? zone;
  try {
    const offset = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" }).formatToParts(now)
      .find((part) => part.type === "timeZoneName")?.value ?? "";
    return offset !== "" && offset !== city ? `${city} · ${offset}` : city;
  } catch {
    return zone;
  }
}

export function holdsWords(value: unknown, modes: boolean, empty = "None"): string {
  const values = Array.isArray(value) ? value : [];
  if (modes) {
    const counts = ([["exclude", "never"], ["activity", "activity only"]] as const)
      .map(([mode, words]) => [values.filter((item) => (item as { mode?: unknown } | null)?.mode === mode).length, words] as const).filter(([count]) => count > 0);
    return counts.map(([count, words]) => `${count} ${words}`).join(", ") || "Everything recorded";
  }
  return values.length === 0 ? empty : number(values.length);
}

export function addWords(label: string): string {
  if (!/s$/u.test(label) || /\s/u.test(label)) return `Add to ${label}`;
  const one = label.slice(0, -1).toLowerCase();
  return `Add ${/^[aeiou]/u.test(one) ? "an" : "a"} ${one}`;
}

export function aboutLeft(minutes: number): string {
  if (minutes < 55) return `about${NB}${Math.max(5, Math.round(minutes / 5) * 5)}${NB}min`;
  const hours = minutes / 60;
  if (hours < 36) return `about${NB}${Math.max(1, Math.round(hours))}${NB}h`;
  const days = Math.round(hours / 24);
  return `about${NB}${days}${NB}${days === 1 ? "day" : "days"}`;
}

const PARTLY: Readonly<Record<string, string>> = {
  location: "While Using only", photos: "Selected photos", contacts: "Some contacts", health: "New data to allow",
};

export function grantWord(grant: PhoneGrant, state: Allowed): string {
  switch (state) {
    case "on": return "On";
    case "asking": return "Asking";
    case "not-now": return "Not now";
    case "not-asked": return "Not asked";
    case "asked": return "Asked";
    case "off": return "Off";
    case "limited": return PARTLY[grant] ?? "Limited";
  }
}

const GRANT_NAMES: Readonly<Record<string, string>> = {
  screenRecording: "Screen Recording", accessibility: "Accessibility", microphone: "the microphone", systemAudio: "System Audio",
  bluetooth: "Bluetooth", fullDiskAccess: "Full Disk Access", photos: "Photos", location: "Location", motion: "Motion",
  health: "Health", contacts: "Contacts", notifications: "Notifications", "screen-time": "Screen Time",
};
export const grantName = (grant: string): string => GRANT_NAMES[grant] ?? sentence(grant);

export const STORE_GRANT = "store:";
export const storeWords = (name: string, device: string, unsafe: boolean): string => (unsafe ? `${device} can’t read ${name}` : `Allow ${name} on ${device}`);
export const UNSAFE_LINE = "macOS blocks it";

export interface Words {
  name: string;
  noun: readonly [string, string] | null;
  now: number;
  day: DaySettings;
  facts: Readonly<Record<string, unknown>>;
}

export const wordsOf = (name: string, noun: readonly [string, string] | null, now: number, day: DaySettings, facts: Words["facts"] = {}): Words => ({ name, noun, now, day, facts });

const text = (facts: Words["facts"], key: string): string | undefined => (typeof facts[key] === "string" && facts[key] !== "" ? facts[key] as string : undefined);
const instant = (facts: Words["facts"], key: string): number | undefined => (typeof facts[key] === "number" ? facts[key] as number : undefined);
const accountOf = (facts: Words["facts"]): string | undefined => {
  const named = (value: unknown): string | undefined => (typeof value !== "object" || value === null ? undefined
    : text(value as Words["facts"], "email") ?? text(value as Words["facts"], "name"));
  return text(facts, "email") ?? named(facts.offered) ?? named(facts.account);
};

export function reasonWords(state: string, reason: string | null, words: Words): string {
  const { facts, now, day } = words;
  if (reason === "retrying" && text(facts, "code") === SESSION_LOG_UNREADABLE) return "A session log couldn't be read";
  const name = text(facts, "company") ?? words.name;
  const again = facts.again === true ? " again" : "";
  const device = text(facts, "device");
  const on = device === undefined ? "" : ` on ${device}`;
  const next = instant(facts, "next_ms");
  const at = next === undefined ? "" : ` · tries again ${when(next, now, day)}`;
  switch (reason) {
    case "form": return text(facts, "choose") === undefined ? `Set up ${name}${again}` : `Choose ${text(facts, "choose")!}${again}`;
    case "sign-in": return facts.way === "key" ? `Connect ${name}${again}` : `Sign in to ${name}${again}`;
    case "choose": return facts.extension === false ? "Add Lifestream to Chrome" : `Turn on ${name} in Chrome${again}`;
    case "app": {
      const mac = device ?? "your Mac";
      return facts.looked === false ? `Checking ${mac}…` : text(facts, "app") === undefined ? `${name} isn’t on ${mac}` : `Install ${text(facts, "app")!} on ${mac}`;
    }
    case "grant": {
      const id = text(facts, "grant") ?? "";
      if (id.startsWith(STORE_GRANT)) return storeWords(words.name, device ?? "your Mac", facts.unsafe === true);
      const grant = grantName(id);
      const where = state === "setup" ? on : "";
      if (facts.allowed !== "limited") return `Allow ${grant}${where}`;
      return id === "health" ? `Allow new Health data${where}` : `${grant} is limited${where}`;
    }
    case "pair": return device === undefined ? `Pair your iPhone${again}` : `Pair ${device} again`;
    case "export": return facts.bringing === true ? `Importing your ${name} export` : `Import your ${name} export${again}`;
    case "install": return `${text(facts, "install") ?? name}${again}`;
    case "offline": return "Waiting for internet";
    case "door": return facts.interrupted === true ? "Stopped when Lifestream quit · running again" : "Waiting for Lifestream to start";
    case "chrome": {
      const account = text(facts, "account") ?? (typeof facts.account === "object" && facts.account !== null ? text(facts.account as Words["facts"], "email") : undefined);
      const signed = account === undefined ? "" : ` signed in as ${account}`;
      return facts.why === "closed" ? "Chrome is closed" : facts.why === "busy" ? "Chrome is busy" : `Waiting for Chrome${signed}`;
    }
    case "provider-limit":
      return next === undefined ? `${name} asked to wait` : civilDay(next, day) === civilDay(now, day) ? `${name} allows more at ${when(next, now, day)}` : `${name} allows more ${when(next, now, day).split(" ")[0]}`;
    case "provider-making": {
      const since = instant(facts, "since_ms");
      const from = since === undefined ? "" : ` · since ${when(since, now, day)}`;
      switch (facts.step) {
        case "asked": return `Asked ${name} for your export${from}`;
        default: return `${name} is making your export${from}`;
      }
    }
    case "disk": return "Waiting for disk space on your Mac";
    case "metered": return "Waiting for Wi-Fi";
    case "power": return "Waiting for power";
    case "vault": return "Waiting for your passwords to unlock";
    case "retrying": return `Couldn’t reach ${name}${at}`;
    case "signed-out": return facts.road === "chrome" ? `Sign in to ${name} in Chrome` : `Sign in to ${name} again`;
    case "other-account": return `Another ${name} account`;
    case "confirm": return "Confirm it's you";
    case "password": return `Type your ${name} password${again}`;
    case "extension": return text(facts, "code") === "SITE_NOT_ALLOWED" ? `Allow Lifestream on ${name} in Chrome` : "Allow the extension in Chrome";
    case "failing": {
      if (device === undefined) return `Couldn’t read ${name}`;
      if (facts.answering === true) return `${device} isn’t sending`;
      return name === device ? `Couldn't send from ${device}` : `Couldn't send ${name}`;
    }
    case "import": return facts.unread === true ? `Couldn’t read what ${name} sent` : `Couldn’t import new ${(words.noun ?? ["item", "items"])[1]}`;
    case "provider-changed": return `${name} changed`;
    case "missing-file": return `Couldn't read ${filesWords(instant(facts, "files") ?? 0)}`;
    case "nothing-new": {
      const since = instant(facts, "since_ms");
      return since === undefined ? "Nothing new" : `Nothing new since ${when(since, now, day)}`;
    }
    case "device": {
      const since = instant(facts, "since_ms");
      return `Nothing from ${device ?? name}${since === undefined ? "" : ` since ${when(since, now, day)}`}`;
    }
    default: return "";
  }
}

export function reasonLine(state: string, reason: string | null, words: Words): string | undefined {
  const { facts, name } = words;
  const device = text(facts, "device");
  switch (reason) {
    case "grant": return text(facts, "grant")?.startsWith(STORE_GRANT) === true ? facts.unsafe === true ? UNSAFE_LINE : undefined
      : state === "setup" ? undefined : device;
    case "other-account": {
      const account = accountOf(facts);
      return account === undefined ? "In Chrome" : `${account} in Chrome`;
    }
    case "confirm": return text(facts, "company") ?? name;
    case "extension": return text(facts, "code") === "SITE_NOT_ALLOWED" ? "Click Allow in Lifestream’s popup in Chrome" : text(facts, "company") ?? name;
    case "failing": {
      if (device === undefined) return undefined;
      if (facts.answering === true) return "Open Lifestream on it";
      const code = text(facts, "code");
      if (code !== undefined) return sentence(sendStep(code, device));
      return name === device ? undefined : `From ${device}`;
    }
    case "import": return facts.unread === true ? text(facts, "why") : name;
    case "provider-changed": return "Update Lifestream to fix it";
    case "missing-file": return name;
    default: return undefined;
  }
}

export const SESSION_LOG_UNREADABLE = "SESSION_LOG_UNREADABLE";
export const OFF_WORD = "Disconnected";

function sendStep(code: string, device: string): string {
  switch (code) {
    case "LOCAL_STORAGE": return `check that ${device} has free space, then open Lifestream on it`;
    case "LOCAL_ACCESS":
    case "PHOTOS": return `open Lifestream on ${device}`;
    case "CLOCK_AHEAD": return `check the date and time on ${device}`;
    case "DISK_LOW": return "free space on your Mac’s disk";
    default: return `update Lifestream on ${device}`;
  }
}

export function metWords(kind: Requirement, words: Words): string {
  const { facts, now, day } = words;
  const device = text(facts, "device");
  switch (kind) {
    case "form": return "Set up";
    case "sign-in": return text(facts, "account") === undefined ? "Signed in" : `Signed in as ${text(facts, "account")!}`;
    case "choose": return "On in Chrome";
    case "app": return text(facts, "app") === undefined ? `Found on ${device ?? "your Mac"}` : `${text(facts, "app")!} is on ${device ?? "your Mac"}`;
    case "grant": {
      const id = text(facts, "grant") ?? "";
      return device === undefined ? `${id.startsWith(STORE_GRANT) ? words.name : sentence(grantName(id))} is allowed` : `Allowed on ${device}`;
    }
    case "pair": return device === undefined ? "Paired" : `${device} is paired`;
    case "export": return instant(facts, "at_ms") === undefined ? "Imported" : `Imported ${when(instant(facts, "at_ms")!, now, day)}`;
    case "install": return "Installed";
  }
}

const MAC_GRANT_LINES: Readonly<Record<string, string>> = {
  screenRecording: "macOS asks before any app sees your screen.",
  accessibility: "macOS asks before any app sees your keys and clicks.",
  microphone: "macOS asks before any app hears the microphone.",
  systemAudio: "macOS asks before any app hears your Mac’s sound.",
  photos: "macOS asks before any app sees your library.",
};

const PHONE_GRANT_LINES: Readonly<Record<string, string>> = {
  location: "Choose Always when your iPhone asks.",
  motion: "Choose Allow when your iPhone asks.",
  health: "Choose what to share when your iPhone asks.",
  photos: "Choose Full Access when your iPhone asks.",
  contacts: "Choose Full Access when your iPhone asks.",
  notifications: "Choose Allow when your iPhone asks.",
  "screen-time": "Choose Continue when your iPhone asks.",
};

export interface StepAbout {
  road: string;
  app: string | null;
  note: string | null;
  takes: string | null;
}

export function stepLine(kind: Requirement, words: Words, about: StepAbout): string | null {
  const { facts } = words;
  switch (kind) {
    case "form": return null;
    case "sign-in": return about.note;
    case "choose": return facts.extension === false ? "Lifestream reads in your own Chrome, where you’re signed in." : `Lifestream reads ${words.name} in your own Chrome, where you’re signed in.`;
    case "app": return facts.looked === false || text(facts, "app") === undefined ? null : "Lifestream finds it on its own once it’s installed.";
    case "grant": {
      const grant = text(facts, "grant") ?? "";
      if (grant.startsWith(STORE_GRANT)) return facts.unsafe === true ? null : "macOS asks before Lifestream reads another app’s data.";
      if (about.road === "phone") return PHONE_GRANT_LINES[grant] ?? null;
      return grant === "fullDiskAccess" ? `macOS keeps ${about.app ?? words.name} behind it.` : MAC_GRANT_LINES[grant] ?? null;
    }
    case "pair": return "Open Lifestream on your iPhone and pair it with your Mac.";
    case "export": return about.takes === null ? null : `${about.takes}.`;
    case "install": return "Downloads once, then runs on your Mac.";
  }
}

export interface WhereAbout {
  name: string;
  roads: readonly string[];
  app: string | null;
  store: boolean;
  library: boolean;
  every: string | null;
  file: string | null;
}

export function whereWords(about: WhereAbout): string | null {
  const has = (road: string) => about.roads.includes(road);
  const every = about.every === null ? "" : `, ${about.every.charAt(0).toLowerCase()}${about.every.slice(1)}`;
  if (has("poll")) return `${about.name}’s servers, from your Mac${every}. Nothing leaves your Mac but the request.`;
  if (has("chrome")) return `${about.name} in your own Chrome, where you’re signed in${every}.`;
  const mac = !has("mac") ? null : about.store ? `what ${about.app ?? about.name} keeps on your Mac` : about.library ? `your ${about.name} library on your Mac` : "your Mac, as you use it";
  const phone = has("phone") ? "your iPhone, which sends to your Mac" : null;
  if (mac !== null && phone !== null) return `${sentence(mac)}, and ${phone}.`;
  if (mac !== null) return `${sentence(mac)}. Nothing leaves it.`;
  if (phone !== null) return `${sentence(phone)}.`;
  if (has("upload")) return `The ${about.file ?? "file"} you import. Lifestream reads a copy; your file stays where it is.`;
  return null;
}

export function pausedWords(by: string, device: string | null, since: string | null, sensor = false): string {
  const paused = sensor ? "Reading paused" : "Paused";
  return by === "you" || by === "terminal" ? [`${paused} since`, since ?? ""].filter(Boolean).join(" ") : `${paused} on ${device ?? by}`;
}

export const RECORDER_WORDS: Readonly<Record<RecorderState | Cause, string>> = {
  recording: "Recording",
  starting: "Starting recording",
  paused: "Recording paused",
  disk: "Not recording",
  permission: "Screen Recording needs access",
  browser: "Not recording · browser not answering",
  capture: "Not recording · screen unavailable",
  away: "Not recording · Mac idle",
  private: "Not recording · private window or app",
};

export function recorderWords(recorder: Recorder): string {
  return RECORDER_WORDS[recorder.state === "interrupted" ? recorder.cause : recorder.state];
}

export function refreshWords(reason: "running" | "held" | "paused" | "offline" | "chrome" | "disk" | "vault" | "device",
  facts: { name: string; until_ms?: number | null; devices?: readonly string[]; now: number; day: DaySettings }): string {
  switch (reason) {
    case "running": return "Refreshing";
    case "held": return facts.until_ms === undefined || facts.until_ms === null ? `${facts.name} asked to wait` : `${facts.name} asked to wait until ${when(facts.until_ms, facts.now, facts.day)}`;
    case "paused": return "Paused";
    case "offline": return "Waiting for internet";
    case "chrome": return "Open Chrome";
    case "disk": return "Your Mac’s disk is full";
    case "vault": return "Unlock Lifestream first";
    case "device": return `Open Lifestream on ${listWords(facts.devices ?? []) || "your Mac"}`;
  }
}
