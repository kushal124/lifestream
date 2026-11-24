import type { BlobStore } from "./blobs.js";
import { RELEASE } from "./schema.js";
import type { Sql } from "./sql.js";
import { addDays, civilDay, dayBounds } from "./time.js";
import type { BlobReader, DaySettings } from "./types.js";

export const STORED_MARK = "stored:fill";
export const BLOCKS = 1024;
const BLOCK_BITS = 10;
export const ROUND_ROWIDS = 32_000_000;
export const MAP_SEQS = 8192;
export const SLAB_LEAVES = 64;
export const SLAB_REFERENCES = 4096;
const LEAVES = 0x10000;
export const FILES_END = `sha256:${"f".repeat(64)}`;
const PLAIN_LISTING = "sha256:";
const DAY_MS = 86_400_000;

export const OWNER_MAP = `SELECT v.rowid AS rowid, s.source AS source, (SELECT r.started_ms FROM runs r WHERE r.id = s.run) AS started_ms
  FROM statements s CROSS JOIN versions v ON v.id = s.version WHERE s.seq > ? AND s.seq <= ? AND v.rowid <= ? ORDER BY s.seq`;

export interface StoredFilling {
  M: number;
  blocks: number;
  after: string | null;
  naming?: Naming;
  erasures: number;
  slab_ms: number;
}

export interface Naming {
  blob: string;
  version: string;
  lowest: number | null;
}

export type FileCursor = Pick<StoredFilling, "after" | "naming">;

export type StoredMark = StoredFilling | { complete: string };

export type Holding = Pick<BlobReader, "has"> & Partial<Pick<BlobStore, "stored">>;

export interface Named {
  id: string;
  kind: string;
  key: string;
  rowid?: number;
  owner?: string;
}

export interface Earliest {
  seq: number;
  source: string;
}

export function upgradeMark(M: number): StoredMark {
  return M === 0 ? { complete: RELEASE } : { M, blocks: 0, after: null, erasures: 0, slab_ms: 0 };
}

const NAMING_PAGE = `SELECT count(*) AS links, max(version) AS last, min(rowid) AS lowest FROM (
  SELECT vb.version AS version, v.rowid AS rowid FROM version_blobs vb INDEXED BY version_blobs_blob
    CROSS JOIN versions v ON v.id = vb.version WHERE vb.blob = ? AND vb.version > ? ORDER BY vb.version LIMIT ?)`;

export function storedMark(sql: Sql): StoredMark {
  const value = sql.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", STORED_MARK)?.value;
  if (value === undefined) throw new Error(`home.db has no ${STORED_MARK} mark`);
  return JSON.parse(value) as StoredMark;
}

export function setStoredMark(sql: Sql, mark: StoredMark): void {
  sql.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", STORED_MARK, JSON.stringify(mark));
}

export function blockOf(rowid: number, M: number): number {
  return Math.floor(((rowid - 1) * BLOCKS) / M);
}

export function blockRowids(block: number, M: number): { after: number; through: number } {
  return { after: Math.ceil((block * M) / BLOCKS), through: Math.ceil(((block + 1) * M) / BLOCKS) };
}

export function blockAt(step: number): number {
  let block = 0;
  for (let bit = 0; bit < BLOCK_BITS; bit++) block = (block << 1) | ((step >> bit) & 1);
  return block;
}

export function passed(mark: StoredMark, rowid: number): boolean {
  return "complete" in mark || rowid > mark.M || blockAt(blockOf(rowid, mark.M)) < mark.blocks;
}

interface FileRow {
  source: string;
  version: number;
  bytes: number;
}

interface Lowest {
  rowid: number;
  id: string;
  kind: string;
  key: string;
}

export class Stored {
  #mark: StoredMark | undefined;
  #above = false;
  readonly #moved = new Map<string, { text: number; files: number }>();

  constructor(
    private readonly sql: Sql,
    private readonly today: () => string,
  ) {}

