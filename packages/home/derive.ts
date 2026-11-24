import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  canonical, civilDay, DAYS_MARK, GONE, MissingVersion, openHome, RELEASE, selects, type BlobReader, type DayRow, type DaySettings, type DayUnit, type ExtractRow, type FileKind, type Head, type HeadAfter, type HomeDb, type HomeFolder, type Json, type KeptFile, type OpenView, type Staged,
  type PublishLists, type RecordRef, type Statement, type Tx, type Version, type View, walkPlace,
} from "@lifestreamprotocol/core";
import { dayHead, LABELS_FAMILY, renderDay, type Change, type DayHead, type Family, type LabelUnits, type Touched } from "@lifestreamprotocol/families";
import { shownName } from "./devices.js";
import { failpoint, holdpoint } from "./failpoint.js";
import { errorText, homeFault, LANE, RECENT_MS, type HelperEnv, type Kind, type Main, type Running, type Task } from "./jobs.js";
import { readerOf } from "./registry.js";


const CHUNK_STATEMENTS = 2_000;
const CHUNK_RECORDS = 2_000;
const CHUNK_BYTES = 64 * 1024 * 1024;
const RUN_STATEMENTS = 50_000;
const RUN_MS = 60_000;
const COMMIT_UNITS = 200;
const COMMIT_BYTES = 32 * 1024 * 1024;

export function extractCursor(family: string): string {
  return `extract:${family}`;
}


export function rebuildCursor(family: string): string {
  return `rebuild:${family}`;
}

export interface KeptFingerprint {
  parts?: Record<string, string>;
  reason?: string[];
  generation?: number;
}

export function fingerprintKey(family: string): string {
  return `fingerprint:${family}`;
}

export function keptFingerprint(tx: Pick<Tx, "tables">, family: string): KeptFingerprint | undefined {
  const text = tx.tables.meta.get(fingerprintKey(family));
  return text === undefined ? undefined : JSON.parse(text) as KeptFingerprint;
}

const NAMED_UNITS = 50;

export function rebuildExtracts(tx: Tx, family: string, now: number, fingerprint?: string): number {
  const cursor = tx.tables.cursors.get(extractCursor(family));
  const stamp = fingerprint ?? cursor?.fingerprint ?? undefined;
  if ((cursor?.seq ?? 0) === 0 && tx.records.top() === 0 && (tx.tables.cursors.get(rebuildCursor(family))?.seq ?? 0) === 0) {
    tx.tables.cursors.move(extractCursor(family), { at_ms: now, ...(stamp === undefined ? {} : { fingerprint: stamp }) });
    tx.tables.cursors.move(rebuildCursor(family), { seq: 0, at_ms: now });
    return tx.tables.cursors.get(rebuildCursor(family))!.generation;
  }
  const placed = (cursor?.seq ?? 0) === 0 ? { seq: tx.records.top(), reread: tx.records.newestReread() } : {};
  tx.tables.cursors.move(extractCursor(family), { ...placed, at_ms: now, ...(stamp === undefined ? {} : { fingerprint: stamp }) });
  tx.tables.cursors.move(rebuildCursor(family), { seq: 1, at_ms: now });
  tx.tables.meta.delete(walkPlace(family));
  return tx.tables.cursors.turn(rebuildCursor(family), now);
}

const SLAB_MS = 7 * 86_400_000;
function slabRecords(): number {
  const test = Number(process.env.LIFESTREAM_TEST_SLAB_RECORDS);
  return Number.isInteger(test) && test > 0 ? test : 20_000;
}

function chunkRecords(): number {
  const test = Number(process.env.LIFESTREAM_TEST_CHUNK_RECORDS);
  return Number.isInteger(test) && test > 0 ? test : CHUNK_RECORDS;
}

function walkMs(): number {
  const test = process.env.LIFESTREAM_TEST_WALK_MS;
  return test === undefined ? RUN_MS : Number(test);
}

interface Handed extends HeadAfter {
  source: string;
  kind: string;
}

interface Slab {
  handed?: Handed;
  touched: string[];
  previous: string[];
}

interface Place {
  seq: number;
  reread: number;
  reads: { source: string; now: number }[];
  next_ms?: number;
  slab?: Slab;
  aside: string[];
  errors?: Record<string, string>;
  log?: "reading" | "closing";
}

type Stage = "slabs" | "reading" | "closing";

function readPlace(tx: Pick<Tx, "tables">, family: string): Place | undefined {
  const text = tx.tables.meta.get(walkPlace(family));
  return text === undefined ? undefined : JSON.parse(text) as Place;
}

function writePlace(tx: Tx, family: string, place: Place): void {
  tx.tables.meta.set(walkPlace(family), JSON.stringify(place));
}

export function walkFloor(tx: Pick<Tx, "tables">, family: string): number | undefined {
  return readPlace(tx, family)?.reread;
}

interface ExtractData {
  family: string;
  cursor: number;
  reread: number;
  reads: { source: string; before: number | null; now: number }[];
}

interface UnitError {
  unit: string;
  error: string;
}

interface ExtractChunk {
  cursor?: { seq: number; reread: number };
  left?: string[];
  puts: ExtractRow[];
  deletes: string[];
  aside: UnitError[];
}

interface ExtractResult {
  statements: number;
  units: number;
  set_aside: number;
  more: boolean;
  touch_ms: number;
  build_ms: number;
}

interface ExtractState {
  reads: ExtractData["reads"];
  generation: number;
  written: number;
  deleted: number;
}

function familyOf(env: HelperEnv, name: string): Family {
  const family = env.registry.families.find((each) => each.name === name);
  if (family === undefined) throw new Error(`no family is named ${name}`);
  return family;
}

function extractHelper(env: HelperEnv, task: Task<ExtractData>): AsyncGenerator<ExtractChunk, ExtractResult, undefined> {
  return extractRun(env, familyOf(env, task.data.family), task.data, RUN_MS);
}

