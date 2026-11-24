import { chmodSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, type Stats } from "node:fs";
import { open } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type Database from "better-sqlite3";
import { fits, flush, freeOf, isObject, isSqliteError, lineOf, makeUnder, tryLock, writeDurably, type FileLock, type HomeFolder } from "@lifestreamprotocol/core";
import { holdCalls } from "@lifestreamprotocol/model";
import { failpoint } from "./failpoint.js";
import { holdLine } from "./hold.js";
import { rootFiles, type RootFile } from "./home-file.js";
import { folderHere, HOME_FILE, homeSocket, LifecycleError, nearestExisting, notBuiltKeyed, placeRefusal, readHome, realPath, sameHome, standing, STOP_LOCK } from "./lifecycle.js";
import { machine, pointAt, pointedAt, type Machine } from "./machine.js";
import { ask, NoHomeError } from "./socket.js";
import { CLI } from "./cli-name.js";
import { DOOR_LOCK } from "./erasable-streams.js";


const LOCKS = new Set(["home.lock", "home.lock-journal", "stop.lock", "stop.lock-journal", "replies/calls.lock", "replies/calls.lock-journal", DOOR_LOCK, `${DOOR_LOCK}-journal`]);

const LEFT_OUT = new Set([
  "home.lock", "home.lock-journal",
  "stop.lock", "stop.lock-journal",
  "home.db-wal", "home.db-shm", "replies/replies.db-wal", "replies/replies.db-shm",
  "replies/calls.lock", "replies/calls.lock-journal",
  "door",
]);
const NAMING = ".HOME.json.moving";
const EMPTY = new Set([".DS_Store", NAMING]);
const MOVED_DIRECTORY = "moved";
const WAIT_MS = 500;
const ASK_MS = 10_000;
const PROGRESS_MS = 10_000;
const FLIGHT = 16;
const CHUNK = 4 << 20;

export interface MoveOptions {
  machine?: Machine;
  now?: () => number;
  out?: (line: string) => void;
  fileSystem?: (path: string) => string | null;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
}

export interface Moved {
  folder: string;
  from: string;
  id: string;
  files: number;
  bytes: number;
  removed: number;
}

interface Entry {
  path: string;
  stat: Stats;
}

