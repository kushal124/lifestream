import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { followDoor, feedOut } from './door-feed.mjs';
import { pageHarness } from './page-harness.mjs';
import { clockFor } from './clock.mjs';
import { until } from '../until.mjs';
import { installClock } from '../../public/lib/home-clock.js';

/** @typedef {import('../../public/pages.js').Day} Day */
/** @typedef {import('../../public/pages.js').Days} Days */
/** @typedef {import('../../public/pages.js').Thread} Thread */
/** @typedef {import('../../public/pages.js').Moment} Moment */
/** @typedef {import('../../public/pages.js').WrittenDay} WrittenDay */
/** @typedef {'past' | 'today' | 'turned' | 'empty' | 'nothing' | 'midnight' | 'groups' | 'placeless' | 'side' | 'unnamed' | 'travel' | 'brief'} DayCase */

const PAGES = new URL('../../../homelink/Tests/Fixtures/pages/', import.meta.url);

/** @param {string} name */
const fixture = name => JSON.parse(readFileSync(new URL(`${name}.json`, PAGES), 'utf8'));

/** @type {DayCase[]} */
const CASES = ['past', 'today', 'turned', 'empty', 'nothing', 'midnight', 'groups', 'placeless', 'side', 'unnamed', 'travel', 'brief'];
export const DAYS = /** @type {Days} */ (fixture('days.full'));
export const PAGE = /** @type {Record<DayCase, Day>} */ (Object.fromEntries(CASES.map(name => [name, fixture(`day.${name}`)])));
export const THREAD = /** @type {Thread} */ (fixture('thread.full'));
export const MOMENTS = /** @type {Record<string, Moment>} */ (Object.fromEntries(readdirSync(PAGES)
  .flatMap(name => /^moment\.(.+)\.json$/u.exec(name)?.slice(1, 2) ?? []).map(name => [name, fixture(`moment.${name}`)])));

export const PAST = PAGE.past.day;
export const TODAY = PAGE.today.day;
export const EMPTY = PAGE.empty.day;
export const NOTHING = PAGE.nothing.day;
export const MIDNIGHT = PAGE.midnight.day;
export const GROUPS = PAGE.groups.day;
export const PLACELESS = PAGE.placeless.day;
export const SIDE = PAGE.side.day;
export const UNNAMED = PAGE.unnamed.day;
export const TRAVEL = PAGE.travel.day;
export const BRIEF = PAGE.brief.day;
export const FIXTURE_MS = Number(PAGE.past.position.split(':')[1]);
export const WHOLE = '?limit=1024';

export const HOME_DAY = '2026-09-28';
export const CHAT_A = '15550000001@s.whatsapp.net';

/** @type {DayCase[]} */
const ANSWERED = ['past', 'today', 'empty', 'nothing', 'midnight', 'groups', 'placeless', 'unnamed'];

/** @param {Day} day */
export const rowsIn = day => day.all_day.length + day.plans.length + (day.also?.rows.length ?? 0)
  + day.chapters.reduce((sum, chapter) => sum + chapter.blocks.reduce((rows, block) => rows + block.rows.length, 0), 0);

/**
 * @param {string} day
 * @param {string} focus
 */
const momentOn = (day, focus) => {
  const page = Object.values(PAGE).find(each => each.day === day);
  const rows = page ? [...page.all_day, ...page.plans, ...page.also?.rows ?? [],
    ...page.chapters.flatMap(chapter => chapter.blocks.flatMap(block => block.rows))] : [];
  const row = rows.find(each => each.focus === focus)?.key ?? focus;
  return Object.values(MOMENTS).find(each => each.day === day && each.moment?.row === row) ?? null;
};

/** @param {string} day @returns {WrittenDay} */
function writtenOf(day) {
  const listed = DAYS.days.find(each => each.day === day);
  if (listed) return listed;
  const page = ANSWERED.map(name => PAGE[name]).find(each => each.day === day);
  assert.ok(page, `${day} has a day page among the fixtures`);
  return { day, counts: { total: rowsIn(page), families: [] } };
}

installClock(clockFor('UTC', 4));

