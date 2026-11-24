import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createViewer } from '../server.mjs';
import { until } from './until.mjs';
import { openDoor } from '../lib/door.mjs';
import { loading } from '../public/ui/kit/states.js';
import { inspectorReading, pageLack, waitLine } from '../public/ui/kit/index.js';
import { pageReach, requestState } from '../public/lib/reach.js';
import { fetchPage } from '../public/lib/api.js';
import { dayListReading } from '../public/ui/days/fold.js';
import { listReading as peopleReading } from '../public/ui/people/list.js';
import { groupPageReading, pageFailed, personPageReading } from '../public/ui/people/person.js';
import { listViews, rowsReading } from '../public/ui/places/list.js';
import { placeBodyReading } from '../public/ui/places/place.js';
import { namingReading } from '../public/ui/places/naming.js';
import { tripPage, tripPageReading, tripsReading } from '../public/ui/places/trips.js';
import { hitListReading } from '../public/ui/search/hit-list.js';
import { AT_REST, bodyMarkup } from '../public/ui/connectors/view.js';
import { pageOf } from '../public/ui/connectors/page.js';
import { HOST_STATE } from '../public/kit-gallery-report.js';

const TOKEN = 'stand-in-token';
const KEEPALIVE_MS = 100;
const SILENCE_MS = 2_000;
const GONE = 'Can\'t reach Lifestream.';
const UNREACHED = { error: GONE, code: 'GONE' };
const LOCKED = 'Lifestream is locked: unlock it on your Mac.';
const EVENT_ID = 'g1:1';
const SEARCHED = ['/v1/search', '/v1/page/search'];

const summary = {};
after(async () => {
  const out = join(tmpdir(), 'lifestream-e2e');
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'dashboard-door-wait.json'), `${JSON.stringify(summary, null, 2)}\n`);
});

async function standIn(t) {
  /** @type {{ path: string, beats: number }[]} */
  const asked = [];
  /** @type {{ resumedFrom: string | null, silent: boolean }[]} */
  const feeds = [];
  /** @type {Map<string, Promise<void>>} */
  const held = new Map();
  /** @type {Set<import('node:http').ServerResponse>} */
  const open = new Set();
  let beats = 0;
  let broken = false;
  let refusedFeeds = 0;
  const server = createServer(async (request, response) => {
    const at = new URL(request.url, 'http://door');
    if (at.pathname === '/v1/feed' && broken) {
      refusedFeeds++;
      return request.socket.destroy();
    }
    if (at.pathname === '/v1/feed') {
      open.add(response);
      response.on('close', () => open.delete(response));
      const feed = { resumedFrom: request.headers['last-event-id'] ?? null, silent: false };
      feeds.push(feed);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`retry: 1000\n\nid: ${EVENT_ID}\ndata: ${JSON.stringify({ seq: 1, at_ms: 0, kind: 'import', key: 'stand-in', detail: null })}\n\n`);
      const beat = setInterval(() => {
        if (feed.silent) return;
        beats++;
        response.write(':\n\n');
      }, KEEPALIVE_MS);
      request.on('close', () => clearInterval(beat));
      return;
    }
    asked.push({ path: `${at.pathname}${at.search}`, beats, token: request.headers.authorization, etag: request.headers['if-none-match'] ?? null });
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ code: 'UNAUTHORIZED', message: 'no' }));
    }
    const q = at.searchParams.get('query') ?? '';
    await held.get(q);
    if (SEARCHED.includes(at.pathname) && q === 'refused') {
      response.writeHead(422, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ code: 'BAD_PARAM', message: '[BAD_PARAM] /private/path/never-shown' }));
    }
    if (at.pathname === '/v1/search' && q === 'cut') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"hits":[');
      return response.socket?.destroy();
    }
    if (at.pathname === '/v1/search' && q === 'short') {
      response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      return response.end('{"hits":[{"ref":');
    }
    if (SEARCHED.includes(at.pathname) && q === 'plain') {
      response.writeHead(503, { 'content-type': 'text/plain' });
      return response.end('Service Unavailable');
    }
    if (at.pathname === '/v1/search' && q === 'locked') {
      response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '60' });
      return response.end(JSON.stringify({ code: 'LOCKED', message: LOCKED }));
    }
    if (at.pathname === '/v1/search' && q === 'missing') {
      response.writeHead(404, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ code: 'NOT_FOUND', message: 'none' }));
    }
    if (at.pathname === '/v1/search') {
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ hits: [{ ref: 'stand-in:1', q }], next: null }));
    }
    response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '5' });
    response.end(JSON.stringify({ code: 'NOT_NOW', message: 'Lifestream is starting: it answers in a moment.' }));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  t.after(() => new Promise(done => { server.closeAllConnections(); server.close(() => done(undefined)); }));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    asked,
    feeds,
    beats: () => beats,
    hold(q) {
      let release = () => undefined;
      held.set(q, new Promise(done => { release = () => done(undefined); }));
      t.after(() => release());
      return () => {
        held.delete(q);
        release();
      };
    },
    silence: () => feeds.forEach(feed => { feed.silent = true; }),
    breakFeed: () => {
      broken = true;
      for (const response of open) response.destroy();
    },
    refusedFeeds: () => refusedFeeds,
    searches: q => asked.filter(each => each.path.startsWith('/v1/search?') && new URLSearchParams(each.path.split('?')[1]).get('query') === q),
  };
}

