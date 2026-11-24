import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, inject, it, onTestFinished } from "vitest";
import { startHome } from "./home.js";
import { KNOCK_MS, KNOCKS } from "./knocks.js";
import { ASKED_MS, SHOWN_MS, type Connecting } from "./pairing.js";
import { readPrincipals, revokePrincipal } from "./principals.js";
import { ask, askHome } from "./socket.js";
import { when } from "./stream-words.js";
import { readOpsSettings } from "./verbs/context.js";
import { FAKES, makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { statusOf } from "./test/harness-status.js";
import { doorHere } from "./test/harness-door.js";
import { REPO } from "./test/support.js";
import { testSocket } from "./test/folder.js";
import { openHomeFolder } from "@lifestreamprotocol/core";

const ARTIFACT = join(REPO, "packages", "home", ".build", "e2e", "connect.json");
const report: Record<string, unknown> = {};

afterAll(() => {
  mkdirSync(join(ARTIFACT, ".."), { recursive: true });
  writeFileSync(ARTIFACT, `${JSON.stringify(report, null, 2)}\n`);
});

function chromeForTesting(): string {
  const binary = inject("chromeForTesting");
  if (binary === null) throw new Error("no Chrome to run the extension in: npx playwright install chromium");
  return binary;
}

class Devtools {
  readonly #waiting = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();
  #next = 0;
  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (message.id !== undefined) this.#waiting.get(message.id)?.(message);
    });
  }
  async send<T>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = ++this.#next;
    const answer = await new Promise<{ result?: unknown; error?: { message: string } }>((resolve) => {
      this.#waiting.set(id, resolve);
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    });
    this.#waiting.delete(id);
    if (answer.error !== undefined) throw new Error(`${method}: ${answer.error.message}`);
    return answer.result as T;
  }
  async run<T>(session: string, expression: string): Promise<T> {
    const answer = await this.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
      "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session);
    if (answer.exceptionDetails !== undefined) throw new Error(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text);
    return answer.result.value;
  }
  async attach(targetId: string): Promise<string> {
    return (await this.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true })).sessionId;
  }
  async targets(): Promise<{ targetId: string; type: string; url: string }[]> {
    return (await this.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets")).targetInfos;
  }
}

const HAND_LOADED = "chrome-extension://bioodomopbikaidodldikkkinnpfddin";
const STORE = "chrome-extension://bdiidhddmofblpjlbgkckhjfcbgfnfem";

function fromProgram(door: string, body: object, origin = HAND_LOADED): Promise<{ status: number; code: unknown }> {
  return new Promise((resolve, reject) => {
    const sent = httpRequest(`${door}/v1/pair`, { method: "POST", agent: false, headers: { origin, "content-type": "application/json", "lifestream-device": "extension/0.8.0" } }, (response) => {
      let text = "";
      response.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, code: (JSON.parse(text) as { code?: unknown }).code }));
    });
    sent.on("error", reject);
    sent.end(JSON.stringify(body));
  });
}

