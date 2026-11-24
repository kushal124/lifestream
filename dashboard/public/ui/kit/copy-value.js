// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { icon } from './icon.js';

export const COPIED_MS = 1500;

/**
 * @param {object} value
 * @param {string} value.value
 * @param {string} value.label
 * @param {import('../../lib/html.js').Attributes} [value.attrs]
 * @param {boolean} [value.unseen]
 * @param {boolean} [value.key]
 * @param {boolean} [value.line]
 */
export const copyValue = ({ value, label, attrs = {}, unseen = false, key = false, line = false }) =>
  `<div class="ck-copy${key ? ' ck-copy--key' : ''}${line ? ' ck-copy--line' : ''}">`
  + `<span${attributes({ class: `ck-copy__value mac-mono-data${unseen ? ' is-unseen' : ''}`, 'aria-label': label,
    'aria-hidden': unseen ? 'true' : null })}>${esc(value)}</span>`
  + `<button${attributes({ type: 'button', class: `ck-ibtn ck-copy__btn${unseen ? ' is-unseen' : ''}`,
    'aria-label': `Copy ${label.toLowerCase()}`, title: 'Copy', disabled: unseen, ...attrs })}>`
  + `${icon('copy', { className: 'ck-copy__glyph' })}${icon('done', { className: 'ck-copy__check' })}</button>`
  + '<span class="ck-copy__said sr-only" aria-live="polite"></span></div>';

/** @param {Element} button */
export function showCopied(button) {
  if (!(button instanceof HTMLElement)) return;
  const said = button.parentElement?.querySelector('.ck-copy__said');
  button.classList.add('is-copied');
  button.title = 'Copied';
  if (said) said.textContent = 'Copied';
  window.clearTimeout(Number(button.dataset.copied ?? 0));
  button.dataset.copied = String(window.setTimeout(() => {
    button.classList.remove('is-copied');
    button.title = 'Copy';
    if (said) said.textContent = '';
    delete button.dataset.copied;
  }, COPIED_MS));
}
