// @ts-check
/** @import { Handle } from './words.js' */
/** @import { Person as PersonPage, Row as ListRow, Talk, When } from '../../pages.js' */
/** @import { Lead } from '../kit/name-row.js' */
/** @import { Birthday, Details, Profile } from '../../lib/details.js' */
import { attributes, esc } from '../../lib/html.js';
import {
  inPlaceLine, ARRIVES, bar, button, calendarPicker, fieldRow, fieldRowMenu, floatList, formAct, formAdd, formCard, icon,
  iconButton, nameRow, nameRowCardReading, personFace, personFaceReading, sectionLabel,
} from '../kit/index.js';
import { productName } from '../../lib/kinds.js';
import { today as homeToday } from '../../lib/home-clock.js';
import { count, counted, sinceWords } from '../../lib/words.js';
import {
  birthdayOf, birthdayWords, NETWORKS, changedDetails, noDetails, profileGlyph, profileWords, sameProfile, suggestedProfile,
} from '../../lib/details.js';
import { rowFace, rowLine } from './list.js';
import { handleWords, listWords, yourHandles } from './words.js';

/**
 * @typedef {Omit<PersonPage['edit']['suggestions'][number], 'reasons'> & { reasons: Record<string, number> }} Suggestion
 * @typedef {PersonPage['edit']['joined'][number]} Joined
 * @typedef {object} Person
 * @property {string} id
 * @property {string} name
 * @property {boolean} named
 * @property {string | null} call
 * @property {string | null} full_name
 * @property {'name' | 'full_name'} show
 * @property {string | null} name_from
 * @property {string | null} relationship
 * @property {Details | null} details
 * @property {'person' | 'ai' | 'business' | 'bot'} entity
 * @property {'you' | 'home' | null} entity_by
 * @property {boolean} me
 * @property {string | null} record
 * @property {boolean} face
 * @property {string | null} photo
 * @property {Handle[]} handles
 * @property {Suggestion[]} suggestions
 * @property {{ name: string, from: string }[]} also_called
 * @property {Joined[]} joined
 * @property {string[]} names_seen
 * @property {string | null} reach
 * @property {When | null} since
 * @property {When | null} last
 * @property {string} much
 * @property {number} month
 * @property {PersonPage['edit']['mails']} mails
 * @property {Talk | null} talk
 * @property {PersonPage['where']} where
 */

/**
 * @param {string} asked
 * @param {PersonPage} page
 * @returns {Person}
 */
export const editPersonOf = (asked, { became, me, head, handles, edit, month, talk, where }) => ({
  id: became ?? asked, name: head.name, named: head.named, call: edit.call, full_name: edit.full_name, show: edit.record?.show ?? 'name',
  name_from: edit.name_from, relationship: head.relationship, details: /** @type {Details | null} */ (edit.details), entity: head.entity, entity_by: head.entity_by, me,
  record: edit.record_id, face: edit.face, photo: head.photo, handles,
  suggestions: edit.suggestions.map(each => ({ ...each, reasons: Object.fromEntries(each.reasons.map(({ reason, count: n }) => [reason, n])) })),
  also_called: edit.also_called, joined: edit.joined, names_seen: edit.names_seen, reach: edit.reach, since: head.since, last: edit.last,
  much: edit.much, month: month.count, mails: edit.mails, talk, where,
});

/**
 * @param {Pick<Person, 'name' | 'named' | 'photo'>} person
 * @param {import('../kit/person-face.js').FaceSize} [size]
 */
export const faceOf = (person, size = 'md') => personFace({ name: person.named ? person.name : null, photo: person.photo ?? '', size });

/** @param {When | null} when */
export const sinceLine = when => when ? `since ${sinceWords(when)}` : '';

/** @typedef {{ id: string, faces: number, photos: number, years: [number, number] | null, sample: string[], reason: string, crops: Record<string, string> }} Group */

/** @typedef {{ key: string, kind: 'find', find: ListRow } | { key: string, kind: 'group', group: Group } | { key: string, kind: 'profile', profile: Profile }} Added */

/** @typedef {{ kind: 'person', row: ListRow } | { kind: 'profile', profile: Profile }} Find */

/** @typedef {{ name: string, full: string, rel: string, work: string }} Fields */

/**
 * @typedef {object} Card
 * @property {string} id
 * @property {Person} person
 * @property {Group[]} likely
 * @property {boolean} faces
 * @property {Fields} fields
 * @property {Fields} opened
 * @property {Suggestion | null} fill
 * @property {{ work: Suggestion | null, birthday: Suggestion | null }} fills
 * @property {Birthday | null} birthday
 * @property {Birthday | null} born
 * @property {{ birthday: boolean }} shows
 * @property {Details} details
 * @property {Set<string>} unlisted
 * @property {Map<string, boolean>} ticks
 * @property {string | null} said
 * @property {Added[]} added
 * @property {Set<string>} removed
 * @property {{ name: string, from: string }[]} called
 * @property {Set<string>} split
 * @property {string | null} made
 * @property {number} page
 * @property {number} maybe
 */

const YOU_ADDED = 'You added';

export const NAMES_MOST = 12;
export const NAME_LONGEST = 60;

/** @param {Card} card */
export const yours = card => card.person.me === true;

export const KINDS = /** @type {const} */ ([
  { value: 'ai', label: 'AI', icon: 'ai' },
  { value: 'business', label: 'A business', icon: 'work-mac' },
  { value: 'bot', label: 'An automated sender', icon: 'coding-agent' },
]);

export const KIND_LABEL = /** @type {Record<string, string>} */ (Object.fromEntries(KINDS.map(kind => [kind.value, kind.label])));

