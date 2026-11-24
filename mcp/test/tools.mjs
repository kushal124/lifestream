// @ts-check
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHandler } from '../server.mjs';
import { DoorRefusal } from '../lib/errors.mjs';
import { ASK_TOOLS, onceMore, TOOLS } from '../lib/tools.mjs';
import { MAX_CHARS, NOTE } from '../lib/shape.mjs';
import { command, home, named, note, startHome, stopHome } from './asking.mjs';

const ARTIFACT = fileURLToPath(new URL('../../.build/e2e/tools.json', import.meta.url));
const DAY = '2026-09-28';
const SAME_NAME = 'the same full name';

/** @type {string[]} */
const asked = [];
/** @type {import('node:http').Server[]} */
const servers = [];
/** @type {Client} */
let agent;
let url = '';

/** @param {import('node:http').RequestListener} handler */
async function listen(handler) {
  const server = createServer(handler);
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  servers.push(server);
  return `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
}

/** @param {string} at @param {string} pass */
async function connect(at, pass) {
  const client = new Client({ name: 'lifestream-tools', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${at}/mcp`), { requestInit: { headers: { authorization: `Bearer ${pass}` } } }));
  return client;
}

/**
 * @param {string} tool
 * @param {Record<string, unknown>} args
 * @param {Client} [client]
 */
async function call(tool, args, client = agent) {
  const result = /** @type {{ content: { type: string, text: string }[], isError?: boolean }} */ (await client.callTool({ name: tool, arguments: args }));
  const text = result.content.map(part => part.text).join('\n');
  note({ tool, args, error: result.isError === true, answer: text.slice(0, 4_000) });
  assert.ok(text.length <= MAX_CHARS + 500, `${tool} answered ${text.length} characters`);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { text, json, error: result.isError === true };
}

before(async () => {
  await startHome('http://127.0.0.1:9');
  const door = await listen((request, response) => {
    asked.push(String(request.url));
    const onward = httpRequest(`${home.url}${request.url}`, { method: request.method, headers: { ...request.headers, host: new URL(home.url).host } }, answer => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    });
    onward.on('error', () => response.destroy());
    request.pipe(onward);
  });
  url = await listen(createHandler({ door, machine: home.ask.machine, log: () => undefined }));
  agent = await connect(url, home.tokens.agent);
});

after(async () => {
  await agent?.close();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise(done => server.close(() => done(undefined)));
  }
  await stopHome(ARTIFACT);
});


test('1: four tools, feedback and access, each described as the spec words it; Ask\'s read opens links besides, and Ask has no access', async () => {
  named('the four tools');
  const { tools } = await agent.listTools();
  assert.deepEqual(tools.map(tool => tool.name), ['search_people', 'search', 'count', 'read', 'feedback', 'access']);
  const spec = Object.fromEntries(TOOLS.slice(0, 4).map(tool => [tool.name, tool.description]));
  assert.deepEqual(Object.fromEntries(tools.slice(0, 4).map(tool => [tool.name, tool.description])), spec);
  const ask = /** @type {string} */ (ASK_TOOLS[3]?.description);
  assert.ok(ask.startsWith(`${spec.read} \`link\`:`), ask);
  assert.deepEqual(ASK_TOOLS.map(tool => [tool.name, tool.description]), [...Object.entries({ ...spec, read: ask }), ['feedback', TOOLS[4]?.description]]);
});

