import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { accountOf, addDays, CHECKPOINT_PAGES, dayBounds, flush, handleId, handleOf, isSqliteError, type DaySettings, type HomeFolder, type RecordRef, type StoreKind } from "@lifestreamprotocol/core";
import { handleOfId, minorUnitsOf, type DayFileFact, type NameSpan } from "@lifestreamprotocol/families";
import type { HeldDays } from "./index-file.js";
import { readHome } from "./lifecycle.js";
import { atomPassages, families, kinds, recordPassages, search, SITTING_ROWS, sittingLines, sittingUnits, unitsSaid, utcDate, type KindsFound, type KindsShape, type SearchAnswer, type SearchGate, type SearchQuery, type UnitFound } from "./record-search.js";
import {
  chatTag, DATED_TAG, GROUP_ROWS, MAX_MS, MIN_MS, PAGE_ROWS, slotMs, sourceTag, SUBJECT_KEYS, tagWord, TIMED, timeOf, UNTIMED,
} from "./search-scan.js";
import { forEachVocabularyWord, phrase, says, skeletonOf, STRUCTURE_KEYS, vocabularyOf } from "./search-words.js";
import { refused } from "./refusal.js";
import { READ_TOO_BROAD, Work } from "./work.js";
import { comboKeys, FACTS_FORMAT, FACTS_SCHEMA, factsBuild, FactsLayer, rebuildFacts, type Cite, type Claim } from "./index-layers.js";

export type { Reached, SearchCursor } from "./search-scan.js";
export { comboKeys } from "./index-layers.js";


