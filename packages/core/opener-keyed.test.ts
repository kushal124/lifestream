import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { homeSchema, openHome } from "./home-db.js";
import { cipherLoads, KEYED_CACHE_KB, openHomeFolder, StoreError, storeStamp, type HandedFolder, type HomeFolder, type StoreKind } from "./home-folder.js";
import { KeyError, Keys } from "./keys.js";
import { openMemo } from "./memo.js";
import { Schema } from "./schema.js";
import { damaged, homeError, LEDGER_DB } from "./sql.js";
import { keyedFolder, TEST_DATA_KEY, TEST_KEY_ID, testMachine } from "./test/keyed.js";
import { spillingSort } from "./test/sorts.js";

const CANARY = "ZQX-opener-canary-7f3a";
const PLAIN = "SQLite format 3\0";
const CUSTODY: StoreKind = { role: "custody", remade: true };
const SEARCH: StoreKind = { role: "search", remade: true };
const SCREEN: StoreKind = { role: "screen", remade: true };
const LEDGER: StoreKind = { role: "ledger", remade: false };
const RECORD: StoreKind = { role: "record", remade: false };
const SORTS_CHILD = fileURLToPath(new URL("./test/sorts-child.ts", import.meta.url));
const SETUP = fileURLToPath(new URL("./test/process-sorts.ts", import.meta.url));
const NAMED_AT_LOAD = process.env.SQLITE_TMPDIR;

let root: string;
let n = 0;
const fresh = (name: string): { folder: HomeFolder; path: string } => {
  const home = join(root, `case-${++n}`);
  mkdirSync(home, { recursive: true });
  return { folder: keyedFolder(home), path: join(home, name) };
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "opener-keyed-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function bytesOf(path: string): string {
  return existsSync(path) ? readFileSync(path).toString("latin1") : "";
}

function plainWithin(path: string): string[] {
  const found: string[] = [];
  for (const end of ["", "-wal", "-shm"]) {
    const text = bytesOf(`${path}${end}`);
    if (text.includes(PLAIN)) found.push(`${end || ".db"} has a SQLite header`);
    if (text.includes(CANARY)) found.push(`${end || ".db"} has the canary`);
    if (text.includes("CREATE TABLE")) found.push(`${end || ".db"} has schema text`);
  }
  return found;
}

function errorOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("it opened");
}

function plainStore(path: string): void {
  const db = new Database(path);
  db.exec("CREATE TABLE t (a TEXT); INSERT INTO t VALUES ('kept')");
  db.close();
}

