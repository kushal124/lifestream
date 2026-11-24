// @ts-check

/**
 * @typedef {{ day: string, start_ms: number, days: number, zone: string }} DayRun
 * @typedef {{ day: string, zone: string, start_ms: number, end_ms: number }} HomeDay
 * @typedef {{ id: string, zone: string, start_hour: number, runs: DayRun[], dayAt: (ms: number) => HomeDay }} HomeClock
 */

const DAY_MS = 86_400_000;

/**
 * @param {{ id: string, zone: string, start_hour: number, runs: DayRun[] }} answer
 * @returns {HomeClock}
 */
export function clockOf({ id, zone, start_hour, runs }) {
  return { id, zone, start_hour, runs, dayAt: ms => dayAt(runs, ms) };
}

/**
 * @param {DayRun[]} runs
 * @param {number} ms
 * @returns {HomeDay}
 */
export function dayAt(runs, ms) {
  let low = 0;
  let high = runs.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (/** @type {DayRun} */ (runs[middle]).start_ms <= ms) low = middle;
    else high = middle - 1;
  }
  const run = /** @type {DayRun} */ (runs[low]);
  const next = runs[low + 1];
  let k = Math.floor((ms - run.start_ms) / DAY_MS);
  if (next !== undefined) k = Math.min(k, run.days - 1);
  const start_ms = run.start_ms + k * DAY_MS;
  const end_ms = next !== undefined && k === run.days - 1 ? next.start_ms : start_ms + DAY_MS;
  return { day: addDays(run.day, k), zone: run.zone, start_ms, end_ms };
}

/**
 * @param {string} day
 * @param {number} n
 */
function addDays(day, n) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}
