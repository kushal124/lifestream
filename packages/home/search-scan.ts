import { createHash } from "node:crypto";
import { addDays, civilDay, dayBounds, type DaySettings } from "@lifestreamprotocol/core";


export const SCAN = 10_000;
export const PAGE_ROWS = 30_000;
export const SCAN_ROWS = 20_000;
export const HIT_ROWS = 200;
export const EDGE_ROWS = 1_000;
export const FACET_ROWS = 256;
export const COUNT_SCAN = 100_000;
export const GROUP_ROWS = 110_000;
export const GROUP_NAME_ROWS = 4_000;
const CHUNK = 100;
export const DATED_TAG = "dated";

export const MIN_MS = -9_000_000_000_000;
export const MAX_MS = 9_007_199_254_739;
export const UNTIMED = -Number.MAX_SAFE_INTEGER;
export const TIMED = MIN_MS * 1000;
export const TOP = Number.MAX_SAFE_INTEGER;

export function slotMs(ms: number): number {
  return Math.min(MAX_MS, Math.max(MIN_MS, Math.floor(ms))) * 1000;
}

export function timeOf(slot: number): number | null {
  return slot < TIMED ? null : Math.floor(slot / 1000);
}

export const SUBJECT_KEYS = ["chat"] as const;

const TAG_CACHE_MAX = 4_096;
const tagWords = new Map<string, string>();
const chatTags = new Map<string, string>();
const sourceTags = new Map<string, string>();

export function tagWord(name: string): string {
  const held = tagWords.get(name);
  if (held !== undefined) return held;
  const value = name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  if (tagWords.size >= TAG_CACHE_MAX) tagWords.clear();
  tagWords.set(name, value);
  return value;
}

export function productsTerm(products: readonly string[]): string {
  return `tags : (${products.map((product) => `p${tagWord(product)}`).join(" OR ")})`;
}

export function chatTag(chat: string): string {
  const held = chatTags.get(chat);
  if (held !== undefined) return held;
  const value = `c${createHash("sha256").update(chat).digest("hex").slice(0, 12)}`;
  if (chatTags.size >= TAG_CACHE_MAX) chatTags.clear();
  chatTags.set(chat, value);
  return value;
}

export function sourceTag(source: string): string {
  const held = sourceTags.get(source);
  if (held !== undefined) return held;
  const value = `s${createHash("sha256").update(source).digest("hex").slice(0, 12)}`;
  if (sourceTags.size >= TAG_CACHE_MAX) sourceTags.clear();
  sourceTags.set(source, value);
  return value;
}

export type End = "ended" | "full" | "out";

export type SearchCursor =
  | { kind: "page"; slot: number | null; stop: number | null }
  | { kind: "rank"; from: number | null; today: number | null; given: number[] }
  | { kind: "rest"; place: number | null; stop: number | null; given: number[] }
  | { kind: "scan"; slot: number | null; given?: number[] };

export interface Reached {
  side: "newest" | "oldest";
  at: string | null;
  whole: string | null;
}

export interface ScanPlan {
  match: string | undefined;
  from: number;
  to: number;
  test: { sql: string; params: readonly unknown[] } | undefined;
  stretches?: readonly Stretch[] | undefined;
}

export interface Stretch {
  from: number;
  to: number;
  clock: boolean;
  date: boolean;
  reach?: number;
}