export async function move(path: string, options: MoveOptions = {}): Promise<Moved> {
  const at = options.machine ?? machine();
  const now = options.now ?? Date.now;
  const out = options.out ?? (() => {});
  const pointed = at.home ?? fail(`this machine holds no home to move: ${CLI} adopt <folder> makes one`);
  const found = standing(pointed, at);
  if (!("folder" in found)) fail("away" in found ? found.away : found.refused);
  if (found.hold !== null) fail(holdLine(found.hold, found.folder));
  const source = realPath(found.folder);
  notBuiltKeyed(source, "move");
  const { id } = found.home;
  const target = realPath(resolve(path));
  if (target === source) fail(`Lifestream is at ${target} already`);
  const refused = placeRefusal(target, at, options.fileSystem, options.platform);
  if (refused !== null) fail(refused);
  const inside = (folder: string, of: string) => folder.startsWith(`${of}${sep}`);
  if (inside(target, source) || inside(source, target)) fail(`${target} and Lifestream's folder ${source} are one inside the other: choose a folder of its own`);
  targetRefusal(target, source);
  out(`looking at what ${source} holds`);
  const bytes = walk(source).files.reduce((sum, file) => sum + file.stat.size, 0);
  const free = freeOf(nearestExisting(target));
  if (!fits(free, "later", bytes)) {
    fail(`${target} is on a disk with ${free === null ? "free space that cannot be read" : `${gb(free)} free`}; the move needs ${gb(bytes + lineOf("later"))}: the ${gb(bytes)} it copies and the 5 GB every disk keeps free`);
  }
  out(`moving ${source} to ${target}: ${gb(bytes)}`);
  out("Lifestream stops until the copy is done; devices keep what they hold meanwhile");

  let locks: { release(): void };
  try {
    locks = await quiet(source, { out, machine: at, ...(options.signal === undefined ? {} : { signal: options.signal }) });
  } catch (error) {
    return fail(`${(error as Error).message}. Nothing changed: Lifestream stays at ${source}`);
  }
  let switched = false;
  let intake: FileLock | undefined;
  try {
    const pointing = pointedAt(at);
    if (pointing === null || realPath(pointing) !== source) fail(`Lifestream moved to ${pointing ?? "no folder"}`);
    const folder = folderHere(source);
    for (const file of Object.values(rootFiles(source))) await checkpoint(folder, file, out, options.signal);
    out(`listing what ${source} holds, Lifestream stopped`);
    const { files, dirs } = walk(source);
    mkdirSync(target, { recursive: true });
    chmodSync(target, lstatSync(source).mode & 0o7777);
    if (existsSync(join(target, "replies"))) {
      intake = await holdCalls(join(target, "replies", "replies.db"), {
        ...(options.signal === undefined ? {} : { signal: options.signal }), waiting: () => out(`waiting for a delivery to ${target} to end`),
      });
    }
    const copy = new Copy(source, target, files, out, now, options.signal);
    await copy.one(files.find((file) => file.path === HOME_FILE)!, NAMING);
    const removed = prune(target, files, dirs);
    for (const dir of dirs) {
      mkdirSync(join(target, dir.path), { recursive: true });
      chmodSync(join(target, dir.path), dir.stat.mode & 0o7777);
    }
    await copy.all();
    out(`flushing ${target} to its disk`);
    for (const dir of [target, dirname(target)]) flush(dir);
    const total = files.reduce((sum, file) => sum + file.stat.size, 0);
    mkdirSync(join(at.dir, MOVED_DIRECTORY), { recursive: true });
    writeDurably(join(at.dir, MOVED_DIRECTORY, `${id}.json`), `${JSON.stringify({ from: source, to: target, bytes: total })}\n`);
    stopped(options.signal);
    pointAt(at, target);
    switched = true;
    failpoint("move.pointed");
    out(`Lifestream is at ${target}; ${source} stays, its only second copy until a backup exists, until you delete it`);
    return { folder: target, from: source, id, files: files.length, bytes: total, removed };
  } catch (error) {
    if (switched || pointsAt(at, target)) return fail(`Lifestream is at ${target}: ${(error as Error).message}`);
    return fail(`${(error as Error).message}. Nothing changed: Lifestream stays at ${source}; ${CLI} move ${target} copies it again`);
  } finally {
    intake?.release();
    try {
      locks.release();
    } catch (error) {
      if (!switched) throw error;
    }
  }
}

export async function quiet(root: string, options: { out?: (line: string) => void; signal?: AbortSignal; stopping?: boolean; machine?: Machine } = {}): Promise<{ release(): void }> {
  const out = options.out ?? (() => {});
  const held: FileLock[] = [];
  const free = () => {
    for (const lock of held.splice(0)) lock.release();
  };
  try {
    let intent = tryLock(join(root, STOP_LOCK));
    if (intent === null) {
      await delay(WAIT_MS);
      intent = tryLock(join(root, STOP_LOCK));
    }
    if (intent === null) fail("a move, a verb, or Lifestream starting or stopping holds Lifestream: try again once it has ended");
    held.push(intent);
    let asked = options.stopping === true;
    let said = false;
    for (;;) {
      stopped(options.signal);
      const lock = tryLock(join(root, "home.lock"));
      if (lock !== null) {
        held.push(lock);
        break;
      }
      try {
        await ask(homeSocket(root, options.machine?.dir), { verb: "stop" }, undefined, ASK_MS);
        asked = true;
      } catch (error) {
        if (!(error instanceof NoHomeError)) throw error;
        if (error.asked) asked = true;
        else if (!asked) fail("a move, a verb, or Lifestream starting or stopping holds Lifestream: try again once it has ended");
      }
      if (!said) out("waiting for Lifestream to stop");
      said = true;
      await delay(WAIT_MS);
    }
    makeUnder(root, join(root, "replies"));
    stopped(options.signal);
    try {
      held.push(await holdCalls(join(root, "replies", "replies.db"), {
        ...(options.signal === undefined ? {} : { signal: options.signal }), waiting: () => out("waiting for a model call or a delivery to end"),
      }));
    } catch (error) {
      stopped(options.signal);
      throw error;
    }
  } catch (error) {
    free();
    throw error;
  }
  return { release: free };
}

