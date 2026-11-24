// @ts-check
import { esc } from './lib/html.js';
import {
  addCircleRow, circleRow, faceStack, nameCredit, nameField, nameRow, nameRowReading,
  personChip, personChips, photoGrid, photoGridReading, questionCard, reachStepper, sectionLabel,
} from './ui/kit/index.js';
import { fromGoogle, litFor, rowsOf } from './lib/place-naming.js';
import { editBody, editFoot, editTop, placeBody, placeBodyReading, placeTop } from './ui/places/place.js';
import {
  finishBody, finishFoot, hiddenPage, hiddenTop, nameRows, namePlaceholder, namingBody, namingFoot, namingReach, namingTop,
} from './ui/places/naming.js';

/** @typedef {import('./pages.js').Place} Place */
/** @typedef {import('./pages.js').When} When */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const PICTURES = Array.from({ length: 8 }, (_, at) => `face-${at}`);
const SCENES = [1, 2, 7, 3, 5, 6, 4].map(seed => `scene-${seed}`);
const NOW = Date.parse('2026-10-15T19:30:00Z');
const TODAY = '2026-10-15';
const AT = { now: NOW };

/**
 * @param {string} label
 * @param {string} html
 * @param {string} [className]
 */
const specimen = (label, html, className = '') => `<div class="gallery__specimen${className ? ` ${className}` : ''}">`
  + `<p class="gallery__label mac-mono-label">${esc(label)}</p>${html}</div>`;
/** @param {string} name @param {string} body */
const group = (name, body) => `<section class="gallery__group">${sectionLabel(name)}${body}</section>`;

const ASK = 'You’ve slept here 3 nights, since Monday.';

const PEOPLE = [{ id: 'sam', name: 'Sam Rivera', days: 31 }, { id: 'mira', name: 'Mira Sen', days: 12 },
  { id: 'dana', name: 'Dana Okafor', days: 4 }];

/**
 * @param {string} name
 * @param {object} read
 * @param {[number, number, number, string[]][]} read.visits
 * @param {number} read.photos
 * @param {When | null} read.since
 * @param {string | null} [read.rhythm]
 * @param {boolean} [read.ask]
 * @param {boolean} [read.here]
 * @returns {Place}
 */
const one = (name, { visits, photos, since, rhythm = null, ask = false, here = false }) => ({
  position: '1:0', today: TODAY, head: { name, line: 'Bayview', since }, here, rhythm, stays: visits.length,
  visits: { count: visits.length, rows: visits.map(([ago, hour, hours, people]) => {
    const start_ms = Date.parse('2026-10-15T00:00:00Z') - ago * DAY_MS + hour * HOUR_MS;
    const end_ms = start_ms + hours * HOUR_MS;
    return { key: `stay/${ago}@${start_ms}-${end_ms}`, unit: `stay/${ago}`, start_ms, end_ms, day: new Date(start_ms).toISOString().slice(0, 10), focus: `u:stay/${ago}@${start_ms}-${end_ms}`, people };
  }) },
  people: PEOPLE.filter(person => visits.some(visit => visit[3].includes(person.id)))
    .map(person => ({ id: person.id, name: person.name, photo: null, line: visits.length > 1 ? `${person.days} days` : null })),
  photos: { first: Array.from({ length: Math.min(4, photos) }, (_, at) => `sha256:${`${at}`.padStart(64, '0')}`), total: photos,
    line: photos ? `${photos} photos` : null },
  part_of: null, inside: [], clashes: [], counting: false,
  ask_home: ask ? { line: 'You’ve slept here 3 nights', since: { kind: 'day', day: '2026-10-12' } } : null,
});

/**
 * @param {string} name
 * @param {Place | null} read
 */
