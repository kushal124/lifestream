// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { until } from './until.mjs';
import { asked, home, homeClock, keyed, machineWith, named, note, statusOf } from './asking.mjs';
import { choose, fakeClaude, fakeCodex, ready } from './programs.mjs';
import { openCodex } from '../lib/ask/codex.mjs';
import { askServer, claudeState, doneOf, errorOf, onClaude } from './on-claude.mjs';

const ASK_READY = fileURLToPath(new URL('../../homelink/Tests/Fixtures/ask-ready.json', import.meta.url));
const KEY = 'sk-or-test-0000';

onClaude('claude-picks');

/**
 * @param {string} at
 * @param {Record<string, string>} pick
 */
const pickedStatus = async (at, pick) => /** @type {any} */ (await (await fetch(`${at}/ask?${new URLSearchParams(pick)}`, { headers: { authorization: `Bearer ${home.tokens.reader}` } })).json());

/**
 * @param {unknown} value
 * @returns {unknown}
 */
const shapeOf = value => Array.isArray(value) ? [shapeOf(value[0])]
  : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, shapeOf(inner)]))
    : value === null || typeof value === 'string' ? 'string?' : typeof value;

test('9: both subscriptions signed in: one picker over both makers, a pick from each runs on its own program, Claude\'s list unreadable or never given leaves ChatGPT\'s whole and its questions unheld, a pick read too slowly for the status named as asked and asked so, a conversation moved between makers starts a new context with the conversation so far; a chosen Claude still downloading says so and is never answered through OpenRouter', async () => {
  named('both makers');
  const machine = await machineWith(['claude', 'codex']);
  const fake = fakeClaude(machine);
  const codex = fakeCodex(machine);
  await fake.signIn();
  await writeFile(join(machine, 'codex', 'fake', 'auth.json'), JSON.stringify({ email: 'person-a@example.com', plan: 'plus' }));
  try {
    const { url, close } = await askServer({ machine });
    const status = await statusOf(url);
    note({ status });
    assert.deepEqual([status.model, status.group, status.default.model], ['claude/opus', 'Claude', 'claude/opus']);
    assert.deepEqual([...new Set(status.models.map((/** @type {any} */ each) => each.group))], ['Claude', 'ChatGPT']);
    await fake.script([[{ say: 'On Claude.' }], [{ say: 'Back on Claude.' }]]);
    await codex.script([[{ say: 'On ChatGPT.' }], [{ say: 'title' }]]);
    const onClaude = await asked(url, { question: 'Which?', model: 'claude/sonnet', thinking: 'low' });
    assert.deepEqual([doneOf(onClaude)?.text, doneOf(onClaude)?.model], ['On Claude.', 'claude-sonnet-5-5'], JSON.stringify(onClaude));
    const chat = doneOf(onClaude).chat;
    const onChatGPT = await asked(url, { question: 'And now?', chat, model: 'gpt-6-luna' });
    assert.deepEqual([doneOf(onChatGPT)?.text, doneOf(onChatGPT)?.model], ['On ChatGPT.', 'gpt-6-luna'], JSON.stringify(onChatGPT));
    const injected = await codex.asked('thread/inject_items');
    assert.deepEqual(injected.at(-1).items.map((/** @type {any} */ item) => item.content[0].text), ['[Asked Thursday 2026-10-01 12:00]\nWhich?', 'On Claude.']);
    const back = await asked(url, { question: 'Back?', chat, model: 'claude/sonnet', thinking: 'low' });
    assert.equal(doneOf(back)?.text, 'Back on Claude.');
    assert.equal((await fake.starts()).filter(each => each.argv.includes('--mcp-config')).length, 2);
    assert.match((await fake.seen()).filter(line => line.asked !== undefined).at(-1).asked, /Your answer: On ChatGPT\./u);
    const stale = await pickedStatus(url, { model: 'claude/retired', thinking: 'low' });
    assert.deepEqual([stale.gone, stale.model, stale.thinking, stale.said], [true, 'claude/opus', 'high', undefined]);
    await fake.script([[{ say: 'By default.' }]]);
    const answeredStale = await asked(url, { question: 'Stale?', model: 'claude/retired', thinking: 'low' });
    assert.deepEqual([doneOf(answeredStale)?.text, doneOf(answeredStale)?.thinking], ['By default.', 'high'], JSON.stringify(answeredStale));
    assert.deepEqual((await fake.starts()).filter(each => each.argv.includes('--mcp-config')).at(-1).argv.slice(-4), ['--model', 'opus', '--effort', 'high']);
    await close();

    await fake.touch('models-broken');
    const broken = await askServer({ machine });
    const without = await statusOf(broken.url);
    note({ without: without.models.map((/** @type {any} */ each) => each.id) });
    assert.deepEqual([without.model, without.group, [...new Set(without.models.map((/** @type {any} */ each) => each.group))]], ['gpt-6.1-terra', 'ChatGPT', ['ChatGPT']]);
    const unread = await pickedStatus(broken.url, { model: 'claude/sonnet' });
    assert.deepEqual([unread.gone, unread.model, unread.said], [undefined, 'gpt-6.1-terra', undefined]);
    await broken.close();

    await rm(join(fake.dir, 'models-broken'));
    await fake.touch('models-held');
    const held = await askServer({ machine, listedMs: 200 });
    const lists = async () => (await fake.starts()).filter(each => each.argv[0] === '-p' && !each.argv.includes('--mcp-config') && !each.argv.includes('--system-prompt')).length;
    const before = await lists();
    await codex.script([[{ say: 'Unheld.' }]]);
    const unheld = await asked(held.url, { question: 'Quick?', model: 'gpt-6-luna' });
    assert.equal(doneOf(unheld)?.text, 'Unheld.', JSON.stringify(unheld));
    assert.equal(await lists(), before);
    const waiting = await statusOf(held.url);
    note({ held: waiting.models.map((/** @type {any} */ each) => each.id) });
    assert.deepEqual([...new Set(waiting.models.map((/** @type {any} */ each) => each.group))], ['ChatGPT']);
    const slow = await pickedStatus(held.url, { model: 'claude/sonnet' });
    assert.deepEqual([slow.gone, slow.model, slow.name, slow.thinking, slow.group, slow.login, slow.said], [undefined, 'claude/sonnet', 'claude/sonnet', 'high', 'Claude', 'ready', undefined]);
    await held.close();

    await rm(join(fake.dir, 'models-held'));
    await fake.touch('status-held');
    await keyed(KEY);
    const withKey = await askServer({ machine, listedMs: 200 });
    const statuses = async () => (await fake.starts()).filter(each => each.argv[0] === 'auth' && each.argv[1] === 'status').length;
    const unasked = await statuses();
    await codex.script([[{ say: 'Unasked.' }]]);
    const direct = await asked(withKey.url, { question: 'Direct?', model: 'gpt-6-luna' });
    assert.equal(doneOf(direct)?.text, 'Unasked.', JSON.stringify(direct));
    assert.equal(await statuses(), unasked);
    const slowPick = { model: 'claude/sonnet', thinking: 'low' };
    const named = await pickedStatus(withKey.url, slowPick);
    note({ named });
    assert.deepEqual([named.model, named.name, named.thinking, named.group, named.said, named.gone], ['claude/sonnet', 'claude/sonnet', 'low', 'Claude', undefined, undefined]);
    await fake.script([[{ say: 'Waited.' }]]);
    const waited = asked(withKey.url, { question: 'Waited?', ...slowPick });
    await rm(join(fake.dir, 'status-held'));
    const waitedDone = doneOf(await waited);
    assert.deepEqual([waitedDone?.text, waitedDone?.thinking], ['Waited.', named.thinking]);
    assert.deepEqual((await fake.starts()).filter(each => each.argv.includes('--mcp-config')).at(-1).argv.slice(-4), ['--model', 'sonnet', '--effort', named.thinking]);
    await withKey.close();

    const bare = await machineWith([]);
    await choose(bare, 'claude');
    const fetching = await askServer({ machine: bare });
    const said = await asked(fetching.url, { question: 'Anything?' });
    note({ downloading: said });
    assert.deepEqual(said, [{ type: 'error', error: 'model', message: 'Claude Code is downloading. Ask again in a minute.' }]);
    assert.equal((await claudeState(fetching.url)).state, 'fetching');
    await fetching.close();
    await rm(bare, { recursive: true, force: true });
  } finally {
    await keyed(null);
    await rm(machine, { recursive: true, force: true });
  }
});

