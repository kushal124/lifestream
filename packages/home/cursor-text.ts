import { createHash } from "node:crypto";
import { canonical, FormatError, type Json } from "@lifestreamprotocol/core";
import { refused } from "./refusal.js";
import { kindsParams } from "./kinds-contract.js";
import { ContractError, ROUTES, countHeld, type Shape } from "./search-contract.js";


export const GIVEN_MOST = 300;
export const NEXT_CHARS = 6_000;
export const ARGUMENTS_BYTES = 1_100;
export const LIMIT_BYTES = 12;

export class CursorError extends Error {}

export const SQLITE_LEAST = -(2n ** 63n);
export const SQLITE_MOST = 2n ** 63n - 1n;
export const VARINT_BYTES = 10;

export class CursorWriter {
  readonly #bytes: number[] = [];

  put(value: bigint | number): this {
    let left = BigInt(value);
    if (left < 0n) throw new RangeError("a cursor's plain number is at least 0");
    while (left >= 0x80n) {
      this.#bytes.push(Number(left & 0x7fn) | 0x80);
      left >>= 7n;
    }
    this.#bytes.push(Number(left));
    return this;
  }

  signed(value: bigint | number): this {
    const n = BigInt(value);
    return this.put(n < 0n ? -2n * n - 1n : 2n * n);
  }

  set(values: Iterable<bigint | number>): this {
    const sorted = [...new Set([...values].map((each) => BigInt(each)))].sort((one, other) => (one < other ? -1 : one > other ? 1 : 0));
    this.put(sorted.length);
    sorted.forEach((value, at) => (at === 0 ? this.signed(value) : this.put(value - sorted[at - 1]!)));
    return this;
  }

  bytes(value: Uint8Array): this {
    this.put(value.length);
    for (const byte of value) this.#bytes.push(byte);
    return this;
  }

