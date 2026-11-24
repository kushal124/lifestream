// @ts-check
/** @import { Flow, FlowAct, FlowGuide, FlowItem, FlowList, FlowNote, FlowReason, Piece, Spoken } from './model.js' */
import { attributes, esc } from '../../lib/html.js';
import {
  action, button, copyValue, dialog, groupRow, groupRowReading, icon, menuButton, plain, qrCode, rowGroup,
  settingRow, settingsSection, settingTile, status, tilesRow, waitLine,
} from '../kit/index.js';

/** @typedef {'step' | 'dialog'} Frame */

/**
 * @param {FlowAct} act
 * @param {{ after?: boolean }} [options]
 */
export function flowAction(act, { after = false } = {}) {
  if (act.href) {
    return button(act.label, { variant: act.variant, href: act.href,
      attrs: { 'data-arrive': act.variant === 'primary' ? 'primary' : null } });
  }
  return action(act.label, { state: act.state, done: act.result, why: act.why, after, variant: act.variant,
    ...act.waiting ? { waiting: act.waiting } : {},
    tone: act.tone === 'warning' ? 'warning' : 'neutral', disabled: act.disabled,
    attrs: act.key ? { 'data-flow': act.key, title: act.title || null,
      'data-arrive': act.variant === 'primary' ? 'primary' : null, ...act.data } : {} });
}

/** @param {Spoken} words */
const spoken = words => words.map(part => typeof part === 'string' ? esc(part)
  : `<span class="fl-code mac-mono-data">${esc(part.code)}</span>`).join('');

/**
 * @param {Piece} piece
 * @param {boolean} [held]
 * @returns {string}
 */
function pieceMarkup(piece, held = false) {
  if ('plain' in piece) return plain(piece.plain);
  if ('failed' in piece) return status('failed', piece.failed);
  if ('copy' in piece) {
    const { value, label, key } = piece.copy;
    return copyValue({ value, label, attrs: held ? {} : { 'data-flow': key } });
  }
  if ('field' in piece) {
    const field = piece.field;
    return `<form${attributes({ id: field.form, 'data-flow-form': field.kind, novalidate: true })}><input class="ck-field mac-body" type="text" `
      + `name="${esc(field.name)}" autocomplete="off" spellcheck="false"${attributes({ 'aria-label': field.label,
        placeholder: field.placeholder, value: field.value, 'data-flow': `${field.kind}-field`,
        'aria-invalid': field.invalid ? 'true' : null, disabled: field.disabled, title: field.title || null })}></form>`;
  }
  if ('scan' in piece) {
    const scan = piece.scan;
    return `<div class="ck-scan">${scan.label ? `<span class="ck-scan__plate">${qrCode(scan.qr, { label: scan.label })}</span>` : ''}`
      + '<div class="ck-scan__side">'
      + (scan.words.length ? `<p class="ck-scan__words mac-subhead">${spoken(scan.words)}</p>` : '')
      + (scan.turn ? flowAction(scan.turn) : '') + '</div></div>';
  }
  const menu = piece.menu;
  return menuButton({ id: menu.id, label: menu.label, words: menu.words, attrs: { 'data-flow-menu': 'browser' },
    choices: menu.choices.map(choice => ({ ...choice, default: false })) });
}

/** @param {Piece[]} body */
const bodyOf = body => body.map(piece => pieceMarkup(piece)).join('');

/** @param {NonNullable<FlowItem['part']>} part */
const partNumber = part => `<span${attributes({ class: `fl-num${part.open ? ' is-open' : ''}` })}>${part.number}</span>`;

/**
 * @param {FlowItem} item
 * @param {'' | 'river'} look
 */
const tilesOf = (item, look) => tilesRow(tileRows(item, look), `${item.name}’s connectors`);
/**
 * @param {FlowItem} item
 * @param {'river' | ''} look
 */
const tileRows = (item, look) => (item.tiles ?? []).map((tile, at) => groupRow({ id: tile.id, name: tile.name,
  icon: tile.icon, index: at, kind: 'words', line: tile.line, about: tile.about, end: status(tile.mark, tile.word), tile: true,
  look }));

/**
 * @param {FlowItem} item
 * @param {number} index
 * @param {{ lead?: boolean }} [options]
 * @returns {string[]}
 */
