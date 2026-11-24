// @ts-check
import { atMost, continued, inputSchemaOf } from '../params.mjs';
import { NOTE, linksIn, told } from '../shape.mjs';

/** @typedef {import('../tools.mjs').Context} Context */


export const FOLLOWS = 3;
const LISTS = ['record', 'screen'];

const SCHEMA = inputSchemaOf('/v1/search');

export const search = {
  name: 'search',
  description: 'Find what was said, written, shown or seen. One call answers two lists. `record`: one hit per thing, across messages, mail, notes, AI chats, calendar, calls, web pages and searches, photo descriptions, and each day\'s account of what was done on the Mac (family screen). `screen`: the exact words the Mac\'s screen showed, one hit per window on a day; use it for a thing only seen (a price, an account, a page). `query` reads like a search box: every word; "a phrase"; -word; a OR b. A rare word\'s near spellings are added and named in `variants`; quote a word to match it exactly; write a placeholder as given, [[Person 1]], never quoted. No `query`: what the filters keep (a person, a chat, a place, dates), newest first. Filters: from, to, families, products, person (a handle from `search_people`), chat, place. `order`: relevance, newest, oldest (for who was first). Each `record` hit: a handle for `read`, its time where the person was, family, title, sender, snippet, a message\'s `chat` (read it as `chat` for the whole conversation), `the_user_was_at` (where the user was then, not where the thing is), and `picture` when it holds one (`read` shows it to you). Each `screen` hit: a handle, its app, window title, line, time (`until` when known only to a stretch) and `reason` (`words`; `spelling`; `partial`: only some of the words; `meaning`: alike in meaning, not in words). A snippet is a cut of the thing, not the thing. `total` counts every match unless `capped`: then it is at least that many, counted as far as `reached` says, and `next`, passed as `cursor`, goes on from there. The two lists have their own `next`. The screen records no person, chat or place: under those filters, or with no `query`, `screen` says it was not searched. With no dates it reads the newest year; its `next` gives the next windows, then older days. To count or add up, use `count`.',
  inputSchema: SCHEMA,
  route: '/v1/search',
  /**
   * @param {{ query?: string, families?: string[], products?: string[], person?: string[], chat?: string,
   *   place?: string, from?: string, to?: string, order?: string, limit?: number, lists?: string[], typing?: number,
   *   cursor?: string }} asked
   * @param {Context} context
   * @returns {Promise<import('../hiding.mjs').Routed>}
   */
  async run(asked, context) {
    const { args, lines: most } = atMost('/v1/search', asked);
    /** @type {any} */
    let answer = await context.read('/v1/search', paramsOf(args));
    for (let followed = 0; args.cursor === undefined && followed < FOLLOWS && emptyCapped(answer.record); followed++) {
      const on = await context.read('/v1/search', { cursor: answer.record.next });
      answer = { ...answer, record: on.record };
    }
    const lines = [...most, ...readAsLines(answer.read_as), ...recordLines(answer.record, args), ...screenLines(answer.screen, args),
      ...notSearchedLines(answer.not_searched)];
    const hits = [...answer.record?.hits ?? [], ...answer.screen?.hits ?? []];
    return told({ ...noteOf(lines), ...withoutPending(answer) }, {
      ...(answer.record === undefined ? {} : { found: answer.record.capped === true ? `${answer.record.total}+` : answer.record.total }),
      links: linksIn(hits.map(hit => String(hit.snippet ?? '').replace(/[«»]/gu, ''))),
    });
  },
};

/**
 * @param {Parameters<typeof search.run>[0]} args
 * @returns {Record<string, unknown>}
 */
export function paramsOf(args) {
  if (args.cursor !== undefined) return continued(args);
  return Object.fromEntries(Object.entries({ ...args, lists: args.lists ?? LISTS }).filter(([, value]) => value !== undefined));
}

/** @param {any} list */
const emptyCapped = list => list !== undefined && list.capped === true && list.hits.length === 0 && typeof list.next === 'string';

