import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { HILL, HILL_AT, LISTED, placesSuite, WATCH_POLICY } from './stand-ins/places-page.mjs';
import { hostScript } from './stand-ins/onboarding-home.mjs';
import { HOST_STATE } from '../public/kit-gallery-report.js';
import { until } from './until.mjs';

const suite = placesSuite({ file: 'places-instant', mutable: true });
const ANNEX = 'tile-annex-0b0b0b';
const { seen, shot, click, words, count, times, openPlace, statedSince, onCard, askedNoHostButLoopbackAndTiles } = suite;
/** @type {Awaited<ReturnType<typeof suite.journey>>['home']} */
let home;
/** @type {Awaited<ReturnType<typeof suite.journey>>['front']} */
let front;
/** @type {Awaited<ReturnType<typeof suite.journey>>['chrome']} */
let chrome;

before(async () => {
  await suite.open();
  ({ home, front, chrome } = await suite.journey('places-instant'));
  /** @param {string} name @param {{ latitude: number, longitude: number }} centre @param {object} more */
  const place = (name, centre, more) => ({ name, ...centre, radius_m: 80, ids: [], ...more });
  const spot1 = { latitude: 38.7189, longitude: -9.1466, radius_m: 80 };
  front.elsewhere({
    [HILL]: place('Hill Studio', HILL_AT, { also: [spot1], home: true }),
    'home-0a0a0a': place('Home', { latitude: 38.712, longitude: -9.129 }, { home: true }),
    [ANNEX]: place('Tile Annex', { latitude: 41.1495, longitude: -8.6108 }, { home: false }),
  });
});

after(() => suite.close());

test('a places event the door answers 304: the list kept as drawn, asked with its ETag, not drawn again', async () => {
  await chrome.load('#view=places', WATCH_POLICY);
  await chrome.until('document.querySelector(".pl-group") && !document.querySelector(".pl.ck-reading")');
  const hidden = Number(await chrome.evaluate('document.querySelector(".pl-card__foot [data-pl-open=hidden]")'
    + '?.getAttribute("aria-label")?.split(", ")[1] ?? 0'));
  await chrome.evaluate(`(() => {
    window.listDrawn = 0;
    new MutationObserver(() => { window.listDrawn += 1; }).observe(document.querySelector('[data-part=list]'), { childList: true });
  })()`);
  const lists = await chrome.evaluate(LISTED);
  const asks = times('page/places');
  const unchanged = front.unchanged;
  await chrome.following();
  front.tell();
  await chrome.until(`${LISTED} === ${lists + 1}`);
  assert.equal(front.unchanged, unchanged + 1);
  await click('[data-pl-cameras]');
  await chrome.until('document.querySelector(".ck-dialog .ck-toggle")');
  await click('.ck-dialog [data-pl-close]');
  await chrome.until('!document.querySelector(".ck-dialog")');
  assert.equal(await chrome.evaluate('window.listDrawn'), 0);
  front.hide({ latitude: 41.16, longitude: -8.62 });
  await chrome.until(`document.querySelector(".pl-card__foot [data-pl-open=hidden]")?.getAttribute("aria-label") === "Hidden, ${hidden + 1}"`);
  assert.equal(await chrome.evaluate('window.listDrawn'), 0);
  await chrome.evaluate('document.querySelector(".pl-group [data-pl-once]").click()');
  await chrome.until('document.querySelector(".pl-group .pl-once")');
  assert.equal(await chrome.evaluate('window.listDrawn'), 1);
  assert.equal(times('page/places'), asks + 2);
});

/** @param {() => void} tell */
async function readAgain(tell) {
  const lists = await chrome.evaluate(LISTED);
  await chrome.following();
  tell();
  await chrome.until(`${LISTED} > ${lists} && !document.querySelector(".pl.ck-reading")`);
}

const title = () => words('.pl-card__title');

const EDITING = '!!document.querySelector(".pl-card form[data-pl-form=edit] input[name=name]")';

/** @param {string} name */
async function rename(name) {
  if (!await chrome.evaluate(EDITING)) await click('[data-pl-edit]');
  await chrome.until(EDITING);
  await chrome.evaluate(`(() => {
    const input = document.querySelector('form[data-pl-form=edit] input[name=name]');
    input.value = ${JSON.stringify(name)};
    input.form.requestSubmit();
  })()`);
}

