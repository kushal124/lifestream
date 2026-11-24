import type Database from "better-sqlite3";
import { addDays, civilDay, dayBounds, type DaySettings } from "@lifestreamprotocol/core";
import { blockEvidence, metaOf, screenPositionOf, unpackText } from "./screen-index.js";
import type { ProductWindows } from "./screen-keys.js";
import { AROUND_CHARS, CursorError, CursorReader, CursorWriter, GIVEN_MOST, NEXT_CHARS, VARINT_BYTES } from "./cursor-text.js";
import { Work } from "./work.js";
import { NEAR_MOST, prefixedOf, readQuery, SCREEN_WORDS, skeletonOf, spellingsOf, tokens, wordsIn, type Read, type Term as Typed, type Vocabulary } from "./search-words.js";

const NEWEST_DAYS = 366;
export const STRETCH_DAYS = 366;
export const PAGE_HITS = 10;
export const CURSOR_CHARS = NEXT_CHARS - AROUND_CHARS;
const PREFIX_WALK = 1_000;
const PREFIX_MOST = 16;
export const TOP = 40;
const COVERAGE = 0.6;
export const UNCOMMON_IDF = Math.log(6);
export const BLOCK_SHARE = 0.5;
export const MINUTE_RESULTS = 3;
const SPREAD_MS = 30 * 60_000;
const DAY_MS = 86_400_000;
const EXCERPT_CHARS = 200;
export const TERM_LINES = 8;

interface HiddenAsk {
  evidence?: boolean;
  unmatched?: ReadonlySet<string>;
  nowhere?: ReadonlySet<string>;
  width?: number;
}

export interface ScreenGate {
  readonly since_ms: number | null;
  floor(machine: string): number | null | undefined;
  allows(machine: string, at_ms: number, tally: boolean): boolean;
}

export interface ScreenSearch extends HiddenAsk {
  q: string;
  typing?: true;
  now_ms: number;
  from_ms?: number;
  to_ms?: number;
  windows?: ProductWindows;
  cursor?: ScreenCursor;
  room?: number;
  gate?: ScreenGate;
}

export interface ScreenWindow {
  key: bigint;
  day: string;
}

export interface ScreenCursor {
  newest: string;
  oldest: string;
  upto_ms: number;
  by_day: boolean;
  place?: ScreenWindow;
  given: ScreenWindow[];
}

export const stretchStart = (cursor: ScreenCursor | undefined): boolean => cursor === undefined || (!cursor.by_day && cursor.given.length === 0);

export interface ScreenPage {
  applied_filter: {
    terms: { word: string; matches: string[]; idf: number }[];
    dropped: string[];
    sites?: string[];
  };
  read_as: { without: string[]; as: Record<string, readonly string[]> };
  stretch: { from: string; to: string };
  seq: number;
  hits: ScreenHit[];
  total: number;
  capped: boolean;
  reached?: { side: "newest"; whole: string };
  order?: "newest";
  next?: ScreenCursor;
}

export interface ScreenHit {
  machine: string;
  app: string;
  site: string;
  name: string;
  day: string;
  at_ms: number;
  until_ms: number | null;
  excerpt: string;
  evidence: string;
  reason: Reason;
  also: ScreenSibling[];
  source?: string;
  terms?: TermLines[];
  spans?: [number, number][];
  group?: string;
}

type Reason = "words" | "spelling" | "partial";

export interface ScreenSibling {
  machine: string;
  app: string;
  site: string;
  name: string;
  day: string;
  terms?: TermLines[];
  spans?: [number, number][];
  group?: string;
}

export interface Stated {
  from: string;
  to: string;
}

export interface TermLines {
  word: string;
  forms: string[][];
  lines: string[];
}

interface Term {
  word: string;
  match: string;
  forms: string[][];
  phrases: string[][];
  idf: number;
  spelling: boolean;
  nowhere?: boolean;
}

interface Terms {
  terms: Term[];
  excluded: Pick<Term, "match" | "forms" | "phrases">[];
}

interface Group {
  key: bigint;
  day: string;
  L: number;
  rows: Map<number, number[]>;
  score: number;
  anchor: number;
  rarest: number;
  partial: boolean;
}

interface Hit {
  group: Group;
  also: Group[];
}

interface KeyRow {
  id: number;
  machine: string;
  app: string;
  site: string;
  name: string;
}

type KeyNames = Omit<KeyRow, "id">;
type KeyOf = (id: bigint) => KeyNames;

interface KeyFilter {
  sites?: readonly string[];
  windows?: ProductWindows;
}

export function search(db: Database.Database, ask: ScreenSearch): ScreenPage {
  return metered(() => db.transaction(() => searchIn(db, ask))());
}

let meter: Work | undefined;

type ScreenLine = ReturnType<typeof unpackText>[number];

interface ReadOnce {
  texts: Map<number, readonly ScreenLine[]>;
  words: Map<string, readonly string[]>;
  spans: Map<string, readonly Span[]>;
}

let once: ReadOnce | undefined;

function metered<T>(work: () => T): T {
  const outer = { meter, once };
  meter = new Work(Infinity);
  once = { texts: new Map(), words: new Map(), spans: new Map() };
  try {
    return work();
  } finally {
    ({ meter, once } = outer);
  }
}

const counted = (rows: number): void => {
  meter?.made(rows);
};

interface Stretch {
  read: Read;
  terms: Term[];
  sites: string[] | undefined;
  cursor: ScreenCursor;
  older: ScreenCursor | undefined;
  keyOf: KeyOf;
  groups: Group[];
}

