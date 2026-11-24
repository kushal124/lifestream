// @ts-check
/** @import { DayCount, DayName, DayRow, DayRun, Tile } from '../../pages.js' */
import { attributes, esc } from '../../lib/html.js';
import { clock, count } from '../../lib/words.js';
import { pictureUrl } from '../../lib/api.js';
import { icon } from './icon.js';
import { videoLabel } from './video.js';

const JOIN = '<span class="dy-w__join" aria-hidden="true"> · </span>';

/** @param {DayRun[]} words */
export function wordsOf(words) {
  return words.map((part, index) => {
    const before = words[index - 1];
    const join = !before || (before.type === 'quote' && part.type === 'quote') ? ''
      : before.type === 'text' && before.title ? AFTER_TITLE : JOIN;
    return join + run(part);
  }).join('');
}

const AFTER_TITLE = '<span class="dy-w__join" aria-hidden="true" data-after-title hidden> · </span>';

/** @param {DayRun} part */
function run(part) {
  switch (part.type) {
    case 'text':
      return `<span class="dy-w dy-w--${part.tone}" data-w="text"${part.title ? ' data-title hidden' : ''}>${esc(part.text)}</span>`;
    case 'span':
      return `<span class="dy-w dy-w--${part.tone}" data-w="text">${esc(spanWords(part))}</span>`;
    case 'quote':
      return `<span class="dy-w dy-w--quote mac-voice" data-w="quote">“${esc(part.text)}”</span>`;
    case 'list':
    case 'titles':
      return `<span class="dy-w dy-w--${part.type === 'titles' ? 'tertiary' : 'secondary'}" data-w="${part.type}">`
        + part.items.map((item, at) => `${at ? '<span class="dy-w__comma">, </span>' : ''}<span data-i>${esc(item)}</span>`).join('')
        + '</span>';
    case 'tiles':
      return '<span class="dy-w dy-w--tiles" data-w="tiles">' + part.photos.map(tile).join('')
        + (part.more ? `<span class="dy-w__more dy-w--tertiary">+${part.more}</span>` : '') + '</span>';
  }
}

/** @param {Extract<DayRun, { type: 'span' }>} span */
const spanWords = span => [span.text, `${clock(span.start_ms)}–${clock(span.end_ms)}`].filter(Boolean).join(' ');

/** @param {Tile} photo */
const tile = photo => {
  const img = (/** @type {string} */ className, alt = '') => `<img${attributes({ class: `ck-pic ${className}`,
    'data-src': pictureUrl(photo.hash, 'tile'), alt, decoding: 'async', draggable: 'false' })}>`;
  if (!photo.video) return img('dy-w__tile', photo.live ? 'Live Photo' : '');
  const label = videoLabel(photo.duration_ms);
  return `<span${attributes({ class: 'dy-w__tile dy-w__tile--video', role: 'img', 'aria-label': label })}>` + img('dy-w__poster')
    + `<span class="dy-w__play ck-night" aria-hidden="true">${icon('play', { size: 'xs', fill: true })}</span></span>`;
};

/** @param {DayCount | null} counted */
export const countOf = counted => !counted ? '' : `<span class="dy-c">${counted.kind === 'words' ? ''
  : icon('message', { size: 'xs' })}<span>${esc(counted.kind === 'words' ? counted.text : count(counted.count))}</span></span>`;

/**
 * @param {string} time
 * @param {DayRow} row
 */
export function rowLabel(time, row) {
  const said = row.words.map(part => part.type === 'text' ? part.title ? '' : part.text : part.type === 'quote' ? part.text
    : part.type === 'span' ? spanWords(part) : part.type === 'tiles' ? '' : part.items.join(', ')).filter(Boolean);
  const messages = (/** @type {number} */ n, /** @type {string} */ way) => `${count(n)} ${n === 1 ? 'message' : 'messages'} ${way}`;
  const tally = !row.count ? '' : row.count.kind === 'words' ? row.count.text : messages(row.count.count, row.count.kind);
  return [time, row.name, ...said, tally].filter(Boolean).join(', ');
}

