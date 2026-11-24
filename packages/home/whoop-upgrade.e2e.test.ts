import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { canonical, openHome, openHomeFolder, type JsonObject } from "@lifestreamprotocol/core";
import { startHome, type Home } from "./home.js";
import { mintPrincipal } from "./principals.js";
import { askHome } from "./socket.js";
import { editSettings, testSocket } from "./test/folder.js";
import { LOOK_MS, makeRoot, makeVault, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { doorHere } from "./test/harness-door.js";
import { REPO } from "./test/support.js";
import { JOURNEY_FILE } from "./test/whoop-registry.js";
import { declarations, vendorOf } from "@lifestreamprotocol/connect";

const { FakeRelay } = (await import(new URL("../connect/test/station.ts", import.meta.url).href)) as typeof import("../connect/test/station.js");
const { fakeWhoop } = (await import(new URL("../connect/health/whoop/test/fake.ts", import.meta.url).href)) as typeof import("../connect/health/whoop/test/fake.js");
type FakeWhoop = import("../connect/health/whoop/test/fake.js").FakeWhoop;
type FakeRelay = import("../connect/test/station.js").FakeRelay;

const REGISTRY = new URL("./test/whoop-registry.ts", import.meta.url);
const UNIT = "chrome-5550aa07";
const DEVICE = { "lifestream-device": "extension/1.0.0" };
const ZONE = "UTC";
const DAY_MS = 86_400_000;
const ACCOUNT = "10000001";
const OTHER = "10000002";
const SOURCE = `whoop:${ACCOUNT}:cloud`;
const OFF = `whoop:${OTHER}:cloud`;
const BEFORE = Date.parse("2026-09-01T12:00:00Z");
const AFTER = BEFORE + 30 * DAY_MS;
const PACE_MS = 30_000;

const report: Record<string, unknown> = {};
afterAll(() => {
  const directory = join(REPO, "packages", "home", ".build", "e2e");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "whoop-upgrade.json"), `${JSON.stringify(report, null, 2)}\n`);
});

type Call = { id: string; errand: string; op: string; [member: string]: unknown };
type Answer = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };
type Result = Answer & { id: string };

class Station {
  readonly begun: string[] = [];
  readonly calls: string[] = [];
  sites: { id: string; signed_in?: boolean | null; account?: { email: string; verdict: string } | null }[] = [];
  answers = 0;
  surveys = 0;
  #survey = false;
  #stopped = false;
  #inflight: AbortController | null = null;
  readonly #results: Result[] = [];
  readonly #errands = new Map<string, { relay: FakeRelay; id: string }>();
  readonly #boot = randomBytes(6).toString("hex");

