// @ts-check
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { bundledProgram } from '../../testing/program.mjs';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHandler } from '../server.mjs';
import { openHandles } from '../lib/ask/handles.mjs';
import { DoorRefusal } from '../lib/errors.mjs';
import { openWrapper } from '../lib/hiding.mjs';
import { NOTICE } from '../lib/shape.mjs';
import { ASK_TOOLS, INSTRUCTIONS, NOTE_IT, UNREAD_ACCESS, search, serverOf } from '../lib/tools.mjs';
import { ONE_OF } from '../lib/tools/access.mjs';
import { until } from './until.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const MAIL = 'gmail:person-a@example.com';
const FULL = 'Your access to this Lifestream:\n1. Everything · all time\n2. nothing hidden\nAsk for more, or drop a line, with `access`.';
const OUTSIDE = 'Outside your access.';

/** @param {string} name */
const fixture = name => JSON.parse(readFileSync(new URL(`../../packages/home/test/contract/${name}.json`, import.meta.url), 'utf8'));

/**
 * @param {Record<string, () => unknown>} routes
 * @param {string} [access]
 */
function fakeDoor(routes, access = FULL) {
  /** @type {{ path: string, headers?: Record<string, string> }[]} */
  const asked = [];
  const door = {
    pass: 'p',
    asked,
    forModel() { return door; },
    async json(/** @type {string} */ path, /** @type {unknown} */ _params, /** @type {Record<string, string> | undefined} */ headers) {
      asked.push({ path, ...(headers === undefined ? {} : { headers }) });
      if (path === '/v1/access') return { text: access };
      throw new Error(`the fake door has no GET ${path}`);
    },
    async post(/** @type {string} */ path) {
      asked.push({ path });
      const answer = routes[path];
      if (answer === undefined) throw new Error(`the fake door has no ${path}`);
      return answer();
    },
  };
  return door;
}

