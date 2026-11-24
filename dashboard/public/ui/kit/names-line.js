// @ts-check
/** @import { DayName } from '../../pages.js' */
import { attributes, esc } from '../../lib/html.js';
import { bar } from './skeleton.js';

/** @param {{ block: string, names: DayName[] }} line */
export function namesLine({ block, names }) {
  if (!names.length) return '';
  return '<div class="dy-names mac-body" data-k="names" data-c="name" data-d-fit="names">'
    + names.map((name, at) => `<button${attributes({ type: 'button', class: 'dy-name', 'data-d-name': name.first_row,
      'data-d-block': block, tabindex: '-1' })}>${esc(name.text)}</button>`
      + (at < names.length - 1 ? '<span class="dy-names__comma">, </span>' : '')).join('')
    + '<span class="dy-names__more" hidden></span></div>';
}

export const namesLineReading = () => `<div class="dy-names mac-body" aria-hidden="true">${bar(8)}</div>`;
