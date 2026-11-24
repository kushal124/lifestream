import { civilDay, dayBounds, instantIn, type DaySettings } from "@lifestreamprotocol/core";
import { handleOfId, ME, type NameSpan } from "@lifestreamprotocol/families";
import { GIVEN_MOST } from "./cursor-text.js";
import { comboKeys, FACTS_FORMAT } from "./index-layers.js";
import { dayOf, type PlaceStretches, type TimeStretch } from "./presence.js";
import type { RecordRef } from "@lifestreamprotocol/core";
import type { AtomRow, Metered, Named, Passage, RecordRow } from "./search-index.js";
import { ordinalOf } from "./refs.js";
import {
  chatTag, COUNT_SCAN, EDGE_ROWS, FACET_ROWS, GROUP_NAME_ROWS, groupsOf, HIT_ROWS, isTime, partialOf, productsTerm, Scan, SCAN, SCAN_ROWS, slotMs, stretchesOf,
  SUBJECT_KEYS, tagWord, tiered, TIMED, timeOf, TOP, UNTIMED, walked, wholeOf,
  type Allows, type Folded, type PartlyRead, type Reached, type ScanPlan, type Scanned, type SearchCursor, type Walked, type Walker,
} from "./search-scan.js";
import { cutAt, markedIn, NEAR_MOST, phrase, plainOf, plainSnippet, prefixedOf, RECORD_WORDS, snippetAt, spellingsOf, widen, widenable, wordsOfTerms, type Mark, type Term, type Vocabulary, type Words } from "./search-words.js";


export type Layer = "records" | "atoms";
export type Facet = "day" | "month" | "family";
export type Order = "relevance" | "newest" | "oldest";

export interface SearchQuery {
  terms?: readonly Term[] | undefined;
  typing?: boolean | undefined;
  chats?: readonly string[] | undefined;
  places?: PlaceStretches | undefined;
  sender?: ((who: string, handle: string) => boolean) | undefined;
  products?: string[] | undefined;
  notProducts?: string[] | undefined;
  families?: string[] | undefined;
  notFamilies?: string[] | undefined;
  today_ms?: number | undefined;
  forPerson?: boolean | undefined;
  from_ms?: number | undefined;
  to_ms?: number | undefined;
  who?: string[] | undefined;
  order: Order;
  group?: Facet | readonly [Facet] | readonly [Facet, Facet] | undefined;
  facets?: Facet[] | undefined;
  limit: number;
  width?: number | undefined;
  after?: SearchCursor | undefined;
  passages?: boolean | undefined;
  gate?: SearchGate | undefined;
}

export interface SearchGate {
  allows(accounts: string | null, start_ms: number | null, tally: boolean): boolean;
  floorOf(accounts: string | null): number | null | undefined;
  whole(accounts: string, from_ms: number, to_ms: number): boolean | undefined;
  tell(accounts: string, start_ms: number, n: number): void;
}

export interface Hit {
  layer: Layer;
  ref: RecordRef | { day: string; n: number };
  family: string | null;
  record?: RecordRef;
  unit?: string;
  item?: string;
  start_ms: number | null;
  end_ms: number | null;
  dated?: true;
  day: string | null;
  n?: number;
  rev?: string;
  line?: { same: string; m: number };
  title: string;
  product?: string;
  from?: string;
  snippet: string;
  who: string[];
  link?: string;
  chat?: string;
  chat_title?: string;
  picture?: number;
  more?: true;
  passages?: Passage[];
}


export interface Count {
  key: string;
  n: number;
  partial?: true;
}

export interface Grouped {
  key: string | [string, string];
  n: number;
  partial?: true;
}

export type SearchAnswer =
  | {
    hits: Hit[]; total?: number; capped?: boolean; reached?: Reached; continues?: true; facets?: Partial<Record<Facet, Count[]>>; next?: SearchCursor;
    steps?: (SearchCursor | undefined)[]; ended?: true;
    variants?: Record<string, string[]>;
    held?: { first: string; last: string } | null;
    order?: "newest";
  }
  | { groups: Grouped[]; total: number; capped: boolean; reached?: Reached; variants?: Record<string, string[]> };

const DAY_MS = 86_400_000;

export const RECENCY = 0.6;

const COMMON = 4;

const PAGE_READS = 1_000;

const LAYERS = 8;

const CHAT_ROWS = 3;

const FAMILIES_MOST = 1_000;

const TIER = 1_000_000;

const SPELL_ROWS = 4_000;

const DIRECTION = "direction";

interface Plan {
  match: string | undefined;
  range: Range;
  kept: [Named, Set<number>][];
  excluded: Set<number>;
  excludedFamilies?: Set<number>;
  places?: PlaceStretches;
}

type Within = Pick<Plan, "places">;

interface Read {
  words?: Words;
  exact?: Words;
  variants: Record<string, string[]>;
}

interface Range {
  from: number;
  to: number;
}

const ALL_TIME: Range = { from: UNTIMED, to: TOP };

const SAID = "{line text}";
const EVERY = "{title line text who}";

function rangeOf(query: SearchQuery): Range {
  const ends = query.to_ms ?? (query.order === "newest" ? query.today_ms : undefined);
  if (query.from_ms === undefined && query.to_ms === undefined) return { from: UNTIMED, to: ends === undefined ? TOP : slotMs(ends) };
  return { from: query.from_ms === undefined ? TIMED : slotMs(query.from_ms), to: ends === undefined ? TOP : slotMs(ends) };
}

function planRows(query: SearchQuery): number {
  return LAYERS + 1 + (query.families?.length ?? 0) + (query.products?.length ?? 0) + new Set(query.notProducts ?? []).size + new Set(query.notFamilies ?? []).size;
}

function testOf(plan: Plan): { sql: string; params: unknown[] } | undefined {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const [named, ids] of plan.kept) {
    parts.push(`e.${named} IN (${[...ids].map(() => "?").join(", ")})`);
    params.push(...ids);
  }
  if (plan.excluded.size > 0) {
    parts.push(`(e.product IS NULL OR e.product NOT IN (${[...plan.excluded].map(() => "?").join(", ")}))`);
    params.push(...plan.excluded);
  }
  if (plan.excludedFamilies !== undefined && plan.excludedFamilies.size > 0) {
    parts.push(`(e.family IS NULL OR e.family NOT IN (${[...plan.excludedFamilies].map(() => "?").join(", ")}))`);
    params.push(...plan.excludedFamilies);
  }
  return parts.length === 0 ? undefined : { sql: parts.join(" AND "), params };
}

