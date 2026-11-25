// @ts-check
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { bundledProgram } from '../../testing/program.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { OAuthClientInformationFullSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import { AGENT_ONLY_WORDS, createHandler, serve } from '../server.mjs';
import { SKILL_FILE } from '../lib/tools.mjs';
import { readClientDocument } from '../lib/agents/clients.mjs';
import { until } from './until.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const ARTIFACT = fileURLToPath(new URL('../.build/e2e/agent-signin.json', import.meta.url));
const ORIGIN = 'https://macbook-pro-0001.tailnet-0000.ts.net';
const RESOURCE = `${ORIGIN}/mcp`;
const CHALLENGE = `Bearer error="invalid_token", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="read"`;
const INITIALIZE = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic-agent', version: '1' } } };
const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const LOOPBACK_REDIRECT = 'http://127.0.0.1:47001/callback';

/** @type {import('node:child_process').ChildProcessByStdio<import('node:stream').Writable, import('node:stream').Readable, null>} */
let child;
/** @type {{ url: string, tokens: { reader: string, agent: string, anywhere: string, phone: string, mac: string }, phone: string, ask: { machine: string } }} */
let home;
/** @type {((line: any) => void)[]} */
const waiting = [];
/** @type {import('node:http').Server[]} */
const servers = [];
let listener = '';
let skew = 0;
/** @type {Record<string, unknown>[]} */
const logged = [];
/** @type {Map<string, number>} */
const fetched = new Map();
/** @type {{ arrived: () => void, released: Promise<void>, lost: boolean | 'unknown' } | null} */
let held = null;
const UNKNOWN = 'Lifestream did not answer in time: it may have kept the change.';
/** @param {{ lost?: boolean | 'unknown' }} [options] */
function hold({ lost = false } = {}) {
  let asked = false;
  /** @type {() => void} */
  let release = () => undefined;
  held = { arrived: () => { asked = true; }, released: new Promise(done => { release = () => done(undefined); }), lost };
  return { asked: () => asked, release: () => release() };
}
let reachable = true;
/** @type {Record<string, unknown[]>} */
const artifact = {};
let current = '';
/** @param {string} name */
const named = name => {
  current = name;
  artifact[name] = [];
};
/** @param {unknown} line */
const note = line => void artifact[current]?.push(JSON.parse(redact(JSON.stringify(line))));

