// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { boldLine } from './bold-line.js';
import { bar } from './skeleton.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_MS = 86_400_000;

/** @param {number[]} counts */
function top(counts) {
  const [most = 0, next = 0] = [...counts].sort((a, b) => b - a).map(count => Math.max(0, count));
  return next > 0 && most > 4 * next ? 1.25 * next : most;
}

/** @param {number} count */
const number = count => count.toLocaleString('en-US');

/**
 * @param {string} end
 * @param {number} length
 */
function daysEnding(end, length) {
  const last = Date.parse(`${end}T00:00:00Z`);
  return Array.from({ length }, (_, index) => {
    const date = new Date(last - (length - 1 - index) * DAY_MS);
    const weekday = WEEKDAYS[date.getUTCDay()];
    return { weekday, words: `${weekday} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}` };
  });
}

/**
 * @param {string} amount
 * @param {string} words
 * @param {string} [className]
 */
const reading = (amount, words, className = '') => `<p class="ck-week__figure${className}">`
  + `<span class="ck-week__n mac-display">${esc(amount)}</span>`
  + `<span class="ck-week__unit mac-body">${esc(words)}</span>`
  + '</p>';

/**
 * @typedef {object} DaysFigure
 * @property {number | null} today
 * @property {[string, string] | null} noun
 * @property {string} last
 * @property {number[] | null} week
 * @property {string} end
 * @property {number} [lit]
 * @property {string} [unit]
 * @property {import('./bold-line.js').Bolded} [said]
 */

/** @typedef {{ count: number, words: string, spoken: string, attrs?: Record<string, string> }} Bar */

/**
 * @typedef {object} BarsFigure
 * @property {string | null} amount
 * @property {string} words
 * @property {string} [line]
 * @property {Bar[]} bars
 * @property {number} [marked]
 * @property {string[]} [labels]
 * @property {[string, string]} [ends]
 * @property {string} [foot]
 * @property {string} label
 */

/** @param {DaysFigure | BarsFigure} figure */
export const weekFigure = figure => 'bars' in figure ? barsFigure(figure) : daysFigure(figure);

/** @param {DaysFigure} figure */
function daysFigure({ today, noun, last, week, end, lit = -1, unit, said = [] }) {
  /** @param {number} count */
  const nounWords = count => noun ? (count === 1 ? noun[0] : noun[1]) : '';
  const tail = `<p class="ck-week__last mac-subhead">${esc(last)}</p>`;
  const under = said.length ? boldLine(said, { attrs: { class: 'ck-week__said' } }) : '';
  if (today === null) return counting(tail, end);
  const rest = reading(number(today), unit ?? [nounWords(today), 'today'].filter(Boolean).join(' '), ' is-rest');
  if (!week?.length) return `<figure class="ck-week">${rest}${tail}${under}</figure>`;
  const counts = week.slice(-7);
  const most = top(counts);
  const days = daysEnding(end, counts.length);
  const readings = counts.map((count, index) => reading(number(count),
    [nounWords(count), days[index].words].filter(Boolean).join(' · '))).join('');
  const bars = counts.map((count, index) => {
    const height = count > 0 && most > 0 ? Math.round(Math.min(1, count / most) * 1000) / 10 : 0;
    const classes = ['ck-week__day', index === counts.length - 1 ? 'is-today' : '', count > 0 ? '' : 'is-zero',
      index === lit ? 'is-lit' : ''].filter(Boolean).join(' ');
    const words = `${days[index].words}, ${[number(count), nounWords(count)].filter(Boolean).join(' ')}`;
    return `<span class="${classes}" tabindex="0" role="img" aria-label="${esc(words)}">`
      + `<i${count > 0 ? ` data-geo="height:${height}%"` : ''}></i></span>`;
  }).join('');
  return `<figure class="ck-week" role="group" aria-label="This week">`
    + `<div class="ck-week__figures">${rest}${readings}</div>${tail}`
    + `<div class="ck-week__days">${bars}</div>${names(days)}${under}</figure>`;
}

/** @param {{ weekday: string }[]} days */
const names = days => '<figcaption class="ck-week__names mac-mono-time" aria-hidden="true">'
  + days.map(day => `<span>${esc(day.weekday)}</span>`).join('') + '</figcaption>';

/**
 * @param {string} tail
 * @param {string} end
 */
