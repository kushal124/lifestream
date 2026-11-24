import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { startHome, type Home } from "./home.js";
import { runCli } from "./cli.js";
import { homeSecrets, openHomeFolder } from "@lifestreamprotocol/core";
import { askHome } from "./socket.js";
import { artifact, FAKES, hex, makeRoot, makeVault, readHome, removeRoot, settled, steppedClock, TICK_MS, until } from "./test/harness-root.js";
import { ship, shipFiles } from "./test/harness-deliveries.js";
import { doorHere } from "./test/harness-door.js";
import { mintPrincipal } from "./principals.js";
import { acquisitionBundle, DEVICE } from "./test/support.js";
import { MAC_SOURCE, stated, value } from "./test/through.js";
import { keptKey, waitingKey } from "./through.js";
import { QUIET_DONE } from "./quiet.js";
import { testSocket } from "./test/folder.js";


const MINUTE = 60_000;


const TURNS = /^(?:tick|take and begin|queued commit|truncate|people act|helper \S+|line \S+|request \S+)$/u;

describe("a writer pause over the mark", () => {
  it("is logged naming no one, or not at all, or twice for one commit; a turn without its CPU, or the tick without its parts", async () => {
    const source = "apple-notes:local:device-a";
    const root = makeRoot("lifestream-slow-commit-", { sources: { [source]: "fake-rows" } });
    onTestFinished(() => removeRoot(root));
    const logs: string[] = [];
    const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: FAKES, log: (line) => logs.push(line), slowMs: -1 });
    onTestFinished(() => home.stop());
    const at = Date.now() - MINUTE;
    const id = await ship(root, { source, fetched_ms: at, rows: [{ kind: "note", key: "n1", content: { text: "a note", at }, at }] });
    await until("the delivery imported", () => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(id)) === "imported");
    const lines = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
    const slow = lines.filter((line) => line.slow !== undefined);
    expect(slow.every((line) => typeof line.slow === "number" && typeof line.of === "string" && typeof line.cpu_ms === "number")).toBe(true);
    const named = slow.map((line) => line.of as string);
    expect(named).toEqual(expect.arrayContaining(["start", "take", `begin import ${source}`, `import ${source} chunk`, `import ${source} done`]));
    expect(named).toEqual(expect.arrayContaining(["tick", "tick commit", "take and begin", "queued commit", "helper chunk", "helper done"]));
    expect(named.filter((of) => of === `import ${source} done`)).toHaveLength(1);
    const commits = slow.filter((line) => !TURNS.test(line.of as string));
    const parts = (line: Record<string, unknown>) => [typeof line.work_ms, typeof line.due_ms, typeof line.commit_ms];
    expect(commits.map(parts)).toEqual(commits.map(() => ["number", "number", "number"]));
    const tick = slow.find((line) => line.of === "tick")!;
    expect([tick.hold_ms, tick.controls_ms, tick.pick_ms, tick.checkpoint_ms].map((ms) => typeof ms)).toEqual(["number", "number", "number", "number"]);
    const started = lines.filter((line) => line.start !== undefined);
    expect(started).toEqual([{
      at: expect.any(String),
      start: {
        ms: expect.any(Number), read_days_ms: expect.any(Number), recover_ms: expect.any(Number), interrupt_ms: expect.any(Number), revive_ms: expect.any(Number),
        forget_ms: expect.any(Number), tally_ms: expect.any(Number), held_ms: expect.any(Number), left_ms: expect.any(Number), stored_ms: expect.any(Number), prompts_ms: expect.any(Number),
        models_ms: expect.any(Number), fingerprints_ms: expect.any(Number), put_back_ms: expect.any(Number), list_ms: expect.any(Number),
        starts_ms: expect.any(Number), consumers_ms: expect.any(Number), imports_ms: expect.any(Number), asks_ms: expect.any(Number), prune_ms: expect.any(Number),
      },
      days: { listed: 0, changed: 0, unread: 0 },
    }]);
    artifact(root, "slow-commit", { named, slow, started });
  });

  it("is not logged when the commit throws; its request logs no line, or two", async () => {
    const root = makeRoot("lifestream-slow-failed-", { sources: {} });
    onTestFinished(() => removeRoot(root));
    const logs: string[] = [];
    const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: FAKES, log: (line) => logs.push(line), slowMs: -1 });
    onTestFinished(() => home.stop());
    const answer = await askHome(testSocket(root), "drop", ["job", "extract", "nosuch"]).then(() => "answered", (error: Error) => error.message);
    expect(answer).toMatch(/no job extract nosuch/u);
    const dropped = logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.slow !== undefined && line.of === "verb drop");
    expect(dropped).toEqual([{ at: expect.any(String), slow: expect.any(Number), of: "verb drop", cpu_ms: expect.any(Number), work_ms: expect.any(Number), failed: true }]);
    const asked = logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.request === "drop");
    expect(asked).toEqual([{
      at: expect.any(String), request: "drop", queued_ms: expect.any(Number), ran_ms: expect.any(Number), cpu_ms: expect.any(Number), answer: "error",
    }]);
  });

  it("names no part when `Due.after` throws, or names the COMMIT it never reached", async () => {
    const source = "apple-notes:local:device-a";
    const fails = join(mkdtempSync(join(tmpdir(), "lifestream-broken-label-")), "fails");
    onTestFinished(() => rmSync(dirname(fails), { recursive: true, force: true }));
    const root = makeRoot("lifestream-slow-due-", { sources: { [source]: "fake-rows" }, settings: { "connectors.fake-label": { fails } } });
    onTestFinished(() => removeRoot(root));
    const logs: string[] = [];
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: (line) => logs.push(line), slowMs: -1, tickMs: TICK_MS });
    onTestFinished(() => home.stop());
    await until("the start's work done", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE state NOT IN ('done', 'dead')").pluck().get()) === 0);
    writeFileSync(fails, "");
    const at = Date.now() - MINUTE;
    await ship(root, { source, fetched_ms: at, rows: [{ kind: "note", key: "n1", content: { text: "a note", at }, at }] });
    const failed = () => logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.slow !== undefined && line.failed === true);
    await until("a commit that threw in Due.after", () => failed().some((line) => line.due_ms !== undefined));
    rmSync(fails);
    const line = failed().find((each) => each.due_ms !== undefined)!;
    expect(line).toEqual({ at: expect.any(String), slow: expect.any(Number), of: expect.any(String), cpu_ms: expect.any(Number), work_ms: expect.any(Number), due_ms: expect.any(Number), failed: true });
    artifact(root, "slow-due", { line });
  });

  it("loses the parts of a start that threw, or names parts it never entered", async () => {
    const fails = join(mkdtempSync(join(tmpdir(), "lifestream-broken-start-")), "fails");
    onTestFinished(() => rmSync(dirname(fails), { recursive: true, force: true }));
    writeFileSync(fails, "");
    const root = makeRoot("lifestream-start-failed-", { sources: {}, settings: { "connectors.fake-label": { fails } } });
    onTestFinished(() => removeRoot(root));
    const logs: string[] = [];
    await expect(startHome(root, { stopGraceMs: 50, registry: FAKES, log: (line) => logs.push(line), tickMs: TICK_MS })).rejects.toThrow("a synthetic broken labeler");
    const started = logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.start !== undefined);
    expect(started).toEqual([{ at: expect.any(String), start: { ms: expect.any(Number), read_days_ms: expect.any(Number), recover_ms: expect.any(Number), interrupt_ms: expect.any(Number), revive_ms: expect.any(Number), forget_ms: expect.any(Number), tally_ms: expect.any(Number), held_ms: expect.any(Number), left_ms: expect.any(Number), stored_ms: expect.any(Number), prompts_ms: expect.any(Number), models_ms: expect.any(Number), fingerprints_ms: expect.any(Number), failed: true } }]);
    artifact(root, "start-failed", { started });
  });
});

