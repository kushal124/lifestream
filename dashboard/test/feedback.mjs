// @ts-check
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createViewer } from '../server.mjs';
import { openDoor } from '../lib/door.mjs';
import { HOST_STATE } from '../public/kit-gallery-report.js';
import { readHost } from '../public/lib/host.js';
import { accountMarkup } from '../public/ui/sections.js';
import { actOf, actsOf } from '../public/ui/connectors/page.js';
import { aboutKey, entryOf, FEEDBACK, sentOf, titleOf } from '../public/ui/feedback.js';
import { askAnswer, attachmentChip, setIcons } from '../public/ui/kit/index.js';
import { seenHidden } from '../public/ui/kit/seen.js';

setIcons(JSON.parse(readFileSync(new URL('../../design/icons.json', import.meta.url), 'utf8')));

const FIXTURES = new URL('../../homelink/Tests/Fixtures/feedback/', import.meta.url);
/** @type {import('../public/pages.js').Feedback} */
const PAGE = JSON.parse(readFileSync(new URL('page.json', FIXTURES), 'utf8'));
const DRAFT = JSON.parse(readFileSync(new URL('draft.json', FIXTURES), 'utf8'));
const YOU = { id: 'person-sam', name: 'Sam de Rivera', photo: '' };
const ID = '0b6c5c7e-3f1a-4d2b-9c8e-1a2b3c4d5e6f';

/** @param {string} markup */
const itemsOf = markup => [...markup.matchAll(/<(?:div|span)[^>]*data-value="([^"]*)"[^>]*>.*?ck-flist__label">([^<]*)/gu)]
  .map(([, value, words]) => ({ value, words }));

test('F1: Send feedback… sits after Settings and a rule while the home has feedback open, and not at all while it is closed', () => {
  assert.equal(entryOf(PAGE), 'Send feedback…');
  assert.equal(entryOf({ ...PAGE, open: false }), null);
  assert.equal(entryOf(null), null);
  const open = accountMarkup(YOU, { ...HOST_STATE, update: null }, entryOf(PAGE));
  assert.deepEqual(itemsOf(open), [{ value: 'profile', words: 'Profile' }, { value: 'settings', words: 'Settings' },
    { value: FEEDBACK, words: 'Send feedback…' }]);
  assert.ok(open.indexOf('ck-flist__rule') > open.indexOf('data-value="settings"'));
  assert.ok(open.indexOf('ck-flist__rule') < open.indexOf(`data-value="${FEEDBACK}"`));
  const closed = accountMarkup(YOU, { ...HOST_STATE, update: null }, entryOf({ ...PAGE, open: false }));
  assert.deepEqual(itemsOf(closed).map(item => item.value), ['profile', 'settings']);
  assert.doesNotMatch(closed, /ck-flist__rule/u);
});

test('F2: every answer, done, stopped or failed, holds a … menu after Copy and the eye whose one item opens the form on that answer', () => {
  const more = { items: [{ name: 'Send feedback…', value: FEEDBACK }], attrs: { 'data-ask-more': '4' } };
  const draw = { markdown: (/** @type {string} */ text) => `<p>${text}</p>`, turn: 1 };
  const done = askAnswer({ text: 'You slept 7 h.', refs: {}, seen: [], more }, draw);
  const copy = done.indexOf('ck-answer__copy');
  const eye = done.indexOf('data-ck-seen-eye');
  const dots = done.indexOf('ck-answer__more');
  assert.ok(copy > 0 && eye > copy && dots > eye, 'Copy, the eye, then …');
  assert.match(done, /<span class="ck-fmenu ck-fmenu--float ck-fmenu--start ck-answer__more" data-ask-more="4">/u);
  assert.match(done, /aria-label="More"/u);
  assert.deepEqual(itemsOf(done), [{ value: FEEDBACK, words: 'Send feedback…' }]);
  assert.match(askAnswer({ text: 'You walked', refs: {}, stopped: true, more }, draw), /data-ask-more="4"/u);
  const failed = askAnswer({ text: '', refs: {}, failed: { sentence: 'ChatGPT didn’t answer.', retry: null }, more }, draw);
  assert.match(failed, /class="ck-copy ck-answer__foot"/u);
  assert.match(failed, /data-ask-more="4"/u);
  assert.doesNotMatch(failed, /ck-answer__copy/u);
  assert.doesNotMatch(askAnswer({ text: 'You slept', refs: null, paced: true, more }, draw), /data-ask-more/u);
  assert.doesNotMatch(askAnswer({ text: 'You slept 7 h.', refs: {}, more: null }, draw), /ck-answer__more/u);
});

