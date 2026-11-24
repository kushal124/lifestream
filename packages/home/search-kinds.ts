import { civilDay, dayBounds, type DaySettings, type RecordRef } from "@lifestreamprotocol/core";
import { LISTENING_FAMILY, PHOTOS_FAMILY, unitFocus } from "@lifestreamprotocol/families";
import type { Call } from "./call.js";
import { collectionsOf, countAskOf, countIn, countLacking, countShown } from "./count.js";
import { PeopleCounts, type CountContext } from "./counting.js";
import { CursorError, CursorWriter, opened, sealed, type CursorReader, type Current, type Params } from "./cursor-text.js";
import { freshMembers, OPEN_FROM, type Fresh } from "./index-file.js";
import {
  countOf, KINDS_SHOWN, type GroupCount, type Kind, type KindsAnswer, type KindsHit, type KindsPage, type KindsParams, type ListeningPage, type MatchedWindow, type RecordPage,
  type ScreenPage, type Sitting, type TopRow, type Track,
} from "./kinds-contract.js";
import type { Presence } from "./presence.js";
import type { Hit, UnitFound } from "./record-search.js";
import { refused, Refusal } from "./refusal.js";
import { cursorOf as screenCursorOf, cursorText as screenCursorText, type ScreenCursor, type WindowGroup } from "./screen-query.js";
import { firstMsOf, MachineSittings, type Sittings } from "./screen-sittings.js";
import { machineSources, screenRoles } from "./screen-source.js";
import { readsSource } from "./sources-read.js";
import { familyOf, type CountResult, type Family, type SearchParams } from "./search-contract.js";
import { timeOf } from "./search-scan.js";
import type { RecordRead, SearchCursor } from "./search-index.js";
import { typedOf, type Read } from "./search-words.js";
import {
  peopleNamed, placesNamed, recordAskOf, recordHitOf, SCREEN_BUILT, SCREEN_WRITTEN, screenGroupsOf, screenHitOf, searchAskedOf, searchPlace, searchPlaceRead, shownAt, whenNamed,
  type RecordAsk, type SearchAsked,
} from "./search-route.js";


const PLAYS = "plays";
const SCREEN = "screen";
const SCREEN_WORD = "Screen";
const SCREEN_PAGE = 20;
const MINUTE_MS = 60_000;
const KIND_PAGE = 40;
const NOT_OURS = "`cursor` is not a next this route gave.";
const STUCK = "Search could not read further just now: try again in a moment.";

const UNREAD_SCREEN: Readonly<Record<string, string>> = {
  [SCREEN_BUILT]: "Screen search is getting ready.",
  [SCREEN_WRITTEN]: "Screen search is busy: try again in a moment.",
};

const UNREAD_PLAYS: Readonly<Record<string, string>> = {
  TOO_BROAD: "Too many plays match to count. Add a word or pick a time.",
  INDEX_BUILDING: "Your plays are being counted again. Try again in a few minutes.",
  NOT_NOW: "Your plays could not be counted just now.",
};

export interface KindsOptions {
  sittings?: (call: Call) => Sittings;
  photo: (record: RecordRef) => string | undefined;
}

type Photo = KindsOptions["photo"];
type Spans = () => Sittings;
type Screened = Exclude<ReturnType<typeof screenGroupsOf>, { unread: string }>;
type Asked = Params<"kinds">;
type Seen = Asked & { see: Family };

interface Seeing {
  asked: Seen;
  place?: CursorReader;
  check?: (current: Current) => void;
}

export function kindsOf(params: KindsParams, call: Call, options: KindsOptions): KindsAnswer | KindsPage {
  const spans = sittingsOf(call, options.sittings ?? ((each) => new MachineSittings(each.view(), machineSources(each.view(), screenRoles(each.families)))));
  const { cursor, ...asked } = params;
  if (cursor !== undefined) return pageOf(seeOpened(cursor, asked), call, spans, options.photo);
  if (asked.query === undefined || asked.query.trim() === "") refused("BAD_PARAMETER", "`query` names the words to find.");
  if (asked.see !== undefined) return pageOf({ asked: asked as Seen }, call, spans, options.photo);
  return firstScreenOf(asked, call, spans, options.photo);
}

