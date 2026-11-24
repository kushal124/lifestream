import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { openHome, openHomeFolder, type BlobStore, type HomeDb, type JsonObject } from "@lifestreamprotocol/core";
import { aiFamily, labelsFamily, photosFamily, physicalFamily, screenFamily, type Family } from "@lifestreamprotocol/families";
import { RELEASE_FED } from "./test/fed.js";
import { extractCursor, rebuildExtracts } from "./derive.js";
import { LANE } from "./jobs.js";
import { coastHeard, drain, historyBacklog, photosBacklog, physicalBacklog, screenBacklog, SHORT_DAY, STILL, strayFix, summary, watchDue, type Ran } from "./test/backlog.js";

const physical = physicalFamily({ photos: RELEASE_FED.photos })(RELEASE_FED.physical);

const KEEP = process.env.LIFESTREAM_KEEP_ARTIFACTS === "1";
const DIR = mkdtempSync(join(tmpdir(), "lifestream-extract-cost-"));
const ARTIFACT: Record<string, unknown> = {};

afterAll(() => {
  writeFileSync(join(DIR, "extract-cost.json"), `${JSON.stringify(ARTIFACT, null, 1)}\n`);
  if (KEEP) console.log(`extract cost artifact kept: ${join(DIR, "extract-cost.json")}`);
  else rmSync(DIR, { recursive: true, force: true });
});
function open(name: string): { db: HomeDb; reader: HomeDb; blobs: BlobStore } {
  const dir = mkdtempSync(join(DIR, `${name}-`));
  const db = openHome(openHomeFolder(dir), "migrate");
  return { db, reader: openHome(openHomeFolder(dir), "read"), blobs: openHomeFolder(dir).blobs(join(dir, "blobs")) };
}