export const FORMAT = "18";
const MENTIONS = 200;
const BUSY_MS = 60_000;
const CACHE_KB = 131_072;
const READ_WAIT_MS = 5_000;
const META = "SELECT value FROM meta WHERE key = ?";
const WHOLE = Number.MAX_SAFE_INTEGER - 1;
const MARK_WAIT_MS = 100;
const STATES_BATCH = 1_000;
const STATED_SQL = "f.fid, f.id, f.of, f.day, f.record, f.start_ms, f.end_ms, f.date_only, c.keys, w.handles AS who";
const STATED_FROM = "fact f JOIN combos c ON c.id = f.combo LEFT JOIN crews w ON w.id = f.crew";
const BY_REF = "account = ? AND kind = ? AND key = ? AND source = ?";
const byRef = (ref: RecordRef): [string, string, string, string] => [accountOf(ref.source), ref.kind, ref.key, ref.source];

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE names (
  id INTEGER PRIMARY KEY, role TEXT NOT NULL, name TEXT NOT NULL,  -- role: family, kind, product, title or layer; or value, a fact's key's
  n INTEGER NOT NULL,            -- the entries that name it; a value's, the facts
  detail INTEGER NOT NULL DEFAULT 0,  -- a value's facts that state it under a key that is not structure (STRUCTURE_KEYS): marked while one does
  UNIQUE (role, name)
) STRICT;
CREATE TABLE entries (
  slot    INTEGER PRIMARY KEY,
  head    INTEGER NOT NULL,      -- the record's id, or the atom's id negated
  family INTEGER, kind INTEGER, product INTEGER, title INTEGER, layer INTEGER NOT NULL,  -- names
  dated INTEGER NOT NULL,          -- 1: its time is a date with no clock, its slot its first date's civil day's start (#placed)
  last INTEGER                     -- with a date: its last date's civil day's start (#placed), past its slot's when it holds several; else null
) STRICT;
CREATE INDEX entries_dated ON entries(dated);  -- each kind's entries by slot: a place's stretch that keeps one kind walks it alone
CREATE TABLE records (
  id INTEGER PRIMARY KEY, source TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, version TEXT NOT NULL, family TEXT NOT NULL,
  account TEXT NOT NULL,         -- its source's account, <product>:<account> (core accountOf): copies fold inside one
  start_ms INTEGER, end_ms INTEGER,
  hash TEXT NOT NULL,            -- the digest of its title and text: copies of one record in one account are one entry by it
  title TEXT NOT NULL, text TEXT NOT NULL, who TEXT NOT NULL, link TEXT,
  dated INTEGER NOT NULL,        -- 1: its time is a date with no clock
  entry INTEGER
) STRICT;
-- A record's copies in its account, and the record itself: by its ref (BY_REF) it is the copy of its account, kind and key
-- whose source it names, a walk of the few rows that share them. One index for both: a second, by source, kind and key,
-- held every ref of the file again (measured: 313 MB of a 7.5 GB file) for the writer alone.
CREATE INDEX records_copy ON records(account, kind, key, hash);
CREATE TABLE atoms (
  id INTEGER PRIMARY KEY, day TEXT NOT NULL, n INTEGER NOT NULL, family TEXT NOT NULL, unit TEXT NOT NULL, item TEXT,
  source TEXT, kind TEXT, key TEXT, start_ms INTEGER, end_ms INTEGER, title TEXT NOT NULL, line TEXT NOT NULL,
  names TEXT, title_names TEXT,  -- the names the line and the title printed, JSON [{start, end, who}]; null for none
  dated INTEGER NOT NULL,        -- 1: a line with no clock (its day file's date_only)
  chat TEXT,                     -- the chat the line is a message or a turn of, as its day file states it; null for none
  pictures INTEGER,              -- how many pictures the thing it prints holds, as its day file states it; null for none
  sender TEXT,                   -- the handles its facts state in the role sender, sorted, joined by char(30); null for none
  same TEXT NOT NULL,            -- what makes it the same atom on a day rendered again: everything but its number
  entry INTEGER
) STRICT;
CREATE INDEX atoms_at ON atoms(day, n);
-- A day line by its identity (refs.ts lineRef): its same, and its ordinal among the day's atoms with it, one seek.
CREATE INDEX atoms_same ON atoms(day, same, n);
CREATE INDEX atoms_record ON atoms(source, kind, key) WHERE source IS NOT NULL;
-- What the index holds of each day (the header's): the render it read, by its inputs and its file's time; inputs '' for none,
-- at -1 when an erasure took it, at its file's time when that file is another renderer's (unread).
CREATE TABLE days (day TEXT PRIMARY KEY, inputs TEXT NOT NULL, mtime_us INTEGER NOT NULL) STRICT;
CREATE VIRTUAL TABLE fts USING fts5(title, line, text, who, tags, content = '', contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 2', prefix = '3');
-- The vocabulary's words under their consonant skeletons (skeletonOf), each while an entry holds it in its own words: what a
-- query word's near spellings are found among. Owned by the full-text table: written with
-- an entry that brings a new word, gone in the transaction that removes its last entry.
CREATE TABLE skeletons (word TEXT PRIMARY KEY, skeleton TEXT NOT NULL) STRICT, WITHOUT ROWID;
CREATE INDEX skeletons_of ON skeletons(skeleton);
CREATE TABLE unmarked (n INTEGER PRIMARY KEY AUTOINCREMENT, slot INTEGER NOT NULL UNIQUE) STRICT;  -- the entries whose texts' marks are not kept yet
CREATE TABLE unmarked_values (n INTEGER PRIMARY KEY AUTOINCREMENT, name INTEGER NOT NULL UNIQUE) STRICT;  -- the key values (names, detail > 0) whose marks are not kept yet
-- The entries written while the facts layer made again in place had a day unread (facts_owed): their chats' tags and an
-- atom's people were read from a layer not read through. Once the last day is read, the fill writes them again a batch a
-- transaction (#refresh), states_owed held until the last. Of the words, so a layer made again before it was read through keeps them.
CREATE TABLE facts_stale (slot INTEGER PRIMARY KEY) STRICT;
`;

export function searchFileOf(root: string, machine: string): string {
  return join(machine, "search", readHome(root).id, "index.db");
}

function stemOf(file: string): string {
  return basename(file).replace(/\.db$/u, "");
}

export function buildingFileOf(file: string): string {
  return join(dirname(file), `${stemOf(file)}.${FORMAT}.building.db`);
}

function buildsBeside(file: string): { path: string; format: string | undefined }[] {
  let names: string[];
  try {
    names = readdirSync(dirname(file));
  } catch {
    return [];
  }
  const named = new RegExp(`^${stemOf(file).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\.(?:(\\d+)\\.)?building\\.db(?:-wal|-shm)?$`, "u");
  return names.flatMap((name) => {
    const found = named.exec(name);
    return found === null ? [] : [{ path: join(dirname(file), name), format: found[1] }];
  });
}

function deadBuilds(file: string): string[] {
  return buildsBeside(file).filter((build) => build.format === undefined || Number(build.format) < Number(FORMAT)).map((build) => build.path);
}

function otherBuilds(file: string): string[] {
  return buildsBeside(file).filter((build) => build.format !== FORMAT).map((build) => build.path);
}

export interface IndexPosition {
  seq: number;
  statement: string | null;
  reread: number;
}

export function statementName(statement: RecordRef & { version: string }): string {
  return createHash("sha256").update(`${statement.source}\0${statement.kind}\0${statement.key}\0${statement.version}`).digest("hex").slice(0, 16);
}

export interface Texts {
  sources: string[];
  owners: Record<string, string>;
}

interface Rereading {
  source: string;
  kind: string;
  after: string;
}

export interface RecordEntry {
  record: RecordRef;
  family: string;
  version: string;
  start_ms: number | null;
  end_ms: number | null;
  title: string;
  text: string;
  who: string[];
  link: string | null;
  dated?: boolean;
}

export interface IndexedDay {
  inputs: string;
  mtime_us: number;
  atoms: readonly AtomEntry[];
  facts?: { window: { start_ms: number; end_ms: number }; facts: readonly DayFileFact[] } | undefined;
  still?: () => boolean;
}

const ERASED_US = -1;

export interface RecordRead {
  readonly clock: DaySettings;
  readonly revision: string;
  readonly file: string;
  readonly factsBuild: string;
  readonly seq: number;
  held(from: string, to: string, within?: Work): HeldDays;
  building(): { days: number | null } | null;
  search(query: SearchQuery): SearchAnswer;
  kinds(query: SearchQuery, shape: KindsShape, familyOf: (stored: string) => string): KindsFound;
  sittingLines(units: readonly { unit: string; first_ms: number }[]): Map<string, string>;
  units(query: SearchQuery): { units: UnitFound[]; whole: boolean };
  unitsSaid(query: SearchQuery, slots: readonly number[]): Map<number, string>;
  facts<T>(work: (read: FactsRead) => T, within?: Work): T;
  mentions(phrases: readonly string[], range: { from_ms: number; to_ms: number }, out: { families: readonly string[]; products: readonly string[]; kinds: readonly string[]; words: readonly string[] }): Mention[];
  recordCount(): number;
  holding(word: string, most: number): number;
  attached(name: string): AttachedRead | undefined;
}

export interface AttachedRead {
  meta(key: string): string | undefined;
  rows<T>(table: string, columns: string, order: string, raw?: boolean): T[];
}

export const LINE_ACCOUNTS = "SELECT accounts FROM line_accounts WHERE day = ? AND atom = ?";

export function lineAccountsOf(stated: string | undefined, source: string | null): string[] | null {
  if (stated === undefined) return source === null ? null : [accountOf(source)];
  const accounts = stated.split("\x1e").filter((account) => account !== "");
  return accounts.length === 0 ? null : accounts;
}

export interface Metered {
  readonly work: Work;
  readonly clock: DaySettings;
  walk<T>(sql: string, params: readonly unknown[], limit: number, by?: Work): { rows: T[]; more: boolean };
  point<T>(sql: string, params: readonly unknown[], by?: Work): T | undefined;
  meta(key: string): string | undefined;
}

export interface FactsRead extends RecordRead, Metered {
  wordFacts(match: string, of: string, passages: boolean, range: WalkRange, budget: number, newest: boolean, within?: WordsWithin): WordFacts;
  people(of: string): boolean;
  values(of: string, key: string, value?: string, by?: Work): { name: number; value: string }[];
  families(leftOut: readonly string[], gate?: SearchGate): { family: string; first?: string }[];
}

export interface WordsWithin {
  chats?: readonly string[];
  families?: readonly string[];
}

export interface AtomEntry {
  n: number;
  family: string;
  unit: string;
  item?: string;
  record?: RecordRef;
  start_ms: number | null;
  end_ms: number | null;
  text: string;
  names?: NameSpan[];
  title?: string;
  title_names?: NameSpan[];
  dated?: boolean;
  chat?: string;
  pictures?: number;
  sender?: readonly string[];
  accounts?: readonly string[];
}

export interface Passage {
  text: string;
  names: NameSpan[];
}

export interface Against {
  store: string;
  model: string | null;
}

export interface Unmarked {
  of: "entry" | "value";
  n: number;
  texts: string[];
}

export interface Mention {
  record: RecordRef;
  product: string;
  family: string;
  start_ms: number;
  title: string;
  text: string;
}

interface Copy {
  account: string;
  kind: string;
  key: string;
  hash: string;
}

export interface RecordRow {
  id: number;
  source: string;
  account: string;
  kind: string;
  key: string;
  version: string;
  family: string;
  start_ms: number | null;
  end_ms: number | null;
  hash: string;
  title: string;
  text: string;
  who: string;
  link: string | null;
  dated: number;
  entry: number | null;
}

export interface AtomRow {
  id: number;
  day: string;
  n: number;
  family: string;
  unit: string;
  item: string | null;
  source: string | null;
  kind: string | null;
  key: string | null;
  start_ms: number | null;
  end_ms: number | null;
  title: string;
  line: string;
  names: string | null;
  title_names: string | null;
  dated: number;
  chat: string | null;
  pictures: number | null;
  sender: string | null;
  same: string;
  entry: number | null;
}

export interface WalkRange {
  from_ms?: number;
  to_ms: number;
}

export type WalkEnd = { whole: true } | { whole: false; from: number } | { whole: false; to: number } | { whole: false; untimed: true };

export interface WordFacts {
  facts: Map<string, Passage[]>;
  slots: Map<string, number[]>;
  slack?: Slack;
  end: WalkEnd;
}

function reachWindow(range: WalkRange, slack: Slack): [number, number] {
  const lo = range.from_ms === undefined ? TIMED : Math.max(TIMED, (range.from_ms - slack.before) * 1000);
  const reach = range.to_ms + slack.after;
  return [lo, reach >= MAX_MS ? Number.MAX_SAFE_INTEGER : reach * 1000];
}

export function reaches(slot: number, range: WalkRange, slack: Slack | undefined): boolean {
  if (slot < TIMED) return true;
  if (slack === undefined) return false;
  const [lo, hi] = reachWindow(range, slack);
  return lo <= slot && slot < hi;
}

export const WORDS_ROWS = 100_000;
const REACH_SHARE = 8;
const REACH_NEWEST = "SELECT rowid AS slot FROM fts WHERE fts MATCH ? AND rowid >= ? AND rowid < ? ORDER BY rowid DESC LIMIT ?";
const REACH_OLDEST = "SELECT rowid AS slot FROM fts WHERE fts MATCH ? AND rowid >= ? AND rowid < ? ORDER BY rowid ASC LIMIT ?";

function stepOf(budget: number): number {
  return Math.max(1, Math.floor(budget / REACH_SHARE));
}
const unit = (work: Work): number => Math.max(1, work.left);

interface Touched {
  slots: Set<number>;
  groups: Map<string, Copy>;
  fresh: Map<string, Omit<RecordRow, "id" | "entry"> | Map<string, Omit<RecordRow, "id" | "entry">>>;
  seenKeys: Set<string>;
  titles: Map<string, number>;
  atoms: Set<number>;
  named: Map<number, number>;
  changed: boolean;
  gone: Set<string>;
  added: Set<string>;
  slack: Map<string, Slack>;
  untimed: Map<string, number>;
  entries: number;
  unstated: number;
  span?: number;
  remaking?: boolean;
  emptyRecords?: boolean;
}

interface Stated {
  fid: number;
  id: string;
  of: string;
  day: string;
  record: string | null;
  start_ms: number;
  end_ms: number;
  date_only: number;
  chat: string | null;
  who: string | null;
}

type StatedRow = Omit<Stated, "chat"> & { keys: string };

interface EntryStates {
  accounts: string;
  who: string | null;
  chat: string | null;
}

function statedOf(get: (sql: string) => Database.Statement, { keys, ...row }: StatedRow): Stated {
  const chat = comboKeys(keys).find(([key]) => key === SUBJECT_KEYS[0])?.[1];
  return { ...row, chat: chat === undefined ? null : (get("SELECT name FROM names WHERE id = ?").pluck().get(chat) as string | undefined) ?? null };
}

type Changes = Map<string, { was?: Stated; is?: Stated }> & { printing: Map<string, { id: number; entry: number | null }[]> };

export interface Slack {
  before: number;
  after: number;
}

const NAMED = ["family", "kind", "product", "title", "layer"] as const;
const NAMED_LIST = NAMED.join(", ");
const INSERT_ENTRY_SQL = `INSERT INTO entries (slot, head, dated, last, ${NAMED_LIST}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const SELECT_NAMED_SQL = `SELECT ${NAMED_LIST} FROM entries WHERE slot = ?`;
const SELECT_BY_REF_SQL = `SELECT id, account, kind, key, hash, entry, title, text FROM records WHERE ${BY_REF}`;
const EXISTS_BY_COPY_SQL = "SELECT 1 FROM records WHERE account = ? AND kind = ? AND key = ? LIMIT 1";
const INSERT_RECORD_SQL = "INSERT INTO records (source, kind, key, account, version, family, start_ms, end_ms, hash, title, text, who, link, dated) VALUES (@source, @kind, @key, @account, @version, @family, @start_ms, @end_ms, @hash, @title, @text, @who, @link, @dated)";
const INSERT_RECORD_WITH_ENTRY_SQL = "INSERT INTO records (source, kind, key, account, version, family, start_ms, end_ms, hash, title, text, who, link, dated, entry) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
const UPDATE_RECORD_SQL = "UPDATE records SET version = @version, family = @family, start_ms = @start_ms, end_ms = @end_ms, hash = @hash, title = @title, text = @text, who = @who, link = @link, dated = @dated WHERE id = @id";
export type Named = (typeof NAMED)[number];

interface SlotState {
  max: number;
  min: number;
  untimed: number | null;
  occupied?: Map<number, number>;
}

interface FlushStatements {
  entry: Database.Statement;
  fts: Database.Statement;
  unmarked: Database.Statement;
  skeleton: Database.Statement;
  states: Database.Statement;
}

export class SearchIndex {
  readonly #statements = new Map<string, Database.Statement>();
  readonly #meteredStatements = new Map<string, Database.Statement>();
  readonly #names = new Map<string, number>();
  readonly #knownWords = new Set<string>();
  #knownVersion: number | undefined;
  #work: Work | undefined;
  #read: RecordRead | undefined;
  #within: Work | undefined;
  #clock: DaySettings | undefined;
  readonly #spent = { write_ms: 0, commit_ms: 0 };

  private constructor(
    private readonly folder: HomeFolder,
    private readonly db: Database.Database,
    private readonly target?: string,
  ) {}

  static write(folder: HomeFolder, file: string, fits: (position: IndexPosition, building: boolean) => boolean, reread: number, clock: DaySettings): SearchIndex {
    mkdirSync(dirname(file), { recursive: true });
    for (const dead of deadBuilds(file)) rmSync(dead, { force: true });
    const building = buildingFileOf(file);
    const resumed = SearchIndex.#fitting(folder, building, fits, clock, file);
    if (resumed !== undefined) return resumed;
    const whole = SearchIndex.#fitting(folder, file, fits, clock);
    removeFile(building);
    return whole ?? SearchIndex.#create(folder, building, file, reread, clock);
  }

  static #create(folder: HomeFolder, path: string, target: string, reread: number, clock: DaySettings): SearchIndex {
    const index = new SearchIndex(folder, open(folder, path, false, false, false), target);
    index.db.exec(SCHEMA);
    index.db.exec(FACTS_SCHEMA);
    index.db.transaction(() => {
      index.#setMeta("format", FORMAT);
      index.#setMeta("facts_format", FACTS_FORMAT);
      index.#setMeta("facts_build", factsBuild());
      index.#setMeta("clock", clockName(clock));
      index.#setMeta("id", randomUUID());
      index.#setMeta("position", JSON.stringify({ seq: 0, statement: null, reread } satisfies IndexPosition));
      index.#setMeta("texts", JSON.stringify({ sources: [], owners: {} } satisfies Texts));
      index.#setMeta("entries", "0");
      index.#setMeta("unstated", "0");
    })();
    return index;
  }

  static #fitting(folder: HomeFolder, path: string, fits: (position: IndexPosition, building: boolean) => boolean, clock: DaySettings, whole?: string): SearchIndex | undefined {
    const index = SearchIndex.#open(folder, path, false, whole);
    if (index === undefined) return undefined;
    const position = index.position();
    if (position !== undefined && index.#meta("clock") === clockName(clock) && fits(position, whole !== undefined)) {
      if (index.#meta("unstated") === undefined) index.db.transaction(() => index.#count()).immediate();
      if (index.#meta("facts_format") !== FACTS_FORMAT) {
        index.db.transaction(() => {
          rebuildFacts(index.db);
          index.#setMeta("revision", String(index.#changes() + 1));
        }).immediate();
      }
      return index;
    }
    index.close();
    return undefined;
  }

  static existing(folder: HomeFolder, file: string): SearchIndex[] {
    for (const other of otherBuilds(file)) rmSync(other, { force: true });
    return ([[file, undefined], [buildingFileOf(file), file]] as const).flatMap(([path, whole]) => {
      const index = SearchIndex.#open(folder, path, false, whole);
      if (index !== undefined) return [index];
      removeFile(path);
      return [];
    });
  }

  static read(folder: HomeFolder, file: string, waitMs?: number): SearchIndex | undefined {
    return SearchIndex.#open(folder, file, true, undefined, waitMs);
  }

  static marking(folder: HomeFolder, file: string): SearchIndex | undefined {
    return SearchIndex.#open(folder, file, false, undefined, MARK_WAIT_MS);
  }

  static #open(folder: HomeFolder, path: string, readonly: boolean, whole?: string, waitMs?: number): SearchIndex | undefined {
    let db: Database.Database;
    try {
      db = open(folder, path, readonly, true, whole === undefined, waitMs);
    } catch (error) {
      if (isSqliteError(error) && (error.code === "SQLITE_CANTOPEN" || error.code === "SQLITE_NOTADB")) return undefined;
      if (error instanceof TypeError && error.message.includes("directory does not exist")) return undefined;
      throw error;
    }
    const index = new SearchIndex(folder, db, whole);
    if (index.#meta("format") === FORMAT) return index;
    index.close();
    return undefined;
  }

  get file(): string {
    return this.db.name;
  }

  get building(): boolean {
    return this.target !== undefined;
  }

  get clock(): DaySettings {
    return this.#clock ??= JSON.parse(this.#meta("clock")!) as DaySettings;
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  finish(): void {
    if (this.target === undefined) return;
    const built = buildingFileOf(this.target);
    const [folded] = this.db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
    if (folded!.busy !== 0) throw new Error(`the build ${built} could not fold its log in before it is published: a reader held it`);
    this.db.close();
    for (const suffix of ["-wal", "-shm"]) rmSync(`${this.target}${suffix}`, { force: true });
    renameSync(built, this.target);
    flush(dirname(this.target));
    for (const suffix of ["-wal", "-shm"]) rmSync(`${built}${suffix}`, { force: true });
    this.close();
  }

  position(): IndexPosition | undefined {
    return this.#json<IndexPosition>("position");
  }

  follow(texts: Texts): void {
    const stated = this.#meta("texts");
    if (stated === JSON.stringify(texts)) return;
    const stored = stated === undefined ? undefined : JSON.parse(stated) as Texts;
    this.#change((touched) => {
      if (stored !== undefined) {
        const rereading = this.#json<Record<string, string>>("rereading") ?? {};
        const known = new Set(stored.sources);
        const pairs = new Set([...Object.keys(stored.owners), ...Object.keys(texts.owners)]);
        for (const pair of pairs) {
          const [source, kind] = pair.split("\0") as [string, string];
          if (!known.has(source) || (stored.owners[pair] ?? "") === (texts.owners[pair] ?? "")) continue;
          if (texts.owners[pair] !== undefined) {
            rereading[pair] = "";
            continue;
          }
          delete rereading[pair];
          const keys = this.#get("SELECT key FROM records WHERE account = ? AND kind = ? AND source = ?").pluck().all(accountOf(source), kind, source) as string[];
          for (const key of keys) this.#drop({ source, kind, key }, touched);
        }
        this.#setMeta("rereading", JSON.stringify(rereading));
      }
      this.#setMeta("texts", JSON.stringify(texts));
    });
  }

  rereading(): Rereading[] {
    return Object.entries(this.#json<Record<string, string>>("rereading") ?? {}).sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([pair, after]) => ({ source: pair.slice(0, pair.indexOf("\0")), kind: pair.slice(pair.indexOf("\0") + 1), after }));
  }

  versions(records: readonly RecordRef[]): Map<string, string> {
    const select = this.#get(`SELECT version FROM records WHERE ${BY_REF}`).pluck();
    const found = new Map<string, string>();
    for (const record of records) {
      const version = select.get(...byRef(record)) as string | undefined;
      if (version !== undefined) found.set(refName(record), version);
    }
    return found;
  }

  records(puts: readonly RecordEntry[], removes: readonly RecordRef[], to: { position: IndexPosition } | { rereading: Rereading; after: string | null }, told = false): void {
    this.#change((touched) => {
      for (const record of removes) this.#drop(record, touched);
      for (const entry of puts) this.#put(entry, touched, true);
      if ("position" in to) {
        this.#setMeta("position", JSON.stringify(to.position));
        return;
      }
      const rereading = this.#json<Record<string, string>>("rereading") ?? {};
      const pair = `${to.rereading.source}\0${to.rereading.kind}`;
      if (to.after === null) delete rereading[pair];
      else rereading[pair] = to.after;
      this.#setMeta("rereading", JSON.stringify(rereading));
    }, told);
  }

  told(): IndexPosition | undefined {
    this.#change(() => {}, true);
    return this.position();
  }

  spent(): { write_ms: number; commit_ms: number } {
    return { ...this.#spent };
  }

  days(): Map<string, { inputs: string; mtime_us: number }> {
    const rows = this.#get("SELECT day, inputs, mtime_us FROM days").all() as { day: string; inputs: string; mtime_us: number }[];
    return new Map(rows.map((row) => [row.day, { inputs: row.inputs, mtime_us: row.mtime_us }]));
  }

  #heldDays(from: string, to: string): HeldDays {
    const { rows, more } = this.#walk<{ day: string; inputs: string; mtime_us: number }>("SELECT day, inputs, mtime_us FROM days WHERE day >= ? AND day <= ? ORDER BY day DESC LIMIT ?", [from, to], WHOLE);
    const read = !more ? from : rows.length === 0 ? addDays(to, 1) : rows.at(-1)!.day;
    return { from: read, to, days: new Map(rows.reverse().map((row) => [row.day, { inputs: row.inputs, erased: row.inputs === "" && row.mtime_us === ERASED_US }])) };
  }

  revision(): string {
    return `${this.#meta("id")}:${this.#changes()}`;
  }

  #changes(): number {
    return Number(this.#meta("revision") ?? "0");
  }

  touchDay(day: string, indexed: IndexedDay): void {
    this.#change((touched) => {
      const held = this.#get("SELECT inputs FROM days WHERE day = ?").pluck().get(day) as string | undefined;
      if (indexed.still?.() === false || held === undefined || held === "") return;
      const holder = this.#get("SELECT f.day, d.mtime_us FROM fact f LEFT JOIN days d ON d.day = f.day WHERE f.id = ?");
      const { window, facts } = indexed.facts ?? { window: { start_ms: 0, end_ms: 0 }, facts: [] };
      const stamp = indexed.mtime_us;
      const taken = facts.some((fact) => {
        if (!claims(fact, window)) return false;
        const held = holder.get(fact.id) as { day: string; mtime_us: number | null } | undefined;
        return held === undefined || (held.day !== day && outdates(day, stamp, held));
      });
      const lost = !taken && this.#get(`SELECT 1 FROM fact f JOIN fact_rival r ON r.id = f.id JOIN days d ON d.day = r.day
        WHERE f.day = ? AND json_extract(r.claim, '$.cite') IS NULL AND (d.mtime_us > ? OR (d.mtime_us = ? AND r.day > ?)) LIMIT 1`).get(day, stamp, stamp, day) !== undefined;
      if (taken || lost) this.#day(day, indexed, touched);
      else this.#get("UPDATE days SET mtime_us = ? WHERE day = ?").run(stamp, day);
    });
  }

  day(day: string, indexed: IndexedDay | null, reread?: (records: readonly RecordRef[]) => readonly RecordEntry[]): boolean {
    let written = false;
    this.#change((touched) => {
      if (indexed?.still?.() === false) return;
      const records = this.#day(day, indexed, touched);
      written = true;
      if (reread === undefined || records.length === 0) return;
      const puts = new Map(reread(records).map((entry) => [refName(entry.record), entry]));
      for (const record of records) {
        const hash = this.#get(`SELECT hash FROM records WHERE ${BY_REF}`).pluck().get(...byRef(record)) as string | undefined;
        const entry = puts.get(refName(record));
        if (entry === undefined ? hash === undefined : hash === wordsHash(entry.title, entry.text)) continue;
        if (entry === undefined) this.#drop(record, touched);
        else this.#put(entry, touched);
      }
    });
    return written;
  }

  putDays(entries: readonly { day: string; indexed: IndexedDay | null }[]): void {
    if (entries.length === 0) return;
    this.#change((touched) => {
      for (const { day, indexed } of entries) {
        if (indexed?.still?.() === false) continue;
        this.#day(day, indexed, touched);
      }
    });
  }

  factsDay(day: string, indexed: IndexedDay): boolean {
    let written = false;
    this.#change((touched) => {
      if (indexed.still?.() === false) return;
      if (this.#get("DELETE FROM facts_owed WHERE day = ? RETURNING day").pluck().get(day) === undefined) return;
      touched.changed = true;
      written = true;
      const slots = new Set<number>();
      const printed = this.#printed(day);
      const changes = this.#facts(day, indexed, false, touched);
      const now = this.#printed(day);
      const entryOf = this.#get("SELECT entry FROM atoms WHERE id = ?").pluck();
      for (const id of new Set([...printed.keys(), ...now.keys()])) {
        if (printed.get(id) === now.get(id)) continue;
        const entry = entryOf.get(id) as number | null | undefined;
        if (entry !== undefined && entry !== null) slots.add(entry);
      }
      for (const [fact, { was, is }] of changes) {
        for (const record of new Set([was?.record ?? null, is?.record ?? null])) {
          const entry = record === null ? undefined : this.#heldRecord(record)?.entry;
          if (entry !== undefined && entry !== null) slots.add(entry);
        }
        for (const { entry } of changes.printing.get(fact) ?? []) if (entry !== null) slots.add(entry);
      }
      const unstated = this.#get("SELECT DISTINCT a.entry FROM atoms a WHERE a.day = ? AND a.entry IS NOT NULL AND NOT EXISTS (SELECT 1 FROM entry_states x WHERE x.slot = a.entry)");
      for (const slot of unstated.pluck().all(day) as number[]) slots.add(slot);
      const head = this.#get("SELECT head FROM entries WHERE slot = ?").pluck();
      for (const slot of slots) {
        const at = head.get(slot) as number | undefined;
        if (at === undefined) continue;
        const { copies, atoms } = this.#heldBy(at);
        const facts = this.#statedBy(copies, atoms);
        unstate((sql) => this.#get(sql), touched, slot);
        state((sql) => this.#get(sql), touched, slot, facts, this.#statesOf(copies, atoms, facts));
      }
    });
    return written;
  }

  factsOwed(most?: number): string[] {
    return this.#get("SELECT day FROM facts_owed ORDER BY day DESC LIMIT ?").pluck().all(most ?? -1) as string[];
  }

  factsHeld(): boolean {
    return this.#meta("facts_format") === FACTS_FORMAT;
  }

  #building(): { days: number | null } | null {
    return this.#owed(() => this.#walk<{ day: string }>("SELECT day FROM facts_owed WHERE day >= ? ORDER BY day LIMIT ?", [""], WHOLE).rows.length);
  }

  #owed(daysLeft: () => number): { days: number | null } | null {
    if (!this.factsHeld()) return { days: null };
    const left = daysLeft();
    if (left > 0) return { days: left };
    return this.statesOwed() ? { days: null } : null;
  }

  statesOwed(): boolean {
    return this.#meta("states_owed") !== undefined;
  }

  fillStates(most = STATES_BATCH): boolean {
    let filled = false;
    this.#change((touched) => {
      if (this.#get("SELECT 1 FROM facts_owed LIMIT 1").pluck().get() !== undefined) return;
      const refreshed = this.#refresh(touched, most);
      if (refreshed > 0) touched.changed = filled = true;
      const from = this.#meta("states_owed");
      if (from === undefined || refreshed === most) return;
      touched.changed = true;
      filled = true;
      const batch = this.#get(`SELECT slot, head FROM entries e WHERE slot >= ? AND NOT EXISTS (SELECT 1 FROM entry_states x WHERE x.slot = e.slot)
        ORDER BY slot LIMIT ?`).all(Number(from), most - refreshed) as { slot: number; head: number }[];
      for (const { slot, head } of batch) {
        const { copies, atoms } = this.#heldBy(head);
        stateRow((sql) => this.#get(sql), touched, slot, this.#statesOf(copies, atoms, this.#statedBy(copies, atoms)));
      }
      if (batch.length < most - refreshed) this.#get("DELETE FROM meta WHERE key = 'states_owed'").run();
      else this.#setMeta("states_owed", String(batch[batch.length - 1]!.slot + 1));
    });
    return filled;
  }

  static progress(folder: HomeFolder, file: string): { read: number } {
    const build = SearchIndex.#open(folder, buildingFileOf(file), true);
    if (build === undefined) return { read: 0 };
    try {
      return { read: build.position()?.seq ?? 0 };
    } finally {
      build.close();
    }
  }

  #day(day: string, indexed: IndexedDay | null, touched: Touched, none?: "erased" | "unread", erased = false): RecordRef[] {
    touched.changed = true;
    const printed = this.#printed(day);
    const changes = this.#facts(day, indexed, erased, touched);
    const held = new Map<string, AtomRow[]>();
    const enriched = new Map<string, RecordRef>();
    for (const row of this.#get("SELECT * FROM atoms WHERE day = ?").all(day) as AtomRow[]) {
      const rows = held.get(row.same);
      if (rows === undefined) held.set(row.same, [row]);
      else rows.push(row);
    }
    for (const atom of indexed?.atoms ?? []) {
      const row = atomRow(day, atom);
      const kept = held.get(row.same)?.shift();
      if (kept !== undefined) {
        if (kept.n !== atom.n) this.#get("UPDATE atoms SET n = ? WHERE id = ?").run(atom.n, kept.id);
        continue;
      }
      const id = Number(this.#get(`
        INSERT INTO atoms (day, n, family, unit, item, source, kind, key, start_ms, end_ms, title, line, names, title_names, dated, chat, pictures, sender, same)
        VALUES (@day, @n, @family, @unit, @item, @source, @kind, @key, @start_ms, @end_ms, @title, @line, @names, @title_names, @dated, @chat, @pictures, @sender, @same)
      `).run(row).lastInsertRowid);
      this.#touchAtom({ ...row, id, entry: null }, touched);
      if (atom.item !== undefined && atom.record !== undefined) enriched.set(refName(atom.record), atom.record);
    }
    for (const row of [...held.values()].flat()) {
      gone(touched, row.title, row.line);
      this.#get("DELETE FROM atoms WHERE id = ?").run(row.id);
      this.#touchAtom(row, touched);
    }
    const now = this.#printed(day);
    for (const [id, facts] of printed) if (now.get(id) !== facts) touched.atoms.add(id);
    for (const [id, facts] of now) if (printed.get(id) !== facts) touched.atoms.add(id);
    this.#dependants(changes, touched);
    this.#get("DELETE FROM facts_owed WHERE day = ?").run(day);
    if (none !== undefined) this.#get("INSERT INTO days (day, inputs, mtime_us) VALUES (?, '', ?) ON CONFLICT (day) DO UPDATE SET inputs = '', mtime_us = excluded.mtime_us").run(day, ERASED_US);
    else if (indexed === null) this.#get("DELETE FROM days WHERE day = ? AND mtime_us <> ?").run(day, ERASED_US);
    else this.#get("INSERT INTO days (day, inputs, mtime_us) VALUES (?, ?, ?) ON CONFLICT (day) DO UPDATE SET inputs = excluded.inputs, mtime_us = excluded.mtime_us").run(day, indexed.inputs, indexed.mtime_us);
    return [...enriched.values()];
  }

  #printed(day: string): Map<number, string> {
    const printed = new Map<number, string[]>();
    for (const { id, fid } of this.#get("SELECT a.id, l.fid FROM fact_line l JOIN atoms a ON a.day = l.day AND a.n = l.atom WHERE l.day = ?").all(day) as { id: number; fid: number }[]) {
      printed.set(id, [...printed.get(id) ?? [], String(fid)]);
    }
    for (const { id, accounts } of this.#get("SELECT a.id, x.accounts FROM line_accounts x JOIN atoms a ON a.day = x.day AND a.n = x.atom WHERE x.day = ?").all(day) as { id: number; accounts: string }[]) {
      printed.set(id, [...printed.get(id) ?? [], `@${accounts}`]);
    }
    return new Map([...printed].map(([id, stated]) => [id, stated.sort().join(",")]));
  }

  #facts(day: string, indexed: IndexedDay | null, erased: boolean, touched: Touched): Changes {
    const changes: Changes = Object.assign(new Map<string, { was?: Stated; is?: Stated }>(), { printing: new Map<string, { id: number; entry: number | null }[]>() });
    const stated = (sql: string, ...params: unknown[]) => (this.#get(sql).all(...params) as StatedRow[]).map((row) => statedOf((each) => this.#get(each), row));
    for (const was of stated(`SELECT ${STATED_SQL} FROM ${STATED_FROM} WHERE f.day = ?`, day)) changes.set(was.id, { was });
    const held = [...changes.keys()];
    const layer = new FactsLayer((sql) => this.#get(sql), (value) => this.#value(value), (key) => STRUCTURE_KEYS.has(key));
    layer.release(day);
    layer.stateLines(day, indexed?.atoms ?? []);
    this.#get("DELETE FROM fact_rival WHERE day = ?").run(day);
    const recount = new Set([day]);
    const arbiter = new Arbiter((sql) => this.#get(sql), recount, changes, layer);
    if (indexed?.facts !== undefined) this.#factsOf(day, indexed.mtime_us, indexed.facts, arbiter);
    if (!erased) for (const fact of held) arbiter.reconcile(fact, day, indexed?.mtime_us);
    const printing = this.#get("SELECT a.id, a.entry FROM fact_line l JOIN atoms a ON a.day = l.day AND a.n = l.atom WHERE l.fid = ?");
    for (const fact of changes.keys()) {
      const fid = layer.fid(fact);
      if (fid !== undefined) changes.printing.set(fact, printing.all(fid) as { id: number; entry: number | null }[]);
    }
    const another = this.#get("SELECT 1 FROM entry_fact e JOIN fact f ON f.fid = e.fid WHERE e.slot = ? AND f.of = ? LIMIT 1").pluck();
    layer.settle((of, slots) => {
      for (const slot of slots) if (slot < TIMED && another.get(slot, of) === undefined) untimed(touched, of, -1);
    });
    for (const each of recount) layer.tally(each);
    layer.prune();
    for (const is of stated(`SELECT ${STATED_SQL} FROM ${STATED_FROM} WHERE f.day = ?`, day)) changes.set(is.id, { ...changes.get(is.id), is });
    for (const [fact, change] of changes) {
      if (change.is !== undefined) continue;
      const [is] = stated(`SELECT ${STATED_SQL} FROM ${STATED_FROM} WHERE f.id = ?`, fact);
      if (is !== undefined) change.is = is;
    }
    return changes;
  }

  #factsOf(day: string, stamp: number, { window, facts }: NonNullable<IndexedDay["facts"]>, arbiter: Arbiter): void {
    const claimed = new Map<string, Claim>();
    const cited = new Map<string, Set<number>>();
    for (const fact of facts) {
      if (!claims(fact, window)) {
        if (fact.lines.length > 0) cited.set(fact.id, new Set([...cited.get(fact.id) ?? [], ...fact.lines]));
        continue;
      }
      const claim = claimOf(fact, fact.date_only === true ? dayBounds(day, this.clock) : undefined);
      const first = claimed.get(fact.id);
      claimed.set(fact.id, first === undefined ? claim : merged(first, claim));
    }
    const rival = this.#get("INSERT INTO fact_rival (id, day, claim) VALUES (?, ?, ?) ON CONFLICT (id, day) DO UPDATE SET claim = excluded.claim");
    for (const [fact, lines] of cited) {
      if (claimed.has(fact)) continue;
      const cite: Cite = { cite: true, lines: [...lines].sort((a, b) => a - b) };
      rival.run(fact, day, JSON.stringify(cite));
      arbiter.layer.rival(fact, day, cite.lines);
    }
    for (const [fact, claim] of claimed) {
      const held = arbiter.holder(fact);
      if (held !== undefined && held.day !== day) {
        if (!outdates(day, stamp, held)) {
          rival.run(fact, day, JSON.stringify(claim));
          arbiter.layer.rival(fact, day, claim.lines);
          continue;
        }
        rival.run(fact, held.day, JSON.stringify(arbiter.layer.held(fact, held.day)));
        arbiter.unseat(held);
      }
      arbiter.install(fact, day, claim);
    }
  }

  #dependants(changes: Changes, touched: Touched): void {
    for (const [fact, { was, is }] of changes) {
      const printing = changes.printing.get(fact) ?? [];
      if (was === undefined || is === undefined || was.record !== is.record || was.chat !== is.chat) {
        for (const record of new Set([was?.record ?? null, is?.record ?? null])) {
          const held = record === null ? undefined : this.#heldRecord(record);
          if (held !== undefined) group(touched, held);
        }
        for (const { id } of printing) touched.atoms.add(id);
        continue;
      }
      if (was.who !== is.who) {
        for (const { id } of printing) touched.atoms.add(id);
        const held = is.record === null ? undefined : this.#heldRecord(is.record);
        if (held !== undefined) group(touched, held);
      }
      if (was.start_ms === is.start_ms && was.end_ms === is.end_ms) continue;
      const slots = new Set(printing.flatMap(({ entry }) => (entry === null ? [] : [entry])));
      const entry = is.record === null ? undefined : this.#heldRecord(is.record)?.entry;
      if (entry !== undefined && entry !== null) slots.add(entry);
      for (const slot of slots) {
        const p = timeOf(slot);
        if (p !== null) grow(touched.slack, is, p);
      }
    }
  }

  #heldRecord(record: string): (Copy & { entry: number | null }) | undefined {
    const [source, kind, key] = record.split("\0") as [string, string, string];
    return this.#get(`SELECT account, kind, key, hash, entry FROM records WHERE ${BY_REF}`).get(...byRef({ source, kind, key })) as (Copy & { entry: number | null }) | undefined;
  }

  #value(value: string): number {
    return this.#get("SELECT id FROM names WHERE role = 'value' AND name = ?").pluck().get(value) as number | undefined
      ?? Number(this.#get("INSERT INTO names (role, name, n) VALUES ('value', ?, 0)").run(value).lastInsertRowid);
  }

  forget(records: readonly RecordRef[], days: readonly string[]): void {
    this.db.pragma("secure_delete = ON");
    try {
      this.#change((touched) => {
        for (const day of days) this.#day(day, null, touched, "erased", true);
        for (const record of records) this.#drop(record, touched);
      }, true);
    } finally {
      this.db.pragma("secure_delete = FAST");
    }
  }

  truncateLog(wait_ms: number): boolean {
    const before = this.db.pragma("busy_timeout", { simple: true }) as number;
    this.db.pragma(`busy_timeout = ${Math.max(0, Math.floor(wait_ms))}`);
    try {
      const [row] = this.db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
      return row!.busy === 0;
    } finally {
      this.db.pragma(`busy_timeout = ${before}`);
    }
  }

  unread(days: ReadonlyMap<string, number>): void {
    this.#change((touched) => {
      const erased = this.#get("SELECT 1 FROM days WHERE day = ? AND inputs = '' AND mtime_us = ?");
      for (const [day, mtime_us] of days) {
        if (erased.get(day, ERASED_US) !== undefined) continue;
        this.#day(day, null, touched, "unread");
        this.#get("UPDATE days SET mtime_us = ? WHERE day = ?").run(mtime_us, day);
      }
    });
  }

  #mentions(phrases: readonly string[], range: { from_ms: number; to_ms: number }, out: { families: readonly string[]; products: readonly string[]; kinds: readonly string[]; words: readonly string[] }): Mention[] {
    const left = [...out.families.map((name) => `f${tagWord(name)}`), ...out.products.map((name) => `p${tagWord(name)}`), ...out.kinds.map((name) => `k${tagWord(name)}`)];
    const not = [...(left.length === 0 ? [] : [`tags : (${left.join(" OR ")})`]), ...(out.words.length === 0 ? [] : [`{title line text} : (${out.words.map(phrase).join(" OR ")})`])];
    const found = new Map<number, Mention>();
    for (const said of new Set(phrases)) {
      if (said.trim() === "") continue;
      const match = `({title line text} : ${phrase(said)}) AND tags : lrecords${not.length === 0 ? "" : ` NOT (${not.join(" OR ")})`}`;
      const rows = this.#walk<Pick<RecordRow, "id" | "source" | "kind" | "key" | "family" | "title" | "text"> & { start_ms: number | null }>(
        "SELECT r.id, r.source, r.kind, r.key, r.family, r.start_ms, r.title, r.text FROM fts f JOIN entries e ON e.slot = f.rowid JOIN records r ON r.id = e.head WHERE fts MATCH ? AND f.rowid >= ? AND f.rowid < ? ORDER BY f.rowid DESC LIMIT ?",
        [match, slotMs(range.from_ms), slotMs(range.to_ms)], MENTIONS).rows;
      for (const row of rows) {
        if (row.start_ms === null || found.has(row.id)) continue;
        found.set(row.id, { record: { source: row.source, kind: row.kind, key: row.key }, product: productOf(row.source), family: row.family, start_ms: row.start_ms, title: row.title, text: row.text });
      }
    }
    return [...found.values()].sort((left, right) => left.start_ms - right.start_ms || (left.record.source < right.record.source ? -1 : 1));
  }


  unmarked(against: Against & { model: string }, most: number): Unmarked[] {
    if (!sameAgainst(this.#json<Against>("marks"), against)) {
      this.db.transaction(() => {
        this.#get("INSERT INTO unmarked (slot) SELECT slot FROM entries WHERE slot NOT IN (SELECT slot FROM unmarked) ORDER BY slot").run();
        this.#get("INSERT INTO unmarked_values (name) SELECT id FROM names WHERE role = 'value' AND detail > 0 AND id NOT IN (SELECT name FROM unmarked_values) ORDER BY id").run();
        this.#setMeta("marks", JSON.stringify(against));
      }).immediate();
    }
    return this.db.transaction(() => {
      const values = (this.#get("SELECT u.n, v.name FROM unmarked_values u JOIN names v ON v.id = u.name ORDER BY u.n DESC LIMIT ?").all(most) as { n: number; name: string }[])
        .map(({ n, name }): Unmarked => ({ of: "value", n, texts: [name] }));
      if (values.length >= most) return values;
      const entries = (this.#get("SELECT u.n, e.head FROM unmarked u JOIN entries e ON e.slot = u.slot ORDER BY u.slot DESC LIMIT ?").all(most - values.length) as { n: number; head: number }[])
        .map(({ n, head }): Unmarked => ({ of: "entry", n, texts: this.#textsOf(head) }));
      return [...values, ...entries];
    })();
  }

  marked(rows: readonly Pick<Unmarked, "of" | "n">[]): void {
    const of = (which: Unmarked["of"]) => JSON.stringify(rows.filter((row) => row.of === which).map((row) => row.n));
    this.db.transaction(() => {
      this.#get("DELETE FROM unmarked WHERE n IN (SELECT value FROM json_each(?))").run(of("entry"));
      this.#get("DELETE FROM unmarked_values WHERE n IN (SELECT value FROM json_each(?))").run(of("value"));
    })();
  }

  markCounts(against: Against): { entries: number; unmarked: number } {
    return this.db.transaction(() => {
      const entries = (this.#get("SELECT coalesce(sum(n), 0) FROM names WHERE role = 'layer'").pluck().get() as number)
        + (this.#get("SELECT count(*) FROM names WHERE role = 'value' AND detail > 0").pluck().get() as number);
      if (!sameAgainst(this.#json<Against>("marks"), against)) return { entries, unmarked: entries };
      return { entries, unmarked: this.#get("SELECT (SELECT count(*) FROM unmarked) + (SELECT count(*) FROM unmarked_values)").pluck().get() as number };
    })();
  }

  textsOf(records: readonly RecordRef[], days: readonly string[]): string[] {
    return this.db.transaction(() => {
      const slots = new Set<number>();
      const ofRecord = this.#get(`SELECT entry FROM records WHERE ${BY_REF}`).pluck();
      for (const record of records) {
        const slot = ofRecord.get(...byRef(record)) as number | null | undefined;
        if (slot !== undefined && slot !== null) slots.add(slot);
      }
      const ofDay = this.#get("SELECT entry FROM atoms WHERE day = ? AND entry IS NOT NULL").pluck();
      for (const day of days) for (const slot of ofDay.all(day) as number[]) slots.add(slot);
      const head = this.#get("SELECT head FROM entries WHERE slot = ?").pluck();
      const erased = new Map<number, number>();
      const combos = this.#get("SELECT c.keys FROM fact f JOIN combos c ON c.id = f.combo WHERE f.day = ?").pluck();
      for (const day of days) {
        for (const keys of combos.all(day) as string[]) for (const [key, name] of comboKeys(keys)) if (!STRUCTURE_KEYS.has(key)) erased.set(name, (erased.get(name) ?? 0) + 1);
      }
      const detail = this.#get("SELECT name, detail FROM names WHERE id = ?");
      const values = [...erased].flatMap(([name, facts]) => {
        const held = detail.get(name) as { name: string; detail: number } | undefined;
        return held !== undefined && held.detail === facts ? [held.name] : [];
      });
      return [...new Set([...[...slots].flatMap((slot) => {
        const found = head.get(slot) as number | undefined;
        return found === undefined ? [] : this.#textsOf(found);
      }), ...values])];
    })();
  }

  #textsOf(head: number): string[] {
    if (head < 0) {
      const atom = this.#get("SELECT * FROM atoms WHERE id = ?").get(-head) as AtomRow | undefined;
      return atom === undefined ? [] : atomPassages(atom).map((passage) => passage.text);
    }
    const first = this.#get("SELECT * FROM records WHERE id = ?").get(head) as RecordRow | undefined;
    if (first === undefined) return [];
    const copies = this.#get("SELECT * FROM records WHERE account = ? AND kind = ? AND key = ? AND hash = ? ORDER BY id").all(first.account, first.kind, first.key, first.hash) as RecordRow[];
    return recordPassages(this.#atomsOf(copies), first).map((passage) => passage.text);
  }

  snapshot<T>(attached: Readonly<Record<string, Attached>>, work: (read: RecordRead) => T): T {
    const held = this.hold(attached);
    try {
      return work(held.read);
    } finally {
      held.end();
    }
  }

  hold(attached: Readonly<Record<string, Attached>>, within?: Work): { read: RecordRead; end(): void } {
    if (this.#read !== undefined) throw new Error("a read of the index inside another: ask the open read's members");
    this.#attach(attached);
    this.db.exec("BEGIN");
    let read: RecordRead;
    try {
      this.#within = within;
      read = this.#handle();
      this.#read = read;
    } catch (error) {
      this.#within = undefined;
      this.db.exec("ROLLBACK");
      throw error;
    }
    return {
      read,
      end: () => {
        if (this.#read !== read) return;
        this.#read = undefined;
        this.#within = undefined;
        if (this.db.inTransaction) this.db.exec("COMMIT");
      },
    };
  }

  #handle(): RecordRead {
    const inRead = (): void => {
      if (this.#read !== read) throw new Error("a member of a read of the index asked outside its read");
    };
    const member = <T>(budget: number, run: (on: Metered) => T, within?: Work): T => {
      inRead();
      return this.#metered(budget, run, inRead, within);
    };
    const guarded = <A extends unknown[], R>(run: (...args: A) => R) => (...args: A): R => {
      inRead();
      return run(...args);
    };
    const attached = new Map<string, AttachedRead | undefined>();
    const read: RecordRead = {
      clock: this.clock, revision: this.revision(), file: this.#meta("id") ?? "", factsBuild: this.#meta("facts_build") ?? "", seq: this.position()?.seq ?? 0,
      held: (from, to, within) => member(Infinity, () => this.#heldDays(from, to), within),
      building: () => member(Infinity, () => this.#building()),
      search: (query) => member(query.group === undefined ? PAGE_ROWS : GROUP_ROWS, (on) => search(on, query)),
      kinds: (query, shape, familyOf) => member(PAGE_ROWS, (on) => kinds(on, query, shape, familyOf)),
      sittingLines: (units) => member(units.length * SITTING_ROWS, (on) => sittingLines(on, units)),
      units: (query) => member(PAGE_ROWS, (on) => sittingUnits(on, query)),
      unitsSaid: (query, slots) => member(PAGE_ROWS, (on) => unitsSaid(on, query, slots)),
      facts: (work, within) => member(Infinity, (on) => work({
        ...read, ...on,
        wordFacts: guarded((match, of, passages, range, budget, newest, within) => this.#wordFacts(inRead, match, of, passages, range, budget, newest, within)),
        people: guarded((of) => this.#people(of)),
        values: guarded((of, key, value, by) => this.#values(of, key, value, by)),
        families: guarded((leftOut, gate) => families(on, leftOut, gate)),
      }), within),
      mentions: (phrases, range, out) => member(Infinity, () => this.#mentions(phrases, range, out)),
      recordCount: () => member(1, () => this.#point<{ n: number }>("SELECT n FROM names WHERE role = 'layer' AND name = 'records'", [])?.n ?? 0),
      holding: (word, most) => member(Infinity, () => this.#walk("SELECT rowid FROM fts WHERE fts MATCH ? LIMIT ?", [`({title line text} : ${phrase(word)}) AND tags : lrecords`], most).rows.length),
      attached: (name) => {
        inRead();
        if (!attached.has(name)) attached.set(name, this.#attachedRead(name, inRead));
        return attached.get(name);
      },
    };
    return read;
  }

  #people(of: string): boolean {
    if (!this.factsHeld()) return false;
    const { rows, more } = this.#walk("SELECT crew FROM tally INDEXED BY tally_crew WHERE of = ? AND crew > ? LIMIT ?", [of, 0], 1);
    if (rows.length === 0 && more) refused("TOO_BROAD", READ_TOO_BROAD);
    return rows.length > 0;
  }

  #values(of: string, key: string, value?: string, by: Work = this.#meter()): { name: number; value: string }[] {
    const walk = <T>(sql: string, params: readonly unknown[], limit: number) => by.walk<T>(this.#prepared(sql), params, limit);
    const point = <T>(sql: string, params: readonly unknown[]) => by.point<T>(this.#prepared(sql), params);
    const counted = (combo: number) => walk("SELECT day FROM tally INDEXED BY tally_combo WHERE of = ? AND combo = ? LIMIT ?", [of, combo], 1).rows.length > 0;
    if (value !== undefined) {
      const id = point<{ id: number }>("SELECT id FROM names WHERE role = 'value' AND name = ?", [value])?.id;
      if (id === undefined) return [];
      const combos = walk<{ combo: number }>("SELECT combo FROM combo_keys WHERE of = ? AND key = ? AND name = ? LIMIT ?", [of, key, id], WHOLE).rows;
      return combos.some(({ combo }) => counted(combo)) ? [{ name: id, value }] : [];
    }
    const named = new Set<number>();
    for (const { name, combo } of walk<{ name: number; combo: number }>("SELECT name, combo FROM combo_keys WHERE of = ? AND key = ? LIMIT ?", [of, key], WHOLE).rows) {
      if (!named.has(name) && counted(combo)) named.add(name);
    }
    return [...named].map((name) => ({ name, value: point<{ name: string }>("SELECT name FROM names WHERE id = ?", [name])?.name ?? "" }));
  }

  #attachedRead(name: string, inRead: () => void): AttachedRead | undefined {
    if (!this.#attached.has(name)) return undefined;
    const schema = `"${name}"`;
    const prepared = (sql: string): Database.Statement => {
      inRead();
      let statement = this.#attachedStatements.get(sql);
      if (statement === undefined) this.#attachedStatements.set(sql, statement = this.db.prepare(sql));
      return statement;
    };
    return {
      meta: (key) => {
        if (prepared(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name = 'meta'`).get() === undefined) return undefined;
        return (prepared(`SELECT value FROM ${schema}.meta WHERE key = ?`).get(key) as { value: string } | undefined)?.value;
      },
      rows: <T>(table: string, columns: string, order: string, raw = false) => prepared(`SELECT ${columns} FROM ${schema}.${table} ORDER BY ${order}`).raw(raw).all() as T[],
    };
  }

  readonly #attachedStatements = new Map<string, Database.Statement>();

  readonly #attached = new Map<string, string>();

  #attach(files: Readonly<Record<string, Attached>>): void {
    for (const [name, file] of [...this.#attached]) {
      if (files[name]?.file === file) continue;
      this.db.exec(`DETACH DATABASE "${name}"`);
      this.#attached.delete(name);
    }
    for (const [name, { kind, file }] of Object.entries(files)) {
      if (this.#attached.has(name) || !existsSync(file)) continue;
      try {
        this.folder.attach(this.db, name, kind, file);
        this.#attached.set(name, file);
      } catch (error) {
        if (!(isSqliteError(error) && error.code === "SQLITE_CANTOPEN")) throw error;
      }
    }
  }

  #wordFacts(inRead: () => void, match: string, of: string, withPassages: boolean, range: WalkRange, budget: number, newest: boolean, within: WordsWithin = {}): WordFacts {
    return this.#metered(budget, () => {
      const found = new Map<string, Passage[]>();
      const slots = new Map<string, number[]>();
      const narrowed = [within.chats?.map(chatTag), within.families?.map((family) => `f${tagWord(family)}`)].filter((tags) => tags !== undefined);
      if (narrowed.some((tags) => tags.length === 0)) return { facts: found, slots, end: { whole: true } };
      const matched = [`(${match})`, ...narrowed.map((tags) => `tags : (${[...new Set(tags)].join(" OR ")})`)].join(" AND ");
      const work = this.#meter();
      const meta = (key: string) => {
        const value = this.#point<{ key: string; value: string }>("SELECT key, value FROM meta WHERE key = ?", [key])?.value;
        return value === undefined ? undefined : JSON.parse(value) as Record<string, unknown>;
      };
      const slack = meta("slack")?.[of] as Slack | undefined;
      const untimed = (meta("untimed")?.[of] as number | undefined) ?? 0;
      const walk = (lo: number, hi: number): number | null => {
        let [bottom, top] = [lo, hi];
        const limit = stepOf(budget);
        for (;;) {
          const step = this.#walk<{ slot: number }>(newest ? REACH_NEWEST : REACH_OLDEST, [matched, bottom, top], limit);
          for (const { slot } of step.rows) {
            if (!this.#stated(slot, of, withPassages, found, slots, work)) return newest ? slot + 1 : slot;
            if (newest) top = slot;
            else bottom = slot + 1;
          }
          if (!step.more) return null;
          if (step.rows.length === 0) return newest ? top : bottom;
        }
      };
      if (untimed > 0 && walk(UNTIMED, TIMED) !== null) return { facts: found, slots, end: { whole: false, untimed: true } };
      if (slack === undefined) return { facts: found, slots, end: { whole: true } };
      const [lo, hi] = reachWindow(range, slack);
      const covered = lo < hi ? walk(lo, hi) : null;
      if (covered === null) return { facts: found, slots, slack, end: { whole: true } };
      return { facts: found, slots, slack, end: newest ? { whole: false, from: Math.ceil(covered / 1000) + slack.before } : { whole: false, to: Math.floor(covered / 1000) - slack.after } };
    }, inRead);
  }

  #stated(slot: number, of: string, withPassages: boolean, found: Map<string, Passage[]>, slots: Map<string, number[]>, work: Work): boolean {
    const stated = this.#walk<{ id: string; of: string }>("SELECT f.id, f.of FROM entry_fact e JOIN fact f ON f.fid = e.fid WHERE e.slot = ? LIMIT ?", [slot], unit(work));
    if (stated.more) return false;
    const facts = { rows: stated.rows.filter((fact) => fact.of === of).map(({ id }) => ({ fact: id })) };
    if (facts.rows.length === 0) return true;
    let passages: Passage[] = [];
    if (withPassages) {
      const read = this.#passagesAt(slot, work);
      if (read === undefined) return false;
      passages = read;
    }
    for (const { fact } of facts.rows) {
      found.set(fact, [...found.get(fact) ?? [], ...passages]);
      slots.set(fact, [...slots.get(fact) ?? [], slot]);
    }
    return true;
  }

  #passagesAt(slot: number, work: Work): Passage[] | undefined {
    if (!work.reserve(2)) return undefined;
    const head = this.#point<{ head: number }>("SELECT head FROM entries WHERE slot = ?", [slot])?.head;
    if (head === undefined) return [];
    if (head < 0) {
      const atom = this.#point<AtomRow>("SELECT * FROM atoms WHERE id = ?", [-head]);
      return atom === undefined ? [] : atomPassages(atom);
    }
    const first = this.#point<RecordRow>("SELECT * FROM records WHERE id = ?", [head]);
    if (first === undefined) return [];
    const copies = this.#walk<RecordRow>("SELECT * FROM records WHERE account = ? AND kind = ? AND key = ? AND hash = ? ORDER BY id LIMIT ?", [first.account, first.kind, first.key, first.hash], unit(work));
    if (copies.more) return undefined;
    const atoms: AtomRow[] = [];
    for (const copy of copies.rows) {
      const printed = this.#walk<AtomRow>("SELECT * FROM atoms WHERE source = ? AND kind = ? AND key = ? ORDER BY id LIMIT ?", [copy.source, copy.kind, copy.key], unit(work));
      if (printed.more) return undefined;
      atoms.push(...printed.rows);
    }
    atoms.sort((left, right) => (left.day < right.day ? -1 : left.day > right.day ? 1 : left.n - right.n));
    return recordPassages(atoms, first);
  }


  #change(work: (touched: Touched) => void, told = false): void {
    const began = performance.now();
    let wrote = 0;
    const raise = told && this.building;
    if (raise) this.db.pragma("synchronous = FULL");
    try {
      let addedWords: Set<string> | undefined;
      let removedWords: string[] | undefined;
      this.db.transaction(() => {
        const inside = performance.now();
        const version = this.db.pragma("data_version", { simple: true }) as number;
        if (this.#knownVersion !== version) {
          this.#knownWords.clear();
          this.#knownVersion = version;
        }
        const touched: Touched = { slots: new Set(), groups: new Map(), fresh: new Map(), seenKeys: new Set(), titles: new Map(), atoms: new Set(), named: new Map(), changed: false, gone: new Set(), added: new Set(), slack: new Map(), untimed: new Map(), entries: 0, unstated: 0 };
        work(touched);
        const seen = touched.changed || touched.slots.size > 0 || touched.groups.size > 0 || touched.fresh.size > 0 || touched.atoms.size > 0;
        removedWords = this.#flush(touched);
        addedWords = touched.added;
        if (seen) this.#setMeta("revision", String(this.#changes() + 1));
        if (told) this.#setMeta("told", String(Number(this.#meta("told") ?? "0") + 1));
        wrote = performance.now() - inside;
      }).immediate();
      if (removedWords !== undefined) for (const word of removedWords) this.#knownWords.delete(word);
      if (addedWords !== undefined) for (const word of addedWords) this.#knownWords.add(word);
    } finally {
      if (raise) this.db.pragma("synchronous = NORMAL");
      this.#spent.write_ms += wrote;
      this.#spent.commit_ms += performance.now() - began - wrote;
    }
  }

  #refresh(touched: Touched, most: number): number {
    const head = this.#get("SELECT head FROM entries WHERE slot = ?").pluck();
    const record = this.#get("SELECT account, kind, key, hash FROM records WHERE id = ?");
    const done = this.#get("DELETE FROM facts_stale WHERE slot = ?");
    const slots = this.#get("SELECT slot FROM facts_stale ORDER BY slot LIMIT ?").pluck().all(most) as number[];
    for (const slot of slots) {
      done.run(slot);
      const at = head.get(slot) as number | undefined;
      if (at === undefined) continue;
      const copy = at > 0 ? record.get(at) as Copy | undefined : undefined;
      if (copy !== undefined) group(touched, copy);
      else if (at < 0) touched.atoms.add(-at);
    }
    return slots.length;
  }

  #put(entry: RecordEntry, touched: Touched, batchFresh = false): void {
    const { source, kind, key } = entry.record;
    const account = accountOf(source);
    const row = {
      source, kind, key, account, version: entry.version, family: entry.family, start_ms: entry.start_ms, end_ms: entry.end_ms,
      hash: wordsHash(entry.title, entry.text), title: entry.title, text: entry.text, who: entry.who.length === 0 ? "" : entry.who.join(" "), link: entry.link, dated: entry.dated === true ? 1 : 0,
    };
    if (batchFresh) {
      const ak = `${account}\0${kind}\0${key}`;
      if (!touched.seenKeys.has(ak)) {
        const held = touched.fresh.get(ak);
        if (held === undefined) {
          touched.emptyRecords ??= this.#get("SELECT 1 FROM records LIMIT 1").pluck().get() === undefined;
          if (touched.emptyRecords || this.#get(EXISTS_BY_COPY_SQL).pluck().get(account, kind, key) === undefined) {
            touched.fresh.set(ak, row);
            return;
          }
          touched.seenKeys.add(ak);
        } else if (held instanceof Map) {
          held.set(source, row);
          return;
        } else if (held.source === source) {
          touched.fresh.set(ak, row);
          return;
        } else {
          const copies = new Map<string, Omit<RecordRow, "id" | "entry">>();
          copies.set(held.source, held);
          copies.set(source, row);
          touched.fresh.set(ak, copies);
          return;
        }
      }
    }
    const old = this.#get(SELECT_BY_REF_SQL).get(account, kind, key, source) as Pick<RecordRow, "id" | "account" | "kind" | "key" | "hash" | "entry" | "title" | "text"> | undefined;
    if (old !== undefined) gone(touched, old.title, old.text);
    if (old === undefined) {
      this.#get(INSERT_RECORD_SQL).run(row);
    } else {
      if (old.entry !== null) touched.slots.add(old.entry);
      group(touched, old);
      this.#get(UPDATE_RECORD_SQL).run({ ...row, id: old.id });
    }
    group(touched, row);
  }

  #drop(record: RecordRef, touched: Touched): void {
    const old = this.#get(`SELECT id, account, kind, key, hash, entry, title, text FROM records WHERE ${BY_REF}`).get(...byRef(record)) as Pick<RecordRow, "id" | "account" | "kind" | "key" | "hash" | "entry" | "title" | "text"> | undefined;
    if (old === undefined) return;
    gone(touched, old.title, old.text);
    if (old.entry !== null) touched.slots.add(old.entry);
    group(touched, old);
    this.#get("DELETE FROM records WHERE id = ?").run(old.id);
    for (const id of this.#get("SELECT id FROM atoms WHERE source = ? AND kind = ? AND key = ?").pluck().all(record.source, record.kind, record.key) as number[]) touched.atoms.add(id);
  }

  #touchAtom(atom: Pick<AtomRow, "id" | "source" | "kind" | "key" | "entry">, touched: Touched): void {
    if (atom.entry !== null) touched.slots.add(atom.entry);
    const record = atom.source === null || atom.kind === null || atom.key === null ? undefined
      : this.#get(`SELECT account, kind, key, hash FROM records WHERE ${BY_REF}`).get(...byRef({ source: atom.source, kind: atom.kind!, key: atom.key! })) as Copy | undefined;
    if (record !== undefined) group(touched, record);
    else touched.atoms.add(atom.id);
  }

  #flush(touched: Touched): string[] {
    const lone: AtomRow[] = [];
    for (const id of touched.atoms) {
      const atom = this.#get("SELECT * FROM atoms WHERE id = ?").get(id) as AtomRow | undefined;
      if (atom === undefined) continue;
      const record = atom.source === null ? undefined
        : this.#get(`SELECT account, kind, key, hash FROM records WHERE ${BY_REF}`).get(...byRef({ source: atom.source, kind: atom.kind!, key: atom.key! })) as Copy | undefined;
      if (record !== undefined) group(touched, record);
      else {
        if (atom.entry !== null) touched.slots.add(atom.entry);
        if (atom.line !== "" || atom.title !== "") lone.push(atom);
      }
    }
    const hasAtoms = (touched.groups.size > 0 || touched.fresh.size > 0) && this.#get("SELECT 1 FROM atoms LIMIT 1").pluck().get() !== undefined;
    const hasFacts = (touched.groups.size > 0 || touched.fresh.size > 0 || lone.length > 0) && this.#get("SELECT 1 FROM fact LIMIT 1").pluck().get() !== undefined;
    if (touched.fresh.size > 0 && (hasAtoms || hasFacts)) {
      const insertRecord = this.#get(INSERT_RECORD_SQL);
      for (const held of touched.fresh.values()) {
        if (held instanceof Map) {
          for (const row of held.values()) {
            insertRecord.run(row);
            group(touched, row);
          }
        } else {
          insertRecord.run(held);
          group(touched, held);
        }
      }
      touched.fresh.clear();
    }
    const selectCopies = this.#get("SELECT * FROM records WHERE account = ? AND kind = ? AND key = ? AND hash = ? ORDER BY id");
    const groups: { copies: RecordRow[]; atoms: AtomRow[] }[] = [];
    for (const { account, kind, key, hash } of touched.groups.values()) {
      const copies = selectCopies.all(account, kind, key, hash) as RecordRow[];
      if (copies.length === 0) continue;
      const atoms = hasAtoms ? this.#atomsOf(copies) : [];
      for (const row of copies) if (row.entry !== null) touched.slots.add(row.entry);
      for (const row of atoms) if (row.entry !== null) touched.slots.add(row.entry);
      groups.push({ copies, atoms });
    }
    for (const slot of touched.slots) {
      this.#get("DELETE FROM fts WHERE rowid = ?").run(slot);
      this.#get("DELETE FROM unmarked WHERE slot = ?").run(slot);
      this.#get("DELETE FROM facts_stale WHERE slot = ?").run(slot);
      unstate((sql) => this.#get(sql), touched, slot);
      const gone = this.#get(SELECT_NAMED_SQL).raw().get(slot) as (number | null)[] | undefined;
      if (gone === undefined) continue;
      this.#get("DELETE FROM entries WHERE slot = ?").run(slot);
      touched.entries -= 1;
      touched.unstated -= 1;
      for (const id of gone) if (id !== null) touched.named.set(id, (touched.named.get(id) ?? 0) - 1);
    }
    const writing = groups.length > 0 || lone.length > 0 || touched.fresh.size > 0;
    const maxSlot = writing ? ((this.#get(`SELECT max(slot) FROM entries WHERE slot >= ${TIMED}`).pluck().get() as number | null) ?? -Infinity) : -Infinity;
    const slotState: SlotState | undefined = writing ? {
      max: maxSlot,
      min: maxSlot === -Infinity ? Infinity : ((this.#get(`SELECT min(slot) FROM entries WHERE slot >= ${TIMED}`).pluck().get() as number | null) ?? Infinity),
      untimed: this.#get(`SELECT max(slot) FROM entries WHERE slot < ${TIMED}`).pluck().get() as number | null,
      ...(maxSlot === -Infinity ? { occupied: new Map<number, number>() } : {}),
    } : undefined;
    const stmts: FlushStatements | undefined = writing ? {
      entry: this.#get(INSERT_ENTRY_SQL),
      fts: this.#get("INSERT INTO fts (rowid, title, line, text, who, tags) VALUES (?, ?, ?, ?, ?, ?)"),
      unmarked: this.#get("INSERT INTO unmarked (slot) VALUES (?)"),
      skeleton: this.#get("INSERT OR IGNORE INTO skeletons (word, skeleton) VALUES (?, ?)"),
      states: this.#get("INSERT INTO entry_states (slot, accounts, who, chat) VALUES (?, ?, ?, ?)"),
    } : undefined;
    if (touched.fresh.size > 0) {
      const insertRecordWithEntry = this.#get(INSERT_RECORD_WITH_ENTRY_SQL);
      for (const held of touched.fresh.values()) {
        if (!(held instanceof Map)) {
          const row = held;
          const dates = row.dated === 1 && row.start_ms !== null ? [utcDate(row.start_ms), utcDate(Math.max(row.start_ms, (row.end_ms ?? row.start_ms) - 1))] as const : null;
          const placed = this.#placed(row.start_ms, dates);
          const slot = this.#slot(placed.at, slotState);
          const head = Number(insertRecordWithEntry.run(row.source, row.kind, row.key, row.account, row.version, row.family, row.start_ms, row.end_ms, row.hash, row.title, row.text, row.who, row.link, row.dated, slot).lastInsertRowid);
          this.#insertAt(slot, placed, touched, {
            shown: row.title, head, dated: row.dated === 1, family: row.family, kind: row.kind,
            products: [productOf(row.source)], sources: [row.source], layer: 0,
            title: row.title, line: "", text: row.text, who: row.who, facts: [],
            states: row.who === "" ? { accounts: row.account, who: null, chat: null } : this.#statesOf([{ ...row, id: head, entry: slot }], [], []),
          }, stmts!);
          continue;
        }
        const byHash = new Map<string, Omit<RecordRow, "id" | "entry">[]>();
        for (const row of held.values()) {
          const list = byHash.get(row.hash);
          if (list === undefined) byHash.set(row.hash, [row]);
          else list.push(row);
        }
        for (const copies of byHash.values()) {
          const first = copies[0]!;
          const dates = first.dated === 1 && first.start_ms !== null ? [utcDate(first.start_ms), utcDate(Math.max(first.start_ms, (first.end_ms ?? first.start_ms) - 1))] as const : null;
          const placed = this.#placed(first.start_ms, dates);
          const slot = this.#slot(placed.at, slotState);
          let head = 0;
          const rows: RecordRow[] = [];
          for (let i = 0; i < copies.length; i++) {
            const row = copies[i]!;
            const id = Number(insertRecordWithEntry.run(row.source, row.kind, row.key, row.account, row.version, row.family, row.start_ms, row.end_ms, row.hash, row.title, row.text, row.who, row.link, row.dated, slot).lastInsertRowid);
            if (i === 0) head = id;
            if (row.who !== "") rows.push({ ...row, id, entry: slot });
          }
          const who = copies.length === 1 ? first.who : [...new Set(copies.flatMap((copy) => copy.who === "" ? [] : copy.who.split(" ")))].join(" ");
          this.#insertAt(slot, placed, touched, {
            shown: first.title, head, dated: first.dated === 1, family: first.family, kind: first.kind,
            products: copies.length === 1 ? [productOf(first.source)] : copies.map((copy) => productOf(copy.source)),
            sources: copies.length === 1 ? [first.source] : copies.map((copy) => copy.source), layer: 0,
            title: first.title, line: "", text: first.text, who, facts: [],
            states: who === "" ? { accounts: first.account, who: null, chat: null } : this.#statesOf(rows, [], []),
          }, stmts!);
        }
      }
    }
    const updateRecordEntry = this.#get("UPDATE records SET entry = ? WHERE id = ?");
    const updateAtomEntry = this.#get("UPDATE atoms SET entry = ? WHERE id = ?");
    for (const { copies, atoms } of groups) {
      const first = copies[0]!;
      const facts = hasFacts ? this.#statedBy(copies, atoms) : [];
      const lines = atoms.length === 0 ? "" : [...new Set(atoms.map((atom) => atom.line).filter((line) => line !== ""))].join("\n");
      const dates = first.dated === 1 && first.start_ms !== null ? [utcDate(first.start_ms), utcDate(Math.max(first.start_ms, (first.end_ms ?? first.start_ms) - 1))] as const : null;
      const title = atoms.length === 0 ? first.title : [...new Set([first.title, ...atoms.map((atom) => atom.title)].filter((each) => each !== ""))].join(" · ");
      const who = copies.length === 1 ? first.who : [...new Set(copies.flatMap((copy) => copy.who === "" ? [] : copy.who.split(" ")))].join(" ");
      const slot = this.#insert(this.#placed(first.start_ms, dates), touched, {
        shown: first.title !== "" ? first.title : atoms[0]?.title ?? "", head: first.id, dated: first.dated === 1, family: first.family, kind: first.kind,
        products: copies.length === 1 ? [productOf(first.source)] : copies.map((copy) => productOf(copy.source)),
        sources: copies.length === 1 ? [first.source] : copies.map((copy) => copy.source), layer: 0,
        title, line: lines, text: first.text === "" || (lines !== "" && says(lines, first.text)) ? "" : first.text, who,
        facts, states: this.#statesOf(copies, atoms, facts),
      }, slotState, stmts!);
      for (const copy of copies) updateRecordEntry.run(slot, copy.id);
      for (const atom of atoms) updateAtomEntry.run(slot, atom.id);
    }
    for (const atom of lone) {
      const facts = hasFacts ? this.#statedBy([], [atom]) : [];
      const who = facts.length === 0 ? "" : [...new Set(facts.flatMap((fact) => (fact.who?.split("\x1e") ?? []).map((handle) => handleOfId(handle)?.value ?? handle)))].join(" ");
      const slot = this.#insert(this.#placed(atom.start_ms, atom.dated === 1 ? [atom.day, atom.day] : null), touched, {
        shown: atom.title, head: -atom.id, dated: atom.dated === 1, family: atom.family, kind: atom.kind, products: atom.source === null ? [] : [productOf(atom.source)], sources: atom.source === null ? [] : [atom.source],
        layer: 1, title: atom.title, line: atom.line, text: "", who, facts, states: this.#statesOf([], [atom], facts),
      }, slotState, stmts!);
      updateAtomEntry.run(slot, atom.id);
    }
    for (const [id, more] of touched.named) {
      if (more !== 0) this.#get("UPDATE names SET n = n + ? WHERE id = ?").run(more, id);
    }
    for (const [id] of touched.named) this.#get("DELETE FROM names WHERE id = ? AND role = 'title' AND n = 0").run(id);
    const removed: string[] = [];
    if (touched.gone.size > 0) {
      const holds = this.#get("SELECT 1 FROM fts WHERE fts MATCH ? LIMIT 1").pluck();
      const dropSkeleton = this.#get("DELETE FROM skeletons WHERE word = ?");
      for (const word of touched.gone) {
        if (touched.added.has(word) || holds.get(`{title line text} : ${phrase(word)}`) !== undefined) continue;
        dropSkeleton.run(word);
        removed.push(word);
      }
    }
    this.#reach(touched);
    return removed;
  }

  #statedBy(copies: readonly RecordRow[], atoms: readonly AtomRow[]): Stated[] {
    const facts = new Map<string, Stated>();
    const byRecord = this.#get(`SELECT ${STATED_SQL} FROM ${STATED_FROM} WHERE f.record = ?`);
    const byLine = this.#get(`SELECT ${STATED_SQL} FROM fact_line l JOIN ${STATED_FROM} WHERE f.fid = l.fid AND l.day = ? AND l.atom = ?`);
    const stated = (rows: unknown[]) => (rows as StatedRow[]).map((row) => statedOf((sql) => this.#get(sql), row));
    for (const copy of copies) for (const fact of stated(byRecord.all(refName(copy)))) facts.set(fact.id, fact);
    for (const atom of atoms) for (const fact of stated(byLine.all(atom.day, atom.n))) facts.set(fact.id, fact);
    return [...facts.values()];
  }

  #statesOf(copies: readonly RecordRow[], atoms: readonly AtomRow[], facts: readonly Stated[]): EntryStates | null {
    if (atoms.length === 0 && facts.length === 0 && copies.length === 1 && copies[0]!.who === "") {
      return { accounts: copies[0]!.account, who: null, chat: null };
    }
    const lineAccounts = this.#get(LINE_ACCOUNTS).pluck();
    const accounts = new Set(copies.map((copy) => copy.account));
    for (const atom of atoms) {
      const stated = lineAccounts.get(atom.day, atom.n) as string | undefined;
      if (stated === undefined && copies.length > 0) continue;
      const own = lineAccountsOf(stated, atom.source);
      if (own === null) return null;
      for (const account of own) accounts.add(account);
    }
    const who = new Set([
      ...copies.flatMap((copy) => (copy.who === "" ? [] : copy.who.split(" "))),
      ...facts.flatMap((fact) => (fact.who === null ? [] : fact.who.split("\x1e"))),
      ...atoms.flatMap((atom) => [...namedIn(atom.names), ...namedIn(atom.title_names)]),
    ].map(whoIdOf));
    const chats = new Set([...atoms.map((atom) => atom.chat), ...facts.map((fact) => fact.chat)].filter((chat) => chat !== null));
    return { accounts: joined(accounts), who: who.size === 0 ? null : joined(who), chat: chats.size === 0 ? null : joined(chats) };
  }

  #heldBy(head: number): { copies: RecordRow[]; atoms: AtomRow[] } {
    if (head < 0) return { copies: [], atoms: [this.#get("SELECT * FROM atoms WHERE id = ?").get(-head) as AtomRow] };
    const first = this.#get("SELECT account, kind, key, hash FROM records WHERE id = ?").get(head) as Copy;
    const copies = this.#get("SELECT * FROM records WHERE account = ? AND kind = ? AND key = ? AND hash = ? ORDER BY id").all(first.account, first.kind, first.key, first.hash) as RecordRow[];
    return { copies, atoms: this.#atomsOf(copies) };
  }

  unresolved(): number | null {
    const owed = this.#owed(() => (this.#get("SELECT 1 FROM facts_owed LIMIT 1").pluck().get() === undefined ? 0 : 1)) !== null;
    const held = this.#meta(owed ? "entries" : "unstated");
    return held === undefined ? null : Number(held);
  }

  #count(): void {
    this.#setMeta("entries", String(this.#get("SELECT count(*) FROM entries").pluck().get() as number));
    this.#setMeta("unstated", String(this.#get("SELECT count(*) FROM entries e WHERE NOT EXISTS (SELECT 1 FROM entry_states x WHERE x.slot = e.slot)").pluck().get() as number));
  }

  #reach(touched: Touched): void {
    for (const key of ["entries", "unstated"] as const) {
      const held = touched[key] === 0 ? undefined : this.#meta(key);
      if (held !== undefined) this.#setMeta(key, String(Number(held) + touched[key]));
    }
    if (touched.span !== undefined && touched.span > Number(this.#meta("dated_span") ?? 0)) this.#setMeta("dated_span", String(touched.span));
    if (touched.slack.size > 0) {
      const kept = this.#json<Record<string, Slack>>("slack") ?? {};
      let grew = false;
      for (const [of, wide] of touched.slack) {
        const held = kept[of];
        if (held !== undefined && held.before >= wide.before && held.after >= wide.after) continue;
        kept[of] = held === undefined ? wide : { before: Math.max(held.before, wide.before), after: Math.max(held.after, wide.after) };
        grew = true;
      }
      if (grew) this.#setMeta("slack", JSON.stringify(kept));
    }
    if ([...touched.untimed.values()].some((more) => more !== 0)) {
      const kept = this.#json<Record<string, number>>("untimed") ?? {};
      for (const [of, more] of touched.untimed) {
        const n = (kept[of] ?? 0) + more;
        if (n === 0) delete kept[of];
        else kept[of] = n;
      }
      this.#setMeta("untimed", JSON.stringify(Object.fromEntries(Object.entries(kept).sort(([a], [b]) => (a < b ? -1 : 1)))));
    }
  }

  #learn(touched: Touched, insert: Database.Statement, title: string, line: string, text: string): void {
    const visit = (word: string): void => {
      if (touched.added.has(word) || this.#knownWords.has(word)) return;
      touched.added.add(word);
      insert.run(word, skeletonOf(word));
    };
    if (title !== "") forEachVocabularyWord(title, visit);
    if (line !== "") forEachVocabularyWord(line, visit);
    if (text !== "") forEachVocabularyWord(text, visit);
  }

  #atomsOf(copies: readonly RecordRow[]): AtomRow[] {
    const select = this.#get("SELECT * FROM atoms WHERE source = ? AND kind = ? AND key = ?");
    return copies.flatMap((copy) => select.all(copy.source, copy.kind, copy.key) as AtomRow[])
      .sort((left, right) => (left.day < right.day ? -1 : left.day > right.day ? 1 : left.n - right.n));
  }

  #placed(start_ms: number | null, dates: readonly [string, string] | null): { at: number | null; last: number | null } {
    if (dates === null) return { at: start_ms, last: null };
    return { at: dayBounds(dates[0], this.clock).start_ms, last: dayBounds(dates[1], this.clock).start_ms };
  }

  #insert(placed: { at: number | null; last: number | null }, touched: Touched, entry: {
    shown: string;
    head: number; dated: boolean; family: string; kind: string | null; products: string[]; sources: string[]; layer: 0 | 1; title: string; line: string; text: string; who: string;
    facts: readonly Stated[]; states: EntryStates | null;
  }, slotState: SlotState | undefined, stmts: FlushStatements): number {
    return this.#insertAt(this.#slot(placed.at, slotState), placed, touched, entry, stmts);
  }

  #insertAt(slot: number, placed: { at: number | null; last: number | null }, touched: Touched, entry: {
    shown: string;
    head: number; dated: boolean; family: string; kind: string | null; products: string[]; sources: string[]; layer: 0 | 1; title: string; line: string; text: string; who: string;
    facts: readonly Stated[]; states: EntryStates | null;
  }, stmts: FlushStatements): number {
    if (placed.at !== null && placed.last !== null && placed.last > placed.at) touched.span = Math.max(touched.span ?? 0, placed.last - placed.at);
    const products = entry.products.length <= 1 ? entry.products : [...new Set(entry.products)];
    let tags: string;
    if (products.length === 1 && entry.sources.length === 1 && entry.facts.length === 0) {
      tags = `f${tagWord(entry.family)}${entry.kind === null ? "" : ` k${tagWord(entry.kind)}`} p${tagWord(products[0]!)} ${sourceTag(entry.sources[0]!)} ${entry.layer === 0 ? "lrecords" : "latoms"}${entry.dated ? ` ${DATED_TAG}` : ""}`;
    } else {
      tags = [
        `f${tagWord(entry.family)}`, ...(entry.kind === null ? [] : [`k${tagWord(entry.kind)}`]), ...products.map((product) => `p${tagWord(product)}`),
        ...[...new Set(entry.sources)].map(sourceTag), entry.layer === 0 ? "lrecords" : "latoms", ...(entry.dated ? [DATED_TAG] : []),
        ...new Set(entry.facts.flatMap((fact) => (fact.chat === null ? [] : [chatTag(fact.chat)]))),
      ].join(" ");
    }
    const familyId = this.#name("family", entry.family, touched);
    const kindId = entry.kind === null ? null : this.#name("kind", entry.kind, touched);
    const productId = products[0] === undefined ? null : this.#name("product", products[0], touched);
    const titleId = entry.shown === "" ? null : this.#name("title", entry.shown, touched);
    const layerId = this.#name("layer", entry.layer === 0 ? "records" : "atoms", touched);
    touched.named.set(familyId, (touched.named.get(familyId) ?? 0) + 1);
    if (kindId !== null) touched.named.set(kindId, (touched.named.get(kindId) ?? 0) + 1);
    if (productId !== null) touched.named.set(productId, (touched.named.get(productId) ?? 0) + 1);
    if (titleId !== null) touched.named.set(titleId, (touched.named.get(titleId) ?? 0) + 1);
    touched.named.set(layerId, (touched.named.get(layerId) ?? 0) + 1);
    stmts.entry.run(slot, entry.head, entry.dated ? 1 : 0, placed.last, familyId, kindId, productId, titleId, layerId);
    touched.entries += 1;
    touched.unstated += 1;
    stmts.fts.run(slot, entry.title, entry.line, entry.text, entry.who, tags);
    this.#learn(touched, stmts.skeleton, entry.title, entry.line, entry.text);
    stmts.unmarked.run(slot);
    touched.remaking ??= this.#get("SELECT 1 FROM facts_owed LIMIT 1").pluck().get() !== undefined;
    if (touched.remaking) this.#get("INSERT INTO facts_stale (slot) VALUES (?) ON CONFLICT DO NOTHING").run(slot);
    state((sql) => this.#get(sql), touched, slot, entry.facts, entry.states, stmts.states);
    return slot;
  }

  #slot(start_ms: number | null, slotState?: SlotState): number {
    if (start_ms === null) {
      if (slotState !== undefined) {
        slotState.untimed = slotState.untimed === null ? UNTIMED : slotState.untimed + 1;
        return slotState.untimed;
      }
      const top = this.#get(`SELECT max(slot) FROM entries WHERE slot < ${TIMED}`).pluck().get() as number | null;
      return top === null ? UNTIMED : top + 1;
    }
    const firstMs = Math.min(MAX_MS, Math.max(MIN_MS, Math.floor(start_ms)));
    if (slotState !== undefined) {
      if (slotState.occupied !== undefined) {
        for (let ms = firstMs; ; ms++) {
          const next = slotState.occupied.get(ms) ?? 0;
          if (next >= 1000) continue;
          slotState.occupied.set(ms, next + 1);
          const chosen = ms * 1000 + next;
          if (chosen > slotState.max) slotState.max = chosen;
          if (chosen < slotState.min) slotState.min = chosen;
          return chosen;
        }
      }
      const base = firstMs * 1000;
      if (base > slotState.max) {
        slotState.max = base;
        if (base < slotState.min) slotState.min = base;
        return base;
      }
      if (base <= slotState.max && slotState.max < base + 999) {
        slotState.max += 1;
        return slotState.max;
      }
      if (base + 1000 <= slotState.min) {
        slotState.min = base;
        if (base > slotState.max) slotState.max = base;
        return base;
      }
    }
    for (let ms = firstMs; ; ms++) {
      const base = ms * 1000;
      const top = this.#get("SELECT max(slot) FROM entries WHERE slot >= ? AND slot < ?").pluck().get(base, base + 1000) as number | null;
      let chosen: number;
      if (top === null) chosen = base;
      else if (top < base + 999) chosen = top + 1;
      else {
        const taken = this.#get("SELECT slot FROM entries WHERE slot >= ? AND slot < ? ORDER BY slot").pluck().all(base, base + 1000) as number[];
        if (taken.length >= 1000) continue;
        let n = 0;
        for (const slot of taken) {
          if (slot - base !== n) break;
          n++;
        }
        chosen = base + n;
      }
      if (slotState !== undefined) {
        if (chosen > slotState.max) slotState.max = chosen;
        if (chosen < slotState.min) slotState.min = chosen;
      }
      return chosen;
    }
  }

  #name(role: Named, name: string, touched?: Touched): number {
    if (role === "title") {
      let id = touched?.titles.get(name);
      if (id === undefined) {
        id = this.#get("SELECT id FROM names WHERE role = ? AND name = ?").pluck().get(role, name) as number | undefined
          ?? Number(this.#get("INSERT INTO names (role, name, n) VALUES (?, ?, 0)").run(role, name).lastInsertRowid);
        touched?.titles.set(name, id);
      }
      return id;
    }
    const remembered = `${role}\0${name}`;
    let id = this.#names.get(remembered);
    if (id === undefined) {
      id = this.#get("SELECT id FROM names WHERE role = ? AND name = ?").pluck().get(role, name) as number | undefined
        ?? Number(this.#get("INSERT INTO names (role, name, n) VALUES (?, ?, 0)").run(role, name).lastInsertRowid);
      this.#names.set(remembered, id);
    }
    return id;
  }

  #metered<T>(budget: number, run: (on: Metered) => T, inRead: () => void, within: Work | undefined = this.#within): T {
    const outer = this.#work;
    const work = new Work(budget, true, within);
    this.#work = work;
    try {
      const answer = run({
        work, clock: this.clock,
        walk: <R,>(sql: string, params: readonly unknown[], limit: number, by = work) => {
          inRead();
          return by.walk<R>(this.#prepared(sql), params, limit);
        },
        point: <R,>(sql: string, params: readonly unknown[], by = work) => {
          inRead();
          return by.point<R>(this.#prepared(sql), params);
        },
        meta: (key) => {
          inRead();
          return this.#meta(key);
        },
      });
      work.end();
      return answer;
    } finally {
      this.#work = outer;
    }
  }

  #walk<T>(sql: string, params: readonly unknown[], limit: number): { rows: T[]; more: boolean } {
    return this.#meter().walk<T>(this.#prepared(sql), params, limit);
  }

  #point<T>(sql: string, params: readonly unknown[]): T | undefined {
    return this.#meter().point<T>(this.#prepared(sql), params);
  }

  #prepared(sql: string): Database.Statement {
    if (this.#read === undefined) throw new Error("the search index is walked only inside a read of it (snapshot)");
    let statement = this.#meteredStatements.get(sql);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      this.#meteredStatements.set(sql, statement);
    }
    return statement;
  }

  #meter(): Work {
    if (this.#work === undefined) throw new Error("the search index is walked only inside a member of a read of it (#metered)");
    return this.#work;
  }

  #get(sql: string): Database.Statement {
    if (this.#read !== undefined && sql !== META) throw new Error(`a read of the index runs every statement but meta's through its meter: ${sql}`);
    let statement = this.#statements.get(sql);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  #json<T>(key: string): T | undefined {
    const value = this.#meta(key);
    return value === undefined ? undefined : JSON.parse(value) as T;
  }

  #meta(key: string): string | undefined {
    try {
      return this.#get(META).pluck().get(key) as string | undefined;
    } catch (error) {
      if (isSqliteError(error) && (error.code === "SQLITE_NOTADB" || /no such table/u.test(error.message))) return undefined;
      throw error;
    }
  }

  #setMeta(key: string, value: string): void {
    this.#get("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }
}