function stretchIn(db: Database.Database, ask: ScreenSearch): Stretch {
  const days = daysOf(db);
  const read = readQuery(ask.q, SCREEN_WORDS, ask.typing === true);
  const { terms, excluded } = termsOf(db, read.terms, ask.nowhere, prefixedOf(read.terms, read.typing));
  const sites = sitesOf(read);
  const asked = ask.from_ms ?? firstOf(db, ask.now_ms);
  const floor = Math.max(asked, ask.gate?.since_ms ?? -Infinity);
  const cursor = ask.cursor ?? firstStretch(ask, floor, days);
  const start = dayBounds(cursor.oldest, days).start_ms;
  const range = { from: Math.max(floor, start), to: Math.min(cursor.upto_ms, ask.to_ms ?? Infinity, dayBounds(cursor.newest, days).end_ms) };
  const older = floor < start ? olderStretch(cursor, floor, days) : undefined;
  const filter: KeyFilter = { ...(sites === undefined ? {} : { sites }), ...(ask.windows === undefined ? {} : { windows: ask.windows }) };
  const keyOf = keysOf(db);
  const allowed = ask.gate === undefined ? undefined : allowedOf(ask.gate, keyOf);
  const groups = terms.length === 0 || range.to <= range.from ? [] : matched(db, terms, excluded, range, filter, ask.unmatched, allowed);
  const before = { from: Math.max(asked, floor - STRETCH_DAYS * DAY_MS), to: Math.min(floor, ask.to_ms ?? Infinity) };
  if (allowed !== undefined && ask.cursor === undefined && terms.length > 0 && before.from < before.to) matched(db, terms, excluded, before, filter, ask.unmatched, allowed);
  return { read, terms, sites, cursor, older, keyOf, groups };
}

function searchIn(db: Database.Database, ask: ScreenSearch): ScreenPage {
  const { read, terms, sites, cursor, older, keyOf, groups } = stretchIn(db, ask);
  const page: ScreenPage = {
    applied_filter: appliedOf(terms, read, sites),
    read_as: { without: read.without, as: read.as },
    stretch: { from: cursor.oldest, to: cursor.newest },
    seq: screenPositionOf(db)?.seq ?? 0,
    hits: [],
    total: groups.length,
    capped: false,
  };
  const room = Math.floor((Math.min(ask.room ?? CURSOR_CHARS, NEXT_CHARS) * 3) / 4);
  let made = cursor.by_day ? byDay(db, groups, cursor, terms, keyOf) : byRank(db, groups, cursor, terms, keyOf, room, ask.width ?? PAGE_HITS);
  const turned = made.hits.length === 0 && made.next?.by_day === true;
  if (turned) made = byDay(db, groups, made.next!, terms, keyOf);
  const first = stretchStart(cursor);
  page.hits = made.hits.map((hit, i) => screenHitOf(db, hit, terms, keyOf, first && i < MINUTE_RESULTS, ask.evidence === true, ask.gate));
  if (cursor.by_day || turned) page.order = "newest";
  const next = made.next ?? older;
  if (next !== undefined) {
    page.capped = true;
    page.reached = { side: "newest", whole: cursor.oldest };
    page.next = next;
  }
  return page;
}

export interface WindowGroup {
  name: string;
  machine: string;
  day: string;
  spans: [number, number][];
}

export interface StretchGroups {
  stretch: Stated;
  cursor: ScreenCursor;
  older?: ScreenCursor;
  groups: WindowGroup[];
  hits(chosen: readonly WindowGroup[]): Map<string, ScreenHit>;
}

export function stretchGroups(db: Database.Database, ask: ScreenSearch): StretchGroups {
  return metered(() => db.transaction(() => {
    const { terms, cursor, older, keyOf, groups } = stretchIn(db, ask);
    const byName = new Map(groups.map((group) => [windowName(group), group]));
    const windows = groups.flatMap((group): WindowGroup[] => {
      const { machine } = keyOf(group.key);
      const shown = matchedSpans(db, group, machine, ask.gate);
      return shown.length === 0 ? [] : [{ name: windowName(group), machine, day: group.day, spans: merged(shown).map((run): [number, number] => [run.from, run.to]) }];
    });
    const hits = (chosen: readonly WindowGroup[]) => metered(() => db.transaction(() => new Map(chosen.flatMap((window) => {
      const group = byName.get(window.name);
      if (group === undefined) return [];
      anchored(group);
      return [[window.name, screenHitOf(db, { group, also: [] }, terms, keyOf, false, false, ask.gate)] as const];
    })))());
    return { stretch: { from: cursor.oldest, to: cursor.newest }, cursor, ...(older === undefined ? {} : { older }), groups: windows, hits };
  })());
}

export function gaveToo(page: ScreenPage, windows: readonly ScreenWindow[]): ScreenCursor | undefined {
  const next = page.next;
  if (next === undefined || windows.length === 0 || next.newest !== page.stretch.to) return next;
  const given = new Set(next.given.map(windowName));
  const past = (window: ScreenWindow) => !next.by_day || next.place === undefined || window.day < next.place.day || (window.day === next.place.day && window.key > next.place.key);
  const more = windows.filter((window) => past(window) && !given.has(windowName(window)));
  return more.length === 0 ? next : { ...next, given: [...next.given, ...more] };
}

export const MEANING_ROOM = Math.ceil((PAGE_HITS * (VARINT_BYTES + 2) * 4) / 3);

function firstStretch(ask: ScreenSearch, floor: number, days: DaySettings): ScreenCursor {
  const upto = Math.min(ask.to_ms ?? ask.now_ms, ask.now_ms);
  const newest = civilDay(Math.max(upto, floor + 1) - 1, days);
  const dated = ask.from_ms !== undefined || ask.to_ms !== undefined;
  return { newest, oldest: latest(addDays(newest, -((dated ? STRETCH_DAYS : NEWEST_DAYS) - 1)), civilDay(floor, days)), upto_ms: upto, by_day: false, given: [] };
}