describe("an extract chunk's cost grows with its statements and the units it extracts", () => {
  it("a chunk of a dense sitting reads the sitting once per statement", async () => {
    const measured: Record<string, JsonObject> = {};
    for (const hours of [1, 4]) {
      const { db, reader, blobs } = open(`screen-${hours}h`);
      const backlog = screenBacklog(db, 4 / hours, hours);
      const built = await drain(db, reader, blobs, screenFamily({ zone: "UTC" })(RELEASE_FED.screen));
      const trees = backlog.restate();
      const restated = await drain(db, reader, blobs, screenFamily({ zone: "UTC" })(RELEASE_FED.screen));
      reader.close();
      db.close();
      expect(restated.written + restated.deleted).toBe(0);
      measured[`${hours}h`] = { rows: backlog.rows, trees, built: summary(built), restated: summary(restated) };
      ARTIFACT[`screen-${hours}h`] = { ...measured[`${hours}h`], chunks: { built: built.chunks, restated: restated.chunks } };
    }
    const short = measured["1h"]!.restated as JsonObject;
    const long = measured["4h"]!.restated as JsonObject;
    expect(long.extract_bytes_per_statement as number).toBeLessThan(1_000);
    expect(long.extract_bytes_per_statement as number).toBeLessThanOrEqual(2 * (short.extract_bytes_per_statement as number) + 100);
    expect(long.touched_rows_per_statement as number).toBeLessThan(2);
    expect((measured["4h"]!.built as JsonObject).touched_rows_per_statement as number).toBeLessThan(2);
  });

  it("a chunk of a dense phone day reads the day once per statement", async () => {
    const { db, reader, blobs } = open("physical");
    const rows = physicalBacklog(db, 1);
    const drained = await drain(db, reader, blobs, physical);
    reader.close();
    db.close();
    const measured: JsonObject = { rows, ...summary(drained) };
    ARTIFACT.physical = { summary: measured, chunks: drained.chunks };
    expect(measured.units as number).toBeGreaterThan(0);
    expect(measured.touched_rows_per_statement as number).toBeLessThan(4);
  });

  it("a long sitting spread over many chunks is extracted once per run", async () => {
    const { db, reader, blobs } = open("screen-long");
    const backlog = screenBacklog(db, 1, 8);
    const built = await drain(db, reader, blobs, screenFamily({ zone: "UTC" })(RELEASE_FED.screen));
    backlog.restate();
    const restated = await drain(db, reader, blobs, screenFamily({ zone: "UTC" })(RELEASE_FED.screen));
    reader.close();
    db.close();
    ARTIFACT["screen-long"] = { rows: backlog.rows, built: summary(built), restated: summary(restated), runs: { built: built.runs, restated: restated.runs } };
    expect(built.units).toBe(1);
    expect(built.chunks.reduce((sum, chunk) => sum + chunk.statements, 0)).toBeGreaterThan(8 * 2_000);
    expect(restated.written + restated.deleted).toBe(0);
    for (const run of [...built.runs, ...restated.runs]) expect(run.extracts).toBe(run.units);
  });

  it("a run's chunks fetch again the statements the chunk before them left unread", async () => {
    const { db, reader, blobs } = open("screen-fetched");
    screenBacklog(db, 1, 8);
    const family = screenFamily({ zone: "UTC" })(RELEASE_FED.screen);
    const drained = await drain(db, reader, blobs, family);
    reader.close();
    db.close();
    const streams = new Set(family.inputs.flatMap((input) => input.kinds)).size;
    ARTIFACT["screen-fetched"] = { streams, runs: drained.runs.map(({ statements, fetched }) => ({ statements, fetched })) };
    expect(drained.touched[0]!.length).toBeGreaterThan(1);
    for (const run of drained.runs) expect(run.fetched).toBeLessThanOrEqual(run.statements + streams * 512);
  });

  it("a photo statement touches the bursts it can change, never every photo near it", async () => {
    const { db, reader, blobs } = open("photos");
    const backlog = photosBacklog(db, 20);
    const family = photosFamily({ faces: true })(RELEASE_FED.photos);
    const drained = await drain(db, reader, blobs, family);
    reader.close();
    db.close();
    const measured: JsonObject = { ...backlog, ...summary(drained) };
    ARTIFACT.photos = { summary: measured, runs: drained.runs, chunks: drained.chunks };
    expect(drained.units).toBe(backlog.photos + backlog.wanted + 20);
    for (const run of drained.runs) expect(run.extracts).toBe(run.units);
    expect(measured.unit_extracts as number).toBeLessThanOrEqual(2 * drained.units);
    expect(measured.touched_rows_per_statement as number).toBeLessThan(20);
  });

  it("a view that lives for a run reads the machine's whole history again", async () => {
    const { db, reader, blobs } = open("screen-history");
    screenBacklog(db, 6, 1);
    await drain(db, reader, blobs, screenFamily({ zone: "UTC" })(RELEASE_FED.screen));
    const fresh = screenBacklog(db, 4, 1, 6);
    const drained = await drain(db, reader, blobs, screenFamily({ zone: "UTC" })(RELEASE_FED.screen));
    reader.close();
    db.close();
    const [run] = drained.touched;
    ARTIFACT["screen-history"] = { rows: fresh.rows, touched_rows_per_chunk: run, summary: summary(drained) };
    expect(drained.runs.length).toBe(1);
    expect(run!.length).toBeGreaterThan(3);
    const first = Math.max(...run!.slice(0, 2));
    for (const rows of run!.slice(2)) expect(rows).toBeLessThanOrEqual(2 * first + 100);
  });

  it("a read-through move far from a run's statements reads everything between them", async () => {
    const { db, reader, blobs } = open("screen-heard");
    const early = screenBacklog(db, 4, 1);
    screenBacklog(db, 8, 1, 4);
    await drain(db, reader, blobs, screenFamily({ zone: "UTC" })(RELEASE_FED.screen));
    const trees = early.restate();
    coastHeard(db, 8 + 8);
    const drained = await drain(db, reader, blobs, screenFamily({ zone: "UTC" })(RELEASE_FED.screen));
    reader.close();
    db.close();
    const measured = summary(drained);
    ARTIFACT["screen-heard"] = { trees, touched_rows_per_chunk: drained.touched, summary: measured };
    expect(drained.runs.length).toBe(1);
    expect(drained.written + drained.deleted).toBe(0);
    expect(measured.touched_rows_per_statement as number).toBeLessThan(2);
  });

  it("a phone's day costs more the more days came before it", async () => {
    const measured: Record<string, JsonObject> = {};
    for (const days of [2, 8]) {
      const { db, reader, blobs } = open(`phone-${days}d`);
      const rows = physicalBacklog(db, days, true, SHORT_DAY);
      const drained = await drain(db, reader, blobs, physical);
      reader.close();
      db.close();
      measured[`${days}d`] = { rows, touched_calls: drained.touched.flat().length, ...summary(drained) };
    }
    ARTIFACT.phone = measured;
    const read = (days: string) => (measured[days]!.touched_rows_per_statement as number) + (measured[days]!.extract_rows_per_statement as number);
    expect(measured["8d"]!.touched_calls as number).toBeGreaterThan(1);
    expect(read("8d")).toBeLessThanOrEqual(read("2d") * 1.5);
  });
  it("a run over a dense stretch holds the whole stretch in memory", async () => {
    const { db, reader, blobs } = open("screen-dense");
    const backlog = screenBacklog(db, 1, 1, 0, 1_500);
    await drain(db, reader, blobs, screenFamily({ zone: "UTC" })(RELEASE_FED.screen));
    backlog.restate();
    const drained = await drain(db, reader, blobs, screenFamily({ zone: "UTC" })(RELEASE_FED.screen));
    reader.close();
    db.close();
    ARTIFACT["screen-dense"] = { touched_bytes: drained.touched_bytes, commit_bytes: drained.commit_bytes, summary: summary(drained) };
    expect(drained.written + drained.deleted).toBe(0);
    expect(drained.touched_bytes).toBeLessThan(64 * 1024 * 1024 + 1_000_000);
  });
});

