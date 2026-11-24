// @ts-check
/** @import { Route } from '../lib/hash.js' */
import { namesView, parseRoute, routeHash } from '../lib/hash.js';

/**
 * @typedef {object} PageContext
 * @property {Readonly<Route>} route
 * @property {(patch: Partial<Omit<Route, 'view' | 'dialog' | 'flow' | 'tour'>>, push?: boolean) => void} set
 * @property {(view: string, patch?: Partial<Omit<Route, 'view' | 'dialog' | 'flow'>>) => void} go
 * @property {() => void} leaveSearch
 * @property {(text: string) => void} title
 * @property {(id: string) => void} dialog
 * @property {(id: string) => void} flow
 */

/**
 * @typedef {{ update: (route: Route) => void, focus?: () => void, flow?: (id: string) => boolean, leaves?: () => boolean }} Mounted
 * @typedef {(container: HTMLElement, context: PageContext) => Mounted} Mount
 */

/**
 * @param {string} view
 * @returns {Route}
 */
const bare = view => ({ view, on: '', focus: '', seg: '', q: '', chat: '', dialog: '', flow: '', tour: '' });

/** @typedef {{ show: (id: string) => void, flow: (id: string) => boolean, leaves: () => boolean }} Dialogs */

/** @type {Dialogs} */
const NO_DIALOGS = { show: () => {}, flow: () => false, leaves: () => true };

/** @typedef {{ to: (step: number) => void, end: (view: string) => void }} WalkMoves */

/** @typedef {{ view: string, seg?: string }} WalkStop */

/** @typedef {{ stops: readonly WalkStop[], show: (step: number, moves: WalkMoves, flow?: string) => void }} Walk */

/** @type {Walk} */
const NO_WALK = { stops: [], show: () => {} };

/**
 * @param {object} parts
 * @param {Window} parts.win
 * @param {HTMLElement} parts.container
 * @param {Record<string, Mount>} parts.pages
 * @param {Dialogs} [parts.dialogs]
 * @param {(id: string, route: Route) => void} [parts.flows]
 * @param {() => boolean} [parts.leaves]
 * @param {Walk} [parts.walk]
 * @param {(section: HTMLElement) => void} [parts.left]
 */
