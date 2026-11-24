// @ts-check
/** @import { Day, DayChapter, DayCount, DayName, DayRow, DayRun } from './pages.js' */
/** @import { FoldView } from './ui/days/fold.js' */
import { esc } from './lib/html.js';
import { sectionLabel } from './ui/kit/index.js';
import { monthPicker } from './ui/kit/month-picker.js';
import { dayBar } from './ui/days/head.js';
import { dayList, dayListReading, itemsOf } from './ui/days/fold.js';

/** @param {string} label @param {string} html @param {string} [className] */
const specimen = (label, html, className = '') => `<div class="gallery__specimen${className ? ` ${className}` : ''}">`
  + `<p class="gallery__label mac-mono-label">${esc(label)}</p>${html}</div>`;
/** @param {string} name @param {string} body */
const group = (name, body) => `<section class="gallery__group">${sectionLabel(name)}${body}</section>`;

/**
 * @param {string} bar
 * @param {string} list
 * @param {{ picker?: string, reading?: boolean }} [more]
 */
const frame = (bar, list, { picker = '', reading = false } = {}) => `<div class="gallery__page ck-page dy${reading ? ' ck-reading' : ''}">`
  + `<header class="ck-page__bar dy-bar">${bar}</header><div class="dy-body"><div class="dy-main"><div class="dy-day">${list}</div></div></div>`
  + (picker ? `<div class="dy-pickhost">${picker}</div>` : '') + '</div>';

const TODAY = '2026-10-23';
const PAST = '2026-10-21';
/** @param {string} clock @param {string} [on] */
const at = (clock, on = PAST) => Date.parse(`${on}T${clock}:00Z`);

/**
 * @param {string} key
 * @param {string} time
 * @param {string} icon
 * @param {string} name
 * @param {DayRun[]} words
 * @param {DayCount | null} [count]
 * @param {Partial<DayRow>} [more]
 * @returns {DayRow}
 */
const row = (key, time, icon, name, words, count = null, more = {}) => ({ key, kind: 'conversation', at_ms: time ? at(time) : null,
  end_ms: null, icon, name, note: '', words, count, quiet: false, focus: `u:gallery/${key}`, divider: null, ...more });
/** @param {string} text @returns {DayRun} */
const said = text => ({ type: 'text', text, tone: 'secondary', title: false });
/** @param {string} text @returns {DayRun} */
const quote = text => ({ type: 'quote', text });
/** @param {number} n @returns {DayCount} */
const sent = n => ({ kind: 'sent', count: n });
/** @param {string} text @returns {DayCount} */
const plain = text => ({ kind: 'words', text });

const ROWS = [
  row('e1', '09:41', 'message', 'Person A', [quote('On my way, ten minutes'), quote('Grabbing coffee first')], sent(4)),
  row('e2', '10:02', 'call', 'Person B', [said('You called')], plain('5 m'), { kind: 'call' }),
  row('e3', '10:20', 'work-mac', 'Mac', [{ type: 'list', items: ['Browser 16 m', 'Lifestream 11 m', 'Chat 1 m'] },
    { type: 'titles', items: ['Synthetic notes', 'Draft plan'] }], plain('38 m'), { kind: 'sitting' }),
  row('e4', '10:58', 'coding-agent', 'Claude Code', [quote('Fold every stay the first time a day is seen')], plain('17 prompts'),
    { kind: 'ai', note: 'lifestream' }),
  row('e5', '11:30', 'voice-note', 'Dictated', [quote('Remind me to call Person C about Saturday')], plain('2 dictations'),
    { kind: 'dictation', note: 'to Notes' }),
  row('e6', '11:42', 'search', 'Searched', [quote('synthetic bakery hours'), quote('tram 12 timetable')], plain('2 searches'),
    { kind: 'search' }),
  row('e7', '12:05', 'photos', 'Photos', [{ type: 'tiles', photos: ['photo-1', 'photo-2', 'photo-3', 'photo-4']
    .map((hash, n) => ({ item: hash, hash, at_ms: null, video: n === 2, duration_ms: n === 2 ? 42_000 : null, live: false })), more: 3 },
    said('at Corner Gym')], plain('7 photos'), { kind: 'photos' }),
  row('e8', '13:18', 'mail', 'Mail', [said('Sent'), quote('Synthetic plans for November')], null, { kind: 'mail_sent' }),
  row('e9', '13:40', 'listening', 'Music', [{ type: 'list', items: ['Artist A', 'Artist B'] }], plain('10 tracks'), { kind: 'listening' }),
  row('e10', '14:02', 'call-missed', 'Person D', [said('Missed call'), { type: 'text', text: 'not returned yet', tone: 'tertiary', title: false }],
    null, { kind: 'call' }),
];

