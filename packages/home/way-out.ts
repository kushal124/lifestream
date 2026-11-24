import {
  accountOf, baseOf, bracketHeld, hides, hidesAny, placeholderSpans, placeholderSpelling, restoreDetails, wordMarks,
  TYPES, type DetailType, type Level, type Mark, type PlaceholderTable, type Quote, type Piece, type Restored, type Type, type Wanted,
} from "@lifestreamprotocol/core";
import { tallyOf, type CallItem, type Came, type OutboundRef } from "@lifestreamprotocol/model";
import { idType, ownNames, type HiddenText, type HomeAccount, type NameTable, type Seal, type Text } from "@lifestreamprotocol/privacy";
import type { MatchTerm } from "./counting.js";
import type { ValueMarks } from "./marking.js";
import { makeRef, readRef } from "./refs.js";
import { refused } from "./refusal.js";
import { argsOf, countAnswer, CURSOR_PARAMS, HANDLE, leavesOf, readAnswer, ROUTES, searchAnswer, searchPeopleAnswer, TOOL_ROUTES, type Leaf, type Leaves, type Shape } from "./search-contract.js";
import type { TermLines } from "./screen-query.js";
import {
  matchesRaw, matchFold, matchTermsOf, plainSnippet, snippetAt, spansOf, STRUCTURE_KEYS, termsOf, tokens, wordsIn, wordsOfTerms,
  type ReadTerm, type Span, type Term,
} from "./search-words.js";
import { admit, ALWAYS, TRIES, walkEndOf, type Candidates, type Snapshot, type Stands } from "./count.js";
import type { Admission } from "./counting.js";
import type { Step, Stepped } from "./reads.js";
import { ROUND_WIDTH, SEARCH_LIMIT, type Copies, type MeaningLent, type Widened } from "./search-route.js";

const WITHHELD_UNREAD = "This search is withheld: its words cannot be read for hidden details yet. Ask again in a few minutes.";

const WITHHELD_TERMS = "This search is withheld: each word it must find could tell where a hidden detail is, so none was searched.";

export const WITHHELD_COUNT_UNREAD = "This number is withheld: a value it reaches cannot be read for hidden details yet. Ask again in a few minutes.";

export type Hide = (texts: readonly Text[]) => Promise<{ texts: readonly HiddenText[] } | { wait: string }>;

export interface Sealing {
  seal: Seal;
  open: Hide;
}

type TableOf = PlaceholderTable | ((wanted: Wanted) => PlaceholderTable | Promise<PlaceholderTable>);

export interface Placed {
  type: DetailType;
  who?: string;
  words: string;
  placeholder: string;
}

export type Part = { placeholder: string } | { text: string; words: string[] };

export interface Written {
  written: string;
  read: string;
  as: "placeholder" | "person" | "guess" | "handle";
  type?: DetailType;
  who?: string;
}

export interface Query {
  terms: Term[];
  placed: (Placed | null)[];
  parts: (Part[] | null)[];
  written: string[];
  shown: boolean[];
}

export interface Asked<P> {
  params: P;
  route: string;
  level: Level;
  hides: boolean;
  written: Readonly<Record<string, unknown>>;
  placed: Written[];
  not_searched: string[];
  terms: Record<string, Query>;
  match?: Record<string, { term: MatchTerm; placed: Placed | null }[]>;
  seen: string[];
  kept?: number;
  rows?: Record<string, Asked<unknown>>;
  row?: string;
}

export const GUESS = "qxzvjwkh";
const guessOf = (n: number): string => `${GUESS}${String.fromCharCode(97 + (n % 26)).repeat(1 + Math.floor(n / 26))}`;

function alone(restored: Restored): Mark | undefined {
  const mark = restored.marks[0];
  return restored.marks.length === 1 && mark!.start === 0 && mark!.end === restored.text.length ? mark : undefined;
}

function personType(id: string): DetailType {
  if (id.startsWith("person:") || !/[:@\d]/u.test(id)) return "person";
  return idType(bareOf(id));
}

function bareOf(id: string): string {
  const colon = id.indexOf(":");
  return colon > 0 && ["phone", "email", "jid"].includes(id.slice(0, colon)) ? id.slice(colon + 1) : id;
}

export function outside(text: string): string[] {
  const parts: string[] = [];
  let from = 0;
  for (const span of placeholderSpans(text)) {
    parts.push(text.slice(from, span.start));
    from = span.end;
  }
  parts.push(text.slice(from));
  return parts;
}

export function visible(text: string, term: ReadTerm): Span[] {
  const placeholders = placeholderSpans(text);
  return spansOf(text, term).filter((span) => !placeholders.some((placeholder) => placeholder.start < span.end && span.start < placeholder.end));
}

export function seenAs(text: string, parts: readonly Part[], prefix: boolean): Span[] {
  const placeholders = placeholderSpans(text);
  const read: (Span & { word?: string; placeholder?: string })[] = [
    ...wordsIn(text).filter((word) => !placeholders.some((placeholder) => placeholder.start < word.end && word.start < placeholder.end)),
    ...placeholders.map((placeholder) => ({ ...placeholder, placeholder: text.slice(placeholder.start, placeholder.end) })),
  ].sort((left, right) => left.start - right.start);
  const wanted = parts.flatMap((part): { word?: string; placeholder?: string }[] => ("words" in part ? part.words.map((word) => ({ word })) : [{ placeholder: part.placeholder }]));
  const found: Span[] = [];
  if (wanted.length === 0) return found;
  const lastWord = wanted.findLastIndex((each) => each.word !== undefined);
  for (let i = 0; i + wanted.length <= read.length; i++) {
    const matches = wanted.every((each, k) => {
      const token = read[i + k]!;
      if (each.placeholder !== undefined) return token.placeholder === each.placeholder;
      return token.word !== undefined && (prefix && k === lastWord && k === wanted.length - 1 ? token.word.startsWith(each.word!) : token.word === each.word);
    });
    if (matches) found.push({ start: read[i]!.start, end: read[i + wanted.length - 1]!.end });
  }
  return found;
}

export function besides(table: TableOf, current: PlaceholderTable): TableOf {
  if (typeof table !== "function") return current;
  return async (wanted) => {
    const part = await table(wanted);
    const held = new Set(current.entries.map((entry) => entry.placeholder));
    const next = { ...part.next };
    for (const [type, n] of Object.entries(current.next) as [keyof typeof next, number][]) next[type] = Math.max(next[type] ?? 1, n);
    return { scope: current.scope, entries: [...current.entries, ...part.entries.filter((entry) => !held.has(entry.placeholder))], next };
  };
}

function placedTerms(typed: string, part: PlaceholderTable, people: NameTable | undefined): { terms: Term[]; placed: (Placed | null)[]; parts: (Part[] | null)[]; written: string[] } {
  const spans = placeholderSpans(typed);
  let masked = typed;
  for (const span of spans) masked = `${masked.slice(0, span.start)}${"x".repeat(span.end - span.start)}${masked.slice(span.end)}`;
  const restored = new Map(spans.map((span) => [span.start, restoreDetails(typed.slice(span.start, span.end), part)]));
  const terms: Term[] = [];
  const placed: (Placed | null)[] = [];
  const parts: (Part[] | null)[] = [];
  const written: string[] = [];
  for (const term of termsOf(masked)) {
    const end = term.at + term.text.length;
    const inside = spans.filter((span) => term.at <= span.start && span.end <= end);
    const only = inside.length === 1 && !/[\p{L}\p{N}]/u.test(typed.slice(term.at, inside[0]!.start) + typed.slice(inside[0]!.end, end)) ? restored.get(inside[0]!.start)! : undefined;
    const mark = only?.marks[0];
    if (only !== undefined && mark !== undefined) {
      const bracketed = typed.slice(inside[0]!.start, inside[0]!.end);
      const stands: Placed = { type: mark.type, ...(mark.who === undefined ? {} : { who: mark.who }), words: only.text, placeholder: placeholderSpelling(bracketed) ?? bracketed };
      alternatives(stands, people).forEach((text, index) => {
        terms.push({ text, quoted: true, negated: term.negated, or: term.negated ? false : index === 0 ? term.or : true, at: term.at });
        placed.push(stands);
        parts.push(null);
        written.push(typed.slice(term.at, end));
      });
      continue;
    }
    let text = "";
    let from = term.at;
    const own: Part[] = [];
    const words = (between: string) => {
      const read = wordsIn(between).map((each) => each.word);
      if (read.length > 0) own.push({ text: between, words: read });
    };
    for (const span of inside) {
      words(typed.slice(from, span.start));
      const spelled = typed.slice(span.start, span.end);
      own.push({ placeholder: placeholderSpelling(spelled) ?? spelled });
      text += `${typed.slice(from, span.start)}${restored.get(span.start)!.text}`;
      from = span.end;
    }
    words(typed.slice(from, end));
    terms.push({ ...term, text: text + typed.slice(from, end) });
    placed.push(null);
    parts.push(inside.length === 0 ? null : own);
    written.push(typed.slice(term.at, end));
  }
  return { terms, placed, parts, written };
}