async function dashboard(t, url, token = TOKEN) {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-door-wait-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const door = openDoor({ url, token: () => token, silenceMs: SILENCE_MS });
  const server = await createViewer({ door });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  t.after(() => new Promise(done => { server.closeAllConnections(); server.close(() => done(undefined)); }));
  const at = `http://127.0.0.1:${server.address().port}`;
  return {
    door,
    at,
    search: async q => {
      const response = await fetch(`${at}/api/search?${new URLSearchParams({ query: q })}`);
      return { status: response.status, body: await response.json() };
    },
  };
}

test('L1 L6: a read the door holds while its feed beats past the silence limit answers the page; a refusal is told in the door\'s words, its paths cut, with its code', async t => {
  const door = await standIn(t);
  const page = await dashboard(t, door.url);
  await until('the page\'s feed opened', () => door.feeds.length > 0);
  const release = door.hold('slow');
  const answer = page.search('slow');
  const [arrived] = await until('the held search at the door', () => door.searches('slow').length > 0 && door.searches('slow'));
  const span = SILENCE_MS / KEEPALIVE_MS + 10;
  await until('the feed beating past the silence limit', () => door.beats() - arrived.beats >= span);
  release();
  assert.deepEqual(await answer, { status: 200, body: { hits: [{ ref: 'stand-in:1', q: 'slow' }], next: null } });
  const refused = await page.search('refused');
  assert.deepEqual(refused, { status: 400, body: { error: '[BAD_PARAM] …', code: 'BAD_PARAM' } });
  const missing = await page.search('missing');
  assert.deepEqual(missing, { status: 404, body: { error: 'Lifestream holds no such thing (NOT_FOUND).', code: 'NOT_FOUND' } });
  summary.slow = { held_for_keepalives: span, keepalive_ms: KEEPALIVE_MS, silence_ms: SILENCE_MS, answered: 200, refused, missing };
});

test('L2 L4: the same read asked while it waits reaches the door once, a read that differs or comes after asks again, and a door client nobody follows opens its feed for its reads', async t => {
  const door = await standIn(t);
  const client = openDoor({ url: door.url, token: () => TOKEN, silenceMs: SILENCE_MS });
  t.after(() => client.close());
  const release = door.hold('slow');
  const first = [client.json('/v1/search', { query: 'slow' }), client.json('/v1/search', { query: 'slow' })];
  await until('the held search at the door', () => door.searches('slow').length > 0);
  await until('the client\'s feed opened', () => door.feeds.length > 0);
  const again = client.json('/v1/search', { query: 'slow' });
  const validated = [client.text('/v1/search', '"stand-in-etag"', { query: 'slow' }), client.text('/v1/search', '"stand-in-etag"', { query: 'slow' })];
  const visitor = client.allows('visitor-token');
  await until('the validated and the visitor\'s searches at the door', () => door.searches('slow').length === 2 && door.asked.some(each => each.token === 'Bearer visitor-token'));
  release();
  const answers = await Promise.all([...first, again]);
  for (const each of answers) assert.deepEqual(each, { hits: [{ ref: 'stand-in:1', q: 'slow' }], next: null });
  for (const each of await Promise.all(validated)) assert.equal(each.status, 200);
  assert.equal(await visitor, false);
  const joined = door.searches('slow');
  assert.deepEqual(joined.map(each => each.etag), [null, '"stand-in-etag"']);
  await client.json('/v1/search', { query: 'slow' });
  assert.equal(door.searches('slow').length, 3);
  summary.joined = { asked_at_once: 3, door_saw: joined.filter(each => each.etag === null).length, with_validator_asked: 2,
    with_validator_door_saw: joined.filter(each => each.etag !== null).length, after_the_answer: 1, feeds: door.feeds.length };
});

