import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FIGURES_SHOWN, mapViewOf, PEOPLE_SHOWN } from '../public/ui/days/side.js';
import { pageHarness } from './stand-ins/page-harness.mjs';

/** @typedef {import('../public/pages.js').Day} Day */
/** @typedef {import('../public/pages.js').DaySide} DaySide */
/** @typedef {import('../public/pages.js').SidePlace} SidePlace */
/** @typedef {import('../public/pages.js').ContactRun} ContactRun */
/** @typedef {'side' | 'travel' | 'unnamed' | 'groups'} Scene */

const PAGES = new URL('../../homelink/Tests/Fixtures/pages/', import.meta.url);
/** @type {Record<Scene, Day>} */
const CASES = Object.fromEntries(/** @type {Scene[]} */ (['side', 'travel', 'unnamed', 'groups'])
  .map(name => [name, JSON.parse(readFileSync(new URL(`day.${name}.json`, PAGES), 'utf8'))]));
const SIDE = CASES.side.side;
const HARNESS = '/days-side-harness.html';
const MODULE = '/days-side-harness.js';
const DISC_LEAST_MS = 10 * 60_000;

/** @typedef {{ latitude: number, longitude: number }} Point */
/** @param {Point} point */
const pointKey = point => `${point.latitude},${point.longitude}`;
/** @param {string} name */
const placeNamed = name => /** @type {SidePlace} */ (SIDE.places.find(place => place.name === name));
/** @param {ContactRun[]} runs */
const runsOf = runs => runs.map(run => `${run.glyph} ${run.value}`).join(', ');
/** @param {SidePlace} place */
const lineOf = place => place.home ? 'Home' : place.line || null;
/** @param {DaySide} side */
const discsOf = side => side.places.filter(place => place.ms >= DISC_LEAST_MS).length;

/** @type {Scene} */
let scene = 'side';

const FRAME = '.ds-card [data-map="day-map"]';
/** @param {string} inside */
const frame = (inside = '') => `document.querySelector('${inside} [data-map="day-map"]')`;

/** @param {string} [inside] */
const units = (inside = '.ds') => opened.chrome.evaluate(`[...document.querySelectorAll('${inside} [data-d-unit]')].map(unit => ({
  key: unit.dataset.dUnit, open: unit.getAttribute('href'),
  name: unit.querySelector('.ck-punit__name').dataset.full ?? unit.querySelector('.ck-punit__name').textContent,
  time: unit.querySelector('.ck-punit__time').textContent.replace(/\\s+/gu, ' '),
  line: unit.querySelector('.ck-punit__line')?.textContent ?? null, rows: unit.dataset.dRows, label: unit.getAttribute('aria-label'),
  quiet: unit.closest('li').classList.contains('is-quiet') }))`);

/** @param {string} [inside] */
const people = (inside = '.ds') => opened.chrome.evaluate(`[...document.querySelectorAll('${inside} [data-d-who]')].map(row => ({
  key: row.dataset.dWho, name: row.querySelector('.ck-prow__name').textContent,
  runs: [...row.querySelectorAll('.ck-run')].map(run => run.dataset.glyph + ' ' + run.textContent.replace(/\\s+/gu, ' ')).join(', '),
  label: row.getAttribute('aria-label'), rows: row.dataset.dRows.split(' ').sort().join(' '),
  open: row.getAttribute('href') }))`);

/** @param {string} [inside] */
const groups = (inside = '.ds') => opened.chrome.evaluate(`[...document.querySelectorAll('${inside} [data-side-part="groups"] [data-d-group]')]
  .map(row => ({ name: row.querySelector('.ck-prow__name').textContent,
    runs: [...row.querySelectorAll('.ck-run')].map(run => run.dataset.glyph + ' ' + run.textContent.replace(/\\s+/gu, ' ')).join(', '),
    label: row.getAttribute('aria-label'), opens: row.dataset.dGroup, rows: row.dataset.dRows,
    quiet: row.closest('li').classList.contains('is-quiet') }))`);

const names = () => opened.chrome.evaluate(`(() => {
  const card = ${frame()}.getBoundingClientRect();
  return { width: card.width, height: card.height, boxes: [...${frame()}.querySelectorAll('.ck-map__name')].map(name => {
    const box = name.getBoundingClientRect();
    return { text: name.firstChild?.nodeType === Node.TEXT_NODE ? name.firstChild.textContent : '',
      spent: (name.querySelector('.ck-map__spent')?.textContent ?? '').replace(/\\s+/gu, ' '), x: box.x - card.x, y: box.y - card.y, w: box.width, h: box.height };
  }) };
})()`);

