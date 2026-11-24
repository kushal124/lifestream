// @ts-check
import { esc } from '../../lib/html.js';

/** @typedef {'engaged' | 'idle' | 'now' | 'plan' | 'caution' | 'warning' | 'waiting' | 'done'} SignalKind */

const SEVERITY = {
  warning: '<circle cx="12" cy="12" r="9.2" class="ck-stroke-warning" stroke-width="2" fill="none"/>'
    + '<path d="M12 7.2v5.6" class="ck-stroke-warning" stroke-width="2.2" stroke-linecap="round"/>'
    + '<circle cx="12" cy="16.6" r="1.35" class="ck-fill-warning"/>',
  caution: '<path d="M12 3.6L21.4 20H2.6z" class="ck-stroke-caution" stroke-width="2" stroke-linejoin="round" fill="none"/>'
    + '<path d="M12 9.4v4.6" class="ck-stroke-caution" stroke-width="2.2" stroke-linecap="round"/>'
    + '<circle cx="12" cy="17" r="1.3" class="ck-fill-caution"/>',
  waiting: '<circle cx="12" cy="12" r="8.6" class="ck-stroke-waiting" stroke-opacity=".35" stroke-width="2.2" fill="none"/>'
    + '<path d="M12 3.4a8.6 8.6 0 0 1 8.6 8.6" class="ck-stroke-waiting ck-turn" stroke-width="2.2" stroke-linecap="round" fill="none"/>',
  done: '<circle cx="12" cy="12" r="9.2" class="ck-stroke-engaged" stroke-width="2" fill="none"/>'
    + '<path d="M7.8 12.4l2.9 2.9 5.6-6" class="ck-stroke-engaged" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
};

/**
 * @param {SignalKind} kind
 * @param {{ size?: number, pulse?: boolean }} [options]
 */
export function signalShape(kind, { size = 12, pulse = false } = {}) {
  if (kind === 'warning' || kind === 'caution' || kind === 'waiting' || kind === 'done') {
    return `<svg class="ck-signal__shape" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${SEVERITY[kind]}</svg>`;
  }
  const c = size / 2;
  const n = (/** @type {number} */ value) => Number(value.toFixed(2));
  /** @type {Record<'engaged' | 'idle' | 'now' | 'plan', string>} */
  const shapes = {
    engaged: `<circle cx="${c}" cy="${c}" r="${n(size * 0.34)}" class="ck-fill-engaged"/>`,
    idle: `<circle cx="${c}" cy="${c}" r="${n(size * 0.28)}" class="ck-stroke-idle" stroke-width="1.5" fill="none"/>`,
    now: `<circle cx="${c}" cy="${c}" r="${n(size * 0.44)}" class="ck-stroke-now" stroke-width="1.5" fill="none"/>`
      + `<circle cx="${c}" cy="${c}" r="${n(size * 0.22)}" class="ck-fill-now"/>`,
    plan: `<circle cx="${c}" cy="${c}" r="${n(size * 0.38)}" class="ck-stroke-plan" stroke-width="1.5" fill="none" `
      + 'stroke-dasharray="2 2"/>',
  };
  const shape = (/** @type {string} */ shown, className = '') => `<svg class="ck-signal__shape${className}" width="${size}" `
    + `height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">${shown}</svg>`;
  if (!pulse || kind !== 'engaged') return shape(shapes[kind]);
  return `<span class="ck-signal__beat">${shape(shapes[kind])}${shape(shapes[kind], ' ck-pulse')}</span>`;
}

/**
 * @param {SignalKind} kind
 * @param {string} label
 * @param {{ detail?: string, pulse?: boolean, strong?: boolean }} [options]
 */
export function signal(kind, label, { detail = '', pulse = false, strong = false } = {}) {
  return `<span class="ck-signal ck-signal--${kind}">${signalShape(kind, { pulse })}`
    + `<span class="ck-signal__label ${strong ? 'mac-headline' : 'mac-footnote'}">${esc(label)}</span>`
    + (detail ? `<span class="ck-signal__detail mac-footnote">${esc(detail)}</span>` : '')
    + '</span>';
}