  begin(): void {
    this.#mark = undefined;
    this.#above = false;
    this.#moved.clear();
  }

  mark(): StoredMark {
    return (this.#mark ??= storedMark(this.sql));
  }

  passed(rowid: number): boolean {
    return passed(this.mark(), rowid);
  }

  rowid(): number | null {
    if (this.#above) return null;
    const mark = this.mark();
    if ("complete" in mark) {
      this.#above = true;
      return null;
    }
    const highest = this.sql.get<{ rowid: number }>("SELECT coalesce(max(rowid), 0) AS rowid FROM versions")!.rowid;
    if (highest >= mark.M) {
      this.#above = true;
      return null;
    }
    return mark.M + 1;
  }

  versionStored(rowid: number, source: string, bytes: number): void {
    this.#above = true;
    if (this.passed(rowid)) this.#add(source, bytes, 0);
  }

  linked(blob: string, version: Named, store: Holding): void {
    const row = this.#row(blob);
    if (row !== undefined) {
      const rowid = version.rowid ?? this.sql.get<{ rowid: number }>("SELECT rowid FROM versions WHERE id = ?", version.id)!.rowid;
      if (row.version <= rowid) return;
      const owner = version.owner ?? this.#ownerOf(version);
      if (owner !== null) this.#moveFile(blob, row, owner, rowid);
      return;
    }
    const bytes = store.stored?.(blob);
    if (bytes !== undefined) this.#count(blob, bytes, version);
  }

  arrived(blob: string, store: Pick<Holding, "stored">): void {
    if (this.#row(blob) !== undefined) return;
    if (this.#lowest(blob) === undefined) return;
    const bytes = store.stored?.(blob);
    if (bytes !== undefined) this.#count(blob, bytes);
  }

  unstated(rowid: number, bytes: number, gone: Earliest, survivor: Earliest | null): boolean {
    if (survivor !== null && survivor.seq < gone.seq) return false;
    if (this.passed(rowid)) {
      this.#add(gone.source, -bytes, 0);
      if (survivor !== null) this.#add(survivor.source, bytes, 0);
    }
    return true;
  }

  recount(blobs: Iterable<string>): void {
    for (const blob of new Set(blobs)) {
      const row = this.#row(blob);
      if (row === undefined) continue;
      const lowest = this.#lowest(blob);
      if (lowest === undefined) {
        this.sql.run("DELETE FROM stored_files WHERE blob = ?", blob);
        this.#add(row.source, 0, -row.bytes);
        continue;
      }
      const owner = this.#ownerOf(lowest);
      if (owner !== null && (owner !== row.source || lowest.rowid !== row.version)) this.#moveFile(blob, row, owner, lowest.rowid);
    }
  }

  erased(): void {
    const mark = this.mark();
    if ("complete" in mark) return;
    const { naming: _naming, ...rest } = mark;
    this.#mark = { ...rest, erasures: mark.erasures + 1 };
    setStoredMark(this.sql, this.#mark);
  }

  flush(): void {
    let day: string | undefined;
    for (const [source, { text, files }] of this.#moved) {
      if (text !== 0 || files !== 0) this.#upsert((day ??= this.today()), source, text, files);
    }
    this.begin();
  }

  countText(slab: TextSlab): boolean {
    this.begin();
    const mark = storedMark(this.sql);
    if ("complete" in mark || mark.M !== slab.M || mark.erasures !== slab.erasures || mark.blocks !== slab.step) return false;
    for (const row of slab.rows) this.#upsert(row.day, row.source, row.text, 0);
    setStoredMark(this.sql, { ...mark, blocks: mark.blocks + 1, slab_ms: mark.slab_ms + Math.round(slab.ms) });
    return true;
  }

  countFiles(slab: FileSlab): boolean {
    this.begin();
    const mark = storedMark(this.sql);
    if ("complete" in mark || mark.M !== slab.M || mark.erasures !== slab.erasures || mark.after !== slab.from || !sameNaming(mark.naming, slab.from_naming)) return false;
    const sums = new Map<string, StoredRow>();
    for (const file of slab.files) {
      const inserted = this.sql.run(
        "INSERT INTO stored_files (blob, source, version, bytes) VALUES (?, ?, ?, ?) ON CONFLICT (blob) DO NOTHING",
        file.blob, file.source, file.version, file.bytes,
      ).changes;
      if (inserted === 1) fold(sums, file.day, file.source, file.bytes);
    }
    for (const row of sums.values()) this.#upsert(row.day, row.source, 0, row.bytes);
    const { naming: _naming, ...rest } = mark;
    setStoredMark(this.sql, { ...rest, after: slab.through, ...(slab.naming === undefined ? {} : { naming: slab.naming }), slab_ms: mark.slab_ms + Math.round(slab.ms) });
    return true;
  }

  complete(own: number): boolean {
    this.begin();
    const mark = storedMark(this.sql);
    if ("complete" in mark || mark.blocks < BLOCKS || mark.after !== FILES_END) return false;
    const days = this.sql.all<{ day: string; text: number }>("SELECT day, sum(text) AS text FROM stored_days GROUP BY day ORDER BY day");
    const today = this.today();
    const total = days.reduce((sum, day) => sum + day.text, 0);
    const text = new Map(days.map((day) => [day.day, day.text]));
    let held = 0;
    for (let day = days[0]?.day ?? today; day < today; day = addDays(day, 1)) {
      held += text.get(day) ?? 0;
      const bytes = total > 0 ? Math.round(own * (Math.max(0, held) / total)) : own;
      this.sql.run("INSERT INTO own_days (day, bytes) VALUES (?, ?) ON CONFLICT (day) DO NOTHING", day, bytes);
    }
    setStoredMark(this.sql, { complete: RELEASE });
    return true;
  }

  close(day: string, bytes: number): void {
    const last = this.sql.get<{ day: string | null }>("SELECT max(day) AS day FROM own_days")!.day;
    for (let at = last === null ? day : addDays(last, 1); at <= day; at = addDays(at, 1)) {
      this.sql.run("INSERT INTO own_days (day, bytes) VALUES (?, ?) ON CONFLICT (day) DO NOTHING", at, bytes);
    }
  }

  #upsert(day: string, source: string, text: number, files: number): void {
    this.sql.run(
      `INSERT INTO stored_days (day, source, text, files) VALUES (?, ?, ?, ?)
       ON CONFLICT (day, source) DO UPDATE SET text = text + excluded.text, files = files + excluded.files`,
      day, source, text, files,
    );
  }

  #add(source: string, text: number, files: number): void {
    const moved = this.#moved.get(source);
    if (moved === undefined) this.#moved.set(source, { text, files });
    else {
      moved.text += text;
      moved.files += files;
    }
  }

  #count(blob: string, bytes: number, named?: Named): void {
    const lowest = this.#lowest(blob);
    if (lowest === undefined) return;
    const owner = named !== undefined && named.id === lowest.id && named.owner !== undefined ? named.owner : this.#ownerOf(lowest);
    if (owner === null) return;
    this.sql.run("INSERT INTO stored_files (blob, source, version, bytes) VALUES (?, ?, ?, ?)", blob, owner, lowest.rowid, bytes);
    this.#add(owner, 0, bytes);
  }

  #moveFile(blob: string, row: FileRow, owner: string, version: number): void {
    this.sql.run("UPDATE stored_files SET source = ?, version = ? WHERE blob = ?", owner, version, blob);
    if (owner === row.source) return;
    this.#add(row.source, 0, -row.bytes);
    this.#add(owner, 0, row.bytes);
  }

  #row(blob: string): FileRow | undefined {
    return this.sql.get<FileRow>("SELECT source, version, bytes FROM stored_files WHERE blob = ?", blob);
  }

