import type { PageAnswers, PageCall, PageEnvelope } from "./page.js";
import { newPass, onThisMac, type Asked, type Connected } from "./link.js";
import { HELD, type Browser, type Look, type Report, type SavedErrand } from "./station.js";
import { ownNeed, StationError, type Need, type Pressed, type Site, type StationTab } from "./wire.js";


const ERRANDS_KEY = "lifestream.errands";
const WINDOW_KEY = "lifestream.window";
const TABS_KEY = "lifestream.tabs";
const SHOWN_KEY = "lifestream.shown";
const UNNAMED_KEY = "lifestream.unnamed";
const STARTED_KEY = "lifestream.started";
const UNNAMED_KEPT = 200;
const BLANK = "blank.html";
export async function needsNow(needs: readonly Need[], sites: readonly Site[]): Promise<Need[]> {
  const holds = async (origin: string): Promise<boolean> => (await withheld([sites.find((site) => site.origin === origin) ?? { origins: [origin] }])).length === 0;
  const allows = (need: Need): string | undefined => need.acts.flatMap((act) => (act.do === "allow" ? [act.origin] : []))[0];
  const left: Need[] = [];
  for (const need of needs) {
    const origin = allows(need);
    if (origin === undefined || !(await holds(origin))) left.push(need);
  }
  const picked = new Set(await chosen());
  for (const site of sites.filter((each) => picked.has(each.id))) {
    if ((await holds(site.origin)) || left.some((need) => allows(need) === site.origin)) continue;
    const host = new URL(site.origin).host;
    left.push(ownNeed(`allow:${site.origin}`, `Allow Lifestream on ${host}`, { do: "allow", label: "Allow", origin: site.origin }, host));
  }
  return left;
}

let forgotten = Promise.resolve();

export function forgetWindow(): void {
  // external: Chrome promises a window id only within one browser session, and local storage outlives it.
  forgotten = Promise.all([chrome.storage.local.remove([WINDOW_KEY, TABS_KEY, SHOWN_KEY]), chrome.storage.local.set({ [STARTED_KEY]: Date.now() })]).then(() => undefined);
}

export async function startWindow(): Promise<void> {
  // external: Chrome drops every extension as a profile's last window closes; the station's own window keeps the reads running.
  const { [PAIRING_KEY]: pairing } = await chrome.storage.local.get(PAIRING_KEY);
  if (pairing !== undefined && (await chosen()).length > 0) await ownWindow();
}

async function stationWindow(): Promise<number | undefined> {
  await forgotten;
  const id = (await chrome.storage.local.get(WINDOW_KEY))[WINDOW_KEY] as number | undefined;
  return id === undefined ? undefined : (await chrome.windows.get(id).catch(() => undefined))?.id;
}

async function ownTabs(): Promise<number[]> {
  await forgotten;
  return ((await chrome.storage.local.get(TABS_KEY))[TABS_KEY] as number[] | undefined) ?? [];
}

let noting = Promise.resolve();
function note(tab: number): Promise<void> {
  const noted = noting.then(async () => {
    const open = new Set((await chrome.tabs.query({})).map((one) => one.id));
    await chrome.storage.local.set({ [TABS_KEY]: [...(await ownTabs()).filter((one) => open.has(one)), tab] });
  });
  noting = noted.catch(() => undefined);
  return noted;
}

async function unnamed(): Promise<StationTab[]> {
  return ((await chrome.storage.local.get(UNNAMED_KEY))[UNNAMED_KEY] as StationTab[] | undefined) ?? [];
}

let naming = Promise.resolve();
function changeUnnamed(change: (tabs: StationTab[]) => StationTab[]): Promise<void> {
  const changed = naming.then(async () => chrome.storage.local.set({ [UNNAMED_KEY]: change(await unnamed()).slice(-UNNAMED_KEPT) }));
  naming = changed.catch(() => undefined);
  return changed;
}

const sameTab = (one: StationTab, other: StationTab): boolean => one.tab === other.tab && one.from === other.from;

function noteUnnamed(tabs: readonly StationTab[]): Promise<void> {
  return tabs.length === 0 ? Promise.resolve() : changeUnnamed((kept) => [...kept, ...tabs]);
}

