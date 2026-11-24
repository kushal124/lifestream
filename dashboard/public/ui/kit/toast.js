// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { icon } from './icon.js';

/**
 * @param {object} toast
 * @param {string} toast.title
 * @param {string | null} [toast.line]
 * @param {boolean} [toast.held]
 */
export const toast = ({ title, line = null, held = false }) => `<div${attributes({
  class: `ck-toast${held ? ' is-held' : ''}`, role: 'status' })}>`
  + icon('done', { size: 'sm', className: 'ck-toast__mark' })
  + `<span class="ck-toast__words"><span class="ck-toast__title mac-headline">${esc(title)}</span>`
  + (line ? `<span class="ck-toast__line mac-subhead">${esc(line)}</span>` : '') + '</span></div>';

/**
 * @param {HTMLElement} layer
 * @param {{ title: string, line?: string | null }} said
 */
export function showToast(layer, said) {
  for (const old of layer.querySelectorAll('.ck-toast')) old.remove();
  layer.insertAdjacentHTML('beforeend', toast(said));
  const shown = /** @type {HTMLElement} */ (layer.lastElementChild);
  shown.addEventListener('animationend', event => {
    if (event.animationName === 'ck-toast-out') shown.remove();
  });
}
