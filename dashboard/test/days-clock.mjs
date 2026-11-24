import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_A, daysPage, drawn, HOME_DAY, MIDNIGHT, NOTHING, nowAt, PAST, TODAY, WHOLE } from './stand-ins/days-page.mjs';
import { clockFor } from './stand-ins/clock.mjs';
import { until } from './until.mjs';
import { dayAt } from '../public/lib/home-clock.js';

const dayPages = daysPage({ file: 'days-clock', mutable: true });
const { page, served, journey, pageAsked, listReads, load, fromDoor, pickerDays, listedDays } = dayPages;

before(() => dayPages.open());

after(() => dayPages.close());

describe('days-clock', () => {
  before(() => journey('days-clock'));

  test('D14: the home started again with other days: the clock read at the reset, the Today mark moved to the day it names', async () => {
    const { chrome } = dayPages.opened;
    await load(`#view=days&on=${PAST}`);
    await chrome.until(drawn(PAST));
    await chrome.until(`!document.querySelector('[data-d-today]').disabled`);
    assert.notEqual(await page.words('.dy-bar__word'), 'Today');
    const clockReads = pageAsked('/api/clock').length;
    dayPages.front?.clocked({ id: 'the-day-is-now', zone: 'UTC', start_hour: 4,
      runs: [{ day: PAST, start_ms: Date.now() - 12 * 3_600_000, days: 1, zone: 'UTC' }] });
    dayPages.front?.reset();
    await until('the clock read at the reset', () => pageAsked('/api/clock').length > clockReads);
    await chrome.until(`document.querySelector('[data-d-today]').disabled && document.querySelector('.dy-bar__word')?.textContent === 'Today'`);
    await page.shot('today-moved', drawn(PAST));
    dayPages.front?.clocked(null);
    const again = pageAsked('/api/clock').length;
    dayPages.front?.reset();
    await until('the home\'s clock read again', () => pageAsked('/api/clock').length > again);
    await chrome.until(`!document.querySelector('[data-d-today]').disabled`);
  });
});

const TIMES = `[...document.querySelectorAll('.dy-list [data-c="time"]')].map(each => each.textContent)`;

describe('days-reclock', () => {
  before(() => journey('days-reclock'));

  test('D15: a day drawn before the first clock is read: printed again in the clock\'s zone once it lands, from the day held', async () => {
    const { chrome } = dayPages.opened;
    dayPages.front?.clocked(clockFor('Asia/Kolkata', 4, { id: 'kolkata' }));
    const release = dayPages.front?.holdClock();
    await load(`#view=days&on=${MIDNIGHT}`);
    await chrome.until(drawn(MIDNIGHT));
    /** @type {string[]} */
    const before = await chrome.evaluate(TIMES);
    assert.ok(before.some(time => /\d\d:\d\d/u.test(time)), 'times drawn');
    const reads = served.get(MIDNIGHT) ?? 0;
    release?.();
    const shifted = before.map(time => time.replace(/(\d\d):(\d\d)/gu, (_, hours, minutes) => {
      const at = (Number(hours) * 60 + Number(minutes) + 330) % 1440;
      return `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`;
    }));
    await chrome.until(`JSON.stringify(${TIMES}) === ${JSON.stringify(JSON.stringify(shifted))}`);
    assert.equal(served.get(MIDNIGHT) ?? 0, reads, 'printed again from the day held, not read again');
    await page.shot('reclocked', drawn(MIDNIGHT));
  });
});