function removeFile(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
}

export const SEARCH_STORE: StoreKind = { role: "search", remade: true };

export interface Attached {
  readonly kind: StoreKind;
  readonly file: string;
}

function open(folder: HomeFolder, path: string, readonly: boolean, exists: boolean, published: boolean, waitMs?: number): Database.Database {
  if (readonly) return folder.store(SEARCH_STORE, path, { mode: "read", mustExist: exists, timeout: waitMs ?? READ_WAIT_MS });
  const db = folder.store(SEARCH_STORE, path, { mustExist: exists, timeout: waitMs ?? BUSY_MS, sync: published ? "FULL" : "NORMAL", sorts: "memory" });
  db.pragma(`wal_autocheckpoint = ${CHECKPOINT_PAGES}`);
  if (waitMs === undefined) db.pragma(`cache_size = -${CACHE_KB}`);
  return db;
}

function group(touched: Touched, record: Copy): void {
  touched.groups.set(`${record.account}\0${record.kind}\0${record.key}\0${record.hash}`, { account: record.account, kind: record.kind, key: record.key, hash: record.hash });
}

function atomRow(day: string, atom: AtomEntry): Omit<AtomRow, "id" | "entry"> {
  const row = {
    day, n: atom.n, family: atom.family, unit: atom.unit, item: atom.item ?? null, source: atom.record?.source ?? null, kind: atom.record?.kind ?? null,
    key: atom.record?.key ?? null, start_ms: atom.start_ms, end_ms: atom.end_ms, title: atom.title ?? "", line: atom.text,
    names: atom.names === undefined || atom.names.length === 0 ? null : JSON.stringify(atom.names),
    title_names: atom.title_names === undefined || atom.title_names.length === 0 ? null : JSON.stringify(atom.title_names), dated: atom.dated === true ? 1 : 0,
    chat: atom.chat ?? null, pictures: atom.pictures ?? null, sender: atom.sender === undefined || atom.sender.length === 0 ? null : atom.sender.join("\x1e"),
  };
  return { ...row, same: sameOf(row) };
}

