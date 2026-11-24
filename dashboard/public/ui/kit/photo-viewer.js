// @ts-check
/** @import { MapView } from './map.js' */
/** @import { Made } from '../../types.js' */
import { attributes, esc } from '../../lib/html.js';
import { fetchPhoto, lifeMediaUrl } from '../../lib/api.js';
import { itemSent } from '../../lib/sent.js';
import { readHost } from '../../lib/host.js';
import { routeHash } from '../../lib/hash.js';
import { afterRecovery, requestState } from '../../lib/reach.js';
import { productName } from '../../lib/kinds.js';
import { dayAt, today } from '../../lib/home-clock.js';
import { calendarDate, clock, count as grouped, longDay } from '../../lib/words.js';
import { iconButton, spinner } from './button.js';
import { icon } from './icon.js';
import { installMaps, mapFrame } from './map.js';
import { personFace, watchPictures } from './person-face.js';
import { pictureFrame } from './picture.js';
import { inPlaceLine, pageLack } from './states.js';
import { installFilterMenus } from './filter-menu.js';
import { DESCRIBE, made, madeActs } from './made.js';
import { liveStage, videoStage } from './video.js';

/** @typedef {{ city: string | null, region: string | null, country: string | null }} Area */

/** @param {unknown} error */
const lackOf = error => {
  const state = requestState(error);
  if (state.state === 'reach') return 'This photo’s details aren’t on this Mac yet.';
  return state.state === 'failed' ? 'This photo’s details couldn’t be read.' : state.words;
};
/**
 * @typedef {object} PhotoFacts
 * @property {string} hash
 * @property {'photograph' | 'screenshot' | 'image' | 'video'} kind
 * @property {number | null} at_ms
 * @property {string | null} unit
 * @property {string | null} caption
 * @property {Made | null} [described]
 * @property {{ id: string, name: string, me: boolean, box: number[] | null, photo: { crop: string } | { card: string } | null }[]} people
 * @property {{ width: number, height: number } | null} size
 * @property {{ slug: string, name: string, latitude: number, longitude: number, radius_m: number, area: Area } | null} place
 * @property {Area | null} area
 * @property {{ id: string, name: string, mine: boolean } | null} camera
 * @property {string | null} from
 * @property {{ network: string, chat: string, title: string, group: boolean, sender: { id: string, name: string } | null, mine: boolean, at_ms: number, day: string, record: { source: string, kind: string, key: string } } | null} chat
 * @property {{ hash: string, media_type: string, live: boolean } | null} play
 */
/** @typedef {{ state: 'reading' } | { state: 'failed', words: string } | { state: 'read', photo: PhotoFacts | null }} Known */
/** @typedef {{ count: number, hash: (index: number) => string | Promise<string> }} Photos */
/**
 * @typedef {object} ViewerState
 * @property {number} index
 * @property {number} count
 * @property {string | null} hash
 * @property {boolean} unshown
 * @property {Known} known
 * @property {boolean} info
 * @property {{ acts: boolean, busy: boolean, refused: string }} [describe]
 * @property {{ words: string, href: string } | null} [sent]
 * @property {'cannot' | 'reach' | null} [failed]
 */

const PLAYER_KEYS = new Set([' ', 'ArrowLeft', 'ArrowRight', 'Home', 'End']);

/** @param {Element} element */
const release = element => {
  for (const film of element.querySelectorAll('video')) {
    film.pause();
    film.removeAttribute('src');
    film.load();
  }
};

const REST_MS = 2_000;
const INFO_KEY = 'viewer.info';
const FROM = /** @type {Record<string, string>} */ ({ phone: 'From your iPhone', mac: 'From your Mac’s Photos', camera: 'Taken in Lifestream' });

/** @param {string} route */
const fromWords = route => FROM[route] ?? `From ${productName(route)}`;
const KINDS = { photograph: 'Photo', screenshot: 'Screenshot', image: 'Image', video: 'Video' };

/**
 * @param {string} view
 * @param {string} on
 * @param {string} focus
 */
const linkTo = (view, on, focus) => routeHash({ view, on, focus, seg: '', q: '', chat: '', dialog: '', flow: '', tour: '' });
/** @param {NonNullable<PhotoFacts['chat']>} chat */
const recordOf = chat => `rec:${chat.record.source} ${chat.record.kind} ${chat.record.key}`;
/** @param {PhotoFacts} photo */
const momentOf = photo => photo.at_ms === null ? null
  : linkTo('days', dayAt(photo.at_ms).day, photo.unit ? `u:${photo.unit}` : photo.chat ? recordOf(photo.chat) : '');
