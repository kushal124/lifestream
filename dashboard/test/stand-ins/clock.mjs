// @ts-check

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** @type {Map<string, Intl.DateTimeFormat>} */
const formats = new Map();

/**
 * @param {number} ms
 * @param {string} zone
 */
function offsetOf(ms, zone) {
  let format = formats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' });
    formats.set(zone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(ms).map(part => [part.type, Number(part.value)]));
  const whole = Math.floor(ms / 1000) * 1000;
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - whole;
}

/**
 * @param {number} wall
 * @param {string} zone
 */
function wallToMs(wall, zone) {
  const before = offsetOf(wall - DAY_MS, zone);
  const after = offsetOf(wall + DAY_MS, zone);
  let found;
  for (const offset of new Set([before, after, offsetOf(wall - before, zone), offsetOf(wall - after, zone)])) {
    const ms = wall - offset;
    if (offsetOf(ms, zone) === offset && (found === undefined || ms < found)) found = ms;
  }
  return found ?? wall - before;
}

/** @param {string} day @param {number} by */
const addDays = (day, by) => new Date(Date.parse(`${day}T00:00:00Z`) + by * DAY_MS).toISOString().slice(0, 10);

/**
 * @param {string} zone
 * @param {number} startHour
 * @param {{ first?: string, last?: string, id?: string }} [span]
 * @returns {{ id: string, zone: string, start_hour: number, runs: { day: string, start_ms: number, days: number, zone: string }[] }}
 */
export function clockFor(zone, startHour, { first = '2020-01-01', last = '2030-12-31', id = `${zone}@${startHour}` } = {}) {
  const startOf = (/** @type {string} */ day) => wallToMs(Date.parse(`${day}T00:00:00Z`) + startHour * HOUR_MS, zone);
  const runs = [];
  let run = { day: first, start_ms: startOf(first), days: 0, zone };
  let start = run.start_ms;
  for (let day = first; day <= last; day = addDays(day, 1)) {
    const end = startOf(addDays(day, 1));
    run.days += 1;
    if (end - start !== DAY_MS && day < last) {
      runs.push(run);
      run = { day: addDays(day, 1), start_ms: end, days: 0, zone };
    }
    start = end;
  }
  runs.push(run);
  return { id, zone, start_hour: startHour, runs };
}

/** @param {{ day: string, zone: string, day_start_hour: number }} file */
export const clockOfDay = ({ day, zone, day_start_hour }) => clockFor(zone, day_start_hour,
  { first: addDays(day, -7), last: addDays(day, 7), id: `${zone}@${day_start_hour}:${day}` });