test('F3: Report a problem opens the form on its connector, as words left of the card’s act, the act still its primary', () => {
  const connector = /** @type {any} */ ({ id: 'example-mail', name: 'Example Mail', members: [], routes: [] });
  const report = /** @type {const} */ ({ do: 'report', label: 'Report a problem', of: 'example-mail' });
  assert.deepEqual(actOf(report, connector, null), { label: 'Report a problem', variant: 'plain',
    do: { feedback: { connector: 'example-mail', name: 'Example Mail' } } });
  assert.equal(actOf(report, null, null), null);
  const acts = actsOf([{ do: 'try', label: 'Try now', need: 'need-1' }, { do: 'skip', label: 'Skip it', need: 'need-1' }, report],
    connector, null);
  assert.deepEqual(acts.map(act => [act.label, act.variant]), [['Report a problem', 'plain'], ['Try now', 'primary'], ['Skip it', 'secondary']]);
  assert.deepEqual(actsOf([{ do: 'skip', label: 'Skip it', need: 'need-1' }, report], connector, null).map(act => [act.label, act.variant]),
    [['Report a problem', 'plain'], ['Skip it', undefined]]);
});

test('F4: the form’s title, its sent words and its memory are the home’s words for what it was opened on', () => {
  assert.equal(titleOf(PAGE, { kind: 'menu' }, ''), 'Send feedback');
  assert.equal(titleOf(PAGE, { kind: 'chat', chat: '1790000000000-abcdef', n: 2 }, ''), 'Feedback on this answer');
  assert.equal(titleOf(PAGE, { kind: 'connector', connector: 'example-mail' }, 'Example Mail'), 'Report a problem with Example Mail');
  assert.deepEqual(sentOf(PAGE, null), { title: 'Sent. Thank you.', line: null });
  assert.deepEqual(sentOf(PAGE, 'person-a@example.com'), { title: 'Sent. Thank you.', line: 'We\'ll reply to person-a@example.com.' });
  assert.deepEqual(new Set([aboutKey({ kind: 'menu' }), aboutKey({ kind: 'chat', chat: '1790000000000-abcdef', n: 2 }),
    aboutKey({ kind: 'chat', chat: '1790000000000-abcdef', n: 4 }), aboutKey({ kind: 'connector', connector: 'example-mail' })]).size, 4);
});