function sectionRows(item, index, { lead = true } = {}) {
  if (item.line === null) return [groupRowReading(index)];
  const part = item.part;
  const after = (/** @type {string} */ words) => words ? `<span class="ck-srow__line">${esc(words)}</span>` : '';
  const held = item.body.map(piece => pieceMarkup(piece, true)).join('');
  const ended = !item.act && item.beside !== null && 'menu' in item.beside;
  const faces = item.hold ? [...item.hold.faces, ...(item.why && item.line ? [{ line: item.line, after: item.after }] : [])]
    .filter(face => face.line).map(face => ({ line: face.line, holds: after(face.after) + held })) : [];
  const row = settingRow({ label: item.name,
    lead: !lead ? '' : part?.number ? partNumber(part) : item.icon ? settingTile(item.icon) : '',
    line: item.why || item.line, signal: item.why ? 'warning' : null,
    holds: after(item.after) + (item.beside && !ended ? pieceMarkup(item.beside) : '') + bodyOf(item.body)
      + (item.tiles?.length ? `<ul${attributes({ class: 'ck-tiles fl-tiles', 'aria-label': `${item.name}’s connectors` })}>`
        + `${tileRows(item, '').join('')}</ul>` : ''),
    end: (item.cancel ? flowAction(item.cancel) : '') + (item.act ? flowAction(item.act) : ended && item.beside ? pieceMarkup(item.beside) : ''),
    hold: item.hold ? { faces, end: item.hold.end } : null,
    go: part && !part.open ? { value: '', attrs: { 'data-flow': part.key, 'aria-expanded': 'false', 'aria-label': item.name } }
      : null,
    attrs: { class: part ? `fl-part${part.open ? ' is-open' : ''}` : '', 'data-item': item.id,
      'data-part': part ? item.id : null } });
  return [row];
}

/**
 * @param {FlowItem} item
 * @param {number} index
 * @returns {string[]}
 */
function stepRows(item, index) {
  if (item.line === null) return [groupRowReading(index)];
  const part = item.part;
  const sentence = (/** @type {string} */ words) => words ? `<span class="ck-grow__after ob-row-line">${esc(words)}</span>` : '';
  const row = groupRow({ id: item.id, name: item.name, icon: item.icon, index, kind: item.measured ? 'mono' : 'words',
    line: item.line,
    after: sentence(item.after),
    hold: item.hold ? { faces: item.hold.faces.map(face => ({ line: face.line, after: sentence(face.after) })),
      body: item.body.map(piece => pieceMarkup(piece, true)).join(''), end: item.hold.end } : null,
    why: item.why, body: bodyOf(item.body), beside: item.beside ? pieceMarkup(item.beside) : '',
    end: (item.cancel ? flowAction(item.cancel) : '') + (item.act ? flowAction(item.act) : ''), look: 'river',
    mark: part?.number ? partNumber(part) : '',
    press: part && !part.open ? { role: 'button', checked: false, label: item.name, attrs: { 'data-flow': part.key } }
      : null, className: part ? `fl-part${part.open ? ' is-open' : ''}` : '',
    attrs: { 'data-item': item.id, 'data-part': part ? item.id : null } });
  return item.tiles?.length ? [row, tilesOf(item, 'river')] : [row];
}

/**
 * @param {FlowList[]} lists
 * @param {Frame} frame
 */
const panels = (lists, frame) => lists.filter(list => list.items.length).map(list => frame === 'step'
  ? rowGroup(list.items.flatMap(stepRows), { attrs: { 'aria-label': list.label } })
  : settingsSection({ rows: list.items.flatMap((item, index) => sectionRows(item, index)), attrs: { 'aria-label': list.label } }))
  .join('');


/**
 * @param {Flow} flow
 * @returns {string[]}
 */
export const flowPageRows = flow => flow.lists.flatMap(list => list.items.flatMap((item, index) => sectionRows(item, index,
  { lead: false })));

/** @param {Flow} flow */
export const flowRows = flow => flow.lists.flatMap(list => list.items.flatMap(stepRows));

/** @param {FlowNote} note */
export const noteMarkup = note => `<p class="fl-note mac-subhead">${icon(note.icon, { size: 'sm' })}<span>${esc(note.words)}`
  + (note.link ? ` <a${attributes({ class: 'fl-note__link', href: note.link.href, target: '_blank',
    rel: 'noopener noreferrer' })}>${esc(note.link.label)}</a>` : '') + '</span></p>';

