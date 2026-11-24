import { textHead } from "@lifestreamprotocol/core";
import { text } from "./cell.js";
import type { MatchTerm } from "./counting.js";
import { VIDEO_SITES } from "./screen-keys.js";


const WORD = /[\p{L}\p{N}\p{Co}]+/gu;
const PREFIX_FROM = 3;
const FILLER_FROM = 3;
export const NEAR_MOST = 5;
export const NEAR_FROM = 4;
export const EDIT_FROM = 5;
const TWO_EDITS_FROM = 8;
export const SKELETON_FROM = 3;
const SPLIT_PART_FROM = 2;
export const VOCABULARY_MOST = 32;

export const FILLER: ReadonlySet<string> = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "at", "for", "with", "from", "by", "about", "into",
  "i", "me", "my", "we", "our", "you", "it", "its", "this", "that", "these", "those", "there",
  "is", "was", "were", "be", "been", "am", "are", "did", "do", "does", "had", "has", "have",
  "what", "which", "where", "when", "who", "how", "some", "something", "thing", "things",
  "saw", "seen", "see", "looked", "look", "read", "find", "show", "remember", "screen",
]);

export type AliasSide = "sites" | "products";

export const ALIASES: ReadonlyMap<string, { readonly [side in AliasSide]?: readonly string[] }> = new Map([
  ["tweet", { sites: ["x.com", "twitter.com"] }],
  ["tweets", { sites: ["x.com", "twitter.com"] }],
  ["video", { sites: [...VIDEO_SITES.keys()] }],
  ["videos", { sites: [...VIDEO_SITES.keys()] }],
]);

export interface SpellingRule {
  rare: number;
  skeleton: boolean;
  edits: boolean;
  distance: boolean;
  splits: boolean;
  counted: number;
}

export const RECORD_SPELLING: SpellingRule = { rare: 10, skeleton: true, edits: true, distance: false, splits: false, counted: 1_000 };
export const SCREEN_SPELLING: SpellingRule = { rare: 1, skeleton: false, edits: false, distance: true, splits: true, counted: Infinity };

export interface WordRule {
  filler: boolean;
  aliases?: AliasSide;
  spelling: SpellingRule;
}

export const RECORD_WORDS: WordRule = { filler: true, spelling: RECORD_SPELLING };
export const SCREEN_WORDS: WordRule = { filler: true, aliases: "sites", spelling: SCREEN_SPELLING };

export interface Term {
  text: string;
  quoted: boolean;
  negated: boolean;
  or: boolean;
  at: number;
  exact?: boolean;
  variant?: boolean;
}

export interface ReadTerm {
  index: number;
  words: string[];
  prefix: boolean;
}

export interface Span {
  start: number;
  end: number;
}

export interface Mark {
  word: string;
  prefix: boolean;
}

export interface Words {
  match: string;
  marks: Mark[];
  terms?: { required: ReadTerm[][]; excluded: ReadTerm[] };
}

export interface Read {
  terms: Term[];
  typing: boolean;
  without: string[];
  as: Record<string, readonly string[]>;
}

const ASCII = /^[\x00-\x7f]*$/;
const ASCII_WORD = /[A-Za-z0-9]+/g;
const ASCII_LETTERS = /^[a-z]+$/;

export function fold(word: string): string {
  return ASCII.test(word) ? word.toLowerCase() : word.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function wordsIn(text: string): (Span & { word: string })[] {
  return [...text.matchAll(WORD)].map((match) => ({ word: fold(match[0]), start: match.index, end: match.index + match[0].length }));
}

export function termsOf(typed: string): Term[] {
  const terms: Term[] = [];
  const pattern = /(-?)"([^"]*)"?|(\S+)/gu;
  let pendingOr = false;
  for (const match of typed.matchAll(pattern)) {
    if (match[3] === "OR") {
      pendingOr = terms.length > 0;
      continue;
    }
    const negated = match[1] === "-" || (match[3]?.startsWith("-") === true && match[3].length > 1);
    const text = match[2] ?? (negated ? match[3]!.slice(1) : match[3]!);
    if (!/[\p{L}\p{N}]/u.test(text)) {
      pendingOr = false;
      continue;
    }
    const quoted = match[2] !== undefined;
    terms.push({ text, quoted, negated, or: pendingOr && !negated, at: match.index + (negated ? 1 : 0) + (quoted ? 1 : 0) });
    pendingOr = false;
  }
  return terms;
}

