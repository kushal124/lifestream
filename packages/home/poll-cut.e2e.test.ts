import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { civilDay, openHome, openHomeFolder, type JobRow, type JsonObject } from "@lifestreamprotocol/core";
import { StationFailed, type Acquirer, type Fetched } from "@lifestreamprotocol/connect";
import { afterAll, describe, expect, it } from "vitest";
import { runCli, openContext } from "./cli.js";
import { readConnectors } from "./connectors.js";
import { pageTurns, parkPoll, pollKind, pollsCut, POLL_RUN, queuedFor, SOON_MS, unparkPoll, type Call } from "./import.js";
import type { HelperEnv, Main } from "./jobs.js";
import { homeOf, loadRegistry, type Loaded } from "./registry.js";
import { effective } from "./settings.js";
import { askHome } from "./socket.js";
import { reasonLine, reasonWords, wordsOf } from "./stream-words.js";
import { clockConnectors } from "./test/clock-fakes.js";
import { ChildHome, FAKES, makeRoot, readHome, removeRoot, until } from "./test/harness-root.js";
import { editSettings, testSocket } from "./test/folder.js";
import { REPO } from "./test/support.js";
import { VERBS } from "./verbs/index.js";
import { photosComing, photosStart } from "./status.js";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) removeRoot(root);
});

const CLOCK = "apple-notes:local:clock";

const offline = () => new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND provider.example.com"), { code: "ENOTFOUND" }) });

function seams(prefix: string) {
  const root = makeRoot(prefix, { sources: { [CLOCK]: "fake-rows" }, settings: { "connectors.fake-clock": {} } });
  roots.push(root);
  const db = openHome(openHomeFolder(root), "migrate");
  const script: Record<Call, () => Fetched> = { fetch: () => ({ files: [], facts: {}, state: { n: 1 } }), page: () => ({ files: [], facts: {}, state: { n: 1 } }) };
  const clock: Acquirer = { name: "fake-clock", source: CLOCK, secrets: [], fetch: async () => script.fetch(), page: async () => ({ ...script.page(), left: 1 }) };
  let now = Date.now();
  const registry = { connectors: clockConnectors(), readers: [{ name: "fake-rows" }], families: [], acquirers: [clock], labelers: [], code: "code-test" } as unknown as Loaded;
  const main = (acquirers: readonly Acquirer[] = [clock]) => ({
    folder: openHomeFolder(root), settings: effective(root).settings, now: () => now, room: "ok", stated: {}, ending: 0, registry: { ...registry, acquirers }, log: () => undefined, polled: () => undefined,
  }) as unknown as Main;
  const jobOf = (name: string) => ({ id: 1, kind: "poll", key: name, connector: name, lane: 1 }) as JobRow;
  const begin = (name: string, calls: Call[] = []) => {
    const acquirer = [clock].find((each) => each.name === name)!;
    const begun = db.commit((tx) => {
      const queued = tx.tables.jobs.get("poll", name);
      if (queued?.state === "queued") tx.tables.jobs.delete(queued.id);
      unparkPoll(tx, acquirer);
      if (calls.length > 0) queuedFor(tx, name, calls);
      return pollKind.begin!(main(), tx, jobOf(name));
    });
    if (begun === null) return null;
    return {
      state: begun.state,
      async end(): Promise<string> {
        const env = { folder: openHomeFolder(root), registry, db, secrets: () => ({ get: () => undefined, rotate: () => undefined }), stations: { door: "http://127.0.0.1:9", pass: "none" }, signal: new AbortController().signal } as unknown as HelperEnv;
        const result = (await pollKind.helper(env, { job: 1, kind: "poll", key: name, lane: 1, now_ms: now, data: begun.data }).next()).value as Parameters<typeof pollKind.done>[3];
        db.commit((tx) => pollKind.done(main(), tx, { job: jobOf(name), state: begun.state }, result));
        return result.end.outcome;
      },
      stop: () => db.commit((tx) => pollKind.stopped!(main(), tx, { job: jobOf(name), state: begun.state })),
    };
  };
  const start = (acquirers?: readonly Acquirer[]) => db.commit((tx) => pollsCut(main(acquirers), tx));
  const attempt = (target: string) => db.commit((tx) => tx.tables.attempts.of(target)[0]);
  const meta = (key: string) => db.commit((tx) => tx.tables.meta.get(key));
  const job = (name: string) => db.commit((tx) => tx.tables.jobs.get("poll", name)?.state);
  const cli = async (...args: string[]) => {
    const lines: string[] = [];
    const ctx = openContext(openHomeFolder(root), () => undefined, { registry: { ...registry } }, "write", (line) => lines.push(line));
    try {
      await VERBS.connectors!(ctx, args);
      return lines;
    } finally {
      ctx.close();
    }
  };
  const words = (row: { outcome: string; reason: string | null; facts: Readonly<Record<string, unknown>> }) => {
    const state = { ok: "ok", wait: "waiting", need: "needs-you", fail: "broken" }[row.outcome]!;
    const said = wordsOf("Notes", null, now, effective(root).settings.day, row.facts as never);
    return [reasonWords(state, row.reason, said), reasonLine(state, row.reason, said) ?? null];
  };
  const stream = () => readHome(root, (read) => {
    const report = readConnectors(read, {
      folder: openHomeFolder(root), now_ms: now, settings: effective(root).settings, registry: { connectors: clockConnectors(), families: [] },
      machine: process.env.LIFESTREAM_MACHINE_DIR!, sites: null, present: [], needs: [], free_bytes: Number.MAX_SAFE_INTEGER, photos: photosComing(read, photosStart(effective(root).settings, clockConnectors(), now)),
    });
    const { state, words, acts } = report.connectors.find((each) => each.id === "fake-clock")!.health;
    return { state, words, acts, needs: report.needs.filter((need) => need.connector === "fake-clock").map((need) => need.id) };
  });
  return {
    root, db, script, clock, begin, start, attempt, meta, job, cli, words, stream, main,
    tick: (ms: number) => { now += ms; },
    now: () => now,
    close: () => db.close(),
  };
}