test('2: who lists two contacts of one name apart, says which was in touch when; a person\'s handle filters search with no query', async () => {
  named('search_people');
  const both = await call('search_people', { name: 'Person D' });
  assert.equal(both.error, false, both.text);
  assert.equal(both.json.matches.length, 2);
  assert.equal(both.json.note, `${NOTE} two contacts go by this name; each match's \`reach\` says when it was in touch.`);
  assert.deepEqual(both.json.matches.map((/** @type {any} */ each) => [each.handles, each.reach]),
    [[['+15550000004'], { messages: [3, '2026-09-25', '2026-09-25'] }], [['+15550000005'], undefined]]);
  assert.notEqual(both.json.matches[0].ref, both.json.matches[1].ref);

  const a = await call('search_people', { name: 'Person A' });
  const personA = a.json.matches.find((/** @type {any} */ each) => each.name === 'Person A');
  const theirs = await call('search', { person: [personA.ref], lists: ['record'] });
  assert.equal(theirs.error, false, theirs.text);
  assert.deepEqual(theirs.json.person, [{ asked: personA.ref, ref: personA.ref, name: 'Person A' }]);
  assert.ok(theirs.json.record.total >= 3, theirs.text);
  assert.ok(theirs.json.record.hits.some((/** @type {any} */ hit) => /lighthouse tickets/u.test(hit.snippet)), theirs.text);
  const opened = (await call('read', { ref: personA.ref })).json;
  assert.deepEqual([opened.what, opened.match.ref, opened.match.name], ['people', personA.ref, 'Person A']);
  const chat = (await call('read', { ref: personA.chats[0].chat })).json;
  assert.deepEqual([chat.what, chat.latest.what], ['people', 'chat']);
  assert.deepEqual(chat.latest.lines.map((/** @type {any} */ line) => [line.at.slice(11, 16), line.from, line.text]),
    [['08:00', 'Person A', 'synthetic hello one'], ['08:05', 'the user', 'synthetic reply two'], ['08:06', 'Person A', 'got two lighthouse tickets for Sunday']]);
});

test('7: search_people: two contacts of one name tied by their handles, the note naming them by handle; reach as count counts it; a near spelling said in near; what else goes by a word', async () => {
  named('who tied');
  const both = await call('search_people', { name: 'Person D' });
  const [one, two] = both.json.matches;
  assert.deepEqual([one.tied, two.tied], [[two.ref], [one.ref]]);
  assert.deepEqual([one.same, two.same], [[{ ref: two.ref, why: SAME_NAME }], [{ ref: one.ref, why: SAME_NAME }]]);
  assert.deepEqual([one.reach, two.reach], [{ messages: [3, '2026-09-25', '2026-09-25'] }, undefined]);
  assert.doesNotMatch(both.json.note, /phone:|\+1555|person\./u);
  for (const [each, n] of /** @type {const} */ ([[one, 3], [two, 0]])) {
    const counted = await call('count', { of: 'messages', person: [each.ref] });
    assert.deepEqual([counted.error, counted.json.matched?.person, counted.json.total.n], [false, { [each.ref]: ['Person D'] }, n], counted.text);
  }

  const a = (await call('search_people', { name: 'Person A' })).json.matches.find((/** @type {any} */ each) => each.name === 'Person A');
  assert.deepEqual(a.reach, { messages: [3, DAY, DAY] });
  assert.equal((await call('count', { of: 'messages', person: [a.ref] })).json.total.n, 3);
  assert.deepEqual(a.chats.map((/** @type {any} */ chat) => [chat.title, chat.messages]), [['Person A', 3]]);

  const from = asked.length;
  const near = await call('search_people', { name: 'Persn A' });
  assert.deepEqual(near.json.matches.map((/** @type {any} */ each) => [each.ref, each.name]), [[a.ref, 'Person A']], near.text);
  assert.deepEqual(asked.slice(from).filter(path => path !== '/v1/me'), ['/v1/people/search'], 'one POST of the route, the name in its body');

  const word = await call('search_people', { name: 'lighthouse' });
  assert.deepEqual(word.json.matches, []);
  assert.ok(word.json.elsewhere.some((/** @type {any} */ each) => each.as === 'words' && each.n >= 1), word.text);
});

test('8: a chat\'s handle and a place filter search and count; a name no one is and a name of two people are one plain line each, the two by their handles', async () => {
  named('person lines');
  const a = (await call('search_people', { name: 'Person A' })).json.matches.find((/** @type {any} */ each) => each.name === 'Person A');
  const chat = a.chats[0].chat;
  const byChat = await call('count', { of: 'messages', chat });
  assert.deepEqual([byChat.error, byChat.json.total?.n], [false, 3], byChat.text);
  const inChat = await call('search', { chat, lists: ['record'] });
  assert.deepEqual([inChat.error, inChat.json.record.total], [false, 3], inChat.text);
  const there = await call('search', { place: 'New York', lists: ['record'] });
  assert.equal(there.error, false, there.text);
  assert.ok(there.json.record.total > 0 && there.json.record.hits.every((/** @type {any} */ hit) => /New York/u.test(hit.the_user_was_at)), there.text);

  const nobody = await call('search', { person: ['Nobody Zed'] });
  assert.equal(nobody.error, true, nobody.text);
  assert.match(nobody.text, /^No such person: .*Nobody Zed.*`search_people`.*\n\nIf this got in your way/u);
  const d = (await call('search_people', { name: 'Person D' })).json.matches.map((/** @type {any} */ each) => each.ref);
  for (const [tool, args] of /** @type {const} */ ([['search', { person: ['Person D'] }], ['count', { of: 'messages', person: ['Person D'] }]])) {
    const several = await call(tool, args);
    assert.equal(several.error, true, several.text);
    assert.equal(several.text.split('\n')[0], `Several people go by Person D: ask by one of their refs. Find them with \`search_people\`. They are: ${d[0]} Person D; ${d[1]} Person D. Pass the one meant as \`person\`, by its handle.`);
  }
});