export function typedOf(terms: readonly Term[]): string {
  return terms.map((term) => `${term.or ? "OR " : ""}${term.negated ? "-" : ""}${term.quoted ? `"${term.text}"` : term.text}`).join(" ");
}

export function readQuery(typed: string, rule: Pick<WordRule, "filler" | "aliases">, typing = false): Read {
  let terms = termsOf(typed);
  const plain = (term: Term) => !term.quoted && !term.negated;
  const grouped = (at: number) => terms[at]!.or || terms[at + 1]?.or === true;
  const wanted = (list: readonly Term[]) => list.some((term) => !term.negated);
  const without: string[] = [];
  if (rule.filler && terms.filter(plain).flatMap((term) => wordsIn(term.text)).length >= FILLER_FROM) {
    const last = terms.length - 1;
    const filler = terms.map((term, at) => {
      const words = wordsIn(term.text).map((each) => each.word);
      return plain(term) && !grouped(at) && !(typing && at === last) && words.length > 0 && words.every((word) => FILLER.has(word));
    });
    const kept = terms.filter((_, at) => !filler[at]);
    if (wanted(kept)) {
      terms.forEach((term, at) => {
        if (filler[at]) without.push(...wordsIn(term.text).map((each) => each.word));
      });
      terms = kept;
    }
  }
  const as: Record<string, readonly string[]> = {};
  const side = rule.aliases;
  if (side !== undefined) {
    const placeOf = (term: Term, at: number) => {
      const words = wordsIn(term.text);
      return plain(term) && !grouped(at) && words.length === 1 ? ALIASES.get(words[0]!.word)?.[side] : undefined;
    };
    const places = terms.map(placeOf);
    const kept = terms.filter((_, at) => places[at] === undefined);
    if (places.some((each) => each !== undefined) && wanted(kept)) {
      terms.forEach((term, at) => {
        if (places[at] !== undefined) as[wordsIn(term.text)[0]!.word] = places[at];
      });
      terms = kept;
    }
  }
  return { terms, typing, without, as };
}

export function phrase(text: string): string {
  return `"${text.replace(/"/gu, '""')}"`;
}

function marksOf(text: string, prefix: boolean): Mark[] {
  const words = wordsIn(text).map((each) => each.word);
  return words.map((word, at) => ({ word, prefix: prefix && at === words.length - 1 }));
}

export function prefixedOf(terms: readonly Term[], typing: boolean): Term | undefined {
  if (!typing) return undefined;
  const last = terms.filter((term) => !term.negated && term.variant !== true).at(-1);
  if (last === undefined) return undefined;
  const lastWord = wordsIn(last.text).at(-1)?.word ?? "";
  return !last.quoted && [...lastWord].length >= PREFIX_FROM ? last : undefined;
}

export function wordsOfTerms(terms: readonly Term[], typing = false): Words | null {
  const positives = terms.filter((term) => !term.negated);
  if (positives.length === 0) return null;
  const prefixed = prefixedOf(terms, typing);
  const groups: Term[][] = [];
  for (const term of positives) {
    if (term.or && groups.length > 0) groups.at(-1)!.push(term);
    else groups.push([term]);
  }
  const spelled = (term: Term) => (term === prefixed ? `${phrase(term.text)}*` : phrase(term.text));
  const positive = groups.map((group) => group.length === 1 ? spelled(group[0]!) : `(${group.map(spelled).join(" OR ")})`).join(" AND ");
  const negatives = terms.filter((term) => term.negated);
  const read = (term: Term): ReadTerm => ({ index: terms.indexOf(term), words: wordsIn(term.text).map((each) => each.word), prefix: term === prefixed });
  return {
    match: negatives.length === 0 ? positive : `(${positive}) NOT (${negatives.map((term) => phrase(term.text)).join(" OR ")})`,
    marks: positives.flatMap((term) => marksOf(term.text, term === prefixed)),
    terms: { required: groups.map((group) => group.map(read)), excluded: negatives.map(read) },
  };
}