function alternatives(placed: Placed, people: NameTable | undefined): string[] {
  const type = baseOf(placed.type);
  const person = type === "person" && placed.who !== undefined ? people?.people.find((each) => each.who === placed.who) : undefined;
  const names = person === undefined || people === undefined ? [] : ownNames(people, person.who);
  const digits = type === "phone" ? placed.words.replace(/\D/gu, "") : "";
  const ten = digits.slice(-10);
  const spelled = ten.length === 10 ? [digits, ten, `${ten.slice(0, 3)} ${ten.slice(3, 6)} ${ten.slice(6)}`] : [];
  const all = [placed.words, ...names, ...person?.accounts ?? [], ...spelled].map((text) => text.replaceAll('"', " ").trim()).filter((text) => /[\p{L}\p{N}]/u.test(text));
  return all.filter((text, index) => all.findIndex((other) => other.toLowerCase() === text.toLowerCase()) === index);
}

function placedMatch(typed: string, table: PlaceholderTable, people: NameTable | undefined): { term: MatchTerm; placed: Placed | null }[] {
  const spans = placeholderSpans(typed);
  let masked = typed;
  for (const span of spans) masked = `${masked.slice(0, span.start)}${"x".repeat(span.end - span.start)}${masked.slice(span.end)}`;
  return matchTermsOf(typed, masked).map((term) => {
    const inside = spans.filter((span) => term.start <= span.start && span.end <= term.end);
    const only = inside.length === 1 && !/[\p{L}\p{N}]/u.test(typed.slice(term.start, inside[0]!.start) + typed.slice(inside[0]!.end, term.end)) ? inside[0]! : undefined;
    const bracketed = only === undefined ? undefined : typed.slice(only.start, only.end);
    const mark = bracketed === undefined ? undefined : alone(restoreDetails(bracketed, table));
    const restored = mark === undefined ? restoreDetails(term.text, table) : restoreDetails(bracketed!, table);
    if (mark === undefined) return { term: { ...term, text: restored.text, folds: [matchFold(restored.text)], said: { is: "text", value: restored.text } }, placed: null };
    const placed: Placed = { type: mark.type, ...(mark.who === undefined ? {} : { who: mark.who }), words: restored.text, placeholder: placeholderSpelling(bracketed!) ?? bracketed! };
    const folds = [...new Set(alternatives(placed, people).map(matchFold).filter((each) => each !== ""))];
    return { term: { ...term, text: restored.text, folds, said: { is: "detail", value: restored.text, type: mark.type, ...(mark.who === undefined ? {} : { who: mark.who }) } }, placed };
  });
}

export interface Plain {
  text: string;
  words: readonly string[];
}

type Unsearched = "tells" | "unread" | null;

async function unsearched(queries: readonly (readonly (readonly Plain[])[])[], said: (words: readonly string[]) => boolean, look: Hide): Promise<Unsearched[][] | { wait: string }> {
  const texts = queries.map((terms) => terms.flat().map(({ text }) => text).join(" "));
  const asked = texts.flatMap((text, at) => (text.trim() === "" ? [] : [at]));
  const hidden: (string | null)[] = queries.map(() => null);
  if (asked.length > 0) {
    const out = await look(asked.map((at) => [{ text: texts[at]!, free: true }]));
    if (!("texts" in out)) return out;
    asked.forEach((at, k) => void (hidden[at] = typeof out.texts[k] === "string" ? out.texts[k] as string : null));
  }
  const numbered = (text: string) => /\p{N}/u.test(text);
  return queries.map((terms, q) => terms.map((parts) => {
    const read = hidden[q] ?? null;
    const failed = parts.filter(({ text, words }) => !said(words) && (numbered(text) || read === null || visible(read, { index: 0, words: [...words], prefix: false }).length === 0));
    if (failed.length === 0) return null;
    return read === null && failed.every(({ text }) => !numbered(text)) ? "unread" : "tells";
  }));
}

function guessedIn(query: Query, at: ReadonlySet<number>, guess: (value: string) => string): Query {
  return {
    terms: query.terms.map((term, i) => (at.has(i) ? { ...term, text: guess(query.written[i]!), quoted: false } : term)),
    placed: query.placed.map((each, i) => (at.has(i) ? null : each)),
    parts: query.parts.map((each, i) => (at.has(i) ? null : each)),
    written: query.written,
    shown: query.shown.map((each, i) => each && !at.has(i)),
  };
}

function queryOf(terms: readonly Term[], exact: (at: number) => boolean): string {
  return terms.map((term, at) => {
    const quoted = term.quoted || exact(at) || /\s/u.test(term.text);
    const said = `${term.negated ? "-" : ""}${quoted ? `"${term.text.replaceAll('"', " ")}"` : term.text}`;
    return at > 0 && term.or ? `OR ${said}` : said;
  }).join(" ");
}

function leftOut(query: Query, out: ReadonlySet<number>): Query | null {
  const kept: number[] = [];
  const terms: Term[] = [];
  let begins = false;
  query.terms.forEach((term, at) => {
    if (out.has(at)) {
      if (!term.negated && !term.or) begins = true;
      return;
    }
    kept.push(at);
    if (term.negated) return void terms.push(term);
    terms.push(begins && term.or ? { ...term, or: false } : term);
    begins = false;
  });
  if (wordsOfTerms(terms) === null) return null;
  return { terms, placed: kept.map((at) => query.placed[at]!), parts: kept.map((at) => query.parts[at]!), written: kept.map((at) => query.written[at]!), shown: kept.map((at) => query.shown[at]!) };
}

interface Continuation {
  of: string;
  asked: Asked<unknown>;
}

export function continuation(of: string, asked: Asked<unknown>): string {
  return JSON.stringify({ continues: { of, asked } });
}

export function continuationOf(detail: string): Continuation | undefined {
  if (!detail.startsWith('{"continues":')) return undefined;
  return (JSON.parse(detail) as { continues: Continuation }).continues;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const canonical = (value: unknown): string => JSON.stringify(value, (_key, each: unknown) => (isRecord(each) ? Object.fromEntries(Object.entries(each).sort(([a], [b]) => a.localeCompare(b))) : each));

function stringsOf(args: Readonly<Record<string, unknown>>): string[] {
  return Object.values(args).flatMap((value) => (typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : isRecord(value) ? Object.values(value).filter((each): each is string => typeof each === "string") : []));
}

type MatchRead = { term: MatchTerm; placed: Placed | null }[];

function bracketed(value: unknown, table: PlaceholderTable): unknown {
  if (Array.isArray(value)) return value.map((each) => bracketed(each, table));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([name, each]) => [name, bracketed(each, table)]));
  if (typeof value !== "string") return value;
  return bracketHeld(value, table);
}

function leafOf(leaves: Leaves | undefined): Leaf | undefined {
  return leaves?.leaf ?? leaves?.each?.leaf ?? leaves?.values?.leaf;
}

export { CURSOR_PARAMS };

