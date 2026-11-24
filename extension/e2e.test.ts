import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { connect, type Stations } from "./client.js";
import { ask, doorUrl, httpLink, pair, PlainHttp, type Pairing } from "./link.js";
import { createStation, HELD, PassRefused, type Link as DoorLink, type Report, type Station } from "./station.js";
import { fixtureBrowser, type FixtureBrowser, type Site as FixtureSite } from "./test/fixture-browser.js";
import { closing } from "./test/closing.js";
import { until } from "./test/until.js";
import { API, API_KEY, APP, bankSite, chatSite, COOKIE_TOKEN, CUSTOMER_ID, EXPORT, LONG_COOKIE_TOKEN, LONG_SECRET, PASSWORD, SESSION_COOKIE, SESSION_TOKEN, sessionSites, tokenSite } from "./test/sites.js";
import { FETCH_MS, ownNeed, PART_BYTES, StationError, type Act, type Call, type Code, type ErrandSpec, type ExchangeAnswer, type Need, type PageRequest, type Result, type Site, type StationInfo } from "./wire.js";
import { choose, chromeBrowser, CONNECTING_MS, connected, landsOn, link, needsNow, type Link } from "./chrome.js";

function homeNeed(id: string, words: string, { site, open = null, errand = null, connector = null, acts = [] }:
  { site?: string; open?: string | null; errand?: string | null; connector?: string | null; acts?: Act[] }): Need {
  return { id, state: "needs-you", reason: null, words, since_ms: null, next_ms: null, acts, detail: null, connector, copy: null, unit: null,
    at: site === undefined ? null : { site, open, errand } };
}


const REPO = fileURLToPath(new URL("../", import.meta.url));
const ARTIFACTS = join(REPO, "extension", ".build", "e2e");
const UNIT = "chrome-0000aa01";
const LOOKALIKE = "https://bank-login.example";
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const SPEC = (name: string, origins: string[], extra: Partial<ErrandSpec> = {}): ErrandSpec => ({ name, origins, deadline_ms: 120_000, ...extra });

async function refused(promise: Promise<unknown>): Promise<StationError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof StationError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

const code = async (promise: Promise<unknown>): Promise<Code> => (await refused(promise)).code;

type InprocStations = {
  serveStations(state: string, options?: { port?: number; floor?: string; home?: { version: string; generation: number | null }; idle_ms?: number; poll_ms?: number }): Promise<{ url: string; close(): Promise<void> }>;
  declaredSites(): Omit<Site, "signed_in" | "account">[];
};
let inprocStations: Promise<InprocStations> | undefined;
function loadInprocStations(): Promise<InprocStations> {
  if (inprocStations === undefined) {
    const bundle = process.env.LIFESTREAM_TEST_DIST === undefined ? undefined : join(process.env.LIFESTREAM_TEST_DIST, "packages~home~test~stations-inproc.mjs");
    const target = bundle !== undefined && existsSync(bundle) ? pathToFileURL(bundle).href : new URL("../packages/home/test/stations-inproc.ts", import.meta.url).href;
    inprocStations = import(target) as Promise<InprocStations>;
  }
  return inprocStations;
}

async function declaredSites(): Promise<Omit<Site, "signed_in" | "account">[]> {
  return (await loadInprocStations()).declaredSites();
}

async function presence(driver: Stations, unit: string): Promise<void> {
  await until("the station listed present", async () => (await driver.list()).some((one) => one.unit === unit && one.present));
}

function counting(): { fetch: typeof fetch; sent: number; answered: number; inflight: number; bodies: string[] } {
  const counter = {
    sent: 0,
    answered: 0,
    inflight: 0,
    bodies: [] as string[],
    fetch: (async (input, init) => {
      if (!String(input).endsWith("/v1/stations/exchange")) return fetch(input, init);
      counter.sent++;
      counter.bodies.push(String(init?.body));
      counter.inflight++;
      try {
        const response = await fetch(input, init);
        counter.answered++;
        return response;
      } finally {
        counter.inflight--;
      }
    }) as typeof fetch,
  };
  return counter;
}

async function extensionPage(name: "popup" | "options" | "allow", world: { local?: Record<string, unknown>; session?: Record<string, unknown>; answer?: unknown; holds?: readonly string[]; search?: string; live?: boolean }) {
  const page = new Window({ url: `chrome-extension://testextensionid/${name}.html${world.search ?? ""}`, settings: { disableJavaScriptFileLoading: true, disableJavaScriptEvaluation: true, disableCSSFileLoading: true } });
  page.document.write(readFileSync(join(REPO, "extension", `${name}.html`), "utf8"));
  const local: Record<string, unknown> = { ...world.local };
  const session: Record<string, unknown> = { ...world.session };
  const read = (store: Record<string, unknown>) => async (keys: string | string[]) => Object.fromEntries([keys].flat().map((key) => [key, store[key]]));
  const closed = { count: 0 };
  const told: unknown[] = [];
  const asked: { origins: string[]; inClick: boolean }[] = [];
  const grants: { answer: boolean | Error } = { answer: false };
  const held = new Set(world.holds);
  const tabs: string[] = [];
  let clicking = false;
  const changed: (() => void)[] = [];
  const writes: Record<string, unknown>[] = [];
  const write = (store: Record<string, unknown>) => async (values: Record<string, unknown>) => {
    if (store === local) writes.push(values);
    Object.assign(store, values);
    if (world.live === true) for (const listener of changed) listener();
  };
  const removed: number[] = [];
  const chrome = {
    storage: {
      local: { get: read(local), set: write(local) },
      session: { get: read(session), set: write(session) },
      onChanged: { addListener: (listener: () => void) => void changed.push(listener) },
    },
    runtime: {
      id: "testextensionid",
      sendMessage: async (message: { choose?: string[]; stop?: string[] }) => {
        told.push(message);
        if (!Array.isArray(message.choose) || !Array.isArray(message.stop)) return world.answer;
        await choose(message.choose, message.stop);
        return { ok: true };
      },
      openOptionsPage: () => undefined,
      getManifest: () => ({ version: "0.3.0" }),
    },
    permissions: {
      getAll: async () => ({ origins: [] }), contains: async ({ origins }: { origins: string[] }) => origins.every((origin) => held.has(origin)),
      onAdded: { addListener: () => undefined }, onRemoved: { addListener: () => undefined },
      request: (wanted: { origins?: string[] }) => {
        asked.push({ origins: wanted.origins ?? [], inClick: clicking });
        if (grants.answer === true) for (const origin of wanted.origins ?? []) held.add(origin);
        return grants.answer instanceof Error ? Promise.reject(grants.answer) : Promise.resolve(grants.answer);
      },
    },
    tabs: { create: async ({ url }: { url: string }) => void tabs.push(url), getCurrent: async () => ({ id: 41 }), remove: async (id: number) => void removed.push(id) },
  };
  const act = (run: () => void): void => {
    clicking = true;
    try {
      run();
    } finally {
      clicking = false;
    }
  };
  Object.assign(globalThis, { document: page.document, chrome, window: { close: () => void closed.count++ } });
  vi.useFakeTimers({ toFake: ["setInterval"] });
  vi.resetModules();
  await import(`./${name}.js`);
  const text = (id: string): string => page.document.getElementById(id)?.textContent ?? "";
  return {
    document: page.document,
    text,
    stands: (): string => [...page.document.querySelectorAll("#standing .ck-signal__label, #standing .ck-signal__detail, .ls-then")].map((part) => part.textContent).join(" · "),
    accounts: (): { says: string; on: boolean }[] => [...page.document.querySelectorAll("#accounts .ck-srow")].map((row) => ({ says: row.textContent, on: row.querySelector("[role=switch]")?.getAttribute("aria-checked") === "true" })),
    account: (name: string) => [...page.document.querySelectorAll("#accounts .ck-srow")].find((row) => row.querySelector(".ck-srow__label")?.textContent === name)!,
    closed,
    told,
    local,
    writes,
    held,
    removed,
    asked,
    grants,
    tabs,
    click: (element: unknown): void => act(() => (element as { click(): void }).click()),
    submit: (form: unknown): void => act(() => void (form as { dispatchEvent(event: unknown): boolean }).dispatchEvent(new page.Event("submit", { cancelable: true }))),
    type: (id: string, value: string): void => void ((page.document.getElementById(id) as unknown as HTMLInputElement).value = value),
    async close(): Promise<void> {
      vi.useRealTimers();
      await new Promise<void>((resolve) => setImmediate(resolve));
      for (const key of ["document", "chrome", "window"]) Reflect.deleteProperty(globalThis, key);
      await page.happyDOM.close();
    },
  };
}

interface Home {
  readonly url: string;
  readonly drive: string;
  readonly code: string;
  readonly dir: string;
  readonly port: number;
  stop(): Promise<void>;
}

async function stationsAt(options: { floor?: string; release?: string; generation?: number; idle_ms?: number; poll_ms?: number; dir?: string; port?: number; cli?: boolean } = {}, spawned?: (stop: () => Promise<void>) => void): Promise<Home> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "extension-stations-"));
  if (options.cli !== true) {
    const { serveStations } = await loadInprocStations();
    const served = await serveStations(dir, {
      port: options.port ?? 0,
      poll_ms: options.poll_ms ?? 30,
      ...(options.floor === undefined ? {} : { floor: options.floor }),
      ...(options.release === undefined ? {} : { home: { version: options.release, generation: options.generation ?? null } }),
      ...(options.idle_ms === undefined ? {} : { idle_ms: options.idle_ms }),
    });
    const stop = async (): Promise<void> => { await served.close(); await sleep(10); };
    spawned?.(stop);
    const kept = JSON.parse(readFileSync(join(dir, "relay.json"), "utf8")) as { url: string; drive_token: string; code: string };
    return { url: kept.url, drive: kept.drive_token, code: kept.code, dir, port: Number(new URL(kept.url).port), stop };
  }
  const cliBundle = process.env.LIFESTREAM_TEST_DIST === undefined ? undefined : join(process.env.LIFESTREAM_TEST_DIST, "packages~home~test~cli-child.mjs");
  const cli = cliBundle !== undefined && existsSync(cliBundle) ? [cliBundle] : ["--import", "tsx", join(REPO, "packages", "home", "cli.ts")];
  const args = [...cli, "stations", "--state", dir, "--port", String(options.port ?? 0), "--poll-ms", String(options.poll_ms ?? 30)];
  if (options.floor !== undefined) args.push("--floor", options.floor);
  if (options.release !== undefined) args.push("--release", options.release);
  if (options.generation !== undefined) args.push("--generation", String(options.generation));
  if (options.idle_ms !== undefined) args.push("--idle-ms", String(options.idle_ms));
  const child: ChildProcess = spawn(process.execPath, args, { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let errors = "";
  child.stderr!.on("data", (chunk: Buffer) => void (errors += chunk.toString("utf8")));
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const stop = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
  };
  spawned?.(stop);
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.includes("stations at ")) resolve();
    });
    void exited.then(() => reject(new Error(`lifestream stations exited: ${errors}`)));
  });
  const kept = JSON.parse(readFileSync(join(dir, "relay.json"), "utf8")) as { url: string; drive_token: string; code: string };
  return { url: kept.url, drive: kept.drive_token, code: kept.code, dir, port: Number(new URL(kept.url).port), stop };
}

function ownStations(options: Parameters<typeof stationsAt>[0] = {}): Promise<Home> {
  return stationsAt(options, (stop) => onTestFinished(stop));
}

