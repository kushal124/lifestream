// @ts-check
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentDetail, controlFoot, controlOf, draftDetail, historyOf, historyRowOf, NO_AGENT_READS, OPEN_FIELD, readFoot, readParts, thingsParts,
  whenWords } from '../public/ui/agents/detail.js';
import { answerKey, signInOf } from '../public/lib/agents.js';
import { routeOf } from '../public/lib/opening.js';
import { busyKey } from '../public/ui/connectors/view.js';
import { drafts } from '../public/ui/agents/drafts.js';
import { agentsFrame } from '../public/ui/agents/frame.js';
import { OPENED } from '../public/ui/connectors/dialog.js';
import { detailMarkup } from '../public/ui/connectors/detail.js';
import { AT_REST } from '../public/ui/connectors/view.js';
import { esc } from '../public/lib/html.js';
import { phraseWords } from '../public/lib/words.js';
import { until } from './until.mjs';

/** @typedef {import('../public/types.js').AgentAsk} AgentAsk */
/** @typedef {import('../public/types.js').AgentRead} AgentRead */
/** @typedef {import('../public/types.js').AccessDraft} AccessDraft */
/** @typedef {import('../public/types.js').EditRequest} EditRequest */

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'homelink', 'Tests', 'Fixtures', 'agents', 'door');
/**
 * @param {string} name
 * @returns {any}
 */
const answer = name => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')).answer;
const ENDED = answer('edit-sign-in-ended');
assert.ok(readdirSync(FIXTURES).includes('ask-open.json'));
const READER = /** @type {AgentRead} */ (answer('reader-agent'));
const SIGN_IN = JSON.parse(readFileSync(join(FIXTURES, '..', '..', 'agents-host', 'waiting-sign-in.json'), 'utf8'))
  .state.agent_requests[0];
const OPEN = /** @type {AgentAsk} */ (answer('ask-open'));
const DECLINED = /** @type {AgentAsk} */ (answer('ask-declined'));
/**
 * @param {string} code
 * @param {string} [message]
 */
const refused = (code, message = 'Lifestream did not take that.') => Object.assign(new Error(message), { code });
/** @param {{ asks?: AgentAsk[], signIns?: unknown[] }} lists */
const stateOf = ({ asks = [], signIns = [] }) => /** @type {any} */ ({ agent_requests: signIns, agent_asks: asks });

/** @param {{ asks?: (AgentAsk | Error)[], readers?: (AgentRead | Error)[], reply?: (act: any) => Promise<any>, ended?: Set<string>, edited?: ((asked: EditRequest) => AccessDraft) | null, home?: boolean }} parts */
function frameOver({ asks = [], readers = [], reply = async () => ({ answer: {} }), ended = new Set(), edited = null, home = false }) {
  const sent = { edits: /** @type {EditRequest[]} */ ([]), saves: /** @type {any[]} */ ([]), acts: /** @type {any[]} */ ([]),
    asks: 0, readers: 0, draws: 0, kinds: /** @type {string[]} */ ([]), reads: /** @type {string[]} */ ([]), things: /** @type {string[]} */ ([]) };
  /** @template T @param {(T | Error)[]} queue @returns {Promise<T>} */
  const next = queue => {
    const value = queue.length > 1 ? queue.shift() : queue[0];
    return value instanceof Error || value === undefined ? Promise.reject(value ?? refused('NOT_NOW')) : Promise.resolve(value);
  };
  const host = /** @type {any} */ ({ state: stateOf({}), follow: () => () => {}, act: (/** @type {any} */ act) => {
    sent.acts.push(act);
    return reply(act);
  } });
  const frame = agentsFrame({ host, draw: () => { sent.draws += 1; }, holdsHome: () => home, hold: (_, run) => run(), io: {
    reader: id => { sent.readers += 1; return next(readers).then(read => ({ ...read, id })); },
    history: async (_id, _before, kind) => {
      sent.kinds.push(kind ?? '');
      return kind ? answer('history-kind') : answer('history');
    },
    read: async (_id, call) => {
      sent.reads.push(call);
      return { ...answer('read'), id: call };
    },
    things: async (_id, call) => {
      sent.things.push(call);
      return answer('things');
    },
    ask: () => { sent.asks += 1; return next(asks); },
    edit: async asked => {
      sent.edits.push(asked);
      if ('request' in asked.target && ended.has(asked.target.request)) throw Object.assign(refused(ENDED.code, ENDED.message), { status: 404 });
      if (edited) return edited(asked);
      return { access: asked.access, expect: asked.expect, view: READER.view };
    },
    save: async (id, saved) => {
      sent.saves.push({ id, ...saved });
      return { access: saved.access, expect: saved.expect + 1, view: READER.view };
    },
    answer: async () => assert.fail('a frame with a host answers through it'),
  } });
  /**
   * @param {string[]} pages
   * @param {any} state
   * @param {Record<string, string>} [fields]
   */
  const at = (pages, state, fields = {}) => frame.follow({ id: pages[0] ?? '', state, opened: { ...OPENED, pages: pages.slice(1), fields },
    shown: true, zone: 'UTC' });
  return { frame, sent, at };
}

