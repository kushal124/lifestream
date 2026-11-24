// @ts-check
import { z } from 'zod';

/** @typedef {import('../tools.mjs').Context} Context */

const CATEGORIES = /** @type {const} */ (['missing', 'wrong', 'confusing', 'slow', 'error', 'other']);
export const FULL = 'Today\'s notes are full; this one was not kept.';

export const feedback = {
  name: 'feedback',
  description: [
    'Save a note for the owner of this Lifestream about what would have made your work easier: a tool, field or filter',
    'you needed, a result that was wrong or hard to read, a call that failed or was slow. Use it whenever you hit',
    'friction, even if you found a way around it. Say what you tried, what you expected, and what happened. Quote as',
    'little of their records as you can.',
  ].join(' '),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  keepsUnknown: true,
  fixed: true,
  inputSchema: {
    category: z.enum(CATEGORIES).describe('missing: a tool, field or filter you needed; wrong: a result that was wrong or misleading; confusing: a tool or answer hard to read; slow; error: a call failed; other.'),
    message: z.string().min(1).max(2_000).describe('What you tried, what you expected, and what happened: 1 to 2,000 characters.'),
    tool: z.string().max(64).optional().describe('The tool you were using, if any.'),
  },
  /**
   * @param {{ category: (typeof CATEGORIES)[number], message: string, tool?: string }} args
   * @param {Context} context
   */
  async run({ category, message, tool }, { door }) {
    const { outcome } = await door.post('/v1/feedback', { category, message, ...(tool === undefined ? {} : { tool }) });
    return outcome === 'full' ? FULL : 'Saved.';
  },
};