function reachedOf(scan: { capped: boolean; told?: number | undefined; toldTimed?: number | undefined }, side: "newest" | "oldest", query: SearchQuery, settings: DaySettings, span: number): { reached?: Reached; partial?: PartlyRead } {
  if (!scan.capped) return {};
  const { told: stop, toldTimed: lastTimed } = scan;
  const range = daysOf(query, settings);
  const past = stop === undefined || side === "oldest" || stop < TIMED ? stop : stop + span * 1000;
  const whole = past === undefined ? null
    : wholeOf(side, past, settings, range, lastTimed === undefined ? undefined : civilDay(Math.floor(lastTimed / 1000), settings));
  const at = stop === undefined || stop < TIMED ? null : instantIn(Math.floor(stop / 1000), settings.zone);
  return { reached: { side, at, whole }, partial: stop === undefined ? () => true : partialOf(side, stop, whole, range) };
}

function daysOf(query: SearchQuery, settings: DaySettings): { first?: string; last?: string } {
  return {
    ...(query.from_ms === undefined ? {} : { first: civilDay(query.from_ms, settings) }),
    ...(query.to_ms === undefined ? {} : { last: civilDay(query.to_ms - 1, settings) }),
  };
}

function variantsOf(variants: Record<string, string[]>): { variants?: Record<string, string[]> } {
  return Object.keys(variants).length === 0 ? {} : { variants };
}

export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function spans(names: string | null): NameSpan[] {
  return names === null ? [] : JSON.parse(names) as NameSpan[];
}

export function atomPassages(atom: AtomRow): Passage[] {
  return passagesOf([{ text: atom.line, names: spans(atom.names) }, { text: atom.title, names: spans(atom.title_names) }]);
}

export function recordPassages(atoms: readonly AtomRow[], first: RecordRow): Passage[] {
  return passagesOf([
    ...atoms.map((each) => ({ text: each.line, names: spans(each.names) })), { text: first.text, names: [] },
    ...atoms.map((each) => ({ text: each.title, names: spans(each.title_names) })), { text: first.title, names: [] },
  ]);
}

function passagesOf(all: readonly Passage[]): Passage[] {
  const kept = new Map<string, Passage>();
  for (const passage of all) {
    if (passage.text === "") continue;
    const had = kept.get(passage.text);
    if (had === undefined || (had.names.length === 0 && passage.names.length > 0)) kept.set(passage.text, passage);
  }
  return [...kept.values()];
}

function snippetOf(passages: readonly Passage[], marks: readonly Mark[]): string {
  if (marks.length > 0) {
    for (const { text } of passages) {
      const words = markedIn(text, marks);
      if (words.length > 0) return snippetAt(text, words);
    }
  }
  return plainSnippet(passages.find((each) => each.text !== "")?.text ?? "");
}

function shownOf(said: readonly string[], hit: Pick<Hit, "title" | "from" | "family">, marks: readonly Mark[]): string {
  const head = hit.from !== undefined ? `${hit.from}: ` : hit.family === SCREEN ? SUMMARY : undefined;
  const plains = said.map((text) => {
    const plain = plainOf(text);
    return head !== undefined && plain.startsWith(head) ? plain.slice(head.length) : plain;
  }).filter((plain) => plain !== "");
  for (const plain of plains) {
    const words = markedIn(plain, marks);
    if (words.length > 0) return cutAt(plain, words);
  }
  return cutAt(plains[0] ?? plainOf(hit.title), []);
}

function chatOf(found: { chat?: string }, title: string): { chat?: string; chat_title?: string } {
  if (found.chat === undefined) return {};
  return { chat: found.chat, ...(title === "" ? {} : { chat_title: title }) };
}

export function search(on: Metered, query: SearchQuery): SearchAnswer {
  return searchIn(on, query, on.clock);
}

function searchIn(on: Metered, query: SearchQuery, settings: DaySettings): SearchAnswer {
  const read = wordsRead(on, query);
  const within = withinOf(query);
  const plan = within === null ? null : planOf(on, query, read.words, within);
  if (query.group !== undefined) {
    if (plan === null || within === null) return { groups: [], total: 0, capped: false };
    return byGroup(on, query, read, plan, within, typeof query.group === "string" ? [query.group] : query.group, settings);
  }
  if (plan === null || within === null) return { hits: [], total: 0, capped: false };
  return hitsOf(on, query, read, plan, within, settings);
}

