// @ts-check

const HOUR_MS = 3_600_000;

/**
 * @param {string} zone
 * @param {number} start_hour
 * @returns {import('../../lib/home-clock.mjs').HomeClock}
 */
export function clockIn(zone, start_hour) {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return {
    id: `synthetic-${zone}-${start_hour}`, zone, start_hour, runs: [],
    dayAt: ms => ({ day: format.format(ms - start_hour * HOUR_MS), zone, start_ms: NaN, end_ms: NaN }),
  };
}
