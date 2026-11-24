import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeTransport } from "@lifestreamprotocol/model";
import { afterAll, describe, expect, it } from "vitest";
import { startHome } from "./home.js";
import { askHome } from "./socket.js";
import { artifact, ChildHome, FAKES, makeRoot, readHome, readLedger, removeRoot, settled, until } from "./test/harness-root.js";
import { ship, type Planned } from "./test/harness-deliveries.js";
import { tortureRun, type TortureSnapshot } from "./test/torture.js";
import { testSocket } from "./test/folder.js";


const SLICE_MS = 1_000;

describe("a rebuild with a live tail", () => {
  let root: string;
  afterAll(() => removeRoot(root));

  it("holds its helper until it is done: another live family's extract waits behind the whole run", async () => {
    root = makeRoot("lifestream-extract-turns-", { sources: { "apple-notes:local:device-a": "fake-rows", "apple-notes:local:device-b": "fake-rows", "screen:local:mac-0001": "fake-rows" }, helpers: 2 });
    const now = Date.now();
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined });
    try {
      await until("every family's first build published", () => readHome(root, (db) =>
        db.prepare("SELECT count(*) FROM cursors WHERE name LIKE 'rebuild:%' AND seq > 0").pluck().get() as number) === 0);
      await askHome(testSocket(root), "pause", ["kind:extract", "--reason", "a test"]);
      const notes = await ship(root, { source: "apple-notes:local:device-a", fetched_ms: now - 1_000, rows: [], facts: { generate: { count: 55_000, start_ms: now - 30 * 86_400_000, step_ms: 40_000, prefix: "history" } } });
      await until("the backlog imported", () => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(notes)) === "imported");
      await ship(root, { source: "screen:local:mac-0001", fetched_ms: now - 500, rows: [{ kind: "frame", key: "f1", content: { at: now - 500 }, at: now - 500 }] });
      const queued = () => readHome(root, (db) => db.prepare("SELECT key FROM jobs WHERE kind = 'extract' AND state = 'queued' AND key <> 'labels' ORDER BY id").pluck().all()) as string[];
      await until("both extracts queued, the notes first", () => queued().join() === "notes,screen");
      const hold = join(root, "hold");
      writeFileSync(hold, "");
      await ship(root, { source: "apple-notes:local:device-b", fetched_ms: now - 100, rows: [{ kind: "note", key: "b-1", content: { text: "b", at: now - 100 }, at: now - 100 }], facts: { hold } });
      await until("the holding import running", () => readHome(root, (db) => db.prepare("SELECT state FROM jobs WHERE kind = 'import' AND key = 'apple-notes:local:device-b'").pluck().get()) === "running");
      await askHome(testSocket(root), "resume", ["kind:extract"]);
      const runs = () => readHome(root, (db) => db.prepare("SELECT subject, started_ms, ended_ms, counts FROM runs WHERE kind = 'extract' ORDER BY id").all()) as { subject: string; started_ms: number; ended_ms: number; counts: string }[];
      await until("the notes extract run twice and the screen extract once", () => runs().filter((run) => run.subject === "notes").length === 2 && runs().some((run) => run.subject === "screen"));
      rmSync(hold);
      const [first, second, third] = runs();
      expect([first!.subject, second!.subject, third!.subject]).toEqual(["notes", "screen", "notes"]);
      expect((JSON.parse(first!.counts) as { statements: number }).statements).toBe(50_000);
      expect(second!.started_ms).toBeGreaterThanOrEqual(first!.ended_ms - SLICE_MS);
      expect(third!.started_ms).toBeGreaterThanOrEqual(second!.ended_ms - SLICE_MS);
      artifact(root, "extract-turns", runs());
    } finally {
      await home.stop();
    }
  });
});

