// @ts-check
/** @import { LibreMap } from '../../maplibre.js' */
/** @import { Circle, CircleWorld } from '../../lib/circle.js' */
import { esc } from '../../lib/html.js';
import {
  REACH_MAX_M, REACH_MIN_M, changedAt, clampReach, movedBy, movedWords, notch, onEarth, overlapping,
  reachWords, sameCircle, snapReach, winningCircle,
} from '../../lib/circle.js';
import { stepper } from './controls.js';

const EARTH_M = 40_075_016.686;
const GIVE_PX = 14;
const HANDLE_MIN_PX = 16;
const EDGE_PX = 7;
const KEEP_PX = 28;
const KEYS_APART_MS = 900;
const TOLD_MS = 1200;
const TIP_PX = 76;
const DOT_PX = 4;
const DRAWN_PAST_M = REACH_MAX_M;
const SVG = 'http://www.w3.org/2000/svg';

/**
 * @typedef {object} CirclePicture
 * @property {{ x: number, y: number, r: number }[]} circles
 * @property {number} [lit]
 * @property {number} [give]
 * @property {string} [tip]
 * @property {{ x: number, y: number, held: boolean }[]} points
 * @property {{ x: number, y: number, held: boolean }[]} spots
 * @property {{ x: number, y: number, r: number, over: boolean }[]} others
 */

/** @param {number} at @param {number} [places] */
const px = (at, places = 2) => String(Math.round(at * 10 ** places) / 10 ** places);

/**
 * @param {string} label
 * @param {number} at
 * @param {number} of
 */
const moveLabel = (label, at, of) => `${of > 1 ? `Circle ${at + 1} of ${label}` : label}: the arrow keys move it, minus and`
  + ' equals change its reach';

/** @param {number} metres */
const reachEnds = metres => ({ less: metres <= REACH_MIN_M, more: metres >= REACH_MAX_M });

export const circleOverlay = () => '<div class="ck-circle">'
  + `<svg class="ck-circle__svg" xmlns="${SVG}">`
  + '<g class="ck-circle__others"></g><g class="ck-circle__points"></g><g class="ck-circle__pools"></g>'
  + '<g class="ck-circle__rings"></g><g class="ck-circle__spots"></g><g class="ck-circle__centres"></g>'
  + '<g class="ck-circle__moves"></g><g class="ck-circle__edges"></g></svg>'
  + '<div class="ck-circle__handles"></div>'
  + '<span class="ck-circle__tip mac-mono-data" aria-hidden="true"></span>'
  + '<p class="ck-circle__said sr-only" aria-live="polite"></p></div>';

/** @param {HTMLElement} box */
function partsOf(box) {
  const one = (/** @type {string} */ name) => /** @type {any} */ (box.querySelector(`.ck-circle__${name}`));
  return {
    box,
    svg: /** @type {SVGSVGElement} */ (one('svg')),
    others: /** @type {SVGGElement} */ (one('others')),
    points: /** @type {SVGGElement} */ (one('points')),
    pools: /** @type {SVGGElement} */ (one('pools')),
    rings: /** @type {SVGGElement} */ (one('rings')),
    spots: /** @type {SVGGElement} */ (one('spots')),
    centres: /** @type {SVGGElement} */ (one('centres')),
    moves: /** @type {SVGGElement} */ (one('moves')),
    edges: /** @type {SVGGElement} */ (one('edges')),
    handles: /** @type {HTMLElement} */ (one('handles')),
    tip: /** @type {HTMLElement} */ (one('tip')),
    said: /** @type {HTMLElement} */ (one('said')),
    /** @type {Ring[]} */
    circles: [],
  };
}

/** @typedef {ReturnType<typeof partsOf>} Parts */

/** @typedef {{ pool: SVGCircleElement, ring: SVGCircleElement, centre: SVGCircleElement, number: SVGTextElement, move: SVGGElement, body: SVGCircleElement, edge: SVGCircleElement, handle: HTMLElement }} Ring */

/**
 * @param {string} tag
 * @param {Record<string, string>} attrs
 * @param {boolean} [html]
 */
const made = (tag, attrs, html = false) => {
  const element = html ? document.createElement(tag) : document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
  return element;
};

