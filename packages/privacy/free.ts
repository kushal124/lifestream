import { baseOf, placeholderSpans, runsOf, type Level, type Links, type Mark } from "@lifestreamprotocol/core";
import type { PassageMark } from "./detector.js";
import { mergeMarks, type Found } from "./merge.js";
import type { NameMatcher } from "./names.js";
import { passagesOf, type Passage } from "./passages.js";
import { ruleMarks, type Span } from "./rules.js";

export interface Free {
  length: number;
  source: string;
  known: readonly Mark[];
  lines?: true;
}

export interface Ways {
  names: NameMatcher;
  links: Links;
  always: readonly string[];
  never: readonly string[];
  seal?: { open(mark: Mark, text: string): boolean; sealed(mark: Mark, text: string): boolean };
}

export interface Detected {
  start: number;
  marks: readonly PassageMark[];
}

export function readPassages(free: Pick<Free, "length" | "source">): Passage[] {
  const passages = passagesOf(free.source);
  const touched = passages.filter((passage) => passage.start < free.length);
  const after = passages.find((passage) => passage.start >= free.length);
  const edge = touched.length > 0 && touched.every((passage) => passage.end <= free.length);
  return after !== undefined && edge ? [...touched, after] : touched;
}

export function marksOfFree(free: Free, ways: Ways, detected: readonly Detected[], level: Level, named: readonly Mark[] = ways.names.marks(free.source)): Mark[] {
  const { source } = free;
  const found: Found[] = free.known.filter((mark) => !businessOrBot(mark, ways.names)).map((mark) => ({ ...mark, way: 1 }));
  const none = free.known.filter((mark) => businessOrBot(mark, ways.names));
  for (const span of placeholderSpans(source)) found.push({ ...span, type: "word", way: 2 });
  for (const mark of named) found.push({ ...mark, way: 3 });
  const rules = ruleMarks(source, ways.links);
  for (const mark of free.lines === true ? [...rules.marks, ...acrossLines(source, ways.links)] : rules.marks) {
    const who = mark.type === "email" || mark.type === "phone" || mark.type === "account" ? ways.names.whoOf(source.slice(mark.start, mark.end).replaceAll("\n", " ")) : undefined;
    found.push({ ...mark, ...(who === undefined ? {} : { who }), way: 4 });
  }
  for (const passage of detected) {
    for (const mark of passage.marks) found.push({ start: passage.start + mark.start, end: passage.start + mark.end, type: mark.type, way: 5 });
  }
  if (ways.always.length > 0) {
    const always = new RegExp(`(?<![\\p{L}\\p{N}])(?:${ways.always.map(escaped).join("|")})(?![\\p{L}\\p{N}])`, "giu");
    for (const match of source.matchAll(always)) found.push({ start: match.index, end: match.index + match[0].length, type: "word", way: 6 });
  }
  const never = new Set(ways.never.map((word) => word.toLowerCase()));
  const plain = (mark: Mark) => {
    const text = source.slice(mark.start, mark.end);
    if (ways.seal === undefined) return never.has(text.toLowerCase());
    return !ways.seal.sealed(mark, text) && (never.has(text.toLowerCase()) || ways.seal.open(mark, text));
  };
  const kept = found.filter((mark) => !plain(mark) && none.every((stated) => standsInside(stated, mark, source)));
  kept.push(...softLinks(rules.soft, kept));
  return mergeMarks(kept, level).flatMap((mark) => (mark.start >= free.length ? [] : [{ ...mark, end: Math.min(mark.end, free.length) }]));
}

export function businessOrBot(mark: Mark, names: NameMatcher): boolean {
  if (baseOf(mark.type) !== "person" || mark.who === undefined) return false;
  const is = names.isOf(mark.who);
  return is === "business" || is === "bot";
}

export function standsInside(stated: { start: number; end: number }, mark: Found, source: string): boolean {
  if (mark.start < stated.start || stated.end < mark.end || baseOf(mark.type) !== "person") return true;
  if (mark.way !== 3) return false;
  const runs = runsOf(source.slice(stated.start, stated.end));
  return runs.length === 0 || mark.start !== stated.start + runs[0]! || mark.end !== stated.start + runs[runs.length - 1]!;
}

function acrossLines(source: string, links: Links): Mark[] {
  return ruleMarks(source.replaceAll("\n", " "), links).marks.filter((mark) => source.slice(mark.start, mark.end).includes("\n"));
}

function softLinks(soft: readonly Span[], found: readonly Found[]): Found[] {
  if (soft.length === 0) return [];
  const details = found.filter((mark) => mark.type !== "link").sort((left, right) => left.start - right.start);
  const reach: number[] = [];
  for (const mark of details) reach.push(Math.max(reach.at(-1) ?? 0, mark.end));
  return soft.filter((span) => {
    let low = 0;
    let high = details.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (details[middle]!.start < span.end) low = middle + 1;
      else high = middle;
    }
    return low > 0 && reach[low - 1]! > span.start;
  }).map((span) => ({ ...span, type: "link", way: 0 }));
}

function escaped(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
