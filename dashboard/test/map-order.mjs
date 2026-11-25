import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createViewer } from '../server.mjs';
import { atExit, openChrome } from '../tools/chrome.mjs';

const OUT = fileURLToPath(new URL('../.build/e2e/map-order/', import.meta.url));
/** @type {Record<string, unknown>} */
const seen = {};
/** @type {string} */
let dir;
/** @type {Awaited<ReturnType<typeof createViewer>>} */
let viewer;
/** @type {Awaited<ReturnType<typeof openChrome>>} */
let chrome;

function keep() {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'map-order.json'), `${JSON.stringify({ seen, waiting: chrome?.waiting ?? '', thrown: chrome?.thrown }, null, 2)}\n`);
}
const kept = atExit(keep);

const WATCH = `(() => {
  const real = window.fetch.bind(window);
  let release = () => undefined;
  const held = new Promise(done => { release = () => done(undefined); });
  window.glyphs = { asked: false };
  window.letGlyphs = () => release();
  window.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.endsWith('/256-511.pbf')) return real(input, init);
    window.glyphs.asked = true;
    return held.then(() => real(input, init));
  };
  const tiles = window.tiles = { sent: 0, answered: 0, out: new Map(), data: new Set() };
  const post = Worker.prototype.postMessage;
  const heard = new WeakSet();
  Worker.prototype.postMessage = function (message, ...rest) {
    if (!heard.has(this)) {
      heard.add(this);
      this.addEventListener('message', event => {
        const id = event.data?.id;
        tiles.out.delete(id);
        if (tiles.data.delete(id)) tiles.answered += 1;
      });
    }
    if (message?.data?.source === 'life') {
      if (message.type === 'LD') {
        tiles.sent += 1;
        tiles.data.add(message.id);
      } else if (message.type === 'LT' || message.type === 'RT') tiles.out.set(message.id, tiles.sent);
    }
    return post.call(this, message, ...rest);
  };
})()`;

const ONE = { latitude: 38.7100, longitude: -9.1500 };
const TWO = { latitude: 38.7200, longitude: -9.1300 };
/** @param {string} key @param {{ latitude: number, longitude: number }} at */
const spot = (key, at) => ({ key, kind: 'spot', ...at, weight: 0, name: '' });
/**
 * @param {object[]} marks
 * @param {object[]} lit
 */
const view = (marks, lit) => JSON.stringify({ order: { frame: 'order', fit: [ONE, TWO], around: 200, marks, here: null,
  focus: null, lit } });
const DRAWN = 'document.querySelector("[data-map=order]").dataset.drawn';

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dashboard-map-order-'));
  viewer = await createViewer({ key: null });
  await new Promise(done => viewer.listen(0, '127.0.0.1', () => done(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (viewer.address());
  chrome = await openChrome({ profile: join(dir, 'chrome'), origin: `http://127.0.0.1:${address.port}` });
});

after(async () => {
  kept();
  keep();
  await chrome?.close();
  viewer?.closeAllConnections();
  await new Promise(done => viewer ? viewer.close(() => done(undefined)) : done(undefined));
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('a tile answered late for the layer written before never stays drawn over the layer written last', async () => {
  await chrome.size(800, 600, 1);
  await chrome.load('map-order', WATCH);
  await chrome.until('document.readyState === "complete"');
  await chrome.evaluate(`(async () => {
    document.head.innerHTML = '<link rel="stylesheet" href="/cockpit.css"><link rel="stylesheet" href="/kit.css">';
    await Promise.all([...document.querySelectorAll('link')].map(link => new Promise(done => {
      link.addEventListener('load', done, { once: true });
      link.addEventListener('error', done, { once: true });
    })));
    const { installMaps, mapFrame } = await import('/ui/kit/map.js');
    document.body.innerHTML = mapFrame('order', 'Order');
    document.querySelector('[data-map=order]').style.cssText = 'position: relative; width: 640px; height: 480px';
    window.maps = installMaps(document.body, { open: () => undefined });
    window.maps.settle(${view([spot('spot:two', TWO)], [])});
  })()`);
  await chrome.until(`${DRAWN} === '1'`, 'the first layer drawn');
  const sent = await chrome.evaluate('tiles.sent');
  await chrome.evaluate(`window.maps.settle(${view([spot('spot:one', ONE), spot('spot:two', TWO)], [{ ...ONE, name: 'Ōne' }])});
    window.maps.settle(${view([spot('spot:two', TWO)], [])})`);
  await chrome.until(`glyphs.asked && tiles.answered >= ${sent + 2} && tiles.out.size > 0
    && [...tiles.out.values()].every(at => at <= ${sent + 1})`, 'the second layer answered before the first');
  seen.before = await chrome.evaluate(`({ drawn: ${DRAWN}, out: [...tiles.out.values()] })`);
  await chrome.evaluate(`delete document.querySelector("[data-map=order]").dataset.drawn; letGlyphs()`);
  await chrome.until(`tiles.out.size === 0 && ${DRAWN} !== undefined`, 'the map settled with every tile answered');
  seen.after = await chrome.evaluate(`({ drawn: ${DRAWN}, gathered: document.querySelector("[data-map=order]").dataset.gathered })`);
  assert.equal(await chrome.evaluate(DRAWN), '1', 'the map draws the one ring written last, not the layer written before');
});