/** @param {{ id: string }} handle */
export const handleId = handle => handle.id;

/** @param {string} value */
export const otherId = value => value.includes(':') ? value : `person:${value}`;


/** @param {Suggestion} suggestion */
export const fullSource = ({ reasons }) => Object.entries(reasons).filter(([, n]) => n > 0)
  .map(([key, n]) => key === 'mail' ? counted(n, 'mail') : key === 'photos' ? PHOTO_LABELS : productName(key)).join(' · ');

export const PHOTO_LABELS = 'Photo labels';

/** @param {Suggestion} suggestion */
export const cardSource = ({ reasons }) => (reasons.cards ?? 0) > 1 ? counted(reasons.cards, 'contact card') : 'Contact card';

/** @param {Suggestion} suggestion */
export const guessed = suggestion => suggestion.kind === 'birthday' && suggestion.ticked !== true;

/** @param {Suggestion} suggestion */
export const guessSource = ({ reasons }) => (reasons.wished ?? 0) > 0 ? 'From your messages'
  : (reasons.cards ?? 0) > 1 ? `From ${counted(reasons.cards, 'contact card')}` : 'From a contact card';

/** @param {Profile} profile */
export const profileKey = profile => `${profile.network}:${profile.value}`;

/** @param {Birthday | null} left @param {Birthday | null} right */
const sameDay = (left, right) => (left === null || right === null ? left === right
  : left.month === right.month && left.day === right.day && left.year === right.year);

/** @param {Person} person */
const suggestionsOf = person => person.suggestions;

/**
 * @param {Card} card
 * @param {keyof Fields} field
 */
const sourceOf = (card, field) => field === 'name'
  ? card.person.name_from ?? ''
  : field === 'full' && card.fill ? fullSource(card.fill) : field === 'work' && card.fills.work ? cardSource(card.fills.work) : '';

/**
 * @param {Person} person
 * @param {Group[]} likely
 * @param {boolean} faces
 * @returns {Card}
 */
export function newCard(person, likely, faces) {
  const fill = person.full_name ? null : suggestionsOf(person).find(each => each.kind === 'full_name' && each.ticked === true) ?? null;
  const name = person.call ?? '';
  const details = person.details ?? noDetails();
  const work = details.work ? null : suggestionsOf(person).find(each => each.kind === 'work' && each.ticked === true) ?? null;
  const birthday = details.birthday ? null : suggestionsOf(person).find(each => each.kind === 'birthday' && each.ticked === true) ?? null;
  const opened = { name, full: person.full_name ?? fill?.value ?? '', rel: person.relationship ?? '', work: details.work ?? work?.value ?? '' };
  const born = details.birthday ?? (birthday ? birthdayOf(birthday.value) : null);
  const { entity } = person;
  /** @type {Map<string, boolean>} */
  const ticks = new Map();
  for (const suggestion of suggestionsOf(person)) {
    if (suggestion.kind === 'full_name' || suggestion.kind === 'work' || (suggestion.kind === 'birthday' && !guessed(suggestion))) continue;
    ticks.set(`o:${suggestion.id}`, suggestion.ticked === true);
  }
  for (const group of faces ? likely : []) ticks.set(`g:${group.id}`, false);
  return {
    id: person.id, person, likely: faces ? likely : [], faces, fields: { ...opened }, opened, fill, fills: { work, birthday },
    birthday: born, born, shows: { birthday: born !== null }, details, unlisted: new Set(), ticks,
    said: entity === 'person' ? null : entity, added: [], removed: new Set(), called: [...person.also_called], split: new Set(),
    made: null, page: 0, maybe: 0,
  };
}

/** @param {string} name */
export const nameFold = name => name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/gu, ' ').trim();

/** @param {Card} card */
export function namesChanged(card) {
  const served = card.person.also_called;
  const had = new Set(served.map(each => nameFold(each.name)));
  const has = new Set(card.called.map(each => nameFold(each.name)));
  return { add: card.called.filter(each => !had.has(nameFold(each.name))).map(each => each.name),
    remove: served.filter(each => !has.has(nameFold(each.name))).map(each => each.name) };
}

/**
 * @param {Card} card
 * @returns {Set<string>}
 */
export const takenBySplit = card => new Set(card.person.joined.filter(each => card.split.has(each.id))
  .flatMap(each => each.handles));

/**
 * @param {Card} card
 * @returns {Card}
 */
export const cardCopy = card => ({ ...card, fields: { ...card.fields }, shows: { ...card.shows }, ticks: new Map(card.ticks),
  added: [...card.added], removed: new Set(card.removed), unlisted: new Set(card.unlisted),
  called: [...card.called], split: new Set(card.split) });

/**
 * @param {Card} card
 * @param {Card} before
 * @returns {Card}
 */
export function cardAgain(card, before) {
  for (const field of /** @type {const} */ (['name', 'full', 'rel', 'work'])) {
    if (before.fields[field] !== before.opened[field]) card.fields[field] = before.fields[field];
  }
  for (const [row, on] of before.ticks) if (card.ticks.has(row) || row.startsWith('a:')) card.ticks.set(row, on);
  const theirs = new Set(card.person.handles.map(handleId));
  const listed = new Set(card.details.profiles.map(profileKey));
  const names = namesChanged(before);
  const off = new Set(names.remove.map(nameFold));
  const called = card.called.filter(each => !off.has(nameFold(each.name)));
  const there = new Set(called.map(each => nameFold(each.name)));
  for (const name of names.add) if (!there.has(nameFold(name))) called.push({ name, from: YOU_ADDED });
  const joined = new Set(card.person.joined.map(each => each.id));
  return { ...card, added: [...before.added], called, split: new Set([...before.split].filter(id => joined.has(id))), removed: new Set([...before.removed].filter(id => theirs.has(id))),
    unlisted: new Set([...before.unlisted].filter(key => listed.has(key))),
    birthday: sameDay(before.birthday, before.born) ? card.birthday : before.birthday,
    shows: { birthday: card.shows.birthday || before.shows.birthday },
    said: before.said, made: before.made, page: before.page };
}