export function atomSame(day: string, atom: AtomEntry): string {
  return atomRow(day, atom).same;
}

function sameOf(row: Omit<AtomRow, "id" | "entry" | "same">): string {
  return createHash("sha256").update(JSON.stringify([row.family, row.unit, row.item, row.source, row.kind, row.key, row.start_ms, row.end_ms, row.title, row.line, row.names, row.title_names, row.dated, row.chat, row.pictures, row.sender]))
    .digest("hex").slice(0, 16);
}

function clockName(clock: DaySettings): string {
  return JSON.stringify({ zone: clock.zone, day_start_hour: clock.day_start_hour });
}

function claimOf(fact: DayFileFact, dated?: { start_ms: number; end_ms: number }): Claim {
  return canonical({
    of: fact.of, time_ms: dated?.start_ms ?? fact.time_ms, start_ms: dated?.start_ms ?? fact.start_ms, end_ms: dated?.end_ms ?? fact.end_ms,
    date_only: fact.date_only === true ? 1 : 0, unit: fact.from.units[0]!,
    record: fact.from.record === undefined ? null : refName(fact.from.record), item: fact.from.item ?? null, source: fact.from.instrument ?? fact.from.record?.source ?? null,
    accounts: fact.from.accounts === undefined ? null : [...fact.from.accounts],
    keys: Object.entries(fact.keys), who: fact.who.map(({ handle }) => handle), measures: measuresOf(fact), lines: [...fact.lines],
  });
}

