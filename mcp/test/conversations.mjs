// @ts-check
import { createHash } from 'node:crypto';
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { openConversations, pendingFolder, UNTAKEN } from '../lib/ask/conversations.mjs';
import { until } from './until.mjs';

const SOURCE = 'ask:local:macbook-pro-0001';
const CHAT = '1792396847000-3fa9c2';
const AT = 1_792_396_850_000;
/** @param {number} n @param {'user' | 'assistant'} role @param {string} text */
const msg = (n, role, text) => ({ type: 'ask.msg', chat: CHAT, n, at_ms: AT + n, role, text });

/** @typedef {ReturnType<typeof openConversations>} Conversations */

/**
 * @param {Conversations} conversations
 * @param {string} title
 * @param {import('../lib/ask/conversations.mjs').Message} question
 * @param {string} submission
 * @param {boolean} [files]
 */
const begin = (conversations, title, question, submission, files = false) =>
  conversations.begin({ title, chat: question.chat, n: question.n, submission, files, question });

/**
 * @param {Conversations} conversations
 * @param {import('../lib/door.mjs').Door} door
 * @param {string} chat
 */
const readOf = async (conversations, door, chat) => {
  const read = await conversations.read(door, chat);
  assert.ok(!('absent' in read), JSON.stringify(read));
  return read;
};

/** @param {Awaited<ReturnType<typeof begin>>} begun */
const held = begun => {
  assert.ok('conversation' in begun, JSON.stringify(begun));
  return begun.conversation;
};

const emptyHome = /** @type {any} */ ({ json: async (/** @type {string} */ path) => path === '/v1/sources' ? { sources: [] } : path === '/v1/records' ? { records: [] } : {} });

/**
 * @param {boolean} [keyed]
 * @returns {import('../lib/door.mjs').Door}
 */
function homeDoor(keyed = false) {
  const messages = [msg(1, 'user', 'Is the synthetic harbour quiet?'), msg(2, 'assistant', 'It is quiet.')];
  /** @type {Record<string, (params: Record<string, unknown>) => unknown>} */
  const routes = {
    '/v1/me': () => ({ id: 'p-synthetic', kind: null, resource: null, ...(keyed ? { keyed: true } : {}) }),
    '/v1/sources': () => ({ sources: [{ id: SOURCE, connector: 'ask-home' }] }),
    '/v1/record': () => ({ version: { content: { type: 'ask.chat', title: 'Is the synthetic harbour quiet?', at_ms: AT + 2 } } }),
    '/v1/records': params => (params.kind === 'chat'
      ? { records: [{ key: CHAT, content: { type: 'ask.chat', title: 'Is the synthetic harbour quiet?', at_ms: AT + 2 } }] }
      : { records: messages.map(content => ({ content })) }),
  };
  return /** @type {any} */ ({ json: async (/** @type {string} */ path, /** @type {Record<string, unknown>} */ params) => routes[path](params) });
}

/**
 * @param {{ statements: unknown[], kept_ms: number }[]} deliveries
 * @param {(opened: ReturnType<typeof openConversations>, folder: string) => Promise<void>} use
 */
async function started(deliveries, use) {
  const machine = mkdtempSync(join(tmpdir(), 'lifestream-mcp-conversations-'));
  const opened = { current: /** @type {ReturnType<typeof openConversations> | null} */ (null) };
  try {
    mkdirSync(pendingFolder(machine), { recursive: true });
    deliveries.forEach((delivery, at) => writeFileSync(join(pendingFolder(machine), `${String(at + 1).padStart(12, '0')}-0000000${at}.json`),
      JSON.stringify({ source: SOURCE, made_ms: AT + 10, ...delivery })));
    opened.current = openConversations({ machine, door: 'http://127.0.0.1:9', log: () => undefined });
    await use(opened.current, pendingFolder(machine));
  } finally {
    await opened.current?.settle(0);
    rmSync(machine, { recursive: true, force: true });
  }
}

test('1, 2: a title waiting alone names the home\'s conversation in the list and in its read, its messages the home\'s', async () => {
  const title = { kind: 'chat', key: CHAT, content: { type: 'ask.chat', title: 'Synthetic harbour', at_ms: AT + 2 } };
  await started([{ statements: [title], kept_ms: Date.now() }], async conversations => {
    const door = homeDoor();
    assert.deepEqual((await conversations.list(door, undefined)).chats,
      [{ chat: CHAT, title: 'Synthetic harbour', first_ms: Number(CHAT.slice(0, 13)), last_ms: AT + 2, messages: 2 }]);
    const read = await readOf(conversations, door, CHAT);
    assert.deepEqual([read.title, read.messages.map(message => message.n)], ['Synthetic harbour', [1, 2]]);
  });
});

test('3: while a turn waits under its hour, in how long it turns an hour old; 0 once past it, and null with nothing waiting', async () => {
  const turn = [{ kind: 'msg', key: `${CHAT}:0001`, content: msg(1, 'user', 'Anything?') }];
  await started([{ statements: turn, kept_ms: Date.now() - 20 * 60_000 }], async conversations => {
    const left = conversations.unsavedIn();
    assert.ok(left !== null && left > 39 * 60_000 && left <= 40 * 60_000, String(left));
  });
  await started([{ statements: turn, kept_ms: Date.now() - 61 * 60_000 }], async conversations => {
    assert.equal(conversations.unsavedIn(), 0);
  });
  await started([], async conversations => {
    assert.equal(conversations.unsavedIn(), null);
  });
});

test('4: a turn its disk cannot hold is refused before anything is told of it; an answer its disk cannot hold is told `unsaved` beside how it ended, by finish and by every read, never in what is kept, until it is written', async () => {
  const OTHER = '1792396900000-4ab0d3';
  /**
   * @param {number} n @param {'user' | 'assistant'} role @param {string} text
   * @param {Partial<import('../lib/ask/conversations.mjs').Message>} [more]
   * @returns {import('../lib/ask/conversations.mjs').Message}
   */
  const said = (n, role, text, more = {}) => ({ type: 'ask.msg', chat: OTHER, n, at_ms: AT + 100 + n, role, text, ...more });
  const done = said(2, 'assistant', 'The synthetic tide turns at six.', { end: 'done' });
  const failed = said(4, 'assistant', 'It was', { end: 'failed', failed: 'model', error: 'OpenRouter didn\'t answer: your OpenRouter account is out of credits.' });
  await started([], async (conversations, folder) => {
    const door = homeDoor();
    assert.equal(await conversations.knowsSource(door), true);
    const tide = held(await begin(conversations, 'The tide', said(1, 'user', 'When does the tide turn?'), '1'.repeat(32)));
    held(await begin(conversations, 'The tide', said(3, 'user', 'And tomorrow?'), '3'.repeat(32)));
    chmodSync(folder, 0o500);
    try {
      assert.deepEqual(await begin(conversations, 'Elsewhere', { ...said(1, 'user', 'Never kept?'), chat: CHAT }, 'e'.repeat(32)), { unsaved: true });
      assert.equal(conversations.get(CHAT), undefined);
      assert.deepEqual(await conversations.finish(tide, 'The tide', done), { ...done, unsaved: true });
      assert.deepEqual(await conversations.finish(tide, 'The tide', failed), { ...failed, unsaved: true });
      const read = await readOf(conversations, door, OTHER);
      assert.deepEqual(read.messages.map(message => [message.n, message.end, message.failed, message.unsaved]),
        [[1, undefined, undefined, undefined], [2, 'done', undefined, true], [3, undefined, undefined, undefined], [4, 'failed', 'model', true]]);
      assert.equal(read.messages[3]?.error, failed.error);
      assert.equal('unsaved' in done, false, 'the held message is told, never changed');
    } finally {
      chmodSync(folder, 0o700);
    }
    await conversations.settle(0);
    const files = readdirSync(folder);
    assert.equal(files.length, 2);
    assert.equal(files.some(file => readFileSync(join(folder, file), 'utf8').includes('unsaved')), false);
    const read = await readOf(conversations, door, OTHER);
    assert.deepEqual(read.messages.map(message => [message.n, message.end, 'unsaved' in message]),
      [[1, undefined, false], [2, 'done', false], [3, undefined, false], [4, 'failed', false]]);
  });
});