/** @param {Awaited<ReturnType<typeof names>>} set */
function apart(set) {
  for (const [index, one] of set.boxes.entries()) {
    assert.ok(one.x >= 0 && one.y >= 0 && one.x + one.w <= set.width && one.y + one.h <= set.height, `${one.text} inside the card`);
    for (const other of set.boxes.slice(index + 1)) {
      const meets = one.x < other.x + other.w && other.x < one.x + one.w && one.y < other.y + other.h && other.y < one.y + one.h;
      assert.ok(!meets, `${one.text} and ${other.text} apart`);
    }
  }
}

const HARNESS_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="dark light">
<link rel="stylesheet" href="/cockpit.css"><link rel="stylesheet" href="/kit.css"><link rel="stylesheet" href="/days-side.css">
<style>/* The side as the page stands it: the stage's width at 1440, as tall as the window; never under 836 px, so a short window scrolls under a wheel. */
.stage { position: relative; display: flex; gap: 40px; padding: 32px; }
/* The moment's sheet as the page lays it over the stage: hidden until open. */
.dy-panel { position: absolute; top: 32px; right: 32px; width: 560px; height: 480px; display: none; background: var(--canvas); }
.dy-panel.is-open { display: block; } .stage__list { flex: 1; } .stage__side { flex: none; width: 560px; height: max(836px, calc(100vh - 64px)); }
@media (max-width: 999px) { .stage { display: block; padding: 16px 24px; } .stage__list { display: none; } .stage__side { width: auto; } }</style>
</head><body><main class="stage" id="stage"><div class="stage__list"></div><aside class="stage__side" id="side"></aside><section class="dy-panel"></section></main>
<script type="module" src="${MODULE}"></script></body></html>`;

const HARNESS_JS = `
import { fetchPage } from '/lib/api.js';
import { setIcons } from '/ui/kit/icon.js';
import { fitWithin } from '/ui/days/fit.js';
import { daySide, daySideReading, installDaySide, sidePills, sidePillsReading } from '/ui/days/side.js';

setIcons(await (await fetch('/icons.json')).json());
const day = new URLSearchParams(location.search).get('day');
const stage = document.querySelector('#stage');
const slot = document.querySelector('#side');
const wide = () => innerWidth >= 1000;
let answer = null;
let open = '';
window.revealed = [];
window.reads = 0;
window.asked = [];
const fetched = window.fetch.bind(window);
window.fetch = (input, init) => {
  const path = new URL(String(input instanceof Request ? input.url : input), location.href).pathname;
  if (path.startsWith('/api/')) window.asked.push(path);
  return fetched(input, init);
};
const side = installDaySide(stage, { changed: () => draw(), reveal: rows => window.revealed.push({ kind: 'disc', key: '', rows }) });

function draw() {
  if (!answer) slot.innerHTML = wide() ? daySideReading() : sidePillsReading();
  else slot.innerHTML = wide() ? daySide(day, answer.side, side.more(day)) : sidePills(day, answer.side, { ...side.more(day), open });
  fitWithin(slot);
  if (answer) side.settle(day, answer.side);
}

async function load() {
  answer = await fetchPage('day', { day });
  draw();
  window.reads += 1;
}

