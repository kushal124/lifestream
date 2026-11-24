import { createHash } from "node:crypto";
import { lstatSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import {
  addDays, BLOCKS, civilDay, FILES_END, MAP_SEQS, OwnerMap, SealedError, type BlobStore, type FileCursor, type FileKind, type FileSlab, type FillDays, type Holding, type HomeFolder, type KeptFile,
  type StoredFilling, type StoredMark, type TextSlab, type Tx,
} from "@lifestreamprotocol/core";
import { failpoint, holdpoint } from "./failpoint.js";
import type { HelperEnv, Kind, Task } from "./jobs.js";
import { readHome } from "./lifecycle.js";

export const STORED_KEY = "count";
export const STORED_REST = "stored:rest";
export const STORED_AT = "stored:at";
export const REST_ENTRIES = 200_000;

export interface Rest {
  bytes: number;
  entries: number;
  capped: boolean;
  at_ms: number;
}

export function readRest(value: string | undefined): Rest | null {
  return value === undefined ? null : JSON.parse(value) as Rest;
}

const OWN_FILES = [["home.db"], ["home.db-wal"], ["home.db-shm"], ["replies", "replies.db"], ["replies", "replies.db-wal"]] as const;

export function ownFiles(root: string): number {
  let bytes = 0;
  for (const parts of OWN_FILES) {
    try {
      bytes += statSync(join(root, ...parts)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return bytes;
}

export function ownNow(files: number, rest: number, text: number): number {
  return Math.max(0, files + rest - text);
}

export function walkRest(root: string, signal?: AbortSignal, cap = REST_ENTRIES): { bytes: number; entries: number; capped: boolean } {
  const replies = join(root, "replies");
  let bytes = 0;
  let entries = 0;
  const folders = [root];
  while (folders.length > 0) {
    signal?.throwIfAborted();
    const folder = folders.pop()!;
    let listed: Dirent[];
    try {
      listed = readdirSync(folder, { withFileTypes: true });
    } catch (error) {
      if (unreadable(error)) continue;
      throw error;
    }
    for (const entry of listed) {
      if (folder === root && (entry.name === "blobs" || entry.name === "inbox" || entry.name.startsWith("home.db"))) continue;
      if (folder === replies && entry.name.startsWith("replies.db")) continue;
      if (entries >= cap) return { bytes, entries, capped: true };
      entries++;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) folders.push(path);
      else if (entry.isFile()) {
        try {
          const stat = lstatSync(path);
          if (stat.nlink === 1) bytes += stat.size;
        } catch (error) {
          if (!unreadable(error)) throw error;
        }
      }
    }
  }
  return { bytes, entries, capped: false };
}

const unreadable = (error: unknown): boolean => ["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

export function storedMark(tx: Tx): StoredMark {
  tx.stored.begin();
  return tx.stored.mark();
}

const BATCH_MS = 200;
const RUN_MS = 60_000;

function batchMs(): number {
  const test = process.env.LIFESTREAM_TEST_STORED_MS;
  return test === undefined ? BATCH_MS : Number(test);
}

function runMs(): number {
  const test = process.env.LIFESTREAM_TEST_STORED_RUN_MS;
  return test === undefined ? RUN_MS : Number(test);
}

function mapSeqs(): number {
  const test = process.env.LIFESTREAM_TEST_STORED_SEQS;
  return test === undefined ? MAP_SEQS : Number(test);
}

export const OWNER_MAP: FileKind = { role: "owner-map", remade: true };

export function mapFileOf(folder: HomeFolder, machine: string): KeptFile {
  return folder.file(OWNER_MAP, join(machine, "stored", readHome(folder.root).id, "owners.map"));
}

interface MapHead {
  M: number;
  erasures: number;
  from: number;
  to: number;
  end: number;
  seq: number;
  first: string;
  sources: string[];
  length: number;
  sha256: string;
}

const bytesOf = (array: Uint16Array): Uint8Array => new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
const digest = (map: OwnerMap): string => createHash("sha256").update(bytesOf(map.owner)).update(bytesOf(map.day)).digest("hex");

export function saveMap(file: KeptFile, map: OwnerMap): void {
  const head: MapHead = {
    M: map.M, erasures: map.erasures, from: map.from, to: map.to, end: map.end, seq: map.seq, first: map.first, sources: map.sources, length: map.owner.length, sha256: digest(map),
  };
  const json = Buffer.from(JSON.stringify(head));
  const size = Buffer.alloc(4);
  size.writeUInt32LE(json.length);
  file.write(Buffer.concat([size, json, bytesOf(map.owner), bytesOf(map.day)]));
}

export function loadMap(file: KeptFile, days: FillDays): OwnerMap | null {
  let bytes: Buffer | undefined;
  try {
    bytes = file.read();
  } catch (error) {
    if (error instanceof SealedError) return null;
    throw error;
  }
  if (bytes === undefined || bytes.length < 4) return null;
  try {
    const length = bytes.readUInt32LE(0);
    if (bytes.length < 4 + length) return null;
    const head = JSON.parse(bytes.toString("utf8", 4, 4 + length)) as MapHead;
    if (bytes.length !== 4 + length + 4 * head.length) return null;
    const today = civilDay(days.now_ms, days.settings);
    const map = new OwnerMap(head.M, head.erasures, head.from, head.to, head.end, head.first, today < head.first ? head.first : today, days.settings);
    if (map.owner.length !== head.length) return null;
    map.seq = head.seq;
    for (const source of head.sources.slice(1)) map.number(source);
    bytesOf(map.owner).set(bytes.subarray(4 + length, 4 + length + 2 * head.length));
    bytesOf(map.day).set(bytes.subarray(4 + length + 2 * head.length));
    return digest(map) === head.sha256 ? map : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export function fits(map: OwnerMap, mark: StoredFilling): boolean {
  return map.M === mark.M && map.erasures === mark.erasures && (mark.blocks >= BLOCKS || map.covers(mark.blocks));
}

function fresh<T>(read: T | null): T {
  if (read === null) throw new Error("the owner map read stale on the view whose mark it fits");
  return read;
}

type Slab = { text: TextSlab } | { files: FileSlab };

interface StoredChunk {
  slabs: Slab[];
}

interface FillRun {
  maps: number;
  map_batches: number;
  map_ms: number;
  map_bytes: number;
  map_seq: number;
  map_end: number;
  loaded: number;
  load_ms: number;
  batches: number;
  slabs: number;
  files: number;
  read_ms: number;
}

interface Reading {
  rest: Rest;
  own: number;
  first: string;
  walk_ms: number;
}

interface StoredResult {
  fill: FillRun | null;
  reading: Reading | null;
  run_ms: number;
}

interface StoredState {
  refused: number;
  commit_ms: number;
}

async function* storedHelper(env: HelperEnv, task: Task<undefined>): AsyncGenerator<StoredChunk, StoredResult, undefined> {
  const began = performance.now();
  const skew = task.now_ms - Date.now();
  const days = (): FillDays => ({ settings: env.settings.day, now_ms: Date.now() + skew });
  const saved = mapFileOf(env.folder, env.machine);
  const loading = performance.now();
  let kept = loadMap(saved, days());
  const load_ms = Math.round(performance.now() - loading);
  let fill: FillRun | null = null;
  let map: OwnerMap | null = null;
  let ended = false;
  for (;;) {
    env.signal.throwIfAborted();
    const view = env.db.view();
    const slabs: Slab[] = [];
    let mapped = false;
    const read = performance.now();
    try {
      const mark = view.stored.mark();
      if ("complete" in mark) {
        ended = true;
        break;
      }
      fill ??= { maps: 0, map_batches: 0, map_ms: 0, map_bytes: 0, map_seq: 0, map_end: 0, loaded: 0, load_ms: 0, batches: 0, slabs: 0, files: 0, read_ms: 0 };
      let step = mark.blocks;
      let files: FileCursor = { after: mark.after, ...(mark.naming === undefined ? {} : { naming: mark.naming }) };
      if (step >= BLOCKS && files.after === FILES_END) {
        ended = true;
        break;
      }
      if (fill.batches + fill.map_batches > 0 && performance.now() - began >= runMs()) break;
      if (map === null || !fits(map, mark)) {
        if (kept !== null && fits(kept, mark)) {
          map = kept;
          fill.loaded++;
          fill.load_ms += load_ms;
        } else {
          const beginning = performance.now();
          map = view.stored.ownerMap(days())!;
          fill.maps++;
          fill.map_ms += Math.round(performance.now() - beginning);
        }
        kept = null;
        fill.map_bytes = map.owner.byteLength + map.day.byteLength;
      }
      if (!map.whole) {
        const mapping = performance.now();
        fresh(view.stored.mapBatch(map, mapSeqs()));
        fill.map_ms += Math.round(performance.now() - mapping);
        fill.map_batches++;
        mapped = true;
      } else {
        while (step < BLOCKS || files.after !== FILES_END) {
          if (step < BLOCKS && !map.covers(step)) break;
          if (step < BLOCKS) {
            slabs.push({ text: fresh(view.stored.text(map, step)) });
            step++;
          }
          if (files.after !== FILES_END) {
            const slab = fresh(view.stored.files(map, env.blobs, files));
            slabs.push({ files: slab });
            files = { after: slab.through, ...(slab.naming === undefined ? {} : { naming: slab.naming }) };
            fill.files += slab.files.length;
          }
          if (performance.now() - read >= batchMs()) break;
        }
      }
    } finally {
      if (fill !== null && map !== null) {
        fill.map_seq = map.seq;
        fill.map_end = map.end;
      }
      view.close();
    }
    if (mapped) {
      if (map!.whole) saveMap(saved, map!);
      await holdpoint("stored.mapped", `${fill!.map_batches}`);
      continue;
    }
    fill!.batches++;
    fill!.slabs += slabs.length;
    fill!.read_ms = Math.max(fill!.read_ms, Math.round(performance.now() - read));
    await holdpoint("stored.read", `${fill!.batches}`);
    yield { slabs };
    await env.committed();
  }
  if (!ended) {
    if (map !== null && !map.whole) {
      saveMap(saved, map);
      failpoint("stored.map");
    }
    return { fill, reading: null, run_ms: Math.round(performance.now() - began) };
  }
  saved.remove();
  const walking = performance.now();
  const walked = walkRest(env.folder.root, env.signal);
  const rest: Rest = { ...walked, at_ms: Date.now() + skew };
  const view = env.db.view();
  let text: number;
  try {
    text = view.stored.textCounted();
  } finally {
    view.close();
  }
  const own = ownNow(ownFiles(env.folder.root), rest.bytes, text);
  const first = civilDay(Date.parse(readHome(env.folder.root).created), env.settings.day);
  return { fill, reading: { rest, own, first, walk_ms: Math.round(performance.now() - walking) }, run_ms: Math.round(performance.now() - began) };
}

export const storedKind: Kind<undefined, StoredChunk, StoredResult, StoredState> = {
  dies: true,
  begin: () => ({ data: undefined, state: { refused: 0, commit_ms: 0 } }),
  helper: storedHelper,
  chunk: (main, running, chunk) => [{
    work(tx) {
      const began = performance.now();
      let counted = false;
      for (const slab of chunk.slabs) {
        if ("text" in slab ? tx.stored.countText(slab.text) : tx.stored.countFiles(slab.files)) counted = true;
        else running.state.refused++;
      }
      if (counted) tx.tables.meta.set(STORED_AT, String(main.now()));
      running.state.commit_ms = Math.max(running.state.commit_ms, Math.round(performance.now() - began));
    },
    after: () => failpoint("stored.slab"),
  }],
  done(main, tx, running, result) {
    const now = main.now();
    const { reading } = result;
    if (reading !== null) tx.tables.meta.set(STORED_REST, JSON.stringify(reading.rest));
    const completed = result.fill !== null && reading !== null && tx.stored.complete(reading.own);
    if (completed) tx.tables.meta.delete(STORED_AT);
    const mark = storedMark(tx);
    if (!("complete" in mark)) running.again = { at_ms: now, lane: running.job.lane };
    const closed = addDays(civilDay(now, main.settings.day), -1);
    if (reading !== null && "complete" in mark && closed >= reading.first) tx.stored.close(closed, reading.own);
    if (reading !== null && (completed || result.fill === null)) {
      tx.tables.events.append({ at_ms: now, kind: "stored", key: completed ? "fill" : "rest", detail: { own: reading.own, rest: reading.rest.bytes } });
    }
    main.log({
      stored: result.fill === null ? "rest" : "fill", ...(completed ? { completed: true } : {}), ...result.fill,
      refused: running.state.refused, commit_ms: running.state.commit_ms,
      ...(reading === null ? {} : {
        walk_ms: reading.walk_ms, entries: reading.rest.entries, rest: reading.rest.bytes, ...(reading.rest.capped ? { capped: true } : {}), own: reading.own,
      }),
      run_ms: result.run_ms,
      ...("complete" in mark ? {} : { blocks: mark.blocks, after: mark.after }),
    });
  },
};

export function measured(blobs: Pick<BlobStore, "has" | "stored">, lengths: Readonly<Record<string, number>> | undefined): Holding {
  return { has: (hash) => blobs.has(hash), stored: (hash) => (lengths !== undefined && Object.hasOwn(lengths, hash) ? lengths[hash] : blobs.stored(hash)) };
}

export function lengthsOf(store: Pick<BlobStore, "stored">, blobs: Iterable<string>): Record<string, number> {
  const lengths: Record<string, number> = {};
  for (const blob of blobs) {
    if (Object.hasOwn(lengths, blob) || !HASH.test(blob)) continue;
    const bytes = store.stored(blob);
    if (bytes !== undefined) lengths[blob] = bytes;
  }
  return lengths;
}

const HASH = /^sha256:[0-9a-f]{64}$/u;