function hitsOf(on: Metered, query: SearchQuery, read: Read, plan: Plan, within: Within, settings: DaySettings): SearchAnswer {
  const work = on.work;
  const ranked = query.order === "relevance";
  const newest = query.order !== "oldest";
  const after = query.after;
  const spellings = Object.values(read.variants).reduce((sum, each) => sum + each.length, 0);
  const lookups = planRows(query);
  const room = 3 * lookups + 2 * EDGE_ROWS + FACET_ROWS + Math.min(spellings, NEAR_MOST) * (EDGE_ROWS + lookups) + HIT_ROWS;
  const share = Math.max(0, Math.min(SCAN_ROWS, work.left - room));
  if (after?.kind === "page") {
    const planned = scanPlanOf(on, plan);
    const bounded = after.stop === null ? planned : newest ? { ...planned, from: Math.max(planned.from, after.stop) } : { ...planned, to: Math.min(planned.to, after.stop + 1) };
    const scan = scanOf(on, bounded, { ranked: false, newest, after: after.slot, most: PAGE_READS, rows: share, chunk: query.limit + 1 }, query.gate, true);
    const variants = keptOf(on, query, read.variants, within, HIT_ROWS);
    const page = pageOf(on, () => scan.next(), () => scan.open, query, read, settings, query.limit);
    if (page.exhausted) scan.next();
    const last = page.last?.slot ?? after.slot;
    const next: SearchCursor | undefined = !page.exhausted ? { kind: "page", slot: last, stop: after.stop }
      : scan.end !== "ended" ? { kind: "page", slot: scan.stop ?? last, stop: after.stop }
      : after.stop === null ? undefined : { kind: "scan", slot: after.stop };
    return { hits: page.hits, ...(next === undefined ? {} : { next }), ...variantsOf(variants) };
  }
  if (after?.kind === "rest") return restOf(on, query, read, plan, within, settings, after, share);
  const from = after === undefined ? null : after.kind === "scan" ? after.slot : after.from;
  const given = new Set(after === undefined ? [] : after.given ?? []);
  const scanned = scannedOf(on, query, read, plan, within, from, share, after?.kind === "rank" ? after.today : undefined);
  let candidates = scanned.accepted;
  if (ranked) candidates = [...candidates].sort((left, right) => left.rank - right.rank || right.slot - left.slot);
  if (given.size > 0) candidates = candidates.filter((each) => !given.has(each.slot));
  const side = newest ? "newest" : "oldest";
  const { reached, partial } = reachedOf(scanned, side, query, settings, datedSpanOf(on));
  const facets = after?.kind === "rank" || query.facets === undefined || query.facets.length === 0 ? undefined : countsOf(on, scanned.accepted, query.facets, settings, partial);
  const variants = keptOf(on, query, scanned.variants, within, HIT_ROWS);
  const held = after === undefined && scanned.end === "ended" && scanned.accepted.length === 0 ? heldOf(on, query, read, within, settings) : undefined;
  let taken = 0;
  const limit = ranked ? Math.min(query.width ?? query.limit, Math.max(0, GIVEN_MOST - given.size)) : query.limit;
  const page = pageOf(on, () => candidates[taken++], () => taken < candidates.length, query, read, settings, limit);
  let next: SearchCursor | undefined;
  let stepped: Pick<Extract<SearchAnswer, { hits: Hit[] }>, "steps" | "ended"> = {};
  if (ranked) {
    const stop = scanned.stop ?? from;
    const rankedNext = (now: number[], exhausted: boolean): SearchCursor | undefined => {
      if (exhausted) return scanned.capped ? { kind: "scan", slot: stop, given: now.filter((slot) => stop === null || slot < stop) } : undefined;
      if (now.length >= GIVEN_MOST) return { kind: "rest", place: from, stop: scanned.capped ? stop : null, given: now };
      return { kind: "rank", from, today: scanned.today, given: now };
    };
    const now = [...given, ...page.given];
    next = rankedNext(now, page.exhausted);
    if (query.width !== undefined) {
      stepped = {
        steps: page.pulls.map((pulled, at) => rankedNext([...given, ...page.given.slice(0, at + 1)], pulled >= candidates.length)),
        ...(page.exhausted || now.length >= GIVEN_MOST ? { ended: true as const } : {}),
      };
    }
  } else if (page.exhausted) next = scanned.capped ? { kind: "scan", slot: scanned.stop ?? from } : undefined;
  else if (page.last === undefined) next = after ?? { kind: "scan", slot: from };
  else next = { kind: "page", slot: page.last.slot, stop: scanned.capped ? scanned.stop ?? from : null };
  return {
    hits: page.hits, total: scanned.accepted.length, capped: scanned.capped, ...(reached === undefined ? {} : { reached }),
    ...(after?.kind === "scan" ? { continues: true as const } : {}), ...(facets === undefined ? {} : { facets }),
    ...(next === undefined ? {} : { next }), ...stepped, ...variantsOf(variants), ...(held === undefined ? {} : { held }),
  };
}

function restOf(on: Metered, query: SearchQuery, read: Read, plan: Plan, within: Within, settings: DaySettings, after: Extract<SearchCursor, { kind: "rest" }>, rows: number): SearchAnswer {
  const given = new Set(after.given);
  const planned = scanPlanOf(on, plan);
  const limit = query.width ?? query.limit;
  const scan = scanOf(on, after.stop === null ? planned : { ...planned, from: Math.max(planned.from, after.stop) }, { ranked: false, newest: true, after: after.place, most: PAGE_READS, rows, chunk: limit + 1 }, query.gate, true);
  const variants = keptOf(on, query, read.variants, within, HIT_ROWS);
  const pull = () => {
    for (;;) {
      const row = scan.next();
      if (row === undefined || !given.has(row.slot)) return row;
    }
  };
  const page = pageOf(on, pull, () => scan.open, query, read, settings, limit);
  if (page.exhausted) scan.next();
  const past = (place: number | null) => after.given.filter((slot) => place === null || slot < place);
  const resting = (place: number | null): SearchCursor => ({ kind: "rest", place, stop: after.stop, given: past(place) });
  let next: SearchCursor | undefined;
  if (!page.exhausted || scan.end !== "ended") next = resting((!page.exhausted ? page.last?.slot : scan.stop) ?? after.place);
  else if (after.stop !== null) next = { kind: "scan", slot: after.stop, given: past(after.stop) };
  const stepped = query.width === undefined ? {} : {
    steps: page.given.map((slot, at) => (at === page.given.length - 1 && page.last?.slot === slot ? next : resting(slot))),
    ...(page.exhausted ? { ended: true as const } : {}),
  };
  return { hits: page.hits, order: "newest", ...(next === undefined ? {} : { next }), ...stepped, ...variantsOf(variants) };
}

function scannedOf(
  on: Metered, query: SearchQuery, read: Read, plan: Plan, within: Within, from: number | null, rows: number, todayAt?: number | null,
): Walked & { capped: boolean; variants: Record<string, string[]>; today: number | null } {
  const ranked = query.order === "relevance";
  let scan: Walked;
  let variants = read.variants;
  if (ranked && read.words !== undefined) {
    const work = on.work;
    const began = work.spent;
    const plans = tiersOf(read.words.match, read.exact?.match).map((match) => planOf(on, query, { match, marks: [] }, within, null)!);
    const kept = Math.floor(rows / 8);
    const scans: Scan[] = [];
    let full = false;
    for (const [at, each] of plans.entries()) {
      const left = rows - (work.spent - began) - kept * (plans.length - 1 - at);
      const reached = scans.reduce<number | undefined>((most, walk) => (walk.capped && walk.stop !== undefined ? Math.max(most ?? walk.stop, walk.stop) : most), undefined);
      const planned = scanPlanOf(on, each);
      const room = SCAN - scans.reduce((sum, walk) => sum + walk.accepted.length, 0);
      const walk = scanOf(on, reached === undefined ? planned : { ...planned, from: Math.max(planned.from, reached) }, { ranked, newest: true, after: from, most: Math.max(1, room), rows: left }, query.gate, true);
      walk.drain();
      if (room < 1) {
        full = walk.accepted.length > 0;
        break;
      }
      scans.push(walk);
    }
    const both = tiered(scans);
    both.tiers.forEach((tier, at) => {
      for (const row of tier) row.rank += at * TIER;
    });
    scan = full ? { ...walked(scans.at(-1)!), accepted: both.tiers.flat(), end: "full" } : { ...both, accepted: both.tiers.flat() };
    if (read.exact !== undefined && scans.length < 2) variants = {};
  } else {
    const one = scanOf(on, scanPlanOf(on, plan), { ranked, newest: query.order !== "oldest", after: from, most: SCAN, rows }, query.gate, true);
    one.drain();
    scan = walked(one);
  }
  const { accepted } = scan;
  const found = accepted.reduce((most, each) => Math.max(most, timeOf(each.slot) ?? -Infinity), -Infinity);
  const today = todayAt !== undefined ? todayAt : query.today_ms ?? (found === -Infinity ? null : found);
  if (ranked && today !== null) {
    for (const each of accepted) {
      const ms = timeOf(each.slot);
      each.rank += ms === null ? 0 : RECENCY * Math.log(1 + Math.floor(Math.abs(today - ms) / DAY_MS));
    }
  }
  return { ...scan, capped: scan.end === "full" || scan.end === "out", variants, today };
}

