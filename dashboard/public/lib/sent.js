// @ts-check
/** @import { DetailCounts, DetailKind, OutboundRow } from '../types.js' */
import { fetchItemOutbound, fetchPrivacy } from './api.js';
import { today } from './home-clock.js';
import { count, dateWords } from './words.js';

/**
 * @param {DetailKind[]} types
 * @returns {(type: string, n: number) => string}
 */
export function wordsOf(types) {
  const words = new Map([...types, ...types.flatMap(kind => kind.subtypes)].map(kind => [kind.type, kind]));
  return (type, n) => {
    const kind = words.get(type);
    return kind ? (n === 1 ? kind.one : kind.many) : type;
  };
}

/**
 * @param {DetailCounts} counts
 * @param {DetailKind[]} types
 */
export function hiddenWords(counts, types) {
  const said = wordsOf(types);
  return Object.entries(counts).filter(([, n]) => n > 0).sort(([, a], [, b]) => b - a)
    .map(([type, n]) => `${count(n)} ${said(type, n)} ${type === 'face' ? 'covered' : 'hidden'}`).join(' · ');
}

/**
 * @param {Pick<OutboundRow, 'level' | 'counts'>} row
 * @param {DetailKind[]} types
 */
export const hidWords = (row, types) => hiddenWords(row.counts, types) || (row.level === 'none' ? 'Sent as it was' : 'Nothing to hide');

/**
 * @param {Pick<OutboundRow, 'counts' | 'detector'>} row
 * @returns {string | null}
 */
export function hiderWords(row) {
  if (!Object.values(row.counts).some(n => n > 0)) return null;
  return row.detector === null ? 'What Lifestream knows' : 'The hiding model';
}

/**
 * @param {Pick<OutboundRow, 'receiver' | 'at_ms' | 'level' | 'counts'>} row
 * @param {DetailKind[]} types
 * @param {number} [year]
 */
export function sentFact(row, types, year = Number(today().slice(0, 4))) {
  const how = hidWords(row, types);
  return `Sent to ${row.receiver}, ${dateWords(row.at_ms, { weekday: false, year })} · ${how.charAt(0).toLowerCase()}${how.slice(1)}`;
}

/** @param {number} seq */
export const sentRoute = seq => `settings/privacy/sent:${seq}`;

/** @param {number} seq */
export const sentHref = seq => '#' + new URLSearchParams({ dialog: sentRoute(seq) });

/** @type {Promise<DetailKind[]> | null} */
let kinds = null;

function kindsRead() {
  kinds ??= fetchPrivacy().then(read => read.types, error => {
    kinds = null;
    throw error;
  });
  return kinds;
}

/**
 * @param {{ family: string, item: string }} item
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ words: string, href: string } | null>}
 */
export async function itemSent(item, { signal } = {}) {
  try {
    const [sent, types] = await Promise.all([fetchItemOutbound(item, signal), kindsRead()]);
    const row = sent.rows[0];
    return row ? { words: sentFact(row, types), href: sentHref(row.seq) } : null;
  } catch {
    return null;
  }
}
