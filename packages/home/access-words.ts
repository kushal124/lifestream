import { addDays, baseOf, civilDay, DETAIL_TYPES, hides, TYPES, type BaseType, type Counts, type DaySettings, type DetailType, type Json, type Level, type Type } from "@lifestreamprotocol/core";
import { NOT_READS, type AccessBy, type AccessChangeWhat, type Came, type ReaderCallResult, type RequestBy, type RequestState, type Withheld } from "@lifestreamprotocol/model";
import {
  allowWithin, categoryOf, hiddenWithin, numbered, reachWithin, untilWithin, windowWithin,
  type Access, type Allow, type DraftAccess, type DraftAllow, type End, type HomeAccount, type Reach, type Window,
} from "@lifestreamprotocol/privacy";
import type { SignInAnswer } from "./agents.js";
import { FUNNEL_ON, TAKEN, troubleOf, type PublicState } from "./funnel.js";
import { readRef } from "./refs.js";
import { NOT_YET } from "./refusal.js";


export interface Words {
  account(account: string): string;
  product(product: string): string;
  address(account: string): string | null;
  readonly zone: string;
}

export interface SentenceAt {
  accounts?: readonly HomeAccount[];
  now_ms?: number | null;
  chat?: boolean;
}

interface Reading {
  reads: Read[];
  shared: Window | undefined;
  after: Window[];
}

function readingOf(access: DraftAccess, at: SentenceAt): Reading | null {
  const now_ms = at.now_ms ?? null;
  const live = access.allow.filter((allow) => "lasts_ms" in allow || now_ms === null || allow.until_ms === null || now_ms < allow.until_ms);
  if (live.length === 0) return null;
  const reads = readsOf(live, access.window, categoryOf(at.accounts ?? []), now_ms);
  const windows = new Set(reads.flatMap((read) => read.limits.map((limit) => windowKey(limit.window))));
  const shared = windows.size === 1 && reads.length > 0 ? reads[0]!.limits[0]!.window : undefined;
  return {
    reads, shared,
    after: [shared ?? null, access.window].filter((window): window is NonNullable<Window> => window !== null),
  };
}

function readsWords(reading: Reading, words: Words, now_ms: number | null): string {
  const end = (limit: Limits) => {
    if ("lasts_ms" in limit) return ` for ${spanWords(limit.lasts_ms)}`;
    if (limit.until_ms === null) return "";
    return ` until ${now_ms === null ? instantWords(limit.until_ms, words.zone) : dayWords(limit.until_ms, now_ms, words.zone)}`;
  };
  const listedPlain = reading.reads.every((read, index) => !read.only && (index === reading.reads.length - 1 || exceptionsOf(read).length === 0));
  const allTime = listedPlain && reading.shared === undefined && reading.after.length === 0;
  const phrase = (window: Window) => (window === null && allTime ? " from all time" : windowPhrase(window, words.zone));
  const parts = reading.reads.map((read): Part => {
    const limits = read.limits.map((limit) => `${reading.shared === undefined ? phrase(limit.window) : ""}${end(limit)}`.trim()).filter((each) => each !== "");
    return { text: `${readReachWords(read, words)}${read.only ? " only" : ""}${limits.length === 0 ? "" : ` ${listed(limits)}`}`, only: read.only, leaves: exceptionsOf(read).length > 0 };
  });
  return joined(parts);
}

export function sentenceOf(access: DraftAccess | null, name: string, words: Words, at: SentenceAt = {}): string {
  const reading = access === null ? null : readingOf(access, at);
  if (access === null || reading === null) return `${name} reads nothing yet.`;
  return `${name} reads ${readsPhrase(reading, words, at)}.${at.chat === true ? "" : ` ${hideSentence(access.hide)}`}`;
}

function readsPhrase(reading: Reading, words: Words, at: SentenceAt): string {
  return `${readsWords(reading, words, at.now_ms ?? null)}${reading.after.map((window) => windowPhrase(window, words.zone)).join("")}`;
}

interface Part {
  text: string;
  only: boolean;
  leaves: boolean;
}

function joined(parts: readonly Part[]): string {
  if (parts.every((part, index) => !part.only && (index === parts.length - 1 || !part.leaves))) return listed(parts.map((part) => part.text));
  return parts.map((part, index) => (index === 0 ? part.text : `${part.only ? ", " : ", plus "}${part.text}`)).join("");
}

type Limits = { window: Window } & End;

function endOf(entry: End): End {
  return "lasts_ms" in entry ? { lasts_ms: entry.lasts_ms } : { until_ms: entry.until_ms };
}

function endWithin(end: End, wider: End, now_ms: number | null): boolean {
  if ("lasts_ms" in end) return "lasts_ms" in wider ? end.lasts_ms <= wider.lasts_ms : wider.until_ms === null;
  if (!("lasts_ms" in wider)) return untilWithin(end.until_ms, wider.until_ms);
  return end.until_ms !== null && now_ms !== null && end.until_ms <= now_ms + wider.lasts_ms;
}

interface Read {
  reach: Reach;
  accounts: string[];
  limits: Limits[];
  only: boolean;
}

function readsOf(allows: readonly DraftAllow[], window: Window, category: (account: string) => Type | null, now_ms: number | null): Read[] {
  const grants = allows.map((allow): DraftAllow => ({ ...allow, window: window !== null && windowWithin(window, allow.window) ? null : allow.window }));
  const holds = (allow: DraftAllow, wider: DraftAllow) => reachWithin(allow.reach, wider.reach, category) && windowWithin(allow.window, wider.window) && endWithin(allow, wider, now_ms);
  const kept = grants.filter((allow, index) => !grants.some((other, at) => at !== index && holds(allow, other) && (!holds(other, allow) || at < index)));
  const reads = kept.map((allow): Read => ({ reach: allow.reach, accounts: [], limits: [{ window: allow.window, ...endOf(allow) }], only: false }));
  const gone = new Set<Read>();
  const alike = (a: Read, b: Read) => same(a.limits, b.limits);
  const live = (read: Read) => !gone.has(read);
  for (const all of reads) {
    for (const typed of reads) {
      const outer = all.reach;
      const inner = typed.reach;
      if (!live(all) || !live(typed) || !("all" in outer) || !("type" in inner) || !outer.but.includes(inner.type) || !alike(all, typed)) continue;
      all.reach = { all: true, but: outer.but.filter((type) => type !== inner.type) };
      all.accounts = [...all.accounts, ...inner.but];
      gone.add(typed);
    }
  }
  const wholeAccount = (read: Read, account: string) => "account" in read.reach && read.reach.account === account;
  for (const read of reads) {
    if (!live(read)) continue;
    for (const account of [...accountsOut(read)]) {
      const whole = reads.find((other) => other !== read && live(other) && wholeAccount(other, account) && alike(read, other));
      if (whole === undefined) continue;
      leaveIn(read, account);
      gone.add(whole);
    }
  }
  const within = (inner: Read, outer: Read) => windowWithin(inner.limits[0]!.window, outer.limits[0]!.window) && endWithin(inner.limits[0]!, outer.limits[0]!, now_ms) && !alike(inner, outer);
  const carved = new Map<Read, Read[]>();
  const taken = new Set<Read>();
  for (const read of reads) {
    if (!live(read) || taken.has(read)) continue;
    const reach = read.reach;
    const parts: { matches: (other: Read) => boolean; part: string }[] = [
      ...("all" in reach ? reach.but.map((type) => ({ matches: (other: Read) => "type" in other.reach && other.reach.type === type && other.reach.but.length === 0, part: type as string })) : []),
      ...accountsOut(read).map((account) => ({ matches: (other: Read) => wholeAccount(other, account), part: account })),
    ];
    for (const { matches, part } of parts) {
      const tighter = reads.find((other) => other !== read && live(other) && !taken.has(other) && !carved.has(other) && matches(other) && within(other, read));
      if (tighter === undefined) continue;
      leaveIn(read, part);
      tighter.only = true;
      taken.add(tighter);
      carved.set(read, [...carved.get(read) ?? [], tighter]);
    }
  }
  const said: Read[] = [];
  for (const read of reads.filter((each) => live(each) && !taken.has(each)).flatMap((each) => [each, ...carved.get(each) ?? []])) {
    const like = said.find((other) => other.only === read.only && same(other.reach, read.reach) && same(other.accounts, read.accounts));
    if (like === undefined) said.push({ ...read, limits: [...read.limits] });
    else like.limits.push(...read.limits);
  }
  return said;
}

function exceptionsOf(read: Read): string[] {
  const reach = read.reach;
  if ("all" in reach) return [...reach.but, ...read.accounts];
  return reach.but;
}

function accountsOut(read: Read): string[] {
  const reach = read.reach;
  if ("all" in reach) return read.accounts;
  return "type" in reach ? reach.but : [];
}

function leaveIn(read: Read, part: string): void {
  const reach = read.reach;
  if ("all" in reach) {
    read.reach = { all: true, but: reach.but.filter((type) => type !== part) };
    read.accounts = read.accounts.filter((account) => account !== part);
  } else if ("type" in reach) {
    read.reach = { type: reach.type, but: reach.but.filter((account) => account !== part) };
  }
}

