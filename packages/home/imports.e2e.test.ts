import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { civilDay, dayBounds, openHome, openHomeFolder, type JobRow, type JsonObject, type ReaderOutput, type Tx } from "@lifestreamprotocol/core";
import type { Labeler } from "@lifestreamprotocol/connect";
import type { Main } from "./jobs.js";
import { startHome, type Home } from "./home.js";
import { CHUNK_ROWS, importKind, indexKind, labelKind, ORDERED_ROWS, streamed, todayFirst } from "./import.js";
import { HEARTBEATS } from "./quiet.js";
import { basicInstant, inboxLane, openSealing, readDelivery } from "./inbox.js";
import { LANE } from "./jobs.js";
import { KINDS } from "./kinds.js";
import { mintPrincipal } from "./principals.js";
import { effective } from "./settings.js";
import { ask, askHome } from "./socket.js";
import { CONNECT_CODE } from "./test/fakes.js";
import { artifact, FAKES, freeSpace, hex, LOOK_MS, makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { ship, shipFiles } from "./test/harness-deliveries.js";
import { doorHere } from "./test/harness-door.js";
import { statusOf, streamsOf } from "./test/harness-status.js";
import { DEVICE, phoneBundle } from "./test/support.js";
import { testSocket } from "./test/folder.js";


const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const POLLED = "apple-notes:local:poll";
const note = (key: string, at: number) => ({ kind: "note", key, content: { text: key, at }, at });

describe("imports of one source", () => {
  const roots: string[] = [];

  afterAll(() => {
    for (const root of roots) removeRoot(root);
  });

  it("a source's deliveries import out of their order, or two at once", async () => {
    const root = makeRoot("lifestream-imports-order-", { sources: { "apple-notes:local:device-a": "fake-rows", "apple-notes:local:device-b": "fake-rows" }, helpers: 4 });
    roots.push(root);
    const t0 = Date.now() - 30 * MINUTE;
    const order = [3, 0, 4, 1, 2];
    for (const index of order) {
      for (const source of ["apple-notes:local:device-a", "apple-notes:local:device-b"]) {
        const at = t0 + index * MINUTE;
        const rows = Array.from({ length: 300 }, (_, row) => ({ kind: "note", key: `n${row}`, content: { text: `delivery ${index} row ${row}`, at: at - row }, at: at - row }));
        await ship(root, { source, fetched_ms: at, rows }, false);
      }
    }
    const home = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, registry: FAKES, log: () => undefined });
    try {
      await until("every delivery imported", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE state = 'imported'").pluck().get()) === 10);
      const runs = readHome(root, (db) => db.prepare(`SELECT r.id, r.started_ms, r.ended_ms, d.source, d.stated_ms FROM runs r JOIN deliveries d ON d.run = r.id
        WHERE r.kind = 'import' ORDER BY r.id`).all() as { id: number; started_ms: number; ended_ms: number; source: string; stated_ms: number }[]);
      for (const source of ["apple-notes:local:device-a", "apple-notes:local:device-b"]) {
        const mine = runs.filter((run) => run.source === source);
        expect(mine.map((run) => run.stated_ms)).toEqual([...mine.map((run) => run.stated_ms)].sort((left, right) => left - right));
        for (let index = 1; index < mine.length; index++) expect(mine[index]!.started_ms).toBeGreaterThanOrEqual(mine[index - 1]!.ended_ms);
      }
      artifact(root, "imports-in-order", runs);
    } finally {
      await home.stop();
    }
  });

  it("an import interrupted after a slice, then run by a connector release that reads one row more, never lands that row", async () => {
    const root = makeRoot("lifestream-imports-replay-", { sources: { "apple-notes:local:device-a": "fake-rows" } });
    roots.push(root);
    const at = Date.now() - HOUR;
    const hold = join(root, "hold");
    const release = join(root, "release");
    writeFileSync(hold, "");
    const note = (key: string) => ({ kind: "note", key, content: { text: key, at }, at });
    const rows = [
      { ...note("recovered"), read_if: release },
      ...Array.from({ length: 3_000 }, (_, index) => note(`n${index}`)),
      { hold },
      ...Array.from({ length: 10 }, (_, index) => note(`tail${index}`)),
    ];
    const id = await ship(root, { source: "apple-notes:local:device-a", fetched_ms: at, rows }, false);
    const landed = () => {
      const progress = readHome(root, (db) => db.prepare("SELECT progress FROM jobs WHERE kind = 'import' AND key = 'apple-notes:local:device-a'").pluck().get()) as string | null | undefined;
      return typeof progress === "string" ? (JSON.parse(progress) as { counts: { new: number } }).counts.new : 0;
    };
    let home = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, registry: FAKES, log: () => undefined });
    try {
      await until("a slice landed and the read held", () => landed() > 0 && existsSync(`${hold}.held`));
      await home.stop();
      const landedAtStop = landed();
      writeFileSync(release, "");
      rmSync(hold);
      home = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, registry: FAKES, log: () => undefined });
      await until("the delivery imported", () => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(id)) === "imported");
      const keys = readHome(root, (db) => db.prepare("SELECT key FROM heads WHERE source = 'apple-notes:local:device-a'").pluck().all()) as string[];
      const runs = readHome(root, (db) => db.prepare("SELECT id, outcome, counts FROM runs WHERE kind = 'import'").all()) as { id: number; outcome: string; counts: string }[];
      const counts = JSON.parse(runs[0]!.counts) as { new: number; duplicated: number };
      artifact(root, "imports-replay", { landed_at_stop: landedAtStop, heads: keys.length, recovered: keys.includes("recovered"), runs });
      expect(keys.includes("recovered")).toBe(true);
      expect(keys).toHaveLength(3_011);
      expect(runs.map((run) => run.outcome)).toEqual(["ok"]);
      expect(counts).toMatchObject({ new: 3_011, duplicated: landedAtStop });
    } finally {
      await home.stop();
    }
  });

  it("a reader's throw or malformed row stops its stream, fails its import or lands less than it yielded; the rest's example lost past ten; a guard's throw costing more than its row; input a fetched copy's reader did not read kept as a notice while a delivery holds some, whatever a newer delivery read, and never a need or a Skip", async () => {
    const S = POLLED;
    const root = makeRoot("lifestream-imports-floor-", { sources: { [S]: "fake-rows" }, settings: { "connectors.fake-poll": { refresh: "10m" } } });
    roots.push(root);
    const always = join(root, "always");
    writeFileSync(always, "");
    const t0 = Date.now() - HOUR;
    const throws = (error: string) => ({ throw_if: always, error });
    const d1 = await ship(root, { source: S, fetched_ms: t0, rows: [
      note("n1", t0), note("n2", t0), note("n3", t0),
      ...Array.from({ length: 11 }, (_, index) => ({ kind: "note", key: `b${index}`, content: { text: "states no at" } })),
      throws("Refused"),
    ] }, false);
    const d2 = await ship(root, { source: S, fetched_ms: t0 + MINUTE, rows: [note("n4", t0), throws("TypeError")] }, false);
    const d3 = await ship(root, { source: S, fetched_ms: t0 + 2 * MINUTE, rows: [note("n5", t0), throws("TimeError")] }, false);
    const d4 = await ship(root, { source: S, fetched_ms: t0 + 3 * MINUTE, rows: [
      { kind: "note", key: "g1", content: { text: "g1", at: t0, guard_throws: true }, at: t0 }, note("n6", t0),
      { ...note("m1", t0), blobs: `sha256:${"ab".repeat(32)}` }, { ...note("m2", t0), bytes: 5 }, note("m3", t0),
    ] }, false);
    const d5 = await shipFiles(root, S, t0 + 4 * MINUTE, { "rows.ndjson": Buffer.from([0xff, 0xfe, 0x0a]) });
    const home = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, registry: FAKES, log: () => undefined });
    try {
      const sock = testSocket(root);
      const rows = () => readHome(root, (db) => db.prepare(`SELECT d.id, d.state, d.refused, r.outcome, r.counts FROM deliveries d JOIN runs r ON r.id = d.run
        WHERE d.source = ? ORDER BY d.stated_ms`).all(S)) as { id: string; state: string; refused: number; outcome: string; counts: string }[];
      await until("every delivery imported", () => rows().length === 5 && rows().every((row) => row.state === "imported"));
      const read = rows().map((row) => ({ ...row, counts: JSON.parse(row.counts) as { refused: number; refusals: { kind: string; key: string; violations: string[] }[] } }));
      expect(read.map((row) => [row.id, row.refused, row.outcome, row.counts.refused])).toEqual([[d1, 12, "ok", 12], [d2, 1, "ok", 1], [d3, 1, "ok", 1], [d4, 3, "ok", 3], [d5, 1, "ok", 1]]);
      expect(read[0]!.counts.refusals).toHaveLength(11);
      expect(read.map((row) => row.counts.refusals.at(-1))).toEqual([
        { kind: "delivery", key: d1, violations: ["after 14 rows: Refused: a synthetic refusal past the rows read"] },
        { kind: "delivery", key: d2, violations: ["after 1 rows: TypeError: a synthetic bug past the rows read"] },
        { kind: "delivery", key: d3, violations: ["after 1 rows: TimeError: a synthetic time past the rows read"] },
        { kind: "delivery", key: d4, violations: [expect.stringMatching(/^after 3 rows: TypeError: /u)] },
        { kind: "delivery", key: d5, violations: [expect.stringMatching(/^after 0 rows: BlobError: blob sha256:[0-9a-f]{64} is not UTF-8 text$/u)] },
      ]);
      expect(read[3]!.counts.refusals.slice(0, 2)).toEqual([
        { kind: "note", key: "g1", violations: ["the guard of 'note' threw: TypeError: a synthetic guard's bug"] }, { kind: "note", key: "m1", violations: ["blobs is not a list"] },
      ]);
      const keys = readHome(root, (db) => db.prepare("SELECT key FROM heads WHERE source = ? ORDER BY key").pluck().all(S));
      expect(keys).toEqual(["n1", "n2", "n3", "n4", "n5", "n6"]);
      expect(readHome(root, (db) => db.prepare("SELECT count(*) FROM events WHERE kind = 'import-failed'").pluck().get())).toBe(0);
      const status = async () => statusOf(root);
      const needs = async () => (await status()).needs;
      const unread = `unread:${S}`;
      expect((await needs()).map((need) => need.id), "rows a fetched copy's reader refused are no need the person can act on").not.toContain(unread);
      expect(streamsOf(root).needs.map((need) => need.id)).not.toContain(unread);
      expect((await status()).notices.find((notice) => notice.id === unread)?.what)
        .toMatch(new RegExp(`^${S}: 5\u00a0deliveries hold input this code could not read; newest ${d5}: after 0 rows: BlobError: .* \\(the next release reads them again; run import ${S} now\\)$`, "u"));
      expect((await needs()).map((need) => need.id)).not.toContain(`job:import:${S}`);
      const d6 = await ship(root, { source: S, fetched_ms: t0 + 5 * MINUTE, rows: [note("n7", t0), { kind: "note", key: "r1", content: { text: "states no at" } }] });
      await until("the next delivery imported", () => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(d6)) === "imported");
      expect((await status()).notices.find((notice) => notice.id === unread)).toMatchObject({
        what: `${S}: 6\u00a0deliveries hold input this code could not read; newest ${d6}: 1\u00a0row or file refused (the next release reads them again; run import ${S} now)`,
      });
      const d7 = await ship(root, { source: S, fetched_ms: t0 + 6 * MINUTE, rows: [note("n8", t0)] });
      await until("a delivery read whole", () => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(d7)) === "imported");
      expect((await needs()).map((need) => need.id)).not.toContain(unread);
      await expect(askHome(sock, "act", [unread, "skip"])).rejects.toThrow(/offers no skip now/u);
      const states = readHome(root, (db) => db.prepare("SELECT id, state FROM deliveries WHERE source = ? ORDER BY sealed_ms").all(S)) as { id: string; state: string }[];
      expect(states.map((row) => row.state)).toEqual(Array.from({ length: 7 }, () => "imported"));
      expect(readHome(root, (db) => db.prepare("SELECT key FROM heads WHERE source = ? ORDER BY key").pluck().all(S))).toEqual(["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8"]);
      artifact(root, "imports-floor", { deliveries: read, keys, kept: states });
    } finally {
      await home.stop();
    }
  });

  it("a source's fresh delivery waits behind its backlog in the backfill lane, behind a derived rebuild", async () => {
    const root = makeRoot("lifestream-imports-lanes-", {
      sources: { "apple-notes:local:archive": "fake-rows", "apple-notes:local:device-a": "fake-rows", "apple-notes:local:device-b": "fake-rows" }, helpers: 4,
    });
    roots.push(root);
    const now = Date.now();
    const hold = join(root, "hold");
    writeFileSync(hold, "");
    const home = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, registry: FAKES, log: () => undefined });
    try {
      await until("the start's walks published", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM cursors WHERE name LIKE 'rebuild:%' AND seq > 0").pluck().get()) === 0);
      await ship(root, { source: "apple-notes:local:archive", fetched_ms: now - 30 * DAY, rows: [{ kind: "note", key: "a1", content: { text: "archive", at: now - 30 * DAY, hold }, at: now - 30 * DAY }], facts: { history: true } });
      const extract = () => readHome(root, (db) => db.prepare("SELECT state, lane FROM jobs WHERE kind = 'extract' AND key = 'notes'").get()) as { state: string; lane: number } | undefined;
      await until("the extract running in the backfill lane", () => existsSync(`${hold}.held`) && extract()?.state === "running" && extract()?.lane === LANE.backfill);
      const note = (source: string, at: number, key: string, history: boolean) => ship(root, { source, fetched_ms: at, rows: [{ kind: "note", key, content: { text: key, at }, at }], facts: history ? { history } : {} });
      const backlog = [await note("apple-notes:local:device-a", now - 3 * HOUR, "a-old-1", true), await note("apple-notes:local:device-a", now - 2 * HOUR, "a-old-2", true)];
      const fresh = await note("apple-notes:local:device-a", now - 1_000, "a-fresh", false);
      const old = [await note("apple-notes:local:device-b", now - 3 * HOUR, "b-old-1", true), await note("apple-notes:local:device-b", now - 2 * HOUR, "b-old-2", true)];
      const state = (id: string) => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(id)) as string | undefined;
      await until("every delivery of device-a and device-b imported", () => [...backlog, fresh, ...old].every((id) => state(id) === "imported"));
      expect(extract()).toEqual({ state: "running", lane: LANE.live });
      const lanes = readHome(root, (db) => db.prepare("SELECT key, lane FROM jobs WHERE kind = 'import' ORDER BY key").all()) as { key: string; lane: number }[];
      expect(lanes).toEqual([
        { key: "apple-notes:local:archive", lane: LANE.history },
        { key: "apple-notes:local:device-a", lane: LANE.live },
        { key: "apple-notes:local:device-b", lane: LANE.history },
      ]);
      const runs = readHome(root, (db) => db.prepare("SELECT subject FROM runs WHERE kind = 'import' AND subject LIKE 'apple-notes:local:device-a %' ORDER BY id").pluck().all()) as string[];
      expect(runs).toEqual([...backlog, fresh].map((id) => `apple-notes:local:device-a ${id}`));
      rmSync(hold);
      await until("the extract done", () => extract()?.state === "done");
      artifact(root, "imports-lanes", { lanes, runs });
    } finally {
      await home.stop();
    }
  });

  it("two sources' deliveries import in the order they arrived, with one helper for imports: a backlog lands one after another, and holds no other source's turn", async () => {
    const A = "apple-notes:local:device-a", B = "apple-notes:local:device-b";
    const root = makeRoot("lifestream-imports-turn-", { sources: { [A]: "fake-rows", [B]: "fake-rows" }, helpers: 2 });
    roots.push(root);
    const t0 = Date.now() - 10 * MINUTE;
    const arrived = [A, A, A, B, A, B, A, B];
    for (const [index, source] of arrived.entries()) {
      const at = t0 + index * MINUTE;
      await ship(root, { source, fetched_ms: at, rows: [{ kind: "note", key: `n${index}`, content: { text: `delivery ${index}`, at }, at }] }, false);
    }
    const home = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, registry: FAKES, log: () => undefined });
    try {
      await until("every delivery imported", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE state = 'imported'").pluck().get()) === arrived.length);
      const order = readHome(root, (db) => db.prepare("SELECT d.source FROM runs r JOIN deliveries d ON d.run = r.id WHERE r.kind = 'import' ORDER BY r.started_ms, r.id").pluck().all());
      artifact(root, "imports-turn", { arrived, order });
      expect(order).toEqual(arrived);
    } finally {
      await home.stop();
    }
  });

  it("a backlog of thousands of quiet rows lands a batch a commit, in delivery order, the main thread free between batches", async () => {
    const MOTION = "motion:local:iphone-0001";
    const root = makeRoot("lifestream-imports-quiet-", { sources: { [MOTION]: "fake-rows" } });
    roots.push(root);
    const count = 3 * HEARTBEATS + 7;
    const t0 = Date.now() - DAY;
    const db = openHome(openHomeFolder(root), "migrate");
    db.commit((tx) => {
      for (let index = 0; index < count; index++) {
        const at = t0 + index * 20_000;
        tx.tables.deliveries.add({ id: `phone:iphone-0001/${index}`, source: MOTION, sealed_ms: at, stated_ms: at, facts: { domains: { "location.jsonl": { observations: 1 } } } });
      }
    });
    db.close();
    const landed = () => readHome(root, (db) => db.prepare(`SELECT count(*) AS imported, max(stated_ms) AS last,
      (SELECT min(stated_ms) FROM deliveries WHERE source = ? AND state <> 'imported') AS first_waiting,
      (SELECT read_through_ms FROM sources WHERE id = ?) AS read_through
      FROM deliveries WHERE source = ? AND state = 'imported'`).get(MOTION, MOTION, MOTION)) as { imported: number; last: number | null; first_waiting: number | null; read_through: number | null };
    const seen: ReturnType<typeof landed>[] = [];
    let probing = true;
    const probe = () => {
      const now = landed();
      if (seen.at(-1)?.imported !== now.imported) seen.push(now);
      if (probing) setImmediate(probe);
    };
    probe();
    const home = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, registry: FAKES, log: () => undefined });
    try {
      await until("every quiet row landed", () => seen.at(-1)?.imported === count);
      probing = false;
      artifact(root, "imports-quiet", { count, batch: HEARTBEATS, seen });
      expect(seen.length).toBeGreaterThan(2);
      for (const at of seen) expect(at.imported % HEARTBEATS === 0 || at.imported === count).toBe(true);
      for (const at of seen.slice(1)) {
        expect(at.first_waiting === null || at.last! < at.first_waiting).toBe(true);
        expect(at.read_through).toBe(at.last);
      }
      expect(seen.at(-1)!.read_through).toBe(t0 + (count - 1) * 20_000);
      expect(readHome(root, (db) => db.prepare("SELECT count(*) FROM runs WHERE kind = 'import'").pluck().get())).toBe(0);
    } finally {
      probing = false;
      await home.stop();
    }
  });

  it("history imports take more than one helper", async () => {
    const root = makeRoot("lifestream-imports-history-", { sources: { "apple-notes:local:device-a": "fake-rows", "apple-notes:local:device-b": "fake-rows" }, helpers: 4 });
    roots.push(root);
    const home = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, registry: FAKES, log: () => undefined });
    try {
      const at = Date.now() - 3 * HOUR;
      const gate = join(root, "gate");
      writeFileSync(gate, "");
      for (const source of ["apple-notes:local:device-a", "apple-notes:local:device-b"]) await ship(root, { source, fetched_ms: at, rows: [{ kind: "note", key: source, content: { text: source, at }, at }], facts: { hold: gate, history: true } });
      const imports = () => readHome(root, (db) => db.prepare("SELECT state, lane FROM jobs WHERE kind = 'import' ORDER BY state").all()) as { state: string; lane: number }[];
      await until("one history import running", () => imports().some((job) => job.state === "running"));
      const started = home.stats().jobs;
      await askHome(testSocket(root), "run", ["index-inbox", "inbox"]);
      await until("the inbox indexed after the imports were due", () => home.stats().jobs > started &&
        readHome(root, (db) => db.prepare("SELECT state FROM jobs WHERE kind = 'index-inbox'").pluck().get()) === "done");
      const held = { imports: imports(), helpers: home.stats().helpers };
      expect(held.imports).toEqual([{ state: "queued", lane: LANE.history }, { state: "running", lane: LANE.history }]);
      rmSync(gate);
      await until("both imported", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE state = 'imported'").pluck().get()) === 2);
      artifact(root, "imports-history-one-helper", held);
    } finally {
      await home.stop();
    }
  });

  it("a queued import an earlier look (or an older release) left in a higher lane stays there, above the lane it is due in now", async () => {
    const root = makeRoot("lifestream-imports-lowered-", { sources: { "apple-notes:local:device-a": "fake-rows" } });
    roots.push(root);
    const now = Date.now();
    const at = now - 2 * DAY;
    const id = await ship(root, { source: "apple-notes:local:device-a", fetched_ms: at, rows: [{ kind: "note", key: "old", content: { text: "old", at }, at }], facts: { history: true } }, false);
    const db = openHome(openHomeFolder(root), "migrate");
    db.commit((tx) => {
      const [lane, name] = id.split("/") as [string, string];
      const delivery = readDelivery(openHomeFolder(root), lane, name)!;
      tx.tables.deliveries.add({ id, source: lane, sealed_ms: delivery.sealed_ms, stated_ms: delivery.stated_ms, facts: delivery.facts });
      tx.tables.jobs.enqueue({ kind: "import", key: "apple-notes:local:device-a", lane: LANE.backfill, not_before_ms: at, now_ms: at });
      tx.tables.controls.set({ target: "import:apple-notes:local:device-a", reason: "the test holds it", at_ms: now, by: "terminal" });
    });
    db.close();
    const home = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, registry: FAKES, log: () => undefined });
    try {
      const job = () => readHome(root, (home) => home.prepare("SELECT state, lane, not_before_ms FROM jobs WHERE kind = 'import' AND key = 'apple-notes:local:device-a'").get()) as { state: string; lane: number; not_before_ms: number };
      await until("the queued import lowered to the history lane", () => job().lane === LANE.history);
      expect(job()).toEqual({ state: "queued", lane: LANE.history, not_before_ms: at });
      await askHome(testSocket(root), "resume", ["import:apple-notes:local:device-a"]);
      await until("the delivery imported", () => readHome(root, (home) => home.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(id)) === "imported");
      artifact(root, "imports-lowered", { job: job() });
    } finally {
      await home.stop();
    }
  });

  it("live imports take every helper, and today's extract waits behind them", async () => {
    const root = makeRoot("lifestream-imports-last-helper-", { sources: { "apple-notes:local:device-a": "fake-rows", "apple-notes:local:device-b": "fake-rows", "apple-notes:local:device-c": "fake-rows" }, helpers: 2 });
    roots.push(root);
    const now = Date.now();
    const home = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, registry: FAKES, log: () => undefined });
    try {
      const jobs = () => readHome(root, (db) => db.prepare("SELECT kind, key, state FROM jobs WHERE kind IN ('import', 'extract') ORDER BY kind, key").all()) as { kind: string; key: string; state: string }[];
      const note = (source: string, key: string, facts?: Record<string, string>) =>
        ship(root, { source, fetched_ms: now - 1_000, rows: [{ kind: "note", key, content: { text: key, at: now - 1_000 }, at: now - 1_000 }], ...(facts === undefined ? {} : { facts }) });
      await note("apple-notes:local:device-c", "c-1");
      await until("device-c extracted", () => jobs().some((job) => job.kind === "extract" && job.state === "done"));
      const hold = join(root, "hold");
      writeFileSync(hold, "");
      await note("apple-notes:local:device-a", "a-1", { hold });
      await note("apple-notes:local:device-b", "b-1", { hold });
      const imports = () => jobs().filter((job) => job.kind === "import").map((job) => job.state).sort();
      await until("one import running and the other queued", () => imports().join() === "done,queued,running");
      const held = jobs();
      expect(held.filter((job) => job.kind === "import").map((job) => job.state).sort()).toEqual(["done", "queued", "running"]);
      await askHome(testSocket(root), "run", ["extract", "notes"]);
      await until("the extract run while the imports hold", () => jobs().some((job) => job.kind === "extract" && job.state === "done" && jobs().some((other) => other.kind === "import" && other.state === "running")));
      const during = jobs();
      expect(during.filter((job) => job.kind === "import").map((job) => job.state).sort()).toEqual(["done", "queued", "running"]);
      rmSync(hold);
      await until("every import done", () => jobs().filter((job) => job.kind === "import").every((job) => job.state === "done"));
      artifact(root, "imports-last-helper", { held, during, after: jobs() });
    } finally {
      await home.stop();
    }
  });

  it("a live delivery waits behind a long import's queued commits although a helper is free", async () => {
    const root = makeRoot("lifestream-imports-queued-commits-", { sources: { "apple-notes:local:archive": "fake-rows", "apple-notes:local:device-a": "fake-rows" }, helpers: 3 });
    roots.push(root);
    let archiveCommits = 0;
    let atLiveBegin: number | undefined;
    const chunk = importKind.chunk!;
    const begin = importKind.begin!;
    importKind.chunk = (main, running, posted) => chunk(main, running, posted).map((slice) => running.job.key !== "apple-notes:local:archive" ? slice : {
      ...slice,
      work(tx) {
        slice.work(tx);
        archiveCommits++;
      },
    });
    importKind.begin = (main, tx, job) => {
      if (job.key === "apple-notes:local:device-a") atLiveBegin ??= archiveCommits;
      return begin(main, tx, job);
    };
    const home = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, registry: FAKES, log: () => undefined });
    const hold = join(root, "hold");
    writeFileSync(hold, "");
    try {
      await until("the start's look done", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE state <> 'done'").pluck().get()) === 0);
      for (const kind of Object.keys(KINDS).filter((each) => each !== "import")) await askHome(testSocket(root), "pause", [`kind:${kind}`, "--reason", "only imports run"]);
      const now = Date.now();
      const archive = await ship(root, { source: "apple-notes:local:archive", fetched_ms: now - 1_000, rows: [], facts: { generate: { count: 20_000, start_ms: now - 400 * DAY, step_ms: 100_000, prefix: "archive", values: 300, hold } } });
      await until("the long import landing", () => archiveCommits > 2);
      const state = (id: string) => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(id)) as string;
      const sent = Date.now();
      const live = await ship(root, { source: "apple-notes:local:device-a", fetched_ms: sent, rows: [{ kind: "note", key: "live", content: { text: "a live note", at: sent }, at: sent }] }, false);
      await ask(testSocket(root), { verb: "sealed", delivery: live });
      const atNudge = archiveCommits;
      await until("the live delivery imported", () => state(live) === "imported");
      const measured = { archive_commits_at_nudge: atNudge, archive_commits_at_live_begin: atLiveBegin, archive: state(archive), helpers: home.stats().helpers };
      artifact(root, "imports-queued-commits", measured);
      expect(measured.archive_commits_at_live_begin).toBeLessThanOrEqual(atNudge);
      expect(measured.archive).toBe("importing");
    } finally {
      importKind.chunk = chunk;
      importKind.begin = begin;
      rmSync(hold, { force: true });
      await home.stop();
    }
  });

  it("a cheap import beside an expensive one sets the expensive one's slices, which then hold the write lock far past 100 ms", async () => {
    const root = makeRoot("lifestream-imports-pace-", { sources: { "apple-notes:local:device-a": "fake-rows", "apple-notes:local:device-b": "fake-rows" }, helpers: 4 });
    roots.push(root);
    const chunks: { key: string; rows: number; slices: number }[] = [];
    const chunk = importKind.chunk!;
    importKind.chunk = (main, running, posted) => {
      const slices = chunk(main, running, posted);
      chunks.push({ key: running.job.key, rows: posted.rows.length, slices: slices.length });
      return slices;
    };
    const home = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, registry: FAKES, log: () => undefined });
    const hold = join(root, "hold");
    writeFileSync(hold, "");
    try {
      const now = Date.now();
      await ship(root, { source: "apple-notes:local:device-a", fetched_ms: now - 2_000, rows: [], facts: { generate: { count: 24_000, start_ms: now - 400 * DAY, step_ms: 60_000, prefix: "cheap", hold } } });
      await until("the cheap import landing", () => chunks.filter((each) => each.key === "apple-notes:local:device-a").length > 5);
      const expensive = await ship(root, { source: "apple-notes:local:device-b", fetched_ms: now - 1_000, rows: [], facts: { generate: { count: 4_000, start_ms: now - 400 * DAY, step_ms: 60_000, prefix: "costly", values: 3_000 } } });
      const state = (id: string) => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(id)) as string;
      await until("the expensive import done", () => state(expensive) === "imported");
      await until("the cheap import read whole", () => existsSync(`${hold}.held`));
      const pace = (key: string) => {
        const per = chunks.filter((each) => each.key === key).map((each) => each.rows / each.slices).sort((left, right) => left - right);
        return per[Math.floor(per.length / 2)]!;
      };
      const measured = { cheap_rows_per_slice: pace("apple-notes:local:device-a"), expensive_rows_per_slice: pace("apple-notes:local:device-b"), chunks };
      artifact(root, "imports-pace", measured);
      expect(chunks.findIndex((each) => each.key === "apple-notes:local:device-b")).toBeGreaterThan(chunks.findIndex((each) => each.key === "apple-notes:local:device-a"));
      expect(measured.expensive_rows_per_slice).toBeLessThan(measured.cheap_rows_per_slice);
    } finally {
      importKind.chunk = chunk;
      await home.stop();
      rmSync(hold, { force: true });
    }
  });

  it("a home started on a home.db a restore left (sealed rows, no jobs) leaves a waiting delivery unimported", async () => {
    const root = makeRoot("lifestream-imports-migrated-", { sources: { "apple-notes:local:device-a": "fake-rows", "apple-notes:local:device-b": "fake-rows" } });
    roots.push(root);
    const now = Date.now();
    const ids: string[] = [];
    for (const [source, at] of [["apple-notes:local:device-a", now - 2 * DAY], ["apple-notes:local:device-a", now - 1_000], ["apple-notes:local:device-b", now - DAY]] as const) {
      ids.push(await ship(root, { source, fetched_ms: at, rows: [{ kind: "note", key: `n-${at}`, content: { text: "migrated", at }, at }] }, false));
    }
    const db = openHome(openHomeFolder(root), "migrate");
    db.commit((tx) => {
      for (const id of ids) {
        const [lane, name] = id.split("/") as [string, string];
        const delivery = readDelivery(openHomeFolder(root), lane, name)!;
        tx.tables.deliveries.add({ id, source: lane, sealed_ms: delivery.sealed_ms, stated_ms: delivery.stated_ms, facts: delivery.facts });
      }
    });
    db.close();
    expect(readHome(root, (home) => home.prepare("SELECT count(*) FROM jobs").pluck().get())).toBe(0);
    const home = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, registry: FAKES, log: () => undefined });
    try {
      await until("every migrated delivery imported", () => readHome(root, (home) => home.prepare("SELECT count(*) FROM deliveries WHERE state = 'imported'").pluck().get()) === ids.length);
      const imported = readHome(root, (home) => home.prepare("SELECT id, source, state FROM deliveries ORDER BY id").all());
      artifact(root, "imports-migrated", imported);
    } finally {
      await home.stop();
    }
  });

  it("a source added to a lane never receives the shipments the lane delivered before it", async () => {
    const root = makeRoot("lifestream-imports-added-", { sources: { "apple-notes:local:device-a": "fake-rows" } });
    roots.push(root);
    const home = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, registry: FAKES, log: () => undefined });
    try {
      const sock = testSocket(root);
      const at = Date.now() - HOUR;
      const id = await ship(root, { source: "apple-notes:local:device-a", fetched_ms: at, rows: [{ kind: "note", key: "n1", content: { text: "before the source", at }, at }] });
      const index = async () => {
        await askHome(sock, "run", ["index-inbox", "inbox"]);
        await until("the inbox indexed", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')").pluck().get()) === 0);
      };
      await until("the shipment imported", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE state = 'imported'").pluck().get()) === 1);
      await index();
      await askHome(sock, "source", ["add", "apple-notes:local:copy", "--connector", "fake-rows", "--options", JSON.stringify({ lane: "apple-notes:local:device-a" })]);
      await index();
      await until("the shipment imported for the new source", () => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ? AND source = 'apple-notes:local:copy'").pluck().get(id)) === "imported");
      const deliveries = readHome(root, (db) => db.prepare("SELECT id, source, state FROM deliveries ORDER BY source").all());
      const heads = readHome(root, (db) => db.prepare("SELECT source, key FROM heads ORDER BY source").all());
      artifact(root, "imports-source-added", { deliveries, heads });
      expect(heads).toEqual([{ source: "apple-notes:local:copy", key: "n1" }, { source: "apple-notes:local:device-a", key: "n1" }]);
    } finally {
      await home.stop();
    }
  });

  it("a shipment its sources on imported waits in the inbox for a source turned off, or that source on again cannot import its receipt", async () => {
    const lane = "apple-notes:local:device-a";
    const COPY = "apple-notes:local:copy";
    const root = makeRoot("lifestream-imports-off-", { sources: { [lane]: "fake-rows" }, settings: { "sources.off": [COPY] } });
    roots.push(root);
    const home = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, registry: FAKES, log: () => undefined });
    try {
      const sock = testSocket(root);
      const state = (id: string, source: string) => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ? AND source = ?").pluck().get(id, source)) as string | undefined;
      await askHome(sock, "source", ["add", COPY, "--connector", "fake-rows", "--options", JSON.stringify({ lane })]);
      const at = Date.now() - HOUR;
      const id = await ship(root, { source: lane, fetched_ms: at, rows: [{ kind: "note", key: "n1", content: { text: "synthetic note", at }, at }] });
      await until("the shipment imported by the source on, and the one off fed it", () => state(id, lane) === "imported" && state(id, COPY) === "sealed");
      await askHome(sock, "sweep");
      await until("the sweep ran", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE kind = 'sweep' AND state = 'done'").pluck().get()) === 1);
      const directory = join(root, "inbox", ...id.split("/"));
      const receipt = JSON.parse(readFileSync(join(directory, "swept.json"), "utf8")) as { done: boolean; removed: string[]; kept: string[] };
      expect({ receipt, rows: existsSync(join(directory, "rows.ndjson")), copy: state(id, COPY) }).toEqual({
        receipt: expect.objectContaining({ done: true, removed: ["rows.ndjson"], kept: [] }), rows: false, copy: "sealed",
      });
      await askHome(sock, "connectors", ["on", COPY]);
      await until("the receipt imported for the source on again", () => state(id, COPY) === "imported");
      const heads = readHome(root, (db) => db.prepare("SELECT source, key FROM heads ORDER BY source").all());
      artifact(root, "imports-source-off", { receipt, heads });
      expect(heads).toEqual([{ source: COPY, key: "n1" }, { source: lane, key: "n1" }]);
    } finally {
      await home.stop();
    }
  });

  it("status counts a delivery twice when a second source is fed it, or puts its bytes in another week", async () => {
    const lane = "apple-notes:local:device-a";
    const root = makeRoot("lifestream-imports-inbox-", { sources: { [lane]: "fake-rows" } });
    roots.push(root);
    const home = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, registry: FAKES, log: () => undefined });
    try {
      const sock = testSocket(root);
      const now = Date.now();
      const ages = [1, 2, 8, 15, 22, 40];
      const ids = [];
      for (const [index, age] of ages.entries()) {
        const at = now - age * DAY;
        ids.push(await ship(root, { source: lane, fetched_ms: at, rows: Array.from({ length: index + 1 }, (_, n) => ({ kind: "note", key: `n${index}-${n}`, content: { text: "synthetic", at }, at })) }));
      }
      await until("every delivery imported", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE state = 'imported'").pluck().get()) === ages.length);
      await askHome(sock, "source", ["add", "apple-notes:local:copy", "--connector", "fake-rows", "--options", JSON.stringify({ lane })]);
      await askHome(sock, "run", ["index-inbox", "inbox"]);
      await until("the second source fed every delivery", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE source = 'apple-notes:local:copy'").pluck().get()) === ages.length);
      const bytes = ids.map((id) => readDelivery(openHomeFolder(root), lane, id.slice(lane.length + 1))!.files.reduce((sum, file) => sum + file.size, 0));
      const week = (age: number) => Math.floor((Math.floor(now / DAY) - Math.floor((now - age * DAY) / DAY)) / 7);
      const expected = [0, 0, 0, 0];
      ages.forEach((age, index) => { if (week(age) < 4) expected[week(age)]! += bytes[index]!; });
      const status = statusOf(root) as { inbox: { lanes: { lane: string; weeks: number[] }[]; since: string | null } };
      artifact(root, "imports-inbox-growth", { bytes, status: status.inbox });
      expect(status.inbox).toEqual({ lanes: [{ lane, weeks: expected }], since: null });
    } finally {
      await home.stop();
    }
  });
});