describe("a keyed store", () => {
  it("holds no SQLite header, schema text or canary in .db, -wal or -shm, before a checkpoint, after it and after close", () => {
    const { folder, path } = fresh("custody.db");
    const db = folder.store(CUSTODY, path);
    db.exec("CREATE TABLE t (a TEXT, j TEXT) STRICT");
    db.exec("CREATE VIRTUAL TABLE f USING fts5(a, content='', contentless_delete=1)");
    db.prepare("INSERT INTO t VALUES (?, json_object('c', ?))").run(CANARY, CANARY);
    db.prepare("INSERT INTO f (rowid, a) VALUES (1, ?)").run(CANARY);
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
    expect(plainWithin(path)).toEqual([]);
    db.pragma("wal_checkpoint(TRUNCATE)");
    expect(plainWithin(path)).toEqual([]);
    db.close();
    expect(plainWithin(path)).toEqual([]);
    expect(readFileSync(path).length).toBeGreaterThan(0);
  });

  it("is opened under aegis-256 with 4 KiB pages, its own page cache, its sorts in a file and nothing mapped, and a plain store's mapping and sorts are not honoured", () => {
    const { folder, path } = fresh("custody.db");
    const db = folder.store(CUSTODY, path, { mapped: 1 << 20, sorts: "memory" });
    try {
      expect(db.pragma("cipher", { simple: true })).toBe("aegis");
      expect(db.pragma("algorithm", { simple: true })).toBe("aegis-256");
      expect(db.pragma("page_size", { simple: true })).toBe(4096);
      expect(db.pragma("cache_size", { simple: true })).toBe(-KEYED_CACHE_KB);
      expect(db.pragma("temp_store", { simple: true })).toBe(1);
      expect(db.pragma("mmap_size", { simple: true })).toBe(0);
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(db.pragma("secure_delete", { simple: true })).toBe(2);
    } finally {
      db.close();
    }
  });

  it("runs the home's migrations, then opens for write and read", () => {
    const { folder, path } = fresh("home.db");
    const home = openHome(folder, "migrate");
    expect(home.migrated).toEqual(expect.objectContaining({ from: 0, to: homeSchema.latest }));
    home.close();
    openHome(folder, "write").close();
    const read = openHome(folder, "read");
    const view = read.view();
    view.close();
    read.close();
    expect(plainWithin(path)).toEqual([]);
  });

  it("is refused under another role's key, with a key not handed, with no keys, and by the plain engine", () => {
    const { folder, path } = fresh("custody.db");
    folder.store(CUSTODY, path).close();
    expect(() => folder.store(LEDGER, path)).toThrow(expect.objectContaining({ name: "StoreError", code: "STORE_KEY" }));
    const narrowed = openHomeFolder(folder.root, { machine: testMachine(), program: "home", keys: Keys.derive(TEST_DATA_KEY).only(["store:ledger"]) });
    expect(() => narrowed.store(CUSTODY, path)).toThrow(expect.objectContaining({ name: "KeyError", code: "NOT_HANDED" }));
    expect(() => narrowed.store(CUSTODY, path)).toThrow(KeyError);
    expect(() => openHomeFolder(folder.root, { machine: testMachine(), program: "home" })).toThrow(expect.objectContaining({ name: "KeyError", code: "LOCKED" }));
    const plain = new Database(path, { readonly: true });
    try {
      expect(() => plain.prepare("SELECT count(*) FROM sqlite_schema").get()).toThrow(expect.objectContaining({ code: "SQLITE_NOTADB" }));
    } finally {
      plain.close();
    }
  });

  it("refuses a plain store of the record STORE_PLAIN and leaves it as it was", () => {
    for (const kind of [LEDGER, RECORD]) {
      const { folder, path } = fresh(`${kind.role}.db`);
      plainStore(path);
      const before = readFileSync(path);
      expect(() => folder.store(kind, path, { sync: "NORMAL" })).toThrow(StoreError);
      expect(() => folder.store(kind, path, { sync: "NORMAL" })).toThrow(expect.objectContaining({ code: "STORE_PLAIN" }));
      expect(readFileSync(path).equals(before)).toBe(true);
    }
    const { folder, path } = fresh("home.db");
    plainStore(path);
    expect(() => openHome(folder, "write")).toThrow(expect.objectContaining({ code: "STORE_PLAIN" }));
    expect(() => openHome(folder, "read")).toThrow(expect.objectContaining({ code: "STORE_PLAIN" }));
  });

  it("names a record that does not open, under another key or plain, as damage of its database, or leaves it a fault no hold names", () => {
    const { folder, path } = fresh("home.db");
    plainStore(path);
    const plain = errorOf(() => openHome(folder, "migrate"));
    writeFileSync(path, randomBytes(8192));
    const other = errorOf(() => openHome(folder, "migrate"));
    expect([plain, other]).toEqual([expect.objectContaining({ code: "STORE_PLAIN", database: "home.db" }), expect.objectContaining({ code: "STORE_KEY", database: "home.db" })]);
    expect([damaged(plain), damaged(other)]).toEqual([true, true]);
    expect(homeError(new StoreError("STORE_KEY", path, "synthetic"), LEDGER_DB)).toMatchObject({ database: LEDGER_DB });
    expect(damaged(new StoreError("STORE_SCRATCH", path, "synthetic"))).toBe(false);
  });

  it("makes a plain cache, or one under another key, again keyed", () => {
    const { folder, path: plain } = fresh("search.db");
    plainStore(plain);
    const db = folder.store(SEARCH, plain, { sync: "NORMAL" });
    try {
      expect(db.prepare("SELECT count(*) FROM sqlite_schema").pluck().get()).toBe(0);
    } finally {
      db.close();
    }
    expect(bytesOf(plain).startsWith(PLAIN)).toBe(false);

    const other = join(folder.root, "screen.db");
    folder.store(SEARCH, other, { sync: "NORMAL" }).exec("CREATE TABLE gone (a)");
    const remade = folder.store(SCREEN, other, { sync: "NORMAL" });
    try {
      expect(remade.prepare("SELECT count(*) FROM sqlite_schema").pluck().get()).toBe(0);
    } finally {
      remade.close();
    }

    const memo = join(folder.root, "memo.db");
    plainStore(memo);
    const opened = openMemo(folder, memo, "1");
    expect(opened.values("space", ["k"], () => 1)).toEqual(new Map([["k", 1]]));
    opened.close();
    expect(bytesOf(memo).startsWith(PLAIN)).toBe(false);
  });

  it("leaves a cache it may not make again, one that must exist or one opened to read, to the cache's own repair with SQLite's own error, and the record to StoreError", () => {
    const { folder, path: plain } = fresh("search.db");
    plainStore(plain);
    const other = join(folder.root, "screen.db");
    folder.store(SEARCH, other, { sync: "NORMAL" }).close();
    const modes = [{ sync: "NORMAL", mustExist: true }, { mode: "read" }, { mode: "read", mustExist: true }] as const;
    for (const [kind, path] of [[SEARCH, plain], [SCREEN, other]] as const) {
      const before = readFileSync(path);
      for (const open of modes) {
        const thrown = errorOf(() => folder.store(kind, path, open));
        expect([kind.role, open, damaged(thrown), thrown instanceof StoreError]).toEqual([kind.role, open, true, false]);
      }
      expect(readFileSync(path).equals(before)).toBe(true);
    }
    for (const open of modes) {
      expect(errorOf(() => folder.store(RECORD, plain, open))).toEqual(expect.objectContaining({ name: "StoreError", code: "STORE_PLAIN" }));
      expect(errorOf(() => folder.store(RECORD, other, open))).toEqual(expect.objectContaining({ name: "StoreError", code: "STORE_KEY" }));
    }
  });

  it("attaches another keyed store under its own role's key", () => {
    const { folder, path } = fresh("search.db");
    const attached = join(folder.root, "custody.db");
    const made = folder.store(CUSTODY, attached);
    made.exec("CREATE TABLE t (a TEXT)");
    made.prepare("INSERT INTO t VALUES (?)").run(CANARY);
    made.close();
    const db = folder.store(SEARCH, path, { sync: "NORMAL" });
    try {
      folder.attach(db, "custody", CUSTODY, attached);
      expect(db.prepare("SELECT a FROM custody.t").pluck().get()).toBe(CANARY);
      db.exec('DETACH DATABASE "custody"');
      expect(() => folder.attach(db, "custody", SEARCH, attached)).toThrow(expect.objectContaining({ code: "SQLITE_NOTADB" }));
    } finally {
      db.close();
    }
    expect(plainWithin(attached)).toEqual([]);
  });
});