function readReachWords(read: Read, words: Words): string {
  const reach = read.reach;
  if (!("all" in reach)) return reachWords(reach, words);
  const out = [...reach.but.map(typeName), ...read.accounts.map((account) => words.account(account))];
  return out.length === 0 ? "everything" : `everything but ${listed(out)}`;
}

export const READS_NOTHING = "Reads nothing";

export function summaryOf(access: DraftAccess | null, words: Words, at: SentenceAt = {}): string {
  const reading = access === null ? null : readingOf(access, at);
  if (access === null || reading === null) return READS_NOTHING;
  return [capital(readsWords(reading, words, at.now_ms ?? null)), ...reading.after.map((window) => windowWords(window, words.zone)), ...(at.chat === true ? [] : [hideShort(access.hide)])].join(" · ");
}

export function readsShort(access: DraftAccess, words: Words, at: SentenceAt = {}): string {
  const reading = readingOf(access, at);
  return reading === null ? READS_NOTHING : capital(readsWords(reading, words, at.now_ms ?? null));
}

export function seesOf(access: DraftAccess | null, name: string, words: Words, at: SentenceAt & { today?: true } = {}): Bolded {
  const reading = access === null ? null : readingOf(access, at);
  const head = at.today === true ? `Today ${name} sees ` : `${name} sees `;
  if (reading === null) return runs(head, at.today === true ? "nothing." : "nothing yet.");
  const names = [...new Set([...(Object.keys(TYPES) as Type[]).map(typeName), ...(at.accounts ?? []).map((each) => words.account(each.account))])]
    .filter((each) => each !== "").sort((a, b) => b.length - a.length);
  return runs(head, namesBold(readsPhrase(reading, words, at), names), ".");
}

function namesBold(text: string, names: readonly string[]): Bolded {
  if (names.length === 0) return runs(text);
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(${names.map((each) => each.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|")})(?![\\p{L}\\p{N}])`, "gu");
  const out: (string | Bolded)[] = [];
  let at = 0;
  for (const found of text.matchAll(pattern)) {
    out.push(text.slice(at, found.index), bold(found[0]));
    at = found.index + found[0].length;
  }
  out.push(text.slice(at));
  return runs(...out);
}

export function todayWords(access: DraftAccess | null, words: Words, at: SentenceAt = {}): string {
  const reading = access === null ? null : readingOf(access, at);
  return `Today it reads ${reading === null ? "nothing" : readsPhrase(reading, words, at)}.`;
}

export function hideSentence(level: Level): string {
  if (level === "names") return "Details hidden, names shown.";
  if (level === "all") return "Names and details hidden.";
  if (level === "none") return "Nothing hidden.";
  return "Some details hidden.";
}

export function hideChoiceWords(level: Level): string {
  if (level === "names") return "Details";
  if (level === "all") return "Names and details";
  if (level === "none") return "Nothing";
  return "Some details";
}

function hideShort(level: Level): string {
  if (level === "names") return "details hidden";
  if (level === "all") return "names and details hidden";
  if (level === "none") return "nothing hidden";
  return "some details hidden";
}

function hiddenWords(level: Level): string {
  if (level === "names") return "details";
  if (level === "all") return "names and details";
  if (level === "none") return "nothing";
  return "some details";
}

function reachWords(reach: Reach, words: Words): string {
  if ("all" in reach) return reach.but.length === 0 ? "everything" : `everything but ${listed(reach.but.map(typeName))}`;
  if ("type" in reach) return reach.but.length === 0 ? typeName(reach.type) : `${typeName(reach.type)} but ${listed(reach.but.map((account) => words.account(account)))}`;
  return words.account(reach.account);
}

function typeName(type: Type): string {
  return TYPES[type]?.name ?? type;
}

export function windowWords(window: Window, zone: string): string {
  if (window === null) return "all time";
  if ("since_ms" in window) return `since ${dateWords(window.since_ms, zone)}`;
  return `past ${window.past_ms === YEAR_MS ? "year" : spanWords(window.past_ms)}`;
}

function windowPhrase(window: Window, zone: string): string {
  if (window === null) return "";
  return "since_ms" in window ? ` ${windowWords(window, zone)}` : ` from the ${windowWords(window, zone)}`;
}

function windowKey(window: Window): string {
  return window === null ? "all" : "since_ms" in window ? `since ${window.since_ms}` : `past ${window.past_ms}`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const YEAR_MS = 365 * DAY_MS;

export function spanWords(ms: number): string {
  const count = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (ms >= 2 * DAY_MS && ms % DAY_MS === 0) return count(ms / DAY_MS, "day");
  if (ms % HOUR_MS === 0) return count(ms / HOUR_MS, "hour");
  return count(Math.max(1, Math.round(ms / MINUTE_MS)), "minute");
}

function dateWords(ms: number, zone: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: zone }).format(ms);
}

export function dayMonthWords(ms: number, zone: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: zone }).format(ms);
}

function timeWords(ms: number, zone: string): string {
  return instantWords(ms, zone).split(" ").at(-1)!;
}

function instantWords(ms: number, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: zone }).formatToParts(ms);
  const of = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${of("day")} ${of("month")} ${of("hour")}:${of("minute")}`;
}

export interface DayTally {
  day: string;
  start_ms: number;
  n: number;
}

export interface ReadDay {
  day: string;
  words: string;
  n: number;
}

export interface AgentReads {
  last_ms: number | null;
  last: string | null;
  line: string;
  short: string;
  today: number;
  total: number;
  since: string | null;
  days: ReadDay[];
}

export interface KindReads {
  n: number;
  words: string;
}

export const KIND_READS_DAYS = 30;

export function seeAllWords(total: number): string {
  return total === 0 ? "See all" : `See all ${readCount(total)}`;
}

export function dayWordsOf(day: string, today: string, yesterday: string, ms: number, zone: string): string {
  return day === today ? "Today" : day === yesterday ? "Yesterday" : dayMonthWords(ms, zone);
}

export function readCount(n: number): string {
  return `${n.toLocaleString("en-GB")} read${n === 1 ? "" : "s"}`;
}

export function calendarOf(zone: string): DaySettings {
  return { zone, day_start_hour: 0 };
}

export function agentReads(tally: { last_ms: number | null; total: number; first_ms: number | null; days: readonly DayTally[] }, zone: string): AgentReads {
  const today = tally.days.at(-1);
  const yesterday = tally.days.at(-2);
  const { last_ms } = tally;
  const day = last_ms === null ? null : civilDay(last_ms, calendarOf(zone));
  const last = last_ms === null ? null : day === today?.day ? timeWords(last_ms, zone) : day === yesterday?.day ? "Yesterday" : dayMonthWords(last_ms, zone);
  const n = today?.n ?? 0;
  const read = last === null ? null : `Read ${last === "Yesterday" ? "yesterday" : last}`;
  return {
    last_ms, last,
    line: read === null ? HASNT_READ : `${read}${n === 0 ? "" : ` · ${readCount(n)} today`}`,
    short: read === null ? HASNT_READ : `${read}${n === 0 ? "" : ` · ${n.toLocaleString("en-GB")} today`}`,
    today: n, total: tally.total,
    since: tally.first_ms === null || tally.total === 0 ? null : `${readCount(tally.total)} since ${dayMonthWords(tally.first_ms, zone)}`,
    days: tally.days.map((each) => ({ day: each.day, words: new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: zone }).format(each.start_ms), n: each.n })),
  };
}

export const HASNT_READ = "Hasn’t read yet";

export function kindReads(n: number): KindReads {
  return { n, words: n === 0 ? `No reads in ${KIND_READS_DAYS} days` : `${readCount(n)} in ${KIND_READS_DAYS} days` };
}

export function listed(items: readonly string[], joiner = "and"): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${joiner} ${items.at(-1)}`;
}

