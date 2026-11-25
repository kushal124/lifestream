// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLOUDFLARE, CLOUDFLARE_KEY_ROUTE, cloudflareKey, cloudflareProvider, hidden, NO_LOGS } from '../lib/ask/cloudflare.mjs';
import { homeKey, KEY_ROUTE, OPENROUTER } from '../lib/ask/openrouter.mjs';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const TOKEN = 'synthetic-cloudflare-token_0001';
const HELD = `${ACCOUNT}:${TOKEN}`;

/** @param {import('@earendil-works/pi-ai').Credential | undefined} credential */
const resolved = credential => /** @type {any} */ (cloudflareProvider().auth.apiKey)
  .resolve({ credential, ctx: { env: async () => undefined }, signal: new AbortController().signal });

test('1: a held key is the account ID, a colon and the token', () => {
  assert.deepEqual(cloudflareKey(HELD), { account: ACCOUNT, token: TOKEN });
  for (const value of [undefined, '', TOKEN, `${ACCOUNT}:`, `${ACCOUNT.toUpperCase()}:${TOKEN}`, `${ACCOUNT}:a b`, `../${ACCOUNT}:${TOKEN}`]) assert.equal(cloudflareKey(value), null);
});

test('2: Chat reaches Cloudflare through the default gateway on the home\'s token, and asks it to log no bodies and cache nothing', async () => {
  const auth = await resolved({ type: 'api_key', key: HELD });
  assert.deepEqual(auth.env, { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_GATEWAY_ID: 'default' });
  assert.deepEqual(auth.auth.headers, { 'cf-aig-authorization': `Bearer ${TOKEN}`, Authorization: null, 'x-api-key': null, ...NO_LOGS });
  assert.deepEqual(NO_LOGS, { 'cf-aig-collect-log-payload': 'false', 'cf-aig-skip-cache': 'true' });
  assert.equal(await resolved(undefined), undefined);
  assert.equal(await resolved({ type: 'api_key', key: TOKEN }), undefined);
});

test('3: its models are the gateway\'s, its default among them', () => {
  const ids = cloudflareProvider().getModels().map(model => model.id);
  assert.ok(ids.includes(CLOUDFLARE.modelId), `${CLOUDFLARE.modelId} is a Cloudflare AI Gateway model`);
  assert.ok(cloudflareProvider().getModels().every(model => model.provider === CLOUDFLARE.provider));
});

test('4: a failure\'s words never hold the token', () => {
  assert.equal(hidden(`401 for ${TOKEN} and "${TOKEN}"`, new Set([TOKEN])), '401 for [the Cloudflare token] and "[the Cloudflare token]"');
});

test('5: the key store reads each provider\'s key from its own route, and no other provider\'s', async t => {
  const machine = mkdtempSync(join(tmpdir(), 'lifestream-cloudflare-'));
  t.after(() => rmSync(machine, { recursive: true, force: true }));
  mkdirSync(join(machine, 'ask'));
  writeFileSync(join(machine, 'ask', 'door-token'), 'synthetic-pass');
  /** @type {string[]} */
  const asked = [];
  const door = createServer((request, response) => {
    asked.push(`${request.headers.authorization} ${request.url}`);
    const key = request.url === CLOUDFLARE_KEY_ROUTE ? HELD : request.url === KEY_ROUTE ? 'sk-or-synthetic' : null;
    response.writeHead(key === null ? 404 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(key === null ? { code: 'NOT_SET', message: 'not set' } : { key }));
  });
  await new Promise(done => door.listen(0, '127.0.0.1', () => done(null)));
  t.after(() => door.close());
  const address = /** @type {import('node:net').AddressInfo} */ (door.address());
  const keys = homeKey({ machine, door: `http://127.0.0.1:${address.port}`, log: () => undefined,
    routes: { [OPENROUTER.provider]: KEY_ROUTE, [CLOUDFLARE.provider]: CLOUDFLARE_KEY_ROUTE } });
  assert.deepEqual(await keys.read(CLOUDFLARE.provider), { type: 'api_key', key: HELD });
  assert.deepEqual(await keys.read(OPENROUTER.provider), { type: 'api_key', key: 'sk-or-synthetic' });
  assert.equal(await keys.read('anthropic'), undefined);
  assert.deepEqual((await keys.list()).map(each => each.providerId).sort(), [CLOUDFLARE.provider, OPENROUTER.provider].sort());
  assert.deepEqual(asked, [`Bearer synthetic-pass ${CLOUDFLARE_KEY_ROUTE}`, `Bearer synthetic-pass ${KEY_ROUTE}`]);
});
