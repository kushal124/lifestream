// @ts-check
/** @import { Day, DayBlock, DayChapter, DayName, DayRow } from '../../pages.js' */
import { attributes } from '../../lib/html.js';
import { calendarDate, clock, dayDate, duration as durationWords, longDay, shiftDay } from '../../lib/words.js';
import { dayRow } from '../kit/day-row.js';
import { namesLine, namesLineReading } from '../kit/names-line.js';
import { photoStrip } from '../kit/photo-strip.js';
import { stayHead, stayHeadReading } from '../kit/stay-head.js';
import { bar, noneLine, shape, waitLine } from '../kit/index.js';

export const UNTIMED = 'untimed';

/**
 * @typedef {object} Fold
 * @property {string} key
 * @property {'stay' | 'move' | 'none' | 'untimed'} kind
 * @property {string | null} episode
 * @property {number | null} start_ms
 * @property {number | null} end_ms
 * @property {DayChapter['head']} head
 * @property {string} name
 * @property {boolean} folded
 * @property {DayName[]} names
 * @property {DayChapter['photos']} photos
 * @property {DayBlock[]} blocks
 */

/**
 * @typedef {{ type: 'fold', fold: Fold } | { type: 'row', row: DayRow, allDay?: boolean, plan?: boolean }
 *   | { type: 'gap', chapter: DayChapter } | { type: 'move', chapter: DayChapter } | { type: 'now', at: number }
 *   | { type: 'divider', day: string } | { type: 'end', at: number }} Item
 */

/**
 * @typedef {object} FoldView
 * @property {ReadonlyMap<string, boolean>} open
 * @property {ReadonlyMap<string, boolean>} hours
 * @property {string} selected
 * @property {number} now
 */

const RUN = 100;

/** @param {number} ms */
const duration = ms => durationWords(ms).replace(/(\d)[  ](?=[hms]\b)/gu, '$1');

/** @param {number | null} ms */
const timeOf = ms => ms === null ? '' : clock(ms);

/**
 * @param {DayChapter} chapter
 * @returns {Fold}
 */
const chapterFold = chapter => ({
  key: chapter.key, kind: /** @type {Fold['kind']} */ (chapter.kind), episode: chapter.episode, start_ms: chapter.start_ms,
  end_ms: chapter.end_ms, head: chapter.head, name: chapter.head?.title ?? '', folded: chapter.folded, names: chapter.names,
  photos: chapter.photos, blocks: chapter.blocks,
});

/**
 * @param {Day} day
 * @returns {Item[]}
 */
export function itemsOf(day) {
  /** @type {Item[]} */
  const items = day.all_day.map(row => ({ type: /** @type {const} */ ('row'), row, allDay: true }));
  for (const chapter of day.chapters) {
    if (chapter.divider) items.push({ type: 'divider', day: chapter.divider });
    if (chapter.kind === 'gap') items.push({ type: 'gap', chapter });
    else if (chapter.kind === 'day') {
      for (const row of chapter.blocks.flatMap(block => block.rows)) {
        if (row.divider) items.push({ type: 'divider', day: row.divider });
        items.push({ type: 'row', row });
      }
    } else if (chapter.kind === 'move' && !chapter.blocks.length) items.push({ type: 'move', chapter });
    else items.push({ type: 'fold', fold: chapterFold(chapter) });
  }
  if (day.also) {
    const { folded, names, rows } = day.also;
    items.push({ type: 'fold', fold: { key: UNTIMED, kind: 'untimed', episode: null, start_ms: null, end_ms: null, head: null,
      name: day.now_ms !== null ? 'Also today' : 'Also that day', folded, names, photos: [],
      blocks: [{ key: `${UNTIMED}#run`, kind: 'run', start_ms: 0, title: null, line: null, count: null, folded: false, rows, divider: null }] } });
  }
  if (day.now_ms !== null) {
    if (day.now_divider) items.push({ type: 'divider', day: day.now_divider });
    items.push({ type: 'now', at: day.now_ms });
    for (const row of day.plans) {
      if (row.divider) items.push({ type: 'divider', day: row.divider });
      items.push({ type: 'row', row, plan: true });
    }
  }
  if (day.end_ms !== null) items.push({ type: 'end', at: day.end_ms });
  return items;
}

