// @ts-check
import assert from 'node:assert/strict';
import { pageHarness } from './page-harness.mjs';
import { placesHome } from './places-home.mjs';

const TILES = 'tiles.openfreemap.org';

export const WATCH_POLICY = `window.refused = [];
document.addEventListener('securitypolicyviolation', event => window.refused.push(event.violatedDirective + ' ' + event.blockedURI));`;

export const LISTED = 'performance.getEntriesByType("resource").filter(entry => entry.name.endsWith("/api/page/places")).length';

export const PLACES_NOW = Date.parse('2026-11-11T13:00:00Z');

export const HILL = 'fixture-hill-studio';
export const HILL_AT = { latitude: 38.7165, longitude: -9.141 };

/** @param {string} id */
export const drawn = id => `document.querySelector('[data-map="${id}"]')?.dataset.drawn`;

/**
 * @param {string} file
 * @param {import('./page-harness.mjs').Seen} seen
 * @param {() => unknown} ending
 * @param {boolean} [mutable]
 */
const placesPage = (file, seen, ending, mutable = false) => pageHarness({ file, seen, ending, mutable,
  front: home => placesHome({ door: { url: home.url }, now: PLACES_NOW }), ahead: front => front.ahead,
  size: { width: 1440, height: 900 }, zone: 'Pacific/Kiritimati' });

