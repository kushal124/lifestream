// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clockOf } from '../lib/home-clock.mjs';
import { openMemory } from '../lib/memory.mjs';

/** @type {{ clocks: { name: string, clock: any, cases: { at: number, why: string, day: string, start_ms: number, end_ms: number, zone: string }[] }[] }} */
const CASES = JSON.parse(readFileSync(new URL('../../packages/core/test/clock-cases.json', import.meta.url), 'utf8'));

test('1-5: every case of the case file is filed under its day, with its bounds and zone', () => {
  assert.ok(CASES.clocks.length > 5);
  for (const { name, clock, cases } of CASES.clocks) {
    const held = clockOf(clock);
    assert.equal(held.id, clock.id);
    for (const each of cases) {
      assert.deepEqual(held.dayAt(each.at), { day: each.day, zone: each.zone, start_ms: each.start_ms, end_ms: each.end_ms }, `${name}: ${each.why}`);
    }
  }
});

test('5: the made-up trip files each time in the zone of its day', () => {
  const trip = CASES.clocks.find(each => each.name === 'trip');
  assert.ok(trip !== undefined);
  const held = clockOf(trip.clock);
  const zones = new Set(trip.cases.map(each => each.zone));
  assert.ok(zones.size > 1, 'the trip holds days of more than one zone');
  for (const each of trip.cases) {
    assert.equal(held.dayAt(each.at).zone, each.zone, each.why);
  }
});

/** @param {number} hour */
const utcClock = hour => ({ id: `utc-${hour}`, zone: 'UTC', start_hour: hour, runs: [{ day: '1970-01-01', start_ms: hour * 3_600_000, days: 30_000, zone: 'UTC' }] });

test('6: a warm clock is replaced at the next read after the home starts again with a new id', async () => {
  const at = Date.UTC(2026, 9, 7, 5);
  let served = utcClock(4);
  /** @type {(string | null)[]} */
  const asked = [];
  /** @type {number[]} */
  const answered = [];
  const door = {
    pass: 'p-synthetic',
    /**
     * @param {string} path
     * @param {unknown} _params
     * @param {string | null} etag
     */
    text: async (path, _params, etag) => {
      assert.equal(path, '/v1/clock');
      asked.push(etag);
      const tag = `"${served.id}"`;
      answered.push(etag === tag ? 304 : 200);
      return etag === tag ? { status: 304, etag: tag, text: '' } : { status: 200, etag: tag, text: JSON.stringify(served) };
    },
  };
  const memory = openMemory();
  const read = async () => [(await memory.clock(/** @type {any} */ (door))).dayAt(at).day];
  assert.deepEqual(await read(), ['2026-10-07']);
  assert.deepEqual(await read(), ['2026-10-07']);
  served = utcClock(6);
  assert.deepEqual(await read(), ['2026-10-06']);
  assert.deepEqual(asked, [null, '"utc-4"', '"utc-4"']);
  assert.deepEqual(answered, [200, 304, 200]);
});

test('7: overlapping clock reads answered out of order: a 304 is the clock whose ETag it was sent with, and an older read never replaces a newer clock', async () => {
  /** @type {{ etag: string | null, answer: (value: unknown) => void }[]} */
  const sent = [];
  const door = /** @type {any} */ ({
    pass: 'p-synthetic',
    /** @param {string} path @param {unknown} _params @param {string | null} etag */
    text: (path, _params, etag) => {
      assert.equal(path, '/v1/clock');
      return new Promise(answer => { sent.push({ etag, answer }); });
    },
  });
  /** @param {{ id: string }} clock */
  const whole = clock => ({ status: 200, etag: `"${clock.id}"`, text: JSON.stringify(clock) });
  /** @param {string} id */
  const same = id => ({ status: 304, etag: `"${id}"`, text: '' });
  /**
   * @param {number} at
   * @param {unknown} value
   */
  const answer = (at, value) => /** @type {NonNullable<typeof sent[number]>} */ (sent[at]).answer(value);
  const memory = openMemory();
  const older = memory.clock(door);
  const newer = memory.clock(door);
  answer(1, whole(utcClock(6)));
  assert.equal((await newer).id, 'utc-6');
  answer(0, whole(utcClock(4)));
  assert.equal((await older).id, 'utc-6');
  const checking = memory.clock(door);
  const replacing = memory.clock(door);
  assert.deepEqual([sent[2]?.etag, sent[3]?.etag], ['"utc-6"', '"utc-6"']);
  answer(3, whole(utcClock(5)));
  assert.equal((await replacing).id, 'utc-5');
  answer(2, same('utc-6'));
  assert.equal((await checking).id, 'utc-6');
  const next = memory.clock(door);
  assert.equal(sent[4]?.etag, '"utc-5"');
  answer(4, same('utc-5'));
  assert.equal((await next).id, 'utc-5');
  const toSix = memory.clock(door);
  const backToFive = memory.clock(door);
  answer(6, same('utc-5'));
  assert.equal((await backToFive).id, 'utc-5');
  answer(5, whole(utcClock(6)));
  assert.equal((await toSix).id, 'utc-5');
  const after = memory.clock(door);
  assert.equal(sent[7]?.etag, '"utc-5"');
  answer(7, same('utc-5'));
  assert.equal((await after).id, 'utc-5');
});
