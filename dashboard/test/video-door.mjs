// @ts-check
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as forward } from 'node:http';
import { pageHarness } from './stand-ins/page-harness.mjs';
import { until } from './until.mjs';

const seen = { shots: /** @type {string[]} */ ([]), waiting: '', drew: /** @type {Record<string, unknown>} */ ({}),
  asked: /** @type {string[]} */ ([]) };
const SAID_AGAIN = 'a synthetic picture, said again';

/** @param {{ url: string, day: string }} home */
async function sayingFront(home) {
  const door = new URL(home.url);
  /** @type {Set<import('node:http').ServerResponse>} */
  const feeds = new Set();
  let last = '0:0';
  let again = false;

  /** @param {import('node:http').IncomingMessage} request @param {import('node:http').ServerResponse} response */
  const readAgain = async (request, response) => {
    const answer = await fetch(new URL(request.url ?? '', door), { headers: { authorization: String(request.headers.authorization) } });
    const said = /** @type {{ moment: { pictures: { video: boolean }[] } | null }} */ (await answer.json());
    const moment = said.moment && { ...said.moment, pictures: said.moment.pictures.map(picture => picture.video ? picture
      : { ...picture, alt: SAID_AGAIN, words: SAID_AGAIN }) };
    response.writeHead(200, { 'content-type': 'application/json', etag: '"said-again"' });
    response.end(JSON.stringify({ ...said, moment }));
  };

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '', door).pathname;
    if (again && path === '/v1/page/moment') {
      readAgain(request, response).catch(() => response.destroy());
      return;
    }
    const passed = forward(new URL(request.url ?? '', door), { method: request.method, headers: { ...request.headers, host: door.host } }, answer => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      if (path === '/v1/feed') {
        feeds.add(response);
        response.on('close', () => {
          feeds.delete(response);
          passed.destroy();
        });
        answer.on('data', chunk => { last = [...String(chunk).matchAll(/^id: (.*)$/gmu)].at(-1)?.[1] ?? last; });
      }
      answer.pipe(response);
    });
    passed.on('error', () => response.destroy());
    request.pipe(passed);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  return {
    url: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`,
    followers: () => feeds.size,
    sayAgain() {
      again = true;
      const [seq, at_ms] = last.split(':').map(Number);
      for (const feed of feeds) feed.write(`id: ${last}\nevent: reset\ndata: ${JSON.stringify({ seq, at_ms })}\n\n`);
    },
    async close() {
      server.closeAllConnections();
      await new Promise(done => server.close(() => done(undefined)));
    },
  };
}

/** @type {'door' | 'saying'} */
let scene = 'door';
const page = pageHarness({ file: 'video-door', seen, script: 'video-home.ts', size: { width: 1200, height: 800 }, zone: 'UTC',
  front: async home => scene === 'saying' ? sayingFront(home) : { url: home.url, close: async () => undefined } });
/** @type {Awaited<ReturnType<typeof page.journey>> | undefined} */
let opened;
const run = () => /** @type {NonNullable<typeof opened>} */ (opened);
const chrome = () => run().chrome;

const PLAYER = '.ck-viewer__stage video.ck-viewer__video';
const press = async (/** @type {string} */ selector) => {
  const [x, y] = await chrome().evaluate(`(() => { const box = document.querySelector(${JSON.stringify(selector)})
    .getBoundingClientRect(); return [box.left + box.width / 2, box.top + box.height / 2]; })()`);
  await chrome().send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await chrome().send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
};
const photos = () => /** @type {Record<'live' | 'video' | 'pair' | 'mp4', { image: string, motion: string | null }>} */ (
  /** @type {any} */ (run().home).photos);

let feeds = 0;
before(async () => {
  const { chrome } = await page.open();
  chrome.on('Network.requestWillBeSent', ({ request }) => seen.asked.push(request.url));
  chrome.on('Network.responseReceived', ({ response }) => {
    if (new URL(response.url).pathname === '/api/feed') feeds += 1;
  });
});

after(() => page.close());

describe('video-door', () => {
  before(async () => {
    opened = await page.journey('video-door');
    await chrome().send('Network.enable');
  });

  test('D1 D2 D3: the home\'s day draws its videos; the viewer plays the phone\'s video and the Live Photo\'s motion', async () => {
    await chrome().load(`#view=days&on=${run().home.day}`);
    await chrome().until(`document.querySelectorAll('.dy-w__tile--video').length === 2`);
    seen.drew.tiles = await chrome().evaluate(`[...document.querySelectorAll('.dy-w__tile')].map(each => each.getAttribute('aria-label'))`);
    await page.shot('day', `[...document.querySelectorAll('img.ck-pic')].every(each => each.classList.contains('is-loaded'))`);

    const { live, video } = photos();
    await chrome().evaluate(`document.querySelector('.dy-w__tile--video').closest('button[data-d-row]').click()`);
    await chrome().until(`document.querySelector('.ck-gallery')`);
    const strip = await chrome().evaluate(`[...document.querySelectorAll('.ck-gallery__strip button')].map(each => each.getAttribute('aria-label'))`);
    seen.drew.gallery = strip;
    const at = strip.findIndex((/** @type {string} */ label) => label.startsWith('Video'));
    assert.ok(at >= 0, 'the gallery holds the video');
    await chrome().evaluate(`document.querySelector('[data-ck-gallery-at="${at}"]').click()`);
    await chrome().until(`document.querySelector('.ck-gallery__stage .ck-video-mark')`);
    await press('.ck-gallery__open');
    await chrome().until(`document.querySelector('${PLAYER}')`);
    const recipe = (await (await fetch(`${run().home.url}/v1/pictures`, { headers: { authorization: `Bearer ${run().home.tokens.reader}` } })).json()).recipe;
    const player = await chrome().evaluate(`(() => { const video = document.querySelector('${PLAYER}');
      return { poster: video.parentElement.querySelector('img.ck-video__still')?.getAttribute('data-src') ?? null,
        src: video.getAttribute('src') }; })()`);
    seen.drew.player = player;
    assert.deepEqual(player, {
      poster: `/api/life/picture?${new URLSearchParams({ hash: video.image, size: 'screen', recipe: String(recipe) })}`,
      src: `/api/life/media?hash=${encodeURIComponent(video.image)}`,
    });
    await chrome().until(`(() => { const video = document.querySelector('${PLAYER}'); return video === null || video.error !== null || (video.readyState >= 2 && (video.currentTime > 0 || video.ended)); })()`);
    seen.drew.played = await chrome().evaluate(`(() => { const video = document.querySelector('${PLAYER}');
      return video === null ? { stage: document.querySelector('.ck-viewer__stage')?.textContent ?? '' }
        : { error: video.error?.code ?? null, message: video.error?.message ?? '', width: video.videoWidth, height: video.videoHeight, duration: video.duration, time: video.currentTime }; })()`);
    assert.deepEqual(seen.drew.played && { error: /** @type {any} */ (seen.drew.played).error, width: /** @type {any} */ (seen.drew.played).width, height: /** @type {any} */ (seen.drew.played).height },
      { error: null, width: 480, height: 640 }, 'the phone\'s video plays, upright');
    await page.shot('video', `document.querySelector('${PLAYER}').readyState >= 2`);

    await chrome().evaluate(`document.querySelector('.ck-viewer').focus()`);
    await chrome().key('ArrowLeft');
    await chrome().until(`document.querySelector('.ck-live-stage .ck-live')`);
    await page.shot('live', `document.querySelector('.ck-live-stage img.ck-pic.is-loaded')`);
    await chrome().evaluate(`document.querySelector('.ck-live').focus()`);
    await chrome().send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await chrome().send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await chrome().until(`document.querySelector('.ck-live-stage.is-playing')`);
    const motion = await chrome().evaluate(`(() => { const video = document.querySelector('.ck-live-stage__motion');
      return { muted: video.muted, src: video.getAttribute('src') }; })()`);
    seen.drew.motion = motion;
    assert.deepEqual(motion, { muted: true, src: `/api/life/media?hash=${encodeURIComponent(/** @type {string} */ (live.motion))}` });
    await chrome().until(`document.querySelector('.ck-live-stage__motion').currentTime > 0 || !document.querySelector('.ck-live-stage.is-playing')`);
    await page.shot('live-playing', 'true');
  });
});