describe("the version stamp", () => {
  const STEPS = new Schema({
    name: "steps.db",
    file: "steps.db",
    base: 1,
    baseline: "CREATE TABLE one (a TEXT)",
    migrations: [(db) => db.exec("CREATE TABLE two (a TEXT)"), (db) => db.exec("CREATE TABLE three (a TEXT)")],
    small: [],
  });
  const STEPPED: StoreKind = { role: "steps", remade: false };
  const version = (folder: HomeFolder, path: string): number => {
    const db = folder.store(STEPPED, path, { mode: "read" });
    try {
      return db.pragma("user_version", { simple: true }) as number;
    } finally {
      db.close();
    }
  };

  it("is written by the store itself on a keyed migration, with the vault key's id, beside the other stores' versions", () => {
    const { folder } = fresh("home.db");
    const stamp = join(folder.root, "config", "stores.json");
    writeFileSync(stamp, JSON.stringify({ "replies.db": 12 }));
    openHome(folder, "migrate").close();
    expect(JSON.parse(readFileSync(stamp, "utf8"))).toEqual({ key_id: TEST_KEY_ID, "home.db": homeSchema.latest, "replies.db": 12 });
    expect(storeStamp(folder.root)).toEqual({ key_id: TEST_KEY_ID, versions: { "home.db": homeSchema.latest, "replies.db": 12 } });
    expect(statSync(stamp).mode & 0o777).toBe(0o600);
  });

  it("is written ahead: the target before the migration runs", () => {
    const { folder, path } = fresh("steps.db");
    const seen: unknown[] = [];
    const watching = new Schema({
      name: "steps.db", file: "steps.db", base: 1, baseline: "CREATE TABLE one (a TEXT)", small: [],
      migrations: [(db) => {
        seen.push(storeStamp(folder.root)?.versions["steps.db"]);
        db.exec("CREATE TABLE two (a TEXT)");
      }],
    });
    const db = folder.store(STEPPED, path);
    try {
      watching.open(db, "migrate");
    } finally {
      db.close();
    }
    expect(seen[0]).toBe(2);
    expect(storeStamp(folder.root)?.versions["steps.db"]).toBe(2);
  });

  it("is never below the file's version when a migration is cut between its two writes", () => {
    const { folder, path: failing } = fresh("steps.db");
    const breaking = new Schema({
      name: "steps.db", file: "steps.db", base: 1, baseline: "CREATE TABLE one (a TEXT)", small: [],
      migrations: [(db) => db.exec("CREATE TABLE two (a TEXT)"), () => {
        throw new Error("cut inside the migration");
      }],
    });
    let db = folder.store(STEPPED, failing);
    try {
      expect(() => breaking.open(db, "migrate")).toThrow("cut inside the migration");
    } finally {
      db.close();
    }
    expect(version(folder, failing)).toBe(0);
    expect(storeStamp(folder.root)?.versions["steps.db"]).toBe(3);

    const { folder: after, path: committed } = fresh("steps.db");
    const config = join(after.root, "config");
    const cutting = new Schema({
      name: "steps.db", file: "steps.db", base: 1, baseline: "CREATE TABLE one (a TEXT)", small: [],
      migrations: [...STEPS.migrations.slice(0, 1), (db) => {
        STEPS.migrations[1]!(db);
        chmodSync(config, 0o500);
      }],
    });
    db = after.store(STEPPED, committed);
    try {
      expect(() => cutting.open(db, "migrate")).toThrow(expect.objectContaining({ code: "EACCES" }));
    } finally {
      chmodSync(config, 0o700);
      db.close();
    }
    expect(version(after, committed)).toBe(3);
    expect(storeStamp(after.root)?.versions["steps.db"]).toBe(3);
  });

  it("is never written through a store opened to read", () => {
    const { folder, path } = fresh("steps.db");
    const db = folder.store(STEPPED, path);
    db.close();
    const read = folder.store(STEPPED, path, { mode: "read" });
    try {
      expect(() => STEPS.open(read, "migrate")).toThrow();
    } finally {
      read.close();
    }
    expect(storeStamp(folder.root)).toBeNull();
  });

  it("holds the record's and the ledger's versions alone: a cache's migration writes none", () => {
    const { folder, path } = fresh("steps.db");
    openHome(folder, "migrate").close();
    const stepped = folder.store(STEPPED, path);
    try {
      STEPS.open(stepped, "migrate");
    } finally {
      stepped.close();
    }
    const cache = folder.store(CUSTODY, join(folder.root, "cache.db"));
    try {
      new Schema({ name: "cache.db", file: "cache.db", base: 1, baseline: "CREATE TABLE one (a TEXT)", small: [], migrations: [(db) => db.exec("CREATE TABLE two (a TEXT)")] }).open(cache, "migrate");
    } finally {
      cache.close();
    }
    expect(storeStamp(folder.root)).toEqual({ key_id: TEST_KEY_ID, versions: { "home.db": homeSchema.latest, "steps.db": 3 } });
  });

  it("names the vault whose keys opened the folder, not the vault.json on disk when it is written", () => {
    const { folder } = fresh("home.db");
    const vault = join(folder.root, "config", "vault.json");
    writeFileSync(vault, readFileSync(vault, "utf8").replace(TEST_KEY_ID, "ffffffff"));
    openHome(folder, "migrate").close();
    expect(storeStamp(folder.root)?.key_id).toBe(TEST_KEY_ID);
  });
});