function canonical(claim: Claim): Claim {
  const order = <T extends [string, unknown]>(pairs: T[]) => [...pairs].sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0));
  return {
    ...claim, accounts: claim.accounts === null ? null : [...new Set(claim.accounts)].sort(), keys: order(claim.keys), who: [...new Set(claim.who)].sort(), measures: order(claim.measures),
    lines: [...new Set(claim.lines)].sort((a, b) => a - b),
  };
}

function measuresOf(fact: DayFileFact): [string, number][] {
  return Object.entries(fact.measures).map(([measure, value]) => [measure, typeof value === "string" ? minorUnits(value, fact.keys["currency"], fact.id) : value]);
}

function merged(first: Claim, then: Claim): Claim {
  const keys = new Map(first.keys);
  for (const [key, value] of then.keys) if (!keys.has(key)) keys.set(key, value);
  const measures = new Map(first.measures);
  for (const [measure, value] of then.measures) if (!measures.has(measure)) measures.set(measure, value);
  const accounts = first.accounts === null && then.accounts === null && first.record === then.record ? null : [...restsOn(first), ...restsOn(then)];
  return canonical({ ...first, accounts, keys: [...keys], who: [...first.who, ...then.who], measures: [...measures], lines: [...first.lines, ...then.lines] });
}