/** @param {DayRow} each @returns {DayName} */
const named = each => ({ text: each.name, first_row: each.key, at_ms: each.at_ms });

/**
 * @param {string} key
 * @param {string} time
 * @param {string} name
 * @param {string} length
 * @param {DayRow[]} rows
 * @param {{ head?: Partial<NonNullable<DayChapter['head']>>, photos?: DayChapter['photos'], blocks?: DayChapter['blocks'] }} [more]
 * @returns {DayChapter}
 */
const stay = (key, time, name, length, rows, { head = {}, photos = [], blocks } = {}) => ({
  key, kind: 'stay', episode: key, start_ms: at(time), end_ms: at(time) + 3_600_000, folded: rows.length > 0,
  head: { title: name, line: null, place: null, stated_by: null, since_ms: null, icon: 'place', quiet: false, words: [], length, ...head },
  names: rows.filter(each => each.focus !== null).map(named), photos, divider: null,
  blocks: blocks ?? (rows.length ? [{ key: `${key}#run`, kind: 'run', start_ms: at(time), title: null, line: null, count: null,
    folded: false, rows, divider: null }] : []),
});

const PHOTOS = Array.from({ length: 9 }, (_, n) => ({ hash: `photo-${n}`, at_ms: null, alt: `Photo ${n + 1}`, video: false, duration_ms: null }));

/** @type {DayChapter} */
const MOVE = { key: 'm1', kind: 'move', episode: 'm1', start_ms: at('09:24'), end_ms: at('09:33'), folded: false, names: [], photos: [],
  blocks: [], divider: null, head: { title: 'Drive 1.5 km', line: null, place: null, stated_by: null, since_ms: null, icon: 'drive',
    quiet: false, words: [{ type: 'text', text: '0.9 km of it not recorded', tone: 'tertiary', title: false }], length: '9m' } };

/**
 * @param {string} key
 * @param {string} from
 * @param {string} to
 * @returns {DayChapter}
 */
const gap = (key, from, to) => ({ key, kind: 'gap', episode: null, start_ms: at(from), end_ms: at(to), folded: false, names: [],
  photos: [], blocks: [], divider: null, head: { title: 'Nothing recorded', line: null, place: null, stated_by: null, since_ms: null,
    icon: 'pause', quiet: true, words: [], length: null } });

/**
 * @param {Partial<Day>} more
 * @returns {Day}
 */
const dayOf = more => ({ position: '1:0', today: TODAY, day: PAST, state: 'ready', line: null, now_ms: null, updated_ms: null,
  all_day: [], chapters: [], also: null, plans: [], until_ms: null, now_divider: null, end_ms: null, before_home: null,
  side: { figures: [], located: false, places: [], people: [], groups: [], unreturned: [] }, ...more });