function sittingsOf(call: Call, made: (call: Call) => Sittings): Spans {
  let held: Sittings | undefined;
  return () => (held ??= made(call));
}

function wordsAsked(asked: Asked, also: Partial<SearchParams> = {}): SearchAsked {
  const { see: _see, upcoming: _upcoming, ...words } = asked;
  return searchAskedOf({ ...words, ...also, lists: ["record"] } as SearchParams);
}

function firstScreenOf(asked: Asked, call: Call, spans: Spans, photo: Photo): KindsAnswer {
  call.screenIfReady();
  const searched = searchAskedOf({ ...asked, lists: ["record", "screen", "goto"] } as SearchParams);
  const base = recordAskOf(searched, call);
  const { read, words, where, day } = base;
  const persons = peopleNamed(words, base.people, call).slice(0, KINDS_SHOWN);
  const places = placesNamed(words, call).slice(0, KINDS_SHOWN - persons.length);
  const found = read.kinds(kindsQuery(base), { top: KINDS_SHOWN - persons.length - places.length, shown: KINDS_SHOWN }, familyOf);
  call.walked(found.capped);
  const screen = screensOf(spans) ? firstStretchOf(searched, call, found.units.length > 0) : undefined;
  const top: TopRow[] = [
    ...messagesOf(read, call, base, persons).map((messages, at) => ({ person: { ref: persons[at]!.ref, name: persons[at]!.name, ...(messages === undefined ? {} : { messages }) } })),
    ...places.map(({ ref, name, days }) => ({ place: { ref, name, days } })),
    ...found.top.flatMap((hit) => kindsHitOf(hit, where, day, photo)).map((hit) => ({ hit })),
  ];
  const recorded = found.kinds.filter((kind) => kind.family !== SCREEN).map((kind): Kind => ({
    family: kind.family as Exclude<Kind["family"], "listening" | "screen">,
    n: counted(kind.n, found.capped),
    ...(kind.upcoming > 0 ? { upcoming: counted(kind.upcoming, found.upcomingPartial) } : {}),
    hits: kind.hits.flatMap((hit) => kindsHitOf(hit, where, day, photo)),
  }));
  const screened = screen === undefined ? undefined : screenKindOf(base, found.units, found.capped || !found.unitsWhole, screen, spans);
  const today = civilDay(call.now_ms, day);
  const text = words === undefined ? "" : words.terms.filter((term) => !term.negated).map((term) => term.text).join(" ");
  const named = text === "" ? { day: null, month: null } : whenNamed(text.toLowerCase(), today);
  const fresh = call.fresh(read.seq, read.held(base.from_ms === undefined ? OPEN_FROM : civilDay(base.from_ms, day), base.to_ms === undefined ? today : civilDay(base.to_ms - 1, day)));
  const listened = words === undefined ? undefined : listeningKindOf(asked, words, call);
  const kinds = sorted([...recorded, ...[screened, listened].filter((kind) => kind !== undefined)]);
  const sum = kinds.reduce((total, kind) => total + ("n" in kind && kind.n !== undefined ? countOf(kind.n) : 0), 0);
  const partly = kinds.some((kind) => ("unread" in kind && kind.unread !== undefined) || ("n" in kind && kind.n !== undefined && typeof kind.n !== "number"));
  const held = heldWith(found.held, screen !== undefined && "groups" in screen ? screen.groups.groups.map((group) => group.day) : []);
  return {
    ...freshMembers(fresh),
    ...(held === undefined ? {} : { held }),
    total: counted(sum, partly), capped: found.capped,
    ...(found.reached?.at === undefined || found.reached.at === null ? {} : { reached: { side: found.reached.side, at: found.reached.at, whole: found.reached.whole } }),
    ...(named.day === null ? {} : { day: named.day }), ...(named.month === null ? {} : { month: named.month }),
    top, kinds,
  };
}

function screensOf(spans: Spans): boolean {
  return spans().machines().length > 0;
}

