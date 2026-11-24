// @ts-check
/** @import { Mounted, PageContext } from '../ui/route.js' */
/** @import { Route } from '../lib/hash.js' */
/** @import { Day, Days, WrittenDay } from '../pages.js' */
/** @import { Fold, FoldView, Item } from '../ui/days/fold.js' */
import { fetchPage } from '../lib/api.js';
import { readHost } from '../lib/host.js';
import { pageReach } from '../lib/reach.js';
import { pageMoved, readMoves } from '../lib/pages.js';
import { today } from '../lib/home-clock.js';
import { clock, longDay, shortDay } from '../lib/words.js';
import { duration } from '../ui/kit/duration.js';
import { atOrPast, onHomeChange } from '../ui/live.js';
import {
  ARRIVES, dayRow, noneLine, openPhotoViewer, pageLack, reading, readingAgain, waitLine, watchPictures,
} from '../ui/kit/index.js';
import { installMonthPicker } from '../ui/kit/month-picker.js';
import { dayBar } from '../ui/days/head.js';
import {
  aheadOf, blockBody, dayList, dayListReading, foldsOf, hourOpen, hourRows, isOpen, itemsOf, lengthOf, moveHeadRow, opens, sizeRuns,
} from '../ui/days/fold.js';
import { fitWithin } from '../ui/days/fit.js';
import { DAY_MAP, daySide, daySideReading, installDaySide, sidePills, sidePillsReading } from '../ui/days/side.js';
import { installMomentPanel } from '../ui/panel.js';

/** @typedef {{ open: Map<string, boolean>, hours: Map<string, boolean>, scroll: number }} Kept */

const KEPT = 5;
const LIST_PAGE = '1024';

const SIDE_PANE = 1056;

const NOT_HERE = 'This day isn’t on this Mac yet.';
const UNREAD = 'This day couldn’t be read.';

const FRAME = '<div class="ck-page dy">'
  + '<header class="ck-page__bar dy-bar" data-window-drag data-part="bar"></header>'
  + '<div class="ck-under"><div class="ck-page__scroll dy-scroll" data-part="scroll"><div class="dy-body">'
  + '<div class="dy-main"><div class="dy-under" data-part="pills"></div>'
  + `<div class="dy-day" data-part="list"></div></div></div></div></div>`
  + '<aside class="dy-side ck-page__stage" data-part="side" aria-label="The day\'s places and people"></aside>'
  + `<aside class="dy-panel" aria-label="Moment" data-part="panel" data-map-over="${DAY_MAP}"></aside>`
  + '<div class="dy-pickhost" data-part="picker"></div></div>';

/**
 * @param {HTMLElement} container
 * @param {PageContext} context
 * @returns {Mounted}
 */
