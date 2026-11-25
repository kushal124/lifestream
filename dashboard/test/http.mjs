import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createViewer } from '../server.mjs';
import { SECURITY_HEADERS } from '../lib/http.mjs';

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

async function serve(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-http-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const server = await createViewer({ key: null });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server.address().port;
}

test('the page is served: every file under public/ by extension, the index at /, the two libraries and the design system tokens and icons at their URLs', async t => {
  const port = await serve(t);
  const expected = {
    '/': 'text/html',
    '/app.js': 'text/javascript',
    '/lib/html.js': 'text/javascript',
    '/ui/sections.js': 'text/javascript',
    '/pages/days.js': 'text/javascript',
    '/pages/connectors.js': 'text/javascript',
    '/kit.css': 'text/css',
    '/cockpit.css': 'text/css',
    '/icons.json': 'application/json',
    '/marked.js': 'text/javascript',
    '/purify.js': 'text/javascript',
  };
  for (const [path, type] of Object.entries(expected)) {
    const response = await raw(port, path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers['content-type'], type, path);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(response.headers[name.toLowerCase()], value, `${path} ${name}`);
  }
  assert.equal((await raw(port, '/')).body, await readFile(new URL('../public/index.html', import.meta.url), 'utf8'));
  assert.match((await raw(port, '/marked.js')).body, /marked/);
  assert.match((await raw(port, '/purify.js')).body, /DOMPurify/);
  assert.equal((await raw(port, '/cockpit.css')).body, await readFile(new URL('../../design/css/cockpit.css', import.meta.url), 'utf8'));
  assert.equal((await raw(port, '/kit.css')).body, await readFile(new URL('../../design/css/kit.css', import.meta.url), 'utf8'));
  assert.ok(JSON.parse((await raw(port, '/icons.json')).body).icons.days);
});

test('the static route refuses paths that leave public/, dotfiles, other extensions and other methods', async t => {
  const port = await serve(t);
  for (const path of ['/../server.mjs', '/%2e%2e/server.mjs', '/%2E%2E/%2E%2E/package.json', '/lib/..%2f..%2fserver.mjs', '/.local/x', '/.gitignore', '/lib/.hidden.js', '/types.d.ts', '/lib', '/server.mjs', '/nope.js', '/%E0%A4%A.js', '/app.js%00.css']) {
    const response = await raw(port, path);
    assert.equal(response.status, 404, path);
    assert.deepEqual(JSON.parse(response.body), { error: 'Not found.' }, path);
    assert.equal(response.headers['content-security-policy'], SECURITY_HEADERS['Content-Security-Policy'], path);
  }
  assert.equal((await raw(port, '/app.js', { method: 'POST' })).status, 404);
  const foreign = await raw(port, '/app.js', { headers: { host: 'example.invalid' } });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers['x-content-type-options'], 'nosniff');
});

test('the local-only check: a .localhost name on any port is this Mac, over http or https; anything else is foreign', async t => {
  const port = await serve(t);
  const status = async (host, origin) => (await raw(port, '/app.js', { headers: { host, ...(origin === undefined ? {} : { origin }) } })).status;
  for (const host of ['lifestream.localhost', 'lifestream.localhost:1355', 'LIFESTREAM.LOCALHOST', 'a.b.localhost:443', 'localhost', `localhost:${port}`, `127.0.0.1:${port}`]) {
    assert.equal(await status(host), 200, host);
  }
  for (const host of ['evil-localhost:1355', 'lifestream.localhost.evil.example', '.localhost', 'lifestream..localhost', 'lifestream.localhost:abc', 'lifestream.localhost:1355:1', '127.0.0.1', `127.0.0.1:${port + 1}`]) {
    assert.equal(await status(host), 403, host);
  }
  for (const origin of ['https://lifestream.localhost', 'https://lifestream.localhost:1355', 'http://lifestream.localhost:4317', `http://127.0.0.1:${port}`]) {
    assert.equal(await status('lifestream.localhost', origin), 200, origin);
  }
  for (const origin of ['https://evil.example', 'https://lifestream.localhost.evil.example', 'https://evil-localhost', 'ftp://lifestream.localhost', 'null', '', 'lifestream.localhost']) {
    assert.equal(await status('lifestream.localhost', origin), 403, origin);
  }
});

test('an over-long write is refused with 413 BODY_TOO_LARGE and its own message, before it is parsed, by its bytes', async t => {
  const port = await serve(t);
  const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Viewer-Request': '1' }, body });
  const long = await post('/api/act', 'x'.repeat(4097));
  assert.equal(long.status, 413);
  assert.deepEqual(await long.json(), { error: 'That act is too long.', code: 'BODY_TOO_LARGE' });
  const wide = await post('/api/act', 'é'.repeat(2049));
  assert.equal(wide.status, 413);
  const broken = await post('/api/act', '{not json');
  assert.equal(broken.status, 400);
  assert.deepEqual(await broken.json(), { error: 'Invalid act.' });
});

test('another site cannot load the dashboard as a resource: Sec-Fetch-Site cross-site or same-site refused, its own and none served, CORP on every answer', async t => {
  const port = await serve(t);
  const host = `127.0.0.1:${port}`;
  const asked = async (/** @type {string} */ path, /** @type {string | undefined} */ site) => {
    const response = await raw(port, path, { headers: { host, ...(site === undefined ? {} : { 'sec-fetch-site': site }) } });
    return { status: response.status, corp: response.headers['cross-origin-resource-policy'] };
  };
  const seen = {
    picture_cross: await asked('/api/life/picture?hash=sha256:' + '0'.repeat(64) + '&size=tile', 'cross-site'),
    script_cross: await asked('/app.js', 'cross-site'),
    same_site: await asked('/app.js', 'same-site'),
    own: await asked('/app.js', 'same-origin'),
    typed: await asked('/', 'none'),
    native: await asked('/app.js', undefined),
  };
  assert.deepEqual(seen, {
    picture_cross: { status: 403, corp: 'same-origin' }, script_cross: { status: 403, corp: 'same-origin' },
    same_site: { status: 403, corp: 'same-origin' },
    own: { status: 200, corp: 'same-origin' }, typed: { status: 200, corp: 'same-origin' }, native: { status: 200, corp: 'same-origin' },
  });
  assert.equal(SECURITY_HEADERS['Cross-Origin-Resource-Policy'], 'same-origin');
});
