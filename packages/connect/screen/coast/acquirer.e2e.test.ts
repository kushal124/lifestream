import { artifact, collect, deliver, LENT, openTestHome, poll, temp, type PollRecord, type TestHome } from "../../test/drive.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonical, type JsonObject, type Landed } from "@lifestreamprotocol/core";
import { statedAt } from "../../shared/index.js";
import { coastAcquirer, VIDEO, type CoastSettings } from "./acquirer.js";
import { coast, COAST_FRAME } from "./reader.js";
import { COAST_FILE, CoastShapeUnknown } from "./shape.js";
import { BASE, COAST_SOURCE, COAST_UNIT, FakeCoast, VIDEOS } from "./test/fixture.js";

const SETTLE = 60_000;

interface Poll {
  facts: JsonObject;
  state: JsonObject;
  more?: true;
  files: string[];
  landed: Landed;
  frames: string[];
}

function setup(home: TestHome, options: Partial<CoastSettings> = {}) {
  const live = join(home.dir, "inc.example.coast", "rem.db");
  const videos = join(home.dir, "inc.example.coast", "videos");
  mkdirSync(videos, { recursive: true });
  for (const [name, bytes] of Object.entries(VIDEOS)) writeFileSync(join(videos, name), bytes);
  const store = new FakeCoast(live, "id", { wal: true });
  store.video(1, "a".repeat(64));
  store.video(2, "b".repeat(64));
  let now = BASE;
  const settings: CoastSettings = {
    unit: COAST_UNIT, database: live, videos, settle_ms: SETTLE, work: join(home.dir, "coast-work"), clock: () => now, ...options,
  };
  const acquirer = coastAcquirer(settings);
  const record: PollRecord = { state: null, deliveries: [] };
  const polls: Poll[] = [];
  const fingerprint = () => ["", "-wal"].map((suffix) => (existsSync(live + suffix) ? createHash("sha256").update(readFileSync(live + suffix)).digest("hex") : "none")).join(" ");
  return {
    store,
    live,
    acquirer,
    polls,
    at(ms: number) {
      now = ms;
    },
    record,
    get state() {
      return record.state;
    },
    async poll(start_ms: number | null = null): Promise<Poll> {
      const before = fingerprint();
      const sealed = await poll(home, acquirer, record, { get: () => undefined, rotate: () => {} }, now, "fetch", start_ms);
      expect(fingerprint()).toBe(before);
      const facts = record.facts!;
      const delivery = sealed ?? deliver(home, COAST_SOURCE, {}, facts, statedAt(facts));
      const rows = await collect(coast.read(delivery, home.blobs));
      const landed = await home.land(coast, delivery, rows);
      const more = record.next?.more;
      const done = { facts, state: record.state!, ...(more === undefined ? {} : { more }), files: delivery.files.map((file) => file.path), landed, frames: rows.filter((row) => row.kind === COAST_FRAME).map((row) => row.key) };
      polls.push(done);
      return done;
    },
  };
}

async function wholeRead(home: TestHome, store: FakeCoast): Promise<Map<string, string>> {
  const copy = join(home.dir, `whole-${Date.now()}-${Math.random()}.db`);
  store.db.prepare("VACUUM INTO ?").run(copy);
  const delivery = deliver(home, COAST_SOURCE, { [COAST_FILE]: readFileSync(copy) }, { snapshot_taken_at: "2026-09-30T00:00:00.000Z" });
  return new Map((await collect(coast.read(delivery, home.blobs))).map((row) => [`${row.kind} ${row.key}`, canonical(row.content)]));
}

