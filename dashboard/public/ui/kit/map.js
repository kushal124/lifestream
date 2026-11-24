// @ts-check
/** @import { Camera, Control, Feature, GeoJSONSource, LibreMap, MapEvent, MapLibre, Tile } from '../../maplibre.js' */
/** @import { Circle, CircleWorld } from '../../lib/circle.js' */
import { esc } from '../../lib/html.js';
import { editCircle } from './circle-editor.js';
import { icon } from './icon.js';
import { cutName } from './cut.js';

const VERSION = '5.24.0';
const SCRIPT = `vendor/maplibre-gl-csp-${VERSION}.js`;
const WORKER = `vendor/maplibre-gl-csp-worker-${VERSION}.js`;
const STYLESHEET = `vendor/maplibre-gl-${VERSION}.css`;
const STYLES = 'ui/kit/map-style.json';

const NEAR_PX = 240;
const CLOSEST = 16.5;
const EDGE_PX = 48;
const NAME_ROOM_PX = 24;
const CLEAR_PX = 16;
const SMALL_EDGE_PX = 12;
const STAGE_WIDE_PX = 400;
const STAGE_EDGE_PX = 88;
const NAME_CORNER_IN = 0.3;
const OVER_CLEAR_PX = 4;
const PLATE_SIDE = 40;
const PLATE_CORNER = 12;
const PLATE_ROOM = [-4, 1, -4, 1];
const EDGE_STRIP_PX = 2;
const CLEAR_IMAGE_PX = 4;
const RING_CLEAR_PX = 6;
const FLIGHT_MS = 800;
const SAID = ['framed', 'drawn', 'gathered', 'hot', 'hushed', 'lit', 'circle', 'named', 'camera', 'failed', 'style', 'tiles'];
const LAYER_SOURCES = ['marks', 'life'];
const MARKS = ['life-disc', 'life-cluster', 'life-ring', 'life-focus', 'life-here'];
const FOCUS_RING_R = 4;
const NULL_ISLAND_DEG = 0.02;
const SMALL = 0.75;
const EARTH_M = 40_075_016.686;
const NAME_FROM_PX = 6;
const NAME_EDGE_PX = 8;
const NAME_LEAST_PX = 24;
const NAME_PLATE_PX = 16;
const STILL_RING_PX = 1.5;
const STILL_FILL = 0.22;
const STILL_DOT_PX = 3;
const NAME_CLEAR_PX = 8;

/**
 * @typedef {object} MapMark
 * @property {string} key
 * @property {'place' | 'spot' | 'city'} kind
 * @property {number} latitude
 * @property {number} longitude
 * @property {number} weight
 * @property {string} name
 * @property {number} [reach]
 * @property {{ latitude: number, longitude: number, reach: number }[]} [also]
 * @property {number} [r]
 * @property {string} [spent]
 */

/** @typedef {{ key: string, kind: 'place' | 'spot', circles: Circle[], edit?: { world: CircleWorld, label: string } }} MapFocus */

/**
 * @typedef {object} MapView
 * @property {string} frame
 * @property {{ latitude: number, longitude: number, radius_m?: number }[]} fit
 * @property {number} around
 * @property {MapMark[]} marks
 * @property {{ latitude: number, longitude: number } | null} here
 * @property {{ latitude: number, longitude: number, name?: string }[]} [lit]
 * @property {MapFocus | null} focus
 * @property {number} [insetLeft]
 * @property {number} [pad]
 * @property {boolean} [bare]
 * @property {boolean} [small]
 * @property {boolean} [credited]
 * @property {boolean} [still]
 * @property {string} [theme]
 */

/**
 * @param {string} id
 * @param {string} label
 * @param {string} [className]
 */
export const mapFrame = (id, label, className = '') => `<div class="ck-map${className ? ` ${className}` : ''}" `
  + `data-map="${esc(id)}" role="region" aria-label="${esc(label)}"></div>`;

/** @param {MapMark} mark */
const sized = mark => mark.kind === 'spot' ? 4
  : mark.kind === 'city' ? Math.min(20, 6 + Math.sqrt(mark.weight) * 2.6)
    : mark.weight > 0 ? Math.min(19, 4 + 2 * Math.log1p(mark.weight)) : 3.5;

/** @param {MapView} view */
function openRadius(view) {
  if (view.focus?.kind === 'spot') return FOCUS_RING_R * (view.small ? SMALL : 1);
  const own = view.marks.find(mark => mark.key === view.focus?.key);
  return own ? sized(own) : 0;
}

/** @type {Promise<MapLibre> | null} */
let loading = null;

function maplibre() {
  loading ??= new Promise((done, fail) => {
    const sheet = document.createElement('link');
    sheet.rel = 'stylesheet';
    sheet.href = STYLESHEET;
    document.head.prepend(sheet);
    const script = document.createElement('script');
    script.src = SCRIPT;
    script.addEventListener('load', () => {
      const library = /** @type {MapLibre | undefined} */ (/** @type {any} */ (window).maplibregl);
      if (!library) return fail(new Error('The map could not load.'));
      library.setWorkerUrl(new URL(WORKER, document.baseURI).href);
      done(library);
    });
    script.addEventListener('error', () => {
      loading = null;
      fail(new Error('The map could not load.'));
    });
    document.head.append(script);
  });
  return loading;
}

/** @type {Promise<Record<string, any>> | null} */
let styling = null;

function styles() {
  styling ??= fetch(STYLES).then(response => {
    if (!response.ok) throw new Error('The map could not load.');
    return response.json();
  }).catch(error => {
    styling = null;
    throw error;
  });
  return styling;
}

function pageTheme() {
  const set = document.documentElement.dataset.theme;
  if (set) return set;
  const light = matchMedia('(prefers-color-scheme: light)').matches;
  return `${light ? 'light' : 'dark'}${matchMedia('(prefers-contrast: more)').matches ? '-hc' : ''}`;
}