export function stretchesOf(clock: readonly (readonly [number, number])[], date: readonly (readonly [number, number])[], from: number, to: number): Stretch[] {
  if (clock.length === 0 || date.length === 0) {
    const isClock = date.length === 0;
    const list = isClock ? clock : date;
    let ordered = true;
    for (let at = 0; at < list.length; at++) {
      const pair = list[at]!;
      if (pair[0] > pair[1] || (at > 0 && list[at - 1]![1] > pair[0])) {
        ordered = false;
        break;
      }
    }
    if (ordered) {
      const out: Stretch[] = [];
      for (let at = 0; at < list.length; at++) {
        const pair = list[at]!;
        const low = pair[0] < from ? from : pair[0];
        const high = pair[1] > to ? to : pair[1];
        if (low >= high) continue;
        const last = out.at(-1);
        if (last !== undefined && last.to === low) last.to = high;
        else out.push({ from: low, to: high, clock: isClock, date: !isClock });
      }
      return out;
    }
  }
  const edges = [...new Set([...clock, ...date].flat().filter((edge) => edge > from && edge < to).concat(from, to))].sort((left, right) => left - right);
  const out: Stretch[] = [];
  let [inClock, inDate] = [0, 0];
  const holds = (list: readonly (readonly [number, number])[], at: number, slot: number): [number, boolean] => {
    while (at < list.length && list[at]![1] <= slot) at++;
    return [at, at < list.length && list[at]![0] <= slot];
  };
  for (let at = 0; at + 1 < edges.length; at++) {
    const [low, high] = [edges[at]!, edges[at + 1]!];
    let keepsClock: boolean, keepsDate: boolean;
    [inClock, keepsClock] = holds(clock, inClock, low);
    [inDate, keepsDate] = holds(date, inDate, low);
    if (!keepsClock && !keepsDate) continue;
    const last = out.at(-1);
    if (last !== undefined && last.to === low && last.clock === keepsClock && last.date === keepsDate) last.to = high;
    else out.push({ from: low, to: high, clock: keepsClock, date: keepsDate });
  }
  return out;
}

export interface Scanned {
  slot: number;
  kept: number;
  rank: number;
  family: number | null;
  accounts?: string | null;
}

export type Allows = (row: Scanned, matched: boolean) => boolean;

export type Walker = <T>(sql: string, params: readonly unknown[], limit: number) => { rows: T[]; more: boolean };

const WEIGHTS = "3, 2, 1, 0.5, 0";

type Kinds = "both" | "clock" | "date";

const STATING = ", x.accounts AS accounts";
const STATED_BY = " LEFT JOIN entry_states x ON x.slot = e.slot";

function statementOf(plan: ScanPlan, ranked: boolean, newest: boolean, kinds: Kinds, reach: number | undefined, stating: boolean): { sql: string; params: readonly unknown[] } {
  const column = plan.match === undefined ? "e.slot" : "f.rowid";
  const tests = [...(plan.test === undefined ? [] : [`(${plan.test.sql})`]), ...(reach === undefined ? [] : ["e.last >= ?"])];
  const kept = tests.length === 0 ? "1" : tests.join(" AND ");
  const rank = ranked && plan.match !== undefined ? (tests.length === 0 ? `bm25(fts, ${WEIGHTS})` : `CASE WHEN ${kept} THEN bm25(fts, ${WEIGHTS}) ELSE 0 END`) : "0";
  const select = `SELECT ${column} AS slot, ${kept} AS kept, ${rank} AS rank, e.family AS family${stating ? STATING : ""}`;
  const joined = stating ? STATED_BY : "";
  const order = `ORDER BY ${column} ${newest ? "DESC" : "ASC"} LIMIT ?`;
  const testParams = [...(plan.test?.params ?? []), ...(reach === undefined ? [] : [reach])];
  const params = [...testParams, ...(ranked && plan.match !== undefined && tests.length > 0 ? testParams : [])];
  if (plan.match === undefined) {
    const kind = kinds === "both" ? "" : `e.dated = ${kinds === "date" ? 1 : 0} AND `;
    return { sql: `${select} FROM entries e${joined} WHERE ${kind}e.slot >= ? AND e.slot < ? ${order}`, params };
  }
  const match = kinds === "both" ? plan.match : `(${plan.match}) ${kinds === "date" ? "AND" : "NOT"} tags : ${DATED_TAG}`;
  return { sql: `${select} FROM fts f JOIN entries e ON e.slot = f.rowid${joined} WHERE fts MATCH ? AND f.rowid >= ? AND f.rowid < ? ${order}`, params: [...params, match] };
}

export class Scan {
  readonly accepted: Scanned[] = [];
  end: End | undefined;
  stop: number | undefined;
  told: number | undefined;
  toldTimed: number | undefined;
  readonly #statements = new Map<string, { sql: string; params: readonly unknown[] }>();
  readonly #plan: ScanPlan;
  readonly #started: number;
  readonly #stretches: Stretch[];
  #stretch = 0;
  readonly #seeks: boolean;
  readonly #test: boolean;
  #from = 0;
  #to = 0;
  #entered = false;
  #buffer: Scanned[] = [];
  #at = 0;
  #exhausted = false;
  #emptyRun = 0;
  readonly #emptySpan = new Map<string, { from: number; to: number }>();
  readonly #judged = new WeakMap<Scanned, boolean>();

