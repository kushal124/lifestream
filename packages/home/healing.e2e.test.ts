import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, onTestFinished } from "vitest";
import { CHECKPOINT_PAGES, openHome, openHomeFolder, type JsonObject } from "@lifestreamprotocol/core";
import { nudges } from "./nudges.js";
import { startHome, type Home } from "./home.js";
import { MANIFEST_FILE } from "./inbox.js";
import { LANE } from "./jobs.js";
import { mintPrincipal } from "./principals.js";
import { askHome } from "./socket.js";
import { FREE_BYTES, readDisk, type FreeDay } from "./status.js";
import { artifact, FAKES, freeSpace, makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { ship, shipFiles } from "./test/harness-deliveries.js";
import { doorHere } from "./test/harness-door.js";
import { acquisitionBundle, DEVICE, startDoor } from "./test/support.js";
import { testSocket } from "./test/folder.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOTES = "apple-notes:local:mac-0001";

const count = (root: string, sql: string, ...params: unknown[]) => readHome(root, (db) => db.prepare(sql).pluck().get(...params) as number);
const deliveryState = (root: string, id: string) => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(id) as string | undefined);
const note = (key: string, at: number, extra: Record<string, unknown> = {}) => ({ kind: "note", key, content: { text: `synthetic note ${key}`, at, ...extra }, at });
type Line = Record<string, unknown>;
function fillLog(root: string, letter: string): void {
  const db = new Database(join(root, "home.db"));
  db.pragma("wal_autocheckpoint = 0");
  db.prepare("INSERT INTO meta (key, value) VALUES ('test-filler', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(letter.repeat((CHECKPOINT_PAGES + 64) * 4096));
  db.close();
}
function frames(root: string): number {
  const db = new Database(join(root, "home.db"));
  try {
    const [row] = db.pragma("wal_checkpoint(NOOP)") as { log: number }[];
    return row!.log;
  } finally {
    db.close();
  }
}

describe("the inbox look", () => {
  it("a delivery whose nudge the door never sent, or one sealed while the home was down, is never imported", async () => {
    const root = makeRoot("lifestream-look-", { sources: { [NOTES]: "fake-rows" } });
    const token = "synthetic-token-mac".padEnd(43, "x");
    mintPrincipal(openHomeFolder(root), { unit: "mac-0001", kind: "mac", scopes: ["deliver"], sources: [NOTES], token, now_ms: Date.now() });
    const at = { root, tokens: { mac: token }, ids: {} };
    let home: Home | undefined = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined, tickMs: TICK_MS });
    const doors: { stop(): Promise<unknown> }[] = [];
    onTestFinished(async () => {
      for (const door of doors) await door.stop();
      await home?.stop();
      removeRoot(root);
    });
    await until("the start's look done", () => count(root, "SELECT count(*) FROM jobs WHERE state <> 'done'") === 0);
    const bundle = (n: number) => acquisitionBundle({
      source: NOTES, fetched_ms: Date.now() - 5 * MINUTE + n, custody: { [NOTES]: { seal: n } },
      files: [["rows.ndjson", Buffer.from(`${JSON.stringify(note(`n${n}`, Date.now() - 5 * MINUTE))}\n`)]],
    });
    const put = (url: string, sealed: ReturnType<typeof bundle>) => fetch(`${url}${sealed.path}`, { method: "PUT", headers: { authorization: `Bearer ${token}`, ...DEVICE.mac }, body: sealed.bytes });

    const dying = await startDoor(at, { LIFESTREAM_FAILPOINT: "door.sealed" });
    doors.push(dying);
    const first = bundle(1);
    await expect(put(dying.url, first)).rejects.toThrow();
    expect(await dying.exited).toBe("SIGKILL");
    expect(deliveryState(root, first.id)).toBeUndefined();
    const door = await doorHere(root);
    doors.push(door);
    await until("the lost seal imported", () => deliveryState(root, first.id) === "imported");

    await home.stop();
    home = undefined;
    const second = bundle(2);
    expect((await put(door.url, second)).status).toBe(201);
    home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined, tickMs: TICK_MS });
    await until("the seal made while the home was down imported", () => deliveryState(root, second.id) === "imported");
    artifact(root, "look", { first: first.id, second: second.id });
  });
});

