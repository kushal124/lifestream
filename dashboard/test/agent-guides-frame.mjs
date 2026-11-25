// @ts-check
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createViewer } from '../server.mjs';
import { openDoor } from '../lib/door.mjs';
import { openChrome } from '../tools/chrome.mjs';
import { HOST_STATE, REPORT } from '../public/kit-gallery-report.js';
import { STORAGE_YEAR } from '../public/kit-gallery-settings.js';
import { hostScript } from './stand-ins/onboarding-home.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '..', '.build', 'e2e', 'agent-guides-frame');
const FIXTURES = resolve(HERE, '..', '..', 'homelink', 'Tests', 'Fixtures');
/** @param {string} path @returns {any} */
const json = path => JSON.parse(readFileSync(join(FIXTURES, path), 'utf8'));
/** @param {string} folder @returns {Record<string, any>} */
const filesOf = folder => Object.fromEntries(readdirSync(join(FIXTURES, folder)).filter(name => name.endsWith('.json'))
  .map(name => [name.slice(0, -'.json'.length), json(join(folder, name))]));
const DOOR = filesOf('agents/door');
const GUIDE_DOOR = filesOf('agents/guide-door');
const HOST = filesOf('agents-host');
const GUIDES = json('pages/agentGuides.mac.json');
const LIST = DOOR.list.answer;
const EMPTY = { ...LIST, readers: LIST.readers.filter((/** @type {any} */ each) => each.kind === 'chat') };
const STATE = { ...HOST_STATE, setup: { state: 'done', error: null } };
const SIGN_IN = { ...HOST['waiting-sign-in'].state.agent_requests[0], app: 'chatgpt', host: 'chatgpt.com' };
/** @param {string} id @param {string} file */
const signInRead = (id, file) => ({ status: 200, answer: { ...GUIDE_DOOR[file].answer, id } });

const home = {
  address: /** @type {any} */ (GUIDE_DOOR['address-off']),
  /** @type {any} */
  signin: signInRead(SIGN_IN.id, 'signin-connected'),
  key: /** @type {any} */ (GUIDE_DOOR['keys-grok-bot']),
  list: /** @type {any} */ (EMPTY),
};
const seen = { shots: /** @type {string[]} */ ([]), door: /** @type {{ method: string, path: string, body: any, pass: string }[]} */ ([]),
  overflows: /** @type {unknown[]} */ ([]) };
const MAC_PASS = 'Bearer mac-pass-0001';
const PERSON_ONLY = /^\/v1\/agents\/(guides|address|keys|waiting|answer|signins\/.+)$/u;
const MAC_ACTS = ['agent-guides', 'agent-address', 'agent-key', 'agent-signin'];
const MAC = `(() => {
  const asked = new Map();
  let next = 0;
  const handler = window.webkit.messageHandlers.lifestream;
  const sent = handler.postMessage;
  window.homeAnswered = (id, reply) => {
    asked.get(id)?.(reply);
    asked.delete(id);
  };
  handler.postMessage = message => ${JSON.stringify(MAC_ACTS)}.includes(message.act) ? new Promise(done => {
    next += 1;
    asked.set(next, done);
    window.homeAsk(JSON.stringify({ id: next, message }));
  }) : sent(message);
})();`;
/** @param {unknown} state */
const macHost = state => hostScript(state) + MAC;

/**
 * @param {any} message
 * @returns {[string, string, unknown]}
 */
function doorAsk(message) {
  const { type, act, label, ...body } = message;
  if (act === 'agent-guides') return ['GET', '/v1/agents/guides', null];
  if (act === 'agent-signin') return ['GET', `/v1/agents/signins/${body.id}`, null];
  if (act === 'agent-key') return ['POST', '/v1/agents/keys', body];
  return 'on' in body ? ['POST', '/v1/agents/address', body] : ['GET', '/v1/agents/address', null];
}
let dir = '';
/** @type {import('node:http').Server[]} */
const servers = [];
/** @type {Awaited<ReturnType<typeof openChrome>> | undefined} */
let chrome;

/**
 * @param {string} method
 * @param {URL} url
 * @param {any} body
 * @returns {{ status: number, answer: unknown } | null}
 */
