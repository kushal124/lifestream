import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { closeSync, createReadStream, fstatSync, fsyncSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeSync } from "node:fs";
import { open, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pipeline, Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline as pipelined } from "node:stream/promises";

export const HEADER_BYTES = 40;
export const TAG_BYTES = 16;
export const FILES_KEY_BYTES = 32;
export const IDENTITY_BYTES = 32;
export const SEGMENT = 64 * 1024;
export const VECTOR_SEGMENT = 1024 * 1024;
export const MAX_SEGMENTS = 0xffffffff;

const SALT_BYTES = 32;
const PREFIX_BYTES = 7;
const FORMAT = "lifestream:1";

export type SegmentSize = typeof SEGMENT | typeof VECTOR_SEGMENT;

export interface Sealing {
  key: Buffer;
  associatedData: string;
  segment: SegmentSize;
}

export type SealedErrorCode = "SEALED_DAMAGED" | "SEALED_TOO_LARGE" | "SEALED_BAD_RANGE" | "SEALED_BAD_KEY";

export class SealedError extends Error {
  static override [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof Error && value.name === "SealedError";
  }

  constructor(
    readonly code: SealedErrorCode,
    readonly file: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${file}: ${message}`, options);
    this.name = "SealedError";
  }
}

export function blobData(): string {
  return `${FORMAT}:blob`;
}

export function fileData(role: string, plainName: string): string {
  if (role === "" || role.includes(":") || role === "blob") throw new Error(`a sealed file's role is a word of its own: ${JSON.stringify(role)}`);
  if (plainName === "") throw new Error(`a sealed ${role} file has a plain name`);
  return `${FORMAT}:${role}:${plainName}`;
}

export function blobSealing(key: Buffer): Sealing {
  return { key, associatedData: blobData(), segment: SEGMENT };
}

const KEYED = /^(.+)\.k([1-9][0-9]*)$/;

export function keyedName(plainName: string, keyId: number): string {
  return `${plainName}.k${keyIdOf(keyId)}`;
}

export function nameKey(name: string): { plainName: string; keyId: number } | undefined {
  const match = KEYED.exec(name);
  if (match === null) return undefined;
  return { plainName: match[1]!, keyId: Number(match[2]) };
}

export function blobTree(root: string, keyId: number): string {
  return join(root, `k${keyIdOf(keyId)}`);
}

function keyIdOf(keyId: number): number {
  if (!Number.isSafeInteger(keyId) || keyId < 1) throw new Error(`a data key's id is a whole number from 1: ${keyId}`);
  return keyId;
}

export function freshHeader(): Buffer {
  return Buffer.concat([Buffer.from([HEADER_BYTES]), randomBytes(SALT_BYTES + PREFIX_BYTES)]);
}

function firstPlain(segment: number): number {
  return segment - HEADER_BYTES - TAG_BYTES;
}

function plainOf(segment: number, index: number): number {
  return index === 0 ? firstPlain(segment) : segment - TAG_BYTES;
}

function diskOf(segment: number, index: number): number {
  return index === 0 ? segment - HEADER_BYTES : segment;
}

function fileKey(sealing: Sealing, salt: Buffer, file: string): Buffer {
  if (sealing.key.length !== FILES_KEY_BYTES) throw new SealedError("SEALED_BAD_KEY", file, `a files key is ${FILES_KEY_BYTES} bytes, not ${sealing.key.length}`);
  if (sealing.segment !== SEGMENT && sealing.segment !== VECTOR_SEGMENT) throw new SealedError("SEALED_BAD_KEY", file, `no role seals in segments of ${sealing.segment}`);
  return Buffer.from(hkdfSync("sha256", sealing.key, salt, Buffer.from(sealing.associatedData, "utf8"), FILES_KEY_BYTES));
}

export function segmentNonce(prefix: Buffer, index: number, last: boolean, file: string): Buffer {
  if (index >= MAX_SEGMENTS) throw new SealedError("SEALED_TOO_LARGE", file, `more than ${MAX_SEGMENTS} segments`);
  const nonce = Buffer.alloc(PREFIX_BYTES + 5);
  prefix.copy(nonce, 0);
  nonce.writeUInt32BE(index, PREFIX_BYTES);
  nonce[PREFIX_BYTES + 4] = last ? 1 : 0;
  return nonce;
}

interface Opened {
  key: Buffer;
  prefix: Buffer;
}

function headerOf(header: Buffer, sealing: Sealing, file: string): Opened {
  if (header.length < HEADER_BYTES || header[0] !== HEADER_BYTES) throw damaged(file, "its header is not 40 bytes");
  return { key: fileKey(sealing, header.subarray(1, 1 + SALT_BYTES), file), prefix: Buffer.from(header.subarray(1 + SALT_BYTES, HEADER_BYTES)) };
}

function sealSegment(opened: Opened, index: number, last: boolean, plain: Buffer, file: string): Buffer {
  const cipher = createCipheriv("aes-256-gcm", opened.key, segmentNonce(opened.prefix, index, last, file));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([body, cipher.getAuthTag()]);
}

function openSegment(opened: Opened, index: number, last: boolean, sealed: Buffer, file: string): Buffer {
  if (sealed.length < TAG_BYTES) throw damaged(file, `segment ${index} is shorter than its tag`);
  try {
    const decipher = createDecipheriv("aes-256-gcm", opened.key, segmentNonce(opened.prefix, index, last, file));
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    const plain = decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES));
    return Buffer.concat([plain, decipher.final()]);
  } catch (error) {
    if (error instanceof SealedError) throw error;
    throw damaged(file, `segment ${index} fails its tag`, error);
  }
}

