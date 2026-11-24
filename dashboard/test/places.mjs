import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { drawn, HILL, HILL_AT, placesSuite, WATCH_POLICY } from './stand-ins/places-page.mjs';

/** @param {string} selector */
const sizesOf = selector => `[...document.querySelectorAll(${JSON.stringify(selector)})].map(img => {
  const address = new URL(img.getAttribute('data-src'), location.href);
  return address.pathname === '/api/life/picture' && /^sha256:[0-9a-f]{64}$/u.test(address.searchParams.get('hash') ?? '')
    ? address.searchParams.get('size') : img.getAttribute('data-src');
})`;
const WATCH_PICTURES = `(() => {
  document.addEventListener('transitionrun', event => {
    if (event.target instanceof HTMLImageElement && event.propertyName === 'opacity') event.target.fades = (event.target.fades ?? 0) + 1;
  }, true);
  const real = window.fetch;
  let release = () => undefined;
  const held = new Promise(done => { release = () => done(undefined); });
  window.letPhotos = () => { release(); window.fetch = real; };
  window.fetch = (input, init) => String(input).includes('life/places/photos') ? held.then(() => real(input, init)) : real(input, init);
})()`;
/**
 * @param {string} selector
 * @param {string} mark
 */
const markAll = (selector, mark) => `[...document.querySelectorAll(${JSON.stringify(selector)})].map(img => { img[${JSON.stringify(mark)}] = true; return img.getAttribute('data-src'); })`;

const KEEPER = `(async () => {
  const root = document.querySelector('.pl-page').closest('[data-pictures]');
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const box = () => root.appendChild(document.createElement('div'));
  const loaded = img => img.complete && img.naturalWidth ? Promise.resolve()
    : new Promise(done => { img.addEventListener('load', done, { once: true }); img.addEventListener('error', done, { once: true }); });
  const one = box();
  const other = one.appendChild(document.createElement('img'));
  other.src = PNG + '#other';
  await loaded(other);
  const foreign = { loaded: other.classList.contains('is-loaded'), opacity: getComputedStyle(other).opacity };
  one.innerHTML = '<img src="' + PNG + '#other">';
  await Promise.resolve();
  foreign.kept = one.firstElementChild === other;
  const away = Object.assign(new Image(), { className: 'ck-pic', src: PNG + '#away' });
  await loaded(away);
  const two = box();
  two.append(away);
  await Promise.resolve();
  const three = box();
  three.innerHTML = '<img class="ck-pic" data-src="' + PNG + '#twice">';
  const twice = three.firstElementChild;
  await loaded(twice);
  twice.remove();
  three.append(twice);
  twice.remove();
  three.insertAdjacentHTML('beforeend', ('<img class="ck-pic" data-src="' + PNG + '#twice">').repeat(2));
  await Promise.resolve();
  const drawn = [...three.querySelectorAll('img')];
  const said = { foreign, away: away.classList.contains('is-loaded'),
    twice: { drawn: drawn.length, kept: drawn.filter(img => img === twice).length } };
  for (const each of [one, two, three]) each.remove();
  return said;
})()`;

const MOTION = { features: [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'no-preference' }] };

const suite = placesSuite({ file: 'places' });
/** @type {Awaited<ReturnType<typeof suite.journey>>['home']} */
let home;
/** @type {Awaited<ReturnType<typeof suite.journey>>['front']} */
let front;
/** @type {Awaited<ReturnType<typeof suite.journey>>['chrome']} */
let chrome;

before(() => suite.open());

after(() => suite.close());

