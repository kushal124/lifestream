// @ts-check
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { until } from './until.mjs';

const FAKES = { codex: fileURLToPath(new URL('./fake/codex.mjs', import.meta.url)), claude: fileURLToPath(new URL('./fake/claude.mjs', import.meta.url)) };
const VERSIONS = { codex: '0.166.0', claude: '2.1.321' };

/** @param {'codex' | 'claude'} name */
const launcher = name => `#!/bin/sh\n[ "$1" = --version ] && { echo "${VERSIONS[name]}"; exit 0; }\nexec "${process.execPath}" "${FAKES[name]}" "$@"\n`;

/**
 * @param {string} machine
 * @param {'codex' | 'claude'} name
 */
export const choose = (machine, name) => mkdir(join(machine, 'subscriptions', name), { recursive: true });

/**
 * @param {string} machine
 * @param {'codex' | 'claude'} name
 */
export async function ready(machine, name) {
  const bin = join(machine, 'subscriptions', name, VERSIONS[name], 'bin');
  await mkdir(bin, { recursive: true });
  const binary = join(bin, name);
  await writeFile(binary, launcher(name));
  await chmod(binary, 0o755);
  await writeFile(join(machine, 'subscriptions', name, 'current'), `${VERSIONS[name]}/bin/${name}\n`);
}

/**
 * @param {string} dir
 * @param {string} name
 * @returns {Promise<any[]>}
 */
const linesOf = async (dir, name) => (await readFile(join(dir, name), 'utf8').catch(() => '')).split('\n').filter(line => line !== '').map(line => JSON.parse(line));

/**
 * @param {string} dir
 * @param {unknown[][]} turns
 */
const scripted = async (dir, turns) => {
  await writeFile(join(dir, 'turns.json'), JSON.stringify(turns));
  await rm(join(dir, 'turn-n'), { force: true });
};

/** @param {string} machine */
export const fakeCodex = machine => {
  const dir = join(machine, 'codex', 'fake');
  return {
    seen: () => linesOf(dir, 'seen.jsonl'),
    starts: () => linesOf(dir, 'started.jsonl'),
    /** @param {string} method */
    asked: async method => (await linesOf(dir, 'seen.jsonl')).filter(line => line.method === method).map(line => line.params),
    /** @param {{ decline?: boolean, plan?: string, exit?: boolean }} [how] */
    confirm: (how = {}) => writeFile(join(dir, 'confirm'), JSON.stringify(how)),
    /** @param {unknown[][]} turns */
    script: turns => scripted(dir, turns),
    signedIn: () => existsSync(join(dir, 'auth.json')),
  };
};

/** @param {string} machine */
export const fakeClaude = machine => {
  const dir = join(machine, 'claude', 'fake');
  return {
    dir,
    starts: async () => (await linesOf(dir, 'started.jsonl')).filter(line => line.argv !== undefined),
    seen: () => linesOf(dir, 'seen.jsonl'),
    /** @param {unknown[][]} turns */
    script: turns => scripted(dir, turns),
    signIn: () => writeFile(join(dir, 'auth.json'), JSON.stringify({ email: 'person-a@example.com', plan: 'max' })),
    approve: () => writeFile(join(dir, 'approve'), ''),
    /** @param {string} name */
    touch: name => writeFile(join(dir, name), ''),
    /** @returns {Promise<{ pid: number, helper: number }>} */
    login: async () => {
      const file = join(dir, 'login.json');
      /** @type {{ pid: number, helper: number }[]} */
      const read = [];
      await until('the fake sign-in wrote its processes', async () => {
        try {
          read.push(JSON.parse(await readFile(file, 'utf8')));
          return true;
        } catch {
          return false;
        }
      });
      await rm(file);
      return read[0];
    },
  };
};

