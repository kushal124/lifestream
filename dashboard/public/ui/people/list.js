// @ts-check
/** @import { Person } from './words.js' */
/** @import { ChatRow, People, Row } from '../../pages.js' */
import { attributes, esc } from '../../lib/html.js';
import {
  ARRIVES, button, cardGrid, connectorRow, connectorRowReading, icon, iconButton, pageHead, personFace, searchField,
  sectionLabel, sectionLabelReading, views, waitLine, youCard,
} from '../kit/index.js';
import { count, counted, found, sectionWhen, whenWords } from '../../lib/words.js';
import { isNamed } from './words.js';

const MOST = 'Most in touch';

export const ROWS_SHOWN = 120;

/** @typedef {'' | 'ai' | 'groups'} Seg */

/** @param {Pick<Person, 'photo'>} person */
export const photoOf = person => !person.photo ? '' : 'crop' in person.photo ? person.photo.crop : person.photo.card;

/**
 * @param {Person} person
 * @param {import('../kit/person-face.js').FaceSize} [size]
 */
export const faceOf = (person, size = 'md') => personFace({ name: isNamed(person) ? person.name : null, photo: photoOf(person), size });

/**
 * @param {Pick<Row, 'name' | 'named' | 'photo'>} row
 * @param {import('../kit/person-face.js').FaceSize} [size]
 */
export const rowFace = (row, size = 'md') => personFace({ name: row.named ? row.name : null, photo: row.photo ?? '', size });

/**
 * @param {Pick<Row, 'when' | 'line'>} row
 * @param {string} today
 * @param {boolean} [grouped]
 */
export const rowLine = (row, today, grouped = false) => row.line ?? (row.when ? whenWords(row.when, today, { grouped }) : '');

/**
 * @param {string} typed
 * @param {boolean} hosted
 * @param {boolean} faces
 */
export const listBar = (typed, hosted, faces) => pageHead({ title: 'People', tools: [
  `<span class="pp-faces-tool" data-people-faces>${facesTool(faces)}</span>`,
  searchField({ placeholder: 'Search people', value: typed, shortcut: hosted ? '⌘F' : '/', outlined: true,
    attrs: { 'data-people-find': '' } }),
] });

/** @param {boolean} faces */
export const facesTool = faces => faces ? iconButton('settings', 'Faces settings', { attrs: { 'data-people-connect': 'faces' } }) : '';

/**
 * @param {string} name
 * @param {string} [tools]
 * @param {{ label: string, id: string }} [back]
 */
export const pageBar = (name, tools = '', back = { label: 'People', id: '' }) => pageHead({
  back: { label: back.label, attrs: { 'data-person': back.id } }, name, tools: tools ? [tools] : [] });

/**
 * @param {Row} row
 * @param {string} today
 * @param {boolean} [grouped]
 */
export const personRow = (row, today, grouped = false) => connectorRow({
  name: row.name, face: rowFace(row, 'row'), places: [], state: 'ok', line: rowLine(row, today, grouped),
  attrs: { 'data-person': row.id },
});

/**
 * @param {ChatRow} chat
 * @param {string} today
 */
export const groupRow = (chat, today) => connectorRow({
  name: chat.title, icon: 'meeting', places: [], state: 'ok', line: rowLine(chat, today),
  attrs: { 'data-person': `chat:${chat.chat}` },
});

/**
 * @param {People['groups']} groups
 * @param {{ shown: number, today: string, open: boolean }} view
 */
export function groupsView({ yours, quiet, quiet_line: quietLine }, { shown, today, open }) {
  const own = yours.length ? flatRows('Your groups', yours, shown, chat => groupRow(chat, today)) : '';
  if (!quiet.length) return own;
  if (open) return own + flatRows('Quiet', quiet, shown, chat => groupRow(chat, today));
  const fold = connectorRow({ name: 'Quiet', icon: 'hidden', places: [], state: 'ok',
    line: quietLine ?? '', attrs: { 'data-people-quiet': '', 'aria-expanded': 'false' } });
  return own + `<section class="pp-group pp-fold ${ARRIVES}">${cardGrid([fold], { label: 'Quiet' })}</section>`;
}

/**
 * @param {string} label
 * @param {string} inner
 * @param {string} [className]
 */
const group = (label, inner, className = '') => `<section class="pp-group${className ? ` ${className}` : ''} ${ARRIVES}">${sectionLabel(label)}${inner}</section>`;

/**
 * @param {Row} row
 * @param {string} line
 */
const personTile = (row, line) => `<button${attributes({ type: 'button', class: 'pp-tile', 'aria-label': `${row.name}, ${line}`,
  'data-person': row.id })}><span class="pp-tile__face" aria-hidden="true">${rowFace(row, 'tile')}</span>`
  + `<span class="pp-tile__name mac-headline" aria-hidden="true">${esc(row.name)}</span>`
  + `<span class="pp-tile__line mac-subhead" aria-hidden="true">${esc(line)}</span></button>`;

/** @param {number} left */
const more = left => button(`Show ${count(left)} more`, { variant: 'plain', className: 'pp-more', attrs: { 'data-people-more': '' } });