/** @param {unknown[]} [models] */
const noList = models => `import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const [fake, ...args] = process.argv.slice(2);
const child = spawn(process.execPath, [fake, ...args], { stdio: ['pipe', 'pipe', 'inherit'] });
const listing = new Set();
createInterface({ input: process.stdin }).on('line', line => {
  try {
    const said = JSON.parse(line);
    if (said.method === 'model/list') listing.add(said.id);
    if (said.request?.subtype === 'initialize') listing.add(said.request_id);
  } catch {}
  child.stdin.write(\`\${line}\\n\`);
}).on('close', () => child.stdin.end());
createInterface({ input: child.stdout }).on('line', line => {
  let said = null;
  try { said = JSON.parse(line); } catch {}
  if (said !== null && listing.has(said.id) && said.result !== undefined) said.result = {};
  if (said !== null && listing.has(said.response?.request_id)) ${models === undefined ? 'delete said.response.response.models' : `said.response.response.models = ${JSON.stringify(models)}`};
  process.stdout.write(\`\${said === null ? line : JSON.stringify(said)}\\n\`);
});
child.on('exit', code => process.exit(code ?? 1));
`;

/**
 * @param {string} machine
 * @param {'codex' | 'claude'} name
 * @param {unknown[]} [models]
 */
const unlisted = async (machine, name, models) => {
  const proxy = join(machine, `${name}-no-list.mjs`);
  await writeFile(proxy, noList(models));
  const subscription = join(machine, 'subscriptions', name);
  const binary = join(subscription, (await readFile(join(subscription, 'current'), 'utf8')).trim());
  const fake = fileURLToPath(new URL(`./fake/${name}.mjs`, import.meta.url));
  const launcher = await readFile(binary, 'utf8');
  assert.ok(launcher.includes(`"${fake}"`), launcher);
  await writeFile(binary, launcher.replace(`"${fake}"`, `"${proxy}" "${fake}"`));
};