describe("Coast acquirer: each of these is impossible", () => {
  it("a poll copies a window that overlaps or leaves a gap with the last one, or fetches what the previous poll sealed", async () => {
    const home = openTestHome();
    try {
      const coastStore = setup(home);
      const { store } = coastStore;
      store.segment(1, 1, 1, 1, "https://example.com/");
      store.frame(1, BASE + 1_000, 1);
      store.frame(2, BASE + 2_000, 1);
      store.tree(2, BASE + 2_000);
      store.frame(3, BASE + 3_000, 1);
      store.frame(4, BASE + 4_000, null);
      store.frame(5, BASE + 4_000, null);
      store.frame(6, BASE + 30_000, 1, [2, 0]);
      coastStore.at(BASE + 70_000);
      const first = await coastStore.poll();
      expect(first.facts).toMatchObject({ kind: "delta", after: 0, through: 5, window: "time" });
      store.frame(7, BASE + 100_000, 1, [2, 1]);
      store.segment(2, 8, 2, null, null);
      store.frame(8, BASE + 200_000, 2, [2, 2]);
      store.tree(8, BASE + 200_000);
      store.frame(9, BASE + 590_000, 2, [2, 3]);
      coastStore.at(BASE + 600_000);
      const second = await coastStore.poll();
      expect(second.facts).toMatchObject({ after: 5, through: 8, window: "id" });
      coastStore.at(BASE + 900_000);
      const third = await coastStore.poll();
      expect(third.facts).toMatchObject({ after: 8, through: 9 });
      coastStore.at(BASE + 1_200_000);
      const quiet = await coastStore.poll();
      expect(quiet.files).toEqual([]);
      expect(quiet.facts.read_through).toBe(new Date(BASE + 1_200_000 - SETTLE).toISOString());

      const stated = coastStore.polls.flatMap((poll) => poll.frames);
      expect(stated).toHaveLength(new Set(stated).size);
      expect(stated.sort()).toEqual([1, 2, 3, 4, 4, 30, 100, 200, 590].map((s, index) => `${BASE + s * 1_000}${index === 4 ? ":1" : ""}`).sort());
      const carried = coastStore.polls.flatMap((poll) => poll.files.filter((file) => file.startsWith("videos/")));
      expect(carried).toHaveLength(new Set(carried).size);
      expect(third.files).toEqual([COAST_FILE, "videos.json"]);
      const heads = home.heads(COAST_SOURCE);
      const whole = await wholeRead(home, store);
      expect(new Map(heads.map((head) => [`${head.kind} ${head.key}`, canonical(head.content!)]))).toEqual(whole);
      artifact(home.dir, "polls.json", { polls: coastStore.polls, heads: heads.map(({ content: _content, ...head }) => head) });
      store.close();
    } finally {
      home.close();
    }
  });

  it("a start moved earlier never reads the frames it left out, reads again what the walk read, or one moved later states a frame before it", async () => {
    const home = openTestHome();
    try {
      const coastStore = setup(home);
      const { store } = coastStore;
      [1, 2, 3].forEach((id) => store.frame(id, BASE + id * 1_000, null));
      [4, 5, 6].forEach((id) => store.frame(id, BASE + (id + 6) * 1_000, null));
      coastStore.at(BASE + 200_000);
      const under = await coastStore.poll(BASE + 5_000);
      expect([under.facts, under.frames]).toEqual([expect.objectContaining({ after: 3, through: 6, window: "time" }), [10, 11, 12].map((s) => `${BASE + s * 1_000}`)]);
      const gap = await coastStore.poll(null);
      expect([gap.facts, gap.more, gap.frames]).toEqual([expect.objectContaining({ after: 0, through: 3, window: "gap" }), true, [1, 2, 3].map((s) => `${BASE + s * 1_000}`)]);
      expect(gap.state).toMatchObject({ frame_id: 6 });
      expect(gap.state).not.toHaveProperty("gap");
      const quiet = await coastStore.poll(null);
      expect([quiet.files, quiet.frames]).toEqual([[], []]);
      store.frame(7, BASE + 150_000, null);
      store.frame(8, BASE + 250_000, null);
      coastStore.at(BASE + 400_000);
      const later = await coastStore.poll(BASE + 200_000);
      expect([later.facts, later.frames]).toEqual([expect.objectContaining({ after: 7, through: 8, window: "time" }), [`${BASE + 250_000}`]]);
      artifact(home.dir, "moved.json", { polls: coastStore.polls.map(({ facts, state, frames }) => ({ facts, state, frames })) });
      store.close();
    } finally {
      home.close();
    }
  });

  it("a gap too large for one call goes on reading frames before a start moved later mid-gap, or outlives the frames it had left", async () => {
    const home = openTestHome();
    try {
      const coastStore = setup(home, { max_frames: 2 });
      const { store } = coastStore;
      [1, 2, 3, 4, 5, 6].forEach((id) => store.frame(id, BASE + id * 1_000, null));
      [7, 8].forEach((id) => store.frame(id, BASE + (id + 20) * 1_000, null));
      coastStore.at(BASE + 200_000);
      const under = await coastStore.poll(BASE + 20_000);
      expect([under.facts, under.frames]).toEqual([expect.objectContaining({ after: 6, through: 8, window: "time" }), [27, 28].map((s) => `${BASE + s * 1_000}`)]);
      const opened = await coastStore.poll(null);
      expect([opened.facts, opened.more, opened.frames]).toEqual([expect.objectContaining({ after: 0, through: 2, window: "gap" }), true, [1, 2].map((s) => `${BASE + s * 1_000}`)]);
      expect(opened.state).toMatchObject({ gap: { after: 2, through: 6 } });
      const later = await coastStore.poll(BASE + 4_000);
      expect([later.facts, later.more, later.frames]).toEqual([expect.objectContaining({ after: 3, through: 5, window: "gap" }), true, [4, 5].map((s) => `${BASE + s * 1_000}`)]);
      expect(later.state).toMatchObject({ gap: { after: 5, through: 6 } });
      const past = await coastStore.poll(BASE + 6_500);
      expect([past.files, past.frames, past.more]).toEqual([[], [], undefined]);
      expect(past.state).not.toHaveProperty("gap");
      expect(past.state).toMatchObject({ frame_id: 8 });
      artifact(home.dir, "moved-mid-gap.json", { polls: coastStore.polls.map(({ facts, state, frames }) => ({ facts, state, frames })) });
      store.close();
    } finally {
      home.close();
    }
  });

  it("a poll whose home's folder went away (a drive unplugged) makes the folder again on the boot disk", async () => {
    const home = openTestHome("connect-coast-gone-");
    const root = join(home.dir, "home");
    mkdirSync(join(root, "tools"), { recursive: true });
    const lane = setup(home, { work: join(root, "tools", "coast-work") });
    try {
      renameSync(root, `${root}-away`);
      await expect(lane.acquirer.fetch(null, { get: () => undefined, rotate: () => {} }, LENT)).rejects.toThrow(/ENOENT/u);
      expect(existsSync(root)).toBe(false);
      lane.store.close();
    } finally {
      home.close();
    }
  });

  it("a poll stopped at its cap splits a millisecond, or a capped poll is not due again at once", async () => {
    const home = openTestHome();
    try {
      const coastStore = setup(home, { max_frames: 2 });
      const { store } = coastStore;
      store.frame(1, BASE + 1_000, null);
      store.frame(2, BASE + 2_000, null);
      store.frame(3, BASE + 2_000, null);
      store.frame(4, BASE + 3_000, null);
      store.frame(5, BASE + 4_000, null);
      coastStore.at(BASE + 400_000);
      const first = await coastStore.poll();
      expect(first.facts).toMatchObject({ after: 0, through: 3 });
      expect(first.frames.sort()).toEqual([`${BASE + 1_000}`, `${BASE + 2_000}`, `${BASE + 2_000}:1`].sort());
      expect(first.more).toBe(true);
      const second = await coastStore.poll();
      expect(second.facts).toMatchObject({ after: 3, through: 5 });
      const third = await coastStore.poll();
      expect(third.files).toEqual([]);
      expect([second.more, third.more]).toEqual([undefined, undefined]);
      expect([first, second].map((poll) => poll.facts.snapshot_taken_at)).toEqual([new Date(BASE + 2_000).toISOString(), new Date(BASE + 400_000 - SETTLE).toISOString()]);
      artifact(home.dir, "polls.json", coastStore.polls);
      store.close();
    } finally {
      home.close();
    }
  });

  it("a provider cursor that goes backward skips or repeats a frame", async () => {
    const home = openTestHome();
    try {
      const coastStore = setup(home);
      coastStore.store.frame(1, BASE + 1_000, null);
      coastStore.store.frame(2, BASE + 2_000, null);
      coastStore.at(BASE + 300_000);
      await coastStore.poll();
      coastStore.store.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(coastStore.live + suffix, { force: true });
      const reset = new FakeCoast(coastStore.live, "id", { wal: true });
      reset.video(1, "a".repeat(64));
      reset.frame(1, BASE + 1_500, null);
      reset.frame(2, BASE + 400_000, null);
      reset.frame(3, BASE + 401_000, null);
      coastStore.at(BASE + 600_000);
      const after = await coastStore.poll();
      expect(after.facts).toMatchObject({ window: "time", after: 1, through: 3 });
      expect(after.frames).toEqual([`${BASE + 400_000}`, `${BASE + 401_000}`]);
      reset.frame(4, BASE + 500_000, null);
      coastStore.at(BASE + 900_000);
      const next = await coastStore.poll();
      expect(next.facts).toMatchObject({ window: "id", after: 3, through: 4 });
      const stated = coastStore.polls.flatMap((poll) => poll.frames);
      expect(stated).toHaveLength(new Set(stated).size);
      artifact(home.dir, "polls.json", coastStore.polls);
      reset.close();
    } finally {
      home.close();
    }
  });

  it("a tree naming a node the store never persisted refuses the window or loses its frame", async () => {
    const home = openTestHome();
    try {
      const coastStore = setup(home);
      const { store } = coastStore;
      store.frame(1, BASE + 1_000, null);
      store.tree(1, BASE + 1_000);
      store.frame(2, BASE + 2_000, null);
      store.tree(2, BASE + 2_000, { missing: true });
      coastStore.at(BASE + 300_000);
      const poll = await coastStore.poll();
      expect(poll.facts).toMatchObject({ ax_snapshots: 1, ax_dropped: 1, ax_dropped_frames: [2] });
      expect(poll.frames).toEqual([`${BASE + 1_000}`, `${BASE + 2_000}`]);
      expect(poll.landed).toMatchObject({ new: 3, refused: 0 });
      artifact(home.dir, "polls.json", coastStore.polls);
      store.close();
    } finally {
      home.close();
    }
  });

  it("an unknown Coast schema shape is copied blind, or moves the cursor past what it could not read", async () => {
    const home = openTestHome();
    try {
      const coastStore = setup(home);
      const { store } = coastStore;
      store.frame(1, BASE + 1_000, null);
      coastStore.at(BASE + 300_000);
      await coastStore.poll();
      store.frame(2, BASE + 400_000, null);
      store.db.exec("ALTER TABLE ax_snapshot RENAME COLUMN root_id TO root_ref");
      const held = coastStore.state;
      coastStore.at(BASE + 600_000);
      await expect(coastStore.poll()).rejects.toBeInstanceOf(CoastShapeUnknown);
      expect(coastStore.state).toBe(held);
      store.db.exec("ALTER TABLE ax_snapshot RENAME COLUMN root_ref TO root_id");
      const next = await coastStore.poll();
      expect(next.frames).toEqual([`${BASE + 400_000}`]);
      artifact(home.dir, "polls.json", coastStore.polls);
      store.close();
    } finally {
      home.close();
    }
  });

  it("the window holds a column or table Coast's own schema does not, or the connector reads it differently from the store", async () => {
    const home = openTestHome();
    try {
      const coastStore = setup(home);
      const { store } = coastStore;
      store.segment(1, 1, 1, 2, null);
      store.frame(1, BASE + 1_000, 1, [1, 0], "SYNTHETIC OCR LINE");
      store.tree(1, BASE + 1_000);
      coastStore.at(BASE + 300_000);
      const poll = await coastStore.poll();
      const file = coastStore.polls[0]!;
      expect(file.files).toEqual([COAST_FILE, `videos/${"a".repeat(64)}`]);
      expect(poll.landed).toMatchObject({ new: 3, refused: 0 });
      const whole = await wholeRead(home, store);
      for (const head of home.heads(COAST_SOURCE)) expect(canonical(head.content!)).toBe(whole.get(`${head.kind} ${head.key}`));
      store.close();
    } finally {
      home.close();
    }
  });
});

