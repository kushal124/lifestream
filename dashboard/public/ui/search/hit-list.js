// @ts-check
/** @import { Count, KindSection, Search, SearchKind, SearchRow, When } from '../../pages.js' */
import { attributes, esc } from '../../lib/html.js';
import { dayAt } from '../../lib/home-clock.js';
import { familyWords } from '../../lib/kinds.js';
import { clock, dateTitle, monthName, nearDay, rowDay } from '../../lib/words.js';
import {
  ARRIVES, icon, listRow, noneLine, sectionLabelReading, thingLead, thingRow, thingRowReading, waitLine,
} from '../kit/index.js';
import { countSpoken, countWords } from './filter-pills.js';
import { LISTENING, readingWords, SCREEN } from './query.js';

/** @typedef {{ key: string, thing: SearchRow }} Shown */

/** @typedef {{ rows: SearchRow[], next: string | null, unread: string, reading: string, nothing: string }} Page */

/** @typedef {{ today: string, dated?: boolean }} Words */

/** @param {string} words */
const plain = words => words.replace(/[«»]/gu, '');

/** @param {SearchRow} row */
export function keyOf(row) {
  switch (row.kind) {
    case 'date':
      return row.when.kind === 'month' ? `month:${row.when.month}` : row.when.kind === 'day' ? `day:${row.when.day}` : `at:${row.when.at_ms}`;
    case 'sitting':
      return row.key;
    default:
      return row.ref;
  }
}

/**
 * @param {When | null} when
 * @param {Words} words
 */
export function whenWords(when, { today, dated = false }) {
  if (!when) return '';
  if (when.kind === 'month') return monthName(when.month);
  if (when.kind === 'day') return rowDay(when.day, today);
  return rowDay(dayAt(when.at_ms).day, today, { clock: dated ? '' : clock(when.at_ms) });
}

/**
 * @param {SearchRow} row
 * @param {Words} words
 * @returns {{ lead: string, title: string, when: string, line: string }}
 */
export function rowWords(row, words) {
  switch (row.kind) {
    case 'person':
      return { lead: thingLead.face(row.name, row.picture), title: row.name, when: '', line: row.line ?? '' };
    case 'place':
      return { lead: thingLead.square('place'), title: row.name, when: '', line: row.line };
    case 'date': {
      if (row.when.kind !== 'day') return { lead: thingLead.square('days'), title: whenWords(row.when, words), when: '', line: '' };
      const title = dateTitle(row.when.day, words.today);
      const near = nearDay(row.when.day, words.today);
      return { lead: thingLead.square('days'), title, when: '', line: near === title ? '' : near };
    }
    case 'track':
      return { lead: thingLead.art(familyWords(LISTENING).icon), title: row.title, when: '', line: row.line };
    case 'sitting':
      return { lead: thingLead.square(familyWords(SCREEN).icon), title: row.title, when: whenWords(row.when, words), line: row.line ?? '' };
    case 'hit': {
      const lead = row.family === 'messages' ? thingLead.face(/\p{L}/u.test(row.title) ? row.title : null)
        : row.picture ? thingLead.picture(row.picture) : thingLead.square(familyWords(row.family).icon);
      return { lead, title: row.title, when: whenWords(row.when, words), line: row.line ?? '' };
    }
  }
}

/**
 * @param {Shown} shown
 * @param {number} at
 * @param {Words} words
 */
function row(shown, at, words) {
  const { lead, title, when, line } = rowWords(shown.thing, words);
  return thingRow({ lead, title, when, line, attrs: {
    'data-search-row': at, 'data-search-nav': '', 'aria-label': [title, when, plain(line)].filter(Boolean).join(', '),
  } });
}

/**
 * @param {{ label: string, n?: Count | null, see?: string, unread?: string | null }} head
 * @param {string} rows
 */
function section({ label, n = null, see = '', unread = '' }, rows) {
  const all = see ? `<button${attributes({ type: 'button', class: 'sx-see mac-subhead', 'data-search-see': see,
    'aria-label': `See all ${label}` })}>See all${icon('forward', { size: 'xs' })}</button>` : '';
  const count = countWords(n);
  return `<section class="sx-kind ${ARRIVES}"><div class="sx-kind__head"><h2${attributes({ class: 'sx-kind__label mac-headline',
    'aria-label': count ? `${label}, ${countSpoken(n)}` : null })}>${esc(label)}`
    + (count ? `<span class="sx-kind__count">${esc(count)}</span>` : '') + `</h2>${all}</div>`
    + (rows ? `<div class="ck-trows">${rows}</div>` : '')
    + (unread ? `<p class="sx-unread mac-footnote">${esc(unread)}</p>` : '') + '</section>';
}

