// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { MAX_URL, openDoor } from '../lib/door.mjs';
import { DoorRefusal, ToolError } from '../lib/errors.mjs';

test('a path with a dot segment, plain or encoded, or its own query, is refused before any request; a route is sent as named', async () => {
  /** @type {string[]} */
  const asked = [];
  const server = createServer((request, response) => {
    asked.push(request.url ?? '');
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  try {
    const address = /** @type {import('node:net').AddressInfo} */ (server.address());
    const door = openDoor({ url: `http://127.0.0.1:${address.port}`, authorization: 'Bearer test-pass' });
    for (const path of ['/v1/days/../secrets/openrouter', '/v1/days/%2e%2E/secrets/openrouter', '/v1/days/./x', '/v1/days/..\\secrets', '/v1/days/x?file=json']) {
      await assert.rejects(door.json(path), error => error instanceof ToolError && error.message.startsWith('Not a route of the home'), path);
    }
    assert.deepEqual(asked, []);
    assert.deepEqual(await door.json('/v1/days/2026-01-02', { file: 'json' }), { ok: true });
    assert.deepEqual(asked, ['/v1/days/2026-01-02?file=json']);
  } finally {
    await new Promise(done => server.close(() => done(undefined)));
  }
});

test('an outcome unknown is sent once more only when the door says again, then refused in its words; a 304 is an answer', async () => {
  /** @param {boolean} again @returns {[number, unknown]} */
  const unknown = again => [503, { code: 'OUTCOME_UNKNOWN', message: 'Lifestream did not answer in time: it may have kept the change.', again }];
  /** @type {Record<string, [number, unknown][]>} */
  const answers = {
    '/v1/again-then-answered': [unknown(true), [200, { ok: true }]],
    '/v1/again-twice': [unknown(true), unknown(true), [200, { ok: true }]],
    '/v1/not-again': [unknown(false), [200, { ok: true }]],
    '/v1/kept': [[304, null]],
  };
  /** @type {string[]} */
  const asked = [];
  const server = createServer((request, response) => {
    const path = request.url ?? '';
    asked.push(path);
    const [status, body] = answers[path]?.shift() ?? [404, { code: 'NONE', message: 'no such answer' }];
    response.writeHead(status, { 'content-type': 'application/json', ...(status === 503 ? { 'retry-after': '5' } : {}) }).end(body === null ? undefined : JSON.stringify(body));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  try {
    const address = /** @type {import('node:net').AddressInfo} */ (server.address());
    const door = openDoor({ url: `http://127.0.0.1:${address.port}`, authorization: 'Bearer test-pass' });
    assert.deepEqual(await door.json('/v1/again-then-answered'), { ok: true });
    /** @param {unknown} error */
    const refusedAs = error => error instanceof DoorRefusal && error.code === 'OUTCOME_UNKNOWN' && error.said === 'Lifestream did not answer in time: it may have kept the change.';
    await assert.rejects(door.json('/v1/again-twice'), refusedAs);
    await assert.rejects(door.json('/v1/not-again'), refusedAs);
    assert.equal((await door.text('/v1/kept', {}, '"etag"')).status, 304);
    assert.deepEqual(asked, ['/v1/again-then-answered', '/v1/again-then-answered', '/v1/again-twice', '/v1/again-twice', '/v1/not-again', '/v1/kept']);
  } finally {
    await new Promise(done => server.close(() => done(undefined)));
  }
});

test('a list too long for one URL: the door client never sends a URL past the door\'s head limit', async () => {
  /** @type {string[]} */
  const asked = [];
  const server = createServer((request, response) => {
    asked.push(request.url ?? '');
    response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  try {
    const address = /** @type {import('node:net').AddressInfo} */ (server.address());
    const door = openDoor({ url: `http://127.0.0.1:${address.port}`, authorization: 'Bearer test-pass' });
    const blob = (/** @type {string} */ kind, /** @type {number} */ n) => `sha256:${createHash('sha256').update(`${kind} ${n}`).digest('hex')}`;
    await assert.rejects(door.json('/v1/enrichments', { item: Array.from({ length: 256 }, (_, n) => blob('photo', n)) }),
      error => !(error instanceof ToolError) && error instanceof Error && error.message.includes(`past the ${MAX_URL}`));
    assert.equal(asked.length, 0);
  } finally {
    await new Promise(done => server.close(() => done(undefined)));
  }
});

test('a turn asked on the asker\'s own pass read as the person\'s: a door made for a model says so on each request, a door made during a signal keeps it and the server\'s pass, the person\'s door never does', async () => {
  /** @type {[string | undefined, string | undefined][]} */
  const seen = [];
  const server = createServer((request, response) => {
    const header = (/** @type {string} */ name) => /** @type {string | undefined} */ (request.headers[name]);
    seen.push([header('lifestream-reader'), header('lifestream-server')]);
    response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  try {
    const address = /** @type {import('node:net').AddressInfo} */ (server.address());
    const person = openDoor({ url: `http://127.0.0.1:${address.port}`, authorization: 'Bearer test-pass', server: () => 'server-pass' });
    await person.json('/v1/search');
    await person.forModel().json('/v1/search');
    await person.forModel().during(new AbortController().signal).json('/v1/search');
    await person.during(new AbortController().signal).json('/v1/search');
    assert.deepEqual(seen, [[undefined, 'server-pass'], ['model', 'server-pass'], ['model', 'server-pass'], [undefined, 'server-pass']]);
  } finally {
    await new Promise(done => server.close(() => done(undefined)));
  }
});

test('a locked home: every read is refused in the door\'s own sentence, its code and when to ask again, which a tool answers as its error', async () => {
  const locked = 'Lifestream is locked: unlock it on your Mac.';
  const server = createServer((_request, response) => {
    response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '60' }).end(JSON.stringify({ code: 'LOCKED', message: locked }));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  try {
    const address = /** @type {import('node:net').AddressInfo} */ (server.address());
    const door = openDoor({ url: `http://127.0.0.1:${address.port}`, authorization: 'Bearer test-pass' });
    for (const read of [() => door.json('/v1/days'), () => door.text('/v1/days/2026-01-02'), () => door.post('/v1/search', { query: 'x' })]) {
      const refused = await read().then(() => null, error => error);
      assert.ok(refused instanceof DoorRefusal);
      assert.deepEqual({ message: refused.message, status: refused.status, code: refused.code, retryAfter: refused.retryAfter }, { message: locked, status: 503, code: 'LOCKED', retryAfter: 60 });
    }
  } finally {
    await new Promise(done => server.close(() => done(undefined)));
  }
});
