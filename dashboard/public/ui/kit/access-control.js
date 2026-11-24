// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { spinner } from './button.js';
import { boldRuns } from './bold-line.js';
import { icon } from './icon.js';
import { signalShape } from './signal.js';

/** @typedef {import('../../lib/html.js').Attributes} Attributes */

/** @typedef {'on' | 'off' | 'some'} Check */

const MARKS = {
  on: '<path d="M4.5 8.2l2.3 2.3L11.5 5.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  some: '<path d="M4.5 8h7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  off: '',
};

/**
 * @param {object} check
 * @param {Check} check.state
 * @param {string} check.label
 * @param {Attributes} [check.attrs]
 * @param {boolean} [check.busy]
 * @param {boolean} [check.waits]
 * @param {boolean} [check.fixed]
 */
export const accessCheck = ({ state, label, attrs = {}, busy = false, waits = false, fixed = false }) => `<button${attributes({
  type: 'button', role: 'checkbox', class: `ck-check is-${state}${waits ? ' is-waiting' : ''}`,
  'aria-checked': state === 'some' ? 'mixed' : String(state === 'on'), 'aria-label': label, disabled: busy || fixed,
  'aria-busy': busy ? 'true' : null, ...attrs,
})}><svg class="ck-check__box" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">${MARKS[state]}</svg></button>`;

/**
 * @param {object} differs
 * @param {string} differs.words
 * @param {boolean} differs.open
 * @param {Attributes} differs.attrs
 */
export const differsFold = ({ words, open, attrs }) => `<button${attributes({ type: 'button', class: 'ck-srow__differs mac-subhead',
  'aria-expanded': String(open), ...attrs })}><span>${esc(words)}</span>`
  + `${icon(open ? 'collapse' : 'expand', { size: 'xs' })}</button>`;

/** @param {string} words */
export const differsFace = words => `<span>${esc(words)}</span>${icon('expand', { size: 'xs' })}`;

/**
 * @param {object} row
 * @param {string} row.name
 * @param {Check} row.check
 * @param {Attributes} row.attrs
 * @param {string} [row.icon]
 * @param {string} [row.line]
 * @param {string} [row.differs]
 * @param {string} [row.end]
 * @param {string} [row.endSaid]
 * @param {boolean} [row.busy]
 * @param {boolean} [row.waits]
 * @param {boolean} [row.fixed]
 * @param {boolean} [row.inner]
 */
export const checkedRow = ({ name, check, attrs, icon: meaning = '', line = '', differs = '', end = '', endSaid = '', busy = false,
  waits = false, fixed = false, inner = false }) => `<li${attributes({ class: ['ck-srow ck-srow--check', line ? '' : 'ck-srow--short',
  check === 'off' ? 'is-off' : '', inner ? 'is-inner' : ''].filter(Boolean).join(' ') })}>`
  + `<span class="ck-srow__check">${accessCheck({ state: check, label: name, attrs, busy, waits, fixed })}</span>`
  + (meaning ? `<span class="ck-srow__glyph" aria-hidden="true">${icon(meaning, { size: 'sm' })}</span>` : '')
  + '<span class="ck-srow__main"><span class="ck-srow__top">'
  + `<span class="ck-srow__label">${esc(name)}</span>${differs}</span>`
  + (line ? `<span class="ck-srow__line">${esc(line)}</span>` : '') + '</span>'
  + `<span${attributes({ class: 'ck-srow__count', title: endSaid || null })}>${esc(end)}</span></li>`;

/**
 * @param {'done' | 'waiting' | ''} mark
 * @param {boolean} busy
 */
const footMark = (mark, busy) => busy ? spinner() : mark === 'done' ? icon('done', { size: 'xs' })
  : mark === 'waiting' ? signalShape('caution', { size: 8 }) : '';

/**
 * @param {object} foot
 * @param {import('./bold-line.js').Bolded} [foot.said]
 * @param {import('./bold-line.js').Bolded} [foot.waits]
 * @param {'done' | 'waiting' | ''} [foot.mark]
 * @param {string} [foot.acts]
 * @param {boolean} [foot.busy]
 */
export const accessFoot = ({ said = [], waits = [], mark = '', acts = '', busy = false }) => '<div class="ck-afoot">'
  + '<div class="ck-afoot__lines" role="status">'
  + `<p class="ck-afoot__said">${footMark(mark, busy)}<span>${boldRuns(said)}</span></p>`
  + (waits.length ? `<p class="ck-afoot__said">${footMark('waiting', false)}<span>${boldRuns(waits)}</span></p>` : '')
  + `</div>${acts}</div>`;
