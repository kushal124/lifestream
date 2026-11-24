// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { ARRIVES, bar } from './skeleton.js';

/** @typedef {import('../../lib/html.js').Attributes} Attributes */

/** @param {number | null | undefined} count */
const countOf = count => count === undefined ? ''
  : count === null ? `<span class="ck-views__n mac-mono-data">${bar(1)}</span>`
    : `<span class="ck-views__n mac-mono-data ${ARRIVES}">${count.toLocaleString('en-US')}</span>`;

/**
 * @param {object} views
 * @param {string} views.label
 * @param {{ id: string, label: string, count?: number | null, attrs: Attributes }[]} views.options
 * @param {string} views.value
 */
export function views({ label, options, value }) {
  return `<div class="ck-views" role="tablist" aria-label="${esc(label)}">`
    + options.map(option => `<button${attributes({
    type: 'button', role: 'tab', 'aria-selected': String(option.id === value),
    class: `ck-views__opt mac-headline${option.count === null ? ' is-reading' : ''}`, ...option.attrs,
  })}>${esc(option.label)}${countOf(option.count)}</button>`).join('')
    + '</div>';
}
