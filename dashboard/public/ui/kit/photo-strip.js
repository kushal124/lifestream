// @ts-check
import { attributes } from '../../lib/html.js';
import { picture } from './picture.js';
import { clock, counted } from '../../lib/words.js';
import { icon } from './icon.js';
import { videoLabel, videoMark } from './video.js';

export const STRIP_MOST = 12;

/** @param {{ block: string, photos: { hash: string, alt: string, at_ms?: number | null, video?: boolean, duration_ms?: number | null }[] }} strip */
export function photoStrip({ block, photos }) {
  if (!photos.length) return '';
  return `<div${attributes({ class: 'dy-photos', 'data-k': 'photos', 'data-d-fit': 'tiles', 'data-total': photos.length,
    'data-said': `${counted(photos.length, 'photo')} unavailable` })}>`
    + photos.slice(0, STRIP_MOST).map((shown, at) => `<button${attributes({ type: 'button', class: 'dy-tile', 'data-d-photo': at,
      'data-d-block': block, tabindex: '-1', 'aria-label': [shown.video ? videoLabel(shown.duration_ms) : shown.alt,
        ...shown.at_ms == null ? [] : [clock(shown.at_ms)], `photo ${at + 1} of ${photos.length}`].join(', ') })}>`
      + picture({ hash: shown.hash, size: 'tile', alt: '' }, { className: 'dy-tile__pic' })
      + (shown.video ? videoMark() : '')
      + `<span class="dy-tile__fallback" aria-hidden="true">${icon(shown.video ? 'video' : 'photo')}</span>`
      + '<span class="dy-tile__more mac-headline" aria-hidden="true"></span></button>').join('')
    + '</div>';
}