describe("a dead job", () => {
  it("dies past five tries, is never tried again once a release fixed it, or is tried more often than at a start and once a day", async () => {
    const start = Date.UTC(2026, 9, 10, 6, 0);
    let now = start;
    const root = makeRoot("lifestream-dead-", { sources: { [NOTES]: "fake-rows" }, clocks: true });
    let home = await startHome(root, { stopGraceMs: 50, registry: FAKES, clock: () => now, log: () => undefined, tickMs: TICK_MS });
    onTestFinished(async () => {
      await home.stop();
      removeRoot(root);
    });
    const failures = () => count(root, "SELECT count(*) FROM events WHERE kind = 'import-failed'");
    const job = () => readHome(root, (db) => db.prepare("SELECT state, attempts FROM jobs WHERE kind = 'import' AND key = ?").get(NOTES)) as { state: string; attempts: number } | undefined;
    const toDeath = async (from: number) => {
      for (let tries = 1; tries <= 5; tries++) {
        await until(`failure ${from + tries}`, () => failures() === from + tries);
        now += 31 * MINUTE;
        await askHome(testSocket(root), "settings");
      }
      await until("the job dead", () => job()?.state === "dead");
    };
    const fault = join(root, "fault");
    writeFileSync(fault, "");
    await shipFiles(root, NOTES, start - 10 * MINUTE, { "rows.ndjson": Buffer.from(`${JSON.stringify({ fault_if: fault })}\n`) });
    await toDeath(0);
    expect(job()).toEqual({ state: "dead", attempts: 5 });

    await home.stop();
    home = await startHome(root, { stopGraceMs: 50, registry: FAKES, clock: () => now, log: () => undefined, tickMs: TICK_MS });
    await toDeath(5);
    const starts = readHome(root, (db) => db.prepare("SELECT detail FROM events WHERE kind = 'home' AND key = 'start' ORDER BY seq").pluck().all() as string[]).map((detail) => JSON.parse(detail) as { revived: string[] });
    expect(starts.map((detail) => detail.revived)).toEqual([[], [`import ${NOTES}`]]);

    now = start + DAY;
    await toDeath(10);
    now = start + DAY + 6 * HOUR;
    await until("a tick six hours on", () => home.stats().ticks.at_ms === now);
    await until("the hour's prune", () => count(root, "SELECT count(*) FROM jobs WHERE kind = 'sweep' AND state <> 'done'") === 0);
    expect([failures(), job()?.state]).toEqual([15, "dead"]);
    expect(count(root, "SELECT count(*) FROM events WHERE kind = 'revived'")).toBe(1);
    const free = JSON.parse(readHome(root, (db) => db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(FREE_BYTES) as string)) as FreeDay[];
    expect(free.map((day) => day.day)).toEqual(["2026-10-10", "2026-10-11"]);
    expect(free.every((day) => day.bytes > 0 && day.disk === readDisk(root, now).disk)).toBe(true);
    artifact(root, "dead", { failures: failures(), starts, free });
  });
});

