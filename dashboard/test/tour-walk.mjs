import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, BROWSER_WALK, chatting, heard, leftOn, MAC, MAC_WALK, NO_AI_WALK, offering, resting, tourPage, WINDOW }
  from './stand-ins/tour-page.mjs';
import { PAIR_QR } from './stand-ins/onboarding-home.mjs';
import { GET_APP } from '../public/ui/flows/model.js';

const page = tourPage({ file: 'tour-walk' });
/** @type {Awaited<ReturnType<typeof page.journey>>} */
let opened;
/** @type {Awaited<ReturnType<typeof page.journey>>['chrome']} */
let chrome;
/** @type {Awaited<ReturnType<typeof page.journey>>['front']} */
let front;

before(async () => {
  await page.open();
  opened = await page.journey('tour-walk');
  ({ chrome, front } = opened);
});

afterEach(() => {
  front?.reset();
  assert.deepEqual(chrome?.thrown.splice(0), []);
});

after(() => page.close());

const { holds, key, load, pressAt, pressOn, resize, snap, walkThrough } = page;
const NO_AI = { ...MAC, ask_login: undefined };
const PAIRABLE = { ...MAC, pairing: { link: 'lifestream://pair?code=ABCD2345', code: 'ABCD2345', qr: PAIR_QR, why: null, match: '4F7K',
  expires_ms: Date.now() + 3_600_000 }, phone_app: { link: 'https://testflight.example.com/join/AAAA0000', qr: PAIR_QR } };
const LEAST = { width: 900, height: 600 };