export async function wayIn<P>(
  route: string, shape: Shape<P>, args: unknown, table: PlaceholderTable, level: Level, shown: ReadonlySet<string>, people: NameTable | undefined, look: Hide,
  sealing?: Sealing,
): Promise<Asked<P> | { unknown: string[] } | { withheld: string; not_searched?: string[] } | { wait: string }> {
  const typed = bracketed(argsOf(shape, args), table) as Readonly<Record<string, unknown>>;
  const members = leavesOf(shape).members ?? {};
  const kindOf = (name: string): Leaf | undefined => leafOf(members[name]);
  const placed: Written[] = [];
  let guesses = 0;
  const guess = (value: string): string => {
    const read = guessOf(guesses++);
    placed.push({ written: value, read, as: "guess" });
    return read;
  };
  const seal = sealing?.seal.typed;
  const sealedMark = (restored: Restored) => seal !== undefined && restored.marks.some((mark) => seal.detail(mark.type, restored.text.slice(mark.start, mark.end), mark.who));
  const isSealed = (restored: Restored): boolean => seal !== undefined && (sealedMark(restored) || seal.marks(restored.text).length > 0);
  const sealedValue = (restored: Restored): boolean => isSealed(restored) || (seal !== undefined && restored.marks.length === 0 && seal.detail(personType(restored.text), restored.text));
  const unsealed = (value: unknown): unknown => {
    if (typeof value !== "string" || seal === undefined) return value;
    const holders = placeholderSpans(value);
    const spans = [
      ...holders.filter((span) => isSealed(restoreDetails(value.slice(span.start, span.end), table))),
      ...seal.marks(value).filter((mark) => !holders.some((span) => span.start < mark.end && mark.start < span.end)),
    ].sort((left, right) => left.start - right.start);
    let out = "";
    let from = 0;
    for (const span of spans) {
      if (span.start < from) continue;
      out += value.slice(from, span.start) + guess(value.slice(span.start, span.end));
      from = span.end;
    }
    return out + value.slice(from);
  };
  const written = seal === undefined ? typed : Object.fromEntries(Object.entries(typed).map(([name, value]) =>
    [name, kindOf(name) !== "term" ? value : isRecord(value) ? Object.fromEntries(Object.entries(value).map(([key, each]) => [key, unsealed(each)])) : unsealed(value)]));
  const hiding = hidesAny(level);
  const hidingOut = hiding || seal !== undefined;
  const detailOf = (handle: string) => table.entries.find((entry) => entry.type === "ref" && entry.placeholder === handle.trim())?.detail;

  const cursorName = Object.keys(written).find((name) => kindOf(name) === "cursor");
  if (cursorName !== undefined) {
    const handle = String(written[cursorName]);
    const detail = detailOf(handle);
    const continued = detail === undefined ? undefined : continuationOf(detail);
    if (continued === undefined || continued.asked.level !== level) return { unknown: [handle] };
    if (continued.asked.route !== route) refused("BAD_PARAMETER", "`cursor` is the next of another route: give it to the route that gave it.");
    const { [cursorName]: _cursor, limit, ...beside } = written;
    const { [cursorName]: _was, limit: _limit, ...first } = continued.asked.written;
    if (Object.keys(beside).length > 0 && canonical(beside) !== canonical(first)) {
      refused("BAD_PARAMETER", `\`${cursorName}\` goes on alone, or with the arguments exactly as first written, and \`limit\`.`);
    }
    return { ...continued.asked, hides: hidingOut, params: { ...(continued.asked.params as object), [cursorName]: continued.of, ...(limit === undefined ? {} : { limit }) } as P };
  }

  const unknown = new Set<string>();
  for (const value of stringsOf(written)) for (const each of restoreDetails(value, table).unknown) unknown.add(each);
  const seenWords = new Set([...shown].flatMap((text) => outside(text).flatMap((part) => wordsIn(part).map((each) => each.word))));
  const said = (words: readonly string[]) => words.length > 0 && words.every((word) => seenWords.has(word));
  const saidText = (text: string) => said(wordsIn(text).map((each) => each.word));
  const params: Record<string, unknown> = {};
  const asked: Omit<Asked<P>, "params"> = { route, level, hides: hidingOut, written, placed, not_searched: [], terms: {}, seen: [] };

  const handleBack = (value: string): string => {
    const detail = detailOf(value);
    const continued = detail === undefined ? undefined : continuationOf(detail);
    if (detail === undefined || (continued !== undefined && continued.asked.level !== level)) {
      unknown.add(value);
      return value;
    }
    if (continued === undefined) return detail;
    if (continued.of.startsWith("row.")) asked.rows = { ...asked.rows, [continued.of]: continued.asked };
    return continued.of;
  };
  const typedBack = (value: string): string => {
    if (HANDLE.test(value.trim())) {
      const read = handleBack(value);
      if (read !== value) placed.push({ written: value, read, as: "handle" });
      return read;
    }
    const restored = restoreDetails(value, table);
    if (sealedValue(restored)) return guess(value);
    const mark = alone(restored);
    const who = mark?.who === undefined ? {} : { who: mark.who };
    if (mark !== undefined && baseOf(mark.type) === "person") {
      if (mark.who === undefined) return guess(value);
      const read = makeRef("person", { handle: mark.who });
      placed.push({ written: value, read, as: "person", type: mark.type, ...who });
      return read;
    }
    if (mark !== undefined) {
      placed.push({ written: value, read: restored.text, as: "placeholder", type: mark.type, ...who });
      return restored.text;
    }
    if (hiding && hides(level, personType(restored.text)) && !said(outside(value).flatMap((part) => wordsIn(part).map((each) => each.word)))) return guess(value);
    return restored.text;
  };
  const freeBack = (value: string): string => {
    const restored = restoreDetails(value, table);
    if (isSealed(restored)) return guess(value);
    if (!hiding || outside(value).flatMap((part) => wordsIn(part).map((each) => each.word)).every((word) => seenWords.has(word))) return restored.text;
    return guess(value);
  };
  const strings = (value: unknown, back: (value: string) => string): unknown => (typeof value === "string" ? back(value) : Array.isArray(value) ? value.map((one) => strings(one, back)) : value);

  const matches: Record<string, Record<string, { typed: string; terms: MatchRead }>> = {};
  for (const [name, value] of Object.entries(written)) {
    const kind = kindOf(name);
    if (kind === "ref") params[name] = strings(value, handleBack);
    else if (kind === "label") params[name] = value;
    else if (kind === "name" || kind === "id") params[name] = strings(value, typedBack);
    else if (kind === "term" && isRecord(value)) {
      matches[name] = Object.fromEntries(Object.entries(value).map(([key, typed]) => [key, { typed: String(typed), terms: placedMatch(String(typed), table, people) }]));
    } else if (kind === "term") {
      const typed = String(value);
      const read = placedTerms(typed, table, people);
      asked.terms[name] = { ...read, shown: read.terms.map((term, at) => read.placed[at] === null && saidText(term.text)) };
      read.terms.forEach((term, at) => {
        const put = read.placed[at];
        if (put != null) placed.push({ written: read.written[at]!, read: term.text, as: "placeholder", type: put.type, ...(put.who === undefined ? {} : { who: put.who }) });
      });
    } else params[name] = strings(value, freeBack);
  }
  if (unknown.size > 0) return { unknown: [...unknown] };
  asked.seen = [...new Set(stringsOf(written).flatMap((text) => wordsIn(text).map((one) => one.word)).filter((word) => seenWords.has(word)))];

  const queries = Object.entries(asked.terms).map(([name, query]) => ({ name, query, read: wordsOfTerms(query.terms) }));
  const keys = Object.entries(matches).flatMap(([name, map]) => Object.entries(map).map(([key, { typed, terms }]) => ({ name, key, typed, terms })));
  const plainOf = (query: Query, term: ReadTerm): Plain[] => {
    if (query.placed[term.index] !== null) return [];
    const parts = query.parts[term.index];
    return parts == null ? [{ text: query.terms[term.index]!.text, words: term.words }] : parts.flatMap((part) => ("words" in part ? [part] : []));
  };
  const judged = queries.map(({ query, read }) => [...read?.terms?.required.flat() ?? [], ...read?.terms?.excluded ?? []].map((term) => ({ term, parts: plainOf(query, term) })));
  const judgedKeys = keys.map(({ key, terms }) => terms.map(({ term, placed: put }) => (put !== null || STRUCTURE_KEYS.has(key) ? [] : [{ text: term.text, words: wordsIn(term.text).map((one) => one.word) }])));
  let fails: Unsearched[][] = [...judged.map((terms) => terms.map(() => null)), ...judgedKeys.map((terms) => terms.map(() => null))];
  const bySeal = fails.map((terms) => terms.map(() => false));
  if (hiding) {
    const judging = [...judged.map((terms) => terms.map(({ parts }) => parts)), ...judgedKeys];
    const found = await unsearched(judging, said, look);
    if (!Array.isArray(found)) return found;
    fails = found;
    if (sealing !== undefined && fails.some((terms) => terms.some((why) => why !== null))) {
      const open = await unsearched(judging, said, sealing.open);
      if (!Array.isArray(open)) return open;
      fails = fails.map((terms, g) => terms.map((why, at) => {
        if (why === null || open[g]![at] !== null) return why;
        bySeal[g]![at] = true;
        return null;
      }));
    }
  }
  const queryFails = fails.slice(0, queries.length);
  const keyFails = fails.slice(queries.length);

  const guessed = queries.map(({ query }, q) => judged[q]!.some(({ term }, at) => queryFails[q]![at] !== null && query.terms[term.index]!.negated));
  const keyGuessed = keys.map(({ terms }, k) => terms.some(({ term }, at) => keyFails[k]![at] !== null && term.negated));
  const anyGuess = guessed.some(Boolean) || keyGuessed.some(Boolean);

  const tells: string[] = [];
  const unread: string[] = [];
  const notSearched = (why: Unsearched, typed: string) => {
    const list = why === "unread" ? unread : tells;
    if (!list.includes(typed)) list.push(typed);
  };
  let leftAny = false;
  let remains = false;
  queries.forEach(({ name: param, query, read }, q) => {
    if (guessed[q]) {
      params[param] = `"${guess(String(written[param]))}"`;
      return;
    }
    const sealedTerms = new Set(judged[q]!.flatMap(({ term }, at) => (bySeal[q]![at] ? [term.index] : [])));
    const whole = sealedTerms.size === 0 ? query : guessedIn(query, sealedTerms, guess);
    const out = new Set<number>();
    if (!anyGuess) {
      judged[q]!.forEach(({ term }, at) => {
        const why = queryFails[q]![at]!;
        if (why === null || whole.terms[term.index]!.negated) return;
        out.add(term.index);
        notSearched(why, whole.written[term.index]!);
      });
    }
    const rest = out.size === 0 ? whole : leftOut(whole, out);
    if (out.size > 0) leftAny = true;
    if (rest === null) {
      delete asked.terms[param];
      return;
    }
    if ((wordsOfTerms(rest.terms)?.terms?.required.length ?? 0) > 0 || read === null) remains = true;
    asked.terms[param] = rest;
    params[param] = !hiding && rest.parts.every((one) => one === null) && rest.placed.every((one) => one === null)
      ? String(written[param]) : queryOf(rest.terms, (at) => hiding && !rest.shown[at]);
  });
  keys.forEach(({ name: param, key, typed, terms }, k) => {
    const map = (params[param] ??= {}) as Record<string, string>;
    asked.match ??= {};
    if (keyGuessed[k]) {
      map[key] = guess(typed);
      asked.match[key] = [];
      return;
    }
    const kept = terms.flatMap((one, at) => {
      const why = keyFails[k]![at]!;
      if (bySeal[queries.length + k]![at]) {
        const read = guess(typed.slice(one.term.start, one.term.end));
        return [{ term: { ...one.term, text: read, folds: [matchFold(read)], said: { is: "text" as const, value: read } }, placed: null }];
      }
      if (anyGuess || why === null || one.term.negated) return [one];
      notSearched(why, typed.slice(one.term.start, one.term.end));
      leftAny = true;
      return [];
    });
    const required = kept.filter(({ term }) => !term.negated);
    if (required.length === 0 && terms.some(({ term }) => !term.negated)) return;
    if (required.length > 0) remains = true;
    asked.match[key] = kept.flatMap((one) => (one.placed === null || one.term.negated ? [one]
      : alternatives(one.placed, people).map((text) => ({ term: { ...one.term, text, folds: [matchFold(text)] }, placed: one.placed }))));
    map[key] = kept.map(({ term, placed: put }) => {
      if (put === null) return `${term.negated ? "-" : ""}${term.text}`;
      for (const one of alternatives(put, people)) placed.push({ written: typed.slice(term.start, term.end), read: one, as: "placeholder", type: put.type, ...(put.who === undefined ? {} : { who: put.who }) });
      return term.negated ? `-${put.words}` : alternatives(put, people).join(" OR ");
    }).join(" OR ");
  });
  for (const { name: param } of keys) if (isRecord(params[param]) && Object.keys(params[param]).length === 0) delete params[param];
  asked.not_searched = [...tells, ...unread];
  if (leftAny && !remains) return { withheld: tells.length === 0 ? WITHHELD_UNREAD : WITHHELD_TERMS, not_searched: asked.not_searched };
  return { ...asked, params: params as P };
}