afterEach(() => {
  for (const id of drafts.ids()) drafts.forget(id);
});

test('F1: a sign-in’s Change reopened starts from the draft kept with Done', async () => {
  const kept = { ...SIGN_IN.access, window: { past_ms: 86_400_000 } };
  drafts.keep(SIGN_IN.id, { access: kept, view: READER.view });
  const { sent, at } = frameOver({});
  at([`signin:${SIGN_IN.id}`], stateOf({ signIns: [SIGN_IN] }));
  await until('the sign-in’s draft drawn', () => sent.edits.length === 1);
  assert.deepEqual(sent.edits[0].access, kept, 'the kept draft, not the access it would get');
});

test('F2: an ask gone from the host’s list is read; ended, its outcome in place of its draft and Allow', async () => {
  const { frame, sent, at } = frameOver({ asks: [OPEN, DECLINED] });
  const listed = stateOf({ asks: [OPEN] });
  at([`ask:${OPEN.id}`], listed);
  await until('the ask’s draft', () => frame.reads.editor !== null);
  at([`ask:${OPEN.id}`], stateOf({ asks: [] }));
  await until('the ask read as ended', () => frame.reads.editorFailed === phraseWords(DECLINED.outcome));
  assert.equal(frame.reads.editor, null, 'no draft, so no Allow');
  assert.equal(await frame.act({ editor: 'allow' }), undefined);
  assert.deepEqual(sent.acts, [], 'nothing answered');
});

test('F2: a read of how an ask stands that fails keeps Allow held; the next poll reads it again', async () => {
  const away = refused('NOT_NOW', 'Can’t reach Lifestream.');
  const { frame, sent, at } = frameOver({ asks: [OPEN, away, OPEN], reply: () => Promise.reject(refused('OUTCOME_UNKNOWN', 'Not sure.')) });
  at([`ask:${OPEN.id}`], stateOf({ asks: [OPEN] }));
  await until('the ask’s draft', () => frame.reads.editor !== null);
  await frame.act({ editor: 'allow' });
  await until('the read after the lost reply', () => sent.asks === 2);
  assert.equal(frame.reads.checking, true, 'held until the home says how it stands');
  const drawn = frame.detail({ id: `ask:${OPEN.id}`, state: stateOf({ asks: [OPEN] }), opened: OPENED, home: true, now: Date.now() });
  assert.equal(drawn?.foot?.end.at(-1)?.disabled, true, 'Allow disabled');
  await frame.act({ editor: 'allow' });
  assert.equal(sent.acts.length, 1, 'no second answer while held');
  at([`ask:${OPEN.id}`], stateOf({ asks: [OPEN] }));
  await until('read again at the poll', () => sent.asks === 3 && frame.reads.checking === false);
});

