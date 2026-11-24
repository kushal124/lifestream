// @ts-check
import { birthdayMonth } from '../../lib/calendar.js';
import { textField } from './controls.js';
import { monthGrid } from './month-grid.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
  'November', 'December'];
const CELLS = 42;

/**
 * @param {object} calendar
 * @param {number} calendar.month
 * @param {number | null} calendar.day
 * @param {string} calendar.year
 * @param {number | null} calendar.typed
 * @param {{ year: number, month: number, day: number }} calendar.today
 * @param {number | null} [calendar.focus]
 * @param {boolean} [calendar.forced]
 * @param {string} [calendar.label]
 */
export function calendarPicker({ month, day, year, typed, today, focus = null, forced = false, label = 'Date' }) {
  const drawn = birthdayMonth(month, typed, today.year);
  const name = MONTHS[month - 1] ?? '';
  const todays = (typed === null || typed === today.year) && month === today.month;
  const stop = focus !== null && focus <= drawn.count ? focus
    : day !== null && day <= drawn.count ? day : todays ? today.day : 1;
  /** @type {import('./month-grid.js').MonthCell[]} */
  const days = Array.from({ length: drawn.count }, (_, at) => {
    const n = at + 1;
    const now = todays && n === today.day;
    return { n, on: n === day, today: now, focus: forced && n === stop, attrs: { tabindex: n === stop ? '0' : '-1',
      'aria-pressed': String(n === day), 'aria-current': now ? 'date' : null,
      'aria-label': `${n} ${name}${typed === null ? '' : ` ${typed}`}`, 'data-ck-cal-day': String(n) } };
  });
  /**
   * @param {number} n
   * @param {-1 | 1} by
   * @returns {import('./month-grid.js').MonthCell}
   */
  const beside = (n, by) => {
    const edge = (month === 1 && by < 0) || (month === 12 && by > 0) ? by : 0;
    return { n, out: true, attrs: { tabindex: '-1', 'aria-pressed': 'false',
      'aria-label': `${n} ${MONTHS[(month + 11 + by) % 12]}${typed === null ? '' : ` ${typed + edge}`}`,
      'data-ck-cal-day': String(n), 'data-ck-cal-out': String(by) } };
  };
  const lead = Array.from({ length: drawn.offset }, (_, at) => beside(drawn.before - drawn.offset + 1 + at, -1));
  const trail = Array.from({ length: CELLS - drawn.offset - drawn.count }, (_, at) => beside(at + 1, 1));
  return monthGrid({ label, fill: true, attrs: { 'data-ck-cal': '' }, cells: [...lead, ...days, ...trail],
    head: { name, live: true, less: { label: 'Previous month', attrs: { 'data-ck-cal-step': '-1' } },
      more: { label: 'Next month', attrs: { 'data-ck-cal-step': '1' } } },
    foot: '<label class="ck-mgrid__field"><span class="ck-mgrid__label mac-body">Year</span>'
      + textField({ label: 'Year, if you know it', value: year, placeholder: 'Optional',
        attrs: { inputmode: 'numeric', maxlength: '4', 'data-ck-cal-year': '' } })
      + '</label>' });
}