function tiersOf(words: string, exact: string | undefined): string[] {
  const said = (match: string) => `(${SAID} : (${match}))`;
  return [
    said(exact ?? words),
    ...(exact === undefined ? [] : [`${said(words)} NOT ${said(exact)}`]),
    `(${EVERY} : (${words})) NOT ${said(words)}`,
  ];
}

function scanOf(on: Metered, plan: ScanPlan, how: Omit<ConstructorParameters<typeof Scan>[4], "allows">, gate: SearchGate | undefined, tally: boolean): Scan {
  const work = on.work;
  const walk: Walker = <T,>(sql: string, params: readonly unknown[], limit: number) => on.walk<T>(sql, params, limit);
  return new Scan(walk, () => work.spent, (rows) => work.made(rows), plan, { ...how, allows: allowsOf(gate, tally) });
}

function allowsOf(gate: SearchGate | undefined, tally: boolean): Allows | undefined {
  if (gate === undefined) return undefined;
  return (row, matched) => gate.allows(row.accounts ?? null, timeOf(row.slot), tally && matched);
}

function scanPlanOf(on: Metered, plan: Plan): ScanPlan {
  const { from, to } = plan.range;
  const slots = (stretches: readonly TimeStretch[]) => stretches.map(([start, end]) => [start === null ? UNTIMED : slotMs(start), end === null ? TOP : slotMs(end)] as const);
  const placed = plan.places === undefined ? undefined : stretchesOf(slots(plan.places.clock), slots(plan.places.date), from, to);
  const reaching = reachingOf(on, plan.range, plan.places?.date);
  const before = reaching === undefined ? [] : [{ from: reaching.from, to: from, clock: false, date: true, reach: reaching.reach }];
  const stretches = before.length === 0 ? placed : [...before, ...(placed ?? [{ from, to, clock: true, date: true }])];
  return { match: plan.match, from: before[0]?.from ?? from, to, test: testOf(plan), ...(stretches === undefined ? {} : { stretches }) };
}

function reachingOf(on: Metered, range: Range, date?: readonly TimeStretch[]): { from: number; reach: number } | undefined {
  const span = datedSpanOf(on);
  if (span === 0 || range.from <= TIMED) return undefined;
  const startFrom = (ms: number) => {
    const bounds = dayBounds(civilDay(ms, on.clock), on.clock);
    return bounds.start_ms === ms ? ms : bounds.end_ms;
  };
  let reach = startFrom(Math.floor(range.from / 1000));
  if (date !== undefined) {
    const held = date.map(([start, end]) => [start === null ? reach : startFrom(Math.max(start, reach)), end ?? Infinity] as const).find(([at, end]) => at < end);
    if (held === undefined) return undefined;
    reach = held[0];
  }
  if (slotMs(reach) >= range.to) return undefined;
  const from = slotMs(reach - span);
  return from < range.from ? { from, reach } : undefined;
}

function datedSpanOf(on: Metered): number {
  return Number(on.meta("dated_span") ?? 0);
}

function wordsRead(on: Metered, query: SearchQuery): Read {
  if (query.terms === undefined) return { variants: {} };
  const typing = query.typing === true;
  const exact = wordsOfTerms(query.terms);
  if (exact === null) return { variants: {} };
  const found = nearOf(on, query.terms, typing, query.notProducts);
  const variants = Object.fromEntries(Object.entries(found).map(([word, each]) => [word, each.slice(0, NEAR_MOST)]));
  const prefixed = prefixedOf(query.terms, typing) !== undefined;
  if (Object.keys(variants).length === 0 && !prefixed) return { words: exact, variants };
  return { words: wordsOfTerms(widen(query.terms, variants).terms, typing)!, exact, variants };
}

function nearOf(on: Metered, terms: readonly Term[], typing: boolean, notProducts: readonly string[] | undefined): Record<string, string[]> {
  const prefixed = prefixedOf(terms, typing);
  const words: { word: string; prefix: boolean }[] = [];
  for (const term of terms) {
    const word = widenable(term);
    if (word !== undefined && !words.some((each) => each.word === word)) words.push({ word, prefix: term === prefixed });
  }
  const work = on.work;
  const began = work.spent;
  const found: Record<string, string[]> = {};
  words.forEach(({ word, prefix }, at) => {
    const rows = Math.floor((SPELL_ROWS - (work.spent - began)) / (words.length - at));
    const each = candidatesOf(on, word, prefix, notProducts, rows);
    if (each.length > 0) found[word] = each;
  });
  return found;
}

function keptOf(on: Metered, query: SearchQuery, variants: Record<string, string[]>, within: Within, keep = 0): Record<string, string[]> {
  const work = on.work;
  const holds = (spelling: string) => {
    if (work.left - keep < EDGE_ROWS + planRows(query)) return false;
    const plan = planOf(on, query, { match: phrase(spelling), marks: [] }, within);
    return plan !== null && scanOf(on, scanPlanOf(on, plan), { ranked: false, newest: true, most: 1, rows: EDGE_ROWS }, query.gate, false).drain().length > 0;
  };
  return Object.fromEntries(Object.entries(variants).flatMap(([word, spellings]) => {
    const kept = spellings.filter(holds);
    return kept.length === 0 ? [] : [[word, kept] as const];
  }));
}

function candidatesOf(on: Metered, word: string, prefix: boolean, notProducts: readonly string[] | undefined, rows: number): string[] {
  const work = on.work;
  const began = work.spent;
  const products = [...new Set(notProducts ?? [])];
  const holds = (match: string, most: number) => on.walk("SELECT rowid FROM fts WHERE fts MATCH ? LIMIT ?", [products.length === 0 ? match : `(${match}) NOT ${productsTerm(products)}`], most).rows.length;
  const words = (sql: string, params: readonly unknown[], most: number) => on.walk<{ word: string }>(sql, params, most).rows.map((row) => row.word);
  const vocabulary: Vocabulary = {
    held: (form, most, prefixed = false) => holds(`{title line text} : ${phrase(form)}${prefixed ? "*" : ""}`, most),
    has: (each) => on.point("SELECT word FROM skeletons WHERE word = ?", [each]) !== undefined,
    ofSkeleton: (skeleton, most) => words("SELECT word FROM skeletons WHERE skeleton = ? LIMIT ?", [skeleton], most),
    starting: (first, most) => words("SELECT word FROM skeletons WHERE word >= ? AND word < ? ORDER BY word LIMIT ?", [first, String.fromCodePoint(first.codePointAt(0)! + 1)], most),
    left: () => rows - (work.spent - began),
  };
  return spellingsOf(word, vocabulary, RECORD_WORDS.spelling, { prefix });
}

