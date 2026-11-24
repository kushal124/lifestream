import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { startHome, type Home } from "./home.js";
import { askHome } from "./socket.js";
import { ChildHome, LOOK_MS, makeRoot, makeVault, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { doorHere } from "./test/harness-door.js";
import { CALLS_FILE, type CallLine } from "./test/poll-state-registry.js";
import { REPO } from "./test/support.js";
import { testSocket } from "./test/folder.js";

const { FakeRelay } = (await import(new URL("../connect/test/station.ts", import.meta.url).href)) as typeof import("../connect/test/station.js");
const { ExampleBrowserSite, note, ACCOUNT, SOURCE } = (await import(new URL("../connect/templates/browser/test/fixture.ts", import.meta.url).href)) as typeof import("../connect/templates/browser/test/fixture.js");
type FakeRelay = import("../connect/test/station.js").FakeRelay;
type Site = import("../connect/test/station.js").Site;

const REGISTRY = new URL("./test/poll-state-registry.ts", import.meta.url);
const LANE = "example-browser";
const UNIT = "chrome-5550aa08";
const DEVICE = { "lifestream-device": "extension/1.0.0" };
const N = 450;
const PIECE = 150;
const SEEN = `seen:${ACCOUNT}`;

const report: Record<string, unknown> = {};
afterAll(() => {
  const directory = join(REPO, "packages", "home", ".build", "e2e");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "poll-state.json"), `${JSON.stringify(report, null, 2)}\n`);
});

type Call = { id: string; errand: string; op: string; [member: string]: unknown };
type Answer = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };
type Result = Answer & { id: string };

interface Seen {
  id: string;
  name: string;
  probe: number;
  list: number;
  conversation: number;
}

class Station {
  readonly errands: { id: string; name: string; relay: FakeRelay }[] = [];
  sites: { id: string; signed_in?: boolean | null }[] = [];
  answers = 0;
  #survey = false;
  #stopped = false;
  #inflight: AbortController | null = null;
  readonly #results: Result[] = [];
  readonly #open = new Map<string, { relay: FakeRelay; id: string }>();
  readonly #boot = randomBytes(6).toString("hex");

  constructor(private readonly door: string, private readonly pass: string, private readonly site: Site) {}

  seen(): Seen[] {
    return this.errands.filter((each) => each.name === LANE).map(({ id, name, relay }) => {
      const paths = relay.requested.map((url) => new URL(url, "https://notes.example.com").pathname);
      return { id, name, probe: paths.filter((path) => path === "/api/me").length, list: paths.filter((path) => path === "/api/notes").length, conversation: paths.filter((path) => path.startsWith("/api/notes/")).length };
    });
  }