export const mountDays = (container, context) => {
  /** @type {WrittenDay[] | null} */
  let list = null;
  let opening = '';
  /** @type {string | null} */
  let listAt = null;
  /** @type {Promise<void> | null} */
  let listReads = null;
  let listAgain = false;
  let day = '';
  /** @type {Day | null} */
  let answer = null;
  /** @type {Item[]} */
  let items = [];
  /** @type {Map<string, Day>} */
  const read = new Map();
  /** @type {Map<string, Kept>} */
  const kept = new Map();
  /** @type {'loading' | 'ready' | 'error'} */
  let status = 'loading';
  /** @type {import('../lib/reach.js').Drawn | null} */
  let failure = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let waiting = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let until = null;
  /** @type {number | null} */
  let untilFired = null;
  /** @type {number | null} */
  let behind = null;
  let focus = '';
  let named = '';
  let unmarked = false;
  let inPanel = '';
  let generation = 0;
  let cursor = '';
  /** @type {{ close: () => void } | null} */
  let picker = null;

  let pill = '';
  let wide = true;

  container.innerHTML = FRAME;
  const root = /** @type {HTMLElement} */ (container.querySelector('.dy'));
  const reach = pageReach(readHost(window), root);
  /** @param {import('../lib/reach.js').Retry | null} [retry] */
  const readAgain = (retry = null) => void readDay(true, retry);
  /** @param {string} name */
  const part = name => /** @type {HTMLElement} */ (root.querySelector(`[data-part="${name}"]`));
  const bar = part('bar');
  const scroll = part('scroll');
  const listBox = part('list');
  watchPictures(root);
  void readMoves();
  /** @type {number} */
  let sideFrame = 0;
  const side = installDaySide(root, {
    changed: () => {
      sideFrame ||= requestAnimationFrame(() => {
        sideFrame = 0;
        drawSide();
      });
    },
    reveal: ids => revealIds(ids),
  });
  const panel = installMomentPanel(part('panel'), {
    go: context.go,
    found: (on, asked, id) => {
      if (on !== day || asked !== (named || focus) || id === focus) return;
      if (/^(?:a\d|rec:)/u.test(asked)) named = asked;
      focus = id;
      context.set({ focus: id });
      markSelected();
      revealRow(id, { flash: false });
      queueMicrotask(() => drawInspector());
    },
    closed: () => {
      const back = opener ?? (focus ? [{ attr: 'data-d-row', value: focus }] : []);
      inPanel = '';
      if (focus) openRow('');
      const to = back.map(each => /** @type {HTMLElement | null} */ (root.querySelector(`[${each.attr}="${CSS.escape(each.value)}"]`)))
        .find(element => element !== null && element.offsetParent !== null);
      to?.focus({ preventScroll: true });
    },
  });

  const days = () => (list ?? []).map(entry => entry.day);
  const earlier = () => days().findLast(each => each < day) ?? null;
  const later = () => days().find(each => each > day) ?? null;
  const view = () => {
    let held = kept.get(day);
    if (!held) {
      held = { open: new Map(), hours: new Map(), scroll: 0 };
      kept.set(day, held);
    }
    return held;
  };
  const motion = () => !matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** @param {string} name */
  const ms = name => duration(root, name);


  function drawBar() {
    const focused = Boolean(document.activeElement?.matches('[data-d-title]') && bar.contains(document.activeElement));
    bar.innerHTML = dayBar({ day: list ? day : '', today: today(), picking: picker !== null, previous: earlier(), next: later() });
    if (focused) /** @type {HTMLElement | null} */ (bar.querySelector('[data-d-title]'))?.focus({ preventScroll: true });
  }

  /** @returns {FoldView} */
  function foldView() {
    const held = view();
    return { open: held.open, hours: held.hours, selected: focus, now: Date.now() };
  }

  function drawDay() {
    reading(root, status === 'loading');
    listBox.style.minHeight = '';
    if (status === 'loading') {
      listBox.innerHTML = failure && failure.kind !== 'lack' ? dayListReading().replace(waitLine(), readingAgain(failure, NOT_HERE))
        : dayListReading();
      return;
    }
    if (status !== 'ready' || !answer) {
      listBox.innerHTML = `<div class="dy-state">${failure?.kind === 'lack'
        ? pageLack(failure.words ?? UNREAD, failure.retry ? { retry: { 'data-d-retry': '' } } : {}) : ''}</div>`;
      return;
    }
    if (answer.before_home !== null) {
      listBox.innerHTML = beforeHome(answer.before_home);
      return;
    }
    const focused = listBox.contains(document.activeElement);
    listBox.innerHTML = dayList(answer, items, foldView());
    sizeRuns(listBox);
    listBox.classList.add(ARRIVES);
    fitWithin(listBox);
    const item = roveTo(cursor);
    if (focused && cursor) item?.focus({ preventScroll: true });
    markPinned();
  }

  /** @param {string} words */
  function beforeHome(words) {
    const first = days()[0];
    return noneLine(words, { detail: first ? 'Lifestream begins <button type="button" '
      + `class="dy-link" data-d-day="${first}">${shortDay(first, '-')}</button>` : '' });
  }

  function drawSide() {
    const column = part('side');
    const pills = part('pills');
    if (status === 'error') {
      putSide(column, '');
      putSide(pills, '');
      return;
    }
    if (status === 'loading' || !answer) {
      putSide(column, wide ? daySideReading() : '');
      putSide(pills, wide ? '' : sidePillsReading());
      return;
    }
    const more = side.more(day);
    const drew = putSide(column, wide ? daySide(day, answer.side, more) : '');
    const also = putSide(pills, wide ? '' : sidePills(day, answer.side, { ...more, open: pill }));
    if (drew || also) fitWithin(wide ? column : pills);
    side.settle(day, answer.side);
  }

  /** @type {Map<HTMLElement, string>} */
  const sideDrawn = new Map();

  /**
   * @param {HTMLElement} box
   * @param {string} markup
   */
  function putSide(box, markup) {
    if (sideDrawn.get(box) === markup) return false;
    sideDrawn.set(box, markup);
    const frame = box.querySelector(`[data-map="${DAY_MAP}"]`);
    if (!frame) {
      box.innerHTML = markup;
      return true;
    }
    const next = document.createElement('template');
    next.innerHTML = markup;
    const place = next.content.querySelector(`[data-map="${DAY_MAP}"]`);
    if (place) {
      for (const { name, value } of place.attributes) if (name !== 'class') frame.setAttribute(name, value);
      place.replaceWith(frame);
    }
    box.replaceChildren(next.content);
    return true;
  }

  /** @param {string} id */
  function pointOf(id) {
    const fold = blockWith(id)?.fold ?? foldsOf(items).find(each => each.episode === id);
    if (!answer || fold?.kind !== 'stay' || !fold.episode) return null;
    const episode = fold.episode;
    const place = answer.side.places.find(each => each.rows.includes(episode));
    return place ? { latitude: place.point.latitude, longitude: place.point.longitude } : null;
  }

  function drawInspector() {
    const asked = named || focus;
    side.moment(focus ? pointOf(focus) : null);
    if (!focus || !day) {
      inPanel = '';
      if (panel.isOpen()) panel.close();
      return;
    }
    if (inPanel === `${day} ${asked}` && panel.isOpen()) return;
    inPanel = `${day} ${asked}`;
    panel.show([{ on: day, focus: asked, ...unmarked ? { marks: [] } : {} }], 0, { openDay: false });
  }

  function drawAll() {
    drawBar();
    drawDay();
    drawSide();
    drawInspector();
  }


  const navItems = () => /** @type {HTMLElement[]} */ ([...listBox.querySelectorAll('[data-d-nav]')]);
  /** @param {HTMLElement} element */
  const itemKey = element => element.dataset.dHour ? `hour:${element.dataset.dHour}`
    : element.dataset.dRow ? `row:${element.dataset.dRow}` : `stay:${element.dataset.dStay}`;
  /** @param {string} key */
  const itemOf = key => navItems().find(element => itemKey(element) === key) ?? null;

  /** @param {string} key */
  function roveTo(key) {
    const items_ = navItems();
    const on = items_.find(element => itemKey(element) === key) ?? items_[0];
    for (const element of items_) element.tabIndex = element === on ? 0 : -1;
    return on ?? null;
  }

  /** @param {HTMLElement | null} element */
  function focusItem(element) {
    if (!element) return;
    cursor = itemKey(element);
    roveTo(cursor);
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: 'nearest' });
  }

  /** @param {number} top */
  function keepRoom(top) {
    listBox.style.minHeight = '';
    if (top <= scroll.scrollHeight - scroll.clientHeight) return;
    const from = listBox.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
    listBox.style.minHeight = `${top + scroll.clientHeight - from}px`;
    roomFor = top;
  }
  let roomFor = 0;

  const pins = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const block = /** @type {HTMLElement} */ (entry.target.parentElement);
      const top = entry.rootBounds?.top ?? 0;
      block.classList.toggle('is-pinned', block.classList.contains('is-open') && entry.isIntersecting
        && entry.intersectionRatio < 1 && entry.boundingClientRect.top <= top + 1);
    }
  }, { root: scroll, rootMargin: '-1px 0px 0px 0px', threshold: [0, 1] });
  function markPinned() {
    pins.disconnect();
    for (const block of /** @type {NodeListOf<HTMLElement>} */ (listBox.querySelectorAll('.dy-block'))) {
      const head = block.querySelector(':scope > .dy-head, :scope > .dy-row--move');
      if (block.classList.contains('is-open') && head) pins.observe(head);
      else block.classList.remove('is-pinned');
    }
  }


  /** @param {string} key */
  const foldOf = key => foldsOf(items).find(fold => fold.key === key);
  /** @param {string} key */
  const blockElement = key => /** @type {HTMLElement | null} */ (listBox.querySelector(`.dy-block[data-d-block="${CSS.escape(key)}"]`));

  /**
   * @param {string} key
   * @param {boolean} open
   * @param {boolean} [animate]
   */
  function setOpen(key, open, animate = true) {
    const held = view();
    const fold = foldOf(key);
    const element = blockElement(key);
    if (!fold || !element || !answer || isOpen(fold, foldView()) === open || !opens(fold)) return;
    held.open.set(key, open);
    const body = /** @type {HTMLElement} */ (element.querySelector('.dy-block__body'));
    const head = /** @type {HTMLElement} */ (element.querySelector('[data-d-stay]'));
    const pinned = !open && element.getBoundingClientRect().top < scroll.getBoundingClientRect().top;
    const headAt = head.getBoundingClientRect().top;
    const before = body.offsetHeight;
    const leaving = animate ? /** @type {HTMLElement | null} */ (body.firstElementChild?.cloneNode(true) ?? null) : null;
    if (pinned) listBox.style.minHeight = `${listBox.offsetHeight}px`;
    element.classList.toggle('is-open', open);
    head.setAttribute('aria-expanded', String(open));
    (head.closest('.dy-head') ?? head).classList.toggle('is-open', open);
    const time = fold.start_ms === null ? '' : clock(fold.start_ms);
    const said = [time, lengthOf(fold)].filter(Boolean).join(', ');
    head.setAttribute('aria-label', `${open ? 'Fold' : 'Open'} ${fold.name}${said ? `, ${said}` : ''}`);
    if (fold.kind === 'move') {
      const fresh = document.createElement('div');
      fresh.innerHTML = moveHeadRow(fold, foldView());
      const row = fresh.querySelector('[data-d-stay]');
      if (row) head.replaceWith(row);
    }
    body.innerHTML = blockBody(fold, foldView(), answer);
    sizeRuns(body);
    fitWithin(element);
    if (pinned) {
      const want = scroll.scrollTop + /** @type {HTMLElement} */ (element.querySelector('[data-d-stay], .dy-head')).getBoundingClientRect().top - headAt;
      keepRoom(want);
      scroll.scrollTop = want;
    }
    roveTo(cursor);
    if (animate) grow(body, before, open, leaving);
    markPinned();
  }

  /**
   * @param {HTMLElement} body
   * @param {number} before
   * @param {boolean} open
   * @param {HTMLElement | null} leaving
   */
  function grow(body, before, open, leaving) {
    const after = body.offsetHeight;
    const duration = ms(open ? '--duration-open' : '--duration-fold');
    const easing = open ? 'cubic-bezier(0.2, 0, 0, 1)' : 'cubic-bezier(0.45, 0, 0.25, 1)';
    const fast = ms('--duration-fast');
    if (leaving) {
      leaving.classList.add('dy-leaving');
      leaving.setAttribute('aria-hidden', 'true');
      leaving.inert = true;
      body.append(leaving);
      body.classList.add('is-leaving');
      const gone = () => {
        leaving.remove();
        if (!body.querySelector(':scope > .dy-leaving')) body.classList.remove('is-leaving');
      };
      const fading = leaving.animate([{ opacity: 1 }, { opacity: 0 }], { duration: open ? fast : duration, easing, fill: 'forwards' });
      void fading.finished.then(gone, gone);
    }
    if (!motion()) {
      body.firstElementChild?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: fast, easing: 'ease-out' });
      return;
    }
    body.animate([{ height: `${before}px`, overflow: 'hidden' }, { height: `${after}px`, overflow: 'hidden' }], { duration, easing });
    if (!open) {
      body.firstElementChild?.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing });
      return;
    }
    const stagger = duration / 24;
    const rows = /** @type {HTMLElement[]} */ ([...body.querySelectorAll('.dy-row')]).slice(0, 8);
    rows.forEach((row, at) => row.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }],
      { duration: duration - at * stagger, easing, delay: at * stagger, fill: 'backwards' }));
  }

  /**
   * @param {string} key
   * @param {boolean} open
   */
  function setHour(key, open) {
    const held = view();
    const fold = foldOf(key.slice(0, key.lastIndexOf('#')));
    const block = fold?.blocks.find(each => each.key === key);
    if (!fold || !block || !answer || hourOpen(block, foldView()) === open) return;
    held.hours.set(key, open);
    const box = /** @type {HTMLElement | null} */ (listBox.querySelector(`[data-d-hourbox="${CSS.escape(key)}"]`));
    if (!box) return;
    const body = /** @type {HTMLElement} */ (box.querySelector('.dy-hour__rows'));
    const line = /** @type {HTMLElement} */ (box.querySelector('[data-d-hour]'));
    const before = body.offsetHeight;
    const leaving = open ? null : /** @type {HTMLElement | null} */ (body.firstElementChild?.cloneNode(true) ?? null);
    box.classList.toggle('is-open', open);
    line.classList.toggle('is-open', open);
    line.setAttribute('aria-expanded', String(open));
    body.innerHTML = open ? hourRows(block, fold, foldView(), answer) : '';
    sizeRuns(body);
    fitWithin(body);
    roveTo(cursor);
    grow(body, before, open, leaving);
  }

  /** @param {boolean} open */
  function setAll(open) {
    if (!answer) return;
    const held = view();
    for (const fold of foldsOf(items)) if (opens(fold)) held.open.set(fold.key, open);
    if (!open) held.hours.clear();
    const keep = scroll.scrollTop;
    drawDay();
    scroll.scrollTop = open ? keep : 0;
    if (cursor) focusItem(itemOf(cursor) ?? navItems()[0] ?? null);
  }

  /**
   * @param {string} id
   * @param {{ flash?: boolean, top?: boolean }} [how]
   */
  function revealRow(id, { flash = true, top = false } = {}) {
    const found = blockWith(id);
    if (!found) return;
    setOpen(found.fold.key, true, false);
    if (found.hour) setHour(found.hour, true);
    const row = /** @type {HTMLElement | null} */ (listBox.querySelector(`[data-d-at="${CSS.escape(id)}"]`));
    if (!row) return;
    row.scrollIntoView({ block: top ? 'start' : 'center' });
    markPinned();
    if (flash) {
      row.classList.add('is-flash');
      setTimeout(() => row.classList.remove('is-flash'), ms('--duration-draw'));
    }
    if (row.matches('[data-d-nav]')) {
      cursor = itemKey(row);
      roveTo(cursor);
    }
  }

  /** @param {string} id */
  function rowFocus(id) {
    for (const item of items) {
      const rows = item.type === 'row' ? [item.row] : item.type === 'fold' ? item.fold.blocks.flatMap(block => block.rows) : [];
      const found = rows.find(row => row.key === id);
      if (found) return found.focus ?? '';
    }
    return '';
  }

  /**
   * @param {string} id
   * @returns {{ fold: Fold, hour: string } | null}
   */
  function blockWith(id) {
    for (const fold of foldsOf(items)) {
      const block = fold.blocks.find(each => each.rows.some(row => row.key === id));
      if (block) return { fold, hour: block.kind === 'hour' ? block.key : '' };
    }
    return null;
  }

  /** @param {{ blocks: string[], rows: string[] }} what */
  function reveal({ blocks, rows }) {
    for (const key of blocks) setOpen(key, true, false);
    for (const id of rows) {
      const found = blockWith(id);
      if (!found) continue;
      setOpen(found.fold.key, true, false);
      if (found.hour) setHour(found.hour, true);
    }
    if (rows.length) revealRow(rows[0], { top: true });
    else if (blocks.length) blockElement(blocks[0])?.scrollIntoView({ block: 'start' });
    markPinned();
  }

  function markSelected() {
    for (const row of /** @type {NodeListOf<HTMLElement>} */ (listBox.querySelectorAll('[data-d-row]'))) {
      const on = row.dataset.dRow === focus;
      row.classList.toggle('is-selected', on);
      if (on) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
    }
  }


  function readList() {
    listAgain = listReads !== null;
    return listReads ??= (async () => {
      do {
        listAgain = false;
        try {
          const before = days().join();
          /** @type {WrittenDay[]} */
          const found = [];
          /** @type {Days | null} */
          let page = null;
          /** @type {string | null} */
          let after = null;
          do {
            page = /** @type {Days} */ (await fetchPage('days', { limit: LIST_PAGE, ...after ? { after } : {} }));
            found.push(...page.days);
            after = page.next;
          } while (after !== null);
          if (listAt !== null && !atOrPast(page.position, listAt)) continue;
          listAt = page.position;
          list = found;
          opening = page.opening;
          if (day && days().join() !== before) drawBar();
        } catch {
        }
      } while (listAgain);
      listReads = null;
    })();
  }

  /** @type {Map<string, Promise<Day>>} */
  const ahead = new Map();

  /** @param {string} on */
  const dayOf = on => /** @type {Promise<Day>} */ (fetchPage('day', { day: on }));

  /**
   * @param {string} on
   * @param {Day} landed
   */
  function keep(on, landed) {
    const held = read.get(on);
    if (held && !atOrPast(landed.position, held.position)) return held;
    read.delete(on);
    read.set(on, landed);
    for (const old of read.keys()) {
      if (read.size <= KEPT) break;
      read.delete(old);
    }
    return landed;
  }

  /**
   * @param {boolean} quiet
   * @param {import('../lib/reach.js').Retry | null} [retry]
   */
  async function readDay(quiet, retry = null) {
    const asked = day;
    const mine = ++generation;
    const begun = reach.begin(retry);
    if (waiting !== null) clearTimeout(waiting);
    waiting = null;
    const reading_ = ahead.get(asked) ?? dayOf(asked);
    ahead.delete(asked);
    if (!quiet) {
      status = 'loading';
      failure = null;
      answer = null;
      items = [];
      drawAll();
    }
    try {
      const landed = await reading_;
      if (mine !== generation || asked !== day) return;
      land(keep(asked, landed), quiet);
      readNeighbours();
    } catch (error) {
      if (mine !== generation || asked !== day) return;
      if (quiet && answer) return;
      answer = null;
      items = [];
      failure = reach.failed(error, begun, readAgain);
      status = failure.kind === 'lack' ? 'error' : 'loading';
      if (failure.kind === 'wait') waiting = setTimeout(() => readAgain(), Math.max(0, failure.until - Date.now()));
      land(null, quiet);
    }
  }

  /**
   * @param {Day | null} landed
   * @param {boolean} quiet
   */
  function land(landed, quiet) {
    if (landed) {
      if (answer?.day === landed.day && !atOrPast(landed.position, answer.position)) return;
      answer = landed;
      items = itemsOf(landed);
      status = 'ready';
      failure = null;
      readAtUntil(landed);
    }
    const at = scroll.scrollTop;
    context.title(longDay(day, today().slice(0, 4)));
    drawAll();
    scroll.scrollTop = quiet ? at : view().scroll;
    onScroll();
    if (!quiet && focus) revealRow(focus, { flash: false });
  }

  /** @param {Day} landed */
  function readAtUntil(landed) {
    if (until !== null) clearTimeout(until);
    until = null;
    const at = landed.until_ms;
    if (at === null || at === untilFired) return;
    until = setTimeout(() => {
      until = null;
      untilFired = at;
      if (day === landed.day && !container.hidden) void readDay(true);
    }, Math.max(0, at - Date.now()));
  }


  /** @param {string} next */
  function show(next) {
    if (day) view().scroll = scroll.scrollTop;
    picker?.close();
    day = next;
    cursor = '';
    pill = '';
    context.title(longDay(day, today().slice(0, 4)));
    const held = read.get(day);
    if (held) {
      generation += 1;
      answer = null;
      land(held, false);
      readNeighbours();
      readTodayBehind();
    } else void readDay(false);
  }

  function readTodayBehind() {
    if (behind !== null || container.hidden) return;
    behind = requestAnimationFrame(() => setTimeout(() => {
      behind = null;
      if (answer?.now_ms !== null && answer?.day === day && !container.hidden) void readDay(true);
    }));
  }

  function readNeighbours() {
    if (container.hidden) return;
    const [before, after] = [earlier(), later()];
    requestAnimationFrame(() => setTimeout(() => {
      readAhead(before);
      readAhead(after);
    }));
  }

  /** @param {string | null | undefined} on */
  function readAhead(on) {
    if (!on || read.has(on) || ahead.has(on)) return;
    const reading_ = dayOf(on);
    ahead.set(on, reading_);
    reading_.then(landed => {
      if (ahead.get(on) !== reading_) return;
      ahead.delete(on);
      keep(on, landed);
      const open = read.get(day);
      if (open) keep(day, open);
    }).catch(() => {
      if (ahead.get(on) === reading_) ahead.delete(on);
    });
  }

  /** @param {string} next */
  function goDay(next) {
    if (!next || next === day) return;
    focus = '';
    named = '';
    unmarked = false;
    context.set({ on: next, focus: '' }, true);
    show(next);
  }

  /** @type {{ attr: string, value: string }[] | null} */
  let opener = null;

  /**
   * @param {string} id
   * @param {{ attr: string, value: string }[] | null} [from]
   */
  function openRow(id, from = null) {
    if (id !== focus) {
      named = rowFocus(id);
      unmarked = named !== '';
    }
    opener = id ? from : null;
    focus = id;
    context.set({ focus: id });
    markSelected();
    drawInspector();
  }

  const openingDay = () => opening || today();

  function togglePicker() {
    if (picker) {
      picker.close();
      return;
    }
    const titleNow = () => /** @type {HTMLElement | null} */ (bar.querySelector('[data-d-title]'));
    /** @param {boolean} open */
    const opened = open => {
      titleNow()?.classList.toggle('is-open', open);
      titleNow()?.setAttribute('aria-expanded', String(open));
    };
    const title = titleNow();
    if (!title || !list) return;
    const host = part('picker');
    host.style.left = `${title.getBoundingClientRect().left - root.getBoundingClientRect().left + 8}px`;
    picker = installMonthPicker(host, {
      dates: list.map(entry => ({ day: entry.day, total: entry.counts.total })), selected: day, today: today(),
      returnTo: titleNow,
      onSelect: chosen => goDay(chosen),
      onClose: () => {
        picker = null;
        opened(false);
      },
    });
    opened(true);
  }

  bar.addEventListener('pointerover', event => {
    const arrow = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest?.('[data-d-day]') ?? null);
    if (arrow?.dataset.dDay) readAhead(arrow.dataset.dDay);
  });


  /** @type {[string, (element: HTMLElement, event: MouseEvent) => void][]} */
  const actions = [
    ['data-d-title', () => togglePicker()],
    ['data-d-day', element => goDay(String(element.dataset.dDay))],
    ['data-d-today', () => goDay(openingDay())],
    ['data-d-stay', (element, event) => {
      const key = String(element.dataset.dStay);
      const fold = foldOf(key);
      const open = Boolean(fold && isOpen(fold, foldView()));
      cursor = `stay:${key}`;
      if (event.altKey) setAll(!open);
      else setOpen(key, !open);
    }],
    ['data-d-hour', (element, event) => {
      const key = String(element.dataset.dHour);
      const open = hourIsOpen(key);
      cursor = `hour:${key}`;
      if (event.altKey) setAll(!open);
      else setHour(key, !open);
    }],
    ['data-d-row', element => {
      const id = String(element.dataset.dRow);
      cursor = `row:${id}`;
      roveTo(cursor);
      openRow(focus === id ? '' : id);
    }],
    ['data-d-name', element => {
      const id = String(element.dataset.dName);
      const stay = /** @type {HTMLElement | null} */ (element.closest('.dy-block'))?.querySelector('[data-d-stay]');
      const head = stay instanceof HTMLElement && stay.dataset.dStay ? [{ attr: 'data-d-stay', value: stay.dataset.dStay }] : [];
      openRow(focus === id ? '' : id, [{ attr: 'data-d-name', value: id }, ...head]);
    }],
    ['data-d-photo', element => {
      const fold = foldOf(String(element.dataset.dBlock));
      if (!fold) return;
      openPhotoViewer(fold.photos.map(photo => photo.hash), Number(element.dataset.dPhoto),
        { closed: () => element.focus({ preventScroll: true }) });
    }],
    ['data-d-place', element => revealIds(String(element.dataset.dRows ?? ''))],
    ['data-d-person', element => revealIds(String(element.dataset.dRows ?? ''))],
    ['data-d-group', element => {
      const id = String(element.dataset.dGroup);
      const from = pill && element.closest('[data-part="pills"]')
        ? [{ attr: 'data-d-pill', value: pill }] : [{ attr: 'data-d-group', value: id }, { attr: 'data-d-pill', value: 'people' }];
      closePill(false);
      openRow(id, from);
    }],
    ['data-d-pill', element => {
      pill = pill === element.dataset.dPill ? '' : String(element.dataset.dPill);
      drawSide();
    }],
    ['data-d-retry', () => void readDay(false)],
  ];
  const selector = actions.map(([name]) => `[${name}]`).join(',');

  /** @param {string} key */
  function hourIsOpen(key) {
    const block = foldOf(key.slice(0, key.lastIndexOf('#')))?.blocks.find(each => each.key === key);
    return Boolean(block && hourOpen(block, foldView()));
  }

  /** @param {string} ids */
  function revealIds(ids) {
    const named_ = new Set(ids.split(' ').filter(Boolean));
    const folds = foldsOf(items).filter(fold => named_.has(String(fold.episode)));
    const rows = [...named_].filter(id => !folds.some(fold => fold.episode === id));
    closePill(false);
    reveal({ blocks: folds.map(fold => fold.key), rows });
  }

  /** @param {boolean} [refocus] */
  function closePill(refocus = true) {
    if (!pill) return;
    const was = pill;
    pill = '';
    drawSide();
    if (refocus) /** @type {HTMLElement | null} */ (part('pills').querySelector(`[data-d-pill="${CSS.escape(was)}"]`))?.focus();
  }

  root.addEventListener('click', event => {
    const target = /** @type {Element} */ (event.target);
    const control = /** @type {HTMLElement | null} */ (target.closest(selector));
    if (!control) {
      const band = /** @type {HTMLElement | null} */ (target.closest('.dy-block:not(.is-reading) .dy-names'));
      const key = band?.closest('.dy-block')?.getAttribute('data-d-block');
      if (key) setOpen(key, true);
      return;
    }
    if (!root.contains(control) || control.matches(':disabled') || control.closest('.dy-panel, .dy-pickhost')) return;
    actions.find(([name]) => control.hasAttribute(name))?.[1](control, /** @type {MouseEvent} */ (event));
  });
  document.addEventListener('pointerdown', event => {
    if (pill && !(/** @type {Element} */ (event.target)).closest('[data-part="pills"]')) closePill(false);
  }, true);


  const owned = () => {
    const active = document.activeElement;
    if (!active || active === document.body) return false;
    return active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement
      || (active instanceof HTMLElement && active.isContentEditable)
      || Boolean(active.closest('.ck-fmenu__panel, [role="menu"], .ck-mgrid, .ck-popover'));
  };

  /** @param {KeyboardEvent} event */
  const onKey = event => {
    if (event.defaultPrevented || container.hidden || !container.isConnected) return;
    if (event.key === 'Escape' && pill) {
      event.preventDefault();
      closePill();
      return;
    }
    if (owned()) return;
    const active = /** @type {HTMLElement | null} */ (document.activeElement);
    const inPanel_ = Boolean(active?.closest('.dy-panel'));
    if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      goDay((event.key === 'ArrowLeft' ? earlier() : later()) ?? '');
      return;
    }
    if (event.metaKey || event.ctrlKey || inPanel_) return;
    if ((event.key === 't' || event.key === 'T') && !event.altKey) {
      event.preventDefault();
      goDay(openingDay());
      return;
    }
    if (event.key === 'Escape') {
      if (active && listBox.contains(active)) {
        event.preventDefault();
        active.blur();
      }
      return;
    }
    if (status !== 'ready') return;
    const item = active?.closest('[data-d-nav]');
    const on = item instanceof HTMLElement && listBox.contains(item) ? item : null;
    const items_ = navItems();
    const kind = on ? (on.dataset.dHour ? 'hour' : on.dataset.dRow ? 'row' : 'stay') : '';
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (event.altKey) return;
        event.preventDefault();
        const at = on ? items_.indexOf(on) : -1;
        focusItem(items_[Math.max(0, Math.min(items_.length - 1, at < 0 ? 0 : at + (event.key === 'ArrowDown' ? 1 : -1)))] ?? null);
        return;
      }
      case 'Home':
      case 'End':
        event.preventDefault();
        focusItem((event.key === 'Home' ? items_[0] : items_.at(-1)) ?? null);
        if (event.key === 'Home') scroll.scrollTop = 0;
        else scroll.scrollTop = scroll.scrollHeight;
        return;
      default:
        break;
    }
    if (event.altKey && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
      event.preventDefault();
      setAll(event.key === 'ArrowRight');
      return;
    }
    if (!on) return;
    const toggle = (/** @type {boolean | null} */ open) => {
      if (kind === 'hour') {
        const key = String(on.dataset.dHour);
        setHour(key, open ?? !hourIsOpen(key));
      } else {
        const key = String(on.dataset.dStay);
        const fold = foldOf(key);
        setOpen(key, open ?? !(fold && isOpen(fold, foldView())));
      }
      focusItem(itemOf(cursor));
    };
    cursor = itemKey(on);
    if (event.key === 'ArrowRight' || event.key === ' ') {
      event.preventDefault();
      if (kind === 'row') openRow(String(on.dataset.dRow));
      else toggle(true);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (kind === 'row') openRow(String(on.dataset.dRow));
      else toggle(null);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (kind !== 'row') {
        toggle(false);
        return;
      }
      const found = blockWith(String(on.dataset.dRow));
      if (!found) return;
      if (found.hour) {
        cursor = `hour:${found.hour}`;
        setHour(found.hour, false);
      } else {
        cursor = `stay:${found.fold.key}`;
        setOpen(found.fold.key, false);
      }
      focusItem(itemOf(cursor));
    }
  };
  document.addEventListener('keydown', onKey);


  function onScroll() {
    if (listBox.style.minHeight && scroll.scrollTop < roomFor) {
      listBox.style.minHeight = `${Math.max(0, parseFloat(listBox.style.minHeight) - (roomFor - scroll.scrollTop))}px`;
      roomFor = scroll.scrollTop;
    }
    markPinned();
  }
  scroll.addEventListener('scroll', onScroll, { passive: true });
  listBox.addEventListener('contentvisibilityautostatechange', event => {
    const run = event.target;
    if (run instanceof HTMLElement && !/** @type {Event & { skipped: boolean }} */ (event).skipped) fitWithin(run);
  }, true);
  let width = 0;
  new ResizeObserver(entries => {
    const next = Math.round(entries[0]?.contentRect.width ?? 0);
    if (next === width) return;
    width = next;
    if (status === 'ready') fitWithin(listBox);
  }).observe(listBox);
  new ResizeObserver(entries => {
    const width_ = entries[0]?.contentRect.width ?? 0;
    if (width_ === 0) return;
    const next = width_ >= SIDE_PANE;
    if (next === wide) return;
    wide = next;
    pill = '';
    drawSide();
  }).observe(root);


  onHomeChange(change => {
    if (change.reset || change.clockMoved) {
      read.clear();
      ahead.clear();
    }
    for (const changed of change.days) {
      read.delete(changed);
      ahead.delete(changed);
    }
    if (pageMoved('days', change, listAt)) void readList();
    if (change.clock && day) {
      context.title(longDay(day, today().slice(0, 4)));
      drawAll();
    }
    if (day && (change.reset || change.clockMoved || change.days.has(day))) {
      void readDay(true);
      if (panel.isOpen()) panel.redraw();
    }
  }, container);

  function tellNow() {
    if (!answer || answer.now_ms === null) return;
    const now = Date.now();
    const row = listBox.querySelector('.dy-row--now');
    const time = row?.querySelector('.dy-row__time');
    if (row && time) {
      const drawn = document.createElement('template');
      drawn.innerHTML = dayRow('now', { now: { time: clock(now), updated: answer.updated_ms === null ? '' : clock(answer.updated_ms) } });
      const fresh = /** @type {Element} */ (drawn.content.firstElementChild);
      time.textContent = clock(now);
      row.setAttribute('aria-label', String(fresh.getAttribute('aria-label')));
    }
    for (const plan of answer.plans) {
      const element = listBox.querySelector(`[data-d-at="${CSS.escape(plan.key)}"]`);
      const run = /** @type {HTMLElement | null} */ (element?.querySelector('.dy-row__words [data-w]') ?? null);
      if (!element || !run) continue;
      const words = aheadOf(plan, now);
      const was = run.dataset.full ?? run.textContent ?? '';
      if (run.dataset.full !== undefined) run.dataset.full = words;
      else run.textContent = words;
      element.setAttribute('aria-label', String(element.getAttribute('aria-label')).replace(was, words));
    }
  }

  setInterval(() => {
    if (container.hidden || status !== 'ready' || !answer || answer.now_ms === null) return;
    tellNow();
  }, 60_000);

  /** @param {Route} route */
  function follow(route) {
    if (route.on && route.on !== day) {
      focus = route.focus;
      named = '';
      unmarked = false;
      show(route.on);
    } else if (route.focus !== focus) {
      openRow(route.focus);
      if (route.focus) revealRow(route.focus, { flash: false });
    }
    if (!route.on && day) context.set({ on: day });
  }

  focus = context.route.focus;
  if (context.route.on) show(context.route.on);
  else drawAll();
  void readList().then(() => {
    if (day) {
      drawBar();
      readNeighbours();
    } else {
      context.set({ on: openingDay() });
      show(openingDay());
    }
  });

  return {
    update: follow,
    focus: () => readTodayBehind(),
  };
};
