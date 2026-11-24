// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cut, textHead } from '../lib/shape.mjs';
import { titleAsk } from '../lib/ask/prompt.mjs';

const PARTY = '\u{1F389}';

/** @param {string} text */
const wellFormed = text => !/[\ud800-\udfff]/u.test(text);

test('1: a cut never keeps half of an emoji, wherever it lands', () => {
  const text = `ab${PARTY}cd`;
  assert.equal(textHead(text, 2), 'ab');
  assert.equal(textHead(text, 3), 'ab', 'the emoji left out whole');
  assert.equal(textHead(text, 4), `ab${PARTY}`);
  assert.equal(textHead(text, 0), '');
  assert.equal(textHead(text, 6), text);
  for (let units = 0; units <= text.length; units += 1) assert.ok(wellFormed(textHead(text, units)), `cut at ${units}`);
  assert.equal(titleAsk('q', `${'a'.repeat(3_999)}${PARTY}`), `Question: q\n\nAnswer: ${'a'.repeat(3_999)}`);
});

test('2: a string cut at an emoji says how much it left out', () => {
  assert.equal(JSON.stringify(cut(`abc${PARTY}`, 4)), JSON.stringify('abc…[cut: 2 more characters]'));
});

test('3: ASCII is cut at its length, its count as before', () => {
  assert.equal(JSON.stringify(cut('c'.repeat(2_100), 2_000)), JSON.stringify(`${'c'.repeat(2_000)}…[cut: 100 more characters]`));
});
