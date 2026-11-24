// @ts-check
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { bundledProgram } from '../../testing/program.mjs';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createHandler } from '../server.mjs';
import { until } from './until.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

/** @type {import('node:child_process').ChildProcessByStdio<import('node:stream').Writable, import('node:stream').Readable, null>} */
let child;
/** @type {{ root: string, url: string, day: string, ask: { machine: string } }} */
let home;
/** @type {((line: any) => void)[]} */
const waiting = [];
/** @type {import('node:http').Server[]} */
const servers = [];
let mcp = '';
/** @type {string[]} */
let lifestream = [];

/** @param {import('node:http').RequestListener} handler */
async function listen(handler) {
  const server = createServer(handler);
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  servers.push(server);
  return `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
}

/**
 * @param {string[]} words
 * @param {string} [at]
 */
async function cli(words, at = mcp) {
  const run = spawn(process.execPath, ['--import', './testing/process.mjs', ...lifestream, ...words, '--root', home.root],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LIFESTREAM_MCP: at, LIFESTREAM_MACHINE_DIR: home.ask.machine } });
  let out = '';
  let err = '';
  run.stdout.on('data', chunk => { out += chunk; });
  run.stderr.on('data', chunk => { err += chunk; });
  /** @type {{ done: boolean, code: number | null }} */
  const ended = { done: false, code: null };
  run.once('close', code => Object.assign(ended, { done: true, code }));
  await until(`lifestream ${words.join(' ')} ended`, () => ended.done);
  return { code: ended.code, out, err };
}

async function callGrant() {
  const listing = await cli(['agents', 'call']);
  assert.equal(listing.code, 0, listing.out + listing.err);
  const id = /"lifestream agents call" \((p-[0-9a-f]+)\)/u.exec(listing.out)?.[1];
  assert.ok(id !== undefined, listing.out);
  const listed = await cli(['agents', 'list', '--json']);
  assert.equal(listed.code, 0, listed.out + listed.err);
  const agents = /** @type {{ id: string, name: string }[]} */ (JSON.parse(listed.out).agents);
  assert.ok(!agents.some(agent => agent.id === id || agent.name === 'lifestream agents call'), listed.out);
  return id;
}

const kept = () => readFileSync(`${home.ask.machine}/agents-call/door-token`, 'utf8').trim();

/** @typedef {{ name: string, description?: string, inputSchema: { properties: Record<string, { type?: string, description?: string, items?: { enum?: unknown[] } }>, required?: string[] } }} Listed */

async function listedTools() {
  const json = await cli(['agents', 'call', '--json']);
  assert.equal(json.code, 0, json.out + json.err);
  return /** @type {Listed[]} */ (JSON.parse(json.out).tools);
}

/** @param {string[]} names */
const inOrder = names => new RegExp(`^.*${names.map(name => `\\b${name}\\b`).join('.*')}.*$`, 'mu');

/** @param {any} result */
const textOf = result => result.content.filter((/** @type {any} */ part) => part.type === 'text').map((/** @type {any} */ part) => part.text).join('\n');

async function bundledCommand() {
  const run = spawn(process.execPath, bundledProgram('mcp/test/lifestream.ts'), { cwd: REPO, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  run.stdout.on('data', chunk => { out += chunk; });
  const code = await new Promise(done => run.once('close', done));
  assert.equal(code, 0, `the bundled lifestream command: ${out}`);
  return /** @type {string[]} */ (JSON.parse(out));
}

async function syntheticHome() {
  child = spawn(process.execPath, bundledProgram('mcp/test/home.ts'), { cwd: REPO, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout });
  return /** @type {Promise<typeof home>} */ (new Promise((done, fail) => {
    child.once('exit', code => fail(new Error(`the synthetic home exited with ${code}`)));
    lines.on('line', text => {
      const line = JSON.parse(text);
      if (line.ready) done(line);
      else waiting.shift()?.(line);
    });
  }));
}

before(async () => {
  [home, lifestream] = await Promise.all([syntheticHome(), bundledCommand()]);
  mcp = await listen(createHandler({ door: home.url, machine: home.ask.machine, log: () => undefined }));
});

after(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise(done => server.close(() => done(undefined)));
  }
  if (child) {
    /** @type {{ came: boolean }} */
    const answer = { came: false };
    waiting.push(() => Object.assign(answer, { came: true }));
    child.stdin.write(`${JSON.stringify({ cmd: 'stop' })}\n`);
    await until('the synthetic home stopped', () => answer.came || child.exitCode !== null);
  }
});


test('the listing: every tool, each argument with its type, whether it may be left out and its words, the level it reads under', async () => {
  const listed = await cli(['agents', 'call']);
  assert.equal(listed.code, 0, listed.out + listed.err);
  const lines = listed.out.split('\n');
  const tools = await listedTools();
  assert.deepEqual(tools.map(tool => tool.name), ['search_people', 'search', 'count', 'read', 'feedback', 'access']);
  /** @type {Map<string, string[]>} */
  const blocks = new Map();
  for (const tool of tools) {
    const at = lines.findIndex(line => line.startsWith(`${tool.name}: `));
    assert.ok(at >= 0 && lines[at]?.includes(tool.description ?? ''), `${tool.name} listed with its words`);
    const end = lines.indexOf('', at);
    const block = lines.slice(at + 1, end < 0 ? undefined : end);
    blocks.set(tool.name, block);
    const required = new Set(tool.inputSchema.required ?? []);
    for (const [name, schema] of Object.entries(tool.inputSchema.properties)) {
      const said = block.find(line => line.startsWith(`  ${name}${required.has(name) ? '' : '?'}: `));
      assert.ok(said !== undefined && said.includes(schema.description ?? ''), `${tool.name}'s ${name}, left out or not, with its words`);
    }
  }
  const read = tools.find(tool => tool.name === 'read')?.inputSchema.properties;
  const readLines = blocks.get('read') ?? [];
  assert.equal(read?.from?.type, 'string');
  assert.ok(readLines.find(line => line.startsWith('  from?: '))?.includes('string'), 'from, with its type');
  const families = readLines.find(line => line.startsWith('  families?: ')) ?? '';
  assert.ok((read?.families?.items?.enum ?? []).length > 0 && (read?.families?.items?.enum ?? []).every(each => families.includes(JSON.stringify(each))), families);
  const grant = await callGrant();
  const head = lines.find(line => line.includes(`${mcp}/mcp`)) ?? '';
  for (const part of [`${mcp}/mcp`, `"lifestream agents call" (${grant})`, `lifestream agents access ${grant}`]) assert.ok(head.includes(part), `${part} in ${head}`);
  assert.ok(lines.some(line => line.includes('lifestream agents call <tool> ')), 'how to call one');
  assert.ok(!listed.out.includes(kept()));
});