describe("an extract run holds its read about a minute, building included", () => {
  const stored = (db: HomeDb, family: string) => {
    const view = db.view();
    try {
      return [...view.extracts(family)].map(({ seq: _seq, ...row }) => row);
    } finally {
      view.close();
    }
  };
  const left = (db: HomeDb, family: string) => {
    const view = db.view();
    try {
      const after = view.tables.cursors.get(extractCursor(family))?.reread ?? 0;
      return view.rereads(after, 10_000).flatMap((each) => "family" in each && each.family === family ? [each.unit] : []);
    } finally {
      view.close();
    }
  };

  it("a run whose building outlasts the minute leaves its units to the next run, and every unit ends as one unbounded run builds it", async () => {
    const plain = screenFamily({ zone: "UTC" })(RELEASE_FED.screen);
    const more = (db: HomeDb) => {
      screenBacklog(db, 1, 2, 11);
      screenBacklog(db, 1, 2, 1);
    };

    const once = open("bound-once");
    screenBacklog(once.db, 12, 1);
    more(once.db);
    const whole = await drain(once.db, once.reader, once.blobs, plain);
    const expected = stored(once.db, plain.name);
    once.reader.close();
    once.db.close();
    expect(whole.runs.length).toBe(1);

    const bounded = open("bound-slow");
    screenBacklog(bounded.db, 12, 1);
    let clock = 0;
    const slow: Family = { ...plain, extract: (...args) => {
      clock += 25_000;
      return plain.extract(...args);
    } };
    const ran: (Ran & { left: string[] })[] = [];
    const watched = watchDue(bounded.db, [plain, physical]);
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    let drained;
    try {
      drained = await drain(bounded.db, bounded.reader, bounded.blobs, slow, { watched, afterRun: (run) => {
        ran.push({ ...run, left: left(bounded.db, plain.name) });
        if (ran.length === 1) more(bounded.db);
      } });
    } finally {
      now.mockRestore();
    }
    const built = stored(bounded.db, plain.name);
    const rereads = () => {
      const view = bounded.db.view();
      try {
        return view.rereads(0, 10_000).length;
      } finally {
        view.close();
      }
    };
    const kept = rereads();
    const erased = expected[0]!.unit;
    bounded.db.commit((tx) => {
      tx.records.erase({ records: [], units: [{ family: plain.name, unit: erased }], reason: "the test erases a unit", at_ms: 0 });
      watched.due.after(tx);
    });
    const erasureLane = bounded.db.view();
    const lane = erasureLane.tables.jobs.get("extract", plain.name)?.lane;
    erasureLane.close();
    const erasureRuns: Ran[] = [];
    await drain(bounded.db, bounded.reader, bounded.blobs, plain, { watched, afterRun: (run) => erasureRuns.push(run) });
    const rebuilt = stored(bounded.db, plain.name);
    bounded.reader.close();
    bounded.db.close();
    ARTIFACT["bound-slow"] = {
      units: expected.length, rereads_kept: kept, erasure_lane: lane ?? null,
      runs: ran.map(({ statements, built: units, more: again, lane: queued, left: rest }) => ({ statements, built: units, more: again, lane: queued, left: rest })),
    };

    const [first] = ran;
    expect(first!.built.length).toBe(3);
    expect(first!.more).toBe(true);
    expect(first!.left.length).toBeGreaterThan(0);
    for (const unit of first!.left) expect(first!.built).not.toContain(unit);
    for (const run of ran.slice(1, -1)) expect([run.built.length, run.more]).toEqual([3, true]);
    expect(ran.at(-1)!.more).toBe(false);
    for (const [index, run] of ran.slice(0, -1).entries()) expect(ran[index + 1]!.built).toEqual(run.left.slice(0, ran[index + 1]!.built.length));
    expect(ran.at(-1)!.left).toEqual([]);
    expect(drained.runs.reduce((sum, run) => sum + run.extracts, 0)).toBe(expected.length + 1);
    expect(built).toEqual(expected);
    for (const run of ran.slice(0, -1)) expect(run.lane).toBe(LANE.backfill);
    expect(ran.at(-1)!.lane).toBe(null);
    expect(kept).toBe(0);
    expect(lane).toBe(LANE.live);
    expect(erasureRuns.map((run) => run.built)).toEqual([[erased]]);
    expect(rebuilt).toEqual(expected);
  });
});