describe("the quiet rows' job", () => {
  it("is queued again at a start after a walk that left no quiet row", async () => {
    const root = makeRoot("lifestream-quiet-done-", { sources: { "apple-notes:local:device-a": "fake-rows" } });
    onTestFinished(() => removeRoot(root));
    let now = Date.UTC(2026, 9, 3, 10);
    const done = () => readHome(root, (db) => db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(QUIET_DONE)) as string | undefined;
    const queued = (since: number) => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE kind = 'quiet' AND (state <> 'done' OR started_ms >= ?)").pluck().get(since)) as number;
    const first = await startHome(root, { stopGraceMs: 50, registry: FAKES, clock: () => now, log: () => undefined, tickMs: TICK_MS });
    await until("the first start's walk of the quiet rows", () => done() !== undefined);
    await first.stop();
    now += MINUTE;
    const second = await startHome(root, { stopGraceMs: 50, registry: FAKES, clock: () => now, log: () => undefined, tickMs: TICK_MS });
    onTestFinished(() => second.stop());
    expect(queued(now)).toBe(0);
    artifact(root, "quiet-done", { done: done() });
  });
});

describe("quiet hour: clocks off, nothing due, an hour passes", () => {
  let root: string;
  let home: Home;
  const start = Date.UTC(2026, 9, 3, 10, 0, 0);
  let now = start;
  let settledJobs = 0;
  let runs: unknown[] = [];
  let jobsStarted: unknown[] = [];

  beforeAll(async () => {
    root = makeRoot("lifestream-quiet-", { sources: { "apple-notes:local:device-a": "fake-rows" } });
    home = await startHome(root, { stopGraceMs: 50, registry: FAKES, clock: () => now, log: () => undefined, tickMs: TICK_MS });
    await until("the start-up index", () => readHome(root, (db) => db.prepare("SELECT count(*) AS n FROM jobs WHERE state <> 'done'").get() as { n: number }).n === 0);
    settledJobs = home.stats().jobs;
    const started = readHome(root, (db) => db.prepare("SELECT coalesce(max(id), 0) FROM runs").pluck().get() as number);
    now = start + 60 * MINUTE;
    await until("a tick at the end of the hour", () => home.stats().ticks.at_ms === now);
    runs = readHome(root, (db) => db.prepare("SELECT * FROM runs WHERE id > ?").all(started));
    jobsStarted = readHome(root, (db) => db.prepare("SELECT kind, key, started_ms FROM jobs WHERE started_ms > ?").all(start));
    artifact(root, "quiet-hour-runs", runs);
  });

  afterAll(async () => {
    await home?.stop();
    removeRoot(root);
  });

  it("a job starts", () => {
    expect(home.stats().jobs).toBe(settledJobs);
    expect(jobsStarted).toEqual([]);
  });

  it("a run is written", () => {
    expect(runs).toEqual([]);
  });

  it("a process starts", () => {
    expect(home.stats().calls).toBe(0);
  });

  it("a second home starts on the same root, or exits rather than waiting for its lock", async () => {
    const logs: string[] = [];
    const ending = new AbortController();
    const second = startHome(root, { stopGraceMs: 50, registry: FAKES, log: (line) => logs.push(line), tickMs: TICK_MS, lookMs: 50, signal: ending.signal });
    await until("the second start waits", () => logs.length > 0);
    expect(logs.map((line) => JSON.parse(line) as Record<string, unknown>)).toEqual([{ at: expect.any(String), home: "waiting", why: "a move or a verb holds the home: it starts when that ends" }]);
    ending.abort();
    await expect(second).rejects.toThrow();
  });

  it("the operator socket answers anyone but its owner", async () => {
    const { mode } = await import("node:fs").then((fs) => fs.statSync(testSocket(root).path));
    expect(mode & 0o077).toBe(0);
    await expect(askHome(testSocket(root), "pause", ["kind:repair", "--reason", "a test"])).resolves.toEqual({ paused: "kind:repair", by: "terminal" });
    expect(readHome(root, (db) => db.prepare("SELECT target, reason FROM controls").all())).toEqual([{ target: "kind:repair", reason: "a test" }]);
    await expect(askHome(testSocket(root), "resume", ["kind:repair"])).resolves.toEqual({ resumed: "kind:repair" });
    await expect(askHome(testSocket(root), "no-such-verb")).rejects.toThrow(/no verb is named no-such-verb/u);
  });

  it("the CLI waits on after the home answered its verb", async () => {
    const lines: string[] = [];
    expect(await runCli(["pause", "kind:repair", "--reason", "a test", "--root", root], { write: (text) => lines.push(text) })).toBe(0);
    expect(lines.join("")).toContain('{"paused":"kind:repair","by":"terminal"}');
    expect(await runCli(["resume", "kind:repair", "--root", root], { write: () => undefined })).toBe(0);
  });
});