/** @param {{ view: MapView }} entry */
const themeOf = entry => entry.view.theme ?? pageTheme();

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
/** @param {number} t */
const easeOut = t => 1 - (1 - t) ** 3;

/** @param {LibreMap} map */
const hushable = map => {
  if (map.getLayer('life-name')) {
    const shown = ['case', ['boolean', ['feature-state', 'over'], false], 0, 1];
    map.setPaintProperty('life-name', 'text-opacity', shown);
  }
};

/**
 * @param {LibreMap} map
 * @param {HTMLElement} frame
 */
function plated(map, frame) {
  const style = getComputedStyle(frame);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = PLATE_SIDE;
  const pen = canvas.getContext('2d');
  if (!pen) return;
  pen.beginPath();
  pen.roundRect(1, 1, PLATE_SIDE - 2, PLATE_SIDE - 2, PLATE_CORNER);
  pen.fillStyle = style.getPropertyValue('--map-plate').trim() || style.getPropertyValue('--surface').trim();
  pen.fill();
  pen.lineWidth = 2;
  pen.strokeStyle = style.getPropertyValue('--border').trim();
  pen.stroke();
  const [from, to] = [PLATE_CORNER + 2, PLATE_SIDE - PLATE_CORNER - 2];
  const image = pen.getImageData(0, 0, PLATE_SIDE, PLATE_SIDE);
  if (map.hasImage('life-plate')) map.removeImage('life-plate');
  map.addImage('life-plate', image, { pixelRatio: 2, stretchX: [[from, to]], stretchY: [[from, to]], content: [from, from, to, to] });
  const text = style.getPropertyValue('--text').trim();
  for (const layer of ['life-focus-name', 'life-lit-name']) {
    if (!map.getLayer(layer)) continue;
    map.setLayoutProperty(layer, 'icon-image', 'life-plate');
    map.setLayoutProperty(layer, 'icon-text-fit', 'both');
    map.setLayoutProperty(layer, 'icon-text-fit-padding', PLATE_ROOM);
    map.setLayoutProperty(layer, 'icon-padding', 3);
    map.setLayoutProperty(layer, 'text-size', 12);
    map.setLayoutProperty(layer, 'text-font', ['Noto Sans Bold']);
    map.setPaintProperty(layer, 'text-halo-width', 0);
    map.setPaintProperty(layer, 'text-color', text);
  }
  if (map.getLayer('life-name')) {
    map.setLayoutProperty('life-name', 'text-size', 12);
    map.setLayoutProperty('life-name', 'text-padding', 4);
    map.setLayoutProperty('life-name', 'text-radial-offset', ['/', ['+', ['get', 'r'], 9], 12]);
    map.setLayoutProperty('life-name', 'text-variable-anchor', ['bottom', 'top', 'right', 'left',
      'bottom-right', 'bottom-left', 'top-right', 'top-left']);
    map.setPaintProperty('life-name', 'text-color', text);
    map.setPaintProperty('life-name', 'text-halo-color', style.getPropertyValue('--map-land').trim());
    map.setPaintProperty('life-name', 'text-halo-width', 2);
    map.setPaintProperty('life-name', 'text-halo-blur', 0);
  }
}

/** @type {WeakSet<GeoJSONSource>} */
const inOrder = new WeakSet();

/** @param {GeoJSONSource | undefined} source */
function ordered(source) {
  if (!source || inOrder.has(source)) return;
  inOrder.add(source);
  const load = source.loadTile.bind(source);
  /** @type {WeakMap<Tile, { count: number, done: Promise<void> }>} */
  const asks = new WeakMap();
  source.loadTile = tile => {
    const before = asks.get(tile);
    const count = (before?.count ?? 0) + 1;
    const ask = before ? before.done.then(() => {
      if (asks.get(tile)?.count !== count || tile.aborted || tile.state === 'unloaded') return undefined;
      tile.state = tile.state === 'errored' ? 'loading' : 'reloading';
      return load(tile);
    }) : load(tile);
    asks.set(tile, { count, done: ask.then(() => undefined, () => undefined) });
    return ask;
  };
}

/**
 * @param {{ latitude: number, longitude: number }} at
 * @param {Record<string, unknown>} properties
 */
const feature = (at, properties) => ({ type: 'Feature', properties,
  geometry: { type: 'Point', coordinates: [at.longitude, at.latitude] } });

/**
 * @param {number} metres
 * @param {number} latitude
 */
const reachAtZero = (metres, latitude) => (metres * 512) / (EARTH_M * Math.max(0.01, Math.cos((latitude * Math.PI) / 180)));

