// @ts-check
import { menuButton } from './menu-button.js';
import { stepper } from './controls.js';

/** @typedef {import('../../lib/html.js').Attributes} Attributes */

/**
 * @param {object} pager
 * @param {string} pager.id
 * @param {number} pager.page
 * @param {number} pager.total
 * @param {number} pager.size
 * @param {number[]} pager.sizes
 * @param {Attributes} pager.resize
 * @param {(by: number) => Attributes} pager.step
 */
export function photoPager({ id, page, total, size, sizes, resize, step }) {
  const pages = Math.max(1, Math.ceil(total / size));
  const count = (/** @type {number} */ n) => n.toLocaleString('en-US');
  return '<div class="ck-pager">'
    + menuButton({ id: `${id}-size`, label: 'Photos per page', words: `${size} per page`, attrs: resize,
      choices: sizes.map(each => ({ value: String(each), words: `${each} per page`, chosen: each === size, default: each === sizes[0] })) })
    + (pages > 1 ? stepper({ label: 'Pages of photos', text: `${count(page + 1)} of ${count(pages)}`,
      less: { label: 'Newer photos', attrs: step(-1), disabled: page === 0 },
      more: { label: 'Older photos', attrs: step(1), disabled: page >= pages - 1 } }) : '')
    + '</div>';
}