/** @param {FlowReason[]} reasons */
const reasonsMarkup = reasons => reasons.length ? `<ul class="fl-reasons">${reasons.map(reason => '<li class="fl-reason">'
  + `${icon(reason.icon, { size: 'sm' })}<span class="fl-reason__title mac-headline">${esc(reason.title)}</span>`
  + `<span class="fl-reason__line mac-subhead">${esc(reason.line)}</span></li>`).join('')}</ul>` : '';

/** @param {FlowGuide} guide */
const guideMarkup = guide => '<div class="fl-guide"><div class="fl-guide__code">'
  + (guide.get ? `<p class="fl-guide__get">${flowAction(guide.get)}</p>` : '')
  + (guide.failed ? status('failed', guide.failed) : `<span class="ck-scan__plate">${qrCode(guide.qr, { label: guide.label })}</span>`)
  + '</div>'
  + '<div class="fl-guide__side"><ol class="fl-guide__steps">' + guide.steps.map((step, at) => `<li${attributes({
    class: `fl-guide__step is-${step.state}`, 'aria-current': step.state === 'now' ? 'step' : null })}>`
    + `<span class="fl-guide__num" aria-hidden="true">${at + 1}</span>`
    + `<span class="mac-body">${esc(step.words)}</span></li>`).join('') + '</ol>'
  + (guide.typed.length ? `<p class="fl-guide__typed mac-subhead">${spoken(guide.typed)}</p>` : '') + '</div></div>';

/**
 * @param {Flow} flow
 * @returns {{ body: string, primary: string, aside: string, dialog: string }}
 */
export function flowStep(flow) {
  const asked = flow.question;
  const body = flow.say ? plain(flow.say) + panels(flow.lists, 'step') : panels(flow.lists, 'step') + (flow.note ? noteMarkup(flow.note) : '');
  return { body, primary: flow.primary ? flowAction(flow.primary) : '',
    aside: flow.aside ? flowAction(flow.aside, { after: true }) : '',
    dialog: asked ? dialog({ icon: asked.icon, title: asked.title, body: `<p class="mac-body">${esc(asked.line)}</p>`,
      foot: '<span></span>' + flowAction(asked.no) + flowAction(asked.yes),
      close: { 'data-flow': 'close' } }) : '' };
}

const DONE = /** @type {FlowAct} */ ({ label: 'Done', key: 'done', variant: 'primary', tone: '', state: 'idle', result: '',
  disabled: false, title: '', why: '', data: {}, href: '' });

/**
 * @param {Flow} flow
 * @param {{ back?: string, bare?: boolean, page?: boolean }} [options]
 */
export function flowDialog(flow, { back = '', bare = false, page = false } = {}) {
  const head = flow.head ? `<p class="fl-head">${status(flow.head.state, flow.head.words)}</p>` : '';
  const body = head + (flow.say ? plain(flow.say) + panels(flow.lists, 'dialog')
    : flow.question ? settingsSection({ rows: [settingRow({ label: flow.question.title,
      lead: settingTile(flow.question.icon), line: flow.question.line, attrs: { 'data-item': 'asking' } })],
    attrs: { 'aria-label': flow.title } })
      : panels(flow.lists, 'dialog') + reasonsMarkup(flow.reasons) + (flow.guide ? guideMarkup(flow.guide) : ''))
    + (flow.reading && !flow.question ? waitLine() : '')
    + (flow.note && !flow.question ? noteMarkup(flow.note) : '');
  const aside = flow.aside ? flowAction(flow.aside, { after: true })
    : flow.fine && !flow.question ? `<p class="fl-fine mac-subhead">${esc(flow.fine)}</p>` : '<span></span>';
  const foot = flow.question ? '<span></span>' + flowAction(flow.question.no) + flowAction(flow.question.yes)
    : flow.holds ? aside + flowAction(DONE)
      : flow.primary ? aside + flowAction(flow.primary) : flow.aside ? aside : '';
  return dialog({ icon: flow.icon, title: flow.title, line: flow.line, body: `<div class="fl-body" data-flow-root>${body}</div>`,
    foot, close: { 'data-flow': 'close' }, back: back ? { label: back, attrs: { 'data-flow': 'back' } } : null, bare, page });
}