function heldOf(on: Metered, query: SearchQuery, read: Read, within: Within, settings: DaySettings): { first: string; last: string } | null | undefined {
  if (on.work.left < 2 * EDGE_ROWS + planRows(query)) return undefined;
  const plan = planOf(on, { ...query, from_ms: undefined, to_ms: undefined }, read.words, within);
  if (plan === null) return null;
  const timed: Plan = { ...plan, range: { from: TIMED, to: TOP } };
  const edge = (newest: boolean) => {
    const scan = scanOf(on, scanPlanOf(on, timed), { ranked: false, newest, most: 1, rows: EDGE_ROWS }, query.gate, false);
    const row = scan.drain()[0];
    return { row, out: scan.end === "out" };
  };
  const first = edge(false);
  if (first.out) return undefined;
  if (first.row === undefined) return null;
  const last = edge(true);
  if (last.row === undefined) return undefined;
  const day = (row: Scanned) => civilDay(timeOf(row.slot)!, settings);
  return { first: day(first.row), last: day(last.row) };
}

function planOf(on: Metered, query: SearchQuery, words: Words | undefined, within: Within, columns: string | null = EVERY): Plan | null {
  const terms: string[] = [];
  if (words !== undefined) terms.push(columns === null ? words.match : `${columns} : (${words.match})`);
  if (query.who !== undefined) {
    if (query.who.length === 0) return null;
    terms.push(`who : (${query.who.map(phrase).join(" OR ")})`);
  }
  if (query.chats !== undefined) {
    if (query.chats.length === 0) return null;
    terms.push(`tags : (${[...new Set(query.chats.map(chatTag))].join(" OR ")})`);
  }
  const total = on.walk<{ n: number }>("SELECT n FROM names WHERE role = 'layer' LIMIT ?", [], LAYERS).rows.reduce((sum, each) => sum + each.n, 0);
  const kept: [Named, Set<number>][] = [];
  const filter = (role: Named, prefix: string, values: readonly string[] | undefined) => {
    if (values === undefined || values.length === 0) return;
    const named = values.map((value) => on.point<{ id: number; n: number }>("SELECT id, n FROM names WHERE role = ? AND name = ?", [role, value]));
    const n = named.reduce((sum, each) => sum + (each?.n ?? 0), 0);
    if (n * COMMON < total) terms.push(`tags : (${[...new Set(values.map((value) => `${prefix}${tagWord(value)}`))].join(" OR ")})`);
    else kept.push([role, new Set(named.flatMap((each) => (each === undefined ? [] : [each.id])))]);
  };
  filter("family", "f", query.families);
  filter("product", "p", query.products);
  let match = terms.length === 0 ? undefined : terms.join(" AND ");
  const leftOut = (role: Named, values: readonly string[] | undefined, term: (values: readonly string[]) => string): Set<number> => {
    const left = [...new Set(values ?? [])];
    const ids = new Set<number>();
    if (left.length > 0 && match !== undefined) match = `(${match}) NOT ${term(left)}`;
    else for (const value of left) {
      const id = on.point<{ id: number }>("SELECT id FROM names WHERE role = ? AND name = ?", [role, value])?.id;
      if (id !== undefined) ids.add(id);
    }
    return ids;
  };
  const excluded = leftOut("product", query.notProducts, productsTerm);
  const excludedFamilies = leftOut("family", query.notFamilies, (families) => `tags : (${families.map((family) => `f${tagWord(family)}`).join(" OR ")})`);
  return { match, range: rangeOf(query), kept, excluded, ...(excludedFamilies.size === 0 ? {} : { excludedFamilies }), ...within };
}

function withinOf(query: SearchQuery): Within | null {
  const places = query.places;
  if (places === undefined) return {};
  return places.clock.length === 0 && places.date.length === 0 ? null : { places };
}

function byGroup(on: Metered, query: SearchQuery, read: Read, plan: Plan, within: Within, by: readonly Facet[], settings: DaySettings): SearchAnswer {
  const work = on.work;
  const variants = keptOf(on, query, read.variants, within);
  const side = query.order === "oldest" ? "oldest" : "newest";
  const scan = scanOf(on, scanPlanOf(on, plan), { ranked: false, newest: side === "newest", most: COUNT_SCAN, rows: Math.max(0, work.left - GROUP_NAME_ROWS) }, query.gate, true);
  const matches = scan.drain();
  const { reached, partial } = reachedOf(scan, side, query, settings, datedSpanOf(on));
  const { groups, cut } = orderedOf(on, groupsOf(matches, by, settings, partial), by);
  return { groups, total: matches.length, capped: scan.capped || cut, ...(reached === undefined ? {} : { reached }), ...variantsOf(variants) };
}

function orderedOf(on: Metered, counted: readonly Folded[], by: readonly Facet[]): { groups: Grouped[]; cut: boolean } {
  const work = on.work;
  const names = new Map<number, string>();
  const name = (id: number): string | undefined => {
    const known = names.get(id);
    if (known !== undefined || !work.reserve(1)) return known;
    const spelled = on.point<{ name: string }>("SELECT name FROM names WHERE id = ?", [id])?.name ?? "";
    names.set(id, spelled);
    return spelled;
  };
  type Value = { value: string | number; n: number; partial?: true };
  const inOrder = <T extends Value>(key: Facet, values: T[]): (T & { key: string })[] | undefined => {
    const named: (T & { key: string })[] = [];
    for (const each of values) {
      const shown = isTime(key) ? each.value as string : name(each.value as number);
      if (shown === undefined) return undefined;
      named.push({ ...each, key: shown });
    }
    return named.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  };
  const [first, second] = by as [Facet, Facet | undefined];
  const firsts = new Map<string | number, Value & { pairs: Value[] }>();
  for (const { values, n, partial } of counted) {
    const each = firsts.get(values[0]!) ?? { value: values[0]!, n: 0, pairs: [] };
    each.n += n;
    if (second === undefined) {
      if (partial === true) each.partial = true;
    } else each.pairs.push({ value: values[1]!, n, ...(partial === true ? { partial } : {}) });
    firsts.set(values[0]!, each);
  }
  const ordered = inOrder(first, [...firsts.values()]);
  if (ordered === undefined) return { groups: [], cut: true };
  if (second === undefined) return { groups: ordered.map(({ key, n, partial }) => ({ key, n, ...(partial === true ? { partial } : {}) })), cut: false };
  const groups: Grouped[] = [];
  for (const each of ordered) {
    const pairs = inOrder(second, each.pairs);
    if (pairs === undefined) return { groups, cut: true };
    for (const pair of pairs) groups.push({ key: [each.key, pair.key], n: pair.n, ...(pair.partial === true ? { partial: true as const } : {}) });
  }
  return { groups, cut: false };
}