export type Marked = (values: readonly string[]) => ReadonlyMap<string, ValueMarks> | null;
export type Stop = { withheld: string } | { wait: string };

export function standsFor(asked: Asked<unknown>, look: Hide, marked: Marked): (candidates: Candidates) => Promise<Stands | { stop: Stop }> {
  const matchTerms = asked.match ?? {};
  const wordPlaced = Object.values(asked.terms).flatMap((query) => query.placed);
  return async (candidates) => {
    const required = candidates.words?.required?.facts ?? {};
    const excluded = candidates.words?.excluded?.facts ?? {};
    const raw = (key: string, at: number) => STRUCTURE_KEYS.has(key) || matchTerms[key]?.[at]?.placed != null;
    const wanted = [...new Set(Object.entries(candidates.match)
      .filter(([key, { terms }]) => terms.some((_term, at) => !raw(key, at)))
      .flatMap(([, { values }]) => values.map((value) => value.value)))];
    const kept = wanted.length === 0 ? null : marked(wanted);
    const unmarked = new Set(kept === null ? [] : wanted.filter((value) => {
      const marks = kept.get(value);
      return marks === undefined || marks === "unmarked" || !marks.current;
    }));
    const texts: Text[] = [];
    const valueAt = new Map<string, number>();
    for (const value of wanted) if (!unmarked.has(value)) valueAt.set(value, texts.push([{ text: value, free: true }]) - 1);
    const passageAt = new Map<string, number>();
    for (const passage of [...Object.values(required), ...Object.values(excluded)].flat()) {
      if (passageAt.has(passage.text)) continue;
      passageAt.set(passage.text, texts.push([{ text: passage.text, free: true, ...(passage.names.length === 0 ? {} : { known: passage.names.map(({ start, end, who }) => ({ start, end, type: "person" as const, who })) }) }]) - 1);
    }
    const hidden = texts.length === 0 ? { texts: [] as HiddenText[] } : await look(texts);
    if (!("texts" in hidden)) return { stop: hidden };
    const out = (at: number | undefined): string | null => (at !== undefined && typeof hidden.texts[at] === "string" ? hidden.texts[at] as string : null);
    return {
      value: (key, term, at, candidate) => {
        if (raw(key, at)) return matchesRaw(candidate.value, term);
        const shownValue = out(valueAt.get(candidate.value));
        if (shownValue === null) return null;
        return outside(shownValue).some((segment) => term.folds.some((each) => matchFold(segment).includes(each)));
      },
      fact: (_term, at, read, _fact, passages) => {
        const held = wordPlaced[at]?.placeholder;
        let unread = false;
        for (const passage of passages) {
          const shownText = out(passageAt.get(passage.text));
          if (shownText === null) {
            unread = true;
            continue;
          }
          if (held === undefined ? visible(shownText, read).length > 0 : shownText.includes(held)) return true;
        }
        return unread ? null : false;
      },
      place: () => true,
    };
  };
}