export function capital(text: string): string {
  return text === "" ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`;
}



export function agentLines(access: Access, words: Words, now_ms: number): string[] {
  return numbered(access).map(({ number, member, index }) => {
    if (member === "hide") return `${number}. ${hideShort(access.hide)}`;
    if (member === "window") return `${number}. ${capital(windowWords(access.window, words.zone))} on everything`;
    const allow = access.allow[index]!;
    const end = allow.until_ms === null ? "" : now_ms >= allow.until_ms ? ` · ended ${instantWords(allow.until_ms, words.zone)}` : ` · until ${instantWords(allow.until_ms, words.zone)}`;
    return `${number}. ${capital(reachWords(allow.reach, words))} · ${windowWords(allow.window, words.zone)}${end}`;
  });
}

export function agentText(lines: readonly string[], outside: readonly string[], nothing: boolean, request: string | null = null): string {
  return [
    "Your access to this Lifestream:",
    ...(nothing ? ["Nothing yet: ask for it with `access`."] : []),
    ...lines,
    ...(outside.length === 0 ? [] : [`Also in this Lifestream, outside your access: ${outside.join(", ")}.`]),
    ...(request === null ? [] : [request]),
    "Ask for more, or drop a line, with `access`.",
  ].join("\n");
}

export const ASKED = "Asked. Your person will see it on their Mac or iPhone. Call `access` to see their answer.";
export const ALREADY = "Your access already allows this: nothing was asked.";
export const DECLINED_TWICE = "Declined twice. Your person can change your access in Lifestream.";
export const NOTHING_OPEN = "You have no open request to drop.";
export const OWN_CHANGED = "Your access changed since you read it: call `access` again, and drop by the numbers and version it gives.";
export const DROP_VERSION = "dropping a line names the version you read: drop and version, as `access` gave them";

export function heldWords(declined_ms: number, until_ms: number | null, zone: string): string {
  if (until_ms === null) return DECLINED_TWICE;
  return `Declined on ${instantWords(declined_ms, zone).split(" ").slice(0, 2).join(" ")}. You can ask again after ${instantWords(until_ms, zone)}.`;
}

export function requestWords(state: RequestState, wants: string): string {
  const request = `Your request (${wants})`;
  switch (state) {
    case "open": return `${request} waits for your person's answer.`;
    case "allowed": return `${request} was allowed.`;
    case "declined": return `${request} was declined.`;
    case "lapsed": return `${request} lapsed with no answer.`;
    case "dropped": return `${request} was dropped.`;
    case "replaced": return `${request} was replaced by a newer one.`;
  }
}

export function droppedWords(drop: number | "everything" | "request"): string {
  if (drop === "request") return "Dropped your request.";
  if (drop === "everything") return "Dropped everything you read.";
  return `Dropped line ${drop}.`;
}

export function undroppableWords(line: number, member: string | null, count: number): string {
  if (member === "window") return `Line ${line} limits the time you read: dropping it would widen your access. Drop a line that allows a read.`;
  if (member === "hide") return `Line ${line} says what stays hidden: dropping it would widen your access. Drop a line that allows a read.`;
  return `Your access has no line ${line}: its lines are 1 to ${count}.`;
}

export const SCREEN = "Screen shows almost everything you did.";

export function limitWords(grants: readonly Limits[], zone: string): string {
  const ended = (end: End) => !("until_ms" in end) || end.until_ms !== null;
  const phrases = [...new Set([...grants].sort((a, b) => Number(ended(endOf(a))) - Number(ended(endOf(b)))).map((grant) => {
    const end = endOf(grant);
    const until = "lasts_ms" in end ? ` for ${spanWords(end.lasts_ms)}` : end.until_ms === null ? "" : ` until ${instantWords(end.until_ms, zone)}`;
    return `${windowWords(grant.window, zone)}${until}`;
  }))];
  if (phrases.length <= 1) return capital(phrases[0] ?? windowWords(null, zone));
  return `${capital(phrases[0]!)} for most, ${listed(phrases.slice(1))} for some`;
}

export type ReadWant = "everything" | { category: Type } | { product: string } | { account: string };
export type AskWant = { read: ReadWant; window: Window };
export type AskAnswer = "once" | "always" | "no";

export function onceOf(lasts: number | null): number {
  return lasts ?? HOUR_MS;
}

export function wantsOf(want: AskWant, for_ms: number | null, words: Words): string {
  const time = for_ms === null ? "" : ` for ${spanWords(for_ms)}`;
  return `${readWords(want.read, words)}${windowPhrase(want.window, words.zone)}${time}`;
}

export function headOf(name: string, wants: string): string {
  return `${name} asks to see ${wants}`;
}

export function askLine(wants: string): string {
  return `asks to see ${wants}`;
}

export type ClockPart = { kind: "words"; words: string } | { kind: "time"; time: { kind: "clock"; at_ms: number } };
export type ClockPhrase = ClockPart[];

const wordsPart = (words: string): ClockPart => ({ kind: "words", words });
const clockAt = (at_ms: number): ClockPart => ({ kind: "time", time: { kind: "clock", at_ms } });

export function phraseText(phrase: ClockPhrase, now_ms: number, zone: string): string {
  return phrase.map((part) => (part.kind === "words" ? part.words : dayWords(part.time.at_ms, now_ms, zone))).join(" ");
}

export function askedLine(at_ms: number, until_ms: number): ClockPhrase {
  return [wordsPart("Asked"), clockAt(at_ms), wordsPart("· the ask ends"), clockAt(until_ms)];
}

export function underLine(reason: string | null, at_ms: number): ClockPhrase {
  return [wordsPart(reason === null || reason === "" ? "Asked" : `“${reason}” · asked`), clockAt(at_ms)];
}

export function saysTitle(name: string): string {
  return `${name} says`;
}

export function chatHeadOf(name: string, difference: Difference, words: Words): string {
  const { reads, window, hide } = difference;
  const sources = reads.length > 0 && window === undefined && hide === null;
  return sources ? `Let ${name} also read ${listed(reads.map((piece) => pieceWords(piece, words)))}?` : `Let ${name} read more?`;
}

export function chatLine(adds: readonly string[]): string {
  return `Chat proposes ${adds.length === 0 ? "more" : listed(adds)}`;
}

export const CHAT_ERASED = "What this asked for was erased.";

export function erasedHead(name: string): string {
  return `What ${name} asked for was erased.`;
}

export function unchangedWords(name: string): string {
  return `${name} already reads this.`;
}

export function narrowedWords(name: string, before: Access | null, after: Access, words: Words, at: SentenceAt = {}): Bolded {
  const reading = readingOf(after, at);
  if (reading === null) return runs(`Saved. ${name} now sees nothing.`);
  const was = before ?? NOTHING;
  const accounts = at.accounts ?? [];
  const gone = differenceOf(after, was, accounts);
  const reads = !same(was.allow, after.allow);
  const whole = gone.reads.length > 0 && gone.reads.length <= GONE_MOST
    && same(differenceOf(timeless(after), timeless(was), accounts).reads, timeless({ ...NOTHING, allow: gone.reads }).allow);
  const parts: Bolded[] = [];
  if (reads && whole) parts.push(runs("no longer sees ", boldListed(gone.reads.map((piece) => seenPiece(piece, words)))));
  else if (reads) parts.push(runs("now sees only ", bold(readsPhrase(reading, words, at).trim())));
  else if (windowKey(was.window) !== windowKey(after.window) && after.window !== null) {
    parts.push("since_ms" in after.window ? runs("now sees only ", bold(windowWords(after.window, words.zone))) : runs("now sees the ", bold(windowWords(after.window, words.zone))));
  }
  if (!same(was.hide, after.hide)) parts.push(runs("now hides ", bold(hiddenWords(after.hide))));
  if (parts.length === 0) return runs(`Saved. ${name} sees as before.`);
  return runs(`Saved. ${name} `, ...parts.flatMap((part, index) => [index === 0 ? "" : index === parts.length - 1 ? " and " : ", ", part]), ".");
}

const GONE_MOST = 3;

function timeless(access: Access): Access {
  return { ...access, allow: access.allow.map((allow) => ({ ...allow, window: null, until_ms: null })) };
}

export function widenedWords(name: string, difference: Difference, words: Words): Bolded {
  const { reads, window, hide } = difference;
  const until = " Nothing changes until you allow it.";
  if (reads.length > 0 && window === undefined && hide === null) return runs(`${name} would also see `, boldListed(reads.map((piece) => bold(pieceWords(piece, words)))), `.${until}`);
  return runs(`${name} would see more.${until}`);
}

export function underOf(want: AskWant, words: Words, accounts: readonly HomeAccount[]): string | null {
  const read = want.read;
  if (read === "everything" || "category" in read) return null;
  if ("product" in read) {
    const named = accounts.filter((each) => each.account.split(":")[0] === read.product).map((each) => words.address(each.account) ?? words.account(each.account));
    return named.length === 0 ? null : listed(named);
  }
  return words.address(read.account);
}

export interface Difference {
  reads: Allow[];
  window: Window | undefined;
  hide: Level | null;
}

export function differenceOf(before: Access | null, after: Access, accounts: readonly HomeAccount[]): Difference {
  const was = before ?? NOTHING;
  const category = categoryOf(accounts);
  return {
    reads: after.allow.flatMap((allow) => newOf(allow, was.allow, accounts, category)),
    window: windowWithin(after.window, was.window) ? undefined : after.window,
    hide: hiddenWithin(was.hide, after.hide) ? null : after.hide,
  };
}

export function addsOf(difference: Difference, words: Words): string[] {
  const { reads, window, hide } = difference;
  return [
    ...reads.map((piece) => capital(pieceWords(piece, words))),
    ...(window === undefined ? [] : [capital(windowWords(window, words.zone))]),
    ...(hide === null ? [] : [hideSentence(hide).slice(0, -1)]),
  ];
}

