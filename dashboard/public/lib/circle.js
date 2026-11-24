// @ts-check
/** @import { NamedCircle, PlaceEdit, StayPoint } from '../pages.js' */
import { counted } from './words.js';

export const REACH_MIN_M = 20;
export const REACH_MAX_M = 2000;
export const CIRCLES_MAX = 20;
const BESIDE_MAX_M = 200;
const BESIDE_SPOT_M = 500;
const EARTH_RADIUS_M = 6_371_008.8;
const LATITUDE_M = 110_000;

/** @typedef {{ latitude: number, longitude: number, radius_m: number }} Circle */

/** @typedef {{ latitude: number, longitude: number }} Point */

/**
 * @typedef {object} CircleWorld
 * @property {string} slug
 * @property {{ latitude: number, longitude: number }[]} points
 * @property {{ key: string, latitude: number, longitude: number, stays: number }[]} spots
 * @property {{ key: string, name: string, latitude: number, longitude: number, radius_m: number }[]} others
 */

/**
 * @param {Point} left
 * @param {Point} right
 */
export function distanceMeters(left, right) {
  const radians = (/** @type {number} */ degrees) => degrees * Math.PI / 180;
  const a = Math.sin(radians(right.latitude - left.latitude) / 2) ** 2
    + Math.cos(radians(left.latitude)) * Math.cos(radians(right.latitude))
    * Math.sin(radians(right.longitude - left.longitude) / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * @template {NamedCircle} C
 * @param {Point} point
 * @param {C[]} circles
 * @returns {C | null}
 */
export function winningCircle(point, circles) {
  /** @type {{ circle: C, distance: number } | null} */
  let best = null;
  for (const circle of circles) {
    if (Math.abs(point.latitude - circle.latitude) * LATITUDE_M > circle.radius_m) continue;
    const distance = distanceMeters(point, circle);
    if (distance > circle.radius_m) continue;
    if (best === null || circle.radius_m < best.circle.radius_m || (circle.radius_m === best.circle.radius_m
        && (distance < best.distance || (distance === best.distance && circle.slug < best.circle.slug)))) best = { circle, distance };
  }
  return best === null ? null : best.circle;
}

/**
 * @param {NamedCircle} circle
 * @param {NamedCircle[]} others
 * @param {StayPoint[]} points
 */
export function takesIn(circle, others, points) {
  const circles = [circle, ...others];
  let taken = 0;
  for (const point of points) if (winningCircle(point, circles)?.slug === circle.slug) taken += point.count;
  return taken;
}

/**
 * @param {Pick<PlaceEdit, 'slug' | 'others' | 'points' | 'held'>} edit
 * @param {Circle[]} circles
 */
export function draggedStays(edit, circles) {
  const mine = circles.map(circle => ({ slug: edit.slug, ...circle }));
  const others = edit.others.filter(other => other.slug !== edit.slug);
  return edit.held + takesIn(mine[0], [...others, ...mine.slice(1)], edit.points);
}

/** @param {number} stays */
export const takesInWords = stays => `Takes in ${stays ? counted(stays, 'stay') : 'no stays'}`;

/** @param {number} metresOut */
export const clampReach = metresOut => Math.min(REACH_MAX_M, Math.max(REACH_MIN_M, metresOut));

/** @param {number} at */
const stepAt = at => at < 100 ? 5 : at < 500 ? 10 : 50;

/** @param {number} metresOut */
export function snapReach(metresOut) {
  const held = clampReach(metresOut);
  const step = stepAt(held);
  return clampReach(Math.round(held / step) * step);
}

/**
 * @param {number} at
 * @param {1 | -1} way
 */
export function notch(at, way) {
  if (way > 0) {
    const step = stepAt(at);
    return clampReach(Math.floor(at / step + 1e-9) * step + step);
  }
  const step = stepAt(at - 1e-6);
  return clampReach(Math.ceil(at / step - 1e-9) * step - step);
}

const NB = ' ';

/** @param {number} metresOut */
export function reachWords(metresOut) {
  if (metresOut < 1000) return `${Math.round(metresOut)}${NB}m`;
  return `${(metresOut / 1000).toFixed(2).replace(/\.?0+$/u, '')}${NB}km`;
}

const DEGREE_M = 111_320;
const LATITUDE_MAX = 85;

/** @param {number} longitude */
const wrapLongitude = longitude => ((((longitude + 180) % 360) + 360) % 360) - 180;

/**
 * @param {Circle} circle
 * @returns {Circle}
 */
export const onEarth = circle => ({ ...circle, longitude: wrapLongitude(circle.longitude),
  latitude: Math.max(-LATITUDE_MAX, Math.min(LATITUDE_MAX, circle.latitude)) });

/**
 * @param {Circle} circle
 * @param {number} north
 * @param {number} east
 * @returns {Circle}
 */
export const movedBy = (circle, north, east) => onEarth({
  ...circle,
  latitude: circle.latitude + north / DEGREE_M,
  longitude: circle.longitude + east / (DEGREE_M * Math.max(0.01, Math.cos((circle.latitude * Math.PI) / 180))),
});

/**
 * @param {Circle} from
 * @param {Circle} to
 */
export function movedWords(from, to) {
  const distance = distanceMeters(from, to);
  const north = (to.latitude - from.latitude) * DEGREE_M;
  const east = wrapLongitude(to.longitude - from.longitude) * DEGREE_M * Math.cos((from.latitude * Math.PI) / 180);
  const turn = ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
  const way = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(turn / 45) % 8];
  const far = distance < 1000 ? `${Math.round(distance)}${NB}m` : `${(distance / 1000).toFixed(1)}${NB}km`;
  return `${far} ${way}`;
}

/**
 * @param {{ latitude: number, longitude: number }} point
 * @param {Circle} circle
 */
export const inCircle = (point, circle) => distanceMeters(point, circle) <= circle.radius_m;

/**
 * @param {Circle} circle
 * @param {Circle} other
 */
export const overlapping = (circle, other) =>
  distanceMeters(other, circle) < circle.radius_m + other.radius_m;

/**
 * @param {Circle} a
 * @param {Circle} b
 */
export const sameCircle = (a, b) =>
  a.latitude === b.latitude && a.longitude === b.longitude && a.radius_m === b.radius_m;

/**
 * @param {Circle[]} was
 * @param {Circle[]} now
 */
export function changedAt(was, now) {
  const [longer, shorter] = now.length >= was.length ? [now, was] : [was, now];
  return longer.findIndex((circle, at) => !shorter[at] || !sameCircle(circle, shorter[at]));
}

/**
 * @param {Circle[]} circles
 * @param {number} anchor
 * @param {Point[]} spots
 * @returns {Circle}
 */
export function besideCircle(circles, anchor, spots) {
  const from = circles[anchor];
  const radius_m = Math.min(from.radius_m, BESIDE_MAX_M);
  const free = (/** @type {Point} */ point) => !circles.some(circle => inCircle(point, circle));
  const apart = (/** @type {Point} */ spot) => distanceMeters(spot, from);
  const [spot] = spots.filter(each => apart(each) <= BESIDE_SPOT_M && free(each)).sort((a, b) => apart(a) - apart(b));
  if (spot) return onEarth({ latitude: spot.latitude, longitude: spot.longitude, radius_m });
  const away = from.radius_m + radius_m;
  const beside = Array.from({ length: 8 }, (_, turn) => movedBy({ ...from, radius_m },
    away * Math.sin((turn * Math.PI) / 4), away * Math.cos((turn * Math.PI) / 4)));
  return beside.find(free) ?? beside[0];
}
