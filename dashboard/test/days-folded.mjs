import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ALT, DAYS, daysPage, drawn, FOCUSED, GROUPS, LATTICE, latticeHolds, META, MIDNIGHT, PAGE } from './stand-ins/days-page.mjs';
import { until } from './until.mjs';
import { UNTIMED } from '../public/ui/days/fold.js';
import { clock, longDay } from '../public/lib/words.js';

/** @typedef {import('../public/pages.js').Day} Day */
/** @typedef {{ key: string, kind: string, start_ms: number | null, end_ms: number | null, name: string, length: string, folded: boolean,
 *   names: { text: string, first_row: string }[], photos: unknown[], blocks: import('../public/pages.js').DayBlock[] }} Folded */

/**
 * @param {Day} day
 * @returns {Folded[]}
 */
const foldedOf = day => [
  ...day.chapters.filter(chapter => chapter.kind === 'stay' || chapter.kind === 'none' || (chapter.kind === 'move' && chapter.blocks.length))
    .map(chapter => ({ key: chapter.key, kind: chapter.kind, start_ms: chapter.start_ms, end_ms: chapter.end_ms, name: chapter.head?.title ?? '',
      length: chapter.head?.length ?? '', folded: chapter.folded, names: chapter.names, photos: chapter.photos, blocks: chapter.blocks })),
  ...day.also ? [{ key: UNTIMED, kind: 'untimed', start_ms: null, end_ms: null, name: day.now_ms === null ? 'Also that day' : 'Also today',
    length: '', folded: day.also.folded, names: day.also.names, photos: [],
    blocks: [{ key: `${UNTIMED}#run`, kind: /** @type {const} */ ('run'), start_ms: 0, title: null, line: null, count: null, folded: false,
      rows: day.also.rows, divider: null }] }] : [],
];

/** @param {Folded} fold */
const rowsOf = fold => fold.blocks.flatMap(block => block.rows);

/** @param {Folded} fold */
const opensAlone = fold => !fold.folded && rowsOf(fold).length > 0;

const dayPages = daysPage({ file: 'days-folded' });
const { page, seen, journey, holdDay, pageAsked, load, key, listed } = dayPages;

before(() => dayPages.open());

after(() => dayPages.close());