describe("a keyed store's sorts", () => {
  const sorts = (): string => join(testMachine(), "scratch", "sqlite");
  const spilledInto = (db: ReturnType<HomeFolder["store"]>, folder: string): string[] => {
    let open: string[] = [];
    expect(spillingSort(db, () => { open = openIn(folder); })).toBe(40_000);
    return open;
  };

  it("spill to <machine>/scratch/sqlite, unlinked, made 0700", () => {
    const { folder, path } = fresh("custody.db");
    expect(statSync(sorts()).mode & 0o777).toBe(0o700);
    expect(process.env.SQLITE_TMPDIR).toBe(sorts());
    const db = folder.store(CUSTODY, path);
    const seen = { open: [] as string[], listed: [] as string[] };
    try {
      spillingSort(db, () => Object.assign(seen, { open: openIn(sorts()), listed: readdirSync(sorts()) }));
    } finally {
      db.close();
    }
    expect([seen.open.length > 0, seen.listed]).toEqual([true, []]);
  });

  it("are named by the test setup before any engine loads, so a file that mocks an engine still binds its mock", async () => {
    const shown = await lastLine(["--input-type=module", "-e", `await import(${JSON.stringify(SETUP)}); process.stdout.write(JSON.stringify({ engines: process.report.getReport().sharedObjects.filter((path) => path.includes("better-sqlite3")), sorts: process.env.SQLITE_TMPDIR }));`]);
    expect(shown).toEqual({ engines: [], sorts: expect.stringMatching(/\/scratch\/sqlite$/u) });
  });

  it("go to one folder per process, named before its first test: a keyed folder of another machine spills there and names none of its own", () => {
    expect(NAMED_AT_LOAD).toBe(sorts());
    const other = mkdtempSync(join(root, "other-machine-"));
    const home = join(root, `case-${++n}`);
    const folder = keyedFolder(home, other);
    const db = folder.store(CUSTODY, join(home, "custody.db"));
    try {
      expect(spilledInto(db, sorts()).length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
    expect([process.env.SQLITE_TMPDIR, existsSync(join(other, "scratch", "sqlite"))]).toEqual([sorts(), false]);
  });

  it("outlive a keyed home and its machine removed by its test: a plain store, a keyed store of a new machine and a child process opened after still sort through a spill", async () => {
    const gone = mkdtempSync(join(root, "gone-machine-"));
    const goneHome = join(root, `case-${++n}`);
    const first = keyedFolder(goneHome, gone).store(CUSTODY, join(goneHome, "custody.db"));
    try {
      expect(spilledInto(first, sorts()).length).toBeGreaterThan(0);
    } finally {
      first.close();
    }
    rmSync(goneHome, { recursive: true, force: true });
    rmSync(gone, { recursive: true, force: true });
    expect([process.env.SQLITE_TMPDIR, existsSync(sorts())]).toEqual([sorts(), true]);

    const plainRoot = join(root, `case-${++n}`);
    mkdirSync(plainRoot);
    const plain = openHomeFolder(plainRoot).store(CUSTODY, join(plainRoot, "custody.db"));
    try {
      expect(spillingSort(plain)).toBe(40_000);
    } finally {
      plain.close();
    }

    const later = join(root, `case-${++n}`);
    const keyed = keyedFolder(later, mkdtempSync(join(root, "later-machine-"))).store(CUSTODY, join(later, "custody.db"));
    try {
      expect(spilledInto(keyed, sorts()).length).toBeGreaterThan(0);
    } finally {
      keyed.close();
    }

    const child = mkdtempSync(join(root, "child-"));
    expect(await sortsInChild(child)).toEqual({ inherited: sorts(), there: true, plain: 40_000, keyed: 40_000, sorts: join(child, "machine", "scratch", "sqlite") });
  });

  it("are named before a cipher probed first, as the release's self-check probes it: the next keyed folder opens and spills", () => {
    expect(cipherLoads()).toBeNull();
    const { folder, path } = fresh("custody.db");
    const db = folder.store(CUSTODY, path);
    try {
      expect(spilledInto(db, sorts()).length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("in a thread go to the folder the main thread named, for a folder of any machine, and are refused in a thread started with none named", async () => {
    const other = mkdtempSync(join(root, "thread-machine-"));
    const home = join(root, `case-${++n}`);
    const handed = keyedFolder(home, other).handOver();
    expect(await inThread(home, handed, process.env)).toMatchObject({ form: "keyed" });
    const { SQLITE_TMPDIR: _named, ...unnamed } = process.env;
    expect(await inThread(home, handed, unnamed)).toMatchObject({ refused: expect.stringContaining("SQLITE_TMPDIR is the process's") });
  });
});

function inThread(root: string, handed: HandedFolder, env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const worker = new Worker(new URL("./test/folder-worker.ts", import.meta.url), { execArgv: ["--import", "tsx"], env, workerData: { root, handed } });
  return new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
}

function sortsInChild(root: string): Promise<unknown> {
  return lastLine([SORTS_CHILD, root]);
}

function lastLine(args: string[]): Promise<unknown> {
  const child = spawn(process.execPath, ["--import", "tsx", ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve(JSON.parse(out.trim().split("\n").at(-1)!)) : reject(new Error(`the child ended ${code}: ${err}`))));
  });
}

function openIn(folder: string): string[] {
  if (process.platform === "linux") {
    return readdirSync("/proc/self/fd").flatMap((fd) => {
      try {
        const target = readlinkSync(`/proc/self/fd/${fd}`);
        return target.startsWith(`${folder}/`) && target.endsWith(" (deleted)") ? [target] : [];
      } catch {
        return [];
      }
    });
  }
  const real = execFileSync("realpath", [folder], { encoding: "utf8" }).trim();
  return execFileSync("lsof", ["-n", "-P", "-F", "n", "-p", String(process.pid)], { encoding: "utf8", maxBuffer: 1 << 26 })
    .split("\n").filter((line) => line.startsWith(`n${real}/`)).map((line) => line.slice(1));
}
