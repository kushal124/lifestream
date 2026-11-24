import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { JSON_ANSWER, peoplePage, shows, WIDTHS } from './stand-ins/people-page.mjs';
import { until } from './until.mjs';

const page = peoplePage({ file: 'people-deck' });
const { seen, shot, click, text, attr, go, stub, load, held, landed, landedPast, stroke, deckNow, facesOfGroup, undoLast } = page;
/** @type {Awaited<ReturnType<typeof page.open>>['front']} */
let front;
/** @type {Awaited<ReturnType<typeof page.open>>['chrome']} */
let chrome;

before(async () => {
  await page.open();
  ({ front, chrome } = await page.journey('people-deck'));
});

after(() => page.close());

const cardShown = () => chrome.evaluate(`document.querySelector('[data-f-card]')?.dataset.fCard ?? ''`);
/** @param {string} id */
const movedFrom = id => `(document.querySelector('[data-f-card]')?.dataset.fCard ?? '') !== ${JSON.stringify(id)}`;
/** @param {string} id */
const showing = id => `document.querySelector('[data-f-card]')?.dataset.fCard === ${JSON.stringify(id)}`;
/** @param {string} id */
const lacks = id => `window.deckRead && !window.deckRead.includes(${JSON.stringify(id)})`;
const fieldText = () => chrome.evaluate(`document.querySelector('#face-name')?.value ?? null`);
/** @param {string} letters */
async function typeKeys(letters) {
  for (const letter of letters) {
    const code = `Key${letter.toUpperCase()}`;
    const virtual = letter.toUpperCase().charCodeAt(0);
    await chrome.send('Input.dispatchKeyEvent', { type: 'keyDown', key: letter, code, windowsVirtualKeyCode: virtual, text: letter,
      unmodifiedText: letter });
    await chrome.send('Input.dispatchKeyEvent', { type: 'keyUp', key: letter, code, windowsVirtualKeyCode: virtual });
  }
}
/** @param {string} id */
async function answeredOn(id) {
  await chrome.until(`${movedFrom(id)} || ${shows('Not saved')}`);
  assert.equal(await chrome.evaluate(shows('Not saved')), false, (await text('.naming-said')).join());
}
async function openDeck() {
  await chrome.size(...WIDTHS[0]);
  await chrome.theme('dark');
  await load('#view=people&focus=faces', null);
  await chrome.until(`document.querySelector('[data-f-card] #face-name')`);
}

