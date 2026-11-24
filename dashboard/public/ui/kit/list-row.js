// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { icon } from './icon.js';
import { personFace } from './person-face.js';
import { picture } from './picture.js';
import { bar, counting, iconSquare } from './skeleton.js';

/**
 * @param {object} row
 * @param {string} row.title
 * @param {import('../../lib/html.js').Attributes} row.attrs
 * @param {string | null} [row.meta]
 * @param {string} [row.here]
 * @param {string | { mark: string }} [row.lead]
 * @param {number | null} [row.count]
 * @param {string} [row.value]
 * @param {boolean} [row.chevron]
 * @param {boolean} [row.short]
 * @param {boolean} [row.quiet]
 * @param {string} [row.label]
 */
export function listRow({ title, attrs, meta = '', here = '', lead = '', count, value = '', chevron = false, short = false,
  quiet = false, label = '' }) {
  const hidden = label ? ' aria-hidden="true"' : '';
  const titled = `<span class="ck-lrow__title ${short ? 'mac-body' : 'mac-headline'}">`
    + `<span class="ck-lrow__words">${esc(title)}</span>`
    + (count === undefined ? '' : `<span class="ck-lrow__count mac-mono-data">${count === null ? bar(1)
      : count.toLocaleString('en-US')}</span>`) + '</span>';
  return `<button${attributes({ type: 'button', class: `ck-lrow${short ? ' ck-lrow--short' : ''}${quiet ? ' ck-lrow--quiet' : ''}`,
    ...attrs, 'aria-label': label || null })}>`
    + (lead ? `<span class="ck-lrow__lead" aria-hidden="true">${typeof lead === 'string' ? icon(lead, { size: 'sm' }) : lead.mark}</span>` : '')
    + `<span class="ck-lrow__main"${hidden}>${titled}${short ? ''
      : meta === null ? `<span class="ck-lrow__meta">${counting(bar(5), 'span')}</span>`
        : meta ? `<span class="ck-lrow__meta mac-mono-data">${marked(meta, here)}</span>` : ''}</span>`
    + (value ? `<span class="ck-lrow__end mac-mono-data"${hidden}>${marked(value, here)}</span>` : '')
    + (chevron ? `<span class="ck-lrow__chev" aria-hidden="true">${icon('forward', { size: 'xs' })}</span>` : '')
    + '</button>';
}

/**
 * @param {string} words
 * @param {string} phrase
 */
const marked = (words, phrase) => {
  const at = phrase ? words.indexOf(phrase) : -1;
  return at < 0 ? esc(words)
    : `${esc(words.slice(0, at))}<span class="ck-lrow__here">${esc(phrase)}</span>${esc(words.slice(at + phrase.length))}`;
};

/**
 * @param {import('./skeleton.js').BarWidth} title
 * @param {import('./skeleton.js').BarWidth} meta
 */
export const listRowReading = (title, meta) => '<div class="ck-lrow ck-lrow--reading" aria-hidden="true"><span class="ck-lrow__main">'
  + `<span class="ck-lrow__title mac-headline">${bar(title)}</span><span class="ck-lrow__meta mac-mono-data">${bar(meta)}</span>`
  + '</span></div>';

/** @param {string} rows */
export const listRows = rows => `<div class="ck-lrows">${rows}</div>`;

/** @param {string} words */
export function matched(words) {
  let html = '';
  let open = false;
  for (const part of words.split(/([«»])/u)) {
    if (part === '«') {
      if (!open) html += '<mark>';
      open = true;
    } else if (part === '»') {
      if (open) html += '</mark>';
      open = false;
    } else html += esc(part);
  }
  return open ? `${html}</mark>` : html;
}

export const thingLead = {
  /** @param {string} meaning */
  square: meaning => `<span class="ck-trow__tile">${icon(meaning, { size: 'sm' })}</span>`,
  /** @param {string} meaning */
  art: meaning => `<span class="ck-trow__tile ck-trow__tile--art">${icon(meaning, { size: 'sm' })}</span>`,
  /** @param {string | null} name @param {string | null} [photo] */
  face: (name, photo = null) => personFace({ name, photo: photo ?? '', size: 'md' }),
  /** @param {string} hash */
  picture: hash => picture({ hash, size: 'tile', alt: '' }, { className: 'ck-trow__picture' }),
};

/**
 * @param {object} row
 * @param {string} row.lead
 * @param {string} row.title
 * @param {import('../../lib/html.js').Attributes} row.attrs
 * @param {string} [row.when]
 * @param {string} [row.line]
 * @param {boolean} [row.selected]
 */
export function thingRow({ lead, title, attrs, when = '', line = '', selected = false }) {
  return `<button${attributes({ type: 'button', class: `ck-trow${selected ? ' is-selected' : ''}`, ...attrs })}>`
    + `<span class="ck-trow__lead" aria-hidden="true">${lead}</span><span class="ck-trow__main" aria-hidden="true">`
    + `<span class="ck-trow__top"><span class="ck-trow__title mac-headline">${esc(title)}</span>`
    + (when ? `<span class="ck-trow__when mac-subhead">${esc(when)}</span>` : '') + '</span>'
    + (line ? `<span class="ck-trow__line mac-body">${matched(line)}</span>` : '') + '</span></button>';
}

/** @param {number} index */
export const thingRowReading = index => '<div class="ck-trow ck-trow--reading" aria-hidden="true">'
  + `<span class="ck-trow__lead">${iconSquare()}</span><span class="ck-trow__main"><span class="ck-trow__top">`
  + `<span class="ck-trow__title mac-headline">${bar([5, 4, 6], index)}</span></span>`
  + `<span class="ck-trow__line mac-body">${bar([8, 7, 6], index)}</span></span></div>`;
