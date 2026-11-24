import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { placesSuite, WATCH_POLICY } from './stand-ins/places-page.mjs';
import { FIXTURE_HASHES, PHOTO_FACTS } from './stand-ins/places-home.mjs';
import { until } from './until.mjs';
import { parseRoute } from '../public/lib/hash.js';

const suite = placesSuite({ file: 'photo-viewer' });
const { asked, click, count, words, shot, seen } = suite;
/** @type {Awaited<ReturnType<typeof suite.journey>>['home']} */
let home;
/** @type {Awaited<ReturnType<typeof suite.journey>>['front']} */
let front;
/** @type {Awaited<ReturnType<typeof suite.journey>>['chrome']} */
let chrome;
let url = '';

const SHOWN = '.ck-viewer__stage img.ck-picture__image';
const FAST_REST = `(() => {
  const later = window.setTimeout;
  window.fastRest = false;
  window.setTimeout = (run, ms, ...rest) => later(run, window.fastRest && ms === 2000 ? 30 : ms, ...rest);
})();`;
const waitStill = async () => {
  await chrome.evaluate('window.fastRest = true');
  try {
    await chrome.hover(SHOWN);
    await chrome.until(`document.querySelector('.ck-viewer.is-still')`);
  } finally {
    await chrome.evaluate('window.fastRest = false');
  }
};
const H = FIXTURE_HASHES;
/**
 * @param {number} seed
 * @returns {any}
 */
const factsOf = seed => PHOTO_FACTS.get(H[seed].slice('sha256:'.length));
const drew = /** @type {Record<string, unknown>} */ ({});

const factsRead = () => asked.map(address => new URL(address)).filter(address => address.pathname === '/api/life/photos')
  .map(address => address.searchParams.get('hash'));
/** @param {string} selector */
const routeOf = async selector => parseRoute(String(await chrome.evaluate(`document.querySelector(${JSON.stringify(selector)})
  .getAttribute('href')`)));
/** @param {string} title */
const drawnWith = title => chrome.until(`document.querySelector('.ck-viewer__title')?.textContent === ${JSON.stringify(title)}`
  + ` && document.querySelector('${SHOWN}.is-loaded')`);
const open = (/** @type {string[]} */ hashes, /** @type {number} */ at) => chrome.evaluate(`import('/ui/kit/photo-viewer.js')
  .then(kit => { window.closedAt = null; kit.openPhotoViewer(${JSON.stringify(hashes)}, ${at}, { closed: index => { window.closedAt = index; } }); })`);
const closeViewer = async () => {
  if (await chrome.evaluate(`document.querySelector('.ck-viewer')?.classList.contains('is-info')`)) await chrome.press('Escape');
  await chrome.press('Escape');
  await chrome.until(`!document.querySelector('.ck-viewer')`);
};
const infoRows = () => chrome.evaluate(`[...document.querySelectorAll('.ck-viewer__info .ck-viewer__row')].map(row =>
  [row.dataset.row, ...[...row.querySelectorAll('.ck-viewer__line')].map(line => line.textContent)])`);
const infoParts = () => chrome.evaluate(`[...document.querySelectorAll('.ck-viewer__info [data-part]')].map(part => part.dataset.part)`);
/** @param {any} photo */
const titleOf = photo => chrome.evaluate(`import('/ui/kit/photo-viewer.js').then(({ barWords }) => barWords(${JSON.stringify(photo)}).title.text)`);
/**
 * @param {number} x
 * @param {number} y
 */
