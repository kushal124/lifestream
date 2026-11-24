import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { openHome, type HomeDb } from "./home-db.js";
import { openHomeFolder } from "./home-folder.js";

const dir = mkdtempSync(join(tmpdir(), "lifestream-checkpoint-"));
const report: Record<string, unknown> = {};

afterAll(() => {
  writeFileSync(join(tmpdir(), "core-checkpoint.json"), `${JSON.stringify(report, null, 2)}\n`);
  rmSync(dir, { recursive: true, force: true });
});

function home(name: string): { db: HomeDb; path: string; write(value: string): void; log(): number } {
  const path = join(mkdtempSync(join(dir, `${name}-`)), "home.db");
  const db = openHome(openHomeFolder(dirname(path)), "migrate", { ownCheckpoints: true });
  onTestFinished(() => db.close());
  return {
    db, path,
    write: (value) => db.commit((tx) => tx.tables.meta.set("checkpoint-test", value)),
    log: () => statSync(`${path}-wal`).size,
  };
}

function reader(path: string): { value(): string; end(): void } {
  const db = new Database(path, { readonly: true });
  const value = () => db.prepare("SELECT value FROM meta WHERE key = 'checkpoint-test'").pluck().get() as string;
  db.exec("BEGIN");
  value();
  return { value, end: () => { db.exec("COMMIT"); db.close(); } };
}

describe("a truncate and the readers of the log", () => {
  it("a reader from before the last commit stands in the way; one begun once the log is wholly copied never does; one begun between does until it ends", () => {
    const { db, path, write, log } = home("readers.db");
    write("one");

    const before = reader(path);
    write("two");
    const kept = db.checkpoint("truncate");
    expect(kept.busy).toBe(1);
    expect(kept.checkpointed).toBeLessThan(kept.log);
    expect(before.value()).toBe("one");
    before.end();
    expect(db.checkpoint("truncate").busy).toBe(0);
    expect(log()).toBe(0);

    write("three");
    const copied = db.checkpoint("passive");
    expect(copied.checkpointed).toBe(copied.log);
    const after = reader(path);
    const through = db.checkpoint("truncate");
    expect(through.busy).toBe(0);
    expect(log()).toBe(0);
    expect(after.value()).toBe("three");
    after.end();

    write("four");
    const between = reader(path);
    const held = db.checkpoint("truncate");
    expect(held.busy).toBe(1);
    expect(held.checkpointed).toBe(held.log);
    between.end();
    expect(db.checkpoint("truncate").busy).toBe(0);
    report.readers = { kept, copied, through, held };
  });

  it("reads that overlap without end, each begun after the last commit, never keep a truncate that waits from going through", async () => {
    const { db, path, write, log } = home("overlapping.db");
    write("one");
    write("two");
    const child = spawn(process.execPath, ["-e", `
      const Database = require(process.argv[1]);
      const [a, b] = [new Database(process.argv[2], { readonly: true }), new Database(process.argv[2], { readonly: true })];
      const read = (db) => { db.exec("BEGIN"); db.prepare("SELECT value FROM meta WHERE key = 'checkpoint-test'").get(); };
      const pace = new Int32Array(new SharedArrayBuffer(4));
      read(a);
      for (let turn = 1, open = a, next = b; ; turn++, [open, next] = [next, open]) {
        read(next);
        open.exec("COMMIT");
        if (turn === 2) process.stdout.write("overlapping\\n");
        Atomics.wait(pace, 0, 0, 10);
      }
    `, createRequire(import.meta.url).resolve("better-sqlite3"), path], { stdio: ["ignore", "pipe", "inherit"] });
    onTestFinished(() => { child.kill("SIGKILL"); });
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (data: Buffer) => { if (data.toString().includes("overlapping")) resolve(); });
      child.once("exit", (code) => reject(new Error(`the reading process ended first: ${code}`)));
    });
    const waited = db.checkpoint("truncate", 5_000);
    expect(waited.busy).toBe(0);
    expect(log()).toBe(0);
    report.overlapping = { waited };
  });
});