describe('days-turn', () => {
  before(() => journey('days-turn'));

  test('D16: the day turns while Days is hidden: shown again, the day is read again and drawn as the home answers it, with no now, and its minute ticks none', async () => {
    const { chrome } = dayPages.opened;
    const now = Date.parse(`${TODAY}T14:00:00Z`);
    await load(`#view=days&on=${TODAY}`, nowAt(now));
    await chrome.until(`${drawn(TODAY)} && document.querySelector('.dy-row--now')
      && !document.querySelector('[data-d-title]').disabled`);
    assert.equal(await page.words('.dy-bar__word'), 'Today');
    await chrome.evaluate(`location.hash = '#view=search'`);
    await chrome.until(`document.querySelector('.dy').closest('[hidden]')`);
    const reads = served.get(TODAY) ?? 0;
    dayPages.answerWith(TODAY, 'turned');
    const turned = dayAt(now).end_ms + 3_600_000 - now;
    await chrome.evaluate(`window.by += ${turned}; document.dispatchEvent(new Event('visibilitychange'))`);
    assert.equal(await chrome.evaluate(`Boolean(document.querySelector('.dy-row--now'))`), true, 'hidden, Days drew nothing');
    await chrome.evaluate(`location.hash = '#view=days&on=${TODAY}'`);
    await chrome.until(`!document.querySelector('.dy').closest('[hidden]') && !document.querySelector('.dy-row--now')
      && !document.querySelector('[data-d-today]').disabled && !document.querySelector('[data-d-title]').disabled`);
    assert.ok((served.get(TODAY) ?? 0) > reads, 'read again once the day turned');
    await chrome.evaluate(`window.minute.forEach(run => run())`);
    assert.equal(await chrome.evaluate(`Boolean(document.querySelector('.dy-row--now'))`), false, 'no now ticked on a past day');
  });
});

describe('people-changed', () => {
  before(() => journey('people-changed'));

  test('Y5: a people event that changed no one past the list held reads nothing, page or dashboard; one that did reads once each', async () => {
    const { chrome } = dayPages.opened;
    const stand = /** @type {NonNullable<typeof dayPages.front>} */ (dayPages.front);
    await load('#view=people');
    await chrome.until('document.querySelector("[data-person]") && !document.querySelector(".ck-reading")');
    await until('the list read', () => pageAsked('/api/page/people').length === 1 && listReads() === 1);
    const reports = () => pageAsked('/api/page/connectors').length;
    const { position } = await fromDoor('/v1/page/people');
    let heard = reports();
    stand.tell([{ kind: 'people', key: 'people', detail: { position: stand.told(), changed: position } },
      { kind: 'import', key: `cameras:local:macbook-pro-0001/synthetic-${Date.now()}` }]);
    await until('the burst heard', () => reports() > heard);
    assert.deepEqual([pageAsked('/api/page/people').length, listReads()], [1, 1]);
    const told = stand.people.length;
    await page.command('message', { key: `${CHAT_A}:P1`, at: Date.parse(`${HOME_DAY}T19:00:00Z`), text: 'synthetic people message' });
    await until('the list read again', () => pageAsked('/api/page/people').length > 1);
    heard = reports();
    stand.tell([{ kind: 'import', key: `cameras:local:macbook-pro-0001/synthetic-${Date.now()}` }]);
    await until('the marker heard', () => reports() > heard);
    const reads = pageAsked('/api/page/people').length - 1;
    await until('the dashboard\'s reads for the page', () => listReads() - 1 === reads);
    const changes = new Set(stand.people.slice(told).map(each => each.changed).filter(changed => changed !== position)).size;
    assert.ok(reads >= 1 && reads <= changes, JSON.stringify({ reads, changes, people: stand.people.slice(told) }));
    assert.equal(listReads() - 1, reads);
    await page.shot('people', '!document.querySelector(".ck-reading")');
  });
});

describe('days-list', () => {
  before(() => journey('days-list'));

  test('Y1: the day list read whole once; a day the home tells reads it whole again, and a day it now lists lands in the picker', async () => {
    const { chrome } = dayPages.opened;
    const stand = /** @type {NonNullable<typeof dayPages.front>} */ (dayPages.front);
    await load(`#view=days&on=${PAST}`);
    await chrome.until(drawn(PAST));
    await until('the list read', () => dayPages.landed('/api/page/days') === 1);
    assert.deepEqual(pageAsked('/api/page/days'), [WHOLE]);
    const month = PAST.slice(0, 7);
    assert.ok(!(await pickerDays(month)).includes(NOTHING), 'the home does not list the day yet');
    dayPages.serve([NOTHING]);
    stand.tell([{ kind: 'day', key: NOTHING }]);
    await until('the list read again', () => dayPages.landed('/api/page/days') === 2);
    await until('the new day in the picker', async () => (await pickerDays(month)).includes(NOTHING));
    assert.deepEqual(await pickerDays(month), listedDays(month));
    assert.deepEqual(pageAsked('/api/page/days'), [WHOLE, WHOLE]);
    await page.shot('new-day', drawn(PAST));
  });
});

