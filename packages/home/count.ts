import { accountOf, addDays, civilDay, dayBounds, digest, instantIn, type Json } from "@lifestreamprotocol/core";
import { handleOfId, type Collection, type Family, type Measure } from "@lifestreamprotocol/families";
import { plain, text, type Cell } from "./cell.js";
import {
  ASK_PRODUCT, bad, partitionKeyOf, countWhole, DAY_MS, groupKey, heldDigits, joinedPlace, needsPresence, peopleOrRefuse, PLACE_KEYS, presenceOrRefuse,
  rangeOf, reached, sideOf, TIME_KEYS, walkRangeOf, wholePeople, windowOf, wordsBudget,
  type Admission, type Admitted, type CatalogEntry, type Clauses, type CountAnswer, type CountAsk, type CountContext, type CountOp, type CountRun, type Extreme, type FactShown,
  type CountPlace, type FamilyEntry, type Group, type Kept, type MatchTerm, type Named, type PeopleMap, type PeopleShown, type Phrases, type Population, type Range, type Raw, type ResolvedPerson,
  type ResolveOptions, type Scope, type WordsAdmitted,
} from "./counting.js";
import { argumentsWritten, opened as envelopeOpened, resolvedOf, sealed, type Bound } from "./cursor-text.js";
import { freshMembers, OPEN_FROM, type HeldDays } from "./index-file.js";
import { at as instantAt, placeDaysOf, placeNamed, placesKept, placeTermsOf, presenceAttached, presenceIn, type PlaceAt, type PlaceTerm, type PlaceValue, type PresenceAreaRow } from "./presence.js";
import { lineRefAt, lowestHandle, makeRef, personRef, readRef, REF_CHARS, type Kept as SpelledKept, type PlaceKept, type RowScope } from "./refs.js";
import { FAMILIES, type CountCatalog, type CountFound, type CountParams, type CountResult, type PeopleMatch, type RowAsk } from "./search-contract.js";
import { refused, Refusal } from "./refusal.js";
import type { Call } from "./call.js";
import { readsSource } from "./sources-read.js";
import type { Attached, FactsRead, Passage, RecordRead, Slack, WalkEnd } from "./search-index.js";
import { matchesRaw, matchTermsOf, STRUCTURE_KEYS, termsOf, wordsOfTerms, type ReadTerm, type Term } from "./search-words.js";


const EXTREMES: ReadonlySet<string> = new Set(["min", "max", "first", "last"]);
const OPS: readonly string[] = ["count", "sum", "avg", "min", "max", "first", "last"];


const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const COUNT_LIMIT = 50;
export const PERSONS_MAX = 10;
const TIES_SHOWN = 3;
export const TRIES = 3;

export interface Depends {
  people: "needs" | "shows" | null;
  presence: "needs" | "shows" | null;
}

export function dependsOn(ask: CountAsk, collections: ReadonlyMap<string, Collection>): Depends {
  if (ask.of === "") return { people: null, presence: null };
  return { people: ask.person.length > 0 || ask.by.includes("person") ? "needs" : "shows", presence: needsPresence(ask, collections) ? "needs" : "shows" };
}

export function collectionsOf(families: readonly Family[]): Map<string, Collection> {
  const all = new Map<string, Collection>();
  for (const family of families) {
    for (const [of, collection] of Object.entries(family.collections ?? {})) {
      const had = all.get(of);
      all.set(of, had === undefined ? collection : { keys: [...new Set([...had.keys, ...collection.keys])], measures: { ...had.measures, ...collection.measures } });
    }
  }
  return all;
}


interface Asked {
  of?: string;
  measure?: string;
  op?: string;
  by: readonly string[];
  from?: string;
  to?: string;
  person: readonly string[];
  chat?: string;
  words?: string;
  typing?: 1;
  place?: string;
  match: Readonly<Record<string, string>>;
  order?: string;
  at_least?: string;
  at_most?: string;
  limit: number;
}

export function countAskOf(params: Omit<CountParams, "cursor"> & Pick<RowAsk, "typing">, collections: ReadonlyMap<string, Collection>): CountAsk {
  argumentsWritten("count", params);
  const { limit, ...query } = params;
  const { at_least, at_most, chat, by, person, match, ...rest } = query;
  const ask = askChecked({
    ...rest, by: by ?? [], person: person ?? [], match: match ?? {}, limit: limit ?? COUNT_LIMIT,
    ...(chat === undefined ? {} : { chat: readRef(chat, "chat", ["chat"]).parts.key }),
    ...(at_least === undefined ? {} : { at_least: String(at_least) }), ...(at_most === undefined ? {} : { at_most: String(at_most) }),
  }, collections);
  return query.of === undefined ? ask : { ...ask, asked: query as RowAsk };
}

export function countAskedOf(params: CountParams, collections: ReadonlyMap<string, Collection>): CountAsk {
  const { cursor, ...query } = params;
  if (cursor === undefined) return countAskOf(query, collections);
  return { ...countAskOf(envelopeOpened(cursor, ["count"], query).params, collections), cursor };
}

function askChecked(asked: Asked, collections: ReadonlyMap<string, Collection>): CountAsk {
  const { of, limit } = asked;
  if (of === undefined) {
    const others = (["measure", "op", "from", "to", "chat", "words", "place", "order", "at_least", "at_most"] as const).filter((name) => asked[name] !== undefined);
    if (asked.by.length > 0) others.push("by" as never);
    if (asked.person.length > 0) others.push("person" as never);
    if (Object.keys(asked.match).length > 0) others.push("match" as never);
    if (others.length > 0) bad(`with no of, count answers the catalog and takes nothing else (${others.join(", ")}): name the collection in of`);
    return { of: "", op: "count", by: [], person: [], match: {}, limit };
  }
  const collection = collections.get(of) ?? bad(`no collection ${of}; the collections: ${[...collections.keys()].sort().join(", ")}`);
  const measure = asked.measure;
  const declared = measure === undefined ? undefined : collection.measures[measure] ?? bad(`${of} has no measure ${measure}; its measures: ${Object.keys(collection.measures).join(", ")}`);
  const typed = asked.op;
  if (typed !== undefined && !OPS.includes(typed)) bad("op is sum, avg, min, max, first or last; neither measure nor op is a count");
  let op: CountOp;
  if (declared === undefined) {
    if (typed !== undefined && typed !== "count") bad(`${typed} needs a measure; ${of}'s measures: ${Object.keys(collection.measures).join(", ")}`);
    op = "count";
  } else {
    op = (typed as CountOp | undefined) ?? (declared.ops.includes("sum") ? "sum" : "avg");
    if (op === "count") bad("a count names no measure");
    if (!declared.ops.includes(op)) {
      const others = declared.ops.filter((each) => each !== op);
      bad(op === "sum" ? `${measure} does not add up: use ${others.join(", ")}` : `${measure} takes ${declared.ops.join(", ")}`);
    }
  }
  const by = [...asked.by];
  if (by.length > 2 || new Set(by).size !== by.length) bad("by is one or two keys, each once");
  if (by.includes("item") && by.length > 1) bad("by item stands alone: the facts themselves, each with its keys and measures");
  if (by.includes("run") && by.length > 1) bad("by run stands alone: the unbroken runs of days that hold a match; name a place to read trips there");
  for (const key of by) {
    if (key === "item" || key === "run") continue;
    if (key === "hour") {
      if (of === "days") bad("days have no hour: group days by day, week, month, year or weekday");
      continue;
    }
    if (!(TIME_KEYS as readonly string[]).includes(key) && key !== "person" && !collection.keys.includes(key) && !joinedPlace(key, of, collection.keys)) {
      bad(`${of} has no key ${key}; its keys: ${[...collection.keys, "person", ...[...PLACE_KEYS].filter((each) => !collection.keys.includes(each)), ...of === "days" ? ["sure"] : []].join(", ")}; or hour, ${TIME_KEYS.join(", ")}; or run alone; or item alone`);
    }
  }
  const match: Record<string, string> = {};
  for (const [key, words] of Object.entries(asked.match)) {
    if (PLACE_KEYS.has(key) && !collection.keys.includes(key)) bad(`${of} states no ${key} of its own: ask where the person was with place=words`);
    if (!collection.keys.includes(key)) bad(`${of} has no key ${key}; its keys: ${collection.keys.join(", ")}`);
    if (matchTermsOf(words).length === 0) bad(`match.${key} names no word`);
    match[key] = words;
  }
  const chat = asked.chat;
  if (chat !== undefined && !collection.keys.includes("chat")) {
    const chatted = [...collections].filter(([, each]) => each.keys.includes("chat")).map(([name]) => `of=${name}`).sort();
    bad(`${of} states no chat: a chat's facts are ${chatted.join(", ")}`);
  }
  if (asked.person.length > PERSONS_MAX) bad(`person names at most ${PERSONS_MAX} people`);
  const person = [...asked.person];
  const words = asked.words;
  if (words !== undefined && termsOf(words).length === 0) bad("words names no word");
  const place = asked.place;
  if (place !== undefined && placeTermsOf(place).length === 0) bad("place names no place: an owner's place, a city, a region or a country");
  const order = asked.order;
  if (order !== undefined && order !== "value" && order !== "time") bad("order is value (largest first) or time (earliest first)");
  if (order === "value" && by.includes("item") && measure === undefined) bad("order=value ranks the items by a measure: name one");
  const bounds: { at_least?: string; at_most?: string } = {};
  for (const name of ["at_least", "at_most"] as const) {
    const value = asked[name];
    if (value === undefined) continue;
    if (declared === undefined) bad(`${name} bounds a measure: name one; ${of}'s measures: ${Object.keys(collection.measures).join(", ") || "none"}`);
    if (!/^-?\d+(\.\d+)?$/u.test(value)) bad(`${name} is a number in ${measure}'s unit${declared.unit === "currency" ? ", a currency's in its own decimals (12.50)" : ""}`);
    bounds[name] = value;
  }
  if (bounds.at_least !== undefined && bounds.at_most !== undefined && Number(bounds.at_least) > Number(bounds.at_most)) bad("at_least is more than at_most: nothing lies between");
  const { from, to } = asked;
  return {
    of, op, by, person, match, limit, ...bounds,
    ...(measure === undefined ? {} : { measure }), ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }),
    ...(words === undefined || words.trim() === "" ? {} : { words, ...(asked.typing === 1 ? { typing: true as const } : {}) }), ...(order === undefined ? {} : { order: order as "value" | "time" }),
    ...(place === undefined ? {} : { place }), ...(chat === undefined ? {} : { chat }),
  };
}







export interface Candidate {
  name: number;
  value: string;
}

export interface Candidates {
  snapshot: Snapshot;
  persons: ResolvedPerson[];
  match: Record<string, { terms: MatchTerm[]; values: Candidate[] }>;
  chat?: Candidate[];
  words?: { terms: Term[]; typing?: true; required?: Walked; excluded?: Walked };
  place?: { terms: PlaceTerm[]; values: ({ term: number } & PlaceValue)[]; areas: readonly PresenceAreaRow[] };
}

export interface Walked {
  facts: Record<string, Passage[]>;
  slots: Record<string, number[]>;
  slack?: Slack;
  end: WalkEnd;
}