test('F3: after ACCESS_CHANGED the stale draft is dropped and drawn again from the fresh proposal and version', async () => {
  const fresh = { ...OPEN, version: OPEN.version + 2, proposed: { ...OPEN.proposed, window: { past_ms: 3_600_000 } } };
  const replies = [() => Promise.reject(refused('ACCESS_CHANGED', 'This access changed since it was drawn: read it again.')),
    () => Promise.resolve({ answer: {} })];
  const { frame, sent, at } = frameOver({ asks: [OPEN, fresh], reply: () => /** @type {() => Promise<any>} */ (replies.shift())() });
  at([`ask:${OPEN.id}`], stateOf({ asks: [OPEN] }));
  await until('the ask’s draft', () => frame.reads.editor !== null);
  await frame.act({ editor: 'allow' });
  await until('drawn again from the fresh ask', () => sent.edits.length === 2 && frame.reads.editor !== null);
  assert.deepEqual(sent.edits[1].access, fresh.proposed);
  assert.equal(sent.edits[1].expect, fresh.version);
  await frame.act({ editor: 'allow' });
  assert.equal(sent.acts.length, 2);
  assert.equal(sent.acts[1].expect, fresh.version, 'Allow again with the fresh version, never the stale one');
});

test('F4: a reader reopened after a save is read again, its editor at the saved version', async () => {
  const saved = { ...READER, version: 2 };
  const { frame, sent, at } = frameOver({ readers: [READER, saved] });
  const page = `agent:${READER.id}`;
  at([page], null);
  await until('the reader’s editor', () => frame.reads.editor !== null);
  await frame.act({ edit: { window: { past_ms: 86_400_000 } } });
  assert.equal(sent.saves.length, 1);
  at([], null);
  at([page], null);
  await until('the reader read again', () => sent.readers === 2 && frame.reads.editor !== null);
  await frame.act({ edit: { hide: 'custom' } });
  assert.equal(sent.edits.at(-1)?.expect, 2, 'the next edit on the saved version');
});

test('F5: Access, an account’s fold and Hides ask the home nothing', async () => {
  const { frame, sent, at } = frameOver({ readers: [READER] });
  const page = `agent:${READER.id}`;
  at([page], null);
  await until('the reader’s editor', () => frame.reads.editor !== null);
  const edits = sent.edits.length;
  at([page, 'access'], null);
  at([page, 'access'], null, { [OPEN_FIELD]: 'mail' });
  at([page, 'hides'], null);
  assert.equal(sent.edits.length, edits, 'no edit sent');
  assert.equal(sent.readers, 1, 'no read');
});

test('a connected app’s reader page leads with the app’s mark the home gives, as its row does', async () => {
  const chatgpt = { ...READER, mark: 'chatgpt' };
  const { frame, at } = frameOver({ readers: [chatgpt] });
  at([`agent:${READER.id}`], stateOf({}));
  await until('the reader’s editor', () => frame.reads.editor !== null);
  assert.equal(pageOf(frame, READER.id)?.icon, 'chatgpt');
});

test('F6: an open ask’s editor is not drawn again for a changed proposal; a moved version draws it again', async () => {
  const { frame, sent, at } = frameOver({ asks: [OPEN, { ...OPEN, version: OPEN.version + 1 }] });
  at([`ask:${OPEN.id}`], stateOf({ asks: [OPEN] }));
  await until('the ask’s draft', () => frame.reads.editor !== null);
  await frame.act({ edit: { hide: 'custom' } });
  assert.equal(sent.edits.length, 2);
  const reworded = { ...OPEN, proposed: { ...OPEN.proposed, allow: OPEN.proposed.allow.map(each => ({ ...each, until_ms: 1 })) } };
  at([`ask:${OPEN.id}`], stateOf({ asks: [reworded] }));
  assert.equal(sent.edits.length, 2, 'no draw again');
  assert.equal(sent.asks, 1, 'no read');
  at([`ask:${OPEN.id}`], stateOf({ asks: [{ ...OPEN, version: OPEN.version + 1 }] }));
  await until('drawn again at the new version', () => sent.edits.length === 3);
  assert.equal(sent.edits[2].expect, OPEN.version + 1);
});

test('F2: a sign-in gone from the host’s list asks the home once more, and ends its editor in the home’s words', async () => {
  /** @type {Set<string>} */
  const ended = new Set();
  const { frame, sent, at } = frameOver({ ended });
  at([`signin:${SIGN_IN.id}`], stateOf({ signIns: [SIGN_IN] }));
  await until('the sign-in’s draft', () => frame.reads.editor !== null);
  ended.add(SIGN_IN.id);
  at([`signin:${SIGN_IN.id}`], stateOf({}));
  await until('the home’s words', () => frame.reads.editorFailed !== '');
  assert.equal(frame.reads.editor, null);
  assert.equal(frame.reads.editorFailed, ENDED.message);
  assert.equal(sent.edits.length, 2, 'the draft, then the one that asked whether it still waits');
  assert.equal(await frame.act({ editor: 'done' }), undefined);
  assert.equal(sent.acts.length, 0);
});

