import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createViewer } from '../server.mjs';
import { KEY_COOKIE, KEY_FILE, KEY_HEADER, viewerKey } from '../lib/viewer-key.mjs';

const KEY = 'a'.repeat(64);

function raw(port, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function serve(t, options) {
  const server = await createViewer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server.address().port;
}

const shut = response => response.status === 401 && JSON.parse(response.body).code === 'VIEWER_KEY';

test('an /api/ request without the key is refused, and the page itself still loads', async t => {
  const port = await serve(t, { key: KEY });
  assert.ok(shut(await raw(port, '/api/nope')));
  assert.ok(shut(await raw(port, '/api/act', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Viewer-Request': '1' } })));
  assert.equal((await raw(port, '/')).status, 200);
});

test('the key as a header passes the gate to the routes', async t => {
  const port = await serve(t, { key: KEY });
  const passed = await raw(port, '/api/nope', { headers: { [KEY_HEADER]: KEY } });
  assert.equal(passed.status, 404);
  assert.equal(JSON.parse(passed.body).error, 'Not found.');
});

test('a wrong key is refused, as a header, a cookie or a launch address', async t => {
  const port = await serve(t, { key: KEY });
  const wrong = 'b'.repeat(64);
  assert.ok(shut(await raw(port, '/api/nope', { headers: { [KEY_HEADER]: wrong } })));
  assert.ok(shut(await raw(port, '/api/nope', { headers: { [KEY_HEADER]: KEY.slice(1) } })));
  assert.ok(shut(await raw(port, '/api/nope', { headers: { Cookie: `${KEY_COOKIE}=${wrong}` } })));
  const launched = await raw(port, `/?k=${wrong}`);
  assert.equal(launched.status, 403);
  assert.equal(launched.headers['set-cookie'], undefined);
});

test('a launch address trades the key for a cookie and comes back without it', async t => {
  const port = await serve(t, { key: KEY });
  const launched = await raw(port, `/?view=days&k=${KEY}`);
  assert.equal(launched.status, 303);
  assert.equal(launched.headers.location, '/?view=days');
  const [cookie] = launched.headers['set-cookie'];
  assert.match(cookie, new RegExp(`^${KEY_COOKIE}=${KEY}; `));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const passed = await raw(port, '/api/nope', { headers: { Cookie: cookie.split(';')[0] } });
  assert.equal(passed.status, 404);
});

test('an /api/ route keeps its own k parameter', async t => {
  const port = await serve(t, { key: KEY });
  assert.ok(shut(await raw(port, `/api/nope?k=${KEY}`)));
  assert.equal((await raw(port, '/api/nope?k=3', { headers: { [KEY_HEADER]: KEY } })).status, 404);
});

test('with no key given, the dashboard makes one nobody holds, so /api/ stays shut', async t => {
  const port = await serve(t, {});
  assert.ok(shut(await raw(port, '/api/nope')));
});

test('the key file is made once, readable by its owner alone, and read back after', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-key-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = join(dir, 'dashboard');
  const made = viewerKey(state);
  assert.match(made, /^[0-9a-f]{64}$/u);
  assert.equal((await stat(join(state, KEY_FILE))).mode & 0o777, 0o600);
  assert.equal(viewerKey(state), made);
  writeFileSync(join(state, KEY_FILE), `${KEY}\n`);
  assert.equal(viewerKey(state), KEY);
  writeFileSync(join(state, KEY_FILE), 'not a key\n');
  assert.throws(() => viewerKey(state));
  assert.equal(readFileSync(join(state, KEY_FILE), 'utf8'), 'not a key\n');
});
