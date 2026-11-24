// @ts-check
import { atMost, continued, inputSchemaOf } from '../params.mjs';
import { told } from '../shape.mjs';
import { noteOf, notSearchedLines, pendingLines, withoutPending } from './search.mjs';

/** @typedef {import('../tools.mjs').Context} Context */


const SCHEMA = inputSchemaOf('/v1/count');

export const count = {
  name: 'count',
  description: 'Exact numbers over everything the record measures, never a ranked page: how many, how much, how long, averages, the most and least, first and last, days in a place, trips. No `of`: the catalog: each collection with its keys, its measures and the days held, and what the screen\'s text holds. `of`: the collection counted (payments, calls, days, workouts, messages…). `measure` with `op` (sum, avg, min, max, first, last); neither: a count. `by`: up to two of hour, weekday, day, week, month, year, a key of the collection (person, payee, app, sport, city, country…) or `run` (unbroken runs of days: trips, streaks); or `item` alone (the things themselves). Filters: from, to, person, chat, place, `match` ({key: words}: any case, part of a word, a OR b, -word), `words` (as search reads them), at_least and at_most on the measure. Each row ends with a handle: `read` it for the things behind the number. `matched` lists what the filters took, `population` what was counted and what had no value, `counted` what it was counted from, `also` what else in the range the same filter reaches, uncounted (read it, add what the rows lack, give the whole first), `readings` the other ways the record measures it (the total\'s `said` states each), `held` the days the record holds. Every number is of exactly what you asked. A count of stays is no timeline: where the person was, in order, is `read` of the days. Too much for one call: it is refused and names the range that fits (ask it, then the rest; for a first, the oldest days), or what to narrow by. The note says the days still being read.',
  inputSchema: SCHEMA,
  route: '/v1/count',
  /**
   * @param {{ of?: string, measure?: string, op?: string, by?: string[], from?: string, to?: string, person?: string[],
   *   chat?: string, place?: string, words?: string, match?: Record<string, string>, at_least?: number, at_most?: number,
   *   order?: string, limit?: number, cursor?: string }} asked
   * @param {Context} context
   * @returns {Promise<import('../hiding.mjs').Routed>}
   */
  async run(asked, context) {
    const { args, lines: most } = atMost('/v1/count', asked);
    /** @type {any} */
    const answer = await context.read('/v1/count', args.cursor === undefined ? args : continued(args));
    return told({ ...noteOf([...most, ...countLines(answer, args)]), ...withoutPending(answer) });
  },
};

/**
 * @param {{ op?: string, found?: unknown, pending?: { day: string }[], pending_more?: number, not_searched?: string[], next?: string | null }} answer
 * @param {{ from?: string, to?: string }} [args]
 * @returns {import('./search.mjs').Line[]}
 */
export function countLines(answer, args = {}) {
  return [
    ...('found' in answer && answer.found === null ? [[`no ${answer.op === 'last' ? 'last' : 'first'}: nothing in the range is kept`]] : []),
    ...pendingLines(answer.pending, answer.pending_more, args),
    ...notSearchedLines(answer.not_searched),
    ...(typeof answer.next === 'string' ? [['more rows: `next` gives the next page']] : []),
  ];
}