function damaged(file: string, why: string, cause?: unknown): SealedError {
  return new SealedError("SEALED_DAMAGED", file, `the sealed file is damaged: ${why}`, cause === undefined ? undefined : { cause });
}

class Held {
  #parts: Buffer[] = [];
  bytes = 0;

  add(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.#parts.push(chunk);
    this.bytes += chunk.length;
  }

  take(count: number): Buffer {
    const whole = this.#parts.length === 1 ? this.#parts[0]! : Buffer.concat(this.#parts, this.bytes);
    const taken = whole.subarray(0, count);
    const rest = whole.subarray(count);
    this.#parts = rest.length === 0 ? [] : [rest];
    this.bytes = rest.length;
    return taken;
  }
}

export class SealStream extends Transform {
  readonly #opened: Opened;
  readonly #header: Buffer;
  readonly #segment: number;
  readonly #file: string;
  readonly #held = new Held();
  #index = 0;
  #started = false;

  constructor(sealing: Sealing, file: string, header: Buffer = freshHeader()) {
    super();
    this.#file = file;
    this.#segment = sealing.segment;
    this.#header = header;
    this.#opened = headerOf(header, sealing, file);
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    try {
      this.#held.add(chunk);
      this.#start();
      while (this.#held.bytes > plainOf(this.#segment, this.#index)) this.#emit(false);
      done();
    } catch (error) {
      done(error as Error);
    }
  }

  override _flush(done: TransformCallback): void {
    try {
      this.#start();
      this.#emit(true);
      done();
    } catch (error) {
      done(error as Error);
    }
  }

  #start(): void {
    if (this.#started) return;
    this.#started = true;
    this.push(this.#header);
  }

  #emit(last: boolean): void {
    const plain = this.#held.take(last ? this.#held.bytes : plainOf(this.#segment, this.#index));
    this.push(sealSegment(this.#opened, this.#index, last, plain, this.#file));
    this.#index += 1;
  }
}

export class OpenStream extends Transform {
  readonly #sealing: Sealing;
  readonly #file: string;
  readonly #held = new Held();
  #opened: Opened | undefined;
  #index = 0;

  constructor(sealing: Sealing, file: string) {
    super();
    this.#sealing = sealing;
    this.#file = file;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    try {
      this.#held.add(chunk);
      this.#header();
      if (this.#opened !== undefined) {
        while (this.#held.bytes > diskOf(this.#sealing.segment, this.#index)) this.#emit(false);
      }
      done();
    } catch (error) {
      done(error as Error);
    }
  }

  override _flush(done: TransformCallback): void {
    try {
      this.#header();
      if (this.#opened === undefined) throw damaged(this.#file, "it is shorter than its header and one tag");
      if (this.#held.bytes < TAG_BYTES) throw damaged(this.#file, "it is cut short");
      if (this.#index > 0 && this.#held.bytes === TAG_BYTES) throw damaged(this.#file, "an empty segment follows a full one");
      this.#emit(true);
      done();
    } catch (error) {
      done(error as Error);
    }
  }

  #header(): void {
    if (this.#opened !== undefined || this.#held.bytes === 0) return;
    const first = this.#held.take(Math.min(this.#held.bytes, HEADER_BYTES));
    if (first[0] !== HEADER_BYTES) throw damaged(this.#file, `its header says ${first[0]} bytes, not ${HEADER_BYTES}`);
    if (first.length < HEADER_BYTES) {
      this.#held.add(Buffer.from(first));
      return;
    }
    this.#opened = headerOf(first, this.#sealing, this.#file);
  }

  #emit(last: boolean): void {
    const index = this.#index;
    const sealed = this.#held.take(last ? this.#held.bytes : diskOf(this.#sealing.segment, index));
    this.push(openSegment(this.#opened!, index, last, sealed, this.#file));
    this.#index += 1;
  }
}

export function sealWhole(plain: Buffer, sealing: Sealing, file: string, header: Buffer = freshHeader()): Buffer {
  const opened = headerOf(header, sealing, file);
  const parts = [header];
  let at = 0;
  let index = 0;
  for (;;) {
    const room = plainOf(sealing.segment, index);
    const last = plain.length - at <= room;
    const end = last ? plain.length : at + room;
    parts.push(sealSegment(opened, index, last, plain.subarray(at, end), file));
    if (last) return Buffer.concat(parts);
    at = end;
    index += 1;
  }
}

export function openWhole(sealed: Buffer, sealing: Sealing, file: string): Buffer {
  const layout = layoutOf(sealed.length, sealing.segment, file);
  const opened = headerOf(sealed.subarray(0, HEADER_BYTES), sealing, file);
  const parts: Buffer[] = [];
  for (let index = 0; index < layout.segments; index += 1) {
    const [from, to] = diskSpan(layout, index);
    parts.push(openSegment(opened, index, index === layout.segments - 1, sealed.subarray(from, to), file));
  }
  return Buffer.concat(parts);
}

export interface Layout {
  readonly size: number;
  readonly segment: number;
  readonly segments: number;
  readonly plainLength: number;
}

export function layoutOf(size: number, segment: number, file: string): Layout {
  if (size < HEADER_BYTES + TAG_BYTES) throw damaged(file, "it is shorter than its header and one tag");
  const segments = size <= segment ? 1 : 1 + Math.ceil((size - segment) / segment);
  const lastDisk = segments === 1 ? size - HEADER_BYTES : size - segment * (segments - 1);
  if (segments > 1 && lastDisk <= TAG_BYTES) throw damaged(file, "an empty segment follows a full one, or bytes follow its end");
  if (segments > MAX_SEGMENTS) throw new SealedError("SEALED_TOO_LARGE", file, `more than ${MAX_SEGMENTS} segments`);
  return { size, segment, segments, plainLength: size - HEADER_BYTES - segments * TAG_BYTES };
}

function diskSpan(layout: Layout, index: number): [number, number] {
  const from = index === 0 ? HEADER_BYTES : index * layout.segment;
  return [from, Math.min((index + 1) * layout.segment, layout.size)];
}

function plainStart(layout: Layout, index: number): number {
  return index === 0 ? 0 : firstPlain(layout.segment) + (index - 1) * (layout.segment - TAG_BYTES);
}

function segmentAt(layout: Layout, offset: number): number {
  const first = firstPlain(layout.segment);
  return offset < first ? 0 : 1 + Math.floor((offset - first) / (layout.segment - TAG_BYTES));
}

export class Positioned {
  readonly #cache = new Map<number, Buffer>();

  private constructor(
    readonly handle: FileHandle,
    readonly layout: Layout,
    readonly opened: Opened,
    readonly file: string,
  ) {}

  static async open(path: string, sealing: Sealing, file: string): Promise<Positioned> {
    const handle = await open(path, "r");
    try {
      const { size } = await handle.stat();
      const layout = layoutOf(size, sealing.segment, file);
      const header = Buffer.alloc(HEADER_BYTES);
      await readExactly(handle, header, 0, file);
      return new Positioned(handle, layout, headerOf(header, sealing, file), file);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async segment(index: number): Promise<Buffer> {
    const kept = this.#cache.get(index);
    if (kept !== undefined) return kept;
    const [from, to] = diskSpan(this.layout, index);
    const sealed = Buffer.alloc(to - from);
    await readExactly(this.handle, sealed, from, this.file);
    const plain = openSegment(this.opened, index, index === this.layout.segments - 1, sealed, this.file);
    if (index >= this.layout.segments - 2) this.#cache.set(index, plain);
    return plain;
  }

  async *range(start: number, end: number): AsyncGenerator<Buffer> {
    await this.segment(this.layout.segments - 1);
    if (end <= start) return;
    for (let index = segmentAt(this.layout, start); index < this.layout.segments; index += 1) {
      const at = plainStart(this.layout, index);
      if (at >= end) return;
      const plain = await this.segment(index);
      yield plain.subarray(Math.max(start - at, 0), Math.min(end - at, plain.length));
    }
  }
}

export class SealedReader {
  readonly #kept = new Map<number, Buffer>();

  private constructor(
    private readonly fd: number,
    readonly layout: Layout,
    private readonly opened: Opened,
    readonly file: string,
    readonly mtimeMs: number,
  ) {}

  static open(path: string, sealing: Sealing): SealedReader {
    const fd = openSync(path, "r");
    try {
      const file = basename(path);
      const stat = fstatSync(fd);
      const layout = layoutOf(stat.size, sealing.segment, file);
      const header = Buffer.alloc(HEADER_BYTES);
      readExactlySync(fd, header, 0, file);
      return new SealedReader(fd, layout, headerOf(header, sealing, file), file, stat.mtimeMs);
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  get size(): number {
    return this.layout.size;
  }

  get plainLength(): number {
    return this.layout.plainLength;
  }

  segment(index: number): Buffer {
    const kept = this.#kept.get(index);
    if (kept !== undefined) return kept;
    const plain = this.#decrypt(index);
    this.#kept.set(index, plain);
    return plain;
  }

  head(count: number): Buffer {
    const parts: Buffer[] = [];
    let held = 0;
    for (let index = 0; held < count && index < this.layout.segments; index += 1) {
      const plain = this.segment(index);
      parts.push(plain);
      held += plain.length;
    }
    return Buffer.concat(parts).subarray(0, count);
  }

  tail(count: number): Buffer {
    const last = this.layout.segments - 1;
    const parts = [this.segment(last)];
    let held = parts[0]!.length;
    for (let index = last - 1; held < count && index >= 0; index -= 1) {
      const plain = this.segment(index);
      parts.unshift(plain);
      held += plain.length;
    }
    const whole = Buffer.concat(parts);
    return whole.subarray(Math.max(0, whole.length - count));
  }

  *range(start: number, end: number, length = this.layout.plainLength): Generator<Buffer> {
    checkRange({ start, end }, length, this.file);
    if (end === start) return;
    for (let index = segmentAt(this.layout, start); index < this.layout.segments; index += 1) {
      const at = plainStart(this.layout, index);
      if (at >= end) return;
      const plain = this.#kept.get(index) ?? this.#decrypt(index);
      yield plain.subarray(Math.max(start - at, 0), Math.min(end - at, plain.length));
    }
  }

  close(): void {
    closeSync(this.fd);
  }

  #decrypt(index: number): Buffer {
    const [from, to] = diskSpan(this.layout, index);
    const sealed = Buffer.alloc(to - from);
    readExactlySync(this.fd, sealed, from, this.file);
    return openSegment(this.opened, index, index === this.layout.segments - 1, sealed, this.file);
  }
}

function readExactlySync(fd: number, into: Buffer, position: number, file: string): void {
  for (let read = 0; read < into.length; ) {
    const bytes = readSync(fd, into, read, into.length - read, position + read);
    if (bytes === 0) throw damaged(file, "it was cut short while read");
    read += bytes;
  }
}

async function readExactly(handle: FileHandle, into: Buffer, position: number, file: string): Promise<void> {
  let read = 0;
  while (read < into.length) {
    const { bytesRead } = await handle.read(into, read, into.length - read, position + read);
    if (bytesRead === 0) throw damaged(file, "it was cut short while read");
    read += bytesRead;
  }
}

function checkRange(range: { start: number; end: number }, length: number, file: string): void {
  if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end > length || range.end < range.start) {
    throw new SealedError("SEALED_BAD_RANGE", file, `the range ${range.start}..${range.end} is not within its ${length} bytes`);
  }
}

export function openFile(path: string, sealing: Sealing): Readable {
  return pipeline(createReadStream(path, { highWaterMark: sealing.segment }), new OpenStream(sealing, basename(path)), () => undefined);
}

export function openBlob(path: string, sealing: Sealing): WithoutIdentity {
  return pipeline(openFile(path, sealing), new WithoutIdentity(basename(path)), () => undefined);
}

export function readSealedSync(path: string, sealing: Sealing): Buffer {
  return openWhole(readFileSync(path), sealing, basename(path));
}

function identityText(bytes: Buffer): string {
  return `sha256:${bytes.toString("hex")}`;
}

export function identityOf(raw: Buffer): Buffer {
  return createHash("sha256").update(raw).digest();
}

export class WithoutIdentity extends Transform {
  readonly #held = new Held();
  identity: string | undefined;

  constructor(readonly file: string) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.#held.add(chunk);
    if (this.#held.bytes > IDENTITY_BYTES) this.push(this.#held.take(this.#held.bytes - IDENTITY_BYTES));
    done();
  }

  override _flush(done: TransformCallback): void {
    if (this.#held.bytes !== IDENTITY_BYTES) {
      done(damaged(this.file, "it holds fewer plain bytes than its identity"));
      return;
    }
    this.identity = identityText(this.#held.take(IDENTITY_BYTES));
    done();
  }
}

const TEMPORARY = /^\.tmp-(\d+)-[0-9a-f]{24}$/u;

export function isTemporary(name: string): boolean {
  return TEMPORARY.test(name);
}

export function temporaryIn(folder: string): string {
  return join(folder, `.tmp-${process.pid}-${randomBytes(12).toString("hex")}`);
}

export function sweepTemporaries(folder: string): void {
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    const pid = TEMPORARY.exec(name)?.[1];
    if (pid === undefined || isAlive(Number(pid))) continue;
    rmSync(join(folder, name), { recursive: true, force: true });
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function besideOf(path: string): string {
  return temporaryIn(dirname(path));
}

function syncDirectory(path: string): void {
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export function writeSealedSync(path: string, plain: Buffer, sealing: Sealing): void {
  const sealed = sealWhole(plain, sealing, basename(path));
  const beside = besideOf(path);
  try {
    const file = openSync(beside, "wx", 0o600);
    try {
      let at = 0;
      while (at < sealed.length) at += writeSync(file, sealed, at, sealed.length - at);
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(beside, path);
  } finally {
    rmSync(beside, { force: true });
  }
  syncDirectory(path);
}

export async function writeSealed(path: string, plain: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, sealing: Sealing): Promise<number> {
  const beside = besideOf(path);
  let written = 0;
  try {
    const handle = await open(beside, "wx", 0o600);
    try {
      await pipelined(Readable.from(plain, { objectMode: false }), new SealStream(sealing, basename(path)), async (sealed: AsyncIterable<Buffer>) => {
        for await (const chunk of sealed) {
          for (let at = 0; at < chunk.length;) {
            const { bytesWritten } = await handle.write(chunk, at, chunk.length - at);
            if (bytesWritten === 0) throw new Error(`${basename(path)}: the disk took none of a write`);
            at += bytesWritten;
          }
          written += chunk.length;
        }
      });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(beside, path);
  } finally {
    await rm(beside, { force: true });
  }
  syncDirectory(path);
  return written;
}