test('13: a pick the plans cannot answer: Claude signed out says Claude\'s sentence in the status and the turn; a Claude pick at low, Claude signed out and a key held, asks ChatGPT\'s default at its own level, says the pick\'s line and never bills the key; a pick that answers is asked as the status names it; after a signed-out answer on Claude the default is ChatGPT\'s and says so, a pick gone says it too; a reply with no list, or a list with an entry that is no model, keeps the pick', async () => {
  named('picks');
  const only = await machineWith(['claude']);
  const machine = await machineWith(['claude', 'codex']);
  const fake = fakeClaude(machine);
  const codex = fakeCodex(machine);
  const claudeAsked = async () => (await fake.starts()).filter(each => each.argv.includes('--mcp-config')).at(-1)?.argv.slice(-4);
  /** @param {string} question */
  const codexAsked = async question => {
    const started = (await codex.asked('turn/start')).find((/** @type {any} */ each) => each.input?.[0]?.text?.endsWith(`]\n${question}`));
    return [started?.model, started?.effort];
  };
  try {
    const alone = await askServer({ machine: only });
    const signedOut = await statusOf(alone.url);
    note({ signedOut });
    assert.deepEqual([signedOut.login, signedOut.group, signedOut.said], ['missing', 'Claude', 'Chat needs your Claude sign-in on your Mac.']);
    assert.deepEqual(await asked(alone.url, { question: 'Anyone?' }), [{ type: 'error', error: 'login', message: 'Chat needs your Claude sign-in on your Mac.' }]);
    await alone.close();

    await writeFile(join(machine, 'codex', 'fake', 'auth.json'), JSON.stringify({ email: 'person-a@example.com', plan: 'plus' }));
    await keyed(KEY);
    const first = await askServer({ machine });
    const instead = await pickedStatus(first.url, { model: 'claude/sonnet', thinking: 'low' });
    note({ instead });
    const { voice: fixtureVoice, starters: fixtureStarters, voices: _voices, ...fixture } = JSON.parse(await readFile(ASK_READY, 'utf8'));
    const { voice: insteadVoice, starters: insteadStarters, ...rest } = instead;
    assert.deepEqual(rest, fixture, 'the answer HomeLink decodes');
    assert.ok(insteadStarters.length === 0 || JSON.stringify(insteadStarters) === JSON.stringify(fixtureStarters), JSON.stringify(insteadStarters));
    assert.deepEqual(shapeOf(insteadVoice), shapeOf(fixtureVoice), 'the voice row HomeLink decodes');
    await codex.script([[{ say: 'From ChatGPT.' }], [{ say: 'title' }]]);
    const fellBack = await asked(first.url, { question: 'Who?', model: 'claude/sonnet', thinking: 'low' });
    assert.deepEqual([doneOf(fellBack)?.text, doneOf(fellBack)?.model, doneOf(fellBack)?.thinking], ['From ChatGPT.', 'gpt-6.1-terra', 'high'], JSON.stringify(fellBack));
    assert.deepEqual(await codexAsked('Who?'), [instead.model, instead.thinking]);
    assert.equal(await claudeAsked(), undefined, 'Claude Code is never asked');
    await first.close();

    await fake.signIn();
    const second = await askServer({ machine });
    const picked = await pickedStatus(second.url, { model: 'claude/sonnet', thinking: 'low' });
    assert.deepEqual([picked.model, picked.name, picked.thinking, picked.group, picked.login, picked.said, picked.gone], ['claude/sonnet', 'Sonnet', 'low', 'Claude', 'ready', undefined, undefined]);
    await fake.script([[{ say: 'On Sonnet.' }], [{ signedOut: true }]]);
    const onSonnet = await asked(second.url, { question: 'Which?', model: 'claude/sonnet', thinking: 'low' });
    assert.deepEqual([doneOf(onSonnet)?.text, doneOf(onSonnet)?.thinking], ['On Sonnet.', 'low'], JSON.stringify(onSonnet));
    assert.deepEqual(await claudeAsked(), ['--model', 'sonnet', '--effort', 'low']);
    const refused = await asked(second.url, { question: 'And?' });
    assert.equal(errorOf(refused)?.message, 'Chat needs your Claude sign-in on your Mac.');
    const moved = await statusOf(second.url);
    note({ moved });
    assert.deepEqual([moved.model, moved.thinking, moved.login, moved.said, moved.default], ['gpt-6.1-terra', 'high', 'ready', 'Claude needs your sign-in on your Mac. Asking GPT-6.1 Terra.', { model: 'gpt-6.1-terra' }]);
    assert.equal((await pickedStatus(second.url, { model: 'claude/sonnet' })).said, 'Your pick needs your Claude sign-in on your Mac. Asking GPT-6.1 Terra.');
    const retired = await pickedStatus(second.url, { model: 'claude/retired' });
    assert.deepEqual([retired.gone, retired.model, retired.said], [true, 'gpt-6.1-terra', 'Claude needs your sign-in on your Mac. Asking GPT-6.1 Terra.']);
    await codex.script([[{ say: 'Moved.' }], [{ say: 'title' }]]);
    const onDefault = await asked(second.url, { question: 'Now?' });
    assert.equal(doneOf(onDefault)?.text, 'Moved.', JSON.stringify(onDefault));
    assert.deepEqual(await codexAsked('Now?'), [moved.model, moved.thinking]);
    await second.close();

    await unlisted(machine, 'claude');
    const noClaudeList = await askServer({ machine });
    const keptClaude = await pickedStatus(noClaudeList.url, { model: 'claude/sonnet' });
    assert.deepEqual([keptClaude.gone, keptClaude.model, keptClaude.said], [undefined, 'gpt-6.1-terra', undefined]);
    await codex.script([[{ say: 'Unlisted.' }], [{ say: 'title' }]]);
    assert.equal(doneOf(await asked(noClaudeList.url, { question: 'Listed?', model: 'claude/sonnet' }))?.text, 'Unlisted.');
    await noClaudeList.close();
    await ready(machine, 'claude');
    await unlisted(machine, 'claude', [{}]);
    const badClaudeList = await askServer({ machine });
    const keptOverBad = await pickedStatus(badClaudeList.url, { model: 'claude/sonnet' });
    assert.deepEqual([keptOverBad.gone, keptOverBad.model, keptOverBad.said], [undefined, 'gpt-6.1-terra', undefined]);
    await badClaudeList.close();
    await ready(machine, 'claude');
    await unlisted(machine, 'codex');
    const noCodexList = await askServer({ machine });
    const keptChatGPT = await pickedStatus(noCodexList.url, { model: 'gpt-6-luna' });
    assert.deepEqual([keptChatGPT.gone, keptChatGPT.model, keptChatGPT.said], [undefined, 'claude/opus', undefined]);
    await noCodexList.close();
  } finally {
    await keyed(null);
    await rm(only, { recursive: true, force: true });
    await rm(machine, { recursive: true, force: true });
  }
});