/**
 * @param {Card} card
 * @param {Record<string, unknown>} action
 * @returns {string[]}
 */
export function touchedBy(card, action) {
  const answered = new Set([.../** @type {string[]} */ (action.accept ?? []), .../** @type {string[]} */ (action.decline ?? [])]);
  return [...suggestionsOf(card.person).filter(each => each.kind === 'same' && answered.has(each.id)).map(each => otherId(each.value)),
    .../** @type {string[]} */ (action.add ?? []).filter(id => id.startsWith('person:')), .../** @type {string[]} */ (action.split ?? [])];
}

/** @typedef {{ id: string, kind: 'field' } | { id: 'f:birthday', kind: 'birthday' } | { id: string, kind: 'chip', suggestion: Suggestion } | { id: string, kind: 'guess', suggestion: Suggestion } | { id: 'said', kind: 'said', value: string } | { id: 'notperson', kind: 'notperson' } | { id: 'addbirthday', kind: 'pill' } | { id: string, kind: 'handle', handle: import('./words.js').Handle } | { id: string, kind: 'profile', profile: Profile } | { id: string, kind: 'suggestion', suggestion: Suggestion } | { id: string, kind: 'group', group: Group } | { id: string, kind: 'added', added: Added } | { id: 'faces', kind: 'faces' } | { id: 'more', kind: 'more' } | { id: string, kind: 'called', called: { name: string, from: string } } | { id: 'addname', kind: 'addname' } | { id: string, kind: 'joined', joined: Joined } | { id: 'add', kind: 'add' }} Row */

/**
 * @param {Card} card
 * @returns {{ groups: Group[], people: ListRow[], joining: string[] }}
 */
export function marked(card) {
  const on = (/** @type {string} */ id) => card.ticks.get(id) === true;
  const groups = card.likely.filter(group => on(`g:${group.id}`));
  /** @type {ListRow[]} */
  const people = [];
  for (const each of card.added) {
    if (!on(`a:${each.key}`)) continue;
    if (each.kind === 'group') groups.push(each.group);
    else if (each.kind === 'find' && each.find.photo) people.push(each.find);
  }
  const same = suggestionsOf(card.person).flatMap(each => each.kind === 'same' && on(`o:${each.id}`) ? [otherId(each.value)] : []);
  return { groups, people, joining: [...people.map(person => person.id), ...same] };
}

/** @param {Card} card */
export function faced(card) {
  const { groups, people } = marked(card);
  return Boolean(card.person.photo) || card.made !== null || groups.length + people.length > 0;
}

/**
 * @param {Card} card
 * @returns {Row[]}
 */
export function rowsOf(card) {
  const you = yours(card);
  /** @type {Row[]} */
  const rows = [{ id: 'f:name', kind: 'field' }, { id: 'f:full', kind: 'field' }];
  if (!you) rows.push({ id: 'f:rel', kind: 'field' });
  rows.push({ id: 'f:work', kind: 'field' });
  rows.push(card.shows.birthday ? { id: 'f:birthday', kind: 'birthday' } : { id: 'addbirthday', kind: 'pill' });
  for (const suggestion of suggestionsOf(card.person).filter(guessed)) {
    if (card.birthday === null || card.ticks.get(`o:${suggestion.id}`)) rows.push({ id: `o:${suggestion.id}`, kind: 'guess', suggestion });
  }
  for (const called of card.called) rows.push({ id: `n:${called.name}`, kind: 'called', called });
  rows.push({ id: 'addname', kind: 'addname' });
  const taken = takenBySplit(card);
  for (const handle of you ? yourHandles(card.person.handles) : card.person.handles) {
    if (!card.removed.has(handleId(handle)) && !taken.has(handleId(handle))) rows.push({ id: `h:${handleId(handle)}`, kind: 'handle', handle });
  }
  for (const profile of card.details.profiles) {
    if (!card.unlisted.has(profileKey(profile))) rows.push({ id: `p:${profileKey(profile)}`, kind: 'profile', profile });
  }
  for (const suggestion of suggestionsOf(card.person)) {
    if (suggestion.kind === 'handle' || suggestion.kind === 'same' || suggestion.kind === 'profile') {
      rows.push({ id: `o:${suggestion.id}`, kind: 'suggestion', suggestion });
    }
  }
  for (const group of card.likely) rows.push({ id: `g:${group.id}`, kind: 'group', group });
  for (const added of card.added) rows.push({ id: `a:${added.key}`, kind: 'added', added });
  if (card.faces && !faced(card)) rows.push({ id: 'faces', kind: 'faces' });
  if (card.faces && card.maybe > 0) rows.push({ id: 'more', kind: 'more' });
  rows.push({ id: 'add', kind: 'add' });
  for (const joined of card.person.joined ?? []) if (!card.split.has(joined.id)) rows.push({ id: `j:${joined.id}`, kind: 'joined', joined });
  const suspected = you ? [] : suggestionsOf(card.person).filter(each => each.kind === 'entity');
  for (const suggestion of suspected) rows.push({ id: `o:${suggestion.id}`, kind: 'chip', suggestion });
  if (card.said !== null && !you) rows.push({ id: 'said', kind: 'said', value: card.said });
  if (!suspected.length && card.said === null && !you) rows.push({ id: 'notperson', kind: 'notperson' });
  return rows;
}