export async function programServer() {
  const staging = await mkdtemp(join(tmpdir(), 'lifestream-mcp-codex-'));
  await mkdir(join(staging, 'package', 'bin'), { recursive: true });
  await writeFile(join(staging, 'package', 'bin', 'codex'), launcher('codex'), { mode: 0o755 });
  const tarball = join(staging, 'codex.tgz');
  await new Promise((done, fail) => execFile('tar', ['-czf', tarball, '-C', staging, 'package'], error => error === null ? done(undefined) : fail(error)));
  const bytes = await readFile(tarball);
  await rm(staging, { recursive: true, force: true });
  let mode = /** @type {'up' | 'held' | 'down'} */ ('up');
  /** @type {(() => void)[]} */
  const held = [];
  const server = createServer((request, response) => {
    if (mode === 'down') return void request.socket.destroy();
    response.writeHead(200, { 'content-length': bytes.length });
    if (mode === 'up') return void response.end(bytes);
    const half = Math.floor(bytes.length / 2);
    response.write(bytes.subarray(0, half));
    held.push(() => response.end(bytes.subarray(half)));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  const url = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}/codex.tgz`;
  return {
    rows: [{ name: 'codex', version: VERSIONS.codex, team: 'SYNTHETIC1', entry: 'package/bin/codex',
      artifact: { url, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }],
    /** @param {string} folder */
    signed: async folder => (await readdir(folder, { recursive: true, withFileTypes: true })).filter(each => each.isFile()).map(each => join(each.parentPath, each.name)),
    /** @param {'up' | 'held' | 'down'} how */
    serve: how => {
      mode = how;
      if (how === 'up') for (const rest of held.splice(0)) rest();
    },
    close: () => new Promise(done => {
      server.closeAllConnections();
      server.close(() => done(undefined));
    }),
  };
}

/** @param {string} door */
export async function openDoorway(door) {
  const state = { stalled: '', refused: '', keyed: false };
  /** @type {(() => void)[]} */
  const held = [];
  /** @type {string[]} */
  const asked = [];
  /** @type {string[]} */
  const forModel = [];
  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   */
  const forwarded = (request, response) => {
    const target = new URL(door);
    const { host: _host, ...headers } = request.headers;
    const forward = httpRequest({ host: target.hostname, port: target.port, method: request.method, path: request.url, headers }, answered => {
      response.writeHead(answered.statusCode ?? 502, answered.headers);
      answered.pipe(response);
    });
    forward.on('error', () => response.destroy());
    request.pipe(forward);
  };
  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   */
  const keyedMe = (request, response) => {
    const target = new URL(door);
    const { host: _host, 'accept-encoding': _encoding, ...headers } = request.headers;
    const forward = httpRequest({ host: target.hostname, port: target.port, method: request.method, path: request.url, headers }, answered => {
      /** @type {Buffer[]} */
      const chunks = [];
      answered.on('data', chunk => chunks.push(chunk));
      answered.on('end', () => {
        const body = Buffer.concat(chunks);
        response.writeHead(answered.statusCode ?? 502, { 'content-type': 'application/json' });
        response.end(answered.statusCode === 200 ? JSON.stringify({ ...JSON.parse(body.toString('utf8')), keyed: true }) : body);
      });
    });
    forward.on('error', () => response.destroy());
    request.pipe(forward);
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://doorway');
    asked.push(`${request.method} ${url.pathname}`);
    if (request.headers['lifestream-reader'] === 'model') forModel.push(`${request.method} ${url.pathname}`);
    if (state.refused !== '' && url.pathname.startsWith(state.refused)) {
      request.resume();
      response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '60' });
      return void response.end(JSON.stringify({ code: 'NOT_NOW', message: 'Lifestream is busy with other reads: try again in a minute.' }));
    }
    if (state.stalled !== '' && `${url.pathname}${url.search}`.startsWith(state.stalled)) return void held.push(() => forwarded(request, response));
    if (state.keyed && request.method === 'GET' && url.pathname === '/v1/me') return void keyedMe(request, response);
    forwarded(request, response);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  return {
    url: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`,
    state,
    asked,
    forModel,
    unstall: () => {
      state.stalled = '';
      for (const go of held.splice(0)) go();
    },
    holding: () => held.length,
    close: () => new Promise(done => {
      server.closeAllConnections();
      server.close(() => done(undefined));
    }),
  };
}