test('L3: a door whose feed falls silent fails the waiting read with "Can\'t reach Lifestream." and its feed opens again where it was', async t => {
  const door = await standIn(t);
  const page = await dashboard(t, door.url);
  await until('the page\'s feed opened', () => door.feeds.length > 0);
  door.hold('silent');
  const answer = page.search('silent');
  await until('the held search at the door', () => door.searches('silent').length > 0);
  door.silence();
  assert.deepEqual(await answer, { status: 503, body: UNREACHED });
  const [, reopened] = await until('the feed opened again', () => door.feeds.length > 1 && door.feeds);
  assert.equal(reopened.resumedFrom, EVENT_ID);
  assert.equal((await page.search('back')).status, 200);
  summary.silent = { told: GONE, feeds: door.feeds };
});

test('L8: a feed that breaks and whose reconnects fail at once still fails a read left waiting once the silence passes', async t => {
  const door = await standIn(t);
  const page = await dashboard(t, door.url);
  await until('the page\'s feed opened', () => door.feeds.length > 0);
  door.hold('stranded');
  const answer = page.search('stranded');
  await until('the held search at the door', () => door.searches('stranded').length > 0);
  door.breakFeed();
  assert.deepEqual(await answer, { status: 503, body: UNREACHED });
  assert.ok(door.refusedFeeds() >= 1, `reconnects tried: ${door.refusedFeeds()}`);
  summary.broken = { told: GONE, reconnects_refused: door.refusedFeeds(), silence_ms: SILENCE_MS };
});

test('L5: a door that refuses the connection is told "Can\'t reach Lifestream."', async t => {
  const free = createServer();
  await new Promise(done => free.listen(0, '127.0.0.1', () => done(undefined)));
  const port = free.address().port;
  await new Promise(done => free.close(() => done(undefined)));
  const page = await dashboard(t, `http://127.0.0.1:${port}`);
  const told = await page.search('anything');
  assert.deepEqual(told, { status: 503, body: UNREACHED });
  summary.refused = told;
});

test('L10: GONE is the dashboard reaching no door: a body cut short is; the door\'s own plain 503 and a refused token are not', async t => {
  const door = await standIn(t);
  const page = await dashboard(t, door.url);
  const cut = await page.search('cut');
  assert.deepEqual(cut, { status: 503, body: UNREACHED });
  await until('the dashboard\'s feed open', () => door.feeds.length > 0);
  const short = await page.search('short');
  assert.deepEqual(short, { status: 503, body: UNREACHED }, 'a body ended short is no answer');
  const plain = await page.search('plain');
  assert.deepEqual(plain, { status: 503, body: { error: 'Lifestream cannot answer now. Try again in a moment.' } });
  const stranger = await dashboard(t, door.url, 'not-the-token');
  const refused = await stranger.search('anything');
  assert.deepEqual(refused, { status: 503, body: { error: 'Lifestream refused the dashboard\'s read token.' } });
  summary.gone = { cut, short, plain, refused };
});

test('L12: a locked home is told in the door\'s own sentence with its code and when to ask again, and the page shows it as a wait, never as a broken read', async t => {
  const door = await standIn(t);
  const page = await dashboard(t, door.url);
  const response = await fetch(`${page.at}/api/search?query=locked`);
  const locked = { status: response.status, retry: response.headers.get('retry-after'), body: await response.json() };
  assert.deepEqual(locked, { status: 503, retry: '60', body: { error: LOCKED, code: 'LOCKED' } });
  const refused = await page.door.json('/v1/search', { query: 'locked' }).then(() => null, error => error);
  assert.deepEqual({ message: refused.message, status: refused.status, code: refused.code, retryAfter: refused.retryAfter }, { message: LOCKED, status: 503, code: 'LOCKED', retryAfter: 60 });
  const state = requestState({ status: locked.status, code: locked.body.code, message: locked.body.error, retryAfter: Number(locked.retry) }, 0);
  assert.deepEqual(state, { state: 'wait', words: LOCKED, until: 60_000 });
  summary.locked = { locked, state };
});

