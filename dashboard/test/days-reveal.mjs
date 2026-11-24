import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BRIEF, daysPage, drawn, FIXTURE_MS, MOMENTS, NOTHING, PAST, SIDE, THREAD, TODAY, WHOLE } from './stand-ins/days-page.mjs';
import { until } from './until.mjs';
import { clock, duration } from '../public/lib/words.js';

const dayPages = daysPage({ file: 'days-reveal' });
const { page, journey, pageAsked, waitingPaths, holdPath, load, pickerDays, listedDays } = dayPages;

/** @param {string} day */
const reads = day => pageAsked('/api/page/day').filter(search => new URLSearchParams(search).get('day') === day).length;

before(() => dayPages.open());

after(() => dayPages.close());

describe('days-widths', () => {
  before(() => journey('days-widths'));

  test('D9: the main column W at a pane of 1056; the rows two lines at 700', async () => {
    const { chrome } = dayPages.opened;
    dayPages.answerWith(BRIEF, 'brief');
    dayPages.serve([BRIEF]);
    await load(`#view=days&on=${BRIEF}`);
    await chrome.until(drawn(BRIEF));
    /** @param {number} pane */
    const sized = async (/** @type {number} */ pane) => {
      for (let turn = 0; turn < 3; turn += 1) {
        const [window_, page_] = await chrome.evaluate(`[innerWidth, document.querySelector('.dy').getBoundingClientRect().width]`);
        if (Math.round(page_) === pane) break;
        await chrome.size(Math.round(window_ - page_ + pane), 900);
        await chrome.until(`innerWidth === ${Math.round(window_ - page_ + pane)}`);
      }
      await chrome.until(`Math.round(document.querySelector('.dy').getBoundingClientRect().width) === ${pane}`);
    };
    const main = `Math.round(document.querySelector('.dy-main').getBoundingClientRect().width)`;
    await sized(1056);
    await chrome.until(`document.querySelector('.dy-side .ds--rail .ds-figures .ck-figrow__figure') && !document.querySelector('.dy-side [data-map]')
      && document.querySelector('.dy-side [data-side-part="places"]:not(.is-reading) [data-d-unit]')
      && document.querySelector('.dy-side [data-side-part="people"]:not(.is-reading) [data-d-who]')`);
    const column = 1056 - 408 - 48;
    assert.equal(await chrome.evaluate(main), column);
    assert.deepEqual(await chrome.evaluate(`(() => {
      const box = selector => document.querySelector(selector).getBoundingClientRect();
      return { bar: Math.round(box('.dy-bar').width), title: Math.round(box('.dy-lead').left - box('.dy-main').left),
        tools: Math.round(box('.dy').right - box('.dy-bar .ck-page__tools').right) };
    })()`), { bar: 1056, title: 0, tools: 24 });
    await page.shot('pane-1056', drawn(BRIEF));
    await sized(1055);
    await page.shot('pane-1055', drawn(BRIEF));
    await sized(700);
    await chrome.evaluate(`document.querySelector('[data-d-stay]').dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }))`);
    await chrome.until(`document.querySelector('.dy-block.is-open .dy-row[data-k="row"]')`);
    const rowHeight = `document.querySelector('.dy-block.is-open .dy-row[data-k="row"]').getBoundingClientRect().height`;
    const narrow = await chrome.evaluate(rowHeight);
    await page.shot('pane-700', `document.querySelector('.dy-block.is-open')`);
    await chrome.size(1440, 900);
    await chrome.until(`innerWidth === 1440`);
    const wide = await chrome.evaluate(rowHeight);
    assert.ok(narrow > wide, JSON.stringify({ narrow, wide }));
  });
});