/** @param {{ answer?: (statements: any[]) => { status: number, body?: unknown } | 'lost' | Promise<{ status: number, body?: unknown }>, stage?: (file: string, bytes: Buffer) => number }} [script] */
async function standIn(script = {}) {
  const { createServer } = await import('node:http');
  const { inflateRawSync } = await import('node:zlib');
  /** @type {{ path: string, statements: any[], status: number }[]} */
  const puts = [];
  /** @type {Set<string>} */
  const erased = new Set();
  /** @type {string[]} */
  const drops = [];
  /** @type {{ file: string, bytes: Buffer }[]} */
  const staged = [];
  const server = createServer((request, response) => {
    const chunks = /** @type {Buffer[]} */ ([]);
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', async () => {
      const body = Buffer.concat(chunks);
      const send = (/** @type {number} */ status, /** @type {unknown} */ said) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(said));
      };
      if (request.method === 'GET' && request.url?.startsWith('/v1/ask/erased?')) {
        return send(200, { erased: new URL(request.url, 'http://door').searchParams.getAll('chat').filter(chat => erased.has(chat)) });
      }
      if (request.method === 'DELETE') {
        drops.push(String(request.url).slice('/v1/ask/files/'.length));
        return send(200, { dropped: true });
      }
      if (request.method === 'PUT' && request.url?.startsWith('/v1/ask/files/')) {
        const file = request.url.slice('/v1/ask/files/'.length);
        staged.push({ file, bytes: body });
        const status = script.stage?.(file, body) ?? 200;
        return send(status, status === 200 ? { file } : { code: 'STAGE_FULL' });
      }
      const named = body.readUInt16LE(26);
      const size = body.readUInt32LE(18);
      const start = 30 + named + body.readUInt16LE(28);
      const text = (body.readUInt16LE(8) === 8 ? inflateRawSync(body.subarray(start, start + size)) : body.subarray(start, start + size)).toString('utf8');
      const statements = text.split('\n').filter(line => line !== '').map(line => JSON.parse(line));
      const put = { path: String(request.url), statements, status: 0 };
      puts.push(put);
      const answer = await (script.answer?.(statements) ?? { status: 201 });
      if (answer === 'lost') return void request.socket.destroy();
      put.status = answer.status;
      send(answer.status, answer.body ?? {});
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { url: `http://127.0.0.1:${address.port}`, puts, erased, drops, staged, close: () => new Promise(done => {
    server.closeAllConnections();
    server.close(() => done(undefined));
  }) };
}

/**
 * @param {string} door
 * @param {(opened: ReturnType<typeof openConversations>, machine: string) => Promise<void>} use
 * @param {{ envelopes?: unknown[], machine?: string, onLetGo?: (conversation: import('../lib/ask/conversations.mjs').Conversation, n: number | null) => void, resumeMs?: number, keyed?: boolean }} [given]
 */
async function delivering(door, use, given = {}) {
  const machine = given.machine ?? mkdtempSync(join(tmpdir(), 'lifestream-mcp-envelopes-'));
  mkdirSync(join(machine, 'ask'), { recursive: true });
  writeFileSync(join(machine, 'ask', 'door-token'), 'synthetic-ask-pass\n');
  mkdirSync(pendingFolder(machine), { recursive: true });
  (given.envelopes ?? []).forEach((envelope, at) => writeFileSync(join(pendingFolder(machine), `${String(at + 1).padStart(12, '0')}-0000000${at}.json`), JSON.stringify(envelope)));
  const conversations = openConversations({ machine, door, log: () => undefined, ...(given.onLetGo === undefined ? {} : { onLetGo: given.onLetGo }), ...(given.resumeMs === undefined ? {} : { resumeMs: given.resumeMs }) });
  try {
    await conversations.knowsSource(homeDoor(given.keyed));
    await use(conversations, machine);
  } finally {
    await conversations.settle(0);
    if (given.machine === undefined) rmSync(machine, { recursive: true, force: true });
  }
}

/** @param {string} chat @param {number} n @param {'user' | 'assistant'} role @param {string} text @param {object} [more] */
const of = (chat, n, role, text, more = {}) => /** @type {import('../lib/ask/conversations.mjs').Message} */ ({ type: 'ask.msg', chat, n, at_ms: AT + n, role, text, ...more });
/** @param {{ statements: any[] }[]} puts */
const stated = puts => puts.map(put => put.statements.filter(each => each.kind === 'msg').map(each => `${each.content.chat.slice(-2)}:${each.content.n}${each.content.role === 'assistant' ? `:${each.content.end}` : ''}`).join(' '));

test('5: a question is delivered at once, its marker held while its turn runs and passed over, so another conversation\'s turn goes; the answer goes over the marker once the turn ends, never before its question, and the envelope then goes, its submission remembered', async () => {
  const door = await standIn();
  const A = '1792396847000-aaaaa1';
  const B = '1792396848000-bbbbb2';
  try {
    await delivering(door.url, async (conversations, machine) => {
      const a = held(await begin(conversations, 'A', of(A, 1, 'user', 'First?'), 'a'.repeat(32)));
      const b = held(await begin(conversations, 'B', of(B, 1, 'user', 'Second?'), 'b'.repeat(32)));
      conversations.finish(b, 'B', of(B, 2, 'assistant', 'B answered.', { end: 'done' }));
      await conversations.settle(0);
      assert.deepEqual(stated(door.puts), ['a1:1', 'b2:1', 'b2:2:done']);
      assert.equal(readdirSync(pendingFolder(machine)).length, 1, 'A\'s envelope stands while its turn runs');
      assert.deepEqual(conversations.submitted('b'.repeat(32)), { state: 'delivered', chat: B, n: 2 });
      assert.deepEqual(conversations.submitted('a'.repeat(32)), { state: 'pending', chat: A, n: 2 }, 'a running turn\'s submission is pending');
      conversations.finish(a, 'A', of(A, 2, 'assistant', 'A answered.', { end: 'done' }));
      await conversations.settle(5_000);
      assert.deepEqual(stated(door.puts), ['a1:1', 'b2:1', 'b2:2:done', 'a1:2:done']);
      assert.deepEqual(readdirSync(pendingFolder(machine)), []);
      const remembered = readFileSync(join(machine, 'ask', 'submitted.ndjson'), 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line));
      assert.deepEqual(remembered.map(({ kept_ms: _kept, ...line }) => line), [{ submission: 'b'.repeat(32), chat: B, n: 2 }, { submission: 'a'.repeat(32), chat: A, n: 2 }]);
    });
  } finally {
    await door.close();
  }
});