test('L7: a page waiting on the home says "Waiting for Lifestream." under its mark; a card\'s mark never does', async t => {
  const door = await standIn(t);
  const page = await dashboard(t, door.url);
  const WAITING = 'Waiting for Lifestream.';
  assert.ok(loading('Reading the days').includes(`>${WAITING}</p>`));
  assert.ok(!loading('Reading their weeks', { size: 'inline' }).includes(WAITING));
  const kit = await (await fetch(`${page.at}/kit.css`)).text();
  assert.match(kit, /\.ck-loading__wait \{[^}]*var\(--duration-patience\) forwards;/u);
  summary.waiting = { page: WAITING, inline: null };
});

test('L9: a first read of the home standing as skeletons says "Waiting for Lifestream." once, after its last skeleton row, from the root\'s patience; never once it lands or fails', async t => {
  const door = await standIn(t);
  const page = await dashboard(t, door.url);
  const WAITING = '<p class="ck-sk-wait mac-body" aria-hidden="true">Waiting for Lifestream.</p>';
  const SHAPE = 'class="ck-sk ';
  const today = '2026-10-18';
  const unread = listViews('places', { places: null, cities: null, trips: null });
  const placesReading = (/** @type {string} */ failed = '') => `${unread}${failed || rowsReading()}`;
  const trip = { title: 'Somewhere not known', nights: '3 nights', range: { first: '2026-03-01', last: '2026-03-03' }, route: [],
    guessed: false };
  const year = { position: '1:0', today, year: 2026, span: { first: 2026, last: 2026 }, trips: [trip], figures: [], cities: [],
    base: null };
  const streams = bodyMarkup(pageOf(null, HOST_STATE, { query: '', place: '' }), AT_REST, '');
  /** @type {Record<string, string>} */
  const firstReads = {
    'days list': dayListReading(),
    people: peopleReading(''),
    person: personPageReading(today),
    group: groupPageReading(),
    places: placesReading(),
    place: placeBodyReading(),
    'name a spot': namingReading(),
    trips: tripsReading(),
    trip: tripPageReading(),
    'trip read, its days not': tripPage({ trip, year, days: null, world: null, width: 600, today }),
    search: hitListReading(),
    moment: inspectorReading({ close: {} }),
    streams,
  };
  for (const [name, html] of Object.entries(firstReads)) {
    const main = html.split('<aside')[0];
    assert.equal(html.split(WAITING).length - 1, 1, `${name}: the line once`);
    assert.ok(main.includes(WAITING), `${name}: the line in the content column`);
    assert.ok(main.lastIndexOf(WAITING) > main.lastIndexOf(SHAPE), `${name}: the line after the last skeleton row`);
  }
  const done = {
    'people failed': peopleReading('', pageLack('Your people couldn’t be read.', { retry: {} })),
    'places failed': placesReading(pageLack('Your places couldn’t be read.', { retry: {} })),
    'person failed': pageFailed('This couldn’t be read.', false),
    'group failed': pageFailed('This couldn’t be read.', true),
    'trip, its days read': tripPage({ trip, year, days: [], world: null, width: 600, today }),
    'connectors failed': bodyMarkup(pageOf(null, HOST_STATE, { query: '', place: '' }), AT_REST, '',
      pageLack('Your connectors couldn’t be read.', { retry: {} })),
  };
  for (const [name, html] of Object.entries(done)) assert.ok(!html.includes('Waiting for Lifestream.'), `${name}: no line`);
  const kit = await (await fetch(`${page.at}/kit.css`)).text();
  const rule = (/** @type {string} */ selector) => kit.match(new RegExp(`^\\s*${selector.replace(/[.]/gu, '\\.')} \\{([^}]*)\\}`, 'mu'))?.[1] ?? '';
  assert.match(rule('.ck-sk-wait'), /opacity: var\(--ck-sk-wait\);/u);
  assert.doesNotMatch(rule('.ck-sk-wait'), /animation/u);
  assert.match(rule('.ck-root'), /--ck-sk-wait: 0;/u);
  const readings = [...kit.matchAll(/^\s*\.ck-reading \{ animation: ([^}]*)\}/gmu)].map(each => each[1]);
  assert.equal(readings.length, 2);
  for (const animation of readings) {
    assert.match(animation, /ck-sk-wait var\(--duration-fast\) var\(--ease-out\) var\(--duration-patience\) both/u);
  }
  assert.match(kit, /@keyframes ck-sk-wait \{ from \{ --ck-sk-wait: 0; \} to \{ --ck-sk-wait: 1; \} \}/u);
  assert.match(kit, /@property --ck-sk-wait \{ syntax: '<number>'; inherits: true; initial-value: 0; \}/u);
  summary.skeletons = { waiting: 'Waiting for Lifestream.', pages: Object.keys(firstReads), gone: Object.keys(done),
    after: 'duration-patience, on the reading root' };
});