const folded = () => dayOf({
  all_day: [row('a1', '', 'calendar-event', 'Conference', [said('Calendar · all day')], null, { kind: 'event' })],
  chapters: [
    stay('stay-home', '04:00', 'Synthetic Home', '5h 24m', ROWS.slice(0, 2), { head: { since_ms: at('21:53', '2026-10-20') } }),
    MOVE,
    stay('stay-gym', '09:38', 'Corner Gym', '1h 13m', ROWS.slice(2, 7), { photos: PHOTOS }),
    gap('gap:2', '11:10', '13:10'),
    stay('stay-cafe', '13:10', 'Harbour Cafe', '2h 4m', [], { photos: PHOTOS.slice(0, 2) }),
  ],
  also: { folded: false, names: [], rows: [row('u1', '', 'money', 'Payment', [said('12.00 USD'), said('Shop A')], null, { kind: 'payment' })] },
  end_ms: at('04:00', '2026-10-22'),
});

/**
 * @param {string[]} open
 * @param {string[]} [hours]
 * @returns {FoldView}
 */
const view = (open, hours = []) => ({ open: new Map(open.map(key => [key, true])), hours: new Map(hours.map(key => [key, true])),
  selected: '', now: at('15:42', TODAY) });

const unnamed = () => dayOf({ chapters: [
  stay('stay-home', '07:10', 'Synthetic Home', '1h 50m', ROWS.slice(0, 2)),
  stay('stay-near', '09:00', 'Near Synthetic Home', '1h 20m', ROWS.slice(2, 4), { head: { line: '1.8 km away', quiet: true, place: 'spot:0.0001,0.03' } }),
  stay('stay-short', '10:40', 'Near Corner Gym', '24m', [], { head: { line: '2.9 km away', quiet: true } }),
  stay('stay-city', '11:30', 'Lisbon', '2h 5m', ROWS.slice(4, 6), { head: { quiet: true, place: 'spot:38.7223,-9.1393' }, photos: PHOTOS.slice(0, 3) }),
  stay('stay-hidden', '13:50', 'a hidden place', '45m', [], { head: { quiet: true } }),
  stay('stay-gym', '14:50', 'Corner Gym', '1h 13m', ROWS.slice(6, 8)),
] });

const dense = () => {
  const rows = Array.from({ length: 30 }, (_, n) => row(`d${n}`, `${String(9 + Math.floor(n / 10)).padStart(2, '0')}:${String((n % 10) * 5 + 2).padStart(2, '0')}`,
    'message', ['Person A', 'Group Alpha', 'Person B', 'Person C', 'Group Beta'][n % 5], [quote(n % 2 ? 'Sounds good' : 'See you there')],
    sent(1 + (n % 3))));
  const blocks = [0, 1, 2].map(h => ({ key: `stay-office#${h}`, kind: /** @type {const} */ ('hour'), start_ms: at(`${String(9 + h).padStart(2, '0')}:00`), title: null,
    line: 'Person A, Group Alpha, Person B and 2 others', count: sent(20 - h * 3), folded: true, rows: rows.slice(h * 10, h * 10 + 10),
    divider: null }));
  return dayOf({ chapters: [stay('stay-office', '09:00', 'Synthetic Office', '3h', rows, { blocks })] });
};

const today = () => dayOf({
  day: TODAY, now_ms: at('15:42', TODAY), updated_ms: at('15:42', TODAY), until_ms: at('18:30', TODAY), end_ms: at('04:00', '2026-10-24'),
  chapters: [{ ...stay('stay-today', '08:12', 'Synthetic Office', '', ROWS.slice(0, 3)), start_ms: at('08:12', TODAY), end_ms: null,
    head: { title: 'Synthetic Office', line: null, place: null, stated_by: null, since_ms: null, icon: 'place', quiet: false, words: [],
      length: null } }],
  plans: [row('p1', '', 'calendar-event', 'Dinner with Person A', [said('Calendar · accepted')], plain('2h'),
    { kind: 'event', at_ms: at('18:30', TODAY) })],
});

