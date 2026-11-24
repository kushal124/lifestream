import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { daysPage, drawn, HOME_DAY, UNNAMED } from './stand-ins/days-page.mjs';
import { until } from './until.mjs';

const dayPages = daysPage({ file: 'days-unnamed', mutable: true });
const { page, asked, journey, pageAsked, load, fromDoor, fromDashboard } = dayPages;

/** @param {string} day */
const reads = day => pageAsked('/api/page/day').filter(search => new URLSearchParams(search).get('day') === day).length;

before(() => dayPages.open());

after(() => dayPages.close());

const HEADS = `(() => {
  const colour = token => {
    const probe = document.createElement('span');
    probe.style.color = 'var(' + token + ')';
    document.querySelector('.dy').append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  };
  const tokens = { canvas: colour('--canvas'), secondary: colour('--text-secondary'), text: colour('--text') };
  const named = value => Object.keys(tokens).find(key => tokens[key] === value) ?? value;
  const whole = part => part ? part.dataset.full ?? part.textContent : '';
  return [...document.querySelectorAll('.dy-block--stay > .dy-head')].map(head => {
    const disc = getComputedStyle(head.querySelector('.dy-head__disc'));
    const slot = head.querySelector('.dy-head__slot:not(.dy-nameit)');
    const link = head.querySelector('.dy-nameit');
    return { name: whole(head.querySelector('.dy-head__name')), line: whole(head.querySelector('.dy-head__line[data-w]')),
      quiet: head.classList.contains('dy-head--quiet'),
      ring: [disc.borderTopWidth, disc.borderTopStyle, disc.borderTopStyle === 'none' ? '' : named(disc.borderTopColor)].join(' ').trim(),
      fill: named(disc.backgroundColor), colour: named(getComputedStyle(head.querySelector('.dy-head__name')).color),
      slot: slot ? (getComputedStyle(slot).color === 'rgba(0, 0, 0, 0)' ? 'unseen' : 'seen') : null,
      height: head.getBoundingClientRect().height,
      link: link ? { key: link.dataset.dNameit, href: link.getAttribute('href'), label: link.getAttribute('aria-label'),
        inButton: Boolean(link.closest('button')) } : null };
  });
})()`;

/** @param {string} heads */
const PRESSES = heads => `[...${heads}].map(head => {
  const at = element => { const box = element.getBoundingClientRect(); return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2); };
  const link = head.querySelector('.dy-nameit');
  const press = head.querySelector(':scope > .dy-head__press[data-d-stay]');
  return { link: link ? at(link) === link : null, name: press ? at(head.querySelector('.dy-head__name')) === press : null };
})`;

