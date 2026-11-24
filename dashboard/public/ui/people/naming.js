// @ts-check
/** @import { Face } from '../kit/face-grid.js' */
import { esc } from '../../lib/html.js';
import {
  inPlaceLine, bar, button, faceGrid, icon, loading, meter, nameRow, noneLine, personFace, pictureFrame, textField, waitLine,
} from '../kit/index.js';

export const SHOWN = 12;

/**
 * @typedef {object} NamingRow
 * @property {string} lead
 * @property {string} name
 * @property {string} line
 */

/** @param {string | null} left */
export const namingLeft = left => `<span class="naming-left mac-body">${left === null ? bar(1) : esc(left)}</span>`;

/**
 * @param {object} side
 * @param {Face[]} side.faces
 * @param {boolean} side.all
 * @param {string} side.span
 * @param {{ label: string, busy?: boolean } | null} side.more
 * @param {string} [side.label]
 * @param {string} [side.peek]
 */
export function namingFaces({ faces, all, span, more, label = 'This group’s faces', peek = '' }) {
  const columns = all || faces.length > SHOWN ? 6 : faces.length <= 2 ? 2 : faces.length === 3 ? 3 : 4;
  const rows = Math.max(1, Math.ceil(faces.length / columns));
  const grid = faceGrid({ faces, label, mode: 'out', all, room: Math.max(faces.length, 1) });
  const toggle = more ? button(more.label, { variant: 'plain', size: 'sm', busy: more.busy ?? false,
    attrs: { 'data-f-all': '' } }) : '';
  return `<div class="naming-faces${all ? ' is-all' : ''}${peek ? ' is-peek' : ''}" id="face-faces"><div class="naming-gridbox">`
    + `<div class="naming-grid naming-grid--c${columns} naming-grid--r${Math.min(rows, all ? 3 : 6)}">${grid}</div>${peek}</div>`
    + `<p class="naming-span mac-subhead"><span>${esc(span)}</span>${toggle}</p></div>`;
}

/**
 * @param {object} peek
 * @param {string} peek.hash
 * @param {string} peek.face
 * @param {string} peek.words
 */
export const namingPeek = ({ hash, face, words }) => `<div class="naming-peek" data-f-peek="${esc(face)}">`
  + pictureFrame({ hash, size: 'full', alt: 'The whole photo of this face' }, { className: 'naming-peek__box',
    imageClass: 'naming-peek__img', overlay: '<svg class="naming-peek__ring" aria-hidden="true" hidden><circle /></svg>'
      + '<p class="naming-peek__none mac-subhead" hidden>This photo can’t be shown here.</p>' })
  + `<p class="naming-peek__words mac-subhead">${esc(words)}</p></div>`;

/** @param {HTMLElement} root */
export function placePeek(root) {
  const peek = /** @type {HTMLElement | null} */ (root.querySelector('[data-f-peek]'));
  if (!peek?.querySelector('.naming-peek__img')) return;
  const draw = () => {
    const img = /** @type {HTMLImageElement | null} */ (peek.querySelector('.naming-peek__img'));
    const ring = peek.querySelector('.naming-peek__ring');
    const circle = ring?.querySelector('circle');
    const box = /^[0-9a-f]{64}:(\d+),(\d+),(\d+),(\d+)$/u.exec(peek.dataset.fPeek ?? '')?.slice(1).map(Number);
    if (!img || !ring || !circle || !box || !img.naturalWidth) return;
    const [x1, y1, x2, y2] = box;
    ring.setAttribute('viewBox', `0 0 ${img.naturalWidth} ${img.naturalHeight}`);
    ring.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    circle.setAttribute('cx', String((x1 + x2) / 2));
    circle.setAttribute('cy', String((y1 + y2) / 2));
    circle.setAttribute('r', String(Math.max(x2 - x1, y2 - y1) * 0.7));
    circle.setAttribute('vector-effect', 'non-scaling-stroke');
    ring.removeAttribute('hidden');
  };
  const none = () => {
    const img = /** @type {HTMLImageElement | null} */ (peek.querySelector('.naming-peek__img'));
    if (img) img.hidden = true;
    peek.querySelector('.naming-peek__none')?.removeAttribute('hidden');
  };
  peek.addEventListener('load', draw, { capture: true, once: true });
  peek.addEventListener('error', none, { capture: true, once: true });
  queueMicrotask(draw);
}

/**
 * @param {object} ask
 * @param {string} ask.face
 * @param {string} ask.name
 * @param {string} ask.waiting
 */
export const namingAsk = ({ face, name, waiting }) => `<div class="naming-ask">${face}<div class="naming-ask__words">`
  + `<h2 class="naming-question mac-title-1">Is this ${esc(name)}?</h2>`
  + `<p class="naming-ask__line mac-body">${esc(waiting)}</p></div></div>`;

