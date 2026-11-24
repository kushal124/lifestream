import { addDays, civilDay, dayBounds, type DaySettings } from "@lifestreamprotocol/core";
import { digitsOf, type Collection, type Measure } from "@lifestreamprotocol/families";
import type { Cell } from "./cell.js";
import { refused, Refusal } from "./refusal.js";
import { readTime } from "./home-clock.js";
import type { Fresh, HeldDays, PendingDay } from "./index-file.js";
import { factAccounts } from "./index-layers.js";
import { utcDate, type SearchAnswer, type SearchGate } from "./record-search.js";
import { comboKeys, reaches, WORDS_ROWS, type FactsRead, type Metered, type RecordRead, type Slack, type WalkEnd, type WalkRange } from "./search-index.js";
import type { RowAsk } from "./search-contract.js";
import type { Term } from "./search-words.js";
import { timeKeyOf, unitDays } from "./search-scan.js";
import { areasAt, placeDaysOf, presenceIn, runsOver, type PlaceAt, type Presence, type PresenceAreaRow, type PresenceSource, type RunRow } from "./presence.js";
import type { Work } from "./work.js";




export type CountOp = "count" | "sum" | "avg" | "min" | "max" | "first" | "last";

export const TIME_KEYS = ["day", "week", "month", "year", "weekday"] as const;

export const PLACE_KEYS = new Set(["place", "city", "region", "country"]);

export interface CountAsk {
  of: string;
  measure?: string;
  op: CountOp;
  by: string[];
  from?: string;
  to?: string;
  person: string[];
  match: Record<string, string>;
  chat?: string;
  words?: string;
  typing?: true;
  place?: string;
  order?: "value" | "time";
  at_least?: string;
  at_most?: string;
  limit: number;
  cursor?: string;
  asked?: RowAsk;
}

export interface ResolveOptions {
  passages?: boolean;
}

export interface Phrases {
  phrases: string[];
  negated: boolean;
}

export interface MatchTerm {
  text: string;
  start: number;
  end: number;
  folds: string[];
  negated: boolean;
  said: Cell;
  whole?: true;
}

export function needsPresence(ask: CountAsk, collections: ReadonlyMap<string, Collection>): boolean {
  if (ask.of === "") return false;
  const keys = collections.get(ask.of)?.keys ?? [];
  return ask.place !== undefined || ask.by.some((key) => key === "run" || key === "hour" || joinedPlace(key, ask.of, keys));
}

export function joinedPlace(key: string, of: string, keys: readonly string[]): boolean {
  return (PLACE_KEYS.has(key) || (key === "sure" && of === "days")) && !keys.includes(key);
}

export interface PeopleMap {
  version: string;
  idOf(id: string): string | undefined;
  person(id: string): { name: string; handles: readonly string[] } | undefined;
  find(name: string): string[];
}

export interface ShownPerson {
  name: string;
  handles: readonly string[];
  involved: boolean | undefined;
}

export interface PeopleShown {
  shown(id: string): ShownPerson | undefined;
  named(asked: string): string | undefined;
  found(name: string): string[];
}

export function wholePeople(people: PeopleMap): PeopleShown {
  return {
    shown: (id) => {
      const person = people.person(id);
      return person === undefined ? undefined : { name: person.name, handles: person.handles, involved: true };
    },
    named: (asked) => people.idOf(asked),
    found: (name) => people.find(name),
  };
}

export interface CountContext {
  collections: ReadonlyMap<string, Collection>;
  settings: DaySettings;
  now_ms: number;
  people: () => PeopleMap | undefined;
  presence?: PresenceSource;
  chat?: (asked: string) => string;
  families?: readonly string[];
  familiesOf?: (of: string) => readonly string[];
  sources?: (family: string) => readonly { id: string; product: string; read_through_ms: number | null }[];
  fresh?: (seq: number, held: HeldDays) => Fresh | undefined;
  budget?: { fetch?: number; words?: number };
  gate?: SearchGate;
  outside?: () => boolean;
  shown?: PeopleShown;
}

export function bad(message: string): never {
  return refused("BAD_PARAMETER", message);
}

export function peopleOrRefuse(context: CountContext): PeopleMap {
  return context.people() ?? refused("INDEX_BUILDING", "your people are being prepared", { building: ["people"] });
}

export function presenceOrRefuse(read: FactsRead, context: CountContext): Presence {
  return presenceIn(read, context.presence) ?? refused("INDEX_BUILDING", "where you were is being prepared", { building: ["places"] });
}

export interface ResolvedPerson {
  said: Cell;
  id: string;
  name: string;
  handles: readonly string[];
  bare: boolean;
}

export interface Kept {
  handles?: readonly string[];
  persons: ResolvedPerson[];
  values: Record<string, { in?: readonly string[]; out: readonly string[] }>;
  chat?: readonly string[];
  took: Record<string, { said: Cell; values: readonly string[] }[]>;
  place?: { in?: readonly PlaceAt[]; out: readonly PlaceAt[]; took: { said: Cell; values: { said: Cell; at: PlaceAt }[] }[] };
  words?: readonly Term[];
}

export interface WordsAdmitted {
  in?: readonly string[];
  out: readonly string[];
  end: WalkEnd;
  slots?: Readonly<Record<string, readonly number[]>>;
  slack?: Slack;
}

export interface Admission {
  kept: Kept;
  words?: WordsAdmitted;
}

export interface Admitted {
  kept: Kept;
  values: Record<string, { in?: readonly number[]; out: readonly number[] }>;
  chat?: readonly number[];
  took: Record<string, { said: Cell; names: number[] }[]>;
  place?: { in?: readonly number[]; out: readonly number[]; took: { said: Cell; values: { said: Cell; ids: number[] }[] }[] };
  words?: WordsAdmitted;
}

const VALUE_NAMED = "SELECT id FROM names WHERE role = 'value' AND name = ?";

function admittedIn(read: FactsRead, context: CountContext, admission: Admission, by?: Work): Admitted {
  const { kept } = admission;
  const texts = new Set([...Object.values(kept.values).flatMap(({ in: kept, out }) => [...kept ?? [], ...out]), ...kept.chat ?? []]);
  const work = by ?? read.work.beside(texts.size + 1);
  const ids = new Map<string, number>();
  for (const text of texts) {
    const id = read.point<{ id: number }>(VALUE_NAMED, [text], work)?.id;
    if (id !== undefined) ids.set(text, id);
  }
  const named = (values: readonly string[]) => values.flatMap((value) => (ids.has(value) ? [ids.get(value)!] : []));
  const values: Admitted["values"] = {};
  for (const [key, { in: taken, out }] of Object.entries(kept.values)) values[key] = { ...(taken === undefined ? {} : { in: named(taken) }), out: named(out) };
  const took: Admitted["took"] = {};
  for (const [key, terms] of Object.entries(kept.took)) took[key] = terms.map(({ said, values: each }) => ({ said, names: named(each) }));
  let place: Admitted["place"];
  if (kept.place !== undefined) {
    const { areas } = presenceOrRefuse(read, context);
    const bound = (at: readonly PlaceAt[]) => [...new Set(at.flatMap((each) => areasAt(areas, each)))];
    place = {
      ...(kept.place.in === undefined ? {} : { in: bound(kept.place.in) }), out: bound(kept.place.out),
      took: kept.place.took.map(({ said, values: each }) => ({ said, values: each.map((value) => ({ said: value.said, ids: areasAt(areas, value.at) })) })),
    };
  }
  return {
    kept, values, took, ...(kept.chat === undefined ? {} : { chat: named(kept.chat) }), ...(place === undefined ? {} : { place }),
    ...(admission.words === undefined ? {} : { words: admission.words }),
  };
}

export interface CountAnswer {
  asked: Cell;
  matched: { from?: string; to?: string; values: Record<string, { said: Cell; values: { value: Cell; n: number }[] }[]>; person: { said: Cell; is: Cell }[] };
  abroad?: Record<string, Cell>[];
  days_there?: Cell;
  population: Record<string, Cell | Record<string, number> | Record<string, Cell>[]>;
  held?: Cell;
  heldDays?: { first: string; last: string } | null;
  there?: { zone: string; first: string; last: string };
  covers?: Cell[];
  counted?: Cell;
  also?: Cell[];
  readings?: Cell[];
  as_of?: string;
  pending?: PendingDay[];
  pending_more?: number;
  total: { partition?: Cell; cells: Record<string, Cell | Record<string, Cell>[]> }[];
  whole?: Cell;
  partitionKey?: string;
  columns: string[];
  rows: Cell[][];
  next: Cell | null;
  place?: CountPlace;
  places?: CountPlace[];
  catalog?: Record<string, CatalogEntry>;
  families?: Record<string, FamilyEntry>;
  outside?: true;
}

export interface FamilyEntry {
  products: Cell[];
  first?: Cell;
  read_through?: Cell;
}

export interface CatalogEntry {
  about?: Cell;
  keys: Cell[];
  measures: Record<string, Record<string, Cell | Cell[]>>;
  held: Cell;
  days: { first: string; last: string } | null;
  stated?: Record<string, { first: string; last: string; n: number } | null>;
}


export function minorBound(written: string, digits: number, toward: "ceil" | "floor"): number {
  const [, sign, whole, fraction = ""] = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(written.trim()) ?? bad(`${written} is not a number`);
  const negative = sign === "-";
  let magnitude = BigInt(`${whole}${fraction.slice(0, digits).padEnd(digits, "0")}`);
  if (/[1-9]/u.test(fraction.slice(digits)) && (toward === "ceil") !== negative) magnitude += 1n;
  return Number(negative ? -magnitude : magnitude) + 0;
}

export function heldDigits(currency: string): number {
  const digits = digitsOf(currency);
  if (digits === undefined) throw new Error(`${currency}: the index holds no amount of it`);
  return digits;
}


export type Raw = string | number | null;

export interface Group {
  keys: Raw[];
  partition: string | null;
  n: number;
  valued: number;
  value: number | null;
  t: Raw;
}

export interface Named {
  unit: string;
  p: string | null;
  fact: string | null;
  t: Raw;
  day: string;
  v: number | null;
}

export interface Extremum {
  value: number | null;
  tied: number;
  named: Named[];
}

export type Extreme = "min" | "max" | "first" | "last";

export interface HeldHandles {
  handles: readonly string[];
}

export type Scope = { g: (Raw | HeldHandles)[]; p: string | null } | { t: { p: string | null } } | { u: [string, string | null, string | null] };

const isHeld = (value: Raw | HeldHandles | undefined): value is HeldHandles => typeof value === "object" && value !== null;
const HELD = "\u0000held";

export interface Runs {
  rows: ReadonlyMap<string, RunRow>;
  of: ReadonlyMap<string, readonly string[]>;
}

export type CountPlace = { after: Item } | { o: number; h: string };

export interface Item {
  unit: string;
  p: string | null;
  fact: string | null;
  t: Raw;
  d: string;
  v: number | null;
}

export interface Population {
  measure?: Measure;
  partitionKey?: string;
  runs?: Runs;
  calendar?: { from: string; to: string };
  groupsOf(set: readonly string[]): Group[];
  extremesOf(set: readonly string[], kind: Extreme, take: number): Map<string, Extremum>;
  overlapOf(set: readonly string[]): number;
  matchedOf(key: string, names: readonly number[]): { name: number; value: string; n: number }[];
  inPlace(ids: readonly number[]): number;
  coversOf(): { source: string; last: string }[];
  edges(): Edges;
  items(after: Item | undefined, limit: number): Item[];
  unvalued(): { p: string | null; unit: string }[];
  bounded(bounded: boolean): { n: number; valued: number };
  wordless(): number;
}

export const groupKey = (keys: readonly Raw[], partition: string | null) => JSON.stringify([...keys, partition]);

export const DAY_MS = 86_400_000;

export interface Range {
  fromDay?: string;
  toDay: string;
  from_ms?: number;
  to_ms: number;
}

export function firstDay(read: FactsRead): string | undefined {
  return read.walk<{ day: string }>("SELECT day FROM days WHERE day >= ? ORDER BY day LIMIT ?", [""], 1, read.work.beside(2)).rows[0]?.day;
}

function order(left: Raw, right: Raw): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  if (typeof left !== typeof right) return typeof left === "number" ? -1 : 1;
  return left < right ? -1 : 1;
}


export interface Fact {
  fid: number;
  id: string;
  of: string;
  combo: number;
  crew: number;
  day: string;
  time_ms: number;
  start_ms: number;
  end_ms: number;
  date_only: number;
  source: string;
  record?: string | null;
  accounts?: string | null;
}

interface TallyCell {
  day: string;
  combo: number;
  crew: number;
  source: string;
  n: number;
  t: number | null;
  u: number | null;
  accounts?: string;
  start_min?: number;
  start_max?: number;
}

export interface Total {
  combo: number;
  crew: number;
  n: number;
  first: string;
  last: string;
}

type StatedTotal = Total & { accounts?: string };

export type Side = "newest" | "oldest";

export class Stopped extends Error {
  constructor(readonly side: Side, readonly at: { ms: number } | { day: string } | undefined, readonly words?: Exclude<WalkEnd, { whole: true }>) {
    super("a count's read stopped at its budget");
  }
}

export const FETCH_ROWS = 100_000;
const PROOF_SHARE = 20;
export const HELD_ROWS = 1_000;
const STEP = 256;

export function ceilingOf(budget: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, budget + Math.max(STEP, Math.ceil(budget / PROOF_SHARE)));
}


const FACT = "fid, id, of, combo, crew, day, time_ms, start_ms, end_ms, date_only, source";
const FACTS = {
  of: {
    newest: `SELECT ${FACT} FROM fact INDEXED BY fact_of WHERE of = ? AND time_ms >= ? AND time_ms <= ? ORDER BY time_ms DESC LIMIT ?`,
    oldest: `SELECT ${FACT} FROM fact INDEXED BY fact_of WHERE of = ? AND time_ms >= ? AND time_ms <= ? ORDER BY time_ms ASC LIMIT ?`,
  },
  combo: {
    newest: `SELECT ${FACT} FROM fact INDEXED BY fact_combo WHERE combo = ? AND time_ms >= ? AND time_ms <= ? ORDER BY time_ms DESC LIMIT ?`,
    oldest: `SELECT ${FACT} FROM fact INDEXED BY fact_combo WHERE combo = ? AND time_ms >= ? AND time_ms <= ? ORDER BY time_ms ASC LIMIT ?`,
  },
  crew: {
    newest: `SELECT ${FACT} FROM fact INDEXED BY fact_crew WHERE crew = ? AND of = ? AND time_ms >= ? AND time_ms <= ? ORDER BY time_ms DESC LIMIT ?`,
    oldest: `SELECT ${FACT} FROM fact INDEXED BY fact_crew WHERE crew = ? AND of = ? AND time_ms >= ? AND time_ms <= ? ORDER BY time_ms ASC LIMIT ?`,
  },
} as const;

