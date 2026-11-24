import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { birthdayMonth } from '../public/lib/calendar.js';
import { FACE, GROUND, PHOTO } from './stand-ins/people-home.mjs';
import { A, JSON_ANSWER, peoplePage, shows, WIDTHS } from './stand-ins/people-page.mjs';
import { until } from './until.mjs';
import { SAVING } from '../public/lib/reach.js';

const page = peoplePage({ file: 'people-edit' });
/** @type {Awaited<ReturnType<typeof page.open>>['home']} */
let home;
/** @type {Awaited<ReturnType<typeof page.open>>['front']} */
let front;
/** @type {Awaited<ReturnType<typeof page.open>>['chrome']} */
let chrome;
/** @type {Awaited<ReturnType<typeof page.open>>['restart']} */
let restart;

before(async () => {
  await page.open();
  await page.organisedA();
});

after(() => page.close());

describe('people-chooser: Choose their photo, sixteen tiles a page', () => {

  before(async () => {
    ({ front, chrome } = await page.journey('people-chooser'));
    front.faces({ state: 'on', scanned: 30, photos: 30 });
  });

  const { shot, click, text, attr, stub, load, stroke, dashboard } = page;

  test('P11: Choose their photo: sixteen tiles a page, the home\'s count, pages read as they are reached, one height', async () => {
    const editing = `document.querySelector('.pl-naming__title')?.textContent === 'Edit person' && document.querySelector('[data-o-field="rel"]')`;
    await load('#view=people&focus=person:person-a', null);
    await chrome.evaluate(`(async () => {
    window.realFetch ??= window.fetch.bind(window);
    const base = (await (await window.realFetch('api/life/people/photos?id=person%3Aperson-a')).json()).photos;
    window.forty = Array.from({ length: 40 }, (_, at) => base[at % base.length]);
    window.pageHeld = new Promise(done => { window.releasePage = done; });
    return true;
  })()`);
    await stub(`(url, init, real) => {
    if (!url.startsWith('api/life/people/photos?')) return real(url, init);
    const asked = new URLSearchParams(url.split('?')[1]);
    const at = Number(asked.get('after') || 0);
    const page = { position: '', photos: window.forty.slice(at, at + 20), total: 40, ...(at + 20 < 40 ? { next: String(at + 20) } : {}) };
    const fails = at === 20 && !window.failedOnce;
    if (fails) window.failedOnce = true;
    return (at ? window.pageHeld : Promise.resolve()).then(() => (${JSON_ANSWER})(fails ? { error: 'Lifestream could not read them.' } : page, fails ? 503 : 200));
  }`);
    await chrome.until(`document.querySelector('[data-people-edit="open"]')`);
    await click('[data-people-edit="open"]');
    await chrome.until(editing);
    await click('[data-o-do="photo"]');
    await chrome.until(`document.querySelectorAll('.pp-window [data-o-frame]').length === 14`);
    const tiles = `document.querySelectorAll('.pp-window .ck-fgrid__faces > *').length`;
    const height = `Math.round(document.querySelector('.pp-window .ck-fgrid').getBoundingClientRect().height)`;
    const step = `document.querySelector('.pp-window .ck-step__value')?.textContent`;
    assert.deepEqual([await chrome.evaluate(tiles), await chrome.evaluate(step)], [16, '1 of 3']);
    assert.equal(await chrome.evaluate(`document.querySelector('.pp-window [data-o-own="now"] img')?.getAttribute('data-src')
    === document.querySelector('.pp-hero__face img')?.getAttribute('data-src')`), true, 'their photo now not the head\'s');
    assert.equal(await chrome.evaluate(`(own => own.matches('span[role="img"]') && Boolean(own.querySelector('.ck-tick.is-on')))(
    document.querySelector('.pp-window [data-o-own="now"]'))`), true, 'their photo now pressable');
    assert.ok((await text('.pp-chooser .ck-section')).join(' ').includes('40'), 'the label holds the home\'s count');
    const tall = await chrome.evaluate(height);
    await click('[data-o-page="1"]');
    await chrome.until(`${step} === '2 of 3' && document.querySelector('.pp-window .ck-fcrop--reading')`);
    assert.deepEqual([await chrome.evaluate(tiles), await chrome.evaluate(height)], [16, tall]);
    await chrome.evaluate('window.releasePage(); true');
    await chrome.until(`document.querySelector('.pp-window .ck-in-place')`);
    assert.equal(await chrome.evaluate(`document.querySelectorAll('.pp-window [data-o-frame]').length`), 6);
    await click('[data-o-page="-1"]');
    await chrome.until(`${step} === '1 of 3'`);
    await click('[data-o-page="1"]');
    await chrome.until(`document.querySelectorAll('.pp-window [data-o-frame]').length === 14 && !document.querySelector('.pp-window .ck-fcrop--reading')
    && !document.querySelector('.pp-window .ck-in-place')`);
    await chrome.evaluate(`document.querySelector('.pp-window [data-o-page="1"]').focus(); true`);
    await stroke('ArrowRight');
    await chrome.until(`${step} === '3 of 3'`);
    assert.deepEqual([await chrome.evaluate(tiles), await chrome.evaluate(height), (await attr('.pp-window [data-o-frame]', 'data-o-frame')).length],
      [16, tall, 12]);
    assert.equal(await chrome.evaluate(`document.querySelector('[data-o-page="1"]').disabled`), true);
    await shot('edit-chooser-last-page', `${step} === '3 of 3'`);
    assert.equal(await chrome.evaluate(`document.querySelector('.pp-window [data-o-chooser]') === document.activeElement`), true,
      'the focus left the chooser');
    await stroke('ArrowLeft');
    await chrome.until(`${step} === '2 of 3'`);
    await click('.pp-foot [data-o-do="cancel"]');
    await chrome.until(`!document.querySelector('.pp-panel')`);
  });

  test('P13: a face group ticked on the card: its photos in the chooser, framed as theirs, gone once unticked', async () => {
    const editing = `document.querySelector('.pl-naming__title')?.textContent === 'Edit person' && document.querySelector('[data-o-field="rel"]')`;
    await load('#view=people&focus=person:person-b', null);
    await chrome.until(`document.querySelector('[data-people-edit="open"]') && document.querySelector('[data-people-retry]') === null`);
    await click('[data-people-edit="open"]');
    await chrome.until(`${editing} && document.querySelector('[data-row="faces"]')`);
    await click('[data-o-do="photo"]');
    await chrome.until(`document.querySelector('.pp-window__head .ck-section__label')?.textContent === 'Their photo' && !document.querySelector('.pp-window .ck-fcrop--reading')`);
    assert.equal(await chrome.evaluate(`document.querySelectorAll('.pp-window [data-o-frame]').length`), 0, 'photos before any is theirs');
    assert.deepEqual(await chrome.evaluate(`[Boolean(document.querySelector('.pp-hero__face img')), document.querySelectorAll('.pp-window .ck-fgrid__faces > *').length,
    Boolean(document.querySelector('.pp-window .ck-fgrid__faces > :disabled'))]`), [false, 1, false]);
    await stub(`(url, init, real) => url.startsWith('api/faces/group?') && !window.groupHeals
    ? (${JSON_ANSWER})({ error: 'Lifestream could not read this face.' }, 503) : real(url, init)`);
    await click('.pp-window [data-o-do="faces"]');
    await chrome.until(`document.querySelector('.pp-window [data-o-pick^="group:"]')`);
    const pick = (await attr('.pp-window [data-o-pick^="group:"]', 'data-o-pick'))[0];
    const id = String(pick).slice('group:'.length);
    await click(`.pp-window [data-o-pick="${pick}"]`);
    const row = `[data-row="a:group-${id}"]`;
    await chrome.until(`document.querySelector('${row}')?.getAttribute('aria-checked') === 'true'`);
    const every = /** @type {string[]} */ ((await dashboard(`/api/faces/group?id=${encodeURIComponent(id)}`)).every);
    const photos = new Set(every.map(face => face.slice(0, face.indexOf(':'))));
    const frames = `document.querySelectorAll('.pp-window [data-o-frame]').length`;
    await click('[data-o-do="photo"]');
    await chrome.until(`document.querySelector('.pp-window .ck-in-place') && ${frames} === 0`);
    await chrome.evaluate('window.groupHeals = true; true');
    await click('[data-o-do="photo"]');
    await chrome.until(`document.querySelector('.pp-window__head .ck-section__label')?.textContent !== 'Their photo'`);
    await click('[data-o-do="photo"]');
    await chrome.until(`${frames} === ${Math.min(14, photos.size)} && !document.querySelector('.pp-window .ck-in-place')`);
    assert.ok((await text('.pp-chooser .ck-section')).join(' ').includes(String(photos.size)), 'the label counts the group\'s photos');
    assert.deepEqual(await chrome.evaluate(`document.querySelectorAll('.pp-window .ck-fgrid__faces > *').length`), 16);
    assert.ok(photos.size <= 14, 'the group\'s photos fit one page');
    assert.deepEqual(await chrome.evaluate(`(() => { const own = document.querySelector('.pp-window [data-o-own="now"] img')?.getAttribute('data-src');
    const label = document.querySelector('.pp-chooser > .ck-section').getBoundingClientRect().height;
    const control = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--size-control-mac'));
    return [Boolean(own) && own === document.querySelector('.pp-hero__face img')?.getAttribute('data-src'),
      Boolean(document.querySelector('.pp-window [data-o-pager]')), label === control]; })()`), [true, false, true]);
    await shot('edit-chooser-group', `${frames} === ${Math.min(14, photos.size)} && [...document.querySelectorAll('.pp-window [data-o-frame] img')].every(img => img.classList.contains('is-loaded'))`);
    const [wide, tall] = await chrome.evaluate(`[innerWidth, innerHeight]`);
    await chrome.size(2400, 1100);
    const [left, right, spills] = await chrome.evaluate(`(() => { const column = document.querySelector('.pp-window__in').getBoundingClientRect();
    const pane = document.querySelector('.pp-window'); const stage = pane.getBoundingClientRect(); const card = document.querySelector('.pp-panel').getBoundingClientRect();
    return [card.left - stage.left, stage.right - column.right, pane.scrollHeight > pane.clientHeight]; })()`);
    assert.ok(Math.abs(left - right) <= 1, `the block centred: ${left} and ${right}`);
    assert.equal(spills, false, 'its four rows stand in the window');
    await chrome.size(wide, tall);
    await click('.pp-window [data-o-frame="0"]');
    await chrome.until(`document.querySelector('.ck-mas:not(.is-refused) .ck-mas__img')?.complete`);
    await click('[data-ck-mas="cancel"]');
    await chrome.until(`${frames} === ${Math.min(14, photos.size)}`);
    await click(`${row} .ck-namerow__end`);
    await chrome.until(`document.querySelector('${row}')?.getAttribute('aria-checked') === 'false'`);
    await chrome.until(`document.querySelector('.pp-window__head .ck-section__label')?.textContent === 'Their photo' && ${frames} === 0
    && !document.querySelector('.pp-window [data-o-own]')`);
    await click('.pp-foot [data-o-do="cancel"]');
    await chrome.until(`!document.querySelector('.pp-panel')`);
  });

  test('P11 P13: a page reached past the album as it shrinks steps from the page shown; a group\'s photo of theirs offered once', async () => {
    const editing = `document.querySelector('.pl-naming__title')?.textContent === 'Edit person' && document.querySelector('[data-o-field="rel"]')`;
    await load('#view=people&focus=person:person-b', null);
    await chrome.evaluate('window.theirsHeld = new Promise(done => { window.releaseTheirs = done; }); true');
    await stub(`(url, init, real) => url.startsWith('api/life/people/photos?')
    && new URLSearchParams(url.split('?')[1]).get('id') === 'person:person-b'
    ? window.theirsHeld.then(() => (${JSON_ANSWER})({ position: '', photos: window.theirs, total: window.theirs.length }))
    : real(url, init)`);
    await chrome.until(`document.querySelector('[data-people-edit="open"]')`);
    await click('[data-people-edit="open"]');
    await chrome.until(`${editing} && document.querySelector('[data-row="faces"]')`);
    await click('.pp-panel [data-row="faces"]');
    await chrome.until(`document.querySelector('.pp-window [data-o-pick^="group:"]')`);
    const pick = (await attr('.pp-window [data-o-pick^="group:"]', 'data-o-pick'))[0];
    const id = String(pick).slice('group:'.length);
    await click(`.pp-window [data-o-pick="${pick}"]`);
    const row = `[data-row="a:group-${id}"]`;
    await chrome.until(`document.querySelector('${row}')?.getAttribute('aria-checked') === 'true'`);
    const every = /** @type {string[]} */ ((await dashboard(`/api/faces/group?id=${encodeURIComponent(id)}`)).every);
    const photos = new Set(every.map(face => face.slice(0, face.indexOf(':'))));
    assert.ok(photos.size >= 1 && photos.size <= 14, 'the group\'s photos fit one page');
    const shared = every[0];
    const hex = (/** @type {number} */ at) => at.toString(16).padStart(64, 'b');
    const theirs = [...Array.from({ length: 28 }, (_, at) => ({ image: hex(at), face: `${hex(at)}:0,0,10,10`, box: [0, 0, 10, 10], at_ms: null,
      crop: null })), { image: shared.slice(0, shared.indexOf(':')), face: shared, box: [0, 0, 10, 10], at_ms: null, crop: null }];
    await chrome.evaluate(`window.theirs = ${JSON.stringify(theirs)}; window.releaseTheirs(); true`);
    await click('[data-o-do="photo"]');
    const step = `document.querySelector('.pp-window .ck-step__value')?.textContent`;
    await chrome.until(`${step} === '1 of 3' && document.querySelectorAll('.pp-window [data-o-frame]').length === 14`);
    assert.deepEqual(await text('.pp-chooser .ck-section__count'), [String(28 + photos.size)], 'the group\'s photo of theirs counted twice');
    await click('[data-o-page="1"]');
    await chrome.until(`${step} === '2 of 3'`);
    await click('[data-o-page="1"]');
    await chrome.until(`${step} === '3 of 3'`);
    await click(`${row} .ck-namerow__end`);
    await chrome.until(`document.querySelector('${row}')?.getAttribute('aria-checked') === 'false' && ${step} === '2 of 2'`);
    await click('[data-o-page="-1"]');
    await chrome.until(`${step} === '1 of 2'`);
    await click('.pp-foot [data-o-do="cancel"]');
    await chrome.until(`!document.querySelector('.pp-panel')`);
  });
});

