// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { pictureUrl } from '../../lib/api.js';
import { icon } from './icon.js';
import { shape } from './skeleton.js';
import { tick } from './tick.js';

/** @typedef {import('../../lib/html.js').Attributes} Attributes */
/** @typedef {'open' | 'out' | 'choose'} FaceMode */

/**
 * @typedef {object} Face
 * @property {string} hash
 * @property {string} label
 * @property {Attributes} [attrs]
 * @property {boolean} [on]
 * @property {boolean} [whole]
 * @property {boolean} [disabled]
 * @property {'hover' | 'focus'} [forced]
 */

const ROLES = /** @type {const} */ ({
  open: { role: null, state: null },
  out: { role: null, state: 'aria-pressed' },
  choose: { role: 'radio', state: 'aria-checked' },
});

/**
 * @param {Face} face
 * @param {FaceMode} [mode]
 */
export function faceCrop({ hash, label, attrs, on = false, whole = false, disabled = false, forced }, mode = 'open') {
  const { role, state } = ROLES[mode];
  const button = (Boolean(attrs) || mode !== 'open') && !(mode === 'choose' && on);
  const classes = ['ck-fcrop', `ck-fcrop--${mode}`, on ? 'is-on' : '', hash ? '' : 'is-empty',
    forced ? `is-${forced}` : ''].filter(Boolean).join(' ');
  const picture = icon(whole ? 'photo' : 'person', { size: 'md', className: 'ck-fcrop__glyph' }) + (hash ? `<img${attributes({
    class: 'ck-pic ck-fcrop__img', 'data-src': pictureUrl(hash, 'tile'), alt: '',
    loading: 'lazy', decoding: 'async', draggable: 'false' })}>` : '');
  const mark = mode === 'out' ? `<span class="ck-fcrop__badge" aria-hidden="true">${icon('close', { size: 'xs' })}</span>`
    : mode === 'choose' && on ? `<span class="ck-fcrop__badge">${tick(on, { photo: true })}</span>`
      : '';
  if (!button) return `<span${attributes({ class: classes, role: 'img', 'aria-label': label, ...attrs })}>${picture}${mark}</span>`;
  return `<button${attributes({
    type: 'button', class: classes, role, 'aria-label': label, disabled,
    ...(state ? { [state]: String(on) } : {}), ...attrs,
  })}>${picture}${mark}</button>`;
}

/** @param {{ attrs?: Attributes, lit?: boolean }} upload */
const uploadTile = ({ attrs = {}, lit = false }) => `<label class="ck-fcrop ck-fcrop--upload${lit ? ' is-lit' : ''}" data-ck-upload>`
  + `<input${attributes({ class: 'ck-fcrop__file', type: 'file', accept: 'image/*', 'aria-label': 'Upload a photo', ...attrs })}>`
  + `${icon('add', { size: 'md' })}<span class="ck-fcrop__words mac-footnote" aria-hidden="true">Upload a photo</span></label>`;

/**
 * @param {object} grid
 * @param {Face[]} grid.faces
 * @param {string} grid.label
 * @param {FaceMode} [grid.mode]
 * @param {{ count: number, attrs: Attributes } | null} [grid.more]
 * @param {boolean} [grid.all]
 * @param {{ attrs?: Attributes, lit?: boolean } | null} [grid.upload]
 * @param {boolean} [grid.reading]
 * @param {number} [grid.room]
 * @param {boolean} [grid.pad]
 * @param {4 | 6} [grid.columns]
 */
export function faceGrid({ faces, label, mode = 'open', more = null, all = false, upload = null, reading = false, room: tiles = 12,
  pad = false, columns = 6 }) {
  const room = tiles - (upload ? 1 : 0);
  const shown = all ? faces : faces.slice(0, room - (more && !reading ? 1 : 0));
  const left = Math.max(0, room - shown.length);
  const read = reading ? Array.from({ length: left }, faceCropReading).join('')
    : pad ? Array.from({ length: left }, () => '<span class="ck-fcrop ck-fcrop--blank" aria-hidden="true"></span>').join('') : '';
  const rest = more && !all && !reading ? `<button${attributes({ type: 'button', class: 'ck-fcrop ck-fcrop--more',
    'aria-label': `${more.count.toLocaleString('en-US')} more`, ...more.attrs })}><span class="ck-fcrop__more">`
    + `+${esc(more.count.toLocaleString('en-US'))}</span></button>` : '';
  return `<div${attributes({ class: `ck-fgrid${columns === 4 ? ' ck-fgrid--4' : ''}`, role: mode === 'choose' ? 'radiogroup' : 'group',
    'aria-label': label })}>`
    + `<div class="ck-fgrid__faces">${upload ? uploadTile(upload) : ''}${shown.map(face => faceCrop(face, mode)).join('')}`
    + `${rest}${read}</div></div>`;
}

export const faceCropReading = () => `<span class="ck-fcrop ck-fcrop--reading" aria-hidden="true">${shape()}</span>`;

/** @param {number} count */
export const faceGridReading = count => '<div class="ck-fgrid" aria-hidden="true"><div class="ck-fgrid__faces">'
  + Array.from({ length: Math.min(12, count) }, faceCropReading).join('') + '</div></div>';
