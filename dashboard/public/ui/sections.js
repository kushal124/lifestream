// @ts-check
/** @import { Route } from '../lib/hash.js' */
/** @import { Host, HostState } from '../lib/host.js' */
/** @import { FinishItem } from './kit/finish-card.js' */
/**
 * @typedef {object} SidebarRouter
 * @property {() => void} openSearch
 * @property {(id: string) => void} openDialog
 * @property {(view: string, patch: { focus: string }) => void} go
 * @property {(id: string) => void} openFlow
 * @property {(listener: (route: Route) => void) => void} follow
 */
import { attributes, esc } from '../lib/html.js';
import { SETTINGS } from './connectors/settings.js';
import {
  ACCOUNT_FEEDBACK, ACCOUNT_FINISH, ACCOUNT_PROFILE, ACCOUNT_SETTINGS, accountMenu, finishCard, finishGone, finishLeft, finishRing, icon,
  iconButton, inPlaceLine, installFilterMenus, relight, signal, watchPictures,
} from './kit/index.js';
import { applyGeometry } from './geometry.js';
import { FINISH_HIDDEN } from './finish.js';

export const SECTIONS = [
  { view: 'ask', label: 'Chat', icon: 'chat' },
  { view: 'days', label: 'Timeline', icon: 'days' },
  { view: 'people', label: 'People', icon: 'people' },
  { view: 'places', label: 'Places', icon: 'places' },
  { view: 'connectors', label: 'Connectors', icon: 'streams' },
  { view: 'agents', label: 'Agents', icon: 'agents' },
];

/** @type {Record<string, (n: number) => string>} */
const COUNT_WORDS = {
  connectors: n => `${n} ${n === 1 ? 'thing needs' : 'things need'} you`,
  agents: n => `${n} ${n === 1 ? 'ask waits' : 'asks wait'} for you`,
};

/** @param {import('../types.js').StreamsReport | null} report */
export const footRoute = report => {
  const recorder = report?.connectors.find(connector => connector.recorder);
  return recorder ? `#dialog=${recorder.id}` : null;
};
/**
 * @param {string} open
 * @param {Record<string, number>} counts
 */