/** @param {{ row: Row, line: string }[]} most */
export const mostRows = most => most.length ? group(MOST, cardGrid(most.map(({ row, line }) => personTile(row, line)),
  { label: MOST }), 'pp-group--most') : '';

/**
 * @param {People['sections']} sections
 * @param {number} shown
 * @param {string} today
 */
export function sectionRows(sections, shown, today) {
  let left = shown;
  let total = 0;
  const drawn = sections.map(({ key, title, rows }) => {
    total += rows.length;
    const taken = rows.slice(0, Math.max(0, left));
    left -= taken.length;
    if (!taken.length) return '';
    const heading = title ?? sectionWhen(key, today) ?? '';
    return group(heading, cardGrid(taken.map(row => personRow(row, today, true)), { label: heading }));
  });
  return drawn.join('') + (total > shown ? more(total - shown) : '');
}

/**
 * @template {{ find: string[] }} T
 * @param {T[]} items
 * @param {string} typed
 * @returns {T[]}
 */
export function findIn(items, typed) {
  return items.filter(item => found(item.find, typed));
}

/**
 * @template T
 * @param {string} label
 * @param {T[]} items
 * @param {number} shown
 * @param {(item: T) => string} row
 */
export const flatRows = (label, items, shown, row) => group(label, cardGrid(items.slice(0, shown).map(row), { label }))
  + (items.length > shown ? more(items.length - shown) : '');

/**
 * @param {Seg} seg
 * @param {{ people: number, ai: number, groups: number } | null} counts
 */
export function listViews(seg, counts) {
  const options = [{ id: '', label: 'People', count: counts?.people ?? null, attrs: { 'data-people-seg': '' } }];
  if (counts?.ai || seg === 'ai') options.push({ id: 'ai', label: 'AI', count: counts?.ai ?? null, attrs: { 'data-people-seg': 'ai' } });
  options.push({ id: 'groups', label: 'Groups', count: counts?.groups ?? null, attrs: { 'data-people-seg': 'groups' } });
  return views({ label: 'People', value: seg, options });
}

const READING_ROWS = 6;

/**
 * @param {Seg} seg
 * @param {string} [failed]
 */
export const listReading = (seg, failed = '') => '<div class="ck-page__body"><div class="ck-page__main pp-main pp-cards">'
  + listViews(seg, null) + (failed || '<section class="pp-group" aria-hidden="true">' + sectionLabelReading(4)
    + cardGrid(Array.from({ length: READING_ROWS }, (_, at) => connectorRowReading(at, 'face')), { label: 'People' })
    + `</section>${waitLine()}`)
  + '</div><aside class="ck-page__side ck-page__side--top pp-side" aria-label="You and what is left to tidy"'
  + ` data-read="${failed ? 'failed' : 'reading'}"></aside></div>`;

/**
 * @param {string} lead
 * @param {string} name
 * @param {string} line
 * @param {Record<string, string>} attrs
 */
const tidyRow = (lead, name, line, attrs) => `<button${attributes({
  type: 'button', class: 'ck-side__row', 'aria-label': `${name}, ${line}`, ...attrs,
})}><span class="ck-side__icon" aria-hidden="true">${lead}</span>`
  + '<span class="ck-side__main" aria-hidden="true">'
  + `<span class="ck-side__name mac-headline">${esc(name)}</span>`
  + `<span class="ck-side__line mac-subhead"><span>${esc(line)}</span></span></span></button>`;

/**
 * @typedef {object} Tidy
 * @property {string | null} organise
 * @property {{ names: number, people: number } | null} faces
 * @property {string} [facesLine]
 * @property {string | null} businesses
 * @property {boolean} askFaces
 * @property {{ row: Row, line: string }[]} fresh
 */

/** @param {Tidy} tidy */
export function tidyCard({ organise, businesses, faces, facesLine, askFaces, fresh }) {
  /** @type {string[]} */
  const rows = [];
  if (organise !== null) rows.push(tidyRow(icon('people'), 'Organise your people', organise, { 'data-person': 'organise' }));
  if (businesses !== null) rows.push(tidyRow(icon('work-mac'), 'Businesses', businesses, { 'data-people-businesses': '' }));
  if (faces) {
    const line = [faces.names ? `${count(faces.names)} to name` : '', faces.people ? `${counted(faces.people, 'person', 'people')} to check` : '']
      .filter(Boolean).join(' · ');
    rows.push(tidyRow(icon('faces'), 'Faces', line, { 'data-person': 'faces' }));
  } else if (facesLine) rows.push(tidyRow(icon('faces'), 'Faces', facesLine, { 'data-person': 'faces' }));
  if (askFaces) rows.push(tidyRow(icon('faces'), 'Turn on faces', 'Find the people in your photos', { 'data-people-connect': 'faces' }));
  for (const { row, line } of fresh) rows.push(tidyRow(rowFace(row, 'sm'), row.name, line, { 'data-people-organise': row.id }));
  return rows.length ? `<div class="ck-sidebox ${ARRIVES}"><div class="ck-side__rows">${rows.join('')}</div></div>` : '';
}

/** @param {Row | null} you */
export const youCardOf = you => you ? youCard({ name: you.name, photo: you.photo ?? '', line: you.line ?? '',
  attrs: { 'data-person': you.id }, className: ARRIVES }) : '';
