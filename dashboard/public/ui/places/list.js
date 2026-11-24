// @ts-check
/** @import { PlaceRow, Places } from '../../pages.js' */
import { esc } from '../../lib/html.js';
import { spanWords } from '../../lib/places.js';
import { dayAt } from '../../lib/home-clock.js';
import { counted, found, whenWords } from '../../lib/words.js';
import { opensOf } from '../connectors/page.js';
import {
  ARRIVES, button, connected, icon, listRow, listRowReading, listRows, offer, offers, pageHead, searchField, sectionLabel,
  sectionLabelReading, views, waitLine,
} from '../kit/index.js';

/** @typedef {Places['cities'][number]} City */
/** @typedef {{ today: string, here: string | null, counting: boolean }} Shown */

const NAMING_S = 10;
const HERE_NOW = 'Here now';

const GOOGLE_TIMELINE = 'google-timeline';

/**
 * @param {string} typed
 * @param {boolean} hosted
 * @param {string} [tools]
 */
export const listBar = (typed, hosted, tools = '') => pageHead({ title: 'Places', tools: [
  ...tools ? [tools] : [],
  searchField({ placeholder: 'Search places', value: typed, shortcut: hosted ? '⌘F' : '/', outlined: true,
    attrs: { 'data-pl-find': '' } }),
] });

/**
 * @param {string} back
 * @param {string} name
 * @param {string} [tools]
 */
export const pageBar = (back, name, tools = '') => pageHead({ back: { label: back, attrs: { 'data-pl-back': '' } }, name,
  tools: tools ? [tools] : [] });

/**
 * @param {'places' | 'cities' | 'trips'} view
 * @param {{ places: number | null, cities: number | null, trips: number | null | undefined }} counts
 */
export const listViews = (view, counts) => views({ label: 'Places', value: view, options: [
  { id: 'places', label: 'Places', count: counts.places, attrs: { 'data-pl-seg': '' } },
  { id: 'cities', label: 'Cities', count: counts.cities, attrs: { 'data-pl-seg': 'cities' } },
  { id: 'trips', label: 'Trips', count: counts.trips === 0 ? undefined : counts.trips, attrs: { 'data-pl-seg': 'trips' } },
] });

/**
 * @param {object} top
 * @param {string} top.title
 * @param {string} [top.line]
 * @param {string} [top.back]
 * @param {string} top.placeholder
 * @param {string} top.typed
 * @param {boolean} top.hosted
 */
export const cardTop = ({ title, line = '', back = '', placeholder, typed, hosted }) => '<div class="pl-card__top">'
  + (back ? `<button type="button" class="pl-card__back ck-back mac-body" data-pl-back>${icon('back', { size: 'sm' })}`
    + `<span>${esc(back)}</span></button>` : '')
  + `<div class="pl-card__titles"><h1 class="pl-card__title mac-display">${esc(title)}</h1>`
  + (line ? `<p class="pl-card__line mac-body">${esc(line)}</p>` : '') + '</div>'
  + searchField({ placeholder, value: typed, shortcut: hosted ? '⌘F' : '/', outlined: true, attrs: { 'data-pl-find': '' } })
  + '</div>';

/** @param {number} count */
export function inviteCard(count) {
  const minutes = Math.max(1, Math.round((count * NAMING_S) / 60));
  return `<section class="pl-invite ${ARRIVES}" aria-label="Places to name">`
    + '<span class="pl-invite__words">'
    + `<span class="pl-invite__count mac-headline">${esc(counted(count, 'place'))} to name</span>`
    + `<span class="pl-invite__time mac-body">About ${esc(counted(minutes, 'minute'))}</span></span>`
    + button('Start', { variant: 'primary', attrs: { 'data-pl-open': 'name' } }) + '</section>';
}

/**
 * @param {PlaceRow} row
 * @param {Shown} shown
 */
export function placeLine(row, { today, here }) {
  const hours = row.spent?.day === today ? row.spent.hours : 0;
  const spent = hours > 0 ? `${spanWords(hours * 3_600_000)} today` : '';
  if (row.slug === here) return [HERE_NOW, spent].filter(Boolean).join(' · ');
  if (spent) return spent;
  return row.when ? whenWords(row.when, today) : row.line ?? '';
}

/**
 * @param {PlaceRow} row
 * @param {Shown} shown
 */
export function placeRow(row, shown) {
  const here = row.slug === shown.here;
  const line = shown.counting ? null : placeLine(row, shown);
  return listRow({ attrs: { 'data-pl-open': row.slug }, title: row.name, here: here ? HERE_NOW : '', meta: line,
    label: [row.name, here ? 'you are here' : '', line ?? ''].filter(Boolean).join(', ') });
}

/**
 * @param {PlaceRow} row
 * @param {Shown} shown
 */
const onceRow = (row, { today, here }) => {
  const day = row.slug === here ? HERE_NOW : row.when ? whenWords(row.when, today) : '';
  return listRow({ attrs: { 'data-pl-open': row.slug }, short: true, title: row.name, here: row.slug === here ? HERE_NOW : '',
    value: day, label: `${row.name}, ${day}` });
};

