// @ts-check
import { DoorRefusal } from '../errors.mjs';


export const BUILDING = 'The record\'s index is building: no catalog yet. `count` with no `of` gives it once the index is whole; until then a tool may answer that it cannot answer yet.';

/**
 * @typedef {{ first: string, last: string } | null} Held
 * @typedef {{ family: string, products: string[], held: Held }} Family
 * @typedef {{ measure: string, unit: string, sums?: true, readings?: string[], held?: Held, stated?: number }} Measure
 * @typedef {{ of: string, keys: string[], measures: Measure[], held: Held, about?: string }} Collection
 * @typedef {{ held: Held, shows: string[] } | { unread: string }} Screen
 */

/**
 * @param {(args: Record<string, unknown>) => Promise<any>} count
 * @returns {Promise<string>}
 */
export async function compactCatalog(count) {
  /** @type {{ families: Family[], collections: Collection[], screen: Screen }} */
  let catalog;
  try {
    catalog = await count({});
  } catch (error) {
    if (error instanceof DoorRefusal && error.code === 'INDEX_BUILDING') return BUILDING;
    throw error;
  }
  return [...catalog.families.map(familyLine), ...catalog.collections.map(collectionLine), screenLine(catalog.screen)].join('\n');
}

/** @param {Held} held */
const span = held => (held === null ? 'none' : `${held.first} → ${held.last}`);

/** @param {Family} family */
function familyLine({ family, products, held }) {
  return `${family}${held === null ? '' : ` ${span(held)}`}: ${products.join(', ') || 'no source'}`;
}

/** @param {Collection} collection */
function collectionLine({ of, keys, measures, held, about }) {
  const named = measures.map(({ measure, unit, sums, readings }) => {
    const also = readings === undefined || readings.length === 0 ? '' : `; or ${readings.join(', ')}`;
    const name = `${measure}${sums ? '+' : ''}`;
    return unit === '' && also === '' ? name : `${name} (${unit}${also})`;
  });
  const stated = measures.flatMap(({ measure, held: on, stated: n }) => on === undefined ? [] : [`${measure} ${span(on)}${n === undefined ? '' : `, ${n} days`}`]);
  return `${of}: ${keys.join(' ')}${named.length === 0 ? '' : ` | ${named.join(' ')}`} | ${[span(held), ...stated].join('; ')}${about === undefined ? '' : ` — ${about}`}`;
}

/** @param {Screen} screen */
function screenLine(screen) {
  if ('unread' in screen) return `screen's text: ${screen.unread}`;
  return `screen's text ${span(screen.held)}${screen.shows.length === 0 ? '' : `: ${screen.shows.join(', ')}`}`;
}