/** @param {{ url: string, tokens: Record<string, string> }} home */
async function daysHome(home) {
  const door = home.url;
  /** @type {string[]} */
  const asked = [];
  /** @type {{ position: string, changed: string }[]} */
  const people = [];
  let seq = 0;
  /** @type {(() => void)[]} */
  const releases = [];
  /** @type {object | null} */
  let clock = null;
  /** @type {Promise<void> | null} */
  let clockHeld = null;

  const out = feedOut();
  const write = out.relay;
  const followed = await followDoor({ url: door, token: home.tokens.reader, heard: (block, event) => {
    if (typeof event?.seq === 'number') seq = Math.max(seq, event.seq);
    if (event?.kind === 'people') people.push(event.detail);
    write(block);
  } });

  /** @param {import('node:http').IncomingMessage} request @param {import('node:http').ServerResponse} response */
  const handle = async (request, response) => {
    const address = new URL(request.url ?? '', 'http://door');
    if (address.pathname === '/v1/feed') {
      out.add(response);
      return;
    }
    asked.push(`${address.pathname}${address.search}`);
    if (address.pathname === '/v1/clock' && clockHeld) await clockHeld;
    if (clock && address.pathname === '/v1/clock') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(clock));
      return;
    }
    /** @type {Buffer[]} */
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    /** @type {Record<string, string>} */
    const headers = {};
    for (const name of ['authorization', 'content-type', 'if-none-match']) {
      if (request.headers[name]) headers[name] = String(request.headers[name]);
    }
    const passed = await fetch(`${door}${request.url}`, { method: request.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
    /** @type {Record<string, string>} */
    const back = {};
    for (const name of ['content-type', 'etag', 'lifestream-position', 'retry-after']) {
      const value = passed.headers.get(name);
      if (value) back[name] = value;
    }
    response.writeHead(passed.status, back);
    response.end(Buffer.from(await passed.arrayBuffer()));
  };
  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  const id = () => `${seq}:${Date.now()}`;

  return {
    url: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`,
    asked,
    people,
    followers: out.followers,
    told: id,
    /** @param {object | null} next */
    clocked(next) {
      clock = next;
    },
    /** @returns {() => void} */
    holdClock() {
      /** @type {() => void} */
      let release = () => undefined;
      clockHeld = new Promise(done => { release = () => done(undefined); });
      const held = clockHeld;
      const go = () => {
        if (clockHeld === held) clockHeld = null;
        release();
      };
      releases.push(go);
      return go;
    },
    /** @param {{ kind: string, key: string, detail?: unknown }[]} events */
    tell(events) {
      write(events.map(({ kind, key, detail = {} }) => {
        const at_ms = Date.now();
        return `id: ${id()}\ndata: ${JSON.stringify({ seq, at_ms, kind, key, detail })}\n\n`;
      }).join(''));
    },
    reset() {
      write(`id: ${id()}\nevent: reset\ndata: ${JSON.stringify({ seq, at_ms: Date.now() })}\n\n`);
    },
    async close() {
      for (const release of releases) release();
      followed.close();
      out.close();
      server.closeAllConnections();
      await new Promise(done => server.close(() => done(undefined)));
    },
  };
}

/** @param {string} day */
export const drawn = day => `location.hash.includes('on=${day}') && document.querySelector('.dy-day > :is(.dy-list, .ck-none, .dy-state)')
  && !document.querySelector('.dy.ck-reading') && document.fonts.status === 'loaded'`;

/** @param {number} ms */
export const nowAt = ms => `(() => {
  const real = Date.now;
  window.by = ${ms} - real();
  Date.now = () => real() + window.by;
  const every = window.setInterval;
  window.minute = [];
  window.setInterval = (run, ms, ...rest) => ms === 60000 ? (window.minute.push(run), 0) : every(run, ms, ...rest);
})()`;

export const CODES = /** @type {Record<string, number>} */ ({ ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, ' ': 32,
  Enter: 13, Escape: 27, Home: 36, End: 35, PageUp: 33, PageDown: 34, t: 84, Tab: 9 });
export const ALT = 1;
export const META = 4;
export const SHIFT = 8;

export const FOCUSED = `(() => {
  const at = document.activeElement;
  if (!at) return '';
  return at.dataset.dHour ? 'hour:' + at.dataset.dHour : at.dataset.dRow ? 'row:' + at.dataset.dRow
    : at.dataset.dStay ? 'stay:' + at.dataset.dStay : at.tagName.toLowerCase();
})()`;

export const LATTICE = `(() => {
  const list = document.querySelector('.dy-list');
  const box = list.getBoundingClientRect();
  const L = box.left + 8;
  const W = box.width - 16;
  const round = value => Math.round(value * 2) / 2;
  const columns = {};
  const kinds = {};
  const over = [];
  for (const cell of document.querySelectorAll('.dy-list [data-c]')) {
    if (cell.closest('[hidden], .dy-leaving') || !cell.getClientRects().length) continue;
    const host = cell.matches('[data-k]') ? cell : cell.closest('.dy-row, .dy-head');
    // A quiet head (a place the person did not name) is a small marker of its own height.
    const kind = host.dataset.k + (host.classList.contains('dy-head--quiet') ? '-quiet' : '');
    const top = host.getBoundingClientRect().top;
    // A row of an open hour stands one step in: its icon and its name are columns of their own.
    const column = cell.closest('.dy-hour__rows') && ['icon', 'name'].includes(cell.dataset.c) ? cell.dataset.c + '-in-hour' : cell.dataset.c;
    // The runs' own boxes: each text's, each picture's and glyph's, never a button's padding around them.
    const rects = [];
    const range = document.createRange();
    const texts = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    for (let node = texts.nextNode(); node; node = texts.nextNode()) {
      if (!node.textContent.trim()) continue;
      range.selectNodeContents(node);
      rects.push(...range.getClientRects());
    }
    for (const picture of cell.querySelectorAll('img, svg')) rects.push(picture.getBoundingClientRect());
    rects.splice(0, rects.length, ...rects.filter(rect => rect.width > 0 && rect.height > 0));
    let x = null;
    if (column === 'icon') x = cell.getBoundingClientRect().left - L;
    else if (rects.length) x = column === 'time' || column === 'count'
      ? Math.max(...rects.map(rect => rect.right)) - L : Math.min(...rects.map(rect => rect.left)) - L;
    kinds[kind] ??= { heights: [], baselines: [], middles: [] };
    const height = round(host.getBoundingClientRect().height);
    if (!kinds[kind].heights.includes(height)) kinds[kind].heights.push(height);
    if (x === null) continue;
    (columns[column] ??= {})[round(x)] = [...new Set([...(columns[column][round(x)] ?? []), kind])];
    const right = Math.max(...rects.map(rect => rect.right), cell.getBoundingClientRect().left);
    if (right > L + W + 0.5) over.push({ kind, column, by: round(right - L - W), words: cell.textContent.trim().slice(0, 60) });
    if (column === 'icon') continue;
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT,
      { acceptNode: node => node.textContent.trim() && node.parentElement.getClientRects().length ? 1 : 2 });
    const text = walker.nextNode();
    if (!text) continue;
    // Where the run's letters stand: the middle of its text's box, from the host's top.
    range.selectNodeContents(text);
    const glyphs = range.getBoundingClientRect();
    const middle = round((glyphs.top + glyphs.bottom) / 2 - top);
    if (!kinds[kind].middles.includes(middle)) kinds[kind].middles.push(middle);
    const probe = document.createElement('span');
    probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
    text.parentNode.insertBefore(probe, text);
    const baseline = round(probe.getBoundingClientRect().bottom - top);
    probe.remove();
    if (!kinds[kind].baselines.includes(baseline)) kinds[kind].baselines.push(baseline);
  }
  return { L: round(L), W: round(W), columns, kinds, over };
})()`;

export const CENTRED = ['head', 'head-quiet', 'move', 'now'];

/**
 * @param {any} measured
 * @param {string} where
 */
export function latticeHolds(measured, where) {
  const want = { time: 40, icon: 84, name: 108, 'icon-in-hour': 108, 'name-in-hour': 132, words: 276, count: measured.W };
  for (const [column, at] of Object.entries(measured.columns)) {
    assert.deepEqual(Object.keys(at).map(Number), [want[/** @type {keyof typeof want} */ (column)]],
      `${where}: the ${column} column at one x from L, ${JSON.stringify(at)}`);
  }
  /** @type {Record<string, [number, number]>} */
  const sizes = { head: [32, 22], 'head-quiet': [28, 19], names: [28, 19] };
  for (const [kind, { heights, baselines, middles }] of Object.entries(measured.kinds)) {
    const [height, baseline] = sizes[kind] ?? [28, 19];
    assert.deepEqual(heights, [height], `${where}: ${kind} at one height`);
    if (CENTRED.includes(kind)) {
      assert.ok(middles.every((/** @type {number} */ middle) => Math.abs(middle - height / 2) <= 1),
        `${where}: ${kind}'s runs on its centre line, ${JSON.stringify(middles)}`);
      continue;
    }
    assert.equal(baselines.length, 1, `${where}: ${kind} at one baseline, ${JSON.stringify(baselines)}`);
    assert.ok(Math.abs(baselines[0] - baseline) <= 1, `${where}: ${kind}'s baseline ${baselines[0]}, not ${baseline}`);
  }
  assert.deepEqual(measured.over, [], `${where}: no run past the count's edge`);
}

