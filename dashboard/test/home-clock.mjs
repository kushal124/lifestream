// @ts-check
process.env.TZ = 'Pacific/Kiritimati';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clockKeeper, installClock, lookup, placeholder } from '../public/lib/home-clock.js';
import { calendarDate, clock, dateWords, monthYear, rowWhen } from '../public/lib/words.js';
import { clockFor } from './stand-ins/clock.mjs';

const CASES = JSON.parse(readFileSync(new URL('../../packages/core/test/clock-cases.json', import.meta.url), 'utf8'));
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** @param {string} day @param {number} by */
const addDays = (day, by) => new Date(Date.parse(`${day}T00:00:00Z`) + by * DAY).toISOString().slice(0, 10);

test('C1: every case of the case file filed as the home files it', () => {
  let cases = 0;
  for (const { name, clock: held, cases: each } of CASES.clocks) {
    for (const one of each) {
      cases++;
      assert.deepEqual(lookup(held, one.at), { day: one.day, zone: one.zone, start_ms: one.start_ms, end_ms: one.end_ms },
        `${name}: ${one.why} (${one.utc})`);
    }
  }
  assert.ok(cases > 100, `${cases} cases`);
});

test('C1: the tests\' stand-in clocks are the home\'s, run for run', () => {
  for (const { name, clock: held } of CASES.clocks) {
    if (name === 'trip') continue;
    const last = held.runs.at(-1);
    const made = clockFor(held.zone, held.start_hour, { first: held.runs[0].day, last: addDays(last.day, last.days - 1) });
    assert.deepEqual(made.runs, held.runs, name);
  }
});

test('C2: before any clock, one open run from this machine\'s latest 04:00, in its zone, with no id', () => {
  const at = Date.UTC(2026, 9, 14, 12);
  const made = placeholder(at);
  assert.deepEqual(made, { id: null, runs: [{ day: '2026-10-14', start_ms: Date.UTC(2026, 9, 13, 14), days: 1, zone: 'Pacific/Kiritimati' }] });
  const keeper = clockKeeper({ now: () => at, wait: () => () => undefined });
  assert.equal(keeper.dayAt(at).zone, 'Pacific/Kiritimati');
  assert.equal(keeper.today(), '2026-10-14');
  assert.equal(keeper.dayAt(at + 3 * DAY).day, '2026-10-17');
  /** @type {boolean[]} */
  const told = [];
  keeper.onChange(moved => told.push(moved));
  const london = clockFor('Europe/London', 4);
  keeper.install(london);
  assert.deepEqual(told, [false], 'the first clock read replaces the placeholder, and says so: the home\'s days did not move');
  assert.equal(keeper.dayAt(at).zone, 'Europe/London');
  assert.equal(keeper.today(), '2026-10-14');
  keeper.install(clockFor('Europe/London', 4));
  assert.deepEqual(told, [false], 'the same clock read again tells no one');
});

test('C3: a page left open across the day start turns today once, at the day\'s end', () => {
  const london = clockFor('Europe/London', 4);
  let now = Date.UTC(2026, 9, 14, 22);
  /** @type {{ then: () => void, ms: number }[]} */
  const timers = [];
  const keeper = clockKeeper({ now: () => now, wait: (then, ms) => {
    const timer = { then, ms };
    timers.push(timer);
    return () => timers.splice(timers.indexOf(timer), 1);
  } });
  keeper.install(london);
  assert.equal(timers.length, 0, 'no timer while no one listens');
  /** @type {string[]} */
  const told = [];
  const stop = keeper.onChange(() => told.push(keeper.today()));
  assert.deepEqual(timers.map(each => each.ms), [5 * HOUR], 'one timer, for the day\'s end');
  assert.equal(keeper.today(), '2026-10-14');
  now = Date.UTC(2026, 9, 15, 1, 10);
  keeper.inFront();
  assert.deepEqual(told, []);
  now = Date.UTC(2026, 9, 15, 3);
  timers[0].then();
  assert.deepEqual(told, ['2026-10-15'], 'told once, at the day start');
  assert.deepEqual(timers.map(each => each.ms), [DAY], 'the next timer, for the next day\'s end');
  now += 2 * DAY + HOUR;
  keeper.inFront();
  assert.deepEqual(told, ['2026-10-15', '2026-10-17']);
  stop();
  assert.equal(timers.length, 0, 'no timer once no one listens');
  now += DAY;
  keeper.inFront();
  assert.deepEqual(told, ['2026-10-15', '2026-10-17']);
});