describe("a quiet source's read-through, stated in its Mac's exchange", () => {
  it("moves by the exchange alone, never past a delivery the door sealed and the home has not read, and to the newer value once that delivery imports", async () => {
    const root = makeRoot("lifestream-stated-through-", { sources: { [MAC_SOURCE]: "fake-rows" } });
    onTestFinished(() => removeRoot(root));
    const { token } = mintPrincipal(openHomeFolder(root), { unit: "macbook-pro-0001", kind: "mac", scopes: ["deliver"], sources: [MAC_SOURCE], now_ms: Date.now() });
    const headers = { authorization: `Bearer ${token}`, ...DEVICE.mac };
    const front = await doorHere(root);
    onTestFinished(() => front.stop());
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined, tickMs: TICK_MS });
    onTestFinished(() => home.stop());
    const exchange = async (body: object) => (await fetch(`${front.url}/v1/exchange`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) })).status;
    const held = () => readHome(root, (db) => ({
      read_through_ms: db.prepare("SELECT read_through_ms FROM sources WHERE id = ?").pluck().get(MAC_SOURCE) as number | null,
      kept: JSON.parse((db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(keptKey(MAC_SOURCE)) as string | undefined) ?? "null") as unknown,
      waiting: JSON.parse((db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(waitingKey(MAC_SOURCE)) as string | undefined) ?? "null") as unknown,
      deliveries: db.prepare("SELECT state FROM deliveries WHERE source = ? ORDER BY sealed_ms").pluck().all(MAC_SOURCE) as string[],
    }));
    const base = Date.now() - 30 * MINUTE;

    const quiet = value(base, base + MINUTE);
    expect(await exchange({ through: { [MAC_SOURCE]: stated(quiet) } })).toBe(200);
    await until("the stated read-through applied", () => held().read_through_ms === quiet.read_through_ms);
    const moved = held();
    expect(moved).toMatchObject({ waiting: null, deliveries: [], kept: { applied: { read_through_ms: quiet.read_through_ms, stated_ms: quiet.stated_ms } } });

    expect(await askHome(testSocket(root), "pause", ["kind:import", "--reason", "a test"])).toBeDefined();
    const rows = Buffer.from(`${JSON.stringify({ kind: "frame", key: "frame-1", content: { at: base + 2 * MINUTE }, at: base + 2 * MINUTE })}\n`);
    const bundle = acquisitionBundle({ source: MAC_SOURCE, fetched_ms: base + 3 * MINUTE, files: [["rows.ndjson", rows]], custody: { [MAC_SOURCE]: { seal: 1 } } });
    expect((await fetch(`${front.url}${bundle.path}`, { method: "PUT", headers, body: bundle.bytes })).status).toBe(201);
    await until("the delivery indexed and waiting", () => held().deliveries.length === 1);
    const newer = value(base + 4 * MINUTE, base + 5 * MINUTE);
    expect(await exchange({ through: { [MAC_SOURCE]: stated(newer) } })).toBe(200);
    await until("the newer value kept", () => held().waiting !== null);
    const waiting = held();
    expect(waiting).toMatchObject({ read_through_ms: quiet.read_through_ms, waiting: { value: newer }, deliveries: ["sealed"] });

    expect(await askHome(testSocket(root), "resume", ["kind:import"])).toBeDefined();
    await until("the kept value applied as the delivery imported", () => held().read_through_ms === newer.read_through_ms);
    const applied = held();
    expect(applied).toMatchObject({ waiting: null, deliveries: ["imported"], kept: { applied: { read_through_ms: newer.read_through_ms, stated_ms: newer.stated_ms } } });
    artifact(root, "stated-through", { moved, waiting, applied });
  });
});

