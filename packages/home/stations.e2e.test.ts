import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { openLedger } from "@lifestreamprotocol/model";
import { surveyed } from "./door.js";
import { machine } from "./machine.js";
import { homeOf, loadRegistry } from "./registry.js";
import { act } from "./verbs/act.js";
import type { StreamsReport } from "./streams-report.js";
import { startHome, type Home } from "./home.js";
import { mintPrincipal, readPrincipals } from "./principals.js";
import { chromeSites, declarations, type Connector } from "@lifestreamprotocol/connect";
import { openHome, openHomeFolder, type FileKind, type HomeFolder, type JsonObject, type KeptFile } from "@lifestreamprotocol/core";
import { keyedFolder } from "@lifestreamprotocol/core/test/keyed";
import { ask, askHome } from "./socket.js";
import { budgetOf, openStations, serveStations, type Entry } from "./stations.js";
import { CALL_SLACK_MS, FETCH_MS } from "./errand.js";
import { Refusal } from "./refusal.js";
import { effective } from "./settings.js";
import { readOpsSettings } from "./verbs/context.js";
import { RETRY_MS } from "./status.js";
import { editSettings, testSocket } from "./test/folder.js";
import { ChildHome, FAKES, LOOK_MS, makeRoot, makeVault, readHome, removeRoot, steppedClock, TICK_MS, until } from "./test/harness-root.js";
import { doorHere } from "./test/harness-door.js";
import { fakeDeclarations } from "./test/fakes.js";
import { statusOf } from "./test/harness-status.js";

const report: Record<string, unknown> = {};
const UNIT = "chrome-5550aa01";
const OTHER = "chrome-5550aa02";
const THIRD = "chrome-5550aa03";
const PASSWORD = "pw-synthetic-0001";
const EXPORT = randomBytes(128 * 1024 + 17);
type DoorHandle = Awaited<ReturnType<typeof doorHere>>;
const openFakeDoor = (root: string) => doorHere(root, { registry: FAKES, connectors: fakeDeclarations(), needsMs: 20 });
const DEVICE = { "lifestream-device": "extension/1.0.0" };
const HAND_LOADED = "chrome-extension://bioodomopbikaidodldikkkinnpfddin";
const fetched = (root: string, acquirer: string) => readHome(root, (db) => db.prepare("SELECT outcome, reason, detail, at_ms, contact_ms FROM attempts WHERE target = ? ORDER BY at_ms DESC LIMIT 1").get(`fetch:${acquirer}`)) as
  { outcome: string; reason: string | null; detail: string | null; at_ms: number; contact_ms: number | null } | undefined;
const needing = (root: string, acquirer: string) => readHome(root, (db) => db.prepare("SELECT count(*) FROM attempts WHERE target IN (?, ?) AND outcome = 'need'").pluck().get(`fetch:${acquirer}`, `page:${acquirer}`)) as number;
const CLAUDE_A = "11111111-1111-4111-8111-00000000000a";
const CLAUDE_B = "22222222-2222-4222-8222-00000000000b";

afterAll(() => {
  const directory = join(tmpdir(), "lifestream-home-ops-e2e");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "stations.json"), `${JSON.stringify(report, null, 2)}\n`);
});

type Need = StreamsReport["needs"][number];

class Station {
  password = true;
  verify = false;
  botCheck = false;
  readonly #at = new Map<string, string>();
  readonly tabs: string[] = [];
  readonly filled = new Map<string, string>();
  needs: Need[] = [];
  begun = 0;
  readonly begunNames: string[] = [];
  chosen: string[] = [];
  pressed: { choose: string[]; stop: string[] } = { choose: [], stop: [] };
  allowing: string[] = [];
  withheld: string[] | null = null;
  signedIn: boolean | null = null;
  as = { id: CLAUDE_A, email: "person-a@example.com" };
  survey = false;
  holding = false;
  heldFetches = 0;
  #release: (() => void) | null = null;
  sites: { id: string; [member: string]: unknown }[] = [];
  readonly answered: { pressed: { choose: string[]; stop: string[] }; survey: boolean; needs: string[]; chosen: string[]; calls: number }[] = [];
  answers = 0;
  failures = 0;
  readonly opened: string[] = [];
  readonly acted: { need: string; do: string; of?: string }[] = [];
  readonly #results: unknown[] = [];
  readonly #errands = new Set<string>();
  #stopped = false;
  readonly #boot = randomBytes(6).toString("hex");
  #inflight: AbortController | null = null;
  intruder?: string;
  readonly intruded: number[] = [];

  constructor(private readonly door: string, private readonly pass: string, private readonly unit = UNIT) {}

