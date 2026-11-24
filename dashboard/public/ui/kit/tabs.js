// @ts-check
import { attributes, esc } from '../../lib/html.js';

/** @typedef {import('../../lib/html.js').Attributes} Attributes */

/**
 * @param {object} tabs
 * @param {string} tabs.label
 * @param {string} tabs.id
 * @param {{ id: string, label: string, dot?: boolean, attrs: Attributes }[]} tabs.items
 * @param {string} tabs.value
 */
export function tabs({ label, id, items, value }) {
  return `<div${attributes({ class: 'ck-tabs', role: 'tablist', 'aria-label': label })}>`
    + items.map(item => {
      const shown = item.id === value;
      return `<button${attributes({ type: 'button', role: 'tab', id: `${id}-${item.id}`, class: 'ck-tabs__tab mac-headline',
        'aria-selected': String(shown), 'aria-controls': shown ? `${id}-panel` : null, tabindex: shown ? '0' : '-1',
        ...item.attrs })}>${esc(item.label)}`
        + (item.dot ? '<span class="ck-tabs__dot" aria-hidden="true"></span><span class="sr-only">, needs you</span>' : '')
        + '</button>';
    }).join('') + '</div>';
}

/** @param {string} markup */
const holdsStop = markup => [...markup.matchAll(/<(?:button|input|select|textarea)\b[^>]*>|<a\b[^>]*\bhref=[^>]*>|<[^>]*\btabindex="0"[^>]*>/gu)]
  .some(([tag]) => !/\sdisabled(?=[\s=>])/u.test(tag));

/**
 * @param {object} panel
 * @param {string} panel.id
 * @param {string} panel.value
 * @param {string} panel.body
 */
export const tabPanel = ({ id, value, body }) => `<div${attributes({ class: 'ck-tabs__panel', role: 'tabpanel',
  id: `${id}-panel`, 'aria-labelledby': `${id}-${value}`, tabindex: holdsStop(body) ? null : '0' })}>${body}</div>`;

/** @param {HTMLElement} root */
export function installTabs(root) {
  root.addEventListener('keydown', event => {
    const pill = event.target instanceof Element ? event.target.closest('[role="tab"]') : null;
    const list = pill?.closest('[role="tablist"]');
    if (!pill || !list || event.altKey || event.ctrlKey || event.metaKey) return;
    const pills = /** @type {HTMLElement[]} */ ([...list.querySelectorAll('[role="tab"]')]);
    const at = pills.indexOf(/** @type {HTMLElement} */ (pill));
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: pills.length - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    const next = pills[(to + pills.length) % pills.length];
    next.focus();
    if (next !== pill) next.click();
  });
}
