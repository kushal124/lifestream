import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageHarness } from './stand-ins/page-harness.mjs';
import { placesHome, FILM_HASHES } from './stand-ins/places-home.mjs';
import { WATCH_POLICY } from './stand-ins/places-page.mjs';
import { RECIPE } from './stand-ins/pictures.mjs';
import { until } from './until.mjs';

const VIDEO_MS = 2_000;
/** @param {string} name */
const fixture = name => JSON.parse(readFileSync(new URL(`../../homelink/Tests/Fixtures/pages/${name}.json`, import.meta.url), 'utf8'));
const FILMS = /** @type {import('../public/pages.js').Day} */ (fixture('day.films'));
const FILMS_MOMENT = /** @type {import('../public/pages.js').Moment} */ (fixture('moment.films'));
const FILMS_FOCUS = [...FILMS.all_day, ...FILMS.plans, ...FILMS.also?.rows ?? [], ...FILMS.chapters.flatMap(chapter => chapter.blocks.flatMap(block => block.rows))]
  .find(row => row.key === FILMS_MOMENT.moment?.row)?.focus;
const seen = { shots: /** @type {string[]} */ ([]), waiting: '', drew: /** @type {Record<string, unknown>} */ ({}),
  asked: /** @type {string[]} */ ([]), thrown: /** @type {string[]} */ ([]) };
/** @type {Awaited<ReturnType<typeof placesHome>> | undefined} */
let stand;
const page = pageHarness({ file: 'video', seen, size: { width: 1200, height: 800 }, narrow: { width: 390, height: 844 },
  zone: 'Pacific/Kiritimati', ending: () => { seen.thrown = opened?.chrome.thrown ?? []; },
  front: async home => {
    stand = await placesHome({ door: { url: home.url }, now: Date.now() });
    return stand;
  } });
/** @type {Awaited<ReturnType<typeof page.journey>> | undefined} */
let opened;
const run = () => /** @type {NonNullable<typeof opened>} */ (opened);
const chrome = () => run().chrome;
const front = () => /** @type {NonNullable<typeof stand>} */ (stand);

const PLAYER = '.ck-viewer__stage video.ck-viewer__video';
const space = async () => {
  await chrome().send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' });
  await chrome().send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
};
const shiftTab = async () => {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await chrome().send('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
  }
};
const enter = async () => {
  await chrome().send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await chrome().send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
};
const press = async (/** @type {string} */ selector) => {
  const [x, y] = await chrome().evaluate(`(() => { const box = document.querySelector(${JSON.stringify(selector)})
    .getBoundingClientRect(); return [box.left + box.width / 2, box.top + box.height / 2]; })()`);
  await chrome().send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await chrome().send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
};
const open = (/** @type {string[]} */ hashes, /** @type {number} */ at) => chrome().evaluate(`import('/ui/kit/photo-viewer.js')
  .then(kit => { kit.openPhotoViewer(${JSON.stringify(hashes)}, ${at}); })`);
const closeViewer = async () => {
  await chrome().press('Escape');
  await chrome().until(`!document.querySelector('.ck-viewer')`);
};
const player = () => chrome().evaluate(`(() => {
  const video = document.querySelector('${PLAYER}');
  if (!video) return null;
  const box = video.getBoundingClientRect();
  return { poster: video.parentElement.querySelector('img.ck-video__still')?.getAttribute('data-src') ?? null, src: video.getAttribute('src'), paused: video.paused, time: video.currentTime,
    muted: video.muted, focused: document.activeElement === video, width: Math.round(box.width), height: Math.round(box.height),
    ratio: video.videoWidth / video.videoHeight };
})()`);
const counted = () => chrome().evaluate(`document.querySelector('.ck-viewer__count')?.textContent ?? ''`);
/** @param {{ hash: string, alt: string, video?: boolean, duration_ms?: number }[]} shown */
const testGallery = shown => chrome().evaluate(`Promise.all([import('/ui/kit/gallery.js'), import('/ui/kit/person-face.js')])
  .then(([kit, faces]) => {
    const holder = document.createElement('div');
    holder.className = 'test-gallery';
    holder.innerHTML = kit.gallery(${JSON.stringify(shown)});
    for (const [name, value] of [['position', 'fixed'], ['left', '16px'], ['top', '16px'], ['width', '360px'], ['z-index', '5']]) {
      holder.style.setProperty(name, value);
    }
    document.body.append(holder);
    faces.watchPictures(holder);
    kit.installGalleries(holder, () => ${JSON.stringify(shown)});
    holder.addEventListener('error', () => { holder.dataset.failed = 'yes'; }, true);
  })`);