export async function kept<H extends Readonly<Record<string, unknown>>>(
  asked: Asked<unknown>, hits: readonly H[], hide: Hide, leaves: Leaves, without: readonly string[] = [],
): Promise<Omit<H, "passages">[] | { wait: string }> {
  const bare = hits.map(({ passages: _passages, ...hit }) => hit);
  if (!asked.hides || hits.length === 0) return bare;
  const each = hits.map((hit, n) => [...textsOf(bare[n]!, leaves, asked), ...passagesOf(hit).map((passage) => textOf("excerpt", passage, asked))]);
  const hidden = await hide(each.flat());
  if (!("texts" in hidden)) return hidden;
  const dropped = new Set(without.flatMap((word) => wordsIn(word).map((one) => one.word)));
  const queries = Object.values(asked.terms).map((query) => ({
    query,
    groups: (wordsOfTerms(query.terms)?.terms?.required ?? []).filter((group) => !group.every((term) => query.placed[term.index] === null && term.words.every((word) => dropped.has(word)))),
  }));
  const stands = (text: string, query: Query, group: readonly ReadTerm[]) => group.some((term) => standing(text, query, term).length > 0);
  const shows = (text: string) => queries.some(({ query, groups }) => groups.some((group) => stands(text, query, group)));
  const required = queries.some(({ groups }) => groups.length > 0);
  const out: Omit<H, "passages">[] = [];
  let from = 0;
  hits.forEach((hit, n) => {
    const shownTexts = hidden.texts.slice(from, from + each[n]!.length);
    from += each[n]!.length;
    if (shownTexts.some((text) => typeof text !== "string")) return;
    const texts = shownTexts as string[];
    if (!queries.every(({ query, groups }) => groups.every((group) => texts.some((text) => stands(text, query, group))))) return;
    const lent = passagesOf(hit);
    const first = lent.find((_passage, p) => shows(texts[texts.length - lent.length + p]!));
    const { snippet: _snippet, ...rest } = bare[n]!;
    out.push((lent.length === 0 || !required ? bare[n]! : first === undefined ? rest : { ...rest, snippet: { ...first, spans: [] } }) as Omit<H, "passages">);
  });
  return out;
}

function standing(hidden: string, query: Query, term: ReadTerm): Span[] {
  const put = query.placed[term.index];
  if (put !== null && put !== undefined) {
    const found: Span[] = [];
    for (let at = hidden.indexOf(put.placeholder); at >= 0; at = hidden.indexOf(put.placeholder, at + 1)) found.push({ start: at, end: at + put.placeholder.length });
    return found;
  }
  const parts = query.parts[term.index];
  if (parts !== null && parts !== undefined) return seenAs(hidden, parts, term.prefix);
  return visible(hidden, term);
}

function passagesOf(hit: Readonly<Record<string, unknown>>): { text: string; names: Named[] }[] {
  return Array.isArray(hit.passages) ? (hit.passages as { text: string; names: Named[] }[]).map(({ text, names }) => ({ text, names })) : [];
}

function holds(words: readonly string[], term: { forms: readonly (readonly string[])[] }): boolean {
  return term.forms.some((form) => form.length > 0 && words.some((_, i) => i + form.length <= words.length && form.every((word, j) => words[i + j] === word)));
}

export interface ScreenFound {
  title: string;
  snippet: string;
  reason: string;
  source?: string;
  terms?: TermLines[];
  group?: string;
  siblings?: { title: string; terms?: TermLines[]; group?: string }[];
  also?: number;
  [member: string]: unknown;
}

export async function screenKept(asked: Asked<unknown>, hits: readonly ScreenFound[], hide: Hide): Promise<{ hits: Record<string, unknown>[]; unmatched: string[] } | { wait: string }> {
  const bare = (hit: ScreenFound): Record<string, unknown> => {
    const { source: _source, terms: _terms, group: _group, siblings: _siblings, ...rest } = hit;
    return rest;
  };
  if (!asked.hides || hits.length === 0) return { hits: hits.map(bare), unmatched: [] };
  const placed = new Set(asked.placed.filter((each) => each.as === "placeholder").flatMap((each) => tokens(each.read)));
  const free = (term: TermLines) => term.word.split(" OR ").every((alternative) => tokens(alternative).every((word) => placed.has(word)));
  const texts: Text[] = [];
  const at = new Map<string, number>();
  const add = (line: string): number => {
    const held = at.get(line);
    if (held !== undefined) return held;
    const n = texts.push([{ text: line, free: true }]) - 1;
    at.set(line, n);
    return n;
  };
  const laidTerms = (terms: readonly TermLines[] | undefined) => (terms ?? []).map((term) => ({ term, lines: term.lines.map(add) }));
  const laid = hits.map((hit) => {
    const lines = (hit.source ?? unmarked(hit.snippet)).split("\n");
    return {
      hit, plain: lines, lines: lines.map(add), window: add(hit.title), terms: laidTerms(hit.terms),
      siblings: (hit.siblings ?? []).map((other) => ({ group: other.group, window: add(other.title), terms: laidTerms(other.terms) })),
    };
  });
  const hidden = await hide(texts);
  if (!("texts" in hidden)) return hidden;
  const out = (at: number): string | undefined => {
    const text = hidden.texts[at];
    return typeof text === "string" ? text : undefined;
  };
  const standsIn = (text: string, term: TermLines) => outside(text).some((stretch) => holds(tokens(stretch), term));
  const stands = ({ term, lines }: { term: TermLines; lines: number[] }, window: string) => free(term)
    || [...lines.map(out), window].some((text) => text !== undefined && standsIn(text, term));
  const allStand = (terms: readonly { term: TermLines; lines: number[] }[], window: string) => terms.length > 0 && terms.every((each) => stands(each, window));
  const unmatched: string[] = [];
  const name = (group: string | undefined, terms: readonly { term: TermLines; lines: number[] }[], window: string) => {
    if (group === undefined) return;
    for (const each of terms) if (!stands(each, window)) unmatched.push(`${group}/${each.term.word}`);
  };
  const kept: Record<string, unknown>[] = [];
  for (const { hit, plain, lines, window, terms, siblings } of laid) {
    const hiddenWindow = out(window);
    const readable = lines.flatMap((at, n) => (out(at) === undefined ? [] : [{ plain: plain[n]!, hidden: out(at)! }]));
    if (hiddenWindow === undefined || readable.length === 0 || readable.length < lines.length && hit.reason === "meaning") continue;
    if (hit.reason === "meaning") {
      kept.push(bare(hit));
      continue;
    }
    name(hit.group, terms, hiddenWindow);
    for (const other of siblings) name(other.group, other.terms, out(other.window) ?? "");
    if (!allStand(terms, hiddenWindow)) continue;
    const standing = terms.filter((each) => stands(each, hiddenWindow)).map(({ term }) => term);
    const line = readable.find((each) => standing.some((term) => standsIn(each.hidden, term))) ?? readable[0]!;
    const also = siblings.filter((other) => allStand(other.terms, out(other.window) ?? "")).length;
    const { also: _also, ...rest } = bare(hit);
    kept.push({ ...rest, snippet: { text: line.plain, names: [], spans: [] }, ...(also === 0 ? {} : { also }) });
  }
  return { hits: kept, unmatched: [...new Set(unmatched)] };
}

export type Said = string | { text: string; who: string } | { text: string; names: readonly Named[]; spans?: readonly Span[] };
export interface Named {
  start: number;
  end: number;
  who: string;
}

const PIECES: readonly Leaf[] = ["name", "free", "excerpt"];
const isPiece = (value: unknown): value is Exclude<Said, string> => isRecord(value) && typeof value.text === "string" && (typeof value.who === "string" || Array.isArray(value.names));

function unmarked(excerpt: string): string {
  return excerpt.replaceAll("«", "").replaceAll("»", "");
}

function textOf(kind: Leaf, said: Said, asked: Asked<unknown>): Text {
  const text = typeof said === "string" ? (kind === "excerpt" && asked.hides ? unmarked(said) : said) : said.text;
  if (typeof said !== "string" && "who" in said) return [{ text, is: "person", who: said.who }];
  if (kind === "id") return [{ text, is: idType(text) }];
  if (kind === "name" && personType(text) !== "person") return [{ text, is: personType(text) }];
  const names: Mark[] = typeof said === "string" ? [] : said.names.map(({ start, end, who }) => ({ start, end, type: "person", who }));
  const putBack = asked.placed.flatMap((each) => (each.as === "placeholder" && each.type !== undefined ? [{ words: each.read, type: each.type, ...(each.who === undefined ? {} : { who: each.who }) }] : []));
  const pieces: (Piece | Quote)[] = [];
  const opaque = asked.placed.filter((each) => each.as !== "placeholder");
  let rest = text;
  let at = 0;
  const free = (part: string, offset: number) => {
    if (part === "") return;
    const printed = names.filter((mark) => mark.start >= offset && mark.end <= offset + part.length).map((mark) => ({ ...mark, start: mark.start - offset, end: mark.end - offset }));
    const known = [...printed, ...wordMarks(part, putBack).filter((mark) => !printed.some((each) => each.start < mark.end && mark.start < each.end))].sort((a, b) => a.start - b.start);
    pieces.push({ text: part, free: true, ...(known.length === 0 ? {} : { known }) });
  };
  for (;;) {
    const found = opaque.map((each) => ({ each, index: rest.indexOf(each.read) })).filter(({ index }) => index >= 0).sort((a, b) => a.index - b.index)[0];
    if (found === undefined) break;
    free(rest.slice(0, found.index), at);
    pieces.push({ text: found.each.written, quote: true });
    at += found.index + found.each.read.length;
    rest = rest.slice(found.index + found.each.read.length);
  }
  free(rest, at);
  return pieces;
}

