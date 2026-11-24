import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { homeSchema, openHome } from "./home-db.js";
import { openHomeFolder, type StoreKind } from "./home-folder.js";
import { Keys } from "./keys.js";

const PROBE = fileURLToPath(new URL("./test/engine-probe.ts", import.meta.url));
const OURS: StoreKind = { role: "ours", remade: false };
const MEMO: StoreKind = { role: "memo", remade: true };
const PRAGMAS = ["page_size", "journal_mode", "synchronous", "secure_delete", "temp_store", "mmap_size", "auto_vacuum", "user_version", "encoding", "cache_size"];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opener-plain-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function todays(path: string): Database.Database {
  const db = new Database(path, { fileMustExist: false, timeout: 5_000 });
  db.pragma("fullfsync = ON");
  db.pragma("checkpoint_fullfsync = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("secure_delete = FAST");
  return db;
}

function settings(db: Database.Database): Record<string, unknown> {
  return Object.fromEntries(PRAGMAS.map((name) => [name, db.pragma(name, { simple: true })]));
}

function schemaOf(path: string): unknown[] {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name").all();
  } finally {
    db.close();
  }
}

function header(path: string): Buffer {
  const bytes = readFileSync(path).subarray(0, 100);
  bytes.fill(0, 24, 28);
  bytes.fill(0, 92, 100);
  return bytes;
}

function probe(form: "plain" | "keyed" | "both"): Promise<{ modules: number; binaries: number } & Record<string, unknown>> {
  const folder = mkdtempSync(join(dir, `${form}-`));
  const child = spawn(process.execPath, ["--import", "tsx", PROBE, folder, form], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve(JSON.parse(out.trim().split("\n").at(-1)!) as { modules: number; binaries: number } & Record<string, unknown>) : reject(new Error(`the probe ended ${code}: ${err}`))));
  });
}

describe("a plain home's opener", () => {
  it("is plain when handed keys: the form is the folder's", () => {
    const folder = openHomeFolder(dir, { machine: join(dir, "machine"), program: "home", keys: Keys.derive(Buffer.alloc(32, 1)) });
    expect([folder.form, folder.handOver(), folder.work("job", join(dir, "tools", "job-work")).path]).toEqual(["plain", { root: dir, form: "plain" }, join(dir, "tools", "job-work")]);
    openHome(folder, "migrate").close();
    expect(readFileSync(join(dir, "home.db")).subarray(0, 16).toString("latin1")).toBe("SQLite format 3\0");
    expect(existsSync(join(dir, "machine"))).toBe(false);
  });

  it("makes a home.db equal in schema, header and settings to today's code", () => {
    const opened = join(dir, "home.db");
    const today = join(dir, "today.db");
    openHome(openHomeFolder(dir), "migrate").close();
    const made = todays(today);
    homeSchema.open(made, "migrate");
    made.close();
    const ours = new Database(opened);
    const theirs = new Database(today);
    try {
      expect(settings(ours)).toEqual(settings(theirs));
    } finally {
      ours.close();
      theirs.close();
    }
    expect(schemaOf(opened)).toEqual(schemaOf(today));
    expect(header(opened).equals(header(today))).toBe(true);
    expect(readFileSync(opened).subarray(0, 16).toString("latin1")).toBe("SQLite format 3\0");
  });

  it("opens a connection with today's settings", () => {
    const folder = openHomeFolder(dir);
    const ours = folder.store(OURS, join(dir, "ours.db"));
    const cache = folder.store(MEMO, join(dir, "cache.db"), { sync: "NORMAL" });
    const theirs = todays(join(dir, "theirs.db"));
    try {
      expect(settings(ours)).toEqual(settings(theirs));
      expect({ ...settings(cache), synchronous: null }).toEqual({ ...settings(theirs), synchronous: null });
      expect(cache.pragma("synchronous", { simple: true })).toBe(1);
    } finally {
      ours.close();
      cache.close();
      theirs.close();
    }
    const sorting = folder.store(MEMO, join(dir, "sorting.db"), { sync: "NORMAL", sorts: "memory" });
    try {
      expect(sorting.pragma("temp_store", { simple: true })).toBe(2);
    } finally {
      sorting.close();
    }
  });

  it("never writes a stamp", () => {
    const stamp = join(dir, "config", "stores.json");
    openHome(openHomeFolder(dir), "migrate").close();
    expect(existsSync(stamp)).toBe(false);
    expect(existsSync(join(dir, "config"))).toBe(false);
  });

  it("refuses a broken store with SQLITE_NOTADB, as today, with no header check of its own", () => {
    const path = join(dir, "home.db");
    writeFileSync(path, Buffer.concat([Buffer.from("SQLite format 3\0", "latin1"), Buffer.alloc(8176, 0x41)]));
    expect(() => openHome(openHomeFolder(dir), "write")).toThrow(expect.objectContaining({ code: "SQLITE_NOTADB" }));
    const cache = join(dir, "cache.db");
    writeFileSync(cache, Buffer.alloc(8192, 0x41));
    expect(() => openHomeFolder(join(dir, "elsewhere")).store(MEMO, cache, { sync: "NORMAL" })).toThrow(expect.objectContaining({ code: "SQLITE_NOTADB" }));
  });

  it("never loads the cipher engine in a process that holds no keys, and the probe sees it in one that does", async () => {
    expect(await probe("plain")).toEqual({ modules: 0, binaries: 0 });
    const keyed = await probe("keyed");
    expect(keyed.modules).toBeGreaterThan(0);
    expect(keyed.binaries).toBe(1);
  });

  it("opens a keyed and a plain store at once in one process and in one worker thread, each read and written", async () => {
    const written = (rows: string[]) => [{ form: "keyed", rows }, { form: "plain", rows }];
    expect(await probe("both")).toEqual({
      modules: expect.any(Number), binaries: 1,
      main: written(["main"]), worker: written(["main", "worker"]), after: written(["main", "worker", "main-after"]),
    });
  });
});
