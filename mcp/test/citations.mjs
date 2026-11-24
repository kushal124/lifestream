// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { citedOf, spelledOut } from '../lib/ask/ask.mjs';
import { openHandles } from '../lib/ask/handles.mjs';
import { openWrapper } from '../lib/hiding.mjs';

/** @param {number[]} numbers */
const handlesOf = numbers => openHandles(Object.fromEntries(numbers.map(n => [`r${n}`, /** @type {const} */ ({ ref: `record.synthetic-${n}`, kind: 'record',
  day: '2026-09-25', title: `Synthetic ${n}`, opens: { page: 'days', day: '2026-09-25' } })])));

test('1: a range of forty, one missing in the middle, keeps the thirty-nine it covers', () => {
  const forty = Array.from({ length: 40 }, (_, at) => at + 1).filter(n => n !== 20);
  assert.equal(spelledOut('Forty lines [r1–r40].', handlesOf(forty)), `Forty lines [${forty.map(n => `r${n}`).join(', ')}].`);
});

test('2: a range past a thousand keeps every held source in it, however wide', () => {
  assert.equal(spelledOut('Both ends [r1–r1001].', handlesOf([1, 1001])), 'Both ends [r1, r1001].');
  assert.equal(spelledOut('Far apart [r2 to r250000].', handlesOf([1, 2, 250_000, 250_001])), 'Far apart [r2, r250000].');
});

test('3: a range typed past the handles given cites only those given', () => {
  assert.equal(spelledOut('Mistyped [r1–r99999].', handlesOf([1, 2, 3])), 'Mistyped [r1, r2, r3].');
});

test('4: a range in a list joins it once; a range naming none is dropped with its bracket; a bracket of no range stays as written', () => {
  const held = handlesOf([1, 2, 9]);
  assert.equal(spelledOut('A list [r1, r2 – r9].', held), 'A list [r1, r2, r9].');
  assert.equal(spelledOut('None [r500-r600].', held), 'None.');
  assert.equal(spelledOut('One [r2].', held), 'One [r2].');
});

test('5, 6: a run gives every handle it carried, in the order read, in any field of a JSON answer, never a cursor nor a record\'s words nor a line of a page', () => {
  const handles = handlesOf([]);
  const page = ['Quoted from the person\'s own record.', 'Opened https://example.com/page: a web page.', '', '[r14] Person D: 3 messages',
    '[r15]   09:00 Person D: see r3 and [r4]', 'next: r16'].join('\n');
  assert.deepEqual(handles.ran({ cited: [], text: page, links: [] }), []);
  const counted = JSON.stringify({ asked: 'count of messages', total: { n: 3, ref: 'r5' }, rows: [['2026-09-25', 3, 'r6'], ['2026-09-26', 1, 'r7']], next: 'r8' });
  assert.deepEqual(handles.ran({ cited: [], text: counted, links: [] }), ['r5', 'r6', 'r7']);
  const people = JSON.stringify({ matches: [{ ref: 'r1', kind: 'person', name: 'Person D', chats: [{ chat: 'r2', title: 'Person D', messages: 3 }] }], note: 'r9 is words' });
  assert.deepEqual(handles.ran({ cited: [], text: people, links: [] }), ['r1', 'r2']);
  assert.equal(spelledOut('All [r5–r7].', handles), 'All [r5, r6, r7].');
  assert.equal(spelledOut('The page [r14–r15].', handles), 'The page.');
});


/** @param {string} name */
const fixture = name => JSON.parse(readFileSync(new URL(`../../packages/home/test/contract/${name}.json`, import.meta.url), 'utf8'));

/**
 * @param {Record<string, string>} refs
 * @param {Record<string, unknown> | undefined} citations
 */
const restoringDoor = (refs, citations) => /** @type {any} */ ({
  pass: 'synthetic',
  async json(/** @type {string} */ path) { throw new Error(`a citation read the home: ${path}`); },
  async post(/** @type {string} */ path, /** @type {any} */ body) {
    assert.equal(path, '/v1/restore-details');
    const cited = [...new Set([...String(body.text).matchAll(/r[1-9][0-9]*/gu)].map(([handle]) => handle))].filter(handle => handle in refs);
    return { level: 'none', epoch: 1, text: body.text, marks: [], unknown: [], refs: cited.map(handle => ({ handle, ref: refs[handle] })),
      ...(citations === undefined ? {} : { citations }) };
  },
});

async function keptOf(/** @type {string} */ text, /** @type {any} */ door) {
  const kept = await openWrapper({ table: 'chat:c-0001', agent: false }).words(door, text);
  return citedOf(kept.refs, kept.citations);
}

