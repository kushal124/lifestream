// @ts-check
/** @import { HostState } from './lib/host.js' */
import { installDialogEdges, installPageHeads, setIcons, stopVoiceIn } from './ui/kit/index.js';
import { readHost } from './lib/host.js';
import { startRouter } from './ui/route.js';
import { footRoute, installSidebar, sidebarMarkup } from './ui/sections.js';
import { installHomeStrip } from './ui/home-strip.js';
import { installWindowBands } from './ui/window.js';
import { mountAsk } from './pages/ask.js';
import { mountDays } from './pages/days.js';
import { mountPeople } from './pages/people.js';
import { mountPlaces } from './pages/places.js';
import { mountSearch } from './pages/search.js';
import { mountConnectors } from './pages/connectors.js';
import { mountAgents } from './pages/agents.js';
import { mountOnboarding } from './pages/onboarding.js';
import { heldPeople, installHeld } from './lib/held.js';
import { photoOf } from './ui/people/list.js';
import { fetchAgents, fetchClock, fetchFeedbackDraft, fetchPage, readRecipe, sendFeedback, sendFeedbackShot } from './lib/api.js';
import { clockInFront, onClockChange, refreshClock } from './lib/home-clock.js';
import { followChats, heldChats, readChats } from './ui/ask/chats.js';
import { clockChanged, onHomeChange } from './ui/live.js';
import { reportReader } from './lib/report.js';
import { ownNeeds, readingPaused } from './ui/connectors/page.js';
import { forgetEnded, onDismissed } from './ui/connectors/dismissed.js';
import { flowOverlay } from './ui/flows/frame.js';
import { pageChanges } from './ui/connectors/changes.js';
import { streamDialogs } from './ui/connectors/layer.js';
import { installAgentCards } from './ui/agents/cards.js';
import { installTour } from './ui/tour.js';
import { finishItems } from './ui/finish.js';
import { FEEDBACK, installFeedback } from './ui/feedback.js';

const host = readHost(window);
onClockChange(clockChanged);
const readClock = () => refreshClock(fetchClock);
onHomeChange(change => {
  if (!change.reset) return;
  void readClock();
  void readRecipe();
});
void readClock();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) clockInFront();
});
installHeld();
const reports = reportReader(host);
const changes = pageChanges(host, reports);
const root = document.documentElement;
root.classList.toggle('hosted', host !== null);
setIcons(await (await fetch('icons.json')).json());

const app = /** @type {HTMLElement} */ (document.getElementById('app'));
app.className = 'app';
app.innerHTML = sidebarMarkup() + '<div class="app__edge" data-window-drag aria-hidden="true"></div>'
  + '<div class="column"><div id="home-strip" class="home-strip" data-window-drag hidden></div>'
  + '<main id="main" class="main" tabindex="-1"></main></div>';
app.insertAdjacentHTML('afterend', '<div id="dialog-layer"></div><div id="flow-layer"></div><div id="feedback-layer"></div>'
  + '<div id="agent-layer" class="agent-layer" hidden></div>');
