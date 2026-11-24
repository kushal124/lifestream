import { Readable } from "node:stream";
import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from "node:worker_threads";
import { constants, gunzipSync } from "node:zlib";
import { hostFault } from "@lifestreamprotocol/core";
import { Refused, refuse } from "./refused.js";
import { BYTES_LIMIT } from "./zip.js";

/** One file or folder a gzipped tar holds. */
export interface TarEntry {
  /** Its path inside the tar, its long name when a GNU or PAX header gives one. */
  readonly name: string;
  /** Its size in bytes, as its header states it. */
  readonly size: number;
  /** Whether it is a folder. */
  readonly directory: boolean;
  /** Its bytes at once, inflated from the archive, refused before any is read when it holds more than the limit given, `BYTES_LIMIT` when none is. */
  bytes(limit?: number): Buffer;
  /** Its bytes as a stream, inflated from the archive. */
  stream(): Readable;
}

/** A gzipped tar file on disk, read by inflating it from the start. */
export interface Tgz {
  /** The file it was opened from. */
  readonly path: string;
  /** Its files and folders in the archive's order, found by inflating the whole archive, with `progress` told how many bytes have been inflated. */
  entries(progress?: (inflated: number) => void): Generator<TarEntry>;
  /** Stops every read still open and frees the copy it was opened from, if any. */
  close(): void;
}

const BLOCK = 512;
const PIECE = 64 * 1024;
const CHUNK = 1024 * 1024;
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

/** Whether a file's first bytes are a gzip that inflates to a tar header, as the first 64 KiB of a gzipped tar do. */
export function isTgz(head: Buffer): boolean {
  if (head.length < 2 || !head.subarray(0, 2).equals(GZIP_MAGIC)) return false;
  let inflated: Buffer;
  try {
    inflated = gunzipSync(head, { finishFlush: constants.Z_SYNC_FLUSH });
  } catch {
    return false;
  }
  return inflated.length >= BLOCK && headerOf(inflated.subarray(0, BLOCK)) !== null;
}

export const TGZ_HEAD = 64 * 1024;

/** Opens a gzipped tar file on disk, with `dispose` run once it closes. */
export function openTgz(path: string, dispose?: () => void): Tgz {
  const open = new Set<Inflated>();
  let resting: Inflated | null = null;
  let closed = false;
  const fresh = (): Inflated => {
    if (closed) throw new Error(`${path} is closed`);
    const inflated = new Inflated(path, () => open.delete(inflated));
    open.add(inflated);
    return inflated;
  };
  const take = (at: number): Inflated => {
    const kept = resting;
    resting = null;
    if (kept !== null && kept.position <= at) return kept;
    kept?.close();
    return fresh();
  };
  const rest = (cursor: Inflated): void => {
    if (closed) return cursor.close();
    if (resting !== null && resting !== cursor) resting.close();
    resting = cursor;
  };
  function* range(name: string, at: number, size: number): Generator<Buffer> {
    const cursor = take(at);
    let whole = false;
    try {
      if (!cursor.skip(at - cursor.position)) refuse(`${path}: ${name}: the archive ends before the member`);
      for (let left = size; left > 0;) {
        const piece = cursor.next(Math.min(left, CHUNK));
        if (piece === null) refuse(`${path}: ${name}: the archive ends inside the member`);
        left -= piece.length;
        yield piece;
      }
      whole = true;
    } finally {
      if (whole || cursor.healthy) rest(cursor);
      else cursor.close();
    }
  }
  const entry = (name: string, size: number, at: number, directory: boolean): TarEntry => ({
    name, size, directory,
    bytes(limit = BYTES_LIMIT) {
      if (size > limit) refuse(`${path}: ${name} holds ${size} bytes, past the ${limit} a whole read takes`);
      return Buffer.concat([...range(name, at, size)], size);
    },
    stream: () => Readable.from(range(name, at, size), { objectMode: false }),
  });
  return {
    path,
    *entries(progress) {
      const reader = fresh();
      try {
        let long: string | null = null;
        let pax: { path?: string; size?: number } = {};
        for (;;) {
          const block = reader.read(BLOCK);
          if (block === null || block.every((byte) => byte === 0)) return;
          const header = headerOf(block) ?? refuse(`${path}: a header at byte ${reader.position - BLOCK} of the tar does not read (its checksum does not hold)`);
          const size = pax.size ?? header.size;
          const at = reader.position;
          const padded = Math.ceil(size / BLOCK) * BLOCK;
          if (header.type === "L" || header.type === "x" || header.type === "g") {
            const data = reader.read(padded)?.subarray(0, size) ?? refuse(`${path}: the archive ends inside an extended header`);
            if (header.type === "L") long = cString(data);
            else if (header.type === "x") pax = paxOf(data);
            continue;
          }
          const name = pax.path ?? long ?? header.name;
          long = null;
          pax = {};
          if (header.type === "0" || header.type === "7" || header.type === "5") yield entry(name, size, at, header.type === "5" || name.endsWith("/"));
          progress?.(reader.position);
          if (!reader.skip(padded, progress)) refuse(`${path}: ${name}: the archive ends inside the member`);
        }
      } finally {
        reader.close();
      }
    },
    close() {
      if (closed) return;
      closed = true;
      for (const each of [...open]) each.close();
      dispose?.();
    },
  };
}