/** @typedef {string[]} Line */

/** @param {Line[]} lines */
export function noteOf(lines) {
  if (lines.length === 0) return { note: NOTE };
  return { note: `${NOTE} ${lines.map(line => line.join('')).join('. ')}.` };
}

/** @param {number} n */
const counted = n => (n <= 10 ? ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][n] : n.toLocaleString('en-US'));

/** @param {number} n */
const matches = n => `${n.toLocaleString('en-US')} ${n === 1 ? 'match' : 'matches'}`;

/** @param {string} at */
const minute = at => at.slice(0, 16).replace('T', ' ');

/**
 * @param {{ day: string }[] | undefined} pending
 * @param {number | undefined} more
 * @param {{ from?: unknown, to?: unknown }} [range]
 * @returns {Line[]}
 */
export function pendingLines(pending, more, range = {}) {
  const n = (pending?.length ?? 0) + (more ?? 0);
  if (pending === undefined || pending.length === 0) return [];
  const newest = /** @type {{ day: string }} */ (pending[0]).day;
  const oldest = /** @type {{ day: string }} */ (pending.at(-1)).day;
  const days = daysIn(range);
  if (days !== null && n >= days) {
    return [[`every day of this range is still being read (${n === 1 ? `1 day, ${newest}` : `${n.toLocaleString('en-US')} days, ${oldest} to ${newest}`})`]];
  }
  if (n === 1) return [[`1 day of this range is still being read: ${newest}`]];
  return [[`${n.toLocaleString('en-US')} days of this range are still being read, ${(more ?? 0) > 0 ? `from before ${oldest}` : `from ${oldest}`} to ${newest}`]];
}

/** @param {unknown} when */
const dayOf = when => (typeof when === 'string' && /^\d{4}-\d{2}-\d{2}/u.test(when) ? when.slice(0, 10) : null);

/** @param {{ from?: unknown, to?: unknown }} range */
function daysIn(range) {
  const from = dayOf(range.from), to = dayOf(range.to);
  if (from === null || to === null || to < from) return null;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/**
 * @template T
 * @param {T} answer
 * @returns {T}
 */
export function withoutPending(answer) {
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) return answer;
  const { pending: _pending, pending_more: _more, ...rest } = /** @type {Record<string, unknown>} */ (answer);
  for (const member of ['record', 'screen']) if (rest[member] !== undefined) rest[member] = withoutPending(rest[member]);
  if (Array.isArray(rest.opened)) rest.opened = rest.opened.map(withoutPending);
  return /** @type {T} */ (rest);
}

/**
 * @param {any} list
 * @param {{ query?: string, order?: string, from?: string, to?: string }} args
 * @returns {Line[]}
 */
export function recordLines(list, args) {
  if (list === undefined) return [];
  const byTime = list.order === 'newest';
  const ranked = !byTime && (args.order === 'relevance' || (args.order === undefined && (args.query ?? '').trim() !== ''));
  return [
    ...(byTime ? [['ranked paging stops here; the rest come newest first: `next` goes on']] : []),
    ...(list.capped === true ? [[boundLine(list, ranked)]] : []),
    ...pendingLines(list.pending, list.pending_more, args),
  ];
}

/**
 * @param {any} list
 * @param {boolean} ranked
 */