test('F3: Disconnect goes through the host and reads the agent again, back on its page; Remove from the list goes through the host and closes', async () => {
  const gone = /** @type {AgentRead} */ (answer('disconnect'));
  const { frame, sent, at } = frameOver({ readers: [READER, gone] });
  at([`agent:${gone.id}`, 'disconnect'], stateOf({}));
  await until('the agent read', () => frame.reads.one !== null);
  const before = sent.readers;
  assert.equal(await frame.act({ disconnect: gone.id }), 'back');
  assert.deepEqual(sent.acts, [{ act: 'agent-disconnect', id: gone.id }]);
  assert.equal(sent.readers, before + 1, 'the agent read again');
  assert.equal(frame.reads.one?.state, 'disconnected');
  assert.equal(await frame.act({ unlist: gone.id }), 'close');
  assert.deepEqual(sent.acts.at(-1), { act: 'agent-unlist', id: gone.id });
  assert.equal(await frame.act({ unlist: 'p-0000ffff' }), undefined, 'never another agent’s');
  assert.equal(sent.acts.length, 2);
});

/**
 * @param {ReturnType<typeof frameOver>['frame']} frame
 * @param {string} id
 */
const pageOf = (frame, id) => frame.detail({ id: `agent:${id}`, state: stateOf({}), opened: OPENED, home: true, now: Date.now() });

/**
 * @param {ReturnType<typeof pageOf>} page
 * @param {string} label
 */
const menuOf = (page, label) => {
  const row = page?.parts.flatMap(part => part.panel?.rows ?? []).find(each => each.label === label);
  assert.ok(row?.menu, `${label} is a menu on its row`);
  return row.menu;
};

test('W1: a narrowing picked from How far back saves at once; the foot says the home’s words with Undo, and Undo sends its undo', async () => {
  const narrowing = /** @type {AccessDraft} */ (answer('edit-window'));
  const { frame, sent, at } = frameOver({ readers: [READER], home: true, edited: () => narrowing,
    reply: async () => ({ answer: answer('access-undo') }) });
  at([`agent:${READER.id}`], stateOf({}));
  await until('the agent’s page and its editor', () => frame.reads.editor !== null);
  const choice = menuOf(pageOf(frame, READER.id), 'How far back').choices.find(each => each.words === 'Past 30 days');
  assert.ok(choice?.do, 'Past 30 days in the menu');
  await frame.act(/** @type {any} */ (choice.do));
  assert.deepEqual(sent.edits.map(each => each.edit), [{ window: { past_ms: 2_592_000_000 } }], 'one change sent');
  assert.deepEqual([sent.saves, sent.acts], [[], []], 'the home saved the narrowing with the change: nothing sent again');
  const foot = pageOf(frame, READER.id)?.foot;
  assert.deepEqual(foot?.said, narrowing.narrowed?.words, 'the home’s words, bold parts and all');
  assert.equal(foot?.mark, 'done');
  assert.deepEqual(foot?.end.map(act => [act.label, act.keys, act.do]), [['Undo', '⌘Z', { editor: 'undo' }]]);
  await frame.act({ editor: 'undo' });
  assert.deepEqual(sent.acts, [{ act: 'agent-access', id: READER.id, ...narrowing.narrowed?.undo }], 'Undo sends the undo the home gave');
});

test('W1: a widening picked from a menu saves nothing until Allow', async () => {
  const widening = /** @type {AccessDraft} */ (answer('edit-widening'));
  const { frame, sent, at } = frameOver({ readers: [READER], home: true, edited: () => widening,
    reply: async () => ({ answer: answer('access-narrowed') }) });
  at([`agent:${READER.id}`], stateOf({}));
  await until('the agent’s page and its editor', () => frame.reads.editor !== null);
  const choice = menuOf(pageOf(frame, READER.id), 'How far back').choices.find(each => each.words === 'Past year');
  await frame.act(/** @type {any} */ (choice?.do));
  assert.deepEqual([sent.saves, sent.acts], [[], []], 'nothing saved');
  const foot = pageOf(frame, READER.id)?.foot;
  assert.deepEqual(foot?.said, widening.view.widening);
  assert.equal(foot?.mark, 'waiting');
  assert.deepEqual(foot?.end.map(act => [act.label, act.variant, act.do]), [['Cancel', 'secondary', { editor: 'cancel' }],
    ['Allow', 'primary', { editor: 'save' }]]);
  await frame.act({ editor: 'save' });
  assert.deepEqual(sent.acts.map(each => each.act), ['agent-access'], 'Allow saves it, once');
});

