import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ALT, daysPage, drawn, EMPTY, MIDNIGHT, NOTHING, nowAt, PAGE, PAST, PLACELESS, SHIFT, TODAY, WHOLE } from './stand-ins/days-page.mjs';
import { until } from './until.mjs';
import { markOf } from '../public/ui/kit/month-picker.js';
import { UNTIMED } from '../public/ui/days/fold.js';
import { today as todayNow } from '../public/lib/home-clock.js';
import { clock } from '../public/lib/words.js';

const dayPages = daysPage({ file: 'days-picker' });
const { page, asked, served, journey, holdDay, pageAsked, load, key, listed, listedDays } = dayPages;

/**
 * @param {string} day
 * @param {number} by
 */
const shift = (day, by) => new Date(Date.parse(`${day}T12:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);

before(() => dayPages.open());

after(() => dayPages.close());

describe('days-picker', () => {
  before(() => journey('days-picker'));

  test('D7: the month picker reads nothing, draws the list\'s days with their marks, and keeps every key of the list', async () => {
    const { chrome } = dayPages.opened;
    await load(`#view=days&on=${PAST}`);
    await chrome.until(drawn(PAST));
    const beside = await chrome.evaluate(`[...document.querySelectorAll('.dy-bar .ck-page__tools [data-d-day]')].map(each => each.dataset.dDay)`);
    const ownReads = () => asked.filter(address => {
      const url = new URL(address);
      return /^\/api\/page\/days?$/u.test(url.pathname) && !beside.includes(url.searchParams.get('day'));
    }).length;
    const reads = ownReads();
    await chrome.evaluate(`document.querySelector('[data-d-title]').click()`);
    await chrome.until(`document.activeElement?.dataset.pDay === '${PAST}'`);
    assert.equal(ownReads(), reads, 'the picker read nothing');
    assert.equal(await chrome.evaluate(`document.querySelector('[data-d-title]').getAttribute('aria-expanded')`), 'true');
    const list = listed();
    const month = PAST.slice(0, 7);
    const held = list.filter(each => each.day.startsWith(month));
    const most = Math.max(...held.map(each => each.counts.total));
    const cells = await chrome.evaluate(`[...document.querySelectorAll('.ck-mgrid__day:not(.is-dim):not(.is-out)')]
      .map(cell => [cell.dataset.pDay, cell.querySelector('.ck-mgrid__mark').getBoundingClientRect().width])`);
    assert.deepEqual(cells, held.map(each => [each.day, markOf(each.counts.total, most)]).sort());
    assert.equal(await chrome.evaluate(`document.querySelector('.ck-mgrid__day[data-p-day="${PAST}"]').closest('[role="gridcell"]').getAttribute('aria-selected')`), 'true');
    const empty = await chrome.evaluate(`document.querySelector('.ck-mgrid__day.is-dim:not(.is-out)').dataset.pDay`);
    await chrome.evaluate(`document.querySelector('.ck-mgrid__day[data-p-day="${empty}"]').focus()`);
    assert.equal(await chrome.evaluate(`document.activeElement.getAttribute('aria-disabled')`), 'true');
    await key('Enter');
    assert.ok(await chrome.evaluate(`document.querySelector('.ck-mgrid')`), 'Enter on a day without a date does nothing');
    await chrome.evaluate(`document.querySelector('.ck-mgrid__day[data-p-day="${PAST}"]').focus()`);
    await page.shot('picker', `document.querySelector('.ck-mgrid')`);
    const focused = () => chrome.evaluate('document.activeElement?.dataset.pDay ?? ""');
    const weekday = (new Date(`${PAST}T12:00:00Z`).getUTCDay() + 6) % 7;
    await key('ArrowRight');
    assert.equal(await focused(), shift(PAST, 1));
    await key('ArrowDown');
    assert.equal(await focused(), shift(PAST, 8));
    await key('ArrowUp');
    await key('ArrowLeft');
    assert.equal(await focused(), PAST);
    const firstCell = `${listedDays()[0].slice(0, 7)}-01`;
    const monday = shift(PAST, -weekday);
    await key('Home');
    assert.equal(await focused(), monday < firstCell ? firstCell : monday, 'Home: the week\'s Monday, never before the first listed month');
    await key('End');
    assert.equal(await focused(), shift(PAST, 6 - weekday));
    for (let step = 0; step < 6 - weekday; step += 1) await key('ArrowLeft');
    assert.equal(await focused(), PAST);
    await key('PageDown');
    assert.equal(await focused(), '2026-11-04');
    assert.equal(await chrome.evaluate(`document.querySelector('[data-p-live]').textContent`), 'November 2026');
    await key('Home');
    assert.equal(await focused(), '2026-11-02');
    await key('End');
    assert.equal(await focused(), '2026-11-08');
    for (let step = 0; step < 4; step += 1) await key('ArrowLeft');
    assert.equal(await focused(), '2026-11-04');
    await key('PageUp');
    assert.equal(await focused(), PAST);
    assert.equal(await chrome.evaluate(`document.querySelector('[data-p-live]').textContent`), 'October 2026');
    for (let step = 0; step < 3; step += 1) await key('ArrowDown');
    for (let step = 0; step < 6; step += 1) await key('ArrowRight');
    assert.equal(await focused(), '2026-10-31');
    await key('PageDown');
    assert.equal(await focused(), '2026-11-30');
    assert.equal(await chrome.evaluate(`document.querySelector('[data-p-live]').textContent`), 'November 2026');
    await key('PageUp', SHIFT);
    assert.equal(await focused(), firstCell > '2025-11-30' ? firstCell : '2025-11-30');
    await key('t');
    const today = todayNow();
    assert.equal(await focused(), today);
    assert.equal(await chrome.evaluate(`document.activeElement.getAttribute('aria-current')`), 'date');
    assert.equal(await chrome.evaluate(`document.querySelector('[data-p-today]').disabled`), true);
    await chrome.evaluate(`document.querySelector('.ck-mgrid__year .ck-fmenu__btn').click()`);
    await chrome.until(`!document.querySelector('#dy-pick-years').hidden`);
    const years = [...new Set(list.map(each => each.day.slice(0, 4)))].sort().reverse();
    assert.deepEqual(await chrome.evaluate(`[...document.querySelectorAll('#dy-pick-years [data-value]')].map(item => item.dataset.value)`), years);
    await page.shot('years', `!document.querySelector('#dy-pick-years').hidden`);
    await chrome.evaluate(`document.querySelector('.ck-mgrid__year .ck-fmenu__btn').click()`);
    await chrome.until(`document.querySelector('#dy-pick-years').hidden`);
    await chrome.evaluate(`document.querySelector('[data-d-title]').dataset.testOld = ''`);
    const [dayReads, listReads] = [pageAsked('/api/page/day').length, pageAsked('/api/page/days').length];
    dayPages.front?.tell([{ kind: 'day', key: PAST }]);
    await until('the day and the list read again', () => pageAsked('/api/page/day').length > dayReads && pageAsked('/api/page/days').length > listReads);
    await chrome.until(`document.querySelector('.ck-mgrid') && !document.querySelector('[data-d-title][data-test-old]')
      && document.querySelector('[data-d-title]').getAttribute('aria-expanded') === 'true'`);
    await chrome.evaluate(`document.querySelector('.ck-mgrid__day[data-p-day="${today}"]').focus()`);
    await key('Escape');
    await chrome.until(`!document.querySelector('.ck-mgrid') && document.activeElement?.matches('[data-d-title]')`);
    assert.equal(await chrome.evaluate(`document.querySelector('[data-d-title]').getAttribute('aria-expanded')`), 'false');
    const lists = pageAsked('/api/page/days').length;
    const other = held.map(each => each.day).filter(day => day !== PAST).sort().at(-1);
    assert.ok(other, 'another day of the month');
    await chrome.evaluate(`document.querySelector('[data-d-title]').click()`);
    await chrome.until(`document.activeElement?.dataset.pDay === '${PAST}'`);
    const steps = Math.round((Date.parse(/** @type {string} */ (other)) - Date.parse(PAST)) / 86_400_000);
    for (let step = 0; step < Math.abs(steps); step += 1) await key(steps > 0 ? 'ArrowRight' : 'ArrowLeft');
    assert.equal(await focused(), other);
    await key('Enter');
    await chrome.until(`${drawn(/** @type {string} */ (other))} && !document.querySelector('.ck-mgrid')`);
    assert.equal(pageAsked('/api/page/days').length, lists);
  });
});

