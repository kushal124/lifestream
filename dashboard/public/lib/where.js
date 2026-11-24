// @ts-check
import { dayDate, shiftDay } from './words.js';

/**
 * @typedef {{ name: string, city_id?: string, country: string | null, days: number, nights: number, guessed_days: number, guessed_nights: number }} AreaCount
 * @typedef {{ period: string, from: string, to: string, places: { slug: string | null, name: string, hours: number, days: number }[], cities: AreaCount[], regions: AreaCount[], countries: AreaCount[], base: { city: string, city_id: string, nights: number } | null, trips: { first: string, last: string, cities: string[], guessed: boolean }[], coverage: { place: number, moving: number, city: number, region: number, country: number, guessed: number, unknown: number, days_unknown: string[], nights_unknown: string[] } }} Summary
 * @typedef {{ camera: string, name: string, make: string | null, model: string | null, photos: number, first_ms: number | null, last_ms: number | null, sample: string | null, phones: string[], word: Said | null, mine: boolean, why: 'owner' | 'count' | 'paired' | 'none', rule: 'count' | 'paired' | 'none' }} Camera
 * @typedef {{ mine: boolean, from?: string, to?: string }} Said
 * @typedef {{ kind: 'camera', camera: string, mine: boolean, from?: string, to?: string } | { kind: 'forget', camera: string }} CameraAction
 * @typedef {Said | 'count'} CameraWord
 */

/**
 * @param {Summary} summary
 * @returns {{ name: string, guessed: boolean } | null}
 */
export function nightOf(summary) {
  for (const level of /** @type {const} */ (['cities', 'regions', 'countries'])) {
    const known = summary[level].find(area => area.nights > 0);
    if (known) return { name: known.name, guessed: false };
  }
  const guessed = summary.cities.find(area => area.guessed_nights > 0);
  return guessed ? { name: guessed.name, guessed: true } : null;
}

/** @param {Camera} camera */
export function whyWords(camera) {
  if (camera.why === 'owner') return 'Your word';
  if (camera.why === 'paired') return 'A paired phone\'s own camera';
  return camera.why === 'count' ? '50 photos or more' : 'Fewer than 50 photos';
}

/** @param {string} day */
export const dayWords = day => dayDate(day, { weekday: false });

/** @param {Camera} camera */
export function wordWords(camera) {
  const word = camera.word;
  if (word === null) return null;
  if (!word.mine && !word.from && !word.to) return 'Never yours';
  const [from, to] = [word.from && dayWords(word.from), word.to && dayWords(word.to)];
  return (word.mine ? 'Yours' : 'Not yours')
    + (from && to ? ` from ${from} to ${to}` : from ? ` since ${from}` : to ? ` until ${to}` : '');
}

/** @param {Camera} camera */
export function yearsOf(camera) {
  if (camera.first_ms === null || camera.last_ms === null) return '';
  const [first, last] = [new Date(camera.first_ms).getUTCFullYear(), new Date(camera.last_ms).getUTCFullYear()];
  return first === last ? String(first) : `${first}–${last}`;
}

/**
 * @param {string} camera
 * @param {CameraWord} word
 * @returns {CameraAction}
 */
export function cameraAction(camera, word) {
  if (word === 'count') return { kind: 'forget', camera };
  return { kind: 'camera', camera, ...word };
}

/**
 * @param {Camera} camera
 * @param {string | null} stopped
 * @returns {Said}
 */
export function notMine(camera, stopped) {
  if (stopped === null) return { mine: false };
  if (camera.rule !== 'none') return { mine: false, from: stopped };
  const to = shiftDay(stopped, -1);
  const from = camera.word?.mine ? camera.word.from : undefined;
  return from && to < from ? { mine: false } : { mine: true, ...(from ? { from } : {}), to };
}