const FACTS_AFTER = {
  combo: {
    tie: {
      newest: `SELECT ${FACT} FROM fact INDEXED BY fact_combo WHERE combo = ? AND time_ms = ? AND fid < ? ORDER BY fid DESC LIMIT ?`,
      oldest: `SELECT ${FACT} FROM fact INDEXED BY fact_combo WHERE combo = ? AND time_ms = ? AND fid > ? ORDER BY fid ASC LIMIT ?`,
    },
    past: {
      newest: `SELECT ${FACT} FROM fact INDEXED BY fact_combo WHERE combo = ? AND time_ms < ? AND time_ms >= ? ORDER BY time_ms DESC, fid DESC LIMIT ?`,
      oldest: `SELECT ${FACT} FROM fact INDEXED BY fact_combo WHERE combo = ? AND time_ms > ? AND time_ms <= ? ORDER BY time_ms ASC, fid ASC LIMIT ?`,
    },
  },
  crew: {
    tie: {
      newest: `SELECT ${FACT} FROM fact INDEXED BY fact_crew WHERE crew = ? AND of = ? AND time_ms = ? AND fid < ? ORDER BY fid DESC LIMIT ?`,
      oldest: `SELECT ${FACT} FROM fact INDEXED BY fact_crew WHERE crew = ? AND of = ? AND time_ms = ? AND fid > ? ORDER BY fid ASC LIMIT ?`,
    },
    past: {
      newest: `SELECT ${FACT} FROM fact INDEXED BY fact_crew WHERE crew = ? AND of = ? AND time_ms < ? AND time_ms >= ? ORDER BY time_ms DESC, fid DESC LIMIT ?`,
      oldest: `SELECT ${FACT} FROM fact INDEXED BY fact_crew WHERE crew = ? AND of = ? AND time_ms > ? AND time_ms <= ? ORDER BY time_ms ASC, fid ASC LIMIT ?`,
    },
  },
} as const;

export type Walks = { combos: readonly number[] } | { crews: readonly number[] } | "all" | "none";

type Walk = "all" | { combo: number } | { crew: number };

function walksOf(of: string, walks: Exclude<Walks, "none">): { walk: Walk; sql: { newest: string; oldest: string }; prefix: unknown[] }[] {
  if (walks === "all") return [{ walk: "all", sql: FACTS.of, prefix: [of] }];
  if ("combos" in walks) return walks.combos.map((combo) => ({ walk: { combo }, sql: FACTS.combo, prefix: [combo] }));
  return walks.crews.map((crew) => ({ walk: { crew }, sql: FACTS.crew, prefix: [crew, of] }));
}

export interface Settle {
  settles(fact: Fact): boolean;
  key: string | undefined;
  in: ReadonlySet<number> | undefined;
  out: ReadonlySet<number>;
}

interface Probe {
  walks: { sql: (typeof FACTS_AFTER)[keyof typeof FACTS_AFTER]; prefix: unknown[] }[];
  meets(fact: Fact): boolean;
}

function keepsPart(settle: Settle, value: number): boolean {
  return (settle.in === undefined || settle.in.has(value)) && !settle.out.has(value);
}

const FACT_BY_ID = `SELECT ${FACT} FROM fact WHERE id = ?`;
const SELECTED = `SELECT ${FACT} FROM`;
const STATING = `SELECT ${FACT}, record, accounts FROM`;

const TALLIED = " n, t, u FROM";
const TALLIED_STATING = " n, t, u, accounts, start_min, start_max FROM";
const FACTS_OF_DAY = `${SELECTED} fact INDEXED BY fact_day WHERE day = ? AND of = ? ORDER BY fid LIMIT ?`;

function statedOf(fact: Fact): string {
  return factAccounts(fact.accounts ?? null, fact.record ?? null);
}

function factCell(fact: Fact): TallyCell {
  return { day: fact.day, combo: fact.combo, crew: fact.crew, source: fact.source, n: 1, t: fact.time_ms, u: fact.time_ms, accounts: statedOf(fact) };
}

const STARTS_BEFORE_DAY = DAY_MS;
const STARTS_AFTER_DAY = 3 * DAY_MS;

interface KeptRow {
  combo: number;
  crew: number;
  accounts: string;
  n: number;
  first: string;
  last: string;
}

interface Fallback {
  row: KeptRow;
  from: string;
  start_ms: number;
  read: number;
}

function keptCell(cell: Pick<TallyCell, "combo" | "crew" | "n">): TallyCell {
  return { day: "", combo: cell.combo, crew: cell.crew, source: "", n: cell.n, t: null, u: null };
}

function rowKey(cell: { combo: number; crew: number; accounts?: string }): string {
  return `${cell.combo}\0${cell.crew}\0${cell.accounts}`;
}

interface Withheld {
  day: string;
  accounts: string;
  start_ms: number;
  n: number;
  key?: string;
}
const MEASURE = "SELECT value FROM fact_measure WHERE fid = ? AND measure = ?";
const MEASURES = "SELECT measure, value FROM fact_measure WHERE fid = ? LIMIT ?";
const COMBO = "SELECT keys FROM combos WHERE id = ?";
const NAME = "SELECT name FROM names WHERE id = ?";
const CREW = "SELECT handles FROM crews WHERE id = ?";
const NAMED = "SELECT id FROM names WHERE role = 'value' AND name = ?";
const SPAN = "SELECT value FROM meta WHERE key = 'span'";
const COMBOS_OF = "SELECT combo FROM combo_keys WHERE of = ? AND key = ? AND name = ? LIMIT ?";
const CREWS_OF = "SELECT crew FROM crew_members WHERE handle = ? LIMIT ?";
const KEPT = "SELECT combo, crew, n FROM totals WHERE of = ? LIMIT ?";
const KEPT_STATING = "SELECT combo, crew, accounts, n, first, last FROM totals WHERE of = ? LIMIT ?";
const TOTALS = {
  crew: "SELECT combo, crew, n, first, last FROM totals WHERE of = ? AND crew = ? ORDER BY combo LIMIT ?",
  combo: "SELECT combo, crew, n, first, last FROM totals INDEXED BY totals_combo WHERE of = ? AND combo = ? ORDER BY crew LIMIT ?",
} as const;
const TOTALS_STATING = {
  crew: "SELECT combo, crew, accounts, n, first, last FROM totals WHERE of = ? AND crew = ? ORDER BY combo LIMIT ?",
  combo: "SELECT combo, crew, accounts, n, first, last FROM totals INDEXED BY totals_combo WHERE of = ? AND combo = ? ORDER BY crew LIMIT ?",
} as const;
const NEXT_VALUE = "SELECT name FROM combo_keys WHERE of = ? AND key = ? AND name > ? ORDER BY name LIMIT ?";
const CELL = "day, combo, crew, source, n, t, u";
const CELLS = {
  days: {
    newest: "SELECT day, -1 AS combo, -1 AS crew, source, n, t, u FROM day_total WHERE of = ? AND day >= ? AND day <= ? ORDER BY day DESC LIMIT ?",
    oldest: "SELECT day, -1 AS combo, -1 AS crew, source, n, t, u FROM day_total WHERE of = ? AND day >= ? AND day <= ? ORDER BY day ASC LIMIT ?",
  },
  all: {
    newest: `SELECT ${CELL} FROM tally WHERE of = ? AND day >= ? AND day <= ? ORDER BY day DESC LIMIT ?`,
    oldest: `SELECT ${CELL} FROM tally WHERE of = ? AND day >= ? AND day <= ? ORDER BY day ASC LIMIT ?`,
  },
  combo: {
    newest: `SELECT ${CELL} FROM tally INDEXED BY tally_combo WHERE of = ? AND combo = ? AND day >= ? AND day <= ? ORDER BY day DESC LIMIT ?`,
    oldest: `SELECT ${CELL} FROM tally INDEXED BY tally_combo WHERE of = ? AND combo = ? AND day >= ? AND day <= ? ORDER BY day ASC LIMIT ?`,
  },
  crew: {
    newest: `SELECT ${CELL} FROM tally INDEXED BY tally_crew WHERE of = ? AND crew = ? AND day >= ? AND day <= ? ORDER BY day DESC LIMIT ?`,
    oldest: `SELECT ${CELL} FROM tally INDEXED BY tally_crew WHERE of = ? AND crew = ? AND day >= ? AND day <= ? ORDER BY day ASC LIMIT ?`,
  },
} as const;
const EDGE_DAY = {
  newest: "SELECT day FROM day_total WHERE of = ? ORDER BY day DESC LIMIT ?",
  oldest: "SELECT day FROM day_total WHERE of = ? ORDER BY day ASC LIMIT ?",
} as const;

function longestOf(read: FactsRead, of: string): number {
  const row = read.point<{ value: string }>(SPAN, [], read.work.beside(1));
  return row === undefined ? 0 : (JSON.parse(row.value) as Record<string, number>)[of] ?? 0;
}

interface Span {
  start: number | string;
  edge: number | string;
  edgeIn: boolean;
  rows: unknown[];
}

export class Ledger {
  readonly points = new Map<string, unknown>();
  readonly walks = new Map<string, { rows: unknown[]; more: boolean }>();
  readonly spans = new Map<string, Span>();
  readonly days = new Set<string>();
  readonly passed = new Map<number, Fact>();
  readonly told = new Set<number>();
  readonly toldDays = new Set<string>();
  readonly toldOf = new Set<string>();
  readonly toldRows = new Set<string>();
  readonly passedRows = new Map<string, Withheld>();

  constructor(readonly read: Pick<Metered, "walk" | "point">, readonly real: Work, readonly gate?: SearchGate) {}

  fetch(budget: number, side: Side, proving = false): Fetch {
    return new Fetch(this, this.real.beside(budget, false), this.real, side, proving);
  }
}

export class Fetch {
  readonly #ledger: Ledger;
  readonly #work: Work;
  readonly #real: Work;
  readonly #keys = new Map<number, ReadonlyMap<string, number>>();
  readonly #names = new Map<number, string>();
  readonly #crews = new Map<number, readonly string[]>();
  readonly #measures = new Map<string, number | null>();
  readonly #byId = new Map<string, Fact | undefined>();
  readonly #walked = new Map<string, readonly unknown[]>();
  #at: { ms: number } | { day: string } | undefined;

  constructor(ledger: Ledger, work: Work, real: Work, readonly side: Side, readonly proving: boolean) {
    this.#ledger = ledger;
    this.#work = work;
    this.#real = real;
  }