/**
 * @param {Item[]} items
 * @returns {Fold[]}
 */
export const foldsOf = items => items.flatMap(item => item.type === 'fold' ? [item.fold] : []);

/** @param {Fold} fold */
export const opens = fold => fold.blocks.some(block => block.rows.length > 0);

/**
 * @param {Fold} fold
 * @param {FoldView} view
 */
export const isOpen = (fold, view) => opens(fold) && (view.open.get(fold.key) ?? !fold.folded);

/**
 * @param {DayBlock} block
 * @param {FoldView} view
 */
export const hourOpen = (block, view) => view.hours.get(block.key) ?? !block.folded;

/**
 * @param {Day} day
 * @param {Item[]} items
 * @param {FoldView} view
 */
export function dayList(day, items, view) {
  if (!items.length) return noneLine(day.line ?? '');
  const rails = railsOf(items);
  return '<div class="dy-list" role="list" aria-label="The day">'
    + items.map((item, at) => itemOf(item, view, day, rails[at])).join('') + '</div>';
}

/**
 * @param {Fold} fold
 * @param {FoldView} view
 */
export function moveHeadRow(fold, view) {
  const open = isOpen(fold, view);
  return dayRow('move', { row: moveRow(fold), time: timeOf(fold.start_ms), opens: { key: fold.key, open, names: fold.names } });
}

/**
 * @param {Fold | DayChapter} moved
 * @returns {DayRow}
 */
const moveRow = moved => ({
  key: moved.episode ?? moved.key, kind: 'move', at_ms: moved.start_ms, end_ms: moved.end_ms, icon: moved.head?.icon ?? 'move',
  name: moved.head?.title ?? '', note: '', words: moved.head?.words ?? [],
  count: moved.head?.length ? { kind: 'words', text: moved.head.length } : null, quiet: false, focus: null, divider: null,
});

/**
 * @param {Item[]} items
 * @returns {{ line: '' | 'life' | 'track' | 'plan', from: boolean, to: boolean }[]}
 */
function railsOf(items) {
  const marked = (/** @type {Item} */ item) => (item.type === 'fold' && (item.fold.kind === 'stay' || item.fold.kind === 'move'))
    || item.type === 'move' || item.type === 'now';
  const first = items.findIndex(item => item.type === 'fold' && item.fold.kind === 'stay');
  const now = items.findIndex(item => item.type === 'now');
  const lastPlan = items.map((item, at) => item.type === 'row' && item.plan ? at : -1).filter(at => at >= 0).at(-1) ?? -1;
  const lastMark = now >= 0 ? now : items.map((item, at) => marked(item) ? at : -1).filter(at => at >= 0).at(-1) ?? -1;
  const start = first >= 0 ? first : items.findIndex(marked);
  return items.map((item, at) => {
    if (start < 0 || at < start) return { line: '', from: false, to: false };
    if (at <= lastMark) {
      const none = item.type === 'fold' && item.fold.kind !== 'stay' && item.fold.kind !== 'move';
      return { line: none ? 'track' : 'life', from: at === start, to: at === lastMark };
    }
    if (now >= 0 && at <= lastPlan) return { line: 'plan', from: false, to: at === lastPlan };
    return { line: '', from: false, to: false };
  });
}

/**
 * @param {string} day
 * @param {string} on
 */
const dividerOf = (day, on) => dayRow('divider', { divider: { date: longDay(day, on.slice(0, 4)) } });

/**
 * @param {DayRow} plan
 * @param {number} now
 * @returns {DayRow}
 */