describe('days-folded', () => {
  before(() => journey('days-folded'));

  test('D1 D2: a day drawn folded as its page says, every head, names band and strip as the page words them, the midnight between hour lines, the lattice one grid', async () => {
    const { chrome } = dayPages.opened;
    await load(`#view=days&on=${MIDNIGHT}`);
    await chrome.until(drawn(MIDNIGHT));
    const folds = foldedOf(PAGE.midnight);
    assert.deepEqual(await chrome.evaluate(`[...document.querySelectorAll('.dy-block.is-open')].map(block => block.dataset.dBlock)`),
      folds.filter(opensAlone).map(fold => fold.key));
    const dated = /** @type {Folded} */ (folds.find(fold => fold.key === UNTIMED));
    assert.equal(dated.name, 'Also that day');
    assert.deepEqual(await chrome.evaluate(`[...document.querySelectorAll('.dy-block[data-d-block="${UNTIMED}"] .dy-row')].map(row => row.dataset.dAt)`),
      rowsOf(dated).map(row => row.key));
    const headed = folds.filter(fold => fold.kind !== 'move');
    const heads = await chrome.evaluate(`[...document.querySelectorAll('.dy-block > .dy-head')].map(head => [
      head.querySelector('.dy-head__time').textContent, head.querySelector('.dy-head__name').dataset.full ?? head.querySelector('.dy-head__name').textContent,
      head.querySelector('.dy-head__length').textContent])`);
    assert.deepEqual(heads, headed.map(fold => [fold.start_ms === null ? '' : clock(fold.start_ms), fold.name, fold.length]));
    const bands = await chrome.evaluate(`[...document.querySelectorAll('.dy-block')].filter(block => block.querySelector(':scope > .dy-head'))
      .map(block => ({ names: [...block.querySelectorAll('.dy-name')].map(name => name.textContent),
        hidden: block.querySelectorAll('.dy-name[hidden]').length,
        more: block.querySelector('.dy-names__more:not([hidden])')?.textContent ?? '',
        total: Number(block.querySelector('.dy-photos')?.dataset.total ?? 0), tiles: block.querySelectorAll('.dy-tile').length }))`);
    assert.deepEqual(bands.map((/** @type {any} */ band) => band.names), headed.map(fold => opensAlone(fold) ? [] : fold.names.map(name => name.text)));
    for (const band of bands) assert.equal(band.more, band.hidden ? `+${band.hidden}` : '');
    assert.deepEqual(bands.map((/** @type {any} */ band) => [band.total, band.tiles]),
      headed.map(fold => [fold.photos.length, Math.min(12, fold.photos.length)]));
    await page.shot('folded', drawn(MIDNIGHT));
    /** @type {Record<string, unknown>} */
    const lattice = {};
    lattice.folded = await chrome.evaluate(LATTICE);
    latticeHolds(lattice.folded, 'folded');
    await chrome.evaluate(`document.querySelector('.dy-block [data-d-stay]').dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }))`);
    await chrome.until(`[...document.querySelectorAll('.dy-block')].every(block => block.classList.contains('is-open')
      || !block.querySelector('[data-d-stay]'))`);
    lattice.open = await chrome.evaluate(LATTICE);
    latticeHolds(lattice.open, 'every stay open');
    await chrome.evaluate(`document.querySelectorAll('[data-d-hour]').forEach(hour => hour.click())`);
    await chrome.until(`document.querySelector('[data-d-at="e73"]') && document.querySelector('[data-d-at="e4"]')`);
    /** @param {string} id */
    const row = id => chrome.evaluate(`(() => { const row = document.querySelector('[data-d-at="${id}"]');
      const words = row.querySelector('.dy-row__words');
      return [row.querySelector('.dy-row__title').textContent, (words.matches('[data-full]') ? words : words.querySelector('[data-full]'))?.dataset.full ?? words.textContent]; })()`);
    const said = new Map(folds.flatMap(rowsOf).map(each => [each.key, each]));
    const strain = /** @type {import('../public/pages.js').DayRow} */ (said.get('e4'));
    assert.deepEqual(await row('e4'), [strain.name, strain.words.map(word => word.text).join('')]);
    const quoted = /** @type {import('../public/pages.js').DayRow} */ (said.get('e73'));
    assert.deepEqual(quoted.words.map(word => word.type), ['quote']);
    assert.ok((await row('e73'))[1].includes(`“${quoted.words[0].text}”`), 'the quote drawn as a quote');
    const [stay, hour] = /** @type {[Folded, import('../public/pages.js').DayBlock]} */ (folds.flatMap(fold => fold.blocks
      .filter(block => block.divider !== null).map(block => [fold, block]))[0]);
    assert.equal(hour.kind, 'hour');
    const around = await chrome.evaluate(`(() => {
      const divider = document.querySelector('.dy-block[data-d-block="${stay.key}"] .dy-rows > .dy-row--divider');
      return divider ? [divider.previousElementSibling?.matches('.dy-hour') ?? false, divider.nextElementSibling?.dataset.dHourbox ?? '',
        divider.querySelector('.dy-divider__date').textContent, document.querySelectorAll('.dy-list .dy-row--divider').length] : null;
    })()`);
    assert.deepEqual(around, [true, hour.key, longDay(/** @type {string} */ (hour.divider), MIDNIGHT.slice(0, 4)), 1],
      'the midnight drawn once, between the hour lines the page puts it between');
    await page.shot('open-all', `document.querySelectorAll('.dy-block.is-open').length > 0`);
    await load(`#view=days&on=${GROUPS}`);
    await chrome.until(drawn(GROUPS));
    await chrome.evaluate(`document.querySelector('.dy-block--stay [data-d-stay]').click()`);
    await chrome.until(`document.querySelector('.dy-row--hour')`);
    await chrome.evaluate(`document.querySelectorAll('[data-d-hour]').forEach(hour => hour.click())`);
    await chrome.until(`[...document.querySelectorAll('.dy-hour')].every(hour => hour.classList.contains('is-open'))`);
    lattice.dense = await chrome.evaluate(LATTICE);
    latticeHolds(lattice.dense, 'the dense day, every hour open');
    seen.lattice = lattice;
    await page.shot('dense-hours', `document.querySelectorAll('.dy-hour.is-open').length > 0`);
  });
});