const UNLISTED = `import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method } = JSON.parse(line);
  if (id === undefined) return;
  appendFileSync(join(process.env.CODEX_HOME ?? '', 'asked'), \`\${method}\\n\`);
  process.stdout.write(\`\${JSON.stringify(method === 'model/list' ? { id, error: { code: -32603, message: 'no models now' } } : { id, result: {} })}\\n\`);
});
`;

test('12: a model list that failed is asked again a minute later, not at every request: Codex\'s and Claude\'s', async () => {
  named('lists that failed');
  const folder = await mkdtemp(join(tmpdir(), 'lifestream-mcp-unlisted-'));
  const machine = await machineWith(['claude']);
  const fake = fakeClaude(machine);
  await fake.signIn();
  await fake.touch('models-broken');
  try {
    const script = join(folder, 'codex.mjs');
    await writeFile(script, UNLISTED);
    const binary = join(folder, 'codex');
    await writeFile(binary, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    await chmod(binary, 0o755);
    let clock = 0;
    const codex = openCodex({ at: () => ({ binary, home: folder }), log: () => undefined, now: () => clock });
    const codexLists = async () => (await readFile(join(folder, 'asked'), 'utf8')).split('\n').filter(line => line === 'model/list').length;
    await assert.rejects(codex.models(), /no models now/u);
    await assert.rejects(codex.models(), /no models now/u);
    const codexAtOnce = await codexLists();
    clock += 61_000;
    await assert.rejects(codex.models(), /no models now/u);
    const codexLater = await codexLists();
    await codex.close();

    let shift = 0;
    const { url, logged, close } = await askServer({ machine, now: () => homeClock() + shift });
    const claudeLists = async () => (await fake.starts()).filter(each => each.argv[0] === '-p' && !each.argv.includes('--mcp-config') && !each.argv.includes('--system-prompt')).length;
    /** @param {number} n */
    const readUnlisted = async n => {
      await statusOf(url);
      await until(`Claude's list unread ${n} times`, () => logged.filter(line => line.ask === 'models unread' && line.maker === 'claude').length === n);
    };
    await readUnlisted(1);
    await readUnlisted(2);
    const claudeAtOnce = await claudeLists();
    shift += 61_000;
    await readUnlisted(3);
    const claudeLater = await claudeLists();
    await close();
    note({ codex: [codexAtOnce, codexLater], claude: [claudeAtOnce, claudeLater] });
    assert.deepEqual([codexAtOnce, codexLater], [1, 2], 'Codex\'s list asked once, then again a minute later');
    assert.deepEqual([claudeAtOnce, claudeLater], [1, 2], 'Claude\'s list asked once, then again a minute later');
  } finally {
    await rm(folder, { recursive: true, force: true });
    await rm(machine, { recursive: true, force: true });
  }
});

const STOPS_LISTING = `import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const folder = process.env.CODEX_HOME ?? '';
const say = line => process.stdout.write(\`\${JSON.stringify(line)}\\n\`);
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method } = JSON.parse(line);
  if (id === undefined) return;
  appendFileSync(join(folder, 'asked'), \`\${method}\\n\`);
  if (method === 'model/list' && !existsSync(join(folder, 'stopped'))) {
    writeFileSync(join(folder, 'stopped'), '');
    process.exit(1);
  }
  if (method === 'model/list') return say({ id, result: { data: [{ id: 'gpt-synthetic', displayName: 'Synthetic', hidden: false, isDefault: true }] } });
  if (method === 'account/login/start') say({ method: 'account/login/completed', params: { loginId: 'synthetic-login', success: true, error: null } });
  say({ id, result: {} });
});
`;

test('12: Codex\'s models are asked again of the Codex that starts after one stopped while it listed them, and after its sign-in ends signed out or signed in', async () => {
  named('models forgotten');
  const folder = await mkdtemp(join(tmpdir(), 'lifestream-mcp-stops-'));
  try {
    const script = join(folder, 'codex.mjs');
    await writeFile(script, STOPS_LISTING);
    const binary = join(folder, 'codex');
    await writeFile(binary, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    await chmod(binary, 0o755);
    const codex = openCodex({ at: () => ({ binary, home: folder }), log: () => undefined, now: () => 0 });
    const lists = async () => (await readFile(join(folder, 'asked'), 'utf8')).split('\n').filter(line => line === 'model/list').length;
    await assert.rejects(codex.models(), /Codex stopped/u);
    assert.deepEqual((await codex.models()).map(each => each.id), ['gpt-synthetic'], 'the next request lists again and is answered');
    await codex.models();
    const restarted = await lists();
    await codex.request('account/logout', undefined);
    await codex.models();
    const signedOut = await lists();
    await codex.request('account/login/start', { type: 'chatgptDeviceCode' });
    await codex.models();
    const signedIn = await lists();
    await codex.close();
    note({ lists: [restarted, signedOut, signedIn] });
    assert.deepEqual([restarted, signedOut, signedIn], [2, 3, 4], 'listed again after the stop, the sign-out and the sign-in, and kept between');
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
