// @ts-check
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createViewer } from '../server.mjs';
import { openDoor } from '../lib/door.mjs';
import { BODY_BYTES } from '../lib/routes/agents.mjs';
import { withoutPaths } from '../lib/errors.mjs';
import { readHost } from '../public/lib/host.js';
import { accessChangeOf, answerReplyOf, answerWord, askAnswer, askChanges, askChoices, askOf, draftOf, NOT_SURE,
  refusalWords, signInAnswer, signInOf, UNREACHED } from '../public/lib/agents.js';
import { draftEditor, settingsEditor } from '../public/lib/editor.js';
import { accessRows, agentDetail, answerKeys, answerOrder, askOf as askPart, controlFoot, controlOf, draftDetail, HISTORY_FOLDS, hidesOf, historyOf,
  historyWith, NO_AGENT_READS, sinceEdit, whenWords }
  from '../public/ui/agents/detail.js';
import { agentsList } from '../public/ui/agents/list.js';
import { PAGE as AGENT_PAGE } from '../public/ui/agents/words.js';
import { OPENED } from '../public/ui/connectors/dialog.js';
import { accessChatCard, accessNarrowed } from '../public/ui/kit/access-card.js';
import { askBody } from '../public/ui/kit/agent-card.js';
import { askCard, noticeCard, signInCard } from '../public/ui/agents/cards.js';
import { setIcons } from '../public/ui/kit/icon.js';
import { asking, turnsOf, withEvent } from '../public/ui/ask/turns.js';
import { chatAccess } from '../public/ui/ask/access.js';
import { esc } from '../public/lib/html.js';
import { counted, phraseWords } from '../public/lib/words.js';
import { until } from './until.mjs';

/** @typedef {import('../public/types.js').AgentAsk} AgentAsk */
/** @typedef {import('../public/types.js').AccessDraft} AccessDraft */
/** @typedef {import('../public/types.js').AgentRead} AgentRead */
/** @typedef {import('../public/types.js').EditRequest} EditRequest */
/** @typedef {{ route: string, request: any, status: number, answer: any }} Contract */

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'homelink', 'Tests', 'Fixtures');
/** @param {string} folder */
const filesOf = folder => Object.fromEntries(readdirSync(join(FIXTURES, folder)).filter(name => name.endsWith('.json'))
  .map(name => [name.slice(0, -'.json'.length), JSON.parse(readFileSync(join(FIXTURES, folder, name), 'utf8'))]));
/** @type {Record<string, Contract>} */
const FILES = filesOf('agents/door');
/**
 * @typedef {{ from: string, state?: any, act?: any, sent?: any, reply?: any }} HostFile
 * @type {Record<string, HostFile>}
 */
const HOST_FILES = filesOf('agents-host');
/**
 * @param {string} name
 * @returns {Contract}
 */
const file = name => {
  assert.ok(FILES[name], `the contract file ${name}.json`);
  return FILES[name];
};
const READER = /** @type {AgentRead} */ (file('reader-agent').answer);
/** @param {string} markup */
const cardPicks = markup => [...markup.matchAll(/data-agent-pick="([^"]+)"/gu)].map(found => JSON.parse(found[1].replaceAll('&quot;', '"')).answer);
const ASKS = /** @type {AgentAsk[]} */ (HOST_FILES.waiting.state.agent_asks);
const SIGN_IN = HOST_FILES['waiting-sign-in'].state.agent_requests[0];
const EVERY_ASK = [...ASKS, ...Object.entries(FILES).filter(([name, each]) => name.startsWith('ask-') && each.status === 200)
  .map(([, each]) => /** @type {AgentAsk} */ (each.answer))];
setIcons(JSON.parse(readFileSync(resolve(FIXTURES, '..', '..', '..', 'design', 'icons.json'), 'utf8')));
/**
 * @param {Record<string, unknown>} value
 * @param {string} key
 */
const without = (value, key) => Object.fromEntries(Object.entries(value).filter(([each]) => each !== key));
/** @param {Contract} refused */
const refusalOf = refused => Object.assign(new Error(refused.answer.message), { status: refused.status, code: refused.answer.code });

/** @param {unknown} state */
const hostWindow = state => ({ lifestreamHost: { kind: 'mac', version: 6, state }, addEventListener: () => {}, removeEventListener: () => {},
  webkit: { messageHandlers: { lifestream: { postMessage: () => ({}) } } } });

test('X1: an ask, a sign-in and Chat’s change kept as the home wrote them, the same object; one member short, none', () => {
  assert.ok(EVERY_ASK.length >= 10, 'every ask the contract answers');
  for (const ask of EVERY_ASK) {
    assert.equal(askOf(ask), ask, ask.id);
    for (const key of Object.keys(ask)) assert.equal(askOf(without(ask, key)), null, `${ask.id} without ${key}`);
    assert.equal(askOf({ ...ask, outcome: ask.state === 'open' ? [{ kind: 'words', words: 'Not allowed' }] : null }), null, `${ask.id} with an outcome its state does not have`);
  }
  assert.equal(signInOf(SIGN_IN), SIGN_IN);
  for (const key of Object.keys(SIGN_IN)) assert.equal(signInOf(without(SIGN_IN, key)), null, `a sign-in without ${key}`);
  for (const name of ['propose-narrowed', 'propose-unchanged', 'propose-asked']) {
    const change = file(name).answer;
    assert.equal(accessChangeOf(change), change, name);
    for (const key of Object.keys(change)) assert.equal(accessChangeOf(without(change, key)), null, `${name} without ${key}`);
  }
  const host = readHost(/** @type {any} */ (hostWindow({ agent_asks: ASKS, agent_requests: [SIGN_IN] })));
  assert.equal(host?.state.agent_asks.length, ASKS.length);
  assert.ok(host?.state.agent_asks.every((each, at) => each === ASKS[at]));
  assert.equal(host?.state.agent_requests[0], SIGN_IN);
  const odd = readHost(/** @type {any} */ (hostWindow({ agent_asks: [without(ASKS[0], 'choices'), ...ASKS.slice(1)] })));
  assert.deepEqual(odd?.state.agent_asks, ASKS.slice(1));
  const narrowed = file('propose-narrowed').answer;
  const asked = file('propose-asked').answer;
  let turn = asking('allow Instinct only the past 24 hours', 1_000);
  turn = withEvent(turn, { type: 'access', change: narrowed });
  turn = withEvent(turn, { type: 'access', change: /** @type {any} */ (without(asked, 'snapshot')) });
  turn = withEvent(turn, { type: 'access', change: asked });
  assert.deepEqual(turn.access, [narrowed, asked]);
  const message = { chat: 'c1', n: 2, at_ms: 2_000, role: /** @type {const} */ ('assistant'), text: 'Done.', end: /** @type {const} */ ('done'),
    access: [narrowed, without(narrowed, 'undo'), asked] };
  const kept = turnsOf({ chat: 'c1', title: '', messages: [{ chat: 'c1', n: 1, at_ms: 1_000, role: 'user', text: 'q' }, /** @type {any} */ (message)] });
  assert.deepEqual(kept[0].access, [narrowed, asked]);
});

test('X2: each answer the page sends is the file’s request for the same act', () => {
  const ask = /** @type {AgentAsk} */ (file('ask-open').answer);
  const names = Object.keys(FILES).filter(name => name.startsWith('answer-'));
  assert.equal(names.length, 14, 'every answer file');
  for (const name of names) {
    const { request } = file(name);
    const sent = request.id.startsWith('rq-')
      ? askAnswer({ ...ask, id: request.id, version: request.expect ?? ask.version }, request.answer,
        request.access ? { access: request.access, expect: request.expect, view: READER.view } : null)
      : signInAnswer(request.id, request.answer, request.access ?? null);
    assert.deepEqual(sent, request, name);
  }
  const signIn = file('answer-sign-in').request;
  const deny = file('answer-sign-in-deny').request;
  assert.deepEqual(signInAnswer(deny.id, 'deny', signIn.access), deny, 'a deny carries no access');
});