export function sectionRows(open, counts) {
  return SECTIONS.map(section => {
    const on = section.view === open;
    const needs = counts[section.view] ?? 0;
    const said = COUNT_WORDS[section.view]?.(needs) ?? '';
    const count = needs && said
      ? `<span class="sidebar__count ck-count ck-count--need" title="${esc(said)}"><span aria-hidden="true">${needs}</span>`
        + `<span class="sr-only">${esc(said)}</span></span>` : '';
    return `<li><a class="sidebar__item ck-navrow${on ? ' is-on' : ''}"${attributes({
      href: `#view=${section.view}`, 'aria-current': on ? 'page' : null,
    })}>${icon(section.icon)}<span class="sidebar__words ck-navrow__words">${esc(section.label)}</span>${count}</a></li>`;
  }).join('');
}

/** @param {boolean} on */
export const searchRow = on => `<a${attributes({
  class: `sidebar__item ck-navrow${on ? ' is-on' : ''}`, id: 'sidebar-search', href: '#view=search',
  'aria-current': on ? 'page' : null, 'aria-keyshortcuts': 'Meta+K',
})}>${icon('search')}<span class="sidebar__words ck-navrow__words">Search</span><kbd class="sidebar__key">⌘K</kbd></a>`;

export const SIDEBAR_RAIL = 'sidebar.rail';

/**
 * @param {Document} doc
 * @param {boolean} rail
 */
const showRail = (doc, rail) => {
  doc.documentElement.classList.toggle('sidebar-rail', rail);
  keep(doc, SIDEBAR_RAIL, rail);
};

/**
 * @param {Document} doc
 * @param {string} key
 */
const kept = (doc, key) => {
  try {
    return (doc.defaultView?.localStorage.getItem(key) ?? null) !== null;
  } catch {
    return false;
  }
};

/**
 * @param {Document} doc
 * @param {string} key
 * @param {boolean} on
 */
const keep = (doc, key, on) => {
  try {
    if (on) doc.defaultView?.localStorage.setItem(key, 'on');
    else doc.defaultView?.localStorage.removeItem(key);
  } catch {
  }
};

/**
 * @param {HostState} state
 * @param {boolean} paused
 */
export const footMarkup = ({ recorder }, paused) => recorder
  ? signal(recorder.signal, recorder.words, { pulse: recorder.signal === 'engaged', detail: paused ? 'Lifestream paused' : '' })
  : '';

/**
 * @param {{ id: string, name: string, photo: string } | null} you
 * @param {HostState | null} state
 * @param {string | null} [feedback]
 * @param {boolean} [finish]
 */
export const accountMarkup = (you, state, feedback = null, finish = false) => {
  const act = state?.update?.acts[0];
  return accountMenu({ you, shortcut: state ? '⌘,' : '', finish, feedback,
    update: act && state?.update ? { line: state.update.line, act } : null });
};

/**
 * @param {readonly FinishItem[]} items
 * @param {{ hidden: boolean, gone: boolean, flying: boolean }} shown
 */
export const finishMarkup = (items, { hidden, gone, flying }) => !items.length || !finishLeft(items) ? ''
  : hidden ? gone ? finishGone() : '' : finishCard(items, { id: 'sidebar-finish', flying }) + finishRing(items, flying);

export const sidebarMarkup = () => '<nav class="sidebar" aria-label="Sections">'
  + '<div class="sidebar__top" data-window-drag>'
  + '<span class="sidebar__history">'
  + iconButton('sidebar', 'Toggle sidebar', { attrs: { 'data-sidebar-rail': true, 'aria-keyshortcuts': 'Meta+Backslash', title: 'Toggle sidebar (⌘\\)' } })
  + '</span></div>'
  + `<div class="sidebar__nav"><ul class="sidebar__list" id="sidebar-search-row"><li>${searchRow(false)}</li></ul>`
  + '<ul class="sidebar__list" id="sidebar-sections"></ul></div>'
  + '<div class="sidebar__foot" id="sidebar-foot">'
  + '<div class="sidebar__finish" id="sidebar-finish" hidden></div>'
  + '<a class="sidebar__line" id="sidebar-line" hidden></a>'
  + '<div class="sidebar__said" id="sidebar-said" hidden></div>'
  + `<div class="sidebar__you" id="sidebar-you" data-menu-anchor>${accountMarkup(null, null)}</div></div></nav>`;

/**
 * @param {object} parts
 * @param {Document} parts.doc
 * @param {SidebarRouter} parts.router
 * @param {Host | null} parts.host
 * @param {Pick<import('./feedback.js').FeedbackForm, 'entry' | 'follow' | 'open'>} [parts.feedback]
 * @returns {{ counts(counts: { connectors: number, agents: number }): void, host(state: HostState): void, reading(paused: boolean, route: string | null): void, you(you: { id: string, name: string, photo: string } | null): void, finish(items: FinishItem[]): void }}
 */
export function installSidebar({ doc, router, host: app, feedback }) {
  const list = /** @type {HTMLElement} */ (doc.getElementById('sidebar-sections'));
  const search = /** @type {HTMLElement} */ (doc.getElementById('sidebar-search-row'));
  const line = /** @type {HTMLElement} */ (doc.getElementById('sidebar-line'));
  const account = /** @type {HTMLElement} */ (doc.getElementById('sidebar-you'));
  const saidLine = /** @type {HTMLElement} */ (doc.getElementById('sidebar-said'));
  const finish = /** @type {HTMLElement} */ (doc.getElementById('sidebar-finish'));
  watchPictures(account);
  /** @type {FinishItem[]} */
  let finishing = [];
  const shown = { hidden: kept(doc, FINISH_HIDDEN), gone: false, flying: false };
  let finished = '';
  function drawFinish() {
    const markup = finishMarkup(finishing, shown);
    finish.hidden = !markup;
    if (markup !== finished) {
      finished = markup;
      finish.innerHTML = markup;
      applyGeometry(finish);
    }
    drawAccount();
  }
  /** @param {boolean} hidden */
  function hideFinish(hidden) {
    shown.hidden = hidden;
    shown.gone = hidden;
    shown.flying = false;
    keep(doc, FINISH_HIDDEN, hidden);
    drawFinish();
  }
  finish.addEventListener('click', event => {
    const on = /** @type {Element} */ (event.target);
    const flow = /** @type {HTMLElement | null} */ (on.closest('[data-finish-flow]'))?.dataset.finishFlow;
    if (on.closest('[data-finish-hide]')) hideFinish(true);
    else if (on.closest('[data-finish-undo]')) hideFinish(false);
    else if (on.closest('[data-finish-ring]')) {
      shown.flying = !shown.flying;
      drawFinish();
    } else if (flow || on.closest('a[href]')) {
      if (flow) router.openFlow(flow);
      shown.flying = false;
      drawFinish();
    }
  });
  doc.addEventListener('pointerdown', event => {
    if (!shown.flying || finish.contains(/** @type {Node} */ (event.target))) return;
    shown.flying = false;
    drawFinish();
  });
  doc.addEventListener('keydown', event => {
    if (!shown.flying || event.key !== 'Escape') return;
    shown.flying = false;
    drawFinish();
    /** @type {HTMLElement | null} */ (finish.querySelector('[data-finish-ring]'))?.focus();
  });
  /** @type {HostState | null} */
  let stated = null;
  let paused = false;
  /** @type {{ id: string, name: string, photo: string } | null} */
  let you = null;
  let drawnAccount = '';
  let refused = { update: '', words: '' };
  function drawSaid() {
    const words = refused.words && refused.update === stated?.update?.id ? refused.words : '';
    saidLine.hidden = !words;
    saidLine.innerHTML = words ? inPlaceLine(words) : '';
  }
  function drawLine() {
    const markup = stated ? footMarkup(stated, paused) : '';
    line.hidden = !markup;
    if (line.innerHTML !== markup) line.innerHTML = markup;
  }
  function drawAccount() {
    const markup = accountMarkup(you, stated, feedback?.entry() ?? null, shown.hidden && finishLeft(finishing) > 0);
    if (markup === drawnAccount) return;
    drawnAccount = markup;
    const menu = /** @type {HTMLElement | null} */ (account.querySelector('.ck-account'));
    if (!menu) {
      account.innerHTML = markup;
      return;
    }
    const next = /** @type {HTMLElement} */ (doc.createRange().createContextualFragment(markup).firstElementChild);
    const button = /** @type {HTMLElement} */ (menu.querySelector('.ck-account__btn'));
    const drawnButton = /** @type {HTMLElement} */ (next.querySelector('.ck-account__btn'));
    for (const name of ['aria-label', 'title']) {
      const value = drawnButton.getAttribute(name);
      if (value === null) button.removeAttribute(name);
      else button.setAttribute(name, value);
    }
    button.replaceChildren(...drawnButton.childNodes);
    const panel = /** @type {HTMLElement} */ (menu.querySelector('.ck-fmenu__panel'));
    const drawnPanel = /** @type {HTMLElement} */ (next.querySelector('.ck-fmenu__panel'));
    const lit = /** @type {HTMLElement | null} */ (panel.querySelector('.is-lit'))?.dataset.value;
    panel.setAttribute('aria-label', drawnPanel.getAttribute('aria-label') ?? '');
    panel.replaceChildren(...drawnPanel.childNodes);
    relight(menu, lit);
  }
  drawAccount();
  feedback?.follow(drawAccount);
  installFilterMenus(account, (_, value) => {
    if (value === ACCOUNT_SETTINGS) return router.openDialog(SETTINGS);
    if (value === ACCOUNT_FINISH) return hideFinish(false);
    if (value === ACCOUNT_FEEDBACK) return feedback?.open({ kind: 'menu' });
    if (value === ACCOUNT_PROFILE) return you ? router.go('people', { focus: you.id }) : undefined;
    const update = stated?.update;
    if (!app || !update) return;
    refused = { update: '', words: '' };
    drawSaid();
    void app.act({ act: 'need', need: update.id, button: value }).catch((/** @type {Error} */ error) => {
      refused = { update: update.id, words: error.message };
      drawSaid();
    });
  });
  let open = 'ask';
  let shownCounts = { connectors: 0, agents: 0 };
  let drawn = '';
  const draw = () => {
    const markup = sectionRows(open, shownCounts);
    if (markup === drawn) return;
    drawn = markup;
    const focused = list.contains(doc.activeElement) ? doc.activeElement?.getAttribute('href') : null;
    list.innerHTML = markup;
    if (focused) /** @type {HTMLElement | null} */ (list.querySelector(`a[href="${focused}"]`))?.focus({ preventScroll: true });
  };
  router.follow(route => {
    open = route.view;
    draw();
    if (shown.gone || shown.flying) {
      shown.gone = false;
      shown.flying = false;
      drawFinish();
    }
    const row = /** @type {HTMLElement} */ (search.querySelector('#sidebar-search'));
    row.classList.toggle('is-on', open === 'search');
    if (open === 'search') row.setAttribute('aria-current', 'page');
    else row.removeAttribute('aria-current');
  });
  search.addEventListener('click', event => {
    if (!/** @type {Element} */ (event.target).closest('#sidebar-search')) return;
    event.preventDefault();
    router.openSearch();
  });
  doc.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      router.openSearch();
    }
  });
  showRail(doc, kept(doc, SIDEBAR_RAIL));
  const sidebar = /** @type {HTMLElement} */ (doc.querySelector('.sidebar'));
  sidebar.addEventListener('mouseover', event => {
    if (!doc.documentElement.classList.contains('sidebar-rail')) return;
    const row = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest('.ck-navrow, .sidebar__line, .ck-account__btn'));
    if (row && !row.title) row.title = row.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  });
  doc.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key === '\\') {
      event.preventDefault();
      showRail(doc, !doc.documentElement.classList.contains('sidebar-rail'));
    }
  });
  doc.querySelector('.sidebar__history')?.addEventListener('click', event => {
    if (/** @type {Element} */ (event.target).closest('[data-sidebar-rail]')) showRail(doc, !doc.documentElement.classList.contains('sidebar-rail'));
  });
  return {
    counts(counts) {
      shownCounts = counts;
      draw();
    },
    host(state) {
      stated = state;
      draw();
      drawAccount();
      drawLine();
      drawSaid();
    },
    reading(held, route) {
      paused = held;
      if (route) line.setAttribute('href', route);
      drawLine();
    },
    you(person) {
      you = person;
      drawAccount();
    },
    finish(items) {
      finishing = items;
      drawFinish();
    },
  };
}
