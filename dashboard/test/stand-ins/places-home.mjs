// @ts-check
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { crc32, deflateSync } from 'node:zlib';
import { SCENES, scene } from '../../public/kit-gallery-scenes.js';
import { answerPicture, doorBytes, PICTURE_ROUTE } from './pictures.mjs';
import { CIRCLES_MAX, distanceMeters } from '../../public/lib/circle.js';
import { lookup } from '../../public/lib/home-clock.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const PHOTO_ROUTE = /^\/v1\/photos\/sha256:([0-9a-f]{64})$/u;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const PHOTOS_PAGE = 60;
const PHOTOS_NEWEST = 4;
const BROKEN = 'home';

/**
 * @param {number} now
 * @param {string} slug
 * @param {string} name
 * @param {[number, number]} at
 * @param {{ city: string, days: number, hours: number, last: number, first: number, radius?: number, home?: boolean, ask?: boolean }} life
 */
const place = (now, slug, name, [latitude, longitude], { city, days, hours, last, first, radius = 80, home, ask = false }) => ({
  slug, name, latitude, longitude, radius_m: radius, ids: /** @type {string[]} */ ([]),
  also: /** @type {{ latitude: number, longitude: number, radius_m: number }[]} */ ([]), stays: days, days, hours,
  longest_day_hours: Math.min(hours, 9), first_ms: now - first * DAY_MS, last_ms: now - last * DAY_MS,
  ...(home === undefined ? {} : { home }),
  ask_home: ask && home === undefined ? `You’ve slept here 3 nights, since ${WEEKDAYS[new Date(now - first * DAY_MS).getUTCDay()]}.` : null,
  area: { city, region: city === 'Porto' ? 'Porto' : 'Lisbon', country: 'Portugal' },
});

/** @param {number} now */
export const PLACES = now => [
  place(now, 'fixture-river-flat', 'River Flat', [38.7139, -9.1334],
    { city: 'Lisbon', days: 210, hours: 2900, last: 0, first: 700, radius: 150, home: true }),
  place(now, 'fixture-hill-studio', 'Hill Studio', [38.7165, -9.1410],
    { city: 'Lisbon', days: 4, hours: 36, last: 1, first: 5, ask: true }),
  place(now, 'fixture-corner-cafe', 'Corner Cafe', [38.7108, -9.1428], { city: 'Lisbon', days: 44, hours: 61, last: 3, first: 400 }),
  place(now, 'fixture-climbing-hall', 'Climbing Hall', [38.7268, -9.1503], { city: 'Lisbon', days: 30, hours: 70, last: 6, first: 300 }),
  place(now, 'fixture-roof-terrace', 'Roof Terrace', [38.7142, -9.1332],
    { city: 'Lisbon', days: 12, hours: 20, last: 8, first: 150, radius: 30 }),
  place(now, 'fixture-old-office', 'Old Office', [38.7223, -9.1393], { city: 'Lisbon', days: 120, hours: 900, last: 400, first: 1100 }),
  place(now, 'fixture-noodle-bar', 'Noodle Bar', [38.7090, -9.1365], { city: 'Lisbon', days: 1, hours: 1, last: 20, first: 20 }),
  place(now, 'fixture-gallery', 'Salt Gallery', [38.7046, -9.1600], { city: 'Lisbon', days: 1, hours: 2, last: 60, first: 60 }),
  place(now, 'fixture-ferry-dock', 'Ferry Dock', [38.7067, -9.1446], { city: 'Lisbon', days: 1, hours: 1, last: 90, first: 90 }),
  place(now, 'fixture-river-cabin', 'River Cabin', [41.1421, -8.6110], { city: 'Porto', days: 9, hours: 120, last: 30, first: 500 }),
  place(now, 'fixture-tile-market', 'Tile Market', [41.1466, -8.6150], { city: 'Porto', days: 1, hours: 2, last: 31, first: 31 }),
  place(now, 'fixture-palace-garden', 'Palace Garden', [38.7964, -9.3904], { city: 'Sintra', days: 3, hours: 9, last: 200, first: 380 }),
];

const SPOT_LIVES = [{ witnessed: 'You were here on 4 days in 2026. You took 20 photos here.',
  last: 'Last time Sun 18 Oct 2026 from 14:10 to 15:30', photos: 20 },
  { witnessed: 'You took 2 photos here on Sat 17 Oct 2026 from 10:05 to 10:40.', last: null, photos: 2 },
  { witnessed: 'You were here on 3 days in 2026. You took a photo here.',
    last: 'Last time Mon 19 Oct 2026 from 09:00 to 11:20', photos: 1 }];

/**
 * @param {number} now
 * @param {number[]} at
 * @param {{ witnessed: string, last: string | null, photos: number }} life
 * @param {number[]} seeds
 * @param {boolean} ask
 */
const spotOf = (now, [latitude, longitude, days], life, seeds, ask) => ({
  key: `spot:${latitude},${longitude}`, latitude, longitude, stays: days, days, hours: days * 2, longest_day_hours: 2,
  first_ms: now - 50 * DAY_MS, last_ms: now - 5 * DAY_MS, worth: true,
  area: { city: latitude > 40 ? 'Porto' : 'Lisbon', region: 'Lisbon', country: 'Portugal' },
  home_ask: ask ? { nights: 3, since: new Date(now - 2 * DAY_MS).toISOString().slice(0, 10) } : null,
  witnessed: life.witnessed, last: life.last, photos_count: life.photos,
  photos: seeds.slice(0, life.photos).map((seed, index) => ({ image: PICTURE_KEYS[seed],
    at_ms: now - 5 * DAY_MS - index * HOUR_MS })),
});

/** @param {number} now */
export const SPOTS = now => [[38.7189, -9.1466, 4], [38.7120, -9.1290, 2], [41.1495, -8.6108, 3]]
  .map((at, index) => spotOf(now, at, SPOT_LIVES[index], SPOT_PHOTOS[index], index > 0));

/** @param {any} area */
const areaWords = area => area ? [area.city, area.region, area.country].filter(Boolean) : [];
/** @param {number | null | undefined} at_ms */
const atOf = at_ms => at_ms === null || at_ms === undefined ? null : { kind: 'at', at_ms };

/** @param {any} spot */
export const spotRow = spot => ({ key: spot.key, latitude: spot.latitude, longitude: spot.longitude,
  line: `${spot.days} days · ${spot.stays} stays`, find: [...new Set(areaWords(spot.area))], when: atOf(spot.last_ms ?? null),
  photos: (spot.photos ?? []).map((/** @type {any} */ photo) => `sha256:${photo.image}`),
  ask: spot.home_ask ? { line: `You’ve slept here ${spot.home_ask.nights} nights`, since: { kind: 'day', day: spot.home_ask.since } } : null,
  city: spot.area?.city ?? spot.area?.region ?? null });

const REACH_M = 80;
const AROUND_M = 400;
const DEGREE_M = 111_320;
const ELSEWHERE = 'Elsewhere';
const PAGE_FIXTURES = new URL('../../../homelink/Tests/Fixtures/pages/', import.meta.url);
const PLACES_SOURCE = 'places:local:fixture';
const TODAY_HOURS = 2.5;

const SLUG_CHARS = 48;
const COUNTED = { stays: 0, days: 0, hours: 0, longest_day_hours: 0, first_ms: null, last_ms: null, today_hours: 0 };

/** @param {string} name */
function mintedSlug(name) {
  const slug = name.trim().normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-/u, '')
    .slice(0, SLUG_CHARS).replace(/-$/u, '');
  const hex = randomBytes(3).toString('hex');
  return slug ? `${slug}-${hex}` : hex;
}

const SPOT_PHOTOS = [[1, 2, 7, 3, 5, 6], [5, 7], [4]];

const NAMES = [
  ['Lantern Noodle Bar', 'Harbour Ramen', 'Lantern Park', 'Quay Bakery'],
  ['Kiln Coffee', 'Mira’s', 'Quay Apartments', 'Lantern Steps'],
  ['Dockside Books', 'Iron Bridge Bar', 'River Steps', 'Tile Works Cafe'],
];

const typed = (/** @type {string} */ name, /** @type {number} */ distance_m) => ({ name, typed: true, distance_m,
  id: `google:typed-${name.toLowerCase().replace(/[^a-z]+/gu, '-')}` });

/** @type {Record<string, (string | object)[]>[]} */
/** @param {string} google */
const providerOf = google => {
  const act = (/** @type {string} */ label) => ({ do: 'set', label, connector: 'google-places', member: 'key' });
  return { name: 'Google Places', need: google === 'no key' ? { words: 'Names from Google Places come once Lifestream holds a key', act: act('Add key') }
    : google === 'refused' ? { words: 'Your Google Places key was refused', act: act('Change key') } : null };
};

