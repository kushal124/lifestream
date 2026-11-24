// @ts-check
/** @import { Host, HostState } from './host.js' */
/** @import { StreamsReport } from '../types.js' */
import { fetchStreams } from './api.js';
import { pageReach } from './reach.js';
import { onHomeChange, whileShown } from '../ui/live.js';

export const AGAIN_S = 5;

export const UNREAD = 'Your connectors couldn’t be read.';

/** @param {unknown} error */
const waits = error => {
  const { status } = /** @type {{ status?: number }} */ (error ?? {});
  return status === undefined || status === 503;
};

/** @param {HostState | null} state */
export const homeThere = state => state === null || state.setup === null || state.setup.state === 'done';

/** @param {HostState | null} state */
const askable = state => homeThere(state) && (state === null || state.unit !== null);

/** @param {Host | null} host */
export function reportReader(host) {
  const seen = { state: host?.state ?? null, report: /** @type {StreamsReport | null} */ (null) };
  let etag = '';
  /** @type {import('./reach.js').Drawn | null} */
  let drawn = null;
  const reach = pageReach(host);
  /** @param {import('./reach.js').Retry} retry */
  const readAgain = retry => void read(retry);
  let started = 0;
  let answered = 0;
  /** @type {Promise<void> | null} */
  let running = null;
  /** @type {Promise<void> | null} */
  let queued = null;
  /** @type {import('./reach.js').Retry | null} */
  let queuedRetry = null;
  let notBefore = 0;
  let again = false;
  let listening = false;
  /** @type {Set<() => void>} */
  const listeners = new Set();

  /**
   * @param {import('./reach.js').Retry | null} [retry]
   * @returns {Promise<void>}
   */
  function read(retry = null) {
    if (!askable(seen.state)) return Promise.resolve();
    if (!listening) {
      listening = true;
      onHomeChange(change => {
        if (change.records) void read();
      });
    }
    if (running || Date.now() < notBefore) {
      if (retry !== null) queuedRetry = retry;
      queued ??= (running ?? new Promise(resolve => setTimeout(resolve, notBefore - Date.now()))).then(() => {
        queued = null;
        const carried = queuedRetry;
        queuedRetry = null;
        return read(carried);
      });
      return queued;
    }
    const unit = seen.state?.unit;
    const mine = ++started;
    const begun = reach.begin(retry);
    running = (async () => {
      try {
        const read = await fetchStreams(unit, seen.report ? etag : '');
        if (seen.state?.unit === unit) {
          if (read) {
            seen.report = read.report;
            etag = read.etag;
          }
          drawn = null;
          answered = mine;
        }
      } catch (error) {
        const { retryAfter = 0 } = /** @type {{ retryAfter?: number }} */ (error ?? {});
        drawn = reach.failed(error, begun, readAgain);
        if (retryAfter > 0) notBefore = Date.now() + retryAfter * 1_000;
        if (waits(error) && !(begun.again && drawn.kind === 'lack')) {
          if (retryAfter <= 0) notBefore = Date.now() + AGAIN_S * 1_000;
          again = true;
        }
      }
      running = null;
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch (error) {
          console.error(error);
        }
      }
      if (again) {
        again = false;
        void read();
      }
    })();
    return running;
  }

  host?.follow(state => {
    const before = seen.state;
    seen.state = state;
    if (before?.unit !== state.unit) seen.report = null;
    if (askable(state) && (!askable(before) || before?.unit !== state.unit)) void read();
  });

  return {
    seen,
    read,
    failure: () => !homeThere(seen.state) ? 'Lifestream isn’t set up on this Mac yet.'
      : drawn?.kind === 'wait' ? drawn.words : drawn?.kind === 'lack' ? drawn.words ?? UNREAD : '',
    drawn: () => drawn,
    /** @param {() => void} then */
    whenAnswered(then) {
      const after = started;
      const stop = this.follow(() => {
        if (answered <= after) return;
        stop();
        then();
      });
    },
    /**
     * @param {() => void} listener
     * @param {HTMLElement} [section]
     * @returns {() => void}
     */
    follow(listener, section) {
      const { hear, stop } = whileShown(section, listener, () => undefined);
      const heard = () => hear(undefined);
      listeners.add(heard);
      return () => {
        stop();
        listeners.delete(heard);
      };
    },
  };
}

/** @typedef {ReturnType<typeof reportReader>} ReportReader */