/** @param {PhotoFacts['people'][number]} person */
const faceOf = person => !person.photo ? '' : 'crop' in person.photo ? person.photo.crop : person.photo.card;
/** @param {PhotoFacts['people'][number]} person */
const nameOf = person => person.me ? 'You' : person.name;
/** @param {Area | null} area */
const areaWords = area => [...new Set([area?.city, area?.region].filter(Boolean))].join(', ') || area?.country || '';

/**
 * @param {PhotoFacts | null} photo
 * @returns {{ title: { text: string, href: string | null }, date: { text: string, href: string | null } | null }}
 */
export function barWords(photo) {
  const moment = photo ? momentWords(photo) : null;
  const date = moment ? { text: `${moment.day} · ${moment.clock}`, href: photo ? momentOf(photo) : null } : null;
  if (photo?.place) return { title: { text: photo.place.name, href: linkTo('places', '', photo.place.slug) }, date };
  const area = photo?.area?.city ?? photo?.area?.region ?? photo?.area?.country;
  if (area) return { title: { text: area, href: null }, date };
  return { title: date ?? { text: 'Photo', href: null }, date: null };
}

/** @param {PhotoFacts} photo */
function momentWords(photo) {
  if (photo.at_ms === null) return null;
  const date = calendarDate(photo.at_ms);
  return { day: longDay(date, today().slice(0, 4)), long: `${longDay(date)} ${date.slice(0, 4)}`,
    clock: clock(photo.at_ms) };
}

/**
 * @param {string} part
 * @param {{ text: string, href: string | null }} words
 * @param {string} type
 * @param {string} id
 * @param {boolean} [hidden]
 */
const linkOr = (part, words, type, id, hidden = false) => words.href
  ? `<a${attributes({ class: `ck-viewer__${part} ${type}`, id, href: words.href, 'data-ck-viewer': part, hidden })}>${esc(words.text)}</a>`
  : `<span${attributes({ class: `ck-viewer__${part} ${type}`, id, hidden })}>${esc(words.text)}</span>`;

/**
 * @param {string} name
 * @param {string} meaning
 * @param {string} first
 * @param {string} second
 * @param {string | null} href
 */
const row = (name, meaning, first, second, href) => `<${href ? 'a' : 'div'}${attributes({ class: 'ck-viewer__row', 'data-row': name,
  href, 'data-ck-viewer': href ? `row-${name}` : null })}>${icon(meaning, { className: 'ck-viewer__row-icon' })}<span class="ck-viewer__lines">`
  + `<span class="ck-viewer__line mac-body">${esc(first)}</span>`
  + (second ? `<span class="ck-viewer__line mac-subhead">${esc(second)}</span>` : '') + `</span></${href ? 'a' : 'div'}>`;

/** @param {NonNullable<PhotoFacts['chat']>} chat */
function chatRow(chat) {
  const network = productName(chat.network);
  const first = chat.mine ? 'You sent it' : chat.sender ? `Sent by ${chat.sender.name}` : chat.title;
  const second = (chat.mine || chat.sender) && chat.group ? `${chat.title} · ${network}` : network;
  return row('chat', 'message', first, second, linkTo('days', chat.day, recordOf(chat)));
}

/**
 * @param {Known} known
 * @param {string} map
 * @param {NonNullable<ViewerState['describe']>} describe
 * @param {ViewerState['sent']} sent
 */
function infoParts(known, map, describe, sent) {
  if (known.state === 'failed') return pageLack(known.words);
  if (known.state === 'reading' || !known.photo) return '';
  const photo = known.photo;
  /** @type {string[]} */
  const parts = [];
  const describing = made({ made: photo.described, verbs: DESCRIBE, acts: describe.acts, busy: describe.busy,
    id: photo.hash, attrs: { 'data-ck-viewer': 'describe' } }) + (describe.refused ? inPlaceLine(describe.refused) : '');
  if (photo.caption || describing) {
    parts.push('<div class="ck-viewer__described" data-part="caption">'
      + (photo.caption ? `<p class="ck-viewer__caption mac-body">${esc(photo.caption)}</p>` : '') + describing + '</div>');
  }
  if (photo.people.length) {
    parts.push('<div class="ck-viewer__people" data-part="people">' + photo.people.map((person, at) => `<a${attributes({
      class: 'ck-viewer__person', href: linkTo('people', '', person.id), 'data-ck-viewer': `person-${at}` })}>`
      + personFace({ name: person.name, photo: faceOf(person), size: 'sm' })
      + `<span class="ck-viewer__person-name mac-body">${esc(nameOf(person))}</span>`
      + icon('forward', { className: 'ck-viewer__caret' }) + '</a>').join('') + '</div>');
  }
  if (photo.place) {
    const area = areaWords(photo.place.area);
    parts.push(`<a${attributes({ class: 'ck-viewer__place', href: linkTo('places', '', photo.place.slug), 'data-ck-viewer': 'place',
      'data-part': 'place' })}>${mapFrame(map, `${photo.place.name} on the map`, 'ck-viewer__map')}`
      + `<span class="ck-viewer__place-words"><span class="ck-viewer__place-name mac-body">${esc(photo.place.name)}</span>`
      + (area ? `<span class="ck-viewer__place-area mac-subhead">${esc(area)}</span>` : '') + '</span></a>');
  }
  const moment = momentWords(photo);
  const chat = photo.chat;
  const kept = !chat || photo.from !== null;
  const camera = kept ? photo.camera?.name ?? KINDS[photo.kind] : null;
  const route = kept && photo.from ? fromWords(photo.from) : '';
  const rows = [
    moment ? row('date', 'calendar-event', moment.long, moment.clock, momentOf(photo)) : '',
    camera || route ? row('camera', 'photo', camera ?? route, camera ? route : '', null) : '',
    chat ? chatRow(chat) : '',
    sent ? row('sent', 'send', sent.words, sent.href ? 'See what was sent' : '', sent.href) : '',
  ].filter(Boolean);
  if (rows.length) parts.push(`<div class="ck-viewer__rows" data-part="rows">${rows.join('')}</div>`);
  return parts.join('<hr class="ck-viewer__rule">');
}

