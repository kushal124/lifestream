// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { voiceRow } from '../lib/ask/ask.mjs';

const READY = JSON.parse(readFileSync(fileURLToPath(new URL('../../homelink/Tests/Fixtures/ask-ready.json', import.meta.url)), 'utf8'));
const PARAKEET = 'runner:runner-macbook-pro-0001/parakeet-unified-en-0.6b';
const OTHER = 'runner:runner-mac-mini-bb01/parakeet-unified-en-0.6b';
const HOME_RUNNER = { unit: 'runner-macbook-pro-0001', name: 'MacBook Pro', home: true };
const OTHER_RUNNER = { unit: 'runner-mac-mini-bb01', name: 'Mac mini', home: false };
const SCRIBE = 'openrouter-voice:elevenlabs/scribe-v2';
const OFF = { value: 'off', words: 'Off', note: null };

/**
 * @typedef {{ value: string, words: string, note: string | null, runner?: { unit: string, name: string, home: boolean } }} Step
 * @param {{ kind: 'mac' | 'phone', words: string, steps: Step[], route: string | null, chat?: unknown, leaves?: string | null }} home
 */
const reads = ({ kind, words, steps, route, chat = 'none', leaves = null }) => ({
  listed: { connectors: [{ id: 'ask', members: [{ key: 'llm.voice', value: 'default', words, steps, route }] }] },
  me: { kind },
  privacy: { chat, voice: { leaves } },
});

/** @param {'mac' | 'phone'} kind */
const none = kind => reads({ kind, words: 'No model yet', steps: [OFF, { value: 'default', words: 'Default', note: 'No model yet' }], route: null });

test('1: no model that writes out a note: not ready, the fix in the words of the device that reads it', () => {
  assert.deepEqual(voiceRow(none('mac')), READY.voices['not ready, on the Mac']);
  assert.deepEqual(voiceRow(none('phone')), READY.voices['not ready, on a phone']);
});

test('2: a route that sends the note as it is, under Hide all: the caution names who the door says it leaves for; none when the door says it leaves for no one', () => {
  /** @type {{ kind: 'mac', words: string, steps: Step[], route: string, chat: string }} */
  const sent = { kind: 'mac', words: 'Scribe v2 · OpenRouter', steps: [OFF, { value: 'default', words: 'Default', note: 'Scribe v2' }, { value: SCRIBE, words: 'Scribe v2', note: 'Sent as it is' }], route: SCRIBE, chat: 'all' };
  assert.deepEqual(voiceRow(reads({ ...sent, leaves: 'OpenRouter' })), READY.voices['sent as it is, under Hide all']);
  assert.equal(voiceRow(reads({ ...sent, leaves: null })).caution, null);
  assert.equal(voiceRow(reads({ ...sent, chat: 'none', leaves: 'OpenRouter' })).caution, null, 'a level that hides nothing says no caution');
});

test('3, 4: Parakeet installed, its runner away: ready, its route the home\'s own Mac\'s, as the phone names it', () => {
  const steps = [OFF, { value: 'default', words: 'Default', note: 'Parakeet' }, { value: PARAKEET, words: 'Parakeet', note: 'Waiting for MacBook Pro to come back', runner: HOME_RUNNER }];
  assert.deepEqual(voiceRow(reads({ kind: 'phone', words: 'Parakeet · MacBook Pro', steps, route: PARAKEET, chat: 'all' })), READY.voices['Parakeet\'s runner away, on a phone']);
});

test('4: the row the apps decode first, Parakeet ready on the home\'s Mac beside a route that sends the note as it is', () => {
  const steps = [OFF, { value: 'default', words: 'Default', note: 'Parakeet' }, { value: PARAKEET, words: 'Parakeet', note: 'MacBook Pro', runner: HOME_RUNNER }, { value: SCRIBE, words: 'Scribe v2', note: 'Sent as it is' }];
  assert.deepEqual(voiceRow(reads({ kind: 'phone', words: 'Parakeet · MacBook Pro', steps, route: PARAKEET })), READY.voice);
});

test('5: two runners offer Parakeet, the home\'s route the second\'s: the row names the second, on the Mac and on a phone, and still while its runner is away', () => {
  const steps = (/** @type {string} */ note) => [OFF, { value: 'default', words: 'Default', note: 'Parakeet' },
    { value: PARAKEET, words: 'Parakeet', note: 'Stays on MacBook Pro', runner: HOME_RUNNER }, { value: OTHER, words: 'Parakeet', note, runner: OTHER_RUNNER }];
  const choices = [{ value: PARAKEET, words: 'Parakeet · this Mac', sent: false }, { value: OTHER, words: 'Parakeet · Mac mini', sent: false }];
  for (const kind of /** @type {const} */ (['mac', 'phone'])) {
    const row = voiceRow(reads({ kind, words: 'Parakeet · Mac mini', steps: steps('Stays on Mac mini'), route: OTHER }));
    assert.equal(row.ready, true);
    assert.equal(row.words, 'Parakeet · Mac mini');
    assert.deepEqual(row.choices, kind === 'mac' ? choices : [{ ...choices[0], words: 'Parakeet · your Mac' }, choices[1]]);
  }
  const away = voiceRow(reads({ kind: 'phone', words: 'Parakeet · Mac mini', steps: steps('Waiting for Mac mini to come back'), route: OTHER }));
  assert.deepEqual([away.ready, away.words, away.line], [true, 'Parakeet · Mac mini', null]);
});