const counting = (tail, end) => '<figure class="ck-week is-reading" role="group" aria-label="This week, still counted"'
  + ` aria-busy="true"><p class="ck-week__figure is-rest"><span class="ck-week__n mac-display">${bar(2)}</span>`
  + `<span class="ck-week__unit mac-body">${bar(5)}</span></p>${tail}`
  + `<div class="ck-week__days" aria-hidden="true">${'<span class="ck-week__day"><i class="ck-sk"></i></span>'.repeat(7)}</div>`
  + `${names(daysEnding(end, 7))}</figure>`;

/** @param {BarsFigure} figure */
function barsFigure({ amount, words, line = '', bars, marked = -1, labels, ends, foot = '', label }) {
  const reading = amount === null;
  const most = top(bars.map(each => each.count));
  const drawn = bars.map((each, index) => {
    if (reading) return '<span class="ck-week__day"><i class="ck-sk"></i></span>';
    const height = each.count > 0 && most > 0 ? Math.max(4, Math.round(Math.min(1, each.count / most) * 1000) / 10) : 0;
    const classes = ['ck-week__day', index === marked ? 'is-marked' : '', each.count > 0 ? '' : 'is-zero']
      .filter(Boolean).join(' ');
    const said = { 'data-week-bar': '', 'data-amount': number(each.count), 'data-words': each.words };
    const mark = `<i${each.count > 0 ? ` data-geo="height:${height}%"` : ''}></i>`;
    if (each.count > 0 && each.attrs) {
      return `<button${attributes({ type: 'button', class: classes, 'aria-label': each.spoken, ...said, ...each.attrs })}>${mark}</button>`;
    }
    return `<span${attributes({ class: classes, role: 'img', 'aria-label': each.spoken, ...said,
      ...each.count > 0 ? { tabindex: '0' } : {} })}>${mark}</span>`;
  }).join('');
  const under = labels ? `<div class="ck-week__names mac-mono-time" aria-hidden="true">${labels.map(each => `<span>${esc(each)}</span>`).join('')}</div>`
    : ends ? `<div class="ck-week__ends mac-mono-time" aria-hidden="true"><span>${esc(ends[0])}</span><span>${esc(ends[1])}</span></div>` : '';
  const shown = reading ? bar(2) : esc(amount);
  return `<figure${attributes({ class: `ck-week ck-week--bars${reading ? ' is-reading' : ''}`, role: 'group', 'aria-label': label,
    ...reading ? { 'aria-busy': 'true' } : {} })}>`
    + `<p class="ck-week__figure is-rest"><span${attributes({ class: 'ck-week__n mac-display', 'data-week-n': '',
      'data-rest': amount ?? '' })}>${shown}</span>`
    + `<span${attributes({ class: 'ck-week__unit mac-body', 'data-week-words': '', 'data-rest': words })}>${esc(words)}</span></p>`
    + (line ? `<p class="ck-week__last mac-subhead">${esc(line)}</p>` : '')
    + `<div class="ck-week__days"${reading ? ' aria-hidden="true"' : ''}>${drawn}</div>${under}`
    + (foot ? `<p class="ck-week__foot mac-subhead">${esc(foot)}</p>` : '') + '</figure>';
}

/** @param {HTMLElement} root */
export function installWeekFigure(root) {
  /** @param {Element} figure @param {HTMLElement | null} lit */
  const show = (figure, lit) => {
    const amount = figure.querySelector('[data-week-n]');
    const words = figure.querySelector('[data-week-words]');
    if (!(amount instanceof HTMLElement) || !(words instanceof HTMLElement)) return;
    amount.textContent = (lit ? lit.dataset.amount : amount.dataset.rest) ?? '';
    words.textContent = (lit ? lit.dataset.words : words.dataset.rest) ?? '';
    for (const each of figure.querySelectorAll('[data-week-bar]')) each.classList.toggle('is-lit', each === lit);
  };
  /** @param {Event} event */
  const over = event => {
    const lit = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest('[data-week-bar]'));
    const figure = lit?.closest('.ck-week--bars');
    if (lit && figure) show(figure, lit);
  };
  /** @param {Event} event */
  const out = event => {
    const figure = /** @type {Element} */ (event.target).closest('.ck-week--bars');
    const into = /** @type {Element | null} */ (/** @type {FocusEvent} */ (event).relatedTarget);
    if (!figure || into?.closest('[data-week-bar]') && into.closest('.ck-week--bars') === figure) return;
    show(figure, null);
  };
  root.addEventListener('pointerover', over);
  root.addEventListener('focusin', over);
  root.addEventListener('pointerout', out);
  root.addEventListener('focusout', out);
}
