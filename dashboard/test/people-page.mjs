import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostState } from './stand-ins/onboarding-home.mjs';
import { FACES_NEED } from './stand-ins/people-home.mjs';
import { RECIPE } from './stand-ins/pictures.mjs';
import { A, carding, JSON_ANSWER, OWN, peoplePage, shows, WIDTHS } from './stand-ins/people-page.mjs';
import { barWords } from '../public/ui/kit/photo-viewer.js';
import { installClock } from '../public/lib/home-clock.js';

/** @param {any} photo */
const titleOf = photo => barWords(photo).title.text;

const page = peoplePage({ file: 'people-page' });
const NOTHING = JSON.parse(readFileSync(new URL('../../homelink/Tests/Fixtures/pages/person.nothing.json', import.meta.url), 'utf8'));
/** @type {Awaited<ReturnType<typeof page.open>>['front']} */
let front;
/** @type {Awaited<ReturnType<typeof page.open>>['chrome']} */
let chrome;
/** @type {Awaited<ReturnType<typeof page.open>>['url']} */
let url;
/** @type {Awaited<ReturnType<typeof page.open>>['dir']} */
let dir;

before(() => page.open());

after(() => page.close());

describe('people-faces: Faces opened from People, and its dialog', () => {

  before(async () => {
    ({ front, chrome } = await page.journey('people-faces'));
  });

  const { shot, click, text, acts, load } = page;

  test('P6: Faces opened from People, its dialog a connector like any other, each act read again once answered', async () => {
    front.faces({ state: 'never-asked', scanned: null, photos: null });
    await load('#view=connectors', hostState({ more: { setup: null } }));
    await chrome.until(`document.querySelector('[data-cn-open="settings/home"]')`);
    assert.equal(await chrome.evaluate(`Boolean(document.querySelector('[data-cn-open="faces"]'))`), false);
    await load('#view=people', hostState({ more: { setup: null } }));
    await chrome.until(`document.querySelector('.pp-side [data-people-connect="faces"]')`);
    await click('.pp-side [data-people-connect="faces"]');
    const toggle = '.ck-dialog [role="switch"]';
    const overPeople = `location.hash === '#view=people&dialog=faces' && !document.querySelector('.main__section:not([hidden]) [data-cn-q]')
      && Boolean(document.querySelector('.main__section:not([hidden]) .pp-side'))`;
    await chrome.until(`document.querySelector('.ck-dialog .ck-dialog__title')?.textContent === 'Faces' && ${overPeople}`);
    const install = `.ck-dialog .cn-connect [data-cn-label="Install"]`;
    await shot('faces-dialog-never-asked', `document.querySelector('${install}') && !document.querySelector('${toggle}') && ${overPeople}`);

    /**
     * @param {string} selector
     * @param {unknown} act
     * @param {import('./stand-ins/people-home.mjs').FacesIndex} next
     * @param {string} ready
     */
    const acted = async (selector, act, next, ready) => {
      front.faces(next);
      await click(selector);
      await chrome.until('window.hostActs.length === 1');
      assert.deepEqual(await acts(), [act]);
      await chrome.until(`${ready} && !document.querySelector('.ck-dialog [aria-busy="true"]')`);
    };
    await acted(install, { act: 'faces', do: 'on', label: 'Install' }, { state: 'installing', scanned: null, photos: null },
      shows('Getting the face models'));
    await shot('faces-dialog-installing', `${shows('Getting the face models')} && document.querySelector('${toggle}[aria-checked="true"]')`);
    front.faces({ state: 'waiting-for-power', scanned: 10, photos: 30 });
    front.poke();
    await chrome.until(shows('Scan now'));
    await shot('faces-dialog-waiting', shows('Waiting for power'));
    front.faces({ state: 'on', scanned: 30, photos: 30 });
    await click(`.ck-dialog [data-cn-do*='${FACES_NEED}']`);
    await chrome.until(`${shows('Up to date')} && !document.querySelector('.ck-dialog [aria-busy="true"]')`);
    assert.deepEqual(front.acted.map((/** @type {any} */ each) => [each.need, each.do]), [[FACES_NEED, 'try']]);
    assert.deepEqual(await acts(), []);
    await shot('faces-dialog-on', shows('Up to date'));
    await acted(toggle, { act: 'turn', sources: ['faces'], on: false }, { state: 'off', scanned: 0, photos: 30 },
      `document.querySelector('${toggle}[aria-checked="false"]')`);
    await shot('faces-dialog-off', `document.querySelector('${toggle}[aria-checked="false"]')`);
    await chrome.press('Escape');
    await chrome.until(`!document.querySelector('.ck-dialog') && location.hash === '#view=people'`);
    await load('#view=people', hostState({ more: { setup: null } }));
    await chrome.until(`document.querySelector('.ck-page__tools [data-people-connect="faces"]')`);
    await shot('people-faces-settings', `document.querySelector('.ck-page__tools [data-people-connect="faces"]')`);
    await click('.ck-page__tools [data-people-connect="faces"]');
    await chrome.until(`document.querySelector('.ck-dialog .ck-dialog__title')?.textContent === 'Faces' && ${overPeople}`);
    assert.deepEqual(chrome.thrown, []);
  });
});