test('L11: a page\'s read that met the door gone is reach\'s: one probe, its skeleton standing, read again once the home answers; one the door refused or failed at is its own', async t => {
  const door = await standIn(t);
  const page = await dashboard(t, door.url);
  const free = createServer();
  await new Promise(done => free.listen(0, '127.0.0.1', () => done(undefined)));
  const port = free.address().port;
  await new Promise(done => free.close(() => done(undefined)));
  const away = await dashboard(t, `http://127.0.0.1:${port}`);
  const fetched = globalThis.fetch;
  let on = page.at;
  globalThis.fetch = (path, init) => fetched(typeof path === 'string' && path.startsWith('api/') ? `${on}/${path}` : path, init);
  t.after(() => {
    globalThis.fetch = fetched;
  });
  /**
   * @param {string} q
   * @param {string} [at]
   */
  const thrown = async (q, at = page.at) => {
    on = at;
    return fetchPage('search', { query: q }).then(() => assert.fail(`${q} answered`), error => error);
  };
  /** @type {unknown[]} */
  const probes = [];
  /** @type {(reply: unknown) => void} */
  let answer = () => undefined;
  const host = {
    /** @param {(state: { reach?: import('../public/lib/reach.js').Reach | null }) => void} listener */
    follow: listener => {
      listener({ reach: { state: 'answering', revision: 3, tone: null, title: null, line: null, meta: null, acts: [] } });
      return () => undefined;
    },
    /** @param {unknown} message */
    act: message => {
      probes.push(message);
      return new Promise(done => {
        answer = done;
      });
    },
  };
  const reach = pageReach(host);
  let again = 0;
  const readAgain = () => {
    again += 1;
  };

  const gone = await thrown('anything', away.at);
  assert.deepEqual([gone.status, gone.code], [503, 'GONE']);
  assert.deepEqual(reach.failed(gone, reach.begin(), readAgain), { kind: 'reach' });
  assert.deepEqual(reach.failed(await thrown('anything', away.at), reach.begin(), readAgain), { kind: 'reach' });
  assert.deepEqual(probes, [{ act: 'home', do: 'probe' }]);
  const NOT_HERE = 'Search isn’t on this Mac yet.';
  const drawn = hitListReading().replace(waitLine(), waitLine() + pageLack(NOT_HERE, { reach: true }));
  assert.equal(drawn.split('Waiting for Lifestream.').length - 1, 1);
  assert.ok(drawn.indexOf('ck-lack--reach') > drawn.indexOf('Waiting for Lifestream.'));
  assert.ok(!drawn.includes('reach Lifestream') && !drawn.includes('Try again'), 'no why, nothing to press');
  answer({ state: 'answering', revision: 3 });
  await until('the read asked again', () => again > 0);
  assert.equal(again, 1);

  assert.deepEqual(reach.failed(await thrown('refused'), reach.begin(), readAgain),
    { kind: 'lack', words: '[BAD_PARAM] …', retry: false });
  assert.deepEqual(reach.failed(await thrown('plain'), reach.begin(), readAgain), { kind: 'lack', words: null, retry: true });
  assert.equal(probes.length, 1, 'a read\'s own failure asks the Mac nothing');
  assert.equal(again, 1);
  reach.close();
  summary.reach = { gone: 'reach, one probe, read again once', refused: 'its words', plain: 'its lack, Try again' };
});
