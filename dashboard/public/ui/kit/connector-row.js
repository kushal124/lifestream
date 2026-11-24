// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { button } from './button.js';
import { icon } from './icon.js';
import { signalShape } from './signal.js';
import { avatar, bar, iconSquare } from './skeleton.js';
import { sectionLabel } from './surface.js';
import HEALTH_STATES from './health-states.json' with { type: 'json' };

/** @typedef {import('../../lib/html.js').Attributes} Attributes */
/** @typedef {import('./signal.js').SignalKind} SignalKind */

/** @typedef {import('../../types.js').State} State */

const STATES = /** @type {Record<State, { signal: SignalKind | null, word: string | null }>} */ (HEALTH_STATES);

/** @type {Record<State, SignalKind | null>} */
export const STATE_LOOKS = /** @type {Record<State, SignalKind | null>} */ (Object.fromEntries(Object.entries(STATES)
  .map(([state, { signal }]) => [state, signal])));

/** @type {Record<State, string | null>} */
export const STATE_WORDS = /** @type {Record<State, string | null>} */ (Object.fromEntries(Object.entries(STATES)
  .map(([state, { word }]) => [state, word])));

/** @param {State} state */
export const stateShape = state => {
  const look = STATE_LOOKS[state];
  return look ? signalShape(look) : '';
};

/**
 * @typedef {object} ConnectorRowOptions
 * @property {string} name
 * @property {string} [icon]
 * @property {string} [face]
 * @property {{ icon: string, word: string }[]} places
 * @property {State} state
 * @property {string} [area]
 * @property {string} line
 * @property {string} [lead]
 * @property {boolean} [selected]
 * @property {Attributes} attrs
 * @property {'hover' | 'pressed' | 'focus'} [forced]
 * @property {{ label: string, busy: boolean, attrs: Attributes } | null} [act]
 */

/** @param {ConnectorRowOptions} row */
export const rowWords = ({ name, places, area = '', lead = '', line }) =>
  [name, ...places.map(place => place.word), area, [lead, line].filter(Boolean).join(' · ')].filter(Boolean).join(', ');

/**
 * @param {string} base
 * @param {{ selected?: boolean, forced?: string }} options
 */
const classes = (base, { selected = false, forced }) =>
  [base, selected ? 'is-selected' : '', forced ? `is-${forced}` : ''].filter(Boolean).join(' ');

/** @param {ConnectorRowOptions} row */
export function connectorRow(row) {
  const { name, icon: meaning = '', face = '', places, state, lead = '', line, selected = false, attrs, forced,
    act = null } = row;
  const second = stateShape(state) + (lead
    ? `<span class="ck-crow__words ck-crow__words--lead mac-mono-data"><span>${esc(line)}</span>`
      + `<span>${esc(lead)}</span></span>`
    : `<span class="ck-crow__words mac-mono-data">${esc(line)}</span>`);
  const look = classes(`ck-crow ck-crow--${state}`, { selected, forced });
  const opens = attributes({
    type: 'button', class: act ? 'ck-crow__open' : look, 'aria-label': rowWords(row),
    'aria-current': selected ? 'true' : null, ...attrs,
  });
  const inner = `<span class="ck-crow__icon" aria-hidden="true">${face || icon(meaning, { size: 'md' })}</span>`
    + '<span class="ck-crow__main" aria-hidden="true"><span class="ck-crow__names">'
    + `<span class="ck-crow__name mac-headline">${esc(name)}</span>`
    + places.map(place => `<span class="ck-crow__place">${icon(place.icon, { size: 'xs' })}</span>`).join('')
    + `</span><span class="ck-crow__line">${second}</span></span>`;
  if (!act) return `<button${opens}>${inner}</button>`;
  return `<div class="${look} ck-crow--act"><button${opens}>${inner}</button>${actOf(act, name)}</div>`;
}

/**
 * @param {{ label: string, busy: boolean, attrs: Attributes }} act
 * @param {string} name
 */
const actOf = (act, name) => button(act.label, { size: 'sm', busy: act.busy, className: 'ck-crow__act',
  attrs: { 'aria-label': `${act.label.replace(/…$/u, '')} ${name}`, ...act.attrs } });

const NAMES = /** @type {const} */ ([4, 3, 5, 3, 4]);
const LINES = /** @type {const} */ ([6, 7, 5, 7, 6]);

/**
 * @param {number} index
 * @param {'icon' | 'face' | 'none'} [lead]
 */