describe("the floor and the re-read", () => {
  const owned = (root: string): { home: Home | undefined } => {
    const held: { home: Home | undefined } = { home: undefined };
    onTestFinished(async () => {
      await held.home?.stop();
      removeRoot(root);
    });
    return held;
  };
  const stateOf = (root: string, id: string) => readHome(root, (db) => db.prepare("SELECT state, failures, refused, read_by, run, error FROM deliveries WHERE id = ?").get(id)) as
    { state: string; failures: number; refused: number; read_by: string | null; run: number | null; error: string | null } | undefined;

  it("a home fault taken for the content's: a blob the store lacks, a carried blob that is not its name, a delivery in transit whose own file is gone, or a disk failing under the read, or a store's has the system refuses, letting its source move on", async () => {
    const MISSING = "apple-notes:local:device-a";
    const CARRIED = "apple-notes:local:device-b";
    const TRANSIT = "apple-notes:local:device-c";
    const DISK = "apple-notes:local:device-d";
    const DENIED = "apple-notes:local:device-e";
    let now = Date.now();
    const root = makeRoot("lifestream-imports-fault-", { sources: { [MISSING]: "fake-rows", [CARRIED]: "fake-rows", [TRANSIT]: "fake-rows", [DISK]: "fake-rows", [DENIED]: "fake-rows" } });
    const at = owned(root);
    const fault = join(root, "fault");
    writeFileSync(fault, "");
    const missing = await ship(root, { source: MISSING, fetched_ms: now - MINUTE, rows: [note("m1", now - MINUTE), { fault_if: fault }] }, false);
    const named = Buffer.from("the bytes the name is of");
    inboxLane(openHomeFolder(root), CARRIED).placed(hex(named)).write(Buffer.from("other bytes under that name"));
    const carried = await ship(root, { source: CARRIED, fetched_ms: now - MINUTE, rows: [{ ...note("c1", now - MINUTE), blobs: [`sha256:${hex(named)}`] }] }, false);
    const transit = await ship(root, { source: TRANSIT, fetched_ms: now - MINUTE, rows: [note("t1", now - MINUTE)], facts: { transit: true } }, false);
    rmSync(join(root, "inbox", ...transit.split("/"), "rows.ndjson"));
    const disk = await ship(root, { source: DISK, fetched_ms: now - MINUTE, rows: [note("d1", now - MINUTE), { throw_if: fault, error: "EIO" }] }, false);
    const denied = await ship(root, { source: DENIED, fetched_ms: now - MINUTE, rows: [note("e1", now - MINUTE), { throw_if: fault, error: "EACCES" }] }, false);
    at.home = await startHome(root, { stopGraceMs: 50, lookMs: LOOK_MS, registry: FAKES, clock: () => now, log: () => undefined, tickMs: TICK_MS });
    await until("the five imports failed once", () => [missing, carried, transit, disk, denied].every((id) => (stateOf(root, id)?.failures ?? 0) >= 1));
    now += 31_000;
    await askHome(testSocket(root), "settings");
    await until("the missing blob's second failure", () => (stateOf(root, missing)?.failures ?? 0) >= 2);
    const needs = statusOf(root, { now_ms: now }).needs;
    expect(needs.find((need) => need.id === `job:import:${MISSING}`)).toMatchObject({ state: "broken", reason: "import", acts: [{ do: "skip", label: "Skip it", need: `job:import:${MISSING}` }] });
    expect([stateOf(root, missing), stateOf(root, carried), stateOf(root, transit)]).toEqual([
      expect.objectContaining({ refused: 0, read_by: null, error: expect.stringContaining("is neither in blobs/ nor carried") }),
      expect.objectContaining({ refused: 0, read_by: null, error: expect.stringContaining(`expected blob sha256:${hex(named)}`) }),
      expect.objectContaining({ refused: 0, read_by: null, error: expect.stringMatching(/is neither in blobs\/ nor at .*rows\.ndjson$/u) }),
    ]);
    expect(stateOf(root, disk)).toMatchObject({ refused: 0, read_by: null, error: expect.stringContaining("EIO") });
    expect(stateOf(root, denied)).toMatchObject({ refused: 0, read_by: null, error: expect.stringContaining("EACCES") });
    expect([missing, carried, transit, disk, denied].map((id) => (stateOf(root, id)?.failures ?? 0) >= 1 && stateOf(root, id)?.state !== "imported"))
      .toEqual([true, true, true, true, true]);
    expect(readHome(root, (db) => db.prepare("SELECT count(*) FROM heads").pluck().get())).toBe(0);
    artifact(root, "imports-home-fault", { missing: stateOf(root, missing), carried: stateOf(root, carried), transit: stateOf(root, transit), disk: stateOf(root, disk), denied: stateOf(root, denied), needs });
  });

  it("a store write the home's disk refuses taken for the content's, or the reader left open when its row cannot be kept", async () => {
    const TRANSIT = "apple-notes:local:device-c";
    const now = Date.now();
    const root = makeRoot("lifestream-imports-unwritten-", { sources: { [TRANSIT]: "fake-rows" } });
    const at = owned(root);
    const store = join(root, "blobs");
    const closed = join(root, "closed");
    const photo = Buffer.from("a synthetic photo of the export");
    const fetched_at = new Date(now - MINUTE).toISOString();
    const sealing = openSealing(openHomeFolder(root), { source: TRANSIT, name: basicInstant(fetched_at), feeder: "fake-rows", fetched_at });
    await sealing.write("rows.ndjson", (async function* () { yield Buffer.from(`${JSON.stringify({ ...note("t1", now - MINUTE), blobs: [`sha256:${hex(photo)}`] })}\n`); })());
    await sealing.write("photo.bin", (async function* () { yield photo; })());
    sealing.seal({ transit: true, closed });
    const id = `${TRANSIT}/${basicInstant(fetched_at)}`;
    mkdirSync(store, { recursive: true });
    chmodSync(store, 0o555);
    try {
      at.home = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, registry: FAKES, log: () => undefined });
      await until("the import failed once", () => (stateOf(root, id)?.failures ?? 0) >= 1);
      expect(stateOf(root, id)).toMatchObject({ refused: 0, read_by: null, error: expect.stringContaining("could not be written") });
      expect(existsSync(closed)).toBe(true);
      expect(readHome(root, (db) => db.prepare("SELECT count(*) FROM heads").pluck().get())).toBe(0);
      artifact(root, "imports-unwritten", { delivery: stateOf(root, id) });
    } finally {
      chmodSync(store, 0o755);
    }
  });

  it("a read gone quiet, or holding its thread in a loop, holding its stream; or a pause mid-read marking a refusal or landing more", async () => {
    const QUIET = "apple-notes:local:device-a";
    const LOOP = "apple-notes:local:device-c";
    const PAUSED = "apple-notes:local:device-b";
    const POSTED = "apple-notes:local:device-d";
    const root = makeRoot("lifestream-imports-quiet-", { sources: { [QUIET]: "fake-rows", [LOOP]: "fake-rows", [PAUSED]: "fake-rows", [POSTED]: "fake-rows" }, helpers: 3 });
    const at = owned(root);
    const quiet = join(root, "quiet");
    const loop = join(root, "loop");
    const hold = join(root, "hold");
    writeFileSync(quiet, "");
    writeFileSync(loop, "");
    let now = Date.now();
    const t0 = now - HOUR;
    const silent = await ship(root, { source: QUIET, fetched_ms: t0, rows: [{ quiet_while: quiet }, note("q1", t0)] }, false);
    const after = await ship(root, { source: QUIET, fetched_ms: t0 + MINUTE, rows: [note("q3", t0)] }, false);
    const looping = await ship(root, { source: LOOP, fetched_ms: t0, rows: [note("l1", t0), { hold: loop }, note("l2", t0)] }, false);
    const next = await ship(root, { source: LOOP, fetched_ms: t0 + MINUTE, rows: [note("l3", t0)] }, false);
    const posted = await ship(root, { source: POSTED, fetched_ms: t0, rows: [...Array.from({ length: 2_000 }, (_, index) => note(`d${index}`, t0)), { quiet_while: quiet }] }, false);
    at.home = await startHome(root, { lookMs: LOOK_MS, registry: FAKES, clock: () => now, log: () => undefined, quietMs: 50, stopGraceMs: 50, tickMs: TICK_MS });
    const sock = testSocket(root);
    await until("the quiet reads failed once", () => [silent, looping, posted].every((id) => stateOf(root, id)?.failures === 1));
    expect([silent, looping, posted].map((id) => [stateOf(root, id)?.state, stateOf(root, id)?.refused, stateOf(root, id)?.error])).toEqual(
      Array.from({ length: 3 }, () => ["failed", 0, "its reader gave no row for ten minutes the home ran"]));
    expect(statusOf(root, { now_ms: now }).needs.filter((need) => need.reason === "import")).toEqual([]);
    expect(readHome(root, (db) => db.prepare("SELECT count(*) FROM heads WHERE source = ?").pluck().get(POSTED))).toBe(2_000);
    now += 31_000;
    await askHome(sock, "settings");
    await until("the stopped reads ended and their next deliveries imported", () => stateOf(root, after)?.state === "imported" && stateOf(root, next)?.state === "imported" &&
      stateOf(root, posted)?.state === "imported");
    const ended = [silent, looping, posted].map((id) => readHome(root, (db) => JSON.parse(db.prepare("SELECT counts FROM runs WHERE id = ?").pluck().get(stateOf(root, id)!.run) as string)) as { new: number; refusals: unknown[] });
    const words = (read: string, landed: string) => `the read stopped after ${read} rows; ${landed} landed`;
    expect([silent, looping, posted].map((id, index) => [stateOf(root, id)?.state, stateOf(root, id)?.refused, stateOf(root, id)?.error, ended[index]!.new, ended[index]!.refusals])).toEqual([
      ["imported", 1, words("0", "0"), 0, [{ kind: "delivery", key: silent, violations: [words("0", "0")] }]],
      ["imported", 1, words("1", "0"), 0, [{ kind: "delivery", key: looping, violations: [words("1", "0")] }]],
      ["imported", 1, words("2,000", "2,000"), 2_000, [{ kind: "delivery", key: posted, violations: [words("2,000", "2,000")] }]],
    ]);
    rmSync(loop);
    const blob = Buffer.from("a synthetic blob a note wants");
    const wanted = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM wanted_blobs WHERE source = ?").pluck().get(QUIET)) as number;
    await ship(root, { source: QUIET, fetched_ms: t0 + 2 * MINUTE, rows: [{ ...note("w1", t0), blobs: [`sha256:${hex(blob)}`] }] });
    await until("the note wants its blob", () => wanted() === 1);
    const carrying = await ship(root, { source: QUIET, fetched_ms: t0 + 3 * MINUTE, rows: [{ quiet_while: quiet }], carried: { [hex(blob)]: blob } });
    await until("the carrying read failed quiet", () => stateOf(root, carrying)?.failures === 1);
    expect(wanted()).toBe(0);
    rmSync(quiet);
    await at.home.stop();
    at.home = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, registry: FAKES, log: () => undefined });
    writeFileSync(hold, "");
    const held = await ship(root, { source: PAUSED, fetched_ms: t0, rows: [...Array.from({ length: 2_500 }, (_, index) => note(`p${index}`, t0)), { hold }, note("tail", t0)] });
    const landed = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM heads WHERE source = ?").pluck().get(PAUSED)) as number;
    await until("the held read's first chunk landed", () => existsSync(`${hold}.held`) && landed() > 0);
    await askHome(sock, "pause", [`import:${PAUSED}`, "--reason", "a test"]);
    const job = () => readHome(root, (db) => db.prepare("SELECT state, progress FROM jobs WHERE kind = 'import' AND key = ?").get(PAUSED)) as { state: string; progress: string | null };
    await until("the paused import queued again", () => job().state === "queued");
    const stopped = { landed: landed(), delivery: stateOf(root, held), progress: JSON.parse(job().progress!) as { counts: { refused: number; refusals: unknown[] } } };
    expect([stopped.delivery?.state, stopped.delivery?.refused, stopped.progress.counts.refused, stopped.progress.counts.refusals]).toEqual(["importing", 0, 0, []]);
    rmSync(hold);
    await askHome(sock, "resume", [`import:${PAUSED}`]);
    await until("the paused delivery imported", () => stateOf(root, held)?.state === "imported");
    expect([landed(), stateOf(root, held)?.refused]).toEqual([2_501, 0]);
    artifact(root, "imports-quiet", { ended, stopped });
  });

  it("a read stopped, then resumed and gone quiet twice, counting what the stopped read landed as the resumed read's", async () => {
    const SOURCE = "apple-notes:local:device-a";
    const root = makeRoot("lifestream-imports-quiet-resumed-", { sources: { [SOURCE]: "fake-rows" } });
    const at = owned(root);
    const sock = testSocket(root);
    const waiting = join(root, "waiting");
    const hold = join(root, "hold");
    const quiet = join(root, "quiet");
    writeFileSync(waiting, "");
    writeFileSync(hold, "");
    writeFileSync(quiet, "");
    const t0 = Date.now() - HOUR;
    const landed = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM heads WHERE source = ?").pluck().get(SOURCE)) as number;
    const job = () => readHome(root, (db) => db.prepare("SELECT state FROM jobs WHERE kind = 'import' AND key = ?").pluck().get(SOURCE)) as string;
    at.home = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, registry: FAKES, log: () => undefined });
    const id = await ship(root, { source: SOURCE, fetched_ms: t0, rows: [...Array.from({ length: 2_000 }, (_, index) => note(`r${index}`, t0)), { quiet_while: waiting }, { hold }, { quiet_while: quiet }] });
    await until("the first read's rows landed while it waited", () => landed() === 2_000);
    rmSync(waiting);
    await until("the first read held its thread", () => existsSync(`${hold}.held`));
    await askHome(sock, "pause", [`import:${SOURCE}`, "--reason", "a test"]);
    await until("the stopped import queued again", () => job() === "queued");
    rmSync(hold);
    await at.home.stop();
    let now = Date.now();
    at.home = await startHome(root, { lookMs: LOOK_MS, registry: FAKES, clock: () => now, log: () => undefined, quietMs: 50, stopGraceMs: 50, tickMs: TICK_MS });
    await askHome(sock, "resume", [`import:${SOURCE}`]);
    await until("the resumed read failed quiet", () => stateOf(root, id)?.failures === 1);
    now += 31_000;
    await askHome(sock, "settings");
    await until("the read again ended quiet", () => stateOf(root, id)?.state === "imported");
    expect(stateOf(root, id)?.error).toBe("the read stopped after 2,000 rows; 2,000 landed");
    rmSync(quiet);
  });

  it("a reader's refusal is logged by its run number alone; the run keeps its source and reason", async () => {
    const SOURCE = "apple-notes:canary-account-a@example.com:device-a";
    const root = makeRoot("lifestream-imports-refusal-log-", { sources: { [SOURCE]: "fake-rows" } });
    const at = owned(root);
    const broken = join(root, "broken");
    writeFileSync(broken, "");
    const t0 = Date.now() - HOUR;
    const id = await ship(root, { source: SOURCE, fetched_ms: t0, rows: [note("r1", t0), { throw_if: broken, error: "Refused" }] }, false);
    const logs: string[] = [];
    at.home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: (line) => logs.push(line) });
    await until("the read refused its rest", () => stateOf(root, id)?.state === "imported");
    const run = stateOf(root, id)!.run;
    expect(readHome(root, (db) => db.prepare("SELECT subject FROM runs WHERE id = ?").pluck().get(run))).toContain(SOURCE);
    expect(stateOf(root, id)?.error).toContain("a synthetic refusal past the rows read");
    expect(logs.filter((line) => line.includes("rest-refused")).map((line) => JSON.parse(line) as Record<string, unknown>)).toEqual([{ at: expect.any(String), import: "rest-refused", run }]);
    expect(logs.filter((line) => line.includes("synthetic refusal"))).toEqual([]);
  });

  it("a re-read gone quiet failing, not refused at once", async () => {
    const SOURCE = "apple-notes:local:device-a";
    const root = makeRoot("lifestream-imports-quiet-reread-", { sources: { [SOURCE]: "fake-rows" } });
    const at = owned(root);
    const broken = join(root, "broken");
    const quiet = join(root, "quiet");
    writeFileSync(broken, "");
    writeFileSync(quiet, "");
    const t0 = Date.now() - HOUR;
    const id = await ship(root, { source: SOURCE, fetched_ms: t0, rows: [...Array.from({ length: CHUNK_ROWS }, (_, index) => note(`r${index}`, t0)), { throw_if: broken, error: "TypeError" }, { quiet_while: quiet }, note("tail", t0)] }, false);
    writeFileSync(join(root, CONNECT_CODE), "code-1");
    at.home = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined, quietMs: 50, stopGraceMs: 50 });
    await until("the first read refused its rest", () => stateOf(root, id)?.read_by === "code-1");
    await at.home.stop();
    writeFileSync(join(root, CONNECT_CODE), "code-2");
    rmSync(broken);
    at.home = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined, quietMs: 50, stopGraceMs: 50 });
    await until("the re-read ended", () => stateOf(root, id)?.read_by === "code-2");
    const chunk = CHUNK_ROWS.toLocaleString("en-US");
    expect(stateOf(root, id)).toMatchObject({ state: "imported", failures: 0, refused: 1, error: `the read stopped after ${chunk} rows; ${chunk} landed` });
    rmSync(quiet);
  });

  it("a delivery whose read goes quiet across a sleep of the machine refused at its first time, or not read again whole", async () => {
    const SOURCE = "apple-notes:local:device-a";
    const root = makeRoot("lifestream-imports-quiet-sleep-", { sources: { [SOURCE]: "fake-rows" } });
    const at = owned(root);
    const quiet = join(root, "quiet");
    writeFileSync(quiet, "");
    let now = Date.now();
    const t0 = now - HOUR;
    const id = await ship(root, { source: SOURCE, fetched_ms: t0, rows: [note("s1", t0), { quiet_while: quiet }, note("s2", t0)] }, false);
    at.home = await startHome(root, { lookMs: LOOK_MS, registry: FAKES, clock: () => now, log: () => undefined, quietMs: 50, stopGraceMs: 50, tickMs: TICK_MS });
    await until("the read began", () => stateOf(root, id)?.state === "importing");
    now += 35 * MINUTE;
    await until("the quiet read failed once", () => stateOf(root, id)?.failures === 1);
    const failed = stateOf(root, id);
    expect(failed).toMatchObject({ state: "failed", refused: 0, read_by: null, error: "its reader gave no row for ten minutes the home ran" });
    expect(statusOf(root, { now_ms: now }).needs.filter((need) => need.reason === "import")).toEqual([]);
    rmSync(quiet);
    now += 31_000;
    await askHome(testSocket(root), "settings");
    await until("the delivery imported", () => stateOf(root, id)?.state === "imported");
    const landed = readHome(root, (db) => db.prepare("SELECT count(*) FROM heads WHERE source = ?").pluck().get(SOURCE)) as number;
    expect([stateOf(root, id)?.refused, stateOf(root, id)?.error, landed]).toEqual([0, null, 2]);
    artifact(root, "imports-quiet-sleep", { failed, imported: stateOf(root, id) });
  });

  it("a Mac's delivery read twice that throws in its first read losing today's rows or the rows before the throw, or counting two refusals; one read whole that throws landing out of today-first order", async () => {
    const NOTES = "apple-notes:local:macbook-pro-0001";
    const root = makeRoot("lifestream-imports-twice-", { sources: { [NOTES]: "fake-rows" } });
    const at = owned(root);
    const { principal: mac } = mintPrincipal(openHomeFolder(root), { unit: "macbook-pro-0001", kind: "mac", scopes: ["deliver"], sources: [NOTES], now_ms: 0 });
    const { day } = effective(root).settings;
    const now = Date.now();
    const today = dayBounds(civilDay(now, day), day);
    const throwAt = ORDERED_ROWS + 5;
    const fetched_at = new Date(now).toISOString();
    const sealing = openSealing(openHomeFolder(root), { source: NOTES, name: basicInstant(fetched_at), feeder: "fake-rows", fetched_at });
    await sealing.write("rows.ndjson", (async function* () { yield Buffer.from("\n"); })());
    sealing.seal({ generate: { count: ORDERED_ROWS + 10, start_ms: today.start_ms - ORDERED_ROWS * MINUTE, step_ms: MINUTE, prefix: "big", throw_at: throwAt } } as JsonObject, undefined, { pass: mac.id, sealed_at: fetched_at });
    const id = `${NOTES}/${basicInstant(fetched_at)}`;
    const small_at = new Date(now + 1_000).toISOString();
    const small = openSealing(openHomeFolder(root), { source: NOTES, name: basicInstant(small_at), feeder: "fake-rows", fetched_at: small_at });
    await small.write("rows.ndjson", (async function* () { yield Buffer.from("\n"); })());
    small.seal({ generate: { count: 10, start_ms: today.start_ms - 5 * MINUTE, step_ms: MINUTE, prefix: "small", throw_at: 8 } } as JsonObject, undefined, { pass: mac.id, sealed_at: small_at });
    const whole = `${NOTES}/${basicInstant(small_at)}`;
    at.home = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, registry: FAKES, log: () => undefined });
    await until("both deliveries imported", () => stateOf(root, id)?.state === "imported" && stateOf(root, whole)?.state === "imported");
    const run = stateOf(root, id)!.run!;
    const first = readHome(root, (db) => db.prepare("SELECT key FROM statements WHERE run = ? ORDER BY seq LIMIT 6").pluck().all(run)) as string[];
    const stated = readHome(root, (db) => db.prepare("SELECT count(*) FROM statements WHERE run = ?").pluck().get(run)) as number;
    const counts = readHome(root, (db) => JSON.parse(db.prepare("SELECT counts FROM runs WHERE id = ?").pluck().get(run) as string)) as { refused: number; refusals: unknown[] };
    expect(first).toEqual(["big-30004", "big-30003", "big-30002", "big-30001", "big-30000", "big-0"]);
    expect([stated, stateOf(root, id)?.refused, counts.refusals]).toEqual([throwAt, 1, [{ kind: "delivery", key: id, violations: [`after 30,005 rows: TypeError: a synthetic bug at note ${throwAt}`] }]]);
    const wholeRun = stateOf(root, whole)!.run!;
    const order = readHome(root, (db) => db.prepare("SELECT key FROM statements WHERE run = ? ORDER BY seq").pluck().all(wholeRun)) as string[];
    const wholeCounts = readHome(root, (db) => JSON.parse(db.prepare("SELECT counts FROM runs WHERE id = ?").pluck().get(wholeRun) as string)) as { refusals: unknown[] };
    expect(order).toEqual(["small-7", "small-6", "small-5", "small-4", "small-3", "small-2", "small-1", "small-0"]);
    expect([stateOf(root, whole)?.refused, wholeCounts.refusals]).toEqual([1, [{ kind: "delivery", key: whole, violations: ["after 8 rows: TypeError: a synthetic bug at note 8"] }]]);
    artifact(root, "imports-twice", { first, stated, counts, order });
  });

  it("an unread delivery never read again by a new code, read again under the same one, read before what waits or on a low disk, changing its state or a head a later delivery set, winning a tie, failing its job on a home fault, or not read again now by run import", async () => {
    const R = "apple-notes:local:device-a";
    const LIVE = "apple-notes:local:device-b";
    const root = makeRoot("lifestream-imports-reread-", { sources: { [R]: "fake-rows", [LIVE]: "fake-rows" } });
    const at = owned(root);
    const sock = testSocket(root);
    const code = (name: string) => writeFileSync(join(root, CONNECT_CODE), name);
    const start = async () => {
      at.home = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, registry: FAKES, log: () => undefined });
    };
    const stop = async () => {
      await at.home?.stop();
      at.home = undefined;
    };
    const runsOf = (id: string) => readHome(root, (db) => db.prepare("SELECT id, outcome, counts FROM runs WHERE kind = 'import' AND subject = ? ORDER BY id").all(`${R} ${id}`)) as
      { id: number; outcome: string | null; counts: string | null }[];
    const job = () => readHome(root, (db) => db.prepare("SELECT state, lane FROM jobs WHERE kind = 'import' AND key = ?").get(R)) as { state: string; lane: number } | undefined;
    const head = (key: string) => readHome(root, (db) => db.prepare("SELECT json_extract(v.text, '$.content.text') FROM heads h JOIN versions v ON v.id = h.version WHERE h.source = ? AND h.key = ?").pluck().get(R, key));
    const broken = join(root, "broken");
    const still = join(root, "still");
    const hold = join(root, "reread-hold");
    const fault = join(root, "fault");
    writeFileSync(broken, "");
    writeFileSync(still, "");
    const said = (key: string, text: string, at_ms: number) => ({ kind: "note", key, content: { text, at: at_ms }, at: at_ms });
    const t0 = Date.now() - HOUR;
    const fillers = Array.from({ length: 600 }, (_, index) => said(`f${index}`, `f${index}`, t0));
    const r1 = await ship(root, { source: R, fetched_ms: t0, rows: [
      said("a1", "a1", t0), { throw_if: broken, error: "TypeError" }, said("a2", "a2 by r1", t0), said("a3", "a3", t0), said("tie", "tie by r1", t0), ...fillers, said("tie", "tie again by r1", t0),
    ] }, false);
    const r2 = await ship(root, { source: R, fetched_ms: t0 + MINUTE, rows: [said("a2", "a2 by r2", t0)] }, false);
    const r3 = await ship(root, { source: R, fetched_ms: t0 + 2 * MINUTE, rows: [said("tie", "tie by r3", t0)], facts: { snapshot_taken_at: new Date(t0).toISOString() } }, false);
    const report: Record<string, unknown> = {};

    code("code-1");
    await start();
    await until("r1, r2 and r3 imported", () => [r1, r2, r3].every((id) => stateOf(root, id)?.state === "imported"));
    const firstRun = stateOf(root, r1)!.run;
    expect(stateOf(root, r1)).toMatchObject({ refused: 1, read_by: "code-1" });
    await stop();
    await start();
    expect(job()?.state).toBe("done");
    expect(runsOf(r1)).toHaveLength(1);

    await stop();
    code("code-2");
    rmSync(broken);
    const r4 = await ship(root, { source: R, fetched_ms: Date.now() - MINUTE, rows: [said("a4", "a4", Date.now() - MINUTE)] }, false);
    await start();
    await until("r1 read by code-2", () => stateOf(root, r1)?.read_by === "code-2");
    const reread = runsOf(r1).at(-1)!;
    const r4Run = stateOf(root, r4)!.run!;
    const counts = JSON.parse(reread.counts!) as Record<string, number>;
    report.second = { reread, counts };
    expect(r4Run).toBeLessThan(reread.id);
    expect(stateOf(root, r1)).toMatchObject({ state: "imported", refused: 0, run: firstRun });
    expect([reread.outcome, counts.duplicated, counts.restated, counts.late, counts.new, counts.changed, counts.refused]).toEqual(["ok", 1, 0, 3, 601, 0, 0]);
    expect([head("a2"), head("tie"), head("a3")]).toEqual(["a2 by r2", "tie by r3", "a3"]);

    const r5 = await ship(root, { source: R, fetched_ms: Date.now() - MINUTE, rows: [said("b1", "b1", t0), { hold }, { throw_if: still, error: "Refused" }] });
    await until("r5 imported, its rest refused", () => stateOf(root, r5)?.refused === 1);
    await stop();

    code("code-3");
    const free = freeSpace(4e9);
    await start();
    const live = await ship(root, { source: LIVE, fetched_ms: Date.now() - MINUTE, rows: [said("l1", "l1", Date.now() - MINUTE)] });
    await until("the live delivery imported", () => stateOf(root, live)?.state === "imported");
    expect([job(), stateOf(root, r5)?.read_by, runsOf(r5)]).toEqual([{ state: "queued", lane: LANE.history }, "code-2", [expect.objectContaining({ outcome: "ok" })]]);
    await stop();
    free.set(6e9);

    writeFileSync(hold, "");
    await start();
    await until("r5's re-read reading, held", () => existsSync(`${hold}.held`));
    expect(job()).toEqual({ state: "running", lane: LANE.history });
    await stop();
    rmSync(hold);
    await start();
    await until("r5 read by code-3", () => stateOf(root, r5)?.read_by === "code-3");
    await until("the import done", () => job()?.state === "done");
    expect([stateOf(root, r5)?.state, stateOf(root, r5)?.refused, runsOf(r5).map((run) => run.outcome)]).toEqual(["imported", 1, ["ok", "ok"]]);

    writeFileSync(fault, "");
    const r6 = await ship(root, { source: R, fetched_ms: Date.now() - MINUTE, rows: [said("c1", "c1", t0), { fault_if: fault }] });
    await until("r6 failed once", () => stateOf(root, r6)?.failures === 1);
    await askHome(sock, "drop", ["job", "import", R]);
    expect(stateOf(root, r6)).toMatchObject({ state: "dead", read_by: "code-3" });
    expect(runsOf(r6).map((run) => run.outcome)).toEqual(["failed"]);
    await askHome(sock, "run", ["import", R]);
    await until("r6 read again", () => runsOf(r6).length === 2 && runsOf(r5).length === 3);
    await until("the import done", () => job()?.state === "done");
    expect(stateOf(root, r6)).toMatchObject({ state: "dead", refused: 0, read_by: "code-3", error: expect.stringContaining("is neither in blobs/ nor carried") });
    expect(runsOf(r6).map((run) => run.outcome)).toEqual(["failed", "failed"]);

    rmSync(fault);
    const ran = (await askHome(sock, "run", ["import", R])) as { unread: number };
    expect(ran.unread).toBe(2);
    await until("r6 read again and landed", () => head("c1") === "c1" && runsOf(r5).length === 4);
    await until("the import done", () => job()?.state === "done");
    expect([stateOf(root, r6)?.state, stateOf(root, r6)?.read_by, stateOf(root, r5)?.refused, runsOf(r6).map((run) => run.outcome)]).toEqual(["imported", "code-3", 1, ["failed", "ok"]]);

    const broken7 = join(root, "broken7");
    const hold7 = join(root, "hold7");
    writeFileSync(broken7, "");
    const r7 = await ship(root, { source: R, fetched_ms: Date.now() - MINUTE, rows: [
      { throw_if: broken7, error: "TypeError" }, said("d1", "d1", t0), ...Array.from({ length: 2_500 }, (_, index) => said(`g${index}`, `g${index}`, t0)),
      { hold: hold7 }, { kind: "note", key: "d1", content: null, gone: true },
    ] });
    await until("r7 imported, its rest refused", () => stateOf(root, r7)?.refused === 1);
    await until("the import done", () => job()?.state === "done");
    rmSync(broken7);
    writeFileSync(hold7, "");
    await askHome(sock, "run", ["import", R]);
    await until("r7's re-read held past the slice that stated d1", () => existsSync(`${hold7}.held`) && head("d1") === "d1");
    await stop();
    rmSync(hold7);
    const r8 = await ship(root, { source: R, fetched_ms: Date.now() - MINUTE, rows: [said("e1", "e1", Date.now() - MINUTE)] }, false);
    await start();
    await until("r7 read again whole", () => stateOf(root, r7)?.refused === 0);
    await until("the import done", () => job()?.state === "done");
    const d1 = readHome(root, (db) => db.prepare("SELECT version FROM heads WHERE source = ? AND key = 'd1'").pluck().get(R));
    const imported = readHome(root, (db) => db.prepare("SELECT key FROM events WHERE kind = 'import' AND key IN (?, ?) ORDER BY seq").pluck().all(r7, r8));
    expect([d1, imported.slice(-2), stateOf(root, r8)?.state, runsOf(r7).map((run) => run.outcome)]).toEqual(["gone", [r8, r7], "imported", ["ok", "ok"]]);
    report.runs = { r1: runsOf(r1), r5: runsOf(r5), r6: runsOf(r6), r7: runsOf(r7) };
    artifact(root, "imports-reread", report);
  });

  it("a delivery whose input is gone unread for ever: a re-read that finds it gone ending nothing, or one denied access ending it; a first read that finds it gone settling it", async () => {
    const DEAD = "apple-notes:local:device-a";
    const TRANSIT = "apple-notes:local:device-b";
    const DENIED = "apple-notes:local:device-c";
    const FIRST = "apple-notes:local:device-d";
    let now = Date.now();
    const root = makeRoot("lifestream-imports-gone-", { sources: { [DEAD]: "fake-rows", [TRANSIT]: "fake-rows", [DENIED]: "fake-rows", [FIRST]: "fake-rows" } });
    const at = owned(root);
    const sock = testSocket(root);
    const code = (name: string) => writeFileSync(join(root, CONNECT_CODE), name);
    const start = async () => {
      at.home = await startHome(root, { stopGraceMs: 50, lookMs: LOOK_MS, registry: FAKES, clock: () => now, log: () => undefined, tickMs: TICK_MS });
    };
    const stop = async () => {
      await at.home?.stop();
      at.home = undefined;
    };
    const runsOf = (id: string) => readHome(root, (db) => db.prepare("SELECT outcome FROM runs WHERE kind = 'import' AND subject LIKE ? ORDER BY id").pluck().all(`% ${id}`)) as string[];
    const goneEvents = () => readHome(root, (db) => db.prepare("SELECT key, json_extract(detail, '$.source') AS source FROM events WHERE kind = 'input-gone' ORDER BY key").all()) as { key: string; source: string }[];
    const unread = () => readHome(root, (db) => db.prepare("SELECT id FROM deliveries WHERE refused > 0 OR state = 'dead' ORDER BY id").pluck().all()) as string[];
    const busy = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE kind = 'import' AND key != ? AND state IN ('queued', 'running')").pluck().get(FIRST)) as number;
    const fault = join(root, "fault");
    const refuse = join(root, "refuse");
    writeFileSync(fault, "");
    writeFileSync(refuse, "");
    const dead = await ship(root, { source: DEAD, fetched_ms: now - MINUTE, rows: [note("a1", now - MINUTE), { fault_if: fault }] }, false);
    const first = await ship(root, { source: FIRST, fetched_ms: now - MINUTE, rows: [note("f1", now - MINUTE), { fault_if: fault }] }, false);
    const transit = await ship(root, { source: TRANSIT, fetched_ms: now - MINUTE, rows: [note("t1", now - MINUTE), { throw_if: refuse, error: "Refused" }], facts: { transit: true } }, false);
    const denied = await ship(root, { source: DENIED, fetched_ms: now - MINUTE, rows: [note("e1", now - MINUTE), { throw_if: refuse, error: "Refused" }], facts: { transit: true } }, false);
    const deniedAt = join(root, "inbox", ...denied.split("/"));
    onTestFinished(() => chmodSync(deniedAt, 0o755));

    code("code-1");
    await start();
    await until("DEAD and FIRST failed, TRANSIT and DENIED refused their rest", () => (stateOf(root, dead)?.failures ?? 0) >= 1 && (stateOf(root, first)?.failures ?? 0) >= 1
      && stateOf(root, transit)?.refused === 1 && stateOf(root, denied)?.refused === 1);
    await askHome(sock, "drop", ["job", "import", DEAD]);
    expect(stateOf(root, dead)).toMatchObject({ state: "dead", read_by: "code-1" });
    await stop();

    rmSync(join(root, "inbox", ...dead.split("/")), { recursive: true });
    rmSync(join(root, "inbox", ...first.split("/")), { recursive: true });
    rmSync(join(root, "inbox", ...transit.split("/"), "rows.ndjson"));
    chmodSync(deniedAt, 0o000);
    code("code-2");
    await start();
    now += 31_000;
    await askHome(sock, "settings");
    await until("DEAD and TRANSIT re-read, DENIED's re-read failed, FIRST failed again", () => stateOf(root, dead)?.state === "superseded" && stateOf(root, transit)?.refused === 0
      && stateOf(root, denied)?.read_by === "code-2" && (stateOf(root, first)?.failures ?? 0) >= 2);
    await until("the re-reads done", () => busy() === 0);
    expect(stateOf(root, dead)).toMatchObject({ state: "superseded", refused: 0, error: expect.stringContaining("is not sealed in the inbox") });
    expect(stateOf(root, transit)).toMatchObject({ state: "imported", refused: 0, read_by: "code-2", error: expect.stringMatching(/is neither in blobs\/ nor at .*rows\.ndjson$/u) });
    expect([runsOf(dead).at(-1), runsOf(transit)]).toEqual(["failed", ["ok", "failed"]]);
    expect(goneEvents()).toEqual([{ key: dead, source: DEAD }, { key: transit, source: TRANSIT }].sort((a, b) => a.key.localeCompare(b.key)));
    expect(stateOf(root, denied)).toMatchObject({ state: "imported", refused: 1, read_by: "code-2", error: expect.stringContaining("EACCES") });
    expect(runsOf(denied)).toEqual(["ok", "failed"]);
    expect(stateOf(root, first)).toMatchObject({ state: "failed", refused: 0, read_by: null, error: expect.stringContaining("is not sealed in the inbox") });
    expect(readHome(root, (db) => db.prepare("SELECT read_through_ms FROM sources WHERE id = ?").pluck().get(FIRST))).toBeNull();
    expect(unread()).toEqual([denied]);
    const notices = JSON.stringify(statusOf(root, { now_ms: now }));
    expect([DEAD, TRANSIT, DENIED].map((source) => new RegExp(`${source}: [^"]*could not read`, "u").test(notices))).toEqual([false, false, true]);
    await stop();

    chmodSync(deniedAt, 0o755);
    rmSync(refuse);
    code("code-3");
    await start();
    await until("DENIED read by code-3", () => stateOf(root, denied)?.read_by === "code-3");
    await until("the re-reads done", () => busy() === 0);
    expect(stateOf(root, denied)).toMatchObject({ state: "imported", refused: 0, error: null });
    expect([runsOf(dead).length, runsOf(transit).length, goneEvents().length, unread()]).toEqual([2, 2, 2, []]);
    artifact(root, "imports-input-gone", { dead: stateOf(root, dead), transit: stateOf(root, transit), denied: stateOf(root, denied), first: stateOf(root, first), gone: goneEvents() });
  });

  it("a HealthKit deletion of a sample the home lacks lost or refused, that sample landing live from a bundle stating earlier, or a re-read leaving a delivery's own deletion behind its sample", async () => {
    const ACCOUNT = "person-a@example.com";
    const HEALTH = `apple-health:${ACCOUNT}:cloud`;
    const HEART = "HKQuantityTypeIdentifierHeartRate";
    const [X, Y, Z] = ["30000000-0000-4000-8000-000000000001", "30000000-0000-4000-8000-000000000002", "30000000-0000-4000-8000-000000000003"];
    const AT = "2026-08-31T04:00:00.875Z";
    const sampleLine = (sequence: number, uuid: string, quantity = `${70 + Number(uuid.slice(-1))} count/min`) => ({
      domain: "health", kind: "sample", sequence, captured: { wall_rfc3339: "2026-08-31T10:00:00.125+05:30" },
      payload: {
        uuid: uuid.toUpperCase(), sample_type: HEART, start_date_rfc3339: AT, start_date_unix_seconds: Date.parse(AT) / 1000,
        end_date_rfc3339: AT, end_date_unix_seconds: Date.parse(AT) / 1000, source_revision: { source_name: "Synthetic Health Source", version: "9.1" },
        device: null, metadata: {}, quantity_description: quantity,
      },
    });
    const deletionLine = (sequence: number, uuid: string) => ({
      domain: "health", kind: "deleted_sample", sequence, captured: { wall_rfc3339: "2026-08-31T10:00:00.250+05:30" },
      payload: { uuid, sample_type: HEART, deletion_reported_at: "2026-08-31T10:00:00.250+05:30" },
    });
    const root = makeRoot("lifestream-imports-health-", { sources: {} });
    const at = owned(root);
    const sock = testSocket(root);
    writeFileSync(join(root, CONNECT_CODE), "code-1");
    const door = await doorHere(root);
    at.home = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, registry: FAKES, log: () => undefined });
    const pass = randomBytes(32).toString("base64url");
    const { code } = (await askHome(sock, "pair", [])) as { code: string };
    const paired = await fetch(`${door.url}/v1/pair`, {
      method: "POST", headers: { ...DEVICE.phone, "content-type": "application/json" },
      body: JSON.stringify({ code, pass, kind: "phone", model: "iPhone 17 Pro", account: ACCOUNT, new: true }),
    });
    const unit = ((await paired.json()) as { unit: string }).unit;
    let seal = 0;
    const shipHealth = async (second: number, lines: { sequence: number }[]): Promise<string> => {
      const bundle = phoneBundle({ entries: { "health.jsonl": lines }, custody: { [HEALTH]: { seal: ++seal } }, second });
      const put = await fetch(`${door.url}/v1/bundles/${bundle.id}`, { method: "PUT", headers: { authorization: `Bearer ${pass}`, ...DEVICE.phone }, body: bundle.bytes });
      expect(put.status).toBe(201);
      return `phone:${unit}/${bundle.id}`;
    };
    const delivery = (id: string) => readHome(root, (db) => db.prepare("SELECT state, refused, read_by FROM deliveries WHERE id = ? AND source = ?").get(id, HEALTH)) as
      { state: string; refused: number; read_by: string | null } | undefined;
    const runs = (id: string) => (readHome(root, (db) => db.prepare("SELECT counts FROM runs WHERE kind = 'import' AND subject = ? AND counts IS NOT NULL ORDER BY id").pluck().all(`${HEALTH} ${id}`)) as string[])
      .map((counts) => JSON.parse(counts) as Record<string, number>);
    const heads = () => readHome(root, (db) => db.prepare("SELECT kind, version = 'gone' AS gone FROM heads WHERE source = ? ORDER BY kind, key").all(HEALTH)) as { kind: string; gone: number }[];
    const report: Record<string, unknown> = {};

    const deletes = await shipHealth(30, [deletionLine(1, X)]);
    await until("the deletion imported", () => delivery(deletes)?.state === "imported");
    expect([delivery(deletes)?.refused, runs(deletes)[0]?.gone, heads()]).toEqual([0, 1, [{ kind: "sample-uuid", gone: 1 }]]);
    const brings = await shipHealth(10, [sampleLine(1, X)]);
    await until("the sample imported", () => delivery(brings)?.state === "imported");
    expect([delivery(brings)?.refused, runs(brings)[0]]).toEqual([0, expect.objectContaining({ duplicated: 1, restated: 1, gone: 1, late: 0, new: 0 })]);
    expect(heads()).toEqual([{ kind: "sample", gone: 1 }, { kind: "sample-uuid", gone: 1 }]);
    report.lost = { deletes: runs(deletes), brings: runs(brings) };

    const both = await shipHealth(40, [sampleLine(1, Y), deletionLine(2, Y), sampleLine(3, Z, "seventy count/min")]);
    await until("the bundle imported", () => delivery(both)?.state === "imported");
    expect(delivery(both)).toEqual({ state: "imported", refused: 1, read_by: "code-1" });
    expect(heads().filter((head) => head.gone === 0)).toEqual([]);
    await at.home!.stop();
    writeFileSync(join(root, CONNECT_CODE), "code-2");
    at.home = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, registry: FAKES, log: () => undefined });
    await until("the bundle read again by code-2", () => delivery(both)?.read_by === "code-2");
    const [, again] = runs(both);
    expect([delivery(both), again]).toEqual([{ state: "imported", refused: 1, read_by: "code-2" }, expect.objectContaining({ duplicated: 3, late: 0, replayed: 0, refused: 1 })]);
    expect([heads().length, heads().filter((head) => head.gone === 0)]).toEqual([4, []]);
    expect([delivery(deletes)?.read_by, delivery(brings)?.read_by]).toEqual(["code-1", "code-1"]);
    report.tie = { first: runs(both)[0], again };
    artifact(root, "imports-health", report);
  });
});

