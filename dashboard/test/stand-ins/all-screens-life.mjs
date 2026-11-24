// @ts-check
import { readFileSync } from 'node:fs';

const fixture = (/** @type {string} */ name) => JSON.parse(readFileSync(new URL(`../../../packages/families/test/day-page/${name}`, import.meta.url), 'utf8'));
const pageOf = (/** @type {string} */ name) => JSON.parse(readFileSync(new URL(`../../../homelink/Tests/Fixtures/pages/day.${name}.json`, import.meta.url), 'utf8'));
const PAGES = [pageOf('side'), pageOf('groups'), pageOf('placeless'), pageOf('nothing')];
const [EVERY, DENSE, PLACELESS, NOTHING] = PAGES.map(page => page.day);
const TRIP_IDS = ['38.72,-9.14 Lisbon', '41.15,-8.61 Porto', '40.42,-3.70 Madrid', '48.86,2.35 Paris'];

/** @param {any} shared */
export async function daysScreens({ bases, FULL_DAY, day, home }) {
  const list = await (await fetch(`${bases.full}/api/page/days?limit=1024`)).json();
  const rows = (/** @type {any} */ page) => page.all_day.length + page.plans.length + (page.also?.rows.length ?? 0)
    + page.chapters.reduce((/** @type {number} */ sum, /** @type {any} */ chapter) => sum + chapter.blocks.reduce((/** @type {number} */ held, /** @type {any} */ block) => held + block.rows.length, 0), 0);
  const days = [...PAGES.map(page => ({ day: page.day, counts: { total: rows(page), families: [] } })), ...list.days].sort((a, b) => a.day.localeCompare(b.day));
  const base = [{ url: 'api/page/days(\\?|$)', json: { ...list, days } }, ...PAGES.map(page => ({ url: `api/page/day\\?day=${page.day}`, json: page }))];
  const kinds = fixture(`${EVERY}.episodes.json`).episodes;
  const firstOf = new Map();
  for (const episode of kinds) if (!firstOf.has(episode.kind)) firstOf.set(episode.kind, episode);
  const K = /** @type {Record<string, string>} */ ({ sleep: 'sleep', stay: 'a stay', other: 'other', move: 'a move', listening: 'listening', conversation: 'a conversation', sitting: 'a sitting at the Mac', ai: 'an AI conversation',
    event: 'a calendar event', browsing: 'browsing', search: 'a web search', call: 'a call', dictation: 'a dictation', note: 'a note', phone: 'phone use', photos: 'photos', mail_sent: 'a mail sent', mail_received: 'a mail received',
    voice_note: 'a voice note', workout: 'a workout', check_in: 'a check-in', payment: 'a payment' });
  const D = (/** @type {string} */ name, /** @type {string} */ title, /** @type {string} */ hash, more = {}) => ({ section: 'Days', name, title, hash, stub: base, ...more });
  const on = (/** @type {string} */ when, focus = '') => `#view=days&on=${when}${focus ? `&focus=${focus}` : ''}`;
  const openAll = `for (const stay of [...document.querySelectorAll('[data-d-stay]')]) { stay.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, altKey: true })); break; } await S.sleep(1000);`;
  const openStay = (/** @type {number} */ at) => `const stays = [...document.querySelectorAll('[data-d-stay]')]; stays[${at}].click(); await S.sleep(900);`;
  const atoms = day.atoms;
  const full = await (await fetch(`${bases.full}/api/page/day?day=${FULL_DAY}`)).json();
  const fullRows = full.chapters.flatMap((/** @type {any} */ chapter) => chapter.blocks.flatMap((/** @type {any} */ block) => block.rows));
  const episodeOf = (/** @type {string} */ kind) => full.chapters.find((/** @type {any} */ chapter) => chapter.kind === kind && chapter.episode)?.episode ?? '';
  const rowOf = (/** @type {string} */ kind) => fullRows.find((/** @type {any} */ row) => row.kind === kind)?.key ?? '';
  const moment = `await S.until('.ck-inspector__body'); await S.sleep(1000);`;
  const inViewer = `await S.click('[data-d-photo]'); await S.until('.ck-viewer__bar'); await S.sleep(800); await S.awake();`;
  const clock = Date.UTC(2026, 9, 17, 14, 0);
  return [
    D('days-stay-open', 'Days, one stay opened', on(FULL_DAY), { run: openStay(2) }),
    D('days-all-open', 'Days, every stay opened (⌥-click)', on(FULL_DAY), { run: openAll }),
    D('days-picker', 'Days, month picker open', on(FULL_DAY), { run: `await S.click('[data-d-title]'); await S.sleep(500);` }),
    D('days-picker-year', 'Days, month picker on another month', on(EVERY), { run: `await S.click('[data-d-title]'); await S.sleep(500);` }),
    D('days-side-hover', 'Days, a place on the side lit', on(FULL_DAY), { run: `await S.hover('[data-d-unit]');` }),
    D('days-moment-stay', 'Days, moment: a stay over the day’s map', on(FULL_DAY, episodeOf('stay')), { run: moment }),
    D('days-moment-move', 'Days, moment: a move over the day’s map', on(FULL_DAY, episodeOf('move')), { run: moment }),
    D('days-moment-group', 'Days, moment: a group conversation', on(FULL_DAY, full.side.groups[0]?.rows[0] ?? ''), { run: moment }),
    D('days-moment-mail', 'Days, moment: a mail', on(FULL_DAY, rowOf('mail_received')), { run: moment }),
    D('days-moment-photos', 'Days, moment: photos with their strip', on(FULL_DAY, rowOf('photos')), { run: moment }),
    D('days-moment-source', 'Days, moment: its Source fold opened', on(FULL_DAY, rowOf('conversation')), { run: `${moment} await S.click('.ck-source__summary'); await S.sleep(500);` }),
    D('days-moment-reading', 'Days, moment: its day still loading', on(FULL_DAY, 'e1'), { stub: [{ url: 'api/page/moment\\?', hold: true }, ...base.slice(0, 1)], raw: true, run: `await S.sleep(2600);`, whole: false }),
    D('days-today', 'Days, today, with the now row', '#view=days', { now: clock, run: `(await S.until('.dy-row--now')).scrollIntoView({ block: 'center' }); await S.sleep(300);`, stub: [{ url: 'api/page/days(\\?|$)', json: { ...list, opening: FULL_DAY, days: [{ day: FULL_DAY, counts: { total: atoms.length, families: [] } }] } }] }),
    D('days-every', 'Days, a day holding every kind of moment', on(EVERY), { run: openAll }),
    D('days-every-folded', 'Days, the same day folded', on(EVERY)),
    D('days-dense', 'Days, a dense stay opened to its hours', on(DENSE), { run: `${openStay(0)} const hour = document.querySelector('[data-d-hour]'); if (hour) { hour.click(); await S.sleep(700); }` }),
    D('days-no-place', 'Days, a day with no place: the rail', on(PLACELESS)),
    D('days-empty', 'Days, nothing recorded this day', on(NOTHING)),
    D('days-before', 'Days, before Lifestream’s first day', on('2000-01-03')),
    D('days-not-written', 'Days, this day is not written yet', on('2026-10-18')),
    D('days-reading', 'Days, loading', on(FULL_DAY), { stub: [{ url: 'api/page/day\\?day=', hold: true }], raw: true, run: `await S.sleep(2600);`, whole: false }),
    D('days-failed', 'Days, the day could not be read', on(FULL_DAY), { stub: [{ url: 'api/page/day\\?day=', status: 503, json: { error: 'Lifestream is starting: it answers in a moment.' } }] }),
    D('days-narrow', 'Days, a narrower window: figures line and pills', on(FULL_DAY), { width: 1100 }),
    D('days-narrow-pill', 'Days, a narrower window: the People pill open', on(FULL_DAY), { width: 1100, run: `await S.click('[data-d-pill="people"]'); await S.sleep(600);` }),
    D('days-thin', 'Days, the synthetic home’s thin day', on(home.day), { base: 'home', stub: [] }),
    ...[...firstOf].filter(([kind]) => kind !== 'browsing' && kind !== 'mail_sent').map(([kind, episode]) => D(`moment-${kind.replaceAll('_', '-')}`, `Moment panel: ${K[kind] ?? kind}`, on(EVERY, kind === 'sleep' ? 'e54' : episode.id), { run: `await S.until('.ck-inspector__body, .ck-inspector'); await S.sleep(800);` })),
    { section: 'Photo viewer', name: 'viewer-photo', title: 'Photo viewer, a place’s photo with its facts', hash: '#view=places&focus=fixture-climbing-hall', base: 'home', run: `await S.click('.ck-photo[data-pl-photo="0"]'); await S.until('.ck-viewer__chip'); await S.sleep(800); await S.awake();` },
    { section: 'Photo viewer', name: 'viewer-info', title: 'Photo viewer, Info panel with map', hash: '#view=places&focus=fixture-climbing-hall', base: 'home', run: `await S.click('.ck-photo[data-pl-photo="0"]'); await S.until('.ck-viewer__chip'); await S.key('i'); await S.sleep(1500); if (!document.querySelector('.ck-viewer__rows')) { await S.press('Info'); await S.sleep(1200); }` },
    { section: 'Photo viewer', name: 'viewer-face', title: 'Photo viewer, a face pointed at', hash: '#view=places&focus=fixture-climbing-hall', base: 'home', run: `await S.click('.ck-photo[data-pl-photo="0"]'); await S.until('.ck-viewer__chip'); await S.awake(); const chip = document.querySelector('.ck-viewer__chip'); await S.hover(chip); await S.sleep(500);` },
    { section: 'Photo viewer', name: 'viewer-next', title: 'Photo viewer, stepped to the next photo', hash: '#view=places&focus=fixture-climbing-hall', base: 'home', run: `await S.click('.ck-photo[data-pl-photo="0"]'); await S.until('.ck-viewer__chip'); await S.key('ArrowRight'); await S.sleep(1000); await S.awake();` },
    { section: 'Photo viewer', name: 'viewer-day', title: 'Photo viewer, a day’s photo with no facts yet', hash: `#view=days&on=${FULL_DAY}`, run: inViewer },
    { section: 'Photo viewer', name: 'viewer-failed', title: 'Photo viewer, facts that could not be read', hash: '#view=places&focus=fixture-climbing-hall', base: 'home', stub: [{ url: 'api/life/photos', status: 503, json: { error: 'Lifestream is starting: it answers in a moment.' } }], run: `await S.click('.ck-photo[data-pl-photo="0"]'); await S.until('.ck-viewer__bar'); await S.key('i'); await S.sleep(1200); await S.awake();` },
    { section: 'Photo viewer', name: 'viewer-lost', title: 'Photo viewer, a picture that cannot be drawn', hash: `#view=days&on=${FULL_DAY}`, run: `${inViewer} for (const image of document.querySelectorAll('.ck-viewer img')) image.src = '/api/life/picture?hash=sha256:' + '0'.repeat(64) + '&size=large'; await S.until('.ck-viewer__failed:not([hidden])'); await S.sleep(500); await S.awake();` },
  ];
}