test('C4: the same today under a new clock tells once, and a 05:00 message moves days', () => {
  const now = Date.UTC(2026, 9, 14, 11);
  const early = Date.UTC(2026, 9, 14, 4);
  const keeper = clockKeeper({ now: () => now, wait: () => () => undefined });
  keeper.install(clockFor('Europe/London', 4));
  /** @type {boolean[]} */
  const told = [];
  keeper.onChange(moved => told.push(moved));
  assert.deepEqual([keeper.today(), keeper.dayAt(early).day], ['2026-10-14', '2026-10-14']);
  keeper.install(clockFor('Europe/London', 6));
  assert.deepEqual(told, [true], 'a new clock over the home\'s held one moves the home\'s days');
  assert.deepEqual([keeper.today(), keeper.dayAt(early).day], ['2026-10-14', '2026-10-13']);
});

test('C5: words by the home\'s day and the day\'s zone, never this machine\'s', () => {
  installClock(clockFor('Europe/London', 4));
  const message = Date.UTC(2026, 9, 15, 1, 10);
  assert.equal(clock(message), '02:10');
  assert.equal(dateWords(message), 'Wed 14 Oct 2026');
  assert.equal(dateWords(message, { weekday: false, year: 2026 }), '14 Oct');
  assert.equal(monthYear(message), 'Oct 2026');
  assert.equal(calendarDate(message), '2026-10-15', 'the calendar date, for the midnight line alone');
  assert.equal(rowWhen(message, Date.UTC(2026, 9, 15, 2, 59)), '02:10');
  assert.equal(rowWhen(message, Date.UTC(2026, 9, 15, 3)), 'Yesterday');
  assert.equal(rowWhen(message, Date.UTC(2026, 9, 15, 3), true), '02:10', 'under Yesterday, its clock');
  assert.equal(clock(Date.UTC(2026, 11, 15, 2, 10)), '02:10');
});

test('C5: a made-up trip prints each day in its own zone', () => {
  const trip = CASES.clocks.find((/** @type {{ name: string }} */ each) => each.name === 'trip').clock;
  installClock(trip);
  assert.equal(clock(Date.UTC(2026, 0, 9, 12)), '17:30');
  assert.equal(clock(Date.UTC(2026, 0, 15, 12)), '12:00');
  assert.equal(rowWhen(Date.UTC(2026, 0, 10, 3), Date.UTC(2026, 0, 10, 5)), 'Yesterday', 'the 29.5-hour day ends at 04:00 London');
});

test('C6: two reads of the clock, the older answering last: the newer clock stays', async () => {
  const keeper = clockKeeper({ now: () => Date.UTC(2026, 9, 14, 11), wait: () => () => undefined });
  /** @type {((clock: import('../public/lib/home-clock.js').Clock) => void)[]} */
  const answers = [];
  const read = () => new Promise(done => answers.push(done));
  let told = 0;
  keeper.onChange(() => told++);
  const older = keeper.refresh(read);
  const newer = keeper.refresh(read);
  answers[1](clockFor('Europe/London', 6, { id: 'newer' }));
  await newer;
  answers[0](clockFor('Europe/London', 4, { id: 'older' }));
  await older;
  assert.equal(keeper.dayAt(Date.UTC(2026, 9, 14, 4)).day, '2026-10-13');
  assert.equal(told, 1, 'the older answer installed nothing');
});
