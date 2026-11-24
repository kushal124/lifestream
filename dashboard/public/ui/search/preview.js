// @ts-check
/** @import { SearchRow } from '../../pages.js' */
/** @import { PlaysCount } from './query.js' */
import { dayAt } from '../../lib/home-clock.js';
import { esc } from '../../lib/html.js';
import { familyWords } from '../../lib/kinds.js';
import { clock, count, counted, dateTitle, monthName, monthShort, rowDay, shiftMonth } from '../../lib/words.js';
import {
  ARRIVES, button, figureRowReading, listRow, listRows, listRowReading, matched, sectionLabel, thingLead, thingRow,
  weekFigure,
} from '../kit/index.js';
import { trackParams } from './filter-pills.js';
import { LISTENING, SCREEN } from './query.js';

const MONTHS_SHOWN = 12;

/**
 * @typedef {Extract<SearchRow, { kind: 'track' }>} TrackRow
 * @typedef {Extract<SearchRow, { kind: 'sitting' }>} SittingRow
 */

/**
 * @param {PlaysCount} answer
 * @param {string} name
 */
const column = (answer, name) => answer.columns.indexOf(name);

/**
 * @param {PlaysCount} answer
 * @param {string} name
 * @param {(string | number | boolean | null)[]} row
 */
const cell = (answer, name, row) => {
  const at = column(answer, name);
  const value = at < 0 ? null : row[at];
  return value === null || value === undefined ? '' : String(value);
};

/**
 * @param {PlaysCount} months
 * @returns {{ month: string, plays: number }[]}
 */
export const monthsOf = months => months.rows.map(row => ({ month: cell(months, 'month', row), plays: Number(cell(months, 'sum', row)) || 0 }))
  .filter(each => each.plays > 0).sort((a, b) => b.month.localeCompare(a.month));

/**
 * @param {PlaysCount} page
 * @returns {{ at: string, day: string, clock: string, app: string, album: string }[]}
 */
export const playsOf = page => page.rows.map(row => {
  const at = cell(page, 'time', row);
  return { at, day: at.slice(0, 10), clock: at.slice(11, 16), app: cell(page, 'app', row), album: cell(page, 'album', row) };
}).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

/**
 * @param {(params: URLSearchParams) => Promise<PlaysCount>} read
 * @param {URLSearchParams} params
 * @returns {Promise<PlaysCount>}
 */
export async function wholeCount(read, params) {
  const first = await read(params);
  const rows = [...first.rows];
  for (let next = first.next; next;) {
    const page = await read(new URLSearchParams({ cursor: next }));
    rows.push(...page.rows);
    next = page.next;
  }
  return { ...first, rows, next: null };
}

/**
 * @param {PlaysCount} answer
 * @param {{ artist: string | null }} track
 * @returns {PlaysCount}
 */
export function ownRows(answer, track) {
  if (track.artist || column(answer, 'artist') < 0) return answer;
  return { ...answer, rows: answer.rows.filter(row => cell(answer, 'artist', row) === '') };
}

/**
 * @param {(params: URLSearchParams) => Promise<PlaysCount>} read
 * @param {{ title: string, artist: string | null }} track
 * @param {{ month: string } | null} [month]
 */
export const trackCount = async (read, track, month = null) => ownRows(await wholeCount(read, trackParams(track, month)), track);

/**
 * @typedef {{ track: { title: string, artist: string | null }, months: PlaysCount | null, pages: PlaysCount[], oldest: PlaysCount | null, paging?: string,
 *   failed?: string }} TrackRead
 */

/**
 * @param {TrackRead} read
 * @param {string} today
 */
export function trackFacts({ track, months, pages, oldest }, today) {
  const held = months ? monthsOf(months) : [];
  const plays = pages.flatMap(playsOf);
  const first = oldest ? playsOf(oldest).at(-1) : plays.at(-1);
  const album = plays.find(play => play.album)?.album ?? '';
  const byMonth = new Map(held.map(each => [each.month, each.plays]));
  const now = today.slice(0, 7);
  const bars = Array.from({ length: MONTHS_SHOWN }, (_, at) => shiftMonth(now, at - MONTHS_SHOWN + 1)).map(month => {
    const n = byMonth.get(month) ?? 0;
    return { month, n };
  });
  return {
    plays: months ? held.reduce((sum, each) => sum + each.plays, 0) : null, album, list: plays, bars,
    first: first ? rowDay(first.day, today) : '', last: plays[0] ? rowDay(plays[0].day, today) : '',
    older: held.slice(pages.length).map(each => each.month), artist: track.artist ?? '',
  };
}

/**
 * @param {{ lead: string, title: string, line: string }} head
 */