export function spansOf(text: string, term: Pick<ReadTerm, "words" | "prefix">): Span[] {
  const tokens = wordsIn(text);
  const n = term.words.length;
  const found: Span[] = [];
  if (n === 0) return found;
  for (let i = 0; i + n <= tokens.length; i++) {
    const matches = term.words.every((word, k) => (term.prefix && k === n - 1 ? tokens[i + k]!.word.startsWith(word) : tokens[i + k]!.word === word));
    if (matches) found.push({ start: tokens[i]!.start, end: tokens[i + n - 1]!.end });
  }
  return found;
}

export function markedIn(text: string, marks: readonly Mark[]): Span[] {
  return wordsIn(text)
    .filter(({ word }) => marks.some((mark) => (mark.prefix ? word.startsWith(mark.word) : word === mark.word)))
    .map(({ start, end }) => ({ start, end }));
}

export function says(line: string, text: string): boolean {
  const words = (said: string) => ` ${wordsIn(said).map((each) => each.word).join(" ")} `;
  return words(line).includes(words(text));
}

const REACH = 70;
const PLAIN_SNIPPET = 120;
const CUT_BEFORE = 24;
const CUT = 140;
const TAG = /<\/?[A-Za-z][\w.:-]*((?:\s+[\w.:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\}|[^\s"'>/{}]+))?)*)\s*\/?>/gu;
const VALUE = /=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}|([^\s"'>/{}]+))/gu;

export function plainOf(text: string): string {
  return text
    .replace(TAG, (_tag, attributes: string) => ` ${[...attributes.matchAll(VALUE)].map((value) => value[1] ?? value[2] ?? value[3] ?? value[4] ?? "").join(" ")} `)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+)/gmu, "")
    .replace(/[*`~]+|(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function cutAt(text: string, marked: readonly Span[]): string {
  const first = marked[0];
  const from = first === undefined ? 0 : Math.min(first.start - CUT_BEFORE, text.length - CUT);
  const start = from <= 0 ? 0 : wordsIn(text).find((word) => word.start >= from)!.start;
  let end = Math.min(text.length, start + CUT);
  if (first !== undefined && end < first.end) end = first.end;
  if (end < text.length) end = Math.max(first?.end ?? 0, text.lastIndexOf(" ", end));
  if (end <= start) end = Math.min(text.length, start + CUT);
  let cut = "";
  let at = start;
  for (const span of marked) {
    if (span.start < at || span.end > end) continue;
    cut += `${text.slice(at, span.start)}«${text.slice(span.start, span.end)}»`;
    at = span.end;
  }
  cut += text.slice(at, end);
  return `${start > 0 ? "…" : ""}${cut.trim()}${end < text.length ? "…" : ""}`;
}

export function snippetAt(text: string, marked: readonly Span[], whole: readonly Span[] = []): string {
  const first = marked[0]!;
  let start = Math.max(0, first.start - REACH);
  let end = Math.min(text.length, first.end + REACH);
  if (start > 0) start = Math.min(first.start, text.indexOf(" ", start) + 1 || first.start);
  if (end < text.length) end = Math.max(first.end, text.lastIndexOf(" ", end));
  for (const span of whole) {
    if (span.start < start && start < span.end) start = span.start;
    if (span.start < end && end < span.end) end = span.end;
  }
  let cut = "";
  let at = start;
  for (const span of marked) {
    if (span.start < at || span.end > end) continue;
    cut += `${text.slice(at, span.start)}«${text.slice(span.start, span.end)}»`;
    at = span.end;
  }
  cut += text.slice(at, end);
  return `${start > 0 ? "…" : ""}${cut.trim()}${end < text.length ? "…" : ""}`;
}

export function plainSnippet(text: string, whole: readonly Span[] = []): string {
  if (text.length <= PLAIN_SNIPPET) return text;
  let end = textHead(text, PLAIN_SNIPPET).length;
  for (const span of whole) if (span.start < end && end < span.end) end = span.end;
  return end >= text.length ? text : `${text.slice(0, end)}…`;
}

export function widenable(term: Term): string | undefined {
  if (term.quoted || term.negated || term.exact === true || term.variant === true) return undefined;
  const words = wordsIn(term.text);
  return words.length === 1 && /^\p{L}+$/u.test(words[0]!.word) ? words[0]!.word : undefined;
}

export function widen(terms: readonly Term[], variants: Readonly<Record<string, readonly string[]>>): { terms: Term[]; of: number[] } {
  const out: Term[] = [];
  const of: number[] = [];
  terms.forEach((term, at) => {
    out.push(term);
    of.push(at);
    const word = widenable(term);
    if (word === undefined || !Object.hasOwn(variants, word)) return;
    for (const variant of variants[word]!) {
      out.push({ text: variant, quoted: true, negated: false, or: true, at: term.at, variant: true });
      of.push(at);
    }
  });
  return { terms: out, of };
}

export function skeletonOf(word: string): string {
  return [...fold(word).replace(/[aeiou]/gu, "")].filter((letter, at, all) => at === 0 || all[at - 1] !== letter).join("");
}

export function forEachVocabularyWord(text: string, visit: (word: string) => void): void {
  if (text === "") return;
  if (ASCII.test(text)) {
    ASCII_WORD.lastIndex = 0;
    for (let match = ASCII_WORD.exec(text); match !== null; match = ASCII_WORD.exec(text)) {
      const raw = match[0];
      if (raw.length < NEAR_FROM || raw.length > VOCABULARY_MOST) continue;
      const word = raw.toLowerCase();
      if (ASCII_LETTERS.test(word)) visit(word);
    }
    return;
  }
  for (const { word } of wordsIn(text)) {
    const length = [...word].length;
    if (length >= NEAR_FROM && length <= VOCABULARY_MOST && /^\p{L}+$/u.test(word)) visit(word);
  }
}

export function vocabularyOf(texts: readonly string[]): Set<string> {
  const words = new Set<string>();
  for (const text of texts) forEachVocabularyWord(text, (word) => words.add(word));
  return words;
}

export function editsOf(word: string): Set<string> {
  const letters = [...word];
  const alphabet = [...new Set([..."abcdefghijklmnopqrstuvwxyz", ...letters])];
  const edits = new Set<string>();
  for (let at = 0; at <= letters.length; at++) {
    const before = letters.slice(0, at).join(""), after = letters.slice(at).join("");
    if (at < letters.length) edits.add(before + letters.slice(at + 1).join(""));
    if (at + 1 < letters.length) edits.add(before + letters[at + 1] + letters[at] + letters.slice(at + 2).join(""));
    for (const letter of alphabet) {
      if (at < letters.length) edits.add(before + letter + letters.slice(at + 1).join(""));
      edits.add(before + letter + after);
    }
  }
  edits.delete(word);
  return edits;
}

export function editDistance(left: string, right: string, most: number): number {
  const a = [...left], b = [...right];
  const rows: number[][] = [Array.from({ length: b.length + 1 }, (_, j) => j)];
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let least = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(rows[i - 1]![j]! + 1, row[j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, rows[i - 2]![j - 2]! + 1);
      row.push(value);
      least = Math.min(least, value);
    }
    if (least > most) return most + 1;
    rows.push(row);
  }
  return rows[a.length]![b.length]!;
}

export interface Vocabulary {
  held(form: string, most: number, prefix?: boolean): number;
  has(word: string): boolean;
  ofSkeleton(skeleton: string, most: number): Iterable<string>;
  starting(first: string, most: number): Iterable<string>;
  left(): number;
}

export function spellingsOf(word: string, vocabulary: Vocabulary, rule: SpellingRule, how: { prefix?: boolean } = {}): string[] {
  const letters = [...word];
  if (letters.length < NEAR_FROM) return [];
  const left = () => vocabulary.left();
  if (left() < rule.rare + 1 || vocabulary.held(word, rule.rare, how.prefix === true) >= rule.rare) return [];
  const found = new Set<string>();
  const skeleton = skeletonOf(word);
  if (rule.skeleton && [...skeleton].length >= SKELETON_FROM && left() >= 2) {
    for (const each of vocabulary.ofSkeleton(skeleton, Math.min(rule.counted, left() - 1))) found.add(each);
  }
  if (rule.edits && letters.length >= EDIT_FROM) {
    const edits = editsOf(word);
    if (left() >= edits.size) for (const edit of edits) if (vocabulary.has(edit)) found.add(edit);
  }
  if (rule.distance && left() >= 2) {
    const most = letters.length >= TWO_EDITS_FROM ? 2 : 1;
    for (const each of vocabulary.starting(letters[0]!, Math.floor(left() / 2))) {
      if (Math.abs([...each].length - letters.length) <= most && editDistance(word, each, most) <= most) found.add(each);
    }
  }
  if (rule.splits) {
    for (let at = SPLIT_PART_FROM; at <= letters.length - SPLIT_PART_FROM && left() >= 2; at++) {
      const before = letters.slice(0, at).join(""), after = letters.slice(at).join("");
      if (vocabulary.held(before, 1) === 0) continue;
      if (left() < 2) break;
      if (vocabulary.held(after, 1) > 0) found.add(`${before} ${after}`);
    }
  }
  const near = [...found].filter((each) => each !== word && !(how.prefix === true && each.startsWith(word)));
  const most = near.length === 0 ? 0 : Math.min(rule.counted, Math.floor(left() / near.length) - 1);
  if (most < 1) return [];
  return near.map((each) => ({ each, n: vocabulary.held(each, most) }))
    .filter(({ n }) => n > 0)
    .sort((one, other) => other.n - one.n || (one.each < other.each ? -1 : one.each > other.each ? 1 : 0))
    .map(({ each }) => each);
}

export const STRUCTURE_KEYS: ReadonlySet<string> = new Set([
  "direction", "outcome", "service", "currency", "channel", "searchable", "sure",
  "day", "week", "month", "year", "weekday",
  "city", "region", "country",
]);

export function matchTermsOf(written: string, masked = written): MatchTerm[] {
  const whole = /^\s*=\s*/u.exec(masked);
  if (whole !== null) {
    const start = whole[0].length, end = masked.trimEnd().length;
    const words = written.slice(start, end);
    return matchFold(words) === "" ? [] : [{ text: words, start, end, folds: [matchFold(words)], negated: false, said: text(written.trim()), whole: true }];
  }
  const terms: MatchTerm[] = [];
  const push = (start: number, end: number, negated: boolean) => {
    const words = written.slice(start, end);
    if (matchFold(words) !== "") terms.push({ text: words, start, end, folds: [matchFold(words)], negated, said: text(words) });
  };
  let run: { start: number; end: number } | undefined;
  const close = () => {
    if (run !== undefined) push(run.start, run.end, false);
    run = undefined;
  };
  for (const token of masked.matchAll(/\S+/gu)) {
    const start = token.index, end = start + token[0].length;
    if (token[0] === "OR") {
      close();
      continue;
    }
    if (token[0].startsWith("-") && token[0].length > 1) {
      push(start + 1, end, true);
      continue;
    }
    run = run === undefined ? { start, end } : { start: run.start, end };
  }
  close();
  return terms;
}

export function matchFold(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export function matchesRaw(value: string, term: Pick<MatchTerm, "folds" | "whole">): boolean {
  const folded = matchFold(value);
  return term.folds.some((each) => (term.whole === true ? folded === each : folded.includes(each)));
}

export function placeFold(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function placeIn(name: string, fold: string): boolean {
  return ` ${name} `.includes(` ${fold} `);
}

export function tokens(text: string): string[] {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().match(/[\p{L}\p{N}\p{Co}]+/gu) ?? [];
}
