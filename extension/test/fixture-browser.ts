import { Window } from "happy-dom";
import { createPageAgent, type PageAgent, type PageEnvelope } from "../page.js";
import type { Browser, SavedErrand } from "../station.js";
import { offlineOr } from "../chrome.js";
import type { StationTab } from "../wire.js";


export interface SiteRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface Site {
  readonly origin: string;
  readonly pages: Readonly<Record<string, string>>;
  readonly cors?: readonly string[];
  api?(request: SiteRequest): SiteAnswer | Promise<SiteAnswer>;
  submit?(path: string, values: Readonly<Record<string, string>>): string;
}

export type SiteAnswer = { status: number; body: string | Uint8Array } | undefined;

export interface Hushed {
  heard(): number;
  release(): void;
}

interface Tab {
  url: string;
  page: Window | null;
  agent: PageAgent | null;
  document: string | null;
  window: number;
  pending?: { url: string; looks: number };
}

export interface FixtureBrowser extends Browser {
  readonly windows: ReadonlySet<number>;
  readonly tabs: ReadonlySet<number>;
  readonly saved: () => readonly SavedErrand[];
  allow(origin: string): void;
  choose(...ids: string[]): void;
  unchoose(id: string): void;
  readonly setUp: () => string[];
  readonly kept: () => string[] | null;
  readonly allowAsked: string[];
  refuseKeeps(count: number): void;
  readonly refusedKeeps: () => number;
  answerAllow(id: string): void;
  reach(origin: string, reached: boolean): void;
  withdraw(origin: string): void;
  take(tab: number): void;
  stall(looks: number): void;
  hush(count: number): Hushed;
  beforeTarget(hook: (tab: number) => void | Promise<void>): void;
  afterTarget(hook: (tab: number) => void | Promise<void>): void;
  relocate(tab: number, url: string): void;
  fields(document: string): Record<string, string> | undefined;
  breakPage(tab: number): void;
  readonly shown: number[];
  write(tab: number, html: string): void;
  cookie(origin: string, name: string, value: string | null): void;
  noteUnnamed(tab: StationTab): void;
  opens(source: number, url: string): number;
  readonly adopted: number[];
  readonly unnamed: () => readonly StationTab[];
}