const PICKER = monthPicker({
  dates: new Map(['01', '02', '05', '06', '07', '09', '12', '13', '14', '15', '16', '19', '20', '21', '22', '23']
    .map((d, n) => [`2026-10-${d}`, 200 + ((n * 137) % 900)])),
  selected: PAST, today: TODAY, month: '2026-10', focused: PAST, first: '2026-01', last: '2026-10',
});

/**
 * @param {Day} day
 * @param {FoldView} shown
 */
const listOf = (day, shown) => dayList(day, itemsOf(day), shown);

export const days = () => [
  group('Days · the bar', [
    ['A past day of this year: no word, every control live', `<header class="ck-page__bar dy-bar">${dayBar({ day: PAST, today: TODAY, previous: '2026-10-20', next: '2026-10-22', picking: false })}</header>`],
    ['Today: the word, › and Today disabled', `<header class="ck-page__bar dy-bar">${dayBar({ day: TODAY, today: TODAY, previous: '2026-10-22', next: null, picking: false })}</header>`],
    ['While the day list has not named the day: bars, the controls waiting', `<header class="ck-page__bar dy-bar ck-reading">${dayBar({ day: '', today: TODAY, previous: null, next: null, picking: false })}</header>`],
  ].map(([label, html]) => specimen(label, html)).join('')),
  group('Days · the day folded, the first time it is seen', specimen('An all-day plan, a stay since the night before, a move, a stay with its names and photos, nothing recorded, a stay of photos alone, the dated records open in their words (Also that day), the day’s end',
    frame(dayBar({ day: PAST, today: TODAY, previous: '2026-10-20', next: '2026-10-22', picking: false }), listOf(folded(), view([]))))),
  group('Days · a stay open', specimen('Its rows on its ground, a row of every kind: a chat, a call, the Mac, a coding agent, a dictation, searches, photos, a mail, music, a missed call',
    frame(dayBar({ day: PAST, today: TODAY, previous: '2026-10-20', next: '2026-10-22', picking: false }), listOf(folded(), view(['stay-gym', 'stay-home']))))),
  group('Days · the hour fold', specimen('A stay over 12 rows in its hours, the second open',
    frame(dayBar({ day: PAST, today: TODAY, previous: '2026-10-20', next: '2026-10-22', picking: false }), listOf(dense(), view(['stay-office'], ['stay-office#1']))))),
  group('Days · today', specimen('The open stay with no end, the now row, when the day was last updated, a plan ahead on the dotted rail',
    frame(dayBar({ day: TODAY, today: TODAY, previous: '2026-10-22', next: null, picking: false }), listOf(today(), view(['stay-today']))))),
  group('Days · the pinned head', specimen('Scrolled inside an open stay: its head on the canvas under the bar, its hairline',
    frame(dayBar({ day: PAST, today: TODAY, previous: '2026-10-20', next: '2026-10-22', picking: false }),
      listOf(dense(), view(['stay-office'], ['stay-office#0'])).replace('dy-block--stay is-open', 'dy-block--stay is-open is-pinned')))),
  group('Days · a stay at a place you did not name', specimen('Its name a step quieter, its disc hollow, its line what '
    + 'it is near; "Name it" after a stay whose spot is worth naming, none after one that is not, a hidden place quiet',
    frame(dayBar({ day: PAST, today: TODAY, previous: '2026-10-20', next: '2026-10-22', picking: false }),
      listOf(unnamed(), view([]))), 'gallery__specimen--unnamed')),
  group('Days · while the day reads', specimen('Three folded stays and two moves of soft shapes, the wait’s line after them',
    frame(dayBar({ day: '', today: TODAY, previous: null, next: null, picking: false }), dayListReading(), { reading: true }))),
  group('Days · the month picker', specimen('Under the title: October, the 21st chosen, today the 23rd, each day’s mark by its fullness',
    frame(dayBar({ day: PAST, today: TODAY, previous: '2026-10-20', next: '2026-10-22', picking: true }), listOf(folded(), view([])),
      { picker: PICKER }))),
].join('');