describe('days-states', () => {
  before(() => journey('days-states'));

  test('D8: nothing, before the home, no place, as the page answers each, and the skeleton while a day reads', async () => {
    const { chrome } = dayPages.opened;
    const release = holdDay(MIDNIGHT);
    await load(`#view=days&on=${NOTHING}`);
    await chrome.until(`document.querySelector('.dy-day > .ck-none')?.textContent === ${JSON.stringify(PAGE.nothing.line)}`);
    assert.equal(PAGE.nothing.before_home, null);
    assert.equal(await page.count('.dy-row--end'), 0);
    await page.shot('nothing', `document.querySelector('.dy-day > .ck-none')`);
    const first = listedDays()[0];
    await chrome.evaluate(`location.hash = '#view=days&on=${EMPTY}'`);
    await chrome.until(`document.querySelector('.dy-day > .ck-none')?.textContent.includes(${JSON.stringify(PAGE.empty.before_home)})`);
    assert.equal(await chrome.evaluate(`document.querySelector('.dy-day > .ck-none [data-d-day]').dataset.dDay`), first);
    await page.shot('before', `document.querySelector('.dy-day > .ck-none [data-d-day]')`);
    await chrome.evaluate(`location.hash = '#view=days&on=${PLACELESS}'`);
    await chrome.until(drawn(PLACELESS));
    const placeless = PAGE.placeless;
    assert.deepEqual(await chrome.evaluate(`[...document.querySelectorAll('.dy-block')].map(block => block.dataset.dBlock)`), [UNTIMED]);
    assert.deepEqual(await chrome.evaluate(`[...document.querySelectorAll('.dy-list > .dy-item--row .dy-row, .dy-list > .dy-item--plan .dy-row')]
      .map(row => row.dataset.dAt)`), [...placeless.all_day, ...placeless.chapters.flatMap(chapter => chapter.blocks.flatMap(block => block.rows))]
      .map(row => row.key));
    assert.equal(await chrome.evaluate(`document.querySelector('.dy-list').textContent.includes('No place recorded')`), false);
    await chrome.until(`document.querySelector('.dy-side [data-side-part="people"]:not(.is-reading)')`);
    assert.equal(await page.count('.dy-side [data-map], .dy-side [data-side-part="places"]'), 0);
    await page.shot('no-place', drawn(PLACELESS));
    await chrome.evaluate(`document.querySelector('.dy-list > .dy-item--row [data-d-at="e4"]').click()`);
    await chrome.until(`location.hash.includes('focus=e4') && document.querySelector('.dy-panel.is-open')`);
    await chrome.evaluate(`document.querySelector('.dy-list > .dy-item--row [data-d-at="e4"]').click()`);
    await chrome.until(`!document.querySelector('.dy-panel.is-open')`);
    await chrome.evaluate(`location.hash = '#view=days&on=${MIDNIGHT}'`);
    await chrome.until(`document.querySelector('.dy.ck-reading') && document.querySelectorAll('.dy-block.is-reading').length === 3`);
    assert.equal(await page.count('.dy-item--move.is-reading'), 2);
    assert.equal(await page.count('.dy-list[aria-hidden="true"] ~ .ck-sk-wait'), 1);
    await page.shot('reading', `document.querySelector('.dy.ck-reading')`);
    release();
    await chrome.until(drawn(MIDNIGHT));
  });
});

