import { existsSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { addDays, civilDay, openHome, openHomeFolder, OwnerMap, type FillDays, type StoredFilling } from "@lifestreamprotocol/core";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { runCli } from "./cli.js";
import { startHome } from "./home.js";
import { HOME_FILE } from "./lifecycle.js";
import { effective } from "./settings.js";
import { askHome } from "./socket.js";
import { fits, loadMap, mapFileOf, OWNER_MAP, saveMap } from "./stored.js";
import { artifact, ChildHome, copyRoot, FAKES, hex, LOOK_MS, makeRoot, readHome, removeRoot, settled, TICK_MS, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { startHere } from "./test/harness-home.js";

async function withEnv<T>(values: Record<string, string>, work: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    return await work();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
import { editSettings, testSocket } from "./test/folder.js";
import { complete, counted, fillMark, recount, upgrade } from "./test/stored.js";

const DAY = 86_400_000;
const A = "apple-notes:local:device-a";
const B = "apple-notes:local:device-b";
const C = "apple-notes:local:device-c";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) removeRoot(root);
});

const file = (text: string) => {
  const bytes = Buffer.from(text);
  return { bytes, hex: hex(bytes), blob: `sha256:${hex(bytes)}` };
};
const note = (key: string, text: string, at: number, blobs: string[] = []) =>
  ({ kind: "note", key, content: { text, at, ...(blobs.length === 0 ? {} : { files: blobs }) }, at, ...(blobs.length === 0 ? {} : { blobs }) });

const storedFrom = (lines: readonly string[]): Record<string, unknown>[] =>
  lines.filter((line) => line.includes("\"stored\":\"")).map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => typeof line.stored === "string");

const storedLines = (root: string): Record<string, unknown>[] => {
  const log = join(root, "logs", "home.log");
  return !existsSync(log) ? [] : storedFrom(readFileSync(log, "utf8").split("\n"));
};