let openings: Promise<unknown> = Promise.resolve();
function opensOwn(open: () => Promise<chrome.tabs.Tab>): Promise<chrome.tabs.Tab> {
  const opened = open().then(async (tab) => {
    if (tab?.id !== undefined) await note(tab.id);
    return tab;
  });
  openings = Promise.all([openings, opened.catch(() => undefined)]).then(() => undefined);
  return opened;
}

let making: Promise<unknown> = Promise.resolve();

function ownWindow(): Promise<number> {
  const next = making.then(async () => {
    const kept = await stationWindow();
    if (kept !== undefined) return kept;
    const made = await chrome.windows.create({ url: "about:blank", focused: false, state: "minimized" });
    if (made?.id === undefined) throw new StationError("PAGE_ERROR", "Chrome made no window");
    const first = made.tabs?.[0]?.id;
    if (first !== undefined) await note(first);
    await chrome.storage.local.set({ [WINDOW_KEY]: made.id });
    // external: Chrome on macOS shows a window as it makes it, minimized or not, in front of the person's though unfocused (measured 31 Oct 2026).
    await chrome.windows.update(made.id, { state: "minimized" }).catch(() => undefined);
    if (first !== undefined) await chrome.tabs.update(first, { url: BLANK }).catch(() => undefined);
    return made.id;
  });
  making = next.catch(() => undefined);
  return next;
}

async function blankTabs(): Promise<Set<number>> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.TAB], documentUrls: [chrome.runtime.getURL(BLANK)] });
  return new Set(contexts.map((one) => one.tabId));
}

export async function leaveBlank(): Promise<void> {
  const window = await stationWindow();
  if (window !== undefined) await opensOwn(() => chrome.tabs.create({ windowId: window, url: "about:blank", active: false })).catch(() => undefined);
}

let judging: Promise<unknown> = Promise.resolve();
function inJudgement<T>(judge: () => Promise<T>): Promise<T> {
  const judged = judging.then(judge);
  judging = judged.catch(() => undefined);
  return judged;
}

async function needShown(window: number): Promise<boolean> {
  const shown = (await chrome.storage.local.get(SHOWN_KEY))[SHOWN_KEY] as number | undefined;
  return shown !== undefined && (await chrome.tabs.get(shown).catch(() => undefined))?.windowId === window;
}

async function personsTabsIn(window: number): Promise<number[]> {
  await openings;
  const [held, own, blank] = await Promise.all([chrome.tabs.query({ windowId: window }).catch(() => []), ownTabs(), blankTabs()]);
  return held.flatMap((tab) => (tab.id === undefined || own.includes(tab.id) || blank.has(tab.id) ? [] : [tab.id]));
}

async function giveUp(window: number, bring: boolean): Promise<void> {
  await chrome.storage.local.remove([WINDOW_KEY, SHOWN_KEY]);
  const held = await chrome.windows.get(window, { populate: true }).catch(() => undefined);
  if (held === undefined) return;
  const [own, blank] = await Promise.all([ownTabs(), blankTabs()]);
  const ids = (held.tabs ?? []).flatMap((tab) => (tab.id === undefined ? [] : [tab.id]));
  const errands = ids.filter((tab) => own.includes(tab) && !blank.has(tab));
  if (ids.every((tab) => own.includes(tab) || blank.has(tab))) await chrome.tabs.create({ windowId: window, active: true }).catch(() => undefined);
  await chrome.tabs.remove(ids.filter((tab) => blank.has(tab))).catch(() => undefined);
  if (bring && held.state === "minimized") await chrome.windows.update(window, { state: "normal", focused: true }).catch(() => undefined);
  if (errands.length > 0) await chrome.tabs.move(errands, { windowId: await ownWindow(), index: -1 }).catch(() => undefined);
}

function judgeTabs(bring: boolean): Promise<void> {
  return inJudgement(async () => {
    const window = await stationWindow();
    if (window === undefined || (await needShown(window))) return;
    if ((await personsTabsIn(window)).length > 0) await giveUp(window, bring);
  });
}

let adoptions: Promise<unknown> = Promise.resolve();

export function adopting(deciding: Promise<unknown>): void {
  adoptions = Promise.all([adoptions, deciding.catch(() => undefined)]);
}

