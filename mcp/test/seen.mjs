// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { askedOf, modelText, seenOf } from '../lib/ask/seen.mjs';
import { photoLine, VOICE_LINE } from '../lib/ask/prompt.mjs';

/**
 * @typedef {import('../lib/ask/seen.mjs').Span} Span
 * @typedef {import('../lib/hiding.mjs').Placed} Placed
 * @typedef {{ name: string, words: string, answer: string, end: string, photos?: number, seen: import('../lib/ask/seen.mjs').Seen, model?: { asked: string, answered: string }, eye: boolean }} Case
 */

/** @type {{ turns: Case[] }} */
const FIXTURE = JSON.parse(readFileSync(new URL('../../design/privacy-view.json', import.meta.url), 'utf8'));
const MODELLED = FIXTURE.turns.filter(turn => turn.model !== undefined);
const [JOURNEY, VOICE] = /** @type {[Case, Case]} */ (FIXTURE.turns);
const INVENTED = 'synthetic detail';

/**
 * @param {Case} turn
 * @returns {{ pieces: { text: string }[], spans: Placed[], joined: string }}
 */
function inputOf(turn) {
  const words = turn.seen.spoken ?? turn.words;
  const spoken = turn.seen.spoken !== undefined;
  let prefix = '';
  /** @type {Placed[]} */
  const spans = [];
  const lead = spoken ? turn.seen.asked.filter(span => span.start === 0 && span.end === 0) : [];
  for (const span of lead) {
    if ('added' in span) prefix += span.added;
    else {
      spans.push({ start: prefix.length, end: prefix.length + INVENTED.length, placeholder: span.placeholder });
      prefix += INVENTED;
    }
  }
  let joined = prefix;
  let from = 0;
  for (const span of turn.seen.asked.slice(lead.length)) {
    joined += words.slice(from, span.start);
    from = span.start;
    if ('added' in span) joined += span.added;
    else if (span.end > span.start) {
      spans.push({ start: joined.length, end: joined.length + span.end - span.start, placeholder: span.placeholder });
      joined += words.slice(span.start, span.end);
      from = span.end;
    } else {
      spans.push({ start: joined.length, end: joined.length + INVENTED.length, placeholder: span.placeholder });
      joined += INVENTED;
    }
  }
  joined += words.slice(from);
  return { pieces: spoken ? [{ text: prefix }, { text: joined.slice(prefix.length) }] : [{ text: joined }], spans, joined };
}

test('the model\'s text of every case of the fixture with a model: the shown words, and the answer, with each span replaced by what the model got', () => {
  assert.ok(MODELLED.length >= 7);
  for (const turn of MODELLED) {
    const model = /** @type {{ asked: string, answered: string }} */ (turn.model);
    assert.equal(modelText(turn.seen.spoken ?? turn.words, turn.seen.asked), model.asked, turn.name);
    assert.equal(modelText(turn.answer, turn.seen.answered), model.answered, turn.name);
  }
});

test('askedOf over every case of the fixture with a model: the hide\'s spans over the joined pieces give the case\'s asked, and the hidden text is its model question', () => {
  for (const turn of MODELLED) {
    const { pieces, spans, joined } = inputOf(turn);
    const words = turn.seen.spoken ?? turn.words;
    assert.deepEqual(askedOf(pieces, words, turn.seen.spoken !== undefined, spans), turn.seen.asked, turn.name);
    assert.equal(modelText(joined, spans), /** @type {{ asked: string }} */ (turn.model).asked, turn.name);
  }
});