describe('days-import', () => {
  before(() => journey('days-import'));

  test('D14: a day before the home\'s first draws the home\'s words and links the first day of the list read anew, never the old one', async () => {
    const { chrome } = dayPages.opened;
    const stand = /** @type {NonNullable<typeof dayPages.front>} */ (dayPages.front);
    await load(`#view=days&on=${PAST}`);
    await chrome.until(drawn(PAST));
    await until('the list read', () => dayPages.landed('/api/page/days') === 1);
    const link = `document.querySelector('.dy-day > .ck-none [data-d-day]')?.dataset.dDay`;
    await chrome.evaluate(`location.hash = '#view=days&on=${EMPTY}'`);
    await chrome.until(`document.querySelector('.dy-day > .ck-none')?.textContent.includes(${JSON.stringify(PAGE.empty.before_home)})`);
    assert.equal(await chrome.evaluate(link), PAST);
    await page.shot('before', `document.querySelector('.dy-day > .ck-none [data-d-day]')`);
    dayPages.hide(PAST);
    stand.tell([{ kind: 'day', key: PAST }]);
    await until('the list read anew', () => dayPages.landed('/api/page/days') === 2);
    await chrome.evaluate(`location.hash = '#view=days&on=${TODAY}'`);
    await chrome.until(drawn(TODAY));
    await chrome.evaluate(`location.hash = '#view=days&on=${EMPTY}'`);
    await chrome.until(`${drawn(EMPTY)} && (${link}) === ${JSON.stringify(listedDays()[0])}`);
    assert.equal(listedDays()[0], TODAY);
    assert.deepEqual(pageAsked('/api/page/days'), [WHOLE, WHOLE]);
    await page.shot('before-anew', `document.querySelector('.dy-day > .ck-none [data-d-day]')`);
  });
});