export function keepsOf(difference: Difference, after: Access): string | null {
  if (difference.hide !== null) return null;
  const hidden = (level: Level) => DETAIL_TYPES.filter((type) => hides(level, type)).join();
  const now = hidden(after.hide);
  if (now === "") return null;
  if (now === hidden("names")) return "Details stay hidden.";
  if (now === hidden("all")) return "Names and details stay hidden.";
  return "Some details stay hidden.";
}

export function choicesOf(by: "agent" | "chat", for_ms: number | null, erased = false): { answer: AskAnswer; words: string }[] {
  if (erased) return [{ answer: "no", words: DONT_ALLOW }];
  if (by === "chat") return [{ answer: "always", words: "Allow" }, { answer: "no", words: DONT_ALLOW }];
  return [{ answer: "once", words: `Allow for ${spanWords(onceOf(for_ms))}` }, { answer: "always", words: "Always allow" }, { answer: "no", words: DONT_ALLOW }];
}

export function defaultOf(by: "agent" | "chat", for_ms: number | null, erased = false): AskAnswer {
  if (erased) return "no";
  return by === "chat" || for_ms === null ? "always" : "once";
}

const DONT_ALLOW = "Don’t allow";

export interface Outcome {
  state: RequestState | SignInAnswer["state"];
  answered_ms: number | null;
  device: string | null;
  name: string;
  until_ms?: number | null;
  by?: RequestBy;
}

export function outcomeOf({ state, answered_ms, device, name, until_ms = null, by }: Outcome, now_ms: number): ClockPhrase | null {
  if (state === "open") return null;
  if (state === "replaced") return [wordsPart(by === "chat" ? `${name}’s access changed since. Ask Chat again.` : `${name} asked again.`)];
  if (state === "declined" || state === "denied") return answeredWords("Not allowed", answered_ms, device);
  if (state === "wrong") return [wordsPart(`Wrong code, so ${name} wasn’t let in. Start the sign-in again in ${name}.`)];
  if (state !== "allowed" && state !== "approved") return [wordsPart(REQUEST_OVER)];
  if (until_ms !== null) return [wordsPart(until_ms > now_ms ? "Allowed until" : "Allowed, ended"), clockAt(until_ms)];
  return answeredWords("Allowed", answered_ms, device);
}

function answeredWords(answer: string, answered_ms: number | null, device: string | null): ClockPhrase {
  const words = `${answer}${device === null ? "" : ` on ${device}`}`;
  return answered_ms === null ? [wordsPart(words)] : [wordsPart(`${words},`), clockAt(answered_ms)];
}


export function signInHead(name: string): string {
  return `${name} wants to read your Lifestream`;
}

export function signInNotice(name: string): string {
  return `${signInHead(name)}. Type the code it shows.`;
}

export function signInOver(name: string | null): string {
  return `This sign-in is over. Start it again in ${name ?? "the app"}.`;
}

export const SIGNING_IN_HERE = "an app on the computer you are signing in from";

export function signInSays(name: string, checked: boolean, host: string | null): string {
  const to = host === null ? SIGNING_IN_HERE : checked ? `from ${host}` : `sending access to ${host}`;
  return checked ? to : `says it is ${name}, ${to}`;
}

export function signingInLine(from: string | null, at_ms: number, calm: string | null = null): ClockPhrase {
  if (calm !== null) return [wordsPart(calm)];
  return [wordsPart(`Signing in${from === null ? "" : ` from ${from}`} ·`), clockAt(at_ms)];
}

export function pickWords(name: string): string {
  return `Type the code ${name} shows`;
}

export function pickLine(name: string): string {
  return `The code is the yes. A wrong one turns ${name} away.`;
}

export function connectedLine(access: DraftAccess | null, words: Words, at: SentenceAt = {}): string {
  const reading = access === null ? null : readingOf(access, at);
  return `It sees ${reading === null ? "nothing yet" : readsPhrase(reading, words, at)}. Change it any time in Agents.`;
}

export interface AddressAct { label: string; to: "web" | "tailscale" | "turn-on"; url: string | null }
export type Address =
  | { state: "on"; url: string; line: string }
  | { state: "off"; url: string | null }
  | { state: "fix"; url: null; words: string; act: AddressAct | null };

export const ADDRESS_ON = "Lifestream’s agent address is now on the internet. Only agents you say yes to can read.";
export const ADDRESS_NOT_READY = "Lifestream’s agent address isn’t on the internet yet. Turn it on, then make the key.";
const TAILSCALE_SILENT = "Tailscale did not answer. Open Tailscale on your Mac.";

export function addressOf(state: PublicState, phone: boolean): Address {
  const url = state.origin === null ? null : `${state.origin}/mcp`;
  if (state.state === "on" && url !== null) return { state: "on", url, line: ADDRESS_ON };
  const trouble = troubleOf(state);
  if (trouble === null) return { state: "off", url };
  const fix = (words: string, act: AddressAct | null = null): Address => ({ state: "fix", url: null, words, act: phone ? null : act });
  const opened = (label: string): AddressAct | null => (state.open === null ? null : { label, to: "web", url: state.open });
  if (trouble === "no-tailscale") return phone ? fix("Needs Tailscale on your Mac.") : fix("Your address needs Tailscale on this Mac.", opened("Get Tailscale"));
  if (trouble === "signed-out") return phone ? fix("Sign in to Tailscale on your Mac.") : fix("Sign in to Tailscale to get your address.", opened("Sign in") ?? { label: "Sign in", to: "tailscale", url: null });
  if (trouble === "not-running") return phone ? fix("Open Tailscale on your Mac.") : fix("Open Tailscale to get your address.", { label: "Open Tailscale", to: "tailscale", url: null });
  if (trouble === "no-funnel") {
    return { state: "fix", url: null, words: "Allow Funnel in Tailscale to put your address on the internet.", act: opened("Allow Funnel") ?? { label: "Allow Funnel", to: "turn-on", url: null } };
  }
  if (trouble === "taken") return fix(`${TAKEN}.`);
  if (trouble === "funnel-on") return fix(`${FUNNEL_ON}.`);
  return fix(TAILSCALE_SILENT);
}

export const ANYWHERE_KEY_ONLY = "A sign-in reads from the internet already: only a key is turned on for it.";

export function keyOnMac(name: string): string {
  return `${name} runs on your Mac. Make its key in Lifestream there.`;
}

export const KEY_ROWS = {
  name: "Name", url: "Server URL", header: "Header name", value: "Header value", address: "Address", key: "Key", code: "Claude Code", internet: "From the internet",
} as const;

export const NOT_STARTED = "Update Lifestream on your Mac to connect agents.";
export const PERSON_ONLY_WORDS = "Allow this in Lifestream on your Mac or iPhone.";
export const ACCESS_CHANGED_WORDS = "This access just changed. Look again, then save.";
export const REQUEST_OVER = "This request is over.";
export const CHAT_HIDES = "Each conversation hides what you pick in it.";
export const AGENT_GONE = "This agent was disconnected.";
export const CHAT_NOT_DISCONNECTED = "Chat is Lifestream’s own: it is not disconnected.";
export const CHAT_LISTED = "Chat is Lifestream’s own: it stays on the list.";
export const ACCESS_UNSAVED = "Couldn’t save this access. Try again.";

export function disconnectedWords(ms: number, zone: string): string {
  return `Disconnected ${dayMonthWords(ms, zone)}`;
}

export function stillConnected(name: string): string {
  return `Disconnect ${name} first.`;
}

export interface Ended {
  icon: string;
  name: string;
  line: string;
}

export interface Disconnecting {
  head: string;
  line: string;
  stops: Ended[];
  stays: Ended[];
  confirm: string;
}

export interface Unlisting {
  ask: string;
  line: string;
}

export function unlistingOf(name: string): Unlisting {
  return { ask: `Remove ${name} from the list?`, line: "Its history stays in Lifestream." };
}

export type Entry = { via: "pass"; made_ms: number | null } | { via: "sign-in"; from: string | null };

export function disconnectingOf(name: string, entry: Entry, ask: string | null, total: number, zone: string): Disconnecting {
  const way: Ended = entry.via === "pass"
    ? { icon: "link", name: "Its key", line: entry.made_ms === null ? "The key stops working" : `The key made ${dayMonthWords(entry.made_ms, zone)} stops working` }
    : { icon: "link", name: "Its sign-in", line: entry.from === null ? "The sign-in stops working" : `The sign-in from ${entry.from} stops working` };
  return {
    head: `Disconnect ${name}?`,
    line: `${name} stops reading at once. Nothing in Lifestream is deleted.`,
    stops: [
      { icon: "streams", name: "Its reads", line: `From now on ${name} can’t see your Lifestream` },
      way,
      ...(ask === null ? [] : [{ icon: "needs-you", name: `Its ask for ${ask}`, line: "Turned down" }]),
    ],
    stays: [
      { icon: "time", name: "Its history here", line: total === 0 ? "Nothing read yet" : `${readCount(total)}, to look back on` },
      { icon: "ai-apps", name: `What ${name} already read`, line: `That stays with ${name}. Ask its maker to delete it.` },
    ],
    confirm: `Disconnect ${name}`,
  };
}


