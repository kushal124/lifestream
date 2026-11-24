// @ts-check
/** @import { HostNeed } from '../../lib/host.js' */

const KEY = 'lifestream.dismissed';

/** @type {Set<() => void>} */
const listeners = new Set();

/** @param {Pick<HostNeed, 'id' | 'line' | 'detail'>} need */
export const stampOf = need => `${need.id}\n${need.line}\n${need.detail ?? ''}`;

/** @returns {Set<string>} */
export function dismissedOwn() {
  try {
    const kept = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '[]');
    return new Set(Array.isArray(kept) ? kept.filter(each => typeof each === 'string') : []);
  } catch {
    return new Set();
  }
}

/** @param {Set<string>} stamps */
function keep(stamps) {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify([...stamps]));
  } catch {
    return;
  }
  for (const listener of listeners) listener();
}

/** @param {string} stamp */
export function dismissOwn(stamp) {
  keep(new Set([...dismissedOwn(), stamp]));
}

/** @param {readonly HostNeed[]} standing */
export function forgetEnded(standing) {
  const kept = dismissedOwn();
  const now = new Set(standing.map(stampOf));
  const left = new Set([...kept].filter(stamp => now.has(stamp)));
  if (left.size !== kept.size) keep(left);
}

/** @param {() => void} listener */
export function onDismissed(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