function answerOf(method, url, body) {
  const path = url.pathname;
  if (method === 'GET' && path === '/v1/agents') return { status: 200, answer: home.list };
  if (method === 'GET' && path === '/v1/agents/guides') return { status: 200, answer: GUIDES };
  if (method === 'GET' && path === '/v1/agents/address') return home.address;
  if (method === 'POST' && path === '/v1/agents/address') return body?.on === true ? GUIDE_DOOR['address-on'] : GUIDE_DOOR['address-bad'];
  if (method === 'POST' && path === '/v1/agents/keys') return home.key;
  if (method === 'GET' && path.startsWith('/v1/agents/signins/')) return home.signin;
  if (method === 'POST' && path === '/v1/agents/edit') {
    return { status: 200, answer: { access: body.access, expect: body.expect, view: DOOR['edit-hide'].answer.view, narrowed: null, saved: null } };
  }
  return null;
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dashboard-agent-guides-'));
  const door = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const url = new URL(request.url ?? '/', 'http://door');
    const body = text ? JSON.parse(text) : null;
    if (url.pathname === '/v1/storage') return void response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(STORAGE_YEAR));
    if (url.pathname === '/v1/connectors') return void response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ position: '1:0', ...REPORT }));
    const pass = request.headers.authorization ?? '';
    if (url.pathname.startsWith('/v1/agents')) seen.door.push({ method: request.method ?? '', path: url.pathname, body, pass });
    if (PERSON_ONLY.test(url.pathname) && pass !== MAC_PASS) {
      return void response.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify(GUIDE_DOOR['address-person-only'].answer));
    }
    const contract = url.pathname.startsWith('/v1/agents') ? answerOf(request.method ?? '', url, body) : null;
    if (!contract) return void response.writeHead(404, { 'content-type': 'application/json' }).end('{"code":"NOT_FOUND"}');
    response.writeHead(contract.status, { 'content-type': 'application/json' }).end(JSON.stringify(contract.answer));
  });
  servers.push(door);
  await new Promise(done => door.listen(0, '127.0.0.1', () => done(undefined)));
  const doorUrl = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (door.address()).port}`;
  const viewer = await createViewer({ key: null, door: openDoor({ url: doorUrl, token: () => 'stand-in-token' }) });
  servers.push(viewer);
  await new Promise(done => viewer.listen(0, '127.0.0.1', () => done(undefined)));
  const origin = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (viewer.address()).port}`;
  const opened = await openChrome({ profile: join(dir, 'chrome'), origin });
  chrome = opened;
  await opened.send('Runtime.addBinding', { name: 'homeAsk' });
  opened.on('Runtime.bindingCalled', async (/** @type {{ name: string, payload: string }} */ called) => {
    if (called.name !== 'homeAsk') return;
    const { id, message } = JSON.parse(called.payload);
    const [method, path, body] = doorAsk(message);
    const answer = await fetch(`${doorUrl}${path}`, { method, headers: { authorization: MAC_PASS, 'content-type': 'application/json' },
      ...body === null ? {} : { body: JSON.stringify(body) } });
    const said = await answer.json();
    const reply = answer.ok ? { answer: said } : { refused: { code: said.code, message: said.message } };
    await opened.evaluate(`window.homeAnswered(${id}, ${JSON.stringify(reply)})`);
  });
  await opened.size(1180, 860, 1);
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
});