const card = (name, read) => '<div class="gallery__place"><section class="pl-card ck-float" aria-label="Places">'
  + `<div class="pl-card__head">${placeTop({ back: 'Places', name, one: read, today: TODAY })}</div>`
  + '<div class="pl-card__scroll">' + (read ? placeBody({ one: read, allVisits: false, rowOf: () => null,
    shown: { today: TODAY, here: null, counting: false }, now: NOW }) : placeBodyReading())
  + '</div></section></div>';

/**
 * @param {string} name
 * @param {{ metres: number, line: string }[]} circles
 * @param {{ removing?: boolean, note?: import('./ui/places/place.js').EditNote | null, lit?: number }} [state]
 */
const editCard = (name, circles, { removing = false, note = null, lit = 0 } = {}) => '<div class="gallery__place">'
  + '<section class="pl-card ck-float" aria-label="Places">'
  + `<div class="pl-card__head">${editTop()}</div>`
  + `<div class="pl-card__scroll">${editBody({ name, note, circles, lit })}</div>`
  + `<div class="pl-card__foot">${editFoot(removing)}</div></section></div>`;

const BLOCK = [{ metres: 55, line: 'Takes in 79 stays' }, { metres: 30, line: 'Takes in 79 stays' },
  { metres: 80, line: 'Takes in 79 stays' }];

const CLIMBING = 'Northside Climbing';
const NOODLES = 'Lantern Noodle Bar';
const MIRAS = 'Mira’s';
const LONG = 'Harbourside Community Climbing and Bouldering Centre';

const PAGES = () => '<div class="gallery__places">'
  + specimen('Visited often: its rhythm, photos, people by days, the newest visits with their faces', card(CLIMBING,
    one(CLIMBING, { rhythm: '85 days here since Mar 2025 · usually Tue and Thu evenings', photos: 36, since: null, here: true, visits: [
      [0, 18, 1.6, []], [2, 18.2, 1.9, ['sam']], [4, 10.5, 2.3, ['sam', 'mira']], [6, 18.3, 1.6, []],
      [8, 18, 2.2, ['sam']], [11, 9.8, 2.7, ['sam', 'mira', 'dana']], [13, 18.2, 1.6, []], [15, 18.1, 1.9, ['sam']],
      [18, 18, 2, []] ] })))
  + specimen('Is this home? asked under the line', card(MIRAS,
    one(MIRAS, { ask: true, photos: 2, since: { kind: 'month', month: '2026-10' }, visits: [[0, 23.2, 8.3, ['mira']], [1, 22.7, 8.6, ['mira']], [2, 23.7, 7.6, ['mira']]] })))
  + specimen('Visited once: no rhythm, its day in the line, one Visit', card(NOODLES,
    one(NOODLES, { photos: 5, since: { kind: 'day', day: '2026-08-22' }, visits: [[54, 12.3, 0.95, ['mira']]] })))
  + specimen('A long name: it wraps under the way back, the line under it', card(LONG,
    one(LONG, { rhythm: '6 days here since Sep · usually Saturday mornings', photos: 0, since: null, visits: [[3, 9, 2, []],
      [10, 9.5, 1.5, []], [17, 9, 2.5, []]] })))
  + specimen('Its own read under way: the head at once, the body’s shapes', card(CLIMBING, null), 'ck-reading')
  + specimen('Edit in the card, one circle: the name, its circle’s row, Add circle, Cancel, Remove this place and Save',
    editCard('Lantern Noodle Bar', [{ metres: 80, line: 'Takes in 1 stay' }]))
  + specimen('Edit, three circles: a row each in the place’s order, the second lit as its circle is, any removable',
    editCard('Harbour Block', BLOCK, { lit: 1 }))
  + specimen('Edit, a removal asked: Not now or Remove for good', editCard('Harbour Block', BLOCK, { removing: true }))
  + specimen('Edit, a save refused: the home’s words under the name, the circles as the person left them',
    editCard('Harbour Block', BLOCK.slice(1), { note: { text: 'Not saved. Lifestream is starting up. Try again in a moment.',
      error: true } }))
  + '</div>';