describe("live imports beside walks", () => {
  it.each([3, 4])("a live delivery waits on %i helpers until a walk of its family's records publishes", async (helpers) => {
    const LIVE = "apple-notes:local:device-a";
    const ARCHIVE = "apple-notes:local:archive";
    const SCREEN = "screen:local:mac-0001";
    const root = makeRoot(`lifestream-imports-walks-${helpers}-`, { sources: { [LIVE]: "fake-rows", [ARCHIVE]: "fake-rows", [SCREEN]: "fake-rows" }, helpers });
    onTestFinished(() => removeRoot(root));
    const before = process.env.LIFESTREAM_TEST_WALK_MS;
    process.env.LIFESTREAM_TEST_WALK_MS = "0";
    onTestFinished(() => {
      if (before === undefined) delete process.env.LIFESTREAM_TEST_WALK_MS;
      else process.env.LIFESTREAM_TEST_WALK_MS = before;
    });
    const home = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, registry: FAKES, log: () => undefined });
    const gates = {
      notes: join(root, "notes-gate"), screen: join(root, "screen-gate"), notes2: join(root, "notes-gate-2"), screen2: join(root, "screen-gate-2"),
      history: join(root, "history-gate"), live: join(root, "live-gate"),
    };
    onTestFinished(async () => {
      for (const gate of Object.values(gates)) rmSync(gate, { force: true });
      await home.stop();
    });
    const sock = testSocket(root);
    const idle = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')").pluck().get()) === 0;
    const owed = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM cursors WHERE name IN ('rebuild:notes', 'rebuild:screen', 'rebuild:labels') AND seq > 0").pluck().get()) as number;
    const job = () => readHome(root, (db) => db.prepare("SELECT state, lane FROM jobs WHERE kind = 'import' AND key = ?").get(LIVE)) as { state: string; lane: number } | undefined;
    const weeks = Array.from({ length: 8 }, (_, week) => Date.now() - 60 * DAY + week * 7 * DAY);
    await ship(root, { source: LIVE, fetched_ms: Date.now() - 3 * HOUR, rows: weeks.map((at, week) => ({ kind: "note", key: `w${week}`, content: { text: `week ${week}`, at, ...(week === 0 ? { hold: gates.notes } : week === 1 ? { hold: gates.notes2 } : {}) }, at })) });
    await ship(root, { source: SCREEN, fetched_ms: Date.now() - 3 * HOUR, rows: weeks.map((at, week) => ({ kind: "frame", key: `f${week}`, content: { at, ...(week === 0 ? { hold: gates.screen } : week === 1 ? { hold: gates.screen2 } : {}) }, at })) });
    await until("both families extracted", idle);
    for (const gate of [gates.notes, gates.screen, gates.notes2, gates.screen2]) writeFileSync(gate, "");
    await askHome(sock, "pause", ["walk:labels", "--reason", "a test"]);
    for (const family of ["notes", "screen", "labels"]) await askHome(sock, "rebuild", ["extracts", "--family", family]);
    await until("both walks held", () => existsSync(`${gates.notes}.held`) && existsSync(`${gates.screen}.held`));
    if (helpers === 4) {
      writeFileSync(gates.history, "");
      await ship(root, { source: ARCHIVE, fetched_ms: Date.now() - DAY, rows: [{ hold: gates.history }], facts: { history: true } });
      await until("the history import held", () => existsSync(`${gates.history}.held`));
    }
    writeFileSync(gates.live, "");
    const live = await ship(root, { source: LIVE, fetched_ms: Date.now(), rows: [{ kind: "note", key: "live", content: { text: "live", at: Date.now() }, at: Date.now() }, { hold: gates.live }] });
    await until("the live import queued", () => job()?.state === "queued");
    expect([job()?.lane, owed()]).toEqual([LANE.live, 3]);
    rmSync(gates.notes);
    rmSync(gates.screen);
    await until("the live import reading", () => existsSync(`${gates.live}.held`));
    const state = readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(live));
    expect([state, owed()]).toEqual(["importing", 3]);
    artifact(root, `imports-beside-walks-${helpers}`, { state, owed: owed(), helpers: home.stats().helpers });
  });
});