test('askedOf over the pieces a question is sent as: the voice line before the words, a photo line after them with its place stated, empty words with none', () => {
  const line = /** @type {{ before: string, place: string | null, after: string }} */ (photoLine(1, { ms: Date.parse('2026-11-03T14:02:00Z'), at: [1.5, 2.5] }, 'UTC'));
  const typed = [{ text: JOURNEY.words }, { text: `\n${line.before}` }, { text: /** @type {string} */ (line.place) }, { text: line.after }];
  const joined = typed.map(piece => piece.text).join('');
  const maya = joined.indexOf('Maya');
  const place = joined.indexOf(/** @type {string} */ (line.place));
  const spans = [{ start: maya, end: maya + 4, placeholder: '[[Person 1]]' }, { start: place, end: place + /** @type {string} */ (line.place).length, placeholder: '[[Place 1]]' }];
  assert.deepEqual(askedOf(typed, JOURNEY.words, false, spans), JOURNEY.seen.asked);

  const voiced = [{ text: `${VOICE_LINE}\n\n` }, { text: VOICE.words }];
  const said = voiced.map(piece => piece.text).join('');
  const at = said.indexOf('Maya');
  assert.deepEqual(askedOf(voiced, VOICE.words, true, [{ start: at, end: at + 4, placeholder: '[[Person 1]]' }]), VOICE.seen.asked);

  const lines = [{ text: '\n[Photo 1: taken 3 Nov 2026 14:02]' }, { text: '\n[Photo 2: taken 3 Nov 2026 14:02]' }];
  assert.deepEqual(askedOf(lines, '', false, []), [{ start: 0, end: 0, added: '\n[Photo 1: taken 3 Nov 2026 14:02]\n[Photo 2: taken 3 Nov 2026 14:02]' }], 'no words: the lines added at 0');
});

test('a span that crosses the edge of the person\'s words fails the build', () => {
  const pieces = [{ text: 'Ask Maya' }, { text: '\n[Photo 1]' }];
  assert.equal(askedOf(pieces, 'Ask Maya', false, [{ start: 4, end: 10, placeholder: '[[Person 1]]' }]), null);
  const voiced = [{ text: `${VOICE_LINE}\n\n` }, { text: 'Maya' }];
  assert.equal(askedOf(voiced, 'Maya', true, [{ start: VOICE_LINE.length, end: VOICE_LINE.length + 4, placeholder: '[[Person 1]]' }]), null);
});

test('the record is kept only when its spans give the question sent and the answer written, and something differs', () => {
  const journey = /** @type {{ asked: string, answered: string }} */ (JOURNEY.model);
  const turn = {
    words: JOURNEY.words, spoken: false, asked: JOURNEY.seen.asked, question: journey.asked,
    answer: JOURNEY.answer, answered: JOURNEY.seen.answered, written: journey.answered, drawn: [true],
  };
  const { photos: _photos, ...record } = JOURNEY.seen;
  assert.deepEqual(seenOf(turn), { seen: record });
  assert.deepEqual(seenOf({ ...turn, written: `${journey.answered} ` }), { differs: true }, 'the answer written differs');
  assert.deepEqual(seenOf({ ...turn, question: JOURNEY.words }), { differs: true }, 'the question sent differs');
  assert.deepEqual(seenOf({ ...turn, answered: [{ start: 7, end: 40, placeholder: '[[Person 1]]' }] }), { differs: true }, 'a span past its text');
  assert.deepEqual(seenOf({ ...turn, asked: [...turn.asked].reverse() }), { differs: true }, 'spans out of order');
  assert.deepEqual(seenOf({ words: 'Hello', spoken: false, asked: [], question: 'Hello', answer: 'Hello.', answered: [], written: 'Hello.', drawn: [false] }), { seen: null }, 'nothing differs: no record');
  assert.deepEqual(seenOf({ words: 'Hello', spoken: false, asked: [], question: 'Hello', answer: 'Hello.', answered: [], written: 'Hello.', drawn: [true] }), { seen: { asked: [], answered: [] } }, 'a drawn photo alone differs');
  const voice = /** @type {{ asked: string, answered: string }} */ (VOICE.model);
  assert.deepEqual(seenOf({ words: VOICE.words, spoken: true, asked: VOICE.seen.asked, question: voice.asked, answer: VOICE.answer, answered: [], written: voice.answered, drawn: [] }), { seen: VOICE.seen });
});
