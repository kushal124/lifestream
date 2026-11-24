// @ts-check
import { esc } from '../../lib/html.js';

/**
 * @typedef {{ countries: { code: string, name: string, rings: number[][] }[] }} World
 * @typedef {{ name: string, latitude: number, longitude: number, nights: number, country?: string | null, home?: boolean, now?: boolean }} AtlasCity
 */

const A1 = 1.340264;
const A2 = -0.081106;
const A3 = 0.000893;
const A4 = 0.003796;
const M = Math.sqrt(3) / 2;
const SCALE = 160;

/**
 * @param {number} longitude
 * @param {number} latitude
 * @returns {[number, number]}
 */
export function project(longitude, latitude) {
  const l = (longitude * Math.PI) / 180;
  const t = Math.asin(M * Math.sin((latitude * Math.PI) / 180));
  const t2 = t * t;
  const t6 = t2 ** 3;
  const x = (l * Math.cos(t)) / (M * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2)));
  const y = t * (A1 + A2 * t2 + t6 * (A3 + A4 * t2));
  return [x * SCALE, -y * SCALE];
}

/** @type {WeakMap<World, { name: string, d: string }[]>} */
const drawn = new WeakMap();

/** @param {World} world */
function landOf(world) {
  let land = drawn.get(world);
  if (!land) {
    land = world.countries.map(country => ({
      name: country.name,
      d: country.rings.map(ring => {
        /** @type {string[]} */
        const points = [];
        for (let i = 0; i + 1 < ring.length; i += 2) points.push(project(ring[i], ring[i + 1]).map(n => n.toFixed(1)).join(','));
        return `M${points.join('L')}Z`;
      }).join(''),
    }));
    drawn.set(world, land);
  }
  return land;
}

/** @param {number} n */
const f = n => n.toFixed(2);

/**
 * @param {object} view
 * @param {World} view.world
 * @param {AtlasCity[]} view.cities
 * @param {number} view.width
 * @param {number} view.height
 * @param {boolean} [view.route]
 * @param {string} view.label
 */
export function atlasMap({ world, cities, width, height, route = false, label }) {
  const points = cities.map(city => ({ ...city, at: project(city.longitude, city.latitude) }));
  if (!points.length) return '';
  const xs = points.map(point => point.at[0]);
  const ys = points.map(point => point.at[1]);
  const aspect = width / height;
  let w = Math.max(Math.max(...xs) - Math.min(...xs), 30) * 1.5;
  let h = Math.max(Math.max(...ys) - Math.min(...ys), 18) * 1.6;
  if (w / h > aspect) h = w / aspect;
  else w = h * aspect;
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
  const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
  const k = w / width;
  const been = new Set(cities.map(city => city.country).filter(Boolean));
  const land = landOf(world).map(country => `<path class="m-land${been.has(country.name) ? ' is-been' : ''}" d="${country.d}"/>`).join('');
  const lines = route ? `<path class="m-route" d="M${points.map(point => point.at.map(f).join(',')).join('L')}"/>` : '';
  const marks = points.filter((point, at) => points.findIndex(other => other.name === point.name) === at);
  const most = Math.max(...marks.map(point => point.nights || 1));
  const dots = marks.map(point => {
    const [x, y] = point.at;
    if (point.home) {
      return `<circle class="m-home" cx="${f(x)}" cy="${f(y)}" r="${f(5.5 * k)}"/>`
        + `<circle class="m-dot${point.now ? ' is-now' : ''}" cx="${f(x)}" cy="${f(y)}" r="${f(2.6 * k)}"/>`;
    }
    const r = (2.2 + 3.2 * Math.sqrt((point.nights || 1) / most)) * k;
    return `<circle class="m-dot${point.now ? ' is-now' : ''}" cx="${f(x)}" cy="${f(y)}" r="${f(r)}"><title>${esc(point.name)}</title></circle>`;
  }).join('');
  /** @type {number[][]} */
  const boxes = marks.map(point => [point.at[0] - 4 * k, point.at[1] - 4 * k, point.at[0] + 4 * k, point.at[1] + 4 * k]);
  const hits = (/** @type {number[]} */ box) => boxes.some(other => box[0] < other[2] && box[2] > other[0]
    && box[1] < other[3] && box[3] > other[1]);
  const order = [...marks].sort((a, b) => (b.home ? Infinity : b.nights) - (a.home ? Infinity : a.nights));
  const labels = order.map(point => {
    const [x, y] = point.at;
    const tw = point.name.length * 6.4 * k;
    const th = 12 * k;
    for (const [lx, anchor] of /** @type {[number, string][]} */ ([[x + 8 * k, 'start'], [x - 8 * k, 'end']])) {
      const box = anchor === 'start' ? [lx, y - th / 2, lx + tw, y + th / 2] : [lx - tw, y - th / 2, lx, y + th / 2];
      if (hits(box)) continue;
      boxes.push(box);
      return `<text class="m-label${point.home ? ' is-strong' : ''}" text-anchor="${anchor}" x="${f(lx)}" y="${f(y + 4 * k)}" `
        + `font-size="${f(11 * k)}" stroke-width="${f(3 * k)}">${esc(point.name)}</text>`;
    }
    return '';
  }).join('');
  return `<figure class="pp-map pp-map--atlas" aria-label="${esc(label)}">`
    + `<svg viewBox="${f(cx - w / 2)} ${f(cy - h / 2)} ${f(w)} ${f(h)}" preserveAspectRatio="xMidYMid slice" role="img">`
    + `${land}${lines}${dots}${labels}</svg></figure>`;
}

