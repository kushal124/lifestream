// @ts-check
/** @import { Mount } from '../ui/route.js' */
/** @import { Route } from '../lib/hash.js' */
/** @import { Opens } from '../lib/opening.js' */
/** @import { Drawn, Retry } from '../lib/reach.js' */
/** @import { Search, SearchKind, SearchRow } from '../pages.js' */
/** @import { Page, Shown } from '../ui/search/hit-list.js' */
/** @import { SittingRow, TrackRow, TrackRead } from '../ui/search/preview.js' */
import { fetchPage, fetchPlays } from '../lib/api.js';
import { readHost } from '../lib/host.js';
import { esc } from '../lib/html.js';
import { familyWords } from '../lib/kinds.js';
import { momentAt, routeOf } from '../lib/opening.js';
import { pageReach, wordsOr } from '../lib/reach.js';
import { today } from '../lib/home-clock.js';
import {
  ARRIVES, icon, installFilterMenus, installWeekFigure, kbd, pageLack, personFace, reading, readingAgain, waitLine,
  watchPictures,
} from '../ui/kit/index.js';
import { applyGeometry } from '../ui/geometry.js';
import { onHomeChange } from '../ui/live.js';
import { momentPreview } from '../ui/panel.js';
import { kindsParams, pageParams, searchChips, seeParams } from '../ui/search/filter-pills.js';
import {
  chipsShown, hitListReading, kindsList, listState, nothingMatches, rowWords, seeAllList, seePage,
} from '../ui/search/hit-list.js';
import {
  monthsOf, namedPage, previewFailed, previewNone, sittingPage, trackCount, trackPage,
} from '../ui/search/preview.js';
import { cursorExpired, newest, onClock, pageJoined, readingWords, SCREEN, unopened } from '../ui/search/query.js';
import { keepRecent, readRecent, recentSearches, remembered } from '../ui/search/recent-searches.js';

const NEAR = 2400;
const HOME_EVERY = 3000;
const TYPING_EVERY = 150;
const NOT_HERE = 'Search isn’t on this Mac yet.';
const UNREAD = 'Search couldn’t be read.';

/**
 * @typedef {({ state: 'found', kinds: Search } | { state: 'failed', drawn: Drawn })
 *   & { key: string, words: string, day: string }} Answer
 * @typedef {({ state: 'found', page: Page } | { state: 'failed', words: string }) & { key: string, kind: string, words: string }} SeeAnswer
 * @typedef {{ kinds: Search, key: string }} Found
 * @typedef {{ key: string, track: TrackRow }} Target
 */

