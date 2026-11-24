// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { icon } from './icon.js';
import { signalShape } from './signal.js';
import { ARRIVES, bar, iconSquare } from './skeleton.js';
import { sectionLabel } from './surface.js';
import { tip } from './tip.js';

/** @typedef {import('./signal.js').SignalKind} SignalKind */

const LINES = /** @type {const} */ ([6, 7, 5, 7, 6]);

/** @typedef {{ role: 'checkbox' | 'radio' | 'button', checked: boolean, label: string, disabled?: boolean, title?: string, attrs?: import('../../lib/html.js').Attributes }} RowPress */

/**
 * @param {object} row
 * @param {string} row.name
 * @param {string} [row.icon]
 * @param {string | null} [row.line]
 * @param {'mono' | 'words'} [row.kind]
 * @param {SignalKind | null} [row.signal]
 * @param {string} [row.end]
 * @param {number} [row.index]
 * @param {boolean} [row.dim]
 * @param {number | null} [row.meter]
 * @param {string} [row.id]
 * @param {{ src: string } | null} [row.app]
 * @param {boolean} [row.pulse]
 * @param {string} [row.body]
 * @param {string} [row.why]
 * @param {string} [row.about]
 * @param {string} [row.mark]
 * @param {string} [row.beside]
 * @param {string} [row.after]
 * @param {RowPress | null} [row.press]
 * @param {boolean} [row.tile]
 * @param {'' | 'river'} [row.look]
 * @param {string} [row.className]
 * @param {RowHold | null} [row.hold]
 * @param {import('../../lib/html.js').Attributes} [row.attrs]
 */
export function groupRow({ name, icon: meaning = '', line = '', kind = 'mono', signal = null, end = '', index = 0,
  dim = false, meter = null, id = '', app = null, pulse = false, body = '', why = '', about = '', mark = '', after = '',
  beside = '', press = null, tile = false, look = '', className = '', hold = null, attrs = {} }) {
  const key = id || name;
  const river = look === 'river';
  const said = why ? `<span${attributes({ class: 'ck-grow__why', role: 'alert', 'data-arrive': `${key}:line` })}>`
      + `${signalShape('warning')}${esc(why)}</span>`
    : line === null ? bar(LINES, index)
      : `<span${attributes({ class: ARRIVES, 'data-arrive': `${key}:line` })}>${signal ? signalShape(signal, { pulse }) : ''}${esc(line)}</span>`;
  const share = meter === null ? null : Math.round(Math.max(0, Math.min(1, meter)) * 1000) / 10;
  const lead = app ? appIcon(name, app.src) : meaning ? icon(meaning, { size: 'md' }) : '';
  const lineType = kind === 'mono' && !why ? 'mac-mono-data' : river ? 'ob-row-line' : 'mac-subhead';
  const button = press?.role === 'button';
  const lineOf = (/** @type {string} */ words, /** @type {string} */ shape, /** @type {string} */ type) =>
    `<span class="ck-grow__line ck-grow__line--${shape} ${type}">${words}</span>`;
  const bodyOf = (/** @type {string} */ markup) => markup ? `<span class="ck-grow__body">${markup}</span>` : '';
  const face = (line === '' && !why ? '' : why && line
    ? lineOf(`${said}<span class="ck-held" aria-hidden="true">${esc(line)}</span>`, 'words', `${lineType} ck-grow__line--holds`)
    : lineOf(said, why ? 'words' : kind, lineType)) + after + bodyOf(body);
  const faces = [...(hold?.faces ?? []), ...(hold && why && line ? [{ line, after }] : [])].filter(each => each.line);
  const heldType = kind === 'mono' ? 'mac-mono-data' : river ? 'ob-row-line' : 'mac-subhead';
  const ends = end + (hold?.end ? '<span class="ck-held ck-hold__slot" aria-hidden="true"></span>' : '');
  const hit = press ? `<button${attributes({ type: 'button', class: 'ck-grow__hit', role: button ? null : press.role,
    'aria-checked': button ? null : String(press.checked), 'aria-expanded': button ? String(press.checked) : null,
    'aria-label': press.label, disabled: press.disabled === true,
    title: press.title || null, ...press.attrs })}></button>` : '';
  return `<li${attributes({ class: `ck-grow${dim ? ' is-dim' : ''}${lead ? '' : ' ck-grow--bare'}${
    press ? ' ck-grow--press' : ''}${tile ? ' ck-grow--tile' : ''}${mark ? ' ck-grow--mark' : ''}${
    className ? ` ${className}` : ''}`, ...attrs })}>`
    + hit
    + (mark ? `<span class="ck-grow__mark" aria-hidden="true">${mark}</span>` : '')
    + (lead ? `<span class="ck-grow__icon" aria-hidden="true">${lead}</span>` : '')
    + '<span class="ck-grow__main">'
    + `<span class="ck-grow__top"><span class="ck-grow__name ${river ? 'ob-row-name' : 'mac-headline'}">${esc(name)}</span>`
    + `${about ? tip({ label: name, text: about, id: key }) : ''}${beside}</span>`
    + (faces.length ? `<span class="ck-grow__faces"><span class="ck-grow__face">${face}</span>${faces.map(each =>
      `<span class="ck-grow__face ck-held" aria-hidden="true" inert>${lineOf(esc(each.line), kind, heldType)}${each.after ?? ''}${
        bodyOf(hold?.body ?? '')}</span>`).join('')}</span>` : face)
    + `</span>${ends ? `<span${attributes({ class: `ck-grow__end${hold?.end ? ' ck-hold' : ''}`,
      'data-arrive': `${key}:end` })}>${ends}</span>` : ''}`
    + (share === null ? '' : `<span${attributes({ class: 'ck-grow__meter', role: 'meter', 'aria-valuemin': 0,
      'aria-valuemax': 100, 'aria-valuenow': Math.round(share), 'aria-label': `${name} arrived` })}>`
      + `<span style="width: ${share}%"></span></span>`) + '</li>';
}