async function* extractRun(
  env: HelperEnv, family: Family, data: ExtractData, ms: number, next = false,
): AsyncGenerator<ExtractChunk, ExtractResult, undefined> {
  let { cursor, reread } = data;
  let read = 0;
  let more = false;
  let rereads = data.reads.filter((each) => each.before === null || each.now > each.before);
  const touched = new Set<string>();
  const previous = new Set<string>();
  const began = performance.now();
  let generation: HomeDb | undefined;
  let committed: OpenView | undefined;
  const view = env.db.view();
  try {
    let rows: View = view;
    if (next) {
      await env.committed();
      generation = openHome(env.folder, "read");
      committed = generation.view();
      rows = view.horizon(Number.MAX_SAFE_INTEGER, family.name, committed.next, data.reread);
    }
    const all = view.sources();
    const reads = readerOf(family.inputs, all);
    const sources = all.map((source) => source.id).filter((id) => reads(id));
    const kinds = [...new Set(family.inputs.flatMap((input) => input.kinds))];
    const statements = view.statements(cursor, { sources, kinds })[Symbol.iterator]();
    const touching = performance.now();
    for (;;) {
      const chunk = touchedChunk(family, reads, view, statements, cursor, reread, rereads, touched, previous, rows);
      rereads = [];
      read += chunk.statements;
      cursor = chunk.cursor;
      reread = chunk.reread;
      if (!chunk.full) break;
      more = read >= RUN_STATEMENTS || performance.now() - began >= ms;
      if (more) break;
    }
    const touch_ms = Math.round(performance.now() - touching);
    const left: string[] = [];
    const units = new Batches();
    const building = performance.now();
    yield* units.build(family, touched, previous, rows, env, (tried) => tried === 0 || performance.now() - began < ms, left);
    const batch = units.rest();
    if (cursor !== data.cursor || reread !== data.reread || batch.puts.length > 0 || batch.deletes.length > 0 || batch.aside.length > 0 || left.length > 0) {
      yield { ...batch, cursor: { seq: cursor, reread }, left };
    }
    return { statements: read, units: units.built, set_aside: units.set_aside, more: more || left.length > 0, touch_ms, build_ms: Math.round(performance.now() - building) };
  } finally {
    view.close();
    committed?.close();
    generation?.close();
  }
}

class Outcomes {
  readonly #threw: Map<string, string>;

  constructor(carried: readonly UnitError[]) {
    this.#threw = new Map(carried.map(({ unit, error }) => [unit, error]));
  }

  of(batch: ExtractChunk): void {
    for (const unit of [...batch.puts.map((row) => row.unit), ...batch.deletes]) this.#threw.delete(unit);
    for (const { unit, error } of batch.aside) this.#threw.set(unit, error);
  }

  get size(): number {
    return this.#threw.size;
  }

  list(): UnitError[] {
    return [...this.#threw].map(([unit, error]) => ({ unit, error }));
  }
}

class Batches {
  built = 0;
  set_aside = 0;
  unit_ms = 0;
  #batch: ExtractChunk = { puts: [], deletes: [], aside: [] };
  #bytes = 0;

  *build(
    family: Family, touched: ReadonlySet<string>, previous: ReadonlySet<string>, view: View, env: HelperEnv, may: (tried: number) => boolean = () => true, left: string[] = [],
  ): Generator<ExtractChunk, void, undefined> {
    for (const unit of new Set([...touched, ...previous])) {
      if (touched.has(unit) && !may(this.built + this.set_aside)) {
        left.push(unit);
        continue;
      }
      const outcome: Outcome = touched.has(unit) ? this.#tried(family, unit, view, env) : { kind: "gone" };
      if (outcome.kind === "built") {
        this.#batch.puts.push(outcome.row);
        this.#bytes += outcome.bytes;
      } else if (outcome.kind === "gone") this.#batch.deletes.push(unit);
      else this.#batch.aside.push({ unit, error: outcome.error });
      if (this.#batch.puts.length + this.#batch.deletes.length + this.#batch.aside.length < COMMIT_UNITS && this.#bytes < COMMIT_BYTES) continue;
      yield this.rest();
    }
  }

  #tried(family: Family, unit: string, view: View, env: HelperEnv): Outcome {
    const began = performance.now();
    try {
      const built = buildUnit(family, unit, view, env.blobs, env.settings.day);
      this.built++;
      return built === null ? { kind: "gone" } : { kind: "built", ...built };
    } catch (error) {
      if (homeFault(error) || error instanceof MissingVersion) throw error;
      this.set_aside++;
      return { kind: "threw", error: errorText(error) };
    } finally {
      this.unit_ms = Math.max(this.unit_ms, Math.round(performance.now() - began));
    }
  }

