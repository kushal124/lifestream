// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { bar } from './skeleton.js';

/**
 * @typedef {object} PlaceUnitOptions
 * @property {string} name
 * @property {string} minutes
 * @property {string} spoken
 * @property {string | null} [line]
 * @property {import('../../lib/html.js').Attributes} [attrs]
 * @property {string | null} [open]
 * @property {boolean} [lit]
 */

/** @param {PlaceUnitOptions} unit */
export function placeUnit({ name, minutes, spoken, line, attrs = {}, open = null, lit = false }) {
  const lined = line !== undefined;
  const label = [spoken, line].filter(Boolean).join(', ');
  const tag = open ? 'a' : 'button';
  return `<div class="ck-punit${lined ? ' has-line' : ''}${lit ? ' is-lit' : ''}">`
    + `<${tag}${attributes({ type: open ? null : 'button', href: open, class: 'ck-punit__main', 'aria-label': label, ...attrs })}>`
    + `<span class="ck-punit__name mac-headline" data-d-fit="label">${esc(name)}</span>`
    + `<span class="ck-punit__time mac-mono-data">${esc(minutes)}</span>`
    + (lined ? `<span class="ck-punit__line mac-subhead">${line === null ? bar(6) : esc(line)}</span>` : '')
    + `</${tag}></div>`;
}

/** @param {number} index */
export const placeUnitReading = index => '<div class="ck-punit has-line" aria-hidden="true"><span class="ck-punit__main">'
  + `<span class="ck-punit__name mac-headline">${bar([5, 4, 6], index)}</span>`
  + `<span class="ck-punit__time mac-mono-data">${bar(2)}</span>`
  + `<span class="ck-punit__line mac-subhead">${bar([6, 5, 7], index)}</span></span></div>`;
