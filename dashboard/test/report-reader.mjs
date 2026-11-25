import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { HOST_STATE, REPORT } from '../public/kit-gallery-report.js';
import { openDoor } from '../lib/door.mjs';
import { createViewer } from '../server.mjs';

const TOKEN = 'stand-in-token';
const NOT_NOW = 'Lifestream took too long to read this: try again in a few minutes.';
const WAIT_S = 300;
const AGAIN_MS = 5_000;
const ANSWERING = { state: 'answering', revision: 1, tone: null, title: null, line: null, meta: null, acts: [] };
const UNREACHABLE = { state: 'unreachable', revision: 1, tone: 'warning', title: 'Can\'t reach Lifestream',
  line: 'Your Mac isn\'t answering', meta: 'since 14:02', acts: [] };

/** @param {object} reach */
function reachHost(reach) {
  const state = { ...HOST_STATE, setup: null, reach };
  /** @type {unknown[]} */
  const probes = [];
  /** @type {((reply: unknown) => void) | null} */
  let reply = null;
  const host = /** @type {any} */ ({
    state,
    /** @param {(state: object) => void} listener */
    follow(listener) {
      listener(state);
      return () => undefined;
    },
    /** @param {unknown} message */
    act(message) {
      probes.push(message);
      return new Promise(done => {
        reply = done;
      });
    },
  });
  return { host, probes, /** @param {unknown} answer */ answer: answer => reply?.(answer) };
}

test('W1: the door\'s 503 NOT_NOW reaches the page with its Retry-After, its code and its words', async t => {
  /** @type {string[]} */
  const asked = [];
  const door = createServer((request, response) => {
    const at = new URL(/** @type {string} */ (request.url), 'http://door');
    if (at.pathname === '/v1/feed') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('retry: 50\n\n');
      return;
    }
    asked.push(at.pathname);
    response.writeHead(503, { 'content-type': 'application/json', 'retry-after': String(WAIT_S) });
    response.end(JSON.stringify({ code: 'NOT_NOW', message: NOT_NOW }));
  });
  await new Promise(done => door.listen(0, '127.0.0.1', () => done(undefined)));
  const reader = openDoor({ url: `http://127.0.0.1:${/** @type {any} */ (door.address()).port}`, token: () => TOKEN });
  const viewer = await createViewer({ key: null, door: reader });
  await new Promise(done => viewer.listen(0, '127.0.0.1', () => done(undefined)));
  t.after(async () => {
    reader.close();
    await new Promise(done => viewer.close(() => done(undefined)));
    await new Promise(done => { door.closeAllConnections(); door.close(() => done(undefined)); });
  });
  const response = await fetch(`http://127.0.0.1:${/** @type {any} */ (viewer.address()).port}/api/page/connectors`);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), String(WAIT_S));
  assert.deepEqual(await response.json(), { error: NOT_NOW, code: 'NOT_NOW' });
  assert.deepEqual(asked.filter(path => path === '/v1/connectors'), ['/v1/connectors'], 'one ask of the door');
});