describe('tour-walk: the walk over the app', () => {
  test('W1 W2: the tour’s entry walks the Mac window’s six steps, Skip passing the first question, with motion and without; Done lands on Chat with Finish setting up', async () => {
    for (const still of [false, true]) {
      page.reduce(still);
      await load('#view=ask&tour=1', MAC);
      await chrome.until(offering(6));
      await walkThrough(MAC_WALK, { shots: still ? '' : 'mac' });
      await pressOn(act('lead'));
      await chrome.until(`${leftOn('ask')} && document.querySelector('.sidebar [data-finish]')`);
      assert.equal(await chrome.evaluate(`document.querySelector('[data-tour="ask"] textarea')?.value ?? ''`), '',
        'the offered question withdrawn');
    }
    page.reduce(false);
    assert.ok(front.asked.every(each => each.startsWith('GET /v1/ask')), `Ask asked ${front.asked}`);
  });

  test('W3: with no AI connected, Chat says what it does and the walk is five steps', async () => {
    front.signedIn(false);
    await load('#view=ask&tour=1', NO_AI);
    await chrome.until(chatting(5));
    await walkThrough(NO_AI_WALK, { shots: 'no-ai', ai: false });
    await pressOn(act('lead'));
    await chrome.until(leftOn('ask'));
  });

  test('W4: arrows pass the answer when nothing was asked, Esc and Skip tour leave where they are, the window’s Back', async () => {
    front.chatted(true);
    await load('#view=ask&tour=1', MAC);
    await chrome.until(offering(6));
    await key('ArrowRight');
    await chrome.until(resting(3, 6, true));
    await holds('more', 3, 6);
    await key('Tab');
    assert.equal(await chrome.evaluate(`Boolean(document.activeElement?.closest('.ck-spot__card'))`), false, 'Tab kept in the card');
    await chrome.evaluate(`document.querySelector(${JSON.stringify(act('lead'))}).focus()`);
    await key('ArrowLeft');
    await chrome.until(offering(6));
    await key('Escape');
    await chrome.until(leftOn('ask'));
    assert.equal(await chrome.evaluate(`document.querySelector('[data-tour="ask"] textarea').value`), '');
    await chrome.evaluate(`location.hash = '#view=agents&tour=5'`);
    await chrome.until(resting(5, 6, true));
    await pressOn(act('aside'));
    await chrome.until(leftOn('agents'));
    await chrome.evaluate(`location.hash = '#view=ask&tour=9'`);
    await chrome.until(`${offering(6)} && location.hash === '#view=ask&tour=1'`);
    await key('Escape');
    await chrome.until(leftOn('ask'));
    await chrome.evaluate(`location.hash = '#view=days'`);
    await chrome.until(`location.hash.startsWith('#view=days&on=') && document.querySelector('.dy')`);
    await chrome.evaluate(`location.hash = '#view=connectors&tour=3'`);
    await chrome.until(`${resting(3, 6, true)} && location.hash === '#view=connectors&seg=not&tour=3'`);
    await pressOn(act('lead'));
    await chrome.until(`${resting(4, 6, true)} && location.hash === '#view=connectors&tour=4'`);
    await chrome.evaluate('history.back()');
    await chrome.until(`location.hash.startsWith('#view=days&on=') && !location.hash.includes('tour=')
      && document.querySelector('.ck-spot--docked[data-still]') && ${heard(4, 6)}`);
    await chrome.evaluate('history.forward()');
    await chrome.until(resting(4, 6, true));
    await pressOn(act('aside'));
    await chrome.until(leftOn('connectors'));
  });

  test('W5: in a browser, five steps and no Agents; with no Mac to connect from, Devices rings nothing', async () => {
    await load('#view=ask&tour=1', null);
    await walkThrough(BROWSER_WALK, { shots: 'browser', unlit: ['devices', 'people'] });
    await pressOn(act('lead'));
    await chrome.until(leftOn('ask'));
  });

  test('W6: nothing dims the page: a press on it keeps the walk, the sidebar goes where it says and Next comes back; a lit device opens its flow, the walk stepping aside until it closes', async () => {
    await load('#view=connectors&tour=4', MAC);
    await chrome.until(resting(4, 6, true));
    await pressAt(1240, 700);
    await chrome.until(resting(4, 6, true));
    assert.equal(await chrome.evaluate('location.hash'), '#view=connectors&tour=4');
    await pressOn('.sidebar .sidebar__item[href="#view=people"]');
    await chrome.until(`location.hash.startsWith('#view=people') && !location.hash.includes('tour=')
      && document.querySelector('.ck-spot--docked[data-still]') && ${heard(4, 6)}`);
    await snap('away', `document.querySelector('.ck-spot--docked[data-still]')`);
    await pressOn(act('lead'));
    await chrome.until(`${resting(5, 6, true)} && location.hash === '#view=agents&tour=5'`);
    await key('ArrowLeft');
    await chrome.until(resting(4, 6, true));
    await pressOn('#main > .main__section:not([hidden]) [data-tour="devices"] [data-cn-flow="browser"]');
    const aside = `document.querySelector('#flow-layer .ck-dialog') && document.querySelector('.ck-spot[data-still]')
      && document.querySelector('.ck-spot__card:not(.ck-spot__card--twin)').hidden && !document.querySelector('.ck-spot__ring')`;
    await chrome.until(`location.hash.includes('flow=browser') && !location.hash.includes('tour=') && ${aside} && ${heard(4, 6)}`);
    await snap('pressed-chrome', aside);
    await chrome.evaluate('history.back()');
    await chrome.until(`${resting(4, 6, true)} && location.hash === '#view=connectors&tour=4' && !document.querySelector('#flow-layer .ck-dialog')`);
    await pressOn(act('aside'));
    await chrome.until(leftOn('connectors'));
  });

  test('W11: the devices step’s iPhone opens the pairing code in place, Get the app above it and the tour clear of it; paired, Done comes back to the step with Chrome alone ringed', async () => {
    await load('#view=connectors&tour=4', PAIRABLE);
    await chrome.until(resting(4, 6, true));
    await pressOn('#main > .main__section:not([hidden]) [data-tour="devices"] [data-cn-flow="phone"]');
    const code = `document.querySelector('#flow-layer .fl-guide img.ck-qr')?.alt === 'Pair your iPhone with this Mac'
      && /ABCD 2345/.test(document.querySelector('#flow-layer .fl-guide__typed')?.textContent ?? '')`;
    await chrome.until(`${code} && document.querySelector('.ck-spot[data-still]')
      && document.querySelector('.ck-spot__card:not(.ck-spot__card--twin)').hidden && !document.querySelector('.ck-spot__ring')`);
    const laid = await chrome.evaluate(`(() => { const get = document.querySelector('#flow-layer .fl-guide__get [data-flow="phone-app"]');
      const plate = document.querySelector('#flow-layer .fl-guide .ck-scan__plate').getBoundingClientRect();
      const box = get.getBoundingClientRect();
      return { get: get.textContent, above: box.bottom <= plate.top, hash: location.hash }; })()`);
    assert.deepEqual(laid, { get: GET_APP, above: true, hash: '#view=connectors&flow=phone' });
    front.paired('phone');
    await chrome.until(`/Paired/.test(document.querySelector('#flow-layer .ck-dialog')?.textContent ?? '')
      && !document.querySelector('#flow-layer .fl-guide') && document.querySelector('.ck-spot__card:not(.ck-spot__card--twin)').hidden`);
    await pressOn('#flow-layer [data-flow="done"]');
    await chrome.until(`${resting(4, 6, true)} && location.hash === '#view=connectors&tour=4' && !document.querySelector('#flow-layer .ck-dialog')`);
    const read = await page.now('devices');
    assert.deepEqual(read.devices, [false, false, true], 'the Mac, the paired iPhone, then Chrome still wanted');
    assert.ok(read.hook && read.hole && read.hole.every((each, at) => Math.abs(each - /** @type {number[]} */ (read.hook)[at]) <= 1),
      `the ring ${read.hole} is not Chrome’s row ${read.hook}`);
    assert.deepEqual(read.buttons, ['Skip tour', 'Next']);
    await key('Escape');
    await chrome.until(leftOn('connectors'));
  });

  test('W7: a resize, the Mac window’s least size at twice the device scale and the host’s inset follow the box; in a browser, a window too small centres the card', async () => {
    await load('#view=connectors&tour=4', MAC);
    await chrome.until(resting(4, 6, true));
    await holds('devices', 4, 6);
    try {
      await resize(1180, 760);
      await chrome.until(resting(4, 6, true));
      await holds('devices', 4, 6);
      await resize(LEAST.width, LEAST.height, 2);
      await chrome.until(resting(4, 6, true));
      await holds('devices', 4, 6);
      await snap('zoomed', resting(4, 6, true));
      await resize(WINDOW.width, WINDOW.height);
      await chrome.evaluate(`window.setHostState(${JSON.stringify({ ...MAC, inset: { left: 92, centre: 40 } })})`);
      await chrome.until(`${resting(4, 6, true)} && document.documentElement.style.getPropertyValue('--inset-centre') === '40px'`);
      await holds('devices', 4, 6);
    } finally {
      await chrome.size(WINDOW.width, WINDOW.height);
    }
    await chrome.until(resting(4, 6, true));
    await key('Escape');
    await chrome.until(leftOn('connectors'));
    await load('#view=connectors&tour=3', null);
    await chrome.until(resting(3, 5, true));
    try {
      await resize(360, 220);
      await chrome.until(resting(3, 5, false));
      await holds('more', 3, 5, { lit: false });
      await snap('too-small', resting(3, 5, false));
    } finally {
      await chrome.size(WINDOW.width, WINDOW.height);
    }
    await chrome.until(resting(3, 5, true));
    await key('Escape');
    await chrome.until(leftOn('connectors'));
  });

  test('W8: the last step rings nothing; its card sits in the corner', async () => {
    await load('#view=people&tour=6', MAC);
    await chrome.until(`${resting(6, 6, false)} && document.querySelector('.ck-spot--docked')`);
    await holds('people', 6, 6, { lit: false });
    await snap('people', resting(6, 6, false));
  });

  test('W10: the third step turns Connectors to Not connected and lights its pill; Next goes on to the devices', async () => {
    await load('#view=connectors&tour=3', MAC);
    await chrome.until(`${resting(3, 6, true)} && location.hash === '#view=connectors&seg=not&tour=3'`);
    await holds('more', 3, 6);
    await snap('more', resting(3, 6, true));
    await pressOn(act('lead'));
    await chrome.until(`${resting(4, 6, true)} && location.hash === '#view=connectors&tour=4'`);
    await holds('devices', 4, 6);
    await key('ArrowLeft');
    await chrome.until(`${resting(3, 6, true)} && location.hash === '#view=connectors&seg=not&tour=3'`);
    await key('Escape');
    await chrome.until(`${leftOn('connectors')} && location.hash.includes('seg=not')`);
  });

  test('W9: the onboarding drops a walk; a flow that asks first keeps it from starting', async () => {
    await load('#view=onboarding&tour=1', MAC);
    await chrome.until(`location.hash.startsWith('#view=onboarding') && !location.hash.includes('tour=')`);
    assert.equal(await chrome.evaluate(`document.querySelector('.ck-spot')`), null);
    const asking = { ...MAC, connect_requests: [{ id: 'req-1', browser: 'Arc' }] };
    const ASKS = `/Arc wants to connect/.test(document.querySelector('#flow-layer .ck-dialog')?.textContent ?? '')`;
    for (const hash of ['#view=ask&tour=1', '#view=days&flow=browser&tour=1']) {
      await load('#view=days&flow=browser', asking);
      await chrome.until(ASKS);
      await chrome.evaluate(`location.hash = ${JSON.stringify(hash)}`);
      await chrome.until(`!${ASKS} && location.hash.includes('flow=browser') && Boolean(document.querySelector('#flow-layer .ck-dialog'))`);
      assert.equal(await chrome.evaluate(`document.querySelector('.ck-spot')`), null, hash);
    }
    front.chatted(true);
    await load('#view=connectors&dialog=settings/home', MAC);
    await chrome.until(`document.querySelector('#dialog-layer .ck-dialog')`);
    await chrome.evaluate(`location.hash = '#view=ask&tour=1'`);
    await chrome.until(`${offering(6)} && !document.querySelector('#dialog-layer .ck-dialog')`);
    await key('Escape');
    await chrome.until(leftOn('ask'));
  });
});
