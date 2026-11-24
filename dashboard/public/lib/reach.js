// @ts-check

/** @typedef {'answering' | 'waiting' | 'starting' | 'unreachable' | 'held' | 'update' | 'refused' | 'unpaired'} ReachName */

/**
 * @typedef {object} ReachLink
 * @property {string} id
 * @property {string} name
 * @property {'passed' | 'failed' | 'unchecked'} state
 * @property {string} value
 * @property {string | null} fix
 * @property {{ do: string, label: string } | null} act
 */

/**
 * @typedef {object} Reach
 * @property {ReachName} state
 * @property {number} revision
 * @property {'warning' | 'caution' | 'waiting' | 'done' | null} tone
 * @property {string | null} title
 * @property {string | null} line
 * @property {string | null} meta
 * @property {{ do: string, label: string }[]} acts
 * @property {string | null} last
 * @property {ReachLink[]} path
 * @property {boolean} checking
 */

/** @typedef {{ state: 'reach' } | { state: 'wait', words: string, until: number } | { state: 'refused', words: string } | { state: 'saving', words: string } | { state: 'unknown', words: string } | { state: 'failed' }} RequestState */

/** @typedef {'not-sent' | 'refused' | 'saving' | 'unknown'} Said */

export const WAITING = 'Waiting for Lifestream.';
export const NOT_SENT = 'Not sent';
export const TRY_AGAIN = 'Try again';
export const UNKNOWN = 'Lifestream didn\'t say whether this was done.';
export const UNSAVED = 'Lifestream didn\'t say whether this was saved.';
export const SAVING = 'Still saving to Lifestream';
export const REFUSED = 'Lifestream didn\'t take this.';
export const PROBE_EVERY_S = 10;
export const ACT_MS = 15_000;
export const SEND_MS = 10_000;
export const LAST_SEND_MS = 4_000;
export const SENDS = 2;
export const CHECK_MOST_MS = 30_000;

/** @param {() => number} [now] */
export function budget(now = Date.now) {
  const deadline = now() + ACT_MS;
  let sent = 0;
  return {
    /** @returns {number | null} */
    next() {
      const left = deadline - now();
      if (sent >= SENDS || (sent > 0 && left < LAST_SEND_MS)) return null;
      sent += 1;
      return Math.min(SEND_MS, left);
    },
  };
}
/** @typedef {ReturnType<typeof budget>} Budget */

/** @param {number} checks */
export const checkAfter = checks => Math.min(CHECK_MOST_MS, 1_000 * 2 ** checks);

/** @param {unknown} error */
export const answerUnknown = error => {
  const { code, again } = /** @type {{ code?: unknown, again?: unknown }} */ (error ?? {});
  return code === 'OUTCOME_UNKNOWN' && again === true;
};

/** @type {Readonly<Record<string, string>>} */
export const DOOR_WORDS = Object.freeze({
  ASK_DOWN: 'Chat isn\'t answering on your Mac',
  DISK_LOW: 'Waiting for space on Lifestream\'s disk',
});

/**
 * @param {unknown} error
 * @param {number} [now]
 * @returns {RequestState}
 */
export function requestState(error, now = Date.now()) {
  const { status, code = '', retryAfter = 0, message = '', wait = '', began = false } = /** @type {{ status?: unknown, code?: string, retryAfter?: number, message?: string, wait?: string, began?: boolean }} */ (error ?? {});
  const words = message || '';
  if (answerUnknown(error)) return began ? { state: 'saving', words: SAVING } : { state: 'unknown', words: UNSAVED };
  if (code === 'OUTCOME_UNKNOWN') return { state: 'unknown', words: words || UNKNOWN };
  if (typeof status !== 'number' || code === 'GONE') return { state: 'reach' };
  if (status === 401 || status === 426) return { state: 'reach' };
  if (status === 503 && code === 'NOT_NOW' && (wait === 'starting' || wait === 'needs')) return { state: 'reach' };
  if (code === 'HOME_FAILED') return { state: 'failed' };
  if (status === 503 && (code === '' || code.startsWith('HTTP_'))) return { state: 'failed' };
  if (status === 503) {
    return { state: 'wait', words: DOOR_WORDS[code] ?? (words || WAITING), until: now + (retryAfter > 0 ? retryAfter : PROBE_EVERY_S) * 1_000 };
  }
  if (status >= 500) return { state: 'failed' };
  return { state: 'refused', words: words || REFUSED };
}

/**
 * @param {unknown} error
 * @param {string} lack
 */
export function wordsOr(error, lack) {
  const state = requestState(error);
  return state.state === 'refused' || state.state === 'wait' || state.state === 'saving' || state.state === 'unknown' ? state.words : lack;
}

/**
 * @param {Pick<ReachHost, 'follow'>} host
 * @param {number} revision
 * @param {() => void} then
 */