test('P8: the invitation starts the deck, and what is typed is typed: “Sonal”, “Zara”, “Nina”, again once deleted', async () => {
  front.faces({ state: 'on', scanned: 30, photos: 30 });
  const deck = await until('the deck read whole', async () => {
    const read = await deckNow();
    return read.ready && !read.building && !read.people_building ? read : undefined;
  });
  await chrome.size(...WIDTHS[0]);
  await load('#view=people', null);
  const invitation = '.pp-side [data-person="faces"]';
  await chrome.until(`document.querySelector('${invitation} .ck-side__line')?.textContent.includes(' to name')`);
  assert.deepEqual((await text(`${invitation} .ck-side__line`)).map(line => line.replace(/\s/gu, ' ')),
    [[`${deck.cards.length} to name`, deck.maybe.people ? `${deck.maybe.people} ${deck.maybe.people === 1 ? 'person' : 'people'} to check` : '']
      .filter(Boolean).join(' · ')]);
  await click(invitation);
  await chrome.until(`document.querySelector('[data-f-card] #face-name')`);
  assert.equal(await cardShown(), deck.cards[0].id);
  assert.equal(await chrome.evaluate(`document.activeElement?.id`), 'face-name');
  const offering = deck.cards.find((/** @type {any} */ card) => card.suggestions.length > 0);
  assert.ok(offering, 'a card offers someone');
  while (await cardShown() !== offering.id) {
    const at = await cardShown();
    await stroke('ArrowRight');
    await chrome.until(movedFrom(at));
  }
  const first = offering.id;
  await shot('faces-deck', `document.querySelector('[data-f-card]')`);
  for (const name of ['Sonal', 'Zara', 'Nina']) {
    await chrome.press(name[0]);
    await typeKeys(name.slice(1));
    assert.equal(await fieldText(), name);
    assert.equal(await cardShown(), first);
    assert.deepEqual((await text('.naming-rows .ck-namerow.is-lit .ck-namerow__name')), [`New person “${name}”`]);
    assert.deepEqual(await text('.naming-rows .ck-namerow.is-lit .ck-namerow__key'), ['⏎']);
    assert.equal((await text('.naming-rows .ck-namerow__name')).at(-1), 'Set aside');
    for (let left = name.length; left > 0; left -= 1) await stroke('Backspace');
    assert.equal(await fieldText(), '');
    assert.equal(await cardShown(), first);
  }
  await chrome.evaluate(`document.querySelector('[data-f-face]').focus()`);
  await click('[data-f-face]:first-of-type');
  assert.deepEqual(await attr('[data-f-face][aria-pressed="true"]', 'aria-pressed'), ['true']);
  await chrome.evaluate(`document.querySelector('[data-f-face]').focus()`);
  await typeKeys('Sonal');
  assert.equal(await fieldText(), 'Sonal');
  await shot('faces-deck-typing', `document.querySelector('.naming-rows .ck-namerow.is-lit')`);
  await stroke('Escape');
  assert.equal(await fieldText(), '');
  assert.equal(await cardShown(), first);
  assert.ok((await text('.naming-rows .ck-namerow__name'))[0] !== 'New person “Sonal”');
  assert.deepEqual(chrome.thrown, []);
});

test('P8: the deck fills the window: at 1440 and 1920 the card spans the page less its margins', async () => {
  await openDeck();
  const measure = `(() => { const page = document.querySelector('.pp-faces'); const style = getComputedStyle(page);
    const box = selector => { const each = document.querySelector(selector).getBoundingClientRect();
      return { left: each.left, right: each.right, top: each.top, bottom: each.bottom, width: each.width }; };
    return { scroller: page.parentElement.clientWidth, page: box('.pp-faces').width,
      inner: page.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      card: box('[data-f-card]').width, faces: box('.naming-faces'), answer: box('.naming-answer') }; })()`;
  /** @type {Record<string, unknown>} */
  const widths = {};
  for (const [width, height] of /** @type {const} */ ([[1440, 900], [1920, 1080]])) {
    await chrome.size(width, height);
    const got = await chrome.evaluate(measure);
    widths[width] = got;
    assert.equal(Math.round(got.page), got.scroller, JSON.stringify(got));
    assert.equal(Math.round(got.card), Math.round(got.inner), JSON.stringify(got));
    assert.ok(got.faces.right <= got.answer.left && Math.abs(got.faces.top - got.answer.top) < 1, JSON.stringify(got));
    assert.ok(got.faces.width > got.answer.width, JSON.stringify(got));
    assert.ok(await chrome.evaluate(`(() => { const scroll = document.querySelector('.pp-faces').parentElement;
      const faces = document.querySelector('.naming-faces').getBoundingClientRect();
      const grid = document.querySelector('.naming-grid').getBoundingClientRect();
      return scroll.scrollHeight <= scroll.clientHeight && grid.bottom <= faces.bottom; })()`), JSON.stringify(got));
    if (width === 1920) {
      for (const theme of /** @type {const} */ (['dark', 'light'])) {
        await chrome.theme(theme);
        await chrome.shoot(join(page.out, `faces-deck-1920-${theme}.png`));
      }
      await chrome.theme('dark');
    }
  }
  await chrome.size(...WIDTHS[1]);
  const narrow = await chrome.evaluate(measure);
  assert.ok(narrow.answer.top >= narrow.faces.bottom, JSON.stringify(narrow));
  seen.deck = { ...widths, 390: narrow };
  await chrome.size(...WIDTHS[0]);
});