/** @typedef {{ faces?: { line: string, after?: string }[], body?: string, end?: boolean }} RowHold */

/** @param {string} markup */
export const heldPart = markup => `<span class="ck-held" aria-hidden="true" inert>${markup}</span>`;

/**
 * @param {string[]} tiles
 * @param {string} label
 */
export const tilesRow = (tiles, label) => `<li class="ck-grow ck-grow--tiles"><ul${attributes({ class: 'ck-tiles',
  'aria-label': label })}>${tiles.join('')}</ul></li>`;

/**
 * @param {string} name
 * @param {string} [src]
 */
export function appIcon(name, src = '') {
  const letter = [...name.trim()][0]?.toUpperCase() ?? '';
  const picture = /^lifestream-app:\/\/icon\/[\w.-]+$/u.test(src)
    ? `<img class="ck-appicon__picture" alt=""${attributes({ src, width: 28, height: 28 })}>` : '';
  return `<span class="ck-appicon mac-headline">${esc(letter)}${picture}</span>`;
}

/** @param {HTMLElement} root */
export function installAppIcons(root) {
  root.addEventListener('load', event => {
    const picture = event.target;
    if (picture instanceof HTMLImageElement && picture.classList.contains('ck-appicon__picture')) {
      picture.parentElement?.classList.add('is-loaded');
    }
  }, true);
}

const NAMES = /** @type {const} */ ([5, 4, 6, 4, 5, 6]);

/** @param {number} index */
export const groupRowReading = index => '<li class="ck-grow" aria-hidden="true">'
  + `<span class="ck-grow__icon">${iconSquare()}</span><span class="ck-grow__main">`
  + `<span class="ck-grow__name mac-headline">${bar(NAMES, index)}</span>`
  + `<span class="ck-grow__line mac-mono-data">${bar(LINES, index)}</span></span></li>`;

/**
 * @param {string[]} rows
 * @param {{ label?: string, columns?: 1 | 2, attrs?: import('../../lib/html.js').Attributes, role?: string }} [options]
 */
export const rowGroup = (rows, { label = '', columns = 1, attrs = {}, role = '' } = {}) => `<section${attributes({
  class: `ck-group${columns === 2 ? ' ck-group--cols' : ''}`, ...attrs })}>`
  + (label && !role ? sectionLabel(label) : '') + `<ul${attributes({ class: 'ck-group__rows', role: role || null,
    'aria-label': role && label ? label : null })}>${rows.join('')}</ul></section>`;

/**
 * @param {object} row
 * @param {string} row.icon
 * @param {string} row.value
 * @param {string} row.line
 */
export const tileRow = ({ icon: meaning, value, line }) => `<div class="ck-tilerow" role="listitem">`
  + `<span class="ck-tilerow__tile" aria-hidden="true">${icon(meaning)}</span><span class="ck-tilerow__main">`
  + `<span${attributes({ class: 'ck-tilerow__value mac-headline', title: value })}>${esc(value)}</span>`
  + `<span class="ck-tilerow__line mac-subhead">${esc(line)}</span></span></div>`;

/**
 * @param {string[]} rows
 * @param {string} label
 */
export const rowsAcross = (rows, label) => `<div${attributes({ class: 'ck-across', role: 'list', 'aria-label': label })}>${rows.join('')}</div>`;