export function walkEndOf(words: NonNullable<Candidates["words"]>): WalkEnd {
  const ends = [words.required?.end, words.excluded?.end].filter((end): end is WalkEnd => end !== undefined);
  if (ends.some((end) => "untimed" in end)) return { whole: false, untimed: true };
  const froms = ends.flatMap((end) => ("from" in end ? [end.from] : []));
  const tos = ends.flatMap((end) => ("to" in end ? [end.to] : []));
  return tos.length > 0 ? { whole: false, to: Math.min(...tos) } : froms.length === 0 ? { whole: true } : { whole: false, from: Math.max(...froms) };
}

function phraseGroups(terms: readonly { text: string; negated: boolean; or: boolean }[]): Phrases[] {
  const groups: Phrases[] = [];
  let open: Phrases | undefined;
  for (const term of terms) {
    if (term.negated) groups.push({ phrases: [term.text], negated: true });
    else if (term.or && open !== undefined) open.phrases.push(term.text);
    else groups.push(open = { phrases: [term.text], negated: false });
  }
  return groups;
}

const peoplesOwn = (value: string): boolean => value === "me" || value.startsWith("person:") || value.startsWith("contact:");

export interface PersonSaid {
  asked: string;
  ref?: string;
  name: string;
}

function shownIn(context: CountContext): PeopleShown | undefined {
  const people = context.people();
  return context.shown ?? (people === undefined ? undefined : wholePeople(people));
}

function personByHandle(handle: string, shown: PeopleShown | undefined): Omit<ResolvedPerson, "said"> | undefined {
  const id = shown?.named(handle);
  const person = id === undefined ? undefined : shown!.shown(id);
  if (id !== undefined && person !== undefined) return { id, name: person.name, handles: person.handles, bare: false };
  return handleOfId(handle) === null ? undefined : { id: handle, name: handle, handles: [handle], bare: true };
}

export function personsAsked(values: readonly string[], people: PeopleMap, shown: PeopleShown = wholePeople(people)): { who: ResolvedPerson[]; said: PersonSaid[] } {
  const who: ResolvedPerson[] = [];
  const said: PersonSaid[] = [];
  const gone: string[] = [];
  const none: string[] = [];
  const several: { said: string; ids: string[] }[] = [];
  const add = (asked: string, person: Omit<ResolvedPerson, "said">) => {
    who.push({ said: text(asked), ...person });
    said.push({ asked, ...(person.bare ? {} : { ref: personRef(person) }), name: person.name });
  };
  for (const value of values) {
    const ref = value.startsWith("person.") ? readRef(value, "person", ["person"]).parts.handle : undefined;
    const found = personByHandle(ref ?? value, ref !== undefined || !peoplesOwn(value) ? shown : undefined);
    if (found !== undefined) {
      add(value, found);
      continue;
    }
    if (ref !== undefined) gone.push(value);
    else {
      const named = shown.found(value);
      const person = named.length === 1 ? shown.shown(named[0]!) : undefined;
      if (person !== undefined) add(value, { id: named[0]!, name: person.name, handles: person.handles, bare: false });
      else if (named.length > 1) several.push({ said: value, ids: named });
      else none.push(value);
    }
  }
  if (gone.length > 0) refused("BAD_PARAMETER", `\`person\` names no one held now: ${gone.join(", ")}. Find them with \`search_people\`.`);
  if (none.length > 0) refused("PERSON_UNKNOWN", `No such person: ${none.join(", ")}. Find them with \`search_people\`.`);
  if (several.length > 0) {
    const matches = several.flatMap(({ ids }) => ids.map((id): PeopleMatch => {
      const person = shown.shown(id);
      const handles = person?.handles ?? [];
      return { ref: personRef({ id, handles }), kind: "person", name: person?.name ?? id, ...(handles.length === 0 ? {} : { handles: handles.map((handle) => handleOfId(handle)?.value ?? handle) }) };
    }));
    refused("PERSON_UNKNOWN", `Several people go by ${several.map(({ said }) => said).join(", ")}: ask by one of their refs. Find them with \`search_people\`.`, { matches });
  }
  return { who, said };
}

export function resolve(read: FactsRead, ask: CountAsk, context: CountContext, options: ResolveOptions = {}): Candidates {
  const persons = ask.person.length === 0 ? [] : personsAsked(ask.person, peopleOrRefuse(context), context.shown).who;
  const match: Candidates["match"] = {};
  for (const [key, written] of Object.entries(ask.match)) match[key] = matchResolved(read, ask.of, key, matchTermsOf(written));
  let chat: Candidate[] | undefined;
  if (ask.chat !== undefined) chat = read.values(ask.of, "chat", context.chat?.(ask.chat) ?? ask.chat).map(({ name, value }) => ({ name, value }));
  const words = ask.words === undefined ? undefined
    : wordsWalked(read, ask, context, termsOf(ask.words), { passages: options.passages === true, ...(chat === undefined ? {} : { chats: chat.map((each) => each.value) }) });
  const place = ask.place === undefined ? undefined : placeResolved(read, context, placeTermsOf(ask.place));
  return {
    snapshot: snapshotOf(read, ask, context), persons, match, ...(chat === undefined ? {} : { chat }), ...(words === undefined ? {} : { words }),
    ...(place === undefined ? {} : { place }),
  };
}

function matchResolved(read: FactsRead, of: string, key: string, terms: MatchTerm[]): Candidates["match"][string] {
  return { terms, values: read.values(of, key).filter((each) => terms.some((term) => matchesRaw(each.value, term))).map(({ name, value }) => ({ name, value })) };
}

function placeResolved(read: FactsRead, context: CountContext, terms: PlaceTerm[]): NonNullable<Candidates["place"]> {
  const presence = presenceOrRefuse(read, context);
  return { terms, values: terms.flatMap((term, at) => placeNamed(presence.areas, term).map((value) => ({ term: at, ...value }))), areas: presence.areas };
}

export function wordsWalked(read: FactsRead, ask: CountAsk, context: CountContext, terms: Term[], options: { passages?: boolean; chats?: readonly string[] } = {}): NonNullable<Candidates["words"]> {
  const positive = wordsOfTerms(terms.filter((term) => !term.negated), ask.typing === true);
  const negatives = terms.filter((term) => term.negated).map((term, at) => ({ ...term, negated: false, or: at > 0 }));
  const negative = negatives.length === 0 ? null : wordsOfTerms(negatives);
  const passages = options.passages === true;
  const range = walkRangeOf(rangeOf(ask, context));
  const budget = wordsBudget(context, passages);
  const families = context.familiesOf?.(ask.of);
  const within = { ...(options.chats === undefined ? {} : { chats: options.chats }), ...(families === undefined ? {} : { families }) };
  const walked = (match: string): Walked => {
    const { facts, slots, slack, end } = read.wordFacts(match, ask.of, passages, range, budget, sideOf(ask) === "newest", within);
    return { facts: Object.fromEntries(facts), slots: Object.fromEntries(slots), ...(slack === undefined ? {} : { slack }), end };
  };
  return {
    terms, ...(ask.typing === true ? { typing: true } : {}),
    ...(positive === null ? {} : { required: walked(positive.match) }), ...(negative === null ? {} : { excluded: walked(negative.match) }),
  };
}


export interface Stands {
  value(key: string, term: MatchTerm, at: number, candidate: Candidate): boolean | null;
  fact(term: Term, at: number, read: ReadTerm, fact: string, passages: readonly Passage[]): boolean | null;
  place(term: PlaceTerm, at: number, value: PlaceValue & { owner: string }): boolean | null;
}

export const ALWAYS: Stands = { value: (_key, term, _at, candidate) => matchesRaw(candidate.value, term), fact: () => true, place: () => true };

export function admit(candidates: Candidates, stands: Stands): Admission | { unread: true } {
  let unread = false;
  const known = (answer: boolean | null) => {
    if (answer === null) unread = true;
    return answer === true;
  };
  const values: Kept["values"] = {};
  const took: Kept["took"] = {};
  for (const [key, { terms, values: all }] of Object.entries(candidates.match)) {
    const of = (wanted: boolean) => terms.map((term, at) => ({ term, at })).filter(({ term }) => term.negated === wanted);
    const required = of(false), excluded = of(true);
    const taking = (list: typeof required, candidate: Candidate) => list.some(({ term, at }) => known(stands.value(key, term, at, candidate)));
    took[key] = required.map(({ term, at }) => ({ said: term.said, values: all.filter((each) => known(stands.value(key, term, at, each))).map((each) => each.value) }));
    values[key] = {
      ...(required.length === 0 ? {} : { in: all.filter((each) => taking(required, each)).map((each) => each.value) }),
      out: all.filter((each) => taking(excluded, each)).map((each) => each.value),
    };
  }
  let words: WordsAdmitted | undefined;
  if (candidates.words !== undefined) {
    const { terms } = candidates.words;
    const required = candidates.words.required?.facts;
    const excluded = candidates.words.excluded?.facts ?? {};
    const indexed = terms.map((term, at) => ({ term, at }));
    const positives = indexed.filter(({ term }) => !term.negated);
    const negatives = indexed.filter(({ term }) => term.negated);
    const readPositive = wordsOfTerms(positives.map(({ term }) => term), candidates.words.typing === true)?.terms?.required ?? [];
    const readNegative = (wordsOfTerms(negatives.map(({ term }, at) => ({ ...term, negated: false, or: at > 0 })))?.terms?.required ?? []).flat();
    const passagesOf = (fact: string): Passage[] => {
      const seen = new Set<string>();
      return [...required?.[fact] ?? [], ...excluded[fact] ?? []].filter((passage) => {
        if (seen.has(passage.text)) return false;
        seen.add(passage.text);
        return true;
      });
    };
    const standsIn = (list: typeof positives, read: ReadTerm, fact: string) => {
      const { term, at } = list[read.index]!;
      return stands.fact(term, at, read, fact, passagesOf(fact));
    };
    const any = (each: readonly (boolean | null)[]) => (each.includes(true) ? true : each.includes(null) ? null : false);
    const every = (each: readonly (boolean | null)[]) => (each.includes(false) ? false : each.includes(null) ? null : true);
    const isIn = (fact: string) => (required === undefined ? true : fact in required ? every(readPositive.map((group) => any(group.map((read) => standsIn(positives, read, fact))))) : false);
    const isOut = (fact: string) => (fact in excluded ? any(readNegative.map((read) => standsIn(negatives, read, fact))) : false);
    const kept = new Map([...new Set([...Object.keys(required ?? {}), ...Object.keys(excluded)])].map((fact) => [fact, { in: isIn(fact), out: isOut(fact) }]));
    for (const { in: taken, out: left } of kept.values()) if (every([taken, left === null ? null : !left]) === null) unread = true;
    const walked = candidates.words.required;
    words = {
      ...(required === undefined ? {} : { in: Object.keys(required).filter((fact) => kept.get(fact)!.in === true) }),
      out: Object.keys(excluded).filter((fact) => kept.get(fact)!.out === true),
      end: walkEndOf(candidates.words),
      ...(walked === undefined ? {} : { slots: walked.slots, ...(walked.slack === undefined ? {} : { slack: walked.slack }) }),
    };
  }
  const place: Kept["place"] = candidates.place === undefined ? undefined
    : placesKept(candidates.place.areas, candidates.place.terms, (term, at, value) => known(stands.place(term, at, value)));
  if (unread) return { unread: true };
  const kept: Kept = {
    persons: candidates.persons, values, took, ...(place === undefined ? {} : { place }),
    ...(candidates.persons.length === 0 ? {} : { handles: [...new Set(candidates.persons.flatMap((each) => each.handles))] }),
    ...(candidates.words === undefined ? {} : { words: candidates.words.terms }), ...(candidates.chat === undefined ? {} : { chat: candidates.chat.map((each) => each.value) }),
  };
  return { kept, ...(words === undefined ? {} : { words }) };
}