/** @param {MapView} view */
function layer(view) {
  const current = view.here ? view.marks.find(mark => Math.abs(mark.latitude - (view.here?.latitude ?? Infinity)) < 0.0001
    && Math.abs(mark.longitude - (view.here?.longitude ?? Infinity)) < 0.0001) : undefined;
  const edited = view.focus?.edit ? view.focus : null;
  const focus = edited ? null : view.focus;
  const radius = (/** @type {MapMark} */ mark) => view.still && mark.r !== undefined ? mark.r : sized(mark);
  const others = view.marks.filter(mark => mark.key !== view.focus?.key || (edited && mark.kind === 'spot'))
    .filter(mark => !view.here || Math.abs(mark.latitude - view.here.latitude) > 0.0001
      || Math.abs(mark.longitude - view.here.longitude) > 0.0001);
  const discs = others.filter(mark => mark.kind !== 'spot').flatMap(mark => [feature(mark, {
    kind: 'disc', key: mark.key, r: radius(mark), label: view.still ? '' : mark.name, weight: mark.weight,
    places: 1, ...(mark.reach ? { reach0: reachAtZero(mark.reach, mark.latitude) } : {}),
  }), ...(mark.also ?? []).map(circle => feature(circle, {
    kind: 'disc', key: mark.key, r: radius(mark), label: '', weight: 0, places: 0,
    ...(circle.reach ? { reach0: reachAtZero(circle.reach, circle.latitude) } : {}),
  }))]);
  const rings = others.filter(mark => mark.kind === 'spot').map(mark => feature(mark, {
    kind: 'ring', key: mark.key, r: radius(mark), focus: false,
  }));
  const own = focus ? view.marks.find(mark => mark.key === focus.key) : undefined;
  const kind = focus?.kind;
  const r = openRadius(view);
  const open = (focus?.circles ?? []).map((circle, at) => feature(circle, {
    kind: kind === 'spot' ? 'ring' : 'disc', key: focus?.key, focus: true, r,
    label: view.small || kind === 'spot' || at > 0 ? '' : own?.name ?? '', reach0: reachAtZero(circle.radius_m, circle.latitude),
  }));
  const collection = (/** @type {object[]} */ features) => ({ type: 'FeatureCollection', features });
  return {
    marks: collection(discs),
    life: collection([...rings, ...open, ...(view.lit ?? []).map(at => feature(at, { kind: 'here', label: at.name ?? '' })),
      ...(view.here ? [feature(view.here, { kind: 'here', key: current?.key ?? 'here',
        label: current && current.key !== focus?.key ? current.name : '' })] : [])]),
  };
}

/**
 * @template {{ latitude: number, longitude: number }} T
 * @param {T[]} points
 * @returns {T[]}
 */
export function fitted(points) {
  const real = points.filter(at => Math.hypot(at.latitude, at.longitude) > NULL_ISLAND_DEG);
  return real.length ? real : points;
}

/**
 * @param {MapView} view
 * @returns {[[number, number], [number, number]]}
 */
function bounds(view) {
  const fit = fitted(view.fit);
  const middle = fit.reduce((sum, at) => sum + at.latitude, 0) / fit.length;
  const perLon = 111320 * Math.max(0.01, Math.cos((middle * Math.PI) / 180));
  const out = fit.map(at => (at.radius_m ?? 0) + view.around);
  return [
    [Math.max(-180, Math.min(...fit.map((at, i) => at.longitude - out[i] / perLon))),
      Math.max(-85, Math.min(...fit.map((at, i) => at.latitude - out[i] / 111320)))],
    [Math.min(180, Math.max(...fit.map((at, i) => at.longitude + out[i] / perLon))),
      Math.min(85, Math.max(...fit.map((at, i) => at.latitude + out[i] / 111320)))],
  ];
}

/** @param {MapView} view */
const fitKey = view => JSON.stringify(view.fit);

/**
 * @typedef {object} Entry
 * @property {string} id
 * @property {HTMLElement} box
 * @property {HTMLElement} frame
 * @property {MapView} view
 * @property {LibreMap | null} map
 * @property {boolean} loaded
 * @property {boolean} starting
 * @property {boolean} near
 * @property {string} fitted
 * @property {string} fitTo
 * @property {boolean} refit
 * @property {Camera | null} camera
 * @property {string} written
 * @property {string} hot
 * @property {string} emphasised
 * @property {string} hovered
 * @property {ReturnType<typeof editCircle> | null} editor
 * @property {string[]} hushed
 * @property {HTMLElement | null} controls
 * @property {HTMLElement | null} names
 * @property {string} named
 * @property {{ x: number, y: number, w: number, h: number }[]} plates
 * @property {string} cleared
 * @property {Map<string, unknown>} base
 * @property {string} claimed
 */

/**
 * @param {HTMLElement} root
 * @param {object} acts
 * @param {(id: string, key: string) => void} acts.open
 * @param {(id: string, key: string, circles: Circle[], live: boolean) => void} [acts.edited]
 * @param {(id: string, key: string, at: number) => void} [acts.lit]
 * @param {(id: string, key: string) => void} [acts.pointed]
 */
