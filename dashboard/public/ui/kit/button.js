// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { icon } from './icon.js';
import { signalShape } from './signal.js';

/** @typedef {import('../../lib/html.js').Attributes} Attributes */

export const spinner = () => '<span class="ck-spinner" aria-hidden="true"></span>';

const DONE_CHECK = '<svg class="ck-btn__check" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">'
  + '<path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * @param {string} label
 * @param {{ variant?: 'primary' | 'secondary' | 'plain' | 'link', tone?: 'neutral' | 'caution' | 'warning', icon?: string, size?: 'md' | 'sm', key?: string, busy?: boolean, done?: string, disabled?: boolean, attrs?: Attributes, className?: string, href?: string }} [options]
 */
export function button(label, { variant = 'secondary', tone = 'neutral', icon: meaning = '', size = 'md', key = '',
  busy = false, done = '', disabled = false, attrs = {}, className = '', href = '' } = {}) {
  const classes = ['ck-btn', `ck-btn--${variant}`, `ck-btn--${size}`, tone === 'neutral' ? '' : `ck-tone--${tone}`,
    busy ? 'is-busy' : '', done ? 'is-done' : '', 'mac-headline', className].filter(Boolean).join(' ');
  if (href) {
    return `<a class="${classes}"${attributes({ href, target: '_blank', rel: 'noopener noreferrer', ...attrs })}>`
      + `<span class="ck-btn__label">${esc(label)}</span></a>`;
  }
  return `<button class="${classes}"${attributes({ type: 'button', disabled: disabled || busy, 'aria-busy': busy ? 'true' : null, ...attrs })}>`
    + (meaning ? icon(meaning) : '')
    + `<span class="ck-btn__label">${esc(label)}</span>`
    + (key ? `<span class="ck-btn__key mac-subhead" aria-hidden="true">${esc(key)}</span>` : '')
    + (busy ? spinner() : '')
    + (done ? `<span class="ck-btn__done" role="status">${DONE_CHECK}${esc(done)}</span>` : '') + '</button>';
}

/**
 * @param {string} label
 * @param {{ state?: 'idle' | 'busy' | 'working' | 'done', done?: string, waiting?: string, why?: string, after?: boolean, variant?: 'primary' | 'secondary' | 'plain' | 'link', tone?: 'neutral' | 'warning', disabled?: boolean, attrs?: Attributes }} [options]
 */
export function action(label, { state = 'idle', done = '', waiting = WAITING, why = '', after = false,
  variant = 'secondary', tone = 'neutral', disabled = false, attrs = {} } = {}) {
  const busy = state === 'busy';
  const shown = state === 'done' ? 'done' : busy || state === 'working' ? 'busy' : 'idle';
  const faces = actionFaces(label, { waiting: (variant === 'plain' || variant === 'link') && state !== 'working' ? '' : waiting, done, shown });
  const own = state === 'done' ? `<span class="ck-btn ck-btn--md ck-action__btn ck-done mac-headline">${faces}</span>`
    : state === 'working' ? `<span${attributes(workingAttrs(waiting))}>${faces}</span>`
    : `<button${attributes({ type: 'button',
      class: `ck-btn ck-btn--${variant} ck-btn--md ck-action__btn${tone === 'warning' ? ' ck-tone--warning' : ''}${
        busy ? ' is-busy' : ''} mac-headline`,
      disabled: disabled || busy, 'aria-busy': busy ? 'true' : null, ...attrs })}>${faces}</button>`;
  if (!why) return own;
  return `<span class="ck-action${after ? ' ck-action--after' : ''}">`
    + `<span class="ck-action__note mac-subhead" role="alert"${attributes({ title: why })}>${signalShape('warning')}`
    + `${esc(why)}</span>${own}</span>`;
}

export const WAITING = 'Waiting';

/**
 * @param {string} label
 * @param {{ waiting: string, done: string, shown: 'idle' | 'busy' | 'done' }} faces
 */
