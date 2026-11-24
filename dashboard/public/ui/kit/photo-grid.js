// @ts-check
import { attributes } from '../../lib/html.js';
import { icon } from './icon.js';
import { shape } from './skeleton.js';
import { picture } from './picture.js';

/**
 * @typedef {object} Photo
 * @property {string} hash
 * @property {string} label
 * @property {import('../../lib/html.js').Attributes} attrs
 */

/** @param {number} count */
function filledRows(count) {
  const rows = Math.ceil(count / 3);
  return Array.from({ length: rows }, (_, at) => Math.floor(count / rows) + (at < count % rows ? 1 : 0));
}

/**
 * @param {object} grid
 * @param {Photo[]} grid.photos
 * @param {string} grid.label
 * @param {number} [grid.columns]
 * @param {boolean} [grid.fill]
 */
export function photoGrid({ photos, label, columns = 4, fill = false }) {
  const spans = fill ? filledRows(photos.length).flatMap(row => Array.from({ length: row }, () => 6 / row)) : [];
  return `<div${attributes({ class: `ck-photos ${fill ? 'ck-photos--fill' : `ck-photos--${columns}`}`, role: 'group',
    'aria-label': label })}>${photos.map(({ hash, label: said, attrs }, at) => `<button${attributes({ type: 'button',
    class: `ck-photo${fill ? ` ck-photo--span-${spans[at]}` : ''}`, 'aria-label': said, ...attrs })}>`
    + icon('photo', { size: 'md', className: 'ck-photo__glyph' })
    + picture({ hash, size: 'tile', alt: '' }, { className: 'ck-photo__img', attrs: { loading: 'lazy' } })
    + '</button>').join('')}</div>`;
}

/**
 * @param {number} [columns]
 * @param {boolean} [fill]
 * @param {number} [count]
 */
export const photoGridReading = (columns = 4, fill = false, count = columns) => `<div class="ck-photos ${fill ? 'ck-photos--fill'
  : `ck-photos--${columns}`}" aria-hidden="true">` + Array.from({ length: fill ? 3 : count },
  () => `<span class="ck-photo ck-photo--reading${fill ? ' ck-photo--span-2' : ''}">${shape()}</span>`).join('') + '</div>';
