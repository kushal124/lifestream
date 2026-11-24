// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Marked } from 'marked';
import { askAnswer, askLive, closed, cutsOf, setIcons, thoughtFor, took } from '../public/ui/kit/index.js';
import { asking, shownRefs, withEvent } from '../public/ui/ask/turns.js';

setIcons(JSON.parse(readFileSync(new URL('../../design/icons.json', import.meta.url), 'utf8')));

/** @typedef {import('../public/ui/kit/ask-live.js').AskLiveEvent} Event */
/** @typedef {import('../public/ui/kit/ask-live.js').AskLiveView} View */
/**
 * @typedef {{ at: number, named?: true, began?: number, ended?: number, words?: string, said?: string, failed?: boolean, text?: string, done?: string, cut?: true, thought_ms?: number }} Timed
 * @typedef {{ name: string, followed?: boolean, events: Timed[], frames: { at: number, line: string, shown: string, settled: boolean }[] }} Timeline
 */

/** @type {{ pace: { dwell: number, quiet: number, word: number }, cases: Timeline[] }} */
const SHARED = JSON.parse(readFileSync(new URL('../../design/ask-trace.json', import.meta.url), 'utf8'));
const PACE = SHARED.pace;
const FRAME = 16;

/**
 * @param {Timed} timed
 * @returns {Event}
 */
const eventOf = timed => timed.named ? { type: 'chat' }
  : timed.began !== undefined ? { type: 'step', call: timed.began, words: timed.words ?? '', ...(timed.said ? { said: timed.said } : {}) }
    : timed.ended !== undefined ? { type: 'step', call: timed.ended, words: timed.words ?? '', ms: 1, ...(timed.failed ? { error: 'failed' } : {}) }
      : timed.text !== undefined ? { type: 'text', delta: timed.text }
        : { type: 'done', message: { text: timed.done ?? '', end: timed.cut ? 'stopped' : 'done', ...(timed.thought_ms === undefined ? {} : { thought_ms: timed.thought_ms }) } };

/**
 * @param {Timeline} timeline
 * @returns {{ frames: { t: number, view: View }[], lines: { t: number, line: string, working: boolean }[] }}
 */
function play({ events, followed = false }) {
  const live = askLive(0, PACE, { followed });
  /** @type {{ t: number, view: View }[]} */
  const frames = [];
  let next = 0;
  for (let t = events[0].at; t <= events[0].at + 30_000; t += FRAME) {
    while (next < events.length && events[next].at <= t) live.hear(eventOf(events[next]), events[next++].at);
    const view = live.at(t);
    frames.push({ t, view });
    if (view.settled && next === events.length) break;
  }
  /** @type {{ t: number, line: string, working: boolean }[]} */
  const lines = [];
  for (const { t, view } of frames) {
    const last = lines.at(-1);
    if (!last || last.line !== view.line || last.working !== view.working) lines.push({ t, line: view.line, working: view.working });
  }
  return { frames, lines };
}

