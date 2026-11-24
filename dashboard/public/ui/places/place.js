// @ts-check
/** @import { Place, PlaceRow, PlaceVisit, When } from '../../pages.js' */
/** @import { Shown } from './list.js' */
import { CIRCLES_MAX } from '../../lib/circle.js';
import { attributes, esc } from '../../lib/html.js';
import { shortDay, sinceWords, whenWords } from '../../lib/words.js';
import {
  ARRIVES, addCircleRow, bar, button, circleRow, counting, inPlaceLine, fieldRow, icon, iconButton, personChip, personChips,
  listRow, listRows, noneLine, photoGrid, photoGridReading, questionCard, sectionLabel, sectionLabelReading, waitLine,
} from '../kit/index.js';
import { placeRow } from './list.js';
import { visitRow, visitRowReading, visitRows } from './rows.js';

/** @typedef {{ text: string, error: boolean }} EditNote */

export const VISITS_SHOWN = 6;
const PHOTOS_ROW = 4;

/** @param {EditNote | null} note */
export function editNote(note) {
  if (!note) return '';
  if (note.error) return `<div class="pl-note">${inPlaceLine(note.text)}</div>`;
  return `<p class="pl-note mac-footnote" role="status">${esc(note.text)}</p>`;
}

/**
 * @param {string} label
 * @param {string} inner
 * @param {{ count?: number, action?: string }} [options]
 */
const part = (label, inner, { count, action = '' } = {}) => `<section class="pl-part ${ARRIVES}">`
  + `${sectionLabel(label, { count, action })}${inner}</section>`;

/**
 * @param {When} since
 * @param {string} today
 */
const sinceLine = (since, today) => since.kind === 'day' ? shortDay(since.day, today.slice(0, 4)) : `since ${sinceWords(since)}`;

/**
 * @param {Place} one
 * @param {string} today
 */
export function placeLine(one, today) {
  const words = [one.head.line ?? '', one.head.since ? sinceLine(one.head.since, today) : ''].filter(Boolean).map(esc);
  if (one.here) words.push('<span class="pp-here" aria-hidden="true"></span>Here now');
  if (one.part_of) {
    words.push(`Part of <button${attributes({ type: 'button', class: 'pl-link', 'data-pl-open': one.part_of.slug })}>`
      + `${esc(one.part_of.name)}</button>`);
  }
  return words.join(' · ');
}

/**
 * @param {object} head
 * @param {string} head.back
 * @param {string | null} head.name
 * @param {Place | null} head.one
 * @param {string} head.today
 */
export const placeTop = ({ back, name, one, today }) => '<div class="pl-card__top">'
  + '<div class="pl-card__nav">'
  + `<button type="button" class="pl-card__back ck-back mac-body" data-pl-back>${icon('back', { size: 'sm' })}<span>${esc(back)}</span></button>`
  + (name ? button('Edit', { attrs: { 'data-pl-edit': '' } }) : '') + '</div>'
  + '<div class="pl-card__titles">'
  + (name ? `<h1 class="pl-card__title mac-display">${esc(name)}</h1>`
    + (one ? `<p class="pl-card__line mac-body">${placeLine(one, today)}</p>`
      + one.clashes.map(clash => '<p class="pl-head__clash mac-footnote">Shares '
        + `<span class="mac-mono-data">${esc(clash.id)}</span> with ${esc(clash.names.join(', '))}</p>`).join('')
      : `<p class="pl-card__line mac-body" aria-hidden="true">${bar(7)}</p>`)
    : `<h1 class="pl-card__title mac-display" aria-hidden="true">${bar(6)}</h1>`
      + `<p class="pl-card__line mac-body" aria-hidden="true">${bar(7)}</p>`)
  + '</div></div>';

/**
 * @param {Place['ask_home'] & {}} ask
 * @param {string} today
 */
export const askLine = (ask, today) => `${ask.line}, since ${whenWords(ask.since, today)}.`;

/**
 * @param {Place['ask_home'] & {}} ask
 * @param {string} today
 */
const askHome = (ask, today) => questionCard({ title: 'Is this home?', line: askLine(ask, today),
  yes: 'Yes, it’s home', answer: yes => ({ 'data-pl-home': String(yes) }), className: `pl-ask ${ARRIVES}` });

/** @param {Place} one */
function photos(one) {
  const { first, total, line } = one.photos;
  if (!total) return '';
  const grid = photoGrid({ label: `Photos at ${one.head.name}`, photos: first.map((hash, index) => ({
    hash, label: `Photo ${index + 1} of ${total.toLocaleString('en-US')}`, attrs: { 'data-pl-photo': index } })) });
  const all = total > first.length && line ? button(`View all ${line}`, {
    variant: 'plain', attrs: { 'data-pl-photo': 0 }, className: 'pl-photos-all',
  }) : '';
  return part('Photos', grid, { action: all });
}

/** @param {Place} one */
const people = one => one.people.length ? part('People here', personChips(one.people.map(person => personChip({
  name: person.name, photo: person.photo ?? '', figure: person.line ?? '', attrs: { 'data-pl-person': person.id },
})))) : '';

/**
 * @param {Place} one
 * @param {boolean} all
 * @param {number} now
 */