export function afterRecovery(host, revision, then) {
  let done = false;
  /** @type {() => void} */
  let stop = () => undefined;
  stop = host.follow(state => {
    if (done || (state.reach?.revision ?? -1) <= revision) return;
    done = true;
    queueMicrotask(() => stop());
    then();
  });
}

/**
 * @param {RequestState} state
 * @returns {{ said: Said, words: string }}
 */
export function actSaid(state) {
  switch (state.state) {
    case 'wait': case 'refused': return { said: 'refused', words: state.words };
    case 'saving': return { said: 'saving', words: state.words };
    case 'unknown': return { said: 'unknown', words: state.words };
    default: return { said: 'not-sent', words: NOT_SENT };
  }
}

/** @param {{ said: Said, words?: string }} failure */
export const actWords = ({ said, words = '' }) => said === 'not-sent' ? NOT_SENT
  : words || (said === 'saving' ? SAVING : said === 'unknown' ? UNKNOWN : REFUSED);

/** @param {Reach | null | undefined} reach */
export const lacks = reach => reach != null && reach.state !== 'answering' && reach.state !== 'waiting' && reach.state !== 'starting';

/**
 * @param {Reach | null | undefined} reach
 * @returns {{ word: string, signal: 'warning' | 'caution' } | null}
 */
export const reachWord = reach => !lacks(reach) ? null
  : reach?.state === 'unreachable' ? { word: 'Can’t reach', signal: 'warning' } : { word: 'Needs you', signal: 'caution' };

/**
 * @typedef {object} ReachHost
 * @property {(listener: (state: { reach?: Reach | null }) => void) => () => void} follow
 * @property {(message: { act: 'home', do: 'probe' }) => Promise<unknown>} act
 */

/** @typedef {{ revision: number, again: boolean }} Begun */

/** @typedef {{ readonly again: true }} Retry */

/** @typedef {{ kind: 'reach' } | { kind: 'wait', words: string, until: number } | { kind: 'lack', words: string | null, retry: boolean }} Drawn */

/**
 * @param {ReachHost | null} host
 * @param {HTMLElement | null} [root]
 */
export function pageReach(host, root = null) {
  /** @type {Reach | null} */
  let reach = null;
  /** @type {{ state: string, revision: number } | null} */
  let known = null;
  /** @type {Map<(retry: Retry) => void, number>} */
  const pending = new Map();
  let probing = false;
  /** @type {WeakSet<Retry>} */
  const issued = new WeakSet();
  let closed = false;

  /** @param {Iterable<(retry: Retry) => void>} agains */
  const ask = agains => {
    for (const again of [...agains]) {
      if (closed) return;
      pending.delete(again);
      /** @type {Retry} */
      const retry = Object.freeze({ again: true });
      issued.add(retry);
      again(retry);
    }
  };
  /** @param {number} revision */
  const risen = revision => ask([...pending].filter(([, begun]) => revision > begun).map(([again]) => again));

  const unfollow = host?.follow(state => {
    if (closed) return;
    reach = state.reach ?? null;
    if (reach && (!known || reach.revision >= known.revision)) known = { state: reach.state, revision: reach.revision };
    root?.classList.toggle('ck-lacks', lacks(reach));
    if (reach) risen(reach.revision);
  }) ?? (() => {});

  const probe = () => {
    if (probing || !host) return;
    probing = true;
    host.act({ act: 'home', do: 'probe' }).then(reply => {
      probing = false;
      if (closed) return;
      const { state, revision } = /** @type {{ state?: unknown, revision?: unknown }} */ (reply ?? {});
      if (typeof revision === 'number' && typeof state === 'string' && revision > (known?.revision ?? -1)) known = { state, revision };
      if (state === 'answering') ask(pending.keys());
      else if (typeof revision === 'number') risen(revision);
    }, () => { probing = false; });
  };

  return {
    get reach() { return reach; },
    /**
     * @param {Retry | null} [retry]
     * @returns {Begun}
     */
    begin: (retry = null) => ({ revision: known?.revision ?? 0, again: retry !== null && issued.delete(retry) }),
    /**
     * @param {unknown} error
     * @param {Begun} begun
     * @param {(retry: Retry) => void} again
     * @returns {Drawn}
     */
    failed(error, begun, again) {
      const state = requestState(error);
      if (state.state === 'wait') {
        return { kind: 'wait', words: state.words, until: state.until };
      }
      if (state.state === 'refused') return { kind: 'lack', words: state.words, retry: false };
      if (state.state !== 'reach' || !reach || !known) return { kind: 'lack', words: null, retry: true };
      if (known.revision > begun.revision) {
        queueMicrotask(() => ask([again]));
        return { kind: 'reach' };
      }
      if (begun.again && known.state === 'answering') return { kind: 'lack', words: null, retry: true };
      pending.set(again, Math.min(begun.revision, pending.get(again) ?? Infinity));
      if (!lacks(reach)) probe();
      return { kind: 'reach' };
    },
    close() {
      closed = true;
      unfollow();
      pending.clear();
      root?.classList.remove('ck-lacks');
    },
  };
}
