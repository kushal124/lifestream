// @ts-check
import { z } from 'zod';
import { argumentError } from '../errors.mjs';
import { Hidden } from '../pieces.mjs';

/**
 * @typedef {import('../door.mjs').Door} Door
 * @typedef {{ text: string, bold?: true }[]} Bolded
 * @typedef {{ id: string, kind: 'narrowed', reader: string, words: Bolded, undo: { access: unknown, expect: number } }
 *   | { id: string, kind: 'unchanged', reader: string, words: string }
 *   | { id: string, kind: 'asked', snapshot: { id: string, head: string } & Record<string, unknown> }} AccessChange
 * @typedef {{ account: string, name: string, line: string | null }} Account
 * @typedef {{ id: string, name: string, kind: 'chat' | 'agent', access: unknown, version: number,
 *   view: { sentence: Bolded, categories: { type: string, name: string, accounts: Account[] }[] } }} Reader
 * @typedef {{ door: Door, chat: string, changed: (change: AccessChange) => void }} Context
 */

export const AGENTS_ROUTE = '/v1/agents';

export const SHAPE = [
  'An access is {"allow": [{"reach": R, "window": W, "until_ms": null}], "items": [], "not": [], "only": [], "window": W, "hide": H, "shown": []}, every member written.',
  'R is {"all": true, "but": [categories]}, {"type": category, "but": [accounts]} or {"account": account, "but": []}. An allow\'s `until_ms` ends it at that instant; null keeps it.',
  'W is null for all time, {"past_ms": n} for the past n milliseconds, or {"since_ms": n} from an instant; the access\'s own `window` limits every allow.',
  'H is "names" (names shown, other details hidden), "all" (every detail hidden) or "none" (nothing hidden); Chat\'s own access keeps "none".',
  '`items`, `not`, `only` and `shown` stay empty: an access names categories, accounts, time and hiding, never a person or a chat.',
].join('\n');

const BOTH = 'To change an access, give `reader`, the `version` you read and the whole new `access` together.';

export const agents = {
  name: 'agents',
  description: [
    'Read which agents may read this Lifestream and what each reads, or change one agent\'s access when the person asks you to.',
    'With no `access`: every reader (each agent, and Chat), its access in words and as JSON, its version, and the categories',
    'and accounts an access can name; `reader` alone reads that one. To change one: `reader`, the `version` you read, and',
    '`access`, the whole new access as JSON. A narrowing (less to read, a shorter time, more hidden) applies at once; a',
    'widening waits for the person\'s Allow on their iPhone or Mac, and nothing changes until they tap it.',
  ].join(' '),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  writes: (/** @type {{ access?: string }} */ args) => args.access !== undefined,
  inputSchema: {
    reader: z.string().min(1).max(64).optional().describe('A reader\'s id as this tool gave it: `ask` for Chat, `p-…` for an agent.'),
    version: z.number().int().min(0).optional().describe('The version of the reader\'s access you read, given with `access`.'),
    access: z.string().min(1).max(20_000).optional().describe('The reader\'s whole new access, as JSON in the shape this tool\'s read gives.'),
  },
  /**
   * @param {{ reader?: string, version?: number, access?: string }} args
   * @param {Context} context
   * @returns {Promise<{ lines: (string | Hidden)[] }>}
   */
  async run({ reader, version, access }, { door, chat, changed }) {
    const asking = door.forModel(chat);
    if (access === undefined) {
      if (version !== undefined) throw argumentError(BOTH);
      return { lines: await readersOf(asking, reader) };
    }
    if (reader === undefined || version === undefined) throw argumentError(BOTH);
    const proposed = parsed(access);
    /** @type {AccessChange} */
    const change = await asking.post(`${AGENTS_ROUTE}/${encodeURIComponent(reader)}/propose`, { access: proposed, expect: version });
    changed(change);
    return { lines: [toldOf(change)] };
  },
};

/**
 * @param {Door} door
 * @param {string | undefined} only
 * @returns {Promise<(string | Hidden)[]>}
 */
async function readersOf(door, only) {
  /** @type {{ readers: { id: string, name: string, state: 'connected' | 'disconnected', summary: string }[] }} */
  const list = await door.json(AGENTS_ROUTE);
  const rows = list.readers.filter(each => only === undefined || each.id === only);
  if (only !== undefined && rows.length === 0) {
    /** @type {{ id: string, name: string, state: 'connected' | 'disconnected', disconnected: string | null }} */
    const off = await door.json(`${AGENTS_ROUTE}/${encodeURIComponent(only)}`);
    rows.push({ id: off.id, name: off.name, state: off.state, summary: off.disconnected ?? '' });
  }
  /** @type {Reader[]} */
  const readers = await Promise.all(rows.filter(each => each.state === 'connected').map(each => door.json(`${AGENTS_ROUTE}/${encodeURIComponent(each.id)}`)));
  /** @type {Map<string, string>} */
  const accounts = new Map();
  /** @type {Map<string, string>} */
  const categories = new Map();
  for (const each of readers) {
    for (const category of each.view.categories) {
      categories.set(category.type, category.name);
      for (const one of category.accounts) accounts.set(one.account, `${category.name}, ${one.name}${one.line === null ? '' : ` ${one.line}`}`);
    }
  }
  const gone = rows.filter(each => each.state === 'disconnected');
  return [
    only === undefined ? 'Every reader of this Lifestream and its access now.' : 'This reader and its access now.',
    ...readers.flatMap(each => [
      '',
      `${each.name} (reader ${each.id}, ${each.kind === 'chat' ? 'Chat itself' : 'an agent'}, version ${each.version}): ${plain(each.view.sentence)}`,
      `access: ${JSON.stringify(each.access)}`,
    ]),
    ...gone.flatMap(each => ['', `${each.name} (reader ${each.id}, an agent): ${each.summary}. It reads nothing, and its access can't change: to read again it signs in again.`]),
    '',
    `Categories: ${[...categories].map(([type, name]) => `${type} (${name})`).join(', ') || 'none yet'}.`,
    `Accounts: ${[...accounts].map(([account, name]) => `${account} (${name})`).join('; ') || 'none yet'}.`,
    '',
    new Hidden(SHAPE),
  ];
}

/** @param {string} access */
function parsed(access) {
  try {
    return JSON.parse(access);
  } catch (error) {
    throw argumentError(`\`access\` is not JSON (${error instanceof Error ? error.message : String(error)}): write the whole access as JSON and ask again.`);
  }
}

/** @param {AccessChange} change */
function toldOf(change) {
  if (change.kind === 'narrowed') return `${plain(change.words)} Applied now; the person sees this line with Undo.`;
  if (change.kind === 'asked') return `${change.snapshot.head} This widens the access, so it waits for the person: they answer Allow or No on their iPhone or Mac, and nothing changes until they do. The person sees the card under your answer.`;
  return change.words;
}

/** @param {Bolded} bolded */
function plain(bolded) {
  return bolded.map(run => run.text).join('');
}
