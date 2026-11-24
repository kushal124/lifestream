// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { icon } from './icon.js';
import { bar } from './skeleton.js';
import { tip } from './tip.js';

/**
 * @param {string} text
 * @param {{ action?: string, level?: 2 | 3, id?: string, count?: number | null, about?: string, open?: import('../../lib/html.js').Attributes }} [options]
 */
export function sectionLabel(text, { action = '', level = 2, id = '', count, about = '', open } = {}) {
  const counted = count === undefined ? '' : ` <span class="ck-section__count">${count === null ? bar(1)
    : count.toLocaleString('en-US')}</span>`;
  if (open) {
    return `<div class="ck-section"><h${level} class="ck-section__label mac-mono-label"${attributes({ id: id || null })}>`
      + `<button${attributes({ type: 'button', class: 'ck-section__open', ...open })}><span class="ck-section__words">`
      + `${esc(text)}${counted}</span><span class="ck-section__chev" aria-hidden="true">${icon('forward', { size: 'xs' })}</span>`
      + `</button></h${level}></div>`;
  }
  const heading = `<h${level} class="ck-section__label mac-mono-label"${attributes({ id: id || null })}>`
    + `${esc(text)}${counted}</h${level}>`;
  return `<div class="ck-section">${about ? `<span class="ck-section__titled">${heading}${tip({ label: text, text: about })}</span>`
    : heading}${action}</div>`;
}

/** @param {import('./skeleton.js').BarWidth} width */
export const sectionLabelReading = width => '<div class="ck-section"><h2 class="ck-section__label mac-mono-label"'
  + ` aria-hidden="true">${bar(width)}</h2></div>`;
