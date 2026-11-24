import { readFileSync } from "node:fs";

const COMMON = 20;
const EVERYDAY = 40;

let sizes: ReadonlyMap<string, number> | undefined;
let given: ReadonlySet<string> | undefined;
let family: ReadonlySet<string> | undefined;
let places: ReadonlySet<string> | undefined;

function read(name: string, first: string, each: (word: string, section: string) => void): void {
  const text = readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
  let section = first;
  for (let at = 0; at < text.length;) {
    let end = text.indexOf("\n", at);
    if (end === -1) end = text.length;
    const code = text.charCodeAt(at);
    if (end > at && code !== 0x23) {
      if (code === 0x40) section = text.slice(at + 1, end);
      else each(text.slice(at, end), section);
    }
    at = end + 1;
  }
}

export function loadWords(): void {
  sizesOf();
  isGivenName("");
  isFamilyWord("");
  isPlaceName("");
}

function sizesOf(): ReadonlyMap<string, number> {
  if (sizes !== undefined) return sizes;
  const map = new Map<string, number>();
  let section = "";
  let size = 0;
  read("english-words.txt", "70", (word, each) => {
    if (each !== section) [section, size] = [each, Number(each)];
    map.set(word, size);
  });
  read("hinglish-words.txt", String(COMMON), (word) => {
    const size = isGivenName(word) ? EVERYDAY : COMMON;
    map.set(word, Math.min(map.get(word) ?? size, size));
  });
  return (sizes = map);
}

const key = (word: string) => (isAscii(word, 0, word.length) ? word.toLowerCase() : word.normalize("NFC").toLowerCase());

export function isAscii(text: string, start: number, end: number): boolean {
  for (let at = start; at < end; at += 1) if (text.charCodeAt(at) > 0x7f) return false;
  return true;
}

/** The first `units` UTF-16 code units of a text, one fewer where the cut would split a surrogate pair. */
export function textHead(text: string, units: number): string {
  if (text.length <= units) return text;
  if (units <= 0) return "";
  const last = text.charCodeAt(units - 1);
  const next = text.charCodeAt(units);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? units - 1 : units);
}

const OTHER_WORD_CHARACTER = /[\p{L}\p{M}\p{N}]/uy;

export function runsOf(text: string): Int32Array {
  const runs = new Int32Array(text.length + 1);
  let count = 0;
  let start = -1;
  for (let at = 0; at < text.length;) {
    const code = text.charCodeAt(at);
    let width = 1;
    let inRun: boolean;
    if (code < 0x80) inRun = (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
    else {
      if (code >= 0xd800 && code <= 0xdbff && at + 1 < text.length) {
        const low = text.charCodeAt(at + 1);
        if (low >= 0xdc00 && low <= 0xdfff) width = 2;
      }
      OTHER_WORD_CHARACTER.lastIndex = at;
      inRun = OTHER_WORD_CHARACTER.test(text);
    }
    if (inRun && start === -1) start = at;
    else if (!inRun && start !== -1) {
      runs[count++] = start;
      runs[count++] = at;
      start = -1;
    }
    at += width;
  }
  if (start !== -1) {
    runs[count++] = start;
    runs[count++] = text.length;
  }
  return runs.subarray(0, count);
}

export function lowerAligned(text: string): string | null {
  const lower = text.toLowerCase();
  return lower.length === text.length ? lower : null;
}

export interface Reading {
  readonly text: string;
  readonly runs: Int32Array;
  readonly lower: string | null;
}

export function readWords(text: string): Reading {
  return { text, runs: runsOf(text), lower: lowerAligned(text) };
}

export function readingOf(text: string, given?: Reading): Reading {
  return given !== undefined && given.text === text ? given : readWords(text);
}

export function isPlainWord(word: string): boolean {
  return sizesOf().has(key(word));
}

export function isCommonWord(word: string): boolean {
  return (sizesOf().get(key(word)) ?? Infinity) <= COMMON;
}

export function isEverydayWord(word: string): boolean {
  return (sizesOf().get(key(word)) ?? Infinity) <= EVERYDAY;
}

export function wordSize(word: string): number | undefined {
  return sizesOf().get(key(word));
}

export function isGivenName(word: string): boolean {
  if (given === undefined) {
    const set = new Set<string>();
    read("given-names.txt", "", (word) => set.add(word));
    given = set;
  }
  return given.has(key(word));
}

export function isFamilyWord(word: string): boolean {
  if (family === undefined) {
    const set = new Set<string>();
    read("family-names.txt", "", (name) => set.add(name));
    family = set;
  }
  return family.has(key(word));
}

export function isPlaceName(phrase: string): boolean {
  if (places === undefined) {
    const set = new Set<string>();
    read("place-names.txt", "", (place) => set.add(place));
    places = set;
  }
  return places.has(key(phrase));
}
