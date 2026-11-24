import {
  adopting, askingPass, choose, chromeBrowser, CHOSEN_KEY, CONNECT_KEY, connected, forgetWindow, landsOn, leaveBlank, needsNow, NOT_PAIRED, PAIRING_KEY, pastBlank, personsTab,
  PRESSED_KEY, startWindow, STATUS_KEY, stationUnit, tabNavigating, windowFocused, type Status,
} from "./chrome.js";
import { ask, httpLink, onThisMac, type Pairing } from "./link.js";
import { idsOf, needOf, pressingOf, sentBy } from "./senders.js";
import { createStation, type Report, type Station } from "./station.js";


declare const LIFESTREAM_DEVELOPMENT: boolean;
declare const LIFESTREAM_GENERATION: number | null;
declare const LIFESTREAM_DOOR: string;
declare const LIFESTREAM_BADGE: { readonly background: string; readonly text: string };
const ASK_MS = 2_000;
const ASKING_MS = 60_000;
const SIGNED_MS = 10_000;

const closed: Promise<void> = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).then(() => undefined, (error: unknown) => {
  console.error("Lifestream: Chrome did not close local storage to content scripts, so the station does not serve", error);
  return new Promise<void>(() => undefined);
});
const afterClosed = <A extends unknown[]>(work: (...args: A) => unknown) => (...args: A): void => void closed.then(() => work(...args));

const browser = chromeBrowser();
interface Serving {
  readonly controller: AbortController;
  readonly station: Promise<Station | null>;
}

let serving: Serving | null = null;
let updating = false;
let looked = false;
const RELOADED_KEY = "lifestream.reloaded-below-floor";
let askingUntil = 0;
let refusedHere = false;
let againAsking = false;
let signedAsked = 0;
let signedLater: ReturnType<typeof setTimeout> | undefined;

let counting = 0;

async function badge(): Promise<void> {
  const mine = ++counting;
  await closed;
  const status = (await chrome.storage.session.get(STATUS_KEY))[STATUS_KEY] as Status | undefined;
  const count = (await needsNow(status?.needs ?? [], status?.sites ?? [])).length;
  if (mine !== counting) return;
  await chrome.action.setBadgeBackgroundColor({ color: LIFESTREAM_BADGE.background });
  await chrome.action.setBadgeTextColor({ color: LIFESTREAM_BADGE.text });
  await chrome.action.setBadgeText({ text: count === 0 ? "" : String(count) });
}

function reported(state: Report, home: string): void {
  refusedHere = !state.paired && onThisMac(home);
  if (refusedHere) void again();
  if (!looked && state.outdated) {
    looked = true;
    void chrome.runtime.requestUpdateCheck().catch(() => undefined);
  }
  void chrome.storage.session.set({ [STATUS_KEY]: { ...state, home } satisfies Status }).then(badge);
}

function reload(): void {
  void leaveBlank().finally(() => chrome.runtime.reload());
}

function start(theirs = true): Serving {
  if (theirs) askingUntil = Date.now() + ASKING_MS;
  if (serving !== null) {
    if (theirs && refusedHere) void again();
    return serving;
  }
  const controller = new AbortController();
  let made: (station: Station | null) => void = () => undefined;
  const running: Serving = { controller, station: new Promise((resolve) => (made = resolve)) };
  serving = running;
  void serve(controller.signal, made).finally(() => {
    made(null);
    if (serving === running) serving = null;
  });
  return running;
}

async function serve(signal: AbortSignal, made: (station: Station | null) => void): Promise<void> {
  await closed;
  const paired = (await chrome.storage.local.get(PAIRING_KEY))[PAIRING_KEY] as Pairing | undefined;
  if (paired === undefined) return connect(signal);
  const version = chrome.runtime.getManifest().version;
  const unit = await stationUnit();
  if (signal.aborted) return;
  const station = createStation({
    browser,
    link: httpLink(paired, { version, before: () => chrome.runtime.getPlatformInfo() }),
    unit,
    version,
    report: (state) => reported(state, paired.url),
    reload: () => {
      if (LIFESTREAM_DEVELOPMENT) reload();
    },
    reloaded: {
      read: async () => (await chrome.storage.local.get(RELOADED_KEY))[RELOADED_KEY] === true,
      write: (reloaded) => (reloaded ? chrome.storage.local.set({ [RELOADED_KEY]: true }) : chrome.storage.local.remove(RELOADED_KEY)),
    },
    development: LIFESTREAM_DEVELOPMENT,
    updating: () => updating,
    update: reload,
    ...(LIFESTREAM_GENERATION === null ? {} : { generation: LIFESTREAM_GENERATION }),
  });
  made(station);
  await station.serve(signal);
}

async function connect(signal: AbortSignal): Promise<void> {
  await asking(LIFESTREAM_DOOR, await askingPass(), signal);
}

async function again(): Promise<void> {
  const running = serving;
  if (againAsking || running === null) return;
  againAsking = true;
  try {
    const paired = (await chrome.storage.local.get(PAIRING_KEY))[PAIRING_KEY] as Pairing | undefined;
    if (paired === undefined || !onThisMac(paired.url)) return;
    if (await asking(paired.url, paired.pass, running.controller.signal) && serving === running) restart();
  } finally {
    againAsking = false;
  }
}