/**
 * @param {Card} card
 * @returns {Details}
 */
export function detailsOf(card) {
  const on = (/** @type {string} */ id) => card.ticks.get(id) === true;
  /** @type {Profile[]} */
  const profiles = [];
  const put = (/** @type {Profile | null} */ profile) => {
    if (profile && !profiles.some(each => sameProfile(each, profile))) profiles.push(profile);
  };
  for (const profile of card.details.profiles) if (!card.unlisted.has(profileKey(profile))) put(profile);
  for (const suggestion of suggestionsOf(card.person)) {
    if (suggestion.kind === 'profile' && on(`o:${suggestion.id}`)) put(suggestedProfile(suggestion.value));
  }
  for (const added of card.added) if (added.kind === 'profile' && on(`a:${added.key}`)) put(added.profile);
  return { work: card.fields.work.replace(/\s+/gu, ' ').trim() || null, birthday: card.birthday, profiles };
}

/** @param {Card} card */
export const firstLight = card => !suggestionsOf(card.person).length && card.likely[0] ? `g:${card.likely[0].id}` : null;

/** @param {Card} card */
export const shownName = card => card.fields.name.trim() || card.fields.full.trim() || card.person.name;

/** @param {Group} group */
export const groupCrop = group => group.crops[group.sample[0]] ?? '';

/** @param {Card} card */
export function photoNow(card) {
  if (card.made) return card.made;
  const { groups: [group], people: [other] } = marked(card);
  return card.person.photo || (group ? groupCrop(group) : other?.photo || '');
}

/**
 * @param {Card} card
 * @param {import('../kit/person-face.js').FaceSize} size
 */
export const cardFace = (card, size) => {
  const photo = photoNow(card);
  const unnamed = !card.person.named && !card.fields.name.trim() && !card.fields.full.trim();
  return personFace({ name: unnamed && !photo ? null : shownName(card), photo, size });
};

/**
 * @param {Card} card
 * @returns {Record<string, unknown>}
 */
export function answerOf(card) {
  const { fields, opened } = card;
  const ticked = (/** @type {string} */ id) => card.ticks.get(id) === true;
  /** @type {string[]} */
  const accept = [];
  /** @type {string[]} */
  const decline = [];
  for (const suggestion of suggestionsOf(card.person)) {
    if (suggestion.kind === 'full_name') {
      if (suggestion === card.fill && fields.full.trim() === suggestion.value) accept.push(suggestion.id);
    } else if (suggestion === card.fills.work) {
      const typed = fields.work.trim();
      if (typed === suggestion.value) accept.push(suggestion.id);
      else if (!typed) decline.push(suggestion.id);
    } else if (suggestion === card.fills.birthday) {
      if (sameDay(card.birthday, birthdayOf(suggestion.value))) accept.push(suggestion.id);
      else if (card.birthday === null) decline.push(suggestion.id);
    } else if (guessed(suggestion)) {
      if (ticked(`o:${suggestion.id}`) && sameDay(card.birthday, birthdayOf(suggestion.value))) accept.push(suggestion.id);
    } else if (suggestion.kind !== 'work' && suggestion.kind !== 'birthday') {
      (ticked(`o:${suggestion.id}`) ? accept : decline).push(suggestion.id);
    }
  }
  /** @type {Record<string, unknown>} */
  const action = { kind: 'confirm', id: card.id, accept, decline };
  const typed = (/** @type {'name' | 'full' | 'rel'} */ field) => fields[field].trim() || null;
  if (fields.name.trim() !== opened.name || card.person.show === 'full_name') action.name = typed('name');
  if (fields.full.trim() !== opened.full) action.full_name = typed('full');
  if (fields.rel.trim() !== opened.rel) action.relationship = typed('rel');
  const suspected = suggestionsOf(card.person).some(each => each.kind === 'entity' && ticked(`o:${each.id}`));
  if (!suspected && (card.said ?? 'person') !== card.person.entity) action.entity = card.said ?? 'person';
  const details = changedDetails(detailsOf(card), card.details);
  if (Object.keys(details).length) action.details = details;
  const add = card.added.flatMap(each => each.kind === 'find' && ticked(`a:${each.key}`) ? [each.find.id] : []);
  const groups = marked(card).groups.map(group => group.id);
  if (add.length) action.add = add;
  const taken = takenBySplit(card);
  const unlink = [...card.removed].filter(id => !taken.has(id));
  if (unlink.length) action.unlink = unlink;
  if (groups.length) action.groups = groups;
  const names = namesChanged(card);
  if (names.add.length) action.add_names = names.add;
  if (names.remove.length) action.remove_names = names.remove;
  if (card.split.size) action.split = [...card.split];
  return action;
}


/** @param {Group} group */
const groupLine = group => ['Not named yet', counted(group.photos, 'photo'), group.reason].filter(Boolean).join(' · ');


export const BUSINESS_SIGNS = /** @type {const} */ ([
  { reason: 'whatsapp', icon: 'chat', title: 'Listed as a business on WhatsApp', where: 'WhatsApp’s business accounts' },
  { reason: 'named', icon: 'work-mac', title: 'Named like a business you hear from', where: 'A sender of your mail, or a name WhatsApp verified' },
  { reason: 'relay', icon: 'mail', title: 'Mail signed by several people', where: 'One address, many senders' },
  { reason: 'cards', icon: 'person', title: 'A company, no person’s name', where: 'Your contact card' },
]);

/** @param {Card} card */
export const judgedTag = card => card.person.entity_by === 'home' && card.said === card.person.entity;