export async function tabNavigating(tab: number): Promise<void> {
  const window = await stationWindow();
  if (window === undefined || (await chrome.tabs.get(tab).catch(() => undefined))?.windowId !== window) return;
  await adoptions;
  await judgeTabs(true);
}

export function windowFocused(focused: number): Promise<void> {
  // external: Chrome focuses a window only for the person or for windows.update; with only the station's window open, a Dock click focuses it and a link from another app lands in it (measured 31 Oct 2026).
  return inJudgement(async () => {
    const window = await stationWindow();
    if (focused !== window || (await needShown(window))) return;
    if ((await chrome.windows.get(window).catch(() => undefined))?.state !== "minimized") await giveUp(window, false);
  });
}

export async function pastBlank(tab: chrome.tabs.Tab | undefined): Promise<void> {
  const now = tab?.id === undefined ? undefined : await chrome.tabs.get(tab.id).catch(() => undefined);
  if (now?.id === undefined || now.windowId === (await stationWindow())) return;
  const [all, held, own] = await Promise.all([chrome.windows.getAll(), chrome.windows.get(now.windowId, { populate: true }), ownTabs()]);
  const others = (held.tabs ?? []).flatMap((one) => (one.id === undefined || one.id === now.id ? [] : [one.id]));
  const only = all.length === 1;
  if (!others.some((one) => own.includes(one)) && (now.active || only)) {
    const at = Date.now();
    const started = (await chrome.storage.local.get(STARTED_KEY))[STARTED_KEY] as number | undefined;
    const from = started !== undefined && started <= at ? started : at;
    await noteUnnamed(others.map((one) => ({ tab: one, errand: null, from, until: at })));
    if (now.active && !only) return void (await chrome.windows.remove(now.windowId).catch(() => undefined));
    if (now.active) {
      if (others.length > 0) await chrome.tabs.remove(others).catch(() => undefined);
      return void (await chrome.tabs.update(now.id, { url: "about:blank" }).catch(() => undefined));
    }
  }
  if (only && others.length === 0) await chrome.tabs.update(now.id, { url: "about:blank" }).catch(() => undefined);
  else await chrome.tabs.remove(now.id).catch(() => undefined);
}

export async function personsTab(tab: chrome.tabs.Tab): Promise<boolean> {
  return tab.windowId !== (await stationWindow());
}

export const PAIRING_KEY = "lifestream.pairing";

export const UNIT_KEY = "lifestream.unit";

export const STATUS_KEY = "lifestream.status";
export type Status = Report & { readonly home: string };

export const CONNECT_KEY = "lifestream.connect";

export const CONNECT_WORDS = {
  waiting: "Allow it in Lifestream on this Mac.",
  absent: "Open Lifestream on this Mac.",
} as const;

export const askedLine = (asked: Asked | undefined): string => (asked === undefined ? CONNECT_WORDS.absent : typeof asked === "string" ? CONNECT_WORDS[asked] : asked.says);

export const NOT_PAIRED = "Not connected to Lifestream";

export function whereOf(door: string): string {
  return onThisMac(door) ? "this Mac" : new URL(door).hostname;
}

export interface Link {
  readonly signal: "engaged" | "idle" | "loading" | "warning";
  readonly word: string;
  readonly where?: string;
  readonly then?: string;
  readonly paired: boolean;
}

export const CONNECTING_MS = 5_000;

