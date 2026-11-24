import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { connect, type Stations } from "./client.js";
import { pair } from "./link.js";
import { chrome } from "./test/chrome.js";
import { closing } from "./test/closing.js";
import { until } from "./test/until.js";

const REPO = fileURLToPath(new URL("../", import.meta.url));

class Stopped extends Error {}

type Answer = { result?: unknown; error?: { message: string } };
type Event = { method?: string; sessionId?: string; params?: { sessionId?: string; targetId?: string; targetInfo?: { targetId: string; type: string } } };

class Devtools {
  readonly #socket: WebSocket;
  readonly #waiting = new Map<number, { sessionId: string | undefined; method: string; answer: (message: Answer) => void; stop: (error: Stopped) => void }>();
  readonly #ended = new Map<string, string>();
  readonly #workers = new Set<string>();
  readonly #began = performance.now();
  readonly heard: string[] = [];
  #next = 0;
  constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as Answer & Event & { id?: number };
      if (message.id !== undefined) this.#waiting.get(message.id)?.answer(message);
      else this.#heard(message);
    });
  }
  #heard({ method, sessionId, params = {} }: Event): void {
    const info = params.targetInfo;
    if (info?.type === "service_worker") this.#workers.add(info.targetId);
    if (method === "Target.attachedToTarget" && info?.type === "service_worker") this.#workers.add(params.sessionId!);
    if (!/^(Target|Inspector)\./u.test(method ?? "")) return;
    const about = sessionId ?? params.sessionId ?? params.targetId ?? info?.targetId;
    if (about === undefined || !this.#workers.has(about)) return;
    this.heard.push(`${((performance.now() - this.#began) / 1000).toFixed(1)} s ${method} ${[params.targetId ?? info?.targetId, params.sessionId ?? sessionId].filter(Boolean).join(" ")}`);
    if (method === "Inspector.targetCrashed") this.#end(sessionId!, "Chrome stopped the worker (Inspector.targetCrashed)");
    else if (method === "Target.detachedFromTarget") this.#end(params.sessionId!, "Chrome detached the session (Target.detachedFromTarget)");
  }
  #end(sessionId: string, how: string): void {
    this.#ended.set(sessionId, how);
    for (const waiting of this.#waiting.values()) if (waiting.sessionId === sessionId) waiting.stop(new Stopped(`${waiting.method}: ${how}`));
  }
  ended(sessionId: string): boolean {
    return this.#ended.has(sessionId);
  }
  async send<T>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const ended = sessionId === undefined ? undefined : this.#ended.get(sessionId);
    if (ended !== undefined) throw new Stopped(`${method}: ${ended}`);
    const id = ++this.#next;
    const answered = new Promise<Answer>((answer, stop) => {
      this.#waiting.set(id, { sessionId, method, answer, stop });
      this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    });
    let answer: Answer = {};
    try {
      await until(`Chrome's answer to ${method}`, async () => { answer = await answered; return true; });
    } catch (error) {
      throw error instanceof Stopped ? error : this.told(error);
    } finally {
      this.#waiting.delete(id);
    }
    if (answer.error !== undefined) throw new Error(`${method}: ${answer.error.message}`);
    const attached = (answer.result as { sessionId?: string } | undefined)?.sessionId;
    if (method === "Target.attachToTarget" && attached !== undefined && this.#workers.has((params as { targetId?: string }).targetId ?? "")) this.#workers.add(attached);
    return answer.result as T;
  }
  told(error: unknown): Error {
    const message = (error as Error).message;
    return message.includes("; Chrome said of its workers: ") ? error as Error : new Error(`${message}; Chrome said of its workers: ${this.heard.join(", ") || "nothing"}`);
  }
}

const DEADLINE_MS = 120_000;

