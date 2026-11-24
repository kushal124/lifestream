import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createViewer } from '../server.mjs';
import { openChrome } from '../tools/chrome.mjs';
import { HOST_STATE } from '../public/kit-gallery-report.js';
import { signInCard } from '../public/ui/agents/cards.js';
import { phraseWords } from '../public/lib/words.js';
import { ASKED, SIGNING } from '../public/ui/agents/words.js';
import { agentsList } from '../public/ui/agents/list.js';
import { bodyMarkup } from '../public/pages/agents.js';
import { hostScript } from './stand-ins/onboarding-home.mjs';
import HOST_APPROVED from '../../homelink/Tests/Fixtures/agents-host/answer-sign-in.json' with { type: 'json' };
import HOST_DENIED from '../../homelink/Tests/Fixtures/agents-host/answer-sign-in-deny.json' with { type: 'json' };
import HOST_WRONG from '../../homelink/Tests/Fixtures/agents-host/answer-sign-in-wrong.json' with { type: 'json' };
import WAITING from '../../homelink/Tests/Fixtures/agents-host/waiting.json' with { type: 'json' };
import WAITING_SIGN_IN from '../../homelink/Tests/Fixtures/agents-host/waiting-sign-in.json' with { type: 'json' };
import LIST from '../../homelink/Tests/Fixtures/agents/door/list.json' with { type: 'json' };
import LIST_DISCONNECTED from '../../homelink/Tests/Fixtures/agents/door/list-disconnected.json' with { type: 'json' };
import GUIDES from '../../homelink/Tests/Fixtures/pages/agentGuides.mac.json' with { type: 'json' };

/** @typedef {import('../public/types.js').SignIn} HostAgentRequest */
/** @typedef {import('../public/lib/host.js').HostState} HostState */
/** @param {import('../public/types.js').Phrase} phrase */
const leadOf = phrase => phrase.flatMap(part => (part.kind === 'words' ? [part.words] : [])).slice(0, 1).join('');
/** @typedef {import('../public/ui/connectors/dialog.js').Detail} Detail */

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.build', 'e2e', 'agents');
const UNTIL = Date.UTC(2026, 9, 28, 12, 5);
const SIGNED = /** @type {HostAgentRequest} */ (/** @type {unknown} */ (WAITING_SIGN_IN.state.agent_requests[0]));
const READS = { sentence: SIGNED.sentence, access: SIGNED.access, view: SIGNED.view, at_ms: UNTIL - 300_000 };
/**
 * @param {string} name
 * @param {string} over
 * @returns {Pick<HostAgentRequest, 'head' | 'over_line' | 'pick' | 'pick_line' | 'over' | 'app' | 'notice'>}
 */
const linesOf = (name, over) => ({ head: `${name} wants to read your Lifestream`,
  over_line: [{ kind: 'words', words: `Signing in from ${over} ·` }, { kind: 'time', time: { kind: 'clock', at_ms: UNTIL - 300_000 } }],
  pick: `Pick the number ${name} shows`, pick_line: `Picking it is the yes. The wrong number turns ${name} away.`,
  over: `This sign-in is over. Start it again in ${over}.`, app: null,
  notice: `${name} wants to read your Lifestream. Pick the number it shows.` });
/** @type {HostAgentRequest} */
const CHECKED = { id: 'request-a', name: 'Claude', checked: true, host: 'claude.example.com', choices: [47, 12, 83],
  until_ms: UNTIL, ...linesOf('Claude', 'claude.example.com'), ...READS };
/** @type {HostAgentRequest} */
const NAMED = { id: 'request-b', name: 'Some <b>App</b>', checked: false, host: 'app.example.net', choices: [31, 64, 19],
  until_ms: UNTIL, ...linesOf('Some <b>App</b>', 'app.example.net'), ...READS };
/** @type {HostAgentRequest} */
const LOCAL = { id: 'request-c', name: 'Claude Code', checked: false, host: null, choices: [58, 26, 74], until_ms: UNTIL,
  ...linesOf('Claude Code', 'Claude Code'), ...READS };
const APPROVED = HOST_APPROVED.reply;
const DENIED = HOST_DENIED.reply;
const WRONG = HOST_WRONG.reply;