function firstStretchOf(asked: SearchAsked, call: Call, lined: boolean): ReturnType<typeof screenGroupsOf> {
  let screen = screenGroupsOf(asked, call);
  while (!lined && "groups" in screen && screen.groups.groups.length === 0 && screen.groups.older !== undefined) screen = screenGroupsOf(asked, call, screen.groups.older);
  return screen;
}

function heldWith(held: { first: string; last: string } | null | undefined, days: readonly string[]): { first: string; last: string } | null | undefined {
  if (held === undefined || days.length === 0) return held;
  const sorted = [...days].sort();
  const [first, last] = [sorted[0]!, sorted.at(-1)!];
  return held === null ? { first, last } : { first: first < held.first ? first : held.first, last: last > held.last ? last : held.last };
}

function kindsQuery(base: RecordAsk): RecordAsk["query"] {
  const { facets: _facets, after: _after, ...query } = base.query;
  return { ...query, order: "relevance", notFamilies: [LISTENING_FAMILY] };
}

function counted(n: number, partial: boolean): GroupCount {
  return partial ? { n, partial: true } : n;
}

function sorted(kinds: Kind[]): Kind[] {
  const size = (kind: Kind) => ("n" in kind && kind.n !== undefined ? countOf(kind.n) : -1);
  return kinds.sort((left, right) => size(right) - size(left) || (left.family < right.family ? -1 : left.family > right.family ? 1 : 0));
}

function kindsHitOf(hit: Hit, where: Presence | undefined, day: DaySettings, photo: Photo): KindsHit[] {
  return (recordHitOf(hit, where, day) as KindsHit[]).map((shown) => {
    const record = hit.layer === "records" ? hit.ref as RecordRef : hit.record;
    const image = shown.family === PHOTOS_FAMILY && record !== undefined ? photo(record) : undefined;
    return image === undefined ? shown : { ...shown, image };
  });
}

function listens(call: Call): boolean {
  const family = call.families.find((each) => each.name === LISTENING_FAMILY);
  return family !== undefined && collectionsOf([family]).has(PLAYS) && call.view().sources().some((row) => readsSource(family, row));
}

interface Plays {
  result: CountResult;
  lacking: number;
}

function playsOf(asked: Asked, words: Read, call: Call, limit: number, cursor?: string): Plays {
  const ask = countAskOf({
    of: PLAYS, words: typedOf(words.terms), ...(words.typing ? { typing: 1 as const } : {}),
    measure: "times", op: "sum", by: ["track", "artist"], order: "value", limit,
    ...(asked.from === undefined ? {} : { from: asked.from }), ...(asked.to === undefined ? {} : { to: asked.to }),
  }, collectionsOf(call.families));
  const answer = countIn(call, cursor === undefined ? ask : { ...ask, cursor }, countLacking("track"));
  return { result: countShown(answer, ask) as CountResult, lacking: answer.lacking };
}

function playsSaid(error: unknown): string {
  const said = error instanceof Refusal ? UNREAD_PLAYS[error.code] : undefined;
  if (said === undefined) throw error;
  return said;
}

function tracksOf(counted: CountResult): Track[] {
  const column = (name: string) => counted.columns.indexOf(name);
  const [track, artist, plays] = [column("track"), column("artist"), column("sum")];
  return counted.rows.flatMap((row): Track[] => {
    const named = row[track], by = row[artist], ref = row.at(-1);
    if (typeof named !== "string" || named === "" || typeof ref !== "string") return [];
    return [{ ref, track: named, ...(typeof by === "string" && by !== "" ? { artist: by } : {}), plays: Number(row[plays]) }];
  });
}

function listeningKindOf(asked: Asked, words: Read, call: Call): Kind | undefined {
  if (!listens(call)) return undefined;
  let plays: Plays;
  try {
    plays = playsOf(asked, words, call, KINDS_SHOWN);
  } catch (error) {
    return { family: LISTENING_FAMILY, unread: playsSaid(error) };
  }
  const n = Number(plays.result.total?.sum ?? 0) - plays.lacking;
  if (n <= 0) return undefined;
  return { family: LISTENING_FAMILY, n, tracks: tracksOf(plays.result) };
}

