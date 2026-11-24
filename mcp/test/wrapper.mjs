// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DoorRefusal } from '../lib/errors.mjs';
import { openWrapper } from '../lib/hiding.mjs';
import { count } from '../lib/tools/count.mjs';
import { feedback } from '../lib/tools/feedback.mjs';
import { readTool } from '../lib/tools/read.mjs';

const NOTE_REF = 'record.WyJyZWNvcmQiLCJzeW50aGV0aWM6b25lIiwibm90ZSIsIm4xIl0';

/** @param {{ feedback?: () => void }} [on] */
function fakeDoor(on = {}) {
  /** @type {{ path: string, body: any }[]} */
  const calls = [];
  const door = {
    epoch: 4,
    calls,
    forModel() { return door; },
    erase() { door.epoch += 2; },
    /** @param {string} tool */
    hidden: tool => calls.filter(({ path, body }) => path === '/v1/hide-details' && body.tool === tool).map(({ body }) => ['texts', body.epoch]),
    /**
     * @param {string} path
     * @param {any} body
     */
    async post(path, body) {
      calls.push({ path, body });
      if (path === '/v1/restore-details') {
        if (typeof body.text === 'string') {
          return { level: 'all', epoch: door.epoch, text: body.text, marks: [], unknown: [], refs: [{ handle: 'r1', ref: NOTE_REF }] };
        }
        return { level: 'all', epoch: door.epoch, params: body.params.map((/** @type {{ value: string }} */ { value }) => ({ value, marks: [], unknown: [] })) };
      }
      if (path === '/v1/hide-details') {
        if (body.epoch !== door.epoch) throw new DoorRefusal(409, 'ERASED', 'An erasure ran since these texts were read: read them again', null, { epoch: door.epoch });
        return { level: 'all', epoch: door.epoch, texts: body.texts.map((/** @type {{ text: string }[]} */ pieces) => pieces.map(piece => piece.text).join('')) };
      }
      if (path === '/v1/count') return { asked: 'count of messages', total: { n: 0, ref: 'r1' }, as_of: '2026-11-14T22:10+00:00', next: null };
      if (path === '/v1/feedback') {
        on.feedback?.();
        return { outcome: 'saved' };
      }
      throw new Error(`the fake door has no ${path}`);
    },
  };
  return door;
}

const chatWrapper = () => openWrapper({ table: 'chat:c1', to: 'codex:gpt-6-luna', agent: false, shown: () => ['What did Ada Example say?'] });

/**
 * @param {string} name
 * @param {(args: any, context: any) => Promise<import('../lib/pieces.mjs').Answer>} run
 * @returns {import('../lib/hiding.mjs').Tool}
 */
const reader = (name, run) => ({ name, description: name, inputSchema: {}, run });

test('1, 4: tools run side by side across an erasure: each hides under the epoch its own restore answered, and the one that read before it reads again', async () => {
  const door = fakeDoor();
  const wrapper = chatWrapper();
  /** @type {() => void} */
  let release = () => {};
  const held = new Promise(done => { release = () => done(undefined); });
  /** @type {() => void} */
  let entered = () => {};
  const reading = new Promise(done => { entered = () => done(undefined); });
  let reads = 0;
  const slow = reader('slow', async () => {
    reads++;
    if (reads === 1) {
      entered();
      await held;
    }
    return { lines: [`read ${reads}`] };
  });
  const quick = reader('quick', async () => ({ lines: ['read after the erasure'] }));
  const context = { door: /** @type {any} */ (door) };

  const first = wrapper.run(slow, {}, context);
  await reading;
  door.erase();
  const second = await wrapper.run(quick, {}, context);
  assert.equal(second.text, 'read after the erasure');
  assert.equal(wrapper.epoch(), 6, 'the shared epoch is the last answer\'s');
  release();
  const ran = await first;

  assert.deepEqual(door.hidden('quick'), [['texts', 6]]);
  assert.deepEqual(door.hidden('slow'), [['texts', 4], ['texts', 6]]);
  assert.equal(reads, 2);
  assert.equal(ran.text, 'read 2');
});

test('3: a tool that writes runs once past an erasure, its same answer hidden again under the epoch the door named; feedback\'s line is served as written', async () => {
  const door = fakeDoor({ feedback: () => door.erase() });
  const ran = await chatWrapper().run(/** @type {any} */ (feedback), { category: 'slow', message: 'The day read took long.' }, { door: /** @type {any} */ (door) });
  assert.equal(ran.text, 'Saved.');
  assert.equal(door.calls.filter(({ path }) => path === '/v1/feedback').length, 1, 'the note is saved once');
  assert.deepEqual(door.hidden('feedback'), []);

  const fetched = fakeDoor();
  let outbound = 0;
  const context = {
    door: /** @type {any} */ (fetched), seen: () => true,
    outbound: async () => {
      outbound++;
      fetched.erase();
    },
  };
  await assert.rejects(chatWrapper().run(/** @type {any} */ (readTool({ links: true })), { link: 'http://127.0.0.1/page' }, context), /never opens 127\.0\.0\.1/u);
  assert.equal(outbound, 1, 'the link\'s outbound row is written once');
  assert.deepEqual(fetched.hidden('read'), [['texts', 4], ['texts', 6]]);
});

test('2, 5, 6: a route\'s call states what the conversation showed, with no restore or hide beside it; a tool\'s parameters and the model\'s words state none, and their citations are the door\'s to read', async () => {
  const door = fakeDoor();
  const wrapper = chatWrapper();
  await wrapper.run(reader('restoring', async () => 'found'), { query: 'dinner' }, { door: /** @type {any} */ (door) });
  const restored = door.calls.find(({ path }) => path === '/v1/restore-details');
  const routes = door.calls.length;
  await wrapper.run(/** @type {any} */ (count), { of: 'messages', words: 'dinner' }, { door: /** @type {any} */ (door) });
  assert.deepEqual(door.calls.slice(routes), [{ path: '/v1/count', body: { args: { of: 'messages', words: 'dinner' }, to: 'codex:gpt-6-luna', shown: ['What did Ada Example say?'] } }]);
  assert.deepEqual(restored?.body, { table: 'chat:c1', params: [{ value: 'dinner' }] });

  const before = door.calls.length;
  assert.deepEqual(await wrapper.many(/** @type {any} */ (door), ['Ada Example wrote']), ['Ada Example wrote']);
  const words = await wrapper.words(/** @type {any} */ (door), 'Both notes [r1, r2].');
  assert.deepEqual(door.calls.slice(before).map(({ body }) => body), [
    { table: 'chat:c1', params: [{ value: 'Ada Example wrote' }] },
    { table: 'chat:c1', text: 'Both notes [r1, r2].' },
  ]);
  assert.deepEqual(words.refs, [{ handle: 'r1', ref: NOTE_REF }]);
});