function actionFaces(label, { waiting, done, shown }) {
  const held = (/** @type {boolean} */ seen) => seen ? '' : ' ck-held';
  /** @param {string} words @param {boolean} seen @param {string} [kind] */
  const said = (words, seen, kind = '') => seen ? `<span${attributes({ class: kind || null })}>${esc(words)}</span>`
    : `<span${attributes({ class: `ck-action__said${kind ? ` ${kind}` : ''}`, 'data-words': words })}></span>`;
  return `<span class="ck-btn__label${held(shown !== 'done')}"${shown === 'done' ? ' aria-hidden="true"' : ''}>`
    + `${shown === 'done' ? said(label, false) : esc(label)}</span>`
    + (waiting ? `<span class="ck-action__face ck-action__face--busy${held(shown === 'busy')}" aria-hidden="true">${
      spinner()}${said(waiting, shown === 'busy')}</span>` : '')
    + (done ? `<span class="ck-action__face ck-action__face--done${held(shown === 'done')}"${
      shown === 'done' ? '' : ' aria-hidden="true"'}>${icon('done', { size: 'xs' })}${said(done, shown === 'done',
      'ck-done__words')}</span>` : '');
}

/**
 * @param {string} words
 * @param {{ attrs?: Attributes }} [options]
 */
export const connected = (words, { attrs = {} } = {}) => `<span${attributes({
  class: 'ck-btn ck-btn--md ck-action__btn ck-done mac-headline', ...attrs })}>`
  + `<span class="ck-action__face ck-action__face--done">${icon('done', { size: 'xs' })}<span class="ck-done__words">${
    esc(words)}</span></span></span>`;

/** @param {{ words?: string, attrs?: Attributes }} [options] */
export const working = ({ words = WAITING, attrs = {} } = {}) => `<span${attributes({ ...workingAttrs(words), ...attrs })}>`
  + `<span class="ck-action__face ck-action__face--busy">${spinner()}<span>${esc(words)}</span></span></span>`;

/**
 * @param {string} words
 * @returns {Attributes}
 */
const workingAttrs = words => ({ class: 'ck-btn ck-btn--md ck-action__btn ck-working is-busy mac-headline', role: 'status',
  'aria-busy': 'true', 'aria-label': words });

/** @param {{ size?: number }} [options] */
export const checkDisc = ({ size = 16 } = {}) => `<svg class="ck-checkdisc" width="${size}" height="${size}" `
  + 'viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" fill="currentColor"/>'
  + '<path d="M4.6 8.3l2.3 2.2 4.5-4.8" fill="none" class="ck-checkdisc__tick" stroke-width="1.75" '
  + 'stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * @param {string} label
 * @param {string} href
 */
export const linkButton = (label, href) => `<a class="ck-btn ck-btn--plain ck-btn--sm mac-headline"${attributes({
  href, target: '_blank', rel: 'noopener noreferrer' })}><span class="ck-btn__label">${esc(label)}</span>${icon('open-out', { size: 'xs' })}</a>`;

/**
 * @param {string} meaning
 * @param {string} label
 * @param {{ variant?: 'plain' | 'raised' | 'secondary' | 'glass', attrs?: Attributes, pressed?: boolean, disabled?: boolean, className?: string }} [options]
 */
export function iconButton(meaning, label, { variant = 'plain', attrs = {}, pressed, disabled = false, className = '' } = {}) {
  return `<button class="ck-ibtn ck-ibtn--${variant}${className ? ` ${className}` : ''}"${attributes({
    type: 'button', 'aria-label': label, title: label, 'aria-pressed': pressed === undefined ? null : String(pressed),
    disabled, ...attrs,
  })}>${icon(meaning)}</button>`;
}

/**
 * @param {string} text
 * @param {{ tone?: 'neutral' | 'plan' | 'now' | 'engaged' | 'caution' | 'warning', mono?: boolean }} [options]
 */
export const tag = (text, { tone = 'neutral', mono = false } = {}) => `<span class="ck-tag ck-tag--${tone} `
  + `${mono ? 'mac-mono-data' : 'mac-label'}">${esc(text)}</span>`;

/** @param {string} keys */
export const kbd = keys => `<kbd class="ck-kbd mac-mono-data">${esc(keys)}</kbd>`;