function headerOf(block: Buffer): { name: string; size: number; type: string } | null {
  const stated = Number.parseInt(cString(block.subarray(148, 156)).trim() || "x", 8);
  let sum = 0;
  for (let at = 0; at < BLOCK; at++) sum += at >= 148 && at < 156 ? 0x20 : block[at]!;
  if (!Number.isSafeInteger(stated) || stated !== sum) return null;
  const name = cString(block.subarray(0, 100));
  const ustar = block.subarray(257, 262).toString("latin1") === "ustar";
  const prefix = ustar ? cString(block.subarray(345, 500)) : "";
  const flag = block[156]!;
  return { name: prefix === "" ? name : `${prefix}/${name}`, size: sizeOf(block.subarray(124, 136)), type: flag === 0 ? "0" : String.fromCharCode(flag) };
}

function sizeOf(field: Buffer): number {
  if ((field[0]! & 0x80) !== 0) {
    let value = field[0]! & 0x7f;
    for (let at = 1; at < field.length; at++) value = value * 256 + field[at]!;
    return value;
  }
  const text = cString(field).trim();
  return text === "" ? 0 : Number.parseInt(text, 8);
}

function paxOf(data: Buffer): { path?: string; size?: number } {
  const out: { path?: string; size?: number } = {};
  for (let at = 0; at < data.length;) {
    const space = data.indexOf(0x20, at);
    const length = Number.parseInt(data.subarray(at, space).toString("latin1"), 10);
    if (space < 0 || !Number.isSafeInteger(length) || length <= 0) break;
    const record = data.subarray(space + 1, at + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (record.slice(0, equals) === "path") out.path = record.slice(equals + 1);
    if (record.slice(0, equals) === "size") out.size = Number(record.slice(equals + 1));
    at += length;
  }
  return out;
}

function cString(bytes: Buffer): string {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end < 0 ? bytes.length : end).toString("utf8");
}

