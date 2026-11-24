// @ts-check
/** @import { AgentAsk, AgentGuides, AgentRow } from '../../types.js' */
/** @import { HostState } from '../../lib/host.js' */
import { agentDialog, CONNECT_ID } from './detail.js';
import { GUIDE_PAGE } from './guides.js';
import { PAGE } from './words.js';

/** @typedef {{ id: string, name: string, icon: string, line: string, place: string, when: string, review: string, dim: boolean, opens: string }} ListRow */

/** @typedef {{ name: string, count: number, rows: ListRow[] }} ListSection */

/** @typedef {{ name: string, mark: string, line: string, connected: boolean, opens: string }} GuideRow */

/** @typedef {{ title: string, rows: GuideRow[] }} GuidesList */

/**
 * @typedef {object} AgentsList
 * @property {ListSection[]} sections
 * @property {GuidesList | null} guides
 * @property {boolean} adds
 */

/**
 * @param {AgentRow} reader
 * @returns {string}
 */
const iconOf = reader => reader.mark || (reader.kind === 'chat' ? 'chat' : 'ai-apps');

/**
 * @param {AgentRow} reader
 * @returns {ListRow}
 */
const rowOf = reader => ({ id: reader.id, name: reader.name, icon: iconOf(reader), line: reader.summary, place: reader.place,
  when: reader.state === 'disconnected' ? '' : reader.reads.last ?? '', review: '', dim: reader.state === 'disconnected',
  opens: agentDialog(reader.id) });

/**
 * @param {string} name
 * @param {ListRow[]} rows
 * @returns {ListSection[]}
 */
const sectionOf = (name, rows) => rows.length ? [{ name, count: rows.length, rows }] : [];

/**
 * @param {AgentGuides} guides
 * @returns {GuidesList}
 */
export const guidesList = guides => ({ title: guides.title, rows: guides.apps.map(guide => ({ name: guide.name,
  mark: guide.mark, line: guide.line ?? '', connected: guide.connected !== null,
  opens: guide.connected ? agentDialog(guide.connected) : `${CONNECT_ID}/${GUIDE_PAGE}${guide.app}` })) });

/**
 * @param {object} read
 * @param {AgentRow[]} read.readers
 * @param {HostState | null} read.state
 * @param {AgentGuides | null} [read.guides]
 * @returns {AgentsList}
 */
export function agentsList({ readers, state, guides = null }) {
  /** @param {AgentAsk} ask @returns {ListRow[]} */
  const asked = ask => {
    const reader = readers.find(each => each.id === ask.reader);
    return reader ? [{ ...rowOf(reader), id: ask.id, name: ask.name, line: ask.line, when: '', review: `ask:${ask.id}` }] : [];
  };
  const agents = readers.filter(each => each.kind !== 'chat');
  const connected = agents.filter(each => each.state === 'connected');
  const needs = state ? state.agent_asks.flatMap(asked)
    : connected.filter(each => each.has_ask).map(each => ({ ...rowOf(each), line: PAGE.asking, when: '', review: agentDialog(each.id) }));
  return {
    sections: [
      ...sectionOf(PAGE.needs, needs),
      ...sectionOf(PAGE.connected, connected.map(rowOf)),
      ...sectionOf(PAGE.inLifestream, readers.filter(each => each.kind === 'chat').map(rowOf)),
      ...sectionOf(PAGE.disconnected, agents.filter(each => each.state === 'disconnected').map(rowOf)),
    ],
    guides: connected.length || !guides ? null : guidesList(guides),
    adds: connected.length > 0,
  };
}
