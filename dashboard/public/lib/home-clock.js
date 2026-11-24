// @ts-check

const DAY_MS = 86_400_000;
const PLACEHOLDER_HOUR = 4;

/**
 * @typedef {{ day: string, start_ms: number, days: number, zone: string }} DayRun
 * @typedef {{ id: string | null, runs: DayRun[] }} Clock
 * @typedef {{ day: string, zone: string, start_ms: number, end_ms: number }} ClockDay
 */

/**
 * @param {string} day
 * @param {number} count
 */
const addDays = (day, count) => new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY_MS).toISOString().slice(0, 10);

/**
 * @param {Clock} clock
 * @param {number} ms
 * @returns {ClockDay}
 */
export function lookup(clock, ms) {
  const { runs } = clock;
  let at = 0;
  for (let low = 1, high = runs.length - 1; low <= high;) {
    const middle = (low + high) >> 1;
    if (runs[middle].start_ms <= ms) [at, low] = [middle, middle + 1];
    else high = middle - 1;
  }
  const run = runs[at];
  const last = at === runs.length - 1;
  const counted = Math.floor((ms - run.start_ms) / DAY_MS);
  const k = last ? counted : Math.min(counted, run.days - 1);
  const start_ms = run.start_ms + k * DAY_MS;
  const end_ms = !last && k === run.days - 1 ? runs[at + 1].start_ms : start_ms + DAY_MS;
  return { day: addDays(run.day, k), zone: run.zone, start_ms, end_ms };
}

/**
 * @param {number} now
 * @returns {Clock}
 */
export function placeholder(now) {
  const start = new Date(now);
  start.setHours(PLACEHOLDER_HOUR, 0, 0, 0);
  if (start.getTime() > now) start.setDate(start.getDate() - 1);
  const day = [start.getFullYear(), start.getMonth() + 1, start.getDate()].map(part => String(part).padStart(2, '0')).join('-');
  return { id: null, runs: [{ day, start_ms: start.getTime(), days: 1, zone: Intl.DateTimeFormat().resolvedOptions().timeZone }] };
}

/** @param {{ now?: () => number, wait?: (then: () => void, ms: number) => () => void }} [parts] */
export function clockKeeper({ now = () => Date.now(), wait = (then, ms) => {
  const timer = setTimeout(then, ms);
  return () => clearTimeout(timer);
} } = {}) {
  /** @type {Clock | null} */
  let kept = null;
  /** @type {((moved: boolean) => void) | null} */
  let listener = null;
  /** @type {ClockDay | null} */
  let held = null;
  /** @type {(() => void) | null} */
  let cancel = null;
  let asked = 0;

  const current = () => kept ??= placeholder(now());
  /** @param {number} ms */
  const dayAt = ms => lookup(current(), ms);
  const arm = () => {
    cancel?.();
    held = dayAt(now());
    cancel = wait(turned, Math.max(0, held.end_ms - now()));
  };
  function turned() {
    if (!listener) return;
    const was = held?.day;
    arm();
    if (held?.day !== was) listener(true);
  }
  /** @param {Clock} clock */
  function install(clock) {
    if (kept?.id != null && kept.id === clock.id) return;
    const moved = kept?.id != null;
    kept = clock;
    if (!listener) return;
    arm();
    listener(moved);
  }

  return {
    dayAt,
    today: () => dayAt(now()).day,
    inFront: turned,
    install,
    /** @param {() => Promise<Clock>} read */
    refresh(read) {
      const mine = ++asked;
      return read().then(clock => {
        if (mine === asked) install(clock);
      }, () => undefined);
    },
    /**
     * @param {(moved: boolean) => void} told
     * @returns {() => void}
     */
    onChange(told) {
      listener = told;
      arm();
      return () => {
        if (listener !== told) return;
        listener = null;
        cancel?.();
        cancel = null;
        held = null;
      };
    },
  };
}

const page = clockKeeper();
export const dayAt = page.dayAt;
export const today = page.today;
export const installClock = page.install;
export const refreshClock = page.refresh;
export const onClockChange = page.onChange;
export const clockInFront = page.inFront;
