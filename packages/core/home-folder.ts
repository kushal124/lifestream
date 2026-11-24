import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, createReadStream, createWriteStream, existsSync, fstatSync, fsyncSync, ftruncateSync, linkSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { open, rename, rm, type FileHandle } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isMainThread } from "node:worker_threads";
import Database from "better-sqlite3";
import { BLOB_HASH, BlobError, blobsIn, KEYED_BLOBS_KEY_ID, keyedBlobName, type BlobStore } from "./blobs.js";
import { flush, flushed, makeUnder, writeDurably } from "./disk.js";
import { KeyError, keyBytesOf, Keys, type HandedKeys, type KeyLabel } from "./keys.js";
import { stampsTo } from "./schema.js";
import { cipherLoaded, madeScratch, SORTS, spillSorts } from "./scratch.js";
import { blobSealing, fileData, freshHeader, HEADER_BYTES, IDENTITY_BYTES, identityOf, isTemporary, keyedName, layoutOf, nameKey, openBlob, openFile, openWhole, Positioned, readSealedSync, SealedError, sealWhole, SealedReader, SEGMENT, sweepTemporaries, TAG_BYTES, temporaryIn, writeSealed, writeSealedSync, type Sealing, type SegmentSize } from "./sealed.js";
import { damaged } from "./sql.js";

export type Form = "plain" | "keyed";

export interface StoreKind {
  readonly role: string;
  readonly remade: boolean;
}

export interface StoreOpen {
  mode?: "write" | "read";
  mustExist?: boolean;
  sync?: "FULL" | "NORMAL";
  timeout?: number;
  keepJournal?: boolean;
  mapped?: number;
  sorts?: "memory";
}

export type FileKind = NamedKind | BlobKind;

export interface NamedKind {
  readonly role: string;
  readonly segment?: SegmentSize;
  readonly remade?: true;
  readonly passing?: true;
  readonly blob?: never;
  readonly grows?: never;
}

export interface BlobKind {
  readonly blob: true;
  readonly role?: never;
  readonly grows?: never;
}

export const BLOB_FILE: BlobKind = { blob: true };

export interface GrowingKind {
  readonly role: string;
  readonly segment?: SegmentSize;
  readonly grows: true;
}

export interface Staged {
  readonly from: string;
  readonly to: string;
}

export interface OpenedFile {
  readonly size: number;
  read(into: Buffer, at: number): number;
  close(): void;
}

export interface OpenFile {
  readonly size: number;
  reading(range?: { start: number; end: number }): Readable;
  close(): Promise<void>;
}

export interface FileStat {
  readonly size: number;
  readonly modified_ms: number;
  readonly links: number;
}

export interface Materialised {
  readonly path: string;
  dispose(): void;
}

export interface KeptFile {
  readonly path: string;
  exists(): boolean;
  stat(): FileStat | undefined;
  touch(at_ms: number): void;
  read(): Buffer | undefined;
  opened(): OpenedFile | undefined;
  open(): Promise<OpenFile | undefined>;
  reading(range?: { start: number; end: number }): Readable;
  write(bytes: Buffer): void;
  writing(chunks: AsyncIterable<Uint8Array>): Promise<number>;
  stage(bytes: Buffer): Staged;
  adopt(made: string | KeptFile): Promise<void>;
  link(from: KeptFile): Promise<void>;
  materialise(): Materialised;
  remove(): boolean;
}

export interface GrowingFile {
  readonly path: string;
  read(): Buffer | undefined;
  opened(): OpenedFile | undefined;
  append(bytes: Buffer, at?: number): void;
  write(chunks: Iterable<Buffer>): void;
  remove(): boolean;
}

export interface BlobFile {
  readonly blob: string;
  readonly file: KeptFile;
}

export interface Work {
  readonly path: string;
  empty(): void;
}

export const PROGRAMS = ["home", "door", "call"] as const;
export type Program = (typeof PROGRAMS)[number];

export type PlainWork = string | { readonly own: string };

export interface WorkOf {
  readonly program?: Program;
  readonly job?: string;
  readonly plain?: string | undefined;
}

interface Holding {
  readonly machine: string;
  readonly program: Program;
  readonly keys?: Keys;
  readonly vault?: string;
}

export type HandedFolder =
  | { readonly root: string; readonly form: "plain" }
  | { readonly root: string; readonly form: "keyed"; readonly machine: string; readonly program: Program; readonly keys: HandedKeys };

export interface HomeFolder {
  readonly root: string;
  readonly form: Form;
  store(kind: StoreKind, path: string, open?: StoreOpen): Database.Database;
  attach(db: Database.Database, as: string, kind: StoreKind, path: string): void;
  blobs(path: string, open?: { reading?: true }): BlobStore;
  file(kind: GrowingKind, path: string): GrowingFile;
  file(kind: FileKind, path: string): KeptFile;
  sealedFile(kind: FileKind, path: string): KeptFile | undefined;
  commit(staged: readonly Staged[]): void;
  discard(staged: readonly Staged[]): void;
  names(directory: string): string[];
  blobFile(directory: string, blob: string, at?: { sharded?: true }): KeptFile;
  blobFiles(directory: string): BlobFile[];
  placeName(use: string, plain: string): string;
  work(job: string, plain?: PlainWork): Work;
  emptyWork(of?: WorkOf): void;
  handOver(labels?: readonly KeyLabel[], to?: Program): HandedFolder;
}

export type StoreErrorCode = "STORE_PLAIN" | "STORE_KEY" | "STORE_SCRATCH";

export class StoreError extends Error {
  static override [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof Error && value.name === "StoreError";
  }