stage.addEventListener('click', event => {
  const target = event.target.closest('[data-d-pill], [data-d-place], [data-d-person], [data-d-group]');
  if (!target) return;
  if (target.dataset.dPill) {
    open = open === target.dataset.dPill ? '' : target.dataset.dPill;
    draw();
    return;
  }
  const kind = target.dataset.dPlace !== undefined ? 'place' : target.dataset.dGroup !== undefined ? 'group' : 'person';
  window.revealed.push({ kind, key: target.dataset.dPlace ?? target.dataset.dPerson ?? target.dataset.dGroup,
    rows: target.dataset.dRows ?? '' });
});
document.addEventListener('click', event => {
  if (open && !event.target.closest('.ck-pillpop')) {
    open = '';
    draw();
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && open) {
    open = '';
    draw();
  }
});
addEventListener('resize', () => draw());
window.reread = () => load();
window.moment = id => {
  document.querySelector('.dy-panel').classList.toggle('is-open', Boolean(id));
  const place = id ? answer.side.places.find(each => each.rows.includes(id)) : null;
  side.moment(place ? { latitude: place.point.latitude, longitude: place.point.longitude } : null);
};
draw();
await load();
`;

const seen = { shots: /** @type {string[]} */ ([]), asked: /** @type {unknown[]} */ ([]), revealed: /** @type {unknown[]} */ ([]), waiting: '' };
const page = pageHarness({ file: 'days-side', seen, front: async home => ({ url: home.url, close: async () => undefined }),
  size: { width: 1280, height: 900 }, zone: 'UTC', ending: async () => {
    seen.asked = await opened.chrome.evaluate('window.asked ?? []').catch(() => []);
    seen.revealed = await opened.chrome.evaluate('window.revealed ?? []').catch(() => []);
  } });
/** @type {Awaited<ReturnType<typeof page.journey>>} */
let opened;

/**
 * @param {string} name
 * @param {Scene} which
 * @param {{ width: number, height: number }} [size]
 */
async function journey(name, which, size) {
  scene = which;
  opened = await page.journey(name, size ? { size } : {});
  await opened.chrome.send('Fetch.enable', { patterns: [{ urlPattern: '*days-side-harness*' }, { urlPattern: '*/api/page/day?*' }] });
  return opened;
}

const load = () => opened.chrome.load(`${HARNESS.slice(1)}?day=${CASES[scene].day}`, '');

before(async () => {
  const { chrome } = await page.open();
  chrome.on('Fetch.requestPaused', ({ requestId, request }) => {
    const path = new URL(request.url).pathname;
    const [body, type] = path === '/api/page/day' ? [JSON.stringify(CASES[scene]), 'application/json']
      : path === MODULE ? [HARNESS_JS, 'text/javascript'] : [HARNESS_HTML, 'text/html; charset=utf-8'];
    void chrome.send('Fetch.fulfillRequest', { requestId, responseCode: 200, body: Buffer.from(body).toString('base64'),
      responseHeaders: [{ name: 'content-type', value: type }, { name: 'cache-control', value: 'no-store' }] }).catch(() => undefined);
  });
});

after(() => page.close());

describe('days-side', () => {
  before(() => journey('days-side', 'side'));

  test('S1, S2, S4, S5, S6, S12: the column draws the page\'s side as the page says it, and reads nothing but the page', async () => {
    const { chrome } = opened;
    await load();
    await chrome.until(`window.reads === 1 && document.querySelectorAll('.ds [data-d-unit]').length === ${SIDE.places.length}
      && document.querySelectorAll('.ds [data-d-who]').length === ${SIDE.people.length}
      && document.querySelectorAll('.ds [data-d-group]').length === ${SIDE.groups.length} && ${frame()}.dataset.drawn === '${discsOf(SIDE)}'`);

    assert.deepEqual(await chrome.evaluate(`[...document.querySelectorAll('.ds .ck-figrow__figure')].map(figure =>
      [figure.children[0].textContent.replace(/\\s+/gu, ' '), figure.children[1].textContent])`),
    SIDE.figures.slice(0, FIGURES_SHOWN).map(figure => [figure.value, figure.words]));

    const drawn = await units();
    assert.deepEqual(drawn.map(unit => [unit.key, unit.name, unit.time, unit.line]), SIDE.places.map(place => [place.key, place.name, place.length, lineOf(place)]));
    assert.equal(drawn[0].label, `${SIDE.places[0].spoken}, Home`);
    assert.deepEqual(drawn.map(unit => unit.open), SIDE.places.map(place => place.slug ? `#view=places&focus=${place.slug}` : null));
    assert.deepEqual(drawn.map(unit => unit.rows), SIDE.places.map(place => place.rows.join(' ')));
    assert.deepEqual(drawn.map(unit => unit.quiet), SIDE.places.map(place => place.quiet));

    assert.equal(await chrome.evaluate(`${frame()}.dataset.path`), undefined);
    assert.equal(await chrome.evaluate(`${frame()}.dataset.gathered`), '0');
    assert.equal(await chrome.evaluate(`[...${frame()}.querySelectorAll('canvas')].length > 0`), true);
    const set = await names();
    assert.ok(set.boxes.some(box => box.text === SIDE.places[0].name), 'the map names the place the day spent most at, its largest disc');
    for (const { text, spent } of set.boxes) {
      const unit = drawn.find(each => each.name === text || (text.endsWith('…') && each.name.startsWith(text.slice(0, -1))));
      assert.ok(unit, `${text} is a place of the day`);
      assert.equal(spent, unit.time, `${text} with its time there`);
    }
    apart(set);
    assert.equal(await chrome.evaluate(`${frame()}.getAttribute('aria-label')`), `Map of the day: ${SIDE.places.map(place => place.name).join(', ')}`);

    assert.deepEqual(await people(), SIDE.people.map(person => ({ key: person.key, name: person.name, runs: runsOf(person.runs), label: person.spoken,
      rows: [...person.rows].sort().join(' '), open: person.person ? `#view=people&focus=${encodeURIComponent(person.person)}` : null })));
    assert.equal(await chrome.evaluate(`[...document.querySelectorAll('.ds [data-side-part]')].map(part => part.dataset.sidePart).join(' ')`),
      'map places people groups');
    assert.equal(await page.words('.ds [data-side-part="groups"] .ck-section__label'), `Groups ${SIDE.groups.length}`);
    assert.deepEqual(await groups(), SIDE.groups.map(group => ({ name: group.title, runs: runsOf(group.runs), label: group.spoken, opens: group.rows[0],
      rows: group.rows.join(' '), quiet: group.quiet })));
    const nameColour = (/** @type {string} */ inside) => chrome.evaluate(`getComputedStyle(document.querySelector('.ds [data-side-part="groups"] ${inside} .ck-prow__name')).color`);
    assert.notEqual(await nameColour('li.is-quiet'), await nameColour('li:not(.is-quiet)'));
    assert.equal(await chrome.evaluate(`document.querySelectorAll('.ds .ck-run.is-quiet').length`),
      [...SIDE.people, ...SIDE.groups].flatMap(each => each.runs).filter(run => run.quiet).length);
    assert.equal(await chrome.evaluate(`document.querySelectorAll('.ds .ds-groups').length`), 0);

    assert.deepEqual(await chrome.evaluate('window.asked'), ['/api/page/day']);
    await page.shot('column', `${frame()}.dataset.drawn === '${discsOf(SIDE)}' && ${frame()}.dataset.named !== undefined`);
  });

  test('S7: the day read again draws the side from the page alone, asking nothing of its own', async () => {
    const { chrome } = opened;
    const [unitsBefore, peopleBefore] = [await units(), await people()];
    await chrome.evaluate('window.reread()');
    await chrome.until('window.reads === 2');
    assert.deepEqual(await chrome.evaluate('window.asked'), ['/api/page/day', '/api/page/day']);
    assert.deepEqual([await units(), await people()], [unitsBefore, peopleBefore]);
  });

  test('S13: a moment opened, its sheet over the map, lights its place where it stands and moves nothing; closed, nothing either', async () => {
    const { chrome } = opened;
    await chrome.until(`${frame()}.dataset.drawn === '${discsOf(SIDE)}' && ${frame()}.dataset.camera !== undefined && ${frame()}.dataset.lit === '0'`);
    const camera = await chrome.evaluate(`${frame()}.dataset.camera`);
    const row = placeNamed('Synthetic Office').rows[0];
    await chrome.evaluate(`window.moment(${JSON.stringify(row)})`);
    await chrome.until(`document.querySelector('.dy-panel.is-open') && ${frame()}.dataset.lit === '1' && ${frame()}.dataset.drawn !== undefined`);
    assert.ok(await chrome.evaluate(`(() => { const sheet = document.querySelector('.dy-panel').getBoundingClientRect();
      const map = ${frame()}.getBoundingClientRect(); return sheet.left < map.right && sheet.right > map.left && sheet.bottom > map.top; })()`),
    'the sheet stands over the map');
    assert.equal(await chrome.evaluate(`${frame()}.dataset.camera`), camera);
    await page.shot('moment-lit', `${frame()}.dataset.lit === '1'`);
    await chrome.evaluate(`window.moment('')`);
    await chrome.until(`!document.querySelector('.dy-panel.is-open') && ${frame()}.dataset.lit === '0' && ${frame()}.dataset.drawn !== undefined`);
    assert.equal(await chrome.evaluate(`${frame()}.dataset.camera`), camera);
  });

  test('S3, S8, S12: the map stays still and answers the pointer; a spot, a number and a disc reveal their own rows, a person their page, a group its conversation', async () => {
    const { chrome } = opened;
    assert.deepEqual(await chrome.evaluate(`(() => {
      const map = ${frame()}.querySelector('.maplibregl-map') ?? ${frame()};
      return [map.querySelector('.maplibregl-canvas-container').className.includes('touch'), map.querySelector('canvas').tabIndex];
    })()`), [false, -1]);
    const office = placeNamed('Synthetic Office').key;
    await chrome.hover(`.ds [data-d-unit="${office}"]`);
    await chrome.until(`${frame()}.dataset.hot === ${JSON.stringify(office)}`);
    const cityPlace = placeNamed('Synthetic City');
    const city = cityPlace.key;
    const unit = `.ds [data-d-place="${city}"]`;
    const at = await chrome.evaluate(`(() => {
      const name = [...${frame()}.querySelectorAll('.ck-map__name')].find(each => each.firstChild?.textContent.startsWith('Synthetic Ci'));
      const label = name?.getBoundingClientRect();
      if (!label) return [];
      const [x, y] = [label.x + label.width / 2, label.y + label.height / 2];
      return [8, 12, 16, 20, 24].flatMap(by => [[label.x - by, y], [label.right + by, y], [x, label.y - by], [x, label.bottom + by]]);
    })()`);
    assert.ok(at.length, `the city is named: ${await chrome.evaluate(`${frame()}.dataset.named`)}`);
    let found = null;
    for (const [x, y] of at) {
      await chrome.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      if (await chrome.evaluate(`${frame()}.dataset.hot === ${JSON.stringify(city)}`)) {
        found = [x, y];
        break;
      }
    }
    assert.ok(found, 'the city\'s disc is beside its name');
    const [x0, y0] = /** @type {number[]} */ (found);
    await chrome.until(`document.querySelector('${unit}').closest('.ck-punit').classList.contains('is-lit')`);
    await chrome.evaluate('window.reread()');
    await chrome.until('window.reads === 3');
    await chrome.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: 1, clickCount: 1 });
    await chrome.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x0, y: y0, button: 'left', buttons: 0, clickCount: 1 });
    await chrome.until('window.revealed.length === 1');
    const rows = (await units()).find(each => each.key === city)?.rows;
    assert.equal(rows, cityPlace.rows.join(' '));
    await page.click(unit);
    const caller = /** @type {import('../public/pages.js').SidePerson} */ (SIDE.people.find(person => person.person === null));
    await page.click(`.ds [data-d-person="${caller.key}"]`);
    await page.click('.ds [data-d-group="e78"]');
    const revealed = await chrome.evaluate('window.revealed');
    assert.deepEqual(revealed.map((/** @type {any} */ each) => [each.kind, each.key]),
      [['disc', ''], ['place', city], ['person', caller.key], ['group', 'e78']]);
    assert.equal(revealed[0].rows, rows);
    assert.equal(revealed[1].rows, rows);
    assert.equal(revealed[2].rows, caller.rows.join(' '));
    assert.equal(revealed[3].rows, 'e78');
    const known = /** @type {import('../public/pages.js').SidePerson} */ (SIDE.people.find(person => person.person !== null));
    assert.equal(await chrome.evaluate(`document.querySelector('.ds [data-d-who="${known.key}"]').getAttribute('href')`),
      `#view=people&focus=${encodeURIComponent(String(known.person))}`);

    await chrome.hover('');
    await chrome.size(1280, 480);
    const [x, y] = await chrome.evaluate(`(() => { const box = ${frame()}.getBoundingClientRect(); return [box.x + box.width / 2, box.y + box.height / 2]; })()`);
    await chrome.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: 240 });
    await chrome.until('scrollY > 0');
    await chrome.evaluate('scrollTo(0, 0)');
    await chrome.until(`${frame()}.dataset.camera !== undefined`);
    const camera = await chrome.evaluate(`${frame()}.dataset.camera`);
    await chrome.drag(`${FRAME} canvas`, 80);
    assert.equal(await chrome.evaluate(`${frame()}.dataset.camera`), camera);
    await chrome.size(1280, 900);
    assert.equal(await chrome.evaluate('window.revealed.length'), 4);
  });
});

