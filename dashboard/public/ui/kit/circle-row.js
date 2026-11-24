// @ts-check
import { CIRCLES_MAX } from '../../lib/circle.js';
import { attributes, esc } from '../../lib/html.js';
import { iconButton } from './button.js';
import { circleLine, reachStepper } from './circle-editor.js';
import { icon } from './icon.js';

/** @typedef {import('../../lib/html.js').Attributes} Attributes */

/**
 * @param {object} row
 * @param {number} row.at
 * @param {number} [row.of]
 * @param {number} row.metres
 * @param {string} row.line
 * @param {(way: 1 | -1) => Record<string, string>} row.reach
 * @param {Attributes | null} [row.remove]
 * @param {Attributes} [row.attrs]
 * @param {boolean} [row.lit]
 */
export const circleRow = ({ at, of = 1, metres, line, reach, remove = null, attrs = {}, lit = false }) => `<div${attributes({
  class: `ck-circlerow${lit ? ' is-lit' : ''}`, role: 'group', 'aria-label': `Circle ${at + 1}`, ...attrs })}>`
  + (of > 1 ? `<span class="ck-circlerow__number mac-mono-data" aria-hidden="true">${at + 1}</span>` : '')
  + reachStepper({ metres, at, attrs: reach })
  + circleLine(line, at)
  + (remove ? iconButton('close', `Remove circle ${at + 1}`, { attrs: remove, className: 'ck-circlerow__remove' }) : '')
  + '</div>';

/**
 * @param {object} row
 * @param {boolean} [row.disabled]
 * @param {Attributes} [row.attrs]
 */
export const addCircleRow = ({ disabled = false, attrs = {} } = {}) => `<button${attributes({
  class: 'ck-circlerow ck-circlerow--add', type: 'button', disabled, ...attrs })}>`
  + `<span class="ck-circlerow__plus" aria-hidden="true">${icon('add')}</span><span class="ck-circlerow__add mac-body">`
  + `${esc(disabled ? `${CIRCLES_MAX} circles, the most a place holds` : 'Add circle')}</span></button>`;