describe("a stated read-through: a screen-like sitting and its sources' read-through", () => {
  it("a sitting closes before its sources are read past its gap, or stays open after its Mac's exchange states read-through past it", async () => {
    const root = makeRoot("lifestream-sitting-", { sources: { [MAC_SOURCE]: "fake-rows" } });
    onTestFinished(() => removeRoot(root));
    const { token } = mintPrincipal(openHomeFolder(root), { unit: "macbook-pro-0001", kind: "mac", scopes: ["deliver"], sources: [MAC_SOURCE], now_ms: Date.now() });
    const front = await doorHere(root);
    onTestFinished(() => front.stop());
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined, tickMs: TICK_MS });
    onTestFinished(() => home.stop());
    const t0 = Date.now() - 2 * MINUTE;
    const frames = [t0 - 240_000, t0 - 120_000, t0].map((at, index) => ({ kind: "frame", key: `frame-${index}`, content: { at }, at }));
    const id = await ship(root, { source: MAC_SOURCE, fetched_ms: t0, rows: frames });
    expect(id).toContain(`${MAC_SOURCE}/`);
    await until("the frames' sitting", () => readHome(root, (db) =>
      db.prepare("SELECT count(*) AS n FROM extracts WHERE family = 'screen'").get() as { n: number }).n === 1);
    await until("the frames' day", () => existsSync(join(root, "days")));
    const closed = () => readHome(root, (db) => (JSON.parse((db.prepare("SELECT content FROM extracts WHERE family = 'screen'").get() as { content: string }).content) as { closed: boolean }).closed);
    const before = { closed: closed(), enrichments: readHome(root, (db) => (db.prepare("SELECT count(*) AS n FROM enrichments").get() as { n: number }).n) };
    expect(before).toEqual({ closed: false, enrichments: 0 });

    const through = { [MAC_SOURCE]: stated(value(t0 + 301_000, t0 + 330_000)) };
    const answer = await fetch(`${front.url}/v1/exchange`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, ...DEVICE.mac, "content-type": "application/json" }, body: JSON.stringify({ through }),
    });
    expect(answer.status).toBe(200);
    await until("the sitting's account", () => readHome(root, (db) =>
      db.prepare("SELECT count(*) AS n FROM enrichments WHERE family = 'screen' AND state = 'done'").get() as { n: number }).n === 1);
    const dayFile = join(root, "days", `${new Date(t0 - 4 * 3_600_000).toISOString().slice(0, 10)}.day.txt`);
    await until("the account in its day", () => existsSync(dayFile) && readFileSync(dayFile, "utf8").includes("3 frames: fake reply"));
    const sitting = readHome(root, (db) => db.prepare("SELECT * FROM enrichments WHERE family = 'screen'").get() as Record<string, unknown>);
    artifact(root, "stated-sitting-enrichment", { before, sitting });
    expect(sitting).toMatchObject({ family: "screen", state: "done", item: expect.stringMatching(/^macbook-pro-0001\//u) });
    expect(closed()).toBe(true);
  });
});

