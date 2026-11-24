process.env.TZ = 'Pacific/Kiritimati';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installClock } from '../public/lib/home-clock.js';
import { visitWords } from '../public/ui/places/rows.js';
import { cityGroups, citySince, foundIn, placeRows } from '../public/ui/places/list.js';
import { whyWords } from '../public/lib/place-naming.js';
import { draggedStays, takesIn } from '../public/lib/circle.js';
import { tripPage, tripsBody } from '../public/ui/places/trips.js';
import { clockFor } from './stand-ins/clock.mjs';

installClock(clockFor('America/Los_Angeles', 4, { first: '2025-12-01', last: '2026-12-31' }));
const at = (/** @type {string} */ iso) => Date.parse(iso);
const LATE = at('2026-10-15T09:10:00Z');

/** @param {string} name */
const fixture = name => JSON.parse(readFileSync(new URL(`../../homelink/Tests/Fixtures/${name}.json`, import.meta.url), 'utf8'));

/** @type {import('../public/pages.js').Places} */
const PLACES = fixture('pages/places.full');
/** @type {import('../public/pages.js').Place} */
const PLACE = fixture('pages/place.full');
/** @type {import('../public/pages.js').PlaceEdit} */
const EDIT = fixture('pages/placeEdit.slug');
/** @type {import('../public/pages.js').Year} */
const YEAR = fixture('pages/year.full');
const SHOWN = { today: PLACES.today, here: PLACES.here, counting: PLACES.counting };

/**
 * @param {string} html
 * @param {RegExp} pattern
 */
const every = (html, pattern) => [...html.matchAll(pattern)].map(([, value]) => value);

test('W1: a visit at 02:10 is the night before\'s: Today until 04:00, Yesterday after, in the home\'s zone', () => {
  const visit = /** @type {any} */ ({ key: 'stay/a@1-2', day: '2026-10-14', start_ms: LATE, end_ms: LATE + 30 * 60_000, people: [] });
  const words = visitWords(visit, { now: at('2026-10-15T10:30:00Z') }, false);
  assert.deepEqual([words.date, words.span], ['Today', '02:10–02:40']);
  assert.equal(visitWords(visit, { now: at('2026-10-15T11:00:00Z') }, false).date, 'Yesterday');
  assert.equal(visitWords(visit, { now: at('2026-10-15T09:20:00Z') }, true).span, 'since 02:10');
});

test('W2: a city\'s year is the home\'s day\'s, not the calendar\'s', () => {
  const city = /** @type {any} */ ({ places: [{}], once: [{}], since: { kind: 'at', at_ms: at('2026-01-01T09:00:00Z') } });
  assert.equal(citySince(city), '2\u00a0places · since 2025');
});

test('W3: a suggestion\'s moment by the home\'s days and zone', () => {
  const suggestion = { name: 'Lantern Park', distance_m: null,
    why: { product: 'Calendar', family: 'calendar', at_ms: LATE, tier: 1 } };
  assert.equal(whyWords(suggestion, at('2026-10-14T20:00:00Z')), 'Calendar · 02:10');
  assert.equal(whyWords(suggestion, at('2026-10-13T20:00:00Z')), 'Calendar · Wed 14 Oct 02:10');
});

test('the list in the answer\'s order: its cities as the home sent them, Elsewhere last, each city\'s places in its order', () => {
  const html = cityGroups(PLACES.cities, { ...SHOWN, opened: new Set() });
  const titles = every(html, /data-pl-city="([^"]*)"/gu);
  assert.deepEqual(titles, PLACES.cities.map(city => city.title));
  assert.equal(titles.at(-1), 'Elsewhere');
  for (const city of PLACES.cities) {
    const rows = every(placeRows(city, { ...SHOWN, open: true }), /data-pl-open="([^"]*)"/gu);
    assert.deepEqual(rows, [...city.places, ...city.once].map(row => row.slug), city.title);
  }
});

test('a city\'s name finds its places, in the answer\'s order; a word in no find finds none', () => {
  const rows = PLACES.cities.flatMap(city => [...city.places, ...city.once]);
  const [paris] = PLACES.cities;
  assert.deepEqual(foundIn(rows, paris.title.toLocaleLowerCase()).map(row => row.slug),
    [...paris.places, ...paris.once].map(row => row.slug));
  assert.deepEqual(foundIn(rows, `${paris.places[0].name.split(' ')[1]} ${paris.title}`).map(row => row.slug),
    [paris.places[0].slug]);
  assert.deepEqual(foundIn(rows, 'nowhere-at-all'), []);
});

test('every case of takes-in.json: the drag counts what the home\'s takesIn counts', () => {
  const { cases } = fixture('rules/takes-in');
  assert.ok(cases.length > 0);
  for (const each of cases) assert.equal(takesIn(each.circle, each.others, each.points), each.takes_in, each.about);
});

test('the drag over the fixture place counts held + takesIn, and that is the count its place page shows', () => {
  assert.equal(EDIT.slug, 'cafe-0c0c0c');
  const own = EDIT.others.filter(other => other.slug === EDIT.slug);
  assert.equal(draggedStays(EDIT, [EDIT.circle, ...own]), PLACE.stays);
  const moved = { ...EDIT.circle, latitude: EDIT.circle.latitude + 1 };
  assert.equal(draggedStays(EDIT, [moved, ...own]), EDIT.held, 'a circle dragged off every stay keeps only what the id holds');
});

const WORLD = { countries: [] };
/**
 * @param {string} html
 * @param {string} name
 */
const marks = (html, name) => html.split(`class="${name}`).length - 1;

test('T1: the year\'s atlas draws home\'s ring and a dot per city, no line from home; a trip draws its route', () => {
  const year = tripsBody({ year: YEAR, world: WORLD, width: 800 });
  const cities = YEAR.cities.filter(city => city.point).length;
  assert.deepEqual([marks(year, 'm-home'), marks(year, 'm-dot'), marks(year, 'm-arc'), marks(year, 'm-route')], [1, cities, 0, 0]);
  const trip = tripPage({ trip: YEAR.trips[0], year: YEAR, days: [], world: WORLD, width: 800, today: YEAR.today });
  assert.equal(marks(trip, 'm-route'), 1);
  assert.equal(marks(trip, 'm-home'), 1);
  assert.equal((trip.match(/class="m-label is-strong"/g) ?? []).length, 1);
});

test('T2: the figures and the trips in the home\'s order and words', () => {
  const html = tripsBody({ year: YEAR, world: WORLD, width: 800 });
  const figures = [...html.matchAll(/<span class="pp-stat__v">([^<]*)<\/span><span class="pp-stat__l mac-subhead">([^<]*)<\/span>/gu)]
    .map(([, value, label]) => `${value} ${label}`);
  assert.deepEqual(figures, YEAR.figures.map(figure => `${figure.count.toLocaleString('en-US')} ${figure.words}`));
  assert.deepEqual(every(html, /data-pl-open="trip:([^"]*)"/gu), YEAR.trips.map(trip => trip.range.first));
});