function olderStretch(cursor: ScreenCursor, floor: number, days: DaySettings): ScreenCursor {
  const newest = addDays(cursor.oldest, -1);
  return { newest, oldest: latest(addDays(newest, -(STRETCH_DAYS - 1)), civilDay(floor, days)), upto_ms: dayBounds(newest, days).end_ms, by_day: false, given: [] };
}

function latest(day: string, other: string): string {
  return day > other ? day : other;
}

const windowName = (window: ScreenWindow) => `${window.key}/${window.day}`;
const keyOrder = (one: bigint, other: bigint) => (one < other ? -1 : one > other ? 1 : 0);
const windowOfGroup = (group: Group): ScreenWindow => ({ key: group.key, day: group.day });

function byRank(db: Database.Database, groups: readonly Group[], cursor: ScreenCursor, terms: readonly Term[], keyOf: KeyOf, room: number, width: number): { hits: Hit[]; next?: ScreenCursor } {
  const given = new Set(cursor.given.map(windowName));
  const { order, forty } = ordered(groups);
  const top = new Set(order.slice(0, forty));
  const left = order.filter((group) => !given.has(windowName(group)));
  const hits: Hit[] = [];
  const siblings = new Map<string, Hit>();
  const held = givenHeld(cursor, room);
  const full = () => held.ceiling || hits.length === width || held.given.length >= GIVEN_MOST;
  const results = collapse(db, left.filter((group) => top.has(group)), terms, keyOf);
  let read = 0;
  for (; read < results.length && !full(); read++) {
    const { hit, name } = results[read]!;
    if (!held.take([hit.group, ...hit.also].map(windowOfGroup))) break;
    hits.push(hit);
    if (name !== undefined) siblings.set(name, hit);
  }
  let rest = read < results.length;
  if (!rest) {
    const past = left.filter((group) => !top.has(group));
    let at = 0;
    for (; at < past.length && !full(); at++) {
      if (!held.take([windowOfGroup(past[at]!)])) break;
      fold(db, past[at]!, hits, siblings, terms, keyOf);
    }
    rest = at < past.length;
  }
  if (!rest) return { hits };
  return { hits, next: { ...cursor, given: held.given, by_day: held.ceiling || held.given.length >= GIVEN_MOST } };
}

function givenHeld(cursor: ScreenCursor, room: number): { given: ScreenWindow[]; ceiling: boolean; take: (windows: readonly ScreenWindow[]) => boolean } {
  const held = { given: [...cursor.given], ceiling: false, take };
  const bytes = (given: ScreenWindow[]) => cursorBytes({ ...cursor, by_day: false, given }).length + WINDOW_BYTES;
  let bound = bytes(held.given);
  let least = held.given.reduce<bigint | undefined>((low, window) => (low === undefined || window.key < low ? window.key : low), undefined);
  function take(windows: readonly ScreenWindow[]): boolean {
    const most = bound + windows.length * WINDOW_BYTES + 1;
    const first = least !== undefined && windows.some((window) => window.key < least!);
    if (most > room || first) {
      const exact = bytes([...held.given, ...windows]);
      if (exact > room) {
        held.ceiling = true;
        return false;
      }
      bound = exact;
    } else bound = most;
    held.given.push(...windows);
    for (const window of windows) if (least === undefined || window.key < least) least = window.key;
    return true;
  }
  return held;
}

function byDay(db: Database.Database, groups: readonly Group[], cursor: ScreenCursor, terms: readonly Term[], keyOf: KeyOf): { hits: Hit[]; next?: ScreenCursor } {
  const given = new Set(cursor.given.map(windowName));
  const past = (window: ScreenWindow, place: ScreenWindow | undefined) =>
    place === undefined || window.day < place.day || (window.day === place.day && window.key > place.key);
  const left = [...groups].sort((one, other) => (one.day < other.day ? 1 : one.day > other.day ? -1 : keyOrder(one.key, other.key)))
    .filter((group) => past(group, cursor.place) && !given.has(windowName(group)));
  const hits: Hit[] = [];
  const siblings = new Map<string, Hit>();
  let at = 0;
  for (; at < left.length && hits.length < PAGE_HITS; at++) fold(db, left[at]!, hits, siblings, terms, keyOf);
  if (at === left.length) return { hits };
  const place = windowOfGroup(left[at - 1]!);
  return { hits, next: { ...cursor, by_day: true, place, given: cursor.given.filter((window) => past(window, place)) } };
}

function fold(db: Database.Database, group: Group, hits: Hit[], siblings: Map<string, Hit>, terms: readonly Term[], keyOf: KeyOf): void {
  anchored(group);
  const name = siblingName(db, group, terms, keyOf);
  const into = name === undefined ? undefined : siblings.get(name);
  if (into !== undefined) {
    into.also.push(group);
    return;
  }
  const hit = { group, also: [] };
  hits.push(hit);
  if (name !== undefined) siblings.set(name, hit);
}

function appliedOf(terms: readonly Term[], read: Read, sites: string[] | undefined): ScreenPage["applied_filter"] {
  return {
    terms: terms.map((term) => ({ word: term.word, matches: term.forms.map((form) => form.join(" ")), idf: round(term.idf) })),
    dropped: read.without,
    ...(sites === undefined ? {} : { sites }),
  };
}

function sitesOf(read: Read): string[] | undefined {
  const sites = unique(Object.values(read.as).flat());
  return sites.length === 0 ? undefined : sites;
}