test('F5: a chip says whether it goes: pressed, attached with a remove; not, offered with its add words; a screenshot shows itself', () => {
  const kept = attachmentChip({ title: 'App details', kept: true, glyph: 'info', attrs: { 'data-fb-keep': 'app' } });
  assert.match(kept, /class="ck-achip is-kept"/u);
  assert.match(kept, /aria-pressed="true" data-fb-keep="app"/u);
  assert.match(kept, /ck-achip__end/u);
  const offered = attachmentChip({ title: 'Screenshot', add: 'Add screenshot', kept: false,
    picture: { src: 'blob:shot', attrs: { 'data-fb-picture': '' } } });
  assert.match(offered, /aria-pressed="false"/u);
  assert.match(offered, /ck-achip__words">Add screenshot</u);
  assert.match(offered, /<button type="button" class="ck-achip__picture" aria-label="Screenshot" title="Screenshot" data-fb-picture=""><img src="blob:shot" alt=""><\/button>/u);
  assert.doesNotMatch(offered, /ck-achip__end/u);
});

test('F6: what is sent draws each placeholder as the privacy view does, and the rest as text', () => {
  assert.equal(seenHidden('Question: <b> at [[Place 1]] with [[Person 2]]'),
    'Question: &lt;b&gt; at <span class="ck-stand">Place 1</span> with <span class="ck-stand">Person 2</span>');
  assert.equal(seenHidden('no [[ placeholder\n]] here'), 'no [[ placeholder\n]] here');
});

test('F7: the Mac answers screenshot-take with its JPEG’s bytes; anything else is no picture', async () => {
  /** @param {(message: any) => unknown} reply */
  const windowOf = reply => /** @type {any} */ ({ lifestreamHost: { kind: 'mac', version: 6, state: {} },
    addEventListener: () => undefined, removeEventListener: () => undefined,
    webkit: { messageHandlers: { lifestream: { postMessage: reply } } } });
  /** @type {any[]} */
  const posted = [];
  const host = /** @type {import('../public/lib/host.js').Host} */ (readHost(windowOf(message => {
    posted.push(message);
    return { jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64') };
  })));
  assert.deepEqual([...(await host.act({ act: 'screenshot-take' })).jpeg ?? []], [0xff, 0xd8, 0xff, 0xe0]);
  assert.deepEqual(posted, [{ type: 'act', act: 'screenshot-take' }]);
  const none = /** @type {import('../public/lib/host.js').Host} */ (readHost(windowOf(() => ({ jpeg: '' }))));
  assert.equal((await none.act({ act: 'screenshot-take' })).jpeg, undefined);
});

/** @type {import('node:http').Server[]} */
const servers = [];
after(() => {
  for (const server of servers) server.close();
});

/** @param {import('node:http').Server} server */
const listening = async server => {
  servers.push(server);
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  return `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
};

test('F8: the dashboard relays a draft, a screenshot’s bytes and a send to the door as the page asked, and only from the page', async () => {
  /** @type {{ method: string, path: string, length: string, body: Buffer }[]} */
  const seen = [];
  const door = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const url = new URL(request.url ?? '/', 'http://door');
    if (url.pathname.startsWith('/v1/feedback/')) seen.push({ method: request.method ?? '', path: `${url.pathname}${url.search}`, length: String(request.headers['content-length'] ?? ''),
      body: Buffer.concat(chunks) });
    const answers = /** @type {Record<string, [number, unknown]>} */ ({ '/v1/feedback/draft': [200, DRAFT],
      '/v1/feedback/screenshot': [200, { width: 1, height: 1 }], '/v1/feedback/send': [404, { code: 'NOT_FOUND', message: 'no draft' }] });
    const [status, answer] = answers[url.pathname] ?? [404, { code: 'NOT_FOUND' }];
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
  });
  const doorUrl = await listening(door);
  const origin = await listening(await createViewer({ key: null, door: openDoor({ url: doorUrl, token: () => 'stand-in-token' }) }));
  const page = { 'X-Viewer-Request': '1', 'Content-Type': 'application/json' };
  const about = { kind: 'chat', chat: '1790000000000-abcdef', n: 2 };
  const drafted = await fetch(`${origin}/api/feedback/draft`, { method: 'POST', headers: page, body: JSON.stringify({ id: ID, about }) });
  assert.equal(drafted.status, 200);
  assert.deepEqual(await drafted.json(), DRAFT);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const shot = await fetch(`${origin}/api/feedback/screenshot?id=${ID}`, { method: 'POST', body: jpeg,
    headers: { 'X-Viewer-Request': '1', 'Content-Type': 'image/jpeg' } });
  assert.deepEqual([shot.status, await shot.json()], [200, { width: 1, height: 1 }]);
  const sent = await fetch(`${origin}/api/feedback/send`, { method: 'POST', headers: page,
    body: JSON.stringify({ id: ID, text: 'It skipped a day.', email: null, keep: ['app'] }) });
  assert.equal(sent.status, 404);
  assert.deepEqual(seen.map(each => [each.method, each.path]), [['POST', '/v1/feedback/draft'], ['POST', `/v1/feedback/screenshot?id=${ID}`],
    ['POST', '/v1/feedback/send']]);
  assert.deepEqual(JSON.parse(seen[0].body.toString('utf8')), { id: ID, about });
  assert.deepEqual([seen[1].length, seen[1].body], [String(jpeg.length), jpeg]);
  assert.deepEqual(JSON.parse(seen[2].body.toString('utf8')), { id: ID, text: 'It skipped a day.', email: null, keep: ['app'] });
  const foreign = await fetch(`${origin}/api/feedback/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: ID, text: 'x', email: null, keep: [] }) });
  const unnamed = await fetch(`${origin}/api/feedback/screenshot?id=not-an-id`, { method: 'POST', body: jpeg,
    headers: { 'X-Viewer-Request': '1', 'Content-Type': 'image/jpeg' } });
  assert.deepEqual([foreign.status, unnamed.status], [403, 404]);
  assert.equal(seen.length, 3);
});