describe('days-today', () => {
  before(() => journey('days-today'));

  test('D8: today live: the now row, the open stay with no end, the plans apart after now, a burst read once with the open set and the scroll kept', async () => {
    const { chrome } = dayPages.opened;
    const now = Date.parse(`${TODAY}T14:00:00Z`);
    await load('#view=days', nowAt(now));
    await chrome.until(`${drawn(TODAY)} && document.querySelector('.dy-row--now')`);
    assert.equal(await page.words('.dy-bar__word'), 'Today');
    assert.equal(await page.words('.dy-row--now .dy-row__name'), 'Now');
    await chrome.until(`/^Updated \\d\\d:\\d\\d$/u.test(document.querySelector('.dy-row--now .dy-row__count')?.textContent ?? '')`);
    assert.equal(await page.count('.dy-row--now .dy-row__words'), 0);
    const open = /** @type {import('../public/pages.js').DayChapter} */ (PAGE.today.chapters.find(chapter => chapter.kind === 'stay' && chapter.end_ms === null));
    assert.equal(open.head?.length, null);
    assert.equal(await chrome.evaluate(`document.querySelector('.dy-block[data-d-block="${open.key}"] .dy-head__length').textContent`),
      `since ${clock(open.start_ms)}`);
    assert.deepEqual(await chrome.evaluate(`[...document.querySelectorAll('.dy-list > .dy-item')].slice([...document.querySelectorAll('.dy-list > .dy-item')]
      .findIndex(item => item.matches('.dy-item--now')) + 1).filter(item => item.matches('.dy-item--plan')).map(item => item.querySelector('[data-d-at]').dataset.dAt)`),
      PAGE.today.plans.map(plan => plan.key));
    assert.equal(await page.count('.dy-block .dy-row--plan'), 0);
    await chrome.evaluate(`document.querySelector('.dy-block [data-d-stay]').click()`);
    await chrome.until(`document.querySelector('.dy-block.is-open')`);
    const key_ = await chrome.evaluate(`document.querySelector('.dy-block.is-open').dataset.dBlock`);
    await chrome.evaluate(`document.querySelector('.dy-scroll').scrollTop = 40`);
    const scrolled = await chrome.evaluate(`document.querySelector('.dy-scroll').scrollTop`);
    await page.shot('today', `document.querySelector('.dy-row--now')`);
    const reads = served.get(TODAY) ?? 0;
    dayPages.front?.tell([{ kind: 'day', key: TODAY }]);
    await until('the day read again', () => (served.get(TODAY) ?? 0) === reads + 1);
    await chrome.until(`document.querySelector('.dy-block[data-d-block="${key_}"]')?.classList.contains('is-open')`);
    assert.equal(await chrome.evaluate(`document.querySelector('.dy-scroll').scrollTop`), scrolled);
    assert.deepEqual(await chrome.evaluate(`[...document.querySelectorAll('.dy-block.is-open')].map(block => block.dataset.dBlock)`), [key_]);
    assert.equal(served.get(TODAY), reads + 1);
    await chrome.evaluate(`location.hash = '#view=days&on=${PAST}'`);
    await chrome.until(drawn(PAST));
    const past = served.get(PAST) ?? 0;
    const today = served.get(TODAY) ?? 0;
    await chrome.evaluate(`location.hash = '#view=days&on=${TODAY}'`);
    await chrome.until(`${drawn(TODAY)} && document.querySelector('.dy-block[data-d-block="${key_}"]')?.classList.contains('is-open')`);
    await until('today read behind what is drawn', () => (served.get(TODAY) ?? 0) === today + 1);
    await chrome.until(`document.querySelector('.dy-block[data-d-block="${key_}"]')?.classList.contains('is-open')`);
    assert.equal(await chrome.evaluate(`document.querySelector('.dy-scroll').scrollTop`), scrolled);
    await chrome.evaluate(`location.hash = '#view=days&on=${PAST}'`);
    await chrome.until(drawn(PAST));
    assert.equal(served.get(PAST) ?? 0, past);
  });
});