const planned = (plan, now) => ({ ...plan, words: [{ type: 'text', text: aheadOf(plan, now), tone: 'secondary', title: false },
  ...plan.words] });

/**
 * @param {DayRow} plan
 * @param {number} now
 */
export const aheadOf = (plan, now) => `in ${duration(Math.max(0, (plan.at_ms ?? now) - now))}`;

/**
 * @param {Item} item
 * @param {FoldView} view
 * @param {Day} day
 * @param {{ line: string, from: boolean, to: boolean }} rail
 */
function itemOf(item, view, day, rail) {
  const wrap = (/** @type {string} */ body, /** @type {string} */ kind) => `<div${attributes({ class: `dy-item dy-item--${kind}`,
    role: 'listitem', 'data-line': rail.line || null, 'data-line-from': rail.from ? '' : null, 'data-line-to': rail.to ? '' : null })}>${body}</div>`;
  switch (item.type) {
    case 'fold':
      return foldOf(item.fold, view, day, rail);
    case 'row': {
      const row = item.plan ? planned(item.row, view.now) : item.row;
      return wrap(dayRow('row', { row, time: timeOf(row.at_ms), plan: item.plan, allDay: item.allDay, selected: row.key === view.selected }),
        item.plan ? 'plan' : 'row');
    }
    case 'gap': {
      const { chapter } = item;
      const row = { ...moveRow(chapter), key: chapter.key, kind: /** @type {const} */ ('gap'), count: null };
      return wrap(dayRow('row', { row, time: `${clock(chapter.start_ms)}–${timeOf(chapter.end_ms)}` }), 'gap');
    }
    case 'move':
      return wrap(dayRow('move', { row: moveRow(item.chapter), time: timeOf(item.chapter.start_ms) }), 'move');
    case 'now':
      return wrap(dayRow('now', { now: { time: clock(view.now), updated: timeOf(day.updated_ms) } }), 'now');
    case 'divider':
      return wrap(dividerOf(item.day, day.day), 'divider');
    default: {
      const next = shiftDay(day.day, 1);
      return wrap(dayRow('dayEnd', { end: { time: clock(item.at), next: longDay(next, next.slice(0, 4)) } }), 'end');
    }
  }
}

/**
 * @param {Fold} fold
 * @param {FoldView} view
 * @param {Day} day
 * @param {{ line: string, from: boolean, to: boolean }} rail
 */
function foldOf(fold, view, day, rail) {
  const open = isOpen(fold, view);
  const time = timeOf(fold.start_ms);
  const length = lengthOf(fold);
  const head = fold.kind === 'move'
    ? moveHeadRow(fold, view)
    : stayHead({ key: fold.key, time, icon: fold.head?.icon ?? '', name: fold.name, line: lineOf(fold), quiet: fold.head?.quiet ?? false,
      spot: fold.head?.place ?? '', length, open, button: opens(fold), label: [time, length].filter(Boolean).join(', ') });
  return `<section${attributes({ class: `dy-item dy-block dy-block--${fold.kind}${open ? ' is-open' : ''}`, role: 'listitem',
    'data-k': 'block', 'data-d-block': fold.key, 'data-line': rail.line || null, 'data-line-from': rail.from ? '' : null,
    'data-line-to': rail.to ? '' : null })}>`
    + '<div class="dy-block__ground" aria-hidden="true"></div>'
    + head + `<div class="dy-block__body">${blockBody(fold, view, day)}</div></section>`;
}

/** @param {Fold} fold */
export function lengthOf(fold) {
  if (fold.head?.length) return fold.head.length;
  return fold.kind === 'stay' && fold.end_ms === null && fold.start_ms !== null ? `since ${clock(fold.start_ms)}` : '';
}