const TYPED_ANSWERS = [
  { lan: ['Lantern Noodle Bar', 'Lantern Park', typed('Lantern Steps Cafe', 300)],
    lantern: ['Lantern Noodle Bar', 'Lantern Park', typed('Lantern Steps Cafe', 300)],
    hill: [{ name: 'Hill Studio', slug: 'fixture-hill-studio', distance_m: 554 }, typed('Hillside Bakery', 340)] },
  { 'hill studio': [{ name: 'Hill Studio', slug: 'fixture-hill-studio', distance_m: 1146 }] },
  { tile: [{ name: 'Tile Market', slug: 'fixture-tile-market', distance_m: 477 }, 'Tile Works Cafe'] },
];

/**
 * @param {number} from_ms
 * @param {number} index
 */
const SUGGESTIONS = (from_ms, index) => {
  const [calendar, message, near, far] = NAMES[index];
  const id = (/** @type {string} */ name) => `google:fixture-${name.toLowerCase().replace(/[^a-z]+/gu, '-')}`;
  return [
    { name: calendar, distance_m: 40, why: { product: 'Calendar', family: 'calendar', at_ms: from_ms + 10 * 60_000, tier: 3 } },
    { name: message, id: id(message), distance_m: 60,
      why: { product: 'WhatsApp', family: 'messages', at_ms: from_ms - 40 * 60_000, tier: 2 } },
    { name: near, id: id(near), distance_m: 90 },
    { name: far, id: id(far), distance_m: 120 },
  ];
};

/**
 * @param {number} seed
 * @param {number} [size]
 */
function picture(seed, size = 192) {
  const pixels = scene(seed, size);
  const rows = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        rows[y * (size * 3 + 1) + 1 + x * 3 + channel] = pixels[(y * size + x) * 4 + channel];
      }
    }
  }
  /** @param {string} type @param {Buffer} data */
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0))]);
}

const PICTURES = new Map(Array.from({ length: SCENES }, (_, seed) => {
  const bytes = picture(seed);
  return [createHash('sha256').update(bytes).digest('hex'), bytes];
}));
const PICTURE_KEYS = [...PICTURES.keys()];

/** @type {{ id: string, name: string, photo?: { crop: string } }[]} */
const PEOPLE = [{ id: 'person:person-b', name: 'Person B', photo: { crop: `sha256:${PICTURE_KEYS[0]}` } },
  { id: 'phone:+15550000001', name: 'Person A' }];

const PHOTO_ZONE = 'Europe/Lisbon';
const LISBON = { city: 'Lisbon', region: 'Lisbon', country: 'Portugal' };
/** @param {string} slug */
const placeHead = slug => {
  const { name, latitude, longitude, radius_m, area } = /** @type {ReturnType<typeof PLACES>[number]} */ (PLACES(0)
    .find(place => place.slug === slug));
  return { slug, name, latitude, longitude, radius_m, area };
};
export const THIS_MAC = { unit: 'macbook-pro-0001', name: 'MacBook Pro', kind: 'mac', retired: false,
  health: { state: 'ok', words: 'Recording' }, streams: [] };
export const THIS_PHONE = { unit: 'iphone-aa01', name: 'iPhone', kind: 'phone', retired: false,
  health: { state: 'needs-you', words: 'Pair iPhone again' }, streams: [] };

const OWN_CAMERA = { id: 'camera:fixture-own', name: 'iPhone 17 Pro', mine: true };
const WEEKEND_CHAT = { network: 'whatsapp', chat: 'whatsapp:120363000000000001@g.us', title: 'Weekend plans', group: true,
  sender: { id: 'phone:+15550000001', name: 'Person A' }, mine: false };
/**
 * @param {number} seed
 * @param {string} at
 * @param {Record<string, unknown>} facts
 */
const factsOf = (seed, at, facts) => {
  const at_ms = Date.parse(at);
  const date = new Date(at_ms + HOUR_MS).toISOString().slice(0, 10);
  return { hash: `sha256:${PICTURE_KEYS[seed]}`, kind: 'photograph', at_ms, zone: PHOTO_ZONE, date, day: date,
    unit: `burst/${at_ms - 60_000}`, caption: null, people: [], size: null, place: null, area: null, camera: OWN_CAMERA,
    from: 'phone', chat: null, play: null, ...facts };
};

/** @param {Uint8Array} bytes */
const hexOf = bytes => createHash('sha256').update(bytes).digest('hex');
const FILM = readFileSync(new URL('../fixtures/video.mp4', import.meta.url));
const LIVE_STILL = readFileSync(new URL('../fixtures/live.png', import.meta.url));
const MOTION = readFileSync(new URL('../fixtures/motion.mov', import.meta.url));
const UNPLAYABLE = Buffer.concat([Buffer.from('1a45dfa3a3428286', 'hex'), Buffer.alloc(64, 7)]);
const AWAY = Buffer.concat([FILM, Buffer.alloc(1)]);
const LIVE_AWAY_STILL = picture(2, 200);
const MOTION_AWAY = Buffer.concat([MOTION, Buffer.alloc(1)]);
export const FILM_HASHES = { video: `sha256:${hexOf(FILM)}`, live: `sha256:${hexOf(LIVE_STILL)}`,
  motion: `sha256:${hexOf(MOTION)}`, unplayable: `sha256:${hexOf(UNPLAYABLE)}`, away: `sha256:${hexOf(AWAY)}`,
  liveAway: `sha256:${hexOf(LIVE_AWAY_STILL)}`, motionAway: `sha256:${hexOf(MOTION_AWAY)}` };
const FILMS = new Map([FILM, LIVE_STILL, MOTION, UNPLAYABLE, AWAY, LIVE_AWAY_STILL, MOTION_AWAY].map(bytes => [hexOf(bytes), bytes]));
const POSTERS = new Map([[hexOf(FILM), picture(3, 320)], [hexOf(AWAY), picture(3, 320)], [hexOf(LIVE_STILL), LIVE_STILL],
  [hexOf(LIVE_AWAY_STILL), LIVE_AWAY_STILL]]);
/** @type {[string, Record<string, unknown>][]} */
const FILM_FACTS = [
  { ...factsOf(0, '2025-10-11T17:50:00Z', { place: placeHead('fixture-climbing-hall'), people: [], size: null, caption: null }),
    hash: FILM_HASHES.video, kind: 'video', play: { hash: FILM_HASHES.video, media_type: 'video/mp4', live: false } },
  { ...factsOf(0, '2025-10-11T17:51:00Z', { place: placeHead('fixture-climbing-hall'), people: [], size: null,
    caption: 'A chalked hand on a hold.' }), hash: FILM_HASHES.live,
  play: { hash: FILM_HASHES.motion, media_type: 'video/quicktime', live: true } },
  { ...factsOf(0, '2025-10-11T17:52:00Z', { place: placeHead('fixture-climbing-hall'), people: [], size: null, caption: null }),
    hash: FILM_HASHES.unplayable, kind: 'video', play: { hash: FILM_HASHES.unplayable, media_type: 'video/x-matroska', live: false } },
  { ...factsOf(0, '2025-10-11T17:53:00Z', { place: placeHead('fixture-climbing-hall'), people: [], size: null, caption: null }),
    hash: FILM_HASHES.away, kind: 'video', play: { hash: FILM_HASHES.away, media_type: 'video/mp4', live: false } },
  { ...factsOf(0, '2025-10-11T17:54:00Z', { place: placeHead('fixture-climbing-hall'), people: [], size: null, caption: null }),
    hash: FILM_HASHES.liveAway, play: { hash: FILM_HASHES.motionAway, media_type: 'video/quicktime', live: true } },
].map(facts => [String(facts.hash).slice('sha256:'.length), facts]);

/**
 * @param {Buffer} bytes
 * @param {string} range
 * @param {import('node:http').ServerResponse} response
 */
function answerFile(bytes, range, response) {
  const asked = /^bytes=(\d+)-(\d*)$/u.exec(range);
  if (!asked) {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length), 'accept-ranges': 'bytes' });
    response.end(bytes);
    return;
  }
  const from = Number(asked[1]);
  const to = Math.min(bytes.length - 1, asked[2] ? Number(asked[2]) : bytes.length - 1);
  if (from >= bytes.length) {
    response.writeHead(416, { 'content-range': `bytes */${bytes.length}` });
    response.end();
    return;
  }
  response.writeHead(206, { 'content-type': 'application/octet-stream', 'content-length': String(to - from + 1),
    'content-range': `bytes ${from}-${to}/${bytes.length}`, 'accept-ranges': 'bytes' });
  response.end(bytes.subarray(from, to + 1));
}