describe('people-page: the list, Organise your people and the person page', () => {

  before(async () => {
    ({ front, chrome, url } = await page.journey('people-page'));
    installClock(await (await fetch(`${url}/api/clock`)).json());
  });

  const { shot, click, text, attr, go, stub, load, held, landed, landedPast, boxes, fill, enter, undoKey, stroke, facesOfGroup } = page;

  test('P1: the list, its views and what is left to tidy', async () => {
    front.faces({ state: 'never-asked', scanned: null, photos: null });
    await chrome.size(...WIDTHS[0]);
    await chrome.theme('dark');
    await load('#view=people', null);
    await chrome.until(`document.querySelector('[data-person="${A}"]') && document.querySelector('[data-person="organise"]')`);
    await chrome.until(`document.querySelector('[data-people-connect="faces"]')`);
    await shot('list', `document.querySelector('[data-people-connect="faces"]') && document.querySelector('.pp-side .ck-side__row')`);
    listColumns = await chrome.evaluate(COLUMNS);
    assert.ok(await chrome.evaluate(`Boolean(document.querySelector('[data-person="${A}"] .ck-mono--row'))`), 'Person A is led by their PersonFace');
    assert.deepEqual((await text('[data-people-seg]')).map(each => each.replace(/\d+/gu, '').trim()), ['People', 'Groups']);
    assert.deepEqual((await text('.pp-side .ck-side__name')).slice(0, 2), ['Organise your people', 'Turn on faces']);
    assert.equal((await text('.pp-side .ck-side__name')).includes('Faces'), false);
    assert.deepEqual(await text('[data-person="organise"] .ck-side__line'), ['1 organised · 1 more you talk to often']);
    const own = (await text(`[data-person="${OWN}"]`)).join(' ');
    assert.equal(own.split(OWN.slice('phone:'.length)).length - 1, 1, own);
    await click('[data-people-connect="faces"]');
    await shot('turn-on-faces-browser', `location.hash.includes('view=people') && location.hash.includes('dialog=faces')
      && document.querySelector('.ck-dialog .ck-dialog__title')?.textContent === 'Faces'`);
    assert.equal(await chrome.evaluate(`document.querySelectorAll('.ck-dialog [role="switch"]').length`), 0);
    assert.equal(await chrome.evaluate(`Boolean(document.querySelector('.ck-page__tools [data-people-connect]'))`), false);
    front.faces({ state: 'on', scanned: 30, photos: 30 });
    await load('#view=people', null);
    await chrome.until(`document.querySelector('.pp-side [data-person="faces"] .ck-side__name')?.textContent === 'Faces'`);
    assert.equal(await chrome.evaluate(`Boolean(document.querySelector('.pp-side [data-people-connect="faces"]'))`), false);
    await chrome.until(`document.querySelector('.ck-page__tools [data-people-connect="faces"]')?.getAttribute('aria-label') === 'Faces settings'`);
  });

  test('P1: a home with no one yet still shows what is left to tidy, and a word typed finds no one the answer lacks', async () => {
    front.faces({ state: 'never-asked', scanned: null, photos: null });
    await load('#view=days', null);
    const nobody = { ...JSON.parse(readFileSync(new URL('../../homelink/Tests/Fixtures/pages/people.nothing.json', import.meta.url), 'utf8')),
      sections: [] };
    await stub(`(url, init, real) => url.split('?')[0] === 'api/page/people' ? (${JSON_ANSWER})(${JSON.stringify(nobody)}) : real(url, init)`);
    await go('#view=people');
    await chrome.until(`document.querySelector('.ck-offers') && document.querySelector('[data-people-connect="faces"]')`);
    await shot('list-no-one-yet', `document.querySelector('.ck-offers') && document.querySelector('[data-people-connect="faces"]')`);
    await chrome.type('[data-people-find]', 'Person');
    await chrome.until(shows('No one called “Person”.'));
    assert.equal(await chrome.evaluate(`Boolean(document.querySelector('.pp-main [data-person]'))`), false);
  });

  const eyebrow = () => chrome.evaluate(`document.querySelector('.pp-window__head .ck-section__label')?.textContent ?? ''`);
  const COLUMNS = `['.ck-page__main', '.ck-page__side'].map(part => { const box = document.querySelector('.main__section:not([hidden]) ' + part).getBoundingClientRect(); return [box.left, box.right]; })`;
  /** @type {number[][]} */
  let listColumns;
  const frameOf = () => chrome.evaluate(`JSON.stringify([document.querySelector('.pp-panel').getBoundingClientRect().height, document.querySelector('.pp-panel__body').getBoundingClientRect().top])`);

  test('P2: Organise your people, the panel and its window', async () => {
    front.faces({ state: 'on', scanned: 30, photos: 30 });
    const before = landed();
    await load('#view=people', null);
    await chrome.until(`document.querySelector('[data-person="organise"]')`);
    const listed = await (await fetch(`${url}/api/page/people`)).json();
    assert.deepEqual(listed.organise.queue, [A], 'Organise walks the home\'s queue');
    assert.equal(listed.you?.id, OWN);
    await chrome.evaluate('window.photosAsked = []; true');
    await stub(`(url, init, real) => {
    if (url.startsWith('api/life/people/photos?')) window.photosAsked.push(new URLSearchParams(url.split('?')[1]).get('id'));
    return real(url, init);
  }`);
    await click('[data-person="organise"]');
    await chrome.until(`${carding('Person A')} && document.querySelector('[data-o-do="notperson"]')`);
    await chrome.until(`window.photosAsked.includes(${JSON.stringify(A)})`);
    assert.deepEqual(await text('.pl-naming__title'), ['Organise your people']);
    assert.match((await text('.pl-naming__count')).join(''), /^1 of \d+$/u);
    assert.equal(await chrome.evaluate(`document.querySelector('.pl-naming__progress > i').getBoundingClientRect().width`), 0);
    assert.match(String((await attr('.pl-naming__progress', 'aria-label'))[0]), /^1 organised · /u, 'the progress in organiseLine’s words');
    assert.equal(await chrome.evaluate(`document.querySelector('.pp > .ck-page__bar').hidden && document.querySelector('.pp > .ck-under').hidden`), true);
    await shot('organise', carding('Person A'));
    await chrome.size(...WIDTHS[1]);
    assert.equal(await chrome.evaluate(`[...document.querySelectorAll('.pp-panel .ck-btn__key')].every(key => getComputedStyle(key).display === 'none')`), true);
    await chrome.size(...WIDTHS[0]);
    assert.notEqual(await chrome.evaluate(`getComputedStyle(document.querySelector('.pp-panel .ck-btn__key')).display`), 'none');

    assert.equal(await eyebrow(), '');
    await chrome.hover('[data-row="f:full"]');
    assert.equal(await eyebrow(), '', 'hover is no choice');
    await click('[data-o-field="name"]');
    await chrome.until(`document.querySelector('.pp-window__head .ck-section__label')?.textContent === 'Name'`);
    await stroke('ArrowDown');
    await chrome.until(`document.querySelector('.pp-window__head .ck-section__label')?.textContent === 'Full name' && document.activeElement?.dataset.oField === 'full'`);
    await stroke('Escape');
    await chrome.until(`!document.querySelector('.pp-window__head .ck-section__label') && !document.activeElement?.matches('input')`);

    const opened = await chrome.evaluate(`document.querySelector('[data-o-field="name"]').value`);
    const still = await boxes();
    await chrome.evaluate(`document.querySelector('[data-o-field="name"]').focus()`);
    await chrome.until(`document.querySelector('.pp-window__head .ck-section__label')?.textContent === 'Name'`);
    await chrome.evaluate(`window.windowShown = document.querySelector('.pp-window__in'); true`);
    await fill('[data-o-field="name"]', 'Me');
    await chrome.until(`document.querySelector('.pp-hero__name')?.textContent === 'Me'`);
    assert.equal(await boxes(), still, 'typing a name moves nothing');
    assert.deepEqual(await chrome.evaluate(`[window.windowShown.isConnected, document.querySelector('.pp-window__title').textContent]`), [true, 'Me'],
      'the window keeps its parts, its title following the name');
    await chrome.evaluate(`document.querySelector('[data-o-add]').focus()`);
    await chrome.until(`document.activeElement?.dataset.oAdd !== undefined && document.querySelector('[data-row="add"]').matches(':focus-within')`);
    const lit = await boxes();
    await fill('[data-o-add]', 'Person');
    await chrome.until(`document.querySelector('.pp-pop [data-o-find]')`);
    assert.equal(await boxes(), lit, 'the finds float');
    assert.equal(await chrome.evaluate(`document.querySelectorAll('.pp-pop .ck-flist__item.is-lit').length`), 1, 'one light');
    await shot('organise-finds', `document.querySelector('.pp-pop [data-o-find]')`);
    await stroke('Escape');
    await chrome.until(`!document.querySelector('.pp-pop') && document.querySelector('[data-o-add]').value === ''`);
    const address = 'person-x@example.com';
    await chrome.evaluate('window.building = true; true');
    await stub(`(url, init, real) => {
    const asked = new URLSearchParams(url.split('?')[1] ?? '');
    if (url.startsWith('api/page/peopleFind?') && asked.get('q') === 'person-x') return (${JSON_ANSWER})({ position: '1:1', today: '2026-01-01',
      rows: [{ id: 'email:${address}', name: '${address}', named: false, face: false, photo: null, when: null, line: null, find: ['${address}'] }], profiles: [] });
    if (url.startsWith('api/page/person?') && asked.get('id') === 'email:${address}') {
      const page = ${JSON.stringify(NOTHING)};
      return (${JSON_ANSWER})({ ...page, head: { ...page.head, name: '${address}' },
        edit: { ...page.edit, mails: { from: 0, to: 0, newest: window.building ? null : [] } } });
    }
    return real(url, init);
  }`);
    await fill('[data-o-add]', 'person-x');
    await chrome.until(shows('Your mails are being read.'));
    await chrome.evaluate('window.building = false; true');
    await stroke('ArrowDown');
    await chrome.until(shows('No mail of theirs in Lifestream'));
    await stroke('Escape');
    await chrome.until(`!document.querySelector('.pp-pop') && document.querySelector('[data-o-add]').value === ''`);
    await fill('[data-o-field="name"]', opened);
    await chrome.until(`document.querySelector('.pp-panel [data-row^="g:"]')`);
    assert.deepEqual(await attr('.pp-panel [data-row^="g:"]', 'aria-checked'), ['false']);
    await chrome.evaluate(`document.querySelector('[data-o-do="notperson"]').focus()`);
    await enter();
    await chrome.until(`document.querySelector('.pp-pop [data-o-kind]')`);
    assert.equal(await chrome.evaluate(`Boolean(${carding('Person A')})`), true, '⏎ on the pill confirms nothing');
    await stroke('Escape');
    await chrome.until(`!document.querySelector('.pp-pop')`);
    const theirs = await boxes();
    await click('[data-o-do="notperson"]');
    await chrome.until(`document.querySelector('.pp-pop [data-o-kind]')`);
    assert.equal(await boxes(), theirs, 'the menu floats');
    await chrome.hover('.pp-pop [data-o-menu-at="1"]');
    await chrome.until(`document.querySelector('.pp-pop [data-o-menu-at="1"]')?.classList.contains('is-lit')`);
    await stroke('ArrowUp');
    await chrome.until(`document.querySelector('.pp-pop [data-o-menu-at="0"]')?.classList.contains('is-lit')`);
    assert.equal(await chrome.evaluate(`document.querySelectorAll('.pp-pop .is-lit').length`), 1, 'one light');
    await shot('organise-menu', `document.querySelector('.pp-pop [data-o-kind]')`);
    await enter();
    await chrome.until(`document.activeElement?.dataset.oUnsay !== undefined`);
    await enter();
    await chrome.until(`document.activeElement?.dataset.oDo === 'notperson' && !document.querySelector('[data-o-unsay]')`);
    assert.equal(await chrome.evaluate(`Boolean(${carding('Person A')})`), true, '⏎ on what was said confirms nothing');

    await click('[data-o-do="photo"]');
    await chrome.until(`document.querySelector('.pp-window .ck-fcrop--upload') && !document.querySelector('.pp-window .ck-fcrop--reading')`);
    await stub(`(url, init, real) => url === 'api/owner/act' && JSON.parse(init.body).kind === 'photo'
    ? new Promise(done => { window.refusePhoto = done; }).then(() => (${JSON_ANSWER})({ error: 'Lifestream could not take it.' }, 503))
    : real(url, init)`);
    await chrome.evaluate(`(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 400;
    canvas.getContext('2d').fillRect(0, 0, 400, 400);
    const blob = await new Promise(done => canvas.toBlob(done, 'image/jpeg', 0.9));
    const data = new DataTransfer();
    data.items.add(new File([blob], 'pasted.jpg', { type: 'image/jpeg' }));
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    return true;
  })()`);
    await chrome.until(`document.querySelector('.ck-mas:not(.is-refused)') && document.activeElement?.matches('.ck-mas__stage')`);
    await click('[data-ck-mas="use"]');
    await chrome.until(`document.querySelector('.pp-foot__said span')?.textContent === 'Photo saved' && Boolean(window.refusePhoto)`);
    await click('.pp-window [data-o-do="back"]');
    await chrome.until(`!document.querySelector('.pp-window .ck-fcrop--upload')`);
    await chrome.evaluate('window.refusePhoto(); true');
    await chrome.until(`document.querySelector('.pp-foot__said .ck-in-place')?.textContent.startsWith('Not sent')
      && document.querySelector('.pp-foot__said [data-o-do="resend"]')?.textContent.trim() === 'Try again' && ${carding('Person A')}`);
    await chrome.evaluate('window.fetch = window.realFetch; true');

    await chrome.evaluate(`document.querySelector('.pp-panel__body').focus()`);
    await stroke('ArrowRight');
    await shot('organise-all-skipped', `document.querySelector('[data-o-do="again"]')`);
    assert.ok((await text('.pl-finish')).join(' ').includes('0 people organised'));
    await click('[data-o-do="again"]');
    await chrome.until(`${carding('Person A')} && document.querySelector('.pp-panel [data-row^="g:"]')`);
    await click('.pp-panel [data-row^="g:"] .ck-namerow__end');
    await chrome.until(`document.querySelector('.pp-panel [data-row^="g:"]').getAttribute('aria-checked') === 'true'`);
    assert.equal(await chrome.evaluate(`Boolean(document.querySelector('[data-row="faces"]'))`), false, 'a face theirs: no Mark their face');
    await shot('organise-person', carding('Person A'));
    const group = String((await attr('.pp-panel [data-row^="g:"]', 'data-row'))[0]).slice('g:'.length);
    const every = await facesOfGroup(group);
    await stroke('Escape');
    await chrome.until(`!document.querySelector('.pp-window__head .ck-section__label')`);
    await stub(`(url, init, real) => {
    if (url !== 'api/owner/act') return real(url, init);
    const { request, ...action } = JSON.parse(init.body);
    (window.confirms ??= []).push(action);
    return window.confirms.length === 1 ? (${JSON_ANSWER})({ error: 'Can’t reach Lifestream.', code: 'GONE' }, 503) : real(url, init);
  }`);
    await chrome.press('Enter');
    await chrome.until(`document.querySelector('.pp-foot__said .ck-in-place')?.textContent.startsWith('Not sent')
      && document.querySelector('.pp-foot__said [data-o-do="resend"]') && ${carding('Person A')}`);
    await click('.pp-panel [data-row^="g:"] .ck-namerow__end');
    await chrome.until(`document.querySelector('.pp-panel [data-row^="g:"]').getAttribute('aria-checked') === 'false'`);
    await click('.pp-foot__said [data-o-do="resend"]');
    await chrome.until('window.confirms?.length === 2');
    const [failed, resent] = /** @type {unknown[]} */ (await chrome.evaluate('window.confirms'));
    assert.deepEqual(resent, failed, 'Try again sent another answer');
    await chrome.evaluate('window.fetch = window.realFetch; true');
    await chrome.until(`document.querySelector('.pl-finish')`);
    await undoKey();
    await chrome.until(`${carding('Person A')} && document.querySelector('.pp-foot__said')?.textContent === 'Back to Person A'`);
    assert.deepEqual(await attr('.pp-panel [data-row^="g:"]', 'aria-checked'), ['true']);
    assert.equal(await chrome.evaluate(`Boolean(document.querySelector('[data-o-do="undo"]'))`), false, 'Undo is one answer deep');
    await undoKey();
    await chrome.until(`document.querySelector('.pp-foot__said')?.textContent === 'Back to Person A'`);
    assert.equal(await chrome.evaluate(`Boolean(${carding('Person A')})`), true, 'a second ⌘Z takes back nothing');
    assert.equal(await chrome.evaluate(`Boolean(document.querySelector('.pp-window__head .ck-section__label'))`), false, 'a row lit on the card brought back');
    await chrome.press('Enter');
    await shot('organise-done', `document.querySelector('.pl-finish') && ${shows('1 person organised')}`);
    await chrome.press('Enter');
    await chrome.until(`!location.hash.includes('focus=') && document.querySelector('.pp-main') && !document.querySelector('.pp-panel')`);
    await landedPast(before + 2);
    const { persons, faces } = await held();
    const a = persons.get('person-a');
    assert.deepEqual([a.anchor, a.name, a.me, a.hidden], [{ kind: 'phone', value: '+15550000001' }, null, false, false]);
    const named = [...faces.values()];
    assert.ok(named.length > 0 && named.every(face => face.is === 'person-a'), JSON.stringify(named));
    assert.deepEqual(new Set(every), new Set(faces.keys()), 'every face of the group ticked, and no other');
    await chrome.until(`document.querySelector('.pp-main [data-person="person:person-a"] img')`);
    await chrome.until(`document.querySelector('.pp-side') && !document.querySelector('[data-person="organise"]')`);
    const rowA = '.pp-main [data-person="person:person-a"]';
    await chrome.evaluate(`window.rowShown = document.querySelector('${rowA}'); window.faceShown = window.rowShown.querySelector('img'); true`);
    await click('[data-people-seg=""]');
    assert.deepEqual(await chrome.evaluate(`[document.querySelector('${rowA}') !== window.rowShown,
    document.querySelector('${rowA} img') === window.faceShown]`), [true, true], 'the row drawn anew, its photo the one shown');

  });

  test('P3: the person page: their photos whole, Last talked and Together, nothing of Maybe faces', async () => {
    await load('#view=people&focus=person:person-a', null);
    await chrome.until(`document.querySelector('[data-people-edit="open"]') && document.querySelector('[data-people-photo]')`);
    await shot('person', `[...document.querySelectorAll('[data-people-photo] img')].every(each => each.complete && each.naturalWidth > 0)`);
    const served = await (await fetch(`${url}/api/life/people/photos?id=person%3Aperson-a`)).json();
    assert.equal('maybe' in served, false, 'the photos read holds no Maybe faces');
    assert.equal(served.total, served.photos.length);
    assert.deepEqual(await attr('[data-people-photo] img', 'data-src'),
      served.photos.slice(0, 12).map((/** @type {any} */ each) => `/api/life/picture?${new URLSearchParams({ hash: `sha256:${each.image}`,
        size: 'tile', recipe: String(RECIPE) })}`));
    const sources = /** @type {string[]} */ (await chrome.evaluate(`[...document.querySelectorAll('.pp img:not(.pp-head img)')].map(img => img.getAttribute('data-src'))`));
    assert.ok(sources.length >= Math.min(12, served.photos.length) && sources.every(src => src.startsWith('/api/life/picture?') && src.endsWith(`&size=tile&recipe=${RECIPE}`)), sources.join(' '));
    assert.ok((/** @type {string[]} */ (await attr('.pp-head img', 'data-src'))).every(src => src.startsWith('/api/life/picture?') && src.endsWith(`&size=screen&recipe=${RECIPE}`)));
    assert.equal(await chrome.evaluate(`document.querySelectorAll('.pp img:not(.ck-pic)').length`), 0);
    assert.ok(front.pictures.some(ask => ask.endsWith(`?size=tile&recipe=${RECIPE}`)), 'the home was never asked for a picture');
    assert.equal((await fetch(`${url}/api/life/media?hash=${encodeURIComponent(`sha256:${served.photos[0].image}`)}`)).status, 404);
    assert.ok(served.photos.every((/** @type {any} */ each) => `sha256:${each.image}` !== each.crop));
    assert.equal(await chrome.evaluate(`Boolean(document.querySelector('[data-people-maybe]'))`), false);
    assert.equal((await text('.ck-page__body .ck-btn')).some(words => /^(Add|Not)\b/u.test(words)), false);
    assert.equal(await chrome.evaluate(`/\\bfaces?\\b/iu.test(document.querySelector('.ck-page__body').innerText)`), false, 'a faces word on the person page');
    assert.deepEqual(await text('.pp-talk .ck-section__label'), ['Last talked']);
    assert.match((await text('.pp-talk__when'))[0], / · WhatsApp$/u);
    assert.ok((await text('.pp-talk .ck-section .ck-btn')).includes('Open conversation'));
    assert.ok(await chrome.evaluate(`document.querySelectorAll('.pp-talk .ck-bubble').length`) > 0);
    assert.deepEqual(await chrome.evaluate(COLUMNS), listColumns, 'a person stands in the list\'s frame');
    assert.equal(await chrome.evaluate(`document.querySelectorAll('.pp-side .pp-fact').length`), 0);
    const scale = await chrome.evaluate(`document.querySelector('.pp-figure')?.dataset.scale`);
    if (scale === 'weeks') assert.match((await text('.pp-figure .ck-week__last'))[0], /^Since [A-Z][a-z]{2} \d{4}$/u);
    else if (scale === 'none') assert.deepEqual((await text('.pp-figure .pp-fact > :first-child')).slice(0, 2), ['Messages', 'First contact']);
    else assert.match((await text('.pp-figure .ck-week__unit'))[0], / since [A-Z][a-z]{2} \d{4}$/u);
    assert.equal(await chrome.evaluate(shows('Messages · 30 days')), false);
    await chrome.size(...WIDTHS[1]);
    const weeks = JSON.parse(await chrome.evaluate(`(async () => {
    const { rhythm } = await import('/ui/people/person.js');
    const { applyGeometry } = await import('/ui/geometry.js');
    const today = '2026-11-16';
    const monday = Date.parse('2026-11-16T00:00:00Z');
    const history = { kind: 'weeks', marked: null, weeks: Array.from({ length: 104 }, (_, at) => ({
      start: new Date(monday - (103 - at) * 7 * 86400000).toISOString().slice(0, 10), count: 1 + (at % 5), day: null })) };
    const month = { days: [], count: 12, calls: null, line: '12 messages in the last 30 days', before: null };
    const figure = document.querySelector('.pp-figure');
    figure.insertAdjacentHTML('afterend', rhythm({ head: { name: 'Person A', since: null }, month, history }, today));
    const drawn = figure.nextElementSibling;
    figure.remove();
    applyGeometry(drawn);
    const box = drawn.querySelector('.ck-week__days').getBoundingClientRect();
    const bars = [...drawn.querySelectorAll('.ck-week__day i')].map(each => each.getBoundingClientRect());
    return JSON.stringify({ scale: drawn.dataset.scale, count: bars.length, page: document.documentElement.scrollWidth,
      inside: bars.every(bar => bar.left >= box.left - 0.5 && bar.right <= box.right + 0.5 && bar.width >= 1),
      apart: bars.every((bar, at) => at === 0 || bar.left > bars[at - 1].right) });
  })()`));
    assert.deepEqual(weeks, { scale: 'weeks', count: 104, page: WIDTHS[1][0], inside: true, apart: true });
    await chrome.size(...WIDTHS[0]);
    assert.equal(await chrome.evaluate(`Boolean(document.querySelector('.pp-side .ck-fgrid, .pp-side [data-people-accept]'))`), false);
    assert.ok(await chrome.evaluate(`document.querySelectorAll('.pp-side [data-people-edit="first"]').length <= 1`));
    await click('[data-people-photo="0"]');
    await chrome.until(`document.querySelector('.ck-viewer__stage img.is-loaded')`);
    const hash = `sha256:${served.photos[0].image}`;
    assert.equal(await chrome.evaluate(`document.querySelector('.ck-viewer__stage img').getAttribute('data-src')`),
      `/api/life/picture?${new URLSearchParams({ hash, size: 'screen', recipe: String(RECIPE) })}`);
    const answered = await fetch(`${url}/api/life/photos?${new URLSearchParams({ hash })}`);
    const facts = answered.ok ? (await answered.json()).photo : null;
    await chrome.until(`document.querySelector('.ck-viewer')?.dataset.facts === 'read'`);
    assert.equal(await chrome.evaluate(`document.querySelector('.ck-viewer__title')?.textContent`), titleOf(facts));
    assert.equal(await chrome.evaluate(`document.querySelectorAll('.ck-viewer__chip').length`), facts?.people.length ?? 0);
    await stroke('Escape');
    await chrome.until(`!document.querySelector('.ck-viewer')`);
  });

  test('P15: the sidebar’s own row follows You as the feed says People changed, its open menu kept', async () => {
    await load('#view=days', null);
    const listed = await (await fetch(`${url}/api/life/people`)).json();
    const name = `document.querySelector('#sidebar-you .ck-account__name')?.textContent`;
    await chrome.until(`${name} === ${JSON.stringify(listed.you.name)}`);
    await click('#sidebar-you .ck-account__btn');
    await chrome.until(`!document.querySelector('#ck-account-menu').hidden`);
    await chrome.evaluate(`window.rowWas = document.querySelector('#sidebar-you .ck-account__btn'); true`);
    await stub(`(url, init, real) => url === 'api/life/people' ? real(url, init).then(response => response.json())
    .then(body => (${JSON_ANSWER})({ ...body, you: { ...body.you, name: 'Renamed Example' } })) : real(url, init)`);
    const seq = (Number.parseInt(String(listed.position).split(':')[0] ?? '', 10) || 0) + 1;
    front.people(`${seq}:${Date.now()}`);
    await chrome.until(`${name} === 'Renamed Example'`);
    assert.deepEqual(await chrome.evaluate(`[location.hash.split('&')[0], document.querySelector('#ck-account-menu').hidden,
      document.querySelector('#sidebar-you .ck-account__btn') === window.rowWas, document.activeElement === window.rowWas]`),
    ['#view=days', false, true, true]);
  });
});