describe("a poll the home's end cut short", () => {
  it("says nothing of a fetch the home's end cut short, drops what it was queued for, or leaves a Refresh now's Fetching for ever", async () => {
    const home = seams("lifestream-cut-fetch-");
    try {
      home.db.commit((tx) => tx.tables.meta.set("poll-refresh:fake-clock", "queued"));
      const cut = home.begin("fake-clock", ["fetch"])!;
      expect([cut.state.call, cut.state.refresh, home.meta("poll-refresh:fake-clock"), home.meta(`${POLL_RUN}fake-clock`) !== undefined]).toEqual(["fetch", true, "running", true]);
      expect((await home.cli("show", "fake-clock")).filter((line) => line.startsWith("  "))).toEqual([expect.stringMatching(/^ {2}cut short when the home stopped \(a fetch, begun .+\): it runs again as the home starts$/u)]);
      home.tick(5_000);
      expect(home.start()).toEqual(["fake-clock"]);
      const row = home.attempt("fetch:fake-clock")!;
      expect([row.source, row.outcome, row.reason, row.facts, row.contact_ms]).toEqual([CLOCK, "wait", "door", { interrupted: true, cuts: 1, began_ms: home.now() - 5_000 }, null]);
      expect(row.detail).toMatch(/^the home stopped while this fetch ran \(begun \d{4}-\d\d-\d\dT[\d:.]+Z\); it runs again now$/u);
      expect(home.words(row)).toEqual(["Stopped when Lifestream quit · running again", null]);
      expect([home.meta(`${POLL_RUN}fake-clock`), home.meta("poll-queued:fake-clock"), home.meta("poll-refresh:fake-clock"), home.job("fake-clock")]).toEqual([undefined, JSON.stringify(["fetch"]), "queued", "queued"]);
      const shown = await home.cli("show", "fake-clock");
      expect(shown.slice(-2)).toEqual([
        "  queued: a fetch runs as the home starts",
        expect.stringMatching(new RegExp(`^ {2}${CLOCK} fetch .+: waiting: Stopped when Lifestream quit · running again \\(the home stopped while this fetch ran`, "u")),
      ]);
      const again = home.begin("fake-clock")!;
      expect([again.state.call, again.state.refresh]).toEqual(["fetch", true]);
      expect(await again.end()).toBe("ok");
      expect([home.attempt("fetch:fake-clock")!.outcome, home.attempt("fetch:fake-clock")!.facts, home.meta("poll-refresh:fake-clock"), home.start()]).toEqual(["ok", {}, undefined, []]);
    } finally {
      home.close();
    }
  });

  it("says a run cut again and again as the stream's failure, loses how many times in a row it was cut, or counts a run that read between", async () => {
    const home = seams("lifestream-cut-again-");
    try {
      expect(await home.begin("fake-clock", ["fetch"])!.end()).toBe("ok");
      const read = home.stream();
      const cuts: unknown[] = [];
      for (let n = 1; n <= 3; n++) {
        home.begin("fake-clock", ["fetch"]);
        home.tick(1_000);
        home.start();
        const row = home.attempt("fetch:fake-clock")!;
        cuts.push([row.outcome, row.reason, row.facts.cuts, row.fails, ...home.words(row)]);
        expect(home.stream(), `cut ${n}`).toEqual(read);
      }
      expect(cuts).toEqual([1, 2, 3].map((n) => ["wait", "door", n, 0, "Stopped when Lifestream quit · running again", null]));
      expect(home.attempt("fetch:fake-clock")!.detail).toMatch(/, 3 times in a row; it runs again now$/u);
      expect(await home.cli("show", "fake-clock")).toContainEqual(expect.stringMatching(/: waiting: Stopped when Lifestream quit · running again \(.+, 3 times in a row; it runs again now\)$/u));
      expect(await home.begin("fake-clock")!.end()).toBe("ok");
      home.begin("fake-clock", ["fetch"]);
      home.start();
      expect(home.attempt("fetch:fake-clock")!.facts).toMatchObject({ interrupted: true, cuts: 1 });
    } finally {
      home.close();
    }
  });

  it("drops a page of history the home's end cut short", async () => {
    const home = seams("lifestream-cut-page-");
    try {
      expect(home.begin("fake-clock", ["page"])!.state.call).toBe("page");
      home.start();
      expect([home.attempt("page:fake-clock")!.reason, home.attempt("page:fake-clock")!.detail, home.attempt("fetch:fake-clock")]).toEqual(["door", expect.stringMatching(/^the home stopped while this page of history ran /u), undefined]);
      const page = home.begin("fake-clock")!;
      expect([page.state.call, await page.end()]).toEqual(["page", "ok"]);
    } finally {
      home.close();
    }
  });

  it("says cut of a run that ended or a pause stopped, or of a poll the home builds no more", async () => {
    const home = seams("lifestream-cut-none-");
    try {
      await home.begin("fake-clock", ["fetch"])!.end();
      home.begin("fake-clock", ["fetch"])!.stop();
      expect([home.meta(`${POLL_RUN}fake-clock`), home.start(), home.attempt("fetch:fake-clock")!.outcome]).toEqual([undefined, [], "ok"]);
      const before = home.attempt("fetch:fake-clock");
      home.begin("fake-clock", ["fetch"]);
      expect([home.start([]), home.meta(`${POLL_RUN}fake-clock`), home.attempt("fetch:fake-clock"), home.job("fake-clock")]).toEqual([[], undefined, before, undefined]);
    } finally {
      home.close();
    }
  });

  it("puts a page that stood on a wait that ends by itself off to its pace, or asks one that stood on a busy Chrome again before its retry", async () => {
    const home = seams("lifestream-cut-soon-");
    try {
      await home.begin("fake-clock", ["fetch"])!.end();
      const paged = () => home.db.commit((tx) => tx.tables.polls.get("fake-clock")!);
      const due = () => home.db.commit((tx) => pageTurns(home.main(), tx.tables, home.now())(home.clock).due);
      home.script.page = () => {
        throw offline();
      };
      expect(await home.begin("fake-clock", ["page"])!.end()).toBe("wait");
      const at = home.now();
      expect([paged().paged_ms, paged().page_next_ms]).toEqual([null, at + SOON_MS]);
      home.tick(SOON_MS - 1);
      expect(due()).toBe(false);
      home.tick(1);
      expect(due()).toBe(true);
      home.script.page = () => {
        throw new StationFailed("BUSY", "the Lifestream extension in every Chrome profile is busy with the site");
      };
      expect(await home.begin("fake-clock", ["page"])!.end()).toBe("wait");
      expect(paged().paged_ms).toBe(home.now());
      home.tick(SOON_MS);
      expect(due()).toBe(false);
    } finally {
      home.close();
    }
  });

  it("says a route parked and run again has not run, lets a call that did not read erase that one did, or brings back a row its next call says anew", async () => {
    const home = seams("lifestream-cut-parked-");
    try {
      expect(await home.begin("fake-clock", ["fetch"])!.end()).toBe("ok");
      home.tick(60_000);
      home.script.fetch = () => {
        throw offline();
      };
      expect(await home.begin("fake-clock", ["fetch"])!.end()).toBe("wait");
      const fetched = home.attempt("fetch:fake-clock")!;
      expect([fetched.outcome, fetched.reason]).toEqual(["wait", "offline"]);
      home.db.commit((tx) => tx.tables.attempts.put({ ...fetched, target: "page:fake-clock", outcome: "need", reason: "signed-out", fails: 0 }));
      const lastRead = expect.stringMatching(/^ {2}last read .+ \(a fetch\)$/u);
      expect(await home.cli("show", "fake-clock")).toContainEqual(lastRead);
      home.db.commit((tx) => parkPoll(tx, "fake-clock"));
      expect([home.attempt("fetch:fake-clock"), home.attempt("page:fake-clock")]).toEqual([undefined, undefined]);
      home.db.commit((tx) => unparkPoll(tx, home.clock));
      expect([home.attempt("fetch:fake-clock"), home.attempt("page:fake-clock")]).toEqual([undefined, undefined]);
      const shown = (await home.cli("show", "fake-clock")).filter((line) => line.startsWith("  "));
      expect(shown).toEqual([lastRead]);
    } finally {
      home.close();
    }
  });

});