test('an edit drawn before the home answered it, a lost answer stated twice, a refusal shown as saved, or another device\'s edit '
  + 'left undrawn until the places event', async () => {
  await chrome.load('#view=places', WATCH_POLICY);
  await chrome.until('document.querySelector(".pl-group") && !document.querySelector(".pl.ck-reading")');
  await openPlace('fixture-corner-cafe');
  await chrome.evaluate(`(() => {
    window.names = [];
    const note = () => {
      const name = document.querySelector('.pl-card__title')?.textContent.trim();
      if (name && name !== window.names.at(-1)) window.names.push(name);
    };
    note();
    new MutationObserver(note).observe(document.body, { childList: true, subtree: true, characterData: true });
  })()`);
  const centre = { latitude: 38.7108, longitude: -9.1428 };
  const statedAs = (/** @type {string} */ name) => ({ 'fixture-corner-cafe': { name, ...centre, radius_m: 80, ids: [] } });
  const before = front.saved.length;
  const CLOSED = '!document.querySelector("form[data-pl-form=edit]")';

  front.stall();
  await rename('Corner Bakery');
  await chrome.until('document.querySelector("form[data-pl-form=edit] .pl-note")?.textContent === "Saving…"');
  await front.stated(before + 1);
  assert.equal(front.saved.length, before + 1);
  assert.deepEqual(await chrome.evaluate('window.names'), ['Corner Cafe'], 'the name drawn before the home answered');
  await front.unstall();
  await chrome.until(`${CLOSED} && document.querySelector(".pl-card__title")?.textContent === "Corner Bakery"`);
  assert.equal(await words('.pl-note'), 'Saved');

  front.lose();
  await rename('Corner Two');
  await chrome.until(`${CLOSED} && document.querySelector(".pl-card__title")?.textContent === "Corner Two"`);
  assert.equal(front.saved.length, before + 2, 'the lost answer stated the name again');

  front.hold();
  front.elsewhere(statedAs('Corner Three'));
  await chrome.until('document.querySelector(".pl-card__title")?.textContent === "Corner Three"');
  await readAgain(() => front.release());
  assert.equal(await title(), 'Corner Three');
  assert.deepEqual(await chrome.evaluate('window.names'), ['Corner Cafe', 'Corner Bakery', 'Corner Two', 'Corner Three']);
  seen.pages.flashes = await chrome.evaluate('window.names');

  const forbidden = front.saved.length;
  front.forbid();
  await rename('Corner Five');
  await chrome.until('document.querySelector("form[data-pl-form=edit] .ck-in-place")');
  assert.match(await words('form[data-pl-form=edit] .ck-in-place'), /turned off/u);
  assert.equal(await chrome.evaluate('document.querySelector("form[data-pl-form=edit] input[name=name]").value'), 'Corner Five');
  assert.equal(front.saved.length, forbidden);
  await click('.pl-edit__foot [data-pl-close]');
  await chrome.until(CLOSED);
  assert.equal(await title(), 'Corner Three');

  await click('[data-pl-edit]');
  await chrome.until(EDITING);
  front.unheard(statedAs('Corner Four'));
  const stale = front.saved.length;
  await rename('Corner Six');
  await chrome.until(`${CLOSED} && document.querySelector(".pl-card__title")?.textContent === "Corner Four"`);
  assert.equal(await words('.pl-note'), 'Not saved: this place changed elsewhere. Here it is now.');
  assert.equal(front.saved.length, stale, 'an edit from a stale read states nothing');
  assert.deepEqual(front.acts.at(-1).was, { name: 'Corner Three' }, 'the edit sends the name it was edited from');

  const annex = ANNEX;
  const removing = front.saved.length;
  await chrome.evaluate(`location.hash = "#view=places&focus=${annex}"`);
  await chrome.until('document.querySelector(".pl-page") && !document.querySelector(".pl.ck-reading")');
  await click('[data-pl-edit]');
  await click('[data-pl-remove]');
  await chrome.until('document.querySelector("[data-pl-keep]")');
  await click('[data-pl-remove]');
  await front.stated(removing + 1);
  assert.deepEqual(statedSince(removing), [{ kind: 'remove', key: annex }]);
  await chrome.evaluate('location.hash = "#view=places"');
  await chrome.until('document.querySelector(".pl-invite") && !document.querySelector(".pl.ck-reading")');

  const hiddenNow = () => chrome.evaluate('document.querySelector(".pl-card__foot [data-pl-open=hidden]")?.getAttribute("aria-label") ?? ""');
  const hiddenBefore = await hiddenNow();
  front.hold();
  const hiding = front.saved.length;
  await click('.pl-invite [data-pl-open="name"]');
  await onCard('1 of 1');
  await click('[data-pl-hide]');
  await front.stated(hiding + 1);
  const key = front.saved[hiding].key;
  assert.equal(front.saved[hiding].kind, 'hide');
  await chrome.evaluate('location.hash = "#view=places&focus=hidden"');
  await chrome.until(`document.querySelector('[data-pl-hidden="${key}"]')`);
  await click(`[data-pl-unhide="${key}"]`);
  await chrome.until(`!document.querySelector('[data-pl-hidden="${key}"]')`);
  await front.stated(hiding + 2);
  await chrome.evaluate('location.hash = "#view=places"');
  await chrome.until('document.querySelector(".pl-invite")');
  await readAgain(() => front.release());
  assert.ok(await chrome.evaluate('!!document.querySelector(".pl-invite")'));
  assert.equal(await hiddenNow(), hiddenBefore);
  assert.deepEqual(statedSince(hiding).map(entry => entry.kind), ['hide', 'unhide']);
});

