// @ts-check
/** @import { Group, Person as PersonPage, Talk } from '../../pages.js' */
/** @import { PhotoPagesView } from '../../lib/photo-pages.js' */
import { attributes, esc } from '../../lib/html.js';
import { PHOTO_PAGE_SIZES } from '../../lib/photo-pages.js';
import {
  ARRIVES, bar, button, connected, counting, emptyState, inPlaceLine, factChip, factChips, icon, installWeekFigure, lines,
  menuButton, offer, offers, personFaceReading, photoGrid, photoGridReading, photoPager, rowsAcross, sectionLabel,
  sectionLabelReading, settingRow, settingsSection, shape, tag, thread, tileRow, waitLine, weekFigure,
} from '../kit/index.js';
import { clock, count, counted, dateWords, monthShort, rowDay, rowWhen, sinceWords, stampWhen, whenWords } from '../../lib/words.js';
import { birthdayChip, birthdayWords, profileGlyph } from '../../lib/details.js';
import { rowFace } from './list.js';
import { GROUP_WORDS, GROUPS_SHOWN, handleFrom, handleIcon, networkWords } from './words.js';

/**
 * @template T
 * @typedef {{ state: 'reading' } | { state: 'failed', message: string } | { state: 'read', value: T }} Read
 */

/** @typedef {{ said: import('../../lib/reach.js').Said, words: string }} ActFailed */

/**
 * @param {string} day
 * @param {string} today
 */
const weekWords = (day, today) => `${Number(day.slice(8, 10))} ${monthShort(day)}`
  + (day.slice(0, 4) === today.slice(0, 4) ? '' : ` ${day.slice(0, 4)}`);

/**
 * @param {string} label
 * @param {string} inner
 * @param {{ action?: string, arrives?: boolean, count?: number }} [options]
 */
const group = (label, inner, { action = '', arrives = false, count: many } = {}) => `<section class="pp-group${arrives
  ? ` ${ARRIVES}` : ''}">${sectionLabel(label, { action, count: many })}${inner}</section>`;

/** @param {string} lead */
const headReading = lead => `<header class="pp-head" aria-hidden="true">${lead}<div class="pp-head__titles">`
  + `<h1 class="pp-head__title mac-display">${bar(6)}</h1><p class="pp-head__line mac-body">${bar(7)}</p></div></header>`;

const groupHeadReading = () => headReading(`<span class="pp-tile56">${icon('meeting', { size: 'lg' })}</span>`);

/** @param {PersonPage['head']} head */
export const headLine = head => [head.relationship ?? '', head.work ?? ''].filter(Boolean).join(' · ');

/**
 * @param {PersonPage['head']['chips']} chips
 * @param {string} today
 */
export const headChips = (chips, today) => factChips(chips.map(chip => {
  if (chip.kind === 'profile') return factChip({ label: chip.words, glyph: profileGlyph(/** @type {import('../../lib/details.js').Network} */ (chip.network)), href: chip.href ?? '', title: chip.words });
  const birthday = { month: chip.month, day: chip.day, year: null };
  return factChip({ label: birthdayChip(birthday, today), glyph: 'calendar-event', title: birthdayWords(birthday) });
}));

/**
 * @param {PersonPage['head']} head
 * @param {string} today
 */
const personHead = (head, today) => {
  const line = headLine(head);
  return '<header class="pp-head">' + rowFace(head, 'hero')
    + '<div class="pp-head__titles">'
    + `<h1 class="pp-head__title mac-display${head.named ? '' : ' pp-unnamed'}">${esc(head.name)}</h1>`
    + (line ? `<p class="pp-head__line mac-body">${esc(line)}</p>` : '')
    + headChips(head.chips, today)
    + `</div>${button('Edit', { attrs: { 'data-people-edit': 'open' }, className: 'pp-head__edit' })}</header>`;
};

const WEEKS_LEAST = 26;

const NAMED = 8;

/** @param {number} many */
const messages = many => many === 1 ? 'message' : 'messages';

/**
 * @param {PersonPage['month']} month
 * @param {string} today
 */
const monthFoot = (month, today) => month.before ? `${month.line}${month.before.joiner}${weekWords(month.before.day, today)}` : month.line;

/**
 * @param {PersonPage | null} page
 * @param {string} today
 */