test('P8: Back loops: take a row, Back, Set aside, Back, Skip; the deck moves each time, and Back is one answer deep', async () => {
  await openDeck();
  await stub(`(url, init, real) => url !== 'api/faces' ? real(url, init) : real(url, init).then(async response => {
    const read = await response.clone().json();
    if (read.ready) window.deckRead = read.cards.map(card => card.id);
    return response;
  })`);
  const one = await cardShown();
  await stroke('ArrowRight');
  await chrome.until(movedFrom(one));
  const two = await cardShown();
  const faces = await facesOfGroup(two);
  const before = (await held()).faces;
  const stated = () => held().then(now => faces.filter(face => JSON.stringify(now.faces.get(face) ?? null)
    !== JSON.stringify(before.get(face) ?? null)));
  const rows = await chrome.evaluate(`document.querySelectorAll('[data-f-row]').length`);
  let count = landed();
  await click(`[data-f-row="${Math.min(1, rows - 1)}"]`);
  await answeredOn(two);
  await landedPast(count);
  assert.notDeepEqual(await stated(), []);
  await chrome.until(lacks(two));
  count = landed();
  await stroke('ArrowLeft');
  assert.equal(await cardShown(), two);
  await landedPast(count);
  assert.deepEqual(await stated(), []);
  count = landed();
  await click('.naming-rows .ck-namerow:last-child');
  await answeredOn(two);
  await landedPast(count);
  assert.deepEqual((await held()).faces.get(faces[0]), { ignore: true });
  await chrome.until(lacks(two));
  count = landed();
  await chrome.evaluate(`document.querySelector('[data-f-back]').click()`);
  assert.equal(await cardShown(), two);
  await landedPast(count);
  assert.deepEqual(await stated(), []);
  await stroke('ArrowRight');
  await chrome.until(movedFrom(two));
  await stroke('ArrowLeft');
  await chrome.until(showing(two));
  await stroke('ArrowLeft');
  await chrome.until(showing(one));
  await chrome.until(`document.querySelector('[data-f-back]').disabled`);
  await stroke('ArrowLeft');
  assert.equal(await cardShown(), one);
  await stroke('ArrowRight');
  await chrome.until(movedFrom(one));
  assert.deepEqual(chrome.thrown, []);
});

test('P8: a deck read again in another order keeps the card shown, and draws none of its faces again', async () => {
  await openDeck();
  await stub(`(url, init, real) => url !== 'api/faces' ? real(url, init) : real(url, init).then(async response => {
    const read = await response.json();
    if (read.ready) {
      read.cards.reverse();
      for (const card of read.cards) card.suggestions.unshift({ key: 'person:reversed', target: { kind: 'person',
        id: 'person:reversed' }, name: 'Reversed Read', face: null, channels: [], messages: 0, reason: '' });
    }
    return (${JSON_ANSWER})(read, response.status);
  })`);
  const one = await cardShown();
  const count = landed();
  await chrome.evaluate(`(() => {
    document.querySelector('.naming-rows .ck-namerow:last-child').click();
    window.keptFace = document.querySelector('#face-faces img');
    window.keptCard = document.querySelector('[data-f-card]')?.dataset.fCard;
  })()`);
  await answeredOn(one);
  const two = await chrome.evaluate('window.keptCard');
  await landedPast(count);
  await chrome.until(shows('Reversed Read'));
  assert.equal(await cardShown(), two);
  assert.equal(await chrome.evaluate(`Boolean(window.keptFace?.isConnected)`), true);
  const undone = landed();
  await stroke('ArrowLeft');
  await chrome.until(showing(one));
  await landedPast(undone);
  await chrome.evaluate(`(async () => {
    while (!(await window.realFetch('api/faces').then(response => response.json())).cards?.some(card => card.id === ${JSON.stringify(one)})) {
      await new Promise(done => setTimeout(done, 100));
    }
    window.groupBack = true;
  })(), true`);
  await chrome.until('window.groupBack');
  assert.deepEqual(chrome.thrown, []);
});

