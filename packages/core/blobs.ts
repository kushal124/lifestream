import { createHash, createHmac } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  createReadStream,
  createWriteStream,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeSync,
  type Stats,
} from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pipeline as joined, Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants as zlib, createZstdCompress, createZstdDecompress, zstdCompressSync, zstdDecompressSync, type ZstdOptions } from "node:zlib";
import { fits, freeOf, makeUnder, RECHECK_BYTES } from "./disk.js";
import {
  blobSealing,
  blobTree,
  IDENTITY_BYTES,
  openBlob,
  readSealedSync,
  SealedError,
  SealedReader,
  SealStream,
  sealWhole,
  sweepTemporaries,
  temporaryIn,
  type Sealing,
  type WithoutIdentity,
} from "./sealed.js";
import type { KeptFile } from "./home-folder.js";
import type { BlobReader } from "./types.js";

export interface PutOptions {
  mediaType?: string;
  expect?: string;
}

export interface BlobStore extends BlobReader {
  readonly root: string;
  readonly listing: string;
  put(bytes: Buffer, options?: PutOptions): string;
  putFile(path: string, options?: PutOptions): Promise<string>;
  putKept(file: KeptFile, options?: PutOptions): Promise<string>;
  putChunks(chunks: () => AsyncIterable<Uint8Array>, size: number, options?: PutOptions): Promise<string>;
  stream(hash: string, range?: { start: number; end: number }): Readable;
  size(hash: string): number | undefined;
  stored(hash: string): number | undefined;
  leaf(prefix: string): LeafFile[];
  leaves(referenced: () => Iterable<string>): (prefix: string) => LeafFile[];
  remove(hash: string): boolean;
  directory(hash: string): string;
}

export interface LeafFile {
  blob: string;
  bytes: number;
  mtime_ms: number;
  name?: string;
}

export type BlobErrorCode =
  | "BAD_BLOB_HASH"
  | "BLOB_NOT_FOUND"
  | "BLOB_CORRUPT"
  | "BLOB_FORM"
  | "BLOB_HASH_MISMATCH"
  | "BLOB_NO_SPACE"
  | "BLOB_NOT_STORED"
  | "BLOB_NOT_TEXT";

export class BlobError extends Error {
  static override [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof Error && value.name === "BlobError";
  }

  constructor(
    readonly code: BlobErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BlobError";
  }
}

export function homeBlobFault(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "BLOB_NOT_FOUND" || code === "BLOB_HASH_MISMATCH" || code === "BLOB_CORRUPT" || code === "BLOB_NO_SPACE" || code === "BLOB_NOT_STORED";
}

export function diskFailed(error: unknown): boolean {
  return codeOf(error, (code) => /^(?:SQLITE_IOERR|SQLITE_CANTOPEN|EIO$|ENXIO$|EBADF$)/u.test(code));
}

export function hostFault(error: unknown): boolean {
  return diskFailed(error) || codeOf(error, (code) => /^(?:EMFILE|ENFILE|ENOMEM|EACCES|EPERM|ETIMEDOUT|SQLITE_NOMEM)$/u.test(code));
}

function codeOf(error: unknown, matches: (code: string) => boolean): boolean {
  const { code, cause } = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; cause?: unknown };
  if (typeof code === "string" && matches(code)) return true;
  return cause !== undefined && cause !== error && codeOf(cause, matches);
}

export function outOfRoom(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "BLOB_NO_SPACE" || code === "ENOSPC" || code === "EDQUOT";
}

export type BlobForm =
  | { keyed: false; bare: (file: KeptFile) => string }
  | { keyed: true; files: Buffer; names: Buffer; scratch: string; sealed: (file: KeptFile) => string };

export function blobsIn(root: string, form: BlobForm, reading: boolean, ephemeral = false): BlobStore {
  const tree = blobTree(root, KEYED_BLOBS_KEY_ID);
  if (!reading) {
    makeUnder(dirname(root), root);
    sweepTemporaries(root);
  }
  if (!form.keyed) {
    if (statSync(tree, { throwIfNoEntry: false }) !== undefined) throw new BlobError("BLOB_FORM", `${root} holds a keyed blob tree in a plain home`);
    return new Store(root, form.bare, ephemeral);
  }
  if (!reading) makeUnder(root, tree);
  if (namesIn(root).some((name) => SHARD.test(name))) throw new BlobError("BLOB_FORM", `${root} holds both a keyed blob tree and a plain one`);
  return new KeyedStore(root, { sealing: blobSealing(form.files), names: form.names }, form.scratch, form.sealed);
}