test('W2–W4: every ask before the Retry-After joins one read, made at that time, the last report drawn meanwhile', async t => {
  class Feed {
    static CLOSED = 2;
    /** @type {Feed | null} */
    static open = null;
    readyState = 1;
    /** @type {Map<string, (event: { data: string }) => void>} */
    heard = new Map();
    constructor() {
      Feed.open = this;
    }
    /** @param {string} name @param {(event: { data: string }) => void} listener */
    addEventListener(name, listener) {
      this.heard.set(name, listener);
    }
    close() {}
  }
  Object.assign(globalThis, { EventSource: Feed, MutationObserver: class { observe() {} disconnect() {} } });
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const fetched = globalThis.fetch;
  t.after(() => {
    mock.timers.reset();
    globalThis.fetch = fetched;
  });

  /** @type {number[]} */
  const at = [];
  const answers = ['refused', 'answered', 'refused', 'answered'];
  globalThis.fetch = async path => {
    assert.equal(path, 'api/page/connectors');
    at.push(Date.now());
    return answers.shift() === 'refused'
      ? new Response(JSON.stringify({ error: NOT_NOW, code: 'NOT_NOW' }), { status: 503, headers: { 'retry-after': String(WAIT_S) } })
      : new Response(JSON.stringify(REPORT), { status: 200 });
  };
  const { reportReader } = await import('../public/lib/report.js');
  const reads = reportReader(null);
  const settle = () => new Promise(done => setImmediate(done));
  const change = async () => {
    Feed.open?.heard.get('message')?.({ data: JSON.stringify({ seq: 1, kind: 'import', key: 'stand-in/1' }) });
    mock.timers.tick(1_000);
    await settle();
  };

  await reads.read();
  assert.deepEqual(at, [0]);
  assert.equal(reads.failure(), NOT_NOW);
  let done = 0;
  for (const _ of [1, 2, 3]) void reads.read().then(() => done++);
  for (const _ of [1, 2, 3, 4]) {
    await change();
    void reads.read().then(() => done++);
    mock.timers.tick(59_000);
  }
  mock.timers.tick(WAIT_S * 1_000 - 1 - Date.now());
  await settle();
  assert.deepEqual(at, [0], 'no request before the Retry-After');
  assert.equal(done, 0);
  assert.equal(reads.seen.report, null);

  mock.timers.tick(1);
  await settle();
  assert.deepEqual(at, [0, WAIT_S * 1_000]);
  assert.equal(done, 3 + 4);
  assert.deepEqual(reads.seen.report, REPORT);
  assert.equal(reads.failure(), '');

  const start = Date.now();
  const first = reads.read();
  let joined = false;
  void reads.read().then(() => { joined = true; });
  await first;
  await change();
  assert.deepEqual(at, [0, WAIT_S * 1_000, start]);
  assert.equal(reads.failure(), NOT_NOW);
  assert.deepEqual(reads.seen.report, REPORT, 'the last report still drawn');
  mock.timers.tick(start + WAIT_S * 1_000 - 1 - Date.now());
  await settle();
  assert.equal(at.length, 3);
  assert.equal(joined, false);
  mock.timers.tick(1);
  await settle();
  assert.deepEqual(at.slice(3), [start + WAIT_S * 1_000]);
  assert.equal(joined, true);
  assert.equal(reads.failure(), '');
});

test('W5: a home that waits is read again by the reader itself, at its Retry-After or in 5 s, the last report drawn throughout', async t => {
  class Feed {
    static CLOSED = 2;
    readyState = 1;
    addEventListener() {}
    close() {}
  }
  Object.assign(globalThis, { EventSource: Feed, MutationObserver: class { observe() {} disconnect() {} } });
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const fetched = globalThis.fetch;
  t.after(() => {
    mock.timers.reset();
    globalThis.fetch = fetched;
  });
  const STARTING = 'Lifestream is starting: it answers in a moment.';
  const LATER = { ...REPORT, marker: 'the report after the restart' };
  /** @type {number[]} */
  const at = [];
  const answers = ['answered', 'starting', 'lost', 'unreachable', 'later'];
  globalThis.fetch = async () => {
    at.push(Date.now());
    const answer = answers.shift();
    if (answer === 'starting') {
      return new Response(JSON.stringify({ error: STARTING, code: 'NOT_NOW' }), { status: 503, headers: { 'retry-after': '5' } });
    }
    if (answer === 'lost') return new Response(JSON.stringify({ error: 'Can\'t reach Lifestream.', code: 'GONE' }), { status: 503 });
    if (answer === 'unreachable') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(answer === 'later' ? LATER : REPORT), { status: 200 });
  };
  const { reportReader, AGAIN_S } = await import('../public/lib/report.js');
  const host = reachHost(UNREACHABLE);
  const reads = reportReader(host.host);
  /** @type {[unknown, string][]} */
  const drawn = [];
  reads.follow(() => drawn.push([reads.seen.report, reads.failure()]));
  const settle = async () => {
    for (const _ of [1, 2, 3]) await new Promise(done => setImmediate(done));
  };
  /** @param {number} ms */
  const pass = async ms => {
    mock.timers.tick(ms);
    await settle();
  };

  await reads.read();
  assert.deepEqual(reads.seen.report, REPORT);
  await pass(1_000);
  await reads.read();
  assert.deepEqual([at, reads.failure(), reads.drawn()?.kind], [[0, 1_000], STARTING, 'wait']);
  await pass(4_999);
  assert.equal(at.length, 2, 'asked before the Retry-After');
  await pass(1);
  assert.deepEqual([at.at(-1), reads.failure()], [6_000, '']);
  assert.equal(AGAIN_S, 5);
  await pass(AGAIN_S * 1_000 - 1);
  assert.equal(at.length, 3);
  await pass(1);
  assert.deepEqual([at.at(-1), reads.failure()], [11_000, '']);
  await pass(AGAIN_S * 1_000);
  assert.deepEqual([at.at(-1), reads.failure(), reads.drawn()], [16_000, '', null]);
  assert.deepEqual(reads.seen.report, LATER);
  const first = drawn[0][0];
  assert.deepEqual(drawn.map(([report, failure]) => [report === first ? 'report' : report && 'marker' in report ? 'later' : 'none', failure]), [
    ['report', ''], ['report', STARTING], ['report', ''], ['report', ''], ['later', '']]);
  assert.deepEqual(host.probes, [], 'reach lacking: the Mac is not asked for a probe');
  await pass(10 * 60_000);
  assert.equal(at.length, 5);
});