/** @param {any} shared */
export function placesScreens({ front }) {
  const L = (/** @type {string} */ name, /** @type {string} */ title, /** @type {string} */ hash, more = {}) => ({ section: 'Places', name, title, hash, base: /** @type {const} */ ('home'), ...more });
  const place = (/** @type {string} */ slug) => `#view=places&focus=${slug}`;
  const hall = place('fixture-climbing-hall');
  const edit = `await S.click('[data-pl-edit]'); await S.sleep(1200);`;
  const cameras = `await S.click('[data-pl-cameras]'); await S.until('.ck-dialog'); await S.sleep(800);`;
  const area = (/** @type {string} */ name, /** @type {string} */ id, /** @type {string} */ country, /** @type {number} */ nights) => ({ name, city_id: id, country, days: nights + 1, nights, guessed_days: 0, guessed_nights: 0 });
  const summary = (/** @type {any} */ more) => ({ period: '2026', from: '2026-01-01', to: '2026-12-31', places: [], cities: [], regions: [], countries: [], base: null, trips: [],
    coverage: { place: 0, moving: 0, city: 0, region: 0, country: 0, guessed: 0, unknown: 0, days_unknown: [], nights_unknown: [] }, ...more });
  const CITY = /** @type {Record<string, string>} */ ({ Lisbon: TRIP_IDS[0], Porto: TRIP_IDS[1], Madrid: TRIP_IDS[2], Paris: TRIP_IDS[3] });
  const year = summary({ cities: [area('Lisbon', CITY.Lisbon, 'Portugal', 290), area('Porto', CITY.Porto, 'Portugal', 12), area('Madrid', CITY.Madrid, 'Spain', 5), area('Paris', CITY.Paris, 'France', 3)],
    countries: [area('Portugal', '', 'Portugal', 302), area('Spain', '', 'Spain', 5), area('France', '', 'France', 3)], base: { city: 'Lisbon', city_id: CITY.Lisbon, nights: 290 },
    trips: [{ first: '2026-09-11', last: '2026-09-14', cities: ['Porto'], guessed: false }, { first: '2026-06-02', last: '2026-06-09', cities: ['Madrid', 'Paris'], guessed: false }, { first: '2026-03-20', last: '2026-03-21', cities: ['Porto'], guessed: true }] });
  const nights = ['11', '12', '13', '14'].map((day, at) => summary({ period: `2026-09-${day}`, from: `2026-09-${day}`, to: `2026-09-${day}`, cities: [area('Porto', CITY.Porto, 'Portugal', 1)],
    places: [{ slug: at % 2 ? 'fixture-river-cabin' : null, name: at % 2 ? 'River Cabin' : 'Ferry Terminal', hours: 7, days: 1 }] }));
  const trips = /** @type {any[]} */ ([{ url: 'api/life/where\\?.*grain=year', json: { summaries: [year] } }, { url: 'api/life/where\\?.*grain=day', json: { summaries: nights } }]);
  const failing = /** @type {any[]} */ ([{ url: 'api/life/places$', status: 503, json: { error: 'Lifestream is starting: it answers in a moment.' } }]);
  return [
    L('places-search', 'Places, the list searched', '#view=places', { run: `await S.type('[data-pl-find]', 'river');` }),
    L('places-search-none', 'Places, a search finding nothing', '#view=places', { run: `await S.type('[data-pl-find]', 'zzqq');` }),
    L('places-once', 'Places, Visited once opened', '#view=places', { run: `await S.click('[data-pl-once]');` }),
    L('places-row-hover', 'Places, a row lit with its point on the map', '#view=places', { run: `await S.hover('.ck-lrow[data-pl-open]');` }),
    L('places-map-data', 'Places, Map data credit opened', '#view=places', { run: `await S.click('.pp-credit summary'); await S.sleep(300);` }),
    L('places-reading', 'Places, loading', '#view=places', { stub: [{ url: 'api/life/places$', hold: true }], raw: true, run: `await S.sleep(2600);`, whole: false }),
    L('places-failed', 'Places, could not be read', '#view=places', { stub: failing }),
    L('places-empty', 'Places, nothing yet (no phone paired)', '#view=places', { base: 'onboarding', arm: () => {}, stub: [{ url: 'api/life/places$', json: { position: '0:0', places: [], spots: [], hidden: [], here: null, cameras: { yours: 0, others: 0 } } }] }),
    L('place-edit', 'Place, Edit in its card with its circle', hall, { run: edit }),
    L('place-edit-renamed', 'Place, Edit with the name changed', hall, { run: `${edit} const field = document.querySelector('form[data-pl-form="edit"] input[name=name]'); await S.type('form[data-pl-form="edit"] input[name=name]', 'The Big Wall');` }),
    L('place-edit-two-circles', 'Place, Edit with a circle added', hall, { run: `${edit} await S.click('[data-pl-add-circle]'); await S.sleep(900);` }),
    L('place-edit-remove', 'Place, Edit: Remove asks first', hall, { run: `${edit} await S.click('[data-pl-remove]'); await S.sleep(600);` }),
    L('place-edit-refused', 'Place, Edit refused by the home', hall, { arm: () => front?.refuse?.('Lifestream is starting up. Try again in a moment.'), disarm: () => front?.refuse?.(''), run: `${edit} await S.type('form[data-pl-form="edit"] input[name=name]', 'The Big Wall'); await S.key('s', { metaKey: true }); await S.sleep(900);` }),
    L('place-visits', 'Place, all its visits', hall, { run: `await S.click('[data-pl-visits]'); await S.sleep(700);` }),
    L('place-scrolled', 'Place, its card scrolled to the people and visits', hall, { run: `await S.scroll('.pl-card__body, .pl-card', 900);` }),
    L('place-photos-failed', 'Place, its photos could not be read', hall, { stub: [{ url: 'api/life/place/photos|api/life/places/photos|life/.*photos\\?', status: 503, json: { error: 'Lifestream is starting: it answers in a moment.' } }] }),
    L('place-reading', 'Place, loading', hall, { stub: [{ url: 'api/life/places\\?slug=', hold: true }], raw: true, run: `await S.sleep(2600);`, whole: false }),
    L('place-failed', 'Place, could not be read', hall, { stub: [{ url: 'api/life/places\\?slug=', status: 503, json: { error: 'Lifestream is starting: it answers in a moment.' } }] }),
    L('place-gone', 'Place, a place the home no longer holds', place('fixture-gone')),
    L('cameras', 'Cameras dialog', '#view=places', { run: cameras }),
    L('cameras-ask-why', 'Cameras dialog, asking why a camera is not theirs', '#view=places', { run: `${cameras} await S.click('[data-pl-ask-why]'); await S.sleep(600);` }),
    L('cameras-why-picked', 'Cameras dialog, a reason chosen', '#view=places', { run: `${cameras} await S.click('[data-pl-ask-why]'); await S.sleep(300); await S.click('[data-pl-why]'); await S.sleep(500);` }),
    L('cameras-when', 'Cameras dialog, since when', '#view=places', { run: `${cameras} await S.click('[data-pl-ask-why]'); await S.sleep(300); const whys = document.querySelectorAll('[data-pl-why]'); whys[whys.length - 1].click(); await S.sleep(400); const when = document.querySelector('[data-pl-when]'); if (when) { when.click(); await S.sleep(400); }` }),
    L('cameras-failed', 'Cameras dialog, could not be read', '#view=places', { stub: [{ url: 'api/life/devices', status: 503, json: { error: 'Lifestream is starting: it answers in a moment.' } }], run: cameras }),
    L('naming-reach', 'Naming, circle made larger', '#view=places&focus=name', { run: `await S.until('.pl-name input'); await S.click('[data-pl-reach="1"]'); await S.sleep(800);` }),
    L('naming-names-failed', 'Naming, suggested names could not be read', '#view=places&focus=name', { stub: [{ url: 'api/life/places/suggest', status: 503, json: { error: 'Lifestream is starting: it answers in a moment.' } }] }),
    L('trips-list', 'Trips, a year with trips', '#view=places&seg=trips', { stub: trips }),
    L('trips-year', 'Trips, a year with none (the year before)', '#view=places&seg=trips&on=2025'),
    L('trip-detail', 'Trip detail', '#view=places&seg=trips', { stub: trips, run: `await S.click('.ck-crow[data-pl-open^="trip:"]'); await S.sleep(1500);` }),
    L('trips-reading', 'Trips, loading', '#view=places&seg=trips', { stub: [{ url: 'api/life/where', hold: true }, { url: 'api/life/atlas', hold: true }], raw: true, run: `await S.sleep(2600);`, whole: false }),
    L('trips-failed', 'Trips, could not be read', '#view=places&seg=trips', { stub: [{ url: 'api/life/where', status: 503, json: { error: 'Lifestream is starting: it answers in a moment.' } }] }),
    L('hidden-one-open', 'Hidden spots, unhidden with undo', '#view=places&focus=hidden', { run: `await S.click('[data-pl-unhide]'); await S.sleep(600);` }),
    L('naming-google-picked', 'Naming, a name taken with undo offered', '#view=places&focus=name', { run: `await S.until('.pl-name input'); await S.click('[data-pl-take="0"]'); await S.sleep(900);` }),
  ];
}