/** @param {string[]} pictures */
const photosOf = pictures => pictures.map((hash, at) => ({ hash, label: `Photo ${at + 1}`, attrs: {} }));

const PHOTO_GRID = () => group('PhotoGrid', '<div class="gallery__rows">' + [
  specimen('A row of four', photoGrid({ label: 'Photos', photos: photosOf(PICTURES.slice(0, 4)) })),
  specimen('Every one: rows of four', photoGrid({ label: 'Photos', photos: photosOf([...PICTURES, ...PICTURES.slice(0, 2)]) })),
  ...[1, 2, 3, 4, 5, 6].map(count => specimen(`Filled, a naming card’s: ${count === 1 ? 'one across the row'
    : count === 2 ? 'two sharing the row' : count === 3 ? 'three' : count === 4 ? 'four, two and two'
      : count === 5 ? 'five, three and two' : 'six, two rows of three'}`, `<div class="gallery__column">${photoGrid({
    fill: true, label: 'Photos', photos: photosOf(SCENES.slice(0, count)) })}</div>`)),
  specimen('A picture that cannot be drawn: the glyph', photoGrid({ label: 'Photos', photos: photosOf([PICTURES[2],
    'lost']) })),
  specimen('Not read yet', photoGridReading(), 'ck-reading'),
  specimen('Not read yet, filled', `<div class="gallery__column">${photoGridReading(3, true)}</div>`, 'ck-reading'),
].join('') + '</div>');

const PERSON_CHIP = () => group('PersonChip', '<div class="gallery__rows">' + [
  specimen('With what is counted of them, flowing and wrapping in a card’s column', `<div class="gallery__column">${personChips([
    personChip({ name: 'Sam Rivera', figure: '31 days', attrs: {} }),
    personChip({ name: 'Mira Sen', photo: PICTURES[1], figure: '12 days', attrs: {} }),
    personChip({ name: 'Dana Okafor', figure: '4 days', attrs: {} })])}</div>`),
  specimen('A place of one day: the name alone', personChips([personChip({ name: 'Mira Sen', attrs: {} })])),
  specimen('A long name, in a narrow column', `<div class="gallery__narrow">${personChips([personChip({
    name: 'Alexandra Montgomery-Okafor', figure: '128 days', attrs: {} })])}</div>`),
].join('') + '</div>');

const FACE_STACK = () => group('FaceStack', '<div class="gallery__rows">' + [
  specimen('One', faceStack([{ name: 'Sam Rivera' }])),
  specimen('Two, one a photo', faceStack([{ name: 'Sam Rivera' }, { name: 'Mira Sen', photo: PICTURES[1] }])),
  specimen('Three', faceStack([{ name: 'Sam Rivera' }, { name: 'Mira Sen' }, { name: 'Dana Okafor' }])),
  specimen('Five: two, and how many more', faceStack([{ name: 'Sam Rivera' }, { name: 'Mira Sen' }, { name: 'Dana Okafor' },
    { name: 'Lee Park' }, { name: 'Ana Cruz' }])),
].join('') + '</div>');

const QUESTION_CARD = () => group('QuestionCard', '<div class="gallery__rows">' + [
  specimen('Is this home?', `<div class="gallery__column">${questionCard({ title: 'Is this home?', line: ASK,
    yes: 'Yes, it’s home', answer: () => ({}) })}</div>`),
].join('') + '</div>');

const LAST = Date.parse('2026-10-10T12:20:00Z');
const SUGGESTIONS = [
  { name: 'Lantern Noodle Bar', distance_m: 40,
    why: { product: 'Calendar', family: 'calendar', at_ms: LAST + 600_000, tier: 3 } },
  { name: 'Bayview Ramen', id: 'google:gallery-ramen', distance_m: 60,
    why: { product: 'WhatsApp', family: 'messages', at_ms: LAST - 2_400_000, tier: 2 } },
  { name: 'Lantern Park', id: 'google:gallery-park', distance_m: 90 },
];
const TYPED = [SUGGESTIONS[0], { name: 'Lantern Studio', slug: 'lantern-studio', distance_m: 140 },
  SUGGESTIONS[2], { name: 'Lantern Steps Cafe', id: 'google:gallery-steps', distance_m: 300 },
  { name: 'Lantern Market', id: 'google:gallery-market', distance_m: null }];