const clickAt = async (x, y) => {
  await chrome.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await chrome.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
};
const enter = async () => {
  await chrome.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await chrome.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
};
const showAgentCard = () => chrome.evaluate(`(() => {
  const layer = document.getElementById('agent-layer');
  window.agentPressed = 0;
  layer.innerHTML = '<div><button type="button" data-test-allow>Allow</button></div>';
  layer.hidden = false;
  layer.querySelector('[data-test-allow]').addEventListener('click', () => { window.agentPressed += 1; });
})()`);
const hideAgentCard = () => chrome.evaluate(`(() => { const layer = document.getElementById('agent-layer'); layer.innerHTML = ''; layer.hidden = true; })()`);
/** @param {string} selector */
const boxOf = selector => chrome.evaluate(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`);
/**
 * @param {number} got
 * @param {number} want
 * @param {string} what
 */
const near = (got, want, what) => assert.ok(Math.abs(got - want) <= 1, `${what}: ${got} is not ${want}`);

before(() => suite.open());

after(() => suite.close());

describe('photo-viewer: one photo full size, with what the home knows of it', () => {
  before(async () => {
    const opened = await suite.journey('photo-viewer');
    ({ home, front, chrome, url } = opened);
    seen.pages.viewer = drew;
  });

  test('V1–V6: a place\'s photo, its facts over it, a face pointed at, the reads, Info', async () => {
    await chrome.load('#view=places&focus=fixture-climbing-hall', WATCH_POLICY + FAST_REST);
    await chrome.until('document.querySelectorAll(".pl-page .ck-photo__img").length === 4');
    await click('.ck-photo[data-pl-photo="0"]');
    const first = factsOf(0);
    await drawnWith('Climbing Hall');
    assert.equal(await words('.ck-viewer__count'), '1 of 18');
    assert.equal(await words('.ck-viewer__date'), 'Saturday 11 October 2025 · 17:42');
    assert.deepEqual(await routeOf('.ck-viewer__title'), parseRoute('#view=places&focus=fixture-climbing-hall'));
    const day = await routeOf('.ck-viewer__date');
    assert.deepEqual([day.view, day.on, day.focus], ['days', '2025-10-11', `u:${first.unit}`]);
    await chrome.until(`document.querySelectorAll('.ck-viewer__chip').length === 2`);
    assert.deepEqual(await suite.rows('.ck-viewer__chip-name'), ['Person A', 'Person B']);
    assert.deepEqual(await chrome.evaluate(`[...document.querySelectorAll('.ck-viewer__chip')].map(chip => chip.getAttribute('href'))`),
      ['#view=people&focus=phone%3A%2B15550000001', '#view=people&focus=person%3Aperson-b']);
    assert.deepEqual(await chrome.evaluate(`(() => {
      const viewer = document.querySelector('.ck-viewer');
      return { role: viewer.getAttribute('role'), modal: viewer.getAttribute('aria-modal'),
        label: viewer.getAttribute('aria-labelledby').split(' ').map(id => document.getElementById(id)?.textContent),
        inert: [...document.body.children].filter(each => each !== viewer && each.id !== 'agent-layer').every(each => each.inert),
        agents: document.getElementById('agent-layer')?.inert ?? null };
    })()`), { role: 'dialog', modal: 'true', label: ['Climbing Hall', 'Saturday 11 October 2025 · 17:42'], inert: true, agents: false });
    await shot('place', `document.querySelector('${SHOWN}.is-loaded')`);
    await until('the photo shown and the next read', () => factsRead().length === 2);
    assert.deepEqual(factsRead(), [H[0], H[1]]);

    await chrome.hover('.ck-viewer__chip[data-chip="1"]');
    await chrome.until(`document.querySelector('.ck-viewer__face')?.classList.contains('is-on')`);
    const face = await chrome.evaluate(`(() => {
      const image = document.querySelector('${SHOWN}').getBoundingClientRect();
      const svg = document.querySelector('.ck-viewer__face').getBoundingClientRect();
      const outline = document.querySelector('.ck-viewer__outline');
      const at = name => Number(outline.getAttribute(name));
      return { image: image.toJSON(), svg: svg.toJSON(), scrims: document.querySelectorAll('.ck-viewer__face .ck-viewer__scrim').length,
        outline: { x: svg.left + at('x'), y: svg.top + at('y'), width: at('width'), height: at('height'), rx: at('rx') } };
    })()`);
    drew.pointed = face;
    assert.equal(face.scrims, 4);
    for (const side of ['left', 'top', 'width', 'height']) near(face.svg[side], face.image[side], `the wash's ${side}`);
    const scale = face.image.width / first.size.width;
    const [x1, y1, x2, y2] = first.people[1].box;
    near(face.outline.x, face.image.left + x1 * scale, 'the outline\'s left');
    near(face.outline.y, face.image.top + y1 * scale, 'the outline\'s top');
    near(face.outline.width, (x2 - x1) * scale, 'the outline\'s width');
    near(face.outline.height, (y2 - y1) * scale, 'the outline\'s height');
    near(face.outline.rx, Math.max(6, 0.12 * Math.min(x2 - x1, y2 - y1) * scale), 'the outline\'s corners');
    await shot('pointed', `document.querySelector('.ck-viewer__face')?.classList.contains('is-on')`);
    await chrome.hover('.ck-viewer__count');
    await chrome.until(`!document.querySelector('.ck-viewer__face.is-on')`);
    await chrome.evaluate(`document.querySelector('.ck-viewer__chip[data-chip="0"]').focus()`);
    await chrome.until(`document.querySelector('.ck-viewer__face.is-on')`);
    await chrome.evaluate(`document.querySelector('.ck-viewer').focus()`);
    await chrome.until(`!document.querySelector('.ck-viewer__face.is-on')`);

    await chrome.key('ArrowRight');
    await drawnWith('Seafront');
    assert.equal(await words('.ck-viewer__count'), '2 of 18');
    assert.equal(await chrome.evaluate(`document.querySelector('.ck-viewer__title').tagName`), 'SPAN', 'an area is no link');
    await chrome.hover('.ck-viewer__chip[data-chip="0"]');
    await chrome.until(`document.querySelector('.ck-viewer__chip[data-chip="0"]').matches(':hover')`);
    assert.equal(await count('.ck-viewer__face.is-on'), 0, 'a face with no box outlined');
    const mark = asked.length;
    await chrome.evaluate(`window.bare = []; window.bareWatch = new MutationObserver(() => window.bare.push(
      ...[...document.querySelectorAll('img.ck-pic.is-loaded')].filter(img => !img.naturalWidth).map(img => img.dataset.src)));
      window.bareWatch.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'src'] })`);
    await chrome.key('ArrowLeft');
    await drawnWith('Climbing Hall');
    const again = await chrome.evaluate(`(img => { window.bareWatch.disconnect();
      return { address: new URL(img.dataset.src, location.href).href, width: img.naturalWidth, bare: window.bare }; })(document.querySelector('${SHOWN}'))`);
    assert.ok(again.width > 0, 'the photo shown again not drawn');
    assert.deepEqual(again.bare, [], 'a picture loaded with no pixels');
    assert.ok(asked.slice(0, mark).includes(again.address), 'the photo never asked');
    assert.deepEqual(asked.slice(mark).filter(address => address === again.address), [], 'the photo shown again asked again');
    await chrome.key('ArrowRight');
    await chrome.key('ArrowRight');
    await until('the fourth photo read ahead', () => factsRead().includes(H[3]));
    assert.deepEqual(factsRead(), [H[0], H[1], H[2], H[3]]);
    await chrome.key('End');
    await chrome.until(`document.querySelector('.ck-viewer__count')?.textContent === '18 of 18'`);
    await chrome.key('Home');
    await drawnWith('Climbing Hall');
    assert.equal(await words('.ck-viewer__count'), '1 of 18');

    await chrome.press('i');
    await chrome.until(`document.querySelector('.ck-viewer.is-info [data-part="place"]')`);
    assert.equal(await chrome.evaluate(`document.querySelector('[data-ck-viewer="info"]').getAttribute('aria-pressed')`), 'true');
    assert.deepEqual(await infoParts(), ['caption', 'people', 'place', 'rows']);
    assert.equal(await words('.ck-viewer__caption'), first.caption);
    assert.deepEqual(await suite.rows('.ck-viewer__person-name'), ['Person A', 'Person B']);
    assert.equal(await words('.ck-viewer__place-name'), 'Climbing Hall');
    assert.equal(await words('.ck-viewer__place-area'), 'Lisbon');
    assert.deepEqual(await routeOf('.ck-viewer__place'), parseRoute('#view=places&focus=fixture-climbing-hall'));
    assert.deepEqual(await infoRows(), [['date', 'Saturday 11 October 2025', '17:42'], ['camera', 'iPhone 17 Pro', 'From your iPhone']]);
    assert.equal(await count('.ck-viewer__head:not([hidden])'), 0, 'the bar\'s centre shown with Info');
    assert.equal(await count('.ck-viewer__chip'), 0, 'the chips shown with Info');
    await chrome.until(`document.querySelector('.ck-viewer [data-map="viewer"]')?.dataset.style === 'dark'`);
    await shot('info', `document.querySelector('.ck-viewer [data-map="viewer"]')?.dataset.drawn !== undefined`);
    await chrome.theme('light');
    const [ground, mapStyle, darkCanvas] = await chrome.evaluate(`(() => {
      const probe = document.createElement('div');
      probe.dataset.theme = 'dark';
      probe.style.background = 'var(--canvas)';
      document.body.append(probe);
      const dark = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return [getComputedStyle(document.querySelector('.ck-viewer')).backgroundColor,
        document.querySelector('.ck-viewer [data-map="viewer"]').dataset.style, dark];
    })()`);
    assert.deepEqual([ground, mapStyle], [darkCanvas, 'dark']);
    await chrome.theme('dark');
    await chrome.press('Escape');
    await chrome.until(`document.querySelector('.ck-viewer') && !document.querySelector('.ck-viewer.is-info')`);
    await chrome.press('Escape');
    await chrome.until(`!document.querySelector('.ck-viewer')`);
    assert.equal(await chrome.evaluate('document.activeElement?.dataset.plPhoto'), '0');
    assert.equal(await chrome.evaluate(`[...document.body.children].some(each => each.inert)`), false, 'the page left inert');
    await click('.ck-photo[data-pl-photo="1"]');
    await drawnWith('Seafront');
    await chrome.press('i');
    await chrome.until(`document.querySelector('.ck-viewer.is-info')`);
    await click('[data-ck-viewer="close"]');
    await chrome.until(`!document.querySelector('.ck-viewer')`);
    await click('.ck-photo[data-pl-photo="1"]');
    await chrome.until(`document.querySelector('.ck-viewer.is-info [data-part="rows"]')`);
    drew.remembered = await chrome.evaluate(`localStorage.getItem('viewer.info')`);
    assert.equal(drew.remembered, 'open');
    await chrome.press('i');
    await chrome.until(`!document.querySelector('.ck-viewer.is-info')`);
    assert.equal(await chrome.evaluate(`localStorage.getItem('viewer.info')`), null);
    await waitStill();
    const [x, y] = await chrome.evaluate(`(() => { const box = document.querySelector('${SHOWN}').getBoundingClientRect();
      return [box.x + 10, box.y + 10]; })()`);
    await chrome.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await chrome.until(`!document.querySelector('.ck-viewer.is-still')`);
    await closeViewer();
  });

  test('V10: the viewer over a spot\'s naming card owns the keys, Tab stays in it, the focus comes back', async () => {
    await chrome.load('#view=places', WATCH_POLICY + FAST_REST);
    await chrome.until('document.querySelector(".pl-invite") && !document.querySelector(".pl.ck-reading")');
    await click('.pl-invite [data-pl-open="name"]');
    await chrome.until(`document.querySelector('.pl-naming__count')?.textContent === '1 of 3'`
      + ' && !document.querySelector(".pl-card .ck-namerow--reading")');
    const stated = front.saved.length;
    await click('[data-pl-spot-photo="0"]');
    await drawnWith('Seafront');
    assert.equal(await words('.ck-viewer__count'), '1 of 6');
    for (const key of ['x', 'y', 'Enter']) await chrome.press(key);
    await chrome.key('ArrowRight');
    await chrome.until(`document.querySelector('.ck-viewer__count')?.textContent === '2 of 6'`);
    assert.equal(await chrome.evaluate(`document.querySelector('form[data-pl-form="name"] input[name=name]').value`), '');
    assert.equal(front.saved.length, stated, 'a name saved under the viewer');
    assert.equal(await words('.pl-naming__count'), '1 of 3');
    /** @type {boolean[]} */
    const inside = [];
    for (let turn = 0; turn < 10; turn += 1) {
      await chrome.key('Tab');
      inside.push(await chrome.evaluate(`Boolean(document.activeElement?.closest('.ck-viewer'))`));
    }
    for (let turn = 0; turn < 10; turn += 1) {
      for (const type of ['rawKeyDown', 'keyUp']) {
        await chrome.send('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
      }
      inside.push(await chrome.evaluate(`Boolean(document.activeElement?.closest('.ck-viewer'))`));
    }
    drew.tabbed = inside;
    assert.ok(inside.every(Boolean), JSON.stringify(inside));
    await showAgentCard();
    await chrome.evaluate(`document.querySelector('[data-test-allow]').focus()`);
    await chrome.key('ArrowRight');
    await enter();
    await chrome.until('window.agentPressed === 1');
    assert.equal(await words('.pl-naming__count'), '1 of 3', 'a key on the agent\'s card skipped a naming card');
    assert.equal(await words('.ck-viewer__count'), '2 of 6', 'a key on the agent\'s card stepped the photo');
    assert.equal(front.saved.length, stated, 'Enter on the agent\'s card saved a name');
    await hideAgentCard();
    await chrome.until(`document.activeElement?.closest('.ck-viewer')`);
    await shot('over-naming', `document.querySelector('${SHOWN}.is-loaded')`);
    await closeViewer();
    assert.equal(await chrome.evaluate('document.activeElement?.dataset.plSpotPhoto'), '0');
  });

  test('V7, V8: a chat\'s picture, a screenshot, no facts yet, a read that fails, a picture that cannot be drawn', async () => {
    await open([H[2], H[3]], 0);
    await drawnWith('Thursday 9 October 2025 · 20:15');
    assert.equal(await count('.ck-viewer__date'), 0, 'the date said twice');
    const chat = factsOf(2).chat;
    const opens = await routeOf('.ck-viewer__title');
    assert.deepEqual([opens.view, opens.on, opens.focus],
      ['days', '2025-10-09', `rec:${chat.record.source} ${chat.record.kind} ${chat.record.key}`]);
    await chrome.press('i');
    await chrome.until(`document.querySelector('.ck-viewer.is-info [data-part="rows"]')`);
    assert.deepEqual(await infoParts(), ['rows']);
    assert.deepEqual(await infoRows(), [['date', 'Thursday 9 October 2025', '20:15'], ['chat', 'Sent by Person A', 'Weekend plans · WhatsApp']]);
    const message = await routeOf('.ck-viewer__row[data-row="chat"]');
    assert.deepEqual([message.view, message.on, message.focus],
      ['days', '2025-10-09', `rec:${chat.record.source} ${chat.record.kind} ${chat.record.key}`]);
    await shot('chat', `document.querySelector('${SHOWN}.is-loaded')`);
    await chrome.key('ArrowRight');
    await chrome.until(`document.querySelector('.ck-viewer__row[data-row="camera"]')`);
    assert.deepEqual(await infoRows(), [['date', 'Sunday 12 October 2025', '01:10'], ['camera', 'Screenshot', 'From your Mac’s Photos']]);
    const boundary = await routeOf('.ck-viewer__row[data-row="date"]');
    assert.deepEqual([boundary.on, boundary.focus], ['2025-10-11', `u:${factsOf(3).unit}`]);
    await chrome.press('i');
    await drawnWith('Sunday 12 October 2025 · 01:10');
    await closeViewer();

    front.holdPhoto(H[6]);
    await open([H[6], H[7]], 0);
    await chrome.until(`document.querySelector('${SHOWN}.is-loaded')`);
    drew.reading = await chrome.evaluate(`({ facts: document.querySelector('.ck-viewer').dataset.facts,
      count: document.querySelector('.ck-viewer__count').textContent, titles: document.querySelectorAll('.ck-viewer__title').length,
      chips: document.querySelectorAll('.ck-viewer__chip').length,
      controls: [...document.querySelectorAll('.ck-viewer button')].map(button => button.dataset.ckViewer) })`);
    assert.deepEqual(drew.reading, { facts: 'reading', count: '1 of 2', titles: 0, chips: 0, controls: ['info', 'close', 'prev', 'next'] });
    await shot('reading', `document.querySelector('${SHOWN}.is-loaded')`);
    front.letPhoto(H[6]);
    await drawnWith('River Flat');
    await closeViewer();
    front.failPhoto(H[7], true);
    const before = front.photosAsked.length;
    await open([H[7], H[6]], 0);
    await chrome.until(`document.querySelector('.ck-viewer')?.dataset.facts === 'failed'`);
    assert.equal(await count('.ck-viewer__title'), 0);
    await chrome.press('i');
    await chrome.until(`document.querySelector('.ck-viewer__info .ck-lack')`);
    assert.equal(await words('.ck-viewer__info .ck-lack'), 'This photo’s details aren’t on this Mac yet.');
    await shot('failed', `document.querySelector('${SHOWN}.is-loaded')`);
    await chrome.press('i');
    front.failPhoto(H[7], false);
    await chrome.key('ArrowRight');
    await drawnWith('River Flat');
    await chrome.key('ArrowLeft');
    await chrome.until(`document.querySelector('.ck-viewer')?.dataset.facts === 'read'`
      + ` && document.querySelector('.ck-viewer__count').textContent === '1 of 2'`);
    assert.equal(front.photosAsked.slice(before).filter(hex => `sha256:${hex}` === H[7]).length, 2);
    await closeViewer();
    assert.equal(await chrome.evaluate('window.closedAt'), 0);
    await open([`sha256:${'f'.repeat(64)}`], 0);
    await chrome.until(`document.querySelector('.ck-viewer__failed:not([hidden])')`
      + ` && document.querySelector('.ck-viewer__title')?.textContent === 'Photo'`);
    assert.equal(await words('.ck-viewer__failed'), 'This picture cannot be shown here.');
    assert.equal(await words('.ck-viewer__count'), '');
    assert.equal(await count('.ck-viewer__nav'), 0, 'arrows for one photo');
    await shot('cannot-be-shown', `document.querySelector('.ck-viewer__failed:not([hidden])')`);
    await closeViewer();
  });

  test('V9, V13: whole photos fit at every size, the arrows clear of a panorama, Info over a narrow stage, a click outside closes', async () => {
    const sizes = [[4032, 3024], [3024, 4032], [6000, 1000]];
    const kept = /** @type {string[]} */ (await chrome.evaluate(`(async () => {
      const { keepPicture } = await import('/lib/api.js');
      return Promise.all(${JSON.stringify(sizes)}.map(async ([width, height], index) => {
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const paint = canvas.getContext('2d');
        paint.fillStyle = '#5b8496'; paint.fillRect(0, 0, width, height);
        paint.fillStyle = '#eccd87'; paint.fillRect(0, height / 2, width, height / 2);
        paint.strokeStyle = '#fff'; paint.lineWidth = 80; paint.strokeRect(40, 40, width - 80, height - 80);
        // Named by a hash and kept on the page under it: pictureUrl's one rule draws it.
        const hash = 'sha256:' + String(index + 1).repeat(64);
        keepPicture(hash, await new Promise(done => canvas.toBlob(done)));
        return hash;
      }));
    })()`));
    const frame = () => chrome.evaluate(`(() => {
      const box = selector => document.querySelector(selector)?.getBoundingClientRect().toJSON() ?? null;
      const image = document.querySelector('${SHOWN}');
      return { image: box('${SHOWN}'), stage: box('.ck-viewer__stage'), info: box('.ck-viewer__info'), prev: box('[data-ck-viewer="prev"]'),
        next: box('[data-ck-viewer="next"]'), natural: [image.naturalWidth, image.naturalHeight], viewport: [innerWidth, innerHeight],
        padding: parseFloat(getComputedStyle(document.querySelector('.ck-viewer__stage')).paddingLeft) };
    })()`);
    /** @param {number} at */
    const loaded = async at => {
      await chrome.until(`document.querySelector('${SHOWN}.is-loaded')`
        + ` && document.querySelector('.ck-viewer__count').textContent.startsWith('${at + 1} of')`);
      await chrome.evaluate(`document.querySelector('${SHOWN}').decode()`);
    };
    /** @type {unknown[]} */
    const fits = [];
    drew.fits = fits;
    for (const [width, height] of [[1440, 900], [390, 844], [800, 450]]) {
      await chrome.size(width, height, 1);
      for (let index = 0; index < 3; index += 1) {
        await open(kept, index);
        await loaded(index);
        const at = await frame();
        fits.push({ size: [width, height], index, ...at });
        const { image, stage, padding } = at;
        assert.ok(image.width > 0 && image.height > 0);
        assert.ok(image.left >= stage.left + padding - 1 && image.right <= stage.right - padding + 1, `${width}: the photo leaves its room across`);
        assert.ok(image.top >= stage.top - 1 && image.bottom <= stage.bottom + 1, `${width}: the photo leaves its room down`);
        assert.ok(image.width <= at.natural[0] + 1, 'the photo drawn past its pixels');
        near(image.width / image.height, sizes[index][0] / sizes[index][1], `${width}: the photo's shape`);
        if (width === 1440) {
          assert.ok(at.prev.right <= image.left && at.next.left >= image.right, `an arrow over photo ${index}`);
          near(at.prev.left, 24, 'the previous arrow from the edge');
        }
        if (width === 390) {
          near(at.prev.left, 16, 'the previous arrow from the edge');
          near(at.viewport[0] - at.next.right, 16, 'the next arrow from the edge');
        }
        if (index === 2) await shot(`fit-${width}`, `document.querySelector('${SHOWN}.is-loaded')`);
        await closeViewer();
      }
    }
    await chrome.size(880, 800, 1);
    await open(kept, 0);
    await loaded(0);
    const bare = await frame();
    await chrome.press('i');
    await chrome.until(`document.querySelector('.ck-viewer.is-info .ck-viewer__info')`);
    const over = await frame();
    drew.narrowInfo = { bare, over };
    for (const side of ['left', 'top', 'width', 'height']) near(over.image[side], bare.image[side], `the photo refitted under Info: ${side}`);
    assert.ok(over.info.left < over.stage.right && over.info.right <= over.viewport[0], 'Info not over the stage');
    await shot('info-880', `document.querySelector('.ck-viewer.is-info .ck-viewer__info')`);
    await chrome.press('i');
    await closeViewer();
    await chrome.size(1440, 900, 1);
    await open(kept, 1);
    await loaded(1);
    const portrait = await frame();
    await clickAt(portrait.image.x + portrait.image.width / 2, portrait.image.y + portrait.image.height / 2);
    assert.equal(await count('.ck-viewer'), 1, 'a click on the photo closed it');
    await clickAt(portrait.next.x + portrait.next.width / 2, portrait.next.y + portrait.next.height / 2);
    await loaded(2);
    assert.equal(await count('.ck-viewer'), 1, 'a click on an arrow closed it');
    const panorama = await frame();
    await clickAt(panorama.image.x + panorama.image.width / 2, panorama.image.top - 20);
    await chrome.until(`!document.querySelector('.ck-viewer')`);
    assert.equal(await chrome.evaluate('window.closedAt'), 2);
  });

  test('V14–V20: an agent\'s card by keyboard, failures read again, nothing after close, the focus and the fade kept, the chips, one rule', async () => {
    await chrome.size(1440, 900, 1);
    await chrome.load('#view=places', WATCH_POLICY + FAST_REST);
    await chrome.until(`document.getElementById('agent-layer') && document.querySelector('.pl-invite')`);
    await chrome.evaluate(`localStorage.removeItem('viewer.info')`);

    await open([H[0], H[1]], 0);
    await drawnWith('Climbing Hall');
    await showAgentCard();
    await chrome.evaluate(`document.querySelector('.ck-viewer__chip[data-chip="0"]').focus()`);
    await chrome.until(`document.querySelector('.ck-viewer__face.is-on')`);
    await chrome.evaluate(`document.querySelector('[data-test-allow]').focus()`);
    await chrome.until(`!document.querySelector('.ck-viewer__face.is-on')`);
    await chrome.evaluate(`document.querySelector('.ck-viewer').focus()`);
    /** @type {string[]} */
    const stops = [];
    while (stops.length < 12 && stops.at(-1) !== 'allow') {
      await chrome.key('Tab');
      stops.push(await chrome.evaluate(`document.activeElement?.matches('[data-test-allow]') ? 'allow'
        : document.activeElement?.closest('.ck-viewer') ? 'viewer' : document.activeElement?.tagName ?? 'nothing'`));
    }
    drew.agentTabs = stops;
    assert.equal(stops.at(-1), 'allow', JSON.stringify(stops));
    assert.ok(stops.slice(0, -1).every(stop => stop === 'viewer'), JSON.stringify(stops));
    await chrome.key('ArrowRight');
    assert.equal(await words('.ck-viewer__count'), '1 of 2', 'a key on the card stepped the photo');
    await enter();
    await chrome.until('window.agentPressed === 1');
    assert.equal(await count('.ck-viewer'), 1, 'Enter on the card closed the viewer');
    await shot('agent-card', `document.activeElement?.matches('[data-test-allow]')`);
    await hideAgentCard();
    await chrome.until(`document.activeElement?.closest('.ck-viewer')`);

    await chrome.evaluate(`(() => {
      window.animated = [];
      const own = Element.prototype.animate;
      Element.prototype.animate = function (frames, options) {
        window.animated.push({ on: [...this.classList].join('.'), frames: JSON.stringify(frames), duration: options?.duration ?? options });
        return own.call(this, frames, options);
      };
    })()`);
    const moved = () => chrome.evaluate(`window.animated.splice(0).map(each => ({ on: each.on, duration: each.duration,
      what: [...new Set([...each.frames.matchAll(/"(opacity|transform)"/gu)].map(match => match[1]))].join(',') }))`);
    const base = Number.parseFloat(await chrome.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--duration-base')`));
    await chrome.key('i');
    await chrome.until(`document.querySelector('.ck-viewer.is-info .ck-viewer__info')`);
    const reduced = await moved();
    await chrome.key('i');
    await chrome.until(`!document.querySelector('.ck-viewer.is-info')`);
    const reducedLeaving = await moved();
    await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await chrome.key('i');
    await chrome.until(`document.querySelector('.ck-viewer.is-info .ck-viewer__info')`);
    const full = await moved();
    await chrome.key('i');
    await chrome.until(`!document.querySelector('.ck-viewer.is-info')`);
    const fullLeaving = await moved();
    await chrome.theme('dark');
    drew.infoMotion = { reduced, reducedLeaving, full, fullLeaving };
    const has = (/** @type {any[]} */ list, /** @type {string} */ on, /** @type {string} */ what) =>
      list.some(each => each.on.includes(on) && each.what === what && each.duration === base);
    assert.ok(has(reduced, 'ck-viewer__info', 'opacity') && has(reduced, 'ck-viewer__stage', 'opacity'), JSON.stringify(reduced));
    assert.ok(reduced.every(each => each.what === 'opacity'), JSON.stringify(reduced));
    assert.ok(has(reducedLeaving, 'ck-viewer__info', 'opacity'), JSON.stringify(reducedLeaving));
    assert.ok(full.some(each => each.on.includes('ck-viewer__info') && each.duration === base) && !full.some(each => each.on.includes('ck-picture__image')),
      JSON.stringify(full));
    assert.ok(fullLeaving.some(each => each.on.includes('ck-viewer__info')) && !fullLeaving.some(each => each.on.includes('ck-picture__image')),
      JSON.stringify(fullLeaving));
    await chrome.evaluate(`window.animated = []`);

    await chrome.evaluate(`document.querySelector('.ck-viewer__title').focus()`);
    await chrome.key('i');
    await chrome.until(`document.querySelector('.ck-viewer.is-info [data-part="place"]')`);
    assert.equal(await chrome.evaluate('document.activeElement?.dataset.ckViewer'), 'info');
    await chrome.until(`document.querySelector('.ck-viewer [data-map="viewer"]')?.dataset.drawn !== undefined`);
    /** @type {string[]} */
    const round = [];
    for (let turn = 0; turn < 16; turn += 1) {
      await chrome.key('Tab');
      round.push(await chrome.evaluate(`document.activeElement?.closest('.maplibregl-ctrl') ? 'credit'
        : document.activeElement?.dataset.ckViewer ?? document.activeElement?.className ?? 'nothing'`));
    }
    drew.infoTabs = round;
    assert.ok(!round.includes('credit'), JSON.stringify(round));
    assert.ok(round.every(stop => stop !== 'nothing'), JSON.stringify(round));
    const credit = await chrome.evaluate(`(() => {
      const details = document.querySelector('.ck-viewer .maplibregl-ctrl-attrib');
      const was = details.hasAttribute('open');
      const kept = details.querySelector('.maplibregl-ctrl-attrib-button').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return { kept, was, now: details.hasAttribute('open') };
    })()`);
    drew.credit = credit;
    assert.ok(credit.kept, 'the press on the credit\'s (i) cancelled');
    assert.notEqual(credit.now, credit.was, 'the credit\'s (i) opened nothing');
    assert.equal(await count('.ck-viewer.is-info'), 1, 'the credit\'s (i) closed the viewer or Info');
    await chrome.key('i');
    await chrome.until(`!document.querySelector('.ck-viewer.is-info')`);

    await chrome.evaluate(`document.querySelector('.ck-viewer').focus()`);
    await waitStill();
    await chrome.key('Shift');
    await chrome.until(`!document.querySelector('.ck-viewer.is-still')`);
    const chips = await boxOf('.ck-viewer__chips');
    const firstChip = await boxOf('.ck-viewer__chip');
    await clickAt(chips.left + 4, chips.top + chips.height / 2);
    assert.ok(chips.left + 4 < firstChip.left, 'the chips\' row has no ground left of its chips');
    assert.equal(await count('.ck-viewer'), 1, 'a click on the chips\' ground closed it');
    await closeViewer();

    front.holdPhoto(H[5]);
    await open([H[5]], 0);
    await chrome.until(`document.querySelector('${SHOWN}.is-loaded') && document.querySelector('.ck-viewer').dataset.facts === 'reading'`);
    await chrome.evaluate(`document.querySelector('.ck-viewer').focus()`);
    await waitStill();
    front.letPhoto(H[5]);
    await drawnWith(factsOf(5).place.name);
    assert.equal(await count('.ck-viewer.is-still'), 1, 'a read landing brought the bar back');
    await closeViewer();

    const missing = `sha256:${'e'.repeat(64)}`;
    await open([missing, H[1]], 0);
    await chrome.until(`document.querySelector('.ck-viewer__failed:not([hidden])')`);
    const failedWords = await boxOf('.ck-viewer__failed');
    await clickAt(failedWords.left + failedWords.width / 2, failedWords.top + failedWords.height / 2);
    assert.equal(await count('.ck-viewer'), 1, 'a click on the failed words closed it');
    await chrome.evaluate(`(async () => {
      const { keepPicture } = await import('/lib/api.js');
      const canvas = Object.assign(document.createElement('canvas'), { width: 64, height: 48 });
      const paint = canvas.getContext('2d'); paint.fillStyle = '#5b8496'; paint.fillRect(0, 0, 64, 48);
      keepPicture(${JSON.stringify(missing)}, await new Promise(done => canvas.toBlob(done)));
    })()`);
    await chrome.key('ArrowRight');
    await drawnWith('Seafront');
    await chrome.key('ArrowLeft');
    await chrome.until(`document.querySelector('${SHOWN}.is-loaded')`);
    assert.equal(await count('.ck-viewer__failed:not([hidden])'), 0);
    await closeViewer();
    await chrome.evaluate(`import('/ui/kit/photo-viewer.js').then(kit => {
      let tries = 0;
      const hashes = ${JSON.stringify([H[0], H[1]])};
      kit.openPhotoViewer({ count: 2, hash: n => {
        if (n === 0 && tries++ === 0) throw new Error('not read');
        return hashes[n];
      } }, 0);
    })`);
    await chrome.until(`document.querySelector('.ck-viewer__failed:not([hidden])')`);
    await chrome.key('ArrowRight');
    await drawnWith('Seafront');
    await chrome.key('ArrowLeft');
    await drawnWith('Climbing Hall');
    assert.equal(await count('.ck-viewer__failed:not([hidden])'), 0);
    await closeViewer();

    await chrome.evaluate(`(() => {
      window.calls = [];
      window.ownFetch = window.fetch;
      window.fetch = (address, init) => { window.calls.push({ address: String(address), signal: init?.signal ?? null }); return window.ownFetch(address, init); };
    })()`);
    front.holdPhoto(H[6]);
    await open([H[6]], 0);
    await chrome.until(`window.calls.some(call => call.address.includes('life/photos'))`);
    await closeViewer();
    assert.equal(await chrome.evaluate(`window.calls.filter(call => call.address.includes('life/photos')).every(call => call.signal?.aborted)`), true,
      'a read under way kept past close');
    await until('the door\'s read let go', () => front.photosLeft.includes(H[6].slice('sha256:'.length)));
    front.letPhoto(H[6]);
    await chrome.evaluate(`import('/ui/kit/photo-viewer.js').then(kit => {
      window.calls = [];
      kit.openPhotoViewer({ count: 1, hash: () => new Promise(done => { window.letHash = () => done(${JSON.stringify(H[4])}); }) }, 0);
    })`);
    await chrome.until(`typeof window.letHash === 'function' && document.querySelector('.ck-viewer')`);
    await closeViewer();
    await chrome.evaluate(`(async () => { window.letHash(); await new Promise(done => setTimeout(done)); })()`);
    assert.deepEqual(await chrome.evaluate(`window.calls.map(call => call.address)`), [], 'a read started after close');
    assert.equal(await count('.ck-viewer'), 0);
    await chrome.evaluate(`window.fetch = window.ownFetch`);

    await open([H[6]], 0);
    await drawnWith('River Flat');
    await chrome.key('i');
    await chrome.until(`document.querySelector('.ck-viewer.is-info [data-part="rows"]')`);
    assert.deepEqual(await infoRows(), [['date', 'Wednesday 8 October 2025', '16:00'], ['camera', 'Photo', 'From your iPhone'],
      ['chat', 'Weekend plans', 'WhatsApp']]);
    await shot('no-camera-no-sender', `document.querySelector('.ck-viewer.is-info [data-part="rows"]')`);
    await chrome.key('i');
    await chrome.until(`!document.querySelector('.ck-viewer.is-info')`);
    await closeViewer();

    await chrome.size(390, 844, 1);
    await open([H[5], H[6]], 0);
    await drawnWith(factsOf(5).place.name);
    const bar = await chrome.evaluate(`(() => {
      const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
      const title = document.querySelector('.ck-viewer__title');
      return { count: box('.ck-viewer__count'), title: box('.ck-viewer__title'), date: box('.ck-viewer__date'),
        tools: box('.ck-viewer__tools'), cut: title.scrollWidth > title.clientWidth,
        ellipsis: getComputedStyle(title).textOverflow };
    })()`);
    drew.longTitle = bar;
    assert.ok(bar.cut && bar.ellipsis === 'ellipsis', 'the long title not cut');
    for (const line of ['title', 'date']) {
      assert.ok(bar[line].left >= bar.count.right, `the ${line} over the count`);
      assert.ok(bar[line].right <= bar.tools.left, `the ${line} over the controls`);
    }
    await shot('long-title-390', `document.querySelector('${SHOWN}.is-loaded')`);
    await closeViewer();

    await open([H[7]], 0);
    await drawnWith('River Flat');
    await chrome.until(`document.querySelectorAll('.ck-viewer__chip').length === 6`);
    const row = await chrome.evaluate(`(() => {
      const row = document.querySelector('.ck-viewer__chips'), all = [...row.querySelectorAll('.ck-viewer__chip')];
      const at = () => ({ row: row.getBoundingClientRect().toJSON(), first: all[0].getBoundingClientRect().toJSON(),
        last: all.at(-1).getBoundingClientRect().toJSON() });
      const start = { scrolls: row.scrollWidth > row.clientWidth, ...at() };
      row.scrollLeft = row.scrollWidth;
      return { start, end: at() };
    })()`);
    drew.chips390 = row;
    assert.ok(row.start.scrolls, 'six chips fit in 390');
    assert.ok(row.start.first.left >= row.start.row.left - 1, 'the first chip out of reach');
    assert.ok(row.end.last.right <= row.end.row.right + 1, 'the last chip out of reach');
    await chrome.evaluate(`document.querySelector('.ck-viewer__chips').scrollLeft = 0`);
    await shot('chips-390', `document.querySelectorAll('.ck-viewer__chip').length === 6`);
    await closeViewer();
    await chrome.size(1440, 900, 1);
  });

  test('V12: a day\'s stay tile and its date link', async () => {
    await chrome.load(`#view=days&on=${home.day}`, WATCH_POLICY + FAST_REST);
    await chrome.until('document.querySelector(".dy-tile.is-failed, .dy-tile img.is-loaded")');
    const tile = await chrome.evaluate(`(() => {
      const tile = document.querySelector('.dy-tile');
      return { block: tile.dataset.dBlock, total: Number(tile.closest('.dy-photos').dataset.total),
        hash: new URL(tile.querySelector('img').dataset.src, location.href).searchParams.get('hash') };
    })()`);
    await click(`.dy-tile[data-d-block="${tile.block}"][data-d-photo="0"]`);
    await chrome.until(`document.querySelector('.ck-viewer')?.dataset.facts === 'read' && document.querySelector('.ck-viewer__failed')`);
    assert.equal(await words('.ck-viewer__count'), tile.total > 1 ? `1 of ${tile.total}` : '');
    const facts = (await (await fetch(`${url}/api/life/photos?${new URLSearchParams({ hash: tile.hash })}`)).json()).photo;
    drew.dayFacts = facts;
    assert.equal(await words('.ck-viewer__title'), await titleOf(facts));
    assert.ok(facts.unit, 'the day\'s photo has no burst');
    const link = facts.place || facts.area ? '.ck-viewer__date' : '.ck-viewer__title';
    const to = await chrome.evaluate(`document.querySelector('${link}').getAttribute('href')`);
    assert.deepEqual([parseRoute(to).view, parseRoute(to).on, parseRoute(to).focus], ['days', home.day, `u:${facts.unit}`]);
    await click(link);
    await chrome.until(`!document.querySelector('.ck-viewer') && location.hash.startsWith(${JSON.stringify(`#view=days&on=${home.day}&focus=`)})`);
  });

  test('V12: a person\'s photos open the viewer at the one pressed, stepping through theirs, and keep the focus it hands back when the People list\'s read lands after', async () => {
    await chrome.load('#view=people&focus=person:person-b', `${WATCH_POLICY}
      window.held = [];
      const own = window.fetch;
      window.fetch = (address, init) => String(address).split('?')[0].endsWith('page/people')
        ? new Promise(go => window.held.push(() => go(own(address, init)))) : own(address, init);`);
    await chrome.until(`document.querySelectorAll('[data-people-photo] img').length === 5 && window.held.length > 0`);
    await click('[data-people-photo="0"]');
    await drawnWith('Climbing Hall');
    assert.equal(await words('.ck-viewer__count'), '1 of 5');
    await chrome.key('ArrowRight');
    await drawnWith('Seafront');
    await closeViewer();
    assert.equal(await chrome.evaluate('document.activeElement?.dataset.peoplePhoto'), '1');
    await chrome.evaluate(`window.before = document.querySelector('[data-people-photo="1"]'); window.held.splice(0).forEach(go => go())`);
    await chrome.until(`document.querySelector('[data-people-photo="1"]') !== window.before`);
    assert.equal(await chrome.evaluate('document.activeElement?.dataset.peoplePhoto'), '1');
  });

  test('M2: loopback and the tile host only, nothing refused, nothing thrown', async () => {
    await suite.askedNoHostButLoopbackAndTiles();
  });
});
