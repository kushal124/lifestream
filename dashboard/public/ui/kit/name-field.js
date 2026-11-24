// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { icon } from './icon.js';

/**
 * @param {object} field
 * @param {string} field.placeholder
 * @param {string} [field.value]
 * @param {string} [field.act]
 * @param {boolean} [field.waiting]
 * @param {import('../../lib/html.js').Attributes} [field.attrs]
 */
export function nameField({ placeholder, value = '', act = 'Save', waiting = false, attrs = {} }) {
  return `<div class="ck-search ck-namefield${waiting ? ' is-waiting' : ''}">${icon('search', { size: 'sm' })}`
    + `<input class="ck-search__input mac-body"${attributes({ type: 'search', placeholder, 'aria-label': placeholder, value,
      autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'done', disabled: waiting, ...attrs })}>`
    + `<button${attributes({ type: 'submit', class: 'ck-namefield__act mac-headline', tabindex: '-1' })}>${esc(act)}</button>`
    + '</div>';
}

/** @param {string} name */
export const nameCredit = name => `<p class="ck-namecredit mac-footnote">${esc(name)}</p>`;