/** @param {string} text */
function redact(text) {
  return text
    .replace(/((?:access_token|refresh_token|code|code_verifier|code_challenge|client_id|id)(?:\\?"\s*:\s*\\?"|=))([^"&\\\s]+)/gu, (_, name, value) => `${name}${value.startsWith('https') ? value : '<redacted>'}`)
    .replace(/Bearer [A-Za-z0-9\-_.~]+/gu, 'Bearer <redacted>')
    .replace(/\/oauth\/wait\/[A-Za-z0-9\-_]+/gu, '/oauth/wait/<id>');
}

/** @param {Record<string, unknown>} command */
async function command(command) {
  const answer = new Promise(done => waiting.push(done));
  child.stdin.write(`${JSON.stringify(command)}\n`);
  const line = await answer;
  assert.equal(line.ok, true, line.error);
  return line.value;
}

/** @param {import('node:http').RequestListener} handler */
async function listen(handler) {
  const server = createServer(handler);
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  servers.push(server);
  return `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
}

/**
 * @param {boolean} kept
 * @returns {typeof fetch}
 */
const funnelOf = kept => async (input, init) => {
  const asked = new Request(input, init);
  if (!asked.url.startsWith(`${ORIGIN}/`)) throw new Error(`the client asked ${asked.url}, which is not the public address`);
  const body = asked.method === 'GET' || asked.method === 'HEAD' ? undefined : await asked.text();
  const answer = await fetch(`${listener}${asked.url.slice(ORIGIN.length)}`, { method: asked.method, headers: asked.headers, ...(body === undefined ? {} : { body }), redirect: 'manual' });
  const said = await answer.text();
  if (kept) {
    note({
      request: `${asked.method} ${asked.url}`, ...(asked.headers.has('authorization') ? { authorization: asked.headers.get('authorization') } : {}), ...(body === undefined ? {} : { body }),
      status: answer.status, ...(answer.headers.has('www-authenticate') ? { 'www-authenticate': answer.headers.get('www-authenticate') } : {}),
      answer: /^\s*</u.test(said) ? 'the sign-in page' : said,
    });
  }
  return new Response(said === '' && [204, 304].includes(answer.status) ? null : said, { status: answer.status, headers: answer.headers });
};
const funnel = funnelOf(false);

/**
 * @param {string} path
 * @param {Record<string, string>} headers
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, body: string }>}
 */
const rawGet = (path, headers) => new Promise((done, fail) => {
  const asked = httpRequest(`${listener}${path}`, { headers }, answer => {
    let body = '';
    answer.on('data', chunk => { body += chunk; });
    answer.on('end', () => done({ status: answer.statusCode ?? 0, headers: answer.headers, body }));
  });
  asked.on('error', fail);
  asked.end();
});

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/**
 * @param {string} name
 * @param {string[]} redirects
 */
async function registered(name, redirects) {
  const response = await funnel(`${ORIGIN}/oauth/register`, { method: 'POST', body: JSON.stringify({ client_name: name, redirect_uris: redirects }), headers: { 'content-type': 'application/json' } });
  assert.equal(response.status, 201);
  return /** @type {string} */ ((/** @type {any} */ (await response.json())).client_id);
}

/** @param {Record<string, string | undefined>} params */
async function opened(params) {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) if (value !== undefined) query.set(name, value);
  const response = await funnel(`${ORIGIN}/oauth/authorize?${query}`);
  const html = await response.text();
  const island = /<script type="application\/json" id="data">([\s\S]*?)<\/script>/u.exec(html)?.[1];
  assert.ok(island !== undefined, html);
  return { status: response.status, html, headers: response.headers, data: /** @type {any} */ (JSON.parse(island)), location: response.headers.get('location') };
}

/**
 * @param {string} clientId
 * @param {string} redirect
 * @param {Record<string, string | undefined>} [rest]
 */
function asking(clientId, redirect, rest = {}) {
  const { verifier, challenge } = pkce();
  return {
    verifier,
    params: { response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'synthetic-state', resource: RESOURCE, ...rest },
  };
}

const phoneHeaders = () => ({ authorization: `Bearer ${home.tokens.phone}`, 'lifestream-device': home.phone, 'content-type': 'application/json' });

/** @returns {Promise<any[]>} */
async function onPhone() {
  const response = await fetch(`${home.url}/v1/agents/waiting`, { headers: phoneHeaders() });
  assert.equal(response.status, 200);
  return (/** @type {any} */ (await response.json())).requests;
}

/**
 * @param {string} id
 * @param {string | 'deny'} answer
 */
async function tap(id, answer) {
  const response = await fetch(`${home.url}/v1/agents/answer`, { method: 'POST', body: JSON.stringify({ id, answer }), headers: phoneHeaders() });
  assert.equal(response.status, 200);
  return (/** @type {any} */ (await response.json())).state;
}

/** @param {{ wait: string }} data */
const idOf = data => /** @type {string} */ (data.wait.split('/').at(-1));

/**
 * @param {{ wait: string }} data
 * @returns {Promise<{ state: string, redirect?: string }>}
 */
async function waited(data) {
  /** @type {any} */
  let answer = null;
  await until('the sign-in answered', async () => {
    answer = await (await funnel(`${ORIGIN}${data.wait}`)).json();
    return answer.state !== 'waiting';
  });
  return answer;
}

/**
 * @param {string} clientId
 * @param {string} redirect
 * @param {Record<string, string | undefined>} [rest]
 */
async function codeFor(clientId, redirect, rest) {
  const { verifier, params } = asking(clientId, redirect, rest);
  const page = await opened(params);
  assert.equal(page.status, 200, JSON.stringify(page.data));
  assert.equal(await tap(idOf(page.data), page.data.confirm), 'approved');
  const { state, redirect: sent } = await waited(page.data);
  assert.equal(state, 'approved');
  const url = new URL(/** @type {string} */ (sent));
  return { code: /** @type {string} */ (url.searchParams.get('code')), verifier, url, id: idOf(page.data) };
}

/** @param {Record<string, string>} form */
async function traded(form) {
  const response = await funnel(`${ORIGIN}/oauth/token`, { method: 'POST', body: new URLSearchParams(form).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  return { status: response.status, cache: [response.headers.get('cache-control'), response.headers.get('pragma')], body: /** @type {any} */ (await response.json()) };
}

/**
 * @param {string} token
 * @param {unknown} [message]
 */
async function initialized(token, message = INITIALIZE) {
  const response = await funnel(`${ORIGIN}/mcp`, { method: 'POST', body: JSON.stringify(message), headers: { ...MCP_HEADERS, authorization: `Bearer ${token}` } });
  return { status: response.status, challenge: response.headers.get('www-authenticate'), body: /** @type {any} */ (await response.json()) };
}

/** @type {Map<string, (signal: AbortSignal) => Promise<import('../lib/guarded.mjs').Answer>>} */
const documents = new Map();
/** @param {unknown} body */
const served = body => async () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(body)) });

class Agent {
  /** @param {string} redirect */
  constructor(redirect) {
    this.redirect = redirect;
    /** @type {import('@modelcontextprotocol/sdk/shared/auth.js').OAuthClientInformationMixed | undefined} */
    this.client = undefined;
    /** @type {import('@modelcontextprotocol/sdk/shared/auth.js').OAuthTokens | undefined} */
    this.saved = undefined;
    /** @type {URL | null} */
    this.opened = null;
    this.verifier = '';
  }

  get redirectUrl() { return this.redirect; }
  get clientMetadata() {
    return { client_name: 'Synthetic Agent', redirect_uris: [this.redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
  }

  state() { return 'synthetic-state'; }
  clientInformation() { return this.client; }
  /** @param {import('@modelcontextprotocol/sdk/shared/auth.js').OAuthClientInformationMixed} client */
  saveClientInformation(client) { this.client = client; }
  tokens() { return this.saved; }
  /** @param {import('@modelcontextprotocol/sdk/shared/auth.js').OAuthTokens} tokens */
  saveTokens(tokens) { this.saved = tokens; }
  /** @param {URL} url */
  redirectToAuthorization(url) { this.opened = url; }
  /** @param {string} verifier */
  saveCodeVerifier(verifier) { this.verifier = verifier; }
  codeVerifier() { return this.verifier; }
  /** @param {'all' | 'client' | 'tokens' | 'verifier' | 'discovery'} scope */
  invalidateCredentials(scope) {
    if (scope === 'all' || scope === 'tokens') this.saved = undefined;
    if (scope === 'all' || scope === 'client') this.client = undefined;
  }
}

before(async () => {
  child = spawn(process.execPath, bundledProgram('mcp/test/home.ts'), { cwd: REPO, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout });
  home = await new Promise((done, fail) => {
    child.once('exit', code => fail(new Error(`the synthetic home exited with ${code}`)));
    lines.on('line', text => {
      const line = JSON.parse(text);
      if (line.ready) done(line);
      else waiting.shift()?.(line);
    });
  });
  await mkdir(join(home.ask.machine, 'mcp'), { recursive: true });
  await writeFile(join(home.ask.machine, 'mcp', 'public.json'), JSON.stringify({ origin: ORIGIN }));
  /** @type {import('../lib/guarded.mjs').Get} */
  const get = async (url, { signal }) => {
    fetched.set(url.href, (fetched.get(url.href) ?? 0) + 1);
    const answer = documents.get(url.href);
    if (answer === undefined) return { status: 404, headers: {}, body: Buffer.alloc(0) };
    return answer(signal);
  };
  const door = await listen((request, response) => {
    if (!reachable) return void request.socket.destroy();
    /** @param {boolean | 'unknown'} lost */
    const forward = lost => {
      const out = httpRequest(`${home.url}${request.url}`, { method: request.method, headers: { ...request.headers, host: new URL(home.url).host } }, answer => {
        if (lost === 'unknown') {
          return void answer.resume().once('end', () => {
            response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '5' }).end(JSON.stringify({ code: 'OUTCOME_UNKNOWN', message: UNKNOWN, again: false }));
          });
        }
        if (lost) return void answer.resume().once('end', () => request.socket.destroy());
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      });
      out.on('error', () => response.destroy());
      request.pipe(out);
    };
    const holding = held;
    if (request.method === 'POST' && request.url === '/v1/agents/grant' && holding !== null) {
      held = null;
      holding.arrived();
      return void holding.released.then(() => forward(holding.lost));
    }
    forward(false);
  });
  listener = await listen(createHandler({ door, machine: home.ask.machine, log: line => void logged.push(line) }).public({
    machine: home.ask.machine, now: () => Date.now() + skew, clientDocument: url => readClientDocument(url, { get, waitMs: 500 }),
  }));
});

after(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise(done => server.close(() => done(undefined)));
  }
  if (child) await command({ cmd: 'stop' }).catch(() => undefined);
  await mkdir(join(ARTIFACT, '..'), { recursive: true });
  await writeFile(ARTIFACT, `${JSON.stringify(artifact, null, 1)}\n`);
});


test('1: the whole flow as a client makes it: the SDK discovers, registers, opens the page, the person types its code on their phone, the code trades, its instructions name the new agent\'s access, the tools read, an hour later the token renews, and once the agent is removed initialize is 401', async () => {
  named('the whole flow');
  const agent = new Agent(LOOPBACK_REDIRECT);
  const kept = funnelOf(true);
  const url = new URL(RESOURCE);
  await assert.rejects(new Client({ name: 'synthetic-agent', version: '1' }).connect(new StreamableHTTPClientTransport(url, { authProvider: agent, fetch: kept })), UnauthorizedError);
  assert.ok(agent.client !== undefined && agent.opened !== null);
  OAuthClientInformationFullSchema.parse(agent.client);
  assert.equal(agent.opened.origin + agent.opened.pathname, `${ORIGIN}/oauth/authorize`);
  assert.deepEqual([agent.opened.searchParams.get('resource'), agent.opened.searchParams.get('code_challenge_method'), agent.opened.searchParams.get('state')], [RESOURCE, 'S256', 'synthetic-state']);
  const page = await kept(agent.opened.href);
  const html = await page.text();
  const data = JSON.parse(/** @type {string} */ (/<script type="application\/json" id="data">([\s\S]*?)<\/script>/u.exec(html)?.[1]));
  note({ page: { name: data.name, line: data.line, confirm: 'the code' } });
  assert.deepEqual([page.status, data.name, data.line], [200, 'Synthetic Agent', 'says it is Synthetic Agent, an app on the computer you are signing in from']);
  assert.match(String(data.confirm), /^[0-9]{6}$/u);
  assert.match(html, /<p class="gets">You choose what it reads where you approve it\. It can't change your record\.<\/p>/u);
  const shown = (await onPhone()).find(each => each.id === idOf(data));
  note({ phone: { name: shown.name, checked: shown.checked, host: shown.host, holds_code: JSON.stringify(shown).includes(data.confirm) } });
  assert.deepEqual([shown.name, shown.checked, shown.host, 'choices' in shown, JSON.stringify(shown).includes(`"${data.confirm}"`)], ['Synthetic Agent', false, null, false, false],
    'the phone is never shown the code: only the page the person opened is');
  assert.equal(await tap(shown.id, data.confirm), 'approved');
  const answer = await waited(data);
  const back = new URL(/** @type {string} */ (answer.redirect));
  note({ wait: answer.state, redirect: `${back.origin}${back.pathname}`, iss: back.searchParams.get('iss'), state: back.searchParams.get('state') });
  assert.deepEqual([back.origin + back.pathname, back.searchParams.get('iss'), back.searchParams.get('state')], [LOOPBACK_REDIRECT, ORIGIN, 'synthetic-state']);
  const first = new StreamableHTTPClientTransport(url, { authProvider: agent, fetch: kept });
  await first.finishAuth(/** @type {string} */ (back.searchParams.get('code')));
  const tokens = /** @type {import('@modelcontextprotocol/sdk/shared/auth.js').OAuthTokens} */ (agent.saved);
  assert.deepEqual([tokens.token_type, tokens.expires_in, tokens.scope, typeof tokens.refresh_token], ['Bearer', 3600, 'read', 'string']);
  const client = new Client({ name: 'synthetic-agent', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(url, { authProvider: agent, fetch: kept }));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), ['search_people', 'search', 'count', 'read', 'feedback', 'access']);
  assert.equal(client.getServerVersion()?.title, 'Lifestream');
  assert.match(String(client.getInstructions()), /\n\nYour access to this Lifestream:\n1\. Everything but Health and Money · all time\n2\. details hidden\n(?:.*\n)?Ask for more, or drop a line, with `access`\.$/u);
  const found = /** @type {{ content: { text: string }[], isError?: boolean }} */ (await client.callTool({ name: 'search', arguments: { query: 'lighthouse' } }));
  assert.equal(found.isError, undefined, found.content[0]?.text);
  assert.ok(JSON.parse(found.content[0]?.text ?? '{}').record.hits.length > 0);
  const notes = /** @type {any[]} */ (await command({ cmd: 'notes' })).length;
  const saved = /** @type {{ content: { text: string }[], isError?: boolean }} */ (await client.callTool({ name: 'feedback', arguments: { category: 'missing', message: 'A filter by chat for photos.', tool: 'search' } }));
  note({ feedback: saved.content[0]?.text });
  assert.equal(saved.content[0]?.text, 'Saved.');
  const grant = /** @type {any} */ (await (await fetch(`${home.url}/v1/me`, { headers: { authorization: `Bearer ${/** @type {any} */ (agent.saved).access_token}`, 'lifestream-reach': 'public' } })).json()).id;
  assert.deepEqual(/** @type {any[]} */ (await command({ cmd: 'notes' })).slice(notes).map(({ pass, who }) => ({ pass, who })), [{ pass: grant, who: 'Synthetic Agent' }]);
  await command({ cmd: 'clock', add_ms: 3_600_000 + 60_000 });
  const again = /** @type {{ content: { text: string }[], isError?: boolean }} */ (await client.callTool({ name: 'search', arguments: { query: 'lighthouse' } }));
  assert.equal(again.isError, undefined, again.content[0]?.text);
  const renewed = /** @type {import('@modelcontextprotocol/sdk/shared/auth.js').OAuthTokens} */ (agent.saved);
  assert.notEqual(renewed.access_token, tokens.access_token);
  assert.notEqual(renewed.refresh_token, tokens.refresh_token);
  assert.equal((await initialized(tokens.access_token)).status, 401);
  await client.close();
  const me = /** @type {any} */ (await (await fetch(`${home.url}/v1/me`, { headers: { authorization: `Bearer ${renewed.access_token}`, 'lifestream-reach': 'public' } })).json());
  assert.equal(me.kind, 'agent');
  await command({ cmd: 'revoke', id: me.id });
  const removed = await initialized(renewed.access_token);
  note({ removed: { status: removed.status, challenge: removed.challenge } });
  assert.deepEqual([removed.status, removed.challenge], [401, CHALLENGE]);
  agent.opened = null;
  await assert.rejects(new Client({ name: 'synthetic-agent', version: '1' }).connect(new StreamableHTTPClientTransport(url, { authProvider: agent, fetch: kept })), UnauthorizedError);
  assert.ok(agent.opened !== null, 'the client was sent to sign in again');
});

test('2: a dead, revoked or copied token, the dashboard\'s or a phone\'s, on the public /mcp: HTTP 401 with the challenge at initialize and at tools/list, nothing dispatched', async () => {
  named('refused tokens');
  const clientId = await registered('Synthetic Revoked', [LOOPBACK_REDIRECT]);
  const { code, verifier } = await codeFor(clientId, LOOPBACK_REDIRECT);
  const tokens = await traded({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: LOOPBACK_REDIRECT, resource: RESOURCE });
  assert.equal(tokens.status, 200);
  assert.equal((await initialized(tokens.body.access_token)).status, 200);
  const me = /** @type {any} */ (await (await fetch(`${home.url}/v1/me`, { headers: { authorization: `Bearer ${tokens.body.access_token}`, 'lifestream-reach': 'public' } })).json());
  await command({ cmd: 'revoke', id: me.id });
  const list = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
  const toolsBefore = logged.filter(line => line.tool !== undefined).length;
  const refusedBefore = logged.filter(line => line.mcp === 'pass refused').length;
  for (const [who, token] of [['dead', 'synthetic-dead-token'.padEnd(43, 'd')], ['revoked', tokens.body.access_token], ['copied', home.tokens.agent], ['reader', home.tokens.reader], ['phone', home.tokens.phone]]) {
    for (const message of [INITIALIZE, list]) {
      const refused = await initialized(token, message);
      note({ token: who, method: /** @type {any} */ (message).method, status: refused.status, challenge: refused.challenge, answer: refused.body });
      assert.deepEqual([refused.status, refused.challenge, refused.body.result], [401, CHALLENGE, undefined], `${who} ${/** @type {any} */ (message).method}`);
    }
  }
  assert.equal(logged.filter(line => line.tool !== undefined).length, toolsBefore);
  assert.equal(logged.filter(line => line.mcp === 'pass refused').length, refusedBefore + 10);
  const bare = await funnel(`${ORIGIN}/mcp`, { method: 'POST', body: JSON.stringify(INITIALIZE), headers: MCP_HEADERS });
  assert.deepEqual([bare.status, bare.headers.get('www-authenticate')], [401, `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="read"`]);
});

test('3: the public listener serves its own paths alone: 404 to the door, Ask and the rest, 405 to GET /mcp, the skill\'s file to GET /mcp/skill, 503 everywhere while the internet address is off, served again the moment it is on', async () => {
  named('the public listener');
  for (const path of ['/ask', '/ask/login', '/v1/status', '/v1/me', '/', '/.well-known/openid-configuration', '/oauth', '/mcp/x']) {
    const response = await funnel(`${ORIGIN}${path}`);
    note({ path, status: response.status });
    assert.equal(response.status, 404, path);
  }
  const stream = await funnel(`${ORIGIN}/mcp`, { headers: { accept: 'text/event-stream' } });
  assert.deepEqual([stream.status, stream.headers.get('allow')], [405, 'POST']);
  const skill = await funnel(`${ORIGIN}/mcp/skill`);
  assert.deepEqual([skill.status, await skill.text()], [200, SKILL_FILE]);
  assert.equal((await funnel(`${ORIGIN}/mcp/skill`, { method: 'POST', body: '{}' })).status, 405);
  const file = join(home.ask.machine, 'mcp', 'public.json');
  await rm(file);
  const loggedBefore = logged.length;
  try {
    const id = 'synthetic-request-id-0000000001';
    for (const path of [`/oauth/wait/${id}`, '/mcp', '/.well-known/oauth-authorization-server', '/oauth/authorize', '/nothing']) {
      const response = await funnel(`${ORIGIN}${path}`, path === '/mcp' ? { method: 'POST', body: '{}', headers: MCP_HEADERS } : {});
      const said = await response.text();
      note({ off: path, status: response.status, said });
      assert.deepEqual([response.status, said], [503, "Lifestream's internet address is off on this Mac"], path);
    }
    assert.equal(logged.slice(loggedBefore).filter(line => JSON.stringify(line).includes(id)).length, 0);
  } finally {
    await writeFile(file, JSON.stringify({ origin: ORIGIN }));
  }
  assert.equal((await funnel(`${ORIGIN}/.well-known/oauth-authorization-server`)).status, 200);
});

test('4: a Host or X-Forwarded-Host header changes no URL in the documents, the page or a redirect', async () => {
  named('the origin is the file\'s');
  const forged = { host: 'attacker.example', 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'http' };
  const resource = await rawGet('/.well-known/oauth-protected-resource/mcp', forged);
  const server = await rawGet('/.well-known/oauth-authorization-server', forged);
  note({ resource: JSON.parse(resource.body), server: JSON.parse(server.body) });
  assert.deepEqual(JSON.parse(resource.body), { resource: RESOURCE, authorization_servers: [ORIGIN], scopes_supported: ['read'], bearer_methods_supported: ['header'], resource_name: 'Lifestream' });
  assert.deepEqual(JSON.parse((await rawGet('/.well-known/oauth-protected-resource', forged)).body), JSON.parse(resource.body));
  assert.deepEqual(JSON.parse(server.body), {
    issuer: ORIGIN, authorization_endpoint: `${ORIGIN}/oauth/authorize`, token_endpoint: `${ORIGIN}/oauth/token`, registration_endpoint: `${ORIGIN}/oauth/register`,
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'], client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true, scopes_supported: ['read'],
  });
  assert.equal(`${resource.body}${server.body}`.includes('attacker'), false);
  const clientId = await registered('Synthetic Forged', [LOOPBACK_REDIRECT]);
  const { params } = asking(clientId, LOOPBACK_REDIRECT);
  const page = await rawGet(`/oauth/authorize?${new URLSearchParams(params)}`, forged);
  assert.equal(page.status, 200);
  assert.equal(page.body.includes('attacker'), false);
  const data = JSON.parse(/** @type {string} */ (/<script type="application\/json" id="data">([\s\S]*?)<\/script>/u.exec(page.body)?.[1]));
  await tap(idOf(data), data.confirm);
  const sent = JSON.parse((await rawGet(data.wait, forged)).body);
  assert.equal(new URL(sent.redirect).searchParams.get('iss'), ORIGIN);
  assert.equal(sent.redirect.includes('attacker'), false);
  const challenged = await new Promise((done, fail) => {
    const asked = httpRequest(`${listener}/mcp`, { method: 'POST', headers: { ...forged, ...MCP_HEADERS } }, answer => {
      answer.resume();
      answer.on('end', () => done(answer.headers['www-authenticate']));
    });
    asked.on('error', fail);
    asked.end(JSON.stringify(INITIALIZE));
  });
  assert.equal(challenged, `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="read"`);
});

test('5, 16: a client named with a script is shown its name as text: the page holds no markup of it, and runs only its own script; Lifestream\'s mark above its head, inline, loading nothing', async () => {
  named('a name is text');
  const name = '<script>alert(1)</script> Synthetic </script><b>Agent</b>';
  const clientId = await registered(name, [LOOPBACK_REDIRECT]);
  const page = await opened(asking(clientId, LOOPBACK_REDIRECT).params);
  note({ name: page.data.name, scripts: (page.html.match(/<script/gu) ?? []).length });
  assert.equal(page.status, 200);
  assert.equal(page.data.name, name);
  assert.equal(page.html.includes('alert(1)</script>'), false);
  assert.equal(page.html.includes('<b>Agent'), false);
  assert.equal((page.html.match(/<script/gu) ?? []).length, 2);
  assert.equal((page.html.match(/<\/script>/gu) ?? []).length, 2);
  assert.match(String(page.headers.get('content-security-policy')), /script-src 'sha256-[A-Za-z0-9+/=]+'; /u);
  assert.match(page.html, /textContent/u);
  assert.equal(page.html.includes('innerHTML'), false);
  const mark = readFileSync(new URL('../../design/marks/logo-macos-dark.svg', import.meta.url), 'utf8');
  const inline = `<span class="mark" aria-hidden="true">${mark.trim()}</span>`;
  note({ mark: { inline: page.html.includes(inline), before_head: page.html.indexOf(inline) < page.html.indexOf('<h1') } });
  assert.ok(page.html.includes(inline), 'the page holds the mark as the design file holds it');
  assert.ok(page.html.indexOf(inline) < page.html.indexOf('<h1'), 'the mark is above the head');
  assert.match(/** @type {string} */ (await (await funnel(`${ORIGIN}/oauth/signin.css`)).text()), /^\.mark \{ width: \d+px; height: \d+px; \}$/mu);
  assert.deepEqual(page.html.match(/\b(?:src|href)=/gu), ['href=']);
  assert.match(page.html, /<link rel="stylesheet" href="\/oauth\/signin.css">/u);
  assert.match(String(page.headers.get('content-security-policy')), /^default-src 'none'; style-src 'self'; script-src 'sha256-[A-Za-z0-9+/=]+'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'$/u);
  await tap(idOf(page.data), 'deny');
});

test('5b: a wrong code turns the sign-in away for good: the page is sent access_denied and no code, the right code after it changes nothing', async () => {
  named('a wrong code');
  const clientId = await registered('Synthetic Guesser', [LOOPBACK_REDIRECT]);
  const page = await opened(asking(clientId, LOOPBACK_REDIRECT).params);
  assert.equal(page.status, 200);
  const right = String(page.data.confirm);
  const wrong = right === '000000' ? '000001' : '000000';
  assert.equal(await tap(idOf(page.data), wrong), 'wrong');
  const answer = await waited(page.data);
  const back = new URL(/** @type {string} */ (answer.redirect));
  note({ wait: answer.state, error: back.searchParams.get('error'), code: back.searchParams.has('code') });
  assert.deepEqual([answer.state, back.searchParams.get('error'), back.searchParams.has('code')], ['wrong', 'access_denied', false]);
  assert.equal(await tap(idOf(page.data), right), 'wrong', 'one answer per sign-in: the right code after a wrong one is not a yes');
  const again = /** @type {any} */ (await (await funnel(`${ORIGIN}${page.data.wait}`)).json());
  assert.notEqual(again.state, 'approved');
});

test('6, 13, 15: registration: the answer the SDK parses, sealed, its id under 4 KB however much it states; a tampered id is no client; a redirect never stated gets the error page and no redirect; http off loopback is refused; loopback on another port is taken, the app named as only saying who it is', async () => {
  named('registration');
  const response = await funnel(`${ORIGIN}/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Synthetic Registered', redirect_uris: [LOOPBACK_REDIRECT, 'https://agent.example/callback'], token_endpoint_auth_method: 'client_secret_post', application_type: 'native' }),
  });
  const body = /** @type {any} */ (await response.json());
  note({ status: response.status, body });
  assert.equal(response.status, 201);
  OAuthClientInformationFullSchema.parse(body);
  const { client_id: clientId, ...rest } = body;
  assert.deepEqual(rest, {
    client_name: 'Synthetic Registered', redirect_uris: [LOOPBACK_REDIRECT, 'https://agent.example/callback'], token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  });
  const tampered = `${clientId.slice(0, -2)}${clientId.endsWith('AA') ? 'BB' : 'AA'}`;
  const refused = await opened(asking(tampered, LOOPBACK_REDIRECT).params);
  note({ tampered: { status: refused.status, error: refused.data.error } });
  assert.deepEqual([refused.status, refused.location], [400, null]);
  assert.match(refused.data.error, /an app Lifestream doesn't know/u);
  const token = await traded({ grant_type: 'refresh_token', refresh_token: 'x'.repeat(43), client_id: tampered, resource: RESOURCE });
  assert.deepEqual([token.status, token.body.error], [400, 'invalid_grant']);
  const unstated = await opened(asking(clientId, 'https://attacker.example/callback').params);
  note({ unstated: { status: unstated.status, error: unstated.data.error } });
  assert.deepEqual([unstated.status, unstated.location, unstated.html.includes('attacker.example/callback?')], [400, null, false]);
  assert.match(unstated.data.error, /an address the app didn't state/u);
  for (const redirect of ['http://agent.example/callback', 'https://agent.example/callback#part', 'javascript:alert(1)']) {
    const bad = await funnel(`${ORIGIN}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Synthetic', redirect_uris: [redirect] }) });
    const said = /** @type {any} */ (await bad.json());
    note({ redirect, status: bad.status, error: said.error });
    assert.deepEqual([bad.status, said.error], [400, 'invalid_redirect_uri'], redirect);
  }
  const other = await opened(asking(clientId, 'http://127.0.0.1:52999/callback').params);
  note({ otherPort: { status: other.status, line: other.data.line } });
  assert.deepEqual([other.status, other.data.name, other.data.line], [200, 'Synthetic Registered', 'says it is Synthetic Registered, an app on the computer you are signing in from']);
  await tap(idOf(other.data), 'deny');
  const stated = await opened(asking(clientId, 'https://agent.example/callback').params);
  assert.deepEqual([stated.status, stated.data.line], [200, 'says it is Synthetic Registered, sending access to agent.example']);
  await tap(idOf(stated.data), 'deny');
  /** @param {number} n @param {number} length */
  const long = (n, length) => `https://agent.example/${String(n)}${'p'.repeat(length - 'https://agent.example/'.length - 1)}`;
  /** @param {unknown} body */
  const register = async body => {
    const answer = await funnel(`${ORIGIN}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: answer.status, body: /** @type {any} */ (await answer.json()) };
  };
  const most = await register({ client_name: `${'\ud800'.repeat(200)}`, redirect_uris: [1, 2, 3, 4].map(n => long(n, 510)) });
  note({ most: { status: most.status, id_length: most.body.client_id?.length } });
  assert.equal(most.status, 201);
  assert.ok(most.body.client_id.length < 4096, String(most.body.client_id.length));
  for (const [why, redirects] of /** @type {[string, string[]][]} */ ([['five', [1, 2, 3, 4, 5].map(n => long(n, 100))], ['too long', [long(1, 511)]]])) {
    const bad = await register({ client_name: 'Synthetic Large', redirect_uris: redirects });
    note({ refused: why, status: bad.status, error: bad.body.error });
    assert.deepEqual([bad.status, bad.body.error], [400, 'invalid_redirect_uri'], why);
  }
});

test('7: a client\'s own description: one naming another client, without none, too large, too slow or redirected is refused; ChatGPT\'s, none beside private_key_jwt, is taken and named from its host', async () => {
  named('client descriptions');
  const base = 'https://client.example/oauth';
  const redirect = 'https://client.example/callback';
  /** @param {string} url @param {Record<string, unknown>} [more] */
  const described = (url, more = {}) => ({ client_id: url, client_name: 'Synthetic Described', redirect_uris: [redirect], token_endpoint_auth_method: 'none', ...more });
  documents.set(`${base}/other.json`, served(described(`${base}/someone-else.json`)));
  documents.set(`${base}/secret.json`, served(described(`${base}/secret.json`, { token_endpoint_auth_method: 'private_key_jwt' })));
  documents.set(`${base}/large.json`, served(described(`${base}/large.json`, { padding: 'x'.repeat(70 * 1024) })));
  documents.set(`${base}/slow.json`, signal => new Promise((_, fail) => signal.addEventListener('abort', () => fail(new Error('aborted')))));
  documents.set(`${base}/moved.json`, async () => ({ status: 302, headers: { location: `${base}/elsewhere.json` }, body: Buffer.alloc(0) }));
  documents.set(`${base}/nameless.json`, served({ ...described(`${base}/nameless.json`), client_name: undefined }));
  for (const [file, said] of /** @type {[string, RegExp][]} */ ([
    ['other.json', /names another app/u], ['secret.json', /signs in with a secret/u], ['large.json', /larger than 64 KB/u],
    ['slow.json', /did not answer within/u], ['moved.json', /redirected/u], ['nameless.json', /gives no name/u], ['missing.json', /answered 404/u],
  ])) {
    const page = await opened(asking(`${base}/${file}`, redirect).params);
    note({ document: file, status: page.status, error: page.data.error });
    assert.deepEqual([page.status, page.location], [400, null], file);
    assert.match(page.data.error, said, file);
  }
  const chatgpt = 'https://chatgpt.example/oauth/client-metadata.json';
  documents.set(chatgpt, served({
    client_id: chatgpt, client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.example/connector_platform_oauth_redirect'], token_endpoint_auth_method: 'private_key_jwt',
    token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'], jwks_uri: 'https://chatgpt.example/oauth/jwks.json', grant_types: ['authorization_code', 'refresh_token'],
  }));
  const taken = await opened(asking(chatgpt, 'https://chatgpt.example/connector_platform_oauth_redirect').params);
  note({ chatgpt: { status: taken.status, name: taken.data.name, line: taken.data.line } });
  assert.deepEqual([taken.status, taken.data.name, taken.data.line], [200, 'ChatGPT', 'from chatgpt.example']);
  const shown = (await onPhone()).find(each => each.id === idOf(taken.data));
  assert.deepEqual([shown.name, shown.checked, shown.host], ['ChatGPT', true, 'chatgpt.example']);
  assert.equal(await tap(idOf(taken.data), taken.data.confirm), 'approved');
});

test('8: authorize: plain or no challenge refused; a resource with a trailing slash and no state taken; a reload shows the same request', async () => {
  named('authorize');
  const clientId = await registered('Synthetic Authorize', [LOOPBACK_REDIRECT]);
  const { challenge } = pkce();
  for (const [why, rest] of /** @type {[string, Record<string, string | undefined>][]} */ ([
    ['plain', { code_challenge: challenge, code_challenge_method: 'plain' }], ['no challenge', { code_challenge: undefined, code_challenge_method: undefined }],
    ['no method', { code_challenge_method: undefined }], ['another resource', { resource: 'https://other.example/mcp' }], ['a token', { response_type: 'token' }],
  ])) {
    const page = await opened(asking(clientId, LOOPBACK_REDIRECT, rest).params);
    note({ refused: why, status: page.status, error: page.data.error });
    assert.deepEqual([page.status, page.location], [400, null], why);
  }
  const { code, url } = await codeFor(clientId, LOOPBACK_REDIRECT, { resource: `${RESOURCE}/`, state: undefined });
  note({ noState: [...url.searchParams.keys()] });
  assert.deepEqual([...url.searchParams.keys()].sort(), ['code', 'iss']);
  assert.ok(code.length >= 43);
  const capitals = await opened(asking(clientId, LOOPBACK_REDIRECT, { resource: RESOURCE.replace('https://macbook', 'HTTPS://MACBOOK') }).params);
  assert.equal(capitals.status, 200);
  await tap(idOf(capitals.data), 'deny');
  const same = asking(clientId, LOOPBACK_REDIRECT);
  const first = await opened(same.params);
  const reloaded = await opened(same.params);
  note({ reload: idOf(first.data) === idOf(reloaded.data) && first.data.confirm === reloaded.data.confirm });
  assert.deepEqual([idOf(reloaded.data), reloaded.data.confirm], [idOf(first.data), first.data.confirm]);
  assert.equal((await onPhone()).filter(each => each.id === idOf(first.data)).length, 1);
  await tap(idOf(first.data), 'deny');
  const denied = await waited(first.data);
  const back = new URL(/** @type {string} */ (denied.redirect));
  assert.deepEqual([denied.state, back.searchParams.get('error'), back.searchParams.get('iss'), back.searchParams.get('state'), back.searchParams.has('code')], ['denied', 'access_denied', ORIGIN, 'synthetic-state', false]);
});

test('9: a code used twice (its grant revoked), after 60 s, with another verifier, redirect, client or resource: invalid_grant; every token answer no-store', async () => {
  named('codes');
  const clientId = await registered('Synthetic Codes', [LOOPBACK_REDIRECT, 'http://127.0.0.1:47002/other']);
  const otherId = await registered('Synthetic Other', [LOOPBACK_REDIRECT]);
  /** @param {{ code: string, verifier: string }} signed */
  const form = ({ code, verifier }) => ({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: LOOPBACK_REDIRECT, resource: RESOURCE });
  const twice = await codeFor(clientId, LOOPBACK_REDIRECT);
  const first = await traded(form(twice));
  note({ first: { status: first.status, cache: first.cache, token_type: first.body.token_type, expires_in: first.body.expires_in, scope: first.body.scope } });
  assert.deepEqual([first.status, first.cache, first.body.token_type, first.body.expires_in, first.body.scope], [200, ['no-store', 'no-cache'], 'Bearer', 3600, 'read']);
  assert.equal((await initialized(first.body.access_token)).status, 200);
  const second = await traded(form(twice));
  note({ second: { status: second.status, cache: second.cache, error: second.body.error } });
  assert.deepEqual([second.status, second.cache, second.body.error], [400, ['no-store', 'no-cache'], 'invalid_grant']);
  assert.equal((await initialized(first.body.access_token)).status, 401);
  const refreshed = await traded({ grant_type: 'refresh_token', refresh_token: first.body.refresh_token, client_id: clientId, resource: RESOURCE });
  assert.deepEqual([refreshed.body.error, refreshed.body.error_description], ['invalid_grant', 'This agent was disconnected. Sign in again.'], 'a disconnected grant\'s refresh says so, in the home\'s words');
  for (const [why, change] of /** @type {[string, (asked: Record<string, string>) => Record<string, string>][]} */ ([
    ['another verifier', asked => ({ ...asked, code_verifier: pkce().verifier })],
    ['another redirect', asked => ({ ...asked, redirect_uri: 'http://127.0.0.1:47002/other' })],
    ['another client', asked => ({ ...asked, client_id: otherId })],
    ['another resource', asked => ({ ...asked, resource: 'https://other.example/mcp' })],
    ['no verifier', ({ code_verifier: _, ...asked }) => asked],
  ])) {
    const refused = await traded(change(form(await codeFor(clientId, LOOPBACK_REDIRECT))));
    note({ wrong: why, status: refused.status, error: refused.body.error, cache: refused.cache });
    assert.deepEqual([refused.status, refused.body.error, refused.cache], [400, 'invalid_grant', ['no-store', 'no-cache']], why);
  }
  const late = await codeFor(clientId, LOOPBACK_REDIRECT);
  skew += 61_000;
  try {
    const refused = await traded(form(late));
    note({ late: { status: refused.status, error: refused.body.error } });
    assert.deepEqual([refused.status, refused.body.error], [400, 'invalid_grant']);
  } finally {
    skew -= 61_000;
  }
  assert.deepEqual((await traded({ grant_type: 'password', username: 'x', password: 'y' })).body.error, 'unsupported_grant_type');
  assert.deepEqual((await traded({ grant_type: 'authorization_code' })).body.error, 'invalid_request');
  const good = await traded(form(await codeFor(clientId, LOOPBACK_REDIRECT)));
  assert.equal(good.status, 200);
  const turned = await traded({ grant_type: 'refresh_token', refresh_token: good.body.refresh_token, client_id: clientId, resource: RESOURCE });
  note({ refreshed: { status: turned.status, cache: turned.cache } });
  assert.deepEqual([turned.status, turned.cache], [200, ['no-store', 'no-cache']]);
  assert.notEqual(turned.body.refresh_token, good.body.refresh_token);
});

test('8: authorize checks the request before it reads the client: a description is fetched only once the code, the challenge and the resource pass, and never for a reload', async () => {
  named('authorize order');
  const url = 'https://ordered.example/oauth/client.json';
  const redirect = 'https://ordered.example/callback';
  documents.set(url, served({ client_id: url, client_name: 'Synthetic Ordered', redirect_uris: [redirect], token_endpoint_auth_method: 'none' }));
  const { challenge } = pkce();
  for (const [why, rest] of /** @type {[string, Record<string, string | undefined>][]} */ ([
    ['a token', { response_type: 'token' }], ['plain', { code_challenge: challenge, code_challenge_method: 'plain' }], ['another resource', { resource: 'https://other.example/mcp' }],
  ])) {
    const page = await opened(asking(url, redirect, rest).params);
    note({ refused: why, status: page.status, fetched: fetched.get(url) ?? 0 });
    assert.deepEqual([page.status, fetched.get(url) ?? 0], [400, 0], why);
  }
  const same = asking(url, redirect);
  const first = await opened(same.params);
  const reloaded = await opened(same.params);
  note({ shown: first.status, reloaded: reloaded.status, fetched: fetched.get(url) });
  assert.deepEqual([first.status, reloaded.status, idOf(reloaded.data), fetched.get(url)], [200, 200, idOf(first.data), 1]);
  await tap(idOf(first.data), 'deny');
});

test('10: a code presented again while its first trade is in flight: both trades refused, and the grant the first made revoked', async () => {
  named('a replay in flight');
  const clientId = await registered('Synthetic In Flight', [LOOPBACK_REDIRECT]);
  const signed = await codeFor(clientId, LOOPBACK_REDIRECT);
  const form = { grant_type: 'authorization_code', code: signed.code, code_verifier: signed.verifier, client_id: clientId, redirect_uri: LOOPBACK_REDIRECT, resource: RESOURCE };
  const grant = hold();
  const first = traded(form);
  await until('the first trade asked the home for its grant', grant.asked);
  const second = await traded(form);
  note({ second: { status: second.status, error: second.body.error } });
  assert.deepEqual([second.status, second.body.error], [400, 'invalid_grant']);
  grant.release();
  const answered = await first;
  note({ first: { status: answered.status, error: answered.body.error } });
  assert.deepEqual([answered.status, answered.body.error, answered.body.access_token], [400, 'invalid_grant', undefined]);
  const grants = /** @type {{ name: string, revoked: boolean }[]} */ (await command({ cmd: 'grants' })).filter(each => each.name === 'Synthetic In Flight');
  note({ grants });
  assert.deepEqual(grants.map(each => each.revoked), [true]);
});

test('10: a code presented again after the home restarted, the request it came from forgotten: refused, and the grant it made revoked by its id', async () => {
  named('a replay after a restart');
  const clientId = await registered('Synthetic Restarted', [LOOPBACK_REDIRECT]);
  const signed = await codeFor(clientId, LOOPBACK_REDIRECT);
  const form = { grant_type: 'authorization_code', code: signed.code, code_verifier: signed.verifier, client_id: clientId, redirect_uri: LOOPBACK_REDIRECT, resource: RESOURCE };
  const first = await traded(form);
  assert.equal(first.status, 200);
  assert.equal((await initialized(first.body.access_token)).status, 200);
  await command({ cmd: 'restart' });
  const again = await traded(form);
  note({ again: { status: again.status, error: again.body.error } });
  assert.deepEqual([again.status, again.body.error], [400, 'invalid_grant']);
  const read = await initialized(first.body.access_token);
  note({ read: { status: read.status, challenge: read.challenge } });
  assert.deepEqual([read.status, read.challenge], [401, CHALLENGE]);
  assert.equal((await traded({ grant_type: 'refresh_token', refresh_token: first.body.refresh_token, client_id: clientId, resource: RESOURCE })).body.error, 'invalid_grant');
});

test('10: a code presented again while the home does not answer: refused, and the revoke sent again until the home is back, its tokens then refused', async () => {
  named('a replay while the home is away');
  const clientId = await registered('Synthetic Away', [LOOPBACK_REDIRECT]);
  const signed = await codeFor(clientId, LOOPBACK_REDIRECT);
  const form = { grant_type: 'authorization_code', code: signed.code, code_verifier: signed.verifier, client_id: clientId, redirect_uri: LOOPBACK_REDIRECT, resource: RESOURCE };
  const first = await traded(form);
  assert.equal(first.status, 200);
  const standing = async () => /** @type {{ name: string, revoked: boolean }[]} */ (await command({ cmd: 'grants' })).filter(each => each.name === 'Synthetic Away').map(each => each.revoked);
  reachable = false;
  try {
    const again = await traded(form);
    note({ again: { status: again.status, error: again.body.error }, grants: await standing() });
    assert.deepEqual([again.status, again.body.error, await standing()], [400, 'invalid_grant', [false]]);
  } finally {
    reachable = true;
  }
  await until('the revoke sent again once the home answers', async () => (await standing()).every(Boolean));
  const read = await initialized(first.body.access_token);
  note({ grants: await standing(), read: read.status });
  assert.deepEqual([await standing(), read.status], [[true], 401]);
  assert.equal((await traded({ grant_type: 'refresh_token', refresh_token: first.body.refresh_token, client_id: clientId, resource: RESOURCE })).body.error, 'invalid_grant');
});

test('10: a code presented again after the answer to its trade was lost: refused, and the grant the home made revoked by its request', async () => {
  named('a replay after a lost grant');
  const clientId = await registered('Synthetic Lost', [LOOPBACK_REDIRECT]);
  const signed = await codeFor(clientId, LOOPBACK_REDIRECT);
  const form = { grant_type: 'authorization_code', code: signed.code, code_verifier: signed.verifier, client_id: clientId, redirect_uri: LOOPBACK_REDIRECT, resource: RESOURCE };
  const standing = async () => /** @type {{ name: string, revoked: boolean }[]} */ (await command({ cmd: 'grants' })).filter(each => each.name === 'Synthetic Lost').map(each => each.revoked);
  hold({ lost: true }).release();
  const first = await traded(form);
  note({ first: { status: first.status, error: first.body.error }, grants: await standing() });
  assert.deepEqual([first.status, first.body.error, await standing()], [503, 'temporarily_unavailable', [false]]);
  const again = await traded(form);
  note({ again: { status: again.status, error: again.body.error }, grants: await standing() });
  assert.deepEqual([again.status, again.body.error, await standing()], [400, 'invalid_grant', [true]]);
});

test('18: a trade whose outcome the door does not know: invalid_grant in the door\'s words, never sent again; the code presented again revokes the grant the home made', async () => {
  named('a trade whose outcome is unknown');
  const clientId = await registered('Synthetic Unknown', [LOOPBACK_REDIRECT]);
  const signed = await codeFor(clientId, LOOPBACK_REDIRECT);
  const form = { grant_type: 'authorization_code', code: signed.code, code_verifier: signed.verifier, client_id: clientId, redirect_uri: LOOPBACK_REDIRECT, resource: RESOURCE };
  const standing = async () => /** @type {{ name: string, revoked: boolean }[]} */ (await command({ cmd: 'grants' })).filter(each => each.name === 'Synthetic Unknown').map(each => each.revoked);
  hold({ lost: 'unknown' }).release();
  const first = await traded(form);
  note({ first: { status: first.status, error: first.body.error, description: first.body.error_description }, grants: await standing() });
  assert.deepEqual([first.status, first.body.error, first.body.error_description, await standing()], [400, 'invalid_grant', UNKNOWN, [false]]);
  const again = await traded(form);
  note({ again: { status: again.status, error: again.body.error }, grants: await standing() });
  assert.deepEqual([again.status, again.body.error, await standing()], [400, 'invalid_grant', [true]]);
});

test('11: a tab reloaded once the code is minted: the page and its wait say the sign-in ended, the spent code never shown again; the client\'s own trade of it reads', async () => {
  named('a reload after the code');
  const clientId = await registered('Synthetic Reloaded', [LOOPBACK_REDIRECT]);
  const { verifier, params } = asking(clientId, LOOPBACK_REDIRECT);
  const page = await opened(params);
  assert.equal(await tap(idOf(page.data), page.data.confirm), 'approved');
  const sent = await waited(page.data);
  const code = /** @type {string} */ (new URL(/** @type {string} */ (sent.redirect)).searchParams.get('code'));
  const reloaded = await opened(params);
  const again = /** @type {any} */ (await (await funnel(`${ORIGIN}${page.data.wait}`)).json());
  note({ reloaded: { status: reloaded.status, data: reloaded.data }, wait: again });
  assert.deepEqual([reloaded.status, reloaded.data, reloaded.html.includes(code)], [410, { ended: true }, false]);
  assert.deepEqual(again, { state: 'gone' });
  const tokens = await traded({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: LOOPBACK_REDIRECT, resource: RESOURCE });
  assert.equal(tokens.status, 200);
  assert.equal((await initialized(tokens.body.access_token)).status, 200);
});

test('17: a copied pass made to read from anywhere: initialize and a tool read through the public /mcp, nothing refused', async () => {
  named('a pass from anywhere');
  const refusedBefore = logged.filter(line => line.mcp === 'pass refused').length;
  const opened = await initialized(home.tokens.anywhere);
  note({ initialize: opened.status, server: opened.body.result?.serverInfo?.name ?? null });
  assert.equal(opened.status, 200);
  const listed = await initialized(home.tokens.anywhere, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(listed.status, 200);
  assert.ok(listed.body.result.tools.some((/** @type {{ name: string }} */ tool) => tool.name === 'count'));
  const read = await initialized(home.tokens.anywhere, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'count', arguments: {} } });
  note({ tool: read.status, error: read.body.result?.isError ?? null });
  assert.equal(read.status, 200);
  assert.equal(read.body.error, undefined);
  assert.equal(read.body.result?.isError ?? false, false);
  assert.ok((read.body.result?.content ?? []).some((/** @type {{ type: string, text?: string }} */ part) => part.type === 'text' && (part.text ?? '').length > 0));
  assert.equal(logged.filter(line => line.mcp === 'pass refused').length, refusedBefore);
});

test('the operator\'s log blind where an agent fails: a pass refused or not an agent\'s says which listener and which client, a pass the door could not check is said, an agent\'s initialize is a session line naming its principal; never a pass', async () => {
  named('the operator\'s log');
  const lines = /** @type {Record<string, unknown>[]} */ ([]);
  const local = await listen(createHandler({ door: home.url, machine: home.ask.machine, log: line => void lines.push(line) }));
  const client = `Synthetic-Bot/1.0 ${'x'.repeat(100)}`;
  const cut = client.slice(0, 80);
  /**
   * @param {string} at
   * @param {string} pass
   * @param {string | null} agent
   * @param {unknown} [message]
   * @returns {Promise<{ status: number | undefined, said: string }>}
   */
  const posted = (at, pass, agent, message = INITIALIZE) => new Promise((done, failed) => {
    const body = JSON.stringify(message);
    const asked = httpRequest(`${at}/mcp`, { method: 'POST', headers: { ...MCP_HEADERS, authorization: `Bearer ${pass}`, 'content-length': Buffer.byteLength(body), ...(agent === null ? {} : { 'user-agent': agent }) } }, answer => {
      let said = '';
      answer.setEncoding('utf8').on('data', chunk => { said += chunk; }).on('end', () => done({ status: answer.statusCode, said }));
    });
    asked.on('error', failed);
    asked.end(body);
  });
  const dead = 'synthetic-dead-token'.padEnd(43, 'd');
  assert.equal((await posted(local, dead, client)).status, 401);
  assert.equal((await posted(local, dead, null)).status, 401);
  const before = logged.length;
  assert.equal((await funnel(`${ORIGIN}/mcp`, { method: 'POST', body: JSON.stringify(INITIALIZE), headers: { ...MCP_HEADERS, authorization: `Bearer ${dead}`, 'user-agent': client } })).status, 401);
  const reader = await posted(local, home.tokens.reader, client);
  assert.equal(reader.status, 403);
  const refusal = JSON.parse(reader.said);
  assert.deepEqual(refusal, { error: AGENT_ONLY_WORDS, code: 'AGENT_ONLY' });
  assert.match(refusal.error, /^This pass is not an agent's pass\. In Lifestream, open Settings, then Agents/u);
  assert.match(refusal.error, /Add an agent with a pass/u);
  const refused = lines.filter(line => line.mcp === 'pass refused' || line.mcp === 'refused a pass not an agent\'s');
  assert.deepEqual(refused.map(({ mcp, code, via, client: named }) => ({ mcp, code, via, client: named })), [
    { mcp: 'pass refused', code: 'PRINCIPAL_UNKNOWN', via: 'local', client: cut },
    { mcp: 'pass refused', code: 'PRINCIPAL_UNKNOWN', via: 'local', client: undefined },
    { mcp: 'refused a pass not an agent\'s', code: undefined, via: 'local', client: cut },
  ]);
  assert.equal('client' in /** @type {Record<string, unknown>} */ (refused[1]), false);
  assert.deepEqual(logged.slice(before).filter(line => line.mcp === 'pass refused').map(({ via, client: named }) => ({ via, client: named })), [{ via: 'public', client: cut }]);
  const me = /** @type {any} */ (await (await fetch(`${home.url}/v1/me`, { headers: { authorization: `Bearer ${home.tokens.anywhere}`, 'lifestream-reach': 'public' } })).json());
  const sessions = logged.filter(line => line.mcp === 'session').length;
  assert.equal((await funnel(`${ORIGIN}/mcp`, { method: 'POST', body: JSON.stringify(INITIALIZE), headers: { ...MCP_HEADERS, authorization: `Bearer ${home.tokens.anywhere}`, 'user-agent': client } })).status, 200);
  assert.equal((await initialized(home.tokens.anywhere, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).status, 200);
  await until('the session line', () => logged.filter(line => line.mcp === 'session').length > sessions);
  assert.deepEqual(logged.filter(line => line.mcp === 'session').slice(sessions), [{ mcp: 'session', via: 'public', principal: me.id, client: cut }]);
  reachable = false;
  try {
    assert.equal((await initialized(home.tokens.anywhere)).status, 503);
  } finally {
    reachable = true;
  }
  assert.deepEqual(logged.filter(line => line.mcp === 'pass unchecked').at(-1), { mcp: 'pass unchecked', via: 'public', status: 503, code: 'GONE' });
  for (const pass of [dead, home.tokens.reader, home.tokens.anywhere]) assert.ok(![...lines, ...logged].some(line => JSON.stringify(line).includes(pass)), 'a pass in the log');
});

test('12: a sign-in\'s token at a public address it was not granted for: 401 with that address\'s challenge, nothing dispatched; at its own, it reads', async () => {
  named('the resource is the current origin');
  const clientId = await registered('Synthetic Moved', [LOOPBACK_REDIRECT]);
  const signed = await codeFor(clientId, LOOPBACK_REDIRECT);
  const tokens = await traded({ grant_type: 'authorization_code', code: signed.code, code_verifier: signed.verifier, client_id: clientId, redirect_uri: LOOPBACK_REDIRECT, resource: RESOURCE });
  assert.equal(tokens.status, 200);
  const file = join(home.ask.machine, 'mcp', 'public.json');
  const moved = 'https://macbook-pro-0001.tailnet-1111.ts.net';
  await writeFile(file, JSON.stringify({ origin: moved }));
  try {
    const toolsBefore = logged.filter(line => line.tool !== undefined).length;
    const refused = await initialized(tokens.body.access_token);
    note({ moved: { status: refused.status, challenge: refused.challenge } });
    assert.deepEqual([refused.status, refused.challenge], [401, `Bearer error="invalid_token", resource_metadata="${moved}/.well-known/oauth-protected-resource/mcp", scope="read"`]);
    assert.equal(logged.filter(line => line.tool !== undefined).length, toolsBefore);
    const anywhere = await initialized(home.tokens.anywhere);
    note({ moved: { anywhere: anywhere.status } });
    assert.equal(anywhere.status, 200);
  } finally {
    await writeFile(file, JSON.stringify({ origin: ORIGIN }));
  }
  assert.equal((await initialized(tokens.body.access_token)).status, 200);
});

test('14: the public listener\'s port taken: the 4681 listener serves, and the failure is logged', async () => {
  named('the public port taken');
  const taken = await listen((_, response) => void response.writeHead(418).end());
  const port = Number(new URL(taken).port);
  const machine = await mkdtemp(join(tmpdir(), 'lifestream-mcp-public-taken-'));
  /** @type {Record<string, unknown>[]} */
  const lines = [];
  const served = await serve({ port: 0, publicPort: port, door: home.url, machine, log: line => void lines.push(line) });
  try {
    note({ public: served.public === null ? null : 'listening', publicPort: served.publicPort, logged: lines.map(line => line.public).filter(Boolean) });
    assert.deepEqual([served.public, served.publicPort], [null, null]);
    assert.ok(lines.some(line => line.public === `not listening on 127.0.0.1:${port}: EADDRINUSE; the next start tries again`), JSON.stringify(lines));
    const response = await fetch(`http://127.0.0.1:${served.port}/mcp`, { method: 'POST', body: JSON.stringify(INITIALIZE), headers: { ...MCP_HEADERS, authorization: `Bearer ${home.tokens.agent}` } });
    note({ local: response.status });
    assert.equal(response.status, 200);
  } finally {
    served.server.closeAllConnections();
    await new Promise(done => served.server.close(() => done(undefined)));
    await served.close(0);
    await rm(machine, { recursive: true, force: true });
  }
});