function restsOn(claim: Claim): string[] {
  if (claim.accounts !== null) return claim.accounts;
  return claim.record === null ? [] : [accountOf(claim.record.slice(0, claim.record.indexOf("\0")))];
}

class Arbiter {
  constructor(
    private readonly get: (sql: string) => Database.Statement,
    private readonly recount: Set<string>,
    private readonly changes: Changes,
    readonly layer: FactsLayer,
  ) {}

  holder(fact: string): (Stated & { mtime_us: number | null }) | undefined {
    const row = this.get(`SELECT ${STATED_SQL}, d.mtime_us FROM ${STATED_FROM} LEFT JOIN days d ON d.day = f.day WHERE f.id = ?`).get(fact) as (StatedRow & { mtime_us: number | null }) | undefined;
    return row === undefined ? undefined : { ...statedOf(this.get, row), mtime_us: row.mtime_us };
  }

  reconcile(fact: string, day: string, stamp: number | undefined): void {
    const rivals = (this.get("SELECT r.day, r.claim, d.mtime_us FROM fact_rival r LEFT JOIN days d ON d.day = r.day WHERE r.id = ?").all(fact) as { day: string; claim: string; mtime_us: number | null }[])
      .filter((each) => !(JSON.parse(each.claim) as Partial<Cite>).cite);
    if (rivals.length === 0) return;
    const stampOf = (of: string, mtime_us: number | null) => (of === day ? stamp ?? null : mtime_us);
    const holder = this.holder(fact);
    const held = holder === undefined || this.layer.loose(fact) ? undefined : holder;
    let best = held === undefined ? undefined : { day: held.day, mtime_us: stampOf(held.day, held.mtime_us) };
    let taker: (typeof rivals)[number] | undefined;
    for (const each of rivals) {
      const at = stampOf(each.day, each.mtime_us) ?? -1;
      if (best === undefined || outdates(each.day, at, best)) {
        best = { day: each.day, mtime_us: at };
        taker = each;
      }
    }
    if (taker === undefined) return;
    if (held !== undefined) {
      this.get("INSERT INTO fact_rival (id, day, claim) VALUES (?, ?, ?)").run(fact, held.day, JSON.stringify(this.layer.held(fact, held.day)));
      this.unseat(held);
    }
    this.get("DELETE FROM fact_rival WHERE id = ? AND day = ?").run(fact, taker.day);
    this.install(fact, taker.day, JSON.parse(taker.claim) as Claim);
    this.recount.add(taker.day);
    if (!this.changes.has(fact)) this.changes.set(fact, {});
  }

