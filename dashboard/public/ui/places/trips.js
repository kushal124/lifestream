// @ts-check
/** @import { Summary } from '../../lib/where.js' */
/** @import { AtlasCity, World } from './atlas.js' */
/** @import { Year } from '../../pages.js' */
import { attributes, esc } from '../../lib/html.js';
import { nightOf } from '../../lib/where.js';
import {
  ARRIVES, bar, cardGrid, connectorRowReading, emptyState, icon, sectionLabel, sectionLabelReading, shape, stepper,
  waitLine,
} from '../kit/index.js';
import { rowDay } from '../../lib/words.js';
import { atlasMap } from './atlas.js';

/** @typedef {Year['trips'][number]} Trip */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** @param {string} day */
const dayMonth = day => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;

/** @param {Trip} trip */
export function tripRange({ range: { first, last } }) {
  if (first === last) return dayMonth(first);
  if (first.slice(0, 7) === last.slice(0, 7)) return `${Number(first.slice(8, 10))}–${dayMonth(last)}`;
  return `${dayMonth(first)} – ${dayMonth(last)}`;
}

/**
 * @param {Year} year
 * @param {string} focus
 */
export const tripOf = (year, focus) => year.trips.find(trip => `trip:${trip.range.first}` === focus) ?? null;

/**
 * @param {Year} year
 * @returns {AtlasCity[]}
 */
export const yearCities = year => year.cities.flatMap(city => city.point ? [{ name: city.name, ...city.point, nights: city.nights,
  country: city.country, home: city.base }] : []);

/**
 * @param {number} year
 * @param {{ first: number, last: number }} span
 */
export const yearStepper = (year, span) => stepper({
  label: 'Year', text: String(year),
  less: { label: 'The year before', disabled: year <= span.first, attrs: { 'data-pl-step': '-1' } },
  more: { label: 'The year after', disabled: year >= span.last, attrs: { 'data-pl-step': '1' } },
});

/** @param {string} label @param {string} inner */
const group = (label, inner) => `<section class="pp-group">${sectionLabel(label)}${inner}</section>`;

/** @param {Trip} trip */
const tripRow = trip => {
  const line = `${tripRange(trip)} · ${trip.nights}${trip.guessed ? ' · a guess' : ''}`;
  return `<button${attributes({
    type: 'button', class: 'ck-crow ck-crow--bare', 'data-pl-open': `trip:${trip.range.first}`, 'aria-label': `${trip.title}, ${line}`,
  })}><span class="ck-crow__main" aria-hidden="true"><span class="ck-crow__names">`
    + `<span class="ck-crow__name mac-headline${trip.guessed ? ' pp-unnamed' : ''}">${esc(trip.title)}</span></span>`
    + `<span class="ck-crow__line"><span class="ck-crow__words mac-mono-data">${esc(line)}</span></span></span></button>`;
};

const rowsReading = () => '<section class="pp-group" aria-hidden="true">' + sectionLabelReading(6)
  + cardGrid(Array.from({ length: 6 }, (_, at) => connectorRowReading(at, 'none')), { label: 'Trips' }) + `</section>${waitLine()}`;

const atlasReading = () => `<div class="pp-map pp-map--atlas" aria-hidden="true">${shape()}</div>`;

const FIGURES = /** @type {const} */ ([1, 1, 1]);
const FIGURE_WORDS = /** @type {const} */ ([4, 4, 3]);

export const tripsReading = () => atlasReading() + '<div class="pp-stats" aria-hidden="true">'
  + FIGURES.map((width, at) => `<div class="pp-stat"><span class="pp-stat__v">${bar(width)}</span>`
    + `<span class="pp-stat__l mac-subhead">${bar(FIGURE_WORDS[at])}</span></div>`).join('')
  + '</div>' + rowsReading();

/**
 * @param {object} view
 * @param {Year} view.year
 * @param {World | null} view.world
 * @param {number} view.width
 */
