import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { runCli } from "./cli.js";
import { startHome, type Home } from "./home.js";
import { screenFileOf } from "./screen-index.js";
import { bucketOf } from "./screen-source.js";
import { searchFileOf } from "./search-index.js";
import { askHome } from "./socket.js";
import { effective } from "./settings.js";
import fakeRegistry from "./test/fakes.js";
import { ChildHome, FAKES, LOOK_MS, makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { statusOf } from "./test/harness-status.js";
import { openHomeFolder } from "@lifestreamprotocol/core";
import { homeOf } from "./registry.js";
import { testSocket } from "./test/folder.js";


const SOURCE = "screen:local:mac-0001";
const MACHINE = "mac-0001";
const MINUTE = 60_000;
const T0 = Date.parse("2026-09-28T06:00:00Z");

const frame = (key: string, at: number, title: string, ...lines: string[]) => ({
  kind: "frame", key, at,
  content: {
    at, status: "captured", displayID: 1,
    application: { name: "Example Editor", bundleID: "com.example.editor" },
    frontWindow: { windowID: 11 }, windows: [{ windowID: 11, title }],
    accessibility: { nodes: lines.map((value) => ({ depth: 1, role: "AXStaticText", value })) },
    ocr: [],
  },
});

function fileOf(root: string): string {
  return screenFileOf(searchFileOf(root, process.env.LIFESTREAM_MACHINE_DIR!));
}

interface Read {
  file: number;
  seq: number;
  generation: string;
  segments: Record<string, string>;
}

function readIndex(root: string): Read | undefined {
  const path = fileOf(root);
  if (!existsSync(path)) return undefined;
  const db = new Database(path, { readonly: true, timeout: 10_000 });
  try {
    const meta = (name: string) => db.prepare("SELECT value FROM meta WHERE name = ?").pluck().get(name) as string;
    const position = JSON.parse(meta("position")) as { seq: number } | null;
    const segments = Object.fromEntries((db.prepare("SELECT machine || '/' || start_ms AS record, version FROM screen_segment ORDER BY record").all() as { record: string; version: string }[]).map((row) => [row.record, row.version]));
    return { file: statSync(path).ino, seq: position?.seq ?? 0, generation: meta("generation"), segments };
  } finally {
    db.close();
  }
}

function matching(root: string, words: string, file = fileOf(root)): string[] {
  const db = new Database(file, { readonly: true, timeout: 10_000 });
  try {
    return (db.prepare(`SELECT DISTINCT s.machine || '/' || s.start_ms AS record FROM screen_fts JOIN screen_row r ON r.slot = screen_fts.rowid JOIN screen_segment s ON s.id = r.segment
      WHERE screen_fts MATCH ? ORDER BY record`).all(words) as { record: string }[]).map((row) => row.record);
  } finally {
    db.close();
  }
}

const record = (at: number) => `${MACHINE}/${at}`;

describe("screen job", () => {
  let root: string;
  let home: Home | undefined;
  let shipped = 0;

  const sock = () => testSocket(root);
  const send = async (rows: Record<string, unknown>[]) => {
    await ship(root, { source: SOURCE, fetched_ms: Date.now() + shipped, rows: rows as never });
    shipped++;
  };
  const top = () => readHome(root, (db) => db.prepare("SELECT coalesce(max(seq), 0) FROM statements").pluck().get() as number);
  const cursor = () => readHome(root, (db) => db.prepare("SELECT seq FROM cursors WHERE name = 'screen'").pluck().get() as number | undefined);
  const counts = () => readHome(root, (db) => (db.prepare("SELECT counts FROM runs WHERE kind = 'index' AND subject = 'screen' ORDER BY id").all() as { counts: string }[])
    .map((row) => JSON.parse(row.counts) as { appended: number; rebuilt: number }))
    .reduce((sum, each) => ({ appended: sum.appended + each.appended, rebuilt: sum.rebuilt + each.rebuilt }), { appended: 0, rebuilt: 0 });
  const idle = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE kind = 'index' AND key = 'screen' AND state <> 'done' AND NOT (state = 'queued' AND not_before_ms > ?)").pluck().get(Date.now()) as number) === 0;
  const wake = () => readHome(root, (db) => db.prepare("SELECT not_before_ms FROM jobs WHERE kind = 'index' AND key = 'screen' AND state = 'queued'").pluck().get() as number | undefined);
  const imported = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE state = 'imported'").pluck().get()) === shipped;
  const settle = async () => {
    await until("the home imported every delivery", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE state = 'imported'").pluck().get()) === shipped);
    await until("the screen index read every statement", () => {
      const queued = readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE kind = 'index' AND key = 'screen' AND state <> 'done'").pluck().get() as number);
      return queued === 0 && readIndex(root)?.seq === top() && cursor() === top();
    });
  };

  beforeAll(async () => {
    root = makeRoot("lifestream-screen-job-", { sources: { [SOURCE]: "fake-rows" }, settings: { "families.screen": { index: true } } });
    home = await startHome(root, { registry: FAKES, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, log: () => undefined });
  });

  afterAll(async () => {
    await home?.stop().catch(() => undefined);
    if (root !== undefined) removeRoot(root);
  });

  it("appends segments that come in order, one a 5-minute bucket, and rebuilds none", async () => {
    await send([frame("f1", T0, "Notes", "the lighthouse keeper"), frame("f2", T0 + 2_000, "Notes", "the lighthouse keeper", "alpha line")]);
    await settle();
    await send([frame("f3", T0 + 5 * MINUTE, "Notes", "bravo line")]);
    await settle();
    expect(Object.keys(readIndex(root)!.segments)).toEqual([record(T0), record(T0 + 5 * MINUTE)]);
    expect(matching(root, "lighthouse")).toEqual([record(T0)]);
    expect(matching(root, "bravo")).toEqual([record(T0 + 5 * MINUTE)]);
    expect(counts()).toEqual({ appended: 2, rebuilt: 0 });
  });

  it("rebuilds the machine-day for a segment earlier than one it holds", async () => {
    await send([frame("f0", T0 - 5 * MINUTE, "Notes", "charlie line")]);
    await settle();
    expect(Object.keys(readIndex(root)!.segments)).toEqual([record(T0 - 5 * MINUTE), record(T0), record(T0 + 5 * MINUTE)]);
    expect(matching(root, "charlie")).toEqual([record(T0 - 5 * MINUTE)]);
    expect(matching(root, "bravo")).toEqual([record(T0 + 5 * MINUTE)]);
    expect(counts()).toEqual({ appended: 2, rebuilt: 1 });
  });

  it("reads a frame restated with other words as another version of its segment", async () => {
    const before = readIndex(root)!.segments;
    await send([frame("f2", T0 + 2_000, "Notes", "the lighthouse keeper", "delta line")]);
    await settle();
    const after = readIndex(root)!.segments;
    expect(after[record(T0)]).not.toBe(before[record(T0)]);
    expect(after[record(T0 + 5 * MINUTE)]).toBe(before[record(T0 + 5 * MINUTE)]);
    expect(matching(root, "alpha")).toEqual([]);
    expect(matching(root, "delta")).toEqual([record(T0)]);
  });

  it("loses nothing when the home is killed between the index's write and the home's commit", async () => {
    await home!.stop();
    home = undefined;
    const child = new ChildHome(root);
    child.start("screen.indexed");
    await child.ready();
    await send([frame("f4", T0 + 10 * MINUTE, "Notes", "echo line")]);
    expect(await child.exited()).toEqual({ code: null, signal: "SIGKILL" });
    rmSync(sock().path, { force: true });
    expect(matching(root, "echo")).toEqual([record(T0 + 10 * MINUTE)]);
    expect(cursor()).toBeLessThan(readIndex(root)!.seq);
    home = await startHome(root, { registry: FAKES, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, log: () => undefined });
    await settle();
    expect(matching(root, "echo")).toEqual([record(T0 + 10 * MINUTE)]);
    expect(cursor()).toBe(readIndex(root)!.seq);
  });

  it("builds again beside the file on a rebuild, the last whole file answering meanwhile, a build killed partway going on, and the build the same as the appends made", async () => {
    const before = readIndex(root)!;
    const words = ["lighthouse", "bravo", "charlie", "delta", "echo"];
    const found = words.map((word) => matching(root, word));
    await home!.stop();
    home = undefined;
    const child = new ChildHome(root);
    child.start("screen.indexed");
    await child.ready();
    await askHome(sock(), "rebuild", ["screen"]);
    expect(await child.exited()).toEqual({ code: null, signal: "SIGKILL" });
    rmSync(sock().path, { force: true });
    expect(existsSync(join(fileOf(root), "..", "screen.building.db"))).toBe(true);
    expect(readIndex(root)).toEqual(before);
    expect(matching(root, "charlie")).toEqual([record(T0 - 5 * MINUTE)]);
    home = await startHome(root, { registry: FAKES, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, log: () => undefined });
    await askHome(sock(), "rebuild", ["screen"]);
    await until("the build became screen.db", () => readIndex(root) !== undefined && readIndex(root)!.file !== before.file);
    await settle();
    const after = readIndex(root)!;
    expect(existsSync(join(fileOf(root), "..", "screen.building.db"))).toBe(false);
    expect(after.generation).not.toBe(before.generation);
    expect(after.segments).toEqual(before.segments);
    expect(words.map((word) => matching(root, word))).toEqual(found);
    expect(matching(root, "alpha")).toEqual([]);
  });

  it("holds the bucket the clock is in until a later frame closes it, then appends it once, rebuilding nothing; a bucket still open wakes the job when it can close", async () => {
    const runs = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM runs WHERE kind = 'index' AND subject = 'screen'").pluck().get() as number);
    const base = counts();
    const ran = runs();
    const open = bucketOf(Date.now()) - 5 * MINUTE;
    await send([frame("live-1", open + 1_000, "Notes", "foxtrot line")]);
    await until("the screen job read the frame and held its bucket", () => imported() && runs() > ran && idle());
    expect(readIndex(root)!.segments[record(open)]).toBeUndefined();
    expect(readIndex(root)!.seq).toBeLessThan(top());
    expect(wake()).toBe(open + 15 * MINUTE);
    await send([frame("live-2", open + 5 * MINUTE, "Notes", "golf line")]);
    await until("the closed bucket was appended", () => imported() && idle() && readIndex(root)!.segments[record(open)] !== undefined);
    expect(matching(root, "foxtrot")).toEqual([record(open)]);
    expect(matching(root, "golf")).toEqual([]);
    expect(counts()).toEqual({ appended: base.appended + 1, rebuilt: base.rebuilt });
    const end = open + 10 * MINUTE;
    expect(wake()).toBe(end > Date.now() ? end : end + 10 * MINUTE);
  });
});

describe("screen erasure", () => {
  let root: string;
  let home: Home | undefined;
  let shipped = 0;

  const sock = () => testSocket(root);
  const building = () => join(fileOf(root), "..", "screen.building.db");
  const top = () => readHome(root, (db) => db.prepare("SELECT coalesce(max(seq), 0) FROM statements").pluck().get() as number);
  const settle = async () => {
    await until("the home imported every delivery", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE state = 'imported'").pluck().get()) === shipped);
    await until("the screen index read every statement", () => {
      const queued = readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE kind = 'index' AND key = 'screen' AND state <> 'done'").pluck().get() as number);
      return queued === 0 && readIndex(root)?.seq === top();
    });
  };

  beforeAll(async () => {
    root = makeRoot("lifestream-screen-erase-", { sources: { [SOURCE]: "fake-rows" }, settings: { "families.screen": { index: true } } });
    home = await startHome(root, { registry: FAKES, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, log: () => undefined });
    await ship(root, { source: SOURCE, fetched_ms: Date.now(), rows: [
      frame("e1", T0, "Notes", "kilo secret", "lima line"),
      frame("e2", T0 + 5 * MINUTE, "Notes", "kilo secret", "mike line"),
      frame("e3", T0 + 10 * MINUTE, "Notes", "november line"),
      frame("e4", T0 + 15 * MINUTE, "Notes", "oscar line"),
    ] as never });
    shipped++;
    await settle();
  });

  afterAll(async () => {
    await home?.stop().catch(() => undefined);
    if (root !== undefined) removeRoot(root);
  });

  it("states where the index stands: the statements read, the newest instant its words reach, its bytes and no vectors", () => {
    const screen = statusOf(root).screen!;
    expect(screen).toMatchObject({ seq: top(), of: top(), vectors_bytes: 0 });
    expect(screen.bytes).toBeGreaterThan(0);
    expect(screen.indexed_through).toBeGreaterThanOrEqual(T0 + 15 * MINUTE);
    expect(screen.indexed_through).toBeLessThanOrEqual(T0 + 20 * MINUTE);
  });

  it("rebuilds the machine-day without an erased frame, a line it showed found where it was shown again", async () => {
    expect(matching(root, "kilo")).toEqual([record(T0)]);
    const erased = await askHome(sock(), "erase", ["screen", "e1", "--apply"]) as { applied: boolean; records: number };
    expect(erased).toMatchObject({ applied: true, records: 1 });
    expect(Object.keys(readIndex(root)!.segments)).toEqual([record(T0 + 5 * MINUTE), record(T0 + 10 * MINUTE), record(T0 + 15 * MINUTE)]);
    expect(matching(root, "lima")).toEqual([]);
    expect(matching(root, "kilo")).toEqual([record(T0 + 5 * MINUTE)]);
    expect(matching(root, "november")).toEqual([record(T0 + 10 * MINUTE)]);
  });

  it("forgets in a build beside screen.db as well, an erasure run with no home", async () => {
    await home!.stop();
    home = undefined;
    const child = new ChildHome(root);
    child.start("screen.indexed");
    await child.ready();
    await askHome(sock(), "rebuild", ["screen"]);
    expect(await child.exited()).toEqual({ code: null, signal: "SIGKILL" });
    rmSync(sock().path, { force: true });
    expect(matching(root, "mike", building())).toEqual([record(T0 + 5 * MINUTE)]);
    const settings = effective(root).settings;
    const out: string[] = [];
    expect(await runCli(["erase", "screen", "e2", "--apply", "--root", root], { write: (text) => out.push(text), registry: { code: "code-test", ...fakeRegistry(settings, homeOf(openHomeFolder(root))) } })).toBe(0);
    for (const file of [fileOf(root), building()]) {
      expect(matching(root, "mike", file)).toEqual([]);
      expect(matching(root, "kilo", file)).toEqual([]);
      expect(matching(root, "november", file)).toEqual([record(T0 + 10 * MINUTE)]);
    }
    home = await startHome(root, { registry: FAKES, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, log: () => undefined });
    await askHome(sock(), "rebuild", ["screen"]);
    await until("the build became screen.db", () => !existsSync(building()));
    expect(Object.keys(readIndex(root)!.segments)).toEqual([record(T0 + 10 * MINUTE), record(T0 + 15 * MINUTE)]);
    expect(matching(root, "kilo")).toEqual([]);
  });

  it("keeps an erasure held only in screen.db's log through a publication killed between the old file's retirement and the rename", async () => {
    await home!.stop();
    home = undefined;
    const writer = new Database(fileOf(root), { timeout: 10_000 });
    writer.pragma("journal_mode = WAL");
    const reader = new Database(fileOf(root), { readonly: true, timeout: 10_000 });
    reader.exec("BEGIN");
    expect(reader.prepare("SELECT count(*) AS n FROM screen_row").get()).toMatchObject({ n: expect.any(Number) });
    writer.close();
    const settings = effective(root).settings;
    const said: string[] = [];
    expect(await runCli(["erase", "screen", "e3", "--apply", "--root", root], { write: (text) => said.push(text), registry: { code: "code-test", ...fakeRegistry(settings, homeOf(openHomeFolder(root))) } })).toBe(0);
    expect(said.join("")).toMatch(/"logs_kept":\[[^\]]*"screen\.db"/u);
    expect(statSync(`${fileOf(root)}-wal`).size).toBeGreaterThan(0);
    const child = new ChildHome(root);
    child.start("screen.retired");
    await child.ready();
    await askHome(sock(), "rebuild", ["screen"]);
    await until("the rebuild's build is under way", () => existsSync(building()));
    reader.close();
    expect(await child.exited()).toEqual({ code: null, signal: "SIGKILL" });
    rmSync(sock().path, { force: true });
    expect(existsSync(`${fileOf(root)}-wal`)).toBe(false);
    expect(matching(root, "november")).toEqual([]);
    expect(matching(root, "oscar")).toEqual([record(T0 + 15 * MINUTE)]);
    expect(existsSync(building())).toBe(true);
    home = await startHome(root, { registry: FAKES, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, log: () => undefined });
    await askHome(sock(), "rebuild", ["screen"]);
    await until("the build became screen.db", () => !existsSync(building()));
    expect(Object.keys(readIndex(root)!.segments)).toEqual([record(T0 + 15 * MINUTE)]);
    expect(matching(root, "november")).toEqual([]);
  });
});
