import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openHome, openHomeFolder, type HomeDb, type JobRow, type Tx } from "@lifestreamprotocol/core";
import { openLedger } from "@lifestreamprotocol/model";
import { readDays, rebuildCursor } from "./derive.js";
import { Due } from "./due.js";
import { takeCommit } from "./home.js";
import { CHUNK_ROWS, sliceTarget } from "./import.js";
import { heldBy, LANE, nextRun, servedLane, type Running } from "./jobs.js";
import { helpersFor } from "./machine.js";
import { effective } from "./settings.js";
import { notesFamily } from "./test/fakes.js";
import { artifact, makeRoot, readHome, removeRoot } from "./test/harness-root.js";

const MINUTE = 60_000;
const SOURCE = "apple-notes:local:device-a";

const taken = (id: number, kind: string, key: string, lane: number): JobRow => ({
  id, kind, key, connector: null, lane, state: "running", not_before_ms: 0, attempts: 0, requeue: false, progress: null, created_ms: 0, started_ms: 0, ended_ms: null, error: null,
});

describe("helpers", () => {
  it("are at least three, at most four, else the cores less two (F1)", () => {
    expect([1, 2, 4, 5, 6, 8, 16].map(helpersFor)).toEqual([3, 3, 3, 3, 4, 4, 4]);
  });
});

describe("the writer's next commit", () => {
  const of = (name: string, job: number) => ({ name, job });

  it("serves a running job's commits at the most urgent lane of any work waiting on it, in their order (F2)", () => {
    const extract: Running = { job: taken(1, "extract", "notes", LANE.backfill), state: undefined };
    const history: Running = { job: taken(2, "import", "apple-notes:local:archive", LANE.history), state: undefined };
    const poll: Running = { job: taken(3, "poll", "fake-poll", LANE.polls), state: undefined };
    const running = new Map([[1, extract], [2, history], [3, poll]]);
    const queue = [of("history-1", 2), of("poll-1", 3), of("extract-1", 1), of("extract-2", 1)];
    expect(servedLane(extract)).toBe(LANE.backfill);
    extract.due = LANE.live;
    const order: string[] = [];
    for (let item = takeCommit(queue, (job) => running.get(job)); item !== undefined; item = takeCommit(queue, (job) => running.get(job))) order.push(item.name);
    expect(order).toEqual(["extract-1", "extract-2", "poll-1", "history-1"]);
    expect(extract.job.lane).toBe(LANE.backfill);
  });

  it("drops every commit of a job no longer running before it compares lanes, and takes the next (F6)", () => {
    const running = new Map<number, Running>([[2, { job: taken(2, "render", "days", LANE.backfill), state: undefined }], [3, { job: taken(3, "poll", "fake-poll", LANE.polls), state: undefined }]]);
    const queue = [of("gone-1", 1), of("poll-1", 3), of("gone-2", 1), of("render-1", 2)];
    expect(takeCommit(queue, (job) => running.get(job))?.name).toBe("poll-1");
    expect(queue.map((item) => item.name)).toEqual(["render-1"]);
    expect(takeCommit(queue, (job) => running.get(job))?.name).toBe("render-1");
    expect(takeCommit(queue, (job) => running.get(job))).toBeUndefined();
  });
});

describe("an import's slice target", () => {
  it("never passes the rows a chunk holds, however cheap its rows (F7)", () => {
    let target = 500;
    for (let slice = 0; slice < 50; slice++) target = sliceTarget(target, 0.000_1);
    expect(target).toBe(CHUNK_ROWS);
    for (let slice = 0; slice < 50; slice++) target = sliceTarget(target, 1_000);
    expect(target).toBe(50);
  });
});