describe('people-photo: their photo uploaded, in Your Edit and in Edit', () => {

  before(async () => {
    ({ front, chrome, dir } = await page.journey('people-photo'));
    await namedA();
  });

  const { command, shot, click, attr, stub, load, held, landed, landedPast, fromDoor, act, boxes, enter, undoKey, namedA, centreOf, blobOf } = page;

  async function sidewaysPicture() {
    const made = Buffer.from(await chrome.evaluate(`(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1600;
    canvas.height = 1000;
    const drawn = canvas.getContext('2d');
    drawn.fillStyle = '#ff0000';
    drawn.fillRect(0, 0, 800, 1000);
    drawn.fillStyle = '#0000ff';
    drawn.fillRect(800, 0, 800, 1000);
    const blob = await new Promise(done => canvas.toBlob(done, 'image/jpeg', 0.9));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  })()`), 'base64');
    const exif = Buffer.from('ffe100224578696600004d4d002a00000008000101120003000000010006000000000000', 'hex');
    const after = 4 + made.readUInt16BE(4);
    return Buffer.concat([made.subarray(0, after), exif, made.subarray(after)]);
  }

  /** @param {Buffer} bytes */
  function jpegSize(bytes) {
    for (let at = 2; at + 9 < bytes.length; at += 2 + bytes.readUInt16BE(at + 2)) {
      if (bytes[at + 1] === 0xc0 || bytes[at + 1] === 0xc2) return [bytes.readUInt16BE(at + 7), bytes.readUInt16BE(at + 5)];
    }
    return null;
  }

  /**
   * @param {string} selector
   * @param {string[]} files
   */
  async function chooseFiles(selector, files) {
    const { root } = await chrome.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await chrome.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    await chrome.send('DOM.setFileInputFiles', { nodeId, files });
  }

  /**
   * @param {string} selector
   * @param {string} file
   * @param {{ held?: () => Promise<void>, away?: string }} [how]
   */
  async function dragFile(selector, file, { held, away } = {}) {
    /** @param {string} named @returns {Promise<[number, number]>} */
    const centre = named => chrome.evaluate(`(() => { const box = document.querySelector(${JSON.stringify(named)}).getBoundingClientRect();
    return [box.x + box.width / 2, box.y + box.height / 2]; })()`);
    let [x, y] = await centre(selector);
    const data = { items: [], files: [file], dragOperationsMask: 1 };
    await chrome.send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data });
    await chrome.send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data });
    await held?.();
    if (away) {
      [x, y] = await centre(away);
      await chrome.send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data });
      await chrome.until(`!document.querySelector('.ck-fcrop--upload.is-lit')`);
    }
    await chrome.send('Input.dispatchDragEvent', { type: 'drop', x, y, data });
  }

  /** @param {Buffer} bytes */
  const paste = bytes => chrome.evaluate(`(() => {
  const bytes = Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}), letter => letter.charCodeAt(0));
  const data = new DataTransfer();
  data.items.add(new File([bytes], 'pasted.jpg', { type: 'image/jpeg' }));
  (document.activeElement ?? document.body).dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  return true;
})()`);

  test('P9: their photo uploaded: the chooser, a file and a drop, Move and scale, Use saving it and Undo, Edit\'s Cancel keeping it', async () => {
    front.faces({ state: 'on', scanned: 30, photos: 30 });
    await load('#view=people', null);
    await chrome.until(`document.querySelector('.pp-side [data-person="${OWN}"]')`);
    const picture = join(dir, 'synthetic-sideways.jpg');
    const note = join(dir, 'synthetic-note.txt');
    const pictureBytes = await sidewaysPicture();
    await writeFile(picture, pictureBytes);
    await writeFile(note, 'synthetic words, no picture');
    const sha = (/** @type {Buffer} */ bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const madeTile = `(own => Boolean(own?.matches('span[role="img"]') && own.querySelector('.ck-tick.is-on')))(
    document.querySelector('[data-o-own="made"]'))`;

    await click(`.pp-side [data-person="${OWN}"]`);
    await chrome.until(`document.querySelector('[data-people-edit="open"]')`);
    await click('[data-people-edit="open"]');
    await chrome.until(`document.querySelector('.pl-naming__title')?.textContent === 'Edit' && document.querySelector('[data-o-do="photo"]')`);
    const still = await boxes();
    await click('[data-o-do="photo"]');
    await chrome.until(`document.querySelector('.pp-window .ck-fcrop--upload') && !document.querySelector('.pp-window .ck-fcrop--reading')`);
    assert.equal(await boxes(), still, 'the chooser opening moves nothing on the card');
    assert.equal(await chrome.evaluate(`document.querySelector('.pp-window .ck-fgrid__faces > :first-child').matches('.ck-fcrop--upload')`), true);
    const alone = `document.querySelectorAll('.pp-window .ck-fgrid__faces > *').length === 1 && !document.querySelector('.pp-window [data-o-own]')
    && document.querySelector('.pp-window .ck-none')?.textContent === 'No photos of you yet.'
    && document.querySelector('.pp-window__none-photo [data-o-do="faces"]')?.textContent.includes('Mark your face')`;
    assert.equal(await chrome.evaluate(alone), true, 'the chooser with no photo of you');
    await shot('photo-chooser', `document.querySelector('.pp-window .ck-fcrop--upload')`);

    await chooseFiles('[data-o-upload]', [note]);
    await chrome.until(`document.querySelector('.ck-mas.is-refused')`);
    assert.equal(await chrome.evaluate(shows('This picture can\'t be opened here.')), true);
    assert.equal(await chrome.evaluate(`document.querySelector('[data-ck-mas="use"]').disabled`), true);
    assert.equal(await boxes(), still, 'Move and scale opening moves nothing on the card');
    await shot('photo-refused', `document.querySelector('.ck-mas.is-refused')`);
    await click('[data-ck-mas="cancel"]');
    await chrome.until(`document.querySelector('.pp-window .ck-fcrop--upload') && !document.querySelector('.ck-mas')`);

    await chooseFiles('[data-o-upload]', [picture]);
    await chrome.until(`document.querySelector('.ck-mas:not(.is-refused)') && document.activeElement?.matches('.ck-mas__stage')`);
    assert.deepEqual(await attr('.ck-mas', 'data-width'), ['1000']);
    assert.deepEqual(await attr('.ck-mas', 'data-height'), ['1600']);
    assert.equal(await boxes(), still);
    await shot('photo-move-and-scale', `document.querySelector('.ck-mas:not(.is-refused) .ck-mas__img')?.complete`);
    assert.deepEqual(await chrome.evaluate(`(img => [img.matches('.ck-pic, .is-loaded'), getComputedStyle(img).opacity])(
    document.querySelector('.ck-mas__img'))`), [false, '1']);
    const [x, y] = await chrome.evaluate(`(() => { const box = document.querySelector('.ck-mas__stage').getBoundingClientRect();
    return [box.x + box.width / 2, box.y + box.height / 2]; })()`);
    await chrome.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await chrome.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: y - 500, button: 'left', buttons: 1 });
    await chrome.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: y - 500, button: 'left', buttons: 0, clickCount: 1 });
    await chrome.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: -240 });
    await chrome.until(`Number(document.querySelector('.ck-mas__slider').value) > 0`);
    await chrome.evaluate(`document.querySelector('.ck-mas__slider').focus()`);
    for (const type of ['rawKeyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
    await chrome.until(`document.querySelector('.ck-mas__slider').value === '1'`);
    await shot('photo-moved-and-scaled', `document.querySelector('.ck-mas__slider').value === '1'`);
    const using = landed();
    await click('[data-ck-mas="use"]');
    await chrome.until(`${madeTile}`);
    await chrome.until(`document.querySelector('.pp-hero__face img')?.dataset.src?.startsWith('blob:') && document.querySelector('.pp-hero__face img').complete && document.querySelector('.pp-hero__face img').naturalWidth > 0`);
    const [red, , blue] = await centreOf('.pp-hero__face img');
    assert.ok(blue > 200 && red < 60, `the square is not of the blue half: ${red}, ${blue}`);
    const above = (/** @type {string} */ boxed) => JSON.stringify(JSON.parse(boxed).slice(0, JSON.parse(still).findIndex(([row]) => row === 'faces')));
    assert.equal(above(await boxes()), above(still), 'the square on the card moves nothing above Mark their face');
    assert.equal(await chrome.evaluate(`Boolean(document.querySelector('.pp-panel [data-row="faces"]'))`), false);
    assert.deepEqual(await chrome.evaluate(`[Boolean(document.querySelector('.pp-window [data-o-do="faces"]')),
    document.querySelector('.pp-window .ck-fgrid').matches('.ck-fgrid--4')]`), [false, true]);
    await chrome.until(`document.querySelector('.pp-foot__said span')?.textContent === 'Photo saved'`);
    assert.equal(await chrome.evaluate(`Boolean(document.querySelector('.pp-foot [data-o-do="undo"]'))`), true, 'Undo beside Photo saved');
    await shot('photo-made', `${madeTile}`);
    await landedPast(using);
    assert.equal(landed(), using + 1, 'one action');
    const [mine] = [...(await held()).persons].filter(([, record]) => record.anchor?.value === OWN.slice('phone:'.length));
    assert.ok(mine, 'no record made for you');
    assert.equal(mine[1].me, true, 'your first record is marked you');
    const own = `person:${mine[0]}`;
    const stated = (await held()).photos.get(own);
    assert.deepEqual(Object.keys(stated).sort(), ['image', 'type']);
    const square = await blobOf(stated.image);
    assert.equal(sha(square), stated.image);
    assert.deepEqual(jpegSize(square), [160, 160], 'the least square, sent at its own size');
    await stub(`(url, init, real) => url === 'api/owner/act' && JSON.parse(init.body).kind === 'undo' && !window.releaseUndo
    ? new Promise(done => { window.releaseUndo = done; }).then(() => real(url, init)) : real(url, init)`);
    const undoing = landed();
    await undoKey();
    await chrome.until('Boolean(window.releaseUndo)');
    await paste(pictureBytes);
    await chrome.until(`document.querySelector('.ck-mas:not(.is-refused)') && document.activeElement?.matches('.ck-mas__stage')`);
    await click('[data-ck-mas="use"]');
    await chrome.until(`${madeTile} && document.querySelector('.pp-foot__said span')?.textContent === 'Photo saved'`);
    const newer = await chrome.evaluate(`document.querySelector('.pp-hero__face img')?.getAttribute('data-src')`);
    assert.ok(String(newer).startsWith('blob:'));
    await chrome.evaluate('window.releaseUndo(); true');
    await landedPast(undoing + 1);
    assert.deepEqual(await chrome.evaluate(`[document.querySelector('.pp-hero__face img')?.getAttribute('data-src'),
    document.querySelector('.pp-foot__said span')?.textContent, ${madeTile}]`), [newer, 'Photo saved', true], 'the newer photo stands');
    assert.equal((await held()).photos.has(own), true, 'the home holds the newer');
    const undoingNewer = landed();
    await undoKey();
    await chrome.until(`document.querySelector('.pp-foot__said span')?.textContent === 'Photo taken back'`);
    await chrome.until(alone);
    await chrome.until(`document.querySelector('.pp-panel [data-row="faces"]')`);
    await landedPast(undoingNewer);
    assert.equal((await held()).photos.has(own), false, 'Undo leaves the upload');
    await chrome.evaluate('window.fetch = window.realFetch; true');

    assert.deepEqual(await chrome.evaluate(`['[data-o-do="hide"]', '[data-o-field="rel"]', '[data-o-do="notperson"]']
    .map(each => Boolean(document.querySelector(each)))`), [false, false, false]);
    await click('.pp-foot [data-o-do="cancel"]');
    await chrome.until(`!document.querySelector('.pp-panel')`);

    await load('#view=people&focus=person:person-a', null);
    await chrome.until(`document.querySelector('[data-people-edit="open"]') && document.querySelector('[data-people-retry]') === null`);
    await click('[data-people-edit="open"]');
    await chrome.until(`document.querySelector('.pl-naming__title')?.textContent === 'Edit person' && document.querySelector('[data-o-field="rel"]')`);
    await click('[data-o-do="photo"]');
    await chrome.until(`document.querySelector('.pp-window [data-o-frame]') && !document.querySelector('.pp-window .ck-fcrop--reading')`);
    const page = await chrome.evaluate('location.href');
    await dragFile('.pp-panel .pp-hero', picture, { held: async () => {
      await chrome.until(`document.querySelector('.pp-window .ck-fcrop--upload.is-lit')`);
      await shot('photo-drop', `document.querySelector('.pp-window .ck-fcrop--upload.is-lit')`);
    } });
    await chrome.until(`document.querySelector('.ck-mas:not(.is-refused)') && !document.querySelector('.ck-fcrop--upload.is-lit')`);
    assert.equal(await chrome.evaluate('location.href'), page, 'a drop opened in place of the page');
    await click('[data-ck-mas="cancel"]');
    await chrome.until(`document.querySelector('.pp-window .ck-fcrop--upload') && !document.querySelector('.ck-mas')`);
    await paste(pictureBytes);
    await chrome.until(`document.querySelector('.ck-mas:not(.is-refused)') && document.activeElement?.matches('.ck-mas__stage')`);
    await command('pause', { target: 'people:people' });
    const saving = landed();
    await stub(`(url, init, real) => url === 'api/owner/act'
    ? new Promise(done => { window.releaseAct = done; }).then(() => real(url, init)) : real(url, init)`);
    await enter();
    await chrome.until(`${madeTile}
    && document.querySelector('.pp-foot__said span')?.textContent === 'Photo saved'`);
    await click('.pp-window [data-o-do="back"]');
    await chrome.until(`!document.querySelector('.pp-window .ck-fcrop--upload')`);
    await dragFile('.pp-panel .pp-hero', picture);
    assert.deepEqual(await chrome.evaluate(`[location.href, Boolean(document.querySelector('.ck-mas')), Boolean(document.querySelector('.ck-fcrop--upload.is-lit'))]`),
      [page, false, false], 'a drop with the chooser closed is taken');
    assert.equal(await chrome.evaluate(`(() => { document.querySelector('.pp-foot [data-o-do="cancel"]').click();
    return Boolean(document.querySelector('.pp-panel')); })()`), true, 'Cancel left before the photo was saved');
    await chrome.evaluate('window.fetch = window.realFetch; window.releaseAct(); true');
    await chrome.until(`!document.querySelector('.pp-panel') && document.querySelector('.pp-head img')?.dataset.src?.startsWith('blob:')`);
    await shot('photo-person', `document.querySelector('.pp-head img.is-loaded')`);
    const saved = await front.landing(saving);
    const theirs = (await held()).photos.get('person:person-a');
    assert.ok(theirs?.image, 'landed before its answer');
    assert.deepEqual((await fromDoor('/v1/people', { id: 'person:person-a' })).person.photo, { crop: theirs.image },
      'the upload on the next read, People\'s run held');
    await command('resume', { target: 'people:people' });
    await command('settle');
    assert.deepEqual(jpegSize(await blobOf(theirs.image)), [1000, 1000]);
    assert.equal(await chrome.evaluate(`document.querySelector('.pp-head img')?.getAttribute('data-src')?.startsWith('blob:')`), true);
    const undoingSave = landed();
    const undone = await act({ kind: 'undo', act: saved });
    assert.equal(undone.status, 200, await undone.text());
    await landedPast(undoingSave);
  });
});
