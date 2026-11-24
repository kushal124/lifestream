// @ts-check
/** @import { Face, Filter, Page, SideRow } from './page.js' */
/** @import { Act } from './words.js' */
import { actKey } from './pending.js';
import { attributes, esc } from '../../lib/html.js';
import {
  inPlaceLine, ARRIVES, bar, button, connectorLine, connectorLineReading, connectorLines, copyValue, filterMenu, foldedStrips, icon, noneLine,
  sectionLabel, sectionLabelReading, stateShape, statusStrip, views, waitLine,
} from '../kit/index.js';
import { endOf } from './page.js';
import { ENTRY, PAGE, PLACES } from './words.js';
import { actWords } from '../../lib/reach.js';
import { SETTINGS_HOME } from './settings.js';
import { EDITOR_BUSY } from '../agents/detail.js';
import { answerKey } from '../../lib/agents.js';

/** @typedef {{ busy: ReadonlySet<string>, asking: string, notice: string, error: string, said?: import('../../lib/reach.js').Said, at?: string, label?: string, over?: object | null, done?: string }} View */

/** @type {View} */
export const AT_REST = { busy: new Set(), asking: '', notice: '', error: '', said: 'refused', at: '', label: '', over: null, done: '' };

/**
 * @param {View} view
 * @param {{ said: import('../../lib/reach.js').Said, words: string } | null} failure
 * @param {string} at
 * @param {string} label
 * @param {object | null} over
 */
export function refusing(view, failure, at, label, over) {
  view.error = failure ? actWords(failure) : '';
  view.said = failure?.said ?? 'refused';
  view.at = at;
  view.label = label;
  view.over = over;
}

/**
 * @param {View} view
 * @param {object | null} report
 */
export function landed(view, report) {
  if (!view.error || view.over === report) return;
  refusing(view, null, '', '', null);
}

/**
 * @param {Act | null} act
 * @param {View} view
 */
export const refusalAt = (act, view) => act && view.error && view.at === doAttrs(act)['data-cn-do'] ? view.error : '';

/** @param {Act} act */
export const doAttrs = act => 'copy' in act.do ? { 'data-cn-copy': act.do.copy, 'data-cn-label': act.label }
  : { 'data-cn-do': JSON.stringify(act.do), 'data-cn-label': act.label };

export const COPIED = 'Copied';

/**
 * @param {import('./page.js').Alert[]} alerts
 * @param {View} view
 * @param {{ open: boolean, copied: string }} fold
 */
export const alertsMarkup = (alerts, view, { open, copied }) => alerts.length ? `<div class="cn-alerts">${foldedStrips(alerts.map(alert => ({
  weight: alert.weight, title: alert.title, line: alert.line,
  actions: alert.act ? [{ label: copied && copied === alert.id ? COPIED : alert.act.label, busy: busyWith(alert.act, view),
    attrs: { ...doAttrs(alert.act), 'data-cn-alert': alert.id } }] : [],
  close: alert.dismiss ? { label: alert.dismiss.label, busy: busyWith(alert.dismiss, view), attrs: doAttrs(alert.dismiss) } : null,
})), { open, toggle: { 'data-cn-do': JSON.stringify({ fold: 'alerts' }) } })}</div>` : '';

/**
 * @param {string} connector
 * @param {string} member
 */
export const settingKey = (connector, member) => `setting:${connector}.${member}`;

/** @param {import('./words.js').Do} doing */
export const busyKey = doing => 'host' in doing ? actKey(doing.host, doing.holds)
  : 'edit' in doing || 'editor' in doing || 'since' in doing ? EDITOR_BUSY
    : 'answer' in doing ? answerKey(doing.answer) : JSON.stringify(doing);

/**
 * @param {Act} act
 * @param {View} view
 */
export const busyWith = (act, view) => act.busy === true || view.busy.has(busyKey(act.do));

/**
 * @param {Act} act
 * @param {View} view
 * @param {{ size?: 'md' | 'sm', className?: string }} [options]
 */
export const actButton = (act, view, { size = 'md', className = '' } = {}) => button(act.label, {
  variant: act.variant ?? 'secondary', tone: act.tone, size, busy: busyWith(act, view), disabled: act.disabled, key: act.keys ?? '',
  done: view.done && view.done === busyKey(act.do) ? 'Saved' : '', attrs: { ...doAttrs(act), ...act.keys ? { 'data-cn-keys': act.keys } : {} },
  className,
});

