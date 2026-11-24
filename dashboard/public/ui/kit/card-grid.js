// @ts-check
import { esc } from '../../lib/html.js';

/**
 * @param {string[]} cards
 * @param {{ label: string }} options
 */
export function cardGrid(cards, { label }) {
  return `<div class="ck-cgrid" role="list" aria-label="${esc(label)}">`
    + cards.map(card => `<div class="ck-cgrid__cell" role="listitem">${card}</div>`).join('') + '</div>';
}

/**
 * @param {Element} grid
 * @param {Element} current
 */
function rove(grid, current) {
  for (const cell of grid.querySelectorAll(':scope > .ck-cgrid__cell')) {
    const tabindex = cell === current ? '0' : '-1';
    for (const control of cell.querySelectorAll('button')) control.setAttribute('tabindex', tabindex);
  }
}

/** @param {HTMLElement} root */
export function installCardGrid(root) {
  root.addEventListener('focusin', event => {
    const cell = /** @type {Element} */ (event.target).closest('.ck-cgrid__cell');
    const grid = cell?.parentElement;
    if (cell && grid?.classList.contains('ck-cgrid')) rove(grid, cell);
  });
  root.addEventListener('keydown', event => {
    const cell = /** @type {Element} */ (event.target).closest('.ck-cgrid__cell');
    const grid = cell?.parentElement;
    if (!cell || !grid?.classList.contains('ck-cgrid') || event.altKey || event.ctrlKey || event.metaKey) return;
    const cells = [...grid.querySelectorAll(':scope > .ck-cgrid__cell')];
    const laid = getComputedStyle(grid);
    /** @param {string} tracks */
    const count = tracks => tracks.split(' ').filter(Boolean).length || 1;
    const line = count(laid.gridTemplateColumns);
    const index = cells.indexOf(cell);
    /** @type {Record<string, number>} */
    const steps = { ArrowLeft: index - 1, ArrowRight: index + 1, ArrowUp: index - line, ArrowDown: index + line,
      Home: 0, End: cells.length - 1 };
    if (!(event.key in steps)) return;
    event.preventDefault();
    const next = cells[steps[event.key]];
    if (!next) return;
    rove(grid, next);
    /** @type {HTMLElement | null} */ (next.querySelector('button'))?.focus();
  });
}
