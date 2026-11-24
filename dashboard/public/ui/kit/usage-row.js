// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { icon } from './icon.js';
import { toneClass } from './disk-bar.js';

/**
 * @param {object} row
 * @param {string} row.part
 * @param {string} row.name
 * @param {import('./disk-bar.js').Tone} row.tone
 * @param {string} [row.line]
 * @param {number} row.share
 * @param {string} row.size
 * @param {import('../../lib/html.js').Attributes | null} [row.go]
 */
export function usageRow({ part, name, tone, line = '', share, size, go = null }) {
  const body = `<i class="ck-urow__swatch ${toneClass(tone)}" aria-hidden="true"></i>`
    + `<span class="ck-urow__words"><span class="ck-urow__name">${esc(name)}</span>`
    + (line ? `<span class="ck-urow__line">${esc(line)}</span>` : '') + '</span>'
    + `<span class="ck-urow__share" aria-hidden="true"><i${attributes({ class: toneClass(tone),
      'data-geo': `width:${Math.min(100, Math.max(2, share)).toFixed(1)}%` })}></i></span>`
    + `<span class="ck-urow__size">${esc(size)}</span>`;
  if (!go) return `<li${attributes({ class: 'ck-urow', 'data-part': part })}><div class="ck-urow__hit">${body}<span class="ck-urow__chev"></span></div></li>`;
  return `<li${attributes({ class: 'ck-urow ck-urow--go', 'data-part': part })}><button${attributes({ type: 'button',
    class: 'ck-urow__hit', 'aria-label': `${name}: ${size}`, ...go })}>${body}`
    + `<span class="ck-urow__chev" aria-hidden="true">${icon('forward', { size: 'xs' })}</span></button></li>`;
}
