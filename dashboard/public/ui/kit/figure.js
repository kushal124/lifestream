// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { bar } from './skeleton.js';

/**
 * @typedef {object} Figure
 * @property {string} value
 * @property {string} label
 * @property {import('../../lib/html.js').Attributes} [attrs]
 * @property {boolean} [selected]
 */

/** @param {Figure} figure */
export function figure({ value, label, attrs, selected = false }) {
  const tag = attrs ? 'button' : 'div';
  const extra = attrs ? attributes({ type: 'button', 'aria-pressed': String(selected), ...attrs }) : '';
  return `<${tag} class="ck-figure${selected ? ' is-selected' : ''}"${extra}>`
    + `<span class="ck-figure__value mac-figure-l">${esc(value)}</span>`
    + `<span class="ck-figure__label mac-footnote">${esc(label)}</span></${tag}>`;
}

/**
 * @param {Figure[]} figures
 * @param {{ label?: string }} [options]
 */
export function figureStrip(figures, { label = 'Figures' } = {}) {
  if (!figures.length) return '';
  return `<div class="ck-figures" role="group" aria-label="${esc(label)}">${figures.map(figure).join('')}</div>`;
}

const VALUES = /** @type {const} */ ([1, 2, 1, 2]);
const LABELS = /** @type {const} */ ([3, 2, 3, 2]);

/** @param {number} count */
export const figureStripReading = count => '<div class="ck-figures" aria-hidden="true">'
  + Array.from({ length: count }, (_, at) => '<div class="ck-figure">'
    + `<span class="ck-figure__value mac-figure-l">${bar(VALUES, at)}</span>`
    + `<span class="ck-figure__label mac-footnote">${bar(LABELS, at)}</span></div>`).join('')
  + '</div>';

/**
 * @param {string} label
 * @param {string} value
 * @param {number} share
 * @param {{ step?: 1 | 2 | 3 | 4, progress?: boolean }} [options]
 */
export function meter(label, value, share, { step = 1, progress = false } = {}) {
  const width = Math.round(Math.max(0, Math.min(1, share)) * 1000) / 10;
  return `<div class="ck-meter"><div class="ck-meter__row"><span class="ck-meter__label mac-body">${esc(label)}</span>`
    + `<span class="ck-meter__value mac-mono-data">${esc(value)}</span></div>`
    + `<svg class="ck-meter__track" viewBox="0 0 100 4" preserveAspectRatio="none" role="meter" aria-valuemin="0" `
    + `aria-valuemax="100" aria-valuenow="${Math.round(width)}" aria-label="${esc(label)}">`
    + `<rect class="ck-meter__fill ${progress ? 'ck-meter__fill--here' : `ck-data-${step}`}" width="${width}" height="4"/></svg></div>`;
}
