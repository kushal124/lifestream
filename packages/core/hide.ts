import type { Mark, Piece } from "./types.js";
import { isAscii, isCommonWord, isEverydayWord, isFamilyWord, isGivenName, readingOf, runsOf, type Reading } from "./words.js";

type Fold = "words" | "lower" | "last-ten-digits" | "letters-digits" | "exact";

const TYPES = {
  person: { word: "Person", fold: "words", words: { one: "name", many: "names" } },
  account: { word: "Account", fold: "words", words: { one: "account", many: "accounts" } },
  email: { word: "Email", fold: "lower", words: { one: "email address", many: "email addresses" } },
  phone: { word: "Phone", fold: "last-ten-digits", words: { one: "phone number", many: "phone numbers" } },
  address: { word: "Address", fold: "words", words: { one: "address", many: "addresses" } },
  place: { word: "Place", fold: "exact", words: { one: "place", many: "places" } },
  number: { word: "Number", fold: "letters-digits", words: { one: "number", many: "numbers" } },
  secret: { word: "Secret", fold: "exact", words: { one: "password or key", many: "passwords and keys" } },
  link: { word: "Link", fold: "exact", words: { one: "link", many: "links" } },
  word: { word: "Word", fold: "words", words: { one: "listed word", many: "listed words" } },
  ref: { word: null, fold: "exact", words: null },
  face: { word: null, fold: "exact", words: { one: "face", many: "faces" } },
} as const satisfies Record<string, { word: string | null; fold: Fold; words: Words | null }>;

export const SUBTYPES = {
  "number.bank": { about: "a bank account number, IBAN, routing or IFSC code, the last digits of an account", words: { one: "bank number", many: "bank numbers" } },
  "number.card": { about: "a card number, the last digits of a card", words: { one: "card number", many: "card numbers" } },
  "number.government": { about: "a passport, Aadhaar, SSN, driving licence or voter id", words: { one: "government id", many: "government ids" } },
  "number.tax": { about: "a PAN, GSTIN or other tax id", words: { one: "tax id", many: "tax ids" } },
  "number.payment": { about: "a payment address (a UPI id), a wallet address", words: { one: "payment address", many: "payment addresses" } },
  "number.order": { about: "an order, booking, ticket or tracking number", words: { one: "order number", many: "order numbers" } },
} as const satisfies Record<`${keyof typeof TYPES}.${string}`, { about: string; words: Words }>;

export type BaseType = keyof typeof TYPES;
export type DetailType = BaseType | keyof typeof SUBTYPES;

export const DETAIL_TYPES: readonly DetailType[] = [...Object.keys(TYPES), ...Object.keys(SUBTYPES)] as DetailType[];

export interface Words {
  one: string;
  many: string;
}

export interface DetailWords extends Words {
  type: BaseType;
  subtypes: ({ type: DetailType } & Words)[];
}

export const DETAIL_WORDS: readonly DetailWords[] = (Object.entries(TYPES) as [BaseType, (typeof TYPES)[BaseType]][]).flatMap(([type, row]) => (row.words === null ? [] : [{
  type, one: row.words.one, many: row.words.many,
  subtypes: (Object.entries(SUBTYPES) as [keyof typeof SUBTYPES, (typeof SUBTYPES)[keyof typeof SUBTYPES]][])
    .filter(([subtype]) => subtype.startsWith(`${type}.`)).map(([subtype, sub]) => ({ type: subtype, one: sub.words.one, many: sub.words.many })),
}]));

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Marked {
  text: string;
  marks: readonly Mark[];
  quoted?: true;
  leave?: readonly { start: number; end: number }[];
  reading?: Reading;
}

export interface Entry {
  placeholder: string;
  type: DetailType;
  detail: string;
  who?: string;
  shown?: string;
  face?: Box;
}

export interface Owner {
  who: string;
  shown: string;
}

export interface PlaceholderTable {
  scope: string;
  entries: readonly Entry[];
  next: Readonly<Partial<Record<BaseType, number>>>;
}

const LEAVES = {
  all: [],
  names: ["person", "account", "face"],
  none: "every",
} as const satisfies Record<string, readonly BaseType[] | "every">;

export type LevelName = keyof typeof LEAVES;
export type Level = LevelName | readonly DetailType[];
export const LEVEL_NAMES: readonly LevelName[] = Object.keys(LEAVES) as LevelName[];

export const LINKS = ["tokens", "path", "none"] as const;
export type Links = (typeof LINKS)[number];

export type Counts = Partial<Record<DetailType, number>>;

export interface Placed {
  start: number;
  end: number;
  placeholder: string;
}

export interface Hidden {
  texts: string[];
  spans: Placed[][];
  table: PlaceholderTable;
  counts: Counts;
}

export interface Restored {
  text: string;
  marks: (Mark & { placeholder: string })[];
  unknown: string[];
  table: PlaceholderTable;
}

export interface Spelled {
  words: string;
  type: DetailType;
  who?: string;
  shown?: string;
}

