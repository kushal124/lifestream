import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { until } from './until.mjs';
import { openDoor, retryWait } from '../lib/door.mjs';

const TOKEN = 'stand-in-token';

async function standIn(t, answers) {
  /** @type {(string | null)[]} */
  const asked = [];
  /** @type {import('node:http').ServerResponse[]} */
  const held = [];
  const server = createServer((request, response) => {
    if (new URL(request.url, 'http://door').pathname === '/v1/held') {
      held.push(response);
      return;
    }
    if (new URL(request.url, 'http://door').pathname !== '/v1/feed') {
      response.writeHead(404).end();
      return;
    }
    asked.push(request.headers['last-event-id'] ?? null);
    const answer = answers[Math.min(asked.length - 1, answers.length - 1)];
    if (answer === 'open') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`retry: 1000\n\nid: 7:70\ndata: ${JSON.stringify({ seq: 7, at_ms: 70, kind: 'day', key: 'stand-in', detail: null })}\n\n`, () => {
        setImmediate(() => response.destroy());
      });
      return;
    }
    response.writeHead(answer.status, { 'content-type': 'application/json', ...(answer.retry === undefined ? {} : { 'retry-after': answer.retry }) });
    response.end(JSON.stringify({ code: 'NOT_NOW', message: 'Lifestream is not ready: try again in a moment.' }));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  t.after(() => new Promise(done => { server.closeAllConnections(); server.close(() => done(undefined)); }));
  return {
    url: `http://127.0.0.1:${server.address().port}`, asked, held,
    answerHeld: () => { for (const response of held) response.writeHead(200, { 'content-type': 'application/json' }).end('{}'); },
  };
}

function clock() {
  /** @type {{ ms: number, end: () => void, ended: boolean }[]} */
  const waits = [];
  return {
    waits,
    /** @type {(ms: number, signal: AbortSignal) => Promise<void>} */
    wait: (ms, signal) => new Promise(resolve => {
      const each = { ms, ended: false, end: () => { each.ended = true; resolve(undefined); } };
      waits.push(each);
      signal.addEventListener('abort', () => each.end(), { once: true });
    }),
  };
}

test('R1 R2: a refused feed waits its Retry-After before it asks again, a second when it is not whole seconds', async t => {
  const door = await standIn(t, [{ status: 503, retry: '5' }, { status: 503, retry: 'soon' }, { status: 503 }, { status: 503, retry: '0' }, { status: 503, retry: '1.5' }]);
  const time = clock();
  const client = openDoor({ url: door.url, token: () => TOKEN, wait: time.wait });
  t.after(() => client.close());
  client.follow(() => undefined);
  await until('the first refusal waited', () => time.waits.length === 1);
  assert.equal(time.waits[0].ms, 5_000);
  assert.equal(door.asked.length, 1);
  for (const [at, ms] of [[1, 1_000], [2, 1_000], [3, 0], [4, 1_000]]) {
    time.waits[at - 1].end();
    await until(`refusal ${at + 1} waited`, () => time.waits.length === at + 1);
    assert.equal(door.asked.length, at + 1);
    assert.equal(time.waits[at].ms, ms, `refusal ${at + 1}`);
  }
  assert.deepEqual([5, 'soon', null, 0, '1.5', ' 7 ', ''].map(each => retryWait(each === null ? null : String(each))), [5_000, 1_000, 1_000, 0, 1_000, 7_000, 1_000]);
});

test('R3: a client closed during a long wait ends it at once and asks nothing more', async t => {
  const door = await standIn(t, [{ status: 503, retry: '3600' }]);
  const time = clock();
  const client = openDoor({ url: door.url, token: () => TOKEN, wait: time.wait });
  client.follow(() => undefined);
  await until('the hour waited', () => time.waits.length === 1);
  assert.equal(time.waits[0].ms, 3_600_000);
  client.close();
  assert.equal(time.waits[0].ended, true);
  await new Promise(done => setImmediate(done));
  assert.equal(door.asked.length, 1);
  assert.equal(time.waits.length, 1);
});

test('R4: a stream that opened and broke resumes after a second, from its position', async t => {
  const door = await standIn(t, ['open', { status: 503, retry: '5' }]);
  const time = clock();
  const client = openDoor({ url: door.url, token: () => TOKEN, wait: time.wait });
  t.after(() => client.close());
  client.follow(() => undefined);
  await until('the broken stream waited', () => time.waits.length === 1);
  assert.equal(time.waits[0].ms, 1_000);
  assert.equal(client.position(), '7:70');
  time.waits[0].end();
  await until('asked again', () => door.asked.length === 2);
  assert.deepEqual(door.asked, [null, '7:70']);
});

test('R5: the wait for a refusal\'s Retry-After is not the door\'s silence: a request open meanwhile is answered, not aborted', async t => {
  const door = await standIn(t, [{ status: 503, retry: '3600' }]);
  const time = clock();
  const SILENCE = 987_654;
  /** @type {Set<{ end: () => void }>} */
  const counting = new Set();
  const [set, clear] = [globalThis.setTimeout, globalThis.clearTimeout];
  globalThis.setTimeout = /** @type {typeof setTimeout} */ (/** @type {unknown} */ ((/** @type {() => void} */ end, /** @type {number} */ ms, ...rest) => {
    if (ms !== SILENCE) return set(end, ms, ...rest);
    const timer = { end, refresh: () => timer, unref: () => timer, ref: () => timer, hasRef: () => true };
    counting.add(timer);
    return timer;
  }));
  globalThis.clearTimeout = /** @type {typeof clearTimeout} */ ((timer) => {
    if (!counting.delete(/** @type {never} */ (timer))) clear(timer);
  });
  t.after(() => { globalThis.setTimeout = set; globalThis.clearTimeout = clear; });
  const client = openDoor({ url: door.url, token: () => TOKEN, wait: time.wait, silenceMs: SILENCE });
  t.after(() => client.close());
  const open = client.json('/v1/held').then(body => ({ body }), error => ({ error }));
  await until('the request open at the door', () => door.held.length === 1);
  await until('the refusal\'s hour waited', () => time.waits.length === 1);
  assert.equal(time.waits[0].ms, 3_600_000);
  assert.equal(counting.size, 0);
  for (const timer of [...counting]) timer.end();
  door.answerHeld();
  assert.deepEqual(await open, { body: {} });
});