/**
 * @param {string} time
 * @param {string} [className]
 */
const timeOf = (time, className = '') => `<span class="dy-row__time mac-mono-time${className}" data-c="time">${esc(time)}</span>`;

/**
 * @param {'row' | 'move' | 'hour' | 'now' | 'divider' | 'dayEnd'} kind
 * @param {object} row
 * @param {DayRow} [row.row]
 * @param {string} [row.time]
 * @param {boolean} [row.plan]
 * @param {boolean} [row.allDay]
 * @param {boolean} [row.selected]
 * @param {string} [row.block]
 * @param {{ key: string, time: string, line: string, sent: number, open: boolean }} [row.hour]
 * @param {{ time: string, updated: string }} [row.now]
 * @param {{ date: string }} [row.divider]
 * @param {{ time: string, next: string }} [row.end]
 * @param {{ key: string, open: boolean, names: DayName[] }} [row.opens]
 */
export function dayRow(kind, { row, time = '', plan = false, allDay = false, selected = false, block = '', hour, now, divider, end, opens } = {}) {
  switch (kind) {
    case 'now': {
      const shown = /** @type {NonNullable<typeof now>} */ (now);
      const { updated } = shown;
      return `<div class="dy-row dy-row--now" data-k="now"${attributes({ 'aria-label': `Now, ${shown.time}${updated
        ? `, updated ${updated}` : ''}` })}>`
        + timeOf(shown.time, ' dy-row__time--now')
        + '<span class="dy-row__mark dy-nowbox" aria-hidden="true"><svg class="dy-now ck-breath" viewBox="0 0 22 22"><circle class="dy-now__breath" cx="11" cy="11" r="10"/></svg>'
        + '<svg class="dy-now" viewBox="0 0 22 22"><circle class="dy-now__ring" cx="11" cy="11" r="10"/><circle class="dy-now__disc" cx="11" cy="11" r="7"/></svg></span>'
        + '<span class="dy-row__name dy-row__name--now mac-headline" data-c="name">Now</span>'
        + `<span class="dy-row__count mac-body" data-c="count">${updated ? `Updated ${esc(updated)}` : ''}</span>`
        + '</div>';
    }
    case 'divider': {
      const shown = /** @type {NonNullable<typeof divider>} */ (divider);
      return '<div class="dy-row dy-row--divider" data-k="divider" role="separator">'
        + timeOf('00:00') + '<span class="dy-divider__rule" aria-hidden="true"></span>'
        + `<span class="dy-row__span mac-headline" data-c="name"><span class="dy-divider__date">${esc(shown.date)}</span></span></div>`;
    }
    case 'dayEnd': {
      const shown = /** @type {NonNullable<typeof end>} */ (end);
      return '<div class="dy-row dy-row--end" data-k="end">' + timeOf(shown.time)
        + `<span class="dy-row__span mac-body" data-c="name"><span class="dy-w--tertiary">${esc(shown.next.split(' ')[0])} begins</span></span></div>`;
    }
    case 'hour': {
      const shown = /** @type {NonNullable<typeof hour>} */ (hour);
      const names = shown.line;
      return `<button${attributes({ type: 'button', class: `dy-row dy-row--hour${shown.open ? ' is-open' : ''}`, 'data-k': 'hour',
        'data-d-hour': shown.key, 'data-d-block': block, 'data-d-nav': '', 'aria-expanded': String(shown.open), tabindex: '-1',
        'aria-label': `${shown.time}, ${names}${shown.sent ? `, ${shown.sent} ${shown.sent === 1 ? 'message' : 'messages'} sent` : ''}` })}>`
        + timeOf(shown.time)
        + `<span class="dy-row__icon dy-caret" data-c="icon">${icon('forward')}</span>`
        + `<span class="dy-row__span mac-body" data-c="name" data-d-fit="words"><span class="dy-w dy-w--secondary" data-w="text">${esc(names)}</span></span>`
        + `<span class="dy-row__count mac-mono-data" data-c="count">${shown.sent ? countOf({ kind: 'sent', count: shown.sent }) : ''}</span>`
        + '</button>';
    }
    case 'move': {
      const shown = /** @type {DayRow} */ (row);
      const tag = opens ? 'button' : 'div';
      const names = opens && !opens.open && opens.names.length
        ? `<span class="dy-w dy-w--secondary dy-move__names mac-body" data-w="list">${opens.names
          .map((name, at) => `${at ? '<span class="dy-w__comma">, </span>' : ''}<span data-i>${esc(name.text)}</span>`).join('')}</span>` : '';
      return `<${tag}${attributes({ type: opens ? 'button' : null, class: `dy-row dy-row--move${opens?.open ? ' is-open' : ''}`,
        'data-k': 'move', 'data-d-stay': opens?.key ?? null, 'data-d-nav': opens ? '' : null, tabindex: opens ? '-1' : null,
        'aria-expanded': opens ? String(opens.open) : null, 'aria-label': opens ? `${opens.open ? 'Fold' : 'Open'} ${shown.name}` : null })}>`
        + timeOf(time)
        + `<span class="dy-row__mark dy-move" aria-hidden="true">${icon(shown.icon, { className: 'dy-move__icon' })}</span>`
        + (opens ? `<span class="dy-row__icon dy-caret" data-c="icon">${icon('forward')}</span>` : '')
        + '<span class="dy-row__span mac-subhead" data-c="name" data-d-fit="words">'
        + `<span class="dy-w dy-w--secondary" data-w="text">${esc(shown.name)}</span>${shown.words.length ? JOIN + wordsOf(shown.words) : ''}${names}</span>`
        + `<span class="dy-row__count dy-row__count--quiet mac-mono-data" data-c="count">${countOf(shown.count)}</span>`
        + `</${tag}>`;
    }
    default: {
      const shown = /** @type {DayRow} */ (row);
      if (shown.kind === 'gap') return `<div class="dy-row dy-row--gap" data-k="gap" data-d-at="${esc(shown.key)}">`
        + `<span class="dy-row__span mac-subhead" data-c="name">${esc(shown.name)} · ${esc(time)}</span></div>`;
      const opening = shown.focus !== null;
      const tag = opening ? 'button' : 'div';
      const classes = ['dy-row', plan ? 'dy-row--plan' : '', allDay ? 'dy-row--allday' : '', shown.quiet ? 'is-quiet' : '',
        selected ? 'is-selected' : ''].filter(Boolean).join(' ');
      return `<${tag}${attributes({ type: opening ? 'button' : null, class: classes, 'data-k': plan ? 'plan' : allDay ? 'allday' : 'row',
        'data-d-row': opening ? shown.key : null, 'data-d-at': shown.key, 'data-d-block': block || null,
        'data-d-nav': opening ? '' : null, tabindex: opening ? '-1' : null, 'aria-label': opening ? rowLabel(time, shown) : null,
        'aria-current': selected ? 'true' : null })}>`
        + timeOf(allDay ? 'All day' : time)
        + (plan ? '<svg class="dy-row__mark dy-plan" viewBox="0 0 22 22" aria-hidden="true"><circle cx="11" cy="11" r="10"/></svg>' : '')
        + `<span class="dy-row__icon" data-c="icon">${icon(shown.icon)}</span>`
        + `<span class="dy-row__name mac-headline" data-c="name" data-d-fit="name"><span class="dy-row__title">${esc(shown.name)}</span>`
        + (shown.note ? `<span class="dy-row__note mac-body">${esc(shown.note)}</span>` : '') + '</span>'
        + `<span class="dy-row__words mac-body" data-c="words" data-d-fit="words">${wordsOf(shown.words)}</span>`
        + `<span class="dy-row__count mac-mono-data" data-c="count">${countOf(shown.count)}</span>`
        + `</${tag}>`;
    }
  }
}