export function fixtureBrowser(sites: readonly Site[], options: { allowed?: readonly string[] } = {}): FixtureBrowser {
  const byOrigin = new Map(sites.map((site) => [site.origin, site]));
  const allowed = new Set(options.allowed ?? sites.map((site) => site.origin));
  const windows = new Set<number>();
  const tabs = new Map<number, Tab>();
  const shown: number[] = [];
  let kept: string[] | null = null;
  let pressed: { choose: string[]; stop: string[] } = { choose: [], stop: [] };
  let unnamed: StationTab[] = [];
  const allowAsked: string[] = [];
  const refusing = { left: 0, done: 0 };
  const allowStanding = new Set<string>();
  let ids = 100;
  const broken = new Set<number>();
  const unreached = new Set<string>();
  const jars = new Map<string, Map<string, string>>();
  let documents = 0;
  const left = new Map<string, Record<string, string>>();
  let stalling = 0;
  const hushing: { left: number; held: (() => void)[]; heard: number } = { left: 0, held: [], heard: 0 };
  const hooks: { before: ((tab: number) => void | Promise<void>) | null; after: ((tab: number) => void | Promise<void>) | null } = { before: null, after: null };
  const station = (): number | undefined => windows.values().next().value;

  const fieldsOf = (page: Window): Record<string, string> =>
    Object.fromEntries((Array.from(page.document.querySelectorAll("input[name], select[name], textarea[name]")) as unknown as HTMLInputElement[]).map((field) => [field.name, field.value]));

  const originOf = (url: string): string => {
    try {
      return new URL(url).origin;
    } catch {
      return "null";
    }
  };

  function load(id: number, url: string, now = false): void {
    const tab = tabs.get(id);
    if (tab === undefined) return;
    if (tab.page !== null && tab.document !== null) left.set(tab.document, fieldsOf(tab.page));
    void tab.page?.happyDOM.close();
    broken.delete(id);
    tab.page = null;
    tab.agent = null;
    tab.document = null;
    delete tab.pending;
    if (!now && url !== "about:blank" && stalling > 0) {
      tab.pending = { url, looks: stalling };
      stalling = 0;
      return;
    }
    tab.url = url;
    if (url === "about:blank") return;
    const parsed = new URL(url);
    const site = byOrigin.get(parsed.origin);
    const html = site?.pages[`${parsed.pathname}${parsed.search}`] ?? "<title>Not found</title><h1>Not found</h1>";
    const page = new Window({
      url,
      settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true, navigation: { disableMainFrameNavigation: true } },
    });
    page.document.write(html);
    for (const host of Array.from(page.document.querySelectorAll("[data-shadow]"))) {
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = host.innerHTML;
      host.innerHTML = "";
    }
    Object.defineProperty(page.document, "cookie", {
      configurable: true,
      get: () => [...(jars.get(parsed.origin) ?? new Map<string, string>())].map(([name, value]) => `${name}=${value}`).join("; "),
      set: () => undefined,
    });
    Object.assign(page, {
      fetch: async (input: string, init: RequestInit = {}): Promise<Response> => {
        const target = new URL(input, url);
        const reached = byOrigin.get(target.origin);
        if (reached === undefined || (target.origin !== parsed.origin && !(reached.cors ?? []).includes(parsed.origin))) throw new TypeError("Failed to fetch");
        const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]));
        const request: SiteRequest = { method: init.method ?? "GET", path: `${target.pathname}${target.search}`, headers };
        const signal = init.signal ?? undefined;
        const aborted = new Promise<never>((_, reject) => {
          const fail = (): void => reject(new DOMException("The operation was aborted.", "AbortError"));
          if (signal?.aborted === true) fail();
          else signal?.addEventListener("abort", fail, { once: true });
        });
        const answer = (await Promise.race([Promise.resolve(reached.api?.(typeof init.body === "string" ? { ...request, body: init.body } : request)), aborted])) ?? { status: 404, body: "{}" };
        if (answer.body === "reset:") throw new TypeError("Failed to fetch");
        const response = new Response(answer.body as BodyInit, { status: answer.status });
        const landed = typeof answer.body === "string" && answer.body.startsWith("redirect:") ? answer.body.slice("redirect:".length) : target.href;
        Object.defineProperty(response, "url", { value: landed });
        return response;
      },
    });
    page.document.addEventListener("click", (event) => {
      const element = (event.target as unknown as Element | null)?.closest?.("[data-goto], a[href], button[type='submit'], input[type='submit']");
      if (element === null || element === undefined) return;
      event.preventDefault();
      const goto = element.getAttribute("data-goto") ?? element.getAttribute("href");
      if (goto !== null) {
        setTimeout(() => load(id, new URL(goto, url).href), 5);
        return;
      }
      const form = element.closest("form");
      if (form === null || site?.submit === undefined) return;
      const values: Record<string, string> = {};
      for (const input of Array.from(form.querySelectorAll("input, select, textarea")) as HTMLInputElement[]) {
        if (input.name === "" || ((input.type === "radio" || input.type === "checkbox") && !input.checked)) continue;
        values[input.name] = input.value;
      }
      const next = site.submit(`${parsed.pathname}${parsed.search}`, values);
      setTimeout(() => load(id, new URL(next, url).href), 5);
    }, true);
    tab.page = page;
    tab.agent = createPageAgent(page as unknown as Parameters<typeof createPageAgent>[0]);
    tab.document = `document-${++documents}`;
  }

  const open = new Set<number>();
  let session: readonly SavedErrand[] = [];
  const adopted: number[] = [];

  return {
    windows,
    tabs: open,
    saved: () => session,
    allow: (origin) => void allowed.add(origin),
    withdraw: (origin) => void allowed.delete(origin),
    take(tab) {
      const held = tabs.get(tab);
      if (held !== undefined) held.window = ids++;
    },
    stall: (looks) => void (stalling = looks),
    hush(count) {
      hushing.left = count;
      hushing.heard = 0;
      return {
        heard: () => hushing.heard,
        release() {
          hushing.left = 0;
          for (const resume of hushing.held.splice(0)) resume();
        },
      };
    },
    beforeTarget: (hook) => void (hooks.before = hook),
    afterTarget: (hook) => void (hooks.after = hook),
    relocate(tab, url) {
      const held = tabs.get(tab);
      if (held?.page == null) throw new Error(`no page in tab ${tab} to relocate`);
      held.page.happyDOM.setURL(url);
      held.url = url;
    },
    fields(document) {
      const standing = [...tabs.values()].find((tab) => tab.document === document);
      return standing?.page != null ? fieldsOf(standing.page) : left.get(document);
    },
    breakPage: (tab) => void broken.add(tab),
    reach: (origin, reached) => void (reached ? unreached.delete(origin) : unreached.add(origin)),
    async save(errands) {
      session = structuredClone(errands);
    },
    async restore() {
      return structuredClone(session).map((errand) => ({ ...errand, tabs: errand.tabs.filter((tab) => open.has(tab)), popups: errand.popups.filter((tab) => open.has(tab)) }));
    },
    async openTab(url) {
      if (windows.size === 0) windows.add(ids++);
      const id = ids++;
      tabs.set(id, { url: "about:blank", page: null, agent: null, document: null, window: station()! });
      open.add(id);
      load(id, url);
      return id;
    },
    async closeTab(tab) {
      void tabs.get(tab)?.page?.happyDOM.close();
      tabs.delete(tab);
      open.delete(tab);
    },
    async navigate(tab, url) {
      load(tab, url);
    },
    async look(tab) {
      const held = tabs.get(tab);
      if (held === undefined) return { closed: true };
      if (held.window !== station()) return { taken: true };
      if (held.pending !== undefined) {
        if (held.pending.looks > 0) {
          held.pending.looks--;
          return { loading: true };
        }
        load(tab, held.pending.url, true);
      }
      return held.document === null ? { loading: true } : { url: held.url, document: held.document };
    },
    allowed: async (origin) => allowed.has(origin),
    async page(tab, document, call) {
      if (hushing.left > 0) {
        hushing.left--;
        hushing.heard++;
        await new Promise<void>((resume) => hushing.held.push(resume));
      }
      const before = hooks.before;
      hooks.before = null;
      await before?.(tab);
      const current = tabs.get(tab);
      const answer = async (): Promise<PageEnvelope> => {
        if (current === undefined || current.document !== document) return { ok: false, error: { code: "PAGE_ERROR", message: "the page changed under the call" } };
        if (broken.has(tab)) return { ok: false, error: { code: "PAGE_ERROR", message: "Frame with ID 0 is showing error page" } };
        if (current.agent === null || !allowed.has(originOf(current.url))) {
          return { ok: false, error: { code: "PAGE_ERROR", message: "Cannot access contents of the page" } };
        }
        const after = hooks.after;
        hooks.after = null;
        await after?.(tab);
        return current.agent.run(call);
      };
      return offlineOr(call, await answer(), async () => current !== undefined && unreached.has(originOf(current.url)));
    },
    choose: (...ids) => {
      pressed = { choose: [...new Set([...pressed.choose, ...ids])], stop: pressed.stop.filter((id) => !ids.includes(id)) };
    },
    unchoose: (id) => {
      pressed = { choose: pressed.choose.filter((each) => each !== id), stop: [...new Set([...pressed.stop, id])] };
    },
    setUp: () => [...new Set([...(kept ?? []), ...pressed.choose])].filter((id) => !pressed.stop.includes(id)),
    kept: () => kept,
    allowAsked,
    refuseKeeps: (count) => void (refusing.left = count),
    refusedKeeps: () => refusing.done,
    choice: async () => ({ chosen: kept === null ? null : [...kept], pressed: { choose: [...pressed.choose], stop: [...pressed.stop] } }),
    async keep(list, answered) {
      if (refusing.left > 0) {
        refusing.left--;
        refusing.done++;
        throw new Error("QUOTA_BYTES quota exceeded");
      }
      kept = [...list];
      pressed = { choose: pressed.choose.filter((id) => !answered.choose.includes(id)), stop: pressed.stop.filter((id) => !answered.stop.includes(id)) };
    },
    async askAllow(sites) {
      for (const site of sites) {
        if (site.origins.every((origin) => allowed.has(origin)) || allowStanding.has(site.id)) continue;
        allowAsked.push(site.id);
        allowStanding.add(site.id);
      }
    },
    noteUnnamed: (tab) => void unnamed.push(tab),
    opens(source, url) {
      if (!open.has(source)) throw new Error(`no tab ${source} to open a tab from`);
      const id = ids++;
      tabs.set(id, { url: "about:blank", page: null, agent: null, document: null, window: station()! });
      open.add(id);
      load(id, url);
      return id;
    },
    adopted,
    async adopt(claim) {
      adopted.push(claim.tab);
      unnamed.push(claim);
    },
    unnamed: () => unnamed,
    unnamedTabs: async () => [...unnamed],
    async tabsHeard(heard) {
      unnamed = unnamed.filter((one) => !heard.some((told) => told.tab === one.tab && told.from === one.from));
    },
    answerAllow: (id) => void allowStanding.delete(id),
    allowing: async () => [...allowStanding],
    shown,
    write(tab, html) {
      tabs.get(tab)?.page?.document.body.insertAdjacentHTML("beforeend", html);
    },
    cookie(origin, name, value) {
      const jar = jars.get(origin) ?? new Map<string, string>();
      jars.set(origin, jar);
      if (value === null) jar.delete(name);
      else jar.set(name, value);
    },
    async show(tab) {
      if (!open.has(tab)) return false;
      shown.push(tab);
      return true;
    },
  };
}