/** @param {{ file: string, mutable?: boolean }} options */
export function daysPage({ file, mutable = false }) {
  const seen = { shots: /** @type {string[]} */ ([]), page: /** @type {string[]} */ ([]), door: /** @type {string[]} */ ([]),
    people: /** @type {unknown[]} */ ([]), served: /** @type {Record<string, number>} */ ({}), lattice: /** @type {unknown} */ (null),
    waiting: '' };
  /** @type {Awaited<ReturnType<typeof daysHome>> | undefined} */
  let front;
  const page = pageHarness({ file, seen, mutable, front: home => daysHome(home), size: { width: 1440, height: 900 }, zone: 'UTC',
    ending: () => {
      seen.page = asked.filter(address => new URL(address).pathname.startsWith('/api/'));
      seen.door = front?.asked.filter(path => /^\/v1\/(?:page|people|places)(?:\?|\/|$)/u.test(path)) ?? [];
      seen.people = front?.people ?? [];
      seen.served = Object.fromEntries(served);
    } });
  /** @type {string[]} */
  const asked = [];
  /** @type {Map<string, number>} */
  const served = new Map();
  /** @type {Map<string, number>} */
  const landed = new Map();
  /** @type {Map<string, () => void>} */
  const heldDays = new Map();
  /** @type {Map<string, (() => void)[]>} */
  const waitingDays = new Map();
  /** @type {Map<string, () => void>} */
  const heldPaths = new Map();
  /** @type {Map<string, (() => void)[]>} */
  const waitingPaths = new Map();
  /** @type {Map<string, Day>} */
  const answers = new Map();
  /** @type {Map<string, Thread>} */
  const threads = new Map();
  /** @type {Map<string, Moment>} */
  const moments = new Map();
  /** @type {{ seq: number, days: WrittenDay[] }[]} */
  const lists = [];
  let stale = false;
  let failing = false;
  let failed = 0;
  let feeds = 0;
  /** @type {Awaited<ReturnType<typeof page.journey>>} */
  let opened;

  /**
   * @param {string} name
   * @param {{ size?: { width: number, height: number } }} [options]
   */
  async function journey(name, options) {
    opened = await page.journey(name, options);
    front = opened.front;
    asked.length = 0;
    served.clear();
    landed.clear();
    heldDays.clear();
    waitingDays.clear();
    heldPaths.clear();
    waitingPaths.clear();
    answers.clear();
    threads.clear();
    moments.clear();
    for (const name_ of ANSWERED) answers.set(PAGE[name_].day, PAGE[name_]);
    lists.splice(0, lists.length, { seq: 1, days: [...DAYS.days] });
    stale = false;
    failing = false;
    failed = 0;
    feeds = 0;
    await opened.chrome.send('Network.enable');
    await opened.chrome.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/page/*', requestStage: 'Request' }] });
    return opened;
  }

  const listNow = () => /** @type {{ seq: number, days: WrittenDay[] }} */ (lists.at(-1));

  /** @param {WrittenDay[]} days */
  function relist(days) {
    lists.push({ seq: listNow().seq + 1, days: [...days].sort((left, right) => left.day.localeCompare(right.day)) });
  }

  /** @param {string[]} days */
  const serve = days => relist([...listNow().days.filter(each => !days.includes(each.day)), ...days.map(writtenOf)]);

  /** @param {string} day */
  const hide = day => relist(listNow().days.filter(each => each.day !== day));

  /** @param {string} [month] */
  const listedDays = (month = '') => listNow().days.map(each => each.day).filter(day => day.startsWith(month));

  /**
   * @param {string} day
   * @returns {() => void}
   */
  function holdDay(day) {
    /** @type {() => void} */
    let release = () => undefined;
    const gate = new Promise(done => { release = () => done(undefined); });
    heldDays.set(day, release);
    void gate.then(() => {
      heldDays.delete(day);
      for (const go of waitingDays.get(day) ?? []) go();
      waitingDays.delete(day);
    });
    return release;
  }

  /**
   * @param {string} path
   * @returns {() => void}
   */
  function holdPath(path) {
    /** @type {() => void} */
    let release = () => undefined;
    const gate = new Promise(done => { release = () => done(undefined); });
    heldPaths.set(path, release);
    void gate.then(() => {
      heldPaths.delete(path);
      for (const go of waitingPaths.get(path) ?? []) go();
      waitingPaths.delete(path);
    });
    return release;
  }

  /** @param {string} path */
  const pageAsked = path => asked.map(address => new URL(address)).filter(url => url.pathname === path).map(url => url.search);
  /** @param {string} path */
  const doorAsked = path => (front?.asked ?? []).map(address => new URL(address, 'http://door'))
    .filter(url => url.pathname === path).map(url => url.search);
  const listReads = () => doorAsked('/v1/page/people').filter(search => search === '').length;

  /**
   * @param {string} hash
   * @param {string} [script]
   */
  async function load(hash, script = '') {
    await opened.chrome.load(hash, script);
    await until('the page following the feed, and the dashboard the door\'s', () => feeds > 0 && (front?.followers() ?? 0) > 0);
  }

  /** @param {string} path */
  async function fromDoor(path) {
    const response = await fetch(`${opened.home.url}${path}`, { headers: { authorization: `Bearer ${opened.home.tokens.reader}` } });
    assert.equal(response.status, 200);
    return response.json();
  }

  /** @param {string} path */
  async function fromDashboard(path) {
    const response = await fetch(`${opened.url}${path}`);
    assert.equal(response.status, 200);
    return response.json();
  }

  /**
   * @param {string} key
   * @param {number} [modifiers]
   */
  async function key(key, modifiers = 0) {
    const code = key === ' ' ? 'Space' : key === 't' ? 'KeyT' : key;
    for (const type of ['rawKeyDown', 'keyUp']) {
      await opened.chrome.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: CODES[key] ?? 0, modifiers });
    }
  }

  /** @param {string} month */
  async function pickerDays(month) {
    const { chrome } = opened;
    await chrome.until(`document.querySelector('[data-d-title]:not(:disabled)')`);
    await chrome.evaluate(`document.querySelector('[data-d-title]').click()`);
    await chrome.until(`document.querySelector('.ck-mgrid .ck-mgrid__day')`);
    const days = await chrome.evaluate(`[...document.querySelectorAll('.ck-mgrid .ck-mgrid__day:not(.is-dim):not(.is-out)')]
      .map(cell => cell.dataset.pDay).filter(day => day.startsWith(${JSON.stringify(month)})).sort()`);
    await chrome.evaluate(`document.querySelector('[data-d-title]').click()`);
    await chrome.until(`!document.querySelector('.ck-mgrid')`);
    return /** @type {string[]} */ (days);
  }

  async function open() {
    const { chrome } = await page.open();
    chrome.on('Network.requestWillBeSent', ({ request }) => asked.push(request.url));
    chrome.on('Network.responseReceived', ({ response }) => {
      if (new URL(response.url).pathname === '/api/feed') feeds += 1;
    });
    /**
     * @param {string} requestId
     * @param {number} status
     * @param {unknown} body
     * @param {{ name: string, value: string }[]} [more]
     */
    const fulfil = (requestId, status, body, more = []) => void chrome.send('Fetch.fulfillRequest', { requestId, responseCode: status,
      responseHeaders: [{ name: 'content-type', value: 'application/json' }, ...more],
      body: Buffer.from(JSON.stringify(body)).toString('base64') }).catch(() => undefined);

    /**
     * @param {URL} url
     * @returns {((requestId: string) => void) | null}
     */
    function answerOf(url) {
      const asks = url.searchParams;
      switch (url.pathname) {
        case '/api/page/days':
          return requestId => {
            if (failing) {
              failing = false;
              failed += 1;
              fulfil(requestId, 503, { error: 'Lifestream is starting: it answers in a moment.' }, [{ name: 'retry-after', value: '5' }]);
              return;
            }
            const list = stale ? lists.at(-2) ?? listNow() : listNow();
            stale = false;
            fulfil(requestId, 200, { position: `${list.seq}:${FIXTURE_MS}`, today: DAYS.today, opening: DAYS.opening, days: list.days, next: null });
          };
        case '/api/page/day': {
          const day = asks.get('day') ?? '';
          const answer = answers.get(day);
          return answer ? requestId => {
            served.set(day, (served.get(day) ?? 0) + 1);
            fulfil(requestId, 200, answer);
          } : null;
        }
        case '/api/page/thread': {
          const given = threads.get(`${asks.get('chat')} ${asks.get('day')}`);
          if (given) return requestId => fulfil(requestId, 200, given);
          return asks.get('chat') === THREAD.chat && asks.get('day') === THREAD.day ? requestId => fulfil(requestId, 200, THREAD) : null;
        }
        case '/api/page/moment': {
          const found = momentOn(asks.get('day') ?? '', asks.get('focus') ?? '');
          const answer = found && (moments.get(`${found.day} ${found.moment?.row}`) ?? found);
          return answer ? requestId => fulfil(requestId, 200, answer) : null;
        }
        default:
          return null;
      }
    }

    chrome.on('Fetch.requestPaused', ({ requestId, request }) => {
      const url = new URL(request.url);
      const answer = answerOf(url);
      const go = () => {
        landed.set(url.pathname, (landed.get(url.pathname) ?? 0) + 1);
        if (answer) answer(requestId);
        else void chrome.send('Fetch.continueRequest', { requestId }).catch(() => undefined);
      };
      const day = url.pathname === '/api/page/day' ? url.searchParams.get('day') ?? '' : '';
      if (day && heldDays.has(day)) waitingDays.set(day, [...waitingDays.get(day) ?? [], go]);
      else if (heldPaths.has(url.pathname)) waitingPaths.set(url.pathname, [...waitingPaths.get(url.pathname) ?? [], go]);
      else go();
    });
  }

  return {
    get opened() {
      return opened;
    },
    get front() {
      return front;
    },
    close: () => page.close(),
    page,
    seen,
    asked,
    served,
    waitingPaths,
    journey,
    holdDay,
    holdPath,
    pageAsked,
    doorAsked,
    listReads,
    load,
    fromDoor,
    fromDashboard,
    pickerDays,
    key,
    open,
    serve,
    hide,
    listedDays,
    listed: () => listNow().days,
    staleNext: () => {
      stale = true;
    },
    failList: () => {
      failing = true;
    },
    failed: () => failed,
    /** @param {string} path */
    landed: path => landed.get(path) ?? 0,
    /**
     * @param {string} day
     * @param {DayCase} name
     */
    answerWith: (day, name) => {
      answers.set(day, PAGE[name]);
    },
    /** @param {Thread} thread */
    threadWith: thread => {
      threads.set(`${thread.chat} ${thread.day}`, thread);
    },
    /** @param {Moment} moment */
    momentWith: moment => {
      moments.set(`${moment.day} ${moment.moment?.row}`, moment);
    },
  };
}