/** @param {Suggestion} suggestion */
export function suspicionWords(suggestion) {
  const n = (/** @type {string} */ key) => suggestion.reasons[key] ?? 0;
  if (suggestion.value === 'ai') {
    return { label: KIND_LABEL.ai, why: `Replies within 20 s · ${Math.round((100 * n('quick')) / Math.max(1, n('replies')))}% of ${count(n('replies'))} replies` };
  }
  return { label: KIND_LABEL[suggestion.value] ?? suggestion.value, why: businessSign(suggestion.reasons) };
}

/** @param {Record<string, number>} reasons */
export const businessSign = reasons => BUSINESS_SIGNS.find(each => (reasons[each.reason] ?? 0) > 0)?.title ?? '';

/** @param {Handle} handle */
export function handleKey(handle) {
  const key = handle.kind === 'phone' || handle.kind === 'jid' ? 'Phone' : handle.kind === 'email' ? 'Email'
    : handle.network ? productName(handle.network) : 'Account';
  const from = handle.from && handle.from !== YOU_ADDED && handle.from !== key
    ? handle.from.startsWith('Your ') ? handle.from : `From ${handle.from}` : '';
  return { key, name: handle.words === HIDDEN ? 'Number hidden' : handleWords(handle), line: from };
}

const HIDDEN = 'Hidden number';

/**
 * @param {Extract<Row, { kind: 'handle' | 'profile' | 'group' | 'added' | 'suggestion' }>} row
 * @param {Card} card
 * @param {(address: string) => string} signed
 * @returns {{ key: string, name: string, line: string }}
 */
function rowWords(row, card, signed) {
  if (row.kind === 'handle') return handleKey(row.handle);
  if (row.kind === 'profile') return profileKeyWords(row.profile, '');
  if (row.kind === 'group') return { key: 'Face', name: 'A face in your photos', line: groupLine(row.group) };
  if (row.kind === 'added') return addedWords(row.added);
  const { kind, value, reasons } = row.suggestion;
  if (kind === 'profile') {
    const profile = suggestedProfile(value);
    if (profile) return profileKeyWords(profile, cardSource(row.suggestion));
  }
  if (kind === 'same') {
    const { other } = row.suggestion;
    const colon = value.indexOf(':');
    const name = other?.name ?? (colon < 0 ? 'Another record' : value.slice(colon + 1));
    if (yours(card) && reasons.named && other?.face) return { key: 'Face', name, line: `Same person? · Both named ${name}` };
    if (other ? other.face : colon < 0 && (reasons.seen ?? 0) > 0) return { key: 'Face', name, line: 'A face you named · Same person?' };
    const theirs = card.person.full_name ?? card.fill?.value ?? card.person.name;
    const why = reasons.linked ? 'Your cards share a number or email' : reasons.named ? `Both named ${theirs}`
      : `Seen by the name ${name}`;
    return { key: 'Same as', name, line: why };
  }
  const address = value.slice(value.indexOf(':') + 1);
  const sign = signed(address);
  const mails = counted((reasons.mails_from ?? 0) + (reasons.mails_to ?? 0), 'mail');
  return { key: value.startsWith('email:') ? 'Email' : 'Phone', name: address,
    line: [sign ? `Signed “${sign}”` : yours(card) ? 'Mail in your name' : 'Mail in their name', mails].join(' · ') };
}

/**
 * @param {Profile} profile
 * @param {string} line
 */
const profileKeyWords = (profile, line) => ({ key: NETWORKS[profile.network], name: profileWords(profile, { path: true }), line });

/**
 * @param {Profile} profile
 * @param {string} line
 * @returns {{ lead: Lead, name: string, line: string }}
 */
const profileRowWords = (profile, line) => ({ lead: { icon: profileGlyph(profile.network) }, name: profileWords(profile, { path: true }), line });

/**
 * @param {Added} added
 * @returns {{ key: string, name: string, line: string }}
 */
function addedWords(added) {
  if (added.kind === 'profile') return profileKeyWords(added.profile, '');
  if (added.kind === 'group') return { key: 'Face', name: 'A face in your photos', line: counted(added.group.photos, 'photo') };
  const { id, name, face } = added.find;
  const key = id.startsWith('email:') ? 'Email' : id.startsWith('phone:') || id.startsWith('jid:') ? 'Phone' : face ? 'Face' : 'Same as';
  return { key, name, line: '' };
}

/**
 * @param {Find} find
 * @returns {{ lead: Lead, name: string, line: string }}
 */
const findWords = find => find.kind === 'profile' ? profileRowWords(find.profile, `${NETWORKS[find.profile.network]} · a profile`)
  : { lead: { face: rowFace(find.row) }, name: find.row.name, line: rowLine(find.row, homeToday()) };



/**
 * @param {object} head
 * @param {'organise' | 'edit'} head.mode
 * @param {{ at: number, of: number, words: string } | null} head.count
 * @param {boolean} [head.you]
 */
export function panelHead({ mode, count: where, you = false }) {
  const edit = mode === 'edit';
  return '<div class="pl-card__top pl-naming__top pp-panel__top" data-window-drag><div class="pl-naming__head">'
    + `<h1 class="pl-naming__title mac-title-1">${edit ? panelTitle(you) : 'Organise your people'}</h1>`
    + (where ? `<span class="pl-naming__count mac-mono-data">${count(where.at)} of ${count(where.of)}</span>` : '')
    + iconButton('close', edit ? 'Cancel' : 'Close', { attrs: { 'data-o-do': edit ? 'cancel' : 'close' }, className: 'pl-naming__close' })
    + '</div>'
    + (where ? `<div class="pl-naming__progress" role="progressbar"${attributes({ 'aria-valuemin': '0', 'aria-valuemax': String(where.of),
      'aria-valuenow': String(where.at - 1), 'aria-label': where.words })}>`
      + `<i data-geo="width:${Math.round(((where.at - 1) / Math.max(1, where.of)) * 1000) / 10}%"></i></div>` : '')
    + '</div>';
}

