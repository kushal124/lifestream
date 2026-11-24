// @ts-check
import { esc } from '../../lib/html.js';

/**
 * @typedef {{ phosphor?: string, regular?: string[], fill?: string[], stroke?: string[], solid?: string[] }} Drawing
 * @typedef {'xs' | 'sm' | 'md' | 'lg' | 'xl'} IconSize
 */

/** @type {Record<string, Drawing>} */
let drawings = {};

/** @param {{ icons: Record<string, Drawing> }} table */
export function setIcons(table) {
  drawings = table.icons;
}

/**
 * @param {string} meaning
 * @param {{ size?: IconSize, fill?: boolean, label?: string, className?: string }} [options]
 */
export function icon(meaning, { size = 'sm', fill = false, label = '', className = '' } = {}) {
  const drawing = drawings[meaning];
  const a11y = label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"';
  const open = `<svg class="ck-icon ck-icon--${size}${className ? ` ${className}` : ''}" viewBox="0 0 256 256" `;
  const draw = (/** @type {string[]} */ paths, extra = '') => paths.map(path => `<path d="${path}"${extra}/>`).join('');
  if (drawing?.stroke) {
    const solid = fill && drawing.solid ? draw(drawing.solid, ' fill="currentColor" stroke="none"') : '';
    return `${open}fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" `
      + `focusable="false" ${a11y}>${draw(drawing.stroke)}${solid}</svg>`;
  }
  const paths = drawing ? (fill && drawing.fill?.length ? drawing.fill : drawing.regular ?? []) : [];
  return `${open}fill="currentColor" focusable="false" ${a11y}>${draw(paths)}</svg>`;
}