/** @param {ReturnType<typeof fakeDoor>} door */
async function connected(door) {
  const [near, far] = InMemoryTransport.createLinkedPair();
  const server = serverOf(/** @type {any} */ ({ door }), () => undefined);
  await server.connect(far);
  const client = new Client({ name: 'synthetic-agent', version: '1.0.0' });
  await client.connect(near);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

/** @param {any} result */
const textOf = result => result.content.filter((/** @type {any} */ part) => part.type === 'text').map((/** @type {any} */ part) => part.text).join('\n');

test('initialize reads the agent\'s own access once, as a new session, and the instructions end with the door\'s lines; an access the door does not give is said in its words', async () => {
  const door = fakeDoor({});
  const { client, close } = await connected(door);
  try {
    assert.equal(client.getInstructions(), `${INSTRUCTIONS}\n\n${FULL}`);
    assert.deepEqual(door.asked, [{ path: '/v1/access', headers: { 'lifestream-session': 'new' } }]);
  } finally {
    await close();
  }
  const refused = fakeDoor({});
  const refusal = new DoorRefusal(401, 'PRINCIPAL_UNKNOWN', 'no such pass', null);
  refused.json = async () => { throw refusal; };
  const unread = await connected(refused);
  try {
    const said = String(unread.client.getInstructions());
    assert.equal(said, `${INSTRUCTIONS}\n\n${UNREAD_ACCESS} ${refusal.message}`);
    assert.ok(['401', 'PRINCIPAL_UNKNOWN', 'no such pass'].every(part => said.includes(part)), said);
  } finally {
    await unread.close();
  }
});

test('an answer the door says matched more than the access holds ends with the notice, its JSON whole above it; one that withheld nothing carries none; Chat reads the same handles under it', async () => {
  const door = fakeDoor({ '/v1/search': () => fixture('search-outside') });
  const { client, close } = await connected(door);
  try {
    const text = textOf(await client.callTool({ name: 'search', arguments: { query: 'invoice' } }));
    const [json, notice, ...rest] = text.split('\n');
    assert.deepEqual([notice, rest], [NOTICE, []], text);
    assert.equal(JSON.parse(json).record.hits.length, 1);
  } finally {
    await close();
  }
  const kept = await connected(fakeDoor({ '/v1/search': () => fixture('search') }));
  try {
    const text = textOf(await kept.client.callTool({ name: 'search', arguments: { query: 'example' } }));
    assert.ok(!text.includes(NOTICE), text.slice(-200));
    assert.ok(JSON.parse(text).record.hits.length > 0);
  } finally {
    await kept.close();
  }
  const hidden = fixture('search-hidden');
  const chat = openWrapper({ table: 'chat:c1', agent: false });
  const under = await chat.run(search, { query: 'example' }, { door: /** @type {any} */ (fakeDoor({ '/v1/search': () => ({ ...hidden, outside: true }) })) });
  const plain = await chat.run(search, { query: 'example' }, { door: /** @type {any} */ (fakeDoor({ '/v1/search': () => hidden })) });
  assert.ok(under.text.endsWith(`\n${NOTICE}`), under.text.slice(-120));
  const given = openHandles().ran(under);
  assert.ok(given.length > 0);
  assert.deepEqual(given, openHandles().ran(plain));
});

test('a ref outside the access answers the door\'s words alone: no note to send feedback, nothing of what it is', async () => {
  const door = fakeDoor({ '/v1/read': () => { throw new DoorRefusal(403, 'OUTSIDE_ACCESS', OUTSIDE, null, { code: 'OUTSIDE_ACCESS', message: OUTSIDE }); } });
  const { client, close } = await connected(door);
  try {
    const result = /** @type {any} */ (await client.callTool({ name: 'read', arguments: { ref: 'r1' } }));
    assert.deepEqual([result.isError, textOf(result)], [true, OUTSIDE]);
    assert.doesNotMatch(textOf(result), new RegExp(NOTE_IT.slice(0, 20), 'u'));
  } finally {
    await close();
  }
});

/** @type {import('node:child_process').ChildProcessByStdio<import('node:stream').Writable, import('node:stream').Readable, null>} */
let child;
/** @type {{ url: string, tokens: { agent: string, phone: string }, phone: string, now_ms: number, ask: { machine: string } }} */
let home;
/** @type {((line: any) => void)[]} */
const waiting = [];
/** @type {import('node:http').Server[]} */
const servers = [];
let url = '';

/**
 * @param {string} cmd
 * @param {Record<string, unknown>} [more]
 */
async function command(cmd, more = {}) {
  /** @type {{ came: boolean, line: any }} */
  const answer = { came: false, line: null };
  waiting.push(line => Object.assign(answer, { came: true, line }));
  child.stdin.write(`${JSON.stringify({ ...more, cmd })}\n`);
  await until(`the synthetic home's answer to ${cmd}`, () => {
    if (answer.came) return true;
    if (child.exitCode !== null) throw new Error(`the synthetic home exited before it answered ${cmd}`);
    return false;
  });
  assert.equal(answer.line.ok, true, answer.line.error);
  return answer.line.value;
}

/** @param {string} pass */
async function connect(pass) {
  const client = new Client({ name: 'lifestream-access', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${pass}` } } }));
  return client;
}

/** @typedef {{ tool: string, session: number, result: string }} Call */

const HOUR = 3_600_000;

/** @param {Client} client */
async function ownAccess(client) {
  const result = /** @type {any} */ (await client.callTool({ name: 'access', arguments: {} }));
  assert.equal(result.isError, undefined, textOf(result));
  const text = textOf(result);
  const at = text.lastIndexOf('\n\n');
  /** @type {{ version: number, lines: string[], request: { id: string } | null, answer: { id: string, state: string } | null, outside: string[] }} */
  const data = JSON.parse(text.slice(at + 2));
  return { lines: text.slice(0, at), data };
}

const callsSince = async (/** @type {number} */ mark) => /** @type {Call[]} */ (await command('calls')).slice(mark);
const mark = async () => /** @type {Call[]} */ (await command('calls')).length;

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
  const server = createServer(createHandler({ door: home.url, machine: home.ask.machine, log: () => undefined }));
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  servers.push(server);
  url = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
});

after(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise(done => server.close(() => done(undefined)));
  }
  if (child) await command('stop').catch(() => undefined);
});

test('through the real door: the instructions name the agent\'s lines; narrowed to one mailbox, a search that matched its messages too carries the notice; the next session\'s instructions name the narrowed lines; each initialize starts a session', async () => {
  const since = await mark();
  const first = await connect(home.tokens.agent);
  /** @type {Awaited<ReturnType<typeof ownAccess>> | undefined} */
  let opened;
  try {
    opened = await ownAccess(first);
    assert.equal(first.getInstructions(), `${INSTRUCTIONS}\n\n${opened.lines}`);
    const whole = textOf(await first.callTool({ name: 'search', arguments: { query: 'lighthouse', lists: ['record'] } }));
    assert.ok(!whole.includes(NOTICE), whole.slice(-200));
    const products = new Set(JSON.parse(whole).record.hits.map((/** @type {any} */ hit) => hit.product));
    assert.ok(products.has('gmail') && products.size > 1, [...products].join(', '));

    await command('access', { access: { allow: [{ reach: { account: MAIL, but: [] }, window: null, until_ms: null }], items: [], not: [], only: [], window: null, hide: 'none', shown: [] } });
    const narrowed = /** @type {any} */ (await first.callTool({ name: 'search', arguments: { query: 'lighthouse', lists: ['record'] } }));
    assert.equal(narrowed.isError, undefined, textOf(narrowed));
    const [json, notice] = textOf(narrowed).split('\n');
    assert.equal(notice, NOTICE, textOf(narrowed).slice(-200));
    assert.deepEqual([...new Set(JSON.parse(json).record.hits.map((/** @type {any} */ hit) => hit.product))], ['gmail']);
  } finally {
    await first.close();
  }

  const second = await connect(home.tokens.agent);
  try {
    const narrowed = await ownAccess(second);
    assert.equal(second.getInstructions(), `${INSTRUCTIONS}\n\n${narrowed.lines}`);
    assert.notDeepEqual(narrowed.data.lines, opened?.data.lines);
    assert.deepEqual([opened?.data.outside, narrowed.data.outside.includes('WhatsApp')], [[], true], narrowed.lines);
    const later = /** @type {any} */ (await second.callTool({ name: 'search', arguments: { query: 'lighthouse', lists: ['record'] } }));
    assert.equal(later.isError, undefined, textOf(later));
  } finally {
    await second.close();
    await command('access', { access: { allow: [{ reach: { all: true, but: [] }, window: null, until_ms: null }], items: [], not: [], only: [], window: null, hide: 'none', shown: [] } });
  }

  const calls = await callsSince(since);
  const searches = calls.filter(({ tool }) => tool === 'search');
  const session = searches[0]?.session ?? 0;
  assert.deepEqual(searches.map(each => [each.result, each.session - session]), [['answered', 0], ['answered', 0], ['answered', 1]], JSON.stringify(calls));
  assert.ok(calls.every(each => each.result === 'answered' && (each.session === session || each.session === session + 1)), JSON.stringify(calls));
});

const OWN = new URL('../../homelink/Tests/Fixtures/agents/own/', import.meta.url);

test('the `access` tool, on /mcp alone and not read-only, prints each answer the door\'s contract files hold: the access as lines and data, a request\'s words, a drop\'s words and the access after it, a refusal in the door\'s words', async () => {
  const files = readdirSync(OWN).filter(name => name.endsWith('.json')).sort();
  assert.ok(files.length >= 15, files.join(', '));
  for (const file of files) {
    const kept = JSON.parse(readFileSync(new URL(file, OWN), 'utf8'));
    const [method, path] = kept.route.split(' ');
    /** @type {{ method: string, path: string, body?: unknown }[]} */
    const sent = [];
    const answer = () => {
      if (kept.status !== 200) throw new DoorRefusal(kept.status, kept.answer.code, kept.answer.message, null, kept.answer);
      return kept.answer;
    };
    const door = {
      pass: 'p', forModel() { return door; },
      async json(/** @type {string} */ asked, /** @type {unknown} */ _params, /** @type {Record<string, string> | undefined} */ headers) {
        if (headers?.['lifestream-session'] === 'new') return { text: FULL };
        sent.push({ method: 'GET', path: asked });
        return answer();
      },
      async post(/** @type {string} */ asked, /** @type {unknown} */ body) {
        sent.push({ method: 'POST', path: asked, body });
        return answer();
      },
    };
    const { client, close } = await connected(/** @type {any} */ (door));
    try {
      const args = method === 'GET' ? {} : kept.request;
      const result = /** @type {any} */ (await client.callTool({ name: 'access', arguments: args }));
      assert.deepEqual(sent, [{ method, path, ...(method === 'POST' ? { body: kept.request } : {}) }], `${file}: one call to the door`);
      const text = textOf(result);
      if (kept.status !== 200) {
        assert.equal(result.isError, true, file);
        assert.ok(text.startsWith(kept.answer.message), `${file}: ${text}`);
      } else if (path === '/v1/access') {
        const [lines, data] = text.split('\n\n');
        assert.equal(lines, kept.answer.text, file);
        assert.deepEqual(JSON.parse(data ?? ''), { version: kept.answer.version, lines: kept.answer.lines, request: kept.answer.request, answer: kept.answer.answer, outside: kept.answer.outside }, file);
      } else if (path === '/v1/access/drop') {
        assert.equal(text, `${kept.answer.words}\n\n${kept.answer.now.text}`, file);
      } else {
        assert.equal(text, kept.answer.words, file);
      }
    } finally {
      await close();
    }
  }
  const { client, close } = await connected(fakeDoor({}));
  try {
    const { tools } = await client.listTools();
    const tool = tools.find(each => each.name === 'access');
    assert.deepEqual(tool?.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    const both = /** @type {any} */ (await client.callTool({ name: 'access', arguments: { drop: 1, reason: 'Both at once.' } }));
    assert.deepEqual([both.isError, textOf(both).startsWith(ONE_OF)], [true, true]);
    const noReason = /** @type {any} */ (await client.callTool({ name: 'access', arguments: { request: { read: 'everything' } } }));
    assert.deepEqual([noReason.isError, textOf(noReason).startsWith(ONE_OF)], [true, true]);
    const versionAlone = /** @type {any} */ (await client.callTool({ name: 'access', arguments: { version: 3 } }));
    assert.deepEqual([versionAlone.isError, textOf(versionAlone).startsWith(ONE_OF)], [true, true]);
  } finally {
    await close();
  }
  assert.equal(ASK_TOOLS.some(each => each.name === 'access'), false, 'Chat has its own tool for access, not this one');
});

test('through the real door: `access` reads the lines, drops one at once, asks for Mail with its reason as written; the person allows it on the phone, the next `access` says so and the next search reads under it', async () => {
  const since = await mark();
  const client = await connect(home.tokens.agent);
  /** @param {Record<string, unknown>} args */
  const access = async args => {
    const result = /** @type {any} */ (await client.callTool({ name: 'access', arguments: args }));
    assert.equal(result.isError, undefined, textOf(result));
    return textOf(result);
  };
  /** @param {string} method @param {string} path @param {unknown} [body] */
  const phone = async (method, path, body) => {
    const response = await fetch(`${home.url}${path}`, { method, headers: {
      authorization: `Bearer ${home.tokens.phone}`, 'lifestream-device': home.phone, ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, 200, await response.clone().text());
    return /** @type {any} */ (await response.json());
  };
  try {
    const first = await ownAccess(client);
    assert.equal(client.getInstructions(), `${INSTRUCTIONS}\n\n${first.lines}`);
    const dropped = await access({ drop: 1, version: first.data.version });
    const after = await ownAccess(client);
    assert.ok(dropped.endsWith(`\n\n${after.lines}`), dropped);
    assert.deepEqual([after.data.lines.length, after.data.version > first.data.version], [first.data.lines.length - 1, true], after.lines);
    const nothing = /** @type {any} */ (await client.callTool({ name: 'search', arguments: { query: 'lighthouse', lists: ['record'] } }));
    assert.equal(JSON.parse(textOf(nothing).split('\n')[0]).record.hits.length, 0, 'a drop narrows at once');

    const reason = 'The lighthouse tickets, for [[Person 1]].';
    await access({ request: { read: { category: 'mail' }, past: '30d' }, for: '2h', reason });
    const { asks } = await phone('GET', '/v1/agents/waiting');
    assert.equal(asks.length, 1);
    const [ask] = asks;
    assert.deepEqual([ask.by, ask.reason, ask.default], ['agent', reason, 'once']);
    assert.deepEqual(ask.proposed.allow.at(-1), { reach: { type: 'mail', but: [] }, window: { past_ms: 30 * 24 * HOUR }, lasts_ms: 2 * HOUR });
    assert.equal((await ownAccess(client)).data.request?.id, ask.id, 'the next `access` says the request waits');
    assert.equal((await phone('POST', '/v1/agents/answer', { id: ask.id, answer: 'once', expect: ask.version })).state, 'allowed');
    const allowed = (await ownAccess(client)).data;
    assert.deepEqual([allowed.request, allowed.answer?.id, allowed.answer?.state], [null, ask.id, 'allowed']);
    const mail = /** @type {any} */ (await client.callTool({ name: 'search', arguments: { query: 'lighthouse', lists: ['record'] } }));
    const [json, notice] = textOf(mail).split('\n');
    assert.deepEqual([...new Set(JSON.parse(json).record.hits.map((/** @type {any} */ hit) => hit.product))], ['gmail']);
    assert.equal(notice, NOTICE);
  } finally {
    await client.close();
    await command('access', { access: { allow: [{ reach: { all: true, but: [] }, window: null, until_ms: null }], items: [], not: [], only: [], window: null, hide: 'none', shown: [] } });
  }
  const calls = await callsSince(since);
  const acts = ['access', 'access', 'access', 'search', 'access', 'access', 'access', 'search'];
  const tools = calls.map(({ tool }) => tool);
  let at = 0;
  for (const act of acts) {
    at = tools.indexOf(act, at) + 1;
    assert.ok(at > 0, `each act a History line, in order: ${tools.join(', ')}`);
  }
  assert.deepEqual([calls.filter(({ tool }) => tool === 'search').length, new Set(calls.map(({ session }) => session)).size], [2, 1], JSON.stringify(calls));
  assert.ok(calls.every(({ result }) => result === 'answered'), JSON.stringify(calls));
});
