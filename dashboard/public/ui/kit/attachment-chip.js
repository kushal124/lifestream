// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { icon } from './icon.js';

/** @typedef {import('../../lib/html.js').Attributes} Attributes */

/**
 * @param {object} chip
 * @param {string} chip.title
 * @param {boolean} chip.kept
 * @param {string} [chip.glyph]
 * @param {string} [chip.add]
 * @param {{ src: string, attrs: Attributes } | null} [chip.picture]
 * @param {Attributes} [chip.attrs]
 */
export function attachmentChip({ title, kept, glyph = '', add = '', picture = null, attrs = {} }) {
  const words = kept || !add ? title : add;
  const lead = picture ? '' : kept ? (glyph ? icon(glyph, { size: 'xs', className: 'ck-achip__glyph' }) : '')
    : icon('add', { size: 'xs', className: 'ck-achip__glyph' });
  return `<span${attributes({ class: `ck-achip${kept ? ' is-kept' : ''}${picture ? ' ck-achip--picture' : ''}` })}>`
    + (picture ? `<button${attributes({ type: 'button', class: 'ck-achip__picture', 'aria-label': title, title,
      ...picture.attrs })}><img${attributes({ src: picture.src, alt: '' })}></button>` : '')
    + `<button${attributes({ type: 'button', class: 'ck-achip__btn mac-subhead', 'aria-pressed': String(kept),
      ...attrs })}>`
    + `${lead}<span class="ck-achip__words">${esc(words)}</span>`
    + (kept ? icon('close', { size: 'xs', className: 'ck-achip__end' }) : '') + '</button></span>';
}

/** @param {string[]} chips */
export const attachmentChips = chips => chips.length ? `<div class="ck-achips">${chips.join('')}</div>` : '';