/** @param {Partial<HostState>} more @returns {HostState} */
const stateWith = more => ({ ...HOST_STATE, ...more });
const READERS = /** @type {import('../public/types.js').AgentRow[]} */ (LIST.answer.readers);
const ASKS = /** @type {import('../public/types.js').AgentAsk[]} */ (WAITING.state.agent_asks);
/** @param {string} markup */
const words = markup => markup.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim();

test('A1: the card in the home’s words, what it will see, its three numbers and Don’t allow, names and hosts as text', () => {
  const card = signInCard(NAMED, { view: NAMED.view, count: ASKED.asks(3), busy: null, refused: '' });
  assert.doesNotMatch(card, /<b>App/u, 'a name is text');
  assert.match(card, /Some &lt;b&gt;App&lt;\/b&gt; wants to read your Lifestream/u);
  assert.match(card, /Pick the number Some &lt;b&gt;App&lt;\/b&gt; shows/u);
  assert.ok(card.includes(phraseWords(NAMED.over_line)), 'the head’s line, the home’s');
  assert.ok(card.includes(NAMED.pick_line.replace('<b>', '&lt;b&gt;').replace('</b>', '&lt;/b&gt;')), 'the line under the numbers, the home’s');
  assert.deepEqual([...card.matchAll(/data-agent-pick="([^"]+)"/gu)].map(each => JSON.parse(each[1].replaceAll('&quot;', '"')).answer),
    [31, 64, 19, 'deny']);
  assert.ok(words(card).includes(SIGNING.deny));
  assert.ok(words(card).includes(SIGNING.only));
  assert.ok(words(card).includes('1 of 3 asks'));
  assert.ok(words(card).includes(NAMED.view.reads), 'what it will see, from the home’s view');
  assert.ok(!words(signInCard(CHECKED, { view: CHECKED.view, count: '', busy: null, refused: '' })).includes(' of '), 'none more, nothing said');
  assert.ok(signInCard(LOCAL, { view: LOCAL.view, count: '', busy: null, refused: '' }).includes(phraseWords(LOCAL.over_line)));
});

test('A2: a pick in flight holds every button of the card, the one pressed busy', () => {
  const card = signInCard(CHECKED, { view: CHECKED.view, count: '', busy: 12, refused: '' });
  const buttons = [...card.matchAll(/<button[^>]*>/gu)].map(each => each[0]);
  assert.equal(buttons.length, 5, 'Edit, the three numbers and Don’t allow');
  assert.ok(buttons.every(button => /\sdisabled/u.test(button)), 'every button held');
  assert.equal(buttons.filter(button => /is-busy|aria-busy="true"/u.test(button)).length, 1, 'the one pressed busy');
  assert.match(buttons.find(button => /is-busy|aria-busy="true"/u.test(button)) ?? '', /data-agent-pick="[^"]*12/u);
});