describe('video-door-said-again', () => {
  before(async () => {
    scene = 'saying';
    opened = await page.journey('video-door-said-again');
    await chrome().send('Network.enable');
  });

  test('D4: the open moment read again with its pictures\' words changed keeps the picture its gallery was on', async () => {
    const front = /** @type {Awaited<ReturnType<typeof sayingFront>>} */ (/** @type {unknown} */ (run().front));
    feeds = 0;
    await chrome().load(`#view=days&on=${run().home.day}`);
    await chrome().until(`document.querySelectorAll('.dy-w__tile--video').length === 2`);
    await until('the page following the feed, and the dashboard the door\'s', () => feeds > 0 && front.followers() > 0);
    await chrome().evaluate(`document.querySelector('.dy-w__tile--video').closest('button[data-d-row]').click()`);
    await chrome().until(`document.querySelector('.ck-inspector__body [data-ck-gallery]')`);
    const strip = await chrome().evaluate(`[...document.querySelectorAll('.ck-gallery__strip button')].map(each => each.getAttribute('aria-label'))`);
    seen.drew.gallery = strip;
    const at = strip.findLastIndex((/** @type {string} */ label) => !label.startsWith('Video'));
    assert.ok(!strip[0].startsWith('Video') && at > 0, 'the gallery holds still pictures first and after its first');
    await chrome().evaluate(`document.querySelector('[data-ck-gallery-at="${at}"]').click()`);
    await chrome().until(`document.querySelector('[data-ck-gallery]').dataset.ckGallery === '${at}'`);
    const stage = `document.querySelector('.ck-gallery__stage img.ck-pic').getAttribute('data-src')`;
    const picture = await chrome().evaluate(stage);

    front.sayAgain();
    await chrome().until(`document.querySelector('[data-ck-gallery] .ck-gallery__words')?.textContent === ${JSON.stringify(SAID_AGAIN)}`);
    const drawn = await chrome().evaluate(`(() => { const holder = document.querySelector('[data-ck-gallery]');
      return { at: holder.dataset.ckGallery, words: holder.querySelector('.ck-gallery__words').textContent,
        count: holder.querySelector('.ck-gallery__count').textContent }; })()`);
    seen.drew.again = drawn;
    assert.deepEqual(drawn, { at: String(at), words: SAID_AGAIN, count: `${at + 1} of ${strip.length}` });
    assert.equal(await chrome().evaluate(stage), picture);
    await page.shot('said-again', `[...document.querySelectorAll('.ck-gallery__stage img.ck-pic')].every(each => each.classList.contains('is-loaded'))`);
  });
});