/**
 * @param {string} chat
 * @param {boolean} delivered
 * @param {string} submission
 */
const envelope = (chat, delivered, submission) => ({
  source: SOURCE, made_ms: AT + 1, kept_ms: Date.now(),
  statements: [{ kind: 'chat', key: chat, content: { type: 'ask.chat', title: 'T', at_ms: AT + 1 } },
    { kind: 'msg', key: `${chat}:0002`, content: of(chat, 2, 'assistant', '', { end: 'failed', failed: 'restart', error: 'Chat restarted before this answer finished.' }) }],
  turn: { submission, chat, n: 2, delivered, finished: false,
    question: { made_ms: AT + 1, statements: [{ kind: 'chat', key: chat, content: { type: 'ask.chat', title: 'T', at_ms: AT + 1 } }, { kind: 'msg', key: `${chat}:0001`, content: of(chat, 1, 'user', 'Q?') }] } },
});

test('6: a server that died mid-turn: at its start an envelope whose question never landed sends it, then its marker as `failed` `restart`; one delivered sends its marker alone; a submission is answered from the file past its envelope, and one older than 30 days is forgotten', async () => {
  const door = await standIn();
  const A = '1792396847000-aaaaa1';
  const B = '1792396848000-bbbbb2';
  const machine = mkdtempSync(join(tmpdir(), 'lifestream-mcp-envelopes-'));
  mkdirSync(join(machine, 'ask'), { recursive: true });
  writeFileSync(join(machine, 'ask', 'submitted.ndjson'), [
    { submission: 'c'.repeat(32), chat: B, n: 4, kept_ms: Date.now() - 31 * 24 * 3_600_000 },
    { submission: 'd'.repeat(32), chat: B, n: 6, kept_ms: Date.now() - 24 * 3_600_000 },
  ].map(line => `${JSON.stringify(line)}\n`).join(''));
  try {
    await delivering(door.url, async conversations => {
      await conversations.settle(5_000);
      assert.deepEqual(stated(door.puts), ['a1:1', 'a1:2:failed', 'b2:2:failed']);
      assert.equal(door.puts[1]?.statements[1].content.failed, 'restart');
      const read = await readOf(conversations, emptyHome, A);
      assert.deepEqual(read.messages.map(message => [message.n, message.role, message.end]), [[1, 'user', undefined], [2, 'assistant', 'failed']]);
      assert.equal(conversations.submitted('c'.repeat(32)), null, 'a submission past 30 days is forgotten');
      assert.deepEqual(conversations.submitted('d'.repeat(32)), { state: 'delivered', chat: B, n: 6 });
      assert.deepEqual(conversations.submitted('a'.repeat(32)), { state: 'delivered', chat: A, n: 2 });
    }, { envelopes: [envelope(A, false, 'a'.repeat(32)), envelope(B, true, 'e'.repeat(32))], machine });
    assert.equal(readFileSync(join(machine, 'ask', 'submitted.ndjson'), 'utf8').includes('c'.repeat(32)), false);
  } finally {
    await door.close();
    rmSync(machine, { recursive: true, force: true });
  }
});

const ERASED_ANSWER = { status: 422, body: { code: 'CHAT_ERASED', message: 'This conversation was erased.' } };
const PHOTO = `sha256:${'1'.repeat(64)}`;

/** @param {any[]} statements */
const sealing = statements => statements.some(each => Array.isArray(each.content?.photos));

test('7, 9: a seal the door refuses `CHAT_ERASED` erases its conversation: the begin told erased, its envelope let go whole, nothing of the turn delivered after, its submission told erased; nothing of the erasure on this server\'s disk', async () => {
  const A = '1792396847000-aaaaa1';
  const door = await standIn({ answer: statements => statements.some(each => each.key === A) ? ERASED_ANSWER : { status: 201 } });
  const machine = mkdtempSync(join(tmpdir(), 'lifestream-mcp-envelopes-'));
  try {
    await delivering(door.url, async conversations => {
      assert.deepEqual(await begin(conversations, 'A', of(A, 1, 'user', 'Erased?', { photos: [PHOTO] }), 'a'.repeat(32), true), { erased: true });
      assert.deepEqual(readdirSync(pendingFolder(machine)), []);
      await conversations.settle(5_000);
      assert.deepEqual(door.puts.map(put => put.status), [422], 'nothing of the turn is delivered after');
      assert.deepEqual(conversations.submitted('a'.repeat(32)), { state: 'erased', chat: A, n: 2 });
      assert.deepEqual(await conversations.read(emptyHome, A), { absent: 'erased' });
    }, { machine });
    assert.equal(existsSync(join(machine, 'ask', 'submitted.ndjson')), false, 'the door\'s key is the one record of the erasure');
  } finally {
    await door.close();
    rmSync(machine, { recursive: true, force: true });
  }
});

test('8: an erasure while a turn runs lets the whole conversation go: its earlier turns, its state, Ask told once; an answer that ends after is neither held, read nor delivered', async () => {
  const A = '1792396847000-aaaaa1';
  let refusing = false;
  const door = await standIn({ answer: () => refusing ? ERASED_ANSWER : { status: 201 } });
  /** @type {string[]} */
  const told = [];
  try {
    await delivering(door.url, async conversations => {
      const a = held(await begin(conversations, 'A', of(A, 1, 'user', 'First?'), 'a'.repeat(32)));
      conversations.finish(a, 'A', of(A, 2, 'assistant', 'First answer.', { end: 'done' }));
      await conversations.settle(5_000);
      a.marks.set(2, []);
      a.words.set(`sha256:${'2'.repeat(64)}`, 'Spoken words.');
      refusing = true;
      held(await begin(conversations, 'A', of(A, 3, 'user', 'Second?'), 'c'.repeat(32)));
      await until('the erasure told', () => told.length > 0);
      assert.deepEqual(told, [A]);
      assert.equal(a.erased, true);
      assert.equal(conversations.get(A), undefined);
      assert.deepEqual(await conversations.read(emptyHome, A), { absent: 'erased' }, 'no turn of it is read, the earlier ones neither');
      assert.deepEqual((await conversations.list(emptyHome, undefined)).chats, []);
      conversations.finish(a, 'A', of(A, 4, 'assistant', 'Too late.', { end: 'done' }));
      conversations.retitle(a, 'Too late');
      await conversations.settle(5_000);
      assert.deepEqual(await conversations.read(emptyHome, A), { absent: 'erased' }, 'the answer that ended after is not held');
      assert.deepEqual(stated(door.puts), ['a1:1', 'a1:2:done', 'a1:3'], 'nothing delivered after the refusal');
      assert.deepEqual(conversations.submitted('c'.repeat(32)), { state: 'erased', chat: A, n: 4 });
    }, { onLetGo: conversation => void told.push(conversation.chat) });
  } finally {
    await door.close();
  }
});