  install(fact: string, day: string, claim: Claim): void {
    this.layer.install(fact, day, claim);
    if (!this.changes.has(fact)) this.changes.set(fact, {});
  }

  unseat(held: Stated): void {
    if (!this.changes.has(held.id)) this.changes.set(held.id, { was: held });
    this.layer.unseat(held.id);
    this.recount.add(held.day);
  }
}

function claims(fact: DayFileFact, window: { start_ms: number; end_ms: number }): boolean {
  return fact.date_only === true || (fact.time_ms >= window.start_ms && fact.time_ms < window.end_ms);
}

function outdates(day: string, stamp: number, held: { day: string; mtime_us: number | null }): boolean {
  return held.mtime_us === null || stamp > held.mtime_us || (stamp === held.mtime_us && day > held.day);
}

function unstate(get: (sql: string) => Database.Statement, touched: Touched, slot: number): void {
  touched.unstated += get("DELETE FROM entry_states WHERE slot = ?").run(slot).changes;
  if (slot >= TIMED) {
    get("DELETE FROM entry_fact WHERE slot = ?").run(slot);
    return;
  }
  const stated = get("DELETE FROM entry_fact WHERE slot = ? RETURNING fid").pluck().all(slot) as number[];
  const of = get("SELECT of FROM fact WHERE fid = ?").pluck();
  for (const each of new Set(stated.map((fid) => of.get(fid) as string))) untimed(touched, each, -1);
}