function pageOf(
  on: Metered, pull: () => Scanned | undefined, more: () => boolean, query: SearchQuery, words: Read, settings: DaySettings, limit: number,
): { hits: Hit[]; given: number[]; pulls: number[]; last?: Scanned; exhausted: boolean } {
  const work = on.work;
  const hits: Hit[] = [];
  const given: number[] = [];
  const pulls: number[] = [];
  const marks = words.words?.marks ?? [];
  let last: Scanned | undefined;
  const ended = (exhausted: boolean) => ({ hits, given, pulls, ...(last === undefined ? {} : { last }), exhausted });
  for (let read = 0; read < PAGE_READS && hits.length < limit; read++) {
    const candidate = pull();
    if (candidate === undefined) return ended(true);
    if (!work.reserve(HIT_ROWS)) return ended(false);
    last = candidate;
    const found = hitOf(on, candidate.slot, query, settings);
    if (found === undefined) continue;
    given.push(candidate.slot);
    pulls.push(read + 1);
    const snippet = query.forPerson === true ? shownOf(found.said, found.hit, marks) : snippetOf(found.passages, marks);
    hits.push({ ...found.hit, snippet, ...(query.passages === true ? { passages: found.passages } : {}) });
  }
  return ended(!more());
}

function hitOf(on: Metered, slot: number, query: SearchQuery, settings: DaySettings): { hit: Omit<Hit, "snippet" | "passages">; passages: Passage[]; said: string[] } | undefined {
  const work = on.work;
  const began = work.spent;
  const rest = () => HIT_ROWS - (work.spent - began);
  const left = () => rest() - CHAT_ROWS;
  const entry = on.point<{ head: number; product: number | null }>("SELECT head, product FROM entries WHERE slot = ?", [slot]);
  if (entry === undefined) return undefined;
  const { head } = entry;
  const product = entry.product === null ? undefined : on.point<{ name: string }>("SELECT name FROM names WHERE id = ?", [entry.product])?.name;
  const producted = { ...(product === undefined ? {} : { product }) };
  if (head < 0) {
    const atom = on.point<AtomRow>("SELECT * FROM atoms WHERE id = ?", [-head]);
    if (atom === undefined) return undefined;
    const record = atom.source !== null && atom.kind !== null && atom.key !== null ? { source: atom.source, kind: atom.kind, key: atom.key } : undefined;
    const rev = on.point<{ inputs: string }>("SELECT inputs FROM days WHERE day = ?", [atom.day])?.inputs;
    const m = ordinalOf(on, atom.day, atom.same, atom.n);
    const stated = keysAt(on, atom, query, rest());
    const chat = atom.chat !== null ? { chat: atom.chat, whole: stated.whole } : { ...(stated.chat === undefined ? {} : { chat: stated.chat }), whole: stated.whole };
    return {
      hit: {
        layer: "atoms", ref: { day: atom.day, n: atom.n }, family: atom.family, ...(record === undefined ? {} : { record }), unit: atom.unit,
        ...(atom.item === null ? {} : { item: atom.item }), start_ms: atom.start_ms, end_ms: atom.end_ms, ...(atom.dated === 1 ? { dated: true } : {}), day: atom.day,
        ...(rev === undefined || rev === "" ? {} : { rev }), line: { same: atom.same, m },
        title: atom.title, ...producted, ...senderOf(atom, query, stated.sent), who: [], ...chatOf(chat, atom.title), ...(atom.pictures === null ? {} : { picture: atom.pictures }), ...(chat.whole ? {} : { more: true as const }),
      },
      passages: atomPassages(atom),
      said: [atom.line],
    };
  }
  const first = on.point<RecordRow>("SELECT * FROM records WHERE id = ?", [head]);
  if (first === undefined) return undefined;
  const copies = on.walk<RecordRow>("SELECT * FROM records WHERE account = ? AND kind = ? AND key = ? AND hash = ? ORDER BY id LIMIT ?", [first.account, first.kind, first.key, first.hash], Math.max(1, left() - 2));
  let more = copies.more;
  const atoms: AtomRow[] = [];
  for (const copy of copies.rows) {
    if (left() < 2) {
      more = true;
      break;
    }
    const printed = on.walk<AtomRow>("SELECT * FROM atoms WHERE source = ? AND kind = ? AND key = ? LIMIT ?", [copy.source, copy.kind, copy.key], left() - 1);
    atoms.push(...printed.rows);
    if (printed.more) more = true;
  }
  atoms.sort((left, right) => (left.day < right.day ? -1 : left.day > right.day ? 1 : left.n - right.n));
  const atom = atoms[0];
  const stated = atom === undefined ? { whole: true } : keysAt(on, atom, query, rest());
  const chat = atom === undefined ? { whole: true } : atom.chat !== null ? { chat: atom.chat, whole: stated.whole } : { ...(stated.chat === undefined ? {} : { chat: stated.chat }), whole: stated.whole };
  if (!chat.whole) more = true;
  return {
    hit: {
      layer: "records", ref: { source: first.source, kind: first.kind, key: first.key }, family: first.family,
      start_ms: first.start_ms, end_ms: first.end_ms, ...(first.dated === 1 ? { dated: true } : {}),
      day: dayOf(first.start_ms, first.dated === 1, settings) ?? atom?.day ?? null,
      ...(atom === undefined ? {} : { n: atom.n, unit: atom.unit }),
      title: first.title !== "" ? first.title : atom?.title ?? "", ...producted, ...(atom === undefined ? {} : senderOf(atom, query, stated.sent)),
      who: [...new Set(copies.rows.flatMap((copy) => copy.who === "" ? [] : copy.who.split(" ")))],
      ...(first.link === null ? {} : { link: first.link }),
      ...chatOf(chat, atom?.title ?? ""),
      ...(atom?.pictures == null ? {} : { picture: atom.pictures }),
      ...(more ? { more: true as const } : {}),
    },
    passages: recordPassages(atoms, first),
    said: [...atoms.map((each) => each.line), first.text],
  };
}