/** @type {Mount} */
export const mountSearch = (container, context) => {
  context.title('Search');
  const chosen = { time: '', family: '', upcoming: false };
  let q = context.route.q;
  const kindsKey = () => `${q}\n${chosen.time}`;
  const seeKind = () => `${chosen.family}\n${chosen.upcoming}`;
  const seeKey = () => `${kindsKey()}\n${seeKind()}`;
  /** @type {Answer | null} */
  let answer = null;
  /** @type {Found | null} */
  let found = null;
  /** @type {SeeAnswer | null} */
  let see = null;
  let paging = false;
  let moreFailed = '';
  let cannot = '';
  let recent = readRecent();
  /** @type {Shown[]} */
  let shown = [];
  let selected = '';
  /** @type {Target | null} */
  let target = null;
  /** @type {TrackRead | null} */
  let track = null;
  /** @type {Map<HTMLElement, string>} */
  const drawn = new Map();

  container.innerHTML = '<div class="sx">'
    + '<div class="sx-col"><div class="sx-top" data-window-drag>'
    + `<div class="sx-field"><label class="sx-field__words">${icon('search', { size: 'sm' })}`
    + '<input class="sx-input mac-reading" type="text" role="searchbox" placeholder="Search everything" '
    + 'aria-label="Search everything" autocomplete="off" spellcheck="false" enterkeyhint="search" data-part="input"></label>'
    + '<span class="sx-field__end" data-part="end"></span></div>'
    + '<div data-part="chips"></div><div data-part="note"></div></div>'
    + '<div class="sx-scroll" data-part="scroll"><div data-part="list"></div><div class="sx-sentinel" data-part="sentinel"></div></div></div>'
    + '<aside class="sx-preview" aria-label="Preview" data-part="preview"><div class="sx-preview__moment" data-part="moment" hidden></div>'
    + '<div class="sx-preview__thing" data-part="thing"></div></aside></div>';
  /** @param {string} name */
  const part = name => /** @type {HTMLElement} */ (container.querySelector(`[data-part="${name}"]`));
  const root = /** @type {HTMLElement} */ (container.querySelector('.sx'));
  const input = /** @type {HTMLInputElement} */ (part('input'));
  const end = part('end');
  const chips = part('chips');
  const note = part('note');
  const scroll = part('scroll');
  const list = part('list');
  const sentinel = part('sentinel');
  const momentPart = part('moment');
  const thingPart = part('thing');
  const reach = pageReach(readHost(window), root);
  const moment = momentPreview(momentPart, { go: (view, patch) => context.go(view, patch) });
  watchPictures(root);
  installWeekFigure(thingPart);

  /** @param {Retry | null} [retry] */
  const readAgain = (retry = null) => {
    if (q.trim()) void readKinds.ask(retry);
  };
  /** @type {ReturnType<typeof setTimeout> | null} */
  let waiting = null;

  /**
   * @param {Retry | null} retry
   * @returns {Promise<Answer>}
   */
  async function loadKinds(retry) {
    const key = kindsKey();
    const words = q;
    const day = today();
    const begun = reach.begin(retry);
    if (waiting !== null) clearTimeout(waiting);
    waiting = null;
    try {
      return { key, words, day, state: 'found', kinds: await fetchPage('search', Object.fromEntries(kindsParams(q, chosen.time, day))) };
    } catch (error) {
      const drawnNow = reach.failed(error, begun, readAgain);
      if (drawnNow.kind === 'wait') waiting = setTimeout(() => readAgain(), Math.max(0, drawnNow.until - Date.now()));
      return { key, words, day, state: 'failed', drawn: drawnNow };
    }
  }

  const readKinds = newest(loadKinds, next => {
    const fresh = next.key !== answer?.key;
    answer = next;
    if (next.state === 'found') found = { kinds: next.kinds, key: next.key };
    if (fresh && !chosen.family) scroll.scrollTop = 0;
    drawAll();
  }, kindsKey);

  /**
   * @param {URLSearchParams} params
   * @returns {Promise<Page>}
   */
  async function kindPage(params) {
    const day = today();
    return seePage(await fetchPage('searchKind', Object.fromEntries(params)), day);
  }

  const firstPage = () => kindPage(seeParams(q, chosen, today()));

  /** @param {string} cursor */
  const nextPage = cursor => kindPage(pageParams(cursor));

  const readSee = newest(async () => {
    const asked = { key: seeKey(), kind: seeKind(), words: q };
    try {
      return /** @type {SeeAnswer} */ ({ ...asked, state: 'found', page: await firstPage() });
    } catch (error) {
      return /** @type {SeeAnswer} */ ({ ...asked, state: 'failed', words: wordsOr(error, `${familyWords(chosen.family).label} couldn’t be read.`) });
    }
  }, next => {
    if (next.key !== see?.key) scroll.scrollTop = 0;
    see = next;
    moreFailed = '';
    drawList();
  }, seeKey);

  async function more() {
    if (paging || moreFailed || see?.state !== 'found' || !see.page.next || see.key !== seeKey()) return;
    const asked = see;
    const page = asked.page;
    paging = true;
    /** @type {Page | null} */
    let read = null;
    let again = false;
    try {
      read = await nextPage(String(page.next));
    } catch (error) {
      again = cursorExpired(error);
      if (!again) moreFailed = wordsOr(error, 'More couldn’t be read.');
    }
    paging = false;
    if (see !== asked) return;
    if (again) {
      void readSee.ask();
      return;
    }
    if (read) see = { ...asked, page: pageJoined(page, read) };
    drawList();
  }

  let typedAt = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let typingTimer;
  function askSoon() {
    if (typingTimer !== undefined) return;
    typingTimer = setTimeout(() => {
      typingTimer = undefined;
      typedAt = Date.now();
      ask();
    }, Math.max(0, typedAt + TYPING_EVERY - Date.now()));
  }

  function ask() {
    if (!q.trim()) return;
    void readKinds.ask();
    if (chosen.family) void readSee.ask();
  }

  const observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) void more();
  }, { root: scroll, rootMargin: `0px 0px ${NEAR}px 0px` });
  const watchEnd = () => {
    observer.unobserve(sentinel);
    observer.observe(sentinel);
  };
  observer.observe(sentinel);

  function remember() {
    const next = remembered(recent, q);
    if (next === recent) return;
    recent = next;
    keepRecent(recent);
  }

  const standing = () => q.trim() ? found?.kinds ?? null : null;
  const answerState = () => !answer ? 'none' : answer.state !== 'failed' ? answer.state
    : answer.drawn.kind === 'lack' ? 'lack' : 'waiting';
  const failedDrawn = () => answer?.state === 'failed' ? answer.drawn : null;
  const state = () => listState({ words: q, kinds: standing(), answer: answerState() });

  function chipsMarkup() {
    const kinds = standing();
    if (!chipsShown(state(), chosen)) return '';
    return searchChips({ answer: kinds, family: chosen.family, time: chosen.time, held: kinds?.held, today: today() });
  }

  function noteMarkup() {
    const failed = answer?.state === 'failed' && answer.drawn.kind === 'lack' && found ? answer.drawn : null;
    const reading = standing()?.reading ?? null;
    const words = cannot || (reading?.state === 'building' || !chosen.family ? readingWords(reading, today()) : '');
    if (failed) return pageLack(failed.words ?? UNREAD, failed.retry ? { retry: { 'data-search-action': 'retry' } } : {});
    return words ? `<p class="sx-note mac-footnote">${esc(words)}</p>` : '';
  }

  /** @returns {{ markup: string, shown: Shown[] }} */
  function listParts() {
    const none = { markup: '', shown: [] };
    if (!q.trim()) return { markup: recentSearches(recent), shown: [] };
    const words = { today: today() };
    if (chosen.family) {
      const kept = see?.key === seeKey() || (see?.state === 'found' && see.kind === seeKind()) ? see : null;
      if (!kept) return { markup: hitListReading(), shown: [] };
      if (kept.state === 'failed') return { markup: pageLack(kept.words, { retry: { 'data-search-action': 'see' } }), shown: [] };
      const upcoming = standing()?.kinds.find(each => each.family === chosen.family)?.upcoming ?? null;
      const drawnNow = seeAllList(kept.page, words, { upcoming, chosen: chosen.upcoming });
      return { markup: drawnNow.markup + (moreFailed ? pageLack(moreFailed, { retry: { 'data-search-action': 'more' } }) : ''),
        shown: drawnNow.shown };
    }
    const kinds = standing();
    switch (state()) {
      case 'building':
        return none;
      case 'waiting':
        return { markup: hitListReading().replace(waitLine(), readingAgain(/** @type {Drawn} */ (failedDrawn()), NOT_HERE)), shown: [] };
      case 'lack': {
        const said = /** @type {{ words: string | null, retry: boolean }} */ (failedDrawn());
        return { markup: pageLack(said.words ?? UNREAD, said.retry ? { retry: { 'data-search-action': 'retry' } } : {}), shown: [] };
      }
      case 'nothing':
        return { markup: `<div class="sx-none ${ARRIVES}">${nothingMatches(kinds?.nothing ?? '')}</div>`, shown: [] };
      case 'date':
      case 'kinds':
        return kindsList(/** @type {Search} */ (kinds), words);
      default:
        return { markup: hitListReading(), shown: [] };
    }
  }

  /**
   * @param {HTMLElement} element
   * @param {string} markup
   */
  function put(element, markup) {
    if (drawn.get(element) === markup) return false;
    drawn.set(element, markup);
    const focused = document.activeElement;
    const keep = focused instanceof HTMLElement && element.contains(focused) ? focusKey(focused) : '';
    element.innerHTML = markup;
    if (keep) /** @type {HTMLElement | null} */ (element.querySelector(keep))?.focus({ preventScroll: true });
    return true;
  }

  function drawList() {
    const reads = q.trim() !== '' && (chosen.family ? see?.key !== seeKey() : state() === 'reading' || state() === 'waiting');
    reading(root, reads, 'Searching');
    const made = listParts();
    shown = made.shown;
    put(note, noteMarkup());
    if (put(list, made.markup)) watchEnd();
    if (!shown.some(each => each.key === selected)) select(shown[0]?.key ?? '', false);
    else markSelected(false);
  }

  function drawEnd() {
    put(end, q ? `<button type="button" class="sx-clear" aria-label="Clear" data-search-action="clear">${icon('close', { size: 'sm' })}</button>`
      : kbd('⌘K'));
  }

  function drawAll() {
    drawEnd();
    put(chips, chipsMarkup());
    drawList();
  }

  /** @param {boolean} scrolled */
  function markSelected(scrolled) {
    const at = shown.findIndex(each => each.key === selected);
    for (const row of list.querySelectorAll('.ck-trow.is-selected')) {
      row.classList.remove('is-selected');
      row.removeAttribute('aria-current');
    }
    const row = at < 0 ? null : list.querySelector(`[data-search-row="${at}"]`);
    if (!row) return;
    row.classList.add('is-selected');
    row.setAttribute('aria-current', 'true');
    if (scrolled) row.scrollIntoView({ block: 'nearest' });
  }

  /**
   * @param {string} key
   * @param {boolean} scrolled
   */
  function select(key, scrolled) {
    const changed = key !== selected;
    selected = key;
    markSelected(scrolled);
    if (changed) showPreview();
  }

  const readPreview = newest(loadPreview, draw => {
    if (!container.hidden) draw();
  }, () => target?.key ?? '');

  const selectedThing = () => shown.find(each => each.key === selected)?.thing ?? null;

  /** @param {string} markup */
  function showThing(markup) {
    moment.close();
    momentPart.hidden = true;
    thingPart.hidden = false;
    put(thingPart, markup);
    applyGeometry(thingPart);
  }

  /**
   * @param {Opens | null} opens
   * @param {{ icon: string, title: string, meta: string }} head
   */
  function showOpens(opens, head) {
    const at = momentAt(opens);
    if (at?.focus) {
      thingPart.hidden = true;
      momentPart.hidden = false;
      moment.show([{ on: at.on, focus: at.focus, head }], 0, { terms: q.trim().split(/\s+/u) });
    } else if (routeOf(opens)) showThing(namedPage({ lead: '', title: head.title, line: head.meta }, 'Open'));
    else showThing(previewNone(unopened(head.title, '')));
  }

  let entering = false;
  function enterTrack() {
    const first = /** @type {HTMLElement | null} */ (thingPart.querySelector('[data-search-play]'));
    entering = !first;
    first?.focus({ preventScroll: true });
  }

  /** @param {TrackRead} read */
  function drawTrack(read) {
    track = read;
    showThing(trackPage(read, today()));
    if (entering) enterTrack();
  }

  /**
   * @param {TrackRead['track']} each
   * @param {string} month
   */
  const monthOf = (each, month) => trackCount(fetchPlays, each, { month });

  /**
   * @param {TrackRead['track']} each
   * @returns {Promise<() => void>}
   */
  async function trackOf(each) {
    const read = track;
    if (read?.paging) {
      const month = read.paging;
      try {
        const page = await monthOf(each, month);
        return () => drawTrack({ ...read, pages: [...read.pages, page], paging: '', failed: '' });
      } catch (error) {
        return () => drawTrack({ ...read, paging: '', failed: wordsOr(error, 'Earlier plays couldn’t be read.') });
      }
    }
    try {
      const months = await trackCount(fetchPlays, each);
      const held = monthsOf(months);
      const newestMonth = held[0]?.month;
      const oldestMonth = held.at(-1)?.month;
      const [newestPage, oldestPage] = await Promise.all([
        newestMonth ? monthOf(each, newestMonth) : null,
        oldestMonth && oldestMonth !== newestMonth ? monthOf(each, oldestMonth) : null,
      ]);
      return () => drawTrack({ track: each, months, pages: newestPage ? [newestPage] : [], oldest: oldestPage ?? newestPage });
    } catch (error) {
      return () => showThing(previewFailed(wordsOr(error, `${each.title} couldn’t be read.`), true));
    }
  }

  /** @returns {Promise<() => void>} */
  async function loadPreview() {
    const at = target;
    if (!at) return () => undefined;
    return trackOf({ title: at.track.title, artist: at.track.artist });
  }

  function earlier() {
    const read = track;
    if (!read?.months || read.paging) return;
    const month = monthsOf(read.months)[read.pages.length]?.month;
    if (!month) return;
    drawTrack({ ...read, paging: month, failed: '' });
    void readPreview.ask();
  }

  function showPreview() {
    track = null;
    entering = false;
    readPreview.drop();
    const thing = selectedThing();
    target = thing?.kind === 'track' ? { key: selected, track: thing } : null;
    if (!thing) return showThing('');
    const words = rowWords(thing, { today: today() });
    switch (thing.kind) {
      case 'person':
        return showThing(namedPage({ ...words, lead: personFace({ name: thing.name, photo: thing.picture ?? '', size: 'tile' }) }, 'Open'));
      case 'place':
      case 'date':
        return showThing(namedPage(words, 'Open'));
      case 'sitting':
        return showThing(sittingPage(thing, today()));
      case 'track':
        drawTrack({ track: { title: thing.title, artist: thing.artist }, months: null, pages: [], oldest: null });
        return void readPreview.ask();
      case 'hit':
        return showOpens(thing.opens, { icon: familyWords(thing.family).icon, title: words.title, meta: words.when });
    }
  }

  /**
   * @param {SittingRow} sitting
   * @param {number} at
   */
  function showWindow(sitting, at) {
    const window = sitting.windows[at];
    if (!window) return;
    track = null;
    target = null;
    readPreview.drop();
    showOpens(window.opens, { icon: familyWords(SCREEN).icon, title: window.title, meta: window.app });
  }

  /** @param {SearchRow} thing */
  function goTo(thing) {
    remember();
    const route = 'opens' in thing ? routeOf(thing.opens) : null;
    if (route) return context.go(route.go, route.patch);
    cannot = unopened(rowWords(thing, { today: today() }).title, '');
    put(note, noteMarkup());
  }

  function openSelected() {
    const thing = selectedThing();
    if (!thing) return;
    if (thing.kind === 'track') enterTrack();
    else goTo(thing);
  }

  /** @param {Partial<typeof chosen>} next */
  function choose(next) {
    Object.assign(chosen, next);
    moreFailed = '';
    cannot = '';
    if (chosen.family) void readSee.ask();
    else readSee.drop();
    drawAll();
  }

  /** @param {string} next */
  function setWords(next) {
    if (next === q) return;
    q = next;
    cannot = '';
    if (input.value !== q) input.value = q;
    context.set({ q });
    if (q.trim()) askSoon();
    else {
      readKinds.drop();
      readSee.drop();
      answer = null;
      found = null;
      see = null;
      Object.assign(chosen, { family: '', upcoming: false });
    }
    drawAll();
  }

  /** @type {Record<string, (target: HTMLElement) => void>} */
  const actions = {
    'data-search-row': control => {
      const key = shown[Number(control.dataset.searchRow)]?.key;
      if (key === undefined) return;
      if (key === selected) showPreview();
      else select(key, false);
    },
    'data-search-see': control => choose({ family: String(control.dataset.searchSee), upcoming: false }),
    'data-search-upcoming': () => choose({ upcoming: !chosen.upcoming }),
    'data-value': target => {
      if (target.closest('[data-search-chips]')) choose({ family: String(target.dataset.value), upcoming: false });
    },
    'data-search-go': () => openSelected(),
    'data-search-day': () => {
      const thing = selectedThing();
      if (thing?.kind === 'sitting') goTo(thing);
    },
    'data-search-window': control => {
      const thing = selectedThing();
      if (thing?.kind === 'sitting') showWindow(thing, Number(control.dataset.searchWindow));
    },
    'data-search-play': target => context.go('days', { on: String(target.dataset.searchPlay) }),
    'data-search-earlier': () => earlier(),
    'data-search-preview-retry': () => showPreview(),
    'data-search-recent': target => {
      setWords(String(target.dataset.searchRecent));
      input.focus();
    },
    'data-search-forget': target => {
      recent = recent.filter(words => words !== target.dataset.searchForget);
      keepRecent(recent);
      drawList();
      input.focus();
    },
    'data-search-action': target => {
      const action = target.dataset.searchAction;
      if (action === 'clear') {
        setWords('');
        input.focus();
      } else if (action === 'retry') {
        answer = null;
        drawAll();
        void readKinds.ask();
      } else if (action === 'see') {
        see = null;
        drawList();
        void readSee.ask();
      } else if (action === 'more') {
        moreFailed = '';
        void more();
      }
    },
  };

  /** @param {MouseEvent} event */
  const onClick = event => {
    const target = /** @type {Element} */ (event.target);
    if (momentPart.contains(target)) return;
    for (const [name, act] of Object.entries(actions)) {
      const control = /** @type {HTMLElement | null} */ (target.closest(`[${name}]`));
      if (control && container.contains(control) && !control.closest('.ck-fmenu')) {
        act(control);
        return;
      }
    }
  };

  /** @param {number} by */
  function step(by) {
    const at = shown.findIndex(each => each.key === selected);
    const next = shown[Math.max(0, Math.min(shown.length - 1, at + by))];
    if (!next) return;
    select(next.key, true);
    if (list.contains(document.activeElement)) {
      /** @type {HTMLElement | null} */ (list.querySelector(`[data-search-row="${shown.indexOf(next)}"]`))?.focus({ preventScroll: true });
    }
  }

  /** @param {KeyboardEvent} event */
  const onKey = event => {
    if (event.defaultPrevented || container.hidden) return;
    const target = /** @type {HTMLElement} */ (event.target);
    if (!container.contains(target) && target !== document.body) return;
    if (momentPart.contains(target) || target.closest('.ck-fmenu')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (q) {
        setWords('');
        input.focus();
      } else context.leaveSearch();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!shown.length) return;
      event.preventDefault();
      step(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Enter' && (target === input || list.contains(target))) {
      event.preventDefault();
      if (!q.trim()) return;
      remember();
      if (target.closest('[data-search-upcoming]')) choose({ upcoming: !chosen.upcoming });
      else openSelected();
      return;
    }
    if (target !== input && list.contains(target) && event.key.length === 1 && event.key !== ' ') {
      event.preventDefault();
      input.focus();
      setWords(q + event.key);
      input.setSelectionRange(q.length, q.length);
    }
  };

  input.addEventListener('input', () => setWords(input.value));
  installFilterMenus(chips, (_menu, value) => {
    chosen.time = value;
    chosen.upcoming = false;
    found = null;
    see = null;
    drawAll();
    ask();
  });
  container.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);
  let homeAsked = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let homeTimer;
  onHomeChange(change => {
    const clocked = onClock(change, q);
    if (clocked === 'ask') ask();
    else if (clocked === 'draw') drawAll();
    if (!change.records || homeTimer !== undefined) return;
    homeTimer = setTimeout(() => {
      homeTimer = undefined;
      homeAsked = Date.now();
      if (q.trim()) void readKinds.ask();
    }, Math.max(0, homeAsked + HOME_EVERY - Date.now()));
  }, container);

  input.value = q;
  drawAll();
  ask();
  input.focus();

  return {
    /** @param {Route} route */
    update(route) {
      setWords(route.q);
    },
    focus() {
      input.focus();
      input.select();
    },
  };
};

/** @param {HTMLElement} element */
function focusKey(element) {
  for (const name of ['data-search-row', 'data-search-recent', 'data-search-forget', 'data-search-see', 'data-search-upcoming',
    'data-search-action', 'data-search-window', 'data-search-play', 'data-search-earlier', 'data-search-go', 'data-search-day']) {
    const value = element.getAttribute(name);
    if (value !== null) return `[${name}="${CSS.escape(value)}"]`;
  }
  if (element.matches('[data-search-chips] [data-value]')) return `[data-search-chips] [data-value="${CSS.escape(element.dataset.value ?? '')}"]`;
  return element.matches('.ck-fmenu__btn') ? '.ck-fmenu__btn' : '';
}