async function asking(door: string, pass: string, signal: AbortSignal): Promise<boolean> {
  const unit = await stationUnit();
  const version = chrome.runtime.getManifest().version;
  while (!signal.aborted) {
    const answer = await ask(door, pass, unit, { version });
    if (signal.aborted) return false;
    if (typeof answer === "object" && "pairing" in answer) {
      await connected(answer);
      await chrome.storage.session.remove(CONNECT_KEY);
      return true;
    }
    await chrome.storage.session.set({ [CONNECT_KEY]: answer });
    if (answer === "absent" || (answer !== "waiting" && Date.now() >= askingUntil)) return false;
    await new Promise((resolve) => setTimeout(resolve, ASK_MS));
  }
  return false;
}

function restart(): void {
  serving?.controller.abort();
  serving = null;
  refusedHere = false;
  void chrome.storage.session.remove(STATUS_KEY).then(badge);
  start();
}

chrome.runtime.onMessage.addListener((message: { to?: unknown; blank?: unknown } | null, sender) => {
  if (!sentBy(sender, ["blank.html"]) || message?.to !== "worker" || message.blank !== true) return;
  start();
  void closed.then(() => pastBlank(sender.tab));
});
chrome.webNavigation.onCreatedNavigationTarget.addListener(({ sourceTabId, tabId }) => {
  adopting(start(false).station.then((station) => station?.tabOpened(sourceTabId, tabId)));
});
chrome.webNavigation.onBeforeNavigate.addListener(afterClosed(({ tabId, frameId }: { tabId: number; frameId: number }) => {
  if (frameId === 0) void tabNavigating(tabId);
}));
chrome.windows.onFocusChanged.addListener(afterClosed((window: number) => windowFocused(window)));
chrome.runtime.onMessage.addListener((message: { to?: unknown; opened?: unknown } | null, sender, answer) => {
  if (!sentBy(sender, ["popup.html"]) || message?.to !== "worker" || !("opened" in message)) return;
  const need = needOf(message.opened);
  if (need === null) return;
  void start().station.then(async (station) => {
    if (station === null) return answer({ ok: false, error: NOT_PAIRED });
    if (await station.opened(need)) return answer({ ok: true });
    return answer({ ok: false, error: "Its page is not open any more (Chrome closed it): Lifestream asks again at its next run" });
  }).catch((error: unknown) => answer({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});
chrome.runtime.onMessage.addListener((message: { to?: unknown; act?: unknown } | null, sender, answer) => {
  if (!sentBy(sender, ["popup.html"]) || message?.to !== "worker" || !("act" in message)) return;
  const pressing = pressingOf(message.act);
  if (pressing === null) return;
  void start().station.then(async (station) => {
    if (station === null) return answer({ ok: false, error: NOT_PAIRED });
    await station.act(pressing);
    return answer({ ok: true });
  }).catch((error: unknown) => answer({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});
chrome.runtime.onMessage.addListener((message: { to?: unknown; choose?: unknown; stop?: unknown } | null, sender, answer) => {
  if (!sentBy(sender, ["popup.html"]) || message?.to !== "worker") return;
  const [chose, stopped] = [idsOf(message.choose), idsOf(message.stop)];
  if (chose === null || stopped === null) return;
  void closed.then(() => choose(chose, stopped)).then(() => {
    answer({ ok: true });
    void start().station.then((station) => station?.chose());
  }, (error: unknown) => answer({ ok: false, error: `Chrome refused: ${error instanceof Error ? error.message : String(error)}` }));
  return true;
});
chrome.runtime.onMessage.addListener((message: { to?: unknown; survey?: unknown } | null, sender) => {
  if (!sentBy(sender, ["popup.html"]) || message?.to !== "worker" || message.survey !== true) return;
  void start().station.then((station) => station?.survey());
});
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  const url = tab.url;
  if (change.status !== "complete" || url === undefined) return;
  void closed.then(() => chrome.storage.session.get(STATUS_KEY)).then(async (stored) => {
    if (landsOn((stored[STATUS_KEY] as Status | undefined)?.sites ?? [], url) && await personsTab(tab)) askSigned();
  });
});

function askSigned(): void {
  if (signedLater !== undefined) return;
  const wait = signedAsked + SIGNED_MS - Date.now();
  if (wait > 0) {
    signedLater = setTimeout(() => {
      signedLater = undefined;
      askSigned();
    }, wait);
    return;
  }
  signedAsked = Date.now();
  void start().station.then((station) => station?.survey());
}
chrome.runtime.onUpdateAvailable.addListener(() => {
  updating = true;
  start();
});
const regranted = (): void => {
  void start().station.then((station) => station?.granted());
  void badge();
};
chrome.permissions.onAdded.addListener(regranted);
chrome.permissions.onRemoved.addListener(regranted);
chrome.runtime.onStartup.addListener(afterClosed(() => {
  forgetWindow();
  void startWindow();
  start();
}));
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== "chrome_update") start();
});
chrome.alarms.onAlarm.addListener(() => start(false));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && PAIRING_KEY in changes) restart();
  else if (!(area === "session" && CONNECT_KEY in changes)) start();
  if (area === "local" && (CHOSEN_KEY in changes || PRESSED_KEY in changes)) void badge();
});
void chrome.alarms.get("lifestream").then((alarm) => (alarm === undefined ? chrome.alarms.create("lifestream", { periodInMinutes: 0.5 }) : undefined));
