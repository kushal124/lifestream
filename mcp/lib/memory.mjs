// @ts-check
import { clockOf } from './home-clock.mjs';

/**
 * @typedef {import('./door.mjs').Door} Door
 * @typedef {import('./home-clock.mjs').HomeClock} HomeClock
 */

export function openMemory() {
  /** @type {{ etag: string | null, clock: HomeClock, sent: number } | undefined} */
  let held;
  let sent = 0;

  return {
    /**
     * @param {Door} door
     * @returns {Promise<HomeClock>}
     */
    async clock(door) {
      const asked = held;
      const order = ++sent;
      const answer = await door.text('/v1/clock', {}, asked?.etag ?? null);
      const got = answer.status === 304 && asked !== undefined ? { etag: asked.etag, clock: asked.clock, sent: order }
        : { etag: answer.etag, clock: clockOf(JSON.parse(answer.text)), sent: order };
      if (held === undefined || held.sent < order) held = got;
      return answer.status === 304 ? got.clock : held.clock;
    },
  };
}