describe('days-open', () => {
  before(() => journey('days-open'));

  test('D3: a stay opens and folds in place, a name opens its own moment, ⌥-click opens all, the open set kept across a burst and a day', async () => {
    const { chrome } = dayPages.opened;
    const stand = /** @type {NonNullable<typeof dayPages.front>} */ (dayPages.front);
    await load(`#view=days&on=${MIDNIGHT}`);
    await chrome.until(drawn(MIDNIGHT));
    const openable = foldedOf(PAGE.midnight).filter(fold => rowsOf(fold).length > 0);
    const stays = openable.filter(fold => fold.kind === 'stay' && fold.names.length > 0);
    assert.ok(stays.length >= 2, 'two stays with rows');
    const [first, second] = stays;
    const head = (/** @type {string} */ key) => `document.querySelector('.dy-block[data-d-block="${key}"] [data-d-stay]')`;
    const rows = (/** @type {string} */ key) => `document.querySelectorAll('.dy-block[data-d-block="${key}"] .dy-block__body .dy-row').length`;
    await chrome.evaluate(`${head(first.key)}.click()`);
    await chrome.until(`${rows(first.key)} === ${rowsOf(first).length}`);
    assert.equal(await chrome.evaluate(`${head(first.key)}.getAttribute('aria-expanded')`), 'true');
    await page.shot('open', `${head(first.key)}.getAttribute('aria-expanded') === 'true'`);
    await chrome.evaluate(`${head(first.key)}.click()`);
    await chrome.until(`${head(first.key)}.getAttribute('aria-expanded') === 'false' && !document.querySelector('.dy-block[data-d-block="${first.key}"] .dy-rows')`);
    const [name] = second.names;
    const nameButton = `document.querySelector('.dy-block[data-d-block="${second.key}"] [data-d-name="${name.first_row}"]')`;
    await chrome.evaluate(`${nameButton}.click()`);
    await chrome.until(`location.hash.includes('focus=${name.first_row}') && document.querySelector('.dy-panel.is-open')`);
    assert.equal(await chrome.evaluate(`${head(second.key)}.getAttribute('aria-expanded')`), 'false');
    assert.equal(await page.count(`.dy-block[data-d-block="${second.key}"] .dy-block__body .dy-row`), 0);
    await chrome.evaluate(`${nameButton}.click()`);
    await chrome.until(`!location.hash.includes('focus=') && !document.querySelector('.dy-panel.is-open')`);
    await chrome.evaluate(`${nameButton}.click()`);
    await chrome.until(`document.querySelector('.dy-panel.is-open') && document.querySelector('.dy-panel').contains(document.activeElement)`);
    await chrome.press('Escape');
    await chrome.until(`!document.querySelector('.dy-panel.is-open') && document.activeElement === ${nameButton}`);
    await chrome.evaluate(`${head(first.key)}.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }))`);
    await chrome.until(`document.querySelectorAll('.dy-block.is-open').length === ${openable.length}`);
    await chrome.evaluate(`${head(first.key)}.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }))`);
    await chrome.until(`document.querySelectorAll('.dy-block.is-open').length === 0`);
    await chrome.evaluate(`${head(second.key)}.click()`);
    await chrome.until(`${head(second.key)}.getAttribute('aria-expanded') === 'true'`);
    const reads = pageAsked('/api/page/day').length;
    stand.tell([{ kind: 'day', key: MIDNIGHT }]);
    await until('the day read again', () => pageAsked('/api/page/day').length === reads + 1);
    await chrome.until(`${head(second.key)}.getAttribute('aria-expanded') === 'true' && ${rows(second.key)} > 0`);
    assert.equal(await page.count('.dy-block.is-open'), 1);
    await chrome.evaluate(`document.querySelector('.dy-scroll').scrollTop = 60`);
    const scrolled = await chrome.evaluate(`document.querySelector('.dy-scroll').scrollTop`);
    const previous = await chrome.evaluate(`document.querySelector('.dy-bar .ck-page__tools [data-d-day]').dataset.dDay`);
    await chrome.evaluate(`document.querySelector('.dy-bar .ck-page__tools [data-d-day]').click()`);
    await chrome.until(drawn(previous));
    assert.equal(await page.count('.dy-block.is-open'), 0);
    assert.equal(await chrome.evaluate(`document.querySelector('.dy-scroll').scrollTop`), 0);
    await chrome.evaluate('history.back()');
    await chrome.until(`${drawn(MIDNIGHT)} && ${head(second.key)}?.getAttribute('aria-expanded') === 'true'`);
    assert.equal(await page.count('.dy-block.is-open'), 1);
    assert.equal(await chrome.evaluate(`document.querySelector('.dy-scroll').scrollTop`), scrolled);
    await page.shot('kept', `${head(second.key)}.getAttribute('aria-expanded') === 'true'`);
  });
});