describe("the fill of a home upgraded with three sources over three days", () => {
  const f1 = file("a file only a1's first version names");
  const f2 = file("a file a2 and b1 both name");
  const f3 = file("a file b2 named before it arrived");
  const f4 = file("a file c2 names, larger than the rest of them all together".repeat(40));
  const fe = file("a file only the erased note names");
  let prepared: string;

  beforeAll(async () => {
    const root = makeRoot("lifestream-stored-prepared-", { sources: { [A]: "fake-rows", [B]: "fake-rows", [C]: "fake-rows" } });
    roots.push(root);
    let shift = 2 * DAY;
    const now = () => Date.now() - shift;
    const t1 = now() - 60_000;
    const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, clock: now, log: () => undefined });
    try {
      const big = "a long note, stored compressed. ".repeat(300);
      await ship(root, {
        source: A, fetched_ms: now(), carried: { [f1.hex]: f1.bytes, [f2.hex]: f2.bytes, [fe.hex]: fe.bytes },
        rows: [note("a1", "first", t1, [f1.blob]), note("a2", "with a shared file", t1, [f2.blob]), note("a3", "stated by two", t1), note("a4", big, t1),
          note("erased", "a note the owner erases", t1, [fe.blob])],
      });
      await until("day one imported", () => settled(root, 1));
      shift = DAY;
      const t2 = now() - 60_000;
      await ship(root, { source: B, fetched_ms: now(), rows: [note("a3", "stated by two", t1), note("b1", "the same file", t2, [f2.blob]), note("b2", "a file to come", t2, [f3.blob])] });
      await ship(root, { source: C, fetched_ms: now(), carried: { [f4.hex]: f4.bytes }, rows: [note("c1", "changed later", t2), note("c2", "a large file", t2, [f4.blob])] });
      await until("day two imported", () => settled(root, 3));
      shift = 0;
      await ship(root, { source: B, fetched_ms: now(), carried: { [f3.hex]: f3.bytes }, rows: [] });
      const t3 = now() - 60_000;
      await ship(root, { source: A, fetched_ms: now(), rows: [note("a1", "second", t3)] });
      await ship(root, { source: C, fetched_ms: now(), rows: [note("c1", "changed", t3)] });
      await ship(root, { source: C, fetched_ms: now() + 1_000, rows: [note("c1", "changed later", t2)] });
      await until("day three imported", () => settled(root, 7));
    } finally {
      await home.stop();
    }
    upgrade(root);
    prepared = root;
  });

  const day = (root: string) => effective(root).settings.day;

  it("counts each source's text and files as the recount does, by the days its runs began, and ends complete", async () => {
    const root = copyRoot(prepared, "lifestream-stored-fill-");
    roots.push(root);
    expect(fillMark(root)).toMatchObject({ blocks: 0, after: null });
    expect(counted(root).text).toEqual({});
    const logs: string[] = [];
    await startHere(root, { log: (line) => logs.push(line) });
    await until("the fill complete", () => complete(root));
    const truth = recount(root, day(root));
    const count = counted(root);
    expect(count).toEqual(truth);
    expect(Object.keys(truth.text)).toEqual([A, B, C]);
    expect(truth.rows[f2.blob]?.source).toBe(A);
    expect(truth.rows[f3.blob]?.source).toBe(B);
    const today = civilDay(Date.now(), day(root));
    expect(new Set(Object.keys(count.days).map((key) => key.split(" ")[0]))).toEqual(new Set([addDays(today, -2), addDays(today, -1), today]));
    const own = readHome(root, (db) => db.prepare("SELECT day, bytes FROM own_days ORDER BY day").all()) as { day: string; bytes: number }[];
    expect(own.map((row) => row.day)).toEqual([addDays(today, -2), addDays(today, -1)]);
    expect(own.every((row) => row.bytes > 0)).toBe(true);
    const rest = JSON.parse(readHome(root, (db) => db.prepare("SELECT value FROM meta WHERE key = 'stored:rest'").pluck().get() as string)) as { entries: number; capped: boolean };
    expect(rest).toMatchObject({ capped: false });
    expect(rest.entries).toBeGreaterThan(0);
    expect(readHome(root, (db) => db.prepare("SELECT key FROM events WHERE kind = 'stored'").pluck().all())).toEqual(["fill"]);
    const lines = logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.stored !== undefined);
    expect(lines).toEqual([expect.objectContaining({ stored: "fill", completed: true, maps: 1, refused: 0 })]);
    artifact(root, "stored-fill", { count, own, rest, lines });
  });

  it("killed after a slab's commit, goes on from it and counts every slab once", async () => {
    const root = copyRoot(prepared, "lifestream-stored-killed-");
    roots.push(root);
    const child = new ChildHome(root);
    onTestFinished(async () => { await child.stop(); });
    child.start("stored.slab", { env: { LIFESTREAM_TEST_STORED_MS: "0" } });
    expect(await child.exited()).toEqual({ code: null, signal: "SIGKILL" });
    const killed = fillMark(root);
    expect(killed).toMatchObject({ blocks: 1 });
    expect(killed).not.toMatchObject({ after: null });
    await startHere(root, { log: () => undefined });
    await until("the fill complete", () => complete(root));
    expect(counted(root)).toEqual(recount(root, day(root)));
    artifact(root, "stored-killed", { killed, count: counted(root) });
  });

  it("an erase between a slab's read and its commit leaves no erased byte counted, and the map is built again", async () => {
    const root = copyRoot(prepared, "lifestream-stored-erased-");
    roots.push(root);
    const gate = join(root, "stored-gate");
    const held = (): number => (existsSync(`${gate}.hits`) ? readFileSync(`${gate}.hits`, "utf8").split("\n").filter(Boolean).length : 0);
    writeFileSync(gate, "");
    const child = new ChildHome(root);
    onTestFinished(async () => { await child.stop(); });
    child.start("stored.read", { env: { LIFESTREAM_HOLD: gate } });
    await child.ready();
    await until("a batch read and held", () => held() === 1);
    await askHome(testSocket(root), "erase", ["notes", "erased", "--apply"]);
    await until("the fill read again after the erasure", () => held() === 2);
    expect(fillMark(root)).toMatchObject({ blocks: 0, after: null, erasures: 1 });
    rmSync(gate);
    await until("the fill complete", () => complete(root));
    await child.stop();
    const truth = recount(root, day(root));
    expect(counted(root)).toEqual(truth);
    expect(truth.rows[fe.blob]).toBeUndefined();
    expect(storedLines(root)).toEqual([expect.objectContaining({ stored: "fill", completed: true, maps: 1, refused: 0 })]);
    artifact(root, "stored-erased", { count: counted(root), lines: storedLines(root) });
  });
  const mapFile = (root: string) => mapFileOf(openHomeFolder(root), process.env.LIFESTREAM_MACHINE_DIR!);
  const ownDays = (root: string) => readHome(root, (db) => db.prepare("SELECT day, bytes FROM own_days ORDER BY day").all()) as { day: string; bytes: number }[];

  it("a fill over several runs builds its owner map once, each later run loading it, and the map goes at the end", async () => {
    const root = copyRoot(prepared, "lifestream-stored-runs-");
    roots.push(root);
    mapFile(root).remove();
    const raw: string[] = [];
    await withEnv({ LIFESTREAM_TEST_STORED_MS: "20", LIFESTREAM_TEST_STORED_RUN_MS: "0" }, async () => {
      const home = await startHere(root, { log: (line) => raw.push(line) });
      try {
        await until("the fill complete", () => complete(root));
      } finally {
        await home.stop();
      }
    });
    const lines = storedFrom(raw);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toMatchObject({ stored: "fill", maps: 1, loaded: 0 });
    for (const line of lines.slice(1)) expect(line).toMatchObject({ stored: "fill", maps: 0, loaded: 1, refused: 0 });
    expect(lines.filter((line) => line.completed === true)).toEqual([lines.at(-1)]);
    expect(counted(root)).toEqual(recount(root, day(root)));
    expect(mapFile(root).exists()).toBe(false);
    artifact(root, "stored-runs", { lines });
  });

  it("a map read over several runs goes on from its saved cursor through a kill between two, one batch a run", async () => {
    const root = copyRoot(prepared, "lifestream-stored-map-runs-");
    roots.push(root);
    mapFile(root).remove();
    const env = { LIFESTREAM_TEST_STORED_SEQS: "2", LIFESTREAM_TEST_STORED_MS: "20", LIFESTREAM_TEST_STORED_RUN_MS: "0" };
    const child = new ChildHome(root);
    onTestFinished(async () => { await child.stop(); });
    child.start("stored.map", { env });
    expect(await child.exited()).toEqual({ code: null, signal: "SIGKILL" });
    const mark = fillMark(root) as StoredFilling;
    expect(mark).toMatchObject({ blocks: 0, after: null, erasures: 0 });
    const kept = loadMap(mapFile(root), { settings: day(root), now_ms: Date.now() })!;
    expect(kept).not.toBeNull();
    expect(fits(kept, mark)).toBe(true);
    expect([kept.seq, kept.whole]).toEqual([2, false]);
    expect(kept.end).toBeGreaterThan(6);
    const raw: string[] = [];
    await withEnv(env, async () => {
      const home = await startHere(root, { log: (line) => raw.push(line) });
      try {
        await until("the fill complete", () => complete(root));
      } finally {
        await home.stop();
      }
    });
    const lines = storedFrom(raw);
    for (const line of lines) expect(line).toMatchObject({ stored: "fill", maps: 0, loaded: 1, refused: 0, map_end: kept.end });
    const mapping = lines.filter((line) => line.map_batches === 1);
    const cursors = Array.from({ length: Math.ceil((kept.end - 2) / 2) }, (_, at) => Math.min(kept.end, 4 + 2 * at));
    expect(mapping.map((line) => line.map_seq)).toEqual(cursors);
    expect(lines.slice(0, mapping.length)).toEqual(mapping);
    for (const line of lines) expect((line.map_batches as number) + (line.batches as number), JSON.stringify(line)).toBeLessThanOrEqual(1);
    expect(counted(root)).toEqual(recount(root, day(root)));
    expect(mapFile(root).exists()).toBe(false);
    artifact(root, "stored-map-runs", { kept: { seq: kept.seq, end: kept.end }, lines });
  });

  it("a map read in batches reads other statements than each batch's own seqs, before or after it is saved and loaded", () => {
    const root = copyRoot(prepared, "lifestream-stored-map-seqs-");
    roots.push(root);
    const mark = fillMark(root) as StoredFilling;
    const days: FillDays = { settings: day(root), now_ms: Date.now() };
    const saved = openHomeFolder(root).file(OWNER_MAP, join(root, "map-seqs", "owners.map"));
    const statements = (after: number, through: number) => readHome(root, (db) => db.prepare(`SELECT v.rowid, s.source, r.started_ms
      FROM statements s JOIN versions v ON v.id = s.version LEFT JOIN runs r ON r.id = s.run WHERE s.seq > ? AND s.seq <= ? AND v.rowid <= ? ORDER BY s.seq`)
      .raw(true).all(after, through, mark.M));
    const db = openHome(openHomeFolder(root), "read");
    try {
      const onView = <T>(read: (view: ReturnType<typeof db.view>) => T): T => {
        const view = db.view();
        try {
          return read(view);
        } finally {
          view.close();
        }
      };
      let seen: unknown[][] = [];
      const record = (map: OwnerMap): OwnerMap => {
        const see = map.see.bind(map);
        map.see = (rowid, source, started_ms) => {
          seen.push([rowid, source, started_ms]);
          see(rowid, source, started_ms);
        };
        return map;
      };
      const one = onView((view) => {
        const map = view.stored.ownerMap(days)!;
        expect(view.stored.mapBatch(map, Number.POSITIVE_INFINITY)).toBe(true);
        return map;
      });
      expect(one.end).toBeGreaterThan(6);
      let map = record(onView((view) => view.stored.ownerMap(days)!));
      const ranges: [number, number][] = [];
      for (let whole = false; !whole;) {
        if (ranges.length === 2) {
          saveMap(saved, map);
          map = record(loadMap(saved, days)!);
          expect(fits(map, mark)).toBe(true);
        }
        const after = map.seq;
        const through = Math.min(map.end, after + 2);
        seen = [];
        whole = onView((view) => view.stored.mapBatch(map, 2))!;
        expect(map.seq).toBe(through);
        expect(seen, `the batch of seqs ${after} to ${through}`).toEqual(statements(after, through));
        ranges.push([after, through]);
      }
      expect(ranges.length).toBeGreaterThan(3);
      expect(ranges.map(([after]) => after)).toEqual([0, ...ranges.slice(0, -1).map(([, through]) => through)]);
      expect(ranges.at(-1)![1]).toBe(one.end);
      for (let rowid = 1; rowid <= mark.M; rowid++) expect(map.at(rowid), `rowid ${rowid}`).toEqual(one.at(rowid));
    } finally {
      db.close();
    }
  });

  it("a run that reads its map in several batches holds a view between two of them, over a write landing there", async () => {
    const root = copyRoot(prepared, "lifestream-stored-map-views-");
    roots.push(root);
    mapFile(root).remove();
    const gate = join(root, "stored-gate");
    const held = (): number => (existsSync(`${gate}.hits`) ? readFileSync(`${gate}.hits`, "utf8").split("\n").filter(Boolean).length : 0);
    const imported = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE state = 'imported'").pluck().get()) as number;
    const before = imported();
    editSettings(root, { helpers: 3 });
    writeFileSync(gate, "");
    const child = new ChildHome(root);
    onTestFinished(async () => { await child.stop(); });
    child.start("stored.mapped", { env: { LIFESTREAM_HOLD: gate, LIFESTREAM_TEST_STORED_SEQS: "2" } });
    await child.ready();
    await until("the map's first batch read and held", () => held() === 1);
    await ship(root, { source: A, fetched_ms: Date.now(), rows: [note("between", "a note landed between two batches of the map", Date.now() - 60_000)] });
    await until("the delivery imported", () => imported() === before + 1);
    const log = new Database(join(root, "home.db"), { fileMustExist: true, timeout: 20_000 });
    let emptied: { busy: number; log: number; checkpointed: number };
    try {
      emptied = (log.pragma("wal_checkpoint(TRUNCATE)") as { busy: number; log: number; checkpointed: number }[])[0]!;
    } finally {
      log.close();
    }
    expect(emptied.busy).toBe(0);
    rmSync(gate);
    await until("the fill complete", () => complete(root));
    await child.stop();
    const lines = storedLines(root);
    expect(lines[0]).toMatchObject({ stored: "fill", maps: 1, loaded: 0, refused: 0 });
    const end = lines[0]!.map_end as number;
    expect(end).toBeGreaterThan(6);
    expect(lines[0]).toMatchObject({ map_batches: Math.ceil(end / 2), map_seq: end });
    expect(held()).toBe(Math.ceil(end / 2));
    expect(counted(root)).toEqual(recount(root, day(root)));
    artifact(root, "stored-map-views", { emptied, lines });
  });

  it("an erase between two runs builds the map again, and no erased byte is counted", async () => {
    const root = copyRoot(prepared, "lifestream-stored-erased-runs-");
    roots.push(root);
    mapFile(root).remove();
    const child = new ChildHome(root);
    onTestFinished(async () => { await child.stop(); });
    child.start("stored.slab", { env: { LIFESTREAM_TEST_STORED_MS: "0" } });
    expect(await child.exited()).toEqual({ code: null, signal: "SIGKILL" });
    expect(mapFile(root).exists()).toBe(true);
    expect(fillMark(root)).toMatchObject({ blocks: 1, erasures: 0 });
    expect(await runCli(["pause", "stored:count", "--reason", "a test", "--root", root], { write: () => undefined })).toBe(0);
    const raw: string[] = [];
    await withEnv({ LIFESTREAM_TEST_STORED_MS: "20", LIFESTREAM_TEST_STORED_RUN_MS: "0" }, async () => {
      const home = await startHere(root, { log: (line) => raw.push(line) });
      try {
        await askHome(testSocket(root), "erase", ["notes", "erased", "--apply"]);
        expect(fillMark(root)).toMatchObject({ blocks: 1, erasures: 1 });
        await askHome(testSocket(root), "resume", ["stored:count"]);
        await until("the fill complete", () => complete(root));
      } finally {
        await home.stop();
      }
    });
    const lines = [...storedLines(root), ...storedFrom(raw)];
    expect(lines[0]).toMatchObject({ stored: "fill", maps: 1, loaded: 0 });
    for (const line of lines.slice(1)) expect(line).toMatchObject({ stored: "fill", maps: 0, loaded: 1, refused: 0 });
    const truth = recount(root, day(root));
    expect(counted(root)).toEqual(truth);
    expect(truth.rows[fe.blob]).toBeUndefined();
    expect(mapFile(root).exists()).toBe(false);
    artifact(root, "stored-erased-runs", { lines, count: counted(root) });
  });

  it("the day's close writes the day that ended and the days the home was stopped through, from the next reading", async () => {
    const root = copyRoot(prepared, "lifestream-stored-close-");
    roots.push(root);
    const filling = await startHere(root, { log: () => undefined });
    await until("the fill complete", () => complete(root));
    await filling.stop();
    const today = civilDay(Date.now(), day(root));
    const filled = ownDays(root);
    expect(filled.map((row) => row.day)).toEqual([addDays(today, -2), addDays(today, -1)]);
    editSettings(root, { clocks: true });
    const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, clock: () => Date.now() + 3 * DAY, log: () => undefined });
    try {
      await until("the walk after the day's step", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM events WHERE kind = 'stored' AND key = 'rest'").pluck().get()) === 1);
    } finally {
      await home.stop();
    }
    const closed = ownDays(root);
    expect(closed.slice(0, 2)).toEqual(filled);
    expect(closed.slice(2).map((row) => row.day)).toEqual([today, addDays(today, 1), addDays(today, 2)]);
    expect(new Set(closed.slice(2).map((row) => row.bytes)).size).toBe(1);
    expect(closed[2]!.bytes).toBeGreaterThan(0);
    artifact(root, "stored-close", { filled, closed });
  });
});