describe("a labeler's begin waits on every row of its newest shipment", () => {
  const OWN = "google-places:macbook-pro-0001:nearby";
  const LOOKUP = "google-maps:person-a@example.com:lookup";
  const now = Date.UTC(2026, 9, 6, 12);
  let root: string;
  afterAll(() => removeRoot(root));

  it("a names shipment's lookup row waiting or failing: begin answers null; every row settled: it runs, and its own row waiting holds it as before", () => {
    root = makeRoot("lifestream-label-begin-", { sources: {} });
    const db = openHome(openHomeFolder(root), "migrate");
    const labeler: Labeler = { name: "google-places", source: OWN, inputs: [], label: async () => null };
    const main = { folder: openHomeFolder(root), settings: effective(root).settings, registry: { connectors: [], readers: [], families: [], labelers: [labeler], code: "test" }, now: () => now } as unknown as Main;
    const job = { kind: "label", key: "google-places" } as JobRow;
    const begins = (work: (tx: Tx) => void = () => undefined): boolean => db.commit((tx) => {
      work(tx);
      return labelKind.begin!(main, tx, job) !== null;
    });
    const step = (tx: Tx, id: string, source: string, ...moves: ("begin" | "land" | "fail")[]) => {
      const run = tx.tables.runs.start({ kind: "import", subject: source, started_ms: now });
      for (const move of moves) {
        tx.tables.deliveries.move(id, source, move === "begin" ? { move, run } : move === "land" ? { move, run, refused: 0, error: null, code: "test" } : { move, error: "a synthetic failure" });
      }
    };
    const seen: Record<string, boolean> = {};
    try {
      seen["no delivery"] = begins();
      const id = `${OWN}/20261006T120000Z`;
      seen["both rows sealed"] = begins((tx) => {
        for (const source of [OWN, LOOKUP]) tx.tables.deliveries.add({ id, source, sealed_ms: now, stated_ms: now, facts: {} });
      });
      seen["own landed, lookup sealed"] = begins((tx) => step(tx, id, OWN, "begin", "land"));
      seen["lookup failing"] = begins((tx) => step(tx, id, LOOKUP, "begin", "fail"));
      seen["lookup failed twice"] = begins((tx) => step(tx, id, LOOKUP, "begin", "fail"));
      seen["lookup imported at a retry"] = begins((tx) => step(tx, id, LOOKUP, "begin", "land"));
      seen["another lookup delivery waiting"] = begins((tx) => tx.tables.deliveries.add({ id: `${LOOKUP}/other-1`, source: LOOKUP, sealed_ms: now, stated_ms: now, facts: {} }));
      seen["its own next delivery sealed"] = begins((tx) => tx.tables.deliveries.add({ id: `${OWN}/20261006T130000Z`, source: OWN, sealed_ms: now, stated_ms: now, facts: {} }));
      expect(seen).toEqual({
        "no delivery": true, "both rows sealed": false, "own landed, lookup sealed": false, "lookup failing": false, "lookup failed twice": false,
        "lookup imported at a retry": true, "another lookup delivery waiting": true, "its own next delivery sealed": false,
      });
      artifact(root, "label-begin", seen);
    } finally {
      db.close();
    }
  });
});