describe('days-side-hidden', () => {
  before(() => journey('days-side-hidden', 'side'));

  test('S10: the stage hidden, as the router hides a section, keeps its map; shown again, the day stands at once', async () => {
    const { chrome } = opened;
    await load();
    await chrome.until(`${frame()}?.dataset.drawn !== undefined && ${frame()}.dataset.camera !== undefined && window.reads === 1`);
    const [drawnBefore, cameraBefore] = await chrome.evaluate(`(() => { window.mapCanvas = ${frame()}.querySelector('canvas');
      return [${frame()}.dataset.drawn, ${frame()}.dataset.camera]; })()`);
    const [unitsBefore, peopleBefore] = [(await units()).length, (await people()).length];
    assert.ok(unitsBefore > 0 && peopleBefore > 0);
    await chrome.evaluate(`document.querySelector('#stage').hidden = true`);
    await chrome.evaluate('window.reread()');
    await chrome.until('window.reads === 2');
    assert.equal(await chrome.evaluate(`${frame()}.querySelector('canvas') === window.mapCanvas && !${frame()}.classList.contains('is-waiting')`), true);
    const shown = await chrome.evaluate(`(() => {
      document.querySelector('#stage').hidden = false;
      const frame = ${frame()};
      return [frame.querySelector('canvas') === window.mapCanvas, frame.classList.contains('is-waiting'),
        document.querySelectorAll('.ds [data-side-part="places"]:not(.is-reading) [data-d-unit]').length,
        document.querySelectorAll('.ds [data-side-part="people"]:not(.is-reading) [data-d-who]').length,
        document.querySelectorAll('.ds .ck-sk').length];
    })()`);
    assert.deepEqual(shown, [true, false, unitsBefore, peopleBefore, 0]);
    await chrome.until(`${frame()}.dataset.drawn === ${JSON.stringify(drawnBefore)} && ${frame()}.dataset.camera === ${JSON.stringify(cameraBefore)}`);
    assert.deepEqual(await chrome.evaluate('window.asked'), ['/api/page/day', '/api/page/day']);
    await page.shot('shown-again', `${frame()}.dataset.drawn === ${JSON.stringify(drawnBefore)}`);
  });
});