function messagesOf(read: RecordRead, call: Call, base: RecordAsk, persons: readonly { id: string; handles: readonly string[] }[]): (number | undefined)[] {
  if (persons.length === 0) return [];
  if (read.building() !== null) return persons.map(() => undefined);
  return read.facts((facts) => {
    const context: CountContext = { collections: collectionsOf(call.families), settings: read.clock, now_ms: call.now_ms, people: () => base.people };
    const counts = new PeopleCounts(facts, context, { person: context.collections.has("messages") && facts.people("messages") ? ["messages"] : [], chat: [] });
    return persons.map(({ id, handles }) => counts.reach({ person: id, handles })?.reach.messages?.[0] ?? 0);
  });
}

interface Held {
  unit?: string;
  at_ms: number;
  rank: number;
  slot?: number;
  snippet?: string;
  windows: WindowGroup[];
}

function screenKindOf(base: RecordAsk, units: readonly UnitFound[], unitsPartial: boolean, screen: ReturnType<typeof screenGroupsOf>, spans: Spans): Kind | undefined {
  const listed = "groups" in screen ? screen : undefined;
  const unread = listed === undefined ? saidOf((screen as { unread: string }).unread) : undefined;
  const held = placed(units, listed?.groups.groups ?? [], spans);
  const partial = unitsPartial || unread !== undefined || listed?.groups.older !== undefined;
  if (held.length === 0) return unread === undefined ? undefined : { family: SCREEN, unread };
  const sittings = rowsOf(base, held.sort(byRank).slice(0, KINDS_SHOWN), listed);
  return { family: SCREEN, n: counted(held.length, partial), sittings, ...(unread === undefined ? {} : { unread }) };
}

function saidOf(unread: string): string {
  return UNREAD_SCREEN[unread] ?? `${unread.charAt(0).toUpperCase()}${unread.slice(1)}.`;
}

function placed(units: readonly UnitFound[], groups: readonly WindowGroup[], spans: Spans): Held[] {
  const held = new Map<string, Held>();
  units.forEach((unit, rank) => held.set(unit.unit, { unit: unit.unit, at_ms: firstMsOf(unit.unit), rank, slot: unit.slot, ...(unit.snippet === undefined ? {} : { snippet: unit.snippet }), windows: [] }));
  const runs: Held[] = [];
  groups.forEach((group, order) => {
    const rank = units.length + order;
    const into = new Set<string>();
    let unheld: number | undefined;
    for (const [from_ms, to_ms] of group.spans) {
      const holding = spans().holding(group.machine, group.day, from_ms, to_ms);
      if (holding.length === 0) unheld ??= from_ms;
      for (const sitting of holding) {
        if (into.has(sitting.unit)) continue;
        into.add(sitting.unit);
        const each = held.get(sitting.unit) ?? { unit: sitting.unit, at_ms: sitting.start_ms, rank, windows: [] };
        each.windows.push(group);
        held.set(sitting.unit, each);
      }
    }
    if (unheld !== undefined) runs.push({ at_ms: unheld, rank, windows: [group] });
  });
  return [...held.values(), ...runs];
}

const byRank = (left: Held, right: Held): number => left.rank - right.rank || right.at_ms - left.at_ms;
const newestFirst = (left: Held, right: Held): number => right.at_ms - left.at_ms;

function rowsOf(base: RecordAsk, held: readonly Held[], screen: Screened | undefined): Sitting[] {
  const { read } = base;
  const units = held.flatMap((each) => (each.unit === undefined ? [] : [{ unit: each.unit, first_ms: firstMsOf(each.unit) }]));
  const lines = units.length === 0 ? new Map<string, string>() : read.sittingLines(units);
  const unsaid = held.flatMap((each) => (each.snippet === undefined && each.slot !== undefined ? [each.slot] : []));
  const said = unsaid.length === 0 ? new Map<number, string>() : read.unitsSaid(kindsQuery(base), unsaid);
  const shown = windowsShown(held.flatMap((each) => each.windows.slice(0, KINDS_SHOWN)), screen, base);
  return held.map((each): Sitting => {
    const windows = each.windows.slice(0, KINDS_SHOWN).flatMap((group) => shown.get(group.name) ?? []);
    const at = shownAt(each.at_ms, base.day, base.where);
    const day = civilDay(each.at_ms, base.day);
    const { unit } = each;
    if (unit === undefined) return { at, day, windows: each.windows.length, matched: windows.map(({ window }) => window) };
    const matched = windows.map(({ window, span }) => ({ ...window, focus: unitFocus(unit, span) }));
    const snippet = each.snippet ?? (each.slot === undefined ? undefined : said.get(each.slot));
    const summary = lines.get(unit) || matched[0]?.app || snippet?.replace(/[«»]/gu, "") || SCREEN_WORD;
    return { focus: unitFocus(unit), at, day, summary, ...(snippet === undefined ? {} : { snippet }), windows: each.windows.length, matched };
  });
}

