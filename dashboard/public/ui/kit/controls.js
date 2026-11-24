// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { icon } from './icon.js';
import { kbd } from './button.js';
import { tick } from './tick.js';

/** @typedef {import('../../lib/html.js').Attributes} Attributes */

/** @param {{ placeholder: string, value?: string, shortcut?: string, outlined?: boolean, waiting?: boolean, attrs?: Attributes, capsule?: Attributes }} field */
export function searchField({ placeholder, value = '', shortcut = '', outlined = false, waiting = false, attrs = {},
  capsule = {} }) {
  return `<label${attributes({ ...capsule, class: `ck-search${outlined ? ' ck-search--outlined' : ''}${waiting ? ' is-waiting' : ''}` })}>`
    + icon('search', { size: 'sm' }) + '<input class="ck-search__input mac-body"'
    + `${attributes({ type: 'search', placeholder, 'aria-label': placeholder, value, autocomplete: 'off', spellcheck: 'false', disabled: waiting, ...attrs })}>`
    + (shortcut ? kbd(shortcut) : '') + '</label>';
}

/**
 * @param {HTMLElement} field
 * @param {boolean} waiting
 */
export function searchWaiting(field, waiting) {
  const label = field.closest('.ck-search');
  const input = label?.querySelector('input');
  if (!label || !input) return;
  label.classList.toggle('is-waiting', waiting);
  input.disabled = waiting;
}

/** @param {{ label: string, name?: string, value?: string, placeholder?: string, type?: 'text' | 'date', attrs?: Attributes }} field */
export function textField({ label, name = '', value = '', placeholder = '', type = 'text', attrs = {} }) {
  return `<input class="ck-field mac-body"${attributes({
    type, name: name || null, value, placeholder: placeholder || null, 'aria-label': label, autocomplete: 'off',
    spellcheck: 'false', ...attrs,
  })}>`;
}

/** @param {{ label: string, text: string, attrs?: Attributes, less: { label: string, attrs?: Attributes, disabled?: boolean }, more: { label: string, attrs?: Attributes, disabled?: boolean } }} stepper */
export function stepper({ label, text, attrs = {}, less, more }) {
  /** @param {string} meaning @param {{ label: string, attrs?: Attributes, disabled?: boolean }} side */
  const side = (meaning, { label: said, attrs: own = {}, disabled = false }) => `<button class="ck-step__btn"${attributes({
    type: 'button', 'aria-label': said, title: said, disabled, ...own,
  })}>${icon(meaning, { size: 'sm' })}</button>`;
  return `<div class="ck-step" role="group"${attributes({ 'aria-label': label, ...attrs })}>${side('back', less)}`
    + `<output class="ck-step__value mac-mono-data" aria-live="polite">${esc(text)}</output>${side('forward', more)}</div>`;
}

/**
 * @param {object} chip
 * @param {'ask' | 'tick' | 'tag'} chip.kind
 * @param {string} chip.label
 * @param {boolean} [chip.on]
 * @param {string} [chip.why]
 * @param {Attributes} [chip.attrs]
 */
export function chip({ kind, label, on = false, why = '', attrs = {} }) {
  const words = `<span class="mac-subhead">${esc(label)}</span>`;
  if (kind === 'tick') {
    return `<button${attributes({ type: 'button', class: `ck-chip ck-chip--tick${on ? ' is-selected' : ''}`, role: 'checkbox',
      'aria-checked': String(on), ...attrs })}>${tick(on)}${words}`
      + (why ? `<span class="ck-chip__why mac-subhead">${esc(`· ${why}`)}</span>` : '') + '</button>';
  }
  if (kind === 'tag') {
    return `<button${attributes({ type: 'button', class: 'ck-chip ck-chip--tag is-selected', ...attrs })}>${words}`
      + `<span class="ck-chip__x" aria-hidden="true">${icon('close', { size: 'xs' })}</span></button>`;
  }
  return `<button${attributes({ type: 'button', class: `ck-chip ck-chip--ask${on ? ' is-selected' : ''}`,
    'aria-haspopup': 'listbox', 'aria-expanded': String(on), ...attrs })}>${words}</button>`;
}

/** @param {{ on: boolean, label: string, busy?: boolean, attrs?: Attributes }} toggle */
export function toggle({ on, label, busy = false, attrs = {} }) {
  return `<button class="ck-toggle${busy ? ' is-busy' : ''}"${attributes({
    type: 'button', role: 'switch', 'aria-checked': String(on), 'aria-label': label, disabled: busy,
    'aria-busy': busy ? 'true' : null, ...attrs,
  })}><span class="ck-toggle__knob"></span></button>`;
}

/** @param {{ label: string, choices: { value: string, words: string, chosen: boolean, attrs?: Attributes }[], attrs?: Attributes }} control */
export function segmented({ label, choices, attrs = {} }) {
  return `<div${attributes({ class: 'ck-seg', role: 'group', 'aria-label': label, ...attrs })}>`
    + choices.map(choice => `<button${attributes({ type: 'button', class: 'ck-seg__item', 'aria-pressed': String(choice.chosen),
      'data-value': choice.value, ...choice.attrs })}>${esc(choice.words)}</button>`).join('') + '</div>';
}

/** @param {{ label: string, share: number, words?: string }} progress */
export function progressLine({ label, share, words = '' }) {
  const percent = Math.round(Math.min(1, Math.max(0, share)) * 100);
  return '<span class="ck-progress-line">'
    + `<span${attributes({ class: 'ck-progress', role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0',
      'aria-valuemax': '100', 'aria-valuenow': String(percent), 'aria-valuetext': words || null })}>`
    + `<span class="ck-progress__fill" data-geo="width:${percent}%"></span></span>`
    + (words ? `<span class="ck-progress__words">${esc(words)}</span>` : '') + '</span>';
}
