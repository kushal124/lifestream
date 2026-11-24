// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openWrapper } from '../lib/hiding.mjs';
import { NOTE } from '../lib/shape.mjs';
import { read } from '../lib/tools/read.mjs';

/**
 * @param {string} name
 * @returns {any}
 */
const fixture = name => JSON.parse(readFileSync(new URL(`../../packages/home/test/contract/${name}.json`, import.meta.url), 'utf8'));

const ROOM = 20_000;

/** @param {any[]} pages */
function contextOf(pages) {
  /** @type {Record<string, unknown>[]} */
  const asked = [];
  return {
    asked,
    async read(/** @type {string} */ path, /** @type {Record<string, unknown>} */ args) {
      assert.equal(path, '/v1/read');
      asked.push(args);
      const page = pages.shift();
      if (page === undefined) throw new Error('the synthetic door was read once too often');
      return structuredClone(page);
    },
    door: new Proxy({}, { get: (_, name) => { throw new Error(`read touched door.${String(name)}`); } }),
  };
}

/** @param {any} told */
const plain = told => /** @type {any} */ (JSON.parse(JSON.stringify(told.json)));

/**
 * @param {any} json
 * @returns {string[]}
 */
const linesOf = json => (json.note === NOTE ? [] : json.note.slice(NOTE.length + 1, -1).split('. '));

/**
 * @param {Record<string, unknown>} args
 * @param {ReturnType<typeof contextOf>} context
 */
async function opened(args, context) {
  const json = plain(await read.run(/** @type {any} */ (args), /** @type {any} */ (context)));
  const { note, ...answer } = json;
  return { answer, lines: linesOf({ note }) };
}

test('1: a record past the reader\'s 20,000 characters is read to its end by the door\'s `next`, every page as the door gave it, nothing lost', async () => {
  const words = Array.from({ length: 5_000 }, (_, at) => `word${at}`).join(' ');
  assert.ok(words.length > 2 * ROOM);
  const head = fixture('read-record');
  const cut = ROOM - 2_000;
  const pages = [];
  for (let at = 0, n = 1; at < words.length; at += cut, n++) {
    const last = at + cut >= words.length;
    pages.push({ what: 'record', ref: 'r1', day: head.day, family: head.family, title: head.title, text: words.slice(at, at + cut), ...(last ? {} : { next: `r${100 + n}` }) });
  }
  const context = contextOf(structuredClone(pages));
  let joined = '';
  /** @type {Record<string, unknown>} */
  let args = { ref: 'r1' };
  for (const page of pages) {
    const { answer, lines } = await opened(args, context);
    assert.deepEqual(answer, page, 'the page is the door\'s, uncut');
    assert.ok(JSON.stringify(answer).length <= ROOM);
    joined += answer.text;
    if (typeof answer.next !== 'string') {
      assert.deepEqual(lines, []);
      break;
    }
    assert.deepEqual(lines, ['`next` reads on']);
    args = { cursor: answer.next };
  }
  assert.equal(joined, words, 'every word, once, in order');
  assert.deepEqual(context.asked, [{ ref: 'r1' }, ...pages.slice(0, -1).map(page => ({ cursor: page.next }))]);
});

test('1, 4: a page that continues a record past its words states them `""`, beside its history and `who`, handed on as the door gave it', async () => {
  const page = { what: 'record', ref: 'r1', day: '2026-10-02', family: 'mail', title: 'Your example receipt', text: '', who: ['r4', 'r5'],
    history: [{ at: '2026-10-02T18:40+01:00', text: 'a version' }], next: 'r9' };
  const { answer, lines } = await opened({ cursor: 'r8' }, contextOf([page]));
  assert.deepEqual(answer, page);
  assert.deepEqual(lines, ['`next` reads on']);
});

test('2: a place the door pages, its visits then its photos and people, is two answers, each the door\'s, the first going on', async () => {
  const { place } = fixture('read-place');
  const { visits, photos, people, ...named } = place;
  const first = { what: 'place', ref: 'r40', place: { ...named, visits }, next: 'r41' };
  const second = { what: 'place', ref: 'r40', place: { slug: place.slug, name: place.name, ...(photos === undefined ? {} : { photos }), ...(people === undefined ? {} : { people }) } };
  const context = contextOf([first, second]);
  const one = await opened({ ref: 'r40' }, context);
  assert.deepEqual(one.answer, first);
  assert.deepEqual(one.lines, ['`next` reads on']);
  const two = await opened({ cursor: 'r41' }, context);
  assert.deepEqual(two.answer, second);
  assert.deepEqual(two.lines, []);
  assert.deepEqual(context.asked, [{ ref: 'r40' }, { cursor: 'r41' }]);
});

test('3, 4: several refs, one gone and two the call did not open: each said, the answer the door\'s; a line\'s `cites_more` and Go to\'s `{ref, name}` handed on', async () => {
  const line = fixture('read-line');
  const answer = {
    what: 'refs',
    opened: [
      { ...fixture('read-record'), ref: 'r1' },
      { what: 'gone', ref: 'r2', why: 'this record is no longer held: it was removed, or its source erased it' },
      { ...line, ref: 'r3', lines: line.lines.map((/** @type {any} */ each) => ({ ...each, cites: ['r6'], cites_more: 3 })), goto: [{ ref: 'r7', name: 'Example Cafe' }] },
    ],
    unopened: ['r4', 'r5'],
  };
  const { answer: got, lines } = await opened({ ref: ['r1', 'r2', 'r3', 'r4', 'r5'] }, contextOf([answer]));
  assert.deepEqual(got, answer);
  assert.deepEqual(lines, ['a ref is gone: this record is no longer held: it was removed, or its source erased it',
    '2 refs were not opened in this call (`unopened`): read them again']);
  assert.ok(!JSON.stringify(got).includes('"focus"'), 'no focus is made up');
  const one = await opened({ ref: ['r1', 'r4'] }, contextOf([{ what: 'refs', opened: [answer.opened[0]], unopened: ['r4'] }]));
  assert.deepEqual(one.lines, ['1 ref was not opened in this call (`unopened`): read it again']);
});