/** @param {boolean} you */
export const panelTitle = you => you ? 'Edit' : 'Edit person';

/** @param {Card} card */
function hero(card) {
  const { person } = card;
  const you = yours(card);
  const since = sinceLine(person.since);
  return `<header class="pp-hero"><button type="button" class="pp-hero__face" data-o-do="photo" aria-label="Choose ${you ? 'your' : 'their'} photo">`
    + `${cardFace(card, 'tile')}<span class="pp-hero__badge" aria-hidden="true">${icon('photo')}</span></button>`
    + `<div class="pp-hero__words"><p class="pp-hero__name mac-title-2" data-o-shown>${esc(shownName(card))}</p>`
    + (you ? '' : `<p class="pp-hero__line mac-subhead">${esc([person.reach ?? '', since].filter(Boolean).join(' · '))}</p>`) + '</div></header>';
}

const FIELDS = /** @type {const} */ ({ name: ['Name', 'What you call them'], full: ['Full name', 'Their full name'],
  rel: ['Relationship', 'Mother, friend from college, dentist'], work: ['Work', 'What they do, and where'] });
const YOUR_FIELDS = /** @type {const} */ ({ name: 'What Lifestream calls you', full: 'Your full name', rel: '', work: 'What you do, and where' });

/**
 * @param {Card} card
 * @param {keyof Fields} field
 */
function field(card, field) {
  return fieldRow({ label: FIELDS[field][0], placeholder: yours(card) ? YOUR_FIELDS[field] : FIELDS[field][1], value: card.fields[field],
    source: sourceOf(card, field),
    sourced: card.fields[field] === card.opened[field], attrs: { 'data-row': `f:${field}` }, input: { 'data-o-field': field } });
}

/** @typedef {{ month: number, year: string, typed: number | null, at: number | null }} CalendarAt */

/**
 * @param {Card} card
 * @param {CalendarAt | null} calendar
 * @param {{ year: number, month: number, day: number }} today
 */
function birthdayField(card, calendar, today) {
  if (!card.shows.birthday) {
    return fieldRowMenu({ label: 'Birthday', value: 'Add birthday', empty: true, attrs: { 'data-row': 'addbirthday', 'data-o-do': 'addbirthday',
      'aria-haspopup': 'dialog' } });
  }
  const value = card.birthday ? birthdayWords(card.birthday) : 'Choose a day';
  const day = calendar && card.birthday && card.birthday.month === calendar.month ? card.birthday.day : null;
  return '<div class="pp-calwrap">'
    + fieldRowMenu({ label: 'Birthday', value, empty: !card.birthday, open: calendar !== null, attrs: { 'data-row': 'f:birthday', 'data-o-do': 'calendar',
      'aria-haspopup': 'dialog' } })
    + (calendar ? `<div class="pp-cal">${calendarPicker({ month: calendar.month, day, year: calendar.year, typed: calendar.typed, today,
      focus: calendar.at, label: 'Birthday' })}</div>` : '')
    + '</div>';
}

export function todayNow() {
  const [year, month, day] = homeToday().split('-').map(Number);
  return { year, month, day };
}

/**
 * @param {Card} card
 * @param {boolean} menu
 */
function lastCard(card, menu) {
  if (yours(card)) return '';
  const rows = rowsOf(card).map(row => {
    if (row.kind === 'chip') {
      const { label, why } = suspicionWords(row.suggestion);
      return nameRow({ lead: { key: 'Suggested' }, name: `${label}?`, line: why, end: { add: card.ticks.get(row.id) === true },
        label: `Suggested, ${label}?, ${why}`, attrs: { 'data-row': row.id, 'data-o-tick': row.id } });
    }
    if (row.kind === 'said') {
      const label = KIND_LABEL[row.value] ?? row.value;
      const whose = judgedTag(card) ? 'Lifestream thinks so' : 'You said so';
      return formAct({ words: label, attrs: { 'data-row': 'said' }, said: { whose, remove: `Remove ${label}`, attrs: { 'data-o-unsay': '' } } });
    }
    if (row.kind === 'notperson') {
      return formAct({ words: 'Mark as not a person', menu: true, attrs: { 'data-row': 'notperson', 'data-o-do': 'notperson',
        'aria-expanded': String(menu) } });
    }
    return '';
  }).join('');
  return formCard(rows + formAct({ words: 'Hide from People', attrs: { 'data-o-do': 'hide' } }),
    { label: 'Not a person, or hidden', className: 'pp-last' });
}

/**
 * @param {Row} row
 * @param {Card} card
 * @param {(address: string) => string} signed
 * @param {boolean} browsing
 */