  #lowest(blob: string): Lowest | undefined {
    return this.sql.get<Lowest>(
      `SELECT v.rowid AS rowid, v.id AS id, v.kind AS kind, v.key AS key FROM version_blobs vb INDEXED BY version_blobs_blob
         CROSS JOIN versions v ON v.id = vb.version WHERE vb.blob = ? ORDER BY v.rowid LIMIT 1`,
      blob,
    );
  }

  #ownerOf(version: Pick<Named, "id" | "kind" | "key">): string | null {
    return this.sql.get<{ source: string }>(
      "SELECT source FROM statements INDEXED BY statements_record WHERE kind = ? AND key = ? AND version = ? ORDER BY seq LIMIT 1",
      version.kind, version.key, version.id,
    )?.source ?? null;
  }
}

export interface StoredRow {
  day: string;
  source: string;
  bytes: number;
}

export interface TextSlab {
  M: number;
  step: number;
  erasures: number;
  ms: number;
  rows: { day: string; source: string; text: number }[];
}

export interface FileCounted {
  blob: string;
  source: string;
  version: number;
  bytes: number;
  day: string;
}

export interface FileSlab {
  M: number;
  from: string | null;
  from_naming?: Naming;
  through: string | null;
  naming?: Naming;
  references: number;
  erasures: number;
  ms: number;
  files: FileCounted[];
}

