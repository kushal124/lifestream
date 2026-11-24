import { parentPort, workerData } from "node:worker_threads";
import { openHandedFolder, type OpenedFile } from "@lifestreamprotocol/core";
import { DIM, ROW_BYTES } from "./screen-scan-wasm.js";
import { openedVectors, readRows, type ScanAsk, type Scanning, type Span } from "./screen-vectors.js";

const { bytes, layout, chunk, folder: handed } = workerData as Scanning;
const folder = openHandedFolder(handed);
interface Compiled {
  Module: new (bytes: Uint8Array) => object;
  Instance: new (module: object) => { exports: { memory: { buffer: ArrayBuffer }; scan(rows: number, count: number, ask: number, out: number): void } };
}

const { Module, Instance } = (globalThis as unknown as { WebAssembly: Compiled }).WebAssembly;
const wasm = new Instance(new Module(bytes)).exports;
const memory = wasm.memory.buffer;
const ask = new Float32Array(memory, layout.ask, DIM);
const out = new Float32Array(memory, layout.out, chunk);
const rows = Buffer.from(memory, layout.rows, chunk * ROW_BYTES);

function anyIn(only: Uint8Array, from: number, to: number): boolean {
  for (let row = from; row < to;) {
    if ((row & 7) === 0 && to - row >= 8) {
      if (only[row >> 3] !== 0) return true;
      row += 8;
    } else {
      if ((only[row >> 3]! & (1 << (row & 7))) !== 0) return true;
      row++;
    }
  }
  return false;
}

function scanned(spans: readonly Span[], query: Float32Array, k: number): [number, number, number][] {
  ask.set(query);
  const scores: number[] = [];
  const files: number[] = [];
  const at: number[] = [];
  let low = -Infinity;
  let lowAt = -1;
  const lowest = () => {
    lowAt = 0;
    for (let i = 1; i < k; i++) if (scores[i]! < scores[lowAt]!) lowAt = i;
    low = scores[lowAt]!;
  };
  const keep = (score: number, file: number, row: number) => {
    if (scores.length < k) {
      scores.push(score);
      files.push(file);
      at.push(row);
      if (scores.length === k) lowest();
      return;
    }
    scores[lowAt] = score;
    files[lowAt] = file;
    at[lowAt] = row;
    lowest();
  };
  for (const span of spans) {
    const opened: OpenedFile = openedVectors(folder, span.path);
    try {
      for (let from = span.from; from < span.to; from += chunk) {
        const n = Math.min(chunk, span.to - from);
        const only = span.only;
        if (only !== undefined && !anyIn(only, from, from + n)) continue;
        readRows(opened, rows.subarray(0, n * ROW_BYTES), from * ROW_BYTES, span.path, span.to);
        wasm.scan(layout.rows, n, layout.ask, layout.out);
        if (only === undefined) {
          for (let i = 0; i < n; i++) if (out[i]! > low) keep(out[i]!, span.file, from + i);
        } else {
          for (let i = 0; i < n; i++) {
            const row = from + i;
            if (out[i]! > low && (only[row >> 3]! & (1 << (row & 7))) !== 0) keep(out[i]!, span.file, row);
          }
        }
      }
    } finally {
      opened.close();
    }
  }
  return scores.map((score, i) => [score, files[i]!, at[i]!]);
}

parentPort!.on("message", ({ id, spans, query, k }: ScanAsk) => {
  try {
    parentPort!.postMessage({ id, hits: scanned(spans, query, k) });
  } catch (error) {
    parentPort!.postMessage({ id, error: (error as Error).message, code: (error as NodeJS.ErrnoException).code });
  }
});