describe('days-reveal', () => {
  before(() => journey('days-reveal'));

  test('D10: a person People holds opens their page, one it does not reveals their rows under the bar, a group opens its conversation', async () => {
    const { chrome } = dayPages.opened;
    dayPages.answerWith(SIDE, 'side');
    dayPages.serve([SIDE]);
    await load(`#view=days&on=${SIDE}`);
    await chrome.until(drawn(SIDE));
    const known = '.dy-side [data-d-who][data-d-rows~="e13"]';
    await chrome.until(`document.querySelector('${known}')`);
    assert.deepEqual(await chrome.evaluate(`(() => { const row = document.querySelector('${known}');
      return [row.localName, row.getAttribute('href')?.startsWith('#view=people&focus='), row.hasAttribute('data-d-person')]; })()`),
    ['a', true, false]);
    await chrome.until(`document.querySelector('.dy-side [data-side-part="groups"] [data-d-group="e78"]')`);
    assert.equal(await page.count('.dy-side [data-side-part="people"] [data-d-rows~="e78"]'), 0);
    assert.equal(await page.count('.dy-block[data-d-block="quiet"]'), 0);
    const person = '.dy-side [data-side-part="people"]:not(.is-reading) [data-d-person]';
    await chrome.until(`document.querySelector('${person}')`);
    const rows = String(await chrome.evaluate(`document.querySelector('${person}').dataset.dRows`)).split(' ');
    assert.ok(rows.length > 0 && rows.every(Boolean), JSON.stringify(rows));
    const first = String(await chrome.evaluate(`document.querySelector('.dy-block--stay').dataset.dBlock`));
    await chrome.evaluate(`document.querySelector('.dy-block--stay > [data-d-stay]').click()`);
    await chrome.until(`document.querySelector('.dy-block--stay').classList.contains('is-open')`);
    await chrome.until(`document.querySelector('.dy-block--stay').getAnimations({ subtree: true }).length === 0`);
    await page.click(person);
    await chrome.until(`${JSON.stringify(rows)}.every(id => document.querySelector('[data-d-at="' + id + '"]'))`);
    assert.deepEqual(await chrome.evaluate(`${JSON.stringify(rows)}.map(id => {
      const row = document.querySelector('[data-d-at="' + id + '"]');
      return [Boolean(row.closest('.dy-block.is-open')), !row.closest('.dy-hour') || row.closest('.dy-hour').classList.contains('is-open')];
    })`), rows.map(() => [true, true]));
    assert.equal(await chrome.evaluate(`document.querySelector('.dy-block[data-d-block=${JSON.stringify(first)}]').classList.contains('is-open')`), true);
    const [top, bottom, headBottom, margin, rowTop, rowBottom, end] = await chrome.evaluate(`(() => {
      const box = document.querySelector('.dy-scroll');
      const scroll = box.getBoundingClientRect();
      const element = document.querySelector('[data-d-at="${rows[0]}"]');
      const row = element.getBoundingClientRect();
      const head = element.closest('.dy-block').querySelector(':scope > .dy-head').getBoundingClientRect();
      return [scroll.top, scroll.bottom, head.bottom, parseFloat(getComputedStyle(element).scrollMarginTop), row.top, row.bottom,
        box.scrollTop + box.clientHeight >= box.scrollHeight - 1];
    })()`);
    assert.ok(rowTop >= Math.max(top, headBottom) && rowBottom <= bottom && (rowTop <= top + margin + 1 || end),
      JSON.stringify({ top, bottom, headBottom, margin, rowTop, rowBottom, end }));
    await page.shot('revealed', `document.querySelector('[data-d-at="${rows[0]}"]')`);
    await page.click('.dy-side [data-d-group="e78"]');
    await chrome.until(`location.hash.includes('focus=e78') && document.querySelector('.dy-panel.is-open')`);
    await chrome.until(`document.querySelector('.dy-panel').contains(document.activeElement)`);
    await chrome.press('Escape');
    await chrome.until(`!document.querySelector('.dy-panel.is-open') && document.activeElement?.matches('.dy-side [data-d-group="e78"]')`);
    await chrome.size(700, 900);
    await chrome.until(`document.querySelector('[data-d-pill="people"]')`);
    await page.click('[data-d-pill="people"]');
    await chrome.until(`document.querySelector('#ck-pop-people [data-d-group="e78"]')`);
    await page.click('#ck-pop-people [data-d-group="e78"]');
    await chrome.until(`!document.querySelector('.ck-popover') && document.querySelector('.dy-panel.is-open')
      && document.querySelector('.dy-panel').contains(document.activeElement)`);
    await chrome.press('Escape');
    await chrome.until(`!document.querySelector('.dy-panel.is-open') && document.activeElement?.matches('[data-d-pill="people"]')`);
    await chrome.size(1440, 900);
    await chrome.until(`document.querySelector('.dy-side [data-d-group="e78"]')`);
    await page.click('.dy-side [data-d-group="e78"]');
    await chrome.until(`document.querySelector('.dy-panel.is-open') && document.querySelector('.dy-panel').contains(document.activeElement)`);
    await chrome.size(700, 900);
    await chrome.until(`document.querySelector('[data-d-pill="people"]') && !document.querySelector('.dy-side [data-d-group="e78"]')?.offsetParent`);
    await chrome.press('Escape');
    await chrome.until(`!document.querySelector('.dy-panel.is-open') && document.activeElement?.matches('[data-d-pill="people"]')`);
    await chrome.size(1440, 900);
  });
});

