import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, civilDay, CURSOR_BYTES, openHome, openHomeFolder, type HomeDb, type JobRow, type JsonObject } from "@lifestreamprotocol/core";
import { NotYet, type Acquirer, type Lent } from "@lifestreamprotocol/connect";
import { afterAll, describe, expect, it } from "vitest";
import { startHome } from "./home.js";
import { parkPoll, pollKind, queuedFor, unparkPoll } from "./import.js";
import type { HelperEnv, Main } from "./jobs.js";
import { effective } from "./settings.js";
import { askHome } from "./socket.js";
import { FAKE_CONNECTORS } from "./test/fakes.js";
import { artifact, FAKES, makeRoot, OWN_SOURCES, readHome, removeRoot, steppedClock, TICK_MS, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { doorHere } from "./test/harness-door.js";
import { statusOf } from "./test/harness-status.js";
import { editSettings, testSocket } from "./test/folder.js";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) removeRoot(root);
});

const count = (root: string, sql: string, ...params: unknown[]): number => readHome(root, (db) => db.prepare(sql).pluck().get(...params) as number);

const MAILBOX = "gmail:person-a@example.com:cloud";
const CLOCK_FAKES = fileURLToPath(new URL("./test/clock-fakes.ts", import.meta.url));

describe("a poll's deliveries in a running home", () => {
  it("keeps the cursor a poll gave while it waited on the person, and makes the sources a delivery states on its lane", async () => {
    const stated = "apple-notes:local:stated-a";
    const root = makeRoot("lifestream-polls-", { sources: {}, clocks: true, settings: { "connectors.fake-poll": { refresh: "2s", needs_first: true, states: [stated] } } });
    roots.push(root);
    const clock = steppedClock(root, "fake-poll", 2_000);
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, clock: clock.now, log: () => undefined, tickMs: TICK_MS });
    try {
      const sock = testSocket(root);
      const poll = () => readHome(root, (db) => db.prepare("SELECT c.state, a.outcome, a.reason, a.detail, a.source FROM poll_cursors c JOIN attempts a ON a.target = 'fetch:' || c.acquirer WHERE c.acquirer = 'fake-poll' ORDER BY a.at_ms DESC LIMIT 1").get()) as
        { state: string; outcome: string; reason: string | null; detail: string | null; source: string } | undefined;
      await until("the poll waited on the person", () => poll()?.outcome === "need");
      expect(poll()).toMatchObject({ reason: "confirm", detail: "confirm it's you to the synthetic provider", source: "" });
      expect(JSON.parse(poll()!.state)).toEqual({ cursor: 0, needed: true });
      const needs = (statusOf(root, { now_ms: clock.now() }) as { needs: { id: string; state: string; words: string }[] }).needs.filter((need) => need.id === "fetch:fake-poll");
      expect(needs.map((need) => [need.state, need.words])).toEqual([["needs-you", "Confirm it's you"]]);
      await clock.nextTurn();
      await until("the stated source imported the delivery", () => count(root, "SELECT count(*) FROM deliveries WHERE source = ? AND state = 'imported'", stated) >= 1);
      const made = readHome(root, (db) => db.prepare("SELECT id, connector, options FROM sources WHERE id = ?").get(stated)) as { id: string; connector: string; options: string };
      expect({ ...made, options: JSON.parse(made.options) }).toEqual({ id: stated, connector: "fake-rows", options: { lane: "apple-notes:local:poll" } });
      expect(count(root, "SELECT count(*) FROM heads WHERE source = ?", stated)).toBeGreaterThan(0);
      expect(readHome(root, (db) => db.prepare("SELECT source, outcome FROM attempts WHERE target = 'fetch:fake-poll' ORDER BY source").all())).toEqual([{ source: stated, outcome: "ok" }]);
      artifact(root, "polls-polls", { poll: poll(), needs, made });
    } finally {
      await home.stop();
    }
  });

  it("lands a poll's own source only once someone adds it, or leaves a delivery sealed before its poll ended unrouted", async () => {
    const own = "apple-notes:local:poll";
    const sealed = "apple-notes:local:sealed-a";
    const root = makeRoot("lifestream-polls-own-", { sources: {}, clocks: true, settings: { "connectors.fake-poll": { refresh: "1m", states: [own] } } });
    roots.push(root);
    const at = Date.now() - 5_000;
    const orphan = await ship(root, { source: "apple-notes:local:poll", fetched_ms: at, rows: [{ kind: "note", key: "orphan", content: { text: "synthetic orphan", at }, at }], facts: { sources: [{ id: sealed, connector: "fake-rows" }] } }, false);
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined, tickMs: TICK_MS });
    try {
      await until("the poll's delivery imported into its own source", () => count(root, "SELECT count(*) FROM deliveries WHERE source = ? AND state = 'imported' AND id != ?", own, orphan) >= 1);
      await until("the orphan imported into the source it states", () => count(root, "SELECT count(*) FROM deliveries WHERE source = ? AND id = ? AND state = 'imported'", sealed, orphan) === 1);
      const made = (readHome(root, (db) => db.prepare("SELECT id, connector, options FROM sources ORDER BY id").all()) as { id: string; connector: string; options: string }[])
        .filter((row) => !OWN_SOURCES.includes(row.id));
      expect(made.map((row) => ({ ...row, options: JSON.parse(row.options) }))).toEqual([
        { id: own, connector: "fake-rows", options: {} },
        { id: sealed, connector: "fake-rows", options: { lane: own } },
      ]);
      expect(count(root, "SELECT count(*) FROM heads WHERE source = ? AND key = 'orphan'", sealed)).toBe(1);
      artifact(root, "polls-own", { made });
    } finally {
      await home.stop();
    }
  });

  it("stores only what a record links from a delivery in transit, sweeps it to its text at once, and feeds its receipt to no source added since", async () => {
    const lane = "apple-notes:local:poll";
    const root = makeRoot("lifestream-polls-transit-", { sources: { [lane]: "fake-rows" }, clocks: true, settings: { "connectors.fake-poll": { refresh: "1m", transit: true } } });
    roots.push(root);
    const sock = testSocket(root);
    const imported = (source: string) => count(root, "SELECT count(*) FROM deliveries WHERE source = ? AND state = 'imported'", source);
    const names = () => readdirSync(join(root, "inbox", lane)).filter((entry) => entry !== "blobs").sort();
    const db = openHome(openHomeFolder(root), "migrate");
    db.commit((tx) => tx.tables.meta.set("clock:sweep", civilDay(Date.now(), effective(root).settings.day)));
    db.close();
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined, tickMs: TICK_MS });
    try {
      await until("the transit delivery imported", () => imported(lane) >= 1);
      const [first] = names();
      const directory = join(root, "inbox", lane, first!);
      const blobs = openHomeFolder(root).blobs(join(root, "blobs"), { reading: true });
      const clip = `sha256:${createHash("sha256").update(readFileSync(join(directory, "media", "clip-0.bin"))).digest("hex")}`;
      const rows = `sha256:${createHash("sha256").update(readFileSync(join(directory, "rows.ndjson"))).digest("hex")}`;
      expect({ clip: blobs.has(clip), rows: blobs.has(rows) }).toEqual({ clip: false, rows: false });
      expect(count(root, "SELECT count(*) FROM heads WHERE source = ?", lane)).toBe(1);
      await askHome(sock, "sweep", []);
      await until("the delivery swept to its text", () => {
        try {
          return (JSON.parse(readFileSync(join(directory, "swept.json"), "utf8")) as { done: boolean }).done;
        } catch {
          return false;
        }
      });
      expect({ clip: existsSync(join(directory, "media", "clip-0.bin")), rows: existsSync(join(directory, "rows.ndjson")) }).toEqual({ clip: false, rows: true });
      const receipt = JSON.parse(readFileSync(join(directory, "swept.json"), "utf8")) as { removed: string[]; done: boolean };
      expect(receipt).toMatchObject({ removed: ["media/clip-0.bin"], done: true });
      await askHome(sock, "run", ["poll", "fake-poll"]);
      await until("the second delivery imported", () => imported(lane) >= 2);
      const second = names().find((name) => name !== first)!;
      const spare = "apple-notes:local:spare";
      await askHome(sock, "source", ["add", spare, "--connector", "fake-rows", "--options", JSON.stringify({ lane })]);
      await askHome(sock, "run", ["index-inbox", "inbox"]);
      await until("the added source imported the second delivery", () => imported(spare) === 1);
      const fed = readHome(root, (db) => db.prepare("SELECT id, state FROM deliveries WHERE source = ?").all(spare));
      expect(fed).toEqual([{ id: `${lane}/${second}`, state: "imported" }]);
      artifact(root, "polls-transit", { receipt, fed });
    } finally {
      await home.stop();
    }
  });

  it("polls a lane whose every fed source is off, or stops one that fed a source still on, whichever made the mailbox", async () => {
    const CLAUDE = "claude:00000000-0000-4000-8000-000000000001:cloud";
    const EXPORTS = ["google-calendar:person-a@example.com:export", "youtube:person-a@example.com:export"];
    for (const made of [{}, { [MAILBOX]: "fake-rows" }]) {
      const root = makeRoot("lifestream-polls-off-", { sources: made, clocks: true });
      roots.push(root);
      const tries = { google: join(root, "attempts-google"), claude: join(root, "attempts-claude") };
      editSettings(root, { "connectors.fake-poll": { refresh: "1s", attempts: tries.google, states: [...EXPORTS, MAILBOX] }, "connectors.fake-poll-two": { refresh: "1s", attempts: tries.claude, states: [CLAUDE] } });
      const fetches = (file: string) => (existsSync(file) ? readFileSync(file).length : 0);
      const ended = (key: string, since: number) => count(root, "SELECT count(*) FROM jobs WHERE kind = 'poll' AND key = ? AND state = 'done' AND ended_ms >= ?", key, since) === 1;
      const sock = testSocket(root);
      const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined, tickMs: TICK_MS });
      try {
        await until("both lanes fed their sources", () => [MAILBOX, CLAUDE].every((source) => count(root, "SELECT count(*) FROM deliveries WHERE source = ? AND state = 'imported'", source) >= 1));
        expect(readHome(root, (db) => db.prepare("SELECT options FROM sources WHERE id IN (?, ?)").pluck().all(MAILBOX, CLAUDE))).toEqual(["{}", "{}"]);
        for (const source of [CLAUDE, ...EXPORTS]) await askHome(sock, "connectors", ["off", source]);
        const at = Date.now();
        await askHome(sock, "run", ["poll", "fake-poll-two"]);
        await until("the hand-run Claude poll ended", () => ended("fake-poll-two", at));
        const [claude, google, again] = [fetches(tries.claude), fetches(tries.google), Date.now()];
        await askHome(sock, "run", ["poll", "fake-poll-two"]);
        await until("the many-source lane fetched twice more, and Claude's ran by hand again", () => fetches(tries.google) >= google + 2 && ended("fake-poll-two", again));
        expect(fetches(tries.claude)).toBe(claude);
        await askHome(sock, "connectors", ["off", MAILBOX]);
        const later = Date.now();
        await askHome(sock, "run", ["poll", "fake-poll"]);
        await until("the hand-run many-source poll ended", () => ended("fake-poll", later));
        const [stopped, last] = [fetches(tries.google), Date.now()];
        await askHome(sock, "run", ["poll", "fake-poll"]);
        await until("it ran by hand again", () => ended("fake-poll", last));
        expect(fetches(tries.google)).toBe(stopped);
        artifact(root, "polls-off", { made, fetches: { claude: fetches(tries.claude), google: fetches(tries.google) } });
      } finally {
        await home.stop();
      }
    }
  });
});

