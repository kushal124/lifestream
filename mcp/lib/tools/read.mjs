// @ts-check
import { z } from 'zod';
import { argumentError } from '../errors.mjs';
import { continued, inputSchemaOf } from '../params.mjs';
import { linksIn, MAX_CHARS, told } from '../shape.mjs';
import { LINK_WORDS, openLink, opensLink } from './read/link.mjs';
import { noteOf, pendingLines, withoutPending } from './search.mjs';

/** @typedef {import('../tools.mjs').Context} Context */


const WORDS = 'Open anything whole: a handle, a chat, or a stretch of time. `ref`: one handle or up to 20. A record opens whole; a message with its chat around it; an AI chat\'s turn with its conversation; a day line with its neighbours; a count\'s row as the things behind it; a screen hit as the screen\'s lines around it; a photo is shown to you (6 at most). `chat` (a handle, or a hit\'s `chat`) with from/to: the chat over that span, each message once, empty days skipped; alone: its latest; `next` reads on. `from`/`to` alone: that stretch; a day given alone is the whole day; `families` keeps some. `last` ("45m", "3h", at most "24h"): the stretch ending now, at a glance by default: where the person was active (each chat, window, conversation, place, with its span and handles to open), and `freshness`, which sources have not synced lately; `products` keeps some, as in search. `detail`: `lines` (every family\'s lines in time order: where the person was, in order, and what they did there, in one call; the default for one or two days), `brief` (each day at a glance; the default from three whole days), `raw` (a record\'s whole content; with families screen, the screen\'s text minute by minute in order, 30 minutes at most: read a screen hit\'s minutes so). A picture in a chat or a day is a line with its own handle: read that handle to see it.';

const SCHEMA = inputSchemaOf('/v1/read');

/**
 * @typedef {{ ref?: string | string[], chat?: string, from?: string, to?: string, last?: string, families?: string[], products?: string[],
 *   detail?: 'lines' | 'brief' | 'raw', history?: 1, cursor?: string, link?: string }} Args
 */

/** @param {{ links: boolean }} options */
export function readTool({ links }) {
  return {
    name: 'read',
    description: links ? `${WORDS} ${LINK_WORDS}` : WORDS,
    inputSchema: links ? { ...SCHEMA, link: z.string().max(4_000).optional().describe('A link, exactly as the person or a record wrote it.') } : SCHEMA,
    route: '/v1/read',
    wrapped: opensLink,
    writes: opensLink,
    /**
     * @param {Args} args
     * @param {Context} context
     */
    async run(args, context) {
      if (args.link !== undefined) {
        if (!links) throw argumentError('read opens no link here: open it yourself');
        return openLink(args, context);
      }
      return await routed(args, context);
    },
  };
}

/**
 * @param {Args} args
 * @param {Context} context
 * @returns {Promise<import('../hiding.mjs').Routed>}
 */
async function routed(args, context) {
  const answer = await joinedPages(await context.read('/v1/read', args.cursor === undefined ? args : continued(args)), context);
  const images = /** @type {{ data: string, mimeType: string }[]} */ ([]);
  const json = /** @type {Record<string, unknown>} */ (pictured(withoutPending(answer), images));
  return { ...told({ ...noteOf(readLines(answer)), ...json }, { links: recordLinks(answer), ...(answer.span === undefined ? {} : { span: answer.span }) }), images };
}

export const PAGE_CHARS = 13_000;
export const PAGE_MOST = MAX_CHARS - 1_000;
export const PAGES_JOINED = 6;
const STRETCHES = new Set(['lines', 'brief', 'screen']);

/**
 * @param {any} first
 * @param {Context} context
 * @returns {Promise<any>}
 */
export async function joinedPages(first, context) {
  let page = first;
  for (let pages = 1; pages < PAGES_JOINED && STRETCHES.has(page.what) && typeof page.next === 'string' && modelChars(page) < PAGE_CHARS; pages++) {
    /** @type {any} */
    let on;
    try {
      on = await context.read('/v1/read', { cursor: page.next });
    } catch {
      break;
    }
    if (on?.what !== page.what) break;
    const both = asOne(page, on);
    if (modelChars(both) > PAGE_MOST) break;
    page = both;
  }
  return page;
}