function fromOf(atom: AtomRow, sender: SearchQuery["sender"]): { from?: string } {
  if (atom.sender === null) return {};
  const handles = atom.sender.split("\x1e");
  const named = spans(atom.names).find((span) => handles.some((handle) => span.who === handle || sender?.(span.who, handle) === true));
  const words = named === undefined ? "" : atom.line.slice(named.start, named.end).trim();
  return words === "" ? {} : { from: words };
}

function senderOf(atom: AtomRow, query: SearchQuery, sent: boolean | undefined): { from?: string } {
  if (query.forPerson !== true) return fromOf(atom, query.sender);
  if (sent === true) return { from: ME };
  const named = fromOf(atom, query.sender);
  if (named.from !== undefined || atom.sender === null) return named;
  const line = atom.line.toLowerCase();
  for (const handle of atom.sender.split("\x1e")) {
    const value = handleOfId(handle)?.value ?? handle;
    const at = value === "" ? -1 : line.indexOf(value.toLowerCase());
    if (at >= 0) return { from: atom.line.slice(at, at + value.length) };
  }
  return {};
}

function keysAt(on: Metered, atom: AtomRow, query: SearchQuery, rows: number): { chat?: string; sent?: boolean; whole: boolean } {
  const wanted = [...(atom.chat === null ? [SUBJECT_KEYS[0]] : []), ...(query.forPerson === true ? [DIRECTION] : [])];
  if (wanted.length === 0 || on.meta("facts_format") !== FACTS_FORMAT) return { whole: true };
  const work = on.work;
  const began = work.spent;
  const found = new Map<string, string>();
  const said = (whole: boolean) => ({
    ...(found.has(SUBJECT_KEYS[0]) ? { chat: found.get(SUBJECT_KEYS[0])! } : {}),
    ...(found.has(DIRECTION) ? { sent: found.get(DIRECTION) === "sent" } : {}), whole,
  });
  let after = -1;
  for (let step = 1; ; step = Infinity) {
    const limit = Math.min(step, Math.floor((rows - (work.spent - began) - 1) / (2 + wanted.length)));
    if (limit < 1) return said(false);
    const facts = on.walk<{ fid: number }>("SELECT fid FROM fact_line WHERE day = ? AND atom = ? AND fid > ? LIMIT ?", [atom.day, atom.n, after], limit);
    for (const { fid } of facts.rows) {
      const keys = comboKeys(on.point<{ keys: string }>("SELECT c.keys FROM fact f JOIN combos c ON c.id = f.combo WHERE f.fid = ?", [fid])?.keys ?? "");
      for (const key of wanted) {
        if (found.has(key)) continue;
        const name = keys.find(([each]) => each === key)?.[1];
        const value = name === undefined ? undefined : on.point<{ name: string }>("SELECT name FROM names WHERE id = ?", [name])?.name;
        if (value !== undefined) found.set(key, value);
      }
      if (wanted.every((key) => found.has(key))) return said(true);
    }
    if (!facts.more) return said(true);
    const last = facts.rows.at(-1);
    if (last === undefined) return said(false);
    after = last.fid;
  }
}

function countsOf(on: Metered, scanned: readonly Scanned[], by: readonly Facet[], settings: DaySettings, partial: PartlyRead | undefined): Partial<Record<Facet, Count[]>> {
  const answer: Partial<Record<Facet, Count[]>> = {};
  for (const facet of by) answer[facet] = orderedOf(on, groupsOf(scanned, [facet], settings, partial), [facet]).groups as Count[];
  return answer;
}

export interface KindsShape {
  top: number;
  shown: number;
}

export interface KindFound {
  family: string;
  n: number;
  upcoming: number;
  hits: Hit[];
}

export interface UnitFound {
  unit: string;
  day: string;
  slot: number;
  snippet?: string;
}

export interface KindsFound {
  top: Hit[];
  kinds: KindFound[];
  units: UnitFound[];
  unitsWhole: boolean;
  capped: boolean;
  upcomingPartial: boolean;
  reached?: Reached;
  held?: { first: string; last: string } | null;
}

const SCREEN = "screen";
const UNIT_ROWS = 3;
const UNITS_SHARE = 2;

export function kinds(on: Metered, query: SearchQuery, shape: KindsShape, familyOf: (stored: string) => string): KindsFound {
  const settings = on.clock;
  const work = on.work;
  const read = wordsRead(on, query);
  const within = withinOf(query);
  const plan = within === null ? null : planOf(on, query, read.words, within);
  if (plan === null || within === null) return { top: [], kinds: [], units: [], unitsWhole: true, capped: false, upcomingPartial: false };
  const room = 3 * planRows(query) + 4 * EDGE_ROWS + HIT_ROWS * (shape.top + shape.shown * 13);
  const scanned = scannedOf(on, query, read, plan, within, null, Math.max(0, Math.min(SCAN_ROWS, work.left - room)));
  const names = new Map<number | null, string | undefined>();
  const familyAt = (id: number | null): string | undefined => {
    if (!names.has(id)) {
      const stored = id === null ? undefined : on.point<{ name: string }>("SELECT name FROM names WHERE id = ?", [id])?.name;
      names.set(id, stored === undefined ? undefined : familyOf(stored));
    }
    return names.get(id);
  };
  const today = query.today_ms === undefined ? undefined : slotMs(query.today_ms);
  const counted = new Map<string, KindFound>();
  for (const row of scanned.accepted) {
    const family = familyAt(row.family);
    if (family === undefined) continue;
    const kind = counted.get(family) ?? { family, n: 0, upcoming: 0, hits: [] };
    kind.n++;
    if (today !== undefined && row.slot >= today) kind.upcoming++;
    counted.set(family, kind);
  }
  const ranked = [...scanned.accepted].sort((left, right) => left.rank - right.rank || right.slot - left.slot);
  const marks = read.words?.marks ?? [];
  const shown = (found: NonNullable<ReturnType<typeof hitOf>>): Hit => ({ ...found.hit, snippet: shownOf(found.said, found.hit, marks) });
  const top: Hit[] = [];
  const open = () => top.length < shape.top || [...counted.values()].some((kind) => kind.family !== SCREEN && kind.hits.length < Math.min(shape.shown, kind.n));
  for (const row of ranked) {
    if (!open()) break;
    const family = familyAt(row.family);
    if (family === undefined || family === SCREEN) continue;
    const kind = counted.get(family)!;
    if (top.length >= shape.top && kind.hits.length >= shape.shown) continue;
    if (!work.reserve(HIT_ROWS)) break;
    const found = hitOf(on, row.slot, query, settings);
    if (found === undefined) continue;
    (top.length < shape.top ? top : kind.hits).push(shown(found));
  }
  const share = Math.floor(Math.max(0, work.left - FOLLOWS_UNITS - planRows(query)) / UNITS_SHARE);
  const { units, whole: unitsWhole } = unitsOf(on, ranked.filter((row) => familyAt(row.family) === SCREEN), share, (slot, at) => {
    const found = at < shape.shown && work.reserve(HIT_ROWS) ? hitOf(on, slot, query, settings) : undefined;
    return found === undefined ? undefined : shown(found).snippet;
  });
  const { reached } = reachedOf(scanned, "newest", query, settings, datedSpanOf(on));
  const { notFamilies: _notFamilies, ...every } = query;
  const held = heldOf(on, every, read, within, settings);
  return {
    top, kinds: [...counted.values()], units, unitsWhole, capped: scanned.capped,
    upcomingPartial: scanned.capped && today !== undefined && (scanned.stop ?? TOP) >= today,
    ...(reached === undefined ? {} : { reached }), ...(held === undefined ? {} : { held }),
  };
}