describe('places-page: the list, a place and a visit', () => {

  before(async () => {
    ({ home, front, chrome } = await suite.journey('places-page'));
  });

  const { seen, asked, shot, click, words, times, unplaced, settled, rows, openPlace, pageSays, askedNoHostButLoopbackAndTiles } = suite;

  test('the list over a map with no tiles: the person\'s layer on the land, the places whole under their cities', async () => {
    await chrome.load('#view=places', WATCH_POLICY);
    await chrome.until('document.querySelector(".pl-group") && !document.querySelector(".pl.ck-reading")');
    await settled('stage', 11, 'list');
    assert.equal(await chrome.evaluate('document.querySelector("[data-map=stage]").dataset.failed ?? ""'), '');
    assert.deepEqual(await rows('.pl-card .ck-views__opt'), ['Places14', 'Cities4', 'Trips']);
    assert.match(await words('.pl-invite'), /3 places to name.*About 1 minute/u);
    const heads = await rows('.pl-group .ck-section__open');
    assert.deepEqual(heads, ['Lisbon, 9 places', 'Porto, 2 places', 'Sintra, 1 place', 'Elsewhere, 2 places'], 'Elsewhere last');
    const lisbon = '.pl-group:has([data-pl-city="Lisbon"])';
    assert.deepEqual((await rows(`${lisbon} .ck-lrow[data-pl-open]`)).map(row => row.split(',')[0]),
      ['River Flat', 'Hill Studio', 'Corner Cafe', 'Climbing Hall', 'Roof Terrace', 'Old Office']);
    assert.deepEqual(await rows(`${lisbon} .ck-lrow[data-pl-once]`), ['Visited once, 3']);
    assert.equal(times('page/places'), 1);
    assert.deepEqual(front.asked.filter(path => path === '/v1/page/places'), ['/v1/page/places']);
    assert.deepEqual(await rows('.pl-card [data-pl-open="fixture-river-flat"]'), ['River Flat, you are here, Here now · 2h 30m today']);
    assert.deepEqual(await chrome.evaluate(`(() => {
      const row = document.querySelector('.pl-card [data-pl-open="fixture-river-flat"]');
      const [name, line] = ['.ck-lrow__words', '.ck-lrow__meta'].map(part => getComputedStyle(row.querySelector(part)));
      return [getComputedStyle(row).backgroundColor, name.fontSize + '/' + name.fontWeight, line.fontSize + '/' + line.lineHeight];
    })()`), ['rgba(0, 0, 0, 0)', '13px/500', '12px/16px']);
    assert.deepEqual(unplaced(), []);
    await shot('list', `${drawn('stage')} === '11'`);
    await chrome.evaluate(`document.querySelector('[data-pl-open="fixture-hill-studio"]')
    .dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))`);
    assert.equal(await chrome.evaluate('document.querySelector("[data-map=stage]").dataset.hot'), 'fixture-hill-studio');
    await chrome.evaluate(`document.querySelector('[data-pl-open="fixture-hill-studio"]')
    .dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: null }))`);
    assert.equal(await chrome.evaluate('document.querySelector("[data-map=stage]").dataset.hot ?? ""'), '');
    await click('[data-pl-once="Lisbon"]');
    assert.deepEqual((await rows(`${lisbon} .pl-once .ck-lrow`)).map(row => row.split(',')[0]),
      ['Noodle Bar', 'Salt Gallery', 'Ferry Dock']);
    await shot('list-visited-once', `document.querySelectorAll('${lisbon} .pl-once .ck-lrow').length === 3`);
  });

  test('Cities zooms out to every city, and a city opens as the card with the map on it', async () => {
    await chrome.type('.pl-card [data-pl-find]', 'Cafe');
    await chrome.until('document.querySelector(".pl-card .ck-section__label")?.textContent === "1 found"');
    await click('[data-pl-seg="cities"]');
    assert.equal(await chrome.evaluate('document.querySelector(".pl-card [data-pl-find]").value'), '');
    await settled('stage', 3, 'cities');
    assert.equal(await chrome.evaluate('document.querySelector("[data-map=stage]").dataset.gathered'), '0');
    const cities = await rows('.pl-card .ck-lrow[data-pl-city]');
    assert.deepEqual(cities.map(row => row.split(',')[0]), ['Lisbon', 'Porto', 'Sintra', 'Elsewhere']);
    assert.match(cities[0], /^Lisbon, you are here, 9 places · Here now$/u);
    await shot('cities', `${drawn('stage')} === '3'`);
    await click('.pl-card [data-pl-city="Porto"]');
    await settled('stage', 3, 'city');
    assert.equal(await words('.pl-card__title'), 'Porto');
    assert.match(await words('.pl-card__line'), /^2 places · since \d{4}$/u);
    assert.equal(await words('.pl-card__back'), 'Cities');
    assert.deepEqual((await rows('.pl-card__scroll .ck-lrow')).map(row => row.split(',')[0]), ['River Cabin', 'Visited once']);
    assert.equal(await chrome.evaluate('document.querySelectorAll(".pl-card .ck-views").length'), 0);
    await shot('city', `${drawn('stage')} === '3'`);
    await click('.pl-card__back');
    await settled('stage', 3, 'cities again');
    await click('[data-pl-seg=""]');
    await settled('stage', 11, 'list again');
    await click('.pl-group .ck-section__open[data-pl-city="Sintra"]');
    await chrome.until('document.querySelector(".pl-card__title")?.textContent === "Sintra"');
    await settled('stage', 1, 'city from its heading');
  });

  test('a place opens in the card over its map: one read, its rhythm, its photos, people and visits; back returns', async () => {
    await click('.pl-card__back');
    await click('[data-pl-seg=""]');
    await settled('stage', 11, 'list before a place');
    await chrome.evaluate('window.stageCanvas = document.querySelector("[data-map=stage] canvas")');
    const scrolledTo = await chrome.evaluate(`(() => { const list = document.querySelector('[data-part=list]');
    list.scrollTop = 120; return list.scrollTop; })()`);
    await chrome.evaluate(WATCH_PICTURES);
    await chrome.send('Emulation.setEmulatedMedia', MOTION);
    await openPlace('fixture-climbing-hall');
    assert.equal(await chrome.evaluate('document.querySelectorAll(".pl-card [data-pl-find], .pl-card .ck-views").length'), 0);
    assert.equal(await chrome.evaluate('document.querySelector("[data-part=bar]").hidden'), true);
    assert.equal(await chrome.evaluate('document.querySelectorAll(".pp-side, .pp-bars, .ck-cells, .pp-figure").length'), 0);
    await chrome.until('document.querySelector("[data-map=stage]").dataset.framed === "fixture-climbing-hall"'
      + ` && ${drawn('stage')} !== undefined`);
    seen.drawn.place = await chrome.evaluate(drawn('stage'));
    assert.ok(Number(seen.drawn.place) >= 1, `the map drew ${seen.drawn.place} on the place`);
    assert.ok(await chrome.evaluate('document.querySelector("[data-map=stage] canvas") === window.stageCanvas'));
    const page = await pageSays();
    seen.pages.regular = page;
    assert.equal(times('page/place?slug=fixture-climbing-hall'), 1);
    assert.equal(page.title, 'Climbing Hall');
    assert.equal(page.line, 'Lisbon');
    assert.match(page.rhythm, /^30 days here since [A-Z][a-z]{2} \d{4} · usually Tue and Thu evenings$/u);
    assert.equal(page.ask, null);
    assert.deepEqual(page.labels, ['Photos', 'People here', 'Visits 30']);
    assert.equal(page.visits.length, 6);
    assert.match(page.visits[0], /^(?:Tuesday|Thursday|\d+ [A-Z][a-z]{2}(?: \d{4})?), \d\d:\d\d–\d\d:\d\d, 2h 20m, with Person B$/u);
    assert.match(page.visits[2], /, with Person B, Person A$/u);
    assert.deepEqual(await chrome.evaluate('[...document.querySelectorAll(".pl-visits > .pl-visit")].slice(0, 3)'
      + '.map(row => row.querySelectorAll(".ck-fstack .ck-mono").length)'), [1, 0, 2]);
    assert.deepEqual(page.people.map(each => each.replace(/\d+/u, 'n')), ['Person B, n days', 'Person A, n days']);
    await chrome.until('[...document.querySelectorAll(".pl-page .ck-face__photo")].every(image => image.classList.contains("is-loaded"))');
    assert.deepEqual(await chrome.evaluate('[...document.querySelectorAll(".pl-page .ck-pchip")]'
      + '.map(chip => !!chip.querySelector(".ck-face__photo"))'), [true, false]);
    assert.ok(await chrome.evaluate('!!document.querySelector(".pl-visits .ck-fstack .ck-face__photo")'));
    assert.equal(await chrome.evaluate('document.querySelectorAll(".pl-page .is-failed").length'), 0);
    const standing = await chrome.evaluate(markAll('.pl-page img', 'first'));
    assert.ok(standing.length >= 6, `the place stood with ${standing.length} pictures`);
    assert.equal(await chrome.evaluate('document.querySelectorAll(".pl-page .ck-photo__img").length'), 4,
      'the first photos are the page\'s own, drawn before any photo page is read');
    await chrome.evaluate('window.letPhotos()');
    await chrome.until('[...document.querySelectorAll(".pl-page img")].every(img => img.classList.contains("is-loaded"))');
    assert.equal(await chrome.evaluate('[...document.querySelectorAll(".pl-page img")].filter(img => img.first).length'), standing.length);
    await chrome.until('[...document.querySelectorAll(".pl-page img")].some(img => img.fades === 1)');
    const faded = await chrome.evaluate('[...document.querySelectorAll(".pl-page img")].map(img => img.fades ?? 0)');
    assert.ok(faded.every((/** @type {number} */ each) => each <= 1) && faded.some((/** @type {number} */ each) => each === 1),
      JSON.stringify(faded));
    seen.pages.faded = faded;
    const sizes = await chrome.evaluate(sizesOf('.pl-page img'));
    assert.deepEqual([...new Set(sizes)], ['tile'], JSON.stringify(sizes));
    assert.equal(sizes.length, standing.length);
    assert.equal(await chrome.evaluate('document.querySelectorAll(".pl-page img:not(.ck-pic)").length'), 0);
    assert.deepEqual(await chrome.evaluate(KEEPER), { foreign: { loaded: false, opacity: '1', kept: false }, away: true,
      twice: { drawn: 2, kept: 1 } });
    await shot('place-regular', `${drawn('stage')} !== undefined`);
    await click('[data-pl-visits]');
    assert.equal(await chrome.evaluate('document.querySelectorAll(".pl-visits > .pl-visit").length'), 30);
    const grid = () => chrome.evaluate('[...document.querySelectorAll(".pl-page .ck-photo")].map(photo => photo.dataset.plPhoto ?? "reading")');
    const page1 = 'life/places/photos?slug=fixture-climbing-hall&at=0&limit=12';
    const page2 = 'life/places/photos?slug=fixture-climbing-hall&at=12&limit=12';
    await chrome.until('document.querySelectorAll(".pl-page .ck-photo__img").length === 4');
    assert.deepEqual(await grid(), ['0', '1', '2', '3']);
    assert.equal(await words('.pl-photos-all'), 'View all 18 photos');
    assert.equal(await chrome.evaluate('document.querySelector(".pl-page .ck-pager")'), null);
    assert.equal(times(page1), 1);
    assert.equal(times(page2), 0);
    await click('.pl-photos-all');
    await chrome.until('document.querySelector(".ck-viewer__count")?.textContent.trim() === "1 of 18"');
    for (let at = 2; at <= 12; at += 1) {
      await chrome.key('ArrowRight');
      await chrome.until(`document.querySelector(".ck-viewer__count")?.textContent.trim() === "${at} of 18"`);
    }
    await chrome.until('document.querySelector(".ck-viewer__stage img.is-loaded")');
    assert.deepEqual(await chrome.evaluate(sizesOf('.ck-viewer__stage img')), ['screen']);
    await chrome.until('document.querySelector(".ck-viewer__title")?.textContent === "Sunday 12 October 2025 · 01:10"');
    await chrome.key('ArrowRight');
    await chrome.until('document.querySelector(".ck-viewer__count")?.textContent.trim() === "13 of 18"'
      + ' && document.querySelector(".ck-viewer__stage img.is-loaded")');
    assert.equal(times(page2), 1);
    await click('[data-ck-viewer="close"]');
    await chrome.until('!document.querySelector(".ck-viewer")');
    await chrome.until('document.querySelectorAll(".pl-page .ck-photo__img").length === 4');
    assert.deepEqual(await grid(), ['0', '1', '2', '3'], 'the grid keeps the page\'s first photos');
    assert.ok(await chrome.evaluate('document.activeElement?.classList.contains("pl-photos-all")'));
    assert.equal(times(page2), 1);
    await click('.pl-card__back');
    await chrome.until('document.querySelector(".pl-card__title")?.textContent === "Places"');
    assert.equal(await chrome.evaluate('document.querySelector("[data-part=list]").scrollTop'), scrolledTo);
    await settled('stage', 11, 'list after a place');
    assert.ok(await chrome.evaluate('document.querySelector("[data-map=stage] canvas") === window.stageCanvas'));
  });

  test('a place visited once, a home, and a place inside another: the same page, said as each is', async () => {
    await chrome.evaluate('document.querySelector("[data-part=list]").scrollTop = 0');
    if (!await chrome.evaluate('document.querySelector(".pl-once .ck-lrow")')) await click('[data-pl-once="Lisbon"]');
    await openPlace('fixture-noodle-bar');
    const once = await pageSays();
    seen.pages.once = once;
    assert.equal(once.rhythm, null);
    assert.match(once.line, /^Lisbon · [A-Z][a-z]{2} \d+ [A-Z][a-z]{2}$/u);
    assert.deepEqual(once.labels, ['Photos', 'People here', 'Visit']);
    assert.equal(once.visits.length, 1);
    assert.deepEqual(once.people, ['Person B']);
    await shot('place-once', '!document.querySelector(".pl.ck-reading")');
    await click('.pl-card__back');
    await openPlace('fixture-river-flat');
    const flat = await pageSays();
    seen.pages.home = flat;
    assert.match(flat.rhythm, /^Home · 210 nights since \d{4}$/u);
    assert.equal(flat.line, 'Lisbon · Here now');
    assert.match(flat.visits[0], /^Today, since \d\d:\d\d, .* so far$/u);
    assert.deepEqual(flat.inside.map(row => row.split(',')[0]), ['Roof Terrace']);
    await click('.pl-page [data-pl-open="fixture-roof-terrace"]');
    await chrome.until('document.querySelector(".pl-card__title")?.textContent === "Roof Terrace"'
      + ' && !document.querySelector(".pl.ck-reading")');
    assert.match((await pageSays()).line, /· Part of River Flat$/u);
    assert.equal(await words('.pl-card__back'), 'River Flat');
    await click('.pl-card__back');
    await chrome.until('document.querySelector(".pl-card__title")?.textContent === "River Flat"'
      + ' && !document.querySelector(".pl.ck-reading")');
    assert.equal(await words('.pl-card__back'), 'Places');
    await click('.pl-card__back');
    await chrome.until('document.querySelector(".pl-card__title")?.textContent === "Places"');
  });

  test('the home changes the photos: the page shown is read again, counted anew, a replaced photo drawn as it is now', async () => {
    await chrome.evaluate('document.querySelector("[data-part=list]").scrollTop = 0');
    await chrome.send('Emulation.setEmulatedMedia', MOTION);
    await openPlace('fixture-climbing-hall');
    await chrome.until('document.querySelectorAll(".pl-page .ck-photo__img").length === 4');
    const shown = () => chrome.evaluate('[...document.querySelectorAll(".pl-page .ck-photo__img")].map(img => img.getAttribute("data-src"))');
    const newest = await shown();
    await chrome.until('[...document.querySelectorAll(".pl-page img")].every(img => img.classList.contains("is-loaded"))');
    const stood = await chrome.evaluate(markAll('.pl-page img', 'stood'));
    front.photograph('fixture-climbing-hall', 2);
    await chrome.until('document.querySelector(".pl-page .ck-section__label")?.textContent.replace(/\\s+/gu, " ")'
      + '.trim() === "Photos" && document.querySelector(".pl-photos-all")?.textContent.trim() === "View all 20 photos"'
      + ' && document.querySelectorAll(".pl-page .ck-photo__img").length === 4');
    assert.deepEqual((await shown()).slice(2), newest.slice(0, 2));
    const still = await chrome.evaluate(`(() => {
      const before = ${JSON.stringify(stood)};
      const after = Map.groupBy([...document.querySelectorAll(".pl-page img")], img => img.getAttribute("data-src"));
      return [...after].filter(([src]) => before.includes(src)).map(([src, imgs]) => ({ src,
        kept: imgs.filter(img => img.stood === true).length,
        owed: Math.min(imgs.length, before.filter(each => each === src).length) }));
    })()`);
    assert.ok(still.length >= 1 && still.reduce((/** @type {number} */ sum, /** @type {any} */ each) => sum + each.kept, 0) >= 2
      && still.every((/** @type {any} */ each) => each.kept === each.owed), JSON.stringify(still));
    await chrome.until('[...document.querySelectorAll(".pl-page img")].every(img => img.classList.contains("is-loaded"))');
    const fades = await chrome.evaluate('[...document.querySelectorAll(".pl-page img")].map(img => img.fades ?? 0)');
    assert.ok(fades.every((/** @type {number} */ each) => each <= 1), JSON.stringify(fades));
    seen.pages.fades = fades;
    seen.pages.fresh = await pageSays();
    const page2 = 'life/places/photos?slug=fixture-climbing-hall&at=12&limit=12';
    await click('.pl-photos-all');
    for (let at = 2; at <= 20; at += 1) {
      await chrome.key('ArrowRight');
      await chrome.until(`document.querySelector(".ck-viewer__count")?.textContent.trim() === "${at} of 20"`);
    }
    await chrome.until('document.querySelector(".ck-viewer__stage img.is-loaded")');
    const before = await chrome.evaluate('document.querySelector(".ck-viewer__stage img").getAttribute("data-src")');
    await click('[data-ck-viewer="close"]');
    const askedBefore = await chrome.evaluate(`performance.getEntriesByType('resource').filter(entry => entry.name.includes(${JSON.stringify(page2)})).length`);
    const picture = front.replaceOldest('fixture-climbing-hall');
    await chrome.until(`performance.getEntriesByType('resource').filter(entry => entry.name.includes(${JSON.stringify(page2)})).length > ${askedBefore}`);
    await click('.pl-photos-all');
    for (let at = 2; at <= 20; at += 1) {
      await chrome.key('ArrowRight');
      await chrome.until(`document.querySelector(".ck-viewer__count")?.textContent.trim() === "${at} of 20"`);
    }
    await chrome.until(`document.querySelector(".ck-viewer__stage img")?.getAttribute("data-src").includes(${JSON.stringify(picture)})`);
    assert.ok(!before.includes(picture), before);
    await click('[data-ck-viewer="close"]');
    await chrome.theme('dark');
    await click('.pl-card__back');
    await chrome.until('document.querySelector(".pl-card__title")?.textContent === "Places"');
  });

  async function openVisit(/** @type {number} */ index) {
    await chrome.evaluate(`document.querySelectorAll('.pl-visits > .pl-visit')[${index}].click()`);
    await chrome.until('document.querySelector(".ck-panel.is-open .ck-inspector__title")'
      + ' && !document.querySelector(".ck-panel.ck-reading, .ck-panel .ck-reading")');
  }

  test('a visit opens its day at its stay, each of two one unit holds its own', async () => {
    await click('[data-pl-once="Elsewhere"]');
    await openPlace('home');
    const keys = await chrome.evaluate('[...document.querySelectorAll(".pl-visits > .pl-visit")].map(row => row.dataset.plVisit)');
    assert.equal(keys.length, 2);
    assert.equal(keys[0].split('@')[0], keys[1].split('@')[0], 'the two visits do not share a unit');
    const starts = (await rows('.pl-visits > .pl-visit')).map(row => /(\d\d:\d\d)–/u.exec(row)?.[1]);
    /** @type {string[]} */
    const opened = [];
    for (const index of [1, 0]) {
      await openVisit(index);
      assert.equal(await chrome.evaluate('document.querySelectorAll(".ck-panel .ck-panel__none, .ck-panel .ck-in-place").length'), 0);
      opened.push(await words('.ck-panel .ck-inspector__head'));
      assert.ok(opened.at(-1)?.includes(String(starts[index])), `visit ${index} (${starts[index]}) opened ${opened.at(-1)}`);
    }
    seen.pages.visits = opened;
    assert.ok(asked.some(address => new URL(address).pathname === '/api/page/moment' && new URL(address).searchParams.get('day') === home.day),
      `the panel never read ${home.day}`);
    assert.ok(unplaced().length > 0 && unplaced().every(path => path.includes('unit=') || path.includes('point=')), unplaced().join(' '));
    seen.pages.visit = await words('.ck-panel .ck-inspector__head');
    await shot('place-visit', '!document.querySelector(".pl.ck-reading")');
    await click('.ck-panel [data-panel-open-day]');
    await chrome.until(`location.hash.includes('view=days') && location.hash.includes('on=${home.day}')`);
    assert.match(await chrome.evaluate('location.hash'), /focus=/u);
    /** @type {import('../public/pages.js').Day} */
    const day = await chrome.evaluate(`fetch('api/page/day?day=${home.day}').then(answer => answer.json())`);
    const photos = [...day.all_day, ...day.chapters.flatMap(chapter => chapter.blocks.flatMap(block => block.rows)), ...day.also?.rows ?? []]
      .find(row => row.kind === 'photos');
    assert.ok(photos, 'the day holds its photos');
    await chrome.evaluate(`location.hash = ${JSON.stringify(`#${new URLSearchParams({ view: 'days', on: home.day, focus: photos.key })}`)}`);
    const large = '.ck-panel .ck-gallery__stage img';
    const settled = `document.querySelector('${large}.is-loaded, .ck-panel .ck-gallery__stage.is-failed')`;
    await chrome.until(settled);
    assert.deepEqual(await chrome.evaluate(sizesOf(large)), ['screen']);
    assert.deepEqual(await chrome.evaluate(sizesOf('.ck-panel .ck-gallery__strip img')), ['tile', 'tile']);
    await shot('day-photos', settled);
  });

  test('the page asked no host but loopback and the tile host, and threw nothing', () => askedNoHostButLoopbackAndTiles());
});

describe('places-naming: Is this home? and naming one place at a time', () => {

  before(async () => {
    ({ front, chrome } = await suite.journey('places-naming'));
  });

  const { seen, asked, shot, click, words, count, unplaced, rows, openPlace, pageSays, statedSince, onCard, askedNoHostButLoopbackAndTiles } = suite;

  test('Is this home? while the home asks: Yes states the place again with home, and the question goes', async () => {
    await chrome.load('#view=places', WATCH_POLICY);
    await chrome.until('document.querySelector(".pl-group") && !document.querySelector(".pl.ck-reading")');
    await openPlace('fixture-hill-studio');
    const asking = await pageSays();
    seen.pages.asking = asking;
    assert.match(String(asking.ask), /^Is this home\? You’ve slept here 3 nights, since [A-Z][a-z]+\. Yes, it’s home No$/u);
    await shot('place-home', '!document.querySelector(".pl.ck-reading")');
    await click('[data-pl-home="true"]');
    await chrome.until('!document.querySelector(".pl-ask")');
    await chrome.until('document.querySelector(".pl-note")?.textContent.startsWith("Saved")');
    const saved = front.saved.find(entry => entry.key === 'fixture-hill-studio');
    assert.ok(saved, 'no save of Hill Studio reached the home');
    assert.deepEqual(saved.place, { name: 'Hill Studio', latitude: 38.7165, longitude: -9.141, radius_m: 80, also: [], ids: [], home: true });
    await click('.pl-card__back');
    assert.deepEqual(unplaced(), []);
  });

  const nameRowsNow = () => chrome.evaluate(`[...document.querySelectorAll('.pl-card .ck-namerow')].map(row =>
  (row.classList.contains('is-lit') ? '* ' : '') + row.querySelector('.ck-namerow__name').textContent)`);

  const SPOT_1 = 'spot:38.7189,-9.1466';

  async function undoKey() {
    for (const type of ['rawKeyDown', 'keyUp']) {
      await chrome.send('Input.dispatchKeyEvent', { type, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 4 });
    }
  }

  /** @param {string[]} names */
  const rowsRead = names => chrome.until(`JSON.stringify([...document.querySelectorAll('.pl-card .ck-namerow')].map(row =>
  (row.classList.contains('is-lit') ? '* ' : '') + row.querySelector('.ck-namerow__name').textContent))
  === ${JSON.stringify(JSON.stringify(names))}`);

  const dayReads = () => asked.filter(address => /\/api\/page\/(?:day|moment)\?/u.test(address)).length;

  const DAYS_WARMED = `document.querySelector('.main__section--days .dy-day > :is(.dy-list, .ck-none, .dy-state)')
    && !document.querySelector('.main__section--days .dy.ck-reading')`;

  test('naming one place at a time: the card speaks for its spot, its field first, an own place one pick, ⌘Z, Google', async () => {
    await chrome.load('#view=places', WATCH_POLICY);
    await chrome.until('document.querySelector(".pl-invite") && !document.querySelector(".pl.ck-reading")');
    await chrome.until(DAYS_WARMED);
    const before = front.saved.length;
    const days = dayReads();
    front.googleSays('no key');
    await click('.pl-invite [data-pl-open="name"]');
    await onCard('1 of 3');
    assert.equal(await chrome.evaluate('document.querySelector("[data-pl-save-name]").disabled'), true);
    assert.ok(await chrome.evaluate(`document.querySelector('[data-pl-hide]').getBoundingClientRect().right
      < document.querySelector('[data-pl-skip]').getBoundingClientRect().left`), 'Hide precedes Skip in the footer');
    assert.equal(await words('.pl-naming__key'), 'Names from Google Places come once Lifestream holds a key · Add key');
    assert.equal(await chrome.evaluate('document.querySelector(".pl-naming__key a").getAttribute("href")'), '#dialog=google-places');
    front.googleSays('answered');
    await chrome.until(`document.querySelector("[data-map=stage]").dataset.framed === "${SPOT_1}"`);
    assert.ok(await chrome.evaluate(`(() => {
    const card = document.querySelector('.pl-naming');
    const parts = ['.ck-photos', '.pl-seen', '.pl-name .ck-namefield', '[data-pl-rows]'].map(part => card.querySelector(part));
    return parts.every(Boolean) && parts.every((part, at) => at === 0
      || Boolean(parts[at - 1].compareDocumentPosition(part) & Node.DOCUMENT_POSITION_FOLLOWING));
  })()`), 'the card is not photos, line, field, rows');
    assert.equal(await count('.pl-naming .ck-photo'), 3);
    assert.equal(await words('.pl-seen__line'), '4 days · 4 stays');
    assert.match(await words('.pl-seen__last'), /^Last time \S/u);
    assert.equal(await count('.pl-seen .mac-mono-data'), 1);
    assert.deepEqual(await nameRowsNow(), ['* Lantern Noodle Bar', 'Harbour Ramen', 'Lantern Park']);
    assert.deepEqual(await rows('.pl-card .ck-namerow__line'), ['Calendar · 12:30', 'WhatsApp · 11:40', 'Google · 90 m']);
    assert.deepEqual(await chrome.evaluate(`import('/ui/kit/icon.js').then(({ icon }) => [...document
    .querySelectorAll('.pl-card .ck-namerow__lead')].map(lead => ['calendar-event', 'message', 'place'].find(meaning => {
      const drawn = document.createElement('span');
      drawn.innerHTML = icon(meaning);
      return drawn.innerHTML === lead.innerHTML;
    }) ?? null))`), ['calendar-event', 'message', 'place']);
    assert.equal(await words('.pl-name .ck-namecredit'), 'Google');
    assert.deepEqual(front.suggested.filter(query => query.spot === SPOT_1), [{ spot: SPOT_1, q: '' }]);
    assert.equal(dayReads(), days, 'the card reads no day page and no moment');
    seen.pages.naming = { rows: await nameRowsNow(), seen: await words('.pl-seen'), asked: front.suggested.at(-1) };
    await shot('naming', '!document.querySelector(".pl-card .ck-namerow--reading")');
    for (const letter of ['L', 'a', 'n']) await chrome.press(letter);
    assert.equal(await chrome.evaluate('document.querySelector(".pl-name input").value'), 'Lan');
    await rowsRead(['Lantern Noodle Bar', 'Lantern Park', 'Lantern Steps Cafe']);
    assert.equal(await count('.pl-naming__key'), 0);
    assert.deepEqual(await rows('.pl-card .ck-namerow__line'), ['Calendar · 12:30', 'Google · 90 m', 'Google · 300 m']);
    const typedAsks = front.suggested.filter(query => query.spot === SPOT_1 && query.q).map(query => query.q);
    assert.equal(typedAsks.at(-1), 'Lan');
    assert.ok(!typedAsks.includes('L'), typedAsks.join(' '));
    await chrome.key('ArrowRight');
    assert.equal(await words('.pl-naming__count'), '1 of 3');
    await chrome.key('ArrowDown');
    await chrome.key('ArrowUp');
    assert.deepEqual(await nameRowsNow(), ['* Lantern Noodle Bar', 'Lantern Park', 'Lantern Steps Cafe']);
    await chrome.key('Escape');
    assert.equal(await chrome.evaluate('document.querySelector(".pl-name input").value'), '');
    assert.deepEqual(await nameRowsNow(), ['* Lantern Noodle Bar', 'Harbour Ramen', 'Lantern Park']);
    await chrome.type('.pl-name input', 'Hill');
    await rowsRead(['Hill Studio', 'Hillside Bakery']);
    assert.match((await rows('.pl-card .ck-namerow__line'))[0], /^Your place · \d+ m$/u);
    await chrome.key('ArrowDown');
    assert.deepEqual(await nameRowsNow(), ['* Hill Studio', 'Hillside Bakery']);
    front.stall();
    await chrome.press('Enter');
    await onCard('2 of 3');
    if (await count('[data-pl-spot-home="false"]')) await click('[data-pl-spot-home="false"]');
    await front.stated(before + 1);
    const spot1 = { latitude: 38.7189, longitude: -9.1466, radius_m: 80 };
    const spot2 = { latitude: 38.712, longitude: -9.129, radius_m: 80 };
    const hill = (/** @type {object[]} */ also) => ({ name: 'Hill Studio', ...HILL_AT, radius_m: 80, also, ids: [], home: true });
    const [first] = statedSince(before);
    assert.deepEqual([first.key, first.place], [HILL, hill([spot1])]);

    assert.deepEqual(await nameRowsNow(), ['* Kiln Coffee', 'Mira’s', 'Quay Apartments']);
    await chrome.key('ArrowDown');
    await click('[data-pl-save-name]');
    await onCard('3 of 3');
    await front.stated(before + 2);
    const miras = statedSince(before)[1];
    assert.equal(miras.kind, 'create');
    assert.match(miras.key, /^mira-s-[0-9a-f]{6}$/u, 'the home minted the new place\'s id');
    assert.deepEqual(miras.place, { name: 'Mira’s', ...spot2, also: [], ids: ['google:fixture-mira-s'], home: false },
      'the place and its answer to Is this home? one act');
    await front.unstall();
    await chrome.until(`performance.getEntriesByType('resource').filter(entry => entry.name.endsWith('/api/owner/act')).length >= 2`);
    await undoKey();
    await onCard('2 of 3');
    await front.stated(before + 3);
    assert.deepEqual(statedSince(before)[2], { kind: 'remove', key: miras.key });
    await chrome.until('document.querySelector(".pl-card .pl-ask")');
    await chrome.until(`fetch('/api/life/places').then(answer => answer.json()).then(answer =>
    JSON.stringify(answer.places.find(place => place.slug === ${JSON.stringify(HILL)}).also) === ${JSON.stringify(JSON.stringify(
        [{ latitude: 38.7189, longitude: -9.1466, radius_m: 80 }]))} && !answer.spots.some(spot => spot.key === ${JSON.stringify(SPOT_1)}))`);
    await click('[data-pl-spot-home="false"]');
    await chrome.type('.pl-name input', 'hill  studio');
    await chrome.until('[...document.querySelectorAll(".pl-card .ck-namerow__name")].some(name => name.textContent === "Hill Studio")');
    assert.ok((await nameRowsNow()).every(row => !row.startsWith('* ')), 'a row is lit while words are typed');
    await chrome.press('Enter');
    await onCard('3 of 3');
    await front.stated(before + 4);
    assert.deepEqual([statedSince(before)[3].key, statedSince(before)[3].place], [HILL, hill([spot1, spot2])]);
    await undoKey();
    await onCard('2 of 3');
    await front.stated(before + 5);
    assert.deepEqual([statedSince(before)[4].key, statedSince(before)[4].place], [HILL, hill([spot1])]);
    await chrome.key('ArrowRight');
    await onCard('3 of 3');
    assert.equal(statedSince(before).length, 5);

    await chrome.until('document.querySelector(".pl-card .pl-ask")');
    await click('[data-pl-spot-home="false"]');
    await chrome.until('document.querySelector(".pl-name .ck-namecredit")');
    assert.equal(await words('.pl-name .ck-namecredit'), 'Google');
    await chrome.type('.pl-name input', 'zq');
    await chrome.until('document.querySelectorAll(".pl-card .ck-namerow").length === 0'
      + ' && !document.querySelector(".pl-name .ck-namecredit")');
    assert.equal(await count('.pl-naming__key'), 0);
    front.googleSays('no key');
    await chrome.type('.pl-name input', 'Tile');
    await chrome.until('document.querySelector(".pl-naming__key")?.textContent === "Names from Google Places come once Lifestream holds a key · Add key"');
    await rowsRead(['Tile Market', 'Tile Works Cafe']);
    assert.equal(await words('.pl-name .ck-namecredit'), 'Google');
    seen.pages.typed = { rows: await nameRowsNow(), lines: await rows('.pl-card .ck-namerow__line'), key: await words('.pl-naming__key') };
    await shot('naming-typed', 'document.querySelectorAll(".pl-card .ck-namerow").length === 2');
    front.googleSays('answered');
    await chrome.key('Escape');
    await click('[data-pl-hide]');
    await chrome.until('document.querySelector(".pl-finish")');
    await front.stated(before + 6);
    const hid = statedSince(before)[5];
    assert.equal(hid.kind, 'hide');
    assert.match(hid.key, /^hidden-[0-9a-f]{6}$/u);
    assert.deepEqual([hid.latitude, hid.longitude], [41.1495, -8.6108]);
    assert.equal(await words('.pl-finish__title'), '1 place named');
    assert.equal(await words('.pl-finish__line'), 'In under a minute · Lisbon');
    assert.deepEqual(await rows('.pl-finish .ck-lrow__words'), ['Hill Studio']);
    await chrome.until('document.querySelector("[data-map=stage]").dataset.lit === "1"');
    await shot('naming-finish', 'document.querySelector("[data-map=stage]").dataset.lit === "1"');
    await chrome.press('Enter');
    await chrome.until('document.querySelector(".pl-card__title")?.textContent === "Places"');
    await chrome.until('document.querySelector(".pl-invite")');
    assert.match(await words('.pl-invite'), /^1 place to name/u);
    assert.deepEqual(await rows('.pl-card__foot .ck-lrow[data-pl-open="hidden"]'), ['Hidden, 2']);
  });

  const REFUSED = 'Lifestream is starting up. Try again in a moment.';

  /** @returns {Promise<void>} */
  const watchEmpty = () => chrome.evaluate(`(() => {
  window.empties = [];
  new MutationObserver(() => {
    const empty = [...document.querySelectorAll('.pl-card .ck-none')].find(none => !none.closest('.pl-part'));
    if (empty) window.empties.push(empty.textContent);
  }).observe(document.querySelector('[data-part=list]'), { childList: true, subtree: true });
})()`);

  test('Hidden spots, a spot hidden elsewhere, Is this home? on a spot, refusals, Unhide, and a spot\'s own card', async () => {
    const before = front.saved.length;
    const spot2 = { latitude: 38.712, longitude: -9.129 };
    assert.match(await words('.pl-invite'), /^1 place to name/u);
    const elsewhere = front.hide(spot2);
    await chrome.until('!document.querySelector(".pl-invite")'
      + ' && document.querySelector(".pl-card__foot [data-pl-open=hidden]")?.getAttribute("aria-label") === "Hidden, 3"');
    await click('[data-pl-open="hidden"]');
    await chrome.until('document.querySelectorAll(".pl-hidden__spot").length === 3');
    assert.equal(await words('.pl-card__title'), 'Hidden spots 3');
    assert.deepEqual((await rows('.pl-hidden__words')).map(line => line.replace(/\d+ m/u, 'n m')),
      ['2 days · n m from River Flat', '3 days · n m from Tile Market', '4 days · n m from Corner Cafe'], 'newest hidden first');
    assert.deepEqual(await rows('.pl-hidden__title'), ['Unnamed spot', 'Unnamed spot', 'Unnamed spot']);
    for (const when of await rows('.pl-hidden__when')) assert.match(when, /^Hidden \d+ [A-Z][a-z]{2}$/u);
    seen.pages.hidden = await rows('.pl-hidden__spot');
    await shot('hidden', 'document.querySelectorAll(".pl-hidden__spot").length === 3');
    await click(`[data-pl-unhide="${elsewhere}"]`);
    await chrome.until('document.querySelectorAll(".pl-hidden__spot").length === 2');
    await front.stated(before + 1);
    assert.deepEqual(statedSince(before), [{ kind: 'unhide', key: elsewhere }]);
    await click('.pl-card__back');
    await chrome.until('document.querySelector(".pl-invite")');
    assert.match(await words('.pl-invite'), /^1 place to name/u);

    await click('.pl-invite [data-pl-open="name"]');
    await onCard('1 of 1');
    assert.equal(await words('.pl-ask .ck-question__line'), 'You’ve slept here 3 nights, since Monday.');
    assert.deepEqual(await rows('.pl-ask .ck-btn'), ['Yes, it’s home', 'No']);
    assert.equal(await count('.pl-name, [data-pl-save-name]'), 0, 'the home question stands alone');
    await click('[data-pl-spot-home="true"]');
    front.refuse(REFUSED);
    await click('[data-pl-hide]');
    await chrome.until(`document.querySelector('.pl-naming .ck-in-place .mac-body')?.textContent === ${JSON.stringify(`Not saved. ${REFUSED}`)}`);
    assert.equal(await words('.pl-naming__count'), '1 of 1');
    assert.ok(await chrome.evaluate('location.hash.includes("focus=name") && !!document.querySelector(".pl-card .pl-name")'));
    assert.equal(statedSince(before).length, 1);
    assert.equal(await chrome.evaluate('document.querySelector(".pl-name input").value'), 'Home');
    await chrome.until('document.querySelector(".pl-name input")?.value === "Home"');
    assert.equal(await chrome.evaluate('document.querySelectorAll(".pl-card .pl-ask").length'), 0);
    assert.equal(statedSince(before).length, 1);
    await chrome.press('Enter');
    await chrome.until('document.querySelector(".pl-finish")');
    await front.stated(before + 2);
    assert.deepEqual(statedSince(before + 1).map(entry => entry.place),
      [{ name: 'Home', ...spot2, radius_m: 80, also: [], ids: [], home: true }], 'the place and its home one act');
    await click('[data-pl-done]');
    await chrome.until('document.querySelector(".pl-card__title")?.textContent === "Places" && !document.querySelector(".pl-invite")');

    await click('[data-pl-open="hidden"]');
    await chrome.until('document.querySelectorAll(".pl-hidden__spot").length === 2');
    const key = await chrome.evaluate('document.querySelector(".pl-hidden__spot").dataset.plHidden');
    assert.notEqual(key, 'hidden-fixture');
    await click(`[data-pl-unhide="${key}"]`);
    await chrome.until('document.querySelectorAll(".pl-hidden__spot").length === 1');
    await front.stated(before + 3);
    assert.deepEqual(statedSince(before).at(-1), { kind: 'unhide', key });
    await click('.pl-card__back');
    await chrome.until('document.querySelector(".pl-invite")');
    assert.match(await words('.pl-invite'), /^1 place to name/u);
    assert.deepEqual(await rows('.pl-card__foot .ck-lrow[data-pl-open="hidden"]'), ['Hidden, 1']);

    await chrome.evaluate('location.hash = "#view=places&focus=spot:41.1495,-8.6108"');
    await chrome.until('document.querySelector(".pl-naming .pl-ask")');
    assert.equal(await chrome.evaluate('document.querySelectorAll(".pl-naming__count, [data-pl-skip]").length'), 0);
    await click('[data-pl-spot-home="false"]');
    assert.equal(await chrome.evaluate('document.querySelector(".pl-name input").value'), '');
    assert.equal(await chrome.evaluate('document.querySelectorAll(".pl-card .pl-ask").length'), 0);
    await chrome.type('.pl-name input', 'Tile Annex');
    await chrome.until('document.querySelector(".pl-name input").value === "Tile Annex"'
      + ' && document.querySelectorAll(".pl-card .ck-namerow").length === 0');
    await watchEmpty();
    front.refuse(REFUSED);
    await chrome.press('Enter');
    await chrome.until(`document.querySelector('.pl-naming .ck-in-place .mac-body')?.textContent === ${JSON.stringify(`Not saved. ${REFUSED}`)}`);
    assert.equal(await chrome.evaluate('document.querySelector(".pl-name input").value'), 'Tile Annex');
    assert.ok((await nameRowsNow()).every(row => !row.startsWith('* ')), 'a row is lit under a name typed');
    assert.deepEqual(await chrome.evaluate('window.empties'), []);
    assert.equal(statedSince(before).length, 3);
    await chrome.press('Enter');
    await chrome.until('document.querySelector(".pl-card__title")?.textContent === "Tile Annex"');
    assert.deepEqual(await chrome.evaluate('window.empties'), []);
    assert.deepEqual(statedSince(before).at(-1).place, { name: 'Tile Annex', latitude: 41.1495, longitude: -8.6108, radius_m: 80,
      also: [], ids: [], home: false });
    seen.pages.named = statedSince(0).filter(entry => entry.kind === 'hide' || !String(entry.key).startsWith('fixture-'));
  });

  test('a spot named that opens on anything but its name, its map and the skeleton where its counts go, a lost answer resent under '
    + 'another request, or another device\'s edit left undrawn until the places event', async () => {
    const before = front.saved.length;
    const sent = front.acts.length;
    const corner = { latitude: 38.7301, longitude: -9.1501 };
    front.stayed(corner, 2);
    front.hold();
    await chrome.evaluate(`location.hash = "#view=places&focus=spot:${corner.latitude},${corner.longitude}"`);
    await chrome.until('document.querySelector(".pl-naming .pl-name input")');
    await chrome.type('.pl-name input', 'Synthetic Corner');
    front.lose();
    await chrome.press('Enter');
    await chrome.until('document.querySelector(".pl-card__title")?.textContent === "Synthetic Corner"'
      + ' && document.querySelector(".pl-page .ck-counting")');
    assert.doesNotMatch(await words('.pl-card'), /placing|holds no such thing/u);
    const asked = front.acts.slice(sent);
    assert.deepEqual(asked.map(action => [action.of, action.kind, action.name]),
      [['places', 'create', 'Synthetic Corner'], ['places', 'create', 'Synthetic Corner']], 'the lost answer not asked again');
    assert.equal(asked[1].request, asked[0].request, 'the resend carried another request');
    assert.equal(front.saved.length, before + 1, 'the resend saved the place twice');
    const made = front.saved.at(-1);
    front.release();
    await chrome.until('document.querySelector(".pl-page") && !document.querySelector(".pl-page .ck-counting")');
    front.hold();
    front.elsewhere({ [made.key]: { name: 'Synthetic Corner Renamed' } });
    await chrome.until('document.querySelector(".pl-card__title")?.textContent === "Synthetic Corner Renamed"');
    front.release();
  });

  test('the page asked no host but loopback and the tile host, and threw nothing', () => askedNoHostButLoopbackAndTiles());
});

describe('places-fixtures: the home\'s own answers, drawn in its order', () => {

  /** @param {string} name */
  const fixture = name => JSON.parse(readFileSync(new URL(`../../homelink/Tests/Fixtures/pages/${name}.json`, import.meta.url), 'utf8'));
  /** @type {import('../public/pages.js').Places} */
  const PLACES = fixture('places.full');
  /** @type {import('../public/pages.js').Place} */
  const PLACE = fixture('place.full');
  /** @type {import('../public/pages.js').PlaceEdit} */
  const EDIT = fixture('placeEdit.slug');

  before(async () => {
    ({ front, chrome } = await suite.journey('places-fixtures'));
    front.pagesFromFixtures(true);
  });

  const { click, words, rows, openPlace, askedNoHostButLoopbackAndTiles } = suite;
  const slugsShown = () => chrome.evaluate('[...document.querySelectorAll(".pl-card__scroll .ck-lrow[data-pl-open]")]'
    + '.map(row => row.dataset.plOpen)');

  test('every city in the answer\'s order, Elsewhere last, each city\'s places in its order', async () => {
    await chrome.load('#view=places', WATCH_POLICY);
    await chrome.until('document.querySelector(".pl-group") && !document.querySelector(".pl.ck-reading")');
    const titles = (await rows('.pl-group .ck-section__open')).map(head => head.split(',')[0]);
    assert.deepEqual(titles, PLACES.cities.map(city => city.title));
    assert.equal(titles.at(-1), 'Elsewhere');
    assert.deepEqual(await slugsShown(), PLACES.cities.flatMap(city => city.places.map(row => row.slug)));
    assert.match(await words('.pl-invite'), new RegExp(`^${PLACES.to_name.length} places? to name`, 'u'));
  });

  test('a city\'s name finds its places, in the answer\'s order', async () => {
    const [city] = PLACES.cities;
    await chrome.type('.pl-card [data-pl-find]', city.title);
    await chrome.until(`document.querySelector(".pl-card .ck-section__label")?.textContent === "${city.places.length + city.once.length} found"`);
    assert.deepEqual(await slugsShown(), [...city.places, ...city.once].map(row => row.slug));
    await chrome.type('.pl-card [data-pl-find]', '');
    await chrome.until('document.querySelector(".pl-group")');
  });

  test('the drag counts held + takesIn, the place page\'s own count; a save reads the place settled and its count is said', async () => {
    assert.equal(EDIT.slug, 'cafe-0c0c0c');
    await openPlace(EDIT.slug);
    await click('[data-pl-edit]');
    const said = `Takes in ${PLACE.stays}\u00a0${PLACE.stays === 1 ? 'stay' : 'stays'}`;
    await chrome.until(`document.querySelector('.pl-edit [data-ck-circle-line="0"]')?.textContent === ${JSON.stringify(said)}`);
    const asks = front.asked.length;
    await click('.pl-edit [data-pl-circle="0"] [data-pl-reach="1"]');
    await click('.pl-edit__foot [type="submit"]');
    await chrome.until('!document.querySelector("form[data-pl-form=edit]")');
    await chrome.until(`document.querySelector(".pl-note")?.textContent === ${JSON.stringify(`Saved · ${said}`)}`);
    assert.ok(front.asked.slice(asks).includes(`/v1/page/place?slug=${EDIT.slug}&settled=1`), 'the place never read settled after its save');
    assert.equal(front.acts.at(-1).kind, 'edit');
  });

  test('the page asked no host but loopback and the tile host, and threw nothing', () => askedNoHostButLoopbackAndTiles());
});