const INFLATING = `
const { parentPort, workerData } = require("node:worker_threads");
const { createReadStream } = require("node:fs");
const { createGunzip } = require("node:zlib");
const { path, turn: shared, port, piece } = workerData;
const turn = new Int32Array(shared);
const gunzip = createGunzip();
createReadStream(path, { highWaterMark: piece }).on("error", (error) => gunzip.destroy(error)).pipe(gunzip);
let asked = false;
let failed = null;
let ended = false;
gunzip.on("error", (error) => { failed = { error: error.message, code: typeof error.code === "string" ? error.code : undefined }; serve(); });
gunzip.on("end", () => { ended = true; serve(); });
gunzip.on("readable", () => serve());
function answer(message, transfer) {
  asked = false;
  port.postMessage(message, transfer);
  Atomics.store(turn, 0, 1);
  Atomics.notify(turn, 0);
}
function serve() {
  if (!asked) return;
  const chunk = failed === null ? gunzip.read() : null;
  if (chunk !== null) {
    const bytes = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.length);
    return answer({ chunk: bytes }, [bytes]);
  }
  if (failed !== null) return answer(failed);
  if (ended) return answer({ end: true });
}
parentPort.on("message", () => { asked = true; serve(); });
`;

const ANSWER_MS = 5 * 60_000;

export interface InflateAnswer {
  chunk?: ArrayBuffer;
  end?: true;
  error?: string;
  code?: string;
}

export function pieceOf(path: string, position: number, answer: InflateAnswer | undefined): InflateAnswer {
  if (answer === undefined) {
    throw Object.assign(new Error(`${path}: the inflating thread gave no piece (its wait is at most ${ANSWER_MS / 60_000} minutes)`), { code: "ETIMEDOUT" });
  }
  if (answer.error === undefined) return answer;
  const failed = Object.assign(new Error(`${path}: ${answer.error}`), { code: answer.code });
  if (hostFault(failed)) throw failed;
  throw new Refused(`${path}: its gzip does not inflate after ${position} inflated bytes: ${answer.error}`);
}

class Inflated {
  readonly #worker: Worker;
  readonly #port: MessagePort;
  readonly #turn = new Int32Array(new SharedArrayBuffer(4));
  readonly #pending: Buffer[] = [];
  readonly #closed: () => void;
  #ended = false;
  #open = true;
  position = 0;
  healthy = true;

  constructor(readonly path: string, closed: () => void) {
    const { port1, port2 } = new MessageChannel();
    this.#port = port1;
    this.#worker = new Worker(INFLATING, { eval: true, workerData: { path, turn: this.#turn.buffer, port: port2, piece: PIECE }, transferList: [port2] });
    this.#worker.unref();
    this.#closed = closed;
  }

  next(max: number): Buffer | null {
    while (this.#pending.length === 0) {
      if (this.#ended) return null;
      this.#feed();
    }
    const head = this.#pending[0]!;
    const taken = head.length <= max ? (this.#pending.shift()!) : head.subarray(0, max);
    if (taken !== head) this.#pending[0] = head.subarray(max);
    this.position += taken.length;
    return taken;
  }

  read(length: number): Buffer | null {
    const parts: Buffer[] = [];
    for (let left = length; left > 0;) {
      const piece = this.next(left);
      if (piece === null) return null;
      parts.push(piece);
      left -= piece.length;
    }
    return Buffer.concat(parts, length);
  }

  skip(length: number, progress?: (inflated: number) => void): boolean {
    for (let left = length; left > 0;) {
      const piece = this.next(Math.min(left, CHUNK));
      if (piece === null) return false;
      left -= piece.length;
      progress?.(this.position);
    }
    return true;
  }

  #feed(): void {
    Atomics.store(this.#turn, 0, 0);
    this.#worker.postMessage(null);
    const waited = Atomics.wait(this.#turn, 0, 0, ANSWER_MS);
    const message = receiveMessageOnPort(this.#port)?.message as InflateAnswer | undefined;
    let answer: InflateAnswer;
    try {
      answer = pieceOf(this.path, this.position, waited === "timed-out" ? undefined : message);
    } catch (error) {
      this.healthy = false;
      throw error;
    }
    if (answer.chunk !== undefined) this.#pending.push(Buffer.from(answer.chunk));
    if (answer.end === true) this.#ended = true;
  }

  close(): void {
    if (!this.#open) return;
    this.#open = false;
    this.#port.close();
    void this.#worker.terminate();
    this.#closed();
  }
}