function theirsRow(row, card, signed, browsing) {
  const them = yours(card) ? 'your' : 'their';
  if (row.kind === 'faces') {
    return nameRow({ lead: { key: '' }, name: `Mark ${them} face`, line: 'Faces you named, and faces not named yet',
      quiet: true, end: 'caret', attrs: { 'data-row': 'faces', 'data-o-do': 'faces', 'aria-pressed': String(browsing) } });
  }
  if (row.kind === 'more') {
    return nameRow({ lead: { key: '' }, name: `Find more photos of ${yours(card) ? 'you' : 'them'}`,
      line: `${count(card.maybe)} Lifestream isn’t sure of`, quiet: true, end: 'caret', attrs: { 'data-row': 'more', 'data-o-do': 'more' } });
  }
  if (row.kind !== 'handle' && row.kind !== 'profile' && row.kind !== 'suggestion' && row.kind !== 'group' && row.kind !== 'added') return '';
  const { key, name, line } = rowWords(row, card, signed);
  const words = { lead: { key }, name, line, label: [key, name, line].filter(Boolean).join(', ') };
  if (row.kind === 'handle') {
    return nameRow({ ...words, attrs: { 'data-row': row.id },
      end: row.handle.own ? 'fixed' : { remove: `Remove ${name}`, attrs: { 'data-o-remove': handleId(row.handle) } } });
  }
  if (row.kind === 'profile') {
    return nameRow({ ...words, attrs: { 'data-row': row.id }, end: { remove: `Remove ${name}`, attrs: { 'data-o-unlist': profileKey(row.profile) } } });
  }
  return nameRow({ ...words, end: { add: card.ticks.get(row.id) === true }, attrs: { 'data-row': row.id, 'data-o-tick': row.id } });
}

const ADD = 'Add a number, email, link, person or face';
const ADD_YOURS = 'Add a number, email, link or person';

/**
 * @param {Extract<Row, { kind: 'called' }>} row
 * @param {boolean} first
 */
const calledRow = ({ id, called }, first) => nameRow({ lead: { key: first ? 'Also called' : '' }, name: called.name,
  line: called.from === YOU_ADDED ? '' : called.from, label: ['Also called', called.name, called.from === YOU_ADDED ? '' : called.from]
    .filter(Boolean).join(', '), attrs: { 'data-row': id }, end: { remove: `Remove ${called.name}`, attrs: { 'data-o-unname': called.name } } });

/** @param {Joined} joined */
export function joinedLine(joined) {
  const numbers = joined.handles.filter(id => id.startsWith('phone:') || id.startsWith('jid:')).length;
  const emails = joined.handles.filter(id => id.startsWith('email:')).length;
  const things = [one(numbers, 'number'), one(emails, 'email'), one(joined.handles.length - numbers - emails, 'account')]
    .filter(Boolean);
  const brings = things.length ? capitalised(listWords(things)) : 'Their faces';
  return [brings, joined.with.length ? `with ${listWords(joined.with)}` : ''].filter(Boolean).join(' · ');
}

/**
 * @param {number} n
 * @param {string} noun
 */
const one = (n, noun) => n === 0 ? '' : n === 1 ? `${/^[aeiou]/u.test(noun) ? 'an' : 'a'} ${noun}` : counted(n, noun);

/** @param {string} words */
const capitalised = words => words.charAt(0).toLocaleUpperCase() + words.slice(1);

/** @param {Card} card */
export function savedWords(card) {
  const split = (card.person.joined ?? []).filter(each => card.split.has(each.id)).map(each => each.name);
  return split.length ? `${listWords(split)} split off` : 'Saved';
}

/** @param {Extract<Row, { kind: 'joined' }>} row */
const joinedRow = ({ id, joined }) => nameRow({
  lead: { face: personFace({ name: joined.name, photo: joined.photo ?? '', size: 'md' }) },
  name: joined.name, line: joinedLine(joined), label: `${joined.name}, ${joinedLine(joined)}`, attrs: { 'data-row': id },
  end: { remove: `Split off ${joined.name}`, attrs: { 'data-o-split': joined.id } } });

/**
 * @param {object} body
 * @param {Card} body.card
 * @param {(address: string) => string} body.signed
 * @param {boolean} body.menu
 * @param {boolean} body.browsing
 * @param {string} body.typed
 * @param {string} [body.naming]
 * @param {CalendarAt | null} [body.calendar]
 * @param {{ year: number, month: number, day: number }} [body.today]
 */
export function panelBody({ card, signed, menu, browsing, typed, naming = '', calendar = null, today = todayNow() }) {
  const you = yours(card);
  const rows = rowsOf(card);
  const guesses = rows.map(row => {
    if (row.kind !== 'guess') return '';
    const day = birthdayOf(row.suggestion.value);
    const words = `${day ? birthdayWords(day) : row.suggestion.value}?`;
    const why = guessSource(row.suggestion);
    return nameRow({ lead: { key: 'Suggested' }, name: words, line: why, end: { add: card.ticks.get(row.id) === true },
      label: `Suggested, birthday ${words}, ${why}`, attrs: { 'data-row': row.id, 'data-o-tick': row.id } });
  }).join('');
  const called = rows.flatMap(row => row.kind === 'called' ? [row] : []);
  const full = card.called.length >= NAMES_MOST;
  const addName = formAdd({ key: called.length ? '' : 'Also called', placeholder: 'Add a name', attrs: { 'data-row': 'addname' },
    input: { value: naming, maxlength: String(NAME_LONGEST), disabled: full ? '' : null, 'data-o-name': '', autocapitalize: 'words' } });
  const who = formCard(field(card, 'name') + field(card, 'full') + (you ? '' : field(card, 'rel')) + field(card, 'work')
    + birthdayField(card, calendar, today) + guesses + called.map((row, at) => calledRow(row, at === 0)).join('') + addName,
  { label: `Who ${you ? 'you are' : 'they are'}` });
  const theirs = rows.map(row => theirsRow(row, card, signed, browsing)).join('');
  const joined = rows.flatMap(row => row.kind === 'joined' ? [joinedRow(row)] : []).join('');
  const words = you ? ADD_YOURS : ADD;
  const add = formAdd({ placeholder: words, attrs: { 'data-row': 'add' }, input: { type: 'search', value: typed, 'data-o-add': '' } });
  return hero(card) + who + section('pp-theirs', 'Numbers and emails', formCard(theirs + add))
    + (joined ? section('pp-joined', 'Joined in', formCard(joined)) : '') + lastCard(card, menu);
}