describe('days-side-pills', () => {
  before(() => journey('days-side-pills', 'side', { width: 900, height: 900 }));

  test('S9: under a pane of 1056 the figures are one line and two pills open their parts', async () => {
    const { chrome } = opened;
    await load();
    await chrome.until(`window.reads === 1 && document.querySelectorAll('.ds-line .ck-pill__count .ck-sk').length === 0`);
    assert.equal(await chrome.evaluate(`[...document.querySelectorAll('.ds-line .ck-figline__figure')].map(figure =>
      [...figure.children].map(part => part.textContent.replace(/\\s+/gu, ' ')).join(' ')).join(' · ')`),
    SIDE.figures.slice(0, FIGURES_SHOWN).map(figure => `${figure.value} ${figure.words}`).join(' · '));
    assert.deepEqual(await chrome.evaluate(`[...document.querySelectorAll('.ds-line .ck-pill')].map(pill => pill.textContent)`),
      [`People${SIDE.people.length}`, `Places${SIDE.places.length}`]);
    await page.shot('pills', 'window.reads === 1');

    await page.click('[data-d-pill="people"]');
    await chrome.until(`document.activeElement?.matches('#ck-pop-people') && document.querySelectorAll('#ck-pop-people [data-d-who]').length === ${SIDE.people.length}
      && document.querySelectorAll('#ck-pop-people [data-d-group]').length === ${SIDE.groups.length}`);
    assert.deepEqual((await people('#ck-pop-people')).map(row => row.name), SIDE.people.map(person => person.name));
    assert.deepEqual((await groups('#ck-pop-people')).map(row => [row.name, row.quiet]), SIDE.groups.map(group => [group.title, group.quiet]));
    assert.equal(await page.words('#ck-pop-people [data-side-part="groups"] .ck-section__label'), `Groups ${SIDE.groups.length}`);
    await page.shot('people-popover', `document.activeElement?.matches('#ck-pop-people')`);
    await chrome.press('Escape');
    await chrome.until(`!document.querySelector('.ck-popover') && document.activeElement?.matches('[data-d-pill="people"]')`);

    await page.click('[data-d-pill="places"]');
    await chrome.until(`document.activeElement?.matches('#ck-pop-places') && ${frame('#ck-pop-places')}?.dataset.drawn === '${discsOf(SIDE)}'
      && document.querySelectorAll('#ck-pop-places [data-d-unit]').length === ${SIDE.places.length}`);
    assert.deepEqual((await units('#ck-pop-places')).map(unit => unit.line), SIDE.places.map(lineOf));
    await page.shot('places-popover', `${frame('#ck-pop-places')}?.dataset.drawn === '${discsOf(SIDE)}'`);
    await chrome.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 40, y: 600, button: 'left', buttons: 1, clickCount: 1 });
    await chrome.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 40, y: 600, button: 'left', buttons: 0, clickCount: 1 });
    await chrome.until(`!document.querySelector('.ck-popover') && document.activeElement?.matches('[data-d-pill="places"]')`);
  });
});