describe("an extract run states how it was taken", () => {
  it("its row names the lane it ran in and how long its job waited from when it could first run; a backfill run and a live one differ", async () => {
    const plain = screenFamily({ zone: "UTC" })(RELEASE_FED.screen);
    const home = open("taken");
    const watched = watchDue(home.db, [plain]);
    screenBacklog(home.db, 1, 1);
    await drain(home.db, home.reader, home.blobs, plain, { watched });
    screenBacklog(home.db, 1, 1, 2);
    home.db.commit((tx) => tx.tables.jobs.enqueue({ kind: "extract", key: plain.name, lane: LANE.live, not_before_ms: 1_000, now_ms: 1_000 }));
    await drain(home.db, home.reader, home.blobs, plain, { watched });
    home.reader.close();
    home.db.close();
    const file = new Database(home.db.path, { readonly: true });
    const runs = (file.prepare("SELECT started_ms, counts FROM runs WHERE kind = 'extract' ORDER BY id").all() as { started_ms: number; counts: string }[])
      .map((run) => ({ started_ms: run.started_ms, counts: JSON.parse(run.counts) as { lane: number; waited_ms: number } }));
    file.close();
    ARTIFACT.taken = runs;
    expect(runs.map(({ started_ms, counts }) => ({ lane: counts.lane, waited_ms: counts.waited_ms, since: started_ms - counts.waited_ms }))).toEqual([
      { lane: LANE.backfill, waited_ms: 0, since: runs[0]!.started_ms },
      { lane: LANE.live, waited_ms: runs[1]!.started_ms - 1_000, since: 1_000 },
    ]);
  });
});

describe("a rebuild reads each record about once, however long the history", () => {
  const rows = (db: HomeDb, family: string) => {
    const view = db.view();
    try {
      return [...view.extracts(family)].map(({ seq: _seq, ...row }) => row);
    } finally {
      view.close();
    }
  };
  const WEEK = 7 * 86_400_000;
  const BASE = Date.UTC(2026, 7, 3, 9, 0);
  const strays = [BASE - 3 * 365 * 86_400_000, BASE + 365 * 86_400_000];
  const ROUND: [number, number, number][] = [[0.3, 0, 0], [0.2, 0, 1], [0.3, 1, 1], [0.2, 1, 0]];

  it("a walk over four weeks reads more fixes per fix than over two, opens a view per week, walks the empty years, misses a far record, or builds other rows than ordinary runs", async () => {
    const measured: Record<string, JsonObject> = {};
    for (const weeks of [2, 4]) {
      const reference = open(`walk-reference-${weeks}w`);
      physicalBacklog(reference.db, 7 * weeks, false, ROUND);
      for (const at of strays) strayFix(reference.db, at);
      await drain(reference.db, reference.reader, reference.blobs, physical);
      const expected = rows(reference.db, physical.name);
      reference.reader.close();
      reference.db.close();

      const walked = open(`walk-${weeks}w`);
      const rowsLanded = physicalBacklog(walked.db, 7 * weeks, false, ROUND);
      for (const at of strays) strayFix(walked.db, at);
      walked.db.commit((tx) => rebuildExtracts(tx, physical.name, 0));
      const drained = await drain(walked.db, walked.reader, walked.blobs, physical);
      const built = rows(walked.db, physical.name);
      const view = walked.db.view();
      const fixes = [...view.heads("location:local:iphone-0001", "fix")].length;
      const kinds = new Set(physical.inputs.flatMap((input) => input.kinds));
      const read = [["location:local:iphone-0001", "fix"], ["location:local:iphone-0001", "recorder"], ["motion:local:iphone-0001", "motion"]]
        .filter(([, kind]) => kinds.has(kind!)).flatMap(([source, kind]) => [...view.heads(source!, kind!)]);
      const weeks_with_records = new Set(read.map((head) => Math.floor(head.start_ms! / WEEK))).size;
      view.close();
      walked.reader.close();
      walked.db.close();
      const across = built.filter((row) => row.start_ms !== null && row.end_ms !== null && Math.floor(row.start_ms / WEEK) < Math.floor(row.end_ms / WEEK));
      measured[`${weeks}w`] = {
        rows: rowsLanded, records: read.length, fixes, fixes_read: drained.fixes, fixes_read_per_fix: drained.fixes / fixes, views: drained.views,
        weeks_with_records, ...drained.walked, units: built.length, across_a_week_edge: across.length,
      };
      expect(drained.walked).toEqual({ views: 1, slabs: 1 + weeks_with_records, records: read.length });
      expect(built).toEqual(expected);
      expect(across.length).toBeGreaterThan(0);
      expect(drained.fixes).toBeLessThanOrEqual(2 * fixes);
      for (const at of strays) expect(built.some((row) => row.start_ms !== null && row.start_ms <= at + 60_000 && (row.end_ms ?? row.start_ms) >= at)).toBe(true);
    }
    ARTIFACT.walk = measured;
    const per = (weeks: string) => measured[weeks]!.fixes_read_per_fix as number;
    expect(per("4w")).toBeLessThanOrEqual(per("2w") * 1.2);
  });
});