/** @param {Fold} fold */
const lineOf = fold => {
  const head = fold.head;
  if (fold.kind !== 'stay' || !head) return '';
  const since = head.since_ms === null ? '' : `since ${dayDate(calendarDate(head.since_ms)).split(' ')[0]} ${clock(head.since_ms)}`;
  return [head.line, since, head.stated_by].filter(Boolean).join(' · ');
};

/**
 * @param {Fold} fold
 * @param {FoldView} view
 * @param {Day} day
 */
export function blockBody(fold, view, day) {
  if (!isOpen(fold, view)) {
    return fold.kind === 'move' ? ''
      : namesLine({ block: fold.key, names: fold.names }) + photoStrip({ block: fold.key, photos: fold.photos });
  }
  return `<div class="dy-rows">${fold.blocks.map(block => block.kind === 'hour'
    ? hourOf(block, fold, view, day) : runsOf(rowsOf(block.rows, fold, view, day))).join('')}</div>`;
}

/**
 * @param {DayBlock} block
 * @param {Fold} fold
 * @param {FoldView} view
 * @param {Day} day
 */
function hourOf(block, fold, view, day) {
  const open = hourOpen(block, view);
  const sent = block.count?.kind === 'sent' ? block.count.count : 0;
  return (block.divider ? dividerOf(block.divider, day.day) : '')
    + `<div${attributes({ class: `dy-hour${open ? ' is-open' : ''}`, 'data-d-hourbox': block.key })}>`
    + dayRow('hour', { block: fold.key, hour: { key: block.key, time: clock(block.start_ms), line: block.line ?? '', sent, open } })
    + `<div class="dy-hour__rows">${open ? runsOf(rowsOf(block.rows, fold, view, day)) : ''}</div></div>`;
}

/**
 * @param {DayBlock} block
 * @param {Fold} fold
 * @param {FoldView} view
 * @param {Day} day
 */
export const hourRows = (block, fold, view, day) => runsOf(rowsOf(block.rows, fold, view, day));

/**
 * @param {DayRow[]} rows
 * @param {Fold} fold
 * @param {FoldView} view
 * @param {Day} day
 * @returns {string[]}
 */
function rowsOf(rows, fold, view, day) {
  return rows.flatMap(row => {
    const time = fold.kind === 'untimed' ? '' : timeOf(row.at_ms);
    const drawn = row.kind === 'move'
      ? dayRow('move', { row, time })
      : dayRow('row', { row, time, block: fold.key, selected: row.key === view.selected });
    return row.divider ? [dividerOf(row.divider, day.day), drawn] : [drawn];
  });
}

/** @param {string[]} rows */
function runsOf(rows) {
  const runs = [];
  for (let at = 0; at < rows.length; at += RUN) {
    const run = rows.slice(at, at + RUN);
    runs.push(`<div class="dy-rows__run" data-rows="${run.length}">${run.join('')}</div>`);
  }
  return runs.join('');
}

/** @param {ParentNode} root */
export function sizeRuns(root) {
  for (const run of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('.dy-rows__run[data-rows]'))) {
    run.style.setProperty('--rows', String(run.dataset.rows));
  }
}

export function dayListReading() {
  const stay = (/** @type {'' | 'from' | 'to'} */ end) => `<div class="dy-item dy-block dy-block--stay is-reading"${end ? ` data-line-${end}` : ''} data-line="life">`
    + `${stayHeadReading()}<div class="dy-block__body">${namesLineReading()}</div></div>`;
  const move = '<div class="dy-item dy-item--move is-reading" data-line="life"><div class="dy-row dy-row--move">'
    + `<span class="dy-row__time mac-mono-time">${bar(2)}</span>`
    + `<span class="dy-row__mark dy-move">${shape({ className: 'dy-move__sk' })}</span>`
    + `<span class="dy-row__span mac-subhead">${bar(3)}</span></div></div>`;
  return `<div class="dy-list" aria-hidden="true">${stay('from')}${move}${stay('')}${move}${stay('to')}</div>`
    + waitLine();
}
