// @ts-check
/** @import { ChipChoice, FilterChoice } from '../kit/filter-menu.js' */
/** @import { Count, Search } from '../../pages.js' */
import { familyWords } from '../../lib/kinds.js';
import { monthEnd } from '../../lib/words.js';
import { filterChips, filterMenu } from '../kit/index.js';

/**
 * @param {string} chosen
 * @param {string} today
 * @returns {{ from: string, to: string } | null}
 */
export function timeRange(chosen, today) {
  if (chosen === 'month') return { from: `${today.slice(0, 7)}-01`, to: monthEnd(today.slice(0, 7)) };
  const year = chosen === 'year' ? today.slice(0, 4) : /^\d{4}$/u.test(chosen) ? chosen : '';
  return year ? { from: `${year}-01-01`, to: `${year}-12-31` } : null;
}

/**
 * @param {URLSearchParams} params
 * @param {{ from: string, to: string } | null} range
 */
const within = (params, range) => {
  if (range) {
    params.set('from', range.from);
    params.set('to', range.to);
  }
  return params;
};

/** @param {string} query */
const searched = query => new URLSearchParams([['query', query], ['typing', '1']]);

/**
 * @param {string} query
 * @param {string} time
 * @param {string} today
 */
export const kindsParams = (query, time, today) => within(searched(query), timeRange(time, today));

/**
 * @param {string} query
 * @param {{ family: string, time: string, upcoming: boolean }} chosen
 * @param {string} today
 */
export function seeParams(query, { family, time, upcoming }, today) {
  const params = kindsParams(query, time, today);
  params.set('see', family);
  if (upcoming) params.set('upcoming', '1');
  return params;
}

/** @param {string} cursor */
export const pageParams = cursor => new URLSearchParams([['cursor', cursor]]);

/**
 * @param {{ title: string, artist: string | null }} track
 * @param {{ month: string } | null} [month]
 */
export function trackParams({ title, artist }, month = null) {
  const params = new URLSearchParams([['of', 'plays'], ['match.track', `=${title}`]]);
  if (artist) params.set('match.artist', `=${artist}`);
  params.set('measure', 'times');
  params.set('op', 'sum');
  if (!month) {
    params.set('by', 'month');
    if (!artist) params.append('by', 'artist');
    return params;
  }
  params.set('by', 'item');
  params.set('order', 'time');
  params.set('from', `${month.month}-01`);
  params.set('to', monthEnd(month.month));
  return params;
}

/**
 * @param {{ first: string } | null | undefined} held
 * @param {string} today
 * @returns {FilterChoice[]}
 */
export function timeChoices(held, today) {
  const thisYear = Number(today.slice(0, 4));
  const first = Number(held?.first.slice(0, 4) ?? thisYear);
  /** @type {FilterChoice[]} */
  const years = [];
  for (let year = thisYear - 1; year >= first; year -= 1) years.push({ value: String(year), label: String(year) });
  return [{ value: 'month', label: 'This month' }, { value: 'year', label: 'This year' }, ...years];
}

/** @param {Count | null} count */
export function countWords(count) {
  if (count === null) return '';
  const n = count.n.toLocaleString('en-US');
  return count.partial ? `${n}+` : n;
}

/** @param {Count | null} count */
export function countSpoken(count) {
  if (count === null) return '';
  const n = count.n.toLocaleString('en-US');
  return count.partial ? `at least ${n}` : n;
}

/**
 * @param {Search} answer
 * @returns {{ value: string, label: string, count: string, spoken: string }[]}
 */
export const chipChoices = answer => [{ value: '', label: 'All', count: /** @type {Count | null} */ (answer.total) },
  ...answer.kinds.map(kind => ({ value: kind.family, label: kind.title, count: kind.count }))]
  .map(({ count, ...choice }) => ({ ...choice, count: countWords(count), spoken: countSpoken(count) }));

/**
 * @param {{ answer: Search | null, family: string, time: string, held: { first: string } | null | undefined,
 *   today: string }} chips
 */
export function searchChips({ answer, family, time, held, today }) {
  /** @type {ChipChoice[]} */
  const choices = answer ? chipChoices(answer) : [{ value: '', label: 'All' }];
  if (family && !choices.some(choice => choice.value === family)) choices.push({ value: family, label: familyWords(family).label });
  return filterChips({
    label: 'Kind', choices, value: family, attrs: { 'data-search-chips': '' },
    end: filterMenu({ name: 'Time', all: 'Any time', choices: timeChoices(held, today), value: time, align: 'end',
      attrs: { 'data-search-menu': 'time' } }),
  });
}