test('7, 9: a kept answer\'s citations are its restore\'s `citations`, each as the door made it, with where it opens; a `gone` kept as given; the home never read', async () => {
  const citations = fixture('citations');
  const refs = Object.fromEntries(Object.entries(citations).map(([handle, each]) => [handle, each.ref]));
  const text = `Each kind ${Object.keys(citations).map(handle => `[${handle}]`).join(' ')}.`;
  const kept = await keptOf(text, restoringDoor(refs, citations));
  assert.deepEqual(kept, citations);
  for (const each of Object.values(kept)) assert.ok('opens' in each || ('kind' in each && each.kind === 'gone'), JSON.stringify(each));
  assert.deepEqual(kept.r12, { ref: citations.r12.ref, kind: 'gone', why: citations.r12.why });
});

test('8: a restore stating no `citations` keeps each cited handle as its ref alone; one describing only some keeps the rest so', async () => {
  const citations = fixture('citations');
  const refs = { r3: citations.r3.ref, r8: citations.r8.ref };
  assert.deepEqual(await keptOf('Two [r3, r8].', restoringDoor(refs, undefined)), { r3: { ref: citations.r3.ref }, r8: { ref: citations.r8.ref } });
  assert.deepEqual(await keptOf('Two [r3, r8].', restoringDoor(refs, { r3: citations.r3 })), { r3: citations.r3, r8: { ref: citations.r8.ref } });
  assert.deepEqual(await keptOf('None [r99].', restoringDoor(refs, {})), {});
});

test('10: a step names a handle by the title the answer gave it, as the door hid it, or by a kept answer\'s citation; else by nothing', () => {
  const citations = fixture('citations');
  const handles = openHandles({ r3: citations.r3, r8: citations.r8, r9: citations.r9, r12: citations.r12, r13: { ref: 'record.alone' } });
  assert.deepEqual([handles.name('r3'), handles.name('r8'), handles.name('r9'), handles.name('r12'), handles.name('r13')],
    ['Person A', 'sum of amount over payments, by item', 'Person A', undefined, undefined]);
  handles.ran({ cited: [{ handle: 'r20', title: 'Refund receipt' }, { handle: 'r21', title: 'lunch with [[Person 1]]' }, { handle: 'r13', title: 'Now named' }], links: [], text: '{}' });
  assert.deepEqual([handles.name('r20'), handles.name('r21'), handles.name('r13')], ['Refund receipt', 'lunch with [[Person 1]]', 'Now named']);
  assert.deepEqual(handles.within(1, 30), ['r3', 'r8', 'r9', 'r12', 'r13', 'r20', 'r21']);
});

test('11: a voice note\'s citation keeps its `voice` as the restore described it, a message\'s, a line\'s and the person\'s own recording\'s; a citation without one gains none', async () => {
  const audio = (/** @type {string} */ hex) => `sha256:${hex.repeat(64)}`;
  const day = '2026-09-27';
  const voiced = {
    r1: { ref: 'record.synthetic-note', kind: 'message', day, at: `${day}T19:00-04:00`, title: 'Person A', chat: 'chat.synthetic-a', chat_title: 'Person A',
      opens: { page: 'days', day, focus: 'rec:whatsapp:+15550000009:iphone-aa01 msg synthetic-note' },
      voice: { audio: audio('a'), record: 'record.synthetic-note', seconds: 3, from: 'Person A' } },
    r2: { ref: 'line.synthetic-line', kind: 'line', day, at: `${day}T19:00-04:00`, title: 'Person A',
      opens: { page: 'days', day, focus: 'rec:whatsapp:+15550000009:iphone-aa01 msg synthetic-note' },
      voice: { audio: audio('a'), record: 'record.synthetic-note', seconds: 3, from: 'Person A' } },
    r3: { ref: 'record.synthetic-recording', kind: 'record', day, at: `${day}T19:20-04:00`, title: 'Voice note',
      opens: { page: 'days', day, focus: 'rec:voice-notes:local:iphone-aa01 voice synthetic-recording' },
      voice: { audio: audio('b'), record: 'record.synthetic-recording', seconds: 3, mine: true } },
    r4: { ref: 'record.synthetic-words', kind: 'message', day, title: 'Person A', opens: { page: 'days', day } },
  };
  const refs = Object.fromEntries(Object.entries(voiced).map(([handle, each]) => [handle, each.ref]));
  const kept = await keptOf('Person A said it [r1] [r2], you said yours [r3], then wrote [r4].', restoringDoor(refs, voiced));
  assert.deepEqual(kept, voiced);
  assert.equal('voice' in kept.r4, false);
});