test('the list before the home first counted it: every place named and its counts the skeleton, then the counts once counted', async () => {
  await readAgain(() => front.preparing(true));
  await chrome.load('#view=places', WATCH_POLICY);
  await chrome.until('document.querySelector(".pl-group .ck-lrow .ck-counting") && !document.querySelector(".pl.ck-reading")');
  assert.doesNotMatch(await words('.pl-card'), /being prepared/u);
  assert.equal(await chrome.evaluate('document.querySelectorAll(".pl-invite, [data-pl-retry]").length'), 0);
  front.preparing(false);
  await chrome.until('document.querySelector(".pl-group") && !document.querySelector(".pl-group .ck-counting")');
});

test('the list through the page\'s reach, nothing told: a not-now read again at its time, a hold once the home answers', async t => {
  const reachOf = (/** @type {string} */ state, /** @type {number} */ revision) => ({ ...HOST_STATE.reach, state, revision });
  const answering = { ...HOST_STATE, setup: { state: 'done', error: null, waiting: null }, reach: reachOf('answering', 7) };
  const probes = 'window.hostActs.filter(act => act.act === "home" && act.do === "probe").length';
  t.after(() => front.refuseList(null));
  await chrome.load('#view=places', WATCH_POLICY);
  await chrome.until('document.querySelector(".pl-group") && !document.querySelector(".pl.ck-reading")');
  await readAgain(() => front.refuseList('unheld'));
  await chrome.load('#view=places', WATCH_POLICY + hostScript(answering));
  await chrome.until('document.querySelector(".pl.ck-reading") && /Lifestream is busy/u.test(document.querySelector(".pl .ck-sk-wait")?.textContent ?? "")');
  assert.equal(await chrome.evaluate('document.querySelectorAll("[data-pl-retry]").length'), 0);
  assert.equal(await chrome.evaluate(probes), 0, 'a read\'s own not-now asks the Mac nothing of reach');
  const refused = await chrome.evaluate(LISTED);
  front.refuseList(null);
  await chrome.until(`document.querySelector(".pl-group") && !document.querySelector(".pl.ck-reading") && ${LISTED} > ${refused}`);
  await readAgain(() => front.refuseList('held'));
  await chrome.load('#view=places', WATCH_POLICY + hostScript(answering));
  await chrome.until(`document.querySelector(".pl.ck-reading") && ${probes} === 1`);
  await chrome.evaluate(`window.setHostState(${JSON.stringify({ ...answering, reach: { ...reachOf('held', 7), tone: 'warning', title: 'Lifestream is held' } })})`);
  await chrome.until('document.querySelector(".pl.ck-lacks") && getComputedStyle(document.querySelector(".pl .ck-lack--reach")).display === "flex"');
  assert.equal(await chrome.evaluate('document.querySelectorAll("[data-pl-retry]").length'), 0);
  const held = await chrome.evaluate(LISTED);
  front.refuseList(null);
  await chrome.evaluate(`window.setHostState(${JSON.stringify({ ...answering, reach: reachOf('answering', 8) })})`);
  await chrome.until(`document.querySelector(".pl-group") && !document.querySelector(".pl.ck-reading") && !document.querySelector(".pl.ck-lacks") && ${LISTED} === ${held + 1}`);
});

/** @param {string} said */
const editOn = said => chrome.until(`document.querySelector('[data-map="stage"]')?.dataset.circle === ${JSON.stringify(said)}`);

