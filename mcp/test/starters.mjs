// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DoorRefusal } from '../lib/errors.mjs';
import { clockOf } from '../lib/home-clock.mjs';
import { openStarters, STARTERS, startersOf } from '../lib/ask/starters.mjs';

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 10, 16, 12);
const CLOCK = clockOf({ id: 'c1', zone: 'UTC', start_hour: 0, runs: [{ day: '2026-11-16', start_ms: Date.UTC(2026, 10, 16), days: 1, zone: 'UTC' }] });

/**
 * @param {{ id: string, product: string, records: Record<string, number[]> }[]} sources
 * @param {{ records?: () => void }} [faults]
 */
function homeOf(sources, faults = {}) {
  /** @type {string[]} */
  const asked = [];
  const door = /** @type {any} */ ({
    pass: 'p1',
    /** @param {string} path @param {any} query */
    async json(path, query) {
      if (path === '/v1/sources') {
        asked.push(`sources ${query.after ?? ''}`);
        const rows = sources.map(source => ({ id: source.id, product: source.product, kinds: Object.keys(source.records) }));
        const half = Math.ceil(rows.length / 2);
        return query.after === undefined ? { sources: rows.slice(0, half), ...(half < rows.length ? { next: 'p2' } : {}) } : { sources: rows.slice(half) };
      }
      if (path === '/v1/records') {
        asked.push(`records ${query.source} ${query.kind}`);
        faults.records?.();
        const times = sources.find(source => source.id === query.source)?.records[query.kind] ?? [];
        const inside = times.map(hours => NOW + hours * 3_600_000).filter(at => at >= query.from_ms && at < query.to_ms);
        return { records: inside.slice(0, query.limit).map(at => ({ key: String(at) })) };
      }
      throw new Error(`no route ${path}`);
    },
  });
  const memory = {
    async clock() { return CLOCK; },
  };
  return { door, memory, asked };
}

test('the table: each kind once, each with its days in order', () => {
  assert.equal(new Set(STARTERS.map(each => each.kind)).size, STARTERS.length);
  for (const each of STARTERS) assert.ok(each.days[0] <= each.days[1], each.kind);
});

test('the starters are the first three kinds of the table with a record inside their days, every page of sources read', async () => {
  const { door, memory, asked } = homeOf([
    { id: 'whoop:1', product: 'whoop', records: { sleep: [-8], workout: [-24 * 3], recovery: [-1] } },
    { id: 'photos:1', product: 'photos', records: { photo: [] } },
    { id: 'mail:1', product: 'gmail', records: { mailmsg: [-2] } },
    { id: 'cal:1', product: 'gcal', records: { event: [30] } },
  ]);
  assert.deepEqual(await startersOf(door, memory, NOW), [
    { kind: 'sleep', question: 'How did I sleep last night?' }, { kind: 'workouts', question: 'What was my last workout?' },
    { kind: 'calendar', question: 'What’s on my calendar this week?' },
  ]);
  assert.deepEqual(asked.slice(0, 2), ['sources ', 'sources p2']);
  assert.deepEqual(asked.filter(line => line.startsWith('records')).sort(),
    ['records cal:1 event', 'records mail:1 mailmsg', 'records photos:1 photo', 'records whoop:1 sleep', 'records whoop:1 workout']);
});

test('another AI product\'s conversations, or Chat\'s own, are no one talked to; the iPhone\'s Screen Time is no screen work', async () => {
  const chatgptOnly = homeOf([
    { id: 'chatgpt:1', product: 'chatgpt', records: { msg: [-1], chat: [-1] } },
    { id: 'claude:1', product: 'claude', records: { msg: [-1] } },
    { id: 'ask:local:u1', product: 'ask', records: { msg: [-1] } },
  ]);
  assert.deepEqual(await startersOf(chatgptOnly.door, chatgptOnly.memory, NOW), []);
  assert.ok(!chatgptOnly.asked.some(line => line.startsWith('records')));
  const phoneOnly = homeOf([{ id: 'biome:phone', product: 'biome', records: { usage: [-20], 'app-focus': [-20] } }]);
  assert.deepEqual(await startersOf(phoneOnly.door, phoneOnly.memory, NOW), []);
  const talked = homeOf([{ id: 'wa:1', product: 'whatsapp', records: { msg: [-30] } }, { id: 'mac:1', product: 'screen', records: { frame: [-20] } }]);
  assert.deepEqual((await startersOf(talked.door, talked.memory, NOW)).map(each => each.kind), ['people', 'screen']);
});

test('an import whose records are all a year old offers nothing: each question is of its own days', async () => {
  const yearOld = -365 * 24;
  const { door, memory } = homeOf([
    { id: 'whoop:1', product: 'whoop', records: { sleep: [yearOld], workout: [yearOld] } },
    { id: 'wa:1', product: 'whatsapp', records: { msg: [yearOld, yearOld - 1] } },
    { id: 'gmail:1', product: 'gmail', records: { mailmsg: [yearOld] } },
  ]);
  assert.deepEqual(await startersOf(door, memory, NOW), []);
  const edges = homeOf([{ id: 'loc:1', product: 'location', records: { fix: [-13] } }, { id: 'mac:1', product: 'screen', records: { frame: [-1] } }]);
  assert.deepEqual(await startersOf(edges.door, edges.memory, NOW), []);
});

test('readiness reads the starters only for a home with no conversation; a failed read answers none, and the next reads again', async () => {
  let refuse = true;
  const home = homeOf([{ id: 'gmail:1', product: 'gmail', records: { mailmsg: [-2] } }], {
    records() { if (refuse) { refuse = false; throw new DoorRefusal(503, 'NOT_NOW', 'starting', 5); } },
  });
  let conversations = 0;
  const starters = openStarters({ memory: home.memory, any: async () => conversations > 0, now: () => NOW });
  assert.deepEqual(await starters.read(home.door), []);
  const [first, second] = await Promise.all([starters.read(home.door), starters.read(home.door)]);
  assert.deepEqual(first, [{ kind: 'mail', question: 'What came in my mail this week?' }]);
  assert.equal(second, first);
  assert.equal(home.asked.filter(line => line.startsWith('records')).length, 2);
  conversations = 1;
  home.asked.length = 0;
  assert.deepEqual(await starters.read(home.door), []);
  assert.deepEqual(home.asked, []);
  const down = openStarters({ memory: home.memory, any: async () => false, now: () => NOW });
  const downDoor = { ...home.door, async json(/** @type {string} */ path, /** @type {any} */ query) {
    if (path === '/v1/records') throw new Error('down');
    return home.door.json(path, query);
  } };
  assert.deepEqual(await down.read(downDoor), []);
});
