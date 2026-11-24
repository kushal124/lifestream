// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { icon } from './icon.js';

/**
 * @param {object} chip
 * @param {string} chip.label
 * @param {string} [chip.glyph]
 * @param {string} [chip.href]
 * @param {string} [chip.title]
 * @param {boolean} [chip.forced]
 */
export function factChip({ label, glyph = '', href = '', title = '', forced = false }) {
  const inner = (glyph ? icon(glyph, { size: 'xs' }) : '') + `<span class="mac-subhead">${esc(label)}</span>`;
  const classes = `ck-factchip${href ? ' ck-factchip--link' : ''}${forced ? ' is-hover' : ''}`;
  return href
    ? `<a${attributes({ class: classes, href, target: '_blank', rel: 'noopener noreferrer', title: title || null })}>${inner}</a>`
    : `<span${attributes({ class: classes, title: title || null })}>${inner}</span>`;
}

/** @param {string[]} chips */
export const factChips = chips => chips.length ? `<div class="ck-factchips">${chips.join('')}</div>` : '';