export function rhythm(page, today) {
  if (page === null) {
    return `<div class="pp-figure" aria-hidden="true">${weekFigure({ amount: null, words: 'messages · 30 days',
      label: 'Messages by week', bars: Array.from({ length: WEEKS_LEAST }, () => ({ count: 0, words: '', spoken: '' })),
      ends: ['', 'This week'] })}</div>`;
  }
  const { head, month, history } = page;
  const since = head.since ? sinceWords(head.since) : '';
  const label = `Messages with ${head.name}`;
  if (history.kind === 'years') {
    const bars = history.years.map(year => ({ count: year.count, words: `${messages(year.count)} · ${year.year}`,
      spoken: `${year.year}, ${counted(year.count, 'message')}`, attrs: year.day ? { 'data-people-day': year.day } : undefined }));
    return `<div class="pp-figure ${ARRIVES}" data-scale="years">${weekFigure({ amount: count(history.total),
      words: `${messages(history.total)}${since ? ` since ${since}` : ''}`, bars, marked: history.marked ?? -1, label: `${label} by year`,
      ...bars.length > NAMED ? { ends: /** @type {[string, string]} */ ([history.years[0].year, history.years.at(-1)?.year ?? '']) }
        : { labels: history.years.map(year => year.year) },
      foot: monthFoot(month, today) })}</div>`;
  }
  if (history.kind === 'facts') {
    const facts = [fact('Messages', count(history.total)), ...history.first ? [fact('First contact', weekWords(history.first, today))] : [],
      ...month.calls ? [fact('Calls · 30 days', count(month.calls.count))] : []].join('');
    return `<div class="pp-figure pp-figure--facts ${ARRIVES}" data-scale="none"><div class="pp-facts">${facts}</div></div>`;
  }
  const weeks = history.weeks;
  const bars = weeks.map((week, index) => {
    const now = index === weeks.length - 1;
    const when = now ? 'this week' : `week of ${weekWords(week.start, today)}`;
    return { count: week.count, words: `${messages(week.count)} · ${when}`,
      spoken: `${counted(week.count, 'message')} ${now ? 'this week' : `in the ${when}`}`,
      attrs: week.day ? { 'data-people-day': week.day } : undefined };
  });
  return `<div class="pp-figure ${ARRIVES}" data-scale="weeks">${weekFigure({ amount: count(month.count),
    words: `${messages(month.count)} · 30 days`, line: since ? `Since ${since}` : '', bars, marked: history.marked ?? -1,
    ends: [weeks[0] ? weekWords(weeks[0].start, today) : '', 'This week'], label: `${label} by week` })}</div>`;
}

/** @param {HTMLElement} root */
export const installRhythm = root => installWeekFigure(root);

/**
 * @param {Talk} talk
 * @param {string} today
 * @param {string} title
 */
export const talkHead = (talk, today, title) => ({ icon: talk.group ? 'meeting' : 'message', title,
  meta: [[talk.network, talk.group ? talk.title : ''].filter(Boolean).join(' · '), rowDay(talk.day, today)].filter(Boolean).join(' · ') });

const TALK_SHOWN = 4;

/**
 * @param {Talk | null} talk
 * @param {string} today
 * @param {{ person?: boolean }} [on]
 */
function lastTalkCard(talk, today, { person = false } = {}) {
  if (!talk) return '';
  const shown = talk.lines.slice(-TALK_SHOWN);
  const lines = shown.map((line, at) => ({ n: at, at: null, clock: clock(line.at_ms), speaker: line.name, mine: line.mine,
    words: line.text, forwarded: line.forwarded }));
  const last = shown.at(-1);
  const when = last ? stampWhen(talk.day, today, clock(last.at_ms)) : rowDay(talk.day, today);
  const line = [when, person && talk.group ? talk.title : talk.network].filter(Boolean).join(' · ');
  return `<section class="pp-group pp-talk ${ARRIVES}">${sectionLabel('Last talked', { action: button('Open conversation',
    { variant: 'plain', size: 'sm', attrs: { 'data-people-open': talk.day, 'data-people-focus': `a${last?.n ?? 0}` } }) })}`
    + `<p class="pp-talk__when mac-subhead">${esc(line)}</p>${thread(lines, { group: talk.group })}</section>`;
}

const TALK_SHAPES = /** @type {const} */ ([[false, 3], [false, 2], [true, 3]]);

const talkReading = () => '<section class="pp-group pp-talk" aria-hidden="true">'
  + sectionLabel('Last talked', { action: button('Open conversation', { variant: 'plain', size: 'sm', disabled: true }) })
  + `<p class="pp-talk__when mac-subhead">${bar(5)}</p><div class="ck-thread">`
  + TALK_SHAPES.map(([mine, width], at) => `<div class="ck-msg${mine ? ' is-mine' : ''}${at && mine !== TALK_SHAPES[at - 1][0] ? ' is-run' : ''}">`
    + `${shape({ className: `ck-msg__sk ck-msg__sk--${width} mac-body` })}</div>`).join('')
  + '</div></section>';