export function spelledOf(text: string, marks: readonly Mark[]): Spelled[] {
  return marks.map((mark) => ({
    words: text.slice(mark.start, mark.end), type: mark.type, ...(mark.who === undefined ? {} : { who: mark.who }), ...(mark.shown === undefined ? {} : { shown: mark.shown }),
  }));
}

export function statedIn(pieces: readonly Piece[]): Spelled[] {
  return pieces.flatMap((piece): Spelled[] => {
    if ("is" in piece) return [{ words: piece.text, type: piece.is, ...(piece.who === undefined ? {} : { who: piece.who }), ...(piece.shown === undefined ? {} : { shown: piece.shown }) }];
    if ("free" in piece && piece.known !== undefined) return spelledOf(piece.whole ?? piece.text, piece.known);
    return [];
  }).filter((detail) => detail.words.trim() !== "" && detail.type !== "ref" && detail.type !== "face");
}

export function wordMarks(text: string, details: readonly Spelled[]): Mark[] {
  const marks: Mark[] = [];
  const covered = new Uint8Array(text.length);
  const taken = (start: number, end: number) => covered.subarray(start, end).includes(1);
  for (const detail of [...details].sort((left, right) => right.words.length - left.words.length)) {
    if (detail.words.trim() === "") continue;
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${detail.words.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![\\p{L}\\p{N}])`, "gu");
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + detail.words.length;
      if (taken(start, end)) continue;
      covered.fill(1, start, end);
      marks.push({ start, end, type: detail.type, ...(detail.who === undefined ? {} : { who: detail.who }), ...(detail.shown === undefined ? {} : { shown: detail.shown }) });
    }
  }
  return marks.sort((left, right) => left.start - right.start);
}

export class HideError extends Error {
  override name = "HideError";
}

const WORDS = Object.values(TYPES).flatMap((row) => (row.word === null ? [] : [row.word]));
const WORD_TYPE = new Map(Object.entries(TYPES).flatMap(([type, row]) => (row.word === null ? [] : [[row.word.toLowerCase(), type as BaseType]])));
const ALTERNATION = WORDS.join("|");
const BRACKETED = new RegExp(`\\[\\[[^\\S\\n]*(?:${ALTERNATION})(?![\\p{L}\\p{M}])[^\\[\\]\\n]*\\]\\]`, "giu");
const INSIDE = new RegExp(`^\\s*(${ALTERNATION})[ _-]?(\\d{1,9})\\s*$`, "iu");
const CROSSING: ReadonlySet<BaseType> = new Set((Object.keys(TYPES) as BaseType[]).filter((base) => base !== "person" && base !== "ref" && base !== "face"));
const CROSSING_LIST: readonly BaseType[] = [...CROSSING];
const CROSSING_FOLDS: readonly Fold[] = [...new Set([...CROSSING].map((base) => TYPES[base].fold))];

const BARE_HINT = new RegExp(`(?:${ALTERNATION}) \\d`, "gu");
const BARE_DIGITS = 6;
const BARE = new RegExp(`(?<![\\p{L}\\p{N}])(${ALTERNATION}) (\\d{1,${BARE_DIGITS}})(?![\\p{L}\\p{N}])`, "gu");

export function isDetailType(value: unknown): value is DetailType {
  return typeof value === "string" && (Object.hasOwn(TYPES, value) || Object.hasOwn(SUBTYPES, value));
}

export function baseOf(type: DetailType): BaseType {
  const dot = type.indexOf(".");
  return (dot === -1 ? type : type.slice(0, dot)) as BaseType;
}

export function hides(level: Level, type: DetailType): boolean {
  const base = baseOf(type);
  if (base === "ref") return false;
  if (typeof level === "string") {
    const leaves = LEAVES[level];
    return leaves !== "every" && !(leaves as readonly BaseType[]).includes(base);
  }
  return level.some((named) => named === type || named === base || (type === base && baseOf(named) === base));
}

export function hidesAny(level: Level): boolean {
  return typeof level === "string" ? LEAVES[level] !== "every" : level.length > 0;
}

export function fold(type: DetailType, text: string): string {
  return foldBy(TYPES[baseOf(type)].fold, text);
}

function foldBy(rule: Fold, text: string): string {
  switch (rule) {
    case "words":
      return foldWords(text);
    case "lower":
      return text.normalize("NFC").toLowerCase().trim();
    case "last-ten-digits": {
      const digits = text.replace(/\D/gu, "");
      return digits === "" ? foldWords(text) : digits.slice(-10);
    }
    case "letters-digits": {
      const kept = isAscii(text, 0, text.length) ? text.toUpperCase().replace(NOT_ASCII_LETTER_OR_DIGIT, "") : text.normalize("NFC").toUpperCase().replace(NOT_LETTER_OR_DIGIT, "");
      return kept === "" ? foldWords(text) : kept;
    }
    case "exact":
      return text;
  }
}

function foldWords(text: string): string {
  return isAscii(text, 0, text.length) && !UNEVEN_SPACE.test(text) ? text.toLowerCase() : text.normalize("NFC").toLowerCase().replace(/\s+/gu, " ").trim();
}

const UNEVEN_SPACE = /[^\S ]| {2}|^ | $/u;
const NOT_LETTER_OR_DIGIT = /[^\p{L}\p{N}]/gu;
const NOT_ASCII_LETTER_OR_DIGIT = /[^A-Z0-9]/gu;

export function detailKey(type: DetailType, text: string): string {
  const base = baseOf(type);
  const rule = TYPES[base].fold;
  return keyOf(CROSSING.has(base) ? rule : base, foldBy(rule, text));
}

function keyOf(head: string, folded: string): string {
  return `${head}\u0000${folded}`;
}

function typeKey(type: DetailType, text: string): string {
  return keyOf(baseOf(type), fold(type, text));
}

export function oneValue(left: { type: DetailType; text: string }, right: { type: DetailType; text: string }): boolean {
  const [one, other] = [baseOf(left.type), baseOf(right.type)];
  if (one !== other && !(CROSSING.has(one) && CROSSING.has(other))) return false;
  return fold(left.type, left.text) === fold(left.type, right.text) && fold(right.type, left.text) === fold(right.type, right.text);
}

function valueKeys(type: DetailType, text: string): string[] {
  const base = baseOf(type);
  if (!CROSSING.has(base)) return [detailKey(type, text)];
  const own = TYPES[base].fold;
  const keys = [keyOf(own, foldBy(own, text))];
  for (const rule of CROSSING_FOLDS) if (rule !== own) keys.push(keyOf(rule, foldBy(rule, text)));
  return keys;
}

function typeKeys(type: DetailType, text: string): string[] {
  const base = baseOf(type);
  if (!CROSSING.has(base)) return [typeKey(type, text)];
  const folded: Partial<Record<Fold, string>> = {};
  const keys: string[] = [];
  for (let at = -1; at < CROSSING_LIST.length; at += 1) {
    const other = at === -1 ? base : CROSSING_LIST[at]!;
    if (at !== -1 && other === base) continue;
    const rule = TYPES[other].fold;
    keys.push(keyOf(other, (folded[rule] ??= foldBy(rule, text))));
  }
  return keys;
}

class Values<T extends { type: DetailType; text: string }> {
  readonly #byKey = new Map<string, T[]>();
  readonly #spelled = new Set<string>();

  add(item: T, key = typeKey(item.type, item.text)): void {
    const spelled = `${item.type}\u0000${item.text}`;
    if (this.#spelled.has(spelled)) return;
    this.#spelled.add(spelled);
    const held = this.#byKey.get(key);
    if (held === undefined) this.#byKey.set(key, [item]);
    else held.push(item);
  }

  first(type: DetailType, text: string): T | undefined {
    for (const key of typeKeys(type, text)) {
      for (const item of this.#byKey.get(key) ?? []) if (oneValue(item, { type, text })) return item;
    }
    return undefined;
  }
}

interface Held {
  type: DetailType;
  text: string;
  who?: string;
  at: number;
  anyCase: boolean;
  plain: boolean;
  ascii: boolean;
  lower: string;
}

function otherCase(text: string, start: number, end: number, held: Held, lower: string | null): boolean {
  const same = lower !== null && held.ascii && isAscii(text, start, end) ? lower.startsWith(held.lower, start) : otherFold(text.slice(start, end)) === otherFold(held.text);
  return same && (!held.plain || CAPITAL.test(text.slice(start, end)));
}

function otherFold(written: string): string {
  return isAscii(written, 0, written.length) ? written.toLowerCase() : written.normalize("NFC").toLowerCase();
}

const CAPITAL = /\p{Lu}/u;
const JOINER = /[/\\@_=#%~]|[\p{L}\p{N}]\.[\p{L}\p{N}]/u;
const REACH = 256;

function joined(text: string, start: number, end: number): boolean {
  let from = start;
  while (from > 0 && !/\s/u.test(text[from - 1]!)) if (start - --from > REACH) return true;
  let to = end;
  while (to < text.length && !/\s/u.test(text[to]!)) if (++to - end > REACH) return true;
  return JOINER.test(text.slice(from, start + 1)) || JOINER.test(text.slice(end - 1, to));
}

class ByWord {
  readonly #byRun = new Map<string, Held[]>();
  readonly #spelled = new Set<string>();
  readonly #lengths = new Set<number>();

  get empty(): boolean {
    return this.#byRun.size === 0;
  }

  add(value: { type: DetailType; text: string; who?: string }): void {
    if (baseOf(value.type) === "ref") return;
    const spelled = `${value.type}\u0000${value.text}`;
    if (this.#spelled.has(spelled)) return;
    this.#spelled.add(spelled);
    const runs = runsOf(value.text);
    const run = longestRun(value.text, runs);
    if (run === null || (run.word === value.text && isCommonWord(run.word))) return;
    const ascii = isAscii(value.text, 0, value.text.length);
    const anyCase = TYPES[baseOf(value.type)].fold !== "exact" && (CAPITAL.test(value.text) || (baseOf(value.type) === "person" && everyRun(value.text, isName, runs)));
    const plain = anyCase && everyRun(value.text, isEverydayWord, runs);
    const held: Held = { ...value, at: run.at, anyCase, plain, ascii, lower: ascii ? value.text.toLowerCase() : "" };
    const key = wordFold(run.word);
    this.#lengths.add(key.length);
    const same = this.#byRun.get(key);
    if (same === undefined) this.#byRun.set(key, [held]);
    else same.push(held);
  }

  marks(text: string, marks: readonly { start: number; end: number }[], reading?: Reading): Mark[] {
    const matches: { start: number; end: number; held: Held }[] = [];
    const covered = new Uint8Array(text.length);
    for (let at = 0; at < marks.length; at += 1) covered.fill(1, marks[at]!.start, marks[at]!.end);
    for (const span of placeholderSpans(text)) covered.fill(1, span.start, span.end);
    const { runs, lower } = readingOf(text, reading);
    for (let at = 0; at < runs.length; at += 2) {
      const from = runs[at]!;
      const to = runs[at + 1]!;
      if (covered[from] === 1) continue;
      let key: string;
      if (lower !== null && isAscii(text, from, to)) {
        if (!this.#lengths.has(to - from)) continue;
        key = lower.slice(from, to);
      } else key = wordFold(text.slice(from, to));
      const same = this.#byRun.get(key);
      if (same === undefined) continue;
      for (let each = 0; each < same.length; each += 1) {
        const held = same[each]!;
        const start = from - held.at;
        const end = start + held.text.length;
        if (start < 0 || end > text.length) continue;
        if ((start > 0 && WORD_CHARACTER.test(text[start - 1]!)) || (end < text.length && WORD_CHARACTER.test(text[end]!))) continue;
        if (!text.startsWith(held.text, start) && !(held.anyCase && otherCase(text, start, end, held, lower) && !joined(text, start, end))) continue;
        matches.push({ start, end, held });
      }
    }
    if (matches.length === 0) return [];
    const found: Mark[] = [];
    for (const { start, end, held } of matches.sort((left, right) => right.end - right.start - (left.end - left.start) || left.start - right.start)) {
      if (anyOne(covered, start, end)) continue;
      covered.fill(1, start, end);
      found.push({ start, end, type: held.type, ...(held.who === undefined ? {} : { who: held.who }) });
    }
    return found;
  }
}

function anyOne(bytes: Uint8Array, start: number, end: number): boolean {
  for (let at = start; at < end; at += 1) if (bytes[at] === 1) return true;
  return false;
}

export interface Wanted {
  who: Set<string>;
  keys: Set<string>;
  placeholders: Set<string>;
  words: Set<string>;
}

export function wantedOf(texts: readonly Marked[]): Wanted {
  const wanted: Wanted = { who: new Set(), keys: new Set(), placeholders: new Set(["[[Person 0]]"]), words: new Set() };
  const read = new Set<string>();
  for (const { text, marks, quoted, leave, reading } of texts) {
    if (!quoted) {
      const left = leave === undefined || leave.length === 0 ? null : leftOf(text, leave);
      const { runs, lower } = readingOf(text, reading);
      for (let at = 0; at < runs.length; at += 2) {
        const from = runs[at]!;
        const to = runs[at + 1]!;
        let open = left === null;
        for (let each = from; each < to && !open; each += 1) open = left![each] === 0;
        if (open) wanted.words.add(lower !== null && isAscii(text, from, to) ? lower.slice(from, to) : wordFold(text.slice(from, to)));
      }
    }
    for (let at = 0; at < marks.length; at += 1) {
      const mark = marks[at]!;
      if (mark.who !== undefined) wanted.who.add(mark.who);
      if (!isDetailType(mark.type)) continue;
      const value = text.slice(mark.start, mark.end);
      const spelled = `${mark.type}\u0000${value}`;
      if (read.has(spelled)) continue;
      read.add(spelled);
      for (const key of valueKeys(mark.type, value)) wanted.keys.add(key);
    }
    for (const match of text.matchAll(BRACKETED)) {
      wanted.keys.add(detailKey("word", match[0]));
      const known = canonical(match[0].slice(2, -2));
      if (known !== null) wanted.placeholders.add(known.placeholder);
    }
    for (const match of text.matchAll(BARE)) {
      wanted.keys.add(detailKey("word", match[0]));
      wanted.placeholders.add(`[[${match[0]}]]`);
    }
  }
  return wanted;
}

export function wants(wanted: Wanted, entry: Entry): boolean {
  if ((entry.who !== undefined && wanted.who.has(entry.who)) || wanted.keys.has(detailKey(entry.type, entry.detail)) || wanted.placeholders.has(entry.placeholder)) return true;
  const word = valueWord(entry.detail);
  return word !== null && wanted.words.has(word);
}

function wordFold(run: string): string {
  return isAscii(run, 0, run.length) ? run.toLowerCase() : run.normalize("NFC").toLowerCase();
}

function everyRun(text: string, test: (word: string) => boolean, runs = runsOf(text)): boolean {
  for (let at = 0; at < runs.length; at += 2) if (!test(text.slice(runs[at], runs[at + 1]))) return false;
  return true;
}

const isName = (word: string): boolean => isGivenName(word) || isFamilyWord(word);

function longestRun(value: string, runs = runsOf(value)): { word: string; at: number } | null {
  let best = -1;
  for (let at = 0; at < runs.length; at += 2) if (best === -1 || runs[at + 1]! - runs[at]! > runs[best + 1]! - runs[best]!) best = at;
  return best === -1 ? null : { word: value.slice(runs[best], runs[best + 1]), at: runs[best]! };
}

export function valueWord(value: string): string | null {
  const run = longestRun(value);
  return run === null ? null : wordFold(run.word);
}

export function emptyTable(scope: string): PlaceholderTable {
  return { scope, entries: [], next: {} };
}

export function placeholderSpans(text: string): { start: number; end: number }[] {
  return [...text.matchAll(BRACKETED)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
}

export function bracketHeld(text: string, table: PlaceholderTable): string {
  const held = new Set(table.entries.map((entry) => entry.placeholder));
  const inside = insideOf(placeholderSpans(text));
  return text.replace(BARE, (bare: string, _word: string, _number: string, at: number) => (!inside(at) && held.has(`[[${bare}]]`) ? `[[${bare}]]` : bare));
}

export function placeholderSpelling(bracketed: string): string | null {
  return canonical(bracketed.slice(2, -2))?.placeholder ?? null;
}

function canonical(inside: string): { placeholder: string; base: BaseType; number: number } | null {
  const match = INSIDE.exec(inside);
  if (match === null) return null;
  const base = WORD_TYPE.get(match[1]!.toLowerCase())!;
  const number = Number(match[2]);
  return { placeholder: `[[${TYPES[base].word} ${number}]]`, base, number };
}

interface Chosen {
  at: number;
  start: number;
  end: number;
  type: DetailType;
  who?: string;
  shown?: string;
  text: string;
  group?: Group;
}

interface Group {
  entry: Entry;
  first: [number, number] | null;
}

function leftOf(text: string, leave: Marked["leave"]): Uint8Array {
  const left = new Uint8Array(text.length);
  for (const span of leave ?? []) {
    if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end < span.start || span.end > text.length) {
      throw new HideError(`a span to leave from ${span.start} to ${span.end} is outside a text of ${text.length} characters`);
    }
    left.fill(1, span.start, span.end);
  }
  return left;
}

function heldOf(texts: readonly Marked[], level: Level, table: PlaceholderTable, never: readonly string[]): { values: () => Values<{ type: DetailType; text: string }>; byWord: ByWord } {
  const byWord = new ByWord();
  const each = (take: (value: { type: DetailType; text: string; who?: string }) => void) => {
    if (!hidesAny(level)) return;
    const listed = new Set(never.map((word) => word.normalize("NFC").toLowerCase()));
    const plain = (text: string) => listed.size > 0 && listed.has(text.normalize("NFC").toLowerCase());
    for (const entry of table.entries) {
      if (entry.face !== undefined || (baseOf(entry.type) === "person" && !hides(level, entry.type)) || plain(entry.detail)) continue;
      take({ type: entry.type, text: entry.detail, ...(entry.who === undefined ? {} : { who: entry.who }) });
    }
    const read = new Set<string>();
    for (const { text, marks, quoted } of texts) {
      if (quoted) continue;
      for (let at = 0; at < marks.length; at += 1) {
        const mark = marks[at]!;
        if (!isDetailType(mark.type) || mark.type === "face" || !hides(level, mark.type)) continue;
        const value = text.slice(mark.start, mark.end);
        const spelled = `${mark.type}\u0000${value}`;
        if (read.has(spelled) || plain(value)) continue;
        read.add(spelled);
        take({ type: mark.type, text: value, ...(mark.who === undefined ? {} : { who: mark.who }) });
      }
    }
  };
  each((value) => byWord.add(value));
  let values: Values<{ type: DetailType; text: string }> | null = null;
  return {
    byWord,
    values: () => {
      if (values === null) {
        const made = (values = new Values<{ type: DetailType; text: string }>());
        each((value) => made.add({ type: value.type, text: value.text }));
      }
      return values;
    },
  };
}

function heldIn(byWord: ByWord, marked: Marked): Mark[] {
  if (marked.quoted || byWord.empty) return [];
  return byWord.marks(marked.text, [...marked.marks, ...(marked.leave ?? [])], marked.reading).sort((left, right) => left.start - right.start);
}

export function heldMarks(texts: readonly Marked[], level: Level, table: PlaceholderTable, never: readonly string[] = []): Mark[][] {
  const { byWord } = heldOf(texts, level, table, never);
  return texts.map((marked) => heldIn(byWord, marked));
}

export function hideDetails(texts: readonly Marked[], level: Level, table: PlaceholderTable, owner: Owner | null, never: readonly string[] = []): Hidden {
  const hiding = hidesAny(level);
  const book = new Book(table, owner?.who ?? null);
  if (owner !== null) book.seed(owner);
  const held = new Set(book.table().entries.map((entry) => entry.placeholder));
  const { values: hiddenValues, byWord } = heldOf(texts, level, table, never);
  const withHeld = texts.map((each) => {
    const held = heldIn(byWord, each);
    return held.length === 0 ? each : { ...each, marks: [...each.marks, ...held] };
  });
  const chosen = withHeld.map((each, at) => choose(each, at, level, hiding, held, (type, text) => hiddenValues().first(type, text) !== undefined));
  const standing = new Set<string>();
  texts.forEach((marked, at) => {
    const readable = hiding && !marked.quoted ? hinted(marked.text, chosen[at]!) : [[0, marked.text.length] as [number, number]];
    for (const [start, end] of readable) {
      for (const match of marked.text.slice(start, end).matchAll(BARE)) standing.add(match[0]);
    }
  });
  const single = (mark: Chosen) => baseOf(mark.type) === "person" && mark.who === undefined && !fold("person", mark.text).includes(" ");
  const all = chosen.flat();
  for (const mark of all) if (!single(mark)) mark.group = book.resolve(mark);
  const holdersOf = new Map<string, Set<Group>>();
  const namesOf = new Map<Group, Set<string>>();
  for (const mark of all) {
    if (baseOf(mark.type) !== "person") continue;
    const folded = fold("person", mark.text);
    if (!folded.includes(" ")) continue;
    for (const word of wordsOf(folded)) {
      const holders = holdersOf.get(word);
      if (holders === undefined) holdersOf.set(word, new Set([mark.group!]));
      else holders.add(mark.group!);
    }
    const names = namesOf.get(mark.group!);
    if (names === undefined) namesOf.set(mark.group!, new Set([mark.text]));
    else names.add(mark.text);
  }
  const gone = new Set<Chosen>();
  const covers = new Map<number, Covers>();
  const coversOf = (at: number) => {
    let made = covers.get(at);
    if (made === undefined) covers.set(at, (made = new Covers(texts[at]!.text.length, chosen[at]!)));
    return made;
  };
  for (const mark of all) {
    if (!single(mark) || gone.has(mark)) continue;
    const holders = holdersOf.get(fold("person", mark.text));
    if (holders === undefined || holders.size !== 1) continue;
    const [group] = holders;
    besideFuller(mark, texts[mark.at]!.text, coversOf(mark.at), namesOf.get(group!)!, (other) => single(other) || other.group === group, gone);
    mark.group = book.join(group!, mark);
  }
  for (const mark of all) if (mark.group === undefined && !gone.has(mark)) mark.group = book.resolve(mark);
  if (gone.size > 0) chosen.forEach((marks, at) => (chosen[at] = marks.filter((mark) => !gone.has(mark))));
  book.number(standing);
  const counts: Counts = {};
  const spans: Placed[][] = [];
  const hidden = texts.map((marked, at) => {
    const placed: Placed[] = [];
    let out = "";
    let from = 0;
    for (const mark of chosen[at]!) {
      const placeholder = mark.group!.entry.placeholder;
      placed.push({ start: mark.start, end: mark.end, placeholder });
      out += marked.text.slice(from, mark.start) + placeholder;
      counts[mark.type] = (counts[mark.type] ?? 0) + 1;
      from = mark.end;
    }
    spans.push(placed);
    return out + marked.text.slice(from);
  });
  return { texts: hidden, spans, table: book.table(), counts };
}

export function restoreDetails(text: string, table: PlaceholderTable): Restored {
  const held = new Map(table.entries.map((entry) => [entry.placeholder, entry]));
  const next: Partial<Record<BaseType, number>> = { ...table.next };
  const bracketed = [...text.matchAll(BRACKETED)].map((match) => ({ start: match.index, end: match.index + match[0].length, bare: false }));
  const inside = insideOf(bracketed);
  const bare = [...text.matchAll(BARE)].filter((match) => !inside(match.index)).map((match) => ({ start: match.index, end: match.index + match[0].length, bare: true }));
  const marks: (Mark & { placeholder: string })[] = [];
  const unknown: string[] = [];
  let out = "";
  let from = 0;
  for (const span of [...bracketed, ...bare].sort((left, right) => left.start - right.start)) {
    const written = text.slice(span.start, span.end);
    out += text.slice(from, span.start);
    from = span.end;
    const known = canonical(span.bare ? written : written.slice(2, -2));
    const entry = known === null ? undefined : held.get(span.bare ? `[[${written}]]` : known.placeholder);
    if (entry === undefined) {
      if (!span.bare) unknown.push(written);
      if (known !== null && String(known.number).length <= BARE_DIGITS) next[known.base] = Math.max(next[known.base] ?? 1, known.number + 1);
      out += written;
    } else if (entry.face !== undefined) {
      out += entry.placeholder;
    } else {
      const words = entry.shown ?? entry.detail;
      marks.push({ start: out.length, end: out.length + words.length, type: entry.type, ...(entry.who === undefined ? {} : { who: entry.who }), ...(entry.shown === undefined ? {} : { shown: entry.shown }), placeholder: written });
      out += words;
    }
  }
  return { text: out + text.slice(from), marks, unknown, table: { ...table, next } };
}

function choose(marked: Marked, at: number, level: Level, hiding: boolean, held: ReadonlySet<string>, hidden: (type: DetailType, text: string) => boolean): Chosen[] {
  const { text } = marked;
  if (marked.quoted) {
    if (marked.marks.length > 0) throw new HideError("a quote holds no marks: it leaves as the model wrote it");
    return [];
  }
  const sorted = [...marked.marks].sort((left, right) => left.start - right.start || left.end - right.end);
  sorted.forEach((mark, index) => {
    if (!Number.isInteger(mark.start) || !Number.isInteger(mark.end) || mark.start < 0 || mark.end <= mark.start || mark.end > text.length) {
      throw new HideError(`a mark from ${mark.start} to ${mark.end} is outside a text of ${text.length} characters`);
    }
    if (!isDetailType(mark.type)) throw new HideError(`${JSON.stringify(mark.type)} is no type of detail`);
    if (mark.type === "face") throw new HideError("a face is a picture's, never a text's mark");
    const before = sorted[index - 1];
    if (before !== undefined && before.end > mark.start) throw new HideError(`two marks overlap at ${mark.start}: merge them first`);
  });
  const chosen: Chosen[] = sorted
    .filter((mark) => baseOf(mark.type) === "ref" || hides(level, mark.type) || hidden(mark.type, text.slice(mark.start, mark.end)))
    .map((mark) => ({ at, start: mark.start, end: mark.end, type: mark.type, text: text.slice(mark.start, mark.end), ...(mark.who === undefined ? {} : { who: mark.who }), ...(mark.shown === undefined ? {} : { shown: mark.shown }) }));
  const left = leftOf(text, marked.leave);
  if (!hiding) return chosen;
  const forced: Chosen[] = [];
  for (const [start, end] of hinted(text, chosen)) {
    const run = text.slice(start, end);
    const bracketed = [...run.matchAll(BRACKETED)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
    const spans = [...bracketed];
    const inside = insideOf(bracketed);
    for (const match of run.matchAll(BARE)) {
      if (held.has(`[[${match[0]}]]`) && !inside(match.index)) spans.push({ start: match.index, end: match.index + match[0].length });
    }
    for (const span of spans) if (!left.subarray(start + span.start, start + span.end).includes(1)) forced.push({ at, start: start + span.start, end: start + span.end, type: "word", text: run.slice(span.start, span.end) });
  }
  return [...chosen, ...forced].sort((left, right) => left.start - right.start);
}

function shapeHints(text: string): number[] {
  const at: number[] = [];
  for (let found = text.indexOf("[["); found !== -1; found = text.indexOf("[[", found + 1)) at.push(found);
  for (const match of text.matchAll(BARE_HINT)) at.push(match.index);
  return at.sort((left, right) => left - right);
}

function insideOf(spans: readonly { start: number; end: number }[]): (at: number) => boolean {
  let next = 0;
  return (at) => {
    while (next < spans.length && spans[next]!.end <= at) next += 1;
    return next < spans.length && spans[next]!.start <= at;
  };
}

function hinted(text: string, chosen: readonly Chosen[]): [number, number][] {
  const hints = shapeHints(text);
  const runs: [number, number][] = [];
  let mark = 0;
  let from = 0;
  for (let at = 0; at < hints.length; at += 1) {
    const hint = hints[at]!;
    while (mark < chosen.length && chosen[mark]!.start <= hint) {
      from = Math.max(from, chosen[mark]!.end);
      mark += 1;
    }
    if (hint < from) continue;
    const end = mark < chosen.length ? chosen[mark]!.start : text.length;
    if (runs.length > 0 && runs.at(-1)![0] === from) continue;
    runs.push([from, end]);
  }
  return runs;
}

function wordsOf(folded: string): string[] {
  return folded.split(/[^\p{L}\p{M}\p{N}'’]+/u).filter((word) => word !== "");
}

function besideFuller(mark: Chosen, text: string, covers: Covers, names: ReadonlySet<string>, takes: (other: Chosen) => boolean, gone: Set<Chosen>): void {
  const written = mark.text.toLowerCase();
  if (written.length !== mark.text.length) return;
  let best: { start: number; end: number; inside: Chosen[] } | null = null;
  for (const name of names) {
    const lower = name.toLowerCase();
    if (lower.length !== name.length) continue;
    for (let at = lower.indexOf(written); at !== -1; at = lower.indexOf(written, at + 1)) {
      const start = mark.start - at;
      const end = start + lower.length;
      if (start < 0 || end > text.length || end - start <= (best === null ? mark.end - mark.start : best.end - best.start)) continue;
      if (text.slice(start, end).toLowerCase() !== lower) continue;
      if ((start > 0 && WORD_CHARACTER.test(text[start - 1]!)) || (end < text.length && WORD_CHARACTER.test(text[end]!))) continue;
      const inside = covers.met(start, end).filter((other) => other !== mark);
      if (inside.every((other) => other.start >= start && other.end <= end && takes(other))) best = { start, end, inside };
    }
  }
  if (best === null) return;
  for (const other of best.inside) gone.add(other);
  Object.assign(mark, { start: best.start, end: best.end, text: text.slice(best.start, best.end) });
  covers.take(mark, best.start, best.end);
}

class Covers {
  readonly #at: Int32Array;
  readonly #marks: Chosen[];
  readonly #index = new Map<Chosen, number>();

  constructor(length: number, marks: readonly Chosen[]) {
    this.#at = new Int32Array(length);
    this.#marks = [...marks];
    this.#marks.forEach((mark, index) => {
      this.#index.set(mark, index + 1);
      this.#at.fill(index + 1, mark.start, mark.end);
    });
  }

  met(start: number, end: number): Chosen[] {
    const met: Chosen[] = [];
    let last = 0;
    for (let at = start; at < end; at += 1) {
      const index = this.#at[at]!;
      if (index !== 0 && index !== last) met.push(this.#marks[index - 1]!);
      last = index;
    }
    return met;
  }

  take(mark: Chosen, start: number, end: number): void {
    this.#at.fill(this.#index.get(mark)!, start, end);
  }
}

const WORD_CHARACTER = /[\p{L}\p{M}\p{N}]/u;

class Book {
  readonly #given: Group[];
  readonly #fresh: Group[] = [];
  readonly #byWho = new Map<string, Group>();
  readonly #byText = new Map<string, Group[]>();
  readonly #values = new Values<{ type: DetailType; text: string; group: Group }>();
  readonly #next: Partial<Record<BaseType, number>>;

  constructor(private readonly start: PlaceholderTable, private readonly owner: string | null) {
    this.#next = { ...start.next };
    this.#given = start.entries.map((entry) => ({ entry: { ...entry }, first: null }));
    for (const group of this.#given) if (group.entry.face === undefined) this.#index(group);
  }

  seed(owner: Owner): void {
    const held = this.#given.find((group) => group.entry.placeholder === "[[Person 0]]");
    if (held !== undefined) {
      held.entry.shown = owner.shown;
      return;
    }
    const group: Group = { entry: { placeholder: "[[Person 0]]", type: "person", detail: owner.shown, who: owner.who, shown: owner.shown }, first: null };
    this.#given.unshift(group);
    this.#index(group);
  }

  resolve(mark: Chosen): Group {
    const base = baseOf(mark.type);
    const byWho = base === "person" && mark.who !== undefined ? this.#byWho.get(mark.who) : undefined;
    if (byWho !== undefined) return this.join(byWho, mark);
    const key = typeKey(mark.type, mark.text);
    const same = this.#byText.get(key) ?? [];
    let found: Group | undefined;
    if (base === "person" && mark.who !== undefined) {
      found = mark.who === this.owner ? undefined : same.find((group) => group.entry.who === undefined);
    } else if (base === "person") {
      found = same.find((group) => group.entry.who === undefined) ?? (same.length === 1 ? same[0] : undefined);
    } else {
      found = same[0] ?? this.#values.first(mark.type, mark.text)?.group;
    }
    if (found !== undefined) return this.join(found, mark);
    const entry: Entry = {
      placeholder: base === "person" && mark.who !== undefined && mark.who === this.owner ? "[[Person 0]]" : "",
      type: mark.type,
      detail: mark.text,
      ...(mark.who === undefined ? {} : { who: mark.who }),
      ...(mark.shown === undefined ? {} : { shown: mark.shown }),
    };
    const group: Group = { entry, first: [mark.at, mark.start] };
    this.#fresh.push(group);
    this.#index(group, key);
    return group;
  }

  join(group: Group, mark: Chosen): Group {
    const { entry } = group;
    if (entry.who === undefined && mark.who !== undefined) {
      entry.who = mark.who;
      if (baseOf(entry.type) === "person") this.#byWho.set(mark.who, group);
    }
    if (entry.shown === undefined && mark.shown !== undefined) entry.shown = mark.shown;
    if (group.first === null || mark.at < group.first[0] || (mark.at === group.first[0] && mark.start < group.first[1])) group.first = [mark.at, mark.start];
    return group;
  }

  number(standing: ReadonlySet<string>): void {
    for (const spelled of standing) {
      const known = canonical(spelled)!;
      this.#next[known.base] = Math.max(this.#next[known.base] ?? 1, known.number + 1);
    }
    const order = [...this.#given, ...this.#fresh]
      .filter((group) => group.entry.placeholder === "" && group.first !== null)
      .sort((left, right) => left.first![0] - right.first![0] || left.first![1] - right.first![1]);
    for (const group of order) {
      const base = baseOf(group.entry.type);
      const word = TYPES[base].word;
      const number = this.#next[base] ?? 1;
      group.entry.placeholder = word === null ? `r${number}` : `[[${word} ${number}]]`;
      this.#next[base] = number + 1;
    }
  }

  table(): PlaceholderTable {
    const fresh = [...this.#fresh].sort((left, right) => left.first![0] - right.first![0] || left.first![1] - right.first![1]);
    return { scope: this.start.scope, entries: [...this.#given, ...fresh].map((group) => group.entry), next: { ...this.#next } };
  }

  #index(group: Group, key = typeKey(group.entry.type, group.entry.detail)): void {
    const same = this.#byText.get(key);
    if (same === undefined) this.#byText.set(key, [group]);
    else same.push(group);
    this.#values.add({ type: group.entry.type, text: group.entry.detail, group }, key);
    if (group.entry.who !== undefined && baseOf(group.entry.type) === "person" && !this.#byWho.has(group.entry.who)) this.#byWho.set(group.entry.who, group);
  }
}