  constructor(private readonly door: string, private readonly pass: string, private readonly site: FakeWhoop) {}

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
    let answer: { calls: Call[]; sites: Station["sites"]; chosen: string[] };
    try {
      const response = await fetch(`${this.door}/v1/stations/exchange`, {
        method: "POST", headers: this.#headers("application/json"), signal: exchanging.signal,
        body: JSON.stringify({
          results,
          station: {
            unit: UNIT, version: "1.0.0", slots: 2, errands: [...this.#errands.keys()], boot: this.#boot, running: [],
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
    if (survey) this.surveys++;
    this.sites = answer.sites;
    for (const call of answer.calls) {
      const answered = await this.#handle(call);
      this.calls.push(answered.ok ? call.op : `${call.op}: ${answered.error.code} ${answered.error.message}`);
      this.#results.push({ ...answered, id: call.id } as Result);
    }
  }

  async #handle(call: Call): Promise<Answer> {
    const driver = { authorization: "Bearer drive-token-synthetic", "content-type": "application/json" };
    if (call.op === "begin") {
      const relay = new FakeRelay(this.site);
      const begun = await (await relay.fetch("https://door.example/v1/errands", { method: "POST", headers: driver, body: JSON.stringify({ spec: call.spec }) })).json() as { errand: string };
      this.#errands.set(call.errand, { relay, id: begun.errand });
      this.begun.push((call.spec as { name: string }).name);
      return { ok: true, value: { begun: true } };
    }
    const errand = this.#errands.get(call.errand);
    if (errand === undefined) return { ok: false, error: { code: "BAD_CALL", message: `no errand ${call.errand}` } };
    if (call.op === "end") {
      await errand.relay.fetch(`https://door.example/v1/errands/${errand.id}`, { method: "DELETE", headers: driver });
      this.#errands.delete(call.errand);
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

function holding(root: string) {
  return readHome(root, (db) => ({
    sources: (db.prepare("SELECT id, connector, options FROM sources WHERE product = 'whoop' ORDER BY added_ms, id").all() as { id: string; connector: string; options: string }[]),
    heads: Object.fromEntries((db.prepare("SELECT source, count(*) AS n FROM heads GROUP BY source").all() as { source: string; n: number }[]).map((row) => [row.source, row.n])),
    cycles: db.prepare("SELECT key FROM heads WHERE source = ? AND kind = 'cycle' ORDER BY key").pluck().all(SOURCE) as string[],
    poll: db.prepare("SELECT state, source FROM poll_cursors WHERE acquirer = 'whoop'").get() as { state: string; source: string } | undefined,
    memory: Object.fromEntries((db.prepare("SELECT part, key, value FROM poll_memory WHERE acquirer = 'whoop' ORDER BY part, key").all() as { part: string; key: string; value: string }[])
      .map((row) => [`${row.part} ${row.key}`, JSON.parse(row.value) as unknown])),
    backfills: db.prepare("SELECT source, acquirer, left, start_ms FROM backfills ORDER BY source").all() as { source: string; acquirer: string; left: number | null; start_ms: number | null }[],
    sealed: db.prepare(`SELECT json_extract(facts, '$.history') AS history, json_extract(facts, '$.date_range.start') AS start,
      json_extract(facts, '$.date_range.end') AS end, json_extract(facts, '$.left') AS left FROM deliveries WHERE source = ? ORDER BY sealed_ms, id`).all(SOURCE) as
      { history: number | null; start: string | null; end: string | null; left: number | null }[],
  }));
}

type LaneCall = { target: string; outcome: string; reason: string | null; at_ms: number };
const callsSince = (root: string, since: number) => readHome(root, (db) => db.prepare("SELECT target, outcome, reason, at_ms FROM attempts WHERE target IN ('fetch:whoop', 'page:whoop') AND at_ms > ? GROUP BY target, at_ms ORDER BY at_ms").all(since)) as LaneCall[];
const lastCall = (root: string) => callsSince(root, -1).at(-1);

const days = (keys: readonly string[]) => keys.map((key) => `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6)}`);

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

describe("WHOOP's switch to the browser, on a home that read it before", () => {
  it("finds the account by its declaration, leaves one turned off unread, and reads the outage's days once the walk is started again, under the one source", async () => {
    const root = makeRoot("lifestream-whoop-upgrade-", {
      sources: {}, settings: { "connectors.whoop": { email: "person-a@example.com", timezone: ZONE, heart_rate_step: "10m", pace: "30s", start: "2026-07-22" } },
    });
    const site = fakeWhoop(ZONE);
    site.signIn();
    let ahead = 0;
    const clock = () => Date.now() + ahead;
    const at = (ms: number) => {
      site.now = ms;
      writeFileSync(join(root, JOURNEY_FILE), JSON.stringify({ now_ms: ms }));
    };
    let door: Awaited<ReturnType<typeof doorHere>> | undefined;
    let home: Home | undefined;
    const logs: string[] = [];
    let station: Station | undefined;
    const sock = testSocket(root);
    const start = async () => {
      home = await startHome(root, { stopGraceMs: 50, registry: REGISTRY, slot: null, log: (line) => logs.push(line), tickMs: TICK_MS, lookMs: LOOK_MS, clock });
    };
    const job = () => readHome(root, (db) => db.prepare("SELECT state FROM jobs WHERE kind = 'poll' AND key = 'whoop'").pluck().get()) as string | undefined;
    const rests = () => job() !== "queued" && job() !== "running";
    const surveyEnded = () => readHome(root, (db) => db.prepare("SELECT json_extract(detail, '$.signed_in') IS NOT NULL FROM events WHERE kind = 'sites' AND key = ? ORDER BY seq DESC LIMIT 1").pluck().get(UNIT)) === 1;
    const surveyed = async (what: string, seen: (site: Station["sites"][number]) => boolean) => {
      const asked = station!.surveys;
      station!.survey();
      await until(what, () => station!.surveys > asked && station!.sites.some((each) => each.id === "whoop" && seen(each)));
      await until(`${what}: the survey ended and WHOOP's poll rests`, () => surveyEnded() && rests());
    };
    const call = async (what: string) => {
      const before = lastCall(root)?.at_ms ?? 0;
      await askHome(sock, "run", ["poll", "whoop"]);
      await until(`${what}: the lane's calls ran`, () => (lastCall(root)?.at_ms ?? 0) > before && job() === "done");
      await until(`${what}: what it sealed is imported`, () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE state IN ('sealed', 'importing')").pluck().get()) === 0);
      return callsSince(root, before);
    };
    const walk = async (what: string) => {
      const pages: { target: string; outcome: string; left: number | null }[] = [];
      for (let page = 0; page < 8; page++) {
        ahead += PACE_MS + 1_000;
        const ran = await call(`${what}, page ${page + 1}`);
        const left = holding(root).backfills.find((row) => row.source === SOURCE)?.left ?? null;
        pages.push(...ran.map(({ target, outcome }) => ({ target, outcome, left })));
        if (ran.some((each) => each.target === "page:whoop") && left === 0) return pages;
      }
      throw new Error(`${what}: the walk did not end in 8 calls: ${JSON.stringify(pages)}`);
    };
    try {
      door = await doorHere(root, { registry: REGISTRY });
      at(BEFORE);
      await start();
      await makeVault(root);
      const pass = randomBytes(32).toString("base64url");
      const { code } = await askHome(sock, "pair") as { code: string };
      expect((await fetch(`${door.url}/v1/pair`, { method: "POST", headers: { ...DEVICE, "content-type": "application/json" }, body: JSON.stringify({ code, pass, kind: "extension", model: "Chrome", unit: UNIT }) })).status).toBe(200);
      station = new Station(door.url, pass, site);
      const drive = mintPrincipal(openHomeFolder(root), { unit: "test-driver", scopes: ["drive"], now_ms: Date.now() }).token;
      const verdictAt = async () => ((await (await fetch(`${door!.url}/v1/sites`, { headers: { authorization: `Bearer ${drive}` } })).json()) as
        { sites: { id: string; stations: { account: { email: string; verdict: string } | null }[] }[] }).sites.find((each) => each.id === "whoop")?.stations[0]?.account ?? null;
      void station.serve();
      await until("the station's first answer", () => station!.answers > 0);

      await askHome(sock, "connectors", ["on", "whoop"]);
      await surveyed("the survey saw WHOOP's account", (each) => each.signed_in === true);
      const walkedBefore = await walk("the walk before");
      expect(readHome(root, (db) => db.prepare("SELECT outcome FROM attempts WHERE target = 'fetch:whoop'").pluck().get())).toBe("ok");
      const before = holding(root);
      expect(before.sources.map((row) => [row.id, row.connector])).toEqual([[SOURCE, "whoop-capture"]]);
      expect(before.cycles[0]).toBe("20260722");
      expect(days(before.cycles).at(-1)).toBe(dayOf(BEFORE));
      const place = before.memory[`account ${ACCOUNT}`] as JsonObject;
      expect(Object.keys(before.memory)).toEqual([`account ${ACCOUNT}`, `sealed:${ACCOUNT} answers`]);

      await home!.stop();
      home = undefined;
      const written = openHome(openHomeFolder(root), "migrate");
      written.commit((tx) => {
        tx.tables.polls.leave("whoop", { source: SOURCE, state: canonical(place), start_ms: null, changes: { cleared: [], entries: [] } });
        tx.tables.sources.add({ id: OFF, vendor: vendorOf(declarations(), OFF), connector: "whoop-capture", added_ms: clock() });
      });
      written.close();
      editSettings(root, { "sources.off": [OFF] });
      const old = holding(root);
      expect([old.poll, old.memory]).toEqual([{ state: canonical(place), source: SOURCE }, {}]);
      expect(old.backfills).toEqual([{ source: SOURCE, acquirer: "whoop", left: 0, start_ms: Date.UTC(2026, 6, 22) }]);
      report.before = { sealed: old.sealed, sources: old.sources, heads: old.heads, cursor: { state: JSON.parse(old.poll!.state) as unknown, stamped: old.poll!.source }, memory: { before: before.memory, written: old.memory }, backfills: old.backfills, walk: walkedBefore, days: [old.cycles[0], old.cycles.at(-1)] };

      at(AFTER);
      ahead += DAY_MS;
      site.user = OTHER;
      site.cycles_user = OTHER;
      site.email = "person-b@example.com";
      const released = clock();
      await start();
      await until("the release's due poll and its start's survey ended", () => (lastCall(root)?.at_ms ?? 0) >= released && surveyEnded() && rests());

      await surveyed("the survey saw the other account", (each) => each.account?.email === "person-b@example.com");
      const verdicts: unknown[] = [await verdictAt()];
      expect(verdicts[0]).toEqual({ email: "person-b@example.com", verdict: "not-read" });
      const offCall = await call("signed in to the account turned off");
      expect(offCall).toEqual([expect.objectContaining({ target: "fetch:whoop", outcome: "wait", reason: "chrome" })]);
      const unread = holding(root);
      expect(unread.sources.map((row) => row.id)).toEqual([SOURCE, OFF]);
      expect(unread.heads[OFF]).toBeUndefined();
      expect(unread.heads[SOURCE]).toBe(old.heads[SOURCE]);

      site.user = ACCOUNT;
      site.cycles_user = ACCOUNT;
      site.email = "person-a@example.com";
      await surveyed("the survey saw the account again", (each) => each.account?.email === "person-a@example.com");
      verdicts.push(await verdictAt());
      expect(verdicts[1]).toEqual({ email: "person-a@example.com", verdict: "read" });
      ahead += 3_600_000;
      const today = await call("the release's first read");
      expect(today).toEqual([expect.objectContaining({ target: "fetch:whoop", outcome: "ok" })]);
      const fresh = holding(root);
      const cursor = JSON.parse(fresh.poll!.state) as JsonObject;
      expect([fresh.poll!.source, Object.keys(cursor)]).toEqual(["whoop", ["polled_ms"]]);
      expect(Object.keys(fresh.memory)).toEqual([`account ${ACCOUNT}`, `sealed:${ACCOUNT} answers`]);
      const edge = (fresh.memory[`account ${ACCOUNT}`] as { reached_day: string }).reached_day;
      const overlapped = dayOf(Date.parse(`${edge}T00:00:00Z`) - DAY_MS);
      const outage = (keys: readonly string[]) => days(keys).filter((day) => day > dayOf(BEFORE) && day < overlapped);
      expect(edge > dayOf(BEFORE + 7 * DAY_MS)).toBe(true);
      expect(outage(fresh.cycles)).toEqual([]);
      expect(days(fresh.cycles).filter((day) => day > dayOf(BEFORE))[0]).toBe(overlapped);
      expect(days(fresh.cycles).at(-1)).toBe(dayOf(AFTER));
      expect(fresh.backfills).toEqual([{ source: SOURCE, acquirer: "whoop", left: 0, start_ms: Date.UTC(2026, 6, 22) }]);
      report.release = { verdicts, off: offCall, cursor, stamped: fresh.poll!.source, memory: fresh.memory, heads: fresh.heads, days_read: days(fresh.cycles).filter((day) => day > dayOf(BEFORE)) };

      const restarted = await askHome(sock, "connectors", ["backfill", "whoop", "now"]);
      const walked = await walk("the walk again");
      const after = holding(root);
      const expected: string[] = [];
      for (let day = dayOf(BEFORE + DAY_MS); day < overlapped; day = dayOf(Date.parse(`${day}T00:00:00Z`) + DAY_MS)) expected.push(day);
      expect(outage(after.cycles)).toEqual(expected);
      const pages = after.sealed.slice(fresh.sealed.length).filter((each) => each.history === 1);
      expect(pages[0]!.end).toBe(dayOf(Date.parse(`${edge}T00:00:00Z`) - DAY_MS));
      expect(pages[0]!.start! <= dayOf(BEFORE + DAY_MS)).toBe(true);
      expect(pages.at(-1)!.left).toBe(0);
      expect(after.cycles[0]).toBe("20260722");
      expect(days(after.cycles).at(-1)).toBe(dayOf(AFTER));
      const span = Math.round((Date.parse(`${dayOf(AFTER)}T00:00:00Z`) - Date.parse("2026-07-22T00:00:00Z")) / DAY_MS) + 1;
      expect(after.cycles).toHaveLength(span);
      expect(after.sources.map((row) => row.id)).toEqual([SOURCE, OFF]);
      expect(Object.keys(after.heads).filter((source) => source.startsWith("whoop")).sort()).toEqual([SOURCE]);
      expect(after.backfills).toEqual([{ source: SOURCE, acquirer: "whoop", left: 0, start_ms: Date.UTC(2026, 6, 22) }]);
      expect(station.begun.filter((name) => name === "whoop").length).toBeGreaterThan(0);
      report.walk = { verb: restarted, calls: walked, sealed: after.sealed.slice(fresh.sealed.length), cursor: JSON.parse(after.poll!.state) as unknown, memory: after.memory, backfills: after.backfills };
      report.landed = { before: old.heads, release: fresh.heads, after: after.heads, outage: expected, sources: after.sources };
    } finally {
      report.wire = { begun: station?.begun, calls: [...new Set(station?.calls)].map((op) => `${op} x${station!.calls.filter((each) => each === op).length}`), door: door?.logs.filter((line) => !line.includes('"transcript"')).slice(-40) };
      report.home_log = logs.filter((line) => /whoop|survey|station|error|fail/iu.test(line)).slice(-60);
      station?.stop();
      await home?.stop();
      await door?.stop();
      rmSync(join(root, JOURNEY_FILE), { force: true });
      removeRoot(root);
    }
  });
});
