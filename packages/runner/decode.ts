import type { DetailType } from "@lifestreamprotocol/core";
import type { FindMark } from "@lifestreamprotocol/model";


export const DECODE = "3";

export const KINDS: Readonly<Record<string, DetailType | null>> = {
  private_person: "person",
  private_email: "email",
  private_phone: "phone",
  private_address: "address",
  private_url: "link",
  account_number: "number",
  secret: "secret",
  private_date: null,
};

export interface Token {
  readonly text: string;
  readonly added: boolean;
}

export class Unspelled extends Error {
  override name = "Unspelled";
}

const LABEL = /^(?:O|[BIES]-(.+))$/u;

export function readsLabels(labels: readonly string[]): boolean {
  return labels.every((label) => {
    const kind = LABEL.exec(label)?.[1];
    return label === "O" || (kind !== undefined && Object.hasOwn(KINDS, kind));
  });
}

const BYTE_OF: ReadonlyMap<string, number> = (() => {
  const printable = (byte: number): boolean => (byte >= 0x21 && byte <= 0x7e) || (byte >= 0xa1 && byte <= 0xac) || (byte >= 0xae && byte <= 0xff);
  const table = new Map<string, number>();
  let next = 0;
  for (let byte = 0; byte < 256; byte++) table.set(String.fromCodePoint(printable(byte) ? byte : 256 + next++), byte);
  return table;
})();

function bytesOf(token: Token): number {
  if (token.added) return Buffer.byteLength(token.text, "utf8");
  let count = 0;
  for (const character of token.text) {
    if (!BYTE_OF.has(character)) throw new Unspelled(`a token spells no byte: ${JSON.stringify(token.text)}`);
    count++;
  }
  return count;
}

function charOffsets(text: string): Int32Array {
  const at = new Int32Array(Buffer.byteLength(text, "utf8") + 1).fill(-1);
  let byte = 0;
  let unit = 0;
  for (const character of text) {
    at[byte] = unit;
    const point = character.codePointAt(0)!;
    byte += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    unit += character.length;
  }
  at[byte] = unit;
  return at;
}

export function marksOf(passage: string, tokens: readonly Token[], labels: readonly string[], scores: ArrayLike<number>): FindMark[] {
  if (scores.length !== tokens.length * labels.length) throw new Unspelled(`${scores.length} scores for ${tokens.length} tokens of ${labels.length} labels`);
  const at = charOffsets(passage);
  const starts = startsOf(tokens, at);
  const lattice = latticeOf(labels);
  const best = bestOf(scores, labels.length, tokens.length).map((label) => labels[label]!);
  const path = pathOf(scores, lattice, wholeOf(best));
  const digit = (span: Span): boolean => /\p{N}/u.test(passage.slice(span.start, span.end));
  const paths = spansOf(passage, at, starts, path);
  const held = paths.filter(digit);
  const spans = [
    ...spansOf(passage, at, starts, best).filter((span) => span.type !== "person" || digit(span) || held.some((each) => each.from <= span.from && span.to <= each.to)),
    ...paths.filter((span) => !digit(span)),
  ];
  return spans
    .sort((a, b) => a.start - b.start || a.end - b.end || a.from - b.from)
    .map(({ start, end, type }) => ({ start, end, type }));
}

function bestOf(scores: ArrayLike<number>, width: number, count: number): number[] {
  const best: number[] = [];
  for (let token = 0; token < count; token++) {
    const at = token * width;
    let top = 0;
    for (let label = 1; label < width; label++) if (scores[at + label]! > scores[at + top]!) top = label;
    best.push(top);
  }
  return best;
}

const STATES = ["O", "B-private_person", "I-private_person", "E-private_person", "S-private_person"] as const;
const [OUT, BEGIN, INSIDE, END, SINGLE] = [0, 1, 2, 3, 4];
const FOLLOWS: readonly (readonly number[])[] = [[OUT, END, SINGLE], [OUT, END, SINGLE], [BEGIN, INSIDE], [BEGIN, INSIDE], [OUT, END, SINGLE]];
const FIRST = [OUT, BEGIN, SINGLE];
const LAST = [OUT, END, SINGLE];

interface Lattice {
  readonly width: number;
  readonly person: readonly number[];
  readonly others: readonly number[];
}

const LATTICES = new WeakMap<readonly string[], Lattice>();

function latticeOf(labels: readonly string[]): Lattice {
  let made = LATTICES.get(labels);
  if (made === undefined) {
    const person = STATES.map((state, index) => (index === OUT ? -1 : labels.indexOf(state)));
    made = { width: labels.length, person, others: labels.flatMap((label, index) => (person.includes(index) ? [] : [index])) };
    LATTICES.set(labels, made);
  }
  return made;
}