  get written(): number[] {
    return [...this.#bytes];
  }

  text(): string {
    return Buffer.from(this.#bytes).toString("base64url");
  }
}

export class CursorReader {
  readonly #bytes: Buffer;
  #at = 0;

  constructor(text: string | Buffer, readonly what: string) {
    if (typeof text !== "string") {
      this.#bytes = text;
      return;
    }
    if (!/^[A-Za-z0-9_-]*$/u.test(text) || text === "") throw new CursorError(`is not ${what}`);
    if (text.length > NEXT_CHARS) throw new CursorError(`is longer than ${what}`);
    this.#bytes = Buffer.from(text, "base64url");
  }

  take(): bigint {
    let value = 0n;
    for (let shift = 0n; shift < 7n * BigInt(VARINT_BYTES); shift += 7n) {
      if (this.#at >= this.#bytes.length) break;
      const byte = this.#bytes[this.#at++]!;
      value |= BigInt(byte & 0x7f) << shift;
      if (byte < 0x80) return value;
    }
    throw this.broken();
  }

  small(most = Number.MAX_SAFE_INTEGER): number {
    const value = this.take();
    if (value > BigInt(most)) throw this.broken();
    return Number(value);
  }

  signed(): bigint {
    const value = this.take();
    return this.key((value & 1n) === 1n ? -(value + 1n) / 2n : value / 2n);
  }

  set(most: number): bigint[] {
    const count = this.small();
    if (count > most) throw new CursorError("holds more than a cursor gives");
    const out: bigint[] = [];
    for (let n = 0; n < count; n++) out.push(n === 0 ? this.signed() : this.key(out[n - 1]! + this.take()));
    return out;
  }

  bytes(most: number): Buffer {
    const count = this.small(most);
    if (this.#at + count > this.#bytes.length) throw this.broken();
    const out = this.#bytes.subarray(this.#at, this.#at + count);
    this.#at += count;
    return out;
  }

  rest(): Buffer {
    const out = this.#bytes.subarray(this.#at);
    this.#at = this.#bytes.length;
    return out;
  }

  key(value: bigint): bigint {
    if (value < SQLITE_LEAST || value > SQLITE_MOST) throw new CursorError("names a key no SQLite integer is");
    return value;
  }

  end(): void {
    if (this.#at !== this.#bytes.length) throw this.broken();
  }

  broken(): CursorError {
    return new CursorError(`is not ${this.what}`);
  }
}


export const ROUTE = { record: 1, screen: 2, count: 3, people: 4, read: 5, kinds: 6 } as const;
export type Route = keyof typeof ROUTE;
const ROUTE_NAMES = Object.keys(ROUTE) as Route[];

const SHAPES = {
  record: ROUTES["/v1/search"].params, screen: ROUTES["/v1/search"].params, count: countHeld,
  people: ROUTES["/v1/people/search"].params, read: ROUTES["/v1/read"].params, kinds: kindsParams,
} as const;
export type Params<R extends Route> = (typeof SHAPES)[R] extends Shape<infer T> ? Omit<T, "cursor"> : never;

export interface Bound {
  index?: string;
  facts?: string;
  screen?: string;
  epoch?: number | null;
  resolved?: string;
}
export type Member = keyof Bound;
const MEMBERS: readonly Member[] = ["index", "facts", "screen", "epoch", "resolved"];
export const BINDS: Readonly<Record<Route, readonly Member[]>> = {
  record: ["index", "epoch", "resolved"], screen: ["screen", "epoch"], count: ["index", "facts", "resolved"],
  people: ["index", "facts", "resolved"], read: ["index", "facts", "screen", "resolved"], kinds: ["index", "screen"],
};
export type Current = { [M in Member]?: () => Bound[M] };

const defined = (value: object): Json => JSON.parse(JSON.stringify(value)) as Json;

export const resolvedOf = (value: Json): string => createHash("sha256").update(canonical(defined(value as object))).digest("base64url").slice(0, 22);

export const EXPIRED = "what this page was read from changed since it was given (the index was built again, something was erased, or what the ask named changed): ask again";
const PAGING = new Set(["limit", "lists"]);

export const SEAL_BYTES = 12;
export const NEXT_BYTES = (NEXT_CHARS * 3) / 4;

const sealOf = (bound: Bound, mask: number, body: Uint8Array): Buffer => {
  const held = Object.fromEntries(MEMBERS.flatMap((member, at) => ((mask >> at) & 1) === 1 ? [[member, bound[member] ?? null]] : []));
  return createHash("sha256").update(canonical(held as Json)).update(body).digest().subarray(0, SEAL_BYTES);
};


export function argumentsWritten<R extends Route>(route: R, params: Params<R>): Buffer {
  const bytes = written(params);
  const { limit: _limit, ...args } = params as Record<string, unknown>;
  if (written(args).length > ARGUMENTS_BYTES) refused("BAD_PARAMETER", `the arguments together are over ${ARGUMENTS_BYTES.toLocaleString("en")} bytes as a cursor holds them: ask with fewer words or filters.`);
  return bytes;
}

function written(params: object): Buffer {
  const { cursor: _cursor, ...rest } = params as Record<string, unknown>;
  try {
    return Buffer.from(canonical(defined(rest)), "utf8");
  } catch (error) {
    if (error instanceof FormatError) return refused("BAD_PARAMETER", "the arguments hold a text with no canonical form (a lone surrogate).");
    throw error;
  }
}

export function aroundBytes(args: number): number {
  return 1 + 1 + 2 + new CursorWriter().put(args).written.length + args + SEAL_BYTES;
}

export const AROUND_CHARS = Math.ceil((aroundBytes(ARGUMENTS_BYTES + LIMIT_BYTES) * 4) / 3);

export function sealed<R extends Route>(route: R, place: readonly number[] | Uint8Array, params: Params<R>, bound: Bound): string {
  let mask = 0;
  for (const [at, member] of MEMBERS.entries()) {
    if (!(member in bound)) continue;
    if (!BINDS[route].includes(member)) throw new Error(`a ${route} cursor is bound to ${member}, which its route does not name`);
    mask |= 1 << at;
  }
  const out = new CursorWriter().put(ROUTE[route]).put(mask).bytes(Uint8Array.from(place)).bytes(written(params));
  const body = Buffer.from(out.written);
  const text = Buffer.concat([body, sealOf(bound, mask, body)]).toString("base64url");
  if (text.length > NEXT_CHARS) throw new Error(`a ${route} cursor is ${text.length} characters`);
  return text;
}

export interface Opened<R extends Route> {
  route: R;
  place: CursorReader;
  params: Params<R>;
  check(current: Current): void;
}

export function opened<R extends Route>(text: string, routes: readonly R[], given?: Readonly<Record<string, unknown>>): Opened<R> {
  const notOurs = (): never => refused("BAD_PARAMETER", "`cursor` is not a next this route gave.");
  if (!/^[A-Za-z0-9_-]+$/u.test(text) || text.length > NEXT_CHARS) return notOurs();
  const raw = Buffer.from(text, "base64url");
  if (raw.length <= SEAL_BYTES) return notOurs();
  const body = raw.subarray(0, raw.length - SEAL_BYTES);
  const seal = raw.subarray(raw.length - SEAL_BYTES);
  let route: R, mask: number, place: CursorReader, written: Buffer;
  try {
    const read = new CursorReader(body, "a next");
    const named = ROUTE_NAMES[read.small(ROUTE_NAMES.length) - 1];
    if (named === undefined) return notOurs();
    if (!(routes as readonly Route[]).includes(named)) return refused("BAD_PARAMETER", "`cursor` is the next of another route: give it to the route that gave it.");
    route = named as R;
    mask = read.small((1 << MEMBERS.length) - 1);
    if (MEMBERS.some((member, at) => ((mask >> at) & 1) === 1 && !BINDS[route].includes(member))) return notOurs();
    place = new CursorReader(Buffer.from(read.bytes(NEXT_BYTES)), "a next");
    written = Buffer.from(read.bytes(NEXT_BYTES));
    read.end();
  } catch (error) {
    if (error instanceof CursorError) return notOurs();
    throw error;
  }
  const params = paramsRead(route, written);
  if (params === undefined) return notOurs();
  let own: Params<R> = params;
  if (given !== undefined) {
    const asked = Object.entries(given).filter(([name, value]) => name !== "cursor" && value !== undefined);
    const of = (value: object) => canonical(defined(Object.fromEntries(Object.entries(value).filter(([name]) => !PAGING.has(name)))));
    const others = Object.fromEntries(asked);
    if (asked.some(([name]) => !PAGING.has(name)) && of(others) !== of(params)) {
      refused("BAD_PARAMETER", "`cursor` is given with arguments that are not its own: pass it alone, or with the arguments it was given for.");
    }
    own = { ...params, ...Object.fromEntries(asked.filter(([name]) => name === "limit")) } as NonNullable<Params<R>>;
  }
  return {
    route, place, params: own,
    check: (current) => {
      const now: Bound = {};
      for (const [at, member] of MEMBERS.entries()) {
        if (((mask >> at) & 1) === 0) continue;
        const read = current[member];
        if (read === undefined) throw new Error(`a ${route} cursor is bound to ${member}, which its route did not read`);
        (now as Record<Member, unknown>)[member] = read();
      }
      if (!sealOf(now, mask, body).equals(seal)) refused("CURSOR_EXPIRED", EXPIRED);
    },
  };
}

function paramsRead<R extends Route>(route: R, written: Buffer): Params<R> | undefined {
  const shape = SHAPES[route];
  try {
    const value: unknown = JSON.parse(written.toString("utf8"));
    if (typeof value !== "object" || value === null || Object.hasOwn(value, "cursor")) return undefined;
    return (shape as Shape<unknown>).parse(value) as Params<R>;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ContractError) return undefined;
    throw error;
  }
}