export function oldCopy(at: Machine, root: string): { path: string; bytes: number } | null {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(at.dir, MOVED_DIRECTORY, `${readHome(root).id}.json`), "utf8"));
  } catch {
    return null;
  }
  if (!isObject(value) || typeof value.from !== "string" || typeof value.bytes !== "number") return null;
  const pointing = pointedAt(at);
  if (!existsSync(value.from) || !sameHome(value.from, root) || pointing === null || realPath(pointing) === realPath(value.from)) return null;
  return { path: value.from, bytes: value.bytes };
}

function fail(message: string): never {
  throw new LifecycleError(message);
}

function stopped(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) fail("the move was stopped");
}

function targetRefusal(target: string, source: string): void {
  let names: string[];
  try {
    names = readdirSync(target).filter((name) => !EMPTY.has(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") fail(`${target} is a file: choose a folder`);
    throw error;
  }
  if (names.length === 0) return;
  let other: string;
  try {
    other = readHome(target).id;
  } catch {
    fail(`${target} holds files that are not Lifestream's: choose an empty folder`);
  }
  if (other !== readHome(source).id) fail(`${target} holds another home (${other}): choose an empty folder`);
}

function walk(root: string): { files: Entry[]; dirs: Entry[] } {
  const files: Entry[] = [];
  const dirs: Entry[] = [];
  const visit = (at: string) => {
    for (const name of readdirSync(join(root, at)).sort()) {
      const path = at === "" ? name : `${at}/${name}`;
      if (LEFT_OUT.has(path)) continue;
      let stat: Stats;
      try {
        stat = lstatSync(join(root, path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (stat.isDirectory()) {
        dirs.push({ path, stat });
        visit(path);
      } else if (stat.isFile()) files.push({ path, stat });
      else fail(`${join(root, path)} is neither a file nor a folder: Lifestream's folder holds only those (remove it, then move again)`);
    }
  };
  visit("");
  return { files, dirs };
}

function prune(target: string, files: readonly Entry[], dirs: readonly Entry[]): number {
  const kept = new Set(files.map((file) => file.path));
  const folders = new Set(dirs.map((dir) => dir.path));
  let removed = 0;
  const visit = (at: string) => {
    for (const name of readdirSync(join(target, at))) {
      const path = at === "" ? name : `${at}/${name}`;
      const stat = lstatSync(join(target, path));
      if (stat.isDirectory() && (folders.has(path) || path === dirname(DOOR_LOCK))) visit(path);
      else if (!(stat.isFile() && (kept.has(path) || LOCKS.has(path)))) {
        rmSync(join(target, path), { recursive: true, force: true });
        removed++;
      }
    }
  };
  visit("");
  return removed;
}

async function checkpoint(folder: HomeFolder, file: RootFile, out: (line: string) => void, signal: AbortSignal | undefined): Promise<void> {
  const { path } = file;
  if (!existsSync(path)) return;
  out(`writing ${basename(path)}'s write-ahead log into it`);
  for (let looks = 0; ; looks++) {
    stopped(signal);
    if (checkpointed(folder, file)) return;
    if (looks === 0) out(`waiting for a reader of ${basename(path)} to finish`);
    await delay(WAIT_MS);
  }
}

function checkpointed(folder: HomeFolder, { path, kind }: RootFile): boolean {
  let db: Database.Database | undefined;
  try {
    db = folder.store(kind, path, { mustExist: true, timeout: 0 });
    const [row] = db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
    return row?.busy === 0;
  } catch (error) {
    if (isSqliteError(error) && error.code.startsWith("SQLITE_BUSY")) return false;
    throw error;
  } finally {
    db?.close();
  }
}

function pointsAt(at: Machine, target: string): boolean {
  try {
    const pointing = pointedAt(at);
    return pointing !== null && realPath(pointing) === target;
  } catch {
    return false;
  }
}

class Copy {
  #files = 0;
  readonly #bytes: number;
  #written = 0;
  #writing: number | null = null;
  #said: number;
  #failed: { error: unknown } | undefined;
  #done = new Set<string>();

  constructor(private readonly from: string, private readonly to: string, private readonly files: readonly Entry[], private readonly out: (line: string) => void,
    private readonly now: () => number, private readonly signal: AbortSignal | undefined) {
    this.#bytes = files.reduce((sum, file) => sum + file.stat.size, 0);
    this.#said = now();
  }

  async one(entry: Entry, naming: string): Promise<void> {
    await this.#file(entry, Buffer.allocUnsafe(CHUNK), naming);
    failpoint("move.naming");
    renameSync(join(this.to, naming), join(this.to, entry.path));
    flush(this.to);
    this.#done.add(entry.path);
  }

  async all(): Promise<void> {
    const left = this.files.filter((file) => !this.#done.has(file.path));
    let next = 0;
    const worker = async () => {
      const buffer = Buffer.allocUnsafe(CHUNK);
      while (this.#failed === undefined && next < left.length) {
        try {
          await this.#file(left[next++]!, buffer);
          failpoint("move.copying");
        } catch (error) {
          this.#failed ??= { error };
        }
      }
    };
    await Promise.all(Array.from({ length: FLIGHT }, worker));
    if (this.#failed !== undefined) throw this.#failed.error;
  }

  async #file(entry: Entry, buffer: Buffer, naming?: string): Promise<void> {
    const to = join(this.to, naming ?? entry.path);
    const mode = entry.stat.mode & 0o7777;
    rmSync(to, { force: true });
    this.#writing ??= this.now();
    const output = await open(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_SYNC, mode);
    try {
      const input = await open(join(this.from, entry.path), "r");
      try {
        for (;;) {
          stopped(this.signal);
          if (this.#failed !== undefined) throw this.#failed.error;
          const { bytesRead } = await input.read(buffer, 0, CHUNK, null);
          if (bytesRead === 0) break;
          for (let written = 0; written < bytesRead;) written += (await output.write(buffer, written, bytesRead - written)).bytesWritten;
          this.#written += bytesRead;
          this.#say();
        }
      } finally {
        await input.close();
      }
    } finally {
      await output.close();
    }
    chmodSync(to, mode);
    utimesSync(to, entry.stat.atime, entry.stat.mtime);
    this.#files++;
    this.#say();
  }

  #say(): void {
    const at = this.now();
    if (at - this.#said < PROGRESS_MS) return;
    this.#said = at;
    const writing = this.#writing === null ? 0 : at - this.#writing;
    const rate = this.#written / Math.max(1, writing);
    const left = (this.#bytes - this.#written) / rate / 60_000;
    const speed = writing >= PROGRESS_MS && rate > 0 ? ` at ${Number((rate / 1_000).toPrecision(2))} MB/s: ${left < 1 ? "under a minute" : `about ${minutes(Math.ceil(left))}`} left` : "";
    this.out(`${this.#files} of ${this.files.length} files done; written ${gb(this.#written)} of ${gb(this.#bytes)}${speed}`);
  }
}

function minutes(count: number): string {
  return count === 1 ? "1 minute" : `${count} minutes`;
}

function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(bytes < 1e9 ? 3 : 1)} GB`;
}