  #headers(type?: string): Record<string, string> {
    return { authorization: `Bearer ${this.pass}`, ...DEVICE, ...(type === undefined ? {} : { "content-type": type }) };
  }

  async serve(): Promise<void> {
    while (!this.#stopped) {
      await this.#exchange();
      if (this.#gate === null) continue;
      this.gated = true;
      await this.#gate;
      this.gated = false;
    }
  }

  #gate: Promise<void> | null = null;
  #open: (() => void) | null = null;
  gated = false;
  pause(): void {
    this.#gate = new Promise((resolve) => (this.#open = resolve));
  }
  go(): void {
    const open = this.#open;
    this.#gate = null;
    this.#open = null;
    open?.();
  }

  cutShort(): void {
    this.#inflight?.abort();
  }

  press(choose: string[], stop: string[] = []): void {
    this.pressed = {
      choose: [...new Set([...this.pressed.choose.filter((id) => !stop.includes(id)), ...choose])],
      stop: [...new Set([...this.pressed.stop.filter((id) => !choose.includes(id)), ...stop])],
    };
    this.cutShort();
  }

  async #exchange(): Promise<void> {
    const opened = this.opened.splice(0);
    const acted = this.acted.splice(0);
    const results = this.#results.splice(0);
    const pressed = { choose: [...this.pressed.choose], stop: [...this.pressed.stop] };
    const survey = this.survey;
    this.survey = false;
    const exchanging = new AbortController();
    this.#inflight = exchanging;
    let answer: { calls: { id: string; errand: string; op: string; [member: string]: unknown }[]; needs: Need[]; sites: { id: string; origin: string }[]; chosen: string[] };
    try {
      const response = await fetch(`${this.door}/v1/stations/exchange`, {
        method: "POST", headers: this.#headers("application/json"), signal: exchanging.signal,
        body: JSON.stringify({
          results,
          station: {
            unit: this.unit, version: "1.0.0", slots: 2, errands: [...this.#errands], boot: this.#boot, running: [], pressed, allowing: [...this.allowing], opened, acted,
            ...(survey ? { survey: true } : {}), ...(this.withheld === null ? {} : { withheld: [...this.withheld] }),
          },
        }),
      });
      if (!response.ok) throw new Error(`exchange answered ${response.status}`);
      answer = await response.json() as typeof answer;
    } catch {
      this.opened.unshift(...opened);
      this.acted.unshift(...acted);
      this.#results.unshift(...results);
      if (survey) this.survey = true;
      if (exchanging.signal.aborted) return;
      this.failures++;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return;
    } finally {
      this.#inflight = null;
    }
    this.answers++;
    this.needs = answer.needs;
    this.sites = answer.sites;
    this.chosen = answer.chosen;
    this.pressed = { choose: this.pressed.choose.filter((id) => !pressed.choose.includes(id)), stop: this.pressed.stop.filter((id) => !pressed.stop.includes(id)) };
    this.answered.push({ pressed, survey, needs: answer.needs.map((need) => need.id), chosen: answer.chosen, calls: answer.calls.length });
    for (const call of answer.calls) this.#results.push({ id: call.id, ...(await this.#handle(call)) });
  }

  release(): void {
    this.holding = false;
    this.#release?.();
  }

  stop(): void {
    this.#stopped = true;
    this.#release?.();
    this.go();
    this.#inflight?.abort();
  }

  async #handle(call: { id: string; errand: string; op: string; [member: string]: unknown }): Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }> {
    const ok = (value: unknown) => ({ ok: true as const, value });
    switch (call.op) {
      case "begin":
        this.#errands.add(call.errand);
        this.begun++;
        this.begunNames.push((call.spec as { name: string }).name);
        return ok({ begun: true });
      case "end":
        this.#errands.delete(call.errand);
        return ok({ ended: true });
      case "open": {
        const site = this.sites.find((each) => typeof each.origin === "string" && (call.url as string).startsWith(each.origin));
        if (site !== undefined && this.withheld?.includes(site.id) === true) return { ok: false, error: { code: "SITE_NOT_ALLOWED", message: `the extension may not act on ${site.origin as string}` } };
        this.tabs.push(call.errand);
        this.#at.set(call.errand, call.url as string);
        return ok({ tab: 7, url: call.url });
      }
      case "fetch": {
        const requests = call.requests as { url: string; as: "json" | "file"; name?: string; hold?: { name: string } }[];
        if (requests.every((request) => request.as === "file")) {
          const kept: unknown[] = [];
          for (const request of requests) {
            const path = `${this.door}/v1/stations/files/${call.errand}/${request.name!}`;
            if (this.intruder !== undefined) await this.#intrude(path, call.id);
            const parts = [EXPORT.subarray(0, 64 * 1024), EXPORT.subarray(64 * 1024)];
            for (const [index, part] of parts.entries()) {
              const put = await fetch(`${path}?part=${index}`, { method: "PUT", headers: this.#headers("application/octet-stream"), body: part });
              if (!put.ok) return { ok: false, error: { code: "DOWNLOAD_FAILED", message: `part ${index} answered ${put.status}` } };
            }
            const done = await fetch(`${path}?done=${parts.length}`, { method: "POST", headers: this.#headers() });
            kept.push({ status: 200, url: request.url, file: await done.json() });
          }
          return ok(kept);
        }
        const signedIn = this.signedIn;
        if (this.holding) {
          this.heldFetches++;
          await new Promise<void>((resolve) => (this.#release = resolve));
        }
        if (signedIn === null) return { ok: false, error: { code: "BAD_CALL", message: "fetch is not played" } };
        if (this.botCheck) return ok(requests.map((request) => ({ status: 403, url: request.url })));
        const body = (url: string) => (url.includes("/backend-api/me") ? { id: `user-${this.as.id}`, email: this.as.email } : { uuid: this.as.id, email_address: this.as.email });
        return ok(requests.map((request) => !signedIn ? { status: 401, url: request.url }
          : request.hold !== undefined ? { status: 200, url: request.url, held: request.hold.name } : { status: 200, url: request.url, json: body(request.url) }));
      }
      case "snapshot": {
        const url = this.#at.get(call.errand) ?? "https://site.example/";
        const own = new URL(url).hostname === "site.example";
        return ok({ url, title: own ? "Site" : this.botCheck ? "Just a moment..." : "Home", lines: "",
          signals: { captcha: !own && this.botCheck, otp: false, password: own && this.password, verify: own && this.verify } });
      }
      case "fill": {
        const value = call.value as { secret: string; value: string };
        this.filled.set(value.secret, value.value);
        return ok({ filled: true });
      }
      default:
        return { ok: false, error: { code: "BAD_CALL", message: `${call.op} is not played` } };
    }
  }

  async #intrude(path: string, call: string): Promise<void> {
    const headers = { authorization: `Bearer ${this.intruder!}`, ...DEVICE };
    this.intruded.push((await fetch(`${path}?part=0`, { method: "PUT", headers: { ...headers, "content-type": "application/octet-stream" }, body: EXPORT.subarray(0, 64) })).status);
    const exchange = await fetch(`${this.door}/v1/stations/exchange`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        results: [{ id: call, ok: false, error: { code: "DOWNLOAD_FAILED", message: "not this station's" } }],
        station: { unit: OTHER, version: "1.0.0", slots: 2, errands: [], boot: "other", running: [], opened: [] },
      }),
    }).catch(() => null);
    this.intruded.push(exchange?.status ?? 0);
  }
}

describe("the door's stations", () => {
  it("pairs an extension by a code, lets the home drive it on its own pass, shows a need at once, hears it opened, moves its file into a delivery and keeps its secret out of every log", async () => {
    const root = makeRoot("lifestream-stations-", { sources: {}, settings: { "connectors.fake-errand": {} } });
    mkdirSync(join(root, "config", "secrets"), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, "config", "secrets", "fake.password"), PASSWORD, { mode: 0o600 });
    const worked = openHome(openHomeFolder(root), "migrate");
    worked.commit((tx) => tx.tables.attempts.put({ target: "fetch:fake-errand", source: "", outcome: "ok", reason: null, facts: {}, detail: null, since_ms: 1, at_ms: 1, contact_ms: 1, fails: 0 }));
    worked.close();
    let door: DoorHandle | undefined;
    const home = new ChildHome(root);
    const station = { current: undefined as Station | undefined };
    try {
      door = await openFakeDoor(root);
      home.start();
      await home.ready();
      await makeVault(root);
      const sock = testSocket(root);

      const pass = randomBytes(32).toString("base64url");
      const pair = (body: Record<string, unknown>) => fetch(`${door!.url}/v1/pair`, { method: "POST", headers: { ...DEVICE, "content-type": "application/json" }, body: JSON.stringify(body) });
      const { code } = await askHome(sock, "pair") as { code: string };
      const paired = await pair({ code, pass, kind: "extension", model: "Chrome", unit: UNIT });
      expect(paired.status).toBe(200);
      expect(await paired.json()).toMatchObject({ unit: UNIT });
      const row = readPrincipals(openHomeFolder(root)).principals.find((principal) => principal.unit === UNIT)!;
      expect(row).toMatchObject({ kind: "extension", scopes: ["station"], sources: [] });
      expect(readFileSync(join(root, "config", "principals.json"), "utf8")).not.toContain(pass);
      const { code: again } = await askHome(sock, "pair") as { code: string };
      expect((await pair({ code: again, pass: randomBytes(32).toString("base64url"), kind: "extension", model: "Chrome", unit: UNIT })).status).toBe(409);
      expect((await pair({ code: again, pass: randomBytes(32).toString("base64url"), kind: "extension", model: "Chrome" })).status).toBe(422);
      expect((await fetch(`${door.url}/v1/stations`, { headers: { authorization: `Bearer ${pass}` } })).status).toBe(403);
      expect((await fetch(`${door.url}/v1/stations`)).status).toBe(401);
      expect(readPrincipals(openHomeFolder(root)).principals.filter((principal) => principal.scopes.includes("drive"))).toHaveLength(1);

      const { code: third } = await askHome(sock, "pair") as { code: string };
      const other = randomBytes(32).toString("base64url");
      expect((await pair({ code: third, pass: other, kind: "extension", model: "Chrome", unit: OTHER })).status).toBe(200);

      station.current = new Station(door.url, pass);
      void station.current.serve();
      await until("the station's first answer", () => station.current!.answers > 0);
      expect(station.current.sites).toEqual([
        { id: "chatgpt", name: "ChatGPT", origin: "https://chatgpt.com", origins: ["https://chatgpt.com"], signed_in: null, account: null },
        { id: "claude", name: "Claude", origin: "https://claude.ai", origins: ["https://claude.ai"], signed_in: null, account: null },
        { id: "whoop", name: "WHOOP", origin: "https://app.whoop.com", form: true, origins: ["https://app.whoop.com", "https://id.whoop.com", "https://api.prod.whoop.com"], signed_in: null, account: null },
      ]);

      await askHome(sock, "run", ["poll", "fake-errand"]);
      await until("the poll needs the person", () => needing(root, "fake-errand") > 0);
      const answered = station.current.answers;
      await until("the station answered again", () => station.current!.answers > answered);
      expect(station.current.needs.map(({ id, words, at }) => ({ id, words, site: at?.site }))).toEqual([{ id: "fetch:fake-errand", words: "Sign in to Notes in Chrome", site: "site.example" }]);
      expect([station.current.needs[0]!.at?.open, ...station.current.needs[0]!.acts.flatMap((act) => (act.do === "open" ? [act.url] : []))]).toContain("https://site.example/");
      report.need = { needs: station.current.needs, answers: station.current.answers - answered };

      station.current.password = false;
      station.current.intruder = other;
      station.current.opened.push("fetch:fake-errand");
      station.current.cutShort();
      await until("the home heard it opened", () => readHome(root, (db) => db.prepare("SELECT detail FROM events WHERE kind = 'opened' AND key = 'fetch:fake-errand'").pluck().get()) !== undefined);
      expect(JSON.parse(readHome(root, (db) => db.prepare("SELECT detail FROM events WHERE kind = 'opened'").pluck().get() as string))).toEqual({ unit: UNIT });
      await until("the opened need's poll sealed", () => fetched(root, "fake-errand")?.outcome === "ok" && fetched(root, "fake-errand")!.contact_ms! > 1);
      expect(needing(root, "fake-errand")).toBe(0);
      await until("the need left the station", () => station.current!.needs.length === 0);
      expect(station.current.filled.get("fake.password")).toBe(PASSWORD);
      expect(station.current.intruded).toEqual([403, 200]);

      const lane = join(root, "inbox", "fake-errand:local:station");
      const [name] = readdirSync(lane).filter((entry) => entry !== "blobs");
      const manifest = JSON.parse(readFileSync(join(lane, name!, "manifest.json"), "utf8")) as { files: { file: string; sha256: string; bytes: number }[]; facts: { door_ino: number; door_path: string; sha256: string } };
      expect(manifest.files).toEqual([{ file: "export.bin", sha256: createHash("sha256").update(EXPORT).digest("hex"), bytes: EXPORT.length }]);
      expect(manifest.facts.sha256).toBe(manifest.files[0]!.sha256);
      expect(statSync(join(lane, name!, "export.bin")).ino).toBe(manifest.facts.door_ino);
      expect(manifest.facts.door_path.startsWith(join(root, "door", "stations"))).toBe(true);
      expect(existsSync(manifest.facts.door_path)).toBe(false);
      report.delivery = manifest;

      const transcript = door.logs.filter((line) => line.includes('"transcript"'));
      expect(transcript.some((line) => line.includes('"secrets":["fake.password"]'))).toBe(true);
      expect(door.logs.join("\n")).not.toContain(PASSWORD);
      expect(readFileSync(join(root, "logs", "home.log"), "utf8")).not.toContain(PASSWORD);
      report.transcript = transcript.map((line) => JSON.parse(line) as unknown);
    } finally {
      station.current?.stop();
      await door?.stop();
      await home?.stop();
      removeRoot(root);
    }
  });

  it("refuses a lane's next poll busy while the errand it left for the person stands, or begins it another once they have settled it", async () => {
    const root = makeRoot("lifestream-stations-left-", { sources: {}, settings: { "connectors.fake-errand": {} } });
    mkdirSync(join(root, "config", "secrets"), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, "config", "secrets", "fake.password"), PASSWORD, { mode: 0o600 });
    let door: DoorHandle | undefined;
    let home: Home | undefined;
    let station: Station | undefined;
    try {
      door = await openFakeDoor(root);
      home = await startHome(root, { stopGraceMs: 50, registry: FAKES, slot: null, log: () => undefined, tickMs: TICK_MS, lookMs: LOOK_MS });
      await makeVault(root);
      const sock = testSocket(root);
      const pass = randomBytes(32).toString("base64url");
      const { code } = await askHome(sock, "pair") as { code: string };
      expect((await fetch(`${door.url}/v1/pair`, { method: "POST", headers: { ...DEVICE, "content-type": "application/json" }, body: JSON.stringify({ code, pass, kind: "extension", model: "Chrome", unit: UNIT }) })).status).toBe(200);
      station = new Station(door.url, pass);
      station.password = false;
      station.verify = true;
      void station.serve();
      await until("the station's first answer", () => station!.answers > 0);
      const poll = () => fetched(root, "fake-errand");
      const begun = () => station!.begunNames.filter((name) => name === "fake-errand").length;
      const ended = () => (readHome(root, (db) => db.prepare("SELECT ended_ms FROM jobs WHERE kind = 'poll' AND key = 'fake-errand' AND state = 'done'").pluck().get()) as number | undefined) ?? 0;

      await askHome(sock, "run", ["poll", "fake-errand"]);
      await until("the need on the station", () => station!.needs.some((need) => need.id === "fetch:fake-errand"));
      const left = station.needs.find((need) => need.id === "fetch:fake-errand")!.at?.errand;
      expect({ left: typeof left, begun: begun() }).toEqual({ left: "string", begun: 1 });

      const first = ended();
      await askHome(sock, "run", ["poll", "fake-errand"]);
      await until("the second poll ended", () => ended() > first);
      expect({ outcome: poll()!.outcome, reason: poll()!.reason, begun: begun(), tabs: station.tabs.filter((errand) => errand === left).length }).toEqual({ outcome: "need", reason: "confirm", begun: 1, tabs: 2 });
      expect(station.needs.find((need) => need.id === "fetch:fake-errand")!.at?.errand).toBe(left);

      station.verify = false;
      const second = ended();
      station.opened.push("fetch:fake-errand");
      station.cutShort();
      await until("the opened need's poll ended", () => ended() > second);
      expect({ outcome: poll()!.outcome, need: needing(root, "fake-errand"), begun: begun() }).toEqual({ outcome: "ok", need: 0, begun: 1 });
      await until("the need left the station", () => station!.needs.length === 0);
      report.left = { begun: station.begunNames, tabs: station.tabs };
    } finally {
      station?.stop();
      await door?.stop();
      await home?.stop();
      removeRoot(root);
    }
  });

  it("polls a site's lane before the home chose it, after it is stopped, or lands its delivery nowhere; answers one browser a list the other's press left out", async () => {
    const stated = "claude:11111111-1111-4111-8111-111111111111:browser";
    const root = makeRoot("lifestream-stations-sites-", { sources: {}, clocks: true });
    const before = openHome(openHomeFolder(root), "migrate");
    before.commit((tx) => tx.tables.attempts.put({ target: "fetch:claude-browser", source: "", outcome: "fail", reason: "failing", facts: {}, detail: "synthetic outage from before", since_ms: 0, at_ms: 0, contact_ms: null, fails: 1 }));
    before.close();
    const attempts = join(root, "claude-browser-attempts");
    const beats = join(root, "fake-poll-attempts");
    const hold = join(root, "claude-browser-hold");
    writeFileSync(hold, "");
    editSettings(root, { "connectors.claude": { refresh: "5m", states: [stated], attempts, hold }, "connectors.fake-poll": { refresh: "1s", attempts: beats } });
    const count = (file: string) => (existsSync(file) ? readFileSync(file).length : 0);
    const polls = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE kind = 'poll' AND key = 'claude-browser'").pluck().get()) as number;
    const drive = mintPrincipal(openHomeFolder(root), { unit: "test-driver", scopes: ["drive"], now_ms: Date.now() }).token;
    let door: DoorHandle | undefined;
    let home: Home | undefined;
    const stations: Station[] = [];
    const clock = steppedClock(root, "fake-poll", 1_000);
    try {
      door = await openFakeDoor(root);
      home = await startHome(root, { stopGraceMs: 50, registry: FAKES, clock: clock.now, slot: null, log: () => undefined, tickMs: TICK_MS, lookMs: LOOK_MS });
      const driving = { authorization: `Bearer ${drive}`, "content-type": "application/json" };
      const chosen = async () => ((await (await fetch(`${door!.url}/v1/sites`, { headers: driving })).json()) as { sites: { id: string; chosen: boolean }[] }).sites.find((site) => site.id === "claude")!.chosen;
      for (const unit of [UNIT, OTHER]) {
        const pass = randomBytes(32).toString("base64url");
        const { code } = await askHome(testSocket(root), "pair") as { code: string };
        const paired = await fetch(`${door.url}/v1/pair`, { method: "POST", headers: { ...DEVICE, "content-type": "application/json" }, body: JSON.stringify({ code, pass, kind: "extension", model: "Chrome", unit }) });
        expect(paired.status).toBe(200);
        stations.push(new Station(door.url, pass, unit));
      }
      const [chooser, other] = stations as [Station, Station];
      for (const station of stations) void station.serve();
      await until("both stations' first answers", () => stations.every((station) => station.answers > 0));

      const asked = count(beats);
      await clock.stepUntil("two ticks of the other lane", () => count(beats) >= asked + 2);
      expect({ jobs: polls(), fetches: count(attempts) }).toEqual({ jobs: 0, fetches: 0 });
      const unchosen = ((await askHome(testSocket(root), "connectors")) as StreamsReport).connectors.find((each) => each.id === "claude")!;
      expect([unchosen.health.state, unchosen.health.reason, fetched(root, "claude-browser")?.detail]).toEqual(["setup", "choose", "synthetic outage from before"]);
      expect(statusOf(root, { now_ms: Date.now() + 3_600_000, settings: readOpsSettings(root) }).needs.filter((need) => need.id.startsWith("fetch:claude-browser"))).toEqual([]);
      const begin = await fetch(`${door.url}/v1/errands`, { method: "POST", headers: driving, body: JSON.stringify({ spec: { name: "test", origins: ["https://claude.ai"], deadline_ms: 60_000 }, site: "claude", wait_ms: 15 * 60_000 }) });
      expect({ status: begin.status, ...((await begin.json()) as { code: string; message: string }) }).toEqual({ status: 503, code: "NO_STATION", message: "Claude is not chosen: Lifestream reads it in no Chrome" });

      chooser.signedIn = true;
      chooser.holding = true;
      chooser.survey = true;
      chooser.press(["claude"]);
      await until("the survey's probe is held", () => chooser.heldFetches > 0);
      const held = count(beats);
      await clock.stepUntil("two ticks while the probe is held", () => count(beats) >= held + 2);
      expect(polls()).toBe(0);
      chooser.release();
      await clock.stepUntil("the chosen lane's poll queued", () => polls() > 0);
      const queued = readHome(root, (db) => db.prepare("SELECT state FROM jobs WHERE kind = 'poll' AND key = 'claude-browser'").get()) as { state: string };
      await until("the chosen lane's poll is fetching", () => existsSync(`${hold}.held`));
      const fetching = ((await askHome(testSocket(root), "connectors")) as StreamsReport).connectors.find((each) => each.id === "claude")!;
      expect({ set_up: fetching.set_up, signed_in: fetching.signed_in }).toEqual({ set_up: true, signed_in: true });
      expect({ chooser: chooser.chosen, other: other.chosen, settings: effective(root).settings.sites.chosen }).toEqual({ chooser: ["claude"], other: ["claude"], settings: ["claude"] });
      report.fetching = { queued, line: fetching.line };
      rmSync(hold);
      await until("the chosen site's delivery imported", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE source = ? AND state = 'imported'").pluck().get(stated)) as number >= 1);
      const made = readHome(root, (db) => db.prepare("SELECT connector, options FROM sources WHERE id = ?").get(stated)) as { connector: string; options: string };
      expect({ ...made, options: JSON.parse(made.options) }).toEqual({ connector: "fake-rows", options: { lane: "claude-browser" } });
      const lanes = (station: Station) => station.begunNames.filter((name) => !name.startsWith("probe:")).length;
      expect({ ran: lanes(chooser) + lanes(other) > 0, probed: stations.every((station) => station.begunNames.includes("probe:claude")) }).toEqual({ ran: true, probed: true });

      other.press([], ["claude"]);
      await until("both browsers answered the list without Claude", () => chooser.chosen.length === 0 && other.chosen.length === 0);
      expect(await chosen()).toBe(false);
      const ran = { chooser: lanes(chooser), other: lanes(other) };
      const after = count(beats);
      await clock.stepUntil("a tick after it", () => count(beats) >= after + 1);
      const stopped = { fetches: count(attempts), beats: count(beats) };
      await clock.stepUntil("two ticks more", () => count(beats) >= stopped.beats + 2);
      expect(count(attempts)).toBe(stopped.fetches);
      expect({ chooser: lanes(chooser), other: lanes(other) }).toEqual(ran);
      report.sites = { stopped, made, errands: { chooser: chooser.begunNames, other: other.begunNames } };
    } finally {
      for (const station of stations) station.stop();
      await door?.stop();
      await home?.stop();
      removeRoot(root);
    }
  });

  it("misses a sign-in made after the first survey, runs two surveys of a station at once or one per ask, lets a probe that could not tell undo a sign-in, or leaves a look unsaid", async () => {
    const root = makeRoot("lifestream-stations-survey-", { sources: {} });
    let door: DoorHandle | undefined;
    let home: Home | undefined;
    let station: Station | undefined;
    try {
      door = await openFakeDoor(root);
      home = await startHome(root, { stopGraceMs: 50, registry: FAKES, slot: null, log: () => undefined, tickMs: TICK_MS, lookMs: LOOK_MS });
      const sock = testSocket(root);
      const pass = randomBytes(32).toString("base64url");
      const { code } = await askHome(sock, "pair") as { code: string };
      const paired = await fetch(`${door.url}/v1/pair`, { method: "POST", headers: { ...DEVICE, "content-type": "application/json" }, body: JSON.stringify({ code, pass, kind: "extension", model: "Chrome", unit: UNIT }) });
      expect(paired.status).toBe(200);
      const drive = mintPrincipal(openHomeFolder(root), { unit: "test-driver", scopes: ["drive"], now_ms: Date.now() }).token;
      const driving = { authorization: `Bearer ${drive}`, "content-type": "application/json" };
      station = new Station(door.url, pass, UNIT);
      station.signedIn = false;
      station.holding = true;
      void station.serve();
      const signedIn = (id: string) => station!.sites.find((site) => site.id === id)?.signed_in;
      const probes = () => station!.begunNames.filter((name) => name.startsWith("probe:"));
      const surveyed = () => door!.logs.filter((line) => line.includes('"method":"PUT","path":"/v1/sites"')).length;
      await until("the first survey's first probe is held", () => station!.heldFetches === 1);
      const checking = async () => ((await (await fetch(`${door!.url}/v1/sites`, { headers: driving })).json()) as { sites: { checking: boolean }[] }).sites.map((site) => site.checking);
      expect(await checking()).toEqual([true, true, true]);

      station.signedIn = true;
      const popup = { verb: "stations", unit: UNIT, first: false, survey: true, choose: [], stop: [] };
      const asks = [await ask(sock, popup), await ask(sock, popup)];
      expect(asks).toEqual([{ turned: [], survey: "after", covers: expect.any(Number) }, { turned: [], survey: "after", covers: expect.any(Number) }]);
      expect((asks[0] as { covers: number }).covers).toBe((asks[1] as { covers: number }).covers);
      station.release();
      await until("the survey asked meanwhile reached the popup", () => signedIn("claude") === true && signedIn("chatgpt") === true);
      expect(await checking()).toEqual([false, false, false]);
      const sitesEvents = () => readHome(root, (db) => (db.prepare("SELECT key, detail FROM events WHERE kind = 'sites' ORDER BY seq").all() as { key: string; detail: string }[])
        .map((row) => [row.key, JSON.parse(row.detail)]));
      await until("the feed said the sign-ins changed", () => sitesEvents().length === 4);
      expect(sitesEvents()).toEqual([
        [UNIT, { checking: true }],
        [UNIT, { signed_in: { chatgpt: false, claude: true, whoop: true } }],
        [UNIT, { checking: true }],
        [UNIT, { signed_in: { chatgpt: true } }],
      ]);
      const begun = await fetch(`${door.url}/v1/errands`, { method: "POST", headers: driving, body: JSON.stringify({ spec: { name: "marker", origins: ["https://example.com"], deadline_ms: 60_000 }, wait_ms: 30_000 }) });
      expect(begun.status).toBe(201);
      await until("the marker errand began", () => station!.begunNames.includes("marker"));
      expect(station.begunNames).toEqual(["probe:chatgpt", "probe:claude", "probe:whoop", "probe:chatgpt", "probe:claude", "probe:whoop", "marker"]);
      await fetch(`${door.url}/v1/errands/${((await begun.json()) as { errand: string }).errand}`, { method: "DELETE", headers: driving });

      station.holding = true;
      station.survey = true;
      station.cutShort();
      await until("the popup's survey's first probe is held", () => station!.heldFetches === 2);
      expect(await checking()).toEqual([true, true, true]);
      station.release();
      await until("the popup's survey put what it found", () => surveyed() === 3);
      expect(await checking()).toEqual([false, false, false]);
      expect(probes()).toHaveLength(9);
      await until("the feed said the popup's survey ended", () => sitesEvents().length === 6);
      expect(sitesEvents().slice(4)).toEqual([[UNIT, { checking: true }], [UNIT, { signed_in: {} }]]);
      expect(station.answered.some((each) => each.survey)).toBe(true);

      const put = await fetch(`${door.url}/v1/sites`, {
        method: "PUT", headers: driving,
        body: JSON.stringify({ station: UNIT, sites: chromeSites(declarations()).map((site) => ({ id: site.id, name: site.name, origin: site.origin, signed_in: site.id === "chatgpt" ? false : null })) }),
      });
      expect(put.status).toBe(200);
      const held = ((await (await fetch(`${door.url}/v1/sites`, { headers: driving })).json()) as { sites: { id: string; signed_in: boolean | null }[] }).sites;
      expect(held.map((site) => [site.id, site.signed_in])).toEqual([["chatgpt", false], ["claude", true], ["whoop", true]]);

      station.holding = true;
      station.survey = true;
      station.cutShort();
      await until("the next popup's survey's first probe is held", () => station!.heldFetches === 3);
      expect(await checking()).toEqual([true, true, true]);
      const told = sitesEvents().length;
      const puts = surveyed();
      const orphan = station.tabs.at(-1)!;
      const deletes = () => door!.logs.filter((line) => line.includes('"method":"DELETE","path":"/v1/errands/<id>"')).length;
      const deleted = deletes();
      await home.stop();
      station.release();
      await until("the door ended the stopped home's probe", () => door!.logs.some((line) => line.includes(`"errand":"${orphan}","op":"end"`)));
      expect(await checking()).toEqual([true, true, true]);
      expect(deletes()).toBe(deleted);
      home = await startHome(root, { stopGraceMs: 50, registry: FAKES, slot: null, log: () => undefined, tickMs: TICK_MS, lookMs: LOOK_MS });
      await until("the start's survey ended on the feed", () => sitesEvents().length === told + 2);
      expect(sitesEvents().slice(told)).toEqual([[UNIT, { checking: true }], [UNIT, { signed_in: { chatgpt: true } }]]);
      expect(await checking()).toEqual([false, false, false]);
      expect(surveyed()).toBe(puts + 1);
      report.survey = { asks, begun: station.begunNames, held };
    } finally {
      station?.stop();
      await door?.stop();
      await home?.stop();
      removeRoot(root);
    }
  });

  it("reads a stream's switch to another account only at the refresh, keeps a copy signed out once Chrome is signed in to another, reads an account before it is chosen, keeps an offer standing or the account in the wrong state after Read it too or Not this one, settles an offer twice on two presses at once, settles one Chrome moved on from as the account it is on now, or reads a declined account again once the stream is turned off and on", async () => {
    const root = makeRoot("lifestream-stations-accounts-", { sources: {} });
    const chromeAs = join(root, "chrome-as.json");
    const attempts = join(root, "claude-browser-attempts");
    const signIn = (id: string, email: string) => writeFileSync(chromeAs, JSON.stringify({ id, email }));
    signIn(CLAUDE_A, "person-a@example.com");
    editSettings(root, { "connectors.claude": { refresh: "1h", chrome_as: chromeAs, attempts } });
    const CLAUDE_C = "33333333-3333-4333-8333-00000000000c";
    const CLAUDE_D = "44444444-4444-4444-8444-00000000000d";
    const source = (id: string) => `claude:${id}:browser`;
    const fetches = () => (existsSync(attempts) ? readFileSync(attempts).length : 0);
    const row = (id: string) => {
      const found = readHome(root, (db) => db.prepare("SELECT options FROM sources WHERE id = ?").pluck().get(source(id))) as string | undefined;
      return found === undefined ? undefined : JSON.parse(found) as Record<string, unknown>;
    };
    const imported = (id: string) => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE source = ? AND state = 'imported'").pluck().get(source(id))) as number;
    const offer = () => statusOf(root, { now_ms: Date.now(), settings: readOpsSettings(root) }).needs.find((need) => need.id === "fetch:claude-browser");
    const waits = () => fetched(root, "claude-browser")?.outcome === "wait" && fetched(root, "claude-browser")!.reason === "chrome";
    const claudeSurveys = () => (readHome(root, (db) => db.prepare("SELECT detail FROM events WHERE kind = 'sites' ORDER BY seq").pluck().all()) as string[])
      .map((detail) => JSON.parse(detail) as { signed_in?: Record<string, unknown> }).filter((detail) => detail.signed_in !== undefined && "claude" in detail.signed_in).length;
    const polling = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE kind = 'poll' AND key = 'claude-browser' AND state IN ('queued', 'running')").pluck().get()) as number;
    const drive = mintPrincipal(openHomeFolder(root), { unit: "test-driver", scopes: ["drive"], now_ms: Date.now() }).token;
    let door: DoorHandle | undefined;
    let home: Home | undefined;
    let station: Station | undefined;
    try {
      door = await openFakeDoor(root);
      home = await startHome(root, { stopGraceMs: 50, registry: FAKES, slot: null, log: () => undefined, tickMs: TICK_MS, lookMs: LOOK_MS });
      const sock = testSocket(root);
      const pass = randomBytes(32).toString("base64url");
      const { code } = await askHome(sock, "pair") as { code: string };
      const paired = await fetch(`${door.url}/v1/pair`, { method: "POST", headers: { ...DEVICE, "content-type": "application/json" }, body: JSON.stringify({ code, pass, kind: "extension", model: "Chrome", unit: UNIT }) });
      expect(paired.status).toBe(200);
      station = new Station(door.url, pass, UNIT);
      station.signedIn = true;
      station.press(["claude"]);
      void station.serve();
      const account = async () => ((await (await fetch(`${door!.url}/v1/sites`, { headers: { authorization: `Bearer ${drive}` } })).json()) as
        { sites: { id: string; stations: { unit: string; account: unknown }[] }[] }).sites.find((site) => site.id === "claude")!.stations.find((each) => each.unit === UNIT)!.account;
      const surveyAs = async (id: string, email: string) => {
        signIn(id, email);
        station!.as = { id, email };
        station!.survey = true;
        station!.cutShort();
      };

      await until("the first account's delivery imported", () => imported(CLAUDE_A) >= 1);
      expect(row(CLAUDE_A)).toEqual({ lane: "claude-browser", email: "person-a@example.com" });
      await until("the survey's verdict on the first account", async () => JSON.stringify(await account()) === JSON.stringify({ email: "person-a@example.com", verdict: "read" }));

      const signedOut = () => statusOf(root, { now_ms: Date.now(), settings: readOpsSettings(root) }).needs.filter((need) => need.reason === "signed-out");
      writeFileSync(chromeAs, "null");
      station.signedIn = false;
      station.survey = true;
      station.cutShort();
      await until("the read account signed out", () => signedOut().some((need) => need.copy === source(CLAUDE_A)));

      const before = fetches();
      station.signedIn = true;
      await surveyAs(CLAUDE_B, "person-b@example.com");
      await until("the door holds the other account, offered", async () => JSON.stringify(await account()) === JSON.stringify({ email: "person-b@example.com", verdict: "offered" }));
      await until("the survey's change ran the lane", () => fetches() > before);
      await until("the offer raised", () => offer() !== undefined);
      expect(offer()).toMatchObject({
        state: "needs-you", reason: "other-account", words: "Another Claude account", line: "person-b@example.com in Chrome", connector: "claude",
        acts: [{ do: "read", label: "Read it too", need: "poll:claude-browser", of: source(CLAUDE_B) }, { do: "ignore", label: "Not this one", need: "poll:claude-browser", of: source(CLAUDE_B) }],
      });
      expect([row(CLAUDE_B), imported(CLAUDE_B), signedOut()]).toEqual([undefined, 0, []]);

      await until("the station holds the offer", () => station!.needs.some((need) => need.reason === "other-account"));
      expect(station.needs.find((need) => need.reason === "other-account")!.acts.map((act) => act.label)).toEqual(["Read it too", "Not this one"]);
      const surveyed = claudeSurveys();
      station.acted.push({ need: "poll:claude-browser", do: "ignore", of: source(CLAUDE_B) });
      station.cutShort();
      await until("the popup's answer made its source", () => row(CLAUDE_B) !== undefined);
      expect(row(CLAUDE_B)).toEqual({ lane: "claude-browser", email: "person-b@example.com" });
      expect(readOpsSettings(root).sources.off).toContain(source(CLAUDE_B));
      await until("the lane waits on Chrome", () => waits() && fetched(root, "claude-browser")!.detail === "waits for Chrome: signed in to the synthetic provider as person-b@example.com");
      expect(offer()).toBeUndefined();
      await until("the lane the answer queued ended", () => polling() === 0 && waits());
      station.survey = true;
      station.cutShort();
      await until("a survey found Claude's verdict changed", () => claudeSurveys() > surveyed);
      expect(await account()).toEqual({ email: "person-b@example.com", verdict: "not-read" });
      await until("no poll of the lane queued or running", () => polling() === 0 && waits());
      const waiting = ((await askHome(sock, "connectors")) as StreamsReport).connectors.find((each) => each.id === "claude")!;
      expect(waiting.health).toMatchObject({ state: "waiting", reason: "chrome" });
      const messages = readHome(root, (db) => db.prepare("SELECT count(*) FROM heads WHERE source = ? AND kind = 'msg' AND version <> 'gone'").pluck().get(source(CLAUDE_A))) as number;
      expect(waiting.copies.map((each) => [each.name, each.line, each.on])).toEqual([
        ["person-a@example.com", messages === 0 ? "Nothing yet" : expect.stringMatching(/^[\d,]+\u00a0messages?/u), true], ["person-b@example.com", "Off", false]]);
      const again = await askHome(sock, "act", ["poll:claude-browser", "ignore", source(CLAUDE_B)]).catch((failure: unknown) => failure);
      expect(String((again as Error).message)).toMatch(/offers no ignore/u);

      await askHome(sock, "connectors", ["off", "claude"]);
      await askHome(sock, "connectors", ["on", "claude"]);
      expect(readOpsSettings(root).sources.off).toEqual([source(CLAUDE_B)]);

      await surveyAs(CLAUDE_D, "person-d@example.com");
      await until("the fourth account offered", () => offer()?.line === "person-d@example.com in Chrome");
      await surveyAs(CLAUDE_C, "person-c@example.com");
      await until("the third account offered", () => offer()?.line === "person-c@example.com in Chrome");
      const stale = await askHome(sock, "act", ["poll:claude-browser", "read", source(CLAUDE_D)]).catch((failure: unknown) => failure);
      expect(String((stale as Error).message)).toMatch(/poll:claude-browser offers no read now/u);
      expect([row(CLAUDE_C), row(CLAUDE_D), (offer()?.acts[0] as { of?: string } | undefined)?.of]).toEqual([undefined, undefined, source(CLAUDE_C)]);
      const pressed = await Promise.allSettled([0, 1].map(() => askHome(sock, "act", ["poll:claude-browser", "read", source(CLAUDE_C)])));
      expect(pressed.filter((each) => each.status === "fulfilled").map((each) => (each as PromiseFulfilledResult<unknown>).value)).toEqual([{ acted: "read", source: source(CLAUDE_C) }]);
      expect(pressed.filter((each) => each.status === "rejected").map((each) => String(((each as PromiseRejectedResult).reason as Error).message)))
        .toEqual([expect.stringMatching(/offers no read/u)]);
      expect(readOpsSettings(root).sources.off).toEqual([source(CLAUDE_B)]);
      await until("the third account's delivery imported", () => imported(CLAUDE_C) >= 1);
      expect([row(CLAUDE_C), row(CLAUDE_D), offer()]).toEqual([{ lane: "claude-browser", email: "person-c@example.com" }, undefined, undefined]);
      report.accounts = { first: row(CLAUDE_A), declined: row(CLAUDE_B), read: row(CLAUDE_C), copies: waiting.copies, line: waiting.line };
    } finally {
      station?.stop();
      await door?.stop();
      await home?.stop();
      removeRoot(root);
    }
  });

  it("waits to run a site never run once it is chosen, polls again for every presence within the refresh, wipes a need as another profile comes, records a busy Chrome as a success, or keeps a stopped site's need on the answer to the exchange that stopped it (17)", async () => {
    const root = makeRoot("lifestream-stations-turns-", { sources: {}, clocks: true });
    const attempts = join(root, "claude-browser-attempts");
    const beats = join(root, "fake-poll-attempts");
    const busy = join(root, "claude-browser-busy");
    editSettings(root, { "connectors.claude": { refresh: "1h", attempts, needs_first: true, busy_while: busy }, "connectors.fake-poll": { refresh: "1s", attempts: beats } });
    const count = (file: string) => (existsSync(file) ? readFileSync(file).length : 0);
    const poll = () => fetched(root, "claude-browser")!;
    const needRow = () => needing(root, "claude-browser");
    let door: DoorHandle | undefined;
    let home: Home | undefined;
    const stations: Station[] = [];
    const clock = steppedClock(root, "fake-poll", 1_000);
    try {
      door = await openFakeDoor(root);
      home = await startHome(root, { stopGraceMs: 50, registry: FAKES, clock: clock.now, slot: null, log: () => undefined, tickMs: TICK_MS, lookMs: LOOK_MS });
      for (const unit of [UNIT, OTHER]) {
        const pass = randomBytes(32).toString("base64url");
        const { code } = await askHome(testSocket(root), "pair") as { code: string };
        expect((await fetch(`${door.url}/v1/pair`, { method: "POST", headers: { ...DEVICE, "content-type": "application/json" }, body: JSON.stringify({ code, pass, kind: "extension", model: unit === OTHER ? "Brave" : "Chrome", unit }) })).status).toBe(200);
        stations.push(new Station(door.url, pass, unit));
      }
      const [chooser, other] = stations as [Station, Station];
      void chooser.serve();
      await until("the first station's first answer", () => chooser.answers > 0);
      expect((await askHome(testSocket(root), "connectors") as { extension: { present: boolean; browsers: string[] } }).extension).toMatchObject({ present: true, browsers: ["Chrome"] });
      chooser.press(["claude"]);
      await clock.stepUntil("the lane's need on the station", () => chooser.needs.some((need) => need.id === "fetch:claude-browser"));
      expect(count(attempts)).toBe(1);

      void other.serve();
      await until("the second station's first answer", () => other.answers > 0);
      const beat = count(beats);
      await clock.stepUntil("two beats after the second station came", () => count(beats) >= beat + 2);
      expect({ fetches: count(attempts), need: needRow() }).toEqual({ fetches: 1, need: 1 });
      expect(chooser.needs.map((need) => need.id)).toContain("fetch:claude-browser");

      writeFileSync(busy, "");
      const tried = poll().at_ms;
      await askHome(testSocket(root), "run", ["poll", "claude-browser"]);
      await until("the poll ended busy", () => poll().at_ms > tried);
      expect({ outcome: poll().outcome, reason: poll().reason, need: needRow() }).toEqual({ outcome: "need", reason: "confirm", need: 1 });
      rmSync(busy);

      const from = chooser.answered.length;
      chooser.press([], ["claude"]);
      const stoppedAt = () => chooser.answered.slice(from).find((each) => each.pressed.stop.includes("claude"));
      await until("an answer to the exchange that stopped Claude", () => stoppedAt() !== undefined);
      expect(stoppedAt()!.needs).not.toContain("fetch:claude-browser");
      expect(needRow()).toBe(0);
      report.turns = { answered: chooser.answered, fetches: count(attempts) };
    } finally {
      for (const station of stations) station.stop();
      await door?.stop();
      await home?.stop();
      removeRoot(root);
    }
  });

  it("reads a site Chrome withheld at its first poll only at the lane's retry once the person allows it, holds it past the retry, keeps the extension's need after, or tries a signed-out lane again before its refresh", async () => {
    const root = makeRoot("lifestream-stations-grant-", { sources: {}, clocks: true });
    const signedIn = join(root, "claude-signed-in");
    writeFileSync(signedIn, JSON.stringify({ id: CLAUDE_A, email: "person-a@example.com" }));
    editSettings(root, { "connectors.claude": { refresh: "1h", chrome_as: signedIn } });
    const nextMs = () => readHome(root, (db) => db.prepare("SELECT next_ms FROM polls WHERE acquirer = ?").pluck().get("claude-browser")) as number;
    let door: DoorHandle | undefined;
    let home: Home | undefined;
    let station: Station | undefined;
    try {
      door = await openFakeDoor(root);
      home = await startHome(root, { stopGraceMs: 50, registry: FAKES, slot: null, log: () => undefined, tickMs: TICK_MS, lookMs: LOOK_MS });
      const pass = randomBytes(32).toString("base64url");
      const { code } = await askHome(testSocket(root), "pair") as { code: string };
      expect((await fetch(`${door.url}/v1/pair`, { method: "POST", headers: { ...DEVICE, "content-type": "application/json" }, body: JSON.stringify({ code, pass, kind: "extension", model: "Chrome", unit: UNIT }) })).status).toBe(200);
      station = new Station(door.url, pass);
      station.withheld = ["claude"];
      void station.serve();
      station.press(["claude"]);
      await until("the lane refused the site", () => fetched(root, "claude-browser")?.reason === "extension");
      const refused = fetched(root, "claude-browser")!;
      expect([refused.outcome, needing(root, "claude-browser")]).toEqual(["need", 1]);
      expect(nextMs() - refused.at_ms).toBeLessThanOrEqual(RETRY_MS);
      station.withheld = [];
      station.cutShort();
      await until("the lane read once allowed", () => fetched(root, "claude-browser")?.outcome === "ok" && needing(root, "claude-browser") === 0);
      await until("the station's answer without the need", () => !station!.needs.some((need) => need.id === "fetch:claude-browser"));

      writeFileSync(signedIn, "null");
      const before = fetched(root, "claude-browser")!.at_ms;
      await askHome(testSocket(root), "run", ["poll", "claude-browser"]);
      await until("the lane found Chrome signed out", () => fetched(root, "claude-browser")!.at_ms > before && fetched(root, "claude-browser")!.reason === "signed-out");
      expect(nextMs() - fetched(root, "claude-browser")!.at_ms).toBeGreaterThan(30 * 60_000);
      report.grant = { refused: refused.reason, after: fetched(root, "claude-browser") };
    } finally {
      station?.stop();
      await door?.stop();
      await home?.stop();
      removeRoot(root);
    }
  });

  it("turns a stopped site's need into a failed poll the Mac shows", async () => {
    const root = makeRoot("lifestream-stations-stop-", { sources: {}, clocks: true });
    editSettings(root, { "connectors.claude": { refresh: "1h", needs_first: true } });
    const poll = () => { const row = fetched(root, "claude-browser"); return row === undefined ? undefined : [row.outcome, row.reason]; };
    const needRow = () => needing(root, "claude-browser");
    let door: DoorHandle | undefined;
    let home: Home | undefined;
    let station: Station | undefined;
    try {
      door = await openFakeDoor(root);
      home = await startHome(root, { stopGraceMs: 50, registry: FAKES, slot: null, log: () => undefined, tickMs: TICK_MS, lookMs: LOOK_MS });
      const pass = randomBytes(32).toString("base64url");
      const { code } = await askHome(testSocket(root), "pair") as { code: string };
      expect((await fetch(`${door.url}/v1/pair`, { method: "POST", headers: { ...DEVICE, "content-type": "application/json" }, body: JSON.stringify({ code, pass, kind: "extension", model: "Chrome", unit: UNIT }) })).status).toBe(200);
      station = new Station(door.url, pass);
      station.press(["claude"]);
      void station.serve();
      await until("the lane's need on the station", () => station!.needs.some((need) => need.id === "fetch:claude-browser"));
      expect(poll()).toEqual(["need", "confirm"]);
      station.press([], ["claude"]);
      await until("the need ended", () => needRow() === 0);
      expect(poll()).toBeUndefined();
      const stopped = ((await askHome(testSocket(root), "connectors")) as StreamsReport).connectors.find((each) => each.id === "claude")!;
      expect([stopped.health.state, stopped.on]).toEqual(["off", false]);
      expect(statusOf(root, { now_ms: Date.now(), settings: readOpsSettings(root) }).needs.filter((need) => need.id === "fetch:claude-browser")).toEqual([]);
      report.stop = { error: poll() };
    } finally {
      station?.stop();
      await door?.stop();
      await home?.stop();
      removeRoot(root);
    }
  });

  it("answers two browsers other than the home's one list: the Mac's Turn on, a popup's Stop, a popup's Set up beside the Mac's Turn off, a press while the home is away", async () => {
    const root = makeRoot("lifestream-stations-list-", { sources: {} });
    const sock = testSocket(root);
    let door: DoorHandle | undefined;
    let home: Home | undefined;
    const stations: Station[] = [];
    try {
      door = await openFakeDoor(root);
      home = await startHome(root, { stopGraceMs: 50, registry: FAKES, slot: null, log: () => undefined, tickMs: TICK_MS, lookMs: LOOK_MS });
      const paired = async (unit: string): Promise<Station> => {
        const pass = randomBytes(32).toString("base64url");
        const { code } = await askHome(sock, "pair") as { code: string };
        expect((await fetch(`${door!.url}/v1/pair`, { method: "POST", headers: { ...DEVICE, "content-type": "application/json" }, body: JSON.stringify({ code, pass, kind: "extension", model: "Chrome", unit }) })).status).toBe(200);
        const station = new Station(door!.url, pass, unit);
        stations.push(station);
        return station;
      };
      const [first, second] = [await paired(UNIT), await paired(OTHER)];
      const drive = mintPrincipal(openHomeFolder(root), { unit: "test-driver", scopes: ["drive"], now_ms: Date.now() }).token;
      const claude = async () => ((await (await fetch(`${door!.url}/v1/sites`, { headers: { authorization: `Bearer ${drive}` } })).json()) as { sites: { id: string; chosen: boolean; choosing: string | null }[] })
        .sites.find((each) => each.id === "claude")!;
      const listed = () => effective(root).settings.sites.chosen;
      const off = () => effective(root).settings.sources.off;
      const agreed = async (what: string) => {
        await until(what, async () => stations.every((station) => station.answers > 0 && JSON.stringify(station.chosen) === JSON.stringify(listed()) && station.pressed.choose.length + station.pressed.stop.length === 0)
          && (await claude()).chosen === listed().includes("claude"));
        expect(off().includes("claude")).toBe(!listed().includes("claude"));
      };
      for (const station of stations) void station.serve();
      await until("both browsers' first answers", () => stations.every((station) => station.answers > 0));
      expect(stations.map((station) => station.chosen)).toEqual([[], []]);

      await askHome(sock, "connectors", ["on", "claude"]);
      expect(listed()).toEqual(["claude"]);
      await agreed("both browsers answered Claude chosen");
      second.press([], ["claude"]);
      await agreed("both browsers answered Claude stopped");
      expect(listed()).toEqual([]);
      first.press(["claude"]);
      await askHome(sock, "connectors", ["off", "claude"]);
      await agreed("both browsers answered the home's last word");

      second.allowing = ["claude"];
      second.cutShort();
      await until("Claude allowing", async () => (await claude()).choosing === "allowing");
      second.allowing = [];
      second.cutShort();
      await until("Claude allowing no more", async () => (await claude()).choosing === null);

      await askHome(sock, "connectors", ["on", "claude"]);
      await agreed("both browsers answered Claude chosen again");
      await home.stop();
      home = undefined;
      const failed = first.failures;
      first.press([], ["claude"]);
      await until("the press refused while the home is away", () => first.failures > failed);
      expect({ pressed: first.pressed, chosen: first.chosen, listed: listed() }).toEqual({ pressed: { choose: [], stop: ["claude"] }, chosen: ["claude"], listed: ["claude"] });
      home = await startHome(root, { stopGraceMs: 50, registry: FAKES, slot: null, log: () => undefined, tickMs: TICK_MS, lookMs: LOOK_MS });
      await agreed("the press landed once the home was back");
      expect(listed()).toEqual([]);

      const third = await paired(THIRD);
      void third.serve();
      await until("the third browser's first answer", () => third.answers > 0);
      expect(third.answered[0]!.chosen).toEqual(listed());
      report.list = { first: first.answered.map(({ pressed, chosen }) => ({ pressed, chosen })), second: second.answered.map(({ pressed, chosen }) => ({ pressed, chosen })) };
    } finally {
      for (const station of stations) station.stop();
      await door?.stop();
      await home?.stop();
      removeRoot(root);
    }
  });

  it("chooses a site at a browser's connect, reads one before the person presses Connect, says a site's sign-in other than checking while the first survey looks, or reads a page behind a bot check as signed out", async () => {
    const root = makeRoot("lifestream-stations-first-", { sources: {}, clocks: true, settings: { "connectors.chatgpt": {}, "connectors.claude": {} } });
    const beats = join(root, "fake-poll-attempts");
    editSettings(root, { "connectors.fake-poll": { refresh: "1s", attempts: beats } });
    const count = (file: string) => (existsSync(file) ? readFileSync(file).length : 0);
    const sock = testSocket(root);
    let door: DoorHandle | undefined;
    let home: Home | undefined;
    const stations: Station[] = [];
    const clock = steppedClock(root, "fake-poll", 1_000);
    try {
      door = await openFakeDoor(root);
      home = await startHome(root, { stopGraceMs: 50, registry: FAKES, clock: clock.now, slot: null, log: () => undefined, tickMs: TICK_MS, lookMs: LOOK_MS });
      const connecting = (pass: string, unit: string) => new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
        const sent = httpRequest(`${door!.url}/v1/pair`, { method: "POST", headers: { origin: HAND_LOADED, "content-type": "application/json", ...DEVICE } }, (response) => {
          let text = "";
          response.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
          response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown> }));
        });
        sent.on("error", reject);
        sent.end(JSON.stringify({ connect: true, pass, kind: "extension", unit }));
      });
      const allowed = async (unit: string): Promise<{ pass: string; members: string[] }> => {
        const pass = randomBytes(32).toString("base64url");
        await askHome(sock, "connect");
        expect((await connecting(pass, unit)).status).toBe(202);
        const { requests } = await askHome(sock, "connect") as { requests: { id: string }[] };
        await askHome(sock, "connect", ["answer", requests.at(-1)!.id, "allow"]);
        const paired = await connecting(pass, unit);
        expect(paired.status).toBe(200);
        return { pass, members: Object.keys(paired.body).sort() };
      };
      const listed = () => effective(root).settings.sites.chosen;
      const rows = async () => Object.fromEntries(((await askHome(sock, "connectors")) as StreamsReport).connectors
        .filter((each) => each.id === "chatgpt" || each.id === "claude").map((each) => [each.id, { chosen: each.chosen, checking: each.checking, signed_in: each.signed_in }]));
      const row = (chosen: boolean, checking: boolean, signed_in: boolean | null) => ({ chatgpt: { chosen, checking, signed_in }, claude: { chosen, checking, signed_in } });
      const sitePolls = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE kind = 'poll' AND key IN ('chatgpt-browser', 'claude-browser')").pluck().get()) as number;
      const sitesEvents = () => readHome(root, (db) => (db.prepare("SELECT detail FROM events WHERE kind = 'sites' ORDER BY seq").all() as { detail: string }[]).map((each) => JSON.parse(each.detail)));

      expect(listed()).toEqual([]);
      const first = await allowed(UNIT);
      expect(first.members).toEqual(["answer", "unit"]);
      expect(listed()).toEqual([]);

      const station = new Station(door.url, first.pass, UNIT);
      stations.push(station);
      station.signedIn = true;
      station.botCheck = true;
      void station.serve();
      await until("the first survey ended on the feed", () => sitesEvents().length === 2);
      expect(sitesEvents()).toEqual([{ checking: true }, { signed_in: {} }]);
      const checked = await rows();
      expect(checked).toEqual(row(false, false, null));

      station.botCheck = false;
      station.holding = true;
      station.survey = true;
      station.cutShort();
      await until("the popup's survey's first probe is held", () => station.heldFetches === 1);
      const looking = await rows();
      expect(looking).toEqual(row(false, true, null));
      station.release();
      await until("the popup's survey ended on the feed", () => sitesEvents().length === 4);
      const signedIn = await rows();
      expect(signedIn).toEqual(row(false, false, true));

      const asked = count(beats);
      await clock.stepUntil("two polls of the other lane", () => count(beats) >= asked + 2);
      expect({ polls: sitePolls(), begun: station.begunNames.filter((name) => !name.startsWith("probe:")) }).toEqual({ polls: 0, begun: [] });

      await askHome(sock, "connectors", ["on", "chatgpt"]);
      expect(listed()).toEqual(["chatgpt"]);
      await until("ChatGPT's lane began at the station", () => station.begunNames.includes("chatgpt-browser"));
      expect(station.begunNames.includes("claude-browser")).toBe(false);

      await allowed(OTHER);
      expect(listed()).toEqual(["chatgpt"]);
      report.first = { checked, looking, signedIn, listed: listed(), begun: station.begunNames };
    } finally {
      for (const station of stations) station.stop();
      await door?.stop();
      await home?.stop();
      removeRoot(root);
    }
  });
});

