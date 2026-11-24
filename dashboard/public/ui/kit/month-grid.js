// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { iconButton } from './button.js';

/** @typedef {import('../../lib/html.js').Attributes} Attributes */

const WEEK = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/** @typedef {{ n: number, attrs: Attributes, out?: boolean, dim?: boolean, today?: boolean, on?: boolean, focus?: boolean, mark?: number }} MonthCell */

/** @typedef {{ label: string, attrs: Attributes, disabled?: boolean }} MonthStep */

/** @param {{ name: string, after?: string, tools?: string, less: MonthStep, more: MonthStep, live?: boolean }} head */
export const monthGridHead = ({ name, after = '', tools = '', less, more, live = false }) =>
  `<span${attributes({ class: 'ck-mgrid__month mac-headline', 'aria-live': live ? 'polite' : null })}>${esc(name)}</span>${after}`
  + `<span class="ck-mgrid__tools">${tools}`
  + iconButton('back', less.label, { attrs: less.attrs, disabled: less.disabled ?? false, className: 'ck-mgrid__step' })
  + iconButton('forward', more.label, { attrs: more.attrs, disabled: more.disabled ?? false, className: 'ck-mgrid__step' })
  + '</span>';

/**
 * @param {MonthCell[]} cells
 * @param {boolean} [grid]
 */
export function monthGridDays(cells, grid = false) {
  const day = (/** @type {MonthCell} */ cell) => {
    const classes = ['ck-mgrid__day', 'mac-body', cell.out ? 'is-out' : '', cell.dim ? 'is-dim' : '', cell.today ? 'is-today' : '',
      cell.on ? 'is-on' : '', cell.focus ? 'is-focus' : ''].filter(Boolean).join(' ');
    return `<button${attributes({ type: 'button', class: classes, ...cell.attrs })}><span class="ck-mgrid__num">${cell.n}</span>`
      + (cell.mark ? `<span class="ck-mgrid__mark is-w${cell.mark}"></span>` : '') + '</button>';
  };
  if (!grid) return cells.map(day).join('');
  const rows = [];
  for (let week = 0; week < cells.length / 7; week += 1) {
    rows.push('<div role="row" class="ck-mgrid__row">' + cells.slice(week * 7, week * 7 + 7)
      .map(cell => `<div role="gridcell"${attributes({ 'aria-selected': String(Boolean(cell.on)) })}>${day(cell)}</div>`).join('') + '</div>');
  }
  return rows.join('');
}

/**
 * @param {object} month
 * @param {string} month.label
 * @param {Parameters<typeof monthGridHead>[0]} month.head
 * @param {MonthCell[]} month.cells
 * @param {{ label: string } | null} [month.grid]
 * @param {boolean} [month.counts]
 * @param {boolean} [month.fill]
 * @param {string} [month.foot]
 * @param {string} [month.after]
 * @param {Attributes} [month.attrs]
 */
export function monthGrid({ label, head, cells, grid = null, counts = false, fill = false, foot = '', after = '', attrs = {} }) {
  const classes = ['ck-mgrid', counts ? 'ck-mgrid--counts' : '', fill ? 'ck-mgrid--fill' : ''].filter(Boolean).join(' ');
  return `<div${attributes({ class: classes, role: grid ? 'dialog' : 'group', 'aria-label': label, ...attrs })}>`
    + `<div class="ck-mgrid__head">${monthGridHead(head)}</div>`
    + `<div class="ck-mgrid__week mac-mono-label" aria-hidden="true">${WEEK.map(each => `<span>${each}</span>`).join('')}</div>`
    + `<div${attributes({ class: 'ck-mgrid__days', role: grid ? 'grid' : null, 'aria-label': grid ? grid.label : null })}>`
    + `${monthGridDays(cells, Boolean(grid))}</div>`
    + (foot ? `<div class="ck-mgrid__foot">${foot}</div>` : '') + after + '</div>';
}
