// @ts-check
import { readFile } from 'node:fs/promises';

const TOLERANCE = 0.25;
const SMALLEST = 1;

/**
 * @param {[number, number][]} points
 * @param {number} tolerance
 * @returns {[number, number][]}
 */
function thin(points, tolerance) {
  if (points.length < 3) return points;
  const [ax, ay] = points[0];
  const [bx, by] = /** @type {[number, number]} */ (points.at(-1));
  const [dx, dy] = [bx - ax, by - ay];
  const length = Math.hypot(dx, dy) || 1e-9;
  let far = 0;
  let at = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i];
    const away = Math.abs(dy * px - dx * py + bx * ay - by * ax) / length;
    if (away > far) [far, at] = [away, i];
  }
  if (far <= tolerance) return [points[0], /** @type {[number, number]} */ (points.at(-1))];
  return [...thin(points.slice(0, at + 1), tolerance).slice(0, -1), ...thin(points.slice(at), tolerance)];
}

/** @param {number[]} flat */
function ring(flat) {
  /** @type {[number, number][]} */
  const points = [];
  for (let i = 0; i + 1 < flat.length; i += 2) points.push([flat[i], flat[i + 1]]);
  if (points.length < 4) return null;
  const lons = points.map(point => point[0]);
  const lats = points.map(point => point[1]);
  if (Math.max(...lons) - Math.min(...lons) < SMALLEST && Math.max(...lats) - Math.min(...lats) < SMALLEST) return null;
  const half = Math.floor(points.length / 2);
  const kept = [...thin(points.slice(0, half + 1), TOLERANCE).slice(0, -1), ...thin(points.slice(half), TOLERANCE)];
  if (kept.length < 4) return null;
  return kept.flatMap(([lon, lat]) => [Math.round(lon * 100) / 100, Math.round(lat * 100) / 100]);
}

/**
 * @param {string} file
 * @returns {() => Promise<{ countries: { code: string, name: string, rings: number[][] }[] }>}
 */
export function atlasReader(file) {
  /** @type {Promise<{ countries: { code: string, name: string, rings: number[][] }[] }> | null} */
  let kept = null;
  return () => {
    kept ??= readFile(file, 'utf8').then(text => {
      const world = /** @type {{ countries: { code: string, name: string, parts: number[][][] }[] }} */ (JSON.parse(text));
      return {
        countries: world.countries.map(country => ({
          code: country.code || country.name,
          name: country.name,
          rings: country.parts.flatMap(part => part.map(ring).filter(each => each !== null)),
        })).filter(country => country.rings.length),
      };
    }).catch(error => {
      kept = null;
      throw error;
    });
    return kept;
  };
}