test('5: through the one dispatcher, `read` posts `/v1/read` once with the turn\'s own pass, `{args, to, shown}`, its arguments as the model wrote them, and hands on the door\'s answer; no restore, no hide', async () => {
  /** @type {{ pass: string, path: string, body: any }[]} */
  const calls = [];
  const turn = 'turn-pass-0001';
  const door = {
    pass: turn,
    forModel() { return door; },
    async json(/** @type {string} */ path) { throw new Error(`read GET ${path}`); },
    async post(/** @type {string} */ path, /** @type {any} */ body) {
      calls.push({ pass: this.pass, path, body });
      if (path === '/v1/read') return { ...fixture('read-record'), ref: 'r1' };
      throw new Error(`the synthetic door serves no POST ${path}`);
    },
  };
  const wrapper = openWrapper({ table: 'chat:c-0001', to: 'anthropic', agent: false, shown: () => ['the receipt'] });
  const ran = await wrapper.run(/** @type {any} */ (read), { ref: 'r1', from: '2026-10-02' }, { door: /** @type {any} */ (door) });
  assert.deepEqual(calls, [{ pass: turn, path: '/v1/read', body: { args: { ref: 'r1', from: '2026-10-02' }, to: 'anthropic', shown: ['the receipt'] } }]);
  const { note: _note, ...answer } = JSON.parse(ran.text);
  assert.deepEqual(answer, { ...fixture('read-record'), ref: 'r1' });
});

test('6: a `last` stretch\'s pages joined keep the first page\'s `freshness`, brief and lines alike; the pages after it carry none of their own', async () => {
  const freshness = 'Synced in the last 15 min: 3 sources. Not since: Messages, iPhone (last synced 12:31, last item 12:30).';
  const line = (/** @type {string} */ at, /** @type {string} */ text) => ({ ref: `r${at.slice(11, 13)}`, at: `2026-11-23T${at.slice(11)}+05:30`, family: 'messages', text });
  const brief = [
    { what: 'brief', span: { from: '2026-11-23T09:00+05:30', to: '2026-11-23T10:00+05:30' }, days: [{ day: '2026-11-23', lines: [line('2026-11-23T09:10', 'a chat with Person A')] }], freshness, next: 'cursor:read:b2' },
    { what: 'brief', span: { from: '2026-11-23T10:00+05:30', to: '2026-11-23T12:00+05:30' }, days: [{ day: '2026-11-23', lines: [line('2026-11-23T11:20', 'a chat with Person B')] }] },
  ];
  const joined = await opened({ last: '3h' }, contextOf([...brief]));
  assert.deepEqual(joined.answer, { what: 'brief', span: { from: '2026-11-23T09:00+05:30', to: '2026-11-23T12:00+05:30' },
    days: [{ day: '2026-11-23', lines: [line('2026-11-23T09:10', 'a chat with Person A'), line('2026-11-23T11:20', 'a chat with Person B')] }], freshness });
  const lines = [
    { what: 'lines', span: { from: '2026-11-23T09:00+05:30', to: '2026-11-23T10:00+05:30' }, lines: [line('2026-11-23T09:10', 'one')], freshness, next: 'cursor:read:l2' },
    { what: 'lines', span: { from: '2026-11-23T10:00+05:30', to: '2026-11-23T12:00+05:30' }, lines: [line('2026-11-23T11:20', 'two')] },
  ];
  const both = await opened({ last: '3h', detail: 'lines' }, contextOf([...lines]));
  assert.deepEqual([both.answer.lines.length, both.answer.freshness, both.answer.next], [2, freshness, undefined]);
  const later = await opened({ cursor: 'cursor:read:l2' }, contextOf([lines[1]]));
  assert.equal(later.answer.freshness, undefined, 'a `next` page alone says nothing of freshness');
});

test('7: through the one dispatcher, a stretch\'s span reaches the caller beside its text, the joined pages\' whole span; a record has none', async () => {
  const span = (/** @type {string} */ from, /** @type {string} */ to) => ({ from: `2026-11-23T${from}+05:30`, to: `2026-11-23T${to}+05:30` });
  const pages = [
    { what: 'lines', span: span('09:00', '10:00'), lines: [{ ref: 'r09', at: '2026-11-23T09:10+05:30', family: 'messages', text: 'one' }], next: 'cursor:read:l2' },
    { what: 'lines', span: span('10:00', '12:00'), lines: [{ ref: 'r11', at: '2026-11-23T11:20+05:30', family: 'messages', text: 'two' }] },
    { ...fixture('read-record'), ref: 'r1' },
  ];
  const door = {
    forModel() { return door; },
    async json(/** @type {string} */ path) { throw new Error(`read GET ${path}`); },
    async post(/** @type {string} */ path) {
      if (path === '/v1/read') return pages.shift();
      throw new Error(`the synthetic door serves no POST ${path}`);
    },
  };
  const wrapper = openWrapper({ table: 'chat:c-0001', to: 'anthropic', agent: false });
  const stretch = await wrapper.run(/** @type {any} */ (read), { last: '3h', detail: 'lines' }, { door: /** @type {any} */ (door) });
  assert.deepEqual(stretch.span, span('09:00', '12:00'));
  const record = await wrapper.run(/** @type {any} */ (read), { ref: 'r1' }, { door: /** @type {any} */ (door) });
  assert.equal(record.span, undefined);
});