/** @param {{ head: string, body: string, foot: string }} parts */
const naming = ({ head, body, foot }) => '<div class="gallery__place"><section class="pl-card ck-float" aria-label="Places">'
  + `<div class="pl-card__head">${head}</div>`
  + `<div class="pl-card__scroll">${body}</div><div class="pl-card__foot">${foot}</div></section></div>`;

/** @param {{ typed?: string, lit?: number, ask?: string | null, photos?: number, read?: boolean, refused?: string, names?: import('./lib/places.js').Suggestion[], witnessed?: string, last?: string }} card */
const namingCard = ({ typed = '', lit = litFor(typed), ask = null, photos = 5, read = true, refused = '',
  names = SUGGESTIONS, witnessed = 'You took 214 photos here on 16 days between 2019 and 2026.',
  last = 'Last time Sat 10 Oct 2026 from 13:40 to 15:05' }) => {
  const rows = rowsOf(names, typed);
  return namingBody({ key: 'spot:gallery', typed, placeholder: namePlaceholder(rows), ask, witnessed, last,
    photos: SCENES.slice(0, photos).map((hash, at) => ({ hash, label: `Photo ${at + 1}` })),
    reach: { metres: 80, line: 'Size of the circle on the map' },
    rows: read ? nameRows(rows, lit, { typed, last: LAST }) : null, credit: read && fromGoogle(rows), error: '',
    refused });
};

const NAMED = ['Lantern Noodle Bar', 'Ridge Bakery', 'Pier Six', ...Array.from({ length: 9 }, (_, at) => `Place ${at + 4}`)]
  .map((name, at) => ({ key: name, slug: name, name, latitude: 0, longitude: 0, city: 'Bayview', day: `2026-08-${10 + at}` }));

const NAMING = () => '<div class="gallery__places">'
  + specimen('A card of a sitting: 3 of 12, its photos, the field, the first name lit', naming({
    head: namingTop({ at: 3, of: 12 }), body: namingCard({ photos: 6 }), foot: namingFoot(true) }))
  + specimen('A spot’s own card, the home asking Is this home?', naming({ head: namingTop(null),
    body: namingCard({ ask: ASK, photos: 2, witnessed: 'You were here on 5 days in 2026. You took 9 photos here.' }), foot: namingFoot(false) }))
  + specimen('A name being typed: the field’s own, the home’s names for it under it, none lit, Google credited',
    naming({ head: namingTop({ at: 4, of: 12 }), body: namingCard({ typed: 'Lan', photos: 3, names: TYPED }),
      foot: namingFoot(true) }))
  + specimen('↓ after typing: a name lit, ⏎ takes it', naming({ head: namingTop({ at: 4, of: 12 }),
    body: namingCard({ typed: 'Lan', lit: 1, photos: 3, names: TYPED }), foot: namingFoot(true) }))
  + specimen('A save the home refused: the card back, with the home’s reason', naming({ head: namingTop({ at: 4, of: 12 }),
    body: namingCard({ photos: 1, refused: 'Lifestream is starting up. Try again in a moment.' }), foot: namingFoot(true) }))
  + specimen('No names from the home, no photos, no Google key: the field alone', naming({ head: namingTop({ at: 9, of: 12 }),
    body: namingCard({ photos: 0, names: [], witnessed: 'You were here on 3 days in Oct 2026.' }), foot: namingFoot(true, { words: 'Names from Google Places come once Lifestream holds a key',
      act: { do: 'set', label: 'Add key', connector: 'google-places', member: 'key' } }) }))
  + specimen('A spot of one day: its times in the line, no last time under it', naming({ head: namingTop({ at: 2, of: 12 }),
    body: namingCard({ photos: 1, witnessed: 'You were here on Sun 18 Oct 2026 from 14:10 to 15:30.', last: '',
      names: SUGGESTIONS.slice(0, 1) }), foot: namingFoot(true) }))
  + specimen('A long name, lit', naming({ head: namingTop({ at: 10, of: 12 }), body: namingCard({ photos: 4, names: [
    { name: 'Harbourside Community Climbing and Bouldering Centre', id: 'google:gallery-long', distance_m: 140 },
    ...SUGGESTIONS.slice(1)] }), foot: namingFoot(true) }))
  + specimen('Its suggestions read: the rows’ shapes', naming({ head: namingTop({ at: 5, of: 12 }),
    body: namingCard({ read: false, photos: 6 }), foot: namingFoot(true) }), 'ck-reading')
  + specimen('The finish', naming({ head: '', foot: finishFoot(), body: finishBody({
    words: { title: '12 places named', line: 'In 2 minutes · Bayview and Lakeshore' }, at: AT, named: NAMED }) }))
  + specimen('The finish of one', naming({ head: '', foot: finishFoot(), body: finishBody({
    words: { title: '1 place named', line: 'In under a minute · Bayview' }, at: AT, named: NAMED.slice(0, 1) }) }))
  + specimen('Hidden spots', naming({ head: hiddenTop(2), foot: '', body: hiddenPage({ all: false, at: AT,
    spots: [
      { key: 'h1', latitude: 0, longitude: 0, hidden: { kind: 'at', at_ms: NOW - 3 * DAY_MS }, line: '4 days · 210 m from Harbour Home' },
      { key: 'h2', latitude: 0, longitude: 0, hidden: { kind: 'at', at_ms: NOW - 21 * DAY_MS }, line: '1 day' }] }) }))
  + '</div>';

