import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type Database from "better-sqlite3";
import { VECTOR_SEGMENT, type GrowingKind, type HandedFolder, type HomeFolder, type OpenedFile } from "@lifestreamprotocol/core";
import { threadProgram } from "./programs.js";
import { DIM, ROW_BYTES, scanLayout, scanModuleBytes } from "./screen-scan-wasm.js";

export const VECTOR_FILE: GrowingKind = { role: "vectors", segment: VECTOR_SEGMENT, grows: true };

export const CHUNK_ROWS = 16384;

export function createVectorTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta(name TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS screen_vector_file(model TEXT NOT NULL, month TEXT NOT NULL, rows INTEGER NOT NULL, file INTEGER NOT NULL DEFAULT 0, named INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(model, month)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS screen_vector(id INTEGER PRIMARY KEY, model TEXT NOT NULL, month TEXT NOT NULL, row INTEGER NOT NULL, text_hash TEXT NOT NULL, UNIQUE(model, text_hash), UNIQUE(model, month, row));
  `);
}

export function vectorFileOf(vectors: string, model: string, month: string, file = 0): string {
  return join(vectors, model, file === 0 ? `${month}.q8` : `${month}.${file}.q8`);
}

export const DEAD_SHARE = 0.25;

export function quantize(vector: Float32Array): Buffer {
  if (vector.length !== DIM) throw new Error(`a vector has ${DIM} dimensions, not ${vector.length}`);
  const row = Buffer.alloc(ROW_BYTES);
  let largest = 0;
  for (const value of vector) largest = Math.max(largest, Math.abs(value));
  let squares = 0;
  for (let at = 0; at < DIM; at++) {
    const value = largest === 0 ? 0 : Math.max(-127, Math.min(127, Math.round((vector[at]! / largest) * 127)));
    row.writeInt8(value, at);
    squares += value * value;
  }
  row.writeFloatLE(squares === 0 ? 0 : 1 / Math.sqrt(squares), DIM);
  return row;
}

export interface VectorAsked {
  readonly model: string;
  readonly generation: string;
}

export interface VectorReply {
  readonly textHash: string;
  readonly vector: Float32Array;
}

export function landVectors(db: Database.Database, folder: HomeFolder, vectors: string, asked: VectorAsked, replies: readonly VectorReply[], settings?: string): { landed: number; dropped: number } {
  const meta = db.prepare<[string], { value: string }>("SELECT value FROM meta WHERE name = ?");
  const queued = db.prepare<[string], { one: number }>("SELECT 1 AS one FROM screen_embed_queue WHERE text_hash = ?");
  const latest = db.prepare<[string], { day: string | null }>("SELECT max(day) AS day FROM screen_unit WHERE text_hash = ?");
  const fileRows = db.prepare<[string, string], { rows: number; file: number }>("SELECT rows, file FROM screen_vector_file WHERE model = ? AND month = ?");
  const named = db.prepare("INSERT INTO screen_vector(model, month, row, text_hash) VALUES (?, ?, ?, ?)");
  const raised = db.prepare("INSERT INTO screen_vector_file(model, month, rows, named) VALUES (?, ?, ?, ?) ON CONFLICT(model, month) DO UPDATE SET rows = excluded.rows, named = named + excluded.named");
  const unqueued = db.prepare("DELETE FROM screen_embed_queue WHERE text_hash = ?");
  const placed = db.prepare("UPDATE screen_unit SET vmonth = ?, vrow = ? WHERE text_hash = ?");
  return db.transaction(() => {
    if (meta.get("vector_model")?.value !== asked.model || meta.get("generation")?.value !== asked.generation) return { landed: 0, dropped: replies.length };
    const stands = meta.get("meaning_settings")?.value;
    if (settings !== undefined && stands !== undefined && stands !== settings) return { landed: 0, dropped: replies.length };
    const months = new Map<string, { textHash: string; row: Buffer }[]>();
    const seen = new Set<string>();
    for (const reply of replies) {
      if (seen.has(reply.textHash) || queued.get(reply.textHash) === undefined) continue;
      const day = latest.get(reply.textHash)?.day;
      if (day === null || day === undefined) continue;
      seen.add(reply.textHash);
      const month = day.slice(0, 7);
      const rows = months.get(month) ?? [];
      rows.push({ textHash: reply.textHash, row: quantize(reply.vector) });
      months.set(month, rows);
    }
    for (const [month, rows] of [...months].sort(([a], [b]) => a.localeCompare(b))) {
      const held = fileRows.get(asked.model, month);
      const from = held?.rows ?? 0;
      folder.file(VECTOR_FILE, vectorFileOf(vectors, asked.model, month, held?.file ?? 0)).append(Buffer.concat(rows.map((each) => each.row)), from * ROW_BYTES);
      rows.forEach((each, at) => {
        named.run(asked.model, month, from + at, each.textHash);
        placed.run(month, from + at, each.textHash);
        unqueued.run(each.textHash);
      });
      raised.run(asked.model, month, from + rows.length, rows.length);
    }
    return { landed: seen.size, dropped: replies.length - seen.size };
  }).immediate();
}

export function changeVectorModel(db: Database.Database, vectors: string, model: string | null, also: () => void = () => {}): void {
  const current = db.prepare<[], { value: string }>("SELECT value FROM meta WHERE name = 'vector_model'").get()?.value ?? null;
  if (current === model) return;
  const held = db.transaction(() => {
    const models = db.prepare<[], { model: string }>("SELECT DISTINCT model FROM screen_vector_file").all().map((each) => each.model);
    db.prepare("DELETE FROM screen_vector").run();
    db.prepare("DELETE FROM screen_vector_file").run();
    if (model === null) db.prepare("DELETE FROM meta WHERE name = 'vector_model'").run();
    else db.prepare("INSERT INTO meta(name, value) VALUES ('vector_model', ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").run(model);
    also();
    return models;
  }).immediate();
  for (const each of new Set([...held, ...(current === null ? [] : [current])])) rmSync(join(vectors, each), { recursive: true, force: true });
}

export interface VectorFile {
  readonly month: string;
  readonly file: number;
  readonly path: string;
  readonly rows: number;
  readonly dead: number;
}

export function vectorFiles(db: Database.Database, vectors: string, model: string): VectorFile[] {
  return db.prepare<[string], { month: string; rows: number; file: number; named: number }>(
    "SELECT month, rows, file, named FROM screen_vector_file WHERE model = ? AND rows > 0 ORDER BY month",
  ).all(model)
    .map((each) => ({ month: each.month, file: each.file, path: vectorFileOf(vectors, model, each.month, each.file), rows: each.rows, dead: each.rows - each.named }));
}

export interface VectorHit {
  readonly month: string;
  readonly file: number;
  readonly row: number;
  readonly score: number;
}

export function textsOf(db: Database.Database, model: string, hits: readonly VectorHit[]): (VectorHit & { textHash: string })[] {
  const at = db.prepare<[string, string, number, number], { text_hash: string }>(
    "SELECT v.text_hash FROM screen_vector v JOIN screen_vector_file f ON f.model = v.model AND f.month = v.month WHERE v.model = ? AND v.month = ? AND v.row = ? AND f.file = ?",
  );
  return hits.flatMap((hit) => {
    const text = at.get(model, hit.month, hit.row, hit.file);
    return text === undefined ? [] : [{ ...hit, textHash: text.text_hash }];
  });
}

export interface VectorScope {
  readonly files: readonly VectorFile[];
  readonly only?: readonly Uint8Array[];
  readonly extra: number;
}

export function scopeOf(db: Database.Database, vectors: string, model: string, days?: { from: string; to: string }): VectorScope {
  const files = vectorFiles(db, vectors, model);
  const span = db.prepare<[], { first: string | null; last: string | null }>("SELECT (SELECT min(day) FROM screen_unit) AS first, (SELECT max(day) FROM screen_unit) AS last").get();
  if (days === undefined || span?.first == null || (days.from <= span.first && days.to >= span.last!)) {
    return { files, extra: files.reduce((sum, each) => sum + each.dead, 0) };
  }
  const rowsOf = new Map(files.map((each) => [each.month, each.rows]));
  const eligible = new Map<string, Uint8Array>();
  const rows = db.prepare<[string, string], [string, number]>("SELECT vmonth, vrow FROM screen_unit WHERE day BETWEEN ? AND ? AND vrow IS NOT NULL")
    .raw().iterate(days.from, days.to) as IterableIterator<[string, number]>;
  for (const [month, row] of rows) {
    const size = rowsOf.get(month);
    if (size === undefined || row >= size) continue;
    let bits = eligible.get(month);
    if (bits === undefined) eligible.set(month, bits = new Uint8Array(Math.ceil(size / 8)));
    bits[row >> 3]! |= 1 << (row & 7);
  }
  const kept = files.filter((each) => eligible.has(each.month));
  return { files: kept, only: kept.map((each) => eligible.get(each.month)!), extra: 0 };
}

export async function nearest(db: Database.Database, scan: VectorScan, model: string, scope: VectorScope, ask: Float32Array, k: number): Promise<(VectorHit & { textHash: string })[]> {
  return textsOf(db, model, await scan.scan(scope.files, ask, k + scope.extra, scope.only)).slice(0, k);
}

export function compactVectors(db: Database.Database, folder: HomeFolder, vectors: string, model: string, share = DEAD_SHARE): string[] {
  const compacted: string[] = [];
  for (const each of vectorFiles(db, vectors, model)) {
    if (each.dead === 0 || each.dead <= each.rows * share) continue;
    compactMonth(db, folder, vectors, model, each);
    folder.file(VECTOR_FILE, each.path).remove();
    compacted.push(each.month);
  }
  return compacted;
}

export function purgeVectors(db: Database.Database, folder: HomeFolder, vectors: string, model: string): string[] {
  const old: string[] = [];
  const purged = db.transaction(() => vectorFiles(db, vectors, model).filter((each) => each.dead > 0).map((each) => {
    compactMonth(db, folder, vectors, model, each);
    old.push(each.path);
    return each.month;
  })).immediate();
  for (const path of old) folder.file(VECTOR_FILE, path).remove();
  sweepVectorFiles(db, folder, vectors);
  return purged;
}

function compactMonth(db: Database.Database, folder: HomeFolder, vectors: string, model: string, from: VectorFile): void {
  const kept = db.prepare<[string, string], { id: number; row: number; text_hash: string }>("SELECT id, row, text_hash FROM screen_vector WHERE model = ? AND month = ? ORDER BY row").all(model, from.month);
  const next = from.file + 1;
  const source = openedVectors(folder, from.path);
  try {
    folder.file(VECTOR_FILE, vectorFileOf(vectors, model, from.month, next)).write(keptRows(source, from, kept));
  } finally {
    source.close();
  }
  const renumber = db.prepare("UPDATE screen_vector SET row = ? WHERE id = ?");
  const replaced = db.prepare("UPDATE screen_unit SET vrow = ? WHERE text_hash = ?");
  db.transaction(() => {
    const now = db.prepare<[string, string], { rows: number; file: number }>("SELECT rows, file FROM screen_vector_file WHERE model = ? AND month = ?").get(model, from.month);
    if (now?.file !== from.file || now.rows !== from.rows) throw new Error(`the vectors of ${from.month} moved while they were compacted`);
    kept.forEach((each, at) => {
      renumber.run(at, each.id);
      replaced.run(at, each.text_hash);
    });
    db.prepare("UPDATE screen_vector_file SET file = ?, rows = ?, named = ? WHERE model = ? AND month = ?").run(next, kept.length, kept.length, model, from.month);
  }).immediate();
}

function* keptRows(source: OpenedFile, from: VectorFile, kept: readonly { row: number }[]): Generator<Buffer> {
  const chunk = Buffer.alloc(CHUNK_ROWS * ROW_BYTES);
  const out = Buffer.alloc(CHUNK_ROWS * ROW_BYTES);
  let at = 0;
  for (let first = 0; first < from.rows && at < kept.length; first += CHUNK_ROWS) {
    const want = Math.min(CHUNK_ROWS, from.rows - first) * ROW_BYTES;
    readRows(source, chunk.subarray(0, want), first * ROW_BYTES, from.path, from.rows);
    let filled = 0;
    for (; at < kept.length && kept[at]!.row < first + CHUNK_ROWS; at++) {
      const offset = (kept[at]!.row - first) * ROW_BYTES;
      chunk.copy(out, filled, offset, offset + ROW_BYTES);
      filled += ROW_BYTES;
    }
    yield out.subarray(0, filled);
  }
}

export function openedVectors(folder: HomeFolder, path: string): OpenedFile {
  const opened = folder.file(VECTOR_FILE, path).opened();
  if (opened === undefined) throw Object.assign(new Error(`${path} is gone`), { code: "ENOENT" });
  return opened;
}

export function readRows(opened: OpenedFile, into: Buffer, at: number, path: string, rows: number): void {
  for (let got = 0; got < into.length;) {
    const read = opened.read(into.subarray(got), at + got);
    if (read === 0) throw Object.assign(new Error(`${path} ends before its row ${rows}`), { code: "ESHORT" });
    got += read;
  }
}

export function sweepVectorFiles(db: Database.Database, folder: HomeFolder, vectors: string): void {
  const read = new Set(db.prepare<[], { model: string; month: string; file: number }>("SELECT model, month, file FROM screen_vector_file").all()
    .map((each) => vectorFileOf(vectors, each.model, each.month, each.file)));
  const current = db.prepare<[], { value: string }>("SELECT value FROM meta WHERE name = 'vector_model'").get()?.value;
  let models;
  try {
    models = readdirSync(vectors, { withFileTypes: true });
  } catch {
    return;
  }
  for (const model of models) {
    const kept = join(vectors, model.name);
    if (!model.isDirectory() || model.name !== current) {
      rmSync(kept, { recursive: true, force: true });
      continue;
    }
    for (const name of folder.names(kept)) if (!read.has(join(kept, name))) folder.file(VECTOR_FILE, join(kept, name)).remove();
  }
}

export interface Span {
  readonly file: number;
  readonly path: string;
  readonly from: number;
  readonly to: number;
  readonly only?: Uint8Array;
}

export interface ScanAsk {
  readonly id: number;
  readonly spans: readonly Span[];
  readonly query: Float32Array;
  readonly k: number;
}

export interface Scanning {
  readonly bytes: Uint8Array;
  readonly layout: ReturnType<typeof scanLayout>;
  readonly chunk: number;
  readonly folder: HandedFolder;
}

export interface Answer {
  readonly id: number;
  readonly hits?: [number, number, number][];
  readonly error?: string;
  readonly code?: string;
}

export class ScanError extends Error {
  override name = "ScanError";

  constructor(message: string, readonly moved: boolean) {
    super(message);
  }
}

type Workers = { worker: Worker; waiting: Map<number, (answer: Answer) => void> }[];

export class VectorScan {
  #workers: Workers | null = null;
  #next = 0;

  constructor(private readonly folder: HomeFolder) {}

  get root(): string {
    return this.folder.root;
  }

  async scan(files: readonly VectorFile[], ask: Float32Array, k: number, only?: readonly Uint8Array[]): Promise<VectorHit[]> {
    if (ask.length !== DIM) throw new Error(`an ask has ${DIM} dimensions, not ${ask.length}`);
    if (k < 1 || files.length === 0) return [];
    const workers = this.#start();
    const halves = split(files, workers.length, only);
    const answers = await Promise.all(workers.map((each, at) => {
      const id = this.#next++;
      return new Promise<Answer>((resolve) => {
        each.waiting.set(id, resolve);
        each.worker.postMessage({ id, spans: halves[at]!, query: ask, k } satisfies ScanAsk);
      });
    }));
    const failed = answers.find((each) => each.error !== undefined);
    if (failed !== undefined) throw new ScanError(`the meaning scan failed: ${failed.error}`, failed.code === "ENOENT" || failed.code === "ESHORT");
    return answers.flatMap((each) => each.hits!)
      .map(([score, file, row]) => ({ month: files[file]!.month, file: files[file]!.file, row, score }))
      .sort((a, b) => b.score - a.score || a.month.localeCompare(b.month) || a.row - b.row)
      .slice(0, k);
  }

  async close(): Promise<void> {
    const workers = this.#workers ?? [];
    this.#workers = null;
    await Promise.all(workers.map((each) => each.worker.terminate()));
  }

  #start(): Workers {
    if (this.#workers !== null) return this.#workers;
    const layout = scanLayout(CHUNK_ROWS);
    const scanning: Scanning = { bytes: scanModuleBytes(layout.pages), layout, chunk: CHUNK_ROWS, folder: this.folder.handOver(["files"]) };
    const program = threadProgram("scanner");
    const workers = [0, 1].map(() => {
      const worker = new Worker(program.url, { workerData: scanning, ...(program.execArgv === undefined ? {} : { execArgv: program.execArgv }) });
      worker.unref();
      const waiting = new Map<number, (answer: Answer) => void>();
      worker.on("message", (answer: Answer) => {
        waiting.get(answer.id)?.(answer);
        waiting.delete(answer.id);
      });
      const fail = (message: string) => {
        if (this.#workers === workers) this.#workers = null;
        for (const [id, resolve] of waiting) resolve({ id, error: message });
        waiting.clear();
      };
      worker.on("error", (error) => fail(error.message));
      worker.on("exit", () => fail("its worker ended"));
      return { worker, waiting };
    });
    this.#workers = workers;
    return workers;
  }
}

function split(files: readonly VectorFile[], parts: number, only?: readonly Uint8Array[]): Span[][] {
  const total = files.reduce((sum, each) => sum + each.rows, 0);
  const out: Span[][] = Array.from({ length: parts }, () => []);
  let part = 0;
  let left = Math.ceil(total / parts);
  files.forEach((each, file) => {
    let from = 0;
    while (from < each.rows) {
      const to = Math.min(each.rows, from + left);
      out[part]!.push({ file, path: each.path, from, to, ...(only === undefined ? {} : { only: only[file]! }) });
      left -= to - from;
      from = to;
      if (left === 0 && part < parts - 1) {
        part++;
        left = part === parts - 1 ? Infinity : Math.ceil(total / parts);
      }
    }
  });
  return out;
}
