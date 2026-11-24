// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { iconButton } from './button.js';
import { icon } from './icon.js';

/** @typedef {{ id: string, title: string, done: boolean, href: string, flow: string }} FinishItem */

const RING = 2 * Math.PI * 9;

/** @param {number} n */
const at = n => Math.round(n * 100) / 100;

/** @param {readonly FinishItem[]} items */
export const finishLeft = items => items.filter(item => !item.done).length;

/** @param {FinishItem} item */
function finishRow(item) {
  const mark = `<span class="ck-finish__mark" aria-hidden="true">${item.done ? icon('done', { size: 'xs' }) : ''}</span>`;
  const words = `<span class="ck-finish__words">${esc(item.title)}</span>`;
  if (item.done) return `<li><span class="ck-finish__item is-done">${mark}${words}<span class="sr-only">, done</span></span></li>`;
  return `<li>${item.flow
    ? `<button${attributes({ type: 'button', class: 'ck-finish__item', 'data-finish-flow': item.flow })}>${mark}${words}</button>`
    : `<a${attributes({ class: 'ck-finish__item', href: item.href })}>${mark}${words}</a>`}</li>`;
}

/**
 * @param {readonly FinishItem[]} items
 * @param {{ id?: string, flying?: boolean }} [options]
 */
export function finishCard(items, { id = 'ck-finish', flying = false } = {}) {
  const done = items.length - finishLeft(items);
  return `<section${attributes({ class: `ck-finish${flying ? ' is-flying' : ''}`, 'aria-labelledby': `${id}-title`,
    'data-finish': '' })}>`
    + `<header class="ck-finish__head"><h2 class="ck-finish__title mac-headline" id="${esc(id)}-title">Finish setting up</h2>`
    + iconButton('close', 'Hide Finish setting up', { className: 'ck-finish__hide', attrs: { 'data-finish-hide': '' } })
    + '</header>'
    + '<div class="ck-finish__progress"><span class="ck-finish__bar" aria-hidden="true">'
    + `<span class="ck-finish__fill" data-geo="--done: ${at(done / items.length)}"></span></span>`
    + `<span class="ck-finish__count mac-mono-data">${done} of ${items.length} done</span></div>`
    + `<ul class="ck-finish__list">${items.map(finishRow).join('')}</ul></section>`;
}

/**
 * @param {readonly FinishItem[]} items
 * @param {boolean} open
 */
export function finishRing(items, open) {
  const left = finishLeft(items);
  const filled = at(RING * (items.length - left) / items.length);
  return `<button${attributes({ type: 'button', class: 'ck-finish-ring', 'data-finish-ring': '', 'aria-expanded': String(open),
    'aria-label': `Finish setting up, ${left} left`, title: `Finish setting up · ${left} left` })}>`
    + '<svg class="ck-finish-ring__dial" viewBox="0 0 24 24" aria-hidden="true">'
    + '<circle class="ck-finish-ring__track" cx="12" cy="12" r="9"/>'
    + `<circle class="ck-finish-ring__done" cx="12" cy="12" r="9" stroke-dasharray="${filled} ${at(RING)}" transform="rotate(-90 12 12)"/>`
    + `</svg><span class="ck-finish-ring__left mac-mono-data" aria-hidden="true">${left}</span></button>`;
}

export const FINISH_GONE = 'Hidden. It’s in your account menu.';

export const finishGone = () => `<p class="ck-finish-gone mac-subhead" data-finish-gone role="status">${esc(FINISH_GONE)} `
  + '<button class="ck-finish-gone__undo mac-headline" type="button" data-finish-undo>Undo</button></p>';