describe("a running job made due", () => {
  let root: string;
  let db: HomeDb;
  let due: Due;
  const now = Date.UTC(2026, 9, 6, 12);
  const families = [notesFamily()];
  const running = new Map<number, Running>();
  const seen: Record<string, unknown> = {};
  let delivery = 0;

  const commit = <T>(work: (tx: Tx) => T): T => db.commit((tx) => {
    const done = work(tx);
    due.after(tx);
    return done;
  });
  const land = (stated_ms: number) => commit((tx) => {
    const run = tx.tables.runs.start({ kind: "import", subject: SOURCE, started_ms: now });
    delivery++;
    tx.records.land(run, { id: `${SOURCE}/d${delivery}`, source: SOURCE, stated_ms }, [{ kind: "note", key: `n${delivery}`, content: { text: "a note", at: stated_ms }, time: { start_ms: stated_ms, precision: "ms" } }],
      { note: () => [] }, { has: () => false });
  });
  const take = (kind: string, key: string, lane: number): Running => {
    const job = db.commit((tx) => {
      for (const each of tx.tables.jobs.open()) tx.tables.jobs.delete(each.id);
      tx.tables.jobs.enqueue({ kind, key, lane, not_before_ms: now, now_ms: now });
      return tx.tables.jobs.take(now, [lane])!;
    });
    const run: Running = { job, state: undefined };
    running.set(job.id, run);
    return run;
  };
  const finish = (run: Running) => db.commit((tx) => {
    running.delete(run.job.id);
    tx.tables.jobs.finish(run.job.id, now);
    const next = nextRun(run);
    if (next !== null) tx.tables.jobs.enqueue({ kind: run.job.kind, key: run.job.key, lane: next.lane, not_before_ms: next.at_ms ?? now, now_ms: now });
  });
  const row = (kind: string, key: string) => readHome(root, (home) => home.prepare("SELECT state, lane, not_before_ms, requeue FROM jobs WHERE kind = ? AND key = ?").get(kind, key)) as
    { state: string; lane: number; not_before_ms: number; requeue: number };

  beforeAll(() => {
    root = makeRoot("lifestream-scheduling-", { sources: { [SOURCE]: "fake-rows" } });
    db = openHome(openHomeFolder(root), "migrate");
    openLedger(openHomeFolder(root), { mode: "migrate" }).close();
    due = new Due({
      folder: openHomeFolder(root), settings: effective(root).settings, registry: { connectors: [], readers: [], families, code: "test" },
      families: new Map(families.map((family) => [family.name, family])), now: () => now, running: (job) => running.get(job),
    });
    db.commit((tx) => due.start(tx, readDays(openHomeFolder(root))));
    db.commit((tx) => {
      for (const family of families) tx.tables.cursors.move(rebuildCursor(family.name), { seq: 0, at_ms: now });
    });
  });

  afterAll(() => {
    artifact(root, "scheduling", seen);
    due.close();
    db.close();
    removeRoot(root);
  });

  it("a job a running walk holds is taken while the walk runs, or never once it ends", () => {
    const walk = take("walk", "notes", LANE.live);
    walk.holds = ["extract:notes"];
    db.commit((tx) => {
      tx.tables.jobs.enqueue({ kind: "extract", key: "notes", lane: LANE.live, not_before_ms: now - 1, now_ms: now });
      tx.tables.jobs.enqueue({ kind: "render", key: "days", lane: LANE.live, not_before_ms: now, now_ms: now });
    });
    const first = db.commit((tx) => tx.tables.jobs.take(now, [LANE.live], heldBy(running.values())));
    expect(first?.kind).toBe("render");
    finish(walk);
    const second = db.commit((tx) => tx.tables.jobs.take(now, [LANE.live], heldBy(running.values())));
    expect({ kind: second?.kind, key: second?.key }).toEqual({ kind: "extract", key: "notes" });
  });

  it("runs again in the lane it was made due in, never the one the run in hand was served in (F3)", () => {
    const live = take("extract", "notes", LANE.live);
    land(now - 30 * 24 * 60 * MINUTE);
    expect(live.due).toBe(LANE.backfill);
    finish(live);
    expect(row("extract", "notes")).toMatchObject({ state: "queued", lane: LANE.backfill });
    const backfill = take("extract", "notes", LANE.backfill);
    land(now - MINUTE);
    expect(backfill.due).toBe(LANE.live);
    finish(backfill);
    expect(row("extract", "notes")).toMatchObject({ state: "queued", lane: LANE.live });
    seen.next_lane = row("extract", "notes");
  });

  it("keeps the urgency of the run in hand on its row, owing no run by it, so a restart serves it live (F4)", () => {
    const backfill = take("extract", "notes", LANE.backfill);
    land(now - MINUTE);
    expect(row("extract", "notes")).toMatchObject({ state: "running", lane: LANE.live, requeue: 0 });
    expect(backfill.due).toBe(LANE.live);
    running.clear();
    expect(db.commit((tx) => tx.tables.jobs.recover())).toBe(1);
    expect(row("extract", "notes")).toMatchObject({ state: "queued", lane: LANE.live });
    seen.restart = row("extract", "notes");
  });

  it("leaves a labeler resting when a commit makes it due as it rests: it runs again at its rest's end (F5)", () => {
    const labeler = take("label", "fake-labeler", LANE.live);
    commit((tx) => due.queue(tx, "label", "fake-labeler", LANE.live));
    expect(labeler.due).toBe(LANE.live);
    labeler.again = { at_ms: now + 60 * MINUTE, lane: LANE.live };
    finish(labeler);
    expect(row("label", "fake-labeler")).toMatchObject({ state: "queued", lane: LANE.live, not_before_ms: now + 60 * MINUTE });
    seen.rest = row("label", "fake-labeler");
  });
});