test('W1: the Hides menu says each choice’s line, and Choose… pushes the hides page', async () => {
  const { frame, at } = frameOver({ readers: [READER] });
  at([`agent:${READER.id}`], stateOf({}));
  await until('the agent’s page and its editor', () => frame.reads.editor !== null);
  const hides = menuOf(pageOf(frame, READER.id), 'Hides');
  const choices = READER.view.hide?.choices ?? [];
  assert.ok(choices.length > 0);
  assert.deepEqual(hides.choices.map(each => [each.words, each.note, each.chosen]),
    choices.map(each => [each.words, each.line ?? '', each.selected]));
  assert.deepEqual(hides.choices.find(each => each.words === 'Choose…')?.do, { page: 'hides' });
  const markup = detailMarkup(/** @type {any} */ (pageOf(frame, READER.id)), AT_REST);
  for (const each of choices.filter(choice => choice.line)) assert.ok(markup.includes(esc(each.line ?? '')), each.words);
});

/**
 * @param {ReturnType<typeof agentsFrame>} frame
 * @param {string} id
 * @param {string[]} pages
 */
const insideOf = (frame, id, pages) => frame.detail({ id: `agent:${id}`, state: stateOf({}), opened: { ...OPENED, pages }, home: true,
  now: Date.now() });

test('W2: a chip filters at the home: picking one asks for that kind, a second click clears it, the figure stays', async () => {
  const { frame, sent, at } = frameOver({ readers: [READER] });
  at([`agent:${READER.id}`, 'history'], stateOf({}));
  await until('the history read', () => frame.reads.history !== null);
  const chips = insideOf(frame, READER.id, ['history'])?.parts.find(part => part.kinds)?.kinds;
  assert.deepEqual(chips?.choices.map(each => [each.label, each.count]), answer('history').chips.map((/** @type {any} */ chip) =>
    [chip.name, String(chip.n)]), 'a chip per kind the home counts, its count');
  await frame.act({ kind: 'messages' });
  assert.deepEqual(sent.kinds, ['', 'messages'], 'the home asked for history?kind=messages');
  const filtered = insideOf(frame, READER.id, ['history']);
  assert.equal(filtered?.parts.find(part => part.kinds)?.kinds?.value, 'messages', 'the picked chip is the home’s filter');
  assert.ok(filtered?.parts.some(part => part.figure), 'the figure stays');
  const markup = detailMarkup(/** @type {any} */ (filtered), AT_REST);
  assert.match(markup, /class="ck-fchip mac-subhead is-chosen"[^>]*data-value="messages"/u);
  await frame.act({ kind: '' });
  assert.deepEqual(sent.kinds, ['', 'messages', ''], 'a second click clears it');
});

