// @ts-check
/** @import { DayMoment, MomentRecord, MomentSource } from '../../pages.js' */
/** @import { Opened } from './viewers.js' */
import { attributes, esc } from '../../lib/html.js';
import { fetchLifeExtract, fetchLifeRecord } from '../../lib/api.js';
import { clock, clockSeconds, counted, duration, range, shortDay } from '../../lib/words.js';
import {
  ARRIVES, inPlaceLine, icon, inspector, installJsonTree, jsonTree, linkButton, linkChip, lines, reading, sectionLabel, sourceFold,
} from '../kit/index.js';
import { viewerOf } from './viewers.js';

/**
 * @param {DayMoment} moment
 * @param {Opened} opened
 */
const letterOf = (moment, opened) => opened.only === undefined || opened.only === null || moment.view.view !== 'mail'
  ? null : moment.view.letters[opened.only] ?? null;

/**
 * @param {string} day
 * @param {DayMoment} moment
 * @param {Opened & { day?: boolean, tools?: string, end?: string, faces?: ReadonlyMap<string, string> }} opened
 */
export function inspectorOf(day, moment, opened) {
  const alone = letterOf(moment, opened);
  const when = moment.untimed ?? (alone ? (alone.at_ms === null ? '' : clock(alone.at_ms))
    : moment.start_ms === null ? '' : range(moment.start_ms, moment.end_ms));
  const length = !alone && moment.length_ms !== null ? duration(moment.length_ms) : '';
  const meta = [moment.near ?? '', opened.day ? shortDay(day) : '', when, length, moment.products.join(', ')];
  const out = alone ? alone.record : moment.out ?? moment.record;
  const title = alone ? alone.subject || '(no subject)' : moment.title;
  return inspector({
    icon: moment.icon,
    title,
    meta,
    chips: chipsFor(moment, opened),
    tools: (opened.tools ?? '') + (out === null ? '' : 'href' in out ? outButton(out) : OUT_HOLDER) + (opened.end ?? ''),
    back: alone ? { label: moment.name, attrs: { 'data-d-mail': '' } } : undefined,
    body: `<div class="dy-v">${viewerOf(moment, opened)}</div>`,
    foot: sourceFold(sourceLines(moment.source), { 'data-d-source': moment.key }),
    close: { 'data-d-close': '', title: 'Close  esc' },
    label: title,
  });
}

/**
 * @param {DayMoment} moment
 * @param {Opened & { faces?: ReadonlyMap<string, string> }} opened
 */
export function chipsFor(moment, opened) {
  const alone = letterOf(moment, opened);
  const faces = opened.faces ?? new Map();
  const people = alone ? (alone.person ? [{ name: alone.person, person: alone.person_id }] : []) : moment.people;
  const chips = people.map(person => linkChip(person.name, { person: true, photo: person.person ? faces.get(person.person) ?? '' : '',
    attrs: { 'data-d-person': person.person ?? '', 'data-d-person-name': person.name } }));
  if (moment.place) chips.push(linkChip(moment.place.name, { icon: 'place', attrs: { 'data-d-place-unit': moment.place.unit } }));
  return chips.join('');
}

const OUT_HOLDER = '<span data-d-out hidden></span>';

/** @param {{ label: string, href: string }} open */
export const outButton = open => linkButton(open.label, open.href);

/**
 * @param {DayMoment} moment
 * @param {Opened} opened
 * @returns {MomentRecord | null}
 */
export function outRecord(moment, opened) {
  const alone = letterOf(moment, opened);
  return alone ? alone.record : moment.out ? null : moment.record;
}

/** @param {MomentSource} source */
function sourceLines(source) {
  const first = source.records[0];
  const total = source.records.length + source.more;
  const unit = source.units[0];
  const times = source.start_ms === null ? '' : `${clockSeconds(source.start_ms)}${source.end_ms === null ? '' : `–${clockSeconds(source.end_ms)}`}`;
  return [
    first ? first.source : unit ? `${unit.family} · ${unit.unit}` : '',
    first ? `${first.kind} · ${first.key}${total > 1 ? ` and ${total - 1} more` : ''}` : '',
    source.units.length > 1 || first ? `${counted(source.units.length, 'extract unit')} · ${counted(source.atoms, 'atom')}` : '',
    times,
  ].filter(Boolean);
}