test('A5, A6: the Agents page from the readers and the host: Needs you, Connected, In Lifestream, Disconnected; nothing connected, the home’s apps', () => {
  const list = agentsList({ readers: READERS, state: stateWith({ agent_asks: ASKS }) });
  const named = READERS.filter(each => each.kind !== 'chat');
  assert.deepEqual(list.sections.map(section => [section.name, section.count]), [['Needs you', ASKS.length],
    ['Connected', named.length], ['In Lifestream', 1]]);
  const needs = list.sections[0].rows;
  assert.deepEqual(needs.map(row => [row.name, row.line, row.review, row.opens, row.when]),
    ASKS.map(ask => [ask.name, ask.line, `ask:${ask.id}`, `agent:${ask.reader}`, '']), 'each ask in the home’s words, Review opens the ask');
  assert.deepEqual(list.sections[1].rows.map(row => [row.name, row.line, row.place, row.when, row.review, row.dim]),
    named.map(each => [each.name, each.summary, each.place, each.reads.last ?? '', '', false]),
    'the list draws the home’s summary, place and last read, and computes no words');
  assert.deepEqual(list.sections[2].rows.map(row => [row.name, row.place]), [['Chat', 'Lifestream']]);
  assert.equal(list.adds, true);
  assert.equal(agentsList({ readers: READERS, state: null, guides: /** @type {any} */ (GUIDES) }).guides, null,
    'agents connected: no list of apps in the page');
  assert.equal(list.sections[1].rows.every(row => row.icon === READERS.find(each => each.id === row.id)?.mark), true,
    'each row leads with the home’s mark');

  const browser = agentsList({ readers: READERS, state: null });
  assert.deepEqual([browser.adds, browser.guides], [true, null]);
  const asking = agentsList({ readers: READERS, state: stateWith({ agent_asks: [] }) });
  assert.deepEqual(asking.sections.map(section => section.name), ['Connected', 'In Lifestream'], 'the host’s asks are the asks');
  assert.deepEqual(browser.sections[0].rows.map(row => [row.name, row.line, row.review]),
    READERS.filter(each => each.has_ask && each.kind !== 'chat').map(each => [each.name, 'Asking', `agent:${each.id}`]),
    'no host: the readers that say they ask');

  const gone = agentsList({ readers: /** @type {import('../public/types.js').AgentRow[]} */ (LIST_DISCONNECTED.answer.readers), state: null });
  const disconnected = gone.sections.find(section => section.name === 'Disconnected');
  assert.ok(disconnected, 'a disconnected agent under Disconnected');
  assert.ok(disconnected.rows.every(row => row.dim && row.when === '' && !row.review), 'dimmed, no time, no Review');
  assert.equal(gone.sections.at(-1), disconnected, 'Disconnected comes last');

  const empty = agentsList({ readers: READERS.filter(each => each.kind === 'chat'), state: HOST_STATE, guides: /** @type {any} */ (GUIDES) });
  assert.equal(empty.adds, false);
  assert.deepEqual(empty.guides?.rows.map(row => [row.name, row.mark, row.line, row.connected, row.opens]),
    GUIDES.apps.map(guide => [guide.name, guide.mark, guide.line ?? '', guide.connected !== null,
      guide.connected ? `agent:${guide.connected}` : `agents:connect/guide:${guide.app}`]),
    'the home’s six apps in its order, a connected one opening its reader');
  assert.equal(empty.guides?.title, GUIDES.title);
  assert.equal(agentsList({ readers: READERS.filter(each => each.kind === 'chat'), state: HOST_STATE }).guides, null,
    'the apps not read yet: none drawn');
});

