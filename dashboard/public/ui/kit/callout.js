// @ts-check
import { esc } from '../../lib/html.js';
import { signalShape } from './signal.js';

/**
 * @param {object} callout
 * @param {import('./signal.js').SignalKind | null} callout.kind
 * @param {string} callout.title
 * @param {string[]} [callout.lines]
 * @param {string[]} [callout.steps]
 * @param {string} [callout.acts]
 * @param {boolean} [callout.choice]
 * @param {string} [callout.note]
 */
export function callout({ kind, title, lines = [], steps = [], acts = '', choice = false, note = '' }) {
  return `<section class="ck-callout${kind ? '' : ' ck-callout--bare'}" role="status">`
    + (kind ? `<span class="ck-callout__shape" aria-hidden="true">${signalShape(kind)}</span>` : '')
    + `<div class="ck-callout__main"><p class="ck-callout__title mac-headline">${esc(title)}</p>`
    + lines.map(line => `<p class="ck-callout__line mac-body">${esc(line)}</p>`).join('')
    + (steps.length ? '<ol class="ck-callout__steps">' + steps.map(step => `<li class="mac-body">${esc(step)}</li>`)
      .join('') + '</ol>' : '')
    + (note ? `<p class="ck-callout__note mac-footnote">${esc(note)}</p>` : '') + '</div>'
    + (acts ? `<span class="ck-callout__acts${choice ? ' ck-callout__acts--choice' : ''}">${acts}</span>` : '') + '</section>';
}