function namesIn(root: string): string[] {
  try {
    return readdirSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export const KEYED_BLOBS_KEY_ID = 1;

const MiB = 1024 * 1024;
const CHUNK = MiB;
const PREFIX_STEP = 4096;
const LEVEL = 3;
const TRAILER_MAGIC = 0x184d2a5c;
const TRAILER_BYTES = 40;
const ZSTD_MAGIC = 0xfd2fb528;
export const BLOB_HASH = /^sha256:([0-9a-f]{64})$/;
const SHARD = /^[0-9a-f]{2}$/;
export const SHA256_HEX = /^[0-9a-f]{64}$/;
const LEAF = /^[0-9a-f]{4}$/;

const COMPRESSED: ReadonlySet<string> = new Set([
  "message/rfc822",
  "application/json",
  "application/x-ndjson",
  "application/vnd.sqlite3",
  "application/vnd.sqlite3.wal",
  "application/vnd.apple.segb",
]);

function isCompressedMediaType(mediaType: string | undefined): boolean {
  if (mediaType === undefined) return false;
  const essence = mediaType.split(";")[0]!.trim().toLowerCase();
  return essence.startsWith("text/") || COMPRESSED.has(essence);
}

interface Located {
  file: number;
  stored: number;
  frame: number | null;
}

abstract class Tree {
  constructor(readonly root: string) {}

  protected abstract path(hash: string): string;

  abstract bytes(hash: string): Buffer;

  has(hash: string): boolean {
    const path = this.path(hash);
    try {
      accessSync(path);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw new BlobError("BLOB_NOT_STORED", `whether blob ${hash} is stored cannot be read: ${(error as Error).message}`, { cause: error });
    }
  }

  stored(hash: string): number | undefined {
    const path = this.path(hash);
    try {
      return statSync(path).size;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw new BlobError("BLOB_NOT_STORED", `whether blob ${hash} is stored cannot be read: ${(error as Error).message}`, { cause: error });
    }
  }

  text(hash: string): string {
    const bytes = this.bytes(hash);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new BlobError("BLOB_NOT_TEXT", `blob ${hash} is not UTF-8 text`);
    }
  }

  remove(hash: string): boolean {
    const path = this.path(hash);
    try {
      rmSync(path);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  directory(hash: string): string {
    return dirname(this.path(hash));
  }
}

class Store extends Tree implements BlobStore {
  readonly listing = "sha256:";

  constructor(
    root: string,
    private readonly bare: (file: KeptFile) => string,
    private readonly ephemeral = false,
  ) {
    super(root);
  }

  put(bytes: Buffer, options: PutOptions = {}): string {
    const hash = sha256(bytes);
    expectHash(hash, options.expect);
    if (this.has(hash)) return hash;
    let body = bytes;
    if (isCompressedMediaType(options.mediaType)) {
      const frame = zstdCompressSync(bytes, { params: { [zlib.ZSTD_c_compressionLevel]: LEVEL } });
      if (!zstdDecompressSync(frame).equals(bytes)) throw new BlobError("BLOB_CORRUPT", `blob ${hash} did not survive compression`);
      body = Buffer.concat([frame, trailer(hash)]);
    }
    if (!fits(freeOf(this.root), "new", body.length)) throw noSpace(`blob ${hash}`, body.length);
    const temporary = this.#temporary();
    try {
      const file = openSync(temporary, "wx", 0o600);
      try {
        writeAll(file, body);
        if (!this.ephemeral) fsyncSync(file);
      } finally {
        closeSync(file);
      }
      this.#install(temporary, hash);
    } catch (error) {
      throw unwritten(error, `blob ${hash}`);
    } finally {
      rmSync(temporary, { force: true });
    }
    return hash;
  }

  async putKept(file: KeptFile, options: PutOptions = {}): Promise<string> {
    return this.putFile(this.bare(file), options);
  }

  async putFile(path: string, options: PutOptions = {}): Promise<string> {
    if (options.expect !== undefined && this.has(options.expect)) return options.expect;
    const compress = isCompressedMediaType(options.mediaType);
    const temporary = this.#temporary();
    try {
      const size = compress ? statSync(path).size : 0;
      if (compress && size <= CHUNK) {
        const bytes = readFileSync(path);
        if (bytes.length !== size) throw changedSize(path);
        return this.put(bytes, options);
      }
      const hash = compress ? await compressInto(path, size, temporary, this.#spaceGuard(`the blob of ${path}`), !this.ephemeral) : await linkInto(path, temporary, !this.ephemeral);
      expectHash(hash, options.expect);
      if (compress) await drain(readable(locate(temporary, hash), hash));
      this.#install(temporary, hash);
      return hash;
    } catch (error) {
      throw unwritten(error, options.expect === undefined ? `the blob of ${path}` : `blob ${options.expect}`);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  async putChunks(chunks: () => AsyncIterable<Uint8Array>, size: number, options: PutOptions = {}): Promise<string> {
    if (!Number.isSafeInteger(size) || size < 0) throw new RangeError(`a streamed blob's size is a whole number of bytes, not ${size}`);
    if (options.expect !== undefined && this.has(options.expect)) return options.expect;
    const compress = isCompressedMediaType(options.mediaType);
    const temporary = this.#temporary();
    try {
      const hash = await writeInto(chunks(), size, temporary, compress, this.#spaceGuard("a streamed blob"), !this.ephemeral);
      expectHash(hash, options.expect);
      if (compress) await drain(readable(locate(temporary, hash), hash));
      this.#install(temporary, hash);
      return hash;
    } catch (error) {
      throw unwritten(error, options.expect === undefined ? "a streamed blob" : `blob ${options.expect}`);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  bytes(hash: string): Buffer {
    const blob = this.#open(hash);
    try {
      const stored = readExactly(blob.file, blob.frame ?? blob.stored, hash);
      const raw = blob.frame === null ? stored : inflateOrCorrupt(stored, hash);
      const actual = sha256(raw);
      if (actual !== hash) throw corrupt(hash, actual);
      return raw;
    } finally {
      closeSync(blob.file);
    }
  }

  prefix(hash: string, bytes: number): Buffer {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError(`a prefix is a whole number of bytes, not ${bytes}`);
    const blob = this.#open(hash);
    try {
      if (blob.frame === null) return readExactly(blob.file, Math.min(bytes, blob.stored), hash);
      for (let read = Math.min(PREFIX_STEP, blob.frame); ; read = Math.min(2 * read, blob.frame)) {
        const raw = inflateOrCorrupt(readExactly(blob.file, read, hash), hash);
        if (raw.length >= bytes || read === blob.frame) return raw.subarray(0, bytes);
      }
    } finally {
      closeSync(blob.file);
    }
  }

  stream(hash: string, range?: { start: number; end: number }): Readable {
    const blob = this.#open(hash);
    return range === undefined ? readable(blob, hash) : part(blob, hash, range);
  }

  size(hash: string): number | undefined {
    const blob = this.#open(hash);
    try {
      return blob.frame === null ? blob.stored : frameContentSize(readExactly(blob.file, Math.min(18, blob.frame), hash));
    } finally {
      closeSync(blob.file);
    }
  }

  leaf(prefix: string): LeafFile[] {
    const files: LeafFile[] = [];
    for (const { name, path } of leafNames(this.root, prefix)) {
      const stat = statOf(path);
      if (stat !== undefined) files.push({ blob: `sha256:${name}`, bytes: stat.size, mtime_ms: Math.floor(stat.mtimeMs) });
    }
    return files;
  }

  leaves(): (prefix: string) => LeafFile[] {
    return (prefix) => this.leaf(prefix);
  }

  async materialise(hash: string): Promise<{ path: string; dispose(): void }> {
    const blob = this.#open(hash);
    let stated = 0;
    try {
      if (blob.frame !== null) stated = frameContentSize(readExactly(blob.file, Math.min(18, blob.frame), hash)) ?? 0;
    } finally {
      closeSync(blob.file);
    }
    const directory = this.#temporary();
    const path = join(directory, hexOf(hash));
    const dispose = (): void => rmSync(directory, { recursive: true, force: true });
    try {
      mkdirSync(directory, { mode: 0o700 });
      if (blob.frame === null) {
        linkSync(this.path(hash), path);
      } else {
        if (!fits(freeOf(this.root), "new", stated)) throw noSpace(`blob ${hash}`, stated);
        await pipeline(this.stream(hash), this.#spaceGuard(`blob ${hash}`), createWriteStream(path, { flags: "wx", mode: 0o600 }));
      }
    } catch (error) {
      dispose();
      throw unwritten(error, `blob ${hash}`);
    }
    return { path, dispose };
  }

  #spaceGuard(what: string): Transform {
    return spaceGuard(this.root, what);
  }

  #open(hash: string): Located {
    return locate(this.path(hash), hash);
  }

  #install(temporary: string, hash: string): void {
    install(this.root, temporary, this.path(hash), !this.ephemeral);
  }

  #temporary(): string {
    return temporaryIn(this.root);
  }

  protected path(hash: string): string {
    const hex = hexOf(hash);
    return join(this.root, hex.slice(0, 2), hex.slice(2, 4), hex);
  }
}

interface KeyedLocated {
  stored: number;
  frame: number | null;
  stated: number | undefined;
}

class KeyedStore extends Tree implements BlobStore {
  readonly listing = `k${KEYED_BLOBS_KEY_ID}:`;
  readonly #tree: string;
  readonly #keys: { sealing: Sealing; names: Buffer };

  constructor(
    root: string,
    keys: { sealing: Sealing; names: Buffer },
    private readonly scratch: string,
    private readonly sealed: (file: KeptFile) => string,
  ) {
    super(root);
    this.#tree = blobTree(root, KEYED_BLOBS_KEY_ID);
    this.#keys = keys;
  }

  get #sealing(): Sealing {
    return this.#keys.sealing;
  }

  put(bytes: Buffer, options: PutOptions = {}): string {
    const hash = sha256(bytes);
    expectHash(hash, options.expect);
    if (this.has(hash)) return hash;
    let body = bytes;
    if (isCompressedMediaType(options.mediaType)) {
      const frame = zstdCompressSync(bytes, { params: { [zlib.ZSTD_c_compressionLevel]: LEVEL } });
      if (!zstdDecompressSync(frame).equals(bytes)) throw new BlobError("BLOB_CORRUPT", `blob ${hash} did not survive compression`);
      body = Buffer.concat([frame, trailer(hash)]);
    }
    const temporary = temporaryIn(this.root);
    try {
      const sealed = sealWhole(Buffer.concat([body, identityBytes(hash)]), this.#sealing, basename(temporary));
      if (!fits(freeOf(this.root), "new", sealed.length)) throw noSpace(`blob ${hash}`, sealed.length);
      const file = openSync(temporary, "wx", 0o600);
      try {
        writeAll(file, sealed);
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      install(this.root, temporary, this.path(hash));
    } catch (error) {
      throw unwritten(error, `blob ${hash}`);
    } finally {
      rmSync(temporary, { force: true });
    }
    return hash;
  }

  putFile(path: string, options: PutOptions = {}): Promise<string> {
    return this.#putting(`the blob of ${path}`, options, (temporary, compress, what) =>
      this.#sealInto(() => createReadStream(path, { highWaterMark: CHUNK }), statSync(path).size, temporary, compress, () => changedSize(path), what));
  }

  putKept(file: KeptFile, options: PutOptions = {}): Promise<string> {
    return this.#putting(`the blob of ${file.path}`, options, (temporary, compress, what) => {
      const sealed = this.sealed(file);
      return compress ? this.#resealInto(sealed, temporary, what) : this.#linkInto(sealed, temporary);
    });
  }

  async #putting(of: string, options: PutOptions, into: (temporary: string, compress: boolean, what: string) => Promise<string>): Promise<string> {
    if (options.expect !== undefined && this.has(options.expect)) return options.expect;
    const compress = isCompressedMediaType(options.mediaType);
    const temporary = temporaryIn(this.root);
    const what = options.expect === undefined ? of : `blob ${options.expect}`;
    try {
      const hash = await into(temporary, compress, what);
      expectHash(hash, options.expect);
      if (compress) await drain(this.#readable(temporary, hash));
      install(this.root, temporary, this.path(hash));
      return hash;
    } catch (error) {
      throw unwritten(error, what);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  async putChunks(chunks: () => AsyncIterable<Uint8Array>, size: number, options: PutOptions = {}): Promise<string> {
    if (!Number.isSafeInteger(size) || size < 0) throw new RangeError(`a streamed blob's size is a whole number of bytes, not ${size}`);
    if (options.expect !== undefined && this.has(options.expect)) return options.expect;
    const compress = isCompressedMediaType(options.mediaType);
    const temporary = temporaryIn(this.root);
    const what = options.expect === undefined ? "a streamed blob" : `blob ${options.expect}`;
    try {
      const hash = await this.#sealInto(() => Readable.from(chunks()), size, temporary, compress, (held) => wrongSize(size, held), "a streamed blob");
      expectHash(hash, options.expect);
      if (compress) await drain(this.#readable(temporary, hash));
      install(this.root, temporary, this.path(hash));
      return hash;
    } catch (error) {
      throw unwritten(error, what);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  bytes(hash: string): Buffer {
    const path = this.path(hash);
    let plain: Buffer;
    try {
      plain = readSealedSync(path, this.#sealing);
    } catch (error) {
      if (isMissing(error)) throw notFound(hash);
      throw sealedFault(error, hash);
    }
    if (plain.length < IDENTITY_BYTES) throw new BlobError("BLOB_CORRUPT", `blob ${hash} holds fewer plain bytes than its identity`);
    const stored = plain.subarray(0, plain.length - IDENTITY_BYTES);
    const compressed = stored.length > TRAILER_BYTES && stored.subarray(stored.length - TRAILER_BYTES).equals(trailer(hash));
    const raw = compressed ? inflateOrCorrupt(stored.subarray(0, stored.length - TRAILER_BYTES), hash) : stored;
    const actual = sha256(raw);
    if (actual !== hash) throw corrupt(hash, actual);
    return raw;
  }

  prefix(hash: string, bytes: number): Buffer {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError(`a prefix is a whole number of bytes, not ${bytes}`);
    return this.#reading(hash, (reader, blob) => {
      if (blob.frame === null) return reader.head(Math.min(bytes, blob.stored));
      for (let read = Math.min(PREFIX_STEP, blob.frame); ; read = Math.min(2 * read, blob.frame)) {
        const raw = inflateOrCorrupt(reader.head(read), hash);
        if (raw.length >= bytes || read === blob.frame) return raw.subarray(0, bytes);
      }
    });
  }

  stream(hash: string, range?: { start: number; end: number }): Readable {
    const path = this.path(hash);
    const reader = this.#open(hash);
    let blob: KeyedLocated;
    try {
      blob = locatedOf(reader, hash);
    } catch (error) {
      reader.close();
      throw sealedFault(error, hash);
    }
    if (range === undefined || blob.frame !== null) reader.close();
    if (range === undefined) return this.#readable(path, hash, blob);
    const end = Math.min(range.end, blob.frame === null ? blob.stored : Number.MAX_SAFE_INTEGER);
    const start = Math.min(range.start, end);
    if (blob.frame === null) return ranged(reader, hash, { start, end }, blob.stored);
    return inflatedPart(this.#plain(path, blob), hash, { start, end });
  }

  size(hash: string): number | undefined {
    return this.#reading(hash, (_reader, blob) => (blob.frame === null ? blob.stored : blob.stated));
  }

  leaf(prefix: string): LeafFile[] {
    const sealing = this.#sealing;
    const files: LeafFile[] = [];
    for (const { name, path } of leafNames(this.#tree, prefix)) {
      const file = this.#listed(path, name, sealing);
      if (file !== undefined) files.push(file);
    }
    return files;
  }

  leaves(referenced: () => Iterable<string>): (prefix: string) => LeafFile[] {
    const blobOf = namedBlobs(this.#keys.names, referenced());
    return (prefix) => {
      const files: LeafFile[] = [];
      for (const { name, path } of leafNames(this.#tree, prefix)) {
        const blob = blobOf(name);
        if (blob === undefined) continue;
        const stat = statOf(path);
        if (stat !== undefined) files.push({ blob, bytes: stat.size, mtime_ms: Math.floor(stat.mtimeMs), name: `${this.listing}${name}` });
      }
      return files;
    };
  }

  #listed(path: string, name: string, sealing: Sealing): LeafFile | undefined {
    let reader: SealedReader;
    try {
      reader = SealedReader.open(path, sealing);
    } catch (error) {
      if (isMissing(error) || isDamage(error)) return undefined;
      throw sealedFault(error, `named ${name}`);
    }
    try {
      if (reader.plainLength < IDENTITY_BYTES) return undefined;
      const blob = `sha256:${reader.tail(IDENTITY_BYTES).toString("hex")}`;
      if (keyedBlobName(this.#keys.names, blob) !== name) return undefined;
      return { blob, bytes: reader.size, mtime_ms: Math.floor(reader.mtimeMs), name: `${this.listing}${name}` };
    } catch (error) {
      if (isDamage(error)) return undefined;
      throw sealedFault(error, `named ${name}`);
    } finally {
      reader.close();
    }
  }

  async materialise(hash: string): Promise<{ path: string; dispose(): void }> {
    const stated = this.size(hash) ?? 0;
    mkdirSync(this.scratch, { recursive: true, mode: 0o700 });
    const directory = mkdtempSync(join(this.scratch, "blob-"));
    const path = join(directory, hexOf(hash));
    const dispose = (): void => rmSync(directory, { recursive: true, force: true });
    try {
      if (!fits(freeOf(this.scratch), "new", stated)) throw noSpace(`blob ${hash}`, stated);
      await pipeline(this.stream(hash), spaceGuard(this.scratch, `blob ${hash}`), createWriteStream(path, { flags: "wx", mode: 0o600 }));
    } catch (error) {
      dispose();
      throw unwritten(error, `blob ${hash}`);
    }
    return { path, dispose };
  }

  async #linkInto(src: string, dst: string): Promise<string> {
    linkSync(src, dst);
    const raw = openBlob(dst, this.#sealing);
    const digest = createHash("sha256");
    try {
      for await (const chunk of raw) digest.update(chunk as Buffer);
    } catch (error) {
      throw sealedFault(error, `of ${src}`);
    }
    const hash = `sha256:${digest.digest("hex")}`;
    if (raw.identity !== hash) throw new BlobError("BLOB_CORRUPT", `${src} says it holds blob ${raw.identity ?? "unknown"}, its bytes hash to ${hash}`);
    const file = openSync(dst, "r");
    try {
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    return hash;
  }

  async #resealInto(src: string, dst: string, what: string): Promise<string> {
    let raw: WithoutIdentity | undefined;
    const hash = await this.#sealInto(() => (raw = openBlob(src, this.#sealing)), this.#heldBytes(src), dst, true, () => changedSize(src), what);
    if (raw?.identity !== hash) throw new BlobError("BLOB_CORRUPT", `${src} says it holds blob ${raw?.identity ?? "unknown"}, its bytes hash to ${hash}`);
    return hash;
  }

  #heldBytes(src: string): number {
    let reader: SealedReader;
    try {
      reader = SealedReader.open(src, this.#sealing);
    } catch (error) {
      throw sealedFault(error, `of ${src}`);
    }
    try {
      if (reader.plainLength < IDENTITY_BYTES) throw new BlobError("BLOB_CORRUPT", `${src} holds fewer plain bytes than its identity`);
      return reader.plainLength - IDENTITY_BYTES;
    } finally {
      reader.close();
    }
  }

  async #sealInto(open: () => Readable, size: number, dst: string, compress: boolean, wrong: (held: string) => BlobError, what: string): Promise<string> {
    const digest = createHash("sha256");
    let read = 0;
    let hash = "";
    const tap = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        read += chunk.length;
        if (read > size) return callback(wrong("more"));
        digest.update(chunk);
        callback(null, chunk);
      },
      flush(callback) {
        if (read !== size) return callback(wrong(`only ${read}`));
        hash = `sha256:${digest.digest("hex")}`;
        callback();
      },
    });
    const ending = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        callback(null, chunk);
      },
      flush(callback) {
        callback(null, Buffer.concat([compress ? trailer(hash) : Buffer.alloc(0), identityBytes(hash)]));
      },
    });
    const options = { params: { [zlib.ZSTD_c_compressionLevel]: LEVEL }, pledgedSrcSize: size } as ZstdOptions;
    const sealing = new SealStream(this.#sealing, basename(dst));
    const guard = spaceGuard(this.root, what);
    const written = createWriteStream(dst, { flags: "wx", mode: 0o600 });
    const source = open();
    try {
      if (compress) await pipeline(source, tap, createZstdCompress(options), ending, sealing, guard, written);
      else await pipeline(source, tap, ending, sealing, guard, written);
    } catch (error) {
      throw sealedFault(error, what);
    }
    const file = openSync(dst, "r");
    try {
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    return hash;
  }

  #reading<T>(hash: string, read: (reader: SealedReader, located: KeyedLocated) => T): T {
    const reader = this.#open(hash);
    try {
      return read(reader, locatedOf(reader, hash));
    } catch (error) {
      throw sealedFault(error, hash);
    } finally {
      reader.close();
    }
  }

  #open(hash: string): SealedReader {
    const path = this.path(hash);
    try {
      return SealedReader.open(path, this.#sealing);
    } catch (error) {
      if (isMissing(error)) throw notFound(hash);
      throw sealedFault(error, hash);
    }
  }

  #plain(path: string, blob: KeyedLocated): Readable {
    const raw = openBlob(path, this.#sealing);
    return blob.frame === null ? raw : joined(raw, firstBytes(blob.frame), () => undefined);
  }

  #readable(path: string, hash: string, known?: KeyedLocated): Readable {
    let blob = known;
    if (blob === undefined) {
      let reader: SealedReader;
      try {
        reader = SealedReader.open(path, this.#sealing);
      } catch (error) {
        throw sealedFault(error, hash);
      }
      try {
        blob = locatedOf(reader, hash);
      } catch (error) {
        throw sealedFault(error, hash);
      } finally {
        reader.close();
      }
    }
    const source = this.#plain(path, blob);
    const inflate = blob.frame === null ? null : createZstdDecompress();
    const verifier = verifierOf(hash, blob.frame === null ? undefined : blob.stated);
    source.on("error", (error) => verifier.destroy(sealedFault(error, hash) as Error));
    inflate?.on("error", (error) => verifier.destroy(new BlobError("BLOB_CORRUPT", `blob ${hash} does not inflate: ${error.message}`)));
    verifier.on("close", () => {
      source.destroy();
      inflate?.destroy();
    });
    (inflate === null ? source : source.pipe(inflate)).pipe(verifier);
    return verifier;
  }

  protected path(hash: string): string {
    const name = keyedBlobName(this.#keys.names, hash);
    return join(this.#tree, name.slice(0, 2), name.slice(2, 4), name);
  }
}

export function keyedBlobName(names: Buffer, hash: string): string {
  return createHmac("sha256", names).update(identityBytes(hash)).digest("hex");
}

const NAMED_RECORD = 2 * IDENTITY_BYTES;
const NAME_LEAVES = 0x10000;

function namedBlobs(names: Buffer, blobs: Iterable<string>): (name: string) => string | undefined {
  let held = Buffer.alloc(NAMED_RECORD * 1024);
  let count = 0;
  const starts = new Uint32Array(NAME_LEAVES + 1);
  for (const blob of blobs) {
    if (held.length < (count + 1) * NAMED_RECORD) {
      const grown = Buffer.alloc(held.length * 2);
      held.copy(grown);
      held = grown;
    }
    const at = count * NAMED_RECORD;
    const identity = identityBytes(blob);
    createHmac("sha256", names).update(identity).digest().copy(held, at);
    identity.copy(held, at + IDENTITY_BYTES);
    starts[held.readUInt16BE(at) + 1]!++;
    count++;
  }
  for (let leaf = 1; leaf <= NAME_LEAVES; leaf++) starts[leaf]! += starts[leaf - 1]!;
  const sorted = Buffer.alloc(count * NAMED_RECORD);
  const next = starts.slice(0, NAME_LEAVES);
  for (let record = 0; record < count; record++) {
    const at = record * NAMED_RECORD;
    held.copy(sorted, next[held.readUInt16BE(at)]!++ * NAMED_RECORD, at, at + NAMED_RECORD);
  }
  return (name) => {
    const key = Buffer.from(name, "hex");
    const leaf = key.readUInt16BE(0);
    for (let record = starts[leaf]!; record < starts[leaf + 1]!; record++) {
      const at = record * NAMED_RECORD;
      if (key.compare(sorted, at, at + IDENTITY_BYTES) === 0) return `sha256:${sorted.toString("hex", at + IDENTITY_BYTES, at + NAMED_RECORD)}`;
    }
    return undefined;
  };
}

function leafNames(tree: string, prefix: string): { name: string; path: string }[] {
  if (!LEAF.test(prefix)) throw new RangeError(`a leaf is named by four lowercase hex digits, not ${JSON.stringify(prefix)}`);
  const directory = join(tree, prefix.slice(0, 2), prefix.slice(2, 4));
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  return names.filter((each) => SHA256_HEX.test(each) && each.startsWith(prefix)).sort().map((name) => ({ name, path: join(directory, name) }));
}

function statOf(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function identityBytes(hash: string): Buffer {
  return Buffer.from(hexOf(hash), "hex");
}

function locatedOf(reader: SealedReader, hash: string): KeyedLocated {
  const plain = reader.plainLength;
  const tail = reader.tail(Math.min(plain, TRAILER_BYTES + IDENTITY_BYTES));
  if (tail.length < IDENTITY_BYTES) throw new BlobError("BLOB_CORRUPT", `blob ${hash} holds fewer plain bytes than its identity`);
  const held = `sha256:${tail.subarray(tail.length - IDENTITY_BYTES).toString("hex")}`;
  if (held !== hash) throw new BlobError("BLOB_CORRUPT", `the file named for blob ${hash} holds blob ${held}`);
  const stored = plain - IDENTITY_BYTES;
  const compressed = tail.length === TRAILER_BYTES + IDENTITY_BYTES && tail.subarray(0, TRAILER_BYTES).equals(trailer(hash));
  if (!compressed) return { stored, frame: null, stated: undefined };
  const frame = stored - TRAILER_BYTES;
  return { stored, frame, stated: frameContentSize(reader.head(Math.min(18, frame))) };
}

function isDamage(error: unknown): boolean {
  return error instanceof SealedError && error.code === "SEALED_DAMAGED";
}

function sealedFault(error: unknown, what: string): unknown {
  if (isDamage(error)) return new BlobError("BLOB_CORRUPT", `blob ${what}: ${(error as Error).message}`, { cause: error });
  if (error instanceof SealedError && error.code === "SEALED_BAD_RANGE") return new RangeError(`blob ${what}: ${error.message}`, { cause: error });
  return error;
}

function notFound(hash: string): BlobError {
  return new BlobError("BLOB_NOT_FOUND", `blob ${hash} is not stored`);
}

function ranged(reader: SealedReader, hash: string, range: { start: number; end: number }, length: number): Readable {
  const part = Readable.from((function* () {
    try {
      yield* reader.range(range.start, range.end, length);
    } catch (error) {
      throw sealedFault(error, hash);
    }
  })(), { objectMode: false });
  part.once("close", () => reader.close());
  return part;
}

function firstBytes(count: number): Transform {
  let passed = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const keep = Math.max(0, Math.min(chunk.length, count - passed));
      passed += chunk.length;
      callback(null, keep === 0 ? undefined : chunk.subarray(0, keep));
    },
  });
}

function inflatedPart(source: Readable, hash: string, range: { start: number; end: number }): Readable {
  const inflated = createZstdDecompress();
  source.on("error", (error) => inflated.destroy(sealedFault(error, hash) as Error));
  source.pipe(inflated);
  const part = Readable.from((async function* () {
    let at = 0;
    try {
      for await (const chunk of inflated as AsyncIterable<Buffer>) {
        const from = Math.max(range.start - at, 0);
        const to = Math.min(range.end - at, chunk.length);
        at += chunk.length;
        if (to > from) yield chunk.subarray(from, to);
        if (at >= range.end) return;
      }
    } catch (error) {
      if (error instanceof BlobError) throw error;
      throw new BlobError("BLOB_CORRUPT", `blob ${hash} does not inflate: ${(error as Error).message}`);
    }
  })(), { objectMode: false, highWaterMark: CHUNK });
  part.once("close", () => {
    source.destroy();
    inflated.destroy();
  });
  return part;
}

function spaceGuard(at: string, what: string): Transform {
  let free = freeOf(at);
  let size = 0;
  let checked = 0;
  return new Transform({
    transform: (chunk: Buffer, _encoding, callback) => {
      size += chunk.length;
      if (size - checked >= RECHECK_BYTES) {
        free = freeOf(at);
        checked = size;
      }
      callback(fits(free, "new", size - checked) ? null : noSpace(what, size), chunk);
    },
  });
}

function install(root: string, temporary: string, path: string, durable = true): void {
  chmodSync(temporary, 0o400);
  if (!linked(temporary, path)) {
    makeUnder(root, dirname(path));
    if (!linked(temporary, path)) throw new BlobError("BLOB_NOT_STORED", `${basename(path)} could not be linked into ${dirname(path)}`);
  }
  if (!durable) return;
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function locate(path: string, hash: string): Located {
  let file: number;
  try {
    file = openSync(path, "r");
  } catch (error) {
    if (isMissing(error)) throw new BlobError("BLOB_NOT_FOUND", `blob ${hash} is not stored`);
    throw error;
  }
  try {
    const stored = fstatSync(file).size;
    let frame: number | null = null;
    if (stored > TRAILER_BYTES) {
      const tail = Buffer.alloc(TRAILER_BYTES);
      readAt(file, tail, stored - TRAILER_BYTES);
      if (tail.equals(trailer(hash))) frame = stored - TRAILER_BYTES;
    }
    return { file, stored, frame };
  } catch (error) {
    closeSync(file);
    throw error;
  }
}

function readable(blob: Located, hash: string): Readable {
  let stated: number | undefined;
  try {
    stated = blob.frame === null ? undefined : frameContentSize(readExactly(blob.file, Math.min(18, blob.frame), hash));
  } catch (error) {
    closeSync(blob.file);
    throw error;
  }
  const source = createReadStream("", {
    fd: blob.file,
    start: 0,
    highWaterMark: CHUNK,
    ...(blob.frame === null ? {} : { end: blob.frame - 1 }),
  });
  const inflate = blob.frame === null ? null : createZstdDecompress();
  const verifier = verifierOf(hash, stated);
  source.on("error", (error) => verifier.destroy(error));
  inflate?.on("error", (error) => verifier.destroy(new BlobError("BLOB_CORRUPT", `blob ${hash} does not inflate: ${error.message}`)));
  verifier.on("close", () => {
    source.destroy();
    inflate?.destroy();
  });
  (inflate === null ? source : source.pipe(inflate)).pipe(verifier);
  return verifier;
}

function verifierOf(hash: string, stated: number | undefined): Transform {
  const digest = createHash("sha256");
  let held: Buffer | null = null;
  let passed = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (chunk.length === 0) return callback();
      passed += chunk.length;
      if (stated !== undefined && passed > stated) return callback(new BlobError("BLOB_CORRUPT", `blob ${hash} inflates past the ${stated} bytes its frame states`));
      digest.update(chunk);
      const before = held;
      held = chunk;
      callback(null, before ?? undefined);
    },
    flush(callback) {
      const actual = `sha256:${digest.digest("hex")}`;
      if (actual !== hash) return callback(corrupt(hash, actual));
      callback(null, held ?? undefined);
    },
  });
}

function part(blob: Located, hash: string, range: { start: number; end: number }): Readable {
  if (blob.frame === null) {
    if (range.end <= range.start) {
      closeSync(blob.file);
      return Readable.from([]);
    }
    return createReadStream("", { fd: blob.file, start: range.start, end: range.end - 1, highWaterMark: CHUNK });
  }
  const source = createReadStream("", { fd: blob.file, start: 0, end: blob.frame - 1, highWaterMark: CHUNK });
  const inflated = source.pipe(createZstdDecompress());
  source.on("error", (error) => inflated.destroy(error));
  return Readable.from((async function* () {
    let at = 0;
    try {
      for await (const chunk of inflated as AsyncIterable<Buffer>) {
        const from = Math.max(range.start - at, 0);
        const to = Math.min(range.end - at, chunk.length);
        at += chunk.length;
        if (to > from) yield chunk.subarray(from, to);
        if (at >= range.end) return;
      }
    } catch (error) {
      throw new BlobError("BLOB_CORRUPT", `blob ${hash} does not inflate: ${(error as Error).message}`);
    } finally {
      source.destroy();
      inflated.destroy();
    }
  })(), { objectMode: false, highWaterMark: CHUNK });
}

async function drain(stream: Readable): Promise<void> {
  for await (const _chunk of stream) {
  }
}

function linked(from: string, to: string): boolean {
  try {
    linkSync(from, to);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    if (code !== "EEXIST") throw error;
  }
  return true;
}

async function compressInto(src: string, size: number, dst: string, guard: Transform, durable = true): Promise<string> {
  const digest = createHash("sha256");
  let read = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      digest.update(chunk);
      read += chunk.length;
      callback(null, chunk);
    },
  });
  const options = { params: { [zlib.ZSTD_c_compressionLevel]: LEVEL }, pledgedSrcSize: size } as ZstdOptions;
  await pipeline(createReadStream(src, { highWaterMark: CHUNK }), tap, createZstdCompress(options), guard, createWriteStream(dst, { flags: "wx", mode: 0o600 }));
  if (read !== size) throw changedSize(src);
  const hash = `sha256:${digest.digest("hex")}`;
  const file = openSync(dst, "a");
  try {
    writeAll(file, trailer(hash));
    if (durable) fsyncSync(file);
  } finally {
    closeSync(file);
  }
  return hash;
}

async function writeInto(chunks: AsyncIterable<Uint8Array>, size: number, dst: string, compress: boolean, guard: Transform, durable = true): Promise<string> {
  const digest = createHash("sha256");
  let read = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      read += chunk.length;
      if (read > size) return callback(wrongSize(size, "more"));
      digest.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      callback(read === size ? undefined : wrongSize(size, `only ${read}`));
    },
  });
  const written = createWriteStream(dst, { flags: "wx", mode: 0o600 });
  const options = { params: { [zlib.ZSTD_c_compressionLevel]: LEVEL }, pledgedSrcSize: size } as ZstdOptions;
  if (compress) await pipeline(Readable.from(chunks), tap, createZstdCompress(options), guard, written);
  else await pipeline(Readable.from(chunks), tap, guard, written);
  const hash = `sha256:${digest.digest("hex")}`;
  const file = openSync(dst, "a");
  try {
    if (compress) writeAll(file, trailer(hash));
    if (durable) fsyncSync(file);
  } finally {
    closeSync(file);
  }
  return hash;
}