describe("a walk reads what a family reads whole once, never once a week", () => {
  const WEEK = 7 * 86_400_000;
  it("Timeline's visits, the cards, Ask's chats or a phone's long stay are read more per record over four weeks than over two", async () => {
    const families = { physical, labels: labelsFamily({ home: null, messages: RELEASE_FED.messages, mail: RELEASE_FED.mail })(RELEASE_FED.labels), ai: aiFamily(RELEASE_FED.ai) } as const;
    const measured: Record<string, Record<string, JsonObject>> = {};
    for (const weeks of [2, 4]) {
      const { db, reader, blobs } = open(`history-${weeks}w`);
      const landed = historyBacklog(db, 7 * weeks);
      const still = (() => {
        const view = db.view();
        try {
          const byWeek = new Map<number, number>();
          for (const head of view.heads(STILL, "fix")) byWeek.set(Math.floor(head.start_ms! / WEEK), (byWeek.get(Math.floor(head.start_ms! / WEEK)) ?? 0) + 1);
          let sofar = 0;
          let bound = 0;
          for (const [, count] of [...byWeek].sort(([left], [right]) => left - right)) bound += (sofar += count);
          return { weeks: byWeek.size, bound };
        } finally {
          view.close();
        }
      })();
      measured[`${weeks}w`] = {};
      for (const [name, family] of Object.entries(families)) {
        db.commit((tx) => rebuildExtracts(tx, family.name, 0));
        const drained = await drain(db, reader, blobs, family);
        const [run] = drained.runs;
        measured[`${weeks}w`]![name] = {
          ...drained.reads, kinds: drained.reads.kinds, slabs: drained.walked?.slabs ?? 0, walked: drained.walked?.records ?? 0,
          units: drained.units, built: run?.extracts ?? 0, views: drained.views,
        };
        expect(drained.walked?.views, name).toBe(1);
      }
      reader.close();
      db.close();
      const of = measured[`${weeks}w`]!;
      const kinds = (name: string) => of[name]!.kinds as Record<string, number>;
      Object.assign(of, { landed, still });
      expect(kinds("physical")["place-visit"]!).toBeLessThanOrEqual(3 * landed.visits);
      expect(kinds("physical").trip!).toBeLessThanOrEqual(3 * landed.trips);
      expect(kinds("physical").fix!).toBeLessThanOrEqual(still.bound + 2 * still.weeks * 144);
      expect(of.labels!.built).toBe(of.labels!.units);
      expect(of.labels!.slabs).toBe(1);
      expect(kinds("labels").contact!).toBeLessThanOrEqual(3 * landed.cards);
      expect(of.ai!.extracts as number).toBeLessThanOrEqual(4 * landed.chats);
    }
    ARTIFACT.history = measured;
    const per = (weeks: string, family: string, kind: string, count: string) =>
      ((measured[weeks]![family]!.kinds as Record<string, number>)[kind] ?? 0) / ((measured[weeks]!.landed as unknown as Record<string, number>)[count]!);
    for (const [family, kind, count] of [["physical", "place-visit", "visits"], ["physical", "trip", "trips"], ["labels", "contact", "cards"]] as const) {
      expect(per("4w", family, kind, count), `${family} ${kind}`).toBeLessThanOrEqual(per("2w", family, kind, count) * 1.2);
    }
    const aiPer = (weeks: string) => (measured[weeks]!.ai!.extracts as number) / ((measured[weeks]!.landed as unknown as Record<string, number>).chats!);
    expect(aiPer("4w")).toBeLessThanOrEqual(aiPer("2w") * 1.2);
  });
});