describe('days-unnamed', () => {
  before(() => journey('days-unnamed'));

  test('U1: a stay at a place the person did not name is its row\'s quiet head, at the Mac\'s size and under 760; the gallery draws it', async () => {
    const { chrome } = dayPages.opened;
    dayPages.serve([UNNAMED]);
    await load(`#view=days&on=${UNNAMED}`);
    await chrome.until(drawn(UNNAMED));
    const heads = /** @type {any[]} */ (await chrome.evaluate(HEADS));
    const quiet = { quiet: true, ring: '2px solid secondary', fill: 'canvas', colour: 'secondary', slot: 'unseen', link: null };
    const owned = { quiet: false, ring: '0px none', fill: 'secondary', colour: 'text', slot: null, link: null };
    assert.deepEqual(heads.map(({ name, line, quiet: q, ring, fill, colour, slot, link }) => ({ name, line, quiet: q, ring, fill, colour,
      slot, link })), [
      { name: 'Synthetic Home', line: '', ...owned },
      { name: 'Near Synthetic Home', line: '1.8 km away', ...quiet },
      { name: 'Fresh from Synthetic Farm', line: '', ...owned },
      { name: 'Near Fresh from Synthetic Farm', line: '12 km away · stated by Timeline', ...quiet },
      { name: 'Synthetic Port Town', line: '', ...quiet },
      { name: 'Unnamed place', line: '', ...quiet },
      { name: 'a hidden place', line: 'from photos', ...quiet },
      { name: 'Synthetic Home', line: '', ...owned },
    ]);
    assert.equal(await chrome.evaluate(`[...document.querySelectorAll('.dy-row--move')].some(row => /Near |unnamed/u.test(row.textContent))`),
      false);
    await page.shot('heads', drawn(UNNAMED));
    /** @param {any[]} drawn */
    const kinds = drawn => [true, false].map(quiet => [...new Set(drawn.filter(head => head.quiet === quiet).map(head => head.height))]);
    assert.deepEqual(kinds(heads), [[28], [32]]);
    assert.deepEqual(await chrome.evaluate(`[...new Set([...document.querySelectorAll('.dy-head--quiet .dy-head__name')]
      .map(name => getComputedStyle(name).fontSize + ' ' + getComputedStyle(name).fontWeight))]`), ['13px 500']);
    const oneLine = Math.max(...heads.map(head => head.height));
    await chrome.size(700, 900);
    await chrome.until(`document.querySelector('.dy-head').getBoundingClientRect().height > ${oneLine}`);
    const narrow = /** @type {any[]} */ (await chrome.evaluate(HEADS));
    const [quietHeights, namedHeights] = kinds(narrow);
    assert.ok(quietHeights.length === 1 && namedHeights.length === 1 && quietHeights[0] > 28 && namedHeights[0] > oneLine
      && quietHeights[0] < namedHeights[0], JSON.stringify({ quietHeights, namedHeights, oneLine }));
    assert.deepEqual(narrow.map(head => [head.name, head.ring]), heads.map(head => [head.name, head.ring]));
    await page.shot('heads-narrow', drawn(UNNAMED));
    await chrome.size(1440, 900);
    await chrome.load(`kit-gallery.html#group=${encodeURIComponent('Days · a stay at a place you did not name')}`, '');
    const specimen = `document.querySelector('.gallery__specimen--unnamed')`;
    await chrome.until(`${specimen}?.querySelectorAll('.dy-head--quiet').length === 4`);
    assert.equal(await chrome.evaluate(`document.querySelectorAll('.gallery__group').length`), 1);
    const headInView = `${specimen}.getBoundingClientRect().top >= 0 && ${specimen}.getBoundingClientRect().top < innerHeight`;
    assert.deepEqual(await chrome.evaluate(`[...${specimen}.querySelectorAll('.dy-nameit')].map(link => link.closest('.dy-block')
      .querySelector('.dy-head__name').textContent)`), ['Near Synthetic Home', 'Lisbon']);
    await chrome.evaluate(`${specimen}.scrollIntoView({ block: 'start' })`);
    assert.deepEqual(await chrome.evaluate(PRESSES(`${specimen}.querySelectorAll('.dy-head--quiet')`)),
      [{ link: true, name: true }, { link: null, name: null }, { link: true, name: true }, { link: null, name: null }]);
    await page.shot('gallery', headInView);
    await chrome.size(390, 844);
    await chrome.evaluate(`${specimen}.scrollIntoView({ block: 'start' })`);
    await page.shot('gallery-390', headInView);
    await chrome.size(1440, 900);
  });

  test('U5: a quiet head with rows opens from its button, and its caret turns as a named head\'s does', async () => {
    const { chrome } = dayPages.opened;
    await load(`#view=days&on=${UNNAMED}`);
    await chrome.until(drawn(UNNAMED));
    const block = `[...document.querySelectorAll('.dy-block--stay')].find(block => block.querySelector(':scope > .dy-head--quiet .dy-head__name')?.textContent === 'Unnamed place')`;
    const key = await chrome.evaluate(`${block}.dataset.dBlock`);
    const press = `.dy-block[data-d-block="${key}"] > .dy-head > .dy-head__press`;
    const state = () => chrome.evaluate(`(() => {
      const head = ${block}.querySelector(':scope > .dy-head');
      return [head.classList.contains('is-open'), head.querySelector('.dy-head__press').getAttribute('aria-expanded'),
        Math.round(new DOMMatrix(getComputedStyle(head.querySelector('.dy-caret > .ck-icon')).transform).b)];
    })()`);
    assert.deepEqual(await state(), [false, 'false', 0]);
    await page.click(press);
    await chrome.until(`${block}.querySelector(':scope > .dy-head').classList.contains('is-open')
      && new DOMMatrix(getComputedStyle(${block}.querySelector('.dy-caret > .ck-icon')).transform).b > 0.99`);
    assert.deepEqual(await state(), [true, 'true', 1]);
    assert.match(await chrome.evaluate(`${block}.querySelector('.dy-head__press').getAttribute('aria-label')`), /^Fold Unnamed place/u);
  });
});