function writtenOf(term: string, asked: Asked<unknown>): string | undefined {
  if (asked.not_searched.includes(term)) return term;
  const key = wordsIn(term).map((each) => each.word).join(" ");
  return asked.placed.find((each) => each.read === term || (each.as === "placeholder" && wordsIn(each.read).map((word) => word.word).join(" ") === key))?.written;
}

function markedIn(hidden: string, asked: Asked<unknown>): Span[] {
  const spans = Object.values(asked.terms).flatMap((query) => (wordsOfTerms(query.terms)?.terms?.required.flat() ?? []).flatMap((term) => standing(hidden, query, term)));
  const sorted = spans.sort((left, right) => left.start - right.start || right.end - left.end);
  return sorted.filter((span, i) => sorted.findIndex((other) => other.start <= span.start && span.end <= other.end) === i);
}

function excerptOf(hidden: string, said: Said, asked: Asked<unknown>): string {
  const spans = markedIn(hidden, asked);
  if (typeof said !== "string" && "spans" in said && said.spans !== undefined) return spans.length > 0 ? snippetAt(hidden, spans, placeholderSpans(hidden)) : plainSnippet(hidden, placeholderSpans(hidden));
  let cut = "";
  let at = 0;
  for (const span of spans) {
    cut += `${hidden.slice(at, span.start)}«${hidden.slice(span.start, span.end)}»`;
    at = span.end;
  }
  return cut + hidden.slice(at);
}

interface Spot {
  kind: Leaf;
  said: Said;
  set(value: unknown): void;
}

function textsOf(value: Readonly<Record<string, unknown>>, leaves: Leaves, asked: Asked<unknown>): Text[] {
  const spots: Spot[] = [];
  walk(value, leaves, spots, () => undefined);
  return spots.filter((spot) => !["ref", "cursor", "label", "picture", "term"].includes(spot.kind)).map((spot) => textOf(spot.kind, spot.said, asked));
}

function walk(value: unknown, leaves: Leaves | undefined, spots: Spot[], set: (value: unknown) => void, keys: { kind: Leaf; key: string; set(key: string): void }[] = []): void {
  if (typeof value === "string" || (leaves?.leaf !== undefined && PIECES.includes(leaves.leaf) && leaves.members === undefined && isPiece(value))) {
    spots.push({ kind: leaves?.leaf ?? "free", said: value as Said, set });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((member, i) => walk(member, leaves?.at?.[i] ?? (i === value.length - 1 && leaves?.last !== undefined ? leaves.last : leaves?.each), spots, (next) => void (value[i] = next), keys));
    return;
  }
  if (!isRecord(value)) return;
  for (const name of Object.keys(value)) {
    const member = leaves?.members?.[name];
    if (member !== undefined) {
      walk(value[name], member, spots, (next) => void (value[name] = next), keys);
      continue;
    }
    if (leaves?.members === undefined || leaves.values !== undefined) keys.push({ kind: leaves?.keys ?? "free", key: name, set: (key) => {
      if (key === name) return;
      const was = value[name];
      delete value[name];
      const held = value[key];
      value[key] = Array.isArray(held) && Array.isArray(was) ? [...held, ...was] : held ?? was;
    } });
    walk(value[name], leaves?.values, spots, (next) => void (value[name] = next), keys);
  }
}

const dataUrl = (jpeg: Uint8Array): string => `data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}`;

function outboundOf(ref: string): OutboundRef[] {
  try {
    const read = readRef(ref);
    if (read.kind === "record") return [{ source: read.parts.source, kind: read.parts.kind, key: read.parts.key }];
    if (read.kind === "line" || read.kind === "window") return [{ day: read.parts.day }];
  } catch {
    return [];
  }
  return [];
}

const JUDGED = /^(?:record|window|line|picture|chat|person|place)\.[A-Za-z0-9_-]+$/u;

const NOT_ITEMS: ReadonlySet<string> = new Set(["goto", "person", "same", "tied", "unopened"]);
const ASKED_AGAIN: ReadonlySet<unknown> = new Set(["line", "row", "gone"]);
const FAMILY_TYPES: Readonly<Record<string, Type>> = { calendar: "plans", screen: "device-activity" };

export function itemsOf(tool: string, value: unknown, accounts: readonly HomeAccount[]): CallItem[] {
  const category = new Map(accounts.map((each) => [each.account, each.category] as const));
  const found = new Map<string, unknown>();
  itemsIn(value, found);
  const items: CallItem[] = [];
  for (const [ref, family] of found) {
    const item = itemOf(ref, family, category);
    if (item === null || (tool === "search_people" && item.kind !== "person")) continue;
    items.push(item);
  }
  return items;
}

export function cameOf(tool: string, value: unknown, accounts: readonly HomeAccount[]): Came {
  return tallyOf(itemsOf(tool, value, accounts));
}

function itemsIn(value: unknown, items: Map<string, unknown>): void {
  if (Array.isArray(value)) {
    const last = value.at(-1);
    if (value.length > 1 && isJudged(last) && !isJudged(value[0]) && !items.has(last)) items.set(last, undefined);
    for (const each of value) itemsIn(each, items);
    return;
  }
  if (!isRecord(value)) return;
  if (isJudged(value.ref) && !ASKED_AGAIN.has(value.what) && !items.has(value.ref)) items.set(value.ref, value.family);
  for (const [name, each] of Object.entries(value)) if (!NOT_ITEMS.has(name)) itemsIn(each, items);
}

function isJudged(value: unknown): value is string {
  return typeof value === "string" && JUDGED.test(value);
}

function typeOfFamily(family: unknown): Type | null {
  if (typeof family !== "string") return null;
  const type = FAMILY_TYPES[family] ?? family;
  return Object.hasOwn(TYPES, type) ? type as Type : null;
}

function itemOf(ref: string, family: unknown, category: ReadonlyMap<string, Type | null>): CallItem | null {
  let read: ReturnType<typeof readRef>;
  try {
    read = readRef(ref);
  } catch {
    return null;
  }
  const item = (kind: string, parts: Partial<Pick<CallItem, "source" | "rkind" | "key" | "day">> = {}): CallItem =>
    ({ kind, ref, source: parts.source ?? null, rkind: parts.rkind ?? null, key: parts.key ?? null, day: parts.day ?? null });
  switch (read.kind) {
    case "record": {
      const { source, kind, key } = read.parts;
      return item(category.get(accountOf(source)) ?? typeOfFamily(family) ?? "record", { source, rkind: kind, key });
    }
    case "line": return item(typeOfFamily(family) ?? "line", { day: read.parts.day });
    case "window": return item("device-activity", { day: read.parts.day });
    case "picture": return item("photos");
    case "place": return item("places");
    case "person": return item("person");
    default: return null;
  }
}

export function refsLeaving(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string" && JUDGED.test(value)) found.push(value);
  else if (Array.isArray(value)) for (const each of value) refsLeaving(each, found);
  else if (isRecord(value)) for (const each of Object.values(value)) refsLeaving(each, found);
  return found;
}

function slugsAsNames(value: unknown): void {
  if (Array.isArray(value)) return value.forEach(slugsAsNames);
  if (!isRecord(value)) return;
  if (typeof value.slug === "string" && typeof value.name === "string") value.slug = value.name;
  Object.values(value).forEach(slugsAsNames);
}