export function keptSpelled(kept: Kept): SpelledKept {
  const place = (at: readonly PlaceAt[]) => at.map((each) => ({ level: each.level, id: each.key }));
  return {
    ...(kept.persons.length === 0 && kept.handles === undefined ? {} : { persons: kept.persons.map((person) => [...person.handles]) }),
    ...(kept.chat === undefined ? {} : { chat: [...kept.chat] }),
    ...(Object.keys(kept.values).length === 0 ? {} : { values: Object.fromEntries(Object.entries(kept.values).map(([key, { in: taken, out }]) => [key, { ...(taken === undefined ? {} : { in: [...taken] }), out: [...out] }])) }),
    ...(kept.place === undefined ? {} : { place: { ...(kept.place.in === undefined ? {} : { in: place(kept.place.in) }), out: place(kept.place.out) } }),
  };
}

export function rowRefOf(ask: RowAsk, kept: SpelledKept, scope: RowScope, n: number): string {
  let held = kept;
  let at: RowScope = "g" in scope ? { g: scope.g.map((cell) => (typeof cell === "string" && Buffer.byteLength(cell) > VALUE_KEPT ? valueKept(cell) : cell)), p: scope.p } : scope;
  for (;;) {
    const ref = makeRef("row", { ask, kept: held, scope: at, n });
    if (ref.length <= REF_CHARS) return ref;
    const less = narrowed(held);
    if (less !== undefined) held = less;
    else if ("g" in at && at.g.some(widePerson)) at = { g: at.g.map((cell) => (widePerson(cell) ? lowestOf(cell) : cell)), p: at.p };
    else return refused("BAD_PARAMETER", "this count names more people and values than one of its rows can hold: ask with fewer people or filters.");
  }
}

const widePerson = (held: unknown): held is string[] => Array.isArray(held) && held.length > 1;
const lowestOf = (handles: readonly string[]): string => lowestHandle(handles) ?? handles[0]!;

export const VALUE_KEPT = 200;

function valueKept(value: string): { v: string; h: string } {
  let v = "";
  for (const point of value) {
    if (Buffer.byteLength(v + point) > VALUE_KEPT) break;
    v += point;
  }
  return { v, h: valueDigest(value) };
}

const valueDigest = (value: string): string => digest(value).slice("sha256:".length, "sha256:".length + 16);

const VALUES_AT_ONCE = 64;

function valueAgain(read: FactsRead, kept: { v: string; h: string }): string {
  for (let after = kept.v; ;) {
    const page = read.walk<{ name: string }>("SELECT name FROM names WHERE role = 'value' AND name > ? ORDER BY name LIMIT ?", [after], VALUES_AT_ONCE);
    for (const { name } of page.rows) {
      if (!name.startsWith(kept.v)) return bad("this row's group is of a value the record no longer holds");
      if (valueDigest(name) === kept.h) return name;
    }
    if (!page.more || page.rows.length === 0) return bad("this row's group is of a value the record no longer holds");
    after = page.rows.at(-1)!.name;
  }
}

function narrowed(kept: SpelledKept): SpelledKept | undefined {
  const parts: [string, number][] = [
    ...Object.entries(kept.values ?? {}).map(([key, values]): [string, number] => [key, JSON.stringify(values).length]),
    ...(kept.place === undefined ? [] : [["", JSON.stringify(kept.place).length] as [string, number]]),
  ];
  if (parts.length > 0) {
    const [largest] = parts.reduce((most, each) => (each[1] > most[1] ? each : most));
    if (largest === "") {
      const { place: _place, ...rest } = kept;
      return rest;
    }
    const { [largest]: _gone, ...values } = kept.values!;
    const { values: _values, ...rest } = kept;
    return Object.keys(values).length === 0 ? rest : { ...rest, values };
  }
  if (kept.persons?.some(widePerson) === true) return { ...kept, persons: kept.persons.map((held) => (widePerson(held) ? lowestOf(held) : held)) };
  return undefined;
}

export function admissionOf(read: FactsRead, ask: CountAsk, context: CountContext, kept: SpelledKept): Admission {
  const shown = shownIn(context);
  const persons: ResolvedPerson[] = (kept.persons ?? []).map((held) => {
    if (typeof held === "string") {
      const found = personByHandle(held, shown) ?? { id: held, name: held, handles: [held], bare: true };
      return { said: text(found.name), ...found };
    }
    const id = held.map((handle) => shown?.named(handle)).find((each) => each !== undefined);
    const person = id === undefined ? undefined : shown?.shown(id);
    return person === undefined || id === undefined
      ? { said: text(held[0] ?? ""), id: held[0] ?? "", name: held[0] ?? "", handles: held, bare: true }
      : { said: text(person.name), id, name: person.name, handles: held, bare: false };
  });
  const at = (place: PlaceKept): PlaceAt => ({ level: place.level as PlaceAt["level"], key: place.id });
  const values: Kept["values"] = Object.fromEntries(Object.entries(kept.values ?? {}).map(([key, { in: taken, out }]) => [key, { ...(taken === undefined ? {} : { in: taken }), out }]));
  const terms = ask.words === undefined ? undefined : termsOf(ask.words);
  const own: Kept = {
    persons, values, took: Object.fromEntries(Object.keys(values).map((key) => [key, []])),
    ...(kept.persons === undefined ? {} : { handles: [...new Set(persons.flatMap((person) => person.handles))] }),
    ...(kept.chat === undefined ? {} : { chat: kept.chat }),
    ...(kept.place === undefined ? {} : { place: { ...(kept.place.in === undefined ? {} : { in: kept.place.in.map(at) }), out: kept.place.out.map(at), took: [] } }),
    ...(terms === undefined ? {} : { words: terms }),
  };
  const keysAgain = Object.keys(ask.match).filter((key) => kept.values?.[key] === undefined);
  const placeAgain = ask.place !== undefined && kept.place === undefined;
  if ((terms === undefined || terms.length === 0) && keysAgain.length === 0 && !placeAgain) return { kept: own };
  const words = terms === undefined || terms.length === 0 ? undefined : wordsWalked(read, ask, context, terms, kept.chat === undefined ? {} : { chats: kept.chat });
  const walked = admit({
    snapshot: snapshotOf(read, ask, context), persons: [],
    match: Object.fromEntries(keysAgain.map((key) => [key, matchResolved(read, ask.of, key, matchTermsOf(ask.match[key]!))])),
    ...(words === undefined ? {} : { words }), ...(placeAgain ? { place: placeResolved(read, context, placeTermsOf(ask.place!)) } : {}),
  }, ALWAYS) as Admission;
  for (const key of keysAgain) {
    own.values[key] = walked.kept.values[key]!;
    own.took[key] = walked.kept.took[key]!;
  }
  if (placeAgain && walked.kept.place !== undefined) own.place = walked.kept.place;
  return { kept: own, ...(walked.words === undefined ? {} : { words: walked.words }) };
}

function scopeOf(read: FactsRead, ask: CountAsk, scope: RowScope, context: CountContext): Scope | undefined {
  if ("u" in scope) return { u: scope.u };
  if ("t" in scope) return { t: { p: scope.t } };
  if (!("g" in scope)) return undefined;
  const groupBy = ask.by.filter((key) => key !== "item");
  if (scope.g.length !== groupBy.length) bad("this row's group is not of its query");
  return {
    g: scope.g.map((cell, at) => {
      if (groupBy[at] === "person" && cell !== null) {
        if (Array.isArray(cell)) return { handles: cell };
        if (typeof cell === "string") return { handles: personByHandle(cell, shownIn(context))?.handles ?? [cell] };
        return bad("this row's group is not of its query");
      }
      if (Array.isArray(cell)) bad("this row's group is not of its query");
      return cell !== null && typeof cell === "object" ? valueAgain(read, cell as { v: string; h: string }) : cell;
    }),
    p: scope.p,
  };
}

function narrowedWords(ask: CountAsk, kept: SpelledKept, which: RowScope): string | undefined {
  const groupBy = ask.by.filter((key) => key !== "item");
  const followed = kept.persons?.some((held) => typeof held === "string") === true
    || ("g" in which && which.g.some((cell, at) => groupBy[at] === "person" && typeof cell === "string"));
  const again = [...Object.keys(ask.match).filter((key) => kept.values?.[key] === undefined), ...(ask.place !== undefined && kept.place === undefined ? ["place"] : [])];
  const parts = [
    ...(followed ? ["each person is whoever holds one handle of theirs now"] : []),
    ...(again.length === 0 ? [] : [`${listed(again)} ${again.length === 1 ? "is" : "are"} what the words asked take now`]),
  ];
  return parts.length === 0 ? undefined : `narrowed to fit its ref: ${parts.join("; ")}, so it may count other facts than its n`;
}

interface RowRefs {
  row(scope: { g: Raw[]; p: string | null } | { t: { p: string | null } } | undefined, n: number): Cell;
  fact(named: Named): Cell;
}

function heldKept(admitted: Admitted, population: Population): Kept {
  const held = (key: string, names: readonly number[]) => new Set(population.matchedOf(key, names).filter((row) => row.n > 0).map((row) => row.value));
  const values = Object.fromEntries(Object.entries(admitted.kept.values).map(([key, kept]) => {
    if (kept.in === undefined) return [key, kept];
    const allowed = held(key, admitted.values[key]?.in ?? []);
    return [key, { ...kept, in: kept.in.filter((value) => allowed.has(value)) }];
  }));
  const chat = admitted.kept.chat === undefined ? undefined : held("chat", admitted.chat ?? []);
  return { ...admitted.kept, values, ...(chat === undefined ? {} : { chat: admitted.kept.chat!.filter((value) => chat.has(value)) }) };
}

function rowRefsOf(read: FactsRead, ask: CountAsk, kept: Kept, groupBy: readonly string[], context: CountContext): RowRefs {
  const spelled = keptSpelled(kept);
  const shown = shownIn(context);
  const made = (scope: RowScope, n: number): Cell => ({ is: "ref", value: rowRefOf(ask.asked!, spelled, scope, n) });
  const cellOf = (value: Raw, at: number) => (groupBy[at] === "person" && value !== null ? [...shown?.shown(String(value))?.handles ?? [String(value)]] : value);
  return {
    row: (scope, n) => made(scope === undefined ? {} : "t" in scope ? { t: scope.t.p } : { g: scope.g.map(cellOf), p: scope.p }, n),
    fact: (named) => {
      const own = named.fact === null ? null : factRef(read, named.fact);
      return own === null ? made({ u: [named.unit, named.p, named.fact] }, 1) : { is: "ref", value: own };
    },
  };
}

