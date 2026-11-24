// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { lifeDownloadUrl, lifeMediaUrl, pictureUrl } from '../../lib/api.js';
import { button } from './button.js';
import { icon } from './icon.js';
import { pageLack } from './states.js';

export const VIDEO_WORDS = {
  cannot: 'This video can’t play here.',
  reach: 'This video can’t play right now.',
};

/**
 * @param {number} ms
 * @param {{ length?: boolean }} [options]
 */
export function playerClock(ms, { length = false } = {}) {
  const seconds = Math.max(0, Number.isFinite(ms) ? ms / 1000 : 0);
  const whole = length ? (seconds > 0 ? Math.max(1, Math.round(seconds)) : 0) : Math.floor(seconds);
  const hours = Math.floor(whole / 3600), minutes = Math.floor(whole / 60) % 60, rest = String(whole % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

/** @param {{ length_ms?: number | null }} [video] */
export const videoMark = ({ length_ms = null } = {}) => `<span class="ck-video-mark ck-night${length_ms ? '' : ' ck-video-mark--glyph'}" aria-hidden="true">`
  + icon('play', { size: 'xs', fill: true })
  + (length_ms ? `<span class="ck-video-mark__clock">${playerClock(length_ms, { length: true })}</span>` : '') + '</span>';

/** @param {number | null | undefined} length_ms */
export const videoLabel = length_ms => length_ms ? `Video, ${playerClock(length_ms, { length: true })}` : 'Video';

/** @param {{ hash: string, length_ms?: number | null, attrs?: import('../../lib/html.js').Attributes, className?: string }} tile */
export const videoTile = ({ hash, length_ms = null, attrs = {}, className = '' }) => `<button${attributes({
  type: 'button', class: `ck-video-tile ${className}`.trim(), 'aria-label': videoLabel(length_ms), ...attrs })}>`
  + `<img${attributes({ class: 'ck-pic ck-video-tile__poster', 'data-src': pictureUrl(hash, 'tile'), alt: '', decoding: 'async',
    draggable: 'false', loading: 'lazy' })}>`
  + videoMark({ length_ms }) + '</button>';

/**
 * @param {'cannot' | 'reach'} state
 * @param {string} file
 */
const said = (state, file) => state === 'cannot'
  ? `<div class="ck-video__said" role="status"><p class="mac-subhead">${esc(VIDEO_WORDS.cannot)}</p>`
    + button('Download', { size: 'sm', href: lifeDownloadUrl(file), attrs: { download: '', target: null, rel: null } }) + '</div>'
  : `<div class="ck-video__said">${pageLack(VIDEO_WORDS.reach)}</div>`;

/**
 * @param {string} hash
 * @param {string} alt
 */
const still = (hash, alt) => `<img${attributes({ class: 'ck-pic ck-video__still', 'data-src': pictureUrl(hash, 'screen'), alt,
  decoding: 'async', draggable: 'false' })}>`;

/** @param {{ hash: string, alt?: string, state?: 'play' | 'cannot' | 'reach' }} stage */
export function videoStage({ hash, alt = '', state = 'play' }) {
  if (state === 'play') {
    return `<div class="ck-video"><div class="ck-video__fit">${still(hash, '')}</div>`
      + `<video${attributes({ class: 'ck-viewer__video', controls: true, playsinline: true, preload: 'metadata',
        controlslist: 'nofullscreen', disablepictureinpicture: true, src: lifeMediaUrl(hash), 'aria-label': alt || 'Video' })}>`
      + '</video></div>';
  }
  return `<div class="ck-video ck-video--said"><div class="ck-video__fit">${still(hash, alt)}</div>${said(state, hash)}</div>`;
}

/** @param {{ playing?: boolean }} [badge] */
export const liveBadge = ({ playing = false } = {}) => `<button${attributes({ type: 'button', class: 'ck-live',
  'aria-label': 'Play Live Photo', 'aria-pressed': playing ? 'true' : 'false' })}>`
  + icon('live', { size: 'sm' }) + '<span class="ck-live__word mac-label" aria-hidden="true">LIVE</span></button>';

/** @param {{ hash: string, motion: string | null, alt?: string, playing?: boolean, failed?: 'cannot' | 'reach' | null }} stage */
export function liveStage({ hash, motion, alt = '', playing = false, failed = null }) {
  const plays = motion && !failed;
  return `<div class="ck-video${failed ? ' ck-video--said' : ''}">`
    + `<div${attributes({ class: `ck-video__fit ck-live-stage${playing ? ' is-playing' : ''}` })}>` + still(hash, alt)
    + (plays ? `<video${attributes({ class: 'ck-live-stage__motion', muted: true, playsinline: true, preload: 'auto',
      disablepictureinpicture: true, src: lifeMediaUrl(motion), 'aria-hidden': 'true', tabindex: '-1' })}></video>`
      + liveBadge({ playing }) : '')
    + '</div>' + (motion && failed ? said(failed, motion) : '') + '</div>';
}