/** @param {any} shared */
export function searchScreens({ FULL_DAY }) {
  const S = (/** @type {string} */ name, /** @type {string} */ title, /** @type {string} */ hash, more = {}) => ({ section: 'Search', name, title, hash, ...more });
  const recent = { 'lifestream.search.recent': JSON.stringify(['river walk', 'Person D', 'climbing hall', 'invoice october', 'Porto']) };
  void FULL_DAY;
  return [
    S('search-empty', 'Search, nothing typed and no recent searches', '#view=search'),
    S('search-recent', 'Search, recent searches', '#view=search', { storage: recent }),
    S('search-family-pill', 'Search, the family pill open', '#view=search&q=synthetic', { base: 'home', run: `const pill = document.querySelector('[data-search-menu="family"] .ck-fmenu__btn, .ck-fmenu__btn[data-search-menu="family"]'); if (pill.disabled) throw new Error('family pill waits'); pill.click(); await S.sleep(400); if (!document.querySelector('[data-search-menu="family"] [aria-expanded="true"]')) throw new Error('family pill stayed shut');` }),
    S('search-time-pill', 'Search, the time pill open', '#view=search&q=synthetic', { base: 'home', run: `const plain = window.fetch; window.fetch = async (...asked) => { const answer = await plain(...asked); if (!String(asked[0].url ?? asked[0]).includes('search?')) return answer; const read = await answer.clone().json(); read.record.spread.months = { ...read.record.spread.months, '2025-03': 3, '2024-05': 5 }; return new Response(JSON.stringify(read), { status: 200, headers: { 'content-type': 'application/json' } }); }; location.hash = '#view=search&q=river'; await S.sleep(1500); const pill = document.querySelector('[data-search-menu="time"] .ck-fmenu__btn, .ck-fmenu__btn[data-search-menu="time"]'); if (pill.disabled) throw new Error('time pill waits'); pill.click(); await S.sleep(400); if (!document.querySelector('[data-search-menu="time"] [aria-expanded="true"]')) throw new Error('time pill stayed shut');` }),
    S('search-filtered', 'Search, a family chosen', '#view=search&q=synthetic', { base: 'home', run: `const chips = [...document.querySelectorAll('[data-search-chips] .ck-fchip')]; if (chips[1]) chips[1].click(); else throw new Error('skip: one family'); await S.sleep(900);` }),
    S('search-top', 'Search, Top hits: people and places by name', '#view=search&q=river', { base: 'home', run: `await S.sleep(300);` }),
    S('search-scrolled', 'Search, the results scrolled under its head', '#view=search&q=river', { base: 'home', run: `await S.sleep(300); await S.scroll('.sx .ck-page__scroll', 200);` }),
    S('search-moment', 'Search, a hit open in the moment panel', '#view=search&q=river', { run: `await S.click('[data-search-line]'); await S.until('.ck-inspector, .ck-inspector__body'); await S.sleep(1000);` }),
    S('search-none', 'Search, no results', '#view=search&q=zzqqxx'),
    S('search-reading', 'Search, loading', '#view=search&q=river', { stub: [{ url: 'api/page/search', hold: true }], raw: true, run: `await S.sleep(2600);`, whole: false }),
    S('search-failed', 'Search, could not be read', '#view=search&q=river', { stub: [{ url: 'api/page/search(\\?|$)', status: 500, json: { error: 'Search could not be read.' } }] }),
    S('search-building', 'Search, the index still building', '#view=search&q=river', { stub: [{ url: 'api/page/search(\\?|$)', status: 200, json: { position: '1:0', today: '2026-11-14', top: [], kinds: [], total: { n: 0, partial: false }, held: null, reading: { state: 'building', line: 'Search is getting ready: 42% read', percent: 42 }, nothing: null } }] }),
  ];
}
