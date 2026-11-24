// @ts-check
/** @import { ContactRun, DaySide, SideFigure, SideGroup, SidePerson, SidePlace } from './pages.js' */
import { esc } from './lib/html.js';
import { daySide, daySideReading, mapViewOf, sidePills, sidePillsReading } from './ui/days/side.js';
import { fitWithin } from './ui/days/fit.js';
import { installMaps } from './ui/kit/map.js';
import { sectionLabel } from './ui/kit/surface.js';

const DAY = '2026-10-23';
const HOUR = 3_600_000;

const HOME = { latitude: 51.5007, longitude: -0.1246 };
const GYM = { latitude: 51.5079, longitude: -0.0877 };
const OFFICE = { latitude: 51.5152, longitude: -0.1419 };
const CAFE = { latitude: 51.4985, longitude: -0.0960 };

/**
 * @param {string} key
 * @param {string} value
 * @param {string} words
 * @returns {SideFigure}
 */
const figure = (key, value, words) => ({ key: /** @type {SideFigure['key']} */ (key), value, words });

const NIGHT = [figure('asleep', '7h 21m', 'asleep'), figure('steps', '1,754', 'steps'), figure('recovery', '63', 'recovery'),
  figure('sent', '1,955', 'sent'), figure('received', '3,723', 'to you')];

/**
 * @param {string} name
 * @param {{ latitude: number, longitude: number }} point
 * @param {number} hours
 * @param {Partial<SidePlace>} [more]
 * @returns {SidePlace}
 */
const place = (name, point, hours, more = {}) => {
  const minutes = Math.round(hours * 60);
  const length = `${Math.floor(minutes / 60) ? `${Math.floor(minutes / 60)}h ` : ''}${minutes % 60}m`;
  return { key: `p:${name}`, slug: `p-${name.toLowerCase().replace(/\W+/gu, '-')}`, name, line: null, home: false, quiet: false,
    ms: hours * HOUR, length, spoken: `${name}, ${length}`, point: { ...point, id: null }, radius_m: null, rows: [], ...more };
};

const PLACES = [
  place('Synthetic Home', HOME, 15.7, { home: true }), place('Synthetic Office', OFFICE, 6.05), place('Corner Gym', GYM, 1.2),
  place('Noon Café', CAFE, 0.5, { slug: null, key: 'spot:51.4985,-0.096', line: '1.2 km away', quiet: true }),
];

/**
 * @param {string} glyph
 * @param {string} value
 * @param {boolean} [quiet]
 * @returns {ContactRun}
 */
const run = (glyph, value, quiet = false) => ({ glyph: /** @type {ContactRun['glyph']} */ (glyph), value, quiet });

/**
 * @param {string} name
 * @param {ContactRun[]} runs
 * @param {Partial<SidePerson>} [more]
 * @returns {SidePerson}
 */
const person = (name, runs, more = {}) => ({ key: `k:${name}`, person: `person:${name.toLowerCase().replace(/\W+/gu, '-')}`, name,
  photo: null, runs, spoken: `${name}, ${runs.map(each => each.value).join(', ')}`, rows: [], ...more });

const PEOPLE = [
  person('Person A', [run('message', '12')]),
  person('Person B', [run('message', '2'), run('call', '15m')]),
  person('Sam de Rivera', [run('message', '3')]),
  person('Person C', [run('call', '5m')]),
  person('Alexandria Montgomery-Featherstonehaugh', [run('message', '1')]),
  person('Person Q', [run('message', '3', true)], { person: null }),
  person('+15550000099', [run('call-missed', '1')], { person: null }),
];

/**
 * @param {string} title
 * @param {ContactRun[]} runs
 * @param {boolean} [quiet]
 * @returns {SideGroup}
 */
const group = (title, runs, quiet = false) => ({ chat: `chat:${title}`, title, runs, spoken: title, quiet, rows: [`g:${title}`] });

const GROUPS = [group('Group Alpha', [run('message', '6')]), group('Synthetic Climbing Club', [run('message', '2')]),
  group('Group Gamma', [run('message', '4', true)], true)];

/**
 * @param {Partial<DaySide>} [more]
 * @returns {DaySide}
 */
const sideOf = (more = {}) => ({ figures: NIGHT, located: true, places: PLACES, people: PEOPLE, groups: GROUPS, unreturned: [], ...more });

