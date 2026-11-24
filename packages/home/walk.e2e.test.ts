import { constants, cpSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { homeSchema, openHome, openHomeFolder, Schema, STORED_MARK, type HomeDb, type ReaderOutput, type RecordRef, type View } from "@lifestreamprotocol/core";
import { physicalFamily, type Change, type Family } from "@lifestreamprotocol/families";
import { rebuildCursor, rebuildExtracts, walkKind } from "./derive.js";
import { startHome, type Home } from "./home.js";
import { LANE, type HelperEnv, type Main, type Running } from "./jobs.js";
import { report } from "./report.js";
import { askHome } from "./socket.js";
import { RELEASE_FED } from "./test/fed.js";
import { editSettings, testSocket } from "./test/folder.js";
import { artifact, ChildHome, FAKES, LOOK_MS, makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { count, DAY, note, quiet, SOURCE } from "./test/derived.js";
import { land, removeDir, tempDir } from "./test/ops-support.js";


type WalkRun = ({ slabs: number; records: number } | { stage: string }) & { publish_ms?: number };
const READ = { stage: "reading" };
const CLOSED = { stage: "closing", publish_ms: expect.any(Number) as number };

const SCREEN = "screen:local:mac-0001";
const SETTINGS = { "families.notes": { code: "1", per: "day" }, helpers: 3 };
const SEP_1 = Date.UTC(2026, 8, 1, 10);
const SEP_10 = Date.UTC(2026, 8, 10, 10);
const SEP_20 = Date.UTC(2026, 8, 20, 10);
const WEEK = 7 * DAY;
const weekOf = (at: number): number => Math.floor(at / WEEK) * WEEK;

const unitOn = (at: number): string => `${SOURCE}/${new Date(at).toISOString().slice(0, 10)}`;
const walkRuns = (root: string, family = "notes"): WalkRun[] =>
  (readHome(root, (db) => db.prepare("SELECT counts FROM runs WHERE kind = 'walk' AND subject = ? ORDER BY id").pluck().all(family)) as string[])
    .map((counts) => JSON.parse(counts) as { stage: string; slabs: number; records: number; publish_ms?: number })
    .filter(({ stage }) => stage !== "emptying")
    .map(({ stage, slabs, records, publish_ms }) => ({ ...(stage === "slabs" ? { slabs, records } : { stage }), ...(publish_ms === undefined ? {} : { publish_ms }) }));
const place = (root: string, family = "notes"): { next_ms?: number; log?: string } | undefined => {
  const text = readHome(root, (db) => db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(`walk:${family}`)) as string | undefined;
  return text === undefined ? undefined : JSON.parse(text) as { next_ms?: number; log?: string };
};
const building = (at: number) => ({ next_ms: weekOf(at) + WEEK, slab: { touched: [unitOn(at)], previous: [] } });
const heldIn = (at: number): unknown => expect.objectContaining(building(at));
const handedThenBuilt = (...records: number[]): WalkRun[] => records.flatMap((each) => [{ slabs: 1, records: each }, { slabs: 1, records: 0 }]);
const served = (root: string, family = "notes") =>
  readHome(root, (db) => db.prepare("SELECT unit, reading, content FROM extracts WHERE family = ? ORDER BY unit").all(family)) as { unit: string; reading: string; content: string }[];
const units = (root: string): string[] => served(root).map((row) => row.unit);
const emptied = (root: string, family: string): { emptied: number; lane: number }[] =>
  (readHome(root, (db) => db.prepare("SELECT counts FROM runs WHERE kind = 'walk' AND subject = ? ORDER BY id").pluck().all(family)) as string[])
    .map((counts) => JSON.parse(counts) as { stage: string; emptied: number; lane: number })
    .filter(({ stage }) => stage === "emptying").map(({ emptied, lane }) => ({ emptied, lane }));
const nextRows = (root: string, family: string): number => count(root, "SELECT count(*) FROM extracts_next WHERE family = ?", family);
const published = (root: string, family = "notes"): Record<string, unknown> =>
  JSON.parse(readHome(root, (db) => db.prepare("SELECT counts FROM runs WHERE kind = 'walk' AND subject = ? AND counts LIKE '%publish_ms%' ORDER BY id DESC LIMIT 1").pluck().get(family)) as string) as Record<string, unknown>;
const settled = (root: string, family = "notes"): boolean => quiet(root) && count(root, "SELECT coalesce(max(seq), 0) FROM cursors WHERE name = ?", `rebuild:${family}`) === 0;
const aside = (root: string): { unit: string; error: string }[] =>
  readHome(root, (db) => db.prepare("SELECT unit, error FROM extracts_aside WHERE family = 'notes' ORDER BY unit").all()) as { unit: string; error: string }[];
const extractRuns = (root: string, after: number): { statements: number }[] =>
  (readHome(root, (db) => db.prepare("SELECT counts FROM runs WHERE kind = 'extract' AND subject = 'notes' AND id > ? ORDER BY id").pluck().all(after)) as string[])
    .map((counts) => ({ statements: (JSON.parse(counts) as { statements: number }).statements }));
const lastRun = (root: string): number => count(root, "SELECT coalesce(max(id), 0) FROM runs");
const notesJob = (root: string, kind = "walk"): { state: string; lane: number } | undefined =>
  readHome(root, (db) => db.prepare("SELECT state, lane FROM jobs WHERE kind = ? AND key = 'notes'").get(kind)) as { state: string; lane: number } | undefined;
const imported = (root: string): number => count(root, "SELECT count(*) FROM deliveries WHERE state = 'imported'");
const rebuild = (root: string, family = "notes") => askHome(testSocket(root), "rebuild", ["extracts", "--family", family]);

const DROPPED: Readonly<Record<string, string>> = { "polls.state": "'{}'" };
const LATER: Readonly<Record<string, number>> = { [STORED_MARK]: 34 };

function atVersion(root: string, version: number, edit: (db: Database.Database) => void): void {
  const path = join(root, "home.db");
  const older = join(root, `home-${version}.db`);
  const schema = new Schema({
    name: homeSchema.name, file: homeSchema.file, base: homeSchema.base, baseline: homeSchema.baseline,
    migrations: homeSchema.migrations.slice(0, version - homeSchema.base), small: [...homeSchema.small],
  });
  const db = new Database(older);
  try {
    db.pragma("journal_mode = WAL");
    schema.open(db, "migrate", () => undefined);
    const triggers = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger'").all() as { name: string; sql: string }[];
    for (const { name } of triggers) db.exec(`DROP TRIGGER "${name}"`);
    db.prepare("ATTACH DATABASE ? AS current").run(path);
    const tables = db.prepare("SELECT name FROM main.sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").pluck().all() as string[];
    db.transaction(() => {
      for (const table of tables) {
        const now = new Set(db.prepare("SELECT name FROM pragma_table_info(?, 'current')").pluck().all(table) as string[]);
        const columns = (db.prepare("SELECT name FROM pragma_table_info(?, 'main')").pluck().all(table) as string[]);
        const values = columns.map((column) => now.has(column) ? `"${column}"` : DROPPED[`${table}.${column}`] ?? "NULL");
        db.exec(`DELETE FROM main."${table}"; INSERT INTO main."${table}" (${columns.map((column) => `"${column}"`).join(", ")}) SELECT ${values.join(", ")} FROM current."${table}"`);
      }
      const later = db.prepare("DELETE FROM main.meta WHERE key = ?");
      for (const [key, by] of Object.entries(LATER)) if (version < by) later.run(key);
      db.exec("DELETE FROM main.sqlite_sequence; INSERT INTO main.sqlite_sequence (name, seq) SELECT name, seq FROM current.sqlite_sequence");
      for (const { sql } of triggers) db.exec(sql);
      edit(db);
    })();
    db.exec("DETACH DATABASE current");
    expect(db.pragma("user_version", { simple: true })).toBe(version);
  } finally {
    db.close();
  }
  for (const suffix of ["-wal", "-shm", ""]) rmSync(`${path}${suffix}`, { force: true });
  renameSync(older, path);
}

describe("a rebuild's walk runs a minute at a time beside the ordinary run, and resumes at its place", () => {
  const roots: string[] = [];
  const before = process.env.LIFESTREAM_TEST_WALK_MS;
  beforeAll(() => {
    process.env.LIFESTREAM_TEST_WALK_MS = "0";
  });
  afterAll(() => {
    if (before === undefined) delete process.env.LIFESTREAM_TEST_WALK_MS;
    else process.env.LIFESTREAM_TEST_WALK_MS = before;
    for (const root of roots) removeRoot(root);
  });

  const newRoot = (prefix: string, sending = true): string => {
    const root = makeRoot(prefix, { sources: { [SOURCE]: "fake-rows", [SCREEN]: "fake-rows" }, settings: SETTINGS as never, ...(sending ? {} : { defaults: false }) });
    roots.push(root);
    return root;
  };
  const start = (root: string): Promise<Home> => startHome(root, { registry: FAKES, log: () => undefined, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50 });

  async function heldInThirdWeek(prefix: string, sending = true): Promise<{ root: string; home: Home; gate: string; walked: number }> {
    const root = newRoot(prefix, sending);
    const home = await start(root);
    const gate = join(root, "walk-gate");
    await ship(root, { source: SOURCE, fetched_ms: Date.now(), rows: [note("n1", "note one", SEP_1), note("n2", "note two", SEP_10), note("n3", "note three", SEP_20, { hold: gate })] });
    await until("three days of notes", () => settled(root) && units(root).length === 3);
    const walked = walkRuns(root).length;
    writeFileSync(gate, "");
    await rebuild(root);
    await until("the walk held in its third week", () => existsSync(`${gate}.held`));
    expect(place(root)).toEqual(heldIn(SEP_20));
    return { root, home, gate, walked };
  }

  it("a walk killed mid-way starts again from nothing, or publishes otherwise than one run, a note moved into a week walked among them", async () => {
    expect(new Set([weekOf(SEP_1), weekOf(SEP_10), weekOf(SEP_20)]).size).toBe(3);
    const moved = SEP_1 + DAY;
    expect(weekOf(moved)).toBe(weekOf(SEP_1));
    const root = newRoot("lifestream-walk-kill-");
    const child = new ChildHome(root);
    try {
      child.start();
      await child.ready();
      const gate = join(root, "walk-gate");
      await ship(root, { source: SOURCE, fetched_ms: Date.now(), rows: [note("n1", "note one", SEP_1), note("n2", "note two", SEP_10, { hold: gate }), note("n3", "note three", SEP_20)] });
      await until("three days of notes", () => settled(root) && units(root).length === 3);
      const walked = walkRuns(root).length;
      writeFileSync(gate, "");
      await rebuild(root);
      await until("the walk held in its second week", () => existsSync(`${gate}.held`));
      const held = { place: place(root), runs: walkRuns(root).slice(walked) };
      expect(held).toEqual({ place: heldIn(SEP_10), runs: [{ slabs: 1, records: 0 }, ...handedThenBuilt(1), { slabs: 1, records: 1 }] });
      await ship(root, { source: SOURCE, fetched_ms: Date.now() + 1, rows: [note("n3", "note three", moved)] });
      await until("the restatement landed", () => imported(root) === 2);
      child.kill();
      expect((await child.exited()).signal).toBe("SIGKILL");
      rmSync(gate);
      const resumedHome = await start(root);
      let bounded: ReturnType<typeof served>;
      let resumed: { place: ReturnType<typeof place>; runs: WalkRun[]; units: string[] };
      try {
        await until("the walk resumed and published", () => settled(root) && walkRuns(root).slice(walked + 4).some((run) => run.publish_ms !== undefined));
        resumed = { place: place(root), runs: walkRuns(root).slice(walked + 4), units: units(root) };
        expect(resumed).toEqual({ place: undefined, runs: [{ slabs: 1, records: 0 }, READ, READ, CLOSED], units: [unitOn(SEP_1), unitOn(moved), unitOn(SEP_10)] });
        bounded = served(root);
      } finally {
        await resumedHome.stop();
      }

      const prevWalk = process.env.LIFESTREAM_TEST_WALK_MS;
      process.env.LIFESTREAM_TEST_WALK_MS = "1000000000";
      const oneRun = await start(root);
      try {
        const runs = walkRuns(root).length;
        await rebuild(root);
        await until("the one-run walk published", () => settled(root) && walkRuns(root).length > runs);
        expect(walkRuns(root).slice(runs)).toEqual([{ slabs: 3, records: 3 }, READ, CLOSED]);
        expect(served(root)).toEqual(bounded);
      } finally {
        await oneRun.stop();
        if (prevWalk === undefined) delete process.env.LIFESTREAM_TEST_WALK_MS;
        else process.env.LIFESTREAM_TEST_WALK_MS = prevWalk;
      }
      artifact(root, "walk-kill", { held, resumed, bounded });
    } finally {
      await child.stop();
    }
  });

  it("a version of a record only a middle run saw is served after the publish, or a later version is not", async () => {
    const root = newRoot("lifestream-walk-middle-");
    const home = await start(root);
    try {
      const [first, second] = [join(root, "gate-1"), join(root, "gate-2")];
      const middle = SEP_10 + DAY;
      const fourth = SEP_20 + DAY;
      expect([weekOf(middle), weekOf(fourth)]).toEqual([weekOf(SEP_10), weekOf(SEP_20)]);
      await ship(root, { source: SOURCE, fetched_ms: Date.now(), rows: [
        note("n1", "note one", SEP_1, { hold: first }), note("n2", "note two", SEP_10, { hold: second }), note("n3", "note three", SEP_20), note("n4", "note four", fourth),
      ] });
      await until("four days of notes", () => settled(root) && units(root).length === 4);
      writeFileSync(first, "");
      writeFileSync(second, "");
      await rebuild(root);
      await until("the walk held in its first week", () => existsSync(`${first}.held`));
      await ship(root, { source: SOURCE, fetched_ms: Date.now() + 1, rows: [note("n3", "note three", middle)] });
      await until("n3 moved into the second week", () => imported(root) === 2);
      rmSync(first);
      await until("the walk held in its second week", () => existsSync(`${second}.held`));
      await ship(root, { source: SOURCE, fetched_ms: Date.now() + 2, rows: [note("n3", "note three", SEP_20)] });
      await until("n3 moved back", () => imported(root) === 3);
      rmSync(second);
      await until("the walk published", () => settled(root));
      const publish = published(root);
      expect({ written: publish.written, deleted: publish.deleted, units: units(root) }).toEqual({ written: 0, deleted: 0, units: [unitOn(SEP_1), unitOn(SEP_10), unitOn(SEP_20), unitOn(fourth)] });
      artifact(root, "walk-middle", { publish, units: units(root), runs: walkRuns(root) });
    } finally {
      await home.stop();
    }
  });

  it("a source read further between two runs leaves the sitting it closes open", async () => {
    const root = newRoot("lifestream-walk-read-through-");
    const home = await start(root);
    try {
      const gate = join(root, "walk-gate");
      const later = SEP_10;
      const sittings = () => (readHome(root, (db) => db.prepare("SELECT unit, content FROM extracts WHERE family = 'screen' ORDER BY unit").all()) as { unit: string; content: string }[])
        .map((row) => ({ unit: row.unit, closed: (JSON.parse(row.content) as { closed: boolean }).closed }));
      await ship(root, { source: SCREEN, fetched_ms: SEP_1 + 1_000, rows: [
        { kind: "frame", key: "f1", content: { at: SEP_1, hold: gate }, at: SEP_1 },
        { kind: "frame", key: "f2", content: { at: later }, at: later },
      ] });
      await until("both sittings, both open", () => settled(root, "screen") && sittings().length === 2);
      expect(sittings().map((row) => row.closed)).toEqual([false, false]);
      writeFileSync(gate, "");
      await rebuild(root, "screen");
      await until("the walk held in its first week", () => existsSync(`${gate}.held`));
      await ship(root, { source: SCREEN, fetched_ms: SEP_1 + 3_600_000, rows: [] });
      await until("the read-through moved", () => count(root, "SELECT read_through_ms FROM sources WHERE id = ?", SCREEN) === SEP_1 + 3_600_000);
      rmSync(gate);
      await until("the ordinary run closed the sitting", () => sittings()[0]?.closed === true);
      await until("the walk published", () => settled(root, "screen"));
      expect(count(root, "SELECT at_ms FROM cursors WHERE name = ?", `read:screen:${SCREEN}`)).toBe(SEP_1 + 3_600_000);
      expect(sittings()).toEqual([{ unit: `mac-0001/${SEP_1}`, closed: true }, { unit: `mac-0001/${later}`, closed: false }]);
      artifact(root, "walk-read-through", { sittings: sittings(), runs: walkRuns(root, "screen") });
    } finally {
      await home.stop();
    }
  });

  it("an erasure between two runs of a walk leaves a unit of the next generation quoting what went", async () => {
    const root = newRoot("lifestream-walk-erase-");
    const home = await start(root);
    try {
      const sock = testSocket(root);
      const gate = join(root, "walk-gate");
      const moved = SEP_10 + DAY;
      await ship(root, { source: SOURCE, fetched_ms: Date.now(), rows: [note("n1", "the erased note", SEP_1), note("n2", "note two", SEP_20, { hold: gate })] });
      await until("two days of notes", () => settled(root) && units(root).length === 2);
      await askHome(sock, "pause", ["extract:notes", "--reason", "the test moves a note the served rows do not follow"]);
      await ship(root, { source: SOURCE, fetched_ms: Date.now() + 1, rows: [note("n1", "the erased note", moved)] });
      await until("n1 moved", () => imported(root) === 2);
      writeFileSync(gate, "");
      await rebuild(root);
      await until("the walk held in n2's week", () => existsSync(`${gate}.held`));
      const during = { units: units(root), next: count(root, "SELECT count(*) FROM extracts_next WHERE family = 'notes' AND unit = ?", unitOn(moved)) };
      expect(during).toEqual({ units: [unitOn(SEP_1), unitOn(SEP_20)], next: 1 });
      const old = walkRuns(root).length;
      await askHome(sock, "erase", ["notes", "n1", "--apply"]);
      rmSync(gate);
      await until("the walk published", () => count(root, "SELECT coalesce(max(seq), 0) FROM cursors WHERE name = 'rebuild:notes'") === 0);
      const runs = walkRuns(root).slice(old);
      expect(runs).toEqual([{ slabs: 1, records: 0 }, ...handedThenBuilt(1), READ, CLOSED]);
      await askHome(sock, "resume", ["extract:notes"]);
      await until("the ordinary run read the erasure", () => settled(root));
      const after = served(root);
      expect(after.map((row) => row.unit)).toEqual([unitOn(SEP_20)]);
      expect(after.filter((row) => row.content.includes("the erased note"))).toEqual([]);
      artifact(root, "walk-erase", { during, runs, after: after.map((row) => row.unit) });
    } finally {
      await home.stop();
    }
  });

  it("a rebuild's reset mid-walk resumes the old walk's place", async () => {
    const { root, home, gate, walked } = await heldInThirdWeek("lifestream-walk-reset-");
    try {
      const old = walkRuns(root).length;
      expect(old - walked).toBe(6);
      await rebuild(root);
      expect(place(root)).toBeUndefined();
      rmSync(gate);
      await until("the second walk published", () => settled(root) && walkRuns(root).slice(old).some((run) => run.publish_ms !== undefined));
      expect(walkRuns(root).slice(old)).toEqual([{ slabs: 1, records: 0 }, ...handedThenBuilt(1, 1, 1), READ, CLOSED]);
      expect(units(root)).toEqual([unitOn(SEP_1), unitOn(SEP_10), unitOn(SEP_20)]);
      artifact(root, "walk-reset", { runs: walkRuns(root) });
    } finally {
      await home.stop();
    }
  });

  it("a rebuild asked of a home its erasures emptied mid-walk takes the walk's place and leaves its generation: the walk in flight fails", async () => {
    const root = newRoot("lifestream-walk-emptied-");
    const gate = join(root, "walk-gate");
    const child = new ChildHome(root);
    const held = (): number => (existsSync(`${gate}.hits`) ? readFileSync(`${gate}.hits`, "utf8").split("\n").filter(Boolean).length : 0);
    try {
      child.start("walk.run", { env: { LIFESTREAM_HOLD: gate } });
      await child.ready();
      const sock = testSocket(root);
      await ship(root, { source: SOURCE, fetched_ms: Date.now(), rows: [note("n1", "the only note", SEP_1)] });
      await until("one day of notes", () => settled(root) && units(root).length === 1);
      writeFileSync(gate, "");
      await rebuild(root);
      await until("the walk held", () => held() === 1);
      await askHome(sock, "erase", ["notes", "n1", "--apply"]);
      await until("the walk held again, the home emptied and read", () =>
        held() === 2 && place(root) !== undefined && notesJob(root)?.state === "running"
        && count(root, "SELECT count(*) FROM statements") === 0 && count(root, "SELECT seq FROM cursors WHERE name = 'extract:notes'") === 0
        && notesJob(root, "extract")?.state !== "running" && notesJob(root, "extract")?.state !== "queued");
      const emptied = { place: place(root), owed: count(root, "SELECT seq FROM cursors WHERE name = 'rebuild:notes'") };
      expect(emptied).toEqual({ place: expect.objectContaining({ seq: 0 }), owed: 1 });
      const old = walkRuns(root).length;
      await rebuild(root);
      rmSync(gate);
      await until("the walk ended", () => count(root, "SELECT seq FROM cursors WHERE name = 'rebuild:notes'") === 0 && notesJob(root)?.state !== "running");
      const ended = {
        error: readHome(root, (db) => db.prepare("SELECT error FROM jobs WHERE kind = 'walk' AND key = 'notes'").pluck().get()),
        runs: walkRuns(root).slice(old), place: place(root), units: units(root),
      };
      expect(ended).toEqual({ error: null, runs: [{ slabs: 1, records: 0 }, READ, CLOSED], place: undefined, units: [] });
      artifact(root, "walk-emptied", { emptied, ended });
    } finally {
      await child.stop();
    }
  });

  it("a start whose fingerprint is the same throws the walk's place away, or holds the next generation back", async () => {
    const { root, home, gate, walked } = await heldInThirdWeek("lifestream-walk-restart-");
    let again: Home | undefined;
    try {
      await home.stop();
      const kept = place(root);
      expect(kept).toEqual(heldIn(SEP_20));
      expect(readHome(root, (db) => JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'fingerprint:notes'").pluck().get() as string))).toEqual(expect.objectContaining({ reason: ["verb"] }));
      const file = new Database(join(root, "home.db"));
      try {
        file.prepare("DELETE FROM meta WHERE key = 'fingerprint:notes'").run();
      } finally {
        file.close();
      }
      rmSync(gate);
      again = await start(root);
      await until("the walk resumed and published", () => settled(root) && walkRuns(root).slice(walked + 6).some((run) => run.publish_ms !== undefined));
      expect(walkRuns(root).slice(walked + 6)).toEqual([{ slabs: 1, records: 0 }, READ, CLOSED]);
      expect({ place: place(root), units: units(root), reason: published(root).reason }).toEqual({ place: undefined, units: [unitOn(SEP_1), unitOn(SEP_10), unitOn(SEP_20)], reason: ["unknown"] });
      artifact(root, "walk-restart", { kept, runs: walkRuns(root) });
    } finally {
      await home.stop();
      await again?.stop();
    }
  });

  it("a family the home no longer runs keeps its walk's place", async () => {
    const { root, home, gate } = await heldInThirdWeek("lifestream-walk-forget-");
    let again: Home | undefined;
    try {
      await home.stop();
      expect(place(root)).toEqual(heldIn(SEP_20));
      rmSync(gate);
      editSettings(root, { "families.notes": { absent: true } });
      again = await start(root);
      expect({ place: place(root), walk: notesJob(root), kept: count(root, "SELECT count(*) FROM meta WHERE key = 'fingerprint:notes'") })
        .toEqual({ place: undefined, walk: undefined, kept: 0 });
    } finally {
      await home.stop();
      await again?.stop();
    }
  });

  it("a walk killed after a run's last commit, before its end, loses what the run before it set aside", async () => {
    const root = newRoot("lifestream-walk-kill-done-");
    const child = new ChildHome(root);
    let home: Home | undefined;
    try {
      home = await start(root);
      await ship(root, { source: SOURCE, fetched_ms: Date.now(), rows: [note("n1", "note one", SEP_1, { extract_throw: true }), note("n2", "note two", SEP_10), note("n3", "note three", SEP_20)] });
      await until("two days of notes, the first set aside", () => settled(root) && units(root).length === 2 && aside(root).length === 1);
      await home.stop();
      home = undefined;
      child.start("extract.walked");
      await child.ready();
      const walked = walkRuns(root).length;
      await rebuild(root);
      expect((await child.exited()).signal).toBe("SIGKILL");
      const killed = { place: place(root), runs: walkRuns(root).slice(walked) };
      expect(killed).toEqual({
        place: expect.objectContaining({ ...building(SEP_10), aside: [unitOn(SEP_1)] }),
        runs: [{ slabs: 1, records: 0 }, ...handedThenBuilt(1), { slabs: 1, records: 1 }],
      });
      home = await start(root);
      await until("the walk resumed and published", () => settled(root) && walkRuns(root).slice(walked).some((run) => run.publish_ms !== undefined));
      const resumed = { runs: walkRuns(root).slice(walked + 4), aside: aside(root), units: units(root) };
      expect(resumed).toEqual({
        runs: [{ slabs: 1, records: 0 }, ...handedThenBuilt(1), READ, CLOSED],
        aside: [{ unit: unitOn(SEP_1), error: "note n1 is malformed" }],
        units: [unitOn(SEP_10), unitOn(SEP_20)],
      });
      artifact(root, "walk-kill-done", { killed, resumed });
    } finally {
      await home?.stop();
      await child.stop();
    }
  });

  it("a week of more records than a slab holds is walked in parts, cut only between two starts, and publishes what one slab would", async () => {
    const before = process.env.LIFESTREAM_TEST_SLAB_RECORDS;
    process.env.LIFESTREAM_TEST_SLAB_RECORDS = "2";
    const root = newRoot("lifestream-walk-cut-");
    const home = await start(root);
    try {
      const gate = join(root, "walk-gate");
      const hour = 3_600_000;
      const [t1, t2, t3, t4] = [SEP_1, SEP_1 + hour, SEP_1 + DAY, SEP_1 + DAY + 3 * hour];
      expect(new Set([t1, t2, t3, t4].map(weekOf)).size).toBe(1);
      await ship(root, { source: SOURCE, fetched_ms: Date.now(), rows: [
        note("a", "note a", t1), note("b", "note b", t1), note("x", "note x", t1), note("c", "note c", t2), note("d", "note d", t3),
        note("e", "note e", t4, { hold: gate }),
      ] });
      await until("two days of notes", () => settled(root) && units(root).length === 2);
      const once = served(root);
      const walked = walkRuns(root).length;
      writeFileSync(gate, "");
      await rebuild(root);
      await until("the walk held in the week's third part", () => existsSync(`${gate}.held`));
      const held = { place: place(root), runs: walkRuns(root).slice(walked) };
      expect(held).toEqual({
        place: heldIn(t4), runs: [{ slabs: 1, records: 0 }, ...handedThenBuilt(3), { slabs: 1, records: 2 }, { slabs: 1, records: 0 }, { slabs: 1, records: 0 }, { slabs: 1, records: 1 }],
      });
      rmSync(gate);
      await until("the walk published", () => settled(root) && walkRuns(root).length === walked + 10);
      expect(walkRuns(root).slice(walked + 7)).toEqual([{ slabs: 1, records: 0 }, READ, CLOSED]);
      expect({ place: place(root), served: served(root) }).toEqual({ place: undefined, served: once });
      artifact(root, "walk-cut", { held, runs: walkRuns(root) });
    } finally {
      await home.stop();
      if (before === undefined) delete process.env.LIFESTREAM_TEST_SLAB_RECORDS;
      else process.env.LIFESTREAM_TEST_SLAB_RECORDS = before;
    }
  });

  it("a note of now waits for the walk, its day unrendered until the publish", async () => {
    const root = newRoot("lifestream-walk-live-");
    const home = await start(root);
    try {
      const gate = join(root, "walk-gate");
      await ship(root, { source: SOURCE, fetched_ms: Date.now(), rows: [note("n1", "note one", SEP_1), note("n2", "note two", SEP_10, { hold: gate }), note("n3", "note three", SEP_20)] });
      await until("three days of notes", () => settled(root) && units(root).length === 3);
      writeFileSync(gate, "");
      await rebuild(root);
      await until("the walk held in its second week", () => existsSync(`${gate}.held`));
      expect(notesJob(root)).toEqual({ state: "running", lane: LANE.backfill });
      const now = Date.now();
      await ship(root, { source: SOURCE, fetched_ms: now, rows: [note("n0", "a note of now", now)] });
      const today = unitOn(now);
      await until("the note of now served and its day rendered", () => units(root).includes(today)
        && count(root, "SELECT count(*) FROM day_units WHERE family = 'notes' AND unit = ?", today) > 0);
      const during = { place: place(root), rebuilding: count(root, "SELECT seq FROM cursors WHERE name = 'rebuild:notes'") };
      expect(during).toEqual({ place: heldIn(SEP_10), rebuilding: 1 });
      rmSync(gate);
      await until("the walk published", () => settled(root));
      expect(units(root)).toEqual([unitOn(SEP_1), unitOn(SEP_10), unitOn(SEP_20), today].sort());
      artifact(root, "walk-live", { during, runs: walkRuns(root) });
    } finally {
      await home.stop();
    }
  });

  it("a unit the ordinary run served after the walk's last slab is withdrawn by the publish, or loses its asks or its marks", async () => {
    const { root, home, gate } = await heldInThirdWeek("lifestream-walk-served-", false);
    try {
      const sock = testSocket(root);
      const now = Date.now();
      await ship(root, { source: SOURCE, fetched_ms: now, rows: [note("n0", "a note of now", now, { photo: true })] });
      const today = unitOn(now);
      const row = () => readHome(root, (db) => db.prepare("SELECT unit, reading, code, content, seq FROM extracts WHERE family = 'notes' AND unit = ?").get(today));
      const asks = () => readHome(root, (db) => db.prepare("SELECT * FROM asks WHERE family = 'notes' AND unit = ? ORDER BY item, prompt").all(today));
      const marked = () => count(root, "SELECT count(*) FROM dirty_units WHERE family = 'notes' AND unit = ?", today);
      await until("the note of now served and planned", () => units(root).includes(today) && asks().length > 0 && marked() === 0);
      const before = { row: row(), asks: asks() };
      await askHome(sock, "pause", ["extract:notes", "--reason", "the test reads the rows the publish left"]);
      await askHome(sock, "pause", ["plan:notes", "--reason", "the test reads the marks the publish left"]);
      rmSync(gate);
      await until("the walk published", () => count(root, "SELECT seq FROM cursors WHERE name = 'rebuild:notes'") === 0);
      const publish = published(root);
      expect({ deleted: publish.deleted, row: row(), asks: asks(), marked: marked() }).toEqual({ deleted: 0, ...before, marked: 0 });
      expect(count(root, "SELECT seq FROM cursors WHERE name = 'extract:notes'")).toBe(count(root, "SELECT max(seq) FROM statements"));
      artifact(root, "walk-served", { publish, runs: walkRuns(root) });
    } finally {
      await home.stop();
    }
  });

  for (const stage of ["reading", "closing"] as const) {
    it(`a walk killed after a ${stage === "reading" ? "log read's" : "closing run's"} last commit, before its end, loses the throw it met, and the publish withdraws the served row`, async () => {
      const root = newRoot(`lifestream-walk-kill-${stage}-`);
      const child = new ChildHome(root);
      let home: Home | undefined;
      try {
        home = await start(root);
        const [slab, read] = [join(root, "slab-gate"), join(root, "read-gate")];
        await ship(root, { source: SOURCE, fetched_ms: Date.now(), rows: [note("n1", "note one", SEP_1), note("n2", "note two", SEP_10, { hold: slab })] });
        await until("two days of notes", () => settled(root) && units(root).length === 2);
        const before = served(root).find((row) => row.unit === unitOn(SEP_1));
        await home.stop();
        home = undefined;
        child.start(`walk.${stage}`);
        await child.ready();
        const sock = testSocket(root);
        await askHome(sock, "pause", ["extract:notes", "--reason", "the test reads the rows the publish left"]);
        const broken = note("n1", "note one", SEP_1, { extract_throw: true });
        if (stage === "reading") {
          writeFileSync(slab, "");
          await rebuild(root);
          await until("the walk held in its second week", () => existsSync(`${slab}.held`));
          await ship(root, { source: SOURCE, fetched_ms: Date.now() + 1, rows: [broken] });
          await until("n1 changed", () => imported(root) === 2);
          rmSync(slab);
        } else {
          writeFileSync(slab, "");
          await rebuild(root);
          await until("the walk held in its second week", () => existsSync(`${slab}.held`));
          writeFileSync(read, "");
          await ship(root, { source: SOURCE, fetched_ms: Date.now() + 1, rows: [note("n0", "note zero", SEP_1 - DAY, { hold: read })] });
          await until("n0 landed", () => imported(root) === 2);
          rmSync(slab);
          await until("the log read held on n0", () => existsSync(`${read}.held`));
          await ship(root, { source: SOURCE, fetched_ms: Date.now() + 2, rows: [broken] });
          await until("n1 changed", () => imported(root) === 3);
          rmSync(read);
        }
        expect((await child.exited()).signal).toBe("SIGKILL");
        const killed = place(root) as { log?: string; aside?: string[]; errors?: Record<string, string> } | undefined;
        expect(killed).toEqual(expect.objectContaining({ log: stage, aside: [unitOn(SEP_1)], errors: { [unitOn(SEP_1)]: "note n1 is malformed" } }));
        home = await start(root);
        await until("the walk published", () => count(root, "SELECT seq FROM cursors WHERE name = 'rebuild:notes'") === 0);
        const after = { row: served(root).find((row) => row.unit === unitOn(SEP_1)), aside: aside(root) };
        expect(after).toEqual({ row: before, aside: [{ unit: unitOn(SEP_1), error: "note n1 is malformed" }] });
        artifact(root, `walk-kill-${stage}`, { killed, after, runs: walkRuns(root) });
      } finally {
        await home?.stop();
        await child.stop();
      }
    });
  }

  it("an ordinary run is taken while a closing run is in flight, or reads what landed before the publish", async () => {
    const root = newRoot("lifestream-walk-hold-");
    const home = await start(root);
    try {
      const sock = testSocket(root);
      const [slab, read, close] = [join(root, "slab-gate"), join(root, "read-gate"), join(root, "close-gate")];
      await ship(root, { source: SOURCE, fetched_ms: Date.now(), rows: [note("n1", "note one", SEP_1), note("n2", "note two", SEP_10, { hold: slab })] });
      await until("two days of notes", () => settled(root) && units(root).length === 2);
      writeFileSync(slab, "");
      await rebuild(root);
      await until("the walk held in its second week", () => existsSync(`${slab}.held`));
      await askHome(sock, "pause", ["extract:notes", "--reason", "the test holds the walk on notes the ordinary run would build"]);
      writeFileSync(read, "");
      writeFileSync(close, "");
      await ship(root, { source: SOURCE, fetched_ms: Date.now() + 1, rows: [note("n3", "note three", SEP_1 + DAY, { hold: read })] });
      await until("n3 landed", () => imported(root) === 2);
      rmSync(slab);
      await until("the log read held on n3", () => existsSync(`${read}.held`));
      await ship(root, { source: SOURCE, fetched_ms: Date.now() + 2, rows: [note("n4", "note four", SEP_1 - DAY, { hold: close })] });
      await until("n4 landed", () => imported(root) === 3);
      rmSync(read);
      await until("the closing run held on n4", () => existsSync(`${close}.held`));
      expect({ walk: notesJob(root), place: place(root)?.log }).toEqual({ walk: { state: "running", lane: LANE.live }, place: "closing" });
      const mark = lastRun(root);
      const now = Date.now();
      await ship(root, { source: SOURCE, fetched_ms: now, rows: [note("n5", "a note of now", now)] });
      await until("the note of now landed", () => imported(root) === 4);
      await askHome(sock, "resume", ["extract:notes"]);
      const during = notesJob(root, "extract");
      expect(during?.state).toBe("queued");
      rmSync(close);
      await until("the walk published and the note of now served", () => settled(root) && units(root).includes(unitOn(now)));
      expect(extractRuns(root, mark)).toEqual([{ statements: 1 }]);
      expect(published(root)).toEqual(expect.objectContaining({ written: 2, deleted: 0 }));
      expect(units(root)).toEqual([unitOn(SEP_1 - DAY), unitOn(SEP_1), unitOn(SEP_1 + DAY), unitOn(SEP_10), unitOn(now)].sort());
      artifact(root, "walk-hold", { during, runs: walkRuns(root), extract: extractRuns(root, mark) });
    } finally {
      await home.stop();
    }
  });

  it("lifestream report counts a walk's runs as a figure of their own, never as extract runs", async () => {
    const root = newRoot("lifestream-walk-report-");
    const home = await start(root);
    try {
      await ship(root, { source: SOURCE, fetched_ms: Date.now(), rows: [note("n1", "note one", SEP_1), note("n2", "note two", SEP_10)] });
      await until("two days of notes", () => settled(root) && units(root).length === 2);
      await rebuild(root);
      await until("the walk published", () => settled(root) && walkRuns(root).some((run) => run.publish_ms !== undefined));
      const of = (kind: string) => readHome(root, (db) => db.prepare("SELECT count(*) AS runs, coalesce(sum(json_extract(counts, '$.units')), 0) AS units FROM runs WHERE kind = ? AND subject = 'notes'").get(kind)) as { runs: number; units: number };
      const reported = await report(openHomeFolder(root), { from_ms: 0, to_ms: Date.now() + 60_000, door_log: join(root, "no-door.log"), machine: join(root, "no-machine") });
      const notes = reported.families.by_family.notes;
      expect({ walk: notes?.walk, extract: notes?.extract?.runs }).toEqual({
        walk: { ...of("walk"), busy_seconds: expect.any(Number) as number },
        extract: of("extract").runs,
      });
      expect(of("walk").runs).toBeGreaterThan(2);
    } finally {
      await home.stop();
    }
  });

  it("a publish names its parts on a line of its own and in the closing run's row, which ends after it", async () => {
    const rows = Number(process.env.LIFESTREAM_TEST_BULK_ROWS ?? 40);
    const root = makeRoot("lifestream-walk-publish-", {
      sources: { [SOURCE]: "fake-rows" }, settings: { "families.notes": { absent: true }, "families.bulk": {}, helpers: 3 } as never,
    });
    roots.push(root);
    const lines: { at: string; [member: string]: unknown }[] = [];
    let tick = Date.now();
    const home = await startHome(root, {
      registry: FAKES, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, slowMs: -1, clock: () => (tick = Math.max(tick + 1, Date.now())),
      log: (text) => { lines.push(JSON.parse(text) as { at: string }); },
    });
    try {
      await ship(root, { source: SOURCE, fetched_ms: Date.now(), rows: [], facts: { generate: { count: rows, start_ms: SEP_1, step_ms: 1_000, prefix: "b" } } });
      const built = () => count(root, "SELECT count(*) FROM extracts WHERE family = 'bulk'");
      await until("the bulk family built a row of each note", () => settled(root, "bulk") && built() === rows);
      const from = lines.length;
      await rebuild(root, "bulk");
      await until("the walk published", () => settled(root, "bulk") && lines.slice(from).some((line) => line.publish === "bulk"));
      const at = lines.findIndex((line, index) => index >= from && line.publish === "bulk");
      const publish = lines[at]!;
      const slow = lines.slice(at + 1).find((line) => typeof line.of === "string" && line.of.startsWith("walk bulk"));
      const row = readHome(root, (db) => db.prepare("SELECT ended_ms, counts FROM runs WHERE kind = 'walk' AND subject = 'bulk' AND counts LIKE '%publish_ms%' ORDER BY id DESC LIMIT 1").get()) as { ended_ms: number; counts: string };
      const counts = JSON.parse(row.counts) as Record<string, unknown>;
      artifact(root, "walk-publish", { rows, bytes: Number(process.env.LIFESTREAM_TEST_BULK_BYTES ?? 1024), publish, slow, counts });
      const parts = { compare_ms: expect.any(Number) as number, copy_ms: expect.any(Number) as number, gone_ms: expect.any(Number) as number };
      expect(publish).toEqual({ at: expect.any(String) as string, publish: "bulk", written: 0, deleted: 0, ...parts });
      expect(counts).toEqual(expect.objectContaining({ stage: "closing", written: 0, deleted: 0, publish_ms: expect.any(Number) as number, ...parts }));
      expect(slow).toEqual(expect.objectContaining({ slow: expect.any(Number) as number, commit_ms: expect.any(Number) as number }));
      expect({ served: built(), next: count(root, "SELECT count(*) FROM extracts_next WHERE family = 'bulk'") }).toEqual({ served: rows, next: 0 });
      expect(row.ended_ms).toBeGreaterThanOrEqual(Date.parse(publish.at));
    } finally {
      await home.stop();
    }
  });

  it("a publish leaves its next generation to its emptying runs, which delete it at most 50 rows a commit, in backfill", async () => {
    const root = makeRoot("lifestream-walk-empty-", {
      sources: { [SOURCE]: "fake-rows" }, settings: { "families.notes": { absent: true }, "families.bulk": {}, helpers: 3 } as never,
    });
    roots.push(root);
    const home = await start(root);
    try {
      await ship(root, { source: SOURCE, fetched_ms: Date.now(), rows: [], facts: { generate: { count: 120, start_ms: SEP_1, step_ms: 1_000, prefix: "b" } } });
      const built = () => count(root, "SELECT count(*) FROM extracts WHERE family = 'bulk'");
      await until("the bulk family built a row of each note", () => settled(root, "bulk") && built() === 120);
      expect({ emptied: emptied(root, "bulk"), next: nextRows(root, "bulk") }).toEqual({ emptied: [], next: 0 });
      await rebuild(root, "bulk");
      await until("the walk published and its emptying runs ended", () => settled(root, "bulk") && count(root, "SELECT count(*) FROM runs WHERE kind = 'walk' AND counts LIKE '%publish_ms%'") === 1);
      const after = {
        publish: { written: published(root, "bulk").written, deleted: published(root, "bulk").deleted }, served: built(),
        emptied: emptied(root, "bulk"), next: nextRows(root, "bulk"), job: count(root, "SELECT count(*) FROM jobs WHERE kind = 'walk' AND key = 'bulk' AND state <> 'done'"),
      };
      expect(after).toEqual({
        publish: { written: 0, deleted: 0 }, served: 120,
        emptied: [{ emptied: 50, lane: LANE.backfill }, { emptied: 50, lane: LANE.backfill }, { emptied: 20, lane: LANE.backfill }], next: 0, job: 0,
      });
      artifact(root, "walk-empty", after);
    } finally {
      await home.stop();
    }
  });

  it("a walk killed mid-emptying goes on emptying at the next start, and a family dropped mid-emptying keeps no next row and no place", async () => {
    const root = makeRoot("lifestream-walk-empty-kill-", {
      sources: { [SOURCE]: "fake-rows" }, settings: { "families.notes": { absent: true }, "families.bulk": {}, helpers: 3 } as never,
    });
    roots.push(root);
    const child = new ChildHome(root);
    const killed = async () => {
      await rebuild(root, "bulk");
      expect((await child.exited()).signal).toBe("SIGKILL");
      return {
        next: nextRows(root, "bulk"), place: place(root, "bulk"),
        flag: count(root, "SELECT seq FROM cursors WHERE name = 'rebuild:bulk'"),
        job: readHome(root, (db) => db.prepare("SELECT state FROM jobs WHERE kind = 'walk' AND key = 'bulk'").pluck().get()),
      };
    };
    try {
      child.start("walk.emptied");
      await child.ready();
      await ship(root, { source: SOURCE, fetched_ms: Date.now(), rows: [], facts: { generate: { count: 120, start_ms: SEP_1, step_ms: 1_000, prefix: "b" } } });
      await until("the bulk family built a row of each note", () => settled(root, "bulk") && count(root, "SELECT count(*) FROM extracts WHERE family = 'bulk'") === 120);
      const first = await killed();
      expect(first).toEqual({ next: 70, place: undefined, flag: 0, job: "running" });
      let home: Home | undefined = await start(root);
      try {
        await until("the next generation emptied", () => quiet(root) && nextRows(root, "bulk") === 0);
        expect(emptied(root, "bulk").map((run) => run.emptied)).toEqual([50, 20]);
        await home.stop();
        home = undefined;

        child.start("walk.emptied");
        await child.ready();
        expect(await killed()).toEqual(first);
        editSettings(root, { "families.bulk": null });
        home = await start(root);
        const forgot = (readHome(root, (db) => JSON.parse(db.prepare("SELECT detail FROM events WHERE kind = 'home' AND key = 'start' ORDER BY seq DESC LIMIT 1").pluck().get() as string)) as { forgot: string[] }).forgot;
        expect({ next: nextRows(root, "bulk"), place: place(root, "bulk"), kept: count(root, "SELECT count(*) FROM meta WHERE key = 'fingerprint:bulk'"), forgot: forgot.filter((what) => what.endsWith(" bulk")).sort() })
          .toEqual({ next: 0, place: undefined, kept: 0, forgot: ["rebuild bulk", "walk bulk"] });
      } finally {
        await home?.stop();
      }
    } finally {
      await child.stop();
    }
  });

  it("a code bump's walk names the units it wrote and says `code`, across a restart mid-walk", async () => {
    const root = newRoot("lifestream-walk-reason-");
    let home = await start(root);
    try {
      const gate = join(root, "walk-gate");
      await ship(root, { source: SOURCE, fetched_ms: Date.now(), rows: [note("n1", "note one", SEP_1), note("n2", "note two", SEP_10), note("n3", "note three", SEP_20, { hold: gate })] });
      await until("three days of notes", () => settled(root) && units(root).length === 3);
      await home.stop();
      editSettings(root, { "families.notes": { code: "2", per: "day" } });
      writeFileSync(gate, "");
      home = await start(root);
      await until("the walk held in its third week", () => existsSync(`${gate}.held`));
      await home.stop();
      rmSync(gate);
      home = await start(root);
      await until("the walk published", () => settled(root) && count(root, "SELECT count(*) FROM runs WHERE kind = 'walk' AND subject = 'notes' AND counts LIKE '%publish_ms%'") === 1);
      const row = published(root);
      const event = readHome(root, (db) => JSON.parse(db.prepare("SELECT detail FROM events WHERE kind = 'extract' AND key = 'notes' ORDER BY seq DESC LIMIT 1").pluck().get() as string)) as unknown;
      const all = [unitOn(SEP_1), unitOn(SEP_10), unitOn(SEP_20)];
      expect({ written: row.written, units: typeof row.units, changed: row.changed_units, reason: row.reason, event })
        .toEqual({ written: 3, units: "number", changed: { written: all, deleted: [] }, reason: ["code"], event: { units: all, count: 3 } });
    } finally {
      await home.stop();
    }
  });

  it("a publish of 60 units names 50 of them, and the verb's walk says `verb`", async () => {
    const root = makeRoot("lifestream-walk-names-", {
      sources: { [SOURCE]: "fake-rows" }, settings: { "families.notes": { absent: true }, "families.bulk": {}, helpers: 3 } as never,
    });
    roots.push(root);
    const bytes = process.env.LIFESTREAM_TEST_BULK_BYTES;
    let home = await start(root);
    try {
      await ship(root, { source: SOURCE, fetched_ms: Date.now(), rows: [], facts: { generate: { count: 60, start_ms: SEP_1, step_ms: 1_000, prefix: "b" } } });
      await until("the bulk family built a row of each note", () => settled(root, "bulk") && count(root, "SELECT count(*) FROM extracts WHERE family = 'bulk'") === 60);
      await home.stop();
      process.env.LIFESTREAM_TEST_BULK_BYTES = "512";
      home = await start(root);
      await rebuild(root, "bulk");
      await until("the walk published", () => settled(root, "bulk") && count(root, "SELECT count(*) FROM runs WHERE kind = 'walk' AND subject = 'bulk' AND counts LIKE '%publish_ms%'") === 1);
      const row = published(root, "bulk") as { written: number; changed_units: { written: string[]; deleted: string[] }; reason: string[] };
      const event = readHome(root, (db) => JSON.parse(db.prepare("SELECT detail FROM events WHERE kind = 'extract' AND key = 'bulk' ORDER BY seq DESC LIMIT 1").pluck().get() as string)) as { units: string[]; count: number };
      expect({ written: row.written, named: row.changed_units.written.length, deleted: row.changed_units.deleted, reason: row.reason, event: [event.units.length, event.count] })
        .toEqual({ written: 60, named: 50, deleted: [], reason: ["verb"], event: [50, 60] });
    } finally {
      await home.stop();
      if (bytes === undefined) delete process.env.LIFESTREAM_TEST_BULK_BYTES;
      else process.env.LIFESTREAM_TEST_BULK_BYTES = bytes;
    }
  });

  it("a home of the release before, left mid-rebuild inside a week, migrates and resumes its walk at that place, its ordinary run reading nothing again", async () => {
    const before = process.env.LIFESTREAM_TEST_SLAB_RECORDS;
    process.env.LIFESTREAM_TEST_SLAB_RECORDS = "2";
    const root = newRoot("lifestream-walk-migrate-");
    let home = await start(root);
    let again: Home | undefined;
    try {
      const gate = join(root, "walk-gate");
      const hour = 3_600_000;
      const [t1, t2, t3, t4] = [SEP_1, SEP_1 + hour, SEP_1 + DAY, SEP_1 + DAY + 3 * hour];
      await ship(root, { source: SOURCE, fetched_ms: Date.now(), rows: [
        note("a", "note a", t1), note("b", "note b", t1), note("x", "note x", t1), note("c", "note c", t2), note("d", "note d", t3),
        note("e", "note e", t4, { hold: gate }),
      ] });
      await until("two days of notes", () => settled(root) && units(root).length === 2);
      const once = served(root);
      writeFileSync(gate, "");
      await rebuild(root);
      await until("the walk held in the week's third part", () => existsSync(`${gate}.held`));
      await home.stop();
      const saved = readHome(root, (db) => db.prepare("SELECT value FROM meta WHERE key = 'walk:notes'").pluck().get()) as string;
      expect(JSON.parse(saved)).toEqual(heldIn(t4));
      atVersion(root, 26, (db) => {
        db.prepare("DELETE FROM jobs WHERE kind = 'walk'").run();
        db.prepare("UPDATE cursors SET seq = 0, reread = 0 WHERE name = 'extract:notes'").run();
        db.prepare("INSERT INTO cursors (name, seq, reread, at_ms) VALUES ('extracted:labels', 1, 0, 0)").run();
      });
      rmSync(`${gate}.held`);
      const runs = walkRuns(root).length;
      const mark = lastRun(root);
      again = await start(root);
      await until("the resumed walk held at the cut", () => existsSync(`${gate}.held`));
      const migrated = {
        version: readHome(root, (read) => read.pragma("user_version", { simple: true })),
        unread: count(root, "SELECT count(*) FROM cursors WHERE name = 'extracted:labels'"),
        cursor: count(root, "SELECT seq FROM cursors WHERE name = 'extract:notes'"),
        place: readHome(root, (read) => read.prepare("SELECT value FROM meta WHERE key = 'walk:notes'").pluck().get()),
      };
      expect(migrated).toEqual({ version: homeSchema.latest, unread: 0, cursor: count(root, "SELECT max(seq) FROM statements"), place: saved });
      rmSync(gate);
      await until("the walk published", () => settled(root) && walkRuns(root).slice(runs).some((run) => run.publish_ms !== undefined));
      expect({ runs: walkRuns(root).slice(runs), extract: extractRuns(root, mark).filter((run) => run.statements > 0), served: served(root) })
        .toEqual({ runs: [{ slabs: 1, records: 0 }, READ, CLOSED], extract: [], served: once });
      artifact(root, "walk-migrate", { migrated, runs: walkRuns(root) });
    } finally {
      await home.stop();
      await again?.stop();
      if (before === undefined) delete process.env.LIFESTREAM_TEST_SLAB_RECORDS;
      else process.env.LIFESTREAM_TEST_SLAB_RECORDS = before;
    }
  });
});

describe("a walk's emptying, by hand: walkKind over a home.db, no home", () => {
  const FAMILY = "sample";
  const family = {
    name: FAMILY, code: "1", inputs: [{ sources: { product: ["apple-notes"] }, kinds: ["msg"], role: "evidence" }],
    touched: () => [], extract: () => null, days: () => [],
  } as unknown as Family;
  const main = { families: new Map([[FAMILY, family]]), now: () => SEP_1, log: () => undefined } as unknown as Main;
  const job = { id: 1, kind: "walk", key: FAMILY, lane: LANE.backfill, not_before_ms: 0, started_ms: 0 } as never;

  function open() {
    const dir = tempDir("walk-empty");
    const db: HomeDb = openHome(openHomeFolder(dir), "migrate");
    const reader: HomeDb = openHome(openHomeFolder(dir), "read");
    onTestFinished(() => {
      reader.close();
      db.close();
      removeDir(dir);
    });
    const env = { db: reader, committed: async () => undefined } as unknown as HelperEnv;
    return {
      db,
      garbage: (rows: number) => db.commit((tx) => {
        for (let n = 0; n < rows; n++) {
          tx.derived.next.put({ family: FAMILY, unit: `u${String(n).padStart(3, "0")}`, reading: "r", code: "1", content: { n }, start_ms: SEP_1, end_ms: SEP_1, days: [], seq: 1 });
        }
      }),
      owe: () => db.commit((tx) => {
        tx.tables.cursors.move(rebuildCursor(FAMILY), { seq: 1, at_ms: 0 });
        tx.tables.cursors.turn(rebuildCursor(FAMILY), 0);
      }),
      next: () => count(dir, "SELECT count(*) FROM extracts_next WHERE family = ?", FAMILY),
      place: () => db.commit((tx) => tx.tables.meta.get(`walk:${FAMILY}`)),
      runs: () => (readHome(dir, (read) => read.prepare("SELECT counts FROM runs WHERE kind = 'walk' ORDER BY id").pluck().all()) as string[]).map((counts) => JSON.parse(counts) as Record<string, unknown>),
      begin: () => db.commit((tx) => walkKind.begin!(main, tx, job)),
      async run(begun: NonNullable<ReturnType<NonNullable<typeof walkKind.begin>>>, between: (commit: number) => void = () => undefined) {
        const running: Running<typeof begun.state> = { job, state: begun.state };
        const steps = walkKind.helper(env, { job: 1, kind: "walk", key: FAMILY, lane: LANE.backfill, now_ms: 0, data: begun.data });
        const deleted: number[] = [];
        let step = await steps.next();
        for (; step.done !== true; step = await steps.next()) {
          const was = running.state.emptied;
          for (const slice of walkKind.chunk!(main, running, step.value)) db.commit((tx) => slice.work(tx));
          deleted.push(running.state.emptied - was);
          between(deleted.length);
        }
        return { deleted, running, done: () => db.commit((tx) => walkKind.done(main, tx, running, step.value as never)) };
      },
    };
  }

  it("a family at rest, with no next row and no rebuild owed, begins nothing and writes no run", () => {
    const home = open();
    expect({ begun: home.begin(), runs: home.runs() }).toEqual({ begun: null, runs: [] });
  });

  it("next rows with no place are emptied before a walk begins, 50 a commit, holding nothing; a rebuild asked meanwhile writes no place until none is left, and the run of the generation before deletes nothing", async () => {
    const home = open();
    home.garbage(120);
    home.owe();
    const first = home.begin()!;
    expect({ stage: first.data.stage, holds: first.holds, place: home.place() }).toEqual({ stage: "emptying", holds: undefined, place: undefined });
    const voided = await home.run(first, (commit) => {
      if (commit === 1) home.db.commit((tx) => rebuildExtracts(tx, FAMILY, SEP_1));
    });
    expect({ deleted: voided.deleted, stale: voided.running.stale, next: home.next(), place: home.place() }).toEqual({ deleted: [50, 0, 0], stale: true, next: 70, place: undefined });
    const second = home.begin()!;
    expect({ stage: second.data.stage, place: home.place() }).toEqual({ stage: "emptying", place: undefined });
    const rest = await home.run(second);
    rest.done();
    expect({ deleted: rest.deleted, again: rest.running.again?.lane, next: home.next(), place: home.place() }).toEqual({ deleted: [50, 20], again: LANE.backfill, next: 0, place: undefined });
    const walk = home.begin()!;
    expect({ stage: walk.data.stage, place: home.place() !== undefined }).toEqual({ stage: "slabs", place: true });
  });

  it("a first slabs run killed before its end leaves garbage: the next run deletes its place, empties, then writes a new one", async () => {
    const home = open();
    home.owe();
    const slabs = home.begin()!;
    const killed = home.place();
    expect({ stage: slabs.data.stage, place: JSON.parse(killed!) as Record<string, unknown> }).toEqual({ stage: "slabs", place: expect.not.objectContaining({ next_ms: expect.anything() as unknown }) as unknown });
    home.garbage(30);
    const emptying = home.begin()!;
    expect({ stage: emptying.data.stage, place: home.place() }).toEqual({ stage: "emptying", place: undefined });
    const run = await home.run(emptying);
    run.done();
    expect({ deleted: run.deleted, again: run.running.again?.lane, next: home.next() }).toEqual({ deleted: [30], again: LANE.backfill, next: 0 });
    expect({ stage: home.begin()!.data.stage, place: home.place() !== undefined }).toEqual({ stage: "slabs", place: true });
  });

  it("an emptying run that leaves no row and owes no rebuild ends its job, and writes its row with what it deleted", async () => {
    const home = open();
    home.garbage(3);
    const run = await home.run(home.begin()!);
    run.done();
    expect({ again: run.running.again, runs: home.runs() }).toEqual({ again: undefined, runs: [expect.objectContaining({ stage: "emptying", emptied: 3 })] });
    expect(home.begin()).toBeNull();
  });
});

describe("a slab: one week of records at most its cap, by hand over a home.db, no home", () => {
  describe("walkKind's slabs", () => {
    const FAMILY = "sample";
    const NOTES = "apple-notes:local:device-a";
    const hour = 3_600_000;
    const [t1, t2, t3, t4] = [SEP_1, SEP_1 + hour, SEP_1 + DAY, SEP_1 + DAY + 3 * hour];
    const msg = (key: string, at: number): ReaderOutput => ({ kind: "msg", key, time: { start_ms: at, precision: "ms" }, content: { key } });
    const main = { families: new Map<string, Family>(), now: () => SEP_20, log: () => undefined } as unknown as Main;
    const job = { id: 1, kind: "walk", key: FAMILY, lane: LANE.backfill, not_before_ms: 0, started_ms: 0 } as never;

    function open(place: (written: Record<string, unknown>) => Record<string, unknown>) {
      const dir = tempDir("walk-cap");
      const db: HomeDb = openHome(openHomeFolder(dir), "migrate");
      const reader: HomeDb = openHome(openHomeFolder(dir), "read");
      onTestFinished(() => {
        reader.close();
        db.close();
        removeDir(dir);
      });
      expect(new Set([t1, t2, t3, t4].map(weekOf)).size).toBe(1);
      land(db, { source: NOTES, stated_ms: SEP_20, rows: [msg("a", t1), msg("b", t1), msg("x", t1), msg("c", t2), msg("d", t3), msg("e", t4), msg("f", SEP_10)] });
      const handed: string[][] = [];
      const family = {
        name: FAMILY, code: "1", inputs: [{ sources: { product: ["apple-notes"] }, kinds: ["msg"], role: "evidence" }],
        touched: (changes: readonly Change[]) => {
          if (changes.length > 0) handed.push(changes.map((change) => change.record.key).sort());
          return changes.map((change) => ({ unit: change.record.key }));
        },
        extract: (unit: string) => ({ content: { unit }, start_ms: SEP_1, end_ms: SEP_1, reading: unit }),
        days: () => [],
      } as unknown as Family;
      (main.families as Map<string, Family>).set(FAMILY, family);
      db.commit((tx) => rebuildExtracts(tx, FAMILY, 0));
      db.commit((tx) => walkKind.begin!(main, tx, job));
      const read = () => JSON.parse(db.commit((tx) => tx.tables.meta.get(`walk:${FAMILY}`))!) as Record<string, unknown>;
      const edited = place(read());
      db.commit((tx) => tx.tables.meta.set(`walk:${FAMILY}`, JSON.stringify(edited)));
      const env = { db: reader, folder: openHomeFolder(dir), registry: { families: [family] }, settings: { day: { zone: "UTC", day_start_hour: 4 } }, committed: async () => undefined } as unknown as HelperEnv;
      return {
        async run() {
          const begun = db.commit((tx) => walkKind.begin!(main, tx, job))!;
          const running: Running<typeof begun.state> = { job, state: begun.state };
          const steps = walkKind.helper(env, { job: 1, kind: "walk", key: FAMILY, lane: LANE.backfill, now_ms: 0, data: begun.data });
          let step = await steps.next();
          for (; step.done !== true; step = await steps.next()) {
            for (const slice of walkKind.chunk!(main, running, step.value)) db.commit((tx) => slice.work(tx));
          }
          db.commit((tx) => walkKind.done(main, tx, running, step.value));
          const row = readHome(dir, (each) => each.prepare("SELECT counts FROM runs WHERE kind = 'walk' ORDER BY id DESC LIMIT 1").pluck().get()) as string;
          const { next_ms, log, slab } = read();
          return { handed: [...handed], place: { next_ms, log, slab }, row: JSON.parse(row) as Record<string, unknown> };
        },
      };
    }

    function bounds(walk: string | undefined, records: string | undefined): void {
      const was = [process.env.LIFESTREAM_TEST_WALK_MS, process.env.LIFESTREAM_TEST_SLAB_RECORDS];
      const set = (name: string, value: string | undefined) => {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      };
      set("LIFESTREAM_TEST_WALK_MS", walk);
      set("LIFESTREAM_TEST_SLAB_RECORDS", records);
      onTestFinished(() => {
        set("LIFESTREAM_TEST_WALK_MS", was[0]);
        set("LIFESTREAM_TEST_SLAB_RECORDS", was[1]);
      });
    }

    it("a week of more records than the cap is handed in parts of that many, or one whole instant, cut only between two starts", async () => {
      bounds(undefined, "2");
      const home = open((written) => ({ ...written, next_ms: weekOf(SEP_1) }));
      const { handed, place, row } = await home.run();
      expect({ handed, place }).toEqual({ handed: [["a", "b", "x"], ["c", "d"], ["e"], ["f"]], place: { next_ms: undefined, log: "reading", slab: undefined } });
      expect(row).toEqual(expect.objectContaining({ stage: "slabs", slabs: 4, records: 7, units: 7, longest_ms: expect.any(Number) as number, unit_ms: expect.any(Number) as number }));
      expect(row).not.toHaveProperty("untimed");
      expect(row).not.toHaveProperty("left");
    });

    it("a run past its bound ends after its first chunk, and the place keeps the slab's units, and where the next slab begins", async () => {
      bounds("-1", undefined);
      const home = open((written) => ({ ...written, next_ms: weekOf(SEP_1) }));
      const { handed, place, row } = await home.run();
      expect({ handed, place }).toEqual({
        handed: [["a", "b", "c", "d", "e", "x"]], place: { next_ms: weekOf(SEP_1) + WEEK, log: undefined, slab: { touched: ["a", "b", "x", "c", "d", "e"], previous: [] } },
      });
      expect(row).toEqual(expect.objectContaining({ slabs: 1, records: 6, units: 0, left: 6 }));
    });

    it("the first slab's run says it walked it", async () => {
      bounds("-1", "1000");
      const home = open((written) => written);
      const { handed, place, row } = await home.run();
      expect({ handed, place }).toEqual({ handed: [], place: { next_ms: weekOf(SEP_1), log: undefined, slab: undefined } });
      expect(row).toEqual(expect.objectContaining({ slabs: 1, records: 0, untimed: 1, longest_ms: expect.any(Number) as number }));
    });
  });
});

describe("a walk's run ends at the first chunk or unit past its bound, whatever the family's shape, and the next resumes there: by hand over a home.db, the family's cost its clock", () => {
  const FAMILY = "sample";
  const NOTES = "apple-notes:local:device-a";
  const COST_MS = 25_000;
  const at = (key: string, ms: number | undefined) => (ms === undefined ? {} : { time: { start_ms: ms, precision: "ms" as const } });
  const msg = (key: string, ms?: number): ReaderOutput => ({ kind: "msg", key, ...at(key, ms), content: { key } });
  const label = (key: string): ReaderOutput => ({ kind: "sample", key, content: { key } });
  const job = { id: 1, kind: "walk", key: FAMILY, lane: LANE.backfill, not_before_ms: 0, started_ms: 0 } as never;

  interface Shape {
    rows: ReaderOutput[];
    units(record: RecordRef): string[];
    previous?(record: RecordRef): string | undefined;
    labels?: string[];
    evidence?: string[];
    cost_ms?: number;
  }

  interface Ran {
    stage: string;
    records?: number;
    units?: number;
    left?: number;
    chunks: number;
  }

  function walked(name: string, shape: Shape) {
    const dir = tempDir(name);
    const db: HomeDb = openHome(openHomeFolder(dir), "migrate");
    const reader: HomeDb = openHome(openHomeFolder(dir), "read");
    onTestFinished(() => {
      reader.close();
      db.close();
      removeDir(dir);
    });
    land(db, { source: NOTES, stated_ms: SEP_20, rows: shape.rows });
    const cost = { clock: 0, chunks: 0 };
    const step_ms = shape.cost_ms ?? COST_MS;
    const family = {
      name: FAMILY, code: "1",
      inputs: [
        { sources: { product: ["apple-notes"] }, kinds: shape.evidence ?? ["msg"], role: "evidence" }, { sources: { product: ["apple-notes"] }, kinds: shape.labels ?? ["sample"], role: "labels" },
      ],
      touched: (changes: readonly Change[]) => {
        if (changes.length > 0) {
          cost.clock += step_ms;
          cost.chunks++;
        }
        return changes.flatMap((change) => {
          const previous = shape.previous?.(change.record);
          return shape.units(change.record).map((unit) => ({ unit, ...(previous === undefined ? {} : { previous }) }));
        });
      },
      extract: (unit: string, view: View) => {
        cost.clock += step_ms;
        const msgs = [...view.heads(NOTES, "msg", { start_ms: 0 })].map((head) => head.key);
        return { content: { unit, msgs }, start_ms: SEP_1, end_ms: SEP_1, reading: `${unit}:${msgs.join(",")}` };
      },
      days: () => [],
    } as unknown as Family;
    const main = { families: new Map([[FAMILY, family]]), now: () => SEP_20, log: () => undefined } as unknown as Main;
    const env = { db: reader, folder: openHomeFolder(dir), registry: { families: [family] }, settings: { day: { zone: "UTC", day_start_hour: 4 } }, committed: async () => undefined } as unknown as HelperEnv;
    db.commit((tx) => rebuildExtracts(tx, FAMILY, 0));
    const lastRow = (): Record<string, unknown> => JSON.parse(readHome(dir, (each) => each.prepare("SELECT counts FROM runs WHERE kind = 'walk' ORDER BY id DESC LIMIT 1").pluck().get()) as string) as Record<string, unknown>;
    const run = async (): Promise<Ran | null> => {
      const begun = db.commit((tx) => walkKind.begin!(main, tx, job));
      if (begun === null) return null;
      const running: Running<typeof begun.state> = { job, state: begun.state };
      cost.chunks = 0;
      const steps = walkKind.helper(env, { job: 1, kind: "walk", key: FAMILY, lane: LANE.backfill, now_ms: 0, data: begun.data });
      let step = await steps.next();
      for (; step.done !== true; step = await steps.next()) {
        for (const slice of walkKind.chunk!(main, running, step.value)) db.commit((tx) => slice.work(tx));
      }
      db.commit((tx) => walkKind.done(main, tx, running, step.value));
      const { stage, records, units, left } = lastRow() as { stage: string; records?: number; units?: number; left?: number };
      return { stage, ...(stage === "slabs" ? { records, units, ...(left === undefined ? {} : { left }) } : {}), chunks: cost.chunks };
    };
    return {
      dir,
      cost,
      async walk(): Promise<Ran[]> {
        const runs: Ran[] = [];
        for (let ran = await run(); ran !== null; ran = await run()) runs.push(ran);
        return runs;
      },
      served: () => readHome(dir, (each) => each.prepare("SELECT unit, reading, content, start_ms, end_ms, days FROM extracts WHERE family = ? ORDER BY unit").all(FAMILY)),
    };
  }

  async function bounded(name: string, shape: Shape, caps: { slab?: string; chunk?: string } = {}): Promise<{ runs: Ran[]; served: unknown[]; once: unknown[]; whole: Ran[]; dir: string }> {
    const names = ["LIFESTREAM_TEST_WALK_MS", "LIFESTREAM_TEST_SLAB_RECORDS", "LIFESTREAM_TEST_CHUNK_RECORDS"] as const;
    const was = names.map((key) => process.env[key]);
    const set = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    onTestFinished(() => names.forEach((key, index) => set(key, was[index])));
    set("LIFESTREAM_TEST_WALK_MS", "1000000000");
    set("LIFESTREAM_TEST_SLAB_RECORDS", undefined);
    set("LIFESTREAM_TEST_CHUNK_RECORDS", undefined);
    const unbounded = walked(`${name}-once`, shape);
    const whole = (await unbounded.walk()).filter((ran) => ran.stage === "slabs");
    set("LIFESTREAM_TEST_WALK_MS", "60000");
    set("LIFESTREAM_TEST_SLAB_RECORDS", caps.slab);
    set("LIFESTREAM_TEST_CHUNK_RECORDS", caps.chunk);
    const home = walked(name, shape);
    const now = vi.spyOn(performance, "now").mockImplementation(() => home.cost.clock);
    try {
      const runs = (await home.walk()).filter((ran) => ran.stage === "slabs");
      return { runs, served: home.served(), once: unbounded.served(), whole, dir: home.dir };
    } finally {
      now.mockRestore();
    }
  }

  it("a family of many labels and records that state no start hands them in chunks and builds their units across runs, each run ending at the first chunk or unit begun past its minute", async () => {
    const labels = Array.from({ length: 20 }, (_, n) => label(`l${String(n + 1).padStart(2, "0")}`));
    const shape: Shape = {
      rows: [...labels, msg("u1"), msg("u2"), msg("m1", SEP_1), msg("m2", SEP_1 + DAY)],
      units: (record) => [`${record.kind}/${record.key}`],
    };
    expect(weekOf(SEP_1 + DAY)).toBe(weekOf(SEP_1));
    const { runs, served, once, whole, dir } = await bounded("walk-bound-untimed", shape, { chunk: "4" });
    artifact(dir, "walk-bound-untimed", { runs, whole });
    expect(whole).toEqual([{ stage: "slabs", records: 24, units: 24, chunks: 2 }]);
    expect(runs).toEqual([
      { stage: "slabs", records: 12, units: 0, left: 12, chunks: 3 },
      { stage: "slabs", records: 10, units: 0, left: 22, chunks: 3 },
      ...[19, 16, 13, 10, 7, 4, 1].map((left) => ({ stage: "slabs", records: 0, units: 3, left, chunks: 0 })),
      { stage: "slabs", records: 2, units: 2, left: 1, chunks: 1 },
      { stage: "slabs", records: 0, units: 1, chunks: 0 },
    ]);
    expect(served).toEqual(once);
    expect(served).toHaveLength(24);
  });

  it("a family whose few records touch many costly units builds them across runs, three a run past a minute of 25 s units, and publishes what one run does", async () => {
    const shape: Shape = {
      rows: [msg("m1", SEP_1), msg("m2", SEP_1 + DAY)],
      units: (record) => Array.from({ length: 4 }, (_, n) => `${record.key}/${n}`),
    };
    const { runs, served, once, whole, dir } = await bounded("walk-bound-costly", shape);
    artifact(dir, "walk-bound-costly", { runs, whole });
    expect(whole).toEqual([{ stage: "slabs", records: 2, units: 8, chunks: 1 }]);
    expect(runs).toEqual([
      { stage: "slabs", records: 2, units: 2, left: 6, chunks: 1 },
      { stage: "slabs", records: 0, units: 3, left: 3, chunks: 0 },
      { stage: "slabs", records: 0, units: 3, chunks: 0 },
    ]);
    expect(served).toEqual(once);
    expect(served).toHaveLength(8);
  });

  it("a family whose records name a previous unit, of two label streams whose timed labels share one start, cut at every chunk and unit by caps of 1 and a chunk or unit the length of a run, publishes what one run does", async () => {
    const timed = (kind: string, key: string): ReaderOutput => ({ kind, key, ...at(key, SEP_1), content: { key } });
    const previous: Record<string, string> = { s2: "s1", g1: "s3", g2: "gone-g2", m1: "s2" };
    const shape: Shape = {
      rows: [timed("sample", "s1"), timed("sample", "s2"), timed("sample", "s3"), timed("gap", "g1"), timed("gap", "g2"), msg("m1", SEP_1)],
      units: (record) => [record.key],
      previous: (record) => previous[record.key],
      labels: ["sample", "gap"],
      cost_ms: 60_000,
    };
    const { runs, served, once, whole, dir } = await bounded("walk-bound-previous", shape, { slab: "1", chunk: "1" });
    artifact(dir, "walk-bound-previous", { runs, whole });
    expect(whole).toEqual([{ stage: "slabs", records: 6, units: 6, chunks: 2 }]);
    expect(runs).toEqual([
      ...[1, 2, 3, 4, 5].map((left) => ({ stage: "slabs", records: 1, units: 0, left, chunks: 1 })),
      ...[4, 3, 2, 1].map((left) => ({ stage: "slabs", records: 0, units: 1, left, chunks: 0 })),
      { stage: "slabs", records: 0, units: 1, chunks: 0 },
      { stage: "slabs", records: 1, units: 0, left: 1, chunks: 1 },
      { stage: "slabs", records: 0, units: 1, chunks: 0 },
    ]);
    expect(served).toEqual(once);
    expect((served as { unit: string }[]).map((row) => row.unit)).toEqual(["g1", "g2", "m1", "s1", "s3"]);
  });

  it("a family whose touched costs a whole minute a chunk hands one chunk a run, resumes after it in the first slab and inside a week, an instant split between chunks and streams, and publishes what one run does", async () => {
    const hour = 3_600_000;
    const timed = (kind: string, key: string, ms: number): ReaderOutput => ({ kind, key, ...at(key, ms), content: { key } });
    const shape: Shape = {
      rows: [
        label("l1"), label("l2"), label("l3"),
        timed("msg", "m1", SEP_1), timed("msg", "m2", SEP_1 + hour), timed("photo", "k1", SEP_1 + hour), timed("photo", "k2", SEP_1 + hour), timed("msg", "m3", SEP_1 + 2 * hour),
      ],
      units: (record) => [`${record.kind}/${record.key}`],
      evidence: ["msg", "photo"],
      cost_ms: 60_000,
    };
    const { runs, served, once, whole, dir } = await bounded("walk-bound-chunks", shape, { chunk: "2" });
    artifact(dir, "walk-bound-chunks", { runs, whole });
    expect(whole).toEqual([{ stage: "slabs", records: 8, units: 8, chunks: 2 }]);
    expect(runs).toEqual([
      { stage: "slabs", records: 2, units: 0, left: 2, chunks: 1 },
      { stage: "slabs", records: 1, units: 0, left: 3, chunks: 1 },
      ...[2, 1].map((left) => ({ stage: "slabs", records: 0, units: 1, left, chunks: 0 })),
      { stage: "slabs", records: 0, units: 1, chunks: 0 },
      { stage: "slabs", records: 2, units: 0, left: 2, chunks: 1 },
      { stage: "slabs", records: 2, units: 0, left: 4, chunks: 1 },
      { stage: "slabs", records: 1, units: 0, left: 5, chunks: 1 },
      ...[4, 3, 2, 1].map((left) => ({ stage: "slabs", records: 0, units: 1, left, chunks: 0 })),
      { stage: "slabs", records: 0, units: 1, chunks: 0 },
    ]);
    expect(served).toEqual(once);
    expect((served as { unit: string }[]).map((row) => row.unit)).toEqual(["msg/m1", "msg/m2", "msg/m3", "photo/k1", "photo/k2", "sample/l1", "sample/l2", "sample/l3"]);
  });
});

describe("a resumed slabs run: killed after a commit past its place, by hand over a home.db", () => {
  const PHONE = "location:local:iphone-0001";
  const SETTINGS_DAY = { zone: "UTC", day_start_hour: 4 };
  const physical = physicalFamily({ photos: RELEASE_FED.photos })(RELEASE_FED.physical);
  const main = { families: new Map([[physical.name, physical]]), now: () => Date.UTC(2026, 8, 25), log: () => undefined } as unknown as Main;
  const job = { id: 1, kind: "walk", key: physical.name, lane: LANE.backfill, not_before_ms: 0, started_ms: 0 } as never;
  const MIN = 60_000;
  const HOME = { latitude: 0, longitude: 0 };
  const OFFICE = { latitude: 0, longitude: 0.0135 };
  const GYM = { latitude: 0.009, longitude: 0.0135 };
  const at = (day: number, hour: number, minute = 0) => Date.UTC(2026, 8, day, hour, minute);
  const STAYS: [number, number, { latitude: number; longitude: number }][] = [
    [at(1, 8), at(1, 19), HOME], [at(1, 19, 10), at(2, 9), OFFICE], [at(2, 9, 10), at(3, 18), HOME], [at(3, 18, 10), at(5, 10), GYM],
    [at(5, 10, 10), at(7, 8), OFFICE], [at(7, 8, 10), at(10, 12), HOME], [at(10, 12, 10), at(12, 20), OFFICE], [at(12, 20, 10), at(14, 6), GYM],
    [at(14, 6, 10), at(17, 9), HOME], [at(17, 9, 10), at(18, 12), OFFICE],
  ];
  const SLAB = "150";

  function track(): ReaderOutput[] {
    let n = 0;
    const fix = (ms: number, point: { latitude: number; longitude: number }, speed: number): ReaderOutput => ({
      kind: "fix", key: `33333333-3333-4333-8333-333333333333:${++n}`, time: { start_ms: ms, precision: "ms" },
      content: { type: "location.fix", content: { kind: "fix", payload: { location: {
        timestamp_rfc3339_utc: new Date(ms).toISOString(), latitude: point.latitude, longitude: point.longitude, horizontal_accuracy: 5, altitude: 35, speed,
      } } } },
    });
    return STAYS.flatMap(([from, to, point], index) => {
      const still = Array.from({ length: Math.ceil((to - from) / (10 * MIN)) }, (_, step) => fix(from + step * 10 * MIN, point, 0));
      const next = STAYS[index + 1];
      if (next === undefined) return still;
      return [...still, ...Array.from({ length: 30 }, (_, leg) => fix(to + leg * 20_000, {
        latitude: point.latitude + (next[2].latitude - point.latitude) * leg / 30, longitude: point.longitude + (next[2].longitude - point.longitude) * leg / 30,
      }, 9))];
    });
  }

  function open(from?: string) {
    const dir = tempDir("walk-resumed");
    if (from !== undefined) cpSync(from, dir, { recursive: true, mode: constants.COPYFILE_FICLONE });
    const db: HomeDb = openHome(openHomeFolder(dir), from === undefined ? "migrate" : "write");
    const reader: HomeDb = openHome(openHomeFolder(dir), "read");
    const blobs = openHomeFolder(dir).blobs(join(dir, "blobs"));
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      reader.close();
      db.close();
    };
    onTestFinished(() => {
      close();
      removeDir(dir);
    });
    if (from === undefined) {
      db.commit((tx) => {
        tx.tables.sources.add({ id: PHONE, vendor: "apple", connector: "synthetic", added_ms: 0 });
        const run = tx.tables.runs.start({ kind: "import", subject: PHONE, started_ms: at(19, 0) });
        const landed = tx.records.land(run, { id: `${PHONE}/fixes`, source: PHONE, stated_ms: at(19, 0) }, track(), { fix: () => [] }, { has: () => true });
        expect(landed.refusals).toEqual([]);
        tx.tables.runs.end(run, { ended_ms: at(19, 0), outcome: "ok" });
        tx.tables.sources.advance(PHONE, at(19, 0));
      });
      db.commit((tx) => rebuildExtracts(tx, physical.name, 0));
    }
    const env = { db: reader, folder: openHomeFolder(dir), blobs, registry: { connectors: [], families: [physical] }, settings: { day: SETTINGS_DAY }, committed: async () => undefined } as unknown as HelperEnv;
    const sql = <T>(query: string): T[] => readHome(dir, (read) => read.prepare(query).all(physical.name)) as T[];
    return {
      dir,
      close,
      async run(walk: string, kill?: number): Promise<number> {
        process.env.LIFESTREAM_TEST_WALK_MS = walk;
        const begun = db.commit((tx) => walkKind.begin!(main, tx, job));
        if (begun === null) throw new Error("the walk begins with nothing to do");
        const running: Running<typeof begun.state> = { job, state: begun.state };
        const steps = walkKind.helper(env, { job: 1, kind: "walk", key: physical.name, lane: LANE.backfill, now_ms: 0, data: begun.data });
        let commits = 0;
        let step = await steps.next();
        for (; step.done !== true; step = await steps.next()) {
          for (const slice of walkKind.chunk!(main, running, step.value)) db.commit((tx) => slice.work(tx));
          if (++commits === kill) {
            await steps.return(undefined as never);
            return commits;
          }
        }
        db.commit((tx) => walkKind.done(main, tx, running, step.value));
        return commits;
      },
      async publish(): Promise<void> {
        while (this.place() !== undefined || this.owed()) await this.run("1000000000");
      },
      place: () => {
        const text = db.commit((tx) => tx.tables.meta.get(`walk:${physical.name}`));
        return text === undefined ? undefined : JSON.parse(text) as { next_ms?: number; log?: string; slab?: unknown };
      },
      owed: () => db.commit((tx) => (tx.tables.cursors.get(rebuildCursor(physical.name))?.seq ?? 0) > 0),
      next: () => sql<{ unit: string; start_ms: number }>("SELECT unit, start_ms FROM extracts_next WHERE family = ? ORDER BY unit"),
      served: () => sql<{ unit: string; reading: string; content: Uint8Array; start_ms: number; end_ms: number; days: string }>(
        "SELECT unit, reading, content, start_ms, end_ms, days FROM extracts WHERE family = ? ORDER BY unit"),
    };
  }

  async function placed(home: ReturnType<typeof open>) {
    await home.run("0");
    do await home.run("0");
    while (home.place()!.slab !== undefined);
    return home.place()!;
  }

  it("a run killed after any of its commits, its rows of later slabs beside the place it left, resumes and publishes what a walk with no kill publishes", async () => {
    const before = [process.env.LIFESTREAM_TEST_WALK_MS, process.env.LIFESTREAM_TEST_SLAB_RECORDS];
    process.env.LIFESTREAM_TEST_SLAB_RECORDS = SLAB;
    onTestFinished(() => {
      for (const [name, value] of [["LIFESTREAM_TEST_WALK_MS", before[0]], ["LIFESTREAM_TEST_SLAB_RECORDS", before[1]]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
    expect(new Set(STAYS.flatMap(([from, to]) => [weekOf(from), weekOf(to)])).size).toBe(4);

    const clean = open();
    const place = await placed(clean);
    expect(STAYS[1]![0] < place.next_ms! && place.next_ms! < STAYS[1]![1]).toBe(true);
    const commits = await clean.run("1000000000");
    expect(clean.place()).toEqual(expect.objectContaining({ log: "reading" }));
    await clean.publish();
    const once = clean.served();
    expect(once.filter((row) => row.unit.startsWith("stay/")).length).toBe(STAYS.length);
    expect(once.filter((row) => row.unit.startsWith("stay/") && row.start_ms < place.next_ms! && row.end_ms > place.next_ms!).length).toBe(1);
    expect(commits).toBeGreaterThan(3);

    const seeded = open();
    expect(await placed(seeded)).toEqual(place);
    seeded.close();
    const kills: Record<number, unknown> = {};
    for (let kill = 1; kill <= commits; kill++) {
      const home = open(seeded.dir);
      expect(home.place()).toEqual(place);
      expect(await home.run("1000000000", kill)).toBe(kill);
      const later = home.next().filter((row) => row.start_ms >= place.next_ms!).length;
      expect({ place: home.place(), later: later > 0 }).toEqual({ place, later: true });
      await home.publish();
      const served = home.served();
      const differ = [
        ...served.filter((row) => !once.some((other) => JSON.stringify(other) === JSON.stringify(row))).map((row) => ({ resumed: row })),
        ...once.filter((row) => !served.some((other) => JSON.stringify(other) === JSON.stringify(row))).map((row) => ({ clean: row })),
      ];
      kills[kill] = differ;
    }
    expect(kills).toEqual(Object.fromEntries(Array.from({ length: commits }, (_, index) => [index + 1, []])));
  });
});