describe('days-hours', () => {
  before(() => journey('days-hours'));

  test('D4 D5: the dense stay opens to its hours, an hour to its rows and no further; its head pins under the bar and folds there', async () => {
    const { chrome } = dayPages.opened;
    await load(`#view=days&on=${GROUPS}`);
    await chrome.until(drawn(GROUPS));
    const [stay] = foldedOf(PAGE.groups).filter(fold => fold.kind === 'stay');
    const hours = stay.blocks.filter(block => block.kind === 'hour');
    assert.ok(hours.length > 1, 'the dense stay holds hours');
    const block = `document.querySelector('.dy-block[data-d-block="${stay.key}"]')`;
    await chrome.evaluate(`${block}.querySelector(':scope > [data-d-stay]').click()`);
    await chrome.until(`${block}.querySelectorAll('.dy-row--hour').length === ${hours.length}`);
    assert.equal(await chrome.evaluate(`${block}.querySelectorAll('.dy-row:not(.dy-row--hour)').length`), 0);
    const [hour] = hours;
    await chrome.evaluate(`${block}.querySelector('[data-d-hour="${hour.key}"]').click()`);
    await chrome.until(`${block}.querySelectorAll('[data-d-hourbox="${hour.key}"] .dy-hour__rows .dy-row').length === ${hour.rows.length}`);
    assert.equal(await chrome.evaluate(`${block}.querySelectorAll('.dy-hour__rows [data-d-hour], .dy-hour__rows .dy-hour').length`), 0);
    assert.equal(await chrome.evaluate(`${block}.querySelector('[data-d-hour="${hour.key}"]').getAttribute('aria-expanded')`), 'true');
    await page.shot('hour', `${block}.querySelector('.dy-hour.is-open')`);
    await chrome.evaluate(`${block}.querySelectorAll('.dy-hour:not(.is-open) [data-d-hour]').forEach(each => each.click())`);
    await chrome.until(`${block}.querySelectorAll('.dy-hour.is-open').length === ${hours.length}`);
    const under = await chrome.evaluate(`document.querySelector('.dy-bar').getBoundingClientRect().bottom`);
    assert.equal(await chrome.evaluate(`document.querySelector('.dy-scroll').getBoundingClientRect().top`), under);
    await chrome.evaluate(`(() => {
      const scroll = document.querySelector('.dy-scroll');
      scroll.scrollTop += ${block}.getBoundingClientRect().top - scroll.getBoundingClientRect().top + 400;
    })()`);
    await chrome.until(`${block}.classList.contains('is-pinned')`);
    const headTop = `${block}.querySelector(':scope > .dy-head').getBoundingClientRect().top`;
    assert.equal(await chrome.evaluate(headTop), under);
    assert.match(await chrome.evaluate(`getComputedStyle(${block}.querySelector(':scope > .dy-head')).boxShadow`), /inset/u);
    await page.shot('pinned', `${block}.classList.contains('is-pinned')`);
    await chrome.evaluate(`${block}.querySelector(':scope > [data-d-stay]').click()`);
    await chrome.until(`!${block}.classList.contains('is-open')`);
    assert.equal(await chrome.evaluate(headTop), under);
    assert.equal(await chrome.evaluate(`(() => {
      const scroll = document.querySelector('.dy-scroll');
      return ${block}.querySelector(':scope > .dy-head').getBoundingClientRect().top - scroll.getBoundingClientRect().top;
    })()`), 0);
    assert.equal(await chrome.evaluate(`${block}.classList.contains('is-pinned')`), false);
    await page.shot('folded-from-pin', `!${block}.classList.contains('is-open')`);
  });
});