function wholeOf(best: readonly string[]): Int8Array {
  const pinned = new Int8Array(best.length).fill(-1);
  for (let from = 0; from < best.length; from++) {
    if (best[from] === STATES[SINGLE]) pinned[from] = SINGLE;
    if (best[from] !== STATES[BEGIN]) continue;
    let to = from + 1;
    while (best[to] === STATES[INSIDE]) to++;
    if (best[to] !== STATES[END]) continue;
    pinned.fill(INSIDE, from + 1, to);
    pinned[from] = BEGIN;
    pinned[to] = END;
    from = to;
  }
  return pinned;
}

function pathOf(scores: ArrayLike<number>, lattice: Lattice, pinned: Int8Array): string[] {
  const { width } = lattice;
  const count = pinned.length;
  const of = (token: number, state: number): number => {
    if (pinned[token] !== -1 && pinned[token] !== state) return -Infinity;
    const row = token * width;
    if (state !== OUT) return lattice.person[state] === -1 ? -Infinity : scores[row + lattice.person[state]!]!;
    let most = -Infinity;
    for (const label of lattice.others) most = Math.max(most, scores[row + label]!);
    if (most === -Infinity) return most;
    let sum = 0;
    for (const label of lattice.others) sum += Math.exp(scores[row + label]! - most);
    return most + Math.log(sum);
  };
  if (count === 0) return [];
  let score = STATES.map((_, state) => (FIRST.includes(state) ? of(0, state) : -Infinity));
  const back = new Int8Array(count * STATES.length);
  for (let token = 1; token < count; token++) {
    score = STATES.map((_, state) => {
      let best = -Infinity;
      let from = FOLLOWS[state]![0]!;
      for (const before of FOLLOWS[state]!) {
        if (score[before]! > best) {
          best = score[before]!;
          from = before;
        }
      }
      back[token * STATES.length + state] = from;
      return best + of(token, state);
    });
  }
  let last = OUT;
  for (const state of LAST) if (score[state]! > score[last]!) last = state;
  const path = new Array<string>(count);
  for (let token = count - 1; token >= 0; token--) {
    path[token] = STATES[last]!;
    last = back[token * STATES.length + last]!;
  }
  return path;
}

function startsOf(tokens: readonly Token[], at: Int32Array): number[] {
  const starts: number[] = [];
  let byte = 0;
  for (const token of tokens) {
    starts.push(byte);
    byte += bytesOf(token);
  }
  if (byte !== at.length - 1) throw new Unspelled(`the tokens spell ${byte} bytes of a passage of ${at.length - 1}`);
  starts.push(byte);
  return starts;
}

interface Span extends FindMark {
  readonly from: number;
  readonly to: number;
}

function spansOf(passage: string, at: Int32Array, starts: readonly number[], labels: readonly string[]): Span[] {

  const spans: { kind: string; from: number; to: number }[] = [];
  let open: { kind: string; from: number; to: number } | null = null;
  const close = (): void => {
    if (open !== null) spans.push(open);
    open = null;
  };
  labels.forEach((label, index) => {
    if (label === "O") return close();
    const tag = label[0];
    const kind = label.slice(2);
    if (tag === "B" || tag === "S" || open === null || open.kind !== kind) {
      close();
      open = { kind, from: index, to: index };
    } else {
      open.to = index;
    }
    if (tag === "E" || tag === "S") close();
  });
  close();

  const marks: Span[] = [];
  for (const span of spans) {
    const type = KINDS[span.kind];
    if (type === undefined) throw new Unspelled(`a label of a kind this decoding does not read: ${span.kind}`);
    if (type === null) continue;
    let first = starts[span.from]!;
    while (at[first] === -1) first--;
    let last = starts[span.to + 1]!;
    while (at[last] === -1) last++;
    let start = at[first]!;
    let end = at[last]!;
    while (start < end && /\s/u.test(passage[start]!)) start++;
    while (end > start && /\s/u.test(passage[end - 1]!)) end--;
    if (end - start < 2) continue;
    while (start > 0 && inWord(passage[start - 1]) && inWord(passage[start])) start--;
    while (end < passage.length && inWord(passage[end]) && inWord(passage[end - 1])) end++;
    marks.push({ start, end, type, from: span.from, to: span.to });
  }
  return marks;
}

const WORD = /[\p{L}\p{M}\p{N}]/u;
const UNSPACED = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}\p{scx=Tibetan}]/u;
const inWord = (character: string | undefined): boolean => character !== undefined && WORD.test(character) && !UNSPACED.test(character);