const EVER_DRAWN = `window.everDrawn = new Set();
new MutationObserver(() => document.querySelectorAll('[data-d-day], .ck-mgrid__day:not(.is-dim)').forEach(each =>
  window.everDrawn.add(each.dataset.dDay || each.dataset.pDay))).observe(document, { childList: true, subtree: true });`;

describe('days-removed', () => {
  before(() => journey('days-removed'));

  test('Y6 Y7: a list answer older than the one drawn, come after a reset, never drawn; a day removed leaves the picker, after a failed read too', async () => {
    const { chrome } = dayPages.opened;
    const stand = /** @type {NonNullable<typeof dayPages.front>} */ (dayPages.front);
    const month = PAST.slice(0, 7);
    const next = `[...document.querySelectorAll('.dy-bar .ck-page__tools [data-d-day]')].at(-1)?.dataset.dDay`;
    dayPages.serve([NOTHING]);
    await load(`#view=days&on=${PAST}`, EVER_DRAWN);
    await chrome.until(`${drawn(PAST)} && ${next} === ${JSON.stringify(TODAY)}`);
    await until('the list read', () => dayPages.landed('/api/page/days') === 1);
    dayPages.hide(TODAY);
    stand.tell([{ kind: 'day', key: TODAY }]);
    await until('the list read again', () => dayPages.landed('/api/page/days') === 2);
    await chrome.until(`${next} === ${JSON.stringify(NOTHING)}`);
    assert.deepEqual(await pickerDays(month), listedDays(month));
    await chrome.evaluate('window.everDrawn.clear()');
    dayPages.staleNext();
    stand.reset();
    await until('the reset\'s list read answered with the older list', () => dayPages.landed('/api/page/days') === 3);
    stand.tell([{ kind: 'day', key: PAST }]);
    await until('the next list read asked, the older answer handled', () => pageAsked('/api/page/days').length === 4);
    await until('the next list read answered', () => dayPages.landed('/api/page/days') === 4);
    await chrome.until(`${drawn(PAST)} && ${next} === ${JSON.stringify(NOTHING)}`);
    assert.equal(await chrome.evaluate(`window.everDrawn.has(${JSON.stringify(TODAY)})`), false);
    assert.deepEqual(await pickerDays(month), listedDays(month));
    await page.shot('restored', drawn(PAST));
    dayPages.hide(NOTHING);
    stand.tell([{ kind: 'day', key: NOTHING }]);
    await until('the removed day\'s list read', () => dayPages.landed('/api/page/days') === 5);
    await until('the day gone from the picker', async () => !(await pickerDays(month)).includes(NOTHING));
    dayPages.serve([TODAY]);
    stand.tell([{ kind: 'day', key: TODAY }]);
    await until('the day listed again', async () => (await pickerDays(month)).includes(TODAY));
    const reads = dayPages.landed('/api/page/days');
    dayPages.hide(TODAY);
    dayPages.failList();
    stand.tell([{ kind: 'day', key: TODAY }]);
    await until('the failed list read', () => dayPages.failed() === 1 && dayPages.landed('/api/page/days') === reads + 1);
    assert.ok((await pickerDays(month)).includes(TODAY), 'still listed: the read failed');
    stand.tell([{ kind: 'day', key: '2026-09-01' }]);
    await until('the list read after the failure', () => dayPages.landed('/api/page/days') === reads + 2);
    await until('the failed day gone from the picker', async () => !(await pickerDays(month)).includes(TODAY));
    assert.ok(pageAsked('/api/page/days').every(search => search === WHOLE), JSON.stringify(pageAsked('/api/page/days')));
    assert.deepEqual(await pickerDays(month), listedDays(month));
    await page.shot('removed', drawn(PAST));
  });
});