export async function link(waited_ms = 0): Promise<Link> {
  const pairing = (await chrome.storage.local.get(PAIRING_KEY))[PAIRING_KEY] as { url: string } | undefined;
  if (pairing === undefined) {
    const asked = (await chrome.storage.session.get(CONNECT_KEY))[CONNECT_KEY] as Asked | undefined;
    return asked === "waiting"
      ? { signal: "loading", word: "Connecting", where: "This Mac", then: askedLine(asked), paired: false }
      : { signal: "idle", word: "Not connected", then: askedLine(asked), paired: false };
  }
  const where = whereOf(pairing.url);
  const place = onThisMac(pairing.url) ? "This Mac" : where;
  const status = (await chrome.storage.session.get(STATUS_KEY))[STATUS_KEY] as Status | undefined;
  if (status === undefined) {
    if (waited_ms < CONNECTING_MS) return { signal: "loading", word: "Connecting", where: place, paired: true };
    return { signal: "warning", word: "Can't reach Lifestream", then: onThisMac(pairing.url) ? `Lifestream isn't answering. ${CONNECT_WORDS.absent}` : `Lifestream on ${where} isn't answering. Check that it is running.`, paired: true };
  }
  if (status.paired === false) {
    const asked = onThisMac(pairing.url) ? (await chrome.storage.session.get(CONNECT_KEY))[CONNECT_KEY] as Asked | undefined : undefined;
    if (asked === "waiting") return { signal: "loading", word: "Connecting", where: "This Mac", then: askedLine(asked), paired: true };
    if (typeof asked === "object") return { signal: "idle", word: "Not connected", then: askedLine(asked), paired: true };
    const back = onThisMac(pairing.url) ? "remove the extension and add it again" : "pair it again in the extension's settings";
    return { signal: "idle", word: "Not connected", then: `Lifestream on ${where} doesn't know this browser now: ${back}.`, paired: true };
  }
  if (status.error !== null) return { signal: "warning", word: "Can't reach Lifestream", then: onThisMac(pairing.url) ? CONNECT_WORDS.absent : `Lifestream on ${where} doesn't answer.`, paired: true };
  if (status.held) return { signal: "warning", word: "Waiting for Lifestream", where: place, then: HELD, paired: true };
  return { signal: "engaged", word: "Connected", where: place, paired: true };
}

export async function askingPass(): Promise<string> {
  const kept = (await chrome.storage.local.get(ASKING_KEY))[ASKING_KEY] as string | undefined;
  if (kept !== undefined) return kept;
  const made = newPass();
  await chrome.storage.local.set({ [ASKING_KEY]: made });
  return made;
}
const ASKING_KEY = "lifestream.asking";

export async function connected(answer: Connected): Promise<void> {
  await chrome.storage.local.set({ [UNIT_KEY]: answer.unit, [PAIRING_KEY]: answer.pairing });
  await chrome.storage.local.remove(ASKING_KEY);
}

export function setUpOrigins(site: Pick<Site, "origins">): string[] {
  return site.origins.map((origin) => `${origin}/*`);
}

export async function withheld(sites: readonly Pick<Site, "origins">[]): Promise<string[]> {
  const hosts = [...new Set(sites.flatMap(setUpOrigins))];
  const held = await Promise.all(hosts.map((host) => chrome.permissions.contains({ origins: [host] }).catch(() => false)));
  return hosts.filter((_, n) => !held[n]);
}

export function askFor(hosts: readonly string[]): Promise<boolean> {
  return hosts.length === 0 ? Promise.resolve(true) : chrome.permissions.request({ origins: [...hosts] });
}

export function landsOn(sites: readonly Site[], url: string): boolean {
  if (!URL.canParse(url)) return false;
  const origin = new URL(url).origin;
  return sites.some((site) => site.origins.includes(origin));
}

