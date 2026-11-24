// @ts-check
import { count } from '../../lib/words.js';
import { handleValue, productIcon, productName } from '../../lib/kinds.js';

export { handleValue };

/**
 * @typedef {{ id: string, kind: 'phone' | 'email' | 'jid' | 'network', network: string | null, words: string, from: string | null, own?: boolean }} Handle
 * @typedef {{ id: string, kind: 'handle' | 'full_name' | 'same' | 'entity' | 'work' | 'birthday' | 'profile', value: string, reasons: Record<string, number>, ticked?: boolean }} Suggestion
 * @typedef {{ crop: string } | { card: string }} Photo
 * @typedef {{ id: string, name: string, photo: Photo | null, handles: string[], with: string[] }} Joined
 * @typedef {object} Person
 * @property {string} id
 * @property {string} name
 * @property {string} [call_name]
 * @property {string | null} [full_name]
 * @property {'name' | 'full_name'} [show]
 * @property {string} by
 * @property {string | null} person
 * @property {'person' | 'ai' | 'business' | 'bot'} [entity]
 * @property {'you' | 'home'} [entity_by]
 * @property {string | null} [relationship]
 * @property {string} [work]
 * @property {import('../../lib/details.js').Details} [details]
 * @property {boolean} [me]
 * @property {{ name: string, from: string }[]} [also_called]
 * @property {Joined[]} [joined]
 * @property {number} [suggested]
 * @property {boolean} [hidden]
 * @property {boolean} [organised]
 * @property {boolean} [card]
 * @property {Photo | null} [photo]
 * @property {number} [score]
 * @property {Handle[]} handles
 * @property {string[]} networks
 * @property {{ key: string, count: number }[]} chats
 * @property {number} received
 * @property {number} sent
 * @property {number} [mails_from]
 * @property {number} [mails_to]
 * @property {number | null} first_ms
 * @property {number | null} last_ms
 * @property {number} last_30
 * @property {number} days_count
 * @property {number} [last_day]
 * @property {Record<string, number>} [days]
 * @property {Suggestion[]} [suggestions]
 * @property {string[]} [names_seen]
 * @property {object | null} [record]
 * @property {true} [counting]
 * @typedef {object} Chat
 * @property {string} key
 * @property {string} network
 * @property {string} chat
 * @property {boolean} group
 * @property {string} label
 * @property {number} total
 * @property {number} mine
 * @property {number} first_ms
 * @property {number} last_ms
 * @property {Quiet | null} [quiet]
 * @property {boolean | null} [word]
 * @typedef {{ why: 'owner' | 'archived' | 'silent', last_day: string | null }} Quiet
 * @typedef {{ queue: string[], organised: number, often: number, businesses: { id: string, reasons: Record<string, number> }[] }} Organise
 * @typedef {{ position: string, people: Person[], you?: Person | null, chats: Chat[], organise: Organise, others: number }} People
 * @typedef {{ image: string, face: string, box: number[], at_ms: number | null, crop: string | null, camera?: boolean }} PhotoFace
 * @typedef {{ position: string, photos: PhotoFace[], total: number, next?: string }} Photos
 */

/** @param {string} network */
export const networkWords = network => productName(network);

/** @param {Handle} handle */
export const handleWords = handle => handle.words;


/** @param {Handle[]} handles */
export function yourHandles(handles) {
  const kind = (/** @type {Handle} */ handle) => handle.kind === 'phone' || handle.kind === 'jid' ? 0 : handle.kind === 'email' ? 1 : 2;
  return handles.map((handle, at) => ({ handle, at }))
    .sort((a, b) => Number(!a.handle.own) - Number(!b.handle.own) || kind(a.handle) - kind(b.handle) || a.at - b.at)
    .map(each => each.handle);
}

/** @param {{ organised: number, often: number, queue: number }} organise */
export const organiseLine = ({ organised, often, queue }) => often > 0
  ? `${count(organised)} organised · ${count(often)} more you talk to often` : `${count(organised)} organised · ${count(queue)} more`;

/** @param {Handle} handle */
export const handleFrom = handle => handle.from ?? (handle.network ? productName(handle.network)
  : handle.kind === 'email' ? 'In your mail' : 'In your messages');

/** @param {Pick<Handle, 'kind' | 'network'>} handle */
export const handleIcon = handle => handle.kind === 'email' ? 'mail' : handle.kind === 'phone' ? 'call'
  : handle.network ? productIcon(handle.network) : 'message';

/** @param {string[]} words */
export const listWords = words => words.length < 2 ? words.join('')
  : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;

export const GROUPS_SHOWN = 5;

/** @type {{ value: 'rule' | 'always' | 'never', words: string, quiet: boolean | null }[]} */
export const GROUP_WORDS = [
  { value: 'rule', words: 'Follow the rule', quiet: null },
  { value: 'always', words: 'Always quiet', quiet: true },
  { value: 'never', words: 'Never quiet', quiet: false },
];

/** @param {Person} person */
export const isNamed = person => person.by !== 'none';