  #headers(type?: string): Record<string, string> {
    return { authorization: `Bearer ${this.pass}`, ...DEVICE, ...(type === undefined ? {} : { "content-type": type }) };
  }

  survey(): void {
    this.#survey = true;
    this.#inflight?.abort();
  }

  async serve(): Promise<void> {
    while (!this.#stopped) await this.#exchange();
  }

  stop(): void {
    this.#stopped = true;
    this.#inflight?.abort();
  }

  async #exchange(): Promise<void> {
    const results = this.#results.splice(0);
    const survey = this.#survey;
    this.#survey = false;
    const exchanging = new AbortController();
    this.#inflight = exchanging;
    let answer: { calls: Call[]; sites: Station["sites"] };
    try {
      const response = await fetch(`${this.door}/v1/stations/exchange`, {
        method: "POST", headers: this.#headers("application/json"), signal: exchanging.signal,
        body: JSON.stringify({
          results,
          station: {
            unit: UNIT, version: "1.0.0", slots: 2, errands: [...this.#open.keys()], boot: this.#boot, running: [],
            pressed: { choose: [], stop: [] }, allowing: [], opened: [], acted: [], ...(survey ? { survey: true } : {}),
          },
        }),
      });
      if (!response.ok) throw new Error(`exchange answered ${response.status}`);
      answer = await response.json() as typeof answer;
    } catch {
      this.#results.unshift(...results);
      if (survey) this.#survey = true;
      if (!exchanging.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 100));
      return;
    } finally {
      this.#inflight = null;
    }
    this.answers++;
    this.sites = answer.sites;
    for (const call of answer.calls) this.#results.push({ ...await this.#handle(call), id: call.id } as Result);
  }

  async #handle(call: Call): Promise<Answer> {
    const driver = { authorization: "Bearer drive-token-synthetic", "content-type": "application/json" };
    if (call.op === "begin") {
      const relay = new FakeRelay(this.site);
      const begun = await (await relay.fetch("https://door.example/v1/errands", { method: "POST", headers: driver, body: JSON.stringify({ spec: call.spec }) })).json() as { errand: string };
      this.#open.set(call.errand, { relay, id: begun.errand });
      this.errands.push({ id: call.errand, name: (call.spec as { name: string }).name, relay });
      return { ok: true, value: { begun: true } };
    }
    const errand = this.#open.get(call.errand);
    if (errand === undefined) return { ok: false, error: { code: "BAD_CALL", message: `no errand ${call.errand}` } };
    if (call.op === "end") {
      await errand.relay.fetch(`https://door.example/v1/errands/${errand.id}`, { method: "DELETE", headers: driver });
      this.#open.delete(call.errand);
      return { ok: true, value: { ended: true } };
    }
    const { id: _id, errand: _errand, ...op } = call;
    const answered = await (await errand.relay.fetch(`https://door.example/v1/errands/${errand.id}`, { method: "POST", headers: driver, body: JSON.stringify(op) })).json() as Answer;
    if (!answered.ok || call.op !== "fetch") return answered;
    const answers = answered.value as { file?: { name: string; path: string } }[];
    let failed: Answer | undefined;
    const uploaded = await Promise.all(answers.map(async (each) => {
      if (each.file === undefined) return each;
      const bytes = readFileSync(each.file.path);
      const path = `${this.door}/v1/stations/files/${call.errand}/${each.file.name}`;
      if (bytes.length > 0) {
        const put = await fetch(`${path}?part=0`, { method: "PUT", headers: this.#headers("application/octet-stream"), body: bytes });
        if (!put.ok) {
          failed ??= { ok: false, error: { code: "PAGE_ERROR", message: `${each.file.name} answered ${put.status}` } };
          return each;
        }
      }
      const done = await fetch(`${path}?done=${bytes.length > 0 ? 1 : 0}`, { method: "POST", headers: this.#headers() });
      if (!done.ok) {
        failed ??= { ok: false, error: { code: "PAGE_ERROR", message: `${each.file.name} answered ${done.status}` } };
        return each;
      }
      return { ...each, file: await done.json() };
    }));
    if (failed !== undefined) return failed;
    return { ok: true, value: uploaded };
  }
}

const linesOf = (root: string): CallLine[] => {
  let text = "";
  try {
    text = readFileSync(join(root, CALLS_FILE), "utf8");
  } catch {
    return [];
  }
  return text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as CallLine);
};

function holding(root: string) {
  return readHome(root, (db) => ({
    cursor: db.prepare("SELECT state, source FROM poll_cursors WHERE acquirer = ?").get(LANE) as { state: string; source: string } | undefined,
    parts: Object.fromEntries((db.prepare("SELECT part, count(*) AS n FROM poll_memory WHERE acquirer = ? GROUP BY part ORDER BY part").all(LANE) as { part: string; n: number }[]).map((row) => [row.part, row.n])) as Record<string, number>,
    versions: db.prepare("SELECT count(DISTINCT version) FROM statements WHERE source = ?").pluck().get(SOURCE) as number,
    heads: db.prepare("SELECT count(*) FROM heads WHERE source = ?").pluck().get(SOURCE) as number,
    unimported: db.prepare("SELECT count(*) FROM deliveries WHERE state IN ('sealed', 'importing')").pluck().get() as number,
    job: db.prepare("SELECT state FROM jobs WHERE kind = 'poll' AND key = ?").pluck().get(LANE) as string | undefined,
  }));
}

const doneCommits = (logs: readonly string[]) => logs.filter((line) => line.includes(`"of":"poll ${LANE} done"`)).map((line) => JSON.parse(line) as { slow: number; work_ms: number; due_ms: number; commit_ms: number });

describe("a poll's cursor and memory through a running home", () => {
  it("reads the site in pieces, then fetches only what changed, through a kill before a commit and a restart", async () => {
    const root = makeRoot("lifestream-poll-state-", { sources: {}, clocks: true, settings: { [`connectors.${LANE}`]: {} } });
    cpSync(join(REPO, "packages", "connect", "templates", "browser"), join(root, "connectors", LANE), { recursive: true });
    const site = new ExampleBrowserSite();
    site.notes = [];
    const sock = testSocket(root);
    const logs: string[] = [];
    let home: Home | undefined;
    const child = new ChildHome(root);
    let station: Station | undefined;
    let door: Awaited<ReturnType<typeof doorHere>> | undefined;
    const start = async () => {
      home = await startHome(root, { registry: REGISTRY, slot: null, log: (line) => logs.push(line), tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, slowMs: -1 });
    };
    const stop = async () => {
      await home!.stop();
      home = undefined;
    };
    const settled = (from: number) => {
      const held = holding(root);
      return linesOf(root).length > from && held.job === "done" && held.unimported === 0;
    };
    const call = async (what: string) => {
      const from = linesOf(root).length;
      await askHome(sock, "run", ["poll", LANE]);
      await until(`${what}: the lane's call ran and what it sealed is imported`, () => settled(from));
      return linesOf(root).slice(from);
    };
    const rows = (from: number) => {
      const seen = new Map(station!.seen().map((each) => [each.id, each]));
      return linesOf(root).slice(from).map((line) => {
        if (line.errand === null) return { ...line, requests: { probe: 0, list: 0, conversation: 0 } };
        const ran = seen.get(line.errand);
        expect(ran, `the station saw the errand ${line.errand} the call ran`).toBeDefined();
        return { ...line, requests: { probe: ran!.probe, list: ran!.list, conversation: ran!.conversation } };
      });
    };
    try {
      door = await doorHere(root, { registry: REGISTRY });
      await start();
      await makeVault(root);
      const pass = randomBytes(32).toString("base64url");
      const { code } = await askHome(sock, "pair") as { code: string };
      const paired = await fetch(`${door.url}/v1/pair`, { method: "POST", headers: { ...DEVICE, "content-type": "application/json" }, body: JSON.stringify({ code, pass, kind: "extension", model: "Chrome", unit: UNIT }) });
      expect([paired.status, paired.status === 200 ? "" : await paired.text()]).toEqual([200, ""]);
      station = new Station(door.url, pass, site);
      void station.serve();
      await until("the station's first answer", () => station!.answers > 0);
      await askHome(sock, "pause", [`pause:${LANE}:history`, "--reason", "the journey reads what is new"]);
      await askHome(sock, "connectors", ["on", LANE]);
      station.survey();
      await until("the survey saw the site's account", () => station!.sites.some((each) => each.id === LANE && each.signed_in === true));

      const firsts = await call("the first calls");
      expect(firsts.map((each) => each.call)).toEqual(firsts.map(() => "fetch"));
      expect(firsts[0]).toMatchObject({ changed: { account: { added: 1, changed: 0, dropped: 0 } } });
      const began = linesOf(root).length;
      report.first = { calls: rows(0), holding: holding(root) };

      const at = Date.now();
      for (let n = 1; n <= N; n++) site.notes.push(note(n, "2026-09-04T10:00:00.000Z", new Date(at + n).toISOString()));
      const read = Math.ceil(N / PIECE);
      const from = linesOf(root).length;
      await askHome(sock, "run", ["poll", LANE]);
      for (let calls = 1; calls <= read; calls++) await until(`the first reads: call ${calls} of ${read} ended`, () => linesOf(root).length >= from + calls);
      await until("the first reads settled", () => settled(from) && holding(root).parts[SEEN] === N);
      const pieces = rows(began);
      const firstRead = holding(root);
      expect(pieces.map((each) => each.call)).toEqual(Array.from({ length: read }, () => "fetch"));
      expect(pieces.map((each) => each.requests.conversation)).toEqual(Array.from({ length: read }, (_, at) => Math.min(PIECE, N - at * PIECE)));
      expect(firstRead.heads).toBe(N);
      expect(Math.max(...pieces.map((each) => each.cursor_bytes!))).toBeLessThan(512);
      expect(firstRead.cursor!.state.length).toBeLessThan(512);
      expect(pieces.map((each) => each.cursor_bytes).filter((bytes) => bytes !== null).every((bytes) => Math.abs(bytes! - pieces[0]!.cursor_bytes!) <= 64)).toBe(true);
      expect(pieces[0]!.requests.list).toBeGreaterThanOrEqual(N / 50);
      expect(pieces[0]!.changed).toEqual({
        [SEEN]: { added: PIECE, changed: 0, dropped: 0 }, [`owed:${ACCOUNT}`]: { added: N - PIECE, changed: 0, dropped: 0 },
      });
      expect(firstRead.parts[`owed:${ACCOUNT}`]).toBeUndefined();
      const commits = doneCommits(logs);
      report.reads = { n: N, piece: PIECE, calls: pieces, holding: firstRead, seeding_done_commit: commits[commits.length - read] ?? null, done_commits_ms: commits.slice(-read).map((each) => each.slow) };

      const linesQuiet = linesOf(root).length;
      await call("the call after the reads");
      const after = rows(linesQuiet);
      expect(after).toHaveLength(1);
      expect([after[0]!.call, after[0]!.changed, after[0]!.requests.conversation]).toEqual(["fetch", {}, 0]);
      expect(after[0]!.requests.list).toBeGreaterThan(0);
      expect(holding(root).versions).toBe(firstRead.versions);
      report.after_reads = { calls: after, holding: holding(root) };

      const changedOne = site.notes[N - 1]!;
      changedOne.text = "Synthetic text, edited.";
      changedOne.updated_at = new Date(at + N + 60_000).toISOString();
      const linesOne = linesOf(root).length;
      await call("the call after one change");
      const one = rows(linesOne);
      expect(one).toHaveLength(1);
      expect([one[0]!.call, one[0]!.changed, one[0]!.requests.conversation]).toEqual(["fetch", { [SEEN]: { added: 0, changed: 1, dropped: 0 } }, 1]);
      expect(holding(root).versions).toBe(firstRead.versions + 1);
      report.one_changed = { calls: one, holding: holding(root) };

      await stop();
      const killedNote = site.notes[N - 2]!;
      const seenOf = (id: string) => readHome(root, (db) => db.prepare("SELECT value FROM poll_memory WHERE acquirer = ? AND part = ? AND key = ?").pluck().get(LANE, SEEN, id)) as string;
      const heldBefore = seenOf(killedNote.id);
      killedNote.text = "Synthetic text, edited before the kill.";
      killedNote.updated_at = new Date(at + N + 120_000).toISOString();
      const before = holding(root);
      const linesKill = linesOf(root).length;
      child.start("poll.sealed", { env: { LIFESTREAM_TEST_REGISTRY: REGISTRY.href } });
      await child.ready();
      await askHome(sock, "run", ["poll", LANE]).catch(() => undefined);
      expect(await child.exited()).toEqual({ code: null, signal: "SIGKILL" });
      const killed = rows(linesKill);
      const said = JSON.stringify(killed.map(({ call, errand, threw, changed, requests }) => ({ call, errand, threw, changed, requests })));
      const fetched = killed.filter((row) => row.requests.conversation > 0);
      expect(fetched.map((row) => [row.call, row.changed, row.requests.conversation]), said).toEqual([["fetch", { [SEEN]: { added: 0, changed: 1, dropped: 0 } }, 1]]);
      expect(killed.filter((row) => row.requests.conversation === 0).every((row) => JSON.stringify(row.changed ?? {}) === "{}"), said).toBe(true);
      const left = holding(root);
      expect([left.cursor, left.parts, left.versions]).toEqual([before.cursor, before.parts, before.versions]);
      expect(seenOf(killedNote.id)).toBe(heldBefore);
      const linesAgain = linesOf(root).length;
      await start();
      await until("the killed call's delivery landed and the start made the cut call again", () => {
        const held = holding(root);
        return held.versions === before.versions + 1 && settled(linesAgain) && seenOf(killedNote.id) === JSON.stringify(killedNote.updated_at);
      });
      const again = rows(linesAgain);
      expect(again.filter((row) => row.requests.conversation > 0).map((row) => [row.call, row.changed, row.requests.conversation])).toEqual([["fetch", { [SEEN]: { added: 0, changed: 1, dropped: 0 } }, 1]]);
      expect(again.filter((row) => row.requests.conversation === 0).map((row) => row.changed)).toEqual(again.filter((row) => row.requests.conversation === 0).map(() => ({})));
      const linesQuiet2 = linesOf(root).length;
      await call("the call after the start's");
      expect(rows(linesQuiet2).map((row) => [row.call, row.changed, row.requests.conversation])).toEqual(rows(linesQuiet2).map(() => ["fetch", {}, 0]));
      const recovered = holding(root);
      expect(recovered.versions).toBe(before.versions + 1);
      expect(recovered.heads).toBe(N);
      report.killed = { killed_call: killed, ran_again: again, holding: recovered };

      await stop();
      await start();
      const linesRestart = linesOf(root).length;
      await call("the call after a restart");
      const restarted = rows(linesRestart);
      expect(restarted.length).toBeGreaterThanOrEqual(1);
      expect(restarted.map((row) => [row.call, row.changed, row.requests.conversation])).toEqual(restarted.map(() => ["fetch", {}, 0]));
      const last = holding(root);
      expect([last.versions, last.heads, last.parts[SEEN]]).toEqual([recovered.versions, N, N]);
      report.restarted = { calls: restarted, holding: last };
    } finally {
      report.home_log = logs.filter((line) => /error|fail|stopped|started/iu.test(line) && !line.includes('"slow"')).slice(-20);
      station?.stop();
      child.kill();
      await home?.stop();
      await door?.stop();
      rmSync(join(root, CALLS_FILE), { force: true });
      removeRoot(root);
    }
  });
});