describe("torture: kill -9 at each handoff while three devices ship", () => {
  const FAILPOINTS = ["home.nudged", "home.chunk.import", "home.slice", "import.blob", "day.written", "plan.requested", "call.spawned", "reply.seen"];
  let calm: TortureSnapshot;
  const killed: Record<string, TortureSnapshot> = {};

  it("runs a calm home, and one killed at each handoff", async () => {
    calm = await tortureRun(undefined);
    for (const failpoint of FAILPOINTS) killed[failpoint] = await tortureRun(failpoint);
  });

  it("a failpoint never fires, so nothing was killed", () => {
    for (const failpoint of FAILPOINTS) expect(killed[failpoint]!.kills, failpoint).toBeGreaterThan(0);
  });

  it("a delivery is imported twice or never", () => {
    for (const failpoint of FAILPOINTS) {
      const run = killed[failpoint]!.snapshot;
      expect(run.deliveries, failpoint).toEqual(calm.snapshot.deliveries);
      expect(run.imports, failpoint).toEqual(calm.snapshot.imports);
      expect(Object.values(run.imports).every((count) => count === 1), failpoint).toBe(true);
      expect(run.heads, failpoint).toEqual(calm.snapshot.heads);
    }
  });

  it("a day file differs from a calm run", () => {
    expect(Object.keys(calm.snapshot.days).length).toBeGreaterThan(0);
    for (const failpoint of FAILPOINTS) expect(killed[failpoint]!.snapshot.days, failpoint).toEqual(calm.snapshot.days);
  });

  it("a day's record of what its files print differs from the files, or from a calm run's, after a kill between the file rename and the commit", () => {
    for (const [name, run] of [["calm", calm], ...Object.entries(killed)] as const) {
      const { days, dayUnits } = run.snapshot;
      const printed = new Set(Object.entries(days).filter(([file]) => file.endsWith(".day.json"))
        .flatMap(([file, text]) => (JSON.parse(text) as { atoms: { family: string; units: string[] }[] }).atoms.flatMap((atom) => atom.units.map((unit) => `${file.slice(0, 10)} ${atom.family} ${unit}`))));
      const recorded = dayUnits.filter((row) => row.shown === 1).map((row) => `${row.day} ${row.family} ${row.unit}`);
      expect(new Set(recorded), name).toEqual(printed);
      expect(recorded.length, name).toBeGreaterThan(0);
    }
    for (const failpoint of FAILPOINTS) expect(killed[failpoint]!.snapshot.dayUnits, failpoint).toEqual(calm.snapshot.dayUnits);
  });

  it("a request is sent beyond the ledger's rule", () => {
    for (const failpoint of FAILPOINTS) {
      const run = killed[failpoint]!.snapshot;
      expect(run.replies, failpoint).toEqual(calm.snapshot.replies);
      for (const [key, attempts] of Object.entries(run.attempts)) expect(attempts, `${failpoint} ${key}`).toEqual(["replied"]);
    }
    expect(calm.snapshot.replies.length).toBeGreaterThan(0);
  });
});

async function live(root: string, source: string, busy: () => boolean, everyMs: number, at: () => number): Promise<{ id: string; ms: number }[]> {
  const latencies: { id: string; ms: number }[] = [];
  const waiting: Promise<void>[] = [];
  for (let index = 0; busy() || index < 20; index++) {
    const now = at();
    const marker = `live ${source} ${index}`;
    const sent = Date.now();
    const id = await ship(root, { source, fetched_ms: now, rows: [{ kind: "note", key: `live-${index}`, content: { text: marker, at: now }, at: now }] });
    const day = join(root, "days", `${new Date(now - 4 * 3_600_000).toISOString().slice(0, 10)}.day.txt`);
    waiting.push(until(`${marker} in its day`, () => existsSync(day) && readFileSync(day, "utf8").includes(marker))
      .then(() => { latencies.push({ id, ms: Date.now() - sent }); }));
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  await Promise.all(waiting);
  return latencies.sort((left, right) => left.ms - right.ms);
}

function percentile(latencies: { ms: number }[], p: number): number {
  return latencies[Math.min(latencies.length - 1, Math.ceil((p / 100) * latencies.length) - 1)]!.ms;
}

describe("backfill vs live: a 100,000-row import beside a device shipping every half second", () => {
  let root: string;
  let latencies: { id: string; ms: number }[] = [];
  let landed = 0;

  it("runs a 100,000-row import while a device ships every half second", async () => {
    root = makeRoot("lifestream-backfill-", { sources: { "apple-notes:local:history": "fake-rows", "apple-notes:local:device-a": "fake-rows" } });
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined });
    try {
      const now = Date.now();
      await ship(root, {
        source: "apple-notes:local:history", fetched_ms: now - 1_000, rows: [],
        facts: { exported_at: new Date(now - 86_400_000).toISOString(), generate: { count: 100_000, start_ms: now - 120 * 86_400_000, step_ms: 103_680, prefix: "history" } },
      });
      const done = () => readHome(root, (db) => (db.prepare("SELECT state FROM deliveries WHERE source = 'apple-notes:local:history'").get() as { state: string } | undefined)?.state) === "imported";
      const backfilling = () => !done() || readHome(root, (db) => (db.prepare("SELECT count(*) AS n FROM jobs WHERE lane = 5 AND state IN ('queued', 'running')").get() as { n: number }).n) > 0;
      latencies = await live(root, "apple-notes:local:device-a", backfilling, 500, () => Date.now());
      await until("the backfill", done);
      landed = readHome(root, (db) => (db.prepare("SELECT count(*) AS n FROM heads WHERE source = 'apple-notes:local:history'").get() as { n: number }).n);
      artifact(root, "backfill-vs-live-latency", { p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: latencies.at(-1)!.ms, deliveries: latencies });
    } finally {
      await home.stop();
    }
  });
  afterAll(() => removeRoot(root));

  it("the backfill is lost or cut short", () => {
    expect(landed).toBe(100_000);
  });

  it("a live delivery reaches its day file later than 20 s p95 during the import", () => {
    expect(latencies.length).toBeGreaterThan(5);
    expect(percentile(latencies, 95)).toBeLessThan(20_000);
  });
});