/** @param {MomentSource} source */
function sourceList(source) {
  const chevron = icon('expand', { size: 'xs', className: 'dy-src__chevron' });
  const records = source.records.map(record => {
    const ref = { source: record.source, kind: record.kind, key: record.key };
    return `<li><details class="dy-src"${attributes({ 'data-d-record': JSON.stringify(ref) })}>`
      + '<summary class="dy-src__summary">'
      + `<span class="mac-mono-time">${record.at_ms === null ? '' : esc(clock(record.at_ms))}</span>`
      + `<span class="dy-src__name mac-mono-data">${esc(`${ref.kind} ${ref.key}`)}</span>`
      + `${chevron}</summary><div class="dy-src__body"></div></details></li>`;
  }).join('');
  const units = source.units.map(unit => `<li><details class="dy-src"${attributes({ 'data-d-extract': JSON.stringify(unit) })}>`
    + '<summary class="dy-src__summary"><span class="mac-mono-label">Unit</span>'
    + `<span class="dy-src__name mac-mono-data">${esc(`${unit.family} ${unit.unit}`)}</span>`
    + `${chevron}</summary><div class="dy-src__body"></div></details></li>`).join('');
  return (records ? `<section class="dy-src__group">${sectionLabel('Records', { level: 3 })}<ul class="dy-src__list">${records}</ul>`
    + (source.more > 0 ? `<p class="dy-src__more mac-subhead">and ${esc(counted(source.more, 'record'))} more</p>` : '') + '</section>' : '')
    + `<section class="dy-src__group">${sectionLabel('Extract units', { level: 3 })}<ul class="dy-src__list">${units}</ul></section>`;
}

/** @param {number | null | undefined} ms */
const instant = ms => typeof ms === 'number' ? new Date(ms).toISOString().replace('.000Z', 'Z') : '';

/** @param {{ source: string, kind: string, key: string }} ref */
async function recordView(ref) {
  const found = await fetchLifeRecord(ref);
  const version = found.version;
  const time = version ? [version.start_ms, version.end_ms].filter(ms => ms !== null).map(instant).join(' → ') : 'gone';
  return `<p class="dy-src__facts mac-mono-data">${esc(found.source)}<br>${esc(`${found.kind} · ${found.key}`)}<br>`
    + `${esc(time)}<br>stated ${esc(instant(found.head.stated_ms))}`
    + ` · ${esc(counted(found.history.length, 'statement'))}</p>`
    + jsonTree(JSON.stringify(found.version?.content ?? null), 2);
}

/** @param {{ family: string, unit: string }} ref */
async function extractView(ref) {
  const found = await fetchLifeExtract(ref);
  return `<p class="dy-src__facts mac-mono-data">${esc(`${found.family} · ${found.unit}`)}<br>`
    + `${esc([found.start_ms, found.end_ms].filter(ms => ms !== null).map(instant).join(' → '))}<br>`
    + `${esc(found.days.join(', '))}</p>`
    + jsonTree(JSON.stringify(found.content), 2);
}

/**
 * @param {HTMLElement} root
 * @param {(key: string) => DayMoment | null} find
 */
export function installInspector(root, find) {
  installJsonTree(root);
  root.addEventListener('toggle', event => {
    const details = /** @type {HTMLDetailsElement} */ (event.target);
    if (!details.open) return;
    if (details.dataset.dSource) {
      const body = /** @type {HTMLElement} */ (details.querySelector('.ck-source__body'));
      const found = find(details.dataset.dSource);
      if (found && !body.childElementCount) body.innerHTML = sourceList(found.source);
      return;
    }
    const record = details.dataset.dRecord;
    const extract = details.dataset.dExtract;
    if (!record && !extract) return;
    const body = /** @type {HTMLElement} */ (details.querySelector('.dy-src__body'));
    if (body.dataset.loaded) return;
    body.dataset.loaded = '1';
    body.innerHTML = lines(5, 'mac-mono-data');
    reading(body, true);
    const read = record ? recordView(JSON.parse(record)) : extractView(JSON.parse(/** @type {string} */ (extract)));
    read.then(html => {
      reading(body, false);
      body.innerHTML = `<div class="${ARRIVES}">${html}</div>`;
    }, error => {
      reading(body, false);
      delete body.dataset.loaded;
      body.innerHTML = inPlaceLine(/** @type {Error} */ (error).message);
    });
  }, true);
}