/** @type {Map<string, Record<string, unknown>>} */
export const PHOTO_FACTS = new Map([
  factsOf(0, '2025-10-11T17:42:00Z', { caption: 'Two people at the foot of a climbing wall, one tying in.',
    people: [{ id: 'phone:+15550000001', name: 'Person A', me: false, box: [16, 40, 76, 112], photo: null },
      { id: 'person:person-b', name: 'Person B', me: false, box: [104, 30, 168, 104], photo: PEOPLE[0].photo }],
    size: { width: 192, height: 192 }, place: placeHead('fixture-climbing-hall') }),
  factsOf(1, '2025-10-11T12:05:00Z', { people: [{ id: 'phone:+15550000001', name: 'Person A', me: false, box: null, photo: null }],
    area: { city: 'Seafront', region: 'Northbay', country: 'Testland' }, from: 'mac' }),
  factsOf(2, '2025-10-09T20:15:00Z', { kind: 'image', unit: null, camera: null, from: null,
    chat: { ...WEEKEND_CHAT, at_ms: Date.parse('2025-10-09T20:15:00Z'), day: '2025-10-09',
      record: { source: 'whatsapp:+15550000009:iphone-aa01', kind: 'msg', key: 'FIXTURE-PICTURE-1' } } }),
  factsOf(3, '2025-10-12T01:10:00Z', { kind: 'screenshot', day: '2025-10-11', camera: null, from: 'mac' }),
  factsOf(5, '2025-10-10T09:30:00Z', { place: { ...placeHead('fixture-river-flat'), slug: 'fixture-harbour-room',
    name: 'The Long Room Above the Old Harbour Market Steps', area: LISBON }, from: 'google-photos',
    camera: { id: 'camera:fixture-other', name: 'Pixel 9', mine: false },
    chat: { network: 'whatsapp', chat: 'whatsapp:+15550000001', title: 'Person A', group: false,
      sender: { id: 'phone:+15550000001', name: 'Person A' }, mine: false, at_ms: Date.parse('2025-10-10T10:02:00Z'),
      day: '2025-10-10', record: { source: 'whatsapp:+15550000009:iphone-aa01', kind: 'msg', key: 'FIXTURE-PICTURE-2' } } }),
  factsOf(6, '2025-10-08T16:00:00Z', { place: placeHead('fixture-river-flat'), camera: null,
    chat: { ...WEEKEND_CHAT, sender: null, at_ms: Date.parse('2025-10-08T16:05:00Z'), day: '2025-10-08',
      record: { source: 'whatsapp:+15550000009:iphone-aa01', kind: 'msg', key: 'FIXTURE-PICTURE-3' } } }),
  factsOf(7, '2025-10-08T16:20:00Z', { place: placeHead('fixture-river-flat'),
    people: [{ id: 'phone:+15550000001', name: 'Person A' }, { id: 'person:person-b', name: 'Person B' },
      { id: 'person:person-c', name: 'Person C' }, { id: 'person:person-d', name: 'Person D' },
      { id: 'person:person-e', name: 'Person E' }, { id: 'person:person-f', name: 'Person F' }]
      .map(person => ({ ...person, me: false, box: null, photo: null })) }),
].map(facts => [String(facts.hash).slice('sha256:'.length), facts]).concat(FILM_FACTS));

export const FIXTURE_HASHES = PICTURE_KEYS.map(hex => `sha256:${hex}`);

const PERSON_B_PHOTOS = [0, 1, 5, 6, 7].map((seed, at) => ({ image: PICTURE_KEYS[seed], face: `${PICTURE_KEYS[seed]}:104,30,168,104`,
  box: [104, 30, 168, 104], at_ms: Date.parse('2025-10-11T17:42:00Z') - at * DAY_MS, crop: null, camera: true }));

/**
 * @param {{ latitude: number, longitude: number }} a
 * @param {{ latitude: number, longitude: number }} b
 */
const metres = (a, b) => distanceMeters(a, b);

/** @param {number} ms */
const monthYear = ms => `${MONTHS[new Date(ms).getUTCMonth()]} ${new Date(ms).getUTCFullYear()}`;

/**
 * @typedef {ReturnType<typeof PLACES>[number]} Fixture
 * @typedef {{ unit: string, start_ms: number, end_ms: number, day: string, people: string[],
 *   centre: { latitude: number, longitude: number } }} Visit
 */

/**
 * @param {{ latitude: number, longitude: number, radius_m: number, also?: { latitude: number, longitude: number, radius_m: number }[] }} fixture
 * @param {number} at
 */
function visitCentre(fixture, at) {
  const circles = [fixture, ...fixture.also ?? []];
  const place = circles[at % circles.length];
  const turn = at * 2.399963;
  const out = place.radius_m * (0.1 + 0.8 * ((at * 0.618034) % 1));
  const round = (/** @type {number} */ degrees) => Math.round(degrees * 1e6) / 1e6;
  return { latitude: round(place.latitude + (out * Math.cos(turn)) / 111_320),
    longitude: round(place.longitude + (out * Math.sin(turn)) / (111_320 * Math.cos((place.latitude * Math.PI) / 180))) };
}

/** @type {Record<string, { weekdays?: number[], hour: number, people: number, photos: number, rhythm?: (place: Fixture) => string }>} */
const LIVES = {
  'fixture-river-flat': { hour: 22, people: 0, photos: 75,
    rhythm: place => `Home · ${place.days} nights since ${new Date(place.first_ms).getUTCFullYear()}` },
  'fixture-hill-studio': { hour: 22, people: 1, photos: 3 },
  'fixture-climbing-hall': { weekdays: [2, 4], hour: 18, people: 2, photos: 18,
    rhythm: place => `${place.days} days here since ${monthYear(place.first_ms)} · usually Tue and Thu evenings` },
  'fixture-noodle-bar': { hour: 12, people: 1, photos: 2 },
};

/**
 * @param {Fixture} place
 * @param {number} now
 * @returns {Visit[]}
 */
function fixtureVisits(place, now) {
  const life = LIVES[place.slug] ?? { hour: 13, people: 0, photos: 0 };
  const today = Math.floor(now / DAY_MS);
  const last = today - Math.round((now - place.last_ms) / DAY_MS);
  const first = today - Math.round((now - place.first_ms) / DAY_MS);
  /** @type {number[]} */
  const candidates = [];
  for (let day = last; day >= first; day -= 1) {
    if (!life.weekdays || life.weekdays.includes(new Date(day * DAY_MS).getUTCDay())) candidates.push(day);
  }
  const count = Math.min(place.days, candidates.length);
  const each = Math.min(12, Math.max(0.5, place.hours / place.days)) * HOUR_MS;
  return Array.from({ length: count }, (_, at) => {
    const day = candidates[count === 1 ? 0 : Math.round((at * (candidates.length - 1)) / (count - 1))];
    const start_ms = Math.min(now - HOUR_MS, day * DAY_MS + life.hour * HOUR_MS + ((at * 7) % 40) * 60_000);
    const end_ms = Math.min(now, start_ms + each);
    const people = PEOPLE.slice(0, life.people).filter((_, which) => (at + which) % (which + 2) === 0).map(person => person.id);
    return { unit: `stay/location:local:fixture/${start_ms}`, start_ms, end_ms,
      day: new Date(day * DAY_MS).toISOString().slice(0, 10), people, centre: visitCentre(place, at) };
  });
}

/**
 * @param {Fixture} place
 * @param {Visit[]} visits
 * @param {number} [more]
 */
function fixturePhotos(place, visits, more = 0) {
  if (!visits.length) return [];
  const taken = Array.from({ length: LIVES[place.slug]?.photos ?? 0 }, (_, at) => {
    const visit = visits[Math.floor(at / 3) % visits.length];
    return { image: PICTURE_KEYS[at % PICTURE_KEYS.length], at_ms: visit.start_ms + (40 - (at % 3) * 12) * 60_000 };
  });
  const newer = Array.from({ length: more }, (_, at) => ({ image: PICTURE_KEYS[(at + 3) % PICTURE_KEYS.length],
    at_ms: visits[0].start_ms + (50 + more - at) * 60_000 }));
  return [...newer, ...taken];
}

