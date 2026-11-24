// @ts-check
import { spawn } from 'node:child_process';
import { bundledProgram } from '../../testing/program.mjs';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { ready } from './programs.mjs';
import { until } from './until.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const COMMAND_MS = 30_000;

/** @type {import('node:child_process').ChildProcessByStdio<import('node:stream').Writable, import('node:stream').Readable, null>} */
let child;
/** @type {{ url: string, tokens: { reader: string, agent: string, phone: string, mac: string }, phone: string, mac: string, now_ms: number, ask: { machine: string } }} */
export let home;
/** @type {((line: any) => void)[]} */
const waiting = [];
/** @type {Record<string, unknown[]>} */
const artifact = {};
let current = '';

/**
 * @param {string} mcp
 * @param {Record<string, string>} [env]
 */
export async function startHome(mcp, env = {}) {
  child = spawn(process.execPath, bundledProgram('mcp/test/home.ts'),
    { cwd: REPO, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, LIFESTREAM_MCP: mcp, ...env } });
  const lines = createInterface({ input: child.stdout });
  home = await new Promise((done, fail) => {
    child.once('exit', code => fail(new Error(`the synthetic home exited with ${code}`)));
    lines.on('line', text => {
      const line = JSON.parse(text);
      if (line.ready) done(line);
      else waiting.shift()?.(line);
    });
  });
}

/** @param {Record<string, unknown>} said */
export async function command(said) {
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(`the synthetic home exited (${child.exitCode ?? child.signalCode}) before it answered ${said.cmd}`);
  }
  const line = await new Promise((done, fail) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      fail(new Error(`never came in ${COMMAND_MS / 1000} s: the synthetic home's answer to ${said.cmd}`));
    }, COMMAND_MS);
    /** @param {number | null} code @param {NodeJS.Signals | null} signal */
    const onExit = (code, signal) => {
      clearTimeout(timer);
      fail(new Error(`the synthetic home exited (${code ?? signal}) before it answered ${said.cmd}`));
    };
    child.once('exit', onExit);
    waiting.push(reply => {
      clearTimeout(timer);
      child.off('exit', onExit);
      done(reply);
    });
    child.stdin.write(`${JSON.stringify(said)}\n`);
  });
  if (!line.ok) throw new Error(`${said.cmd}: ${line.error}`);
  return line.value;
}

/** @param {string} file */
export async function stopHome(file) {
  if (child) await command({ cmd: 'stop' });
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, `${JSON.stringify(artifact, null, 1)}\n`);
}

/** @param {string} name */
export const named = name => {
  current = name;
  artifact[name] = [];
};
/** @param {unknown} line */
export const note = line => void artifact[current]?.push(line);

const started = performance.now();
export const homeClock = () => home.now_ms + Math.round(performance.now() - started);

/** @param {('codex' | 'claude')[]} programs */
export async function machineWith(programs) {
  const machine = await mkdtemp(join(tmpdir(), 'lifestream-mcp-ask-'));
  await mkdir(join(machine, 'ask'), { recursive: true });
  await mkdir(join(machine, 'claude', 'fake'), { recursive: true });
  await mkdir(join(machine, 'codex', 'fake'), { recursive: true });
  await copyFile(join(home.ask.machine, 'ask', 'door-token'), join(machine, 'ask', 'door-token'));
  for (const program of programs) await ready(machine, program);
  return machine;
}

/**
 * @param {string} at
 * @param {'GET' | 'POST'} method
 * @param {unknown} [body]
 * @param {{ pass?: string, device?: string, path?: string }} [options]
 */
export async function login(at, method, body, { pass = home.tokens.mac, device = home.mac, path = '/ask/login' } = {}) {
  const response = await fetch(`${at}${path}`, {
    method, headers: { authorization: `Bearer ${pass}`, 'lifestream-device': device, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: /** @type {any} */ (await response.json()) };
}

/** @param {string | null} value */
export async function keyed(value) {
  await command({ cmd: 'key', value });
  await until(`the models read saying the key is ${value === null ? 'gone' : 'held'}`, async () => {
    const read = /** @type {any} */ (await (await fetch(`${home.url}/v1/models`, { headers: { authorization: `Bearer ${home.tokens.reader}` } })).json());
    return read.openrouter?.connected === (value !== null);
  });
}

export const minted = () => randomBytes(16).toString('hex');

/** @param {string} at */
export const statusOf = async at => /** @type {any} */ (await (await fetch(`${at}/ask`, { headers: { authorization: `Bearer ${home.tokens.reader}` } })).json());

/**
 * @param {string} at
 * @param {Record<string, unknown>} body
 * @returns {Promise<any[]>}
 */
export async function asked(at, body) {
  const response = await fetch(`${at}/ask`, { method: 'POST', body: JSON.stringify({ submission: minted(), ...body }), headers: { authorization: `Bearer ${home.tokens.reader}`, 'content-type': 'application/json' } });
  const text = await response.text();
  if (response.status !== 200) return [{ status: response.status, ...JSON.parse(text) }];
  return text.split('\n').filter(line => line !== '').map(line => JSON.parse(line));
}

/**
 * @param {string} at
 * @param {Record<string, unknown>} body
 */
export async function streaming(at, body) {
  const response = await fetch(`${at}/ask`, { method: 'POST', body: JSON.stringify({ submission: minted(), ...body }), headers: { authorization: `Bearer ${home.tokens.reader}`, 'content-type': 'application/json' } });
  const reader = /** @type {ReadableStream<Uint8Array>} */ (response.body).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  /** @type {any[]} */
  const seen = [];
  /** @returns {Promise<any | null>} */
  const next = async () => {
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end >= 0) {
        const event = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        seen.push(event);
        return event;
      }
      const read = await reader.read();
      if (read.done) return null;
      buffer += decoder.decode(read.value, { stream: true });
    }
  };
  return { next, seen };
}

/** @type {{ you: any, me: any, person: any }} */
export const PEOPLE_YOU = JSON.parse(readFileSync(new URL('./fake/people-you.json', import.meta.url), 'utf8'));

/**
 * @param {string} door
 * @param {{ me: any, people?: any[], refused?: [number, string] | null }} served
 */
export async function youDoor(door, served) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://door');
    const id = url.pathname === '/v1/people' && request.method === 'GET' ? url.searchParams.get('id') : null;
    const person = id === null ? undefined : id === 'me' ? served.me : (served.people ?? []).find(each => each.id === id);
    if (id === 'me' && served.refused) {
      const [status, code] = served.refused;
      return void response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ code, message: `${code} (the test's)` }));
    }
    if (person !== undefined) {
      const [status, body] = person === null
        ? [404, { code: 'PERSON_UNKNOWN', message: 'no person me' }]
        : [200, { person, position: 'synthetic' }];
      return void response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    }
    const { host: _host, ...headers } = request.headers;
    const onward = httpRequest(`${door}${request.url}`, { method: request.method, headers }, answer => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    });
    onward.on('error', () => response.destroy());
    request.pipe(onward);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  return {
    url: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`,
    close: () => new Promise(done => {
      server.closeAllConnections();
      server.close(() => done(undefined));
    }),
  };
}
