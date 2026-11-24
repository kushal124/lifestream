// @ts-check
/** @import { Reading } from '../../pages.js' */
/** @import { HomeChange } from '../live.js' */
import { shortDay } from '../../lib/words.js';

/**
 * @typedef {{ columns: string[], rows: (string | number | boolean | null)[][], total?: { n: number, sum?: number | string },
 *   next?: string | null }} PlaysCount
 */

export const LISTENING = 'listening';
export const SCREEN = 'screen';

/**
 * @param {string} name
 * @param {string} why
 */
export const unopened = (name, why) => why ? `Couldn’t open ${name}: ${why}` : `Couldn’t open ${name}.`;

/**
 * @param {Reading | null} reading
 * @param {string} today
 */
export function readingWords(reading, today) {
  if (!reading) return '';
  if (reading.state === 'building') return reading.line;
  const { newest } = reading;
  return newest.kind === 'day' ? `${reading.line} ${shortDay(newest.day, today.slice(0, 4))}` : reading.line;
}

/**
 * @template {{ rows: unknown[] }} P
 * @param {P} page
 * @param {P} read
 * @returns {P}
 */
export const pageJoined = (page, read) => ({ ...read, rows: [...page.rows, ...read.rows] });

/**
 * @param {Pick<HomeChange, 'clock' | 'clockMoved'>} change
 * @param {string} q
 * @returns {'ask' | 'draw' | null}
 */
export const onClock = (change, q) => !change.clock ? null : change.clockMoved && q.trim() ? 'ask' : 'draw';

/** @param {unknown} error */
export const cursorExpired = error => typeof error === 'object' && error !== null && /** @type {{ code?: unknown }} */ (error).code === 'CURSOR_EXPIRED';

/**
 * @template T
 * @template [R=never]
 * @param {(retry: R | null) => Promise<T>} read
 * @param {(answer: T) => void} land
 * @param {() => string} keyOf
 */
export function newest(read, land, keyOf) {
  let asked = 0;
  let wanted = false;
  let running = false;
  /** @type {R | null} */
  let carried = null;
  return {
    drop() {
      asked += 1;
      wanted = false;
      carried = null;
    },
    /** @param {R | null} [retry] */
    async ask(retry = null) {
      asked += 1;
      wanted = true;
      if (retry !== null) carried = retry;
      if (running) return;
      running = true;
      try {
        for (;;) {
          const mine = asked;
          const key = keyOf();
          const given = carried;
          carried = null;
          const answer = await read(given);
          if (!wanted) return;
          if (mine === asked || keyOf() === key) land(answer);
          if (mine === asked) return;
        }
      } finally {
        running = false;
      }
    },
  };
}
