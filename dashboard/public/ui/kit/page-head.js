// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { icon } from './icon.js';

/** @typedef {import('../../lib/html.js').Attributes} Attributes */

/**
 * @param {object} head
 * @param {string} [head.title]
 * @param {{ label: string, attrs?: Attributes }} [head.back]
 * @param {string} [head.name]
 * @param {string} [head.lead]
 * @param {string[]} [head.tools]
 */
export function pageHead({ title = '', back, name = '', lead, tools = [] }) {
  const left = lead ?? (back
    ? '<div class="ck-page__crumb">'
      + `<button${attributes({ type: 'button', class: 'ck-page__back ck-back mac-body', ...back.attrs })}>`
      + `${icon('back', { size: 'sm' })}<span>${esc(back.label)}</span></button>`
      + `<span class="ck-page__name mac-headline">${esc(name)}</span></div>`
    : `<h1 class="ck-page__title mac-display">${esc(title)}</h1>`);
  return `${left}<div class="ck-page__tools">${tools.join('')}</div>`;
}

/** @param {Document} doc */
export function installPageHeads(doc) {
  doc.addEventListener('scroll', event => {
    const scroll = event.target;
    if (!(scroll instanceof Element) || !scroll.classList.contains('ck-page__scroll')) return;
    scroll.closest('.ck-page')?.classList.toggle('is-scrolled', scroll.scrollTop > 0);
  }, { capture: true, passive: true });
}