export function factRef(read: FactsRead, fact: string): string | null {
  const row = read.point<{ fid: number; record: string | null; day: string }>("SELECT fid, record, day FROM fact WHERE id = ?", [fact]);
  if (row === undefined) return null;
  if (row.record !== null) {
    const [source, kind, key] = row.record.split("\0") as [string, string, string];
    return makeRef("record", { source, kind, key });
  }
  const line = read.walk<{ atom: number }>("SELECT atom FROM fact_line WHERE fid = ? AND day = ? ORDER BY atom LIMIT ?", [row.fid, row.day], 1).rows[0];
  return line === undefined ? null : lineRefAt(read, row.day, line.atom);
}

export interface RowOpened {
  answer: CountAnswer;
  now?: number;
}

export function countIn<T>(call: Call, asked: CountAsk, work: (read: RecordRead, asked: CountAsk, context: CountContext) => T): T {
  const read = call.index();
  const context = countContextOf(call, read);
  const depends = dependsOn(asked, context.collections).people;
  const people = depends === null ? undefined : depends === "needs" ? call.people() : call.peopleIfReady();
  const answer = work(read, asked, { ...context, people: () => people });
  const kept = call.keptOut();
  if (kept !== undefined) call.log.withheld = kept;
  return answer;
}

function countContextOf(call: Call, read: RecordRead): CountContext {
  const families = call.families;
  return {
    collections: collectionsOf(families), settings: read.clock, now_ms: call.now_ms, people: () => undefined,
    ...(call.presence() === undefined ? {} : { presence: call.presence()! }),
    ...(call.gate === undefined ? {} : { gate: call, outside: () => call.outside, shown: call }),
    chat: (written) => call.chat(written),
    sources: (name) => {
      const family = families.find((each) => each.name === name);
      return family === undefined ? [] : call.view().sources().filter((row) => readsSource(family, row));
    },
    families: families.map((family) => family.name),
    familiesOf: (of) => families.filter((family) => family.collections?.[of] !== undefined).map((family) => family.name),
    fresh: (seq, held) => call.fresh(seq, held),
  };
}

export function openRow(call: Call, asked: CountAsk, kept: SpelledKept, which: RowScope, place: CountPlace | undefined, admitted?: RowAdmitted): RowOpened {
  return countIn(call, asked, (read, counted, context) => openRowIn(read, counted, kept, which, place, context, admitted));
}

export interface RowAdmitted {
  admission: Admission;
  snapshot: Snapshot;
}

export class SnapshotMoved extends Error {
  constructor() {
    super("the index, People or Places moved since the row's candidates were read");
  }
}

export function rowResolved(call: Call, asked: CountAsk, which: RowScope): Candidates {
  return countIn(call, rowCountAsk(asked, which), (read, ask, context) => readsOf(read, context).resolve(ask, { passages: true }) as Candidates);
}

export function openRowIn(record: RecordRead, asked: CountAsk, kept: SpelledKept, which: RowScope, place: CountPlace | undefined, context: CountContext, admitted?: RowAdmitted): RowOpened {
  const ask = rowCountAsk(asked, which);
  return record.facts((read) => {
    if (admitted !== undefined && !sameSnapshot(snapshotOf(read, ask, context), admitted.snapshot)) throw new SnapshotMoved();
    const held = heldIn(read, ask, context);
    const scope = scopeOf(read, ask, which, context);
    const again = admissionOf(read, ask, context, kept);
    const admission: Admission = admitted === undefined ? again : { kept: again.kept, ...(admitted.admission.words === undefined ? {} : { words: admitted.admission.words }) };
    const answer = toldOf(countWhole(read, ask, context, admission, (run) => counted(read, run, context, { scope, place })), ask, context);
    const counts = answer.total.map((each) => (each.cells.n as Cell | undefined)?.value);
    const now = counts.every((n): n is number => typeof n === "number") && counts.length > 0 ? counts.reduce((sum, n) => sum + n, 0) : undefined;
    const narrowedTo = narrowedWords(ask, kept, which);
    const said = narrowedTo === undefined ? answer : { ...answer, asked: text(`${String(answer.asked.value)} (${narrowedTo})`) };
    return { answer: withFresh(said, read, held, context), ...(now === undefined ? {} : { now }) };
  });
}

function rowCountAsk(asked: CountAsk, which: RowScope): CountAsk {
  const whole = !("t" in which) && !("g" in which) && !("u" in which);
  const { order, ...rest } = asked;
  return !whole ? asked : { ...rest, by: ["item"], ...(order === undefined || (order === "value" && asked.measure === undefined) ? {} : { order }) };
}

export function rowAskedOf(asked: RowAsk, which: RowScope, collections: ReadonlyMap<string, Collection>): string {
  const ask = rowCountAsk(countAskOf(asked, collections), which);
  const collection = collections.get(ask.of)!;
  const measure = ask.measure === undefined ? undefined : collection.measures[ask.measure];
  const scope = "u" in which ? { u: which.u } : "t" in which ? { t: { p: which.t } } : "g" in which ? { g: [], p: which.p } : undefined;
  return askedWords(ask, measure, partitionKeyOf(ask, collection, measure), scope, collection);
}


export interface CountReads {
  resolve(ask: CountAsk, options: ResolveOptions): Promise<Candidates> | Candidates;
  count(ask: CountAsk, admission: Admission, snapshot: Snapshot | null): Promise<CountAnswer | null> | CountAnswer | null;
}

export function readsOf(record: RecordRead, context: CountContext): CountReads {
  return {
    resolve: (ask, options) => record.facts((read) => {
      notBuilding(read);
      return resolve(read, ask, context, options);
    }),
    count: (ask, admission, snapshot) => record.facts((read) => {
      if (snapshot !== null && !sameSnapshot(snapshotOf(read, ask, context), snapshot)) return null;
      const held = heldIn(read, ask, context);
      return withFresh(toldOf(countWhole(read, ask, context, admission, (run) => counted(read, run, context)), ask, context), read, held, context);
    }),
  };
}

export function plainCount(record: RecordRead, ask: CountAsk, context: CountContext): CountAnswer {
  return countedOnce(record, ask, context, (answer) => answer);
}

export function countLacking(key: string): (record: RecordRead, ask: CountAsk, context: CountContext) => CountAnswer & { lacking: number } {
  return (record, ask, context) => record.facts((read) => {
    const held = heldIn(read, ask, context);
    const admission = admit(resolve(read, ask, context), ALWAYS) as Admission;
    const { answer, lacking } = countWhole(read, ask, context, admission, (run) => ({
      answer: counted(read, run, context),
      lacking: run.populationOf().groupsOf([key]).reduce((sum, group) => sum + (group.keys[0] === null || group.keys[0] === undefined ? group.value ?? 0 : 0), 0),
    }));
    return { ...withFresh(toldOf(answer, ask, context), read, held, context), lacking };
  });
}

export function countWithAlso(record: RecordRead, ask: CountAsk, context: CountContext): CountAnswer {
  return countedOnce(record, ask, context, (answer, read, kept) => (context.gate === undefined ? withAlso(answer, read, ask, kept, context) : answer));
}

function countedOnce(record: RecordRead, ask: CountAsk, context: CountContext, told: (answer: CountAnswer, read: RecordRead, kept: Kept) => CountAnswer): CountAnswer {
  return record.facts((read) => {
    const held = heldIn(read, ask, context);
    const admission = admit(resolve(read, ask, context), ALWAYS) as Admission;
    const answer = toldOf(countWhole(read, ask, context, admission, (run) => counted(read, run, context)), ask, context);
    return withFresh(told(answer, read, admission.kept), read, held, context);
  });
}

function heldIn(read: FactsRead, ask: CountAsk, context: CountContext): HeldDays {
  notBuilding(read);
  if (ask.of === "") {
    const today = civilDay(context.now_ms, context.settings);
    return read.held(today, today);
  }
  const days = windowOf(read, ask, context);
  return read.held(days.fromDay ?? OPEN_FROM, days.toDay);
}

export function notBuilding(read: Pick<RecordRead, "building">): void {
  const building = read.building();
  if (building === null) return;
  const left = building.days === null ? "" : `: ${building.days} days left to read`;
  refused("INDEX_BUILDING", `the counts are being made again${left}`, { building: ["facts"] });
}

function toldOf(answer: CountAnswer, ask: CountAsk, context: CountContext): CountAnswer {
  return ask.cursor === undefined && context.outside?.() === true ? { ...answer, outside: true } : answer;
}

function withFresh(answer: CountAnswer, read: RecordRead, held: HeldDays, context: CountContext): CountAnswer {
  return { ...answer, ...freshMembers(context.fresh?.(read.seq, held)) };
}

function abroadOf(read: FactsRead, ask: CountAsk, context: CountContext): Record<string, Cell>[] {
  const isDay = (value: string | undefined) => value !== undefined && /^\d{4}-\d{2}-\d{2}$/u.test(value);
  if (!isDay(ask.from) || (ask.to !== undefined && !isDay(ask.to)) || presenceIn(read, context.presence) === undefined) return [];
  const { settings } = context;
  const [fromDay, toDay] = [ask.from!, ask.to ?? civilDay(context.now_ms, settings)];
  const pieces = presenceIn(read, context.presence)!.between(dayBounds(addDays(fromDay, -1), settings).start_ms, dayBounds(toDay, settings).end_ms + DAY_MS)
    .flatMap(([start_ms, end_ms, , , zone]) => (zone === null ? [] : [{ start_ms, end_ms, zone }]));
  const byZone = new Map<string, Set<string>>();
  for (const piece of pieces) {
    if (piece.zone === settings.zone) continue;
    const local = { zone: piece.zone, day_start_hour: settings.day_start_hour };
    for (let day = civilDay(piece.start_ms, local), last = civilDay(piece.end_ms - 1, local); day <= last; day = addDays(day, 1)) {
      if (day < fromDay || day > toDay || dayBounds(day, local).start_ms === dayBounds(day, settings).start_ms) continue;
      byZone.set(piece.zone, (byZone.get(piece.zone) ?? new Set()).add(day));
    }
  }
  const stretches: Record<string, Cell>[] = [];
  for (const [zone, days] of byZone) {
    const local = { zone, day_start_hour: settings.day_start_hour };
    for (const run of runsOf([...days].sort())) {
      const [first, last = first] = run.split(" → ") as [string, string?];
      stretches.push({
        zone: plain(zone), days: plain(run),
        from: plain(instantIn(dayBounds(first, local).start_ms, zone)), to: plain(instantIn(dayBounds(last, local).end_ms, zone)),
      });
    }
  }
  return stretches.sort((left, right) => String(left.days!.value).localeCompare(String(right.days!.value)));
}