  get #out(): boolean {
    return this.#work.out || this.#real.out;
  }

  #stop(): never {
    throw new Stopped(this.side, this.#at);
  }

  #stated(sql: string): string {
    return this.#ledger.gate === undefined ? sql : sql.replace(SELECTED, STATING);
  }

  #admits(fact: Fact): boolean {
    const gate = this.#ledger.gate;
    if (gate === undefined || gate.allows(statedOf(fact), fact.start_ms, false)) return true;
    this.#ledger.passed.set(fact.fid, fact);
    return false;
  }

  #whole(): void {
    if (this.#ledger.gate !== undefined) throw new Error("a prepared total is read whole, never under a gate");
  }

  #tallied(sql: string): string {
    return this.#ledger.gate === undefined ? sql : sql.replace(TALLIED, TALLIED_STATING);
  }

  get gated(): boolean {
    return this.#ledger.gate !== undefined;
  }

  dayFacts(of: string, day: string): Fact[] {
    return this.#all<Fact>(FACTS_OF_DAY, [day, of]);
  }

  allowedCells(of: string, cells: readonly TallyCell[], keep: ((cell: TallyCell) => boolean) | undefined, tells: boolean): TallyCell[] {
    const { allowed, withheld } = this.#judged(of, cells, keep);
    if (tells) this.#tellDays(of, withheld);
    return allowed;
  }

  allowedKept(of: string, keep: (cell: TallyCell) => boolean, tells: boolean): TallyCell[] {
    const { allowed, withheld } = this.#allowedRows(of, this.#all<KeptRow>(KEPT_STATING, [of]), keep, "combo");
    if (tells) this.#tellAll(of, withheld);
    return allowed.map(keptCell);
  }

  #allowedTotals(of: string, by: "crew" | "combo", id: number): Total[] {
    const { allowed, withheld } = this.#allowedRows(of, this.#all<KeptRow>(TOTALS_STATING[by], [of, id]), () => true, by);
    for (const each of withheld) this.#ledger.passedRows.set(`${of}\0${each.key}`, each);
    return allowed;
  }

  tellPassed(): void {
    const { gate, passedRows, toldRows } = this.#ledger;
    for (const [key, each] of passedRows) {
      if (toldRows.has(key)) continue;
      toldRows.add(key);
      gate!.tell(each.accounts, each.start_ms, each.n);
    }
  }

  #allowedRows(of: string, rows: readonly KeptRow[], keep: (cell: TallyCell) => boolean, by: "crew" | "combo"): { allowed: StatedTotal[]; withheld: (Withheld & { key: string })[] } {
    const gate = this.#ledger.gate!;
    const span = this.#span(of);
    const allowed: StatedTotal[] = [];
    const withheld: (Withheld & { key: string })[] = [];
    const fallbacks = new Map<string, Fallback>();
    for (const row of rows) {
      if (!keep(keptCell(row))) continue;
      const start_ms = Date.parse(`${row.first}T00:00:00Z`) - STARTS_BEFORE_DAY - span;
      const end_ms = Date.parse(`${row.last}T00:00:00Z`) + STARTS_AFTER_DAY - 1;
      const whole = gate.whole(row.accounts, start_ms, end_ms);
      if (whole === true) {
        this.#prepareCell(row);
        allowed.push({ ...row });
      } else if (whole === false) withheld.push({ day: "", accounts: row.accounts, start_ms, n: row.n, key: rowKey(row) });
      else {
        const floor = gate.floorOf(row.accounts);
        const below = typeof floor === "number" && floor > start_ms && gate.whole(row.accounts, start_ms, floor - 1) !== undefined;
        const from = below ? utcDate(floor - STARTS_AFTER_DAY) : row.first;
        fallbacks.set(rowKey(row), { row, from: from > row.first ? from : row.first, start_ms, read: 0 });
      }
    }
    const reach = new Map<number, { from: string; to: string }>();
    for (const { row, from } of fallbacks.values()) {
      const at = row[by];
      const held = reach.get(at);
      reach.set(at, held === undefined ? { from, to: row.last } : { from: from < held.from ? from : held.from, to: row.last > held.to ? row.last : held.to });
    }
    const reached = (cell: TallyCell) => {
      const fallback = fallbacks.get(rowKey(cell));
      return fallback !== undefined && cell.day >= fallback.from && keep(cell);
    };
    const cells: TallyCell[] = [];
    for (const [at, { from, to }] of reach) {
      for (const cell of this.cells(by, of, from, to, at)) {
        if (!reached(cell)) continue;
        fallbacks.get(rowKey(cell))!.read += cell.n;
        cells.push(cell);
      }
    }
    const judged = this.#judged(of, cells, reached);
    for (const cell of judged.allowed) allowed.push({ combo: cell.combo, crew: cell.crew, n: cell.n, first: cell.day, last: cell.day, accounts: cell.accounts! });
    for (const each of judged.withheld) withheld.push({ ...each, key: each.key! });
    for (const { row, start_ms, read } of fallbacks.values()) if (row.n > read) withheld.push({ day: "", accounts: row.accounts, start_ms, n: row.n - read, key: rowKey(row) });
    return { allowed, withheld };
  }

  #span(of: string): number {
    const row = this.#point<{ value: string }>(SPAN, []);
    return row === undefined ? 0 : (JSON.parse(row.value) as Record<string, number>)[of] ?? 0;
  }

  #tellAll(of: string, withheld: readonly Withheld[]): void {
    const { gate, toldDays, toldOf } = this.#ledger;
    if (toldOf.has(of) || [...toldDays].some((day) => day.startsWith(`${of}\0`))) return;
    toldOf.add(of);
    for (const each of withheld) gate!.tell(each.accounts, each.start_ms, each.n);
  }

  #judged(of: string, cells: readonly TallyCell[], keep: ((cell: TallyCell) => boolean) | undefined): { allowed: TallyCell[]; withheld: Withheld[] } {
    const gate = this.#ledger.gate!;
    const kept = keep === undefined ? cells : cells.filter(keep);
    const whole = kept.map((cell) => gate.whole(cell.accounts!, cell.start_min!, cell.start_max!));
    const cut = new Set(kept.filter((_, at) => whole[at] === undefined).map((cell) => cell.day));
    const allowed: TallyCell[] = [];
    const withheld: Withheld[] = [];
    const walked = new Set<string>();
    kept.forEach((cell, at) => {
      if (!cut.has(cell.day)) {
        if (whole[at] === true) {
          this.#prepareCell(cell);
          allowed.push(cell);
        } else withheld.push({ day: cell.day, accounts: cell.accounts!, start_ms: cell.start_min!, n: cell.n, key: `${cell.day}\0${rowKey(cell)}` });
        return;
      }
      if (walked.has(cell.day)) return;
      walked.add(cell.day);
      for (const fact of this.dayFacts(of, cell.day)) {
        const each = factCell(fact);
        if (keep !== undefined && !keep(each)) continue;
        const accounts = statedOf(fact);
        if (!gate.allows(accounts, fact.start_ms, false)) {
          withheld.push({ day: fact.day, accounts, start_ms: fact.start_ms, n: 1, key: `fact ${fact.fid}` });
          continue;
        }
        this.#prepareCell(each);
        allowed.push(each);
      }
    });
    return { allowed, withheld };
  }

  #tellDays(of: string, withheld: readonly Withheld[]): void {
    const { gate, toldDays, toldOf } = this.#ledger;
    if (toldOf.has(of)) return;
    const fresh = new Set<string>();
    for (const each of withheld) {
      const day = `${of}\0${each.day}`;
      if (toldDays.has(day) && !fresh.has(day)) continue;
      fresh.add(day);
      toldDays.add(day);
      gate!.tell(each.accounts, each.start_ms, each.n);
    }
  }

  #reaches(of: string, cell: TallyCell, keep: (cell: TallyCell) => boolean): boolean {
    const gate = this.#ledger.gate;
    if (gate === undefined) return true;
    const whole = gate.whole(cell.accounts!, cell.start_min!, cell.start_max!);
    if (whole !== undefined) return whole;
    return this.dayFacts(of, cell.day).some((fact) => keep(factCell(fact)) && gate.allows(statedOf(fact), fact.start_ms, false));
  }

  #prepareCell(cell: Pick<TallyCell, "combo" | "crew">): void {
    if (cell.combo >= 0) for (const name of this.keys(cell.combo).values()) this.spelled(name);
    if (cell.crew >= 0) this.handles(cell.crew);
  }

  tell(matches: (fact: Fact) => boolean): void {
    const { gate, passed, told } = this.#ledger;
    if (gate === undefined) return;
    for (const fact of passed.values()) {
      if (told.has(fact.fid) || !matches(fact)) continue;
      told.add(fact.fid);
      gate.allows(statedOf(fact), fact.start_ms, true);
    }
  }

  #point<T>(sql: string, params: readonly unknown[]): T | undefined {
    sql = this.#stated(sql);
    if (this.#work.left < 1) this.#stop();
    const name = JSON.stringify([sql, ...params]);
    let row: T | undefined;
    if (this.#ledger.points.has(name)) row = this.#ledger.points.get(name) as T | undefined;
    else {
      if (this.#real.left < 1) this.#stop();
      row = this.#ledger.read.point<T>(sql, params, this.#real);
      this.#ledger.points.set(name, row);
    }
    this.#work.made(1);
    return row;
  }

  #fresh<T>(sql: string, params: readonly unknown[], limit: number): { rows: T[]; more: boolean; cut: boolean } {
    sql = this.#stated(sql);
    const take = this.#work.out ? 0 : Math.min(limit, this.#work.left - 1);
    if (take <= 0) return { ...this.#work.replay<T>([], true, limit), cut: false };
    const read = this.#ledger.read.walk<T>(sql, params, take, this.#real);
    this.#work.replay(read.rows, read.more, limit);
    return { ...read, cut: read.more && read.rows.length < take };
  }

  #read<T>(sql: string, params: readonly unknown[], limit: number): { rows: T[]; more: boolean } {
    const name = JSON.stringify([sql, ...params]);
    const held = this.#ledger.walks.get(name);
    const take = Math.min(limit, this.#work.left - 1);
    if (held !== undefined && (!held.more || held.rows.length >= take)) return this.#work.replay(held.rows as T[], held.more, limit);
    const read = this.#fresh<T>(sql, params, limit);
    if (!read.cut && (read.rows.length > 0 || !read.more) && (held === undefined || held.rows.length < read.rows.length)) this.#ledger.walks.set(name, { rows: read.rows, more: read.more });
    return read;
  }

  #all<T>(sql: string, params: readonly unknown[]): T[] {
    const { rows, more } = this.#read<T>(sql, params, Number.MAX_SAFE_INTEGER - 1);
    if (more) this.#stop();
    return rows;
  }

  #step<T, K extends number | string>(sql: string, prefix: readonly unknown[], key: (row: T) => K, lo: K, hi: K, limit: number): { rows: T[]; more: boolean } {
    const newest = this.side === "newest";
    const before = (a: number | string, b: number | string) => (newest ? a > b : a < b);
    const [from, to] = newest ? [hi, lo] : [lo, hi];
    const name = JSON.stringify([sql, ...prefix]);
    const span = this.#ledger.spans.get(name);
    const covers = (at: number | string) => span !== undefined && !before(at, span.start) && (before(at, span.edge) || (span.edgeIn && at === span.edge));
    if (span !== undefined && covers(from) && covers(to)) {
      return this.#work.replay((span.rows as T[]).filter((row) => !before(key(row), from) && !before(to, key(row))), false, limit);
    }
    const read = this.#fresh<T>(sql, [...prefix, lo, hi], limit);
    const last = read.rows.length === 0 ? undefined : key(read.rows.at(-1)!);
    const step: Span | undefined = !read.more ? { start: from, edge: to, edgeIn: true, rows: read.rows }
      : last === undefined ? undefined : { start: from, edge: last, edgeIn: false, rows: read.rows.filter((row) => key(row) !== last) };
    if (step === undefined || before(step.edge, step.start) || (step.edge === step.start && !step.edgeIn)) return read;
    if (span === undefined) this.#ledger.spans.set(name, step);
    else if (!before(step.start, span.start) && (before(step.start, span.edge) || step.start === span.edge)) {
      const further = before(span.edge, step.edge) || (span.edge === step.edge && step.edgeIn);
      this.#ledger.spans.set(name, {
        start: span.start, edge: further ? step.edge : span.edge, edgeIn: further ? step.edgeIn : span.edgeIn,
        rows: [...span.rows, ...(step.rows as T[]).filter((row) => !covers(key(row)))],
      });
    }
    return read;
  }

  #ordered<T, K extends number | string>(sql: string, prefix: readonly unknown[], key: (row: T) => K, lo: K, hi: K, at: (key: K) => { ms: number } | { day: string }, each: (row: T) => boolean | void, first = STEP): void {
    const newest = this.side === "newest";
    let limit = first;
    this.#at = at(newest ? hi : lo);
    try {
      for (;;) {
        const { rows, more } = this.#step<T, K>(sql, prefix, key, lo, hi, limit);
        if (!more) {
          for (const row of rows) {
            this.#at = at(key(row));
            if (each(row) === false) return;
          }
          return;
        }
        const last = rows.length === 0 ? undefined : key(rows.at(-1)!);
        const done = last === undefined ? [] : rows.filter((row) => key(row) !== last);
        if (done.length === 0) {
          if (this.#out) this.#stop();
          limit *= 2;
          continue;
        }
        for (const row of done) {
          this.#at = at(key(row));
          if (each(row) === false) return;
        }
        this.#at = at(last!);
        if (this.#out) this.#stop();
        if (newest) hi = last!;
        else lo = last!;
        limit = Math.max(limit, Math.min(STEP, limit * 2));
      }
    } finally {
      this.#at = undefined;
    }
  }

  prepare(fact: Fact, measures: readonly string[]): void {
    for (const name of this.keys(fact.combo).values()) this.spelled(name);
    this.handles(fact.crew);
    for (const measure of measures) this.measure(fact, measure);
  }

  facts(of: string, from_ms: number, to_ms: number, measures: readonly string[] = [], walks: Walks = "all", settle?: Settle): Fact[] {
    if (to_ms <= from_ms || walks === "none") return [];
    const name = JSON.stringify(["facts", of, from_ms, to_ms, measures, walks, settle !== undefined]);
    const held = this.#walked.get(name);
    if (held !== undefined) return held as Fact[];
    const facts: Fact[] = [];
    for (const { walk, sql, prefix } of walksOf(of, walks)) {
      const parts = settle === undefined ? undefined : this.#parts(of, walk, settle);
      if (parts?.size === 0) continue;
      const [met, settled, asked] = [new Set<number | null>(), new Set<number | null>(), new Set<number>()];
      let at: number | undefined;
      this.#ordered<Fact, number>(sql[this.side], prefix, (fact) => fact.time_ms, from_ms, to_ms - 1, (ms) => ({ ms }), (fact) => {
        if (at !== undefined && fact.time_ms !== at) return false;
        if (!this.#admits(fact)) return true;
        const part = settle?.key === undefined ? null : this.value(fact, settle.key) ?? null;
        if (parts !== undefined && !parts.has(part)) return true;
        met.add(part);
        this.#byId.set(fact.id, fact);
        this.prepare(fact, measures);
        facts.push(fact);
        if (parts !== undefined && at === undefined && !settled.has(part) && settle!.settles(fact)) {
          settled.add(part);
          if (settled.size === met.size) {
            const [lo, hi] = this.side === "newest" ? [from_ms, fact.time_ms] : [fact.time_ms, to_ms - 1];
            for (const value of [...parts]) {
              if (value === null || met.has(value) || asked.has(value)) continue;
              asked.add(value);
              if (!this.#holds(of, walk === "all" || "combo" in walk ? undefined : walk.crew, settle!.key!, value, lo, hi, { ms: fact.time_ms })) parts.delete(value);
            }
          }
          if (settled.size === parts.size) at = fact.time_ms;
        }
        return true;
      }, settle === undefined ? STEP : 2);
    }
    facts.sort((left, right) => left.time_ms - right.time_ms || left.fid - right.fid);
    this.#walked.set(name, facts);
    return facts;
  }

  cells(kind: keyof typeof CELLS, of: string, from: string, to: string, id?: number): TallyCell[] {
    const cells: TallyCell[] = [];
    this.#ordered<TallyCell, string>(this.#tallied(CELLS[kind][this.side]), id === undefined ? [of] : [of, id], (cell) => cell.day, from, to, (day) => ({ day }), (cell) => {
      if (this.#ledger.gate === undefined) this.#prepareCell(cell);
      cells.push(cell);
    });
    return cells;
  }

  cellEdge(kind: keyof typeof CELLS, of: string, keep: (cell: TallyCell) => boolean, id?: number): string | undefined {
    let found: string | undefined;
    this.#ordered<TallyCell, string>(this.#tallied(CELLS[kind][this.side]), id === undefined ? [of] : [of, id], (cell) => cell.day, "", "9999-12-31", (day) => ({ day }), (cell) => {
      if (!keep(cell) || !this.#reaches(of, cell, keep)) return true;
      found = cell.day;
      return false;
    }, 2);
    return found;
  }

  kept(of: string): TallyCell[] {
    this.#whole();
    return this.#all<{ combo: number; crew: number; n: number }>(KEPT, [of]).map(({ combo, crew, n }) => {
      for (const name of this.keys(combo).values()) this.spelled(name);
      this.handles(crew);
      return { day: "", combo, crew, source: "", n, t: null, u: null };
    });
  }

  totals(of: string, by: "crew" | "combo", id: number): StatedTotal[] {
    if (this.#ledger.gate !== undefined) return this.#allowedTotals(of, by, id);
    this.#whole();
    const pairs = new Map<string, Total>();
    for (const row of this.#all<Total>(TOTALS[by], [of, id])) {
      const key = `${row.combo},${row.crew}`;
      const held = pairs.get(key);
      if (held === undefined) pairs.set(key, { ...row });
      else {
        held.n += row.n;
        if (row.first < held.first) held.first = row.first;
        if (row.last > held.last) held.last = row.last;
      }
    }
    return [...pairs.values()];
  }

  #parts(of: string, walk: Walk, settle: Settle): Set<number | null> {
    const key = settle.key;
    if (key === undefined) return new Set([null]);
    const values: number[] = [];
    if (walk !== "all" && "combo" in walk) {
      const value = this.keys(walk.combo).get(key);
      if (value !== undefined) values.push(value);
    } else {
      for (let after = -1; ;) {
        const next = this.#read<{ name: number }>(NEXT_VALUE, [of, key, after], 1);
        if (next.rows.length === 0) {
          if (next.more) this.#stop();
          break;
        }
        values.push(after = next.rows[0]!.name);
      }
    }
    return new Set(values.filter((value) => keepsPart(settle, value)));
  }

  #holds(of: string, crew: number | undefined, key: string, value: number, lo: number, hi: number, at: { ms: number }): boolean {
    const combos = this.combosOf(of, key, value);
    const sides: Probe[] = [{ walks: combos.map((combo) => ({ sql: FACTS_AFTER.combo, prefix: [combo] })), meets: (fact) => crew === undefined || fact.crew === crew }];
    if (crew !== undefined) {
      const theirs = new Set(combos);
      sides.push({ walks: [{ sql: FACTS_AFTER.crew, prefix: [crew, of] }], meets: (fact) => theirs.has(fact.combo) });
    }
    try {
      return this.#race(sides, lo, hi);
    } catch (error) {
      if (error instanceof Stopped) throw new Stopped(this.side, at);
      throw error;
    } finally {
      this.#at = at;
    }
  }

  #race(sides: readonly Probe[], lo: number, hi: number): boolean {
    const newest = this.side === "newest";
    const [start, bound] = newest ? [hi + 1, lo] : [lo - 1, hi];
    const where = sides.map(() => ({ walk: 0, ms: start, fid: undefined as number | undefined }));
    for (let round = 2; ; round *= 2) {
      for (const [index, side] of sides.entries()) {
        const at = where[index]!;
        for (let left = round; left > 0;) {
          const walk = side.walks[at.walk];
          if (walk === undefined) return false;
          const { rows, more } = at.fid === undefined
            ? this.#read<Fact>(walk.sql.past[this.side], [...walk.prefix, at.ms, bound], left)
            : this.#read<Fact>(walk.sql.tie[this.side], [...walk.prefix, at.ms, at.fid], left);
          if (more && rows.length === 0) this.#stop();
          if (rows.some((fact) => this.#admits(fact) && side.meets(fact))) return true;
          left -= rows.length;
          const last = rows.at(-1);
          if (more) Object.assign(at, { ms: last!.time_ms, fid: last!.fid });
          else if (at.fid !== undefined) at.fid = undefined;
          else Object.assign(at, { walk: at.walk + 1, ms: start, fid: undefined });
        }
      }
    }
  }

  combosOf(of: string, key: string, name: number): number[] {
    return this.#all<{ combo: number }>(COMBOS_OF, [of, key, name]).map((row) => row.combo);
  }

  crewsOf(handle: string): number[] {
    return this.#all<{ crew: number }>(CREWS_OF, [handle]).map((row) => row.crew);
  }

  edgeDay(of: string, side: Side): string | undefined {
    this.#whole();
    return this.heldDay(of, side);
  }

  heldDay(of: string, side: Side): string | undefined {
    const { rows, more } = this.#read<{ day: string }>(EDGE_DAY[side], [of], 1);
    if (more && rows.length === 0) this.#stop();
    return rows[0]?.day;
  }

  calendar(days: readonly string[]): void {
    if (this.#work.made(days.length)) {
      const fresh = days.filter((day) => !this.#ledger.days.has(day));
      if (this.#real.made(fresh.length)) {
        for (const day of fresh) this.#ledger.days.add(day);
        return;
      }
      this.#at = { day: this.side === "newest" ? days[days.length - 1]! : days[0]! };
      this.#stop();
    }
    const made = Math.max(0, this.#work.left);
    this.#at = { day: this.side === "newest" ? days[days.length - 1 - made]! : days[made]! };
    this.#stop();
  }

  fact(id: string): Fact | undefined {
    if (!this.#byId.has(id)) {
      const fact = this.#point<Fact>(FACT_BY_ID, [id]);
      this.#byId.set(id, fact === undefined || !this.#admits(fact) ? undefined : fact);
    }
    return this.#byId.get(id);
  }

  measure(fact: Fact, name: string): number | null {
    const key = `${fact.fid}\0${name}`;
    if (!this.#measures.has(key)) this.#measures.set(key, this.#point<{ value: number }>(MEASURE, [fact.fid, name])?.value ?? null);
    return this.#measures.get(key)!;
  }

  measures(fact: Fact): Record<string, number> {
    return Object.fromEntries(this.#all<{ measure: string; value: number }>(MEASURES, [fact.fid]).map((row) => [row.measure, row.value]));
  }

  keys(combo: number): ReadonlyMap<string, number> {
    let keys = this.#keys.get(combo);
    if (keys === undefined) {
      const row = this.#point<{ keys: string }>(COMBO, [combo]);
      this.#keys.set(combo, keys = new Map(row === undefined ? [] : comboKeys(row.keys)));
    }
    return keys;
  }

  spelled(name: number): string {
    let spelled = this.#names.get(name);
    if (spelled === undefined) this.#names.set(name, spelled = this.#point<{ name: string }>(NAME, [name])?.name ?? "");
    return spelled;
  }

  value(fact: Pick<Fact, "combo">, key: string): number | undefined {
    return this.keys(fact.combo).get(key);
  }

  text(fact: Pick<Fact, "combo">, key: string): string | null {
    const name = this.value(fact, key);
    return name === undefined ? null : this.spelled(name);
  }

  handles(crew: number): readonly string[] {
    if (crew === 0) return [];
    let handles = this.#crews.get(crew);
    if (handles === undefined) {
      const row = this.#point<{ handles: string }>(CREW, [crew]);
      this.#crews.set(crew, handles = row === undefined || row.handles === "" ? [] : row.handles.split("\x1e"));
    }
    return handles;
  }

  named(value: string): number | undefined {
    return this.#point<{ id: number }>(NAMED, [value])?.id;
  }

  span(of: string): number {
    const row = this.#point<{ value: string }>(SPAN, []);
    return row === undefined ? 0 : (JSON.parse(row.value) as Record<string, number>)[of] ?? 0;
  }

  held(side: Side, rows = HELD_ROWS): Fetch {
    return new Fetch(this.#ledger, this.#ledger.real.beside(rows, false), this.#ledger.real.beside(Infinity), side, false);
  }

  edge(of: string, keep: (fact: Fact, fetch: Fetch) => boolean, walks: Walks = "all"): Fact | undefined | "unknown" {
    if (walks === "none") return undefined;
    let found: Fact | undefined;
    const nearer = (fact: Fact) => found === undefined || (this.side === "newest" ? fact.time_ms > found.time_ms : fact.time_ms < found.time_ms);
    try {
      for (const { sql, prefix } of walksOf(of, walks)) {
        this.#ordered<Fact, number>(sql[this.side], prefix, (fact) => fact.time_ms, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, (ms) => ({ ms }), (fact) => {
          if (!this.#admits(fact) || !keep(fact, this)) return true;
          if (nearer(fact)) found = fact;
          return false;
        }, 2);
      }
    } catch (error) {
      if (error instanceof Stopped) return "unknown";
      throw error;
    }
    return found;
  }
}

const FIRST_FACT = "SELECT day FROM fact WHERE of = ? ORDER BY time_ms LIMIT ?";
const LAST_FACT = "SELECT day FROM fact WHERE of = ? ORDER BY time_ms DESC LIMIT ?";

export function collectionDays(read: FactsRead, of: string): { first: string; last: string } | undefined {
  const work = read.work.beside(4);
  const first = read.walk<{ day: string }>(FIRST_FACT, [of], 1, work).rows[0]?.day;
  const last = read.walk<{ day: string }>(LAST_FACT, [of], 1, work).rows[0]?.day;
  return first === undefined || last === undefined ? undefined : { first, last };
}

function firstHeldOf(read: FactsRead, fetch: Fetch, context: CountContext): string | undefined {
  if (context.gate === undefined) return firstDay(read);
  const facts = [...context.collections.keys()].sort().map((of) => allowedDays(fetch, of)?.first);
  const entries = read.families([ASK_PRODUCT], context.gate).map((each) => each.first);
  return [...facts, ...entries].filter((day): day is string => day !== undefined).sort()[0];
}

function allowedDays(fetch: Fetch, of: string): { first: string; last: string } | undefined {
  const end = (side: Side) => new Tallies(fetch.held(side, FETCH_ROWS), { of, in: [], out: [], none: false }, { toDay: "9999-12-31" }, (handle) => handle).edge(side);
  const first = end("oldest");
  const last = first === undefined ? undefined : end("newest");
  return first === undefined || last === undefined ? undefined : { first, last };
}

export interface Stated {
  first: string;
  last: string;
  n: number;
}

function statedOver(fetch: Fetch, measures: readonly string[]): Map<string, Stated> | "unknown" {
  let facts: Fact[];
  try {
    facts = fetch.facts("days", -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, measures);
  } catch (error) {
    if (error instanceof Stopped) return "unknown";
    throw error;
  }
  const stated = new Map<string, Stated>();
  for (const measure of measures) {
    const days = [...new Set(facts.filter((fact) => fetch.measure(fact, measure) !== null).map((fact) => fact.day))].sort();
    if (days.length > 0) stated.set(measure, { first: days[0]!, last: days.at(-1)!, n: days.length });
  }
  return stated;
}

export interface FactShown {
  time: Raw;
  date_only: boolean;
  keys: Record<string, string>;
  people: string[];
  measures: Record<string, number>;
}

function factsShown(fetch: Fetch, ids: readonly string[]): Map<string, FactShown> {
  const found = new Map<string, FactShown>();
  for (const id of new Set(ids)) {
    const fact = fetch.fact(id);
    if (fact === undefined) continue;
    const keys: Record<string, string> = {};
    for (const [key, name] of fetch.keys(fact.combo)) keys[key] = fetch.spelled(name);
    found.set(id, {
      time: fact.date_only === 1 ? fact.day : fact.time_ms, date_only: fact.date_only === 1, keys,
      people: [...fetch.handles(fact.crew)].sort(), measures: fetch.measures(fact),
    });
  }
  return found;
}


interface Row {
  unit: string;
  fact: Fact | null;
  day: string;
  days?: readonly string[];
  p: string | null;
  value: number | null;
  t: Raw;
  hour: number | null;
}

interface Placed extends Row {
  person: string | null;
  area: PresenceAreaRow | null;
  run: string | null;
}

interface Unit {
  g: Raw[];
  p: string | null;
  unit: string;
  v: number | null;
  t: Raw;
  d: string;
  fact: string | null;
}

export function partitionKeyOf(ask: Pick<CountAsk, "of">, collection: Collection, measure: Measure | undefined): string | undefined {
  return measure === undefined ? undefined
    : measure.unit === "currency" ? "currency"
      : ask.of === "days" && measure.copies === undefined && collection.keys.includes("instrument") ? "instrument" : undefined;
}

function populationOver(read: FactsRead, fetch: Fetch, ask: CountAsk, context: CountContext, admitted: Admitted, measureName: string | undefined, scope: Scope | undefined, runsGiven?: Runs): Population {
  const { settings } = context;
  const collection = context.collections.get(ask.of)!;
  const measure = measureName === undefined ? undefined : collection.measures[measureName]!;
  const range = rangeOf(ask, context);
  const isDays = ask.of === "days";
  const first = (isDays ? firstHeldOf(read, fetch, context) : firstDay(read)) ?? range.toDay;
  const today = civilDay(context.now_ms, settings);
  const asked = [...new Set([measureName, ask.measure].filter((name): name is string => name !== undefined))];
  let people: PeopleMap | undefined;
  const personOf = (handle: string) => (people ??= peopleOrRefuse(context)).idOf(handle) ?? handle;

  const toDay = range.toDay;
  const from_ms = range.from_ms ?? -Number.MAX_SAFE_INTEGER, to_ms = range.to_ms;
  const calendar = { from: range.fromDay === undefined || range.fromDay < first ? first : range.fromDay, to: range.toDay > today ? today : range.toDay };

  const partitionKey = partitionKeyOf(ask, collection, measure);
  if (nothingAdmitted(admitted)) return emptyPopulation(measure, partitionKey, calendar, ask.by.filter((key) => key !== "item")[0] === "run");
  const presence = needsPresence(ask, context.collections) ? presenceOrRefuse(read, context) : undefined;
  const groupBy = ask.by.filter((key) => key !== "item");
  const isTime = (key: string) => (TIME_KEYS as readonly string[]).includes(key);
  const placeKeys = groupBy.filter((key) => joinedPlace(key, ask.of, collection.keys));
  const isPlaceKey = (key: string) => placeKeys.includes(key) && key !== "sure";
  const scopePerson = scope !== undefined && "g" in scope && groupBy.includes("person");
  const scopePlaces = scope !== undefined && "g" in scope && groupBy.some(isPlaceKey);
  const scopeRuns = scope !== undefined && "g" in scope && groupBy[0] === "run";
  const byHour = groupBy.includes("hour");
  const isRun = groupBy[0] === "run";
  const clockSum = !isDays && ask.op === "sum" && measure?.split === "clock";
  const localRuns = !isDays && admitted.place !== undefined && isRun;

  const offsets = byHour || localRuns ? presence!.offsets(settings.zone) : [];
  const offsetAt = (ms: number): number => {
    let [low, high] = [0, offsets.length];
    while (low < high) {
      const middle = (low + high) >> 1;
      if (offsets[middle]![0] <= ms) low = middle + 1;
      else high = middle;
    }
    return low === 0 ? 0 : offsets[low - 1]![1];
  };
  const nextOffset = (ms: number): number | undefined => {
    let [low, high] = [0, offsets.length];
    while (low < high) {
      const middle = (low + high) >> 1;
      if (offsets[middle]![0] <= ms) low = middle + 1;
      else high = middle;
    }
    return offsets[low]?.[0];
  };
  const hourOf = (ms: number) => Math.floor(((((ms + 60_000 * offsetAt(ms)) % DAY_MS) + DAY_MS) % DAY_MS) / 3_600_000);
  const nextEdge = (ms: number) => Math.min(ms + 3_600_000 - ((((ms + 60_000 * offsetAt(ms)) % 3_600_000) + 3_600_000) % 3_600_000), nextOffset(ms) ?? ms + 3_600_000);
  const nextLocalDay = (ms: number) => {
    const shift = 60_000 * offsetAt(ms) - settings.day_start_hour * 3_600_000;
    return Math.min(Math.floor((ms + shift) / DAY_MS) * DAY_MS + DAY_MS - shift, nextOffset(ms) ?? Infinity);
  };
  const localDay = (ms: number) => presence!.dayAt(ms, settings);
  const dayOf = (fact: Fact, ms: number, day: string) => (localRuns && fact.date_only === 0 ? localDay(ms) : day);

  const valueFilters = Object.entries(admitted.values);
  const handles = admitted.kept.handles === undefined ? undefined : new Set(admitted.kept.handles);
  const words = admitted.words === undefined ? undefined
    : { in: admitted.words.in === undefined ? undefined : new Set(admitted.words.in), out: new Set(admitted.words.out) };
  const wordless = admitted.words?.in !== undefined && admitted.words.in.length === 0;
  const bounded = ask.at_least !== undefined || ask.at_most !== undefined;
  const areasOf = (fact: Fact): number[] => {
    if (fact.date_only === 1) return presence!.placedOn(fact.day).map(({ area }) => area.id);
    const piece = presence!.pieceAt(fact.time_ms);
    return piece === undefined ? [] : [piece.known, piece.guessed].filter((id): id is number => id !== null);
  };
  const placeIn = admitted.place?.in === undefined ? undefined : new Set(admitted.place.in);
  const placeOut = new Set(admitted.place?.out ?? []);
  const inBounds = (fact: Fact, f: Fetch): boolean => {
    const value = f.measure(fact, ask.measure!);
    if (value === null) return false;
    const currency = collection.measures[ask.measure!]!.unit === "currency" ? f.text(fact, "currency") : undefined;
    if (currency === null) return false;
    for (const [name, toward] of [["at_least", "ceil"], ["at_most", "floor"]] as const) {
      const written = ask[name];
      if (written === undefined) continue;
      const bound = currency === undefined ? Number(written) : minorBound(written, heldDigits(currency), toward);
      if (name === "at_least" ? value < bound : value > bound) return false;
    }
    return true;
  };
  const keeps = (fact: Fact, with_: { words: boolean; bounds: boolean }, f: Fetch = fetch): boolean => {
    if (with_.words && wordless) return false;
    if (handles !== undefined && !f.handles(fact.crew).some((handle) => handles.has(handle))) return false;
    for (const [key, { in: kept, out }] of valueFilters) {
      const value = f.value(fact, key);
      if (kept !== undefined && (value === undefined || !kept.includes(value))) return false;
      if (value !== undefined && out.includes(value)) return false;
    }
    if (admitted.chat !== undefined) {
      const chat = f.value(fact, "chat");
      if (chat === undefined || !admitted.chat.includes(chat)) return false;
    }
    if (with_.words && words !== undefined) {
      if (words.in !== undefined && !words.in.has(fact.id)) return false;
      if (words.out.has(fact.id)) return false;
    }
    if (!isDays && admitted.place !== undefined) {
      const areas = areasOf(fact);
      if (placeIn !== undefined && !areas.some((id) => placeIn.has(id))) return false;
      if (areas.some((id) => placeOut.has(id))) return false;
    }
    return !with_.bounds || !bounded || inBounds(fact, f);
  };
  const ranged = (fact: Fact) => fact.time_ms >= from_ms && fact.time_ms < to_ms;

  let inRange: Fact[] | undefined;
  let widened: Fact[] | undefined;
  let reached: Fact[] | undefined;
  const narrowed = once(() => narrowedTo(read, ask, context, admitted, scope, range, partitionKey));
  const walks = once(() => new Chosen(fetch, narrowed().filter).walks());
  const factsOver = (from: number, to: number) => fetch.facts(ask.of, from, to, asked, walks());
  const stopsAtFirst = (ask.op === "first" || ask.op === "last") && measureName !== undefined && ask.by.length === 0 && scope === undefined && !isDays
    && words === undefined && Object.values(admitted.took).every((terms) => terms.length === 0) && (admitted.place?.took.length ?? 0) === 0;
  const windowFacts = () => {
    const window = windowOver(narrowed().range, 0, settings);
    if (!stopsAtFirst) return factsOver(window.from_ms, window.to_ms);
    const { filter } = narrowed();
    const named = (list: readonly { key: string; names: readonly number[] }[]) => list.filter((each) => each.key === partitionKey).map((each) => new Set(each.names));
    const kept = named(filter.in);
    return fetch.facts(ask.of, window.from_ms, window.to_ms, asked, walks(), {
      settles: (fact) => ranged(fact) && keeps(fact, { words: true, bounds: true }) && valueOfFact(fact) !== null,
      key: partitionKey,
      in: kept.length === 0 ? undefined : kept.reduce((both, each) => new Set([...both].filter((name) => each.has(name)))),
      out: new Set(named(filter.out).flatMap((each) => [...each])),
    });
  };
  const reachedFacts = (): Fact[] | undefined => {
    if (words?.in === undefined) return undefined;
    return reached ??= [...words.in].flatMap((id) => {
      const fact = fetch.fact(id);
      if (fact === undefined || fact.of !== ask.of) return [];
      fetch.prepare(fact, asked);
      return [fact];
    }).sort((left, right) => left.time_ms - right.time_ms || left.fid - right.fid);
  };
  const told = (facts: Fact[], reaches: (fact: Fact) => boolean): Fact[] => {
    fetch.tell((fact) => fact.of === ask.of && reaches(fact) && keeps(fact, { words: true, bounds: true }));
    return facts;
  };
  const factsInRange = (): Fact[] => (inRange ??= told((reachedFacts() ?? windowFacts()).filter(ranged), ranged));
  const touches = (fact: Fact) => ranged(fact) || (fact.date_only === 0 && fact.start_ms < to_ms && fact.end_ms > from_ms);
  const factsReaching = (): Fact[] => {
    if (widened !== undefined) return widened;
    const reach = windowOver(narrowed().range, fetch.span(ask.of), settings);
    return (widened = told((reachedFacts() ?? factsOver(reach.from_ms, reach.to_ms)).filter(touches), touches));
  };

  const partOf = (fact: Fact | null) => (partitionKey === undefined || fact === null ? null : fetch.text(fact, partitionKey));
  const valueOfFact = (fact: Fact) => (measureName === undefined ? null : fetch.measure(fact, measureName));
  const touched = (fact: Fact): string[] => {
    if (fact.date_only === 1) return [fact.day];
    const end = fact.end_ms > fact.start_ms ? fact.end_ms - 1 : fact.start_ms;
    const days: string[] = [];
    for (let day = localRuns ? localDay(fact.start_ms) : civilDay(fact.start_ms, settings), last = localRuns ? localDay(end) : civilDay(end, settings); day <= last; day = addDays(day, 1)) {
      if ((range.fromDay === undefined || day >= range.fromDay) && day <= toDay) days.push(day);
    }
    return days;
  };

  const wholeRow = (fact: Fact): Row => ({
    unit: fact.id, fact, day: dayOf(fact, fact.time_ms, fact.day), ...isRun ? { days: touched(fact) } : {}, p: partOf(fact),
    value: valueOfFact(fact), t: fact.time_ms, hour: byHour && fact.date_only === 0 ? hourOf(fact.time_ms) : null,
  });
  const clockRows = (fact: Fact, out: Row[]) => {
    const value = valueOfFact(fact);
    const base = { unit: fact.id, fact, p: partOf(fact), t: fact.time_ms };
    if (value === null) {
      if (ranged(fact)) out.push({ ...base, day: dayOf(fact, fact.time_ms, fact.day), value: null, hour: byHour && fact.date_only === 0 ? hourOf(fact.time_ms) : null });
      return;
    }
    if (fact.date_only === 1) {
      if (ranged(fact)) out.push({ ...base, day: fact.day, value, hour: null });
      return;
    }
    const { start_ms: start, end_ms: end } = fact;
    if (end <= start) {
      if (start >= from_ms && start < to_ms) out.push({ ...base, day: dayOf(fact, start, fact.day), value, hour: byHour ? hourOf(start) : null });
      return;
    }
    for (let day = civilDay(start, settings), last = civilDay(end - 1, settings); day <= last; day = addDays(day, 1)) {
      if ((range.fromDay !== undefined && day < range.fromDay) || day > toDay) continue;
      const window = dayBounds(day, settings);
      const piece = [Math.max(start, window.start_ms), Math.min(end, window.end_ms)] as const;
      const lo = Math.max(piece[0], from_ms), hi = Math.min(piece[1], to_ms);
      if (hi <= lo) continue;
      if (!byHour && !localRuns) {
        out.push({ ...base, day, value: (value * (hi - lo)) / (end - start), hour: null });
        continue;
      }
      for (let a = lo; a < hi;) {
        const b = Math.min(hi, byHour ? nextEdge(a) : nextLocalDay(a));
        const at = localRuns ? localDay(a) : day;
        if (!localRuns || ((range.fromDay === undefined || at >= range.fromDay) && at <= toDay)) {
          out.push({ ...base, day: at, value: (value * (b - a)) / (end - start), hour: byHour ? hourOf(a) : null });
        }
        a = b;
      }
    }
  };
  const dayRows = (withBounds: boolean): Row[] => {
    if (wordless) return [];
    const days: string[] = [];
    for (let day = calendar.from; day <= calendar.to; day = addDays(day, 1)) days.push(day);
    fetch.calendar(days);
    const facts = calendar.from > calendar.to ? [] : told(factsOver(dayBounds(calendar.from, settings).start_ms, dayBounds(calendar.to, settings).end_ms), ranged);
    const kept = facts.filter((fact) => keeps(fact, { words: true, bounds: withBounds }));
    let parts: (string | null)[] = [null];
    if (partitionKey !== undefined) {
      const stating = [...new Set(facts.filter((fact) => keeps(fact, { words: true, bounds: true }) && valueOfFact(fact) !== null).map((fact) => fetch.text(fact, partitionKey)))];
      if (stating.length > 0) parts = stating;
    }
    const filtered = handles !== undefined || valueFilters.some(([, { in: kept, out }]) => kept !== undefined || out.length > 0) || admitted.chat !== undefined
      || admitted.words !== undefined && (admitted.words.in !== undefined || admitted.words.out.length > 0) || (withBounds && bounded);
    const statedOn = new Set(kept.map((fact) => fact.day));
    const placeDays = (ids: readonly number[]) => new Set(placeDaysOf(presence!, ids, calendar.from, calendar.to, settings).days.keys());
    const there = admitted.place?.in === undefined ? undefined : placeDays(admitted.place.in);
    const notThere = (admitted.place?.out.length ?? 0) > 0 ? placeDays(admitted.place!.out) : undefined;
    const byDay = new Map<string, Fact[]>();
    for (const fact of kept) {
      const stating = byDay.get(fact.day);
      if (stating === undefined) byDay.set(fact.day, [fact]);
      else stating.push(fact);
    }
    const rows: Row[] = [];
    for (const day of days) {
      if ((filtered && !statedOn.has(day)) || (there !== undefined && !there.has(day)) || notThere?.has(day) === true) continue;
      for (const p of parts) {
        const stating = (byDay.get(day) ?? []).filter((fact) => partitionKey === undefined || fetch.text(fact, partitionKey) === p);
        if (stating.length === 0) rows.push({ unit: day, fact: null, day, p, value: null, t: day, hour: null });
        for (const fact of stating) rows.push({ unit: day, fact, day, p, value: valueOfFact(fact), t: day, hour: null });
      }
    }
    return rows;
  };
  const rowsOf = (whole: boolean, withBounds: boolean): Row[] => {
    if (isDays) return dayRows(withBounds);
    const keep = (fact: Fact) => keeps(fact, { words: true, bounds: withBounds });
    if (clockSum && !whole) {
      const out: Row[] = [];
      for (const fact of factsReaching()) if (keep(fact)) clockRows(fact, out);
      return out;
    }
    return (isRun ? factsReaching() : factsInRange()).filter(keep).map(wholeRow);
  };
  const baseRows = once(() => rowsOf(false, true));

  let runs = runsGiven;
  if (runs === undefined && isRun) {
    const held = new Map<string | null, Set<string>>();
    for (const row of baseRows()) {
      if (measure !== undefined && row.value === null) continue;
      const days = held.get(row.p) ?? new Set();
      for (const day of row.days ?? [row.day]) days.add(day);
      held.set(row.p, days);
    }
    const rows = new Map<string, RunRow>();
    const of = new Map<string, string[]>();
    for (const [p, days] of [...held].sort(([left], [right]) => order(left, right))) {
      for (const run of runsOver(presence!, [...days], admitted.place?.in, settings)) {
        const id = JSON.stringify([run.from_day, run.to_day, run.country]);
        rows.set(id, run);
        for (let day = run.from_day; day <= run.to_day; day = addDays(day, 1)) {
          const key = JSON.stringify([p, day]);
          of.set(key, [...of.get(key) ?? [], id]);
        }
      }
    }
    runs = { rows, of };
  }
  if (scope !== undefined && "g" in scope && (scope.g.length !== groupBy.length || (scopeRuns && !runs!.rows.has(String(scope.g[0]))))) bad("this handle is not of a row of this query");
  const heldAt = scope !== undefined && "g" in scope ? scope.g.findIndex(isHeld) : -1;
  const heldIn = heldAt < 0 ? undefined : new Set((scope as { g: HeldHandles[] }).g[heldAt]!.handles);
  const scopeKeys = scope !== undefined && "g" in scope ? scope.g.map((value) => (isHeld(value) ? HELD : value)) : [];

  const named = (area: PresenceAreaRow) => groupBy.filter(isPlaceKey).every((key) => area[key as "city"] !== null);
  const areasNamed = (row: Row): (PresenceAreaRow | null)[] => {
    const placed = (day: string) => presence!.placedOn(day).map(({ area }) => area);
    let areas: PresenceAreaRow[];
    if (isDays) areas = placed(row.day);
    else if (row.fact!.date_only === 1) areas = placed(row.fact!.day);
    else areas = areasOf(row.fact!).map((id) => presence!.area(id)!).filter((area) => area !== undefined);
    const found = areas.filter(named);
    return found.length === 0 ? [null] : found;
  };
  const sureOf = (day: string): Raw => {
    const placed = presence!.placedOn(day);
    return placed.some((each) => !each.guessed) ? "known" : placed.length > 0 ? "guessed" : null;
  };
  const keyOf = (row: Placed, key: string, places: boolean): Raw => {
    if (isTime(key)) return timeKeyOf(key, row.day);
    if (key === "person") return row.person;
    if (key === partitionKey) return row.p;
    if (key === "hour") return row.hour;
    if (key === "run") return row.run;
    if (placeKeys.includes(key)) {
      if (key === "sure") return sureOf(isDays ? row.day : row.fact!.day);
      return places ? row.area?.[key as "city"] ?? null : null;
    }
    return row.fact === null ? null : fetch.text(row.fact, key);
  };
  const scoped = (row: Placed, places: boolean): boolean => {
    if (scope === undefined) return true;
    if ("t" in scope) return row.p === scope.t.p;
    if ("g" in scope) return row.p === scope.p && groupBy.every((key, at) => keyOf(row, key, places) === (scopeKeys[at] ?? null));
    return row.unit === scope.u[0] && row.p === scope.u[1] && (row.fact?.id ?? null) === scope.u[2];
  };
  const placedRows = new Map<string, Placed[]>();
  const placedOf = (set: readonly string[], rows: readonly Row[] = baseRows(), cache = true): { rows: Placed[]; places: boolean } => {
    const withPerson = set.includes("person") || scopePerson;
    const places = set.some(isPlaceKey) || scopePlaces;
    const withRuns = set.includes("run") || scopeRuns;
    const name = `${withPerson}:${places}:${withRuns}`;
    const held = cache ? placedRows.get(name) : undefined;
    if (held !== undefined) return { rows: held, places };
    const out: Placed[] = [];
    for (const row of rows) {
      const persons = !withPerson || isDays ? [null]
        : heldIn !== undefined ? (fetch.handles(row.fact!.crew).some((handle) => heldIn.has(handle)) ? [HELD] : [])
        : [...new Set(fetch.handles(row.fact!.crew).map(personOf))];
      const areas = places ? areasNamed(row) : [null];
      const runIds = !withRuns ? [null] : [...new Set((row.days ?? [row.day]).flatMap((day) => runs!.of.get(JSON.stringify([row.p, day])) ?? []))];
      const seen = new Set<string>();
      for (const person of persons) {
        for (const area of areas) {
          for (const run of runIds) {
            const each: Placed = { ...row, person, area, run };
            const key = JSON.stringify([person, placeKeys.map((place) => (place === "sure" ? null : area?.[place as "city"] ?? null)), run]);
            if (seen.has(key) || !scoped(each, places)) continue;
            seen.add(key);
            out.push(each);
          }
        }
      }
    }
    if (cache) placedRows.set(name, out);
    return { rows: out, places };
  };
  const unitsCache = new Map<string, Unit[]>();
  const unitsOf = (set: readonly string[]): Unit[] => {
    const name = JSON.stringify(set);
    const held = unitsCache.get(name);
    if (held !== undefined) return held;
    const { rows, places } = placedOf(set);
    const units = new Map<string, Unit & { valuedFact: string | null }>();
    for (const row of rows) {
      const g = set.map((key) => keyOf(row, key, places));
      const key = JSON.stringify([g, row.p, row.unit]);
      let unit = units.get(key);
      if (unit === undefined) units.set(key, unit = { g, p: row.p, unit: row.unit, v: null, t: row.t, d: row.day, fact: null, valuedFact: null });
      const fact = row.fact?.id ?? null;
      if (row.value !== null) {
        unit.v = (unit.v ?? 0) + row.value;
        if (fact !== null && (unit.valuedFact === null || fact < unit.valuedFact)) unit.valuedFact = fact;
      }
      if (row.t !== null && (unit.t === null || order(row.t, unit.t) < 0)) unit.t = row.t;
      if (row.day < unit.d) unit.d = row.day;
      if (fact !== null && (unit.fact === null || fact < unit.fact)) unit.fact = fact;
    }
    const out = [...units.values()].map(({ valuedFact, ...unit }) => ({ ...unit, fact: valuedFact ?? unit.fact }));
    unitsCache.set(name, out);
    return out;
  };
  const byGroup = (units: readonly Unit[]) => {
    const groups = new Map<string, Unit[]>();
    for (const unit of units) {
      const key = groupKey(unit.g, unit.p);
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [unit]);
      else group.push(unit);
    }
    return groups;
  };

  return {
    ...(measure === undefined ? {} : { measure }), ...(partitionKey === undefined ? {} : { partitionKey }), ...(runs === undefined ? {} : { runs }),
    calendar,
    groupsOf(set) {
      const groups: Group[] = [];
      for (const units of byGroup(unitsOf(set)).values()) {
        const values = units.flatMap((unit) => (unit.v === null ? [] : [unit.v]));
        const sum = values.reduce((total, value) => total + value, 0);
        const value = values.length === 0 ? null : ask.op === "avg" ? sum / values.length : ask.op === "min" ? Math.min(...values) : ask.op === "max" ? Math.max(...values)
          : ask.op === "sum" || ask.op === "count" ? sum : null;
        let t: Raw = null;
        for (const unit of units) if (unit.t !== null && (t === null || order(unit.t, t) < 0)) t = unit.t;
        groups.push({ keys: units[0]!.g, partition: units[0]!.p, n: units.length, valued: values.length, value, t });
      }
      return groups.sort((left, right) => {
        for (let at = 0; at < left.keys.length; at++) {
          const by = order(left.keys[at] ?? null, right.keys[at] ?? null);
          if (by !== 0) return by;
        }
        return order(left.partition, right.partition);
      });
    },
    extremesOf(set, kind, take) {
      const found = new Map<string, Extremum>();
      const pick = (unit: Unit) => (kind === "min" || kind === "max" ? unit.v : unit.t);
      for (const [key, units] of byGroup(unitsOf(set).filter((unit) => unit.v !== null))) {
        let best: Raw = null;
        for (const unit of units) {
          const value = pick(unit);
          if (best === null || (kind === "min" || kind === "first" ? order(value, best) < 0 : order(value, best) > 0)) best = value;
        }
        const tied = units.filter((unit) => pick(unit) === best).sort((left, right) => order(left.t, right.t) || order(left.unit, right.unit));
        found.set(key, { value: tied[0]!.v, tied: tied.length, named: tied.slice(0, take).map((unit) => ({ unit: unit.unit, p: unit.p, fact: unit.fact, t: unit.t, day: unit.d, v: unit.v })) });
      }
      return found;
    },
    overlapOf(set) {
      const seen = new Map<string, number>();
      for (const unit of unitsOf(set)) {
        const key = JSON.stringify([unit.unit, unit.p]);
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      return [...seen.values()].filter((n) => n > 1).length;
    },
    matchedOf(key, names) {
      const wanted = new Set(names);
      const units = new Map<number, Set<string>>();
      for (const row of placedOf([]).rows) {
        const name = row.fact === null ? undefined : fetch.value(row.fact, key);
        if (name !== undefined && wanted.has(name)) units.set(name, (units.get(name) ?? new Set()).add(row.unit));
      }
      return [...units].map(([name, each]) => ({ name, value: fetch.spelled(name), n: each.size }));
    },
    inPlace(ids) {
      const wanted = new Set(ids);
      const days = isDays ? new Set(placeDaysOf(presence!, ids, calendar.from, calendar.to, settings).days.keys()) : undefined;
      const units = new Set<string>();
      for (const row of placedOf([]).rows) {
        if (days !== undefined ? days.has(row.unit) : row.fact !== null && areasOf(row.fact).some((id) => wanted.has(id))) units.add(row.unit);
      }
      return units.size;
    },
    coversOf() {
      const last = new Map<string, string>();
      for (const row of placedOf([]).rows) {
        const source = row.fact?.source ?? "";
        if (source !== "" && (last.get(source) ?? "") < row.fact!.day) last.set(source, row.fact!.day);
      }
      return [...last].sort(([left], [right]) => (left < right ? -1 : 1)).map(([source, day]) => ({ source, last: day }));
    },
    edges: () => ask.measure === undefined && admitted.place === undefined && ask.at_least === undefined && ask.at_most === undefined
      ? talliesOf(fetch, ask, context, admitted, range).edges()
      : edgesOf(fetch, filterOf(ask.of, admitted), (fact, f) => keeps(fact, { words: false, bounds: true }, f) && (ask.measure === undefined || f.measure(fact, ask.measure) !== null)),
    items(after, limit) {
      const items = new Map<string, Item>();
      for (const row of placedOf([]).rows) {
        const key = JSON.stringify([row.unit, row.p, row.fact?.id ?? null]);
        const item = items.get(key);
        if (item === undefined) {
          items.set(key, { unit: row.unit, p: row.p, fact: row.fact?.id ?? null, t: row.t, d: row.day, v: row.fact === null || ask.measure === undefined ? null : fetch.measure(row.fact, ask.measure) });
          continue;
        }
        if (row.t !== null && (item.t === null || order(row.t, item.t) < 0)) item.t = row.t;
        if (row.day < item.d) item.d = row.day;
      }
      const byTime = (left: Item, right: Item) => order(left.t, right.t) || order(left.unit, right.unit) || order(left.fact, right.fact);
      const byValue = (left: Item, right: Item) => (partitionKey === "currency" ? order(left.p, right.p) : 0)
        || (left.v === null ? 1 : 0) - (right.v === null ? 1 : 0) || (left.v !== null && right.v !== null ? right.v - left.v : 0) || byTime(left, right);
      const by = ask.order === "value" ? byValue : byTime;
      const sorted = [...items.values()].sort(by);
      const start = after === undefined ? 0 : sorted.findIndex((item) => by(item, after) > 0);
      return start < 0 ? [] : sorted.slice(start, start + limit);
    },
    unvalued() {
      const units = new Map<string, { p: string | null; unit: string; valued: boolean }>();
      for (const row of placedOf([]).rows) {
        const key = JSON.stringify([row.p, row.unit]);
        const unit = units.get(key) ?? { p: row.p, unit: row.unit, valued: false };
        unit.valued ||= row.value !== null;
        units.set(key, unit);
      }
      return [...units.values()].filter((unit) => !unit.valued).sort((left, right) => order(left.unit, right.unit)).map(({ p, unit }) => ({ p, unit }));
    },
    bounded(withBounds) {
      const { rows } = placedOf([], rowsOf(true, withBounds), false);
      const units = new Set<string>(), valued = new Set<string>();
      for (const row of rows) {
        units.add(row.unit);
        if (row.fact !== null && fetch.measure(row.fact, ask.measure!) !== null) valued.add(row.unit);
      }
      return { n: units.size, valued: valued.size };
    },
    wordless() {
      const no = (fact: Fact) => fetch.text(fact, "searchable") === "no";
      return windowFacts().filter((fact) => ranged(fact) && no(fact) && keeps(fact, { words: false, bounds: true })).length;
    },
  };

}

function emptyPopulation(measure: Measure | undefined, partitionKey: string | undefined, calendar: { from: string; to: string }, isRun: boolean): Population {
  return {
    ...(measure === undefined ? {} : { measure }), ...(partitionKey === undefined ? {} : { partitionKey }), ...(isRun ? { runs: { rows: new Map(), of: new Map() } } : {}),
    calendar,
    groupsOf: () => [],
    extremesOf: () => new Map(),
    overlapOf: () => 0,
    matchedOf: () => [],
    inPlace: () => 0,
    coversOf: () => [],
    edges: () => ({}),
    items: () => [],
    unvalued: () => [],
    bounded: () => ({ n: 0, valued: 0 }),
    wordless: () => 0,
  };
}

function once<T>(make: () => T): () => T {
  let made: { value: T } | undefined;
  return () => (made ??= { value: make() }).value;
}

export function rangeOf(ask: CountAsk, context: CountContext): Range {
  const { settings } = context;
  const edge = (value: string, end: boolean): { day: string; ms: number } => {
    const time = readTime(end ? "to" : "from", value, settings);
    if (time.day) return { day: value, ms: end ? time.end_ms : time.start_ms };
    return { day: civilDay(end ? time.start_ms - 1 : time.start_ms, settings), ms: time.start_ms };
  };
  const from = ask.from === undefined ? undefined : edge(ask.from, false);
  const today = civilDay(context.now_ms, settings);
  const to = ask.to === undefined ? { day: today, ms: dayBounds(today, settings).end_ms } : edge(ask.to, true);
  if (from !== undefined && to.ms <= from.ms) bad("to is not before from");
  return { ...(from === undefined ? {} : { fromDay: from.day, from_ms: from.ms }), toDay: to.day, to_ms: to.ms };
}

function calendarEdges(settings: DaySettings): readonly [number, number] {
  return [Math.max(Date.UTC(1000, 0, 1), dayBounds("1000-01-01", settings).start_ms), Math.min(Date.UTC(10_000, 0, 1), dayBounds("9999-12-31", settings).end_ms)];
}

export interface FetchWindow {
  from_ms: number;
  to_ms: number;
  fromDay?: string;
  toDay: string;
}

function windowOver(range: Range, span: number, settings: DaySettings): FetchWindow {
  const [low, high] = calendarEdges(settings);
  const from_ms = range.from_ms === undefined ? undefined : Math.max(low, range.from_ms - span);
  const to_ms = Math.min(high, range.to_ms + span);
  return { from_ms: from_ms ?? -Number.MAX_SAFE_INTEGER, to_ms, ...from_ms === undefined ? {} : { fromDay: civilDay(from_ms, settings) }, toDay: civilDay(to_ms - 1, settings) };
}

function widens(ask: CountAsk, context: CountContext): boolean {
  const measure = ask.measure === undefined ? undefined : context.collections.get(ask.of)?.measures[ask.measure];
  return ask.of !== "days" && ((ask.op === "sum" && measure?.split === "clock") || ask.by.filter((key) => key !== "item")[0] === "run");
}

export function windowOf(read: FactsRead, ask: CountAsk, context: CountContext, range: Range = rangeOf(ask, context)): FetchWindow {
  return windowOver(range, widens(ask, context) ? longestOf(read, ask.of) : 0, context.settings);
}


function chosen(read: FactsRead, fetch: Fetch, ask: CountAsk, context: CountContext, admitted: Admitted, scope: Scope | undefined): Population {
  if (admitted.words !== undefined && !admitted.words.end.whole) throw new Stopped(sideOf(ask), undefined, admitted.words.end);
  if (nothingAdmitted(admitted)) return populationOver(read, fetch, ask, context, admitted, ask.measure, scope);
  if (talliable(ask, context, admitted, scope)) return tallyPopulation(fetch, ask, context, admitted, rangeOf(ask, context));
  const facts = populationOver(read, fetch, ask, context, admitted, ask.measure, scope);
  if (admitted.words === undefined) return facts;
  const { words: _words, measure: _measure, ...rest } = ask;
  const { words: _admitted, ...others } = admitted;
  const bare: CountAsk = { ...rest, op: "count", by: [] };
  if (!talliable(bare, context, others, undefined)) return facts;
  return { ...facts, wordless: () => tallyPopulation(fetch, bare, context, others, rangeOf(bare, context)).wordless() };
}

function talliable(ask: CountAsk, context: CountContext, admitted: Admitted, scope: Scope | undefined): boolean {
  if (ask.of === "" || ask.of === "days" || ask.op !== "count" || ask.measure !== undefined || scope !== undefined) return false;
  if (ask.words !== undefined || admitted.words !== undefined || ask.place !== undefined || admitted.place !== undefined || ask.at_least !== undefined || ask.at_most !== undefined) return false;
  const whole = (value: string | undefined) => value === undefined || /^\d{4}-\d{2}-\d{2}$/u.test(value);
  if (!whole(ask.from) || !whole(ask.to)) return false;
  const keys = context.collections.get(ask.of)!.keys;
  return ask.by.every((key) => (TIME_KEYS as readonly string[]).includes(key) || key === "person" || keys.includes(key));
}

type Need = "n" | "day" | "keys" | "cell";

interface ChosenFilter {
  of: string;
  in: { key: string; names: readonly number[] }[];
  out: { key: string; names: readonly number[] }[];
  handles?: readonly string[];
  none: boolean;
}

class Chosen {
  #combos: { set: Set<number> | null | undefined } | undefined;
  #excluded: Set<number> | undefined;
  #crews: { set: Set<number> | null | undefined } | undefined;

  constructor(private readonly fetch: Fetch, private readonly filter: ChosenFilter) {}

  get empty(): boolean {
    return this.filter.none || this.#allowed() === null || this.#crewSet() === null;
  }

  walks(): Walks {
    if (this.empty) return "none";
    const allowed = this.#allowed(), crews = this.#crewSet();
    if (allowed !== undefined && allowed !== null && (crews === undefined || crews === null || allowed.size <= crews.size)) return { combos: [...allowed] };
    if (crews !== undefined && crews !== null) return { crews: [...crews] };
    return "all";
  }

  keeps(combo: number, crew: number): boolean {
    const allowed = this.#allowed(), crews = this.#crewSet();
    if (this.filter.none || allowed === null || crews === null) return false;
    if (allowed !== undefined && !allowed.has(combo)) return false;
    if (crews !== undefined && !crews.has(crew)) return false;
    return !this.#excludedSet().has(combo);
  }

  #allowed(): Set<number> | null | undefined {
    if (this.#combos !== undefined) return this.#combos.set;
    let kept: Set<number> | undefined;
    for (const { key, names } of this.filter.in) {
      const found = new Set(this.#combosOf(key, names));
      kept = kept === undefined ? found : new Set([...kept].filter((combo) => found.has(combo)));
    }
    this.#combos = { set: kept === undefined ? undefined : kept.size === 0 ? null : kept };
    return this.#combos.set;
  }

  #excludedSet(): Set<number> {
    return this.#excluded ??= new Set(this.filter.out.flatMap(({ key, names }) => this.#combosOf(key, names)));
  }

  #combosOf(key: string, names: readonly number[]): number[] {
    return names.flatMap((name) => this.fetch.combosOf(this.filter.of, key, name));
  }

  #crewSet(): Set<number> | null | undefined {
    if (this.#crews !== undefined) return this.#crews.set;
    const handles = this.filter.handles;
    if (handles === undefined) return (this.#crews = { set: undefined }).set;
    const crews = new Set(handles.flatMap((handle) => this.fetch.crewsOf(handle)));
    this.#crews = { set: crews.size === 0 ? null : crews };
    return this.#crews.set;
  }
}

class Tallies {
  readonly chosen: Chosen;
  readonly #cells = new Map<string, TallyCell[]>();
  readonly #persons = new Map<number, string[]>();
  readonly #handles = new Map<string, string>();
  #everyDay: boolean | undefined;

  constructor(
    private readonly fetch: Fetch, private readonly filter: ChosenFilter, private readonly range: { fromDay?: string; toDay: string }, private readonly personOf: (handle: string) => string,
    private readonly tells = false,
  ) {
    this.chosen = new Chosen(fetch, filter);
  }

  get empty(): boolean {
    return this.chosen.empty;
  }

  keeps(combo: number, crew: number): boolean {
    return this.chosen.keeps(combo, crew);
  }

  cells(need: Need): TallyCell[] {
    const walks = this.chosen.walks();
    if (walks === "none") return [];
    const unfiltered = walks === "all" && this.filter.out.length === 0;
    const read = (need === "n" || need === "day") && unfiltered ? "days" : (need === "n" || need === "keys") && unfiltered && this.everyDay() ? "kept" : "tally";
    const held = this.#cells.get(read);
    if (held !== undefined) return held;
    const cells = this.#read(read, walks);
    this.#cells.set(read, cells);
    return cells;
  }

  #read(read: "days" | "kept" | "tally", walks: Exclude<Walks, "none">): TallyCell[] {
    const { of } = this.filter;
    const from = this.range.fromDay ?? "", to = this.range.toDay;
    const keep = read === "days" ? undefined : (cell: TallyCell) => this.keeps(cell.combo, cell.crew);
    if (read === "kept" && this.fetch.gated) return this.fetch.allowedKept(of, keep!, this.tells);
    let cells: TallyCell[];
    if (read === "days") cells = this.fetch.cells("days", of, from, to);
    else if (read === "kept") cells = this.fetch.kept(of);
    else if (walks !== "all" && "combos" in walks) cells = walks.combos.flatMap((combo) => this.fetch.cells("combo", of, from, to, combo));
    else if (walks !== "all") cells = walks.crews.flatMap((crew) => this.fetch.cells("crew", of, from, to, crew));
    else cells = this.fetch.cells("all", of, from, to);
    if (this.fetch.gated) return this.fetch.allowedCells(of, cells, keep, this.tells);
    return keep === undefined ? cells : cells.filter(keep);
  }

  edges(): Edges {
    if (this.filter.none) return {};
    if (this.fetch.proving) return { unknown: true };
    const end = (side: Side) => new Tallies(this.fetch.held(side), this.filter, this.range, this.personOf).edge(side);
    try {
      const first = end("oldest");
      const last = first === undefined ? undefined : end("newest");
      return first === undefined || last === undefined ? {} : { first, last };
    } catch (error) {
      if (error instanceof Stopped) return { unknown: true };
      throw error;
    }
  }

  edge(side: Side): string | undefined {
    const walks = this.chosen.walks();
    if (walks === "none") return undefined;
    const { of } = this.filter;
    const keep = (cell: TallyCell) => this.keeps(cell.combo, cell.crew);
    const days = walks !== "all" && "combos" in walks ? walks.combos.map((combo) => this.fetch.cellEdge("combo", of, keep, combo))
      : walks !== "all" ? walks.crews.map((crew) => this.fetch.cellEdge("crew", of, keep, crew))
      : this.filter.out.length === 0 ? [this.fetch.gated ? this.fetch.cellEdge("days", of, () => true) : this.fetch.edgeDay(of, side)] : [this.fetch.cellEdge("all", of, keep)];
    const held = days.filter((day): day is string => day !== undefined).sort();
    return side === "oldest" ? held[0] : held.at(-1);
  }

  everyDay(): boolean {
    if (this.#everyDay === undefined) {
      const first = this.fetch.heldDay(this.filter.of, "oldest");
      const last = first === undefined ? undefined : this.fetch.heldDay(this.filter.of, "newest");
      this.#everyDay = first === undefined || ((this.range.fromDay ?? "") <= first && last! <= this.range.toDay);
    }
    return this.#everyDay;
  }

  valueOf(combo: number, key: string): number | undefined {
    return this.fetch.keys(combo).get(key);
  }

  spelled(name: number): string {
    return this.fetch.spelled(name);
  }

  personsOf(crew: number): string[] {
    let persons = this.#persons.get(crew);
    if (persons === undefined) {
      persons = [...new Set(this.fetch.handles(crew).map((handle) => {
        let person = this.#handles.get(handle);
        if (person === undefined) this.#handles.set(handle, person = this.personOf(handle));
        return person;
      }))].sort();
      this.#persons.set(crew, persons);
    }
    return persons;
  }
}

function filterOf(of: string, admitted: Pick<Admitted, "kept" | "values" | "chat">): ChosenFilter {
  const { handles } = admitted.kept;
  const values = Object.entries(admitted.values);
  return {
    of,
    in: [...values.flatMap(([key, { in: kept }]) => (kept === undefined ? [] : [{ key, names: kept }])), ...admitted.chat === undefined ? [] : [{ key: "chat", names: admitted.chat }]],
    out: values.flatMap(([key, { out }]) => (out.length === 0 ? [] : [{ key, names: out }])),
    ...(handles === undefined ? {} : { handles }),
    none: (handles !== undefined && handles.length === 0) || values.some(([, { in: kept }]) => kept !== undefined && kept.length === 0)
      || (admitted.chat !== undefined && admitted.chat.length === 0),
  };
}

function narrowedTo(read: FactsRead, ask: CountAsk, context: CountContext, admitted: Admitted, scope: Scope | undefined, range: Range, partitionKey: string | undefined): { filter: ChosenFilter; range: Range } {
  const filter = filterOf(ask.of, admitted);
  const groupBy = ask.by.filter((key) => key !== "item");
  if (scope === undefined || "u" in scope || ask.of === "days" || groupBy[0] === "run") return { filter, range };
  const keys = context.collections.get(ask.of)!.keys;
  const stated: [key: string, value: string][] = [];
  const p = "t" in scope ? scope.t.p : scope.p;
  if (partitionKey !== undefined && p !== null && keys.includes(partitionKey)) stated.push([partitionKey, p]);
  let handles = filter.handles;
  let timed = false;
  let { from_ms, to_ms } = { from_ms: range.from_ms ?? -Number.MAX_SAFE_INTEGER, to_ms: range.to_ms };
  if ("g" in scope && scope.g.length === groupBy.length) {
    for (const [at, key] of groupBy.entries()) {
      const value = scope.g[at];
      if (value === null || value === undefined) continue;
      if (key === "person") {
        handles = isHeld(value) ? value.handles : peopleOrRefuse(context).person(String(value))?.handles ?? [String(value)];
      } else if (key === "day" || key === "week" || key === "month" || key === "year") {
        const [first, last] = unitDays(key, String(value));
        timed = true;
        from_ms = Math.max(from_ms, dayBounds(first, context.settings).start_ms);
        to_ms = Math.min(to_ms, dayBounds(last, context.settings).end_ms);
      } else if (key !== partitionKey && keys.includes(key)) {
        stated.push([key, String(value)]);
      }
    }
  }
  const work = read.work.beside(stated.length + 1);
  const joined = stated.map(([key, value]) => ({ key, names: [read.point<{ id: number }>(VALUE_NAMED, [value], work)?.id].filter((id): id is number => id !== undefined) }));
  if (to_ms < from_ms) to_ms = from_ms;
  const { settings } = context;
  return {
    filter: {
      ...filter, in: [...filter.in, ...joined], ...(handles === undefined ? {} : { handles }),
      none: filter.none || joined.some(({ names }) => names.length === 0) || handles?.length === 0,
    },
    range: !timed ? range : { ...(from_ms === -Number.MAX_SAFE_INTEGER ? {} : { from_ms, fromDay: civilDay(from_ms, settings) }), to_ms, toDay: civilDay(to_ms - 1, settings) },
  };
}

function talliesOf(fetch: Fetch, ask: CountAsk, context: CountContext, admitted: Pick<Admitted, "kept" | "values" | "chat">, range: Range, tells = false): Tallies {
  let people: PeopleMap | undefined;
  return new Tallies(fetch, filterOf(ask.of, admitted), { ...(range.fromDay === undefined ? {} : { fromDay: range.fromDay }), toDay: range.toDay }, (handle) => {
    people ??= peopleOrRefuse(context);
    return people.idOf(handle) ?? handle;
  }, tells);
}

function tallyPopulation(fetch: Fetch, ask: CountAsk, context: CountContext, admitted: Pick<Admitted, "kept" | "values" | "chat">, range: Range): Population {
  const tallies = talliesOf(fetch, ask, context, admitted, range, true);
  const isTime = (key: string) => (TIME_KEYS as readonly string[]).includes(key);
  const cellsFor = (set: readonly string[]) => tallies.cells(tallyNeed(set, ask));
  const factsOnly = (): never => {
    throw new Error("a count from the tallies reads no fact");
  };
  const edges = once(() => tallies.edges());
  return {
    groupsOf(set) {
      const groups = new Map<string, Group>();
      const at = set.indexOf("person");
      for (const cell of cellsFor(set)) {
        const base: Raw[] = set.map((key) => {
          if (isTime(key)) return timeKeyOf(key, cell.day);
          if (key === "person") return null;
          const name = tallies.valueOf(cell.combo, key);
          return name === undefined ? null : tallies.spelled(name);
        });
        for (const person of at < 0 ? [null] : tallies.personsOf(cell.crew)) {
          const values = at < 0 ? base : base.map((value, index) => (index === at ? person : value));
          const key = groupKey(values, null);
          const group = groups.get(key);
          if (group === undefined) groups.set(key, { keys: values, partition: null, n: cell.n, valued: 0, value: null, t: cell.t });
          else {
            group.n += cell.n;
            if (cell.t !== null && (group.t === null || cell.t < (group.t as number))) group.t = cell.t;
          }
        }
      }
      return [...groups.values()];
    },
    overlapOf: (set) => (!set.includes("person") ? 0 : cellsFor(set).reduce((sum, cell) => sum + (tallies.personsOf(cell.crew).length > 1 ? cell.n : 0), 0)),
    matchedOf(key, names) {
      const wanted = new Set(names);
      const counts = new Map<number, number>();
      for (const cell of cellsFor([key])) {
        const name = tallies.valueOf(cell.combo, key);
        if (name !== undefined && wanted.has(name)) counts.set(name, (counts.get(name) ?? 0) + cell.n);
      }
      return [...counts].map(([name, n]) => ({ name, value: tallies.spelled(name), n }));
    },
    coversOf() {
      const last = new Map<string, string>();
      for (const cell of tallies.cells("day")) if (cell.source !== "" && (last.get(cell.source) ?? "") < cell.day) last.set(cell.source, cell.day);
      return [...last].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([source, day]) => ({ source, last: day }));
    },
    edges,
    bounded: () => {
      const n = tallies.cells("n").reduce((sum, cell) => sum + cell.n, 0);
      return { n, valued: n };
    },
    wordless() {
      const no = fetch.named("no");
      const asked = admitted.values.searchable;
      const kept = no === undefined || (asked?.in !== undefined && !asked.in.includes(no)) ? [] : [no];
      const none = talliesOf(fetch, ask, context, { ...admitted, values: { ...admitted.values, searchable: { in: kept, out: asked?.out ?? [] } } }, range);
      return none.cells("n").reduce((sum, cell) => sum + cell.n, 0);
    },
    extremesOf: factsOnly, inPlace: factsOnly, items: factsOnly, unvalued: factsOnly,
  };
}

function tallyNeed(set: readonly string[], ask: CountAsk): Need {
  const isTime = (key: string) => (TIME_KEYS as readonly string[]).includes(key);
  return set.length === 0 ? "n" : set.every(isTime) ? "day" : set.some(isTime) || ask.order === "time" ? "cell" : "keys";
}

export interface Edges {
  first?: string;
  last?: string;
  unknown?: true;
}

function edgesOf(fetch: Fetch, filter: ChosenFilter, keep: (fact: Fact, fetch: Fetch) => boolean): Edges {
  if (fetch.proving) return { unknown: true };
  const end = (side: Side) => {
    const held = fetch.held(side);
    try {
      return held.edge(filter.of, keep, new Chosen(held, filter).walks());
    } catch (error) {
      if (error instanceof Stopped) return "unknown";
      throw error;
    }
  };
  const first = end("oldest");
  if (first === "unknown") return { unknown: true };
  if (first === undefined) return {};
  const last = end("newest");
  if (last === "unknown") return { unknown: true };
  return last === undefined ? {} : { first: first.day, last: last.day };
}

function excludedOf(ask: CountAsk, context: CountContext, admitted: Admitted, population: Population): Record<string, number> {
  const excluded: Record<string, number> = {};
  if (nothingAdmitted(admitted)) return excluded;
  if (ask.at_least !== undefined || ask.at_most !== undefined) {
    const base = population.bounded(false), kept = population.bounded(true);
    if (base.n - base.valued > 0) excluded[`no ${ask.measure}`] = base.n - base.valued;
    if (base.valued - kept.n > 0) excluded[`${ask.measure} outside the bounds`] = base.valued - kept.n;
  }
  if (ask.words !== undefined && context.collections.get(ask.of)!.keys.includes("searchable")) {
    const none = population.wordless();
    if (none > 0) excluded["no words"] = none;
  }
  return excluded;
}


export function walkRangeOf(range: Range): WalkRange {
  return { ...(range.from_ms === undefined ? {} : { from_ms: range.from_ms }), to_ms: range.to_ms };
}

function wholeTo(range: Range, settings: DaySettings): string {
  return range.to_ms === dayBounds(range.toDay, settings).end_ms ? range.toDay : addDays(range.toDay, -1);
}

function wordsFit(range: Range, first: string, end: { from: number } | { to: number }, settings: DaySettings): { from: string; to: string } | undefined {
  const last = wholeTo(range, settings);
  if (first > last) return undefined;
  if ("to" in end) {
    let found: string | undefined;
    for (let day = first; day <= last; day = addDays(day, 1)) {
      if (dayBounds(day, settings).end_ms > end.to) break;
      found = day;
    }
    return found === undefined ? undefined : { from: first, to: found };
  }
  const { from } = end;
  if (from >= walkRangeOf(range).to_ms) return undefined;
  for (let day = civilDay(Math.max(from, Date.parse("1970-01-01T00:00:00Z")), settings); day <= last; day = addDays(day, 1)) {
    if (day < first) continue;
    if (dayBounds(day, settings).start_ms >= from) return { from: day, to: last };
  }
  return undefined;
}

export function wordsBudget(context: CountContext, passages: boolean): number {
  return context.budget?.words ?? (passages ? WORDS_ROWS / 2 : WORDS_ROWS);
}

export function sideOf(ask: CountAsk): Side {
  return ask.op === "first" ? "oldest" : "newest";
}

const PROOFS = 6;

function provenOver(admitted: Admitted, range: Range): Admitted {
  const { words } = admitted;
  if (words === undefined) return admitted;
  const window = walkRangeOf(range);
  const kept = words.in?.filter((fact) => (words.slots?.[fact] ?? []).some((slot) => reaches(slot, window, words.slack)));
  return { ...admitted, words: { ...words, ...(kept === undefined ? {} : { in: kept }), end: { whole: true } } };
}

export interface CountRun {
  readonly ask: CountAsk;
  readonly admitted: Admitted;
  readonly proving: boolean;
  populationOf(scope?: Scope): Population;
  factRows(scope?: Scope): Population;
  readingOf(measure: string, scope: Scope | undefined, runs: Runs | undefined): Population;
  factsShown(ids: readonly string[]): Map<string, FactShown>;
  excludedOf(population: Population): Record<string, number>;
  stated(measures: readonly string[]): Map<string, Stated> | "unknown";
  days(of: string): { first: string; last: string } | undefined;
  firstHeld(): string | undefined;
}

function runOf(read: FactsRead, fetch: Fetch, ask: CountAsk, context: CountContext, admitted: Admitted): CountRun {
  return {
    ask, admitted, proving: fetch.proving,
    populationOf: (scope) => chosen(read, fetch, ask, context, admitted, scope),
    factRows: (scope) => populationOver(read, fetch, ask, context, admitted, ask.measure, scope),
    readingOf: (measure, scope, runs) => populationOver(read, fetch, ask, context, admitted, measure, scope, runs),
    factsShown: (ids) => factsShown(fetch, ids),
    excludedOf: (population) => excludedOf(ask, context, admitted, population),
    stated: (measures) => statedOver(fetch, measures),
    days: (of) => (context.gate === undefined ? collectionDays(read, of) : allowedDays(fetch, of)),
    firstHeld: () => firstHeldOf(read, fetch, context),
  };
}

export function countWhole<T>(read: FactsRead, ask: CountAsk, context: CountContext, admission: Admission, show: (run: CountRun) => T): T {
  const admitted = admittedIn(read, context, admission);
  const budget = context.budget?.fetch ?? FETCH_ROWS;
  const ledger = new Ledger(read, read.work.beside(ceilingOf(budget)), context.gate);
  const attempt = (asked: CountAsk): T => show(runOf(read, ledger.fetch(budget, sideOf(asked), asked !== ask), asked, context, asked === ask ? admitted : provenOver(admitted, rangeOf(asked, context))));
  let stopped: Stopped;
  try {
    return attempt(ask);
  } catch (error) {
    if (!(error instanceof Stopped)) throw error;
    stopped = error;
  }
  const first = stopped;
  let range = rangeOf(ask, context);
  let fits: { from: string; to: string } | undefined;
  for (let proof = 0; proof < PROOFS && ask.cursor === undefined; proof++) {
    const candidate = fitsAfter(read, ask, context, range, stopped);
    if (candidate === undefined) break;
    const within: CountAsk = { ...ask, from: candidate.from, to: candidate.to };
    try {
      attempt(within);
      fits = candidate;
      break;
    } catch (error) {
      if (error instanceof Refusal) break;
      if (!(error instanceof Stopped)) throw error;
      stopped = error;
      range = rangeOf(within, context);
    }
  }
  return tooBroad(ask, context, first, fits, budget);
}

function fitsAfter(read: FactsRead, ask: CountAsk, context: CountContext, range: Range, stopped: Stopped): { from: string; to: string } | undefined {
  const { settings } = context;
  const last = wholeTo(range, settings);
  const first = range.fromDay === undefined ? firstDay(read) ?? range.toDay : range.from_ms === dayBounds(range.fromDay, settings).start_ms ? range.fromDay : addDays(range.fromDay, 1);
  if (stopped.words !== undefined) return "untimed" in stopped.words ? undefined : wordsFit(range, first, stopped.words, settings);
  if (first > last) return undefined;
  const newest = stopped.side === "newest";
  const halved = (): { from: string; to: string } | undefined => {
    let days = 0;
    for (let day = first; day <= last && days < 2; day = addDays(day, 1)) days++;
    if (days < 2) return undefined;
    const half = Math.max(1, Math.floor(((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / DAY_MS + 1) / 2));
    return newest ? { from: addDays(last, -(half - 1)), to: last } : { from: first, to: addDays(first, half - 1) };
  };
  const { at } = stopped;
  if (at === undefined) return halved();
  const span = widens(ask, context) ? longestOf(read, ask.of) : 0;
  const windowOf = (from: string, to: string) => windowOver({ fromDay: from, from_ms: dayBounds(from, settings).start_ms, toDay: to, to_ms: dayBounds(to, settings).end_ms }, span, settings);
  let found: { from: string; to: string } | undefined;
  const dayAt = (ms: number) => civilDay(Math.min(Math.max(ms, dayBounds(first, settings).start_ms), dayBounds(last, settings).end_ms - 1), settings);
  if (newest) {
    const done = (day: string) => ("day" in at ? day > at.day : windowOf(day, last).from_ms > at.ms);
    let day = "day" in at ? addDays(at.day, 1) : dayAt(at.ms);
    if (day < first) day = first;
    while (day <= last && !done(day)) day = addDays(day, 1);
    if (day <= last) found = { from: day, to: last };
  } else {
    const done = (day: string) => ("day" in at ? day < at.day : windowOf(first, day).to_ms <= at.ms);
    let day = "day" in at ? addDays(at.day, -1) : dayAt(at.ms - 1);
    if (day > last) day = last;
    while (day >= first && !done(day)) day = addDays(day, -1);
    if (day >= first) found = { from: first, to: day };
  }
  return found === undefined || (found.from === first && found.to === last) ? halved() : found;
}

function tooBroad(ask: CountAsk, context: CountContext, stopped: Stopped, fits: { from: string; to: string } | undefined, budget: number): never {
  const { of } = ask;
  const collection = context.collections.get(of);
  if (stopped.words !== undefined) {
    const more = "more words, each of which must appear, or rarer ones";
    const narrower = ask.chat === undefined && collection?.keys.includes("chat") === true ? `ask in one chat, or with ${more}` : `ask with ${more}`;
    const then = stopped.side === "oldest" ? "the days after it if none is there" : "the days before it";
    const said = fits !== undefined ? `the words match too much of ${of} to count in one call: ask from=${fits.from} to=${fits.to}, then ${then}, or ${narrower}`
      : "untimed" in stopped.words ? `the words are too common among the entries with no time to count ${of} in one call: ${narrower}`
        : `not one day of the words' matches fits one call's count of ${of}: ${narrower}`;
    return refused("TOO_BROAD", said, fits === undefined ? {} : { fits });
  }
  const read = `this count reads past ${budget} rows of the index`;
  const said = fits === undefined ? `${read}, and not one day of it fits one call: narrow by a filter, a chat or more words`
    : stopped.side === "oldest" ? `${read}: the first is in the oldest days: ask from=${fits.from} to=${fits.to}, then the days after it if none is there, or a filter that keeps fewer of its facts`
      : `${read}: ask from=${fits.from} to=${fits.to}, then the days before it, or a filter that keeps fewer of its facts`;
  const clock = ask.op === "sum" && ask.measure !== undefined && collection?.measures[ask.measure]?.split === "clock";
  const days = clock && ask.place !== undefined && of !== "days" ? "; or, for how long there, its days: of=days with the same place, by=run" : "";
  return refused("TOO_BROAD", `${said}${days}`, fits === undefined ? {} : { fits });
}

function nothingAdmitted(admitted: Admitted): boolean {
  return (admitted.kept.handles !== undefined && admitted.kept.handles.length === 0) || Object.values(admitted.values).some(({ in: kept }) => kept !== undefined && kept.length === 0)
    || (admitted.chat !== undefined && admitted.chat.length === 0) || (admitted.place?.in !== undefined && admitted.place.in.length === 0);
}


export interface Clauses {
  words?: Phrases[];
  who?: string[];
  chats?: string[];
  from_ms?: number;
  to_ms: number;
}

export interface Reached {
  family: string;
  n: number;
  first?: string;
  last?: string;
  capped: boolean;
}

export const ASK_PRODUCT = "ask";

export function reached(read: RecordRead, clauses: Clauses, families: readonly string[], excluded: readonly string[], gate?: SearchGate): Reached[] | "unread" {
  const left = new Set(excluded);
  const looked = families.filter((family) => !left.has(family));
  if (looked.length === 0) return [];
  const terms: Term[] | undefined = clauses.words?.flatMap((group) => group.phrases.map((text, at) => ({ text, quoted: true, negated: group.negated, or: !group.negated && at > 0, at: 0, exact: true })));
  let found: SearchAnswer;
  try {
    found = read.search({
      ...terms === undefined ? {} : { terms }, ...clauses.who === undefined ? {} : { who: clauses.who }, ...clauses.chats === undefined ? {} : { chats: clauses.chats },
      families: looked, notProducts: [ASK_PRODUCT], ...clauses.from_ms === undefined ? {} : { from_ms: clauses.from_ms },
      to_ms: clauses.to_ms, group: ["family", "day"], order: "newest", limit: 1, ...(gate === undefined ? {} : { gate }),
    });
  } catch (error) {
    if (error instanceof Refusal) return "unread";
    throw error;
  }
  if (!("groups" in found)) return "unread";
  const byFamily = new Map<string, Reached>();
  for (const { key, n } of found.groups) {
    if (!Array.isArray(key)) continue;
    const [family, day] = key;
    const each = byFamily.get(family) ?? { family, n: 0, capped: found.capped };
    each.n += n;
    if (/^\d{4}-\d{2}-\d{2}$/u.test(day)) {
      if (each.first === undefined || day < each.first) each.first = day;
      if (each.last === undefined || day > each.last) each.last = day;
    }
    byFamily.set(family, each);
  }
  return [...byFamily.values()].filter((each) => each.n > 0).sort((a, b) => b.n - a.n || (a.family < b.family ? -1 : 1));
}


export const PEOPLE_ROWS = 100_000;

export type Subject = { person: string; handles: readonly string[] } | { chat: string };

export type Reach = Record<string, [n: number, first: string, last: string]>;

export interface PeopleCollections {
  person: readonly string[];
  chat: readonly string[];
}

type Sized = { n: number; first: string; last: string } | null | "capped";

interface Counted {
  n: number;
  reach: Reach;
  chats: { chat: string; messages: number }[];
  handles?: string[];
}

export class PeopleCounts {
  readonly #read: FactsRead;
  readonly #context: CountContext;
  readonly #collections: PeopleCollections;
  readonly #today: string;
  readonly #real: Work;
  readonly #fetch: Fetch;
  #out = false;
  readonly #crews = new Map<string, number[]>();
  readonly #pairs = new Map<string, Total[]>();
  readonly #combos = new Map<string, number[]>();
  readonly #subjects = new Map<string, Counted>();

  constructor(read: FactsRead, context: CountContext, collections: PeopleCollections, budget: number = PEOPLE_ROWS) {
    this.#read = read;
    this.#context = context;
    this.#collections = collections;
    this.#today = civilDay(context.now_ms, context.settings);
    this.#real = read.work.beside(budget);
    this.#fetch = new Ledger(read, this.#real, context.gate).fetch(budget, "newest");
  }

  get capped(): boolean {
    return this.#out;
  }

  get spent(): number {
    return this.#real.spent;
  }

  touch(subjects: readonly Subject[]): (number | undefined)[] {
    return subjects.map((subject) => this.#subject(subject)?.n);
  }

  reach(subject: Subject): { reach: Reach; chats: { chat: string; messages: number }[]; handles?: string[] } | undefined {
    const counted = this.#subject(subject);
    return counted === undefined ? undefined : { reach: counted.reach, chats: counted.chats, ...(counted.handles === undefined ? {} : { handles: counted.handles }) };
  }

  size(ask: CountAsk, admit: (read: FactsRead) => Admission): Sized {
    const sized = this.#counted(() => {
      const admitted = admittedIn(this.#metered(), this.#context, admit(this.#metered()), this.#real);
      if (nothingAdmitted(admitted)) return null;
      const population = chosen(this.#read, this.#fetch, { ...ask, by: [] }, this.#context, admitted, undefined);
      const n = population.groupsOf([]).reduce((sum, group) => sum + group.n, 0);
      if (n === 0) return null;
      const days = population.groupsOf(["day"]).map((group) => String(group.keys[0])).sort();
      return { n, first: days[0]!, last: days.at(-1)! };
    });
    return sized === undefined ? "capped" : sized;
  }

  #subject(subject: Subject): Counted | undefined {
    const key = JSON.stringify(subject);
    const kept = this.#subjects.get(key);
    if (kept !== undefined) return kept;
    const counted = this.#counted(() => {
      const reach: Reach = {};
      for (const of of this.#of(subject)) {
        const summed = this.#summed(this.#pairsOf(of, subject));
        if (summed !== undefined) reach[of] = summed;
      }
      const n = Object.values(reach).reduce((sum, [each]) => sum + each, 0);
      if ("chat" in subject) return { n, reach, chats: this.#collections.chat.includes("messages") ? [{ chat: subject.chat, messages: reach.messages?.[0] ?? 0 }] : [] };
      const byChat = new Map<string, number>();
      if (this.#collections.chat.includes("messages") && this.#collections.person.includes("messages")) {
        for (const pair of this.#pairsOf("messages", subject)) {
          const name = this.#fetch.keys(pair.combo).get("chat");
          if (name !== undefined) byChat.set(this.#fetch.spelled(name), (byChat.get(this.#fetch.spelled(name)) ?? 0) + pair.n);
        }
      }
      return { n, reach, chats: [...byChat].map(([chat, messages]) => ({ chat, messages })), ...(this.#context.gate === undefined ? {} : { handles: this.#heldHandles(subject) }) };
    });
    if (counted !== undefined) this.#subjects.set(key, counted);
    return counted;
  }

  #metered(): FactsRead {
    const read = this.#read, real = this.#real;
    const cut = <T>(get: () => T): T => {
      if (real.out) throw new Stopped("newest", undefined);
      let got: T;
      try {
        got = get();
      } catch (error) {
        if (real.out || real.left < 1) throw new Stopped("newest", undefined);
        throw error;
      }
      if (real.out) throw new Stopped("newest", undefined);
      return got;
    };
    return {
      ...read,
      walk: (sql, params, limit, by = real) => cut(() => read.walk(sql, params, limit, by)),
      point: (sql, params, by = real) => cut(() => read.point(sql, params, by)),
      values: (of, key, value) => cut(() => read.values(of, key, value, real)),
    };
  }

  #counted<T>(count: () => T): T | undefined {
    if (this.#out) return undefined;
    try {
      return count();
    } catch (error) {
      if (!(error instanceof Stopped)) throw error;
      this.#out = true;
      return undefined;
    }
  }

  #of(subject: Subject): readonly string[] {
    return "chat" in subject ? this.#collections.chat : this.#collections.person;
  }

  #pairsOf(of: string, subject: Subject): Total[] {
    if ("chat" in subject) return this.#chatCombos(of, subject.chat).flatMap((combo) => this.#through(of, "combo", combo));
    const crews = new Set<number>();
    for (const handle of new Set(subject.handles)) {
      let found = this.#crews.get(handle);
      if (found === undefined) this.#crews.set(handle, found = this.#fetch.crewsOf(handle));
      for (const crew of found) crews.add(crew);
    }
    return [...crews].flatMap((crew) => this.#through(of, "crew", crew));
  }

  #heldHandles(subject: Extract<Subject, { person: string }>): string[] {
    const theirs = new Set(subject.handles);
    const crews = new Set(this.#of(subject).flatMap((of) => this.#pairsOf(of, subject)).filter((pair) => pair.n > 0).map((pair) => pair.crew));
    return [...new Set([...crews].flatMap((crew) => this.#fetch.handles(crew)).filter((handle) => theirs.has(handle)))].sort();
  }

  #chatCombos(of: string, chat: string): number[] {
    const key = `${of}\x1f${chat}`;
    let combos = this.#combos.get(key);
    if (combos === undefined) {
      const name = this.#fetch.named(chat);
      this.#combos.set(key, combos = name === undefined ? [] : this.#fetch.combosOf(of, "chat", name));
    }
    return combos;
  }

  #through(of: string, by: "crew" | "combo", id: number): Total[] {
    const key = `${of}\x1f${by}\x1f${id}`;
    let pairs = this.#pairs.get(key);
    if (pairs !== undefined) return pairs;
    const today = this.#today;
    const pairOf = (cell: { combo: number; crew: number; accounts?: string }) => `${cell.combo},${cell.crew},${cell.accounts ?? ""}`;
    let planned: Map<string, number> | undefined;
    pairs = [];
    for (const pair of this.#fetch.totals(of, by, id)) {
      if (pair.last <= today) {
        pairs.push(pair);
        continue;
      }
      if (pair.first > today) continue;
      if (planned === undefined) {
        planned = new Map();
        for (const cell of this.#fetch.cells(by, of, addDays(today, 1), "9999-12-31", id)) planned.set(pairOf(cell), (planned.get(pairOf(cell)) ?? 0) + cell.n);
      }
      const n = pair.n - (planned.get(pairOf(pair)) ?? 0);
      const last = this.#fetch.cellEdge(by, of, (cell) => cell.day <= today && pairOf(cell) === pairOf(pair), id);
      if (n > 0 && last !== undefined) pairs.push({ ...pair, n, last });
    }
    this.#pairs.set(key, pairs);
    return pairs;
  }

  tellPassed(): void {
    if (this.#context.gate !== undefined) this.#fetch.tellPassed();
  }

  #summed(pairs: readonly Total[]): [number, string, string] | undefined {
    if (pairs.length === 0) return undefined;
    let n = 0, first = pairs[0]!.first, last = pairs[0]!.last;
    for (const pair of pairs) {
      n += pair.n;
      if (pair.first < first) first = pair.first;
      if (pair.last > last) last = pair.last;
    }
    return [n, first, last];
  }
}