async function linkInto(src: string, dst: string, durable = true): Promise<string> {
  linkSync(src, dst);
  const digest = createHash("sha256");
  const file = await open(dst, "r");
  try {
    const size = (await file.stat()).size;
    const chunk = Buffer.allocUnsafe(CHUNK);
    let read = 0;
    for (;;) {
      const { bytesRead } = await file.read(chunk, 0, CHUNK, null);
      if (bytesRead === 0) break;
      digest.update(chunk.subarray(0, bytesRead));
      read += bytesRead;
    }
    if (read !== size) throw changedSize(src);
    if (durable) await file.sync();
  } finally {
    await file.close();
  }
  return `sha256:${digest.digest("hex")}`;
}

function wrongSize(size: number, held: string): BlobError {
  return new BlobError("BLOB_CORRUPT", `a streamed blob stated ${size} bytes and held ${held}`);
}

function changedSize(path: string): BlobError {
  return new BlobError("BLOB_CORRUPT", `${path} changed size while it was stored`);
}

function hexOf(hash: string): string {
  const match = BLOB_HASH.exec(hash);
  if (match === null) throw new BlobError("BAD_BLOB_HASH", `a blob hash is 'sha256:' and 64 lowercase hex digits: ${JSON.stringify(hash)}`);
  return match[1]!;
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function expectHash(actual: string, expected: string | undefined): void {
  if (expected !== undefined && actual !== expected) {
    throw new BlobError("BLOB_HASH_MISMATCH", `expected blob ${expected}, the bytes hash to ${actual}`);
  }
}

function trailer(hash: string): Buffer {
  const bytes = Buffer.alloc(TRAILER_BYTES);
  bytes.writeUInt32LE(TRAILER_MAGIC, 0);
  bytes.writeUInt32LE(TRAILER_BYTES - 8, 4);
  Buffer.from(hexOf(hash), "hex").copy(bytes, 8);
  return bytes;
}

function frameContentSize(header: Buffer): number | undefined {
  if (header.length < 5 || header.readUInt32LE(0) !== ZSTD_MAGIC) return undefined;
  const descriptor = header[4]!;
  const single = (descriptor >> 5) & 1;
  const width = [single ? 1 : 0, 2, 4, 8][descriptor >> 6]!;
  const at = 5 + (single ? 0 : 1) + [0, 1, 2, 4][descriptor & 3]!;
  if (width === 0 || header.length < at + width) return undefined;
  if (width === 1) return header.readUInt8(at);
  if (width === 2) return header.readUInt16LE(at) + 256;
  if (width === 4) return header.readUInt32LE(at);
  return Number(header.readBigUInt64LE(at));
}

function inflateOrCorrupt(frame: Buffer, hash: string): Buffer {
  try {
    return zstdDecompressSync(frame);
  } catch (error) {
    throw new BlobError("BLOB_CORRUPT", `blob ${hash} does not inflate: ${(error as Error).message}`);
  }
}

function corrupt(hash: string, actual: string): BlobError {
  return new BlobError("BLOB_CORRUPT", `blob ${hash} holds bytes that hash to ${actual}`);
}

function unwritten(error: unknown, what: string): unknown {
  if (error instanceof BlobError) return error;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (outOfRoom(error)) return new BlobError("BLOB_NO_SPACE", `the disk filled while ${what} was written`);
  if (typeof code === "string" && /^E[A-Z]+$/u.test(code)) return new BlobError("BLOB_NOT_STORED", `${what} could not be written: ${(error as Error).message}`);
  return error;
}

function noSpace(what: string, need: number): BlobError {
  return new BlobError("BLOB_NO_SPACE", `${what} needs ${need} bytes, which its disk cannot take and keep 1 GB free`);
}

function readAt(file: number, into: Buffer, position: number): void {
  for (let read = 0; read < into.length; ) {
    const bytes = readSync(file, into, read, into.length - read, position + read);
    if (bytes === 0) throw new BlobError("BLOB_CORRUPT", "a blob file ended early");
    read += bytes;
  }
}

function readExactly(file: number, length: number, hash: string): Buffer {
  const bytes = Buffer.alloc(length);
  try {
    readAt(file, bytes, 0);
  } catch (error) {
    if (error instanceof BlobError) throw new BlobError("BLOB_CORRUPT", `blob ${hash} ended early`);
    throw error;
  }
  return bytes;
}

function writeAll(file: number, bytes: Buffer): void {
  for (let written = 0; written < bytes.length; ) written += writeSync(file, bytes, written);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}