describe("polls: the clocks on, a provider polled every second", () => {
  let root: string;
  let home: Home;
  let states: number[] = [];
  let keys: unknown[] = [];
  let landed = 0;
  let token = "";
  let rotated = 0;

  beforeAll(async () => {
    root = makeRoot("lifestream-polls-", { sources: { "apple-notes:local:poll": "fake-rows" }, clocks: true, settings: { "connectors.fake-poll": { refresh: "1s", rotates: true } } });
    const clock = steppedClock(root, "fake-poll", 1_000);
    const log = (line: string) => {
      const entry = JSON.parse(line) as { secret?: string; op?: string; ok?: boolean };
      if (entry.secret === "fake-poll" && entry.op === "rotate" && entry.ok === true) rotated += 1;
    };
    home = await startHome(root, { stopGraceMs: 50, registry: FAKES, clock: clock.now, slot: null, log, tickMs: TICK_MS });
    const vaultKey = await makeVault(root);
    await clock.stepUntil("three polls imported", () => readHome(root, (db) =>
      (db.prepare("SELECT count(*) AS n FROM deliveries WHERE source = 'apple-notes:local:poll' AND state = 'imported'").get() as { n: number }).n) >= 3);
    await home.stop();
    keys = readHome(root, (db) => db.prepare("SELECT key FROM heads WHERE source = 'apple-notes:local:poll' ORDER BY key").pluck().all());
    landed = readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE source = 'apple-notes:local:poll'").pluck().get() as number);
    const polls = readHome(root, (db) => db.prepare("SELECT state FROM poll_cursors WHERE acquirer = 'fake-poll'").get() as { state: string });
    states = [(JSON.parse(polls.state) as { cursor: number }).cursor];
    token = homeSecrets(join(root, "config", "secrets"), { key: vaultKey }).get("fake-poll")!;
    artifact(root, "polls", { keys, polls, token, rotated });
  });

  afterAll(() => removeRoot(root));

  it("a poll's delivery is never imported", () => {
    expect(keys.length).toBeGreaterThanOrEqual(3);
    expect(keys.slice(0, 3)).toEqual(["poll-0", "poll-1", "poll-2"]);
  });

  it("a provider cursor goes backward, or skips", () => {
    expect(states[0]).toBe(landed);
    expect(keys.length).toBeLessThanOrEqual(landed);
  });

  it("a rotated secret is lost", () => {
    expect([states[0], states[0]! + 1]).toContain(rotated);
    expect(token).toBe(`synthetic-token-${rotated}`);
  });
});