describe("Storage's day's close on a new home", () => {
  it("a new home's first day's step closes the day before it was made, or its next one leaves out its first day", async () => {
    const root = makeRoot("lifestream-stored-new-", { sources: {}, clocks: true });
    const made = JSON.parse(readFileSync(join(root, HOME_FILE), "utf8")) as Record<string, unknown>;
    writeFileSync(join(root, HOME_FILE), JSON.stringify({ ...made, created: new Date().toISOString() }));
    const walks = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM events WHERE kind = 'stored' AND key = 'rest'").pluck().get()) as number;
    const ownDays = () => readHome(root, (db) => db.prepare("SELECT day FROM own_days ORDER BY day").pluck().all());
    try {
      let home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined });
      try {
        await until("the first day's walk", () => walks() === 1);
      } finally {
        await home.stop();
      }
      expect(ownDays()).toEqual([]);
      home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, clock: () => Date.now() + DAY, log: () => undefined });
      try {
        await until("the second day's walk", () => walks() === 2);
      } finally {
        await home.stop();
      }
      expect(ownDays()).toEqual([civilDay(Date.now(), effective(root).settings.day)]);
    } finally {
      removeRoot(root);
    }
  });
});

describe("the saved owner map", () => {
  const settings = { zone: "UTC", day_start_hour: 0 };
  const days = { settings, now_ms: Date.UTC(2026, 10, 13, 12) };
  const mark: StoredFilling = { M: 4096, blocks: 3, after: null, erasures: 2, slab_ms: 0 };
  const built = (seq = mark.M) => {
    const map = new OwnerMap(mark.M, mark.erasures, 0, 512, mark.M, "2026-11-10", "2026-11-13", settings);
    for (let rowid = 1; rowid <= seq; rowid++) {
      if (map.holds(rowid)) map.see(rowid, rowid % 3 === 0 ? "source-b" : "source-a", Date.UTC(2026, 10, 10 + (rowid % 3), 9));
    }
    map.seq = seq;
    return map;
  };
  const dir = mkdtempSync(join(tmpdir(), "lifestream-stored-map-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const kept = (path: string) => openHomeFolder(dir).file(OWNER_MAP, path);
  const served = (file: string, at: StoredFilling) => {
    const map = loadMap(kept(file), days);
    return map !== null && fits(map, at) ? map : null;
  };

  it("loads another map than it saved, or one whose stamp is not the mark's, or one that does not read whole", () => {
    const file = join(dir, "stored", "home", "owners.map");
    const map = built();
    saveMap(kept(file), map);
    const loaded = served(file, mark)!;
    expect(loaded).not.toBeNull();
    expect([loaded.M, loaded.erasures, loaded.from, loaded.to, loaded.end, loaded.seq, loaded.whole, loaded.first, loaded.sources])
      .toEqual([map.M, map.erasures, map.from, map.to, map.end, map.seq, true, map.first, map.sources]);
    expect(Buffer.from(loaded.owner.buffer)).toEqual(Buffer.from(map.owner.buffer));
    expect(Buffer.from(loaded.day.buffer)).toEqual(Buffer.from(map.day.buffer));
    for (const rowid of [1, 2, 3, 2000, 4096]) expect(loaded.at(rowid)).toEqual(map.at(rowid));
    expect(served(file, { ...mark, blocks: 1024, after: "sha256:00" })).not.toBeNull();
    expect(served(file, { ...mark, erasures: 3 })).toBeNull();
    expect(served(file, { ...mark, M: 4097 })).toBeNull();
    expect(served(file, { ...mark, blocks: 512 })).toBeNull();
    const bytes = readFileSync(file);
    bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 1, bytes.length - 1);
    writeFileSync(file, bytes);
    expect(served(file, mark)).toBeNull();
    saveMap(kept(file), map);
    truncateSync(file, readFileSync(file).length - 2);
    expect(served(file, mark)).toBeNull();
    rmSync(file);
    expect(served(file, mark)).toBeNull();
  });

  it("loads a map part read at another cursor than it saved, numbers its sources anew, or loads one whose stamp is not the mark's", () => {
    const file = join(dir, "stored", "part", "owners.map");
    const part = built(1500);
    expect(part.whole).toBe(false);
    saveMap(kept(file), part);
    const loaded = served(file, mark)!;
    expect([loaded.seq, loaded.end, loaded.whole]).toEqual([1500, mark.M, false]);
    const unread = Array.from({ length: mark.M }, (_, at) => at + 1).find((rowid) => rowid > 1500 && part.holds(rowid))!;
    const read = Array.from({ length: 1500 }, (_, at) => at + 1).find((rowid) => part.holds(rowid))!;
    expect(loaded.at(unread)).toBeUndefined();
    expect(loaded.at(read)).toEqual(part.at(read));
    expect(loaded.at(read)).toBeDefined();
    expect(loaded.number("source-a")).toBe(part.number("source-a"));
    expect(loaded.number("source-c")).toBe(3);
    expect(loaded.sources).toEqual(["", "source-a", "source-b", "source-c"]);
    expect(served(file, { ...mark, erasures: 3 })).toBeNull();
    expect(served(file, { ...mark, blocks: 512 })).toBeNull();
  });
});

describe("Storage counts an import's files once", () => {
  const named = (key: string, at: number, blob?: string) => ({ kind: "note", key, content: { text: key, at }, at, ...(blob === undefined ? {} : { blobs: [blob] }) });
  const day = (root: string) => effective(root).settings.day;
  const same = (root: string) => {
    const { days: _counted, ...count } = counted(root);
    const { days: _truth, ...truth } = recount(root, day(root));
    expect(count).toEqual(truth);
    return count;
  };

  it("a file that arrives after the record that wanted it is counted once, to that record's source, by its length", async () => {
    const root = makeRoot("lifestream-imports-stored-arrival-", { sources: { [A]: "fake-rows", [B]: "fake-rows" } });
    roots.push(root);
    const late = file("a file the first delivery names and the second brings");
    const at = Date.now() - 3_600_000;
    const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined });
    try {
      await ship(root, { source: A, fetched_ms: at, rows: [named("wants", at, late.blob)] });
      await until("the first imported", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE state = 'imported'").pluck().get()) === 1);
      expect(counted(root).rows).toEqual({});
      await ship(root, { source: B, fetched_ms: at + 60_000, carried: { [late.hex]: late.bytes }, rows: [named("also", at, late.blob)] });
      await until("the second imported", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE state = 'imported'").pluck().get()) === 2);
      const count = same(root);
      expect(count.rows[late.blob]).toEqual(expect.objectContaining({ source: A, bytes: late.bytes.length }));
      expect(count.files).toEqual({ [A]: late.bytes.length });
      artifact(root, "imports-stored-arrival", count);
    } finally {
      await home.stop();
    }
  });

  it("an import killed after a slice's commit, then run again, counts each of its files and texts once", async () => {
    const root = makeRoot("lifestream-imports-stored-killed-", { sources: { [A]: "fake-rows" } });
    roots.push(root);
    const files = Array.from({ length: 5 }, (_, index) => file(`file ${index} of the killed import`));
    const at = Date.now() - 3_600_000;
    const rows = Array.from({ length: 600 }, (_, index) => named(`n${index}`, at + index, index < 3 ? files[index]!.blob : index >= 550 && index < 552 ? files[index - 547]!.blob : undefined));
    const id = await ship(root, { source: A, fetched_ms: at, carried: Object.fromEntries(files.map((each) => [each.hex, each.bytes])), rows }, false);
    const child = new ChildHome(root);
    onTestFinished(async () => { await child.stop(); });
    child.start("home.slice");
    expect(await child.exited()).toEqual({ code: null, signal: "SIGKILL" });
    const killed = counted(root);
    expect(Object.keys(killed.rows)).toHaveLength(3);
    const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined });
    try {
      await until("the delivery imported", () => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(id)) === "imported");
      const count = same(root);
      expect(count.files).toEqual({ [A]: files.reduce((sum, each) => sum + each.bytes.length, 0) });
      artifact(root, "imports-stored-killed", { killed, count });
    } finally {
      await home.stop();
    }
  });
  it("a file a delivery brings for a version that named it already is counted by the commit before its rows, and stays counted through a kill", async () => {
    const root = makeRoot("lifestream-imports-stored-brought-", { sources: { [A]: "fake-rows" } });
    roots.push(root);
    const brought = file("a file a version named before a later delivery brought it");
    const at = Date.now() - 3_600_000;
    const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined });
    try {
      await ship(root, { source: A, fetched_ms: at, rows: [named("wants", at, brought.blob)] });
      await until("the first imported", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE state = 'imported'").pluck().get()) === 1);
    } finally {
      await home.stop();
    }
    expect(counted(root).rows).toEqual({});
    const rows = [{ ...named("wants", at, brought.blob), stores: brought.bytes.toString() }, ...Array.from({ length: 599 }, (_, index) => named(`n${index}`, at + index + 1))];
    const id = await ship(root, { source: A, fetched_ms: at + 60_000, rows }, false);
    const child = new ChildHome(root);
    onTestFinished(async () => { await child.stop(); });
    child.start("home.slice");
    expect(await child.exited()).toEqual({ code: null, signal: "SIGKILL" });
    const killed = same(root);
    expect(killed.rows[brought.blob]).toEqual({ source: A, version: expect.any(Number), bytes: brought.bytes.length });
    const again = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined });
    try {
      await until("the delivery imported", () => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(id)) === "imported");
      const count = same(root);
      expect(count.files).toEqual({ [A]: brought.bytes.length });
      artifact(root, "imports-stored-brought", { killed, count });
    } finally {
      await again.stop();
    }
  });
});
