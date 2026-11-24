import { REPEATS, repeats, type PageAnswers, type PageCall, type PageEnvelope, type PageOp } from "./page.js";
import {
  FETCH_AT_ONCE,
  FETCH_MS,
  ownNeed,
  PART_BYTES,
  SECRET,
  StationError,
  type Answers,
  type Call,
  type ErrandSpec,
  type ExchangeAnswer,
  type FileRef,
  type FromCookie,
  type HomeNamed,
  type Need,
  type Op,
  type Outline,
  type PageRequest,
  type PageResponse,
  type Pressed,
  type Pressing,
  type Result,
  type Site,
  type StationInfo,
  type StationTab,
  type Value,
} from "./wire.js";


export interface Browser {
  openTab(url: string, ms: number): Promise<number>;
  closeTab(tab: number): Promise<void>;
  navigate(tab: number, url: string, ms: number): Promise<void>;
  look(tab: number): Promise<Look>;
  allowed(origin: string): Promise<boolean>;
  page(tab: number, document: string, call: PageCall): Promise<PageEnvelope>;
  save(errands: readonly SavedErrand[]): Promise<void>;
  restore(): Promise<SavedErrand[]>;
  choice(): Promise<{ chosen: string[] | null; pressed: Pressed }>;
  keep(chosen: readonly string[], answered: Pressed): Promise<void>;
  adopt(tab: StationTab): Promise<void>;
  unnamedTabs(): Promise<StationTab[]>;
  tabsHeard(heard: readonly StationTab[]): Promise<void>;
  askAllow(sites: readonly Site[]): Promise<void>;
  allowing(): Promise<string[]>;
  show(tab: number): Promise<boolean>;
}

export type Look =
  | { readonly url: string; readonly document: string }
  | { readonly closed: true }
  | { readonly taken: true }
  | { readonly loading: true };

type Seen = { readonly url: string; readonly document: string };

export interface SavedErrand {
  readonly id: string;
  readonly spec: ErrandSpec;
  readonly ends_at: number;
  readonly tabs: readonly number[];
  readonly popups: readonly number[];
  readonly held: readonly (readonly [string, string])[];
  readonly redact: readonly string[];
  readonly files: readonly string[];
  readonly refused: string | null;
}

export interface Link {
  exchange(station: StationInfo, results: readonly Result[], signal: AbortSignal): Promise<ExchangeAnswer>;
  put(errand: string, name: string, parts: AsyncIterable<Uint8Array>): Promise<FileRef>;
}

export class BelowFloor extends Error {
  constructor(readonly floor: string) {
    super(`Lifestream serves this extension from ${floor}`);
    this.name = "BelowFloor";
  }
}

export class Superseded extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Superseded";
  }
}

export type Opened = Pick<Need, "id"> & { readonly at: { readonly errand: string | null } | null };

export class PassRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PassRefused";
  }
}

export interface StationOptions {
  readonly browser: Browser;
  readonly link: Link;
  readonly unit: string;
  readonly version: string;
  readonly slots?: number;
  readonly now?: () => number;
  readonly report?: (state: Report) => void;
  readonly reload?: () => void;
  readonly reloaded?: { read(): Promise<boolean>; write(reloaded: boolean): Promise<void> };
  readonly development?: boolean;
  readonly generation?: number;
  readonly bounds?: Partial<Bounds>;
  readonly retryMs?: number;
  readonly updating?: () => boolean;
  readonly update?: () => void;
}

export interface Bounds {
  readonly fetch: number;
  readonly look: number;
  readonly act: number;
  readonly spare: number;
  readonly reach: number;
}

export interface Report {
  readonly at: number;
  readonly errands: { readonly id: string; readonly name: string; readonly origins: readonly string[] }[];
  readonly needs: Need[];
  readonly outdated: boolean;
  readonly sites: Site[];
  readonly error: string | null;
  readonly paired: boolean;
  readonly held: boolean;
}

export interface Station {
  serve(signal: AbortSignal): Promise<void>;
  handle(call: Call): Promise<Result>;
  opened(need: Opened): Promise<boolean>;
  act(pressing: Pressing): Promise<void>;
  survey(): void;
  chose(): void;
  granted(): void;
  tabOpened(source: number, tab: number): Promise<boolean>;
}