/**
 * @param {string} id
 * @param {string} label
 * @param {string} card
 */
const section = (id, label, card) => `<section class="pp-theirs" aria-labelledby="${id}">${sectionLabel(label, { level: 2, id })}${card}</section>`;

export const panelBodyReading = () => '<header class="pp-hero" aria-hidden="true">'
  + `<span class="pp-hero__face">${personFaceReading('tile')}</span><div class="pp-hero__words">`
  + `<p class="pp-hero__name mac-title-2">${bar(5)}</p><p class="pp-hero__line mac-subhead">${bar(7)}</p></div></header>`
  + formCard([FIELDS.name, FIELDS.full, FIELDS.rel, FIELDS.work].map(([label, placeholder]) => fieldRow({ label, placeholder,
    input: { disabled: true, tabindex: '-1' } })).join(''), { hidden: true })
  + `<section class="pp-theirs" aria-hidden="true">${sectionLabel('Numbers and emails')}`
  + formCard([0, 1].map(nameRowCardReading).join(''), { hidden: true }) + '</section>';

/**
 * @param {object} foot
 * @param {'organise' | 'edit'} foot.mode
 * @param {string} foot.said
 * @param {{ said: import('../../lib/reach.js').Said, words: string, again?: string } | null} [foot.failure]
 * @param {boolean} [foot.undo]
 * @param {boolean} [foot.saving]
 * @param {boolean} [foot.you]
 */
export function panelFoot({ mode, said, failure = null, undo = false, saving = false, you = false }) {
  const line = failure ? inPlaceLine(failure.words ?? '', { said: failure.said,
    retry: failure.again ? { 'data-o-do': failure.again } : undefined })
    : said ? `<span>${esc(said)}</span>${undo ? button('Undo', { variant: 'plain', size: 'sm', key: '⌘Z',
      attrs: { 'data-o-do': 'undo' } }) : ''}` : '';
  const acts = mode === 'edit'
    ? button('Cancel', { variant: 'plain', key: 'Esc', attrs: { 'data-o-do': 'cancel' } })
      + button('Save', { variant: 'primary', key: '⌘S', busy: saving, attrs: { 'data-o-do': 'save' }, className: 'pp-foot__end' })
    : button('Skip', { variant: 'plain', attrs: { 'data-o-do': 'skip' } })
      + button('Hide', { variant: 'plain', attrs: { 'data-o-do': 'hide' }, className: 'pp-foot__hide' })
      + button('Confirm', { variant: 'primary', key: '⏎', attrs: { 'data-o-do': 'confirm' } });
  return `<footer class="pp-foot"><div class="pp-foot__said mac-subhead" role="status">${line}</div>`
    + `<div class="pp-foot__acts">${acts}</div></footer>`;
}

/**
 * @param {number} lit
 * @param {string | null} said
 */
export const kindMenu = (lit, said) => floatList({ label: 'Not a person', lit, items: KINDS.map((kind, at) => ({
  name: kind.label, icon: kind.icon, chosen: said === kind.value, attrs: { 'data-o-kind': kind.value, 'data-o-menu-at': String(at) },
})) });

/**
 * @param {Find[] | null} finds
 * @param {number} lit
 * @param {string} typed
 */
export const findsList = (finds, lit, typed) => floatList({
  label: 'Found in Lifestream', lit,
  none: finds === null ? 'Looking in Lifestream' : `Nothing in Lifestream matches “${typed.trim()}”`,
  items: (finds ?? []).map((find, at) => ({ ...findWords(find), attrs: { 'data-o-find': String(at) } })),
});

/**
 * @param {object} finish
 * @param {{ name: string, face: string, line: string }[]} finish.people
 * @param {number} finish.minutes
 * @param {number} finish.skipped
 */
export function panelFinish({ people, minutes, skipped }) {
  const line = [`In about ${count(Math.max(1, minutes))} min`, skipped ? `${count(skipped)} skipped` : ''].filter(Boolean).join(' · ');
  const named = people.slice(0, 3).map(one => `<div class="pp-finish__person">${one.face}<span class="mac-headline">${esc(one.name)}</span>`
    + `<span class="mac-mono-data">${esc(one.line)}</span></div>`).join('');
  const body = `<div class="pl-finish ${ARRIVES}"><span class="pl-finish__mark" aria-hidden="true">${icon('done')}</span>`
    + `<div class="pl-finish__head"><h1 class="pl-finish__title mac-display">${count(people.length)} ${people.length === 1 ? 'person' : 'people'} organised</h1>`
    + `<p class="pl-finish__line mac-body">${esc(line)}</p></div>`
    + (people.length ? `<div class="pl-finish__named"><div class="pp-finish__people">${named}</div>`
      + (people.length > 3 ? `<p class="pl-finish__more mac-body">and ${count(people.length - 3)} more, now in your people</p>` : '') + '</div>' : '')
    + '</div>';
  const foot = '<footer class="pp-foot"><div class="pp-foot__acts">'
    + (skipped ? button(`Go through ${count(skipped)} skipped`, { variant: 'plain', attrs: { 'data-o-do': 'again' } }) : '<span></span>')
    + button('Done', { variant: 'primary', key: '⏎', attrs: { 'data-o-do': 'done' }, className: 'pp-foot__end' }) + '</div></footer>';
  return { body, foot };
}