/**
 * @param {string} label
 * @param {string} value
 * @param {boolean} [mono]
 */
const fact = (label, value, mono = true) => `<div class="pp-fact mac-body"><span>${esc(label)}</span>`
  + `<span${mono ? ' class="mac-mono-data"' : ''}>${esc(value)}</span></div>`;

/**
 * @param {string} lead
 * @param {string} name
 * @param {string} line
 * @param {Record<string, string> | null} attrs
 * @param {{ quiet?: boolean, count?: number }} [end]
 */
export const sideRow = (lead, name, line, attrs, { quiet = false, count: many } = {}) => {
  const inner = `<span class="ck-side__icon" aria-hidden="true">${lead}</span><span class="ck-side__main">`
    + `<span class="ck-side__name mac-headline">${esc(name)}</span>`
    + (line || quiet
      ? `<span class="ck-side__line mac-subhead"><span>${esc(line)}</span>${quiet ? tag('Quiet') : ''}</span>` : '')
    + '</span>'
    + (many === undefined ? '' : `<span class="ck-side__count mac-mono-data">${count(many)}</span>`);
  const classes = `ck-side__row${quiet ? ' is-quiet' : ''}`;
  if (!attrs) return `<div class="${classes} pp-still">${inner}</div>`;
  return `<button${attributes({ type: 'button', class: classes, ...attrs })}>${inner}</button>`;
};

/**
 * @param {string} label
 * @param {string} inner
 */
const sideBox = (label, inner) => `<section class="ck-sidebox">${sectionLabel(label)}${inner}</section>`;

/**
 * @param {PersonPage['where']} where
 * @param {{ all: boolean, today: string, more: Record<string, string>, open: boolean }} view
 */
export function whereRows(where, { all, today, more: moreAttrs, open }) {
  let groups = 0;
  const shown = where.filter(each => all || !each.group || groups++ < GROUPS_SHOWN);
  const more = where.length - shown.length;
  return shown.map(each => sideRow(icon(each.chat === null ? 'mail' : each.group ? 'meeting' : 'message'), each.title,
    each.when ? whenWords(each.when, today) : '', open && each.group && each.chat ? { 'data-person': `chat:${each.chat}` } : null,
    { quiet: each.quiet, count: each.count })).join('')
    + (more ? sideRow('', `${count(more)} more ${more === 1 ? 'group' : 'groups'}`, '', moreAttrs) : '');
}

/**
 * @param {PersonPage} page
 * @param {boolean} all
 * @param {string} today
 */
export function personSide(page, all, today) {
  const calls = page.history.kind === 'facts' ? null : page.month.calls;
  const where = whereRows(page.where, { all, today, more: { 'data-people-groups': 'all' }, open: true });
  const whose = `<span class="pp-side-whose mac-subhead">From ${esc(page.head.name)}</span>`;
  return (calls === null ? '' : `<section class="ck-sidebox pp-calls"><div class="ck-side__rows">`
      + `${sideRow(icon('call'), 'Calls', 'Last 30 days', null, { count: calls.count })}</div></section>`)
    + (where ? `<section class="ck-sidebox">${sectionLabel('Where you talk', { action: whose })}`
      + `<div class="ck-side__rows">${where}</div></section>` : '');
}

/** @param {import('./words.js').PhotoFace} photo */
export const photoHash = photo => `sha256:${photo.image}`;

const photosReading = () => `<section class="pp-group" aria-hidden="true">${sectionLabel('Photos')}${photoGridReading(4)}</section>`;

/**
 * @param {string} name
 * @param {PhotoPagesView<import('./words.js').PhotoFace>} photos
 */
export function personPhotos(name, { total, page, size, photos, error }) {
  if (total === null && !error) return photosReading();
  if (total === null || (error && !photos)) return group('Photos', inPlaceLine(error, { retry: { 'data-people-photos': 'again' } }));
  if (!total) return '';
  const grid = photos ? photoGrid({ label: `${name}’s photos`, photos: photos.map((photo, at) => ({
    hash: photoHash(photo), attrs: { 'data-people-photo': String(page * size + at) },
    label: ['Photo', photo.at_ms === null ? '' : dateWords(photo.at_ms, { weekday: true })].filter(Boolean).join(', '),
  })) }) : photoGridReading(4, false, Math.min(size, total - page * size));
  const action = total > PHOTO_PAGE_SIZES[0] ? photoPager({ id: 'people-photos', page, total, size, sizes: PHOTO_PAGE_SIZES,
    resize: { 'data-people-photos-size': '' }, step: by => ({ 'data-people-photos': String(by) }) }) : '';
  return group('Photos', grid, { arrives: true, action, count: total });
}