describe('days-side-travel', () => {
  before(() => journey('days-side-travel', 'travel', { width: 1280, height: 1400 }));

  test('S2, S4, S7: a travel day draws twelve places, a disc each and no line, a long name cut to its box, every name apart', async () => {
    const { chrome } = opened;
    const travel = CASES.travel.side;
    await load();
    await chrome.until(`window.reads === 1 && document.querySelectorAll('.ds [data-d-unit]').length === 12
      && ${frame()}.dataset.drawn === '12'`);
    const drawn = await units();
    assert.deepEqual(drawn.map(unit => unit.key), travel.places.map(place => place.key));
    assert.deepEqual(drawn.map(unit => unit.line), travel.places.map(lineOf));
    const long = /** @type {SidePlace} */ (travel.places.find(place => place.name.length > 30));
    assert.deepEqual(await chrome.evaluate(`(() => {
      const name = document.querySelector('.ds [data-d-unit="${long.key}"] .ck-punit__name');
      return [name.textContent.endsWith('…'), name.scrollWidth <= name.clientWidth];
    })()`), [true, true]);
    assert.equal(await chrome.evaluate(`${frame()}.dataset.path`), undefined);
    const set = await names();
    apart(set);
    for (const box of set.boxes) assert.ok(box.spent, `${box.text} with its time there`);
    assert.deepEqual(await chrome.evaluate('window.asked'), ['/api/page/day']);
    await page.shot('travel', `${frame()}.dataset.drawn === '12'`);
  });
});