describe('days-name-it', () => {
  before(async () => {
    await journey('days-name-it');
    await page.command('unnamed');
  });

  const NEAR = `[...document.querySelectorAll('.dy-block--stay')].find(block => block.querySelector(':scope > .dy-head--quiet .dy-head__line')?.textContent === '1.8 km away')`;
  const spotKeys = async () => (await fromDashboard('/api/life/places')).spots
    .filter((/** @type {{ worth: boolean }} */ spot) => spot.worth).map((/** @type {{ key: string }} */ spot) => spot.key);

  test('U1, U2: "Name it" stands on the worth spot\'s stay alone, as the page answers its head\'s place, beside the name it does not cover', async () => {
    const { chrome } = dayPages.opened;
    await load(`#view=days&on=${HOME_DAY}`);
    await chrome.until(`${drawn(HOME_DAY)} && ${NEAR}?.querySelector(':scope > .dy-head .dy-nameit')`);
    const answer = /** @type {import('../public/pages.js').Day} */ (await fromDoor(`/v1/page/day?day=${HOME_DAY}`));
    const spots = answer.chapters.flatMap(chapter => chapter.head?.place ? [chapter.head.place] : []);
    const listed = await spotKeys();
    assert.equal(listed.length, 1);
    assert.deepEqual(spots, listed);
    const heads = /** @type {any[]} */ (await chrome.evaluate(HEADS)).filter(head => head.quiet);
    assert.deepEqual(heads.map(head => [head.name, head.line, head.ring, head.link]), [
      ['Near Synthetic Office', '1.8 km away', '2px solid secondary', { key: listed[0], href: `#view=places&focus=${encodeURIComponent(listed[0])}`,
        label: 'Name it, Near Synthetic Office', inButton: false }],
      ['Near Synthetic Office', '2.9 km away', '2px solid secondary', null]]);
    assert.deepEqual(await chrome.evaluate(PRESSES(`${NEAR}.querySelectorAll(':scope > .dy-head')`)), [{ link: true, name: null }]);
    await page.shot('name-it', `${NEAR}?.querySelector(':scope > .dy-head .dy-nameit')`);
    await chrome.size(700, 900);
    await chrome.until(`${NEAR}.querySelector(':scope > .dy-head').getBoundingClientRect().height === 48`);
    await page.shot('name-it-narrow', `${NEAR}?.querySelector(':scope > .dy-head .dy-nameit')`);
    await chrome.size(1440, 900);
  });

  test('U3: "Name it" opens its spot\'s naming card on Places, and Back with nothing named returns to the day, read no more', async () => {
    const { chrome } = dayPages.opened;
    const [key] = await spotKeys();
    const before = reads(HOME_DAY);
    await chrome.evaluate(`${NEAR}.querySelector(':scope > .dy-head .dy-nameit').click()`);
    await chrome.until(`location.hash.includes('view=places') && document.querySelector('.main__section--places:not([hidden]) .pl-naming')`);
    assert.equal(await chrome.evaluate(`new URLSearchParams(location.hash.slice(1)).get('focus')`), key);
    await page.shot('card', `document.querySelector('.main__section--places:not([hidden]) .pl-naming .pl-name input')`);
    await chrome.evaluate('history.back()');
    await chrome.until(`${drawn(HOME_DAY)} && document.querySelector('.main__section--days:not([hidden])') && ${NEAR}?.querySelector(':scope > .dy-head .dy-nameit')`);
    await chrome.evaluate(`requestAnimationFrame(() => setTimeout(() => void fetch('/favicon.ico?u3').catch(() => undefined)))`);
    await until('the marker asked', () => asked.some(address => address.includes('favicon.ico?u3')));
    assert.equal(reads(HOME_DAY), before);
  });

  test('U4: named and saved, Back to the day: read again on the day the home tells, the stay its place, no link, the side and its map the place', async () => {
    const { chrome } = dayPages.opened;
    await chrome.evaluate(`${NEAR}.querySelector(':scope > .dy-head .dy-nameit').click()`);
    await chrome.until(`document.querySelector('.main__section--places:not([hidden]) .pl-naming .pl-name input')`);
    await chrome.type('.main__section--places .pl-name input', 'Synthetic Studio');
    await chrome.until(`!document.querySelector('.pl-card .ck-namerow--reading')`);
    const before = reads(HOME_DAY);
    await page.click('.main__section--places [data-pl-save-name]');
    await chrome.until(`location.hash.includes('view=places') && !location.hash.includes('focus=spot')`);
    await chrome.evaluate('history.back()');
    await chrome.until(`location.hash.includes('focus=spot')`);
    await chrome.evaluate('history.back()');
    await chrome.until(`${drawn(HOME_DAY)} && document.querySelector('.main__section--days:not([hidden])')`);
    await until('the day read again once the home told it', () => reads(HOME_DAY) > before);
    await chrome.until(`[...document.querySelectorAll('.dy-block--stay > .dy-head')].some(head => head.querySelector('.dy-head__name').textContent === 'Synthetic Studio'
      && !head.classList.contains('dy-head--quiet')) && !document.querySelector('.dy-nameit')`);
    const heads = /** @type {any[]} */ (await chrome.evaluate(HEADS));
    assert.deepEqual(heads.filter(head => head.name === 'Synthetic Studio').map(head => [head.quiet, head.ring, head.link]),
      [[false, '0px none', null]]);
    await chrome.until(`[...document.querySelectorAll('.ds [data-d-unit] .ck-punit__name')].map(name => name.textContent).join('|')
      .includes('Synthetic Studio') && ![...document.querySelectorAll('.ds [data-d-unit] .ck-punit__name')]
      .some(name => name.textContent === 'Near Synthetic Office')`);
    await chrome.until(`(document.querySelector('[data-map="day-map"]')?.dataset.named ?? '').includes('Synthetic Studio')
      && !(document.querySelector('[data-map="day-map"]').dataset.named ?? '').includes('Near Synthetic Office')`);
    await page.shot('named', `!document.querySelector('.dy-nameit')`);
  });
});