test('10: a submission\'s record that cannot be written leaves its envelope, so a restart still answers its replay; once written, the envelope goes', async () => {
  const A = '1792396847000-aaaaa1';
  const door = await standIn();
  const machine = mkdtempSync(join(tmpdir(), 'lifestream-mcp-envelopes-'));
  const record = join(machine, 'ask', 'submitted.ndjson');
  try {
    await delivering(door.url, async conversations => {
      mkdirSync(record, { recursive: true });
      const a = held(await begin(conversations, 'A', of(A, 1, 'user', 'Kept?'), 'a'.repeat(32)));
      conversations.finish(a, 'A', of(A, 2, 'assistant', 'Kept.', { end: 'done' }));
      await conversations.settle(0);
      assert.deepEqual(stated(door.puts), ['a1:1', 'a1:2:done']);
      assert.equal(readdirSync(pendingFolder(machine)).length, 1, 'the envelope stands while its record is not written');
      assert.deepEqual(conversations.submitted('a'.repeat(32)), { state: 'pending', chat: A, n: 2 });
    }, { machine });
    await delivering(door.url, async conversations => {
      assert.deepEqual(conversations.submitted('a'.repeat(32)), { state: 'pending', chat: A, n: 2 }, 'a restart still knows the submission');
      rmSync(record, { recursive: true });
      await conversations.settle(5_000);
      assert.deepEqual(readdirSync(pendingFolder(machine)), []);
      assert.deepEqual(conversations.submitted('a'.repeat(32)), { state: 'delivered', chat: A, n: 2 });
      assert.match(readFileSync(record, 'utf8'), /^\{"submission":"a{32}","chat":"1792396847000-aaaaa1","n":2,/u);
    }, { machine });
  } finally {
    await door.close();
    rmSync(machine, { recursive: true, force: true });
  }
});

test('11: a question with files is begun once the door took its seal, its envelope written delivered first; a seal refused lets its envelope go, its submission and the conversation it made; one whose envelope cannot be written sends nothing', async () => {
  const A = '1792396847000-aaaaa1';
  const MISSING = { status: 409, body: { code: 'FILES_MISSING', message: 'Synthetic: a photo is not at the home.', missing: { photos: [PHOTO] } } };
  let missing = true;
  const door = await standIn({ answer: statements => sealing(statements) && missing ? MISSING : { status: 201 } });
  try {
    await delivering(door.url, async (conversations, machine) => {
      chmodSync(pendingFolder(machine), 0o500);
      try {
        assert.deepEqual(await begin(conversations, 'A', of(A, 1, 'user', 'Kept?', { photos: [PHOTO] }), 'b'.repeat(32), true), { unsaved: true });
      } finally {
        chmodSync(pendingFolder(machine), 0o700);
      }
      assert.deepEqual(door.puts, []);
      assert.equal(conversations.submitted('b'.repeat(32)), null);
      assert.deepEqual(await begin(conversations, 'A', of(A, 1, 'user', 'Here?', { photos: [PHOTO] }), 'a'.repeat(32), true), { refused: MISSING });
      assert.deepEqual(readdirSync(pendingFolder(machine)), []);
      assert.equal(conversations.submitted('a'.repeat(32)), null);
      assert.equal(conversations.get(A), undefined);
      missing = false;
      const a = held(await begin(conversations, 'A', of(A, 1, 'user', 'Here now?', { photos: [PHOTO] }), 'c'.repeat(32), true));
      assert.deepEqual(stated(door.puts), ['a1:1', 'a1:1']);
      const [file] = readdirSync(pendingFolder(machine));
      assert.equal(JSON.parse(readFileSync(join(pendingFolder(machine), String(file)), 'utf8')).turn.delivered, true, 'written delivered before its begin answers');
      assert.deepEqual(a.messages.map(message => message.n), [1]);
      assert.deepEqual(conversations.submitted('c'.repeat(32)), { state: 'pending', chat: A, n: 2 });
    });
  } finally {
    await door.close();
  }
});

/** @param {string[]} seen @param {string[]} steps @param {string} what */
const inOrder = (seen, steps, what) => {
  let at = 0;
  for (const each of seen) if (each === steps[at]) at++;
  assert.equal(at, steps.length, `${what}: ${JSON.stringify(steps)} in order, in ${JSON.stringify(seen)}`);
};

/**
 * @param {Conversations} conversations
 * @param {[string, string][]} chats
 */
const answered = async (conversations, chats) => {
  for (const [chat, letter] of chats) {
    const conversation = held(await begin(conversations, chat.slice(-1), of(chat, 1, 'user', 'Imported?'), letter.repeat(32)));
    conversations.finish(conversation, chat.slice(-1), of(chat, 2, 'assistant', 'Imported.', { end: 'done' }));
  }
  await conversations.settle(5_000);
};

test('12: a conversation the door states erased, its turns imported, is read and listed no more, Ask told once, and so is one the home still holds; one absent at home and not erased is still read from this server; one neither holds is waiting while a submission names it, else unknown', async () => {
  const A = '1792396847000-aaaaa1';
  const B = '1792396848000-bbbbb2';
  const door = await standIn();
  /** @type {string[]} */
  const told = [];
  const machine = mkdtempSync(join(tmpdir(), 'lifestream-mcp-envelopes-'));
  mkdirSync(join(machine, 'ask'), { recursive: true });
  writeFileSync(join(machine, 'ask', 'submitted.ndjson'), `${JSON.stringify({ submission: 'c'.repeat(32), chat: '1792396849000-ccccc3', n: 2, kept_ms: Date.now() })}\n`);
  try {
    await delivering(door.url, async conversations => {
      await answered(conversations, [[A, 'a'], [B, 'b']]);
      assert.deepEqual(conversations.submitted('a'.repeat(32)), { state: 'delivered', chat: A, n: 2 });
      assert.deepEqual((await readOf(conversations, emptyHome, A)).messages.map(message => message.n), [1, 2], 'absent at home, not erased');
      assert.deepEqual((await conversations.list(emptyHome, undefined)).chats.map(each => each.chat).sort(), [A, B]);
      door.erased.add(A);
      assert.deepEqual(await conversations.read(emptyHome, A), { absent: 'erased' });
      assert.deepEqual(told, [A]);
      assert.equal(conversations.get(A), undefined);
      assert.deepEqual(conversations.submitted('a'.repeat(32)), { state: 'erased', chat: A, n: 2 });
      door.erased.add(B);
      assert.deepEqual((await conversations.list(emptyHome, undefined)).chats, []);
      assert.deepEqual(told, [A, B]);
      assert.deepEqual(await conversations.read(emptyHome, B), { absent: 'erased' });
      assert.deepEqual(await conversations.read(emptyHome, '1792396849000-ccccc3'), { absent: 'unknown' });
      assert.equal((await conversations.list(homeDoor(), undefined)).chats.length, 1);
      door.erased.add(CHAT);
      assert.deepEqual(await conversations.read(homeDoor(), CHAT), { absent: 'erased' }, 'the home still holding its shell and messages');
      assert.deepEqual((await conversations.list(homeDoor(), undefined)).chats, []);
    }, { onLetGo: conversation => void told.push(conversation.chat) });
    await delivering(door.url, async conversations => {
      const C = '1792396849000-ccccc3';
      assert.deepEqual(conversations.submitted('c'.repeat(32)), { state: 'delivered', chat: C, n: 2 });
      assert.deepEqual(await conversations.read(emptyHome, C), { absent: 'waiting' }, 'a turn the home has not taken in yet');
      door.erased.add(C);
      assert.deepEqual(await conversations.read(emptyHome, C), { absent: 'erased' });
      assert.deepEqual(conversations.submitted('c'.repeat(32)), { state: 'erased', chat: C, n: 2 });
    }, { machine });
  } finally {
    await door.close();
    rmSync(machine, { recursive: true, force: true });
  }
});

test('13: a seal answered after its conversation was erased does not make the conversation again: the begin told erased, no envelope, no read, its submission told erased; a begin after is refused erased', async () => {
  const A = '1792396847000-aaaaa1';
  const seal = { answer: () => {} };
  const door = await standIn({ answer: statements => sealing(statements) ? new Promise(done => { seal.answer = () => done({ status: 201 }); }) : { status: 201 } });
  try {
    await delivering(door.url, async (conversations, machine) => {
      await answered(conversations, [[A, 'a']]);
      const late = begin(conversations, 'A', of(A, 3, 'user', 'A photo?', { photos: [PHOTO] }), 'c'.repeat(32), true);
      await until('the seal asked', () => door.puts.some(put => sealing(put.statements)));
      conversations.erase(A);
      seal.answer();
      assert.deepEqual(await late, { erased: true });
      assert.equal(conversations.get(A), undefined);
      assert.deepEqual(readdirSync(pendingFolder(machine)), []);
      assert.deepEqual(conversations.submitted('c'.repeat(32)), { state: 'erased', chat: A, n: 4 });
      assert.deepEqual(await conversations.read(emptyHome, A), { absent: 'erased' });
      assert.deepEqual(await begin(conversations, 'A', of(A, 3, 'user', 'Again?'), 'd'.repeat(32)), { erased: true });
      assert.equal(conversations.get(A), undefined);
    });
  } finally {
    await door.close();
  }
});

test('14: an erasure makes every submission of its conversation erased, a delivered one too; past a restart, the door\'s erasure read for a delivered one; another conversation\'s delivered submission stays delivered', async () => {
  const A = '1792396847000-aaaaa1';
  const B = '1792396848000-bbbbb2';
  let refusing = false;
  const door = await standIn({ answer: statements => refusing && statements.some(each => each.key === A) ? ERASED_ANSWER : { status: 201 } });
  const machine = mkdtempSync(join(tmpdir(), 'lifestream-mcp-envelopes-'));
  const known = (/** @type {Conversations} */ conversations, /** @type {string} */ what) => {
    assert.deepEqual(conversations.submitted('a'.repeat(32)), { state: 'erased', chat: A, n: 2 }, what);
    assert.deepEqual(conversations.submitted('c'.repeat(32)), { state: 'erased', chat: A, n: 4 }, what);
    assert.deepEqual(conversations.submitted('b'.repeat(32)), { state: 'delivered', chat: B, n: 2 }, what);
  };
  try {
    await delivering(door.url, async conversations => {
      await answered(conversations, [[A, 'a'], [B, 'b']]);
      assert.deepEqual(conversations.submitted('a'.repeat(32)), { state: 'delivered', chat: A, n: 2 });
      refusing = true;
      held(await begin(conversations, 'A', of(A, 3, 'user', 'Second?'), 'c'.repeat(32)));
      await until('the erasure', () => conversations.get(A) === undefined);
      known(conversations, 'as erased');
    }, { machine });
    door.erased.add(A);
    await delivering(door.url, async conversations => {
      assert.deepEqual(conversations.submitted('a'.repeat(32)), { state: 'delivered', chat: A, n: 2 }, 'until the door is asked');
      assert.equal(conversations.submitted('c'.repeat(32)), null, 'its envelope let go, it was never delivered');
      assert.deepEqual(await conversations.read(emptyHome, A), { absent: 'erased' });
      assert.deepEqual(conversations.submitted('a'.repeat(32)), { state: 'erased', chat: A, n: 2 });
      assert.deepEqual(conversations.submitted('b'.repeat(32)), { state: 'delivered', chat: B, n: 2 });
    }, { machine });
    assert.deepEqual(readFileSync(join(machine, 'ask', 'submitted.ndjson'), 'utf8').trim().split('\n').map(line => Object.keys(JSON.parse(line)).sort()),
      [['chat', 'kept_ms', 'n', 'submission'], ['chat', 'kept_ms', 'n', 'submission']], 'one kind of line: a submission delivered');
  } finally {
    await door.close();
    rmSync(machine, { recursive: true, force: true });
  }
});

test('15: the envelope, the submissions\' record and its rewrite are replaced durably: written, synced, renamed, the folder synced, before the turn is told; a folder or a record made is synced into its parent', async () => {
  const A = '1792396847000-aaaaa1';
  const door = await standIn();
  const machine = mkdtempSync(join(tmpdir(), 'lifestream-mcp-durable-'));
  mkdirSync(join(machine, 'ask'), { recursive: true });
  writeFileSync(join(machine, 'ask', 'door-token'), 'synthetic-ask-pass\n');
  /** @type {string[]} */
  const seen = [];
  /** @type {Map<number, string>} */
  const paths = new Map();
  const at = (/** @type {unknown} */ path) => String(path).slice(machine.length + 1).replace(/\.\d+\.tmp$/u, '.tmp');
  const real = { openSync: fs.openSync, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync, mkdirSync: fs.mkdirSync };
  mock.method(fs, 'openSync', /** @type {any} */ ((/** @type {any} */ path, /** @type {any[]} */ ...rest) => {
    const fd = /** @type {any} */ (real.openSync)(path, ...rest);
    paths.set(fd, at(path));
    return fd;
  }));
  mock.method(fs, 'fsyncSync', /** @type {any} */ ((/** @type {number} */ fd) => {
    seen.push(`fsync ${paths.get(fd)}`);
    real.fsyncSync(fd);
  }));
  mock.method(fs, 'renameSync', /** @type {any} */ ((/** @type {any} */ from, /** @type {any} */ to) => {
    seen.push(`rename ${at(from)} ${at(to)}`);
    real.renameSync(from, to);
  }));
  mock.method(fs, 'mkdirSync', /** @type {any} */ ((/** @type {any} */ path, /** @type {any} */ options) => {
    seen.push(`mkdir ${at(path)}`);
    return real.mkdirSync(path, options);
  }));
  syncBuiltinESMExports();
  /** @param {(conversations: Conversations) => Promise<void>} use */
  const opened = async use => {
    const conversations = openConversations({ machine, door: door.url, log: () => undefined });
    try {
      await conversations.knowsSource(homeDoor());
      await use(conversations);
    } finally {
      await conversations.settle(0);
    }
  };
  try {
    await opened(async conversations => {
      const a = held(await begin(conversations, 'A', of(A, 1, 'user', 'Durable?'), 'a'.repeat(32)));
      const told = seen.length;
      const [file] = readdirSync(pendingFolder(machine));
      const envelope = [`fsync ask/pending/${file}.tmp`, `rename ask/pending/${file}.tmp ask/pending/${file}`, 'fsync ask/pending'];
      inOrder(seen.slice(0, told), ['mkdir ask/pending', 'fsync ask', ...envelope], 'the envelope, before its turn is told');
      conversations.finish(a, 'A', of(A, 2, 'assistant', 'Durable.', { end: 'done' }));
      inOrder(seen.slice(told), envelope, 'the envelope written again with its answer');
      const answered = seen.length;
      await conversations.settle(5_000);
      assert.deepEqual(readdirSync(pendingFolder(machine)), []);
      inOrder(seen.slice(answered), ['fsync ask/submitted.ndjson', 'fsync ask'], 'the record made, then its place in its folder');
    });
    fs.appendFileSync(join(machine, 'ask', 'submitted.ndjson'), `${JSON.stringify({ submission: 'e'.repeat(32), chat: A, n: 4, state: 'delivered', kept_ms: Date.now() - 31 * 24 * 3_600_000 })}\n`);
    const started = seen.length;
    await opened(async conversations => {
      assert.deepEqual(conversations.submitted('a'.repeat(32)), { state: 'delivered', chat: A, n: 2 });
      inOrder(seen.slice(started), ['fsync ask/submitted.ndjson.tmp', 'rename ask/submitted.ndjson.tmp ask/submitted.ndjson', 'fsync ask'], 'the record trimmed');
    });
    assert.equal(readFileSync(join(machine, 'ask', 'submitted.ndjson'), 'utf8').includes('e'.repeat(32)), false);
    assert.equal(existsSync(dirname(pendingFolder(machine))), true);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    await door.close();
    rmSync(machine, { recursive: true, force: true });
  }
});

/** @param {string} machine */
const markerIn = machine => JSON.parse(readFileSync(join(pendingFolder(machine), /** @type {string} */ (readdirSync(pendingFolder(machine))[0])), 'utf8'))
  .statements.find((/** @type {any} */ each) => each.kind === 'msg').content;

test('16: a seal whose answer was lost keeps its envelope and fails no turn: the begin told the end unknown, its question held, its marker neither held nor sent and its file the untaken words; a replay resumes from the seal with the same bytes, the restart marker back in its file; with no replay the marker lands in the untaken words; a seal behind a delivery the door does not take is told unknown', async () => {
  const A = '1792396847000-aaaaa1';
  const B = '1792396848000-bbbbb2';
  const C = '1792396849000-ccccc3';
  const D = '1792396850000-ddddd4';
  let lose = 1;
  let busy = false;
  const door = await standIn({
    answer: statements => busy && statements.some(each => each.key === B) ? { status: 503, body: { code: 'SYNTHETIC', message: 'Synthetic: busy.' } }
      : sealing(statements) && lose-- > 0 ? 'lost' : { status: 201 },
  });
  try {
    await delivering(door.url, async (conversations, machine) => {
      const lost = await begin(conversations, 'A', of(A, 1, 'user', 'Lost?', { photos: [PHOTO] }), 'a'.repeat(32), true);
      assert.equal('unknown' in lost ? lost.unknown.status : null, 0);
      assert.equal(readdirSync(pendingFolder(machine)).length, 1, 'the envelope kept');
      assert.deepEqual(conversations.submitted('a'.repeat(32)), { state: 'pending', chat: A, n: 2 });
      assert.deepEqual((await readOf(conversations, emptyHome, A)).messages.map(message => [message.n, message.end]), [[1, undefined]]);
      assert.deepEqual([markerIn(machine).failed, markerIn(machine).error], ['door', UNTAKEN]);
      assert.equal(conversations.unsealed('a'.repeat(32))?.chat, A);
      const a = held(await conversations.resume('a'.repeat(32)));
      assert.deepEqual(stated(door.puts), ['a1:1', 'a1:1']);
      assert.equal(door.puts[0]?.path, door.puts[1]?.path, 'the same bytes, the same delivery');
      assert.equal(markerIn(machine).failed, 'restart');
      assert.equal(conversations.unsealed('a'.repeat(32)), null);
      conversations.finish(a, 'A', of(A, 2, 'assistant', 'A answered.', { end: 'done' }));
      await conversations.settle(5_000);
      assert.deepEqual(stated(door.puts), ['a1:1', 'a1:1', 'a1:2:done']);
      assert.deepEqual(readdirSync(pendingFolder(machine)), []);
      assert.deepEqual(conversations.submitted('a'.repeat(32)), { state: 'delivered', chat: A, n: 2 });
      busy = true;
      held(await begin(conversations, 'B', of(B, 1, 'user', 'Waiting?'), 'b'.repeat(32)));
      const behind = await begin(conversations, 'C', of(C, 1, 'user', 'Behind?', { photos: [PHOTO] }), 'c'.repeat(32), true);
      assert.equal('unknown' in behind ? behind.unknown.status : null, 0);
      assert.equal(door.puts.some(put => put.statements.some(each => each.key === C)), false, 'never sent before the delivery ahead of it');
    });
  } finally {
    await door.close();
  }
  let quiet = 1;
  const unreplayed = await standIn({ answer: statements => sealing(statements) && quiet-- > 0 ? 'lost' : { status: 201 } });
  try {
    await delivering(unreplayed.url, async (conversations, machine) => {
      const lost = await begin(conversations, 'D', of(D, 1, 'user', 'Never replayed?', { photos: [PHOTO] }), 'd'.repeat(32), true);
      assert.equal('unknown' in lost ? lost.unknown.status : null, 0);
      await until('the marker landed', () => readdirSync(pendingFolder(machine)).length === 0);
      assert.deepEqual(stated(unreplayed.puts).at(-1), 'd4:2:failed');
      const marker = unreplayed.puts.at(-1)?.statements.find(each => each.kind === 'msg').content;
      assert.deepEqual([marker.failed, marker.error], ['door', UNTAKEN]);
      assert.deepEqual(conversations.submitted('d'.repeat(32)), { state: 'delivered', chat: D, n: 2 });
    }, { resumeMs: 1 });
  } finally {
    await unreplayed.close();
  }
});

test('17: an envelope of a conversation erased while no server ran is sent once at the start, refused `CHAT_ERASED` and let go; its submission told erased', async () => {
  const A = '1792396847000-aaaaa1';
  const door = await standIn({ answer: () => ERASED_ANSWER });
  try {
    await delivering(door.url, async (conversations, machine) => {
      await until('the envelope let go', () => readdirSync(pendingFolder(machine)).length === 0);
      await conversations.settle(5_000);
      assert.deepEqual(door.puts.map(put => put.status), [422]);
      assert.deepEqual(conversations.submitted('a'.repeat(32)), { state: 'erased', chat: A, n: 2 });
      assert.equal(conversations.get(A), undefined);
    }, { envelopes: [envelope(A, false, 'a'.repeat(32))] });
  } finally {
    await door.close();
  }
});

test('18: a question the door can never read lets its turn go whole, Ask told its answer\'s number to end it; the conversation, nothing of it left, is unknown; an envelope loaded at a start whose files the home holds no more is let go once, its submission unknown again', async () => {
  const A = '1792396847000-aaaaa1';
  const door = await standIn({ answer: () => ({ status: 422, body: { code: 'STATEMENTS_BAD', message: 'A synthetic bundle the home can never read.' } }) });
  /** @type {[string, number | null][]} */
  const told = [];
  try {
    await delivering(door.url, async (conversations, machine) => {
      const a = held(await begin(conversations, 'A', of(A, 1, 'user', 'Readable?'), 'a'.repeat(32)));
      await until('Ask told', () => told.length > 0);
      assert.deepEqual(told, [[A, 2]]);
      assert.deepEqual(readdirSync(pendingFolder(machine)), []);
      assert.equal(conversations.submitted('a'.repeat(32)), null);
      assert.deepEqual(a.messages, []);
      assert.deepEqual(await conversations.read(emptyHome, A), { absent: 'unknown' });
    }, { onLetGo: (conversation, n) => void told.push([conversation.chat, n]) });
  } finally {
    await door.close();
  }
  const gone = await standIn({ answer: () => ({ status: 409, body: { code: 'FILES_MISSING', message: 'Synthetic: a photo is not at the home.', missing: { photos: [PHOTO] } } }) });
  try {
    await delivering(gone.url, async (conversations, machine) => {
      await until('the envelope let go', () => readdirSync(pendingFolder(machine)).length === 0);
      await conversations.settle(5_000);
      assert.deepEqual(gone.puts.map(put => put.status), [409]);
      assert.equal(conversations.submitted('a'.repeat(32)), null);
    }, { envelopes: [envelope(A, false, 'a'.repeat(32))] });
  } finally {
    await gone.close();
  }
});

/** @param {number} count */
function manyDoor(count) {
  /** @type {{ path: string, params: Record<string, unknown> }[]} */
  const asked = [];
  const chats = Array.from({ length: count }, (_, index) => ({ key: `${1792396000000 + index * 1000}-${String(index).padStart(6, '0')}`, at_ms: AT + 1000 * (index % 7) + index }));
  /** @type {Record<string, (params: Record<string, unknown>) => unknown>} */
  const routes = {
    '/v1/me': () => ({ id: 'p-synthetic', kind: null, resource: null }),
    '/v1/sources': () => ({ sources: [{ id: SOURCE, connector: 'ask-home' }] }),
    '/v1/records': params => {
      if (params.kind === 'msg') {
        return { records: chats.filter(each => each.at_ms >= Number(params.from_ms) && each.at_ms < Number(params.to_ms)).map(each => ({ content: { chat: each.key, n: 2 } })) };
      }
      const from = params.after === undefined ? 0 : chats.findIndex(each => each.key === params.after) + 1;
      const page = chats.slice(from, from + 7);
      return { records: page.map(each => ({ key: each.key, content: { type: 'ask.chat', title: `Synthetic ${each.key}`, at_ms: each.at_ms } })), ...(from + 7 < chats.length ? { next: page.at(-1)?.key } : {}) };
    },
  };
  const door = /** @type {any} */ ({
    json: async (/** @type {string} */ path, /** @type {Record<string, unknown>} */ params = {}) => {
      asked.push({ path, params });
      const route = routes[path];
      if (route === undefined) throw new Error(`no ${path} in this home`);
      return route(params);
    },
  });
  return { door, asked, chats };
}

test('19: the list reads the home\'s chat records, every page of them, never the search; it pages 20 at a time newest first, each conversation once across pages, this server\'s own beside the home\'s', async () => {
  await started([], async conversations => {
    const { door, asked, chats } = manyDoor(45);
    assert.equal(await conversations.knowsSource(door), true);
    const own = '1792399000000-ab12cd';
    const mine = held(await begin(conversations, 'Synthetic own', { type: 'ask.msg', chat: own, n: 1, at_ms: AT + 50_000, role: 'user', text: 'Synthetic?' }, 'f'.repeat(32)));
    conversations.finish(mine, 'Synthetic own', { type: 'ask.msg', chat: own, n: 2, at_ms: AT + 50_001, role: 'assistant', text: 'Synthetic.', end: 'done' });
    /** @type {import('../lib/ask/conversations.mjs').Listed[]} */
    const listed = [];
    /** @type {string | undefined} */
    let after;
    const sizes = [];
    do {
      const page = await conversations.list(door, after);
      sizes.push(page.chats.length);
      listed.push(...page.chats);
      after = page.next;
    } while (after !== undefined);
    assert.deepEqual(sizes, [20, 20, 6]);
    assert.deepEqual(listed.map(each => each.chat), [own, ...[...chats].sort((one, other) => other.at_ms - one.at_ms || (one.key < other.key ? 1 : -1)).map(each => each.key)]);
    assert.equal(new Set(listed.map(each => each.chat)).size, 46);
    assert.deepEqual(listed[0], { chat: own, title: 'Synthetic own', first_ms: 1792399000000, last_ms: AT + 50_001, messages: 2 });
    assert.ok(listed.slice(1).every(each => each.messages === 2 && each.title === `Synthetic ${each.chat}` && each.first_ms === Number(each.chat.slice(0, 13))));
    assert.equal(asked.some(each => each.path !== '/v1/me' && each.path !== '/v1/sources' && each.path !== '/v1/records'), false, JSON.stringify(asked.map(each => each.path)));
    assert.equal(asked.some(each => each.path === '/v1/records' && ('alike' in each.params || 'order' in each.params || 'product' in each.params)), false);
    assert.equal(asked.filter(each => each.params.kind === 'chat').length, 3 * 7);
  });
});

test('19: a cursor this server never gave starts the list again', async () => {
  await started([], async conversations => {
    const { door } = manyDoor(3);
    const first = await conversations.list(door, undefined);
    assert.deepEqual((await conversations.list(door, 'not-a-cursor')).chats, first.chats);
    assert.deepEqual((await conversations.list(door, Buffer.from('{"m":[1,"x"]}').toString('base64url'))).chats, first.chats);
  });
});

test('20: on an encrypted home a turn is kept in memory, never on this server\'s disk: begun, told `unsaved` until the door took it, then delivered as on a plain home, its submission remembered in memory alone, no `submitted.ndjson`', async () => {
  const door = await standIn();
  const A = '1792396847000-aaaaa1';
  /** @param {string} dir @returns {string[]} */
  const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
  try {
    await delivering(door.url, async (conversations, machine) => {
      const a = held(await begin(conversations, 'A', of(A, 1, 'user', 'A synthetic question?'), 'a'.repeat(32)));
      assert.deepEqual(readdirSync(pendingFolder(machine)), []);
      assert.deepEqual(await conversations.finish(a, 'A', of(A, 2, 'assistant', 'A synthetic answer.', { end: 'done' })), { ...of(A, 2, 'assistant', 'A synthetic answer.', { end: 'done' }), unsaved: true });
      assert.equal(await conversations.settle(5_000), true);
      assert.deepEqual(stated(door.puts), ['a1:1', 'a1:2:done']);
      assert.deepEqual(conversations.submitted('a'.repeat(32)), { state: 'delivered', chat: A, n: 2 });
      const written = files(machine).filter(file => /synthetic (question|answer)/u.test(readFileSync(file, 'utf8')));
      assert.deepEqual(written, []);
      assert.deepEqual(files(machine).map(file => relative(machine, file)), [join('ask', 'door-token')], 'nothing of the turn on disk, its submission\'s record either');
    }, { keyed: true });
  } finally {
    await door.close();
  }
});

const PICTURE = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from('a synthetic picture the model got')]);
const PICTURE_FILE = `sha256:${createHash('sha256').update(PICTURE).digest('hex')}`;
const SEEN = { asked: [{ start: 0, end: 3, placeholder: '[[Person 1]]' }], answered: [] };
/** @param {string} chat @param {number} n @param {string} text */
const seenAnswer = (chat, n, text) => of(chat, n, 'assistant', text, { end: 'done', seen: SEEN });
/** @param {any[]} statements */
const namesSeen = statements => statements.some(each => each.content?.seen !== undefined);