describe('days-side-many', () => {
  before(() => journey('days-side-many', 'groups', { width: 1280, height: 1400 }));

  test('S6: a day of many people draws the first ones the column holds before "N more", the rest after it, in the page\'s order', async () => {
    const { chrome } = opened;
    const many = CASES.groups.side;
    assert.ok(many.people.length > PEOPLE_SHOWN);
    await load();
    await chrome.until(`window.reads === 1 && document.querySelectorAll('.ds [data-d-who]').length === ${PEOPLE_SHOWN}`);
    assert.equal(await page.words('.ds [data-side-part="people"] .ds-more'), `${many.people.length - PEOPLE_SHOWN} more`);
    assert.deepEqual((await people()).map(row => row.name), many.people.slice(0, PEOPLE_SHOWN).map(person => person.name));
    assert.deepEqual((await groups()).map(row => row.name), many.groups.map(group => group.title));
    assert.equal(await chrome.evaluate(`document.querySelector('.ds [data-side-part="groups"] .ds-more')`), null);
    await page.shot('many', `document.querySelector('.ds [data-side-part="people"] .ds-more')`);
    await page.click('.ds [data-side-part="people"] .ds-more');
    await chrome.until(`document.querySelectorAll('.ds [data-d-who]').length === ${many.people.length} && !document.querySelector('.ds .ds-more')`);
    assert.deepEqual((await people()).slice(PEOPLE_SHOWN).map(row => row.name), many.people.slice(PEOPLE_SHOWN).map(person => person.name));
  });
});

