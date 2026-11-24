// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** @typedef {import('../public/ui/ask/turns.js').ChatSummary} ChatSummary */

/** @param {string} chat @param {number} at @returns {ChatSummary} */
const summary = (chat, at) => ({ chat, title: `Synthetic ${chat}`, first_ms: at, last_ms: at, messages: 2 });

const ALL = Array.from({ length: 45 }, (_, n) => summary(`c${n}`, 1_000_000 - n));

/** @param {ChatSummary[]} chats */
function door(chats) {
  /** @type {{ after: string, answer: () => void, fail: () => void }[]} */
  const waiting = [];
  /** @type {string[]} */
  const asked = [];
  globalThis.fetch = /** @type {typeof fetch} */ (async (/** @type {string} */ url) => {
    if (!url.startsWith('api/ask/chats')) return new Response('null', { status: 404 });
    const after = new URL(url, 'http://loopback/').searchParams.get('after') ?? '';
    asked.push(after);
    const from = after ? Number(after) : 0;
    const body = { chats: chats.slice(from, from + 20), ...from + 20 < chats.length ? { next: String(from + 20) } : {} };
    return new Promise((resolve, reject) => waiting.push({ after,
      answer: () => resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })),
      fail: () => reject(new Error('Synthetic: the list broke.')) }));
  });
  const settle = () => new Promise(done => setImmediate(done));
  return {
    asked,
    async answer() {
      await settle();
      const first = waiting.shift();
      assert.ok(first, 'a request waits');
      first.answer();
      await settle();
    },
    async fail() {
      await settle();
      waiting.shift()?.fail();
      await settle();
    },
    waiting: async () => {
      await settle();
      return waiting.length;
    },
  };
}

let fresh = 0;
const chatsModule = async () => /** @type {typeof import('../public/ui/ask/chats.js')} */ (await import(`../public/ui/ask/chats.js?${++fresh}`));

test('L1, L2: a read reads the first page alone; more reads the next once, and more is said until the last page', async () => {
  const home = door(ALL);
  const { readChats, heldChats, more } = await chatsModule();
  const read = readChats();
  await home.answer();
  assert.equal((await read)?.length, 20);
  assert.deepEqual(home.asked, ['']);
  assert.equal(heldChats().more, true);
  const one = more();
  const two = more();
  assert.equal(one, two, 'a second ask while the page reads shares it');
  await home.answer();
  assert.equal((await one)?.length, 40);
  assert.deepEqual(home.asked, ['', '20']);
  assert.deepEqual(heldChats().list?.map(chat => chat.chat), ALL.slice(0, 40).map(chat => chat.chat));
  const last = more();
  await home.answer();
  await last;
  assert.equal(heldChats().list?.length, 45);
  assert.equal(heldChats().more, false);
  assert.equal((await more())?.length, 45);
  assert.equal(await home.waiting(), 0, 'nothing more is read when the home holds no more');
});

test('L3: a read again reads as many pages as the readers asked for', async () => {
  const home = door(ALL);
  const { readChats, heldChats, more } = await chatsModule();
  const first = readChats();
  await home.answer();
  await first;
  const next = more();
  await home.answer();
  await next;
  const again = readChats({ again: true });
  await home.answer();
  await home.answer();
  assert.equal((await again)?.length, 40);
  assert.deepEqual(home.asked, ['', '20', '', '20']);
  assert.equal(heldChats().list?.length, 40);
});

test('L2: more asked while a read is under way is read by that read', async () => {
  const home = door(ALL);
  const { readChats, heldChats, more } = await chatsModule();
  const first = readChats();
  await home.answer();
  await first;
  const again = readChats({ again: true });
  const asked = more();
  assert.equal(asked, again, 'more shares the read under way');
  await home.answer();
  await home.answer();
  await again;
  assert.deepEqual(home.asked, ['', '', '20']);
  assert.equal(heldChats().list?.length, 40);
});

test('L4: a conversation begun here stays on top over a read begun before it, and goes with one begun after', async () => {
  const home = door(ALL.slice(0, 5));
  const { readChats, heldChats, began } = await chatsModule();
  const first = readChats();
  await home.answer();
  await first;
  const before = readChats({ again: true });
  began('new', 'What is new?');
  assert.equal(heldChats().list?.[0].chat, 'new');
  await home.answer();
  await before;
  assert.equal(heldChats().list?.[0].chat, 'new', 'a read begun before it kept it');
  const after = readChats({ again: true });
  await home.answer();
  await after;
  assert.equal(heldChats().list?.some(chat => chat.chat === 'new'), false, 'a read begun after it is the home’s word');
});

test('L5: a newer read wins over an older one landing after it, and over a page read on with more', async () => {
  const home = door(ALL);
  const { readChats, heldChats, more } = await chatsModule();
  const first = readChats();
  await home.answer();
  await first;
  const page = more();
  const newer = readChats({ again: true });
  await home.answer();
  assert.equal(await page, null, 'the page read on lost to the newer read');
  assert.equal(heldChats().list?.length, 20, 'a page read before the newer read began adds nothing');
  await home.answer();
  await home.answer();
  assert.equal((await newer)?.length, 40);
  const older = readChats({ again: true });
  const newest = readChats({ again: true });
  await home.answer();
  await home.answer();
  await home.answer();
  assert.equal(await older, null);
  assert.equal((await newest)?.length, 40);
});

test('L6: a failed more leaves the list read, not failed, and the next more asks again', async () => {
  const home = door(ALL);
  const { readChats, heldChats, more } = await chatsModule();
  const first = readChats();
  await home.answer();
  await first;
  const failing = more();
  await home.fail();
  await assert.rejects(failing);
  assert.equal(heldChats().list?.length, 20);
  assert.equal(heldChats().failed, false);
  assert.equal(heldChats().more, true);
  const next = more();
  await home.answer();
  assert.equal((await next)?.length, 40);
});
