// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { checkDisc } from './button.js';
import { icon } from './icon.js';
import { signalShape } from './signal.js';

/** @typedef {import('../../lib/html.js').Attributes} Attributes */

/**
 * @typedef {object} Step
 * @property {string} title
 * @property {string} [line]
 * @property {string} [body]
 * @property {'done' | 'here' | 'idle' | 'plain'} [mark]
 * @property {string} [why]
 */

/** @type {Record<NonNullable<Step['mark']>, string>} */
const HEARD = { done: 'done', here: 'next', idle: 'to do', plain: '' };

/**
 * @param {Step} step
 * @param {number} at
 */
const stepMarkup = ({ title, line = '', body = '', mark = 'idle', why = '' }, at) => `<li class="ck-numbered__step is-${mark}">`
  + `<span class="ck-numbered__n mac-subhead" aria-hidden="true">${mark === 'done' ? checkDisc({ size: 14 }) : at + 1}</span>`
  + `<div class="ck-numbered__main"><p class="ck-numbered__title mac-body">${esc(title)}`
  + `${HEARD[mark] ? `<span class="sr-only">, ${HEARD[mark]}</span>` : ''}</p>`
  + (line ? `<p class="ck-numbered__line mac-body">${esc(line)}</p>` : '')
  + (why ? `<p class="ck-numbered__why mac-subhead" role="alert">${signalShape('warning')}${esc(why)}</p>` : '')
  + (body ? `<div class="ck-numbered__body">${body}</div>` : '') + '</div></li>';

/**
 * @param {Step[]} items
 * @param {{ label?: string, start?: number }} [options]
 */
export const steps = (items, { label = '', start = 0 } = {}) => `<ol${attributes({ class: 'ck-numbered', 'aria-label': label || null })}>`
  + items.map((step, at) => stepMarkup(step, start + at)).join('') + '</ol>';

/**
 * @param {object} field
 * @param {string} field.label
 * @param {Attributes} field.input
 * @param {string} [field.why]
 * @param {string} [field.note]
 * @param {boolean} [field.shown]
 */
export const stepField = ({ label, input, why = '', note = '', shown = true }) => '<label class="ck-stepfield">'
  + (shown ? `<span class="ck-stepfield__label mac-subhead">${esc(label)}</span>` : '')
  + `<input${attributes({ class: `ck-field mac-body${why ? ' is-refused' : ''}`, type: 'text', autocomplete: 'off', spellcheck: 'false',
    autocapitalize: 'off', 'aria-label': label, 'aria-invalid': why ? 'true' : null, ...input })}>`
  + (why ? `<span class="ck-stepfield__why mac-subhead" role="alert">${signalShape('warning')}${esc(why)}</span>` : '')
  + (note ? `<span class="ck-stepfield__note mac-subhead">${icon('private', { size: 'xs' })}${esc(note)}</span>` : '') + '</label>';