/**
 * @param {Parts} parts
 * @param {number} count
 */
function ringsFor(parts, count) {
  while (parts.circles.length > count) {
    for (const element of Object.values(/** @type {Ring} */ (parts.circles.pop()))) element.remove();
  }
  while (parts.circles.length < count) {
    const at = String(parts.circles.length);
    const move = /** @type {SVGGElement} */ (made('g', { class: 'ck-circle__move', tabindex: '0', role: 'application',
      'aria-roledescription': 'circle', 'data-at': at }));
    const body = /** @type {SVGCircleElement} */ (made('circle', { class: 'ck-circle__body', 'data-grip': 'move', 'data-at': at }));
    move.append(body);
    const ring = {
      pool: /** @type {SVGCircleElement} */ (made('circle', { class: 'ck-circle__pool', 'data-at': at })),
      ring: /** @type {SVGCircleElement} */ (made('circle', { class: 'ck-circle__ring', 'data-at': at })),
      centre: /** @type {SVGCircleElement} */ (made('circle', { class: 'ck-circle__centre', r: '3.5', 'data-at': at })),
      number: /** @type {SVGTextElement} */ (made('text', { class: 'ck-circle__number', 'aria-hidden': 'true', 'data-at': at })),
      move, body,
      edge: /** @type {SVGCircleElement} */ (made('circle', { class: 'ck-circle__edge', 'data-grip': 'size', 'data-at': at })),
      handle: /** @type {HTMLElement} */ (made('span', { class: 'ck-circle__handle', tabindex: '0', role: 'slider',
        'data-grip': 'size', 'data-at': at, 'aria-valuemin': String(REACH_MIN_M), 'aria-valuemax': String(REACH_MAX_M) }, true)),
    };
    parts.pools.append(ring.pool);
    parts.rings.append(ring.ring);
    parts.centres.append(ring.centre, ring.number);
    parts.moves.append(move);
    parts.edges.append(ring.edge);
    parts.handles.append(ring.handle);
    parts.circles.push(ring);
  }
  parts.circles.forEach((ring, at) => {
    ring.number.textContent = count > 1 ? String(at + 1) : '';
  });
}

/**
 * @param {Parts} parts
 * @param {string} label
 */
function labelled(parts, label) {
  const of = parts.circles.length;
  parts.circles.forEach((ring, at) => {
    ring.move.setAttribute('aria-label', moveLabel(label, at, of));
    ring.handle.setAttribute('aria-label', of > 1 ? `Reach of circle ${at + 1}` : 'Reach');
  });
}

/**
 * @param {Ring} ring
 * @param {number} x
 * @param {number} y
 * @param {number} r
 * @param {number} give
 */
function placeRing(ring, x, y, r, give) {
  const cx = px(x);
  const cy = px(y);
  for (const circle of [ring.pool, ring.ring, ring.body, ring.edge, ring.centre]) {
    circle.setAttribute('cx', cx);
    circle.setAttribute('cy', cy);
  }
  const radius = px(Math.max(0, r));
  ring.pool.setAttribute('r', radius);
  ring.ring.setAttribute('r', radius);
  ring.edge.setAttribute('r', radius);
  const band = Math.max(3, Math.min(EDGE_PX, r * 0.3));
  ring.edge.setAttribute('stroke-width', px(band * 2));
  ring.body.setAttribute('r', px(Math.max(0, r - band)));
  ring.handle.style.transform = `translate(${px(handleX(x, r, give))}px, ${px(y)}px)`;
  ring.number.setAttribute('x', px(x + 7));
  ring.number.setAttribute('y', px(y - 7));
}

/**
 * @param {number} x
 * @param {number} r
 * @param {number} give
 */
const handleX = (x, r, give) => x + Math.max(r, HANDLE_MIN_PX) + give;

/**
 * @param {Parts} parts
 * @param {number} hx
 * @param {number} y
 * @param {number} width
 */
function placeTip(parts, hx, y, width) {
  const left = hx + 16 + TIP_PX > width;
  parts.tip.classList.toggle('is-left', left);
  parts.tip.style.transform = `translate(${px(left ? hx - 16 : hx + 16)}px, ${px(y)}px)`;
}