interface WindowShown {
  window: MatchedWindow;
  span: { from_ms: number; to_ms: number };
}

function windowsShown(groups: readonly WindowGroup[], screen: Screened | undefined, base: RecordAsk): Map<string, WindowShown> {
  if (screen === undefined || groups.length === 0) return new Map();
  const chosen = [...new Map(groups.map((group) => [group.name, group])).values()];
  return new Map([...screen.groups.hits(chosen)].map(([name, hit]) => {
    const shown = screenHitOf(hit, screen.clock, base.where);
    const window = { ref: shown.ref, ...(shown.at === undefined ? {} : { at: shown.at }), app: shown.app, title: shown.title, snippet: shown.snippet as string };
    return [name, { window, span: { from_ms: hit.at_ms, to_ms: hit.until_ms ?? hit.at_ms + MINUTE_MS } }];
  }));
}

function seeOpened(cursor: string, beside: Asked): Seeing {
  const held = opened(cursor, ["kinds"], beside);
  if (held.params.see === undefined) refused("BAD_PARAMETER", NOT_OURS);
  return { asked: held.params as Seen, place: held.place, check: held.check };
}

function placeRead<T>(place: CursorReader | undefined, read: (place: CursorReader) => T): T | undefined {
  if (place === undefined) return undefined;
  try {
    const at = read(place);
    place.end();
    return at;
  } catch (error) {
    if (error instanceof CursorError) refused("BAD_PARAMETER", NOT_OURS);
    throw error;
  }
}

function pendingOf(fresh: Fresh | undefined): Omit<ReturnType<typeof freshMembers>, "as_of"> {
  const { as_of: _as_of, ...members } = freshMembers(fresh);
  return members;
}

function pageOf(seeing: Seeing, call: Call, spans: Spans, photo: Photo): KindsPage {
  const { see } = seeing.asked;
  if (see === SCREEN) return screenPageOf(seeing, call, spans);
  if (see === LISTENING_FAMILY) return listeningPageOf(seeing, call);
  return recordPageOf(seeing, call, photo);
}

function recordPageOf(seeing: Seeing, call: Call, photo: Photo): RecordPage {
  const { see, upcoming } = seeing.asked;
  const coming = upcoming === 1;
  const base = recordAskOf(wordsAsked(seeing.asked, { families: [see], order: coming ? "oldest" : "newest", limit: KIND_PAGE }), call);
  const { read, where, day } = base;
  let after = placeRead(seeing.place, searchPlaceRead);
  seeing.check?.({ index: () => read.file });
  const { facets: _facets, after: _after, ...query } = base.query;
  const today_ms = query.today_ms!;
  const from_ms = coming ? Math.max(base.from_ms ?? today_ms, today_ms) : base.from_ms;
  const to_ms = coming ? base.to_ms : Math.min(base.to_ms ?? today_ms, today_ms);
  const span = { from_ms, to_ms };
  const shown = { family: see as RecordPage["family"], ...(coming ? { upcoming: true as const } : {}) };
  if (from_ms !== undefined && to_ms !== undefined && to_ms <= from_ms) return { ...shown, hits: [], next: null };
  let hits: KindsHit[] = [];
  let next: SearchCursor | undefined;
  for (;;) {
    const found = read.search({ ...query, ...span, ...(after === undefined ? {} : { after }) });
    if (!("hits" in found)) throw new Error("a search of hits answered groups");
    call.walked(found.capped === true);
    hits = found.hits.flatMap((hit) => kindsHitOf(hit, where, day, photo));
    next = found.next;
    if (hits.length > 0 || next === undefined) break;
    if (after !== undefined && JSON.stringify(next) === JSON.stringify(after)) refused("NOT_NOW", STUCK);
    after = next;
  }
  const fresh = coming || to_ms === undefined ? undefined
    : call.fresh(read.seq, read.held(from_ms === undefined ? OPEN_FROM : civilDay(from_ms, day), civilDay(to_ms - 1, day)));
  return {
    ...shown, hits,
    next: next === undefined ? null : sealed("kinds", searchPlace(new CursorWriter(), next).written, seeing.asked, { index: read.file }),
    ...pendingOf(fresh),
  };
}