function proofOf(db: Database.Database, group: Group, terms: readonly Term[], keyOf: KeyOf, gate?: ScreenGate): { terms: TermLines[]; spans: [number, number][]; group: string } {
  const proof = [...group.rows].map(([i, slots]): TermLines => {
    const term = terms[i]!;
    const lines = new Set<string>();
    for (const slot of slots) {
      if (lines.size >= TERM_LINES) break;
      for (const { line } of linesHolding(db, slot, [term])) {
        if (lines.size >= TERM_LINES) break;
        lines.add(line);
      }
    }
    return { word: term.word, forms: term.forms, lines: [...lines] };
  });
  return { terms: proof, spans: merged(groupSpans(db, group, keyOf(group.key).machine, gate)).map((run) => [run.from, run.to]), group: `${group.key}/${group.day}` };
}

interface Span {
  display: string;
  from_ms: number;
  to_ms: number;
}

interface SpanReads {
  day: Database.Statement;
  slots: Database.Statement;
}

const spanReads = new WeakMap<Database.Database, SpanReads>();

function spanReadsOf(db: Database.Database): SpanReads {
  const held = spanReads.get(db);
  if (held !== undefined) return held;
  const made: SpanReads = {
    day: db.prepare("SELECT s.display, s.from_ms, s.to_ms FROM screen_span s JOIN screen_row r ON r.slot = s.slot WHERE r.key = ? AND r.day = ? ORDER BY s.from_ms, s.display"),
    slots: db.prepare("SELECT display, from_ms, to_ms FROM screen_span WHERE slot IN (SELECT value FROM json_each(?)) ORDER BY from_ms, display"),
  };
  spanReads.set(db, made);
  return made;
}

function groupSpans(db: Database.Database, group: Pick<Group, "key" | "day">, machine: string, gate: ScreenGate | undefined): readonly Span[] {
  const name = `${group.key}/${group.day}`;
  let rows = once?.spans.get(name);
  if (rows === undefined) {
    rows = spanReadsOf(db).day.all(group.key, group.day) as Span[];
    counted(rows.length);
    once?.spans.set(name, rows);
  }
  return gated(rows, machine, gate);
}

function matchedSpans(db: Database.Database, group: Pick<Group, "rows">, machine: string, gate: ScreenGate | undefined): readonly Span[] {
  const slots = [...new Set([...group.rows.values()].flat())];
  const rows = spanReadsOf(db).slots.all(JSON.stringify(slots)) as Span[];
  counted(rows.length);
  return gated(rows, machine, gate);
}

function gated(rows: readonly Span[], machine: string, gate: ScreenGate | undefined): readonly Span[] {
  return gate === undefined ? rows : rows.filter((span) => gate.allows(machine, span.from_ms, false));
}

export function daysOf(db: Database.Database): DaySettings {
  const value = (db.prepare("SELECT value FROM meta WHERE name = 'days'").get() as { value: string } | undefined)?.value;
  return JSON.parse(value ?? '{"zone":"UTC","day_start_hour":0}') as DaySettings;
}

function firstOf(db: Database.Database, now: number): number {
  const first = (db.prepare("SELECT min(slot) AS slot FROM screen_row").get() as { slot: number | null }).slot;
  return first === null ? now : Math.min(now, Math.floor(first / 8));
}

function screenVocabulary(db: Database.Database): Vocabulary {
  const docOf = db.prepare("SELECT doc FROM screen_vocab WHERE term = ?").pluck();
  const words = db.prepare("SELECT term FROM screen_vocab WHERE term >= ? AND term < ?").pluck();
  const held = new Map<string, number>();
  const one = (word: string) => {
    let n = held.get(word);
    if (n === undefined) held.set(word, n = (docOf.get(word) as number | undefined) ?? 0);
    return n;
  };
  function* starting(first: string, most: number): Iterable<string> {
    let n = 0;
    if (n >= most) return;
    for (const word of words.iterate(first, String.fromCodePoint(first.codePointAt(0)! + 1)) as Iterable<string>) {
      yield word;
      if (++n >= most) return;
    }
  }
  return {
    held: (form, most) => Math.min(most, ...form.split(" ").map(one)),
    has: (word) => one(word) > 0,
    *ofSkeleton(skeleton, most) {
      let n = 0;
      for (const first of new Set(["a", "e", "i", "o", "u", [...skeleton][0]!])) {
        for (const word of starting(first, Infinity)) {
          if (n >= most) return;
          if (skeletonOf(word) === skeleton) {
            yield word;
            n++;
          }
        }
      }
    },
    starting,
    left: () => Infinity,
  };
}

function begun(vocabulary: Vocabulary, start: string): string[] {
  const found: string[] = [];
  for (const each of vocabulary.starting(start, PREFIX_WALK)) {
    if (!each.startsWith(start)) break;
    found.push(each);
  }
  const held = new Map(found.map((each) => [each, vocabulary.held(each, Infinity)]));
  return found.sort((one, other) => held.get(other)! - held.get(one)! || (one < other ? -1 : 1)).slice(0, PREFIX_MOST);
}

