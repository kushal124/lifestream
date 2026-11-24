import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createViewer } from '../server.mjs';
import { openDoor } from '../lib/door.mjs';
import { fetchPage } from '../public/lib/api.js';
import { readHost, STATE_EVENT } from '../public/lib/host.js';
import { lacks, pageReach } from '../public/lib/reach.js';
import { homeStrip } from '../public/ui/kit/index.js';
import { esc } from '../public/lib/html.js';
import { settingsDetail } from '../public/ui/connectors/settings.js';
import { OPENED } from '../public/ui/connectors/dialog.js';
import { HOST_STATE, REPORT } from '../public/kit-gallery-report.js';
import { until } from './until.mjs';

const TOKEN = 'stand-in-token';
const REACH = JSON.parse(await readFile(new URL('./fixtures/host-reach.json', import.meta.url), 'utf8'));
const PREPARING = 'Your people are being prepared.';
const HELD = { code: 'NOT_NOW', wait: 'needs', message: 'Lifestream is held', title: 'Lifestream is held', line: 'The drive holding it went away.', acts: [] };

/** @type {Record<string, unknown>} */
const summary = {};
after(async () => {
  const out = join(tmpdir(), 'lifestream-e2e');
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'dashboard-reach.json'), JSON.stringify(summary, null, 2));
});

/** @param {import('node:test').TestContext} t */
async function standIn(t) {
  const server = createServer((request, response) => {
    const at = new URL(/** @type {string} */ (request.url), 'http://door');
    if (at.pathname === '/v1/feed') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('retry: 50\n\n');
      return;
    }
    const q = at.searchParams.get('query');
    const json = (/** @type {number} */ status, /** @type {unknown} */ body, headers = {}) => {
      response.writeHead(status, { 'content-type': 'application/json', ...headers });
      response.end(JSON.stringify(body));
    };
    if (q === 'failing') return json(500, { code: 'HOME_FAILED', message: 'Lifestream failed at this. Its log says why.' });
    if (q === 'refused') return json(422, { code: 'NOT_A_DAY', message: 'That isn\'t a day.' });
    if (q === 'busy') return json(503, { code: 'INDEX_BUILDING', message: 'building', building: ['words'] }, { 'retry-after': '5' });
    if (q === 'preparing') return json(503, { code: 'NOT_NOW', wait: 'busy', message: PREPARING, title: null, line: null, acts: [] }, { 'retry-after': '5' });
    if (q === 'held') return json(503, HELD, { 'retry-after': '60' });
    return json(200, { hits: [], next: null });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  t.after(() => new Promise(done => { server.closeAllConnections(); server.close(() => done(undefined)); }));
  return `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
}

/**
 * @param {import('node:test').TestContext} t
 * @param {string} url
 */
async function dashboard(t, url) {
  const door = openDoor({ url, token: () => TOKEN });
  const server = await createViewer({ door });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  t.after(() => new Promise(done => { door.close(); server.closeAllConnections(); server.close(() => done(undefined)); }));
  return `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
}

async function freePort() {
  const free = createServer();
  await new Promise(done => free.listen(0, '127.0.0.1', () => done(undefined)));
  const port = /** @type {any} */ (free.address()).port;
  await new Promise(done => free.close(() => done(undefined)));
  return port;
}

/** @param {Record<string, unknown>} state */
function standInHost(state) {
  /** @type {Set<() => void>} */
  const listeners = new Set();
  /** @type {unknown[]} */
  const asked = [];
  /** @type {((reply: unknown) => void)[]} */
  const waiting = [];
  const win = {
    lifestreamHost: { kind: 'mac', version: REACH.version, state },
    addEventListener: (/** @type {string} */ type, /** @type {() => void} */ listener) => { if (type === STATE_EVENT) listeners.add(listener); },
    removeEventListener: (/** @type {string} */ _, /** @type {() => void} */ listener) => { listeners.delete(listener); },
    webkit: { messageHandlers: { lifestream: { postMessage: (/** @type {any} */ message) => {
      asked.push(message);
      return new Promise(done => { waiting.push(done); });
    } } } },
  };
  const host = readHost(/** @type {any} */ (win));
  assert.ok(host, 'a host of version 6 believed');
  return {
    host,
    asked,
    /** @param {Record<string, unknown>} next */
    state: next => {
      win.lifestreamHost.state = next;
      for (const listener of [...listeners]) listener();
    },
    /** @param {unknown} reply */
    answer: reply => waiting.shift()?.(reply),
  };
}

function fakeRoot() {
  const classes = new Set();
  return { classes, classList: {
    /** @param {string} name @param {boolean} on */
    toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); return on; },
    /** @param {string} name */
    remove: name => { classes.delete(name); },
  } };
}

const settled = () => new Promise(resolve => setImmediate(resolve));

/**
 * @param {string} at
 * @param {string} q
 */
async function thrown(at, q) {
  const fetched = globalThis.fetch;
  globalThis.fetch = (path, init) => fetched(typeof path === 'string' && path.startsWith('api/') ? `${at}/${path}` : path, init);
  try {
    return await fetchPage('search', { query: q }).then(() => assert.fail(`${q} answered`), error => error);
  } finally {
    globalThis.fetch = fetched;
  }
}