  constructor(
    private readonly walk: Walker,
    private readonly spent: () => number,
    private readonly made: (rows: number) => boolean,
    plan: ScanPlan,
    private readonly how: { ranked: boolean; newest: boolean; after?: number | null | undefined; most: number; rows: number; chunk?: number; allows?: Allows | undefined },
  ) {
    this.#plan = plan;
    this.#started = spent();
    let [from, to] = [plan.from, plan.to];
    const after = how.after ?? null;
    if (after !== null) {
      if (how.newest) to = Math.min(to, after);
      else from = Math.max(from, after + 1);
    }
    this.#seeks = plan.stretches !== undefined;
    const stretches = (plan.stretches ?? [{ from: plan.from, to: plan.to, clock: true, date: true }])
      .map((stretch) => ({ ...stretch, from: Math.max(stretch.from, from), to: Math.min(stretch.to, to) }))
      .filter((stretch) => stretch.from < stretch.to);
    this.#stretches = how.newest ? stretches.reverse() : stretches;
    this.#test = plan.test !== undefined || stretches.some((stretch) => stretch.reach !== undefined);
    this.#enter();
  }

  next(): Scanned | undefined {
    for (;;) {
      if (this.end !== undefined) return undefined;
      if (this.accepted.length >= this.how.most) {
        this.end = this.#at >= this.#buffer.length && this.#exhausted ? "ended" : "full";
        return undefined;
      }
      if (this.#at < this.#buffer.length) {
        const row = this.#buffer[this.#at++]!;
        if (!this.#passed(row) || row.kept !== 1) continue;
        this.accepted.push(row);
        return row;
      }
      if (this.#exhausted) {
        this.end = "ended";
        return undefined;
      }
      this.#fill();
    }
  }

  drain(): Scanned[] {
    while (this.next() !== undefined);
    return this.accepted;
  }

  get open(): boolean {
    if (this.end !== undefined || this.accepted.length >= this.how.most) return false;
    if (this.how.allows !== undefined) return this.#seekAllowed();
    for (let at = this.#at; at < this.#buffer.length; at++) if (this.#buffer[at]!.kept === 1) return true;
    return !this.#exhausted;
  }

  #seekAllowed(): boolean {
    for (;;) {
      for (; this.#at < this.#buffer.length; this.#at++) {
        const row = this.#buffer[this.#at]!;
        if (row.kept === 1 && this.#allows(row)) return true;
        this.#passed(row);
      }
      if (this.#exhausted) return false;
      this.#fill();
      if (this.end !== undefined) return true;
    }
  }

  get capped(): boolean {
    return this.end === "full" || this.end === "out";
  }

  #passed(row: Scanned): boolean {
    this.stop = row.slot;
    const allowed = this.#allows(row);
    if (allowed) {
      this.told = row.slot;
      if (row.slot >= TIMED) this.toldTimed = row.slot;
    }
    return allowed;
  }

  #allows(row: Scanned): boolean {
    const allows = this.how.allows;
    if (allows === undefined) return true;
    let allowed = this.#judged.get(row);
    if (allowed === undefined) this.#judged.set(row, allowed = allows(row, row.kept === 1));
    return allowed;
  }

  #enter(): void {
    const stretch = this.#stretches[this.#stretch];
    this.#entered = false;
    if (stretch === undefined) this.#exhausted = true;
    else [this.#from, this.#to] = [stretch.from, stretch.to];
  }

  #fill(): void {
    const stretch = this.#stretches[this.#stretch]!;
    if (this.#from >= this.#to) {
      this.stop = this.told = this.how.newest ? stretch.from : stretch.to - 1;
      this.#stretch += 1;
      this.#enter();
      this.#buffer = [];
      this.#at = 0;
      return;
    }
    const left = this.how.rows - (this.spent() - this.#started);
    const lacks = this.how.most - this.accepted.length;
    const wanted = this.how.chunk ?? (this.#test ? Math.max(lacks, CHUNK) : lacks);
    const seek = this.#seeks && !this.#entered ? 1 : 0;
    const limit = Math.min(wanted, left - seek - 1);
    if (limit < 1 || (seek === 1 && !this.made(1))) {
      this.end = "out";
      this.#buffer = [];
      this.#at = 0;
      return;
    }
    this.#entered = true;
    const kinds: Kinds = stretch.clock && stretch.date ? "both" : stretch.date ? "date" : "clock";
    const key = `${kinds}:${stretch.reach ?? ""}`;
    const knownEmpty = this.#emptySpan.get(key);
    if (knownEmpty !== undefined && this.#from >= knownEmpty.from && this.#to <= knownEmpty.to) {
      this.#buffer = [];
      this.#at = 0;
      [this.#from, this.#to] = [stretch.to, stretch.to];
      if (this.#stretch + 1 === this.#stretches.length) this.#exhausted = true;
      return;
    }
    let statement = this.#statements.get(key);
    if (statement === undefined) this.#statements.set(key, statement = statementOf(this.#plan, this.how.ranked, this.how.newest, kinds, stretch.reach, this.how.allows !== undefined));
    if (this.#seeks && this.#plan.match !== undefined && this.#emptyRun >= 16 && this.#stretches.length - this.#stretch >= 16) {
      const spanFrom = this.how.newest ? this.#stretches.at(-1)!.from : this.#from;
      const spanTo = this.how.newest ? this.#to : this.#stretches.at(-1)!.to;
      const probe = this.walk<Scanned>(statement.sql, [...statement.params, spanFrom, spanTo], 1);
      if (probe.rows.length === 0 && probe.more) {
        this.end = "out";
        return;
      }
      if (probe.rows.length === 0) {
        this.#emptySpan.set(key, { from: spanFrom, to: spanTo });
        this.#buffer = [];
        this.#at = 0;
        [this.#from, this.#to] = [stretch.to, stretch.to];
        if (this.#stretch + 1 === this.#stretches.length) this.#exhausted = true;
        return;
      }
      const hit = probe.rows[0]!;
      if (this.how.newest && hit.slot < this.#from) {
        this.#emptySpan.set(key, { from: hit.slot + 1, to: spanTo });
        this.#buffer = [];
        this.#at = 0;
        [this.#from, this.#to] = [stretch.to, stretch.to];
        if (this.#stretch + 1 === this.#stretches.length) this.#exhausted = true;
        return;
      }
      if (!this.how.newest && hit.slot >= this.#to) {
        this.#emptySpan.set(key, { from: spanFrom, to: hit.slot });
        this.#buffer = [];
        this.#at = 0;
        [this.#from, this.#to] = [stretch.to, stretch.to];
        if (this.#stretch + 1 === this.#stretches.length) this.#exhausted = true;
        return;
      }
      this.#emptyRun = 0;
    }
    const { rows, more } = this.walk<Scanned>(statement.sql, [...statement.params, this.#from, this.#to], limit);
    if (rows.length === 0 && more) {
      this.end = "out";
      return;
    }
    this.#emptyRun = rows.length === 0 && !more ? this.#emptyRun + 1 : 0;
    this.#buffer = rows;
    this.#at = 0;
    const last = rows.at(-1);
    if (!more) [this.#from, this.#to] = [stretch.to, stretch.to];
    else if (this.how.newest) this.#to = last!.slot;
    else this.#from = last!.slot + 1;
    if (!more && this.#stretch + 1 === this.#stretches.length) this.#exhausted = true;
  }
}

export interface Walked {
  accepted: Scanned[];
  end: End | undefined;
  stop?: number;
  told?: number;
  toldTimed?: number;
}

export function walked(scan: Scan): Walked {
  return { accepted: scan.accepted, end: scan.end, ...(scan.stop === undefined ? {} : { stop: scan.stop }), ...toldOf(scan) };
}

function toldOf(scan: Pick<Scan, "told" | "toldTimed">): Pick<Walked, "told" | "toldTimed"> {
  return { ...(scan.told === undefined ? {} : { told: scan.told }), ...(scan.toldTimed === undefined ? {} : { toldTimed: scan.toldTimed }) };
}

export function tiered(scans: readonly Scan[]): Omit<Walked, "accepted"> & { tiers: Scanned[][] } {
  const capped = scans.filter((walk) => walk.capped);
  if (capped.length === 0) return { ...walked(scans.at(-1)!), tiers: scans.map((walk) => walk.accepted) };
  if (capped.some((walk) => walk.stop === undefined)) return { end: "out", tiers: scans.map(() => []) };
  const first = capped.reduce((most, walk) => (walk.stop! > most.stop! ? walk : most));
  const stop = first.stop!;
  return { end: first.end, stop, ...toldOf(first), tiers: scans.map((walk) => walk.accepted.filter((row) => row.slot >= stop)) };
}

export function wholeOf(side: "newest" | "oldest", stop: number, settings: DaySettings, range: { first?: string; last?: string }, read?: string): string | null {
  if (stop < TIMED) return side === "newest" ? range.first ?? read ?? null : null;
  const day = civilDay(Math.floor(stop / 1000), settings);
  const { start_ms, end_ms } = dayBounds(day, settings);
  const each = side === "newest" ? (start_ms * 1000 >= stop ? day : addDays(day, 1)) : (end_ms * 1000 - 1 <= stop ? day : addDays(day, -1));
  if (side === "newest") return range.last !== undefined && each > range.last ? null : each;
  return range.first !== undefined && each < range.first ? null : each;
}

export type FoldKey = "day" | "month" | "family";

export function isTime(key: FoldKey): key is "day" | "month" {
  return key === "day" || key === "month";
}

export interface Folded {
  values: (string | number)[];
  n: number;
  partial?: true;
}

export type PartlyRead = (first: string, last: string) => boolean;

export function groupsOf(rows: readonly Scanned[], by: readonly FoldKey[], settings: DaySettings, partial?: PartlyRead): Folded[] {
  const timed = by.some(isTime);
  const counted = new Map<string, Folded>();
  let bounds: { start_ms: number; end_ms: number; day: string } | undefined;
  for (const row of rows) {
    let day: string | undefined;
    if (timed && row.slot >= TIMED) {
      const ms = Math.floor(row.slot / 1000);
      if (bounds === undefined || ms < bounds.start_ms || ms >= bounds.end_ms) {
        const civil = civilDay(ms, settings);
        bounds = { ...dayBounds(civil, settings), day: civil };
      }
      day = bounds.day;
    }
    const values: (string | number)[] = [];
    let first = "", last = "\uffff", missing = false;
    for (const key of by) {
      if (isTime(key)) {
        if (day === undefined) {
          missing = true;
          break;
        }
        const value = timeKeyOf(key, day) as string;
        values.push(value);
        const [from, to] = unitDays(key, value);
        if (from > first) first = from;
        if (to < last) last = to;
        continue;
      }
      const value = row[key];
      if (value === null) {
        missing = true;
        break;
      }
      values.push(value);
    }
    if (missing) continue;
    const name = values.join("\u001f");
    const group = counted.get(name);
    if (group !== undefined) group.n++;
    else counted.set(name, { values, n: 1, ...(partial !== undefined && timed && partial(first, last) ? { partial: true as const } : {}) });
  }
  return [...counted.values()];
}

export function partialOf(side: "newest" | "oldest", stop: number, whole: string | null, range: { first?: string; last?: string }): PartlyRead {
  if (side === "newest" && stop < TIMED) return () => false;
  if (whole === null) return () => true;
  if (side === "newest") return (first) => (range.first !== undefined && range.first > first ? range.first : first) < whole;
  return (_first, last) => (range.last !== undefined && range.last < last ? range.last : last) > whole;
}

export function timeKeyOf(key: string, day: string): string | number {
  if (key === "day") return day;
  if (key === "month") return day.slice(0, 7);
  if (key === "year") return day.slice(0, 4);
  const at = Date.parse(`${day}T00:00:00Z`);
  const weekday = (new Date(at).getUTCDay() + 6) % 7;
  if (key === "weekday") return weekday;
  return new Date(at - weekday * 86_400_000).toISOString().slice(0, 10);
}

export function unitDays(key: "day" | "week" | "month" | "year", value: string): [string, string] {
  if (key === "day") return [value, value];
  if (key === "week") return [value, addDays(value, 6)];
  if (key === "month") return [`${value}-01`, addDays(new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)), 1)).toISOString().slice(0, 10), -1)];
  return [`${value}-01-01`, `${value}-12-31`];
}