/**
 * @param {Face} face
 * @param {string} open
 * @param {View} view
 */
export function rowOf(face, open, view) {
  const end = endOf(face);
  return connectorLine({ name: face.name, icon: face.icon, line: face.line, place: face.places[0]?.word ?? '', set_up: face.set_up,
    end: 'act' in end ? { act: { label: end.act.label, busy: busyWith(end.act, view), attrs: doAttrs(end.act) } } : end,
    opens: face.opens === null ? null : { 'data-cn-open': face.opens }, selected: face.opens !== null && face.opens === open });
}

/**
 * @param {import('./page.js').Entry} entry
 * @returns {{ head: string, name: string, count: null, rows: string, attrs: Record<string, string> }}
 */
export const entrySection = entry => ({ head: '', name: ENTRY.name, count: null, attrs: { 'data-cn-area': 'adding' },
  rows: connectorLine({ name: ENTRY.name, icon: ENTRY.icon, line: ENTRY.line, place: '', set_up: false, end: { last: '' },
    opens: { 'data-cn-do': JSON.stringify({ fold: 'adding' }), 'aria-expanded': String(entry.open) } })
  + (entry.open ? `<div class="cn-entry">${copyValue({ value: entry.prompt, label: ENTRY.copy, line: true,
    attrs: { 'data-cn-copy': entry.prompt } })}</div>` : '') });

/**
 * @param {Page} page
 * @param {Filter} filter
 */
export const menusMarkup = (page, filter) => filterMenu({
  name: PAGE.where, all: PAGE.everywhere, value: filter.place, attrs: { 'data-cn-menu': 'place' }, waiting: !page.read,
  choices: PLACES.map(place => ({ value: place.key, label: place.word, icon: place.icon, count: page.placeCounts[place.key] })),
});

/** @param {Page} page */
const shownMarkup = page => `<div class="cn-shown">${views({ label: PAGE.title, value: page.shown, options: [
  { id: 'connected', label: PAGE.connected, count: page.shownCounts.connected, attrs: { 'data-cn-seg': 'connected' } },
  { id: 'not', label: PAGE.notConnected, count: page.shownCounts.not, attrs: { 'data-cn-seg': 'not', 'data-tour': 'more' } },
] })}</div>`;

/**
 * @param {Page} page
 * @param {Filter} filter
 */
const emptyWords = (page, filter) => page.shown === 'connected' && !filter.query.trim() && !filter.place ? PAGE.noneConnected : page.empty;

/** @param {View} view */
export const saidMarkup = view => view.error ? failureMarkup(view)
  : view.notice ? `<p class="cn-notice mac-body">${esc(view.notice)}</p>` : '';

/** @param {View} view */
export const failureMarkup = view => inPlaceLine(view.error ?? '', { said: view.said ?? 'refused',
  retry: view.at ? { 'data-cn-do': view.at, 'data-cn-label': view.label ?? '' } : undefined });

const READING_SECTIONS = [5, 4];

const READING_LABELS = /** @type {const} */ ([6, 3]);

const readingList = () => '<div aria-hidden="true">' + connectorLines(READING_SECTIONS.map((rows, at) => ({
  head: sectionLabelReading(READING_LABELS[at]), name: '', count: null,
  rows: Array.from({ length: rows }, (_, row) => connectorLineReading(at * READING_SECTIONS[0] + row)).join('') })), PAGE.title)
  + `</div>${waitLine()}`;

/**
 * @param {Page} page
 * @param {View} view
 * @param {string} open
 * @param {string} [failed]
 * @param {{ away?: boolean, alerts?: { open: boolean, copied: string }, filter?: Filter }} [options]
 */
