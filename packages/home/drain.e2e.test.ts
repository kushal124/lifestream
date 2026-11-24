import { spawn } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, onTestFinished } from "vitest";
import { CHECKPOINT_PAGES, openHomeFolder } from "@lifestreamprotocol/core";
import { startHome, type Home } from "./home.js";
import { report } from "./report.js";
import { askHome } from "./socket.js";
import { LOG_BEHIND } from "./status.js";
import { artifact, FAKES, freeSpace, makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { statusOf } from "./test/harness-status.js";
import { testSocket } from "./test/folder.js";

const MINUTE = 60_000;
const NOTES = "apple-notes:local:mac-0001";
const SCREEN = "screen:local:mac-0001";
const LIVE = "apple-notes:local:mac-live";
const HOME_TURN_MS = 1_000;
const READ_HOLD_MS = TICK_MS;

type Line = Record<string, unknown>;
const count = (root: string, sql: string, ...params: unknown[]) => readHome(root, (db) => db.prepare(sql).pluck().get(...params) as number);
const deliveryState = (root: string, id: string) => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(id) as string | undefined);
const jobState = (root: string, kind: string, key: string) => readHome(root, (db) => db.prepare("SELECT state FROM jobs WHERE kind = ? AND key = ?").pluck().get(kind, key) as string | undefined);
const note = (key: string, at: number, extra: Record<string, unknown> = {}) => ({ kind: "note", key, content: { text: `synthetic note ${key}`, at, ...extra }, at });
const quiet = (root: string) => count(root, "SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')") === 0;
const drainEvents = (root: string) => readHome(root, (db) => db.prepare("SELECT key, detail FROM events WHERE kind = 'log-drain' ORDER BY seq").all() as { key: string; detail: string }[])
  .map((event) => ({ end: event.key, ...(JSON.parse(event.detail) as { ms: number; frames: number; jobs: number }) }));