/** @param {{ door: { url: string }, now: number }} options */
export async function placesHome({ door, now }) {
  const ahead = now - Date.now();
  const clock = () => Date.now() + ahead;
  const fixtures = PLACES(now).map(place => ({ ...place, today_hours: place.slug === 'fixture-river-flat' ? TODAY_HOURS : 0 }));
  /** @type {any[]} */
  const saved = [];
  /** @type {any[]} */
  const acts = [];
  /** @type {any[]} */
  const named = [];
  /** @type {{ key: string, latitude: number, longitude: number, hidden_ms: number, days: number, nearest: any }[]} */
  const hidden = [];
  /** @type {string[]} */
  const asked = [];
  let unchanged = 0;
  /**
   * @param {string} key
   * @param {{ latitude: number, longitude: number }} centre
   * @param {number} hidden_ms
   * @param {number} days
   */
  const hiddenAt = (key, centre, hidden_ms, days) => ({ key, ...centre, hidden_ms, days,
    nearest: [...fixtures, ...named].map(place => ({ slug: place.slug, name: place.name, distance_m: Math.round(metres(place, centre)) }))
      .sort((a, b) => a.distance_m - b.distance_m)[0] ?? null });
  hidden.push(hiddenAt('hidden-fixture', { latitude: 38.7100, longitude: -9.1420 }, now - 12 * DAY_MS, 4));
  /** @type {Record<string, string>[]} */
  const suggested = [];
  /** @type {{ count: number, done: () => void }[]} */
  const waiting = [];
  let refusing = '';
  let forbidding = false;
  /** @type {Map<string, { act: null, id: string, position: string }>} */
  const answered = new Map();
  /** @type {Set<string>} */
  const counting = new Set();
  /** @type {Set<() => void>} */
  const heldSettled = new Set();
  const wakeSettled = () => {
    for (const wake of [...heldSettled]) wake();
  };
  /**
   * @param {URL} url
   * @param {import('node:http').ServerResponse} response
   * @returns {Promise<void>}
   */
  const settled = async (url, response) => {
    if (url.searchParams.get('settled') !== '1' || counting.size === 0) return;
    await new Promise(done => {
      const wake = () => {
        heldSettled.delete(wake);
        response.off('close', wake);
        done(undefined);
      };
      heldSettled.add(wake);
      response.once('close', wake);
    });
  };
  let holding = false;
  let lastMs = 0;
  const stamp = () => {
    lastMs = Math.max(clock(), lastMs + 1);
    return lastMs;
  };
  /** @type {Map<string, number>} */
  const photographed = new Map();
  /** @type {Map<string, string>} */
  const replaced = new Map();
  /** @type {Set<{ response: import('node:http').ServerResponse, last: string | null }>} */
  const feeds = new Set();
  let landings = 0;
  /** @type {string | null} */
  let position = null;
  let preparing = false;
  /** @type {'unheld' | 'held' | null} */
  let listRefusal = null;
  let losing = false;
  let stalling = false;
  /** @type {(() => Promise<void>) | null} */
  let stalled = null;
  let google = 'answered';
  let fromFixtures = false;
  let fixtureActed = false;
  /** @type {any} */
  let brokenHome = null;
  /** @type {any[]} */
  const found = [];
  /** @type {string[]} */
  const photosAsked = [];
  /** @type {string[]} */
  const photosLeft = [];
  /** @type {Map<string, { promise: Promise<void>, release: () => void }>} */
  const held = new Map();
  /** @type {Set<string>} */
  const failing = new Set();
  /** @type {Set<string>} */
  const unreached = new Set();
  /** @type {Set<string>} */
  const later = new Set();
  /** @type {string[]} */
  const picturesAsked = [];
  /** @type {string[]} */
  const picturesLeft = [];
  /** @type {Map<string, { promise: Promise<void>, release: () => void }>} */
  const heldPictures = new Map();
  /** @param {Fixture} fixture */
  const photosOf = fixture => {
    const all = fixturePhotos(fixture, fixtureVisits(fixture, now), photographed.get(fixture.slug) ?? 0);
    const oldest = replaced.get(fixture.slug);
    return oldest ? [...all.slice(0, -1), { ...all[all.length - 1], image: oldest }] : all;
  };

  /**
   * @param {string} path
   * @param {string} authorization
   */
  const fromDoor = async (path, authorization) => (await fetch(`${door.url}${path}`, { headers: { authorization } })).json();

  /** @param {string} authorization */
  async function doorHome(authorization) {
    brokenHome ??= (await fromDoor(`/v1/places?slug=${BROKEN}`, authorization)).place;
    return brokenHome;
  }

  /** @param {string} authorization */
  const listed = async authorization => {
    const [answer, homeClock] = await Promise.all([fromDoor('/v1/places', authorization), fromDoor('/v1/clock', authorization)]);
    const today = lookup(homeClock, clock());
    position = answer.position;
    const places = [...answer.places.map((/** @type {any} */ place) => ({ also: [], ...place })), ...fixtures, ...named]
      .map(place => counting.has(place.slug) ? { ...place, ...COUNTED, counting: true } : place);
    const circles = [...named, ...[...fixtures, ...named].flatMap(place => place.also),
      ...hidden.map(each => ({ ...each, radius_m: REACH_M }))];
    const held = (/** @type {any} */ spot) => circles.some(circle => metres(spot, circle) <= circle.radius_m);
    const spots = [...SPOTS(now), ...found, ...answer.spots];
    const flat = /** @type {Fixture} */ (fixtures.find(place => place.slug === 'fixture-river-flat'));
    const here = { latitude: flat.latitude, longitude: flat.longitude, start_ms: now - TODAY_HOURS * HOUR_MS, end_ms: now,
      slug: flat.slug };
    return { ...answer, day: today.day, day_until_ms: today.end_ms, here, places, spots: spots.filter(spot => !held(spot)), hidden };
  };

  /**
   * @param {string} kind
   * @param {string} key
   */
  function told(kind, key) {
    say(id => `${id === null ? '' : `id: ${id}\n`}data: ${JSON.stringify({ seq: 0, at_ms: clock(), kind, key, detail: {} })}\n\n`);
  }

  function reset() {
    say(id => `event: reset\n${id === null ? '' : `id: ${id}\n`}data: ${JSON.stringify({ seq: 0, at_ms: clock() })}\n\n`);
  }

  /** @type {((id: string | null) => string)[]} */
  const unsaid = [];
  /** @param {(id: string | null) => string} block */
  function say(block) {
    if (!feeds.size) return void unsaid.push(block);
    for (const feed of feeds) feed.response.write(block(feed.last ?? position));
  }

  function landed() {
    landings += 1;
    told('import', `${PLACES_SOURCE}/fixture-${landings}`);
    if (!holding) told('places', 'places');
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   */
  async function follow(request, response) {
    const stated = request.headers['last-event-id'];
    const feed = { response, last: typeof stated === 'string' ? stated : null };
    const following = new AbortController();
    response.on('close', () => {
      feeds.delete(feed);
      following.abort();
    });
    const passed = await fetch(`${door.url}/v1/feed`, { signal: following.signal, headers: {
      authorization: String(request.headers.authorization ?? ''), ...(feed.last === null ? {} : { 'last-event-id': feed.last }) } });
    response.writeHead(passed.status, { 'content-type': passed.headers.get('content-type') ?? 'text/event-stream' });
    if (passed.status !== 200 || !passed.body) {
      response.end(Buffer.from(await passed.arrayBuffer()));
      return;
    }
    feeds.add(feed);
    for (const block of unsaid.splice(0)) response.write(block(feed.last ?? position));
    let text = '';
    try {
      for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (passed.body)) {
        text += Buffer.from(chunk).toString('utf8');
        for (let end = text.indexOf('\n\n'); end >= 0; end = text.indexOf('\n\n')) {
          const block = text.slice(0, end + 2);
          text = text.slice(end + 2);
          feed.last = /^id: ?(.*)$/mu.exec(block)?.[1] ?? feed.last;
          response.write(block);
        }
      }
    } catch {
    }
    feeds.delete(feed);
    response.end();
  }

  /**
   * @param {string} authorization
   * @returns {Promise<Map<string, string>>}
   */
  async function brokenUnits(authorization) {
    /** @type {Visit[]} */
    const pieces = (await doorHome(authorization)).visits;
    return new Map(pieces.map(piece => [piece.unit, pieces[pieces.length - 1].unit]));
  }

  /**
   * @param {URL} url
   * @param {string} authorization
   * @returns {Promise<string>}
   */
  async function ownFocus(url, authorization) {
    const focus = url.searchParams.get('focus') ?? '';
    /** @type {Visit[]} */
    const pieces = (await doorHome(authorization)).visits;
    const shared = pieces[pieces.length - 1]?.unit;
    const own = pieces.find(piece => focus === `u:${shared}@${piece.start_ms}-${piece.end_ms}`);
    if (!own) return `${url.pathname}${url.search}`;
    const asked = new URL(url);
    asked.searchParams.set('focus', `u:${own.unit}@${own.start_ms}-${own.end_ms}`);
    return `${asked.pathname}${asked.search}`;
  }

  /**
   * @param {string} slug
   * @param {string} authorization
   */
  async function onePlace(slug, authorization) {
    const { position, places } = await listed(authorization);
    const found = places.find((/** @type {any} */ each) => each.slug === slug);
    if (!found) return null;
    const fixture = fixtures.find(each => each.slug === slug);
    if (!fixture && !named.some(each => each.slug === slug)) {
      const [own, units] = await Promise.all([fromDoor(`/v1/places?slug=${encodeURIComponent(slug)}`, authorization),
        brokenUnits(authorization)]);
      return { ...own, place: { ...own.place, here: false, visits: own.place.visits.map((/** @type {Visit} */ visit) =>
        ({ ...visit, unit: units.get(visit.unit) ?? visit.unit })) } };
    }
    /** @type {Visit[]} */
    const visits = fixture ? fixtureVisits(fixture, now) : [];
    const photos = fixture ? photosOf(fixture) : [];
    /** @type {Map<string, number>} */
    const days = new Map();
    for (const visit of visits) for (const id of visit.people) days.set(id, (days.get(id) ?? 0) + 1);
    const holds = (/** @type {any} */ outer, /** @type {any} */ inner) => outer !== inner
      && metres(outer, inner) + inner.radius_m <= outer.radius_m;
    const part = places.filter((/** @type {any} */ each) => holds(each, found))
      .sort((/** @type {any} */ a, /** @type {any} */ b) => a.radius_m - b.radius_m)[0];
    const life = LIVES[slug];
    const placed = {
      here: slug === 'fixture-river-flat',
      part_of: part ? { slug: part.slug, name: part.name } : null,
      inside: places.filter((/** @type {any} */ each) => holds(found, each))
        .map((/** @type {any} */ each) => ({ slug: each.slug, name: each.name }))
        .sort((/** @type {any} */ a, /** @type {any} */ b) => a.name.localeCompare(b.name)),
    };
    if (found.counting) {
      return { position, place: { ...found, ...placed, visits_count: 0, nights: 0, ask_home: null, rhythm: null, visits: [],
        photos: [], photos_count: 0, people: [] } };
    }
    return { position, place: {
      ...found, ...placed, visits_count: visits.length, nights: found.home === true ? visits.length : found.ask_home ? 3 : 0,
      ask_home: found.home === undefined ? found.ask_home ?? null : null,
      rhythm: life?.rhythm && fixture ? life.rhythm(fixture) : null,
      visits, photos: photos.slice(0, PHOTOS_NEWEST), photos_count: photos.length,
      people: PEOPLE.filter(person => days.has(person.id)).map(person => ({ ...person, days: days.get(person.id) ?? 0 }))
        .sort((a, b) => b.days - a.days || a.name.localeCompare(b.name)),
    } };
  }

  /** @param {any} a @param {any} b */
  const newest = (a, b) => (b.last_ms ?? -Infinity) - (a.last_ms ?? -Infinity) || a.name.localeCompare(b.name);
  /** @param {any[]} circles */
  const frameOf = circles => {
    if (!circles.length) return null;
    const sides = circles.map(({ latitude, longitude, radius_m }) => {
      const out = radius_m + AROUND_M;
      const east = out / (DEGREE_M * Math.max(0.01, Math.cos((latitude * Math.PI) / 180)));
      return { north: latitude + out / DEGREE_M, south: latitude - out / DEGREE_M, east: longitude + east, west: longitude - east };
    });
    return { north: Math.max(...sides.map(side => side.north)), south: Math.min(...sides.map(side => side.south)),
      east: Math.max(...sides.map(side => side.east)), west: Math.min(...sides.map(side => side.west)) };
  };

  /** @param {string} authorization */
  async function placesPage(authorization) {
    const { position, ...read } = await listed(authorization);
    const list = preparing ? { ...read, spots: [], places: read.places.map((/** @type {any} */ place) => ({ ...place, ...COUNTED,
      counting: true })) } : read;
    /** @type {Map<string, any[]>} */
    const cities = new Map();
    for (const place of list.places) cities.set(place.area?.city ?? ELSEWHERE, [...cities.get(place.area?.city ?? ELSEWHERE) ?? [], place]);
    const grouped = [...cities].map(([title, held]) => ({ title, held: [...held].sort(newest) }))
      .sort((a, b) => Number(a.title === ELSEWHERE) - Number(b.title === ELSEWHERE) || newest(a.held[0], b.held[0]));
    const row = (/** @type {any} */ place) => ({ slug: place.slug, name: place.name, line: place.last_ms === null ? 'Not yet' : null,
      when: atOf(place.last_ms), spent: place.today_hours > 0 ? { day: list.day, hours: place.today_hours } : null,
      find: [...new Set([place.name, ...areaWords(place.area)])], latitude: place.latitude, longitude: place.longitude,
      radius_m: place.radius_m, also: place.also ?? [], hours: place.hours });
    const spots = list.spots.filter((/** @type {any} */ spot) => spot.worth && typeof spot.key === 'string');
    const here = list.here?.slug ?? null;
    return { position, today: list.day, here, counting: preparing || list.places.some((/** @type {any} */ place) => place.counting),
      frame: frameOf(grouped[0]?.held.flatMap((/** @type {any} */ place) => [place, ...place.also ?? []]) ?? []),
      cities: grouped.map(({ title, held }) => {
        const firsts = held.flatMap(place => place.first_ms ?? []);
        return { key: title === ELSEWHERE ? 'elsewhere' : `city:${title}`, title, here: held.some(place => place.slug === here),
          when: atOf(held[0].last_ms), since: firsts.length ? atOf(Math.min(...firsts)) : null,
          point: { latitude: held.reduce((sum, place) => sum + place.latitude, 0) / held.length,
            longitude: held.reduce((sum, place) => sum + place.longitude, 0) / held.length },
          places: held.filter(place => place.days !== 1).map(row), once: held.filter(place => place.days === 1).map(row) };
      }),
      to_name: spots.map(spotRow),
      hidden: [...list.hidden].sort((a, b) => b.hidden_ms - a.hidden_ms).map(each => ({ key: each.key, latitude: each.latitude,
        longitude: each.longitude, hidden: atOf(each.hidden_ms),
        line: [each.days > 0 ? `${each.days} days` : '', each.nearest ? `${Math.round(each.nearest.distance_m)} m from ${each.nearest.name}` : '']
          .filter(Boolean).join(' · ') || null })),
    };
  }

  /**
   * @param {string} slug
   * @param {string} authorization
   */
  async function placePage(slug, authorization) {
    const answer = await onePlace(slug, authorization);
    if (!answer) return null;
    const { place } = answer;
    const { places } = await listed(authorization);
    const clashes = place.ids.flatMap((/** @type {string} */ id) => {
      const names = places.filter((/** @type {any} */ other) => other.slug !== slug && other.ids.includes(id))
        .map((/** @type {any} */ other) => other.name);
      return names.length ? [{ id, names }] : [];
    });
    const first = place.first_ms === null || place.rhythm?.includes('since ') ? null
      : place.days === 1 ? { kind: 'day', day: place.visits[0]?.day ?? new Date(place.first_ms).toISOString().slice(0, 10) }
        : { kind: 'month', month: new Date(place.first_ms).toISOString().slice(0, 7) };
    const photoOf = (/** @type {any} */ person) => !person.photo ? null : 'crop' in person.photo ? person.photo.crop : person.photo.card;
    return { position: answer.position, today: new Date(clock()).toISOString().slice(0, 10), counting: place.counting === true,
      head: { name: place.name, line: place.area?.city ?? place.area?.region ?? null, since: first },
      here: place.here, rhythm: place.rhythm, stays: place.stays ?? 0,
      visits: { count: place.visits_count, rows: place.visits.map((/** @type {Visit} */ visit) => ({
        key: `${visit.unit}@${visit.start_ms}-${visit.end_ms}`, day: visit.day, start_ms: visit.start_ms, end_ms: visit.end_ms,
        focus: `u:${visit.unit}@${visit.start_ms}-${visit.end_ms}`, people: visit.people })) },
      people: place.people.map((/** @type {any} */ person) => ({ id: person.id, name: person.name, photo: photoOf(person),
        line: place.days > 1 ? `${person.days} days` : null })),
      photos: { first: place.photos.slice(0, PHOTOS_NEWEST).map((/** @type {any} */ photo) => `sha256:${photo.image}`),
        total: place.photos_count, line: place.photos_count ? `${place.photos_count} photos` : null },
      part_of: place.part_of, inside: place.inside, clashes,
      ask_home: place.ask_home ? { line: 'You’ve slept here 3 nights', since: { kind: 'day',
        day: new Date(place.first_ms).toISOString().slice(0, 10) } } : null,
    };
  }

  /**
   * @param {URLSearchParams} query
   * @param {string} authorization
   */
  async function editPage(query, authorization) {
    const { position, places, spots, day } = await listed(authorization);
    const slug = query.get('slug');
    const key = query.get('spot');
    const place = slug === null ? null : places.find((/** @type {any} */ each) => each.slug === slug);
    const spot = key === null ? null : spots.find((/** @type {any} */ each) => each.key === key);
    if (!place && !spot) return null;
    const own = place ? place.slug : /** @type {string} */ (key);
    const circles = place ? [place, ...place.also ?? []] : [{ latitude: spot.latitude, longitude: spot.longitude, radius_m: REACH_M }];
    const mine = circles.map(circle => ({ slug: own, latitude: circle.latitude, longitude: circle.longitude, radius_m: circle.radius_m }));
    const others = places.filter((/** @type {any} */ other) => other.slug !== own)
      .flatMap((/** @type {any} */ other) => [other, ...other.also ?? []].map(circle => ({ slug: other.slug, latitude: circle.latitude,
        longitude: circle.longitude, radius_m: circle.radius_m })));
    /** @type {Map<string, { latitude: number, longitude: number, count: number }>} */
    const points = new Map();
    const add = (/** @type {{ latitude: number, longitude: number }} */ at, /** @type {number} */ count) => {
      const name = `${at.latitude},${at.longitude}`;
      points.set(name, { latitude: at.latitude, longitude: at.longitude, count: (points.get(name)?.count ?? 0) + count });
    };
    for (const fixture of fixtures) for (const visit of fixtureVisits(fixture, now)) add(visit.centre, 1);
    const ours = new Set([...fixtures, ...named].map(each => each.slug));
    for (const other of places.filter((/** @type {any} */ each) => !ours.has(each.slug))) {
      const { place: whole } = await fromDoor(`/v1/places?slug=${encodeURIComponent(other.slug)}`, authorization);
      for (const visit of whole?.visits ?? []) if (visit.centre) add(visit.centre, 1);
    }
    for (const each of spots) if (each.worth && typeof each.key === 'string') add(each, each.stays);
    return { position, today: day, counting: false, slug: own, circle: { latitude: circles[0].latitude,
      longitude: circles[0].longitude, radius_m: circles[0].radius_m }, others: [...mine.slice(1), ...others],
      points: [...points.values()], held: 0, read: true, line: null };
  }

  /** @param {string} name */
  const fixturePage = name => JSON.parse(readFileSync(new URL(`${name}.json`, PAGE_FIXTURES), 'utf8'));

  /**
   * @param {string} path
   * @param {URL} url
   * @param {string} authorization
   * @returns {Promise<{ status: number, body: any }>}
   */
  async function pageOf(path, url, authorization) {
    const page = path.slice('/v1/page/'.length);
    const settledRead = url.searchParams.get('settled') === '1';
    if (fromFixtures) {
      if (page === 'places') return { status: 200, body: fixturePage('places.full') };
      if (page === 'place') {
        const counted = fixtureActed && !settledRead;
        if (settledRead) fixtureActed = false;
        return { status: 200, body: fixturePage(counted ? 'place.counting' : 'place.full') };
      }
      if (page === 'place/edit') return { status: 200, body: fixturePage(url.searchParams.has('spot') ? 'placeEdit.spot' : 'placeEdit.slug') };
      if (page === 'year') return { status: 200, body: fixturePage('year.full') };
    }
    if (page === 'places') return { status: 200, body: await placesPage(authorization) };
    if (page === 'place') {
      const body = await placePage(String(url.searchParams.get('slug')), authorization);
      return body ? { status: 200, body } : { status: 404, body: { code: 'PLACE_UNKNOWN', message: 'no such place' } };
    }
    if (page === 'place/edit') {
      const body = await editPage(url.searchParams, authorization);
      return body ? { status: 200, body } : { status: 404, body: { code: 'PLACE_UNKNOWN', message: 'no such place' } };
    }
    return { status: 0, body: null };
  }

  /**
   * @param {string} slug
   * @param {number} from
   * @param {number} limit
   */
  function photosPage(slug, from, limit) {
    const found = fixtures.find(each => each.slug === slug);
    if (!found) return named.some(each => each.slug === slug) ? { position: '0', photos: [], total: 0, counting: true } : null;
    const all = photosOf(found);
    return { position: '0', photos: all.slice(from, from + limit), total: all.length,
      ...(from + limit < all.length ? { next: String(from + limit) } : {}) };
  }

  /**
   * @param {number} at
   * @param {any[]} records
   * @param {string | undefined} q
   */
  function namesFor(at, records, q) {
    const words = (q ?? '').trim().toLowerCase().replace(/\s+/gu, ' ');
    const rows = !words ? records : (TYPED_ANSWERS[at]?.[words] ?? [])
      .map(row => typeof row === 'string' ? records.find(record => record.name === row) : row)
      .filter(row => row && (!row.typed || google === 'answered'))
      .map(({ typed: _typed, ...row }) => row);
    return { suggestions: rows, ...(q === undefined ? {} : { provider: providerOf(google) }) };
  }

  function settle() {
    for (const waiter of waiting.filter(each => saved.length >= each.count)) {
      waiting.splice(waiting.indexOf(waiter), 1);
      waiter.done();
    }
  }

  /** @param {string} slug */
  const rowOf = slug => fixtures.find(each => each.slug === slug) ?? named.find(each => each.slug === slug);

  /** @param {any} place */
  const countedOf = place => place === undefined ? ''
    : JSON.stringify([place.latitude, place.longitude, place.radius_m, place.also, place.ids, place.home ?? null]);

  /**
   * @param {string} slug
   * @returns {any}
   */
  function servedOf(slug) {
    const place = rowOf(slug);
    return place && { name: place.name, latitude: place.latitude, longitude: place.longitude, radius_m: place.radius_m,
      also: place.also, ids: place.ids, home: place.home ?? null };
  }

  /**
   * @param {string} slug
   * @param {any} fields
   */
  function placed(slug, fields) {
    const before = rowOf(slug);
    const { home: _was, ...kept } = before ?? { ...COUNTED, also: [], ids: [],
      area: { city: fields.latitude > 40 ? 'Porto' : 'Lisbon', region: 'Lisbon', country: 'Portugal' } };
    const { home = before?.home, ...rest } = fields;
    const row = { ...kept, ...rest, slug, ask_home: null, ...(home === undefined || home === null ? {} : { home }) };
    const rows = fixtures.includes(/** @type {any} */ (before)) ? fixtures : named;
    if (before) rows.splice(rows.indexOf(/** @type {any} */ (before)), 1, row);
    else named.push(row);
    if (holding && countedOf(before) !== countedOf(row)) counting.add(slug);
    return countedOf(before) !== countedOf(row) || before?.name !== row.name;
  }

  /** @param {any} entry */
  function save(entry) {
    saved.push(entry);
    settle();
    landed();
  }

  /**
   * @param {any} action
   * @returns {{ id: string, entry: any | null }}
   */
  function apply(action) {
    /** @param {number} status @param {string} code @param {string} message @returns {never} */
    const refused = (status, code, message) => {
      throw Object.assign(new Error(message), { status, code });
    };
    const circle = { latitude: action.latitude, longitude: action.longitude, radius_m: action.radius_m };
    if (action.kind === 'hide') {
      const key = mintedSlug('hidden');
      const spot = SPOTS(now).find(each => metres(each, action) <= REACH_M);
      hidden.push(hiddenAt(key, { latitude: action.latitude, longitude: action.longitude }, stamp(), spot?.days ?? 0));
      return { id: `hidden:${key}`, entry: { kind: 'hide', key, latitude: action.latitude, longitude: action.longitude } };
    }
    if (action.kind === 'unhide') {
      const at = hidden.findIndex(each => each.key === action.key);
      if (at < 0) refused(404, 'PLACE_UNKNOWN', 'There is no such place.');
      hidden.splice(at, 1);
      return { id: `hidden:${action.key}`, entry: { kind: 'unhide', key: action.key } };
    }
    if (action.kind === 'create') {
      const slug = mintedSlug(action.name);
      placed(slug, { ...circle, name: action.name.trim(), ids: action.ids ?? [], home: action.home });
      return { id: `place:${slug}`, entry: { kind: 'create', key: slug, place: servedOf(slug) } };
    }
    const row = rowOf(action.slug) ?? refused(404, 'PLACE_UNKNOWN', 'There is no such place.');
    const id = `place:${action.slug}`;
    if (action.kind === 'remove') {
      const rows = fixtures.includes(row) ? fixtures : named;
      rows.splice(rows.indexOf(row), 1);
      return { id, entry: { kind: 'remove', key: action.slug } };
    }
    /** @type {any} */
    const fields = {};
    if (action.kind === 'add-circle') fields.also = [...row.also, circle];
    else {
      const served = servedOf(action.slug);
      const sent = Object.keys(action).filter(member => !['of', 'kind', 'request', 'slug', 'was'].includes(member));
      const unsaid = sent.find(member => !Object.hasOwn(action.was ?? {}, member));
      if (unsaid) refused(400, 'STATEMENTS_BAD', `An edit says what ${unsaid} was.`);
      if (sent.some(member => JSON.stringify(action.was[member]) !== JSON.stringify(served[member]))) {
        refused(409, 'CHANGED', 'This place changed since it was read.');
      }
      for (const member of sent) fields[member] = member === 'name' ? action.name.trim() : action[member];
    }
    if ((fields.also ?? row.also).length >= CIRCLES_MAX) refused(409, 'CIRCLES_FULL', `A place has at most ${CIRCLES_MAX} circles.`);
    return { id, entry: placed(action.slug, fields) ? { kind: action.kind, key: action.slug, place: servedOf(action.slug) } : null };
  }

  /**
   * @param {any} action
   * @param {import('node:http').ServerResponse} response
   */
  function act(action, response) {
    /** @param {number} status @param {unknown} answer */
    const json = (status, answer) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
    acts.push(action);
    const kept = answered.get(action.request);
    if (kept) return json(200, kept);
    if (fromFixtures) {
      fixtureActed = true;
      const done = { act: null, id: `place:${action.slug}`, position: position ?? '0' };
      answered.set(action.request, done);
      return json(200, done);
    }
    if (refusing) {
      json(503, { code: 'NOT_NOW', message: refusing });
      refusing = '';
      return;
    }
    if (forbidding) {
      json(403, { code: 'PRINCIPAL_SCOPE', message: `${PLACES_SOURCE} is turned off: the home takes none of it` });
      forbidding = false;
      return;
    }
    /** @type {{ id: string, entry: any | null }} */
    let applied;
    try {
      applied = apply(action);
    } catch (error) {
      const { status, code, message } = /** @type {{ status: number, code: string, message: string }} */ (error);
      return json(status, { code, message });
    }
    if (applied.entry) save(applied.entry);
    const answer = { act: null, id: applied.id, position: position ?? '0' };
    answered.set(action.request, answer);
    if (losing) {
      losing = false;
      response.destroy();
    } else if (stalling) {
      stalling = false;
      stalled = () => new Promise(done => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer), done));
    } else json(200, answer);
  }

  /** @param {any} action @param {string} authorization */
  async function atDoor(action, authorization) {
    if (action.of !== 'places') return true;
    if (typeof action.slug !== 'string') return false;
    const { places } = await fromDoor('/v1/places', authorization);
    return places.some((/** @type {any} */ each) => each.slug === action.slug);
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   */
  async function answer(request, response) {
    const url = new URL(request.url ?? '', 'http://door');
    const path = url.pathname;
    /** @type {Buffer[]} */
    const body = [];
    for await (const chunk of request) body.push(chunk);
    const authorization = String(request.headers.authorization ?? '');
    asked.push(request.url ?? '');
    if (path === '/v1/feed') {
      await follow(request, response);
      return;
    }
    /** @param {number} status @param {unknown} answer */
    const json = (status, answer) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer));
    };
    if (path === '/v1/connectors' && request.method === 'GET') {
      const held = await fromDoor(`${path}${url.search}`, authorization);
      const devices = held.devices ?? [];
      const has = (/** @type {string} */ kind) => devices.some((/** @type {any} */ each) => each.kind === kind);
      json(200, { ...held, devices: [...(has('mac') ? [] : [THIS_MAC]), ...(has('phone') ? [] : [THIS_PHONE]), ...devices] });
      return;
    }
    if (path.startsWith('/v1/page/') && (path === '/v1/page/places' ? !listRefusal : true)) {
      await settled(url, response);
      const page = await pageOf(path, url, authorization);
      if (page.status !== 0) {
        if (page.status !== 200) return json(page.status, page.body);
        const { position: _at, ...drawn } = page.body;
        const etag = `"${createHash('sha256').update(JSON.stringify(drawn)).digest('hex')}"`;
        if (request.headers['if-none-match'] === etag) {
          unchanged += 1;
          response.writeHead(304, { etag }).end();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json', etag });
        response.end(JSON.stringify(page.body));
        return;
      }
    }
    const listPath = path === '/v1/page/places' ? '/v1/places' : path;
    if (path === '/v1/places') await settled(url, response);
    if (path === '/v1/places' && url.searchParams.has('slug')) {
      const answer = await onePlace(String(url.searchParams.get('slug')), authorization);
      json(answer ? 200 : 404, answer ?? { code: 'PLACE_UNKNOWN', message: 'no such place' });
      return;
    }
    if (listPath === '/v1/places' && listRefusal === 'held') {
      json(503, { code: 'NOT_NOW', message: 'Lifestream is held: the drive holding it went away.', wait: 'needs', title: 'Lifestream is held', line: 'The drive holding it went away.', acts: [] });
      return;
    }
    if (listPath === '/v1/places' && listRefusal === 'unheld') {
      response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '0.2' });
      response.end(JSON.stringify({ code: 'NOT_NOW', message: 'Lifestream is busy.', wait: 'busy', title: null, line: null, acts: [] }));
      return;
    }
    if (path === '/v1/places') {
      const { position, ...read } = await listed(authorization);
      const answer = preparing ? { ...read, spots: [], counting: true,
        places: read.places.map((/** @type {any} */ place) => ({ ...place, ...COUNTED, counting: true })) } : read;
      const etag = `"${createHash('sha256').update(JSON.stringify(answer)).digest('hex')}"`;
      if (request.headers['if-none-match'] === etag) {
        unchanged += 1;
        response.writeHead(304, { etag }).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json', etag });
      response.end(JSON.stringify({ ...answer, position }));
      return;
    }
    if (path === '/v1/places/suggest') {
      const asked = Object.fromEntries(url.searchParams);
      suggested.push(asked);
      const spots = SPOTS(now);
      const which = asked.spot ? spots.findIndex(spot => spot.key === asked.spot) : -1;
      if (asked.spot && which < 0) {
        json(404, { code: 'SPOT_UNKNOWN', message: 'no spot of that key in the list' });
        return;
      }
      const point = which >= 0 ? spots[which] : { latitude: Number(asked.latitude), longitude: Number(asked.longitude) };
      const at = which >= 0 ? which : spots.findIndex(spot => metres(spot, point) <= REACH_M);
      const from_ms = which >= 0 ? Math.floor(spots[which].last_ms / DAY_MS) * DAY_MS + 12 * HOUR_MS + 20 * 60_000
        : Number(asked.from_ms);
      if ((asked.q ?? '').length > 100) {
        json(422, { code: 'QUERY_BAD', message: 'q is at most 100 characters' });
        return;
      }
      json(200, namesFor(at, at < 0 ? [] : SUGGESTIONS(from_ms, at), asked.q));
      return;
    }
    const photo = PHOTO_ROUTE.exec(path);
    if (photo && (PICTURES.has(photo[1]) || FILMS.has(photo[1]))) {
      const hex = photo[1];
      photosAsked.push(hex);
      const waited = held.get(hex);
      if (waited) response.once('close', () => { if (!response.writableEnded) photosLeft.push(hex); });
      await waited?.promise;
      if (failing.has(hex)) {
        response.socket?.destroy();
        return;
      }
      const facts = PHOTO_FACTS.get(hex);
      json(facts ? 200 : 404, facts ? { position: position ?? '0', photo: facts }
        : { code: 'PHOTO_UNKNOWN', message: `no photo names sha256:${hex}` });
      return;
    }
    if (path === '/v1/people/photos' && url.searchParams.get('id') === 'person:person-b') {
      const from = Number(url.searchParams.get('at') || 0);
      const limit = Number(url.searchParams.get('limit') || PHOTOS_PAGE);
      json(200, { position: position ?? '0', photos: PERSON_B_PHOTOS.slice(from, from + limit), total: PERSON_B_PHOTOS.length });
      return;
    }
    if (path === '/v1/places/photos') {
      const from = Number(url.searchParams.get('after') || url.searchParams.get('at') || 0);
      const answer = photosPage(url.searchParams.get('slug') ?? '', from, Number(url.searchParams.get('limit') || PHOTOS_PAGE));
      json(answer ? 200 : 404, answer ?? { code: 'PLACE_UNKNOWN', message: 'no such place' });
      return;
    }
    const blob = /^\/v1\/blobs\/sha256:([0-9a-f]{64})$/u.exec(path);
    const film = blob ? FILMS.get(blob[1]) : undefined;
    if (blob && film) {
      if (unreached.has(blob[1])) return void response.socket?.destroy();
      answerFile(film, String(request.headers.range ?? ''), response);
      return;
    }
    const pictured = blob ? PICTURES.get(blob[1]) : undefined;
    if (pictured) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(pictured);
      return;
    }
    const asking = PICTURE_ROUTE.exec(path);
    if (asking) {
      const hex = asking[1];
      picturesAsked.push(hex);
      const waited = heldPictures.get(hex);
      if (waited) {
        response.once('close', () => { if (!response.writableEnded) picturesLeft.push(hex); });
        await waited.promise;
        if (response.destroyed) return;
      }
      if (later.has(hex)) {
        response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '1' });
        response.end(JSON.stringify({ code: 'NOT_NOW', message: 'The picture could not be made now.' }));
        return;
      }
      await answerPicture(hex, url, request, response, async () => PICTURES.get(hex) ?? POSTERS.get(hex) ?? FILMS.get(hex)
        ?? doorBytes(door.url, hex, authorization));
      return;
    }
    if (path === '/v1/owner/act' && request.method === 'POST') {
      const action = JSON.parse(Buffer.concat(body).toString('utf8'));
      if (!(await atDoor(action, authorization))) return act(action, response);
    }
    /** @type {Record<string, string>} */
    const headers = {};
    for (const name of ['authorization', 'content-type', 'if-none-match', 'last-event-id', 'range']) {
      if (request.headers[name]) headers[name] = String(request.headers[name]);
    }
    const target = path === '/v1/page/moment' ? await ownFocus(url, authorization) : request.url;
    const passed = await fetch(`${door.url}${target}`, {
      method: request.method, headers, body: body.length ? Buffer.concat(body) : undefined,
    }).catch(() => null);
    if (!passed) {
      response.writeHead(502).end();
      return;
    }
    /** @type {Record<string, string>} */
    const back = {};
    passed.headers.forEach((value, name) => {
      if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(name)) back[name] = value;
    });
    if (/^\/v1\/days\/\d{4}-\d{2}-\d{2}$/u.test(path) && passed.status === 200) {
      const [file, units] = await Promise.all([passed.json(), brokenUnits(authorization)]);
      const atoms = file.atoms.map((/** @type {any} */ atom) => ({ ...atom, unit: units.get(atom.unit) ?? atom.unit }));
      response.writeHead(200, back);
      response.end(JSON.stringify({ ...file, atoms }));
      return;
    }
    response.writeHead(passed.status, back);
    if (!passed.body) {
      response.end();
      return;
    }
    const stream = Readable.fromWeb(/** @type {import('node:stream/web').ReadableStream} */ (passed.body));
    response.on('close', () => stream.destroy());
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  }

  const server = createServer((request, response) => {
    answer(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  return {
    url: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`,
    ahead,
    now: clock,
    saved,
    acts,
    suggested,
    asked,
    photosAsked,
    photosLeft,
    /** @param {string} hash */
    holdPhoto(hash) {
      /** @type {() => void} */
      let release = () => undefined;
      const promise = new Promise(done => {
        release = () => done(undefined);
      });
      held.set(hash.slice('sha256:'.length), { promise, release });
    },
    /** @param {string} hash */
    letPhoto(hash) {
      const hex = hash.slice('sha256:'.length);
      held.get(hex)?.release();
      held.delete(hex);
    },
    /**
     * @param {string} hash
     * @param {boolean} on
     */
    failPhoto(hash, on) {
      const hex = hash.slice('sha256:'.length);
      if (on) failing.add(hex);
      else failing.delete(hex);
    },
    /**
     * @param {string} hash
     * @param {boolean} on
     */
    failFile(hash, on) {
      const hex = hash.slice('sha256:'.length);
      if (on) unreached.add(hex);
      else unreached.delete(hex);
    },
    /**
     * @param {string} hash
     * @param {boolean} on
     */
    posterLater(hash, on) {
      const hex = hash.slice('sha256:'.length);
      if (on) later.add(hex);
      else later.delete(hex);
    },
    picturesAsked,
    picturesLeft,
    /** @param {string} hash */
    holdPicture(hash) {
      /** @type {() => void} */
      let release = () => undefined;
      const promise = new Promise(done => {
        release = () => done(undefined);
      });
      heldPictures.set(hash.slice('sha256:'.length), { promise, release });
    },
    /** @param {string} hash */
    letPicture(hash) {
      const hex = hash.slice('sha256:'.length);
      heldPictures.get(hex)?.release();
      heldPictures.delete(hex);
    },
    get unchanged() {
      return unchanged;
    },
    /** @param {number} count */
    stated(count) {
      if (saved.length >= count) return Promise.resolve();
      return new Promise((done, fail) => {
        const timer = setTimeout(() => fail(new Error(`no ${count}th save reached the home in 30 s`)), 30_000);
        waiting.push({ count, done: () => {
          clearTimeout(timer);
          done(undefined);
        } });
      });
    },
    /** @param {string} words */
    refuse(words) {
      refusing = words;
    },
    /** @param {{ latitude: number, longitude: number }} centre */
    hide(centre) {
      const key = `hidden-elsewhere-${landings + 1}`;
      hidden.push(hiddenAt(key, centre, stamp(), SPOTS(now).find(each => metres(each, centre) <= REACH_M)?.days ?? 0));
      landed();
      return key;
    },
    /**
     * @param {string} slug
     * @param {number} count
     */
    photograph(slug, count) {
      photographed.set(slug, (photographed.get(slug) ?? 0) + count);
      told('places', 'places');
    },
    /** @param {string} slug */
    replaceOldest(slug) {
      const found = /** @type {any} */ (fixtures.find(each => each.slug === slug));
      const all = photosOf(found);
      const picture = /** @type {string} */ (PICTURE_KEYS.find(key => key !== all[all.length - 1].image));
      replaced.set(slug, picture);
      told('places', 'places');
      return picture;
    },
    /**
     * @param {{ latitude: number, longitude: number }} centre
     * @param {number} days
     */
    stayed(centre, days) {
      found.push(spotOf(now, [centre.latitude, centre.longitude, days],
        { witnessed: `You were here on ${days} days in 2026.`, last: null, photos: 0 }, [], false));
      told('places', 'places');
    },
    tell() {
      told('places', 'places');
    },
    /** @param {'answered' | 'no key' | 'refused' | 'unreachable'} state */
    googleSays(state) {
      google = state;
    },
    /** @param {string} slug */
    ask(slug) {
      const at = fixtures.findIndex(each => each.slug === slug);
      const { home: _home, ...rest } = fixtures[at];
      fixtures[at] = { ...rest, ask_home: 'You’ve slept here 3 nights, since Monday.' };
      told('places', 'places');
    },
    forbid() {
      forbidding = true;
    },
    lose() {
      losing = true;
    },
    stall() {
      stalling = true;
    },
    async unstall() {
      const send = stalled;
      stalled = null;
      await send?.();
    },
    /** @param {Record<string, any>} places */
    elsewhere(places) {
      for (const [slug, fields] of Object.entries(places)) placed(slug, fields);
      landed();
    },
    /** @param {Record<string, any>} places */
    unheard(places) {
      for (const [slug, fields] of Object.entries(places)) placed(slug, fields);
    },
    hold() {
      holding = true;
    },
    release() {
      holding = false;
      counting.clear();
      wakeSettled();
      told('places', 'places');
    },
    heldSettled: () => heldSettled.size,
    bound: wakeSettled,
    countedUnheard() {
      holding = false;
      counting.clear();
      wakeSettled();
    },
    /** @param {'unheld' | 'held' | null} kind */
    refuseList(kind) {
      listRefusal = kind;
      if (kind) reset();
    },
    /** @param {boolean} on */
    pagesFromFixtures(on) {
      fromFixtures = on;
      fixtureActed = false;
    },
    /** @param {boolean} on */
    preparing(on) {
      preparing = on;
      if (on) reset();
      else told('places', 'places');
    },
    async close() {
      server.closeAllConnections();
      await new Promise(done => server.close(() => done(undefined)));
    },
  };
}
