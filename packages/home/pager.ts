import { createHash } from "node:crypto";
import { EXPIRED } from "./cursor-text.js";
import { refused } from "./refusal.js";
import { either, int, leavesOf, list, object, text, type Leaves, type Of, type Shape } from "./search-contract.js";

export type Inside = (string | number)[];

export const cutShape = object({ at: list(either(text(/^.+$/su, "a member's name"), int()), 1, 16), h: text(/^[A-Za-z0-9_-]{12}$/u, "an item's digest") });
export type Cut = Of<typeof cutShape>;

export interface Admitted<T> {
  piece: T;
  to: Cut | null;
}

export interface Cutting {
  from?: Cut | undefined;
  keep?: readonly string[];
  need?: readonly string[];
  tuple?: boolean;
}

export class NoRoom extends Error {
  constructor() {
    super("no room left for this entry");
  }
}

export const sizeOf = (value: unknown): number => (value === undefined ? 0 : JSON.stringify(value).length);

export const digestOf = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("base64url").slice(0, 12);

export const HANDLE_CHARS = 8;

export type Measure = (value: unknown) => number;

export function byHandles(of: Shape<unknown>): Measure {
  const handled = new Set<string>();
  const walk = (leaves: Leaves): void => {
    for (const [name, inner] of Object.entries(leaves.members ?? {})) {
      const leaf = inner.leaf ?? inner.each?.leaf;
      if (leaf === "ref" || leaf === "cursor") handled.add(name);
      walk(inner);
    }
    if (leaves.each !== undefined) walk(leaves.each);
  };
  walk(leavesOf(of));
  const measured = (value: unknown, handle: boolean): number => {
    if (typeof value === "string") return handle ? Math.min(HANDLE_CHARS, sizeOf(value)) : sizeOf(value);
    if (Array.isArray(value)) return value.reduce<number>((sum, each, n) => sum + (n > 0 ? 1 : 0) + (each === undefined ? 4 : measured(each, handle)), 2);
    if (typeof value !== "object" || value === null) return sizeOf(value);
    return Object.entries(value).filter(([, member]) => member !== undefined)
      .reduce((sum, [name, member], n) => sum + (n > 0 ? 1 : 0) + sizeOf(name) + 1 + measured(member, handled.has(name)), 2);
  };
  return (value) => (value === undefined ? 0 : measured(value, false));
}

export class Room {
  #left: number;
  #since = 0;
  #cutFirst = true;

  constructor(readonly size: number, readonly measure: Measure = sizeOf) {
    this.#left = size - 2;
  }

