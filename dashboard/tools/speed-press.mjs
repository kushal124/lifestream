// @ts-check
import { createServer, request, Agent } from 'node:http';

const HOVER_MS = 120;
const KEY_MS = 110;
const DROP_MS = 25;
const IDLE_MS = 20_000;
const WHEEL = { dy: -90, times: 90, everyMs: 16 };
const KEYS = { Escape: { text: '\u001b', code: 53 } };
const WORDS = { search: 'the morning', people: 'an', places: 'ca', streams: 'ma' };
const SECTIONS = [['chat', 'ask'], ['days', 'days'], ['people', 'people'], ['places', 'places'], ['streams', 'connectors']];
const row = (/** @type {string} */ view) => `document.querySelector('.sidebar__item[href="#view=${view}"]')`;
const SEARCH_ROW = `document.getElementById('sidebar-search')`;
const READY = 'speed.ready()';
const NOT_IN_SEARCH = `!location.hash.includes('view=search')`;
const nth = (/** @type {string} */ selector, /** @type {string} */ keep = 'true', at = 0) => `[...document.querySelectorAll(${JSON.stringify(selector)})]
  .filter(each => !each.closest('.main__section[hidden]') && each.getClientRects().length).filter(each => ${keep})[${at}]`;
const PERSON_ROW = `each => !/^(organise|faces|chat:)/u.test(each.dataset.person)`;
const panelOpen = `Boolean(document.querySelector('.main__section:not([hidden]) .ck-panel.is-open .ck-inspector')) && !document.querySelector('.main__section:not([hidden]) .ck-panel.is-open .ck-reading, .main__section:not([hidden]) .ck-panel.is-open .ck-sk')`;
const panelShut = `!document.querySelector('.main__section:not([hidden]) .ck-panel.is-open')`;
const menuOpen = `Boolean(document.querySelector('.main__section:not([hidden]) :is(.ck-fmenu__btn, .dy-title)[aria-expanded="true"]'))`;
const menuShut = `!document.querySelector('.main__section:not([hidden]) :is(.ck-fmenu__btn, .dy-title)[aria-expanded="true"]')`;
const dialogOpen = `Boolean(document.querySelector('#dialog-layer .ck-dialog')) && !document.querySelector('#dialog-layer .ck-reading, #dialog-layer .ck-sk')`;
const dialogShut = `!document.querySelector('#dialog-layer .ck-dialog')`;
const viewerOpen = `Boolean(document.querySelector('.ck-viewer__stage'))`;
const viewerPicture = `[...document.querySelectorAll('.ck-viewer img')].some(each => each.complete && each.naturalWidth > 0)`;
const viewerShut = `!document.querySelector('.ck-viewer')`;
const MAP_DRAWN = `[...document.querySelectorAll('.main__section:not([hidden]) [data-map]')].some(each => each.dataset.drawn !== undefined)`;
const J = JSON.stringify;

/**
 * @typedef {object} Driver
 * @property {(url: string) => Promise<unknown>} open
 * @property {(expression: string) => Promise<any>} run
 * @property {(command: object) => Promise<any>} act
 */

/**
 * @param {Driver} page
 * @param {string} url
 * @param {number} reps
 * @param {(line: string) => void} say
 * @param {string[]} only
 * @param {number} deadline
 */