describe("the station's own window, in Chrome", () => {
  const binary = inject("chromeForTesting");
  const dir = mkdtempSync(join(tmpdir(), "extension-window-"));
  let stationsProcess: ChildProcess;
  let browser: ReturnType<typeof chrome> | undefined;
  let site: Server;
  let otherSite: Server;
  let origin = "";
  let other = "";
  let apartSite: Server;
  let apart = "";
  let slowSite: Server;
  let late = "";
  let devtools: Devtools;
  let worker = "";
  let workerTarget = "";
  let workerUrl = "";
  let stations: Stations;
  let state = "";
  let slow: ServerResponse | undefined;

  const listed = async (): Promise<{ targetId: string; type: string; url: string }[]> =>
    (await devtools.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets")).targetInfos;
  const running = async (): Promise<string | undefined> =>
    (await listed()).find((one) => one.type === "service_worker" && one.url === workerUrl)?.targetId;
  async function wake(): Promise<void> {
    const { targetId: popup } = await devtools.send<{ targetId: string }>("Target.createTarget", { url: workerUrl.replace(/worker\.js$/u, "popup.html"), newWindow: true });
    const page = (await devtools.send<{ sessionId: string }>("Target.attachToTarget", { targetId: popup, flatten: true })).sessionId;
    await until("the popup's extension runtime", async () => (await devtools.send<{ result: { value?: boolean } }>("Runtime.evaluate", { expression: "typeof chrome.runtime?.sendMessage === 'function'", returnByValue: true }, page)).result.value === true);
    await devtools.send("Runtime.evaluate", { expression: `chrome.runtime.sendMessage({ to: "worker", survey: true })`, awaitPromise: true }, page);
    await until("the station's worker running", async () => (await running()) !== undefined);
    await devtools.send("Target.closeTarget", { targetId: popup });
  }
  async function attached(): Promise<void> {
    await until("the extension's worker attached", async (): Promise<boolean> => {
      let now = await running();
      if (now === undefined) {
        await wake();
        now = await running();
        if (now === undefined) return false;
      }
      if (now === workerTarget && !devtools.ended(worker)) return true;
      workerTarget = "";
      worker = "";
      const session = (await devtools.send<{ sessionId: string }>("Target.attachToTarget", { targetId: now, flatten: true })).sessionId;
      try {
        await devtools.send("Runtime.enable", {}, session);
        await until("the worker's extension storage", async () => (await devtools.send<{ result: { value?: boolean } }>("Runtime.evaluate", { expression: "typeof chrome?.storage?.local?.get === 'function'", returnByValue: true }, session)).result.value === true);
      } catch (error) {
        if (error instanceof Stopped) return false;
        throw error;
      }
      workerTarget = now;
      worker = session;
      return true;
    }).catch((error: unknown) => { throw devtools.told(error); });
  }
  async function inWorker<T>(expression: string): Promise<T> {
    await attached();
    const answer = await devtools.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
      "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, worker);
    if (answer.exceptionDetails !== undefined) throw new Error(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text);
    return answer.result.value;
  }
  const ADDRESSES = `(async (tabs) => {
    const blank = chrome.runtime.getURL("blank.html");
    const parked = (await chrome.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [blank] })).map((one) => one.tabId);
    return tabs.map((tab) => {
      const address = tab.pendingUrl ?? tab.url;
      return address === blank ? "blank" : address ?? (parked.includes(tab.id) ? "blank" : "hidden");
    });
  })`;
  const tabsOf = (id: number): Promise<string[]> => inWorker(`chrome.tabs.query({ windowId: ${id} }).then(${ADDRESSES})`);
  const own = (): Promise<number | null> => inWorker(`chrome.storage.local.get("lifestream.window").then((kept) => kept["lifestream.window"] ?? null)`);
  const count = (): Promise<number> => inWorker(`chrome.windows.getAll().then((all) => all.length)`);
  const active = async (): Promise<number[]> => inWorker(`chrome.tabs.query({ active: true })
    .then((tabs) => tabs.filter((tab) => tab.windowId !== ${(await own()) ?? -1}).map((tab) => tab.id).sort())`);
  const held = (): Promise<string[]> => inWorker(`chrome.storage.session.get("lifestream.errands").then((kept) => (kept["lifestream.errands"] ?? []).map((one) => one.id))`);
  async function restartWorker(reloaded = false): Promise<void> {
    await attached();
    const [before] = await stations.list();
    if (reloaded) await inWorker(`chrome.storage.session.clear().then(() => true)`);
    const stopped = worker;
    await devtools.send("Target.closeTarget", { targetId: workerTarget });
    await until("the worker's session told it stopped", async () => devtools.ended(stopped)).catch((error: unknown) => { throw devtools.told(error); });
    await wake();
    await attached();
    await until("the station present again, a new boot", async () => (await stations.list()).some((one) => one.present && one.boot !== before?.boot));
  }
  const windowOf = (tab: number): Promise<number> => inWorker(`chrome.tabs.get(${tab}).then((one) => one.windowId)`);
  const idle = (window: number): Promise<void> => until("the station's window back to its blank tab", async () => (await tabsOf(window)).join() === "blank");
  async function inPage(url: string, expression: string): Promise<void> {
    const { targetInfos } = await devtools.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets", {});
    const target = targetInfos.find((one) => one.type === "page" && one.url === url);
    if (target === undefined) throw new Error(`no page at ${url}`);
    const page = (await devtools.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
    await devtools.send("Runtime.evaluate", { expression, userGesture: true }, page);
  }
  async function fieldIn(url: string): Promise<string | null> {
    const { targetInfos } = await devtools.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets", {});
    const target = targetInfos.find((one) => one.type === "page" && one.url === url);
    if (target === undefined) throw new Error(`no page at ${url}`);
    const page = (await devtools.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
    return (await devtools.send<{ result: { value: string | null } }>("Runtime.evaluate", { expression: `document.querySelector("input")?.value ?? null`, returnByValue: true }, page)).result.value;
  }
  async function refusal(call: Promise<unknown>): Promise<{ code: string; message: string }> {
    try {
      await call;
    } catch (error) {
      return { code: (error as { code: string }).code, message: (error as Error).message };
    }
    throw new Error("expected a refusal");
  }
  async function tabAt(url: string): Promise<number> {
    const find = `chrome.tabs.query({}).then((tabs) => tabs.find((tab) => tab.url === "${url}" && tab.status === "complete")?.id ?? null)`;
    await until(`a tab at ${url}`, async () => (await inWorker<number | null>(find)) !== null);
    return (await inWorker<number>(find))!;
  }
  async function errand(path: string, site = origin): Promise<number> {
    const window = await stations.using({ name: "page", origins: [site], deadline_ms: DEADLINE_MS }, async (one) => windowOf((await one.open(`${site}${path}`)).id));
    await idle(window);
    return window;
  }
  const claims = (): { tab: number; errand: string | null; from_ms: number; until_ms: number }[] => {
    try {
      return readFileSync(join(state, "claims.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const groups = (): Promise<number> => inWorker(`chrome.tabs.query({}).then((tabs) => tabs.filter((tab) => tab.groupId !== -1).length)`);

  const setup: string[] = [];
  let settingUp: string | null = "";
  async function step<T>(what: string, run: () => Promise<T>): Promise<T> {
    settingUp = what;
    const began = performance.now();
    const value = await run();
    setup.push(`${what} ${((performance.now() - began) / 1000).toFixed(1)} s`);
    return value;
  }

  beforeAll(async () => {
    if (binary === null) throw new Error("no Chrome to run the extension in: npx playwright install chromium");
    state = join(dir, "stations");
    const relay = await step("lifestream stations listening", async () => {
      const cliBundle = process.env.LIFESTREAM_TEST_DIST === undefined ? undefined : join(process.env.LIFESTREAM_TEST_DIST, "packages~home~test~cli-child.mjs");
      const cli = cliBundle !== undefined && existsSync(cliBundle) ? [cliBundle] : ["--import", "tsx", join(REPO, "packages", "home", "cli.ts")];
      stationsProcess = spawn(process.execPath, [...cli, "stations", "--state", state, "--port", "0", "--poll-ms", "200"],
        { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
      let said = "";
      let errors = "";
      stationsProcess.stdout!.on("data", (chunk: Buffer) => { said += chunk.toString("utf8"); });
      stationsProcess.stderr!.on("data", (chunk: Buffer) => { errors += chunk.toString("utf8"); });
      await until("lifestream stations saying where it listens", () => {
        if (stationsProcess.exitCode !== null || stationsProcess.signalCode !== null) {
          throw new Error(`lifestream stations exited (${stationsProcess.signalCode ?? `code ${stationsProcess.exitCode}`}) before it listened: ${(errors || said).trim() || "it said nothing"}`);
        }
        return said.includes("stations at ");
      });
      return JSON.parse(readFileSync(join(state, "relay.json"), "utf8")) as { url: string; drive_token: string; code: string };
    });

    const built = join(dir, "extension");
    await step("the extension built", async () => {
      const building = spawn(process.execPath, [join(REPO, "extension", "build.mjs"), built], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, LIFESTREAM_DOOR: relay.url } });
      let errors = "";
      let code: number | null | undefined;
      building.stderr!.on("data", (chunk: Buffer) => { errors += chunk.toString("utf8"); });
      building.once("close", (exited) => { code = exited; });
      await until("the extension built", () => {
        if (code !== undefined && code !== 0) throw new Error(`building the extension: ${errors}`);
        return code === 0;
      });
    });
    const manifest = JSON.parse(readFileSync(join(built, "manifest.json"), "utf8")) as { host_permissions: string[] };
    writeFileSync(join(built, "manifest.json"), JSON.stringify({ ...manifest, host_permissions: [...manifest.host_permissions, "http://127.0.0.1/*", "http://[::1]/*"] }));
    const worker = readFileSync(join(built, "worker.js"), "utf8");
    writeFileSync(join(built, "worker.js"), `{ const focus = chrome.windows.onFocusChanged; const heard = [];
      focus.addListener = (listener) => void heard.push(listener); focus.dispatch = (window) => heard.forEach((listener) => listener(window)); }
      { const scripting = chrome.scripting; const inject = scripting.executeScript.bind(scripting);
      scripting.executeScript = async (injection) => { const hook = globalThis.beforeInjection; globalThis.beforeInjection = undefined; if (hook !== undefined) await hook(injection); return inject(injection); }; }\n${worker}`);

    const page = (title: string) => (request: IncomingMessage, response: ServerResponse) =>
      void response.end(`<!doctype html><title>${title}</title>${request.url?.startsWith("/form") === true ? `<input aria-label="Field">` : "<p>a page</p>"}`);
    site = createServer(page("Page"));
    slowSite = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.write("<!doctype html><title>Slow</title>");
      slow = response;
    });
    await new Promise<void>((resolve) => slowSite.listen(0, "127.0.0.1", () => resolve()));
    late = `http://127.0.0.1:${(slowSite.address() as { port: number }).port}`;
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", () => resolve()));
    origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
    otherSite = createServer(page("Other"));
    await new Promise<void>((resolve) => otherSite.listen(0, "127.0.0.1", () => resolve()));
    other = `http://127.0.0.1:${(otherSite.address() as { port: number }).port}`;
    apartSite = createServer(page("Apart"));
    await new Promise<void>((resolve) => apartSite.listen(0, "::1", () => resolve()));
    apart = `http://[::1]:${(apartSite.address() as { port: number }).port}`;

    await step("Chrome listening", async () => {
      browser = chrome(binary, [
        "--headless=new", `--user-data-dir=${join(dir, "profile")}`, `--load-extension=${built}`, `--disable-extensions-except=${built}`,
        "--remote-debugging-port=0", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "about:blank",
      ]);
      const browserProcess = browser.child;
      let printed = "";
      browserProcess.stderr!.on("data", (chunk: Buffer) => { printed += chunk.toString("utf8"); });
      let address: string | undefined;
      await until("Chrome saying where its DevTools listen", () => {
        if (browserProcess.exitCode !== null || browserProcess.signalCode !== null) {
          throw new Error(`Chrome exited (${browserProcess.exitCode ?? browserProcess.signalCode}) before it listened: ${printed}`);
        }
        address = /DevTools listening on (ws:\S+)/u.exec(printed)?.[1];
        return address !== undefined;
      });
      const socket = new WebSocket(address!);
      await until("Chrome's DevTools socket open", () => {
        if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) throw new Error(`Chrome's DevTools socket closed before it opened: ${address}`);
        return socket.readyState === WebSocket.OPEN;
      });
      devtools = new Devtools(socket);
      await devtools.send("Target.setDiscoverTargets", { discover: true });
    });
    await step("the extension's worker", async () => {
      await until("Chrome's extension worker", async () => {
        workerUrl = (await listed()).find((one) => one.type === "service_worker" && one.url.endsWith("/worker.js"))?.url ?? "";
        return workerUrl !== "";
      });
      await attached();
    });

    await step("the station paired and present", async () => {
      const ownUnit = (): Promise<string | null> => inWorker(`chrome.storage.local.get("lifestream.unit").then((kept) => kept["lifestream.unit"] ?? null)`);
      await until("the worker's own unit, made as it first asks to connect", async () => (await ownUnit()) !== null);
      let paired: Awaited<ReturnType<typeof pair>> | undefined;
      await until("the door's answer to the pairing", async () => { paired = await pair(relay.url, relay.code, (await ownUnit())!, { version: "0.3.0" }); return true; });
      await inWorker(`chrome.storage.local.set(${JSON.stringify({ "lifestream.unit": paired!.unit, "lifestream.pairing": paired!.pairing })})`);
      stations = closing(connect(relay.url, relay.drive_token));
      await until("the station present", async () => (await stations.list()).some((one) => one.present));
    });
    settingUp = null;
    console.log(`window e2e setup: ${setup.join(", ")}`);
  });

  afterAll(async () => {
    if (settingUp !== null) {
      console.log(`window e2e setup did not finish, in: ${settingUp || "its start"}; before it: ${setup.join(", ") || "nothing"}; Chrome said of its workers: ${devtools?.heard.join(", ") || "nothing"}`);
    }
    slow?.end();
    const exited = (child: ChildProcess | undefined) => child === undefined || child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      await browser?.stop();
    } finally {
      stationsProcess?.kill();
      await exited(stationsProcess);
      site?.close();
      otherSite?.close();
      apartSite?.close();
      slowSite?.close();
    }
    rmSync(dir, { recursive: true, force: true });
  });

  let person = 0;

  it("runs its errands in one minimized window of its own, made at the first, never in the person's; closes a tab its errand left loading; keeps its blank tab; makes its window again once the person closes it; makes no tab group (1, 8)", async () => {
    person = await inWorker<number>(`chrome.windows.getAll({ windowTypes: ["normal"] }).then((all) => all[0].id)`);
    const [windows, theirs, theirTabs] = [await count(), await active(), await tabsOf(person)];
    const station = await errand("/first");
    expect([station === person, station, await count()]).toEqual([false, await own(), windows + 1]);
    expect(await errand("/again")).toBe(station);
    expect([await count(), await active(), await tabsOf(person)]).toEqual([windows + 1, theirs, theirTabs]);
    const short = await stations.open({ name: "short", origins: [late], deadline_ms: DEADLINE_MS });
    void short.open(`${late}/slow`).catch(() => undefined);
    await until("the slow page asked for", () => slow !== undefined);
    await short.close();
    await until("the errand let go by the station", async () => !(await held()).includes(short.id));
    slow!.end("<p>late</p>");
    await until("the late tab closed", async () => (await inWorker<string[]>(`chrome.tabs.query({}).then((tabs) => tabs.filter((tab) => tab.status !== "complete" || (tab.pendingUrl ?? tab.url ?? "").startsWith("${late}")).map((tab) => tab.url))`)).length === 0);
    await idle(station);

    await inWorker(`chrome.windows.remove(${station}).then(() => true)`);
    await until("the station's window closed", async () => (await count()) === windows);
    const [again, beside] = await Promise.all([errand("/third"), errand("/third", other)]);
    expect([again === person, again === station, again, beside]).toEqual([false, false, await own(), again]);
    expect(await errand("/fourth")).toBe(again);
    expect([await count(), await active(), await tabsOf(person), await groups()]).toEqual([windows + 1, theirs, theirTabs, 0]);
  });

  it("keeps its window while an errand with its window's only two tabs ends, both closed at once (2)", async () => {
    const station = await errand("/two-own");
    await stations.using({ name: "two tabs", origins: [origin, other], deadline_ms: DEADLINE_MS }, async (errand) => {
      await errand.open(`${origin}/one`);
      await errand.open(`${other}/two`);
      await inWorker(`chrome.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [chrome.runtime.getURL("blank.html")] })
        .then((blank) => chrome.tabs.remove(blank.map((one) => one.tabId))).then(() => true)`);
      expect(await tabsOf(station)).toEqual([`${origin}/one`, `${other}/two`]);
    });
    await idle(station);
  });

  it("keeps its window by its saved id after session storage is cleared, as on an extension reload (3)", async () => {
    const kept = await errand("/before-reload");
    const windows = await count();
    await restartWorker(true);
    expect(await errand("/after-reload")).toBe(kept);
    expect(await count()).toBe(windows);
  });

  it("keeps every tab of the person's, and an errand's tab they dragged out of the station's window (4)", async () => {
    const hidden = origin.replace("127.0.0.1", "localhost");
    const mine = await inWorker<number>(`chrome.windows.create({ url: ["${hidden}/mine-a", "${origin}/mine-b"], focused: false }).then((made) => made.id)`);
    const theirs = async (): Promise<string[]> => (await listed()).filter((one) => one.type === "page" && /\/mine-[ab]$/u.test(one.url)).map((one) => one.url).sort();
    await until("the person's two pages", async () => (await theirs()).length === 2);
    expect(await tabsOf(mine)).toEqual(["hidden", `${origin}/mine-b`]);
    const before = await theirs();
    await restartWorker(true);
    const kept = await errand("/beside");
    expect(kept).not.toBe(mine);
    expect([await theirs(), await tabsOf(mine)]).toEqual([before, ["hidden", `${origin}/mine-b`]]);
    await stations.using({ name: "dragged", origins: [origin], deadline_ms: DEADLINE_MS }, async (one) => {
      await one.open(`${origin}/kept`);
      const dragged = await one.open(`${origin}/form-dragged`);
      await inWorker(`chrome.tabs.move(${dragged.id}, { windowId: ${mine}, index: -1 }).then(() => true)`);
      const taken = await refusal(dragged.fill({ label: "Field" }, "typed"));
      expect([taken.code, taken.message]).toEqual(["PAGE_ERROR", "the person took the tab"]);
      expect(await fieldIn(`${origin}/form-dragged`)).toBe("");
    });
    await idle(kept);
    expect(await tabsOf(mine)).toEqual(["hidden", `${origin}/mine-b`, `${origin}/form-dragged`]);
    await inWorker(`chrome.windows.remove(${mine}).then(() => true)`);
  });

  it.runIf(process.platform === "darwin")("makes its window and runs while Chrome has no window open, and never runs in the person's once they open one (5)", async () => {
    await inWorker(`chrome.windows.getAll().then((all) => Promise.all(all.map((one) => chrome.windows.remove(one.id)))).then(() => true)`);
    await until("every window closed", async () => (await count()) === 0);
    const made = await errand("/no-window");
    expect([made, await count()]).toEqual([await own(), 1]);
    person = await inWorker<number>(`chrome.windows.create({ url: "about:blank" }).then((made) => made.id)`);
    expect([await errand("/window-again"), await count()]).toEqual([made, 2]);
  });

  it("forgets its window as Chrome starts again, and leaves the person's window that carries its old id be (6)", async () => {
    const past = await errand("/before-start");
    const mine = await inWorker<number>(`chrome.windows.create({ url: ["${origin}/mine-d", "${origin}/mine-e"], focused: false, state: "normal" }).then((made) => made.id)`);
    await until("the person's window's tabs loaded", async () => (await tabsOf(mine)).every((url) => url.startsWith(origin)));
    await inWorker(`chrome.windows.remove(${past}).then(() => true)`);
    const windows = await count();
    await inWorker(`chrome.storage.local.set({ "lifestream.window": ${mine} }).then(() => chrome.runtime.onStartup.dispatch()).then(() => true)`);
    const made = await errand("/after-start");
    expect([made === mine, made, await count()]).toEqual([false, await own(), windows + 1]);
    expect(await tabsOf(mine)).toEqual([`${origin}/mine-d`, `${origin}/mine-e`]);
    await inWorker(`chrome.windows.remove(${mine}).then(() => true)`);
  });

  it("closes a past session's blank tab that Chrome restored in the person's window, known by its blank page (7)", async () => {
    const station = await errand("/before-restored");
    const restored = await inWorker<number>(`chrome.tabs.create({ windowId: ${person}, url: "about:blank", active: false }).then((made) =>
      chrome.tabs.update(made.id, { url: chrome.runtime.getURL("blank.html") }).then(() => made.id))`);
    await until("the restored tab closed", async () => (await inWorker<boolean>(`chrome.tabs.get(${restored}).then(() => true, () => false)`)) === false);
    expect(await errand("/after-restored")).toBe(station);
    const before = Date.now();
    const [past, cut] = await inWorker<[number, number]>(`chrome.windows.create({ url: ["about:blank", "${origin}/cut-off"], focused: false }).then((made) => [made.id, made.tabs[1].id])`);
    await inWorker(`chrome.tabs.query({ windowId: ${past}, index: 0 }).then(([front]) => chrome.tabs.update(front.id, { active: true, url: chrome.runtime.getURL("blank.html") })).then(() => true)`);
    await until("the past session's window closed", async () => (await inWorker<boolean>(`chrome.windows.get(${past}).then(() => true, () => false)`)) === false);
    await until("the restored tab claimed", () => claims().some((one) => one.tab === cut));
    const claimed = claims().find((one) => one.tab === cut)!;
    expect(claimed.errand).toBeNull();
    expect(claimed.until_ms).toBeGreaterThanOrEqual(before);
    await until("the station let the claimed tab go", async () =>
      (await inWorker<unknown[]>(`chrome.storage.local.get("lifestream.unnamed").then((kept) => kept["lifestream.unnamed"] ?? [])`)).length === 0);
  });

  it.runIf(process.platform === "darwin")("claims the tabs of a past session's window that Chrome restored alone, emptied with its blank page in front, kept with a need's tab in front (16)", async () => {
    await inWorker(`chrome.windows.getAll().then((all) => Promise.all(all.map((one) => chrome.windows.remove(one.id)))).then(() => true)`);
    await until("every window closed", async () => (await count()) === 0);
    const before = Date.now();
    const restore = async (front: number): Promise<[number, number[]]> => {
      const [window, ids] = await inWorker<[number, number[]]>(`chrome.windows.create({ url: ["about:blank", "${origin}/cut-a", "${origin}/cut-b"], focused: false })
        .then((made) => [made.id, made.tabs.map((one) => one.id)])`);
      const loaded = `Promise.all(${JSON.stringify(ids.slice(1))}.map((id) => chrome.tabs.get(id).then((tab) => tab.status === "complete" && tab.url.startsWith("${origin}"))))`;
      await until("the reads loaded", async () => (await inWorker<boolean[]>(loaded)).every(Boolean));
      await inWorker(`chrome.tabs.update(${ids[front]}, { active: true }).then(() => chrome.tabs.update(${ids[0]}, { url: chrome.runtime.getURL("blank.html") })).then(() => true)`);
      return [window, ids];
    };
    const [emptied, first] = await restore(0);
    const standing = (ids: number[]): Promise<boolean[]> => inWorker(`Promise.all(${JSON.stringify(ids)}.map((id) => chrome.tabs.get(id).then(() => true, () => false)))`);
    await until("the reads closed", async () => (await standing(first)).join() === "true,false,false");
    expect(await inWorker<boolean>(`chrome.tabs.get(${first[0]}).then((tab) => tab.url === undefined || tab.url === "about:blank" || tab.url === chrome.runtime.getURL("blank.html"))`)).toBe(true);
    await inWorker(`chrome.windows.remove(${emptied}).then(() => true)`);
    await until("no window open", async () => (await count()) === 0);
    const [kept, second] = await restore(1);
    await until("the blank page closed", async () => (await standing(second)).join() === "false,true,true");
    const reads = [...first.slice(1), ...second.slice(1)];
    await until("the reads claimed", () => reads.every((tab) => claims().some((one) => one.tab === tab)));
    for (const tab of reads) expect(claims().find((one) => one.tab === tab)).toMatchObject({ errand: null });
    expect(claims().filter((one) => one.tab === first[0] || one.tab === second[0])).toEqual([]);
    expect(claims().find((one) => one.tab === reads[0])!.until_ms).toBeGreaterThanOrEqual(before);
    person = kept;
  });

  it("takes the tabs an errand's page opens as the errand's: its popup, the popup's link, a popup window kept minimized; each claimed until the deadline, closed as the errand ends, and the window kept (15)", async () => {
    const station = await errand("/before-popup");
    const opened = Date.now();
    const [made, id] = await stations.using({ name: "popup", origins: [origin], deadline_ms: DEADLINE_MS }, async (one) => {
      await one.open(`${origin}/opener`);
      await inPage(`${origin}/opener`, `void window.open("${origin}/popup")`);
      const popup = await tabAt(`${origin}/popup`);
      await inPage(`${origin}/popup`, `(() => { const link = document.createElement("a"); link.href = "${origin}/from-popup"; link.target = "_blank"; document.body.append(link); link.click(); })()`);
      await inPage(`${origin}/opener`, `void window.open("${origin}/popup-window", "_blank", "popup,width=400,height=400")`);
      const tabs = [popup, await tabAt(`${origin}/from-popup`), await tabAt(`${origin}/popup-window`)];
      await until("the three claimed", () => tabs.every((tab) => claims().some((claim) => claim.tab === tab)));
      expect(await tabsOf(station)).toEqual(expect.arrayContaining([`${origin}/opener`, `${origin}/popup`, `${origin}/from-popup`]));
      const windowed = await windowOf(tabs[2]!);
      await until("the popup window minimized", async () => (await inWorker<string>(`chrome.windows.get(${windowed}).then((made) => made.type + " " + made.state)`)) === "popup minimized");
      expect(await own()).toBe(station);
      return [tabs, one.id];
    });
    for (const tab of made) {
      const claimed = claims().find((one) => one.tab === tab)!;
      expect(claimed.errand).toBe(id);
      expect(claimed.from_ms).toBeGreaterThanOrEqual(opened - 60_000);
      expect(claimed.until_ms).toBeGreaterThanOrEqual(opened + DEADLINE_MS);
    }
    await idle(station);
    expect(await inWorker<boolean[]>(`Promise.all(${JSON.stringify(made)}.map((tab) => chrome.tabs.get(tab).then(() => true, () => false)))`)).toEqual([false, false, false]);
    expect(await own()).toBe(station);
  });

  const personsTabIn = (window: number, path: string): Promise<number> =>
    inWorker(`chrome.tabs.query({ windowId: ${window}, active: true }).then(([front]) => chrome.tabs.create({ windowId: ${window}, url: "${origin}${path}", openerTabId: front.id })).then((made) => made.id)`);
  const movedTo = (tab: number, window: number): Promise<void> => until("the tab in the station's new window", async () => (await windowOf(tab)) === window);
  async function openNeed(errand: string): Promise<void> {
    const { targetId: popup } = await devtools.send<{ targetId: string }>("Target.createTarget", { url: workerUrl.replace(/worker\.js$/u, "popup.html"), newWindow: true });
    const page = (await devtools.send<{ sessionId: string }>("Target.attachToTarget", { targetId: popup, flatten: true })).sessionId;
    await until("the popup's extension runtime", async () => (await devtools.send<{ result: { value?: boolean } }>("Runtime.evaluate", { expression: "typeof chrome.runtime?.sendMessage === 'function'", returnByValue: true }, page)).result.value === true);
    await devtools.send("Runtime.evaluate", { expression: `void chrome.runtime.sendMessage({ to: "worker", opened: { id: "shown", title: "Sign in", at: { errand: "${errand}" }, acts: [] } })` }, page);
    await until("the need's tab shown", async () => (await inWorker<number | null>(`chrome.storage.local.get("lifestream.shown").then((kept) => kept["lifestream.shown"] ?? null)`)) !== null);
    await devtools.send("Target.closeTarget", { targetId: popup });
  }

  it("gives up a window the person moved into: a worker started again closes none of their tabs, and the next errand runs in another (10)", async () => {
    const station = await errand("/before-moved-in");
    const [blank] = await inWorker<number[]>(`chrome.tabs.query({ windowId: ${station} }).then((tabs) => tabs.map((tab) => tab.id))`);
    await inWorker(`chrome.storage.local.set({ "lifestream.shown": ${blank} }).then(() => true)`);
    const mine = await personsTabIn(station, "/mine-g");
    await until("the person's page loaded", () => inWorker<boolean>(`chrome.tabs.get(${mine}).then((tab) => tab.status === "complete")`));
    expect(await own()).toBe(station);
    await restartWorker();
    expect(await inWorker<boolean>(`chrome.tabs.get(${mine}).then(() => true, () => false)`)).toBe(true);
    const next = await errand("/after-moved-in");
    expect(next).not.toBe(station);
    expect(await tabsOf(station)).toEqual([`${origin}/mine-g`]);
    await inWorker(`chrome.windows.remove(${station}).then(() => true)`);
  });

  it("gives up its window as a tab it did not open lands there, and the errand running there moves to another and ends there (11)", async () => {
    const station = await errand("/before-link");
    const mine = await stations.using({ name: "running", origins: [origin], deadline_ms: DEADLINE_MS }, async (one) => {
      const running = (await one.open(`${origin}/running`)).id;
      const link = await personsTabIn(station, "/from-another-app");
      await until("the station's window given up", async () => (await own()) !== station && (await own()) !== null);
      const next = (await own())!;
      await movedTo(running, next);
      expect(await tabsOf(station)).toEqual([`${origin}/from-another-app`]);
      return link;
    });
    const next = (await own())!;
    await idle(next);
    expect(await inWorker<boolean>(`chrome.tabs.get(${mine}).then((tab) => tab.active)`)).toBe(true);
    expect(await tabsOf(station)).toEqual([`${origin}/from-another-app`]);
    expect(await errand("/after-link")).toBe(next);
    await inWorker(`chrome.windows.remove(${station}).then(() => true)`);
  });

  it("gives up its window as the person focuses it: a new tab page where the blank page was, and the next errand in another (12)", async () => {
    const station = await errand("/before-focus");
    await inWorker(`chrome.windows.update(${station}, { state: "normal" }).then(() => chrome.windows.onFocusChanged.dispatch(${station})).then(() => true)`);
    await until("the station's window given up", async () => (await own()) !== station);
    await until("its blank page given way", async () => (await tabsOf(station)).join() === "hidden");
    const next = await errand("/after-focus");
    expect(next).not.toBe(station);
    expect(await tabsOf(station)).toEqual(["hidden"]);
    await inWorker(`chrome.windows.remove(${station}).then(() => true)`);
  });

  it("keeps its window while a need the person opened stands in it, and every tab of theirs beside it (13)", async () => {
    const station = await errand("/before-need");
    const needing = await stations.open({ name: "needing", origins: [origin], deadline_ms: DEADLINE_MS });
    const tab = (await needing.open(`${origin}/sign-in`)).id;
    await openNeed(needing.id);
    await until("the need's tab alone in its window, no blank page beside it", async () => (await tabsOf(station)).join() === `${origin}/sign-in`);
    await inWorker(`chrome.windows.onFocusChanged.dispatch(${station})`);
    const mine = await personsTabIn(station, "/mine-h");
    await until("the person's page loaded", () => inWorker<boolean>(`chrome.tabs.get(${mine}).then((tab) => tab.status === "complete")`));
    await restartWorker();
    expect([await own(), await windowOf(tab), await windowOf(mine)]).toEqual([station, station, station]);
    await needing.close();
    await until("the station's window given up", async () => (await own()) !== station);
    expect(await tabsOf(station)).toEqual([`${origin}/mine-h`]);
    await inWorker(`chrome.windows.remove(${station}).then(() => true)`);
  });

  it("makes its window as Chrome starts with sites to read, and none with none (14)", async () => {
    const station = await errand("/before-chosen");
    await inWorker(`chrome.windows.remove(${station}).then(() => true)`);
    await until("the station's window closed", async () => (await inWorker<boolean>(`chrome.windows.get(${station}).then(() => true, () => false)`)) === false);
    const windows = await count();
    await inWorker(`Promise.resolve(chrome.runtime.onStartup.dispatch()).then(() => true)`);
    expect([await own(), await count()]).toEqual([null, windows]);
    await inWorker(`chrome.storage.local.set({ "lifestream.home-chosen": ["chat"] }).then(() => chrome.runtime.onStartup.dispatch()).then(() => true)`);
    await until("the window made", async () => (await own()) !== null);
    expect(await count()).toBe(windows + 1);
    await inWorker(`chrome.storage.local.remove("lifestream.home-chosen").then(() => true)`);
  });

  it("keeps its window minimized: made so as Chrome starts, and minimized again as an errand's tab opens while it is shown with its blank page in front", async () => {
    const state = (id: number): Promise<string> => inWorker(`chrome.windows.get(${id}).then((one) => one.state)`);
    const before = await errand("/before-minimized");
    await inWorker(`chrome.windows.remove(${before}).then(() => true)`);
    await until("the station's window closed", async () => (await inWorker<boolean>(`chrome.windows.get(${before}).then(() => true, () => false)`)) === false);
    await inWorker(`chrome.storage.local.set({ "lifestream.home-chosen": ["chat"] }).then(() => chrome.runtime.onStartup.dispatch()).then(() => true)`);
    await until("the window made", async () => (await own()) !== null);
    const made = (await own())!;
    await inWorker(`chrome.storage.local.remove("lifestream.home-chosen").then(() => true)`);
    expect(await state(made)).toBe("minimized");
    await inWorker(`chrome.windows.update(${made}, { state: "normal" }).then(() => true)`);
    await until("the window shown", async () => (await state(made)) === "normal");
    expect(await errand("/while-shown")).toBe(made);
    expect(await state(made)).toBe("minimized");
  });

  it("fills nothing when the tab's page changes between its look and the injection, to the same site or another (17)", async () => {
    const station = await errand("/before-changed");
    await stations.using({ name: "changed", origins: [origin, apart], deadline_ms: DEADLINE_MS }, async (one) => {
      for (const to of [`${origin}/form-next`, `${apart}/form-apart`]) {
        const tab = await one.open(`${origin}/form-first`);
        await inWorker(`(globalThis.beforeInjection = () => new Promise((done) => {
          const committed = (details) => {
            if (details.tabId !== ${tab.id} || details.frameId !== 0) return;
            chrome.webNavigation.onCommitted.removeListener(committed);
            done();
          };
          chrome.webNavigation.onCommitted.addListener(committed);
          void chrome.tabs.update(${tab.id}, { url: "${to}" });
        }), true)`);
        const changed = await refusal(tab.fill({ label: "Field" }, "typed"));
        expect([to, changed.code, changed.message]).toEqual([to, "PAGE_ERROR", "the page changed under the call"]);
        expect(await fieldIn(to)).toBe("");
      }
    });
    await idle(station);
  });

  it("moves an errand's tabs with its window as the person focuses it while a call runs: that call and the next run on, no tab taken (18)", async () => {
    const station = await errand("/before-moving");
    await stations.using({ name: "moving", origins: [origin], deadline_ms: DEADLINE_MS }, async (one) => {
      const tab = await one.open(`${origin}/moving`);
      const waiting = tab.wait({ text: "arrived" }, 60_000);
      await until("the wait running at the station", async () => (await stations.list()).some((info) => info.running.length > 0));
      await inWorker(`chrome.windows.update(${station}, { state: "normal" }).then(() => chrome.windows.onFocusChanged.dispatch(${station})).then(() => true)`);
      await until("the station's window given up", async () => (await own()) !== station && (await own()) !== null);
      await movedTo(tab.id, (await own())!);
      await inPage(`${origin}/moving`, `document.body.append(Object.assign(document.createElement("p"), { textContent: "arrived" }))`);
      expect((await waiting).title).toBe("Page");
      expect((await tab.snapshot()).title).toBe("Page");
    });
    await idle((await own())!);
    await inWorker(`chrome.windows.remove(${station}).then(() => true)`);
  });

  it("holds its hosts from its install, and runs no content script (9)", async () => {
    const install = await inWorker<{ hosts: boolean; registered: unknown[]; declared: unknown }>(`(async () => {
      const manifest = chrome.runtime.getManifest();
      return {
        hosts: await chrome.permissions.contains({ origins: manifest.host_permissions.filter((origin) => origin.startsWith("http")) }),
        registered: await chrome.scripting.getRegisteredContentScripts(),
        declared: manifest.content_scripts ?? null,
      };
    })()`);
    expect(install).toEqual({ hosts: true, registered: [], declared: null });
  });

  it("reads a tab whose page failed to load as the address it asked, so a site out of reach answers OFFLINE, never ORIGIN_REFUSED (19)", async () => {
    const gone = createServer();
    await new Promise<void>((resolve) => gone.listen(0, "127.0.0.1", () => resolve()));
    const dead = `http://127.0.0.1:${(gone.address() as { port: number }).port}`;
    await new Promise<void>((resolve) => gone.close(() => resolve()));
    const theirs = `chrome.windows.getAll({ windowTypes: ["normal"] }).then((all) => all.find((one) => one.id !== ${(await own()) ?? -1})?.id)`;
    const made = await inWorker<number>(`${theirs}.then((windowId) => chrome.tabs.create({ windowId, url: "${dead}/measured", active: false })).then((tab) => tab.id)`);
    const frameOf = `chrome.webNavigation.getFrame({ tabId: ${made}, frameId: 0 }).then((frame) => frame === null ? null : { url: frame.url, errorOccurred: frame.errorOccurred }).catch(() => null)`;
    await until("the failed load committed in the test's tab", async () => {
      const frame = await inWorker<{ url: string } | null>(frameOf);
      return frame !== null && frame.url !== "about:blank";
    });
    const frame = await inWorker<{ url: string; errorOccurred: boolean }>(frameOf);
    const asked = await inWorker<string>(`chrome.tabs.get(${made}).then((tab) => tab.url)`);
    await inWorker(`chrome.tabs.remove(${made}).then(() => true)`);
    console.log(`window e2e case 19: a failed load's top frame reads ${JSON.stringify(frame)}, its tab ${asked}`);
    expect([frame, asked]).toEqual([{ url: `${dead}/measured`, errorOccurred: true }, `${dead}/measured`]);

    const station = await errand("/before-offline");
    await stations.using({ name: "offline", origins: [dead], deadline_ms: DEADLINE_MS }, async (one) => {
      const tab = await one.open(`${dead}/`);
      const offline = await refusal(tab.snapshot());
      expect(offline.code).toBe("OFFLINE");
    });
    await idle(station);
  });
});