  #memberOf(members: Record<string, unknown>): number {
    return Math.max(0, this.measure(members) - 1);
  }

  get left(): number {
    return this.#left;
  }

  begin(cutFirst: boolean): () => void {
    const before = { since: this.#since, cutFirst: this.#cutFirst };
    this.#since = 0;
    this.#cutFirst = cutFirst;
    return () => {
      this.#since = before.since;
      this.#cutFirst = before.cutFirst;
    };
  }

  mark(): number {
    return this.#left;
  }

  back(mark: number): void {
    this.#left = mark;
  }

  state(members: Record<string, unknown>): void {
    this.#spend(this.#memberOf(members));
  }

  hold(chars: number): number {
    this.#spend(chars);
    return chars;
  }

  settle(held: number, members: Record<string, unknown> | undefined): void {
    this.#left += held - (members === undefined ? 0 : this.#memberOf(members));
  }

  admit<T>(item: T, how: Cutting = {}): Admitted<T> | null {
    if (how.from !== undefined && how.from.h !== digestOf(item)) refused("CURSOR_EXPIRED", EXPIRED);
    if (how.from === undefined) {
      const size = this.measure(item) + 1;
      if (size <= this.#left) {
        this.#left -= size;
        this.#since++;
        return { piece: item, to: null };
      }
    }
    if (this.#since > 0) return null;
    if (!this.#cutFirst) throw new NoRoom();
    const done = { emitted: false };
    const sliced = slice(item, how.from?.at, this.#left - 1, { keep: new Set(how.keep ?? []), need: new Set(how.need ?? []), tuple: how.tuple === true }, done);
    if (sliced === null || (sliced.to !== null && !done.emitted)) throw new NoRoom();
    this.#left -= sliced.size + 1;
    this.#since++;
    return { piece: sliced.out as T, to: sliced.to === null ? null : { at: sliced.to, h: digestOf(item) } };
  }

  #spend(chars: number): void {
    if (chars > this.#left) throw new NoRoom();
    this.#left -= chars;
  }
}

interface How {
  keep: ReadonlySet<string>;
  need: ReadonlySet<string>;
  tuple: boolean;
}

interface Sliced {
  out: unknown;
  size: number;
  to: Inside | null;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const emptyOf = (value: unknown): unknown => (typeof value === "string" ? "" : Array.isArray(value) ? [] : value);

function fitText(words: string, room: number): number {
  let low = 0, high = words.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (sizeOf(words.slice(0, mid)) <= room) low = mid;
    else high = mid - 1;
  }
  if (low > 0 && low < words.length && /[\uD800-\uDBFF]/u.test(words[low - 1]!)) low--;
  return low;
}

function slice(value: unknown, from: Inside | undefined, room: number, how: How, done: { emitted: boolean }): Sliced | null {
  const at = from !== undefined && from.length > 0 ? from : undefined;
  if (typeof value === "string") {
    const start = at === undefined ? 0 : Number(at[0]);
    const rest = value.slice(start);
    if (sizeOf(rest) <= room) {
      if (rest.length > 0) done.emitted = true;
      return { out: rest, size: sizeOf(rest), to: null };
    }
    const n = fitText(rest, room);
    if (n === 0) return null;
    done.emitted = true;
    const piece = rest.slice(0, n);
    return { out: piece, size: sizeOf(piece), to: [start + n] };
  }
  if (Array.isArray(value)) {
    const start = at === undefined ? 0 : Number(at[0]);
    const inner = at?.slice(1);
    const out: unknown[] = how.tuple ? Array.from({ length: start }, () => null) : [];
    let size = sizeOf(out);
    if (size > room) return null;
    const below = { ...how, tuple: false };
    for (let k = start; k < value.length; k++) {
      const element = value[k];
      const sep = out.length > 0 ? 1 : 0;
      const within = k === start && inner !== undefined && inner.length > 0 ? inner : undefined;
      if (within === undefined) {
        const whole = sizeOf(element);
        if (size + sep + whole <= room) {
          out.push(element);
          size += sep + whole;
          done.emitted = true;
          continue;
        }
      }
      if (done.emitted) return { out, size, to: [k, ...(within ?? [])] };
      const cut = slice(element, within, room - size - sep, below, done);
      if (cut === null) return null;
      out.push(cut.out);
      size += sep + cut.size;
      if (cut.to !== null) return { out, size, to: [k, ...cut.to] };
    }
    return { out, size, to: null };
  }
  if (!isObject(value)) {
    if (at !== undefined || sizeOf(value) > room) return null;
    done.emitted = true;
    return { out: value, size: sizeOf(value), to: null };
  }
  const keys = Object.keys(value);
  const startAt = at === undefined ? 0 : keys.indexOf(String(at[0]));
  if (startAt < 0) refused("CURSOR_EXPIRED", EXPIRED);
  const inner = at?.slice(1);
  const mandatory = (k: number) => how.keep.has(keys[k]!) || (how.need.has(keys[k]!) && k < startAt);
  const member = (name: string, member: unknown) => sizeOf(name) + 1 + sizeOf(member);
  let owed = 0;
  for (let k = 0; k < keys.length; k++) if (mandatory(k)) owed += member(keys[k]!, how.keep.has(keys[k]!) ? value[keys[k]!] : emptyOf(value[keys[k]!])) + 1;
  const out: Record<string, unknown> = {};
  let size = 2;
  let count = 0;
  if (size + owed > room + 1) return null;
  const add = (name: string, member: unknown) => {
    size += (count > 0 ? 1 : 0) + sizeOf(name) + 1 + sizeOf(member);
    count++;
    out[name] = member;
  };
  let to: Inside | null = null;
  for (let k = 0; k < keys.length; k++) {
    const name = keys[k]!;
    const held = value[name];
    if (how.keep.has(name)) {
      owed -= member(name, held) + 1;
      add(name, held);
      continue;
    }
    if (k < startAt || to !== null) {
      if (how.need.has(name)) {
        if (k < startAt) owed -= member(name, emptyOf(held)) + 1;
        add(name, emptyOf(held));
      }
      continue;
    }
    const within = k === startAt && inner !== undefined && inner.length > 0 ? inner : undefined;
    const sep = count > 0 ? 1 : 0;
    const after = owed + keys.slice(k + 1).reduce((sum, rest) => sum + (how.need.has(rest) && !how.keep.has(rest) ? member(rest, emptyOf(value[rest])) + 1 : 0), 0);
    const avail = room - size - sep - sizeOf(name) - 1 - after;
    if (within === undefined && sizeOf(held) <= avail) {
      add(name, held);
      done.emitted = true;
      continue;
    }
    const cut = avail <= 0 ? null : slice(held, within, avail, how, done);
    if (cut === null) {
      if (!done.emitted) return null;
      to = [name, ...(within ?? [])];
      if (how.need.has(name)) add(name, emptyOf(held));
      continue;
    }
    add(name, cut.out);
    if (cut.to !== null) to = [name, ...cut.to];
  }
  return { out, size, to };
}