describe("slow model: 64 calls that each take a long time while deliveries flow", () => {
  let root: string;
  let latencies: { id: string; ms: number }[] = [];
  let inFlight = 0;
  let attempts: Record<string, number> = {};
  const CALL_MS = 20_000;
  const ROOM = fakeTransport().defaults.concurrency;

  it("runs 64 calls that each take a long time, the transport's room full, while a device ships every half second", async () => {
    root = makeRoot("lifestream-slow-model-", { sources: { "apple-notes:local:photos": "fake-rows", "apple-notes:local:device-a": "fake-rows" }, fake: { delay_ms: CALL_MS } });
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined });
    try {
      const now = Date.now();
      const photos = Array.from({ length: 64 }, (_, index) => {
        const at = now - 60_000 + index * 100;
        return { kind: "note", key: `photo-${index}`, content: { text: `photo ${index}`, at, photo: true }, at };
      });
      await ship(root, { source: "apple-notes:local:photos", fetched_ms: now - 30_000, rows: photos });
      await until(`the transport's ${ROOM} calls in flight`, () => (readLedger(root, (db) =>
        (db.prepare("SELECT count(*) AS n FROM attempts WHERE state = 'sending'").get() as { n: number }).n) ?? 0) === ROOM);
      const sendingAt = Date.now();
      latencies = await live(root, "apple-notes:local:device-a", () => Date.now() - sendingAt < CALL_MS * 0.6, 500, () => Date.now());
      inFlight = readLedger(root, (db) => (db.prepare("SELECT count(*) AS n FROM attempts WHERE state = 'sending'").get() as { n: number }).n) ?? 0;
      await until("every caption", () => readHome(root, (db) =>
        (db.prepare("SELECT count(*) AS n FROM enrichments WHERE family = 'notes' AND state = 'done'").get() as { n: number }).n) === 64);
      attempts = Object.fromEntries((readLedger(root, (db) => db.prepare("SELECT key, count(*) AS n FROM attempts GROUP BY key").all()) as { key: string; n: number }[])
        .map((row) => [row.key, row.n]));
      artifact(root, "slow-model-latency", { calls: 64, call_ms: CALL_MS, in_flight_while_measured: inFlight, p50: percentile(latencies, 50), p95: percentile(latencies, 95), deliveries: latencies });
    } finally {
      await home.stop();
    }
  });
  afterAll(() => removeRoot(root));

  it("imports, extracts or days miss their targets while the calls run", () => {
    expect(inFlight).toBeGreaterThan(0);
    expect(percentile(latencies, 95)).toBeLessThan(20_000);
  });

  it("a call is sent twice, or a reply never lands", () => {
    expect(Object.keys(attempts)).toHaveLength(64);
    expect(Object.values(attempts).every((count) => count === 1)).toBe(true);
  });
});