export const UNSTATED = {
  "/v1/search": ["record.reached", "record.held", "record.spread", "record.unproven", "screen.total", "screen.unproven", "goto"],
  "/v1/count": ["also"],
  "/v1/people/search": [],
  "/v1/read": ["place.latitude", "place.longitude", "place.radius_m", "place.also", "place.ids", "place.visits[].centre"],
} as const satisfies Record<(typeof TOOL_ROUTES)[number], readonly string[]>;

function unstate(value: unknown, path: string): void {
  if (!isRecord(value)) return;
  const [head, ...rest] = path.split(".");
  const name = head!.replace(/\[\]$/u, "");
  if (rest.length === 0) return void delete value[name];
  const inner = value[name];
  for (const each of Array.isArray(inner) ? inner : [inner]) unstate(each, rest.join("."));
}

function named(asked: Asked<unknown>): boolean {
  const name = asked.written.name;
  const seen = new Set(asked.seen);
  const words = typeof name === "string" ? wordsIn(name).map((each) => each.word) : [];
  return asked.placed.length === 0 && words.length > 0 && words.every((word) => seen.has(word));
}

function trimmed(shape: Shape<unknown>, answer: Record<string, unknown>, asked: Asked<unknown>): void {
  if (asked.not_searched.length > 0 && (shape === countAnswer || shape === searchAnswer)) answer.not_searched = [...new Set([...(answer.not_searched as string[] | undefined) ?? [], ...asked.not_searched])];
  if (!asked.hides) return;
  const route = TOOL_ROUTES.find((path) => ROUTES[path].answer === shape);
  const pages = route === "/v1/read" && answer.what === "refs" && Array.isArray(answer.opened) ? answer.opened : [answer];
  for (const path of route === undefined ? [] : UNSTATED[route]) for (const page of pages) unstate(page, path);
  const record = shape === searchAnswer ? answer.record as Record<string, unknown> | undefined : undefined;
  if (record !== undefined) {
    record.total = (asked.kept ?? 0) + (record.hits as unknown[]).length;
    record.capped = typeof record.next === "string";
  }
  if (shape === searchPeopleAnswer && !named(asked)) delete answer.elsewhere;
  if (shape === readAnswer) slugsAsNames(answer);
}

function nearInKept(answer: Record<string, unknown>): void {
  const texts: string[] = [];
  const strings = (value: unknown): void => {
    if (typeof value === "string") texts.push(value);
    else if (Array.isArray(value)) value.forEach(strings);
    else if (isRecord(value)) Object.values(value).forEach(strings);
  };
  for (const list of ["record", "screen"]) strings((answer[list] as { hits?: unknown } | undefined)?.hits);
  const stands = (spelling: unknown) => typeof spelling === "string" && placeholderSpans(spelling).length === 0
    && texts.some((text) => visible(unmarked(text), { index: 0, words: wordsIn(spelling).map((each) => each.word), prefix: false }).length > 0);
  const near = (map: Record<string, unknown> | undefined) => {
    for (const [word, spellings] of Object.entries(map ?? {})) {
      const standing = Array.isArray(spellings) ? spellings.filter(stands) : [];
      if (standing.length === 0) delete map![word];
      else map![word] = standing;
    }
  };
  const variants = answer.variants as Record<string, unknown> | undefined;
  near(variants);
  if (variants !== undefined && Object.keys(variants).length === 0) delete answer.variants;
  near((answer.read_as as { as?: Record<string, unknown> } | undefined)?.as);
}

export async function wayOut<A>(shape: Shape<A>, answer: A, asked: Asked<unknown>, hide: Hide): Promise<{ answer: A; refs: OutboundRef[]; pictures: number } | { wait: string }> {
  const copy = structuredClone(answer) as unknown;
  if (isRecord(copy)) trimmed(shape as Shape<unknown>, copy, asked);
  const spots: Spot[] = [];
  const keys: { kind: Leaf; key: string; set(key: string): void }[] = [];
  let whole: unknown = copy;
  walk(copy, leavesOf(shape as Shape<unknown>), spots, (next) => void (whole = next), keys);

  const words = spots.filter((spot) => !["ref", "cursor", "label"].includes(spot.kind));
  const toHide: Text[] = [];
  const setters: ((hidden: HiddenText) => void)[] = [];
  let pictures = 0;
  for (const spot of words) {
    if (spot.kind === "term" && typeof spot.said === "string") {
      const back = writtenOf(spot.said, asked);
      if (back !== undefined) {
        spot.set(back);
        continue;
      }
    }
    if (spot.kind === "picture" && typeof spot.said === "string") {
      toHide.push({ picture: spot.said });
      setters.push((hidden) => {
        if (typeof hidden !== "string" && "jpeg" in hidden) pictures += 1;
        spot.set(typeof hidden === "string" ? hidden : "jpeg" in hidden ? dataUrl(hidden.jpeg) : hidden.cannot);
      });
      continue;
    }
    toHide.push(textOf(spot.kind, spot.said, asked));
    setters.push((hidden) => {
      const text = typeof hidden === "string" ? hidden : "cannot" in hidden ? hidden.cannot : "";
      spot.set(spot.kind === "excerpt" && asked.hides ? excerptOf(text, spot.said, asked) : text);
    });
  }
  const renames: (() => void)[] = [];
  for (const each of keys.filter((key) => key.kind !== "label")) {
    const back = each.kind === "term" ? writtenOf(each.key, asked) : undefined;
    if (back !== undefined) {
      renames.push(() => each.set(back));
      continue;
    }
    toHide.push(textOf("free", each.key, asked));
    setters.push((hidden) => renames.push(() => each.set(typeof hidden === "string" ? hidden : "cannot" in hidden ? hidden.cannot : "")));
  }
  if (toHide.length > 0) {
    const hidden = await hide(toHide);
    if (!("texts" in hidden)) return hidden;
    hidden.texts.forEach((text, at) => setters[at]!(text));
  }

  const refSpots = spots.filter((spot) => spot.kind === "ref" || spot.kind === "cursor");
  const refs: OutboundRef[] = [];
  if (refSpots.length > 0) {
    const kept = asked.kept ?? 0;
    const hits = isRecord(copy) && isRecord(copy.record) && Array.isArray(copy.record.hits) ? copy.record.hits.length : 0;
    const details = refSpots.map((spot) => {
      const ref = String(spot.said);
      if (spot.kind === "cursor") return continuation(ref, { ...asked, kept: kept + hits });
      if (ref.startsWith("row.")) return continuation(ref, asked.rows?.[ref] ?? asked);
      refs.push(...outboundOf(ref));
      return ref;
    });
    const hidden = await hide(details.map((detail) => [{ text: detail, is: "ref" }]));
    if (!("texts" in hidden)) return hidden;
    hidden.texts.forEach((handle, at) => refSpots[at]!.set(handle));
  }
  for (const rename of renames) rename();
  if (asked.hides && shape === (searchAnswer as Shape<unknown>) && isRecord(whole)) nearInKept(whole);
  return { answer: whole as A, refs, pictures };
}

type Answered = { status: number; value: unknown };

export interface Through {
  engine: (step: Step) => Promise<Answered>;
  look: Hide;
  hide: Hide;
  marked: Marked;
  current: () => PlaceholderTable;
  passed: () => boolean;
}

interface Listed {
  hits: Record<string, unknown>[];
  next?: string | null;
  [member: string]: unknown;
}

const PAGES = 10;

export function nothing(route: string, level: Level, hides: boolean, written: readonly string[]): Asked<unknown> {
  return { params: {}, route, level, hides, written: {}, placed: [], not_searched: [], terms: {}, seen: [...new Set(written)] };
}

function leftUnopened(answered: Answered, rest: readonly string[]): Answered {
  if (answered.status !== 200) return answered;
  const value = answered.value as { what: string; unopened?: string[] };
  return { status: 200, value: value.what === "refs" ? { ...value, unopened: [...value.unopened ?? [], ...rest] } : { what: "refs", opened: [value], unopened: [...rest] } };
}

export const NAMES_HIDDEN = "Names are hidden from you, so no one is found by a name. Find the person in `search` or `read`, then give the placeholder shown for them as `name`.";