function sameNaming(a: Naming | undefined, b: Naming | undefined): boolean {
  return a === undefined || b === undefined ? a === b : a.blob === b.blob && a.version === b.version && a.lowest === b.lowest;
}

export interface FillDays {
  settings: DaySettings;
  now_ms: number;
}

export type Leaves = Pick<BlobStore, "leaves"> & Partial<Pick<BlobStore, "listing">>;

type Lister = ReturnType<BlobStore["leaves"]>;

const listers = new WeakMap<OwnerMap, { store: Leaves; list: Lister }>();

export class OwnerMap {
  seq = 0;
  readonly sources: string[] = [""];
  readonly owner: Uint16Array;
  readonly day: Uint16Array;
  readonly #offset = new Int32Array(BLOCKS).fill(-1);
  readonly #numbers = new Map<string, number>();
  readonly #first: number;
  readonly #last: number;
  readonly #days: string[] = [];
  #bounds = { start_ms: 0, end_ms: 0, index: 0 };

  constructor(
    readonly M: number,
    readonly erasures: number,
    readonly from: number,
    readonly to: number,
    readonly end: number,
    readonly first: string,
    readonly today: string,
    readonly settings: DaySettings,
  ) {
    let length = 0;
    for (let step = from; step < to; step++) {
      const block = blockAt(step);
      const { after, through } = blockRowids(block, M);
      this.#offset[block] = length;
      length += through - after;
    }
    this.owner = new Uint16Array(length);
    this.day = new Uint16Array(length);
    this.#first = Date.parse(first);
    this.#last = this.#index(today);
  }

  get whole(): boolean {
    return this.seq >= this.end;
  }

  covers(step: number): boolean {
    return step >= this.from && step < this.to;
  }

  holds(rowid: number): boolean {
    return this.#at(rowid) >= 0;
  }

  at(rowid: number): { source: string; day: string } | undefined {
    const at = this.#at(rowid);
    if (at < 0 || this.owner[at] === 0) return undefined;
    return { source: this.sources[this.owner[at]!]!, day: this.dayName(this.day[at]!) };
  }

  see(rowid: number, source: string, started_ms: number | null): void {
    const at = this.#at(rowid);
    if (at < 0 || this.owner[at] !== 0) return;
    this.owner[at] = this.number(source);
    this.day[at] = this.dayIndex(started_ms);
  }

  number(source: string): number {
    let number = this.#numbers.get(source);
    if (number === undefined) {
      number = this.sources.length;
      if (number > 0xffff) throw new Error("the owner map holds at most 65,535 sources");
      this.sources.push(source);
      this.#numbers.set(source, number);
    }
    return number;
  }

