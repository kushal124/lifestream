// @ts-check
/** @import { ProviderNeed, Suggestion } from '../../lib/places.js' */
/** @import { Named } from '../../lib/place-naming.js' */
/** @import { Clock } from './rows.js' */
/** @import { Places, When } from '../../pages.js' */
import { attributes, esc } from '../../lib/html.js';
import { TYPED_MOST, whyWords } from '../../lib/place-naming.js';
import { dayAt } from '../../lib/home-clock.js';
import { dateWords, dayDate, sinceWords } from '../../lib/words.js';
import { circleLine } from '../kit/circle-editor.js';
import {
  ARRIVES, bar, button, inPlaceLine, icon, iconButton, listRow, listRows, nameCredit, nameField, nameRow, nameRowReading,
  noneLine, photoGrid, photoGridReading, questionCard, reachStepper, waitLine,
} from '../kit/index.js';

export const HIDDEN_SHOWN = 20;
const PHOTOS_SHOWN = 3;

/**
 * @param {{ at: number, of: number } | null} count
 * @param {string} [title]
 */
export const namingTop = (count, title = 'Name this place') => '<div class="pl-card__top pl-naming__top">'
  + `<div class="pl-naming__head"><h1 class="pl-naming__title mac-title-1">${esc(title)}</h1>`
  + (count ? `<span class="pl-naming__count mac-mono-data">${count.at} of ${count.of}</span>` : '')
  + iconButton('close', 'Close', { attrs: { 'data-pl-end': '' }, className: 'pl-naming__close' }) + '</div>'
  + '</div>';

const LEADS = /** @type {Record<string, string>} */ ({ calendar: 'calendar-event', messages: 'message', mail: 'mail',
  notes: 'note', money: 'money' });

/** @param {Suggestion} suggestion */
const leadOf = suggestion => suggestion.slug ? 'place' : LEADS[suggestion.why?.family ?? ''] ?? 'place';

/** @param {Suggestion[]} rows */
export const namePlaceholder = rows => rows[0]?.name ?? 'What you call it';

/**
 * @param {Suggestion[]} rows
 * @param {number} lit
 * @param {{ typed: string, last: number | null }} at
 */
export const nameRows = (rows, lit, { typed, last }) => rows.length
  ? rows.map((row, index) => nameRow({ lead: leadOf(row), lit: index === lit, attrs: { 'data-pl-take': index },
    name: row.name, line: whyWords(row, last) })).join('')
  : typed.trim() ? '' : noneLine('Type its name');

/**
 * @param {object} card
 * @param {string} card.key
 * @param {string} card.typed
 * @param {string} card.placeholder
 * @param {string | null} card.ask
 * @param {{ hash: string, label: string }[]} card.photos
 * @param {string} card.witnessed
 * @param {string} card.last
 * @param {{ metres: number, line: string } | null} card.reach
 * @param {string | null} card.rows
 * @param {boolean} card.credit
 * @param {string} card.error
 * @param {string} card.refused
 */
export function namingBody({ key, typed, placeholder, ask, photos, witnessed, last, reach, rows, credit, error, refused }) {
  const asked = ask ? questionCard({ title: 'Is this home?', line: ask, yes: 'Yes, it’s home',
    answer: yes => ({ 'data-pl-spot-home': String(yes) }), className: `pl-ask ${ARRIVES}` }) : '';
  if (ask) return `<div class="pl-naming pl-naming--home">${asked}</div>`;
  const grid = () => photoGrid({ fill: true, label: 'Photos of this place',
    photos: photos.slice(0, PHOTOS_SHOWN).map((photo, index) => ({ ...photo, attrs: { 'data-pl-spot-photo': index } })) });
  const pictures = photos.length ? grid() : '';
  const list = rows === null ? [0, 1, 2].map(nameRowReading).join('')
    : `${error ? inPlaceLine(error, { retry: { 'data-pl-retry-names': '' } }) : ''}${rows}`;
  return `<div class="pl-naming">${asked}${pictures}`
    + `<p class="pl-seen"><span class="pl-seen__line">${esc(witnessed)}</span>`
    + (last ? `<span class="pl-seen__last mac-mono-data">${esc(last)}</span>` : '') + '</p>'
    + `<form class="pl-name"${attributes({ id: 'place-name-form', 'data-pl-form': 'name', 'data-pl-spot': key })}>`
    + '<div class="pl-name__top"><label class="pl-name__label" for="place-name">Place name</label>'
    + '</div>'
    + nameField({ placeholder, value: typed, attrs: { name: 'name', id: 'place-name', 'aria-label': 'Place name',
      autofocus: true, maxlength: String(TYPED_MOST) } })
    + (refused ? inPlaceLine(`Not saved. ${refused}`) : '')
    + `<div class="ck-namerows" role="listbox" aria-label="Names for this place"><div data-pl-rows>${list}</div>`
    + `<div data-pl-credit>${credit ? nameCredit('Google') : ''}</div></div></form>`
    + `${reach ? namingReach(reach) : ''}</div>`;
}

/**
 * @param {boolean} skip
 * @param {ProviderNeed | null} [need]
 * @param {{ ready?: boolean, refused?: boolean, ask?: boolean }} [state]
 */