/**
 * @param {ViewerState} state
 * @param {{ id: string, map: string }} names
 */
function viewerParts(state, { id, map }) {
  const photo = state.known.state === 'read' ? state.known.photo : null;
  const words = state.known.state === 'read' ? barWords(photo) : null;
  const several = state.count > 1;
  const alt = photo?.caption ?? words?.title.text ?? 'Photo';
  const unshown = state.unshown && !photo?.play;
  return `<div class="ck-viewer__bar" data-window-drag>`
    + `<span class="ck-viewer__count mac-mono-data">${several ? `${grouped(state.index + 1)} of ${grouped(state.count)}` : ''}</span>`
    + `<div${attributes({ class: 'ck-viewer__head', hidden: state.info && Boolean(words) })}>`
    + (words ? linkOr('title', words.title, 'mac-headline', `${id}-title`)
      + (words.date ? linkOr('date', words.date, 'mac-subhead', `${id}-date`) : '') : '') + '</div>'
    + '<div class="ck-viewer__tools">'
    + iconButton('info', 'Info', { pressed: state.info, className: 'ck-viewer__tool', attrs: { 'data-ck-viewer': 'info' } })
    + iconButton('close', 'Close', { className: 'ck-viewer__tool', attrs: { 'data-ck-viewer': 'close' } }) + '</div></div>'
    + '<div class="ck-viewer__body"><div class="ck-viewer__stage">'
    + (unshown ? '' : state.hash ? stageOf(state.hash, photo?.play ?? null, state.failed ?? null, alt) : spinner())
    + `<p${attributes({ class: 'ck-viewer__failed mac-subhead', hidden: !unshown })}>This picture cannot be shown here.</p>`
    + '<svg class="ck-viewer__face" aria-hidden="true"></svg>'
    + (several ? iconButton('back', 'Previous photo', { variant: 'glass', className: 'ck-viewer__nav ck-viewer__nav--prev',
      disabled: state.index === 0, attrs: { 'data-ck-viewer': 'prev' } })
      + iconButton('forward', 'Next photo', { variant: 'glass', className: 'ck-viewer__nav ck-viewer__nav--next',
        disabled: state.index === state.count - 1, attrs: { 'data-ck-viewer': 'next' } }) : '')
    + '</div>'
    + (state.info ? `<aside class="ck-viewer__info ck-panel is-open" aria-label="Info">${infoParts(state.known, map,
      state.describe ?? { acts: false, busy: false, refused: '' }, state.sent ?? null)}</aside>` : '')
    + '</div><div class="ck-viewer__chips">'
    + (!state.info && photo ? photo.people.map((person, at) => `<a${attributes({ class: 'ck-viewer__chip mac-body',
      href: linkTo('people', '', person.id), 'data-ck-viewer': `chip-${at}`, 'data-chip': at })}>`
      + personFace({ name: person.name, photo: faceOf(person), size: 'sm' })
      + `<span class="ck-viewer__chip-name">${esc(nameOf(person))}</span></a>`).join('') : '')
    + '</div><span class="ck-viewer__edge" tabindex="0"></span>';
}

/**
 * @param {string} hash
 * @param {PhotoFacts['play']} play
 * @param {ViewerState['failed']} failed
 * @param {string} alt
 */
const stageOf = (hash, play, failed, alt) => !play ? pictureFrame({ hash, size: 'screen', alt })
  : play.live ? liveStage({ hash, motion: play.hash, alt, failed }) : videoStage({ hash, alt, state: failed ?? 'play' });