/** @param {{ file: string, mutable?: boolean }} options */
export function placesSuite({ file, mutable = false }) {
  /** @type {string[]} */
  const asked = [];
  const seen = { shots: /** @type {string[]} */ ([]), drawn: /** @type {Record<string, string>} */ ({}),
    pages: /** @type {Record<string, unknown>} */ ({}), saved: /** @type {unknown[]} */ ([]),
    hosts: /** @type {string[]} */ ([]), hostAsked: 0, refused: /** @type {string[]} */ ([]), thrown: /** @type {string[]} */ ([]),
    waiting: '' };
  const page = placesPage(file, seen, () => {
    seen.saved = opened?.front.saved ?? [];
    seen.thrown = opened?.chrome.thrown ?? [];
  }, mutable);
  const { click } = page;
  /** @type {Awaited<ReturnType<typeof page.journey>> | undefined} */
  let opened;

  const run = () => /** @type {NonNullable<typeof opened>} */ (opened);
  const browser = () => run().chrome;

  return {
    seen,
    asked,
    shot: page.shot,
    click,
    words: page.words,
    count: page.count,

    async open() {
      (await page.open()).chrome.on('Network.requestWillBeSent', ({ request }) => asked.push(request.url));
    },

    /** @param {string} name */
    async journey(name) {
      opened = await page.journey(name);
      asked.length = 0;
      await opened.chrome.send('Network.enable');
      return opened;
    },

    close: page.close,

    /** @param {string} path */
    times: path => asked.filter(address => address.endsWith(`/api/${path}`)).length,

    unplaced: () => run().front.asked.filter(path => path.startsWith('/v1/extracts?family=physical') || /^\/v1\/labels\?(?:.*&)?point=/u.test(path)),

    /**
     * @param {string} id
     * @param {number} count
     * @param {string} state
     */
    async settled(id, count, state) {
      try {
        await browser().until(`${drawn(id)} === '${count}'`);
      } catch (error) {
        seen.drawn[state] = `not ${count}: drew ${await browser().evaluate(drawn(id))}, gathered ${
          await browser().evaluate(`document.querySelector('[data-map="${id}"]')?.dataset.gathered`)}`;
        throw error;
      }
      seen.drawn[state] = await browser().evaluate(drawn(id));
    },

    /** @param {string} selector */
    rows: selector => browser().evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})]
  .map(row => (row.getAttribute('aria-label') ?? row.textContent).replace(/\\s+/gu, ' ').trim())`),

    /** @param {string} slug */
    async openPlace(slug) {
      await click(`.pl-card [data-pl-open="${slug}"]`);
      await browser().until('document.querySelector(".pl-page") && !document.querySelector(".pl.ck-reading")');
    },

    pageSays: () => browser().evaluate(`(() => {
  const text = selector => document.querySelector(selector)?.innerText.replace(/\\s+/gu, ' ').trim() ?? null;
  const all = selector => [...document.querySelectorAll(selector)].map(each => (each.getAttribute('aria-label')
    ?? each.textContent).replace(/\\s+/gu, ' ').trim());
  return { title: text('.pl-card__title'), line: text('.pl-card__line'), rhythm: text('.pl-rhythm'), ask: text('.pl-ask'),
    labels: all('.pl-page .ck-section__label'), photos: all('.pl-page .ck-photo'), people: all('.pl-page .ck-pchip'),
    visits: all('.pl-page .pl-visits > .pl-visit'), inside: all('.pl-page .ck-lrows .ck-lrow') };
})()`),

    /** @param {number} from */
    statedSince: from => run().front.saved.slice(from),

    /** @param {string} count */
    onCard: count => browser().until(`document.querySelector('.pl-naming__count')?.textContent === ${JSON.stringify(count)}`
      + ' && !document.querySelector(".pl-card .ck-namerow--reading")'),

    async askedNoHostButLoopbackAndTiles() {
      const hosts = [...new Set(asked.filter(address => /^https?:/u.test(address)).map(address => new URL(address).hostname))];
      seen.hosts = hosts;
      seen.hostAsked = asked.filter(address => new URL(address, 'http://x').hostname === TILES).length;
      seen.refused = await browser().evaluate('window.refused');
      assert.deepEqual(hosts.filter(host => host !== '127.0.0.1' && host !== TILES), []);
      assert.ok(seen.hostAsked > 0, 'the page never asked the tile host');
      assert.deepEqual(seen.refused, []);
      assert.deepEqual(browser().thrown, []);
    },
  };
}

export const WATCH_WORK = `window.moveWork = [];
addEventListener('pointermove', () => { window.moveStart = performance.now(); }, true);
addEventListener('pointermove', () => {
  void document.documentElement.offsetHeight;
  window.moveWork.push(performance.now() - window.moveStart);
});`;

/** @param {string} id */
export const frameOf = id => `document.querySelector('[data-map="${id}"]')`;

/** @param {{ file: string }} options */
export function circleSuite({ file }) {
  const seen = { shots: /** @type {string[]} */ ([]), circles: /** @type {Record<string, string>} */ ({}),
    lines: /** @type {Record<string, string>} */ ({}), witnessed: /** @type {Record<string, string>} */ ({}),
    saved: /** @type {unknown[]} */ ([]), work: /** @type {Record<string, unknown>} */ ({}),
    thrown: /** @type {string[]} */ ([]), waiting: '' };
  const page = placesPage(file, seen, () => {
    seen.saved = opened?.front.saved ?? [];
    seen.thrown = opened?.chrome.thrown ?? [];
  });
  /** @type {Awaited<ReturnType<typeof page.journey>> | undefined} */
  let opened;

  const browser = () => /** @type {NonNullable<typeof opened>} */ (opened).chrome;

  /**
   * @param {'mouseMoved' | 'mousePressed' | 'mouseReleased'} type
   * @param {number} x
   * @param {number} y
   * @param {boolean} held
   */
  const mouse = (type, x, y, held) => browser().send('Input.dispatchMouseEvent', { type, x, y,
    button: type === 'mouseMoved' && !held ? 'none' : 'left', buttons: held && type !== 'mouseReleased' ? 1 : 0,
    clickCount: type === 'mouseMoved' ? 0 : 1 });

  return {
    seen,
    shot: page.shot,
    click: page.click,
    words: page.words,
    count: page.count,
    mouse,

    open: page.open,

    /** @param {string} name */
    async journey(name) {
      opened = await page.journey(name);
      return opened;
    },

    close: page.close,

    /**
     * @param {string} id
     * @returns {Promise<{ latitude: number, longitude: number, radius_m: number, said: string }>}
     */
    async circleOf(id) {
      const said = await browser().evaluate(`${frameOf(id)}?.dataset.circle ?? ''`);
      const [latitude, longitude, radius_m] = String(said).split(',').map(Number);
      return { latitude, longitude, radius_m, said };
    },

    /**
     * @param {string} id
     * @param {string} said
     */
    settledOn: (id, said) => browser().until(`${frameOf(id)}?.dataset.circle === ${JSON.stringify(said)}`),

    /**
     * @param {string} selector
     * @returns {Promise<[number, number]>}
     */
    at: selector => browser().evaluate(`(() => { const box = document.querySelector(${JSON.stringify(selector)})
  .getBoundingClientRect(); return [box.x + box.width / 2, box.y + box.height / 2]; })()`),

    /** @param {string} id */
    ringPx: id => browser().evaluate(`Number(${frameOf(id)}.querySelector('.ck-circle__ring').getAttribute('r'))`),

    /**
     * @param {[number, number]} from
     * @param {[number, number]} by
     * @param {{ steps?: number, held?: () => Promise<void> }} [options]
     */
    async drag([x, y], [dx, dy], { steps = 6, held } = {}) {
      await mouse('mouseMoved', x, y, false);
      await mouse('mousePressed', x, y, true);
      for (let step = 1; step <= steps; step += 1) await mouse('mouseMoved', x + (dx * step) / steps, y + (dy * step) / steps, true);
      await held?.();
      await mouse('mouseReleased', x + dx, y + dy, false);
    },

    /**
     * @param {string} key
     * @param {number} [modifiers]
     */
    async key(key, modifiers = 0) {
      const code = { Escape: 27, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, PageUp: 33, PageDown: 34, Home: 36,
        End: 35, Enter: 13 }[key] ?? key.toUpperCase().charCodeAt(0);
      for (const type of ['rawKeyDown', 'keyUp']) {
        await browser().send('Input.dispatchKeyEvent', { type, key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
          windowsVirtualKeyCode: code, modifiers });
      }
    },

    /** @param {string} selector */
    focus: selector => browser().evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`),

    async work() {
      const all = /** @type {number[]} */ (await browser().evaluate('window.moveWork.splice(0)')).sort((a, b) => a - b);
      const centile = (/** @type {number} */ share) => Math.round(all[Math.min(all.length - 1, Math.floor(share * all.length))] * 100) / 100;
      return { moves: all.length, p50: centile(0.5), p95: centile(0.95), most: centile(1) };
    },
  };
}