test('3: a count\'s sum, and its row\'s handle read back as the facts behind it, each fact\'s handle as that fact alone', async () => {
  named('count');
  const sum = await call('count', { of: 'stays', measure: 'minutes' });
  assert.equal(sum.error, false, sum.text);
  assert.deepEqual([sum.json.total.n, sum.json.total.sum], [2, 584.67]);
  assert.match(sum.json.asked, /^sum of minutes over stays/u);
  assert.match(sum.json.total.ref, /^r\d+$/u);
  const behind = await call('read', { ref: sum.json.total.ref });
  assert.equal(behind.error, false, behind.text);
  assert.equal(behind.json.what, 'row');
  assert.deepEqual(behind.json.rows.map((/** @type {unknown[]} */ row) => row.at(-2)), [240.33, 344.33]);
  const facts = behind.json.rows.map((/** @type {unknown[]} */ row) => row.at(-1));
  const one = await call('read', { ref: facts[0] });
  assert.deepEqual([one.json.what, one.json.ref, one.json.lines.find((/** @type {any} */ line) => line.ref === facts[0])?.text], ['line', facts[0], 'At an unnamed place in New York City']);
  const both = await call('read', { ref: facts });
  assert.deepEqual(both.json.opened.map((/** @type {any} */ each) => [each.what, each.ref]), [['line', facts[0]], ['line', facts[1]]]);
  const catalog = await call('count', {});
  assert.ok(catalog.json.collections.find((/** @type {any} */ each) => each.of === 'messages').keys.includes('person'), catalog.text);
  const byPerson = await call('count', { of: 'messages', by: ['person'] });
  assert.equal(byPerson.json.total.n, 210);
  const a = (await call('search_people', { name: 'Person A' })).json.matches.find((/** @type {any} */ each) => each.name === 'Person A');
  const theirs = await call('count', { of: 'messages', person: [a.ref], by: ['day'] });
  assert.deepEqual(theirs.json.rows.map((/** @type {unknown[]} */ row) => row.slice(0, 2)), [[DAY, 3]]);
});