describe("a dead import revived", () => {
  it("a revived import resumes its run with the counts of its attempts gone, so the run says it landed less than it did", async () => {
    const start = Date.UTC(2026, 9, 10, 6, 0);
    let now = start;
    const root = makeRoot("lifestream-revived-", { sources: { [NOTES]: "fake-rows" } });
    let home = await startHome(root, { stopGraceMs: 50, registry: FAKES, clock: () => now, log: () => undefined, tickMs: TICK_MS });
    onTestFinished(async () => {
      await home.stop();
      removeRoot(root);
    });
    const failing = join(root, "connector-fails");
    writeFileSync(failing, "");
    const lines = Array.from({ length: 2_500 }, (_, n) => JSON.stringify(note(`n${n}`, start - HOUR + n)));
    await shipFiles(root, NOTES, start - 10 * MINUTE, { "rows.ndjson": Buffer.from(`${[...lines, JSON.stringify({ fault_if: failing })].join("\n")}\n`) });
    const failures = () => count(root, "SELECT count(*) FROM events WHERE kind = 'import-failed'");
    for (let tries = 1; tries <= 5; tries++) {
      await until(`failure ${tries}`, () => failures() === tries);
      now += 31 * MINUTE;
      await askHome(testSocket(root), "settings");
    }
    await until("the job dead", () => count(root, "SELECT count(*) FROM jobs WHERE kind = 'import' AND state = 'dead'") === 1);
    rmSync(failing);
    await home.stop();
    home = await startHome(root, { stopGraceMs: 50, registry: FAKES, clock: () => now, log: () => undefined, tickMs: TICK_MS });
    await until("the delivery imported", () => count(root, "SELECT count(*) FROM deliveries WHERE state = 'imported'") === 1);
    const runs = readHome(root, (db) => db.prepare("SELECT outcome, counts FROM runs WHERE kind = 'import'").all()) as { outcome: string; counts: string }[];
    const counts = JSON.parse(runs[0]!.counts) as { new: number; duplicated: number };
    artifact(root, "revived-import", { runs, notes: count(root, "SELECT count(*) FROM heads") });
    expect(runs.map((run) => run.outcome)).toEqual(["ok"]);
    expect(counts.new).toBe(2_500);
  });
});

describe("a nudge the home answered with an error", () => {
  it("a sealed delivery whose manifest cannot be read is asked about again, not left for a whole look, and indexed once it can be read", async () => {
    const start = Date.UTC(2026, 9, 10, 6, 0);
    const root = makeRoot("lifestream-nudge-error-", { sources: { [NOTES]: "fake-rows" } });
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, clock: () => start, log: () => undefined, tickMs: TICK_MS });
    onTestFinished(async () => {
      await home.stop();
      removeRoot(root);
    });
    await until("the start's inbox look", () => readHome(root, (db) => db.prepare("SELECT state FROM jobs WHERE kind = 'index-inbox'").pluck().get()) === "done");
    const id = await ship(root, { source: NOTES, fetched_ms: start - MINUTE, rows: [note("n1", start - MINUTE)] }, false);
    const manifest = join(root, "inbox", id, MANIFEST_FILE);
    const sealed = readFileSync(manifest);
    writeFileSync(manifest, "{ a synthetic manifest cut short");
    const logs: JsonObject[] = [];
    const kept = nudges(testSocket(root), (line) => logs.push(line));
    onTestFinished(() => kept.close());
    kept.owe(id);
    await until("the home's error logged", () => logs.length === 1);
    expect([logs[0], kept.owing(), deliveryState(root, id)]).toEqual([{ nudge: "failed", delivery: id, tries: 1, error: expect.any(String) }, [id], undefined]);
    writeFileSync(manifest, sealed);
    await until("the nudge answered", () => logs.some((line) => line.nudge === "answered"));
    expect([logs.at(-1), kept.owing(), count(root, "SELECT count(*) FROM deliveries WHERE id = ?", id)]).toEqual([{ nudge: "answered", delivery: id, tries: logs.at(-1)!.tries }, [], 1]);
    expect(logs.filter((line) => line.nudge === "failed")).toHaveLength(1);
    artifact(root, "nudge-error", { logs });
  });

  it("a sealed delivery whose lane routes to no source is answered with an error and kept, and indexed at the first try after its source's lane is mended", async () => {
    const start = Date.UTC(2026, 9, 10, 6, 0);
    const root = makeRoot("lifestream-nudge-unrouted-", { sources: { [NOTES]: "fake-rows" } });
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, clock: () => start, log: () => undefined, tickMs: TICK_MS });
    onTestFinished(async () => {
      await home.stop();
      removeRoot(root);
    });
    await until("the start's inbox look", () => readHome(root, (db) => db.prepare("SELECT state FROM jobs WHERE kind = 'index-inbox'").pluck().get()) === "done");
    const lane = "apple-notes:local:mac-bb42";
    const id = await ship(root, { source: lane, fetched_ms: start - MINUTE, rows: [note("n1", start - MINUTE)] }, false);
    const logs: JsonObject[] = [];
    const kept = nudges(testSocket(root), (line) => logs.push(line));
    onTestFinished(() => kept.close());
    kept.owe(id);
    await until("the home's error logged", () => logs.length === 1);
    expect([logs[0], kept.owing(), count(root, "SELECT count(*) FROM deliveries WHERE id = ?", id)])
      .toEqual([{ nudge: "failed", delivery: id, tries: 1, error: expect.stringContaining("feeds no source") }, [id], 0]);
    const writer = new Database(join(root, "home.db"));
    writer.prepare("UPDATE sources SET options = ? WHERE id = ?").run(JSON.stringify({ lane }), NOTES);
    writer.close();
    await until("the nudge answered", () => logs.some((line) => line.nudge === "answered"));
    expect([kept.owing(), readHome(root, (db) => db.prepare("SELECT source FROM deliveries WHERE id = ?").pluck().all(id))]).toEqual([[], [NOTES]]);
    expect(count(root, "SELECT count(*) FROM jobs WHERE kind = 'index-inbox' AND state <> 'done'")).toBe(0);
    artifact(root, "nudge-unrouted", { logs });
  });

  it("a dead inbox look: the whole look asked for, and a nudge of an archive not yet listed, are each answered with an error naming it and kept; revived, each is answered", async () => {
    const start = Date.UTC(2026, 9, 10, 6, 0);
    const root = makeRoot("lifestream-nudge-dead-look-", { sources: { [NOTES]: "fake-rows" } });
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, clock: () => start, log: () => undefined, tickMs: TICK_MS });
    onTestFinished(async () => {
      await home.stop();
      removeRoot(root);
    });
    const look = () => readHome(root, (db) => db.prepare("SELECT state FROM jobs WHERE kind = 'index-inbox'").pluck().get());
    await until("the start's inbox look", () => look() === "done");
    const writer = new Database(join(root, "home.db"));
    writer.prepare("UPDATE jobs SET state = 'dead' WHERE kind = 'index-inbox' AND key = 'inbox'").run();
    writer.close();
    const imported = await ship(root, { source: NOTES, fetched_ms: start - MINUTE, rows: [], facts: { import: { kind: "google-takeout" } } }, false);
    const logs: JsonObject[] = [];
    const kept = nudges(testSocket(root), (line) => logs.push(line));
    onTestFinished(() => kept.close());
    kept.owe();
    kept.owe(imported);
    await until("both errors logged", () => logs.length === 2);
    const dead = { nudge: "failed", tries: 1, error: expect.stringContaining("the inbox look (index-inbox inbox) is dead") };
    expect([logs, kept.owing(), look()]).toEqual([[{ ...dead, delivery: null }, { ...dead, delivery: imported }], [null, imported], "dead"]);
    await askHome(testSocket(root), "run", ["index-inbox", "inbox"]);
    await until("both answered", () => logs.filter((line) => line.nudge === "answered").length === 2);
    expect(kept.owing()).toEqual([]);
    artifact(root, "nudge-dead-look", { logs });
  });
});

