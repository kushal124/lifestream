// @ts-check
import { esc } from '../../lib/html.js';
import { bar } from './skeleton.js';

/** @typedef {{ value: string, caption: string }} DayFigure */

/**
 * @param {DayFigure[]} figures
 * @param {{ label?: string }} [options]
 */
export const figureRow = (figures, { label = 'The day in figures' } = {}) => !figures.length ? ''
  : `<div class="ck-figrow" role="group" aria-label="${esc(label)}">${figures.map(figure => '<p class="ck-figrow__figure">'
    + `<span class="ck-figrow__value mac-figure-l">${esc(figure.value)}</span>`
    + `<span class="ck-figrow__caption mac-subhead">${esc(figure.caption)}</span></p>`).join('')}</div>`;

/**
 * @param {DayFigure[]} figures
 * @param {{ label?: string }} [options]
 */
export const figureLine = (figures, { label = 'The day in figures' } = {}) => !figures.length ? ''
  : `<p class="ck-figline" role="group" aria-label="${esc(label)}">${figures.map(figure => '<span class="ck-figline__figure">'
    + `<span class="ck-figline__value mac-figure-m">${esc(figure.value)}</span>`
    + `<span class="ck-figline__caption mac-subhead">${esc(figure.caption)}</span></span>`)
    .join('<span class="ck-figline__dot mac-subhead" aria-hidden="true">·</span>')}</p>`;

const VALUES = /** @type {const} */ ([3, 2, 1]);
const CAPTIONS = /** @type {const} */ ([2, 3, 3]);

export const figureRowReading = () => '<div class="ck-figrow" aria-hidden="true">' + VALUES.map((value, at) =>
  `<p class="ck-figrow__figure"><span class="ck-figrow__value mac-figure-l">${bar(value)}</span>`
  + `<span class="ck-figrow__caption mac-subhead">${bar(CAPTIONS[at])}</span></p>`).join('') + '</div>';

export const figureLineReading = () => '<p class="ck-figline" aria-hidden="true">' + VALUES.map((value, at) =>
  `<span class="ck-figline__figure"><span class="ck-figline__value mac-figure-m">${bar(value)}</span>`
  + `<span class="ck-figline__caption mac-subhead">${bar(CAPTIONS[at])}</span></span>`)
  .join('<span class="ck-figline__dot mac-subhead">·</span>') + '</p>';