test('5: each refusal is one plain line saying what to do; a home still building is asked once more within its bound, then said, never as a record that holds nothing', async () => {
  named('refusals');
  /** @param {string} code @param {string} said @param {number | null} [retry] */
  const line = (code, said, retry = null) => new DoorRefusal(code === 'BAD_PARAMETER' ? 422 : 503, code, said, retry).message;
  assert.deepEqual([
    line('INDEX_BUILDING', 'this number is not whole yet: days owed 2026-09-28', 5),
    new DoorRefusal(422, 'TOO_BROAD', 'this count would read about 90000 facts of messages: ask from=2026-01-01 or later', null, { fits: { from: '2026-01-01', to: '2026-03-31' } }).message,
    line('TOO_BROAD', 'not one day of the words\' matches fits one call\'s count of messages: ask with more words, each of which must appear, or rarer ones'),
    line('CURSOR_EXPIRED', 'what this page was read from changed since it was given (the index was built again, something was erased, or what the ask named changed): ask again'),
    line('LINE_MOVED', '2026-09-28 was written again'),
    line('BAD_PARAMETER', 'payments has no key sport; its keys: payee, account, direction, channel'),
  ], [
    'The home could not answer this yet: it is still building what it reads (this number is not whole yet: days owed 2026-09-28). Ask again in 5 s; this says nothing of what the record holds.',
    'Too much to count in one call. 2026-01-01 → 2026-03-31 fits: ask it, then the rest with `to: 2025-12-31`.',
    'Too much to count in one call, and not one whole day of it fits, so no range would: not one day of the words\' matches fits one call\'s count of messages: ask with more words, each of which must appear, or rarer ones.',
    'That cursor or handle no longer holds: what this page was read from changed since it was given (the index was built again, something was erased, or what the ask named changed): ask again, without it.',
    'That day line moved since its handle was given (2026-09-28 was written again): read the day again, or search for the line.',
    'An argument is not one this takes: payments has no key sport; its keys: payee, account, direction, channel. Fix it and ask again.',
  ]);
  /** @type {number[]} */
  const waits = [];
  const wait = async (/** @type {number} */ ms) => void waits.push(ms);
  /** @param {(DoorRefusal | string)[]} answers */
  const runs = answers => {
    let runs = 0;
    const tool = onceMore({ run: async (/** @type {unknown} */ _args, /** @type {unknown} */ _context) => {
      const answer = answers[runs++];
      if (answer instanceof DoorRefusal) throw answer;
      return answer;
    } }, { wait });
    return { run: () => tool.run({}, {}), count: () => runs };
  };
  const building = () => new DoorRefusal(503, 'INDEX_BUILDING', 'this number is not whole yet', 5);
  const once = runs([building(), 'whole']);
  assert.deepEqual([await once.run(), once.count(), waits], ['whole', 2, [5_000]]);
  const twice = runs([building(), building(), 'never']);
  await assert.rejects(twice.run(), /^Error: The home could not answer this yet/u);
  assert.equal(twice.count(), 2);
  const long = runs([new DoorRefusal(503, 'INDEX_BUILDING', 'a rebuild', 600), 'never']);
  await assert.rejects(long.run(), /Ask again in 600 s/u);
  assert.equal(long.count(), 1);
  const broad = runs([new DoorRefusal(422, 'TOO_BROAD', 'too much', null), 'never']);
  await assert.rejects(broad.run(), /^Error: Too much to count/u);
  assert.equal(broad.count(), 1);

  let counts = 0;
  const buildingDoor = await listen(async (request, response) => {
    if (request.url === '/v1/me') return void response.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"p-synthetic","kind":"agent"}');
    let raw = '';
    for await (const chunk of request) raw += String(chunk);
    const body = raw === '' ? {} : JSON.parse(raw);
    const json = (/** @type {number} */ status, /** @type {unknown} */ answer, /** @type {Record<string, string>} */ headers = {}) =>
      void response.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(answer));
    if (request.url === '/v1/count' && request.method === 'POST' && body.args?.of === 'payments') {
      counts++;
      return json(503, { code: 'INDEX_BUILDING', message: 'this number is not whole yet: payments building' }, { 'retry-after': '1' });
    }
    return json(404, { code: 'NO_ROUTE', message: 'not here' });
  });
  const client = await connect(await listen(createHandler({ door: buildingDoor, machine: home.ask.machine, log: () => undefined })), home.tokens.agent);
  try {
    const said = await call('count', { of: 'payments', measure: 'amount' }, client);
    assert.equal(said.error, true);
    assert.equal(said.text.split('\n')[0], 'The home could not answer this yet: it is still building what it reads (this number is not whole yet: payments building). Ask again in 1 s; this says nothing of what the record holds.');
    assert.equal(counts, 2);
  } finally {
    await client.close();
  }
});

test('5: the door\'s own refusal of an argument, through its one path, is one plain line', async () => {
  const bad = await call('count', { of: 'messages', by: ['sport'] });
  assert.match(bad.text, /^An argument is not one this takes: messages has no key sport; its keys: .*\. Fix it and ask again\./u);
});