describe('days-calls', () => {
  before(() => journey('days-calls'));

  test('D11: a call\'s other calls are those its record shares an id with, and its chip the person the home names (page-days.e2e "pins the moments")', async () => {
    const { chrome } = dayPages.opened;
    dayPages.answerWith(SIDE, 'side');
    dayPages.serve([SIDE]);
    const others = `document.querySelector('.dy-panel.is-open [data-d-fill="calls"] .ck-items')`;
    const listed = `({ label: document.querySelector('.dy-panel.is-open [data-d-fill="calls"]').textContent,
      items: [...document.querySelectorAll('.dy-panel.is-open [data-d-fill="calls"] .ck-item')]
        .map(item => [item.querySelector('.ck-item__at').textContent, item.querySelector('.ck-item__title').textContent]) })`;
    await load(`#view=days&on=${SIDE}&focus=e47`);
    await chrome.until(others);
    /** @param {string} name */
    const said = name => {
      const view = /** @type {import('../public/pages.js').DayMoment} */ (MOMENTS[name].moment).view;
      assert.equal(view.view, 'call');
      return view.view === 'call' ? { name: view.name, items: view.others
        .map(other => [clock(other.at_ms), [other.way, other.length_ms === null ? '' : duration(other.length_ms)].filter(Boolean).join(' · ')]) } : null;
    };
    const mine = /** @type {{ label: string, items: string[][] }} */ (await chrome.evaluate(listed));
    const shared = said('call');
    assert.ok(mine.label.startsWith(`Other calls with ${shared?.name} today`), mine.label);
    assert.deepEqual(mine.items, shared?.items, 'drawn as the home says: the call its record shares an id with (page-days.e2e "pins the moments")');
    assert.deepEqual(shared?.items.map(item => item[1]), ['They called · 5m']);
    await page.shot('other-calls', others);
    const named = /** @type {import('../public/pages.js').DayMoment} */ (MOMENTS.call.moment).people[0]?.person;
    assert.equal(named, 'person-a', 'the home names the person whose handle the call\'s record holds');
    await page.click('.dy-panel.is-open .ck-inspector__chips [data-d-person]');
    await chrome.until(`location.hash.includes('view=people') && location.hash.includes(${JSON.stringify(`focus=${encodeURIComponent(named)}`)})`);
    await load(`#view=days&on=${SIDE}&focus=e50`);
    await chrome.until(others);
    const missed = /** @type {{ label: string, items: string[][] }} */ (await chrome.evaluate(listed));
    const held = said('missed');
    assert.ok(missed.label.startsWith(`Other calls with ${held?.name} today`), missed.label);
    assert.deepEqual(missed.items, held?.items);
    assert.deepEqual(held?.items.map(item => item[1]), ['You called · 2m']);
  });
});

const TITLE = `document.querySelector('.dy-panel.is-open .ck-inspector__title')?.textContent`;
const MOMENT_PATH = '/api/page/moment';
const momentsWaiting = () => waitingPaths.get(MOMENT_PATH)?.length ?? 0;

