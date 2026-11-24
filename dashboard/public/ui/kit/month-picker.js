// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { monthGrid as monthLayout } from '../../lib/calendar.js';
import { duration } from './duration.js';
import { longDay, monthName, monthOnly, shiftDay, shiftMonth } from '../../lib/words.js';
import { button } from './button.js';
import { installFilterMenus } from './filter-menu.js';
import { floatList } from './float-list.js';
import { icon } from './icon.js';
import { monthGrid, monthGridDays, monthGridHead } from './month-grid.js';

/**
 * @param {number} total
 * @param {number} most
 */
export function markOf(total, most) {
  if (total <= 0 || most <= 0) return 6;
  const share = total / most;
  return share > 0.75 ? 24 : share > 0.5 ? 18 : share > 0.25 ? 12 : 6;
}

/** @typedef {{ day: string, total: number }} PickerDate */

const CELLS = 42;

/** @typedef {{ dates: Map<string, number>, selected: string, today: string, month: string, focused: string, first: string, last: string }} PickerState */

/** @param {string} month */
export function gridDays(month) {
  const { offset } = monthLayout(month);
  const start = shiftDay(`${month}-01`, -offset);
  return Array.from({ length: CELLS }, (_, at) => shiftDay(start, at));
}

/**
 * @param {Map<string, number>} dates
 * @param {string} month
 */
const mostOf = (dates, month) => Math.max(0, ...[...dates].filter(([day]) => day.startsWith(month)).map(([, total]) => total));

/** @param {PickerState} state */
export function monthPicker(state) {
  return monthGrid({ label: 'Choose a day', counts: true, attrs: { 'data-k': 'picker' }, head: headOf(state),
    cells: cellsOf(state), grid: { label: monthName(state.month) },
    after: `<p class="sr-only" aria-live="polite" data-p-live>${esc(monthName(state.month))}</p>` });
}

/** @param {PickerState} state */
function headOf(state) {
  const year = state.month.slice(0, 4);
  /** @type {Map<string, number>} */
  const years = new Map();
  for (const day of state.dates.keys()) years.set(day.slice(0, 4), (years.get(day.slice(0, 4)) ?? 0) + 1);
  const listed = [...years].sort((left, right) => right[0].localeCompare(left[0]));
  return { name: monthOnly(state.month),
    after: '<div class="ck-fmenu ck-fmenu--float ck-fmenu--start ck-mgrid__year" data-p-year>'
      + `<button${attributes({ type: 'button', class: 'ck-fmenu__btn ck-menubtn mac-body', 'aria-haspopup': 'menu',
        'aria-expanded': 'false', 'aria-controls': 'dy-pick-years', 'aria-label': `Year: ${year}` })}>`
      + `<span class="ck-menubtn__words">${esc(year)}</span>${icon('expand', { size: 'xs', className: 'ck-fmenu__caret' })}</button>`
      + floatList({ label: 'Year', role: 'menu', className: 'ck-fmenu__panel', lit: null, attrs: { id: 'dy-pick-years', hidden: true },
        items: listed.map(([each, dates], at) => ({ name: each, count: dates, chosen: each === year,
          attrs: { id: `dy-pick-year-${at}`, 'data-value': each, class: 'ck-fmenu__item' } })) })
      + '</div>',
    tools: button('Today', { variant: 'plain', size: 'sm', disabled: state.month === state.today.slice(0, 7),
      attrs: { 'data-p-today': '' } }),
    less: { label: 'Earlier month', attrs: { 'data-p-step': '-1' }, disabled: state.month <= state.first },
    more: { label: 'Later month', attrs: { 'data-p-step': '1' }, disabled: state.month >= state.last } };
}

/**
 * @param {PickerState} state
 * @returns {import('./month-grid.js').MonthCell[]}
 */
function cellsOf(state) {
  /** @type {Map<string, number>} */
  const most = new Map();
  return gridDays(state.month).map(day => {
    const month = day.slice(0, 7);
    const own = month === state.month;
    const total = state.dates.get(day);
    const live = total !== undefined;
    if (live && !most.has(month)) most.set(month, mostOf(state.dates, month));
    const today = own && day === state.today;
    return { n: Number(day.slice(8)), out: !own, dim: !live, today, on: own && day === state.selected,
      mark: live ? markOf(/** @type {number} */ (total), most.get(month) ?? 0) : 0,
      attrs: { 'data-p-day': day, tabindex: day === state.focused ? '0' : '-1', 'aria-label': longDay(day, '-'),
        'aria-current': today ? 'date' : null, 'aria-disabled': live ? null : 'true' } };
  });
}

/**
 * @param {string} day
 * @param {number} by
 */
function stepped(day, by) {
  const month = shiftMonth(day.slice(0, 7), by);
  const last = Number(shiftDay(`${shiftMonth(month, 1)}-01`, -1).slice(8));
  return `${month}-${String(Math.min(Number(day.slice(8)), last)).padStart(2, '0')}`;
}

/**
 * @param {HTMLElement} host
 * @param {object} options
 * @param {{ day: string, total: number }[]} options.dates
 * @param {string} options.selected
 * @param {string} options.today
 * @param {(day: string) => void} options.onSelect
 * @param {() => void} options.onClose
 * @param {() => HTMLElement | null} options.returnTo
 * @returns {{ close: () => void, element: HTMLElement }}
 */
