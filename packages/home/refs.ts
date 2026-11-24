import { canonical, compareHandles, FormatError, type Json } from "@lifestreamprotocol/core";
import { handleOfId } from "@lifestreamprotocol/families";
import { refuse } from "./refusal.js";
import { collectionKey, ContractError, day, either, int, list, map, nullable, num, object, rowAsk, text, tuple, type RowAsk, type Shape } from "./search-contract.js";

export interface PlaceKept {
  level: string;
  id: string;
}

export type Held = string[] | string;

export interface Kept {
  persons?: Held[];
  chat?: string[];
  values?: Record<string, { in?: string[]; out: string[] }>;
  place?: { in?: PlaceKept[]; out: PlaceKept[] };
}

export type Cell = string | number | null | string[] | { v: string; h: string };

export type RowScope =
  | Record<string, never>
  | { t: string | null }
  | { g: Cell[]; p: string | null }
  | { u: [unit: string, p: string | null, fact: string | null] };

export interface RefParts {
  record: { source: string; kind: string; key: string };
  line: { day: string; same: string; m: number; unit: string; item: string | null };
  person: { handle: string };
  chat: { key: string };
  place: { id: string };
  picture: { image: string };
  window: { machine: string; day: string; app: string; site: string; name: string; at_ms: number | null };
  row: { ask: RowAsk; kept: Kept; scope: RowScope; n: number };
}
export type RefKind = keyof RefParts;
export type Ref = { [K in RefKind]: { kind: K; parts: RefParts[K] } }[RefKind];

const word = text(/^.+$/su, "a non-empty text");
const words = text();
const cell = nullable(either(words, num, list(word, 1), object({ v: word, h: text(/^[0-9a-f]{16}$/u, "a value's digest") })));
const rowScope: Shape<RowScope> = either(
  object({ g: list(cell, 1), p: nullable(word) }),
  object({ t: nullable(word) }),
  object({ u: tuple(word, nullable(word), nullable(word)) }),
  object({}),
) as Shape<RowScope>;
const placeKept: Shape<PlaceKept> = object({ level: word, id: word });
const kept: Shape<Kept> = object({}, {
  persons: list(either(word, list(word))),
  chat: list(words),
  values: map(object({ out: list(words) }, { in: list(words) }), collectionKey),
  place: object({ out: list(placeKept) }, { in: list(placeKept) }),
});
const image = text(/^sha256:[0-9a-f]{64}$/u, "a picture's file, sha256:<hex>");

const KINDS: { [K in RefKind]: { order: readonly (keyof RefParts[K])[]; parts: Shape<unknown[]> } } = {
  record: { order: ["source", "kind", "key"], parts: tuple(word, word, word) },
  line: { order: ["day", "same", "m", "unit", "item"], parts: tuple(day, text(/^[0-9a-f]{16}$/u, "an atom's same"), int(), word, nullable(word)) },
  person: { order: ["handle"], parts: tuple(word) },
  chat: { order: ["key"], parts: tuple(word) },
  place: { order: ["id"], parts: tuple(word) },
  picture: { order: ["image"], parts: tuple(image) },
  window: { order: ["machine", "day", "app", "site", "name", "at_ms"], parts: tuple(word, day, word, words, words, nullable(int())) },
  row: { order: ["ask", "kept", "scope", "n"], parts: tuple(rowAsk, kept, rowScope, int()) },
};

export const REF_KINDS = Object.keys(KINDS) as RefKind[];

const isKind = (name: string): name is RefKind => Object.hasOwn(KINDS, name);

export const REF_CHARS = 3_500;

export function personRef(person: { id: string; handles: readonly string[] }): string {
  return makeRef("person", { handle: lowestHandle(person.handles) ?? person.id });
}

export function lowestHandle(handles: readonly string[]): string | undefined {
  const held = handles.flatMap((id) => {
    const handle = handleOfId(id);
    return handle === null ? [] : [{ id, handle }];
  });
  return held.sort((left, right) => compareHandles(left.handle, right.handle) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))[0]?.id;
}

interface LineAtom {
  day: string;
  same: string;
  unit: string;
  item: string | null;
}

export function lineRef(atom: LineAtom, m: number): string {
  return makeRef("line", { day: atom.day, same: atom.same, m, unit: atom.unit, item: atom.item });
}

interface IndexRead {
  walk<T>(sql: string, params: readonly unknown[], limit: number): { rows: T[]; more: boolean };
  point<T>(sql: string, params: readonly unknown[]): T | undefined;
}

const SAME_AT_ONCE = 256;

export function ordinalOf(read: IndexRead, day: string, same: string, n: number): number {
  let m = 0;
  for (let after = -1; ;) {
    const page = read.walk<{ n: number }>("SELECT n FROM atoms WHERE day = ? AND same = ? AND n > ? AND n < ? ORDER BY n LIMIT ?", [day, same, after, n], SAME_AT_ONCE);
    m += page.rows.length;
    if (!page.more || page.rows.length === 0) return m;
    after = page.rows.at(-1)!.n;
  }
}

export function lineRefAt(read: IndexRead, day: string, n: number): string | null {
  const atom = read.walk<LineAtom>("SELECT day, same, unit, item FROM atoms WHERE day = ? AND n = ? LIMIT ?", [day, n], 1).rows[0];
  return atom === undefined ? null : lineRef(atom, ordinalOf(read, day, atom.same, n));
}

const written = (kind: RefKind, values: readonly unknown[]): string =>
  `${kind}.${Buffer.from(canonical([kind, ...values] as Json), "utf8").toString("base64url")}`;

export function makeRef<K extends RefKind>(kind: K, parts: RefParts[K]): string {
  const { order, parts: shape } = KINDS[kind];
  return written(kind, shape.parse(order.map((name) => (parts as Record<string, unknown>)[name as string] ?? null), `${kind} ref`));
}

export function readRef<K extends RefKind = RefKind>(given: string, member = "ref", kinds?: readonly K[]): Extract<Ref, { kind: K }> {
  const dot = given.indexOf(".");
  const kind = dot > 0 ? given.slice(0, dot) : "";
  const body = given.slice(dot + 1);
  const refused = (why: string): never =>
    refuse(422, "BAD_PARAMETER", `\`${member}\` is not ${kinds === undefined ? "a ref" : `a ref of ${kinds.join(" or ")}`} this home made (${why}).`);
  if (!isKind(kind)) return refused(dot > 0 ? `no ref is of kind ${JSON.stringify(kind.slice(0, 20))}` : "it names no kind");
  if (kinds !== undefined && !(kinds as readonly string[]).includes(kind)) return refused(`it is a ${kind}`);
  if (!/^[A-Za-z0-9_-]+$/u.test(body)) return refused("its parts are not the door's");
  let values: unknown[];
  try {
    const payload: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!Array.isArray(payload) || payload[0] !== kind) return refused(`its parts are not a ${kind}'s`);
    values = KINDS[kind].parts.parse(payload.slice(1), `${kind} ref`);
    if (written(kind, values) !== given) return refused("it is not written as the door writes it");
  } catch (error) {
    if (error instanceof ContractError || error instanceof SyntaxError || error instanceof FormatError) return refused("its parts are not the door's");
    throw error;
  }
  const parts: Record<string, unknown> = {};
  KINDS[kind].order.forEach((name, i) => {
    parts[name as string] = values[i];
  });
  return { kind, parts } as Extract<Ref, { kind: K }>;
}