test('a place of two circles: Edit in the card holds both, a row each, any removable, Is this home? keeps them', async () => {
  const spot1 = { latitude: 38.7189, longitude: -9.1466 };
  const both = (/** @type {number} */ reach) => `38.716500,-9.141000,80;38.718900,-9.146600,${reach}`;
  await chrome.load('#view=places', WATCH_POLICY);
  await chrome.until('document.querySelector(".pl-group") && !document.querySelector(".pl.ck-reading")');
  await openPlace(HILL);
  await click('[data-pl-edit]');
  await chrome.until(EDITING);
  await editOn(both(80));
  assert.equal(await count('.ck-dialog'), 0);
  assert.equal(await count('.pl-edit [data-pl-circle]'), 2);
  assert.equal(await count('.pl-edit [data-pl-uncircle]'), 2);
  assert.equal(await count('[data-map="stage"] .ck-circle__move'), 2);
  await chrome.until(`document.querySelector('.pl-edit [data-ck-circle-line="1"]')?.textContent === ${JSON.stringify('Takes in 4\u00a0stays')}`);
  assert.equal(await words('.pl-edit [data-ck-circle-line="0"]'), 'Takes in 4 stays', 'every circle of a place says what the place takes in');
  await click('.pl-edit [data-pl-circle="1"] [data-pl-reach="1"]');
  await editOn(both(85));
  await shot('edit-circles', `document.querySelector('[data-map="stage"]')?.dataset.circle === ${JSON.stringify(both(85))}`);
  const before = front.saved.length;
  await click('.pl-edit__foot [type="submit"]');
  await front.stated(before + 1);
  await chrome.until('!document.querySelector("form[data-pl-form=edit]")');
  const sized = { ...spot1, radius_m: 85 };
  const hill = (/** @type {object[]} */ also) => ({ name: 'Hill Studio', ...HILL_AT, radius_m: 80, also, ids: [], home: true });
  assert.deepEqual(statedSince(before), [{ kind: 'edit', key: HILL, place: hill([sized]) }]);
  front.ask(HILL);
  await chrome.until('document.querySelector(".pl-page .pl-ask")');
  await click('[data-pl-home="true"]');
  await front.stated(before + 2);
  assert.deepEqual(statedSince(before)[1], { kind: 'edit', key: HILL, place: hill([sized]) });
  await chrome.until('!document.querySelector(".pl-ask")');
  await click('[data-pl-edit]');
  await editOn(both(85));
  await click('.pl-edit [data-pl-uncircle="1"]');
  await editOn('38.716500,-9.141000,80');
  assert.equal(await count('.pl-edit [data-pl-uncircle]'), 0);
  await click('.pl-edit__foot [type="submit"]');
  await front.stated(before + 3);
  await chrome.until('!document.querySelector("form[data-pl-form=edit]")');
  assert.deepEqual(statedSince(before)[2], { kind: 'edit', key: HILL, place: hill([]) });
  seen.pages.circles = statedSince(before).map(entry => entry.place);
});

/** @param {number} asks */
const settledReads = asks => front.asked.slice(asks).filter(each => each.startsWith(`/v1/page/place?slug=${HILL}&`)
  && new URL(each, 'http://door').searchParams.get('settled') === '1').length;

test('a place saved before Places counted it: read settled, asked again when the held read comes back still counting, drawn once counted, no places event', async () => {
  const counting = 'Boolean(document.querySelector(".pl-page .ck-counting"))';
  await chrome.load('#view=places', WATCH_POLICY);
  await chrome.until('document.querySelector(".pl-group") && !document.querySelector(".pl.ck-reading")');
  await openPlace(HILL);
  await chrome.until(`document.querySelector(".pl-page") && !document.querySelector(".pl.ck-reading") && !${counting}`);
  front.hold();
  const asks = front.asked.length;
  await click('[data-pl-edit]');
  await chrome.until(EDITING);
  await click('.pl-edit [data-pl-circle="0"] [data-pl-reach="1"]');
  await editOn('38.716500,-9.141000,85');
  const before = front.saved.length;
  await click('.pl-edit__foot [type="submit"]');
  await front.stated(before + 1);
  await until('the place read settled, held', () => front.heldSettled() > 0 && settledReads(asks) === 1 || undefined);
  await chrome.until(`!document.querySelector("form[data-pl-form=edit]") && ${counting}`);
  front.bound();
  await until('the place asked settled again', () => front.heldSettled() > 0 && settledReads(asks) === 2 || undefined);
  assert.equal(await chrome.evaluate(counting), true, 'a read still counting drawn as counted');
  front.countedUnheard();
  await chrome.until(`!${counting} && document.querySelector(".pl-page")`);
  assert.equal(front.heldSettled(), 0, 'no read held once counted');
  assert.deepEqual(statedSince(before).map(entry => entry.kind), ['edit']);
});