describe('days-known', () => {
  before(() => journey('days-known'));

  test('D13: today\'s "Updated" is the page\'s: drawn with the day, kept through each minute and a fold, the day read once', async () => {
    const { chrome } = dayPages.opened;
    const at = Date.parse(`${TODAY}T16:30:00Z`);
    await load(`#view=days&on=${TODAY}`, nowAt(at));
    /** @param {number} minutes */
    const tick = minutes => chrome.evaluate(`window.by += ${minutes * 60_000}; window.minute.forEach(run => run())`);
    const now = () => chrome.evaluate(`document.querySelector('.dy-row--now')?.getAttribute('aria-label')`);
    const known = `updated ${clock(/** @type {number} */ (PAGE.today.updated_ms))}`;
    await chrome.until(`${drawn(TODAY)} && document.querySelector('.dy-row--now')`);
    assert.equal(await now(), `Now, ${clock(at)}, ${known}`);
    assert.equal(await page.words('.dy-row--now .dy-row__count'), `Updated ${clock(/** @type {number} */ (PAGE.today.updated_ms))}`);
    await tick(5);
    await chrome.until(`document.querySelector('.dy-row--now')?.getAttribute('aria-label') === ${JSON.stringify(`Now, ${clock(at + 5 * 60_000)}, ${known}`)}`);
    await tick(1);
    assert.equal(await now(), `Now, ${clock(at + 6 * 60_000)}, ${known}`);
    await chrome.evaluate(`window.told = document.querySelector('.dy-row--now')`);
    await key('ArrowRight', ALT);
    await chrome.until(`document.querySelector('.dy-row--now') !== window.told`);
    assert.equal(await now(), `Now, ${clock(at + 6 * 60_000)}, ${known}`);
    assert.equal(served.get(TODAY), 1, 'the day read once');
  });
});

describe('days-ahead', () => {
  before(() => journey('days-ahead'));

  test('D10: a day read ahead never lands under the open day, whose own read has not landed', async () => {
    const { chrome } = dayPages.opened;
    dayPages.serve([NOTHING]);
    const nothing = holdDay(NOTHING);
    const other = holdDay(PAST);
    await load(`#view=days&on=${TODAY}`, nowAt(Date.parse(`${TODAY}T14:00:00Z`)));
    await chrome.until(drawn(TODAY));
    await until('the days either side asked', () => [NOTHING, PAST].every(day => pageAsked('/api/page/day').includes(`?day=${day}`)));
    await chrome.evaluate(`location.hash = '#view=days&on=${NOTHING}'`);
    await chrome.until(`document.querySelector('.dy.ck-reading')`);
    other();
    await until('the other day served', () => (served.get(PAST) ?? 0) > 0);
    await chrome.evaluate('new Promise(done => requestAnimationFrame(() => setTimeout(done)))');
    await chrome.evaluate(`location.hash = '#view=days&on=${TODAY}'`);
    await chrome.until(drawn(TODAY));
    await chrome.evaluate(`location.hash = '#view=days&on=${NOTHING}'`);
    await chrome.until(`location.hash.includes('on=${NOTHING}') && document.querySelector('.dy.ck-reading')`);
    assert.equal(await page.count('.dy-block:not(.is-reading)'), 0);
    nothing();
    await chrome.until(`document.querySelector('.dy-day > .ck-none')?.textContent === ${JSON.stringify(PAGE.nothing.line)}`);
    assert.equal(await page.count('.dy-block'), 0);
  });
});

describe('days-warm', () => {
  before(() => journey('days-warm'));

  test('D12: a window nobody sees mounts no Days and reads none of it; shown, Days stands unseen behind the first page', async () => {
    const { chrome } = dayPages.opened;
    await load('#view=connectors', `(() => {
      const later = window.setTimeout;
      window.setTimeout = (run, ms, ...rest) => later(run, ms === 1000 ? 0 : ms, ...rest);
      window.seen = 'hidden';
      Object.defineProperty(document, 'visibilityState', { get: () => window.seen });
    })()`);
    await chrome.until(`document.querySelector('.main__section--connectors')`);
    await chrome.evaluate('new Promise(done => requestAnimationFrame(() => setTimeout(done)))');
    assert.equal(await page.count('.main__section--days'), 0);
    assert.deepEqual(pageAsked('/api/page/day'), []);
    await chrome.evaluate(`window.seen = 'visible'; document.dispatchEvent(new Event('visibilitychange'))`);
    await chrome.until(`document.querySelector('.main__section--days')?.hidden === true`);
    await until('the day read unseen', () => pageAsked('/api/page/day').length > 0);
    assert.equal(await chrome.evaluate(`document.querySelector('.main__section--connectors').hidden`), false);
  });
});
