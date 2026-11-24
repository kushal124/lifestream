// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { personFace } from './person-face.js';

/**
 * @param {object} chip
 * @param {string} chip.name
 * @param {string} [chip.photo]
 * @param {string} [chip.figure]
 * @param {import('../../lib/html.js').Attributes} chip.attrs
 */
export const personChip = ({ name, photo = '', figure = '', attrs }) => `<button${attributes({ type: 'button',
  class: 'ck-pchip', 'aria-label': figure ? `${name}, ${figure}` : name, ...attrs })}>${personFace({ name, photo, size: 'xs' })}`
  + `<span class="ck-pchip__words" aria-hidden="true"><span class="ck-pchip__name mac-headline">${esc(name)}</span>`
  + (figure ? `<span class="ck-pchip__figure mac-mono-data">${esc(figure)}</span>` : '') + '</span></button>';

/** @param {string[]} chips */
export const personChips = chips => `<div class="ck-pchips">${chips.join('')}</div>`;
