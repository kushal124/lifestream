// @ts-check
import { randomUUID } from 'node:crypto';
import { hostScript } from './onboarding-home.mjs';
import { pageHarness } from './page-harness.mjs';
import { peopleHome } from './people-home.mjs';
import { until } from '../until.mjs';

export const A = 'phone:+15550000001';
export const OWN = 'phone:+15550000009';
export const WIDTHS = /** @type {const} */ ([[1440, 900], [390, 844]]);
export const JSON_ANSWER = `(body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))`;
/** @param {string} words */
export const shows = words => `document.body.innerText.includes(${JSON.stringify(words)})`;
/** @param {string} name */
export const carding = name => `document.querySelector('.pp-hero__name')?.textContent === ${JSON.stringify(name)} && document.querySelector('.pp-panel [data-o-field="name"]')`;

/** @param {{ file: string, faces?: boolean }} options */
export function peoplePage({ file, faces = true }) {
  const seen = /** @type {{ shots: string[], acts: unknown[], waiting: string, persons: unknown[], faces: unknown[] } & Record<string, unknown>} */ (
    { shots: [], acts: [], waiting: '', persons: [], faces: [] });
  const page = pageHarness({ file, seen, args: faces ? ['faces'] : [], token: faces ? 'dashboard' : 'reader',
    size: { width: WIDTHS[0][0], height: WIDTHS[0][1] }, narrow: { width: WIDTHS[1][0], height: WIDTHS[1][1] },
    zone: 'Pacific/Kiritimati',
    front: faces
      ? home => peopleHome({ door: { url: home.url, token: home.tokens.dashboard }, people: String(home.faces?.people_source) })
      : async home => ({ url: home.url, landings: () => 0, landing: async () => undefined, close: async () => undefined }),
    ending: faces ? async () => {
      const end = opened ? await held().catch(() => null) : null;
      if (end) {
        seen.persons = [...end.persons].map(([key, content]) => ({ key, content }));
        seen.faces = [...end.faces].map(([key, content]) => ({ key, content }));
      }
    } : undefined });
  /** @type {Awaited<ReturnType<typeof page.journey>> | undefined} */
  let opened;

  const run = () => /** @type {NonNullable<typeof opened>} */ (opened);
  const browser = () => run().chrome;

  /**
   * @param {string} path
   * @param {Record<string, string>} [params]
   */
  async function fromDoor(path, params = {}) {
    const { home } = run();
    const query = new URLSearchParams(params).toString();
    const response = await fetch(`${home.url}${path}${query ? `?${query}` : ''}`, { headers: { authorization: `Bearer ${home.tokens.dashboard}` } });
    if (response.status !== 200) throw new Error(`${path}: ${response.status}`);
    return response.json();
  }

  const held = async () => {
    const source = String(run().home.faces?.people_source);
    const of = async (/** @type {string} */ kind, /** @type {Record<string, string>} */ more = {}) => new Map((await fromDoor('/v1/records',
      { source, kind, ...more })).records.map((/** @type {any} */ record) => [record.key, record.content]));
    return { persons: await of('person'), faces: await of('face', { limit: '1024' }), photos: await of('photo'), details: await of('details') };
  };

  const landed = () => run().front.landings();
  /** @param {number} count */
  async function landedPast(count) {
    await run().front.landing(count);
    await page.command('settle');
  }

  const ONCE = { connection: 'close' };
  /** @param {string} path */
  const dashboard = async path => (await fetch(`${run().url}${path}`, { headers: ONCE })).json();
  /** @param {Record<string, unknown>} action */
  const act = action => fetch(`${run().url}/api/owner/act`, { method: 'POST', body: JSON.stringify({ of: 'people', request: randomUUID(), ...action }),
    headers: { 'content-type': 'application/json', 'x-viewer-request': '1', ...ONCE } });

  /** @param {string} key */
  async function stroke(key) {
    const virtual = /** @type {Record<string, number>} */ ({ Backspace: 8, Enter: 13, Escape: 27, PageUp: 33, PageDown: 34,
      ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 })[key];
    for (const type of ['rawKeyDown', 'keyUp']) await browser().send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: virtual });
  }

  /** @param {string} answer */
  const stub = answer => browser().evaluate(`(() => {
  const real = window.realFetch ??= window.fetch.bind(window);
  window.fetch = (input, init) => (${answer})(String(input), init, real);
})()`);
  const capture = () => stub(`(url, init, real) => {
  const answer = real(url, init);
  if (url === 'api/owner/act') answer.then(response => response.clone().json()).then(body => (window.answered ??= []).push(body));
  return answer;
}`);
  /** @param {{ act: string }} [given] */
  async function undoLast(given) {
    const [last] = given ? [given] : (await browser().evaluate('window.answered ?? []')).slice(-1);
    const undoing = landed();
    const undone = await act({ kind: 'undo', act: last.act });
    if (undone.status !== 200) throw new Error(`undo: ${undone.status} ${await undone.text()}`);
    await landedPast(undoing);
  }
  /** @param {string} selector */
  const centreOf = selector => browser().evaluate(`(() => {
  const image = document.querySelector(${JSON.stringify(selector)});
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const drawn = canvas.getContext('2d');
  drawn.drawImage(image, 0, 0);
  return [...drawn.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data].slice(0, 3);
})()`);
  /** @param {string} hash */
  async function blobOf(hash) {
    const { home } = run();
    const response = await fetch(`${home.url}/v1/blobs/${hash}`, { headers: { authorization: `Bearer ${home.tokens.dashboard}` } });
    if (response.status !== 200) throw new Error(`/v1/blobs/${hash}: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  const namedA = () => until('Person A named on their faces', async () =>
    (await dashboard('/api/life/people/photos?id=person%3Aperson-a')).photos?.some((/** @type {any} */ each) => each.crop) || undefined);

  return {
    seen,
    get out() {
      return page.out;
    },
    command: page.command,
    shot: page.shot,
    click: page.click,
    fromDoor,
    held,
    landed,
    landedPast,
    dashboard,
    act,
    stroke,

    async open() {
      opened = await page.open();
      return opened;
    },

    /** @param {string} name */
    async journey(name) {
      opened = await page.journey(name);
      return opened;
    },

    close: page.close,

    /**
     * @param {string} hash
     * @param {unknown} host
     */
    load: (hash, host) => browser().load(hash, host === null ? '' : hostScript(host)),

    /** @param {string} selector */
    text: selector => browser().evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map(each => each.textContent.trim().replace(/\\s+/g, ' '))`),
    /**
     * @param {string} selector
     * @param {string} name
     */
    attr: (selector, name) => browser().evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map(each => each.getAttribute(${JSON.stringify(name)}))`),
    /** @returns {Promise<any[]>} */
    async acts() {
      const posted = await browser().evaluate('window.hostActs.splice(0)');
      seen.acts.push(...posted);
      return posted.map((/** @type {any} */ { type: _, ...act }) => act);
    },
    /** @param {string} hash */
    go: hash => browser().evaluate(`location.hash = ${JSON.stringify(hash)}`),
    stub,
    capture,
    undoLast,
    centreOf,
    blobOf,
    boxes: () => browser().evaluate(`JSON.stringify([...document.querySelectorAll('.pp-panel__top, .pp-hero, .pp-panel [data-row], .pp-foot')]
  .map(el => { const box = el.getBoundingClientRect(); return [el.dataset.row ?? el.className, Math.round(box.top), Math.round(box.left), Math.round(box.width), Math.round(box.height)]; }))`),
    /**
     * @param {string} selector
     * @param {string} words
     */
    fill: (selector, words) => browser().type(selector, words),
    async enter() {
      await browser().send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
      await browser().send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    },
    async undoKey() {
      for (const type of ['rawKeyDown', 'keyUp']) await browser().send('Input.dispatchKeyEvent', { type, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 4 });
    },
    deckNow: () => dashboard('/api/faces'),
    /**
     * @param {string} id
     * @returns {Promise<string[]>}
     */
    facesOfGroup: async id => (await dashboard(`/api/faces/group?id=${encodeURIComponent(id)}`)).every,

    async organisedA() {
      const { groups } = await until('the face group the deck offers Person A', async () => {
        const read = await dashboard(`/api/faces/likely?id=${encodeURIComponent(A)}`);
        return read.groups?.length === 1 ? read : undefined;
      });
      const before = landed();
      const answer = await act({ kind: 'confirm', id: A, accept: [], decline: [], groups: [groups[0].id] });
      if (answer.status !== 200) throw new Error(`Person A's Confirm: ${answer.status} ${await answer.text()}`);
      await landedPast(before);
      await namedA();
    },

    namedA,
  };
}