/** @param {string} url */
const fetched = url => chrome().evaluate(`performance.getEntriesByType('resource')
  .filter(entry => entry.name === new URL(${JSON.stringify(url)}, location.href).href).length`);
/**
 * @param {string} hash
 * @param {string} size
 */
const pictureAt = (hash, size) => chrome().evaluate(`import('/lib/api.js').then(api => api.pictureUrl(${JSON.stringify(hash)}, ${JSON.stringify(size)}))`);

before(async () => {
  (await page.open()).chrome.on('Network.requestWillBeSent', ({ request }) => seen.asked.push(request.url));
});

after(() => page.close());

describe('recipe', () => {
  before(async () => {
    opened = await page.journey('recipe');
  });

  test('W9: the page draws before its recipe is read; a first read that failed is read again at the feed\'s reset', async () => {
    /** @type {string | null} */
    let held = null;
    let asks = 0;
    let feeds = 0;
    await chrome().send('Fetch.enable', { patterns: [{ urlPattern: '*/api/life/pictures', requestStage: 'Request' },
      { urlPattern: '*/api/feed', requestStage: 'Request' }] });
    chrome().on('Fetch.requestPaused', ({ requestId, request }) => {
      const path = new URL(request.url).pathname;
      if (path === '/api/life/pictures' && (asks += 1) === 1) held = requestId;
      else if (path === '/api/feed' && (feeds += 1) === 1) {
        void chrome().send('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' }).catch(() => undefined);
      } else if (path === '/api/life/pictures' || path === '/api/feed') {
        void chrome().send('Fetch.continueRequest', { requestId }).catch(() => undefined);
      }
    });
    await chrome().load('#view=days', WATCH_POLICY);
    await chrome().until(`document.getElementById('main') && !performance.getEntriesByType('resource')
      .some(entry => entry.name.endsWith('/api/life/pictures'))`, 'the page drawn with its recipe unread');
    assert.ok(held, 'the recipe was asked');
    await chrome().send('Fetch.fulfillRequest', { requestId: held, responseCode: 503,
      responseHeaders: [{ name: 'content-type', value: 'application/json' }],
      body: Buffer.from(JSON.stringify({ error: 'Not now.', code: 'NOT_NOW' })).toString('base64') });
    await chrome().until(`performance.getEntriesByType('resource').some(entry => entry.name.endsWith('/api/life/pictures'))`);
    seen.drew.before = await pictureAt(FILM_HASHES.video, 'tile');
    assert.doesNotMatch(String(seen.drew.before), /recipe=/u, 'a recipe named before one was read');
    await chrome().evaluate(`import('/lib/api.js').then(api => { window.api = api; })`);
    await chrome().until(`window.api.pictureUrl(${JSON.stringify(FILM_HASHES.video)}, 'tile').includes('recipe=${RECIPE}')`,
      'the recipe read again at the feed\'s reset');
    seen.drew.after = await pictureAt(FILM_HASHES.video, 'tile');
  });
});