/** @param {ViewerState} state */
const stageKey = state => {
  const play = state.known.state === 'read' ? state.known.photo?.play : null;
  return play && state.hash ? `${state.hash} ${play.live ? `live ${play.hash}` : 'video'} ${state.failed ?? 'play'}` : '';
};

function darkTheme() {
  const set = document.documentElement.dataset.theme;
  return set ? (set.endsWith('-hc') ? 'dark-hc' : 'dark') : matchMedia('(prefers-contrast: more)').matches ? 'dark-hc' : 'dark';
}

/**
 * @param {ViewerState} state
 * @param {string} id
 * @param {string} theme
 */
const rootAttributes = (state, id, theme) => ({ role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': `${id}-title ${id}-date`,
  'data-theme': theme, 'data-facts': state.known.state });

/**
 * @param {NonNullable<PhotoFacts['place']>} place
 * @param {string} theme
 * @returns {MapView}
 */
export const placeMap = (place, theme) => ({ frame: `place:${place.slug}`,
  fit: [{ latitude: place.latitude, longitude: place.longitude, radius_m: place.radius_m }], around: 0,
  marks: [{ key: place.slug, kind: 'place', latitude: place.latitude, longitude: place.longitude, weight: 0, name: '',
    reach: place.radius_m }],
  here: null, focus: { key: place.slug, kind: 'place', circles: [{ latitude: place.latitude, longitude: place.longitude,
    radius_m: place.radius_m }] }, small: true, still: true, theme });

/**
 * @param {HTMLElement} root
 * @param {PhotoFacts | null} photo
 * @param {number} at
 */
export function outlineFace(root, photo, at) {
  const face = /** @type {SVGSVGElement | null} */ (root.querySelector('.ck-viewer__face'));
  const stage = root.querySelector('.ck-viewer__stage');
  const image = /** @type {HTMLImageElement | null} */ (root.querySelector('.ck-viewer__stage img'));
  const box = photo?.people[at]?.box;
  if (!face) return;
  if (!stage || !image || !box || !photo?.size || !image.complete || !image.naturalWidth) {
    face.classList.remove('is-on');
    return;
  }
  const room = stage.getBoundingClientRect();
  const drawn = image.getBoundingClientRect();
  const { width, height } = drawn;
  face.style.left = `${drawn.left - room.left}px`;
  face.style.top = `${drawn.top - room.top}px`;
  face.style.width = `${width}px`;
  face.style.height = `${height}px`;
  face.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const across = width / photo.size.width;
  const down = height / photo.size.height;
  const [x1, y1, x2, y2] = [box[0] * across, box[1] * down, box[2] * across, box[3] * down];
  const corner = Math.max(6, 0.12 * Math.min(x2 - x1, y2 - y1));
  const rect = (/** @type {string} */ part, /** @type {number[]} */ [x, y, w, h], more = '') => `<rect class="ck-viewer__${part}" x="${x}"`
    + ` y="${y}" width="${Math.max(0, w)}" height="${Math.max(0, h)}"${more}/>`;
  face.innerHTML = rect('scrim', [0, 0, width, y1]) + rect('scrim', [0, y2, width, height - y2])
    + rect('scrim', [0, y1, x1, y2 - y1]) + rect('scrim', [x2, y1, width - x2, y2 - y1])
    + rect('outline', [x1, y1, x2 - x1, y2 - y1], ` rx="${corner}" ry="${corner}"`);
  face.classList.add('is-on');
}

/** @type {{ root: HTMLElement, maps: ReturnType<typeof installMaps> } | null} */
let shell = null;
/** @type {(() => void) | null} */
let closeOpen = null;
/** @type {(route: string) => void} */
let describeBy = () => undefined;

function shellOf() {
  if (shell) return shell;
  const root = document.createElement('div');
  root.tabIndex = -1;
  watchPictures(root);
  shell = { root, maps: installMaps(root, { open: () => undefined }) };
  installFilterMenus(root, (_, route) => describeBy(route));
  return shell;
}

const infoRemembered = () => {
  try {
    return localStorage.getItem(INFO_KEY) === 'open';
  } catch {
    return false;
  }
};

/** @param {boolean} open */
const rememberInfo = open => {
  try {
    if (open) localStorage.setItem(INFO_KEY, 'open');
    else localStorage.removeItem(INFO_KEY);
  } catch {
  }
};

/**
 * @param {string[] | Photos} photos
 * @param {number} at
 * @param {{ closed?: (index: number) => void }} [options]
 */