test('6: under a level that hides, count is posted to the door\'s one path, which hides it; a placeholder given is said back as itself', async () => {
  named('count hidden');
  await command({ cmd: 'privacy', agent: 'all' });
  const hiding = await connect(url, home.tokens.agent);
  try {
    const found = await call('search', { query: 'lighthouse' }, hiding);
    const placeholder = /\[\[Person [1-9][0-9]*\]\]/u.exec(found.text)?.[0];
    assert.ok(placeholder !== undefined, found.text);
    const counted = await call('count', { of: 'messages', person: [placeholder], by: ['day'] }, hiding);
    assert.equal(counted.error, false, counted.text);
    assert.ok(counted.text.includes(placeholder), counted.text);
    assert.doesNotMatch(counted.text, /Person A|15550000001/u);
    assert.deepEqual(counted.json.rows.map((/** @type {unknown[]} */ row) => row.slice(0, 2)), [[DAY, 3]]);
    assert.ok(asked.some(path => path === '/v1/count'));
    assert.ok(!asked.some(path => path === '/v1/hide-details' || path === '/v1/restore-details'), 'a route read asks no hide or restore of the server\'s');
    const who = await call('search_people', { name: placeholder }, hiding);
    const handle = who.json.matches.find((/** @type {any} */ each) => each.name === placeholder).ref;
    const byHandle = await call('count', { of: 'messages', person: [handle], by: ['day'] }, hiding);
    assert.deepEqual(byHandle.json.rows.map((/** @type {unknown[]} */ row) => row.slice(0, 2)), [[DAY, 3]]);
    assert.doesNotMatch(byHandle.text, /Person A|15550000001/u);
  } finally {
    await hiding.close();
    await command({ cmd: 'privacy', agent: null });
  }
});

test('11: under a level that hides, search_people matches a placeholder exactly and names no one plain; a guessed name answered as names hidden, never as a name no one has; a brief\'s names are placeholders', async () => {
  named('who hidden');
  await command({ cmd: 'privacy', agent: 'all' });
  const hiding = await connect(url, home.tokens.agent);
  try {
    const guess = await call('search_people', { name: 'Person A' }, hiding);
    assert.deepEqual([guess.error, guess.json.matches, guess.json.note], [false, [], `${NOTE} Names are hidden from you, so no one is found by a name. Find the person in \`search\` or \`read\`, then give the placeholder shown for them as \`name\`.`], guess.text);
    const found = await call('search', { query: 'lighthouse' }, hiding);
    const placeholder = /\[\[Person [1-9][0-9]*\]\]/u.exec(found.text)?.[0] ?? '';
    const shown = await call('search_people', { name: placeholder }, hiding);
    assert.equal(shown.error, false, shown.text);
    const match = shown.json.matches.find((/** @type {any} */ each) => each.name === placeholder);
    assert.ok(match !== undefined, shown.text);
    assert.deepEqual(match.reach, { messages: [3, DAY, DAY] });
    assert.doesNotMatch(shown.text, /Person [ACD]\b|\bPim\b|person-[ac]|1555000000\d/iu);
    assert.ok((match.also ?? []).length > 0, shown.text);
    assert.equal((await call('count', { of: 'messages', person: [match.ref] }, hiding)).json.total.n, 3);
    const brief = await call('read', { from: DAY, detail: 'brief' }, hiding);
    const lines = brief.json.days[0].lines.map((/** @type {any} */ line) => line.text);
    assert.ok(lines.some((/** @type {string} */ line) => line.endsWith(` ${placeholder}: 3 messages`)), brief.text);
    assert.ok(lines.some((/** @type {string} */ line) => /^11:00 Mail from \[\[Person \d+\]\] to the user/u.test(line)), brief.text);
    assert.doesNotMatch(brief.text, /Person [AC]\b/u);
    const two = await call('search_people', { name: 'Person D' }, hiding);
    assert.deepEqual(two.json.matches, [], two.text);
    const marmalade = await call('search', { query: 'marmalade' }, hiding);
    const namesake = /\[\[Person [1-9][0-9]*\]\]/u.exec(marmalade.text)?.[0] ?? '';
    const same = await call('search_people', { name: namesake }, hiding);
    const [first] = same.json.matches;
    assert.equal(same.json.matches.length, 1, same.text);
    assert.equal(first.name, namesake);
    assert.match(String(first.ref), /^r\d+$/u);
    assert.deepEqual(first.same.map((/** @type {any} */ each) => [/^r\d+$/u.test(each.ref) && each.ref !== first.ref, each.why]), [[true, SAME_NAME]], same.text);
    assert.doesNotMatch(same.text, /Person [ACD]\b|1555000000\d/u);
  } finally {
    await hiding.close();
    await command({ cmd: 'privacy', agent: null });
  }
});

test('Ask\'s read opens a link the person wrote; an agent\'s does not', () => {
  const read = /** @type {any} */ (ASK_TOOLS.find(tool => tool.name === 'read'));
  assert.ok('link' in read.inputSchema);
  assert.ok(!('link' in /** @type {any} */ (TOOLS.find(tool => tool.name === 'read')).inputSchema));
});