function fillLog(root: string, letter: string): void {
  const db = new Database(join(root, "home.db"));
  db.pragma("wal_autocheckpoint = 0");
  db.prepare("INSERT INTO meta (key, value) VALUES ('test-filler', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(letter.repeat((CHECKPOINT_PAGES + 64) * 4096));
  db.close();
}

function stands(root: string): { log: number; checkpointed: number } {
  const db = new Database(join(root, "home.db"));
  try {
    const [row] = db.pragma("wal_checkpoint(NOOP)") as { log: number; checkpointed: number }[];
    return row!;
  } finally {
    db.close();
  }
}

let outsideReads = 0;
function readFromOutside(root: string): { end(): void } {
  const writer = new Database(join(root, "home.db"));
  writer.pragma("wal_autocheckpoint = 0");
  writer.prepare("INSERT INTO meta (key, value) VALUES ('test-outside', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(++outsideReads));
  writer.close();
  const db = new Database(join(root, "home.db"), { readonly: true });
  db.exec("BEGIN");
  db.prepare("SELECT count(*) FROM meta").get();
  return { end: () => { if (db.open) { db.exec("COMMIT"); db.close(); } } };
}

function holdFile(root: string, name: string) {
  const path = join(root, `${name}-hold`);
  writeFileSync(path, "");
  return { path, held: () => until(`${name} held`, () => existsSync(`${path}.held`)), release: () => rmSync(path, { force: true }) };
}

async function ticksOn(home: Home, what: string): Promise<void> {
  const from = home.stats().ticks.count;
  await until(what, () => home.stats().ticks.count > from + 1);
}

describe("a drain", () => {
  it("a walk holding two reads and waiting on the main thread's commit never ends, or a live import starts beside it", async () => {
    const root = makeRoot("lifestream-drain-walk-", { sources: { [NOTES]: "fake-rows", [LIVE]: "fake-rows" }, helpers: 3 });
    const logs: Line[] = [];
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: (line) => logs.push(JSON.parse(line) as Line), tickMs: TICK_MS, drainPages: CHECKPOINT_PAGES });
    onTestFinished(async () => {
      await home.stop();
      removeRoot(root);
    });
    const said = (what: string) => logs.filter((line) => line.log === what);
    const first = join(root, "first-hold"), second = join(root, "second-hold");
    const weekA = Date.UTC(2026, 8, 1, 10), weekB = Date.UTC(2026, 8, 22, 10);
    await ship(root, { source: NOTES, fetched_ms: Date.now() - MINUTE, rows: [note("a", weekA, { hold: first }), note("b", weekB, { hold: second })] });
    await until("both days extracted", () => quiet(root) && count(root, "SELECT count(*) FROM extracts WHERE family = 'notes'") === 2);

    writeFileSync(first, "");
    writeFileSync(second, "");
    await askHome(testSocket(root), "rebuild", ["extracts", "--family", "notes"]);
    await until("the walk held in its first slab", () => existsSync(`${first}.held`));
    fillLog(root, "a");
    await until("the drain begun", () => said("draining").length === 1);
    expect(said("draining")[0]!.jobs as number).toBeGreaterThanOrEqual(1);

    const live = await ship(root, { source: LIVE, fetched_ms: Date.now() - MINUTE, rows: [note("live", Date.now() - MINUTE)] });
    await until("the live import queued", () => jobState(root, "import", LIVE) === "queued");
    await ticksOn(home, "two ticks on");
    expect([jobState(root, "import", LIVE), deliveryState(root, live), said("drained").length]).toEqual(["queued", "sealed", 0]);

    rmSync(first);
    await until("the walk past its wait on the commit, held in its second slab", () => existsSync(`${second}.held`));
    expect(count(root, "SELECT count(*) FROM extracts_next WHERE family = 'notes'")).toBeGreaterThan(0);
    expect([jobState(root, "import", LIVE), said("drained").length]).toEqual(["queued", 0]);

    rmSync(second);
    await until("the drain ended", () => said("drained").length === 1);
    await until("the live import once the drain ended", () => deliveryState(root, live) === "imported");
    expect(drainEvents(root)).toEqual([expect.objectContaining({ end: "emptied" })]);
    expect(count(root, "SELECT count(*) FROM events WHERE kind = ?", LOG_BEHIND)).toBe(0);
    artifact(root, "drain-walk", { draining: said("draining"), drained: said("drained") });
  });

  it("helpers' runs ending one after another drain once per drain mark, live work starting between, and the drain ends only with the last reader", async () => {
    const root = makeRoot("lifestream-drain-burst-", { sources: { [NOTES]: "fake-rows", [SCREEN]: "fake-rows", [LIVE]: "fake-rows" }, helpers: 5 });
    const logs: Line[] = [];
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: (line) => logs.push(JSON.parse(line) as Line), tickMs: TICK_MS, drainPages: 2 * CHECKPOINT_PAGES });
    onTestFinished(async () => {
      await home.stop();
      removeRoot(root);
    });
    const said = (what: string) => logs.filter((line) => line.log === what);
    const at = Date.now() - MINUTE;
    const notes = holdFile(root, "notes"), screen = holdFile(root, "screen");
    await ship(root, { source: NOTES, fetched_ms: at, rows: [note("n", at, { hold: notes.path })] });
    await ship(root, { source: SCREEN, fetched_ms: at, rows: [{ kind: "frame", key: "f", content: { at, hold: screen.path }, at }] });
    await notes.held();
    await screen.held();

    fillLog(root, "a");
    await ticksOn(home, "the try at the first fill");
    const before = await ship(root, { source: LIVE, fetched_ms: at, rows: [note("before", at)] });
    await until("the live import beside the runs", () => deliveryState(root, before) === "imported");
    expect(said("draining")).toEqual([]);

    fillLog(root, "b");
    await until("the drain begun", () => said("draining").length === 1);
    expect(said("draining")[0]!.jobs as number).toBeGreaterThanOrEqual(2);
    expect(said("draining")[0]!.frames as number).toBeGreaterThanOrEqual(2 * CHECKPOINT_PAGES);
    const during = await ship(root, { source: LIVE, fetched_ms: at + 1, rows: [note("during", at + 1)] });
    await until("the live import queued", () => jobState(root, "import", LIVE) === "queued");

    notes.release();
    await until("the notes extract done", () => jobState(root, "extract", "notes") !== "running");
    await ticksOn(home, "two ticks after the first run ended");
    expect([said("drained").length, deliveryState(root, during)]).toEqual([0, "sealed"]);

    screen.release();
    await until("the drain ended", () => said("drained").length === 1);
    await until("the live import after the drain", () => deliveryState(root, during) === "imported");
    expect(drainEvents(root)).toEqual([expect.objectContaining({ end: "emptied" })]);
    expect(stands(root).log).toBeLessThan(CHECKPOINT_PAGES);
    artifact(root, "drain-burst", { fills: 2, draining: said("draining"), drained: said("drained"), events: drainEvents(root) });
  });

  it("a job that reads nothing holds the drain until it ends", async () => {
    const root = makeRoot("lifestream-drain-unread-", { sources: { [NOTES]: "fake-rows", [LIVE]: "fake-rows" }, helpers: 4 });
    const logs: Line[] = [];
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: (line) => logs.push(JSON.parse(line) as Line), tickMs: TICK_MS, drainPages: CHECKPOINT_PAGES });
    onTestFinished(async () => {
      await home.stop();
      removeRoot(root);
    });
    const said = (what: string) => logs.filter((line) => line.log === what);
    const extract = holdFile(root, "extract"), unread = holdFile(root, "unread");
    const day = Date.UTC(2026, 8, 1, 10);
    await ship(root, { source: NOTES, fetched_ms: day + MINUTE, rows: [note("e", day, { hold: extract.path })] });
    await extract.held();
    await ship(root, { source: LIVE, fetched_ms: Date.now() - MINUTE, rows: [note("live", Date.now() - MINUTE)], facts: { hold: unread.path } });
    await unread.held();
    await until("only the two held jobs left", () => count(root, "SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')") === 2);
    fillLog(root, "a");
    await until("the drain begun", () => said("draining").length === 1);
    expect(said("draining")[0]!.jobs).toBe(2);

    extract.release();
    await until("the drain ended", () => said("drained").length === 1);
    expect(drainEvents(root)).toEqual([expect.objectContaining({ end: "emptied", jobs: 1 })]);
    expect(jobState(root, "import", LIVE)).toBe("running");
    unread.release();
    await until("the import done", () => quiet(root));
    artifact(root, "drain-unread", { drained: said("drained") });
  });

  it("a read at the door longer than one wait holds the drain no longer than it lasts", async () => {
    const root = makeRoot("lifestream-drain-door-", { sources: {} });
    const logs: Line[] = [];
    const now = Date.now();
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, clock: () => now, log: (line) => logs.push(JSON.parse(line) as Line), tickMs: TICK_MS, drainPages: CHECKPOINT_PAGES });
    const read = readFromOutside(root);
    onTestFinished(async () => {
      read.end();
      await home.stop();
      removeRoot(root);
    });
    const said = (what: string) => logs.filter((line) => line.log === what);
    fillLog(root, "a");
    await until("the drain begun", () => said("draining").length === 1);
    await ticksOn(home, "two ticks into the drain");
    await ticksOn(home, "two more");
    expect(said("drained")).toEqual([]);
    read.end();
    await until("the drain ended", () => said("drained").length === 1);
    expect(drainEvents(root)).toEqual([expect.objectContaining({ end: "emptied" })]);
    artifact(root, "drain-door", { drained: said("drained") });
  });

  it("a drain under way when the disk fills never ends, nor empties the log, while no job may start", async () => {
    const free = freeSpace(1e12);
    const root = makeRoot("lifestream-drain-full-", { sources: {} });
    const logs: Line[] = [];
    const now = Date.now();
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, clock: () => now, log: (line) => logs.push(JSON.parse(line) as Line), tickMs: TICK_MS, drainPages: CHECKPOINT_PAGES });
    const read = readFromOutside(root);
    onTestFinished(async () => {
      read.end();
      await home.stop();
      removeRoot(root);
    });
    const said = (what: string) => logs.filter((line) => line.log === what);
    fillLog(root, "a");
    await until("the drain begun", () => said("draining").length === 1);
    free.set(0.5e9);
    await ticksOn(home, "the home read its disk full");
    read.end();
    await until("the drain ended on the full disk", () => said("drained").length === 1);
    expect(drainEvents(root)).toEqual([expect.objectContaining({ end: "emptied" })]);
    expect(stands(root).log).toBeLessThan(CHECKPOINT_PAGES);
    artifact(root, "drain-full", { drained: said("drained") });
  });

  it("a log wholly copied and still held is a trigger", async () => {
    const root = makeRoot("lifestream-drain-copied-", { sources: {} });
    const keep = new Database(join(root, "home.db"));
    keep.prepare("SELECT count(*) FROM meta").get();
    fillLog(root, "a");
    const read = readFromOutside(root);
    const copier = new Database(join(root, "home.db"));
    copier.pragma("wal_checkpoint(PASSIVE)");
    copier.close();
    keep.close();
    const copied = stands(root);
    expect(copied.log).toBeGreaterThanOrEqual(CHECKPOINT_PAGES);
    expect(copied.log - copied.checkpointed).toBeLessThan(CHECKPOINT_PAGES);

    const logs: Line[] = [];
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: (line) => logs.push(JSON.parse(line) as Line), tickMs: TICK_MS, drainPages: CHECKPOINT_PAGES });
    onTestFinished(async () => {
      read.end();
      await home.stop();
      removeRoot(root);
    });
    const said = (what: string) => logs.filter((line) => line.log === what);
    await until("the drain begun", () => said("draining").length === 1);
    read.end();
    await until("the drain ended", () => said("drained").length === 1);
    expect(drainEvents(root)).toEqual([expect.objectContaining({ end: "emptied" })]);
    artifact(root, "drain-copied", { copied, draining: said("draining"), drained: said("drained") });
  });

  it("a job past the bound holds live work longer or drains again behind it, or a read from outside raises no need, or keeps it once it ends", async () => {
    const root = makeRoot("lifestream-drain-outside-", { sources: { [NOTES]: "fake-rows", [LIVE]: "fake-rows" }, helpers: 3 });
    const logs: Line[] = [];
    let now = Date.now();
    const options = { stopGraceMs: 50, registry: FAKES, clock: () => now, log: (line: string) => logs.push(JSON.parse(line) as Line), tickMs: TICK_MS, drainPages: CHECKPOINT_PAGES };
    let home = await startHome(root, options);
    let outside: { end(): void } | undefined;
    onTestFinished(async () => {
      outside?.end();
      await home.stop();
      removeRoot(root);
    });
    const said = (what: string) => logs.filter((line) => line.log === what);
    const behind = () => readHome(root, (db) => db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(LOG_BEHIND) as string | undefined);
    const behindEvents = () => readHome(root, (db) => db.prepare("SELECT key FROM events WHERE kind = ? ORDER BY seq").pluck().all(LOG_BEHIND)) as string[];
    const ends = () => drainEvents(root).map((drain) => drain.end);

    const first = holdFile(root, "first");
    await ship(root, { source: NOTES, fetched_ms: now - MINUTE, rows: [note("first", now - MINUTE, { hold: first.path })] });
    await first.held();
    outside = readFromOutside(root);
    fillLog(root, "a");
    await until("the drain begun", () => said("draining").length === 1);
    const live = await ship(root, { source: LIVE, fetched_ms: now - MINUTE, rows: [note("live", now - MINUTE)] });
    await until("the live import queued", () => jobState(root, "import", LIVE) === "queued");

    now += 2 * MINUTE;
    await until("the drain ended by its bound", () => said("drained").length === 1);
    expect(ends()).toEqual(["outlasted"]);
    await until("the live import after the bound", () => deliveryState(root, live) === "imported");
    fillLog(root, "b");
    await ticksOn(home, "two ticks after the next mark");
    expect(said("draining").length).toBe(1);
    first.release();
    await until("the extract done", () => quiet(root));

    fillLog(root, "c");
    await until("the second drain begun", () => said("draining").length === 2);
    now += 2 * MINUTE;
    await until("the second drain ended", () => said("drained").length === 2);
    expect(ends()).toEqual(["outlasted", "outside"]);
    expect(behind()).toBeUndefined();

    const since = now;
    now += 10 * MINUTE;
    await until("the need raised", () => behind() !== undefined);
    expect(JSON.parse(behind()!)).toEqual({ since_ms: since });
    expect(ends()).toEqual(["outlasted", "outside"]);
    expect(said("draining").length).toBe(2);
    const status = statusOf(root) as { needs: { id: string; state: string; words: string; line?: string }[] };
    expect(status.needs.filter((need) => need.id === LOG_BEHIND)).toEqual([expect.objectContaining({
      state: "needs-you", words: "Another app holds Lifestream's database open", line: "Close it and Lifestream catches up",
    })]);
    expect(behindEvents()).toEqual(["start"]);

    await home.stop();
    outside.end();
    outside = undefined;
    home = await startHome(root, options);
    await until("the need ended", () => behind() === undefined);
    expect(behindEvents()).toEqual(["start", "end"]);
    const caughtUp = ends().slice(2);
    expect([[], ["emptied"]]).toContainEqual(caughtUp);
    const doorLog = join(root, "synthetic-door.log");
    writeFileSync(doorLog, "");
    const reported = await report(openHomeFolder(root), { from_ms: 0, to_ms: now + MINUTE, door_log: doorLog });
    expect(reported.log).toMatchObject({ drains: 2 + caughtUp.length, emptied: caughtUp.length, outlasted: 1, outside: 1, behind: 1, behind_now: false });
    expect(reported.log.drained_ms).toBe(2 * 2 * MINUTE);
    artifact(root, "drain-outside", { drains: logs.filter((line) => line.log !== undefined), events: drainEvents(root), behind: behindEvents(), log: reported.log });
  });

  it("reads that overlap without end while commits go on let the log grow with no drain", async () => {
    const root = makeRoot("lifestream-drain-overlap-", { sources: {} });
    const logs: Line[] = [];
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: (line) => logs.push(JSON.parse(line) as Line), tickMs: TICK_MS, logTurnMs: HOME_TURN_MS, drainPages: CHECKPOINT_PAGES });
    const children: ReturnType<typeof spawn>[] = [];
    let outside: { end(): void } | undefined;
    onTestFinished(async () => {
      outside?.end();
      for (const child of children) child.kill("SIGKILL");
      await home.stop();
      removeRoot(root);
    });
    const said = (what: string) => logs.filter((line) => line.log === what);
    const sqlite = createRequire(import.meta.url).resolve("better-sqlite3");
    const run = (what: string, program: string) => {
      const child = spawn(process.execPath, ["-e", program, sqlite, join(root, "home.db")], { stdio: ["ignore", "pipe", "inherit"] });
      children.push(child);
      return new Promise<void>((resolve, reject) => {
        child.stdout!.on("data", (data: Buffer) => { if (data.toString().includes(what)) resolve(); });
        child.once("exit", (code) => reject(new Error(`the ${what} process ended first: ${code}`)));
      });
    };
    await run("committing", `
      const Database = require(process.argv[1]);
      const db = new Database(process.argv[2], { timeout: 600000 });
      db.pragma("wal_autocheckpoint = 0");
      const write = db.prepare("INSERT INTO meta (key, value) VALUES ('test-writer', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
      const pace = new Int32Array(new SharedArrayBuffer(4));
      for (let turn = 1; ; turn++) {
        write.run(String(turn));
        if (turn === 2) process.stdout.write("committing\\n");
        Atomics.wait(pace, 0, 0, 10);
      }
    `);
    await run("overlapping", `
      const Database = require(process.argv[1]);
      const [a, b] = [new Database(process.argv[2], { readonly: true }), new Database(process.argv[2], { readonly: true })];
      const read = (db) => { db.exec("BEGIN"); db.prepare("SELECT value FROM meta WHERE key = 'test-writer'").get(); };
      const pace = new Int32Array(new SharedArrayBuffer(4));
      read(a);
      for (let turn = 1, open = a, next = b; ; turn++, [open, next] = [next, open]) {
        read(next);
        open.exec("COMMIT");
        if (turn === 2) process.stdout.write("overlapping\\n");
        Atomics.wait(pace, 0, 0, ${READ_HOLD_MS});
      }
    `);

    const letters = ["a", "b", "c", "d"];
    const found: number[] = [];
    for (const [index, letter] of letters.entries()) {
      found.push(stands(root).log);
      outside = readFromOutside(root);
      fillLog(root, letter);
      await until(`drain ${index + 1} begun behind the read from outside`, () => said("draining").length === index + 1);
      outside.end();
      await until(`drain ${index + 1} ended`, () => said("drained").length === index + 1);
    }
    expect(drainEvents(root).map((drain) => drain.end)).toEqual(["emptied", "emptied", "emptied", "emptied"]);
    for (const each of found) expect(each).toBeLessThan(CHECKPOINT_PAGES);
    artifact(root, "drain-overlap", { found, draining: said("draining"), drained: said("drained") });
  });
});
