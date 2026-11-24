// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { pictureUrl } from '../../lib/api.js';
import { icon } from './icon.js';

/** @typedef {import('../../lib/html.js').Attributes} Attributes */

/**
 * @param {object} tile
 * @param {string} tile.hash
 * @param {string} tile.name
 * @param {string} tile.line
 * @param {boolean} [tile.quiet]
 * @param {Attributes} [tile.attrs]
 */
export const faceTile = ({ hash, name, line, quiet = false, attrs = {} }) => `<button${attributes({ type: 'button',
  class: `ck-ftile${quiet ? ' is-quiet' : ''}`, 'aria-label': `${name}, ${line}`, ...attrs })}>`
  + (hash ? `<img${attributes({ class: 'ck-pic ck-ftile__crop', 'data-src': pictureUrl(hash, 'tile'), alt: '', loading: 'lazy', decoding: 'async',
    draggable: 'false' })}>`
    : `<span class="ck-ftile__crop">${icon('person')}</span>`)
  + `<span class="ck-ftile__main"><span class="ck-ftile__name mac-headline">${esc(name)}</span>`
  + `<span class="ck-ftile__line mac-subhead">${esc(line)}</span></span></button>`;

/** @param {string[]} tiles */
export const faceTiles = tiles => `<div class="ck-ftiles">${tiles.join('')}</div>`;
