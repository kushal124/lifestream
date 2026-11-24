// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { pictureUrl } from '../../lib/api.js';
import { PROBE_EVERY_S } from '../../lib/reach.js';
import { icon } from './icon.js';
import { avatar } from './skeleton.js';

/** @typedef {'xs' | 'sm' | 'md' | 'row' | 'tile' | 'head' | 'hero'} FaceSize */

/** @type {Record<FaceSize, import('./icon.js').IconSize>} */
const GLYPHS = { xs: 'xs', sm: 'xs', md: 'sm', row: 'sm', tile: 'lg', head: 'xl', hero: 'xl' };

/** @param {string} name */
export function initials(name) {
  const words = name.trim().split(/\s+/u).filter(word => /^\p{L}/u.test(word));
  if (words.length) {
    return [words[0], ...words.slice(1).slice(-1)].map(word => [...word][0].toLocaleUpperCase()).join('');
  }
  return /[\p{L}\p{N}]/u.exec(name)?.[0] ?? '#';
}

/**
 * @param {string} name
 * @param {FaceSize} size
 */
const inner = (name, size) => /\p{L}/u.test(name) ? esc(initials(name)) : icon('person', { size: GLYPHS[size] });

/**
 * @param {string} name
 * @param {FaceSize} [size]
 */
export const monogram = (name, size = 'md') => `<span class="ck-mono ck-mono--${size}" aria-hidden="true">`
  + `${inner(name, size)}</span>`;

/**
 * @param {object} face
 * @param {string | null} face.name
 * @param {string} [face.photo]
 * @param {FaceSize} [face.size]
 */
export function personFace({ name, photo = '', size = 'md' }) {
  if (name === null) {
    return `<span class="ck-mono ck-mono--${size} ck-mono--unnamed" aria-hidden="true">`
      + `${icon('person', { size: GLYPHS[size] })}</span>`;
  }
  if (!photo) return monogram(name, size);
  return `<span class="ck-mono ck-mono--${size} ck-face" aria-hidden="true">${inner(name, size)}<img${attributes({
    class: 'ck-pic ck-face__photo', 'data-src': pictureUrl(photo, size === 'hero' ? 'screen' : 'tile'), alt: '', loading: 'lazy', decoding: 'async', draggable: 'false',
  })}></span>`;
}

/**
 * @param {string} meaning
 * @param {FaceSize} [size]
 */
export const quietRing = (meaning, size = 'md') => `<span class="ck-mono ck-mono--${size} ck-mono--ring"`
  + ` aria-hidden="true">${icon(meaning, { size: GLYPHS[size] })}</span>`;

/** @param {FaceSize} [size] */
export const personFaceReading = (size = 'md') => `<span class="ck-mono ck-mono--${size} ck-mono--reading"`
  + ` aria-hidden="true">${avatar()}</span>`;

const PICTURE = 'img.ck-pic';
const ASKED = '/api/life/picture?';
const NEAR = '1250px';

/** @param {Element} picture */
const addressOf = picture => picture.getAttribute('data-src') ?? '';

/**
 * @param {Node[]} nodes
 * @returns {HTMLImageElement[]}
 */
const picturesIn = nodes => [...new Set(nodes.flatMap(node => node instanceof HTMLImageElement ? node.matches(PICTURE) ? [node] : []
  : node instanceof Element ? [.../** @type {NodeListOf<HTMLImageElement>} */ (node.querySelectorAll(PICTURE))] : []))];

/**
 * @param {HTMLImageElement} kept
 * @param {HTMLImageElement} picture
 */
function keep(kept, picture) {
  for (const { name } of [...kept.attributes]) {
    if (name !== 'src' && !picture.hasAttribute(name)) kept.removeAttribute(name);
  }
  for (const { name, value } of [...picture.attributes]) {
    if (kept.getAttribute(name) !== value) kept.setAttribute(name, value);
  }
  picture.replaceWith(kept);
  return kept;
}

/** @param {HTMLImageElement} picture */
function weighStrip(picture) {
  const strip = picture.closest('.dy-photos');
  strip?.classList.toggle('is-unavailable', !!strip.querySelector('.dy-tile.is-failed') && !strip.querySelector('.ck-pic.is-loaded'));
}

/** @typedef {{ pictures: Set<HTMLImageElement>, stop: AbortController, bytes: string, failed: boolean }} Read */
/** @type {Map<string, Read>} */
const reads = new Map();
const KEEP = 64;
/** @type {Map<string, string>} */
const kept = new Map();
/** @type {WeakMap<Element, string>} */
const showing = new WeakMap();

/** @param {HTMLImageElement} picture */
const fail = picture => picture.dispatchEvent(new Event('error'));

/**
 * @param {number} ms
 * @param {AbortSignal} signal
 */
const until = (ms, signal) => new Promise((done, stopped) => {
  if (signal.aborted) return stopped(signal.reason);
  const stop = () => {
    clearTimeout(timer);
    stopped(signal.reason);
  };
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', stop);
    done(undefined);
  }, ms);
  signal.addEventListener('abort', stop, { once: true });
});

/**
 * @param {string} address
 * @param {Read} read
 */
