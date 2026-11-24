import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { circleSuite, frameOf, WATCH_WORK } from './stand-ins/places-page.mjs';

const suite = circleSuite({ file: 'place-circle' });
/** @type {Awaited<ReturnType<typeof suite.journey>>['front']} */
let front;
/** @type {Awaited<ReturnType<typeof suite.journey>>['chrome']} */
let chrome;

before(() => suite.open());

after(() => suite.close());

describe('place-circle: a spot named, its circle on the naming card', () => {

  before(async () => {
    ({ front, chrome } = await suite.journey('place-circle'));
  });

  const { seen, shot, click, words, count, mouse, circleOf, settledOn, at, ringPx, drag, key, focus, work } = suite;

  /** @param {number} metres */
  const stepAt = metres => metres < 100 ? 5 : metres < 500 ? 10 : 50;

  const STAGE = 'stage';
  const SPOT = '38.718900,-9.146600,80';

  /** @type {Awaited<ReturnType<typeof circleOf>>} */
  let chosen;

  test('naming a spot: its circle starts at the spot, moves with a press inside it, is taken back and given again', async () => {
    await chrome.load('#view=places', WATCH_WORK);
    await chrome.until('document.querySelector(".pl-invite") && !document.querySelector(".pl.ck-reading")');
    await click('.pl-invite [data-pl-open="name"]');
    await chrome.until(`document.querySelector('.pl-naming__count')?.textContent === '1 of 3'`
      + ` && ${frameOf(STAGE)}.dataset.framed === 'spot:38.7189,-9.1466' && ${frameOf(STAGE)}.dataset.drawn !== undefined`);
    await settledOn(STAGE, SPOT);
    assert.equal(await words('.pl-reach output'), '80 m');
    await chrome.until(`document.querySelector(".pl-reach .ck-circle-line")?.textContent === ${JSON.stringify('Takes in 4\u00a0stays')}`);
    assert.equal(await count('.pl-card .pl-naming > .pl-name + .pl-reach [data-ck-reach]'), 1);
    assert.equal(await count('.ck-circle__point.is-held'), 1);
    assert.equal(await count('[data-pl-add-circle]'), 0);
    seen.witnessed.naming = await words('.pl-seen');
    assert.equal(await words('.pl-seen__line'), '4 days · 4 stays');
    assert.match(await words('.pl-seen__last'), /^Last time \S/u);
    assert.equal(await chrome.evaluate('getComputedStyle(document.querySelector(".ck-circle__body")).cursor'), 'grab');
    assert.equal(await chrome.evaluate('getComputedStyle(document.querySelector(".ck-circle__handle")).cursor'), 'ew-resize');
    const centre = await at('.ck-circle__centre');
    await mouse('mouseMoved', centre[0], centre[1], false);
    await shot('naming-circle', `${frameOf(STAGE)}.dataset.drawn !== undefined`);

    const r = await ringPx(STAGE);
    await drag(centre, [2 * r, 0], { held: async () => {
      assert.ok(await chrome.evaluate('document.querySelector(".ck-circle").classList.contains("is-moving")'));
      assert.equal(await words('.pl-reach .ck-circle-line'), 'Takes in no stays');
      assert.equal(await count('.ck-circle__point.is-held'), 0);
    } });
    const away = await at('.ck-circle__centre');
    assert.ok(Math.abs(away[0] - centre[0] - 2 * r) <= 1 && Math.abs(away[1] - centre[1]) <= 1, `${centre} → ${away}`);
    const moved = await circleOf(STAGE);
    assert.ok(moved.longitude > -9.1466 && Math.abs(moved.latitude - 38.7189) < 1e-5 && moved.radius_m === 80, moved.said);
    seen.circles.moved = moved.said;
    seen.work.move = await work();
    await key('z', 4);
    await settledOn(STAGE, SPOT);
    assert.equal(await words('.pl-reach .ck-circle-line'), 'Takes in 4 stays');
    await key('z', 4 | 8);
    await settledOn(STAGE, moved.said);
    await key('z', 4);
    await settledOn(STAGE, SPOT);
    await drag(centre, [r, r], { held: () => key('Escape') });
    await settledOn(STAGE, SPOT);
    assert.equal(await words('.pl-naming__count'), '1 of 3');
    assert.equal(await chrome.evaluate('document.querySelector(".pl-name input").value'), '');
    await drag([centre[0] + 4 * r, centre[1] + 2 * r], [-60, -40]);
    await settledOn(STAGE, SPOT);
    const panned = await at('.ck-circle__centre');
    assert.ok(panned[0] <= centre[0] - 50 && panned[1] <= centre[1] - 30, `${centre} → ${panned}`);
  });

  test('naming a spot: the handle sizes its circle along the ladder, two-way with the stepper, between 20 m and 2 km', async () => {
    const r = await ringPx(STAGE);
    const handle = await at('.ck-circle__handle');
    await drag(handle, [Math.round(1.37 * r), 0], { held: async () => {
      assert.ok(await chrome.evaluate('document.querySelector(".ck-circle").classList.contains("is-sizing")'));
      assert.equal(await words('.ck-circle__tip'), await words('.pl-reach output'));
      await shot('naming-sizing', '!!document.querySelector(".ck-circle.is-sizing")');
    } });
    const sized = await circleOf(STAGE);
    seen.circles.sized = sized.said;
    seen.work.size = await work();
    assert.ok(sized.radius_m > 150 && sized.radius_m < 260 && sized.radius_m % stepAt(sized.radius_m) === 0, sized.said);
    assert.equal(await words('.pl-reach output'), `${sized.radius_m} m`);
    assert.equal(await chrome.evaluate('document.querySelector(".ck-circle__handle").getAttribute("aria-valuenow")'),
      String(sized.radius_m));
    await click('.pl-reach [data-pl-reach="1"]');
    await settledOn(STAGE, `38.718900,-9.146600,${sized.radius_m + 10}`);
    assert.equal(await chrome.evaluate('document.querySelector(".ck-circle__handle").getAttribute("aria-valuenow")'),
      String(sized.radius_m + 10));
    assert.ok(await ringPx(STAGE) > (r * sized.radius_m) / 80, 'the circle did not grow with its stepper');
    await click('.pl-reach [data-pl-reach="-1"]');
    await settledOn(STAGE, sized.said);

    await focus('.ck-circle__handle');
    await key('End');
    await settledOn(STAGE, '38.718900,-9.146600,2000');
    assert.equal(await words('.pl-reach output'), '2 km');
    assert.deepEqual(await chrome.evaluate('[...document.querySelectorAll(".pl-reach button")].map(side => side.disabled)'),
      [false, true]);
    const far = await at('.ck-circle__handle');
    const past = () => chrome.evaluate(`(() => { const ring = document.querySelector('.ck-circle__ring');
    const handle = document.querySelector('.ck-circle__handle').getBoundingClientRect();
    const box = ring.ownerSVGElement.getBoundingClientRect();
    return handle.x + handle.width / 2 - box.x - Number(ring.getAttribute('cx')) - Number(ring.getAttribute('r')); })()`);
    await drag(far, [24, 0], { held: async () => {
      const gives = await past();
      assert.ok(gives > 0 && gives <= 14, `the handle gave ${gives} px`);
      assert.equal(await words('.pl-reach output'), '2 km');
    } });
    await settledOn(STAGE, '38.718900,-9.146600,2000');
    await chrome.until(`Math.abs(${frameOf(STAGE)}.querySelector('.ck-circle__handle').getBoundingClientRect().x + 12`
      + ` - ${frameOf(STAGE)}.querySelector('.ck-circle__svg').getBoundingClientRect().x`
      + ` - Number(${frameOf(STAGE)}.querySelector('.ck-circle__ring').getAttribute('cx'))`
      + ` - Number(${frameOf(STAGE)}.querySelector('.ck-circle__ring').getAttribute('r'))) < 1`);
    assert.match(await words('.pl-reach .ck-circle-line'), /^Takes in [1-9]\d* stays$/u);
    assert.equal(await count('.ck-circle__other.is-over'), 9);
    assert.equal(await chrome.evaluate(`${frameOf(STAGE)}.dataset.hushed.split(',').length`), 9);
    await key('Home');
    await settledOn(STAGE, '38.718900,-9.146600,20');
    await chrome.until(`${frameOf(STAGE)}.dataset.hushed === undefined`);
    assert.deepEqual(await chrome.evaluate('[...document.querySelectorAll(".pl-reach button")].map(side => side.disabled)'),
      [true, false]);
    await drag(await at('.ck-circle__handle'), [-14, 0]);
    await settledOn(STAGE, '38.718900,-9.146600,20');
  });

  test('naming a spot: the keys step its reach and move it, with an overlap drawn and named', async () => {
    for (let page = 0; page < 11; page += 1) await key('PageUp');
    await key('ArrowUp');
    await settledOn(STAGE, '38.718900,-9.146600,500');
    assert.equal(await words('.ck-circle__said'), '500 m');
    await key('ArrowLeft');
    await settledOn(STAGE, '38.718900,-9.146600,490');
    await key('ArrowRight');
    await settledOn(STAGE, '38.718900,-9.146600,500');
    assert.match(await words('.pl-reach .ck-circle-line'), /^Takes in [1-9]\d* stays$/u);
    assert.equal(await count('.ck-circle__other.is-over'), 1);
    assert.equal(await chrome.evaluate(`${frameOf(STAGE)}.dataset.hushed`), 'fixture-hill-studio');
    await shot('naming-overlap', `${frameOf(STAGE)}.dataset.circle === '38.718900,-9.146600,500'`);
    await focus('.ck-circle__move');
    await key('ArrowUp');
    await chrome.until(`${frameOf(STAGE)}.dataset.circle !== '38.718900,-9.146600,500'`);
    let now = await circleOf(STAGE);
    assert.ok(Math.abs((now.latitude - 38.7189) * 111_320 - 5) < 0.2 && now.longitude === -9.1466, now.said);
    assert.equal(await words('.ck-circle__said'), 'Moved 5 m north');
    await key('ArrowRight', 8);
    await chrome.until(`${frameOf(STAGE)}.dataset.circle.split(',')[1] !== '-9.146600'`);
    now = await circleOf(STAGE);
    assert.ok(Math.abs((now.longitude + 9.1466) * 111_320 * Math.cos((now.latitude * Math.PI) / 180) - 25) < 0.2, now.said);
    await key('-');
    await chrome.until(`${frameOf(STAGE)}.dataset.circle.endsWith(',490')`);
    await key('=');
    await chrome.until(`${frameOf(STAGE)}.dataset.circle.endsWith(',500')`);
    await key('[');
    await chrome.until(`${frameOf(STAGE)}.dataset.circle.endsWith(',490')`);
    await key(']');
    await chrome.until(`${frameOf(STAGE)}.dataset.circle.endsWith(',500')`);
    const sized = (await circleOf(STAGE)).radius_m;
    await key('=');
    await chrome.until(`${frameOf(STAGE)}.dataset.circle.endsWith(',${sized + 50}')`);
    await key('z', 4);
    await chrome.until(`!${frameOf(STAGE)}.dataset.circle.endsWith(',${sized + 50}')`);
    const was = await circleOf(STAGE);
    assert.ok(was.radius_m < sized + 50, was.said);
    await key('=');
    await settledOn(STAGE, `${was.said.split(',').slice(0, 2).join(',')},${was.radius_m + (was.radius_m < 500 ? 10 : 50)}`);
    const grown = await circleOf(STAGE);
    await key('z', 4);
    await settledOn(STAGE, was.said);
    await key('z', 4 | 8);
    await settledOn(STAGE, grown.said);
    await key('z', 4 | 8);
    assert.equal((await circleOf(STAGE)).said, grown.said);
    await key('z', 4);
    await settledOn(STAGE, was.said);
    await key('ArrowDown');
    await key('ArrowLeft');
    assert.equal(await words('.pl-naming__count'), '1 of 3');
    assert.equal(await chrome.evaluate('document.querySelector(".pl-name input").value'), '');
    chosen = await circleOf(STAGE);
    seen.circles.chosen = chosen.said;
    seen.lines.chosen = await words('.pl-reach .ck-circle-line');
  });

  test('naming a spot: the name states the circle as it stands; a skip states nothing', async () => {
    const before = front.saved.length;
    await key('Enter');
    await chrome.until(`document.querySelector('.pl-naming__count')?.textContent === '2 of 3'`);
    await front.stated(before + 1);
    const named = front.saved[before];
    assert.equal(named.kind, 'create');
    assert.deepEqual(named.place, { name: 'Lantern Noodle Bar', latitude: chosen.latitude, longitude: chosen.longitude,
      radius_m: chosen.radius_m, also: [], ids: [], home: null });
    await settledOn(STAGE, '38.712000,-9.129000,80');
    await focus('.ck-circle__move');
    await key('=');
    await chrome.until(`${frameOf(STAGE)}.dataset.circle === '38.712000,-9.129000,85'`);
    await key('z', 4);
    await settledOn(STAGE, '38.712000,-9.129000,80');
    assert.equal(await words('.pl-naming__count'), '2 of 3');
    assert.equal(front.saved.length, before + 1);
    await key('=');
    await chrome.until(`${frameOf(STAGE)}.dataset.circle === '38.712000,-9.129000,85'`);
    await click('[data-pl-skip]');
    await chrome.until(`document.querySelector('.pl-naming__count')?.textContent === '3 of 3'`);
    await settledOn(STAGE, '41.149500,-8.610800,80');
    assert.equal(front.saved.length, before + 1);
    await click('[data-pl-spot-home="false"]');
    await chrome.until('document.querySelector(".pl-seen")');
    seen.witnessed.porto = await words('.pl-seen');
  });

  /** @type {[number, number, number, number][]} */
  const LADDER = [[20, 20, 25, 20], [83, 85, 85, 80], [100, 100, 110, 100], [105, 110, 110, 100], [500, 500, 550, 500],
    [525, 550, 550, 500], [2000, 2000, 2000, 1950], [1999, 2000, 2000, 1950]];

  test('the ladder and the earth: the same cases as the iPhone\'s, a centre kept on the earth however it moves', async () => {
    const found = await chrome.evaluate(`import('/lib/circle.js').then(circle => ${JSON.stringify(LADDER)}.map(([at]) =>
    [at, circle.snapReach(at), circle.notch(at, 1), circle.notch(circle.notch(at, 1), -1)]))`);
    assert.deepEqual(found, LADDER);
    assert.equal(await chrome.evaluate(`import('/lib/circle.js').then(circle => circle.notch(83, -1))`), 80);
    const [east, north] = await chrome.evaluate(`import('/lib/circle.js').then(circle => [
    circle.movedBy({ latitude: 0, longitude: 179.99999, radius_m: 80 }, 0, 5),
    circle.movedBy({ latitude: 84.99999, longitude: 10, radius_m: 80 }, 50, 0)])`);
    assert.ok(east.longitude >= -180 && east.longitude < -179.9999, String(east.longitude));
    assert.equal(north.latitude, 85);
    assert.equal(await chrome.evaluate(`import('/lib/circle.js').then(circle => circle.movedWords(
    { latitude: 0, longitude: 179.99999 }, { latitude: 0, longitude: -179.99996 }))`), '6\u00a0m east');
    assert.deepEqual(chrome.thrown, []);
  });
});

