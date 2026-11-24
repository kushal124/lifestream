// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { pictureUrl } from '../../lib/api.js';
import { iconButton } from './button.js';
import { openPhotoViewer } from './photo-viewer.js';
import { picture, pictureFrame } from './picture.js';
import { videoLabel, videoMark } from './video.js';

/** @typedef {{ hash: string, alt: string, words?: string, video?: boolean, duration_ms?: number | null, live?: boolean }} Shown */

/** @param {Shown} shown */
const kindOf = shown => shown.video ? 'Video' : shown.live ? 'Live Photo' : 'Picture';

/**
 * @param {Shown[]} pictures
 * @param {number} [at]
 */
export function gallery(pictures, at = 0) {
  if (!pictures.length) return '';
  const shown = pictures[at];
  const several = pictures.length > 1;
  const strip = several ? `<div class="ck-gallery__strip">${pictures.map((picture, index) => `<button${attributes({
    type: 'button', class: index === at ? 'is-on' : null, 'data-ck-gallery-at': index,
    'aria-label': `${kindOf(picture)} ${index + 1}`,
    'aria-current': index === at ? 'true' : null })}>${thumbnail(picture)}</button>`).join('')}</div>` : '';
  return `<div class="ck-gallery" tabindex="0"${attributes({ 'data-ck-gallery': at, 'aria-label': `${pictures.length} pictures` })}>`
    + `<div class="ck-gallery__stage"><button class="ck-gallery__open"${attributes({ type: 'button', 'data-ck-picture': at,
      'aria-label': shown.video ? `${videoLabel(shown.duration_ms)}, play` : shown.live ? 'Live Photo, full size' : 'Full size' })}>`
    + (shown.video ? poster(shown) : pictureFrame({ ...shown, size: 'screen' })) + '</button>'
    + '<p class="ck-gallery__failed mac-subhead">This picture cannot be shown here.</p>'
    + (several ? iconButton('back', 'Previous picture', { variant: 'glass', className: 'ck-gallery__nav ck-gallery__nav--prev', attrs: { 'data-ck-gallery-step': '-1' } })
      + iconButton('forward', 'Next picture', { variant: 'glass', className: 'ck-gallery__nav ck-gallery__nav--next', attrs: { 'data-ck-gallery-step': '1' } }) : '')
    + '</div>'
    + `<div class="ck-gallery__line"><p class="ck-gallery__words mac-subhead">${esc(shown.words ?? shown.alt)}</p>`
    + (several ? `<span class="ck-gallery__count mac-mono-data">${at + 1} of ${pictures.length}</span>` : '') + '</div>'
    + strip + '</div>';
}

/**
 * @template P
 * @param {import('../../lib/photo-pages.js').PhotoPages<P>} pages
 * @param {number} index
 * @param {(photo: P) => string} hashOf
 * @param {(index: number) => void} closed
 * @param {number | null} [total]
 */
export function openPhotoPages(pages, index, hashOf, closed, total = null) {
  openPhotoViewer({
    count: pages.view().total ?? total ?? 0,
    hash: n => {
      const photo = pages.photo(n);
      return photo instanceof Promise ? photo.then(hashOf) : hashOf(photo);
    },
  }, index, {
    closed: last => {
      const { page, size } = pages.view();
      if (Math.floor(last / size) !== page) pages.go(Math.floor(last / size));
      closed(last);
    },
  });
}

/** @param {Shown} shown */
const poster = shown => '<div class="ck-video"><div class="ck-video__fit">'
  + `<img${attributes({ class: 'ck-pic ck-video__still', 'data-src': pictureUrl(shown.hash, 'screen'), alt: shown.alt,
    decoding: 'async', draggable: 'false' })}>` + videoMark({ length_ms: shown.duration_ms ?? null }) + '</div></div>';

/** @param {Shown} shown */
const thumbnail = shown => picture({ hash: shown.hash, size: 'tile', alt: '' }, { attrs: { loading: 'lazy' } })
  + (shown.video ? videoMark() : '');

/**
 * @param {HTMLElement} root
 * @param {(holder: HTMLElement) => Shown[]} pictures
 */
export function installGalleries(root, pictures) {
  /** @param {HTMLElement} holder @param {number} at */
  const show = (holder, at) => {
    const all = pictures(holder);
    const next = Math.max(0, Math.min(all.length - 1, at));
    const focused = holder.contains(document.activeElement);
    holder.outerHTML = gallery(all, next);
    if (focused) /** @type {HTMLElement | null} */ (root.querySelector('.ck-gallery'))?.focus({ preventScroll: true });
  };
  root.addEventListener('click', event => {
    const target = /** @type {Element} */ (event.target);
    const holder = /** @type {HTMLElement | null} */ (target.closest('[data-ck-gallery], .ck-thread'));
    if (!holder) return;
    const strip = /** @type {HTMLElement | null} */ (target.closest('[data-ck-gallery-at]'));
    const stepper = /** @type {HTMLElement | null} */ (target.closest('[data-ck-gallery-step]'));
    const picture = /** @type {HTMLElement | null} */ (target.closest('[data-ck-picture]'));
    if (strip) show(holder, Number(strip.dataset.ckGalleryAt));
    else if (stepper) show(holder, Number(holder.dataset.ckGallery) + Number(stepper.dataset.ckGalleryStep));
    else if (picture) {
      openPhotoViewer(pictures(holder).map(shown => shown.hash), Number(picture.dataset.ckPicture), { closed: () => picture.focus() });
    }
  });
  root.addEventListener('keydown', event => {
    const holder = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest?.('[data-ck-gallery]'));
    if (!holder || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    event.preventDefault();
    event.stopPropagation();
    show(holder, Number(holder.dataset.ckGallery) + (event.key === 'ArrowLeft' ? -1 : 1));
  });
  root.addEventListener('error', event => {
    if (!(event.target instanceof HTMLImageElement) || event.target.closest('.ck-video')) return;
    event.target.closest('.ck-gallery__stage')?.classList.add('is-failed');
    event.target.closest('.ck-gallery__strip button')?.classList.add('is-failed');
  }, true);
}
