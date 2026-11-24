// @ts-check
/**
 * @typedef {{ latitude: number, longitude: number, radius_m: number }} Circle
 * @typedef {{ stays: number, days: number, hours: number, longest_day_hours: number, first_ms: number | null, last_ms: number | null }} Visits
 * @typedef {{ city: string | null, region: string | null, country: string | null }} PlaceArea
 * @typedef {Visits & { slug: string, name: string, latitude: number, longitude: number, radius_m: number, ids: string[], also: Circle[], area?: PlaceArea, home?: boolean, ask_home?: string | null, today_hours?: number, counting?: true }} HomePlace
 * @typedef {Visits & { latitude: number, longitude: number, worth: boolean, area?: PlaceArea, ask_home?: string | null, key?: string, witnessed?: string, last?: string | null, photos?: PlacePhoto[], photos_count?: number }} HomeSpot
 * @typedef {{ key: string, latitude: number, longitude: number, hidden_ms: number, days: number, nearest: { slug: string, name: string, distance_m: number } | null }} HiddenSpot
 * @typedef {{ latitude: number, longitude: number, start_ms: number, end_ms: number, slug: string | null }} Here
 * @typedef {{ places: HomePlace[], spots: HomeSpot[], hidden?: HiddenSpot[], here?: Here | null, day?: string, day_until_ms?: number, counting?: true }} PlacesIndex
 * @typedef {{ name: string, id?: string, slug?: string, distance_m: number | null, why?: { product: string, family: string | null, at_ms: number, tier: number } }} Suggestion
 * @typedef {{ words: string, act: { do: 'set', label: string, connector: string, member: string } }} ProviderNeed
 * @typedef {{ name: string, need: ProviderNeed | null }} Provider
 * @typedef {{ suggestions: Suggestion[], provider?: Provider }} Suggested
 * @typedef {{ name?: string, latitude?: number, longitude?: number, radius_m?: number, also?: Circle[], ids?: string[], home?: boolean | null }} PlaceFields
 * @typedef {{ kind: 'create', name: string, latitude: number, longitude: number, radius_m: number, ids?: string[], home?: boolean }
 *   | { kind: 'edit', slug: string, was: PlaceFields } & PlaceFields
 *   | { kind: 'add-circle', slug: string, latitude: number, longitude: number, radius_m: number }
 *   | { kind: 'remove', slug: string } | { kind: 'hide', latitude: number, longitude: number } | { kind: 'unhide', key: string }} PlaceAction
 * @typedef {{ unit: string, start_ms: number, end_ms: number, day: string, people: string[], centre?: { latitude: number, longitude: number } }} PlaceVisit
 * @typedef {{ image: string, at_ms: number }} PlacePhoto
 * @typedef {{ id: string, name: string, days: number, photo?: { crop: string } | { card: string } }} PlacePerson
 * @typedef {{ slug: string, name: string, latitude: number, longitude: number, radius_m: number, ids: string[], also: Circle[], home?: boolean, area: PlaceArea, days: number, hours: number, first_ms: number | null, last_ms: number | null, visits_count: number, nights: number, here: boolean, part_of: { slug: string, name: string } | null, inside: { slug: string, name: string }[], ask_home: string | null, rhythm: string | null, visits: PlaceVisit[], photos: PlacePhoto[], photos_count: number, people: PlacePerson[], counting?: true }} OnePlace
 * @typedef {{ photos: PlacePhoto[], total: number, next?: string }} PlacePhotos
 */

export const SPOT_RADIUS_M = 80;

/** @param {number} degrees */
export const stated = degrees => Math.round(degrees * 1e6) / 1e6;

/** @param {Circle[]} circles */
const circlesKey = circles => JSON.stringify(circles.map(circle => [stated(circle.latitude), stated(circle.longitude), circle.radius_m]));

/** @typedef {{ slug: string, name: string, latitude: number, longitude: number, radius: number, also: Circle[], home: boolean | null }} Editing */

/**
 * @param {Editing} place
 * @param {Omit<PlaceFields, 'ids'>} next
 * @returns {PlaceAction | null}
 */
export function placeEdit(place, next) {
  /** @type {PlaceFields} */
  const fields = {};
  /** @type {PlaceFields} */
  const was = {};
  if (next.name !== undefined && next.name.trim() !== place.name) {
    fields.name = next.name.trim();
    was.name = place.name;
  }
  const latitude = next.latitude ?? place.latitude;
  const longitude = next.longitude ?? place.longitude;
  if (stated(latitude) !== stated(place.latitude) || stated(longitude) !== stated(place.longitude)) {
    Object.assign(fields, { latitude, longitude });
    Object.assign(was, { latitude: place.latitude, longitude: place.longitude });
  }
  if (next.radius_m !== undefined && next.radius_m !== place.radius) {
    fields.radius_m = next.radius_m;
    was.radius_m = place.radius;
  }
  if (next.also !== undefined && circlesKey(next.also) !== circlesKey(place.also)) {
    fields.also = next.also;
    was.also = place.also;
  }
  if (next.home !== undefined && next.home !== place.home) {
    fields.home = next.home;
    was.home = place.home;
  }
  return Object.keys(fields).length ? { kind: 'edit', slug: place.slug, ...fields, was } : null;
}

/**
 * @param {{ latitude: number, longitude: number, radius: number, also: Circle[] }} place
 * @returns {Circle[]}
 */
export const circlesOf = place => [{ latitude: place.latitude, longitude: place.longitude, radius_m: place.radius },
  ...place.also];

const NB = ' ';
const HOUR_MS = 3_600_000;

/** @param {number} ms */
export function spanWords(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${Math.max(minutes, ms > 0 ? 1 : 0)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 10) return `${Math.round(ms / HOUR_MS).toLocaleString('en-US')}h`;
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** @param {number} m */
export function distanceWords(m) {
  if (m < 1000) return `${Math.round(m)}${NB}m`;
  const km = m / 1000;
  return `${km < 100 ? km.toFixed(1) : Math.round(km).toLocaleString('en-US')}${NB}km`;
}