  constructor(
    readonly code: StoreErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

const VAULT = join("config", "vault.json");
const STAMP = join("config", "stores.json");
const HOME = "home.db";
const BLOB_TREES = [join("blobs", `k${KEYED_BLOBS_KEY_ID}`), join("replies", "blobs", `k${KEYED_BLOBS_KEY_ID}`)];
const KEYED_NAME = /\.k[1-9][0-9]*$/u;
const PIECE = /^(?:0|[1-9][0-9]*)$/u;
const BLOB_NAME = /^[0-9a-f]{64}$/u;
const PLAIN_HEADER = Buffer.from("SQLite format 3\0", "latin1");
const STORE_FILES = ["", "-wal", "-shm", "-journal"];
const BUSY_TIMEOUT_MS = 5_000;
export const KEYED_CACHE_KB = 65_536;
export const KEYED_CIPHER = { cipher: "aegis", algorithm: "aegis-256" } as const;
const JOB = /^[a-z0-9][a-z0-9._-]*$/u;
const CIPHER_PACKAGE = "better-sqlite3-multiple-ciphers";

export function formOf(root: string): Form {
  return vaultHoldsKeys(root) || headerJudged(root) || keyedNames(root) ? "keyed" : "plain";
}

export interface StoreStamp {
  readonly key_id: string | null;
  readonly versions: { readonly [file: string]: number };
}

export function storeStamp(root: string): StoreStamp | null {
  const stamp = readStamp(root);
  if (stamp === null) return null;
  const versions: Record<string, number> = {};
  for (const [file, version] of Object.entries(stamp)) {
    if (file !== "key_id" && typeof version === "number" && Number.isSafeInteger(version) && version >= 0) versions[file] = version;
  }
  return { key_id: typeof stamp.key_id === "string" ? stamp.key_id : null, versions };
}

export function cipherLoads(): string | null {
  try {
    probeCipher();
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

export function sqliteVersion(): string {
  const db = new Database(":memory:");
  try {
    return db.prepare("SELECT sqlite_version()").pluck().get() as string;
  } finally {
    db.close();
  }
}

export function openHomeFolder(root: string, held?: Holding): HomeFolder {
  if (!isMainThread) throw new Error(`a thread opens only the folder it was handed (openHandedFolder): ${root} is judged by the main thread, which hands it over`);
  if (formOf(root) === "plain") return new Folder(root, undefined);
  if (held?.keys === undefined) throw new KeyError("LOCKED", `${root} is an encrypted home and this program holds no keys for it`);
  return keyedFolder(root, held.machine, held.program, held.keys, held.vault);
}

export function plainFolder(root: string): HomeFolder | null {
  return formOf(root) === "plain" ? new Folder(root, undefined) : null;
}

export function scratchFolder(root: string): HomeFolder {
  return new Folder(root, undefined, true);
}

export function openHandedFolder(handed: HandedFolder): HomeFolder {
  return handed.form === "plain" ? new Folder(handed.root, undefined) : keyedFolder(handed.root, handed.machine, handed.program, Keys.read(handed.keys), undefined);
}

export function handedFolderIn(text: string): HandedFolder {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new KeyError("REFUSED", "a handed folder does not read as JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new KeyError("REFUSED", "a handed folder is not an object");
  const { root, form, machine, program, keys, ...rest } = value as Record<string, unknown>;
  if (typeof root !== "string" || root === "" || Object.keys(rest).length > 0) throw new KeyError("REFUSED", "a handed folder names its root and nothing else but its form, machine, program and keys");
  if (form === "plain" && machine === undefined && program === undefined && keys === undefined) return { root, form };
  if (form !== "keyed" || typeof machine !== "string" || machine === "" || !isProgram(program)) throw new KeyError("REFUSED", "a handed folder is plain, or keyed with its machine, program and keys");
  Keys.read(keys);
  return { root, form, machine, program, keys: keys as HandedKeys };
}

function isProgram(value: unknown): value is Program {
  return (PROGRAMS as readonly unknown[]).includes(value);
}

function jobNamed(job: string): void {
  if (!JOB.test(job)) throw new Error(`a job's work folder is named by lowercase letters, digits, dots and dashes: not ${JSON.stringify(job)}`);
}

function jobFolders(scratch: string, job: string): string[] {
  jobNamed(job);
  return namesIn(scratch).filter((name) => name.startsWith(`${job}-`) && name.length === job.length + 7).map((name) => join(scratch, name));
}

function keyedFolder(root: string, machine: string, program: Program, keys: Keys, vault: string | undefined): HomeFolder {
  if (!isProgram(program)) throw new Error(`scratch holds a folder for each of ${PROGRAMS.join(", ")}, not ${JSON.stringify(program)}`);
  const scratch = madeScratch(machine);
  const sorts = join(scratch, SORTS);
  const refused = spillSorts(sorts);
  if (refused !== null) throw new StoreError("STORE_SCRATCH", sorts, refused);
  return new Folder(root, { keys, scratch, program, machine, vault });
}

class Folder implements HomeFolder {
  readonly form: Form;
  readonly #swept = new Set<string>();
  #files: Buffer | undefined;
  #names: Buffer | undefined;

  constructor(
    readonly root: string,
    private readonly keyed: { keys: Keys; scratch: string; program: Program; machine: string; vault: string | undefined } | undefined,
    private readonly ephemeral = false,
  ) {
    this.form = keyed === undefined ? "plain" : "keyed";
  }

  store(kind: StoreKind, path: string, open: StoreOpen = {}): Database.Database {
    if (this.keyed === undefined || !onDisk(path)) return openPlain(path, open, this.ephemeral);
    const label = storeLabel(kind.role);
    try {
      return this.#keyedStore(kind, path, open);
    } catch (error) {
      if (!damaged(error)) throw error;
      if (!kind.remade) {
        throw plainHeader(path)
          ? new StoreError("STORE_PLAIN", path, `${path} is a plain store in a keyed home: it is refused, never read as plain`)
          : new StoreError("STORE_KEY", path, `${path} does not open under this home's key for ${label}: it is another home's, or damaged`);
      }
      if (open.mode === "read" || open.mustExist === true) throw error;
      removeStore(path);
      return this.#keyedStore(kind, path, open);
    }
  }

  attach(db: Database.Database, as: string, kind: StoreKind, path: string): void {
    const statement = db.prepare(`ATTACH DATABASE ? AS "${as.replaceAll('"', '""')}"${this.keyed === undefined ? "" : " KEY ?"}`);
    if (this.keyed === undefined) {
      statement.run(path);
      return;
    }
    const key = keyBytesOf(this.keyed.keys, storeLabel(kind.role));
    try {
      statement.run(path, `x'${key.toString("hex")}'`);
    } finally {
      key.fill(0);
    }
  }

  blobs(path: string, open: { reading?: true } = {}): BlobStore {
    const reading = open.reading === true;
    if (this.keyed === undefined) return blobsIn(path, { keyed: false, bare: plainPathOf }, reading, this.ephemeral);
    const { keys } = this.keyed;
    const files = keyBytesOf(keys, "files");
    return blobsIn(path, { keyed: true, files, names: keyBytesOf(keys, "names"), scratch: this.#scratchOf(), sealed: (file) => sealedBlobOf(file, files) }, reading);
  }

  file(kind: GrowingKind, path: string): GrowingFile;
  file(kind: FileKind, path: string): KeptFile;
  file(kind: FileKind | GrowingKind, path: string): KeptFile | GrowingFile {
    if (kind.grows === true) {
      if (this.keyed === undefined) return new PlainGrowing(path);
      const folder = keyedName(path, KEYED_BLOBS_KEY_ID);
      return new PiecedFile(path, new Pieces(folder, this.#filesKey(), kind.role, this.#place(path), kind.segment ?? SEGMENT), () => this.#sweep(folder));
    }
    if (this.keyed === undefined) return new PlainFile(path, this.ephemeral ? { ...kind, remade: true } : kind.blob === true ? {} : kind);
    const sealing: Sealing = kind.blob === true ? blobSealing(this.#filesKey()) : { key: this.#filesKey(), associatedData: fileData(kind.role, this.#place(path)), segment: kind.segment ?? SEGMENT };
    return new SealedFile(path, keyedName(path, KEYED_BLOBS_KEY_ID), sealing, () => this.#sweep(dirname(path)), () => this.work("materialise"), kind.blob === true ? IDENTITY_BYTES : 0);
  }

  sealedFile(kind: FileKind, path: string): KeptFile | undefined {
    return this.keyed === undefined ? undefined : this.file(kind, path);
  }

  commit(staged: readonly Staged[]): void {
    for (const { from, to } of staged) renameSync(from, to);
    if (!this.ephemeral) for (const directory of new Set(staged.map(({ to }) => dirname(to)))) flush(directory);
  }

  discard(staged: readonly Staged[]): void {
    for (const { from } of staged) rmSync(from, { force: true });
  }

  names(directory: string): string[] {
    const names = namesIn(directory);
    if (this.keyed === undefined) return names;
    const plain = new Set<string>();
    for (const name of names) {
      if (isTemporary(name)) continue;
      plain.add(nameKey(name)?.plainName ?? name);
    }
    return [...plain];
  }

  work(job: string, plain?: PlainWork): Work {
    jobNamed(job);
    if (this.keyed !== undefined) {
      const scratch = this.#scratchOf();
      mkdirSync(scratch, { recursive: true, mode: 0o700 });
      return emptied(mkdtempSync(join(scratch, `${job}-`)));
    }
    if (plain === undefined) return emptied(mkdtempSync(join(tmpdir(), `lifestream-${job}-`)));
    if (typeof plain === "string") return { path: plain, empty: () => undefined };
    rmSync(plain.own, { recursive: true, force: true });
    mkdirSync(dirname(plain.own), { recursive: true });
    mkdirSync(plain.own, { mode: 0o700 });
    return emptied(plain.own);
  }

  emptyWork(of: WorkOf = {}): void {
    if (this.keyed === undefined) {
      if (of.plain !== undefined) rmSync(of.plain, { recursive: true, force: true });
      return;
    }
    const scratch = this.#scratchOf(of.program);
    for (const path of of.job === undefined ? [scratch] : jobFolders(scratch, of.job)) rmSync(path, { recursive: true, force: true });
    chmodSync(this.keyed.scratch, 0o700);
  }

  handOver(labels?: readonly KeyLabel[], to?: Program): HandedFolder {
    if (this.keyed === undefined) return { root: this.root, form: "plain" };
    const { keys, machine, program } = this.keyed;
    return { root: this.root, form: "keyed", machine, program: to ?? program, keys: (labels === undefined ? keys : keys.only(labels)).hand() };
  }

  #scratchOf(program: Program = this.keyed!.program): string {
    return join(this.keyed!.scratch, program);
  }

  #keyedStore(kind: StoreKind, path: string, open: StoreOpen): Database.Database {
    const db = openKeyed(path, keyBytesOf(this.keyed!.keys, storeLabel(kind.role)), open);
    if (open.mode !== "read" && !kind.remade) stampsTo(db, (file, version) => writeStamp(this.root, file, version, this.keyed!.vault));
    return db;
  }

  #filesKey(): Buffer {
    this.#files ??= keyBytesOf(this.keyed!.keys, "files");
    return this.#files;
  }

  blobFile(directory: string, blob: string, at: { sharded?: true } = {}): KeptFile {
    const name = this.#blobName(blob);
    return this.file(BLOB_FILE, at.sharded === true ? join(directory, name.slice(0, 2), name) : join(directory, name));
  }

  blobFiles(directory: string): BlobFile[] {
    const found: BlobFile[] = [];
    for (const name of this.names(directory)) {
      if (!BLOB_NAME.test(name)) continue;
      const path = join(directory, name);
      const blob = this.keyed === undefined ? `sha256:${name}` : this.#identity(keyedName(path, KEYED_BLOBS_KEY_ID));
      if (blob !== undefined && this.#blobName(blob) === name) found.push({ blob, file: this.file(BLOB_FILE, path) });
    }
    return found;
  }

  placeName(use: string, plain: string): string {
    if (!/^[a-z]+$/u.test(use)) throw new Error(`a place name's use is lowercase letters: ${JSON.stringify(use)}`);
    if (this.keyed === undefined) return plain;
    return createHmac("sha256", this.#namesKey()).update(`${use}:${plain}`).digest("hex");
  }

  #namesKey(): Buffer {
    this.#names ??= keyBytesOf(this.keyed!.keys, "names");
    return this.#names;
  }

  #blobName(blob: string): string {
    const hex = BLOB_HASH.exec(blob)?.[1] ?? (() => { throw new BlobError("BAD_BLOB_HASH", `a blob hash is 'sha256:' and 64 lowercase hex digits: ${JSON.stringify(blob)}`); })();
    if (this.keyed === undefined) return hex;
    return keyedBlobName(this.#namesKey(), blob);
  }

  #identity(sealed: string): string | undefined {
    let reader: SealedReader;
    try {
      reader = SealedReader.open(sealed, blobSealing(this.#filesKey()));
    } catch (error) {
      if (error instanceof SealedError || (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      return reader.plainLength < IDENTITY_BYTES ? undefined : `sha256:${reader.tail(IDENTITY_BYTES).toString("hex")}`;
    } catch (error) {
      if (error instanceof SealedError) return undefined;
      throw error;
    } finally {
      reader.close();
    }
  }

  #place(path: string): string {
    const at = resolve(path);
    for (const under of [this.root, this.keyed!.machine]) {
      const within = relative(resolve(under), at);
      if (within !== "" && !within.startsWith(`..${sep}`) && within !== ".." && !isAbsolute(within)) return within.split(sep).join("/");
    }
    throw new Error(`${path} is neither in the home at ${this.root} nor in its machine folder at ${this.keyed!.machine}: a kept file lives in one of them`);
  }

  #sweep(directory: string): void {
    if (this.#swept.has(directory)) return;
    sweepTemporaries(directory);
    this.#swept.add(directory);
  }
}

class PlainPlace {
  constructor(readonly path: string) {}

  read(): Buffer | undefined {
    return absentAs(() => readFileSync(this.path), undefined);
  }

  opened(): OpenedFile | undefined {
    const fd = absentAs(() => openSync(this.path, "r"), undefined);
    return fd === undefined ? undefined : new PlainOpened(fd);
  }

  async open(): Promise<OpenFile | undefined> {
    const handle = await absentAsync(() => open(this.path, "r"));
    if (handle === undefined) return undefined;
    try {
      const { size } = await handle.stat();
      return { size, reading: (range) => handleReading(handle, range), close: () => handle.close() };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  remove(): boolean {
    return removed(this.path);
  }
}

class PlainFile extends PlainPlace implements KeptFile {
  constructor(
    path: string,
    private readonly kind: { readonly remade?: true; readonly passing?: true },
  ) {
    super(path);
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  stat(): FileStat | undefined {
    const stat = statSync(this.path, { throwIfNoEntry: false });
    return stat?.isFile() === true ? { size: stat.size, modified_ms: stat.mtimeMs, links: stat.nlink } : undefined;
  }

  touch(at_ms: number): void {
    touched(this.path, at_ms);
  }

  reading(range?: { start: number; end: number }): Readable {
    if (range === undefined) return createReadStream(this.path);
    if (range.end <= range.start) return Readable.from([]);
    return createReadStream(this.path, { start: range.start, end: range.end - 1 });
  }

  write(bytes: Buffer): void {
    if (this.kind.remade !== true) {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      writeDurably(this.path, bytes);
      return;
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = cacheTemporary(this.path);
    writeFileSync(temporary, bytes);
    renameSync(temporary, this.path);
  }

  stage(bytes: Buffer): Staged {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const from = join(dirname(this.path), `.${basename(this.path)}.${randomUUID()}.tmp`);
    writeFileSync(from, bytes, { flag: "wx" });
    flush(from);
    return { from, to: this.path };
  }

  async adopt(made: string | KeptFile): Promise<void> {
    const from = typeof made === "string" ? made : plainPathOf(made);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    if (this.kind.remade !== true) await flushed(from);
    renameSync(from, this.path);
  }

  async link(from: KeptFile): Promise<void> {
    const path = plainPathOf(from);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    linkSync(path, this.path);
  }

  materialise(): Materialised {
    return { path: this.path, dispose: () => undefined };
  }

  async writing(chunks: AsyncIterable<Uint8Array>): Promise<number> {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    if (this.kind.passing === true) return passed(this.path, chunks);
    const beside = temporaryIn(dirname(this.path));
    let written = 0;
    try {
      await pipeline((async function* () {
        for await (const chunk of chunks) {
          written += chunk.length;
          yield chunk;
        }
      })(), createWriteStream(beside, { flags: "wx", mode: 0o600, flush: this.kind.remade !== true }));
      await rename(beside, this.path);
    } finally {
      await rm(beside, { force: true });
    }
    return written;
  }
}

async function passed(path: string, chunks: AsyncIterable<Uint8Array>): Promise<number> {
  const handle = await open(path, "wx");
  let written = 0;
  try {
    for await (const chunk of chunks) {
      for (let at = 0; at < chunk.byteLength;) at += (await handle.write(chunk, at, chunk.byteLength - at)).bytesWritten;
      written += chunk.byteLength;
    }
  } finally {
    await handle.close();
  }
  return written;
}

function plainPathOf(file: KeptFile): string {
  if (!(file instanceof PlainFile)) throw new Error(`${file.path} is not a file of a plain folder: a file moves only within its own folder`);
  return file.path;
}

function sealedBlobOf(file: KeptFile, key: Buffer): string {
  if (!(file instanceof SealedFile) || file.identity !== IDENTITY_BYTES || !file.sealing.key.equals(key)) {
    throw new BlobError("BLOB_NOT_STORED", `${file.path} is not a blob-form file of this keyed home`);
  }
  return file.sealed;
}

class PlainGrowing extends PlainPlace implements GrowingFile {
  append(bytes: Buffer, at?: number): void {
    if (at === undefined) {
      const fresh = !existsSync(this.path);
      if (fresh) mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      appendFileSync(this.path, bytes);
      flush(this.path);
      if (fresh) flush(dirname(this.path));
      return;
    }
    mkdirSync(dirname(this.path), { recursive: true });
    let fd: number;
    let created = false;
    try {
      fd = openSync(this.path, "r+");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      fd = openSync(this.path, "w+");
      created = true;
    }
    try {
      for (let written = 0; written < bytes.length;) written += writeSync(fd, bytes, written, bytes.length - written, at + written);
      ftruncateSync(fd, at + bytes.length);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (created) flush(dirname(this.path));
  }

  write(chunks: Iterable<Buffer>): void {
    const fd = openSync(this.path, "w");
    try {
      let at = 0;
      for (const chunk of chunks) {
        for (let put = 0; put < chunk.length;) put += writeSync(fd, chunk, put, chunk.length - put, at + put);
        at += chunk.length;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    flush(dirname(this.path));
  }
}

class SealedFile implements KeptFile {
  constructor(
    readonly path: string,
    readonly sealed: string,
    readonly sealing: Sealing,
    private readonly sweep: () => void,
    private readonly work: () => Work,
    readonly identity: number,
  ) {}

  exists(): boolean {
    return existsSync(this.sealed);
  }

  stat(): FileStat | undefined {
    const stat = statSync(this.sealed, { throwIfNoEntry: false });
    if (stat?.isFile() !== true) return undefined;
    return { size: layoutOf(stat.size, this.sealing.segment, basename(this.sealed)).plainLength - this.identity, modified_ms: stat.mtimeMs, links: stat.nlink };
  }

  touch(at_ms: number): void {
    touched(this.sealed, at_ms);
  }

  read(): Buffer | undefined {
    const plain = absentAs(() => readSealedSync(this.sealed, this.sealing), undefined);
    return plain?.subarray(0, this.#within(plain.length));
  }

  opened(): OpenedFile | undefined {
    const reader = absentAs(() => SealedReader.open(this.sealed, this.sealing), undefined);
    if (reader === undefined) return undefined;
    try {
      return new SealedOpened(reader, this.#within(reader.plainLength));
    } catch (error) {
      reader.close();
      throw error;
    }
  }

  async open(): Promise<OpenFile | undefined> {
    const positioned = await absentAsync(() => Positioned.open(this.sealed, this.sealing, basename(this.sealed)));
    if (positioned === undefined) return undefined;
    const plainLength = this.#within(positioned.layout.plainLength);
    return {
      size: plainLength,
      reading: (range) => Readable.from(positioned.range(...clampedTo(plainLength, range ?? { start: 0, end: plainLength })), { objectMode: false }),
      close: () => positioned.handle.close(),
    };
  }

  reading(range?: { start: number; end: number }): Readable {
    if (range === undefined) return this.identity === 0 ? openFile(this.sealed, this.sealing) : openBlob(this.sealed, this.sealing);
    return Readable.from(this.#span(range), { objectMode: false });
  }

  write(bytes: Buffer): void {
    this.#ready();
    writeSealedSync(this.sealed, this.#whole(bytes), this.sealing);
  }

  writing(chunks: AsyncIterable<Uint8Array>): Promise<number> {
    this.#ready();
    return writeSealed(this.sealed, this.identity === 0 ? chunks : identified(chunks), this.sealing);
  }

  stage(bytes: Buffer): Staged {
    this.#ready();
    const from = temporaryIn(dirname(this.sealed));
    const sealed = sealWhole(this.#whole(bytes), this.sealing, basename(this.sealed));
    const fd = openSync(from, "wx", 0o600);
    try {
      for (let at = 0; at < sealed.length; ) at += writeSync(fd, sealed, at, sealed.length - at);
      fsyncSync(fd);
    } catch (error) {
      rmSync(from, { force: true });
      throw error;
    } finally {
      closeSync(fd);
    }
    return { from, to: this.sealed };
  }

  async adopt(made: string | KeptFile): Promise<void> {
    if (typeof made !== "string" && !(made instanceof SealedFile)) throw new Error(`${made.path} is not a file of a keyed folder: a file moves only within its own folder`);
    this.#ready();
    const chunks = typeof made === "string" ? createReadStream(made, { highWaterMark: this.sealing.segment }) : made.reading();
    await writeSealed(this.sealed, this.identity === 0 ? chunks : identified(chunks), this.sealing);
    if (typeof made === "string") await rm(made, { force: true });
    else made.remove();
  }

  async link(from: KeptFile): Promise<void> {
    if (!(from instanceof SealedFile) || from.sealing.associatedData !== this.sealing.associatedData || !from.sealing.key.equals(this.sealing.key) || from.identity !== this.identity) {
      throw new Error(`${from.path} is not sealed as ${this.path} is: a file links only to a blob-form file of its own folder`);
    }
    this.#ready();
    linkSync(from.sealed, this.sealed);
  }

  materialise(): Materialised {
    const work = this.work();
    try {
      const copy = join(work.path, basename(this.path));
      writeFileSync(copy, this.read() ?? gone(this.path), { mode: 0o600, flag: "wx" });
      return { path: copy, dispose: () => work.empty() };
    } catch (error) {
      work.empty();
      throw error;
    }
  }

  remove(): boolean {
    return removed(this.sealed);
  }

  #ready(): void {
    mkdirSync(dirname(this.sealed), { recursive: true, mode: 0o700 });
    this.sweep();
  }

  #within(plainLength: number): number {
    if (plainLength < this.identity) throw new SealedError("SEALED_DAMAGED", basename(this.sealed), "it holds fewer plain bytes than its identity");
    return plainLength - this.identity;
  }

  *#span(range: { start: number; end: number }): Generator<Buffer> {
    const reader = SealedReader.open(this.sealed, this.sealing);
    try {
      yield* reader.range(...clampedTo(this.#within(reader.plainLength), range));
    } finally {
      reader.close();
    }
  }

  #whole(bytes: Buffer): Buffer {
    return this.identity === 0 ? bytes : Buffer.concat([bytes, identityOf(bytes)]);
  }
}

async function* identified(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  const digest = createHash("sha256");
  for await (const chunk of chunks) {
    digest.update(chunk);
    yield chunk;
  }
  yield digest.digest();
}

interface Tail {
  readonly count: number;
  readonly last: number;
}

class Pieces {
  readonly room: number;

  constructor(
    readonly folder: string,
    private readonly key: Buffer,
    private readonly role: string,
    private readonly place: string,
    private readonly segment: SegmentSize,
  ) {
    this.room = segment - HEADER_BYTES - TAG_BYTES;
  }

  sizeOf(tail: Tail): number {
    return (tail.count - 1) * this.room + tail.last;
  }

  tail(): Tail | undefined {
    for (let index = 0; ; index += 1) {
      const size = this.#diskSize(index);
      if (size === undefined) return this.#none(index);
      if (size < HEADER_BYTES + TAG_BYTES || size > this.segment) throw new SealedError("SEALED_DAMAGED", this.#name(index), `its ${size} bytes are no one sealed segment of ${this.segment}`);
      if (size < this.segment) return { count: index + 1, last: size - HEADER_BYTES - TAG_BYTES };
    }
  }

  #none(index: number): undefined {
    if (index > 0) throw new SealedError("SEALED_DAMAGED", this.#name(index), `piece ${index - 1} is full, so a piece follows it, and none does: the file's end was dropped`);
    if (this.#anyKept()) throw new SealedError("SEALED_DAMAGED", this.#name(0), "later pieces are kept and the first is not: the file's start was dropped");
    return undefined;
  }

  header(index: number): Buffer {
    const fd = openSync(this.#at(index), "r");
    try {
      const header = Buffer.alloc(HEADER_BYTES);
      if (readSync(fd, header, 0, HEADER_BYTES, 0) !== HEADER_BYTES) throw new SealedError("SEALED_DAMAGED", this.#name(index), "it is shorter than its header");
      return header;
    } finally {
      closeSync(fd);
    }
  }

  piece(index: number, before: Buffer | undefined): { header: Buffer; plain: Buffer } {
    const sealed = readFileSync(this.#at(index));
    return { header: Buffer.from(sealed.subarray(0, HEADER_BYTES)), plain: openWhole(sealed, this.#sealing(index, before), this.#name(index)) };
  }

  lay(first: number, before: Buffer | undefined, plain: Buffer): void {
    const count = Math.floor(plain.length / this.room) + 1;
    const headers = Array.from({ length: count }, () => freshHeader());
    const part = (at: number) => plain.subarray(at * this.room, Math.min((at + 1) * this.room, plain.length));
    for (let at = count - 1; at >= 1; at -= 1) this.#put(first + at, headers[at - 1], part(at), headers[at]!);
    if (count > 1) flush(this.folder);
    this.#put(first, before, part(0), headers[0]!);
    flush(this.folder);
  }

  put(index: number, before: Buffer | undefined, plain: Buffer): Buffer {
    const header = freshHeader();
    this.#put(index, before, plain, header);
    return header;
  }

  dropAfter(last: number): void {
    for (const name of namesIn(this.folder)) {
      const index = nameKey(name)?.plainName;
      if (index !== undefined && PIECE.test(index) && Number(index) > last) rmSync(join(this.folder, name), { force: true });
    }
  }

  #sealing(index: number, before: Buffer | undefined): Sealing {
    return { key: this.key, associatedData: fileData(this.role, `${this.place}:piece:${index}:${before === undefined ? "first" : before.toString("hex")}`), segment: this.segment };
  }

  #anyKept(): boolean {
    return namesIn(this.folder).some((name) => PIECE.test(nameKey(name)?.plainName ?? ""));
  }

  #put(index: number, before: Buffer | undefined, plain: Buffer, header: Buffer): void {
    const sealed = sealWhole(plain, this.#sealing(index, before), this.#name(index), header);
    const beside = temporaryIn(this.folder);
    try {
      const fd = openSync(beside, "wx", 0o600);
      try {
        for (let at = 0; at < sealed.length;) at += writeSync(fd, sealed, at, sealed.length - at);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(beside, this.#at(index));
    } finally {
      rmSync(beside, { force: true });
    }
  }

  #diskSize(index: number): number | undefined {
    const stat = statSync(this.#at(index), { throwIfNoEntry: false });
    return stat?.isFile() === true ? stat.size : undefined;
  }

  #at(index: number): string {
    return join(this.folder, this.#name(index));
  }

  #name(index: number): string {
    return keyedName(String(index), KEYED_BLOBS_KEY_ID);
  }
}

class PiecedFile implements GrowingFile {

  constructor(
    readonly path: string,
    private readonly pieces: Pieces,
    private readonly sweep: () => void,
  ) {}

  read(): Buffer | undefined {
    const opened = this.opened();
    if (opened === undefined) return undefined;
    try {
      const whole = Buffer.alloc(opened.size);
      return whole.subarray(0, opened.read(whole, 0));
    } finally {
      opened.close();
    }
  }

  opened(): OpenedFile | undefined {
    const tail = this.pieces.tail();
    return tail === undefined ? undefined : new PiecedOpened(this.pieces, this.pieces.sizeOf(tail));
  }

  append(bytes: Buffer, at?: number): void {
    const { pieces } = this;
    const { room } = pieces;
    mkdirSync(pieces.folder, { recursive: true, mode: 0o700 });
    this.sweep();
    const tail = pieces.tail();
    const size = tail === undefined ? 0 : pieces.sizeOf(tail);
    const from = at ?? size;
    if (!Number.isSafeInteger(from) || from < 0) throw new Error(`a grown file is written from a byte within it or past its end, not ${from}`);
    const first = tail === undefined ? 0 : Math.min(Math.floor(from / room), tail.count - 1);
    const before = first === 0 ? undefined : pieces.header(first - 1);
    const kept = tail === undefined ? Buffer.alloc(0) : pieces.piece(first, before).plain;
    const head = from - first * room <= kept.length ? kept.subarray(0, from - first * room) : Buffer.concat([kept, Buffer.alloc(from - first * room - kept.length)]);
    const whole = Buffer.concat([head, bytes]);
    if (whole.length >= room && (tail === undefined || first < tail.count - 1)) pieces.lay(first, before, tail === undefined ? Buffer.alloc(0) : head);
    pieces.lay(first, before, whole);
    pieces.dropAfter(first + Math.floor(whole.length / room));
  }

  write(chunks: Iterable<Buffer>): void {
    const { pieces } = this;
    rmSync(pieces.folder, { recursive: true, force: true });
    mkdirSync(pieces.folder, { recursive: true, mode: 0o700 });
    const held = Buffer.alloc(pieces.room);
    let index = 0;
    let filled = 0;
    let before: Buffer | undefined;
    for (const chunk of chunks) {
      for (let at = 0; at < chunk.length;) {
        const took = chunk.copy(held, filled, at);
        filled += took;
        at += took;
        if (filled < pieces.room) continue;
        before = pieces.put(index, before, held);
        index += 1;
        filled = 0;
      }
    }
    pieces.put(index, before, held.subarray(0, filled));
    flush(pieces.folder);
  }

  remove(): boolean {
    if (statSync(this.pieces.folder, { throwIfNoEntry: false }) === undefined) return false;
    rmSync(this.pieces.folder, { recursive: true, force: true });
    return true;
  }
}

class PiecedOpened implements OpenedFile {
  readonly #headers = new Map<number, Buffer>();
  #held: { index: number; plain: Buffer } | undefined;

  constructor(
    private readonly pieces: Pieces,
    readonly size: number,
  ) {}

  read(into: Buffer, at: number): number {
    let copied = 0;
    for (const part of this.#range(at, at + into.length)) copied += part.copy(into, copied);
    return copied;
  }

  close(): void {
    this.#held = undefined;
  }

  *#range(start: number, end: number): Generator<Buffer> {
    const [from, to] = clampedTo(this.size, { start, end });
    const { room } = this.pieces;
    for (let index = Math.floor(from / room); index * room < to; index += 1) {
      const plain = this.#plain(index);
      yield plain.subarray(Math.max(from - index * room, 0), Math.min(to - index * room, plain.length));
    }
  }

  #plain(index: number): Buffer {
    if (this.#held?.index === index) return this.#held.plain;
    const before = index === 0 ? undefined : this.#headers.get(index - 1) ?? this.pieces.header(index - 1);
    const { header, plain } = this.pieces.piece(index, before);
    this.#headers.set(index, header);
    this.#held = { index, plain };
    return plain;
  }
}

class PlainOpened implements OpenedFile {
  #size: number | undefined;

  constructor(private readonly fd: number) {}

  get size(): number {
    this.#size ??= fstatSync(this.fd).size;
    return this.#size;
  }

  read(into: Buffer, at: number): number {
    return readSync(this.fd, into, 0, into.length, at);
  }

  close(): void {
    closeSync(this.fd);
  }
}

class SealedOpened implements OpenedFile {
  constructor(
    private readonly reader: SealedReader,
    readonly size: number,
  ) {}

  read(into: Buffer, at: number): number {
    let copied = 0;
    for (const part of this.reader.range(...clampedTo(this.size, { start: at, end: at + into.length }))) copied += part.copy(into, copied);
    return copied;
  }

  close(): void {
    this.reader.close();
  }
}


function clampedTo(length: number, range: { start: number; end: number }): [start: number, end: number] {
  const end = Math.min(Math.max(range.end, 0), length);
  return [Math.min(Math.max(range.start, 0), end), end];
}

function handleReading(handle: FileHandle, range?: { start: number; end: number }): Readable {
  if (range === undefined) return handle.createReadStream({ autoClose: false });
  if (range.end <= range.start) return Readable.from([]);
  return handle.createReadStream({ autoClose: false, start: range.start, end: range.end - 1 });
}

function cacheTemporary(path: string): string {
  const name = basename(path);
  const dot = name.indexOf(".");
  const [stem, rest] = dot === -1 ? [name, ""] : [name.slice(0, dot), name.slice(dot)];
  return join(dirname(path), `.${stem}.${randomBytes(6).toString("hex")}${rest}`);
}

function emptied(path: string): Work {
  return { path, empty: () => rmSync(path, { recursive: true, force: true }) };
}

function touched(path: string, at_ms: number): void {
  const at = new Date(at_ms);
  utimesSync(path, at, at);
}

function gone(path: string): never {
  throw Object.assign(new Error(`ENOENT: ${path} is gone`), { code: "ENOENT" });
}

function absentAs<T, A>(read: () => T, absent: A): T | A {
  try {
    return read();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return absent;
    throw error;
  }
}

async function absentAsync<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function removed(path: string): boolean {
  return absentAs(() => {
    rmSync(path);
    return true;
  }, false);
}

function namesIn(directory: string): string[] {
  return absentAs(() => readdirSync(directory), []);
}

function namesReadable(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch (error) {
    if (["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return [];
    throw error;
  }
}

function storeLabel(role: string): KeyLabel {
  return `store:${role}`;
}

function vaultHoldsKeys(root: string): boolean {
  try {
    const vault = JSON.parse(readFileSync(join(root, VAULT), "utf8")) as { keys?: unknown } | null;
    return Array.isArray(vault?.keys) && vault.keys.some((key) => (key as { kind?: unknown } | null)?.kind === "data");
  } catch {
    return false;
  }
}

const headers = new Map<string, boolean>();

function headerJudged(root: string): boolean {
  if (!isMainThread) return false;
  const path = resolve(root, HOME);
  const judged = headers.get(path) ?? headerless(path);
  headers.set(path, judged);
  return judged;
}

function headerless(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  try {
    const head = Buffer.alloc(PLAIN_HEADER.length);
    return readSync(fd, head, 0, head.length, 0) === head.length && !head.equals(PLAIN_HEADER);
  } finally {
    closeSync(fd);
  }
}

function keyedNames(root: string): boolean {
  if (BLOB_TREES.some((tree) => existsSync(join(root, tree)))) return true;
  for (const name of namesIn(root)) {
    if (KEYED_NAME.test(name)) return true;
    if (name === "blobs" || name.startsWith(".")) continue;
    const path = join(root, name);
    if (statSync(path, { throwIfNoEntry: false })?.isDirectory() === true && namesReadable(path).some((inner) => KEYED_NAME.test(inner))) return true;
  }
  return false;
}

function readStamp(root: string): Record<string, unknown> | null {
  try {
    const read = JSON.parse(readFileSync(join(root, STAMP), "utf8")) as unknown;
    return typeof read === "object" && read !== null && !Array.isArray(read) ? read as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function writeStamp(root: string, file: string, version: number, vault: string | undefined): void {
  const path = join(root, STAMP);
  makeUnder(root, dirname(path));
  const kept = readStamp(root);
  const key_id = vault ?? kept?.key_id;
  writeDurably(path, `${JSON.stringify({ ...kept, ...(key_id === undefined ? {} : { key_id }), [file]: version })}\n`);
}

let cipher: typeof Database | undefined;

function loadCipher(): typeof Database {
  if (cipher === undefined) {
    cipher = createRequire(import.meta.url)(CIPHER_PACKAGE) as typeof Database;
    cipherLoaded();
  }
  return cipher;
}

function probeCipher(): void {
  const Engine = loadCipher();
  const folder = mkdtempSync(join(tmpdir(), "lifestream-cipher-"));
  const path = join(folder, "probe.db");
  const key = `key = "x'${randomBytes(32).toString("hex")}'"`;
  const keyed = () => {
    const db = new Engine(path);
    keyedCipher(db);
    db.pragma(key);
    return db;
  };
  try {
    const made = keyed();
    try {
      made.exec("CREATE TABLE probe (a INTEGER); INSERT INTO probe VALUES (1)");
    } finally {
      made.close();
    }
    if (plainHeader(path)) throw new Error("the cipher engine wrote a plain store under a key");
    const read = keyed();
    try {
      if (read.prepare("SELECT a FROM probe").pluck().get() !== 1) throw new Error("the cipher engine did not read back what it wrote");
    } finally {
      read.close();
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

function onDisk(path: string): boolean {
  return path !== "" && path !== ":memory:";
}

function openPlain(path: string, open: StoreOpen, ephemeral = false): Database.Database {
  const timeout = open.timeout ?? BUSY_TIMEOUT_MS;
  const db = open.mode === "read"
    ? new Database(path, { readonly: true, fileMustExist: open.mustExist ?? true, timeout })
    : writablePlain(path, open, timeout, ephemeral);
  try {
    if (open.mapped !== undefined) db.pragma(`mmap_size = ${open.mapped}`);
    if (open.sorts === "memory") db.pragma("temp_store = MEMORY");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function writablePlain(path: string, open: StoreOpen, timeout: number, ephemeral = false): Database.Database {
  if (onDisk(path) && !path.startsWith("file:")) ownStore(path, open.mustExist !== true);
  const db = new Database(path, { fileMustExist: open.mustExist ?? false, timeout });
  try {
    logged(db, open, ephemeral);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function openKeyed(path: string, key: Buffer, open: StoreOpen): Database.Database {
  const readonly = open.mode === "read";
  if (!readonly && !path.startsWith("file:")) ownStore(path, open.mustExist !== true);
  const Engine = loadCipher();
  const db = new Engine(path, { readonly, fileMustExist: open.mustExist ?? readonly, timeout: open.timeout ?? BUSY_TIMEOUT_MS });
  try {
    keyedCipher(db);
    db.pragma(`key = "x'${key.toString("hex")}'"`);
    if (!readonly) db.pragma("page_size = 4096");
    db.pragma("temp_store = FILE");
    db.pragma("mmap_size = 0");
    db.pragma(`cache_size = -${KEYED_CACHE_KB}`);
    db.prepare("SELECT count(*) FROM sqlite_schema").get();
    if (!readonly) logged(db, open);
    return db;
  } catch (error) {
    db.close();
    throw error;
  } finally {
    key.fill(0);
  }
}

function keyedCipher(db: Database.Database): void {
  db.pragma(`cipher = '${KEYED_CIPHER.cipher}'`);
  db.pragma(`algorithm = '${KEYED_CIPHER.algorithm}'`);
}

function logged(db: Database.Database, open: StoreOpen, ephemeral = false): void {
  if (ephemeral) {
    if (open.keepJournal !== true) db.pragma("journal_mode = WAL");
    db.pragma("synchronous = OFF");
    db.pragma("secure_delete = FAST");
    return;
  }
  db.pragma("fullfsync = ON");
  db.pragma("checkpoint_fullfsync = ON");
  if (open.keepJournal !== true) db.pragma("journal_mode = WAL");
  db.pragma(`synchronous = ${open.sync ?? "FULL"}`);
  db.pragma("secure_delete = FAST");
}

function plainHeader(path: string): boolean {
  const head = Buffer.alloc(PLAIN_HEADER.length);
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return false;
  }
  try {
    return readSync(fd, head, 0, head.length, 0) === head.length && head.equals(PLAIN_HEADER);
  } finally {
    closeSync(fd);
  }
}

function removeStore(path: string): void {
  for (const end of STORE_FILES) rmSync(`${path}${end}`, { force: true });
}

function ownStore(path: string, make: boolean): void {
  if (make) {
    try {
      closeSync(openSync(path, "wx", 0o600));
    } catch {
    }
  }
  for (const end of STORE_FILES) {
    try {
      if ((statSync(`${path}${end}`).mode & 0o077) !== 0) chmodSync(`${path}${end}`, 0o600);
    } catch {
    }
  }
}