/** @param {string | null} line */
const personSuggestions = line => line === null ? ''
  : `<button type="button" class="ck-sidebox pp-suggested ${ARRIVES}" data-people-edit="first">`
    + `<span class="mac-body">${esc(line)}</span><span class="pp-suggested__edit mac-body">Edit</span></button>`;

/** @param {{ said: string, act: string | null, undoing: boolean, failure: ActFailed | null } | null} saved */
export const savedLine = saved => {
  if (!saved) return '';
  if (saved.failure) {
    return `<div class="pp-saved">${inPlaceLine(saved.failure.words ?? '', { said: saved.failure.said, retry: saved.act ? { 'data-people-saved-undo': '' } : undefined })}</div>`;
  }
  return `<p class="pp-saved mac-subhead" role="status"><span>${esc(saved.said)}</span>`
    + (saved.act ? button('Undo', { variant: 'plain', size: 'sm', busy: saved.undoing, attrs: { 'data-people-saved-undo': '' } }) : '')
    + '</p>';
};

/**
 * @param {object} parts
 * @param {PersonPage} parts.page
 * @param {PhotoPagesView<import('./words.js').PhotoFace>} parts.photos
 * @param {string} parts.today
 * @param {boolean} [parts.groups]
 * @param {string} [parts.saved]
 */
export const personPage = ({ page, photos, today, groups = false, saved = '' }) =>
  '<div class="ck-page__body">'
  + `<div class="ck-page__main pp-main">${personHead(page.head, today)}${saved}`
  + (page.counting ? counting(talkReading() + rhythm(null, today) + photosReading())
    : lastTalkCard(page.talk, today, { person: true }) + rhythm(page, today) + personPhotos(page.head.name, photos))
  + '</div><aside class="ck-page__side ck-page__side--top pp-side" aria-label="Together">'
  + (page.counting ? '' : personSide(page, groups, today) + personSuggestions(page.suggestions_line))
  + '</aside></div>';

/** @param {PersonPage} page */
const yourHead = page => '<header class="pp-head">' + rowFace(page.head, 'hero') + '<div class="pp-head__titles">'
  + `<h1 class="pp-head__title mac-display">${esc(page.head.name)}</h1>`
  + (page.head.full_name ? `<p class="pp-head__line mac-body">${esc(page.head.full_name)}</p>` : '')
  + factChips(page.edit.also_called.map(also => factChip({ label: also.name, title: `${also.name} · ${also.from}` })))
  + `</div>${button('Edit', { attrs: { 'data-people-edit': 'open' }, className: 'pp-head__edit' })}</header>`;

/**
 * @param {object} parts
 * @param {PersonPage} parts.page
 * @param {PhotoPagesView<import('./words.js').PhotoFace>} parts.photos
 * @param {string} [parts.saved]
 */
export function yourPage({ page, photos, saved = '' }) {
  const handles = page.handles;
  const yours = handles.length ? group('Numbers and emails', rowsAcross(handles.map(handle => tileRow({
    icon: handleIcon(handle), value: handle.words, line: handleFrom(handle) })), 'Numbers and emails'), { count: handles.length })
    : '';
  return '<div class="ck-page__body">'
    + `<div class="ck-page__main pp-main">${yourHead(page)}${saved}`
    + (page.counting ? counting(`<section class="pp-group">${sectionLabelReading(4)}${lines(2)}</section>${photosReading()}`)
      : yours + personPhotos(page.head.name, photos))
    + '</div>'
    + '<aside class="ck-page__side ck-page__side--top pp-side" aria-hidden="true"></aside></div>';
}

/** @param {string} label */
const factReading = label => `<div class="pp-fact mac-body"><span>${esc(label)}</span><span class="mac-mono-data">${bar(1)}</span></div>`;

/**
 * @param {string} head
 * @param {string} parts
 * @param {string} [side]
 */
const pageReading = (head, parts, side = '') => '<div class="ck-page__body">'
  + `<div class="ck-page__main pp-main">${head}${parts}${waitLine()}</div><aside class="ck-page__side ck-page__side--top pp-side" aria-hidden="true">`
  + `${side}</aside></div>`;

/** @param {string} today */
export const personPageReading = today => pageReading(
  headReading(personFaceReading('hero')), talkReading() + rhythm(null, today));

export const groupPageReading = () => pageReading(groupHeadReading(), talkReading(),
  sideBox('Together', `<div class="pp-facts">${['Messages', 'Yours'].map(factReading).join('')}</div>`));

/**
 * @param {Group['head']} head
 * @param {string} today
 */