function listeningPageOf(seeing: Seeing, call: Call): ListeningPage {
  const base = recordAskOf(wordsAsked(seeing.asked), call);
  let cursor = placeRead(seeing.place, (place) => place.rest().toString("base64url"));
  seeing.check?.({ index: () => base.read.file });
  const later = cursor !== undefined;
  if (base.words === undefined || !listens(call)) return { family: LISTENING_FAMILY, tracks: [], next: null };
  for (;;) {
    let plays: Plays;
    try {
      plays = playsOf(seeing.asked, base.words, call, KIND_PAGE, cursor);
    } catch (error) {
      const said = playsSaid(error);
      if (later) refused("NOT_NOW", said);
      return { family: LISTENING_FAMILY, unread: said };
    }
    const tracks = tracksOf(plays.result);
    const next = plays.result.next ?? null;
    if (tracks.length > 0 || next === null) {
      const { pending, pending_more } = plays.result;
      return {
        family: LISTENING_FAMILY, tracks,
        next: next === null ? null : sealed("kinds", Buffer.from(next, "base64url"), seeing.asked, { index: base.read.file }),
        ...(pending === undefined || pending.length === 0 ? {} : { pending }), ...(pending_more === undefined ? {} : { pending_more }),
      };
    }
    if (next === cursor) refused("NOT_NOW", STUCK);
    cursor = next;
  }
}

interface PageAt {
  stretch?: ScreenCursor;
  before_ms?: number;
}

const BEFORE = 1;
const STRETCH = 2;

function pageAtRead(place: CursorReader): PageAt {
  const flags = place.small(BEFORE | STRETCH);
  const before_ms = (flags & BEFORE) === 0 ? undefined : place.small();
  const stretch = (flags & STRETCH) === 0 ? undefined : screenCursorOf(place.rest().toString("base64url"));
  return { ...(stretch === undefined ? {} : { stretch }), ...(before_ms === undefined ? {} : { before_ms }) };
}

function placeOf(at: PageAt): number[] {
  const out = new CursorWriter().put((at.before_ms === undefined ? 0 : BEFORE) | (at.stretch === undefined ? 0 : STRETCH));
  if (at.before_ms !== undefined) out.put(at.before_ms);
  return [...out.written, ...(at.stretch === undefined ? [] : Buffer.from(screenCursorText(at.stretch), "base64url"))];
}

interface ScreenStep {
  sittings: Sitting[];
  next?: PageAt;
  unread?: string;
}

function screenPageOf(seeing: Seeing, call: Call, spans: Spans): ScreenPage {
  const asked = wordsAsked(seeing.asked);
  let at = placeRead(seeing.place, pageAtRead) ?? {};
  const ready = call.screenIfReady();
  if (at.stretch !== undefined && typeof ready !== "object") refused("NOT_NOW", saidOf(ready === "none" ? SCREEN_BUILT : SCREEN_WRITTEN));
  const file = typeof ready === "object" ? ready.file : "";
  const lines = recordAskOf(searchAskedOf({ ...asked.params, families: [SCREEN], lists: ["record"] } as SearchParams), call);
  seeing.check?.({ index: () => lines.read.file, screen: () => file });
  if (!screensOf(spans)) return { family: SCREEN, sittings: [], next: null };
  let step = screenStepOf(asked, at, lines, call, spans);
  while (step.sittings.length === 0 && step.next !== undefined) {
    at = step.next;
    step = screenStepOf(asked, at, lines, call, spans);
  }
  const { next } = step;
  return {
    family: SCREEN,
    sittings: step.sittings,
    next: next === undefined ? null : sealed("kinds", placeOf(next), seeing.asked, { index: lines.read.file, ...(next.stretch === undefined ? {} : { screen: file }) }),
    ...(step.unread === undefined ? {} : { unread: step.unread }),
  };
}

