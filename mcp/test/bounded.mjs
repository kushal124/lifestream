// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DoorRefusal } from '../lib/errors.mjs';
import { openWrapper } from '../lib/hiding.mjs';
import { count } from '../lib/tools/count.mjs';

/** @param {import('../lib/hiding.mjs').Routed} answer */
const plain = answer => /** @type {any} */ (JSON.parse(JSON.stringify(answer.json)));

test('TOO_BROAD: with `fits`, the range to ask and the rest; with none, no range, the door\'s words for what to narrow; through the one wrapper, never "could not hide"', async () => {
  const fits = { from: '2024-03-01', to: '2026-11-14' };
  const refusals = [
    new DoorRefusal(422, 'TOO_BROAD', 'the words match too much of messages to count in one call: ask from=2024-03-01 to=2026-11-14, then the days before it', null, { budget: 100_000, fits }),
    new DoorRefusal(422, 'TOO_BROAD', 'the words are too common among the entries with no time to count notes in one call: ask with more words, each of which must appear, or rarer ones', null, { budget: 100_000 }),
  ];
  /** @type {string[]} */
  const said = [];
  for (const refusal of refusals) {
    const door = {
      pass: 'p',
      forModel() { return door; },
      async post(/** @type {string} */ path) {
        if (path === '/v1/count') throw refusal;
        throw new Error(`the fake door has no ${path}`);
      },
    };
    const wrapper = openWrapper({ table: 'chat:c1', to: 'codex:gpt-6-luna', agent: false, shown: () => [] });
    said.push(await wrapper.run(/** @type {any} */ (count), { of: 'messages', words: 'example' }, { door: /** @type {any} */ (door) }).then(() => 'answered', error => error.message));
  }
  assert.deepEqual(said, [
    'Too much to count in one call. 2024-03-01 → 2026-11-14 fits: ask it, then the rest with `to: 2024-02-29`.',
    'Too much to count in one call, and not one whole day of it fits, so no range would: the words are too common among the entries with no time to count notes in one call: ask with more words, each of which must appear, or rarer ones.',
  ]);
});

test('`held`: passed on as the door says it', async () => {
  const held = { first: '2022-01-01', last: '2026-11-06' };
  const context = { door: {}, read: async () => ({ asked: 'count of payments', held, total: { n: 0 } }) };
  const answer = plain(/** @type {any} */ (await count.run({ of: 'payments', words: 'example' }, /** @type {any} */ (context))));
  assert.deepEqual(answer.held, held);
});