export const namingFoot = (skip, need = null, { ready = false, refused = false, ask = false } = {}) => '<div class="pl-naming__foot">'
  + button('Hide this place', { variant: 'plain', attrs: { 'data-pl-hide': '' }, className: 'pl-naming__hide' })
  + (skip ? button('Skip', { variant: 'plain', attrs: { 'data-pl-skip': '' } }) : '')
  + (ask ? '' : button(refused ? 'Retry saving' : 'Save name', { variant: 'primary', disabled: !ready, attrs: { 'data-pl-save-name': '' }, className: 'pl-naming__save' }))
  + '</div>' + (need && !ask ? `<p class="pl-naming__key mac-footnote">${esc(need.words)} · `
    + `<a${attributes({ href: `#dialog=${need.act.connector}` })}>${esc(need.act.label)}</a></p>` : '');

/** @param {{ metres: number, line: string }} reach */
export const namingReach = ({ metres, line }) => '<div class="pl-reach" role="group" aria-label="Where" data-pl-circle="0">'
  + '<span class="pl-reach__label mac-subhead">Radius</span>'
  + reachStepper({ metres, attrs: way => ({ 'data-pl-reach': String(way) }) }) + circleLine(line) + '</div>';

/**
 * @param {object} finish
 * @param {{ title: string, line: string }} finish.words
 * @param {Named[]} finish.named
 * @param {Clock} finish.at
 */
export function finishBody({ words, named, at }) {
  const year = Number(dayAt(at.now).day.slice(0, 4));
  const rows = named.slice(0, 3).map(place => listRow({ attrs: { 'data-pl-open': place.slug }, short: true,
    lead: { mark: '<span class="pl-lit"></span>' }, title: place.name, value: dayDate(place.day, { year }) })).join('');
  const more = named.length > 3 ? `<p class="pl-finish__more mac-body">and ${named.length - 3} more, now in your places</p>` : '';
  return `<div class="pl-finish ${ARRIVES}"><span class="pl-finish__mark" aria-hidden="true">${icon('done')}</span>`
    + `<div class="pl-finish__head"><h1 class="pl-finish__title mac-display">${esc(words.title)}</h1>`
    + `<p class="pl-finish__line mac-body">${esc(words.line)}</p></div>`
    + `<div class="pl-finish__named">${listRows(rows)}${more}</div></div>`;
}

export const finishFoot = () => '<div class="pl-naming__foot pl-naming__foot--done">'
  + `${button('Done', { variant: 'primary', key: '⏎', attrs: { 'data-pl-done': '' } })}</div>`;

/**
 * @param {When} when
 * @param {number} year
 */
const hiddenWhen = (when, year) => when.kind === 'at' ? dateWords(when.at_ms, { weekday: false, year })
  : when.kind === 'day' ? dayDate(when.day, { year }) : sinceWords(when);

/** @param {number} count */
export const hiddenTop = count => '<div class="pl-card__top"><div class="pl-card__nav">'
  + `<button type="button" class="pl-card__back ck-back mac-body" data-pl-back>${icon('back', { size: 'sm' })}<span>Places</span>`
  + '</button></div><div class="pl-card__titles">'
  + `<h1 class="pl-card__title mac-display">Hidden spots <span class="pl-card__count">${count.toLocaleString('en-US')}</span></h1>`
  + '<p class="pl-card__line mac-body">Hidden from Places, Timeline and naming.</p></div></div>';

/**
 * @param {object} page
 * @param {Places['hidden']} page.spots
 * @param {boolean} page.all
 * @param {Clock} page.at
 */
export function hiddenPage({ spots, all, at }) {
  if (!spots.length) return noneLine('No spot is hidden.');
  const year = Number(dayAt(at.now).day.slice(0, 4));
  const shown = all ? spots : spots.slice(0, HIDDEN_SHOWN);
  return `<div class="pl-hidden ${ARRIVES}">` + shown.map(spot => {
    const words = spot.line ?? '';
    const when = `Hidden ${hiddenWhen(spot.hidden, year)}`;
    return `<article${attributes({ class: 'pl-hidden__spot', 'data-pl-hidden': spot.key,
      'aria-label': [words, when].filter(Boolean).join(', ') })}>`
      + '<h2 class="pl-hidden__title">Unnamed spot</h2>'
      + `<p class="pl-hidden__line">${words ? `<span class="pl-hidden__words">${esc(words)}</span> · ` : ''}`
      + `<span class="pl-hidden__when">${esc(when)}</span></p>`
      + `${button('Unhide', { size: 'sm', attrs: { 'data-pl-unhide': spot.key } })}</article>`;
  }).join('')
    + (shown.length < spots.length ? button(`Show all ${spots.length.toLocaleString('en-US')}`,
      { attrs: { 'data-pl-hidden-all': '' } }) : '')
    + '</div>';
}

export const namingReading = () => `<div class="pl-naming" aria-hidden="true">${photoGridReading(3, true)}`
  + `<p class="pl-seen"><span class="pl-seen__line">${bar(7)}</span>`
  + `<span class="pl-seen__last mac-mono-data">${bar(4)}</span></p>`
  + `<div class="pl-name">${nameField({ placeholder: 'Type a name', waiting: true })}`
  + `<div class="ck-namerows">${[0, 1, 2].map(nameRowReading).join('')}</div></div>${waitLine()}</div>`;