describe("the inbox look clearing what a killed run left", () => {
  it("a killed poll's directory kept for ever, or the look removing a running poll's, a later run's, a device lane's, a lane a pass delivers to or a sealed delivery", async () => {
    const DEVICE_LANE = "apple-notes:local:device-a";
    const hold = join(tmpdir(), `lifestream-leftovers-hold-${process.pid}`);
    writeFileSync(hold, "");
    const root = makeRoot("lifestream-imports-leftovers-", {
      sources: { [POLLED]: "fake-rows", [DEVICE_LANE]: "fake-rows" },
      settings: { "connectors.fake-poll": { refresh: "1h", hold } },
    });
    const lines: Record<string, unknown>[] = [];
    let home: Home | undefined;
    onTestFinished(async () => {
      await home?.stop();
      rmSync(hold, { force: true });
      rmSync(`${hold}.held`, { force: true });
      removeRoot(root);
    });
    const inbox = join(root, "inbox");
    const sock = testSocket(root);
    const now = Date.now();
    const unsealed = async (lane: string, at_ms: number, feeder = "fake-poll"): Promise<string> => {
      const fetched_at = new Date(at_ms).toISOString();
      const sealing = openSealing(openHomeFolder(dirname(inbox)), { source: lane, name: basicInstant(fetched_at), feeder, fetched_at });
      await sealing.write("rows.ndjson", (async function* () { yield Buffer.from(`${JSON.stringify(note("left", at_ms))}\n`); })());
      return `${lane}/${basicInstant(fetched_at)}`;
    };
    const there = (id: string) => existsSync(join(inbox, ...id.split("/")));
    const leftoverLines = () => lines.filter((line) => line.inbox === "leftovers").map(({ at: _at, ...line }) => line);
    const looks = () => readHome(root, (db) => db.prepare("SELECT ended_ms FROM jobs WHERE kind = 'index-inbox'").pluck().get()) as number | null;
    const look = async () => {
      const before = looks();
      await askHome(sock, "run", ["index-inbox", "inbox"]);
      await until("the look ran", () => readHome(root, (db) => db.prepare("SELECT state FROM jobs WHERE kind = 'index-inbox'").pluck().get()) === "done" && looks() !== before);
    };

    const killed = await unsealed(POLLED, now - HOUR);
    const later = await unsealed(POLLED, now + HOUR);
    const device = await unsealed(DEVICE_LANE, now - HOUR, "fake-rows");
    const sealed = await ship(root, { source: POLLED, fetched_ms: now - 2 * HOUR, rows: [note("kept", now - 2 * HOUR)] }, false);
    home = await startHome(root, { stopGraceMs: 50, lookMs: LOOK_MS, registry: FAKES, log: (line) => lines.push(JSON.parse(line) as Record<string, unknown>), tickMs: TICK_MS });
    await until("the start's look removed the leftover", () => leftoverLines().length === 1);
    expect(leftoverLines()).toEqual([{ inbox: "leftovers", removed: 1, ids: [killed] }]);
    expect([there(killed), there(later), there(device), there(sealed)]).toEqual([false, true, true, true]);
    await until("the sealed delivery indexed", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE id = ?").pluck().get(sealed)) === 1);

    await askHome(sock, "run", ["poll", "fake-poll"]);
    await until("fake-poll holds mid-fetch", () => existsSync(`${hold}.held`));
    const running = await unsealed(POLLED, now - HOUR / 2);
    await look();
    expect([there(running), leftoverLines().length]).toEqual([true, 1]);
    rmSync(hold);
    await until("the poll done", () => readHome(root, (db) => db.prepare("SELECT state FROM jobs WHERE kind = 'poll' AND key = 'fake-poll'").pluck().get()) === "done");
    await look();
    expect(leftoverLines().at(-1)).toEqual({ inbox: "leftovers", removed: 1, ids: [running] });
    expect([there(running), there(later), there(device), there(sealed)]).toEqual([false, true, true, true]);
    const unsealedLeft = readdirSync(join(inbox, POLLED)).filter((name) => name !== "blobs" && !existsSync(join(inbox, POLLED, name, "manifest.json")));
    expect(unsealedLeft.map((name) => `${POLLED}/${name}`)).toEqual([later]);

    mintPrincipal(openHomeFolder(root), { unit: "macbook-pro-0001", kind: "mac", scopes: ["deliver"], sources: [POLLED], now_ms: 0 });
    const shared = await unsealed(POLLED, now - HOUR / 4);
    await look();
    expect([there(shared), leftoverLines().length]).toEqual([true, 2]);
    artifact(root, "imports-leftovers", { lines: leftoverLines(), left: unsealedLeft });
  });
});

describe("the inbox look's first commit", () => {
  it("clearing leftovers while a stopped helper is still alive, which may still write or seal its run's directory", () => {
    const tx = { tables: { jobs: { open: () => [] }, sources: { list: () => [] } } } as unknown as Tx;
    const begun = (ending: number) => indexKind.begin!({ registry: { acquirers: [], labelers: [] }, now: () => 0, ending } as unknown as Main, tx, {} as JobRow)!;
    expect([begun(0).data.clear, begun(1).data.clear]).toEqual([true, false]);
  });
});

describe("a Mac's delivery today first, in bounded memory", () => {
  const today = { start_ms: Date.UTC(2026, 10, 13), end_ms: Date.UTC(2026, 10, 14) };
  const row = (key: string, start_ms: number, text = key): ReaderOutput => ({ kind: "note", key, content: { text }, time: { start_ms } } as unknown as ReaderOutput);
  const TODAY = today.start_ms + HOUR;
  const PAST = today.start_ms - DAY;
  const reads = (rows: readonly ReaderOutput[]) => {
    const seen = { begun: 0, open: 0, most: 0 };
    const read = async function* (): AsyncGenerator<ReaderOutput> {
      seen.begun++;
      seen.most = Math.max(seen.most, ++seen.open);
      try {
        for (const each of rows) yield { ...each };
      } finally {
        seen.open--;
      }
    };
    return { read, seen };
  };
  const recordOf = (each: ReaderOutput) => `${each.kind}\u0000${each.key}`;
  const land = async (rows: readonly ReaderOutput[], caps: { rows: number; bytes: number }) => {
    const { read, seen } = reads(rows);
    const fell: { rows: number; bytes: number }[] = [];
    const chunks: { keys: string[]; newest_first: boolean }[] = [];
    const heads = new Map<string, unknown>();
    for await (const chunk of todayFirst(read, today, caps, (counted) => fell.push(counted))) {
      chunks.push({ keys: chunk.rows.map((each) => each.key), newest_first: chunk.newest_first });
      for (const each of chunk.rows) heads.set(recordOf(each), each.content);
    }
    const expected = new Map<string, unknown>();
    for (const each of rows) expected.set(recordOf(each), each.content);
    return { chunks, fell, seen, heads: [...heads].sort(), expected: [...expected].sort() };
  };
  const big = "x".repeat(200);

  it("a delivery under both caps not landing today first; one under the row cap and past the byte cap held whole", async () => {
    const under = await land([row("p1", PAST), row("t1", TODAY), row("p2", PAST + MINUTE), row("t1", TODAY + MINUTE, "t1 again")], { rows: 10, bytes: 10_000 });
    expect(under).toMatchObject({ chunks: [{ keys: ["t1", "t1", "p2", "p1"], newest_first: true }], fell: [], seen: { begun: 1, most: 1 } });
    expect(under.heads).toEqual(under.expected);
    const rows = [row("p1", PAST, big), row("t1", TODAY, big), row("p2", PAST, big), row("t1", TODAY + MINUTE, `${big} again`), row("t2", TODAY, big)];
    const heavy = await land(rows, { rows: 10, bytes: 600 });
    expect(heavy.chunks).toEqual([{ keys: ["p1", "t1", "p2", "t1", "t2"], newest_first: false }]);
    expect([heavy.fell.length, heavy.fell[0]!.rows, heavy.fell[0]!.bytes > 600, heavy.seen]).toEqual([1, 3, true, { begun: 2, open: 0, most: 1 }]);
    expect(heavy.heads).toEqual(heavy.expected);
  });

  it("past the row cap and under the byte cap not read twice, today's last rows first; records leaving today, or today's rows past the byte cap, held without bound", async () => {
    const rows = [row("p1", PAST), row("t1", TODAY), row("t2", TODAY + MINUTE), row("x1", TODAY), row("p2", PAST), row("x1", PAST, "x1 left today"),
      row("p3", PAST), row("t1", TODAY + 2 * MINUTE, "t1 again"), row("p4", PAST), row("p5", PAST), row("p6", PAST), row("p7", PAST)];
    const twice = await land(rows, { rows: 4, bytes: 10_000 });
    expect(twice.chunks).toEqual([
      { keys: ["t1", "t2"], newest_first: false },
      { keys: ["p1", "x1", "p2", "x1", "p3", "p4", "p5", "p6", "p7"], newest_first: false },
    ]);
    expect([twice.fell, twice.seen.begun]).toEqual([[], 2]);
    expect(twice.heads).toEqual(twice.expected);
    const leaving = Array.from({ length: 6 }, (_, index) => [row(`r${index}`, TODAY), row(`r${index}`, PAST, `r${index} left`)]).flat();
    const nulls = await land(leaving, { rows: 4, bytes: 10_000 });
    expect([nulls.fell.length, nulls.chunks.every((chunk) => !chunk.newest_first), nulls.chunks.flatMap((chunk) => chunk.keys), nulls.seen]).toEqual([1, true, leaving.map((each) => each.key), { begun: 2, open: 0, most: 1 }]);
    expect(nulls.heads).toEqual(nulls.expected);
    const heavy = [...Array.from({ length: 4 }, (_, index) => row(`h${index}`, TODAY + index, big)), row("h0", TODAY + 9, `${big}${big}`)];
    const bytes = await land(heavy, { rows: 4, bytes: 1_200 });
    expect([bytes.fell.length, bytes.chunks.flatMap((chunk) => chunk.keys), bytes.seen.most]).toEqual([1, heavy.map((each) => each.key), 1]);
    expect(bytes.heads).toEqual(bytes.expected);
  });
});

describe("the rows a read sends to land", () => {
  const row = (key: string): ReaderOutput => ({ kind: "note", key, content: { text: key } } as unknown as ReaderOutput);
  const keysOf = (next: IteratorResult<{ rows: readonly ReaderOutput[] }>) => (next.done === true ? null : next.value.rows.map((each) => each.key));

  it("a row read is sent while its reader waits for the next one, and the rest when it ends", async () => {
    let release = (): void => undefined;
    const waited = new Promise<void>((resolve) => { release = resolve; });
    const read = async function* (): AsyncGenerator<ReaderOutput> {
      yield row("r1");
      await waited;
      yield row("r2");
      yield row("r3");
    };
    const chunks = streamed(read());
    expect(keysOf(await chunks.next())).toEqual(["r1"]);
    release();
    const rest: string[] = [];
    for await (const chunk of chunks) rest.push(...chunk.rows.map((each) => each.key));
    expect(rest).toEqual(["r2", "r3"]);
  });
});