describe('days-side-unnamed', () => {
  before(() => journey('days-side-unnamed', 'unnamed'));

  test('S11: a spot\'s unit and its plate are its stay\'s head: "Near Synthetic Home", "1.8 km away", a step quieter', async () => {
    const { chrome } = opened;
    const unnamed = CASES.unnamed.side;
    await load();
    await chrome.until(`window.reads === 1 && document.querySelectorAll('.ds [data-d-unit]').length === ${unnamed.places.length}`);
    const drawn = Object.fromEntries((await units()).map(unit => [unit.name, [unit.line, unit.quiet, unit.time]]));
    assert.deepEqual(drawn, Object.fromEntries(unnamed.places.map(place => [place.name, [lineOf(place), place.quiet, place.length]])));
    assert.deepEqual(drawn['Near Synthetic Home'], ['1.8 km away', true, '50m']);
    const near = (await units()).find(unit => unit.name === 'Near Synthetic Home');
    assert.equal(near?.label, 'Near Synthetic Home, 50 minutes, 1.8 km away');
    await chrome.until(`${frame()}.dataset.named !== undefined && ${frame()}.querySelectorAll('.ck-map__name').length > 0`);
    const plates = (await names()).boxes.map(box => box.text);
    assert.ok(plates.every(text => !/unnamed place \d|unnamed place in/u.test(text)), plates.join(' | '));
    assert.ok(plates.some(text => text.startsWith('Near ')), plates.join(' | '));
    assert.ok(!(await chrome.evaluate(`${frame()}.getAttribute('aria-label')`)).includes('an unnamed place'));
    await page.shot('unnamed', `${frame()}.dataset.named !== undefined`);
  });
});

describe('days-side-map', () => {
  const DAY = CASES.side.day;
  const HOME = { latitude: -34.93, longitude: 138.6 };
  const OFFICE = { latitude: -34.905, longitude: 138.645 };
  const CAFE = { latitude: -34.91, longitude: 138.653 };
  const CITY = { latitude: -34.89, longitude: 138.62 };
  /**
   * @param {string} name
   * @param {number} minutes
   * @param {Point} point
   * @param {string} length
   * @param {Partial<SidePlace>} [more]
   * @returns {SidePlace}
   */
  const place = (name, minutes, point, length, more = {}) => ({ key: `spot:${pointKey(point)}`, slug: null, name, line: null, home: false, quiet: false,
    ms: minutes * 60_000, length, spoken: name, point: { ...point, id: null }, radius_m: null, rows: [], ...more });
  /** @param {SidePlace[]} places @returns {DaySide} */
  const sideWith = places => ({ figures: [], located: true, places, people: [], groups: [], unreturned: [] });
  /** @param {NonNullable<ReturnType<typeof mapViewOf>>} view */
  const discs = view => view.marks.map(mark => [mark.key, pointKey(mark), mark.r, mark.spent]);

  test('S2: where the time went: a disc a place, its area by the day\'s time there, no line, none under 10 minutes', () => {
    const view = mapViewOf(DAY, sideWith([
      place('Synthetic Home', 900, HOME, '15h', { key: 'fx-home', slug: 'fx-home', home: true }),
      place('Synthetic Office', 225, OFFICE, '3h 45m', { key: 'fx-office', slug: 'fx-office' }),
      place('Synthetic City', 100, CITY, '1h 40m'),
      place('Synthetic Cafe', 9, CAFE, '9m'),
    ]));
    assert.ok(view);
    assert.deepEqual(discs(view), [
      ['fx-home', pointKey(HOME), 24, '15h'],
      ['fx-office', pointKey(OFFICE), 15, '3h 45m'],
      [`spot:${pointKey(CITY)}`, pointKey(CITY), 12, '1h 40m'],
    ]);
    assert.deepEqual(view.marks.map(mark => mark.name), ['Synthetic Home', 'Synthetic Office', 'Synthetic City']);
    assert.ok(!('path' in view), 'no line joins them');
    assert.deepEqual(view.fit, [HOME, OFFICE, CITY]);
    assert.equal(view.still, true);
  });

  test('S2: one place the whole day is one disc, framed by its circle at three times its reach, a spot\'s by its own; a day of minutes has no map', () => {
    const alone = mapViewOf(DAY, sideWith([place('Synthetic Home', 580, HOME, '9h 40m', { key: 'fx-home', slug: 'fx-home', radius_m: 60 })]));
    assert.ok(alone);
    assert.deepEqual(discs(alone), [['fx-home', pointKey(HOME), 24, '9h 40m']]);
    assert.deepEqual(alone.fit, [{ ...HOME, radius_m: 180 }]);
    assert.deepEqual(mapViewOf(DAY, sideWith([place('Synthetic Cafe', 40, CAFE, '40m')]))?.fit, [{ ...CAFE, radius_m: 240 }]);
    assert.equal(mapViewOf(DAY, sideWith([place('Synthetic Cafe', 9, CAFE, '9m')])), null);
  });
});