test('W2: a read row pushes its page, read once; a count row opens nothing', async () => {
  const lines = answer('history').sessions.flatMap((/** @type {any} */ session) => session.lines);
  const read = lines.find((/** @type {any} */ line) => line.kind === 'call' && line.opens);
  assert.ok(read, 'the file holds a read that opens');
  const when = whenWords('2026-11-14');
  const row = historyRowOf(read, when);
  assert.deepEqual(row.go?.do, { page: `read:${read.id}` });
  assert.equal(row.go?.time, when.clock(read.at_ms), 'its time beside the chevron');
  const count = historyRowOf({ ...read, opens: false }, when);
  assert.equal(count.go, null, 'a count has no chevron');
  assert.deepEqual(count.end, { time: when.clock(read.at_ms) });
  assert.doesNotMatch(detailMarkup(/** @type {any} */ ({ id: 'agent:x', icon: '', name: '', line: '', state: null, callout: null,
    figure: null, panels: [], back: null, foot: null, confirm: null, reading: false, ticking: false,
    parts: [{ label: '', lines: [], acts: [], card: true, panel: { label: '', about: '', lede: '', rows: [count], add: null, note: '' } }] }),
  AT_REST), /ck-srow__chev/u, 'and does nothing');

  const { frame, sent, at } = frameOver({ readers: [READER] });
  const pages = ['history', `read:${read.id}`];
  at([`agent:${READER.id}`, ...pages], stateOf({}));
  await until('the read’s page read', () => frame.reads.read !== null);
  at([`agent:${READER.id}`, ...pages], stateOf({}));
  assert.deepEqual(sent.reads, [read.id], 'one read of reads/<id>');
  const page = insideOf(frame, READER.id, pages);
  assert.deepEqual([page?.name, page?.line, page?.back], [answer('read').title, answer('read').line, { label: 'History', above: true }]);
  assert.deepEqual(page?.foot?.end.map(act => [act.label, act.do]), [[answer('read').show.words, { page: `things:${read.id}` }]]);
});

test('W2: a refused read draws its stop in the home’s words: no figure, no Kept, no Show', () => {
  const refused = answer('read-refused');
  const parts = readParts(refused);
  assert.deepEqual(parts.map(part => [part.label, part.refused ?? null, Boolean(part.amount)]), [['', refused.refused, false],
    ['Why it could', null, false]]);
  assert.equal(readFoot(refused), null);
  const kept = readParts(answer('read'));
  assert.deepEqual(kept.find(part => part.label === 'Kept from it')?.panel?.rows.map(row => [row.label, row.end]),
    answer('read').kept.rows.map((/** @type {any} */ each) => [each.name, { words: each.value }]));
  assert.deepEqual(kept[0].amount?.parts, answer('read').kinds.map((/** @type {any} */ each) => ({ id: each.kind, name: each.name, n: each.n })));
});

test('W3: a thing opens where the home says, its day at its place, through the app’s own page, never a viewer', () => {
  const things = answer('things');
  const rows = thingsParts(things, 'call-1').flatMap(part => part.panel?.rows ?? []);
  const all = things.groups.flatMap((/** @type {any} */ group) => group.things);
  assert.ok(all.every((/** @type {any} */ thing) => thing.opens.page === 'days' && thing.opens.focus), 'the fixtures open a day at a place');
  assert.deepEqual(rows.map(row => [row.label, row.go?.do, row.go?.time]), all.map((/** @type {any} */ thing) =>
    [thing.title, { to: { view: 'days', patch: { on: thing.opens.day, focus: thing.opens.focus } } }, thing.when]));
  const person = { ...all[0], opens: { page: 'people', id: 'person-a' } };
  const place = { ...all[0], opens: { page: 'places', id: 'place-a' } };
  const read = { ...all[0], opens: { page: 'read' } };
  const others = thingsParts({ ...things, groups: [{ ...things.groups[0], things: [person, place, read] }] }, 'call-1')
    .flatMap(part => part.panel?.rows ?? []);
  assert.deepEqual(others.map(row => row.go?.do ?? null), [{ to: { view: 'people', patch: { focus: 'person-a' } } },
    { to: { view: 'places', patch: { focus: 'place-a' } } }, null], 'a person, a place, and a thing that opens nowhere');
  assert.deepEqual(others.at(-1)?.end, { time: read.when }, 'one that opens nowhere keeps its time and no chevron');
});

test('W2: the Reads page draws no presets; a widening marks the kinds it would add as waiting', async () => {
  const { frame, at } = frameOver({ readers: [READER] });
  at([`agent:${READER.id}`, 'access'], stateOf({}));
  await until('the agent’s editor', () => frame.reads.editor !== null);
  const page = detailMarkup(/** @type {any} */ (insideOf(frame, READER.id, ['access'])), AT_REST);
  assert.match(page, /role="checkbox"/u, 'the kinds drawn');
  assert.doesNotMatch(page, /access\.start|Start from/u);
  const before = /** @type {AccessDraft} */ (answer('edit-mode-but')).view;
  const after = /** @type {AccessDraft} */ (answer('edit-type-on')).view;
  const lines = controlOf(after, OPENED, before).lines;
  const added = after.categories.filter(each => each.state !== 'off'
    && before.categories.find(was => was.type === each.type)?.state === 'off').map(each => each.name);
  assert.ok(added.length > 0, 'the fixtures widen');
  assert.deepEqual(lines.filter(line => line.waits).map(line => line.name), added);
  assert.equal(controlOf(after, OPENED).lines.some(line => line.waits), false, 'nothing waits once saved');
});