/**
 * @param {City} city
 * @param {Shown & { open: boolean }} shown
 */
export function placeRows(city, shown) {
  const rows = city.places.map(row => placeRow(row, shown)).join('');
  if (!city.once.length) return listRows(rows);
  const fold = shown.open
    ? `<div class="pl-once">${sectionLabel('Visited once', { level: 3, count: city.once.length })}`
      + `${city.once.map(row => onceRow(row, shown)).join('')}</div>`
    : listRow({ attrs: { 'data-pl-once': city.title }, short: true, quiet: true, title: 'Visited once', count: city.once.length,
      chevron: true, label: `Visited once, ${city.once.length}` });
  return listRows(`${rows}${fold}`);
}

/** @param {City} city */
const placesIn = city => city.places.length + city.once.length;

/**
 * @param {City[]} cities
 * @param {Shown & { opened: Set<string> }} shown
 */
export const cityGroups = (cities, shown) => cities.map(city => `<section class="pl-group ${ARRIVES}">`
  + sectionLabel(city.title, { count: placesIn(city), open: { 'data-pl-city': city.title,
    'aria-label': `${city.title}, ${counted(placesIn(city), 'place')}` } })
  + placeRows(city, { ...shown, open: shown.opened.has(city.title) }) + '</section>').join('');

/**
 * @param {City} city
 * @param {string} today
 */
const cityLine = (city, today) => [counted(placesIn(city), 'place'),
  city.here ? HERE_NOW : city.when ? whenWords(city.when, today) : ''].filter(Boolean).join(' · ');

/** @param {import('../../pages.js').When} when */
const yearOf = when => when.kind === 'at' || when.kind === 'clock' ? dayAt(when.at_ms).day.slice(0, 4) : (when.kind === 'day' ? when.day : when.month).slice(0, 4);

/** @param {City} city */
export const citySince = city => [counted(placesIn(city), 'place'), city.since ? `since ${yearOf(city.since)}` : '']
  .filter(Boolean).join(' · ');

/**
 * @param {City[]} cities
 * @param {string} today
 */
export const cityRows = (cities, today) => `<div class="${ARRIVES}">${listRows(cities.map(city => {
  const line = cityLine(city, today);
  return listRow({ attrs: { 'data-pl-city': city.title }, title: city.title, here: city.here ? HERE_NOW : '', meta: line,
    chevron: true, label: `${city.title}${city.here ? ', you are here' : ''}, ${line}` });
}).join(''))}</div>`;

/**
 * @template {{ find: string[] }} T
 * @param {T[]} rows
 * @param {string} typed
 * @returns {T[]}
 */
export function foundIn(rows, typed) {
  return rows.filter(row => found(row.find, typed));
}

const READING_ROWS = 6;

const READING_WIDTHS = /** @type {const} */ ([[6, 3], [5, 4], [7, 3], [4, 3], [6, 4], [5, 3]]);

export const rowsReading = () => `<section class="pl-group" aria-hidden="true">${sectionLabelReading(4)}`
  + listRows(READING_WIDTHS.slice(0, READING_ROWS).map(([name, line]) => listRowReading(name, line)).join(''))
  + `</section>${waitLine()}`;

/**
 * @param {number | null} cameras
 * @param {number} hidden
 */
export const cardFoot = (cameras, hidden) => (hidden > 0 ? listRow({ attrs: { 'data-pl-open': 'hidden' }, short: true,
  quiet: true, lead: 'hidden', title: 'Hidden', count: hidden, chevron: true, label: `Hidden, ${hidden}` }) : '')
  + listRow({ attrs: { 'data-pl-cameras': '' }, short: true, quiet: true, lead: 'photos', title: 'Cameras', count: cameras,
    chevron: true }) + credit();

/** @param {import('../../types.js').StreamsReport | null} report */
export const nowhereYet = report => {
  const paired = (report?.devices ?? []).filter(device => device.kind === 'phone' && !device.retired && device.pass !== null);
  const timeline = report?.connectors.find(each => each.id === GOOGLE_TIMELINE) ?? null;
  return offers([...paired.length ? paired.map(phone => offer({ icon: 'phone-screen', name: phone.name,
    line: 'Places appear once your iPhone sends where you’ve been.', end: connected('Connected') }))
    : [offer({ icon: 'phone-screen', name: 'iPhone', line: 'Where you go, from your phone’s location and photos.',
      end: report ? button('Pair', { variant: 'primary', attrs: { 'data-pl-connect': 'phone' } }) : '' })],
  ...timeline ? [offer({ icon: timeline.icon, name: timeline.name, line: 'Your location history, years of it, from a Google export.',
    end: button('Connect', { attrs: { 'data-pl-connect': opensOf(timeline) } }) })] : []]);
};

export const credit = () => `<details class="pp-credit mac-footnote"><summary>${icon('forward', { size: 'xs' })}Map data</summary>`
  + '<p>OpenFreeMap · OpenMapTiles · OpenStreetMap contributors · GeoNames, CC BY 4.0 · Natural Earth.</p></details>';
