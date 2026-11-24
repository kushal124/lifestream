// @ts-check
import { esc, textHead } from '../../lib/html.js';

const CLIP = 280;

/**
 * @param {unknown} value
 * @param {number} depth
 * @param {number} open
 * @returns {string}
 */
function node(value, depth, open) {
  if (value === null) return '<span class="j-null">null</span>';
  if (typeof value === 'string') {
    if (value.length <= CLIP) return `<span class="j-str">"${esc(value)}"</span>`;
    const head = textHead(value, CLIP);
    return `<span class="j-str j-clip" data-full="${esc(value)}">"${esc(head)}`
      + `<button class="j-more" data-l-more>… ${(value.length - head.length).toLocaleString('en-US')} more</button>"</span>`;
  }
  if (typeof value === 'number') return `<span class="j-num">${value}</span>`;
  if (typeof value === 'boolean') return `<span class="j-bool">${value}</span>`;
  const array = Array.isArray(value);
  const entries = array ? value.map((item, index) => [String(index), item]) : Object.entries(/** @type {object} */ (value));
  const [left, right] = array ? ['[', ']'] : ['{', '}'];
  if (!entries.length) return `<span class="j-punct">${left}${right}</span>`;
  const items = entries.map(([key, item]) => '<li>'
    + (array ? '' : `<span class="j-key">"${esc(key)}"</span><span class="j-punct">: </span>`)
    + node(item, depth + 1, open) + '</li>').join('');
  const count = `<span class="j-count">${entries.length} ${array ? (entries.length === 1 ? 'item' : 'items') : (entries.length === 1 ? 'key' : 'keys')}</span>`;
  return `<span class="j-node${depth < open ? '' : ' closed'}"><button class="j-toggle" data-l-fold>${left}</button>`
    + `${count}<ul>${items}</ul><span class="j-punct">${right}</span></span>`;
}

/**
 * @param {string} text
 * @param {number} [open]
 */
export function jsonTree(text, open = 2) {
  try {
    return `<div class="json-tree">${node(JSON.parse(text), 0, open)}</div>`;
  } catch {
    return `<pre class="json-raw">${esc(text)}</pre>`;
  }
}

/** @param {HTMLElement} root */
export function installJsonTree(root) {
  root.addEventListener('click', event => {
    const fold = /** @type {Element} */ (event.target).closest('[data-l-fold]');
    if (fold) {
      /** @type {HTMLElement} */ (fold.parentElement).classList.toggle('closed');
      return;
    }
    const button = /** @type {Element} */ (event.target).closest('[data-l-more]');
    if (!button) return;
    const holder = /** @type {HTMLElement} */ (button.closest('.j-clip'));
    holder.textContent = `"${holder.dataset.full}"`;
    holder.classList.remove('j-clip');
  });
}