describe("late blob: a record names a blob a later delivery brings", () => {
  let root: string;
  let home: Home;
  const t0 = Date.now() - 2 * MINUTE;
  const segment = Buffer.from("synthetic text segment of frame 0");
  const blob = `sha256:${hex(segment)}`;
  let before: number | undefined;
  let after: number | undefined;

  beforeAll(async () => {
    root = makeRoot("lifestream-late-blob-", { sources: { "screen:local:mac-bb07": "fake-rows" } });
    home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined, tickMs: TICK_MS });
    const missing = () => readHome(root, (db) => (db.prepare("SELECT content FROM extracts WHERE family = 'screen'").get() as { content: string } | undefined)?.content);
    await ship(root, { source: "screen:local:mac-bb07", fetched_ms: t0, rows: [{ kind: "frame", key: "frame-0", content: { at: t0 - 1_000, blob }, at: t0 - 1_000, blobs: [blob] }] });
    await until("the sitting", () => missing() !== undefined);
    before = (JSON.parse(missing()!) as { missing: number }).missing;
    await shipFiles(root, "screen:local:mac-bb07", t0 + 30_000, { "segments/frame-0.txt": segment });
    await until("the sitting read again", () => (JSON.parse(missing()!) as { missing: number }).missing === 0);
    after = 0;
    artifact(root, "late-blob-sitting", JSON.parse(missing()!));
  });

  afterAll(async () => {
    await home?.stop();
    removeRoot(root);
  });

  it("a row naming a blob the home lacks is refused, or fails its import", () => {
    expect(before).toBe(1);
    expect(readHome(root, (db) => db.prepare("SELECT state FROM deliveries ORDER BY id").pluck().all())).toEqual(["imported", "imported"]);
  });

  it("a record whose blob arrives after it is never looked at again", () => {
    expect(after).toBe(0);
  });
});

