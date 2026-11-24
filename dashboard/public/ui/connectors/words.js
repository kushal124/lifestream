// @ts-check
/** @import { HostAct, HostNeed, HostNeedAct } from '../../lib/host.js' */
/** @import { ConnectorReport, Road } from '../../types.js' */

/** @typedef {'mac' | 'iphone' | 'chrome' | 'online' | 'file'} PlaceKey */
/**
 * @typedef {{ key: PlaceKey, word: string, icon: string, road: Road }} Place
 * @type {Place[]}
 */
export const PLACES = [
  { key: 'mac', word: 'Mac', icon: 'work-mac', road: 'mac' },
  { key: 'iphone', word: 'iPhone', icon: 'phone-screen', road: 'phone' },
  { key: 'chrome', word: 'Chrome', icon: 'web', road: 'chrome' },
  { key: 'online', word: 'Online', icon: 'online', road: 'poll' },
  { key: 'file', word: 'File', icon: 'file', road: 'upload' },
];

export const FILE_PLACE = /** @type {Place} */ (PLACES.find(place => place.key === 'file'));

export const PAGE = { title: 'Connectors', search: 'Search connectors', where: 'Where', everywhere: 'Everywhere',
  start: 'Start with these', imports: 'Imports', connect: 'Connect', none: 'No connectors match.', one: 'connector',
  connected: 'Connected', notConnected: 'Not connected', noneConnected: 'Nothing connected yet.',
  failed: 'Couldn’t load connectors.', elsewhere: 'Connectors show here once Lifestream has started.' };


/** @param {ConnectorReport} connector */
export const placesOf = connector => PLACES.filter(place => connector.roads.includes(place.road));

export const FACES_NOTICE = 'https://github.com/deepinsight/insightface#license';
export const FACES_MODEL = 'Uses InsightFace’s face model.';
export const FACES_NOTICE_LINK = 'Its notice';
export const FACES_PRIVACY = 'The face index stays on this Mac; names can show in captions your model writes.';

export const ENTRY = { name: 'Not here?', line: 'Your coding agent can build it on your Mac.', icon: 'coding-agent', copy: 'Copy line' };

/** @typedef {{ need: string, do: 'try' | 'skip' | 'let-go' | 'read' | 'ignore' | 'dismiss', of?: string } | { need: string, do: 'choose', account: string }} HomeAct */

/**
 * @typedef {{ host: HostAct, holds?: { connector: string, member: string } } | { home: HomeAct } | { open: string, push?: true } | { page: string } | { theme: 'system' | 'light' | 'dark' } | { back: true } | { guide: import('../agents/guides.js').GuideDo } | { fold: 'removed' | 'adding' | 'alerts' } | { copy: string } | { dismiss: string } | { form: string } | { refresh: string } | { typed: { key: string, value: string } } | { save: 'openrouter' | 'address' | 'name' } | { ask: string } | { rest: 'toggle' } | { link: string } | { reread: import('./settings.js').ReadFailed['reread'] } | { edit: import('../../types.js').Edit } | { editor: 'save' | 'cancel' | 'done' | 'allow' | 'undo' } | { since: string } | { answer: import('../../types.js').AnswerRequest } | { earlier: string } | { kind: string } | { things: string } | { disconnect: string } | { unlist: string } | { at: string } | { to: { view: string, patch: Record<string, string> } } | { feedback: { connector: string, name: string } } | { flow: import('../flows/model.js').FlowId, then?: string, make?: boolean }} Do
 * @typedef {{ label: string, tone?: 'neutral' | 'caution' | 'warning', variant?: 'primary' | 'secondary' | 'plain', out?: boolean, disabled?: boolean, busy?: boolean, keys?: string, do: Do }} Act
 */

/**
 * @param {{ id: string }[]} grants
 * @param {string} label
 * @returns {Act}
 */
export const allow = (grants, label) => ({
  label, tone: 'caution', do: { host: { act: 'allow', grants: grants.map(grant => grant.id) } },
});

/**
 * @param {HostNeed} need
 * @param {HostNeedAct} button
 * @returns {Act}
 */
export const needAct = (need, button) => ({
  label: button.label, tone: button.tone, do: { host: { act: 'need', need: need.id, button: button.id } },
});

/**
 * @param {string} label
 * @param {string[]} ids
 * @param {boolean} on
 * @returns {Act}
 */
export const turn = (label, ids, on) => ({ label, do: { host: { act: 'turn', sources: ids, on } } });

export const DETAIL = { comes: 'Comes from', settings: 'Settings', ai: 'AI', history: 'History', reads: 'What it reads', where: 'Where it reads',
  disconnect: 'Disconnect', cancel: 'Cancel', or: 'Or', reading: 'Reading your history', closeable: 'you can close this.',
  dropHere: 'Drop it here', file: 'A file you download', signInNote: 'Kept encrypted on your Mac.' };

/**
 * @param {string} name
 * @param {[string, string] | null} noun
 */
export const disconnectWords = (name, noun) => ({ question: `Disconnect ${name}?`,
  detail: noun ? `Lifestream will stop getting new ${noun[1]}. ${noun[1].charAt(0).toUpperCase()}${noun[1].slice(1)} already in Lifestream won’t be deleted.`
    : `Lifestream will stop getting anything new from ${name}. What’s already in Lifestream won’t be deleted.` });
