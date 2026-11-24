import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS_BARE } from '../public/kit-gallery-llm.js';
import { SENSES } from './stand-ins/onboarding-home.mjs';
import { given, on, onboardingPage, shows, state, vaulted } from './stand-ins/onboarding-page.mjs';

const page = onboardingPage({ file: 'onboarding-after' });
/** @type {Awaited<ReturnType<typeof page.open>>['front']} */
let front;
/** @type {Awaited<ReturnType<typeof page.open>>['chrome']} */
let chrome;

before(() => page.open());

afterEach(() => {
  front?.reset();
  assert.deepEqual(chrome?.thrown.splice(0), []);
});

after(() => page.close());

describe('onboarding-after: Streams and the pages after the first run', () => {

  before(async () => {
    ({ front, chrome } = await page.journey('onboarding-after'));
  });

  const { load, shot, click, text, acts, setState } = page;

  /** @param {string} selector */
  async function names(selector) {
    /** @type {string[]} */
    const found = [];
    for (let at = 0; ; at += 1) {
      const { result } = await chrome.send('Runtime.evaluate', { expression: `document.querySelectorAll(${JSON.stringify(selector)})[${at}]` });
      if (!result.objectId) return found;
      const { nodes } = await chrome.send('Accessibility.getPartialAXTree', { objectId: result.objectId, fetchRelatives: false });
      found.push(String(nodes[0]?.name?.value ?? '').trim());
    }
  }

  test('Settings’ Show code opens the iPhone’s flow in its page, on its code', async () => {
    front.scene('phone');
    await load(`#view=connectors&dialog=${encodeURIComponent('settings/iphone')}`, given);
    const pair = `[...document.querySelectorAll('.ck-dialog .ck-btn')].find(each => each.textContent.trim() === 'Show code')`;
    await chrome.until(pair);
    await chrome.evaluate(`${pair}.click()`);
    await shot('streams-pair-flow', `document.querySelector('.ck-dialog')?.textContent.includes('Connect your iPhone')
    && document.querySelector('.ck-dialog')?.textContent.includes('Pair with this Mac') && location.hash.includes('flow=phone')`);
    assert.ok(await chrome.evaluate(`location.hash.includes('view=connectors') && !document.querySelector('.ob')`));
    await chrome.until('window.hostActs.length === 1');
    assert.deepEqual(await acts(), [{ act: 'pairing', do: 'open' }]);
    await click('.ck-dialog [data-flow="back"]');
    await chrome.until(`${pair} && !location.hash.includes('flow=')`);
    await chrome.until('window.hostActs.length === 1');
    assert.deepEqual(await acts(), [{ act: 'pairing', do: 'close' }]);
  });

  test('Streams: the same arriving words on a source’s row, and Photos on This Mac', async () => {
    const granted = ['fullDiskAccess', ...SENSES];
    front.scene('counting');
    await load('#view=connectors', given);
    const labels = `[...document.querySelectorAll('.ck-cline__open')].map(each => (each.getAttribute('aria-label') ?? '').replace(/\\s+/g, ' '))`;
    await shot('streams-arriving', `${labels}.some(label => label.includes('Back to Mar 2019 · 12,000 messages left · about 20 min'))`);
    assert.deepEqual((await text('.ck-cline__line')).filter(each => each.startsWith('Back to ')).sort(),
      ['Back to Mar 2019 · 12,000 messages left · about 20 min · Mac', 'Back to Mar 2019 · 9,000 pages left · Mac']);
    assert.ok((await chrome.evaluate(labels)).some((/** @type {string} */ label) => /^Notes\b.*Nothing yet/u.test(label)));

    front.scene('photos-denied');
    await load('#view=connectors', state(granted));
    const banner = `(document.querySelector('.cn-alerts .ck-strip__more[aria-expanded="false"]')?.click(), [...document.querySelectorAll('.cn-alerts .ck-strip')].find(each => each.textContent.includes('Photos needs access')))`;
    await shot('streams-photos-not-allowed', `${banner}?.querySelector('button.ck-strip__act')?.textContent.includes('Allow')`);
    assert.ok(await chrome.evaluate(`(() => {
    const scroll = document.querySelector('.ck-page__scroll');
    const bar = document.querySelector('.ck-page__bar');
    const riser = document.createElement('div');
    riser.style.cssText = 'position: relative; z-index: 50; height: 400px; background: red';
    scroll.prepend(riser);
    scroll.scrollTop = 120;
    const box = bar.getBoundingClientRect();
    const at = document.elementFromPoint(box.left + 40, box.top + box.height / 2);
    riser.remove();
    scroll.scrollTop = 0;
    return bar.contains(at);
  })()`));
    await chrome.evaluate(`${banner}.querySelector('button.ck-strip__act').click()`);
    await chrome.until('window.hostActs.length === 1');
    assert.deepEqual(await acts(), [{ act: 'allow', grants: ['photos'], label: 'Allow' }]);
  });

  test('Places with no place yet: Pair, or the phone paired and when places come', async () => {
    front.placeless(true);
    front.scene('counting');
    await load('#view=places', { ...given, grants: state(['fullDiskAccess', ...SENSES]).grants });
    await shot('places-none-unpaired', `document.querySelector('[data-pl-connect="phone"]')`);
    await chrome.evaluate(`window.notReloaded = true`);
    front.paired('phone');
    await shot('places-none-paired', `document.querySelector('.ck-offers .ck-done')`);
    assert.equal(await chrome.evaluate(`document.querySelector('[data-pl-connect="phone"]')`), null, 'Pair offered with a phone paired');
    assert.deepEqual(await text('.ck-offers .ck-offer:first-child .ck-offer__main > *'),
      ['Person A’s iPhone', 'Places appear once your iPhone sends where you’ve been.']);
    assert.deepEqual(await text('.ck-offers .ck-offer:first-child .ck-done'), ['Connected']);
    assert.equal(await chrome.evaluate(`window.notReloaded`), true, 'the page reloaded to see the phone');
    front.placeless(false);
  });

  test('the feed: a listener after the last one left hears only what changed', async () => {
    front.scene('counting');
    await load('#view=days', given);
    await chrome.until(`document.querySelector('.dy-day > :is(.dy-list, .ck-none, .dy-state)') && !document.querySelector('.dy.ck-reading')`);
    await chrome.evaluate(`(async () => {
      const Native = window.EventSource;
      window.anotherOpens = 0;
      window.EventSource = class extends Native {
        constructor(...args) {
          super(...args);
          this.addEventListener('open', () => { window.anotherOpens += 1; });
        }
      };
      const live = await import('/ui/live.js?another');
      window.feedHeard = [];
      window.feedStop = live.onHomeChange(change => window.feedHeard.push(change));
    })()`);
    await chrome.until('window.anotherOpens === 1');
    await chrome.evaluate(`(async () => {
      window.feedStop();
      window.feedStop = (await import('/ui/live.js?another')).onHomeChange(change => window.feedHeard.push(change));
    })()`);
    await chrome.until('window.anotherOpens === 2');
    front.scene('phone');
    await chrome.until('window.feedHeard.length > 0');
    assert.deepEqual(await chrome.evaluate('window.feedHeard.map(change => [change.records, change.reset])'), [[true, false]]);
    await chrome.evaluate('window.feedStop()');
  });

  test('the person’s row: Settings in its menu, and the update while one waits, at the sidebar’s foot on every page', async () => {
    const restart = { id: 'do', label: 'Restart to Update', tone: 'caution' };
    const held = { ...given, update: { id: 'update:ready', line: 'Lifestream 2026.10.28 is ready', detail: null,
      acts: [restart], home: false } };
    const row = `document.querySelector('#sidebar-you .ck-account__btn')`;
    const menu = `document.querySelector('#ck-account-menu')`;
    const placed = () => chrome.evaluate(`(() => { const button = ${row}, foot = document.querySelector('#sidebar-foot');
      const line = document.querySelector('#sidebar-line:not([hidden])'), sidebar = document.querySelector('.sidebar');
      const at = button.getBoundingClientRect(), side = sidebar.getBoundingClientRect();
      const words = document.querySelector('.ck-account__name').getBoundingClientRect().left;
      const chat = document.querySelector('#sidebar-sections .sidebar__item span').getBoundingClientRect().left;
      const label = line?.querySelector('.ck-signal__label');
      return { last: sidebar.lastElementChild === foot && foot.lastElementChild === document.querySelector('#sidebar-you'),
        height: Math.round(at.height), words: Math.round(words - chat), bottom: Math.round(side.bottom - at.bottom) <= 16,
        line: line ? { over: line.getBoundingClientRect().bottom <= at.top, words: Math.round(label.getBoundingClientRect().left - chat),
          whole: label.scrollWidth <= label.clientWidth && label.scrollHeight <= label.clientHeight
            && !label.textContent.endsWith('…') } : null }; })()`);
    const opened = () => chrome.evaluate(`(() => { const panel = ${menu}.getBoundingClientRect();
      const at = document.querySelector('#sidebar-you').getBoundingClientRect();
      return { over: panel.bottom <= at.top, near: at.top - panel.bottom < 8, leading: Math.round(panel.left - at.left),
        inside: panel.top >= 0 && panel.left >= 0 && panel.right <= innerWidth && panel.bottom <= innerHeight }; })()`);
    const items = () => chrome.evaluate(`[...${menu}.querySelectorAll('[role="menuitem"]')].map(item => [
      item.querySelector('.ck-flist__label').textContent, item.querySelector('.ck-flist__tag')?.textContent ?? '',
      item.querySelector('.ck-flist__note')?.textContent ?? ''])`);
    await load('#view=days', held);
    await shot('account-row', row);
    assert.deepEqual(await chrome.evaluate(`(() => { const button = ${row};
      return [button.title, Boolean(button.querySelector('.ck-account__dot')), button.querySelector('.ck-account__name').textContent
        .length > 0, Boolean(document.querySelector('.sidebar__settings, .ck-update, .sidebar__top .ck-account'))]; })()`),
    ['Lifestream 2026.10.28 is ready', true, true, false]);
    assert.deepEqual(await placed(), { last: true, height: 34, words: 0, bottom: true, line: { over: true, words: 0, whole: true } });
    assert.equal(await chrome.evaluate(`${menu}.hidden`), true, 'its menu drawn open');
    assert.deepEqual(await chrome.evaluate(`(() => { const panel = document.querySelector('.column').getBoundingClientRect();
      const x = (panel.left + panel.right) / 2, strip = document.elementFromPoint(x, panel.top / 2);
      return [Math.round(panel.top), Boolean(strip?.closest('[data-window-drag]')), Boolean(strip?.closest('.column')),
        Boolean(document.elementFromPoint(x, panel.top + 1)?.closest('.column'))]; })()`), [8, true, false, true]);
    await click('#sidebar-you .ck-account__btn');
    await shot('account-row-open', `!${menu}.hidden`);
    assert.deepEqual(await opened(), { over: true, near: true, leading: 0, inside: true });
    assert.deepEqual(await items(), [['Profile', '', ''], ['Settings', '⌘,', ''], ['Restart to Update', '', 'Lifestream 2026.10.28 is ready']]);
    await chrome.evaluate(`window.rowWas = ${row}; for (const step of [1, 2]) ${row}.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
    await chrome.until(`document.querySelector('#ck-account-act')?.classList.contains('is-lit')`);
    const standing = () => chrome.evaluate(`[!${menu}.hidden, ${row} === window.rowWas, document.activeElement === window.rowWas,
      ${row}.getAttribute('aria-expanded'), ${row}.getAttribute('aria-activedescendant'),
      [...${menu}.querySelectorAll('.is-lit')].map(item => item.id)]`);
    await setState({ ...held, update: null });
    await chrome.until(`!document.querySelector('#ck-account-act') && !document.querySelector('.ck-account__dot')`);
    assert.deepEqual(await standing(), [true, true, true, 'true', 'ck-account-profile', ['ck-account-profile']]);
    assert.deepEqual(await items(), [['Profile', '', ''], ['Settings', '⌘,', '']]);
    assert.deepEqual(await opened(), { over: true, near: true, leading: 0, inside: true });
    await setState(held);
    await chrome.until(`Boolean(document.querySelector('#ck-account-act')) && Boolean(document.querySelector('.ck-account__dot'))`);
    assert.deepEqual(await standing(), [true, true, true, 'true', 'ck-account-profile', ['ck-account-profile']]);
    assert.deepEqual(await items(), [['Profile', '', ''], ['Settings', '⌘,', ''], ['Restart to Update', '', 'Lifestream 2026.10.28 is ready']]);
    assert.deepEqual(await opened(), { over: true, near: true, leading: 0, inside: true });
    assert.deepEqual(await acts(), [], 'an update come or gone took an act');
    await click('#ck-account-act');
    await chrome.until(`window.hostActs.length === 1 && ${menu}.hidden`);
    assert.deepEqual(await acts(), [{ act: 'need', need: 'update:ready', button: 'do' }]);
    for (const away of [`${row}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
      `document.querySelector('.main').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`]) {
      await click('#sidebar-you .ck-account__btn');
      await chrome.until(`!${menu}.hidden`);
      await chrome.evaluate(away);
      await chrome.until(`${menu}.hidden && ${row}.getAttribute('aria-expanded') === 'false'`);
    }
    await click('#sidebar-you .ck-account__btn');
    await chrome.until(`!${menu}.hidden`);
    await click('#ck-account-settings');
    await chrome.until(`location.hash.includes('view=days') && /[#&]dialog=settings/u.test(location.hash)
    && Boolean(document.querySelector('#dialog-layer .cn-set__title'))`);
    await chrome.press('Escape');
    await chrome.until(`!document.querySelector('#dialog-layer .ck-dialog') && !location.hash.includes('dialog=')
    && location.hash.includes('view=days')`);
    await setState({ ...held, recorder: null });
    await chrome.until(`document.querySelector('#sidebar-line').hidden && ${row}`);
    await shot('account-row-alone', row);
    assert.deepEqual(await placed(), { last: true, height: 34, words: 0, bottom: true, line: null });
    await click('#sidebar-you .ck-account__btn');
    await chrome.until(`!${menu}.hidden`);
    assert.deepEqual(await opened(), { over: true, near: true, leading: 0, inside: true });
    await chrome.evaluate(`${row}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await chrome.until(`${menu}.hidden`);
    await setState(held);
    await chrome.until(`!document.querySelector('#sidebar-line').hidden`);
    assert.deepEqual(await acts(), [], 'a menu put away took an act');
    await chrome.size(720, 660, 1);
    await chrome.until(`getComputedStyle(document.querySelector('.sidebar')).flexDirection === 'row' && ${row}`);
    await shot('account-row-narrow', row);
    const rows = /** @type {string[]} */ (await names('.sidebar__list a.sidebar__item'));
    assert.deepEqual(rows.map(each => each.split(' ')[0]), ['Search', 'Chat', 'Timeline', 'People', 'Places', 'Connectors', 'Agents'], rows.join(' | '));
    assert.deepEqual(await chrome.evaluate(`(() => { const at = ${row}.getBoundingClientRect();
      const bar = document.querySelector('.sidebar').getBoundingClientRect();
      const line = document.querySelector('#sidebar-line');
      return { line: line.hidden || getComputedStyle(line).display === 'none', shown: at.width > 0 && at.height > 0,
        inBar: at.top >= bar.top && at.bottom <= bar.bottom, trailing: Math.round(bar.right - at.right) <= 16,
        last: [...document.querySelectorAll('.sidebar > *')].every(each => each === document.querySelector('#sidebar-foot')
          || getComputedStyle(each).display === 'none' || each.getBoundingClientRect().right <= at.left) }; })()`),
    { line: true, shown: true, inBar: true, trailing: true, last: true });
    await click('#sidebar-you .ck-account__btn');
    await shot('account-row-narrow-open', `!${menu}.hidden`);
    assert.deepEqual(await chrome.evaluate(`(() => { const panel = ${menu}.getBoundingClientRect();
      const at = document.querySelector('#sidebar-you').getBoundingClientRect();
      return { under: panel.top >= at.bottom && panel.top - at.bottom < 8, trailing: Math.round(at.right - panel.right),
        inside: panel.top >= 0 && panel.left >= 0 && panel.right <= innerWidth && panel.bottom <= innerHeight }; })()`),
    { under: true, trailing: 0, inside: true });
    await chrome.size(920, 660, 1);
    await chrome.until(`!${menu}.hidden && (() => { const panel = ${menu}.getBoundingClientRect();
      const at = document.querySelector('#sidebar-you').getBoundingClientRect();
      return panel.bottom <= at.top && Math.round(panel.left - at.left) === 0 && panel.right <= innerWidth; })()`);
    assert.deepEqual(await opened(), { over: true, near: true, leading: 0, inside: true });
    await chrome.evaluate(`${row}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await chrome.until(`${menu}.hidden`);
    assert.deepEqual(await acts(), [], 'a narrow window took an act');
    await chrome.evaluate(`location.hash = '#view=people'`);
    await chrome.until(`location.hash === '#view=people' && ${row}`);
    await chrome.evaluate(`window.hostReplies.need = 'That no longer needs doing.'`);
    for (const key of ['Enter', 'ArrowDown', 'ArrowDown', 'Enter']) {
      await chrome.evaluate(`${row}.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true }))`);
    }
    await chrome.until(`window.hostActs.length === 1
    && document.querySelector('#sidebar-said:not([hidden]) .ck-in-place')?.textContent === 'That no longer needs doing.'`);
    assert.deepEqual(await acts(), [{ act: 'need', need: 'update:ready', button: 'do' }]);
    await click('#sidebar-line');
    await shot('recorder-dialog-over-people', `location.hash === '#view=people&dialog=screen'
    && document.querySelector('.ck-dialog .ck-dialog__title')?.textContent === 'Screen'
    && Boolean(document.querySelector('.main__section:not([hidden]) .pp-side'))`);
    await chrome.press('Escape');
    await chrome.until(`!document.querySelector('.ck-dialog') && location.hash === '#view=people'`);
    await setState(given);
    await chrome.until(`!document.querySelector('.ck-account__dot') && !document.querySelector('#ck-account-act')
    && !document.querySelector('#sidebar-line').hidden`);
    await setState({ ...given, recorder: null });
    await chrome.until(`document.querySelector('#sidebar-line').hidden && Boolean(${row})`);
    await chrome.size(1100, 720, 1);
    await load('#view=days', null);
    await chrome.until(`document.querySelector('.sidebar__item') && ${row}`);
    await click('#sidebar-you .ck-account__btn');
    await chrome.until(`!${menu}.hidden`);
    assert.deepEqual(await items(), [['Profile', '', ''], ['Settings', '', '']], 'a browser offered an update or a key');
    assert.equal(await chrome.evaluate(`Boolean(document.querySelector('.ck-account__dot'))`), false);
  });

  test('in a browser: nothing that needs this Mac offered', async () => {
    const away = `[...document.querySelectorAll('.ck-onb__body [data-ob]')].filter(each => each.matches('button')).map(each =>
      [each.dataset.ob, each.disabled, each.title])`;
    await load('#view=onboarding&seg=mac', null);
    await shot('mac-in-a-browser', `${on('mac')} && document.querySelector('[data-ob="allow-full"]')`);
    const mac = await chrome.evaluate(away);
    assert.ok(mac.some((/** @type {any[]} */ [key]) => key === 'allow-full'), 'Allow Full Disk Access shown');
    assert.deepEqual(mac.filter((/** @type {any[]} */ [, disabled, title]) => !disabled || title !== 'In the Lifestream app on your Mac.'),
      [], 'every Mac control held for the app');
    await load('#view=onboarding&seg=record', null);
    await shot('record-in-a-browser', `${on('record')} && document.querySelector('[data-ob^="allow-row:"]')`);
    assert.deepEqual(await chrome.evaluate(`[...document.querySelectorAll('[data-ob^="allow-row:"]')].filter(each => !each.disabled
      || each.title !== 'In the Lifestream app on your Mac.').length`), 0);
    assert.equal(await chrome.evaluate(shows('Screen Recording')), false, 'no permission named that only the app knows');
  });

  test('every verb and result the onboarding says fits the action control’s one width', async () => {
    await load('kit-gallery.html#group=Action', null);
    await chrome.until(`document.querySelectorAll('[data-fit]').length > 0`);
    const fits = await chrome.evaluate(`[...document.querySelectorAll('[data-fit]')].map(each => [each.dataset.fit,
    each.scrollWidth <= each.clientWidth, each.getBoundingClientRect().width])`);
    assert.equal(fits.length, 30, 'every verb and result');
    assert.deepEqual(fits.filter(([, fit]) => !fit).map(([words]) => words), [], 'a word wider than the action control');
    assert.equal(new Set(fits.map(([, , width]) => width)).size, 1, 'every word at the one width');
  });
});
