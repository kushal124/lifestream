// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FINISHING_MS, guidesFrame, keyState, signInState } from '../public/ui/agents/guides.js';
import { agentsFrame, AGENTS_IO } from '../public/ui/agents/frame.js';
import { drafts } from '../public/ui/agents/drafts.js';
import { CONNECT_ID, NAME_FIELD, NO_AGENT_READS, SINCE_FIELD, whenWords } from '../public/ui/agents/detail.js';
import { GUIDE } from '../public/ui/agents/words.js';
import { OPENED } from '../public/ui/connectors/dialog.js';
import { detailMarkup } from '../public/ui/connectors/detail.js';
import { AT_REST } from '../public/ui/connectors/view.js';

/** @typedef {import('../public/types.js').Guide} Guide */
/** @typedef {import('../public/types.js').AgentGuides} AgentGuides */

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'homelink', 'Tests', 'Fixtures');
/** @param {string} path @returns {any} */
const json = path => JSON.parse(readFileSync(join(FIXTURES, path), 'utf8'));
const STATES = json('agents/guide-states.json');
/** @type {Record<'mac' | 'phone', AgentGuides>} */
const GUIDES = { mac: json('pages/agentGuides.mac.json'), phone: json('pages/agentGuides.phone.json') };
/** @type {Record<string, any>} */
const DOOR = Object.fromEntries(readdirSync(join(FIXTURES, 'agents', 'guide-door')).filter(name => name.endsWith('.json'))
  .map(name => [name.slice(0, -'.json'.length), json(join('agents', 'guide-door', name)).answer]));
const SIGN_IN = json('agents-host/waiting-sign-in.json').state.agent_requests[0];

/** @param {string} app @param {'mac' | 'phone'} [device] @returns {Guide} */
const guideOf = (app, device = 'mac') => {
  const guide = GUIDES[device].apps.find(each => each.app === app);
  assert.ok(guide, `the ${device}'s guides hold ${app}`);
  return guide;
};

/** @param {string} app @param {string} kind @returns {any} */
const stepOf = (app, kind) => {
  const step = guideOf(app).steps.find(each => each.kind === kind);
  assert.ok(step, `${app}'s guide has its ${kind} step`);
  return step;
};