describe("the journey: a feed of 3,000 events, one file each, its home killed and stopped under its fetch", () => {
  it("leaves a fetch its home was killed, then stopped, under silent, or loses an event once it is let go", async () => {
    const root = makeRoot("lifestream-cut-journey-", { sources: { "apple-notes:local:poll": "fake-rows" }, clocks: true, settings: {} });
    roots.push(root);
    const hold = join(root, "hold");
    const EVENTS = 3_000;
    editSettings(root, { "connectors.fake-poll": { refresh: "1h", hold, events: EVENTS } });
    writeFileSync(hold, "");
    const db = openHome(openHomeFolder(root), "migrate");
    db.commit((tx) => tx.tables.meta.set("clock:sweep", civilDay(Date.now(), effective(root).settings.day)));
    db.close();
    const sock = testSocket(root);
    const child = new ChildHome(root);
    const shows: Record<string, string[]> = {};
    const show = async (label: string) => {
      const lines: string[] = [];
      await askHome(sock, "connectors", ["show", "fake-poll"], (line) => lines.push(line));
      shows[label] = lines.filter((line) => line.startsWith("poll ") || line.startsWith("  "));
      return shows[label]!;
    };
    const held = async (what: string) => {
      if (existsSync(`${hold}.held`)) unlinkSync(`${hold}.held`);
      await until(what, () => existsSync(`${hold}.held`));
    };
    try {
      child.start();
      await child.ready();
      await held("the first fetch is under way");
      child.kill();
      await child.exited();
      const registry = await loadRegistry(pathToFileURL(FAKES).href, effective(root).settings, homeOf(openHomeFolder(root)));
      const out: string[] = [];
      expect(await runCli(["connectors", "show", "fake-poll", "--root", root], { write: (text) => out.push(text), going: () => undefined, registry })).toBe(0);
      shows.killed = out.join("").trimEnd().split("\n").filter((line) => line.startsWith("poll ") || line.startsWith("  "));
      expect(shows.killed.at(-1)).toMatch(/^ {2}cut short when the home stopped \(a fetch, begun .+\): it runs again as the home starts$/u);
      child.start();
      await child.ready();
      await held("the fetch runs again after the kill");
      expect((await show("after the kill")).slice(1)).toEqual([
        expect.stringMatching(/^ {2}running since .+: a fetch$/u),
        expect.stringMatching(/^ {2}apple-notes:local:poll fetch .+: waiting: Stopped when Lifestream quit · running again \(the home stopped while this fetch ran \(begun .+\); it runs again now\)$/u),
      ]);
      await child.stop();
      child.start();
      await child.ready();
      await held("the fetch runs again after the stop");
      expect((await show("after the stop")).at(-1)).toMatch(/, 2 times in a row; it runs again now\)$/u);
      unlinkSync(hold);
      await until("the feed is sealed", () => sealOf(root) !== null);
      const seal = sealOf(root)!;
      expect(seal.files).toBe(EVENTS + 1);
      await until("every event landed", () => readHome(root, (read) => read.prepare("SELECT count(*) FROM heads WHERE source = 'apple-notes:local:poll' AND key LIKE 'event-%'").pluck().get()) === EVENTS);
      expect((await show("landed")).at(-1)).toMatch(/^ {2}apple-notes:local:poll fetch .+: read$/u);
      const directory = join(REPO, "packages", "home", ".build", "e2e");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "poll-cut.json"), `${JSON.stringify({ shows, seal: { ...seal, platform: process.platform, fsync: false } }, null, 2)}\n`);
    } finally {
      await child.stop();
    }
  });
});

function sealOf(root: string): { files: number; seal_ms: number } | null {
  const lane = join(root, "inbox", "apple-notes:local:poll");
  if (!existsSync(lane)) return null;
  for (const name of readdirSync(lane)) {
    const events = join(lane, name, "events");
    if (!existsSync(events) || !existsSync(join(lane, name, "manifest.json"))) continue;
    const first = statSync(join(events, "event-0.ics")).mtimeMs;
    const manifest = statSync(join(lane, name, "manifest.json")).mtimeMs;
    return { files: readdirSync(events).length + 1, seal_ms: Math.round(manifest - first) };
  }
  return null;
}
