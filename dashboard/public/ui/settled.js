// @ts-check
/** @import { Settled } from '../lib/api.js' */

/**
 * @param {HTMLElement} page
 */
export function settledReads(page) {
  /** @type {unknown} */
  let wanted = null;
  /** @type {AbortController | null} */
  let out = null;
  const end = () => {
    wanted = null;
    out?.abort();
    out = null;
  };
  new MutationObserver(() => {
    if (page.hidden) end();
  }).observe(page, { attributes: true, attributeFilter: ['hidden'] });

  return {
    /** @param {unknown} [key] */
    want(key = true) {
      if (wanted !== key) end();
      wanted = key;
    },
    /** @param {unknown} [key] */
    keep(key = true) {
      if (wanted !== null && wanted !== key) end();
    },
    /**
     * @template T
     * @param {(asked: Settled) => Promise<T>} read
     * @param {{ key?: unknown, counts: (answer: T) => boolean, land: (answer: T, settled: boolean) => unknown }} given
     * @returns {{ first: Promise<void>, last: Promise<T> }}
     */
    read(read, { key = true, counts, land }) {
      if (wanted !== key) {
        const last = read({}).then(async answer => {
          await land(answer, false);
          return answer;
        });
        return { first: last.then(() => undefined), last };
      }
      out?.abort();
      const stop = new AbortController();
      out = stop;
      const going = () => out === stop && wanted === key;
      /** @type {() => void} */
      let landed = () => undefined;
      const last = /** @type {Promise<T>} */ ((async () => {
        let ended = false;
        try {
          let answer = /** @type {T} */ (await read({}));
          await land(answer, false);
          landed();
          while (going() && counts(answer)) {
            /** @type {T} */
            let held;
            try {
              held = /** @type {T} */ (await read({ settled: true, signal: stop.signal }));
            } catch {
              break;
            }
            if (!going()) break;
            await land(held, true);
            answer = held;
          }
          ended = true;
          return answer;
        } finally {
          if (out === stop) {
            out = null;
            if (ended && wanted === key) wanted = null;
          }
        }
      })());
      const first = new Promise((resolve, reject) => {
        landed = () => resolve(undefined);
        last.catch(reject);
      });
      return { first, last };
    },
  };
}