export type Bolded = { text: string; bold?: true }[];

export function plainOf(bolded: Bolded): string {
  return bolded.map((run) => run.text).join("");
}

function runs(...parts: (string | Bolded)[]): Bolded {
  const out: Bolded = [];
  for (const run of parts.flatMap((part): Bolded => (typeof part === "string" ? [{ text: part }] : part))) {
    if (run.text === "") continue;
    const last = out.at(-1);
    if (last !== undefined && last.bold === run.bold) last.text += run.text;
    else out.push(run.bold === true ? { text: run.text, bold: true } : { text: run.text });
  }
  return out;
}

function bold(text: string): Bolded {
  return [{ text, bold: true }];
}

function boldListed(items: readonly Bolded[], joiner = "and"): Bolded {
  return runs(...items.flatMap((item, index) => [index === 0 ? "" : index === items.length - 1 ? ` ${joiner} ` : ", ", item]));
}


export interface Noun {
  one: string;
  many: string;
}

export type Countable = Type | "line" | "person" | "record";

function noun(one: string, many = `${one}s`): Noun {
  return { one, many };
}

export const NOUNS: Readonly<Record<Countable, Noun>> = {
  messages: noun("message"),
  mail: noun("email"),
  calls: noun("call"),
  voice: noun("voice note"),
  plans: noun("event"),
  health: noun("health reading"),
  places: noun("place"),
  photos: noun("photo"),
  "device-activity": noun("moment on screen", "moments on screen"),
  web: noun("page"),
  ai: noun("AI chat"),
  notes: noun("note"),
  listening: noun("track"),
  watching: noun("show"),
  money: noun("transaction"),
  social: noun("post"),
  code: noun("coding session"),
  "check-ins": noun("check-in"),
  contacts: noun("contact"),
  line: noun("line of your day", "lines of your day"),
  person: noun("person", "people"),
  record: noun("thing"),
};

const THINGS = NOUNS.record;
const DETAILS = noun("detail");
const TIMES_DONE = noun("time");

export function counted(n: number, of: Noun): string {
  return `${n.toLocaleString("en-GB")} ${n === 1 ? of.one : of.many}`;
}

function nounOf(kind: string): Noun {
  return Object.hasOwn(NOUNS, kind) ? NOUNS[kind as Countable] : THINGS;
}

export const DETAIL_NOUNS: Readonly<Record<BaseType, string>> = {
  person: "Names",
  account: "Account names",
  email: "Email addresses",
  phone: "Phone numbers",
  address: "Addresses",
  place: "Places",
  number: "Account numbers",
  secret: "Passwords and codes",
  link: "Links",
  word: "Words you hid",
  ref: "References",
  face: "Faces",
};

const NAME_TYPES: ReadonlySet<BaseType> = new Set(["person", "account", "face"]);
export const AS_A_PERSON = "Shown as “a person”";

export interface KeptRow {
  type: DetailType | "names";
  name: string;
  value: string;
}

function keptBy(counts: Counts): [BaseType, number][] {
  const by = new Map<BaseType, number>();
  for (const [type, n] of Object.entries(counts) as [DetailType, number | undefined][]) {
    if (n !== undefined && n > 0) by.set(baseOf(type), (by.get(baseOf(type)) ?? 0) + n);
  }
  const order = (type: BaseType) => DETAIL_TYPES.indexOf(type);
  return [...by].sort((a, b) => Number(b[0] === "person") - Number(a[0] === "person") || b[1] - a[1] || order(a[0]) - order(b[0]));
}

export function keptLine(counts: Counts): string | null {
  const by = keptBy(counts);
  const details = by.filter(([type]) => !NAME_TYPES.has(type)).reduce((sum, [, n]) => sum + n, 0);
  if (details > 0) return `${counted(details, DETAILS)} kept from it`;
  const names = by.reduce((sum, [, n]) => sum + n, 0);
  if (names === 0) return null;
  return `${names === 1 ? "name" : "names"} kept from it`;
}

export function keptRows(counts: Counts): KeptRow[] {
  return keptBy(counts).map(([type, n]): KeptRow => (type === "person"
    ? { type: "names", name: DETAIL_NOUNS.person, value: AS_A_PERSON }
    : { type, name: DETAIL_NOUNS[type], value: n.toLocaleString("en-GB") }));
}

export function keptAbout(name: string): string {
  return `${name} got these back as blanks.`;
}

export function unshownWords(withheld: readonly Withheld[], access: Access | null, words: Words): string | null {
  const n = withheld.reduce((sum, each) => sum + each.n, 0);
  return n === 0 ? null : `${n.toLocaleString("en-GB")} more matched but weren’t shown: ${listed([...new Set(withheld.map((each) => withheldWords(each.line, access, words)))])}`;
}

export function itemsKeptWords(kept: number): string {
  return `The first ${kept.toLocaleString("en-GB")} are kept.`;
}


export interface CameKind {
  kind: string;
  name: string;
  icon: string;
  n: number;
  words: string;
}

export type KindNamed = Omit<CameKind, "n" | "words">;

const KINDS: Readonly<Record<string, { name: string; icon: string }>> = {
  line: { name: "Day lines", icon: "days" },
  person: { name: "People", icon: "person" },
  record: { name: "Other", icon: "more" },
};

export function kindNamed(kind: string): KindNamed {
  const known = KINDS[kind] ?? (Object.hasOwn(TYPES, kind) ? TYPES[kind as Type] : KINDS.record!);
  return { kind, name: known.name, icon: known.icon };
}