test('W7: a read that fails for reach asks the Mac one probe and is read again once the home answers; one that fails of itself says its own words, asks none', async t => {
  class Feed {
    static CLOSED = 2;
    readyState = 1;
    addEventListener() {}
    close() {}
  }
  Object.assign(globalThis, { EventSource: Feed, MutationObserver: class { observe() {} disconnect() {} } });
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const fetched = globalThis.fetch;
  t.after(() => {
    mock.timers.reset();
    globalThis.fetch = fetched;
  });
  const REFUSED = 'Lifestream holds no stream by that name.';
  /** @type {number[]} */
  const at = [];
  const answers = ['gone', 'answered', 'failed', 'refused', 'disk', 'answered'];
  globalThis.fetch = async () => {
    at.push(Date.now());
    const answer = answers.shift();
    if (answer === 'gone') return new Response(JSON.stringify({ error: 'Can\'t reach Lifestream.', code: 'GONE' }), { status: 503 });
    if (answer === 'failed') return new Response(JSON.stringify({ error: 'database disk image is malformed' }), { status: 500 });
    if (answer === 'refused') return new Response(JSON.stringify({ error: REFUSED, code: 'NOT_FOUND' }), { status: 404 });
    if (answer === 'disk') {
      return new Response(JSON.stringify({ error: 'no room', code: 'DISK_LOW' }), { status: 503, headers: { 'retry-after': '7' } });
    }
    return new Response(JSON.stringify(REPORT), { status: 200 });
  };
  const { reportReader, UNREAD } = await import('../public/lib/report.js');
  const { DOOR_WORDS } = await import('../public/lib/reach.js');
  const host = reachHost(ANSWERING);
  const reads = reportReader(host.host);
  const settle = async () => {
    for (const _ of [1, 2, 3]) await new Promise(done => setImmediate(done));
  };

  await reads.read();
  assert.deepEqual([at, reads.failure(), reads.drawn()?.kind, reads.seen.report], [[0], '', 'reach', null]);
  void reads.read();
  await settle();
  assert.deepEqual(host.probes, [{ act: 'home', do: 'probe' }], 'one probe, however many asks');
  host.answer({ state: 'answering', revision: 1 });
  await settle();
  mock.timers.tick(AGAIN_MS);
  await settle();
  assert.deepEqual([at, reads.failure()], [[0, AGAIN_MS], '']);
  assert.deepEqual(reads.seen.report, REPORT);
  await reads.read();
  assert.deepEqual([reads.failure(), reads.drawn()], [UNREAD, { kind: 'lack', words: null, retry: true }]);
  assert.equal(host.probes.length, 1, 'a failure of the read\'s own asks no probe');
  await reads.read();
  assert.equal(reads.failure(), REFUSED);
  await reads.read();
  assert.equal(reads.failure(), DOOR_WORDS.DISK_LOW);
  const waited = Date.now();
  mock.timers.tick(6_999);
  await settle();
  assert.equal(at.length, 5);
  mock.timers.tick(1);
  await settle();
  assert.deepEqual([at.at(-1) - waited, reads.failure()], [7_000, '']);
  assert.equal(host.probes.length, 1);
});