describe("late blob behind a late statement: the record's blob arrives while the extract is paused, after an older statement of it", () => {
  let root: string;
  let home: Home;
  const t0 = Date.now() - 2 * MINUTE;
  const segment = Buffer.from("synthetic text segment of frame 0, behind a late statement");
  const blob = `sha256:${hex(segment)}`;
  let missing: { before?: number; after?: number } = {};

  beforeAll(async () => {
    root = makeRoot("lifestream-late-blob-late-", { sources: { "screen:local:mac-bb07": "fake-rows" } });
    home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined, tickMs: TICK_MS });
    const sock = testSocket(root);
    const sitting = () => readHome(root, (db) => (db.prepare("SELECT content FROM extracts WHERE family = 'screen'").pluck().get() as string | undefined));
    const frame = (stated: number, note: string) => ship(root, { source: "screen:local:mac-bb07", fetched_ms: stated, rows: [{ kind: "frame", key: "frame-0", content: { at: t0 - 10 * MINUTE, blob, note }, at: t0 - 10 * MINUTE, blobs: [blob] }] });
    await frame(t0, "as captured");
    await until("the sitting, every walk published", () => sitting() !== undefined &&
      readHome(root, (db) => db.prepare("SELECT count(*) FROM cursors WHERE name LIKE 'rebuild:%' AND seq > 0").pluck().get()) === 0);
    missing.before = (JSON.parse(sitting()!) as { missing: number }).missing;
    await askHome(sock, "pause", ["kind:extract", "--reason", "the test lands a late statement and the blob first"]);
    await frame(t0 - 30_000, "an older copy");
    await shipFiles(root, "screen:local:mac-bb07", t0 + 30_000, { "segments/frame-0.txt": segment });
    await until("both imported, the blob's reread recorded", () => readHome(root, (db) =>
      db.prepare("SELECT count(*) FROM deliveries WHERE state = 'imported'").pluck().get() === 3 && db.prepare("SELECT count(*) FROM rereads").pluck().get() === 1));
    await askHome(sock, "resume", ["kind:extract"]);
    await until("the extract caught up with the statements and the rereads", () => readHome(root, (db) => {
      const cursor = db.prepare("SELECT seq, reread FROM cursors WHERE name = 'extract:screen'").get() as { seq: number; reread: number };
      return db.prepare("SELECT state FROM jobs WHERE kind = 'extract' AND key = 'screen'").pluck().get() === "done" &&
        cursor.seq === db.prepare("SELECT max(seq) FROM statements").pluck().get() && cursor.reread >= (db.prepare("SELECT coalesce(max(seq), 0) FROM rereads").pluck().get() as number);
    }));
    missing.after = (JSON.parse(sitting()!) as { missing: number }).missing;
    await until("the sitting's account landed, no call in flight", () => settled(root, 3));
    artifact(root, "late-blob-late-statement", {
      missing, sitting: JSON.parse(sitting()!),
      statements: readHome(root, (db) => db.prepare("SELECT seq, key, stated_ms, late, run FROM statements ORDER BY seq").all()),
      runs: readHome(root, (db) => db.prepare("SELECT kind, subject, counts FROM runs ORDER BY id").all()),
    });
  });

  afterAll(async () => {
    await home?.stop();
    removeRoot(root);
  });

  it("the late statement swallows the blob's reread, and the sitting never learns the blob arrived", () => {
    expect(missing.before).toBe(1);
    expect(missing.after).toBe(0);
  });
});
