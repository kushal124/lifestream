// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { pictureUrl } from '../../lib/api.js';
import { icon } from './icon.js';
import { bar, iconSquare } from './skeleton.js';
import { tick } from './tick.js';

/** @typedef {import('../../lib/html.js').Attributes} Attributes */

/** @typedef {{ icon: string } | { crop: string } | { face: string } | { key: string }} Lead */

/** @typedef {{ tick: boolean } | { add: boolean } | { remove: string, attrs: Attributes } | 'caret' | 'fixed'} End */

/** @param {Lead} lead */
export const leadOf = lead => 'key' in lead ? esc(lead.key) : 'icon' in lead ? icon(lead.icon, { size: 'md' })
  : 'crop' in lead ? `<img${attributes({ class: 'ck-pic ck-namerow__crop', 'data-src': pictureUrl(lead.crop, 'tile'), alt: '', loading: 'lazy',
    decoding: 'async', draggable: 'false' })}>`
    : lead.face;

/**
 * @param {object} row
 * @param {string | Lead} row.lead
 * @param {boolean} [row.answer]
 * @param {string} row.name
 * @param {string} row.line
 * @param {boolean} [row.lit]
 * @param {Attributes} [row.attrs]
 * @param {End} [row.end]
 * @param {boolean} [row.quiet]
 * @param {string} [row.label]
 * @param {boolean} [row.added]
 */
export function nameRow({ lead, name, line, lit = false, attrs = {}, end = 'caret', quiet = false, label = '', added = false,
  answer = false }) {
  const keyed = typeof lead !== 'string' && 'key' in lead;
  const main = `<span class="ck-namerow__main"><span class="ck-namerow__name ${keyed ? 'mac-body' : 'mac-headline'}">${esc(name)}</span>`
    + (keyed && !line ? '' : `<span class="ck-namerow__line mac-subhead">${esc(line)}</span>`) + '</span>';
  if (typeof lead === 'string' || answer) {
    return `<button${attributes({ type: 'button', role: 'option', 'aria-selected': String(lit), tabindex: '-1',
      class: `ck-namerow${typeof lead === 'string' ? '' : ' ck-namerow--faced'}${lit ? ' is-lit' : ''}`, ...attrs })}>`
      + `<span class="ck-namerow__lead" aria-hidden="true">${typeof lead === 'string' ? icon(lead) : leadOf(lead)}</span>${main}`
      + (lit ? '<span class="ck-namerow__key mac-subhead" aria-hidden="true">⏎</span>' : '') + '</button>';
  }
  const classes = `ck-namerow ck-namerow--card${keyed ? ' ck-namerow--key' : ''}${quiet ? ' ck-namerow--quiet' : ''}${added ? ' is-added' : ''}${lit ? ' is-lit' : ''}`;
  const inner = `<span class="${keyed ? 'ck-namerow__keyword mac-body' : 'ck-namerow__lead'}" aria-hidden="true">${leadOf(lead)}</span>${main}`;
  if (end === 'caret') {
    return `<button${attributes({ type: 'button', class: classes, 'aria-label': label || null, ...attrs })}>${inner}`
      + `<span class="ck-namerow__end ck-namerow__caret" aria-hidden="true">${icon('forward', { size: 'xs' })}</span></button>`;
  }
  if (end === 'fixed') return `<div${attributes({ tabindex: '0', role: 'group', class: classes, 'aria-label': label || null, ...attrs })}>${inner}</div>`;
  if ('tick' in end) {
    return `<button${attributes({ type: 'button', role: 'checkbox', 'aria-checked': String(end.tick), class: classes,
      'aria-label': label || null, ...attrs })}>${inner}<span class="ck-namerow__end">${tick(end.tick)}</span></button>`;
  }
  if ('add' in end) {
    return `<button${attributes({ type: 'button', role: 'checkbox', 'aria-checked': String(end.add), class: classes,
      'aria-label': label || null, ...attrs })}>${inner}<span class="ck-namerow__end">`
      + `${end.add ? tick(true) : '<span class="ck-namerow__add mac-subhead">Add</span>'}</span></button>`;
  }
  return `<div${attributes({ tabindex: '0', role: 'group', class: classes, 'aria-label': label || null, ...attrs })}>${inner}`
    + `<span class="ck-namerow__end"><button${attributes({ type: 'button', class: 'ck-ibtn ck-ibtn--plain ck-namerow__x',
      'aria-label': end.remove, title: end.remove, tabindex: '-1', ...end.attrs })}>${icon('close')}</button></span></div>`;
}

const NAMES = /** @type {const} */ ([6, 4, 5]);
const LINES = /** @type {const} */ ([5, 6, 4]);

/** @param {number} index */
export const nameRowReading = index => readingRow(index, '');

/** @param {number} index */
export const nameRowCardReading = index => readingRow(index, ' ck-namerow--card');

/** @param {number} index @param {string} kind */
const readingRow = (index, kind) => `<div class="ck-namerow${kind} ck-namerow--reading" aria-hidden="true">`
  + `<span class="ck-namerow__lead">${iconSquare()}</span><span class="ck-namerow__main">`
  + `<span class="ck-namerow__name mac-headline">${bar(NAMES, index)}</span>`
  + `<span class="ck-namerow__line mac-subhead">${bar(LINES, index)}</span></span></div>`;