describe("a pause", () => {
  it("a prune lifts a pause, its work starts before it is resumed, or never runs once resumed", async () => {
    const start = Date.UTC(2026, 9, 10, 6, 0);
    let now = start;
    const root = makeRoot("lifestream-pause-", { sources: { [NOTES]: "fake-rows" }, clocks: true });
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, clock: () => now, log: () => undefined, tickMs: TICK_MS });
    onTestFinished(async () => {
      await home.stop();
      removeRoot(root);
    });
    const sock = testSocket(root);
    await askHome(sock, "pause", ["kind:import", "--reason", "held until resumed"]);
    const held = await ship(root, { source: NOTES, fetched_ms: start - 10 * MINUTE, rows: [note("held", start - 10 * MINUTE)] });
    await until("indexed", () => deliveryState(root, held) === "sealed");
    now = start + 2 * DAY;
    await until("a tick two days on", () => home.stats().ticks.at_ms === now);
    const controls = readHome(root, (db) => db.prepare("SELECT target FROM controls ORDER BY target").pluck().all()) as string[];
    expect([controls, deliveryState(root, held)]).toEqual([["kind:import"], "sealed"]);
    await askHome(sock, "resume", ["kind:import"]);
    await until("the held import ran", () => deliveryState(root, held) === "imported");
    artifact(root, "pause", { controls });
  });
});

