// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Marked } from 'marked';
import { askQuestion, setIcons } from '../public/ui/kit/index.js';
import { ciphered, SEEN_CIPHER, seenAnswer, seenStep, seenWords, spansFit } from '../public/ui/kit/seen.js';
import { asking, turnsOf, withEvent } from '../public/ui/ask/turns.js';
import { installClock } from '../public/lib/home-clock.js';
import { clockFor } from './stand-ins/clock.mjs';

setIcons(JSON.parse(readFileSync(new URL('../../design/icons.json', import.meta.url), 'utf8')));
installClock(clockFor('UTC', 4));

/** @typedef {import('../public/ui/kit/seen.js').SeenSpan} SeenSpan */
/**
 * @typedef {{ name: string, words: string, answer: string, end: string, seen: { asked: SeenSpan[], spoken?: string, answered: SeenSpan[], photos?: (string | null)[] },
 *   model?: { asked: string, answered: string }, details?: string[], eye: boolean }} Case
 * @typedef {{ from: string, to: string, index: number, at_ms: number[], locked: number[], fill: { to: number, from_ms: number } }} Frame
 */
/** @type {{ cipher: string, turns: Case[], frames: Frame[] }} */
const SHARED = JSON.parse(readFileSync(new URL('../../design/privacy-view.json', import.meta.url), 'utf8'));
const TIMING = { decrypt: 620, stagger: 50 };
const marked = new Marked({ gfm: true, breaks: true, renderer: { link({ href, tokens }) {
  const words = this.parser.parseInline(tokens);
  return /^https?:\/\//u.test(href) ? `<a href="${href}">${words}</a>` : words;
} } });
/** @param {string} text */
const markdown = text => /** @type {string} */ (marked.parse(text));