const NAME_FIELD = () => group('NameField', '<div class="gallery__rows">' + [
  specimen('Empty, holding the focus: its rows come under it', `<div class="gallery__column pl-name">${nameField({
    placeholder: 'Type a name' })}</div>`),
  specimen('A name typed: its act at the end, which ⏎ does too while no row is lit', `<div class="gallery__column pl-name">${
    nameField({ placeholder: 'Type a name', value: 'Kiln Coffee' })}</div>`),
  specimen('While its card reads', `<div class="gallery__column pl-name">${nameField({ placeholder: 'Type a name',
    waiting: true })}</div>`, 'ck-reading'),
].join('') + '</div>');

const NAME_ROW = () => group('NameRow', '<div class="gallery__rows">' + [
  specimen('Lit, ending in ⏎: the one ⏎ takes', `<div class="gallery__column ck-namerows">${nameRow({ lead: 'calendar-event',
    name: 'Lantern Noodle Bar', line: 'Calendar · 12:30', lit: true, attrs: {} })}</div>`),
  specimen('Not lit: a message, one of the person’s own places, Google’s near and Google’s with no distance',
    `<div class="gallery__column ck-namerows">${[
      nameRow({ lead: 'message', name: 'Bayview Ramen', line: 'WhatsApp · 11:40', lit: false, attrs: {} }),
      nameRow({ lead: 'place', name: 'Kiln Coffee', line: 'Your place · 400 m', lit: false, attrs: {} }),
      nameRow({ lead: 'place', name: 'Lantern Park', line: 'Google · 90 m', lit: false, attrs: {} }),
      nameRow({ lead: 'place', name: 'Lantern Market', line: 'Google', lit: false, attrs: {} })].join('')}</div>`),
  specimen('A long name, in a card’s column', `<div class="gallery__column ck-namerows">${nameRow({ lead: 'place',
    name: 'Harbourside Community Climbing and Bouldering Centre', line: 'Google · 140 m', lit: true, attrs: {} })}</div>`),
  specimen('Not read yet', `<div class="gallery__column ck-namerows">${[0, 1, 2].map(nameRowReading).join('')}</div>`,
    'ck-reading'),
  specimen('Google’s credit under the rows, while one of its names shows', `<div class="gallery__column pl-name">`
    + `<div class="ck-namerows">${nameRow({ lead: 'place', name: 'Lantern Park', line: 'Google · 90 m', attrs: {} })}</div>`
    + `${nameCredit('Google')}</div>`),
].join('') + '</div>');

