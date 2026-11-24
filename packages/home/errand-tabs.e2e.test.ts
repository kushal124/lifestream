import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { civilDay, dayBounds, openHomeFolder, type DaySettings, type JsonObject } from "@lifestreamprotocol/core";
import { startHome, type Home } from "./home.js";
import { mintPrincipal, passOf, readPrincipals } from "./principals.js";
import { effective } from "./settings.js";
import { artifact, LOOK_MS, makeRoot, readHome, removeRoot, searchIndexed, TICK_MS, until } from "./test/harness-root.js";
import { ship, shipFiles } from "./test/harness-deliveries.js";
import { openDoor } from "./test/harness-door.js";
import { TEST_UNIT } from "./test/folder.js";

type History = import("../connect/browser/chrome/test/fixture.js").History;
const { createHistory } = (await import(new URL("../connect/browser/chrome/test/fixture.ts", import.meta.url).href)) as typeof import("../connect/browser/chrome/test/fixture.js");

const REGISTRY = new URL("./test/errand-tabs-registry.ts", import.meta.url);
const CHROME = `chrome:profile-1:${TEST_UNIT}`;
const SCREEN = `screen:local:${TEST_UNIT}`;
const CLAIMS = `stations:local:${TEST_UNIT}`;
const STATION = "chrome-5550aa01";
const STATION_PASS = "synthetic-errand-station".padEnd(43, "s");
const DRIVER_PASS = "synthetic-errand-driver".padEnd(43, "d");
const READER_PASS = "synthetic-errand-reader".padEnd(43, "r");
const SITE = "https://app.errand.example";
const S = 1_000;
const MIN = 60 * S;
const HOUR = 60 * MIN;
const DAY = "2026-09-28";
const SPEC = { name: "synthetic", origins: [SITE], deadline_ms: 5 * MIN };