/** @param {string} shown */
const bare = shown => shown.replace(/[*`~]+$/u, '');

test('the timelines the iPhone shares: each frame, its line and its words, the same on the web', () => {
  for (const timeline of SHARED.cases) {
    const live = askLive(0, PACE, { followed: timeline.followed ?? false });
    let next = 0;
    for (const frame of timeline.frames) {
      while (next < timeline.events.length && timeline.events[next].at <= frame.at) live.hear(eventOf(timeline.events[next]), timeline.events[next++].at);
      const view = live.at(frame.at);
      assert.deepEqual({ line: view.line, shown: view.shown, settled: view.settled }, { line: frame.line, shown: frame.shown, settled: frame.settled },
        `${timeline.name} at ${frame.at}`);
    }
  }
});

test('on every shared timeline, drawn each frame: a phrase stays its dwell, the answer only grows, the first word comes with “Thought for”, the end says how long it thought', () => {
  for (const timeline of SHARED.cases) {
    const { frames, lines } = play(timeline);
    lines.forEach((each, at) => {
      const after = lines[at + 1];
      if (each.working && after?.working) assert.ok(after.t - each.t > PACE.dwell - FRAME, `${timeline.name}: “${each.line}” stood ${after.t - each.t} ms`);
    });
    const streamed = timeline.events.flatMap(each => each.text ?? []).join('');
    const mended = timeline.events.some(each => each.done !== undefined && each.done !== streamed);
    let before = '';
    for (const { view } of mended ? [] : frames) {
      assert.ok(bare(view.shown).startsWith(bare(before)), `${timeline.name}: the answer took back words: “${before}” then “${view.shown}”`);
      before = view.shown;
    }
    const first = frames.find(each => each.view.shown.trim());
    if (first) assert.equal(first.view.working, false, `${timeline.name}: the first word shows with the line saying how long it thought`);
    const end = /** @type {{ view: View }} */ (frames.at(-1)).view;
    assert.equal(end.settled, true, timeline.name);
    assert.match(end.line, /^Thought for /u, timeline.name);
  }
});

test('one unit at a time: a citation list, a link and a table each whole, a word still arriving waits, a list mark waits for its word', () => {
  const ends = (/** @type {string} */ text, final = false) => cutsOf(text, final).map(cut => [...text].slice(0, cut.end).join(''));
  const table = 'Weeks:\n\n| A | B |\n| --- | --- |\n| 1 | 2 |';
  assert.deepEqual(ends('Booked [r1, r4]. More'), ['Booked', 'Booked [r1, r4].'], 'a citation list is one unit with its stop');
  assert.deepEqual(ends('Booked [r1,'), ['Booked'], 'half a citation waits');
  assert.deepEqual(ends('See [the page](https://example.com/a b) now '), ['See', 'See [the page](https://example.com/a b)', 'See [the page](https://example.com/a b) now']);
  assert.deepEqual(ends('See [the pa'), ['See'], 'half a link waits');
  assert.deepEqual(ends(table), ['Weeks:'], 'a table waits until it ends');
  assert.deepEqual(ends(`${table}\n\nDone `), ['Weeks:', table, `${table}\n\nDone`]);
  assert.deepEqual(ends('Intro\n-'), ['Intro'], 'a list mark alone waits for its word');
  assert.deepEqual(ends('Intro\n- one two'), ['Intro', 'Intro\n- one']);
  assert.deepEqual(ends('Half a wor'), ['Half', 'Half a']);
  assert.deepEqual(ends('Half a wor', true), ['Half', 'Half a', 'Half a wor']);
});

test('the answer’s markdown is drawn as it will be: an open mark in the last paragraph closed, none from an earlier one', () => {
  assert.equal(closed('It was **Saturday'), 'It was **Saturday**');
  assert.equal(closed('A `code'), 'A `code`');
  assert.equal(closed('**Bold and *both'), '**Bold and *both***');
  assert.equal(closed('5 * 3 is 15\n\n**next'), '5 * 3 is 15\n\n**next**');
  assert.equal(closed('- one\n- *two'), '- one\n- *two*');
  assert.equal(closed('~~gone'), '~~gone~~');
});

test('how long it thought: a tenth under a second, never “1.0s”, whole seconds under a minute, then minutes and seconds', () => {
  const edges = [800, 949, 950, 999, 1_000, 9_499, 9_500, 59_499, 59_500, 60_000, 65_000];
  assert.deepEqual(edges.map(took), ['0.8s', '0.9s', '1s', '1s', '1s', '9s', '10s', '59s', '1m', '1m', '1m 5s']);
  assert.equal(thoughtFor(9_000), 'Thought for 9s');
});

/**
 * @param {string} text
 * @param {number} from
 * @param {number} gap
 * @param {number} size
 * @returns {[number, Event][]}
 */
const bursts = (text, from, gap, size) => Array.from({ length: Math.ceil(text.length / size) },
  (_, at) => [from + at * gap, { type: 'text', delta: text.slice(at * size, at * size + size) }]);

const marked = new Marked({ gfm: true, breaks: true });
const DRAW = { markdown: (/** @type {string} */ text) => /** @type {string} */ (marked.parse(text)), year: '2026', cite: (/** @type {string} */ handle) => ({ 'data-ask-cite': `0 ${handle}` }) };

/**
 * @param {string} html
 * @returns {{ numbers: string[], pictures: number, words: string }}
 */