function termsOf(db: Database.Database, typed: readonly Typed[], nowhere?: ReadonlySet<string>, prefixed?: Typed): Terms {
  const total = Number(metaOf(db, "texts") ?? 0);
  const vocabulary = screenVocabulary(db);
  const groups: Typed[][] = [];
  const excluded: Terms["excluded"] = [];
  for (const term of typed) {
    const words = wordsIn(term.text).map((each) => each.word);
    if (words.length === 0) continue;
    if (term.negated) excluded.push({ match: quote(words.join(" ")), forms: [words], phrases: words.length > 1 ? [words] : [] });
    else if (term.or && groups.length > 0) groups.at(-1)!.push(term);
    else groups.push([term]);
  }
  const terms: Term[] = [];
  const named = new Set<string>();
  for (const group of groups) {
    const alternatives = group.map((term) => {
      const words = wordsIn(term.text).map((each) => each.word);
      const starts = term === prefixed ? begun(vocabulary, words.at(-1)!).map((each) => [...words.slice(0, -1), each]) : [];
      return { words, quoted: term.quoted, own: starts.length === 0 ? [words] : starts, prefixed: starts.length > 0 };
    });
    const word = alternatives.map((alternative) => alternative.words.join(" ")).join(" OR ");
    if (named.has(word)) continue;
    named.add(word);
    if (nowhere?.has(word) === true) {
      terms.push({ word, match: quote(word), forms: alternatives.map((alternative) => alternative.words), phrases: [], idf: Math.log(1 + total), spelling: false, nowhere: true });
      continue;
    }
    const forms: string[][] = [];
    let docs = 0;
    let typedHeld = false;
    for (const { words, quoted, own: started, prefixed: begins } of alternatives) {
      if (begins) {
        typedHeld = true;
        forms.push(...started);
        docs += started.reduce((sum, each) => sum + vocabulary.held(each.join(" "), Infinity), 0);
        continue;
      }
      const own = vocabulary.held(words.join(" "), Infinity);
      const near = own > 0 || quoted || words.length > 1 ? [] : spellingsOf(words[0]!, vocabulary, SCREEN_WORDS.spelling).slice(0, NEAR_MOST);
      if (own > 0) typedHeld = true;
      if (near.length === 0) forms.push(words);
      for (const each of near) forms.push(each.split(" "));
      docs += own + near.reduce((sum, each) => sum + vocabulary.held(each, Infinity), 0);
    }
    const distinct = unique(forms.map((form) => form.join(" "))).map((form) => form.split(" "));
    terms.push({
      word,
      match: distinct.length === 1 ? quote(distinct[0]!.join(" ")) : `(${distinct.map((form) => quote(form.join(" "))).join(" OR ")})`,
      forms: distinct,
      phrases: unique(alternatives.flatMap((alternative) => (alternative.words.length > 1 ? alternative.own.map((form) => form.join(" ")) : []))).map((form) => form.split(" ")),
      idf: docs > 0 ? Math.log(1 + total / Math.max(1, Math.min(total, docs))) : Math.log(1 + total),
      spelling: !typedHeld && docs > 0,
    });
  }
  return { terms: terms.sort((left, right) => right.idf - left.idf || (left.word < right.word ? -1 : 1)), excluded };
}

type Allowed = (key: bigint, slot: number, tally: boolean) => boolean;

function allowedOf(gate: ScreenGate, keyOf: KeyOf): Allowed {
  const tallied = new Set<number>();
  return (key, slot, tally) => {
    const tallies = tally && !tallied.has(slot);
    if (tallies) tallied.add(slot);
    return gate.allows(keyOf(key).machine, Math.floor(slot / 8), tallies);
  };
}

function matched(
  db: Database.Database, terms: readonly Term[], excluded: Terms["excluded"], range: { from: number; to: number }, filter: KeyFilter, unmatched?: ReadonlySet<string>,
  allowed?: Allowed,
): Group[] {
  const searched = terms.flatMap((term, i) => (term.nowhere === true ? [] : [i]));
  if (searched.length === 0) return [];
  const lo = range.from * 8;
  const hi = range.to * 8 - 1;
  const parts = [...searched.map((i) => [i, terms[i]!] as const), ...excluded.map((part, k) => [terms.length + k, part] as const)];
  const crossed = parts.map(([, part]) => crossing(db, part, lo, hi));
  const hits = parts.map(([i], n) => `SELECT ${i} AS term, rowid AS slot, -bm25(screen_fts, 3, 1) AS s FROM screen_fts WHERE screen_fts MATCH ? AND rowid BETWEEN ? AND ?`
    + (crossed[n]!.length === 0 ? "" : " AND rowid NOT IN (SELECT value FROM json_each(?))")).join(" UNION ALL ");
  const values: unknown[] = parts.flatMap(([, part], n) => [part.match, lo, hi, ...(crossed[n]!.length === 0 ? [] : [JSON.stringify(crossed[n])])]);
  const conditions: string[] = [];
  if (filter.sites !== undefined) {
    conditions.push("site IN (SELECT value FROM json_each(?))");
    values.push(JSON.stringify(filter.sites));
  }
  if (filter.windows !== undefined) {
    conditions.push("(site IN (SELECT value FROM json_each(?)) OR app IN (SELECT value FROM json_each(?)))");
    values.push(JSON.stringify(filter.windows.sites), JSON.stringify(filter.windows.apps));
  }
  const keyFilter = conditions.length === 0 ? "" : `WHERE r.key IN (SELECT id FROM screen_key WHERE ${conditions.join(" AND ")})`;
  const sql = `WITH hits AS MATERIALIZED (${hits})
    SELECT r.key, r.day, h.term, max(h.s) AS s, group_concat(h.slot) AS slots
    FROM hits h JOIN screen_row r ON r.slot = h.slot ${keyFilter}
    GROUP BY r.key, r.day, h.term`;
  const byGroup = new Map<string, Group>();
  const dropped = new Set<string>();
  const withheld: { name: string; key: bigint; slots: number[] }[] = [];
  for (const row of db.prepare(sql).safeIntegers(true).iterate(...values) as Iterable<{ key: bigint; day: string; term: bigint; s: number; slots: string }>) {
    const name = `${row.key}\0${row.day}`;
    const term = Number(row.term);
    const read = row.slots.split(",").map(Number);
    counted(read.length);
    if (term < terms.length && unmatched?.has(`${row.key}/${row.day}/${terms[term]!.word}`) === true) continue;
    const slots = allowed === undefined ? read : read.filter((slot) => allowed(row.key, slot, false));
    if (term >= terms.length) {
      if (slots.length > 0) dropped.add(name);
      continue;
    }
    if (slots.length < read.length) {
      const kept = new Set(slots);
      withheld.push({ name, key: row.key, slots: read.filter((slot) => !kept.has(slot)) });
    }
    if (slots.length === 0) continue;
    let group = byGroup.get(name);
    if (group === undefined) {
      byGroup.set(name, group = { key: row.key, day: row.day, L: 0, rows: new Map(), score: 0, anchor: 0, rarest: 0, partial: false });
    }
    group.L += row.s;
    group.rows.set(term, slots.sort((left, right) => left - right));
  }
  for (const each of withheld) if (!dropped.has(each.name)) for (const slot of each.slots) allowed!(each.key, slot, true);
  const groups = [...byGroup].flatMap(([name, group]) => (dropped.has(name) ? [] : [group]));
  const totalIdf = terms.reduce((sum, term) => sum + term.idf, 0);
  const covers = (group: Group) => terms.length <= 2
    ? group.rows.size === terms.length
    : [...group.rows.keys()].reduce((sum, i) => sum + terms[i]!.idf, 0) >= COVERAGE * totalIdf;
  let kept = groups.filter(covers);
  if (kept.length === 0) {
    kept = groups;
    for (const group of kept) group.partial = true;
  }
  return kept.sort(byL);
}