function counted(read: FactsRead, run: CountRun, context: CountContext, opened?: Opened): CountAnswer {
  const { ask, admitted } = run;
  if (ask.of === "") return catalogAnswer(read, run, context);
  const collection = context.collections.get(ask.of)!;
  const isDays = ask.of === "days";
  const range = rangeOf(ask, context);
  const bound = boundOf(read, admitted);
  const scope = opened?.scope;
  const place = opened !== undefined ? opened.place : ask.cursor === undefined ? undefined : placeOf(ask.cursor, bound);
  const listing = ask.by.includes("item") || scope !== undefined;
  const population = run.populationOf(scope);
  const { measure, partitionKey } = population;
  const groupBy = ask.by.filter((key) => key !== "item");
  const people = context.people();
  const presence = presenceIn(read, context.presence);
  const hasPeople = read.people(ask.of);
  const refs = rowRefsOf(read, ask, context.gate === undefined ? admitted.kept : heldKept(admitted, population), groupBy, context);

  const keyCell = (key: string, value: Raw): Cell => {
    if (value === null) return plain(null);
    if (key === "weekday") return plain(WEEKDAYS[Number(value)]!);
    if ((TIME_KEYS as readonly string[]).includes(key) || key === "hour" || STRUCTURE_KEYS.has(key)) return plain(value);
    if (key === "person") return personCell(String(value));
    return text(String(value));
  };
  function personCell(id: string): Cell {
    const person = people?.person(id);
    return person === undefined ? { is: "person", value: id, handle: id } : { is: "person", value: person.name, who: id };
  }
  const valueText = (of: Measure | undefined, value: number | null, currency: string | null): string | number | null => {
    if (value === null) return null;
    if (of?.unit === "currency") return decimal(value, currency ?? "");
    return round(value);
  };
  const timeCell = (shownFact: FactShown | undefined, named: Named): Cell => {
    if (isDays) return plain(named.day);
    if (shownFact === undefined) return plain(null);
    return plain(shownFact.date_only ? String(shownFact.time) : instantAt(Number(shownFact.time), false, presence, context.settings)!);
  };
  const rowN = (group: Group) => (ask.op === "count" || ask.op === "sum" ? group.n : group.valued);
  const unitHandle = (named: Named): Cell => refs.fact(named);
  const groupHandle = (group: Group): Cell => refs.row({ g: group.keys, p: group.partition }, rowN(group));
  const detailKeys = collection.keys.filter((key) => !groupBy.includes(key) && key !== partitionKey);
  const peopleColumns = hasPeople ? ["person", "people"] : [];
  const peopleCells = (shownFact: FactShown | undefined): Cell[] => {
    if (!hasPeople) return [];
    const persons = [...new Set((shownFact?.people ?? []).map((handle) => people?.idOf(handle) ?? handle))].sort();
    return [persons.length === 0 ? plain(null) : personCell(persons[0]!), plain(persons.length)];
  };

  const matched: CountAnswer["matched"] = { values: {}, person: [] };
  if (ask.from !== undefined) matched.from = range.fromDay ?? ask.from;
  if (ask.to !== undefined || ask.from !== undefined) matched.to = isDays ? population.calendar!.to : range.toDay;
  for (const [key, took] of Object.entries(admitted.took)) {
    const ids = [...new Set(took.flatMap((each) => each.names))];
    const counts = new Map<number, number>();
    const spelled = new Map<number, string>();
    if (ids.length > 0) {
      for (const row of population.matchedOf(key, ids)) {
        counts.set(row.name, row.n);
        spelled.set(row.name, row.value);
      }
    }
    matched.values[key] = took.map(({ said, names }) => ({
      said,
      values: names.filter((id) => (counts.get(id) ?? 0) > 0).map((id) => ({ value: keyCell(key, spelled.get(id)!), n: counts.get(id)! })).sort((left, right) => right.n - left.n),
    }));
  }
  if (admitted.place !== undefined) {
    matched.values.place = admitted.place.took.map(({ said, values }) => ({
      said, values: values.map((value) => ({ value: value.said, n: population.inPlace(value.ids) })).filter((value) => value.n > 0).sort((left, right) => right.n - left.n),
    }));
  }
  for (const person of admitted.kept.persons) matched.person.push({ said: person.said, is: { is: "person", value: person.name, ...(person.bare ? { handle: person.id } : { who: person.id }) } });

  const empty: Group = { keys: [], partition: null, n: 0, valued: 0, value: null, t: null };
  const totals = population.groupsOf([]);
  const all = totals.length === 0 ? [empty] : totals;
  const extreme = EXTREMES.has(ask.op) ? ask.op as Extreme : undefined;
  const counts = ask.op !== "first" && ask.op !== "last";
  const totalExtremes = extreme !== undefined ? population.extremesOf([], extreme, TIES_SHOWN) : undefined;
  const avgBounds = ask.op === "avg" ? { min: population.extremesOf([], "min", 1), max: population.extremesOf([], "max", 1) } : undefined;

  const readingNotes: Cell[] = [];
  const readings: { name: string; population: Population; totals: Map<string, number | null>; rows?: Map<string, number | null> }[] = [];
  if (measure !== undefined && !listing) {
    for (const path of measure.readings ?? []) {
      const [of, name] = path.split(".") as [string, string];
      const other = context.collections.get(of)?.measures[name];
      if (of !== ask.of || other === undefined) {
        readingNotes.push(plain(`${path}: another reading of ${ask.measure}, in ${of}: ask of=${of} measure=${name}`));
        continue;
      }
      if (!(other.ops as readonly string[]).includes(ask.op)) {
        readingNotes.push(plain(`${name}: another reading of ${ask.measure}; it takes ${other.ops.join(", ")}, not ${ask.op}`));
        continue;
      }
      readingNotes.push(plain(`${name}: another reading of ${ask.measure}, its ${ask.op} in its own column`));
      const reading = run.readingOf(name, scope, population.runs);
      const valuesOf = (set: readonly string[]) => {
        const values = new Map<string, number | null>();
        const groups = reading.groupsOf(set);
        const firstLast = ask.op === "first" || ask.op === "last" ? reading.extremesOf(set, ask.op, 1) : undefined;
        for (const group of groups) {
          const key = groupKey(group.keys, group.partition);
          values.set(key, firstLast === undefined ? group.value : firstLast.get(key)?.value ?? null);
        }
        return values;
      };
      readings.push({ name, population: reading, totals: valuesOf([]), ...(groupBy.length === 0 ? {} : { rows: valuesOf(groupBy) }) });
    }
  }

  const partitionColumn = partitionKey !== undefined && !groupBy.includes(partitionKey);
  let columns: string[];
  let shownRows: Cell[][];
  let more = false;
  let nextPlace: CountPlace | undefined;
  const rowIds: string[] = [];
  let rowPlaces: CountPlace[] | undefined;
  if (listing) {
    const page = population.items(place !== undefined && "after" in place ? place.after : undefined, ask.limit + 1);
    more = page.length > ask.limit;
    const shownItems = page.slice(0, ask.limit);
    if (more) nextPlace = { after: shownItems.at(-1)! };
    if (opened !== undefined) rowPlaces = shownItems.map((item) => ({ after: item }));
    const facts = run.factsShown(shownItems.flatMap((item) => (item.fact === null ? [] : [item.fact])));
    const measures = Object.keys(collection.measures);
    columns = [isDays ? "day" : "time", ...collection.keys, ...peopleColumns, ...measures, "ref"];
    shownRows = shownItems.map((item) => {
      const named: Named = { unit: item.unit, p: item.p, fact: item.fact, t: item.t, day: item.d, v: item.v };
      const shownFact = item.fact === null ? undefined : facts.get(item.fact);
      return [
        timeCell(shownFact, named), ...collection.keys.map((key) => keyCell(key, shownFact?.keys[key] ?? (key === partitionKey ? item.p : null))), ...peopleCells(shownFact),
        ...measures.map((name) => plain(valueText(collection.measures[name], shownFact?.measures[name] ?? null, shownFact?.keys.currency ?? null))), unitHandle(named),
      ];
    });
  } else {
    const rowsAll = groupBy.length === 0 ? [] : population.groupsOf(groupBy);
    const rowExtremes = extreme !== undefined && groupBy.length > 0 ? population.extremesOf(groupBy, extreme, TIES_SHOWN) : undefined;
    const rowBounds = ask.op === "avg" && groupBy.length > 0 ? { min: population.extremesOf(groupBy, "min", 1), max: population.extremesOf(groupBy, "max", 1) } : undefined;
    if (rowExtremes !== undefined) for (const group of rowsAll) group.value = rowExtremes.get(groupKey(group.keys, group.partition))?.value ?? null;
    sortGroups(rowsAll, groupBy, ask);
    const facts = run.factsShown([...rowExtremes?.values() ?? []].flatMap((each) => each.named.flatMap((named) => (named.fact === null ? [] : [named.fact]))));
    const runColumns = ["from_day", "to_day", "days", "guessed_days", "cities", ...admitted.place?.in === undefined ? [] : ["country"]];
    columns = [...groupBy.flatMap((key) => (key === "run" ? runColumns : [key])), ...(partitionColumn ? [partitionKey] : []), ...counts ? ["n"] : [], ...(ask.op === "count" ? [] : [ask.op, ...counts ? ["missing"] : []])];
    if (ask.op === "avg") columns.push("min", "min_day", "max", "max_day");
    if (extreme !== undefined) columns.push("tied", isDays ? "day" : "time", ...detailKeys, ...peopleColumns);
    columns.push(...readings.map((each) => each.name), "ref");
    shownRows = rowsAll.flatMap((group) => {
      const key = groupKey(group.keys, group.partition);
      const keys = group.keys.flatMap((value, at) => {
        if (groupBy[at] !== "run") return [keyCell(groupBy[at]!, value)];
        const run = population.runs!.rows.get(String(value))!;
        return [plain(run.from_day), plain(run.to_day), plain(run.days), plain(run.guessed_days), plain(run.cities.join(", ")), ...admitted.place?.in === undefined ? [] : [plain(run.country)]];
      });
      const partition = partitionColumn ? [keyCell(partitionKey, group.partition)] : [];
      const numbers = [...counts ? [plain(ask.op === "count" || ask.op === "sum" ? group.n : group.valued)] : [], ...ask.op === "count" ? [] : [plain(valueText(measure, group.value, group.partition)), ...counts ? [plain(group.n - group.valued)] : []]];
      const readingCells = readings.map((each) => plain(valueText(each.population.measure, each.rows?.get(key) ?? null, group.partition)));
      if (rowBounds !== undefined) {
        const low = rowBounds.min.get(key)?.named[0], high = rowBounds.max.get(key)?.named[0];
        numbers.push(plain(valueText(measure, low?.v ?? null, group.partition)), plain(low?.day ?? null), plain(valueText(measure, high?.v ?? null, group.partition)), plain(high?.day ?? null));
      }
      const rowHandle = groupHandle(group);
      if (rowExtremes === undefined) {
        rowIds.push(key);
        return [[...keys, ...partition, ...numbers, ...readingCells, rowHandle]];
      }
      const found = rowExtremes.get(key);
      if (found === undefined) {
        rowIds.push(key);
        return [[...keys, ...partition, ...numbers, plain(0), plain(null), ...detailKeys.map(() => plain(null)), ...peopleCells(undefined), ...readingCells, rowHandle]];
      }
      return found.named.map((named) => {
        rowIds.push(JSON.stringify([key, named.unit, named.fact]));
        const shownFact = named.fact === null ? undefined : facts.get(named.fact);
        return [...keys, ...partition, ...numbers, plain(found.tied), timeCell(shownFact, named), ...detailKeys.map((name) => keyCell(name, shownFact?.keys[name] ?? null)), ...peopleCells(shownFact), ...readingCells, unitHandle(named)];
      });
    });
    const given = place !== undefined && "o" in place ? place.o : 0;
    if (given > 0 && rowsGiven(rowIds, given) !== (place as { h: string }).h) expiredPage();
    more = given + ask.limit < shownRows.length;
    if (more) nextPlace = { o: given + ask.limit, h: rowsGiven(rowIds, given + ask.limit) };
    shownRows = shownRows.slice(given, given + ask.limit);
  }

  const totalFacts = run.factsShown([...totalExtremes?.values() ?? []].flatMap((each) => each.named.flatMap((named) => (named.fact === null ? [] : [named.fact]))));
  const total = all.map((group) => {
    const key = groupKey([], group.partition);
    const partition = partitionKey === undefined ? undefined : keyCell(partitionKey, group.partition);
    const found = totalExtremes?.get(key);
    const value = valueText(measure, extreme === undefined ? group.value : found?.value ?? null, group.partition);
    const withCurrency = (shownValue: string | number | null) => plain(typeof shownValue === "string" && group.partition !== null ? `${shownValue} ${group.partition}` : shownValue);
    const cells: Record<string, Cell | Record<string, Cell>[]> = counts ? { n: plain(ask.op === "count" || ask.op === "sum" ? group.n : group.valued) } : {};
    if (ask.op !== "count") cells[ask.op] = withCurrency(value);
    if (avgBounds !== undefined) {
      const low = avgBounds.min.get(key)?.named[0], high = avgBounds.max.get(key)?.named[0];
      Object.assign(cells, {
        min: withCurrency(valueText(measure, low?.v ?? null, group.partition)), min_day: plain(low?.day ?? null),
        max: withCurrency(valueText(measure, high?.v ?? null, group.partition)), max_day: plain(high?.day ?? null),
      });
    }
    if (extreme !== undefined) {
      cells.tied = plain(found?.tied ?? 0);
      cells.facts = (found?.named ?? []).map((named) => {
        const shownFact = named.fact === null ? undefined : totalFacts.get(named.fact);
        const peopleShown = peopleCells(shownFact);
        return {
          [isDays ? "day" : "time"]: timeCell(shownFact, named), ...(isDays ? {} : { day: plain(named.day) }), ...Object.fromEntries(collection.keys.filter((name) => name !== partitionKey).map((name) => [name, keyCell(name, shownFact?.keys[name] ?? null)])),
          ...(hasPeople ? { person: peopleShown[0]!, people: peopleShown[1]! } : {}), value: withCurrency(valueText(measure, named.v, group.partition)), ref: unitHandle(named),
        };
      });
    }
    for (const each of readings) cells[each.name] = withCurrency(valueText(each.population.measure, each.totals.get(key) ?? null, group.partition));
    if (readings.length > 0 && measure !== undefined) {
      const said = [{ name: ask.measure!, of: measure, value: extreme === undefined ? group.value : found?.value ?? null }, ...readings.map((each) => ({ name: each.name, of: each.population.measure, value: each.totals.get(key) ?? null }))];
      cells.said = plain(`${ask.op}: ${said.map((each) => `${measureWords(each.name, each.of)} ${amountWords(each.of, each.value, group.partition)}`).join("; ")}`);
    }
    cells.ref = refs.row({ t: { p: group.partition } }, rowN(group));
    return { ...(partition === undefined ? {} : { partition }), cells };
  });
  const whole = all.length < 2 ? undefined : refs.row(undefined, all.reduce((sum, group) => sum + rowN(group), 0));

  let population_: CountAnswer["population"];
  const countsOf = (group: Group): Record<string, Cell> => ({ facts: plain(group.n), ...measure === undefined ? {} : { valued: plain(group.valued), missing: plain(group.n - group.valued) } });
  const excluded = counts ? run.excludedOf(population) : {};
  if (!counts) {
    population_ = {};
  } else if (isDays && measure !== undefined) {
    const unvalued = population.unvalued();
    const each = all.map((group) => ({
      ...(partitionKey === undefined ? {} : { [partitionKey]: keyCell(partitionKey, group.partition) }), ...countsOf(group),
      missing_days: plain(runsOf(unvalued.filter((row) => (row.p ?? null) === group.partition).map((row) => row.unit)).join(", ")),
    }));
    population_ = partitionKey === undefined ? { ...each[0]!, excluded } : { by: each, excluded };
  } else {
    const summed = all.reduce((sum, group) => ({ ...sum, n: sum.n + group.n, valued: sum.valued + group.valued }), empty);
    population_ = { ...countsOf(summed), excluded };
  }
  if (counts && !listing && groupBy.length > 0) population_.overlap = plain(population.overlapOf(groupBy));

  const held = heldOf(ask, population, range, all.every((group) => group.n === 0 || (measure !== undefined && group.valued === 0)));
  const covered = counts ? population.coversOf() : [];
  const covers = covered.map((row) => text(`${row.source}, read to ${row.last}`));
  const abroad = abroadOf(read, ask, context);
  const there = daysThere(read, context, ask, admitted, population.calendar);
  return {
    asked: text(askedWords(ask, measure, partitionKey, scope, collection)), matched, ...(abroad.length === 0 ? {} : { abroad }),
    ...(there === undefined ? {} : { days_there: there.said, there: there.days }), population: population_, ...(held === undefined ? {} : { held: held.said, heldDays: held.days }), covers,
    ...(counts ? { counted: text(countedWords(ask.of, covered, context)) } : {}),
    ...(readingNotes.length === 0 ? {} : { readings: readingNotes }),
    total, ...(whole === undefined ? {} : { whole }), ...(partitionKey === undefined ? {} : { partitionKey }), columns, rows: shownRows,
    next: more ? { is: "ref", value: nextOf(ask, bound, nextPlace!) } : null,
    ...(opened === undefined || !more ? {} : { place: nextPlace! }), ...(rowPlaces === undefined ? {} : { places: rowPlaces }),
  };
}