export function bodyMarkup(page, view, open, failed = '', { away = false, alerts = { open: false, copied: '' }, filter = { query: '', place: '' } } = {}) {
  /** @param {Act} act */
  const acted = act => ({ label: act.label, busy: busyWith(act, view), attrs: doAttrs(act) });
  const banner = page.banner ? `<div class="cn-invite">${statusStrip({ icon: 'archive', title: page.banner.title,
    actions: [acted(page.banner.show)], close: acted(page.banner.close) })}</div>` : '';
  const sections = page.sections.map(section => ({ name: section.name, count: section.faces.length,
    rows: section.faces.map(face => rowOf(face, open, view)).join(''), attrs: { 'data-cn-area': section.key } }));
  const strips = alertsMarkup(page.alerts, view, alerts);
  if (!page.read) return `${strips}${failed || (away ? '' : readingList())}`;
  const lines = [...sections, ...page.entry ? [entrySection(page.entry)] : []];
  return `${strips}${banner}${shownMarkup(page)}<div class="cn-list ${ARRIVES}">${page.empty ? noneLine(emptyWords(page, filter)) : ''}`
    + `${lines.length ? connectorLines(lines, PAGE.title) : ''}</div>`;
}

const SIDE_LINES = /** @type {const} */ ([5, 6, 4, 6]);

/** @param {SideRow} row */
const stateWords = row => row.id !== SETTINGS_HOME || row.state !== 'ok' || !row.line || row.line.startsWith('Running') ? row.line ?? ''
  : row.line.startsWith('Checked ') ? `Running, checked ${row.line.slice('Checked '.length)}` : `Running · ${row.line}`;

/**
 * @param {SideRow} row
 * @param {number} index
 */
function sideRow(row, index) {
  if (row.wanted) {
    return `<button class="cn-device cn-device--wanted" type="button" data-cn-flow="${esc(row.wanted.flow)}" `
      + `aria-label="${esc(`${row.wanted.label} ${row.name}: ${row.line ?? ''}`)}">`
      + `<span class="cn-device__icon" aria-hidden="true">${icon(row.icon)}</span>`
      + `<span class="cn-device__words" aria-hidden="true"><span class="cn-device__name mac-headline">${esc(row.name)}</span>`
      + `<span class="cn-device__state cn-device__want mac-subhead">${esc(row.line ?? '')}</span></span>`
      + `<span class="cn-device__act ck-cline__connect mac-subhead" aria-hidden="true">${esc(row.wanted.label)}</span>`
      + '</button>';
  }
  const well = row.state === 'ok' || row.state === 'syncing';
  const said = stateWords(row);
  const words = row.line === null ? `<span class="cn-device__state mac-mono-data">${bar(SIDE_LINES, index)}</span>`
    : `<span class="cn-device__state mac-mono-data${row.reported.line ? ` ${ARRIVES}` : ''}">`
      + `${well ? '<span class="cn-device__live" aria-hidden="true"></span>' : row.state ? stateShape(row.state) : ''}<span>${esc(said)}</span></span>`;
  return '<button class="cn-device" type="button" '
    + `data-cn-open="${esc(row.id)}" `
    + `aria-label="${esc([row.name, said].filter(Boolean).join(', '))}">`
    + `<span class="cn-device__icon" aria-hidden="true">${icon(row.icon)}</span>`
    + `<span class="cn-device__words" aria-hidden="true"><span class="cn-device__name mac-headline">${esc(row.name)}</span>${words}</span></button>`;
}

/**
 * @param {Page} page
 * @param {boolean} [removed]
 */
export function sideMarkup(page, removed = false) {
  /** @param {SideRow[]} rows */
  const list = rows => `<div class="ck-side__rows">${rows.map((row, at) => sideRow(row, at)).join('')}</div>`;
  const home = page.side.filter(row => row.id === SETTINGS_HOME);
  const devices = page.side.filter(row => row.group === 'devices');
  const gone = page.side.filter(row => row.group === 'removed');
  const fold = gone.length ? `<div class="cn-removed"><button class="ck-side__fold mac-subhead" type="button" aria-expanded="${removed}" `
    + `data-cn-do="${esc(JSON.stringify({ fold: 'removed' }))}"><span class="ck-side__chevron" aria-hidden="true">${icon('expand', { size: 'xs' })}</span>`
    + `<span>${gone.length.toLocaleString('en-US')} removed</span></button>${removed ? list(gone) : ''}</div>` : '';
  return (home.length ? `<section class="ck-sidebox" aria-label="Lifestream">${list(home)}</section>` : '')
    + (devices.length ? `<section class="ck-sidebox" aria-label="Devices" data-tour="devices">${sectionLabel('Devices')}${list(devices)}${fold}</section>` : '');
}