const FLOORS = { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" };

const OUT = new URL("./.build/e2e/errand-tabs.json", import.meta.url);
const kept: Record<string, unknown> = {};

const chromeTime = (ms: number): bigint => (BigInt(ms) + 11_644_473_600_000n) * 1000n;

interface Page {
  at: number;
  path: string;
  title: string;
  tab: number;
  foreground: number;
}

let visits = 0;
function history(pages: readonly Page[]): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "errand-history-"));
  try {
    const rows = pages.map((page) => ({ ...page, id: ++visits }));
    const store: History = {
      urls: rows.map((page) => ({ id: page.id, url: `${SITE}${page.path}`, title: page.title, lastVisit: chromeTime(page.at) })),
      visits: rows.map((page) => ({ id: page.id, url: page.id, at: chromeTime(page.at) })),
      searches: [], downloads: [], tabbed: rows.map((page) => ({ visit: page.id, tab: page.tab, foreground: page.foreground })),
    };
    createHistory(join(dir, "history.sqlite"), store);
    return readFileSync(join(dir, "history.sqlite"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

class Station {
  #results: JsonObject[] = [];
  #stopped = false;
  #boot = "boot-one";
  readonly errands = new Set<string>();
  readonly #tabs: number[] = [];
  #named: JsonObject[] = [];
  readonly #running: Promise<void>;
  #cut = new AbortController();

  constructor(private readonly url: string) {
    this.#running = this.#serve();
  }

  opens(...tabs: number[]): void {
    this.#tabs.push(...tabs);
  }

  names(...tabs: JsonObject[]): void {
    this.#named.push(...tabs);
    this.#cut.abort();
  }

  heard(): boolean {
    return this.#named.length === 0;
  }

  restart(): void {
    this.#boot = "boot-two";
    this.#cut.abort();
  }

  async #serve(): Promise<void> {
    while (!this.#stopped) {
      const results = this.#results.splice(0);
      const named = [...this.#named];
      this.#cut = new AbortController();
      const response = await fetch(`${this.url}/v1/stations/exchange`, {
        signal: this.#cut.signal, method: "POST", headers: { authorization: `Bearer ${STATION_PASS}`, "lifestream-device": "extension/1.0.0", "content-type": "application/json" },
        body: JSON.stringify({ results, station: { unit: STATION, version: "1.0.0", slots: 2, errands: [...this.errands], boot: this.#boot, running: [], pressed: { choose: [], stop: [] }, allowing: [], opened: [], acted: [], tabs: named } }),
      }).catch(() => null);
      if (response === null) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      const answer = await response.json().catch(() => null) as { calls?: { id: string; errand: string; op: string; url?: string }[] } | null;
      if (answer === null) continue;
      this.#named = this.#named.filter((tab) => !named.includes(tab));
      for (const call of answer.calls ?? []) {
        if (call.op === "begin") this.errands.add(call.errand);
        if (call.op === "end") this.errands.delete(call.errand);
        this.#results.push({ id: call.id, ok: true, value: call.op === "open" ? { tab: this.#tabs.shift()!, url: call.url! } : call.op === "goto" ? { url: call.url! } : {} });
      }
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#cut.abort();
    await this.#running.catch(() => undefined);
  }
}

function runningFrom(from: number): () => number {
  const began = Date.now();
  return () => from + (Date.now() - began);
}

async function open(screen: boolean, at: (start_ms: number) => number) {
  const root = makeRoot("lifestream-errand-", { sources: { [CHROME]: "chrome-history", ...(screen ? { [SCREEN]: "fake-rows" } : {}) }, defaults: false });
  onTestFinished(() => removeRoot(root));
  const day: DaySettings = effective(root).settings.day;
  const now = runningFrom(at(dayBounds(DAY, day).start_ms));
  const principals = openHomeFolder(root);
  mintPrincipal(principals, { unit: STATION, kind: "extension", scopes: ["station"], sources: [], token: STATION_PASS, now_ms: 0 });
  mintPrincipal(principals, { unit: "synthetic-driver", scopes: ["drive"], sources: [], token: DRIVER_PASS, now_ms: 0 });
  mintPrincipal(principals, { unit: "reader", scopes: ["read"], sources: [], token: READER_PASS, now_ms: 0 });
  const start = () => startHome(root, { stopGraceMs: 50, registry: REGISTRY, clock: now, tickMs: TICK_MS, lookMs: LOOK_MS, log: () => undefined });
  const started: { home: Home | null } = { home: await start() };
  onTestFinished(() => started.home?.stop());
  const { door, url, logs } = await openDoor(root, { registry: REGISTRY, clock: now, floors: FLOORS });
  const station = new Station(url);
  onTestFinished(() => station.stop());
  const driver = { authorization: `Bearer ${DRIVER_PASS}`, "content-type": "application/json" };
  const held = async (response: Response) => JSON.parse((await response.text()).trim()) as Record<string, any>;
  await until("the station is present", async () => ((await held(await fetch(`${url}/v1/stations`, { headers: driver }))).stations as { present: boolean }[]).some((each) => each.present));
  const begin = async (): Promise<string> => (await held(await fetch(`${url}/v1/errands`, { method: "POST", headers: driver, body: JSON.stringify({ spec: SPEC, wait_ms: 5_000 }) }))).errand as string;
  const call = async (errand: string, op: Record<string, unknown>) => held(await fetch(`${url}/v1/errands/${errand}/calls`, { method: "POST", headers: driver, body: JSON.stringify(op) }));
  const claims = () => readHome(root, (db) => db.prepare("SELECT key FROM heads WHERE source = ? AND kind = 'tab' ORDER BY key").pluck().all(CLAIMS) as string[]);
  const read = async <T = Record<string, any>>(path: string) => await (await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${READER_PASS}` } })).json() as T;
  const found = async (words: string) => ((await read<{ record: { hits: { ref: string; title?: string }[] } }>(`/v1/search?lists=record&query=${encodeURIComponent(words)}`)).record.hits).map((hit) => hit.title ?? hit.ref);
  const today = async () => (await read<{ connectors: { id: string; figure: { today: number | null; week: number[] | null } | null; line: string }[] }>("/v1/connectors")).connectors.find((each) => each.id === "chrome")!;
  const printed = (at_ms: number) => {
    const file = join(root, "days", `${civilDay(at_ms, day)}.day.txt`);
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  };
  let delivered = 0;
  const chromeDelivery = async (pages: readonly Page[]) => {
    await shipFiles(root, CHROME, now() + ++delivered, { "history.sqlite": history(pages) }, { kind: "changes" });
    await until("Chrome's delivery imported", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE source = ? AND state = 'imported'").pluck().get(CHROME) as number) === delivered);
  };
  const settledAll = () => until("the home has read, rendered and indexed everything", () => searchIndexed(root));
  return { root, now, door, url, logs, station, started, start, driver, held, begin, call, claims, read, found, today, printed, chromeDelivery, settledAll };
}

describe("errand tabs", () => {
  afterAll(() => {
    mkdirSync(new URL(".", OUT), { recursive: true });
    writeFileSync(OUT, `${JSON.stringify(kept, null, 2)}\n`);
  });

  const sides = [
    { side: "just before the day's start", at: (start: number) => start - 5 * MIN, today: 3, week: [1, 3], repeated: "today" },
    { side: "just after the day's start", at: (start: number) => start + 5 * MIN, today: 2, week: [2, 2], repeated: "yesterday" },
  ] as const;
  for (const screen of [false, true]) for (const { side, at, today, week, repeated } of sides) {
    const name = `${screen ? "with a screen source" : "with no screen source"}, ${side}`;
    it(`1-5: on a home ${name}, an errand's visit prints, is found or is counted, or takes the person's own visit with it`, async () => {
      const home = await open(screen, at);
      const t0 = home.now();
      if (screen) {
        const frames = Array.from({ length: 30 }, (_, at) => t0 - 2 * MIN + at * 10 * S).map((t) => ({
          kind: "frame", key: new Date(t).toISOString().replace(/[-:]/gu, ""), at: t,
          content: { at: t, type: "screen.lifestream.frame", status: "captured", ocrStatus: "ok", displayID: 1, application: { bundleID: "com.example.browser", name: "Browser", pid: 42 }, frontWindow: { windowID: 7 }, windows: [{ windowID: 7, title: "App" }], ocr: [{ text: "App: synthetic line" }], site: "app.errand.example" },
        }));
        await ship(home.root, { source: SCREEN, fetched_ms: t0 + 1, rows: frames });
        await until("the frames imported", () => readHome(home.root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE source = ? AND state = 'imported'").pluck().get(SCREEN) as number) === 1);
      }
      const report: Record<string, unknown> = {};

      await home.chromeDelivery([
        { at: t0 - 24 * 60 * MIN, path: "/yesterday", title: "Yesterdaypage Old", tab: 500, foreground: 4_000_000 },
        { at: t0 - 30 * S, path: "/early", title: "Errandpage Early", tab: 501, foreground: 0 },
        { at: t0 - 20 * S, path: "/own", title: "Ownpage Morning", tab: 502, foreground: 4_000_000 },
      ]);
      await home.settledAll();
      expect(home.printed(t0)).toContain("Errandpage Early");
      expect(await home.found("Errandpage")).toEqual(["Errandpage Early"]);
      report.before = { day: home.printed(t0), figure: (await home.today()).figure };

      const errand = await home.begin();
      home.station.opens(501);
      const sealedBefore = (): number => {
        const lane = join(home.root, "inbox", CLAIMS);
        return existsSync(lane) ? readdirSync(lane).filter((each) => statSync(join(lane, each)).isDirectory() && each !== "blobs").length : 0;
      };
      expect(sealedBefore()).toBe(0);
      expect(await home.call(errand, { op: "open", url: `${SITE}/early` })).toMatchObject({ ok: true, value: { tab: 501 } });
      expect(sealedBefore()).toBe(1);
      await until("the claim landed", () => home.claims().length === 1);
      await home.settledAll();
      expect(home.claims()[0]).toMatch(new RegExp(`^${STATION}:501:\\d+$`, "u"));
      expect(home.printed(t0)).not.toContain("Errandpage Early");
      expect(home.printed(t0)).toContain("Ownpage Morning");
      expect(await home.found("Errandpage")).toEqual([]);
      expect(await home.found("Ownpage")).toEqual(["Ownpage Morning"]);

      const stated = await home.read<{ records: { content: { url: { title: string }; context_annotations: { tab_id: number; total_foreground_duration: number } }; text: unknown }[] }>(`/v1/records?source=${encodeURIComponent(CHROME)}&kind=page-visit&from_ms=0&text=1`);
      expect(stated.records.map((record) => [record.content.url.title, record.content.context_annotations.tab_id, record.text === null])).toEqual([["Yesterdaypage Old", 500, false], ["Errandpage Early", 501, true], ["Ownpage Morning", 502, false]]);

      home.station.opens(503);
      expect(await home.call(errand, { op: "open", url: `${SITE}/next` })).toMatchObject({ ok: true, value: { tab: 503 } });
      await until("the second claim landed", () => home.claims().length === 2);
      const t1 = home.now();
      await home.chromeDelivery([
        { at: t1, path: "/next", title: "Errandpage Later", tab: 503, foreground: 0 },
        { at: t1 + S, path: "/need", title: "Shownpage Need", tab: 503, foreground: 2_000_000 },
        { at: t0 - 10 * MIN, path: "/repeat", title: "Ownpage Repeated", tab: 503, foreground: 0 },
      ]);
      await home.settledAll();
      const day = home.printed(t0);
      expect(day).not.toContain("Errandpage");
      for (const title of ["Ownpage Morning", "Shownpage Need"]) expect(day).toContain(title);
      expect(day.includes("Ownpage Repeated")).toBe(repeated === "today");
      expect(home.printed(t0 - 10 * MIN)).toContain("Ownpage Repeated");
      expect(day.includes("Web in the"), name).toBe(screen);
      expect(await home.found("Errandpage")).toEqual([]);
      expect((await home.found("Ownpage")).sort()).toEqual(["Ownpage Morning", "Ownpage Repeated"]);

      const chrome = await home.today();
      expect(chrome.figure?.today).toBe(today);
      expect(chrome.figure?.week?.slice(-2)).toEqual(week);
      expect(chrome.line).toMatch(new RegExp(`^${today}\\spages today`, "u"));
      report.after = { day, chrome, claims: home.claims() };
      kept[name] = report;
      artifact(home.root, `errand-tabs-${screen ? "screen" : "no-screen"}-${repeated === "today" ? "before" : "after"}`, report);
    });
  }

  it("5-9: a failed seal fails the errand; a pass does more; a claim sealed with the home away, or across a station's or the door's restart, is lost", async () => {
    const home = await open(false, (start) => start + 8 * HOUR);
    const principals = openHomeFolder(home.root);
    const token = join(process.env.LIFESTREAM_MACHINE_DIR!, "stations", "door-token");

    expect(statSync(token).mode & 0o777).toBe(0o600);
    const held = readFileSync(token, "utf8").trim();
    const pass = passOf(principals, held)!;
    expect({ unit: pass.unit, scopes: pass.scopes, sources: pass.sources, kind: pass.kind }).toEqual({ unit: "stations", scopes: ["deliver"], sources: [CLAIMS], kind: null });
    expect(readHome(home.root, (db) => db.prepare("SELECT connector FROM sources WHERE id = ?").pluck().get(CLAIMS))).toBe("stations-home");
    const dashboard = readPrincipals(principals).principals.find((row) => row.unit === "dashboard")!;
    expect(dashboard.sources).not.toContain(CLAIMS);

    const errand = await home.begin();
    rmSync(token);
    home.station.opens(601);
    expect(await home.call(errand, { op: "open", url: `${SITE}/a` })).toMatchObject({ ok: true, value: { tab: 601 } });
    expect(home.logs.some((line) => line.includes(`"claim":"${errand}"`) && line.includes('"lost"'))).toBe(true);
    expect(await home.call(errand, { op: "goto", tab: 601, url: `${SITE}/b` })).toMatchObject({ ok: true });
    writeFileSync(token, `${held}\n`, { mode: 0o600 });

    await home.started.home!.stop();
    home.started.home = null;
    home.station.opens(602);
    expect(await home.call(errand, { op: "open", url: `${SITE}/c` })).toMatchObject({ ok: true, value: { tab: 602 } });
    home.started.home = await home.start();
    await until("the claim sealed while the home was away landed", () => home.claims().length === 1);
    expect(readFileSync(token, "utf8").trim()).toBe(held);

    home.station.restart();
    await until("the door heard the station's new start", async () => ((await home.held(await fetch(`${home.url}/v1/stations`, { headers: home.driver }))).stations as { boot: string }[]).some((each) => each.boot === "boot-two"));
    home.station.opens(603);
    expect(await home.call(errand, { op: "open", url: `${SITE}/d` })).toMatchObject({ ok: true, value: { tab: 603 } });
    await until("the claim of the station started again landed", () => home.claims().length === 2);

    await home.door.close();
    const again = await openDoor(home.root, { registry: REGISTRY, clock: home.now, floors: FLOORS });
    await home.station.stop();
    expect(home.claims().length).toBe(2);
    const t = home.now();
    await home.chromeDelivery([{ at: t, path: "/d", title: "Errandpage Taken Back", tab: 603, foreground: 0 }, { at: t + S, path: "/own", title: "Ownpage After", tab: 604, foreground: 1_000_000 }]);
    await home.settledAll();
    expect(home.printed(t)).toContain("Ownpage After");
    expect(home.printed(t)).not.toContain("Errandpage");
    expect(again.url).toBeDefined();
  });

  it("10: a tab no `open` named, as the station names it, prints, claims outside its span, is claimed twice, or one of no shape is claimed", async () => {
    const home = await open(false, (start) => start + 8 * HOUR);
    const errand = await home.begin();
    home.station.opens(701);
    expect(await home.call(errand, { op: "open", url: `${SITE}/start` })).toMatchObject({ ok: true, value: { tab: 701 } });
    await until("the open's claim landed", () => home.claims().length === 1);
    const t = home.now();
    const popup = { tab: 702, errand, from: t, until: t + 5 * MIN };
    const restored = { tab: 703, errand: null, from: t - 2 * MIN, until: t - MIN };
    home.station.names(popup, restored, { tab: 704, errand: "no-errand", from: t, until: t + MIN }, { tab: 705, errand: null, from: t, until: t - 1 });
    await until("the named tabs' claims landed", () => home.claims().length === 3);
    home.station.names(popup);
    await until("the exchange naming it again answered", () => home.station.heard());
    await home.settledAll();
    expect(home.claims()).toEqual([`${STATION}:701:`, `${STATION}:702:${t - MIN}`, `${STATION}:703:${t - 3 * MIN}`].map((key, at) => (at === 0 ? expect.stringMatching(new RegExp(`^${key}\\d+$`, "u")) : key)));
    const named = readHome(home.root, (db) => db.prepare("SELECT json_extract(v.text, '$.content') FROM heads h JOIN versions v ON v.id = h.version WHERE h.source = ? AND h.kind = 'tab' AND h.key <> ? ORDER BY h.key").pluck().all(CLAIMS, home.claims()[0]) as string[])
      .map((content) => JSON.parse(content) as JsonObject);
    expect(named).toEqual([
      { type: "stations.tab", station: STATION, tab: 702, errand, from_ms: t - MIN, until_ms: t + 6 * MIN },
      { type: "stations.tab", station: STATION, tab: 703, errand: null, from_ms: t - 3 * MIN, until_ms: t },
    ]);

    await home.chromeDelivery([
      { at: t + S, path: "/popup", title: "Errandpage Popup", tab: 702, foreground: 0 },
      { at: t - 90 * S, path: "/restored", title: "Errandpage Restored", tab: 703, foreground: 0 },
      { at: t + 2 * MIN, path: "/later", title: "Ownpage Later", tab: 703, foreground: 0 },
      { at: t + 2 * S, path: "/no-shape", title: "Ownpage Unclaimed", tab: 704, foreground: 0 },
    ]);
    await home.settledAll();
    const day = home.printed(t);
    expect(day).not.toContain("Errandpage");
    for (const title of ["Ownpage Later", "Ownpage Unclaimed"]) expect(day).toContain(title);
    expect(await home.found("Errandpage")).toEqual([]);
    const report = { claims: named, day };
    kept["named tabs"] = report;
    artifact(home.root, "errand-tabs-named", report);
  });
});