describe('days-keys', () => {
  before(() => journey('days-keys'));

  test('D6: the day page\'s keys, each its own work; ⌘← prevented; none inside the panel\'s field', async () => {
    const { chrome } = dayPages.opened;
    dayPages.serve([MIDNIGHT]);
    await load(`#view=days&on=${MIDNIGHT}`);
    await chrome.until(drawn(MIDNIGHT));
    await chrome.evaluate(`window.prevented = []; addEventListener('keydown', event => window.prevented.push([event.key, event.defaultPrevented]))`);
    const items = /** @type {string[]} */ (await chrome.evaluate(`[...document.querySelectorAll('.dy-list [data-d-nav]')]
      .map(item => item.dataset.dStay ? 'stay:' + item.dataset.dStay : 'row:' + item.dataset.dRow)`));
    assert.ok(items.length >= 2);
    assert.equal(items[0], `row:${PAGE.midnight.all_day[0].key}`, 'the all-day row leads the day, as its page orders it');
    assert.equal(await page.count('.dy-list [data-d-nav][tabindex="0"]'), 1);
    await chrome.evaluate(`document.querySelector('.dy-list [data-d-nav][tabindex="0"]').focus()`);
    assert.equal(await chrome.evaluate(FOCUSED), items[0]);
    await key('ArrowDown');
    assert.equal(await chrome.evaluate(FOCUSED), items[1]);
    await key('ArrowUp');
    assert.equal(await chrome.evaluate(FOCUSED), items[0]);
    const at = items.findIndex(item => item.startsWith('stay:'));
    for (let step = 0; step < at; step += 1) await key('ArrowDown');
    assert.equal(await chrome.evaluate(FOCUSED), items[at]);
    const first = items[at].slice('stay:'.length);
    const open = `document.querySelector('.dy-block[data-d-block="${first}"]').classList.contains('is-open')`;
    await key('ArrowRight');
    await chrome.until(open);
    await key('ArrowLeft');
    await chrome.until(`!${open}`);
    await key(' ');
    await chrome.until(open);
    await key('Enter');
    await chrome.until(`!${open}`);
    await key('Enter');
    await chrome.until(open);
    await key('ArrowDown');
    const row = /** @type {string} */ (await chrome.evaluate(FOCUSED));
    assert.match(row, /^row:/u);
    await key('ArrowRight');
    await chrome.until(`location.hash.includes('focus=') && document.querySelector('.dy-panel.is-open')`);
    await page.shot('moment', `document.querySelector('.dy-panel.is-open')`);
    await key('Escape');
    await chrome.until(`!document.querySelector('.dy-panel.is-open') && !location.hash.includes('focus=')`);
    await chrome.until(`(${FOCUSED}) === ${JSON.stringify(row)}`);
    await key('ArrowLeft');
    await chrome.until(`!${open} && (${FOCUSED}) === ${JSON.stringify(items[at])}`);
    const withRows = await page.count('.dy-block [data-d-stay]');
    assert.equal(withRows, foldedOf(PAGE.midnight).filter(fold => rowsOf(fold).length > 0).length);
    await key('ArrowRight', ALT);
    await chrome.until(`document.querySelectorAll('.dy-block.is-open').length === ${withRows}`);
    await key('ArrowLeft', ALT);
    await chrome.until(`document.querySelectorAll('.dy-block.is-open').length === 0`);
    await key('Escape');
    assert.equal(await chrome.evaluate(`document.querySelector('.dy-list').contains(document.activeElement)`), false);
    const previous = await chrome.evaluate(`document.querySelector('.dy-bar .ck-page__tools [data-d-day]').dataset.dDay`);
    await key('ArrowLeft', META);
    await chrome.until(drawn(previous));
    assert.deepEqual(await chrome.evaluate(`window.prevented.filter(([name]) => name === 'ArrowLeft').at(-1)`), ['ArrowLeft', true]);
    await key('ArrowRight', META);
    await chrome.until(drawn(MIDNIGHT));
    assert.ok(listed().some(each => each.day === MIDNIGHT));
    await key('t');
    await chrome.until(drawn(DAYS.opening));
    await chrome.evaluate(`location.hash = '#view=days&on=${MIDNIGHT}'`);
    await chrome.until(drawn(MIDNIGHT));
    await chrome.evaluate(`document.querySelector('.dy-list .dy-block > [data-d-stay]').click()`);
    await chrome.until(`document.querySelector('.dy-list [data-d-row]')`);
    await chrome.evaluate(`document.querySelector('.dy-list [data-d-row]').click()`);
    await chrome.until(`document.querySelector('.dy-panel.is-open:not(.ck-reading) .ck-inspector__body')`);
    await chrome.evaluate(`(() => {
      const field = document.createElement('input');
      field.dataset.testField = '';
      document.querySelector('.dy-panel').append(field);
      field.focus();
      document.querySelector('.dy-list').dataset.testKept = '';
    })()`);
    const release = holdDay(MIDNIGHT);
    dayPages.front?.tell([{ kind: 'day', key: MIDNIGHT }]);
    release();
    await chrome.until(`document.querySelector('.dy-list:not([data-test-kept])')`);
    assert.equal(await chrome.evaluate(`document.activeElement.matches('[data-test-field]')`), true);
    const hash = await chrome.evaluate('location.hash');
    await key('t');
    await key('ArrowLeft', META);
    await key('ArrowDown');
    assert.equal(await chrome.evaluate('location.hash'), hash);
    assert.equal(await chrome.evaluate(`document.activeElement.matches('[data-test-field]')`), true);
  });
});
