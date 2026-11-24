import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createViewer } from '../server.mjs';
import { openChrome } from '../tools/chrome.mjs';
import {
  actSaid, budget, checkAfter, DOOR_WORDS, lacks, NOT_SENT, pageReach, PROBE_EVERY_S, REFUSED, requestState, SAVING, UNKNOWN, UNSAVED,
} from '../public/lib/reach.js';
import { actUntilAnswered, ownerAct } from '../public/lib/api.js';
import { esc } from '../public/lib/html.js';
import { homeStrip, inPlaceLine, loading, pageLack, waitLine } from '../public/ui/kit/index.js';
import { STATES } from '../public/kit-gallery-reach.js';
import { newest } from '../public/ui/search/query.js';

const OUT = fileURLToPath(new URL('../.build/e2e/kit-reach/', import.meta.url));
/** @typedef {[{ status: number, code: string | null, words: string | null, retryAfter?: number, held?: boolean }, { state: string, words?: string, after?: number }]} Outcome */
/** @type {{ states: Record<string, { reach: import('../public/lib/reach.js').Reach, sending: string | null }>, acts: any[], outcomes: Outcome[], probe: any, recovery: any[], version: number }} */
const FIXTURE = JSON.parse(await readFile(new URL('./fixtures/host-reach.json', import.meta.url), 'utf8'));
const NOW = 1_800_000_000_000;
/** @type {Record<string, unknown>} */
const summary = {};

/**
 * @param {number} status
 * @param {string} [code]
 * @param {string} [message]
 * @param {number} [retryAfter]
 * @param {boolean} [held]
 */
const replied = (status, code = '', message = '', retryAfter = 0, wait = '') =>
  Object.assign(new Error(message), { status, code, retryAfter }, wait ? { wait } : {});

const gone = () => replied(503, 'GONE', 'Can\'t reach Lifestream.');

test('K1: every outcome of the fixture\'s is the state HomeLink\'s table gives it, in its words', () => {
  assert.ok(FIXTURE.outcomes.length > 0);
  for (const [door, expected] of FIXTURE.outcomes) {
    const { after, ...state } = expected;
    const wanted = after === undefined ? state : { ...state, until: NOW + after * 1_000 };
    assert.deepEqual(requestState(replied(door.status, door.code ?? '', door.words ?? '', door.retryAfter ?? 0, door.wait), NOW), wanted,
      `${door.status} ${door.code}`);
  }
});

test('K1: a request\'s state follows HomeLink\'s code table, read off the /api reply', () => {
  const rows = /** @type {[string, unknown, import('../public/lib/reach.js').RequestState][]} */ ([
    ['no answer from the dashboard', new TypeError('Failed to fetch'), { state: 'reach' }],
    ['the dashboard reached no door (GONE)', gone(), { state: 'reach' }],
    ['the door\'s own plain 503', replied(503, '', 'Lifestream cannot answer now. Try again in a moment.'), { state: 'failed' }],
    ['a 503 the device codes by its status', replied(503, 'HTTP_503'), { state: 'failed' }],
    ['the dashboard\'s token refused', replied(503, '', 'Lifestream refused the dashboard\'s read token.'), { state: 'failed' }],
    ['not now, the read\'s own: its wait', replied(503, 'NOT_NOW', 'Your people are being prepared.', 5, 'busy'),
      { state: 'wait', words: 'Your people are being prepared.', until: NOW + 5_000 }],
    ['a hold: a wait on the person', replied(503, 'NOT_NOW', 'Lifestream is held The drive holding it went away.', 60, 'needs'), { state: 'reach' }],
    ['the home starting', replied(503, 'NOT_NOW', 'Lifestream is starting: it answers in a moment.', 5, 'starting'), { state: 'reach' }],
    ['a pass refused', replied(401), { state: 'reach' }],
    ['an app too old', replied(426), { state: 'reach' }],
    ['an outcome not known', replied(503, 'OUTCOME_UNKNOWN', 'It may have done it.'), { state: 'unknown', words: 'It may have done it.' }],
    ['an outcome not known, no words', replied(503, 'OUTCOME_UNKNOWN'), { state: 'unknown', words: UNKNOWN }],
    ['the home failed', replied(502, 'HOME_FAILED', 'The home failed.'), { state: 'failed' }],
    ['another 5xx', replied(500), { state: 'failed' }],
    ['the index busy, its time', replied(503, 'INDEX_BUSY', 'The search index is busy.', 5),
      { state: 'wait', words: 'The search index is busy.', until: NOW + 5_000 }],
    ['a wait with no time: probeEvery', replied(503, 'INDEX_BUILDING', 'The home is building its search index.'),
      { state: 'wait', words: 'The home is building its search index.', until: NOW + PROBE_EVERY_S * 1_000 }],
    ['Chat down: its words, never the door\'s raw text', replied(503, 'ASK_DOWN', 'ask server ECONNREFUSED'),
      { state: 'wait', words: DOOR_WORDS.ASK_DOWN, until: NOW + PROBE_EVERY_S * 1_000 }],
    ['the disk low', replied(503, 'DISK_LOW', 'disk 98%'), { state: 'wait', words: DOOR_WORDS.DISK_LOW, until: NOW + PROBE_EVERY_S * 1_000 }],
    ['a refusal, the home\'s words', replied(400, '', 'That isn\'t a day.'), { state: 'refused', words: 'That isn\'t a day.' }],
    ['a refusal, no words', replied(404), { state: 'refused', words: REFUSED }],
  ]);
  for (const [name, error, state] of rows) assert.deepEqual(requestState(error, NOW), state, name);
  summary.table = rows.map(([name, , state]) => ({ name, state }));
});

