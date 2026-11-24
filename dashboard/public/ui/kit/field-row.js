// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { icon } from './icon.js';

/** @typedef {import('../../lib/html.js').Attributes} Attributes */

/**
 * @param {object} field
 * @param {string} field.label
 * @param {string} [field.value]
 * @param {string} [field.placeholder]
 * @param {string} [field.source]
 * @param {boolean} [field.sourced]
 * @param {Attributes} [field.attrs]
 * @param {Attributes} [field.input]
 * @param {boolean} [field.lit]
 */
export function fieldRow({ label, value = '', placeholder = '', source = '', sourced = true, attrs = {}, input = {}, lit = false }) {
  return `<label${attributes({ class: `ck-fieldrow${lit ? ' is-lit' : ''}`, ...attrs })}>`
    + `<span class="ck-fieldrow__label mac-body">${esc(label)}</span>`
    + `<input${attributes({ class: 'ck-fieldrow__input mac-body', type: 'text', value, placeholder: placeholder || null,
      'aria-label': label, autocomplete: 'off', spellcheck: 'false', autocapitalize: 'words', ...input })}>`
    + (source ? `<span${attributes({ class: 'ck-fieldrow__src mac-subhead', hidden: !sourced })}>${esc(source)}</span>` : '')
    + '</label>';
}

/**
 * @param {object} field
 * @param {string} field.label
 * @param {string} field.value
 * @param {Attributes} [field.attrs]
 * @param {boolean} [field.open]
 * @param {boolean} [field.empty]
 */
export const fieldRowMenu = ({ label, value, attrs = {}, open = false, empty = false }) => `<button${attributes({ type: 'button',
  class: `ck-fieldrow ck-fieldrow--menu${open ? ' is-lit' : ''}`, 'aria-haspopup': 'listbox', 'aria-expanded': String(open),
  ...attrs })}><span class="ck-fieldrow__label mac-body">${esc(label)}</span>`
  + `<span class="ck-fieldrow__value mac-body${empty ? ' is-empty' : ''}">${esc(value)}</span>`
  + `<span class="ck-fieldrow__caret" aria-hidden="true">${icon('expand', { size: 'xs' })}</span></button>`;

/**
 * @param {string} rows
 * @param {{ label?: string, className?: string, hidden?: boolean }} [options]
 */
export const formCard = (rows, { label = '', className = '', hidden = false } = {}) => `<div${attributes({
  class: `ck-form${className ? ` ${className}` : ''}`, role: hidden ? null : 'group', 'aria-label': label || null,
  'aria-hidden': hidden ? 'true' : null })}>${rows}</div>`;

/**
 * @param {object} row
 * @param {string} row.placeholder
 * @param {string} [row.key]
 * @param {Attributes} [row.attrs]
 * @param {Attributes} [row.input]
 */
export const formAdd = ({ placeholder, key = '', attrs = {}, input = {} }) => `<label${attributes({ class: 'ck-form__add', ...attrs })}>`
  + `<span class="ck-form__key mac-body"${key ? '' : ' aria-hidden="true"'}>${key ? esc(key) : icon('add', { size: 'sm' })}</span>`
  + `<input${attributes({ class: 'ck-fieldrow__input mac-body', type: 'text', placeholder, 'aria-label': placeholder,
    autocomplete: 'off', spellcheck: 'false', ...input })}></label>`;

/**
 * @param {object} act
 * @param {string} act.words
 * @param {Attributes} [act.attrs]
 * @param {boolean} [act.menu]
 * @param {{ whose: string, remove: string, attrs: Attributes }} [act.said]
 */
export function formAct({ words, attrs = {}, menu = false, said }) {
  if (said) {
    return `<button${attributes({ type: 'button', class: 'ck-form__act is-said', title: said.remove,
      'aria-label': `${said.remove}, ${said.whose.toLowerCase()}`, ...attrs, ...said.attrs })}>`
      + `<span class="ck-form__words mac-body">${esc(words)}</span><span class="ck-form__whose mac-subhead">${esc(said.whose)}</span>`
      + `<span class="ck-form__x" aria-hidden="true">${icon('close')}</span></button>`;
  }
  return `<button${attributes({ type: 'button', class: 'ck-form__act', ...menu ? { 'aria-haspopup': 'listbox' } : {}, ...attrs })}>`
    + `<span class="ck-form__words mac-body">${esc(words)}</span>`
    + (menu ? `<span class="ck-fieldrow__caret" aria-hidden="true">${icon('expand', { size: 'xs' })}</span>` : '') + '</button>';
}