describe("a browser on this Mac connecting by an Allow", () => {
  it("asks, is refused or answered on the Mac, pairs once allowed, and reaches the door by CORS alone; nothing else connects", async () => {
    const root = makeRoot("lifestream-connect-", { sources: {} });
    const dir = mkdtempSync(join(tmpdir(), "lifestream-connect-chrome-"));
    let at = Date.now();
    const door = await doorHere(root);
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, slot: null, log: () => undefined, tickMs: TICK_MS, clock: () => at });
    let chrome: ChildProcess | undefined;
    let site: Server | undefined;
    let chromeClosed = false;
    onTestFinished(async () => {
      try {
        try {
          if (chrome?.pid !== undefined && chrome.exitCode === null && chrome.signalCode === null) process.kill(-chrome.pid, "SIGKILL");
        } catch {
        }
        if (chrome !== undefined) await until("every process of Chrome gone", () => chromeClosed);
      } finally {
        site?.close();
        await door.stop();
        await home.stop();
      }
      removeRoot(root);
      rmSync(dir, { recursive: true, force: true });
    });
    const sock = testSocket(root);
    let pageReady = false;
    let paired: { url: string; pass: string } | null = null;
    let chosen: string[] | null = null;
    const mac = async (...args: string[]) => (await ask(sock, { verb: "connect", args, by: "you" })) as Connecting;
    const listed = async (what: string, ready: (now: Connecting) => boolean): Promise<Connecting> => {
      let seen: Connecting | null = null;
      let reading = false;
      await until(what, () => {
        if (!reading) {
          reading = true;
          void mac().then((now) => {
            seen = now;
            reading = false;
          });
        }
        return seen !== null && ready(seen);
      });
      return seen!;
    };

    const built = join(dir, "extension");
    const building = spawn(process.execPath, [join(REPO, "extension", "build.mjs"), built], { env: { ...process.env, LIFESTREAM_DOOR: door.url }, stdio: "ignore" });
    expect(await new Promise((resolve) => building.once("exit", resolve))).toBe(0);
    const other = join(dir, "other");
    mkdirSync(other);
    writeFileSync(join(other, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Other", version: "1.0.0", background: { service_worker: "other.js" } }));
    writeFileSync(join(other, "other.js"), "self.x = 1;\n");
    site = createServer((_request, response) => void response.end("<!doctype html><title>A site</title>"));
    await new Promise<void>((resolve) => site!.listen(0, "127.0.0.1", () => resolve()));
    const page = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;

    chrome = spawn(chromeForTesting(), [
      "--headless=new", `--user-data-dir=${join(dir, "profile")}`, `--load-extension=${built},${other}`, `--disable-extensions-except=${built},${other}`,
      "--remote-debugging-port=0", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update",
      "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1", "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"], detached: true });
    chrome.once("close", () => { chromeClosed = true; });
    let printed = "";
    const address = await new Promise<string>((resolve, reject) => {
      chrome!.stderr!.on("data", (chunk: Buffer) => {
        const found = /DevTools listening on (ws:\S+)/u.exec((printed += chunk.toString("utf8")));
        if (found !== null) resolve(found[1]!);
      });
      chrome!.once("exit", (code, signal) => reject(new Error(`Chrome exited (${code ?? signal}) before it listened: ${printed}`)));
    });
    const socket = new WebSocket(address);
    await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
    const devtools = new Devtools(socket);
    const workerOf = async (ending: string): Promise<string> => {
      let found: string | undefined;
      await until(`the worker ${ending}`, () => {
        void devtools.targets().then((all) => (found = all.find((one) => one.type === "service_worker" && one.url.endsWith(ending))?.targetId));
        return found !== undefined;
      });
      return devtools.attach(found!);
    };
    const ours = await workerOf(`${HAND_LOADED.slice("chrome-extension://".length)}/worker.js`);
    const theirs = await workerOf("/other.js");
    const { targetId: popupTarget } = await devtools.send<{ targetId: string }>("Target.createTarget", { url: `${HAND_LOADED}/popup.html` });
    const popup = await devtools.attach(popupTarget);
    const popupNow = () => devtools.run<{ line: string; more: boolean }>(popup, `({ line: [...document.querySelectorAll("#standing .ck-signal__label, #standing .ck-signal__detail, .ls-then")].map((part) => part.textContent).join(" · "), more: document.getElementById("connected") !== null })`);
    const lines: Record<string, unknown> = {};
    const popupSays = async (what: string, line: string, more = false) => {
      let now = { line: "", more: false };
      let reading = false;
      await until(`the popup says ${line}${more ? ", and more" : ""}`, () => {
        if (!reading) {
          reading = true;
          void popupNow().then((read) => (now = read), () => undefined).finally(() => (reading = false));
        }
        return now.line === line && now.more === more;
      });
      expect(now).toEqual({ line, more });
      lines[what] = now.line;
    };
    const wake = () => devtools.run(popup, `chrome.runtime.sendMessage({ to: "worker", survey: true }).then(() => true, () => true)`);
    const stored = <T>(area: "local" | "session", key: string) => devtools.run<T | null>(ours, `chrome.storage.${area}.get(${JSON.stringify(key)}).then((kept) => kept[${JSON.stringify(key)}] ?? null)`);
    const fromOurs = (pass: string, unit: string) => devtools.run<{ status: number; code: unknown }>(ours, `fetch(${JSON.stringify(`${door.url}/v1/pair`)}, {
      method: "POST", headers: { "content-type": "application/json", "lifestream-device": "extension/0.8.0" },
      body: JSON.stringify({ connect: true, pass: ${JSON.stringify(pass)}, kind: "extension", unit: ${JSON.stringify(unit)} }),
    }).then(async (answer) => ({ status: answer.status, code: (await answer.json()).code ?? null }))`);
    const refusedFrom = (code: string) => door.logs.filter((line) => line.includes('"path":"/v1/pair"') && line.includes(`"code":"${code}"`)).length;

    const asked = () => door.logs.filter((line) => line.includes('"code":"NOT_WAITING"')).length;
    await until("the worker's first ask", () => asked() > 0);
    await popupSays("no wait", "Not connected · Open Lifestream on your Mac to allow it.");
    const knocks = (now = at) => statusOf(root, { now_ms: now, settings: readOpsSettings(root) }).needs.filter((need) => need.id.startsWith("connect:"))
      .map(({ id, words, line, state, since_ms }) => ({ id, words, line, state, since_ms }));
    const firstAsked = at;
    const knocked = (browser: string, from: number) => ({
      id: `connect:${browser}`, words: `${browser} is asking to connect`, line: `Since ${when(from, at, readOpsSettings(root).day)}`, state: "needs-you", since_ms: from,
    });
    await until("the knock's need", () => knocks().length === 1);
    expect(knocks()).toEqual([knocked("Chrome for Testing", firstAsked)]);
    const outsider = await fromProgram(door.url, { connect: true, pass: randomBytes(32).toString("base64url"), kind: "extension", unit: "chrome-5550aa0b" }, "https://site.example");
    expect(outsider).toEqual({ status: 403, code: "PAIR_ORIGIN" });
    expect(knocks().map((need) => need.id)).toEqual(["connect:Chrome for Testing"]);
    const knockPass = randomBytes(32).toString("base64url");
    expect(await fromProgram(door.url, { connect: true, pass: knockPass, kind: "extension", unit: "chrome-5550aa0b" })).toEqual({ status: 409, code: "NOT_WAITING" });
    expect(knocks()).toEqual([knocked("Chrome for Testing", firstAsked), knocked("Chrome", firstAsked)]);
    const stated = { first_ms: firstAsked, last_ms: firstAsked };
    expect(readHome(root, (db) => db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(KNOCKS))).toBe(JSON.stringify({ "Chrome for Testing": stated, Chrome: stated }));
    expect(readPrincipals(openHomeFolder(root)).principals.filter((row) => row.unit === "chrome-5550aa0b")).toEqual([]);
    expect(knocks(firstAsked + KNOCK_MS + 1_000)).toEqual([]);
    const programs = () => knocks().filter((need) => need.id === "connect:Chrome");
    const knock = () => fromProgram(door.url, { connect: true, pass: knockPass, kind: "extension", unit: "chrome-5550aa0b" });
    at += KNOCK_MS / 2 + 10_000;
    expect(await knock()).toEqual({ status: 409, code: "NOT_WAITING" });
    at += KNOCK_MS / 2 + 10_000;
    const ticks = home.stats().ticks.count;
    await until("a tick at the clock moved", () => home.stats().ticks.count > ticks + 1);
    expect(programs()).toEqual([knocked("Chrome", firstAsked)]);
    at += KNOCK_MS + 1_000;
    await until("the program's knock gone", () => programs().length === 0);
    report.knocked = knocks();

    await mac();
    expect(knocks()).toEqual([]);
    const waiting = await listed("the request on the Mac", (now) => now.requests.length === 1);
    const [first] = waiting.requests;
    expect(first).toMatchObject({ id: expect.stringMatching(/^c-[0-9a-f]{8}$/u), browser: "Chrome for Testing" });
    await popupSays("asked", "Connecting · This Mac · Allow it in Lifestream on this Mac.");
    const unit = (await stored<string>("local", "lifestream.unit"))!;
    const pass = (await stored<string>("local", "lifestream.asking"))!;
    report.listed = waiting;

    const spare = () => randomBytes(32).toString("base64url");
    const before = refusedFrom("PAIR_ORIGIN");
    const { targetId: pageTarget } = await devtools.send<{ targetId: string }>("Target.createTarget", { url: page });
    const pageSession = await devtools.attach(pageTarget);
    const simple = (from: string) => devtools.run(from, `fetch(${JSON.stringify(`${door.url}/v1/pair`)}, { method: "POST", headers: { "content-type": "text/plain" }, body: ${JSON.stringify(JSON.stringify({ connect: true, pass: spare(), kind: "extension", unit: "chrome-5550aa09" }))} }).then((answer) => answer.status, (error) => String(error))`);
    await until("the page loaded", () => {
      void devtools.run<string>(pageSession, "document.readyState").then((state) => (pageReady = state === "complete"), () => undefined);
      return pageReady;
    });
    await simple(pageSession);
    await until("the page's request refused", () => refusedFrom("PAIR_ORIGIN") === before + 1);
    await simple(theirs);
    await until("the other extension's request refused", () => refusedFrom("PAIR_ORIGIN") === before + 2);
    report.refused = { page: "PAIR_ORIGIN", other_extension: "PAIR_ORIGIN" };
    const program = await fromProgram(door.url, { connect: true, pass: spare(), kind: "extension", unit: "chrome-5550aa0a", browser: "Safe Browser", model: "Safe Browser" });
    expect(program).toEqual({ status: 202, code: undefined });
    const named = (await listed("the program's request on the Mac", (now) => now.requests.length === 2)).requests[1]!;
    expect(named.browser).toBe("Chrome");
    report.program = { answered: program, listed: named };

    const swapped = [];
    for (let each = 0; each < 3; each++) swapped.push(await fromOurs(spare(), unit));
    expect(swapped).toEqual([...Array(2).fill({ status: 202, code: null }), { status: 429, code: "CONNECT_CROWDED" }]);
    expect((await mac()).requests.map((request) => request.id)[0]).toBe(first!.id);
    expect((await mac()).requests).toHaveLength(4);
    at += ASKED_MS / 2 + 500;
    await mac();
    at += ASKED_MS / 2 + 1_000;
    const asking = (await listed("only the browser still asking listed", (now) => now.requests.length === 1)).requests[0]!;
    report.crowded = swapped;

    const denied = await mac("answer", asking.id, "deny");
    expect(denied).toEqual({ answered: { id: asking.id, unit, allowed: false } });
    await popupSays("denied", "Not connected · Lifestream on this Mac said not now.");
    await wake();
    expect(await fromOurs(pass, unit)).toEqual({ status: 403, code: "CONNECT_DENIED" });
    expect((await mac()).requests).toEqual([]);

    at += SHOWN_MS + 1_000;
    expect(await fromOurs(pass, unit)).toEqual({ status: 409, code: "NOT_WAITING" });
    expect(knocks()).toEqual([]);
    await expect(mac("answer", asking.id, "allow")).rejects.toThrow(`no request ${asking.id} waits`);

    const again = (await listed("asked again", (now) => now.requests.length === 1)).requests[0]!;
    expect(again.id).not.toBe(asking.id);
    const allowed = await mac("answer", again.id, "allow");
    expect(allowed).toEqual({ answered: { id: again.id, unit, allowed: true } });
    const left = { connect: true, pass: spare(), kind: "extension", unit: "chrome-5550aa0c" };
    expect(await fromProgram(door.url, left)).toEqual({ status: 202, code: undefined });
    await mac();
    at += SHOWN_MS + 1_000;
    expect(await fromProgram(door.url, left)).toEqual({ status: 409, code: "NOT_WAITING" });
    expect(knocks()).toEqual([]);
    await until("the extension paired", () => {
      void stored<{ url: string; pass: string }>("local", "lifestream.pairing").then((kept) => (paired = kept), () => undefined);
      return paired !== null;
    });
    expect(paired).toEqual({ url: door.url, pass });
    const principal = readPrincipals(openHomeFolder(root)).principals.find((row) => row.unit === unit)!;
    expect(principal).toMatchObject({ kind: "extension", scopes: ["station"], token_sha256: createHash("sha256").update(pass).digest("hex") });
    expect(readFileSync(join(root, "config", "principals.json"), "utf8")).not.toContain(pass);
    expect(readHome(root, (db) => db.prepare("SELECT model FROM devices WHERE unit = ?").pluck().get(unit))).toBe("Chrome for Testing");

    await popupSays("connected", "Connected · This Mac", true);
    await until("the home's list kept", () => {
      void stored<string[]>("local", "lifestream.home-chosen").then((now) => (chosen = now ?? null), () => undefined);
      return chosen !== null;
    });
    expect(chosen).toEqual([]);
    expect(await stored("local", "lifestream.asking")).toBeNull();
    report.popup = lines;
    report.paired = { unit, model: "Chrome for Testing", chosen };

    const held = await devtools.run<{ origins: string[]; warnings: string[]; older: string[]; updated: string[] }>(ours, `(async () => {
      const manifest = chrome.runtime.getManifest();
      const warnings = (of) => chrome.management.getPermissionWarningsByManifest(JSON.stringify(of));
      // 0.8.0's permissions and hosts as its manifest had them (the commit that published it, db8c6bbcc).
      const older = {
        ...manifest,
        permissions: ["scripting", "storage", "alarms", "downloads", "downloads.ui", "offscreen", "debugger", "contentSettings"],
        host_permissions: ["https://claude.ai/*", "https://chatgpt.com/*", "https://takeout.google.com/*", "https://accounts.google.com/*",
          "https://app.whoop.com/*", "https://id.whoop.com/*", "https://api.prod.whoop.com/*", "file:///*"],
      };
      // What an install of 0.8.0 holds once updated: its grants and this build's together. Chrome turns an update off until
      // the person agrees only when that warns of more than what was granted.
      const updated = {
        ...manifest,
        permissions: [...new Set([...older.permissions, ...manifest.permissions])],
        host_permissions: [...new Set([...older.host_permissions, ...manifest.host_permissions])],
      };
      return { origins: (await chrome.permissions.getAll()).origins, warnings: await warnings(manifest), older: await warnings(older), updated: await warnings(updated) };
    })()`);
    expect(held.origins.sort()).toEqual(["https://api.prod.whoop.com/*", "https://app.whoop.com/*", "https://chatgpt.com/*", "https://claude.ai/*", "https://id.whoop.com/*"]);
    expect([...held.warnings].sort()).toEqual(["Read and change your data on a number of websites", "Read your browsing history"]);
    expect([...held.updated].sort()).toEqual([...held.older].sort());
    report.install = held;

    const elsewhere = { url: door.url, pass: spare() };
    const otherUnit = "chrome-5550ac01";
    const passRefused = () => door.logs.filter((line) => line.includes('"path":"/v1/stations/exchange"') && line.includes('"code":"PRINCIPAL_UNKNOWN"')).length;
    at += SHOWN_MS + 1_000;
    await devtools.run(ours, `chrome.storage.local.set({ "lifestream.home-chosen": ["claude"], "lifestream.unit": ${JSON.stringify(otherUnit)}, "lifestream.pairing": ${JSON.stringify(elsewhere)} }).then(() => true)`);
    await until("the pass from another home refused", () => passRefused() > 0);
    await until("its knock", () => knocks().length === 1);
    expect(knocks()).toEqual([knocked("Chrome for Testing", at)]);
    await popupSays("another home's pass", "Not connected · Open Lifestream on your Mac to allow it.", true);
    const back = (await listed("the browser from another home on the Mac", (now) => now.requests.length === 1)).requests[0]!;
    expect(back.browser).toBe("Chrome for Testing");
    await popupSays("another home's pass asked", "Connecting · This Mac · Allow it in Lifestream on this Mac.", true);
    expect(await mac("answer", back.id, "allow")).toEqual({ answered: { id: back.id, unit: otherUnit, allowed: true } });
    await popupSays("another home's pass allowed", "Connected · This Mac", true);
    expect(await stored("local", "lifestream.pairing")).toEqual(elsewhere);
    let kept: string[] | null = null;
    await until("the home's list kept", () => {
      void stored<string[]>("local", "lifestream.home-chosen").then((now) => (kept = now ?? null), () => undefined);
      return kept !== null && kept.length === 0;
    });
    expect(kept).toEqual([]);
    const principals = openHomeFolder(root);
    const taken = readPrincipals(principals).principals.find((row) => row.unit === otherUnit)!;
    expect(taken.token_sha256).toBe(createHash("sha256").update(elsewhere.pass).digest("hex"));

    at += SHOWN_MS + 1_000;
    revokePrincipal(principals, taken.id, Date.now());
    await wake();
    await until("the pass taken back asks, refused", () => refusedFrom("CONNECT_TAKEN_BACK") > 0);
    await popupSays("taken back", "Not connected · Lifestream on this Mac doesn't know this browser now: remove the extension and add it again.", true);
    expect(knocks()).toEqual([]);
    report.another_home = { unit: otherUnit, listed: back, popup: lines };
  });

  it("ends a wait ten seconds after the Mac's last ask, an answer renewing nothing: what the window could have read ended, what first asked after it a knock (14)", async () => {
    const root = makeRoot("lifestream-connect-lease-", { sources: {} });
    let at = Date.now();
    const door = await doorHere(root);
    const options = { registry: FAKES, slot: null, log: () => undefined, tickMs: 3_600_000, clock: () => at };
    let home = await startHome(root, options);
    onTestFinished(async () => {
      await door.stop();
      await home.stop();
      removeRoot(root);
    });
    const sock = testSocket(root);
    const mac = async (...args: string[]) => (await ask(sock, { verb: "connect", args, by: "you" })) as Connecting;
    const browser = (unit: string) => ({ connect: true, pass: randomBytes(32).toString("base64url"), kind: "extension", unit });
    const knocks = () => statusOf(root, { now_ms: at, settings: readOpsSettings(root) }).needs.filter((need) => need.id.startsWith("connect:")).map((need) => need.id);
    const units = () => readPrincipals(openHomeFolder(root)).principals.map((row) => row.unit);
    const timeline: Record<string, unknown> = {};

    const T = at;
    expect(await mac()).toEqual({ requests: [] });
    const allowed = browser("chrome-5550ab01");
    const left = browser("chrome-5550ab02");
    expect([await fromProgram(door.url, allowed), await fromProgram(door.url, left)]).toEqual([{ status: 202, code: undefined }, { status: 202, code: undefined }]);
    const read = (await mac()).requests;
    expect(read).toHaveLength(2);
    at = T + 5_000;
    const late = browser("chrome-5550ab03");
    expect(await fromProgram(door.url, late)).toEqual({ status: 202, code: undefined });
    expect([await fromProgram(door.url, allowed), await fromProgram(door.url, left)]).toEqual([{ status: 202, code: undefined }, { status: 202, code: undefined }]);
    at = T + 9_000;
    expect(await mac("answer", read[0]!.id, "allow")).toEqual({ answered: { id: read[0]!.id, unit: allowed.unit, allowed: true } });
    at = T + SHOWN_MS + 1;
    await expect(mac("answer", read[1]!.id, "allow")).rejects.toThrow(`no request ${read[1]!.id} waits`);
    expect(units()).not.toContain(left.unit);
    timeline.allowed = await fromProgram(door.url, allowed);
    expect(timeline.allowed, "allowed before the lapse, it pairs at its next ask").toEqual({ status: 200, code: undefined });
    timeline.left = await fromProgram(door.url, left);
    expect([timeline.left, knocks()]).toEqual([{ status: 409, code: "NOT_WAITING" }, []]);
    timeline.late = await fromProgram(door.url, late);
    expect([timeline.late, knocks()]).toEqual([{ status: 409, code: "NOT_WAITING" }, ["connect:Chrome"]]);

    const offered = (await mac()).requests;
    expect([offered.map((request) => request.browser), knocks()]).toEqual([["Chrome"], []]);
    expect([await fromProgram(door.url, left), await fromProgram(door.url, late)]).toEqual([{ status: 202, code: undefined }, { status: 202, code: undefined }]);
    expect((await mac()).requests.map((request) => request.id)).toEqual([offered[0]!.id, expect.stringMatching(/^c-/u)]);
    for (const gone of ["open", "close"]) await expect(mac(gone)).rejects.toThrow("usage: lifestream connect [answer <id> allow|deny]");

    await home.stop();
    home = await startHome(root, options);
    expect(await fromProgram(door.url, late)).toEqual({ status: 409, code: "NOT_WAITING" });
    expect((await mac()).requests).toHaveLength(1);
    expect(await fromProgram(door.url, late)).toEqual({ status: 202, code: undefined });
    expect((await mac()).requests).toHaveLength(1);

    at += SHOWN_MS + 1;
    const terminal = browser("chrome-5550ab04");
    expect(await fromProgram(door.url, terminal)).toEqual({ status: 409, code: "NOT_WAITING" });
    at += KNOCK_MS + 1;
    expect(await askHome(sock, "connect")).toEqual({ requests: [] });
    at += SHOWN_MS + 1;
    expect(await fromProgram(door.url, terminal)).toEqual({ status: 202, code: undefined });
    at += 5_000;
    const typed = ((await askHome(sock, "connect")) as Connecting).requests;
    expect(typed).toHaveLength(1);
    const asks: unknown[] = [];
    for (let step = 0; step < 12; step++) {
      at += 5_000;
      asks.push(await fromProgram(door.url, terminal));
    }
    expect(asks).toEqual(Array.from({ length: 12 }, () => ({ status: 202, code: undefined })));
    expect(((await askHome(sock, "connect")) as Connecting).requests.map((request) => request.id)).toEqual([typed[0]!.id]);
    expect(await askHome(sock, "connect", ["answer", typed[0]!.id, "allow"])).toEqual({ answered: { id: typed[0]!.id, unit: terminal.unit, allowed: true } });
    expect(await fromProgram(door.url, terminal)).toEqual({ status: 200, code: undefined });
    report.lease = timeline;
  });

  it("refuses the copy from the Chrome Web Store, which has the store's id, or lets another origin read the door (17)", async () => {
    const root = makeRoot("lifestream-connect-store-", { sources: {} });
    const door = await doorHere(root);
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, slot: null, log: () => undefined, tickMs: 3_600_000 });
    onTestFinished(async () => {
      await door.stop();
      await home.stop();
      removeRoot(root);
    });
    const sock = testSocket(root);
    const mac = async (...args: string[]) => (await ask(sock, { verb: "connect", args, by: "you" })) as Connecting;
    const browser = (unit: string) => ({ connect: true, pass: randomBytes(32).toString("base64url"), kind: "extension", unit });
    const readableBy = (origin: string) => new Promise<string | null>((resolve, reject) => {
      const sent = httpRequest(`${door.url}/v1/pair`, { method: "OPTIONS", agent: false, headers: { origin, "access-control-request-method": "POST" } }, (response) => {
        response.resume();
        response.on("end", () => resolve((response.headers["access-control-allow-origin"] as string | undefined) ?? null));
      });
      sent.on("error", reject);
      sent.end();
    });

    expect(await mac()).toEqual({ requests: [] });
    const asked = {
      loaded: await fromProgram(door.url, browser("chrome-5550ac01"), HAND_LOADED),
      store: await fromProgram(door.url, browser("chrome-5550ac02"), STORE),
      other: await fromProgram(door.url, browser("chrome-5550ac03"), "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    };
    expect(asked).toEqual({ loaded: { status: 202, code: undefined }, store: { status: 202, code: undefined }, other: { status: 403, code: "PAIR_ORIGIN" } });
    expect((await mac()).requests).toHaveLength(2);
    const readable = { loaded: await readableBy(HAND_LOADED), store: await readableBy(STORE), other: await readableBy("https://site.example") };
    expect(readable).toEqual({ loaded: HAND_LOADED, store: STORE, other: null });
    report.store = { asked, readable };
  });
});