test('R1: while reach answers, a read\'s own failure is its own: lack, words, its wait at 5 s, and its own not-now asks no probe', async t => {
  const at = await dashboard(t, await standIn(t));
  const mac = standInHost({ ...HOST_STATE, ...REACH.states.answering });
  const root = fakeRoot();
  const reach = pageReach(mac.host, /** @type {any} */ (root));
  t.after(() => reach.close());
  let again = 0;
  const readAgain = () => { again += 1; };

  const failing = reach.failed(await thrown(at, 'failing'), reach.begin(), readAgain);
  assert.deepEqual(failing, { kind: 'lack', words: null, retry: true });
  const refused = reach.failed(await thrown(at, 'refused'), reach.begin(), readAgain);
  assert.deepEqual(refused, { kind: 'lack', words: 'That isn\'t a day.', retry: false });
  const before = Date.now();
  const busy = reach.failed(await thrown(at, 'busy'), reach.begin(), readAgain);
  const after = Date.now();
  assert.equal(busy.kind, 'wait');
  assert.equal(busy.kind === 'wait' && busy.words, 'Search is getting ready.');
  const until5 = busy.kind === 'wait' ? busy.until : 0;
  assert.ok(until5 >= before + 5_000 && until5 <= after + 5_000, 'asked again at the door\'s Retry-After');
  assert.deepEqual(mac.asked, [], 'a read\'s own failure asks the Mac nothing');
  const preparing = reach.failed(await thrown(at, 'preparing'), reach.begin(), readAgain);
  assert.equal(preparing.kind, 'wait');
  assert.equal(preparing.kind === 'wait' && preparing.words, PREPARING);
  reach.failed(await thrown(at, 'preparing'), reach.begin(), readAgain);
  assert.deepEqual(mac.asked, [], 'a read\'s own not-now is no news of reach');
  await settled();
  assert.equal(root.classes.has('ck-lacks'), false, 'reach answered throughout');
  assert.equal(again, 0, 'a wait is the page\'s to ask again, at its time');
  summary.own = { failing, refused, busy: { ...busy, until: 'Retry-After 5 s' }, preparing: { ...preparing, until: 'Retry-After 5 s' },
    probes: mac.asked.length };
});

test('R2: a read that met the door gone asks one probe and reads again once; a held home is reach\'s too', async t => {
  const gone = await dashboard(t, `http://127.0.0.1:${await freePort()}`);
  const at = await dashboard(t, await standIn(t));
  const mac = standInHost({ ...HOST_STATE, ...REACH.states.answering });
  const reach = pageReach(mac.host);
  t.after(() => reach.close());
  let again = 0;
  const readAgain = () => { again += 1; };

  const met = await thrown(gone, 'anything');
  assert.deepEqual([met.status, met.code], [503, 'GONE']);
  assert.deepEqual(reach.failed(met, reach.begin(), readAgain), { kind: 'reach' });
  assert.deepEqual(reach.failed(await thrown(gone, 'anything'), reach.begin(), readAgain), { kind: 'reach' });
  assert.deepEqual(mac.asked, [REACH.probe.request], 'two reads, one probe');
  mac.answer(REACH.probe.reply);
  await until('the read asked again', () => again > 0);
  mac.state({ ...HOST_STATE, reach: { ...REACH.states.answering.reach, revision: REACH.probe.reply.revision }, sending: null });
  await settled();
  assert.equal(again, 1);

  const held = await thrown(at, 'held');
  assert.deepEqual([held.status, held.code, held.wait], [503, 'NOT_NOW', 'needs']);
  assert.deepEqual(reach.failed(held, reach.begin(), readAgain), { kind: 'reach' });
  summary.gone = { probes: 1, reads: again, held: 'reach' };
});

test('R3: the fixture\'s recovery: the wait line stands while the home waits, lacks once unreachable, reads again once; the strip and Status agree', async t => {
  const gone = await dashboard(t, `http://127.0.0.1:${await freePort()}`);
  const [first] = REACH.recovery;
  const mac = standInHost({ ...HOST_STATE, reach: first.reach, sending: null });
  const root = fakeRoot();
  const reach = pageReach(mac.host, /** @type {any} */ (root));
  t.after(() => reach.close());
  let reads = 0;
  const readAgain = () => { reads += 1; };
  /** @type {unknown[]} */
  const steps = [];
  for (const step of REACH.recovery) {
    mac.state({ ...HOST_STATE, reach: step.reach, sending: null });
    await settled();
    if (step.reach.state === 'waiting') assert.deepEqual(reach.failed(await thrown(gone, 'anything'), reach.begin(), readAgain), { kind: 'reach' });
    const strip = homeStrip(/** @type {any} */ (mac.host.state.reach));
    const status = settingsDetail({ report: REPORT, models: null, failed: '', state: mac.host.state, id: 'settings/home', opened: OPENED,
      subscriptions: null })?.parts.flatMap(part => part.panel?.rows ?? []).find(row => row.label === 'Status');
    assert.equal(root.classes.has('ck-lacks'), step.lacks, `${step.step}: lacks`);
    assert.equal(lacks(mac.host.state.reach), step.lacks);
    assert.equal(reads, step.reads, `${step.step}: reads`);
    if (step.lacks) {
      assert.equal(strip, homeStrip(step.reach), `${step.step}: the strip says why`);
      assert.ok(strip.includes(esc(step.reach.line)));
      assert.equal(status?.line, 'Can’t reach', `${step.step}: Status says the state's word, the strip why`);
      assert.deepEqual(status?.waiting ?? [], [], `${step.step}: nothing of the strip's under it`);
    } else {
      assert.equal(strip, '', `${step.step}: no strip`);
      assert.notEqual(status?.signal, 'warning', `${step.step}: Status says the home's own words`);
    }
    steps.push({ step: step.step, lacks: root.classes.has('ck-lacks'), reads, strip: strip !== '', status: status?.line });
  }
  assert.deepEqual(mac.asked, [REACH.probe.request]);
  mac.answer({ state: 'answering', revision: REACH.recovery.at(-1).reach.revision });
  await settled();
  assert.equal(reads, 1, 'one recovery, one read again');
  summary.recovery = steps;
});
