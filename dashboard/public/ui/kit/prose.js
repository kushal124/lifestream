// @ts-check
import { attributes, esc, textHead } from '../../lib/html.js';
import { icon } from './icon.js';
import { personFace } from './person-face.js';

/** @typedef {import('../../lib/html.js').Attributes} Attributes */

const ADDRESS = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}’”]/gu;

/** @param {string} words */
export function linked(words) {
  let html = '';
  let at = 0;
  for (const match of words.matchAll(ADDRESS)) {
    const index = /** @type {number} */ (match.index);
    const shown = match[0].replace(/^https?:\/\/(?:www\.)?/u, '');
    html += esc(words.slice(at, index)) + `<a${attributes({ href: match[0], target: '_blank', rel: 'noopener noreferrer' })}>`
      + `${esc(shown.length > 64 ? `${textHead(shown, 63)}…` : shown)}</a>`;
    at = index + match[0].length;
  }
  return html + esc(words.slice(at));
}

/**
 * @param {string} words
 * @param {{ className?: string }} [options]
 */
export function prose(words, { className = '' } = {}) {
  const paragraphs = words.trim().split(/\n\s*\n/u).map(paragraph => `<p>${linked(paragraph)}</p>`);
  return `<div class="ck-prose${className ? ` ${className}` : ''}">${paragraphs.join('')}</div>`;
}

/**
 * @param {string} label
 * @param {{ person?: boolean, photo?: string, icon?: string, attrs: Attributes }} options
 */
export function linkChip(label, { person = false, photo = '', icon: meaning = '', attrs }) {
  const lead = person ? personFace({ name: label, photo, size: 'xs' }) : icon(meaning, { size: 'xs' });
  return `<button class="ck-chip ck-chip--lead${person ? ' is-person' : ''} mac-subhead"${attributes({ type: 'button', ...attrs })}>`
    + `${lead}<span class="ck-chip__label">${esc(label)}</span></button>`;
}