const watchTitles = () => dayPages.opened.chrome.evaluate(`(() => {
  const first = document.querySelector('.dy-panel .ck-inspector__title')?.textContent;
  window.titles = first ? [first] : [];
  new MutationObserver(() => {
    const now = document.querySelector('.dy-panel .ck-inspector__title')?.textContent;
    if (now && now !== window.titles.at(-1)) window.titles.push(now);
  }).observe(document.querySelector('.dy-panel'), { subtree: true, childList: true, characterData: true });
})()`);

describe('days-thread', () => {
  before(() => journey('days-thread'));

  test('D17: an edit to an open thread\'s message redraws it, though the moment around it reads the same', async () => {
    const { chrome } = dayPages.opened;
    dayPages.answerWith(SIDE, 'side');
    dayPages.serve([SIDE]);
    const view = /** @type {import('../public/pages.js').DayMoment} */ (MOMENTS.thread.moment).view;
    assert.ok(view.view === 'thread' && view.chat, 'the pinned moment is a conversation');
    const chat = view.view === 'thread' ? String(view.chat) : '';
    /** @param {string} text @param {boolean} edited */
    const said = (text, edited) => ({ ...THREAD, chat, day: SIDE, messages: [{ ...THREAD.messages[0], text, edited }] });
    dayPages.threadWith(said('synthetic line before', false));
    await load(`#view=days&on=${SIDE}&focus=${MOMENTS.thread.moment?.row}`);
    const thread = `document.querySelector('.dy-panel.is-open [data-d-fill="thread"]')?.textContent ?? ''`;
    await chrome.until(`(${thread}).includes('synthetic line before')`);
    const read = pageAsked(MOMENT_PATH).length;
    dayPages.threadWith(said('synthetic line edited', true));
    dayPages.front?.tell([{ kind: 'day', key: SIDE }]);
    await until('the open moment read again', () => pageAsked(MOMENT_PATH).length > read);
    await chrome.until(`(${thread}).includes('synthetic line edited') && !(${thread}).includes('synthetic line before')`);
  });
});

describe('days-panel-reads', () => {
  before(() => journey('days-panel-reads'));

  test('D18: of two reads of the open moment, the one asked first and landing last is never drawn over the other', async () => {
    const { chrome } = dayPages.opened;
    dayPages.answerWith(SIDE, 'side');
    dayPages.serve([SIDE]);
    const call = MOMENTS.call;
    await load(`#view=days&on=${SIDE}&focus=${call.moment?.row}`);
    await chrome.until(`${TITLE} === ${JSON.stringify(call.moment?.title)}`);
    await watchTitles();
    /** @param {string} title @param {number} seq */
    const titled = (title, seq) => ({ ...call, position: `${seq}:${FIXTURE_MS}`, moment: { .../** @type {import('../public/pages.js').DayMoment} */ (call.moment), title } });
    const release = holdPath(MOMENT_PATH);
    dayPages.momentWith(titled('Synthetic older', 100));
    dayPages.front?.tell([{ kind: 'day', key: SIDE }]);
    await until('the first read held', () => momentsWaiting() === 1);
    dayPages.momentWith(titled('Synthetic newer', 101));
    dayPages.front?.tell([{ kind: 'day', key: SIDE }]);
    await until('the second read held', () => momentsWaiting() === 2);
    const [first, second] = /** @type {(() => void)[]} */ (waitingPaths.get(MOMENT_PATH)?.splice(0));
    release();
    second();
    await chrome.until(`${TITLE} === 'Synthetic newer'`);
    const landed = dayPages.landed(MOMENT_PATH);
    first();
    await until('the first read landed', () => dayPages.landed(MOMENT_PATH) === landed + 1);
    dayPages.momentWith(titled('Synthetic newest', 102));
    dayPages.front?.tell([{ kind: 'day', key: SIDE }]);
    await chrome.until(`${TITLE} === 'Synthetic newest'`);
    assert.deepEqual(await chrome.evaluate('window.titles'), [call.moment?.title, 'Synthetic newer', 'Synthetic newest']);
  });
});

