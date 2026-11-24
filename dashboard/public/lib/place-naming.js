// @ts-check
/** @import { PlaceAction, Suggestion } from './places.js' */
/** @import { SpotRow } from '../pages.js' */
/** @import { Circle } from './circle.js' */
import { distanceWords } from './places.js';
import { dayAt } from './home-clock.js';
import { clock, counted, dateWords } from './words.js';

export const SHOWN = 3;
export const TYPED_FROM = 2;
export const TYPED_REST_MS = 250;
export const TYPED_MOST = 100;

/** @typedef {{ key: string, slug: string, name: string, latitude: number, longitude: number, city: string | null, day: string }} Named */

/** @typedef {{ spot: SpotRow, circles: Circle[], named: Named | null, back: PlaceAction }} Taken */

/** @typedef {{ keys: string[], at: number, typed: string, lit: number, named: Named[], started_ms: number, last_ms: number, ended: boolean, refused: { key: string, text: string } | null, home: Map<string, boolean>, pending: number, acts: number, taken: Taken | null, brought: SpotRow | null }} Sitting */

/**
 * @param {string[]} keys
 * @param {number} now
 * @returns {Sitting}
 */
export const startSitting = (keys, now) => ({ keys, at: 0, typed: '', lit: 0, named: [], started_ms: now, last_ms: now,
  ended: false, refused: null, home: new Map(), pending: 0, acts: 0, taken: null, brought: null });

export const HOME_NAME = 'Home';

/** @param {string} typed */
export const askedWords = typed => typed.trim().length >= TYPED_FROM ? typed.trim() : '';

/**
 * @param {Suggestion[]} suggestions
 * @param {string} typed
 */
export const rowsOf = (suggestions, typed) => typed.trim() ? suggestions : suggestions.slice(0, SHOWN);

/** @param {string} typed */
export const litFor = typed => typed === '' ? 0 : -1;

/** @param {{ typed: string, lit: number }} at */
export const canSave = ({ typed, lit }) => Boolean(typed.trim()) || lit !== litFor(typed);

/** @param {string} name */
const plain = name => name.trim().replace(/\s+/gu, ' ').toLocaleLowerCase();

/**
 * @param {string} typed
 * @param {Suggestion[]} listed
 * @returns {Suggestion | null}
 */
export const fieldName = (typed, listed) => listed.find(suggestion => plain(suggestion.name) === plain(typed)) ?? null;

/** @param {Suggestion[]} rows */
export const fromGoogle = rows => rows.some(row => !row.slug && Boolean(row.id?.startsWith('google:')));

/**
 * @param {number} lit
 * @param {number} count
 * @param {1 | -1} by
 */
export function moved(lit, count, by) {
  if (count === 0) return -1;
  if (lit < 0) return by > 0 ? 0 : count - 1;
  return Math.min(count - 1, Math.max(0, lit + by));
}

/**
 * @param {{ key: string, metaKey?: boolean, ctrlKey?: boolean, altKey?: boolean, shiftKey?: boolean }} event
 * @param {{ finish: boolean, typed: string }} at
 * @returns {'type' | 'up' | 'down' | 'take' | 'skip' | 'undo' | 'clear' | 'end' | 'done' | null}
 */
export function keyCommand(event, { finish, typed }) {
  const { key } = event;
  const empty = typed === '';
  if (event.metaKey || event.ctrlKey || event.altKey) {
    return key.toLowerCase() === 'z' && !event.shiftKey && !event.altKey && (finish || empty) ? 'undo' : null;
  }
  if (finish) return key === 'Enter' || key === 'Escape' ? 'done' : null;
  if ([...key].length === 1) return key === ' ' && empty ? null : 'type';
  if (key === 'Backspace' || key === 'Delete') return empty ? null : 'type';
  if (key === 'ArrowUp') return 'up';
  if (key === 'ArrowDown') return 'down';
  if (key === 'Enter') return 'take';
  if (key === 'ArrowRight') return empty ? 'skip' : null;
  if (key === 'Escape') return empty ? 'end' : 'clear';
  return null;
}

/**
 * @param {Suggestion} suggestion
 * @param {number | null} last
 */
export function whyWords(suggestion, last) {
  const far = suggestion.distance_m === null ? '' : distanceWords(suggestion.distance_m);
  if (suggestion.slug) return ['Your place', far].filter(Boolean).join(' · ');
  const { why } = suggestion;
  if (why) {
    const year = Number(dayAt(last ?? why.at_ms).day.slice(0, 4));
    const other = last === null || dayAt(why.at_ms).day !== dayAt(last).day;
    return `${why.product} · ${other ? `${dateWords(why.at_ms, { year })} ` : ''}${clock(why.at_ms)}`;
  }
  if (suggestion.id?.startsWith('google:')) return ['Google', far].filter(Boolean).join(' · ');
  return far ? `${far} away` : '';
}

/** @param {string[]} names */
export const together = names => names.length < 2 ? names.join('')
  : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/** @param {Sitting} sitting */
export function finishWords(sitting) {
  const taken = sitting.last_ms - sitting.started_ms;
  const time = taken < 60_000 ? 'In under a minute' : `In ${counted(Math.round(taken / 60_000), 'minute')}`;
  const cities = [...new Set(sitting.named.flatMap(named => named.city ? [named.city] : []))];
  const named = cities.length > 3 ? [...cities.slice(0, 2), `${cities.length - 2} more`] : cities;
  return { title: `${counted(sitting.named.length, 'place')} named`, line: [time, together(named)].filter(Boolean).join(' · ') };
}