test('21: finish stages each drawn picture under its hash before it queues the answer, which names it in `seen.photos`; a picture with nothing drawn is null and never staged; the seal releases its hold with no drop', async () => {
  const door = await standIn();
  const A = '1792396847000-aaaaa1';
  try {
    await delivering(door.url, async conversations => {
      const a = held(await begin(conversations, 'A', of(A, 1, 'user', 'Who is this?'), 'a'.repeat(32)));
      const told = await conversations.finish(a, 'A', seenAnswer(A, 2, 'Nobody.'), [PICTURE.toString('base64'), null]);
      assert.deepEqual(told.seen, { ...SEEN, photos: [PICTURE_FILE, null] });
      assert.deepEqual(door.staged.map(each => [each.file, each.bytes.equals(PICTURE)]), [[PICTURE_FILE, true]]);
      await conversations.settle(5_000);
      assert.deepEqual(stated(door.puts), ['a1:1', 'a1:2:done']);
      assert.deepEqual(door.puts[1]?.statements.find(each => each.kind === 'msg').content.seen, { ...SEEN, photos: [PICTURE_FILE, null] });
      assert.deepEqual(door.drops, []);
    });
  } finally {
    await door.close();
  }
});

test('22: a staging the door refuses releases its holds, and the answer goes without `seen`', async () => {
  const door = await standIn({ stage: () => 507 });
  const A = '1792396847000-aaaaa1';
  try {
    await delivering(door.url, async conversations => {
      const a = held(await begin(conversations, 'A', of(A, 1, 'user', 'Who is this?'), 'a'.repeat(32)));
      const told = await conversations.finish(a, 'A', seenAnswer(A, 2, 'Nobody.'), [PICTURE.toString('base64')]);
      assert.equal('seen' in told, false);
      await conversations.settle(5_000);
      assert.deepEqual(door.puts.map(put => namesSeen(put.statements)), [false, false]);
      await until('the refused picture dropped', () => door.drops.length === 1);
      assert.deepEqual(door.drops, [PICTURE_FILE]);
      assert.equal(a.messages.find(message => message.n === 2)?.seen, undefined);
    });
  } finally {
    await door.close();
  }
});