function unitsOf(on: Metered, ranked: readonly Scanned[], rows: number, said: (slot: number, at: number) => string | undefined): { units: UnitFound[]; whole: boolean } {
  const units: UnitFound[] = [];
  const seen = new Set<string>();
  const began = on.work.spent;
  for (const row of ranked) {
    if (on.work.spent - began + UNIT_ROWS > rows || !on.work.reserve(UNIT_ROWS)) return { units, whole: false };
    const placed = unitOfSlot(on, row.slot);
    if (placed === undefined || seen.has(placed.unit)) continue;
    seen.add(placed.unit);
    const snippet = said(row.slot, units.length);
    units.push({ ...placed, slot: row.slot, ...(snippet === undefined ? {} : { snippet }) });
  }
  return { units, whole: true };
}

export function sittingUnits(on: Metered, query: SearchQuery): { units: UnitFound[]; whole: boolean } {
  const read = wordsRead(on, query);
  const within = withinOf(query);
  const plan = within === null ? null : planOf(on, query, read.words, within);
  if (plan === null || within === null) return { units: [], whole: true };
  const scanned = scannedOf(on, query, read, plan, within, null, Math.max(0, Math.min(SCAN_ROWS, on.work.left - 3 * planRows(query) - 4 * EDGE_ROWS)));
  const ordered = [...scanned.accepted].sort(query.order === "relevance" ? (left, right) => left.rank - right.rank || right.slot - left.slot : (left, right) => right.slot - left.slot);
  const { units, whole } = unitsOf(on, ordered, on.work.left, () => undefined);
  return { units, whole: whole && !scanned.capped };
}

export function unitsSaid(on: Metered, query: SearchQuery, slots: readonly number[]): Map<number, string> {
  const marks = wordsRead(on, query).words?.marks ?? [];
  const said = new Map<number, string>();
  for (const slot of slots) {
    if (!on.work.reserve(HIT_ROWS)) break;
    const found = hitOf(on, slot, query, on.clock);
    if (found !== undefined) said.set(slot, shownOf(found.said, found.hit, marks));
  }
  return said;
}

function unitOfSlot(on: Metered, slot: number): { unit: string; day: string } | undefined {
  const head = on.point<{ head: number }>("SELECT head FROM entries WHERE slot = ?", [slot])?.head;
  if (head === undefined) return undefined;
  if (head < 0) return on.point<{ unit: string; day: string }>("SELECT unit, day FROM atoms WHERE id = ?", [-head]);
  const record = on.point<{ source: string; kind: string; key: string }>("SELECT source, kind, key FROM records WHERE id = ?", [head]);
  return record === undefined ? undefined : on.walk<{ unit: string; day: string }>("SELECT unit, day FROM atoms WHERE source = ? AND kind = ? AND key = ? LIMIT ?", [record.source, record.kind, record.key], 1).rows[0];
}

const SUMMARY = "Summary: ";
const AT_START = 8;
export const SITTING_ROWS = 2 * AT_START + 1;
const FOLLOWS_UNITS = 2 * EDGE_ROWS + 3 * (SITTING_ROWS + HIT_ROWS);

export function sittingLines(on: Metered, units: readonly { unit: string; first_ms: number }[]): Map<string, string> {
  const lines = new Map<string, string>();
  for (const { unit, first_ms } of units) {
    const from = slotMs(first_ms);
    const heads = on.walk<{ head: number }>("SELECT head FROM entries WHERE slot >= ? AND slot < ? LIMIT ?", [from, from + 1000], AT_START).rows;
    let first: string | undefined;
    for (const { head } of heads) {
      if (head >= 0) continue;
      const atom = on.point<{ unit: string; line: string }>("SELECT unit, line FROM atoms WHERE id = ?", [-head]);
      if (atom === undefined || atom.unit !== unit) continue;
      if (atom.line.startsWith(SUMMARY)) {
        first = atom.line.slice(SUMMARY.length);
        break;
      }
      first ??= atom.line;
    }
    if (first !== undefined) lines.set(unit, first);
  }
  return lines;
}

export function families(on: Metered, leftOut: readonly string[], gate?: SearchGate): { family: string; first?: string }[] {
  const settings = on.clock;
  const left = [...new Set(leftOut)];
  const matchOf = (family: string) => `tags : f${tagWord(family)}${left.length === 0 ? "" : ` NOT ${productsTerm(left)}`}`;
  const from1970 = rangeOf({ order: "oldest", limit: 1, from_ms: dayBounds("1970-01-01", settings).start_ms });
  const oldest = (match: string, range: Range) => scanOf(on, scanPlanOf(on, { match, range, kept: [], excluded: new Set() }), { ranked: false, newest: false, most: 1, rows: EDGE_ROWS, chunk: 1 }, gate, false).drain()[0];
  const held = on.walk<{ name: string; n: number }>("SELECT name, n FROM names WHERE role = 'family' ORDER BY name LIMIT ?", [], FAMILIES_MOST).rows;
  return held.filter(({ n }) => n > 0).flatMap(({ name: family }) => {
    const first = oldest(matchOf(family), from1970);
    if (first !== undefined) return [{ family, first: civilDay(timeOf(first.slot)!, settings) }];
    return oldest(matchOf(family), ALL_TIME) === undefined ? [] : [{ family }];
  });
}