function crossing(db: Database.Database, part: Pick<Term, "forms" | "phrases">, lo: number, hi: number): number[] {
  if (part.phrases.length === 0) return [];
  const phrases = new Set(part.phrases.map((form) => form.join(" ")));
  const any = (forms: readonly string[]) => `(${forms.map(quote).join(" OR ")})`;
  const rest = part.forms.map((form) => form.join(" ")).filter((form) => !phrases.has(form));
  const match = rest.length === 0 ? any([...phrases]) : `${any([...phrases])} NOT ${any(rest)}`;
  const rows = db.prepare(`SELECT f.rowid AS slot, k.app, k.name FROM screen_fts f JOIN screen_row r ON r.slot = f.rowid JOIN screen_key k ON k.id = r.key
    WHERE screen_fts MATCH ? AND f.rowid BETWEEN ? AND ?`).all(match, lo, hi) as { slot: number; app: string; name: string }[];
  counted(rows.length);
  const text = db.prepare("SELECT times, body FROM screen_text WHERE slot = ?");
  const held = (line: string) => {
    const words = tokens(line);
    return part.phrases.some((form) => holds(words, form));
  };
  return rows.filter((row) => {
    if (held(windowOf(row))) return false;
    const body = text.get(row.slot) as { times: Buffer; body: Buffer } | undefined;
    return body === undefined || !unpackText(body.times, body.body).some(({ line }) => held(line));
  }).map((row) => row.slot);
}

function ordered(groups: readonly Group[]): { order: Group[]; forty: number } {
  const top = groups.slice(0, TOP);
  for (const group of top) group.score = group.L - Math.log(1 + (2 * anchored(group)) / SPREAD_MS);
  top.sort((left, right) => right.score - left.score || byL(left, right));
  return { order: [...top, ...groups.slice(TOP)], forty: top.length };
}

function byL(left: Group, right: Group): number {
  return right.L - left.L || keyOrder(left.key, right.key) || (left.day < right.day ? -1 : left.day > right.day ? 1 : 0);
}

function anchored(group: Group): number {
  const matched = [...group.rows.keys()].sort((left, right) => left - right);
  group.rarest = matched[0]!;
  const anchors = group.rows.get(group.rarest)!;
  let best = Infinity;
  let anchor = anchors[0]!;
  for (const slot of anchors) {
    const at = Math.floor(slot / 8);
    let radius = 0;
    for (const term of matched.slice(1)) {
      let nearest = Infinity;
      for (const other of group.rows.get(term)!) nearest = Math.min(nearest, Math.abs(Math.floor(other / 8) - at));
      radius = Math.max(radius, nearest);
    }
    if (radius < best) {
      best = radius;
      anchor = slot;
    }
  }
  group.anchor = anchor;
  return best;
}

function linesHolding(db: Database.Database, slot: number, terms: readonly Term[]): readonly ScreenLine[] {
  return textOf(db, slot).filter(({ line }) => {
    const words = wordsOf(line);
    return terms.some((term) => term.forms.some((form) => holds(words, form)));
  });
}

function textOf(db: Database.Database, slot: number): readonly ScreenLine[] {
  const held = once?.texts.get(slot);
  if (held !== undefined) return held;
  counted(1);
  const text = db.prepare("SELECT times, body FROM screen_text WHERE slot = ?").get(slot) as { times: Buffer; body: Buffer } | undefined;
  const lines = text === undefined ? [] : unpackText(text.times, text.body);
  once?.texts.set(slot, lines);
  return lines;
}

function wordsOf(line: string): readonly string[] {
  const held = once?.words.get(line);
  if (held !== undefined) return held;
  const words = tokens(line);
  once?.words.set(line, words);
  return words;
}

function holds(words: readonly string[], form: readonly string[]): boolean {
  for (let i = 0; i + form.length <= words.length; i++) {
    if (form.every((word, j) => words[i + j] === word)) return true;
  }
  return false;
}

function siblingName(db: Database.Database, group: Group, terms: readonly Term[], keyOf: KeyOf): string | undefined {
  const lines = linesHolding(db, group.anchor, [terms[group.rarest]!]).map(({ line }) => line);
  return lines.length === 0 ? undefined : JSON.stringify([keyOf(group.key).app, group.day, [...new Set(lines)].sort()]);
}