test('a place saved, then the page left while its settled read is held: the hold is freed and nothing asks again', async () => {
  const counting = 'Boolean(document.querySelector(".pl-page .ck-counting"))';
  await chrome.load('#view=places', WATCH_POLICY);
  await chrome.until('document.querySelector(".pl-group") && !document.querySelector(".pl.ck-reading")');
  await openPlace(HILL);
  await chrome.until(`document.querySelector(".pl-page") && !document.querySelector(".pl.ck-reading") && !${counting}`);
  front.hold();
  const asks = front.asked.length;
  await click('[data-pl-edit]');
  await chrome.until(EDITING);
  await click('.pl-edit [data-pl-circle="0"] [data-pl-reach="1"]');
  await editOn('38.716500,-9.141000,90');
  const before = front.saved.length;
  await click('.pl-edit__foot [type="submit"]');
  await front.stated(before + 1);
  await until('the place read settled, held', () => front.heldSettled() > 0 && settledReads(asks) === 1 || undefined);
  await chrome.evaluate('location.hash = "#view=days"; true');
  await until('every held read freed by the page that left', () => front.heldSettled() === 0 || undefined);
  assert.equal(settledReads(asks), 1, 'a read the page left is not asked again');
  front.release();
  await chrome.evaluate(`location.hash = "#view=places&focus=${HILL}"; true`);
  await chrome.until(`document.querySelector(".pl-page") && !${counting}`);
  assert.deepEqual(statedSince(before).map(entry => entry.kind), ['edit']);
});

const OWN = 'synthetic-make/own-camera';
const STRANGER = 'synthetic-make/stranger-camera';
/** @param {string} camera */
const switchOf = camera => `document.querySelector('.ck-dialog .ck-toggle[data-pl-camera="${camera}"]')`;
const OWN_SWITCH = switchOf(OWN);
/**
 * @param {string} camera
 * @param {boolean} on
 */
const settled = (camera, on) => `(toggle => toggle?.getAttribute('aria-checked') === '${on}' && toggle.getAttribute('aria-busy') !== 'true')(${switchOf(camera)})`;
/** @param {boolean} on */
const ownSettled = on => settled(OWN, on);

const WATCH = `(() => {
  const layer = document.querySelector('[data-part="dialog"]');
  const standing = layer.querySelector('.ck-dialog');
  window.cameraSeen = [];
  window.cameraWatch?.disconnect();
  window.cameraWatch = new MutationObserver(records => {
    const dialog = layer.querySelector('.ck-dialog');
    const toggle = dialog?.querySelector('.ck-toggle[data-pl-camera="${OWN}"]');
    const back = dialog?.querySelector('[data-pl-count][data-pl-camera="${OWN}"]');
    window.cameraSeen.push({ same: dialog === standing, on: toggle?.getAttribute('aria-checked') ?? null,
      busy: toggle?.getAttribute('aria-busy') === 'true',
      slid: records.some(each => each.target === toggle && each.attributeName === 'aria-checked' && each.oldValue === 'true'),
      back: back ? (back.getAttribute('aria-busy') === 'true' ? 'busy' : 'shown') : 'none',
      sample: (sample => sample ? (sample.tagName === 'IMG' ? 'picture' : 'tile') : null)(toggle?.closest('.pl-camera')?.querySelector('.ck-srow__lead > :is(img, .ck-srow__tile)')),
      part: toggle?.closest('.pl-cameras')?.querySelector('.ck-ssection__heading')?.textContent ?? null,
      page: Boolean(dialog?.querySelector('.pl-unmine')),
      scrolled: dialog?.classList.contains('is-scrolled') ?? false, top: dialog?.querySelector('.ck-dialog__body')?.scrollTop ?? 0 });
  });
  window.cameraWatch.observe(layer, { subtree: true, childList: true, attributes: true, attributeOldValue: true });
})()`;

const cameraParts = () => chrome.evaluate(`[...document.querySelectorAll('.ck-dialog .pl-cameras')].map(part => [
  part.querySelector('.ck-ssection__heading').textContent, ...[...part.querySelectorAll('.ck-toggle')].map(toggle => toggle.dataset.plCamera)])`);

/** @param {string} camera */
const lineOf = camera => chrome.evaluate(`${switchOf(camera)}.closest('.pl-camera').querySelector('.ck-srow__line').textContent`);

async function reopenCameras() {
  await click('.ck-dialog [data-pl-close]');
  await chrome.until('!document.querySelector(".ck-dialog")');
  await click('[data-pl-cameras]');
  await chrome.until(OWN_SWITCH);
}