const quietWords = ({ quiet, why }, today) => [quiet ? 'Quiet now' : 'Not quiet', why && [why.words,
  why.since === null ? '' : why.since.kind === 'day' ? weekWords(why.since.day, today) : whenWords(why.since, today)].filter(Boolean).join(' ')]
  .filter(Boolean).join(' · ');

/**
 * @param {string} chat
 * @param {Group['head']} head
 * @param {string} today
 * @param {{ busy: boolean, failure: ActFailed | null, value?: string }} acting
 */
export function groupQuiet(chat, head, today, { busy, failure, value = '' }) {
  const word = GROUP_WORDS.find(each => each.value === head.word) ?? GROUP_WORDS[0];
  const end = menuButton({ id: `group-${chat}`, label: 'Quiet in this group', words: word.words, busy,
    attrs: { 'data-people-word': chat },
    choices: GROUP_WORDS.map(each => ({ value: each.value, words: each.words, chosen: each === word,
      default: each.quiet === null })) });
  const row = settingRow({ label: 'Quiet', line: quietWords(head, today), end,
    about: 'A quiet group is one line at the end of each day. A group goes quiet once you archive it, or stop '
      + 'writing in it for a while.' });
  return `<div class="pp-group pp-quiet-word">${settingsSection({ rows: [row] })}`
    + (failure ? inPlaceLine(failure.words ?? '', { said: failure.said, retry: { 'data-people-word-again': chat, 'data-value': value } }) : '') + '</div>';
}

/**
 * @param {string} chat
 * @param {Group} page
 * @param {string} today
 * @param {{ busy: boolean, failure: ActFailed | null, value?: string }} [acting]
 */
export function groupPage(chat, page, today, acting = { busy: false, failure: null }) {
  const { head } = page;
  const line = [head.line, head.since ? `since ${sinceWords(head.since)}` : ''].filter(Boolean).join(' · ');
  const top = '<header class="pp-head">'
    + `<span class="pp-tile56" aria-hidden="true">${icon('meeting', { size: 'lg' })}</span>`
    + '<div class="pp-head__titles">'
    + `<h1 class="pp-head__title mac-display">${esc(head.title)}</h1>`
    + `<p class="pp-head__line mac-body">${esc(line)}</p>`
    + '</div></header>';
  const facts = [fact('Messages', count(page.total)), ...(page.yours === null ? [] : [fact('Yours', page.yours)])].join('');
  const who = page.writers.slice(0, NAMED).map(writer => sideRow(rowFace(writer, 'sm'), writer.name, writer.share,
    { 'data-person': writer.id })).join('');
  return '<div class="ck-page__body">'
    + `<div class="ck-page__main pp-main">${top}${groupQuiet(chat, head, today, acting)}`
    + `${page.counting ? counting(talkReading()) : lastTalkCard(page.talk, today)}</div>`
    + `<aside class="ck-page__side ck-page__side--top pp-side" aria-label="The group">`
    + sideBox('Together', `<div class="pp-facts">${facts}</div>`)
    + (who ? sideBox('Who writes most', `<div class="ck-side__rows">${who}</div>`) : '')
    + '</aside></div>';
}

/**
 * @param {string} message
 * @param {boolean} chat
 */
export const pageFailed = (message, chat) => '<div class="ck-page__body"><div class="ck-page__main pp-main">'
  + (chat ? groupHeadReading() : headReading(personFaceReading('hero')))
  + inPlaceLine(message, { retry: { 'data-people-retry': 'person' } }) + '</div></div>';

const MESSAGES = 'messages';

/** @param {import('../../types.js').StreamsReport | null} report */
export function nobodyYet(report) {
  /** @param {boolean | null} set @param {string} id @param {boolean} primary */
  const end = (set, id, primary) => set === null ? '' : set ? connected('Connected')
    : button('Connect', { variant: primary ? 'primary' : 'secondary', attrs: { 'data-people-connect': id } });
  const streams = (report?.connectors ?? []).filter(each => each.type?.key === MESSAGES && each.shown === 'stream');
  const phone = !report ? null : report.devices.some(device => device.kind === 'phone' && !device.retired && device.pass !== null);
  return offers([...streams.map((each, at) => offer({ icon: each.icon, name: each.name, line: each.records,
    end: end(each.set_up, each.id, at === 0) })),
  offer({ icon: 'photos', name: 'iPhone', line: 'The people in your photos, once you name their faces.', end: end(phone, 'phone', false) })]);
}

export const nobodyThere = () => emptyState('person', 'This person is not in your messages any more.',
  { action: { label: 'Back to People', attrs: { 'data-person': '' } } });