const PIECE = /<span class="ck-seen ck-seen--(\w+)( is-more)?" data-said="([^"]*)"><span class="ck-seen__words">([\s\S]*?)<\/span><span class="ck-seen__said[^"]*">([\s\S]*?)<\/span><span class="ck-seen__run" aria-hidden="true"><\/span><\/span>/gu;
/** @param {string} html */
const unescaped = html => html.replace(/<[^>]*>/gu, '').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"')
  .replace(/&#39;/gu, '\'').replace(/&amp;/gu, '&');
/** @param {string} html @param {boolean} model */
const viewOf = (html, model) => unescaped(html.replace(PIECE, (_, _kind, _more, said, words) => model ? said : words));
/** @param {string} html */
const detailsOf = html => [...html.matchAll(PIECE)].reduce((details, [, , more, said]) => more && details.length
  ? [...details.slice(0, -1), details[details.length - 1] + unescaped(said)] : [...details, unescaped(said)], /** @type {string[]} */ ([]));

test('S1: the alphabet the scramble draws from is the shared cipher', () => {
  assert.equal(SEEN_CIPHER, SHARED.cipher);
  const drawn = ciphered('[[Person 1]]\nx', 3, () => 0.999);
  assert.equal(drawn.length, '[[Person 1]]\nx'.length - 3);
  assert.equal(drawn.indexOf('\n'), 9, 'a line break stays a line break while the rest scrambles');
  assert.ok([...drawn.replace('\n', '')].every(each => SHARED.cipher.includes(each)));
});

test('S2: each detail locks from the left and fills as the shared frames say, each starting its stagger later', () => {
  for (const frame of SHARED.frames) {
    const toModel = frame.to.startsWith('[[');
    frame.at_ms.forEach((ms, at) => {
      const step = seenStep(ms, { index: frame.index, length: frame.to.length, toModel }, TIMING);
      assert.equal(step.locked, frame.locked[at], `${frame.from} → ${frame.to} at ${ms} ms`);
    });
    const before = seenStep(frame.fill.from_ms - 1, { index: frame.index, length: frame.to.length, toModel }, TIMING);
    const after = seenStep(frame.fill.from_ms, { index: frame.index, length: frame.to.length, toModel }, TIMING);
    assert.equal(after.fill, frame.fill.to, `${frame.from} → ${frame.to}: its fill from ${frame.fill.from_ms} ms`);
    if (frame.fill.from_ms > 0) assert.equal(before.fill, 1 - frame.fill.to);
  }
  assert.equal(seenStep(99, { index: 2, length: 4, toModel: false }, TIMING).begun, false, 'a detail waits its stagger before it turns');
  assert.equal(seenStep(720, { index: 2, length: 4, toModel: false }, TIMING).done, true);
});

test('S3: a question draws each span as one detail over the words the person sees, an added line one detail across its breaks', () => {
  for (const turn of SHARED.turns.filter(each => each.eye && each.model && each.details)) {
    const asked = turn.seen.spoken ?? turn.words;
    const drawn = seenWords(asked, turn.seen.asked);
    assert.equal(viewOf(drawn, false), asked, `${turn.name}: the person's view is the person's words`);
    assert.equal(viewOf(drawn, true), turn.model?.asked, `${turn.name}: the model view reads what the model read`);
    assert.deepEqual(detailsOf(drawn), turn.details?.slice(0, turn.seen.asked.length), `${turn.name}: one detail per span`);
  }
  assert.match(seenWords('x', [{ start: 1, end: 1, added: '\n[Photo 1]' }]),
    /ck-seen--break" data-said="\n">[\s\S]*ck-seen--added is-more" data-said="\[Photo 1\]"/u, 'the line after the break is the same detail');
});

test('S4: spans fit their text only sorted, apart, within it, of the two kinds; spans that do not fit draw the words alone', () => {
  const words = 'Call Maya';
  assert.equal(spansFit(words, [{ start: 5, end: 9, placeholder: '[[Person 1]]' }]), true);
  assert.equal(spansFit(words, [{ start: 5, end: 12, placeholder: '[[Person 1]]' }]), false, 'past the text');
  assert.equal(spansFit(words, [{ start: 5, end: 9, placeholder: 'a' }, { start: 4, end: 6, placeholder: 'b' }]), false, 'overlapping');
  assert.equal(spansFit(words, [{ start: 0, end: 4, added: 'x' }]), false, 'an added line holds no words of the person');
  assert.equal(spansFit(words, [/** @type {SeenSpan} */ (/** @type {unknown} */ ({ start: 0, end: 4 }))]), false, 'neither kind');
  assert.equal(seenWords(words, [{ start: 5, end: 12, placeholder: '[[Person 1]]' }]), words);
});

test('S5: a voice turn\'s question draws its spans over the written words', () => {
  const voice = SHARED.turns.find(turn => turn.eye && turn.seen.spoken);
  assert.ok(voice?.seen.spoken);
  const shown = askQuestion('', { seen: voice.seen.asked, voice: { seconds: 3, levels: [0.5], words: voice.seen.spoken } });
  const words = /<p class="ck-ask-voice__words">([\s\S]*)<\/p><\/div><\/div>$/u.exec(shown)?.[1] ?? '';
  assert.equal(viewOf(words, true), voice.model?.asked);
  assert.equal(viewOf(words, false), voice.seen.spoken);
});

test('S6: a turn carries the answer\'s record from the conversation and from the done event; a failed answer none', () => {
  const journey = SHARED.turns[0];
  const messages = [{ chat: 'c', n: 1, at_ms: 0, role: /** @type {const} */ ('user'), text: journey.words },
    { chat: 'c', n: 2, at_ms: 1, role: /** @type {const} */ ('assistant'), text: journey.answer, end: /** @type {const} */ ('done'),
      seen: journey.seen }];
  assert.deepEqual(turnsOf({ chat: 'c', title: '', messages })[0].seen, journey.seen);
  const done = withEvent(asking(journey.words, 0), { type: 'done', message: messages[1] });
  assert.deepEqual(done.seen, journey.seen);
  const failed = withEvent(asking(journey.words, 0), { type: 'done', message: { ...messages[1], end: 'failed' } });
  assert.equal(failed.seen, null);
  assert.equal(asking('Where?', 0).seen, null);
});

test('S7: an answer\'s spans are marked in its raw text and drawn twice: a run becomes a detail where it shows, else no eye', () => {
  const two = seenAnswer('Maya and Dev came.', [{ start: 0, end: 4, placeholder: '[[Person 1]]' }, { start: 9, end: 12, placeholder: '[[Person 2]]' }],
    markdown);
  assert.ok(two);
  assert.equal(viewOf(two, true).trim(), '[[Person 1]] and [[Person 2]] came.');
  assert.equal(viewOf(two, false).trim(), 'Maya and Dev came.');
  assert.doesNotMatch(two, /[]/u, 'no marker is left in what is drawn');
  assert.deepEqual([...two.matchAll(/<span class="ck-seen__said ck-stand">([^<]*)<\/span>/gu)].map(([, words]) => words), ['Person 1', 'Person 2'],
    'a stand-in is drawn as the chip the setup\'s example draws, its name without the brackets the model read');
  const target = 'Write to [her](mailto:maya@example.com), Maya.';
  const kept = seenAnswer(target, [{ start: 22, end: 26, placeholder: '[[Email 1]]' }, { start: 41, end: 45, placeholder: '[[Person 1]]' }], markdown);
  assert.equal(target.slice(22, 26), 'maya');
  assert.deepEqual(detailsOf(kept ?? ''), ['[[Person 1]]'], 'a span in a link target is put back as its words and draws nothing');
  assert.equal(seenAnswer('Call a**+1 555 0100** today.', [{ start: 8, end: 19, placeholder: '[[Phone 1]]' }], markdown), null,
    'markers that change how the markdown reads: no eye');
  assert.equal(seenAnswer('Maya came.', [{ start: 0, end: 4, placeholder: '[[Person 1]]' }], markdown), null, 'a text already holding a marker');
  assert.equal(seenAnswer('Maya came.', [{ start: 0, end: 0, added: 'x' }], markdown), null, 'an answer\'s spans are placeholders over words');
  assert.equal(seenAnswer('Maya came.', [{ start: 0, end: 4, placeholder: '[[Person 1]]' }], () => '<p>Maya came.</p>'), null,
    'a span the markdown does not draw: no eye');
});

test('S8: spans inside one autolink widen to it and become one detail, the model\'s text over the whole of it', () => {
  const text = 'From <maya.iyer@example.com>, then Maya.';
  const html = seenAnswer(text, [{ start: 6, end: 10, placeholder: '[[Person 1]]' }, { start: 11, end: 15, placeholder: '[[Person 2]]' },
    { start: 35, end: 39, placeholder: '[[Person 1]]' }], markdown);
  assert.ok(html);
  assert.deepEqual(detailsOf(html), ['<[[Person 1]].[[Person 2]]@example.com>', '[[Person 1]]']);
  assert.equal(viewOf(html, false).trim(), 'From maya.iyer@example.com, then Maya.', 'the person sees the address as drawn');
  const url = 'See <https://example.com/maya> now.';
  assert.deepEqual(detailsOf(seenAnswer(url, [{ start: 25, end: 29, placeholder: '[[Person 1]]' }], markdown) ?? ''),
    ['<https://example.com/[[Person 1]]>']);
});
