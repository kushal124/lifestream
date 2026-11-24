import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { on, onboardingPage, shows, state } from './stand-ins/onboarding-page.mjs';

const page = onboardingPage({ file: 'onboarding-journey' });
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

describe('onboarding-journey: from the app’s first window to a home, through the recovery key', () => {

  before(async () => {
    ({ front, chrome } = await page.journey('onboarding-journey'));
  });

  const { load, shot, click, text, acts, setState, primaries } = page;

  const KEY = 'MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIAA';
  const idle = { state: 'idle', error: null, waiting: null, key: null };
  const fresh = { folder: null, placement: null, unit: null, setup: idle };
  /** @param {'copied' | 'saved' | null} used @param {string | null} said @param {number} [made] */
  const waiting = (used, said, made = Date.UTC(2026, 10, 23)) => ({ state: 'key', error: null, waiting: null,
    key: { number: 1, made_ms: made, used, said } });
  const groups = `document.querySelectorAll('.ob-key__group').length`;
  const held = (/** @type {string} */ key) => `document.querySelector('[data-ob="${key}"]')?.disabled === true`;
  const free = (/** @type {string} */ key) => `document.querySelector('[data-ob="${key}"]')?.disabled === false`;

  test('Move to Applications: the host’s move, its failure in its own words', async () => {
    await load('#view=onboarding', state([], { ...fresh, placement: { moving: false, error: null } }));
    await shot('place', `${on('place')} && document.querySelector('.ob-place__app').complete`);
    assert.deepEqual(await text('.ck-onb__title'), ['Move Lifestream to Applications']);
    assert.equal(await primaries(), 1);
    await click('[data-ob="move-app"]');
    await chrome.until('window.hostActs.length === 1');
    assert.deepEqual(await acts(), [{ act: 'move-app' }]);
    await setState(state([], { ...fresh, placement: { moving: false, error: 'Lifestream couldn’t copy itself to Applications.' } }));
    await shot('place-failed', shows('Lifestream couldn’t copy itself to Applications.'));
    await setState(state([], fresh));
    await chrome.until(on('welcome'));
    assert.deepEqual(front.units, [], 'no home asked before setup');
  });

  test('Welcome, Where, then the key the host drafted: copied, ticked, saved; Login Items; the home made', async () => {
    await load('#view=onboarding', state([], fresh));
    await shot('welcome', on('welcome'));
    assert.deepEqual(await text('.ck-onb__hero'), ['Your life, kept on your Mac']);
    await click('[data-ob="onward"]');
    await shot('where', `${on('where')} && ${shows('Encrypted')}`);
    await click('[data-ob="setup"]');
    await chrome.until('window.hostActs.length === 1');
    assert.deepEqual(await acts(), [{ act: 'setup' }]);

    await chrome.evaluate(`window.hostAnswers['setup-key'] = { key: ${JSON.stringify(KEY)} }`);
    await setState(state([], { ...fresh, setup: waiting(null, null) }));
    await shot('key', `${on('key')} && ${groups} === 13`);
    assert.deepEqual(await acts(), [{ act: 'setup-key', do: 'show' }]);
    assert.equal(await chrome.evaluate(`[...document.querySelectorAll('.ob-key__group')].map(each => each.textContent).join(' ')`), KEY);
    assert.equal(await chrome.evaluate(held('key-done')), true, 'nothing copied or saved yet');
    assert.equal(await chrome.evaluate(`location.href.includes('MZXW') || JSON.stringify(sessionStorage).includes('MZXW')
      || JSON.stringify(localStorage).includes('MZXW')`), false, 'the key in the page’s memory only');

    await click('[data-ob="key-copy"]');
    await chrome.until('window.hostActs.length === 1');
    assert.deepEqual(await acts(), [{ act: 'setup-key', do: 'copy' }]);
    await setState(state([], { ...fresh, setup: waiting('copied', 'Copied. Paste it into your password manager within 90 seconds.') }));
    await chrome.until(shows('Copied. Paste it into your password manager within 90 seconds.'));
    assert.equal(await chrome.evaluate(held('key-done')), true, 'the tick still owed');
    await click('[data-ob="saved"]');
    await chrome.until(free('key-done'));
    await shot('key-ready', free('key-done'));
    await click('[data-ob="key-done"]');
    await chrome.until('window.hostActs.length === 1');
    assert.deepEqual(await acts(), [{ act: 'setup-key', do: 'saved' }]);

    await setState(state([], { ...fresh, setup: { state: 'working', error: null, waiting: null, key: null } }));
    await chrome.until(`${on('key')} && document.querySelector('[data-ob="key-done"]')?.getAttribute('aria-busy') === 'true'`);
    assert.equal(await chrome.evaluate(`[...document.querySelectorAll('.ob-key__group')].map(each => each.textContent).join(' ')`), KEY,
      'the grid kept while Creating');
    assert.equal(await chrome.evaluate(`document.querySelector('[data-ob="saved"]').getAttribute('aria-checked')`), 'true',
      'the tick kept while Creating');
    assert.equal(await chrome.evaluate(shows('Creating your Lifestream')), false, 'the grid swapped for a wait');
    await setState(state([], { ...fresh, setup: { state: 'login-items', error: null, waiting: null, key: null } }));
    await shot('login', on('login'));
    await click('[data-ob="login-items"]');
    await chrome.until('window.hostActs.length === 1');
    assert.deepEqual(await acts(), [{ act: 'open', what: 'login-items' }]);
  });

  test('a new key after a failed set up clears the tick, says it is new, and holds Continue until saved', async () => {
    const first = state([], { ...fresh, setup: waiting(null, null) });
    await load('#view=onboarding&seg=key', first);
    await chrome.until(on('key'));
    await chrome.evaluate(`window.hostAnswers['setup-key'] = { key: ${JSON.stringify(KEY)} }`);
    await setState(first);
    await chrome.until(`${groups} === 13`);
    await setState(state([], { ...fresh, setup: waiting('saved', 'Saved.') }));
    await click('[data-ob="saved"]');
    await chrome.until(free('key-done'));
    await click('[data-ob="key-done"]');
    await setState(state([], { ...fresh, setup: { state: 'working', error: null, waiting: null, key: null } }));
    const refused = { state: 'failed', error: 'The folder can’t be written.', waiting: null, key: null };
    await setState(state([], { ...fresh, setup: refused }));
    await chrome.until(`${on('where')} && ${shows('The folder can’t be written.')}`);
    await acts();
    await click('[data-ob="setup"]');
    await chrome.until('window.hostActs.length === 1');
    assert.deepEqual(await acts(), [{ act: 'setup' }]);
    await setState(state([], { ...fresh, setup: waiting(null, null, Date.UTC(2026, 10, 23, 1)) }));
    const renewed = shows('This is a new key. The one shown before no longer works.');
    await chrome.until(`${on('key')} && ${groups} === 13 && ${renewed}`);
    const ticked = `document.querySelector('[data-ob="saved"]').getAttribute('aria-checked')`;
    assert.equal(await chrome.evaluate(ticked), 'false', 'the tick was for the key before');
    await setState(state([], { ...fresh, setup: waiting('copied', 'Copied.', Date.UTC(2026, 10, 23, 1)) }));
    await chrome.until(shows('Copied.'));
    assert.equal(await chrome.evaluate(held('key-done')), true, 'the tick owed again for the new key');
  });

  test('a key the Mac resumes after the page opened on Welcome takes the page to the key, never Where held on Creating', async () => {
    await load('#view=onboarding', state([], fresh));
    await chrome.until(on('welcome'));
    await chrome.evaluate(`window.hostAnswers['setup-key'] = { key: ${JSON.stringify(KEY)} }`);
    await setState(state([], { ...fresh, setup: { state: 'working', error: null, waiting: null, key: null } }));
    await setState(state([], { ...fresh, setup: waiting(null, null) }));
    await chrome.until(`${on('key')} && ${groups} === 13`);
    assert.equal(await chrome.evaluate(on('where') + ' ? true : false'), false);
    assert.equal(await chrome.evaluate(shows('Creating')), false);
    assert.deepEqual(await acts(), [{ act: 'setup-key', do: 'show' }]);
  });

  test('a set up that fails after Login Items says why on the login screen, with Try again and Back', async () => {
    const failed = state([], { ...fresh,
      setup: { state: 'failed', error: 'Lifestream didn’t answer.', waiting: null, key: null } });
    await load('#view=onboarding', state([], { ...fresh,
      setup: { state: 'login-items', error: null, waiting: null, key: null } }));
    await chrome.until(on('login'));
    await setState(failed);
    await chrome.until(`${on('login')} && ${shows('Lifestream didn’t answer.')} && ${free('login-back')}`);
    await acts();
    await click('[data-ob="setup"]');
    await chrome.until('window.hostActs.length === 1');
    assert.deepEqual(await acts(), [{ act: 'setup' }]);
    await setState(failed);
    await click('[data-ob="login-back"]');
    await chrome.until(on('where'));
  });

  test('the key’s Back drops the drafted key and shows Where again', async () => {
    const drafted = state([], { ...fresh, setup: waiting(null, null) });
    await load('#view=onboarding&seg=key', drafted);
    await chrome.until(on('key'));
    await chrome.evaluate(`window.hostAnswers['setup-key'] = { key: ${JSON.stringify(KEY)} }`);
    await setState(drafted);
    await chrome.until(`${groups} === 13`);
    await acts();
    await click('[data-ob="key-back"]');
    await chrome.until('window.hostActs.length === 1');
    assert.deepEqual(await acts(), [{ act: 'setup-key', do: 'back' }]);
    await setState(state([], fresh));
    await chrome.until(on('where'));
    assert.equal(await chrome.evaluate(groups), 0);
  });
});