export async function routed(path: (typeof TOOL_ROUTES)[number], asked: Asked<unknown>, through: Through): Promise<Answered | { wait: string }> {
  const { engine, look, hide, passed } = through;
  const params = asked.params as Record<string, unknown>;
  const whole = () => engine({ ask: params, lends: { pieces: true } });
  if (!asked.hides) return whole();
  const rows: Record<(typeof TOOL_ROUTES)[number], () => Promise<Answered | { wait: string }>> = {
    "/v1/count": () => admitted(asked, { candidates: params }, (admission, snapshot) => ({ counted: params, admission, snapshot })),
    "/v1/read": () => opened(),
    "/v1/search": () => searched(),
    "/v1/people/search": () => named(),
  };
  return rows[path]();

  async function named(): Promise<Answered | { wait: string }> {
    const answered = await whole();
    if ("wait" in answered || answered.status !== 200 || !hides(asked.level, "person") || !asked.placed.some((each) => each.as === "guess")) return answered;
    const value = answered.value as { matches: unknown[] };
    return value.matches.length > 0 ? answered : { ...answered, value: { ...value, note: NAMES_HIDDEN } };
  }

  async function opened(): Promise<Answered | { wait: string }> {
    const refs = typeof params.ref === "string" ? [params.ref] : Array.isArray(params.ref) ? params.ref as string[] : [];
    const at = refs.findIndex((ref) => ref.startsWith("row."));
    const row = at === 0 ? refs[0]! : params.cursor === undefined ? undefined : asked.row;
    if (row !== undefined) {
      asked.row = row;
      const one = await admitted(asked.rows?.[row] ?? asked, { candidates: { ref: row } }, (admission, snapshot) => ({ counted: at === 0 ? { ...params, ref: row } : params, admission, snapshot }));
      return refs.length > 1 && !("wait" in one) ? leftUnopened(one, refs.slice(1)) : one;
    }
    if (at > 0) return leftUnopened(await engine({ ask: { ...params, ref: at === 1 ? refs[0] : refs.slice(0, at) }, lends: { pieces: true } }), refs.slice(at));
    return engine({ ask: params, lends: { pieces: true } });
  }

  async function searched(): Promise<Answered | { wait: string }> {
    const plain = await engine({ ask: params, lends: { pieces: true, passages: true, meaning: meaningOf() } });
    if (plain.status !== 200) return plain;
    const value = plain.value as { record?: Listed; screen?: Listed | { unread: string }; read_as?: { without: string[] } };
    const copies = value.record?.hits.flatMap((hit) => (hit.family === "screen" ? [] : [passagesOf(hit).map((passage) => passage.text)]));
    if (value.record !== undefined) {
      const record = await pages(value.record, value.read_as?.without ?? []);
      if (!("listed" in record)) return record;
      value.record = record.listed;
    }
    if (value.screen !== undefined && "hits" in value.screen) {
      const screen = await rounds(value.screen, copies);
      if (!("listed" in screen)) return screen;
      value.screen = screen.listed;
    }
    return plain;
  }

  function meaningOf(): MeaningLent {
    const typed = asked.written.query;
    if (typeof typed !== "string" || asked.not_searched.length > 0 || asked.placed.some((each) => each.as === "guess")) return { withheld: true };
    return { words: restoreDetails(typed, through.current()).text };
  }

  async function pages(first: Listed, without: readonly string[]): Promise<{ listed: Listed } | Answered | { wait: string }> {
    const leaves = leavesOf(ROUTES["/v1/search"].answer as Shape<unknown>).members!.record!.members!.hits!.each as Leaves;
    const limit = (params as { limit?: number }).limit ?? SEARCH_LIMIT;
    const hits: Record<string, unknown>[] = [];
    const following = widely();
    let page = first;
    for (let read = 1; ; read++) {
      const stood = await kept(asked, page.hits, hide, leaves, without);
      if ("wait" in stood) return stood;
      hits.push(...stood);
      if (hits.length >= limit || typeof page.next !== "string" || read === PAGES || passed()) break;
      const more = await following(page.next, limit - hits.length, PAGES - read);
      if (!("listed" in more)) return more;
      page = more.listed;
    }
    return { listed: { ...first, hits, next: page.next ?? null } };
  }

  function widely(): (from: string, need: number, reads: number) => Promise<{ listed: Listed } | Answered> {
    let wide: { list: Listed & Partial<Widened>; at: number } | undefined;
    const taken = (list: Listed & Partial<Widened>, from: number, to: number, next: string | null | undefined): { listed: Listed } => {
      const steps = list.steps!;
      return { listed: { hits: list.hits.slice(from === 0 ? 0 : steps[from - 1]!.hits, to === 0 ? 0 : steps[to - 1]!.hits), next: next ?? null } };
    };
    return async (from, need, reads) => {
      if (wide !== undefined) {
        const { list, at } = wide;
        const read = list.steps!.length;
        if (at + need <= read) {
          wide.at += need;
          return taken(list, at, at + need, list.steps![at + need - 1]!.next);
        }
        wide = undefined;
        if (at < read && list.ended === true) return taken(list, at, read, list.next);
      }
      const more = await engine({ ask: { cursor: from, limit: need }, lends: { pieces: true, passages: true, width: need * reads } });
      if (more.status !== 200) return more;
      const list = (more.value as { record: Listed & Partial<Widened> }).record;
      if (list.steps === undefined) return { listed: list };
      if (need > list.steps.length) return taken(list, 0, list.steps.length, list.next);
      wide = { list, at: need };
      return taken(list, 0, need, list.steps[need - 1]!.next);
    };
  }

  async function rounds(first: Listed, copies: Copies | undefined): Promise<{ listed: Listed | { unread: string } } | Answered | { wait: string }> {
    const unmatched = new Set<string>();
    let nowhere: Set<string> | undefined;
    let list = first;
    let wide = false;
    for (;;) {
      if (wide && list.hits.length === 0) return { listed: list };
      const stood = await screenKept(asked, list.hits as ScreenFound[], hide);
      if ("wait" in stood) return stood;
      const before = unmatched.size;
      for (const each of stood.unmatched) unmatched.add(each);
      const failed = unmatched.size > before;
      if (!wide && (nowhere !== undefined || !failed)) return { listed: { ...list, hits: stood.hits } };
      if (passed()) nowhere = new Set([...unmatched].map((pair) => pair.split("/").slice(2).join("/")));
      wide = failed && nowhere === undefined;
      const again = await engine({
        ask: { ...params, lists: ["screen"] },
        lends: {
          pieces: true, passages: true, meaning: meaningOf(), ...(copies === undefined ? {} : { copies }),
          unmatched: { in: [...unmatched].sort(), nowhere: [...nowhere ?? []].sort(), ...(wide ? { width: ROUND_WIDTH } : {}) },
        },
      });
      if (again.status !== 200) return again;
      const screen = (again.value as { screen: Listed | { unread: string } }).screen;
      if (!("hits" in screen)) return { listed: screen };
      list = screen;
    }
  }

  async function admitted(by: Asked<unknown>, first: Step, then: (admission: Admission, snapshot: Snapshot) => Step): Promise<Answered | { wait: string }> {
    const stands = standsFor(by, look, through.marked);
    for (let again = 0; again < TRIES; again++) {
      const found = await engine(first);
      if (found.status !== 200) return found;
      const stepped = found.value as Stepped;
      if ("answer" in stepped) return { status: 200, value: stepped.answer };
      if (!("candidates" in stepped)) continue;
      const { candidates } = stepped;
      const stopped = candidates.words !== undefined && !walkEndOf(candidates.words).whole;
      const standing = stopped ? undefined : await stands(candidates);
      if (standing !== undefined && "stop" in standing) {
        if ("wait" in standing.stop) return standing.stop;
        return { status: 422, value: { code: "WITHHELD", message: standing.stop.withheld } };
      }
      const admission = admit(candidates, standing ?? ALWAYS);
      if ("unread" in admission) return { status: 422, value: { code: "WITHHELD", message: WITHHELD_COUNT_UNREAD } };
      const counted = await engine(then(admission, candidates.snapshot));
      if (counted.status !== 200) return counted;
      const result = counted.value as Stepped;
      if ("answer" in result) return { status: 200, value: result.answer };
    }
    return { status: 503, value: { code: "NOT_NOW", message: "Your record is being indexed: ask again in a moment" } };
  }
}
