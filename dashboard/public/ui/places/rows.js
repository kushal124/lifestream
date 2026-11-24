// @ts-check
/** @import { PlaceVisit } from '../../pages.js' */
import { attributes, esc } from '../../lib/html.js';
import { spanWords } from '../../lib/places.js';
import { dayAt } from '../../lib/home-clock.js';
import { clock, rowDay } from '../../lib/words.js';
import { bar, faceStack, icon } from '../kit/index.js';

/** @typedef {{ now: number }} Clock */

/**
 * @param {PlaceVisit} visit
 * @param {Clock} at
 * @param {boolean} open
 */
export function visitWords(visit, at, open) {
  const today = dayAt(at.now).day;
  const date = rowDay(visit.day, today);
  const span = open ? `since ${clock(visit.start_ms)}` : `${clock(visit.start_ms)}–${clock(visit.end_ms)}`;
  const held = spanWords((open ? at.now : visit.end_ms) - visit.start_ms);
  return { date, span, held, length: open ? `${held} so far` : held };
}

const chevron = () => `<span class="pl-chev">${icon('forward', { size: 'xs' })}</span>`;

/**
 * @param {string} rows
 * @param {boolean} faces
 */
export const visitRows = (rows, faces) => `<div class="pl-visits${faces ? ' pl-visits--faces' : ''}">${rows}</div>`;

/**
 * @param {PlaceVisit} visit
 * @param {{ at: Clock, open: boolean, people: { name: string, photo: string }[], faces: boolean }} row
 */
export function visitRow(visit, { at, open, people, faces }) {
  const { date, span, held, length } = visitWords(visit, at, open);
  const names = people.map(person => person.name);
  return `<button${attributes({ type: 'button', class: 'pl-visit', 'data-pl-visit': visit.key,
    'aria-label': [date, span, length, names.length ? `with ${names.join(', ')}` : ''].filter(Boolean).join(', ') })}>`
    + `<span class="pl-visit__when" aria-hidden="true"><span class="pl-visit__date mac-headline">${esc(date)}`
    + `${open ? '<span class="pp-here"></span>' : ''}</span><span class="pl-visit__span mac-mono-data">${esc(span)}</span></span>`
    + `<span class="pl-visit__length mac-mono-data" aria-hidden="true">${esc(held)}</span>`
    + (faces ? `<span class="pl-visit__faces">${faceStack(people)}</span>` : '')
    + `${chevron()}</button>`;
}

const DATES = /** @type {const} */ ([4, 5, 4, 3]);
const SPANS = /** @type {const} */ ([6, 6, 5, 6]);

/** @param {number} index */
export const visitRowReading = index => '<div class="pl-visit" aria-hidden="true"><span class="pl-visit__when">'
  + `<span class="pl-visit__date mac-headline">${bar(DATES, index)}</span>`
  + `<span class="pl-visit__span mac-mono-data">${bar(SPANS, index)}</span></span>`
  + `<span class="pl-visit__length mac-mono-data">${bar(3)}</span></div>`;