export function boundLine(list, ranked) {
  const reached = /** @type {{ side: 'newest' | 'oldest', at: string, whole: string | null } | undefined} */ (list.reached);
  if (list.hits.length === 0) {
    const ways = 'pass `cursor`, or give dates or families';
    if (reached === undefined) return `nothing found so far; the rest not searched: ${ways}`;
    return reached.side === 'oldest' ? `nothing found forward to ${minute(reached.at)}; newer not searched: ${ways}`
      : `nothing found back to ${minute(reached.at)}; older not searched: ${ways}`;
  }
  if (reached === undefined) return `at least ${matches(list.total)}; there may be more: \`next\` goes on`;
  const days = reached.whole === null ? 'no day whole' : reached.side === 'oldest' ? `every day up to ${reached.whole} whole` : `every day from ${reached.whole} whole`;
  if (ranked) {
    return `the best of the newest ${matches(list.total)}, back to ${minute(reached.at)}, ${days}: \`next\` gives the next best; after the last of them it ranks the older ones among themselves`;
  }
  return reached.side === 'oldest'
    ? `${matches(list.total)} counted forward to ${minute(reached.at)}, ${days}; newer ones not counted: \`next\` goes on`
    : `${matches(list.total)} counted back to ${minute(reached.at)}, ${days}; older ones not counted: \`next\` goes on`;
}

/**
 * @param {any} list
 * @param {{ query?: string, from?: string, to?: string, cursor?: string }} args
 * @returns {Line[]}
 */
export function screenLines(list, args) {
  if (list === undefined) return [];
  if (typeof list.unread === 'string') return [['the screen\'s text was not searched: ', list.unread]];
  const span = args.cursor === undefined && args.from === undefined && args.to === undefined ? 'the newest year' : 'the days read';
  const byWords = list.hits.filter((/** @type {{ reason: string }} */ hit) => hit.reason !== 'meaning').length;
  const first = args.cursor === undefined;
  /** @type {Line[]} */
  const lines = [];
  if (list.order === 'newest') lines.push(['ranked paging stops here; the rest come newest first: `next` goes on']);
  else if (list.next_gives === 'windows') {
    lines.push([typeof list.total === 'number'
      ? `${list.total.toLocaleString('en-US')} ${list.total === 1 ? 'window' : 'windows'} in ${span}, ${first ? `the ${counted(byWords)} best` : `${counted(byWords)} more`} shown: its \`next\` gives more windows of it`
      : `the ${counted(byWords)} best ${byWords === 1 ? 'window' : 'windows'} of ${span}: its \`next\` gives more windows of it`]);
  } else if (list.next_gives === 'days') {
    const older = list.reached?.side !== 'oldest';
    const shown = !first ? null : list.hits.length === 0 ? 'no window matched' : typeof list.total === 'number' ? 'every window shown' : null;
    const read = list.reached === undefined ? [] : [`read ${older ? 'back' : 'forward'} to ${list.reached.whole}`];
    const said = [...read, ...(shown === null ? [] : [shown])].join(', ');
    lines.push([`${said === '' ? '' : `${said}; `}its \`next\` reads ${older ? 'older' : 'newer'} days`]);
  }
  if ((args.query ?? '').trim() !== '') {
    if (list.meaning === 'off') lines.push(['by words only: search by meaning is off']);
    else if (list.meaning === 'waits') lines.push(['by words only: ', String(list.waits ?? 'search by meaning waits')]);
    else if (list.meaning === 'withheld') lines.push(['by words only: search by meaning is withheld, since the words could tell a hidden detail']);
  }
  lines.push(...pendingLines(list.pending, list.pending_more, args));
  return lines.map(line => ['on the screen: ', ...line]);
}

/**
 * @param {{ without: string[], as: Record<string, string[]> } | undefined} readAs
 * @returns {Line[]}
 */
export function readAsLines(readAs) {
  if (readAs === undefined) return [];
  return [
    ...(readAs.without.length === 0 ? [] : [['read without: ', readAs.without.join(', ')]]),
    ...Object.entries(readAs.as).map(([word, as]) => ['`', word, '` read as ', as.join(', ')]),
  ];
}

/**
 * @param {string[] | undefined} words
 * @returns {Line[]}
 */
export function notSearchedLines(words) {
  if (words === undefined || words.length === 0) return [];
  return [['Not searched (a word that could tell where a hidden detail is): ', words.join(', '),
    '. Search them by the placeholder an answer gave, or a word an answer showed']];
}