test('23: one hold count per hash: two unsealed answers name one picture; the first dropped sends no drop, the second sends one', async () => {
  const door = await standIn({ answer: statements => namesSeen(statements) ? { status: 503 } : { status: 201 } });
  const A = '1792396847000-aaaaa1';
  const B = '1792396848000-bbbbb2';
  try {
    await delivering(door.url, async conversations => {
      const a = held(await begin(conversations, 'A', of(A, 1, 'user', 'Who is this?'), 'a'.repeat(32)));
      const b = held(await begin(conversations, 'B', of(B, 1, 'user', 'And this?'), 'b'.repeat(32)));
      await conversations.finish(a, 'A', seenAnswer(A, 2, 'Nobody.'), [PICTURE.toString('base64')]);
      await conversations.finish(b, 'B', seenAnswer(B, 2, 'Nobody either.'), [PICTURE.toString('base64')]);
      assert.equal(door.staged.length, 2);
      conversations.erase(A);
      assert.deepEqual(door.drops, []);
      conversations.erase(B);
      await until('the last answer naming the picture dropped, and with it the picture', () => door.drops.length === 1);
      assert.deepEqual(door.drops, [PICTURE_FILE]);
    });
  } finally {
    await door.close();
  }
});

test('24: the holds are rebuilt from the deliveries on disk when the server starts: a picture two waiting answers name is dropped once, when the second goes', async () => {
  const door = await standIn({ answer: statements => namesSeen(statements) ? { status: 503 } : { status: 201 } });
  const A = '1792396847000-aaaaa1';
  const B = '1792396848000-bbbbb2';
  /** @param {string} chat */
  const waiting = chat => ({
    source: SOURCE, made_ms: AT, kept_ms: AT, statements: [
      { kind: 'chat', key: chat, content: { type: 'ask.chat', title: 'Waiting', at_ms: AT } },
      { kind: 'msg', key: `${chat}:0002`, content: { ...seenAnswer(chat, 2, 'Nobody.'), seen: { ...SEEN, photos: [PICTURE_FILE] } } },
    ],
  });
  try {
    await delivering(door.url, async conversations => {
      conversations.erase(A);
      assert.deepEqual(door.drops, []);
      conversations.erase(B);
      await until('the picture dropped with the second answer naming it', () => door.drops.length === 1);
      assert.deepEqual(door.drops, [PICTURE_FILE]);
    }, { envelopes: [waiting(A), waiting(B)] });
  } finally {
    await door.close();
  }
});