export function startRouter({ win, container, pages, dialogs = NO_DIALOGS, flows = () => {}, leaves = () => true,
  walk = NO_WALK, left = () => {} }) {
  const doc = win.document;
  const first = parseRoute(win.location.hash);
  /** @type {Route} */
  let route = { ...first, dialog: '', flow: '', tour: '' };
  let step = 0;
  let away = false;
  let dialog = '';
  let flow = first.flow;
  /** @type {string | null} */
  let at = null;
  /** @type {'dialog' | 'section' | null} */
  let held = null;
  let departing = false;
  /** @type {Map<string, { element: HTMLElement, mounted: Mounted, route: Route, title: string }>} */
  const sections = new Map();
  /** @type {Route | null} */
  let before = null;
  /** @type {Set<(route: Route) => void>} */
  const listeners = new Set();

  /** @param {boolean} push */
  function writeHash(push) {
    const next = here();
    const was = win.history.state;
    const marks = push ? { dialog: dialog !== '', flow } : { dialog: was?.dialog === true && dialog !== '',
      flow: was?.flow === flow ? flow : '' };
    const state = marks.dialog || marks.flow ? marks : null;
    if (win.location.hash !== next) {
      if (push) win.history.pushState(state, '', next);
      else win.history.replaceState(state, '', next);
    }
    for (const listener of listeners) listener(route);
  }

  const here = () => routeHash({ ...route, dialog, flow, tour: step && !away ? String(step) : '' });

  /** @param {string} tour */
  const stepOf = tour => {
    if (!tour || !walk.stops.length) return 0;
    const n = Number(tour);
    return Number.isInteger(n) && n >= 1 && n <= walk.stops.length ? n : 1;
  };

  const askChat = () => sections.get('ask')?.route.chat ?? '';

  /**
   * @param {Route} next
   * @returns {Route}
   */
  const destination = next => {
    const asked = next.view === 'onboarding' ? 0 : stepOf(next.tour);
    if (!asked) return { ...next, tour: '' };
    const { view, seg = '' } = walk.stops[asked - 1];
    return { ...bare(view), seg, chat: view === 'ask' ? next.chat : '', tour: String(asked) };
  };

  function endHere() {
    if (!step) return;
    step = 0;
    away = false;
    writeHash(false);
    walk.show(0, moves);
  }

  /** @param {Route} next */
  function mayLeave(next) {
    if (!flow || at === null || next.flow === flow) return true;
    const holder = held === 'dialog' ? dialogs.leaves : held === 'section' ? sections.get(at)?.mounted.leaves : leaves;
    return holder?.() ?? true;
  }

  function putAway() {
    if (!flow || at === null) return;
    if (held === 'dialog') dialogs.flow('');
    else if (held === 'section') sections.get(at)?.mounted.flow?.('');
    else flows('', route);
    at = null;
    held = null;
  }

  function place() {
    if (!flow || at === route.view) return;
    putAway();
    at = route.view;
    held = dialog !== '' && dialogs.flow(flow) ? 'dialog'
      : sections.get(route.view)?.mounted.flow?.(flow) === true ? 'section' : null;
    if (!held) flows(flow, route);
  }

  /** @param {string} id */
  function setFlow(id) {
    if (id === flow) return;
    putAway();
    flow = id;
  }

  /** @param {string} id */
  function setDialog(id) {
    if (id === dialog) return false;
    if (held === 'dialog') putAway();
    dialog = id;
    return true;
  }

  /** @param {string} text */
  const titled = text => text ? `${text} · Lifestream` : 'Lifestream';

  /**
   * @param {string} view
   * @returns {PageContext}
   */
  const contextOf = view => ({
    get route() {
      return sections.get(view)?.route ?? route;
    },
    set(patch, push = false) {
      const section = sections.get(view);
      if (!section) return;
      section.route = { ...section.route, ...patch };
      if (route.view !== view) return;
      if (push) away = step !== 0;
      route = section.route;
      writeHash(push);
    },
    go,
    leaveSearch,
    title(text) {
      const section = sections.get(view);
      if (section) section.title = text;
      if (route.view === view) doc.title = titled(text);
    },
    dialog(id) {
      if (route.view === view) openDialog(id);
    },
    flow(id) {
      if (route.view !== view) return;
      if (id) openFlow(id);
      else leaveFlow();
    },
  });

  /**
   * @param {Route} asked
   * @param {boolean} push
   * @param {boolean} [ends]
   */
  function open(asked, push, ends = false) {
    const next = destination(asked);
    const walked = step;
    if (next.tour) step = Number(next.tour);
    else if (ends) step = 0;
    away = !next.tour && step !== 0;
    if (next.view === 'search' && route.view !== 'search') before = route;
    const from = routeHash(route);
    const over = next.flow !== flow || next.dialog !== dialog;
    setFlow(next.flow);
    const turned = setDialog(next.dialog);
    if (turned && !dialog) dialogs.show('');
    route = { ...next, dialog: '', flow: '', tour: '' };
    writeHash(push);
    const kept = sections.get(route.view);
    for (const [view, section] of sections) {
      const hides = view !== route.view;
      if (hides && !section.element.hidden) left(section.element);
      section.element.hidden = hides;
    }
    if (kept) {
      const was = routeHash(kept.route);
      kept.route = route;
      doc.title = titled(kept.title);
      if (was !== routeHash(route)) kept.mounted.update(route);
      const overlaid = over || step !== 0 || walked !== 0;
      if (from !== routeHash(route) || !overlaid) kept.mounted.focus?.();
    } else {
      mount(route.view, route, false);
    }
    if (turned && dialog) dialogs.show(dialog);
    place();
    if (step || walked) walk.show(step, moves, flow);
  }

  /** @param {string} view */
  function warm(view) {
    if (sections.has(view) || !pages[view] || flow || dialog || step) return;
    mount(view, bare(view), true);
  }

  /**
   * @param {string} view
   * @param {Route} at
   * @param {boolean} hidden
   */
  function mount(view, at, hidden) {
    const element = doc.createElement('div');
    element.className = `main__section main__section--${view}`;
    element.hidden = hidden;
    container.append(element);
    const section = { element, mounted: /** @type {Mounted} */ ({ update: () => {} }), route: at, title: '' };
    sections.set(view, section);
    section.mounted = pages[view](element, contextOf(view));
  }

  /**
   * @param {string} view
   * @param {Partial<Omit<Route, 'view'>>} [patch]
   */
  function go(view, patch) {
    const next = destination({ ...bare(view), ...patch });
    if (next.tour && !mayLeave(next)) return;
    open(next, true);
  }

  function leaveSearch() {
    if (route.view === 'search') open(before ?? bare('ask'), true);
  }

  /** @param {number} to */
  function walkTo(to) {
    if (!step || to < 1 || to > walk.stops.length) return;
    const { view, seg = '' } = walk.stops[to - 1];
    open({ ...bare(view), seg, chat: view === 'ask' ? askChat() : '', tour: String(to) }, false);
  }

  /** @param {string} view */
  function leaveWalk(view) {
    if (!step) return;
    if (view) open({ ...bare(view), chat: view === 'ask' ? askChat() : '' }, false, true);
    else endHere();
  }

  /** @type {WalkMoves} */
  const moves = { to: walkTo, end: leaveWalk };

  /** @param {string} id */
  function openDialog(id) {
    if (id === dialog || departing) return;
    if (id && step) away = true;
    if (!id && win.history.state?.dialog === true && !win.history.state?.flow) {
      departing = true;
      win.history.back();
      return;
    }
    const from = dialog;
    setFlow('');
    setDialog(id);
    writeHash(id !== '' && from === '');
    dialogs.show(dialog);
  }

  /** @param {string} id */
  function openFlow(id) {
    if (id === flow) return;
    if (step) away = true;
    setFlow(id);
    writeHash(true);
    place();
    if (step) walk.show(step, moves, flow);
  }

  function leaveFlow() {
    if (!flow || departing) return;
    if (win.history.state?.flow === flow) {
      departing = true;
      win.history.back();
      return;
    }
    setFlow('');
    writeHash(false);
    if (step) walk.show(step, moves, flow);
  }

  function openSearch() {
    if (route.view === 'search') sections.get('search')?.mounted.focus?.();
    else open(bare('search'), true);
  }

  win.addEventListener('popstate', () => {
    const named = parseRoute(win.location.hash);
    const over = !namesView(win.location.hash) && (named.dialog !== '' || named.flow !== '');
    if (over && named.dialog === dialog && named.flow === flow) {
      departing = true;
      win.history.back();
      return;
    }
    if (over) win.history.replaceState({ dialog: named.dialog !== '', flow: named.dialog ? '' : named.flow }, '');
    const next = destination(over ? { ...route, dialog: named.dialog, flow: named.flow } : named);
    const asks = !departing && !mayLeave(next);
    departing = false;
    if (asks) win.history.pushState({ dialog: dialog !== '', flow }, '', here());
    else open(next, false);
  });
  open(first, false);
  return {
    warm,
    openSearch,
    leaveSearch,
    go,
    openDialog,
    openFlow,
    leaveFlow,
    leaveWalk,
    /** @param {(route: Route) => void} listener */
    follow(listener) {
      listeners.add(listener);
      listener(route);
    },
  };
}
