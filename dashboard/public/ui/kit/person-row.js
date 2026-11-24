// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { icon } from './icon.js';
import { personFace } from './person-face.js';
import { avatar, bar } from './skeleton.js';

/** @typedef {{ glyph: string, value: string, quiet?: boolean }} Run */

/** @param {Run[]} runs */
export const contactRuns = runs => `<span class="ck-runs" aria-hidden="true">${runs.map(run =>
  `<span class="ck-run${run.quiet ? ' is-quiet' : ''}" data-glyph="${esc(run.glyph)}">${icon(run.glyph, { size: 'xs' })}`
  + `<span class="ck-run__value mac-mono-data">${esc(run.value)}</span></span>`).join('')}</span>`;

/**
 * @typedef {object} PersonRowOptions
 * @property {string} name
 * @property {string} [photo]
 * @property {Run[]} runs
 * @property {string} spoken
 * @property {import('../../lib/html.js').Attributes} [attrs]
 * @property {string | null} [open]
 */

/** @param {PersonRowOptions} row */
export function personRow({ name, photo = '', runs, spoken, attrs = {}, open = null }) {
  const tag = open ? 'a' : 'button';
  return '<div class="ck-prow">'
    + `<${tag}${attributes({ type: open ? null : 'button', href: open, class: 'ck-prow__main', 'aria-label': spoken, ...attrs })}>`
    + `<span class="ck-prow__face">${personFace({ name, photo, size: 'sm' })}</span>`
    + `<span class="ck-prow__name mac-headline" data-d-fit="label">${esc(name)}</span>${contactRuns(runs)}</${tag}></div>`;
}

/** @param {number} index */
export const personRowReading = index => '<div class="ck-prow" aria-hidden="true"><span class="ck-prow__main">'
  + `<span class="ck-prow__face"><span class="ck-prow__sk">${avatar()}</span></span>`
  + `<span class="ck-prow__name mac-headline">${bar([5, 4, 6, 3, 5], index)}</span>`
  + `<span class="ck-runs"><span class="ck-run__value mac-mono-data">${bar(1)}</span></span></span></div>`;

/**
 * @param {object} card
 * @param {string} card.name
 * @param {string} [card.photo]
 * @param {string} [card.line]
 * @param {import('../../lib/html.js').Attributes} [card.attrs]
 * @param {string} [card.className]
 */
export function youCard({ name, photo = '', line = '', attrs = {}, className = '' }) {
  return `<button${attributes({ type: 'button', class: `ck-sidebox ck-pcard${className ? ` ${className}` : ''}`, 'aria-label': line ? `${name}, ${line}` : name, ...attrs })}>`
    + personFace({ name, photo, size: 'md' }) + '<span class="ck-pcard__main" aria-hidden="true">'
    + `<span class="ck-pcard__name mac-headline">${esc(name)}</span>`
    + (line ? `<span class="ck-pcard__line mac-subhead">${esc(line)}</span>` : '') + '</span></button>';
}