describe("deploy: SIGTERM in the middle of a backfill", () => {
  let root: string;
  const home = () => new ChildHome(root);
  let first: ChildHome;
  let stopMs = 0;
  let exitCode: number | null = null;
  let progressAtStop = 0;
  let shipped: string[] = [];
  let snapshot: { imported: number; heads: number; runs: { outcome: string; counts: { new: number; duplicated: number } }[]; attempts: number[] } | undefined;

  it("runs a deploy: SIGTERM in the middle of a backfill, a new home after it", async () => {
    root = makeRoot("lifestream-deploy-", { sources: { "apple-notes:local:history": "fake-rows", "apple-notes:local:device-a": "fake-rows" }, fake: { delay_ms: 3_000 } });
    let second: ChildHome | undefined;
    try {
      first = home();
      first.start();
      await first.ready();
      const now = Date.now();
      shipped.push(await ship(root, {
        source: "apple-notes:local:history", fetched_ms: now - 1_000, rows: [],
        facts: { exported_at: new Date(now - 86_400_000).toISOString(), generate: { count: 60_000, start_ms: now - 30 * 86_400_000, step_ms: 43_200, prefix: "history" } },
      }));
      let last = 0;
      const device = async (index: number) => {
        const at = (last = Math.max(Date.now(), last + 1));
        const planned: Planned = { source: "apple-notes:local:device-a", fetched_ms: at, rows: [{ kind: "note", key: `live-${index}`, content: { text: `live ${index}`, at, ...(index % 3 === 0 ? { photo: true } : {}) }, at }] };
        shipped.push(await ship(root, planned));
      };
      let index = 0;
      await until("the backfill under way", () => {
        const progress = readHome(root, (db) => (db.prepare("SELECT progress FROM jobs WHERE kind = 'import' AND key = 'apple-notes:local:history'").get() as { progress: string | null } | undefined)?.progress);
        return progress !== null && progress !== undefined && (JSON.parse(progress) as { counts: { new: number } }).counts.new > 5_000;
      });
      for (; index < 6; index++) await device(index);
      const stopping = Date.now();
      const exit = await first.stop();
      stopMs = Date.now() - stopping;
      exitCode = exit.code;
      progressAtStop = readHome(root, (db) => {
        const row = db.prepare("SELECT progress FROM jobs WHERE kind = 'import' AND key = 'apple-notes:local:history'").get() as { progress: string | null };
        return row.progress === null ? 0 : (JSON.parse(row.progress) as { counts: { new: number } }).counts.new;
      });
      for (; index < 9; index++) await device(index);
      second = home();
      second.start();
      await second.ready();
      for (; index < 12; index++) await device(index);
      await until("a settled home", () => settled(root, shipped.length));
      await second.stop();
      snapshot = readHome(root, (db) => {
        const runs = db.prepare("SELECT outcome, counts FROM runs WHERE kind = 'import' AND subject LIKE 'apple-notes:local:history %' ORDER BY id").all() as { outcome: string; counts: string }[];
        return {
          imported: (db.prepare("SELECT count(*) AS n FROM deliveries WHERE state = 'imported'").get() as { n: number }).n,
          heads: (db.prepare("SELECT count(*) AS n FROM heads WHERE source = 'apple-notes:local:history'").get() as { n: number }).n,
          runs: runs.map((run) => ({ outcome: run.outcome, counts: JSON.parse(run.counts) as { new: number; duplicated: number } })),
          attempts: [],
        };
      });
      snapshot.attempts = (readLedger(root, (db) => db.prepare("SELECT count(*) AS n FROM attempts GROUP BY key").all()) as { n: number }[]).map((row) => row.n);
      artifact(root, "deploy", { stop_ms: stopMs, exit_code: exitCode, progress_at_stop: progressAtStop, shipped: shipped.length, ...snapshot });
    } finally {
      first?.kill();
      second?.kill();
    }
  });
  afterAll(() => removeRoot(root));

  it("the home does not stop promptly on SIGTERM", () => {
    expect(exitCode).toBe(0);
    expect(stopMs).toBeLessThan(5_000);
  });

  it("a sealed delivery is not imported", () => {
    expect(snapshot!.imported).toBe(shipped.length);
    expect(snapshot!.heads).toBe(60_000);
  });

  it("the import's run is split, or a row landed before the stop counts new twice", () => {
    expect(progressAtStop).toBeGreaterThan(0);
    expect(snapshot!.runs).toHaveLength(1);
    expect(snapshot!.runs[0]).toMatchObject({ outcome: "ok", counts: { new: 60_000, duplicated: progressAtStop } });
  });

  it("a call is sent twice", () => {
    expect(snapshot!.attempts.length).toBeGreaterThan(0);
    expect(snapshot!.attempts.every((count) => count === 1)).toBe(true);
  });
});

