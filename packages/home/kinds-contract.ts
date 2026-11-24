import {
  bool, cursor, day, either, family, FAMILIES, held, instant, int, list, month, nullable, object, oneOf, pending, reached, ref, rule, tagged, text, when, type Family, type Of,
} from "./search-contract.js";

const words = text();
const label = text(undefined, undefined, "label");
const name = text(undefined, undefined, "name");
const excerpt = text(undefined, undefined, "excerpt");
const term = text(undefined, undefined, "term");
const picture = text(undefined, undefined, "picture");

export const KINDS_SHOWN = 3;

type RecordFamily = Exclude<Family, "listening" | "screen">;
const RECORD_FAMILIES = FAMILIES.filter((each): each is RecordFamily => each !== "listening" && each !== "screen");
const isRecordFamily = (see: string | undefined): see is RecordFamily => (RECORD_FAMILIES as readonly (string | undefined)[]).includes(see);
const fresh = { pending, pending_more: int(1) };

export const kindsParams = rule(object({}, {
  query: term,
  from: when,
  to: when,
  typing: oneOf(1),
  see: family,
  upcoming: oneOf(1),
  cursor,
}), asked => (asked.cursor !== undefined ? (Object.keys(asked).length > 1 ? "a `cursor` comes alone: it holds its page's words, time and kind" : null)
  : asked.upcoming !== undefined && !isRecordFamily(asked.see) ? "`upcoming` asks a record kind's coming entries, beside its `see`"
  : null));
export type KindsParams = Of<typeof kindsParams>;

export const groupCount = either(int(), object({ n: int(), partial: oneOf(true) }));
export type GroupCount = Of<typeof groupCount>;
export const countOf = (group: GroupCount): number => (typeof group === "number" ? group : group.n);
export const partialOf = (group: GroupCount): boolean => typeof group !== "number";

export const kindsHit = rule(object({ ref, family }, {
  day,
  at: instant,
  product: words,
  title: words,
  from: name,
  snippet: excerpt,
  chat: ref,
  chat_title: name,
  the_user_was_at: words,
  picture: int(1),
  image: picture,
  rev: label,
  more: oneOf(true),
}), hit => (hit.at !== undefined && hit.day === undefined ? "a hit with `at` states its `day`"
  : hit.image !== undefined && hit.family !== "photos" ? "only a photo's hit states its `image`"
  : null));
export type KindsHit = Of<typeof kindsHit>;

export const track = rule(object({ ref, track: words, plays: int(1) }, { artist: words }), row => (row.track === "" ? "a track names its `track`" : null));
export type Track = Of<typeof track>;

const sittingFocus = text(/^u:\S.*\/\d+$/su, "a sitting's focus, u:<source>/<first_ms>", "label");
const windowFocus = text(/^u:\S.*\/\d+@\d+-\d+$/su, "a window's focus, its sitting's u:<source>/<first_ms>@<from_ms>-<to_ms>", "label");

export const matchedWindow = object({ ref, app: label, title: words, snippet: excerpt }, { at: instant, focus: windowFocus });
export type MatchedWindow = Of<typeof matchedWindow>;

export const sitting = rule(object({ at: instant, day, windows: int(), matched: list(matchedWindow, 0, KINDS_SHOWN) }, {
  focus: sittingFocus,
  summary: words,
  snippet: excerpt,
}), row => ((row.focus === undefined) !== (row.summary === undefined) ? "a sitting's `focus` and its `summary` go together"
  : row.matched.length > row.windows ? "a sitting shows no more windows than its `windows`"
  : row.focus === undefined && (row.matched.length === 0 || row.snippet !== undefined) ? "a run no sitting holds yet is its matched windows alone"
  : row.matched.some((window) => (row.focus === undefined ? window.focus !== undefined : !window.focus?.startsWith(`${row.focus}@`)))
    ? "a sitting's window opens within its sitting, a run's window nowhere of its own"
  : null));
export type Sitting = Of<typeof sitting>;

const inOrder = (rows: readonly { at?: string }[], soonest = false): boolean => {
  const times = rows.flatMap(row => (row.at === undefined ? [] : [Date.parse(row.at)]));
  return times.every((at, i) => i === 0 || (soonest ? times[i - 1]! <= at : times[i - 1]! >= at));
};
const mostPlayed = (tracks: readonly Track[]): boolean => tracks.every((each, i) => i === 0 || tracks[i - 1]!.plays >= each.plays);

const recordKind = rule(object({ family: oneOf(...RECORD_FAMILIES), n: groupCount, hits: list(kindsHit, 0, KINDS_SHOWN) }, { upcoming: groupCount }), kind =>
  kind.hits.some(hit => hit.family !== kind.family) ? "a kind's hits are of its family"
    : kind.upcoming !== undefined && (countOf(kind.upcoming) < 1 || countOf(kind.upcoming) > countOf(kind.n)) ? "`upcoming` is 1 to the kind's `n`, stated only when more than 0"
    : null);

const listeningKind = either(
  rule(object({ family: oneOf("listening"), n: groupCount, tracks: list(track, 0, KINDS_SHOWN) }),
    kind => (mostPlayed(kind.tracks) ? null : "tracks come most played first")),
  object({ family: oneOf("listening"), unread: label }),
);

