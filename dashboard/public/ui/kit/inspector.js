// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { icon } from './icon.js';
import { iconButton } from './button.js';
import { bar, lines, waitLine } from './skeleton.js';

/** @typedef {import('../../lib/html.js').Attributes} Attributes */

const TITLE = 6;
const META = 7;

/**
 * @param {object} head
 * @param {string | null} head.icon
 * @param {string | null} head.title
 * @param {string[] | null} head.meta
 * @param {string} [head.chips]
 * @param {string} [head.tools]
 * @param {{ label: string, attrs: Attributes }} [head.back]
 * @param {Attributes} head.close
 */
function headOf({ icon: meaning, title, meta, chips = '', tools = '', back, close }) {
  const said = meta?.filter(Boolean) ?? null;
  return '<header class="ck-inspector__head">'
    + (back ? `<button class="ck-inspector__back ck-btn ck-btn--plain ck-btn--sm mac-subhead"${attributes({ type: 'button', ...back.attrs })}>`
      + `${icon('back', { size: 'xs' })}<span>${esc(back.label)}</span></button>` : '')
    + `<span class="ck-inspector__tile">${meaning === null ? '' : icon(meaning, { size: 'md' })}</span>`
    + '<div class="ck-inspector__names">'
    + `<h2 class="ck-inspector__title mac-title-2">${title === null ? bar(TITLE) : esc(title)}</h2>`
    + (said === null ? `<p class="ck-inspector__meta mac-subhead">${bar(META)}</p>`
      : said.length ? `<p class="ck-inspector__meta mac-subhead">${said.map(esc).join(' · ')}</p>` : '')
    + '</div>'
    + iconButton('close', 'Close', { attrs: close, className: 'ck-inspector__close' })
    + (chips ? `<div class="ck-inspector__chips">${chips}</div>` : '')
    + (tools ? `<div class="ck-inspector__tools">${tools}</div>` : '')
    + '</header>';
}

/**
 * @param {object} frame
 * @param {string} frame.icon
 * @param {string} frame.title
 * @param {string[]} frame.meta
 * @param {string} [frame.chips]
 * @param {string} [frame.tools]
 * @param {{ label: string, attrs: Attributes }} [frame.back]
 * @param {string} frame.body
 * @param {string} [frame.foot]
 * @param {Attributes} frame.close
 * @param {string} [frame.label]
 */
export function inspector(frame) {
  return `<section class="ck-inspector" aria-label="${esc(frame.label ?? frame.title)}">${headOf(frame)}`
    + `<div class="ck-inspector__body">${frame.body}</div>`
    + (frame.foot ?? '')
    + '</section>';
}

/**
 * @param {object} frame
 * @param {{ icon: string, title: string, meta: string }} [frame.head]
 * @param {string} [frame.tools]
 * @param {Attributes} frame.close
 */
export function inspectorReading({ head, tools = '', close }) {
  return `<section class="ck-inspector" aria-label="${esc(head?.title ?? 'Reading the moment')}">`
    + headOf({ icon: head?.icon ?? null, title: head?.title ?? null, meta: head ? [head.meta] : null, tools, close })
    + `<div class="ck-inspector__body">${lines(4)}${waitLine()}</div></section>`;
}

/**
 * @param {string[]} lines
 * @param {Attributes} [attrs]
 */
export function sourceFold(lines, attrs = {}) {
  return `<details class="ck-source"${attributes(attrs)}><summary class="ck-source__summary">`
    + `<span class="mac-mono-label">Source</span>${icon('expand', { size: 'xs', className: 'ck-source__chevron' })}</summary>`
    + `<div class="ck-source__lines mac-mono-data">${lines.map(line => `<p>${esc(line)}</p>`).join('')}</div>`
    + '<div class="ck-source__body"></div></details>';
}