  rest(): ExtractChunk {
    const batch = this.#batch;
    this.#batch = { puts: [], deletes: [], aside: [] };
    this.#bytes = 0;
    return batch;
  }
}

interface Stream {
  source: string;
  kind: string;
  evidence: boolean;
}

function order(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function* untimedHeads(view: OpenView, streams: readonly Stream[], from: Handed | undefined): Generator<Head, void, undefined> {
  for (const stream of streams) {
    const at = from === undefined ? 1 : order(stream.source, from.source) || order(stream.kind, from.kind);
    if (at < 0) continue;
    for (const head of view.byStart(stream.source, stream.kind, at === 0 ? from : undefined)) {
      if (stream.evidence && head.start_ms !== null) break;
      yield head;
    }
  }
}

function* timedHeads(view: OpenView, streams: readonly Stream[], from: Handed, end: number): Generator<Head, void, undefined> {
  const after = (stream: Stream): HeadAfter => {
    const at = order(stream.source, from.source) || order(stream.kind, from.kind);
    return at < 0 ? { start_ms: from.start_ms! + 1, key: "" } : at === 0 ? from : { start_ms: from.start_ms, key: "" };
  };
  const heads = merged(streams.map((stream) => view.byStart(stream.source, stream.kind, after(stream))[Symbol.iterator]()));
  for (let head = heads.peek(); head !== undefined && head.start_ms! < end; head = heads.peek()) {
    heads.take();
    yield head;
  }
}

async function* slabs(env: HelperEnv, family: Family, from: Pick<WalkRead, "next_ms" | "slab" | "aside" | "reread">): AsyncGenerator<ExtractChunk, WalkResult, undefined> {
  const began = performance.now();
  const bound = walkMs();
  const over = () => performance.now() - began >= bound;
  const most = slabRecords();
  const view = env.db.view();
  try {
    const generation = openHome(env.folder, "read");
    try {
      const all = view.sources();
      const reads = readerOf(family.inputs, all);
      const evidence = readerOf(family.inputs.filter((input) => input.role === "evidence"), all);
      const kinds = [...new Set(family.inputs.flatMap((input) => input.kinds))];
      const streams: Stream[] = all.flatMap((source) => kinds.filter((kind) => reads(source.id, kind)).map((kind) => ({ source: source.id, kind, evidence: evidence(source.id, kind) })))
        .sort((left, right) => order(left.source, right.source) || order(left.kind, right.kind));
      const untimed = from.next_ms === undefined;
      const heads = merged(streams.filter((each) => each.evidence)
        .map((each) => view.byStart(each.source, each.kind, { start_ms: from.next_ms ?? Number.MIN_SAFE_INTEGER, key: "" })[Symbol.iterator]()));
      const units = new Batches();
      const aside = new Outcomes(from.aside);
      const writes = function* (batch: ExtractChunk): Generator<ExtractChunk, void, undefined> {
        aside.of(batch);
        if (batch.puts.length > 0 || batch.deletes.length > 0) yield batch;
      };
      let records = 0;
      let chunks = 0;
      let slabs = 0;
      let heap_max = 0;
      let longest_ms = 0;
      let chunk_ms = 0;
      const chunk = chunkRecords();
      const may = (tried: number) => tried + chunks === 0 || !over();
      const result = (next_ms: number | undefined, rest?: Slab): WalkResult => ({
        units: units.built, set_aside: aside.size, more: next_ms !== undefined || rest !== undefined, aside: aside.list(),
        slabs: {
          slabs, records, heap_max, longest_ms, unit_ms: units.unit_ms, chunk_ms, untimed,
          ...(next_ms === undefined ? {} : { next_ms }), ...(rest === undefined ? {} : { slab: rest }),
        },
      });
      const add = (found: readonly Touched[], touched: Set<string>, previous: Set<string>): void => {
        for (const unit of found) {
          touched.add(unit.unit);
          if (unit.previous !== undefined) previous.add(unit.previous);
        }
      };
      const hand = (pending: Iterator<Head>, through: View, touched: Set<string>, previous: Set<string>): Handed | undefined => {
        let last: Head | undefined;
        for (let step = pending.next(); step.done !== true;) {
          if (last !== undefined && over()) return { source: last.source, kind: last.kind, start_ms: last.start_ms, key: last.key };
          const changes: Change[] = [];
          for (let bytes = 0; step.done !== true && changes.length < chunk && bytes < CHUNK_BYTES; step = pending.next()) {
            last = step.value;
            const after = view.version(last.version);
            changes.push({ record: { source: last.source, kind: last.kind, key: last.key }, after });
            bytes += after.text.length;
          }
          const handBegan = performance.now();
          add(family.touched(changes, through), touched, previous);
          chunk_ms = Math.max(chunk_ms, Math.round(performance.now() - handBegan));
          records += changes.length;
          chunks++;
        }
        return undefined;
      };
      const slab = async function* (
        end: number, seed: Slab | undefined, pending: Iterable<Head> | undefined, opening = false,
      ): AsyncGenerator<ExtractChunk, Slab | undefined, undefined> {
        slabs++;
        await env.committed();
        let slabBegan = performance.now();
        const committed = generation.view();
        try {
          const through = view.horizon(end, family.name, committed.next, from.reread);
          const touched = new Set(seed?.touched);
          const previous = new Set(seed?.previous);
          if (opening) add(family.touched([], through), touched, previous);
          const stopped = pending === undefined ? undefined : hand(pending[Symbol.iterator](), through, touched, previous);
          if (stopped !== undefined) return { handed: stopped, touched: [...touched], previous: [...previous] };
          const left: string[] = [];
          const built = function* (): Generator<ExtractChunk, void, undefined> {
            for (const batch of units.build(family, touched, previous, through, env, may, left)) yield* writes(batch);
            yield* writes(units.rest());
          };
          for (const batch of built()) {
            const handedAt = performance.now();
            yield batch;
            slabBegan += performance.now() - handedAt;
          }
          return left.length === 0 ? undefined : { touched: left, previous: [] };
        } finally {
          committed.close();
          longest_ms = Math.max(longest_ms, Math.round(performance.now() - slabBegan));
          heap_max = Math.max(heap_max, process.memoryUsage().heapUsed);
        }
      };
      let cut: number | null = null;
      if (untimed) {
        const seed = from.slab;
        const pending = seed === undefined || seed.handed !== undefined ? untimedHeads(view, streams, seed?.handed) : undefined;
        const rest = yield* slab(Number.MAX_SAFE_INTEGER, seed, pending, seed === undefined);
        if (rest !== undefined) return result(undefined, rest);
      } else if (from.slab !== undefined) {
        const { handed } = from.slab;
        const end = cut = from.next_ms!;
        const rest = yield* slab(end, from.slab, handed === undefined ? undefined : timedHeads(view, streams.filter((each) => each.evidence), handed, end));
        if (rest !== undefined) return result(end, rest);
      }
      for (;;) {
        const next = heads.peek();
        if (next === undefined) break;
        if (slabs > 0 && over()) return result(cut ?? Math.floor(next.start_ms! / SLAB_MS) * SLAB_MS);
        let end = (Math.floor(next.start_ms! / SLAB_MS) + 1) * SLAB_MS;
        const taken: Head[] = [];
        cut = null;
        for (let head = heads.peek(); head !== undefined && head.start_ms! < end; head = heads.peek()) {
          if (taken.length >= most && head.start_ms! > taken.at(-1)!.start_ms!) {
            end = cut = head.start_ms!;
            break;
          }
          heads.take();
          taken.push(head);
        }
        const rest = yield* slab(end, undefined, taken);
        if (rest !== undefined) return result(end, rest);
      }
      return result(undefined);
    } finally {
      generation.close();
    }
  } finally {
    view.close();
  }
}

function merged(streams: Iterator<Head>[]): { peek(): Head | undefined; take(): void } {
  const fronts = streams.map((stream) => ({ stream, head: stream.next() }));
  let at: (typeof fronts)[number] | undefined;
  const order = (head: Head): number => head.start_ms ?? Number.NEGATIVE_INFINITY;
  const find = () => {
    at = undefined;
    for (const front of fronts) {
      if (front.head.done === true) continue;
      if (at === undefined || order(front.head.value) < order(at.head.value as Head)) at = front;
    }
  };
  find();
  return {
    peek: () => (at === undefined ? undefined : at.head.value as Head),
    take: () => {
      if (at === undefined) return;
      at.head = at.stream.next();
      find();
    },
  };
}

export function touchedChunk(
  family: Family, reads: (source: string, kind: string) => boolean, view: OpenView, statements: Iterator<Statement>, cursor: number, reread: number, readThroughs: ExtractData["reads"], touched: Set<string>, previous: Set<string>,
  rows: View = view,
): { cursor: number; reread: number; statements: number; full: boolean } {
  const records = new Map<string, { record: RecordRef; stated?: string[]; reread?: true }>();
  const entry = (record: RecordRef) => {
    const name = `${record.source}\0${record.kind}\0${record.key}`;
    let found = records.get(name);
    if (found === undefined) records.set(name, found = { record });
    return found;
  };
  let last = cursor;
  let count = 0;
  while (count < CHUNK_STATEMENTS) {
    const next = statements.next();
    if (next.done === true) break;
    const { seq, source, kind, key, version, late } = next.value;
    count++;
    last = seq;
    if (!late && reads(source, kind)) (entry({ source, kind, key }).stated ??= []).push(version);
  }
  const rereads = view.rereads(reread, CHUNK_STATEMENTS);
  for (const each of rereads) {
    if ("family" in each) {
      if (each.family === family.name) touched.add(each.unit);
    } else if (reads(each.record.source, each.record.kind)) entry(each.record).reread = true;
  }
  let changes: Change[] = [];
  let bytes = 0;
  const hand = () => {
    for (const unit of changes.length === 0 ? [] : family.touched(changes, rows)) {
      touched.add(unit.unit);
      if (unit.previous !== undefined) previous.add(unit.previous);
    }
    changes = [];
    bytes = 0;
  };
  const gather = (record: RecordRef, before: Version | undefined, after: Version | undefined) => {
    changes.push({ record, ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) });
    bytes += (before?.text.length ?? 0) + (after === before ? 0 : after?.text.length ?? 0);
    if (bytes >= CHUNK_BYTES) hand();
  };
  const read = (id: string | undefined): Version | undefined => (id === undefined ? undefined : view.version(id));
  for (const { record, stated, reread: asked } of records.values()) {
    let at = stated === undefined ? undefined : headAt(view, record, cursor);
    let before: Version | undefined | null = null;
    for (const version of stated ?? []) {
      const id = version === GONE ? undefined : version;
      if (id === at) continue;
      const after = read(id);
      gather(record, before === null ? read(at) : before, after);
      [at, before] = [id, after];
    }
    if (before === null && asked) {
      const head = view.head(record);
      const now = head === undefined ? undefined : read(head.version === GONE ? undefined : head.version);
      gather(record, now, now);
    }
  }
  hand();
  for (const move of readThroughs) {
    for (const unit of family.readThrough?.({ source: move.source, before_ms: move.before, after_ms: move.now }, rows) ?? []) touched.add(unit);
  }
  const full = count >= CHUNK_STATEMENTS;
  return { cursor: full ? last : view.through, reread: rereads.at(-1)?.seq ?? reread, statements: count, full: full || rereads.length >= CHUNK_STATEMENTS };
}

interface Built {
  row: ExtractRow;
  bytes: number;
}

type Outcome = ({ kind: "built" } & Built) | { kind: "gone" } | { kind: "threw"; error: string };

function buildUnit(family: Family, unit: string, view: View, files: BlobReader, settings: DaySettings): Built | null {
  const extracted = family.extract(unit, view, files);
  if (extracted === null) return null;
  const row: ExtractRow = {
    family: family.name, unit, reading: extracted.reading, code: family.code, content: extracted.content,
    start_ms: extracted.start_ms, end_ms: extracted.end_ms, days: [], seq: view.through,
  };
  for (const ms of [row.start_ms, row.end_ms]) if (ms !== null && !Number.isSafeInteger(ms)) throw new Error(`${unit} states the time ${ms}, no whole millisecond`);
  row.days = [...new Set(family.days(row, settings))].sort();
  row.items = [...new Set((family.items?.(row) ?? []).map((each) => each.item))].sort();
  return { row, bytes: canonical(row as unknown as Json).length };
}

function headAt(view: OpenView, record: RecordRef, seq: number): string | undefined {
  let id: string | undefined;
  for (const statement of view.history(record)) {
    if (statement.seq > seq) break;
    if (!statement.late) id = statement.version;
  }
  return id === GONE ? undefined : id;
}

export function putBack(tx: Tx, family?: string): number {
  const rows = tx.derived.extracts.aside.list(family);
  const units = new Map<string, string[]>();
  for (const row of rows) {
    const named = units.get(row.family);
    if (named === undefined) units.set(row.family, [row.unit]);
    else named.push(row.unit);
  }
  for (const [each, named] of units) tx.records.carryUnits(each, named);
  return rows.length;
}

function current(tx: Tx, running: Running<{ generation: number }>, name: string): boolean {
  if (tx.tables.cursors.get(name)?.generation === running.state.generation) return true;
  running.stale = true;
  return false;
}

function taken(running: Running, now: number): { lane: number; waited_ms: number } {
  return { lane: running.job.lane, waited_ms: (running.job.started_ms ?? now) - running.job.not_before_ms };
}

function readThroughs(tx: Tx, family: Family): { source: string; now: number }[] {
  return tx.tables.sources.list()
    .filter((source) => source.read_through_ms !== null && family.inputs.some((input) => input.role === "evidence" && selects(input.sources, source)))
    .map((source) => ({ source: source.id, now: source.read_through_ms! }));
}

export const extractKind: Kind<ExtractData, ExtractChunk, ExtractResult, ExtractState> = {
  dies: true,
  helper: extractHelper,
  begin(main, tx, job) {
    const family = main.families.get(job.key);
    if (family === undefined) throw new Error(`no family is named ${job.key}`);
    const reads = readThroughs(tx, family).map(({ source, now }) => ({ source, before: tx.tables.cursors.get(`read:${family.name}:${source}`)?.at_ms ?? null, now }));
    const cursor = tx.tables.cursors.get(extractCursor(family.name));
    return {
      data: { family: family.name, cursor: cursor?.seq ?? 0, reread: cursor?.reread ?? 0, reads },
      state: { reads, generation: cursor?.generation ?? 0, written: 0, deleted: 0 },
    };
  },
  chunk(main, running, chunk) {
    const family = running.job.key;
    return [{
      work(tx) {
        if (!current(tx, running, extractCursor(family))) return;
        const written = chunk.puts.filter((row) => tx.derived.extracts.put(row)).map((row) => row.unit);
        const deleted = chunk.deletes.filter((unit) => tx.derived.extracts.delete(family, unit) !== undefined);
        running.state.written += written.length;
        running.state.deleted += deleted.length;
        for (const unit of [...chunk.puts.map((row) => row.unit), ...chunk.deletes]) tx.derived.extracts.aside.built(family, unit);
        for (const { unit, error } of chunk.aside) tx.derived.extracts.aside.put(family, unit, error, main.now());
        if (chunk.cursor !== undefined) {
          tx.tables.cursors.move(extractCursor(family), { seq: chunk.cursor.seq, reread: chunk.cursor.reread, at_ms: main.now() });
          if (chunk.left !== undefined && chunk.left.length > 0) tx.records.carryUnits(family, chunk.left);
        }
        const units = [...written, ...deleted];
        if (units.length > 0) tx.tables.events.append({ at_ms: main.now(), kind: "extract", key: family, detail: { units: units.slice(0, NAMED_UNITS), count: units.length } });
      },
      after: () => {
        if (chunk.aside.length > 0) failpoint("extract.aside");
      },
    }];
  },
  done(main, tx, running, outcome) {
    const family = running.job.key;
    if (!current(tx, running, extractCursor(family))) return;
    const now = main.now();
    for (const read of running.state.reads) tx.tables.cursors.move(`read:${family}:${read.source}`, { at_ms: read.now });
    if (outcome.more) running.again = { at_ms: now, lane: running.job.lane };
    if (outcome.statements > 0 || outcome.units > 0 || outcome.set_aside > 0) {
      const run = tx.tables.runs.start({ kind: "extract", subject: running.job.key, started_ms: running.job.started_ms ?? now });
      tx.tables.runs.end(run, {
        ended_ms: now, outcome: "ok",
        counts: { statements: outcome.statements, units: outcome.units, written: running.state.written, deleted: running.state.deleted, set_aside: outcome.set_aside, touch_ms: outcome.touch_ms, build_ms: outcome.build_ms, ...taken(running, now) },
      });
    }
  },
};


interface WalkRead extends ExtractData {
  stage: Stage;
  next_ms?: number;
  slab?: Slab;
  aside: UnitError[];
}

type WalkData = WalkRead | { family: string; stage: "emptying" };

type WalkChunk = ExtractChunk | { empty: number };

const EMPTY_ROWS = 50;

interface WalkResult {
  units: number;
  set_aside: number;
  more: boolean;
  aside?: UnitError[];
  slabs?: { slabs: number; records: number; heap_max: number; longest_ms: number; unit_ms: number; chunk_ms: number; untimed: boolean; next_ms?: number; slab?: Slab };
  statements?: number;
  lists?: PublishLists & { compare_ms: number };
}

interface WalkState {
  stage: Stage | "emptying";
  reads: ExtractData["reads"];
  generation: number;
  emptied: number;
}

async function* walkHelper(env: HelperEnv, task: Task<WalkData>): AsyncGenerator<WalkChunk, WalkResult, undefined> {
  await holdpoint("walk.run", `${task.data.family} ${task.data.stage}`);
  if (task.data.stage === "emptying") return yield* emptying(env, task.data.family);
  const family = familyOf(env, task.data.family);
  if (task.data.stage === "slabs") return yield* slabs(env, family, task.data);
  const read = yield* extractRun(env, family, task.data, walkMs(), true);
  const result = { units: read.units, set_aside: read.set_aside, more: read.more, statements: read.statements };
  if (task.data.stage !== "closing" || read.more) return result;
  return { ...result, lists: await compared(env, family.name) };
}

async function* emptying(env: HelperEnv, family: string): AsyncGenerator<WalkChunk, WalkResult, undefined> {
  const began = performance.now();
  const bound = walkMs();
  const view = env.db.view();
  try {
    for (let after: string | null = null; ;) {
      const page = view.derived.next.units(family, after, EMPTY_ROWS);
      if (page.length === 0) return { units: 0, set_aside: 0, more: false };
      yield { empty: EMPTY_ROWS };
      after = page.at(-1)!;
      if (performance.now() - began >= bound) return { units: 0, set_aside: 0, more: true };
    }
  } finally {
    view.close();
  }
}

async function compared(env: HelperEnv, family: string): Promise<PublishLists & { compare_ms: number }> {
  await env.committed();
  const began = performance.now();
  const view = env.db.view();
  try {
    return { ...view.derived.extracts.compare(family), compare_ms: Math.round(performance.now() - began) };
  } finally {
    view.close();
  }
}

function walking(tx: Tx, running: Running<WalkState>): Place | undefined {
  if (!current(tx, running, rebuildCursor(running.job.key))) return undefined;
  const place = readPlace(tx, running.job.key);
  if (place === undefined) throw new Error(`walk ${running.job.key} lost its place under the generation it began under`);
  return place;
}

function noted(place: Place, chunk: ExtractChunk): boolean {
  const errors = new Map(place.aside.map((unit) => [unit, place.errors?.[unit]]));
  const cleared = [...chunk.puts.map((row) => row.unit), ...chunk.deletes].filter((unit) => errors.has(unit));
  if (cleared.length === 0 && chunk.aside.length === 0) return false;
  for (const unit of cleared) errors.delete(unit);
  for (const { unit, error } of chunk.aside) errors.set(unit, error);
  place.aside = [...errors.keys()];
  place.errors = Object.fromEntries([...errors].filter((entry): entry is [string, string] => entry[1] !== undefined));
  return true;
}

function walked(main: Main, tx: Tx, running: Running<WalkState>, outcome: WalkResult): void {
  const family = running.job.key;
  const now = main.now();
  const place = walking(tx, running);
  if (place === undefined) return;
  const { stage } = running.state;
  if (outcome.aside !== undefined) {
    place.aside = outcome.aside.map(({ unit }) => unit);
    place.errors = Object.fromEntries(outcome.aside.map(({ unit, error }) => [unit, error]));
  }
  const counts = {
    stage, units: outcome.units, set_aside: place.aside.length,
    ...(outcome.slabs === undefined
      ? { statements: outcome.statements ?? 0 }
      : {
        slabs: outcome.slabs.slabs, records: outcome.slabs.records, heap_max: outcome.slabs.heap_max, longest_ms: outcome.slabs.longest_ms,
        unit_ms: outcome.slabs.unit_ms, chunk_ms: outcome.slabs.chunk_ms, ...(outcome.slabs.untimed ? { untimed: 1 } : {}),
        ...(outcome.slabs.slab === undefined ? {} : { left: outcome.slabs.slab.touched.length }),
      }),
    ...taken(running, now),
  };
  const record = (more: Record<string, Json>, ended_ms = now) => {
    const run = tx.tables.runs.start({ kind: "walk", subject: family, started_ms: running.job.started_ms ?? now });
    tx.tables.runs.end(run, { ended_ms, outcome: "ok", counts: { ...counts, ...more } });
  };
  if (stage === "slabs" || outcome.more || stage === "reading") {
    if (stage === "slabs") {
      const { next_ms, slab } = outcome.slabs!;
      delete place.next_ms;
      delete place.slab;
      if (next_ms !== undefined) place.next_ms = next_ms;
      if (slab !== undefined) place.slab = slab;
      if (!outcome.more) place.log = "reading";
    } else {
      place.reads = running.state.reads.map(({ source, now }) => ({ source, now }));
      if (!outcome.more) place.log = "closing";
    }
    writePlace(tx, family, place);
    running.again = { at_ms: now, lane: place.log === "closing" ? LANE.live : LANE.backfill };
    record({});
    return;
  }
  for (const read of running.state.reads) tx.tables.cursors.move(`read:${family}:${read.source}`, { at_ms: read.now });
  for (const unit of place.aside) tx.derived.next.delete(family, unit);
  tx.derived.extracts.aside.clear(family);
  for (const unit of place.aside) tx.derived.extracts.aside.put(family, unit, place.errors?.[unit] ?? "", now);
  if (outcome.lists === undefined) throw new Error(`walk ${family}'s closing run read to its end and compared nothing`);
  const { compare_ms, ...lists } = outcome.lists;
  const began = performance.now();
  const { written, deleted, ...parts } = tx.derived.extracts.publish(family, lists);
  const publish_ms = Math.round(performance.now() - began);
  main.log({ publish: family, written: written.length, deleted: deleted.length, compare_ms, ...parts });
  tx.tables.cursors.move(extractCursor(family), { seq: place.seq, reread: place.reread, at_ms: now });
  if (place.aside.length > 0) tx.records.rereadUnits(family, place.aside);
  tx.tables.cursors.move(rebuildCursor(family), { seq: 0, at_ms: now });
  tx.tables.meta.delete(walkPlace(family));
  running.again = { at_ms: now, lane: LANE.backfill };
  const units = [...written, ...deleted];
  if (units.length > 0) tx.tables.events.append({ at_ms: now, kind: "extract", key: family, detail: { units: units.slice(0, NAMED_UNITS), count: units.length } });
  const kept = keptFingerprint(tx, family);
  const reason = kept?.generation === running.state.generation && kept.reason !== undefined ? kept.reason : ["unknown"];
  record({
    written: written.length, deleted: deleted.length, publish_ms, compare_ms, ...parts,
    changed_units: { written: written.slice(0, NAMED_UNITS), deleted: deleted.slice(0, NAMED_UNITS) }, reason,
  }, main.now());
}

function emptyable(tx: Tx, running: Running<WalkState>): boolean {
  if ((tx.tables.cursors.get(rebuildCursor(running.job.key))?.generation ?? 0) !== running.state.generation) {
    running.stale = true;
    return false;
  }
  return readPlace(tx, running.job.key) === undefined;
}

function emptied(main: Main, tx: Tx, running: Running<WalkState>): void {
  const family = running.job.key;
  const now = main.now();
  if (tx.derived.next.any(family) || (tx.tables.cursors.get(rebuildCursor(family))?.seq ?? 0) > 0) running.again = { at_ms: now, lane: LANE.backfill };
  const run = tx.tables.runs.start({ kind: "walk", subject: family, started_ms: running.job.started_ms ?? now });
  tx.tables.runs.end(run, { ended_ms: now, outcome: "ok", counts: { stage: "emptying", emptied: running.state.emptied, ...taken(running, now) } });
}

export const walkKind: Kind<WalkData, WalkChunk, WalkResult, WalkState> = {
  dies: true,
  helper: walkHelper,
  begin(main, tx, job) {
    const family = main.families.get(job.key);
    if (family === undefined) throw new Error(`no family is named ${job.key}`);
    let place = readPlace(tx, family.name);
    if (place !== undefined && place.next_ms === undefined && place.slab === undefined && place.log === undefined) {
      tx.tables.meta.delete(walkPlace(family.name));
      place = undefined;
    }
    const flag = tx.tables.cursors.get(rebuildCursor(family.name));
    if (place === undefined && tx.derived.next.any(family.name)) {
      return { data: { family: family.name, stage: "emptying" }, state: { stage: "emptying", reads: [], generation: flag?.generation ?? 0, emptied: 0 } };
    }
    if ((flag?.seq ?? 0) === 0) return null;
    const now = readThroughs(tx, family);
    if (place === undefined) {
      place = { seq: tx.records.top(), reread: tx.records.newestReread(), reads: now, aside: [] };
      writePlace(tx, family.name, place);
    }
    const stage: Stage = place.log ?? "slabs";
    const seen = new Map(place.reads.map(({ source, now }) => [source, now]));
    const reads = now.map(({ source, now }) => ({ source, before: seen.get(source) ?? null, now }));
    const closing = stage === "closing";
    if (closing && tx.tables.jobs.get("extract", family.name)?.state === "running") tx.tables.cursors.turn(extractCursor(family.name), main.now());
    const aside = place.aside.map((unit) => ({ unit, error: place.errors?.[unit] ?? "" }));
    return {
      data: {
        family: family.name, stage, ...(place.next_ms === undefined ? {} : { next_ms: place.next_ms }), ...(place.slab === undefined ? {} : { slab: place.slab }),
        aside, cursor: place.seq, reread: place.reread, reads,
      },
      state: { stage, reads, generation: flag!.generation, emptied: 0 },
      ...(closing ? { holds: [`extract:${family.name}`] } : {}),
    };
  },
  chunk(main, running, chunk) {
    const family = running.job.key;
    if ("empty" in chunk) {
      return [{
        work(tx) {
          if (emptyable(tx, running)) running.state.emptied += tx.derived.next.empty(family, chunk.empty);
        },
        after: () => failpoint("walk.emptied"),
      }];
    }
    return [{
      work(tx) {
        const place = walking(tx, running);
        if (place === undefined) return;
        for (const row of chunk.puts) tx.derived.next.put(row);
        for (const unit of chunk.deletes) tx.derived.next.delete(family, unit);
        const changed = noted(place, chunk);
        if (chunk.cursor !== undefined) {
          place.seq = chunk.cursor.seq;
          place.reread = chunk.cursor.reread;
          if (chunk.left !== undefined && chunk.left.length > 0) tx.records.carryUnits(family, chunk.left);
        }
        if (changed || chunk.cursor !== undefined) writePlace(tx, family, place);
      },
      after: () => {
        failpoint("extract.walked");
        if (chunk.cursor !== undefined) failpoint(`walk.${running.state.stage}`);
      },
    }];
  },
  done(main, tx, running, outcome) {
    if (running.state.stage === "emptying") emptied(main, tx, running);
    else walked(main, tx, running, outcome);
  },
};


const RUN_DAYS = 10;

interface RenderData {
  days: { day: string; marks: number }[];
}

type DayRendered = { day: string; marks: number } & (Rendered | { error: string });

interface Rendered {
  head: Omit<DayRow, "day">;
  staged?: Staged[];
  units: DayUnit[];
  devices: [string, string][];
}

interface RenderResult {
  days: number;
}

interface RenderState {
  written: number;
  current: number;
  set_aside: number;
}

async function* renderHelper(env: HelperEnv, task: Task<RenderData>): AsyncGenerator<DayRendered, RenderResult, undefined> {
  const { days } = task.data;
  let threw: string | undefined;
  let failed = 0;
  const view = env.db.view();
  try {
    const labels: LabelUnits = (unit) => {
      const row = view.extract(LABELS_FAMILY, unit);
      return row === undefined ? undefined : { reading: row.reading, code: row.code, content: row.content };
    };
    for (const { day, marks } of days) {
      let outcome: DayRendered;
      try {
        outcome = { day, marks, ...renderOne(env, view, labels, day) };
      } catch (error) {
        if (homeFault(error)) throw error;
        failed++;
        threw ??= `${day}: ${errorText(error)}`;
        outcome = { day, marks, error: errorText(error) };
      }
      yield outcome;
    }
  } finally {
    view.close();
  }
  if (days.length > 1 && failed === days.length) throw new Error(`every day of the run threw, the first ${threw}`);
  return { days: days.length };
}

function renderOne(env: HelperEnv, view: OpenView, labels: LabelUnits, day: string): Rendered {
  const rendered = renderDay(day, env.registry.families, view, env.settings.day, labels, (unit) => shownName(view.tables, unit));
  const { inputs, counts } = dayHead(rendered.json)!;
  const recorded = { head: { inputs, counts }, units: rendered.units, devices: rendered.devices };
  if (readDayHead(env.folder, day)?.inputs === inputs) return recorded;
  const staged: Staged[] = [];
  try {
    for (const [file, text] of [["lines", rendered.lines], ["txt", rendered.txt], ["json", rendered.json]] as const) staged.push(dayFile(env.folder, day, file).stage(Buffer.from(text)));
  } catch (error) {
    env.folder.discard(staged);
    throw error;
  }
  return { ...recorded, staged };
}

export const DAY_FILES = { json: "day.json", txt: "day.txt", lines: "day.lines.json" } as const;

export function dayPath(root: string, day: string, file: keyof typeof DAY_FILES): string {
  return join(root, "days", `${day}.${DAY_FILES[file]}`);
}

const HEAD_BYTES = 1 << 20;

export const DAY_FILE: FileKind = { role: "day" };

export function dayFile(folder: HomeFolder, day: string, file: keyof typeof DAY_FILES): KeptFile {
  return folder.file(DAY_FILE, dayPath(folder.root, day, file));
}

export function readDayHead(folder: HomeFolder, day: string): DayHead | null {
  const file = dayFile(folder, day, "json").opened();
  if (file === undefined) return null;
  try {
    const decoder = new TextDecoder("utf-8");
    const chunk = Buffer.alloc(64 * 1024);
    let text = "";
    for (let at = 0; at < HEAD_BYTES;) {
      const read = file.read(chunk, at);
      if (read === 0) break;
      at += read;
      text += decoder.decode(chunk.subarray(0, read), { stream: true });
      const head = dayHead(text);
      if (head !== null) return head;
    }
    return null;
  } finally {
    file.close();
  }
}

export const renderKind: Kind<RenderData, DayRendered, RenderResult, RenderState> = {
  dies: true,
  helper: renderHelper,
  begin(main, tx, job) {
    const now = main.now();
    const since = job.lane === LANE.live ? civilDay(now - RECENT_MS, main.settings.day) : undefined;
    const days = tx.tables.dirty.nextDays(RUN_DAYS, civilDay(now, main.settings.day), since);
    if (days.length === 0) return null;
    return { data: { days }, state: { written: 0, current: 0, set_aside: 0 } };
  },
  chunk(main, running, outcome) {
    const { day, marks } = outcome;
    return [{
      settle() {
        if ("error" in outcome || outcome.staged === undefined) return;
        main.folder.commit(outcome.staged);
        failpoint("day.written");
      },
      work(tx) {
        if ("error" in outcome) {
          if (tx.tables.dirty.setAsideDay(day, marks, outcome.error)) running.state.set_aside++;
          return;
        }
        tx.derived.dayUnits.put(day, outcome.units);
        const listed = tx.derived.days.put(day, outcome.head.inputs, outcome.head.counts);
        const changed = outcome.staged !== undefined;
        tx.tables.dirty.rendered(day, marks, changed || listed);
        if (tx.derived.dayUnits.stale(day) || outcome.devices.some(([unit, name]) => shownName(tx.tables, unit) !== name)) tx.tables.dirty.days([day]);
        running.state[changed ? "written" : "current"]++;
        if (changed || listed) tx.tables.events.append({ at_ms: main.now(), kind: "day", key: day, detail: { inputs: outcome.head.inputs } });
      },
    }];
  },
  done(main, tx, running, result) {
    const now = main.now();
    const run = tx.tables.runs.start({ kind: "render", subject: "days", started_ms: running.job.started_ms ?? now });
    tx.tables.runs.end(run, { ended_ms: now, outcome: "ok", counts: { days: result.days, ...running.state } });
  },
};

export function sweepDayTemporaries(root: string): void {
  let names: string[] = [];
  try {
    names = readdirSync(join(root, "days"));
  } catch {
    return;
  }
  for (const name of names) if ((name.startsWith(".") && name.endsWith(".tmp")) || name.startsWith(".tmp-")) rmSync(join(root, "days", name), { force: true });
}

function daysWithFiles(folder: HomeFolder): string[] {
  return folder.names(join(folder.root, "days")).map((name) => /^(\d{4}-\d{2}-\d{2})\.day\.json$/u.exec(name)?.[1]).filter((day): day is string => day !== undefined).sort();
}

export type DaysRead = { days: string[]; heads: ReadonlyMap<string, DayHead | null>; unread: string[]; ms: number } | { error: string };

export type Listed = { days: string[]; changed: number; unread: number } | { error: string };

export function readDays(folder: HomeFolder): DaysRead {
  const began = performance.now();
  let days: string[];
  try {
    days = daysWithFiles(folder);
  } catch (error) {
    return { error: errorText(error) };
  }
  const heads = new Map<string, DayHead | null>();
  const unread: string[] = [];
  for (const day of days) {
    try {
      heads.set(day, readDayHead(folder, day));
    } catch {
      unread.push(day);
    }
  }
  return { days, heads, unread, ms: Math.round(performance.now() - began) };
}

export function listDays(tx: Tx, read: DaysRead, now: number): Listed {
  if ("error" in read) {
    tx.tables.meta.delete(DAYS_MARK);
    return read;
  }
  const { days, heads, unread } = read;
  const kept = new Set(unread);
  const changed: [string, string | null][] = [];
  for (const [day, head] of heads) if (head !== null && tx.derived.days.put(day, head.inputs, head.counts)) changed.push([day, head.inputs]);
  for (let after: string | undefined; ;) {
    const page = tx.derived.days.page(undefined, undefined, after, LIST_PAGE);
    for (const { day } of page) if (!kept.has(day) && (heads.get(day) ?? null) === null && tx.derived.days.delete(day)) changed.push([day, null]);
    if (page.length < LIST_PAGE) break;
    after = page.at(-1)!.day;
  }
  for (const [day, inputs] of changed) tx.tables.events.append({ at_ms: now, kind: "day", key: day, detail: { inputs } });
  const lost = changed.filter(([, inputs]) => inputs === null).map(([day]) => day);
  if (lost.length > 0) tx.tables.dirty.days(lost);
  if (unread.length > 0) tx.tables.dirty.days(unread);
  tx.tables.meta.set(DAYS_MARK, RELEASE);
  return { days, changed: changed.length, unread: unread.length };
}

const LIST_PAGE = 1_000;
