// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { iconButton } from './button.js';
import { boldRuns } from './bold-line.js';
import { icon } from './icon.js';
import { bar } from './skeleton.js';

/** @typedef {import('../../lib/html.js').Attributes} Attributes */

/**
 * @param {object} dialog
 * @param {string} [dialog.icon]
 * @param {string} [dialog.tile]
 * @param {string} dialog.title
 * @param {string | null} [dialog.line]
 * @param {import('./bold-line.js').Bolded} [dialog.said]
 * @param {string} [dialog.mark]
 * @param {string} [dialog.above]
 * @param {string} dialog.body
 * @param {string} [dialog.foot]
 * @param {Attributes} dialog.close
 * @param {{ label: string, attrs: Attributes, above?: boolean } | null} [dialog.back]
 * @param {boolean} [dialog.bare]
 * @param {boolean} [dialog.page]
 * @param {boolean} [dialog.plain]
 */
export function dialog({ icon: meaning = '', tile = '', title, line = '', said = [], mark = '', above = '', body, foot = '', close,
  back = null, bare = false, page = false, plain = false }) {
  const panel = `<div${attributes({ class: `ck-dialog${page ? ' ck-dialog--page' : ''}`, role: bare ? null : 'dialog',
    'aria-modal': bare ? null : 'true', 'aria-label': title })}>`
    + `<header${attributes({ class: `ck-dialog__head${back?.above ? ' ck-dialog__head--back' : ''}` })}>`
    + (back?.above ? '' : back ? `<button${attributes({ type: 'button', class: 'ck-dialog__mark ck-dialog__back', 'aria-label': back.label,
      title: back.label, ...back.attrs })}>${icon('back', { size: 'md' })}</button>`
      : plain ? '' : `<span class="ck-dialog__mark" aria-hidden="true">${tile || icon(meaning, { size: 'md' })}</span>`)
    + '<div class="ck-dialog__titles">'
    + (back?.above ? `<button${attributes({ type: 'button', class: 'ck-dialog__backlink mac-body', 'aria-label': `Back to ${back.label}`,
      ...back.attrs })}>${icon('back', { size: 'sm' })}<span>${esc(back.label)}</span></button>` : '')
    + `<h2 class="ck-dialog__title mac-title-2">${esc(title)}</h2>`
    + (line === null ? `<p class="ck-dialog__line mac-subhead">${bar(6)}</p>`
      : line ? `<p class="ck-dialog__line mac-subhead">${esc(line)}</p>` : '')
    + (said.length ? `<p class="ck-dialog__line mac-subhead">${boldRuns(said)}</p>` : '') + mark + '</div>'
    + `${iconButton('close', 'Close', { attrs: close })}</header>`
    + (above ? `<div class="ck-dialog__above">${above}</div>` : '')
    + `<div class="ck-dialog__body">${body}</div>`
    + (foot ? `<footer class="ck-dialog__foot">${foot}</footer>` : '') + '</div>';
  return bare ? panel : `<div class="ck-scrim" data-scrim>${panel}</div>`;
}

/**
 * @param {() => Element | null} slot
 * @param {() => Element[]} behind
 */
export function dialogHold(slot, behind) {
  /** @type {HTMLElement | null} */
  let opener = null;
  let open = false;
  /** @param {() => HTMLElement | null} [back] */
  return (back = () => null) => {
    const shown = slot()?.querySelector('.ck-dialog') ?? null;
    for (const part of behind()) if (part instanceof HTMLElement) part.inert = shown !== null;
    if ((shown !== null) === open) return;
    open = shown !== null;
    if (shown) {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const first = ['input:not(:disabled)', '.ck-dialog__foot .ck-btn--primary:not(:disabled)',
        '.ck-dialog__foot :is(button, a[href]):not(:disabled)'].map(selector => shown.querySelector(selector))
        .find(each => each instanceof HTMLElement);
      if (first instanceof HTMLElement) first.focus();
      return;
    }
    const to = back() ?? (opener?.isConnected ? opener : null);
    opener = null;
    to?.focus();
  };
}

/** @param {Document} doc */
export function installDialogEdges(doc) {
  doc.addEventListener('scroll', event => {
    const body = event.target;
    if (!(body instanceof Element) || !body.classList.contains('ck-dialog__body')) return;
    body.closest('.ck-dialog')?.classList.toggle('is-scrolled', body.scrollTop > 0);
  }, { capture: true, passive: true });
}