export async function pressPlan(page, url, reps, say, only, deadline) {
  /** @type {any[]} */
  const samples = [];
  /** @type {any[]} */
  const loads = [];
  /** @type {any[]} */
  const scrolls = [];
  /** @type {any[]} */
  const usage = [];
  /** @type {Map<string, number>} */
  const missing = new Map();
  const miss = (/** @type {string} */ name, /** @type {string} */ why) => missing.set(`${name}: ${why}`, (missing.get(`${name}: ${why}`) ?? 0) + 1);
  const wait = (/** @type {number} */ ms) => new Promise(done => setTimeout(done, ms));
  const inTime = () => {
    if (Date.now() > deadline) throw new Error('out of time');
  };
  /**
   * @param {string} name
   * @param {() => Promise<unknown>} run
   */
  const part = async (name, run) => {
    if (only.length && !only.some(each => name.startsWith(each))) return;
    say(`  ${name}`);
    try {
      inTime();
      await run();
    } catch (error) {
      miss(`part: ${name}`, /** @type {Error} */ (error).message === 'out of time' ? 'cut, the run\'s time was up' : 'failed');
    }
  };
  /** @type {string} */
  let at = '';
  const held = { person: '', place: '' };

  /**
   * @param {string} name
   * @param {string} target
   * @param {string} done
   * @param {{ temp?: string, marks?: Record<string, string>, most?: number, before?: string }} [options]
   */
  async function press(name, target, done, { temp = 'warm', marks = {}, most = 10_000, before = '' } = {}) {
    inTime();
    const aim = await page.run(`speed.aim(() => ${target})`);
    if (!aim?.x) {
      miss(name, aim?.covered ? `covered by ${aim.covered}` : 'nothing to press');
      say(`    ${name}: not pressed`);
      return null;
    }
    await page.act({ cmd: 'move', ...aim });
    await page.run(`void (${target})?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))`);
    await wait(HOVER_MS);
    if (before) await page.run(`void (${before})`);
    const named = Object.entries(marks).map(([mark, test]) => `${J(mark)}: () => ${test}`).join(', ');
    await page.run(`speed.arm(${J(name)}, () => ${done}, { most: ${most}, marks: { ${named} } })`);
    await page.act({ cmd: 'press', ...aim });
    const result = await page.run('speed.outcome()');
    if (result.unheard) miss(name, 'the press was not heard');
    else samples.push({ temp, ...result });
    if (result.timedOut) miss(name, `no result in ${most} ms`);
    say(`    ${name}: ${result.unheard ? 'not heard' : result.timedOut ? 'timed out' : `${Math.round(result.result)} ms`}`);
    await page.run('speed.calm()');
    return result;
  }

  /**
   * @param {string} name
   * @param {keyof typeof KEYS} key
   * @param {string} done
   * @param {{ temp?: string }} [options]
   */
  async function key(name, key, done, { temp = 'warm' } = {}) {
    inTime();
    await page.run(`speed.arm(${J(name)}, () => ${done}, { on: 'keydown', most: 3000 })`);
    await page.act({ cmd: 'key', ...KEYS[key] });
    const result = await page.run('speed.outcome()');
    if (result.unheard) miss(name, 'the key was not heard');
    else samples.push({ temp, ...result });
    if (result.timedOut) miss(name, 'no result in 3000 ms');
    await page.run('speed.calm()');
    return result;
  }

  /** @param {string} view */
  async function to(view) {
    inTime();
    if (at === view) return true;
    const aim = await page.run(`speed.aim(() => ${view === 'search' ? SEARCH_ROW : row(view)})`);
    if (!aim?.x) {
      miss(`to ${view}`, aim?.covered ? `covered by ${aim.covered}` : 'nothing to press');
      return false;
    }
    await page.run(`speed.arm('to', () => ${view === 'search' ? `location.hash.includes('view=search')` : `${READY} && ${NOT_IN_SEARCH}`})`);
    await page.act({ cmd: 'press', ...aim });
    await page.run('speed.outcome()');
    await page.run('speed.calm()');
    at = view;
    return true;
  }

  /**
   * @param {string} name
   * @param {string} view
   * @param {string} temp
   */
  async function section(name, view, temp) {
    const marks = view === 'places' ? { map: MAP_DRAWN } : {};
    await press(`open ${name}`, row(view), `${READY} && location.hash.includes('view=${view}')`, { temp, marks });
    at = view;
  }

  /**
   * @param {number} rep
   * @param {string} temp
   */
  async function details(rep, temp) {
    await to('people');
    const person = await press('open a person', nth('#main [data-person]', PERSON_ROW, rep),
      `${READY} && Boolean(document.querySelector('.main__section:not([hidden]) .pp-head'))`, { temp });
    if (person) held.person = await page.run('location.hash');
    await press('back to People', nth('#main .ck-page__back'), `${READY} && Boolean(${nth('#main [data-person]', PERSON_ROW)})`, { temp });
    await to('places');
    const place = await press('open a place', nth('#main .ck-lrow[data-pl-open]', 'true', rep),
      `${READY} && Boolean(document.querySelector('.main__section:not([hidden]) .pl-page'))`, { temp });
    if (place) held.place = await page.run('location.hash');
    await press('back to Places', nth('#main [data-pl-back]'), `${READY} && Boolean(${nth('#main .ck-lrow[data-pl-open]')})`, { temp });
  }

  async function switches() {
    const views = [...SECTIONS.map(([, view]) => view), 'search'];
    const left = new Set(views.flatMap(one => views.filter(other => other !== one).map(other => `${one}>${other}`)));
    while (left.size) {
      const next = [...left].find(pair => pair.startsWith(`${at}>`));
      if (!next) {
        const from = [...left][0].split('>')[0];
        if (!await to(from)) for (const pair of [...left]) if (pair.startsWith(`${from}>`)) left.delete(pair);
        continue;
      }
      left.delete(next);
      const view = next.split('>')[1];
      const done = view === 'search' ? `location.hash.includes('view=search') && ${READY}` : `${READY} && location.hash.includes('view=${view}')`;
      await press(`switch ${next}`, view === 'search' ? SEARCH_ROW : row(view), done);
      at = view;
    }
  }

  /** @param {string} temp */
  async function panels(temp) {
    await to('days');
    const opened = `document.querySelectorAll('.main__section:not([hidden]) [data-d-stay][aria-expanded="true"]').length`;
    await press('fold: open a stay', nth('#main [data-d-stay][aria-expanded="false"]'), `${opened} > window.speedWas`, { temp, before: `window.speedWas = ${opened}` });
    const moment = await press('panel: open a moment', nth('#main [data-d-row]'), panelOpen, { temp });
    if (moment) await key('panel: close a moment (Esc)', 'Escape', panelShut, { temp });
    await press('panel: open a moment again', nth('#main [data-d-row]'), panelOpen, { temp });
    await press('panel: close a moment (its close)', nth('.ck-panel.is-open .ck-inspector__close'), panelShut, { temp });
    await press('fold: close a stay', nth('#main [data-d-stay][aria-expanded="true"]'), `${opened} < window.speedWas`, { temp, before: `window.speedWas = ${opened}` });
    await press('menu: open the month picker', nth('#main [data-d-title]'), menuOpen, { temp });
    await key('menu: close the month picker (Esc)', 'Escape', menuShut, { temp });
    const photo = await press('viewer: open a photo from a day', nth('#main [data-d-photo]'), viewerOpen, { temp,
      marks: { picture: viewerPicture } });
    if (photo) {
      await key('viewer: close (Esc)', 'Escape', viewerShut, { temp });
      if (await page.run(`Boolean(document.querySelector('.ck-viewer'))`)) await page.act({ cmd: 'key', ...KEYS.Escape });
    }

    await to('people');
    await press('view: Groups', nth('#main [data-people-seg="groups"]'), `${READY} && Boolean(${nth('#main [data-person^="chat:"]')})`, { temp });
    await press('view: People', nth('#main [data-people-seg=""]'), `${READY} && Boolean(${nth('#main [data-person]', PERSON_ROW)})`, { temp });
    await press('open Faces', nth('#main [data-person="faces"]'), `${READY} && Boolean(document.querySelector('.main__section:not([hidden]) .pp-faces'))`, { temp });
    await press('back from Faces', nth('#main .ck-page__back'), `${READY} && Boolean(${nth('#main [data-person]', PERSON_ROW)})`, { temp });
    await press('panel: open Organise', nth('#main [data-person="organise"]'), `${READY} && location.hash.includes('organise')`, { temp });
    await key('panel: close Organise (Esc)', 'Escape', `!location.hash.includes('organise')`, { temp });
    if (held.person) {
      await press('open a person', nth('#main [data-person]', PERSON_ROW),
        `${READY} && Boolean(document.querySelector('.main__section:not([hidden]) .pp-head'))`, { temp });
      await press('panel: open their last conversation', nth('#main [data-people-open]'), panelOpen, { temp });
      await key('panel: close their last conversation (Esc)', 'Escape', panelShut, { temp });
      const shown = await press('viewer: open a photo of them', nth('#main [data-people-photo]'), viewerOpen, { temp });
      if (shown) {
        await key('viewer: close (Esc)', 'Escape', viewerShut, { temp });
        if (await page.run(`Boolean(document.querySelector('.ck-viewer'))`)) await page.act({ cmd: 'key', ...KEYS.Escape });
      }
      await press('panel: open Edit', nth('#main [data-people-edit="open"]'), `Boolean(document.querySelector('.main__section:not([hidden]) .pp-window__in'))`, { temp });
      await key('panel: close Edit (Esc)', 'Escape', `!document.querySelector('.main__section:not([hidden]) .pp-window__in')`, { temp });
      await press('back to People', nth('#main .ck-page__back'), `${READY} && Boolean(${nth('#main [data-person]', PERSON_ROW)})`, { temp });
    }

    await to('places');
    await press('view: Cities', nth('#main [data-pl-seg="cities"]'), READY, { temp });
    await press('view: Trips', nth('#main [data-pl-seg="trips"]'), READY, { temp });
    await press('view: Places', nth('#main [data-pl-seg=""]'), `${READY} && Boolean(${nth('#main .ck-lrow[data-pl-open]')})`, { temp });
    await press('open a place', nth('#main .ck-lrow[data-pl-open]'), `${READY} && Boolean(document.querySelector('.main__section:not([hidden]) .pl-page'))`, { temp });
    const edit = await press('panel: open a place\'s Edit', nth('#main [data-pl-edit]'), `Boolean(document.getElementById('pl-edit'))`, { temp });
    if (edit) await key('panel: close a place\'s Edit (Esc)', 'Escape', `!document.getElementById('pl-edit')`, { temp });
    const placed = await press('viewer: open a photo of a place', nth('#main [data-pl-photo]'), viewerOpen, { temp });
    if (placed) {
      await key('viewer: close (Esc)', 'Escape', viewerShut, { temp });
      if (await page.run(`Boolean(document.querySelector('.ck-viewer'))`)) await page.act({ cmd: 'key', ...KEYS.Escape });
    }
    await press('back to Places', nth('#main [data-pl-back]'), `${READY} && Boolean(${nth('#main .ck-lrow[data-pl-open]')})`, { temp });

    await to('connectors');
    const dialog = await press('dialog: open a stream', nth('#main [data-cn-open]'), dialogOpen, { temp });
    if (dialog) await key('dialog: close a stream (Esc)', 'Escape', dialogShut, { temp });
    await press('dialog: open a stream again', nth('#main [data-cn-open]'), dialogOpen, { temp });
    await press('dialog: close a stream (its close)', nth('#dialog-layer [data-cn-close]'), dialogShut, { temp });
    await press('menu: open Streams\' filter', nth('#main .ck-page__bar .ck-fmenu__btn'), menuOpen, { temp });
    await key('menu: close Streams\' filter (Esc)', 'Escape', menuShut, { temp });

    await to('ask');
    await press('open the conversations', nth('#main [data-ask-action="chats"]'), `document.querySelector('#ak-chats.is-open') !== null`, { temp });
    await press('open a conversation', nth('#ak-chats [data-ask-chat]'), `${READY} && Boolean(document.querySelector('.main__section:not([hidden]) .ck-ask-thread'))`, { temp });
    await press('leave a conversation (New conversation)', nth('#main .ak-bar [data-ask-action="new"]'), `!document.querySelector('.main__section:not([hidden]) .ck-ask-thread')`, { temp });
  }

  async function dayToDay() {
    await to('days');
    const arrow = (/** @type {number} */ side) => nth('#main .dy-bar .ck-page__tools [data-d-day]', 'true', side);
    for (const [name, side, temp] of /** @type {const} */ ([['day: the day before', 0, 'cold'], ['day: the day after', 1, 'warm']])) {
      for (let step = 0; step < 6; step += 1) {
        const title = `document.querySelector('.main__section:not([hidden]) [data-d-title]')?.getAttribute('aria-label')`;
        await press(name, arrow(side), `${READY} && ${title} !== window.speedWas`, { temp, before: `window.speedWas = ${title}` });
      }
    }
  }

  async function typing(/** @type {string} */ name, /** @type {string} */ view, /** @type {string} */ selector, /** @type {string} */ words, /** @type {string} */ shown) {
    await to(view);
    const field = nth(selector);
    const aim = await page.run(`speed.aim(() => ${field})`);
    if (!aim?.x) return miss(`type: ${name}`, aim?.covered ? `covered by ${aim.covered}` : 'no field');
    await page.act({ cmd: 'press', ...aim });
    await page.run('speed.calm()');
    const value = `(${field})?.value.length`;
    const was = await page.run(value) ?? 0;
    for (let at = 0; at < words.length; at += 1) {
      const last = at === words.length - 1;
      const length = was + at + 1;
      await page.run(`speed.arm(${J(last ? `type: ${name}, the last key to its results` : `type: ${name}, a key`)}, () => ${value} >= ${length}${last ? ` && ${shown}` : ''}, { on: 'keydown', most: 8000 })`);
      await page.act({ cmd: 'key', text: words[at], code: 0 });
      const result = await page.run('speed.outcome()');
      if (result.unheard) miss(`type: ${name}`, 'the key was not heard');
      else samples.push({ temp: 'warm', ...result });
      if (!last) await wait(KEY_MS);
    }
    await page.run('speed.calm()');
    await page.run(`(() => { const field = ${field}; if (field) { field.value = ''; field.dispatchEvent(new InputEvent('input', { bubbles: true })); } })()`);
    await page.run('speed.calm()');
  }

  /** @param {string} name */
  async function scroll(name) {
    const where = await page.run('speed.scrollerAt()');
    if (!where) return miss(`scroll: ${name}`, 'no scroller');
    await page.run('speed.framesStart()');
    await page.act({ cmd: 'wheel', ...where, ...WHEEL });
    await wait(100);
    scrolls.push({ name, ...await page.run(`speed.framesEnd(${DROP_MS})`) });
    await page.run('speed.calm()');
  }

  async function scrollLists() {
    for (const [name, view] of [['People', 'people'], ['Places', 'places'], ['Days, every stay open', 'days'], ['Streams', 'connectors'], ['Chat', 'ask']]) {
      await to(view);
      if (view === 'days') {
        await page.run(`[...document.querySelectorAll('.main__section:not([hidden]) [data-d-stay][aria-expanded="false"]')].forEach(each => each.click())`);
        await page.run('speed.calm()');
      }
      await scroll(name);
    }
    await to('search');
    const field = nth('#main .sx-input');
    const aim = await page.run(`speed.aim(() => ${field})`);
    if (!aim?.x) return miss('scroll: Search', 'no field');
    await page.act({ cmd: 'press', ...aim });
    for (const letter of WORDS.search.slice(0, 3)) await page.act({ cmd: 'key', text: letter, code: 0 });
    await page.run('speed.calm(400)');
    await scroll('Search, its hits');
  }

  const fresh = async (/** @type {string} */ hash) => {
    await page.open(`${url}/${hash}`);
    return page.run('speed.opened()');
  };

  for (let rep = 0; rep < reps; rep += 1) {
    say(`session ${rep + 1} of ${reps}`);
    const opened = await fresh('#view=ask');
    loads.push({ name: 'load Chat', ...opened });
    await page.run('speed.quiet()');
    await page.run('speed.calm()');
    at = 'ask';
    const start = await page.act({ cmd: 'usage' });
    for (const temp of ['cold', 'warm']) {
      await part(`pages, ${temp}`, async () => {
        for (const [name, view] of SECTIONS.slice(1)) await section(name, view, temp);
        await press('open Search', SEARCH_ROW, `location.hash.includes('view=search') && ${READY}`, { temp });
        at = 'search';
        await section('Chat', 'ask', temp);
        await details(rep, temp);
      });
    }
    await part('switches', switches);
    await part('panels, cold', () => panels('cold'));
    await part('panels, warm', () => panels('warm'));
    await part('day to day', dayToDay);
    await part('typing', async () => {
      await typing('Search', 'search', '#main .sx-input', WORDS.search, `${READY} && Boolean(document.querySelector('.main__section:not([hidden]) [data-search-row], .main__section:not([hidden]) .sx-list'))`);
      await typing('People', 'people', '#main [data-people-find]', WORDS.people, READY);
      await typing('Places', 'places', '#main [data-pl-find]', WORDS.places, READY);
      await typing('Streams', 'connectors', '#main .ck-page__bar input', WORDS.streams, READY);
    });
    await part('scrolling', scrollLists);
    const end = await page.act({ cmd: 'usage' });
    await part('left alone', async () => {
      await to('days');
      await wait(2_000);
      const from = await page.act({ cmd: 'usage' });
      const asked = await page.run('speed.readsSoFar()');
      const leftAt = await page.run('performance.now()');
      await wait(IDLE_MS);
      const rested = await page.act({ cmd: 'usage' });
      usage.push({ rep, elements: await page.run('speed.nodes()'), footprintMB: Math.round(rested.footprint / 1e6), sessionCpuS: (end.cpuNs - start.cpuNs) / 1e9,
        idleCpuPercent: (rested.cpuNs - from.cpuNs) / (IDLE_MS * 1e6) * 100, idleReads: await page.run('speed.readsSoFar()') - asked,
        idleKinds: await page.run(`speed.readsSince(${leftAt})`), idleFeed: await page.run(`speed.feedSince(${leftAt})`) });
    });
  }
  await part('each page loaded afresh', async () => {
    for (let rep = 0; rep < reps; rep += 1) {
      for (const [name, hash] of [['Days', '#view=days'], ['People', '#view=people'], ['Places', '#view=places'], ['Streams', '#view=connectors'],
        ['Search', '#view=search'], ['a person', held.person], ['a place', held.place]]) {
        inTime();
        if (hash) loads.push({ name: `load ${name}`, ...await fresh(hash) });
        else miss(`load ${name}`, 'not opened in the sessions');
      }
    }
  });
  return { samples, loads, scrolls, usage, missing: [...missing].map(([what, times]) => ({ what, times })) };
}