const headOf = ({ lead, title, line }) => `<header class="sx-thing__head"><span class="sx-thing__lead" aria-hidden="true">${lead}</span>`
  + `<div class="sx-thing__names"><h2 class="sx-thing__title mac-title-2">${esc(title)}</h2>`
  + (line ? `<p class="sx-thing__line mac-body">${esc(line)}</p>` : '') + '</div></header>';

/**
 * @param {TrackRead} read
 * @param {string} today
 */
export function trackPage(read, today) {
  const facts = trackFacts(read, today);
  const head = headOf({ lead: thingLead.art(familyWords(LISTENING).icon), title: read.track.title,
    line: [facts.artist, facts.album].filter(Boolean).join(' · ') });
  if (facts.plays === null) return `<div class="sx-thing">${head}${figureRowReading()}${listRows(listRowReading(6, 3))}</div>`;
  const figure = weekFigure({
    amount: count(facts.plays), words: facts.plays === 1 ? 'play' : 'plays',
    line: [facts.first && `First ${facts.first}`, facts.last && `last ${facts.last}`].filter(Boolean).join(' · '),
    bars: facts.bars.map(each => ({ count: each.n, words: monthName(each.month),
      spoken: `${monthName(each.month)}, ${counted(each.n, 'play')}` })),
    labels: facts.bars.map(each => monthShort(`${each.month}-01`).slice(0, 1)),
    label: `${read.track.title}, plays a month`,
  });
  const rows = facts.list.map(play => listRow({ title: dateTitle(play.day, today), value: [play.clock, play.app].filter(Boolean).join(' · '),
    short: true, attrs: { 'data-search-play': play.day } })).join('');
  const more = read.failed ? `<p class="sx-unread mac-footnote">${esc(read.failed)}</p>`
    + button('Try again', { variant: 'plain', size: 'sm', attrs: { 'data-search-earlier': '' } })
    : facts.older.length ? button(read.paging ? 'Reading…' : 'Earlier', { variant: 'plain', size: 'sm', busy: Boolean(read.paging),
      attrs: { 'data-search-earlier': '' } }) : '';
  return `<div class="sx-thing ${ARRIVES}">${head}${figure}${sectionLabel('Plays')}${listRows(rows)}${more}</div>`;
}

/**
 * @param {SittingRow} sitting
 * @param {string} today
 */
export function sittingPage(sitting, today) {
  const at = sitting.when.kind === 'at' ? sitting.when.at_ms : null;
  const when = at === null ? '' : `${dateTitle(dayAt(at).day, today)} ${clock(at)}`;
  const head = headOf({ lead: thingLead.square(familyWords(SCREEN).icon), title: sitting.title,
    line: [familyWords(SCREEN).label, when].filter(Boolean).join(' · ') });
  const said = sitting.said ? `<p class="sx-thing__said mac-reading">${matched(sitting.said)}</p>` : '';
  const windows = sitting.windows.map((window, at) => {
    const time = window.when?.kind === 'at' ? clock(window.when.at_ms) : '';
    return thingRow({
      lead: thingLead.square(familyWords(SCREEN).icon), title: window.title, when: time, line: window.line ?? '',
      attrs: { 'data-search-window': at, 'aria-label': [window.title, window.app, time].filter(Boolean).join(', ') },
    });
  }).join('');
  const day = button('Open the day', { variant: 'secondary', size: 'sm', icon: 'days', attrs: { 'data-search-day': '' } });
  return `<div class="sx-thing ${ARRIVES}">${head}${said}`
    + (windows && sitting.windows_line ? sectionLabel(sitting.windows_line) : '')
    + (windows ? `<div class="ck-trows">${windows}</div>` : '')
    + `<div class="sx-thing__acts">${day}</div></div>`;
}

/**
 * @param {{ lead: string, title: string, line: string }} head
 * @param {string} open
 */
export const namedPage = (head, open) => `<div class="sx-thing ${ARRIVES}">${headOf(head)}<div class="sx-thing__acts">`
  + `${button(open, { variant: 'secondary', size: 'sm', attrs: { 'data-search-go': '' } })}</div></div>`;

/**
 * @param {string} words
 * @param {boolean} retry
 */
export const previewFailed = (words, retry) => `<div class="sx-thing"><p class="sx-unread mac-body">${esc(words)}</p>`
  + (retry ? button('Try again', { variant: 'plain', size: 'sm', attrs: { 'data-search-preview-retry': '' } }) : '') + '</div>';

/** @param {string} words */
export const previewNone = words => `<div class="sx-thing"><p class="sx-unread mac-body">${esc(words)}</p></div>`;
