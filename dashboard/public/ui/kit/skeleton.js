// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { WAITING } from '../../lib/reach.js';

/** @typedef {1 | 2 | 3 | 4 | 5 | 6 | 7 | 8} BarWidth */

export const ARRIVES = 'ck-sk-in';

/**
 * @param {BarWidth | readonly BarWidth[]} width
 * @param {number} [index]
 */
export function bar(width, index = 0) {
  const widths = typeof width === 'number' ? [width] : width;
  return `<span class="ck-sk ck-sk--bar ck-sk--w${widths[index % widths.length]}" aria-hidden="true"></span>`;
}

export const iconSquare = () => '<span class="ck-sk ck-sk--icon" aria-hidden="true"></span>';

export const avatar = () => '<span class="ck-sk ck-sk--avatar" aria-hidden="true"></span>';

/** @param {{ className?: string, geo?: string }} [shape] */
export const shape = ({ className = '', geo = '' } = {}) => `<span${attributes({
  class: `ck-sk ck-sk--shape${className ? ` ${className}` : ''}`, 'data-geo': geo || null, 'aria-hidden': 'true',
})}></span>`;

/**
 * @param {number} count
 * @param {string} [text]
 */
export const lines = (count, text = 'mac-body') => '<div class="ck-sk-lines" aria-hidden="true">'
  + Array.from({ length: count }, (_, at) => `<p${attributes({ class: text || null })}>${bar(at === count - 1 ? 5 : 8)}</p>`).join('')
  + '</div>';

/**
 * @param {string} markup
 * @param {string} [tag]
 */
export const counting = (markup, tag = 'div') => `<${tag} class="ck-counting" aria-hidden="true">${markup}</${tag}>`;

/** @param {string} [words] */
export const waitLine = (words = '') => `<p class="ck-sk-wait mac-body" aria-hidden="true">${esc(words || WAITING)}</p>`;

/** @type {WeakMap<HTMLElement, HTMLElement>} */
const said = new WeakMap();

/**
 * @param {HTMLElement} root
 * @param {boolean} on
 * @param {string} [words]
 */
export function reading(root, on, words = '') {
  root.classList.add('ck-root');
  const line = said.get(root);
  if (on) {
    root.classList.remove('ck-arrive');
    root.classList.add('ck-reading');
    if (!words) return;
    const status = line ?? document.createElement('p');
    if (!line) {
      status.className = 'sr-only';
      status.setAttribute('role', 'status');
      said.set(root, status);
    }
    if (status.textContent !== words) status.textContent = words;
    if (status.parentElement !== root) root.prepend(status);
    return;
  }
  line?.remove();
  said.delete(root);
  if (root.classList.contains('ck-reading')) {
    root.classList.remove('ck-reading');
    root.classList.add('ck-arrive');
    root.addEventListener('animationend', arrived);
    root.addEventListener('animationcancel', arrived);
  }
}

/** @param {Event} event */
function arrived(event) {
  if (event.target === event.currentTarget) /** @type {Element} */ (event.currentTarget).classList.remove('ck-arrive');
}