function collapse(db: Database.Database, groups: readonly Group[], terms: readonly Term[], keyOf: KeyOf): { hit: Hit; name?: string }[] {
  const out: { hit: Hit; name?: string }[] = [];
  const bySet = new Map<string, Hit>();
  for (const group of groups) {
    const name = siblingName(db, group, terms, keyOf);
    const held = name === undefined ? undefined : bySet.get(name);
    if (held !== undefined) {
      held.also.push(group);
      continue;
    }
    const hit = { group, also: [] };
    if (name !== undefined) bySet.set(name, hit);
    out.push(name === undefined ? { hit } : { hit, name });
  }
  return out;
}

function keysOf(db: Database.Database): KeyOf {
  const keys = new Map<bigint, KeyNames>();
  const read = db.prepare("SELECT machine, app, site, name FROM screen_key WHERE id = ?");
  return (id) => {
    let key = keys.get(id);
    if (key === undefined) keys.set(id, key = read.get(id) as KeyNames);
    return key;
  };
}

export function windowOf(key: { app: string; name: string }): string {
  return key.name !== "" ? key.name : key.app;
}

function screenHitOf(db: Database.Database, hit: Hit, terms: readonly Term[], keyOf: KeyOf, minute: boolean, evidence: boolean, gate?: ScreenGate): ScreenHit {
  const named = (group: Group) => {
    const { machine, app, site, name } = keyOf(group.key);
    return { machine, app, site, name, day: group.day };
  };
  const also = hit.also.map((other): ScreenSibling => ({ ...named(other), ...(evidence ? proofOf(db, other, terms, keyOf, gate) : {}) }));
  const found = foundOf(db, hit.group, terms, keyOf(hit.group.key), minute, gate);
  return {
    ...named(hit.group), at_ms: found.at_ms, until_ms: found.until_ms, excerpt: found.excerpt, evidence: found.evidence, reason: found.reason, also,
    ...(evidence ? { source: found.line, ...proofOf(db, hit.group, terms, keyOf, gate) } : {}),
  };
}

interface Found {
  at_ms: number;
  until_ms: number | null;
  line: string;
  excerpt: string;
  evidence: string;
  reason: Reason;
}

function foundOf(db: Database.Database, group: Group, terms: readonly Term[], key: KeyNames, findMinute: boolean, gate?: ScreenGate): Found {
  const matched = [...group.rows.keys()].map((i) => terms[i]!);
  const spans = groupSpans(db, group, key.machine, gate);
  const anchorLines = linesHolding(db, group.anchor, matched);
  const anchorSeg = (db.prepare("SELECT seg_ms FROM screen_row WHERE slot = ?").get(group.anchor) as { seg_ms: number }).seg_ms;
  let minute: { ms: number; line: string; evidence: string } | undefined;
  if (findMinute) {
    minute = blockMinute(db, group, terms, key, spans);
    if (minute === undefined && anchorLines.length > 0) {
      const ms = anchorSeg + anchorLines[0]!.tenths * 100;
      minute = { ms, line: anchorLines[0]!.line, evidence: `row:${group.anchor}` };
    }
  }
  const reason: Reason = group.partial ? "partial" : matched.some((term) => term.spelling) ? "spelling" : "words";
  const from = spans[0]?.from_ms ?? Math.floor(group.anchor / 8);
  const to = spans.reduce((most, span) => Math.max(most, span.to_ms), from);
  const line = minute?.line ?? anchorLines[0]?.line ?? windowOf(key);
  return {
    at_ms: minute?.ms ?? from, until_ms: minute === undefined ? to : null,
    line, excerpt: excerptOf(line, matched), evidence: minute?.evidence ?? `row:${group.anchor}`, reason,
  };
}


const CURSOR_FORMAT = 1;
const GIVEN_MOST_HELD = GIVEN_MOST - 1 + TOP + PAGE_HITS;
const WINDOW_BYTES = VARINT_BYTES + 2;

export function cursorText(cursor: ScreenCursor): string {
  return cursorWritten(cursor).text();
}

function cursorBytes(cursor: ScreenCursor): number[] {
  return cursorWritten(cursor).written;
}

function cursorWritten(cursor: ScreenCursor): CursorWriter {
  const out = new CursorWriter();
  const newest = dayNumber(cursor.newest);
  out.put(CURSOR_FORMAT).put(newest).put(newest - dayNumber(cursor.oldest)).put(cursor.upto_ms);
  out.put((cursor.by_day ? 1 : 0) | (cursor.place === undefined ? 0 : 2));
  if (cursor.place !== undefined) out.put(newest - dayNumber(cursor.place.day)).signed(cursor.place.key);
  out.put(cursor.given.length);
  let before: bigint | undefined;
  for (const each of [...cursor.given].sort((one, other) => keyOrder(one.key, other.key) || (one.day < other.day ? 1 : one.day > other.day ? -1 : 0))) {
    if (before === undefined) out.signed(each.key);
    else out.put(each.key - before);
    out.put(newest - dayNumber(each.day));
    before = each.key;
  }
  return out;
}

export function cursorOf(text: string): ScreenCursor {
  const read = new CursorReader(text, "a screen cursor");
  if (read.small() !== CURSOR_FORMAT) throw read.broken();
  const dayAt = (n: number) => {
    if (n < FIRST_DAY || n > LAST_DAY) throw new CursorError("names a day no screen holds");
    return dayOf(n);
  };
  const newest = read.small();
  dayAt(newest);
  const length = read.small();
  if (length >= STRETCH_DAYS) throw new CursorError("names a stretch longer than a stretch");
  const upto_ms = read.small();
  const flags = read.small();
  if (flags > 3) throw read.broken();
  const day = () => {
    const back = read.small();
    if (back > length) throw new CursorError("names a window outside its stretch");
    return dayAt(newest - back);
  };
  let place: ScreenWindow | undefined;
  if ((flags & 2) !== 0) {
    const placeDay = day();
    place = { key: read.signed(), day: placeDay };
  }
  const count = read.small();
  if (count > GIVEN_MOST_HELD) throw new CursorError("holds more windows than a cursor gives");
  const given: ScreenWindow[] = [];
  let before: bigint | undefined;
  for (let n = 0; n < count; n++) {
    before = before === undefined ? read.signed() : read.key(before + read.take());
    given.push({ key: before, day: day() });
  }
  read.end();
  return { newest: dayOf(newest), oldest: dayAt(newest - length), upto_ms, by_day: (flags & 1) === 1, ...(place === undefined ? {} : { place }), given };
}