describe("Coast's cursor and memory", () => {
  it("grows the cursor with a window's videos, carries one again after it, or writes memory on a poll that found nothing new (N and 4N)", async () => {
    const window = async (count: number) => {
      const home = openTestHome();
      try {
        const coastStore = setup(home, { max_frames: count });
        const { store } = coastStore;
        const videos = join(home.dir, "inc.example.coast", "videos");
        store.db.exec("BEGIN");
        for (let n = 1; n <= count; n++) {
          const path = createHash("sha256").update(`synthetic video ${n}`).digest("hex");
          writeFileSync(join(videos, path), `synthetic video ${n}`);
          store.video(n + 2, path);
          store.frame(n, BASE + n * 1_000, null, [n + 2, 0]);
        }
        store.db.exec("COMMIT");
        coastStore.at(BASE + count * 1_000 + 300_000);
        const first = await coastStore.poll();
        expect([first.facts.videos_carried, first.more, coastStore.record.memory!.get(VIDEO)!.size]).toEqual([count, undefined, count]);
        const cursor = Buffer.byteLength(canonical(coastStore.state!));
        coastStore.at(BASE + count * 1_000 + 600_000);
        const next = await coastStore.poll();
        expect([next.files, coastStore.record.changes]).toEqual([[], { cleared: [], entries: [] }]);
        store.frame(count + 1, BASE + count * 1_000 + 601_000, null, [3, 1]);
        coastStore.at(BASE + count * 1_000 + 900_000);
        const listed = await coastStore.poll();
        expect([listed.files, listed.facts.videos_listed, coastStore.record.memory!.get(VIDEO)!.size]).toEqual([[COAST_FILE, "videos.json"], 1, 1]);
        store.close();
        return { count, cursor };
      } finally {
        home.close();
      }
    };
    const n = await window(500);
    const n4 = await window(2_000);
    expect(Math.abs(n4.cursor - n.cursor)).toBeLessThanOrEqual(64);
    expect(Math.max(n.cursor, n4.cursor)).toBeLessThan(16_384);
    artifact(temp(), "bounded.json", { n, n4 });
  });
});
