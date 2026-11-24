// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { actWords, TRY_AGAIN, WAITING } from '../../lib/reach.js';
import { icon } from './icon.js';
import { signalShape } from './signal.js';
import { waitLine } from './skeleton.js';

/** @typedef {import('../../lib/html.js').Attributes} Attributes */

/**
 * @param {string} meaning
 * @param {string} sentence
 * @param {{ action?: { label: string, attrs?: Attributes, href?: string }, detail?: string }} [options]
 */
export function emptyState(meaning, sentence, { action, detail = '' } = {}) {
  return `<div class="ck-empty">${icon(meaning, { size: 'xl' })}<p class="ck-empty__text mac-title-2">${esc(sentence)}</p>`
    + (detail ? `<p class="ck-empty__detail mac-body">${esc(detail)}</p>` : '')
    + (action?.href ? `<a${attributes({ class: 'ck-btn ck-btn--secondary ck-btn--md mac-headline', href: action.href,
      ...action.attrs })}>${esc(action.label)}</a>`
      : action ? `<button type="button" class="ck-btn ck-btn--secondary ck-btn--md mac-headline"${attributes(action.attrs ?? {})}>`
        + `${esc(action.label)}</button>` : '')
    + '</div>';
}

/**
 * @param {string} sentence
 * @param {{ detail?: string }} [options]
 */
export const noneLine = (sentence, { detail = '' } = {}) => `<div class="ck-none"><p class="ck-none__text mac-subhead">`
  + `${esc(sentence)}</p>${detail ? `<p class="ck-none__detail mac-footnote">${detail}</p>` : ''}</div>`;

/**
 * @param {string} [label]
 * @param {{ size?: 'page' | 'inline', words?: string }} [options]
 */
export const loading = (label = 'Loading', { size = 'page', words = '' } = {}) => `<div class="ck-loading ck-loading--${size}" role="status" aria-label="${esc(label)}">`
  + '<span class="ck-loading__mark" aria-hidden="true"></span>'
  + (size === 'page' ? `<p class="ck-loading__wait mac-body" aria-hidden="true">${esc(words || WAITING)}</p>` : '') + '</div>';

/**
 * @param {string} sentence
 * @param {{ retry?: Attributes, reach?: boolean }} [options]
 */
export function pageLack(sentence, { retry, reach = false } = {}) {
  return `<div class="ck-lack${reach ? ' ck-lack--reach' : ''}" role="status"><p class="ck-lack__text mac-footnote">${esc(sentence)}</p>`
    + (retry ? `<button type="button" class="ck-btn ck-btn--plain ck-btn--sm mac-headline"${attributes(retry)}>${esc(TRY_AGAIN)}</button>` : '')
    + '</div>';
}

/**
 * @param {import('../../lib/reach.js').Drawn} drawn
 * @param {string} sentence
 */
export const readingAgain = (drawn, sentence) => waitLine(drawn.kind === 'wait' ? drawn.words : '') + pageLack(sentence, { reach: true });

/**
 * @param {import('../../lib/reach.js').Drawn} drawn
 * @param {{ notHere: string, unread: string, retry?: Attributes, lacking?: boolean }} words
 */
export function readFailure(drawn, { notHere, unread, retry, lacking = false }) {
  if (drawn.kind === 'lack') return pageLack(drawn.words ?? unread, drawn.retry && retry ? { retry } : {});
  return `<div class="ck-reading${lacking ? ' ck-lacks' : ''}">${readingAgain(drawn, notHere)}</div>`;
}

/**
 * @param {string} words
 * @param {{ said?: import('../../lib/reach.js').Said, retry?: Attributes, label?: string, shape?: 'warning' | 'caution' }} [options]
 */
export function inPlaceLine(words, { said, retry, label = TRY_AGAIN, shape = 'warning' } = {}) {
  const sentence = said ? actWords({ said, words }) : words;
  const again = retry && (!said || said === 'not-sent') ? retry : null;
  return `<div class="ck-in-place" role="alert">${signalShape(shape, { size: 14 })}<span class="mac-body">${esc(sentence)}</span>`
    + (again ? `<button type="button" class="ck-in-place__act mac-headline"${attributes(again)}>${esc(label)}</button>` : '')
    + '</div>';
}
