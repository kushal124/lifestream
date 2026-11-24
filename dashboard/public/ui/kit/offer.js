// @ts-check
import { esc } from '../../lib/html.js';
import { icon } from './icon.js';

/** @param {{ icon: string, name: string, line: string, end: string }} offer */
export const offer = ({ icon: meaning, name, line, end }) => '<div class="ck-offer">'
  + `<span class="ck-offer__icon" aria-hidden="true">${icon(meaning)}</span>`
  + `<span class="ck-offer__main"><span class="mac-headline">${esc(name)}</span>`
  + (line ? `<span class="ck-offer__line mac-subhead">${esc(line)}</span>` : '') + '</span>' + end + '</div>';

/** @param {string[]} offers */
export const offers = offers => `<div class="ck-offers">${offers.join('')}</div>`;