test('K2: an act\'s failure says what ReachWords.act says: not sent, a refusal in the door\'s words, an outcome not known', () => {
  assert.deepEqual(actSaid({ state: 'reach' }), { said: 'not-sent', words: NOT_SENT });
  assert.deepEqual(actSaid({ state: 'failed' }), { said: 'not-sent', words: NOT_SENT });
  assert.deepEqual(actSaid({ state: 'wait', words: 'Lifestream is building its index.', until: NOW }),
    { said: 'refused', words: 'Lifestream is building its index.' });
  assert.deepEqual(actSaid({ state: 'refused', words: 'That isn\'t a day.' }), { said: 'refused', words: 'That isn\'t a day.' });
  assert.deepEqual(actSaid({ state: 'unknown', words: 'It may have done it.' }), { said: 'unknown', words: 'It may have done it.' });
  for (const { door, reply } of FIXTURE.acts) {
    const said = actSaid(requestState(replied(door.status, door.code, door.message ?? '', door.retryAfter ?? 0, door.wait ?? ''), NOW));
    assert.equal(said.said, reply.said, door.code);
    assert.equal(said.said === 'not-sent' ? NOT_SENT : said.words, reply.refused, door.code);
  }
  const notSent = inPlaceLine('The app\'s own words.', { said: 'not-sent', retry: { 'data-again': '' } });
  assert.match(notSent, />Not sent</u);
  assert.match(notSent, /data-again[^>]*>Try again</u);
  assert.doesNotMatch(notSent, /The app/u);
  const refused = inPlaceLine('That isn\'t a day.', { said: 'refused', retry: { 'data-again': '' } });
  assert.match(refused, /That isn&#39;t a day\.|That isn't a day\./u);
  assert.doesNotMatch(refused, /Try again|<button/u, 'a refusal offered again');
  assert.match(inPlaceLine('', { said: 'refused' }), new RegExp(esc(REFUSED), 'u'));
  assert.doesNotMatch(inPlaceLine(UNKNOWN, { said: 'unknown', retry: {} }), /Try again/u);
  assert.match(inPlaceLine('', { said: 'unknown' }), new RegExp(esc(UNKNOWN), 'u'));
});

test('K9: an act\'s budget is HomeLink\'s: one deadline of 15 s, two sends, each the least of 10 s and what is left, the second only with 4 s left, HomeLink\'s 3 s and the server\'s hop', () => {
  let now = NOW;
  const sends = budget(() => now);
  assert.equal(sends.next(), 10_000);
  now += 10_000;
  assert.equal(sends.next(), 5_000);
  assert.equal(sends.next(), null, 'a third send');
  const late = budget(() => now);
  assert.equal(late.next(), 10_000);
  now += 11_001;
  assert.equal(late.next(), null, 'a second send with under 4 s left');
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(checkAfter), [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
});

/** @typedef {{ status: number, body: Record<string, unknown> } | 'lost'} Reply */

/**
 * @param {Reply[]} replies
 * @param {() => Promise<unknown>} run
 * @param {(wait: number) => void} [spent]
 */
async function sending(replies, run, spent = () => {}) {
  const fetched = globalThis.fetch;
  /** @type {{ request: string, wait: string | null }[]} */
  const sent = [];
  globalThis.fetch = async (_url, init) => {
    const wait = new Headers(init?.headers).get('lifestream-wait');
    sent.push({ request: JSON.parse(String(init?.body)).request, wait });
    spent(Number(wait));
    const reply = replies.shift();
    if (reply === undefined || reply === 'lost') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
  };
  try {
    return { sent, outcome: await run().then(value => ({ value }), error => ({ error })) };
  } finally {
    globalThis.fetch = fetched;
  }
}

const UNANSWERED = (/** @type {boolean} */ began) => ({ status: 503, body: { error: 'Lifestream is still working on this.', code: 'OUTCOME_UNKNOWN', again: true, began } });
const BUSY = { status: 503, body: { error: 'Not saved: Lifestream is busy.', code: 'NOT_NOW', wait: 'busy' } };
const KEPT = { status: 200, body: { act: 'act-1', id: 'person:person-a', position: '9:1' } };

test('K9: began belongs to the request: a later NOT_NOW stays Still saving; a refusal shows at once; nothing back is said as not known', async () => {
  const saidOf = (/** @type {{ error?: unknown }} */ outcome) => actSaid(requestState(outcome.error, NOW));
  const began = await sending([UNANSWERED(true), BUSY], () => ownerAct({ of: 'people', kind: 'confirm', id: 'person:person-a' }, 'request-1'));
  assert.deepEqual(saidOf(began.outcome), { said: 'saving', words: SAVING });
  assert.deepEqual(began.sent.map(each => each.request), ['request-1', 'request-1']);
  const busy = await sending([BUSY, KEPT], () => ownerAct({ of: 'people', kind: 'confirm', id: 'person:person-a' }, 'request-2'));
  assert.deepEqual(saidOf(busy.outcome), { said: 'refused', words: 'Not saved: Lifestream is busy.' });
  assert.equal(busy.sent.length, 1, 'a refusal sent again');
  const silent = await sending([UNANSWERED(false), 'lost'], () => ownerAct({ of: 'people', kind: 'confirm', id: 'person:person-a' }, 'request-3'));
  assert.deepEqual(saidOf(silent.outcome), { said: 'unknown', words: UNSAVED });
  const resent = await sending(['lost', KEPT], () => ownerAct({ of: 'people', kind: 'confirm', id: 'person:person-a' }, 'request-4'));
  assert.deepEqual(resent.outcome, { value: KEPT.body });
  assert.deepEqual(resent.sent.map(each => each.request), ['request-4', 'request-4']);
  assert.deepEqual(resent.sent.map(each => each.wait), ['10000', '10000'], 'a send lost at once leaves 15 s: each the least of 10 s and what is left');
  let now = NOW;
  const waited = await sending(['lost', KEPT], () => ownerAct({ of: 'people', kind: 'confirm', id: 'person:person-a' }, 'request-4', { sends: budget(() => now) }), wait => { now += wait; });
  assert.deepEqual(waited.sent.map(each => each.wait), ['10000', '5000'], 'a send that waited its 10 s leaves the second what is left of 15 s');
  const third = await sending([UNANSWERED(false), UNANSWERED(false), KEPT], () => ownerAct({ of: 'people', kind: 'confirm', id: 'person:person-a' }, 'request-5'));
  assert.equal(third.sent.length, 2, 'a third send in one budget');
  assert.deepEqual(requestState(Object.assign(new Error('It may have done it.'), { code: 'OUTCOME_UNKNOWN', again: false, began: true }), NOW),
    { state: 'unknown', words: 'It may have done it.' }, 'a route without again said as still saving');
  assert.deepEqual(inPlaceLine(SAVING, { said: 'saving', retry: {} }).match(/Try again/u), null, 'Still saving offered Try again');
});

test('K9: a request not known is checked by itself, the same request after 1, 2, 4 … s, began kept across checks, until its answer', async () => {
  /** @type {number[]} */
  const paced = [];
  /** @type {unknown[]} */
  const told = [];
  const checked = await sending([UNANSWERED(true), 'lost', BUSY, BUSY, 'lost', 'lost', KEPT], () => actUntilAnswered({ of: 'people', kind: 'confirm', id: 'person:person-a' }, {
    request: 'request-6', waiting: error => told.push(actSaid(requestState(error, NOW))), after: async ms => { paced.push(ms); },
  }));
  assert.deepEqual(checked.outcome, { value: KEPT.body });
  assert.deepEqual(paced, [1_000, 2_000, 4_000]);
  assert.deepEqual(told, Array(3).fill({ said: 'saving', words: SAVING }), 'a NOT_NOW after began said other than Still saving');
  assert.deepEqual([...new Set(checked.sent.map(each => each.request))], ['request-6']);
  const refused = await sending([UNANSWERED(false), 'lost', { status: 409, body: { error: 'They changed since you looked.', code: 'NOT_LAST' } }],
    () => actUntilAnswered({ of: 'people', kind: 'undo', act: 'act-1' }, { request: 'request-7', after: async () => {} }));
  assert.deepEqual(actSaid(requestState(/** @type {{ error?: unknown }} */ (refused.outcome).error, NOW)),
    { said: 'refused', words: 'They changed since you looked.' });
  let gone = false;
  const left = await sending([UNANSWERED(true), UNANSWERED(true), KEPT], () => actUntilAnswered({ of: 'people', kind: 'confirm', id: 'person:person-a' }, {
    request: 'request-8', left: () => gone, after: async () => { gone = true; },
  }));
  assert.equal(left.sent.length, 2, 'a page left checked again');
});

/** @param {import('../public/lib/reach.js').Reach} first */
function fakeHost(first) {
  /** @type {((state: { reach?: import('../public/lib/reach.js').Reach | null }) => void) | null} */
  let listener = null;
  /** @type {((reply: unknown) => void)[]} */
  const answers = [];
  /** @type {unknown[]} */
  const asked = [];
  return {
    asked,
    /** @param {(state: { reach?: import('../public/lib/reach.js').Reach | null }) => void} heard */
    follow(heard) {
      listener = heard;
      heard({ reach: first });
      return () => { listener = null; };
    },
    /** @param {{ act: 'home', do: 'probe' }} message */
    act(message) {
      asked.push(message);
      return new Promise(answer => answers.push(answer));
    },
    /** @param {import('../public/lib/reach.js').Reach} reach */
    state(reach) { listener?.({ reach }); },
    /** @param {unknown} reply */
    answer(reply) { answers.shift()?.(reply); },
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

const at = (/** @type {string} */ name, revision = 7) => ({ ...FIXTURE.states[name].reach, revision });

test('K4: one probe per page for one outage, its answer reads again once; a second failure under it is the read\'s own', async () => {
  const host = fakeHost(at('answering'));
  const page = pageReach(host);
  let reads = 0;
  /** @type {import('../public/lib/reach.js').Begun[]} */
  const begins = [];
  const read = /** @param {import('../public/lib/reach.js').Retry} retry */ retry => { reads += 1; begins.push(page.begin(retry)); };
  const other = () => { reads += 10; };
  assert.deepEqual(page.failed(gone(), page.begin(), read), { kind: 'reach' });
  assert.deepEqual(page.failed(gone(), page.begin(), read), { kind: 'reach' });
  assert.deepEqual(page.failed(new TypeError('Failed to fetch'), page.begin(), other), { kind: 'reach' });
  assert.deepEqual(host.asked, [{ act: 'home', do: 'probe' }]);
  host.answer({ state: 'answering', revision: 7 });
  await settled();
  assert.equal(reads, 11);
  assert.deepEqual(begins, [{ revision: 7, again: true }]);
  assert.equal(page.begin().again, false);
  assert.deepEqual(page.failed(gone(), begins[0], read), { kind: 'lack', words: null, retry: true });
  assert.equal(host.asked.length, 1);
  assert.deepEqual(page.failed(gone(), page.begin(), other), { kind: 'reach' });
  assert.equal(host.asked.length, 2);
  summary.probe = { asked: host.asked.length, reads };
});

test('K4: a page waits for a higher revision while reach lacks, and reads at once when the recovery came first', async () => {
  const host = fakeHost(at('waiting'));
  const root = fakeRoot();
  const page = pageReach(host, /** @type {any} */ (root));
  let reads = 0;
  const read = () => { reads += 1; };
  const begun = page.begin();
  host.state(at('unreachable'));
  assert.ok(root.classes.has('ck-lacks'));
  assert.deepEqual(page.failed(gone(), begun, read), { kind: 'reach' });
  assert.equal(host.asked.length, 0);
  host.state(at('unreachable'));
  assert.equal(reads, 0);
  host.state(at('answering', 8));
  assert.equal(reads, 1);
  assert.ok(!root.classes.has('ck-lacks'));
  host.state(at('answering', 9));
  assert.equal(reads, 1);
  const old = { revision: 8, again: false };
  assert.deepEqual(page.failed(gone(), old, read), { kind: 'reach' });
  await settled();
  assert.equal(reads, 2);
  page.close();
  assert.ok(!root.classes.has('ck-lacks'));
});

test('K4: a read\'s own not-now is its wait and asks no probe; the home\'s own (starting, waiting on the person) is reach\'s', async () => {
  const host = fakeHost(at('answering'));
  const page = pageReach(host);
  let reads = 0;
  const read = () => { reads += 1; };
  const preparing = () => replied(503, 'NOT_NOW', 'Your people are being prepared.', 5, 'busy');
  for (let at = 0; at < 2; at += 1) {
    const drawn = page.failed(preparing(), page.begin(), read);
    assert.deepEqual([drawn.kind, 'words' in drawn && drawn.words], ['wait', 'Your people are being prepared.']);
  }
  assert.deepEqual(host.asked, [], 'a read\'s own wait says nothing of reach: no probe');
  await settled();
  assert.equal(reads, 0);
  assert.deepEqual(page.failed(replied(503, 'NOT_NOW', 'Lifestream is held', 60, 'needs'), page.begin(), read), { kind: 'reach' });
  assert.deepEqual(page.failed(replied(503, 'NOT_NOW', 'Lifestream is starting: it answers in a moment.', 5, 'starting'), page.begin(), read),
    { kind: 'reach' });
  assert.deepEqual(host.asked, [{ act: 'home', do: 'probe' }]);
  assert.equal(pageReach(null).failed(preparing(), { revision: 0, again: false }, read).kind, 'wait');
});

test('K4: a request-local wait, a refusal and a plain browser draw by themselves, never waiting on reach', () => {
  const page = pageReach(fakeHost(at('answering')));
  assert.deepEqual(page.failed(replied(503, 'INDEX_BUSY', 'The search index is busy.', 5), page.begin(), () => {}).kind, 'wait');
  assert.deepEqual(page.failed(replied(400, '', 'That isn\'t a day.'), page.begin(), () => {}),
    { kind: 'lack', words: 'That isn\'t a day.', retry: false });
  assert.deepEqual(page.failed(replied(500), page.begin(), () => {}), { kind: 'lack', words: null, retry: true });
  const browser = pageReach(null);
  assert.equal(browser.reach, null);
  assert.deepEqual(browser.failed(gone(), browser.begin(), () => {}), { kind: 'lack', words: null, retry: true });
});

test('K4: one recovery told twice, its state and its probe\'s answer in either order, reads again once', async () => {
  for (const first of ['state', 'answer']) {
    const host = fakeHost(at('waiting'));
    const page = pageReach(host);
    let reads = 0;
    /** @type {import('../public/lib/reach.js').Drawn[]} */
    const drawn = [];
    const read = /** @param {import('../public/lib/reach.js').Retry} retry */ retry => {
      reads += 1;
      drawn.push(page.failed(gone(), page.begin(retry), read));
    };
    assert.deepEqual(page.failed(gone(), page.begin(), read), { kind: 'reach' });
    assert.equal(host.asked.length, 1, first);
    const state = () => host.state(at('answering', 8));
    const answer = async () => {
      host.answer({ state: 'answering', revision: 8 });
      await settled();
    };
    if (first === 'state') {
      state();
      await answer();
    } else {
      await answer();
      state();
    }
    assert.equal(reads, 1, `${first} first: one read again`);
    assert.deepEqual(drawn, [{ kind: 'lack', words: null, retry: true }], `${first} first: its second failure is its own`);
    assert.equal(host.asked.length, 1, first);
  }
});

test('K4: a read asked again whose failure lands after a newer recovery reads again, never Try again', async () => {
  const host = fakeHost(at('waiting', 0));
  const page = pageReach(host);
  let reads = 0;
  /** @type {import('../public/lib/reach.js').Begun[]} */
  const begins = [];
  const read = /** @param {import('../public/lib/reach.js').Retry} retry */ retry => { reads += 1; begins.push(page.begin(retry)); };
  assert.deepEqual(page.failed(gone(), page.begin(), read), { kind: 'reach' });
  host.state(at('answering', 1));
  assert.equal(reads, 1);
  assert.deepEqual(begins[0], { revision: 1, again: true });
  host.state(at('waiting', 1));
  host.state(at('answering', 2));
  assert.deepEqual(page.failed(gone(), begins[0], read), { kind: 'reach' });
  await settled();
  assert.equal(reads, 2);
});

test('K4: a read asked again that waits behind the read under way keeps its mark: its second failure is its own', async () => {
  const host = fakeHost(at('answering', 7));
  const page = pageReach(host);
  /** @type {import('../public/lib/reach.js').Begun[]} */
  const begins = [];
  /** @type {import('../public/lib/reach.js').Drawn[]} */
  const landed = [];
  /** @type {((error: unknown) => void)[]} */
  const fail = [];
  /** @param {import('../public/lib/reach.js').Retry} retry */
  const again = retry => void hits.ask(retry);
  const hits = newest(/** @param {import('../public/lib/reach.js').Retry | null} retry */ async retry => {
    const begun = page.begin(retry);
    begins.push(begun);
    try {
      await new Promise((_, failed) => fail.push(failed));
      return /** @type {import('../public/lib/reach.js').Drawn} */ ({ kind: 'reach' });
    } catch (error) {
      return page.failed(error, begun, again);
    }
  }, drawn => landed.push(drawn), () => 'the same words');
  const done = hits.ask();
  host.state(at('answering', 8));
  fail[0](gone());
  await settled();
  assert.equal(begins.length, 2, 'the read asked again ran once A ended');
  assert.deepEqual(begins[1], { revision: 8, again: true }, 'B begun as a read asked again, however late it began');
  fail[1](gone());
  await done;
  assert.equal(begins.length, 2, 'two reads');
  assert.deepEqual(landed.at(-1), { kind: 'lack', words: null, retry: true });
  assert.equal(host.asked.length, 0, 'no probe for a recovery the home already said');
  assert.equal(page.begin().again, false);
});

test('K4: a page closed asks nothing again, a read queued before it or a probe\'s late answer', async () => {
  const host = fakeHost(at('answering'));
  const page = pageReach(host);
  let reads = 0;
  const read = () => { reads += 1; };
  assert.deepEqual(page.failed(gone(), { revision: 6, again: false }, read), { kind: 'reach' });
  assert.deepEqual(page.failed(gone(), page.begin(), () => { reads += 10; }), { kind: 'reach' });
  page.close();
  host.answer({ state: 'answering', revision: 8 });
  await settled();
  assert.equal(reads, 0);
});

test('K5: the fixture holds every state, act reply, the probe and the recovery; the gallery draws its strips', () => {
  assert.equal(FIXTURE.version, 6);
  const names = new Set(Object.values(FIXTURE.states).map(({ reach }) => reach.state));
  assert.deepEqual([...names].sort(), ['answering', 'held', 'refused', 'starting', 'unpaired', 'unreachable', 'update', 'waiting']);
  assert.deepEqual([...new Set(FIXTURE.acts.map(act => act.reply.said))].sort(), ['not-sent', 'refused', 'unknown']);
  assert.deepEqual(FIXTURE.acts.filter(act => act.probe).map(act => [act.door.code, act.door.wait]), [['NOT_NOW', 'starting']]);
  assert.deepEqual(FIXTURE.probe.request, { type: 'act', act: 'home', do: 'probe' });
  assert.deepEqual(Object.keys(FIXTURE.probe.reply).sort(), ['revision', 'state']);
  assert.deepEqual(FIXTURE.recovery.map(step => step.reach.state), ['answering', 'waiting', 'unreachable', 'answering']);
  for (const [name, reach] of Object.entries(STATES)) assert.deepEqual(reach, FIXTURE.states[name]?.reach, name);
  for (const [name, { reach }] of Object.entries(FIXTURE.states)) {
    const strip = homeStrip(reach);
    assert.equal(strip === '', reach.tone === null, `${name}: a strip whenever the host words one: reach lacking, the home starting, a wait in an episode that showed one, reached again`);
    if (lacks(reach)) assert.notEqual(strip, '', `${name}: reach lacking always has its strip`);
    if (!strip) continue;
    assert.ok(!strip.includes('View details'), `${name}: the strip's acts alone, never a page that repeats it`);
    for (const act of reach.acts) assert.ok(strip.includes(`data-home-act="${act.do}"`), name);
    assert.ok(strip.includes(`ck-strip--${reach.tone}`), name);
    assert.equal(strip.includes('data-home-details'), reach.path.length > 0 && reach.acts.length === 0,
      `${name}: the › opens its checklist, the path's, where no button fixes it`);
    assert.equal(reach.path.length > 0, reach.state === 'unreachable', `${name}: only unreachable states a path`);
  }
  assert.match(waitLine(), />Waiting for Lifestream\.</u);
  assert.match(waitLine('The search index is busy.'), />The search index is busy\.</u);
  assert.match(loading('Reading', { words: DOOR_WORDS.ASK_DOWN }), /Chat isn(?:'|&#39;)t answering on your Mac/u);
  assert.match(pageLack('Your connectors aren’t on this Mac yet.', { reach: true }), /ck-lack ck-lack--reach/u);
  assert.doesNotMatch(pageLack('Your connectors aren’t on this Mac yet.'), /Try again/u);
  assert.match(pageLack('Your connectors couldn’t be read.', { retry: {} }), />Try again</u);
});

let dir = '';
/** @type {import('node:http').Server | null} */
let viewer = null;
/** @type {Awaited<ReturnType<typeof openChrome>> | null} */
let chrome = null;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dashboard-kit-reach-'));
  await mkdir(OUT, { recursive: true });
});

after(async () => {
  await writeFile(join(OUT, 'kit-reach.json'), JSON.stringify({ ...summary, thrown: chrome?.thrown ?? [] }, null, 2));
  await chrome?.close();
  viewer?.closeAllConnections();
  await new Promise(done => viewer ? viewer.close(() => done(undefined)) : done(undefined));
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('K6: a reading root through the fixture\'s recovery: the wait line, then the lack, then one read again', async () => {
  viewer = await createViewer();
  const served = viewer;
  await new Promise(done => served.listen(0, '127.0.0.1', () => done(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (served.address());
  chrome = await openChrome({ profile: join(dir, 'chrome'), origin: `http://127.0.0.1:${address.port}` });
  await chrome.size(1200, 900, 1);
  await chrome.load('kit-gallery.html#group=PageLack', '');
  await chrome.until('document.querySelector(\'.gallery__group\')', 'the gallery drawn');
  const gallery = await chrome.evaluate(`(() => {
    const labels = [...document.querySelectorAll('.gallery__label')];
    const shown = text => { const label = labels.find(each => each.textContent === text); const holder = label?.parentElement;
      return holder ? { wait: holder.querySelector('.ck-sk-wait') ? getComputedStyle(holder.querySelector('.ck-sk-wait')).display : null,
        lack: getComputedStyle(holder.querySelector('.ck-lack')).display } : null; };
    return { waits: shown('Reach waits: “Waiting for Lifestream.”'), lacks: shown('Reach lacks: the line hidden, the lack in its place') };
  })()`);
  assert.deepEqual(gallery, { waits: { wait: 'block', lack: 'none' }, lacks: { wait: 'none', lack: 'flex' } });
  await chrome.evaluate(`(async () => {
    const { pageReach } = await import('/lib/reach.js');
    const kit = await import('/ui/kit/index.js');
    const root = document.createElement('div');
    root.id = 'reach-root';
    document.body.prepend(root);
    kit.reading(root, true);
    root.insertAdjacentHTML('beforeend', kit.lines(3) + kit.waitLine() + kit.pageLack('Your connectors aren’t on this Mac yet.', { reach: true }));
    let listener = null;
    const test = window.reachTest = { reads: 0, asked: 0, drawn: [] };
    const host = { follow: heard => { listener = heard; return () => {}; }, act: () => { test.asked += 1; return new Promise(() => {}); } };
    test.state = reach => listener({ reach });
    const page = pageReach(host, root);
    test.fail = () => { test.drawn.push(page.failed(Object.assign(new Error('Can\u2019t reach Lifestream.'), { status: 503, code: 'GONE' }),
      test.begun, () => { test.reads += 1; })); };
    test.page = page;
  })()`);
  const seen = [];
  for (const [at, step] of FIXTURE.recovery.entries()) {
    await chrome.evaluate(`window.reachTest.state(${JSON.stringify(step.reach)})`);
    if (at === 0) await chrome.evaluate('window.reachTest.begun = window.reachTest.page.begin()');
    if (at === 1) await chrome.evaluate('window.reachTest.fail()');
    const now = await chrome.evaluate(`(() => {
      const root = document.querySelector('#reach-root');
      return { lacks: root.classList.contains('ck-lacks'), wait: getComputedStyle(root.querySelector('.ck-sk-wait')).display,
        lack: getComputedStyle(root.querySelector('.ck-lack--reach')).display, reads: window.reachTest.reads, asked: window.reachTest.asked };
    })()`);
    seen.push({ step: step.step, ...now });
    assert.equal(now.lacks, step.lacks, step.step);
    assert.equal(now.wait, step.lacks ? 'none' : 'block', step.step);
    assert.equal(now.lack, step.lacks ? 'flex' : 'none', step.step);
    assert.equal(now.reads, step.reads, step.step);
  }
  assert.equal(seen.at(-1)?.asked, 1);
  assert.deepEqual(await chrome.evaluate('window.reachTest.drawn'), [{ kind: 'reach' }]);
  summary.recovery = seen;
  await chrome.evaluate(`document.querySelector('.gallery__group:has(.ck-strip)')?.scrollIntoView()`);
  await chrome.shoot(join(OUT, 'reach.png'));
});

test('K7: a read waiting out the home\'s time shows its lack, never a bare skeleton, once reach lacks', async () => {
  assert.ok(chrome, 'Chrome opened by K6');
  const seen = await chrome.evaluate(`(async () => {
    const { pageReach } = await import('/lib/reach.js');
    const kit = await import('/ui/kit/index.js');
    const root = document.createElement('div');
    root.id = 'wait-root';
    document.body.prepend(root);
    kit.reading(root, true);
    let listener = () => {};
    const host = { follow: heard => { listener = heard; heard({ reach: ${JSON.stringify(FIXTURE.states.answering.reach)} }); return () => {}; },
      act: () => new Promise(() => {}) };
    const page = pageReach(host, root);
    const drawn = page.failed(Object.assign(new Error('Your people are being prepared.'), { status: 503, code: 'NOT_NOW', retryAfter: 5, wait: 'busy' }),
      page.begin(), () => {});
    root.insertAdjacentHTML('beforeend', kit.lines(3) + kit.readingAgain(drawn, 'Your people aren\u2019t on this Mac yet.'));
    const shown = () => ({ wait: getComputedStyle(root.querySelector('.ck-sk-wait')).display,
      lack: getComputedStyle(root.querySelector('.ck-lack--reach')).display });
    const before = shown();
    listener({ reach: ${JSON.stringify(FIXTURE.states.unreachable.reach)} });
    const after = shown();
    page.close();
    root.remove();
    return { kind: drawn.kind, words: root.querySelector('.ck-sk-wait').textContent, before, after };
  })()`);
  assert.deepEqual(seen, { kind: 'wait', words: 'Your people are being prepared.', before: { wait: 'block', lack: 'none' },
    after: { wait: 'none', lack: 'flex' } });
  summary.waitThenLacks = seen;
});

test('K8: the window\'s strip takes and gives back the focus, updates in place, posts Start Lifestream and wraps its line', async () => {
  assert.ok(chrome, 'K6 opened Chrome');
  const reaches = JSON.stringify(Object.fromEntries(Object.entries(FIXTURE.states).map(([name, { reach }]) => [name, reach])));
  await chrome.evaluate(`(async () => {
    const { installHomeStrip } = await import('/ui/home-strip.js');
    const holder = document.createElement('div');
    holder.id = 'strip-test';
    holder.style.width = '1100px';
    document.body.prepend(holder);
    const test = window.stripTest = { posted: [], answer: null, reaches: ${reaches} };
    const host = { act: message => { test.posted.push(message); return new Promise(done => { test.answer = done; }); } };
    test.draw = reach => installed.state({ reach });
    const installed = installHomeStrip(holder, host);
    test.state = name => test.draw(test.reaches[name]);
  })()`);
  const focus = () => chrome?.evaluate(`(() => { const at = document.activeElement;
    return at === document.body ? 'body' : at?.closest('.ck-popover') ? 'popover' : at?.matches('[data-home-details]') ? 'details' : at?.tagName ?? null; })()`);
  await chrome.evaluate(`window.stripTest.state('unreachable')`);
  await chrome.evaluate(`document.querySelector('#strip-test [data-home-details]').focus()`);
  await chrome.evaluate(`document.querySelector('#strip-test [data-home-details]').click()`);
  assert.equal(await chrome.evaluate(`Boolean(document.querySelector('#strip-test .ck-path'))`), true, 'the checklist open');
  assert.equal(await focus(), 'popover', 'the checklist takes the focus');
  await chrome.key('Escape');
  assert.equal(await chrome.evaluate(`Boolean(document.querySelector('#strip-test .ck-path'))`), false, 'Escape closes it');
  assert.equal(await focus(), 'details', 'the focus back on the ›');
  await chrome.evaluate(`window.stripTest.kept = document.querySelector('#strip-test [data-home-details]')`);
  await chrome.evaluate(`window.stripTest.draw({ ...window.stripTest.reaches.unreachable, meta: 'since Sun 15 Nov', revision: 9 })`);
  assert.deepEqual(await chrome.evaluate(`(() => { const now = document.querySelector('#strip-test [data-home-details]');
    return [now === window.stripTest.kept, document.activeElement === now, document.querySelector('#strip-test .ck-strip__meta').textContent]; })()`),
  [true, true, ' · since Sun 15 Nov']);
  await chrome.evaluate(`window.stripTest.state('unreachable, Lifestream not running')`);
  assert.equal(await chrome.evaluate(`Boolean(document.querySelector('#strip-test [data-home-details]'))`), false, 'one button: no › beside it');
  await chrome.evaluate(`document.querySelector('#strip-test .ck-strip__act[data-home-act="open"]').click()`);
  await chrome.evaluate(`document.querySelector('#strip-test .ck-strip__act[data-home-act="open"]').click()`);
  assert.deepEqual(await chrome.evaluate('window.stripTest.posted'), [{ act: 'home', do: 'open' }], 'once while the host answers');
  assert.equal(await chrome.evaluate(`document.querySelector('#strip-test .ck-strip__act[data-home-act="open"]').classList.contains('is-busy')`), true);
  await chrome.evaluate('window.stripTest.answer({})');
  await chrome.until(`!document.querySelector('#strip-test .is-busy')`, 'the act answered');
  await chrome.evaluate(`window.stripTest.state('unreachable, checking again')`);
  await chrome.evaluate(`document.querySelector('#strip-test .ck-path') || document.querySelector('#strip-test [data-home-details]').click()`);
  assert.equal(await chrome.evaluate(`document.querySelector('#strip-test .ck-path [data-home-act="probe"]').classList.contains('is-busy')`), true);
  await chrome.key('Escape');
  const long = 'The drive holding Lifestream is not connected, so Lifestream waits for it before it opens again.';
  const wrapped = await chrome.evaluate(`(() => {
    const holder = document.querySelector('#strip-test');
    holder.style.width = '520px';
    window.stripTest.draw({ ...window.stripTest.reaches.held, line: ${JSON.stringify(long)} });
    const strip = holder.querySelector('.ck-strip'); const line = holder.querySelector('.ck-strip__line');
    return { tall: strip.getBoundingClientRect().height, whole: line.scrollWidth <= line.clientWidth + 1, cut: getComputedStyle(line).textOverflow };
  })()`);
  assert.ok(wrapped.tall > 40, `the strip grows to hold the line: ${wrapped.tall}`);
  assert.equal(wrapped.whole, true, 'the line read whole');
  assert.notEqual(wrapped.cut, 'ellipsis');
  summary.strip = { wrapped };
  await chrome.evaluate(`document.querySelector('#strip-test').scrollIntoView()`);
  await chrome.shoot(join(OUT, 'strip-wrapped.png'));
  await chrome.evaluate(`document.querySelector('#strip-test').remove()`);
});