const rowsGiven = (ids: readonly string[], n: number): string => digest([...ids.slice(0, n)].sort() as unknown as Json).slice(7, 31);

function expiredPage(): never {
  return refused("CURSOR_EXPIRED", "the groups this count gave no longer lead it: the record moved since this page was given, ask again");
}

interface Opened {
  scope: Scope | undefined;
  place: CountPlace | undefined;
}

function daysThere(read: FactsRead, context: CountContext, ask: CountAsk, admitted: Admitted, calendar: { from: string; to: string } | undefined): { said: Cell; days: NonNullable<CountAnswer["there"]> } | undefined {
  const kept = admitted.place?.in;
  if (kept === undefined || (ask.of !== "days" && ask.by[0] !== "run") || calendar === undefined) return undefined;
  const settings = context.settings;
  const { days, zones } = placeDaysOf(presenceOrRefuse(read, context), kept, calendar.from, calendar.to, settings);
  const list = [...days.keys()];
  if (zones.length === 0 || list.length === 0) return undefined;
  const span = list.length === 1 ? list[0]! : `${list[0]!} → ${list.at(-1)!}`;
  return {
    said: plain(`each day counted is the place's own civil day, as its clock keeps it (${zones.join(", ")}): ${span}`),
    days: { zone: zones.join(", "), first: list[0]!, last: list.at(-1)! },
  };
}

function countedWords(of: string, covered: readonly { source: string; last: string }[], context: CountContext): string {
  if (covered.length === 0) return `counted from ${of}: no source states one in the range under these filters`;
  const through = new Map<string, number>();
  try {
    for (const family of context.familiesOf?.(of) ?? []) {
      for (const source of context.sources?.(family) ?? []) if (source.read_through_ms !== null) through.set(source.id, source.read_through_ms);
    }
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    through.clear();
  }
  const read = (row: { source: string; last: string }) => {
    const ms = through.get(row.source);
    return ms === undefined ? `last matching fact ${row.last}` : `read to ${civilDay(ms, context.settings)}`;
  };
  const sources = covered.length === 1 ? `${covered[0]!.source} states them, ${read(covered[0]!)}`
    : `${listed(covered.map((row) => `${row.source} (${read(row)})`))} state them`;
  return `counted from ${of} as ${sources}`;
}