after(async () => {
  await writeFile(join(OUT, 'agent-guides-frame.json'), `${JSON.stringify({ ...seen, waiting: chrome?.waiting ?? '' }, null, 2)}\n`)
    .catch(() => undefined);
  await chrome?.close();
  for (const server of servers.reverse()) {
    server.closeAllConnections();
    await new Promise(done => server.close(() => done(undefined)));
  }
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('every guide state fits the Mac’s 600 × 640 frame, but Edit, whose body scrolls under Done', async () => {
  const page = /** @type {NonNullable<typeof chrome>} */ (chrome);
  const BODY = `document.querySelector('#dialog-layer .ck-dialog__body')`;
  /** @param {unknown} does */
  const control = does => `[data-cn-do='${JSON.stringify(does)}']`;
  /** @param {string} selector */
  const click = selector => page.evaluate(`(() => { const found = document.querySelectorAll(${JSON.stringify(selector)});
    if (found.length !== 1) throw new Error(${JSON.stringify(selector)} + ' names ' + found.length); found[0].click(); })()`);
  /** @param {string} words */
  const shows = words => `(${BODY}?.closest('.ck-dialog')?.textContent ?? '').includes(${JSON.stringify(words)})`;
  /**
   * @param {string} name
   * @param {{ scrolls?: boolean }} [shown]
   */
  const fits = async (name, { scrolls = false } = {}) => {
    await page.until(`${BODY}?.closest('.ck-dialog')?.getAnimations().length === 0`, `${name}: the dialog settled`);
    const box = await page.evaluate(`(() => { const body = ${BODY}; const frame = body.closest('.ck-dialog').getBoundingClientRect();
      return { over: body.scrollHeight - body.clientHeight, width: Math.round(frame.width), height: Math.round(frame.height) }; })()`);
    seen.overflows.push({ name, ...box });
    assert.deepEqual([box.width, box.height], [600, 640], `${name}: the dialog is the page frame`);
    if (!scrolls) assert.ok(box.over <= 0, `${name}: its body runs ${box.over} px over`);
    await page.shoot(join(OUT, `${name}.png`));
    seen.shots.push(name);
  };
  /** @param {string} at */
  const open = at => page.evaluate(`window.location.hash = '#view=agents&dialog=${encodeURIComponent(at)}'`);

  await page.load('#view=agents', macHost({ ...STATE, agent_requests: [] }));
  const rows = GUIDES.apps.map((/** @type {any} */ each) => each.connected ? `agent:${each.connected}` : `agents:connect/guide:${each.app}`);
  await page.until(`JSON.stringify([...document.querySelectorAll('[data-ag-guides] [data-ag-open]')].map(each => each.dataset.agOpen)) === ${
    JSON.stringify(JSON.stringify(rows))}`, 'the empty page is the list of apps, a connected one opening its agent');
  await page.shoot(join(OUT, 'list-page.png'));
  seen.shots.push('list-page');

  await open('agents:connect');
  await page.until(shows(GUIDES.apps.at(-1).name), 'the list in the dialog');
  await fits('list');

  await open('agents:connect/guide:chatgpt');
  const chatgpt = GUIDES.apps.find((/** @type {any} */ each) => each.app === 'chatgpt');
  await page.until(`${shows(chatgpt.need)} && ${shows(GUIDE_DOOR['address-off'].answer.url)}`, 'ChatGPT before the copy');
  await fits('chatgpt-ready');
  await click(`[data-cn-copy="${GUIDE_DOOR['address-off'].answer.url}"]`);
  await page.until(shows(GUIDE_DOOR['address-on'].answer.line), 'copied, the address on');
  await fits('chatgpt-copied');

  await page.evaluate(`window.setHostState(${JSON.stringify({ ...STATE, agent_requests: [SIGN_IN] })})`);
  await page.until(`${shows(SIGN_IN.head)} && ${shows(SIGN_IN.pick_line)}`, 'the sign-in arrives inside step 2');
  assert.equal(await page.evaluate(`document.querySelector('#agent-layer')?.hidden !== false`), true, 'no card over the guide');
  await fits('chatgpt-arrived');

  await click(control({ page: 'access' }));
  await page.until(`document.querySelector(${JSON.stringify(`#dialog-layer .ck-dialog__foot ${control({ editor: 'done' })}`)}) !== null`, 'Edit: Done in the foot');
  await fits('chatgpt-edit', { scrolls: true });
  await click(control({ editor: 'done' }));
  await page.until(shows(SIGN_IN.pick_line), 'back at the yes');

  await page.evaluate(`window.hostAnswers['agent-answer'] = ${JSON.stringify(HOST['answer-sign-in-wrong'].reply)}`);
  await page.evaluate(`(() => { const input = document.querySelector('[data-cn-field="signin.code:${SIGN_IN.id}"]');
    input.value = '000000'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await page.until(`document.querySelector(${JSON.stringify(`[data-cn-do*='"answer":"000000"']`)})?.disabled === false`, 'Allow, once the code is typed');
  await click(`[data-cn-do*='"answer":"000000"']`);
  await page.evaluate(`window.setHostState(${JSON.stringify({ ...STATE, agent_requests: [] })})`);
  home.signin = { status: 200, answer: { id: SIGN_IN.id, state: 'wrong', outcome: null, reader: null, connected: null } };
  const yes = chatgpt.steps.find((/** @type {any} */ step) => step.kind === 'yes');
  await page.until(`${shows(yes.wait)} && ${shows(yes.wrong)}`, 'a wrong code: the page’s line, waiting again');
  await fits('chatgpt-wrong');

  const again = { ...SIGN_IN, id: 'c2lnbi1pbi0wMDAwMDAwMg', at_ms: SIGN_IN.at_ms + 1 };
  await page.evaluate(`window.setHostState(${JSON.stringify({ ...STATE, agent_requests: [again] })})`);
  await page.until(shows(SIGN_IN.pick_line), 'the next sign-in');
  await fits('chatgpt-wrong-next');
  await page.evaluate(`window.hostAnswers['agent-answer'] = ${JSON.stringify(HOST['answer-sign-in'].reply)}`);
  home.signin = signInRead(again.id, 'signin-connected');
  await page.evaluate(`(() => { const input = document.querySelector('[data-cn-field="signin.code:${again.id}"]');
    input.value = '482915'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await page.until(`document.querySelector(${JSON.stringify(`[data-cn-do*='"answer":"482915"']`)})?.disabled === false`, 'Allow, once the code is typed');
  await click(`[data-cn-do*='"answer":"482915"']`);
  await page.evaluate(`window.setHostState(${JSON.stringify({ ...STATE, agent_requests: [] })})`);
  await page.until(`${shows(chatgpt.done.title)} && ${shows(GUIDE_DOOR['signin-connected'].answer.connected.line)}`, 'Connected, in the reader’s line');
  await fits('chatgpt-connected');

  const claude = GUIDES.apps.find((/** @type {any} */ each) => each.app === 'claude');
  for (const fix of ['address-fix-mac', 'address-fix-turn-on', 'address-fix-other']) {
    home.address = GUIDE_DOOR[fix];
    await open('');
    await open('agents:connect/guide:claude');
    await page.until(`${shows(GUIDE_DOOR[fix].answer.words)} && ${shows(claude.address.title)}`, `the fix as Tailscale’s step 1: ${fix}`);
    await fits(`claude-${fix}`);
  }
  home.address = GUIDE_DOOR['address-off'];
  await click(control({ guide: { fix: 'check' } }));
  await page.until(`${shows(claude.address.ready)} && ${shows(claude.address.on)}`, 'Tailscale ready: Turn on');
  await fits('claude-tailscale-ready');
  await click(control({ guide: { fix: 'turn-on' } }));
  await page.until(shows(GUIDE_DOOR['address-on'].answer.url), 'turned on: Tailscale done, the address to copy');
  await fits('claude-tailscale-done');
  home.address = GUIDE_DOOR['address-on'];

  for (const app of ['grok-bot', 'instinct', 'another']) {
    const guide = GUIDES.apps.find((/** @type {any} */ each) => each.app === app);
    const make = guide.steps.find((/** @type {any} */ step) => step.kind === 'sees').make;
    home.key = app === 'another' ? GUIDE_DOOR['keys-another'] : GUIDE_DOOR[`keys-${app}`];
    await open('');
    await open(`agents:connect/guide:${app}`);
    await page.until(shows(guide.need), `${app}: its guide`);
    if (app === 'instinct') await click(control({ guide: { linked: true } }));
    if (app === 'another') {
      await page.evaluate(`(() => { const input = document.querySelector('[data-cn-field="agents.name"]');
        input.value = 'Example tool'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    }
    await page.until(`[...document.querySelectorAll('#dialog-layer .ck-dialog__foot button')].some(each => each.textContent.includes(${JSON.stringify(make)}) && !each.disabled)`,
      `${app}: Make the key`);
    await fits(`${app}-sees`);
    await click(control({ guide: { make: true } }));
    await page.until(shows(home.key.answer.rows[1].text), `${app}: its rows`);
    await fits(`${app}-made`);
    if (app === 'another') continue;
    await click(control({ guide: { done: true } }));
    await page.until(shows(guide.done.title), `${app}: Connected`);
    await fits(`${app}-connected`);
  }
  const asked = seen.door.filter(each => PERSON_ONLY.test(each.path));
  assert.ok(asked.some(each => each.path === '/v1/agents/guides') && asked.some(each => each.path === '/v1/agents/keys'), 'the guides read and a key made');
  assert.deepEqual([...new Set(asked.map(each => each.pass))], [MAC_PASS], 'every person’s ask carried the Mac’s own pass, none the dashboard’s');
});
