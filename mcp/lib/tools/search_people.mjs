// @ts-check
import { continued, inputSchemaOf } from '../params.mjs';
import { told } from '../shape.mjs';
import { noteOf } from './search.mjs';

/** @typedef {import('../tools.mjs').Context} Context */


const SCHEMA = inputSchemaOf('/v1/people/search');

export const searchPeople = {
  name: 'search_people',
  description: 'Who or what a name is: a person (one, however many numbers, addresses and chat ids they have), a group, a business or a bot. Give `name` (a name, nickname, part of one, a near spelling, a number or an address) or `id` (a handle). Each match: its handle (pass it as `person` or `chat`), its names, its chats with how much each holds, and per family how much there is with the first and last day. Several match: all, most in touch first; contacts that share a name are `tied`, and `note` says which was in touch when. `same` lists entries likely the same human: pass them all as `person`. None: what else goes by the name (a place, a payee, an app, a chat\'s title, the word itself). The person themself is `the_user`.',
  inputSchema: SCHEMA,
  route: '/v1/people/search',
  /**
   * @param {{ name?: string, id?: string, cursor?: string }} args
   * @param {Context} context
   * @returns {Promise<import('../hiding.mjs').Routed>}
   */
  async run(args, context) {
    const params = args.cursor === undefined ? Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined)) : continued(args);
    const { note, ...answer } = await context.read('/v1/people/search', params);
    return told({ ...noteOf(peopleLines({ note, ...answer })), ...answer });
  },
};

/**
 * @param {{ note?: string, matches: unknown[], elsewhere?: { capped?: boolean }[], capped?: boolean, next?: string | null }} answer
 * @returns {import('./search.mjs').Line[]}
 */
export function peopleLines(answer) {
  const { matches, elsewhere = [] } = answer;
  return [
    ...(typeof answer.note === 'string' ? [[answer.note.replace(/\.$/u, '')]] : []),
    ...(matches.length > 0 || typeof answer.note === 'string' ? [] : [[elsewhere.length === 0 ? 'No person goes by this name' : 'No person goes by this name whole; what else does is in `elsewhere`']]),
    ...(elsewhere.some(each => each.capped === true) ? [['an `elsewhere` count marked `capped` stopped at its budget: at least that many']] : []),
    ...(answer.capped === true ? [['the read stopped at its budget: the matches with no `reach` were not counted, and follow those counted in People\'s order; `next` goes on']]
      : typeof answer.next === 'string' ? [['more match: `next` gives the next page']] : []),
  ];
}