export function tripsBody({ year, world, width }) {
  if (!year.trips.length) {
    return emptyState('trips', `No trips in ${year.year}`, { detail: 'Trips appear when you spend a night away from home.' });
  }
  const cities = yearCities(year);
  const map = world && cities.length ? atlasMap({ world, cities, width, height: 320, label: `Where you slept in ${year.year}` })
    : '';
  const stat = (/** @type {{ count: number, words: string }} */ figure) => '<div class="pp-stat">'
    + `<span class="pp-stat__v">${figure.count.toLocaleString('en-US')}</span>`
    + `<span class="pp-stat__l mac-subhead">${esc(figure.words)}</span></div>`;
  const stats = `<div class="pp-stats">${year.figures.map(stat).join('')}</div>`;
  return map + stats + group(`Trips · ${year.year}`, cardGrid(year.trips.map(tripRow), { label: 'Trips' }));
}

const NIGHTS = /** @type {const} */ ([3, 4, 3, 5, 3, 4]);
const PLACES = /** @type {const} */ ([7, 6, 8, 5, 7, 6]);

const daysReading = () => '<div class="pp-list" aria-hidden="true">'
  + NIGHTS.map((night, at) => '<div class="pp-li"><span class="pp-li__main">'
    + `<span class="mac-body">${bar(night)}</span><span class="pp-li__line mac-subhead">${bar(PLACES[at])}</span></span>`
    + `<span class="pp-li__end mac-mono-data">${bar(2)}</span></div>`).join('') + '</div>';

export const tripPageReading = () => '<header class="pp-head" aria-hidden="true">'
  + `<span class="pp-tile56">${icon('trips', { size: 'lg' })}</span>`
  + `<div class="pp-head__titles"><h1 class="pp-head__title mac-display">${bar(6)}</h1>`
  + `<p class="pp-head__line mac-body">${bar(6)}</p></div></header>${atlasReading()}${group('Days', daysReading())}${waitLine()}`;

/**
 * @param {object} view
 * @param {Trip} view.trip
 * @param {Year} view.year
 * @param {Summary[] | null} view.days
 * @param {World | null} view.world
 * @param {number} view.width
 * @param {string} view.today
 */
export function tripPage({ trip, year, days, world, width, today }) {
  const cities = yearCities(year);
  const byName = new Map(cities.map(city => [city.name, city]));
  const home = cities.find(city => city.home);
  const stops = trip.route.flatMap(name => byName.get(name) ?? []);
  const route = home ? [home, ...stops, home] : stops;
  const map = !route.length ? '' : world ? atlasMap({ world, cities: route, width, height: 280, route: true, label: `The route of ${trip.title}` })
    : atlasReading();
  const head = '<header class="pp-head">'
    + `<span class="pp-tile56" aria-hidden="true">${icon('trips', { size: 'lg' })}</span>`
    + `<div class="pp-head__titles"><h1 class="pp-head__title mac-display">${esc(trip.title)}</h1>`
    + `<p class="pp-head__line mac-body">${esc(`${tripRange(trip)} ${trip.range.first.slice(0, 4)} · ${trip.nights}`
      + `${trip.guessed ? ' · a guess from the days around' : ''}`)}</p></div></header>`;
  const rows = days === null ? daysReading()
    : `<div class="pp-list ${ARRIVES}">` + days.map(day => {
      const night = nightOf(day);
      const places = day.places.slice(0, 3).map(place => place.name).join(', ');
      const when = rowDay(day.from, today);
      return `<button${attributes({ type: 'button', class: 'pp-li', 'data-pl-day': day.from })}>`
        + `<span class="pp-li__main"><span class="mac-body">${esc(night ? `${night.name}${night.guessed ? '?' : ''}` : 'Not known')}</span>`
        + (places ? `<span class="pp-li__line mac-subhead">${esc(places)}</span>` : '') + '</span>'
        + `<span class="pp-li__end mac-mono-data">${esc(when)}</span></button>`;
    }).join('') + '</div>';
  return `${head}${map}${group('Days', rows)}${days === null ? waitLine() : ''}`;
}