test('W2: an ask’s default is the filled button with ↵; Don’t allow plain with esc; each sends its answer', async () => {
  const { frame, at } = frameOver({ asks: [OPEN] });
  at([`ask:${OPEN.id}`], stateOf({ asks: [OPEN] }));
  await until('the ask’s draft', () => frame.reads.editor !== null);
  const page = frame.detail({ id: `ask:${OPEN.id}`, state: stateOf({ asks: [OPEN] }), opened: OPENED, home: true, now: Date.now() });
  assert.deepEqual([page?.name, page?.line], [OPEN.head, phraseWords(OPEN.asked_line)]);
  const ends = page?.foot?.end ?? [];
  assert.deepEqual(ends.map(act => [act.variant, act.keys, 'answer' in act.do ? act.do.answer.answer : null]),
    [['plain', 'esc', 'no'], ['secondary', '⌘↵', 'always'], ['primary', '↵', OPEN.default]].filter(([, , answer]) =>
      OPEN.choices.some(each => each.answer === answer)));
  assert.equal(ends.filter(act => act.variant === 'primary').length, 1);
});

test('W3: a day’s section counts the whole day’s reads the home serves, never the sitting’s, nor a sum of sittings', () => {
  const history = answer('history');
  const today = history.sessions.filter((/** @type {any} */ each) => each.day.words === history.sessions[0].day.words);
  assert.ok(today.length > 1 && new Set(today.map((/** @type {any} */ each) => each.reads)).size > 1, 'the fixture: one day, sittings of their own counts');
  const { days } = historyOf(history, READER.id, whenWords('2026-11-14'));
  assert.deepEqual(days.map(day => [day.day, day.reads]), [[today[0].day.words, today[0].day.reads]]);
  const quiet = historyOf({ ...history, sessions: history.sessions.map((/** @type {any} */ each) => ({ ...each, day: { ...each.day, reads: null } })) },
    READER.id, whenWords('2026-11-14'));
  assert.deepEqual(quiet.days.map(day => day.reads), [''], 'a day the home counts nothing for says nothing');
});

test('W3: the Undo and Allow foot says what was saved and what waits as two lines, each its own mark', () => {
  const split = /** @type {AccessDraft} */ (answer('edit-narrowed-widening-waits'));
  const foot = controlFoot(split.view, { view: split.view, busy: false, note: '', held: true, narrowed: split.narrowed, undoes: true }, 'reader', false);
  const markup = detailMarkup(/** @type {any} */ ({ id: 'agent:x', icon: 'streams', name: 'Reads', line: '', state: null, callout: null, figure: null,
    parts: [], panels: [], back: null, foot, confirm: null, reading: false, ticking: false }), AT_REST);
  const lines = [...markup.matchAll(/<p class="ck-afoot__said">(.*?)<\/p>/gsu)].map(found => found[1]);
  assert.equal(lines.length, 2, 'two lines');
  assert.match(lines[0] ?? '', /ck-icon/u, 'what was saved, its done mark');
  assert.ok((lines[0] ?? '').includes(esc(split.narrowed?.words[0]?.text ?? '-')), 'the home’s saved words first');
  assert.match(lines[1] ?? '', /ck-signal/u, 'what waits, its waiting dot');
  const alone = controlFoot(split.view, { view: split.view, busy: false, note: '', held: true, narrowed: null, undoes: true }, 'reader', false);
  assert.deepEqual([alone.said, alone.mark, alone.waits], [split.view.widening, 'waiting', []], 'nothing saved: what waits, one line');
});