function visits(one, all, now) {
  const { count, rows } = one.visits;
  if (!rows.length) return part('Visits', noneLine('No visit here yet.'));
  const known = new Map(one.people.map(person => [person.id, { name: person.name, photo: person.photo ?? '' }]));
  const shown = all ? rows : rows.slice(0, VISITS_SHOWN);
  const peopleOf = (/** @type {PlaceVisit} */ visit) => visit.people.flatMap(id => known.get(id) ?? []);
  const faces = shown.some(visit => peopleOf(visit).length > 0);
  const drawn = shown.map((visit, index) => visitRow(visit, { at: { now }, open: index === 0 && one.here, people: peopleOf(visit),
    faces })).join('');
  const more = rows.length > shown.length
    ? button(`Show all ${count.toLocaleString('en-US')}`, { attrs: { 'data-pl-visits': '' } }) : '';
  return count === 1 ? part('Visit', visitRows(drawn, faces))
    : part('Visits', `${visitRows(drawn, faces)}${more}`, { count });
}

/**
 * @param {Place} one
 * @param {(slug: string) => PlaceRow | null} rowOf
 * @param {Shown} shown
 */
function inside(one, rowOf, shown) {
  const rows = one.inside.map(({ slug, name }) => {
    const row = rowOf(slug);
    return row ? placeRow(row, shown) : listRow({ attrs: { 'data-pl-open': slug }, title: name, label: name });
  });
  return rows.length ? part('Inside', listRows(rows.join(''))) : '';
}

/** @param {string} sentence */
const rhythm = sentence => `<p class="pl-rhythm ${ARRIVES}">${sentence.split(' · ').map((clause, index) => index
  ? `<span class="pl-rhythm__sep"> · </span><span class="pl-rhythm__clause">${esc(clause)}</span>`
  : `<span class="pl-rhythm__clause">${esc(clause)}</span>`).join('')}</p>`;

/**
 * @param {object} page
 * @param {Place} page.one
 * @param {boolean} page.allVisits
 * @param {(slug: string) => PlaceRow | null} page.rowOf
 * @param {Shown} page.shown
 * @param {number} page.now
 */
export const placeBody = ({ one, allVisits, rowOf, shown, now }) => '<div class="pl-page">'
  + (one.counting ? counting(countedReading())
    : (one.rhythm ? rhythm(one.rhythm) : '') + (one.ask_home ? askHome(one.ask_home, shown.today) : '') + photos(one) + people(one)
      + visits(one, allVisits, now))
  + inside(one, rowOf, shown)
  + '</div>';

const countedReading = () => '<p class="pl-rhythm">'
  + `<span class="pl-rhythm__clause">${bar(7)}</span><span class="pl-rhythm__clause">${bar(8)}</span></p>`
  + `<section class="pl-part">${sectionLabelReading(3)}${photoGridReading(PHOTOS_ROW)}</section>`
  + `<section class="pl-part">${sectionLabelReading(3)}`
  + visitRows(Array.from({ length: 4 }, (_, index) => visitRowReading(index)).join(''), false) + '</section>';

export const placeBodyReading = () => `<div class="pl-page" aria-hidden="true">${countedReading()}${waitLine()}</div>`;

export const editTop = () => '<div class="pl-card__top pl-naming__top"><div class="pl-naming__head">'
  + '<h1 class="pl-naming__title mac-title-1">Edit place</h1>'
  + iconButton('close', 'Cancel', { attrs: { 'data-pl-close': '' }, className: 'pl-naming__close' }) + '</div></div>';

/**
 * @param {object} edit
 * @param {string} edit.name
 * @param {EditNote | null} edit.note
 * @param {{ metres: number, line: string }[]} edit.circles
 * @param {number} [edit.lit]
 */
export function editBody({ name, note, circles, lit = 0 }) {
  const many = circles.length > 1;
  const rows = circles.map(({ metres, line }, at) => circleRow({ at, of: circles.length, metres, line, lit: at === lit,
    attrs: { 'data-pl-circle': String(at) },
    reach: way => ({ 'data-pl-reach': String(way) }), remove: many ? { 'data-pl-uncircle': String(at) } : null }));
  return '<form class="pl-edit" id="pl-edit" data-pl-form="edit">'
    + `<div class="pl-edit__name">${fieldRow({ label: 'Name', placeholder: 'What you call it', value: name, input: { name: 'name', required: true } })}`
    + `${editNote(note)}</div>`
    + `<section class="pl-edit__circles">${sectionLabel(many ? 'Circles' : 'Circle', { count: many ? circles.length : undefined })}`
    + `<div class="pl-edit__rows">${rows.join('')}`
    + `${addCircleRow({ disabled: circles.length >= CIRCLES_MAX, attrs: { 'data-pl-add-circle': '' } })}</div>`
    + '</section></form>';
}

/** @param {boolean} removing */
export const editFoot = removing => '<footer class="pp-foot pl-edit__foot"><div class="pp-foot__acts">' + (removing
  ? button('Not now', { variant: 'plain', attrs: { 'data-pl-keep': '' } })
    + button('Remove for good', { variant: 'primary', tone: 'warning', attrs: { 'data-pl-remove': '' }, className: 'pp-foot__end' })
  : button('Cancel', { variant: 'plain', key: 'Esc', attrs: { 'data-pl-close': '' } })
    + button('Remove this place', { variant: 'plain', tone: 'warning', attrs: { 'data-pl-remove': '' }, className: 'pp-foot__end' })
    + button('Save', { variant: 'primary', key: '⌘S', attrs: { type: 'submit', form: 'pl-edit' } }))
  + '</div></footer>';