export function cameKinds(came: Came): CameKind[] {
  return Object.entries(came).filter(([, n]) => n > 0)
    .map(([kind, n]) => ({ ...kindNamed(kind), n, words: counted(n, nounOf(kind)) }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}

function total(kinds: readonly CameKind[]): number {
  return kinds.reduce((sum, each) => sum + each.n, 0);
}

export const NOTHING_FOUND = "Nothing found";
const KINDS_SHOWN = 3;

export function thingsWords(kinds: readonly CameKind[]): string {
  const n = total(kinds);
  if (n === 0) return NOTHING_FOUND;
  if (kinds.length === 1) return kinds[0]!.words;
  return `${counted(n, THINGS)}: ${kinds.slice(0, KINDS_SHOWN).map((kind) => kind.words).join(", ")}`;
}

export function numberWords(n: number | null): string {
  return n === null ? "Only a number came back" : `Only a number came back: ${n.toLocaleString("en-GB")}`;
}

const YOURS: Readonly<Record<string, string>> = { mail: "email", ai: "AI chats", line: "days", person: "people", record: "other things" };

function yoursOf(kind: string): string {
  return YOURS[kind] ?? (Object.hasOwn(TYPES, kind) ? TYPES[kind as Type].name.toLowerCase() : YOURS.record!);
}


export const NOT_READY = "Lifestream wasn’t ready";
export const STOPPED = "Stopped";
export const ASKED_TOO_MUCH = "Stopped: it asked for too much at once";
const OUTSIDE_CODES: ReadonlySet<string> = new Set(["OUTSIDE_ACCESS", "WITHHELD"]);
const TOO_MUCH_CODES: ReadonlySet<string> = new Set(["TOO_BROAD"]);

export function refusedWords(call: Pick<CallSeen, "code" | "sent" | "read">, name: string, words: Words): string {
  const { code } = call;
  if (code !== null && NOT_YET.has(code)) return NOT_READY;
  if (code !== null && TOO_MUCH_CODES.has(code)) return ASKED_TOO_MUCH;
  if (code === null || !OUTSIDE_CODES.has(code)) return STOPPED;
  const named = namedIn(questionOf(call.sent, call.read), words);
  return named.length === 0 ? `Stopped: outside what ${name} can see` : `Stopped: ${name} can’t see ${listed(named, "or")}`;
}

function namedIn(said: Record<string, Json>, words: Words): string[] {
  const texts = (value: Json | undefined) => (Array.isArray(value) ? value : []).filter((each): each is string => typeof each === "string");
  const typeOf = (family: string) => (Object.keys(TYPES) as Type[]).find((type) => type === family || TYPES[type].name.toLowerCase() === family);
  const types = texts(said.families).map(typeOf).filter((type): type is Type => type !== undefined).map(typeName);
  return [...new Set([...types, ...texts(said.products).map((product) => words.product(product))])];
}

function unready(call: Pick<CallSeen, "result" | "code">): boolean {
  return (call.result === "refused" || call.result === "failed") && call.code !== null && NOT_YET.has(call.code);
}


export interface CallSeen {
  tool: string;
  sent: Json;
  read: Json;
  result: ReaderCallResult;
  code: string | null;
  words: string | null;
  came: Came | null;
  counts: Counts;
  withheld: readonly Withheld[];
}

export type Tone = "plain" | "refused";

export interface CallShown {
  words: string;
  line: string | null;
  kept: string | null;
  tone: Tone;
  icon: string;
  opens: boolean;
}

const UNOPENED: ReadonlySet<string> = new Set(["count", ...NOT_READS]);

export function callLine(call: CallSeen, access: Access | null, name: string, words: Words): CallShown {
  const act = actFor(call, access, words);
  const shown = { words: `${act.past}${act.tail}`, kept: keptLine(call.counts), tone: "plain" as Tone, icon: act.icon, opens: !UNOPENED.has(call.tool) };
  if (call.result === "running") return { ...shown, line: "Didn’t finish" };
  if (unready(call)) return { ...shown, line: NOT_READY };
  if (call.result === "refused") return { ...shown, words: `Tried to ${act.to}${act.tail}`, line: refusedWords(call, name, words), tone: "refused", icon: "close" };
  if (call.result === "failed") return { ...shown, line: "Failed" };
  return { ...shown, line: cameLine(call) };
}

function countedIn(words: string | null): number | null {
  return words !== null && /^\d+$/u.test(words) ? Number(words) : null;
}

function cameLine(call: CallSeen): string | null {
  if ((NOT_READS as readonly string[]).includes(call.tool) || call.came === null) return null;
  const kinds = cameKinds(call.came);
  if (kinds.length === 0 && call.tool === "count") return questionOf(call.sent, call.read).of === undefined ? null : numberWords(countedIn(call.words));
  return thingsWords(kinds);
}

export interface Repeated {
  at_ms: number;
  tool: string;
  sent: Json;
  read: Json;
  came: Came | null;
}

export interface RepeatShown {
  words: string;
  line: string;
  icon: string;
}

const HOURLY_MS = { least: 50 * 60_000, most: 70 * 60_000 } as const;

export function repeatWords(reads: readonly Repeated[], words: Words): RepeatShown {
  const sorted = [...reads].sort((a, b) => a.at_ms - b.at_ms);
  const first = sorted[0]!;
  const last = sorted.at(-1)!;
  const act = actOf(first.tool, first.sent, first.read, words);
  const gaps = sorted.slice(1).map((each, index) => each.at_ms - sorted[index]!.at_ms);
  const hourly = gaps.length > 0 && gaps.every((gap) => gap >= HOURLY_MS.least && gap <= HOURLY_MS.most);
  const each = sorted.map((read) => total(cameKinds(read.came ?? {})));
  const most = Math.max(...each);
  const totals: Came = {};
  for (const read of sorted) for (const [kind, n] of Object.entries(read.came ?? {})) totals[kind] = (totals[kind] ?? 0) + n;
  const kinds = cameKinds(totals).slice(0, KINDS_SHOWN).map((kind) => nounOf(kind.kind).many);
  const things = most === 0 ? NOTHING_FOUND : `${each.every((n) => n === most) ? "" : "up to "}${counted(most, THINGS)} each${kinds.length === 0 ? "" : `: ${kinds.join(", ")}`}`;
  return {
    words: hourly ? `${act.past}, every hour` : act.past,
    line: `${counted(sorted.length, TIMES_DONE)}, ${timeSpan(first.at_ms, last.at_ms, words.zone)} · ${things}`,
    icon: "sync",
  };
}

function timeSpan(from_ms: number, to_ms: number, zone: string): string {
  const calendar = calendarOf(zone);
  const sameDay = civilDay(from_ms, calendar) === civilDay(to_ms, calendar);
  const from = timeWords(from_ms, zone);
  const to = sameDay ? timeWords(to_ms, zone) : instantWords(to_ms, zone);
  return from === to ? from : `${sameDay ? from : instantWords(from_ms, zone)} – ${to}`;
}

function relativeDay(ms: number, now_ms: number, zone: string): string {
  const calendar = calendarOf(zone);
  const day = civilDay(ms, calendar);
  const today = civilDay(now_ms, calendar);
  return day === today ? "today" : day === addDays(today, -1) ? "yesterday" : dayMonthWords(ms, zone);
}

function asked(more: number): string {
  if (more === 0) return "";
  return ` · asked for more ${more === 1 ? "once" : `${more.toLocaleString("en-GB")} times`}`;
}


export function readLine(from_ms: number, to_ms: number, more: number, now_ms: number, zone: string): string {
  return `${capital(relativeDay(from_ms, now_ms, zone))}, ${timeSpan(from_ms, to_ms, zone)}${asked(more)}`;
}

export function sawOf(n: number): { n: number; words: string } {
  return { n, words: n === 1 ? "thing it saw" : "things it saw" };
}

export function showOf(n: number): { words: string; n: number } | null {
  return n === 0 ? null : { words: `Show the ${counted(n, THINGS)}`, n };
}

export function thingWhen(ms: number, zone: string): string {
  return `${dayMonthWords(ms, zone)}, ${timeWords(ms, zone)}`;
}

export function thingsTitle(n: number): string {
  return `The ${counted(n, THINGS)}`;
}

export function goneWords(n: number): string | null {
  return n === 0 ? null : `${n.toLocaleString("en-GB")} of them ${n === 1 ? "is" : "are"} no longer in Lifestream.`;
}

export function whyOf(access: Access | null, name: string, words: Words, at: SentenceAt & { at_ms: number }): Bolded | null {
  if (access === null) return null;
  const now_ms = at.now_ms ?? at.at_ms;
  const time = timeWords(at.at_ms, words.zone);
  const when = relativeDay(at.at_ms, now_ms, words.zone) === "today" ? time : `${time} on ${dayMonthWords(at.at_ms, words.zone)}`;
  const reading = readingOf(access, { ...at, now_ms: at.at_ms });
  if (reading === null) return runs(`At ${when} ${name} could see nothing.`);
  const windows = reading.after.map((window): Bolded => (window !== null && "since_ms" in window
    ? runs(", ", bold(windowWords(window, words.zone)))
    : runs(", from the ", bold(windowWords(window, words.zone)))));
  return runs(
    `At ${when} ${name} could see `, bold(readsWords(reading, words, at.at_ms)), ...windows,
    at.chat === true ? "." : `, with ${hiddenWords(access.hide)} hidden.`,
  );
}


export interface ReadsFigure {
  today: number;
  words: string;
  days: ReadDay[];
  said: Bolded;
}

export function figureOf(reads: AgentReads, said: Bolded): ReadsFigure {
  return { today: reads.today, words: reads.today === 1 ? "read today" : "reads today", days: reads.days, said };
}

const SHUT_NAMED = 2;

export function saidOf(name: string, today: Came, shut: readonly Type[]): Bolded {
  const kinds = cameKinds(today);
  const all = total(kinds);
  const [top, second] = kinds;
  const mostly = top === undefined ? [] : second === undefined || top.n * 2 > all
    ? [runs("Mostly your ", bold(yoursOf(top.kind)), ".")]
    : [runs("Mostly your ", bold(yoursOf(top.kind)), " and ", bold(yoursOf(second.kind)), ".")];
  const named = shut.slice(0, SHUT_NAMED).map((type) => bold(typeName(type)));
  const nothing = shut.length === 0 ? [] : [runs(
    "Nothing from ", boldListed(named, "or"), shut.length > SHUT_NAMED ? `, and ${shut.length - SHUT_NAMED} more` : "",
    `: ${name} can’t see ${shut.length === 1 ? "it" : "them"}.`,
  )];
  return runs(...[...mostly, ...nothing].flatMap((part, index) => [index === 0 ? "" : " ", part]));
}

export function quietOf(last: { at_ms: number; words: string }, now_ms: number, zone: string): Bolded {
  const verb = last.words === "" ? last.words : `${last.words[0]!.toLowerCase()}${last.words.slice(1)}`;
  return runs("Last read ", bold(`${relativeDay(last.at_ms, now_ms, zone)} ${timeWords(last.at_ms, zone)}`), `: it ${verb}.`);
}

export function neverReadOf(name: string, connected_ms: number, now_ms: number, zone: string): { title: string; line: string } {
  const day = relativeDay(connected_ms, now_ms, zone);
  return {
    title: `${name} hasn’t read anything yet`,
    line: `Connected ${day === "today" || day === "yesterday" ? day : `on ${day}`}. When it reads, each read shows here: what it searched for, what it saw, and what was kept from it.`,
  };
}

export const SHOW_EARLIER = "Show earlier";

export function amountOf(reads: AgentReads, disconnected_ms: number | null, zone: string): string {
  if (disconnected_ms !== null) return `${disconnectedWords(disconnected_ms, zone)} · its history stays`;
  if (reads.today > 0) return `${readCount(reads.today)} today`;
  if (reads.last === null) return HASNT_READ;
  return `Last read ${reads.last === "Yesterday" ? "yesterday" : reads.last}`;
}

export interface Placed {
  kind: "chat" | "agent";
  via: "sign-in" | "pass" | null;
  from: string | null;
}

export function placeOf(reader: Placed): string {
  if (reader.kind === "chat" || reader.via === null) return "Lifestream";
  if (reader.via === "pass") return "Key";
  return reader.from ?? "Signed in";
}


const FOLDS = [
  "Searched for", "Searched a conversation", "Looked through", "Read your day", "Read your days", "Read more", "Read a thing’s versions", "Read things", "Read a conversation",
  "Looked up", "Looked up a person", "Looked up more people", "Counted", "Looked at what it can count", "Left a note",
  "Read its access", "Asked to see more", "Gave up part of what it sees", "Gave up everything", "Took back its ask", "Called a tool",
] as const;

export type Fold = (typeof FOLDS)[number];
export type FoldTally = Partial<Record<Fold, number>>;
export type FoldCarried = [fold: number, n: number][];

export function foldOf(call: { tool: string; sent: Json; read: Json }, words: Words): Fold {
  return actFor(call, null, words).fold;
}

export function foldTally(tally: FoldTally, fold: Fold): FoldTally {
  return { ...tally, [fold]: (tally[fold] ?? 0) + 1 };
}

export function foldWords(n: number, tally: FoldTally): { words: string; line: string } {
  const most = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, FOLD_ACTS).map(([fold, each]) => `${fold} ${each}`);
  return { words: `${n.toLocaleString("en-GB")} more ${n === 1 ? "read" : "reads"}`, line: most.join(" · ") };
}

export function carriedOf(tally: FoldTally): FoldCarried {
  return Object.entries(tally).map(([fold, n]) => [FOLDS.indexOf(fold as Fold), n]);
}

export function tallyOf(carried: FoldCarried): FoldTally {
  return Object.fromEntries(carried.map(([at, n]) => [FOLDS[at]!, n]));
}

export function isCarried(value: unknown): value is FoldCarried {
  if (!Array.isArray(value) || value.length > FOLDS.length) return false;
  const pairs = value.every((pair) => Array.isArray(pair) && pair.length === 2 && Number.isSafeInteger(pair[0]) && pair[0] >= 0 && pair[0] < FOLDS.length && Number.isSafeInteger(pair[1]) && pair[1] >= 1);
  return pairs && new Set(value.map((pair: number[]) => pair[0])).size === value.length;
}

const FOLD_ACTS = 3;
const ASKED_CHARS = 60;


interface Act {
  past: string;
  to: string;
  tail: string;
  icon: string;
  fold: Fold;
}

function actFor(call: { tool: string; sent: Json; read: Json }, access: Access | null, words: Words): Act {
  return call.tool === "access" ? accessActOf(call.sent, call.read, access, words) : actOf(call.tool, call.sent, call.read, words);
}

function questionOf(sent: Json, read: Json): Record<string, Json> {
  const put = objectOr(read);
  return Object.keys(put).length > 0 ? put : objectOr(sent);
}

function actOf(tool: string, sent: Json, read: Json, words: Words): Act {
  const said = questionOf(sent, read);
  const text = (value: Json | undefined): string | null => (typeof value === "string" && clipped(value) !== "" ? clipped(value) : null);
  const quote = (value: string) => ` “${value}”`;
  switch (tool) {
    case "search": {
      const people = Array.isArray(said.person) ? said.person.filter((each): each is string => typeof each === "string" && each !== "") : [];
      const asked = text(said.query) ?? (people.length > 0 ? clipped(listed(people)) : null) ?? text(said.place);
      if (asked !== null) return { past: "Searched for", to: "search", tail: quote(asked), icon: "search", fold: "Searched for" };
      if (said.chat !== undefined) return { past: "Searched a conversation", to: "search a conversation", tail: "", icon: "chat", fold: "Searched a conversation" };
      const span = spanOf(said.from, said.to, words.zone);
      return { past: "Looked through", to: "look through", tail: span === null ? " your records" : ` ${span}`, icon: "search", fold: "Looked through" };
    }
    case "read": {
      if (said.chat !== undefined) return { past: "Read a conversation", to: "read a conversation", tail: "", icon: "chat", fold: "Read a conversation" };
      if (said.ref === undefined && (said.from !== undefined || said.to !== undefined)) return daysAct(spanOf(said.from, said.to, words.zone));
      if (said.ref === undefined) return { past: "Read more", to: "read more", tail: "", icon: "days", fold: "Read more" };
      if (said.history !== undefined) return { past: "Read a thing’s versions", to: "read a thing’s versions", tail: "", icon: "file", fold: "Read a thing’s versions" };
      const refs = (Array.isArray(said.ref) ? said.ref : [said.ref]).filter((each): each is string => typeof each === "string");
      const days = [...new Set(refs.map(dayOfRef))];
      if (refs.length > 0 && days.every((day) => day !== null)) {
        const sorted = (days as string[]).sort();
        return daysAct(sorted.length === 1 ? civilWords(sorted[0]!) : rangeWords(civilWords(sorted[0]!), civilWords(sorted.at(-1)!)));
      }
      const things = counted(Array.isArray(said.ref) ? said.ref.length : 1, THINGS);
      return { past: `Read ${things}`, to: `read ${things}`, tail: "", icon: "file", fold: "Read things" };
    }
    case "search_people": {
      const name = text(said.name);
      if (name !== null) return { past: "Looked up", to: "look up", tail: quote(name), icon: "person", fold: "Looked up" };
      if (said.id !== undefined) return { past: "Looked up a person", to: "look up a person", tail: "", icon: "person", fold: "Looked up a person" };
      return { past: "Looked up more people", to: "look up more people", tail: "", icon: "person", fold: "Looked up more people" };
    }
    case "count": {
      const of = text(said.of);
      if (of !== null) return { past: "Counted", to: "count", tail: quote(of), icon: "info", fold: "Counted" };
      return { past: "Looked at what it can count", to: "look at what it can count", tail: "", icon: "info", fold: "Looked at what it can count" };
    }
    case "feedback": return { past: "Left a note", to: "leave a note", tail: "", icon: "note", fold: "Left a note" };
    default: return { past: `Called ${tool}`, to: `call ${tool}`, tail: "", icon: "info", fold: "Called a tool" };
  }
}

function daysAct(span: string | null): Act {
  const fold = span !== null && span.includes("–") ? "Read your days" : "Read your day";
  return { past: fold, to: fold.toLowerCase(), tail: span === null ? "" : `, ${span}`, icon: "days", fold };
}

const UNSHOWN = /[\s\p{Cc}؜​‎‏‪-‮⁦-⁩﻿]+/gu;

function clipped(text: string): string {
  const line = [...text.replace(UNSHOWN, " ").trim()];
  return line.length > ASKED_CHARS ? `${line.slice(0, ASKED_CHARS - 1).join("")}…` : line.join("");
}

function dayOfRef(ref: string): string | null {
  try {
    const read = readRef(ref);
    return read.kind === "line" || read.kind === "window" ? read.parts.day : null;
  } catch {
    return null;
  }
}

const CIVIL = /^(\d{4})-(\d{2})-(\d{2})$/u;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_AND_MONTH = /^(\d{1,2}) (\p{L}+)$/u;

function civilWords(day: string): string {
  const parts = CIVIL.exec(day);
  return parts === null ? clipped(day) : `${Number(parts[3])} ${MONTHS[Number(parts[2]) - 1]}`;
}

function whenWords(value: Json | undefined, zone: string): string | null {
  if (typeof value !== "string" || value === "") return null;
  if (CIVIL.test(value)) return civilWords(value);
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? clipped(value) : dayMonthWords(ms, zone);
}

function spanOf(from: Json | undefined, to: Json | undefined, zone: string): string | null {
  const start = whenWords(from, zone);
  const end = whenWords(to, zone);
  if (start === null || end === null || start === end) return start ?? end;
  return rangeWords(start, end);
}

function rangeWords(start: string, end: string): string {
  if (start === end) return start;
  const first = DAY_AND_MONTH.exec(start);
  const last = DAY_AND_MONTH.exec(end);
  return first !== null && last !== null && first[2] === last[2] ? `${first[1]} – ${end}` : `${start} – ${end}`;
}


export interface ChangeSeen {
  name: string;
  what: AccessChangeWhat;
  by: AccessBy;
  device: string | null;
  access: Access | null;
  before: Access | null;
  wants: string | null;
  about: { account: string } | { lines: number[] } | { changed: true } | null;
  reason?: string | null;
  open?: boolean;
  again?: true;
}

export interface ChangeShown {
  words: string;
  line: string | null;
}

export function changeWords(change: ChangeSeen, words: Words, at: SentenceAt = {}): ChangeShown {
  const { name } = change;
  const who = { person: "You", home: "Lifestream", chat: "Chat", agent: "It" }[change.by];
  const by = change.by === "chat" ? "In a conversation" : change.by === "person" ? (change.device === null ? "You" : `You, on ${change.device}`) : null;
  const told = (more: string | null): string | null => (by === null ? more : more === null ? by : `${by} · ${more}`);
  const summary = (access: Access | null) => (access === null ? null : summaryOf(access, words, at));
  const wants = change.wants ?? "more";
  const { before, access } = change;
  switch (change.what) {
    case "granted": return { words: `${who} allowed ${name}`, line: told(summary(access)) };
    case "widened": return { words: `${who} let ${name} see ${access === null ? "more" : addedWords(before, access, words, at)}`, line: told(null) };
    case "narrowed": {
      if (change.by === "agent") {
        const gone = access === null || before === null ? [] : differenceOf(access, before, at.accounts ?? []).reads;
        return { words: `It gave up ${gone.length === 0 ? "part of what it sees" : listed(gone.map((piece) => pieceWords(piece, words)))}`, line: null };
      }
      if (before !== null && access !== null && !same(before.hide, access.hide) && same({ ...before, hide: "none" }, { ...access, hide: "none" })) {
        return { words: `${who} hid ${hiddenAdded(before.hide, access.hide)} from ${name}`, line: told(seesAs(before.hide, access.hide)) };
      }
      return { words: change.by === "chat" ? "Chat narrowed it" : `${who} narrowed what ${name} sees`, line: told(summary(access)) };
    }
    case "requested": {
      const asked = `asked ${change.again === true ? "again " : ""}to see ${wants}`;
      const reason = change.reason ?? null;
      const waiting = change.open === true;
      return {
        words: change.by === "agent" ? capital(asked) : `${who} ${asked}`,
        line: reason === null ? (waiting ? "Waiting for you" : null) : `“${reason}”${waiting ? " · waiting for you" : ""}`,
      };
    }
    case "allowed": return { words: `${who} allowed ${wants}`, line: told(null) };
    case "declined": return { words: `${who} didn’t allow it`, line: told(null) };
    case "replaced": return { words: change.about !== null && "changed" in change.about ? "Chat’s proposal closed: the access changed" : "Asked again", line: null };
    case "dropped": return { words: "Took back its ask", line: null };
    case "lapsed": return { words: "The ask ended with no answer", line: null };
    case "joined": return { words: change.about !== null && "account" in change.about ? `${capital(words.account(change.about.account))} added when you connected it` : "A new connector was added", line: null };
    case "erased": {
      const lines = change.about !== null && "lines" in change.about ? change.about.lines : [];
      return { words: lines.length === 0 ? "An erase changed what it sees" : "An erase removed part of what it sees", line: null };
    }
    case "removed": return { words: `${who} disconnected ${name}`, line: told(null) };
  }
}

function addedWords(before: Access | null, after: Access, words: Words, at: SentenceAt): string {
  const { reads, window, hide } = differenceOf(before, after, at.accounts ?? []);
  if (reads.length > 0 && window === undefined) return listed(reads.map((piece) => pieceWords(piece, words)));
  if (reads.length === 0 && window === undefined && before !== null && hide !== null) return shownAdded(before.hide, after.hide);
  return "more";
}

function hiddenAdded(before: Level, after: Level): string {
  const names = hides(after, "person") && !hides(before, "person");
  const details = hides(after, "phone") && !hides(before, "phone");
  return names && details ? "names and details" : names ? "names" : details ? "details" : "more";
}

function shownAdded(before: Level, after: Level): string {
  const names = hides(before, "person") && !hides(after, "person");
  const details = hides(before, "phone") && !hides(after, "phone");
  return names && details ? "names and details" : names ? "names" : details ? "details" : "more";
}

function seesAs(before: Level, after: Level): string {
  return hides(after, "person") && !hides(before, "person") ? "it sees “a person” where a name was" : "it sees blanks where details were";
}

export function toldWords(state: RequestState): string {
  if (state === "declined") return "Was told: not allowed";
  if (state === "allowed") return "Was told: allowed";
  if (state === "lapsed") return "Was told: expired";
  return "Was told: over";
}

const NOTHING: Access = { allow: [], items: [], not: [], only: [], window: null, hide: "all", shown: [] };

function newOf(allow: Allow, was: readonly Allow[], accounts: readonly HomeAccount[], category: (account: string) => Type | null): Allow[] {
  const piece = (reach: Reach): Allow => ({ ...allow, reach });
  const held = (reach: Reach) => was.some((wider) => allowWithin(piece(reach), wider, category));
  const ofAccount = (account: string): Allow[] => (held({ account, but: [] }) ? [] : [piece({ account, but: [] })]);
  const ofType = (type: Type, but: readonly string[]): Allow[] => {
    if (held({ type, but: [...but] })) return [];
    const holding = was.filter((wider) => "type" in wider.reach && wider.reach.type === type && allowWithin(piece({ type, but: [] }), { ...wider, reach: { type, but: [] } }, category));
    if (holding.length > 0) {
      const buts = holding.map((wider) => (wider.reach as { but: string[] }).but);
      return buts[0]!.filter((account) => buts.every((each) => each.includes(account)) && !but.includes(account)).flatMap((account) => ofAccount(account));
    }
    const parts = accounts.filter((account) => account.category === type && !but.includes(account.account)).map((account) => ({ account: account.account, pieces: ofAccount(account.account) }));
    const read = parts.filter(({ account, pieces }) => pieces.length !== 1 || !same(pieces[0]!.reach, { account, but: [] }));
    if (read.length === 0) return [piece({ type, but: [...but] })];
    return [piece({ type, but: [...but, ...read.map(({ account }) => account)].sort() }), ...read.flatMap(({ pieces }) => pieces)];
  };
  const reach = allow.reach;
  if (held(reach)) return [];
  if ("all" in reach) {
    if (reach.but.length === 0) return [allow];
    const parts = (Object.keys(TYPES) as Type[]).filter((type) => !reach.but.includes(type)).map((type) => ({ type, pieces: ofType(type, []) }));
    return parts.every(({ type, pieces }) => pieces.length === 1 && same(pieces[0]!.reach, { type, but: [] })) ? [allow] : parts.flatMap(({ pieces }) => pieces);
  }
  if ("type" in reach) return ofType(reach.type, reach.but);
  return ofAccount(reach.account);
}

function pieceWords(piece: Allow, words: Words): string {
  return `${reachWords(piece.reach, words)}${windowPhrase(piece.window, words.zone)}${piece.until_ms === null ? "" : ` until ${instantWords(piece.until_ms, words.zone)}`}`;
}

function seenPiece(piece: Allow, words: Words): Bolded {
  const reach = piece.reach;
  if ("type" in reach && reach.but.length === 0 && piece.window === null && piece.until_ms === null) return runs("your ", bold(yoursOf(reach.type)));
  return bold(pieceWords(piece, words));
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function readWords(read: ReadWant, words: Words): string {
  if (read === "everything") return "everything";
  if ("category" in read) return typeName(read.category);
  if ("product" in read) return `all of ${words.product(read.product)}`;
  return `your ${words.account(read.account)}`;
}

function accessActOf(sent: Json, read: Json, access: Access | null, words: Words): Act {
  const said = objectOr(sent);
  const own = (past: string, fold: Fold, to = "change its access"): Act => ({ past, to, tail: "", icon: "private", fold });
  if (said.drop === "request") return own("Took back its ask", "Took back its ask");
  if (said.drop === "everything") return own("Gave up everything", "Gave up everything");
  if (typeof said.drop === "number") {
    const line = access === null ? undefined : numbered(access).find((each) => each.number === said.drop && each.member === "allow");
    const fold = "Gave up part of what it sees";
    return own(line === undefined || access === null ? fold : `Gave up ${reachWords(access.allow[line.index]!.reach, words)}`, fold);
  }
  if (said.request === undefined) return own("Read its access", "Read its access", "read its access");
  const asked = objectOr(read);
  const fold = "Asked to see more";
  if (asked.want === undefined) return own(fold, fold, "ask to see more");
  const wants = wantsOf(asked.want as unknown as AskWant, typeof asked.for_ms === "number" ? asked.for_ms : null, words);
  if (asked.state === "held") return own(`Asked again to see ${wants}: held, you said no`, fold, `ask again to see ${wants}`);
  if (asked.state === "already") return own(`Asked to see ${wants}, which it already sees`, fold, `ask to see ${wants}`);
  return own(`Asked to see ${wants}`, fold, `ask to see ${wants}`);
}

export type AccessCallRead = { want: Json; for_ms: number | null; state: "asked" | "held" | "already"; changed: boolean } | { changed: boolean };

export function changedBy(call: { tool: string; result: ReaderCallResult; read: Json }): boolean {
  return call.tool === "access" && call.result === "answered" && objectOr(call.read).changed === true;
}

function objectOr(value: Json): Record<string, Json> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function withheldWords(line: string, access: Access | null, words: Words): string {
  if (line === "unresolved") return "couldn’t be checked";
  if (line === "no-line") return "outside what it sees";
  if (line === "window") return "older than it sees";
  const found = access === null ? undefined : numbered(access).find((each) => String(each.number) === line);
  if (found === undefined || access === null) return `line ${line}`;
  if (found.member === "window") {
    const window = access.window!;
    return "since_ms" in window ? `from before ${dateWords(window.since_ms, words.zone)}` : `outside the ${windowWords(window, words.zone)}`;
  }
  return `line ${line}`;
}

function dayWords(ms: number, now_ms: number, zone: string): string {
  const day = (at: number) => dateWords(at, zone);
  return day(ms) === day(now_ms) ? instantWords(ms, zone).split(" ").at(-1)! : instantWords(ms, zone);
}