const seen = html => ({
  numbers: [...html.matchAll(/class="(?:ck-fmenu__btn )?ck-cite mac-footnote[^"]*"[^>]*>([^<]*)</gu)].map(([, said]) => said),
  pictures: (html.match(/class="ck-pics__pic/gu) ?? []).length,
  words: html.replace(/<[^>]*>/gu, '').replace(/\s+/gu, ' ').trim(),
});

test('citations told while the answer arrives: each drawn with its final number, a photo with its room the moment its words show, and done changes nothing on screen', () => {
  const day = '2026-11-12';
  const dinner = { ref: 'line.a', kind: /** @type {const} */ ('message'), opens: { page: /** @type {const} */ ('days'), day }, day, title: 'Dinner at 20:00', chat: 'chat.a' };
  const refs = {
    r1: dinner,
    r2: { ref: 'picture.b', kind: /** @type {const} */ ('photo'), opens: { page: /** @type {const} */ ('days'), day }, image: 'hash-b', day, title: 'The table' },
    r3: { ...dinner, ref: 'line.c', title: 'Table for six' },
  };
  const text = 'Dinner is at 20:00 [r1]. The table by the window [r2].\n\nAsha booked it for six [r3].';
  /** @type {[number, import('../public/ui/ask/turns.js').AskEvent][]} */
  const timeline = [[0, { type: 'chat', chat: 'c', n: 2 }], [200, { type: 'step', call: 1, name: 'search', words: 'Searching messages' }],
    [900, { type: 'step', call: 1, words: 'Searched messages', ms: 700 }],
    ...Object.entries(refs).map(([handle, cited], at) => /** @type {[number, import('../public/ui/ask/turns.js').AskEvent]} */ ([1300 + at, { type: 'ref', handle, cited }])),
    ...bursts(text, 1400, 200, 24).map(([t, event]) => /** @type {[number, import('../public/ui/ask/turns.js').AskEvent]} */ ([t, /** @type {any} */ (event)])),
    [3600, { type: 'done', message: { chat: 'c', n: 2, at_ms: 3600, role: 'assistant', text, refs, end: 'done', thought_ms: 1500 } }]];
  const live = askLive(0, PACE);
  let turn = asking('Where was dinner?', 0);
  /** @type {{ html: string, shown: string }[]} */
  const frames = [];
  let next = 0;
  for (let t = 0; t <= 30_000; t += FRAME) {
    while (next < timeline.length && timeline[next][0] <= t) {
      const [at, event] = timeline[next++];
      if (event.type === 'step' || event.type === 'text' || event.type === 'done') live.hear(/** @type {any} */ (event), at);
      turn = withEvent(turn, event);
    }
    const view = live.at(t);
    if (view.shown) frames.push({ html: askAnswer({ text: view.shown, refs: shownRefs(turn.refs ?? {}), paced: true }, DRAW), shown: view.shown });
    if (view.settled) break;
  }
  const settled = seen(askAnswer({ text: turn.text, refs: turn.refs ? shownRefs(turn.refs) : null }, DRAW));
  assert.deepEqual(settled.numbers, ['1', '2', '1'], 'r3 is the same conversation as r1: it folds to its number');
  assert.equal(settled.pictures, 1);
  for (const { html, shown } of frames) {
    const now = seen(html);
    assert.deepEqual(now.numbers, settled.numbers.slice(0, now.numbers.length), `a citation renumbered while the words came: ${shown}`);
    assert.equal(now.numbers.length, (shown.match(/\[r\d\]/gu) ?? []).length, `a citation shown is drawn at once: ${shown}`);
    assert.equal(now.pictures, shown.includes('[r2]') ? 1 : 0, `the photo shows the moment its words do: ${shown}`);
  }
  assert.equal(frames.at(-1)?.shown, text);
  assert.deepEqual(seen(/** @type {{ html: string }} */ (frames.at(-1)).html), settled, 'the end moves nothing');
  assert.deepEqual(turn.refs, refs, 'done keeps the refs told before it');
});

test('a full stop or comma right after a citation never wraps onto its own line: the citation and its punctuation are one group', () => {
  const refs = shownRefs({ r1: { ref: 'line.a', kind: 'message', opens: { page: 'read' }, title: 'Dinner' } });
  const html = askAnswer({ text: 'At 20:00 [r1]. Then home [r1], late.', refs }, DRAW);
  const glued = [...html.matchAll(/<span class="ck-answer__glued">(.*?<\/button>)<span class="ck-answer__w">([^<]*)<\/span><\/span>/gu)];
  assert.deepEqual(glued.map(([, , after]) => after), ['.', ',']);
  assert.match(html, /<span class="ck-answer__w">20:00<\/span> <span class="ck-answer__glued"><button/u, 'the space before a citation still breaks');
});