describe('place-circle-edit: a place’s Edit, in its card', () => {

  const CABIN = 'fixture-river-cabin';
  const A = { latitude: 41.1421, longitude: -8.611, radius_m: 110 };
  const B = { latitude: 41.1421, longitude: -8.60945, radius_m: 60 };
  const C = { latitude: 41.140638, longitude: -8.61294, radius_m: 160 };

  before(async () => {
    ({ front, chrome } = await suite.journey('place-circle-edit'));
    front.elsewhere({ [CABIN]: { name: 'River Cabin', ...A, ids: [], also: [B, C] } });
  });

  const { seen, shot, click, words, count, mouse, circleOf, settledOn, at, ringPx, drag, key, focus, work } = suite;
  const STAGE = 'stage';

  /** @param {{ latitude: number, longitude: number, radius_m: number }} circle */
  const said = circle => `${circle.latitude.toFixed(6)},${circle.longitude.toFixed(6)},${circle.radius_m}`;
  const listed = async () => String(await chrome.evaluate(`${frameOf(STAGE)}.dataset.circle ?? ''`)).split(';')
    .map(one => one.split(',').map(Number)).map(([latitude, longitude, radius_m]) => ({ latitude, longitude, radius_m }));

  /**
   * @param {string} slug
   * @param {{ latitude: number, longitude: number, radius_m: number }[]} circles
   * @returns {Promise<string>}
   */
  const takesInAt = (slug, circles) => chrome.evaluate(`Promise.all([fetch('/api/page/placeEdit?slug=${slug}')
  .then(answer => answer.json()), import('/lib/circle.js')])
  .then(([page, circle]) => circle.takesInWords(circle.draggedStays(page, ${JSON.stringify(circles)})))`);

  /**
   * @param {{ latitude: number, longitude: number }[]} points
   * @param {{ latitude: number, longitude: number, radius_m: number }} circle
   */
  const held = (points, circle) => points.filter(point => {
    const rad = Math.PI / 180;
    const a = Math.sin(((point.latitude - circle.latitude) * rad) / 2) ** 2 + Math.cos(point.latitude * rad)
      * Math.cos(circle.latitude * rad) * Math.sin(((point.longitude - circle.longitude) * rad) / 2) ** 2;
    return 2 * 6371008.8 * Math.asin(Math.sqrt(a)) <= circle.radius_m;
  }).length;

  /** @param {number} index */
  const lineOf = index => chrome.evaluate(`document.querySelector('.pl-edit [data-ck-circle-line="${index}"]').textContent`);

  const framed = () => chrome.evaluate(`${frameOf(STAGE)}.dataset.framed`);
  const LIST = 'document.querySelector(".pl-card__scroll[data-part=list]")';

  const EDITING = 'document.querySelector(".pl-card form[data-pl-form=edit]") && !document.querySelector(".pl-page")';

  /**
   * @param {string} slug
   * @param {string} circles
   */
  async function edit(slug, circles) {
    await chrome.load(`#view=places&focus=${slug}`, WATCH_WORK);
    await chrome.until('document.querySelector(".pl-page") && !document.querySelector(".pl.ck-reading")');
    await click('[data-pl-edit]');
    await chrome.until(EDITING);
    await settledOn(STAGE, circles);
  }

  /**
   * @param {number} index
   * @returns {Promise<[number, number]>}
   */
  const centreOf = index => at(`[data-map="stage"] .ck-circle__centre[data-at="${index}"]`);
  /** @param {number} index */
  const radiusOf = index => chrome.evaluate(`Number(document.querySelector('[data-map="stage"] .ck-circle__ring[data-at="${index}"]').getAttribute('r'))`);
  /** @param {number} index */
  const litOnMap = index => chrome.evaluate(`(() => {
    const ring = document.querySelector('[data-map="stage"] .ck-circle__ring[data-at="${index}"]');
    const handle = document.querySelector('[data-map="stage"] .ck-circle__handle[data-at="${index}"]');
    return ring.classList.contains('is-lit') && handle.classList.contains('is-lit')
      && document.querySelectorAll('[data-map="stage"] .ck-circle__handle.is-lit').length === 1;
  })()`);
  const litRow = () => chrome.evaluate(`(() => { const rows = [...document.querySelectorAll('.pl-edit [data-pl-circle]')];
    return rows.length && rows.filter(row => row.classList.contains('is-lit')).length <= 1
      ? rows.findIndex(row => row.classList.contains('is-lit')) : -2; })()`);

  const ADD = '.pl-edit [data-pl-add-circle]';
  /** @returns {Promise<string[]>} */
  const numbers = () => chrome.evaluate('[...document.querySelectorAll(".pl-edit [data-pl-circle] .ck-circlerow__number")]'
    + '.map(ring => ring.textContent)');
  const addLast = () => chrome.evaluate(`document.querySelector('.pl-edit__rows').lastElementChild.matches('${ADD}')`);
  /** @param {number} index */
  const gripFocused = index =>
    chrome.evaluate(`document.activeElement?.matches('[data-map="stage"] .ck-circle__move[data-at="${index}"]')`);
  /** @param {{ latitude: number, longitude: number, radius_m: number }} at */
  const circleStated = at => ({ latitude: at.latitude, longitude: at.longitude, radius_m: at.radius_m });
  const saidAloud = () => words('[data-map="stage"] .ck-circle__said');

  async function enter() {
    await chrome.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
      text: '\r', unmodifiedText: '\r' });
    await chrome.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  }

  test('a place\'s Edit in its card: its own stays lit inside its circle and grey outside, an overlap, Cancel, × and Esc state nothing', async () => {
    await edit('home', '0.000000,0.000000,120');
    assert.equal(await framed(), 'edit:home');
    assert.equal(await count('.ck-dialog'), 0);
    assert.equal(await count('[data-part="dialog"] *'), 0);
    assert.equal(await count('[data-map]'), 1);
    assert.equal(await words('.pl-card .pl-naming__title'), 'Edit place');
    assert.equal(await chrome.evaluate('document.activeElement?.name'), 'name');
    assert.equal(await words('.pl-edit .ck-section__label'), 'Circle');
    assert.equal(await count('.pl-edit [data-pl-uncircle]'), 0);
    assert.equal(await words(ADD), 'Add circle');
    assert.equal(await addLast(), true);
    const line = await takesInAt('home', [{ latitude: 0, longitude: 0, radius_m: 120 }]);
    assert.match(line, /^Takes in [1-9]\d*\u00a0stays?$/u, 'the synthetic home takes in no stays');
    await chrome.until(`document.querySelector('.pl-edit [data-ck-circle-line="0"]')?.textContent === ${JSON.stringify(line)}`);
    assert.ok(await count('.ck-circle__point.is-held') > 0, 'no stay of the place is lit');
    assert.equal(await words('.pl-edit [data-ck-reach="0"] output'), '120 m');
    seen.lines.home = await lineOf(0);
    await shot('edit-one-circle', `${frameOf(STAGE)}.dataset.circle === '0.000000,0.000000,120'`);
    const r = await ringPx(STAGE);
    await drag(await centreOf(0), [0, -3 * r]);
    await chrome.until(`${frameOf(STAGE)}.dataset.circle !== '0.000000,0.000000,120'`);
    assert.equal(await count('.ck-circle__point.is-held'), 0);
    assert.equal(await lineOf(0), 'Takes in no stays');
    await key('z', 4);
    await settledOn(STAGE, '0.000000,0.000000,120');
    await focus('[data-map="stage"] .ck-circle__handle');
    await key('End');
    await settledOn(STAGE, '0.000000,0.000000,2000');
    assert.equal(await lineOf(0), await takesInAt('home', [{ latitude: 0, longitude: 0, radius_m: 2000 }]),
      'the office keeps its own stays: a smaller circle wins them');
    assert.equal(await count('[data-map="stage"] .ck-circle__other.is-over'), 1);
    await shot('edit-overlap', `${frameOf(STAGE)}.dataset.circle === '0.000000,0.000000,2000'`);
    const stated = front.saved.length;
    await click('.pl-edit__foot [data-pl-close]');
    await chrome.until('document.querySelector(".pl-page") && !document.querySelector("form[data-pl-form=edit]")');
    assert.equal(await chrome.evaluate('document.activeElement?.matches("[data-pl-edit]")'), true);
    await chrome.until(`${frameOf(STAGE)}.dataset.framed === 'home' && ${frameOf(STAGE)}.dataset.drawn !== undefined`);
    await chrome.size(1440, 300);
    const down = await chrome.evaluate(`${LIST}.scrollTop = ${LIST}.scrollHeight - ${LIST}.clientHeight`);
    assert.ok(down > 0, `the page does not scroll: ${await chrome.evaluate(`${LIST}.scrollHeight`)} tall`);
    await drag([1300, 220], [-300, -180]);
    await click('[data-pl-edit]');
    await chrome.until(EDITING);
    await settledOn(STAGE, '0.000000,0.000000,120');
    await chrome.until(`${frameOf(STAGE)}.dataset.framed === 'edit:home' && ${frameOf(STAGE)}.dataset.drawn !== undefined`);
    const [x, y] = await centreOf(0);
    const card = await chrome.evaluate('document.querySelector(".pl-card").getBoundingClientRect().right');
    assert.ok(x > card && x < 1440 && y > 0 && y < 300, `the circle is at ${x},${y}, off the map beside the card`);
    await click('.pl-naming__close[data-pl-close]');
    await chrome.until('document.querySelector(".pl-page")');
    await chrome.until(`${frameOf(STAGE)}.dataset.framed === 'home'`);
    assert.equal(await chrome.evaluate(`${LIST}.scrollTop`), down);
    await chrome.size(1440, 900);
    await click('[data-pl-edit]');
    await chrome.until(EDITING);
    await focus('[data-map="stage"] .ck-circle__move');
    await key('=');
    await settledOn(STAGE, '0.000000,0.000000,130');
    await click('.pl-edit__foot [data-pl-remove]');
    await chrome.until('document.activeElement?.matches("[data-pl-keep]")');
    await key('Escape');
    await chrome.until('document.activeElement?.matches("[data-pl-remove]") && !document.querySelector("[data-pl-keep]")');
    assert.ok(await chrome.evaluate(EDITING), 'Esc left Edit while Remove for good was asked');
    await key('Escape');
    await chrome.until('document.querySelector(".pl-page") && !document.querySelector("form[data-pl-form=edit]")');
    await click('[data-pl-edit]');
    await settledOn(STAGE, '0.000000,0.000000,120');
    assert.equal(front.saved.length, stated);
    await click('.pl-edit__foot [data-pl-close]');
  });

  test('two overlapping circles: a stay the smaller circle wins is grey in the larger one, as Takes in counts it', async () => {
    await edit('home', '0.000000,0.000000,120');
    await focus('[data-map="stage"] .ck-circle__handle');
    await key('End');
    await settledOn(STAGE, '0.000000,0.000000,2000');
    await chrome.until(`document.querySelector('.pl-edit [data-ck-circle-line="0"]')?.textContent === ${
      JSON.stringify(await takesInAt('home', [{ latitude: 0, longitude: 0, radius_m: 2000 }]))}`);
    assert.equal(await count('[data-map="stage"] .ck-circle__other.is-over'), 1);
    /** @type {{ inside: boolean[], outside: boolean[] }} */
    const lit = await chrome.evaluate(`(() => {
      const other = document.querySelector('[data-map="stage"] .ck-circle__other.is-over');
      const [x, y, r] = ['cx', 'cy', 'r'].map(name => Number(other.getAttribute(name)));
      const points = [...document.querySelectorAll('[data-map="stage"] .ck-circle__point')].map(point => ({
        away: Math.hypot(Number(point.getAttribute('cx')) - x, Number(point.getAttribute('cy')) - y),
        held: point.classList.contains('is-held') }));
      return { inside: points.filter(point => point.away < r / 2).map(point => point.held),
        outside: points.filter(point => point.away > r).map(point => point.held) };
    })()`);
    assert.ok(lit.inside.length > 0, 'no stay is drawn inside the office’s circle');
    assert.deepEqual(lit.inside.filter(Boolean), [], 'a stay the office wins is lit in the home’s circle');
    assert.ok(lit.outside.some(Boolean), 'no stay of the home is lit');
    await click('.pl-edit__foot [data-pl-close]');
    await chrome.until('document.querySelector(".pl-page") && !document.querySelector("form[data-pl-form=edit]")');
  });

  test('a place\'s Edit: the stepper and a drag set its circle, ⌘Z and ⇧⌘Z over them, ⌘S saves it', async () => {
    await edit('fixture-old-office', '38.722300,-9.139300,80');
    const centre = { latitude: 38.7223, longitude: -9.1393 };
    const wide = await takesInAt('fixture-old-office', [{ ...centre, radius_m: 80 }]);
    await chrome.until(`document.querySelector('.pl-edit [data-ck-circle-line="0"]')?.textContent === ${JSON.stringify(wide)}`);
    await focus('[data-map="stage"] .ck-circle__handle');
    await key('Home');
    await settledOn(STAGE, '38.722300,-9.139300,20');
    const near = await takesInAt('fixture-old-office', [{ ...centre, radius_m: 20 }]);
    assert.notEqual(near, wide, 'a circle of 20 m takes in what one of 80 m does');
    assert.equal(await lineOf(0), near);
    assert.ok(await count('[data-map="stage"] .ck-circle__point:not(.is-held)') > 0, 'no stay is grey outside 20 m');
    await shot('edit-own-stays', `${frameOf(STAGE)}.dataset.circle === '38.722300,-9.139300,20'`);
    await key('z', 4);
    await settledOn(STAGE, '38.722300,-9.139300,80');
    await click('.pl-edit [data-pl-circle="0"] [data-pl-reach="1"]');
    await click('.pl-edit [data-pl-circle="0"] [data-pl-reach="1"]');
    await settledOn(STAGE, '38.722300,-9.139300,90');
    assert.equal(await words('.pl-edit [data-ck-reach="0"] output'), '90 m');
    const ring = await ringPx(STAGE);
    await drag(await centreOf(0), [Math.round(ring / 2), -Math.round(ring / 3)]);
    await chrome.until(`${frameOf(STAGE)}.dataset.circle !== '38.722300,-9.139300,90'`);
    const moved = await circleOf(STAGE);
    seen.work.edit = await work();
    await key('z', 4);
    await settledOn(STAGE, '38.722300,-9.139300,90');
    await key('z', 4 | 8);
    await settledOn(STAGE, moved.said);
    const before = front.saved.length;
    await key('s', 4);
    await front.stated(before + 1);
    assert.deepEqual(front.saved[before].place, { name: 'Old Office', latitude: moved.latitude, longitude: moved.longitude,
      radius_m: 90, also: [], ids: [], home: null });
    await chrome.until('document.querySelector(".pl-page") && !document.querySelector("form[data-pl-form=edit]")');
    seen.circles.saved = moved.said;
    assert.deepEqual(chrome.thrown, []);
  });

  test('a place of three overlapping circles: every one live on the page\'s map, its rows lit with them', async () => {
    await edit(CABIN, [A, B, C].map(said).join(';'));
    assert.equal(await count('.ck-dialog'), 0);
    assert.equal(await words('.pl-edit .ck-section__label'), 'Circles 3');
    assert.equal(await count('.pl-edit [data-pl-circle]'), 3);
    assert.deepEqual(await chrome.evaluate('[...document.querySelectorAll(".pl-edit [data-pl-uncircle]")].map(x => x.getAttribute("aria-label"))'),
      ['Remove circle 1', 'Remove circle 2', 'Remove circle 3']);
    assert.deepEqual(await chrome.evaluate('[...document.querySelectorAll(".pl-edit [data-ck-reach] output")].map(o => o.textContent)'),
      ['110\u00a0m', '60\u00a0m', '160\u00a0m']);
    const whole = await takesInAt(CABIN, [A, B, C]);
    await chrome.until(`document.querySelector('.pl-edit [data-ck-circle-line="2"]')?.textContent === ${JSON.stringify(whole)}`);
    for (const index of [0, 1, 2]) assert.equal(await lineOf(index), whole, 'every circle says what the whole place takes in');
    seen.lines.cabin = await chrome.evaluate('[...document.querySelectorAll(".pl-edit [data-ck-circle-line]")].map(l => l.textContent)');
    assert.deepEqual(await numbers(), ['1', '2', '3']);
    assert.deepEqual(await chrome.evaluate('[...document.querySelectorAll("[data-map=stage] .ck-circle__number")].map(n => n.textContent)'),
      ['1', '2', '3']);
    assert.equal(await litRow(), 0);
    assert.equal(await litOnMap(0), true);
    const row = await at('.pl-edit [data-pl-circle="1"] .ck-circlerow__number');
    await mouse('mouseMoved', row[0], row[1], false);
    await chrome.until(`document.querySelector('[data-map="stage"] .ck-circle__ring[data-at="1"]').classList.contains('is-lit')`);
    assert.equal(await litOnMap(1), true);
    assert.equal(await litRow(), 1);
    await shot('edit-three-circles', `document.querySelector('.pl-edit [data-pl-circle="1"]').classList.contains('is-lit')`);
    const [cx, cy] = await centreOf(2);
    const rc = await radiusOf(2);
    await mouse('mouseMoved', cx - rc / 2, cy + rc / 2, false);
    await chrome.until(`document.querySelector('.pl-edit [data-pl-circle="2"]')?.classList.contains('is-lit')`);
    assert.equal(await litRow(), 2);
    assert.equal(await litOnMap(2), true);
    await focus('[data-map="stage"] .ck-circle__handle[data-at="1"]');
    assert.equal(await litOnMap(1), true);
    assert.equal(await litRow(), 1);
    await key('ArrowUp');
    await settledOn(STAGE, [A, { ...B, radius_m: 65 }, C].map(said).join(';'));
    await chrome.until(`getComputedStyle(document.querySelector('[data-map="stage"] .ck-circle__handle[data-at="1"]')).opacity === '1'`);
    await key('z', 4);
    await settledOn(STAGE, [A, B, C].map(said).join(';'));

    const [ax, ay] = await centreOf(0);
    const [bx] = await centreOf(1);
    const ra = await radiusOf(0);
    const rb = await radiusOf(1);
    const inBoth = /** @type {[number, number]} */ ([(bx - (rb - 7) + ax + (ra - 7)) / 2, ay]);
    assert.ok(inBoth[0] - ax < ra - 7 && bx - inBoth[0] < rb - 7, `no point inside both bodies: ${inBoth}`);
    const stated = front.saved.length;
    await drag(inBoth, [0, 24]);
    await chrome.until(`${frameOf(STAGE)}.dataset.circle !== ${JSON.stringify([A, B, C].map(said).join(';'))}`);
    let now = await listed();
    assert.equal(said(now[0]), said(A));
    assert.ok(now[1].latitude < B.latitude && now[1].radius_m === B.radius_m, said(now[1]));
    assert.equal(said(now[2]), said(C));
    assert.equal(await litRow(), 1);
    await key('z', 4);
    await settledOn(STAGE, [A, B, C].map(said).join(';'));

    const [cx2, cy2] = await centreOf(2);
    const towards = Math.hypot(ax - cx2, ay - cy2);
    const r3 = await radiusOf(2);
    const onLine = /** @type {[number, number]} */ ([cx2 + ((ax - cx2) * r3) / towards, cy2 + ((ay - cy2) * r3) / towards]);
    assert.ok(Math.hypot(onLine[0] - ax, onLine[1] - ay) < ra - 7, 'the third\'s line does not run inside the first\'s body');
    await drag(onLine, [((ax - cx2) * 20) / towards, ((ay - cy2) * 20) / towards]);
    await chrome.until(`${frameOf(STAGE)}.dataset.circle !== ${JSON.stringify([A, B, C].map(said).join(';'))}`);
    now = await listed();
    assert.equal(said(now[0]), said(A));
    assert.equal(said(now[1]), said(B));
    assert.ok(now[2].radius_m > C.radius_m && now[2].latitude === C.latitude && now[2].longitude === C.longitude, said(now[2]));
    assert.equal(await words('.pl-edit [data-ck-reach="2"] output'), `${now[2].radius_m} m`);
    assert.equal(await litOnMap(2), true);
    await key('z', 4);
    await settledOn(STAGE, [A, B, C].map(said).join(';'));
    assert.equal(front.saved.length, stated);
    seen.work.three = await work();
  });

  test('a place of three circles: change one, change another, remove the first; ⌘Z three times, ⇧⌘Z three times, ⏎ saves the list', async () => {
    const start = [A, B, C].map(said).join(';');
    const [ax, ay] = await centreOf(0);
    await drag([ax, ay], [0, -14]);
    await chrome.until(`${frameOf(STAGE)}.dataset.circle !== ${JSON.stringify(start)}`);
    const a2 = (await listed())[0];
    assert.ok(a2.latitude > A.latitude && Math.abs(a2.longitude - A.longitude) < 1e-5, said(a2));
    await click('.pl-edit [data-pl-circle="1"] [data-pl-reach="1"]');
    const b2 = { ...B, radius_m: 65 };
    await settledOn(STAGE, [a2, b2, C].map(said).join(';'));
    await click('.pl-edit [data-pl-uncircle="0"]');
    await settledOn(STAGE, [b2, C].map(said).join(';'));
    assert.equal(await words('.pl-edit .ck-section__label'), 'Circles 2');
    assert.equal(await words('.pl-edit [data-ck-reach="0"] output'), '65 m');
    assert.equal(await count('.pl-edit [data-pl-uncircle]'), 2);
    assert.equal(await count('[data-map="stage"] .ck-circle__ring'), 2);
    await shot('edit-removed-first', `${frameOf(STAGE)}.dataset.circle === ${JSON.stringify([b2, C].map(said).join(';'))}`);
    const steps = [[a2, b2, C], [a2, B, C], [A, B, C]];
    for (const list of steps) {
      await key('z', 4);
      await settledOn(STAGE, list.map(said).join(';'));
    }
    assert.equal(await count('.pl-edit [data-pl-circle]'), 3);
    for (const list of [[a2, B, C], [a2, b2, C], [b2, C]]) {
      await key('z', 4 | 8);
      await settledOn(STAGE, list.map(said).join(';'));
    }
    await click('.pl-edit [data-pl-uncircle="1"]');
    await settledOn(STAGE, said(b2));
    assert.equal(await count('.pl-edit [data-pl-uncircle]'), 0);
    assert.equal(await words('.pl-edit .ck-section__label'), 'Circle');
    await key('z', 4);
    await settledOn(STAGE, [b2, C].map(said).join(';'));

    const before = front.saved.length;
    front.refuse('Not saved. Lifestream is starting up. Try again in a moment.');
    await focus('.pl-edit input[name=name]');
    await enter();
    await chrome.until('document.querySelector(".pl-edit .pl-note .ck-in-place")');
    assert.match(await words('.pl-edit .pl-note'), /Lifestream is starting up/u);
    assert.equal(front.saved.length, before);
    assert.equal(await chrome.evaluate(`${frameOf(STAGE)}.dataset.circle`), [b2, C].map(said).join(';'));
    assert.equal(await count('.pl-edit [data-pl-circle]'), 2);
    await shot('edit-refused', 'document.querySelector(".pl-edit .pl-note .ck-in-place")');
    await focus('.pl-edit input[name=name]');
    await enter();
    await front.stated(before + 1);
    assert.deepEqual(front.saved[before].place, { name: 'River Cabin', ...circleStated(b2), also: [circleStated(C)],
      ids: [], home: null });
    await chrome.until('document.querySelector(".pl-page") && !document.querySelector("form[data-pl-form=edit]")');
    seen.circles.cabin = [b2, C].map(said).join(';');
    assert.deepEqual(chrome.thrown, []);
  });

  const CORNER = { latitude: 41.143, longitude: -8.6043 };

  test('adding a circle: beside the one last chosen, on the spot to name near it, one step of the one history', async () => {
    front.elsewhere({ [CABIN]: { name: 'River Cabin', ...circleStated(A), ids: [], also: [circleStated(B), circleStated(C)] } });
    front.stayed(CORNER, 3);
    const start = [A, B, C].map(said).join(';');
    await edit(CABIN, start);
    assert.equal(await words(ADD), 'Add circle');
    assert.equal(await addLast(), true);

    const second = await at('.pl-edit [data-pl-circle="1"] .ck-circlerow__number');
    await mouse('mouseMoved', second[0], second[1], false);
    const HANDLE = '[data-map="stage"] .ck-circle__handle[data-at="1"]';
    await chrome.until(`document.querySelector('${HANDLE}').classList.contains('is-lit')`);
    await drag(await at(HANDLE), [Math.round((await radiusOf(1)) / 2), 0]);
    await chrome.until(`${frameOf(STAGE)}.dataset.circle !== ${JSON.stringify(start)}`);
    const b2 = (await listed())[1];
    assert.ok(b2.radius_m > B.radius_m && said({ ...b2, radius_m: B.radius_m }) === said(B), said(b2));
    for (const index of [2, 0]) {
      const ring = await at(`.pl-edit [data-pl-circle="${index}"] .ck-circlerow__number`);
      await mouse('mouseMoved', ring[0], ring[1], false);
      await chrome.until(`document.querySelector('.pl-edit [data-pl-circle="${index}"]').classList.contains('is-lit')`);
    }
    const add = await at(ADD);
    await mouse('mouseMoved', add[0], add[1], false);
    await mouse('mousePressed', add[0], add[1], true);
    await mouse('mouseReleased', add[0], add[1], false);
    const corner = { ...CORNER, radius_m: Math.min(b2.radius_m, 200) };
    await settledOn(STAGE, [A, b2, C, corner].map(said).join(';'));
    assert.equal(await lineOf(3), await takesInAt(CABIN, [A, b2, C, corner]));
    assert.equal(await words('.pl-edit .ck-section__label'), 'Circles 4');
    assert.deepEqual(await numbers(), ['1', '2', '3', '4']);
    assert.equal(await litRow(), 3);
    assert.equal(await litOnMap(3), true);
    assert.equal(await gripFocused(3), true);
    assert.equal(await saidAloud(), 'Circle 4 added');
    seen.lines.added = await lineOf(3);
    await shot('edit-added-circle', `${frameOf(STAGE)}.dataset.circle?.split(';').length === 4`);
    await click(ADD);
    await chrome.until(`${frameOf(STAGE)}.dataset.circle?.split(';').length === 5`);
    const fifth = (await listed())[4];
    const apart = corner.radius_m * 2;
    assert.ok(fifth.radius_m === corner.radius_m && Math.abs(fifth.latitude - corner.latitude) < 1e-6
      && fifth.longitude > corner.longitude && held([fifth], { ...corner, radius_m: apart + 1 }) === 1
      && held([fifth], { ...corner, radius_m: apart - 1 }) === 0, said(fifth));
    await key('z', 4);
    await settledOn(STAGE, [A, b2, C, corner].map(said).join(';'));
    assert.equal(await litRow(), 3);
    assert.equal(await gripFocused(3), true);
    await key('ArrowUp');
    await chrome.until(`${frameOf(STAGE)}.dataset.circle !== ${JSON.stringify([A, b2, C, corner].map(said).join(';'))}`);
    const moved = (await listed())[3];
    assert.ok(moved.latitude > corner.latitude && moved.longitude === corner.longitude && moved.radius_m === corner.radius_m,
      said(moved));
    await key('z', 4);
    await settledOn(STAGE, [A, b2, C, corner].map(said).join(';'));
    assert.equal(await litRow(), 3);
    await key('z', 4);
    await settledOn(STAGE, [A, b2, C].map(said).join(';'));
    assert.equal(await count('.pl-edit [data-pl-circle]'), 3);
    assert.equal(await litRow(), 1);
    assert.equal(await litOnMap(1), true);
    assert.equal(await gripFocused(1), true);
    assert.equal(await saidAloud(), 'Undone. Circle 4 removed');
    await key('z', 4 | 8);
    await settledOn(STAGE, [A, b2, C, corner].map(said).join(';'));
    assert.equal(await litRow(), 3);
    assert.equal(await saidAloud(), 'Redone. Circle 4 added');
    await key('z', 4 | 8);
    await settledOn(STAGE, [A, b2, C, moved].map(said).join(';'));

    await click('.pl-edit [data-pl-uncircle="0"]');
    await settledOn(STAGE, [b2, C, moved].map(said).join(';'));
    assert.deepEqual(await numbers(), ['1', '2', '3']);
    await click(ADD);
    await chrome.until(`${frameOf(STAGE)}.dataset.circle?.split(';').length === 4`);
    const east = (await listed())[3];
    assert.deepEqual(await numbers(), ['1', '2', '3', '4']);
    assert.equal(await litRow(), 3);
    const touching = moved.radius_m + east.radius_m;
    assert.ok(east.radius_m === moved.radius_m && Math.abs(east.latitude - moved.latitude) < 1e-6
      && east.longitude > moved.longitude && held([east], { ...moved, radius_m: touching + 1 }) === 1
      && held([east], { ...moved, radius_m: touching - 1 }) === 0, `${said(moved)} → ${said(east)}`);
    assert.equal([b2, C, moved].reduce((sum, circle) => sum + held([east], circle), 0), 0);
    await key('z', 4);
    await settledOn(STAGE, [b2, C, moved].map(said).join(';'));
    await click(ADD);
    await settledOn(STAGE, [b2, C, moved, east].map(said).join(';'));
    assert.deepEqual(await numbers(), ['1', '2', '3', '4']);
    seen.circles.added = [b2, C, moved, east].map(said).join(';');

    const before = front.saved.length;
    await key('s', 4);
    await front.stated(before + 1);
    assert.deepEqual(front.saved[before].place, { name: 'River Cabin', ...circleStated(b2), also: [C, moved, east].map(circleStated),
      ids: [], home: null });
    await chrome.until('document.querySelector(".pl-page") && !document.querySelector("form[data-pl-form=edit]")');

    await edit(CABIN, [b2, C, moved, east].map(said).join(';'));
    for (let circles = 4; circles < 20; circles += 1) await click(ADD);
    await chrome.until(`${frameOf(STAGE)}.dataset.circle?.split(';').length === 20`);
    assert.equal(await words('.pl-edit .ck-section__label'), 'Circles 20');
    assert.equal(await chrome.evaluate(`document.querySelector('${ADD}').disabled`), true);
    assert.equal(await words(ADD), '20 circles, the most a place holds');
    await click(ADD);
    assert.equal(await count('.pl-edit [data-pl-circle]'), 20);
    await shot('edit-twenty-circles', `document.querySelector('${ADD}')?.disabled === true`);
    await click('.pl-edit [data-pl-uncircle="19"]');
    await chrome.until(`${frameOf(STAGE)}.dataset.circle?.split(';').length === 19`);
    assert.equal(await chrome.evaluate(`document.querySelector('${ADD}').disabled`), false);
    assert.equal(await words(ADD), 'Add circle');
    const kept = front.saved.length;
    await click('.pl-edit__foot [data-pl-close]');
    await chrome.until('document.querySelector(".pl-page") && !document.querySelector("form[data-pl-form=edit]")');
    assert.equal(front.saved.length, kept);
    assert.deepEqual(chrome.thrown, []);
  });
});