describe('people-check: Find more photos of them, and back to Edit', () => {

  before(async () => {
    ({ home, front, chrome } = await page.journey('people-check'));
    front.faces({ state: 'on', scanned: 30, photos: 30 });
  });

  const { shot, click, text, go, stub, load, held, landed, landedPast, fill, enter, capture, undoLast } = page;

  test('P12: Find more photos of them: Faces on them alone, Is this Person?, the whole photo, back to Edit as it was', async () => {
    const editing = `document.querySelector('.pl-naming__title')?.textContent === 'Edit person' && document.querySelector('[data-o-field="rel"]')`;
    const maybe = home.faces.faces.m1[0].face;
    await load('#view=people', null);
    await chrome.until(`[...document.querySelectorAll('.pp-side .ck-side__line')].some(each => each.textContent.replace(/\\s/gu, ' ').includes('1 person to check'))`);
    assert.equal(await chrome.evaluate(`/\\bfaces?\\b/iu.test(document.querySelector('.pp-main').innerText)`), false, 'a faces word in the list');
    await go('#view=people&focus=faces');
    await chrome.until(`document.querySelector('.naming-card')`);
    await go('#view=people&focus=faces&on=person:person-a');
    await chrome.until(`document.querySelector('.naming-card.is-check [data-f-face]')`);
    assert.deepEqual(await text('.naming-question'), ['Is this Person?']);
    await go('#view=people&focus=person:person-a');
    await capture();
    await chrome.until(`document.querySelector('[data-people-edit="open"]') && document.querySelector('[data-people-retry]') === null`);
    await click('[data-people-edit="open"]');
    await chrome.until(`${editing} && document.querySelector('[data-row="more"]')`);
    await fill('[data-o-field="rel"]', 'kept while away');
    await click('[data-row="more"]');
    await chrome.until(`location.hash.includes('on=') && document.querySelector('.naming-card.is-check [data-f-face]')`);
    assert.deepEqual(await text('.naming-question'), ['Is this Person?']);
    assert.deepEqual((await text('.naming-rows .ck-namerow__name')), ['This is Person', 'This isn’t Person']);
    assert.ok((await text('.ck-page__back')).join(' ').includes('Person'));
    await shot('faces-check', `document.querySelector('.naming-card.is-check img.is-loaded')`);
    const [x, y] = await chrome.evaluate(`(() => { const box = document.querySelector('[data-f-face]').getBoundingClientRect();
    return [box.x + box.width / 2, box.y + box.height / 2]; })()`);
    await chrome.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    const space = async () => {
      await chrome.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ', unmodifiedText: ' ' });
      await chrome.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    };
    await space();
    await chrome.until(`document.querySelector('.naming-peek__img.is-loaded') && !document.querySelector('.naming-peek__ring').hasAttribute('hidden')`);
    assert.equal(await chrome.evaluate(`document.querySelector('[data-f-peek]').dataset.fPeek`), maybe);
    await shot('faces-check-peek', `document.querySelector('.naming-peek__img.is-loaded')`);
    await space();
    await chrome.until(`!document.querySelector('.naming-peek')`);
    const unknown = 'Lifestream is still working on this.';
    await stub(`(url, init, real) => {
    if (url !== 'api/owner/act') return real(url, init);
    (window.posted ??= []).push(JSON.parse(String(init.body)));
    if (!window.refusedOnce) {
      window.refusedOnce = true;
      return (${JSON_ANSWER})({ error: 'Lifestream refused it.' }, 409);
    }
    const answer = real(url, init);
    if (!window.lostOnce) {
      window.lostOnce = true;
      return answer.then(response => response.json()).then(body => {
        window.lost = body;
        return (${JSON_ANSWER})({ error: ${JSON.stringify(unknown)}, code: 'OUTCOME_UNKNOWN', again: true, began: true }, 503);
      });
    }
    answer.then(response => response.clone().json()).then(body => (window.answered ??= []).push(body));
    return answer;
  }`);
    await enter();
    await chrome.until(`${shows('Not saved: Lifestream refused it.')} && document.querySelector('.naming-card.is-check [data-f-face]')`);
    assert.equal(await chrome.evaluate(`location.hash.includes('on=')`), true, 'a refused last save left Faces');
    const answering = landed();
    await enter();
    await chrome.until(`${editing} && document.querySelector('[data-o-field="rel"]').value === 'kept while away'`);
    await chrome.until('(window.answered ?? []).length === 1');
    await landedPast(answering);
    assert.equal(await chrome.evaluate(shows(unknown)), false, 'a lost answer the resend heard said as unknown');
    assert.equal(landed(), answering + 1, 'the face stated theirs twice');
    const posted = await chrome.evaluate('window.posted');
    assert.deepEqual([posted.length, new Set(posted.map((/** @type {any} */ each) => each.request)).size], [3, 2],
      'a lost answer sent again other than once, as the same request');
    assert.equal((await chrome.evaluate('window.answered'))[0].act, (await chrome.evaluate('window.lost')).act, 'the resend answered other than the kept answer');
    assert.deepEqual((await held()).faces.get(maybe), { is: 'person-a' });
    await chrome.until(`!document.querySelector('[data-row="more"]')`);
    const quiet = landed();
    await click('.pp-foot [data-o-do="cancel"]');
    await chrome.until(`!document.querySelector('.pp-panel')`);
    assert.equal(landed(), quiet);
    await undoLast(await chrome.evaluate('window.lost'));
    assert.equal((await held()).faces.has(maybe), false);
  });
});