describe("the home's own checkpoints", () => {
  it("an error from the checkpoint at the mark is lost, or reported against a commit that stood; one that goes through never empties the log", async () => {
    const root = makeRoot("lifestream-mark-", { sources: { [NOTES]: "fake-rows" } });
    const logs: Line[] = [];
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: (line) => logs.push(JSON.parse(line) as Line), tickMs: TICK_MS });
    onTestFinished(async () => {
      await home.stop();
      removeRoot(root);
    });
    const at = Date.now() - MINUTE;

    await until("the start's jobs ended", () => count(root, "SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')") === 0);
    fillLog(root, "a");
    expect(frames(root)).toBeGreaterThanOrEqual(CHECKPOINT_PAGES);
    await until("the home emptied the log", () => frames(root) < CHECKPOINT_PAGES);

    const pragma = Database.prototype.pragma;
    const errors = [new Database.SqliteError("database is locked", "SQLITE_BUSY"), new Database.SqliteError("disk I/O error", "SQLITE_IOERR")];
    Database.prototype.pragma = function (this: Database.Database, source: string, options?: Database.PragmaOptions) {
      if (source === "wal_checkpoint(TRUNCATE)" && this.name.endsWith("home.db")) throw errors.shift() ?? new Error("a third checkpoint at the mark");
      return pragma.call(this, source, options);
    } as typeof pragma;
    onTestFinished(() => { Database.prototype.pragma = pragma; });
    const id = await ship(root, { source: NOTES, fetched_ms: at, rows: [note("kept", at)] });
    await until("the delivery imported", () => deliveryState(root, id) === "imported");
    fillLog(root, "b");
    const why = await home.stopped;
    expect(why).toBe("storage: SQLITE_IOERR: disk I/O error");
    expect(logs.filter((line) => line.storage === "failed")).toEqual([expect.objectContaining({ database: "home.db", error: "SQLITE_IOERR: disk I/O error" })]);
    expect(logs.filter((line) => line.checkpoint === "failed")).toEqual([expect.objectContaining({ database: "home.db", error: "SQLITE_BUSY: database is locked" })]);
    expect(logs.filter((line) => line.loop === "failed")).toEqual([]);
    expect(logs.filter((line) => line.commit === "failed")).toEqual([]);
    expect(deliveryState(root, id)).toBe("imported");
    expect(count(root, "SELECT count(*) FROM heads WHERE key = 'kept'")).toBe(1);
    artifact(root, "mark-checkpoint", { why, failed: logs.filter((line) => line.storage !== undefined || line.checkpoint !== undefined || line.loop !== undefined) });
  });

  it("automatic checkpoints come back after whole-file work, or leave a verb with no home running", async () => {
    const root = makeRoot("lifestream-automatic-", { sources: {} });
    onTestFinished(() => removeRoot(root));
    const opened: Database.Database[] = [];
    const pragma = Database.prototype.pragma;
    Database.prototype.pragma = function (this: Database.Database, source: string, options?: Database.PragmaOptions) {
      if (source.startsWith("wal_autocheckpoint =") && this.name.endsWith("home.db") && !opened.includes(this)) opened.push(this);
      return pragma.call(this, source, options);
    } as typeof pragma;
    onTestFinished(() => { Database.prototype.pragma = pragma; });
    const automatic = (db: Database.Database) => db.pragma("wal_autocheckpoint", { simple: true });

    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined, tickMs: TICK_MS });
    expect(opened.map(automatic)).toEqual([0]);
    await askHome(testSocket(root), "maintenance", ["checkpoint"]);
    expect(opened.slice(1).map(automatic)).toEqual([0]);
    await home.stop();

    const verb = openHome(openHomeFolder(root), "migrate");
    expect(opened.slice(2).map(automatic)).toEqual([CHECKPOINT_PAGES]);
    verb.close();
  });

  it("the layer line is missing from the checkpoint clock, there without it, without its turns over budget or the loop's delay, or a window runs on into the next", async () => {
    const root = makeRoot("lifestream-layer-", { sources: { [NOTES]: "fake-rows" }, clocks: true });
    const logs: Line[] = [];
    let ahead = 0;
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, clock: () => Date.now() + ahead, log: (line) => logs.push(JSON.parse(line) as Line), tickMs: TICK_MS });
    onTestFinished(async () => {
      await home.stop();
      removeRoot(root);
    });
    const layers = () => logs.flatMap((line) => (line.layer === undefined ? [] : [line.layer as Line]));
    const ticked = async (what: string) => {
      const from = home.stats().ticks.count;
      await until(what, () => home.stats().ticks.count > from + 1);
    };
    const at = Date.now() - MINUTE;
    const id = await ship(root, { source: NOTES, fetched_ms: at, rows: [note("n1", at)] });
    await until("the delivery imported", () => deliveryState(root, id) === "imported");
    await ticked("two ticks before the clock");
    expect(layers()).toEqual([]);

    ahead += 5 * MINUTE;
    await until("the clock's layer line", () => layers().length === 1);
    expect(layers()[0]).toEqual({
      commits: expect.any(Number), p50_ms: expect.any(Number), p99_ms: expect.any(Number), max_ms: expect.any(Number),
      due: { p50_ms: expect.any(Number), p99_ms: expect.any(Number), max_ms: expect.any(Number) },
      checkpoints: 1, checkpoint_max_ms: expect.any(Number), copies: expect.any(Number), copy_max_ms: expect.any(Number), truncate: { busy: expect.any(Number), log: expect.any(Number), checkpointed: expect.any(Number) }, polls: { calls: expect.any(Number), cursor_bytes: expect.any(Number), memory_rows: expect.any(Number) },
      over: expect.any(Object), loop: { p99_ms: expect.any(Number), max_ms: expect.any(Number) },
    });
    const first = layers()[0]!;
    expect(first.commits).toBeGreaterThan(1);
    expect(first.p50_ms as number).toBeLessThanOrEqual(first.p99_ms as number);
    expect(first.p99_ms as number).toBeLessThanOrEqual(first.max_ms as number);
    expect((first.due as Line).max_ms as number).toBeLessThanOrEqual(first.max_ms as number);

    const later = await ship(root, { source: NOTES, fetched_ms: at + 1, rows: [note("n2", at + 1)] });
    await until("the second delivery imported", () => deliveryState(root, later) === "imported");
    ahead += 5 * MINUTE;
    await until("the next layer line", () => layers().length === 2);
    expect(layers()[1]).toMatchObject({ checkpoints: 1, truncate: { busy: expect.any(Number), log: expect.any(Number), checkpointed: expect.any(Number) } });
    artifact(root, "layer", { layers: layers() });
  });
});