async function ask(address, read) {
  const { signal } = read.stop;
  try {
    for (;;) {
      const answer = await fetch(address, { signal });
      if (answer.ok) {
        const bytes = await answer.blob();
        if (signal.aborted) return;
        read.bytes = URL.createObjectURL(bytes);
        for (const picture of read.pictures) picture.src = read.bytes;
        return;
      }
      if (answer.status !== 503) {
        void answer.body?.cancel();
        break;
      }
      const said = await answer.json().catch(() => null);
      if (said?.code !== 'NOT_NOW') break;
      await until((Number(answer.headers.get('retry-after')) || PROBE_EVERY_S) * 1000, signal);
    }
  } catch {
  }
  if (signal.aborted) return;
  read.failed = true;
  for (const picture of read.pictures) fail(picture);
}

/**
 * @param {HTMLImageElement} picture
 * @param {string} address
 */
function join(picture, address) {
  let read = reads.get(address);
  if (!read) {
    read = { pictures: new Set(), stop: new AbortController(), bytes: kept.get(address) ?? '', failed: false };
    kept.delete(address);
    reads.set(address, read);
    if (!read.bytes) void ask(address, read);
  }
  read.pictures.add(picture);
  if (read.bytes && picture.getAttribute('src') !== read.bytes) {
    picture.classList.add('is-back');
    picture.src = read.bytes;
  } else if (read.failed) fail(picture);
}

/** @type {IntersectionObserver | null} */
let nearing = null;
const nearingOf = () => nearing ??= new IntersectionObserver(entries => {
  for (const { target, isIntersecting } of entries) {
    const address = showing.get(target);
    if (!isIntersecting || address === undefined) continue;
    nearing?.unobserve(target);
    join(/** @type {HTMLImageElement} */ (target), address);
  }
}, /** @type {IntersectionObserverInit} */ ({ rootMargin: NEAR, scrollMargin: NEAR }));

/** @param {HTMLImageElement} picture */
function show(picture) {
  const address = addressOf(picture);
  if (showing.get(picture) === address) return;
  leave(picture);
  if (!address.startsWith(ASKED)) {
    if (address && picture.getAttribute('src') !== address) picture.src = address;
    return;
  }
  showing.set(picture, address);
  if (picture.getAttribute('loading') === 'lazy' && !reads.has(address) && !kept.has(address)) nearingOf().observe(picture);
  else join(picture, address);
}

/** @param {HTMLImageElement} picture */
function leave(picture) {
  const address = showing.get(picture);
  if (address === undefined) return;
  showing.delete(picture);
  nearing?.unobserve(picture);
  const read = reads.get(address);
  if (!read?.pictures.delete(picture) || read.pictures.size) return;
  reads.delete(address);
  read.stop.abort();
  if (!read.bytes) return;
  kept.set(address, read.bytes);
  for (const [oldest, bytes] of kept) {
    if (kept.size <= KEEP) break;
    kept.delete(oldest);
    URL.revokeObjectURL(bytes);
  }
}

/**
 * @param {MutationRecord[]} records
 * @param {MutationObserver} loader
 */
function drawn(records, loader) {
  const removed = picturesIn(records.flatMap(record => [...record.removedNodes]));
  /** @type {Map<string, HTMLImageElement[]>} */
  const gone = new Map();
  for (const picture of removed) {
    const address = addressOf(picture);
    if (!address || picture.isConnected || (picture.complete && !picture.naturalWidth)) continue;
    gone.set(address, [...gone.get(address) ?? [], picture]);
  }
  const shown = picturesIn(records.flatMap(record => [...record.addedNodes])).filter(picture => picture.isConnected)
    .map(picture => {
      const kept = gone.get(addressOf(picture))?.shift();
      return kept ? keep(kept, picture) : picture;
    });
  const moved = records.flatMap(({ type, target }) => type === 'attributes' && target instanceof HTMLImageElement
    && target.matches(PICTURE) ? [target] : []);
  loader.takeRecords();
  for (const picture of shown) {
    show(picture);
    if (picture.complete && picture.naturalWidth) {
      picture.classList.add('is-loaded');
      weighStrip(picture);
    }
  }
  for (const picture of moved) {
    if (picture.isConnected) show(picture);
  }
  for (const picture of removed) {
    if (!picture.isConnected) leave(picture);
  }
}

/** @type {MutationObserver | null} */
let loader = null;

/** @param {Element} root */
export function watchPictures(root) {
  root.setAttribute('data-pictures', '');
  root.addEventListener('error', event => {
    if (!(event.target instanceof HTMLImageElement) || !event.target.matches(PICTURE)) return;
    event.target.closest('.ck-face, .ck-fcrop, .ck-photo, .dy-tile')?.classList.add('is-failed');
    weighStrip(event.target);
  }, true);
  root.addEventListener('load', event => {
    if (event.target instanceof HTMLImageElement && event.target.matches(PICTURE)) {
      event.target.classList.add('is-loaded');
      weighStrip(event.target);
    }
  }, true);
  if (!loader) {
    loader = new MutationObserver(drawn);
    loader.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-src'] });
  }
  for (const picture of picturesIn([root])) {
    if (picture.isConnected) show(picture);
  }
}