/**
 * @param {NamingRow[]} rows
 * @param {number | null} lit
 * @param {string} [none]
 */
export function namingRows(rows, lit, none = '') {
  const row = (/** @type {NamingRow} */ each, /** @type {number} */ index) => nameRow({ lead: { face: each.lead }, answer: true,
    name: each.name, line: each.line, lit: index === lit, attrs: { 'data-f-row': index } });
  const last = rows.length - 1;
  return (none ? noneLine(none) : '')
    + rows.slice(0, last).map(row).join('') + (last > 0 || none ? '<div class="naming-sep" aria-hidden="true"></div>' : '')
    + (last >= 0 ? row(rows[last], last) : '');
}

/**
 * @param {object} foot
 * @param {string} foot.said
 * @param {{ said: import('../../lib/reach.js').Said, words: string, again: boolean } | null} foot.failure
 * @param {boolean} foot.back
 */
export const namingFoot = ({ said, failure, back }) => button('Back', { variant: 'plain', key: '⌘Z', disabled: !back,
  attrs: { 'data-f-back': '' } })
  + (failure ? `<div class="naming-said mac-subhead" role="status">${inPlaceLine(failure.words ?? '', { said: failure.said,
    retry: failure.again ? { 'data-f-again-act': '' } : undefined })}</div>`
    : `<p class="naming-said mac-subhead" role="status"><span>${esc(said)}</span></p>`)
  + button('Skip', { variant: 'plain', attrs: { 'data-f-skip': '' } });

/**
 * @param {object} card
 * @param {string} card.id
 * @param {string} card.faces
 * @param {string} card.field
 * @param {string} card.rows
 * @param {string} card.foot
 */
export const namingCard = ({ id, faces, field, rows, foot }) => `<div class="naming-page"><section class="naming-card ck-float"`
  + ` data-f-card="${esc(id)}">${faces}<div class="naming-answer"><h2 class="naming-question mac-title-1">Who is this?</h2>`
  + textField({ label: 'Who is this?', value: field, placeholder: 'Type a name',
    attrs: { id: 'face-name', 'aria-controls': 'face-rows' } })
  + `<div class="naming-rows ck-namerows" id="face-rows" role="listbox" aria-label="Who this is">${rows}</div>`
  + `<div class="naming-foot" id="face-foot">${foot}</div></div></section></div>`;

/**
 * @param {object} card
 * @param {string} card.id
 * @param {string} card.faces
 * @param {string} card.ask
 * @param {string} card.rows
 * @param {string} card.foot
 */
export const namingCheck = ({ id, faces, ask, rows, foot }) => '<div class="naming-page"><section class="naming-card ck-float is-check"'
  + ` data-f-card="${esc(id)}">${faces}<div class="naming-answer">${ask}`
  + `<div class="naming-rows ck-namerows" id="face-rows" role="listbox" aria-label="Your answer">${rows}</div>`
  + `<p class="naming-hint mac-subhead">${icon('photo', { size: 'xs' })}<span>Space shows the whole photo of the face under the pointer</span></p>`
  + `<div class="naming-foot" id="face-foot">${foot}</div></div></section></div>`;

/**
 * @param {object} stop
 * @param {string} stop.title
 * @param {{ name: string, photo: string }[]} [stop.named]
 * @param {string} [stop.line]
 * @param {string} stop.acts
 */
export const namingStop = ({ title, named = [], line = '', acts }) => '<div class="naming-page"><section class="naming-end ck-float">'
  + `<h1 class="naming-title mac-title-1">${esc(title)}</h1>`
  + (named.length ? '<div class="naming-named">' + named.map(each => '<span class="naming-person">'
    + personFace({ name: each.name, photo: each.photo, size: 'tile' })
    + `<span class="naming-person__name mac-headline">${esc(each.name)}</span></span>`).join('') + '</div>' : '')
  + (line ? `<p class="naming-line mac-body">${esc(line)}</p>` : '')
  + `<div class="naming-acts">${acts}</div></section></div>`;

/** @param {{ value: string, share: number } | null} progress */
export const namingReading = progress => '<div class="naming-page"><div class="naming-reading">'
  + icon('person', { size: 'xl' })
  + '<h1 class="mac-title-1">Reading your faces</h1>'
  + '<p class="mac-body">Finding the people in your photos.</p>'
  + (progress ? `<div class="naming-reading__meter">${meter('Reading your faces', progress.value, progress.share,
    { progress: true })}${waitLine()}</div>` : `<span class="sr-only">${loading('Reading your faces')}</span>`)
  + '</div></div>';