function state(get: (sql: string) => Database.Statement, touched: Touched, slot: number, facts: readonly Stated[], states: EntryStates | null, insertStates?: Database.Statement): void {
  stateRow(get, touched, slot, states, insertStates);
  if (facts.length === 0) return;
  const stating = get("INSERT INTO entry_fact (slot, fid) VALUES (?, ?)");
  const p = timeOf(slot);
  for (const fact of facts) {
    stating.run(slot, fact.fid);
    if (p !== null) grow(touched.slack, fact, p);
  }
  if (p === null) for (const of of new Set(facts.map((fact) => fact.of))) untimed(touched, of, 1);
}

function stateRow(get: (sql: string) => Database.Statement, touched: Touched, slot: number, states: EntryStates | null, insertStates?: Database.Statement): void {
  if (states === null) return;
  (insertStates ?? get("INSERT INTO entry_states (slot, accounts, who, chat) VALUES (?, ?, ?, ?)")).run(slot, states.accounts, states.who, states.chat);
  touched.unstated -= 1;
}

function whoIdOf(value: string): string {
  const handle = handleOfId(value) ?? handleOf(value);
  return handle === null ? value : handleId(handle);
}

function namedIn(names: string | null): string[] {
  return names === null ? [] : (JSON.parse(names) as NameSpan[]).map(({ who }) => who);
}

function joined(values: Iterable<string>): string {
  return [...values].sort().join("\x1e");
}

function untimed(touched: Touched, of: string, more: number): void {
  if (more !== 0) touched.untimed.set(of, (touched.untimed.get(of) ?? 0) + more);
}

function grow(slack: Map<string, Slack>, fact: Stated, p: number): void {
  const [a, b] = [fact.start_ms, fact.end_ms];
  const held = slack.get(fact.of);
  slack.set(fact.of, { before: Math.max(held?.before ?? b - p, b - p), after: Math.max(held?.after ?? p - a, p - a) });
}

function productOf(source: string): string {
  const colon = source.indexOf(":");
  return colon < 0 ? source : source.slice(0, colon);
}

function wordsHash(title: string, text: string): string {
  return createHash("sha256").update(title).update("\0").update(text).digest("hex").slice(0, 16);
}

function sameAgainst(held: Against | undefined, asked: Against): boolean {
  return held !== undefined && held.store === asked.store && (asked.model === null || held.model === asked.model);
}

export function minorUnits(decimal: string, currency: string | undefined, fact: string): number {
  if (currency === undefined) throw new Error(`fact ${fact} states an amount with no currency`);
  const held = minorUnitsOf(decimal, currency);
  if (typeof held === "string") throw new Error(`fact ${fact} states an amount ${held}`);
  return held;
}

function refName(record: RecordRef): string {
  return `${record.source}\0${record.kind}\0${record.key}`;
}

function gone(touched: Touched, ...texts: string[]): void {
  for (const word of vocabularyOf(texts)) touched.gone.add(word);
}
