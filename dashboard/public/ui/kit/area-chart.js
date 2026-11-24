// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { dateOf, shiftDay, sizeWords } from '../../lib/words.js';
import { toneClass } from './disk-bar.js';

const W = 624;
const H = 200;
const PAD_R = 44;
const PAD_T = 8;
const PAD_B = 22;
export const COLUMNS = 600;

/** @typedef {{ id: string, name: string, tone: import('./disk-bar.js').Tone, bytes: number[] }} AreaPart */

/** @typedef {{ x: number[], days: string[], parts: { name: string, tone: string, bytes: number[] }[] }} Reading */

/** @param {number} value */
function niceMax(value) {
  if (value <= 0) return 1e9;
  const step = 10 ** Math.floor(Math.log10(value));
  return ([1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(each => each * step >= value) ?? 10) * step;
}

/** @param {number} count */
export function columnsOf(count) {
  if (count <= COLUMNS) return Array.from({ length: count }, (_, at) => at);
  const step = Math.ceil((count - 1) / (COLUMNS - 1));
  const picked = [];
  for (let at = 0; at < count - 1; at += step) picked.push(at);
  return [...picked, count - 1];
}

/**
 * @param {object} chart
 * @param {string} chart.label
 * @param {string} chart.first
 * @param {AreaPart[]} chart.parts
 * @param {number | null} [chart.rate]
 * @param {{ bytes: number, name: string } | null} [chart.room]
 */
export function areaChart({ label, first, parts, rate = null, room = null }) {
  const count = Math.max(1, ...parts.map(part => part.bytes.length));
  const lone = count === 1;
  const columns = lone ? [0, 0] : columnsOf(count);
  const span = lone ? 1 : count - 1;
  const ahead = rate === null || rate <= 0 ? 0 : Math.max(1, Math.round(span * 0.25));
  const stacks = columns.map(day => {
    let top = 0;
    return parts.map(part => (top += part.bytes[day] ?? 0));
  });
  const now = stacks.at(-1)?.at(-1) ?? 0;
  const aheadTop = now + (rate ?? 0) * ahead;
  const ceiling = ahead && room !== null && aheadTop >= room.bytes ? room : null;
  const highest = Math.max(now, ...stacks.map(stack => stack.at(-1) ?? 0), ceiling ? ceiling.bytes : ahead ? aheadTop : 0);
  const yMax = niceMax(highest * 1.06);
  const x = (/** @type {number} */ at) => (W - PAD_R) * (at / (span + ahead));
  const y = (/** @type {number} */ value) => PAD_T + (H - PAD_T - PAD_B) * (1 - value / yMax);
  const xs = columns.map((day, at) => x(lone ? at : day));
  const fixed = (/** @type {number} */ value) => value.toFixed(1);
  const grid = [0, 0.5, 1].map(share => `<line x1="0" x2="${W - PAD_R}" y1="${fixed(y(yMax * share))}" y2="${fixed(y(yMax * share))}"/>`).join('');
  const axis = [0.5, 1].map(share => `<text x="${W - PAD_R + 8}" y="${fixed(y(yMax * share) + 4)}">${esc(sizeWords(yMax * share))}</text>`).join('');
  const areas = parts.map((part, k) => {
    const top = xs.map((at, i) => `${fixed(at)},${fixed(y(stacks[i][k]))}`);
    const bottom = xs.map((at, i) => `${fixed(at)},${fixed(y(k ? stacks[i][k - 1] : 0))}`).reverse();
    return `<path${attributes({ class: `ck-area__part ${toneClass(part.tone)}`, 'data-part': part.id, d: `M${top.join('L')}L${bottom.join('L')}Z` })}/>`;
  }).reverse().join('');
  const today = xs.at(-1) ?? 0;
  const reach = ceiling && rate ? Math.max(0, (ceiling.bytes - now) / rate) : ahead;
  const onward = !ahead ? '' : `<path class="ck-area__ahead" d="M${fixed(today)},${fixed(y(now))}`
    + `L${fixed(x(span + reach))},${fixed(y(now + (rate ?? 0) * reach))}"/>`
    + `<circle class="ck-area__now" cx="${fixed(today)}" cy="${fixed(y(now))}" r="4"/>`
    + (ceiling ? `<line class="ck-area__room" x1="0" x2="${W - PAD_R}" y1="${fixed(y(ceiling.bytes))}" y2="${fixed(y(ceiling.bytes))}"/>`
      + `<text class="ck-area__room-name" x="0" y="${fixed(y(ceiling.bytes) - 6)}">${esc(ceiling.name)}</text>` : '');
  const dates = `<text x="0" y="${H - 4}">${esc(dateOf(first))}</text>`
    + `<text x="${fixed(today)}" y="${H - 4}" text-anchor="${ahead ? 'middle' : 'end'}">Today</text>`;
  /** @type {Reading} */
  const reading = { x: xs.map(each => Math.round(each * 10) / 10), days: columns.map(day => shiftDay(first, day)),
    parts: parts.map(part => ({ name: part.name, tone: part.tone, bytes: columns.map(day => part.bytes[day] ?? 0) })) };
  return `<div${attributes({ class: 'ck-area', 'data-chart': JSON.stringify(reading) })}>`
    + `<svg${attributes({ viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label })}>`
    + `<g class="ck-area__grid">${grid}</g><g class="ck-area__axis">${axis}</g>${areas}${onward}<g class="ck-area__axis">${dates}</g>`
    + `<line class="ck-area__cross" x1="0" x2="0" y1="${PAD_T}" y2="${H - PAD_B}"/></svg>`
    + '<div class="ck-area__tip mac-footnote" aria-hidden="true"></div></div>';
}

/** @param {HTMLElement} root */
export function installAreaCharts(root) {
  /** @param {Element} chart */
  const hide = chart => {
    chart.classList.remove('is-pointing');
  };
  root.addEventListener('pointermove', event => {
    const chart = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest('.ck-area'));
    const svg = chart?.querySelector('svg');
    const tip = /** @type {HTMLElement | null} */ (chart?.querySelector('.ck-area__tip') ?? null);
    const cross = chart?.querySelector('.ck-area__cross');
    if (!chart || !svg || !tip || !cross) return;
    /** @type {Reading} */
    const reading = JSON.parse(chart.dataset.chart ?? '{"x":[],"days":[],"parts":[]}');
    const box = svg.getBoundingClientRect();
    const at = (event.clientX - box.left) * (W / box.width);
    const last = reading.x.length - 1;
    if (last < 0 || at < -4 || at > (reading.x[last] ?? 0) + 4) return hide(chart);
    let near = 0;
    for (let i = 1; i <= last; i++) if (Math.abs(reading.x[i] - at) < Math.abs(reading.x[near] - at)) near = i;
    cross.setAttribute('x1', String(reading.x[near]));
    cross.setAttribute('x2', String(reading.x[near]));
    const held = reading.parts.map(part => ({ ...part, value: part.bytes[near] ?? 0 })).filter(part => part.value > 0)
      .sort((a, b) => b.value - a.value);
    const day = reading.days[near] ?? '';
    tip.innerHTML = `<p class="ck-area__when"><span>${esc(near === last ? 'Today' : dateOf(day, { year: true }))}</span>`
      + `<b>${esc(sizeWords(held.reduce((sum, part) => sum + part.value, 0)))}</b></p>`
      + held.map(part => `<p class="ck-area__held"><i class="ck-dot ${toneClass(/** @type {import('./disk-bar.js').Tone} */ (part.tone))}"></i>`
        + `<span class="ck-area__held-name">${esc(part.name)}</span><span class="ck-area__held-size">${esc(sizeWords(part.value))}</span></p>`).join('');
    const left = (reading.x[near] ?? 0) / W * box.width;
    tip.style.left = `${left > box.width / 2 ? left - tip.offsetWidth - 16 : left + 16}px`;
    chart.classList.add('is-pointing');
  });
  root.addEventListener('pointerout', event => {
    const chart = /** @type {Element} */ (event.target).closest('.ck-area');
    const into = /** @type {Element | null} */ (event.relatedTarget);
    if (chart && !(into && chart.contains(into))) hide(chart);
  });
}
