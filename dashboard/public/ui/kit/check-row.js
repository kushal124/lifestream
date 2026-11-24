// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { checkDisc } from './button.js';
import { signalShape } from './signal.js';
import { sectionLabel } from './surface.js';

/** @typedef {'done' | 'here' | 'idle'} CheckState */

/** @type {Record<CheckState, string>} */
const HEARD = { done: 'done', here: 'next', idle: 'to do' };

/** @param {CheckState} state */
export const checkMark = state => state === 'done' ? checkDisc({ size: 14 })
  : state === 'here' ? '<span class="ck-here"></span>' : '<span class="ck-ring"></span>';

/**
 * @param {object} row
 * @param {string} row.id
 * @param {CheckState} row.mark
 * @param {string} row.name
 * @param {string} row.line
 * @param {string} [row.end]
 * @param {string} [row.why]
 */
export const checkRow = ({ id, mark, name, line, end = '', why = '' }) => `<li class="ck-chk is-${mark}">`
  + `<span${attributes({ class: 'ck-chk__mark', 'aria-hidden': 'true', 'data-arrive': `${id}:mark` })}>`
  + `${checkMark(mark)}<span hidden>${mark}</span></span>`
  + `<span class="ck-chk__main"><span class="ck-chk__name mac-headline">${esc(name)}<span class="sr-only">, ${HEARD[mark]}</span></span>`
  + (why ? `<span${attributes({ class: 'ck-chk__line ck-chk__why mac-subhead', role: 'alert', 'data-arrive': `${id}:line` })}>`
    + `${signalShape('warning')}${esc(why)}</span>`
    : line ? `<span${attributes({ class: 'ck-chk__line mac-subhead', 'data-arrive': `${id}:line` })}>${esc(line)}</span>` : '')
  + `</span><span${attributes({ class: 'ck-chk__end', 'data-arrive': `${id}:end` })}>${end}</span></li>`;

/**
 * @param {string[]} rows
 * @param {{ label: string, notes?: string[] }} options
 */
export const checkPanel = (rows, { label, notes = [] }) => `<section${attributes({ class: 'ck-group ck-chks', 'aria-label': label })}>`
  + sectionLabel(label, { level: 3 }) + `<ul class="ck-group__rows">${rows.join('')}</ul>`
  + notes.map(note => `<p class="ck-chks__note mac-footnote">${esc(note)}</p>`).join('') + '</section>';

/** @param {ParentNode} root */
export const checkPanelHere = root => root.querySelector('.ck-chks .ck-here')?.getBoundingClientRect() ?? null;

/**
 * @param {ParentNode} root
 * @param {DOMRect | null} from
 */
export function checkPanelTravel(root, from) {
  const disc = /** @type {HTMLElement | null} */ (root.querySelector('.ck-chks .ck-here'));
  if (!disc || !from || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const to = disc.getBoundingClientRect();
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  if (!dx && !dy) return;
  disc.classList.remove('is-travelling');
  disc.style.transform = `translate(${dx}px, ${dy}px)`;
  void disc.offsetWidth;
  disc.classList.add('is-travelling');
  disc.style.transform = '';
  disc.addEventListener('transitionend', () => disc.classList.remove('is-travelling'), { once: true });
}