const CIRCLE_EDITOR = () => group('CircleEditor', '<div class="gallery__rows gallery__rows--wide">' + [
  specimen('A naming card’s row under the line of what witnessed it: its stepper and the line, wrapping, never cut',
    `<div class="gallery__column">${namingReach({ metres: 2000,
      line: 'Takes in 2 spots · 6 stays · overlaps Hill Studio and 8 more' })}</div>`),
  specimen('At the ends: a side greyed', `<div class="gallery__steppers">${reachStepper({ metres: 20, attrs: () => ({}) })}`
    + `${reachStepper({ metres: 1050, attrs: () => ({}) })}${reachStepper({ metres: 2000, attrs: () => ({}) })}</div>`),
].join('') + '</div>');

/**
 * @param {number} at
 * @param {number} metres
 * @param {string} line
 * @param {{ of?: number, lit?: boolean }} [state]
 */
const oneRow = (at, metres, line, { of = 3, lit = false } = {}) => circleRow({ at, of, metres, line, lit,
  reach: () => ({}), remove: of > 1 ? {} : null });

const CIRCLE_ROW = () => group('CircleRow', '<div class="gallery__rows">' + [
  specimen('One circle: its ring, its stepper and what it takes in, no ×',
    `<div class="gallery__column pl-edit__rows">${oneRow(0, 80, 'Takes in 24 stays', { of: 1 })}</div>`),
  specimen('Three circles: each ring its number, the second lit in life, each with its ×', '<div class="gallery__column pl-edit__rows">'
    + `${oneRow(0, 55, 'Takes in 41 stays')}${oneRow(1, 30, 'Takes in 12 stays', { lit: true })}`
    + `${oneRow(2, 80, 'Takes in 26 stays · overlaps Lantern Noodle Bar')}</div>`),
  specimen('A long line wraps, never cut; at 2 km the stepper’s side greyed', '<div class="gallery__column pl-edit__rows">'
    + `${oneRow(0, 2000, 'Takes in 2 spots · 186 stays · overlaps Hill Studio and 8 more', { of: 1 })}</div>`),
  specimen('Add circle under one circle: its `+` on the ring’s centre, its words where the stepper begins',
    `<div class="gallery__column pl-edit__rows">${oneRow(0, 80, 'Takes in 24 stays', { of: 1, lit: true })}`
    + `${addCircleRow()}</div>`),
  specimen('Add circle under three, the last row of the circles', '<div class="gallery__column pl-edit__rows">'
    + `${oneRow(0, 55, 'Takes in 41 stays')}${oneRow(1, 30, 'Takes in 12 stays', { lit: true })}`
    + `${oneRow(2, 80, 'Takes in 26 stays · overlaps Lantern Noodle Bar')}${addCircleRow()}</div>`),
  specimen('Twenty circles, the most a place holds: Add disabled, saying so',
    '<div class="gallery__column pl-edit__rows">' + Array.from({ length: 20 }, (_, at) => oneRow(at, 40, at ? 'Takes in no stays' : 'Takes in 3 stays',
      { of: 20, lit: at === 19 })).join('')
    + `${addCircleRow({ disabled: true })}</div>`),
].join('') + '</div>');

export const places = () => [group('Places · a place in the card over the map', PAGES()),
  group('Places · naming one place at a time, and the hidden spots', NAMING()), PHOTO_GRID(), PERSON_CHIP(),
  FACE_STACK(), QUESTION_CARD(), NAME_FIELD(), NAME_ROW(), CIRCLE_EDITOR(), CIRCLE_ROW()].join('');
