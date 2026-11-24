import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import workerThreads from "node:worker_threads";
import Database from "better-sqlite3";
import { homeSchema } from "@lifestreamprotocol/core";
import { describe, expect, it, onTestFinished } from "vitest";
import { startHome } from "./home.js";
import { readHold } from "./hold.js";
import { awayWords, readHome as readHomeJson } from "./lifecycle.js";
import { machine } from "./machine.js";
import { askHome } from "./socket.js";
import { artifact, ChildHome, FAKES, makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { ship, shipFiles } from "./test/harness-deliveries.js";
import { startHere } from "./test/harness-home.js";
import { testSocket } from "./test/folder.js";


const MINUTE = 60_000;

describe("storage belongs to the file that failed", () => {
  it("a damaged delivery database is refused with SQLite's code, its stream and the home go on importing", async () => {
    const unreadable = "wispr-flow:local:mac-unreadable";
    const damaged = "wispr-flow:local:mac-damaged";
    const healthy = "apple-notes:local:mac-healthy";
    const root = makeRoot("lifestream-storage-origin-", { sources: { [unreadable]: "wispr-flow-mac", [damaged]: "wispr-flow-mac", [healthy]: "fake-rows" } });
    const child = new ChildHome(root);
    onTestFinished(async () => { await child.stop(); removeRoot(root); });
    child.start();
    await child.ready();
    const store = join(root, "flow.sqlite");
    const db = new Database(store);
    db.exec("CREATE TABLE History (transcriptEntityId TEXT, timestamp TEXT)");
    db.prepare("INSERT INTO History VALUES (?, ?)").run("synthetic-dictation", "2026-10-01 10:00:00.000 +00:00");
    db.close();
    const at = Date.now() - MINUTE;
    await shipFiles(root, unreadable, at, { "flow.sqlite": Buffer.alloc(4096, 42) });
    await shipFiles(root, damaged, at, { "flow.sqlite": readFileSync(store).fill(42, 4096) });
    const deliveries = () => readHome(root, (db) => db.prepare(`SELECT d.source, d.state, d.refused, json_extract(r.counts, '$.refusals[0].violations[0]') AS why
      FROM deliveries d LEFT JOIN runs r ON r.id = d.run ORDER BY d.source`).all()) as { source: string; state: string; refused: number; why: string | null }[];
    await until("both damaged deliveries refused, or the home stopped", () => deliveries().filter((row) => row.refused === 1).length === 2 || !child.alive);
    expect(child.alive).toBe(true);
    const good = await ship(root, { source: healthy, fetched_ms: at, rows: [{ kind: "note", key: "good", content: { text: "synthetic healthy note", at }, at }] });
    await until("the healthy source imported, or the home stopped", () => deliveries().some((row) => row.source === healthy && row.state === "imported") || !child.alive);
    expect(child.alive).toBe(true);
    const rows = deliveries();
    expect(rows).toEqual([
      { source: healthy, state: "imported", refused: 0, why: null },
      { source: damaged, state: "imported", refused: 1, why: expect.stringMatching(/^after \d+ rows: SqliteError: SQLITE_CORRUPT: .*database disk image is malformed/u) },
      { source: unreadable, state: "imported", refused: 1, why: expect.stringContaining("SQLITE_NOTADB") },
    ]);
    expect(readHome(root, (db) => db.prepare("SELECT count(*) FROM events WHERE kind = 'import-failed'").pluck().get())).toBe(0);
    const log = readFileSync(join(root, "logs", "home.log"), "utf8");
    expect(log).not.toContain('"storage":"failed"');
    artifact(root, "storage-delivery", { deliveries: rows, good });
  });

  it("a home.db fault in a verb's read stops the home, as one in a commit does", async () => {
    const root = makeRoot("lifestream-storage-verb-", { sources: {} });
    const child = new ChildHome(root);
    onTestFinished(async () => { await child.stop(); removeRoot(root); });
    child.start("storage-verb");
    await child.ready();
    await expect(askHome(testSocket(root), "drop", ["item", "notes", "photo:n1"])).rejects.toThrow(/^SQLITE_IOERR: disk I\/O error/u);
    await until("the home stopped by itself", () => !child.alive);
    expect(await child.stop()).toEqual({ code: 1, signal: null });
    const log = readFileSync(join(root, "logs", "home.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(log.at(-1)).toMatchObject({ home: "stopped", why: "storage: SQLITE_IOERR: disk I/O error" });
    artifact(root, "storage-verb", { log, exits: child.exits });
  });

  it.each(["storage-helper-open", "storage-helper-import"])("%s stops the home with its origin and code intact", async (point) => {
    const source = "apple-notes:local:mac-0001";
    const root = makeRoot("lifestream-storage-helper-", { sources: { [source]: "fake-rows" } });
    const child = new ChildHome(root);
    onTestFinished(async () => { await child.stop(); removeRoot(root); });
    child.start(point);
    await child.ready();
    let id: string | undefined;
    if (point === "storage-helper-import") {
      const at = Date.now() - MINUTE;
      id = await ship(root, { source, fetched_ms: at, rows: [{ kind: "note", key: "fault", content: { text: "synthetic note", at }, at }] });
    }
    await until("the helper fault stopped the home or failed a job", () => !child.alive || readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE error LIKE '%disk I/O error%'").pluck().get()) !== 0);
    expect(await child.stop()).toEqual({ code: 1, signal: null });
    const log = readFileSync(join(root, "logs", "home.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const failures = log.filter((line) => line.storage === "failed");
    expect(failures).toEqual([expect.objectContaining({ error: expect.stringContaining("SQLITE_IOERR") })]);
    if (id !== undefined) expect(failures[0]!.error).toContain(id);
    expect(log.at(-1)).toMatchObject({ home: "stopped", why: expect.stringMatching(/^storage: SQLITE_IOERR/u) });
    artifact(root, point, { log, exits: child.exits });
  });
});

describe("whole-file work opens home.db again", () => {
  it("a throw that is not SQLite's leaves home.db closed and new helpers beside it, every commit a TypeError", async () => {
    const root = makeRoot("lifestream-reopen-", { sources: {} });
    onTestFinished(() => removeRoot(root));
    const logs: Record<string, unknown>[] = [];
    const home = await startHere(root, { tickMs: TICK_MS, log: (line) => logs.push(JSON.parse(line) as Record<string, unknown>) });

    const { Worker } = workerThreads;
    let helpers = 0;
    workerThreads.Worker = class extends Worker {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        helpers++;
      }
    };
    syncBuiltinESMExports();
    onTestFinished(() => { workerThreads.Worker = Worker; syncBuiltinESMExports(); });

    const db = new Database(join(root, "home.db"));
    db.pragma(`user_version = ${homeSchema.latest + 1}`);
    db.close();
    await expect(askHome(testSocket(root), "maintenance", ["checkpoint"])).rejects.toThrow();
    const why = await home.stopped;
    expect(why).toMatch(/^home\.db did not open again: home\.db is at version \d+; this release reads \d+: a newer release wrote it/u);
    expect(helpers).toBe(0);
    expect(logs.filter((line) => line.loop !== undefined || line.close !== undefined)).toEqual([]);
    expect(logs.at(-1)).toMatchObject({ home: "stopped", why });
    artifact(root, "reopen", { why, helpers });
  });
});

describe("storage: the drive goes under a running home, then comes back", () => {
  it("a storage error leaves the home running paused, or a start with the drive back loses a job's work or what the door sealed meanwhile", async () => {
    const root = makeRoot("lifestream-storage-", { sources: { "apple-notes:local:device-a": "fake-rows" } });
    const child = new ChildHome(root);
    onTestFinished(async () => {
      await child.stop();
      removeRoot(root);
    });
    const count = (sql: string) => readHome(root, (db) => db.prepare(sql).pluck().get() as number);
    const log = () => readFileSync(join(root, "logs", "home.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    child.start("storage");
    await child.ready();
    const hold = join(root, "extract-hold");
    writeFileSync(hold, "");
    const at = Date.now() - 10 * MINUTE;
    await ship(root, { source: "apple-notes:local:device-a", fetched_ms: at, rows: [{ kind: "note", key: "n1", content: { text: "held when the drive went", at, hold }, at }] });
    await until("the held extract", () => existsSync(`${hold}.held`) && count("SELECT count(*) FROM jobs WHERE kind = 'extract' AND state = 'running'") === 1);
    writeFileSync(join(root, "disk-gone"), "");
    const exit = await child.exited();
    expect(exit).toEqual({ code: 1, signal: null });
    const lines = log();
    expect(lines.filter((line) => line.storage === "failed")).toEqual([expect.objectContaining({ error: expect.stringContaining("SQLITE_IOERR") })]);
    expect(lines.at(-1)).toMatchObject({ home: "stopped", why: expect.stringMatching(/^storage: SQLITE_IOERR/u) });
    const id = readHomeJson(root).id;
    expect(readHold(machine(), id)).toBeNull();

    await ship(root, { source: "apple-notes:local:device-a", fetched_ms: at + MINUTE, rows: [{ kind: "note", key: "n2", content: { text: "sealed while the home was down", at: at + MINUTE }, at: at + MINUTE }] });
    rmSync(join(root, "disk-gone"));
    rmSync(hold);
    child.start();
    await child.ready();
    expect(readHold(machine(), id)).toBeNull();
    await until("both deliveries imported and extracted, nothing left running", () =>
      count("SELECT count(*) FROM deliveries WHERE state = 'imported'") === 2 &&
      count("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running', 'dead')") === 0 &&
      count("SELECT count(*) FROM extracts WHERE family = 'notes' AND instr(content, 'sealed while the home was down') > 0 AND instr(content, 'held when the drive went') > 0") === 1);
    artifact(root, "storage-exit", { exit, log: lines });
  });
});

describe("the folder goes from under a running home", () => {
  it("a home whose folder went away (a drive unplugged) runs on, says nothing, or makes the folder again", async () => {
    const root = makeRoot("lifestream-gone-", { sources: { "apple-notes:local:device-a": "fake-rows" } });
    const away = `${root}-away`;
    onTestFinished(() => { removeRoot(root); removeRoot(away); });
    let now = Date.UTC(2026, 9, 3, 10);
    const logs: string[] = [];
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, clock: () => now, log: (line) => logs.push(line), tickMs: TICK_MS });
    onTestFinished(() => home.stop());
    await until("a tick", () => home.stats().ticks.count > 0);
    renameSync(root, away);
    now += 2_000;
    const why = await home.stopped;
    expect(why).toBe(awayWords(root));
    const lines = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.at(-1)).toEqual({ at: expect.any(String), home: "stopped", why });
    expect(existsSync(root)).toBe(false);
    artifact(away, "folder-gone", { why, log: lines });
  });
});

describe("storage: the drive goes under at each of the start's writes and the loop's first", () => {
  it("a storage error at each start write or the loop's first tick stops the home", async () => {
    const root = makeRoot("lifestream-storage-first-", { sources: { "apple-notes:local:device-a": "fake-rows" } });
    onTestFinished(() => removeRoot(root));
    const exits: { writes: number; code: number | null; why: unknown }[] = [];
    for (let writes = 0; ; writes++) {
      rmSync(join(root, "logs"), { recursive: true, force: true });
      writeFileSync(join(root, "disk-gone"), String(writes));
      const child = new ChildHome(root);
      onTestFinished(async () => { await child.stop(); });
      child.start("storage");
      const exit = await child.exited();
      const lines = existsSync(join(root, "logs", "home.log"))
        ? readFileSync(join(root, "logs", "home.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : [];
      exits.push({ writes, code: exit.code, why: lines.at(-1)?.why });
      if (lines.some((line) => line.home === "started")) break;
    }
    artifact(root, "storage-first-tick", { exits });
    expect(exits.filter((exit) => exit.code !== 1)).toEqual([]);
  });
});