test('P8: skip every card: the finish says how many were skipped, and goes through them again', async () => {
  await openDeck();
  const deck = await deckNow();
  const cards = deck.cards.length + (deck.checks ?? []).length;
  let skipped = 0;
  while (!(await chrome.evaluate(`Boolean(document.querySelector('[data-f-again]'))`))) {
    if (await chrome.evaluate(`Boolean(document.querySelector('[data-f-keep]'))`)) {
      await stroke('Enter');
      await chrome.until(`document.querySelector('[data-f-card]')`);
      continue;
    }
    const at = await cardShown();
    await stroke('ArrowRight');
    skipped += 1;
    await chrome.until(`${movedFrom(at)} || document.querySelector('[data-f-keep], [data-f-again]')`);
    assert.ok(skipped <= cards, 'no card is shown twice');
  }
  assert.equal(skipped, cards);
  assert.deepEqual(await text('.naming-title'), [`${cards} skipped`]);
  assert.deepEqual(await text('[data-f-again] .ck-btn__label'), ['Go through the skipped again']);
  await shot('faces-finish', `document.querySelector('[data-f-again]')`);
  await stroke('Enter');
  await chrome.until(showing(deck.cards[0].id));
});

test('P8: a save the home refuses: its card comes back first with the reason, its row lit by who it names, the answers after it stand', async () => {
  await openDeck();
  await stub(`(url, init, real) => {
    if (url !== 'api/owner/act' || window.refused) return real(url, init);
    window.refused = true;
    return new Promise(done => { window.refuse = () => done((${JSON_ANSWER})({ error: 'Lifestream refused it.' }, 422)); });
  }`);
  const one = await cardShown();
  const facesOne = await facesOfGroup(one);
  const before = (await held()).faces;
  await click('[data-f-face]:first-of-type');
  await click('[data-f-row="0"]');
  await chrome.until(movedFrom(one));
  const two = await cardShown();
  const facesTwo = await facesOfGroup(two);
  const count = landed();
  await click('.naming-rows .ck-namerow:last-child');
  await chrome.until(movedFrom(two));
  await chrome.until('typeof window.refuse === "function"');
  await chrome.evaluate('window.refuse()');
  await chrome.until(showing(one));
  await chrome.until(shows('Not saved: Lifestream refused it.'));
  assert.equal(await chrome.evaluate(`document.querySelectorAll('[data-f-face][aria-pressed="true"]').length`), 1);
  assert.deepEqual(await attr('.naming-rows .ck-namerow.is-lit', 'data-f-row'), ['0']);
  const litName = `document.querySelector('.naming-rows .ck-namerow.is-lit')?.textContent ?? ''`;
  assert.match(await chrome.evaluate(litName), /Person A/u);
  await shot('faces-deck-not-saved', shows('Not saved: Lifestream refused it.'));
  await landedPast(count);
  await chrome.until(`[...document.querySelectorAll('.naming-rows .ck-namerow')].some(row => row.textContent.startsWith('You'))`);
  assert.match(await chrome.evaluate(litName), /Person A/u, 'the light moved with the rows read again');
  assert.deepEqual(await attr('.naming-rows .ck-namerow.is-lit', 'data-f-row'), ['1']);
  const after = (await held()).faces;
  assert.deepEqual(facesTwo.map(face => after.get(face)), facesTwo.map(() => ({ ignore: true })));
  assert.deepEqual(facesOne.map(face => after.get(face) ?? null), facesOne.map(face => before.get(face) ?? null));
});