/** @param {string} [camera] */
const doorWord = async (camera = OWN) => (await (await fetch(`${front.url}/v1/devices`, {
  headers: { authorization: `Bearer ${home.tokens.reader}` } })).json()).cameras.find((/** @type {any} */ each) => each.camera === camera).word;

const PAGE = 'document.querySelector(".ck-dialog .pl-unmine")';

/**
 * @param {{ busy: boolean, on: string | null }[]} frames
 * @param {string} was
 */
const heldUntilAnswered = (frames, was) => {
  const free = frames.findIndex(each => !each.busy);
  const turned = frames.findIndex(each => each.on !== was);
  return free > 0 && turned >= 0 && turned <= free
    && frames.every((each, at) => each.busy === at < free && (each.on === was) === at < turned);
};
const confirmOff = () => chrome.evaluate('document.querySelector(".ck-dialog [data-pl-unmine]").disabled');
/** @param {string} said */
const saying = said => `document.querySelector(".ck-dialog .pl-unmine__then")?.textContent === ${JSON.stringify(said)}`;
/** @param {string} value */
const picked = value => `document.querySelector('.ck-dialog [data-ck-choice="${value}"]')?.getAttribute('aria-checked') === 'true'`;

/** @param {string} camera */
async function askWhy(camera) {
  const word = await doorWord(camera);
  await click(`.ck-dialog [data-pl-ask-why][data-pl-camera="${camera}"]`);
  await chrome.until(PAGE);
  assert.equal(await confirmOff(), true);
  assert.deepEqual(await doorWord(camera), word);
}

/** @param {string} day */
const pickDay = day => chrome.evaluate(`(() => {
  const field = document.querySelector('.ck-dialog [data-pl-stopped]');
  field.value = ${JSON.stringify(day)};
  field.dispatchEvent(new Event('input', { bubbles: true }));
})()`);