/**
 * @param {Search} answer
 * @param {Words} words
 * @returns {{ markup: string, shown: Shown[] }}
 */
export function kindsList(answer, words) {
  /** @type {Shown[]} */
  const shown = [];
  /** @param {SearchRow[]} rows */
  const drawn = rows => rows.map(thing => {
    const one = { key: keyOf(thing), thing };
    shown.push(one);
    return row(one, shown.length - 1, words);
  }).join('');
  const top = answer.top.length ? section({ label: 'Top hits' }, drawn(answer.top)) : '';
  const kinds = answer.kinds.map((/** @type {KindSection} */ kind) => section({ label: kind.title, n: kind.count,
    see: kind.see ? kind.family : '', unread: kind.unread }, drawn(kind.rows))).join('');
  return { markup: `<div class="sx-list">${top}${kinds}</div>`, shown };
}

/**
 * @param {Count | null} upcoming
 * @param {boolean} chosen
 */
export function upcomingRow(upcoming, chosen) {
  const attrs = { 'data-search-upcoming': '', 'data-search-nav': '' };
  if (chosen) return listRow({ title: 'Up to today', chevron: true, short: true, attrs });
  if (upcoming === null) return '';
  return listRow({ title: 'Upcoming', value: countWords(upcoming), chevron: true, short: true, attrs,
    label: `Upcoming, ${countSpoken(upcoming)}` });
}

/**
 * @param {SearchKind} read
 * @param {string} today
 * @returns {Page}
 */
export const seePage = (read, today) => ({ rows: read.rows, next: read.next, unread: read.unread ?? '',
  reading: readingWords(read.reading, today), nothing: read.nothing ?? '' });

/** @param {string} words */
export const nothingMatches = words => noneLine(words);

/**
 * @param {Page} page
 * @param {Words} words
 * @param {{ upcoming?: Count | null, chosen?: boolean }} options
 * @returns {{ markup: string, shown: Shown[] }}
 */
export function seeAllList({ rows, unread, reading, nothing }, words, { upcoming = null, chosen = false }) {
  const shown = rows.map(thing => ({ key: keyOf(thing), thing }));
  const said = unread ? `<p class="sx-unread mac-footnote">${esc(unread)}</p>` : '';
  const still = reading ? `<p class="sx-note mac-footnote">${esc(reading)}</p>` : '';
  const head = upcomingRow(upcoming, chosen);
  if (!shown.length && !head && !said) {
    return { markup: `<div class="${ARRIVES}">${nothing ? nothingMatches(nothing) : ''}${still}</div>`, shown };
  }
  const drawn = shown.length
    ? `<div class="ck-trows">${shown.map((one, at) => row(one, at, { ...words, dated: true })).join('')}</div>` : '';
  return { markup: `<div class="sx-list"><section class="sx-kind">${head}${said}${drawn}${still}</section></div>`, shown };
}

/** @typedef {'recent' | 'reading' | 'building' | 'lack' | 'waiting' | 'nothing' | 'date' | 'kinds'} ListState */

/**
 * @param {{ words: string, kinds: Search | null, answer: 'none' | 'found' | 'lack' | 'waiting' }} at
 * @returns {ListState}
 */
export function listState({ words, kinds, answer }) {
  if (!words.trim()) return 'recent';
  if (kinds?.reading?.state === 'building' && !kinds.top.length && !kinds.kinds.length) return 'building';
  if (kinds) return kinds.kinds.length || kinds.top.some(each => each.kind !== 'date') ? 'kinds' : kinds.top.length ? 'date' : 'nothing';
  return answer === 'none' || answer === 'found' ? 'reading' : answer;
}

/**
 * @param {ListState} state
 * @param {{ family: string, time: string }} chosen
 */
export const chipsShown = (state, chosen) => state === 'kinds' || state === 'reading' || state === 'lack' || state === 'waiting'
  || ((state === 'nothing' || state === 'date') && Boolean(chosen.family || chosen.time));

const READING_ROWS = 6;

export const hitListReading = () => `<div class="sx-list" aria-hidden="true"><section class="sx-kind">${sectionLabelReading(3)}`
  + `<div class="ck-trows">${Array.from({ length: READING_ROWS }, (_, at) => thingRowReading(at)).join('')}</div>`
  + `</section></div>${waitLine()}`;