export async function stationUnit(): Promise<string> {
  const stored = (await chrome.storage.local.get(UNIT_KEY))[UNIT_KEY] as string | undefined;
  if (stored !== undefined) return stored;
  const minted = `chrome-${Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  await chrome.storage.local.set({ [UNIT_KEY]: minted });
  return minted;
}

export async function keepUnit(unit: string): Promise<void> {
  await chrome.storage.local.set({ [UNIT_KEY]: unit });
}

export const CHOSEN_KEY = "lifestream.home-chosen";
export const PRESSED_KEY = "lifestream.pressed";

async function choiceOf(): Promise<{ chosen: string[] | null; pressed: Pressed }> {
  const held = await chrome.storage.local.get([CHOSEN_KEY, PRESSED_KEY]);
  return { chosen: (held[CHOSEN_KEY] as string[] | undefined) ?? null, pressed: (held[PRESSED_KEY] as Pressed | undefined) ?? { choose: [], stop: [] } };
}

export async function chosen(): Promise<string[]> {
  const { chosen: kept, pressed } = await choiceOf();
  return [...new Set([...(kept ?? []), ...pressed.choose])].filter((id) => !pressed.stop.includes(id));
}

export function choose(ids: readonly string[], stopped: readonly string[] = []): Promise<void> {
  return inTurn(async () => {
    const { pressed } = await choiceOf();
    const choose = [...new Set([...pressed.choose.filter((id) => !stopped.includes(id)), ...ids])];
    const stop = [...new Set([...pressed.stop.filter((id) => !ids.includes(id)), ...stopped])];
    await chrome.storage.local.set({ [PRESSED_KEY]: { choose, stop } satisfies Pressed });
  });
}

function keep(list: readonly string[], answered: Pressed): Promise<void> {
  return inTurn(async () => {
    const { pressed } = await choiceOf();
    const left: Pressed = { choose: pressed.choose.filter((id) => !answered.choose.includes(id)), stop: pressed.stop.filter((id) => !answered.stop.includes(id)) };
    await chrome.storage.local.set({ [CHOSEN_KEY]: [...list], [PRESSED_KEY]: left });
  });
}

let choosing = Promise.resolve();
function inTurn(write: () => Promise<void>): Promise<void> {
  const done = choosing.then(write);
  choosing = done.catch(() => undefined);
  return done;
}

const ALLOW = "allow.html";
export const allowPage = (site: Pick<Site, "id">): string => `${ALLOW}?site=${encodeURIComponent(site.id)}`;

async function personsWindow(): Promise<number | undefined> {
  const own = await stationWindow();
  const last = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => undefined);
  if (last?.id !== undefined && last.id !== own) return last.id;
  return (await chrome.windows.getAll({ windowTypes: ["normal"] })).find((window) => window.id !== own)?.id;
}

function loaded(tab: number, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id: number, change: chrome.tabs.OnUpdatedInfo): void => {
      if (id === tab && change.status === "complete") done();
    };
    const timer = setTimeout(done, ms);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tab).then((current) => {
      if (current.status === "complete" && current.url !== undefined && current.url !== "about:blank") done();
    }, done);
  });
}

function topFrame(tab: number): Promise<chrome.webNavigation.GetFrameResultDetails | null> {
  return chrome.webNavigation.getFrame({ tabId: tab, frameId: 0 }).then((frame) => frame ?? null, () => null);
}

function look(tab: number): Promise<Look> {
  return inJudgement(async (): Promise<Look> => {
    const held = await chrome.tabs.get(tab).catch(() => undefined);
    if (held === undefined) return { closed: true };
    if (held.windowId !== (await stationWindow())) return { taken: true };
    const frame = await topFrame(tab);
    if (frame === null || frame.url === "about:blank") return { loading: true };
    return { url: frame.url, document: frame.documentId };
  });
}

const ACTS: ReadonlySet<string> = new Set(["click", "fill", "select"]);

async function pageCall(tab: number, document: string, call: PageCall): Promise<PageEnvelope> {
  const target = { tabId: tab, documentIds: [document] };
  const changed: PageEnvelope = { ok: false, error: { code: "PAGE_ERROR", message: "the page changed under the call" } };
  const elsewhere = (results: readonly chrome.scripting.InjectionResult[]): boolean => results.some((one) => one.documentId !== document);
  try {
    const present = await chrome.scripting.executeScript({ target, func: () => globalThis.__lifestreamPage !== undefined });
    if (elsewhere(present)) return changed;
    if (present[0]?.result !== true && elsewhere(await chrome.scripting.executeScript({ target, files: ["page.js"] }))) return changed;
    const ran = await chrome.scripting.executeScript({
      target,
      func: (sent: PageCall) => (globalThis.__lifestreamPage as NonNullable<typeof globalThis.__lifestreamPage>).run(sent),
      args: [call],
    });
    if (elsewhere(ran)) {
      const answered = ran[0]?.result as PageEnvelope | undefined;
      if (answered !== undefined && !answered.ok && answered.error.code === "ORIGIN_REFUSED") return answered;
      return ACTS.has(call.op) ? { ok: false, error: { code: "INTERRUPTED", message: "the page changed under the act: whether it ran is not known" } } : changed;
    }
    return (ran[0]?.result as PageEnvelope | undefined) ?? { ok: false, error: { code: "PAGE_ERROR", message: "the page gave no answer" } };
  } catch (error) {
    if ((await topFrame(tab))?.documentId !== document) return changed;
    return { ok: false, error: { code: "PAGE_ERROR", message: error instanceof Error ? error.message : String(error) } };
  }
}

const REACH_MS = 5_000;

export async function offlineOr(call: PageCall, answer: PageEnvelope, unreachable: () => Promise<boolean>): Promise<PageEnvelope> {
  const error = !answer.ok ? answer.error : call.op === "fetch" ? (answer.value as PageAnswers["fetch"]).error : undefined;
  if (error?.code !== "PAGE_ERROR" || !(await unreachable())) return answer;
  return { ok: false, error: { code: "OFFLINE", message: `Chrome cannot reach the site: ${error.message}` } };
}

async function unreachable(tab: number): Promise<boolean> {
  const url = (await chrome.tabs.get(tab).catch(() => undefined))?.url;
  if (url === undefined || !/^https?:/u.test(url)) return false;
  try {
    await fetch(`${new URL(url).origin}/`, { method: "HEAD", mode: "no-cors", cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(REACH_MS) });
    return false;
  } catch {
    return true;
  }
}

export function chromeBrowser(): Browser {
  let closing = Promise.resolve();

  async function hide(): Promise<void> {
    await judgeTabs(false);
    const window = await stationWindow();
    const shown = window === undefined ? undefined : await chrome.windows.get(window, { populate: true }).catch(() => undefined);
    if (shown?.id === undefined || shown.state === "minimized") return;
    const front = shown.tabs?.find((tab) => tab.active)?.id;
    if (front !== undefined && !(await blankTabs()).has(front)) return;
    await chrome.windows.update(shown.id, { state: "minimized" }).catch(() => undefined);
  }

  async function close(tab: number): Promise<void> {
    const window = await stationWindow();
    const closing = await chrome.tabs.get(tab).catch(() => undefined);
    const needOver = (await chrome.storage.local.get(SHOWN_KEY))[SHOWN_KEY] === tab;
    if (needOver) await chrome.storage.local.remove(SHOWN_KEY);
    if (closing !== undefined && closing.windowId !== window && (await chrome.windows.get(closing.windowId).catch(() => undefined))?.type === "popup") {
      await chrome.tabs.remove(tab).catch(() => undefined);
      return;
    }
    if (window === undefined || closing?.windowId !== window) return;
    if (needOver && (await personsTabsIn(window)).length === 0) await chrome.windows.update(window, { state: "minimized" }).catch(() => undefined);
    if ((await chrome.tabs.query({ windowId: window }).catch(() => [])).length === 1) {
      await chrome.tabs.update(tab, { url: BLANK }).catch(() => undefined);
      return;
    }
    await chrome.tabs.remove(tab).catch(() => undefined);
  }

  async function askToAllow(site: Site): Promise<void> {
    if ((await standing()).has(site.id)) return;
    const url = chrome.runtime.getURL(allowPage(site));
    const window = await personsWindow();
    if (window === undefined) {
      await chrome.windows.create({ url, focused: true });
      return;
    }
    await chrome.tabs.create({ windowId: window, url, active: true });
    await chrome.windows.update(window, { focused: true });
  }

  async function standing(): Promise<Set<string>> {
    const sites = new Set<string>();
    const page = chrome.runtime.getURL(`${ALLOW}?site=`);
    for (const context of await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.TAB] })) {
      if (context.documentUrl?.startsWith(page) === true) sites.add(decodeURIComponent(context.documentUrl.slice(page.length)));
    }
    return sites;
  }

  const browser: Browser = {
    async openTab(url, ms) {
      let tab: chrome.tabs.Tab | undefined;
      const opening = (): Promise<chrome.tabs.Tab> => opensOwn(async () => chrome.tabs.create({ windowId: await ownWindow(), url, active: false }));
      try {
        tab = await opening();
      } catch (error) {
        if (error instanceof StationError) throw error;
        tab = await opening();
      }
      if (tab?.id === undefined) throw new StationError("PAGE_ERROR", "Chrome made no tab");
      await judging;
      if (tab.windowId !== (await stationWindow())) await chrome.tabs.move(tab.id, { windowId: await ownWindow(), index: -1 });
      await loaded(tab.id, ms);
      await hide();
      return tab.id;
    },
    closeTab(tab) {
      const closed = closing.then(() => inJudgement(() => close(tab))).then(hide);
      closing = closed.catch(() => undefined);
      return closed;
    },
    async navigate(tab, url, ms) {
      await chrome.tabs.update(tab, { url });
      if (url !== "about:blank") await loaded(tab, ms);
    },
    look,
    allowed: (origin) => chrome.permissions.contains({ origins: [`${origin}/*`] }),
    page: async (tab, document, call: PageCall): Promise<PageEnvelope> => offlineOr(call, await pageCall(tab, document, call), () => unreachable(tab)),
    // external: chrome.storage.session is read only by the extension's own pages and worker, and is gone with the browser.
    save: (errands) => chrome.storage.session.set({ [ERRANDS_KEY]: errands }),
    async restore() {
      const saved = ((await chrome.storage.session.get(ERRANDS_KEY))[ERRANDS_KEY] as SavedErrand[] | undefined) ?? [];
      const shown = (await chrome.storage.local.get(SHOWN_KEY))[SHOWN_KEY] as number | undefined;
      if (shown !== undefined && !saved.some((errand) => errand.tabs.includes(shown))) await chrome.storage.local.remove(SHOWN_KEY);
      await judgeTabs(false);
      const window = await stationWindow();
      const held = window === undefined ? [] : (await chrome.tabs.query({ windowId: window }).catch(() => [])).flatMap((tab) => (tab.id === undefined ? [] : [tab.id]));
      const owned = new Set(saved.flatMap((errand) => [...errand.tabs, ...errand.popups]).filter((tab) => held.includes(tab)));
      const blank = await blankTabs();
      const persons = window === undefined ? [] : await personsTabsIn(window);
      const loose = held.filter((tab) => !owned.has(tab) && !persons.includes(tab)).sort((one, other) => Number(blank.has(other)) - Number(blank.has(one)));
      const kept = loose.shift();
      if (kept !== undefined && !blank.has(kept)) await chrome.tabs.update(kept, { url: BLANK }).catch(() => undefined);
      await Promise.all(loose.map((tab) => chrome.tabs.remove(tab).catch(() => undefined)));
      const standing = new Set((await chrome.tabs.query({})).flatMap((tab) => (tab.id === undefined ? [] : [tab.id])));
      const popup = (tab: number): boolean => owned.has(tab) || (standing.has(tab) && !held.includes(tab));
      return saved.map((errand) => ({ ...errand, tabs: errand.tabs.filter((tab) => owned.has(tab)), popups: errand.popups.filter(popup) }));
    },
    choice: choiceOf,
    keep,
    async adopt(claim) {
      await note(claim.tab);
      await noteUnnamed([claim]);
      const made = await chrome.tabs.get(claim.tab).catch(() => undefined);
      const window = await stationWindow();
      if (made === undefined || made.windowId === window || (window !== undefined && (await needShown(window)))) return;
      if ((await chrome.windows.get(made.windowId).catch(() => undefined))?.type === "popup") {
        await chrome.windows.update(made.windowId, { state: "minimized", focused: false }).catch(() => undefined);
      }
    },
    unnamedTabs: unnamed,
    tabsHeard: (heard) => changeUnnamed((kept) => kept.filter((one) => !heard.some((told) => sameTab(told, one)))),
    async askAllow(sites) {
      for (const site of sites) {
        if ((await withheld([site])).length > 0) await askToAllow(site).catch(() => undefined);
      }
    },
    allowing: async () => [...(await standing())],
    async show(tab) {
      const showing = await chrome.tabs.get(tab).catch(() => undefined);
      if (showing?.windowId === undefined) return false;
      await chrome.storage.local.set({ [SHOWN_KEY]: tab });
      const blank = await blankTabs();
      const parked = (await chrome.tabs.query({ windowId: showing.windowId })).flatMap((one) => (one.id !== undefined && blank.has(one.id) ? [one.id] : []));
      await chrome.tabs.remove(parked).catch(() => undefined);
      await chrome.windows.update(showing.windowId, { state: "normal", focused: true });
      await chrome.tabs.update(tab, { active: true });
      return true;
    },
  };
  return browser;
}