const FIRST_DAY = dayNumber("0000-01-01");
const LAST_DAY = dayNumber("9999-12-31");

function dayNumber(day: string): number {
  return Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
}

function dayOf(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function blockMinute(
  db: Database.Database, group: Group, terms: readonly Term[], key: KeyNames, spans: readonly { display: string; from_ms: number; to_ms: number }[],
): { ms: number; line: string; evidence: string } | undefined {
  const matched = [...group.rows.keys()].sort((left, right) => left - right).map((i) => terms[i]!);
  const uncommon = matched.filter((term, i) => i === 0 || term.idf >= UNCOMMON_IDF);
  const total = uncommon.reduce((sum, term) => sum + term.idf, 0);
  const blocks = db.prepare(`SELECT b.id, f.body, -bm25(screen_block_fts) AS s FROM screen_block_fts f JOIN screen_block b ON b.id = f.rowid
    WHERE screen_block_fts MATCH @q AND f.rowid BETWEEN (SELECT min(id) FROM screen_block WHERE machine = @m AND day = @d) AND (SELECT max(id) FROM screen_block WHERE machine = @m AND day = @d)
      AND b.machine = @m AND b.day = @d`).all({ q: uncommon.map((term) => term.match).join(" OR "), m: key.machine, d: group.day }) as
    { id: number; body: string; s: number }[];
  counted(blocks.length);
  const runsOf = db.prepare("SELECT display, from_ms, to_ms FROM screen_block_run WHERE block = ? ORDER BY from_ms, display");
  let best: { share: number; s: number; ms: number; line: string; evidence: string } | undefined;
  for (const block of blocks) {
    const words = tokens(block.body);
    const share = uncommon.filter((term) => term.forms.some((form) => holds(words, form))).reduce((sum, term) => sum + term.idf, 0) / total;
    if (share < BLOCK_SHARE) continue;
    let earliest = Infinity;
    const runs = runsOf.all(block.id) as { display: string; from_ms: number; to_ms: number }[];
    counted(runs.length);
    for (const run of runs) {
      for (const span of spans) {
        if (span.display !== run.display || run.from_ms >= span.to_ms || run.to_ms <= span.from_ms) continue;
        earliest = Math.min(earliest, Math.max(run.from_ms, span.from_ms));
      }
    }
    if (earliest === Infinity) continue;
    if (best === undefined || share > best.share || (share === best.share && (block.s > best.s || (block.s === best.s && earliest < best.ms)))) {
      best = { share, s: block.s, ms: earliest, line: block.body, evidence: blockEvidence(key.machine, group.day, block.id) };
    }
  }
  return best === undefined ? undefined : { ms: best.ms, line: best.line, evidence: best.evidence };
}

export function merged(spans: readonly { from_ms: number; to_ms: number }[]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (const span of [...spans].sort((left, right) => left.from_ms - right.from_ms)) {
    const last = out.at(-1);
    if (last !== undefined && span.from_ms <= last.to) last.to = Math.max(last.to, span.to_ms);
    else out.push({ from: span.from_ms, to: span.to_ms });
  }
  return out;
}

export function excerptOf(line: string, terms: readonly { forms: readonly (readonly string[])[] }[]): string {
  const words: { word: string; start: number; end: number }[] = [];
  for (const found of line.matchAll(/[\p{L}\p{N}\p{Co}\p{M}]+/gu)) {
    const word = tokens(found[0]).join("");
    if (word !== "") words.push({ word, start: found.index, end: found.index + found[0].length });
  }
  const marks: { start: number; end: number }[] = [];
  for (let i = 0; i < words.length; i++) {
    for (const term of terms) {
      for (const form of term.forms) {
        if (i + form.length <= words.length && form.every((word, j) => words[i + j]!.word === word)) {
          marks.push({ start: words[i]!.start, end: words[i + form.length - 1]!.end });
        }
      }
    }
  }
  marks.sort((left, right) => left.start - right.start || right.end - left.end);
  const spans: { start: number; end: number }[] = [];
  for (const mark of marks) {
    const last = spans.at(-1);
    if (last !== undefined && mark.start < last.end) last.end = Math.max(last.end, mark.end);
    else spans.push({ ...mark });
  }
  let from = 0;
  let to = line.length;
  if (line.length > EXCERPT_CHARS) {
    const first = spans[0]?.start ?? 0;
    from = Math.max(0, first - Math.floor(EXCERPT_CHARS / 3));
    to = Math.min(line.length, from + EXCERPT_CHARS);
    from = Math.max(0, to - EXCERPT_CHARS);
  }
  let out = from > 0 ? "…" : "";
  let at = from;
  for (const span of spans) {
    if (span.start < from || span.end > to) continue;
    out += `${line.slice(at, span.start)}«${line.slice(span.start, span.end)}»`;
    at = span.end;
  }
  out += line.slice(at, to);
  return to < line.length ? `${out}…` : out;
}

function quote(text: string): string {
  return `"${text.replaceAll('"', '""')}"`;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
