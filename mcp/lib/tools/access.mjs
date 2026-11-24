// @ts-check
import { z } from 'zod';
import { DoorRefusal, ToolError } from '../errors.mjs';

/** @typedef {import('../tools.mjs').Context} Context */

export const ACCESS_ROUTE = '/v1/access';
export const REQUEST_ROUTE = '/v1/access/request';
export const DROP_ROUTE = '/v1/access/drop';
export const ONE_OF = 'Call `access` with nothing to read your access, with `request` and `reason` to ask for more, or with `drop` (and, for a line, the `version` you read) to drop a line or your request.';

const READ = z.union([
  z.literal('everything'),
  z.object({ category: z.string().describe('A category: messages, mail, calls, health, money…') }).strict(),
  z.object({ product: z.string().describe('A product as the record names it: whatsapp, gmail…') }).strict(),
  z.object({ account: z.string().describe('One account, as an answer gave it, placeholder and all.') }).strict(),
]);

export const access = {
  name: 'access',
  description: [
    'Your access to this Lifestream: what you may read, and how to change it. With no arguments: your access as numbered',
    'lines and as data, your open request, and your person\'s answer to your last one. With `request` and `reason`: ask your',
    'person for more; they answer on their Mac or iPhone, and the next `access` says what they said. With `drop`: give up',
    'a line by its number with the version `access` gave, everything you read, or your open request, at once.',
  ].join(' '),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  fixed: true,
  asWritten: true,
  inputSchema: {
    request: z.object({
      read: READ.describe('"everything", {category}, {product} or {account}.'),
      since: z.string().optional().describe('From this day on, as 2026-11-01.'),
      past: z.string().optional().describe('Only the past span, as 24h or 7d.'),
    }).strict().optional().describe('What you ask to read: one want.'),
    for: z.string().optional().describe('How long: from 5m to 7d, or always. Unstated, 1h.'),
    reason: z.string().optional().describe('Why you ask, in one line of at most 300 characters: your person reads it on the card.'),
    drop: z.union([z.number().int().positive(), z.literal('everything'), z.literal('request')]).optional()
      .describe('A line\'s number, everything, or request (your open request).'),
    version: z.number().int().nonnegative().optional().describe('The version `access` gave you: a line\'s number counts in it.'),
  },
  /**
   * @param {{ request?: Record<string, unknown>, for?: string, reason?: string, drop?: number | 'everything' | 'request', version?: number }} args
   * @param {Context} context
   * @returns {Promise<string>}
   */
  async run(args, { door }) {
    const asks = args.request !== undefined || args.reason !== undefined || args.for !== undefined;
    if ((asks && args.drop !== undefined) || (args.version !== undefined && args.drop === undefined)) throw new ToolError(ONE_OF);
    try {
      if (args.drop !== undefined) {
        /** @type {{ words: string, now: { text: string } }} */
        const dropped = await door.post(DROP_ROUTE, { drop: args.drop, ...(args.version === undefined ? {} : { version: args.version }) });
        return `${dropped.words}\n\n${dropped.now.text}`;
      }
      if (asks) {
        if (args.request === undefined || args.reason === undefined) throw new ToolError(ONE_OF);
        /** @type {{ words: string }} */
        const asked = await door.post(REQUEST_ROUTE, { request: args.request, reason: args.reason, ...(args.for === undefined ? {} : { for: args.for }) });
        return asked.words;
      }
      /** @type {{ text: string, version: number, lines: string[], request: unknown, answer: unknown, outside: string[] }} */
      const own = await door.json(ACCESS_ROUTE);
      return `${own.text}\n\n${JSON.stringify({ version: own.version, lines: own.lines, request: own.request, answer: own.answer, outside: own.outside })}`;
    } catch (error) {
      if (error instanceof DoorRefusal && (error.status === 422 || error.status === 404 || error.status === 409)) throw new ToolError(error.said);
      throw error;
    }
  },
};