interface Errand {
  readonly id: string;
  readonly spec: ErrandSpec;
  readonly origins: ReadonlySet<string>;
  readonly tabs: Set<number>;
  readonly popups: Set<number>;
  readonly held: Map<string, string>;
  readonly redact: Set<string>;
  readonly files: Set<string>;
  readonly calls: Set<string>;
  readonly ends_at: number;
  readonly deadline: ReturnType<typeof setTimeout>;
  refused: string | null;
}

interface Admitted {
  readonly wanted: PageRequest;
  readonly call: Omit<PageOp & { op: "fetch" }, "ms">;
}

interface Bound {
  readonly until: number;
  readonly silent: () => PageSilent;
}

class PageSilent extends StationError {}

const SLOTS = 4;
const LOAD_MS = 30_000;
const LOOK_MS = 15_000;
const ACT_MS = 15_000;
const FETCH_SPARE_MS = 60_000;
const REACH_SPARE_MS = 10_000;
const WAIT_STEP_MS = 250;
const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/u;
const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

const originOf = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
  } catch {
    return null;
  }
};

const reached = (url: string): string => originOf(url) ?? "";

const placeOf = (url: string): string => {
  const origin = originOf(url);
  if (origin !== null) return origin;
  try {
    return new URL(url).protocol;
  } catch {
    return "an address that is no URL";
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const ENDED = "the errand ended while the call ran";

const seconds = (ms: number): string => `${Math.round(ms / 100) / 10} s`;

export const HELD = "Lifestream on your Mac needs its update before Chrome can send to it.";

const tooOld = (home: HomeNamed, stamp: number): boolean => home.version !== "checkout" && !(home.generation !== null && home.generation >= stamp);

async function* partsOf(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += PART_BYTES) yield bytes.subarray(offset, offset + PART_BYTES);
}

function fromBase64(text: string): Uint8Array {
  const fast = Uint8Array as typeof Uint8Array & { fromBase64?: (value: string) => Uint8Array };
  if (typeof fast.fromBase64 === "function") return fast.fromBase64(text);
  const nodeBuffer = (globalThis as { Buffer?: { from(value: string, encoding: string): Uint8Array } }).Buffer;
  if (nodeBuffer !== undefined) {
    const raw = nodeBuffer.from(text, "base64");
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function at(value: unknown, path: string): string | undefined {
  let node = value;
  for (const part of path.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

function redacted<T>(value: T, secrets: ReadonlySet<string>): T {
  if (secrets.size === 0) return value;
  const cut = (each: unknown): unknown => {
    if (typeof each === "string") {
      let text = each;
      for (const secret of [...secrets].sort((a, b) => b.length - a.length)) text = text.replaceAll(secret, SECRET);
      return text;
    }
    if (Array.isArray(each)) return each.map(cut);
    if (each !== null && typeof each === "object") return Object.fromEntries(Object.entries(each).map(([key, inner]) => [cut(key), cut(inner)]));
    return each;
  };
  return cut(value) as T;
}

export function createStation(options: StationOptions): Station {
  const { browser, link } = options;
  const now = options.now ?? Date.now;
  const slots = options.slots ?? SLOTS;
  const bounds: Bounds = { fetch: FETCH_MS, look: LOOK_MS, act: ACT_MS, spare: FETCH_SPARE_MS, reach: REACH_SPARE_MS, ...options.bounds };
  const errands = new Map<string, Errand>();
  let home: Need[] = [];
  let outdated: Need | null = null;
  let reloadedBelow: boolean | null = null;
  const streak = async (): Promise<boolean> => (reloadedBelow ??= await options.reloaded?.read().catch(() => false) ?? false);
  let held = options.generation !== undefined;
  let answering: HomeNamed | undefined;
  const opening: string[] = [];
  const acting: Pressing[] = [];
  let surveying = false;
  const running = new Set<string>();
  let inflight: AbortController | null = null;
  let sites: Site[] = [];
  const hearing = new Map<string, (() => void)[]>();
  const heard = (ids: readonly string[]): void => {
    for (const id of ids) for (const resolve of hearing.get(id) ?? []) resolve();
    for (const id of ids) hearing.delete(id);
  };
  const boot = Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  let stopped = false;
  let saving = Promise.resolve();
  let tookBack: () => void = () => undefined;
  const takenBack = new Promise<void>((resolve) => (tookBack = resolve));

  function persist(): void {
    if (stopped) return;
    saving = saving
      .then(() => {
        if (stopped) return;
        return browser.save([...errands.values()].map((one) => ({
          id: one.id,
          spec: one.spec,
          ends_at: one.ends_at,
          tabs: [...one.tabs],
          popups: [...one.popups],
          held: [...one.held],
          redact: [...one.redact],
          files: [...one.files],
          refused: one.refused,
        })));
      })
      .catch(() => undefined);
  }

  async function end(id: string): Promise<void> {
    const ending = errands.get(id);
    if (ending === undefined) return;
    errands.delete(id);
    clearTimeout(ending.deadline);
    persist();
    await Promise.all([...ending.tabs, ...ending.popups].map((tab) => browser.closeTab(tab).catch(() => undefined)));
  }

  function add(id: string, spec: ErrandSpec, origins: ReadonlySet<string>, endsAt: number): Errand {
    const running: Errand = {
      id,
      spec,
      origins,
      tabs: new Set(),
      popups: new Set(),
      held: new Map(),
      redact: new Set(),
      files: new Set(),
      calls: new Set(),
      ends_at: endsAt,
      deadline: setTimeout(() => void end(id), Math.max(0, endsAt - now())),
      refused: null,
    };
    errands.set(id, running);
    return running;
  }

  async function takeBack(): Promise<void> {
    const restored = await browser.restore().catch((): SavedErrand[] => []);
    for (const saved of restored) {
      if (errands.has(saved.id)) continue;
      const running = add(saved.id, saved.spec, new Set(saved.spec.origins), saved.ends_at);
      for (const tab of saved.tabs) running.tabs.add(tab);
      for (const tab of saved.popups) running.popups.add(tab);
      for (const [key, value] of saved.held) running.held.set(key, value);
      for (const value of saved.redact) running.redact.add(value);
      for (const name of saved.files) running.files.add(name);
      running.refused = saved.refused;
      if (saved.ends_at <= now()) await end(saved.id);
    }
    persist();
    tookBack();
  }

  function begin(id: string, call: string, spec: ErrandSpec): { begun: true } {
    const origins = new Set<string>();
    for (const origin of spec.origins) {
      if (originOf(origin) !== origin) throw new StationError("BAD_CALL", `"${origin}" is not an origin`);
      origins.add(origin);
    }
    if (origins.size === 0) throw new StationError("BAD_CALL", "an errand names at least one origin");
    const cookies: unknown = spec.cookies ?? [];
    if (!Array.isArray(cookies) || !cookies.every((name) => typeof name === "string" && COOKIE_NAME.test(name))) {
      throw new StationError("BAD_CALL", "an errand's cookies are cookies' names");
    }
    if (!(spec.deadline_ms > 0)) throw new StationError("BAD_CALL", "an errand has a deadline");
    if (errands.has(id)) throw new StationError("BAD_CALL", `errand ${id} has begun already`);
    if (errands.size >= slots) throw new StationError("BUSY", `the station runs ${slots} errands at once and has no free slot`);
    for (const other of errands.values()) {
      const shared = [...origins].find((origin) => other.origins.has(origin));
      if (shared !== undefined) throw new StationError("BUSY", `errand ${other.id} (${other.spec.name}) holds ${shared}`);
    }
    add(id, spec, origins, now() + spec.deadline_ms).calls.add(call);
    return { begun: true };
  }

  function live(running: Errand): boolean {
    if (errands.get(running.id) !== running) return false;
    if (now() < running.ends_at) return true;
    void end(running.id);
    return false;
  }

  function current(id: string): Errand {
    const running = errands.get(id);
    if (running === undefined || !live(running)) throw new StationError("NO_ERRAND", `errand ${id} is not running`);
    if (running.refused !== null) throw new StationError("ORIGIN_REFUSED", `the errand left its origins (${running.refused}) and ends`);
    return running;
  }

  function within(running: Errand, url: string): string {
    const origin = originOf(url);
    if (origin === null || !running.origins.has(origin)) {
      throw new StationError("ORIGIN_REFUSED", `${placeOf(url)} is not one of the errand's origins`);
    }
    return origin;
  }

  async function admit(running: Errand, url: string): Promise<string> {
    const origin = within(running, url);
    if (!(await browser.allowed(origin))) throw new StationError("SITE_NOT_ALLOWED", `the extension may not act on ${origin}; allow it in the extension's popup`);
    return origin;
  }

  async function refuse(running: Errand, tab: number, where: string, message: string): Promise<never> {
    running.refused = where;
    await browser.navigate(tab, "about:blank", LOAD_MS).catch(() => undefined);
    throw new StationError("ORIGIN_REFUSED", message);
  }

  async function seen(running: Errand, tab: number): Promise<Seen | null> {
    if (!live(running)) throw new StationError("NO_ERRAND", ENDED);
    if (!running.tabs.has(tab)) throw new StationError("BAD_CALL", `tab ${tab} is not one of the errand's`);
    const look = await browser.look(tab);
    if ("closed" in look) throw new StationError("PAGE_ERROR", "the tab was closed");
    if ("taken" in look) {
      running.tabs.delete(tab);
      persist();
      throw new StationError("PAGE_ERROR", "the person took the tab");
    }
    if ("loading" in look) return null;
    const origin = originOf(look.url);
    if (origin === null || !running.origins.has(origin)) {
      const where = placeOf(look.url);
      return await refuse(running, tab, where, `the tab went to ${where}, outside the errand's origins`);
    }
    if (!(await browser.allowed(origin))) throw new StationError("SITE_NOT_ALLOWED", `the extension may not act on ${origin}; allow it in the extension's popup`);
    return look;
  }

  async function check(running: Errand, tab: number): Promise<Seen> {
    const judged = await seen(running, tab);
    if (judged === null) throw new StationError("PAGE_ERROR", "the tab has no page yet");
    return judged;
  }

  const look = (): Bound => ({ until: now() + bounds.look, silent: () => new PageSilent("PAGE_ERROR", `the page did not answer within ${seconds(bounds.look)}`) });
  const act = (): Bound => ({ until: now() + bounds.act, silent: () => new PageSilent("INTERRUPTED", "the page did not answer: whether the act ran is not known") });

  async function bounded<T>(work: Promise<T>, until: number): Promise<{ readonly answer: T } | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const up = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), Math.max(0, until - now()))));
    try {
      return await Promise.race([work.then((answer) => (now() > until ? null : { answer })), up]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function page<K extends keyof PageAnswers>(running: Errand, tab: number, document: string, call: PageOp & { op: K }, bound: Bound): Promise<PageAnswers[K]> {
    const withhold = { values: [...running.redact], cookies: [...(running.spec.cookies ?? [])] };
    const answered = await bounded(browser.page(tab, document, { ...call, origins: [...running.origins], withhold } as PageCall), bound.until);
    if (answered === null) throw bound.silent();
    const envelope = answered.answer;
    if (envelope.ok) return envelope.value as PageAnswers[K];
    if (envelope.error.code === "ORIGIN_REFUSED") await refuse(running, tab, "a page that changed under the call", envelope.error.message);
    throw new StationError(envelope.error.code, envelope.error.message);
  }

  async function snapshotOf(running: Errand | undefined, tab: number | undefined): Promise<Outline | undefined> {
    if (running === undefined || tab === undefined || !running.tabs.has(tab)) return undefined;
    try {
      const { document } = await check(running, tab);
      return await page(running, tab, document, { op: "snapshot" }, look());
    } catch {
      return undefined;
    }
  }

  function resolve(running: Errand, value: Value): string {
    const known = header(running, value);
    if (typeof known === "string") return known;
    throw new StationError("BAD_CALL", "a value from a cookie is sent only as a header of a page's request (`fetch`)");
  }

  function header(running: Errand, value: Value): string | FromCookie {
    if (typeof value === "string") return value;
    const shape = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
    if (typeof shape.secret === "string") {
      const secret = value as { secret: string; value?: string };
      if (!(running.spec.secrets ?? []).includes(secret.secret) || secret.value === undefined || secret.value === "") {
        throw new StationError("SECRET_REFUSED", `secret "${secret.secret}" is not the errand's or was not resolved`);
      }
      running.redact.add(secret.value);
      return secret.value;
    }
    const prefix = shape.prefix === undefined || typeof shape.prefix === "string";
    if (typeof shape.held === "string" && prefix) {
      const held = running.held.get(shape.held);
      if (held === undefined) throw new StationError("BAD_CALL", `no value is held as "${shape.held}"`);
      return `${(shape.prefix as string | undefined) ?? ""}${held}`;
    }
    if (typeof shape.cookie === "string" && prefix) {
      if (!(running.spec.cookies ?? []).includes(shape.cookie)) throw new StationError("BAD_CALL", `cookie "${shape.cookie}" is not the errand's`);
      return shape.prefix === undefined ? { cookie: shape.cookie } : { cookie: shape.cookie, prefix: shape.prefix as string };
    }
    const named = value !== null && typeof value === "object" ? `{ ${Object.keys(value).join(", ")} }` : JSON.stringify(value);
    throw new StationError("BAD_CALL", `this extension (${options.version}) does not know a value of shape ${named}: update it`);
  }

  function name(running: Errand, wanted: string): string {
    if (!FILE_NAME.test(wanted) || wanted.includes("..")) throw new StationError("BAD_CALL", `"${wanted}" is not a file name`);
    if (running.files.has(wanted)) throw new StationError("BAD_CALL", `the errand already has a file "${wanted}"`);
    return wanted;
  }

  async function keep(running: Errand, wanted: string, parts: AsyncIterable<Uint8Array>): Promise<FileRef> {
    if (held) throw new StationError("HOME_TOO_OLD", HELD);
    running.files.add(name(running, wanted));
    try {
      return await link.put(running.id, wanted, parts);
    } catch (error) {
      running.files.delete(wanted);
      if (error instanceof StationError) throw error;
      throw new StationError("DOWNLOAD_FAILED", `the door did not take the file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function admitted(running: Errand, base: string, wanted: PageRequest, named: Set<string>): Admitted {
    let url: string;
    try {
      url = new URL(wanted.url, base).href;
    } catch {
      throw new StationError("BAD_CALL", `"${wanted.url}" is not a URL`);
    }
    within(running, url);
    if (wanted.as === "file") {
      if ((wanted as { readonly hold?: unknown }).hold !== undefined) throw new StationError("BAD_CALL", "a file holds no value: `hold` is a JSON body's");
      if (wanted.name === undefined) throw new StationError("BAD_CALL", "a file request names its file");
      name(running, wanted.name);
      if (named.has(wanted.name)) throw new StationError("BAD_CALL", `the call names a file "${wanted.name}" twice`);
      named.add(wanted.name);
    }
    const headers: Record<string, string | FromCookie> = {};
    for (const [key, value] of Object.entries(wanted.headers ?? {})) headers[key] = header(running, value);
    const call = { op: "fetch" as const, url, method: wanted.method ?? "GET", headers, binary: wanted.as === "file", held: wanted.hold !== undefined };
    return { wanted, call: wanted.body === undefined ? call : { ...call, body: wanted.body } };
  }

  const timeUp = (url: string): PageResponse => ({ status: 0, url, error: { code: "PAGE_ERROR", message: "the call's time ran out" } });

  async function request(running: Errand, tab: number, document: string, { wanted, call }: Admitted, clock: number): Promise<PageResponse> {
    const ms = Math.max(0, Math.min(bounds.fetch, clock - now()));
    let answer: PageAnswers["fetch"];
    try {
      answer = await page(running, tab, document, { ...call, ms }, {
        until: now() + ms + bounds.reach, silent: () => new PageSilent("PAGE_ERROR", `the page did not answer within ${seconds(ms)}`),
      });
    } catch (error) {
      if (error instanceof PageSilent) return { status: 0, url: call.url, error: { code: error.code, message: error.message } };
      throw error;
    }
    if (now() >= clock) return timeUp(call.url);
    if (answer.error !== undefined) return { status: 0, url: answer.url, error: answer.error };
    if (originOf(answer.url) !== null && !running.origins.has(originOf(answer.url) as string)) {
      return { status: 0, url: call.url, error: { code: "ORIGIN_REFUSED", message: `the request was redirected to ${originOf(answer.url)}` } };
    }
    const bytes = wanted.as === "file" ? fromBase64(answer.base64 ?? "") : undefined;
    const known = [...running.redact];
    const body = call.held ? "" : bytes === undefined ? answer.text ?? "" : new TextDecoder().decode(bytes);
    if (repeats(answer.url, known) || repeats(body, known)) return { status: 0, url: call.url, error: { code: "PAGE_ERROR", message: REPEATS } };
    if (bytes !== undefined) return { status: answer.status, url: answer.url, file: await keep(running, wanted.name as string, partsOf(bytes)) };
    let json: unknown;
    try {
      json = JSON.parse(answer.text ?? "");
    } catch {
      json = undefined;
    }
    if (wanted.hold === undefined) return json === undefined ? { status: answer.status, url: answer.url } : { status: answer.status, url: answer.url, json };
    const held = at(json, wanted.hold.path);
    if (held !== undefined && held !== "") {
      running.held.set(wanted.hold.name, held);
      running.redact.add(held);
      return { status: answer.status, url: answer.url, held: wanted.hold.name };
    }
    return { status: answer.status, url: answer.url };
  }

  async function op(running: Errand, call: { readonly id: string } & Op): Promise<Answers[keyof Answers]> {
    switch (call.op) {
      case "open": {
        await admit(running, call.url);
        const tab = await browser.openTab(call.url, LOAD_MS);
        if (errands.get(running.id) !== running) {
          await browser.closeTab(tab);
          throw new StationError("NO_ERRAND", `errand ${running.id} ended as its tab opened`);
        }
        running.tabs.add(tab);
        return { tab, url: reached((await seen(running, tab))?.url ?? "") };
      }
      case "goto":
        await seen(running, call.tab);
        await admit(running, call.url);
        await browser.navigate(call.tab, call.url, LOAD_MS);
        return { url: reached((await seen(running, call.tab))?.url ?? "") };
      case "snapshot": {
        const { document } = await check(running, call.tab);
        return await page(running, call.tab, document, call.text === true ? { op: "snapshot", text: true } : { op: "snapshot" }, look());
      }
      case "find": {
        const { document } = await check(running, call.tab);
        return await page(running, call.tab, document, { op: "find", target: call.target }, look());
      }
      case "click": {
        const { document } = await check(running, call.tab);
        await page(running, call.tab, document, { op: "click", target: call.target }, act());
        const after = await browser.look(call.tab);
        return { url: "url" in after ? reached(after.url) : "" };
      }
      case "fill": {
        const { document } = await check(running, call.tab);
        return await page(running, call.tab, document, { op: "fill", target: call.target, value: resolve(running, call.value) }, act());
      }
      case "select": {
        const { document } = await check(running, call.tab);
        return await page(running, call.tab, document, { op: "select", target: call.target, option: call.option }, act());
      }
      case "wait":
        return await waitFor(running, call);
      case "fetch": {
        const { url: base, document } = await check(running, call.tab);
        const requests: Admitted[] = [];
        const named = new Set<string>();
        for (const wanted of call.requests) requests.push(admitted(running, base, wanted, named));
        const answers: (PageResponse | undefined)[] = new Array(requests.length);
        const clock = now() + Math.ceil(requests.length / FETCH_AT_ONCE) * bounds.fetch + bounds.spare;
        let index = 0;
        let failed: { readonly error: unknown } | undefined;
        let over = false;
        const worker = async (): Promise<void> => {
          while (!over && failed === undefined && index < requests.length && now() < clock) {
            const mine = index++;
            try {
              const answer = await request(running, call.tab, document, requests[mine]!, clock);
              if (!over) answers[mine] = answer;
            } catch (error) {
              if (!over) failed ??= { error };
            }
          }
        };
        const done = await bounded(Promise.all(Array.from({ length: Math.min(FETCH_AT_ONCE, requests.length) }, worker)), clock);
        if (done === null) over = true;
        if (failed !== undefined) throw failed.error;
        return Array.from(answers, (answer, at) => answer ?? timeUp(requests[at]!.call.url));
      }
      default: {
        const unknown: { readonly op?: unknown } = call;
        throw new StationError("BAD_CALL", `this extension (${options.version}) does not know "${String(unknown.op)}": update it`);
      }
    }
  }

  async function waitFor(running: Errand, call: Extract<Op, { op: "wait" }>): Promise<Outline> {
    const until = now() + call.ms;
    for (;;) {
      const judged = await seen(running, call.tab);
      if (judged !== null) {
        try {
          const probe: Bound = { until: Math.min(now() + bounds.look, until), silent: () => new PageSilent("PAGE_ERROR", "the page did not answer the probe") };
          const answer = await page(running, call.tab, judged.document, { op: "probe", for: call.for }, probe);
          if (answer.matched && answer.outline !== undefined) return answer.outline;
        } catch (error) {
          if (!(error instanceof StationError) || !["PAGE_ERROR", "REF_STALE"].includes(error.code)) throw error;
        }
      }
      if (now() >= until) throw new StationError("TIMEOUT", `nothing matched ${JSON.stringify(call.for)} within ${call.ms} ms`);
      await sleep(WAIT_STEP_MS);
    }
  }

  async function handle(call: Call): Promise<Result> {
    if (held) {
      return { id: call.id, ok: false, error: { code: "HOME_TOO_OLD", message: `this extension is of generation ${options.generation} and the home is ${answering?.generation}: ${HELD}` } };
    }
    const secrets = errands.get(call.errand)?.redact ?? new Set<string>();
    let began: Errand | undefined;
    try {
      if (errands.get(call.errand)?.calls.has(call.id) === true) throw new StationError("BAD_CALL", `call ${call.id} ran already in this start`);
      if (call.op === "begin") return { id: call.id, ok: true, value: begin(call.errand, call.id, call.spec) };
      if (call.op === "end") {
        await end(call.errand);
        return { id: call.id, ok: true, value: { ended: true } };
      }
      began = current(call.errand);
      began.calls.add(call.id);
      const value = redacted(await op(began, call), secrets);
      if (!live(began)) throw new StationError("NO_ERRAND", ENDED);
      return { id: call.id, ok: true, value };
    } catch (thrown) {
      const ended = began !== undefined && !live(began) && !(thrown instanceof StationError && thrown.code === "NO_ERRAND");
      return await failed(call.id, call.errand, "tab" in call && typeof call.tab === "number" ? call.tab : undefined, ended ? new StationError("NO_ERRAND", ENDED) : thrown, secrets);
    } finally {
      persist();
    }
  }

  async function failed(id: string, errand: string, tab: number | undefined, thrown: unknown, secrets: ReadonlySet<string>): Promise<Result> {
    const error = thrown instanceof StationError ? thrown : new StationError("PAGE_ERROR", thrown instanceof Error ? thrown.message : String(thrown));
    const pageCodes = ["NOT_FOUND", "AMBIGUOUS", "TIMEOUT", "PAGE_ERROR", "DOWNLOAD_FAILED", "REF_STALE"];
    const snapshot = pageCodes.includes(error.code) && !(error instanceof PageSilent) ? await snapshotOf(errands.get(errand), tab) : undefined;
    return { id, ok: false, error: redacted(new StationError(error.code, error.message, snapshot).toJSON(), secrets) };
  }

  async function info(pressed: Pressed): Promise<StationInfo> {
    return {
      unit: options.unit, version: options.version, slots, errands: [...errands.keys()], boot, running: [...running],
      pressed, allowing: await browser.allowing(), ...(sites.length === 0 ? {} : { withheld: await withheld() }), opened: opening.splice(0), acted: acting.splice(0),
      tabs: await browser.unnamedTabs(), ...(asked() ? { survey: true as const } : {}), ...(options.development === true ? { development: true as const } : {}),
    };
  }

  async function withheld(): Promise<string[]> {
    const held = await Promise.all(sites.map(async (site) => (await Promise.all(site.origins.map((origin) => browser.allowed(origin).catch(() => false)))).every(Boolean)));
    return sites.filter((_, at) => !held[at]).map((site) => site.id);
  }

  function asked(): boolean {
    const was = surveying;
    surveying = false;
    return was;
  }

  function tell(error: string | null, paired = true): void {
    options.report?.({
      at: now(),
      errands: [...errands.values()].map((one) => ({ id: one.id, name: one.spec.name, origins: [...one.origins] })),
      needs: [...(outdated === null ? [] : [outdated]), ...home],
      outdated: outdated !== null,
      sites,
      error,
      paired,
      held,
    });
  }

  return {
    handle,
    async opened(need) {
      if (!opening.includes(need.id)) opening.push(need.id);
      const told = stopped ? Promise.resolve() : new Promise<void>((resolve) => hearing.set(need.id, [...(hearing.get(need.id) ?? []), resolve]));
      inflight?.abort();
      const errand = need.at?.errand ?? null;
      const waits = errand === null ? undefined : errands.get(errand);
      const tab = waits === undefined ? undefined : [...waits.tabs].at(-1);
      const shown = tab === undefined ? false : await browser.show(tab);
      await told;
      return errand === null || shown;
    },
    async act(pressing) {
      acting.push(pressing);
      const told = stopped ? Promise.resolve() : new Promise<void>((resolve) => hearing.set(pressing.need, [...(hearing.get(pressing.need) ?? []), resolve]));
      inflight?.abort();
      await told;
    },
    survey() {
      surveying = true;
      inflight?.abort();
    },
    chose() {
      inflight?.abort();
    },
    granted() {
      inflight?.abort();
    },
    async tabOpened(source, tab) {
      await takenBack;
      const running = [...errands.values()].find((one) => one.tabs.has(source) || one.popups.has(source));
      if (running === undefined) return false;
      running.popups.add(tab);
      persist();
      await browser.adopt({ tab, errand: running.id, from: now(), until: running.ends_at });
      return true;
    },
    async serve(stop) {
      const serving = new AbortController();
      const signal = serving.signal;
      if (stop.aborted) serving.abort();
      else stop.addEventListener("abort", () => serving.abort(), { once: true });
      const results: Result[] = [];
      const queued = new Map<string, Promise<void>>();
      signal.addEventListener("abort", () => {
        stopped = true;
        heard([...hearing.keys()]);
        for (const running of errands.values()) clearTimeout(running.deadline);
      }, { once: true });
      await takeBack();

      async function exchange(): Promise<"answered" | "cut" | "failed"> {
        const exchanging = new AbortController();
        const stop = (): void => exchanging.abort();
        signal.addEventListener("abort", stop, { once: true });
        inflight = exchanging;
        const { chosen: before, pressed } = await browser.choice();
        const told = await info(pressed);
        const sending = results.splice(0);
        try {
          const answer = await link.exchange(told, sending, exchanging.signal);
          for (const result of sending) running.delete(result.id);
          outdated = null;
          if (options.development === true && await streak()) {
            reloadedBelow = false;
            await options.reloaded?.write(false).catch(() => undefined);
          }
          heard([...told.opened, ...told.acted.map((pressed) => pressed.need)]);
          await browser.tabsHeard(told.tabs).catch(() => undefined);
          answering = answer.home;
          held = options.generation !== undefined && tooOld(answer.home, options.generation);
          if (held) {
            home = [];
            sites = [];
            tell(null);
            for (const call of answer.calls) void handle(call).then(ready);
            return "answered";
          }
          home = answer.needs;
          sites = answer.sites;
          tell(null);
          if (answer.reload === true) {
            serving.abort();
            options.reload?.();
            return "answered";
          }
          for (const call of answer.calls) {
            if (running.has(call.id)) continue;
            running.add(call.id);
            run(call);
          }
          if (!(await browser.keep(answer.chosen, told.pressed).then(() => true, () => false))) return "failed";
          const turned = before === null ? [] : sites.filter((site) => answer.chosen.includes(site.id) && !before.includes(site.id) && !told.pressed.choose.includes(site.id));
          if (turned.length > 0) await browser.askAllow(turned).catch(() => undefined);
          return "answered";
        } catch (error) {
          results.unshift(...sending);
          opening.unshift(...told.opened.filter((id) => !opening.includes(id)));
          if (told.survey === true) surveying = true;
          heard(told.acted.map((pressed) => pressed.need));
          if (exchanging.signal.aborted && !signal.aborted) return "cut";
          heard(told.opened);
          if (error instanceof Superseded) {
            serving.abort();
            return "failed";
          }
          if (error instanceof BelowFloor) {
            outdated = ownNeed(`update:${options.unit}`, `Update the Lifestream extension: this is ${options.version}, Lifestream needs ${error.floor} or later`,
              { do: "chrome", label: "Open", url: "chrome://extensions/" }, null);
            if (options.development === true && !(await streak())) {
              reloadedBelow = true;
              await options.reloaded?.write(true).catch(() => undefined);
              options.reload?.();
            }
          }
          if (!signal.aborted) tell(error instanceof Error ? error.message : String(error), !(error instanceof PassRefused));
          return "failed";
        } finally {
          inflight = null;
          signal.removeEventListener("abort", stop);
        }
      }

      function ready(result: Result): void {
        results.push(result);
        inflight?.abort();
      }

      function run(call: Call): void {
        if (call.op === "end") {
          void handle(call).then(ready);
          return;
        }
        after(call.errand, () => handle(call));
      }

      function after(errand: string, answer: () => Promise<Result>): void {
        const done = (queued.get(errand) ?? Promise.resolve()).then(async () => {
          ready(await answer());
          if (queued.get(errand) === done) queued.delete(errand);
        });
        queued.set(errand, done);
      }

      for (let failures = 0; !signal.aborted; ) {
        if (options.updating?.() === true && errands.size === 0 && running.size === 0 && results.length === 0 && opening.length === 0 && acting.length === 0) {
          serving.abort();
          options.update?.();
          break;
        }
        if ((await exchange()) !== "failed") {
          failures = 0;
          continue;
        }
        if (signal.aborted) break;
        await sleep(Math.min(30_000, (options.retryMs ?? 500) * 2 ** ++failures));
      }
    },
  };
}