test('P8: a save never sent: Try again sends the answer that failed, whatever the field finds since', async () => {
  await openDeck();
  await stub(`(url, init, real) => {
    if (url !== 'api/owner/act') return real(url, init);
    const { request, ...action } = JSON.parse(init.body);
    (window.sentActs ??= []).push(action);
    if (window.sentActs.length === 1) return (${JSON_ANSWER})({ error: 'Can’t reach Lifestream.', code: 'GONE' }, 503);
    return real(url, init).then(response => {
      response.clone().json().then(body => { window.lastAct = body; });
      return response;
    });
  }`);
  const one = await cardShown();
  const count = landed();
  await click('[data-f-row="0"]');
  await chrome.until(`${showing(one)} && document.querySelector('[data-f-again-act]')`);
  assert.equal(await chrome.evaluate(shows('Not sent')), true);
  await chrome.evaluate(`document.querySelector('#face-name').focus(); true`);
  await typeKeys('Zed');
  await chrome.until(`document.querySelector('#face-name')?.value === 'Zed'`);
  await click('[data-f-again-act]');
  await chrome.until('window.sentActs?.length === 2 && window.lastAct');
  const [failed, resent] = /** @type {unknown[]} */ (await chrome.evaluate('window.sentActs'));
  assert.deepEqual(resent, failed, 'Try again sent another answer');
  await chrome.until(movedFrom(one));
  await landedPast(count);
  await undoLast(await chrome.evaluate('window.lastAct'));
  await chrome.evaluate('window.fetch = window.realFetch; true');
});

test('P8: the deck\'s keys are the deck\'s alone: Enter on the sidebar\'s Days goes to Days and takes no row', async () => {
  await openDeck();
  await stub(`(url, init, real) => {
    if (url === 'api/owner/act') window.acts = (window.acts ?? 0) + 1;
    return real(url, init);
  }`);
  await stroke('ArrowDown');
  assert.equal(await chrome.evaluate(`document.querySelectorAll('.naming-rows .ck-namerow.is-lit').length`), 1);
  await chrome.evaluate(`document.querySelector('a.sidebar__item[href="#view=days"]').focus()`);
  for (const type of ['keyDown', 'keyUp']) {
    await chrome.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
      ...(type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {}) });
  }
  await chrome.until(`location.hash.includes('view=days')`);
  assert.equal(await chrome.evaluate('window.acts ?? 0'), 0);
});

test('P8: Show all lays every face out, and marking one keeps where it was scrolled and the field the focus', async () => {
  await chrome.size(...WIDTHS[0]);
  await load('#view=days', null);
  await stub(`(url, init, real) => {
    const grown = (answer, change) => answer.then(async response => (${JSON_ANSWER})(change(await response.json())));
    if (url === 'api/faces') {
      return grown(real(url, init), read => {
        if (read.ready && read.cards[0]) read.cards[0].faces = 40;
        return read;
      });
    }
    if (url.startsWith('api/faces/group?')) {
      return grown(real(url, init), group => ({ ...group, faces: 40, every: Array.from({ length: 40 },
        (_, at) => at < group.every.length ? group.every[at] : group.every[at % group.every.length] + ':' + at) }));
    }
    return real(url, init);
  }`);
  await go('#view=people&focus=faces');
  await chrome.until(`document.querySelector('[data-f-card] [data-f-all]')`);
  await click('[data-f-all]');
  await chrome.until(`document.querySelectorAll('[data-f-face]').length === 40`);
  const scrolled = await chrome.evaluate(`(() => { const box = document.querySelector('.naming-gridbox');
    box.scrollTop = box.scrollHeight; return box.scrollTop; })()`);
  assert.ok(scrolled > 0, 'every face scrolls inside the faces\' side');
  await shot('faces-deck-show-all', `document.querySelectorAll('[data-f-face]').length === 40`);
  await chrome.evaluate(`(() => { const box = document.querySelector('.naming-gridbox'); box.scrollTop = box.scrollHeight;
    [...document.querySelectorAll('[data-f-face]')].at(-1).click(); })()`);
  assert.equal(await chrome.evaluate(`[...document.querySelectorAll('[data-f-face]')].at(-1).getAttribute('aria-pressed')`), 'true');
  assert.equal(await chrome.evaluate(`document.querySelector('.naming-gridbox').scrollTop`), scrolled);
  assert.equal(await chrome.evaluate(`document.activeElement?.id`), 'face-name');
});