describe('video', () => {
  before(async () => {
    opened = await page.journey('video');
    await chrome().send('Network.enable');
    await chrome().send('Fetch.enable', { patterns: [{ urlPattern: '*/api/page/*', requestStage: 'Request' }] });
    chrome().on('Fetch.requestPaused', ({ requestId, request }) => {
      const url = new URL(request.url);
      const asked = url.searchParams;
      const answer = asked.get('day') !== FILMS.day ? null : url.pathname === '/api/page/day' ? FILMS
        : url.pathname === '/api/page/moment' && asked.get('focus') === FILMS_FOCUS ? FILMS_MOMENT : null;
      if (!answer) {
        void chrome().send('Fetch.continueRequest', { requestId }).catch(() => undefined);
        return;
      }
      void chrome().send('Fetch.fulfillRequest', { requestId, responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'application/json' }],
        body: Buffer.from(JSON.stringify(answer)).toString('base64') }).catch(() => undefined);
    });
  });

  test('W1 W2 W3 W8: Days draws the video and the Live Photo; the viewer plays the video, its keys its own', async () => {
    await chrome().load(`#view=days&on=${FILMS.day}`, WATCH_POLICY);
    const tile = `.dy-tile[aria-label^="Video, 0:02"]`;
    await chrome().until(`document.querySelector('${tile} .ck-video-mark')`);
    seen.drew.strip = await chrome().evaluate(`[...document.querySelectorAll('.dy-photos .dy-tile')].map(each => each.getAttribute('aria-label'))`);
    assert.ok(/** @type {string[]} */ (seen.drew.strip).some(label => label.startsWith('Live Photo, A chalked hand on a hold.')),
      'the Live Photo\'s tile is not named so');
    assert.ok(/** @type {string[]} */ (seen.drew.strip).every(label => /, \d\d:\d\d, photo \d+ of \d+$/u.test(label)),
      'a strip tile reads the time it was taken before its place in the strip');
    await page.shot('day', `document.querySelector('${tile} img.ck-pic.is-loaded')`);

    await chrome().evaluate(`(() => { const key = document.querySelector('${tile}').dataset.dBlock;
      document.querySelector(\`[data-d-stay="\${key}"][aria-expanded="false"]\`).click(); })()`);
    await chrome().until(`document.querySelector('.dy-w__tile--video[aria-label="Video, 0:02"]')`);
    await page.shot('row', `document.querySelector('.dy-w__tile--video img.ck-pic.is-loaded')`);
    await chrome().evaluate(`document.querySelector('.dy-w__tile--video').closest('button[data-d-row]').click()`);
    await chrome().until(`document.querySelector('.ck-gallery')`);
    const strip = await chrome().evaluate(`[...document.querySelectorAll('.ck-gallery__strip button')].map(each => each.getAttribute('aria-label'))`);
    seen.drew.gallery = strip;
    const at = strip.indexOf(`Video ${strip.findIndex((/** @type {string} */ label) => label.startsWith('Video')) + 1}`);
    assert.ok(at >= 0, 'the gallery holds the video');
    assert.ok(strip.some((/** @type {string} */ label) => label.startsWith('Live Photo ')), 'the gallery\'s Live Photo is not named so');
    assert.ok(await chrome().evaluate(`document.querySelector('[data-ck-gallery-at="${at}"] .ck-video-mark') !== null`),
      'the gallery\'s strip draws the video unmarked');
    await chrome().evaluate(`document.querySelector('[data-ck-gallery-at="${at}"]').click()`);
    await chrome().until(`document.querySelector('.ck-gallery__stage .ck-video-mark__clock')?.textContent === '0:02'`);
    await page.shot('gallery', `document.querySelector('.ck-gallery__stage img.ck-pic.is-loaded')`);

    await press('.ck-gallery__open');
    await chrome().until(`document.querySelector('${PLAYER}')`);
    const shown = await player();
    seen.drew.player = shown;
    assert.equal(shown.src, `/api/life/media?hash=${encodeURIComponent(FILM_HASHES.video)}`);
    assert.equal(shown.poster, `/api/life/picture?${new URLSearchParams({ hash: FILM_HASHES.video, size: 'screen', recipe: String(RECIPE) })}`);
    await chrome().until(`!document.querySelector('${PLAYER}').paused && document.querySelector('${PLAYER}').currentTime > 0`);
    assert.equal((await player()).muted, false, 'the video plays without its sound');
    await chrome().until(`document.querySelector('${PLAYER}').classList.contains('is-sized')`);
    const sized = await player();
    assert.ok(Math.abs(sized.width / sized.height - sized.ratio) < 0.02, `the player's box ${sized.width}×${sized.height}`);
    await chrome().press('i');
    await chrome().until(`document.querySelector('.ck-viewer.is-info')`);
    const playing = await chrome().evaluate(`(() => { const video = document.querySelector('${PLAYER}'); video.dataset.kept = 'yes'; return video.currentTime; })()`);
    await chrome().press('i');
    await chrome().until(`!document.querySelector('.ck-viewer.is-info')`);
    assert.equal(await chrome().evaluate(`document.querySelector('${PLAYER}').dataset.kept`), 'yes', 'a draw made the player again');
    assert.ok((await player()).time >= playing);

    await chrome().evaluate(`document.querySelector('.ck-viewer').focus()`);
    await space();
    await chrome().until(`document.querySelector('${PLAYER}').paused`);
    await space();
    await chrome().until(`!document.querySelector('${PLAYER}').paused`);
    await page.shot('playing', `document.querySelector('${PLAYER}')?.readyState >= 2`);
    const where = await counted();
    await chrome().evaluate(`document.querySelector('${PLAYER}').focus()`);
    await space();
    await chrome().until(`document.querySelector('${PLAYER}').paused`);
    for (const key of ['ArrowRight', 'ArrowLeft', 'End', 'Home']) {
      await chrome().key(key);
      assert.equal(await counted(), where, `${key} in the player stepped the viewer`);
    }
    assert.equal(await chrome().evaluate(`document.querySelector('${PLAYER}').dataset.kept`), 'yes', 'a key in the player made it again');

    await chrome().evaluate(`(() => { window.leaving = document.querySelector('${PLAYER}');
      document.querySelector('.ck-viewer').focus(); })()`);
    await chrome().key('ArrowLeft');
    await chrome().until(`document.querySelector('.ck-live-stage .ck-live')`);
    assert.equal(await chrome().evaluate(`document.querySelector('${PLAYER}')`), null, 'the video\'s player left with it');
    assert.equal(await chrome().evaluate(`[window.leaving.paused, window.leaving.hasAttribute('src'),
      [HTMLMediaElement.NETWORK_EMPTY, HTMLMediaElement.NETWORK_NO_SOURCE].includes(window.leaving.networkState)]`)
      .then(String), 'true,false,true');
    await page.shot('live', `document.querySelector('.ck-live-stage img.ck-pic.is-loaded')`);
    for (let tab = 0; tab < 12 && !(await chrome().evaluate(`document.activeElement?.matches('.ck-live')`)); tab += 1) {
      await chrome().key('Tab');
    }
    assert.ok(await chrome().evaluate(`document.activeElement?.matches('.ck-live')`), 'Tab never reached LIVE');
    await enter();
    await chrome().until(`document.querySelector('.ck-live-stage.is-playing')`);
    const motion = await chrome().evaluate(`(() => { const video = document.querySelector('.ck-live-stage__motion');
      return { muted: video.muted, src: video.getAttribute('src'), pressed: document.querySelector('.ck-live').getAttribute('aria-pressed') }; })()`);
    seen.drew.motion = motion;
    assert.deepEqual(motion, { muted: true, src: `/api/life/media?hash=${encodeURIComponent(FILM_HASHES.motion)}`, pressed: 'true' });
    await page.shot('live-playing', `document.querySelector('.ck-live-stage.is-playing')`);
    await chrome().until(`!document.querySelector('.ck-live-stage.is-playing')`);
    await closeViewer();
  });

  test('W3: Tab goes into the player\'s controls, through them and out, never out of the viewer', async () => {
    await open([FILM_HASHES.video], 0);
    await chrome().until(`document.querySelector('${PLAYER}')?.readyState >= 1`);
    await chrome().evaluate(`document.querySelector('[data-ck-viewer="close"]').focus()`);
    await chrome().key('Tab');
    assert.ok(await chrome().evaluate(`document.activeElement === document.querySelector('${PLAYER}')`), 'Tab never reached the player');
    let inside = 0;
    for (; inside < 12 && await chrome().evaluate(`document.activeElement === document.querySelector('${PLAYER}')`); inside += 1) {
      await chrome().key('Tab');
    }
    seen.drew.tabs = { inside };
    assert.ok(await chrome().evaluate(`document.activeElement?.closest('.ck-viewer') !== null
      && document.activeElement?.matches('[data-ck-viewer]')`), 'Tab past the player left the viewer');
    await shiftTab();
    assert.ok(await chrome().evaluate(`document.activeElement === document.querySelector('${PLAYER}')`), '⇧Tab never reached the player');
    const paused = await chrome().evaluate(`document.querySelector('${PLAYER}').paused`);
    await space();
    await chrome().until(`document.querySelector('${PLAYER}').paused === ${!paused}`, 'Space in the player toggled it once');
    await closeViewer();
  });

  test('W5: a video no browser plays, a poster not made now, the home not answering for a film', async () => {
    front().holdPhoto(FILM_HASHES.unplayable);
    await open([FILM_HASHES.unplayable], 0);
    await chrome().until(`document.querySelector('.ck-viewer__failed:not([hidden])')`);
    front().letPhoto(FILM_HASHES.unplayable);
    await chrome().until(`document.querySelector('.ck-video__said')`);
    seen.drew.cannot = await chrome().evaluate(`document.querySelector('.ck-video__said').textContent`);
    assert.equal(seen.drew.cannot, 'This video can’t play here.Download');
    await page.shot('cannot', `document.querySelector('.ck-video__said')`);
    await closeViewer();

    const unplayable = FILM_HASHES.unplayable.slice('sha256:'.length);
    const asked = () => front().picturesAsked.filter(each => each === unplayable).length;
    const askedBefore = asked();
    await testGallery([{ hash: FILM_HASHES.unplayable, alt: '', video: true }]);
    await chrome().until(`document.querySelector('.test-gallery').dataset.failed === 'yes'`, 'the poster\'s failure reached the gallery');
    assert.equal(asked() - askedBefore, 1, 'a 404 asked again');
    assert.equal(await chrome().evaluate(`(() => { const stage = document.querySelector('.test-gallery .ck-gallery__stage');
      return [stage.classList.contains('is-failed'), getComputedStyle(stage.querySelector('.ck-gallery__open')).display !== 'none',
        stage.querySelector('.ck-video-mark') !== null]; })()`).then(String), 'false,true,true');
    await press('.test-gallery .ck-gallery__open');
    await chrome().until(`document.querySelector('.ck-video__said a')`);
    const href = await chrome().evaluate(`document.querySelector('.ck-video__said a').getAttribute('href')`);
    assert.equal(href, `/api/life/download?hash=${encodeURIComponent(FILM_HASHES.unplayable)}`);
    const got = await chrome().evaluate(`fetch(${JSON.stringify(href)}).then(async answer => ({ status: answer.status,
      type: answer.headers.get('content-type'), disposition: answer.headers.get('content-disposition'),
      sniff: answer.headers.get('x-content-type-options'),
      hex: [...new Uint8Array(await crypto.subtle.digest('SHA-256', await answer.arrayBuffer()))]
        .map(byte => byte.toString(16).padStart(2, '0')).join('') }))`);
    seen.drew.download = got;
    assert.deepEqual(got, { status: 200, type: 'application/octet-stream', disposition: 'attachment', sniff: 'nosniff',
      hex: FILM_HASHES.unplayable.slice('sha256:'.length) });
    await closeViewer();
    await chrome().evaluate(`document.querySelector('.test-gallery').remove()`);

    const away = FILM_HASHES.away.slice('sha256:'.length);
    front().holdPicture(FILM_HASHES.away);
    await testGallery([{ hash: FILM_HASHES.away, alt: '', video: true, duration_ms: VIDEO_MS }]);
    await until('the poster asked', () => front().picturesAsked.includes(away));
    await chrome().evaluate(`document.querySelector('.test-gallery').remove()`);
    await until('the poster\'s request let go', () => front().picturesLeft.includes(away));
    front().letPicture(FILM_HASHES.away);

    front().posterLater(FILM_HASHES.away, true);
    await chrome().evaluate('performance.clearResourceTimings()');
    await testGallery([{ hash: FILM_HASHES.away, alt: '', video: true, duration_ms: VIDEO_MS }]);
    const later = /** @type {string} */ (await pictureAt(FILM_HASHES.away, 'screen'));
    const asks = `performance.getEntriesByType('resource').filter(entry => entry.name === new URL(${JSON.stringify(later)},
      location.href).href)`;
    await chrome().until(`${asks}.length >= 2`, 'the poster asked, and its answer read');
    const [first, second] = /** @type {number[][]} */ (await chrome().evaluate(`${asks}.map(entry => [entry.startTime, entry.responseEnd])`));
    assert.ok(second[0] - first[1] >= 999, `asked again ${Math.round(second[0] - first[1])} ms after the first answer`);
    assert.equal(await chrome().evaluate(`(() => { const gallery = document.querySelector('.test-gallery');
      gallery.querySelector('.ck-gallery__stage img').dataset.kept = 'yes';
      return [gallery.dataset.failed ?? 'no', gallery.querySelector('.ck-gallery__stage').classList.contains('is-failed')]; })()`)
      .then(String), 'no,false');
    front().posterLater(FILM_HASHES.away, false);
    await chrome().until(`document.querySelector('.test-gallery .ck-gallery__stage img.ck-pic.is-loaded')?.dataset.kept === 'yes'`,
      'the poster asked again in place');
    seen.drew.posterAsks = await fetched(later);
    await chrome().evaluate(`document.querySelector('.test-gallery').remove()`);

    front().failFile(FILM_HASHES.away, true);
    await open([FILM_HASHES.away, FILM_HASHES.video], 0);
    await chrome().until(`document.querySelector('.ck-video__said .ck-lack')`);
    seen.drew.reach = await chrome().evaluate(`document.querySelector('.ck-video__said').textContent`);
    assert.match(String(seen.drew.reach), /This video can’t play right now\./u);
    await page.shot('reach', `document.querySelector('.ck-video__said .ck-lack')`);
    front().failFile(FILM_HASHES.away, false);
    await chrome().evaluate(`document.querySelector('.ck-viewer').focus()`);
    await chrome().key('ArrowRight');
    await chrome().until(`document.querySelector('${PLAYER}')?.getAttribute('src')?.includes(${JSON.stringify(encodeURIComponent(FILM_HASHES.video))})`);
    await chrome().key('ArrowLeft');
    await chrome().until(`document.querySelector('${PLAYER}')?.readyState >= 1`);
    await closeViewer();

    front().failFile(FILM_HASHES.motionAway, true);
    await open([FILM_HASHES.liveAway, FILM_HASHES.video], 0);
    await chrome().until(`document.querySelector('.ck-live-stage') && document.querySelector('.ck-video__said .ck-lack')`,
      'the motion\'s failure said');
    assert.equal(await chrome().evaluate(`document.querySelector('.ck-live')`), null, 'LIVE over a motion that failed');
    seen.drew.liveReach = await chrome().evaluate(`document.querySelector('.ck-video__said').textContent`);
    assert.match(String(seen.drew.liveReach), /This video can’t play right now\./u);
    await page.shot('live-reach', `document.querySelector('.ck-live-stage img.ck-pic.is-loaded')`);
    front().failFile(FILM_HASHES.motionAway, false);
    await chrome().evaluate(`document.querySelector('.ck-viewer').focus()`);
    await chrome().key('ArrowRight');
    await chrome().until(`document.querySelector('${PLAYER}')`);
    await chrome().key('ArrowLeft');
    await chrome().until(`document.querySelector('.ck-live-stage .ck-live') && !document.querySelector('.ck-video__said')
      && document.querySelector('.ck-live-stage img.ck-pic.is-loaded')`);
    await press('.ck-live');
    await chrome().until(`document.querySelector('.ck-live-stage.is-playing')`, 'the motion played once the home answered');
    await closeViewer();
  });

  test('W6 W7: a thread\'s video opens the viewer; every picture by the home\'s recipe, an editor\'s at full', async () => {
    await chrome().evaluate(`Promise.all([import('/ui/kit/thread.js'), import('/ui/kit/gallery.js')]).then(([kit, gallery]) => {
      const holder = document.createElement('div');
      holder.className = 'test-thread';
      holder.innerHTML = kit.thread([{ n: 1, at: 0, clock: '09:14', speaker: 'Person A', mine: false, words: '',
        video: { hash: ${JSON.stringify(FILM_HASHES.video)} } }]);
      for (const [name, value] of [['position', 'fixed'], ['left', '16px'], ['top', '16px'], ['width', '320px'], ['z-index', '5']]) {
        holder.style.setProperty(name, value);
      }
      document.body.append(holder);
      gallery.installGalleries(holder, thread => [...thread.querySelectorAll('.ck-msg__shot')].map(shot => ({ hash: shot.dataset.ckHash, alt: '' })));
    })`);
    assert.equal(await chrome().evaluate(`document.querySelectorAll('.test-thread video').length`), 0, 'a video plays in its bubble');
    assert.equal(await chrome().evaluate(`document.querySelector('.test-thread .ck-video-tile').getAttribute('aria-label')`), 'Video');
    await press('.test-thread .ck-video-tile');
    await chrome().until(`document.querySelector('${PLAYER}')?.getAttribute('src')?.includes(${JSON.stringify(encodeURIComponent(FILM_HASHES.video))})`);
    await closeViewer();
    await chrome().evaluate(`document.querySelector('.test-thread').remove()`);

    const peek = await chrome().evaluate(`import('/ui/people/naming.js').then(kit => kit.namingPeek({ hash: ${JSON.stringify(FILM_HASHES.live)},
      face: 'face', words: '' }))`);
    assert.match(peek, new RegExp(`size=full&amp;recipe=${RECIPE}`, 'u'));
    const pictures = seen.asked.filter(address => new URL(address).pathname === '/api/life/picture');
    assert.ok(pictures.length > 0);
    assert.deepEqual(pictures.filter(address => new URL(address).searchParams.get('recipe') !== String(RECIPE)), []);
    assert.deepEqual(pictures.filter(address => new URL(address).searchParams.get('size') === 'original'), []);
    assert.deepEqual(chrome().thrown, []);
  });
});