export function openPhotoViewer(photos, at, { closed = () => undefined } = {}) {
  closeOpen?.();
  const list = Array.isArray(photos) ? { count: photos.length, hash: (/** @type {number} */ n) => photos[n] } : photos;
  const { root, maps } = shellOf();
  const id = 'ck-viewer';
  const acts = madeActs(readHost(window));
  /** @type {Map<string, Promise<void>>} */
  const reading = new Map();
  const theme = darkTheme();
  const life = new AbortController();
  const { signal } = life;
  let index = Math.max(0, Math.min(list.count - 1, at));
  let info = infoRemembered();
  /** @type {Map<number, string>} */
  const hashes = new Map();
  const asking = new Set();
  const unread = new Set();
  /** @type {Map<string, Known>} */
  const known = new Map();
  /** @type {Map<string, ViewerState['sent']>} */
  const went = new Map();
  const unshown = new Set();
  /** @type {Map<string, 'cannot' | 'reach'>} */
  const unplayed = new Map();
  let onBadge = false;
  let pressing = false;
  let hovered = -1;
  let focusedChip = -1;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let resting;
  /** @type {Element[]} */
  const freed = [];
  const agents = document.getElementById('agent-layer');

  const shownFacts = () => {
    const hash = hashes.get(index);
    const facts = hash ? known.get(hash) : undefined;
    return facts?.state === 'read' ? facts.photo : null;
  };

  /** @returns {ViewerState} */
  const state = () => {
    const hash = hashes.get(index) ?? null;
    return { index, count: list.count, hash, info,
      unshown: (unread.has(index) && !asking.has(index)) || (hash !== null && unshown.has(hash)),
      known: (hash && known.get(hash)) || { state: 'reading' }, sent: (hash && went.get(hash)) || null,
      failed: (hash && unplayed.get(hash)) || null,
      describe: { acts: acts.hosted, busy: acts.busy(shownFacts()?.described), refused: acts.refused(shownFacts()?.described) } };
  };

  const describing = acts.follow({ made: () => [shownFacts()?.described], draw: () => draw(), live: () => !signal.aborted,
    read: () => {
      const hash = hashes.get(index);
      return hash ? read(hash, true) : Promise.resolve();
    } });
  describeBy = route => {
    const ask = shownFacts()?.described?.ask;
    if (ask && route) void describing.choose(ask, route);
  };

  const focusName = () => root.contains(document.activeElement)
    ? /** @type {HTMLElement} */ (document.activeElement).dataset.ckViewer ?? '' : null;

  /** @param {HTMLElement | null} control */
  const focusable = control => Boolean(control && !control.closest('[hidden]') && !control.matches(':disabled')
    && control.checkVisibility());

  function draw() {
    if (signal.aborted) return;
    const had = focusName();
    const now = state();
    for (const [name, value] of Object.entries(rootAttributes(now, id, theme))) root.setAttribute(name, value);
    root.classList.add('ck-viewer');
    root.classList.toggle('is-info', info);
    const key = stageKey(now);
    const kept = /** @type {HTMLElement | null} */ (root.querySelector('.ck-viewer__stage > .ck-video'));
    const keeps = Boolean(key && kept?.dataset.key === key);
    const playerHeld = keeps && Boolean(kept?.contains(document.activeElement));
    root.innerHTML = viewerParts(now, { id, map: 'viewer' });
    if (kept && !keeps) release(kept);
    const media = /** @type {HTMLElement | null} */ (root.querySelector('.ck-viewer__stage > .ck-video'));
    if (media && kept && keeps) media.replaceWith(kept);
    else if (media) {
      media.dataset.key = key;
      const fresh = /** @type {HTMLVideoElement | null} */ (media.querySelector('video.ck-viewer__video'));
      void fresh?.play().catch(() => undefined);
    }
    const place = info ? shownFacts()?.place : null;
    maps.settle(place ? { viewer: placeMap(place, theme) } : {});
    if (playerHeld) kept?.querySelector('video')?.focus({ preventScroll: true });
    else if (had !== null) {
      const named = (/** @type {string} */ name) => /** @type {HTMLElement | null} */ (root.querySelector(`[data-ck-viewer="${name}"]`));
      const back = had ? [named(had), named('info')].find(focusable) ?? root : root;
      back.focus({ preventScroll: true });
    }
    queueMicrotask(() => outlineFace(root, shownFacts(), hovered >= 0 ? hovered : focusedChip));
  }

  /**
   * @param {string} hash
   * @param {boolean} [again]
   * @returns {Promise<void>}
   */
  function read(hash, again = false) {
    if (signal.aborted || (!again && known.get(hash)?.state === 'read')) return Promise.resolve();
    const running = reading.get(hash);
    if (running) return again ? running.then(() => read(hash, true)) : running;
    if (known.get(hash)?.state !== 'read') known.set(hash, { state: 'reading' });
    const landing = fetchPhoto(hash, signal).then(answer => /** @type {Known} */ ({ state: 'read', photo: answer.photo }),
      failed => /** @type {{ status?: number }} */ (failed).status === 404 ? /** @type {Known} */ ({ state: 'read', photo: null })
        : /** @type {Known} */ ({ state: 'failed', words: lackOf(failed) }))
      .then(facts => {
        reading.delete(hash);
        if (signal.aborted) return;
        if (facts.state === 'read' || known.get(hash)?.state !== 'read') known.set(hash, facts);
        if (facts.state === 'read') whereWent(hash, facts.photo);
        if (hashes.get(index) === hash) draw();
      });
    reading.set(hash, landing);
    return landing;
  }

  /**
   * @param {string} hash
   * @param {PhotoFacts | null} photo
   */
  function whereWent(hash, photo) {
    const ask = photo?.described?.ask ?? null;
    if (!ask || went.has(hash)) return;
    went.set(hash, null);
    void itemSent(ask, { signal }).then(sent => {
      if (signal.aborted || !sent) return;
      went.set(hash, sent);
      if (hashes.get(index) === hash) draw();
    });
  }

  /**
   * @param {number} at
   * @param {string} hash
   */
  function found(at, hash) {
    if (signal.aborted) return;
    hashes.set(at, hash);
    unread.delete(at);
    read(hash);
  }

  /** @param {number} at */
  function reach(at) {
    if (at < 0 || at >= list.count) return;
    const held = hashes.get(at);
    if (held) return read(held);
    if (asking.has(at)) return;
    let got;
    try {
      got = list.hash(at);
    } catch {
      unread.add(at);
      return;
    }
    if (typeof got === 'string') return found(at, got);
    asking.add(at);
    got.then(hash => found(at, hash), () => {
      if (!signal.aborted) unread.add(at);
    }).finally(() => {
      asking.delete(at);
      if (!signal.aborted && at === index) draw();
    });
  }

  /** @param {number} to */
  function show(to) {
    index = Math.max(0, Math.min(list.count - 1, to));
    hovered = -1;
    focusedChip = -1;
    const hash = hashes.get(index);
    if (hash) {
      unshown.delete(hash);
      unplayed.delete(hash);
    }
    for (const at of [index, index + 1, index - 1]) reach(at);
    draw();
  }

  /**
   * @param {string} hash
   * @param {string} file
   */
  function unplayable(hash, file) {
    const host = readHost(window);
    const revision = host?.state.reach?.revision ?? -1;
    void fetch(lifeMediaUrl(file), { headers: { range: 'bytes=0-0' }, signal }).then(answer => {
      void answer.body?.cancel();
      return answer.ok || answer.status === 404 ? 'cannot' : 'reach';
    }, () => 'reach').then(why => {
      if (signal.aborted) return;
      unplayed.set(hash, /** @type {'cannot' | 'reach'} */ (why));
      if (why === 'reach' && host) {
        afterRecovery(host, revision, () => {
          if (signal.aborted || !unplayed.delete(hash)) return;
          if (hashes.get(index) === hash) draw();
        });
      }
      if (hashes.get(index) === hash) draw();
    });
  }

  const liveParts = () => {
    const stage = /** @type {HTMLElement | null} */ (root.querySelector('.ck-live-stage'));
    const motion = stage?.querySelector('video');
    return stage && motion ? { stage, motion, badge: stage.querySelector('.ck-live') } : null;
  };

  function playLive() {
    const live = liveParts();
    if (!live) return;
    live.motion.muted = true;
    live.motion.currentTime = 0;
    void live.motion.play().then(() => {
      live.stage.classList.add('is-playing');
      live.badge?.setAttribute('aria-pressed', 'true');
    }, () => undefined);
  }

  function stillLive() {
    const live = liveParts();
    if (!live) return;
    live.motion.pause();
    live.stage.classList.remove('is-playing');
    live.badge?.setAttribute('aria-pressed', 'false');
  }

  /** @param {boolean} open */
  function setInfo(open) {
    const panel = root.querySelector('.ck-viewer__body > .ck-viewer__info');
    const panelAt = panel?.getBoundingClientRect() ?? null;
    info = open;
    rememberInfo(open);
    draw();
    wake();
    slide(panel instanceof HTMLElement && panelAt ? { panel, at: panelAt } : null);
  }

  /** @param {{ panel: HTMLElement, at: DOMRect } | null} left */
  function slide(left) {
    const style = getComputedStyle(root);
    const timing = { duration: parseFloat(style.getPropertyValue('--duration-base')) || 0,
      easing: style.getPropertyValue('--ease-out').trim() || 'ease-out' };
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const travel = `translateX(${style.getPropertyValue('--space-6').trim() || '24px'})`;
    const panel = root.querySelector('.ck-viewer__body > .ck-viewer__info');
    if (left) {
      const ghost = left.panel;
      Object.assign(ghost.style, { position: 'fixed', left: `${left.at.left}px`, top: `${left.at.top}px`,
        width: `${left.at.width}px`, height: `${left.at.height}px`, pointerEvents: 'none', margin: '0' });
      ghost.inert = true;
      ghost.setAttribute('aria-hidden', 'true');
      root.append(ghost);
      const going = ghost.animate(reduce ? [{ opacity: 1 }, { opacity: 0 }]
        : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: travel }], { ...timing, fill: 'forwards' });
      void going.finished.then(() => ghost.remove(), () => ghost.remove());
    }
    if (reduce) {
      root.querySelector('.ck-viewer__stage')?.animate([{ opacity: 0 }, { opacity: 1 }], timing);
      panel?.animate([{ opacity: 0 }, { opacity: 1 }], timing);
      return;
    }
    panel?.animate([{ opacity: 0, transform: travel }, { opacity: 1, transform: 'none' }], timing);
  }

  function wake() {
    root.classList.remove('is-still');
    clearTimeout(resting);
    resting = setTimeout(rest, REST_MS);
  }

  function rest() {
    if (signal.aborted || info) return;
    if (root.querySelector('.ck-viewer__bar:hover, .ck-viewer__nav:hover')) return;
    if (document.activeElement?.closest('.ck-viewer__bar, .ck-viewer__nav')) return;
    root.classList.add('is-still');
  }

  /** @param {boolean} [handBack] */
  function close(handBack = true) {
    if (signal.aborted) return;
    life.abort();
    describing.stop();
    clearTimeout(resting);
    const stage = root.querySelector('.ck-viewer__stage');
    root.innerHTML = '';
    if (stage) release(stage);
    maps.settle({});
    root.remove();
    root.className = '';
    for (const element of freed) /** @type {HTMLElement} */ (element).inert = false;
    if (closeOpen === close) {
      closeOpen = null;
      describeBy = () => undefined;
    }
    if (handBack) closed(index);
  }

  const agentControls = () => agents && !agents.hidden
    ? /** @type {HTMLElement[]} */ ([...agents.querySelectorAll('a[href], button, input, select, textarea')]).filter(focusable) : [];

  const cycled = () => [...(/** @type {HTMLElement[]} */ ([...root.querySelectorAll('a[href], button, video.ck-viewer__video')]))
    .filter(control => focusable(control) && !control.closest('.maplibregl-ctrl')), ...agentControls()];

  /** @param {number} by */
  function cycle(by) {
    const controls = cycled();
    if (!controls.length) return root.focus();
    const at = controls.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    controls[at < 0 ? (by > 0 ? 0 : controls.length - 1) : (at + by + controls.length) % controls.length].focus();
  }

  /** @param {number} by */
  function throughPlayer(by) {
    const player = root.querySelector('video.ck-viewer__video');
    if (!player) return false;
    if (document.activeElement === player) return true;
    const controls = cycled();
    const at = controls.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    return at >= 0 && controls[at + by] === player;
  }

  /** @param {KeyboardEvent} event */
  function onKey(event) {
    wake();
    if (event.key === 'Tab' && !event.isComposing) {
      event.stopImmediatePropagation();
      if (throughPlayer(event.shiftKey ? -1 : 1)) return;
      event.preventDefault();
      cycle(event.shiftKey ? -1 : 1);
      return;
    }
    if (agents && event.target instanceof Node && agents.contains(event.target)) return;
    if (event.target instanceof Element && event.target.closest('.ck-fmenu')) return;
    if (event.target instanceof HTMLVideoElement && PLAYER_KEYS.has(event.key)) return;
    event.stopImmediatePropagation();
    if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    const player = /** @type {HTMLVideoElement | null} */ (root.querySelector('video.ck-viewer__video'));
    if (event.key === ' ' && !(event.target instanceof Element && event.target.closest('button, a'))) {
      if (player) void (player.paused ? player.play().catch(() => undefined) : player.pause());
      else if (liveParts()) playLive();
      else return;
    } else if (event.key === 'Escape') {
      if (info) setInfo(false);
      else close();
    } else if (event.key === 'ArrowLeft') show(index - 1);
    else if (event.key === 'ArrowRight') show(index + 1);
    else if (event.key === 'Home') show(0);
    else if (event.key === 'End') show(list.count - 1);
    else if (event.key === 'i' || event.key === 'I') setInfo(!info);
    else return;
    event.preventDefault();
  }

  root.addEventListener('click', event => {
    const target = /** @type {Element} */ (event.target);
    if (target.closest('.maplibregl-ctrl')) return;
    const control = /** @type {HTMLElement | null} */ (target.closest('[data-ck-viewer]'));
    const name = control?.dataset.ckViewer ?? '';
    if (target.closest('.ck-live')) playLive();
    else if (name === 'describe' && control?.matches('button')) describeBy(control.dataset.value ?? '');
    else if (name === 'info') setInfo(!info);
    else if (name === 'close') close();
    else if (name === 'prev' || name === 'next') show(index + (name === 'prev' ? -1 : 1));
    else if (control instanceof HTMLAnchorElement) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      const href = control.getAttribute('href') ?? '';
      close(false);
      location.hash = href;
    } else if (!target.closest('img, video, .ck-video__said, .ck-viewer__bar, .ck-viewer__chips, .ck-viewer__failed, '
      + '.ck-viewer__info, button, a')) close();
  }, { signal });
  root.addEventListener('mouseover', event => {
    const badge = Boolean(/** @type {Element} */ (event.target).closest('.ck-live'));
    if (badge && !onBadge) playLive();
    onBadge = badge;
    const chip = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest('.ck-viewer__chip'));
    const now = chip ? Number(chip.dataset.chip) : -1;
    if (now === hovered) return;
    hovered = now;
    outlineFace(root, shownFacts(), hovered >= 0 ? hovered : focusedChip);
  }, { signal });
  root.addEventListener('mouseleave', () => {
    hovered = -1;
    outlineFace(root, shownFacts(), focusedChip);
  }, { signal });
  root.addEventListener('focusin', event => {
    if (event.target instanceof Element && event.target.matches('.ck-viewer__edge')) {
      const controls = cycled();
      const player = controls.findIndex(control => control.matches('video.ck-viewer__video'));
      (controls[(player + 1) % controls.length] ?? root).focus({ preventScroll: true });
      return;
    }
    const chip = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest('.ck-viewer__chip'));
    focusedChip = chip ? Number(chip.dataset.chip) : -1;
    outlineFace(root, shownFacts(), hovered >= 0 ? hovered : focusedChip);
    wake();
  }, { signal });
  root.addEventListener('focusout', event => {
    if (event.relatedTarget instanceof Node && root.contains(event.relatedTarget)) return;
    focusedChip = -1;
    outlineFace(root, shownFacts(), hovered);
  }, { signal });
  root.addEventListener('pointermove', wake, { signal });
  root.addEventListener('load', event => {
    if (event.target instanceof HTMLImageElement && event.target.matches('.ck-viewer__stage img')) {
      outlineFace(root, shownFacts(), hovered >= 0 ? hovered : focusedChip);
    }
  }, { capture: true, signal });
  root.addEventListener('error', event => {
    const hash = hashes.get(index);
    const target = event.target;
    if (!hash || !(target instanceof Element) || !root.contains(target)) return;
    const film = shownFacts()?.play?.hash;
    if (target.matches('video.ck-viewer__video, video.ck-live-stage__motion')) {
      if (film) unplayable(hash, film);
    }
    else if (target.matches('.ck-viewer__stage img') && !target.closest('.ck-video:not(:has(.ck-live-stage))')) {
      unshown.add(hash);
      draw();
    }
  }, { capture: true, signal });
  root.addEventListener('loadedmetadata', event => {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement) || !video.matches('.ck-viewer__video')) return;
    if (!video.videoWidth || !video.videoHeight) return;
    video.style.setProperty('--ck-video-ratio', String(video.videoWidth / video.videoHeight));
    video.classList.add('is-sized');
  }, { capture: true, signal });
  root.addEventListener('ended', event => {
    if (event.target instanceof Element && event.target.matches('.ck-live-stage__motion')) stillLive();
  }, { capture: true, signal });
  root.addEventListener('pointerdown', event => {
    const target = /** @type {Element} */ (event.target);
    if (event.button !== 0 || !target.closest('.ck-live-stage') || target.closest('.ck-live')) return;
    pressing = true;
    playLive();
  }, { signal });
  for (const name of ['pointerup', 'pointercancel']) {
    window.addEventListener(name, () => {
      if (!pressing) return;
      pressing = false;
      stillLive();
    }, { signal });
  }
  window.addEventListener('keydown', onKey, { capture: true, signal });
  root.addEventListener('keydown', event => {
    if (event.target instanceof HTMLVideoElement) event.stopPropagation();
  }, { signal });
  window.addEventListener('resize', () => outlineFace(root, shownFacts(), hovered >= 0 ? hovered : focusedChip), { signal });
  if (agents) {
    agents.addEventListener('keydown', event => event.stopPropagation(), { signal });
    const leaving = new MutationObserver(() => {
      if (!root.contains(document.activeElement) && !agents.contains(document.activeElement)) root.focus({ preventScroll: true });
    });
    leaving.observe(agents, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    signal.addEventListener('abort', () => leaving.disconnect());
  }

  closeOpen = close;
  for (const sibling of document.body.children) {
    if (/** @type {HTMLElement} */ (sibling).inert || sibling === agents) continue;
    /** @type {HTMLElement} */ (sibling).inert = true;
    freed.push(sibling);
  }
  document.body.append(root);
  show(index);
  root.focus({ preventScroll: true });
  wake();
  return () => close();
}