describe("the stations on their own", () => {
  it("hands a station's popup an account by its email alone: a name-only account reads Signed in with none, while the door's sites keep its name and verdict", async () => {
    const state = mkdtempSync(join(tmpdir(), "lifestream-stations-named-"));
    const alone = await serveStations(state, { port: 0, poll_ms: 20 });
    try {
      const relay = JSON.parse(readFileSync(join(state, "relay.json"), "utf8")) as { code: string; drive_token: string };
      const pass = randomBytes(32).toString("base64url");
      const paired = await fetch(`${alone.url}/v1/pair`, { method: "POST", headers: { ...DEVICE, "content-type": "application/json" }, body: JSON.stringify({ code: relay.code, pass, kind: "extension", unit: UNIT }) });
      expect(paired.status).toBe(200);
      const exchange = async () => ((await (await fetch(`${alone.url}/v1/stations/exchange`, {
        method: "POST", headers: { authorization: `Bearer ${pass}`, ...DEVICE, "content-type": "application/json" },
        body: JSON.stringify({ results: [], station: { unit: UNIT, version: "1.0.0", slots: 4, errands: [], boot: "boot-1", running: [], opened: [] } }),
      })).json()) as { sites: { id: string; signed_in: boolean | null; account: unknown }[] }).sites;
      const put = (account: unknown) => fetch(`${alone.url}/v1/sites`, {
        method: "PUT", headers: { authorization: `Bearer ${relay.drive_token}`, "content-type": "application/json" },
        body: JSON.stringify({ station: UNIT, sites: [{ id: "shop", name: "Shop", origin: "https://shop.example", signed_in: true, account }, { id: "notes", name: "Notes", origin: "https://notes.example", signed_in: true, account: { email: "person-a@example.com", verdict: "read" } }] }),
      });
      await exchange();
      expect((await put({ name: "Person A", verdict: "offered" })).status).toBe(200);
      expect((await exchange()).map((site) => [site.id, site.signed_in, site.account])).toEqual([["shop", true, null], ["notes", true, { email: "person-a@example.com" }]]);
      const held = ((await (await fetch(`${alone.url}/v1/sites`, { headers: { authorization: `Bearer ${relay.drive_token}` } })).json()) as { sites: { id: string; stations: { account: unknown }[] }[] }).sites;
      expect(held.map((site) => [site.id, site.stations.map((each) => each.account)])).toEqual([
        ["shop", [{ name: "Person A", verdict: "offered" }]], ["notes", [{ email: "person-a@example.com", verdict: "read" }]],
      ]);
      for (const account of [{ email: "person-a@example.com", name: "Person A", verdict: "read" }, { verdict: "read" }, { name: "", verdict: "read" }]) {
        expect((await put(account)).status, JSON.stringify(account)).toBe(400);
      }
    } finally {
      await alone.close();
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("shows one profile's sign-in to another, mixes an absent station into the sites, lets a call outwait its station or an errand whose driver left, ends an errand for idleness while its need stands, or begins one whose driver left while it waited (20)", async () => {
    const state = mkdtempSync(join(tmpdir(), "lifestream-stations-alone-"));
    const alone = await serveStations(state, { port: 0, presence_ms: 120, idle_ms: 80, poll_ms: 20 });
    try {
      const relay = JSON.parse(readFileSync(join(state, "relay.json"), "utf8")) as { code: string; drive_token: string };
      const driving = { authorization: `Bearer ${relay.drive_token}`, "content-type": "application/json" };
      const passes: Record<string, string> = {};
      for (const unit of [UNIT, OTHER]) {
        passes[unit] = randomBytes(32).toString("base64url");
        const paired = await fetch(`${alone.url}/v1/pair`, { method: "POST", headers: { ...DEVICE, "content-type": "application/json" }, body: JSON.stringify({ code: relay.code, pass: passes[unit], kind: "extension", unit }) });
        expect(paired.status).toBe(200);
      }
      type Answer = { calls: { id: string; errand: string; op: string }[]; sites: { id: string; signed_in: boolean | null }[] };
      const exchange = async (unit: string, results: unknown[] = [], errands: string[] = [], withheld?: string[]): Promise<Answer> => {
        const response = await fetch(`${alone.url}/v1/stations/exchange`, {
          method: "POST", headers: { authorization: `Bearer ${passes[unit]}`, ...DEVICE, "content-type": "application/json" },
          body: JSON.stringify({ results, station: { unit, version: "1.0.0", slots: 4, errands, boot: `boot-${unit}`, running: [], opened: [], ...(withheld === undefined ? {} : { withheld }) } }),
        });
        return response.json() as Promise<Answer>;
      };
      const drive = (method: string, path: string, body?: unknown) => fetch(`${alone.url}${path}`, { method, headers: driving, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      writeFileSync(join(state, "chosen.json"), JSON.stringify(["claude"]));
      await exchange(UNIT);
      await exchange(OTHER);
      const site = (id: string, signed_in: boolean | null) => ({ id, name: id, origin: `https://${id}.example`, signed_in });
      expect((await drive("PUT", "/v1/sites", { station: UNIT, sites: [site("claude", true)] })).status).toBe(200);
      expect((await drive("PUT", "/v1/sites", { station: OTHER, sites: [site("claude", false)] })).status).toBe(200);
      const origins = ["https://claude.example"];
      expect((await exchange(UNIT)).sites).toEqual([{ ...site("claude", true), account: null, origins }]);
      expect((await exchange(OTHER)).sites).toEqual([{ ...site("claude", false), account: null, origins }]);
      const sites = async () => ((await (await drive("GET", "/v1/sites")).json()) as { sites: { id: string; signed_in: boolean | null; chosen: boolean; stations: unknown }[] }).sites;
      expect(await sites()).toEqual([{
        ...site("claude", true), origins, chosen: true, checking: false, choosing: null,
        stations: [{ unit: UNIT, signed_in: true, account: null }, { unit: OTHER, signed_in: false, account: null }],
      }]);
      await exchange(UNIT, [], [], []);
      for (const unit of [UNIT, OTHER]) expect((await drive("PUT", "/v1/sites", { station: unit, sites: [{ ...site("claude", null), allowed: false }] })).status).toBe(200);
      const views = async () => (await sites())[0]!.stations as unknown[];
      expect(await views()).toEqual([{ unit: UNIT, signed_in: true, account: null, allowed: true }, { unit: OTHER, signed_in: false, account: null, allowed: false }]);
      expect((await drive("PUT", "/v1/sites", { station: OTHER, sites: [site("claude", false)] })).status).toBe(200);
      expect((await views())[1]).toEqual({ unit: OTHER, signed_in: false, account: null });

      const begin = async (origin = `https://e${randomBytes(3).toString("hex")}.example`, name = "test", left = false): Promise<string> => {
        const begun = drive("POST", "/v1/errands", { spec: { name, origins: [origin], deadline_ms: 60_000 }, site: "claude", station: UNIT, wait_ms: 15 * 60_000 });
        const { calls } = await exchange(UNIT);
        const call = calls.find((each) => each.op === "begin")!;
        if (left) writeFileSync(join(state, "needs.json"), JSON.stringify([{ id: "fetch:claude-browser", state: "needs-you", reason: "signed-out", words: "Sign in to Claude",
          since_ms: null, next_ms: null, acts: [], detail: null, connector: "claude", copy: null, unit: null, at: { site: "claude.ai", open: null, errand: call.errand } }]));
        const errands = [...held, call.errand];
        const [answer] = await Promise.all([begun, exchange(UNIT, [{ id: call.id, ok: true, value: { begun: true } }], errands)]);
        held.push(call.errand);
        const placed = (await answer.json()) as { errand?: string; code?: string };
        expect(placed, "the errand was placed").toMatchObject({ errand: call.errand });
        return placed.errand!;
      };
      const held: string[] = [];
      const waiting = await begin("https://held.example", "held", true);
      const idle = await begin();
      const busy = await drive("POST", "/v1/errands", { spec: { name: "test", origins: ["https://held.example"], deadline_ms: 60_000 }, site: "claude", station: UNIT, wait_ms: 0 });
      expect({ status: busy.status, code: ((await busy.json()) as { code: string }).code }).toEqual({ status: 409, code: "BUSY" });
      const ended: string[] = [];
      const serveOnce = async () => {
        const { calls } = await exchange(UNIT, [], held.filter((id) => !ended.includes(id)));
        for (const call of calls.filter((each) => each.op === "end")) {
          ended.push(call.errand);
          await exchange(UNIT, [{ id: call.id, ok: true, value: { ended: true } }], held.filter((id) => !ended.includes(id)));
        }
      };
      const serveUntil = async (done: () => boolean) => {
        while (!done()) await serveOnce();
      };
      await serveUntil(() => ended.includes(idle));
      expect(ended).toEqual([idle]);
      rmSync(join(state, "needs.json"));
      await serveUntil(() => ended.includes(waiting));

      const fourth = await begin();
      const leaving = new AbortController();
      const left = fetch(`${alone.url}/v1/errands/${fourth}/calls`, { method: "POST", headers: driving, body: JSON.stringify({ op: "wait", tab: 1, for: { role: "button" }, ms: 15 * 60_000 }), signal: leaving.signal })
        .then((answer) => answer.text()).catch(() => null);
      await until("the station holds the call", async () => (await exchange(UNIT, [], [fourth])).calls.some((each) => each.op === "wait" && each.errand === fourth));
      leaving.abort();
      await left;
      await until("the errand whose driver left ends at the station", async () => {
        await serveOnce();
        return ended.includes(fourth);
      });
      const transcript = () => readFileSync(join(state, "transcript.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { errand: string; op: string; code?: string });
      await until("the call is answered", () => transcript().some((entry) => entry.errand === fourth && entry.op === "wait"));
      const interrupted = transcript().find((entry) => entry.errand === fourth && entry.op === "wait");
      expect(interrupted).toMatchObject({ ok: false, code: "INTERRUPTED" });

      const third = await begin();
      const call = drive("POST", `/v1/errands/${third}/calls`, { op: "wait", tab: 1, for: { role: "button" }, ms: 15 * 60_000 });
      await exchange(UNIT, [], [third]);
      const result = (await (await call).json()) as { ok: boolean; error?: { code: string } };
      expect(result).toMatchObject({ ok: false, error: { code: "NO_STATION" } });
      await exchange(OTHER);
      expect(await sites()).toEqual([{ ...site("claude", false), origins, chosen: true, checking: false, choosing: null, stations: [{ unit: OTHER, signed_in: false, account: null }] }]);
      report.alone = { ended, result, interrupted };
    } finally {
      await alone.close();
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("hands a station a download or a fetch that holds a value into a file, refuses either otherwise than BAD_CALL, or writes a download's file in the transcript", async () => {
    const state = mkdtempSync(join(tmpdir(), "lifestream-stations-refused-"));
    const alone = await serveStations(state, { port: 0, presence_ms: 120_000, poll_ms: 20 });
    try {
      const relay = JSON.parse(readFileSync(join(state, "relay.json"), "utf8")) as { code: string; drive_token: string };
      const pass = randomBytes(32).toString("base64url");
      const paired = await fetch(`${alone.url}/v1/pair`, { method: "POST", headers: { ...DEVICE, "content-type": "application/json" }, body: JSON.stringify({ code: relay.code, pass, kind: "extension", unit: UNIT }) });
      expect(paired.status).toBe(200);
      type Call = { id: string; errand: string; op: string };
      const exchange = async (results: unknown[], errands: string[]): Promise<Call[]> => {
        const response = await fetch(`${alone.url}/v1/stations/exchange`, {
          method: "POST", headers: { authorization: `Bearer ${pass}`, ...DEVICE, "content-type": "application/json" },
          body: JSON.stringify({ results, station: { unit: UNIT, version: "1.0.0", slots: 2, errands, boot: `boot-${UNIT}`, running: [], opened: [] } }),
        });
        return ((await response.json()) as { calls: Call[] }).calls;
      };
      await exchange([], []);
      const seen: string[] = [];
      let errands: string[] = [];
      let serving = true;
      const served = (async () => {
        let results: unknown[] = [];
        while (serving) {
          const calls = await exchange(results, errands);
          seen.push(...calls.map((call) => call.op));
          results = calls.map((call) => {
            if (call.op === "begin") errands = [...errands, call.errand];
            if (call.op === "end") errands = errands.filter((errand) => errand !== call.errand);
            if (call.op === "begin" || call.op === "end" || call.op === "open") {
              return { id: call.id, ok: true, value: call.op === "begin" ? { begun: true } : call.op === "open" ? { tab: 1, url: "https://site.example/" } : { ended: true } };
            }
            return { id: call.id, ok: false, error: { code: "PAGE_ERROR", message: `${call.op} reached the station` } };
          });
        }
      })();
      const driving = { authorization: `Bearer ${relay.drive_token}`, "content-type": "application/json" };
      const drive = async (method: string, path: string, body?: unknown): Promise<unknown> =>
        (await fetch(`${alone.url}${path}`, { method, headers: driving, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).json();
      const { errand } = (await drive("POST", "/v1/errands", { spec: { name: "test", origins: ["https://site.example"], deadline_ms: 60_000 }, station: UNIT, wait_ms: 60_000 })) as { errand: string };
      type Answered = { ok: boolean; error?: { code: string; message: string } };
      const download = (await drive("POST", `/v1/errands/${errand}/calls`, { op: "download", url: "https://site.example/export.zip", name: "export.zip", ms: 60_000 })) as Answered;
      const opened = (await drive("POST", `/v1/errands/${errand}/calls`, { op: "open", url: "https://site.example/" })) as Answered;
      expect(opened.ok).toBe(true);
      const heldFile = (await drive("POST", `/v1/errands/${errand}/calls`, {
        op: "fetch", tab: 1, ms: 60_000, requests: [{ url: "https://site.example/token", as: "file", name: "token.bin", hold: { name: "token", path: "token" } }],
      })) as Answered;
      await drive("DELETE", `/v1/errands/${errand}`);
      serving = false;
      await served;
      const refused = [download, heldFile].map((answered) => answered.error!);
      expect(refused.map((error) => error?.code)).toEqual(["BAD_CALL", "BAD_CALL"]);
      expect(refused[0]!.message).toContain('"download" is not an op');
      expect(refused[1]!.message).toContain("hold");
      expect(seen).not.toContain("download");
      expect(seen).not.toContain("fetch");
      const transcript = readFileSync(join(state, "transcript.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Entry & { file?: unknown; bytes?: unknown });
      const downloaded = transcript.find((entry) => entry.op === "download")!;
      expect(downloaded).toMatchObject({ ok: false, code: "BAD_CALL" });
      expect([downloaded.file, downloaded.bytes, downloaded.urls]).toEqual([undefined, undefined, undefined]);
      expect(transcript.find((entry) => entry.op === "fetch")).toMatchObject({ ok: false, code: "BAD_CALL" });
      report.refused = { refused, seen };
    } finally {
      await alone.close();
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("answers a browser's press or the home's Turn on only at the long poll's end, answers a list other than the home's, or places a site's errand while the list names it not", async () => {
    const state = mkdtempSync(join(tmpdir(), "lifestream-stations-list-"));
    const alone = await serveStations(state, { port: 0, presence_ms: 120_000, poll_ms: 120_000 });
    try {
      const relay = JSON.parse(readFileSync(join(state, "relay.json"), "utf8")) as { code: string; drive_token: string };
      const driving = { authorization: `Bearer ${relay.drive_token}`, "content-type": "application/json" };
      const passes: Record<string, string> = {};
      for (const unit of [UNIT, OTHER]) {
        passes[unit] = randomBytes(32).toString("base64url");
        const paired = await fetch(`${alone.url}/v1/pair`, { method: "POST", headers: { ...DEVICE, "content-type": "application/json" }, body: JSON.stringify({ code: relay.code, pass: passes[unit], kind: "extension", unit }) });
        expect(paired.status).toBe(200);
      }
      const exchange = async (unit: string, pressed = { choose: [] as string[], stop: [] as string[] }, allowing: string[] = []): Promise<string[]> => {
        const response = await fetch(`${alone.url}/v1/stations/exchange`, {
          method: "POST", headers: { authorization: `Bearer ${passes[unit]}`, ...DEVICE, "content-type": "application/json" },
          body: JSON.stringify({ results: [], station: { unit, version: "1.0.0", slots: 4, errands: [], boot: `boot-${unit}`, running: [], pressed, allowing, opened: [] } }),
        });
        return ((await response.json()) as { chosen: string[] }).chosen;
      };
      const drive = (method: string, path: string, body?: unknown) => fetch(`${alone.url}${path}`, { method, headers: driving, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const listFile = join(state, "chosen.json");
      const list = (): string[] => JSON.parse(readFileSync(listFile, "utf8")) as string[];
      const turn = async (next: string[]) => {
        writeFileSync(listFile, JSON.stringify(next));
        return ((await (await drive("POST", "/v1/sites")).json()) as { asked: string[] }).asked;
      };
      const site = (id: string) => ({ id, name: id, origin: `https://${id}.example`, signed_in: null });
      expect((await drive("PUT", "/v1/sites", { sites: [site("claude"), site("chatgpt")] })).status).toBe(200);
      expect((await drive("POST", "/v1/sites/claude/choose")).status).toBe(404);

      expect([await exchange(UNIT), await exchange(OTHER)]).toEqual([[], []]);
      const waiting = exchange(OTHER);
      expect((await turn(["claude"])).sort()).toEqual([UNIT, OTHER].sort());
      expect(await waiting).toEqual(["claude"]);
      const woken = exchange(OTHER);
      expect(await exchange(UNIT, { choose: [], stop: ["claude"] })).toEqual([]);
      expect([await woken, list()]).toEqual([[], []]);
      expect(await exchange(UNIT, { choose: ["chatgpt", "nowhere"], stop: [] })).toEqual(["chatgpt"]);
      writeFileSync(listFile, JSON.stringify(["chatgpt", "claude"]));
      expect(await exchange(OTHER)).toEqual(["chatgpt", "claude"]);

      const allowing = exchange(OTHER, undefined, ["claude"]);
      await until("Claude allowing", async () => ((await (await drive("GET", "/v1/sites")).json()) as { sites: { id: string; choosing: string | null }[] }).sites.find((each) => each.id === "claude")!.choosing === "allowing");
      await turn(["chatgpt", "claude"]);
      await allowing;
      const closed = exchange(OTHER);
      await until("Claude allowing no more", async () => ((await (await drive("GET", "/v1/sites")).json()) as { sites: { id: string; choosing: string | null }[] }).sites.find((each) => each.id === "claude")!.choosing === null);
      await turn(["chatgpt"]);
      expect(await closed).toEqual(["chatgpt"]);

      const begun = await drive("POST", "/v1/errands", { spec: { name: "test", origins: ["https://claude.example"], deadline_ms: 60_000 }, site: "claude", wait_ms: 60_000 });
      expect({ status: begun.status, ...((await begun.json()) as { code: string; message: string }) }).toEqual({ status: 503, code: "NO_STATION", message: "claude is not chosen: Lifestream reads it in no Chrome" });
      report.alone_list = { list: list() };
    } finally {
      await alone.close();
      rmSync(state, { recursive: true, force: true });
    }
  });
});

describe("an account named by its name", () => {
  it("tells a site with no probe as never checking though its lane names who; or a site with neither as checking", () => {
    const site = (id: string, probe: NonNullable<Connector["chrome"]>["probe"], acquirers: string[]) => ({
      id, product: id, name: id, vendor: "example", type: "notes", records: "Every note.", noun: ["note", "notes"],
      sources: [{ id: `${id}:<account>:browser`, read: id, arrives: "chrome" }], acquirers, chrome: { origin: `https://${id}.example.com`, probe },
    }) as unknown as Connector;
    const probe = { url: "/api/me", has: "id", who: { id: "id", email: "email" } } as const;
    expect(surveyed([site("notes", probe, ["notes-browser"]), site("shop", null, ["shop-browser"]), site("bare", null, [])])).toEqual(["notes", "shop"]);
  });

  it("words Chrome's other account by anything but its name where the site shows no email, or makes Read it too's source without it", async () => {
    const root = makeRoot("lifestream-stations-named-account-", { sources: {} });
    const [A, B] = ["customer-0001", "customer-0002"];
    const source = (id: string) => `claude:${id}:browser`;
    const now = Date.now();
    try {
      const db = openHome(openHomeFolder(root), "migrate");
      try {
        db.commit((tx) => {
          tx.tables.sources.add({ id: source(A), vendor: "anthropic", connector: "fake-rows", options: { lane: "claude-browser", name: "Person A" }, added_ms: 0 });
          tx.tables.attempts.put({ target: "fetch:claude-browser", source: "", outcome: "need", reason: "other-account", facts: { offered: { id: B, name: "Person B" } },
            detail: "Chrome is signed in to Claude as Person B", since_ms: now - 60_000, at_ms: now - 60_000, contact_ms: null, fails: 1 });
        });
      } finally {
        db.close();
      }
      const settings = readOpsSettings(root);
      const offer = () => statusOf(root, { now_ms: now, settings }).needs.find((need) => need.id === "fetch:claude-browser");
      expect(offer()).toMatchObject({
        reason: "other-account", words: "Another Claude account", line: "Person B in Chrome",
        acts: [{ do: "read", need: "poll:claude-browser", of: source(B) }, { do: "ignore", need: "poll:claude-browser", of: source(B) }],
      });
      const home = openHome(openHomeFolder(root), "migrate");
      const ledger = openLedger(openHomeFolder(root), { mode: "migrate" });
      try {
        const registry = await loadRegistry(pathToFileURL(FAKES).href, effective(root).settings, homeOf(openHomeFolder(root)));
        const answer = await act({
          folder: openHomeFolder(root), machine: machine(), cwd: root, by: "terminal", db: home, blobs: openHomeFolder(root).blobs(join(root, "blobs")), ledger, settings,
          registry: async () => registry, now: () => now, out: () => undefined, going: () => undefined,
        }, ["poll:claude-browser", "read", source(B)]);
        expect(answer).toEqual({ acted: "read", source: source(B) });
      } finally {
        ledger.close();
        home.close();
      }
      const made = readHome(root, (read) => read.prepare("SELECT options FROM sources WHERE id = ?").pluck().get(source(B))) as string;
      expect(JSON.parse(made)).toEqual({ lane: "claude-browser", name: "Person B" });
      expect(offer()).toBeUndefined();
    } finally {
      removeRoot(root);
    }
  });
});

function brokenAtEnd(folder: HomeFolder): HomeFolder {
  const broken = (file: KeptFile): KeptFile => new Proxy(file, {
    get: (target, key) => (key === "writing"
      ? (chunks: AsyncIterable<Uint8Array>) => target.writing((async function* () {
        for await (const chunk of chunks) yield chunk;
        throw new Error("the disk is full");
      })())
      : ((value: unknown) => (typeof value === "function" ? value.bind(target) : value))(Reflect.get(target, key, target))),
  });
  return new Proxy(folder, {
    get: (target, key) => (key === "file"
      ? (kind: FileKind, path: string) => broken(target.file(kind, path))
      : ((value: unknown) => (typeof value === "function" ? value.bind(target) : value))(Reflect.get(target, key, target))),
  });
}

async function handsDoor(options: { slack_ms?: number; chosen?: () => string[]; keyed?: true; broken?: true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "lifestream-stations-hands-"));
  const told: JsonObject[] = [];
  const transcript: Entry[] = [];
  const held: (() => void)[] = [];
  let gated = false;
  const closed = new Set<string>();
  const claims: JsonObject[] = [];
  const arrived = new Set<string>();
  const stations = openStations({
    files: { folder: ((folder) => (options.broken ? brokenAtEnd(folder) : folder))(options.keyed ? keyedFolder(directory) : openHomeFolder(directory)), dir: join(directory, "files") }, home: { version: "test", generation: null },
    needs: () => (gated ? new Promise<[]>((resolve) => held.push(() => resolve([]))) : []),
    opened: () => undefined, acted: () => undefined, chosen: options.chosen ?? (() => []),
    sites: [{ id: "site", name: "Site", origin: "https://site.example", origins: ["https://site.example"] }],
    told: (line) => told.push(line), log: (entry) => transcript.push(entry), poll_ms: 15,
    claimed: async (claim) => void claims.push(claim as unknown as JsonObject),
    ...(options.slack_ms === undefined ? {} : { slack_ms: options.slack_ms }),
  });
  const server = createServer((request, response) => {
    const tag = request.headers["x-tag"];
    if (typeof tag === "string") {
      arrived.add(tag);
      response.once("close", () => closed.add(tag));
    }
    const half = stations.half(request.method, new URL(request.url ?? "/", "http://door").pathname);
    stations.serve(half === "peer" ? { peer: UNIT } : { drive: true }, request, response).catch((error: unknown) => {
      if (response.headersSent) return void response.end();
      const refused = error instanceof Refusal ? error : new Refusal(500, "FAILED", String(error));
      response.writeHead(refused.status, { "content-type": "application/json" }).end(JSON.stringify({ code: refused.code, message: refused.words }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  type Handed = { id: string; errand: string; op: string };
  type Answer = { calls: Handed[]; reload?: true };
  const exchange = async (boot: string, sent: { errands?: string[]; running?: string[]; results?: unknown[]; tag?: string; signal?: AbortSignal; stated?: string; development?: true } = {}): Promise<Answer> => {
    const response = await fetch(`${url}/v1/stations/exchange`, {
      method: "POST", signal: sent.signal ?? null,
      headers: { "content-type": "application/json", "lifestream-device": "extension/0.10.0", ...(sent.tag === undefined ? {} : { "x-tag": sent.tag }) },
      body: JSON.stringify({
        results: sent.results ?? [],
        station: { unit: UNIT, version: sent.stated ?? "0.10.0", slots: 4, errands: sent.errands ?? [], boot, running: sent.running ?? [], ...(sent.development ? { development: true } : {}) },
      }),
    });
    return (await response.json()) as Answer;
  };
  const post = (body: unknown) => fetch(`${url}/v1/stations/exchange`, { method: "POST", headers: { "content-type": "application/json", "lifestream-device": "extension/0.10.0" }, body: JSON.stringify(body) });
  const upload = async (errand: string, name: string, bytes: Buffer): Promise<JsonObject> => {
    const path = `${url}/v1/stations/files/${errand}/${name}`;
    expect((await fetch(`${path}?part=0`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: bytes })).status).toBe(201);
    return (await (await fetch(`${path}?done=1`, { method: "POST" })).json()) as JsonObject;
  };
  const drive = (method: string, path: string, body?: unknown) => fetch(`${url}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const call = (errand: string, op: JsonObject) => drive("POST", `/v1/errands/${errand}/calls`, op);
  const handed = async (boot: string, op: string, sent: Parameters<typeof exchange>[1] = {}): Promise<Handed> => {
    let found: Handed | undefined;
    await until(`the station is handed a ${op}`, async () => {
      found = (await exchange(boot, sent)).calls.find((each) => each.op === op);
      return found !== undefined;
    });
    return found!;
  };
  const running = async (boot: string, stated?: string): Promise<string> => {
    await exchange(boot, stated === undefined ? {} : { stated });
    const begun = drive("POST", "/v1/errands", { spec: { name: "hands", origins: ["https://site.example"], deadline_ms: 600_000 } });
    const begin = await handed(boot, "begin");
    await exchange(boot, { errands: [begin.errand], results: [{ id: begin.id, ok: true, value: { begun: true } }] });
    expect(await (await begun).json()).toMatchObject({ errand: begin.errand });
    return begin.errand;
  };
  return {
    url, directory, arrived, told, transcript, held, closed, claims, exchange, post, upload, drive, call, handed, running,
    gate: () => void (gated = true),
    ungate: () => void (gated = false),
    release: (at: number) => held.splice(at, 1)[0]!(),
    clean: () => expect(JSON.stringify(told)).not.toMatch(/site\.example|page text|person-a/u),
    async close() {
      gated = false;
      for (const each of held.splice(0)) each();
      stations.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("the door's hands", () => {
  it("hands a call in a third answer once the first, cut as the door read its needs, gives its hand back after a second took it; or says nothing of the hand again or the fence", async () => {
    const door = await handsDoor();
    try {
      const errand = await door.running("boot-1");
      const clicked = await door.call(errand, { op: "click", tab: 7, target: { ref: "e1" } });
      door.gate();
      const cutting = new AbortController();
      const first = door.exchange("boot-1", { errands: [errand], tag: "first", signal: cutting.signal }).catch(() => null);
      await until("the first exchange reads the needs", () => door.held.length === 1);
      door.release(0);
      await until("the first exchange took the call and reads the needs again", () => door.held.length === 1);
      cutting.abort();
      await until("the door saw the first exchange cut", () => door.closed.has("first"));
      const second = door.exchange("boot-1", { errands: [errand] });
      await until("the second exchange reads the needs", () => door.held.length === 2);
      door.release(1);
      await until("the second exchange took the call", () => door.held.length === 2);
      door.release(0);
      door.ungate();
      door.release(0);
      expect(await first).toBeNull();
      const answered = await second;
      expect(answered.calls.map((each) => each.op)).toEqual(["click"]);
      const id = answered.calls[0]!.id;
      expect((await door.exchange("boot-1", { errands: [errand], running: [id] })).calls).toEqual([]);
      await door.exchange("boot-1", { errands: [errand], results: [{ id, ok: true, value: { url: "https://site.example/" } }] });
      expect(await clicked.json()).toMatchObject({ id, ok: true });
      expect(door.transcript.find((entry) => entry.op === "click")).toMatchObject({ call: id, ok: true });
      expect(door.told).toEqual([
        { station: UNIT, boot: "first", version: "0.10.0", retired: 0 },
        { station: UNIT, handed_again: id, op: "click" },
        { station: UNIT, fenced: id, op: "click", why: "taken" },
      ]);
      door.clean();
      report.hands = door.told;
    } finally {
      await door.close();
    }
  });

  it("hands calls beside a reload, loses a call a reload took, or runs a lost errand's queued call in the new start as NO_ERRAND", async () => {
    let asked = 0;
    const door = await handsDoor({ chosen: () => (asked++, ["site"]) });
    try {
      door.gate();
      const reloading = door.exchange("boot-1", { development: true });
      await until("the first exchange reads the needs", () => door.held.length === 1);
      const before = asked;
      const begun = door.drive("POST", "/v1/errands", { spec: { name: "hands", origins: ["https://site.example"], deadline_ms: 600_000 }, site: "site" });
      await until("the begin is placed", () => asked > before);
      door.ungate();
      door.release(0);
      expect(await reloading).toMatchObject({ calls: [], reload: true });
      const begin = await door.handed("boot-2", "begin");
      await door.exchange("boot-2", { errands: [begin.errand], results: [{ id: begin.id, ok: true, value: { begun: true } }] });
      expect(await (await begun).json()).toMatchObject({ errand: begin.errand });
      const errand = begin.errand;

      const clicked = await door.call(errand, { op: "click", tab: 7, target: { ref: "e1" } });
      door.gate();
      const answer = door.exchange("boot-2", { errands: [errand], development: true });
      await until("the exchange reads the needs", () => door.held.length === 1);
      door.release(0);
      await until("the exchange took the call and reads the needs again", () => door.held.length === 1);
      expect((await door.drive("POST", `/v1/stations/${UNIT}/reload`)).status).toBe(202);
      door.ungate();
      door.release(0);
      expect(await answer).toMatchObject({ calls: [], reload: true });
      const back = await door.exchange("boot-3", { errands: [errand] });
      expect(back.calls.map((each) => each.op)).toEqual(["click"]);
      await door.exchange("boot-3", { errands: [errand], results: [{ id: back.calls[0]!.id, ok: true, value: { url: "https://site.example/" } }] });
      expect(await clicked.json()).toMatchObject({ ok: true });
      const store = await door.drive("POST", `/v1/stations/${UNIT}/reload`);
      expect([store.status, await store.json()]).toEqual([409, { code: "BAD_CALL", message: "a store build never reloads itself" }]);

      const looked = await door.call(errand, { op: "snapshot", tab: 7 });
      expect((await door.exchange("boot-4")).calls).toEqual([]);
      expect(await looked.json()).toMatchObject({ ok: false, error: { code: "INTERRUPTED", message: "Chrome started again under the errand" } });
      expect(door.told).toEqual([
        { station: UNIT, boot: "first", version: "0.10.0", retired: 0 },
        { station: UNIT, boot: "again", version: "0.10.0", retired: 0 },
        { station: UNIT, boot: "again", version: "0.10.0", retired: 0 },
        { station: UNIT, boot: "again", version: "0.10.0", retired: 0 },
      ]);
      door.clean();
    } finally {
      await door.close();
    }
  });

  it("loses a stray errand's end with an answer the station never read, hands a second while the first is out, or none after a failed one (the stations on their own)", async () => {
    const door = await handsDoor();
    try {
      const stray = "e-0000beef";
      await door.exchange("boot-1");
      const end = await door.handed("boot-1", "end", { errands: [stray] });
      expect(end.errand).toBe(stray);
      const again = await door.handed("boot-1", "end", { errands: [stray] });
      expect(again.id).toBe(end.id);
      expect((await door.exchange("boot-1", { errands: [stray], running: [end.id] })).calls).toEqual([]);
      expect((await door.exchange("boot-1", { results: [{ id: end.id, ok: true, value: { ended: true } }] })).calls).toEqual([]);
      const other = "e-0000cafe";
      const failing = await door.handed("boot-1", "end", { errands: [other] });
      await door.exchange("boot-1", { errands: [other], running: [failing.id], results: [] });
      await door.exchange("boot-1", { errands: [other], results: [{ id: failing.id, ok: false, error: { code: "PAGE_ERROR", message: "the tab would not close" } }] });
      const next = await door.handed("boot-1", "end", { errands: [other] });
      expect(next.id).not.toBe(failing.id);
      expect(door.told).toEqual([
        { station: UNIT, boot: "first", version: "0.10.0", retired: 0 },
        { station: UNIT, handed_again: end.id, op: "end" },
      ]);
      door.clean();
    } finally {
      await door.close();
    }
  });

  it("answers a call its station never answered other than INTERRUPTED, or tells its late answer other than once, by op, code and slots, with the version the door parsed and nothing of the page", async () => {
    expect(budgetOf({ op: "fetch", requests: Array.from({ length: 12 }, () => ({ url: "https://site.example/" })) }, CALL_SLACK_MS)).toBe(3 * FETCH_MS + CALL_SLACK_MS);
    expect(budgetOf({ op: "fetch", requests: [{ url: "https://site.example/" }] }, CALL_SLACK_MS)).toBe(FETCH_MS + CALL_SLACK_MS);
    expect(budgetOf({ op: "wait", ms: 5_000 }, CALL_SLACK_MS)).toBe(5_000 + CALL_SLACK_MS);
    expect(budgetOf({ op: "click" }, CALL_SLACK_MS)).toBe(CALL_SLACK_MS);
    const door = await handsDoor({ slack_ms: 300 });
    try {
      const errand = await door.running("boot-1", "9.9.9");
      const looked = await door.call(errand, { op: "snapshot", tab: 7, ms: 60_000 });
      const snapshot = await door.handed("boot-1", "snapshot", { errands: [errand] });
      const seen = { id: snapshot.id, ok: true, value: { url: "https://site.example/", title: "page text", lines: "page text" } };
      await door.exchange("boot-1", { errands: [errand], results: [seen] });
      await door.exchange("boot-1", { errands: [errand], results: [seen] });
      expect(await looked.json()).toMatchObject({ id: snapshot.id, ok: true });
      const clicked = await door.call(errand, { op: "click", tab: 7, target: { ref: "e1" } });
      const click = await door.handed("boot-1", "click", { errands: [errand] });
      expect(await clicked.json()).toEqual({ id: click.id, ok: false, error: { code: "INTERRUPTED", message: `no answer from station ${UNIT} within 300 ms: whether the call ran is not known` } });
      const strange = { id: click.id, ok: false, error: { code: "SOMETHING_NEW", message: "https://site.example/account shows page text" } };
      await door.exchange("boot-1", { errands: [errand], results: [strange] });
      await door.exchange("boot-1", { errands: [errand], results: [strange] });
      const fetching = await door.call(errand, { op: "fetch", requests: [{ url: "https://site.example/a" }, { url: "https://site.example/b" }] });
      const fetch = await door.handed("boot-1", "fetch", { errands: [errand] });
      const ending = door.drive("DELETE", `/v1/errands/${errand}`);
      const end = await door.handed("boot-1", "end", { errands: [errand], running: [fetch.id] });
      await door.exchange("boot-1", { running: [fetch.id], results: [{ id: end.id, ok: true, value: { ended: true } }] });
      expect((await ending).status).toBe(200);
      expect(await fetching.json()).toMatchObject({ id: fetch.id, ok: false, error: { code: "INTERRUPTED" } });
      await door.exchange("boot-1", { results: [{ id: fetch.id, ok: true, value: [
        { status: 200, url: "https://site.example/a", json: { name: "page text" } },
        { status: 0, url: "https://site.example/b", error: { code: "PAGE_ERROR", message: "https://site.example/b did not answer" } },
      ] }] });
      const lines = door.told.map((line) => ({ ...line, ...(typeof line.after_ms === "number" ? { after_ms: "n" } : {}) }));
      expect(lines).toEqual([
        { station: UNIT, boot: "first", version: "0.10.0", retired: 0 },
        { station: UNIT, late: click.id, op: "click", code: "other", after_ms: "n" },
        { station: UNIT, late: fetch.id, op: "fetch", code: "ok", after_ms: "n", slots: [{ status: 200 }, { code: "PAGE_ERROR" }] },
      ]);
      door.clean();
      report.late = door.told;
    } finally {
      await door.close();
    }
  });

  it("throws on a station's result of the wrong shape and is sent it for ever, answers a fetch whose slot is null or names a file it never took after its headers went, claims a tab for an open with none, holds a failed begin's origins when it says no error, or takes a boot that is no string", async () => {
    const door = await handsDoor();
    try {
      const errand = await door.running("boot-1");
      const wrong = { ok: false, error: { code: "BAD_CALL", message: "the station's answer has the wrong shape" } };
      const station = { unit: UNIT, version: "0.10.0", slots: 4, errands: [errand], boot: "boot-1", running: [] };
      for (const stated of [{ boot: 42 }, { slots: 0 }, { slots: 1.5 }, { errands: [7] }, { running: [null] }]) {
        const refused = await door.post({ results: [], station: { ...station, ...stated } });
        expect(refused.status).toBe(400);
        expect(await refused.json()).toMatchObject({ code: "BAD_CALL" });
      }
      const looked = await door.call(errand, { op: "snapshot", tab: 7 });
      const snapshot = await door.handed("boot-1", "snapshot", { errands: [errand] });
      const dropping = await door.post({ results: [null, { ok: true, value: {} }, { id: 42, ok: true, value: {} }, { id: snapshot.id, ok: true, value: { url: "https://site.example/", title: "t", lines: "" } }], station });
      expect(dropping.status).toBe(200);
      expect(await looked.json()).toMatchObject({ id: snapshot.id, ok: true });
      const opening = await door.call(errand, { op: "open", url: "https://site.example/" });
      const open = await door.handed("boot-1", "open", { errands: [errand] });
      await door.exchange("boot-1", { errands: [errand], results: [{ id: open.id, ok: true, value: { url: "https://site.example/" } }] });
      expect(await opening.json()).toEqual({ id: open.id, ...wrong });
      expect(door.claims).toEqual([]);
      const clicking = await door.call(errand, { op: "click", tab: 7, target: { ref: "e1" } });
      const click = await door.handed("boot-1", "click", { errands: [errand] });
      await door.exchange("boot-1", { errands: [errand], results: [{ id: click.id, ok: true, value: {} }] });
      expect(await clicking.json()).toEqual({ id: click.id, ...wrong });
      const finding = await door.call(errand, { op: "find", tab: 7, target: { ref: "e1" } });
      const find = await door.handed("boot-1", "find", { errands: [errand] });
      await door.exchange("boot-1", { errands: [errand], results: [{ id: find.id, ok: false }] });
      expect(await finding.json()).toEqual({ id: find.id, ...wrong });
      const kept = await door.upload(errand, "b.bin", Buffer.from("kept bytes"));
      const another = await door.upload(errand, "c.bin", Buffer.from("other bytes"));
      const requests = [{ url: "https://site.example/a" }, { url: "https://site.example/b", as: "file", name: "b.bin" }];
      const fetched: string[] = [];
      for (const value of [
        [null, { status: 200, url: "https://site.example/b", file: kept }],
        [{ status: 200, url: "https://site.example/a", json: {} }, { status: 200, url: "https://site.example/b", file: { name: "never.bin", bytes: 10, sha256: "0".repeat(64) } }],
        [{ status: 200, url: "https://site.example/a", json: {} }, { status: 200, url: "https://site.example/b", file: another }],
        [{ status: 200, url: "https://site.example/a", json: {} }, { status: 200, url: "https://site.example/b", file: { ...kept, bytes: 11 } }],
        [{ status: 200, url: "https://site.example/a", json: {} }, { status: 200, url: "https://site.example/b", file: { ...kept, sha256: "f".repeat(64) } }],
        [{ status: 200, url: "https://site.example/a", json: {} }],
      ]) {
        const fetching = await door.call(errand, { op: "fetch", requests });
        const fetch = await door.handed("boot-1", "fetch", { errands: [errand] });
        await door.exchange("boot-1", { errands: [errand], results: [{ id: fetch.id, ok: true, value }] });
        await door.exchange("boot-1", { errands: [errand], results: [{ id: fetch.id, ok: true, value }] });
        expect(await fetching.json()).toEqual({ id: fetch.id, ...wrong });
        fetched.push(fetch.id);
      }
      for (const id of fetched) expect(door.transcript.filter((entry) => entry.call === id)).toMatchObject([{ ok: false, code: "BAD_CALL" }]);
      const fetching = await door.call(errand, { op: "fetch", requests });
      const fetch = await door.handed("boot-1", "fetch", { errands: [errand] });
      await door.exchange("boot-1", { errands: [errand], results: [{ id: fetch.id, ok: true, value: [{ status: 200, url: "https://site.example/a", json: { a: 1 } }, { status: 200, url: "https://site.example/b", file: kept }] }] });
      const answered = (await fetching.json()) as { ok: true; value: { file?: { path?: string } }[] };
      expect(answered).toMatchObject({ id: fetch.id, ok: true, value: [{ status: 200, json: { a: 1 } }, { status: 200, file: kept }] });
      expect(typeof answered.value[1]!.file!.path).toBe("string");
      const spec = { spec: { name: "other", origins: ["https://other.example"], deadline_ms: 600_000 } };
      const refusing = door.drive("POST", "/v1/errands", spec);
      const begin = await door.handed("boot-1", "begin", { errands: [errand] });
      await door.exchange("boot-1", { errands: [errand], results: [{ id: begin.id, ok: false }] });
      const refused = await refusing;
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ code: "BAD_CALL" });
      const beginning = door.drive("POST", "/v1/errands", spec);
      const again = await door.handed("boot-1", "begin", { errands: [errand] });
      await door.exchange("boot-1", { errands: [errand, again.errand], results: [{ id: again.id, ok: true, value: { begun: true } }] });
      expect(await (await beginning).json()).toMatchObject({ errand: again.errand });
      expect(door.told).toEqual([{ station: UNIT, boot: "first", version: "0.10.0", retired: 0 }]);
    } finally {
      await door.close();
    }
  });
});

describe("a station's file", () => {
  type Door = Awaited<ReturnType<typeof handsDoor>>;
  const CANARY = "ZQX-station-canary-5d1e";
  const at = (door: Door, errand: string, name: string) => `${door.url}/v1/stations/files/${errand}/${name}`;
  const put = (door: Door, errand: string, name: string, part: number, bytes: Buffer) =>
    fetch(`${at(door, errand, name)}?part=${part}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: bytes });
  const finish = (door: Door, errand: string, name: string, done: number) => fetch(`${at(door, errand, name)}?done=${done}`, { method: "POST" });
  const got = async (door: Door, errand: string, name: string) => {
    const response = await door.drive("GET", `/v1/errands/${errand}/files/${name}`);
    return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
  };
  const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const located = async (door: Door, errand: string, file: JsonObject): Promise<{ path?: string }> => {
    const fetching = await door.call(errand, { op: "fetch", requests: [{ url: "https://site.example/b", as: "file", name: file.name as string }] });
    const handed = await door.handed("boot-1", "fetch", { errands: [errand] });
    await door.exchange("boot-1", { errands: [errand], results: [{ id: handed.id, ok: true, value: [{ status: 200, url: "https://site.example/b", file }] }] });
    return ((await fetching.json()) as { value: { file: { path?: string } }[] }).value[0]!.file;
  };
  const everyFile = (root: string) => readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));

  it("a file sent in parts, or sent empty, reads back otherwise than sent, names a path on a keyed home, keeps its canary on a keyed disk, or is finished twice", async () => {
    for (const keyed of [false, true]) {
      const door = await handsDoor(keyed ? { keyed: true } : {});
      try {
        const errand = await door.running("boot-1");
        const parts = [Buffer.concat([Buffer.from(CANARY), randomBytes(300_000)]), randomBytes(70_001), Buffer.from(`tail ${CANARY}`)];
        const whole = Buffer.concat(parts);
        for (const [index, part] of parts.entries()) expect((await put(door, errand, "a.bin", index, part)).status).toBe(201);
        const file = (await (await finish(door, errand, "a.bin", parts.length)).json()) as JsonObject;
        expect(file).toEqual({ name: "a.bin", bytes: whole.length, sha256: sha(whole) });
        expect(await got(door, errand, "a.bin")).toEqual({ status: 200, bytes: whole });
        expect(await (await finish(door, errand, "empty.bin", 0)).json()).toEqual({ name: "empty.bin", bytes: 0, sha256: sha(Buffer.alloc(0)) });
        expect(await got(door, errand, "empty.bin")).toEqual({ status: 200, bytes: Buffer.alloc(0) });
        const { path } = await located(door, errand, file);
        if (keyed) {
          expect(path).toBeUndefined();
          expect(everyFile(door.directory).some((each) => readFileSync(each).includes(CANARY))).toBe(false);
        } else {
          expect(readFileSync(path!)).toEqual(whole);
        }
        expect((await finish(door, errand, "a.bin", parts.length)).status).toBe(400);
      } finally {
        await door.close();
      }
    }
  });

  it("a file sent again from its first part keeps the first sending's bytes, or takes a part out of turn", async () => {
    const door = await handsDoor();
    try {
      const errand = await door.running("boot-1");
      expect((await put(door, errand, "a.bin", 0, Buffer.from("first sending"))).status).toBe(201);
      expect((await put(door, errand, "a.bin", 2, Buffer.from("skipped"))).status).toBe(400);
      expect((await put(door, errand, "a.bin", 0, Buffer.from("second "))).status).toBe(201);
      expect((await put(door, errand, "a.bin", 1, Buffer.from("sending"))).status).toBe(201);
      expect((await finish(door, errand, "a.bin", 3)).status).toBe(400);
      expect(await (await finish(door, errand, "a.bin", 2)).json()).toMatchObject({ bytes: 14 });
      expect((await got(door, errand, "a.bin")).bytes.toString()).toBe("second sending");
      await until("the first sending's bytes are removed", () => readdirSync(join(door.directory, "files", errand)).length === 1);
    } finally {
      await door.close();
    }
  });

  it("a file its home fails to write yields a reference, can be read, or leaves its bytes", async () => {
    for (const keyed of [false, true]) {
      const door = await handsDoor({ broken: true, ...(keyed ? { keyed: true } : {}) });
      try {
        const errand = await door.running("boot-1");
        expect((await put(door, errand, "a.bin", 0, Buffer.from(CANARY))).status).toBe(201);
        const refused = await finish(door, errand, "a.bin", 1);
        expect(refused.status).toBe(500);
        expect(await refused.json()).toMatchObject({ code: "FAILED" });
        expect((await got(door, errand, "a.bin")).status).toBe(404);
        expect((await finish(door, errand, "a.bin", 1)).status).toBe(400);
        expect((await finish(door, errand, "empty.bin", 0)).status).toBe(500);
        await until("the failed files' bytes are removed", () => everyFile(join(door.directory, "files")).length === 0);
      } finally {
        await door.close();
      }
    }
  });

  it("a part sent as its errand ends is answered as kept, or its file outlives the errand", async () => {
    const door = await handsDoor();
    try {
      const errand = await door.running("boot-1");
      expect((await put(door, errand, "a.bin", 0, Buffer.from("kept part"))).status).toBe(201);
      const sending = httpRequest(`${at(door, errand, "a.bin")}?part=1`, { method: "PUT", headers: { "content-type": "application/octet-stream", "content-length": "8", "x-tag": "held" } });
      const answered = new Promise<number>((resolve, reject) => {
        sending.on("response", (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        sending.on("error", reject);
      });
      sending.write("half");
      await until("the door reads the held part", () => door.arrived.has("held"));
      const ending = door.drive("DELETE", `/v1/errands/${errand}`);
      const end = await door.handed("boot-1", "end", { errands: [errand] });
      await door.exchange("boot-1", { errands: [errand], results: [{ id: end.id, ok: true, value: {} }] });
      expect((await ending).status).toBe(200);
      sending.end("more");
      expect(await answered).toBe(409);
      await until("the errand's files are removed", () => !existsSync(join(door.directory, "files", errand)));
    } finally {
      await door.close();
    }
  });
});