function travel() {
  const names = ['Synthetic Home', 'Corner Gym', 'Synthetic Office', 'Synthetic Market', 'Synthetic Library', 'Synthetic Station',
    'Harbour Point Light Station State Park', 'Synthetic Hotel', 'Synthetic Museum', 'Synthetic Pier', 'Synthetic Gardens',
    'Synthetic Terminal'];
  const points = names.map((_, n) => n < 6 ? { latitude: 51.50 + (n % 3) * 0.012, longitude: -0.13 + n * 0.014 }
    : { latitude: 40.70 + ((n - 6) % 3) * 0.015, longitude: -74.02 + (n - 6) * 0.016 });
  return sideOf({ figures: [figure('sent', '42', 'sent'), figure('received', '61', 'to you')],
    places: names.map((name, n) => place(name, points[n], n === 0 ? 3.2 : 1.2, { home: n === 0 })), people: PEOPLE.slice(0, 3), groups: [] });
}

const MANY = Array.from({ length: 20 }, (_, n) => person(`Person ${String.fromCharCode(65 + n)}`, [run('message', String(20 - n))]));

/**
 * @param {string} label
 * @param {string} body
 * @param {string} [frame]
 */
const specimen = (label, body, frame = 'gallery__side') => '<div class="gallery__specimen">'
  + `<p class="gallery__label mac-mono-label">${esc(label)}</p><div class="${frame}">${body}</div></div>`;

/** @type {Record<string, import('./ui/kit/map.js').MapView>} */
const VIEWS = {};
let maps = 0;

/**
 * @param {DaySide} side
 * @param {{ more?: boolean }} [shown]
 */
function column(side, { more = false } = {}) {
  const id = `day-map-${++maps}`;
  const view = mapViewOf(DAY, side);
  if (view) VIEWS[id] = view;
  return daySide(DAY, side, { more, moreGroups: false }, { map: id });
}

/**
 * @param {DaySide} side
 * @param {string} open
 */
function pills(side, open) {
  const id = `day-map-${++maps}`;
  const view = mapViewOf(DAY, side);
  if (view) VIEWS[id] = view;
  return sidePills(DAY, side, { more: false, moreGroups: false, open }, { map: id });
}

export const daysSide = () => {
  const night = sideOf();
  const noNight = sideOf({ figures: [figure('steps', '8,526', 'steps'), figure('sent', '12', 'sent'), figure('received', '30', 'to you')],
    people: PEOPLE.slice(0, 4), groups: [] });
  const zero = sideOf({ figures: [figure('steps', '0', 'steps'), figure('recovery', '41', 'recovery')], people: PEOPLE.slice(0, 2), groups: [] });
  const nowhere = sideOf({ figures: [figure('asleep', '6h', 'asleep'), figure('steps', '3,120', 'steps')], located: false, places: [],
    people: PEOPLE.slice(0, 3), groups: [] });
  const many = sideOf({ people: MANY, groups: GROUPS.slice(0, 1) });
  return [
    `<section class="gallery__group">${sectionLabel('Days · the side column')}<div class="gallery__sides">`,
    specimen('A day with a night, its places and its people', column(night)),
    specimen('No night: three figures, closed up', column(noNight)),
    specimen('A stated zero is drawn', column(zero)),
    specimen('While the day is read', `<div class="ck-root ck-reading">${daySideReading()}</div>`),
    specimen('A travel day: twelve places', column(travel())),
    specimen('No place at all: no map card, no Places', column(nowhere)),
    specimen('Twenty people: fourteen and “6 more”', column(many)),
    specimen('Twenty people, drawn whole', column(many, { more: true })),
    '</div>',
    '<div class="gallery__stack">',
    specimen('Under a pane of 1056: the figures line and the pills', pills(night, ''), 'gallery__line'),
    specimen('While the day is read', `<div class="ck-root ck-reading">${sidePillsReading()}</div>`, 'gallery__line'),
    specimen('People’s popover', pills(night, 'people'), 'gallery__line gallery__line--open'),
    specimen('Places’ popover', pills(night, 'places'), 'gallery__line gallery__line--open'),
    specimen('No night, no place: two figures and People alone', pills(nowhere, ''), 'gallery__line'),
    '</div></section>',
  ].join('');
};

/** @param {HTMLElement} root */
export function drawDaysSide(root) {
  for (const sides of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('.gallery__sides'))) {
    Object.assign(sides.style, { display: 'flex', flexWrap: 'wrap', gap: '48px 40px', alignItems: 'flex-start' });
  }
  for (const side of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('.gallery__side'))) side.style.width = '280px';
  for (const line of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('.gallery__line'))) {
    Object.assign(line.style, { width: '764px', maxWidth: '100%', minHeight: line.classList.contains('gallery__line--open') ? '560px' : '' });
  }
  installMaps(root, { open: () => undefined }).settle(VIEWS);
  for (const side of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('.ds, .ck-popover'))) fitWithin(side);
}
