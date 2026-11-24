import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import fsPromises, { open } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it, onTestFinished } from "vitest";
import { openHome } from "./home-db.js";
import { cipherLoads, formOf, handedFolderIn, openHandedFolder, openHomeFolder, storeStamp, type FileKind, type GrowingKind, type HandedFolder, type StoreKind } from "./home-folder.js";
import { keyBytesOf, Keys } from "./keys.js";
import { blobSealing, HEADER_BYTES, SEGMENT, TAG_BYTES, writeSealed } from "./sealed.js";
import { keyedFolder, TEST_DATA_KEY, testMachine } from "./test/keyed.js";

const CANARY = "ZQX-folder-canary-91c2";
const PLAIN = "SQLite format 3\0";
const DAY: FileKind = { role: "day" };
const NOTES: GrowingKind = { role: "notes", grows: true };
const ROOM = SEGMENT - HEADER_BYTES - TAG_BYTES;
const ROW = 516;
const LEDGER: StoreKind = { role: "ledger", remade: false };

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "lifestream-folder-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function code(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

function everyFile(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

async function collect(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(chunk as Buffer);
  return Buffer.concat(parts);
}

type FsCall = (...args: never[]) => unknown;
type Tap = (real: FsCall) => FsCall;

function tapped<T>(taps: { readonly [name: string]: Tap }, run: () => T): T {
  const calls = fs as unknown as Record<string, FsCall>;
  const real = Object.fromEntries(Object.keys(taps).map((name) => [name, calls[name]!]));
  for (const [name, tap] of Object.entries(taps)) calls[name] = tap(real[name]!);
  syncBuiltinESMExports();
  try {
    return run();
  } finally {
    Object.assign(calls, real);
    syncBuiltinESMExports();
  }
}

function seeing(see: (args: unknown[]) => void): Tap {
  return (real) => function (this: unknown, ...args: never[]) {
    see(args);
    return real.apply(this, args);
  };
}

function diskReadsUnder<T>(roots: readonly string[], run: () => T): { touched: string[]; value: T } {
  const touched: string[] = [];
  const watch = seeing(([path]) => {
    if (typeof path === "string" && roots.some((root) => path === root || path.startsWith(`${root}${sep}`))) touched.push(path);
  });
  const value = tapped({ readFileSync: watch, readdirSync: watch, statSync: watch, lstatSync: watch, openSync: watch, existsSync: watch, accessSync: watch }, run);
  return { touched, value };
}

async function traced(root: string, run: () => Promise<unknown>): Promise<string[]> {
  const calls: string[] = [];
  const named = (at: unknown) => relative(root, String(at)).replace(/\.tmp-\d+-[0-9a-f]+$/u, ".tmp");
  const fds = new Map<number, unknown>();
  const handles = new WeakMap<object, unknown>();
  const opened = (at: unknown, flags: unknown) => {
    if (flags !== undefined && flags !== "r" && flags !== 0) calls.push(`write ${named(at)} ${String(flags)}`);
  };
  const probe = await open(root, "r");
  const handle = Object.getPrototypeOf(probe) as { sync(this: object): Promise<void> };
  await probe.close();
  const sync = fs as unknown as Record<string, FsCall>;
  const promised = fsPromises as unknown as Record<string, FsCall>;
  const real = {
    sync: Object.fromEntries(["openSync", "open", "fsyncSync", "fsync", "renameSync", "linkSync"].map((name) => [name, sync[name]!])),
    promised: Object.fromEntries(["open", "rename", "writeFile"].map((name) => [name, promised[name]!])),
    handle: handle.sync,
  };
  const call = (at: Record<string, FsCall>, name: string, ...args: unknown[]) => (at[name] as (...args: unknown[]) => unknown)(...args);
  Object.assign(sync, {
    openSync: (at: unknown, flags?: unknown, ...rest: unknown[]) => {
      const fd = call(real.sync, "openSync", at, flags, ...rest) as number;
      fds.set(fd, at);
      opened(at, flags);
      return fd;
    },
    open: (at: unknown, ...rest: unknown[]) => {
      const done = rest.pop() as (error: Error | null, fd?: number) => void;
      opened(at, rest[0]);
      return call(real.sync, "open", at, ...rest, (error: Error | null, fd?: number) => {
        if (fd !== undefined) fds.set(fd, at);
        done(error, fd);
      });
    },
    fsyncSync: (fd: number) => {
      calls.push(`fsync ${named(fds.get(fd))}`);
      return call(real.sync, "fsyncSync", fd);
    },
    fsync: (fd: number, done: unknown) => {
      calls.push(`fsync ${named(fds.get(fd))}`);
      return call(real.sync, "fsync", fd, done);
    },
    renameSync: (from: unknown, to: unknown) => {
      calls.push(`rename ${named(from)} ${named(to)}`);
      return call(real.sync, "renameSync", from, to);
    },
    linkSync: (from: unknown, to: unknown) => {
      calls.push(`link ${named(from)} ${named(to)}`);
      return call(real.sync, "linkSync", from, to);
    },
  });
  Object.assign(promised, {
    open: async (at: unknown, flags?: unknown, ...rest: unknown[]) => {
      const opening = await (call(real.promised, "open", at, flags, ...rest) as Promise<object>);
      handles.set(opening, at);
      opened(at, flags);
      return opening;
    },
    rename: (from: unknown, to: unknown) => {
      calls.push(`rename ${named(from)} ${named(to)}`);
      return call(real.promised, "rename", from, to);
    },
    writeFile: (at: unknown, data: unknown, options?: { flag?: string }) => {
      calls.push(`write ${named(at)} ${options?.flag ?? "w"}`);
      return call(real.promised, "writeFile", at, data, options);
    },
  });
  handle.sync = function (this: object) {
    calls.push(`fsync ${named(handles.get(this))}`);
    return real.handle.call(this);
  };
  syncBuiltinESMExports();
  try {
    await run();
  } finally {
    Object.assign(sync, real.sync);
    Object.assign(promised, real.promised);
    handle.sync = real.handle;
    syncBuiltinESMExports();
  }
  return calls;
}

async function* chunksOf(...parts: string[]): AsyncIterable<Uint8Array> {
  for (const part of parts) yield Buffer.from(part);
}

describe("the home folder: each of these is impossible", () => {
  it("a test file cannot hold a plain, a keyed and a locked home at once", () => {
    const plainRoot = folder();
    const keyedRoot = folder();
    const plain = openHomeFolder(plainRoot);
    const keyed = keyedFolder(keyedRoot);
    openHome(plain, "migrate").close();
    openHome(keyed, "migrate").close();
    expect(code(() => openHomeFolder(keyedRoot))).toBe("LOCKED");
    expect([plain.form, keyed.form]).toEqual(["plain", "keyed"]);
    expect(readFileSync(join(plainRoot, "home.db")).subarray(0, 16).toString("latin1")).toBe(PLAIN);
    expect(readFileSync(join(keyedRoot, "home.db")).subarray(0, 16).toString("latin1")).not.toBe(PLAIN);
    openHome(plain, "read").close();
    openHome(keyed, "read").close();
  });

  it("a keyed folder opened with no keys opens anything, or makes a file", () => {
    const root = folder();
    const machine = join(folder(), "machine");
    keyedFolder(root, testMachine());
    rmSync(join(root, "config", "stores.json"), { force: true });
    const before = everyFile(root);
    expect(code(() => openHomeFolder(root))).toBe("LOCKED");
    expect(code(() => openHomeFolder(root, { machine, program: "home" }))).toBe("LOCKED");
    expect(everyFile(root)).toEqual(before);
    expect(existsSync(machine)).toBe(false);
  });

  it("a plain folder handed keys opens keyed, makes work folders or hands keys on", () => {
    const root = folder();
    const machine = join(folder(), "machine");
    const plain = openHomeFolder(root, { machine, program: "home", keys: Keys.derive(TEST_DATA_KEY) });
    const named = join(root, "tools", "job-work");
    expect([plain.form, plain.handOver(), plain.handOver(undefined, "call"), plain.work("job", named).path]).toEqual(["plain", { root, form: "plain" }, { root, form: "plain" }, named]);
    plain.work("job", named).empty();
    const fresh = plain.work("job");
    expect(dirname(fresh.path)).toBe(tmpdir());
    fresh.empty();
    plain.emptyWork();
    expect([existsSync(named), existsSync(fresh.path)]).toEqual([false, false]);
    openHome(plain, "migrate").close();
    expect(readFileSync(join(root, "home.db")).subarray(0, 16).toString("latin1")).toBe(PLAIN);
    expect([existsSync(machine), existsSync(join(root, "config", "stores.json"))]).toEqual([false, false]);
  });

  it("the form is read from anything but the folder's bytes", () => {
    const empty = folder();
    expect(formOf(empty)).toBe("plain");
    expect(formOf(join(empty, "absent"))).toBe("plain");

    const vaulted = folder();
    mkdirSync(join(vaulted, "config"));
    writeFileSync(join(vaulted, "config", "vault.json"), JSON.stringify({ version: 1, key_id: "0a0b0c0d", slots: [] }));
    expect(formOf(vaulted)).toBe("plain");
    writeFileSync(join(vaulted, "config", "vault.json"), JSON.stringify({ version: 2, keys: [{ kind: "data", id: 1 }] }));
    expect(formOf(vaulted)).toBe("keyed");

    const shut = folder();
    mkdirSync(join(shut, "days"));
    chmodSync(join(shut, "days"), 0o000);
    try {
      expect(formOf(shut)).toBe("plain");
    } finally {
      chmodSync(join(shut, "days"), 0o755);
    }

    const damagedVault = folder();
    openHome(openHomeFolder(damagedVault), "migrate").close();
    mkdirSync(join(damagedVault, "config"));
    writeFileSync(join(damagedVault, "config", "vault.json"), "{\"keys\": [");
    expect(formOf(damagedVault)).toBe("plain");

    const headerless = folder();
    writeFileSync(join(headerless, "home.db"), Buffer.alloc(4096, 0x5a));
    expect(formOf(headerless)).toBe("keyed");

    for (const tree of [join("blobs", "k1"), join("replies", "blobs", "k1")]) {
      const root = folder();
      mkdirSync(join(root, tree), { recursive: true });
      expect([tree, formOf(root)]).toEqual([tree, "keyed"]);
    }

    const sealedName = folder();
    mkdirSync(join(sealedName, "days"));
    writeFileSync(join(sealedName, "days", "2026-11-14.day.txt.k1"), "sealed");
    expect(formOf(sealedName)).toBe("keyed");
  });

  it("a thread opens a folder it was not handed, or any file of it, or the main thread reads home.db's header twice", async () => {
    const root = folder();
    const held = openHome(openHomeFolder(root), "migrate");
    try {
      const seen = await new Promise<{ refused?: string; opened: string[] }>((resolve, reject) => {
        const worker = new Worker(new URL("./test/folder-worker.ts", import.meta.url), { execArgv: ["--import", "tsx"], workerData: { root } });
        worker.once("message", resolve);
        worker.once("error", reject);
      });
      expect(seen).toEqual({ refused: expect.stringContaining("a thread opens only the folder it was handed"), opened: [] });
    } finally {
      held.close();
    }
    writeFileSync(join(root, "home.db"), Buffer.alloc(4096, 0x5a));
    expect([formOf(root), openHomeFolder(root).form]).toEqual(["plain", "plain"]);
  });

  it("a folder judged before its home.db exists reads that header later, or misses a vault.json that says keyed", () => {
    const root = folder();
    expect(formOf(root)).toBe("plain");
    writeFileSync(join(root, "home.db"), Buffer.alloc(4096, 0x5a));
    expect(formOf(root)).toBe("plain");
    mkdirSync(join(root, "config"));
    writeFileSync(join(root, "config", "vault.json"), JSON.stringify({ version: 2, keys: [{ kind: "data", id: 1, wrapped: "AA==" }] }));
    expect(formOf(root)).toBe("keyed");
  });

  it("a child told its form judges it from the disk, or a told plain child opens keyed", async () => {
    const root = folder();
    const keyed = keyedFolder(root);
    openHome(keyed, "migrate").close();
    rmSync(join(root, "config", "vault.json"));
    expect(openHandedFolder(keyed.handOver()).form).toBe("keyed");
    openHome(openHandedFolder(handedFolderIn(JSON.stringify(keyed.handOver()))), "read").close();
    const plain = folder();
    openHome(openHomeFolder(plain), "migrate").close();
    const seen = await new Promise<{ form: string; opened: string[] }>((resolve, reject) => {
      const worker = new Worker(new URL("./test/folder-worker.ts", import.meta.url), { execArgv: ["--import", "tsx"], workerData: { root: plain, handed: { root: plain, form: "plain" } satisfies HandedFolder } });
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    expect(seen).toEqual({ form: "plain", opened: [join(plain, "control.db")] });
  });

  it("the stamp is read with a key, or answers the vault key's id otherwise than beside the versions", () => {
    const root = folder();
    expect(storeStamp(root)).toBeNull();
    mkdirSync(join(root, "config"));
    writeFileSync(join(root, "config", "stores.json"), JSON.stringify({ key_id: "0a0b0c0d", "home.db": 35, "replies.db": 12, odd: "x", below: -1 }));
    expect(storeStamp(root)).toEqual({ key_id: "0a0b0c0d", versions: { "home.db": 35, "replies.db": 12 } });
    writeFileSync(join(root, "config", "stores.json"), JSON.stringify({ key_id: 7, "home.db": 35 }));
    expect(storeStamp(root)).toEqual({ key_id: null, versions: { "home.db": 35 } });
    writeFileSync(join(root, "config", "stores.json"), "{");
    expect(storeStamp(root)).toBeNull();
  });

  it("a kept file of a keyed folder holds a canary, shows its .k1 name to a walk, or reads back otherwise than written", async () => {
    const root = folder();
    const keyed = keyedFolder(root);
    const days = join(root, "days");
    const path = join(days, "2026-11-14.day.txt");
    const file = keyed.file(DAY, path);
    expect(file.read()).toBeUndefined();
    file.write(Buffer.from(`a day ${CANARY}`));
    expect(readdirSync(days)).toEqual(["2026-11-14.day.txt.k1"]);
    expect(keyed.names(days)).toEqual(["2026-11-14.day.txt"]);
    expect(everyFile(root).some((each) => readFileSync(each).includes(CANARY))).toBe(false);
    expect(file.read()?.toString()).toBe(`a day ${CANARY}`);
    expect((await collect(file.reading({ start: 2, end: 5 }))).toString()).toBe("day");
    expect(statSync(join(days, "2026-11-14.day.txt.k1")).mode & 0o777).toBe(0o600);

    const streamed = keyed.file(DAY, join(days, "2026-11-15.day.txt"));
    expect(await streamed.writing(chunksOf("first ", CANARY, " last"))).toBeGreaterThan(0);
    expect((await collect(streamed.reading())).toString()).toBe(`first ${CANARY} last`);
    expect(keyed.names(days).sort()).toEqual(["2026-11-14.day.txt", "2026-11-15.day.txt"]);
    expect(everyFile(root).some((each) => readFileSync(each).includes(CANARY))).toBe(false);

    const later = join(root, "later");
    mkdirSync(later);
    writeFileSync(join(later, `.tmp-${spawnSync(process.execPath, ["-e", ""]).pid}-${"0f".repeat(12)}`), "left by a dead writer");
    keyed.file(DAY, join(later, ".tmp-export", "member.txt")).write(Buffer.from("a delivered member"));
    keyed.file(DAY, join(later, "2026-11-16.day.txt")).write(Buffer.from("third"));
    expect(readdirSync(later).sort()).toEqual([".tmp-export", "2026-11-16.day.txt.k1"]);
    expect(keyed.names(later).sort()).toEqual([".tmp-export", "2026-11-16.day.txt"]);
    expect(keyed.file(DAY, join(later, ".tmp-export", "member.txt")).read()?.toString()).toBe("a delivered member");

    expect([file.remove(), file.remove(), file.read()]).toEqual([true, false, undefined]);
    expect(keyed.names(join(root, "absent"))).toEqual([]);
    const moved = keyed.file({ role: "other" }, join(days, "2026-11-15.day.txt"));
    expect(() => moved.read()).toThrow(expect.objectContaining({ name: "SealedError" }));
  });

  it("a kept file of a plain folder is anything but today's bytes under today's name", async () => {
    const root = folder();
    const plain = openHomeFolder(root);
    const path = join(root, "days", "2026-11-14.day.txt");
    const file = plain.file(DAY, path);
    expect(file.path).toBe(path);
    file.write(Buffer.from(`a day ${CANARY}`));
    expect(readFileSync(path).toString()).toBe(`a day ${CANARY}`);
    expect(plain.names(join(root, "days"))).toEqual(["2026-11-14.day.txt"]);
    expect((await collect(file.reading({ start: 2, end: 5 }))).toString()).toBe("day");
    expect((await collect(file.reading({ start: 5, end: 5 }))).length).toBe(0);
    const streamed = plain.file(DAY, join(root, "days", "2026-11-15.day.txt"));
    expect(await streamed.writing(chunksOf("one ", "two"))).toBe(7);
    expect(readFileSync(join(root, "days", "2026-11-15.day.txt"), "utf8")).toBe("one two");
    expect([file.remove(), file.remove(), file.read()]).toEqual([true, false, undefined]);
  });

  it("a file kept only sealed is there on a plain folder, or is not the keyed folder's own sealed file", () => {
    const root = folder();
    const path = join(root, "config", "settings-sealed.json");
    expect(openHomeFolder(root).sealedFile(DAY, path)).toBeUndefined();
    expect(existsSync(join(root, "config"))).toBe(false);
    const keyed = keyedFolder(folder());
    const at = join(keyed.root, "config", "settings-sealed.json");
    keyed.sealedFile(DAY, at)!.write(Buffer.from(CANARY));
    expect(keyed.file(DAY, at).read()?.toString()).toBe(CANARY);
    expect(existsSync(`${at}.k1`)).toBe(true);
  });

  it("a staged file shows before its commit, a discarded stage leaves a file, or a plain stage's names, bytes and mode are not today's", () => {
    const root = folder();
    const plain = openHomeFolder(root);
    const days = join(root, "days");
    const staged = plain.file(DAY, join(days, "2026-11-14.day.json")).stage(Buffer.from(`{"day": "${CANARY}"}`));
    expect(structuredClone(staged)).toEqual(staged);
    expect(readdirSync(days)).toEqual([expect.stringMatching(/^\.2026-11-14\.day\.json\.[0-9a-f-]{36}\.tmp$/u)]);
    expect(plain.names(days).filter((name) => !name.startsWith("."))).toEqual([]);
    plain.commit([staged]);
    expect(readdirSync(days)).toEqual(["2026-11-14.day.json"]);
    expect(readFileSync(join(days, "2026-11-14.day.json"), "utf8")).toBe(`{"day": "${CANARY}"}`);
    expect(statSync(join(days, "2026-11-14.day.json")).mode & 0o777).toBe(0o666 & ~process.umask());
    plain.discard([plain.file(DAY, join(days, "2026-11-15.day.json")).stage(Buffer.from("dropped"))]);
    expect(readdirSync(days)).toEqual(["2026-11-14.day.json"]);

    const keyedRoot = folder();
    const keyed = keyedFolder(keyedRoot);
    const sealedDays = join(keyedRoot, "days");
    const sealed = keyed.file(DAY, join(sealedDays, "2026-11-14.day.json")).stage(Buffer.from(CANARY));
    expect(keyed.names(sealedDays)).toEqual([]);
    keyed.discard([keyed.file(DAY, join(sealedDays, "2026-11-15.day.json")).stage(Buffer.from(CANARY))]);
    keyed.commit([structuredClone(sealed)]);
    expect(readdirSync(sealedDays)).toEqual(["2026-11-14.day.json.k1"]);
    expect(keyed.file(DAY, join(sealedDays, "2026-11-14.day.json")).read()?.toString()).toBe(CANARY);
    expect(everyFile(keyedRoot).some((each) => readFileSync(each).includes(CANARY))).toBe(false);
  });

  it("a range past the end serves otherwise from a plain and a keyed file, a keyed range throws where a plain one serves, or an opened file reads past its end", async () => {
    const plainRoot = folder();
    const keyedRoot = folder();
    const bytes = Buffer.alloc(200_000);
    for (let at = 0; at < bytes.length; at++) bytes[at] = at % 251;
    const files = [openHomeFolder(plainRoot), keyedFolder(keyedRoot)].map((each) => {
      const file = each.file(DAY, join(each.root, "days", "2026-11-14.day.json"));
      file.write(bytes);
      return file;
    });
    const length = bytes.length;
    const ranges = [{ start: 0, end: length + 100 }, { start: length - 10, end: length + 50 }, { start: length + 5, end: length + 10 }, { start: 10, end: 5 }, { start: 70_000, end: 140_000 }];
    for (const range of ranges) {
      const want = bytes.subarray(Math.min(range.start, length), Math.max(Math.min(range.end, length), Math.min(range.start, length)));
      for (const file of files) {
        expect((await collect(file.reading(range))).equals(want), `${file.path} ${range.start}..${range.end}`).toBe(true);
      }
    }
    for (const file of files) {
      const opened = file.opened()!;
      try {
        expect(opened.size).toBe(length);
        const head = Buffer.alloc(1_000);
        expect([opened.read(head, length - 400), head.subarray(0, 400).equals(bytes.subarray(length - 400))]).toEqual([400, true]);
        expect(opened.read(head, length + 1)).toBe(0);
      } finally {
        opened.close();
      }
    }
    expect(openHomeFolder(plainRoot).file(DAY, join(plainRoot, "days", "absent")).opened()).toBeUndefined();
    expect(keyedFolder(keyedRoot).file(DAY, join(keyedRoot, "days", "absent")).opened()).toBeUndefined();
  });

  it("an open that blocks the loop, a size other than the plain length, or a range otherwise than the file's, from either form", async () => {
    const plainRoot = folder();
    const keyedRoot = folder();
    const bytes = Buffer.alloc(200_000);
    for (let at = 0; at < bytes.length; at++) bytes[at] = at % 251;
    const length = bytes.length;
    for (const each of [openHomeFolder(plainRoot), keyedFolder(keyedRoot)]) {
      const file = each.file(DAY, join(each.root, "days", "2026-11-14.day.json"));
      file.write(bytes);
      expect(file.stat()?.size).toBe(length);
      for (const range of [{ start: 0, end: length + 100 }, { start: length + 5, end: length + 10 }, { start: 10, end: 5 }, { start: 70_000, end: 140_000 }]) {
        const want = bytes.subarray(Math.min(range.start, length), Math.max(Math.min(range.end, length), Math.min(range.start, length)));
        const opened = (await file.open())!;
        try {
          expect((await collect(opened.reading(range))).equals(want), `${each.form} ${range.start}..${range.end}`).toBe(true);
        } finally {
          await opened.close();
        }
      }
      const opened = (await file.open())!;
      try {
        expect(opened.size).toBe(length);
        let chunks = 0;
        for await (const chunk of opened.reading()) chunks += (chunk as Buffer).length > 0 ? 1 : 0;
        expect(chunks).toBeGreaterThan(1);
      } finally {
        await opened.close();
      }
      expect(await each.file(DAY, join(each.root, "days", "absent")).open()).toBeUndefined();
      expect(each.file(DAY, join(each.root, "days", "absent")).stat()).toBeUndefined();
    }
  });

  it("an open of a kept file whose disk does not answer stops the loop, on either form", async () => {
    for (const each of [openHomeFolder(folder()), keyedFolder(folder())]) {
      const file = each.file(DAY, join(each.root, "days", "2026-11-14.day.json"));
      file.write(Buffer.from(CANARY));
      const disk = readdirSync(join(each.root, "days")).map((name) => join(each.root, "days", name))[0]!;
      rmSync(disk);
      execFileSync("mkfifo", [disk]);
      const opening = file.open().then((opened) => opened?.close(), () => undefined);
      await new Promise((resolve) => setImmediate(resolve));
      const writer = await open(disk, "w");
      await writer.close();
      await opening;
    }
  });

  it("a touch that leaves the time it names, on either form", () => {
    for (const each of [openHomeFolder(folder()), keyedFolder(folder())]) {
      const file = each.file(DAY, join(each.root, "days", "2026-11-14.day.json"));
      file.write(Buffer.from(CANARY));
      file.touch(1_700_000_000_000);
      expect(file.stat()).toEqual({ size: CANARY.length, modified_ms: 1_700_000_000_000, links: 1 });
    }
  });

  it("a sealed file moved to another place of the same name reads, in the machine folder or the home", () => {
    const machine = testMachine();
    const root = folder();
    const keyed = keyedFolder(root, machine);
    const cache = join(machine, `pictures-${randomBytes(4).toString("hex")}`);
    onTestFinished(() => rmSync(cache, { recursive: true, force: true }));
    const hex = "ab".repeat(32);
    const tile = keyed.file({ role: "picture" }, join(cache, "tile-1", "ab", `${hex}.jpg`));
    const full = keyed.file({ role: "picture" }, join(cache, "full-1", "ab", `${hex}.jpg`));
    tile.write(Buffer.from("a tile"));
    full.write(Buffer.from("a full picture"));
    renameSync(`${tile.path}.k1`, `${full.path}.k1`);
    expect(code(() => full.read())).toBe("SEALED_DAMAGED");
    const one = keyed.file(DAY, join(root, "days", "2026-11-14.day.txt"));
    const two = keyed.file(DAY, join(root, "days", "2026-11-15.day.txt"));
    one.write(Buffer.from("one day"));
    two.write(Buffer.from("another day"));
    renameSync(`${one.path}.k1`, `${two.path}.k1`);
    expect(code(() => two.read())).toBe("SEALED_DAMAGED");
    expect(() => keyed.file(DAY, join(folder(), "elsewhere.txt"))).toThrow(/neither in the home/u);
  });

  it("an adopted file stays behind, a plain one is copied rather than renamed, or a keyed one lands plain", async () => {
    const plainRoot = folder();
    const plain = openHomeFolder(plainRoot);
    const target = join(plainRoot, "cache", "ab", "made.jpg");
    mkdirSync(dirname(target), { recursive: true });
    const beside = join(dirname(target), ".made.jpg.0a0b0c");
    writeFileSync(beside, `made ${CANARY}`);
    const inode = statSync(beside).ino;
    await plain.file(DAY, target).adopt(beside);
    expect([existsSync(beside), statSync(target).ino, readFileSync(target, "utf8")]).toEqual([false, inode, `made ${CANARY}`]);

    const keyedRoot = folder();
    const keyed = keyedFolder(keyedRoot);
    const work = keyed.work("adopt-test");
    const copy = join(work.path, "made.jpg");
    writeFileSync(copy, `made ${CANARY}`);
    const kept = keyed.file(DAY, join(keyedRoot, "cache", "ab", "made.jpg"));
    await kept.adopt(copy);
    work.empty();
    expect([existsSync(copy), kept.stat()?.size, kept.read()?.toString()]).toEqual([false, `made ${CANARY}`.length, `made ${CANARY}`]);
    expect(everyFile(keyedRoot).some((each) => readFileSync(each).includes(CANARY))).toBe(false);
  });

  it("a blob-form file named by its blob shows its SHA-256 on a keyed folder, takes another name than the keyed store gives it, or is listed with another blob", () => {
    const bytes = Buffer.from(`a carried blob ${CANARY}`);
    const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const hex = hash.slice("sha256:".length);

    const keyedRoot = folder();
    const keyed = keyedFolder(keyedRoot);
    const lane = join(keyedRoot, "inbox", "phone:synthetic-iphone-5a49", "blobs");
    const name = basename(keyed.blobFile(lane, hash).path);
    expect(name).not.toBe(hex);
    expect(name).toMatch(/^[0-9a-f]{64}$/u);
    expect(keyed.blobFile(lane, hash, { sharded: true }).path).toBe(join(lane, name.slice(0, 2), name));
    keyed.blobFile(lane, hash).write(bytes);
    writeFileSync(join(lane, `${"ab".repeat(32)}.k1`), "not a sealed blob");
    expect(keyed.blobFiles(lane).map(({ blob, file }) => [blob, file.read()?.toString()])).toEqual([[hash, bytes.toString()]]);
    expect(readdirSync(lane).filter((each) => each.startsWith(hex))).toEqual([]);
    const store = keyed.blobs(join(keyedRoot, "blobs"));
    store.put(bytes);
    expect(everyFile(join(keyedRoot, "blobs")).map((path) => basename(path))).toEqual([name]);

    const plainRoot = folder();
    const plain = openHomeFolder(plainRoot);
    const plainLane = join(plainRoot, "inbox", "phone:synthetic-iphone-5a49", "blobs");
    expect(plain.blobFile(plainLane, hash).path).toBe(join(plainLane, hex));
    plain.blobFile(plainLane, hash).write(bytes);
    expect(plain.blobFiles(plainLane).map(({ blob }) => blob)).toEqual([hash]);
    expect(readdirSync(plainLane)).toEqual([hex]);
  });

  it("adopt seals a large made file while the thread answers others, or a plain one lands as another inode", async () => {
    const plainRoot = folder();
    const plainMade = join(plainRoot, ".made.jpg.0a0b0c");
    writeFileSync(plainMade, `made ${CANARY}`);
    const inode = statSync(plainMade).ino;
    const plainTarget = join(plainRoot, "cache", "ab", "made.jpg");
    await openHomeFolder(plainRoot).file(DAY, plainTarget).adopt(plainMade);
    expect([existsSync(plainMade), statSync(plainTarget).ino]).toEqual([false, inode]);

    const keyedRoot = folder();
    const keyed = keyedFolder(keyedRoot);
    const work = keyed.work("adopting-test");
    const made = join(work.path, "made.jpg");
    const bytes = Buffer.concat([Buffer.from(CANARY), randomBytes(8 * 1024 * 1024)]);
    writeFileSync(made, bytes);
    const kept = keyed.file(DAY, join(keyedRoot, "cache", "ab", "made.jpg"));
    let answered = 0;
    const adopting = kept.adopt(made).then(() => answered);
    const ticks = setInterval(() => { answered += 1; }, 0);
    try {
      expect(await adopting).toBeGreaterThan(0);
    } finally {
      clearInterval(ticks);
      work.empty();
    }
    expect([existsSync(made), kept.read()?.equals(bytes)]).toEqual([false, true]);
    expect(everyFile(keyedRoot).some((each) => readFileSync(each).includes(CANARY))).toBe(false);
  });

  it("a plain adopt renames a made file the disk may not hold yet, flushes a remade one, or flushes after the rename", async () => {
    const root = folder();
    const plain = openHomeFolder(root);
    const made = join(root, ".made.0a0b0c");
    writeFileSync(made, `made ${CANARY}`);
    expect(await traced(root, () => plain.file(DAY, join(root, "days", "2026-11-17.day.txt")).adopt(made))).toEqual([
      "fsync .made.0a0b0c",
      "rename .made.0a0b0c days/2026-11-17.day.txt",
    ]);
    const upload = plain.file({ role: "upload", passing: true }, join(root, "door", "uploads", "a.zip.partial"));
    await upload.writing(chunksOf("a photo"));
    expect(await traced(root, () => plain.blobFile(join(root, "inbox", "ask:local:unit-a", "blobs"), `sha256:${"ab".repeat(32)}`).adopt(upload))).toEqual([
      "fsync door/uploads/a.zip.partial",
      `rename door/uploads/a.zip.partial inbox/ask:local:unit-a/blobs/${"ab".repeat(32)}`,
    ]);
    const picture = join(root, ".picture.0a0b0c");
    writeFileSync(picture, "a tile");
    expect(await traced(root, () => plain.file({ role: "picture", remade: true }, join(root, "pictures", "tile.jpg")).adopt(picture))).toEqual([
      "rename .picture.0a0b0c pictures/tile.jpg",
    ]);
  });

  it("a plain passing file is written anywhere but straight to its name, synced or renamed, or a kept one is written otherwise than beside, synced on its one handle, then renamed", async () => {
    const root = folder();
    const plain = openHomeFolder(root);
    const path = join(root, "door", "uploads", "a.zip.partial");
    const upload = plain.file({ role: "upload", passing: true }, path);
    let written = 0;
    expect(await traced(root, async () => { written = await upload.writing(chunksOf("PK", `a bundle ${CANARY}`)); })).toEqual(["write door/uploads/a.zip.partial wx"]);
    expect([written, readFileSync(path, "utf8"), statSync(path).mode & 0o777, readdirSync(dirname(path))]).toEqual([2 + `a bundle ${CANARY}`.length, `PKa bundle ${CANARY}`, 0o666 & ~process.umask(), ["a.zip.partial"]]);
    await expect(upload.writing(chunksOf("again"))).rejects.toMatchObject({ code: "EEXIST" });
    const day = join(root, "days", "2026-11-17.day.txt");
    expect(await traced(root, () => plain.file(DAY, day).writing(chunksOf("a day")))).toEqual([
      "write days/.tmp wx",
      "fsync days/.tmp",
      "rename days/.tmp days/2026-11-17.day.txt",
    ]);
    expect([readFileSync(day, "utf8"), readdirSync(dirname(day))]).toEqual(["a day", ["2026-11-17.day.txt"]]);

    const keyedRoot = folder();
    const keyedUpload = keyedFolder(keyedRoot).file({ role: "upload", passing: true }, join(keyedRoot, "door", "uploads", "a.zip.partial"));
    await keyedUpload.writing(chunksOf(`a bundle ${CANARY}`));
    expect([keyedUpload.read()?.toString(), readdirSync(join(keyedRoot, "door", "uploads"))]).toEqual([`a bundle ${CANARY}`, ["a.zip.partial.k1"]]);
    expect(everyFile(keyedRoot).some((each) => readFileSync(each).includes(CANARY))).toBe(false);
  });

  it("a file adopts or links a file of the other form, a keyed one links a file sealed otherwise, or a gone keyed file materialises", async () => {
    const plainRoot = folder();
    const plain = openHomeFolder(plainRoot);
    const keyedRoot = folder();
    const keyed = keyedFolder(keyedRoot);
    const plainBlob = plain.blobFile(join(plainRoot, "lane"), `sha256:${"ab".repeat(32)}`);
    const keyedBlob = keyed.blobFile(join(keyedRoot, "lane"), `sha256:${"ab".repeat(32)}`);
    plainBlob.write(Buffer.from("plain"));
    keyedBlob.write(Buffer.from("keyed"));
    await expect(plain.file(DAY, join(plainRoot, "a.txt")).adopt(keyedBlob)).rejects.toThrow(/own folder/u);
    await expect(plain.blobFile(join(plainRoot, "other"), `sha256:${"ab".repeat(32)}`).link(keyedBlob)).rejects.toThrow(/own folder/u);
    await expect(keyed.file(DAY, join(keyedRoot, "a.txt")).adopt(plainBlob)).rejects.toThrow(/own folder/u);
    await expect(keyed.blobFile(join(keyedRoot, "other"), `sha256:${"ab".repeat(32)}`).link(plainBlob)).rejects.toThrow(/own folder/u);
    const day = keyed.file(DAY, join(keyedRoot, "days", "a.txt"));
    day.write(Buffer.from("a day"));
    await expect(keyed.blobFile(join(keyedRoot, "other"), `sha256:${"ab".repeat(32)}`).link(day)).rejects.toThrow(/own folder/u);
    expect([plainBlob.read()?.toString(), keyedBlob.read()?.toString(), day.read()?.toString()]).toEqual(["plain", "keyed", "a day"]);
    expect(code(() => keyed.file(DAY, join(keyedRoot, "days", "gone.txt")).materialise())).toBe("ENOENT");
  });

  it("a keyed blob shorter than its identity opens or reads by range as an empty file", async () => {
    const root = folder();
    const keyed = keyedFolder(root);
    const short = keyed.blobFile(join(root, "lane"), `sha256:${"ab".repeat(32)}`);
    mkdirSync(dirname(short.path), { recursive: true });
    await writeSealed(`${short.path}.k1`, [Buffer.from("short")], blobSealing(keyBytesOf(Keys.derive(TEST_DATA_KEY), "files")));
    expect([code(() => short.read()), code(() => short.opened())]).toEqual(["SEALED_DAMAGED", "SEALED_DAMAGED"]);
    await expect(collect(short.reading({ start: 0, end: 4 }))).rejects.toMatchObject({ code: "SEALED_DAMAGED" });
  });

  it("a materialised plain file is a copy, a keyed one lands outside scratch, holds other bytes or outlives its dispose", () => {
    const plainRoot = folder();
    const path = join(plainRoot, "stage", "photo.jpg");
    const plain = openHomeFolder(plainRoot).file(DAY, path);
    plain.write(Buffer.from(`photo ${CANARY}`));
    const own = plain.materialise();
    own.dispose();
    expect([own.path, readFileSync(path, "utf8")]).toEqual([path, `photo ${CANARY}`]);

    const keyedRoot = folder();
    const kept = keyedFolder(keyedRoot).file(DAY, join(keyedRoot, "stage", "photo.jpg"));
    kept.write(Buffer.from(`photo ${CANARY}`));
    const copy = kept.materialise();
    expect([dirname(dirname(copy.path)), copy.path.endsWith("photo.jpg"), readFileSync(copy.path, "utf8"), statSync(copy.path).mode & 0o777]).toEqual([join(testMachine(), "scratch", "home"), true, `photo ${CANARY}`, 0o600]);
    copy.dispose();
    expect(existsSync(dirname(copy.path))).toBe(false);
    expect(everyFile(keyedRoot).some((each) => readFileSync(each).includes(CANARY))).toBe(false);
  });

  it("a plain append rewrites the earlier bytes or takes another mode than today's, a keyed one loses them, or a remade write leaves a temporary", () => {
    const root = folder();
    const plain = openHomeFolder(root);
    const path = join(root, "agents", "feedback.jsonl");
    const notes = plain.file(NOTES, path);
    notes.append(Buffer.from("first\n"));
    const inode = statSync(path).ino;
    notes.append(Buffer.from("second\n"));
    expect([statSync(path).ino, readFileSync(path, "utf8"), statSync(path).mode & 0o777]).toEqual([inode, "first\nsecond\n", 0o666 & ~process.umask()]);
    const cached = plain.file({ role: "cache", remade: true }, join(root, "cache", "a.json"));
    cached.write(Buffer.from("cached"));
    expect([readdirSync(join(root, "cache")), cached.read()?.toString()]).toEqual([["a.json"], "cached"]);

    const keyedRoot = folder();
    const keyed = keyedFolder(keyedRoot);
    const sealed = keyed.file(NOTES, join(keyedRoot, "agents", "feedback.jsonl"));
    sealed.append(Buffer.from(`first ${CANARY}\n`));
    sealed.append(Buffer.from("second\n"));
    expect(sealed.read()?.toString()).toBe(`first ${CANARY}\nsecond\n`);
    expect(everyFile(keyedRoot).some((each) => readFileSync(each).includes(CANARY))).toBe(false);
  });

  it("a program handed the home's keys opens otherwise than the home, or a call process opens home.db", () => {
    const root = folder();
    const keyed = keyedFolder(root);
    openHome(keyed, "migrate").close();
    const keysOf = (handed: HandedFolder) => (handed.form === "keyed" ? handed.keys : undefined)!;
    const whole = keysOf(keyed.handOver());
    expect(Object.keys(whole).sort()).toEqual(["data", "form"]);
    const helper = openHomeFolder(root, { machine: testMachine(), program: "home", keys: Keys.read(JSON.parse(JSON.stringify(whole))) });
    openHome(helper, "read").close();
    const call = openHomeFolder(root, { machine: testMachine(), program: "call", keys: Keys.read(keysOf(keyed.handOver(["store:ledger", "files", "names"]))) });
    expect(code(() => openHome(call, "read"))).toBe("NOT_HANDED");
    call.store(LEDGER, join(root, "replies.db")).close();
    expect(cipherLoads()).toBeNull();
  });

  it("a folder handed over to a worker opens otherwise than the home it came from, a plain one hands a key, or either judges its form again from the disk", async () => {
    const root = folder();
    const keyed = keyedFolder(root);
    openHome(keyed, "migrate").close();
    const path = join(root, "notes", "a.jsonl");
    keyed.file(NOTES, path).append(Buffer.from("kept"));
    const handed = JSON.parse(JSON.stringify(keyed.handOver(["files"]))) as HandedFolder;
    expect(handed.form === "keyed" ? [handed.root, handed.machine, Object.keys(handed.keys)] : handed).toEqual([root, testMachine(), ["form", "keys"]]);
    const plainRoot = folder();
    const plainHanded = openHomeFolder(plainRoot).handOver();
    expect(plainHanded).toEqual({ root: plainRoot, form: "plain" });
    const read = await diskReadsUnder([root, plainRoot], () => [openHandedFolder(handed), openHandedFolder(plainHanded)]);
    expect(read.touched).toEqual([]);
    const [worker, plainWorker] = read.value;
    expect([worker!.form, worker!.file(NOTES, path).read()?.toString(), plainWorker!.form]).toEqual(["keyed", "kept", "plain"]);
    expect(code(() => openHome(worker!, "read"))).toBe("NOT_HANDED");
  });
});

describe("a grown file: each of these is impossible", () => {
  const rows = (from: number, count: number, mark = "") => Buffer.concat(Array.from({ length: count }, (_, at) => Buffer.from(`${mark}row ${from + at} `.padEnd(ROW, "."))));
  const pieces = (root: string, path: string) => readdirSync(`${path}.k1`).filter((name) => !name.startsWith(".")).sort((a, b) => parseInt(a) - parseInt(b));
  const disk = (path: string) => new Map(pieces("", path).map((name) => {
    const stat = statSync(join(`${path}.k1`, name));
    return [name, { ino: stat.ino, size: stat.size }] as const;
  }));
  const thrown = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      return (error as Error).name;
    }
    return undefined;
  };

  it("a keyed append row by row rewrites more than one piece, reads back otherwise than appended, or holds a canary", () => {
    const root = folder();
    const keyed = keyedFolder(root);
    const path = join(root, "grown", "a.q8");
    const file = keyed.file(NOTES, path);
    let most = 0;
    for (let at = 0; at < 300; at += 1) {
      const before = existsSync(`${path}.k1`) ? disk(path) : new Map<string, { ino: number; size: number }>();
      file.append(rows(at, 1, CANARY));
      const after = disk(path);
      const rewritten = [...after].filter(([name, now]) => before.get(name)?.ino !== now.ino);
      expect(rewritten.filter(([name]) => before.has(name)).length).toBeLessThanOrEqual(1);
      most = Math.max(most, rewritten.reduce((sum, [, now]) => sum + now.size, 0));
    }
    expect(most).toBeLessThanOrEqual(SEGMENT + ROW + HEADER_BYTES + TAG_BYTES);
    expect(pieces("", path)).toEqual(["0.k1", "1.k1", "2.k1"]);
    expect(file.read()).toEqual(rows(0, 300, CANARY));
    const opened = file.opened()!;
    const into = Buffer.alloc(3 * ROW);
    expect([opened.size, opened.read(into, 126 * ROW), into]).toEqual([300 * ROW, 3 * ROW, rows(126, 3, CANARY)]);
    expect(opened.read(Buffer.alloc(ROW), 300 * ROW)).toBe(0);
    opened.close();
    expect(everyFile(root).some((each) => readFileSync(each).includes(CANARY))).toBe(false);
    expect(keyed.names(join(root, "grown"))).toEqual(["a.q8"]);
    expect([file.remove(), file.remove(), file.read(), file.opened(), existsSync(`${path}.k1`)]).toEqual([true, false, undefined, undefined, false]);
  });

  it("a keyed append from a byte reads back otherwise than the same on a plain file, or leaves a piece past its end", () => {
    const plainRoot = folder();
    const keyedRoot = folder();
    const plain = openHomeFolder(plainRoot).file(NOTES, join(plainRoot, "a.q8"));
    const path = join(keyedRoot, "a.q8");
    const keyed = keyedFolder(keyedRoot).file(NOTES, path);
    const steps: [Buffer, number | undefined][] = [
      [rows(0, 300), undefined], [rows(0, 20, "b"), 100 * ROW], [rows(0, 200, "c"), 30 * ROW], [Buffer.alloc(0), 230 * ROW],
      [Buffer.alloc(0), 5 * ROW], [rows(0, 2, "d"), 9 * ROW], [rows(0, 1, "e"), ROOM], [rows(0, 254, "f"), 0], [Buffer.alloc(0), 2 * ROOM], [rows(0, 1, "g"), undefined],
    ];
    for (const [bytes, at] of steps) {
      plain.append(bytes, at);
      keyed.append(bytes, at);
      const read = plain.read()!;
      expect(keyed.read()).toEqual(read);
      expect(pieces("", path).length).toBe(Math.floor(read.length / ROOM) + 1);
    }
    expect(pieces("", path)).toEqual(["0.k1", "1.k1", "2.k1"]);
    expect(statSync(join(`${path}.k1`, "1.k1")).size).toBe(SEGMENT);
    expect(statSync(join(`${path}.k1`, "2.k1")).size).toBe(HEADER_BYTES + ROW + TAG_BYTES);
  });

  it("a piece moved to another file, swapped, dropped or kept from before a rewrite reads", () => {
    const root = folder();
    const keyed = keyedFolder(root);
    const made = (name: string) => {
      const path = join(root, name);
      keyed.file(NOTES, path).append(rows(0, 300, name));
      return { path, file: keyed.file(NOTES, path), piece: (index: number) => join(`${path}.k1`, `${index}.k1`) };
    };
    const reads = (file: { read(): unknown }) => thrown(() => file.read());

    const moved = made("moved");
    const other = made("other");
    renameSync(other.piece(1), moved.piece(1));
    expect(reads(moved.file)).toBe("SealedError");

    const swapped = made("swapped");
    const zero = readFileSync(swapped.piece(0));
    renameSync(swapped.piece(1), swapped.piece(0));
    writeFileSync(swapped.piece(1), zero);
    expect(reads(swapped.file)).toBe("SealedError");

    const lastDropped = made("last");
    rmSync(lastDropped.piece(2));
    expect([thrown(() => lastDropped.file.opened()), reads(lastDropped.file)]).toEqual(["SealedError", "SealedError"]);

    const middle = made("middle");
    rmSync(middle.piece(1));
    expect(reads(middle.file)).toBe("SealedError");

    const first = made("first");
    const later = [1, 2].map((index) => statSync(first.piece(index)).ino);
    rmSync(first.piece(0));
    expect([code(() => first.file.opened()), code(() => first.file.read()), code(() => first.file.append(rows(0, 1)))]).toEqual(["SEALED_DAMAGED", "SEALED_DAMAGED", "SEALED_DAMAGED"]);
    expect([pieces("", first.path), [1, 2].map((index) => statSync(first.piece(index)).ino)]).toEqual([["1.k1", "2.k1"], later]);

    const older = made("older");
    const before = readFileSync(older.piece(1));
    older.file.append(Buffer.alloc(0), 10 * ROW);
    older.file.append(rows(0, 290, "again"));
    expect(older.file.read()?.length).toBe(300 * ROW);
    writeFileSync(older.piece(1), before);
    expect(reads(older.file)).toBe("SealedError");
  });

  it("a first lay cut before its first piece reads as damage, or the next append keeps the pieces the cut left", () => {
    const root = folder();
    const path = join(root, "cut.q8");
    const file = keyedFolder(root).file(NOTES, path);
    let firsts = 0;
    const cut: Tap = (real) => function (this: unknown, ...args: never[]) {
      if (basename(String(args[1])) === "0.k1" && ++firsts === 2) throw Object.assign(new Error("the process died here"), { code: "EDIED" });
      return real.apply(this, args);
    };
    expect(code(() => tapped({ renameSync: cut }, () => file.append(rows(0, 300))))).toBe("EDIED");
    expect([pieces("", path), file.read()]).toEqual([["0.k1", "1.k1", "2.k1"], Buffer.alloc(0)]);
    file.append(rows(0, 3, "after"));
    expect([pieces("", path), file.read()]).toEqual([["0.k1"], rows(0, 3, "after")]);
  });

  it("a whole write opens, syncs or makes otherwise than today's compaction on a plain folder, or reads back otherwise than written on a keyed one", () => {
    const root = folder();
    const plain = openHomeFolder(root);
    const path = join(root, "vectors", "model", "2026-11.1.q8");
    mkdirSync(dirname(path), { recursive: true });
    const chunks = [rows(0, 100), Buffer.alloc(0), rows(100, 100)];
    const calls: string[] = [];
    const named = (at: unknown) => (at === path ? "file" : at === dirname(path) ? "folder" : String(at));
    tapped({ openSync: seeing(([at, flags]) => calls.push(`open ${named(at)} ${String(flags)}`)), fsyncSync: seeing(() => calls.push("fsync")), mkdirSync: seeing(([at]) => calls.push(`mkdir ${named(at)}`)) },
      () => plain.file(NOTES, path).write(chunks));
    expect(calls).toEqual(["open file w", "fsync", "open folder r", "fsync"]);
    expect([readFileSync(path).equals(Buffer.concat(chunks)), statSync(path).mode & 0o777]).toEqual([true, 0o666 & ~process.umask()]);
    plain.file(NOTES, path).write([]);
    expect([existsSync(path), statSync(path).size]).toEqual([true, 0]);

    const keyedRoot = folder();
    const sealedPath = join(keyedRoot, "grown", "a.q8");
    const file = keyedFolder(keyedRoot).file(NOTES, sealedPath);
    file.append(rows(0, 500));
    for (const bytes of [rows(0, 300, CANARY), Buffer.alloc(2 * ROOM, 7), Buffer.alloc(0)]) {
      file.write([bytes.subarray(0, 1_000), bytes.subarray(1_000, 1_000), bytes.subarray(1_000, ROOM + 5), bytes.subarray(ROOM + 5)]);
      expect(file.read()?.equals(bytes)).toBe(true);
      expect(pieces("", sealedPath)).toEqual(Array.from({ length: Math.floor(bytes.length / ROOM) + 1 }, (_, at) => `${at}.k1`));
      expect(everyFile(keyedRoot).some((each) => readFileSync(each).includes(CANARY))).toBe(false);
    }
  });
});

describe("work folders: each of these is impossible", () => {
  const scratch = (): string => join(testMachine(), "scratch");
  const left = (program = "home"): string[] => (existsSync(join(scratch(), program)) ? readdirSync(join(scratch(), program)).sort() : []);
  const programs = (): string[] => readdirSync(scratch()).sort();
  const threadWork = (handed: HandedFolder, job: string, plain: string) => new Promise<{ path: string; held: string[] }>((resolve, reject) => {
    const worker = new Worker(new URL("./test/folder-worker.ts", import.meta.url), { execArgv: ["--import", "tsx"], workerData: { root: handed.root, handed, work: { job, plain } } });
    worker.once("message", resolve);
    worker.once("error", reject);
  });

  it("a program's start empties another program's work, keeps a working copy of its own, takes the sorts folder, or leaves scratch open to others", () => {
    const root = folder();
    const home = keyedFolder(root);
    const door = keyedFolder(root, testMachine(), "door");
    const call = openHandedFolder(home.handOver(["files"], "call"));
    const [homeJob, doorJob, callJob] = [home.work("materialise"), door.work("ask-upload"), call.work("call", { own: join(folder(), "calls", "a") })];
    for (const job of [homeJob, doorJob, callJob]) writeFileSync(join(job.path, "copy.jpg"), "plain bytes");
    mkdirSync(join(scratch(), "home", "left-by-a-dead-job", "deep"), { recursive: true });
    home.emptyWork();
    expect([left("home"), left("door"), left("call")]).toEqual([[], [basename(doorJob.path)], [basename(callJob.path)]]);
    expect(programs()).toEqual(expect.arrayContaining(["sqlite", "door", "call"]));
    expect([statSync(scratch()).mode & 0o777, statSync(join(scratch(), "sqlite")).mode & 0o777]).toEqual([0o700, 0o700]);
    expect([dirname(homeJob.path), dirname(doorJob.path), dirname(callJob.path)]).toEqual(["home", "door", "call"].map((program) => join(scratch(), program)));
    door.emptyWork();
    home.emptyWork({ program: "call" });
    expect([left("door"), left("call")]).toEqual([[], []]);
  });

  it("a job's work emptied takes another job's work, or leaves one of its own", () => {
    const keyed = keyedFolder(folder());
    const calls = [keyed.work("call"), keyed.work("call"), keyed.work("call", join(folder(), "call-work"))];
    const others = [keyed.work("read"), keyed.work("call-a"), keyed.work("callers"), keyed.work("call.x")];
    for (const work of [...calls, ...others]) writeFileSync(join(work.path, "copy.jpg"), "plain bytes");
    expect(calls.map((work) => basename(work.path))).toEqual(calls.map(() => expect.stringMatching(/^call-.{6}$/u)));
    keyed.emptyWork({ job: "call" });
    expect(left()).toEqual(others.map((work) => basename(work.path)).sort());
    expect(statSync(scratch()).mode & 0o777).toBe(0o700);
    keyed.emptyWork();
    expect(left()).toEqual([]);
  });

  it("two threads' work at one plain place wipe each other on a keyed folder, or a job's folder there holds an earlier run's files or outlives its end", async () => {
    const root = folder();
    const keyed = keyedFolder(root);
    const plain = join(folder(), "tools", "faces-work");
    const mine = keyed.work("faces-work", plain);
    writeFileSync(join(mine.path, "scan.json"), "a scan in flight");
    const theirs = await threadWork(keyed.handOver(), "faces-work", plain);
    expect([readdirSync(mine.path), theirs.held, theirs.path === mine.path, dirname(theirs.path)]).toEqual([["scan.json"], ["thread.txt"], false, join(scratch(), "home")]);
    expect([statSync(mine.path).mode & 0o777, basename(mine.path).startsWith("faces-work-")]).toEqual([0o700, true]);
    mine.empty();
    expect([existsSync(mine.path), existsSync(theirs.path), existsSync(plain)]).toEqual([false, true, false]);
    keyed.emptyWork({ job: "faces-work" });
    expect(left()).toEqual([]);
    for (const name of ["", "..", "../home", "a/b", "Upper"]) expect(() => keyed.work(name)).toThrow();
    expect(() => keyedFolder(root, testMachine(), "ask" as never)).toThrow("scratch holds a folder for each of home, door, call");
  });

  it("a plain home's work lies elsewhere than it always has: a shared place made or removed, a job's own one kept past its end, or anything in scratch", () => {
    const root = folder();
    const machine = join(folder(), "machine");
    const plain = openHomeFolder(root, { machine, program: "home" });
    const shared = join(root, "tools", "faces-work");
    expect(plain.work("faces-work", shared)).toMatchObject({ path: shared });
    plain.work("faces-work", shared).empty();
    expect(existsSync(shared)).toBe(false);
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, "kept.json"), "a connector's own");
    plain.work("faces-work", shared).empty();
    plain.emptyWork({ job: "faces-work" });
    plain.emptyWork({ program: "call" });
    expect(readdirSync(shared)).toEqual(["kept.json"]);
    const copies = join(machine, "calls", "home-test");
    const own = join(copies, "a".repeat(64));
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "attachment-0.jpg"), "left by a killed call");
    const call = plain.work("call", { own });
    expect([call.path, readdirSync(own), statSync(own).mode & 0o777]).toEqual([own, [], 0o700]);
    writeFileSync(join(own, "attachment-0.jpg"), "plain bytes");
    call.empty();
    expect([existsSync(own), existsSync(copies)]).toEqual([false, true]);
    plain.emptyWork({ program: "call", plain: copies });
    expect([existsSync(copies), existsSync(join(machine, "scratch"))]).toEqual([false, false]);
  });

  it("a job's fresh folder is shared by two calls, lies outside its program's scratch on a keyed folder, or outside the system's temporary folder on a plain one", () => {
    const keyed = keyedFolder(folder());
    const [one, two] = [keyed.work("read"), keyed.work("read")];
    expect([one!.path === two!.path, dirname(one!.path), basename(one!.path).startsWith("read-"), statSync(one!.path).mode & 0o777]).toEqual([false, join(scratch(), "home"), true, 0o700]);
    one!.empty();
    two!.empty();
    expect(left()).toEqual([]);
    const plain = openHomeFolder(folder()).work("read");
    expect([dirname(plain.path), basename(plain.path).startsWith("lifestream-read-")]).toEqual([tmpdir(), true]);
    plain.empty();
    expect(existsSync(plain.path)).toBe(false);
  });

  it("a folder handed to another program carries the hander's program, or one handed with no program opens", () => {
    const root = folder();
    const home = keyedFolder(root);
    const toCall = home.handOver(["files"], "call");
    const toWorker = home.handOver(["files"]);
    expect([toCall.form === "keyed" && toCall.program, toWorker.form === "keyed" && toWorker.program]).toEqual(["call", "home"]);
    const line = JSON.parse(JSON.stringify(toCall)) as Record<string, unknown>;
    expect(dirname(openHandedFolder(handedFolderIn(JSON.stringify(line))).work("call").path)).toBe(join(scratch(), "call"));
    for (const program of [undefined, "ask", "sqlite", ""]) {
      expect(code(() => handedFolderIn(JSON.stringify({ ...line, program })))).toBe("REFUSED");
    }
    expect(code(() => handedFolderIn(JSON.stringify({ root, form: "plain", program: "home" })))).toBe("REFUSED");
  });
  it("scratch made open to others before stays so once a keyed folder opens", () => {
    chmodSync(scratch(), 0o755);
    keyedFolder(folder());
    expect(statSync(scratch()).mode & 0o777).toBe(0o700);
  });
});