const seen = { shots: /** @type {string[]} */ ([]), acts: /** @type {unknown[]} */ ([]), said: /** @type {Record<string, unknown>} */ ({}) };
let dir = '';
/** @type {import('node:http').Server | undefined} */
let viewer;
/** @type {Awaited<ReturnType<typeof openChrome>> | undefined} */
let chrome;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dashboard-agents-'));
  const served = await createViewer();
  viewer = served;
  await new Promise(done => served.listen(0, '127.0.0.1', () => done(undefined)));
  const origin = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (served.address()).port}`;
  chrome = await openChrome({ profile: join(dir, 'chrome'), origin });
  await chrome.size(1180, 860, 1);
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
});

after(async () => {
  await writeFile(join(OUT, 'agents.json'), `${JSON.stringify({ ...seen, waiting: chrome?.waiting ?? '' }, null, 2)}\n`)
    .catch(() => undefined);
  await chrome?.close();
  if (viewer) {
    const served = viewer;
    served.closeAllConnections();
    await new Promise(done => served.close(() => done(undefined)));
  }
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('A2–A8 in the window: the card over Streams, each pick sent, the card over Connect an agent, no look sent', async () => {
  const page = /** @type {NonNullable<typeof chrome>} */ (chrome);
  /** @param {unknown} state */
  const setState = state => page.evaluate(`window.setHostState(${JSON.stringify(state)})`);
  /** @returns {Promise<any[]>} */
  const acts = async () => {
    const posted = await page.evaluate('window.hostActs.splice(0)');
    seen.acts.push(...posted);
    return posted.map((/** @type {any} */ { type: _, ...act }) => act);
  };
  /** @param {string} selector @returns {Promise<string[]>} */
  const text = selector => page.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})]
    .map(each => each.textContent.trim().replace(/\\s+/g, ' '))`);
  /** @param {string} selector */
  const click = selector => page.evaluate(`(() => { const found = document.querySelectorAll(${JSON.stringify(selector)});
    if (found.length !== 1) throw new Error(${JSON.stringify(selector)} + ' names ' + found.length); found[0].click(); })()`);
  /** @param {string} name */
  const shot = async name => {
    await page.shoot(join(OUT, `${name}.png`));
    seen.shots.push(name);
  };
  const CARD = `document.querySelector('#agent-layer .ck-agent')`;
  const LAYER_HIDDEN = `document.querySelector('#agent-layer')?.hidden === true`;
  /**
   * @param {string} id
   * @param {number | 'deny'} answer
   */
  const pick = (id, answer) => `#agent-layer [data-agent-pick='${JSON.stringify({ id, answer })}']`;
  const waiting = { ...HOST_STATE, agent_requests: [CHECKED, NAMED] };
  /**
   * @param {{ answer: { outcome: import('../public/types.js').Phrase | null } }} reply
   * @param {string} [name]
   */
  const answered = async (reply, name) => {
    const { outcome } = reply.answer;
    if (outcome) {
      await page.until(`${CARD}?.textContent.includes(${JSON.stringify(leadOf(outcome))})`);
      if (name) {
        seen.said.notice = await text('#agent-layer .ck-agent');
        await shot(name);
      }
      await click('#agent-layer [data-agent-ok]');
    }
    await page.until(LAYER_HIDDEN);
  };

  await page.load('#view=connectors', hostScript(waiting));
  await page.until(`${CARD}?.textContent.includes('Claude wants to read your Lifestream')`);
  const [title, line] = await text('#agent-layer .ck-agent__title, #agent-layer .ck-agent__line');
  assert.equal(title, 'Claude wants to read your Lifestream');
  assert.match(line, /^Signing in from claude\.example\.com · (?:\d{1,2} [A-Z][a-z]{2} (?:\d{4} )?)?\d\d:\d\d$/u, 'the home’s words, its time worded by the app');
  assert.ok((await text('#agent-layer .ck-ssection__heading')).includes(CHECKED.pick), 'the pick’s title, the home’s');
  assert.deepEqual(await text('#agent-layer .ck-picks__n'), ['47', '12', '83']);
  assert.deepEqual(await text('#agent-layer .ck-agent__count'), [ASKED.asks(2)]);
  await shot('card-over-streams');

  await page.evaluate(`window.hostAnswers['agent-answer'] = ${JSON.stringify(APPROVED)}; window.hostHolds['agent-answer'] = true`);
  await click(pick(CHECKED.id, 12));
  await page.until(`[...document.querySelectorAll('#agent-layer button')].every(button => button.disabled)`);
  await click(pick(CHECKED.id, 47)).catch(() => undefined);
  assert.deepEqual(await acts(), [{ act: 'agent-answer', id: 'request-a', answer: 12 }], 'one pick sent, the held one not');
  await page.evaluate(`window.hostHolds = {}; window.hostRelease()`);
  await page.until(`[...document.querySelectorAll('#agent-layer button')].every(button => !button.disabled)`);

  await setState({ ...waiting, agent_requests: [NAMED] });
  await page.until(`${CARD}?.textContent.includes(${JSON.stringify(leadOf(NAMED.over_line))})`);
  assert.deepEqual(await text('#agent-layer .ck-agent__title'), ['Some <b>App</b> wants to read your Lifestream']);
  assert.equal(await page.evaluate(`document.querySelector('#agent-layer b')`), null);
  assert.deepEqual(await text('#agent-layer .ck-agent__count'), [], 'none more, no count');
  await page.evaluate(`window.hostReplies['agent-answer'] = 'Couldn’t reach Lifestream.'`);
  await click(pick(NAMED.id, 64));
  await page.until(`${CARD}?.querySelector('.ck-afoot__said')?.textContent.includes('Couldn’t reach Lifestream')`);
  assert.deepEqual(await acts(), [{ act: 'agent-answer', id: 'request-b', answer: 64 }]);
  await shot('card-refused');
  await page.evaluate(`window.hostReplies = {}; window.hostAnswers['agent-answer'] = ${JSON.stringify(DENIED)}`);
  await click(pick(NAMED.id, 'deny'));
  assert.deepEqual(await acts(), [{ act: 'agent-answer', id: 'request-b', answer: 'deny' }]);
  await setState({ ...waiting, agent_requests: [] });
  await answered(DENIED);

  await setState({ ...waiting, agent_requests: [CHECKED] });
  await page.until(`${CARD}?.textContent.includes(${JSON.stringify(leadOf(CHECKED.over_line))})`);
  await page.evaluate(`window.hostAnswers['agent-answer'] = ${JSON.stringify(WRONG)}; window.hostHolds['agent-answer'] = true`);
  await click(pick(CHECKED.id, 83));
  await setState({ ...waiting, agent_requests: [] });
  await page.evaluate(`window.hostHolds = {}; window.hostRelease()`);
  await answered(WRONG, 'card-wrong-number');
  assert.deepEqual(await acts(), [{ act: 'agent-answer', id: 'request-a', answer: 83 }]);
  await page.evaluate(`window.hostAnswers = {}`);

  const ELSEWHERE = { id: NAMED.id, state: 'approved', outcome: [{ kind: 'words', words: 'Allowed on iPhone,' }, { kind: 'time', time: { kind: 'clock', at_ms: UNTIL - 240_000 } }],
    reader: null, connected: null };
  const GONE = { id: LOCAL.id, state: 'gone', outcome: null, reader: null, connected: null };
  await page.evaluate(`window.signInRead = { status: 200, body: ${JSON.stringify(ELSEWHERE)} }; window.signInsRead = [];
    (() => { const plain = window.fetch; window.fetch = (url, init) => {
      if (!String(url).startsWith('api/agents/signin?')) return plain(url, init);
      window.signInsRead.push(String(url));
      return Promise.resolve(new Response(JSON.stringify(window.signInRead.body), { status: window.signInRead.status, headers: { 'Content-Type': 'application/json' } }));
    }; })()`);
  await setState({ ...waiting, agent_requests: [NAMED] });
  await page.until(`${CARD}?.textContent.includes(${JSON.stringify(leadOf(NAMED.over_line))})`);
  await setState({ ...waiting, agent_requests: [] });
  await page.until(`${CARD}?.textContent.includes(${JSON.stringify(leadOf(/** @type {import('../public/types.js').Phrase} */ (ELSEWHERE.outcome)))})`);
  assert.deepEqual(await page.evaluate('window.signInsRead.splice(0)'), [`api/agents/signin?id=${NAMED.id}`], 'a sign-in that left unanswered here is read once');
  await shot('card-answered-elsewhere');
  await click('#agent-layer [data-agent-ok]');
  await page.until(LAYER_HIDDEN);
  await page.evaluate(`window.signInRead = { status: 200, body: ${JSON.stringify(GONE)} }`);
  await setState({ ...waiting, agent_requests: [LOCAL] });
  await page.until(`${CARD}?.textContent.includes(${JSON.stringify(leadOf(LOCAL.over_line))})`);
  await setState({ ...waiting, agent_requests: [] });
  await page.until(`${CARD}?.textContent.includes(${JSON.stringify(LOCAL.over)})`);
  assert.deepEqual(await acts(), [], 'nothing answered: the home said it is over, by its clock, in the words it served with the sign-in');
  await click('#agent-layer [data-agent-ok]');
  await page.until(LAYER_HIDDEN);

  await page.load('#view=agents&dialog=agents%3Aconnect', hostScript({ ...HOST_STATE, agent_requests: [] }));
  await page.until(`Boolean(document.querySelector('.ck-dialog [data-cn-close]')) && window.hostActs.some(act => act.act === 'agent-guides')`,
    'the dialog, its guides asked of the Mac');
  assert.deepEqual(await acts(), [{ act: 'agent-guides' }], 'the guides read through the Mac’s own pass, and nothing else sent');
  await shot('agents-connect');
  await setState({ ...HOST_STATE, agent_requests: [LOCAL] });
  await page.until(`${CARD}?.textContent.includes(${JSON.stringify(leadOf(LOCAL.over_line))})`);
  assert.ok(await page.evaluate(`(() => { const box = ${CARD}.querySelector('.ck-picks__n').getBoundingClientRect();
    return Boolean(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('#agent-layer')); })()`),
  'the card on top, over the dialog');
  await shot('card-over-dialog');
  await page.evaluate(`window.hostAnswers['agent-answer'] = ${JSON.stringify(APPROVED)}`);
  await click(pick(LOCAL.id, 58));
  assert.deepEqual(await acts(), [{ act: 'agent-answer', id: 'request-c', answer: 58 }]);
  await setState({ ...HOST_STATE, agent_requests: [] });
  await answered(APPROVED);
  assert.ok(await page.evaluate(`Boolean(document.querySelector('.ck-dialog'))`), 'the dialog under it stays');

  await page.load('#view=connectors', '');
  await page.until(`document.querySelector('#agent-layer') && document.querySelector('.cn-side, [data-cn-side], aside')`);
  assert.equal(await page.evaluate(LAYER_HIDDEN), true);
  assert.deepEqual(page.thrown.filter(each => /agent/iu.test(each)), []);
});