export function installMonthPicker(host, { dates, selected, today, onSelect, onClose, returnTo }) {
  const held = new Map(dates.map(entry => [entry.day, entry.total]));
  const days = [...held.keys()].sort();
  const thisMonth = today.slice(0, 7);
  const newest = (days.at(-1) ?? today).slice(0, 7);
  /** @type {PickerState} */
  const state = {
    dates: held, selected, today, month: (selected || today).slice(0, 7), focused: selected || today,
    first: (days[0] ?? today).slice(0, 7), last: newest > thisMonth ? newest : thisMonth,
  };
  host.innerHTML = monthPicker(state);
  const panel = /** @type {HTMLElement} */ (host.firstElementChild);
  const grid = /** @type {HTMLElement} */ (panel.querySelector('.ck-mgrid__days'));
  const head = /** @type {HTMLElement} */ (panel.querySelector('.ck-mgrid__head'));
  const live = /** @type {HTMLElement} */ (panel.querySelector('[data-p-live]'));
  const motion = () => !matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ms = (/** @type {string} */ token) => duration(panel, token);
  panel.animate(motion() ? [{ opacity: 0, transform: 'scale(0.98)' }, { opacity: 1, transform: 'none' }] : [{ opacity: 0 }, { opacity: 1 }],
    { duration: ms('--duration-base'), easing: 'cubic-bezier(0.2, 0, 0, 1)' });
  let closed = false;

  function redraw() {
    const month = state.month;
    const was = grid.dataset.month;
    head.innerHTML = monthGridHead(headOf(state));
    grid.innerHTML = monthGridDays(cellsOf(state), true);
    grid.setAttribute('aria-label', monthName(month));
    grid.dataset.month = month;
    if (was && was !== month) {
      live.textContent = monthName(month);
      grid.animate([{ opacity: 0.25 }, { opacity: 1 }], { duration: ms('--duration-fast'), easing: 'ease-out' });
    }
  }

  /** @param {string} day */
  function focusDay(day) {
    const lowest = `${state.first}-01`;
    const highest = shiftDay(`${shiftMonth(state.last, 1)}-01`, -1);
    const kept = day < lowest ? lowest : day > highest ? highest : day;
    state.focused = kept;
    if (kept.slice(0, 7) !== state.month) state.month = kept.slice(0, 7);
    redraw();
    /** @type {HTMLElement | null} */ (grid.querySelector(`[data-p-day="${kept}"]`))?.focus();
  }

  /** @param {string} month */
  function showMonth(month) {
    focusDay(stepped(state.focused, (Number(month.slice(0, 4)) - Number(state.month.slice(0, 4))) * 12
      + Number(month.slice(5)) - Number(state.month.slice(5))));
  }

  /** @param {string} day */
  function choose(day) {
    if (!held.has(day)) return;
    close();
    onSelect(day);
  }

  function close() {
    if (closed) return;
    closed = true;
    unwire();
    document.removeEventListener('pointerdown', onOutside, true);
    panel.removeEventListener('keydown', onKey);
    panel.removeEventListener('click', onClick);
    const leaving = panel.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms('--duration-fast'), easing: 'ease-out' });
    panel.style.pointerEvents = 'none';
    void leaving.finished.then(() => panel.remove(), () => panel.remove());
    if (!document.activeElement || document.activeElement === document.body || panel.contains(document.activeElement)) {
      returnTo()?.focus();
    }
    onClose();
  }

  /** @param {KeyboardEvent} event */
  function onKey(event) {
    if (event.defaultPrevented) return;
    const target = /** @type {HTMLElement} */ (event.target);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (!target.matches('[data-p-day]')) return;
    const day = String(target.dataset.pDay);
    const weekday = (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;
    /** @type {string | null} */
    let next = null;
    switch (event.key) {
      case 'ArrowLeft': next = shiftDay(day, -1); break;
      case 'ArrowRight': next = shiftDay(day, 1); break;
      case 'ArrowUp': next = shiftDay(day, -7); break;
      case 'ArrowDown': next = shiftDay(day, 7); break;
      case 'PageUp': next = stepped(day, event.shiftKey ? -12 : -1); break;
      case 'PageDown': next = stepped(day, event.shiftKey ? 12 : 1); break;
      case 'Home': next = shiftDay(day, -weekday); break;
      case 'End': next = shiftDay(day, 6 - weekday); break;
      case 't':
      case 'T': next = today; break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        event.stopPropagation();
        choose(day);
        return;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
    focusDay(next);
  }

  /** @param {MouseEvent} event */
  function onClick(event) {
    const target = /** @type {HTMLElement} */ (event.target);
    const day = /** @type {HTMLElement | null} */ (target.closest('[data-p-day]'));
    const step = /** @type {HTMLElement | null} */ (target.closest('[data-p-step]'));
    if (day) choose(String(day.dataset.pDay));
    else if (step && !step.matches(':disabled')) showMonth(shiftMonth(state.month, Number(step.dataset.pStep)));
    else if (target.closest('[data-p-today]')) focusDay(today);
  }

  /** @param {PointerEvent} event */
  function onOutside(event) {
    const target = /** @type {Node} */ (event.target);
    if (panel.contains(target) || returnTo()?.contains(target)) return;
    close();
  }

  const unwire = installFilterMenus(panel, (_, year) => {
    if (year) showMonth(`${year}-${state.month.slice(5)}`);
  });
  panel.addEventListener('keydown', onKey);
  panel.addEventListener('click', onClick);
  document.addEventListener('pointerdown', onOutside, true);
  grid.dataset.month = state.month;
  /** @type {HTMLElement | null} */ (grid.querySelector(`[data-p-day="${state.focused}"]`))?.focus();
  return { close, element: panel };
}