function listed(words: readonly string[]): string {
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

function measureWords(name: string, of: Measure | undefined): string {
  const unit = of?.unit ?? "";
  return (unit !== "" && name.endsWith(`_${unit}`) ? name.slice(0, -unit.length - 1) : name).replaceAll("_", " ");
}

function amountWords(of: Measure | undefined, value: number | null, currency: string | null): string {
  if (value === null) return "none stated";
  if (of?.unit === "currency") return `${decimal(value, currency ?? "")}${currency === null ? "" : ` ${currency}`}`;
  if (of?.unit === "min") {
    const minutes = Math.round(value);
    return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  }
  return `${round(value)}${of === undefined ? "" : ` ${of.unit}`}`;
}

function withAlso(answer: CountAnswer, read: RecordRead, ask: CountAsk, kept: Kept, context: CountContext): CountAnswer {
  const also = alsoOf(read, ask, kept, context);
  return also.length === 0 ? answer : { ...answer, also };
}

function alsoOf(read: RecordRead, ask: CountAsk, kept: Kept, context: CountContext): Cell[] {
  const own = context.familiesOf?.(ask.of);
  if (own === undefined || context.families === undefined || ask.of === "" || ask.cursor !== undefined) return [];
  const carried = clausesOf(ask, kept, context);
  if (carried === undefined) return [];
  const reach = `the same ${listed(carried.named)} ${carried.named.length === 1 && carried.named[0] !== "words" ? "reaches" : "reach"}`;
  const found = reached(read, carried.clauses, context.families, own);
  if (found === "unread") return [plain(`what else ${reach} in the range was not read: search them`)];
  return found.map((each) => {
    const n = `${each.capped ? "at least " : ""}${each.n} ${each.family} ${each.n === 1 ? "entry" : "entries"}`;
    const days = each.first === undefined ? "" : `, ${each.first} → ${each.last}${each.capped ? " as far as counted back from the newest" : ""}`;
    return plain(`the record also holds ${n} ${reach} in the range${days}: ${ALSO_DO}`);
  });
}

const ALSO_DO = "the same kind of thing, held elsewhere: read it, add what these rows do not already hold, and give the whole first";

function clausesOf(ask: CountAsk, kept: Kept, context: CountContext): { clauses: Clauses; named: string[] } | undefined {
  const groups = ownPhrases(ask);
  const words = groups.some((group) => !group.negated) ? groups : undefined;
  const who = kept.handles === undefined ? undefined : [...new Set(kept.handles.map((handle) => handleOfId(handle)?.value ?? handle))];
  const chats = ask.chat === undefined ? undefined : [context.chat?.(ask.chat) ?? ask.chat];
  const named = [...words === undefined ? [] : ["words"], ...who === undefined ? [] : ["person"], ...chats === undefined ? [] : ["chat"]];
  if (named.length === 0) return undefined;
  const range = rangeOf(ask, context);
  return {
    clauses: { ...words === undefined ? {} : { words }, ...who === undefined ? {} : { who }, ...chats === undefined ? {} : { chats }, ...range.from_ms === undefined ? {} : { from_ms: range.from_ms }, to_ms: range.to_ms },
    named,
  };
}

function ownPhrases(ask: CountAsk): Phrases[] {
  const groups: Phrases[] = [];
  for (const [key, written] of Object.entries(ask.match)) {
    if (!STRUCTURE_KEYS.has(key)) groups.push(...phraseGroups(matchTermsOf(written).map((term, at) => ({ text: term.text, negated: term.negated, or: at > 0 }))));
  }
  if (ask.words !== undefined) groups.push(...phraseGroups(termsOf(ask.words)));
  if (ask.place !== undefined) groups.push(...phraseGroups(placeTermsOf(ask.place).filter((term) => !term.negated).map((term, at) => ({ text: term.text, negated: false, or: at > 0 }))));
  return groups;
}

function sortGroups(rows: Group[], by: readonly string[], ask: CountAsk): void {
  const sizeOf = (group: Group) => (ask.op === "count" ? group.n : group.value ?? -Infinity);
  const byPartition = (left: Group, right: Group) => ((left.partition ?? "") < (right.partition ?? "") ? -1 : (left.partition ?? "") > (right.partition ?? "") ? 1 : 0);
  if (ask.order === "value") {
    rows.sort((left, right) => sizeOf(right) - sizeOf(left) || byPartition(left, right));
    return;
  }
  if (ask.order === "time") {
    rows.sort((left, right) => (left.t === right.t ? byPartition(left, right) : left.t === null ? 1 : right.t === null ? -1 : left.t < right.t ? -1 : 1));
    return;
  }
  const timeAt = by.map((key) => (TIME_KEYS as readonly string[]).includes(key) || key === "run");
  const sizes = by.map((_, at) => {
    const sized = new Map<Raw, number>();
    for (const group of rows) sized.set(group.keys[at] ?? null, (sized.get(group.keys[at] ?? null) ?? 0) + (ask.op === "count" ? group.n : group.value ?? 0));
    return sized;
  });
  rows.sort((left, right) => {
    for (let at = 0; at < by.length; at++) {
      const a = left.keys[at] ?? null, b = right.keys[at] ?? null;
      if (a === b) continue;
      if (timeAt[at]) return a === null ? 1 : b === null ? -1 : a < b ? -1 : 1;
      const difference = sizes[at]!.get(b)! - sizes[at]!.get(a)!;
      if (difference !== 0) return difference;
      return String(a) < String(b) ? -1 : 1;
    }
    return byPartition(left, right);
  });
}

function heldOf(ask: CountAsk, population: Population, range: Range, empty: boolean): { said: Cell; days: { first: string; last: string } | null } | undefined {
  const what = ask.measure ?? ask.of;
  const words = ask.words === undefined ? "" : ", whatever the words; search the words for their own first and last day";
  const { first, last, unknown } = population.edges();
  if (unknown === true) return undefined;
  if (first === undefined || last === undefined) return { said: plain(`${what}: nothing held under ${ask.words === undefined ? "these" : "the other"} filters${words}`), days: null };
  if (!empty && !(range.fromDay !== undefined && range.fromDay < first) && !(ask.to !== undefined && range.toDay > last)) return undefined;
  return { said: plain(`${what} ${first} → ${last}${words}`), days: { first, last } };
}

function catalogAnswer(read: FactsRead, run: CountRun, context: CountContext): CountAnswer {
  const catalog: Record<string, CatalogEntry> = {};
  const today = civilDay(context.now_ms, context.settings);
  const firstHeld = run.firstHeld();
  const days = context.collections.get("days");
  const stated = days === undefined ? new Map() : run.stated(Object.keys(days.measures));
  for (const of of [...context.collections.keys()].sort()) {
    const collection = context.collections.get(of)!;
    const people = read.people(of);
    const measures: CatalogEntry["measures"] = {};
    const statedOf: NonNullable<CatalogEntry["stated"]> = {};
    for (const [name, measure] of Object.entries(collection.measures)) {
      const entry: Record<string, Cell | Cell[]> = { unit: plain(measure.unit), ops: measure.ops.map((op) => plain(op)) };
      if (measure.readings !== undefined) entry.readings = measure.readings.map((each) => plain(each));
      if (of === "days" && stated !== "unknown") {
        const on = stated.get(name);
        statedOf[name] = on === undefined ? null : { first: on.first, last: on.last, n: on.n };
        entry.held = plain(on === undefined ? "none" : `${on.first} → ${on.last}, ${on.n} of ${Math.round((Date.parse(`${on.last}T00:00:00Z`) - Date.parse(`${on.first}T00:00:00Z`)) / 86_400_000) + 1} days`);
      }
      measures[name] = entry;
    }
    const ends = of === "days" ? undefined : run.days(of);
    const first = of === "days" ? firstHeld : ends?.first;
    const last = of === "days" ? today : ends?.last;
    catalog[of] = {
      ...collection.about === undefined ? {} : { about: plain(collection.about) },
      keys: [...collection.keys, ...people ? ["person"] : []].map((key) => plain(key)), measures,
      held: plain(first === undefined ? "none" : `${first} → ${last!}`), days: first === undefined ? null : { first, last: last! },
      ...of === "days" && stated !== "unknown" ? { stated: statedOf } : {},
    };
  }
  const families: Record<string, FamilyEntry> = {};
  const gate = context.gate;
  const allowedFirst = gate === undefined ? undefined : new Map(read.families([ASK_PRODUCT], gate).map(({ family, first }) => [family, first]));
  for (const { family, first: whole } of read.families([ASK_PRODUCT])) {
    const first = allowedFirst === undefined ? whole : allowedFirst.get(family);
    const held = (context.sources?.(family) ?? []).filter((source) => source.product !== ASK_PRODUCT);
    const read_through = (source: (typeof held)[number]) => source.read_through_ms === null || (gate !== undefined && !gate.allows(accountOf(source.id), source.read_through_ms, false)) ? 0 : source.read_through_ms;
    const through = Math.max(0, ...held.map(read_through));
    families[family] = {
      products: [...new Set(held.map((source) => source.product))].sort().map((product) => plain(product)),
      ...first === undefined ? {} : { first: plain(first) }, ...through === 0 ? {} : { read_through: plain(civilDay(through, context.settings)) },
    };
  }
  return {
    asked: plain(`the catalog: each collection with its keys, its measures and the days held; group by ${TIME_KEYS.join(", ")}, a key, or item alone`),
    matched: { values: {}, person: [] }, population: {}, total: [], columns: [], rows: [], next: null, families, catalog,
  };
}

function runsOf(days: readonly string[]): string[] {
  const runs: string[] = [];
  let start: string | undefined, last: string | undefined;
  for (const day of days) {
    if (last !== undefined && addDays(last, 1) === day) {
      last = day;
      continue;
    }
    if (start !== undefined) runs.push(start === last ? start : `${start} → ${last}`);
    start = last = day;
  }
  if (start !== undefined) runs.push(start === last ? start : `${start} → ${last!}`);
  return runs;
}

function askedWords(ask: CountAsk, measure: Measure | undefined, partitionKey: string | undefined, scope?: Scope, collection?: Collection): string {
  const groupBy = ask.by.filter((key) => key !== "item");
  const what = ask.op === "count" ? `count of ${ask.of}` : `${ask.op} of ${ask.measure} over ${ask.of}`;
  const parts = [scope === undefined ? what : `the ${ask.of} behind ${"u" in scope ? "one fact" : "t" in scope ? "the total" : "one row"} of: ${what}`];
  if (collection?.about !== undefined) parts.push(`${ask.of}: ${collection.about}`);
  if (ask.by.includes("item")) parts.push(`the ${ask.of} themselves, each with its keys and measures${ask.order === "value" ? `, largest ${ask.measure} first` : ", earliest first"}`);
  else if (groupBy.length > 0) parts.push(`by ${groupBy.join(" and ")}${groupBy.includes("person") ? " (a thing with several people is under each, and once in the total)" : ""}`);
  if (EXTREMES.has(ask.op)) parts.push(`the ${ask.op === "first" || ask.op === "last" ? `${ask.op} fact stating it` : `${ask.op === "min" ? "least" : "most"} a fact states`}, its time, keys and handle; a tie shows ${TIES_SHOWN} and counts the rest; a fact stating none is never one`);
  if (ask.op === "avg") parts.push("with the least and the most a fact states, and their days");
  if (partitionKey !== undefined) parts.push(partitionKey === "currency" ? "each currency apart, never converted" : `each ${partitionKey} apart: its own reading, never one chosen`);
  if (ask.at_least !== undefined || ask.at_most !== undefined) parts.push(`${ask.measure} of the fact whole${ask.at_least === undefined ? "" : ` at least ${ask.at_least}`}${ask.at_least !== undefined && ask.at_most !== undefined ? " and" : ""}${ask.at_most === undefined ? "" : ` at most ${ask.at_most}`}`);
  if (ask.op === "sum" && measure?.split === "clock") parts.push("a thing that crosses a day's edge or the range's is summed by its share inside it");
  if (ask.of === "days") parts.push("every civil day counts, a day that states nothing is missing");
  if (ask.place !== undefined) parts.push(`${ask.of === "days" ? "days" : `${ask.of} at times the person was`} in the place asked, as matched.place names it (a day that touched two places is in both; a moment the person could not have reached is no day there)`);
  if (groupBy.some((key) => joinedPlace(key, ask.of, collection?.keys ?? []))) parts.push("a day or a thing is in each place it touched, so it may sit in two rows (overlap counts them) and once in the total");
  if (groupBy.includes("run")) parts.push(`unbroken runs of civil days that hold a match${ask.place === undefined ? "" : " (a trip)"}: a day only guessed continues a run and is counted apart; a day elsewhere ends it; no month or year edge does`);
  if (groupBy.includes("hour")) parts.push("hour in the local time where the person was, the home's where it is not known");
  if (ask.chat !== undefined) parts.push("in the chat asked");
  if (ask.person.length > 1) parts.push("with any of the people named");
  return parts.join(", ");
}


export function countAttached(ask: CountAsk, context: Pick<CountContext, "collections" | "presence">): Record<string, Attached> {
  return dependsOn(ask, context.collections).presence === null ? {} : presenceAttached(context.presence);
}

export interface Snapshot {
  index: string;
  people: string | null;
  presence: string | null;
}

function snapshotOf(read: FactsRead, ask: CountAsk, context: CountContext): Snapshot {
  const depends = dependsOn(ask, context.collections);
  return {
    index: read.revision,
    people: depends.people === null ? null : (depends.people === "needs" ? peopleOrRefuse(context) : context.people())?.version ?? null,
    presence: depends.presence === null ? null : (depends.presence === "needs" ? presenceOrRefuse(read, context) : presenceIn(read, context.presence))?.version ?? null,
  };
}

const sameSnapshot = (left: Snapshot, right: Snapshot) => left.index === right.index && left.people === right.people && left.presence === right.presence;


function boundOf(read: FactsRead, admitted: Admission): Bound {
  return { index: read.file, facts: read.factsBuild, resolved: populationKey(admitted) };
}

function populationKey(admitted: Admission): string {
  const { persons, took: _took, place, ...kept } = admitted.kept;
  return resolvedOf({
    ...kept, persons: persons.map((person) => [...person.handles]),
    ...(place === undefined ? {} : { place: { ...(place.in === undefined ? {} : { in: place.in }), out: place.out } }),
  } as unknown as Json);
}

function nextOf(ask: CountAsk, bound: Bound, place: CountPlace): string {
  return sealed("count", Buffer.from(JSON.stringify({ p: place }), "utf8"), { ...ask.asked, limit: ask.limit }, bound);
}

function placeOf(written: string, bound: Bound): CountPlace | undefined {
  const notOurs = (): never => bad("cursor is a page's next, as count gave it");
  const cursor = envelopeOpened(written, ["count"]);
  let token: { p?: unknown };
  try {
    token = JSON.parse(cursor.place.rest().toString("utf8")) as { p?: unknown };
  } catch (error) {
    if (error instanceof SyntaxError) return notOurs();
    throw error;
  }
  const isPlace = (place: unknown) => typeof place === "object" && place !== null
    && ((Number.isSafeInteger((place as { o?: unknown }).o) && typeof (place as { h?: unknown }).h === "string")
      || (typeof (place as { after?: unknown }).after === "object" && (place as { after?: unknown }).after !== null));
  if (typeof token !== "object" || token === null || (token.p !== undefined && !isPlace(token.p))) notOurs();
  cursor.check({ index: () => bound.index, facts: () => bound.facts, resolved: () => bound.resolved });
  return token.p as CountPlace | undefined;
}

const SCREEN_UNREAD = "the screen's text is not in the catalog: search it (lists screen) for what it showed";

export function countShown(answer: CountAnswer, ask: CountAsk, pieces = false): CountResult | CountFound | CountCatalog {
  const value = (cell: Cell) => cell.value;
  const shownCell = (cell: Cell) => (pieces && cell.is === "person" && cell.who !== undefined ? { text: String(cell.value), who: cell.who } : cell.value);
  const words = (cell: Cell) => String(cell.value ?? "");
  const fresh = freshShown(answer) as Pick<CountResult, "as_of" | "pending" | "pending_more">;
  const told = answer.outside === true ? { outside: true as const } : {};
  if (answer.catalog !== undefined) {
    return {
      families: Object.entries(answer.families ?? {}).filter(([family]) => (FAMILIES as readonly string[]).includes(family)).map(([family, entry]) => ({
        family: family as CountCatalog["families"][number]["family"], products: entry.products.map(words),
        held: entry.first === undefined ? null : { first: words(entry.first), last: words(entry.read_through ?? entry.first) },
      })),
      collections: Object.entries(answer.catalog).map(([of, entry]) => ({
        of, keys: entry.keys.map(words),
        measures: Object.entries(entry.measures).map(([measure, about]) => {
          const on = entry.stated?.[measure];
          return {
            measure, unit: words(about.unit as Cell),
            ...(Array.isArray(about.ops) && about.ops.some((op) => op.value === "sum") ? { sums: true as const } : {}),
            ...(Array.isArray(about.readings) ? { readings: about.readings.map(words) } : {}),
            ...(on === undefined ? {} : { held: on === null ? null : { first: on.first, last: on.last }, ...(on === null ? {} : { stated: on.n }) }),
          };
        }),
        held: entry.days,
        ...(entry.about === undefined ? {} : { about: words(entry.about) }),
      })),
      screen: { unread: SCREEN_UNREAD },
      ...(fresh.as_of === undefined ? {} : { as_of: fresh.as_of }), ...told,
    };
  }
  const matched: Record<string, string | Record<string, string[]>> = {};
  if (answer.matched.from !== undefined) matched.from = answer.matched.from;
  if (answer.matched.to !== undefined) matched.to = answer.matched.to;
  for (const [key, terms] of Object.entries(answer.matched.values)) matched[key] = Object.fromEntries(terms.map(({ said, values }) => [words(said), values.map((each) => `${words(each.value)} (${each.n})`)]));
  if (answer.matched.person.length > 0) matched.person = Object.fromEntries(answer.matched.person.map((each) => [words(each.said), [words(each.is)]]));
  const said = {
    ...(Object.keys(matched).length === 0 ? {} : { matched }),
    ...(answer.heldDays === undefined ? {} : { held: answer.heldDays }),
    ...(answer.readings === undefined ? {} : { readings: answer.readings.map(words) }),
  };
  type Fact = Record<string, Cell>;
  const factsOf = (each: CountAnswer["total"][number]) => (Array.isArray(each.cells.facts) ? each.cells.facts as Fact[] : []);
  const timeOf = (fact: Fact) => {
    const time = words(fact.time ?? fact.day ?? plain(null));
    return time.includes("T") ? Date.parse(time) : Date.parse(`${time}T00:00:00Z`);
  };
  const factWords = (fact: Fact) => Object.entries(fact).filter(([name]) => !["time", "day", "ref", "value", "people"].includes(name)).map(([, cell]) => cell.value).filter((each) => each !== null && each !== "").join(", ");
  if (ask.op === "first" || ask.op === "last") {
    const facts = answer.total.flatMap((each) => factsOf(each).map((fact) => ({ fact, tied: Number(value(each.cells.tied as Cell) ?? 0), shown: factsOf(each).length })));
    const sorted = [...facts].sort((left, right) => (ask.op === "first" ? timeOf(left.fact) - timeOf(right.fact) : timeOf(right.fact) - timeOf(left.fact)));
    const foundOf = (fact: Fact, note = "") => {
      const time = words(fact.time ?? fact.day ?? plain(null));
      const what = [factWords(fact), note].filter((each) => each !== "").join("; ");
      return {
        value: value(fact.value!) as string | number, ref: words(fact.ref!), ...(time.includes("T") ? { at: time } : {}),
        day: words(fact.day ?? fact.time!).slice(0, 10), ...(what === "" ? {} : { said: what }),
      };
    };
    const first = sorted[0];
    const ties = first === undefined ? [] : sorted.slice(1).filter((each) => timeOf(each.fact) === timeOf(first.fact));
    const untold = first !== undefined && first.tied > first.shown ? `${first.tied} facts at that time, ${first.shown} given` : "";
    const rows = answer.rows.length === 0 ? {} : { columns: answer.columns, rows: answer.rows.map((row) => row.map(shownCell)) as NonNullable<CountFound["rows"]>, next: answer.next === null ? null : words(answer.next) };
    return {
      asked: words(answer.asked), op: ask.op, found: first === undefined ? null : foundOf(first.fact, untold),
      ...(ties.length === 0 ? {} : { ties: ties.map((each) => foundOf(each.fact)) }), ...said, ...rows, ...fresh, ...told,
    };
  }
  const population = answer.population as Record<string, Cell | Record<string, number> | Record<string, Cell>[]>;
  const parts = Array.isArray(population.by) ? population.by as Record<string, Cell>[] : [population as Record<string, Cell>];
  const sum = (name: string) => parts.reduce((total, part) => total + Number(value(part[name] ?? plain(0)) ?? 0), 0);
  const facts = sum("facts");
  const valued = parts.every((part) => part.valued === undefined) ? facts : sum("valued");
  const shared = population.overlap === undefined ? undefined : Number(value(population.overlap as Cell));
  const totals = answer.total;
  const own = (each: CountAnswer["total"][number], name: string) => each.cells[name] as Cell | undefined;
  const perPartition = (name: string) => totals.map((each) => {
    const shown = value(own(each, name) ?? plain(null));
    return typeof shown === "number" && each.partition !== undefined ? `${shown} (${words(each.partition)})` : String(shown);
  }).join("; ");
  const amountOf = (name: string): string | number | undefined => {
    if (totals.every((each) => own(each, name) === undefined)) return undefined;
    if (totals.length === 1) return value(own(totals[0]!, name)!) as string | number;
    return perPartition(name);
  };
  const saidOf = (each: CountAnswer["total"][number]) => {
    const parts = [own(each, "said") === undefined ? "" : words(own(each, "said")!)];
    if (own(each, "min_day") !== undefined) parts.push(`the least ${words(own(each, "min")!)} on ${words(own(each, "min_day")!)}, the most ${words(own(each, "max")!)} on ${words(own(each, "max_day")!)}`);
    const tied = own(each, "tied");
    if (tied !== undefined && Number(tied.value) > factsOf(each).length) parts.push(`${words(tied)} facts hold it, ${factsOf(each).length} listed`);
    const line = parts.filter((part) => part !== "").join("; ");
    return line === "" ? "" : totals.length > 1 && each.partition !== undefined ? `${words(each.partition)}: ${line}` : line;
  };
  const totalSaid = totals.map(saidOf).filter((each) => each !== "").join("; ");
  const ref = totals.length === 1 ? own(totals[0]!, "ref") : answer.whole;
  const n = totals.reduce((count, each) => count + Number(value(own(each, "n") ?? plain(0)) ?? 0), 0);
  const total = totals.length === 0 ? undefined : {
    n, ...(ref === undefined ? {} : { ref: words(ref) }), ...(totalSaid === "" ? {} : { said: totalSaid }),
    ...Object.fromEntries((["sum", "avg", "min", "max"] as const).flatMap((name) => {
      const amount = amountOf(name);
      return amount === undefined || amount === null ? [] : [[name, amount]];
    })),
  };
  let { columns, rows }: { columns: string[]; rows: unknown[][] } = { columns: answer.columns, rows: answer.rows.map((row) => row.map(shownCell)) };
  if (ask.by.length === 0) {
    const partitioned = totals.some((each) => each.partition !== undefined);
    const partition = partitioned ? [answer.partitionKey ?? "partition"] : [];
    const at = (each: CountAnswer["total"][number]) => (partitioned ? [each.partition === undefined ? null : value(each.partition)] : []);
    if (totals.some((each) => factsOf(each).length > 0)) {
      const named = [...new Set(totals.flatMap((each) => factsOf(each).flatMap((fact) => Object.keys(fact))))].filter((name) => name !== "ref");
      columns = [...partition, ...named, "ref"];
      rows = totals.flatMap((each) => factsOf(each).map((fact) => [...at(each), ...named.map((name) => shownCell(fact[name] ?? plain(null))), value(fact.ref!)]));
    } else {
      const named = ["n", ...ask.op === "count" ? [] : [ask.op]];
      columns = [...partition, ...named, "ref"];
      rows = totals.map((each) => [...at(each), ...named.map((name) => value(own(each, name) ?? plain(null))), value(own(each, "ref") ?? plain(null))]);
    }
  }
  const abroad = (answer.abroad ?? []).map((each) => `${words(each.days!)} in ${words(each.zone!)} are other instants there: ask from ${words(each.from!)} to ${words(each.to!)}`);
  const counted = answer.counted === undefined ? undefined : [words(answer.counted), ...abroad.length === 0 ? [] : [`the days asked are the home's; ${abroad.join("; ")}`]].join("; ");
  return {
    asked: words(answer.asked), ...said,
    population: { facts, valued, missing: facts - valued, excluded: (population.excluded ?? {}) as Record<string, number>, ...(shared === undefined ? {} : { shared }) },
    counted: counted ?? `counted from ${ask.of}`,
    ...(answer.also === undefined ? {} : { also: answer.also.map(words) }),
    ...(answer.there === undefined ? {} : { days_there: answer.there }),
    ...(total === undefined ? {} : { total }),
    columns, rows: rows as CountResult["rows"],
    ...fresh, ...told,
    next: answer.next === null ? null : words(answer.next),
  };
}

function freshShown(answer: CountAnswer): Record<string, unknown> {
  return {
    ...(answer.as_of === undefined ? {} : { as_of: answer.as_of }),
    ...(answer.pending === undefined ? {} : { pending: answer.pending }),
    ...(answer.pending_more === undefined ? {} : { pending_more: answer.pending_more }),
  };
}


export function decimal(minor: number, currency: string): string {
  const digits = heldDigits(currency);
  const sign = minor < 0 ? "-" : "";
  const whole = Math.abs(Math.round(minor)).toString().padStart(digits + 1, "0");
  return digits === 0 ? `${sign}${whole}` : `${sign}${whole.slice(0, -digits)}.${whole.slice(-digits)}`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