test('25: an answer refused because the picture its `seen` names left the stage is sent again without `seen`, once, and its picture dropped; the answer held without it', async () => {
  const missing = { status: 409, body: { code: 'FILES_MISSING', missing: { photos: [PICTURE_FILE] } } };
  const door = await standIn({ answer: statements => namesSeen(statements) ? missing : { status: 201 } });
  const A = '1792396847000-aaaaa1';
  try {
    await delivering(door.url, async conversations => {
      const a = held(await begin(conversations, 'A', of(A, 1, 'user', 'Who is this?'), 'a'.repeat(32)));
      await conversations.finish(a, 'A', seenAnswer(A, 2, 'Nobody.'), [PICTURE.toString('base64')]);
      await conversations.settle(5_000);
      assert.deepEqual(stated(door.puts), ['a1:1', 'a1:2:done', 'a1:2:done']);
      assert.deepEqual(door.puts.map(put => namesSeen(put.statements)), [false, true, false]);
      await until('the picture the answer no longer names dropped', () => door.drops.length === 1);
      assert.deepEqual(door.drops, [PICTURE_FILE]);
      assert.equal(a.messages.find(message => message.n === 2)?.seen, undefined);
      assert.deepEqual(conversations.submitted('a'.repeat(32)), { state: 'delivered', chat: A, n: 2 });
    });
  } finally {
    await door.close();
  }
});