  dayIndex(ms: number | null): number {
    if (ms === null) return 0;
    const bounds = this.#bounds;
    if (ms >= bounds.start_ms && ms < bounds.end_ms) return bounds.index;
    const day = civilDay(ms, this.settings);
    const { start_ms, end_ms } = dayBounds(day, this.settings);
    const index = Math.min(this.#last, Math.max(0, this.#index(day)));
    this.#bounds = { start_ms, end_ms, index };
    return index;
  }

  dayName(index: number): string {
    return (this.#days[index] ??= addDays(this.first, index));
  }

  #index(day: string): number {
    return Math.round((Date.parse(day) - this.#first) / DAY_MS);
  }

  #at(rowid: number): number {
    if (rowid <= 0 || rowid > this.M) return -1;
    const block = blockOf(rowid, this.M);
    const offset = this.#offset[block]!;
    return offset < 0 ? -1 : offset + rowid - blockRowids(block, this.M).after - 1;
  }
}

export class StoredReads {
  constructor(
    private readonly sql: Sql,
    private readonly check: () => void = () => {},
  ) {}

  mark(): StoredMark {
    this.check();
    return storedMark(this.sql);
  }

  textCounted(): number {
    this.check();
    return this.sql.get<{ text: number }>("SELECT coalesce(sum(text), 0) AS text FROM stored_days")!.text;
  }

  ownerMap(days: FillDays, round = ROUND_ROWIDS): OwnerMap | null {
    const mark = this.mark();
    if ("complete" in mark) return null;
    const widest = Math.max(1, Math.ceil(mark.M / BLOCKS));
    const steps = Math.max(1, Math.floor(round / widest));
    const from = Math.floor(Math.min(mark.blocks, BLOCKS - 1) / steps) * steps;
    const today = civilDay(days.now_ms, days.settings);
    const firstRun = this.sql.get<{ started_ms: number }>("SELECT started_ms FROM runs ORDER BY id LIMIT 1")?.started_ms;
    const first = firstRun === undefined ? today : [civilDay(firstRun, days.settings), today].sort()[0]!;
    const end = this.sql.get<{ end: number }>("SELECT coalesce(max(seq), 0) AS end FROM statements")!.end;
    return new OwnerMap(mark.M, mark.erasures, from, Math.min(BLOCKS, from + steps), end, first, today, days.settings);
  }

  mapBatch(map: OwnerMap, seqs = MAP_SEQS): boolean | null {
    if (this.#stale(map)) return null;
    const through = Math.min(map.end, map.seq + seqs);
    this.sql.on(() => {
      const rows = this.sql.db.prepare(OWNER_MAP).raw(true).iterate(map.seq, through, map.M) as Iterable<[number, string, number | null]>;
      for (const [rowid, source, started_ms] of rows) map.see(rowid, source, started_ms);
    });
    map.seq = through;
    return map.whole;
  }

  text(map: OwnerMap, step: number): TextSlab | null {
    if (!map.covers(step)) throw new RangeError(`the owner map holds steps ${map.from} to ${map.to - 1}, not ${step}`);
    partial(map);
    const started = performance.now();
    if (this.#stale(map)) return null;
    const { after, through } = blockRowids(blockAt(step), map.M);
    const sums = new Map<string, StoredRow>();
    for (const { rowid, bytes } of this.sql.all<{ rowid: number; bytes: number }>(
      "SELECT rowid, octet_length(text) AS bytes FROM versions WHERE rowid > ? AND rowid <= ? ORDER BY rowid", after, through,
    )) {
      const at = map.at(rowid);
      if (at !== undefined) fold(sums, at.day, at.source, bytes);
    }
    const rows = [...sums.values()].map(({ day, source, bytes }) => ({ day, source, text: bytes }));
    return { M: map.M, step, erasures: map.erasures, ms: performance.now() - started, rows };
  }

  files(map: OwnerMap, store: Leaves, from: FileCursor, bounds = { leaves: SLAB_LEAVES, references: SLAB_REFERENCES }): FileSlab | null {
    const { after } = from;
    if (after === FILES_END) throw new RangeError("the file pass has finished every leaf");
    partial(map);
    const started = performance.now();
    if (this.#stale(map)) return null;
    const listing = store.listing ?? PLAIN_LISTING;
    const list = this.#lister(map, store);
    let leaf = after === null ? 0 : Number.parseInt(after.slice(listing.length, listing.length + 4), 16);
    if (after !== null && after === ceiling(listing, leaf)) leaf++;
    let through = after;
    let references = 0;
    let naming: Naming | undefined;
    const files: FileCounted[] = [];
    const slab = (): FileSlab => ({
      M: map.M, from: after, ...(from.naming === undefined ? {} : { from_naming: from.naming }), through, ...(naming === undefined ? {} : { naming }),
      references, erasures: map.erasures, ms: performance.now() - started, files,
    });
    for (let listed = 0; listed < bounds.leaves && leaf < LEAVES; listed++, leaf++) {
      for (const file of list(leaf.toString(16).padStart(4, "0"))) {
        const at = file.name ?? file.blob;
        if (after !== null && at <= after) continue;
        if (this.sql.get("SELECT 1 FROM stored_files WHERE blob = ?", file.blob) !== undefined) {
          through = at;
          continue;
        }
        const resumed = from.naming?.blob === file.blob ? from.naming : undefined;
        let version = resumed?.version ?? "";
        let lowest = resumed?.lowest ?? null;
        for (;;) {
          const left = bounds.references - references;
          if (left <= 0) {
            naming = { blob: file.blob, version, lowest };
            return slab();
          }
          const read = this.sql.get<{ links: number; last: string | null; lowest: number | null }>(NAMING_PAGE, file.blob, version, left)!;
          references += read.links;
          if (read.lowest !== null) lowest = lowest === null ? read.lowest : Math.min(lowest, read.lowest);
          if (read.last !== null) version = read.last;
          if (read.links < left) break;
        }
        through = at;
        if (lowest !== null && lowest <= map.M) {
          const source = this.#owner(map, lowest);
          if (source !== undefined) files.push({ blob: file.blob, source, version: lowest, bytes: file.bytes, day: map.dayName(map.dayIndex(file.mtime_ms)) });
        }
        if (references >= bounds.references) return slab();
      }
      through = leaf === LEAVES - 1 ? FILES_END : ceiling(listing, leaf);
    }
    return slab();
  }

  #lister(map: OwnerMap, store: Leaves): Lister {
    const held = listers.get(map);
    if (held?.store === store) return held.list;
    const list = store.leaves(() => this.sql.on(() => this.sql.db.prepare("SELECT DISTINCT blob FROM version_blobs INDEXED BY version_blobs_blob").pluck().iterate() as Iterable<string>));
    listers.set(map, { store, list });
    return list;
  }

  #stale(map: OwnerMap): boolean {
    const mark = this.mark();
    return "complete" in mark || mark.M !== map.M || mark.erasures !== map.erasures;
  }

  #owner(map: OwnerMap, rowid: number): string | undefined {
    if (map.holds(rowid)) return map.at(rowid)?.source;
    return this.sql.get<{ source: string }>(
      `SELECT s.source AS source FROM versions v CROSS JOIN statements s INDEXED BY statements_record
         ON s.kind = v.kind AND s.key = v.key AND s.version = v.id WHERE v.rowid = ? ORDER BY s.seq LIMIT 1`,
      rowid,
    )?.source;
  }
}

function partial(map: OwnerMap): void {
  if (!map.whole) throw new RangeError(`the owner map has read through seq ${map.seq} of ${map.end}`);
}

function ceiling(listing: string, leaf: number): string {
  return `${listing}${leaf.toString(16).padStart(4, "0")}${"f".repeat(60)}`;
}

function fold(sums: Map<string, StoredRow>, day: string, source: string, bytes: number): void {
  const key = `${day}\u0000${source}`;
  const row = sums.get(key);
  if (row === undefined) sums.set(key, { day, source, bytes });
  else row.bytes += bytes;
}