const screenKind = rule(object({ family: oneOf("screen") }, { n: groupCount, sittings: list(sitting, 0, KINDS_SHOWN), unread: label }), kind =>
  kind.n === undefined ? (kind.sittings !== undefined || kind.unread === undefined ? "a screen kind with no `n` is `unread` alone" : null)
    : kind.sittings === undefined ? "a screen kind with an `n` holds its `sittings`"
    : kind.unread !== undefined && !partialOf(kind.n) ? "a screen kind read in part states its `n` partial"
    : null);

export const kind = tagged("family", {
  ...Object.fromEntries(RECORD_FAMILIES.map(each => [each, recordKind])) as Record<RecordFamily, typeof recordKind>,
  listening: listeningKind,
  screen: screenKind,
});
export type Kind = Of<typeof kind>;

export const topRow = either(
  object({ person: object({ ref, name }, { messages: int() }) }),
  object({ place: object({ ref, name: words, days: int() }) }),
  object({ hit: kindsHit }),
);
export type TopRow = Of<typeof topRow>;

const nOf = (each: Kind): GroupCount | undefined => ("n" in each ? each.n : undefined);
const unreadOf = (each: Kind): boolean => "unread" in each && each.unread !== undefined;
const rowsOf = (each: Kind): string[] => ("hits" in each ? each.hits.map(hit => hit.ref) : []);
const placeOf = (row: TopRow): number => ("person" in row ? 0 : "place" in row ? 1 : 2);

const kindsBroken = (answer: { total: GroupCount; top: TopRow[]; kinds: Kind[] }): string | null => {
  const families = answer.kinds.map(each => each.family);
  if (new Set(families).size !== families.length) return "a family is one kind";
  const counted = answer.kinds.filter(each => nOf(each) !== undefined);
  for (let i = 1; i < counted.length; i++) {
    const before = countOf(nOf(counted[i - 1]!)!), after = countOf(nOf(counted[i]!)!);
    if (before < after || (before === after && counted[i - 1]!.family > counted[i]!.family)) return "kinds come most first by `n`, ties by family";
  }
  const sum = counted.reduce((total, each) => total + countOf(nOf(each)!), 0);
  if (countOf(answer.total) !== sum) return `\`total\` is the kinds' \`n\` summed, ${sum}`;
  const partial = answer.kinds.some(each => unreadOf(each) || partialOf(nOf(each) ?? 0));
  if (partialOf(answer.total) !== partial) return "`total` is partial when a kind is partial or unread";
  if (answer.top.some((row, i) => i > 0 && placeOf(answer.top[i - 1]!) > placeOf(row))) return "`top` is people, then places, then hits";
  const topHits = answer.top.flatMap(row => ("hit" in row ? [row.hit] : []));
  if (topHits.some(hit => hit.family === "listening" || hit.family === "screen")) return "a top hit is of no listening and no screen";
  const inTop = new Set(topHits.map(hit => hit.ref));
  if (answer.kinds.some(each => rowsOf(each).some(shown => inTop.has(shown)))) return "a hit in `top` is not again in its kind";
  return null;
};

export const kindsAnswer = rule(object({ total: groupCount, top: list(topRow, 0, KINDS_SHOWN), kinds: list(kind) }, {
  as_of: instant,
  held,
  capped: bool,
  reached,
  day,
  month,
  ...fresh,
}), kindsBroken);
export type KindsAnswer = Of<typeof kindsAnswer>;

const ended = (rows: number, next: string | null): string | null => (rows === 0 && next !== null ? "a page with no row has no `next`: the home reads on" : null);

const recordPage = rule(object({ family: oneOf(...RECORD_FAMILIES), hits: list(kindsHit), next: nullable(cursor) }, { upcoming: oneOf(true), ...fresh }), page =>
  page.hits.some(hit => hit.family !== page.family) ? "a page's hits are of its kind"
    : !inOrder(page.hits, page.upcoming === true) ? (page.upcoming === true ? "an Upcoming page comes soonest first" : "a kind's page comes newest first")
    : ended(page.hits.length, page.next));
export type RecordPage = Of<typeof recordPage>;

const listeningPage = either(
  rule(object({ family: oneOf("listening"), tracks: list(track), next: nullable(cursor) }, fresh),
    page => (mostPlayed(page.tracks) ? ended(page.tracks.length, page.next) : "a listening page's tracks come most played first")),
  object({ family: oneOf("listening"), unread: label }),
);
export type ListeningPage = Of<typeof listeningPage>;

const screenPage = rule(object({ family: oneOf("screen"), sittings: list(sitting), next: nullable(cursor) }, { unread: label, ...fresh }),
  page => (inOrder(page.sittings) ? ended(page.sittings.length, page.next) : "a screen page's sittings come newest first"));
export type ScreenPage = Of<typeof screenPage>;

export const kindsPage = tagged("family", {
  ...Object.fromEntries(RECORD_FAMILIES.map(each => [each, recordPage])) as Record<RecordFamily, typeof recordPage>,
  listening: listeningPage,
  screen: screenPage,
});
export type KindsPage = Of<typeof kindsPage>;