type Script = (lent: Lent, state: JsonObject | null) => JsonObject | never;

describe("a poll's cursor and memory at the home's seams", () => {
  const SOURCE = "apple-notes:local:poll";
  const OTHER = "apple-notes:local:poll-b";

  async function run(db: HomeDb, root: string, source: string, script: Script, between?: (tx: Parameters<Parameters<HomeDb["commit"]>[0]>[0]) => void) {
    const seen: { handed: JsonObject | null; listed: string[] } = { handed: null, listed: [] };
    const acquirer: Acquirer = {
      name: "fake-poll", source, secrets: [],
      async fetch(state, _secrets, lent) {
        seen.handed = state;
        seen.listed = lent!.memory.list("seen").map(([key]) => key);
        return { files: [], facts: {}, state: script(lent!, state) };
      },
    };
    const now = Date.now();
    const registry = { connectors: FAKE_CONNECTORS, readers: [{ name: "fake-rows" }], families: [], acquirers: [acquirer], labelers: [], code: "test" };
    const main = { folder: openHomeFolder(root), settings: effective(root).settings, now: () => now, room: "ok", stated: null, ending: 0, registry, log: () => undefined, polled: () => undefined } as unknown as Main;
    const job = { id: 1, kind: "poll", key: "fake-poll", connector: "fake-poll", lane: 1 } as JobRow;
    const begun = db.commit((tx) => {
      unparkPoll(tx, acquirer);
      queuedFor(tx, "fake-poll", ["fetch"]);
      return pollKind.begin!(main, tx, job);
    });
    if (begun === null) throw new Error("the run made no call");
    if (between !== undefined) db.commit(between);
    const env = { folder: openHomeFolder(root), registry, db, secrets: () => ({ get: () => undefined, rotate: () => undefined }), stations: { door: "http://127.0.0.1:9", pass: "none" }, signal: new AbortController().signal } as unknown as HelperEnv;
    const task = { job: 1, kind: "poll", key: "fake-poll", lane: 1, now_ms: now, data: begun.data };
    try {
      const result = (await pollKind.helper(env, task).next()).value as Parameters<typeof pollKind.done>[3];
      db.commit((tx) => pollKind.done(main, tx, { job, state: begun.state }, result));
      return { cursor: begun.data.cursor, ...seen, ended: result.end.outcome };
    } catch (error) {
      db.commit((tx) => pollKind.failed!(main, tx, job, begun.state, (error as Error).message));
      return { cursor: begun.data.cursor, ...seen, ended: "fail", error: (error as Error).message };
    }
  }

  const kept = (db: HomeDb) => db.commit((tx) => ({
    cursor: tx.tables.polls.cursor("fake-poll") ?? null,
    memory: Object.fromEntries(["seen", "listed"].map((part) => [part, tx.tables.polls.rememberedAfter("fake-poll", part, null, 100)])),
    clocks: tx.tables.polls.get("fake-poll") !== undefined,
  }));

  it("hands a call its memory only under its cursor's stamp, commits a call's changes only with the cursor it gave, and writes nothing of a run its route's parking stopped", async () => {
    const root = makeRoot("lifestream-polls-seams-", { sources: { [SOURCE]: "fake-rows", [OTHER]: "fake-rows" }, settings: { "connectors.fake-poll": {} } });
    roots.push(root);
    const db = openHome(openHomeFolder(root), "migrate");
    const calls: unknown[] = [];
    try {
      const fetched = (n: number): Script => (lent) => {
        lent.memory.put("seen", `item-${n}`, n);
        return { n };
      };
      calls.push(await run(db, root, SOURCE, fetched(1)));
      expect(calls.at(-1)).toMatchObject({ cursor: null, handed: null, listed: [], ended: "ok" });
      expect(kept(db)).toEqual({ cursor: { source: SOURCE, state: canonical({ n: 1 }), start_ms: null }, memory: { seen: [["item-1", "1"]], listed: [] }, clocks: true });
      calls.push(await run(db, root, SOURCE, fetched(2)));
      expect(calls.at(-1)).toMatchObject({ cursor: canonical({ n: 1 }), handed: { n: 1 }, listed: ["item-1"] });

      const before = kept(db);
      const marking = (lent: Lent) => lent.memory.put("listed", "page-1", true);
      calls.push(await run(db, root, SOURCE, (lent) => {
        marking(lent);
        throw new NotYet("retrying", "a synthetic wait that carries no cursor");
      }));
      calls.push(await run(db, root, SOURCE, (lent) => {
        marking(lent);
        throw new Error("a synthetic failure");
      }));
      calls.push(await run(db, root, SOURCE, (lent) => {
        marking(lent);
        return { list: "x".repeat(CURSOR_BYTES) };
      }));
      expect(calls.slice(-3).map((call) => (call as { ended: string }).ended)).toEqual(["wait", "fail", "fail"]);
      expect((calls.at(-1) as { error: string }).error).toMatch(/over its bound of 16384/u);
      expect(kept(db)).toEqual(before);

      for (const reason of ["provider-making", "offline"] as const) {
        calls.push(await run(db, root, SOURCE, (lent, state) => {
          lent.memory.put("listed", `by-${reason}`, true);
          throw new NotYet(reason, reason === "offline" ? "fetch failed" : "a synthetic ask", { state: { ...state, [reason]: true } });
        }));
      }
      expect(kept(db)).toEqual({
        cursor: { source: SOURCE, state: canonical({ n: 2, offline: true, "provider-making": true }), start_ms: null },
        memory: { seen: [["item-1", "1"], ["item-2", "2"]], listed: [["by-offline", "true"], ["by-provider-making", "true"]] }, clocks: true,
      });

      const parked = kept(db);
      calls.push(await run(db, root, SOURCE, fetched(3), (tx) => parkPoll(tx, "fake-poll")));
      expect(kept(db)).toEqual({ ...parked, clocks: false });
      expect(readHome(root, (read) => read.prepare("SELECT value FROM meta WHERE key = 'poll-parked:fake-poll'").pluck().get())).toBe(JSON.stringify({ paged_ms: null }));
      calls.push(await run(db, root, SOURCE, fetched(4)));
      expect(calls.at(-1)).toMatchObject({ handed: { n: 2, offline: true, "provider-making": true }, listed: ["item-1", "item-2"] });

      calls.push(await run(db, root, OTHER, fetched(5)));
      expect(calls.at(-1)).toMatchObject({ cursor: null, handed: null, listed: [] });
      expect(kept(db)).toEqual({ cursor: { source: OTHER, state: canonical({ n: 5 }), start_ms: null }, memory: { seen: [["item-5", "5"]], listed: [] }, clocks: true });
      artifact(root, "polls-seams", { calls, kept: kept(db) });
    } finally {
      db.close();
    }
  });

  it("lends each call the home's start and the start its cursor was left under, keeps that start with every cursor a call leaves, and none a call that left no cursor", async () => {
    const root = makeRoot("lifestream-polls-start-", { sources: { [SOURCE]: "fake-rows" }, settings: { "connectors.fake-poll": {} } });
    roots.push(root);
    const db = openHome(openHomeFolder(root), "migrate");
    const lent: [number | null, number | null | undefined][] = [];
    const leaving = (more: JsonObject = {}): Script => (given, state) => {
      lent.push([given.start_ms, given.from_ms]);
      return { ...state, ...more };
    };
    const MAY = Date.UTC(2026, 4, 19);
    const JANUARY = Date.UTC(2026, 0, 1);
    const left = () => kept(db).cursor?.start_ms;
    try {
      await run(db, root, SOURCE, leaving({ n: 1 }));
      expect([lent.at(-1), left()]).toEqual([[null, undefined], null]);
      editSettings(root, { "history.start": "2026-05-19" });
      await run(db, root, SOURCE, leaving({ n: 2 }));
      expect([lent.at(-1), left()]).toEqual([[MAY, null], MAY]);
      await run(db, root, SOURCE, leaving({ n: 3 }));
      expect([lent.at(-1), left()]).toEqual([[MAY, MAY], MAY]);
      editSettings(root, { "history.start": "2026-01-01" });
      await run(db, root, SOURCE, (given, state) => {
        lent.push([given.start_ms, given.from_ms]);
        throw new NotYet("retrying", "a synthetic wait that leaves a cursor", { state: { ...state, n: 4 } });
      });
      expect([lent.at(-1), left()]).toEqual([[JANUARY, MAY], JANUARY]);
      editSettings(root, { "history.start": null });
      await run(db, root, SOURCE, (given) => {
        lent.push([given.start_ms, given.from_ms]);
        throw new Error("a synthetic failure that leaves no cursor");
      });
      expect([lent.at(-1), left(), kept(db).cursor?.state]).toEqual([[null, JANUARY], JANUARY, canonical({ n: 4 })]);
      await run(db, root, SOURCE, leaving());
      expect([lent.at(-1), left()]).toEqual([[null, JANUARY], null]);
      artifact(root, "polls-start", { lent, kept: kept(db) });
    } finally {
      db.close();
    }
  });

  it("goes on past a poisoned cursor everywhere but its own calls, which leave it as it was, and forgets what an acquirer the registry dropped held", async () => {
    const CLOCK = "apple-notes:local:clock";
    const POISON = "{not json, the cursor of no release";
    const root = makeRoot("lifestream-polls-poisoned-", { sources: { [CLOCK]: "fake-rows" }, clocks: true, settings: { "connectors.fake-clock": { refresh: "1m" } } });
    roots.push(root);
    const written = openHome(openHomeFolder(root), "migrate");
    written.commit((tx) => {
      tx.tables.polls.leave("fake-clock", { source: CLOCK, state: POISON, start_ms: null, changes: { cleared: [], entries: [["seen", "item-1", "1"]] } });
      tx.tables.polls.leave("gone-lane", { source: "apple-notes:local:gone", state: canonical({ n: 1 }), start_ms: null, changes: { cleared: [], entries: [["seen", "item-1", "1"]] } });
      tx.tables.meta.set("poll-parked:gone-route", JSON.stringify({ paged_ms: null }));
    });
    written.close();
    const held = () => readHome(root, (db) => ({
      cursor: db.prepare("SELECT source, state FROM poll_cursors WHERE acquirer = 'fake-clock'").get(),
      memory: db.prepare("SELECT part, key, value FROM poll_memory WHERE acquirer = 'fake-clock'").all(),
    }));
    const POISONED = { cursor: { source: CLOCK, state: POISON }, memory: [{ part: "seen", key: "item-1", value: "1" }] };
    const failing = (call: string) => readHome(root, (db) => db.prepare("SELECT outcome, detail, fails, since_ms, at_ms FROM attempts WHERE target = ?").get(`${call}:fake-clock`)) as
      { outcome: string; detail: string; fails: number; since_ms: number; at_ms: number } | undefined;
    const clock = steppedClock(root, "fake-clock", 60_000);
    const logs: string[] = [];
    const sock = testSocket(root);
    const door = await doorHere(root, { registry: CLOCK_FAKES, clock: clock.now });
    let home = await startHome(root, { stopGraceMs: 50, registry: CLOCK_FAKES, clock: clock.now, log: (line) => logs.push(line), tickMs: TICK_MS });
    try {
      expect(readHome(root, (db) => ({
        cursors: db.prepare("SELECT acquirer FROM poll_cursors ORDER BY acquirer").pluck().all(),
        memory: db.prepare("SELECT DISTINCT acquirer FROM poll_memory ORDER BY acquirer").pluck().all(),
        parked: db.prepare("SELECT key FROM meta WHERE key LIKE 'poll-parked:%'").pluck().all(),
      }))).toEqual({ cursors: ["fake-clock"], memory: ["fake-clock"], parked: [] });
      await until("the poisoned fetch failed", () => failing("fetch")?.outcome === "fail");
      expect(failing("fetch")!.detail).toMatch(/^the cursor of fake-clock is no JSON/u);
      await clock.stepUntil("the poisoned fetch failed past its window", () => {
        const fetch = failing("fetch");
        return fetch !== undefined && fetch.fails >= 3 && fetch.at_ms - fetch.since_ms >= 15 * 60_000;
      });
      const report = await askHome(sock, "connectors") as { connectors: { id: string }[] };
      expect(report.connectors.some((each) => each.id === "fake-clock")).toBe(true);
      const answers = {
        try: await askHome(sock, "act", ["poll:fake-clock", "try"]),
        refresh: await askHome(sock, "connectors", ["refresh", "fake-clock"]),
        set: await askHome(sock, "connectors", ["set", "fake-clock", "label", "poisoned"]),
        backfill: await askHome(sock, "connectors", ["backfill", "fake-clock", "now"]),
      };
      await until("the page backfill now asked failed on the cursor", () => failing("page")?.outcome === "fail");
      expect(held()).toEqual(POISONED);
      const before = failing("fetch")!.fails;
      await home.stop();
      home = await startHome(root, { stopGraceMs: 50, registry: CLOCK_FAKES, clock: clock.now, log: (line) => logs.push(line), tickMs: TICK_MS });
      await clock.stepUntil("the poisoned fetch failed again after the restart", () => (failing("fetch")?.fails ?? 0) > before);
      expect(held()).toEqual(POISONED);
      expect(logs.filter((line) => JSON.parse(line).loop === "failed")).toEqual([]);
      artifact(root, "polls-poisoned", { answers, fetch: failing("fetch"), page: failing("page"), held: held() });
    } finally {
      await home.stop();
      await door.stop();
    }
  });
});