export const connectorRowReading = (index, lead = 'icon') => `<div class="ck-crow ck-crow--reading${lead === 'none'
  ? ' ck-crow--bare' : ''}" aria-hidden="true">`
  + (lead === 'none' ? '' : `<span class="ck-crow__icon">${lead === 'face' ? avatar() : iconSquare()}</span>`)
  + '<span class="ck-crow__main">'
  + `<span class="ck-crow__names"><span class="ck-crow__name mac-headline">${bar(NAMES, index)}</span></span>`
  + `<span class="ck-crow__line"><span class="ck-crow__words mac-mono-data">${bar(LINES, index)}</span></span>`
  + '</span></div>';

/**
 * @typedef {{ act: { label: string, busy: boolean, attrs: Attributes } } | { connect: string } | { state: State, word: string } | { last: string }} LineEnd
 */

/**
 * @typedef {object} ConnectorLineOptions
 * @property {string} name
 * @property {string} icon
 * @property {string} line
 * @property {string} place
 * @property {boolean} set_up
 * @property {LineEnd} end
 * @property {Attributes | null} opens
 * @property {boolean} [selected]
 * @property {boolean} [dim]
 * @property {'hover' | 'pressed' | 'focus'} [forced]
 */

/** @param {LineEnd} end */
const endWords = end => 'act' in end ? '' : 'connect' in end ? end.connect : 'word' in end ? end.word : end.last;

/**
 * @param {LineEnd} end
 * @param {string} name
 */
function lineEnd(end, name) {
  if ('act' in end) {
    return button(end.act.label, { size: 'sm', busy: end.act.busy, className: 'ck-cline__act',
      attrs: { 'aria-label': `${end.act.label.replace(/…$/u, '')} ${name}`, ...end.act.attrs } });
  }
  if ('connect' in end) return `<span class="ck-cline__connect mac-subhead" aria-hidden="true">${esc(end.connect)}</span>`;
  if ('word' in end) {
    return `<span class="ck-cline__state ck-cline__state--${end.state} mac-subhead" aria-hidden="true">${stateShape(end.state)}`
      + `<span>${esc(end.word)}</span></span>`;
  }
  return end.last ? `<span class="ck-cline__last mac-mono-data" aria-hidden="true">${esc(end.last)}</span>` : '';
}

/**
 * @param {string} line
 * @param {string} place
 */
const lineWithPlace = (line, place) => place ? [line.replace(/\.$/u, ''), place].filter(Boolean).join(' · ') : line;

/** @param {ConnectorLineOptions} row */
export function connectorLine({ name, icon: meaning, line, place, set_up, end, opens, selected = false, dim = false, forced }) {
  const said = [name, place, line, endWords(end)].filter(Boolean).join(', ');
  const named = opens
    ? `<button${attributes({ type: 'button', class: 'ck-cline__open', 'aria-label': said, 'aria-current': selected ? 'true' : null,
      ...opens })}><span class="ck-cline__name mac-headline" aria-hidden="true">${esc(name)}</span></button>`
    : `<span class="ck-cline__name mac-headline">${esc(name)}</span>`;
  return `<div class="${classes(`ck-cline${set_up ? '' : ' ck-cline--add'}${dim ? ' is-dim' : ''}`, { selected, forced })}">`
    + `<span class="ck-cline__icon" aria-hidden="true">${icon(meaning, { size: 'sm' })}</span>`
    + `<span class="ck-cline__words">${named}<span class="ck-cline__line"${opens ? ' aria-hidden="true"' : ''}>`
    + `${esc(lineWithPlace(line, place))}</span></span>`
    + `<span class="ck-cline__end">${lineEnd(end, name)}</span></div>`;
}

const LINE_NAMES = /** @type {const} */ ([4, 3, 5, 3, 4]);
const LINE_WORDS = /** @type {const} */ ([7, 6, 8, 5, 7]);

/** @param {number} index */
export const connectorLineReading = index => '<div class="ck-cline ck-cline--reading" aria-hidden="true">'
  + `<span class="ck-cline__icon">${iconSquare()}</span>`
  + `<span class="ck-cline__words"><span class="ck-cline__name mac-headline">${bar(LINE_NAMES, index)}</span>`
  + `<span class="ck-cline__line">${bar(LINE_WORDS, index)}</span></span>`
  + `<span class="ck-cline__end"><span class="ck-cline__last mac-mono-data">${bar(2)}</span></span></div>`;

/**
 * @param {{ name: string, count: number | null, rows: string, head?: string, attrs?: Attributes }[]} sections
 * @param {string} label
 */
export const connectorLines = (sections, label) => `<div class="ck-clines" aria-label="${esc(label)}">`
  + sections.map(section => `<section class="ck-clines__section"${attributes(section.attrs ?? {})}>`
    + (section.head ?? sectionLabel(section.name, { count: section.count })) + section.rows + '</section>').join('') + '</div>';