test('a call: the tool\'s answer as the model reads it, --json the result; one grant across calls, a handle the same record in the next', async () => {
  const day = await cli(['agents', 'call', 'read', JSON.stringify({ from: home.day })]);
  assert.equal(day.code, 0, day.out + day.err);
  const lines = JSON.parse(day.out);
  assert.equal(lines.what, 'lines', day.out);
  assert.ok(lines.lines.some((/** @type {any} */ line) => /^r\d+$/u.test(line.ref) && line.at.startsWith(`${home.day}T08:06`) && /lighthouse tickets/u.test(line.text)), day.out);
  const searched = await cli(['agents', 'call', 'search', '{"query":"lighthouse"}', '--json']);
  assert.equal(searched.code, 0, searched.err);
  const result = JSON.parse(searched.out);
  assert.equal(result.isError, undefined);
  const hits = JSON.parse(result.content[0].text).record.hits;
  assert.ok(hits.length > 0, searched.out);
  const read = await cli(['agents', 'call', 'read', JSON.stringify({ ref: hits[0].ref })]);
  assert.equal(read.code, 0, read.out + read.err);
  assert.match(read.out, /lighthouse/u);
  assert.equal(await callGrant(), await callGrant());
  assert.ok(![day.out, searched.out, read.out].some(out => out.includes(kept())));
});

test('a grant the person disconnected: the next call reads on a new one, never listed', async () => {
  const before = await callGrant();
  const disconnected = await cli(['agents', 'disconnect', before]);
  assert.equal(disconnected.code, 0, disconnected.out + disconnected.err);
  const listed = await cli(['agents', 'call', 'search', '{"query":"lighthouse"}']);
  assert.equal(listed.code, 0, listed.out + listed.err);
  assert.notEqual(await callGrant(), before);
});

test('wrong arguments: the tool\'s refusal fails with its words and what it takes; arguments not one object, or no such tool, refused with the way', async () => {
  const tools = await listedTools();
  const wrong = await cli(['agents', 'call', 'read', '{"day":"2026-09-28"}']);
  assert.equal(wrong.code, 1, wrong.out);
  const refused = await cli(['agents', 'call', 'read', '{"day":"2026-09-28"}', '--json']);
  assert.equal(refused.code, 1, refused.out + refused.err);
  const result = JSON.parse(refused.out);
  assert.equal(result.isError, true, refused.out);
  const said = textOf(result);
  assert.ok(wrong.out.includes(said), wrong.out);
  assert.match(said, /\bday\b/u);
  assert.match(wrong.out, inOrder(Object.keys(tools.find(tool => tool.name === 'read')?.inputSchema.properties ?? {})));
  const loose = await cli(['agents', 'call', 'read', 'from=2026-09-28']);
  assert.equal(loose.code, 1);
  assert.ok(loose.out.includes(`lifestream agents call read '{"`), loose.out);
  const none = await cli(['agents', 'call', 'day']);
  assert.equal(none.code, 1);
  assert.match(none.out, /\bday\b/u);
  assert.match(none.out, inOrder(tools.map(tool => tool.name)));
  assert.ok(none.out.includes('lifestream agents call'), none.out);
});

test('no MCP server, or one that cannot reach the door: said with what to do', async () => {
  const closed = await listen(() => undefined);
  const port = new URL(closed).port;
  const server = servers.pop();
  await new Promise(done => server?.close(() => done(undefined)));
  const down = await cli(['agents', 'call'], `http://127.0.0.1:${port}`);
  assert.equal(down.code, 1);
  for (const part of [`http://127.0.0.1:${port}/mcp`, 'ECONNREFUSED', 'launchctl kickstart gui/$(id -u)/org.lifestreamprotocol.mcp', 'node mcp/server.mjs']) assert.ok(down.out.includes(part), `${part} in ${down.out}`);
  const doorless = await listen(createHandler({ door: `http://127.0.0.1:${port}`, machine: home.ask.machine, log: () => undefined }));
  const gone = await cli(['agents', 'call'], doorless);
  assert.equal(gone.code, 1);
  assert.ok(gone.out.includes('lifestream status') && !gone.out.includes('launchctl'), gone.out);
});
