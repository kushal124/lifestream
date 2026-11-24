import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openHome, type HomeDb } from "./home-db.js";
import { openHomeFolder, type StoreKind } from "./home-folder.js";

const REPO = join(import.meta.dirname, "..", "..");
const dir = mkdtempSync(join(tmpdir(), "lifestream-durable-"));
const report: Record<string, unknown> = {};

const OPENER = "packages/core/home-folder.ts";
const KIND: StoreKind = { role: "durable", remade: false };
const truthAt = (path: string) => openHomeFolder(dirname(path)).store(KIND, path);
const cacheAt = (path: string) => openHomeFolder(dirname(path)).store(KIND, path, { sync: "NORMAL" });
const NOT_KEPT = new Set(["packages/core/file-lock.ts", "packages/connect/screen/coast/acquirer.ts"]);
const CACHES = new Set(["packages/home/custody.ts", "packages/home/stated.ts", "packages/core/memo.ts", "packages/home/prepared.ts", "packages/home/search-index.ts"]);

afterAll(() => {
  writeFileSync(join(tmpdir(), "core-durable.json"), `${JSON.stringify(report, null, 2)}\n`);
  rmSync(dir, { recursive: true, force: true });
});

describe("a store opened FULL, and a cache NORMAL", () => {
  it("open the log with every flush a full one, the truth flushed at every commit, and the test process's skip of them is live", () => {
    const read = (open: typeof truthAt, name: string) => {
      const db = open(join(dir, `${name}.db`));
      try {
        return {
          journal_mode: db.pragma("journal_mode", { simple: true }),
          synchronous: db.pragma("synchronous", { simple: true }),
          fullfsync: db.pragma("fullfsync", { simple: true }),
          checkpoint_fullfsync: db.pragma("checkpoint_fullfsync", { simple: true }),
          secure_delete: db.pragma("secure_delete", { simple: true }),
        };
      } finally {
        db.close();
      }
    };
    const before = process.env.LIFESTREAM_TEST_FSYNC;
    try {
      process.env.LIFESTREAM_TEST_FSYNC = "1";
      const kept = { truth: read(truthAt, "truth-kept"), cache: read(cacheAt, "cache-kept") };
      delete process.env.LIFESTREAM_TEST_FSYNC;
      report.settings = { kept, skipped: { truth: read(truthAt, "truth-skipped"), cache: read(cacheAt, "cache-skipped") } };
    } finally {
      if (before === undefined) delete process.env.LIFESTREAM_TEST_FSYNC;
      else process.env.LIFESTREAM_TEST_FSYNC = before;
    }
    expect(report.settings).toEqual({
      kept: {
        truth: { journal_mode: "wal", synchronous: 2, fullfsync: 1, checkpoint_fullfsync: 1, secure_delete: 2 },
        cache: { journal_mode: "wal", synchronous: 1, fullfsync: 1, checkpoint_fullfsync: 1, secure_delete: 2 },
      },
      skipped: {
        truth: { journal_mode: "wal", synchronous: 1, fullfsync: 0, checkpoint_fullfsync: 0, secure_delete: 2 },
        cache: { journal_mode: "wal", synchronous: 1, fullfsync: 0, checkpoint_fullfsync: 0, secure_delete: 2 },
      },
    });
  });

  it("are the only way a package opens a SQLite file of the home's to write, and only the caches are caches", () => {
    const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "packages"], { cwd: REPO, encoding: "utf8" })
      .split("\n")
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.includes("/test/") && !file.includes("test-support") && existsSync(join(REPO, file)));
    const writers: string[] = [];
    for (const file of files) {
      readFileSync(join(REPO, file), "utf8").split("\n").forEach((line, index) => {
        if (/\bsync: "NORMAL"/u.test(line) && !CACHES.has(file) && file !== OPENER) {
          writers.push(`${file}:${index + 1}: opens a file as a cache; only a file made again from the truth is one`);
        }
        if (!line.includes("new Database(") || /\breadonly\b(?!:\s*false)/u.test(line) || line.includes(":memory:")) return;
        if (file === OPENER || NOT_KEPT.has(file)) return;
        writers.push(`${file}:${index + 1}: opens SQLite to write; open it with the home folder's store, sync NORMAL for a cache`);
      });
    }
    report.writers = writers;
    expect(writers).toEqual([]);
  });
});

function holds(path: string, token: string): boolean {
  return readFileSync(path).includes(Buffer.from(token));
}

function overAPage(token: string): string {
  return `${token} `.repeat(1_400);
}

describe("what a delete leaves in the file", () => {
  it("a row deleted inside a page under FAST leaves no byte of it once the log is truncated", () => {
    const path = join(dir, "in-page.db");
    const db = truthAt(path);
    try {
      db.exec("CREATE TABLE t (v TEXT NOT NULL)");
      const insert = db.prepare("INSERT INTO t (v) VALUES (?)");
      for (const v of ["synthetic row one", "zqxerasedtoken in a synthetic row", "synthetic row three"]) insert.run(v);
      db.pragma("wal_checkpoint(TRUNCATE)");
      expect(holds(path, "zqxerasedtoken")).toBe(true);
      db.prepare("DELETE FROM t WHERE v LIKE 'zqx%'").run();
      expect(db.pragma("wal_checkpoint(TRUNCATE)")).toEqual([{ busy: 0, log: 0, checkpointed: 0 }]);
      expect(db.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 2 });
      report.in_page = { holds: holds(path, "zqxerasedtoken"), log_bytes: readFileSync(`${path}-wal`).length };
      expect(report.in_page).toEqual({ holds: false, log_bytes: 0 });
    } finally {
      db.close();
    }
  });

  it("a value over a page keeps its bytes in the pages freed whole under FAST; a secure commit zeroes them, and FAST is the connection's again after it, a throw too", () => {
    const path = join(dir, "home.db");
    const home = openHome(openHomeFolder(dirname(path)), "migrate");
    const deleted = (token: string, options?: { secure?: boolean }): boolean => {
      home.commit((tx) => tx.tables.meta.set(`synthetic:${token}`, overAPage(token)));
      truncated(home);
      expect(holds(path, token)).toBe(true);
      home.commit((tx) => tx.tables.meta.delete(`synthetic:${token}`), options);
      truncated(home);
      return holds(path, token);
    };
    try {
      const fast = deleted("zqxfasttoken");
      const secure = deleted("zqxsecuretoken", { secure: true });
      const after = deleted("zqxaftertoken");
      home.commit((tx) => tx.tables.meta.set("synthetic:zqxthrowtoken", overAPage("zqxthrowtoken")));
      expect(() => home.commit((tx) => {
        tx.tables.meta.delete("synthetic:zqxthrowtoken");
        throw new Error("synthetic failure inside the commit");
      }, { secure: true })).toThrow("synthetic failure inside the commit");
      const afterThrow = deleted("zqxthrowtoken");
      report.over_a_page = { fast, secure, after, afterThrow };
      expect(report.over_a_page).toEqual({ fast: true, secure: false, after: true, afterThrow: true });
    } finally {
      home.close();
    }
  });
});

function truncated(home: HomeDb): void {
  expect(home.checkpoint("truncate", 1_000).busy).toBe(0);
}