/** @param {'Escape' | 'ArrowUp' | 'ArrowDown'} key */
async function press(key) {
  const code = { Escape: 27, ArrowUp: 38, ArrowDown: 40 }[key];
  for (const type of ['rawKeyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: code });
}

/** @param {string} done */
async function carried(done) {
  await chrome.until(`(${done}) || document.querySelector('.ck-dialog .pl-note')`);
  assert.equal(await count('.ck-dialog .pl-note'), 0, await chrome.evaluate('document.querySelector(".ck-dialog .pl-note")?.textContent'));
}

const CAMERA_LOG = `window.cameraLog = [];
const fetched = window.fetch;
window.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!/api\\/(?:life\\/device|owner\\/act)/u.test(url)) return fetched(input, init);
  // While the test says so, every read of the cameras fails as a home that does not answer fails it.
  if (window.failCameras && /api\\/life\\/devices/u.test(url)) {
    return new Response(JSON.stringify({ error: 'Lifestream did not answer.' }), { status: 503, headers: { 'content-type': 'application/json' } });
  }
  const at = Math.round(performance.now());
  try {
    const response = await fetched(input, init);
    const body = await response.clone().text();
    window.cameraLog.push({ at, url, sent: init?.body ? String(init.body).slice(0, 300) : undefined, status: response.status,
      body: body.slice(0, 800), done: Math.round(performance.now()) });
    return response;
  } catch (error) {
    window.cameraLog.push({ at, url, error: String(error) });
    throw error;
  }
};
const listen = EventSource.prototype.addEventListener;
EventSource.prototype.addEventListener = function (type, heard, options) {
  return listen.call(this, type, event => {
    window.cameraLog.push({ at: Math.round(performance.now()), feed: type, data: String(event.data ?? '').slice(0, 400) });
    heard(event);
  }, options);
};`;

const dayBounds = () => chrome.evaluate('(field => [field.min, field.max])(document.querySelector(".ck-dialog [data-pl-stopped]"))');

test('a camera\'s word: asked why on a page in the dialog, busy and drawn as the home holds it until the home answers, the row where it opened', async () => {
  await chrome.load('#view=places', WATCH_POLICY + CAMERA_LOG);
  try {
    await cameraWords();
  } finally {
    seen.pages.cameraLog = await chrome.evaluate('window.cameraLog');
  }
});

async function cameraWords() {
  await chrome.until('document.querySelector(".pl-group") && !document.querySelector(".pl.ck-reading")');
  await chrome.size(1440, 360);
  await click('[data-pl-cameras]');
  await chrome.until(ownSettled(true));
  assert.deepEqual(await cameraParts(), [['Yours', OWN], ['Not yours', STRANGER]]);
  await chrome.until('(body => body.scrollHeight > body.clientHeight + 8)(document.querySelector(".ck-dialog__body"))');
  assert.equal(await count('.ck-dialog.is-scrolled'), 0);
  await chrome.evaluate('document.querySelector(".ck-dialog__body").scrollTop = 6');
  await chrome.until('document.querySelector(".ck-dialog.is-scrolled")');
  await shot('cameras-scrolled', 'document.querySelector(".ck-dialog.is-scrolled")');
  await chrome.evaluate(WATCH);
  await askWhy(OWN);
  assert.equal(await words('.ck-dialog__title'), 'Remove Synthetic Make Own Camera?');
  assert.equal(await words('.ck-dialog__line'), '60 photos · 2019–2026');
  assert.equal(await chrome.evaluate('document.activeElement.dataset.ckChoice'), 'stopped');
  await click('.ck-dialog__foot [data-pl-why-back]');
  await chrome.until(`!${PAGE} && ${ownSettled(true)}`);
  assert.equal(await chrome.evaluate(`document.activeElement === ${OWN_SWITCH}`), true);
  await askWhy(OWN);
  await click('.ck-dialog [data-ck-choice="never"]');
  await chrome.until(saying('None of its 60 photos will count towards understanding your location.'));
  assert.equal(await confirmOff(), false);
  await chrome.evaluate('document.querySelector(\'.ck-dialog [data-ck-choice="never"]\').focus()');
  await press('ArrowUp');
  await chrome.until(`${picked('stopped')} && document.activeElement.dataset.ckChoice === 'stopped'`);
  await chrome.until(picked('last'));
  assert.equal(await confirmOff(), false);
  await press('ArrowDown');
  await chrome.until(`${picked('never')} && document.activeElement.dataset.ckChoice === 'never'`);
  assert.equal(await doorWord(), null);
  await click('.ck-dialog__foot [data-pl-unmine]');
  await carried(ownSettled(false));
  const neverWas = (await chrome.evaluate('window.cameraSeen')).filter((/** @type {any} */ each) => !each.page);
  assert.ok(neverWas.every((/** @type {any} */ each) => each.same && each.scrolled && each.top > 0), JSON.stringify(neverWas));
  const pressed = neverWas.findIndex((/** @type {any} */ each) => each.busy);
  assert.ok(pressed > 0 && heldUntilAnswered(neverWas.slice(pressed), 'true'),
    `a word drawn before the home held it, or busy past the read after its answer: ${JSON.stringify(neverWas)}`);
  assert.ok(neverWas.slice(pressed).every((/** @type {any} */ each) => each.on === 'true' || each.on === 'false'),
    JSON.stringify(neverWas));
  assert.deepEqual(await doorWord(), { mine: false });
  assert.match(await lineOf(OWN), /· Never yours · You said$/u);
  assert.ok(neverWas.every((/** @type {any} */ each) => each.part === 'Yours'), JSON.stringify(neverWas));
  assert.deepEqual(await cameraParts(), [['Yours', OWN], ['Not yours', STRANGER]]);
  await chrome.evaluate('document.querySelector(".ck-dialog__body").scrollTop = 0');
  await chrome.until('!document.querySelector(".ck-dialog.is-scrolled")');
  await chrome.size(1440, 900);
  await reopenCameras();
  assert.deepEqual(await cameraParts(), [['Not yours', OWN, STRANGER]]);
  await chrome.until(`${OWN_SWITCH}.closest('.pl-camera').querySelector('.ck-srow__lead > .ck-srow__tile')`);
  await chrome.evaluate(WATCH);
  await chrome.evaluate(`${OWN_SWITCH}.pressed = true`);
  await click(`.ck-dialog [data-pl-count][data-pl-camera="${OWN}"]`);
  await chrome.until(ownSettled(true));
  const watched = await chrome.evaluate('window.cameraSeen');
  const asked = watched.findIndex((/** @type {any} */ each) => each.busy);
  assert.ok(asked >= 0 && watched.slice(0, asked).every((/** @type {any} */ each) => each.on === 'false' && each.back === 'shown'),
    JSON.stringify(watched));
  const automatic = watched.slice(asked);
  assert.ok(automatic[0].busy && automatic[0].back === 'busy' && heldUntilAnswered(automatic, 'false'),
    `a word drawn before the home held it, or busy past the read after its answer: ${JSON.stringify(automatic)}`);
  assert.ok(automatic.every((/** @type {any} */ each) => each.same && each.part === 'Not yours'
    && (each.on === 'false' ? each.back === 'busy' : each.on === 'true' && each.back === 'none')),
  JSON.stringify(automatic));
  assert.ok(watched.every((/** @type {any} */ each) => each.sample === 'tile'), JSON.stringify(watched));
  assert.equal(await doorWord(), null);
  assert.equal(await chrome.evaluate(`${OWN_SWITCH}.pressed`), true);
  assert.match(await lineOf(OWN), /50 photos or more$/u);
  await askWhy(OWN);
  await press('Escape');
  await chrome.until(`!${PAGE} && ${ownSettled(true)} && document.querySelector(".ck-dialog")`);
  await askWhy(OWN);
  assert.equal(await count('.ck-dialog__back'), 0);
  await click('.ck-dialog [data-ck-choice="stopped"]');
  await chrome.until(`${picked('last')} && document.querySelector('.ck-dialog .pl-unmine__then')`);
  assert.match(await words('.ck-dialog .pl-unmine__then'), /^All 60 of its photos still count towards understanding your location\. Any it takes after \d+ \w{3} \d{4} won’t\.$/u);
  await click('.ck-dialog [data-ck-choice="day"]');
  await chrome.until('document.querySelector(".ck-dialog [data-pl-stopped]")');
  const [earliest, latest] = await dayBounds();
  assert.equal(earliest, '2019-05-01');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/u.test(latest) && latest <= new Date().toISOString().slice(0, 10), latest);
  assert.equal(await confirmOff(), true);
  await pickDay('2026-03-03');
  await chrome.until(saying('Photos before 3 Mar 2026 still count towards understanding your location. From 3 Mar 2026 on, they don’t.'));
  assert.equal(await confirmOff(), false);
  await click('.ck-dialog__foot [data-pl-unmine]');
  await carried(ownSettled(false));
  assert.equal(await chrome.evaluate('document.activeElement.dataset.plRow'), OWN);
  assert.deepEqual(await doorWord(), { mine: false, from: '2026-03-03' });
  assert.match(await lineOf(OWN), /· Not yours since 3 Mar 2026 · You said$/u);
  const sent = await chrome.evaluate('performance.now()');
  await chrome.evaluate('window.failCameras = true');
  await click(`.ck-dialog [data-pl-mine="true"][data-pl-camera="${STRANGER}"]`);
  await chrome.until(`document.querySelector('.ck-dialog .ck-in-place [data-pl-cameras-again]') && window.cameraLog.some(each =>
    each.feed === 'message' && each.at > ${sent} && each.data.includes('"kind":"import"'))`);
  assert.equal(await chrome.evaluate(`${switchOf(STRANGER)}.getAttribute('aria-busy')`), 'true');
  await chrome.evaluate('window.failCameras = false');
  await click('.ck-dialog [data-pl-cameras-again]');
  await carried(settled(STRANGER, true));
  assert.equal(await count('.ck-dialog .ck-in-place'), 0);
  assert.deepEqual(await doorWord(STRANGER), { mine: true });
  assert.match(await lineOf(STRANGER), /· Yours · You said$/u);
  await askWhy(STRANGER);
  assert.equal(await words('.ck-dialog__title'), 'Remove Synthetic Make Stranger Camera?');
  await click('.ck-dialog [data-ck-choice="never"]');
  await chrome.evaluate('document.querySelector(\'.ck-dialog [data-ck-choice="never"]\').focus()');
  await shot('camera-why-never', saying('None of its 3 photos will count towards understanding your location.'));
  await click('.ck-dialog [data-ck-choice="stopped"]');
  await click('.ck-dialog [data-ck-choice="day"]');
  await chrome.until('document.querySelector(".ck-dialog [data-pl-stopped]")');
  assert.equal((await dayBounds())[0], '2026-09-01');
  await pickDay('2026-09-10');
  await shot('camera-why-stopped', saying('All 3 of its photos still count towards understanding your location. Any it takes from 10 Sep 2026 on won’t.'));
  await click('.ck-dialog__foot [data-pl-unmine]');
  await carried(settled(STRANGER, false));
  assert.deepEqual(await doorWord(STRANGER), { mine: true, to: '2026-09-09' });
  assert.match(await lineOf(STRANGER), /· Yours until 9 Sep 2026 · You said$/u);
  await reopenCameras();
  assert.deepEqual(await cameraParts(), [['Not yours', OWN, STRANGER]]);
  await click('.ck-dialog [data-pl-close]');
  seen.pages.cameras = { neverWas, automatic, words: { own: await doorWord(), stranger: await doorWord(STRANGER) } };
}

test('the page asked no host but loopback and the tile host, and threw nothing', () => askedNoHostButLoopbackAndTiles());