/**
 * @param {Parts} parts
 * @param {number} lit
 */
function marked(parts, lit) {
  parts.circles.forEach((ring, at) => {
    for (const element of [ring.pool, ring.ring, ring.number, ring.handle]) {
      if (element.classList.contains('is-lit') !== (at === lit)) element.classList.toggle('is-lit', at === lit);
    }
  });
}

/**
 * @param {Parts} parts
 * @param {Pick<CirclePicture, 'points' | 'spots' | 'others'>} picture
 */
function placeMarks(parts, { points, spots, others }) {
  /** @param {SVGGElement} group @param {number} count @param {string} className @param {number} r */
  const many = (group, count, className, r) => {
    while (group.childElementCount > count) group.lastElementChild?.remove();
    while (group.childElementCount < count) group.append(made('circle', { class: className, ...(r ? { r: String(r) } : {}) }));
    return /** @type {SVGCircleElement[]} */ ([...group.children]);
  };
  const place = (/** @type {SVGCircleElement} */ mark, /** @type {{ x: number, y: number }} */ at) => {
    mark.setAttribute('cx', px(at.x, 1));
    mark.setAttribute('cy', px(at.y, 1));
  };
  many(parts.points, points.length, 'ck-circle__point', 2.5).forEach((mark, at) => place(mark, points[at]));
  many(parts.spots, spots.length, 'ck-circle__spot', 6).forEach((mark, at) => place(mark, spots[at]));
  many(parts.others, others.length, 'ck-circle__other', 0).forEach((mark, at) => {
    place(mark, others[at]);
    mark.setAttribute('r', px(others[at].r, 1));
  });
}

/**
 * @param {Parts} parts
 * @param {Pick<CirclePicture, 'points' | 'spots' | 'others'>} picture
 */
function lightMarks(parts, { points, spots, others }) {
  const light = (/** @type {SVGGElement} */ group, /** @type {boolean[]} */ held, /** @type {string} */ state) => {
    [...group.children].forEach((mark, at) => {
      if (mark.classList.contains(state) !== held[at]) mark.classList.toggle(state, held[at]);
    });
  };
  light(parts.points, points.map(point => point.held), 'is-held');
  light(parts.spots, spots.map(spot => spot.held), 'is-held');
  light(parts.others, others.map(other => other.over), 'is-over');
}

/** @param {{ metres: number, attrs: (way: 1 | -1) => Record<string, string>, at?: number }} reach */
export const reachStepper = ({ metres, attrs, at = 0 }) => stepper({
  label: 'Reach', text: reachWords(metres), attrs: { 'data-ck-reach': String(at) },
  less: { label: 'Smaller', disabled: reachEnds(metres).less, attrs: attrs(-1) },
  more: { label: 'Larger', disabled: reachEnds(metres).more, attrs: attrs(1) },
});

/**
 * @param {ParentNode} root
 * @param {number} at
 * @param {number} metres
 * @param {boolean} [live]
 */
export function showReach(root, at, metres, live = false) {
  const words = reachWords(metres);
  const ends = reachEnds(metres);
  for (const box of root.querySelectorAll(`[data-ck-reach="${at}"]`)) {
    const shown = box.querySelector('output');
    shown?.setAttribute('aria-live', live ? 'off' : 'polite');
    if (shown && shown.textContent !== words) shown.textContent = words;
    const [less, more] = /** @type {NodeListOf<HTMLButtonElement>} */ (box.querySelectorAll('button'));
    if (less) less.disabled = ends.less;
    if (more) more.disabled = ends.more;
  }
}

/**
 * @param {string} words
 * @param {number} [at]
 */
export const circleLine = (words, at = 0) => `<p class="ck-circle-line mac-footnote" data-ck-circle-line="${at}"`
  + ` aria-live="polite">${esc(words)}</p>`;

/**
 * @param {ParentNode} root
 * @param {number} at
 * @param {string} words
 * @param {boolean} live
 */
export function showLine(root, at, words, live) {
  for (const line of root.querySelectorAll(`[data-ck-circle-line="${at}"]`)) {
    line.setAttribute('aria-live', live ? 'off' : 'polite');
    if (live ? line.textContent !== words : true) line.textContent = words;
  }
}