export function installMaps(root, { open, edited, lit, pointed }) {
  /** @type {Map<string, Entry>} */
  const live = new Map();
  /** @type {WeakMap<Element, Entry>} */
  const byFrame = new WeakMap();
  const watch = new IntersectionObserver(records => {
    for (const record of records) {
      const entry = byFrame.get(record.target);
      if (!entry || entry.frame !== record.target) continue;
      entry.near = record.isIntersecting;
      if (entry.near) void start(entry);
      else stop(entry);
    }
  }, { rootMargin: `${NEAR_PX}px` });

  /**
   * @param {Entry} entry
   * @param {{ type: string, features: object[] }} marks
   */
  function clearOfHere(entry, marks) {
    const { map, view } = entry;
    if (!map || !view.here) return marks;
    const here = map.project([view.here.longitude, view.here.latitude]);
    return { ...marks, features: marks.features.map(feature => {
      const mark = /** @type {{ geometry: { coordinates: [number, number] } }} */ (feature);
      const at = map.project(mark.geometry.coordinates);
      const dx = at.x - here.x;
      const dy = at.y - here.y;
      const apart = Math.hypot(dx, dy);
      if (apart >= CLEAR_PX || apart === 0) return mark;
      const moved = map.unproject([here.x + (dx / apart) * CLEAR_PX, here.y + (dy / apart) * CLEAR_PX]);
      return { ...mark, geometry: { ...mark.geometry, coordinates: [moved.lng, moved.lat] } };
    }) };
  }

  /** @param {Entry} entry */
  function padding(entry) {
    const { width, height } = entry.box.getBoundingClientRect();
    const { pad } = entry.view;
    const disc = Math.max(0, ...entry.view.marks.map(mark => (mark.r ?? 0) + STILL_RING_PX));
    const edge = pad ?? (entry.view.still ? (width >= STAGE_WIDE_PX ? Math.max(STAGE_EDGE_PX, SMALL_EDGE_PX + disc) : SMALL_EDGE_PX + disc)
      : entry.view.small ? SMALL_EDGE_PX : EDGE_PX);
    const side = (/** @type {number} */ room, inset = 0) => Math.max(8, Math.min(edge + inset, room));
    const across = Math.max(0, width - 48);
    const down = Math.max(0, height - 48);
    const left = side(across * 0.75, Math.max(0, (entry.view.insetLeft ?? 0) - (pad ? 0 : 24)));
    const top = side(down / 2);
    return { left, right: side(across - left, entry.view.small || entry.view.still || pad ? 0 : NAME_ROOM_PX), top, bottom: side(down - top) };
  }

  /**
   * @param {Entry} entry
   * @param {boolean} fly
   */
  function fit(entry, fly) {
    const { map, view } = entry;
    if (!map) return;
    const { width, height } = entry.box.getBoundingClientRect();
    if (!width || !height) {
      entry.refit = true;
      return;
    }
    entry.refit = false;
    entry.fitted = view.frame;
    entry.fitTo = fitKey(view);
    entry.frame.dataset.framed = view.frame;
    if (!view.fit.length) return;
    map.fitBounds(bounds(view), { padding: padding(entry), maxZoom: CLOSEST, linear: false, easing: easeOut,
      duration: fly && !reduced() && !view.still ? FLIGHT_MS : 0, essential: true });
  }

  /** @param {Entry} entry */
  function write(entry) {
    if (!entry.map || !entry.loaded) return false;
    const data = layer(entry.view);
    const text = JSON.stringify(data);
    if (text === entry.written) return false;
    entry.written = text;
    entry.map.getSource('marks')?.setData(clearOfHere(entry, data.marks));
    entry.map.getSource('life')?.setData(data.life);
    claim(entry);
    heat(entry, true);
    hush(entry, entry.hushed, true);
    return true;
  }

  /** @param {Entry} entry */
  function claim(entry) {
    const { map, view } = entry;
    if (!map || !entry.loaded) return;
    const names = [...new Set([...view.marks.map(mark => mark.name), ...(view.lit ?? []).map(at => at.name ?? '')].filter(Boolean))].sort();
    const key = JSON.stringify(names);
    if (key === entry.claimed) return;
    entry.claimed = key;
    for (const [id, own] of entry.base) {
      if (!map.getLayer(id)) continue;
      const text = map.getLayoutProperty(id, 'text-field');
      map.setFilter(id, names.length ? ['all', own ?? true, ['!', ['in', text, ['literal', names]]]] : /** @type {any} */ (own ?? null));
    }
  }

  /** @param {Entry} entry */
  function baseOf(entry) {
    const { map } = entry;
    entry.base = new Map();
    entry.claimed = '';
    if (!map) return;
    for (const layer of map.getStyle().layers) {
      if (layer.type === 'symbol' && layer.source === 'base') entry.base.set(layer.id, layer.filter);
    }
  }

  /**
   * @param {Entry} entry
   * @param {boolean} [again]
   */
  function heat(entry, again = false) {
    const key = entry.hovered || entry.emphasised;
    if (!entry.map || !entry.loaded || (key === entry.hot && !again)) return;
    if (entry.hot) entry.map.setFeatureState({ source: 'marks', id: entry.hot }, { hot: false });
    entry.hot = key;
    if (key) entry.map.setFeatureState({ source: 'marks', id: key }, { hot: true });
    if (key) entry.frame.dataset.hot = key;
    else delete entry.frame.dataset.hot;
  }

  /**
   * @param {Entry} entry
   * @param {string[]} keys
   * @param {boolean} [again]
   */
  function hush(entry, keys, again = false) {
    const { map } = entry;
    if (map && entry.loaded) {
      for (const key of entry.hushed) {
        if (again || !keys.includes(key)) map.setFeatureState({ source: 'marks', id: key }, { over: false });
      }
      for (const key of keys) map.setFeatureState({ source: 'marks', id: key }, { over: true });
    }
    entry.hushed = keys;
    if (keys.length) entry.frame.dataset.hushed = keys.join(',');
    else delete entry.frame.dataset.hushed;
  }

  /** @param {Entry} entry */
  function circle(entry) {
    const focus = entry.view.focus;
    if (!entry.map || !focus?.edit) {
      entry.editor?.stop();
      entry.editor = null;
      delete entry.frame.dataset.circle;
      return;
    }
    entry.editor ??= editCircle(entry.map, { inset: () => entry.view.insetLeft ?? 0, changed: (key, circles, live) => {
      if (!live) told(entry, circles);
      edited?.(entry.id, key, circles, live);
    }, lit: (key, at) => lit?.(entry.id, key, at), overlaps: keys => hush(entry, keys) });
    entry.editor.set({ key: focus.key, label: focus.edit.label, world: focus.edit.world, circles: focus.circles });
    told(entry, focus.circles);
  }

  /**
   * @param {Entry} entry
   * @param {Circle[]} circles
   */
  const told = (entry, circles) => {
    entry.frame.dataset.circle = circles.map(at => `${at.latitude.toFixed(6)},${at.longitude.toFixed(6)},${at.radius_m}`)
      .join(';');
  };

  /** @param {Entry} entry */
  function apply(entry) {
    const written = write(entry);
    const moved = entry.refit || entry.view.frame !== entry.fitted || (Boolean(entry.view.still) && fitKey(entry.view) !== entry.fitTo);
    if (moved) fit(entry, entry.fitted !== '');
    if (written || moved) delete entry.frame.dataset.drawn;
    entry.frame.dataset.lit = String(entry.view.lit?.length ?? 0);
    if (!entry.frame.dataset.drawn) entry.map?.triggerRepaint();
    entry.controls?.classList.toggle('has-here', Boolean(entry.view.here));
    circle(entry);
  }

  /**
   * @param {Entry} entry
   * @param {string} key
   */
  function point(entry, key) {
    if (entry.hovered === key) return;
    entry.hovered = key;
    heat(entry);
    pointed?.(entry.id, key);
  }

  /** @param {Entry} entry */
  function said(entry) {
    if (!entry.map) return;
    /** @type {Map<string, number>} */
    const marks = new Map();
    for (const feature of entry.map.queryRenderedFeatures({ layers: MARKS })) {
      const { key, cluster_id: cluster, places } = feature.properties;
      if (cluster !== undefined) marks.set(`cluster:${cluster}`, Math.max(1, Number(places)));
      else marks.set(String(key), 1);
    }
    entry.frame.dataset.drawn = String([...marks.values()].reduce((sum, count) => sum + count, 0));
    entry.frame.dataset.gathered = String([...marks.keys()].filter(key => key.startsWith('cluster:')).length);
  }

  /** @param {Entry} entry */
  function stilled(entry) {
    const { map } = entry;
    if (!map || !entry.view.still || !map.getLayer('life-disc')) return;
    map.getSource('marks')?.setClusterOptions({ cluster: false });
    const life = getComputedStyle(entry.frame).getPropertyValue('--life').trim();
    map.setPaintProperty('life-disc', 'circle-opacity', STILL_FILL);
    map.setPaintProperty('life-disc', 'circle-stroke-width', STILL_RING_PX);
    map.setPaintProperty('life-disc', 'circle-stroke-color', life);
    if (!map.getLayer('life-disc-dot')) {
      map.addLayer({ id: 'life-disc-dot', type: 'circle', source: 'marks',
        paint: { 'circle-radius': STILL_DOT_PX, 'circle-color': life, 'circle-pitch-alignment': 'map' } }, 'life-cluster');
    }
    if (entry.view.bare) {
      for (const layer of map.getStyle().layers) {
        if (layer.type === 'symbol' && layer.source === 'base') map.setLayoutProperty(layer.id, 'visibility', 'none');
      }
    }
  }

  /** @param {Entry} entry */
  function name(entry) {
    const { map, view } = entry;
    if (!map || !view.still || !entry.loaded) return;
    const { width, height } = entry.box.getBoundingClientRect();
    const centre = map.getCenter();
    const key = JSON.stringify([view.marks.map(mark => [mark.key, mark.name, mark.spent, mark.latitude, mark.longitude, mark.r]),
      width, height, centre.lng, centre.lat, map.getZoom()]);
    if (key === entry.named && entry.names?.isConnected) return;
    entry.named = key;
    if (!entry.names?.isConnected) {
      entry.names = document.createElement('div');
      entry.names.className = 'ck-map__names';
      entry.names.setAttribute('aria-hidden', 'true');
      map.getCanvasContainer().after(entry.names);
    }
    const layer = entry.names;
    layer.textContent = '';
    const alone = new Set(map.queryRenderedFeatures({ layers: ['life-disc'] }).map(feature => String(feature.properties.key)));
    const discs = view.marks.map(mark => ({ mark, at: map.project([mark.longitude, mark.latitude]),
      r: (mark.r ?? sized(mark)) + STILL_RING_PX })).filter(disc => alone.has(disc.mark.key));
    const gathered = map.queryRenderedFeatures({ layers: ['life-cluster'] }).flatMap(feature => {
      if (feature.geometry.type !== 'Point') return [];
      const [longitude, latitude] = /** @type {[number, number]} */ (feature.geometry.coordinates);
      const places = Math.max(1, Number(feature.properties.places));
      return [{ at: map.project([longitude, latitude]), r: Math.min(20, 10 + 2.5 * Math.sqrt(places)) + 1.5 }];
    });
    const obstacles = [...discs, ...gathered];
    /** @param {{ at: { x: number, y: number }, r: number }} other */
    const clear = other => {
      const r = other.r + NAME_CLEAR_PX;
      return { x: other.at.x - r, y: other.at.y - r, w: r * 2, h: r * 2 };
    };
    /** @type {{ x: number, y: number, w: number, h: number }[]} */
    const set = [];
    /** @param {{ x: number, y: number, w: number, h: number }} one @param {{ x: number, y: number, w: number, h: number }} other */
    const meets = (one, other) => one.x < other.x + other.w && other.x < one.x + one.w && one.y < other.y + other.h && other.y < one.y + one.h;
    /** @type {string[]} */
    const named = [];
    for (const disc of [...discs].sort((one, other) => other.r - one.r || other.mark.weight - one.mark.weight)) {
      if (!disc.mark.name) continue;
      const toward = disc.at.x > width / 2;
      /** @type {{ label: HTMLSpanElement, words: string, box: { x: number, y: number, w: number, h: number } }[]} */
      const sides = [];
      const [near, far] = toward ? ['left', 'right'] : ['right', 'left'];
      for (const side of [near, far, 'above', 'under', `under ${near}`, `under ${far}`, `above ${near}`, `above ${far}`]) {
        const [left, right, above, under] = ['left', 'right', 'above', 'under'].map(word => side.includes(word));
        const corner = (above || under) && (left || right);
        const from = corner ? disc.r * (1 - NAME_CORNER_IN) + NAME_FROM_PX / 2 : disc.r + NAME_FROM_PX;
        const room = Math.floor(left ? disc.at.x - from - NAME_EDGE_PX : right ? width - disc.at.x - from - NAME_EDGE_PX
          : width - 2 * NAME_EDGE_PX);
        if (room - NAME_PLATE_PX < NAME_LEAST_PX) continue;
        const label = document.createElement('span');
        label.className = 'ck-map__name mac-footnote';
        layer.append(label);
        const spent = disc.mark.spent ? document.createElement('span') : null;
        if (spent) {
          spent.className = 'ck-map__spent';
          spent.textContent = disc.mark.spent ?? '';
          label.append(spent);
        }
        const kept = spent ? spent.offsetWidth + Number.parseFloat(getComputedStyle(spent).marginLeft) : 0;
        const words = cutName(disc.mark.name, getComputedStyle(label).font, room - NAME_PLATE_PX - kept);
        label.prepend(words);
        const w = label.offsetWidth;
        const h = label.offsetHeight;
        const box = { x: left ? disc.at.x - from - w : right ? disc.at.x + from
          : Math.min(width - NAME_EDGE_PX - w, Math.max(NAME_EDGE_PX, disc.at.x - w / 2)),
        y: above ? disc.at.y - from - h : under ? disc.at.y + from : disc.at.y - h / 2, w, h };
        const covered = set.some(other => meets(box, other)) || obstacles.some(other => other !== disc && meets(box, clear(other)));
        if (!words || covered || box.y < 0 || box.y + h > height) label.remove();
        else sides.push({ label, words, box });
      }
      const [side, ...others] = [...sides].sort((one, two) => two.words.length - one.words.length);
      for (const other of others) other.label.remove();
      if (!side) continue;
      side.label.style.transform = `translate(${Math.round(side.box.x)}px, ${Math.round(side.box.y)}px)`;
      set.push(side.box);
      named.push([side.words, disc.mark.spent].filter(Boolean).join(' '));
    }
    entry.frame.dataset.named = named.join('|');
    entry.plates = set;
  }

  /** @param {Entry} entry */
  function keepClear(entry) {
    const { map, view } = entry;
    if (!map || !entry.loaded) return false;
    const frame = entry.box.getBoundingClientRect();
    const marked = [...root.querySelectorAll(`[data-map-over="${CSS.escape(entry.id)}"]`)];
    const over = [...marked, ...entry.box.querySelectorAll('.maplibregl-ctrl-attrib, .maplibregl-ctrl-scale, .ck-map__tools')]
      .map(element => element.getBoundingClientRect()).filter(box => box.width > 0 && box.height > 0)
      .map(box => ({ x: box.left - frame.left, y: box.top - frame.top, w: box.width, h: box.height }));
    const edges = [{ x: 0, y: 0, w: EDGE_STRIP_PX, h: frame.height }, { x: frame.width - EDGE_STRIP_PX, y: 0, w: EDGE_STRIP_PX, h: frame.height },
      { x: 0, y: 0, w: frame.width, h: EDGE_STRIP_PX }, { x: 0, y: frame.height - EDGE_STRIP_PX, w: frame.width, h: EDGE_STRIP_PX }];
    const boxes = [...entry.plates, ...over, ...edges].map(box => ({ x: Math.round(box.x) - OVER_CLEAR_PX, y: Math.round(box.y) - OVER_CLEAR_PX,
      w: Math.round(box.w) + 2 * OVER_CLEAR_PX, h: Math.round(box.h) + 2 * OVER_CLEAR_PX }))
      .filter(box => box.x < frame.width && box.y < frame.height && box.x + box.w > 0 && box.y + box.h > 0);
    const centre = map.getCenter();
    const rings = (view.focus?.circles ?? []).map(circle => {
      const at = map.project([circle.longitude, circle.latitude]);
      const reach = Math.max(openRadius(view) + 6, reachAtZero(circle.radius_m, circle.latitude) * 2 ** map.getZoom());
      return { x: Math.round(at.x), y: Math.round(at.y), r: Math.round(reach) + RING_CLEAR_PX };
    }).filter(ring => ring.x + ring.r > 0 && ring.y + ring.r > 0 && ring.x - ring.r < frame.width && ring.y - ring.r < frame.height);
    const key = JSON.stringify([boxes, rings, frame.width, frame.height, centre.lng, centre.lat, map.getZoom()]);
    if (key === entry.cleared && map.getSource('clear')) return false;
    entry.cleared = key;
    /** @type {object[]} */
    const squares = [];
    for (const box of boxes) {
      const side = Math.max(8, Math.min(box.w, box.h, 48));
      const across = Math.max(1, Math.ceil(box.w / side));
      const down = Math.max(1, Math.ceil(box.h / side));
      for (let row = 0; row < down; row += 1) {
        for (let column = 0; column < across; column += 1) {
          const x = Math.min(box.x + column * side, box.x + box.w - side) + side / 2;
          const y = Math.min(box.y + row * side, box.y + box.h - side) + side / 2;
          const at = map.unproject([x, y]);
          squares.push(feature({ latitude: at.lat, longitude: at.lng }, { size: side / CLEAR_IMAGE_PX }));
        }
      }
    }
    /** @type {object[]} */
    const ringed = [];
    for (const ring of rings) {
      const side = Math.max(6, Math.min(16, Math.round(ring.r / 6)));
      for (let y = ring.y - ring.r; y < ring.y + ring.r; y += side) {
        for (let x = ring.x - ring.r; x < ring.x + ring.r; x += side) {
          const nearest = Math.hypot(Math.max(x, Math.min(ring.x, x + side)) - ring.x, Math.max(y, Math.min(ring.y, y + side)) - ring.y);
          if (nearest > ring.r) continue;
          const at = map.unproject([x + side / 2, y + side / 2]);
          ringed.push(feature({ latitude: at.lat, longitude: at.lng }, { size: side / CLEAR_IMAGE_PX }));
        }
      }
    }
    const data = { type: 'FeatureCollection', features: squares };
    const ringData = { type: 'FeatureCollection', features: ringed };
    const held = map.getSource('clear');
    if (held) {
      held.setData(data);
      map.getSource('clear-ring')?.setData(ringData);
    } else {
      if (!map.hasImage('clear')) {
        map.addImage('clear', { width: CLEAR_IMAGE_PX, height: CLEAR_IMAGE_PX, data: new Uint8Array(CLEAR_IMAGE_PX * CLEAR_IMAGE_PX * 4) });
      }
      const layout = { 'icon-image': 'clear', 'icon-size': ['get', 'size'], 'icon-allow-overlap': true, 'icon-padding': 0 };
      map.addSource('clear', { type: 'geojson', data });
      ordered(map.getSource('clear'));
      map.addLayer({ id: 'life-clear', type: 'symbol', source: 'clear', layout });
      map.addSource('clear-ring', { type: 'geojson', data: ringData });
      ordered(map.getSource('clear-ring'));
      map.addLayer({ id: 'life-clear-ring', type: 'symbol', source: 'clear-ring', layout }, map.getLayer('life-name') ? 'life-name' : undefined);
    }
    delete entry.frame.dataset.drawn;
    return true;
  }

  /**
   * @param {Entry} entry
   * @returns {Control}
   */
  const corner = entry => ({
    onAdd(map) {
      const element = document.createElement('div');
      element.className = 'maplibregl-ctrl ck-map__tools';
      element.innerHTML = `<button type="button" class="ck-map__tool ck-map__north" aria-label="Point north">`
        + '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2 11 9H5Z"/><path d="M8 14 5 9h6Z" class="ck-map__south"/></svg>'
        + `</button><button type="button" class="ck-map__tool ck-map__here" aria-label="Where you are">${icon('location')}</button>`;
      element.addEventListener('click', event => {
        const tool = /** @type {Element} */ (event.target).closest('button');
        if (tool?.classList.contains('ck-map__north')) map.resetNorth({ duration: reduced() ? 0 : 400 });
        const here = entry.view.here;
        if (tool?.classList.contains('ck-map__here') && here) {
          map.easeTo({ center: [here.longitude, here.latitude], zoom: Math.max(map.getZoom(), 15), easing: easeOut,
            duration: reduced() ? 0 : FLIGHT_MS });
        }
      });
      const turned = () => element.classList.toggle('is-turned', Math.abs(map.getBearing()) > 0.5);
      map.on('rotate', turned);
      turned();
      entry.controls = element;
      return element;
    },
    onRemove() {
      entry.controls = null;
    },
  });

  /** @param {Entry} entry */
  async function start(entry) {
    if (entry.map || entry.starting) return;
    entry.starting = true;
    let library;
    let style;
    try {
      [library, style] = await Promise.all([maplibre(), styles()]);
    } catch (error) {
      entry.frame.dataset.failed = /** @type {Error} */ (error).message;
      return;
    } finally {
      entry.starting = false;
    }
    if (!entry.near || entry.map || !entry.frame.isConnected) return;
    let map;
    try {
      const still = entry.view.still ? { dragPan: false, dragRotate: false, scrollZoom: false, boxZoom: false,
        doubleClickZoom: false, keyboard: false, touchZoomRotate: false } : {};
      map = new library.Map({ container: entry.box, style: style[themeOf(entry)], attributionControl: false, maxPitch: 0,
        pitchWithRotate: false, touchPitch: false, cooperativeGestures: Boolean(entry.view.small && !entry.view.still),
        fadeDuration: reduced() ? 0 : 200, ...still, ...(entry.camera ?? {}) });
    } catch {
      entry.frame.dataset.failed = 'This map needs WebGL, which this browser has turned off.';
      return;
    }
    entry.map = map;
    map.on('style.load', () => {
      for (const id of LAYER_SOURCES) ordered(map.getSource(id));
    });
    delete entry.frame.dataset.failed;
    entry.frame.dataset.style = themeOf(entry);
    if (entry.view.still) map.getCanvas().tabIndex = -1;
    if (!entry.view.credited) {
      map.addControl(new library.AttributionControl({ compact: true }), 'bottom-right');
    }
    if (!entry.view.credited) {
      map.on('load', () => {
        entry.box.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
        const control = entry.box.querySelector('.maplibregl-ctrl-attrib-button');
        control?.setAttribute('aria-label', 'Map data');
        control?.setAttribute('title', 'Map data');
      });
    }
    if (!entry.view.small && !entry.view.still) {
      map.addControl(corner(entry), 'bottom-right');
      map.addControl(new library.ScaleControl({ maxWidth: 90, unit: 'metric' }), 'bottom-right');
    }
    map.on('error', () => undefined);
    map.on('sourcedata', event => {
      const source = /** @type {{ sourceId?: string, sourceDataType?: string, tile?: unknown }} */ (event);
      if (source.sourceId === 'base' && source.sourceDataType === 'content' && source.tile) {
        entry.frame.dataset.tiles = 'ready';
      }
    });
    map.on('load', () => {
      entry.loaded = true;
      baseOf(entry);
      hushable(map);
      plated(map, entry.frame);
      stilled(entry);
      write(entry);
    });
    map.on('resize', () => {
      if (entry.map === map && entry.refit) apply(entry);
    });
    map.on('zoomend', () => {
      if (entry.view.here) map.getSource('marks')?.setData(clearOfHere(entry, layer(entry.view).marks));
    });
    map.on('idle', () => {
      if (entry.view.still) {
        const base = style[themeOf(entry)].layers.filter((/** @type {{ source?: string, id: string, 'source-layer'?: string }} */ layer) =>
          layer.source === 'base' && !['water', 'landcover', 'landuse', 'park'].includes(layer['source-layer'] ?? ''))
          .map((/** @type {{ id: string }} */ layer) => layer.id);
        entry.frame.dataset.tiles = map.queryRenderedFeatures({ layers: base }).length ? 'ready' : 'missing';
      }
      name(entry);
      if (keepClear(entry)) return;
      said(entry);
      if (entry.view.still) {
        const centre = map.getCenter();
        entry.frame.dataset.camera = [centre.lng, centre.lat, map.getZoom(), map.getBearing()].map(value => value.toFixed(6)).join(',');
      }
    });
    map.on('click', event => {
      if (entry.view.focus?.edit) return;
      const hit = marksAt(map, event).find(feature => !feature.properties.focus);
      const cluster = hit?.properties.cluster_id;
      if (cluster !== undefined && hit?.geometry.type === 'Point') {
        if (entry.view.still) return;
        const [longitude, latitude] = /** @type {[number, number]} */ (hit.geometry.coordinates);
        void map.getSource('marks')?.getClusterExpansionZoom(Number(cluster)).then(zoom => map.easeTo({
          center: [longitude, latitude], zoom: zoom + 0.5, easing: easeOut,
          duration: reduced() ? 0 : FLIGHT_MS * 0.75,
        }), () => undefined);
      } else if (hit?.properties.key) open(entry.id, String(hit.properties.key));
    });
    map.on('mousemove', event => {
      const marks = marksAt(map, event);
      const over = marks.find(feature => !feature.properties.focus) ?? marks[0];
      const pressable = over && !over.properties.focus && !entry.view.focus?.edit
        && !(entry.view.still && over.properties.cluster_id !== undefined);
      map.getCanvas().style.cursor = pressable ? 'pointer' : entry.view.still ? 'default' : '';
      point(entry, over?.layer.id === 'life-disc' ? String(over.properties.key) : '');
    });
    map.on('mouseout', () => point(entry, ''));
    if (entry.camera === null || entry.fitted !== entry.view.frame) fit(entry, false);
    entry.camera = null;
    apply(entry);
  }

  /** @param {Entry} entry */
  function stop(entry) {
    const { map } = entry;
    if (!map) return;
    entry.editor?.stop();
    entry.editor = null;
    const centre = map.getCenter();
    entry.camera = { center: [centre.lng, centre.lat], zoom: map.getZoom(), bearing: map.getBearing() };
    entry.map = null;
    entry.loaded = false;
    entry.written = '';
    entry.hot = '';
    entry.hovered = '';
    entry.controls = null;
    entry.names = null;
    entry.named = '';
    entry.plates = [];
    entry.cleared = '';
    entry.refit = false;
    entry.base = new Map();
    entry.claimed = '';
    map.remove();
  }

  const retheme = () => {
    void styles().then(style => {
      for (const entry of live.values()) {
        if (!entry.map) continue;
        const map = entry.map;
        entry.loaded = false;
        entry.written = '';
        entry.hot = '';
        entry.cleared = '';
        delete entry.frame.dataset.drawn;
        map.setStyle(style[themeOf(entry)], { diff: false });
        entry.frame.dataset.style = themeOf(entry);
        map.once('style.load', () => {
          if (entry.map !== map) return;
          entry.loaded = true;
          baseOf(entry);
          hushable(map);
          plated(map, entry.frame);
          stilled(entry);
          write(entry);
        });
      }
    }, () => undefined);
  };
  for (const query of ['(prefers-color-scheme: light)', '(prefers-contrast: more)']) {
    matchMedia(query).addEventListener('change', retheme);
  }
  new MutationObserver(retheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  return {
    /** @param {Record<string, MapView>} views */
    settle(views) {
      /** @type {Set<Entry>} */
      const placed = new Set();
      for (const frame of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('[data-map]'))) {
        const id = String(frame.dataset.map);
        const view = views[id] ?? live.get(id)?.view;
        if (!view) continue;
        let entry = live.get(id);
        if (!entry) {
          const box = document.createElement('div');
          box.className = 'ck-map__box';
          entry = { id, box, frame, view, map: null, loaded: false, starting: false, near: false, fitted: '', fitTo: '', refit: false,
            camera: null, written: '', hot: '', emphasised: '', hovered: '', editor: null, hushed: [], controls: null,
            names: null, named: '', plates: [], cleared: '', base: new Map(), claimed: '' };
          live.set(id, entry);
        }
        if (entry.frame !== frame || !byFrame.has(frame)) {
          watch.unobserve(entry.frame);
          if (entry.frame !== frame) {
            for (const said of SAID) {
              const value = entry.frame.dataset[said];
              if (value !== undefined && frame.dataset[said] === undefined) frame.dataset[said] = value;
            }
          }
          entry.frame = frame;
          byFrame.set(frame, entry);
          if (view.small) watch.observe(frame);
        }
        if (entry.box.parentElement !== frame) frame.append(entry.box);
        entry.view = view;
        placed.add(entry);
        if (entry.map) apply(entry);
        else if (!view.small && !entry.near) {
          entry.near = true;
          void start(entry);
        }
      }
      for (const [id, entry] of live) {
        if (placed.has(entry)) continue;
        watch.unobserve(entry.frame);
        stop(entry);
        live.delete(id);
      }
    },
    /**
     * @param {string} id
     * @param {string} key
     */
    emphasise(id, key) {
      const entry = live.get(id);
      if (!entry || entry.emphasised === key) return;
      entry.emphasised = key;
      heat(entry);
    },
    /**
     * @param {string} id
     * @param {number} at
     * @param {boolean} [grip]
     */
    light(id, at, grip = false) {
      live.get(id)?.editor?.light(at, grip);
    },
  };
}

/**
 * @param {LibreMap} map
 * @param {MapEvent} event
 * @returns {Feature[]}
 */
const marksAt = (map, event) => map.queryRenderedFeatures([[event.point.x - 4, event.point.y - 4],
  [event.point.x + 4, event.point.y + 4]], { layers: MARKS });