test('W3: How far back is the home’s order, a rule before Since a date… alone', () => {
  const page = agentDetail(`agent:${READER.id}`, { ...NO_AGENT_READS, one: READER, editor: { view: READER.view, busy: false, note: '', held: false } },
    { state: null, opened: OPENED, home: true, now: 0, when: whenWords('2026-11-14') });
  const menu = page.parts.flatMap(part => part.panel?.rows ?? []).find(row => row.label === 'How far back')?.menu;
  assert.deepEqual(menu?.choices.map(each => each.words), READER.view.times.map(each => each.words));
  assert.equal(READER.view.times.at(-1)?.choice, 'since', 'the home puts Since a date… last');
  assert.deepEqual(menu?.choices.filter(each => each.parted).map(each => each.words), [READER.view.times.at(-2)?.words]);
});

test('W3: an answer out shows busy on its own button: each answer its own hold, one answer to an ask at a time', async () => {
  const [once, always] = /** @type {const} */ (['once', 'always']);
  const keys = [answerKey({ id: OPEN.id, answer: once, expect: 1 }), answerKey({ id: OPEN.id, answer: always, expect: 1 }),
    answerKey({ id: OPEN.id, answer: 'no' })];
  assert.equal(new Set(keys).size, 3, 'each answer its own key');
  assert.equal(busyKey({ answer: { id: OPEN.id, answer: 'no' } }), keys[2], 'the button’s key is the hold’s');
  assert.equal(busyKey({ answer: { id: SIGN_IN.id, answer: '482915' } }), answerKey({ id: SIGN_IN.id, answer: '482915' }), 'a code too');
  /** @type {string[]} */
  const held = [];
  /** @type {(value: unknown) => void} */
  let land = () => {};
  const host = /** @type {any} */ ({ state: stateOf({}), follow: () => () => {}, act: () => new Promise(resolve => { land = resolve; }) });
  const frame = agentsFrame({ host, draw: () => {}, holdsHome: () => true, hold: (key, run) => { held.push(key); return run(); },
    io: /** @type {any} */ ({ answer: async () => assert.fail('through the host') }) });
  const first = frame.act({ answer: { id: OPEN.id, answer: 'no' } });
  assert.equal(frame.reads.answering, true, 'the others wait while it is out');
  const second = frame.act({ answer: { id: OPEN.id, answer: once, expect: 1 } });
  await second;
  assert.deepEqual(held, [keys[2]], 'a second answer to the same ask is not sent while the first is out');
  land({ answer: { state: 'declined', version: null, outcome: [{ kind: 'words', words: 'Not allowed.' }] } });
  await first;
  assert.equal(frame.reads.answering, false);
});

test('W3: an ask page’s added kinds are rows with the kind’s own icon, by the name the home serves', () => {
  const draft = /** @type {AccessDraft} */ (answer('edit-ask'));
  const named = draft.view.categories.find(each => each.icon !== 'streams');
  assert.ok(named, 'the fixture names a kind with its own icon');
  const ask = { ...OPEN, adds: [named.name, 'Something new'] };
  const page = draftDetail(`ask:${ask.id}`, { ...NO_AGENT_READS, asked: ask, editor: { view: draft.view, busy: false, note: '', held: false,
    access: draft.access, expect: draft.expect } }, { state: null, opened: OPENED, home: true, now: 0, when: whenWords('2026-11-14') });
  const rows = page.parts.flatMap(part => part.panel?.rows ?? []);
  assert.deepEqual(rows.map(row => [row.label, row.lead]), [[named.name, { icon: named.icon }], ['Something new', { icon: 'streams' }]]);
});

test('W3: a sign-in the host passes is kept only with its own lines, view and pick from the home', () => {
  assert.equal(signInOf(SIGN_IN), SIGN_IN);
  for (const gone of ['at_ms', 'over_line', 'view', 'pick', 'pick_line']) {
    const { [gone]: _, ...rest } = SIGN_IN;
    assert.equal(signInOf(rest), null, `without ${gone}`);
  }
});

test('W3: a cited thing and a found thing open by one rule', () => {
  assert.deepEqual(routeOf({ page: 'days', day: '2026-11-14', focus: 'rec:x' }), { go: 'days', patch: { on: '2026-11-14', focus: 'rec:x' } });
  assert.deepEqual(routeOf({ page: 'days', day: '2026-11-14' }), { go: 'days', patch: { on: '2026-11-14' } });
  assert.equal(routeOf({ page: 'read' }), null);
  assert.equal(routeOf(undefined), null);
});