/** @typedef {{ key: string, circles: Circle[], world: CircleWorld, label: string }} CircleEdit */

/** @typedef {{ circles: Circle[], lit: number }} Step */

/** @returns {Pick<CirclePicture, 'points' | 'spots' | 'others'>} */
const none = () => ({ points: [], spots: [], others: [] });

/** @param {Circle[]} a @param {Circle[]} b */
const sameList = (a, b) => a.length === b.length && a.every((circle, at) => sameCircle(circle, b[at]));

/**
 * @param {Circle[]} was
 * @param {Circle[]} now
 */
const litAfter = (was, now) => Math.min(now.length - 1, Math.max(0, changedAt(was, now)));

/**
 * @param {Circle[]} was
 * @param {Circle[]} now
 */
function stepWords(was, now) {
  const at = changedAt(was, now);
  if (now.length === was.length) return reachWords(now[at].radius_m);
  return `Circle ${at + 1} ${now.length > was.length ? 'added' : 'removed'}`;
}

/**
 * @param {Circle[]} list
 * @param {number} at
 * @param {Circle} circle
 */
const replaced = (list, at, circle) => list.map((each, index) => index === at ? circle : each);

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
/** @param {number} t */
const easeOut = t => 1 - (1 - t) ** 3;

/**
 * @param {LibreMap} map
 * @param {object} acts
 * @param {(key: string, circles: Circle[], live: boolean) => void} acts.changed
 * @param {(key: string, at: number) => void} acts.lit
 * @param {() => number} acts.inset
 * @param {(keys: string[]) => void} acts.overlaps
 */