describe('people-details: their details, and the head’s chips', () => {

  before(async () => {
    ({ front, chrome } = await page.journey('people-details'));
    front.faces({ state: 'on', scanned: 30, photos: 30 });
  });

  const { shot, click, text, attr, load, held, landed, landedPast, fill, enter, stroke, capture, undoLast, dashboard, act } = page;

  test('P10: their details: Work from their card, a birthday from wishes on the calendar, a profile pasted; the head\'s chips', async () => {
    const editing = `document.querySelector('.pl-naming__title')?.textContent === 'Edit person' && document.querySelector('[data-o-field="rel"]')`;
    const left = `!document.querySelector('.pp-panel') && document.querySelector('[data-people-edit="open"]')`;
    const offered = (await dashboard('/api/page/person?id=person%3Aperson-a')).edit.suggestions;
    const of = (/** @type {string} */ kind) => offered.find((/** @type {any} */ each) => each.kind === kind);
    const [work, wish, found] = [of('work'), of('birthday'), of('profile')];
    const wished = wish?.reasons.find((/** @type {any} */ each) => each.reason === 'wished')?.count;
    assert.deepEqual([work?.value, work?.ticked, wish?.value, wish?.ticked, wished, found?.value, found?.ticked],
      ['Designer, Synthetic Studio', true, '03-14', false, 2, 'instagram:person.a.example', true]);
    await load('#view=people&focus=person:person-a', null);
    await capture();
    await chrome.until(`document.querySelector('[data-people-edit="open"]') && document.querySelector('[data-people-retry]') === null`);
    await click('[data-people-edit="open"]');
    await chrome.until(`${editing} && document.querySelector('[data-o-field="work"]')`);
    assert.equal(await chrome.evaluate(`document.querySelector('[data-o-field="work"]').value`), 'Designer, Synthetic Studio');
    assert.equal(await chrome.evaluate(`Boolean(document.querySelector('[data-row="f:birthday"]'))`), false);
    assert.deepEqual(await text('.ck-form [data-o-do="addbirthday"] .ck-fieldrow__value'), ['Add birthday']);
    assert.deepEqual(await text(`.ck-form [data-o-tick="o:${wish.id}"] :is(.ck-namerow__keyword, .ck-namerow__add)`), ['Suggested', 'Add']);
    assert.equal(await chrome.evaluate(`Boolean(document.querySelector('[data-o-do="addwork"], .ck-chip'))`), false, 'no pill, no chip');
    const unasked = landed();
    await click('.pp-foot [data-o-do="cancel"]');
    await chrome.until(left);
    assert.equal(landed(), unasked, 'Cancel ships the decline');
    await click('[data-people-edit="open"]');
    await chrome.until(`${editing} && document.querySelector('[data-o-tick="o:${wish.id}"]')`);
    await click(`[data-o-tick="o:${wish.id}"] .ck-namerow__end`);
    await chrome.until(`document.querySelector('[data-row="f:birthday"]')?.textContent.includes('14 March')`);
    await click(`[data-o-tick="o:${wish.id}"] .ck-namerow__end`);
    await chrome.until(`!document.querySelector('[data-row="f:birthday"]') && document.querySelector('[data-o-do="addbirthday"]')
    && document.querySelector('[data-o-tick="o:${wish.id}"]')?.getAttribute('aria-checked') === 'false'`);
    await click(`[data-o-tick="o:${wish.id}"] .ck-namerow__name`);
    await chrome.until(`document.querySelector('.pp-window')?.innerText.replace(/\\s/gu, ' ').includes('You wished them on this day in 2 years.')`);
    assert.equal(await chrome.evaluate(`document.querySelectorAll('.pp-window .pp-list').length`), 0, 'a message under the wish');
    await click(`[data-o-tick="o:${wish.id}"] .ck-namerow__end`);
    await chrome.until(`document.querySelector('[data-row="f:birthday"]')?.textContent.includes('14 March')`);
    await click('[data-row="f:birthday"]');
    await chrome.until(`document.querySelector('.pp-cal .ck-mgrid__month')?.textContent === 'March'`);
    assert.deepEqual(await attr('.ck-mgrid__day.is-on', 'data-ck-cal-day'), ['14']);
    await click('[data-ck-cal-day="15"]');
    await chrome.until(`document.querySelector('[data-row="f:birthday"]')?.textContent.includes('15 March') && document.querySelector('.ck-mgrid__day.is-on')?.dataset.ckCalDay === '15'`);
    await fill('[data-ck-cal-year]', '1993');
    await chrome.until(`document.querySelector('[data-row="f:birthday"]')?.textContent.includes('15 March 1993')`);
    for (let ahead = 0; ahead < 5; ahead++) await click('[data-ck-cal-step="1"]');
    await chrome.until(`document.querySelector('.pp-cal .ck-mgrid__month')?.textContent === 'August'`);
    await click('[data-ck-cal-day="15"]');
    await chrome.until(`document.querySelector('[data-row="f:birthday"]')?.textContent.includes('15 August 1993')`);
    await shot('edit-birthday', `document.querySelector('.pp-cal .ck-mgrid')`);
    const within = `(() => { const c = document.querySelector('.pp-cal .ck-mgrid').getBoundingClientRect();
    const b = document.querySelector('.pp-panel__body').getBoundingClientRect();
    return [c.left >= b.left + 16, c.right <= b.right - 16, c.top >= b.top, c.bottom <= b.bottom]; })()`;
    const across = `(() => { const c = document.querySelector('.pp-cal .ck-mgrid').getBoundingClientRect();
    const f = document.querySelector('[data-row="f:birthday"]').getBoundingClientRect();
    const d = document.querySelector('.pp-cal .ck-mgrid__day').getBoundingClientRect();
    return Math.round(d.width) !== 36 ? d.width : Math.round(c.left) === Math.round(f.left) && Math.round(c.right) === Math.round(f.right) ? 'field' : c.width; })()`;
    for (const [width, height, wide] of /** @type {const} */ ([[1440, 900, 'field'], [390, 844, 'field']])) {
      await chrome.size(width, height);
      await chrome.until(`${within}.every(Boolean) && ${across} === ${JSON.stringify(wide)}`);
    }
    await chrome.size(1440, 900);
    await stroke('Escape');
    await chrome.until(`!document.querySelector('.pp-cal') && document.activeElement?.dataset.row === 'f:birthday'`);
    const focused = `document.activeElement?.dataset.ckCalDay`;
    const month = `document.querySelector('.pp-cal .ck-mgrid__month')?.textContent`;
    await enter();
    await chrome.until(`${focused} === '15'`);
    await stroke('ArrowRight');
    await chrome.until(`${focused} === '16'`);
    await stroke('ArrowDown');
    await chrome.until(`${focused} === '23'`);
    await stroke('PageDown');
    await chrome.until(`${month} === 'September' && ${focused} === '23'`);
    await shot('edit-calendar-keys', `${focused} === '23' && document.activeElement.matches(':focus-visible')`);
    await enter();
    await chrome.until(`document.querySelector('[data-row="f:birthday"]')?.textContent.includes('23 September 1993') && ${focused} === '23'
    && document.querySelector('.ck-mgrid__day.is-on')?.dataset.ckCalDay === '23'`);
    for (let up = 0; up < 3; up++) await stroke('ArrowUp');
    await chrome.until(`${focused} === '2'`);
    await stroke('ArrowLeft');
    await stroke('ArrowLeft');
    await chrome.until(`${month} === 'August' && ${focused} === '31'`);
    await stroke('Escape');
    await chrome.until(`!document.querySelector('.pp-cal')`);
    const [fx, fy] = await chrome.evaluate(`(() => { const box = document.querySelector('[data-row="f:birthday"]').getBoundingClientRect();
    return [box.x + box.width / 2, box.y + box.height / 2]; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await chrome.send('Input.dispatchMouseEvent', { type, x: fx, y: fy, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
    }
    await chrome.until(`document.querySelector('.pp-cal') && document.activeElement?.dataset.row === 'f:birthday'`);
    await stroke('ArrowDown');
    await chrome.until(`${focused} === '23' && ${month} === 'September'`);
    for (let back = 0; back < 7; back++) await stroke('PageUp');
    await chrome.until(`${month} === 'February'`);
    const days = `document.querySelectorAll('.pp-cal [data-ck-cal-day]:not([data-ck-cal-out])').length`;
    const before = `[...document.querySelectorAll('.pp-cal .ck-mgrid__days > *')].findIndex(each => each.dataset.ckCalDay === '1' && !each.dataset.ckCalOut)`;
    const height = `Math.round(document.querySelector('.pp-cal .ck-mgrid').getBoundingClientRect().height)`;
    const tall = await chrome.evaluate(height);
    /** @param {string} words */
    const year = words => chrome.evaluate(`(() => { const field = document.querySelector('[data-ck-cal-year]'); field.focus();
    field.value = ${JSON.stringify(words)}; field.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await year('');
    await chrome.until(`${days} === 29 && document.querySelector('[data-ck-cal-year]').value === ''`);
    const thisYear = new Date().getUTCFullYear();
    assert.equal(await chrome.evaluate(before), birthdayMonth(2, null, thisYear).offset, 'February with no year drawn as the next leap year');
    assert.ok([2028, 2032, 2036].includes(birthdayMonth(2, null, 2026).year) && birthdayMonth(2, null, 2026).year === 2028);
    assert.equal(birthdayMonth(2, null, 2028).year, 2028);
    assert.equal(birthdayMonth(3, null, 2026).year, 2026);
    await click('[data-ck-cal-step="1"]');
    await chrome.until(`${month} === 'March'`);
    await chrome.evaluate(`document.querySelector('.pp-cal [data-ck-cal-day="1"]:not([data-ck-cal-out])').focus(); true`);
    const lastShown = String(birthdayMonth(3, null, thisYear).before);
    await stroke('ArrowLeft');
    await chrome.until(`${month} === 'February' && ${focused} === '${lastShown}' && ${days} === 29`);
    await year('2023');
    await chrome.until(`${days} === 28`);
    assert.equal(await chrome.evaluate(before), 2, '1 February 2023, a Wednesday');
    await year('2024');
    await chrome.until(`${days} === 29`);
    assert.equal(await chrome.evaluate(height), tall, 'the calendar one height');
    await year('1993');
    await chrome.until(`${days} === 28 && document.querySelector('[data-row="f:birthday"]')?.textContent.includes('23 September 1993')`);
    const cells = `[...document.querySelectorAll('.pp-cal .ck-mgrid__days > *')].map(each => (each.dataset.ckCalOut ?? '0') + ':' + each.dataset.ckCalDay)`;
    assert.deepEqual(await chrome.evaluate(cells), [...Array.from({ length: 28 }, (_, at) => `0:${at + 1}`), ...Array.from({ length: 14 }, (_, at) => `1:${at + 1}`)]);
    assert.deepEqual(await chrome.evaluate(`(() => { const out = [...document.querySelectorAll('.pp-cal [data-ck-cal-out]')];
    const tone = each => getComputedStyle(each).color;
    const week = tone(document.querySelector('.pp-cal .ck-mgrid__week > span'));
    const day = tone(document.querySelector('.pp-cal .ck-mgrid__day:not([data-ck-cal-out])'));
    return [out.every(each => tone(each) === week), week !== day, out.every(each => each.tabIndex === -1 && !each.matches('.is-on, .is-today')),
      out[0].getAttribute('aria-label')]; })()`), [true, true, true, '1 March 1993']);
    await click('[data-ck-cal-out="1"][data-ck-cal-day="3"]');
    await chrome.until(`${month} === 'March' && document.querySelector('[data-row="f:birthday"]')?.textContent.includes('3 March 1993')
    && document.querySelector('.ck-mgrid__day.is-on:not([data-ck-cal-out])')?.dataset.ckCalDay === '3'`);
    await click('[data-ck-cal-step="1"]');
    await chrome.until(`${month} === 'April'`);
    await click('[data-ck-cal-out="-1"][data-ck-cal-day="31"]');
    await chrome.until(`${month} === 'March' && document.querySelector('[data-row="f:birthday"]')?.textContent.includes('31 March 1993')
    && document.querySelector('.ck-mgrid__day.is-on')?.dataset.ckCalDay === '31' && !document.querySelector('.ck-mgrid__day.is-on[data-ck-cal-out]')`);
    for (let ahead = 0; ahead < 6; ahead++) await click('[data-ck-cal-step="1"]');
    await chrome.until(`${month} === 'September'`);
    await click('[data-ck-cal-day="23"]');
    await chrome.until(`document.querySelector('[data-row="f:birthday"]')?.textContent.includes('23 September 1993')`);
    for (let ahead = 0; ahead < 3; ahead++) await click('[data-ck-cal-step="1"]');
    await chrome.until(`${month} === 'December'`);
    assert.equal(await chrome.evaluate(`document.querySelector('.pp-cal [data-ck-cal-out="1"]')?.getAttribute('aria-label')`), '1 January 1994');
    for (let back = 0; back < 3; back++) await click('[data-ck-cal-step="-1"]');
    await chrome.until(`${month} === 'September'`);
    await chrome.size(1440, 640);
    await chrome.evaluate(`(() => { const body = document.querySelector('.pp-panel__body'); body.scrollTop = body.scrollHeight; return true; })()`);
    await chrome.until(`document.querySelector('.pp-panel.is-scrolled')`);
    const head = await chrome.evaluate(`(() => { const top = document.querySelector('.pp-panel__top'); const box = top.getBoundingClientRect();
    const style = getComputedStyle(top); const hero = document.querySelector('.pp-hero').getBoundingClientRect();
    return { opaque: style.backgroundColor !== 'rgba(0, 0, 0, 0)', line: style.boxShadow !== 'none', under: hero.bottom < box.bottom,
      over: [0.2, 0.5, 0.8].every(at => top.contains(document.elementFromPoint(box.left + box.width * at, box.bottom - 2))) }; })()`);
    assert.deepEqual(head, { opaque: true, line: true, under: true, over: true });
    for (const theme of /** @type {const} */ (['dark', 'light'])) {
      await chrome.theme(theme);
      await chrome.shoot(join(page.out, `edit-head-scrolled-1440-${theme}.png`));
    }
    await chrome.theme('dark');
    await chrome.evaluate(`(() => { document.querySelector('.pp-panel__body').scrollTop = 0; return true; })()`);
    await chrome.until(`!document.querySelector('.pp-panel.is-scrolled')`);
    assert.equal(await chrome.evaluate(`getComputedStyle(document.querySelector('.pp-panel__top')).boxShadow`), 'none', 'the hairline at rest');
    await chrome.size(1440, 900);
    await stroke('Escape');
    await chrome.until(`!document.querySelector('.pp-cal')`);
    await click(`[data-row="o:${found.id}"] .ck-namerow__end`);
    await chrome.until(`document.querySelector('[data-row="o:${found.id}"]')?.getAttribute('aria-checked') === 'false'`);
    await fill('[data-o-add]', 'https://www.instagram.com/Person.A.Studio/?igsh=c3ludGhldGlj');
    await chrome.until(`document.querySelector('.pp-pop [data-o-find="0"]')?.textContent.includes('@person.a.studio')`);
    assert.equal(await chrome.evaluate(`document.querySelector('.pp-pop').textContent.includes('igsh')`), false, 'the query kept');
    await shot('edit-profile-find', `document.querySelector('.pp-pop [data-o-find="0"]')`);
    await fill('[data-o-add]', 'https://www.linkedin.com/in/%E5%BC%A0%E4%BC%9F-1a2b3c/');
    await chrome.until(`document.querySelector('.pp-pop [data-o-find="0"]')?.textContent.includes('张伟-1a2b3c')`);
    await fill('[data-o-add]', 'https://www.instagram.com/Person.A.Studio/?igsh=c3ludGhldGlj');
    await chrome.until(`document.querySelector('.pp-pop [data-o-find="0"]')?.textContent.includes('@person.a.studio')`);
    await enter();
    await chrome.until(`document.querySelector('[data-row="a:profile-instagram:person.a.studio"]')?.getAttribute('aria-checked') === 'true'`);
    await shot('edit-details', `document.querySelector('[data-row="a:profile-instagram:person.a.studio"]')`);
    const elsewhere = landed();
    const declined = await act({ kind: 'confirm', id: 'person:person-a', decline: [found.id] });
    assert.equal(declined.status, 200, await declined.text());
    await landedPast(elsewhere);
    await until('the decline on the next read', async () => !(await dashboard('/api/page/person?id=person%3Aperson-a')).edit
      .suggestions.some((/** @type {any} */ each) => each.id === found.id) || undefined);
    await click('[data-o-do="save"]');
    await chrome.until(`${shows('what Lifestream suggests for them has changed')} && !document.querySelector('[data-row="o:${found.id}"]')
    && document.querySelector('[data-row="a:profile-instagram:person.a.studio"]')?.getAttribute('aria-checked') === 'true'`);
    assert.ok((await text('[data-row="f:birthday"]')).join(' ').includes('23 September 1993'), 'the birthday chosen kept');
    assert.equal(await chrome.evaluate(`document.querySelector('[data-o-field="work"]')?.value`), 'Designer, Synthetic Studio');
    const saving = landed();
    await click('[data-o-do="save"]');
    await chrome.until(left);
    await landedPast(saving);
    const [saved] = (await chrome.evaluate('window.answered')).slice(-1);
    assert.deepEqual((await held()).details.get('person:person-a'), { type: 'people.details', work: 'Designer, Synthetic Studio',
      birthday: { month: 9, day: 23, year: 1993 }, profiles: [{ network: 'instagram', value: 'person.a.studio' }] });
    assert.ok((await held()).persons.get('person-a').dismissed.includes(found.id));
    await chrome.until(`document.querySelector('.pp-head .ck-factchip')`);
    assert.ok((await text('.pp-head__line')).join(' ').includes('Designer, Synthetic Studio'), (await text('.pp-head__line')).join());
    assert.deepEqual(await text('.pp-head .ck-factchip'), ['23 Sep', '@person.a.studio']);
    assert.deepEqual(await attr('.pp-head a.ck-factchip', 'href'), ['https://www.instagram.com/person.a.studio/']);
    await chrome.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 100 });
    await chrome.until(`[...document.querySelectorAll('[data-week-words]')].every(each => each.textContent === each.dataset.rest)`);
    await shot('person-details',`document.querySelector('.pp-head .ck-factchip')`);
    await load('#view=people&focus=person:person-a', null);
    await chrome.until(`document.querySelectorAll('.pp-head .ck-factchip').length === 2`);
    await click('[data-people-edit="open"]');
    await chrome.until(`${editing} && document.querySelector('[data-row="p:instagram:person.a.studio"]')`);
    assert.equal(await chrome.evaluate(`Boolean(document.querySelector('[data-row="o:${found.id}"]'))`), false);
    const quiet = landed();
    await click('.pp-foot [data-o-do="cancel"]');
    await chrome.until(left);
    assert.equal(landed(), quiet, 'Cancel ships nothing');
    await undoLast(saved);
    assert.equal((await held()).details.has('person:person-a'), false);
  });
});

describe('people-edit: Edit and the home’s writer, and the list beside the kit gallery', () => {

  before(async () => {
    ({ home, front, chrome, restart } = await page.journey('people-edit'));
  });

  const { seen, command, shot, click, attr, go, stub, capture, load, held, landed, landedPast, fromDoor, act, dashboard, fill, enter, stroke,
    deckNow, centreOf, blobOf } = page;

  test('P4 P5: Edit, two actions while People\'s run is held, each on the next read, its counted parts kept, never the skeleton; the add field, a restart, Remove', async () => {
    const editing = `document.querySelector('.pl-naming__title')?.textContent === 'Edit person' && document.querySelector('[data-o-field="rel"]')`;
    const left = `!document.querySelector('.pp-panel') && document.querySelector('[data-people-edit="open"]')`;
    front.faces({ state: 'on', scanned: 30, photos: 30 });
    await load('#view=days', null);
    await chrome.evaluate('window.photosHeld = new Promise(done => { window.releasePhotos = done; }); true');
    await stub(`(url, init, real) => url.startsWith('api/life/people/photos') ? window.photosHeld.then(() => real(url, init)) : real(url, init)`);
    await go('#view=people&focus=person:person-a');
    await chrome.until(`document.querySelector('[data-people-edit="open"]') && document.querySelector('[data-people-retry]') === null`);
    await click('[data-people-edit="open"]');
    await chrome.until(editing);
    assert.equal(await chrome.evaluate(`Boolean(document.querySelector('.pl-naming__count, .pl-naming__progress'))`), false, 'Edit counts nothing');
    await click('[data-o-do="photo"]');
    await chrome.until(`document.querySelector('.pp-window .ck-fcrop--reading')`);
    const tile = `JSON.stringify(document.querySelector('.pp-window .ck-fcrop--upload').getBoundingClientRect())`;
    const reading = await chrome.evaluate(tile);
    await chrome.evaluate('window.releasePhotos()');
    await chrome.until(`document.querySelector('.pp-window [data-o-frame]')`);
    assert.equal(await chrome.evaluate(tile), reading, 'the upload tile moved as the photos landed');
    assert.equal(await chrome.evaluate(`document.querySelector('.pp-window .ck-fgrid__faces > :first-child').matches('.ck-fcrop--upload')`), true);
    await chrome.size(...WIDTHS[1]);
    const narrow = `[getComputedStyle(document.querySelector('.pp-window')).display, getComputedStyle(document.querySelector('.pp-panel')).display]`;
    assert.deepEqual(await chrome.evaluate(narrow), ['block', 'none']);
    await click('[data-o-do="back"]');
    await chrome.until(`${narrow}[0] === 'none' && ${narrow}[1] !== 'none'`);
    await chrome.size(...WIDTHS[0]);
    await click('.pp-foot [data-o-do="cancel"]');
    await chrome.until(left);

    await load('#view=people&focus=person:person-a', null);
    await chrome.until(`document.querySelector('[data-people-edit="open"]') && document.querySelector('[data-people-photo]')`);
    await click('[data-people-edit="open"]');
    await chrome.until(editing);
    await shot('edit', editing);
    assert.deepEqual(await attr('.pp-panel [data-o-remove]', 'data-o-remove'), [A]);

    await capture();
    await command('pause', { target: 'people:people' });
    const first = landed();
    await fill('[data-o-field="rel"]', 'friend');
    await click('[data-o-do="photo"]');
    await chrome.until(`document.querySelector('.pp-window [data-o-frame="0"]')`);
    await click('.pp-window [data-o-frame="0"]');
    await chrome.until(`document.querySelector('.ck-mas:not(.is-refused) .ck-mas__img')?.complete && document.activeElement?.matches('.ck-mas__stage')`);
    assert.deepEqual([await attr('.ck-mas', 'data-width'), await attr('.ck-mas', 'data-height')], [[String(PHOTO.width)], [String(PHOTO.height)]]);
    await enter();
    await chrome.until(`document.querySelector('[data-o-own="made"][role="img"] .ck-tick.is-on')
    && document.querySelector('.pp-hero__face img.is-loaded') && document.querySelector('.pp-foot__said span')?.textContent === 'Photo saved'
    && document.querySelector('.pp-foot [data-o-do="undo"]')`);
    const middle = await centreOf('.pp-hero__face img');
    const far = (/** @type {readonly number[]} */ from) => from.reduce((sum, each, at) => sum + Math.abs(each - middle[at]), 0);
    assert.ok(far(FACE) < far(GROUND), `the square is not around their face: ${middle}`);
    assert.equal(await chrome.evaluate(`document.querySelector('[data-o-field="rel"]').value`), 'friend');
    await chrome.until(`(window.answered ?? []).length === 1`);
    const crop = (await held()).photos.get('person:person-a')?.image;
    assert.match(String(crop), /^sha256:[0-9a-f]{64}$/u);
    assert.deepEqual((await held()).photos.get('person:person-a'), { type: 'people.photo', image: crop });
    assert.equal(`sha256:${createHash('sha256').update(await blobOf(crop)).digest('hex')}`, crop);
    await click('[data-o-do="save"]');
    await chrome.until(left);
    await chrome.until(`(window.answered ?? []).length === 2`);
    let a = (await held()).persons.get('person-a');
    assert.deepEqual([a.relationship, 'photo' in a], ['friend', false], 'landed before its answer');
    const next = (await fromDoor('/v1/people', { id: 'person:person-a' })).person;
    assert.deepEqual([next.relationship, next.photo, next.counting], ['friend', { crop }, undefined],
      'both on the next read, People\'s run held, counting nothing');
    const drawnLeft = `document.querySelector('.pp-head__line')?.textContent.includes('friend')
    && document.querySelector('.pp-head img')?.getAttribute('data-src')?.startsWith('blob:')`;
    const counted = `Boolean(document.querySelector('.pp-main .ck-counting'))`;
    await chrome.until(`${drawnLeft} && !${counted}`);
    await shot('edit-saved', `${drawnLeft} && !${counted}`);
    await front.landing(first + 1);
    assert.equal(landed(), first + 2);
    await command('resume', { target: 'people:people' });
    await command('settle');
    const prepared = (await fromDoor('/v1/people', { id: 'person:person-a' })).person;
    assert.deepEqual([prepared.relationship, prepared.photo, prepared.counting], ['friend', { crop }, undefined],
      'People\'s run serves what the join served');
    await chrome.until(`${drawnLeft} && !${counted}`);
    const shown = (await dashboard('/api/page/person?id=person%3Aperson-a')).head;
    assert.deepEqual([shown.relationship, shown.photo], [prepared.relationship, crop]);
    assert.deepEqual((await dashboard('/api/life/people')).people.find((/** @type {any} */ each) => each.id === 'person:person-a').photo, { crop });
    await click('[data-people-edit="open"]');
    await chrome.until(editing);
    await fill('[data-o-field="full"]', 'Person A Example');
    await chrome.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers: 4 });
    await chrome.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers: 4 });
    await chrome.until(left);
    await landedPast(first + 2);
    a = (await held()).persons.get('person-a');
    assert.deepEqual([a.relationship, a.full_name, a.name, 'photo' in a], ['friend', 'Person A Example', null, false]);
    assert.equal((await fromDoor('/v1/people', { id: 'person:person-a' })).person.full_name, 'Person A Example');

    const quiet = landed();
    await click('[data-people-edit="open"]');
    await chrome.until(editing);
    await fill('[data-o-add]', 'Person B');
    await shot('edit-add', `[...document.querySelectorAll('.pp-pop [data-o-find]')].some(each => each.textContent.includes('Person B'))`);
    assert.equal(await chrome.evaluate(`document.activeElement?.matches('[data-o-add]')`), true, 'the field keeps the focus as its finds land');
    await stroke('Escape');
    await chrome.until(`!document.querySelector('.pp-pop')`);
    await click('[data-o-do="notperson"]');
    await chrome.until(`document.querySelector('.pp-pop [data-o-kind]')`);
    await enter();
    await chrome.until(`document.activeElement?.dataset.oUnsay !== undefined`);
    await enter();
    await chrome.until(`document.activeElement?.dataset.oDo === 'notperson' && !document.querySelector('[data-o-unsay]')`);
    assert.equal(await chrome.evaluate(`Boolean(${editing})`), true, '⏎ on what was said leaves Edit open');
    await click('.pp-foot [data-o-do="cancel"]');
    await chrome.until(left);
    assert.equal(landed(), quiet, 'Cancel ships nothing');

    const third = landed();
    await click('[data-people-edit="open"]');
    await chrome.until(editing);
    await fill('[data-o-field="rel"]', 'colleague');
    await click('[data-o-do="save"]');
    await chrome.until(left);
    const shipped = await front.landing(third);
    await command('settle');
    await restart();
    const undoingSave = landed();
    const undone = await act({ kind: 'undo', act: shipped });
    assert.equal(undone.status, 200, await undone.text());
    await landedPast(undoingSave);
    assert.equal((await held()).persons.get('person-a').relationship, 'friend');
    assert.equal((await act({ kind: 'undo', act: shipped })).status, 409);
    const fourth = landed();
    await click('[data-people-edit="open"]');
    await chrome.until(editing);
    await fill('[data-o-field="full"]', 'Person A Second');
    await click('[data-o-do="save"]');
    await chrome.until(left);
    await landedPast(fourth);
    a = (await held()).persons.get('person-a');
    assert.deepEqual([a.relationship, a.full_name, (await held()).photos.get('person:person-a')?.image], ['friend', 'Person A Second', crop]);

    const fifth = landed();
    await click('[data-people-edit="open"]');
    await chrome.until(`${editing} && document.querySelector('[data-o-remove="${A}"]')`);
    await click(`[data-o-remove="${A}"]`);
    await chrome.until(`!document.querySelector('[data-o-remove="${A}"]')`);
    await click('[data-o-do="save"]');
    await chrome.until(left);
    await landedPast(fifth);
    a = (await held()).persons.get('person-a');
    assert.deepEqual([a.anchor, a.excluded, a.name], [null, [{ kind: 'phone', value: '+15550000001' }], 'Person A']);

    const deck = await until('the deck read', async () => {
      const read = await deckNow();
      return read.ready && read.cards.length > 0 ? read : undefined;
    });
    const lone = deck.cards.find((/** @type {any} */ card) => card.suggestions.length === 0) ?? deck.cards.at(-1);
    const naming = landed();
    const named = await act({ kind: 'name', cluster: lone.id, target: { kind: 'new', name: 'Person Q' } });
    assert.equal(named.status, 200, await named.text());
    await landedPast(naming);
    const Q = 'person:person-q';
    await until('Person Q named on their faces', async () => {
      const photos = (await dashboard(`/api/life/people/photos?id=${encodeURIComponent(Q)}`)).photos;
      const known = (await deckNow()).someone?.some((/** @type {any} */ one) => one.id === Q && one.named > 0);
      return photos.length > 0 && known ? true : undefined;
    });
    await load('#view=days', null);
    await chrome.evaluate(`window.namedHeld = new Promise(done => { window.releaseNamed = done; });
    window.reportHeld = new Promise(done => { window.releaseReport = done; }); window.posted = []; true`);
    await stub(`(url, init, real) => {
    if (url === 'api/owner/act') window.posted.push(JSON.parse(String(init.body)));
    if (url === 'api/page/connectors') return window.reportHeld.then(() => real(url, init));
    if (url === 'api/faces') return real(url, init).then(async response => {
      window.deckReady = (await response.clone().json()).ready === true;
      return response;
    });
    const q = url.startsWith('api/life/people/photos?') && new URLSearchParams(url.split('?')[1]).get('id') === ${JSON.stringify(Q)};
    return q ? window.namedHeld.then(() => real(url, init)) : real(url, init);
  }`);
    await go('#view=people&focus=person:person-b');
    await chrome.until(`window.deckReady && document.querySelector('[data-people-edit="open"]') && document.querySelector('[data-people-retry]') === null`);
    await click('[data-people-edit="open"]');
    assert.equal(await chrome.evaluate(`Boolean(document.querySelector('[data-o-field="rel"]'))`), false, 'the card opened before faces was read');
    await chrome.evaluate('window.releaseReport(); true');
    await chrome.until(`${editing} && document.querySelector('[data-row="faces"]')`);
    await click('[data-o-do="photo"]');
    await chrome.until(shows('No photos of them yet'));
    await click('.pp-window [data-o-do="faces"]');
    await chrome.until(`document.querySelector('.pp-window [data-o-pick="${Q}"]')`);
    await click(`.pp-window [data-o-pick="${Q}"]`);
    const row = `[data-row="a:find-${Q}"]`;
    await chrome.until(`document.querySelector('${row}')?.getAttribute('aria-checked') === 'true'`);
    assert.equal(await chrome.evaluate(`Boolean(document.querySelector('[data-row="faces"]'))`), false, 'a face marked theirs: no Mark their face');
    assert.equal(await chrome.evaluate(`Boolean(document.querySelector('.pp-hero__face img'))`), true, 'their head shows the face marked');
    await chrome.evaluate('window.releaseNamed(); true');
    await click('[data-o-do="photo"]');
    await chrome.until(`document.querySelector('.pp-window__head .ck-section__label')?.textContent === 'Their photo' && ${shows('No photos of them yet')}`);
    await shot('edit-photo-named-face', shows('No photos of them yet'));
    assert.equal(await chrome.evaluate(`document.querySelectorAll('.pp-window [data-o-frame]').length`), 0, 'the chooser offers Person Q’s photos');
    assert.equal(await chrome.evaluate(`document.querySelector('.pp-window [data-o-own="now"] img')?.getAttribute('data-src')
    === document.querySelector('.pp-hero__face img')?.getAttribute('data-src')`), true, 'their photo now not the face their head shows');
    const joining = landed();
    await click('[data-o-do="save"]');
    await chrome.until(left);
    const [sent] = await chrome.evaluate('window.posted');
    assert.deepEqual([sent.kind, sent.id, sent.add, 'photo' in sent, 'upload' in sent, sent.groups], ['confirm', 'person:person-b', [Q], false, false, undefined]);
    const joined = await front.landing(joining);
    await command('settle');
    assert.equal((await held()).persons.get('person-q').merged_into, 'person-b');
    const undoing = landed();
    const unjoined = await act({ kind: 'undo', act: joined });
    assert.equal(unjoined.status, 200, await unjoined.text());
    await landedPast(undoing);
    assert.equal((await held()).persons.get('person-q').merged_into, null);

    const renaming = landed();
    const renamed = await act({ kind: 'confirm', id: Q, name: 'Person B' });
    assert.equal(renamed.status, 200, await renamed.text());
    const rename = await front.landing(renaming);
    await command('settle');
    const offer = await until('Person Q offered as the same person on Person B', async () => (await dashboard('/api/page/person?id=person%3Aperson-b'))
      .edit.suggestions.find((/** @type {any} */ each) => each.kind === 'same' && each.value === 'person-q'));
    await load('#view=days', null);
    await chrome.evaluate('window.namedHeld = new Promise(done => { window.releaseNamed = done; }); true');
    await stub(`(url, init, real) => {
    const q = url.startsWith('api/life/people/photos?') && new URLSearchParams(url.split('?')[1]).get('id') === ${JSON.stringify(Q)};
    return q ? window.namedHeld.then(() => real(url, init)) : real(url, init);
  }`);
    await go('#view=people&focus=person:person-b');
    await chrome.until(`document.querySelector('[data-people-edit="open"]') && document.querySelector('[data-people-retry]') === null`);
    await click('[data-people-edit="open"]');
    await chrome.until(`${editing} && document.querySelector('[data-row="o:${offer.id}"]')`);
    await click(`[data-row="o:${offer.id}"] .ck-namerow__end`);
    await chrome.until(`document.querySelector('[data-row="o:${offer.id}"]').getAttribute('aria-checked') === 'true'`);
    await chrome.evaluate('window.releaseNamed(); true');
    await click('[data-o-do="photo"]');
    await chrome.until(`document.querySelector('.pp-window__head .ck-section__label')?.textContent === 'Their photo' && ${shows('No photos of them yet')}`);
    assert.equal(await chrome.evaluate(`document.querySelectorAll('.pp-window [data-o-frame]').length`), 0, 'the chooser offers the photos of the same person ticked');
    await click('.pp-foot [data-o-do="cancel"]');
    await chrome.until(left);
    const unrenaming = landed();
    const unrenamed = await act({ kind: 'undo', act: rename });
    assert.equal(unrenamed.status, 200, await unrenamed.text());
    await landedPast(unrenaming);
    await command('pause', { target: 'people:people' });
    await load('#view=people&focus=person:person-a', null);
    await chrome.until(`document.querySelector('[data-people-edit="open"]') && document.querySelector('[data-people-retry]') === null`);
    await click('[data-people-edit="open"]');
    await chrome.until(editing);
    const hiding = landed();
    assert.equal(await chrome.evaluate(`Boolean(document.querySelector('.pp-foot [data-o-do="hide"]'))`), false);
    await click('.pp-last [data-o-do="hide"]');
    const outOfList = `!document.querySelector('.pp-panel') && document.querySelector('.pp-main [data-person]')
    && !document.querySelector('.pp-main [data-person="person:person-a"]')`;
    await chrome.until(outOfList);
    const hid = await front.landing(hiding);
    assert.equal((await held()).persons.get('person-a').hidden, true, 'landed before its answer');
    assert.equal((await fromDoor('/v1/people')).people.some((/** @type {any} */ each) => each.id === 'person:person-a'), false,
      'the hide on the next read, People\'s run held');
    await command('resume', { target: 'people:people' });
    await command('settle');
    assert.ok(await chrome.evaluate(outOfList), 'Person A still off the list once People ran');
    const unhiding = landed();
    const unhidden = await act({ kind: 'undo', act: hid });
    assert.equal(unhidden.status, 200, await unhidden.text());
    await landedPast(unhiding);
    await chrome.until(`document.querySelector('.pp-main [data-person="person:person-a"]')`);

    await command('pause', { target: 'people:people' });
    await load('#view=people&focus=person:person-a', null);
    await chrome.until(`document.querySelector('[data-people-edit="open"]') && document.querySelector('[data-people-retry]') === null`);
    const was = (await fromDoor('/v1/people', { id: 'person:person-a' })).person.name;
    await stub(`(url, init, real) => {
    if (url.split('?')[0] === 'api/page/people') window.listReads = (window.listReads ?? 0) + 1;
    const answer = real(url, init);
    if (url === 'api/owner/act') answer.then(response => response.clone().json()).then(body => (window.answered ??= []).push(body));
    return answer;
  }`);
    const title = `document.querySelector('.pp-head__title')?.textContent.trim()`;
    const naming2 = landed();
    await click('[data-people-edit="open"]');
    await chrome.until(editing);
    await fill('[data-o-field="name"]', 'Person A Called');
    await click('[data-o-do="save"]');
    await chrome.until(`${left} && ${title} === 'Person A Called' && !${counted}`);
    const renamedNext = (await fromDoor('/v1/people', { id: 'person:person-a' })).person;
    assert.deepEqual([renamedNext.name, renamedNext.counting ?? false], ['Person A Called', false], 'the rename on the next read, People\'s run held, its counts kept');
    await click('[data-people-edit="open"]');
    await chrome.until(editing);
    assert.equal(await chrome.evaluate(`document.querySelector('[data-o-field="name"]').value`), 'Person A Called', 'Edit again opened on the home\'s name');
    await click('[data-o-do="photo"]');
    await chrome.until(`document.querySelector('.pp-window [data-o-frame="0"]')`);
    await click('.pp-window [data-o-frame="0"]');
    await chrome.until(`document.querySelector('.ck-mas:not(.is-refused) .ck-mas__img')?.complete && document.activeElement?.matches('.ck-mas__stage')`);
    await enter();
    await chrome.until(`document.querySelector('.pp-foot__said span')?.textContent === 'Photo saved'`);
    await click('.pp-foot [data-o-do="cancel"]');
    await chrome.until(`${left} && document.querySelector('.pp-head img')?.getAttribute('data-src')?.startsWith('blob:')`);
    assert.equal(await chrome.evaluate(title), 'Person A Called', 'the photo used after Save drew another name');
    const [photoUsed] = (await chrome.evaluate('window.answered')).slice(-1);
    assert.equal(photoUsed.act, null, 'the same square stated again');
    const listReads = await chrome.evaluate('window.listReads ?? 0');
    front.reset();
    await chrome.until(`window.listReads > ${listReads} && ${title} === 'Person A Called' && !${counted}`);
    await command('resume', { target: 'people:people' });
    await landedPast(naming2);
    await chrome.until(`${title} === 'Person A Called' && !${counted}`);
    const renaming2 = landed();
    await click('[data-people-edit="open"]');
    await chrome.until(editing);
    await fill('[data-o-field="name"]', was);
    await click('[data-o-do="save"]');
    await chrome.until(left);
    await landedPast(renaming2);
    await chrome.until(`${title} === ${JSON.stringify(was)}`);
  });

  test('P14: a split staged, Cancel, staged again and saved through Edit; the line and its Undo on their page', async () => {
    const A = 'person:person-a';
    const B = 'person:person-b';
    const editing = `document.querySelector('.pl-naming__title')?.textContent === 'Edit person' && document.querySelector('[data-o-field="rel"]')`;
    const left = `!document.querySelector('.pp-panel') && document.querySelector('[data-people-edit="open"]')`;
    const personA = async () => (await dashboard('/api/page/person?id=person%3Aperson-a')).edit;
    const joining = landed();
    const join = await act({ kind: 'confirm', id: A, add: [B] });
    assert.equal(join.status, 200, await join.text());
    await front.landing(joining);
    await command('settle');
    const name = await until('Person B joined in on Person A', async () =>
      (await personA()).joined?.find((/** @type {any} */ each) => each.id === B)?.name);
    await load('#view=days', null);
    await chrome.evaluate('window.posted = []; true');
    await stub(`(url, init, real) => {
    if (url === 'api/owner/act') window.posted.push(JSON.parse(String(init.body)));
    return real(url, init);
  }`);
    await go(`#view=people&focus=${A}`);
    await chrome.until(`document.querySelector('[data-people-edit="open"]') && document.querySelector('[data-people-retry]') === null`);
    await click('[data-people-edit="open"]');
    await chrome.until(`${editing} && document.querySelector('[data-o-split="${B}"]')`);
    await click(`[data-o-split="${B}"]`);
    await chrome.until(`!document.querySelector('[data-row="j:${B}"]')`);
    await click('.pp-foot [data-o-do="cancel"]');
    await chrome.until(left);
    assert.deepEqual(await chrome.evaluate('window.posted'), [], 'Cancel shipped something');
    await click('[data-people-edit="open"]');
    await chrome.until(`${editing} && document.querySelector('[data-o-split="${B}"]')`);
    await click(`[data-o-split="${B}"]`);
    await chrome.until(`!document.querySelector('[data-row="j:${B}"]')`);
    const splitting = landed();
    await click('[data-o-do="save"]');
    const line = `document.querySelector('.pp-saved span')?.textContent === ${JSON.stringify(`${name} split off`)}
    && document.querySelector('[data-people-saved-undo]')`;
    await chrome.until(`${left} && ${line}`);
    const [sent] = await chrome.evaluate('window.posted');
    assert.deepEqual([sent.kind, sent.id, sent.split, 'unlink' in sent, 'add' in sent], ['confirm', A, [B], false, false]);
    const split = await front.landing(splitting);
    await command('settle');
    await until('Person B split off Person A', async () => !(await personA()).joined?.some((/** @type {any} */ each) => each.id === B) || undefined);
    await shot('edit-split-saved', line);
    const undoing = landed();
    await click('[data-people-saved-undo]');
    await chrome.until(`!document.querySelector('.pp-saved')`);
    const posted = await chrome.evaluate('window.posted');
    assert.deepEqual(posted.slice(1).map((/** @type {any} */ each) => [each.kind, each.act]), [['undo', split]]);
    await landedPast(undoing);
    await command('settle');
    await until('Person B joined in again', async () => (await personA()).joined?.some((/** @type {any} */ each) => each.id === B) || undefined);
    const unjoining = landed();
    const unjoined = await act({ kind: 'confirm', id: A, split: [B] });
    assert.equal(unjoined.status, 200, await unjoined.text());
    await landedPast(unjoining);
  });

  test('P15: a Save the home began and has not answered: Still saving, nothing drawn until it answers, no Undo, the same request checked until it lands once', async () => {
    const A = 'person:person-a';
    const editing = `document.querySelector('.pl-naming__title')?.textContent === 'Edit person' && document.querySelector('[data-o-field="rel"]')`;
    const left = `!document.querySelector('.pp-panel') && document.querySelector('[data-people-edit="open"]')`;
    const drawn = `document.querySelector('.pp-head__line')?.textContent.includes('checked again')`;
    const was = (await fromDoor('/v1/people', { id: A })).person.relationship ?? null;
    await load('#view=days', null);
    await chrome.evaluate('window.posted = []; window.holding = true; true');
    await stub(`(url, init, real) => {
    if (url !== 'api/owner/act') return real(url, init);
    window.posted.push({ ...JSON.parse(String(init.body)), wait: new Headers(init.headers).get('lifestream-wait') });
    return window.holding ? (${JSON_ANSWER})({ error: 'Lifestream is still working on this.', code: 'OUTCOME_UNKNOWN', again: true, began: true }, 503)
      : real(url, init);
  }`);
    await go(`#view=people&focus=${A}`);
    await chrome.until(`document.querySelector('[data-people-edit="open"]') && document.querySelector('[data-people-retry]') === null`);
    await click('[data-people-edit="open"]');
    await chrome.until(editing);
    await fill('[data-o-field="rel"]', 'checked again');
    const saving = landed();
    await click('[data-o-do="save"]');
    await chrome.until(shows(SAVING));
    assert.equal(await chrome.evaluate(shows('Not saved')), false, 'a save the home began said as not saved');
    const budget = await chrome.evaluate('window.posted');
    const [first, second] = budget.map((/** @type {any} */ each) => Number(each.wait));
    assert.deepEqual([first, second], [10_000, 10_000], 'an answer at once leaves 15 s: each send the least of 10 s and what is left');
    await chrome.until('window.posted.length > 2');
    await click('.pp-foot [data-o-do="cancel"]');
    await chrome.until(left);
    assert.equal(await chrome.evaluate(drawn), false, 'a save the home has not answered drawn');
    assert.equal(await chrome.evaluate(`Boolean(document.querySelector('[data-people-saved-undo]'))`), false, 'Undo offered while a save is pending');
    assert.equal(landed(), saving, 'a held send landed');
    await chrome.evaluate('window.holding = false; true');
    await landedPast(saving);
    assert.equal((await held()).persons.get('person-a').relationship, 'checked again');
    await chrome.until(drawn);
    const posted = await chrome.evaluate('window.posted');
    assert.equal(new Set(posted.map((/** @type {any} */ each) => each.request)).size, 1, 'a check sent other than the same request');
    assert.equal(landed(), saving + 1, 'the checks landed the save twice');
    const restoring = landed();
    const restored = await act({ kind: 'confirm', id: A, relationship: was });
    assert.equal(restored.status, 200, await restored.text());
    await landedPast(restoring);
  });

  test('P16: a merge saved on their page, no feed heard: read settled, asked again when a held read comes back still counting, their photos once the home counted it', async () => {
    const B = 'person:person-b';
    const Q = 'person:person-q';
    const editing = `document.querySelector('.pl-naming__title')?.textContent === 'Edit person' && document.querySelector('[data-o-field="rel"]')`;
    const left = `!document.querySelector('.pp-panel') && document.querySelector('[data-people-edit="open"]')`;
    const counted = `Boolean(document.querySelector('.pp-main .ck-counting'))`;
    assert.ok((await fromDoor('/v1/people/photos', { id: Q })).total > 0, 'Person Q has photos to bring');
    assert.equal((await fromDoor('/v1/people/photos', { id: B })).total, 0, 'Person B has no photos of their own');
    await load('#view=days', null);
    await chrome.evaluate('window.settled = 0; window.merging = false; true');
    await stub(`(url, init, real) => {
    const asked = new URLSearchParams(url.split('?')[1] ?? '');
    if (!window.merging || !url.startsWith('api/page/person?') || asked.get('id') !== ${JSON.stringify(B)}) return real(url, init);
    const settled = asked.get('settled') === '1';
    if (settled) window.settled += 1;
    if (settled && window.settled > 1) return real(url, init);
    return real(url, init).then(response => response.json()).then(body => (${JSON_ANSWER})({ ...body, counting: true }));
  }`);
    await go(`#view=people&focus=${B}`);
    await chrome.until(`document.querySelector('[data-people-edit="open"]') && document.querySelector('[data-people-retry]') === null`);
    await click('[data-people-edit="open"]');
    await chrome.until(editing);
    await fill('[data-o-add]', 'Person Q');
    await chrome.until(`[...document.querySelectorAll('.pp-pop [data-o-find]')].some(each => each.textContent.includes('Person Q'))`);
    const at = await chrome.evaluate(`[...document.querySelectorAll('.pp-pop [data-o-find]')].find(each => each.textContent.includes('Person Q')).dataset.oFind`);
    await click(`.pp-pop [data-o-find="${at}"]`);
    await chrome.until(`document.querySelector('[data-row="a:find-${Q}"]')?.getAttribute('aria-checked') === 'true'`);
    front.hush();
    await chrome.evaluate('window.merging = true; true');
    const joining = landed();
    await click('[data-o-do="save"]');
    const joined = await front.landing(joining);
    const theirs = `!${counted} && document.querySelectorAll('.pp-main [data-people-photo]').length > 0`;
    await chrome.until(`${left} && ${theirs}`);
    await shot('merge-settled', theirs);
    assert.ok(await chrome.evaluate('window.settled') >= 2, 'a settled read that came back still counting not asked again');
    assert.equal((await fromDoor('/v1/people', { id: B })).person.counting, undefined, 'the home counted the merge');
    assert.ok((await fromDoor('/v1/people/photos', { id: B })).total > 0, 'Person Q\'s photos are Person B\'s');
    await chrome.evaluate('window.merging = false; true');
    front.unhush();
    await command('settle');
    const undoing = landed();
    const undone = await act({ kind: 'undo', act: joined });
    assert.equal(undone.status, 200, await undone.text());
    await landedPast(undoing);
    await command('settle');
  });

  test('P7: the list at 1440 beside the kit gallery\'s People page', async () => {
    const measure = `(() => { const main = document.querySelector('.pp-main');
    const grid = main.querySelector('.pp-group:not(.pp-group--most) .ck-cgrid');
    return { main: Math.round(main.getBoundingClientRect().width),
      rows: [...grid.children].map(cell => Math.round(cell.getBoundingClientRect().width)),
      columns: getComputedStyle(grid).gridTemplateColumns.split(' ').map(width => Math.round(parseFloat(width))) }; })()`;
    await chrome.size(...WIDTHS[0]);
    await load('#view=people', null);
    await chrome.until(`document.querySelector('.pp-main .ck-cgrid')`);
    const page = await chrome.evaluate(measure);
    await load(`kit-gallery.html#group=${encodeURIComponent('People · the list in the Mac app’s window')}`, null);
    await chrome.until(`document.querySelector('.gallery__page .pp-main .ck-cgrid')`);
    await chrome.evaluate(`document.querySelector('.gallery__page .pp-main').closest('.gallery__page').scrollIntoView()`);
    await shot('kit-gallery-people-list', `document.querySelector('.gallery__page .pp-main .ck-cgrid')`);
    const gallery = await chrome.evaluate(measure.replace(".querySelector('.pp-main')", ".querySelector('.gallery__page .pp-main')"));
    seen.list = { page, gallery };
    for (const each of [page, gallery]) {
      assert.ok(each.columns.every((/** @type {number} */ width) => width >= 200 && width === each.columns[0]), JSON.stringify(each));
      assert.ok(each.rows.every((/** @type {number} */ width) => width === each.columns[0]), JSON.stringify(each));
      assert.ok(each.main - each.columns.length * each.columns[0] < each.columns[0], JSON.stringify(each));
    }
  });
});
