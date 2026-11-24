// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openWrapper } from '../lib/hiding.mjs';
import { count } from '../lib/tools/count.mjs';
import { read } from '../lib/tools/read.mjs';
import { serverOf } from '../lib/tools.mjs';

/**
 * @param {string} name
 * @returns {any}
 */
const fixture = name => JSON.parse(readFileSync(new URL(`../../packages/home/test/contract/${name}.json`, import.meta.url), 'utf8'));

test('12: a count gives the model what it was counted from, what else the same filter reaches, and every reading in words', async () => {
  const door = fixture('count-by-month');
  const context = { door: {}, read: async () => door };
  const said = JSON.parse(JSON.stringify(/** @type {any} */ (await count.run({ of: 'days', measure: 'sleep', op: 'avg', by: ['month'] }, /** @type {any} */ (context))).json));
  assert.equal(said.counted, door.counted);
  assert.deepEqual(said.readings, door.readings);
  assert.equal(said.total.said, 'avg: asleep 6 h 38 min; in bed 7 h 13 min');
  assert.match(count.description, /`counted` what it was counted from, `also` what else in the range the same filter reaches, uncounted/u);
  assert.match(count.description, /the total's `said` states each/u);
  assert.match(count.description, /where the person was, in order, is `read` of the days/u);
  assert.match(read.description, /where the person was, in order, and what they did there, in one call; the default for one or two days/u);
});

test('14: on /mcp a photo read is an image block with its date and caption as text beside it, never base64 in the text; Ask\'s answer is the same text and image', async () => {
  const jpeg = Buffer.from('synthetic jpeg bytes').toString('base64');
  const photo = { ...fixture('read-photo-hidden'), image: `data:image/jpeg;base64,${jpeg}` };
  const door = {
    pass: 'p',
    forModel() { return door; },
    async json(/** @type {string} */ path) {
      if (path === '/v1/access') return { text: 'Your access to this Lifestream:\n1. Everything · all time\n2. names hidden' };
      throw new Error(`the fake door has no GET ${path}`);
    },
    async post(/** @type {string} */ path) {
      if (path === '/v1/read') return structuredClone(photo);
      throw new Error(`the fake door has no ${path}`);
    },
  };
  const [near, far] = InMemoryTransport.createLinkedPair();
  const server = serverOf(/** @type {any} */ ({ door }), () => undefined);
  await server.connect(far);
  const client = new Client({ name: 'synthetic-agent', version: '1.0.0' });
  await client.connect(near);
  try {
    const result = /** @type {any} */ (await client.callTool({ name: 'read', arguments: { ref: 'r1' } }));
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.deepEqual(result.content.map((/** @type {any} */ part) => part.type), ['text', 'image']);
    assert.deepEqual(result.content[1], { type: 'image', data: jpeg, mimeType: 'image/jpeg' });
    const [{ text }] = result.content;
    assert.doesNotMatch(text, /base64|data:image|c3ludGhldGlj/u, 'no picture inside the text');
    assert.match(text, /"image":"yes, image 1"/u);
    assert.ok(text.includes(photo.title), 'its caption beside it');
    assert.ok(text.includes(photo.at), 'its time where the person was beside it');

    const ask = await openWrapper({ table: 'chat:c1', agent: false }).run(read, { ref: 'r1' }, { door: /** @type {any} */ (door) });
    assert.equal(ask.text, text);
    assert.deepEqual(ask.images, [{ data: jpeg, mimeType: 'image/jpeg' }]);
  } finally {
    await client.close();
  }
});