function screenStepOf(asked: SearchAsked, at: PageAt, lines: RecordAsk, call: Call, spans: Spans): ScreenStep {
  const params = asked.params;
  const screen = screenGroupsOf(asked, call, at.stretch);
  if (at.stretch !== undefined && "unread" in screen) refused("NOT_NOW", saidOf(screen.unread));
  const listed = "groups" in screen ? screen : undefined;
  const groups = listed?.groups.groups ?? [];
  const older = listed?.groups.older;
  const start_ms = listed === undefined || older === undefined ? undefined : dayBounds(listed.groups.stretch.from, listed.clock).start_ms;
  const kept = (at_ms: number) => (at.before_ms === undefined || at_ms < at.before_ms) && (start_ms === undefined || at_ms >= start_ms);
  const windowed = placed([], groups, spans).filter((each) => kept(each.at_ms)).sort(newestFirst);
  const floor = windowed.length > SCREEN_PAGE ? windowed[SCREEN_PAGE - 1]!.at_ms : undefined;
  const stretch = listed === undefined ? undefined : { ...(older === undefined ? {} : { from: listed.groups.stretch.from }), to: listed.groups.stretch.to };
  const range = stretch === undefined ? lines : recordAskOf(searchAskedOf({ ...params, families: [SCREEN], ...stretch, lists: ["record"] } as SearchParams), call);
  const read = range.read.units(unitsQuery(range, lines.query.to_ms, floor, at.before_ms, spans));
  const units = read.units.filter((unit) => (floor === undefined || firstMsOf(unit.unit) >= floor) && kept(firstMsOf(unit.unit)));
  const found = placed(units, groups, spans).filter((each) => kept(each.at_ms)).sort(newestFirst);
  const cut = read.whole ? undefined : completeFrom(read.units, units, found);
  const all = cut === undefined ? found : found.filter((each) => each.at_ms >= cut);
  const last = all[Math.min(SCREEN_PAGE, all.length) - 1];
  const page = last === undefined ? [] : all.filter((each, n) => n < SCREEN_PAGE || each.at_ms === last.at_ms);
  const here = floor !== undefined || cut !== undefined || page.length < all.length;
  const next: PageAt | undefined = here && last !== undefined ? { ...(listed === undefined ? {} : { stretch: listed.groups.cursor }), before_ms: last.at_ms }
    : older === undefined ? undefined : { stretch: older, before_ms: Math.min(last?.at_ms ?? at.before_ms ?? Infinity, older.upto_ms) };
  const unread = listed === undefined ? saidOf((screen as { unread: string }).unread) : undefined;
  return { sittings: rowsOf(range, page, listed), ...(next === undefined ? {} : { next }), ...(unread === undefined ? {} : { unread }) };
}

function unitsQuery(range: RecordAsk, asked_to: number | undefined, floor: number | undefined, before_ms: number | undefined, spans: Spans): RecordAsk["query"] {
  const query = { ...kindsQuery(range), order: "newest" as const };
  const from_ms = floor === undefined ? query.from_ms : Math.max(query.from_ms ?? floor, floor);
  const to_ms = before_ms === undefined ? query.to_ms : Math.min(spans().reach(civilDay(before_ms, range.day), before_ms), asked_to ?? Infinity);
  return { ...query, ...(from_ms === undefined ? {} : { from_ms }), ...(to_ms === undefined ? {} : { to_ms }) };
}

function completeFrom(read: readonly UnitFound[], kept: readonly UnitFound[], found: readonly Held[]): number | undefined {
  if (read.length === 0) return undefined;
  const line = Math.min(...read.map((unit) => timeOf(unit.slot) ?? -Infinity));
  if (found.some((each) => each.at_ms > line)) return line + 1;
  return kept.length === 0 ? undefined : Math.min(...kept.map((unit) => firstMsOf(unit.unit)));
}