describe('days-panel-left', () => {
  before(() => journey('days-panel-left'));

  test('D19: an answer for a moment the panel has left is never drawn; the moment it went to is', async () => {
    const { chrome } = dayPages.opened;
    dayPages.answerWith(SIDE, 'side');
    dayPages.serve([SIDE]);
    const left = MOMENTS.call;
    const went = MOMENTS.missed;
    const release = holdPath(MOMENT_PATH);
    await load(`#view=days&on=${SIDE}&focus=${left.moment?.row}`);
    await until('the first moment\'s read held', () => momentsWaiting() === 1);
    await watchTitles();
    await chrome.evaluate(`location.hash = ${JSON.stringify(`#view=days&on=${SIDE}&focus=${went.moment?.row}`)}`);
    await until('the second moment\'s read held', () => momentsWaiting() === 2);
    const [first, second] = /** @type {(() => void)[]} */ (waitingPaths.get(MOMENT_PATH)?.splice(0));
    release();
    const landed = dayPages.landed(MOMENT_PATH);
    first();
    await until('the left moment\'s read landed', () => dayPages.landed(MOMENT_PATH) === landed + 1);
    second();
    await chrome.until(`${TITLE} === ${JSON.stringify(went.moment?.title)}`);
    assert.deepEqual(await chrome.evaluate('window.titles'), [went.moment?.title]);
  });
});

describe('days-merge', () => {
  before(() => journey('days-merge'));

  test('Y3: the days two bursts name while the list read runs are one list read after it, and the list ends as the home\'s', async () => {
    const { chrome } = dayPages.opened;
    const release = holdPath('/api/page/days');
    await load(`#view=days&on=${PAST}`);
    await until('the list read held', () => (waitingPaths.get('/api/page/days')?.length ?? 0) === 1);
    await until('the open day read', () => reads(PAST) === 1);
    dayPages.serve([NOTHING]);
    dayPages.front?.tell([{ kind: 'day', key: PAST }]);
    await until('the first burst heard', () => reads(PAST) === 2);
    dayPages.front?.tell([{ kind: 'day', key: PAST }, { kind: 'day', key: NOTHING }]);
    await until('the second burst heard', () => reads(PAST) === 3);
    assert.deepEqual(pageAsked('/api/page/days'), [WHOLE]);
    release();
    await until('the one list read after the held one', () => dayPages.landed('/api/page/days') === 2);
    assert.deepEqual(pageAsked('/api/page/days'), [WHOLE, WHOLE]);
    const month = PAST.slice(0, 7);
    await chrome.until(drawn(PAST));
    await until('the picker drawing the home\'s days', async () => (await pickerDays(month)).join() === listedDays(month).join());
    assert.ok(listedDays(month).includes(NOTHING));
    assert.deepEqual(pageAsked('/api/page/days'), [WHOLE, WHOLE]);
    await page.shot('merged', drawn(PAST));
  });
});

describe('days-reset', () => {
  before(() => journey('days-reset'));

  test('Y3: a reset while the list read runs: the held answer lands, and the whole list is read last', async () => {
    const { chrome } = dayPages.opened;
    const release = holdPath('/api/page/days');
    await load(`#view=days&on=${PAST}`);
    await until('the list read held', () => (waitingPaths.get('/api/page/days')?.length ?? 0) === 1);
    await until('the open day read', () => reads(PAST) === 1);
    dayPages.front?.tell([{ kind: 'day', key: PAST }]);
    await until('the burst heard', () => reads(PAST) === 2);
    dayPages.hide(TODAY);
    dayPages.front?.reset();
    await until('the reset heard', () => reads(PAST) === 3);
    release();
    await until('the reset\'s list read', () => dayPages.landed('/api/page/days') === 2);
    const month = PAST.slice(0, 7);
    await chrome.until(drawn(PAST));
    await until('the picker drawing the home\'s days', async () => (await pickerDays(month)).join() === listedDays(month).join());
    assert.ok(!listedDays(month).includes(TODAY));
    assert.deepEqual(pageAsked('/api/page/days'), [WHOLE, WHOLE]);
    await page.shot('reset', drawn(PAST));
  });
});