test('W8: a read asked again behind the quiet moment keeps its mark: meeting reach again, it is its own lack, no probe', async t => {
  class Feed {
    static CLOSED = 2;
    readyState = 1;
    addEventListener() {}
    close() {}
  }
  Object.assign(globalThis, { EventSource: Feed, MutationObserver: class { observe() {} disconnect() {} } });
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const fetched = globalThis.fetch;
  t.after(() => {
    mock.timers.reset();
    globalThis.fetch = fetched;
  });
  /** @type {number[]} */
  const at = [];
  globalThis.fetch = async () => {
    at.push(Date.now());
    return new Response(JSON.stringify({ error: 'Can\'t reach Lifestream.', code: 'GONE' }), { status: 503 });
  };
  const { reportReader } = await import('../public/lib/report.js');
  const host = reachHost(ANSWERING);
  const reads = reportReader(host.host);
  const settle = async () => {
    for (const _ of [1, 2, 3]) await new Promise(done => setImmediate(done));
  };
  await reads.read();
  assert.deepEqual([at, reads.drawn()?.kind, host.probes.length], [[0], 'reach', 1]);
  host.answer({ state: 'answering', revision: 1 });
  await settle();
  assert.deepEqual(at, [0], 'nothing asked before the quiet moment');
  mock.timers.tick(AGAIN_MS);
  await settle();
  assert.deepEqual(at, [0, AGAIN_MS], 'two reads');
  assert.deepEqual(reads.drawn(), { kind: 'lack', words: null, retry: true });
  assert.equal(host.probes.length, 1, 'no probe for a recovery the probe already said');
  mock.timers.tick(AGAIN_MS * 3);
  await settle();
  assert.deepEqual([at, host.probes.length], [[0, AGAIN_MS], 1], 'the reader asks nothing more by itself');
});

test('W6: a held home\'s words reach the page whole, its Check again left to the Mac; a door that does not answer names no wait', async t => {
  const HELD = { code: 'NOT_NOW', wait: 'needs', message: 'Lifestream\'s database is damaged.',
    title: 'Lifestream\'s database is damaged.', line: 'A check found damage in home.db. It needs a good copy put back.',
    acts: [{ do: 'verify', label: 'Check again' }] };
  const door = createServer((request, response) => {
    if (new URL(/** @type {string} */ (request.url), 'http://door').pathname === '/v1/feed') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('retry: 50\n\n');
      return;
    }
    response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '60' });
    response.end(JSON.stringify(HELD));
  });
  await new Promise(done => door.listen(0, '127.0.0.1', () => done(undefined)));
  const gone = createServer();
  await new Promise(done => gone.listen(0, '127.0.0.1', () => done(undefined)));
  const goneAt = /** @type {any} */ (gone.address()).port;
  await new Promise(done => gone.close(() => done(undefined)));
  const held = openDoor({ url: `http://127.0.0.1:${/** @type {any} */ (door.address()).port}`, token: () => TOKEN });
  const away = openDoor({ url: `http://127.0.0.1:${goneAt}`, token: () => TOKEN });
  const viewers = [await createViewer({ key: null, door: held }), await createViewer({ key: null, door: away })];
  for (const viewer of viewers) await new Promise(done => viewer.listen(0, '127.0.0.1', () => done(undefined)));
  t.after(async () => {
    held.close();
    away.close();
    for (const viewer of viewers) await new Promise(done => viewer.close(() => done(undefined)));
    await new Promise(done => { door.closeAllConnections(); door.close(() => done(undefined)); });
  });
  const [onHeld, onAway] = await Promise.all(viewers.map(viewer =>
    fetch(`http://127.0.0.1:${/** @type {any} */ (viewer.address()).port}/api/page/connectors`)));
  assert.equal(onHeld.status, 503);
  assert.equal(onHeld.headers.get('retry-after'), '60');
  assert.deepEqual(await onHeld.json(), { error: HELD.message, code: 'NOT_NOW', wait: 'needs' });
  assert.equal(onAway.status, 503);
  assert.equal(onAway.headers.get('retry-after'), null, 'a wait the door never named');
  assert.deepEqual(await onAway.json(), { error: 'Can\'t reach Lifestream.', code: 'GONE' });
});