/** @param {(asked: { method: string, path: string, body: unknown }) => Contract} answer */
async function standInDoor(answer) {
  /** @type {{ method: string, path: string, body: unknown }[]} */
  const asked = [];
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const seen = { method: request.method ?? '', path: request.url ?? '', body: text ? JSON.parse(text) : null };
    if (seen.path.startsWith('/v1/agents')) asked.push(seen);
    const contract = answer(seen);
    response.writeHead(contract.status, { 'content-type': 'application/json' }).end(JSON.stringify(contract.answer));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  after(() => new Promise(done => { server.closeAllConnections(); server.close(() => done(undefined)); }));
  return { url: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`, asked };
}

/** @param {string} url */
async function dashboard(url) {
  const server = await createViewer({ door: openDoor({ url, token: () => 'stand-in-token' }) });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  after(() => new Promise(done => { server.closeAllConnections(); server.close(() => done(undefined)); }));
  return `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
}

const PAGE = { 'Content-Type': 'application/json', 'X-Viewer-Request': '1' };

test('X3: every route of the contract through the dashboard’s proxy: the request as the file’s, the answer passed whole', async () => {
  /** @type {Contract} */
  let serving = file('list');
  const door = await standInDoor(() => serving);
  const at = await dashboard(door.url);
  const history = file('history').answer;
  const HOSTED = ['/v1/agents/<id>/disconnect', '/v1/agents/<id>/unlist'];
  const READ_CALL = 'call-0000000000000001';
  /**
   * @param {string} name
   * @param {Contract} contract
   * @returns {{ path: string, method: string, body?: unknown, reaches: string }}
   */
  const callOf = (name, contract) => {
    const [method, route] = contract.route.split(' ');
    const reader = contract.answer?.id && /^(ask|p-)/u.test(contract.answer.id) ? contract.answer.id : 'p-00000001';
    const ask = contract.answer?.id?.startsWith?.('rq-') ? contract.answer.id : 'rq-0000000000000001';
    if (route === '/v1/agents') return { method, path: '/api/agents', reaches: '/v1/agents' };
    if (route === '/v1/agents/waiting') return { method, path: '/api/agents/waiting', reaches: '/v1/agents/waiting' };
    if (route === '/v1/agents/<id>') return { method, path: `/api/agents/one?id=${reader}`, reaches: `/v1/agents/${reader}` };
    if (route === '/v1/agents/<id>/history') return { method, path: '/api/agents/history?id=p-00000001', reaches: '/v1/agents/p-00000001/history' };
    if (route === '/v1/agents/<id>/history?before=') {
      const before = name === 'history-bad-cursor' ? 'not-a-page' : history.next.before;
      return { method, path: `/api/agents/history?id=p-00000001&before=${before}`, reaches: `/v1/agents/p-00000001/history?before=${before}` };
    }
    if (route === '/v1/agents/<id>/history?kind=') {
      const kind = contract.answer.kind ?? 'messages';
      return { method, path: `/api/agents/history?id=p-00000001&kind=${kind}`, reaches: `/v1/agents/p-00000001/history?kind=${kind}` };
    }
    if (route === '/v1/agents/<id>/reads/<call>') {
      return { method, path: `/api/agents/read?id=p-00000001&read=${READ_CALL}`, reaches: `/v1/agents/p-00000001/reads/${READ_CALL}` };
    }
    if (route === '/v1/agents/<id>/reads/<call>/things') {
      return { method, path: `/api/agents/things?id=p-00000001&read=${READ_CALL}`, reaches: `/v1/agents/p-00000001/reads/${READ_CALL}/things` };
    }
    if (route === '/v1/agents/asks/<id>') return { method, path: `/api/agents/ask?id=${ask}`, reaches: `/v1/agents/asks/${ask}` };
    if (route === '/v1/agents/signins/<id>') {
      const signIn = contract.answer?.id ?? 'AAAAAAAAAAAAAAAAAAAAAA';
      return { method, path: `/api/agents/signin?id=${signIn}`, reaches: `/v1/agents/signins/${signIn}` };
    }
    if (route === '/v1/agents/<id>/access' || route === '/v1/agents/<id>/propose') {
      const part = route.endsWith('access') ? 'access' : 'propose';
      return { method, path: `/api/agents/${part}`, body: { id: 'p-00000001', ...contract.request }, reaches: `/v1/agents/p-00000001/${part}` };
    }
    if (route === '/v1/agents/edit' || route === '/v1/agents/answer') {
      return { method, path: route.replace('/v1/', '/api/'), body: contract.request ?? { target: { reader: 'p-00000001' } }, reaches: route };
    }
    throw new Error(`no call of the page reaches ${contract.route} (${name})`);
  };
  const hosted = Object.keys(FILES).filter(name => HOSTED.includes(file(name).route.split(' ')[1] ?? ''));
  assert.deepEqual(hosted.sort(), ['disconnect', 'disconnect-person-only', 'unlist', 'unlist-connected'],
    'the person-only routes the page sends through its host, never its proxy');
  const names = Object.keys(FILES).filter(name => !hosted.includes(name)).sort();
  assert.ok(names.length >= 69, 'every file');
  assert.ok(names.some(name => /"lasts_ms"/u.test(JSON.stringify(file(name).request ?? null))), 'a draft with a span sent as the file has it');
  for (const name of names) {
    const contract = file(name);
    serving = contract;
    const call = callOf(name, contract);
    door.asked.length = 0;
    const response = await fetch(`${at}${call.path}`, call.method === 'POST'
      ? { method: 'POST', headers: PAGE, body: JSON.stringify(call.body) } : {});
    const body = await response.json();
    assert.equal(door.asked.length, 1, `${name}: one request reached the door`);
    assert.equal(door.asked[0].method, call.method, name);
    assert.equal(door.asked[0].path, call.reaches, name);
    if (call.method === 'POST' && contract.request) assert.deepEqual(door.asked[0].body, contract.request, `${name}: the file's request`);
    assert.equal(response.status, contract.status, name);
    if (contract.status < 300) assert.deepEqual(body, contract.answer, `${name}: the answer whole`);
    else {
      assert.deepEqual(body, { error: withoutPaths(contract.answer.message), code: contract.answer.code }, `${name}: the door's code and words`);
      const words = refusalWords(Object.assign(new Error(body.error), { status: response.status, code: body.code }));
      assert.equal(words, body.error, `${name}: said in the home's words`);
    }
  }
  assert.ok(names.some(name => file(name).status === 422), 'a 422 among them');
  door.asked.length = 0;
  for (const path of ['/api/agents/one?id=../x', '/api/agents/one', '/api/agents/history?id=p-00000001&before=../x', '/api/agents/ask?id=x']) {
    assert.equal((await fetch(`${at}${path}`)).status, 400, path);
  }
  assert.equal((await fetch(`${at}/api/agents/access`, { method: 'POST', headers: PAGE, body: JSON.stringify({ id: '../x' }) })).status, 400);
  assert.equal((await fetch(`${at}/api/agents/edit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  const large = await fetch(`${at}/api/agents/edit`, { method: 'POST', headers: PAGE, body: JSON.stringify({ pad: 'x'.repeat(BODY_BYTES) }) });
  assert.equal(large.status, 413);
  assert.equal((await large.json()).code, 'BODY_TOO_LARGE');
  assert.deepEqual(door.asked, [], 'nothing malformed or too large reached the door');
});

/**
 * @param {(asked: EditRequest) => void} [seen]
 * @returns {(asked: EditRequest) => Promise<AccessDraft>}
 */
const homeEditor = (seen = () => {}) => async asked => {
  seen(asked);
  const found = Object.entries(FILES).find(([name, each]) => name.startsWith('edit-') && JSON.stringify(sorted(each.request))
    === JSON.stringify(sorted(asked)));
  assert.ok(found, `a file holds the edit sent: ${JSON.stringify(asked).slice(0, 200)}`);
  const [, contract] = found;
  if (contract.status !== 200) throw refusalOf(contract);
  return contract.answer;
};
/**
 * @param {unknown} value
 * @returns {unknown}
 */
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, each]) => [key, sorted(each)])) : value;

/** @template T */
function held() {
  /** @type {(value: T) => void} */
  let resolve = () => {};
  /** @type {(error: unknown) => void} */
  let reject = () => {};
  const promise = /** @type {Promise<T>} */ (new Promise((yes, no) => { resolve = yes; reject = no; }));
  return { promise, resolve, reject };
}

test('X4: each tap the editor sends is a file’s request, on the last acknowledged draft; one at a time', async () => {
  const editor = draftEditor({ target: { reader: READER.id }, edit: homeEditor(), changed: () => {} });
  assert.equal(await editor.start(/** @type {any} */ (READER.access), READER.version), true);
  assert.deepEqual(editor.draft, file('edit-draw').answer);
  for (const [name, contract] of Object.entries(FILES)) {
    if (!name.startsWith('edit-') || !contract.request.edit || contract.status !== 200) continue;
    const one = draftEditor({ target: contract.request.target, edit: homeEditor(), changed: () => {} });
    one.hold({ access: contract.request.access, expect: contract.request.expect, view: READER.view });
    assert.equal(await one.tap(contract.request.edit), true, name);
    assert.deepEqual(one.draft, contract.answer, name);
  }
  /** @type {EditRequest[]} */
  const sent = [];
  const slow = held();
  const once = draftEditor({ target: { reader: READER.id }, edit: asked => { sent.push(asked); return /** @type {any} */ (slow.promise); }, changed: () => {} });
  once.hold(file('edit-draw').answer);
  const first = once.tap({ mode: 'but' });
  assert.equal(once.busy, true);
  assert.equal(await once.tap({ hide: 'custom' }), false, 'a tap while one is in flight is not sent');
  slow.resolve(file('edit-mode-but').answer);
  assert.equal(await first, true);
  assert.equal(sent.length, 1);
  const next = draftEditor({ target: { reader: READER.id }, edit: async asked => { sent.push(asked); return file('edit-hide').answer; }, changed: () => {} });
  next.hold(file('edit-mode-but').answer);
  await next.tap({ hide: 'custom' });
  assert.deepEqual(sent.at(-1)?.access, file('edit-mode-but').answer.access);
});

test('X4: a stale draft is drawn again; an unreachable home keeps the last acknowledged draft; a closed editor’s reply is dropped', async () => {
  /** @type {string[]} */
  const stale = [];
  const editor = draftEditor({ target: { reader: READER.id }, edit: homeEditor(), changed: () => {}, stale: (code, words) => stale.push(code, words) });
  const before = { access: file('edit-stale-refused').request.access, expect: 1, view: READER.view };
  editor.hold(before);
  assert.equal(await editor.start(file('edit-stale-refused').request.access, 1), false);
  assert.deepEqual(stale, ['ACCESS_CHANGED', file('edit-stale-refused').answer.message]);
  assert.equal(editor.failed, file('edit-stale-refused').answer.message);
  const away = draftEditor({ target: { reader: READER.id }, edit: async () => { throw Object.assign(new Error('Can’t reach Lifestream.'),
    { status: 503, code: 'NOT_NOW' }); }, changed: () => {} });
  away.hold(file('edit-draw').answer);
  assert.equal(await away.tap({ mode: 'but' }), false);
  assert.deepEqual(away.draft, file('edit-draw').answer);
  assert.equal(away.failed, UNREACHED);
  const signIn = draftEditor({ target: { request: SIGN_IN.id }, edit: homeEditor(), changed: () => {} });
  assert.equal(await signIn.start(SIGN_IN.access, null), true);
  assert.deepEqual(signIn.draft, file('edit-sign-in-browser').answer);
  assert.equal(signIn.failed, '');
  const slow = held();
  let draws = 0;
  const closing = draftEditor({ target: { reader: READER.id }, edit: () => /** @type {any} */ (slow.promise), changed: () => { draws += 1; } });
  closing.hold(file('edit-draw').answer);
  const tapped = closing.tap({ mode: 'but' });
  closing.close();
  const drawn = draws;
  slow.resolve(file('edit-mode-but').answer);
  assert.equal(await tapped, false);
  assert.equal(draws, drawn, 'nothing drawn for a closed editor');
  assert.deepEqual(closing.draft, file('edit-draw').answer);
  const late = held();
  /** @type {Promise<AccessDraft>[]} */
  const replies = [/** @type {any} */ (late.promise), Promise.resolve(file('edit-draw').answer)];
  const again = draftEditor({ target: { reader: READER.id }, edit: () => /** @type {Promise<AccessDraft>} */ (replies.shift()), changed: () => {} });
  again.hold(file('edit-draw').answer);
  const old = again.tap({ mode: 'but' });
  await again.start(/** @type {any} */ (READER.access), 1);
  late.resolve(file('edit-mode-but').answer);
  assert.equal(await old, false);
  assert.deepEqual(again.draft, file('edit-draw').answer);
});

const UNSAVED = /** @type {AccessDraft} */ (file('edit-account-on').answer);

/** @param {{ widen?: boolean, save?: (id: string, saved: any) => Promise<AccessDraft>, edit?: (asked: EditRequest) => Promise<AccessDraft> }} [options] */
function settingsOver({ widen = false, save, edit = homeEditor() } = {}) {
  /** @type {{ saved: unknown[], widened: unknown[], read: string[] }} */
  const sent = { saved: [], widened: [], read: [] };
  const editor = settingsEditor({ reader: READER.id, changed: () => {}, io: {
    edit,
    save: save ?? (async (id, saved) => {
      sent.saved.push({ id, ...saved });
      return { access: saved.access, expect: saved.expect + 1, view: READER.view };
    }),
    widen: widen ? async (id, saved) => {
      sent.widened.push({ id, ...saved });
      return /** @type {AccessDraft} */ (HOST_FILES['access-widened'].reply.answer);
    } : null,
    read: async id => {
      sent.read.push(id);
      return { ...READER, version: 2 };
    },
  } });
  editor.open(READER);
  return { editor, sent };
}

test('X5: a narrowing is saved by its edit: nothing saved again, its words and Undo kept, the next tap from its draft', async () => {
  const narrowing = /** @type {AccessDraft} */ (file('edit-window').answer);
  const { editor, sent } = settingsOver();
  await editor.tap({ window: { past_ms: 2592000000 } });
  assert.deepEqual(sent.saved, [], 'the edit saved it');
  assert.equal(editor.held, null);
  assert.equal(editor.narrowed, narrowing.narrowed);
  assert.equal(editor.draft?.expect, narrowing.expect, 'the next tap starts from the edit’s draft');
  assert.equal(editor.undoes, false, 'no Undo from a browser');
  await editor.undo();
  assert.deepEqual(sent.widened, []);
  const mac = settingsOver({ widen: true });
  await mac.editor.tap({ window: { past_ms: 2592000000 } });
  assert.equal(mac.editor.undoes, true);
  await mac.editor.undo();
  assert.deepEqual(mac.sent.widened, [{ id: READER.id, ...narrowing.narrowed?.undo }], 'Undo saves the access before, under the edit’s version');
  assert.equal(mac.editor.narrowed, null);
  assert.equal(mac.editor.draft, HOST_FILES['access-widened'].reply.answer, 'the next tap starts from the undo’s draft');
  /** @type {unknown[]} */
  const saves = [];
  const plain = settingsOver({ edit: async () => UNSAVED, save: async (id, saved) => {
    saves.push({ id, ...saved });
    return { ...UNSAVED, expect: 4 };
  } });
  await plain.editor.tap({ later: false });
  assert.deepEqual(saves, [{ id: READER.id, access: UNSAVED.access, expect: UNSAVED.expect }], 'a draft its edit left unsaved, saved');
  assert.equal(plain.editor.draft?.expect, 4);
  const away = settingsOver({ edit: async () => { throw Object.assign(new Error('x'), { status: 503, code: 'NOT_NOW' }); } });
  await away.editor.tap({ window: { past_ms: 2592000000 } });
  await away.editor.save();
  assert.deepEqual(away.sent.saved, []);
  assert.equal(away.editor.note, UNREACHED);
  assert.equal(away.editor.draft?.expect, 1);
});

test('X5: a narrowing while a widening waits is saved, its words beside the widening’s; Cancel drops the widening alone, Allow saves it alone', async () => {
  const split = /** @type {AccessDraft} */ (file('edit-narrowed-widening-waits').answer);
  assert.ok(split.narrowed && split.saved && split.view.widens, 'the file: a narrowing saved under a widening that waits');
  const mac = settingsOver({ widen: true, edit: async () => split });
  await mac.editor.tap({ type: 'mail', on: false });
  assert.deepEqual(mac.sent.saved, [], 'the edit saved the narrowing');
  assert.equal(mac.editor.held, split, 'the widening still waits for Allow');
  assert.equal(mac.editor.narrowed, split.narrowed);
  const foot = controlFoot(split.view, { view: split.view, busy: false, note: '', held: true, narrowed: split.narrowed, undoes: true }, 'reader', false);
  assert.deepEqual([foot.said, foot.mark, foot.waits], [split.narrowed.words, 'done', split.view.widening],
    'what was saved on one line, its done mark, and what waits on the next');
  assert.deepEqual(foot.end.map(act => act.do), [{ editor: 'cancel' }, { editor: 'save' }]);
  mac.editor.cancel();
  assert.equal(mac.editor.held, null);
  assert.deepEqual([mac.editor.draft?.access, mac.editor.draft?.view, mac.editor.draft?.expect], [split.saved.access, split.saved.view, split.expect],
    'Cancel goes back to what is saved now: the narrowing stays');
  assert.equal(mac.editor.narrowed, split.narrowed, 'its Undo stays');
  const allowing = settingsOver({ widen: true, edit: async () => split });
  await allowing.editor.tap({ type: 'mail', on: false });
  await allowing.editor.save();
  assert.deepEqual(allowing.sent.widened, [{ id: READER.id, access: split.access, expect: split.expect }], 'Allow saves the widening over the saved narrowing');
});

test('X5: a narrowing’s Undo stays while it still works: a later widening tap and Cancel keep it, a save that moves the version ends it', async () => {
  const split = /** @type {AccessDraft} */ (file('edit-narrowed-widening-waits').answer);
  if (!split.narrowed || !split.saved) throw new Error('the file: a narrowing saved under a widening that waits');
  const wider = { ...split, narrowed: null, saved: null };
  const plain = { ...split.saved, expect: split.expect, narrowed: null, saved: null };
  const answers = [split, wider, plain];
  const mac = settingsOver({ widen: true, edit: async () => /** @type {AccessDraft} */ (answers.shift()) });
  await mac.editor.tap({ type: 'mail', on: false });
  await mac.editor.tap({ mode: 'but' });
  assert.equal(mac.editor.held, wider);
  assert.equal(mac.editor.narrowed, split.narrowed, 'a widening tap leaves the saved narrowing and its Undo');
  mac.editor.cancel();
  assert.equal(mac.editor.narrowed, split.narrowed, 'Cancel after it: the Undo still works, so it stays');
  await mac.editor.tap({ later: false });
  assert.deepEqual(mac.sent.saved, [{ id: READER.id, access: plain.access, expect: split.expect }]);
  assert.equal(mac.editor.narrowed, null, 'a save moved the version: that Undo no longer works');
});

test('X5: a widening from a browser is the home’s to refuse, in its words; on the Mac it goes through the host, and its draft is the one the next tap starts from', async () => {
  const wider = /** @type {AccessDraft} */ ({ ...file('edit-type-on').answer, expect: 1 });
  assert.ok(wider.view.widens, 'the file widens');
  const browser = settingsOver({ edit: async () => wider, save: async (id, saved) => {
    assert.deepEqual({ id, ...saved }, { id: READER.id, access: wider.access, expect: 1 });
    throw refusalOf(file('access-person-only'));
  } });
  await browser.editor.tap({ type: 'health', on: true });
  assert.ok(browser.editor.held, 'a widening waits for Allow');
  await browser.editor.save();
  assert.equal(browser.editor.note, file('access-person-only').answer.message);
  assert.deepEqual(browser.sent.read, [READER.id], 'the reader read again');
  const mac = settingsOver({ widen: true, edit: async () => wider });
  await mac.editor.tap({ type: 'health', on: true });
  await mac.editor.save();
  assert.deepEqual(mac.sent.widened, [{ id: READER.id, access: wider.access, expect: 1 }]);
  assert.deepEqual(mac.sent.read, [], 'the host answers the draft: no reader read again');
  assert.equal(mac.editor.draft, HOST_FILES['access-widened'].reply.answer, 'the next tap starts from the save’s draft');
});

test('X5: a preview turning the screen on waits on Save; Cancel drops it; a save refused or lost reads the reader again', async () => {
  const screen = /** @type {AccessDraft} */ ({ ...file('edit-sign-in').answer, expect: 1 });
  const narrowing = { ...screen, view: { ...screen.view, widens: false } };
  const { editor, sent } = settingsOver({ edit: async () => narrowing });
  await editor.tap({ window: { past_ms: 86_400_000 } });
  assert.equal(editor.held, narrowing, 'held for its line');
  assert.deepEqual(sent.saved, [], 'nothing saved before Save');
  await editor.tap({ later: false });
  assert.deepEqual(sent.saved, [], 'no tap while a preview is held');
  editor.cancel();
  assert.equal(editor.held, null);
  assert.deepEqual(editor.draft?.access, READER.access);
  await editor.tap({ window: { past_ms: 86_400_000 } });
  await editor.save();
  assert.deepEqual(sent.saved, [{ id: READER.id, access: narrowing.access, expect: 1 }]);
  const stale = settingsOver({ edit: async () => UNSAVED, save: async () => { throw refusalOf(file('access-stale')); } });
  await stale.editor.tap({ window: { past_ms: 2592000000 } });
  assert.deepEqual(stale.sent.read, [READER.id]);
  assert.equal(stale.editor.note, file('access-stale').answer.message);
  assert.equal(stale.editor.draft?.expect, 2);
  const lost = settingsOver({ edit: async () => UNSAVED, save: async () => {
    throw Object.assign(new Error('x'), { status: 503, code: 'OUTCOME_UNKNOWN' });
  } });
  await lost.editor.tap({ window: { past_ms: 2592000000 } });
  assert.deepEqual(lost.sent.read, [READER.id]);
  assert.equal(lost.editor.note, NOT_SURE);
  const later = file('access-later-refused');
  assert.equal(later.status, 422);
  assert.equal(later.answer.code, 'BAD_REQUEST');
  const refused = settingsOver({ edit: async () => UNSAVED, save: async () => { throw refusalOf(later); } });
  await refused.editor.tap({ window: { past_ms: 2592000000 } });
  assert.deepEqual(refused.sent.read, [READER.id], 'a save the parser refused reads the reader again');
  assert.equal(refused.editor.draft?.expect, 2);
});

const AT = { now: Date.UTC(2026, 10, 14, 12), when: whenWords('2026-11-14') };
/** @param {import('../public/ui/connectors/dialog.js').DetailPart[]} parts */
const rowsOf = parts => parts.flatMap(part => part.panel?.rows ?? []);
/** @param {AccessDraft['view']} view */
const shown = view => ({ view, busy: false, note: '', held: false });
/**
 * @param {AgentRead} agent
 * @param {string[]} [pages]
 * @param {Record<string, string>} [fields]
 */
const agentAt = (agent, pages = [], fields = {}) => agentDetail(`agent:${agent.id}`, { ...NO_AGENT_READS, one: agent,
  editor: shown(agent.view), history: file('history').answer }, { state: null, opened: { ...OPENED, pages, fields }, home: true,
  now: AT.now, when: AT.when });
/** @param {import('../public/ui/connectors/dialog.js').Detail} detail */
const controlIn = detail => /** @type {import('../public/ui/agents/detail.js').Control} */ (detail.parts.find(part => part.control)?.control);

test('X6: the Agents page and an agent are the home’s: the list, the agent’s Access, its one list, its hides, its history paged by entry', () => {
  const list = file('list').answer;
  const drawn = agentsList({ readers: list.readers, state: null });
  const rows = drawn.sections.flatMap(section => section.rows).filter(row => !row.review);
  assert.deepEqual(rows.map(row => row.name), list.readers.map((/** @type {any} */ each) => each.name).filter((/** @type {string} */ name) =>
    list.readers.find((/** @type {any} */ each) => each.name === name).kind !== 'chat').concat(['Chat']));
  assert.deepEqual(rows.map(row => row.line), [...list.readers.filter((/** @type {any} */ each) => each.kind !== 'chat'),
    ...list.readers.filter((/** @type {any} */ each) => each.kind === 'chat')].map((/** @type {any} */ each) => each.summary));
  const page = agentAt(READER);
  const access = page.parts.find(part => part.label === 'Access');
  assert.deepEqual(rowsOf(access ? [access] : []).map(row => [row.label, row.line, row.go?.do ?? null, row.menu?.words ?? null]), [
    ['Reads', READER.view.reads, { page: 'access' }, null],
    ['How far back', '', null, READER.view.window.words],
    ['Hides', '', null, READER.view.hide?.words]], 'each row edits its own part: Reads pushes, the other two are menus in place');
  assert.deepEqual(page.parts[0].figure, READER.figure, 'the home’s figure first');
  const pager = /** @type {AgentRead} */ (file('reader-reads').answer);
  const history = agentAt(pager).parts.find(part => part.label === 'History');
  assert.deepEqual(history?.aside, [{ text: pager.reads.since }]);
  assert.deepEqual(rowsOf(history ? [history] : []).map(row => [row.label, row.line, row.go?.time || (row.end && 'time' in row.end ? row.end.time : null)]),
    [...pager.recent.lines.map(line => [line.words, line.line ?? '', AT.when.clock(line.at_ms)]), ['See all history', '', null]],
    'the home’s last reads as rows, then See all history');
  assert.deepEqual(rowsOf(history ? [history] : []).at(-1)?.go?.do, { page: 'history' });
  assert.deepEqual(page.parts.find(part => part.label === 'Connection')?.panel?.rows.map(row => row.label), [READER.how]);

  const inside = agentAt(READER, ['access']);
  assert.equal(inside.name, 'Reads');
  assert.deepEqual(inside.said, READER.view.sentence, 'the home’s sentence under the title, its bold kept');
  assert.deepEqual(inside.back, { label: READER.name, above: true });
  assert.equal(inside.foot && 'menu' in inside.foot, false, 'no Start from: no presets');
  const control = controlIn(inside);
  assert.deepEqual(control.mode.choices.map(each => [each.words, each.chosen, each.do]), READER.view.modes.map(each => [each.words,
    each.mode === READER.view.mode, { edit: { mode: each.mode } }]));
  assert.deepEqual(control.mode.choices.map(each => each.words), ['Everything but', 'Only these']);
  assert.equal(control.modeLine, READER.view.mode_line, 'the picked mode’s meaning, the home’s');
  assert.deepEqual(control.lines.map(line => [line.name, line.check, line.do]), READER.view.categories.map(each => [each.name, each.state,
    { edit: { type: each.type, on: each.state !== 'on' } }]), 'every kind a check row, none folded away');
  assert.deepEqual(control.lines.map(line => line.differs && 'fold' in line.differs ? line.differs.fold.words
    : line.differs?.menu.words ?? null), READER.view.categories.map(each => each.differs), 'what differs, the home’s words inline');

  const folds = READER.view.categories.find(each => each.accounts.length > 1 && each.differs);
  assert.ok(folds, 'a fixture kind of more than one account');
  const fold = controlIn(agentAt(READER, ['access'])).lines.find(line => line.name === folds.name);
  assert.deepEqual([fold?.differs && 'fold' in fold.differs ? fold.differs.fold.open : null, fold?.inner.length], [false, 0], 'folded first');
  const open = controlIn(agentAt(READER, ['access'], { 'access.open': folds.type })).lines.find(line => line.name === folds.name);
  assert.deepEqual(open?.inner.map(each => [each.name, each.line, each.do]), folds.accounts.map(each => [each.name, each.line ?? '',
    { edit: { account: each.account, on: each.state !== 'on' } }]));

  const hides = hidesOf(READER.view, READER.name);
  const types = READER.view.hide?.types ?? [];
  assert.deepEqual(hides?.rows.map(row => [row.name, row.check]), types.map(each => [each.name, each.state === 'shown' ? 'off' : 'on']));
  const email = hides?.rows.find(row => row.name === 'Email addresses');
  assert.deepEqual(email?.do, { edit: { detail: 'email', hidden: false } });
  assert.equal(hides?.heading, `Hidden from ${READER.name}`);

  const first = file('history').answer;
  const earlier = file('history-earlier').answer;
  const days = agentAt(READER, ['history']).parts.filter(part => part.card && part.label);
  assert.deepEqual(days.map(part => part.label), [...new Set(first.sessions.map((/** @type {any} */ each) => each.day.words))], 'a section a day');
  assert.equal(rowsOf(days).length, first.sessions.reduce((/** @type {number} */ sum, /** @type {any} */ each) => sum + each.lines.length, 0));
  assert.equal(rowsOf(agentAt(READER, ['history']).parts).at(-1)?.label, first.next.words, 'Show earlier last');
  const joined = historyWith(first, earlier);
  const cut = first.sessions.at(-1).key;
  assert.equal(joined.sessions.filter(each => each.key === cut).length, 1);
  const opened = first.sessions.at(-1).lines.at(-1);
  const goesOn = earlier.sessions[0].lines[0];
  assert.ok(opened.kind === 'fold' && goesOn.kind === 'fold' && goesOn.continues, 'the file holds a session folded across two pages');
  const session = joined.sessions.find(each => each.key === cut);
  assert.equal(session?.lines.length, first.sessions.at(-1).lines.length + earlier.sessions[0].lines.length - 1, 'one fold for the session, never a second');
  assert.deepEqual(session?.lines.at(first.sessions.at(-1).lines.length - 1), { ...goesOn, at_ms: opened.at_ms, lines: [...opened.lines, ...goesOn.lines] },
    'the later page’s words, the whole run’s lines');
  assert.equal(joined.sessions.length, first.sessions.length + earlier.sessions.length - 1);
  assert.equal(joined.next, earlier.next);
  assert.equal(joined.figure, first.figure, 'the figure the first page brought');

  const mixed = /** @type {AgentRead} */ (file('reader-overlapping').answer);
  const limited = mixed.view.categories.find(each => each.type === 'mail');
  const mail = controlIn(agentAt(mixed, ['access'])).lines.find(line => line.name === limited?.name);
  assert.equal(mail?.differs && 'fold' in mail.differs ? mail.differs.fold.words : mail?.differs?.menu.words ?? null, limited?.differs ?? null,
    'what differs, in the home’s words');

  const signIn = /** @type {AccessDraft} */ (file('edit-sign-in').answer);
  const request = controlFoot(signIn.view, shown(signIn.view), 'signin', false);
  assert.deepEqual(request.end.map(act => [act.label, act.do]), [['Done', { editor: 'done' }]]);
  const held = controlFoot(signIn.view, { ...shown(signIn.view), held: true, undoes: true }, 'reader', false);
  assert.deepEqual([held.said, held.mark], [[{ text: signIn.view.screen }], 'waiting']);
  assert.deepEqual(held.end.map(act => act.do), [{ editor: 'cancel' }, { editor: 'save' }]);
  const away = controlFoot(signIn.view, { ...shown(signIn.view), held: true }, 'reader', false);
  assert.deepEqual([away.said, away.end.map(act => act.do)], [[{ text: signIn.view.screen }, { text: ' ' }, { text: AGENT_PAGE.browser }],
    [{ editor: 'cancel' }]], 'a browser: no Allow the home refuses');
  assert.deepEqual(controlFoot(READER.view, shown(READER.view), 'reader', false).end, [], 'a narrowing waits for nothing');
  const widening = /** @type {AccessDraft} */ (file('edit-widening').answer);
  const asks = controlFoot(widening.view, { ...shown(widening.view), held: true, undoes: true }, 'reader', false);
  assert.deepEqual(asks.said, widening.view.widening, 'a widening says what it adds');
  assert.deepEqual(asks.end.map(act => [act.do, act.keys]), [[{ editor: 'cancel' }, undefined], [{ editor: 'save' }, '↵']]);
  const narrowing = /** @type {AccessDraft} */ (file('edit-narrowed').answer);
  const undoes = controlFoot(narrowing.view, { ...shown(narrowing.view), narrowed: narrowing.narrowed, undoes: true }, 'reader', false);
  assert.deepEqual([undoes.said, undoes.mark], [narrowing.narrowed?.words, 'done']);
  assert.deepEqual(undoes.end.map(act => [act.label, act.keys, act.do]), [['Undo', '⌘Z', { editor: 'undo' }]]);
  const browser = controlFoot(narrowing.view, { ...shown(narrowing.view), narrowed: narrowing.narrowed, undoes: false }, 'reader', false);
  assert.deepEqual([browser.said, browser.end], [narrowing.narrowed?.words, []], 'no Undo where the host can’t save it');
});

test('X6: Chat’s page has no Hides, its view’s hide null; the rest of its Access the home’s', () => {
  const chat = /** @type {AgentRead} */ (file('reader-chat').answer);
  assert.equal(chat.view.hide, null, 'the contract’s Chat has no hiding');
  const draft = { access: chat.access, expect: chat.version, view: chat.view };
  assert.equal(draftOf(draft), draft, 'Chat’s draft kept as the home wrote it');
  const page = agentAt(chat);
  const labels = rowsOf(page.parts).map(row => row.label);
  assert.ok(labels.includes('Reads') && labels.includes('How far back'), labels.join(', '));
  assert.equal(labels.includes('Hides'), false, 'no Hides row');
  assert.equal(labels.includes(chat.how), false, 'no Connection');
  assert.equal(page.parts.some(part => part.button), false, 'no Disconnect');
  assert.equal(rowsOf(agentAt(chat, ['access']).parts).some(row => row.label === 'Hides'), false);
  assert.deepEqual(agentAt(chat, ['hides']).parts, [], 'no Hides page');
});

test('X6: a row’s time and an agent’s line are the home’s reads, in its words', () => {
  const readers = file('list').answer.readers;
  const read = readers.find((/** @type {any} */ each) => each.reads.last);
  assert.ok(read, 'a fixture agent that read');
  const rows = agentsList({ readers, state: null }).sections.flatMap(section => section.rows);
  assert.equal(rows.find(row => row.name === read.name)?.when, read.reads.last);
  assert.equal(rows.find(row => row.name === readers.find((/** @type {any} */ each) => !each.reads.last).name)?.when, '');
  assert.equal(agentAt({ ...READER, reads: read.reads }).line, read.reads.line);
});

test('X10: How far back’s menu is the view’s `times`, in its order and words: a span a tap, Since… its date’s page', () => {
  const { times } = READER.view;
  assert.deepEqual(times.map(each => each.choice), ['all', 'past', 'past', 'past', 'past', 'past', 'since'], 'the home’s times, Since… last');
  /**
   * @param {typeof times[number]} time
   * @param {string} scope
   * @param {(window: any) => any} set
   */
  const does = (time, scope, set) => time.choice === 'since' ? { page: `since:${scope}` } : { edit: set(time.window) };
  const farRow = rowsOf(agentAt(READER).parts).find(row => row.label === 'How far back');
  const overall = /** @type {import('../public/ui/connectors/dialog.js').Menu} */ (farRow?.menu);
  assert.equal(overall.words, READER.view.window.words);
  assert.deepEqual(overall.choices.map(each => [each.words, each.do]), times.map(each => [each.words, does(each, 'all', window => ({ window }))]));
  assert.ok(overall.choices.every(each => each.note === '' && !each.default), 'no word of the page’s own');
  const mixed = /** @type {AgentRead} */ (file('reader-overlapping').answer);
  const category = { ...mixed.view.categories.find(each => each.limit && each.state !== 'off' && each.accounts.length < 2)
    ?? READER.view.categories[0], differs: 'Past 7 days' };
  const mixedView = { ...mixed.view, categories: mixed.view.categories.map(each => each.type === category.type ? category : each) };
  const line = controlOf(mixedView, OPENED).lines.find(each => each.name === category.name)?.differs;
  const typed = line && 'menu' in line ? line.menu : null;
  assert.deepEqual(typed?.choices.map(each => each.do), times.map(each => does(each, `type:${category.type}`,
    window => ({ type: category.type, window }))));
  const since = /** @type {AccessDraft} */ (file('edit-window').answer);
  const sinceView = { ...since.view, window: { value: { window: { since_ms: 1_000 } }, words: 'Since 1 Nov 2026' } };
  const dated = rowsOf(agentDetail(`agent:${READER.id}`, { ...NO_AGENT_READS, one: READER, editor: shown(sinceView) },
    { state: null, opened: OPENED, home: true, now: AT.now, when: AT.when }).parts).find(row => row.label === 'How far back')?.menu;
  assert.deepEqual(dated?.choices.filter(each => each.chosen).map(each => each.do), [{ page: 'since:all' }]);
  const page = agentAt(READER, ['access', 'since:all']);
  assert.equal(/** @type {any} */ (rowsOf(page.parts)[0])?.end.field.kind, 'date');
  assert.deepEqual(page.back, { label: 'Reads', above: true });
  assert.deepEqual(sinceEdit('type:mail', '2026-11-01', () => 1_000), { type: 'mail', window: { since_ms: 1_000 } });
  assert.equal(sinceEdit('all', '30 days', () => 1_000), null);
});

test('X6: a reader with no access is the empty access at version 0, the editor starting from it', () => {
  const none = /** @type {AgentRead} */ (file('reader-no-access').answer);
  assert.equal(none.version, 0);
  assert.notEqual(none.access, null);
  const { editor, sent } = settingsOver();
  editor.open(none);
  assert.equal(editor.draft?.access, none.access, 'the home’s access, the same object');
  assert.equal(editor.draft?.expect, 0);
  assert.deepEqual(sent.read, []);
});

test('X7: the card over the window draws an ask from the ask page’s own parts, as the home wrote it, the page’s order, Review', () => {
  const marked = { ...ASKS[1], head: 'Asks for <b>all</b>', reason: '<img src=x onerror=alert(1)>' };
  const card = askCard(marked, { count: '1 of 2 asks', busy: null, offer: true, said: '', erased: false });
  assert.doesNotMatch(card, /<b>all|<img/u);
  assert.match(card, /Asks for &lt;b&gt;all&lt;\/b&gt;/u);
  assert.ok(card.includes(askBody(askPart(marked))), 'today, what it says and the screen: the parts the ask page draws');
  const page = draftDetail(`ask:${marked.id}`, { ...NO_AGENT_READS, asked: marked, editor: shown(READER.view) },
    { state: null, opened: { ...OPENED, pages: [] }, home: true, now: 0, when: whenWords('2026-11-14') });
  assert.deepEqual(page.parts.find(part => part.ask)?.ask, askPart(marked), 'the page draws the same part');
  assert.deepEqual(cardPicks(card), answerOrder(marked, false), 'the page’s order: No, then the rest, the default last');
  assert.deepEqual([...card.matchAll(/data-access-key="([^"]+)"/gu)].map(each => each[1]), answerOrder(marked, false).map(each => answerKeys(marked, each)));
  assert.match(card, new RegExp(`data-agent-pick="[^"]*${marked.default}[^"]*"[^>]*data-access-default`, 'u'));
  assert.match(card, /data-agent-change="ask:[^"]+"[^>]*>.*Review/su, 'Review opens the whole ask');
  assert.match(card, />1 of 2 asks</u);
  assert.doesNotMatch(askCard(marked, { count: '', busy: null, offer: false, said: NOT_SURE, erased: false }), /data-agent-pick/u,
    'a tap whose reply never came: no button until it is read');
  for (const ask of EVERY_ASK.filter(each => each.by === 'agent')) {
    const drawn = askCard(ask, { count: '', busy: null, offer: true, said: '', erased: false });
    for (const words of [ask.head, phraseWords(ask.asked_line), ask.reason, ask.screen, ...ask.today.map(run => run.text), ...ask.choices.map(each => each.words)]) {
      if (words) assert.ok(drawn.includes(esc(words)), `${ask.id}: ${words}`);
    }
  }
  const snapshot = /** @type {AgentAsk} */ (file('propose-asked').answer.snapshot);
  const open = accessChatCard({ snapshot, now: { ...snapshot, state: 'open' }, attrs: answer => ({ 'data-pick': answer }) });
  assert.deepEqual([...open.matchAll(/data-pick="([^"]+)"/gu)].map(each => each[1]), snapshot.choices.map(each => each.answer));
  const declined = /** @type {AgentAsk} */ (file('ask-declined').answer);
  const ended = accessChatCard({ snapshot, now: declined, attrs: answer => ({ 'data-pick': answer }) });
  assert.doesNotMatch(ended, /data-pick/u);
  assert.ok(ended.includes(esc(phraseWords(declined.outcome))));
  assert.doesNotMatch(accessChatCard({ snapshot, now: null, attrs: answer => ({ 'data-pick': answer }) }), /data-pick/u, 'unread, no button');
  const refused = file('answer-person-only').answer.message;
  assert.ok(accessChatCard({ snapshot, now: snapshot, said: refused, attrs: answer => ({ 'data-pick': answer }) }).includes(esc(refused)), 'a refusal said in the home’s words, its buttons kept');
  const savedWords = /** @type {{ text: string, bold?: true }[]} */ (file('propose-narrowed').answer.words);
  const savedLine = accessNarrowed({ words: savedWords, undo: null });
  assert.ok(savedWords.every(run => savedLine.includes(run.bold ? `<b>${esc(run.text)}</b>` : esc(run.text))), 'its words, the bold parts bold');
});

/** @param {(act: any) => Promise<any>} reply */
const fakeHost = reply => {
  /** @type {any[]} */
  const acts = [];
  return { acts, host: /** @type {any} */ ({ state: { agent_asks: [] }, follow: () => () => {}, act: (/** @type {any} */ act) => {
    acts.push(act);
    return reply(act);
  } }) };
};
/** @param {unknown} pressed */
const control = pressed => /** @type {HTMLElement} */ (/** @type {unknown} */ ({ dataset: { askAccess: JSON.stringify(pressed) } }));

test('X8: Chat’s Undo sends the change’s stored access and version, once; refused after the access moved, said and not undone', async () => {
  const narrowed = file('propose-narrowed').answer;
  const turn = { ...asking('q', 1_000), access: [narrowed] };
  const slow = held();
  const { host, acts } = fakeHost(() => slow.promise);
  let draws = 0;
  const chat = chatAccess({ host, redraw: () => { draws += 1; }, read: async () => { throw new Error('no ask'); } });
  chat.press(control({ undo: narrowed.id }), [turn]);
  chat.press(control({ undo: narrowed.id }), [turn]);
  assert.deepEqual(acts, [{ act: 'agent-access', id: narrowed.reader, access: narrowed.undo.access, expect: narrowed.undo.expect }]);
  slow.reject(Object.assign(new Error('This access changed since it was drawn.'), { home: false }));
  await until('the refused Undo’s reply', () => draws >= 2);
  const line = chat.markup(turn);
  assert.match(line, /This access changed since it was drawn\./u);
  assert.match(line, /data-ask-access/u, 'Undo still offered');
});

test('X8: Chat’s turn that changed access, as the Ask server streams and keeps it: each change whole, drawn as its line and its card', async () => {
  /** @param {string} name */
  const asked = name => JSON.parse(readFileSync(join(FIXTURES, 'agents', 'ask', `${name}.json`), 'utf8'));
  /** @type {{ type: 'access', change: import('../public/types.js').AccessChange }[]} */
  const events = asked('events');
  const kept = asked('kept');
  const changes = events.map(event => event.change);
  assert.deepEqual(events.map(event => event.type), changes.map(() => 'access'));
  assert.deepEqual(changes.map(change => change.kind), ['narrowed', 'asked']);
  for (const change of changes) {
    assert.equal(accessChangeOf(change), change, change.id);
    for (const key of Object.keys(change)) assert.equal(accessChangeOf(without(change, key)), null, `${change.id} without ${key}`);
  }

  const streamed = events.reduce(withEvent, asking('allow Synthetic Agent only the past day', 1_000));
  assert.deepEqual(streamed.access, changes, 'each change as it streamed, in order');
  assert.deepEqual(withEvent(streamed, { type: 'done', message: kept }).access, changes, 'the kept answer states the same, none twice');
  const [read] = turnsOf({ chat: kept.chat, title: '', messages: [{ chat: kept.chat, n: 1, at_ms: 1_000, role: 'user', text: 'q' }, kept] });
  assert.deepEqual(read.access, changes, 'read back from its conversation');

  const [narrowed, proposal] = changes;
  if (narrowed.kind !== 'narrowed' || proposal.kind !== 'asked') throw new Error('a narrowing, then Chat’s proposal');
  const { host } = fakeHost(async () => ({}));
  const chat = chatAccess({ host, redraw: () => {}, read: async () => proposal.snapshot });
  chat.markup(read);
  await until('the proposal read by its id', () => chat.markup(read).includes('ck-access-chat__answers'));
  const drawn = chat.markup(read);
  const narrowedAt = drawn.indexOf(narrowed.words.map(run => run.bold ? `<b>${esc(run.text)}</b>` : esc(run.text)).join(''));
  assert.ok(narrowedAt >= 0 && narrowedAt < drawn.indexOf(esc(proposal.snapshot.head)), 'the narrowing’s line, then Chat’s card');
  assert.match(drawn, /ck-access-line__undo/u, 'the narrowing offers Undo');
  for (const add of proposal.snapshot.adds) assert.ok(drawn.includes(esc(add)), add);
  assert.deepEqual([...drawn.matchAll(/data-ask-access="([^"]+)"/gu)].map(found => JSON.parse(found[1].replace(/&quot;/gu, '"'))).filter(each => each.ask),
    proposal.snapshot.choices.map(each => ({ ask: proposal.id, answer: each.answer })), 'Chat’s card answers with its own choices');
});

test('X8: Chat’s change that changed nothing is its words alone, no Undo', () => {
  const unchanged = file('propose-unchanged').answer;
  assert.equal(unchanged.kind, 'unchanged');
  const turn = { ...asking('q', 1_000), access: [unchanged] };
  const { host } = fakeHost(() => Promise.resolve({}));
  const chat = chatAccess({ host, redraw: () => {}, read: async () => { throw new Error('no ask'); } });
  const line = chat.markup(turn);
  assert.ok(line.includes(esc(unchanged.words)), line);
  assert.doesNotMatch(line, /data-ask-access/u, 'no Undo');
});

test('X8: Chat’s card answers once, with the ask’s version; a lost reply says so and reads the ask before a button', async () => {
  const asked = file('propose-asked').answer;
  const open = /** @type {AgentAsk} */ ({ ...asked.snapshot, state: 'open' });
  const turn = { ...asking('q', 1_000), access: [asked] };
  /** @type {AgentAsk[]} */
  const reads = [open, /** @type {AgentAsk} */ (file('ask-declined').answer)];
  const slow = held();
  const { host, acts } = fakeHost(() => slow.promise);
  let draws = 0;
  const chat = chatAccess({ host, redraw: () => { draws += 1; }, read: async () => /** @type {AgentAsk} */ (reads.shift()) });
  chat.markup(turn);
  await until('the ask read by its id', () => /data-ask-access/u.test(chat.markup(turn)));
  const allow = open.choices.find(each => each.answer !== 'no')?.answer;
  chat.press(control({ ask: asked.id, answer: allow }), [turn]);
  chat.press(control({ ask: asked.id, answer: 'no' }), [turn]);
  assert.deepEqual(acts, [{ act: 'agent-answer', id: open.id, answer: allow, expect: open.version }], 'one answer from one card');
  slow.reject(Object.assign(new Error(NOT_SURE), { home: true, code: 'OUTCOME_UNKNOWN' }));
  await until('the ask read again after the lost reply', () => chat.markup(turn).includes(esc(phraseWords(file('ask-declined').answer.outcome))));
  const drawn = chat.markup(turn);
  assert.ok(drawn.includes(NOT_SURE));
  assert.doesNotMatch(drawn, /data-ask-access/u);
  assert.ok(draws > 0);
});

/**
 * @param {unknown} state
 * @param {(message: any) => unknown} reply
 */
const answeringWindow = (state, reply) => {
  /** @type {unknown[]} */
  const posted = [];
  return { posted, win: { lifestreamHost: { kind: 'mac', version: 6, state }, addEventListener: () => {}, removeEventListener: () => {},
    webkit: { messageHandlers: { lifestream: { postMessage: (/** @type {any} */ message) => {
      posted.push(message);
      return reply(message);
    } } } } } };
};
/** @param {HostFile} each */
const actOf = each => Object.fromEntries(Object.entries(each.act).filter(([key]) => key !== 'type'));
/** @param {string} id */
const askFor = id => ({ ...ASKS.find(each => each.by === 'agent') ?? ASKS[0], id });

test('X9: every file of the Mac host’s through host.js: its lists whole, each act posted as the file’s, its reply as sent', async () => {
  const names = Object.keys(HOST_FILES).sort();
  assert.ok(names.length >= 20, 'every host file');
  for (const name of names) {
    const each = HOST_FILES[name];
    if (each.state) {
      const host = readHost(/** @type {any} */ (hostWindow(each.state)));
      assert.ok(Array.isArray(each.state.agent_requests) && Array.isArray(each.state.agent_asks), `${name}: both lists present`);
      assert.equal(host?.state.agent_requests.length, each.state.agent_requests.length, name);
      assert.equal(host?.state.agent_asks.length, each.state.agent_asks.length, name);
      for (const [at, request] of (host?.state.agent_requests ?? []).entries()) {
        assert.equal(request, each.state.agent_requests[at], name);
        const card = signInCard(request, { view: request.view, count: '', busy: null, refused: '' });
        assert.ok([request.head, phraseWords(request.over_line), request.pick, request.pick_line].every(words => card.includes(esc(words)))
          && request.choices.every(number => card.includes(`>${number}<`)), `${name}: its card`);
      }
      for (const [at, ask] of (host?.state.agent_asks ?? []).entries()) {
        assert.equal(ask, each.state.agent_asks[at], name);
        assert.ok(askCard(ask, { count: '', busy: null, offer: true, said: '', erased: false }).includes(esc(ask.head)), `${name}: its card`);
      }
      continue;
    }
    const { win, posted } = answeringWindow({}, () => each.reply);
    const host = readHost(/** @type {any} */ (win));
    const settled = await /** @type {NonNullable<typeof host>} */ (host).act(/** @type {any} */ (actOf(each)))
      .then(reply => ({ reply }), refusal => ({ refusal }));
    assert.deepEqual(posted, [each.act], `${name}: the act posted`);
    if (each.reply.answer) {
      assert.ok('reply' in settled, `${name}: answered`);
      assert.deepEqual(settled.reply, { answer: each.reply.answer }, `${name}: the door's answer whole`);
      assert.equal(settled.reply.answer, each.reply.answer, `${name}: the same object`);
    } else {
      assert.ok('refusal' in settled, `${name}: refused`);
      const refusal = /** @type {{ code: string, message: string }} */ (settled.refusal);
      assert.deepEqual({ code: refusal.code, message: refusal.message }, each.reply.refused, `${name}: the door's code and words`);
    }
    if (each.act.act === 'agent-answer') {
      const word = answerWord(each.reply);
      if (each.reply.answer) assert.equal(word.words, phraseWords(each.reply.answer.outcome), name);
      else assert.equal(word.words, each.reply.refused.message, name);
      if (word.words && each.reply.answer) assert.ok(noticeCard(word.words).includes(esc(word.words)), `${name}: its notice`);
      if (!each.reply.answer && !each.act.id.startsWith('rq-')) {
        const card = signInCard({ ...SIGN_IN, id: each.act.id }, { view: SIGN_IN.view, count: '', busy: null, refused: word.words });
        assert.ok(card.includes(esc(word.words)), `${name}: the door's words on the sign-in's card`);
      } else if (!each.reply.answer) {
        const ask = askFor(each.act.id);
        const card = askCard(ask, { count: '', busy: null, offer: true, said: word.words, erased: word.erased });
        assert.ok(card.includes(esc(word.words)), `${name}: the door's words on its card`);
        assert.deepEqual(cardPicks(card), word.erased ? ['no'] : answerOrder(ask, false), `${name}: what it offers`);
      }
      continue;
    }
    const { editor, sent } = settingsOverHost(each);
    await editor.tap({ type: 'health', on: true });
    await editor.save();
    if (each.reply.answer) {
      assert.equal(editor.draft, each.reply.answer, `${name}: the next tap starts from the save's draft`);
      assert.deepEqual(sent.read, [], `${name}: no reader read again`);
    } else {
      assert.equal(editor.note, each.reply.refused.message, `${name}: the door's words`);
      assert.deepEqual(sent.read, [READER.id], `${name}: the reader read again before another save`);
    }
  }
  for (const odd of [{}, { answer: { state: 'allowed' } }, { notice: 'Done.' }, { refused: 'No.' }]) {
    const { win } = answeringWindow({}, () => odd);
    await assert.rejects(/** @type {any} */ (readHost(/** @type {any} */ (win))).act({ act: 'agent-answer', id: 'rq-1', answer: 'no' }),
      { code: 'OUTCOME_UNKNOWN', message: NOT_SURE }, JSON.stringify(odd));
  }
  for (const name of Object.keys(FILES).filter(each => each.startsWith('answer-') && FILES[each].status === 200)) {
    assert.equal(answerReplyOf(FILES[name].answer), FILES[name].answer, name);
    for (const key of Object.keys(FILES[name].answer)) assert.equal(answerReplyOf(without(FILES[name].answer, key)), null, `${name} without ${key}`);
  }
  for (const name of Object.keys(FILES).filter(each => (each.startsWith('edit-') || each.startsWith('access-')) && FILES[each].status === 200)) {
    assert.equal(draftOf(FILES[name].answer), FILES[name].answer, name);
  }
});

/** @param {HostFile} each */
function settingsOverHost(each) {
  /** @type {{ read: string[] }} */
  const sent = { read: [] };
  const { win } = answeringWindow({}, () => each.reply);
  const host = /** @type {NonNullable<ReturnType<typeof readHost>>} */ (readHost(/** @type {any} */ (win)));
  const editor = settingsEditor({ reader: READER.id, changed: () => {}, io: {
    edit: async () => /** @type {AccessDraft} */ ({ ...file('edit-type-on').answer, expect: READER.version }),
    save: async () => { throw new Error('a widening goes through the host'); },
    widen: (id, saved) => host.act({ act: 'agent-access', id, ...saved }).then(reply => /** @type {AccessDraft} */ (reply.answer),
      error => { throw Object.assign(new Error(error.message), { said: error.message, code: error.code }); }),
    read: async id => {
      sent.read.push(id);
      return READER;
    },
  } });
  editor.open(READER);
  return { editor, sent };
}

test('X11: an ask erased since offers No alone, its default, and no Change, on every card; an approval refused as erased the same', () => {
  const erased = /** @type {AgentAsk} */ (file('ask-erased').answer);
  assert.deepEqual(erased.choices.map(each => each.answer), ['no']);
  assert.equal(erased.default, 'no');
  assert.equal(askOf(erased), erased, 'kept, its default one of its choices');
  assert.equal(askOf({ ...erased, default: 'once' }), null, 'a default that is not one of its choices');
  assert.equal(askChanges(erased), false);
  const picks = (/** @type {string} */ markup) => [...markup.matchAll(/data-pick="([^"]+)"/gu)].map(found => found[1]);
  const card = askCard(erased, { count: '', busy: null, offer: true, said: '', erased: false });
  assert.deepEqual(cardPicks(card), ['no']);
  assert.match(card, /data-access-default/u, 'No, its default, filled');
  assert.deepEqual(picks(accessChatCard({ snapshot: erased, now: erased, attrs: answer => ({ 'data-pick': answer }) })), ['no']);
  const refused = HOST_FILES['answer-erased'].reply;
  const word = answerWord(refused);
  assert.deepEqual(word, { words: refused.refused.message, taken: false, erased: true });
  const open = askFor(HOST_FILES['answer-erased'].act.id);
  assert.deepEqual(askChoices(open, true).map(each => each.answer), ['no']);
  const after = askCard(open, { count: '', busy: null, offer: true, said: word.words, erased: word.erased });
  assert.ok(after.includes(esc(word.words)));
  assert.deepEqual(cardPicks(after), ['no']);
  const chat = accessChatCard({ snapshot: open, now: open, erased: true, said: word.words, attrs: answer => ({ 'data-pick': answer }) });
  assert.deepEqual(picks(chat), ['no']);
  const draft = /** @type {AccessDraft} */ (file('edit-ask').answer);
  /** @param {AgentAsk} ask @param {boolean} erasedNow */
  const allowOf = (ask, erasedNow) => draftDetail(`ask:${ask.id}`, { ...NO_AGENT_READS, asked: ask, erased: erasedNow,
    editor: shown(draft.view) }, { state: null, opened: { ...OPENED, pages: ['access'] }, home: true, now: AT.now, when: AT.when }).foot?.end ?? [];
  assert.deepEqual(allowOf(open, false).map(act => act.do), [{ editor: 'allow' }]);
  const page = draftDetail(`ask:${erased.id}`, { ...NO_AGENT_READS, asked: erased, erased: true, editor: shown(draft.view) },
    { state: null, opened: OPENED, home: true, now: AT.now, when: AT.when });
  assert.deepEqual(page.foot?.end.map(act => 'answer' in act.do ? act.do.answer.answer : null), ['no'], 'No alone on an erased ask');
  assert.ok(rowsOf(page.parts).every(row => !row.end), 'no Edit on an erased ask');
});

test('X11: a sign-in’s answer says the home’s outcome as a request’s does, and no words of the page’s own; one answered again its recorded outcome; a refusal its door’s words', () => {
  for (const name of ['answer-sign-in', 'answer-sign-in-wrong', 'answer-sign-in-deny', 'answer-sign-in-ended', 'answer-once', 'answer-no']) {
    const { status, answer } = file(name);
    assert.equal(status, 200, name);
    assert.ok(Array.isArray(answer.outcome) && answer.outcome.length > 0
      && answer.outcome.every((/** @type {import('../public/pages.js').PhrasePart} */ part) => (part.kind === 'words' ? typeof part.words === 'string' : part.kind === 'time')), `${name}: the home’s words`);
    const word = answerWord({ answer });
    assert.deepEqual(word, { words: phraseWords(answer.outcome), taken: true, erased: false }, name);
    assert.ok(noticeCard(word.words).includes(esc(phraseWords(answer.outcome))), name);
  }
  const refused = file('answer-person-only');
  assert.equal(refused.status, 403);
  assert.equal(answerWord({ refused: refused.answer }).words, refused.answer.message);
  assert.ok(signInCard(SIGN_IN, { view: SIGN_IN.view, count: '', busy: null, refused: refused.answer.message }).includes(esc(refused.answer.message)));
});

test('X8: Chat’s card says a refusal in the door’s words; refused as erased, No alone and its ask not read again', async () => {
  const asked = file('propose-asked').answer;
  const open = /** @type {AgentAsk} */ ({ ...asked.snapshot, state: 'open' });
  const turn = { ...asking('q', 1_000), access: [asked] };
  const refused = HOST_FILES['answer-erased'].reply.refused;
  const { win, posted } = answeringWindow({ agent_asks: [] }, () => HOST_FILES['answer-erased'].reply);
  let reads = 0;
  const chat = chatAccess({ host: readHost(/** @type {any} */ (win)), redraw: () => {}, read: async () => {
    reads += 1;
    return open;
  } });
  chat.markup(turn);
  await until('the ask read by its id', () => /data-ask-access/u.test(chat.markup(turn)));
  const allow = open.choices.find(each => each.answer !== 'no')?.answer;
  chat.press(control({ ask: asked.id, answer: allow }), [turn]);
  await until('the refusal said', () => chat.markup(turn).includes(esc(refused.message)));
  assert.equal(posted.length, 1);
  const drawn = chat.markup(turn);
  assert.deepEqual([...drawn.matchAll(/data-ask-access="([^"]+)"/gu)].map(found => JSON.parse(found[1].replace(/&quot;/gu, '"')).answer), ['no']);
  assert.equal(reads, 1, 'not read again: No still ends it');
});

test('X12: the screen’s line and a held widening’s Cancel and Allow stay at Access’s foot; the pages inside it ask nothing', () => {
  const view = { ...READER.view, screen: String(file('edit-sign-in').answer.view.screen) };
  const reads = { ...NO_AGENT_READS, one: READER, editor: { ...shown(view), held: true, undoes: true } };
  /** @param {string[]} pages */
  const at = pages => agentDetail(`agent:${READER.id}`, reads, { state: null, opened: { ...OPENED, pages }, home: true, now: AT.now,
    when: AT.when });
  const access = at(['access']);
  assert.equal(access.foot?.said?.map(run => run.text).join(''), view.screen);
  assert.deepEqual(access.foot?.end.map(act => [act.label, act.do]), [['Cancel', { editor: 'cancel' }], ['Allow', { editor: 'save' }]]);
  for (const inside of [['hides'], ['access', 'since:all']]) assert.equal(at(inside).foot, null, inside.join('/'));
  const quiet = agentDetail(`agent:${READER.id}`, { ...reads, editor: shown(READER.view) }, { state: null,
    opened: { ...OPENED, pages: ['access'] }, home: true, now: AT.now, when: AT.when });
  assert.notEqual(quiet.foot?.said?.map(run => run.text).join('') ?? '', view.screen, 'none without it');
});

test('X12: an account opens inline, its own window beside it only while it differs from its kind’s', () => {
  const kind = READER.view.categories.find(each => each.accounts.length > 1 && each.state !== 'off' && each.differs);
  assert.ok(kind, 'a fixture kind of accounts');
  const line = controlIn(agentAt(READER, ['access'], { 'access.open': kind.type })).lines.find(each => each.name === kind.name);
  for (const [at, account] of kind.accounts.entries()) {
    const inner = line?.inner[at];
    const differs = account.state !== 'off' && account.limit?.words !== kind.limit?.words;
    assert.equal(inner?.differs && 'menu' in inner.differs ? inner.differs.menu.words : null, differs ? account.limit?.words : null,
      account.account);
  }
});

test('X13: Chat’s card says its snapshot’s screen line', () => {
  const snapshot = /** @type {AgentAsk} */ ({ ...file('propose-asked').answer.snapshot, screen: String(file('edit-sign-in').answer.view.screen) });
  for (const now of [null, { ...snapshot, state: /** @type {const} */ ('open') }]) {
    assert.ok(accessChatCard({ snapshot, now, attrs: () => ({}) }).includes(esc(snapshot.screen ?? '')));
  }
});

/** @param {(act: any) => Promise<any>} reply */
const pollingHost = reply => {
  /** @type {any[]} */
  const acts = [];
  /** @type {(state: any) => void} */
  let listener = () => {};
  return { acts, poll: (/** @type {any[]} */ asks) => listener({ agent_asks: asks }), host: /** @type {any} */ ({ state: { agent_asks: [] },
    follow: (/** @type {(state: any) => void} */ heard) => { listener = heard; return () => {}; },
    act: (/** @type {any} */ act) => { acts.push(act); return reply(act); } }) };
};
/** @param {string} drawn */
const offered = drawn => [...drawn.matchAll(/data-ask-access="([^"]+)"/gu)].map(found => JSON.parse(found[1].replace(/&quot;/gu, '"')).answer);

test('X14: Chat’s ask is read once as its card comes, never by drawing; gone, said and never read again', async () => {
  const asked = file('propose-asked').answer;
  const turn = { ...asking('q', 1_000), access: [asked] };
  const { host, poll } = pollingHost(async () => ({}));
  let reads = 0;
  let draws = 0;
  const chat = chatAccess({ host, redraw: () => { draws += 1; }, read: async () => {
    reads += 1;
    throw refusalOf(file('ask-unknown'));
  } });
  chat.markup(turn);
  await until('the read landed', () => draws > 0);
  for (let drawn = 0; drawn < 4; drawn += 1) chat.markup(turn);
  poll([]);
  assert.equal(reads, 1, 'gone is final');
  const drawn = chat.markup(turn);
  assert.ok(drawn.includes(esc(file('ask-unknown').answer.message)), 'said gone, in the home’s words');
  assert.deepEqual(offered(drawn), []);
});

test('X14: a read of Chat’s ask that failed, or a lost reply’s read that failed, is read again at the next poll', async () => {
  const asked = file('propose-asked').answer;
  const open = /** @type {AgentAsk} */ ({ ...asked.snapshot, state: 'open' });
  const turn = { ...asking('q', 1_000), access: [asked] };
  const away = Object.assign(new Error('away'), { status: 503, code: 'NOT_NOW' });
  /** @type {(AgentAsk | Error)[]} */
  const answers = [away, open, away, open];
  const { host, poll } = pollingHost(() => Promise.reject(Object.assign(new Error(NOT_SURE), { code: 'OUTCOME_UNKNOWN' })));
  let reads = 0;
  let draws = 0;
  const chat = chatAccess({ host, redraw: () => { draws += 1; }, read: async () => {
    reads += 1;
    const next = answers.shift();
    if (next instanceof Error || !next) throw next;
    return next;
  } });
  chat.markup(turn);
  await until('the first read failed', () => draws > 0);
  for (let drawn = 0; drawn < 4; drawn += 1) chat.markup(turn);
  assert.equal(reads, 1, 'no read from drawing');
  assert.deepEqual(offered(chat.markup(turn)), []);
  poll([open]);
  await until('read again at the poll, its buttons', () => offered(chat.markup(turn)).length > 0);
  const allow = open.choices.find(each => each.answer !== 'no')?.answer;
  chat.press(control({ ask: asked.id, answer: allow }), [turn]);
  await until('the read after the lost reply', () => reads === 3 && answers.length === 1);
  await until('the failed read drawn', () => offered(chat.markup(turn)).length === 0 && chat.markup(turn).includes(NOT_SURE));
  poll([open]);
  await until('read again at the poll, its buttons again', () => reads === 4 && offered(chat.markup(turn)).length > 0);
});

test('X14: in a browser, a read of Chat’s ask that failed is read again by its own wait while its card is shown, and only then', async () => {
  const asked = file('propose-asked').answer;
  const declined = /** @type {AgentAsk} */ (file('ask-declined').answer);
  const turn = { ...asking('q', 1_000), access: [asked] };
  const away = Object.assign(new Error('away'), { status: 503, code: 'NOT_NOW' });
  /** @type {(AgentAsk | Error)[]} */
  const answers = [away, away, declined];
  /** @type {(() => void)[]} */
  const waits = [];
  /** @type {typeof turn[]} */
  let shown = [turn];
  let reads = 0;
  let draws = 0;
  const chat = chatAccess({ host: null, redraw: () => { draws += 1; }, shown: () => shown,
    later: run => { waits.push(run); }, read: async () => {
      reads += 1;
      const next = answers.shift();
      if (next instanceof Error || !next) throw next;
      return next;
    } });
  chat.markup(turn);
  await until('the first read failed', () => draws > 0);
  for (let drawn = 0; drawn < 4; drawn += 1) chat.markup(turn);
  assert.equal(reads, 1, 'no read from drawing');
  assert.equal(waits.length, 1, 'one wait, however often drawn');
  assert.ok(!chat.markup(turn).includes(esc(phraseWords(declined.outcome))));
  shown = [];
  /** @type {() => void} */ (waits.shift())();
  assert.equal(reads, 1, 'not read while not shown');
  assert.equal(waits.length, 0, 'no wait while no such card is shown');
  shown = [turn];
  chat.markup(turn);
  assert.equal(waits.length, 1);
  /** @type {() => void} */ (waits.shift())();
  await until('read again, failed again, waiting again', () => reads === 2 && waits.length === 1);
  /** @type {() => void} */ (waits.shift())();
  await until('read again: its outcome', () => chat.markup(turn).includes(esc(phraseWords(declined.outcome))));
  assert.equal(reads, 3);
  chat.markup(turn);
  assert.equal(waits.length, 0, 'none waits once read');
});

test('X14: in a browser, a gone ask is never waited on', async () => {
  const asked = file('propose-asked').answer;
  const turn = { ...asking('q', 1_000), access: [asked] };
  /** @type {(() => void)[]} */
  const waits = [];
  let draws = 0;
  const chat = chatAccess({ host: null, redraw: () => { draws += 1; }, shown: () => [turn], later: run => { waits.push(run); },
    read: async () => { throw refusalOf(file('ask-unknown')); } });
  chat.markup(turn);
  await until('the read landed', () => draws > 0);
  assert.ok(chat.markup(turn).includes(esc(file('ask-unknown').answer.message)));
  assert.equal(waits.length, 0);
});

test('X15: History is the home’s rows: its words, line and kept tail, a tile per line, the time at the end; a refused read in the warning tone, a waiting ask in caution with Review; folds open in place', () => {
  const page = /** @type {import('../public/types.js').HistoryPage} */ (file('history').answer);
  const lines = page.sessions.flatMap(session => session.lines);
  const fold = lines.find(line => line.kind === 'fold');
  assert.ok(fold?.kind === 'fold' && lines.some(line => line.kind === 'change'), 'the file holds a fold and a change');
  const history = historyOf(page, READER.id, AT.when);
  const rows = history.days.flatMap(day => day.rows);
  assert.equal(rows.length, lines.length, 'one row per line the home serves, folds folded');
  assert.deepEqual(rows.map(row => [row.label, row.lead && 'icon' in row.lead ? row.lead.icon : null]),
    lines.map(line => [line.words, line.icon]), 'the home’s words and icon');
  assert.deepEqual(rows.map(row => row.tail ?? ''), lines.map(line => line.kind === 'call' ? line.kept ?? '' : ''), 'what was kept, quiet');
  const shut = rows[lines.indexOf(fold)];
  const folding = shut.go?.do;
  assert.ok(folding && 'typed' in folding && folding.typed.key === HISTORY_FOLDS);
  const opened = historyOf(page, READER.id, AT.when, { [HISTORY_FOLDS]: folding.typed.value }).days.flatMap(day => day.rows);
  assert.equal(opened.length, lines.length + fold.lines.length, 'an open fold lists its reads under it');
  assert.deepEqual(history.days.map(day => [day.day, day.reads]),
    [...new Map(page.sessions.map(session => [session.day.words, session.day.reads ?? ''])).entries()], 'a day counts the whole day’s reads');
  assert.deepEqual(history.earlier, { words: page.next?.words, do: { earlier: READER.id } });

  const refused = /** @type {import('../public/types.js').HistoryPage} */ (file('history-refused').answer);
  const stopped = refused.sessions.flatMap(session => session.lines).find(line => line.kind === 'call' && line.tone === 'refused');
  assert.ok(stopped, 'the file holds a refused read');
  const row = historyOf(refused, READER.id, AT.when).days.flatMap(day => day.rows).find(each => each.label === stopped.words);
  assert.equal(row?.tone, 'warning');
  const waiting = /** @type {import('../public/types.js').HistoryPage} */ (file('history-waiting').answer);
  const ask = waiting.sessions.flatMap(session => session.lines).find(line => line.kind === 'change' && line.ask);
  assert.ok(ask?.kind === 'change', 'the file holds a waiting ask');
  const asked = historyOf(waiting, READER.id, AT.when).days.flatMap(day => day.rows).find(each => each.label === ask.words);
  assert.equal(asked?.tone, 'caution');
  assert.deepEqual(asked?.end && 'acts' in asked.end ? asked.end.acts.map(act => [act.label, act.do]) : null,
    [['Review', { open: `ask:${ask.ask}` }]]);
});

test('X16: Disconnect draws the home’s Stops and Stays and sends disconnect; a disconnected agent keeps its history under Disconnected, Remove from the list asked first', () => {
  const asking = /** @type {AgentRead} */ (file('reader-ask').answer);
  const ends = agentAt(asking, ['disconnect']);
  assert.ok(asking.disconnect);
  assert.deepEqual([ends.name, ends.line], [asking.disconnect.head, asking.disconnect.line], 'the home’s title and line');
  assert.deepEqual(ends.parts.map(part => [part.label, rowsOf([part]).map(row => [row.label, row.line,
    row.lead && 'icon' in row.lead ? row.lead.icon : null])]), [
    ['Stops', asking.disconnect.stops.map(each => [each.name, each.line, each.icon])],
    ['Stays', asking.disconnect.stays.map(each => [each.name, each.line, each.icon])]]);
  assert.deepEqual(ends.foot?.end.map(act => [act.label, act.variant, act.tone, act.do]), [['Cancel', 'plain', undefined, { back: true }],
    [asking.disconnect.confirm, 'primary', 'warning', { disconnect: asking.id }]]);
  assert.ok(agentAt(asking).parts.some(part => part.button?.do && 'page' in part.button.do && part.button.do.page === 'disconnect'));

  const gone = /** @type {AgentRead} */ (file('disconnect').answer);
  assert.equal(gone.state, 'disconnected');
  const page = agentDetail(`agent:${gone.id}`, { ...NO_AGENT_READS, one: gone, history: file('history').answer },
    { state: null, opened: { ...OPENED, pages: [], fields: {} }, home: true, now: AT.now, when: AT.when });
  assert.equal(page.line, gone.disconnected);
  assert.equal(page.parts.some(part => part.label === 'Access') || page.callout !== null, false, 'no Access, no ask');
  assert.ok(page.parts.some(part => part.label === 'Connection'), 'its Connection, as on the iPhone');
  assert.ok(page.parts.some(part => part.label === 'History'), 'its history');
  const remove = page.parts.find(part => part.button);
  assert.deepEqual([remove?.button?.label, remove?.button?.do], ['Remove from the list…', { ask: `unlist:${gone.id}` }]);
  assert.deepEqual(remove?.confirm?.yes.do, { unlist: gone.id });
  assert.ok(gone.unlist);
  assert.deepEqual([remove?.confirm?.question, remove?.confirm?.detail], [gone.unlist.ask, gone.unlist.line], 'the home’s words');
  assert.equal(agentDetail(`agent:${gone.id}`, { ...NO_AGENT_READS, one: gone, history: file('history').answer },
    { state: null, opened: { ...OPENED, pages: [], fields: {} }, home: false, now: AT.now, when: AT.when }).parts.some(part => part.button),
  false, 'a browser: no Remove');
  assert.equal(agentDetail(`agent:${gone.id}`, { ...NO_AGENT_READS, one: gone, history: file('history').answer },
    { state: null, opened: { ...OPENED, pages: ['disconnect'], fields: {} }, home: true, now: AT.now, when: AT.when }).foot, null,
  'no Disconnect twice');

  const list = file('list-disconnected').answer;
  const drawn = agentsList({ readers: list.readers, state: null });
  const off = list.readers.filter((/** @type {any} */ each) => each.state === 'disconnected');
  assert.ok(off.length > 0);
  assert.equal(drawn.sections.at(-1)?.name, 'Disconnected', 'Disconnected last');
  assert.deepEqual(drawn.sections.find(section => section.name === 'Disconnected'), { name: 'Disconnected', count: off.length,
    rows: off.map((/** @type {any} */ each) => ({ id: each.id, name: each.name, icon: 'ai-apps', line: each.summary, place: each.place, when: '',
      review: '', dim: true, opens: `agent:${each.id}` })) });
  assert.equal(drawn.sections.filter(section => section.name !== 'Disconnected').flatMap(section => section.rows)
    .some(row => off.some((/** @type {any} */ each) => each.id === row.id)), false, 'only under Disconnected');
});

test('X17: a sign-in’s rows are the home’s view: its own before any draft, the draft’s once kept; its lines are the home’s', () => {
  const view = /** @type {AccessDraft} */ (file('edit-sign-in-browser').answer).view;
  const rows = accessRows(view);
  assert.deepEqual(rows.map(row => [row.name, row.value]), [['Reads', view.reads],
    ['How far back', view.window.words], ...view.hide ? [['Hides', view.hide.words]] : []]);
  const own = signInCard(SIGN_IN, { view: SIGN_IN.view, count: '', busy: null, refused: '' });
  for (const row of accessRows(SIGN_IN.view)) assert.ok(own.includes(esc(row.value)), `${row.name}, from the sign-in’s own view`);
  const kept = signInCard(SIGN_IN, { view, count: '', busy: null, refused: '' });
  for (const row of rows) assert.ok(kept.includes(esc(row.value)), `${row.name}, from the kept draft`);
  for (const words of [SIGN_IN.head, phraseWords(SIGN_IN.over_line), SIGN_IN.pick, SIGN_IN.pick_line]) assert.ok(own.includes(esc(words)), words);
  const page = draftDetail(`signin:${SIGN_IN.id}`, { ...NO_AGENT_READS }, { state: { .../** @type {any} */ (HOST_FILES['waiting-sign-in'].state) },
    opened: OPENED, home: true, now: AT.now, when: AT.when });
  assert.equal(page.line, phraseWords(SIGN_IN.over_line), 'the head’s line, the home’s');
  assert.deepEqual(rowsOf(page.parts).map(row => row.end && 'words' in row.end ? row.end.words : ''), accessRows(SIGN_IN.view).map(row => row.value),
    'its rows from its own view while no draft is read');
  const live = draftDetail(`signin:${SIGN_IN.id}`, { ...NO_AGENT_READS, editor: shown(view) }, { state: { .../** @type {any} */ (HOST_FILES['waiting-sign-in'].state) },
    opened: OPENED, home: true, now: AT.now, when: AT.when });
  assert.deepEqual(live.parts.find(part => part.pick)?.pick && { label: live.parts.find(part => part.pick)?.pick?.label,
    line: live.parts.find(part => part.pick)?.pick?.line }, { label: SIGN_IN.pick, line: SIGN_IN.pick_line }, 'the pick’s title and line, the home’s');
});