/** @param {URL} url */
function routeOf(url) {
  const path = url.pathname;
  if (!path.startsWith('/api/')) return `file ${/\.[a-z0-9]+$/u.exec(path)?.[0] ?? '/'}`;
  const words = path.split('/').filter(Boolean).filter(part => /^[a-z-]{1,24}$/u.test(part));
  const names = [...new Set(url.searchParams.keys())].filter(name => /^[a-z_]{1,16}$/u.test(name)).sort();
  return `/${words.join('/')}${names.length ? `?${names.join('&')}` : ''}`;
}

/** @param {{ api: number, files: number }} ports */
export async function openGate({ api, files }) {
  const agent = new Agent({ keepAlive: true, maxSockets: 64 });
  /** @type {Map<string, { n: number, first: number[], bytes: number[], statuses: Record<string, number> }>} */
  const routes = new Map();
  /** @type {Map<string, number>} */
  const refused = new Map();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://gate');
    const route = routeOf(url);
    if (req.method !== 'GET') {
      refused.set(`${req.method} ${route}`, (refused.get(`${req.method} ${route}`) ?? 0) + 1);
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end('{"error":"This run only reads."}');
      return;
    }
    const port = url.pathname.startsWith('/api/') ? api : files;
    const began = performance.now();
    const headers = { ...req.headers, host: `127.0.0.1:${port}` };
    if (headers.origin) headers.origin = `http://127.0.0.1:${port}`;
    if (headers.referer) headers.referer = `http://127.0.0.1:${port}/`;
    const asked = request({ host: '127.0.0.1', port, path: req.url, method: 'GET', agent, headers }, answer => {
      const first = performance.now() - began;
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      let bytes = 0;
      answer.on('data', chunk => {
        bytes += chunk.length;
      });
      answer.pipe(res);
      answer.on('end', () => {
        const held = routes.get(route) ?? { n: 0, first: [], bytes: [], statuses: {} };
        held.n += 1;
        held.first.push(first);
        held.bytes.push(bytes);
        const status = String(answer.statusCode);
        held.statuses[status] = (held.statuses[status] ?? 0) + 1;
        routes.set(route, held);
      });
    });
    asked.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end('{"error":"Not answered."}');
    });
    res.on('close', () => asked.destroy());
    asked.end();
  });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  return {
    url: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`,
    told: () => ({ routes: [...routes].map(([route, held]) => ({ route, n: held.n, statuses: held.statuses,
      firstByte: spread(held.first), bytes: spread(held.bytes) })).sort((one, other) => (other.firstByte?.worst ?? 0) - (one.firstByte?.worst ?? 0)),
    refused: [...refused].map(([what, times]) => ({ what, times })) }),
    close: async () => {
      server.closeAllConnections();
      await new Promise(done => server.close(() => done(undefined)));
      agent.destroy();
    },
  };
}

/** @param {(number | null | undefined)[]} values */
export function spread(values) {
  const sorted = /** @type {number[]} */ (values.filter(value => typeof value === 'number')).sort((one, other) => one - other);
  if (!sorted.length) return null;
  return { n: sorted.length, median: sorted[Math.floor((sorted.length - 1) / 2)], worst: sorted[sorted.length - 1] };
}

const ms = (/** @type {number | null | undefined} */ value) => typeof value !== 'number' ? '–' : value >= 100 ? String(Math.round(value)) : value.toFixed(1);
const pair = (/** @type {{ median: number, worst: number } | null} */ value) => value ? `${ms(value.median)} / ${ms(value.worst)}` : '–';

/** @param {any[]} samples */
export function interactions(samples) {
  /** @type {Map<string, any[]>} */
  const groups = new Map();
  for (const sample of samples) groups.set(`${sample.name}|${sample.temp}`, [...groups.get(`${sample.name}|${sample.temp}`) ?? [], sample]);
  const all = samples.filter(each => each.name.startsWith('switch '));
  if (all.length) groups.set('switch (every pair)|warm', all);
  return [...groups].map(([key, group]) => {
    const [name, temp] = key.split('|');
    return { name, temp, n: group.length, timedOut: group.filter(each => each.timedOut).length,
      input: spread(group.map(each => each.input)), first: spread(group.map(each => each.first)), result: spread(group.map(each => each.result)),
      rest: spread(group.map(each => each.rest)), longest: spread(group.map(each => each.longest)),
      reads: spread(group.map(each => each.reads)), readMs: spread(group.map(each => each.readMs)),
      flash: group.filter(each => each.flash).length, map: spread(group.map(each => each.at?.map)) };
  }).sort((one, other) => (other.result?.median ?? Infinity) - (one.result?.median ?? Infinity));
}

/** @param {{ label: string, where: string, reps: number, noisy: boolean, machine: object, run: any, gate: any }} told */
export function summary({ label, where, reps, noisy, machine, run, gate }) {
  /** @type {Map<string, any[]>} */
  const loads = new Map();
  for (const load of run.loads) loads.set(load.name, [...loads.get(load.name) ?? [], load]);
  const load = [...loads].map(([name, group]) => ({ name, n: group.length, ...Object.fromEntries(['firstContent', 'frame', 'ready', 'evaluate',
    'scriptsEnd', 'stylesEnd', 'scripts', 'styles', 'rounds', 'scriptBytes', 'styleBytes'].map(key => [key, spread(group.map(each => each[key]))])) }));
  return { label, where, reps, noisy, machine, interactions: interactions(run.samples), load, scrolls: run.scrolls, usage: run.usage, missing: run.missing, gate };
}

/** @param {any[]} scrolls */
function frameRate(scrolls) {
  const rate = spread(scrolls.map(each => each.frames / (each.ms / 1000)));
  return rate ? `about ${Math.round(rate.median)} a second` : 'not measured';
}

/**
 * @param {any} now
 * @param {any} [before]
 */
export function report(now, before) {
  const was = new Map((before?.interactions ?? []).map((/** @type {any} */ each) => [`${each.name}|${each.temp}`, each]));
  const lines = [`# Press to frame: ${now.label}`, '',
    `Real events in the Mac app's WebKit (a 1440×900 window on this Mac), over ${now.where}. ${now.reps} sessions.`
    + `${now.noisy ? ' **NOISY: other work shared this Mac, so read the shape, not the digits.**' : ''}`,
    `Load at the start ${now.machine.loadStart}, at the end ${now.machine.loadEnd}, ${now.machine.cores} cores, slots held: ${now.machine.slots}.`
    + `${now.machine.seen ? '' : ' Its window ended covered or on another Space.'} Frame rate while scrolling: ${frameRate(now.scrolls)}.`, '',
    'Times in ms as median / worst, from the press. `first`: the first frame with anything changed; `result`: the frame showing what was asked; `rest`: nothing '
    + 'moving; `input`: press to the page hearing it; `gap`: the longest wait between two frames; `reads`: reads begun before the result, and when the last ended. '
    + 'A frame is timed to the end of its rendering on the page\'s thread; the screen shows it at its next refresh, up to one more frame. '
    + 'WebKit tells no parse time: `evaluate` is the last script\'s arrival to the first frame drawn, its parse and evaluation.', ''];
  const drawn = spread(now.scrolls.map((/** @type {any} */ each) => each.frames / (each.ms / 1000)));
  if (drawn && drawn.median < 50) {
    lines.push(`**THROTTLED: this run drew about ${Math.round(drawn.median)} frames a second where WebKit draws 60. Every time here that waits on a frame is `
      + 'inflated: run it again before comparing it with anything.**', '');
  }
  if (now.missing.length) lines.push('**Not measured:**', '', ...now.missing.map((/** @type {any} */ each) => `- ${each.what} (${each.times}×)`), '');
  lines.push(`| interaction | temp | result | first | rest | input | gap | reads | read ms | flash | n |${before ? ' was | × |' : ''}`,
    `|---|---|---|---|---|---|---|---|---|---|---|${before ? '---|---|' : ''}`);
  for (const each of now.interactions) {
    const old = /** @type {any} */ (was.get(`${each.name}|${each.temp}`));
    const times = old?.result && each.result ? old.result.median / each.result.median : null;
    lines.push(`| ${each.name} | ${each.temp} | ${pair(each.result)}${each.timedOut ? ` (${each.timedOut} timed out)` : ''} | ${pair(each.first)} | ${pair(each.rest)} | ${pair(each.input)} | `
      + `${pair(each.longest)} | ${each.reads?.median ?? '–'} | ${pair(each.readMs)} | ${each.flash}/${each.n} | ${each.n} |`
      + `${before ? ` ${old?.result ? ms(old.result.median) : '–'} | ${times === null ? '–' : `${times.toFixed(1)}×`} |` : ''}`);
  }
  if (before) {
    const both = now.interactions.flatMap((/** @type {any} */ each) => {
      const old = /** @type {any} */ (was.get(`${each.name}|${each.temp}`));
      return old?.result?.median && each.result?.median ? [old.result.median / each.result.median] : [];
    }).sort((/** @type {number} */ one, /** @type {number} */ other) => one - other);
    lines.push('', `Against ${before.label}: ${both.length} interactions, median ${both[Math.floor(both.length / 2)]?.toFixed(1) ?? '–'}× faster, `
      + `${both.filter((/** @type {number} */ each) => each >= 10).length} at 10× or more.`);
  }
  lines.push('', '| a page loaded afresh | first content | sidebar and page drawn | ready | scripts arrived | evaluate | scripts | styles | rounds | script KB | style KB | n |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const each of now.load) {
    lines.push(`| ${each.name} | ${pair(each.firstContent)} | ${pair(each.frame)} | ${pair(each.ready)} | ${pair(each.scriptsEnd)} | ${pair(each.evaluate)} | `
      + `${each.scripts?.median ?? '–'} | ${each.styles?.median ?? '–'} | ${each.rounds?.median ?? '–'} | ${each.scriptBytes ? Math.round(each.scriptBytes.median / 1000) : '–'} | `
      + `${each.styleBytes ? Math.round(each.styleBytes.median / 1000) : '–'} | ${each.n} |`);
  }
  lines.push('', '| a list scrolled by the wheel | frames | a second | moved px | list px | dropped (>25 ms) | hangs (≥250 ms) | longest gap |', '|---|---|---|---|---|---|---|---|');
  for (const each of now.scrolls) {
    lines.push(`| ${each.name} | ${each.frames} | ${each.ms ? Math.round(each.frames / (each.ms / 1000)) : '–'} | ${Math.round(each.moved)} | ${each.height} | ${each.drops} | ${each.hangs} | ${ms(each.longest)} |`);
  }
  lines.push('', `| session | web process MB | elements, every section kept | CPU s in the session | CPU % left alone | reads left alone (${IDLE_MS / 1000} s) |`, '|---|---|---|---|---|---|');
  for (const each of now.usage) lines.push(`| ${each.rep + 1} | ${each.footprintMB} | ${each.elements} | ${each.sessionCpuS.toFixed(1)} | ${each.idleCpuPercent.toFixed(1)} | ${each.idleReads ?? '–'} |`);
  if (now.gate) {
    lines.push('', '| what the page read | n | first byte ms | KB | status |', '|---|---|---|---|---|');
    for (const each of now.gate.routes) {
      lines.push(`| \`${each.route}\` | ${each.n} | ${pair(each.firstByte)} | ${each.bytes ? `${Math.round(each.bytes.median / 1000)} / ${Math.round(each.bytes.worst / 1000)}` : '–'} | `
        + `${Object.entries(each.statuses).map(([status, times]) => `${status}×${times}`).join(' ')} |`);
    }
    lines.push('', now.gate.refused.length ? `**The gate refused:** ${now.gate.refused.map((/** @type {any} */ each) => `${each.what} (${each.times}×)`).join(', ')}.`
      : 'The gate refused nothing: the page asked only to read.');
  }
  return `${lines.join('\n')}\n`;
}