installDialogEdges(document);
installPageHeads(document);
const homeBanner = installHomeStrip(/** @type {HTMLElement} */ (document.getElementById('home-strip')), host);
/** @param {boolean} on */
const inert = on => {
  for (const behind of document.querySelectorAll('.sidebar, .column')) /** @type {HTMLElement} */ (behind).inert = on;
};
const feedback = installFeedback(/** @type {HTMLElement} */ (document.getElementById('feedback-layer')), {
  page: () => fetchPage('feedback'),
  draft: fetchFeedbackDraft,
  shot: sendFeedbackShot,
  send: sendFeedback,
  mint: () => crypto.randomUUID(),
  picture: jpeg => URL.createObjectURL(new Blob([/** @type {BlobPart} */ (jpeg)], { type: 'image/jpeg' })),
  forget: url => URL.revokeObjectURL(url),
  host,
  behind: () => [...document.querySelectorAll('.sidebar, .column, #dialog-layer')],
  route: () => router.openDialog(FEEDBACK),
  closed: () => router.openDialog(''),
});
void feedback.read();
onHomeChange(change => {
  if (change.reset) void feedback.read();
});
const dialogs = streamDialogs(/** @type {HTMLElement} */ (document.getElementById('dialog-layer')), host, reports, changes, {
  routes: () => ({ dialog: id => router.openDialog(id), flow: id => id ? router.openFlow(id) : router.leaveFlow(),
    go: router.go, feedback: asked => feedback.open({ kind: 'connector', connector: asked.connector }, asked.name) }),
  inert,
});
const overlay = host ? flowOverlay(/** @type {HTMLElement} */ (document.getElementById('flow-layer')), host, reports, {
  leave: () => router.leaveFlow(),
  inert,
}) : null;
let carded = false;
let shownDialog = '';
const walk = installTour({ doc: document, host, covered: () => carded });
const router = startRouter({
  win: window,
  container: /** @type {HTMLElement} */ (document.getElementById('main')),
  pages: {
    ask: (container, context) => mountAsk(container, context, host, feedback), days: mountDays, people: mountPeople, places: mountPlaces, search: mountSearch,
    connectors: (container, context) => mountConnectors(container, context, host, reports, dialogs),
    agents: (container, context) => mountAgents(container, context, host, dialogs),
    onboarding: (container, context) => mountOnboarding(container, context, host, reports, changes),
  },
  dialogs: {
    show: id => {
      shownDialog = id;
      if (id !== FEEDBACK) {
        feedback.hide();
        return dialogs.show(id);
      }
      void feedback.show().then(() => {
        if (shownDialog === FEEDBACK) dialogs.show('');
      });
    },
    flow: id => dialogs.flow(id),
    leaves: () => dialogs.leaves(),
  },
  flows: id => overlay?.show(id),
  leaves: () => overlay?.leaves() ?? true,
  walk,
  left: stopVoiceIn,
});
const WARM_MS = 1_000;
const warmDays = () => {
  if (document.visibilityState === 'visible') router.warm('days');
  else document.addEventListener('visibilitychange', () => setTimeout(warmDays, WARM_MS), { once: true });
};
setTimeout(warmDays, WARM_MS);
const sidebar = installSidebar({ doc: document, router, host, feedback });
void readChats().catch(() => undefined);
onHomeChange(change => {
  if (change.reset || [...change.imports].some(source => source.startsWith('ask:'))) void readChats({ again: true }).catch(() => undefined);
});
router.follow(route => {
  const leaving = root.classList.contains('is-onboarding') && route.view !== 'onboarding';
  root.classList.toggle('is-onboarding', route.view === 'onboarding');
  if (leaving) root.classList.add('left-onboarding');
});
document.querySelector('.sidebar')?.addEventListener('animationend', event => {
  if (event.target === event.currentTarget) root.classList.remove('left-onboarding');
});
/** @param {Awaited<ReturnType<typeof heldPeople.get>>} list */
const drawYou = list => sidebar.you(list.you ? { id: list.you.id, name: list.you.name, photo: photoOf(list.you) } : null);
let shownView = '';
/** @param {boolean} opened */
function askYou(opened) {
  if (!shownView || shownView === 'onboarding' || document.hidden || (!opened && shownView === 'people')) return;
  void heldPeople.get().then(drawYou, () => undefined);
}
heldPeople.follow(list => (list ? drawYou(list) : askYou(false)));
router.follow(route => {
  shownView = route.view;
  askYou(true);
});
document.addEventListener('visibilitychange', () => {
  if (!heldPeople.now()) askYou(false);
});

let agentIn = false;
const readAgentIn = () => {
  if (!host || agentIn) return;
  void fetchAgents().then((/** @type {import('./types.js').AgentsList} */ read) => {
    agentIn = read.readers.some(each => each.kind !== 'chat' && each.state === 'connected');
    if (agentIn) count();
  }, () => undefined);
};
readAgentIn();
router.follow(readAgentIn);

const count = () => {
  const report = reports.failure() ? null : reports.seen.report;
  homeBanner.report(reports.seen.report);
  if (host) forgetEnded(host.state.needs);
  const state = host?.state ?? null;
  sidebar.counts({ connectors: host || report ? (report?.badge.needs ?? 0) + ownNeeds(report, state).length : 0,
    agents: report?.badge.asks ?? 0 });
  sidebar.reading(Boolean(report?.connectors.some(readingPaused)), footRoute(report ?? null));
  sidebar.finish(state && report ? finishItems({ state, report, models: changes.models.read }, (heldChats().list?.length ?? 0) > 0,
    agentIn) : []);
};
reports.follow(count);
followChats(count);
onDismissed(count);
if (host) changes.watch(count).shown(true);

/** @param {HostState['inset']} inset */
function clear(inset) {
  root.classList.toggle('has-inset', inset !== null);
  for (const [name, value] of /** @type {const} */ ([['--inset-left', inset?.left], ['--inset-centre', inset?.centre]])) {
    if (value === undefined) root.style.removeProperty(name);
    else root.style.setProperty(name, `${value}px`);
  }
}

if (host) {
  installWindowBands(document, host);
  installAgentCards(/** @type {HTMLElement} */ (document.getElementById('agent-layer')), host, shown => {
    carded = shown;
    if (shown) router.leaveWalk('');
  });
  let asked = '';
  host.follow(state => {
    const asks = JSON.stringify([state.agent_asks.map(each => each.id), state.agent_requests.map(each => each.id)]);
    if (asks !== asked && asked !== '') void reports.read();
    asked = asks;
    clear(state.inset);
    sidebar.host(state);
    homeBanner.state(state);
    count();
  });
}
void reports.read();
