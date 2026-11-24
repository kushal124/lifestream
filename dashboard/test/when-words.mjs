// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dateTitle, groupWhen, lineClock, lineDay, lineMonth, nearDay, rowDay, sectionWhen, stampWhen } from '../public/lib/words.js';

/** @typedef {{ form: string, today: string, day?: string, key?: string, month?: string, clock?: string, grouped?: boolean, words: string }} Case */

/** @type {{ cases: Case[] }} */
const TABLE = JSON.parse(readFileSync(new URL('../../design/when-words.json', import.meta.url), 'utf8'));

/** @type {Record<string, (one: Case) => string>} */
const FORMS = {
  rowDay: one => rowDay(one.day ?? '', one.today, { clock: one.clock, grouped: one.grouped }),
  groupWhen: one => groupWhen(one.day ?? '', one.today),
  sectionWhen: one => sectionWhen(one.key ?? '', one.today) ?? '',
  dateTitle: one => dateTitle(one.day ?? '', one.today),
  nearDay: one => nearDay(one.day ?? '', one.today),
  stampWhen: one => stampWhen(one.day ?? '', one.today, one.clock ?? ''),
  lineDay: one => lineDay(one.day ?? '', one.today, one.clock),
  lineMonth: one => lineMonth(one.month ?? ''),
  lineClock: one => lineClock(one.day ?? '', one.today, one.clock ?? ''),
};

test('W1: every case of the table, in its form', () => {
  for (const one of TABLE.cases) {
    assert.equal(FORMS[one.form](one), one.words, `${one.form} of ${one.day ?? one.key ?? one.month} on ${one.today}`);
  }
});

test('W2: every form the table names is read here, each with cases', () => {
  const named = new Set(TABLE.cases.map(one => one.form));
  assert.deepEqual([...named].sort(), Object.keys(FORMS).sort());
});

test('W3: a section key that is no time key, none among them, has no words of the app\'s', () => {
  for (const key of ['none', 'month:2026-13', 'month:2026-1', 'year:25', 'day:2026-11-16', '']) assert.equal(sectionWhen(key, '2026-11-16'), null, key);
});