export function editCircle(map, { changed, lit: told, inset, overlaps }) {
  const holder = document.createElement('div');
  holder.innerHTML = circleOverlay();
  const parts = partsOf(/** @type {HTMLElement} */ (holder.firstElementChild));
  map.getCanvasContainer().append(parts.box);
  /** @type {CircleEdit} */
  let edit = { key: '', circles: [], world: { slug: '', points: [], spots: [], others: [] }, label: '' };
  /** @type {Circle[]} */
  let circles = [];
  /** @type {Step[]} */
  let back = [];
  /** @type {Step[]} */
  let again = [];
  let stepLit = 0;
  /** @returns {Step} */
  const asStep = () => ({ circles, lit: stepLit });
  let keyed = { kind: '', at: 0, index: -1 };
  const apart = () => {
    keyed = { kind: '', at: 0, index: -1 };
  };
  /** @type {{ kind: 'move' | 'size', at: number, pointer: number, start: Circle[], from: { x: number, y: number }, centre: { x: number, y: number }, off: number, grip: Element } | null} */
  let press = null;
  let lit = 0;
  let rect = parts.box.getBoundingClientRect();
  /** @type {Pick<CirclePicture, 'points' | 'spots' | 'others'>} */
  let marks = none();
  /** @type {{ points: number[][], spots: number[], others: number[] }} */
  let drawn = { points: [], spots: [], others: [] };
  let over = '';
  let telling = 0;
  let given = 0;

  /** @param {number} latitude */
  const perPixel = latitude => (EARTH_M * Math.cos((latitude * Math.PI) / 180)) / (512 * 2 ** map.getZoom());
  /** @param {{ latitude: number, longitude: number }} at */
  const project = at => {
    const middle = map.getCenter().lng;
    return map.project([at.longitude + 360 * Math.round((middle - at.longitude) / 360), at.latitude]);
  };
  /** @param {Circle} circle */
  const radiusPx = circle => circle.radius_m / perPixel(circle.latitude);

  /** @param {{ x: number, y: number }} point */
  function smallestAt(point) {
    /** @type {number | null} */
    let found = null;
    let smallest = Infinity;
    circles.forEach((circle, at) => {
      const centre = project(circle);
      const r = radiusPx(circle);
      if (Math.hypot(point.x - centre.x, point.y - centre.y) <= r && r <= smallest) {
        found = at;
        smallest = r;
      }
    });
    return found;
  }

  function markAll() {
    const { points, spots, others } = edit.world;
    /**
     * @param {{ latitude: number, longitude: number }} at
     * @param {number} past
     */
    const near = (at, past) => {
      const where = project(at);
      const margin = past / perPixel(at.latitude);
      return where.x >= -margin && where.x <= rect.width + margin && where.y >= -margin && where.y <= rect.height + margin
        ? where : null;
    };
    /** @type {Map<string, { x: number, y: number, stays: number[] }>} */
    const dots = new Map();
    points.forEach((point, index) => {
      const where = near(point, DRAWN_PAST_M);
      if (!where) return;
      const cell = `${Math.round(where.x / DOT_PX)},${Math.round(where.y / DOT_PX)}`;
      const dot = dots.get(cell) ?? { x: where.x, y: where.y, stays: [] };
      dot.stays.push(index);
      dots.set(cell, dot);
    });
    marks = none();
    drawn = { points: [], spots: [], others: [] };
    for (const dot of dots.values()) {
      marks.points.push({ x: dot.x, y: dot.y, held: false });
      drawn.points.push(dot.stays);
    }
    spots.forEach((spot, index) => {
      const where = near(spot, DRAWN_PAST_M);
      if (!where) return;
      marks.spots.push({ x: where.x, y: where.y, held: false });
      drawn.spots.push(index);
    });
    others.forEach((other, index) => {
      const where = near(other, DRAWN_PAST_M + other.radius_m);
      if (!where) return;
      marks.others.push({ x: where.x, y: where.y, r: other.radius_m / perPixel(other.latitude), over: false });
      drawn.others.push(index);
    });
    placeMarks(parts, marks);
  }

  function light() {
    const { slug, points, spots, others } = edit.world;
    const named = [...circles.map(circle => ({ slug, ...circle })),
      ...others.map(other => ({ slug: other.key, latitude: other.latitude, longitude: other.longitude, radius_m: other.radius_m }))];
    const holds = (/** @type {{ latitude: number, longitude: number }} */ point) => winningCircle(point, named)?.slug === slug;
    drawn.points.forEach((stays, at) => {
      marks.points[at].held = stays.some(index => holds(points[index]));
    });
    drawn.spots.forEach((index, at) => {
      marks.spots[at].held = holds(spots[index]);
    });
    drawn.others.forEach((index, at) => {
      marks.others[at].over = circles.some(circle => overlapping(circle, others[index]));
    });
    lightMarks(parts, marks);
    const overlapped = drawn.others.filter((_, at) => marks.others[at].over).map(index => others[index].key);
    const keys = [...new Set(overlapped)].join('\n');
    if (keys !== over) {
      over = keys;
      overlaps(keys ? keys.split('\n') : []);
    }
  }

  /**
   * @param {number} index
   * @param {boolean} [asked]
   */
  function lightOn(index, asked = false) {
    if (index === lit || !circles[index]) return;
    tell(false);
    lit = index;
    marked(parts, lit);
    tipped();
    if (!asked) told(edit.key, lit);
  }

  function tipped() {
    const circle = circles[lit];
    if (!circle) return;
    const at = project(circle);
    placeTip(parts, handleX(at.x, radiusPx(circle), press?.at === lit ? given : 0), at.y, rect.width);
    const words = reachWords(circle.radius_m);
    if (parts.tip.textContent !== words) parts.tip.textContent = words;
  }

  /** @param {number} [give] */
  function draw(give = 0) {
    given = give;
    if (parts.circles.length !== circles.length) {
      const active = document.activeElement;
      const focused = parts.circles.slice(circles.length).some(ring => ring.move === active || ring.handle === active);
      ringsFor(parts, circles.length);
      labelled(parts, edit.label);
      if (lit >= circles.length) lightOn(circles.length - 1);
      marked(parts, lit);
      if (focused) parts.circles[lit]?.move.focus({ preventScroll: true });
    }
    circles.forEach((circle, index) => {
      const ring = parts.circles[index];
      const at = project(circle);
      placeRing(ring, at.x, at.y, radiusPx(circle), press?.at === index ? give : 0);
      const words = reachWords(circle.radius_m);
      ring.handle.setAttribute('aria-valuenow', String(circle.radius_m));
      ring.handle.setAttribute('aria-valuetext', words);
    });
    tipped();
    light();
  }

  /** @param {string} words */
  const say = words => {
    parts.said.textContent = words;
  };

  /** @param {number} index */
  function keep(index) {
    const circle = circles[index];
    if (!circle) return;
    const at = project(circle);
    const r = radiusPx(circle);
    const left = inset() + KEEP_PX;
    if (at.x - r >= left && at.x + r <= rect.width - KEEP_PX && at.y - r >= KEEP_PX && at.y + r <= rect.height - KEEP_PX) return;
    const middle = circle.longitude + 360 * Math.round((map.getCenter().lng - circle.longitude) / 360);
    const north = movedBy(circle, circle.radius_m, 0).latitude;
    const south = movedBy(circle, -circle.radius_m, 0).latitude;
    const wide = circle.radius_m / 111_320 / Math.max(0.01, Math.cos((circle.latitude * Math.PI) / 180));
    map.fitBounds([[middle - wide, south], [middle + wide, north]], {
      padding: { top: KEEP_PX, right: KEEP_PX, bottom: KEEP_PX, left }, maxZoom: map.getZoom(), linear: false,
      easing: easeOut, duration: reduced() ? 0 : 450, essential: true,
    });
  }

  /**
   * @param {Circle[]} was
   * @param {string} words
   * @param {number} [index]
   */
  function stepped(was, words, index = litAfter(was, circles)) {
    lightOn(index);
    stepLit = index;
    draw();
    say(words);
    keep(index);
  }

  /**
   * @param {'move' | 'size'} kind
   * @param {number} index
   * @param {Circle} next
   * @param {string} words
   */
  function key(kind, index, next, words) {
    if (sameCircle(next, circles[index])) return;
    const now = performance.now();
    if (keyed.kind !== kind || keyed.index !== index || now - keyed.at > KEYS_APART_MS) back.push(asStep());
    again = [];
    keyed = { kind, at: now, index };
    const was = circles;
    circles = replaced(circles, index, next);
    stepped(was, words, index);
    changed(edit.key, circles, false);
    if (kind === 'size') tell(true);
  }

  /** @param {boolean} on */
  const tell = on => {
    clearTimeout(telling);
    parts.box.classList.toggle('is-told', on);
    if (on) telling = window.setTimeout(() => parts.box.classList.remove('is-told'), TOLD_MS);
  };

  /**
   * @param {number} index
   * @param {1 | -1} way
   * @param {number} [notches]
   */
  const step = (index, way, notches = 1) => {
    let metres = circles[index].radius_m;
    for (let at = 0; at < notches; at += 1) metres = notch(metres, way);
    key('size', index, { ...circles[index], radius_m: metres }, reachWords(metres));
  };

  /** @param {PointerEvent} event */
  const at = event => ({ x: event.clientX - rect.left, y: event.clientY - rect.top });

  const gripped = (/** @type {Element} */ grip, /** @type {{ x: number, y: number }} */ point) =>
    grip.getAttribute('data-grip') === 'size' ? Number(grip.getAttribute('data-at')) : smallestAt(point) ?? Number(grip.getAttribute('data-at'));

  /** @param {PointerEvent} event */
  function down(event) {
    const grip = /** @type {Element} */ (event.target).closest('[data-grip]');
    if (!grip || event.button !== 0 || press) return;
    event.preventDefault();
    event.stopPropagation();
    const kind = grip.getAttribute('data-grip') === 'size' ? 'size' : 'move';
    apart();
    rect = parts.box.getBoundingClientRect();
    const from = at(event);
    const index = gripped(grip, from);
    const ring = parts.circles[index];
    const circle = circles[index];
    const centre = project(circle);
    const r = radiusPx(circle);
    press = { kind, at: index, pointer: event.pointerId, start: circles, from, centre, grip,
      off: kind === 'size' ? r - Math.hypot(from.x - centre.x, from.y - centre.y) : 0 };
    lightOn(index);
    /** @type {HTMLElement | SVGElement} */ (kind === 'size' ? ring.handle : ring.move).focus({ preventScroll: true });
    try {
      grip.setPointerCapture(event.pointerId);
    } catch {}
    parts.box.classList.remove('is-settling');
    parts.box.classList.add(kind === 'size' ? 'is-sizing' : 'is-moving');
  }

  /** @param {PointerEvent} event */
  function moving(event) {
    if (!press) {
      hover(event);
      return;
    }
    if (event.pointerId !== press.pointer) return;
    const now = at(event);
    const index = press.at;
    const circle = circles[index];
    if (press.kind === 'move') {
      const to = map.unproject([press.centre.x + now.x - press.from.x, press.centre.y + now.y - press.from.y]);
      circles = replaced(circles, index, onEarth({ ...circle, latitude: to.lat, longitude: to.lng }));
      draw();
    } else {
      const centre = project(circle);
      const per = perPixel(circle.latitude);
      const reach = (Math.hypot(now.x - centre.x, now.y - centre.y) + press.off) * per;
      circles = replaced(circles, index, { ...circle, radius_m: snapReach(reach) });
      const past = (reach - clampReach(reach)) / per;
      draw(Math.sign(past) * GIVE_PX * (1 - Math.exp(-Math.abs(past) / (GIVE_PX * 3))));
    }
    changed(edit.key, circles, true);
  }

  /** @param {boolean} kept */
  function end(kept) {
    if (!press) return;
    const { start, kind, grip, pointer, at: index } = press;
    press = null;
    if (grip.hasPointerCapture(pointer)) grip.releasePointerCapture(pointer);
    parts.box.classList.remove('is-sizing', 'is-moving');
    parts.box.classList.toggle('is-settling', given !== 0);
    if (!kept) circles = start;
    else if (!sameList(start, circles)) {
      back.push({ circles: start, lit: stepLit });
      again = [];
    }
    stepped(start, !kept ? 'Put back' : kind === 'move' ? `Moved ${movedWords(start[index], circles[index])}`
      : reachWords(circles[index].radius_m), index);
    changed(edit.key, circles, false);
  }

  /** @param {PointerEvent} event */
  function hover(event) {
    const grip = /** @type {Element} */ (event.target).closest?.('[data-grip]');
    if (!grip) return;
    const now = at(event);
    const index = gripped(grip, now);
    lightOn(index);
    if (!grip.classList.contains('ck-circle__edge')) return;
    const centre = project(circles[index]);
    const turn = ((Math.atan2(now.y - centre.y, now.x - centre.x) * 180) / Math.PI + 180) % 180;
    /** @type {SVGElement} */ (grip).style.cursor = turn < 22.5 || turn >= 157.5 ? 'ew-resize' : turn < 67.5 ? 'nwse-resize'
      : turn < 112.5 ? 'ns-resize' : 'nesw-resize';
  }

  /** @param {FocusEvent} event */
  function focusing(event) {
    const into = event.type === 'focusin' ? /** @type {Element | null} */ (event.target) : null;
    const index = into?.getAttribute('data-at');
    if (index !== null && index !== undefined) lightOn(Number(index));
    for (const ring of parts.circles) ring.ring.classList.toggle('is-focused', ring.move === into && into.matches(':focus-visible'));
  }

  /** @param {KeyboardEvent} event */
  function onKey(event) {
    const target = /** @type {Element} */ (event.target);
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    /** @type {'move' | 'size' | ''} */
    const on = target.classList.contains('ck-circle__move') ? 'move' : target.classList.contains('ck-circle__handle') ? 'size' : '';
    if (!on) return;
    const index = Number(target.getAttribute('data-at'));
    const circle = circles[index];
    if (!circle) return;
    const by = event.shiftKey ? 25 : 5;
    const moves = /** @type {Record<string, [number, number, string]>} */ ({
      ArrowUp: [by, 0, 'north'], ArrowDown: [-by, 0, 'south'], ArrowRight: [0, by, 'east'], ArrowLeft: [0, -by, 'west'] });
    const grow = ['=', '+', ']'].includes(event.key) || (on === 'size' && ['ArrowUp', 'ArrowRight'].includes(event.key));
    const shrink = ['-', '_', '['].includes(event.key) || (on === 'size' && ['ArrowDown', 'ArrowLeft'].includes(event.key));
    if (grow || shrink) step(index, grow ? 1 : -1);
    else if (on === 'size' && (event.key === 'PageUp' || event.key === 'PageDown')) step(index, event.key === 'PageUp' ? 1 : -1, 5);
    else if (on === 'size' && (event.key === 'Home' || event.key === 'End')) {
      const metres = event.key === 'Home' ? REACH_MIN_M : REACH_MAX_M;
      key('size', index, { ...circle, radius_m: metres }, reachWords(metres));
    } else if (on === 'move' && moves[event.key]) {
      const [north, east, way] = moves[event.key];
      key('move', index, movedBy(circle, north, east), `Moved ${by} m ${way}`);
    } else return;
    event.preventDefault();
    event.stopPropagation();
  }

  const shown = () => parts.box.isConnected && !parts.box.closest('[inert]') && parts.box.getClientRects().length > 0;

  /** @param {KeyboardEvent} event */
  function onDocumentKey(event) {
    if (!shown()) return;
    if (press && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      end(false);
      return;
    }
    if (event.key.toLowerCase() !== 'z' || !(event.metaKey || event.ctrlKey) || event.altKey || press) return;
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement || (active instanceof HTMLElement && active.isContentEditable)
      || (active instanceof HTMLInputElement && !['hidden', 'button', 'submit', 'checkbox', 'radio'].includes(active.type))) return;
    const [from, to] = event.shiftKey ? [again, back] : [back, again];
    const next = from.pop();
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    apart();
    to.push(asStep());
    const was = circles;
    circles = next.circles;
    stepped(was, `${event.shiftKey ? 'Redone' : 'Undone'}. ${stepWords(was, circles)}`, next.lit);
    changed(edit.key, circles, false);
  }

  const follow = () => {
    parts.box.classList.remove('is-settling');
    if (!press) rect = parts.box.getBoundingClientRect();
    markAll();
    draw();
  };
  const resized = () => {
    rect = parts.box.getBoundingClientRect();
    follow();
  };

  parts.box.addEventListener('pointerdown', down);
  parts.box.addEventListener('pointermove', moving);
  parts.box.addEventListener('pointerup', event => {
    if (press?.pointer === event.pointerId) end(true);
  });
  parts.box.addEventListener('pointercancel', () => end(false));
  parts.box.addEventListener('pointerenter', () => {
    if (!press) rect = parts.box.getBoundingClientRect();
  });
  parts.box.addEventListener('focusin', focusing);
  parts.box.addEventListener('focusout', focusing);
  parts.box.addEventListener('click', event => event.stopPropagation());
  parts.box.addEventListener('touchstart', event => {
    if (/** @type {Element} */ (event.target).closest('[data-grip]')) event.stopPropagation();
  }, { passive: true });
  parts.box.addEventListener('keydown', onKey);
  parts.box.addEventListener('transitionend', () => parts.box.classList.remove('is-settling'));
  document.addEventListener('keydown', onDocumentKey, true);
  map.on('move', follow);
  map.on('resize', resized);

  return {
    /** @param {CircleEdit} next */
    set(next) {
      const before = circles;
      const fresh = next.key !== edit.key;
      const world = next.world !== edit.world;
      const named = next.label !== edit.label;
      edit = next;
      if (fresh) {
        back = [];
        again = [];
        apart();
        circles = next.circles;
        tell(false);
        lit = 0;
        stepLit = 0;
        marked(parts, lit);
      } else if (!press && !sameList(next.circles, circles)) {
        back.push(asStep());
        again = [];
        apart();
        circles = next.circles;
      }
      if (named) labelled(parts, next.label);
      if (fresh || world) markAll();
      if (fresh || sameList(before, circles)) {
        draw();
        return;
      }
      stepped(before, stepWords(before, circles));
      const index = changedAt(before, circles);
      if (circles.length === before.length && circles[index].radius_m !== before[index].radius_m) tell(true);
    },
    /**
     * @param {number} index
     * @param {boolean} [grip]
     */
    light(index, grip = false) {
      lightOn(index, true);
      if (grip) parts.circles[index]?.move.focus({ preventScroll: true });
    },
    stop() {
      end(false);
      clearTimeout(telling);
      if (over) overlaps([]);
      document.removeEventListener('keydown', onDocumentKey, true);
      map.off('move', follow);
      map.off('resize', resized);
      parts.box.remove();
    },
  };
}