/** @param {string} words */
const said = words => new RegExp(JSON.stringify(words).slice(1, -1).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u');

test('every sign-in state of guide-states.json is the state the dashboard draws from the same inputs', () => {
  assert.ok(STATES['sign-in'].length > 10, 'the table is read whole');
  for (const each of STATES['sign-in']) {
    assert.deepEqual(signInState({ guide: guideOf(each.app), dialog: each.dialog, address: each.address, waiting: each.waiting,
      read: each.read }), each.state, each.case);
  }
});

test('every key state of guide-states.json is the state the dashboard draws, on the Mac’s guides and the iPhone’s', () => {
  assert.ok(STATES.key.length > 10, 'the table is read whole');
  for (const each of STATES.key) {
    assert.deepEqual(keyState({ guide: guideOf(each.app, each.device), dialog: each.dialog, address: each.address }), each.state, each.case);
  }
});

test('a waiting guide misses no other app’s sign-in: one from another guide’s app or from none is the row in step 2', () => {
  const dialog = { copied: true, setup: false, returned: false, shown: null, outcome: null, editing: false };
  const address = { state: /** @type {const} */ ('on') };
  const claude = signInState({ guide: guideOf('chatgpt'), dialog, address, read: null,
    waiting: [{ id: 'c1', app: 'claude', host: 'claude.ai', at_ms: 1 }] });
  assert.equal(claude.other, 'c1', 'Claude’s sign-in waits beside ChatGPT’s guide');
  assert.deepEqual(claude.shows, ['copied', 'waiting']);
  const none = signInState({ guide: guideOf('chatgpt'), dialog, address, read: null,
    waiting: [{ id: 'x1', app: null, host: 'agent.example', at_ms: 1 }, { id: 'x2', app: null, host: 'agent.example', at_ms: 4 }] });
  assert.equal(none.other, 'x2', 'the newest of them');
});

/**
 * @param {Partial<import('../public/ui/agents/guides.js').GuidesIO>} io
 */
function frameOver(io = {}) {
  const sent = { turns: /** @type {any[]} */ ([]), keys: /** @type {any[]} */ ([]), signins: /** @type {string[]} */ ([]),
    opened: /** @type {any[]} */ ([]), draws: 0, later: /** @type {{ run: () => void, ms: number }[]} */ ([]) };
  /** @type {(() => void)[]} */
  const focus = [];
  /** @type {(id: string) => Promise<import('../public/types.js').SignInRead>} */
  const signin = io.signin ?? (async id => ({ id, state: 'waiting', outcome: null, reader: null, connected: null }));
  const frame = guidesFrame({
    io: {
      guides: async () => GUIDES.mac,
      address: async () => DOOR['address-on'],
      turn: async asked => {
        sent.turns.push(asked);
        return DOOR['address-on'];
      },
      key: async asked => {
        sent.keys.push(asked);
        return DOOR['keys-grok-bot'];
      },
      edit: async () => { throw new Error('no edit'); },
      waiting: async () => ({ requests: [] }),
      ...io,
      signin: id => {
        sent.signins.push(id);
        return signin(id);
      },
    },
    draw: () => { sent.draws += 1; },
    open: target => { sent.opened.push(target); },
    page: { addEventListener: (/** @type {string} */ name, /** @type {() => void} */ run) => { if (name === 'focus') focus.push(run); } },
    later: (run, ms) => { sent.later.push({ run, ms }); },
  });
  /** @type {any} */
  let state = { agent_requests: [], agent_asks: [] };
  let pages = /** @type {string[]} */ ([]);
  /** @type {Record<string, string>} */
  let fields = {};
  const follow = () => frame.follow({ id: CONNECT_ID, pages, state, shown: true, fields });
  /** @param {{ pages?: string[], state?: any, fields?: Record<string, string> }} next */
  const at = next => {
    pages = next.pages ?? pages;
    state = next.state ?? state;
    fields = next.fields ?? fields;
    follow();
  };
  const detail = () => frame.detail({ state, opened: { ...OPENED, pages, fields }, home: true, now: 0, when: whenWords('2026-11-14') },
    NO_AGENT_READS);
  const settle = () => new Promise(done => setImmediate(done));
  /** @returns {any[]} */
  const steps = () => /** @type {any} */ (detail().parts.find(part => part.steps))?.steps ?? [];
  return { frame, sent, at, detail, steps, settle, focus: () => focus.forEach(run => run()) };
}

/** @param {any} step */
const buttonOf = step => step.parts.find((/** @type {any} */ part) => part.button)?.button ?? null;

test('a yes given on the iPhone lands on the Mac’s open guide: the sign-in leaves the list, its read says approved with a reader, the guide is Connected', async () => {
  const connected = { reader: 'p-00000009', line: 'It sees everything but Health and Money. Change it any time in Agents.' };
  const over = frameOver({ signin: async id => ({ id, state: 'approved', outcome: null, reader: 'p-00000009', connected }) });
  const ask = { ...SIGN_IN, app: 'chatgpt', host: 'chatgpt.com' };
  over.at({ pages: ['guide:chatgpt'], state: { agent_requests: [ask], agent_asks: [] } });
  await over.settle();
  over.at({});
  assert.equal(over.frame.editing, `signin:${ask.id}`, 'the guide holds this sign-in’s yes');
  assert.equal(JSON.stringify(over.detail().parts).includes(JSON.stringify(ask.head)), true, 'its head is step 2');
  over.at({ state: { agent_requests: [], agent_asks: [] } });
  await over.settle();
  assert.deepEqual(over.sent.signins, [ask.id], 'the sign-in is read once it leaves the list');
  const done = over.detail();
  assert.equal(done.name, guideOf('chatgpt').done.title);
  assert.equal(done.line, connected.line);
});

test('Finishing: an approved sign-in with no reader is read again every 2 s until its reader is there', async () => {
  /** @type {any[]} */
  const answers = [{ state: 'approved', outcome: null, reader: null, connected: null }, { state: 'approved', outcome: null, reader: 'p-0000000a',
    connected: { reader: 'p-0000000a', line: 'Connected line.' } }];
  const over = frameOver({ signin: async id => ({ id, ...answers.shift() }) });
  const ask = { ...SIGN_IN, app: 'claude', host: 'claude.ai' };
  over.at({ pages: ['guide:claude'], state: { agent_requests: [ask], agent_asks: [] } });
  await over.settle();
  over.at({});
  over.at({ state: { agent_requests: [], agent_asks: [] } });
  await over.settle();
  assert.match(JSON.stringify(over.detail()), said(stepOf('claude', 'yes').finishing), 'the page’s Finishing in Claude…');
  assert.equal(over.sent.later.length, 1);
  assert.equal(over.sent.later[0].ms, FINISHING_MS);
  for (let draws = 0; draws < 3; draws += 1) over.at({});
  assert.equal(over.sent.signins.length, 1, 'a draw reads nothing more: the timer does');
  over.sent.later[0].run();
  await over.settle();
  assert.equal(over.sent.signins.length, 2);
  assert.equal(over.detail().name, guideOf('claude').done.title);
});

test('a copy turns the address on beside it: a second copy while it is sent joins it, sending no second POST', async () => {
  /** @type {(answer: any) => void} */
  let land = () => {};
  const over = frameOver({ turn: asked => new Promise(done => { over.sent.turns.push(asked); land = done; }),
    address: async () => DOOR['address-off'] });
  over.at({ pages: ['guide:chatgpt'] });
  await over.settle();
  over.at({});
  const markup = detailMarkup(over.detail(), AT_REST);
  const button = markup.match(/<button[^>]*data-cn-copy="https:[^"]*"[^>]*>/u)?.[0] ?? '';
  assert.match(button, /data-cn-do=/u, 'the address’s Copy both writes the clipboard in its click and asks for the address');
  const first = over.frame.act({ copy: { address: true } });
  const second = over.frame.act({ copy: { address: true } });
  assert.deepEqual(over.sent.turns, [{ on: true }], 'one POST for two copies');
  assert.match(JSON.stringify(over.detail()), /"Waiting for ChatGPT"/u, 'Copied shows before the POST answers');
  land(DOOR['address-on']);
  await Promise.all([first, second]);
  assert.match(JSON.stringify(over.detail()), new RegExp(DOOR['address-on'].line.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
});

test('a fresh Mac: Tailscale is step 1 with Get Tailscale and the rest waits; back in front only reads; once ready, Turn on sends the address on and the step ticks', async () => {
  const chatgpt = guideOf('chatgpt');
  const address = /** @type {NonNullable<Guide['address']>} */ (chatgpt.address);
  /** @type {any[]} */
  const reads = [DOOR['address-fix-mac'], DOOR['address-fix-mac'], DOOR['address-off']];
  let read = 0;
  const over = frameOver({ address: async () => {
    read += 1;
    return reads.length > 1 ? reads.shift() : reads[0];
  } });
  over.at({ pages: ['guide:chatgpt'] });
  await over.settle();
  over.at({});
  const fix = over.steps();
  assert.deepEqual(fix.map(step => [step.title, step.mark]), [[address.title, 'here'], [chatgpt.steps[0].title, 'later'],
    [chatgpt.steps[1].title, 'later']], 'Tailscale first, every step of the app waiting under it');
  assert.equal(fix[0].line, address.line);
  assert.match(JSON.stringify(fix[0].parts), said(DOOR['address-fix-mac'].words));
  assert.deepEqual(buttonOf(fix[0]).do, { guide: { fix: 'web', url: DOOR['address-fix-mac'].act.url } }, 'Get Tailscale opens its download');
  await over.frame.act(buttonOf(fix[0]).do.guide);
  assert.deepEqual(over.sent.opened, [{ url: DOOR['address-fix-mac'].act.url }]);
  over.focus();
  await over.settle();
  assert.deepEqual([read, over.sent.turns], [2, []], 'back in front: read once, nothing turned on');
  over.focus();
  await over.settle();
  const ready = over.steps();
  assert.match(JSON.stringify(ready[0].parts), said(address.ready), 'Tailscale ready: its words');
  assert.deepEqual([buttonOf(ready[0]).label, buttonOf(ready[0]).do], [address.on, { guide: { fix: 'turn-on' } }]);
  assert.deepEqual(over.sent.turns, [], 'ready is not on: only its Turn on turns it on');
  await over.frame.act({ fix: 'turn-on' });
  assert.deepEqual(over.sent.turns, [{ on: true }]);
  const on = over.steps();
  assert.deepEqual(on.map(step => step.mark), ['done', 'here', 'later'], 'Tailscale done, the app’s first step here');
  assert.match(JSON.stringify(on[1].parts), said(DOOR['address-on'].url), 'its address to copy');
});

test('after Open Tailscale, with no coming to the front, the step reads the address every 2 s, one read at a time, until ready; a round turns nothing on and none follows once on', async () => {
  const address = /** @type {NonNullable<Guide['address']>} */ (guideOf('chatgpt').address);
  /** @type {any[]} */
  const reads = [{ ...DOOR['address-fix-mac'], act: { label: 'Open Tailscale', to: 'tailscale', url: null } }, DOOR['address-off'], DOOR['address-on']];
  let read = 0;
  const over = frameOver({ address: async () => {
    read += 1;
    return reads.length > 1 ? reads.shift() : reads[0];
  } });
  over.at({ pages: ['guide:chatgpt'] });
  await over.settle();
  over.at({});
  const fix = over.steps();
  assert.deepEqual(buttonOf(fix[0]).do, { guide: { fix: 'tailscale' } }, 'Open Tailscale');
  await over.frame.act(buttonOf(fix[0]).do.guide);
  assert.deepEqual(over.sent.opened, [{ app: 'Tailscale' }]);
  over.at({});
  over.at({});
  assert.deepEqual(over.sent.later.map(each => each.ms), [FINISHING_MS], 'one round waits its 2 s, however often it draws');
  over.sent.later[0].run();
  await over.settle();
  const ready = over.steps();
  assert.match(JSON.stringify(ready[0].parts), said(address.ready), 'Tailscale ready, by itself');
  assert.deepEqual([buttonOf(ready[0]).label, buttonOf(ready[0]).do], [address.on, { guide: { fix: 'turn-on' } }]);
  assert.deepEqual([read, over.sent.turns], [2, []], 'the round read once and turned nothing on');
  assert.equal(over.sent.later.length, 2, 'ready is not done: the next round waits');
  over.sent.later[1].run();
  await over.settle();
  assert.deepEqual(over.steps().map(step => step.mark), ['done', 'here', 'later'], 'on: the step ticks');
  over.at({});
  assert.deepEqual([read, over.sent.later.length, over.sent.turns], [3, 2, []], 'on: no round follows');
});

test('Nothing yet? shows only once the person is back in front after the copy, never at once', async () => {
  const hint = said(stepOf('chatgpt', 'yes').hint);
  const over = frameOver();
  over.at({ pages: ['guide:chatgpt'] });
  await over.settle();
  over.at({});
  over.focus();
  await over.settle();
  await over.frame.act({ copy: { address: true } });
  assert.match(JSON.stringify(over.detail()), /"Waiting for ChatGPT"/u);
  assert.doesNotMatch(JSON.stringify(over.detail().parts), hint, 'a return before the copy is no return from it');
  over.focus();
  await over.settle();
  assert.match(JSON.stringify(over.detail().parts), hint, 'back after the copy, nothing arrived');
});

test('a copy whose turn-on answers Allow Funnel brings Tailscale in as step 1, whose button turns on and opens Tailscale’s page; back in front never sends it again', async () => {
  /** @type {any[]} */
  const turns = [DOOR['address-fix-turn-on'], DOOR['address-fix-allow']];
  const over = frameOver({ address: async () => DOOR['address-off'], turn: async asked => {
    over.sent.turns.push(asked);
    return turns.shift();
  } });
  over.at({ pages: ['guide:chatgpt'] });
  await over.settle();
  over.at({});
  assert.equal(over.steps().length, 2, 'off on its first read: no Tailscale step');
  await over.frame.act({ copy: { address: true } });
  const allow = over.steps();
  assert.equal(allow[0].title, guideOf('chatgpt').address?.title);
  assert.deepEqual(buttonOf(allow[0]).do, { guide: { fix: 'turn-on' } }, 'Allow Funnel');
  await over.frame.act({ fix: 'turn-on' });
  assert.deepEqual(over.sent.opened, [{ url: DOOR['address-fix-allow'].act.url }]);
  over.focus();
  await over.settle();
  over.focus();
  await over.settle();
  assert.equal(over.sent.turns.length, 2, 'only a press turns it on');
});

test('an address that cannot be read or turned on keeps its words with Check again, never a silent page or a dead Make the key', async () => {
  const words = DOOR['address-person-only'].message;
  const refused = () => Object.assign(new Error(words), { code: 'PERSON_ONLY', status: 403 });
  let fails = true;
  const over = frameOver({ address: async () => {
    if (fails) throw refused();
    return DOOR['address-on'];
  } });
  over.at({ pages: ['guide:chatgpt'] });
  await over.settle();
  over.at({});
  const shown = JSON.stringify(over.detail().parts);
  assert.match(shown, said(words), 'the refusal’s words');
  assert.ok(!shown.includes(GUIDE.getting), 'not Getting your address… for ever');
  assert.match(shown, /"fix":"check"/u, 'Check again');
  fails = false;
  await over.frame.act({ fix: 'check' });
  assert.ok(!JSON.stringify(over.detail().parts).includes(words), 'read again, the words go');

  const key = frameOver({ turn: async () => { throw refused(); } });
  key.at({ pages: ['guide:grok-bot'] });
  await key.settle();
  key.at({});
  await key.frame.act({ make: true });
  const made = key.detail();
  assert.match(JSON.stringify(made.parts), said(words), 'the turn-on’s words');
  assert.equal(made.foot?.end[0].disabled, false, 'Make the key can be pressed again');
  assert.deepEqual(key.sent.keys, [], 'no key without the address');
});

test('a Grok Bot guide whose address needs Tailscale holds Make the key under the Tailscale step, which Turn on ticks', async () => {
  /** @type {any[]} */
  const reads = [DOOR['address-fix-turn-on'], DOOR['address-off']];
  const over = frameOver({ address: async () => reads.length > 1 ? reads.shift() : reads[0] });
  over.at({ pages: ['guide:grok-bot'] });
  await over.settle();
  over.at({});
  assert.deepEqual(over.steps().map(step => step.mark), ['here', 'later', 'later']);
  assert.equal(over.detail().foot?.end[0].disabled, true, 'Make the key waits');
  await over.frame.act({ fix: 'check' });
  assert.deepEqual(buttonOf(over.steps()[0]).do, { guide: { fix: 'turn-on' } }, 'ready: Turn on');
  await over.frame.act({ fix: 'turn-on' });
  assert.deepEqual(over.steps().map(step => step.mark), ['done', 'here', 'later']);
  assert.equal(over.detail().foot?.end[0].disabled, false);
});

test('when the shown sign-in leaves the list the guide reads it before it shows another: a failed read is read again on the next 2 s, then its outcome shows', async () => {
  /** @type {any[]} */
  const answers = [new Error('down'), { state: 'wrong', outcome: null, reader: null, connected: null }];
  const over = frameOver({ signin: async id => {
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return { id, ...next };
  } });
  const first = { ...SIGN_IN, app: 'chatgpt', host: 'chatgpt.com' };
  const second = { ...first, id: 'c2lnbi1pbi0wMDAwMDAwMg', at_ms: first.at_ms + 1 };
  over.at({ pages: ['guide:chatgpt'], state: { agent_requests: [first], agent_asks: [] } });
  await over.settle();
  over.at({});
  assert.equal(over.frame.editing, `signin:${first.id}`);
  over.at({ state: { agent_requests: [second], agent_asks: [] } });
  await over.settle();
  over.at({});
  assert.equal(over.frame.editing, `signin:${first.id}`, 'the departed one stays until it is read');
  assert.deepEqual(over.sent.signins, [first.id]);
  assert.equal(over.sent.later.length, 1, 'a failed read waits its 2 s');
  assert.equal(over.sent.later[0].ms, FINISHING_MS);
  over.sent.later[0].run();
  await over.settle();
  over.at({});
  assert.deepEqual(over.sent.signins, [first.id, first.id]);
  assert.equal(over.frame.editing, `signin:${second.id}`, 'read, the next one shows');
  assert.match(JSON.stringify(over.detail().parts), said(stepOf('chatgpt', 'yes').wrong), 'with the first one’s outcome');
});

test('Another agent’s key on this Mac draws From the internet from the address read while the reply has none, and none without an address', async () => {
  for (const [read, rows] of /** @type {const} */ ([['address-off', 4], ['address-fix-mac', 3]])) {
    const over = frameOver({ address: async () => DOOR[read], key: async asked => {
      over.sent.keys.push(asked);
      return DOOR['keys-another-loopback'];
    } });
    over.at({ pages: ['guide:another'], fields: { [NAME_FIELD]: 'Example tool' } });
    await over.settle();
    over.at({});
    await over.frame.act({ make: true });
    const give = over.steps().at(-1);
    const panel = give.parts.find((/** @type {any} */ part) => part.panel)?.panel;
    assert.equal(panel.rows.length, rows, read);
    if (rows === 3) continue;
    const markup = detailMarkup(over.detail(), AT_REST);
    assert.match(markup, new RegExp(`data-cn-copy="${DOOR['address-off'].url}"[^>]*data-cn-do="[^"]*internet`, 'u'),
      'its Copy sets that reader’s internet address');
  }
});

/**
 * @param {(message: any) => any} answer
 */
function agentsOver(answer) {
  const sent = { acts: /** @type {any[]} */ ([]), edits: /** @type {any[]} */ ([]) };
  const host = /** @type {any} */ ({ state: { agent_requests: [], agent_asks: [] }, follow: () => () => {}, act: async (/** @type {any} */ message) => {
    sent.acts.push(message);
    if (message.act === 'agent-guides') return { answer: GUIDES.mac };
    if (message.act === 'agent-address') return { answer: DOOR['address-on'] };
    return { answer: answer(message) };
  } });
  const frame = agentsFrame({ host, draw: () => {}, holdsHome: () => true, hold: (_, run) => run(), page: null, io: { ...AGENTS_IO,
    edit: async asked => {
      sent.edits.push(asked);
      const access = asked.edit && 'window' in asked.edit ? { ...asked.access, window: asked.edit.window }
        : asked.edit && 'hide' in asked.edit ? { ...asked.access, hide: asked.edit.hide } : asked.access;
      return { access, expect: null, view: SIGN_IN.view };
    } } });
  /** @param {string[]} pages @param {any} state @param {Record<string, string>} [fields] @param {boolean} [shown] */
  const at = (pages, state, fields = {}, shown = true) => frame.follow({ id: shown ? CONNECT_ID : '', state,
    opened: { ...OPENED, pages, fields }, shown, zone: 'UTC' });
  const detail = (/** @type {string[]} */ pages, /** @type {any} */ state, fields = {}) => frame.detail({ id: CONNECT_ID, state,
    opened: { ...OPENED, pages, fields }, home: true, now: 0 });
  return { frame, sent, at, detail, settle: () => new Promise(done => setImmediate(done)) };
}

test('Edit’s child pages work inside a key guide: Since is drawn, sets the draft’s window, and the key carries it', async () => {
  const over = agentsOver(message => message.act === 'agent-key' ? DOOR['keys-grok-bot'] : null);
  const state = { agent_requests: [], agent_asks: [] };
  over.at(['guide:grok-bot'], state);
  await over.settle();
  over.at(['guide:grok-bot'], state);
  const since = over.detail(['guide:grok-bot', 'access', 'since:all'], state, { [SINCE_FIELD]: '2026-11-01' });
  assert.match(JSON.stringify(since.parts), new RegExp(`"key":"${SINCE_FIELD}"`, 'u'), 'the Since page, not the guide');
  over.at(['guide:grok-bot', 'access', 'since:all'], state, { [SINCE_FIELD]: '2026-11-01' });
  assert.equal(await over.frame.act({ since: 'all' }), 'back');
  const window = { since_ms: Date.UTC(2026, 10, 1) };
  assert.deepEqual(over.sent.edits.at(-1)?.edit, { window }, 'the draft’s edit');
  over.at(['guide:grok-bot'], state);
  await over.frame.act({ guide: { make: true } });
  const key = over.sent.acts.find(each => each.act === 'agent-key');
  assert.deepEqual(key?.access.window, window, 'the key made with the window set');
  const hides = over.detail(['guide:grok-bot', 'access', 'hides'], state);
  assert.notEqual(hides.name, guideOf('grok-bot').head, 'custom hiding is its own page');
});

test('a closed guide forgets the access edited for its sign-in: reopened, the yes sends the sign-in’s own', async () => {
  const over = agentsOver(() => null);
  const ask = { ...SIGN_IN, app: 'chatgpt', host: 'chatgpt.com' };
  const state = { agent_requests: [ask], agent_asks: [] };
  over.at(['guide:chatgpt'], state);
  await over.settle();
  over.at(['guide:chatgpt'], state);
  await over.settle();
  over.at(['guide:chatgpt', 'access'], state);
  await over.frame.act({ edit: { hide: 'everything' } });
  const since = over.detail(['guide:chatgpt', 'access', 'since:all'], state, { [SINCE_FIELD]: '2026-11-01' });
  assert.match(JSON.stringify(since.parts), new RegExp(`"key":"${SINCE_FIELD}"`, 'u'), 'Since inside the sign-in’s Edit');
  over.at(['guide:chatgpt', 'access', 'since:all'], state, { [SINCE_FIELD]: '2026-11-01' });
  assert.equal(await over.frame.act({ since: 'all' }), 'back');
  assert.deepEqual(over.sent.edits.at(-1)?.edit, { window: { since_ms: Date.UTC(2026, 10, 1) } }, 'the sign-in’s draft took it');
  over.at(['guide:chatgpt', 'access'], state);
  await over.frame.act({ editor: 'done' });
  assert.equal(drafts.of(ask.id)?.access.hide, 'everything', 'Done keeps the draft for the yes');
  over.at([], state, {}, false);
  assert.equal(drafts.of(ask.id), null, 'closed, the draft is dropped');
  over.at(['guide:chatgpt'], state);
  await over.settle();
  over.at(['guide:chatgpt'], state);
  await over.settle();
  const shown = JSON.stringify(over.detail(['guide:chatgpt'], state));
  const pick = JSON.parse(shown).parts.find((/** @type {any} */ part) => part.steps).steps[1].parts
    .find((/** @type {any} */ part) => part.pick).pick.choices[0].do.answer;
  assert.deepEqual(pick.access ?? ask.access, ask.access, 'the yes carries the sign-in’s own access');
});

test('a key: the address on first, then the key with the draft shown; 409 shows the fix; a lost reply says so and makes again', async () => {
  /** @type {any[]} */
  const keys = [Object.assign(new Error(DOOR['keys-not-ready'].message), { code: 'ADDRESS_NOT_READY', status: 409 }),
    Object.assign(new Error('Not sure'), { code: 'OUTCOME_UNKNOWN', status: 503 }), DOOR['keys-grok-bot']];
  const over = frameOver({ key: async asked => {
    over.sent.keys.push(asked);
    const next = keys.shift();
    if (next instanceof Error) throw next;
    return next;
  } });
  over.at({ pages: ['guide:grok-bot'] });
  await over.settle();
  over.at({});
  const sees = /** @type {any} */ (guideOf('grok-bot').steps.find(step => step.kind === 'sees'));
  await over.frame.act({ make: true });
  assert.deepEqual(over.sent.turns, [{ on: true }]);
  assert.deepEqual(over.sent.keys, [{ app: 'grok-bot', access: sees.access }], 'no name for an app the catalog names');
  await over.frame.act({ make: true });
  assert.match(JSON.stringify(over.detail().foot), said(stepOf('grok-bot', 'give').unknown), 'the page’s lost-key line');
  await over.frame.act({ make: true });
  const made = JSON.stringify(over.detail());
  for (const row of DOOR['keys-grok-bot'].rows) assert.ok(made.includes(row.text), `the ${row.label} row`);
  await over.frame.act({ done: true });
  assert.equal(over.detail().name, guideOf('grok-bot').done.title, 'Done moves to Connected');
  assert.equal(await over.frame.act({ done: true }), 'close');
});

test('Another agent’s key needs no internet address: the name typed is its body, and Done closes onto its row', async () => {
  const over = frameOver({ address: async () => DOOR['address-fix-mac'], key: async asked => {
    over.sent.keys.push(asked);
    return DOOR['keys-another'];
  } });
  over.at({ pages: ['guide:another'] });
  await over.settle();
  over.at({ fields: { [NAME_FIELD]: 'Example tool' } });
  const before = over.detail();
  assert.ok(!JSON.stringify(before.parts).includes(DOOR['address-fix-mac'].words), 'no Tailscale fix for a key on this Mac');
  assert.equal(before.foot?.end[0].disabled, false, 'Make the key is ready');
  over.at({ pages: ['guide:another', 'access'], fields: {} });
  over.at({ pages: ['guide:another'] });
  await over.frame.act({ make: true });
  assert.deepEqual(over.sent.turns, [], 'the address is not turned on');
  assert.equal(over.sent.keys[0].name, 'Example tool', 'the name outlives a visit to Edit');
  const internet = DOOR['keys-another'].rows.find((/** @type {any} */ row) => row.text.startsWith('https://'));
  const markup = detailMarkup(over.detail(), AT_REST);
  assert.match(markup, new RegExp(`data-cn-copy="${internet.text}"[^>]*data-cn-do="[^"]*internet`, 'u'),
    'From the internet’s Copy sets that reader’s internet address');
  assert.equal(await over.frame.act({ done: true }), 'close');
});

test('every line a sign-in state shows is the page’s: It will see, a wrong number, another host’s sign-in, the request ended', async () => {
  const yes = stepOf('chatgpt', 'yes');
  const over = frameOver({ signin: async id => ({ ...DOOR['signin-gone'], id }) });
  const ask = { ...SIGN_IN, app: 'chatgpt', host: 'chatgpt.com' };
  over.at({ pages: ['guide:chatgpt'], state: { agent_requests: [ask], agent_asks: [] } });
  await over.settle();
  over.at({});
  assert.match(JSON.stringify(over.detail().parts), said(yes.sees), 'It will see over the yes');
  over.frame.answered(ask.id, { state: 'wrong', version: null, outcome: null, reader: null, connected: null });
  const stranger = { ...SIGN_IN, id: 'c2lnbi1pbi0wMDAwMDAwMg', app: null, host: 'agent.example', name: 'agent.example' };
  over.at({ state: { agent_requests: [stranger], agent_asks: [] } });
  const wrong = JSON.stringify(over.detail().parts);
  assert.match(wrong, said(yes.wrong), 'the page’s wrong number');
  assert.match(wrong, said(yes.other.replace('{host}', 'agent.example')), 'another host’s sign-in, its host filled in');
  assert.ok(!wrong.includes('{host}'), 'no slot is shown');

  const ended = frameOver({ signin: async id => ({ ...DOOR['signin-gone'], id }) });
  ended.at({ pages: ['guide:chatgpt'], state: { agent_requests: [ask], agent_asks: [] } });
  await ended.settle();
  ended.at({});
  ended.at({ state: { agent_requests: [], agent_asks: [] } });
  await ended.settle();
  assert.match(JSON.stringify(ended.detail().parts), said(yes.out), 'a sign-in the home holds no longer reads gone: the request ended');
});

test('an approved sign-in that reads gone before its reader did not finish; a denied one is Not allowed, both the page’s', async () => {
  const yes = stepOf('claude', 'yes');
  /** @type {any[]} */
  const answers = [DOOR['signin-finishing'], DOOR['signin-gone']];
  const over = frameOver({ signin: async id => ({ ...answers.shift(), id }) });
  const ask = { ...SIGN_IN, app: 'claude', host: 'claude.ai' };
  over.at({ pages: ['guide:claude'], state: { agent_requests: [ask], agent_asks: [] } });
  await over.settle();
  over.at({});
  over.at({ state: { agent_requests: [], agent_asks: [] } });
  await over.settle();
  assert.match(JSON.stringify(over.detail().parts), said(yes.finishing));
  over.sent.later[0].run();
  await over.settle();
  assert.match(JSON.stringify(over.detail().parts), said(yes.unfinished), 'the page’s did not finish');

  const denied = frameOver();
  denied.at({ pages: ['guide:claude'], state: { agent_requests: [ask], agent_asks: [] } });
  await denied.settle();
  denied.at({});
  denied.frame.answered(ask.id, { state: 'denied', version: null, outcome: null, reader: null, connected: null });
  denied.at({ state: { agent_requests: [], agent_asks: [] } });
  assert.match(JSON.stringify(denied.detail().parts), said(yes.denied), 'the page’s Not allowed');
});

test('the connected answer reply lands the guide on Connected with its reader’s line, with no read after it', async () => {
  const over = frameOver();
  const ask = { ...SIGN_IN, app: 'claude', host: 'claude.ai' };
  over.at({ pages: ['guide:claude'], state: { agent_requests: [ask], agent_asks: [] } });
  await over.settle();
  over.at({});
  over.frame.answered(ask.id, DOOR['answer-connected']);
  over.at({ state: { agent_requests: [], agent_asks: [] } });
  await over.settle();
  const done = over.detail();
  assert.equal(done.name, guideOf('claude').done.title);
  assert.equal(done.line, DOOR['answer-connected'].connected.line);
  assert.match(JSON.stringify(done.parts), said(stepOf('claude', 'yes').reads), 'step 2 says the page’s can read your Lifestream');
  assert.deepEqual(over.sent.signins, [], 'a reply with its reader needs no read');
});

test('From the internet’s Copy sends the address on with that reader, and the answer is the home’s', async () => {
  const over = frameOver({ address: async () => DOOR['address-off'], key: async asked => {
    over.sent.keys.push(asked);
    return DOOR['keys-another'];
  } });
  over.at({ pages: ['guide:another'], fields: { [NAME_FIELD]: 'Example tool' } });
  await over.settle();
  over.at({});
  await over.frame.act({ make: true });
  await over.frame.act({ internet: DOOR['keys-another'].reader });
  assert.deepEqual(over.sent.turns, [{ on: true, reader: DOOR['keys-another'].reader }], 'one POST, naming the key’s reader');
  assert.equal(await over.frame.act({ done: true }), 'close', 'Done still closes onto its row');
});