function scripted(): { link: DoorLink; push(calls: Call[], extra?: Partial<ExchangeAnswer>): void; queued(): number; sent: Result[] } {
  const queue: ExchangeAnswer[] = [];
  const sent: Result[] = [];
  let wake: () => void = () => undefined;
  const link: DoorLink = {
    async exchange(_station, results, signal) {
      for (const result of results) if (!sent.some((one) => isDeepStrictEqual(one, result))) sent.push(result);
      while (queue.length === 0) {
        if (signal.aborted) throw new DOMException("cut short", "AbortError");
        await new Promise<void>((resolve) => {
          wake = resolve;
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      return queue.shift()!;
    },
    put: async () => {
      throw new Error("this door takes no file");
    },
  };
  return {
    link,
    push(calls, extra = {}) {
      queue.push({ home: { version: "checkout", generation: null }, calls, needs: [], sites: [], chosen: [], ...extra });
      wake();
    },
    queued: () => queue.length,
    sent,
  };
}

async function paired(home: Home, unit: string, version = "0.3.0"): Promise<Pairing> {
  return (await pair(home.url, home.code, unit, { version })).pairing;
}

describe("extension station", () => {
  const signedIn = { signedIn: true };
  const bankLog: { values: Record<string, string>[] } = { values: [] };
  const bearers: (string | null)[] = [];
  let home: Home;
  let transcript = "";
  let url = "";
  let browser: FixtureBrowser;
  let station: Station;
  let stations: Stations;
  const serving = new AbortController();
  const run: Record<string, unknown> = {};
  const connecting: Record<string, unknown> = {};
  const sent: number[] = [];
  const faults = { put: 0 };

  beforeAll(async () => {
    home = await stationsAt({ cli: true });
    url = home.url;
    transcript = join(home.dir, "transcript.jsonl");
    browser = fixtureBrowser(
      [chatSite(signedIn), tokenSite(), bankSite(bankLog), { ...bankSite({ values: [] }), origin: LOOKALIKE }, { origin: "https://blocked.example", pages: {} }, ...sessionSites(bearers)],
      { allowed: ["https://chat.example", "https://gpt.example", "https://bank.example", LOOKALIKE, APP] },
    );
    const counting: typeof fetch = async (input, init) => {
      if (init?.method === "PUT") {
        if (faults.put > 0 && --faults.put === 0) throw new TypeError("fetch failed");
        sent.push((init.body as Uint8Array).length);
      }
      return fetch(input, init);
    };
    station = createStation({ retryMs: 25, browser, link: httpLink(await paired(home, UNIT), { version: "0.3.0", fetch: counting }), unit: UNIT, version: "0.3.0", slots: 3 });
    void station.serve(serving.signal);
    stations = closing(connect(url, home.drive));
    await presence(stations, UNIT);
  });

  afterAll(async () => {
    serving.abort();
    await home.stop();
    writeFileSync(join(home.dir, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
    mkdirSync(ARTIFACTS, { recursive: true });
    writeFileSync(join(ARTIFACTS, "connect.json"), `${JSON.stringify(connecting, null, 2)}\n`);
    console.log(`extension e2e artifact: ${home.dir}, ${join(ARTIFACTS, "connect.json")}`);
  });

  it("refreshes a chat app's conversations as files, page by page; a closed errand's files are gone (1, 14, 20)", async () => {
    let closed = "";
    await stations.using(SPEC("chat-refresh", ["https://chat.example"]), async (errand) => {
      closed = errand.id;
      const tab = await errand.open("https://chat.example/");
      const orgs = await tab.json("/api/organizations");
      expect(orgs).toMatchObject({ status: 200, json: [{ uuid: "org-aa01" }] });
      const list = await tab.json("/api/organizations/org-aa01/chat_conversations");
      const uuids = (list.json as { uuid: string }[]).map((one) => one.uuid);
      const pulled = await tab.fetch(uuids.map((uuid) => ({
        url: `/api/organizations/org-aa01/chat_conversations/${uuid}?tree=true`, as: "file" as const, name: `conversations/${uuid}.json`,
      })));
      for (const [index, uuid] of uuids.entries()) {
        const bytes = await errand.file(`conversations/${uuid}.json`);
        expect(JSON.parse(Buffer.from(bytes).toString("utf8"))).toMatchObject({ uuid });
        expect(pulled[index]?.file?.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      }
      run["chat"] = pulled.map((one) => one.file);
    });
    expect(await code(stations.attach(closed).file("conversations/c-0001.json"))).toBe("NO_ERRAND");
    const lines = readFileSync(transcript, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line["errand"] === closed);
    expect(lines.map((line) => line["op"])).toEqual(["begin", "open", "fetch", "fetch", "fetch", "end"]);
    expect(lines[4]).toMatchObject({ ok: true, urls: ["GET /api/organizations/org-aa01/chat_conversations/c-0001?tree=true", "GET /api/organizations/org-aa01/chat_conversations/c-0002?tree=true", "GET /api/organizations/org-aa01/chat_conversations/c-0003?tree=true"] });
    expect((lines[4]?.["responses"] as { status: number; bytes: number }[]).every((one) => one.status === 200 && one.bytes > 0)).toBe(true);
    const written = JSON.stringify(lines);
    for (const answered of ["chat_messages", "updated_at", "hello", "sha256", "Recents"]) expect(written).not.toContain(answered);
  });

  it("says a signed-out page is signed out by its status, not by guessing", async () => {
    signedIn.signedIn = false;
    await stations.using(SPEC("chat-refresh", ["https://chat.example"]), async (errand) => {
      const tab = await errand.open("https://chat.example/");
      expect((await tab.json("/api/organizations")).status).toBe(401);
    });
    signedIn.signedIn = true;
  });

  it("keeps a page's session token in the browser and uses it there (2)", async () => {
    await stations.using(SPEC("token-refresh", ["https://gpt.example"]), async (errand) => {
      const tab = await errand.open("https://gpt.example/");
      const session = await tab.json("/api/auth/session", { hold: { name: "token", path: "accessToken" } });
      expect(session).toEqual({ status: 200, url: "https://gpt.example/api/auth/session", held: "token" });
      const list = await tab.json("/backend-api/conversations?offset=0&limit=28", { headers: { authorization: { held: "token", prefix: "Bearer " } } });
      expect(list).toMatchObject({ status: 200, json: { total: 2 } });
      expect(await code(tab.json("/x", { headers: { authorization: { held: "nothing" } } }))).toBe("BAD_CALL");
    });
    expect(readFileSync(transcript, "utf8")).not.toContain(SESSION_TOKEN);
  });

  it("logs in with secrets the home sends, marked as secrets, and redacts them everywhere (3, 4, 8)", async () => {
    const spec = SPEC("bank-statement", ["https://bank.example"], { secrets: ["bank.customer_id", "bank.password"] });
    let id = "";
    await stations.using(spec, async (errand) => {
      id = errand.id;
      const tab = await errand.open("https://bank.example/login");
      const login = await tab.snapshot();
      expect(login.signals).toEqual({ captcha: false, otp: false, password: true, verify: false });
      expect(login.lines).toContain('textbox "Customer ID"');

      expect(await code(tab.fill({ label: "Customer ID" }, { secret: "other.secret", value: CUSTOMER_ID }))).toBe("SECRET_REFUSED");
      expect(await code(tab.fill({ label: "Customer ID" }, { secret: "bank.customer_id" }))).toBe("BAD_CALL");

      await tab.fill({ label: "Customer ID" }, { secret: "bank.customer_id", value: CUSTOMER_ID });
      await tab.fill({ label: "Password" }, { secret: "bank.password", value: PASSWORD });
      const filled = await tab.snapshot({ text: true });
      expect(filled.lines).toContain('textbox "Customer ID" value="[secret]"');
      expect(filled.lines).toContain('textbox "Password" value="[secret]"');
      expect(JSON.stringify(filled)).not.toContain(CUSTOMER_ID);
      const found = await tab.find({ label: "Password" });
      expect(found[0]?.value).toBe("[secret]");
      expect((await tab.find({ label: "Customer ID" }))[0]?.value).toBe("[secret]");

      await tab.click({ role: "button", name: "Login" });
      const dashboard = await tab.wait({ url: "/dashboard$" }, 5_000);
      expect(dashboard.title).toBe("Dashboard");
      expect(bankLog.values.at(-1)).toEqual({ cid: CUSTOMER_ID, pw: PASSWORD });
      expect(dashboard.lines).toContain('heading "Welcome [secret]"');
      expect((await tab.find({ label: "Reference" }))[0]?.value).toBe("[secret]");
      expect(JSON.stringify(await tab.snapshot({ text: true }))).not.toContain(CUSTOMER_ID);

      const ambiguous = await refused(tab.click({ role: "button", name: "Go" }));
      expect(ambiguous.code).toBe("AMBIGUOUS");
      expect(ambiguous.snapshot?.title).toBe("Dashboard");
      const missing = await refused(tab.click({ text: "Transfer funds" }));
      expect(missing.code).toBe("NOT_FOUND");
      expect(missing.snapshot?.lines).toContain('link "Account Statement"');

      const [link] = await tab.find({ role: "link", name: "Account Statement" });
      await tab.click({ ref: link?.ref as string });
      await tab.wait({ role: "heading", name: "Account Statement" }, 5_000);
      expect(await code(tab.click({ ref: link?.ref as string }))).toBe("REF_STALE");

      expect(await tab.select({ label: "Period" }, "Custom Date")).toBe("Custom Date");
      await tab.click({ role: "radio", name: "Text" });
      expect((await tab.find({ role: "radio", name: "Text" }))[0]?.checked).toBe(true);
    });
    const written = readFileSync(transcript, "utf8");
    expect(written).not.toContain(CUSTOMER_ID);
    expect(written).not.toContain(PASSWORD);
    const fills = written.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line["errand"] === id && line["op"] === "fill" && line["ok"] === true);
    expect(fills.map((line) => line["secrets"])).toEqual([["bank.customer_id"], ["bank.password"]]);
  });

  it("reads a page that wants a person as such (7)", async () => {
    await stations.using(SPEC("bank-statement", ["https://bank.example"]), async (errand) => {
      const tab = await errand.open("https://bank.example/otp");
      expect((await tab.snapshot()).signals).toEqual({ captcha: false, otp: true, password: false, verify: false });
      await tab.goto("https://bank.example/verify");
      expect((await tab.snapshot()).signals).toEqual({ captcha: false, otp: false, password: false, verify: true });
      await tab.goto("https://bank.example/otp-shadow");
      const shadowed = await tab.snapshot();
      expect(shadowed.lines).toContain('textbox "Enter OTP"');
      expect(shadowed.signals).toEqual({ captcha: false, otp: true, password: true, verify: true });
      await tab.goto("https://bank.example/challenge");
      expect((await tab.snapshot()).signals.captcha).toBe(true);
    });
  });

  it("never goes, or keeps acting, outside its origins (5, 6)", async () => {
    await stations.using(SPEC("bank-statement", ["https://bank.example", "https://blocked.example"]), async (errand) => {
      expect(await code(errand.open("https://chat.example/"))).toBe("ORIGIN_REFUSED");
      expect(await code(errand.open("https://blocked.example/"))).toBe("SITE_NOT_ALLOWED");
      const tab = await errand.open("https://bank.example/dashboard");
      expect(await code(tab.json("https://chat.example/api/organizations"))).toBe("ORIGIN_REFUSED");
      await tab.click({ role: "link", name: "Offers" });
      await until("the tab off the errand's origins", async () => {
        const seen = await browser.look(tab.id);
        return "url" in seen && new URL(seen.url).origin !== "https://bank.example";
      });
      expect(await code(tab.snapshot())).toBe("ORIGIN_REFUSED");
      expect(await code(errand.open("https://bank.example/login"))).toBe("ORIGIN_REFUSED");
    });
  });

  it("answers a call whose errand ended under it `NO_ERRAND`, a closed tab and a withdrawn grant without refusing the errand, and waits out a tab with no page yet (64)", async () => {
    await stations.using(SPEC("ends under its wait", ["https://bank.example"], { deadline_ms: 150 }), async (errand) => {
      const tab = await errand.open("https://bank.example/login");
      expect(await code(tab.wait({ text: "never on the page" }, 20_000))).toBe("NO_ERRAND");
    });
    await stations.using(SPEC("bank-statement", ["https://bank.example"]), async (errand) => {
      const closed = await errand.open("https://bank.example/login");
      await browser.closeTab(closed.id);
      const gone = await refused(closed.snapshot());
      expect([gone.code, gone.message]).toEqual(["PAGE_ERROR", "the tab was closed"]);
      const tab = await errand.open("https://bank.example/login");
      browser.withdraw("https://bank.example");
      try {
        expect(await code(tab.snapshot())).toBe("SITE_NOT_ALLOWED");
      } finally {
        browser.allow("https://bank.example");
      }
      expect((await tab.snapshot()).title).toBe("NetBanking");

      browser.stall(2);
      expect(await tab.goto("https://bank.example/dashboard")).toBe("");
      const early = await refused(tab.snapshot());
      expect([early.code, early.message]).toEqual(["PAGE_ERROR", "the tab has no page yet"]);
      browser.stall(3);
      expect(await tab.goto("https://bank.example/statement")).toBe("");
      expect((await tab.wait({ role: "heading", name: "Account Statement" }, 5_000)).title).toBe("Statement");
      browser.stall(3);
      const slow = await errand.open("https://bank.example/otp");
      expect((await slow.wait({ label: "Enter OTP" }, 5_000)).title).toBe("Verify");
    });
  });

  it("acts only in the document it checked, on the errand's origins: a navigation between the look and the call, or the page's origin changed under it, fills nothing; a history push fails no call (65)", async () => {
    const spec = SPEC("bank-statement", ["https://bank.example"], { secrets: ["bank.customer_id"] });
    const fill = { secret: "bank.customer_id", value: CUSTOMER_ID };
    await stations.using(spec, async (errand) => {
      const tab = await errand.open("https://bank.example/login");
      let other = "";
      browser.beforeTarget(async () => {
        await browser.navigate(tab.id, `${LOOKALIKE}/login`, 0);
        other = (await browser.look(tab.id) as { document: string }).document;
      });
      const changed = await refused(tab.fill({ label: "Customer ID" }, fill));
      expect([changed.code, changed.message]).toEqual(["PAGE_ERROR", "the page changed under the call"]);
      expect(browser.fields(other)).toEqual({ cid: "", pw: "" });
      expect(await code(tab.snapshot())).toBe("ORIGIN_REFUSED");
    });
    await stations.using(spec, async (errand) => {
      const tab = await errand.open("https://bank.example/login");
      const { document } = await browser.look(tab.id) as { document: string };
      browser.afterTarget(() => browser.relocate(tab.id, `${LOOKALIKE}/login`));
      const left = await refused(tab.fill({ label: "Customer ID" }, fill));
      expect([left.code, left.message]).toEqual(["ORIGIN_REFUSED", "the page left the errand's origins under the call"]);
      expect(browser.fields(document)).toEqual({ cid: "", pw: "" });
      expect(await browser.look(tab.id)).toEqual({ loading: true });
      expect(await code(tab.snapshot())).toBe("ORIGIN_REFUSED");
    });
    await stations.using(SPEC("bank-statement", ["https://bank.example"]), async (errand) => {
      const tab = await errand.open("https://bank.example/dashboard");
      browser.relocate(tab.id, "https://bank.example/dashboard?view=accounts");
      expect((await tab.snapshot()).title).toBe("Dashboard");
      browser.afterTarget(() => browser.relocate(tab.id, "https://bank.example/dashboard#offers"));
      expect(await tab.find({ role: "link", name: "Account Statement" })).toHaveLength(1);
    });
  });

  it("leaves a tab the person took out of the station's window to them: the next call says so, the one after names no tab of the errand's, nothing acts there, and the errand's end leaves it open (66)", async () => {
    let taken = 0;
    await stations.using(SPEC("bank-statement", ["https://bank.example"]), async (errand) => {
      const tab = await errand.open("https://bank.example/login");
      taken = tab.id;
      const submitted = bankLog.values.length;
      browser.take(tab.id);
      const first = await refused(tab.click({ role: "button", name: "Login" }));
      expect([first.code, first.message]).toEqual(["PAGE_ERROR", "the person took the tab"]);
      expect(await code(tab.click({ role: "button", name: "Login" }))).toBe("BAD_CALL");
      expect(bankLog.values.length).toBe(submitted);
      expect(browser.saved().find((one) => one.id === errand.id)?.tabs).toEqual([]);
    });
    expect(browser.tabs.has(taken)).toBe(true);
    await browser.closeTab(taken);
  });

  it("sends a header from a cookie the errand names that never leaves the page, refuses an answer repeating it, and sends none with no cookie (51)", async () => {
    browser.cookie(APP, SESSION_COOKIE, COOKIE_TOKEN);
    browser.cookie(APP, "other", "x");
    const bearer = { authorization: { cookie: SESSION_COOKIE, prefix: "Bearer " } };
    const answered: unknown[] = [];
    let batch: unknown;
    let id = "";
    await stations.using(SPEC("session-refresh", [APP, API], { cookies: [SESSION_COOKIE] }), async (errand) => {
      id = errand.id;
      await errand.open(`${APP}/account`).then(async (shows) => {
        const shown = await shows.snapshot({ text: true });
        const headings = await shows.find({ role: "heading" });
        expect([shown.lines, shown.text, headings.map((heading) => heading.name)]).toEqual([expect.stringContaining('heading "Session [secret]"'), expect.stringContaining("Session [secret]"), ["Session [secret]"]]);
        answered.push(shown, headings);
      });
      const tab = await errand.open(`${APP}/`);
      const me = await tab.json(`${API}/v1/me`, { headers: bearer });
      expect(me).toMatchObject({ status: 200, json: { user: { id: 10000001 } } });
      expect(bearers.at(-1)).toBe(`Bearer ${COOKIE_TOKEN}`);
      const answers = await tab.fetch([
        { url: `${API}/v1/cycles`, as: "file", name: "cycles.json", headers: bearer },
        { url: `${API}/v1/echo`, as: "json", headers: bearer },
        { url: `${API}/v1/echo-file`, as: "file", name: "echo.bin", headers: bearer },
        { url: `${API}/v1/refused-echo`, as: "json", headers: bearer },
        { url: `${API}/v1/escaped-echo`, as: "json", headers: bearer },
        { url: `${API}/v1/escaped-echo-file`, as: "file", name: "escaped.json", headers: bearer },
      ]);
      answered.push(me, answers);
      batch = answers;
      const echoed = { status: 0, error: { code: "PAGE_ERROR", message: "the answer repeats a value the errand holds" } };
      expect(answers.map(({ status, error }) => ({ status, error }))).toEqual([{ status: 200, error: undefined }, echoed, echoed, echoed, echoed, echoed]);
      expect(answers.slice(1).every((answer) => answer.json === undefined && answer.file === undefined)).toBe(true);
      const kept = await errand.file("cycles.json");
      expect(JSON.parse(Buffer.from(kept).toString("utf8"))).toEqual({ records: [{ id: 1, user_id: 10000001 }] });
      expect(answers[0]?.file?.sha256).toBe(createHash("sha256").update(kept).digest("hex"));
      expect(await code(errand.file("echo.bin"))).toBe("NOT_FOUND");
      expect(await code(errand.file("escaped.json"))).toBe("NOT_FOUND");
      const outline = await tab.snapshot({ text: true });
      answered.push(outline, await tab.find({ role: "heading" }), browser.saved());

      browser.cookie(APP, SESSION_COOKIE, LONG_COOKIE_TOKEN);
      await tab.goto(`${APP}/long-account`);
      const long = [await tab.snapshot({ text: true }), await tab.find({ role: "heading" })] as const;
      expect(long[1].map((heading) => heading.name)).toEqual(["Session [secret]"]);
      expect(JSON.stringify(long)).not.toContain(LONG_COOKIE_TOKEN.slice(0, 16));
      answered.push(...long);
      browser.cookie(APP, SESSION_COOKIE, COOKIE_TOKEN);

      expect(await tab.json(`${API}/v1/echo`, { headers: bearer, hold: { name: "echoed", path: "you.token" } })).toEqual({ status: 200, url: `${API}/v1/echo`, held: "echoed" });
      const away = await tab.json(`${API}/v1/away`, { headers: bearer, hold: { name: "away", path: "token" } });
      expect(away).toEqual({ status: 0, url: `${API}/v1/away`, error: echoed.error });
      answered.push(away);

      browser.cookie(APP, SESSION_COOKIE, null);
      expect((await tab.json(`${API}/v1/me`, { headers: bearer })).status).toBe(401);
      expect(bearers.at(-1)).toBeNull();
      browser.cookie(APP, SESSION_COOKIE, COOKIE_TOKEN);

      const unknown = await refused(tab.json(`${API}/v1/me`, { headers: { authorization: { local: "x" } as never } }));
      expect([unknown.code, unknown.message]).toEqual(["BAD_CALL", "this extension (0.3.0) does not know a value of shape { local }: update it"]);
      expect(await code(tab.json(`${API}/v1/me`, { headers: { authorization: { cookie: "a b" } } }))).toBe("BAD_CALL");
      const before = bearers.length;
      const other = await refused(tab.json(`${API}/v1/me`, { headers: { authorization: { cookie: "other" } } }));
      expect([other.code, other.message, bearers.length]).toEqual(["BAD_CALL", 'cookie "other" is not the errand\'s', before]);
      expect(await code(tab.fill({ role: "heading" }, { cookie: SESSION_COOKIE }))).toBe("BAD_CALL");
    });
    browser.cookie(APP, SESSION_COOKIE, null);
    expect(JSON.stringify(answered)).not.toContain(COOKIE_TOKEN);
    expect(JSON.stringify(answered)).not.toContain(LONG_COOKIE_TOKEN.slice(0, 16));
    const lines = readFileSync(transcript, "utf8").trim().split("\n").filter((line) => line.includes(id));
    expect(lines.join("\n")).not.toContain(COOKIE_TOKEN);
    expect(lines.join("\n")).not.toContain(LONG_COOKIE_TOKEN.slice(0, 16));
    expect(lines.length).toBeGreaterThan(0);
    run["cookie"] = { bearers: bearers.map((one) => (one === null ? null : "Bearer [the cookie's value]")), answers: batch };
  });

  it("answers a navigation's address with more than its origin, where a named cookie's value rides its path, query or fragment (71)", async () => {
    browser.cookie(APP, SESSION_COOKIE, COOKIE_TOKEN);
    onTestFinished(() => browser.cookie(APP, SESSION_COOKIE, null));
    await stations.using(SPEC("session-refresh", [APP, API], { cookies: [SESSION_COOKIE] }), async (errand) => {
      const tab = await errand.open(`${APP}/`);
      browser.afterTarget((at) => browser.relocate(at, `${APP}/${COOKIE_TOKEN}/next?session=${COOKIE_TOKEN}#t=${COOKIE_TOKEN}`));
      expect(await tab.click({ role: "heading", name: "Today" })).toBe(APP);
      expect(await tab.goto(`${APP}/account?from=${COOKIE_TOKEN}`)).toBe(APP);
    });
  });

  it("names no address but its origin, or its scheme, in a refusal of the page the tab went to, where a named cookie's value rides (71)", async () => {
    browser.cookie(APP, SESSION_COOKIE, COOKIE_TOKEN);
    onTestFinished(() => browser.cookie(APP, SESSION_COOKIE, null));
    const refusals: StationError[] = [];
    await stations.using(SPEC("session-refresh", [APP, API], { cookies: [SESSION_COOKIE] }), async (errand) => {
      const tab = await errand.open(`${APP}/`);
      browser.relocate(tab.id, `about:blank#${COOKIE_TOKEN}`);
      refusals.push(await refused(tab.snapshot()));
      refusals.push(await refused(tab.snapshot()));
    });
    expect(refusals.map((error) => [error.code, error.message])).toEqual([
      ["ORIGIN_REFUSED", "the tab went to about:, outside the errand's origins"],
      ["ORIGIN_REFUSED", "the errand left its origins (about:) and ends"],
    ]);
  });

  it("matches a locator against the page's own words, and withholds the name it answers (72)", async () => {
    browser.cookie(APP, SESSION_COOKIE, COOKIE_TOKEN);
    onTestFinished(() => browser.cookie(APP, SESSION_COOKIE, null));
    await stations.using(SPEC("session-refresh", [APP, API], { cookies: [SESSION_COOKIE] }), async (errand) => {
      const tab = await errand.open(`${APP}/`);
      browser.write(tab.id, `<button>Continue as ${COOKIE_TOKEN}</button><button>Continue as ck-other</button>`);
      const wanted = { role: "button", name: `Continue as ${COOKIE_TOKEN}`, exact: true } as const;
      expect((await tab.find(wanted)).map((found) => found.name)).toEqual(["Continue as [secret]"]);
      expect(await tab.click(wanted)).toBe(APP);
      expect((await tab.find({ role: "button", name: "Continue as" })).map((found) => found.name)).toEqual(["Continue as [secret]", "Continue as ck-other"]);
    });
  });

  it("matches a locator against the whole of a name longer than an answer carries, and answers it withheld, then cut (72)", async () => {
    browser.cookie(APP, SESSION_COOKIE, LONG_COOKIE_TOKEN);
    onTestFinished(() => browser.cookie(APP, SESSION_COOKIE, null));
    const tail = " and then the rest of a long label".repeat(4);
    await stations.using(SPEC("session-refresh", [APP, API], { cookies: [SESSION_COOKIE] }), async (errand) => {
      const tab = await errand.open(`${APP}/`);
      browser.write(tab.id, `<button>${LONG_COOKIE_TOKEN}${tail}</button>`);
      const wanted = { role: "button", name: `${LONG_COOKIE_TOKEN}${tail}`, exact: true } as const;
      const answered = `[secret]${tail}`;
      expect((await tab.find(wanted)).map((found) => found.name)).toEqual([`${answered.slice(0, 119)}…`]);
      expect(await tab.click(wanted)).toBe(APP);
    });
  });

  it("holds a value for a request that leaves out its `as` as a JSON body's, never refusing the body for the value it holds (51)", async () => {
    browser.cookie(APP, SESSION_COOKIE, COOKIE_TOKEN);
    onTestFinished(() => browser.cookie(APP, SESSION_COOKIE, null));
    const bearer = { authorization: { cookie: SESSION_COOKIE, prefix: "Bearer " } };
    await stations.using(SPEC("session-refresh", [APP, API], { cookies: [SESSION_COOKIE] }), async (errand) => {
      const tab = await errand.open(`${APP}/`);
      const bare = { url: `${API}/v1/echo`, headers: bearer, hold: { name: "bare", path: "you.token" } } as unknown as PageRequest;
      expect(await tab.fetch([bare])).toEqual([{ status: 200, url: `${API}/v1/echo`, held: "bare" }]);
    });
  });

  it("withholds the tag a found element without a role answers as its role (72)", async () => {
    browser.cookie(APP, SESSION_COOKIE, COOKIE_TOKEN);
    onTestFinished(() => browser.cookie(APP, SESSION_COOKIE, null));
    await stations.using(SPEC("session-refresh", [APP, API], { cookies: [SESSION_COOKIE] }), async (errand) => {
      const tab = await errand.open(`${APP}/`);
      browser.write(tab.id, `<${COOKIE_TOKEN}>Today's card</${COOKIE_TOKEN}>`);
      const found = await tab.find({ css: "*" });
      expect(found.map((each) => each.role)).toContain("[secret]");
      expect(JSON.stringify(found)).not.toContain(COOKIE_TOKEN);
    });
  });

  it("admits a page's request to another of the errand's origins with Chrome holding only the page's, and none outside them (52)", async () => {
    browser.cookie(APP, SESSION_COOKIE, COOKIE_TOKEN);
    onTestFinished(() => browser.cookie(APP, SESSION_COOKIE, null));
    const bearer = { authorization: { cookie: SESSION_COOKIE, prefix: "Bearer " } };
    expect([await browser.allowed(APP), await browser.allowed(API)]).toEqual([true, false]);
    await stations.using(SPEC("session-refresh", [APP, API], { cookies: [SESSION_COOKIE] }), async (errand) => {
      const tab = await errand.open(`${APP}/`);
      expect((await tab.json(`${API}/v1/me`, { headers: bearer })).status).toBe(200);
      expect(await code(errand.open(`${API}/`))).toBe("SITE_NOT_ALLOWED");
    });
    await stations.using(SPEC("session-refresh", [APP], { cookies: [SESSION_COOKIE] }), async (errand) => {
      const tab = await errand.open(`${APP}/`);
      const before = bearers.length;
      expect(await code(tab.json(`${API}/v1/me`, { headers: bearer }))).toBe("ORIGIN_REFUSED");
      expect(bearers.length).toBe(before);
    });
  });

  it("withholds what the errand knows in one step before any cut, and refuses whole a page's answer that repeats it, a value held in the same batch among them; a file holds no value (70)", async () => {
    await stations.using(SPEC("bank-statement", ["https://bank.example"], { secrets: ["bank.customer_id"] }), async (errand) => {
      const tab = await errand.open("https://bank.example/login");
      await tab.fill({ label: "Customer ID" }, { secret: "bank.customer_id", value: LONG_SECRET });
      const shown = [await tab.snapshot({ text: true }), await tab.find({ label: "Customer ID" })] as const;
      expect(shown[0].lines).toContain('textbox "Customer ID" value="[secret]"');
      const written = JSON.stringify(shown);
      for (let at = 0; at + 20 <= LONG_SECRET.length; at++) expect(written).not.toContain(LONG_SECRET.slice(at, at + 20));
    });
    await stations.using(SPEC("token-refresh", ["https://gpt.example"], { secrets: ["gpt.key"] }), async (errand) => {
      const tab = await errand.open("https://gpt.example/");
      const refusal = { code: "PAGE_ERROR", message: "the answer repeats a value the errand holds" };
      const key = { "x-key": { secret: "gpt.key", value: API_KEY } };
      expect(await tab.fetch([{ url: "/backend-api/echo-key", as: "file", name: "key.bin", headers: key }])).toEqual([
        { status: 0, url: "https://gpt.example/backend-api/echo-key", error: refusal },
      ]);
      expect(await code(errand.file("key.bin"))).toBe("NOT_FOUND");
      const answers = await tab.fetch([
        { url: "/api/auth/session", as: "json", hold: { name: "token", path: "accessToken" } },
        { url: "/backend-api/late-file", as: "file", name: "late.bin" },
        { url: "/backend-api/late-json", as: "json" },
        { url: "/backend-api/late-plain", as: "json" },
        { url: "/backend-api/after", as: "json" },
      ]);
      expect(answers.map(({ status, held, json, error, file }) => ({ status, held, json, error, file }))).toEqual([
        { status: 200, held: "token" }, { status: 0, error: refusal }, { status: 0, error: refusal }, { status: 200, json: { late: true } }, { status: 200, json: { after: true } },
      ]);
      expect(await code(errand.file("late.bin"))).toBe("NOT_FOUND");
      const bearer = { authorization: { held: "token", prefix: "Bearer " } };
      expect((await tab.json("/backend-api/conversations?offset=0&limit=28", { headers: bearer })).status).toBe(200);
      expect(await tab.json("/backend-api/keyed")).toEqual({ status: 0, url: "https://gpt.example/backend-api/keyed", error: refusal });
      const first: PageRequest = { url: "/backend-api/conversations?offset=0&limit=28", as: "file", name: "first.json", headers: bearer };
      const holdFile = { url: "/backend-api/conversations?offset=0&limit=28", as: "file", name: "held.json", hold: { name: "again", path: "total" } } as unknown as PageRequest;
      expect(await code(tab.fetch([first, holdFile]))).toBe("BAD_CALL");
      const past = await station.handle({ id: "hold-file-70", errand: errand.id, op: "fetch", tab: tab.id, requests: [first, holdFile] });
      expect(past).toMatchObject({ ok: false, error: { code: "BAD_CALL" } });
      expect(await code(errand.file("first.json"))).toBe("NOT_FOUND");
    });
    expect(readFileSync(transcript, "utf8")).not.toMatch(new RegExp(`${API_KEY}|${LONG_SECRET.slice(0, 20)}`, "u"));
  });

  it("one request of a batch that fails alone fails the others, or keeps a file; a call refused whole fetches nothing (43)", async () => {
    let id = "";
    await stations.using(SPEC("token-refresh", ["https://gpt.example"]), async (errand) => {
      id = errand.id;
      const tab = await errand.open("https://gpt.example/");
      await tab.json("/api/auth/session", { hold: { name: "token", path: "accessToken" } });
      const bearer = { authorization: { held: "token", prefix: "Bearer " } };
      const answers = await tab.fetch([
        { url: "/backend-api/conversations?offset=0&limit=28", as: "file", name: "good.json", headers: bearer },
        { url: "/backend-api/huge", as: "file", name: "huge.bin" },
        { url: "/backend-api/elsewhere", as: "file", name: "moved.bin" },
      ]);
      expect(answers.map((answer) => [answer.status, answer.error?.code ?? null, answer.file?.name ?? null])).toEqual([
        [200, null, "good.json"], [0, "TOO_LARGE", null], [0, "ORIGIN_REFUSED", null],
      ]);
      expect(answers[1]?.url).toBe("https://gpt.example/backend-api/huge");
      expect(JSON.parse(Buffer.from(await errand.file("good.json")).toString("utf8"))).toMatchObject({ total: 2 });
      for (const name of ["huge.bin", "moved.bin"]) expect(await code(errand.file(name))).toBe("NOT_FOUND");
      expect((await tab.fetch([{ url: "/backend-api/conversations?offset=0&limit=28", as: "file", name: "huge.bin", headers: bearer }]))[0]?.status).toBe(200);

      for (const [refusal, wanted] of [
        [{ url: "https://chat.example/api/organizations", as: "file" as const, name: "far.json" }, "ORIGIN_REFUSED"],
        [{ url: "/backend-api/conversations?offset=0&limit=28", as: "file" as const, name: "unheld.json", headers: { authorization: { held: "nothing" } } }, "BAD_CALL"],
      ] as const) {
        expect(await code(tab.fetch([{ url: "/backend-api/conversations?offset=0&limit=28", as: "file", name: `before-${wanted}.json`, headers: bearer }, refusal]))).toBe(wanted);
        expect(await code(errand.file(`before-${wanted}.json`))).toBe("NOT_FOUND");
      }
      const twice = { url: "/backend-api/conversations?offset=0&limit=28", as: "file" as const, name: "twice.json", headers: bearer };
      expect(await code(tab.fetch([twice, twice]))).toBe("BAD_CALL");
      expect(await code(errand.file("twice.json"))).toBe("NOT_FOUND");
    });
    const lines = readFileSync(transcript, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line["errand"] === id && line["op"] === "fetch");
    expect(lines[1]).toMatchObject({ ok: true, responses: [{ status: 200 }, { status: 0, bytes: 0, code: "TOO_LARGE" }, { status: 0, bytes: 0, code: "ORIGIN_REFUSED" }] });
    expect((lines[1]?.["responses"] as Record<string, unknown>[])[0]).not.toHaveProperty("code");
    expect(lines.slice(3).map((line) => [line["ok"], line["code"]])).toEqual([[false, "ORIGIN_REFUSED"], [false, "BAD_CALL"], [false, "BAD_CALL"]]);
    run["alone"] = lines.map((line) => ({ ok: line["ok"], code: line["code"], responses: line["responses"] }));
  });

  it("a page that cannot run the script answers each request alone, rather than failing the call (43)", async () => {
    await stations.using(SPEC("token-refresh", ["https://gpt.example"]), async (errand) => {
      const tab = await errand.open("https://gpt.example/");
      browser.breakPage(tab.id);
      const failed = await refused(tab.fetch([
        { url: "/api/auth/session", as: "json" },
        { url: "/backend-api/huge", as: "file", name: "broken.bin" },
      ]));
      expect(failed.code).toBe("PAGE_ERROR");
      expect(await code(errand.file("broken.bin"))).toBe("NOT_FOUND");
      await tab.goto("https://gpt.example/");
      expect((await tab.json("/api/auth/session")).status).toBe(200);
    });
  });

  it("a request whose fetch gets no answer is the request's while the site is reachable, and the network's when it is not (44)", async () => {
    await stations.using(SPEC("token-refresh", ["https://gpt.example"]), async (errand) => {
      const tab = await errand.open("https://gpt.example/");
      await tab.json("/api/auth/session", { hold: { name: "token", path: "accessToken" } });
      const batch = (n: number) => [
        { url: "/backend-api/conversations?offset=0&limit=28", as: "file" as const, name: `kept-${n}.json`, headers: { authorization: { held: "token", prefix: "Bearer " } } },
        { url: "/backend-api/reset", as: "file" as const, name: `reset-${n}.bin` },
      ];
      const answers = await tab.fetch(batch(1));
      expect(answers.map((answer) => [answer.status, answer.error?.code ?? null])).toEqual([[200, null], [0, "PAGE_ERROR"]]);
      expect(answers[1]?.url).toBe("https://gpt.example/backend-api/reset");
      expect(JSON.parse(Buffer.from(await errand.file("kept-1.json")).toString("utf8"))).toMatchObject({ total: 2 });
      expect(await code(errand.file("reset-1.bin"))).toBe("NOT_FOUND");
      browser.reach("https://gpt.example", false);
      try {
        expect(await code(tab.fetch(batch(2)))).toBe("OFFLINE");
      } finally {
        browser.reach("https://gpt.example", true);
      }
    });
  });

  it("runs errands side by side, one per origin, up to its slots, in one window (11, 13)", async () => {
    const chat = await stations.open(SPEC("chat", ["https://chat.example"]));
    const gpt = await stations.open(SPEC("gpt", ["https://gpt.example"]));
    const bank = await stations.open(SPEC("bank", ["https://bank.example"]));
    const [chatTab, gptTab, bankTab] = await Promise.all([chat.open("https://chat.example/"), gpt.open("https://gpt.example/"), bank.open("https://bank.example/login")]);
    let ended = false;
    const waited = bankTab.wait({ text: "Statement ready" }, 60_000).finally(() => void (ended = true));
    const [orgs, session] = await Promise.all([chatTab.json("/api/organizations"), gptTab.json("/api/auth/session", { hold: { name: "token", path: "accessToken" } })]);
    expect([orgs.status, session.status, ended]).toEqual([200, 200, false]);
    browser.write(bankTab.id, "<p>Statement ready</p>");
    await waited;
    const held = await fetch(`${url}/v1/errands/${bank.id}/calls`, {
      method: "POST",
      headers: { authorization: `Bearer ${home.drive}`, "content-type": "application/json" },
      body: JSON.stringify({ op: "wait", tab: bankTab.id, for: { text: "Statement filed" }, ms: 60_000 }),
    });
    browser.write(bankTab.id, "<p>Statement filed</p>");
    expect(await held.json()).toMatchObject({ ok: true });
    expect(browser.windows.size).toBe(1);
    const [kept] = browser.windows;
    expect(browser.tabs.size).toBe(3);
    expect((await stations.list()).find((one) => one.unit === UNIT)?.errands).toHaveLength(3);

    expect(await code(stations.open(SPEC("fourth", ["https://blocked.example"])))).toBe("BUSY");
    expect(await code(stations.open(SPEC("fourth", ["https://blocked.example"]), { station: UNIT }))).toBe("BUSY");

    expect(await code(stations.open(SPEC("chat-again", ["https://chat.example"]), { wait_ms: 60 }))).toBe("BUSY");
    const waiting = stations.open(SPEC("chat-again", ["https://chat.example"]), { wait_ms: 5_000 });
    // paces: the stations record no waiting open a test could wait on.
    await sleep(60);
    await chat.close();
    const again = await waiting;
    expect((await (await again.open("https://chat.example/")).json("/api/organizations")).status).toBe(200);

    await Promise.all([again.close(), gpt.close(), bank.close()]);
    expect(browser.tabs.size).toBe(0);
    expect([...browser.windows]).toEqual([kept]);
  });

  it("ends an errand no driver reaches, and an errand at its deadline, closing their tabs (11, 12, 15)", async () => {
    const idle = await ownStations({ idle_ms: 150 });
    const quiet = fixtureBrowser([chatSite(signedIn)]);
    const serves = new AbortController();
    onTestFinished(() => serves.abort());
    void createStation({ retryMs: 25, browser: quiet, link: httpLink(await paired(idle, "chrome-0000aa02"), { version: "0.3.0" }), unit: "chrome-0000aa02", version: "0.3.0" }).serve(serves.signal);
    const driver = connect(idle.url, idle.drive);
    await presence(driver, "chrome-0000aa02");
    const left = await driver.open(SPEC("left", ["https://chat.example"]));
    await left.open("https://chat.example/");
    const tab = await left.open("https://chat.example/");
    expect(await code(tab.wait({ text: "never on the page" }, 250))).toBe("TIMEOUT");
    expect(quiet.tabs.size).toBe(2);
    await until("the idle errand's tabs closed", () => quiet.tabs.size === 0);
    expect(await code(left.open("https://chat.example/"))).toBe("NO_ERRAND");
    expect(quiet.tabs.size).toBe(0);
    expect(quiet.windows.size).toBe(1);
    await driver.using(SPEC("next", ["https://chat.example"]), async (errand) => void (await errand.open("https://chat.example/")));

    const short = await driver.open(SPEC("short", ["https://chat.example"], { deadline_ms: 100 }));
    await short.open("https://chat.example/");
    await until("the errand's tab closed at its deadline", () => quiet.tabs.size === 0);
    expect(await code(short.open("https://chat.example/"))).toBe("NO_ERRAND");
    expect(quiet.tabs.size).toBe(0);
    expect(quiet.windows.size).toBe(1);
  });

  it("hands a large file the page answers to the stations in parts, hashed there, tells the driver where it lies, and fails one whose part was lost with its name free (17, 26)", async () => {
    const kept: string[] = [];
    await stations.using(SPEC("export", ["https://gpt.example"]), async (errand) => {
      const tab = await errand.open("https://gpt.example/");
      await tab.json("/api/auth/session", { hold: { name: "token", path: "accessToken" } });
      const exported = (name: string): PageRequest => ({ url: "/backend-api/export", as: "file", name, headers: { authorization: { held: "token", prefix: "Bearer " } } });
      const hash = createHash("sha256").update(EXPORT).digest("hex");
      sent.length = 0;
      const [answer] = await tab.fetch([exported("export.zip")]);
      expect(answer).toMatchObject({ status: 200, file: { name: "export.zip", bytes: EXPORT.length, sha256: hash } });
      const path = answer?.file?.path ?? "";
      expect(path.startsWith(join(home.dir, "files"))).toBe(true);
      expect(readFileSync(path).equals(EXPORT)).toBe(true);
      kept.push(path);
      expect(Buffer.from(await errand.file("export.zip")).equals(EXPORT)).toBe(true);
      expect(sent).toHaveLength(2);
      expect(Math.max(...sent)).toBeLessThanOrEqual(PART_BYTES);
      sent.length = 0;
      faults.put = 2;
      expect(await code(tab.fetch([exported("retry.zip")]))).toBe("DOWNLOAD_FAILED");
      expect(sent).toHaveLength(1);
      expect((await tab.fetch([exported("retry.zip")]))[0]?.file).toMatchObject({ name: "retry.zip", bytes: EXPORT.length, sha256: hash });
      expect(Buffer.from(await errand.file("retry.zip")).equals(EXPORT)).toBe(true);
      expect((await tab.fetch([{ url: "/backend-api/huge", as: "file", name: "huge.bin" }]))[0]?.error?.code).toBe("TOO_LARGE");
    });
    expect(readFileSync(transcript, "utf8")).not.toContain(SESSION_TOKEN);
    await until("the untaken file removed", () => !kept.some((path) => existsSync(path)));
  });

  it("hands its errands to the station that starts after it, tabs and held values too (18)", async () => {
    const first = await ownStations();
    const same = fixtureBrowser([tokenSite()]);
    const pairing = await paired(first, "chrome-0000aa03");
    const serve = (): AbortController => {
      const controller = new AbortController();
      void createStation({ retryMs: 25, browser: same, link: httpLink(pairing, { version: "0.3.0" }), unit: "chrome-0000aa03", version: "0.3.0" }).serve(controller.signal);
      return controller;
    };
    const bearer = { authorization: { held: "token", prefix: "Bearer " } };
    const serves = [serve()];
    onTestFinished(() => serves.forEach((controller) => controller.abort()));
    const driver = connect(first.url, first.drive);
    await presence(driver, "chrome-0000aa03");
    const errand = await driver.open(SPEC("survives", ["https://gpt.example"]));
    const tab = await errand.open("https://gpt.example/");
    await tab.json("/api/auth/session", { hold: { name: "token", path: "accessToken" } });
    await until("nothing held at the station", async () => (await driver.list()).some((one) => one.unit === "chrome-0000aa03" && one.running.length === 0));
    const waiting = code(tab.wait({ text: "never on the page" }, 5_000));
    await until("the wait running at the station", async () => (await driver.list()).some((one) => one.unit === "chrome-0000aa03" && one.running.length > 0));
    serves[0]?.abort();
    serves.push(serve());
    expect(await waiting).toBe("INTERRUPTED");
    expect((await tab.json("/backend-api/conversations", { headers: bearer })).status).toBe(200);
    expect([same.tabs.size, same.windows.size]).toEqual([1, 1]);
    expect(JSON.stringify(same.saved())).toContain(SESSION_TOKEN);

    serves[1]?.abort();
    await first.stop();
    await ownStations({ dir: first.dir, port: first.port });
    serves.push(serve());
    await until("the old station's tabs and saved errands gone", () => same.tabs.size === 0 && same.saved().length === 0);
  });

  it("holds a store build on a home older than its stamp or naming none, sending it no file, and lets go at an updated home's first answer (46)", async () => {
    const STAMP = 2000;
    const unit = "chrome-0000aa0e";
    const same = fixtureBrowser([tokenSite(), chatSite(signedIn)]);
    let home = await ownStations({ release: "rel-newer", generation: STAMP + 1 });
    const pairing = await paired(home, unit);
    const parts = { puts: 0 };
    const counted: typeof fetch = async (input, init) => {
      if (init?.method === "PUT") parts.puts++;
      return fetch(input, init);
    };
    const serves: AbortController[] = [];
    onTestFinished(() => serves.forEach((controller) => controller.abort()));
    let current: Station | undefined;
    const serve = (): Report[] => {
      const controller = new AbortController();
      serves.push(controller);
      const reports: Report[] = [];
      current = createStation({ retryMs: 25, browser: same, link: httpLink(pairing, { version: "0.3.0", fetch: counted }), unit, version: "0.3.0", generation: STAMP, report: (state) => reports.push(state) });
      void current.serve(controller.signal);
      return reports;
    };
    let reports = serve();
    let driver = connect(home.url, home.drive);
    await presence(driver, unit);
    await until("the station serving the newer home", () => reports.at(-1)?.held === false);
    const errand = await driver.open(SPEC("kept", ["https://gpt.example"]), { station: unit });
    const tab = await errand.open("https://gpt.example/");
    await tab.json("/api/auth/session", { hold: { name: "token", path: "accessToken" } });
    await home.stop();

    writeFileSync(join(home.dir, "needs.json"), JSON.stringify([homeNeed("poll:claude-browser", "Sign in to claude.ai in Chrome", { site: "claude.ai", open: "https://claude.ai/" })]));
    home = await ownStations({ dir: home.dir, port: home.port, release: "rel-older", generation: STAMP - 1 });
    driver = connect(home.url, home.drive);
    await presence(driver, unit);
    const older = await refused(driver.open(SPEC("held", ["https://chat.example"]), { station: unit }));
    expect([older.code, older.message]).toEqual(["HOME_TOO_OLD", `this extension is of generation ${STAMP} and the home is ${STAMP - 1}: ${HELD}`]);
    expect(reports.at(-1)).toMatchObject({ held: true, error: null, needs: [], sites: [] });
    expect(same.tabs.size).toBe(1);
    const file = await current!.handle({ id: "held-file", errand: errand.id, op: "fetch", tab: tab.id, requests: [{ url: "/backend-api/export", as: "file", name: "held.bin" }] });
    expect(file).toMatchObject({ ok: false, error: { code: "HOME_TOO_OLD" } });
    expect(parts.puts).toBe(0);

    const unstamped = fixtureBrowser([chatSite(signedIn)]);
    const free = new AbortController();
    serves.push(free);
    void createStation({ retryMs: 25, browser: unstamped, link: httpLink(await paired(home, "chrome-0000aa0f"), { version: "0.3.0" }), unit: "chrome-0000aa0f", version: "0.3.0" }).serve(free.signal);
    await presence(driver, "chrome-0000aa0f");
    await driver.using(SPEC("unheld", ["https://chat.example"]), async (other) => void (await other.open("https://chat.example/")), { station: "chrome-0000aa0f" });
    free.abort();

    serves[0]?.abort();
    reports = serve();
    await until("the new start held", () => reports.at(-1)?.held === true);

    await home.stop();
    home = await ownStations({ dir: home.dir, port: home.port });
    driver = connect(home.url, home.drive);
    await presence(driver, unit);
    await until("the hold lifted", () => reports.at(-1)?.held === false);
    expect(reports.at(-1)?.needs.map((need) => need.id)).toEqual(["poll:claude-browser"]);
    await driver.using(SPEC("served", ["https://chat.example"]), async (served) => void (await served.open("https://chat.example/")), { station: unit });
    run["held"] = { older: older.message, popup: HELD };
  });

  it("makes a store build only from a clean commit on origin/main (47)", async () => {
    const root = mkdtempSync(join(tmpdir(), "extension-store-"));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const tree = join(root, "tree");
    mkdirSync(join(tree, "extension"), { recursive: true });
    for (const file of [".gitignore", "extension/.gitignore", "extension/build.mjs"]) copyFileSync(join(REPO, file), join(tree, file));
    symlinkSync(realpathSync(join(REPO, "extension", "node_modules")), join(tree, "extension", "node_modules"));
    const git = (...args: string[]): void => {
      const ran = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", ...args], { cwd: tree, encoding: "utf8" });
      if (ran.status !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr}`);
    };
    git("init", "--quiet", "--initial-branch=main");
    git("add", "-A");
    git("commit", "--quiet", "-m", "one");
    git("init", "--quiet", "--bare", join(root, "origin.git"));
    git("remote", "add", "origin", join(root, "origin.git"));
    git("push", "--quiet", "origin", "main");
    const store = (): Promise<{ status: number | null; said: string }> => new Promise((resolve) => {
      const child = spawn(process.execPath, [join(tree, "extension", "build.mjs"), "--store"], { cwd: join(tree, "extension"), env: { ...process.env, NODE_OPTIONS: "" }, stdio: ["ignore", "ignore", "pipe"] });
      let said = "";
      child.stderr!.on("data", (chunk: Buffer) => void (said += chunk.toString("utf8")));
      child.once("exit", (status) => resolve({ status, said }));
    });
    writeFileSync(join(tree, "extension", "draft.ts"), "");
    const dirty = await store();
    expect([dirty.status, dirty.said]).toEqual([1, expect.stringContaining("commit or remove what is uncommitted first:\n?? extension/draft.ts")]);
    rmSync(join(tree, "extension", "draft.ts"));
    git("commit", "--quiet", "--allow-empty", "-m", "two");
    const lane = await store();
    expect([lane.status, lane.said]).toEqual([1, expect.stringMatching(/a store build is made from a clean commit on origin\/main: [0-9a-f]+ is not on origin\/main/u)]);
    expect(existsSync(join(tree, "extension", "store"))).toBe(false);
  });

  it("serves one station per pairing: one started beside another stops the other, and calls run (28)", async () => {
    const door = await ownStations({ poll_ms: 600_000 });
    const same = fixtureBrowser([tokenSite()]);
    const pairing = await paired(door, "chrome-0000aa07");
    const controllers: AbortController[] = [];
    onTestFinished(() => controllers.forEach((controller) => controller.abort()));
    const serve = (): { stopped: () => boolean; link: ReturnType<typeof counting> } => {
      const controller = new AbortController();
      controllers.push(controller);
      const link = counting();
      let stopped = false;
      void createStation({ retryMs: 25, browser: same, link: httpLink(pairing, { version: "0.3.0", fetch: link.fetch }), unit: "chrome-0000aa07", version: "0.3.0" })
        .serve(controller.signal)
        .finally(() => (stopped = true));
      return { stopped: () => stopped, link };
    };
    const driver = connect(door.url, door.drive);
    const older = serve();
    await presence(driver, "chrome-0000aa07");
    const newer = serve();
    await until("the older station stopped", () => older.stopped());
    const sent = newer.link.sent;
    await driver.using(SPEC("one-station", ["https://gpt.example"]), async (errand) => {
      const tab = await errand.open("https://gpt.example/");
      for (let call = 0; call < 5; call++) expect((await tab.json("/api/auth/session")).status).toBe(200);
    });
    expect(newer.stopped()).toBe(false);
    expect(newer.link.sent - sent).toBeLessThanOrEqual(2 * 8 + 2);
    await until("the newer station's one poll in flight", () => newer.link.inflight === 1);
    const idle = newer.link.sent;
    await stations.using(SPEC("elsewhere", ["https://gpt.example"]), async (errand) => {
      const tab = await errand.open("https://gpt.example/");
      for (let call = 0; call < 5; call++) expect((await tab.json("/api/auth/session")).status).toBe(200);
    });
    expect(newer.link.sent - idle).toBe(0);
    run["one-station"] = { calls: 8, sent: idle - sent, idle: newer.link.sent - idle };
  });

  it("keeps one exchange in flight: a result cuts the waiting exchange short and goes at once, and a call in an answer the station never read is handed again (29)", async () => {
    const door = await ownStations({ poll_ms: 600_000 });
    const same = fixtureBrowser([tokenSite()]);
    const pairing = await paired(door, "chrome-0000aa08");
    const link = { inflight: 0, most: 0, sent: 0, answered: 0, lose: false };
    const counting: typeof fetch = async (input, init) => {
      if (!String(input).endsWith("/v1/stations/exchange")) return fetch(input, init);
      link.sent++;
      link.inflight++;
      link.most = Math.max(link.most, link.inflight);
      try {
        const response = await fetch(input, init);
        link.answered++;
        if (!link.lose || !response.ok) return response;
        const body = (await response.json()) as { calls: unknown[] };
        if (body.calls.length === 0) return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
        link.lose = false;
        throw new TypeError("fetch failed");
      } finally {
        link.inflight--;
      }
    };
    const controller = new AbortController();
    onTestFinished(() => controller.abort());
    void createStation({ retryMs: 25, browser: same, link: httpLink(pairing, { version: "0.3.0", fetch: counting }), unit: "chrome-0000aa08", version: "0.3.0" }).serve(controller.signal);
    const driver = connect(door.url, door.drive);
    await presence(driver, "chrome-0000aa08");
    await driver.using(SPEC("burst", ["https://gpt.example"]), async (errand) => {
      const tab = await errand.open("https://gpt.example/");
      Object.assign(link, { most: 0, sent: 0, answered: 0 });
      const began = Date.now();
      for (let call = 0; call < 10; call++) expect((await tab.json("/api/auth/session")).status).toBe(200);
      expect(link.most).toBe(1);
      expect(link.answered).toBeLessThanOrEqual(10 + 2);
      expect(link.sent).toBeLessThanOrEqual(2 * 10 + 2);
      run["exchanges"] = { calls: 10, took_ms: Date.now() - began, sent: link.sent, answered: link.answered, most_in_flight: link.most };
      link.lose = true;
      const lost = link.sent;
      expect((await tab.json("/api/auth/session")).status).toBe(200);
      expect(link.lose).toBe(false);
      expect(link.sent - lost).toBeLessThanOrEqual(3);
    });
  });

  it("shows what waits on the person, the home's needs among it, and clears each once settled (19, 24)", async () => {
    const floored = await ownStations({ floor: "0.2.0" });
    const person = fixtureBrowser([chatSite(signedIn), tokenSite()], { allowed: ["https://chat.example"] });
    const pairing = await paired(floored, "chrome-0000aa04", "0.2.0");
    let last: Report | undefined;
    let reloads = 0;
    let refusals = 0;
    const serves: AbortController[] = [];
    onTestFinished(() => serves.forEach((controller) => controller.abort()));
    let exchanges = counting();
    const serve = (version: string): void => {
      const controller = new AbortController();
      serves.push(controller);
      exchanges = counting();
      const link = httpLink(pairing, { version, fetch: exchanges.fetch });
      const report = (state: Report): void => {
        if (serves.at(-1) !== controller) return;
        last = state;
        if (state.error !== null) refusals++;
      };
      void createStation({ browser: person, link, unit: "chrome-0000aa04", version, report, reload: () => reloads++, retryMs: 25 }).serve(controller.signal);
    };
    const shown = (ids: string[]): Promise<void> => until("the needs shown", () => JSON.stringify(last?.needs.map((need) => need.id).sort()) === JSON.stringify(ids));
    const driver = connect(floored.url, floored.drive);
    serve("0.1.0");
    await shown(["update:chrome-0000aa04"]);
    expect([last?.needs[0]?.words, last?.outdated]).toEqual([expect.stringContaining("0.2.0"), true]);
    expect(await code(driver.open(SPEC("old", ["https://chat.example"])))).toBe("NO_STATION");
    await until("a second refusal", () => refusals >= 2);
    expect(last?.needs.map((need) => need.id)).toEqual(["update:chrome-0000aa04"]);
    serves[0]?.abort();
    serve("0.2.0");
    await shown([]);
    expect(last?.outdated).toBe(false);

    await driver.using(SPEC("allow", ["https://gpt.example"]), async (errand) => {
      expect(await code(errand.open("https://gpt.example/"))).toBe("SITE_NOT_ALLOWED");
      expect(last?.needs).toEqual([]);
      person.allow("https://gpt.example");
      await errand.open("https://gpt.example/");
    });

    const need = homeNeed("poll:claude-browser", "Sign in to claude.ai in Chrome", { site: "claude.ai", open: "https://claude.ai/" });
    const raised = exchanges.answered;
    writeFileSync(join(floored.dir, "needs.json"), JSON.stringify([need]));
    await shown(["poll:claude-browser"]);
    expect(exchanges.answered - raised).toBeLessThanOrEqual(2);
    expect(last?.needs.find((need) => need.id === need.id)).toEqual(need);
    writeFileSync(join(floored.dir, "needs.json"), "[]");
    await shown([]);

    expect(await refused(driver.reload("chrome-0000aa04"))).toMatchObject({ code: "BAD_CALL", message: "a store build never reloads itself" });
    expect(reloads).toBe(0);
  });

  it("reloads a development build once at each start of the stations, and a release build never (27)", async () => {
    const first = await ownStations({ poll_ms: 15 });
    const developing = await paired(first, "chrome-0000aa07");
    const releasing = await paired(first, "chrome-0000aa08");
    const reloads = { development: 0, release: 0 };
    const serves: AbortController[] = [];
    onTestFinished(() => serves.forEach((controller) => controller.abort()));
    const links: ReturnType<typeof counting>[] = [];
    const serve = (pairing: Pairing, unit: string, development: boolean, link = counting()): void => {
      const controller = new AbortController();
      serves.push(controller);
      if (!links.includes(link)) links.push(link);
      void createStation({ retryMs: 25,
        browser: fixtureBrowser([tokenSite()]), link: httpLink(pairing, { version: "0.3.0", fetch: link.fetch }), unit, version: "0.3.0", development,
        reload: () => {
          if (development) reloads.development++;
          else reloads.release++;
          serve(pairing, unit, development, link);
        },
      }).serve(controller.signal);
    };
    const later = async (): Promise<void> => {
      const at = links.map((link) => link.answered);
      await until("three more exchanges on every link", () => links.every((link, index) => link.answered >= at[index]! + 3));
    };
    serve(developing, "chrome-0000aa07", true);
    serve(releasing, "chrome-0000aa08", false);
    await until("the development station reloaded once", () => reloads.development === 1);
    await later();
    expect(reloads).toEqual({ development: 1, release: 0 });
    await first.stop();
    const second = await ownStations({ dir: first.dir, port: first.port, poll_ms: 15 });
    await until("the development station reloaded again", () => reloads.development === 2);
    await later();
    expect(reloads).toEqual({ development: 2, release: 0 });
    const driver = connect(second.url, second.drive);
    expect(await refused(driver.reload("chrome-0000aa08"))).toMatchObject({ code: "BAD_CALL", message: "a store build never reloads itself" });
    await driver.reload("chrome-0000aa07");
    await until("the development station reloaded when asked", () => reloads.development === 3);
    await later();
    expect(reloads).toEqual({ development: 3, release: 0 });
  });

  it("reloads a development build refused below the floor from disk once a streak, never again while the copy on disk is still below it, and a store build never (50)", async () => {
    const floored = await ownStations({ floor: "0.2.0" });
    const developing = await paired(floored, "chrome-0000aa0d", "0.2.0");
    const storing = await paired(floored, "chrome-0000aa0e", "0.2.0");
    const disk = { version: "0.1.0" };
    const kept = { reloaded: false };
    const reloaded = { refused: 0, asked: 0, store: 0 };
    const refusals: { development: number; store: number } = { development: 0, store: 0 };
    const served: { development: number; store: number } = { development: 0, store: 0 };
    const serves: AbortController[] = [];
    onTestFinished(() => serves.forEach((controller) => controller.abort()));
    const start = (kind: "development" | "store", version: string): void => {
      const controller = new AbortController();
      serves.push(controller);
      const development = kind === "development";
      void createStation({
        browser: fixtureBrowser([tokenSite()]), link: httpLink(development ? developing : storing, { version }), unit: development ? "chrome-0000aa0d" : "chrome-0000aa0e", version, development, retryMs: 25,
        report: (state) => {
          if (controller.signal.aborted) return;
          if (state.outdated) refusals[kind]++;
          else if (state.error === null) served[kind]++;
        },
        ...(development ? { reloaded: { read: async () => kept.reloaded, write: async (value: boolean) => void (kept.reloaded = value) } } : {}),
        reload: () => {
          if (!development) reloaded.store++;
          else if (kept.reloaded) reloaded.refused++;
          else reloaded.asked++;
          controller.abort();
          start(kind, development ? disk.version : version);
        },
      }).serve(controller.signal);
    };
    start("development", "0.1.0");
    start("store", "0.1.0");
    await until("each refused three times after the first", () => refusals.development >= 4 && refusals.store >= 3);
    expect([reloaded, kept.reloaded, served]).toEqual([{ refused: 1, asked: 0, store: 0 }, true, { development: 0, store: 0 }]);

    disk.version = "0.2.0";
    serves.forEach((controller) => controller.abort());
    start("development", disk.version);
    await until("the development build served at the floor", () => served.development > 0);
    expect([reloaded.refused, reloaded.store, kept.reloaded]).toEqual([1, 0, false]);

    disk.version = "0.3.0";
    serves.forEach((controller) => controller.abort());
    await floored.stop();
    await ownStations({ dir: floored.dir, port: floored.port, floor: "0.3.0" });
    const before = served.development;
    start("development", "0.2.0");
    await until("the development build reloaded onto the copy past the floor, and served", () => reloaded.refused === 2 && served.development > before);
    expect([reloaded.refused, reloaded.store, kept.reloaded]).toEqual([2, 0, false]);
  });

  it("tells the home which needs the person opened, once each, shows an errand's tab only on that click (25, 33)", async () => {
    const opening = await ownStations({ poll_ms: 15 });
    const person = fixtureBrowser([chatSite(signedIn)]);
    const serving = new AbortController();
    onTestFinished(() => serving.abort());
    const exchanges = counting();
    let last: Report | undefined;
    const there = createStation({ retryMs: 25,
      browser: person, link: httpLink(await paired(opening, "chrome-0000aa06"), { version: "0.3.0", fetch: exchanges.fetch }), unit: "chrome-0000aa06", version: "0.3.0",
      report: (state) => (last = state),
    });
    void there.serve(serving.signal);
    const driver = connect(opening.url, opening.drive);
    const openedFile = join(opening.dir, "opened.jsonl");
    const opened = (): string[] => (existsSync(openedFile) ? readFileSync(openedFile, "utf8").trim().split("\n").map((line) => (JSON.parse(line) as { id: string; unit: string }).id) : []);
    const later = async (count = 3): Promise<void> => {
      const at = exchanges.answered;
      await until("the exchanges answered", () => exchanges.answered >= at + count);
    };
    await presence(driver, "chrome-0000aa06");
    const errand = await driver.open(SPEC("waits", ["https://chat.example"]));
    const tab = await errand.open("https://chat.example/");
    expect(person.shown).toEqual([]);
    const waits = homeNeed("poll:chat", "Approve the sign-in on your phone", { site: "chat.example", errand: errand.id });
    writeFileSync(join(opening.dir, "needs.json"), JSON.stringify([waits]));
    await until("the need among the needs", () => last?.needs.some((need) => need.id === waits.id) === true);
    expect(await there.opened(waits)).toBe(true);
    expect(person.shown).toEqual([tab.id]);
    expect(opened()).toEqual(["poll:chat"]);
    await later();
    expect(person.shown).toEqual([tab.id]);
    expect(await there.opened(homeNeed("poll:other", "Sign in", { site: "chat.example", open: "https://chat.example/" }))).toBe(true);
    expect(person.shown).toEqual([tab.id]);
    await later();
    expect(opened()).toEqual(["poll:chat", "poll:other"]);
    writeFileSync(join(opening.dir, "needs.json"), "[]");
    await later();
    writeFileSync(join(opening.dir, "needs.json"), JSON.stringify([waits]));
    await until("the need among the needs again", () => last?.needs.some((need) => need.id === waits.id) === true);
    expect(person.shown).toEqual([tab.id]);
    expect(await there.opened(waits)).toBe(true);
    await errand.close();
    expect(await there.opened(waits)).toBe(false);
    expect(person.shown).toEqual([tab.id, tab.id]);
    writeFileSync(join(opening.dir, "needs.json"), "[]");
  });

  it("sends an act pressed in the popup once: an exchange that carried it and lost its answer never sends it again (56)", async () => {
    const door = await ownStations({ poll_ms: 15 });
    const person = fixtureBrowser([chatSite(signedIn)]);
    const serving = new AbortController();
    onTestFinished(() => serving.abort());
    const exchanges = { lose: true, answered: 0 };
    const losing: typeof fetch = async (input, init) => {
      if (!String(input).endsWith("/v1/stations/exchange")) return fetch(input, init);
      const response = await fetch(input, init);
      exchanges.answered++;
      const carried = (JSON.parse(String(init?.body)) as { station: { acted: unknown[] } }).station.acted.length > 0;
      if (!carried || !exchanges.lose) return response;
      exchanges.lose = false;
      await response.arrayBuffer();
      throw new TypeError("fetch failed");
    };
    const there = createStation({ retryMs: 25, browser: person, link: httpLink(await paired(door, "chrome-0000aa09"), { version: "0.3.0", fetch: losing }), unit: "chrome-0000aa09", version: "0.3.0" });
    void there.serve(serving.signal);
    await presence(connect(door.url, door.drive), "chrome-0000aa09");
    const actedFile = join(door.dir, "acted.jsonl");
    const acted = (): string[] => (existsSync(actedFile) ? readFileSync(actedFile, "utf8").trim().split("\n").map((line) => (JSON.parse(line) as { need: string }).need) : []);
    await there.act({ do: "try", label: "Try now", need: "poll:chat" });
    expect(exchanges.lose).toBe(false);
    expect(acted()).toEqual(["poll:chat"]);
    const at = exchanges.answered;
    await until("three exchanges answered", () => exchanges.answered >= at + 3);
    expect(acted()).toEqual(["poll:chat"]);
    run["a press sent once"] = { acted: acted() };
  });

  it("pairs a station only by its code, and serves only a paired station that names itself; a refused pass reads as not paired, and serves again once taken (23, 31)", async () => {
    const door = await ownStations();
    await expect(pair(door.url, "00000000" === door.code ? "11111111" : "00000000", "chrome-0000aa07", { version: "0.3.0" })).rejects.toThrow(/PAIR_CODE/u);
    const pairing = await paired(door, "chrome-0000aa07");
    expect(pairing.pass).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(readFileSync(join(door.dir, "relay.json"), "utf8")).not.toContain(pairing.pass);
    const exchange = (pass: string, headers: Record<string, string> = { "lifestream-device": "extension/0.3.0" }, unit = "chrome-0000aa07") =>
      fetch(`${door.url}/v1/stations/exchange`, {
        method: "POST", headers: { authorization: `Bearer ${pass}`, "content-type": "application/json", ...headers },
        body: JSON.stringify({ station: { unit, version: "0.3.0", slots: 1, errands: [], boot: "b", running: [], needs: [], chosen: [], opened: [] }, results: [] }),
      });
    expect((await exchange(pairing.pass)).status).toBe(200);
    expect((await exchange("x".repeat(43))).status).toBe(401);
    expect((await exchange(pairing.pass, {})).status).toBe(426);
    expect((await exchange(pairing.pass, undefined, "chrome-0000aa08")).status).toBe(403);
    expect((await fetch(`${door.url}/v1/stations`, { headers: { authorization: `Bearer ${pairing.pass}` } })).status).toBe(401);

    const again = await paired(door, "chrome-0000aa09");
    const refusals = { left: 1, answered: 0 };
    const refusing: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/v1/stations/exchange") && refusals.left > 0) {
        refusals.left--;
        refusals.answered++;
        return new Response(JSON.stringify({ code: "PRINCIPAL_UNKNOWN", message: "unknown pass" }), { status: 401 });
      }
      return fetch(input, init);
    };
    const reports: Report[] = [];
    const serving = new AbortController();
    onTestFinished(() => serving.abort());
    void createStation({ retryMs: 25,
      browser: fixtureBrowser([]), link: httpLink(again, { version: "0.3.0", fetch: refusing }),
      unit: "chrome-0000aa09", version: "0.3.0", report: (state) => void reports.push(state),
    }).serve(serving.signal);
    await until("a report with no error", () => reports.some((one) => one.error === null));
    expect(refusals.answered).toBe(1);
    expect(reports[0]).toMatchObject({ paired: false, error: expect.stringMatching(/refused this station's pass/u) });
    expect(reports.at(-1)).toMatchObject({ paired: true, error: null });
    const listed = connect(door.url, door.drive);
    await presence(listed, "chrome-0000aa09");
  });

  it("shows the home's sites in the popup, a site set up in the stream dialog marked and no row, and tells the home which the person chose, and which they took back (21, 53)", async () => {
    const offering = await ownStations({ poll_ms: 15 });
    const person = fixtureBrowser([chatSite(signedIn)]);
    let last: Report | undefined;
    const serving = new AbortController();
    onTestFinished(() => serving.abort());
    const link = httpLink(await paired(offering, "chrome-0000aa05"), { version: "0.3.0" });
    void createStation({ retryMs: 25, browser: person, link, unit: "chrome-0000aa05", version: "0.3.0", report: (state) => (last = state) }).serve(serving.signal);
    const driver = connect(offering.url, offering.drive);
    const sites = [
      { id: "chat", name: "Chat", origin: "https://chat.example", origins: ["https://chat.example"], signed_in: true, account: null },
      { id: "music", name: "Music", origin: "https://music.example", origins: ["https://music.example"], form: true as const, signed_in: null, account: null },
    ];
    await presence(driver, "chrome-0000aa05");
    await driver.offer(sites, "chrome-0000aa05");
    await until("the sites offered", () => isDeepStrictEqual(last?.sites, sites));
    expect((await driver.sites()).every((site) => !site.chosen)).toBe(true);
    person.choose("chat");
    await until("chat chosen", async () => (await driver.sites()).find((site) => site.id === "chat")?.chosen === true);
    expect((await driver.sites()).find((site) => site.id === "music")?.chosen).toBe(false);
    person.unchoose("chat");
    await until("chat unchosen", async () => (await driver.sites()).find((site) => site.id === "chat")?.chosen === false);
    person.choose("chat");
    await until("chat chosen again", async () => (await driver.sites()).find((site) => site.id === "chat")?.chosen === true);
    await expect(driver.offer([{ id: "x", name: "X" } as never])).rejects.toThrow();
    await expect(driver.offer([{ id: "x", name: "X", origin: "https://x.example", form: "yes", signed_in: null, account: null } as never])).rejects.toThrow("form true or none");

    const popup = new Window({ settings: { disableJavaScriptFileLoading: true, disableJavaScriptEvaluation: true, disableCSSFileLoading: true } });
    popup.document.write(readFileSync(join(REPO, "extension", "popup.html"), "utf8"));
    const stored = async (): Promise<Record<string, unknown>> => {
      const { chosen, pressed } = await person.choice();
      return { "lifestream.home-chosen": chosen ?? undefined, "lifestream.pressed": pressed, "lifestream.pairing": { url: offering.url, pass: "p".repeat(43) } };
    };
    const chrome = {
      storage: {
        session: { get: async (key: string) => ({ [key]: key === "lifestream.status" ? { ...last, home: offering.url } : undefined }), set: async () => undefined },
        onChanged: { addListener: () => undefined },
        local: {
          get: async (keys: string | string[]) => {
            const all = await stored();
            return Object.fromEntries([keys].flat().map((key) => [key, all[key]]));
          },
        },
      },
      runtime: {
        sendMessage: async (message: { choose?: string[]; stop?: string[] }) => {
          if (!Array.isArray(message.choose) || !Array.isArray(message.stop)) return undefined;
          person.choose(...message.choose);
          for (const id of message.stop) person.unchoose(id);
          return { ok: true };
        },
        openOptionsPage: () => undefined,
      },
      permissions: { getAll: async () => ({ origins: [] }), contains: async () => true, onAdded: { addListener: () => undefined }, onRemoved: { addListener: () => undefined } },
      tabs: { create: async () => undefined },
    };
    const chat = () => [...popup.document.querySelectorAll("#accounts .ck-srow")].find((row) => row.querySelector(".ck-srow__label")?.textContent === "Chat");
    const on = () => chat()?.querySelector("[role=switch]")?.getAttribute("aria-checked");
    Object.assign(globalThis, { document: popup.document, chrome });
    vi.useFakeTimers({ toFake: ["setInterval"] });
    try {
      await import("./popup.js");
      await until("chat shown on, signed in", () => on() === "true" && chat()!.textContent === "ChatSigned in");
      expect(person.kept()).toEqual(["chat"]);
      expect([...popup.document.querySelectorAll("#accounts .ck-srow__label")].map((name) => name.textContent)).toEqual(["Chat"]);
      (chat()!.querySelector("[role=switch]") as unknown as HTMLElement).click();
      await until("chat shown off", () => on() === "false" && chat()!.textContent === "ChatSigned in");
      await until("chat unchosen at the home", async () => (await driver.sites()).find((site) => site.id === "chat")?.chosen === false);
      await until("the home's list kept without chat", () => JSON.stringify(person.kept()) === "[]");
    } finally {
      vi.useRealTimers();
      Reflect.deleteProperty(globalThis, "document");
      Reflect.deleteProperty(globalThis, "chrome");
      await popup.happyDOM.close();
    }
  });

  it("gates Set up on the home's last look at a sign-in, asks Chrome for the site outside the click, or never asks the home to look again when the popup opens (34, 35)", async () => {
    const pairing = { url: "http://127.0.0.1:4680", pass: "p".repeat(43) };
    const sites = [
      { id: "chat", name: "Chat", origin: "https://chat.example", origins: ["https://chat.example"], signed_in: false, account: null },
      { id: "music", name: "Music", origin: "https://music.example", origins: ["https://music.example"], signed_in: null, account: null },
    ];
    const status: Report & { home: string } = { at: Date.now(), errands: [], needs: [], sites, error: null, paired: true, outdated: false, held: false, home: pairing.url };
    const popup = await extensionPage("popup", { local: { "lifestream.pairing": pairing }, session: { "lifestream.status": status } });
    try {
      await until("the popup's two accounts", () => popup.accounts().length === 2);
      expect(popup.accounts()).toEqual([{ says: "ChatNot signed in", on: false }, { says: "Music", on: false }]);
      expect(popup.document.querySelector("#accounts .ck-ssection__act button")?.textContent).toBe("Set up all");
      expect(popup.told).toEqual([{ to: "worker", survey: true }]);
      popup.click(popup.account("Chat").querySelector("[role=switch]")!);
      await until("the first account on", () => popup.accounts()[0]!.on);
      expect(popup.asked).toEqual([{ origins: ["https://chat.example/*"], inClick: true }]);
      expect([popup.local["lifestream.pressed"], popup.local["lifestream.home-chosen"]]).toEqual([{ choose: ["chat"], stop: [] }, undefined]);
      expect(popup.accounts()[0]).toEqual({ says: "ChatAllow Lifestream on chat.exampleAllow", on: true });
      expect(popup.told).toEqual([{ to: "worker", survey: true }, { to: "worker", choose: ["chat"], stop: [] }]);
    } finally {
      await popup.close();
    }
    const refusing = await extensionPage("popup", { local: { "lifestream.pairing": pairing }, session: { "lifestream.status": status } });
    refusing.grants.answer = new Error("Only permissions specified in the manifest may be requested.");
    try {
      await until("the popup's two accounts", () => refusing.accounts().length === 2);
      refusing.click(refusing.account("Music").querySelector("[role=switch]")!);
      const said = "Chrome didn’t allow Music. Try again.";
      await until("Chrome's refusal shown", () => refusing.account("Music").querySelector(".ck-srow__line")?.textContent === said);
      expect(refusing.local["lifestream.pressed"]).toEqual({ choose: ["music"], stop: [] });
      run["set up refused"] = said;
    } finally {
      await refusing.close();
    }
    const needing = await extensionPage("popup", { local: { "lifestream.pairing": pairing, "lifestream.home-chosen": ["chat"] }, session: { "lifestream.status": status } });
    try {
      await until("Chat's Allow", () => needing.account("Chat")?.querySelector(".ck-srow__end .ck-btn")?.textContent === "Allow");
      needing.grants.answer = true;
      needing.click(needing.account("Chat").querySelector(".ck-srow__end .ck-btn")!);
      await until("Chat's Allow gone", () => needing.account("Chat").querySelector(".ck-srow__end .ck-btn") === null);
      expect(needing.asked).toEqual([{ origins: ["https://chat.example/*"], inClick: true }]);
    } finally {
      await needing.close();
    }
    const all = await extensionPage("popup", { local: { "lifestream.pairing": pairing }, session: { "lifestream.status": status } });
    try {
      await until("the options' two accounts", () => all.accounts().length === 2);
      all.grants.answer = true;
      all.click(all.document.querySelector("#accounts .ck-ssection__act button")!);
      await until("the presses stored", () => all.local["lifestream.pressed"] !== undefined);
      expect(all.asked).toEqual([{ origins: ["https://chat.example/*", "https://music.example/*"], inClick: true }]);
      expect(all.local["lifestream.pressed"]).toEqual({ choose: ["chat", "music"], stop: [] });
      run["set up asked"] = [...popup.asked, ...all.asked];
    } finally {
      await all.close();
    }
    const holds = ["https://chat.example/*", "https://music.example/*"];
    const chosen = { "lifestream.pairing": pairing, "lifestream.home-chosen": ["chat", "music"] };
    const lines = await extensionPage("popup", { local: chosen, session: { "lifestream.status": status }, holds });
    try {
      await until("the popup's two accounts", () => lines.accounts().length === 2);
      expect(lines.accounts()).toEqual([{ says: "ChatNot signed in", on: true }, { says: "Music", on: true }]);
    } finally {
      await lines.close();
    }
    const errands = [{ id: "e1", name: "music history", origins: ["https://music.example"] }];
    const reading = await extensionPage("popup", { local: chosen, session: { "lifestream.status": { ...status, errands } }, holds });
    try {
      await until("the popup's two accounts", () => reading.accounts().length === 2);
      expect(reading.accounts()).toEqual([{ says: "ChatNot signed in", on: true }, { says: "MusicReading now", on: true }]);
      run["popup lines"] = [...reading.accounts()].map((row) => row.says);
    } finally {
      await reading.close();
    }

    const offering = await ownStations();
    const exchanges: { survey: boolean; answered: boolean }[] = [];
    const watching = (async (input, init) => {
      if (!String(input).endsWith("/v1/stations/exchange")) return fetch(input, init);
      const sent = { survey: (JSON.parse(String(init?.body)) as { station: { survey?: true } }).station.survey === true, answered: false };
      exchanges.push(sent);
      const response = await fetch(input, init);
      sent.answered = true;
      return response;
    }) as typeof fetch;
    const serving = new AbortController();
    onTestFinished(() => serving.abort());
    const station = createStation({ retryMs: 25, browser: fixtureBrowser([]), link: httpLink(await paired(offering, "chrome-0000aa0b"), { version: "0.3.0", fetch: watching }), unit: "chrome-0000aa0b", version: "0.3.0" });
    void station.serve(serving.signal);
    await presence(connect(offering.url, offering.drive), "chrome-0000aa0b");
    expect(exchanges.some((each) => each.survey)).toBe(false);
    station.survey();
    await until("the survey answered", () => exchanges.findIndex((each) => each.survey && each.answered) !== -1);
    const at = exchanges.findIndex((each) => each.survey && each.answered);
    await until("an exchange after the survey answered", () => exchanges.slice(at + 1).some((each) => each.answered));
    expect(exchanges.filter((each) => each.survey && each.answered).length).toBe(1);
    expect(exchanges.slice(at + 1).some((each) => each.survey)).toBe(false);
    run["survey asked"] = exchanges.map((each) => each.survey);
  });

  it("asks Chrome in the click for exactly what it withholds of a site's origins, its sign-in's and its probe's host among them, and nothing where it holds them all; the site's Allow and its allow page ask the same; a page on any of its origins is the site's (57)", async () => {
    const pairing = { url: "http://127.0.0.1:4680", pass: "p".repeat(43) };
    const bank: Site = { id: "bank", name: "Bank", origin: "https://bank.example", origins: ["https://bank.example", "https://login.bank.example", "https://api.bank.example"], signed_in: true, account: null };
    const chat: Site = { id: "chat", name: "Chat", origin: "https://chat.example", origins: ["https://chat.example"], signed_in: true, account: null };
    const status: Report & { home: string } = { at: Date.now(), errands: [], needs: [], sites: [bank, chat], error: null, paired: true, outdated: false, held: false, home: pairing.url };
    const session = { "lifestream.status": status };
    const local = { "lifestream.pairing": pairing };
    const page = ["https://bank.example/*", "https://chat.example/*"];
    const missing = ["https://login.bank.example/*", "https://api.bank.example/*"];
    const asked: Record<string, unknown> = {};

    const held = await extensionPage("popup", { local, session, holds: page });
    try {
      await until("the popup's two accounts", () => held.accounts().length === 2);
      held.click(held.account("Chat").querySelector("[role=switch]")!);
      await until("chat's press kept", () => held.local["lifestream.pressed"] !== undefined);
      expect([held.asked, held.local["lifestream.pressed"]]).toEqual([[], { choose: ["chat"], stop: [] }]);
      asked["set up, held"] = held.asked;
    } finally {
      await held.close();
    }
    const one = await extensionPage("popup", { local, session, holds: page });
    try {
      await until("the popup's two accounts", () => one.accounts().length === 2);
      one.grants.answer = true;
      one.click(one.account("Bank").querySelector("[role=switch]")!);
      await until("the bank's press kept", () => one.local["lifestream.pressed"] !== undefined);
      expect(one.asked).toEqual([{ origins: missing, inClick: true }]);
      expect(bank.origins.every((origin) => one.held.has(`${origin}/*`))).toBe(true);
      asked["set up, two missing"] = one.asked;
    } finally {
      await one.close();
    }
    const all = await extensionPage("popup", { local, session, holds: page });
    try {
      await until("the popup's two accounts", () => all.accounts().length === 2);
      all.click(all.document.querySelector("#accounts .ck-ssection__act button")!);
      await until("the presses kept", () => all.local["lifestream.pressed"] !== undefined);
      expect(all.asked).toEqual([{ origins: missing, inClick: true }]);
      expect(all.local["lifestream.pressed"]).toEqual({ choose: ["bank", "chat"], stop: [] });
    } finally {
      await all.close();
    }
    const holding = [...page, "https://api.bank.example/*"];
    const withdrawn = await extensionPage("popup", { local: { ...local, "lifestream.home-chosen": ["bank"] }, session, holds: holding });
    try {
      await until("the bank's Allow", () => withdrawn.account("Bank")?.querySelector(".ck-srow__end .ck-btn")?.textContent === "Allow");
      expect(withdrawn.account("Bank").querySelector(".ck-srow__line")?.textContent).toBe("Allow Lifestream on bank.example");
      expect((await needsNow([], status.sites)).map((need) => need.words)).toEqual(["Allow Lifestream on bank.example"]);
      withdrawn.grants.answer = true;
      withdrawn.click(withdrawn.account("Bank").querySelector(".ck-srow__end .ck-btn")!);
      await until("the bank's Allow gone", () => withdrawn.account("Bank").querySelector(".ck-srow__end .ck-btn") === null);
      expect(withdrawn.asked).toEqual([{ origins: ["https://login.bank.example/*"], inClick: true }]);
      asked["allow, one missing"] = withdrawn.asked;
    } finally {
      await withdrawn.close();
    }
    const allowing = await extensionPage("allow", { local: { ...local, "lifestream.home-chosen": ["bank"] }, session, holds: holding, search: "?site=bank" });
    try {
      await until("the allow page's Allow", () => allowing.document.querySelector("#root .ck-srow .ck-srow__end .ck-btn") !== null);
      allowing.grants.answer = true;
      allowing.click(allowing.document.querySelector("#root .ck-srow .ck-srow__end .ck-btn"));
      await until("the allow page closed", () => allowing.removed.length === 1);
      expect(allowing.asked).toEqual([{ origins: ["https://login.bank.example/*"], inClick: true }]);
      asked["allow page"] = allowing.asked;
    } finally {
      await allowing.close();
    }
    const whole = await extensionPage("allow", { local: { ...local, "lifestream.home-chosen": ["bank"] }, session, holds: [...holding, "https://login.bank.example/*"], search: "?site=bank" });
    try {
      await until("the allow page closed", () => whole.removed.length === 1);
      expect(whole.asked).toEqual([]);
    } finally {
      await whole.close();
    }
    expect(["https://login.bank.example/signin?next=1", "https://api.bank.example/me", "https://bank.example/", "https://elsewhere.example/", "chrome://newtab/", "not a page"]
      .map((url) => landsOn(status.sites, url))).toEqual([true, true, true, false, false, false]);
    run["withheld origins"] = asked;
  });

  it("states a choice made in the popup at once, cutting short the exchange waiting at the door (41)", async () => {
    const door = await ownStations({ poll_ms: 60_000 });
    const person = fixtureBrowser([chatSite(signedIn)]);
    const link = counting();
    let last: Report | undefined;
    const serving = new AbortController();
    onTestFinished(() => serving.abort());
    const station = createStation({ retryMs: 25,
      browser: person, link: httpLink(await paired(door, "chrome-0000aa10"), { version: "0.3.0", fetch: link.fetch }), unit: "chrome-0000aa10", version: "0.3.0", report: (state) => (last = state),
    });
    void station.serve(serving.signal);
    const driver = connect(door.url, door.drive);
    await presence(driver, "chrome-0000aa10");
    await driver.offer([{ id: "chat", name: "Chat", origin: "https://chat.example", origins: ["https://chat.example"], signed_in: true, account: null }], "chrome-0000aa10");
    await until("the site offered, the next exchange waiting at the door", () => last?.sites.length === 1 && link.inflight === 1 && link.sent === link.answered + 1);
    const sent = link.sent;
    person.choose("chat");
    station.chose();
    await until("chat chosen at the door", async () => (await driver.sites()).find((site) => site.id === "chat")?.chosen === true);
    expect((JSON.parse(link.bodies[sent]!) as { station: { pressed: unknown } }).station.pressed).toEqual({ choose: ["chat"], stop: [] });
    await until("the press's answer kept", () => JSON.stringify(person.kept()) === JSON.stringify(["chat"]));
    run["choice at once"] = { pressed: link.bodies.slice(sent).map((body) => (JSON.parse(body) as { station: { pressed: unknown } }).station.pressed) };
  });

  it("names the sites Chrome withholds on every exchange, and a grant at once, cutting short the exchange waiting at the door (63)", async () => {
    const door = await ownStations({ poll_ms: 60_000 });
    const person = fixtureBrowser([chatSite(signedIn)], { allowed: ["https://chat.example"] });
    const link = counting();
    let last: Report | undefined;
    const serving = new AbortController();
    onTestFinished(() => serving.abort());
    const station = createStation({ retryMs: 25,
      browser: person, link: httpLink(await paired(door, "chrome-0000aa11"), { version: "0.3.0", fetch: link.fetch }), unit: "chrome-0000aa11", version: "0.3.0", report: (state) => (last = state),
    });
    void station.serve(serving.signal);
    const driver = connect(door.url, door.drive);
    await presence(driver, "chrome-0000aa11");
    const allowedAt = async (id: string) => (await driver.sites()).find((site) => site.id === id)?.stations.find((each) => each.unit === "chrome-0000aa11")?.allowed;
    await driver.offer([
      { id: "chat", name: "Chat", origin: "https://chat.example", origins: ["https://chat.example"], signed_in: true, account: null },
      { id: "shop", name: "Shop", origin: "https://shop.example", origins: ["https://shop.example"], signed_in: null, account: null },
    ], "chrome-0000aa11");
    await until("each site's grant at the door", async () => (await allowedAt("chat")) === true && (await allowedAt("shop")) === false);
    await until("the next exchange waiting at the door", () => last?.sites.length === 2 && link.inflight === 1 && link.sent === link.answered + 1);
    const sent = link.sent;
    person.allow("https://shop.example");
    station.granted();
    await until("the shop allowed at the door", async () => (await allowedAt("shop")) === true);
    const said = link.bodies.map((body) => (JSON.parse(body) as { station: { withheld?: unknown } }).station.withheld ?? null);
    expect([said[0], said[sent]]).toEqual([null, []]);
    expect(said.slice(0, sent)).toContainEqual(["shop"]);
    run["grant at once"] = { withheld: said };
  });

  it("draws each site's row from the station's own look at the sign-in and the home's needs, with no word of its own about a connector (34, 45)", async () => {
    const pairing = { url: "http://127.0.0.1:4680", pass: "p".repeat(43) };
    const holds = ["https://chat.example/*"];
    const a = "person-a@example.com";
    const b = "person-b@example.com";
    const chat = (email: string | null, signed_in = true) =>
      ({ id: "chat", name: "Chat", origin: "https://chat.example", origins: ["https://chat.example"], signed_in, account: email === null ? null : { email } });
    const offer = homeNeed("poll:chat-browser", `Chrome is signed in to Chat as ${b}. Lifestream reads ${a}.`, { connector: "chat", acts: [
      { do: "read", label: "Read it too", need: "poll:chat-browser", of: `chat:${b}:browser` },
      { do: "ignore", label: "Not this one", need: "poll:chat-browser", of: `chat:${b}:browser` },
    ] });
    const cases: { site: ReturnType<typeof chat>; chosen: boolean; reading?: boolean; needs?: Need[]; says: string; buttons?: number }[] = [
      { site: chat(a), chosen: true, says: `ChatSigned in as ${a}` },
      { site: chat(a), chosen: true, reading: true, says: "ChatReading now" },
      { site: chat(null), chosen: true, says: "ChatSigned in" },
      { site: chat(null, false), chosen: true, says: "ChatNot signed in" },
      { site: chat(b), chosen: true, reading: true, needs: [offer], says: `Chat${offer.words}Read it tooNot this one`, buttons: 2 },
      { site: chat(a), chosen: false, says: `ChatSigned in as ${a}` },
      { site: chat(b), chosen: false, reading: true, says: `ChatSigned in as ${b}` },
      { site: chat(null, false), chosen: false, says: "ChatNot signed in" },
    ];
    const drawn: { says: string; on: boolean; buttons: number }[] = [];
    for (const each of cases) {
      const errands = each.reading === true ? [{ id: "e1", name: "chat history", origins: ["https://chat.example"] }] : [];
      const status: Report & { home: string } = { at: Date.now(), errands, needs: each.needs ?? [], sites: [each.site], error: null, paired: true, outdated: false, held: false, home: pairing.url };
      const popup = await extensionPage("popup", { local: { "lifestream.pairing": pairing, "lifestream.home-chosen": each.chosen ? ["chat"] : [] }, session: { "lifestream.status": status }, holds });
      try {
        await until("the popup's account", () => popup.accounts().length === 1);
        const row = popup.account("Chat");
        const shown = { ...popup.accounts()[0]!, buttons: row.querySelectorAll("button:not([role=switch])").length };
        drawn.push(shown);
        expect(shown).toEqual({ says: each.says, on: each.chosen, buttons: each.buttons ?? 0 });
      } finally {
        await popup.close();
      }
    }
    run["popup accounts"] = drawn.map((row) => row.says);
    const status: Report & { home: string } = { at: Date.now(), errands: [], needs: [offer], sites: [chat(b)], error: null, paired: true, outdated: false, held: false, home: pairing.url };
    const answering = await extensionPage("popup", { local: { "lifestream.pairing": pairing, "lifestream.home-chosen": ["chat"] }, session: { "lifestream.status": status }, holds, answer: { ok: true } });
    try {
      await until("the popup's account", () => answering.accounts().length === 1);
      await until("the offer's buttons", () => answering.account("Chat").querySelectorAll("button:not([role=switch])").length === 2);
      answering.click([...answering.account("Chat").querySelectorAll("button:not([role=switch])")].find((each) => each.textContent === "Not this one"));
      await until("the worker told the act", () => answering.told.some((message) => (message as { act?: unknown }).act !== undefined));
      expect(answering.told.find((message) => (message as { act?: unknown }).act !== undefined)).toEqual({ to: "worker", act: offer.acts[1] });
      run["popup answered"] = offer.acts[1];
    } finally {
      await answering.close();
    }
  });

  it("says where this browser stands with Lifestream in the popup's one line and the options page, shows nothing more until it is connected, and gives every need the popup shows a button (31, 32, 38, 46)", async () => {
    const pairing = { url: "http://127.0.0.1:4680", pass: "p".repeat(43) };
    const elsewhere = { url: "http://lifestream.example:4680", pass: "p".repeat(43) };
    const report = (error: string | null, needs: Need[] = [], paired = true): Report & { home: string } => ({ at: Date.now(), errands: [], needs, sites: [], error, paired, outdated: false, held: false, home: pairing.url });
    const refusal = "the home refused this station's pass (PRINCIPAL_UNKNOWN: unknown pass)";
    const said = async (world: { local?: Record<string, unknown>; session?: Record<string, unknown> }) => {
      const popup = await extensionPage("popup", world);
      let seen: { line: string; more: boolean; told: unknown[]; settings: boolean };
      try {
        await until("the popup's standing line", () => popup.text("standing") !== "");
        seen = { line: popup.stands(), more: popup.document.getElementById("connected") !== null, told: [...popup.told], settings: popup.document.getElementById("settings") !== null };
      } finally {
        await popup.close();
      }
      const options = await extensionPage("options", world);
      try {
        await until("the options' status line", () => options.text("status") !== "");
        return { ...seen, options: options.stands() };
      } finally {
        await options.close();
      }
    };
    const lines: Record<string, unknown> = {};
    const unpaired = [
      ["not asked yet", undefined, "Not connected · Open Lifestream on this Mac."],
      ["no Lifestream", "absent", "Not connected · Open Lifestream on this Mac."],
      ["asked", "waiting", "Connecting · This Mac · Allow it in Lifestream on this Mac."],
      ["no wait", { says: "Open Lifestream on your Mac to allow it." }, "Not connected · Open Lifestream on your Mac to allow it."],
      ["not now", { says: "Lifestream on this Mac said not now." }, "Not connected · Lifestream on this Mac said not now."],
      ["crowded", { says: "Other browsers are asking to connect: answer them in Lifestream on this Mac first." }, "Not connected · Other browsers are asking to connect: answer them in Lifestream on this Mac first."],
    ] as const;
    for (const [label, asked, line] of unpaired) {
      const seen = await said(asked === undefined ? {} : { session: { "lifestream.connect": asked } });
      lines[label] = seen.line;
      expect(seen).toEqual({ line, more: false, told: [{ to: "worker", survey: true }], settings: false, options: line });
    }
    const paired = [
      ["paired, no answer yet", { local: { "lifestream.pairing": pairing } }, "Connecting · This Mac"],
      ["answered", { local: { "lifestream.pairing": pairing }, session: { "lifestream.status": report(null) } }, "Connected · This Mac"],
      ["not reached", { local: { "lifestream.pairing": pairing }, session: { "lifestream.status": report("fetch failed") } }, "Can't reach Lifestream · Open Lifestream on this Mac."],
      ["another computer's, not reached", { local: { "lifestream.pairing": elsewhere }, session: { "lifestream.status": report("fetch failed") } }, "Can't reach Lifestream · Lifestream on lifestream.example doesn't answer."],
      ["pass refused", { local: { "lifestream.pairing": pairing }, session: { "lifestream.status": report(refusal, [], false) } }, "Not connected · Lifestream on this Mac doesn't know this browser now: remove the extension and add it again."],
      ["pass refused, asked", { local: { "lifestream.pairing": pairing }, session: { "lifestream.status": report(refusal, [], false), "lifestream.connect": "waiting" } }, "Connecting · This Mac · Allow it in Lifestream on this Mac."],
      ["pass refused, no wait", { local: { "lifestream.pairing": pairing }, session: { "lifestream.status": report(refusal, [], false), "lifestream.connect": { says: "Open Lifestream on your Mac to allow it." } } }, "Not connected · Open Lifestream on your Mac to allow it."],
      ["another computer's, pass refused", { local: { "lifestream.pairing": elsewhere }, session: { "lifestream.status": report(refusal, [], false) } }, "Not connected · Lifestream on lifestream.example doesn't know this browser now: pair it again in the extension's settings."],
      ["held", { local: { "lifestream.pairing": pairing }, session: { "lifestream.status": { ...report(null), held: true } } }, `Waiting for Lifestream · This Mac · ${HELD}`],
    ] as const;
    for (const [label, world, line] of paired) {
      const seen = await said(world);
      lines[label] = seen.line;
      expect(seen).toEqual({ line, more: true, told: [{ to: "worker", survey: true }], settings: false, options: line });
    }
    const silent = async (at: Pairing) => {
      Object.assign(globalThis, { chrome: { storage: {
        local: { get: async (key: string) => ({ [key]: key === "lifestream.pairing" ? at : undefined }) },
        session: { get: async (key: string) => ({ [key]: undefined }) },
      } } });
      try {
        const words = (now: Link): string => [now.word, now.where, now.then].filter((part) => part !== undefined).join(" · ");
        return [words(await link(CONNECTING_MS - 1)), words(await link(CONNECTING_MS))];
      } finally {
        Reflect.deleteProperty(globalThis, "chrome");
      }
    };
    expect(await silent(pairing)).toEqual(["Connecting · This Mac", "Can't reach Lifestream · Lifestream isn't answering. Open Lifestream on this Mac."]);
    expect((await silent(elsewhere))[1]).toBe("Can't reach Lifestream · Lifestream on lifestream.example isn't answering. Check that it is running.");
    connecting["popup lines"] = lines;

    const needs: Need[] = [
      ownNeed("allow:https://chat.example", "Allow Lifestream on chat.example", { do: "allow", label: "Allow", origin: "https://chat.example" }, "chat.example"),
      ownNeed("update:chrome-0000aa0a", "Update the Lifestream extension", { do: "chrome", label: "Open", url: "chrome://extensions/" }, null),
      homeNeed("poll:claude-browser", "Sign in to claude.ai in Chrome", { site: "claude.ai", open: "https://claude.ai/" }),
      homeNeed("poll:chatgpt-browser", "Approve the sign-in on your phone", { site: "chatgpt.com", errand: "e-0000aa0a" }),
    ];
    const gone = "Its page is not open any more (Chrome closed it): Lifestream asks again at its next run";
    const popup = await extensionPage("popup", { local: { "lifestream.pairing": pairing }, session: { "lifestream.status": report(null, needs) }, answer: { ok: false, error: gone } });
    try {
      const rows = () => [...popup.document.querySelectorAll("#needs .ck-strip")];
      await until("a row for each need", () => rows().length === needs.length);
      expect(rows().map((row) => row.querySelector(".ck-strip__acts .ck-btn")?.textContent)).toEqual(["Allow", "Open", "Open", "Open"]);
      (rows().at(-1)!.querySelector(".ck-strip__acts .ck-btn") as unknown as HTMLElement).click();
      await until("the need's detail gone", () => rows().at(-1)!.querySelector(".ck-strip__line")?.textContent === gone);
      expect(popup.closed.count).toBe(0);
      run["gone"] = gone;
    } finally {
      await popup.close();
    }
  });

  it("pairs by a code with another computer's Lifestream, asking Chrome for its address in the click, and for nothing on this Mac; offers no switch (36, 60)", async () => {
    const door = await ownStations();
    const options = await extensionPage("options", {});
    const stationsPaired = (): string[] => Object.keys((JSON.parse(readFileSync(join(door.dir, "relay.json"), "utf8")) as { stations: Record<string, string> }).stations);
    const form = options.document.getElementById("pairing")!;
    try {
      await until("the options' status line", () => options.text("status") !== "");
      expect(options.document.getElementById("agree")).toBeNull();
      options.type("url", "macbook-pro-0001.local");
      options.type("code", door.code);
      options.submit(form);
      await until("the plain http refused", () => options.text("pair-error") !== "");
      expect(options.text("pair-error")).toContain("Tailscale address, which starts with 100., or an address that starts with https://");
      expect(options.asked).toEqual([]);
      options.type("url", "lifestream.example.ts.net");
      options.submit(form);
      await until("the plain http name refused", () => options.text("pair-error").includes("Tailscale address"));
      expect(options.asked).toEqual([]);
      options.type("url", "100.64.0.1");
      options.submit(form);
      await until("the pairing error shown", () => options.text("pair-error").startsWith("Chrome"));
      expect(options.text("pair-error")).toBe("Chrome didn’t allow Lifestream to reach 100.64.0.1. Pair again, and allow it.");
      expect(options.asked).toEqual([{ origins: ["http://100.64.0.1/*"], inClick: true }]);
      expect(stationsPaired()).toEqual([]);
      options.type("url", door.url);
      options.submit(form);
      await until("the pairing stored", () => options.local["lifestream.pairing"] !== undefined);
      expect(options.asked).toHaveLength(1);
      expect((options.local["lifestream.pairing"] as Pairing).url).toBe(door.url);
      expect(stationsPaired()).toEqual([options.local["lifestream.unit"]]);
      connecting["pairing asked"] = options.asked;
      expect(options.document.querySelectorAll("[role=switch]")).toHaveLength(0);
    } finally {
      await options.close();
    }
  });

  it("holds the install's hosts to today's fixed list, each a declared site's, and no Google host, runs no content script, sets the release's sites up with no prompt, draws, asks and counts nothing of Google's whatever list a station kept, and draws no row for a site set up in the stream dialog (39, 49, 53, 57)", async () => {
    const manifest = JSON.parse(readFileSync(join(REPO, "extension", "manifest.json"), "utf8")) as { host_permissions: string[]; optional_host_permissions: string[]; content_scripts?: unknown };
    expect(manifest.host_permissions).toEqual(["https://claude.ai/*", "https://chatgpt.com/*",
      "https://app.whoop.com/*", "https://id.whoop.com/*", "https://api.prod.whoop.com/*"]);
    const declared = await declaredSites();
    const hosts = new Set(declared.flatMap((site) => site.origins.map((origin) => `${origin}/*`)));
    expect(manifest.host_permissions.filter((host) => !hosts.has(host))).toEqual([]);
    expect(manifest.optional_host_permissions).toEqual(["https://*/*", "http://*/*"]);
    expect(manifest.content_scripts).toBeUndefined();

    const pairing = { url: "http://127.0.0.1:4680", pass: "p".repeat(43) };
    const sites: Site[] = ["claude", "chatgpt", "whoop"].map((id) => ({ ...declared.find((site) => site.id === id)!, signed_in: true, account: null }));
    expect(sites.map((site) => [site.id, site.origins, site.form ?? false])).toEqual([["claude", ["https://claude.ai"], false], ["chatgpt", ["https://chatgpt.com"], false],
      ["whoop", ["https://app.whoop.com", "https://id.whoop.com", "https://api.prod.whoop.com"], true]]);
    const status: Report & { home: string } = { at: Date.now(), errands: [], needs: [], sites, error: null, paired: true, outdated: false, held: false, home: pairing.url };
    const install = { session: { "lifestream.status": status }, holds: manifest.host_permissions };
    const google = /google|takeout/iu;
    const drawn: Record<string, unknown> = {};
    for (const [label, kept] of [["the home's list", ["chatgpt", "claude", "whoop"]], ["an older home's list", ["claude", "chatgpt", "google"]]] as const) {
      const popup = await extensionPage("popup", { ...install, local: { "lifestream.pairing": pairing, "lifestream.home-chosen": kept } });
      try {
        await until("the popup's two accounts", () => popup.accounts().length === 2);
        expect(popup.accounts()).toEqual([{ says: "ClaudeSigned in", on: true }, { says: "ChatGPTSigned in", on: true }]);
        expect(popup.document.body.textContent).not.toMatch(google);
        expect(popup.document.body.textContent).not.toContain("WHOOP");
        expect([popup.document.getElementById("needs"), popup.asked, await needsNow(status.needs, sites)]).toEqual([null, [], []]);
        drawn[label] = popup.accounts().map((row) => row.says);
      } finally {
        await popup.close();
      }
    }
    const older = await extensionPage("popup", { ...install, local: { "lifestream.pairing": pairing, "lifestream.home-chosen": ["google"] } });
    try {
      await until("the popup's two accounts", () => older.accounts().length === 2);
      expect(older.accounts()).toEqual([{ says: "ClaudeSigned in", on: false }, { says: "ChatGPTSigned in", on: false }]);
      older.click(older.document.querySelector("#accounts .ck-ssection__act button")!);
      await until("the presses kept", () => older.local["lifestream.pressed"] !== undefined);
      expect(older.asked).toEqual([]);
      expect(older.local["lifestream.pressed"]).toEqual({ choose: ["claude", "chatgpt"], stop: [] });
      expect(older.document.body.textContent).not.toMatch(google);
    } finally {
      await older.close();
    }
    const withdrawn = await extensionPage("popup", { ...install, holds: manifest.host_permissions.filter((host) => host !== "https://app.whoop.com/*"),
      local: { "lifestream.pairing": pairing, "lifestream.home-chosen": ["chatgpt", "claude", "whoop"] } });
    try {
      await until("WHOOP's Allow as a banner", () => withdrawn.document.getElementById("needs")?.textContent?.includes("Allow Lifestream on app.whoop.com") === true);
      expect(withdrawn.accounts()).toEqual([{ says: "ClaudeSigned in", on: true }, { says: "ChatGPTSigned in", on: true }]);
      const allow = [...withdrawn.document.querySelectorAll("#needs button")].find((each) => each.textContent === "Allow")!;
      withdrawn.grants.answer = true;
      withdrawn.click(allow);
      await until("WHOOP's banner gone", () => withdrawn.document.getElementById("needs") === null);
      expect(withdrawn.asked).toEqual([{ origins: ["https://app.whoop.com/*"], inClick: true }]);
      connecting["install"] = { hosts: manifest.host_permissions, content_scripts: manifest.content_scripts, popup: drawn, "set up all": older.asked, withdrawn: withdrawn.asked };
    } finally {
      await withdrawn.close();
    }
  });

  it("keeps a connect by Allow whole before it lets the asking pass go, and takes no sites from it: the home's first answer is the list (40)", async () => {
    const pass = "q".repeat(43);
    const local: Record<string, unknown> = { "lifestream.asking": pass, "lifestream.unit": "chrome-0000aa0d", "lifestream.home-chosen": ["chatgpt"] };
    const writes: unknown[] = [];
    let stopped = true;
    Object.assign(globalThis, {
      chrome: {
        storage: {
          local: {
            get: async (key: string) => ({ [key]: local[key] }),
            set: async (values: Record<string, unknown>) => void (writes.push({ set: Object.keys(values) }), Object.assign(local, values)),
            remove: async (key: string) => {
              if (stopped) throw new Error("the worker stopped");
              writes.push({ remove: key });
              Reflect.deleteProperty(local, key);
            },
          },
        },
      },
    });
    const pairing = { url: "http://127.0.0.1:4680", pass };
    try {
      await expect(connected({ pairing, unit: "chrome-0000aa0d" })).rejects.toThrow("the worker stopped");
      expect(local).toEqual({ "lifestream.asking": pass, "lifestream.unit": "chrome-0000aa0d", "lifestream.home-chosen": ["chatgpt"], "lifestream.pairing": pairing });
      stopped = false;
      writes.length = 0;
      await connected({ pairing, unit: "chrome-0000aa0d" });
      expect(writes).toEqual([{ set: ["lifestream.unit", "lifestream.pairing"] }, { remove: "lifestream.asking" }]);
      expect(local).toEqual({ "lifestream.unit": "chrome-0000aa0d", "lifestream.home-chosen": ["chatgpt"], "lifestream.pairing": pairing });
      connecting["connected writes"] = writes;
    } finally {
      Reflect.deleteProperty(globalThis, "chrome");
    }
  });

  it("keeps the home's list as the one list: the home's Turn on and off, a popup's press there and back, a write Chrome refused, a worker started again with an old list (41)", async () => {
    const door = await ownStations({ poll_ms: 15 });
    const unit = "chrome-0000aa0e";
    const listFile = join(door.dir, "chosen.json");
    const exchanges: { pressed: { choose: string[]; stop: string[] }; allowing: string[]; chosen?: string[] }[] = [];
    const watching = (async (input, init) => {
      if (!String(input).endsWith("/v1/stations/exchange")) return fetch(input, init);
      const { station } = JSON.parse(String(init?.body)) as { station: { pressed: { choose: string[]; stop: string[] }; allowing: string[] } };
      const sent: (typeof exchanges)[number] = { pressed: station.pressed, allowing: station.allowing };
      exchanges.push(sent);
      const response = await fetch(input, init);
      if (response.ok) sent.chosen = ((await response.clone().json()) as { chosen: string[] }).chosen;
      return response;
    }) as typeof fetch;
    const turn = async (list: string[]) => {
      writeFileSync(listFile, JSON.stringify(list));
      expect((await fetch(`${door.url}/v1/sites`, { method: "POST", headers: { authorization: `Bearer ${door.drive}` } })).status).toBe(202);
    };
    const home = (): string[] => JSON.parse(readFileSync(listFile, "utf8")) as string[];
    const sites = [
      { id: "chat", name: "Chat", origin: "https://chat.example", origins: ["https://chat.example"], signed_in: true, account: null },
      { id: "music", name: "Music", origin: "https://music.example", origins: ["https://music.example"], signed_in: null, account: null },
    ];
    const serving = new AbortController();
    onTestFinished(() => serving.abort());
    const pairing = await paired(door, unit);
    const person = fixtureBrowser([chatSite(signedIn)], { allowed: ["https://chat.example"] });
    let last: Report | undefined;
    const station = createStation({ retryMs: 25, browser: person, link: httpLink(pairing, { version: "0.3.0", fetch: watching }), unit, version: "0.3.0", report: (state) => (last = state) });
    void station.serve(serving.signal);
    const driver = connect(door.url, door.drive);
    await presence(driver, unit);
    await driver.offer(sites, unit);
    await until("the sites offered", () => last?.sites.length === 2);
    expect(person.kept()).toEqual([]);

    await turn(["chat"]);
    await until("chat kept on", () => JSON.stringify(person.kept()) === JSON.stringify(["chat"]));
    expect(person.allowAsked).toEqual([]);
    await turn(["chat", "music"]);
    await until("music kept on", () => JSON.stringify(person.kept()) === JSON.stringify(["chat", "music"]));
    expect(person.allowAsked).toEqual(["music"]);
    await until("an exchange naming music's page", () => exchanges.some((each) => each.allowing.includes("music")));
    person.answerAllow("music");

    person.unchoose("chat");
    station.chose();
    await until("the home's list without chat, kept", () => JSON.stringify(person.kept()) === JSON.stringify(["music"]) && JSON.stringify(home()) === JSON.stringify(["music"]));
    expect(person.setUp()).toEqual(["music"]);
    const pressing = exchanges.findIndex((each) => each.pressed.stop.includes("chat"));
    expect(exchanges[pressing]!.chosen).toEqual(["music"]);
    await until("an exchange after the press's, the press let go", () => exchanges.slice(pressing + 1).some((each) => each.pressed.stop.length === 0));
    person.choose("chat");
    station.chose();
    await until("chat chosen again, kept", () => JSON.stringify(person.kept()) === JSON.stringify(["chat", "music"]) && home().includes("chat"));
    expect(person.allowAsked).toEqual(["music"]);

    person.refuseKeeps(1);
    await turn(["chat"]);
    await until("the refused write followed by the home's list kept", () => person.refusedKeeps() === 1 && JSON.stringify(person.kept()) === JSON.stringify(["chat"]));

    serving.abort();
    await turn([]);
    const again = fixtureBrowser([chatSite(signedIn)], { allowed: ["https://chat.example"] });
    await again.keep(["chat", "music"], { choose: [], stop: [] });
    const restarted = new AbortController();
    onTestFinished(() => restarted.abort());
    void createStation({ retryMs: 25, browser: again, link: httpLink(pairing, { version: "0.3.0" }), unit, version: "0.3.0" }).serve(restarted.signal);
    await until("the home's empty list kept by the station started again", () => JSON.stringify(again.kept()) === "[]");
    expect([again.setUp(), again.allowAsked]).toEqual([[], []]);
    run["one list"] = exchanges.map(({ pressed, chosen }) => ({ pressed, chosen }));
  });

  it("asks the person for a site turned on in Lifestream that Chrome withholds on the extension's allow page, once, in front in their window, closed on either answer; refused or unanswered, its need stands (41, 42)", async () => {
    const pairing = { url: "http://127.0.0.1:4680", pass: "p".repeat(43) };
    const sites: Site[] = [
      { id: "chatgpt", name: "ChatGPT", origin: "https://chatgpt.com", origins: ["https://chatgpt.com"], signed_in: true, account: null },
      { id: "music", name: "Music", origin: "https://music.example", origins: ["https://music.example"], signed_in: null, account: null },
    ];
    const [chatgpt, music] = sites as [Site, Site];
    const MUSIC = ["https://music.example/*"];
    const status: Report & { home: string } = { at: Date.now(), errands: [], needs: [], sites, error: null, paired: true, outdated: false, held: false, home: pairing.url };
    const page = "chrome-extension://testextensionid/allow.html?site=music";
    const popup = await extensionPage("popup", { local: { "lifestream.pairing": pairing, "lifestream.home-chosen": ["chatgpt"], "lifestream.window": 9 }, session: { "lifestream.status": status }, holds: ["https://chatgpt.com/*"], live: true });
    const windows = { last: 3, all: [9, 3, 4] };
    const open = new Map<number, string>();
    const loaded = new Set<number>();
    const opened: { windowId?: number; url: string; active?: boolean; focused?: boolean }[] = [];
    const focused: { id: number; focused?: boolean }[] = [];
    let ids = 50;
    const fake = globalThis.chrome;
    Object.assign(fake.runtime, {
      getURL: (path: string) => `chrome-extension://testextensionid/${path}`,
      ContextType: { TAB: "TAB" },
      getContexts: async ({ documentUrls }: { documentUrls?: string[] }) => [...open].filter(([id, url]) => loaded.has(id) && (documentUrls?.includes(url) ?? true)).map(([tabId, documentUrl]) => ({ tabId, documentUrl })),
    });
    Object.assign(fake.tabs, {
      create: async ({ windowId, url, active }: { windowId: number; url: string; active: boolean }) => {
        open.set(++ids, url);
        opened.push({ windowId, url, active });
        return { id: ids };
      },
      get: async (id: number) => (open.has(id) ? { id } : Promise.reject(new Error(`No tab with id: ${id}.`))),
    });
    Object.assign(fake, {
      windows: {
        get: async (id: number) => (windows.all.includes(id) ? { id } : Promise.reject(new Error(`No window with id: ${id}.`))),
        getLastFocused: async () => ({ id: windows.last }),
        getAll: async () => windows.all.map((id) => ({ id })),
        update: async (id: number, change: { focused?: boolean }) => void focused.push({ id, ...change }),
        create: async ({ url, focused: front }: { url: string; focused: boolean }) => {
          open.set(++ids, url);
          opened.push({ url, focused: front });
          return { id: 100 + ids, tabs: [{ id: ids }] };
        },
      },
    });
    try {
      await until("the popup's two accounts", () => popup.accounts().length === 2);
      const station = chromeBrowser();
      popup.writes.length = 0;
      await station.keep(["music"], { choose: [], stop: [] });
      await station.askAllow([music]);
      expect(popup.writes).toEqual([{ "lifestream.home-chosen": ["music"], "lifestream.pressed": { choose: [], stop: [] } }]);
      await until("the popup's switches as Lifestream set them", () => JSON.stringify(popup.accounts()) === JSON.stringify([
        { says: "ChatGPTSigned in", on: false }, { says: "MusicAllow Lifestream on music.exampleAllow", on: true },
      ]));
      expect(opened).toEqual([{ windowId: 3, url: page, active: true }]);
      expect(focused).toEqual([{ id: 3, focused: true }]);
      for (const id of open.keys()) loaded.add(id);
      expect(await station.allowing()).toEqual(["music"]);
      await station.askAllow([music]);
      const restarted = chromeBrowser();
      expect(await restarted.allowing()).toEqual(["music"]);
      await restarted.askAllow([music]);
      await station.askAllow([chatgpt]);
      expect([opened.length, focused.length]).toEqual([1, 1]);
      const [sent] = [...open.keys()];
      open.set(sent!, "https://elsewhere.example/");
      expect(await station.allowing()).toEqual([]);
      await station.askAllow([music]);
      expect([opened.length, opened.at(-1)]).toEqual([2, { windowId: 3, url: page, active: true }]);
      for (const id of open.keys()) loaded.add(id);
      open.clear();
      expect([await station.allowing(), await restarted.allowing()]).toEqual([[], []]);
      windows.all = [9, 4];
      windows.last = 9;
      await station.askAllow([music]);
      expect(opened.at(-1)).toEqual({ windowId: 4, url: page, active: true });
      expect(focused.at(-1)).toEqual({ id: 4, focused: true });
      open.clear();
      windows.all = [9];
      await station.askAllow([music]);
      expect(opened.at(-1)).toEqual({ url: page, focused: true });
      expect(focused).toHaveLength(3);
      await Promise.all([choose([], ["chatgpt"]), station.keep([], { choose: [], stop: [] })]);
      expect([popup.local["lifestream.home-chosen"], popup.local["lifestream.pressed"]]).toEqual([[], { choose: [], stop: ["chatgpt"] }]);
      await until("the popup drawn after both writes", () => JSON.stringify(popup.accounts()) === JSON.stringify([
        { says: "ChatGPTSigned in", on: false }, { says: "Music", on: false },
      ]));
      connecting["allow tabs"] = { opened, focused };
    } finally {
      await popup.close();
    }

    const world = { local: { "lifestream.pairing": pairing, "lifestream.home-chosen": ["music"] }, session: { "lifestream.status": status }, search: "?site=music" };
    type Page = Awaited<ReturnType<typeof extensionPage>>;
    const allowOf = (on: Page) => on.document.querySelector("#root .ck-srow .ck-srow__end .ck-btn");
    const refusing = await extensionPage("allow", world);
    try {
      await until("the allow page's Allow", () => allowOf(refusing) !== null);
      const row = refusing.document.querySelector("#root .ck-srow")!;
      const words = { name: row.querySelector(".ck-srow__label")?.textContent, line: row.querySelector(".ck-srow__line")?.textContent, act: allowOf(refusing)?.textContent };
      expect(words).toEqual({ name: "Music", line: "Lifestream asks to read your Music here.", act: "Allow" });
      expect(row.querySelector(".ck-srow__lead svg")).not.toBeNull();
      refusing.click(allowOf(refusing));
      await until("the refused page's tab closed", () => refusing.removed.length === 1);
      expect(refusing.asked).toEqual([{ origins: MUSIC, inClick: true }]);
      expect(refusing.removed).toEqual([41]);
      connecting["allow page"] = { ...words, asked: refusing.asked };
    } finally {
      await refusing.close();
    }
    const needing = await extensionPage("popup", { local: world.local, session: world.session });
    try {
      await until("Music's need", () => needing.accounts().some((row) => row.says === "MusicAllow Lifestream on music.exampleAllow" && row.on));
    } finally {
      await needing.close();
    }
    const allowing = await extensionPage("allow", world);
    try {
      await until("the allow page's Allow", () => allowOf(allowing) !== null);
      allowing.grants.answer = true;
      allowing.click(allowOf(allowing));
      await until("the allowed page's tab closed", () => allowing.removed.length === 1);
      expect(MUSIC.every((origin) => allowing.held.has(origin))).toBe(true);
    } finally {
      await allowing.close();
    }
    const failing = await extensionPage("allow", world);
    try {
      await until("the allow page's Allow", () => allowOf(failing) !== null);
      failing.grants.answer = new Error("Only permissions specified in the manifest may be requested.");
      failing.click(allowOf(failing));
      await until("Chrome's refusal said", () => failing.text("root").includes("Chrome didn’t allow Music. Try again."));
      expect(failing.removed).toEqual([]);
    } finally {
      await failing.close();
    }
    for (const other of [{ ...world, holds: MUSIC }, { ...world, search: "?site=nothing" }]) {
      const shut = await extensionPage("allow", other);
      try {
        await until("the page's tab closed at once", () => shut.removed.length === 1);
        expect(shut.asked).toEqual([]);
      } finally {
        await shut.close();
      }
    }
  });

  it("holds from install the sites Lifestream's Connect turns on and every host of a site set up in its stream dialog, as the connectors declare them, and no other (49, 53)", async () => {
    const script = [
      `const { chromeSites, declarations, roadsOf } = await import(${JSON.stringify(`file://${join(REPO, "packages", "connect", "index.ts")}`)});`,
      "const read = (site) => declarations().some((each) => each.chrome?.origin === site.origin && each.sources.some((source) => roadsOf(source).includes('chrome')));",
      "const sites = chromeSites(declarations());",
      "const chosen = sites.filter((site) => read(site) && !site.form).map((site) => site.id);",
      "const who = (site) => /^https:\\/\\//u.test(site.probe?.who?.url ?? '') ? [new URL(site.probe.who.url).origin] : [];",
      "const hosts = (site) => [site.origin, ...(site.signin === undefined ? [] : [site.signin]), ...who(site)];",
      "console.log(JSON.stringify({ first: sites.filter((site) => chosen.includes(site.id)).map((site) => `${site.origin}/*`),",
      "  typed: [...new Set(sites.filter((site) => site.form).flatMap(hosts))].map((origin) => `${origin}/*`) }));",
    ].join("\n");
    const ran = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: REPO, encoding: "utf8" });
    expect(ran.stderr).toBe("");
    const declared = JSON.parse(ran.stdout) as { first: string[]; typed: string[] };
    const manifest = JSON.parse(readFileSync(join(REPO, "extension", "manifest.json"), "utf8")) as { host_permissions: string[] };
    expect(manifest.host_permissions.filter((origin) => origin.startsWith("https://")).sort())
      .toEqual([...declared.first, ...declared.typed].sort());
    expect([declared.first.length > 0, declared.typed]).toEqual([true, ["https://app.whoop.com/*", "https://id.whoop.com/*", "https://api.prod.whoop.com/*"]]);
    run["install sites"] = declared;
  });

  it("answers a call it does not know as refused, never as done (37)", async () => {
    const door = await ownStations();
    const controller = new AbortController();
    const changed: string[] = [];
    const newer: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (!String(input).endsWith("/v1/stations/exchange") || !response.ok) return response;
      const answer = await response.json() as { calls: Call[] };
      for (const call of answer.calls) {
        if (call.op !== "open") continue;
        changed.push(call.id);
        Object.assign(call, { op: "evaluate" });
      }
      return new Response(JSON.stringify(answer), { status: response.status, headers: response.headers });
    };
    const pairing = await paired(door, "chrome-0000aa0c", "0.4.0");
    const served = createStation({ retryMs: 25, browser: fixtureBrowser([chatSite(signedIn)]), link: httpLink(pairing, { version: "0.4.0", fetch: newer }), unit: "chrome-0000aa0c", version: "0.4.0" }).serve(controller.signal);
    onTestFinished(() => {
      controller.abort();
      return served;
    });
    const driver = closing(connect(door.url, door.drive));
    await presence(driver, "chrome-0000aa0c");
    await driver.using(SPEC("newer", ["https://chat.example"]), async (errand) => {
      const answer = await refused(errand.open("https://chat.example/"));
      expect(answer.code).toBe("BAD_CALL");
      expect(answer.message).toContain('does not know "evaluate"');
      expect(changed).toHaveLength(1);
      run["unknown op"] = { code: answer.code, message: answer.message };
    });
  });

  it("names to the door its tabs no `open` answer named until an answer carries them, each claimed as the station states it (54)", async () => {
    const door = await ownStations({ poll_ms: 15 });
    const own = fixtureBrowser([chatSite(signedIn)]);
    const exchanges = counting();
    const controller = new AbortController();
    const served = createStation({ retryMs: 25, browser: own, link: httpLink(await paired(door, "chrome-0000aa0d"), { version: "0.4.0", fetch: exchanges.fetch }), unit: "chrome-0000aa0d", version: "0.4.0" }).serve(controller.signal);
    onTestFinished(() => {
      controller.abort();
      return served;
    });
    await presence(closing(connect(door.url, door.drive)), "chrome-0000aa0d");
    const claimsFile = join(door.dir, "claims.jsonl");
    const claims = (): Record<string, unknown>[] => (existsSync(claimsFile) ? readFileSync(claimsFile, "utf8").trim().split("\n").map((line) => { const { at: _, ...claim } = JSON.parse(line) as Record<string, unknown>; return claim; }) : []);
    const t = 1_791_000_000_000;
    own.noteUnnamed({ tab: 41, errand: "e-0000aa41", from: t, until: t + 600_000 });
    own.noteUnnamed({ tab: 42, errand: null, from: t - 120_000, until: t - 60_000 });
    await until("both tabs claimed", () => claims().length === 2);
    expect(claims()).toEqual([
      { station: "chrome-0000aa0d", tab: 41, errand: "e-0000aa41", from_ms: t - 60_000, until_ms: t + 660_000 },
      { station: "chrome-0000aa0d", tab: 42, errand: null, from_ms: t - 180_000, until_ms: t },
    ]);
    await until("the answered tabs let go", () => own.unnamed().length === 0);
    own.noteUnnamed({ tab: 43, errand: "e-0000aa41", from: t + 1_000, until: t + 600_000 });
    await until("the later tab claimed", () => claims().length === 3);
    const at = exchanges.answered;
    await until("three more exchanges answered", () => exchanges.answered >= at + 3);
    expect(claims().map((claim) => claim.tab)).toEqual([41, 42, 43]);
    expect(exchanges.bodies.slice(-2).map((body) => (JSON.parse(body) as { station: { tabs: unknown[] } }).station.tabs)).toEqual([[], []]);
    run["named tabs"] = claims();
  });

  it("takes a tab an errand's page opened, and one its popup opened, as the errand's: claimed, saved, closed with it; no other (55)", async () => {
    const door = await ownStations({ poll_ms: 15 });
    const own = fixtureBrowser([chatSite(signedIn)]);
    const controller = new AbortController();
    const station = createStation({ retryMs: 25, browser: own, link: httpLink(await paired(door, "chrome-0000aa0e"), { version: "0.4.0" }), unit: "chrome-0000aa0e", version: "0.4.0" });
    const served = station.serve(controller.signal);
    onTestFinished(() => {
      controller.abort();
      return served;
    });
    const driver = closing(connect(door.url, door.drive));
    await presence(driver, "chrome-0000aa0e");
    const claimsFile = join(door.dir, "claims.jsonl");
    const claims = (): Record<string, unknown>[] => (existsSync(claimsFile) ? readFileSync(claimsFile, "utf8").trim().split("\n").map((line) => { const { at: _, ...claim } = JSON.parse(line) as Record<string, unknown>; return claim; }) : []);
    const persons = own.opens(await own.openTab("https://chat.example/", 1_000), "https://chat.example/");
    let popups: number[] = [];
    let errand = "";
    await driver.using(SPEC("popups", ["https://chat.example"]), async (running) => {
      errand = running.id;
      const tab = (await running.open("https://chat.example/")).id;
      const named = (): Record<string, unknown>[] => claims().filter((claim) => claim.tab !== tab);
      const popup = own.opens(tab, "https://chat.example/");
      expect(await station.tabOpened(tab, popup)).toBe(true);
      const inner = own.opens(popup, "https://chat.example/");
      expect(await station.tabOpened(popup, inner)).toBe(true);
      expect(await station.tabOpened(persons, own.opens(persons, "https://chat.example/"))).toBe(false);
      popups = [popup, inner];
      expect(own.adopted).toEqual(popups);
      await until("both popups claimed", () => named().length === 2);
      await until("both popups saved", () => own.saved().find((one) => one.id === errand)?.popups.length === 2);
      const { ends_at } = own.saved().find((one) => one.id === errand)!;
      expect(own.saved().find((one) => one.id === errand)!.popups).toEqual(popups);
      for (const [index, claim] of named().entries()) {
        expect(claim).toMatchObject({ station: "chrome-0000aa0e", tab: popups[index], errand, until_ms: ends_at + 60_000 });
        expect(claim.from_ms as number).toBeLessThanOrEqual(Date.now() - 60_000);
      }
      expect(popups.every((one) => own.tabs.has(one))).toBe(true);
    });
    expect(popups.some((one) => own.tabs.has(one))).toBe(false);
    expect(own.tabs.has(persons)).toBe(true);
    expect(claims().length).toBe(3);
    run["popups"] = { errand, popups, claims: claims() };
  });

  it("runs a call the door hands twice once: a repeat while it is held is dropped, one after its result answers BAD_CALL (67)", async () => {
    const orders: Record<string, string>[] = [];
    const shop: FixtureSite = {
      origin: "https://shop.example",
      pages: { "/order": `<title>Order</title><form action="/order"><input name="item" value="item-a"><button type="submit">Place order</button></form>` },
      submit: (path, values) => {
        orders.push({ ...values });
        return path;
      },
    };
    const own = fixtureBrowser([shop]);
    const door = scripted();
    const controller = new AbortController();
    const served = createStation({ retryMs: 25, browser: own, link: door.link, unit: "chrome-0000aa10", version: "0.4.0" }).serve(controller.signal);
    onTestFinished(() => {
      controller.abort();
      return served;
    });
    door.push([
      { id: "c-begin", errand: "e-twice", op: "begin", spec: SPEC("twice", ["https://shop.example"]) },
      { id: "c-open", errand: "e-twice", op: "open", url: "https://shop.example/order" },
    ]);
    await until("the tab opened", () => door.sent.some((result) => result.id === "c-open"));
    const opened = door.sent.find((result) => result.id === "c-open");
    if (opened?.ok !== true) throw new Error(`the tab did not open: ${JSON.stringify(opened)}`);
    const tab = (opened.value as { tab: number }).tab;
    const click: Call = { id: "c-click", errand: "e-twice", op: "click", tab, target: { role: "button", name: "Place order" } };
    const held = own.hush(1);
    door.push([click]);
    await until("the click reached the page", () => held.heard() === 1);
    door.push([click]);
    await until("the station read the answer that hands it again", () => door.queued() === 0);
    held.release();
    await until("the click answered", () => door.sent.some((result) => result.id === "c-click"));
    door.push([click]);
    await until("the repeat after delivery answered", () => door.sent.filter((result) => result.id === "c-click").length === 2);
    const clicks = door.sent.filter((result) => result.id === "c-click");
    expect(clicks[0]).toMatchObject({ ok: true });
    expect(clicks[1]).toMatchObject({ ok: false, error: { code: "BAD_CALL", message: expect.stringContaining("ran already in this start") } });
    expect(orders).toEqual([{ item: "item-a" }]);
    run["repeat"] = { clicks, orders: orders.length };
  });

  it("ends every page call within its bound, a fetch call within its clock in waves, and takes no answer past either or past the errand's end (68)", async () => {
    const door = await ownStations({ poll_ms: 15 });
    const driver = closing(connect(door.url, door.drive));
    const gate: (() => void)[] = [];
    const slow: FixtureSite = {
      origin: "https://slow.example",
      pages: { "/": `<title>Slow</title><button>Save</button>` },
      api: async (request) => {
        if (request.path === "/api/hang") return await new Promise<undefined>(() => undefined);
        await new Promise<void>((go) => gate.push(go));
        return { status: 200, body: JSON.stringify({ path: request.path }) };
      },
    };
    const serving = new AbortController();
    const served: Promise<void>[] = [];
    onTestFinished(async () => {
      serving.abort();
      await Promise.all(served);
    });
    const clock = { skew: 0 };
    const timed = fixtureBrowser([slow]);
    served.push(createStation({ retryMs: 25, browser: timed, link: httpLink(await paired(door, "chrome-0000aa11"), { version: "0.4.0" }), unit: "chrome-0000aa11", version: "0.4.0", now: () => Date.now() + clock.skew }).serve(serving.signal));
    const quick = fixtureBrowser([slow]);
    served.push(createStation({ retryMs: 25, browser: quick, link: httpLink(await paired(door, "chrome-0000aa12"), { version: "0.4.0" }), unit: "chrome-0000aa12", version: "0.4.0", bounds: { fetch: 100, look: 100, act: 100, spare: 5_000, reach: 150 } }).serve(serving.signal));
    await presence(driver, "chrome-0000aa11");
    await presence(driver, "chrome-0000aa12");

    const deadline = { deadline_ms: 3_600_000 };
    await driver.using(SPEC("waves", ["https://slow.example"], deadline), async (errand) => {
      const tab = await errand.open("https://slow.example/");
      const batch = tab.fetch(Array.from({ length: 12 }, (_, index) => ({ url: `/api/heart/${index}`, as: "json" as const })));
      for (let wave = 1; wave <= 3; wave++) {
        await until(`wave ${wave}'s four requests at the site`, () => gate.length === 4);
        clock.skew += 55_000;
        for (const go of gate.splice(0)) go();
      }
      const answers = await batch;
      expect(answers.map((answer) => answer.status)).toEqual(Array.from({ length: 12 }, () => 200));
      expect(clock.skew).toBeGreaterThan(FETCH_MS + 90_000);
      run["waves"] = { requests: answers.length, station_ms: clock.skew };
    }, { station: "chrome-0000aa11" });

    await driver.using(SPEC("silent", ["https://slow.example"]), async (errand) => {
      const tab = await errand.open("https://slow.example/");
      const hung = quick.hush(8);
      const slots = await tab.fetch(Array.from({ length: 8 }, (_, index) => ({ url: `/api/heart/${index}`, as: "json" as const })));
      expect(slots.map((slot) => [slot.error?.code, slot.error?.message])).toEqual(Array.from({ length: 8 }, () => ["PAGE_ERROR", "the page did not answer within 0.1 s"]));
      expect(hung.heard()).toBe(8);
      hung.release();
      const clicked = quick.hush(1);
      const act = await refused(tab.click({ role: "button", name: "Save" }));
      expect([act.code, act.message]).toEqual(["INTERRUPTED", "the page did not answer: whether the act ran is not known"]);
      clicked.release();
      const looked = quick.hush(1);
      expect(await code(tab.snapshot())).toBe("PAGE_ERROR");
      looked.release();
      quick.reach("https://slow.example", false);
      expect(await code(tab.json("/api/hang"))).toBe("OFFLINE");
      quick.reach("https://slow.example", true);
      expect((await tab.snapshot()).lines).toContain('button "Save"');
    }, { station: "chrome-0000aa12" });

    await driver.using(SPEC("slept", ["https://slow.example"]), async (errand) => {
      const tab = await errand.open("https://slow.example/");
      const pending = timed.hush(1);
      const look = tab.snapshot();
      await until("the snapshot reached the page", () => pending.heard() === 1);
      clock.skew += 3_600_000;
      pending.release();
      expect(await code(look)).toBe("NO_ERRAND");
    }, { station: "chrome-0000aa11" });
  });

  it("runs nothing it was handed with a reload, and takes a store update only with nothing in hand, a press not yet sent among it, before an exchange (69)", async () => {
    const reloading = fixtureBrowser([tokenSite()]);
    const scripting = scripted();
    let reloads = 0;
    let stopped = false;
    const stopping = new AbortController();
    onTestFinished(() => stopping.abort());
    void createStation({ retryMs: 25, browser: reloading, link: scripting.link, unit: "chrome-0000aa13", version: "0.4.0", development: true, reload: () => void reloads++ })
      .serve(stopping.signal).then(() => void (stopped = true));
    scripting.push([{ id: "c-begin", errand: "e-reload", op: "begin", spec: SPEC("reload", ["https://gpt.example"]) }], { reload: true });
    await until("the start stopped", () => stopped);
    expect([reloads, scripting.sent, reloading.saved()]).toEqual([1, [], []]);

    const door = await ownStations({ poll_ms: 15 });
    const driver = closing(connect(door.url, door.drive));
    const exchanges = counting();
    const waiting = { update: false };
    const updated: number[] = [];
    const controller = new AbortController();
    const served = createStation({ retryMs: 25,
      browser: fixtureBrowser([tokenSite()]), link: httpLink(await paired(door, "chrome-0000aa14"), { version: "0.4.0", fetch: exchanges.fetch }), unit: "chrome-0000aa14", version: "0.4.0",
      updating: () => waiting.update, update: () => void updated.push(exchanges.sent),
    }).serve(controller.signal);
    onTestFinished(() => {
      controller.abort();
      return served;
    });
    await presence(driver, "chrome-0000aa14");
    await driver.using(SPEC("updating", ["https://gpt.example"]), async (errand) => {
      await errand.open("https://gpt.example/");
      waiting.update = true;
      const at = exchanges.answered;
      await until("three more exchanges while the errand runs", () => exchanges.answered >= at + 3);
      expect(updated).toEqual([]);
    }, { station: "chrome-0000aa14" });
    await until("the station updated", () => updated.length === 1);
    await served;
    expect([updated, exchanges.sent, exchanges.inflight]).toEqual([[exchanges.sent], exchanges.sent, 0]);
    const last = JSON.parse(exchanges.bodies.at(-1)!) as { station: StationInfo; results: Result[] };
    expect(last.results.map((result) => result.ok)).toEqual([true]);

    const pressed = async (unit: string, press: (station: Station) => Promise<unknown>): Promise<{ stated: unknown[]; made: Promise<unknown> }> => {
      const told: StationInfo[] = [];
      const pressedLink: DoorLink = {
        async exchange(stated, _results, signal) {
          told.push(stated);
          if (told.length > 1) return { home: { version: "checkout", generation: null }, calls: [], needs: [], sites: [], chosen: [] };
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          throw new DOMException("cut short", "AbortError");
        },
        put: async () => {
          throw new Error("this door takes no file");
        },
      };
      const pressing = { update: false };
      let pressedUpdate = 0;
      const pressStop = new AbortController();
      onTestFinished(() => pressStop.abort());
      const pressingStation = createStation({ retryMs: 25,
        browser: fixtureBrowser([tokenSite()]), link: pressedLink, unit, version: "0.4.0",
        updating: () => pressing.update, update: () => void pressedUpdate++,
      });
      const pressServed = pressingStation.serve(pressStop.signal);
      await until("the first exchange waits at the door", () => told.length === 1);
      pressing.update = true;
      const made = press(pressingStation);
      await until("the station updated", () => pressedUpdate === 1);
      await pressServed;
      return { stated: told.map((stated) => [stated.opened, stated.acted]), made };
    };
    const need = homeNeed("poll:chat", "Sign in to chat in Chrome", { site: "chat", open: "https://chat.example/" });
    const opening = await pressed("chrome-0000aa15", (station) => station.opened(need));
    expect(opening.stated).toEqual([[[], []], [["poll:chat"], []]]);
    await opening.made;
    const press = { do: "try", label: "Try now", need: "poll:chat" } as const;
    const acting = await pressed("chrome-0000aa16", (station) => station.act(press));
    expect(acting.stated).toEqual([[[], []], [[], [press]]]);
    await acting.made;
  });

  it("answers an act Chrome ran in the next document as not known, a look there as the page changed, and the page's refusal of its origin as it is (73)", async () => {
    let where: string[] = [];
    let answered: unknown = { ok: true, value: {} };
    Object.assign(globalThis, {
      chrome: {
        scripting: {
          executeScript: async (injection: { func?: unknown; args?: unknown[] }) => {
            const documentId = where.shift() ?? "document-1";
            return [{ documentId, result: injection.args === undefined ? true : answered }];
          },
        },
        webNavigation: { getFrame: async () => ({ documentId: "document-2", url: `${APP}/next` }) },
        tabs: { get: async () => ({ id: 7 }) },
      },
    });
    onTestFinished(() => void Reflect.deleteProperty(globalThis, "chrome"));
    const page = chromeBrowser().page;
    const call = (op: object) => ({ ...op, origins: [APP], withhold: { values: [], cookies: [] } }) as unknown as Parameters<typeof page>[2];
    const interrupted = { ok: false, error: { code: "INTERRUPTED", message: "the page changed under the act: whether it ran is not known" } };
    const changed = { ok: false, error: { code: "PAGE_ERROR", message: "the page changed under the call" } };
    for (const op of [{ op: "click", target: { ref: "x" } }, { op: "fill", target: { ref: "x" }, value: "typed" }, { op: "select", target: { ref: "x" }, option: "One" }]) {
      where = ["document-1", "document-2"];
      expect(await page(7, "document-1", call(op))).toEqual(interrupted);
    }
    where = ["document-1", "document-2"];
    answered = { ok: true, value: { url: `${APP}/next`, title: "Next", lines: "", signals: {} } };
    expect(await page(7, "document-1", call({ op: "snapshot" }))).toEqual(changed);
    where = ["document-1", "document-2"];
    answered = { ok: false, error: { code: "ORIGIN_REFUSED", message: "the page is on https://other.example" } };
    expect(await page(7, "document-1", call({ op: "click", target: { ref: "x" } }))).toEqual(answered);
    where = ["document-2"];
    answered = { ok: true, value: {} };
    expect(await page(7, "document-1", call({ op: "click", target: { ref: "x" } }))).toEqual(changed);
  });
});

describe("what reaches the pass", () => {
  it("60: plain http goes only to this Mac and the tailnet's addresses, https anywhere, never to a user", () => {
    expect(doorUrl("127.0.0.1")).toBe("http://127.0.0.1:4680");
    expect(doorUrl("localhost")).toBe("http://localhost:4680");
    expect(doorUrl("http://[::1]:4680/")).toBe("http://[::1]:4680");
    expect(doorUrl("100.64.0.1")).toBe("http://100.64.0.1:4680");
    expect(doorUrl("  HTTP://100.127.255.254:8080/ ")).toBe("http://100.127.255.254:8080");
    expect(doorUrl("100.64.0.1.")).toBe("http://100.64.0.1:4680");
    expect(doorUrl("https://lifestream.example.ts.net")).toBe("https://lifestream.example.ts.net");
    expect(doorUrl("https://macbook-pro-0001.local")).toBe("https://macbook-pro-0001.local");
    expect(doorUrl("https://192.168.1.20:4680")).toBe("https://192.168.1.20:4680");
    for (const typed of ["macbook-pro-0001.local", "http://macbook-pro-0001.local:4680", "192.168.1.20", "10.0.0.5", "172.16.0.9",
      "100.63.255.255", "100.128.0.1", "home.example.com", "127.0.0.2",
      "lifestream.example.ts.net", "http://lifestream.example.ts.net:443", "  HTTP://Lifestream.Example.TS.NET:8080/ ", "lifestream.example.ts.net.",
      "lifestream.ex\u0430mple.ts.net", "ts.net", "evil-ts.net", "lifestream.example.ts.net.attacker.example"]) {
      expect(() => doorUrl(typed), typed).toThrow(PlainHttp);
    }
    expect(() => doorUrl("macbook-pro-0001.local")).toThrow(/Tailscale address.*https:\/\//u);
    for (const typed of ["http://person@100.64.0.1", "https://100.64.0.1@elsewhere.example", "https://person:secret@lifestream.example.ts.net"]) {
      expect(() => doorUrl(typed), typed).toThrow(Error);
      expect(() => doorUrl(typed), typed).not.toThrow(PlainHttp);
    }
    expect(() => doorUrl("ftp://lifestream.example.ts.net")).toThrow(Error);
    expect(() => doorUrl("ftp://lifestream.example.ts.net")).not.toThrow(PlainHttp);
  });

  it("60: a pairing saved to an address the pass may not go to sends nothing, and reads as not paired", async () => {
    const sent: string[] = [];
    const recording: typeof fetch = async (input) => {
      sent.push(String(input));
      return new Response("{}", { status: 500 });
    };
    const pass = "p".repeat(43);
    for (const url of ["http://lifestream.example.ts.net:4680", "http://macbook-pro-0001.local:4680", "http://192.168.1.20:4680", "https://person@100.64.0.1"]) {
      const saved = httpLink({ url, pass }, { version: "0.3.0", fetch: recording });
      const station = { unit: "chrome-0000aa10", version: "0.3.0", slots: 1, errands: [], boot: "b", running: [], needs: [], chosen: [], opened: [] } as unknown as StationInfo;
      await expect(saved.exchange(station, [], new AbortController().signal), url).rejects.toThrow(PassRefused);
      await expect(saved.put("errand-1", "file.txt", (async function* () { yield new Uint8Array([1]); })()), url).rejects.toThrow(/pair it again/u);
      await expect(pair(url, "12345678", "chrome-0000aa10", { version: "0.3.0", fetch: recording }), url).rejects.toThrow(PlainHttp);
    }
    const reports: Report[] = [];
    const serving = new AbortController();
    onTestFinished(() => serving.abort());
    void createStation({ retryMs: 25,
      browser: fixtureBrowser([]), link: httpLink({ url: "http://lifestream.example.ts.net:4680", pass }, { version: "0.3.0", fetch: recording }),
      unit: "chrome-0000aa10", version: "0.3.0", report: (state) => void reports.push(state),
    }).serve(serving.signal);
    await until("the station's first report", () => reports.length > 0);
    expect(reports[0]).toMatchObject({ paired: false, error: expect.stringMatching(/pair it again/u) });
    expect(sent).toEqual([]);
  });

  it("60: no request that carries the code or the pass follows a redirect, which would take its body to an address never checked", async () => {
    const redirects: (RequestRedirect | undefined)[] = [];
    const recording: typeof fetch = async (_input, init) => {
      redirects.push(init?.redirect);
      return new Response("{}", { status: 500 });
    };
    const pass = "p".repeat(43);
    const url = "https://lifestream.example.ts.net";
    const link = httpLink({ url, pass }, { version: "0.3.0", fetch: recording });
    const station = { unit: "chrome-0000aa11", version: "0.3.0", slots: 1, errands: [], boot: "b", running: [], needs: [], chosen: [], opened: [] } as unknown as StationInfo;
    await link.exchange(station, [], new AbortController().signal).catch(() => undefined);
    await link.put("errand-1", "file.txt", (async function* () { yield new Uint8Array([1]); })()).catch(() => undefined);
    await pair(url, "12345678", "chrome-0000aa11", { version: "0.3.0", fetch: recording }).catch(() => undefined);
    await ask(url, pass, "chrome-0000aa11", { version: "0.3.0", fetch: recording }).catch(() => undefined);
    expect(redirects.length).toBeGreaterThanOrEqual(4);
    expect(redirects.every((redirect) => redirect === "error")).toBe(true);
  });

  const ID = "testextensionid";
  const own = (page: string): chrome.runtime.MessageSender => ({ id: ID, url: `chrome-extension://${ID}/${page}` });
  const tab = { id: 7, windowId: 3 } as chrome.tabs.Tab;
  const foreign: [string, chrome.runtime.MessageSender][] = [
    ["a content script", { id: ID, url: "https://chat.example/c/1", origin: "https://chat.example", tab, frameId: 0 }],
    ["a content script claiming the popup's path", { id: ID, url: "https://chat.example/popup.html", tab, frameId: 0 }],
    ["another extension's popup", { id: "otherextensionid", url: "chrome-extension://otherextensionid/popup.html" }],
    ["a sender with no URL", { id: ID }],
  ];

  function stubChrome(answers: Record<string, (...args: unknown[]) => unknown> = {}) {
    const calls: { path: string; args: unknown[] }[] = [];
    const listeners = new Map<string, ((...args: unknown[]) => unknown)[]>();
    const fixed: Record<string, unknown> = { "runtime.id": ID, "runtime.getURL": (page: string) => `chrome-extension://${ID}/${page.replace(/^\//u, "")}` };
    const node = (path: string): unknown => new Proxy(() => undefined, {
      get: (_target, key) => {
        if (typeof key === "symbol" || key === "then") return undefined;
        const at = path === "" ? key : `${path}.${key}`;
        if (at in fixed) return fixed[at];
        if (key === "addListener") return (listener: (...args: unknown[]) => unknown) => void listeners.set(path, [...(listeners.get(path) ?? []), listener]);
        return node(at);
      },
      apply: (_target, _this, args: unknown[]) => {
        calls.push({ path, args });
        return path in answers ? answers[path]!(...args) : new Promise(() => undefined);
      },
    });
    const send = (message: unknown, sender: chrome.runtime.MessageSender): { kept: boolean; answered: unknown[] } => {
      const answered: unknown[] = [];
      let kept = false;
      for (const listener of listeners.get("runtime.onMessage") ?? []) if (listener(message, sender, (answer: unknown) => void answered.push(answer)) === true) kept = true;
      return { kept, answered };
    };
    const fire = (path: string, ...args: unknown[]): void => {
      for (const listener of listeners.get(path) ?? []) listener(...args);
    };
    return { chrome: node(""), calls, send, fire };
  }

  const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  async function worker(answers: Record<string, (...args: unknown[]) => unknown> = { "storage.local.setAccessLevel": async () => undefined }) {
    const stub = stubChrome(answers);
    Object.assign(globalThis, {
      chrome: stub.chrome, LIFESTREAM_DEVELOPMENT: false, LIFESTREAM_GENERATION: null, LIFESTREAM_DOOR: "http://127.0.0.1:4680",
      LIFESTREAM_BADGE: { background: "#000000", text: "#ffffff" },
    });
    vi.resetModules();
    await import("./worker.js");
    await settled();
    return stub;
  }

  function everyEvent(stub: ReturnType<typeof stubChrome>): void {
    stub.fire("runtime.onStartup");
    stub.fire("runtime.onInstalled", { reason: "install" });
    stub.fire("runtime.onUpdateAvailable", { version: "9.9.9" });
    stub.fire("alarms.onAlarm", { name: "lifestream" });
    stub.fire("storage.onChanged", { "lifestream.chosen": { newValue: ["chat"] } }, "local");
    stub.fire("permissions.onAdded", { origins: ["https://chat.example/*"] });
    stub.fire("permissions.onRemoved", { origins: ["https://chat.example/*"] });
    stub.fire("tabs.onUpdated", 7, { status: "complete" }, { ...tab, url: "https://chat.example/" });
    stub.fire("webNavigation.onBeforeNavigate", { tabId: 7, frameId: 0 });
    stub.fire("webNavigation.onCreatedNavigationTarget", { sourceTabId: 7, tabId: 8 });
    stub.fire("windows.onFocusChanged", 3);
    stub.send({ to: "worker", blank: true }, { ...own("blank.html"), tab });
    stub.send({ to: "worker", survey: true }, own("popup.html"));
    stub.send({ to: "worker", choose: ["chat"], stop: [] }, own("popup.html"));
    stub.send({ to: "worker", opened: need }, own("popup.html"));
    stub.send({ to: "worker", act: { do: "try", label: "Try now", need: "need-1" } }, own("popup.html"));
  }
  const local = (stub: ReturnType<typeof stubChrome>) => stub.calls.filter((call) => call.path.startsWith("storage.local.") && call.path !== "storage.local.setAccessLevel");

  it("61: local storage is closed to content scripts as the worker starts, and nothing it does touches local storage before", async () => {
    let open: () => void = () => undefined;
    const stub = await worker({ "storage.local.setAccessLevel": () => new Promise<void>((resolve) => (open = resolve)) });
    expect(stub.calls[0]).toEqual({ path: "storage.local.setAccessLevel", args: [{ accessLevel: "TRUSTED_CONTEXTS" }] });
    everyEvent(stub);
    await settled();
    expect(local(stub)).toEqual([]);
    open();
    await settled();
    expect(local(stub).some((call) => call.path === "storage.local.get" && call.args[0] === "lifestream.pairing")).toBe(true);
  });

  it("61: Chrome refusing to close local storage, the worker never touches it, and never serves", async () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => said.mockRestore());
    const stub = await worker({ "storage.local.setAccessLevel": async () => { throw new Error("not supported"); } });
    everyEvent(stub);
    await settled();
    everyEvent(stub);
    await settled();
    expect(local(stub)).toEqual([]);
    expect(said).toHaveBeenCalledOnce();
  });

  const need = homeNeed("need-1", "Sign in", { site: "chat.example", errand: "errand-1" });
  const messages: [string, unknown, string, unknown][] = [
    ["the blank page's load", { to: "worker", blank: true }, "blank.html", { to: "worker", blank: "yes" }],
    ["a need opened", { to: "worker", opened: need }, "popup.html", { to: "worker", opened: { ...need, at: { errand: 4 } } }],
    ["an act pressed", { to: "worker", act: { do: "try", label: "Try now", need: "need-1" } }, "popup.html", { to: "worker", act: { do: "open", label: "Open", url: "https://chat.example/", need: "need-1" } }],
    ["Set up and Stop", { to: "worker", choose: ["chat"], stop: [] }, "popup.html", { to: "worker", choose: [{ id: "chat" }], stop: [] }],
    ["the popup opened", { to: "worker", survey: true }, "popup.html", { to: "worker", survey: 1 }],
  ];

  it.each(messages)("62: the worker takes %s only from its own page, in its shape", async (_name, message, page, misshapen) => {
    for (const [who, sender] of [...foreign, ["another of its own pages", own("options.html")] as [string, chrome.runtime.MessageSender]]) {
      const stub = await worker();
      const before = stub.calls.length;
      const { kept, answered } = stub.send(message, sender);
      await settled();
      expect({ who, kept, answered, calls: stub.calls.slice(before) }).toEqual({ who, kept: false, answered: [], calls: [] });
    }
    const wrong = await worker();
    const before = wrong.calls.length;
    expect(wrong.send(misshapen, own(page)).kept).toBe(false);
    await settled();
    expect(wrong.calls.slice(before)).toEqual([]);
    const taken = await worker();
    const from = taken.calls.length;
    taken.send(message, { ...own(page), ...(page === "blank.html" ? { tab } : {}) });
    await settled();
    expect(taken.calls.slice(from).length).toBeGreaterThan(0);
  });
});