/**
 * @param {any} first
 * @param {any} second
 */
function asOne(first, second) {
  /** @type {Map<string, { day: string, why: string }>} */
  const pending = new Map([...first.pending ?? [], ...second.pending ?? []].map(each => [each.day, each]));
  const more = Math.max(first.pending_more ?? 0, second.pending_more ?? 0);
  const fresh = {
    ...(pending.size === 0 ? {} : { pending: [...pending.values()].sort((left, right) => (left.day < right.day ? 1 : -1)) }),
    ...(more === 0 ? {} : { pending_more: more }),
    ...(first.freshness === undefined ? {} : { freshness: first.freshness }),
  };
  const span = { from: first.span.from, to: second.span.to };
  if (first.what !== 'brief') return { ...second, span, lines: [...first.lines, ...second.lines], ...fresh };
  const [last, ...before] = [...first.days].reverse();
  const [next, ...after] = second.days;
  const days = last !== undefined && next !== undefined && last.day === next.day
    ? [...before.reverse(), { ...last, lines: [...last.lines, ...next.lines] }, ...after]
    : [...first.days, ...second.days];
  return { ...second, span, days, ...fresh };
}

/** @param {unknown} answer */
export function modelChars(answer) {
  return JSON.stringify(withoutPending(answer)).length;
}

/**
 * @param {unknown} value
 * @param {{ data: string, mimeType: string }[]} images
 * @returns {unknown}
 */
function pictured(value, images) {
  if (Array.isArray(value)) return value.map(each => pictured(each, images));
  if (value === null || typeof value !== 'object') return value;
  const object = /** @type {Record<string, unknown>} */ (value);
  return Object.fromEntries(Object.entries(object).map(([key, inner]) => [key,
    key === 'image' && object.what === 'photo' && typeof inner === 'string' ? pictureOf(inner, images) : pictured(inner, images)]));
}

/**
 * @param {string} image
 * @param {{ data: string, mimeType: string }[]} images
 */
function pictureOf(image, images) {
  const made = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/u.exec(image);
  if (made === null) return `no: ${image}`;
  images.push({ data: /** @type {string} */ (made[2]), mimeType: /** @type {string} */ (made[1]) });
  return `yes, image ${images.length}`;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
export function recordLinks(value) {
  /** @type {string[]} */
  const held = [];
  /** @param {unknown} each */
  const walk = each => {
    if (Array.isArray(each)) return each.forEach(walk);
    if (each === null || typeof each !== 'object') return;
    const object = /** @type {Record<string, unknown>} */ (each);
    for (const member of ['link', 'text']) if (typeof object[member] === 'string') held.push(/** @type {string} */ (object[member]));
    Object.values(object).forEach(walk);
  };
  walk(value);
  return linksIn(held);
}

/**
 * @param {any} answer
 * @returns {import('./search.mjs').Line[]}
 */
export function readLines(answer) {
  const opened = answer.what === 'refs' ? answer.opened : [answer];
  const unopened = Array.isArray(answer.unopened) ? answer.unopened.length : 0;
  const pending = [...new Set(opened.flatMap((/** @type {any} */ each) => pendingLines(each.pending, each.pending_more, each.span)
    .map(line => line.join(''))))];
  return [
    ...(answer.span === undefined ? [] : [[`${answer.span.from} to ${answer.span.to}`]]),
    ...opened.flatMap((/** @type {any} */ each) => (each.what === 'row' && typeof each.now === 'number' && each.now !== each.n
      ? [[`this row counted ${each.n} when it was given and counts ${each.now} now: the record moved since; the rows are of now`]] : [])),
    ...opened.flatMap((/** @type {any} */ each) => (each.what === 'gone' ? [['a ref is gone: ', each.why]] : [])),
    ...(unopened === 0 ? [] : [[`${unopened} ${unopened === 1 ? 'ref was' : 'refs were'} not opened in this call (\`unopened\`): read ${unopened === 1 ? 'it' : 'them'} again`]]),
    ...pending.map(line => [line]),
    ...(typeof answer.next === 'string' ? [[STRETCHES.has(answer.what) || answer.what === 'raw'
      ? '`next` reads on: a question about the whole span reads every page to the end' : '`next` reads on']] : []),
  ];
}

export const read = readTool({ links: false });