describe("low space", () => {
  it("history fills the last of the disk, or new data waits with it, one stated hours before it reached the home among it", async () => {
    const LIVE = "apple-notes:local:mac-live";
    const LATE = "apple-notes:local:mac-late";
    const OLD = "apple-notes:local:mac-old";
    const root = makeRoot("lifestream-low-", { sources: { [LIVE]: "fake-rows", [LATE]: "fake-rows", [OLD]: "fake-rows" }, helpers: 3 });
    const free = freeSpace(4e9);
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined, tickMs: TICK_MS });
    onTestFinished(async () => {
      await home.stop();
      removeRoot(root);
    });
    const old = await ship(root, { source: OLD, fetched_ms: Date.now() - MINUTE, rows: [note("old", Date.now() - 30 * DAY)], facts: { history: true } });
    const late = await ship(root, { source: LATE, fetched_ms: Date.now() - 3 * HOUR, rows: [note("late", Date.now() - 3 * HOUR)] });
    const live = await ship(root, { source: LIVE, fetched_ms: Date.now() - MINUTE, rows: [note("live", Date.now() - MINUTE)] });
    await until("the new data imported", () => deliveryState(root, live) === "imported" && deliveryState(root, late) === "imported");
    expect(deliveryState(root, old)).toBe("sealed");
    expect(readHome(root, (db) => db.prepare("SELECT state, lane FROM jobs WHERE kind = 'import' AND key = ?").get(OLD))).toEqual({ state: "queued", lane: LANE.history });
    free.set(6e9);
    await until("history imported once there is room", () => deliveryState(root, old) === "imported");
    artifact(root, "low", { old, late, live });
  });
});
