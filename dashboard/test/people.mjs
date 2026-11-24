process.env.TZ = 'Pacific/Kiritimati';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleWords, networkWords, yourHandles } from '../public/ui/people/words.js';
import { dateWords, found } from '../public/lib/words.js';
import { installClock } from '../public/lib/home-clock.js';
import { clockFor } from './stand-ins/clock.mjs';
import { readFileSync } from 'node:fs';
import {
  answerOf, cardAgain, editPersonOf, handleKey, joinedLine, newCard, panelBody, panelFoot, panelHead, rowsOf, shownName,
} from '../public/ui/people/organise.js';
import { icon, setIcons } from '../public/ui/kit/icon.js';
import { groupPage, groupQuiet, personPage, personSide, savedLine, yourPage } from '../public/ui/people/person.js';
import { notSaved, ownerAct } from '../public/lib/api.js';
import { namingFoot } from '../public/ui/people/naming.js';
import { actSaid, NOT_SENT, requestState, SAVING, UNKNOWN, UNSAVED } from '../public/lib/reach.js';
import { esc } from '../public/lib/html.js';
import { findIn, flatRows, groupsView, mostRows, personRow, ROWS_SHOWN, sectionRows, tidyCard } from '../public/ui/people/list.js';
import { acceptAll, businessesDialog, toMark } from '../public/ui/people/businesses.js';
import { channelsOf } from '../lib/faces.mjs';

const DAY = 86_400_000;
installClock(clockFor('UTC', 4));
const NOW = Date.parse('2026-10-14T12:00:00Z');

const person = (id, name, more = {}) => ({
  id,
  name,
  by: 'contact',
  person: null,
  handles: [{ id: `jid:${id.replace(/\D/gu, '')}@s.whatsapp.net`, kind: 'jid', network: null, words: `+${id.replace(/\D/gu, '')}`, from: null }],
  networks: ['whatsapp'],
  chats: [],
  received: 0,
  sent: 0,
  first_ms: NOW - 400 * DAY,
  last_ms: NOW - DAY,
  last_30: 0,
  days_count: 1,
  ...more,
});
const chat = (key, more = {}) => ({
  key, network: key.split(':')[0], chat: key.split(':')[1], group: false, label: key, total: 0, mine: 0,
  first_ms: NOW - 400 * DAY, last_ms: NOW - DAY, ...more,
});

const a = person('phone:+15550000001', 'Person A', { last_ms: NOW - 2 * DAY, last_30: 40, received: 50, sent: 10,
  chats: [{ key: 'whatsapp:15550000001@s.whatsapp.net', count: 50 }] });
const b = person('person:person-b', 'Person B', {
  by: 'record',
  person: 'person-b',
  handles: [{ id: 'phone:+15550000002', kind: 'phone', network: null, words: '+1 555 000 0002', from: 'Contacts' }],
  last_ms: NOW - 3600_000, last_30: 5, received: 500, sent: 0,
  chats: [{ key: 'whatsapp:120363000000000001@g.us', count: 30 }, { key: 'imessage:+15550000002', count: 20 }] });
const c = person('phone:+15550000003', 'Person C', { last_ms: NOW - 3 * DAY, last_30: 40, received: 90, sent: 30 });
const direct = chat('whatsapp:15550000001@s.whatsapp.net', { total: 60, mine: 10 });
const group = chat('whatsapp:120363000000000001@g.us', { group: true, label: 'Group Alpha', total: 300, mine: 12 });
const imessage = chat('imessage:+15550000002', { total: 26, mine: 6 });
const chats = new Map([direct, group, imessage].map(each => [each.key, each]));

test('N6: the deck\'s channels other than the door\'s one-to-one counts', () => {
  assert.deepEqual(channelsOf(a, chats), [{ network: 'whatsapp', messages: 60 }]);
  assert.deepEqual(channelsOf({ ...b, sent: 6 }, chats), [{ network: 'imessage', messages: 26 }]);
  assert.deepEqual(channelsOf({ ...b, sent: 0 }, chats).map(each => each.messages), [20]);
});

test('N7: words the writing rules forbid', () => {
  const since = { weekday: false, year: 2026 };
  assert.equal(dateWords(Date.parse('2026-09-28T10:00:00Z'), since), '28 Sep');
  assert.equal(dateWords(Date.parse('2024-09-28T10:00:00Z'), since), '28 Sep 2024');
  assert.equal(handleWords({ id: 'jid:15550000001@s.whatsapp.net', kind: 'jid', network: null, words: '+1 555 000 0001', from: null }),
    '+1 555 000 0001');
});

test('N11: a person known by a number alone said twice', () => {
  const nameless = editable('phone:+15550000009', '+15550000009', { named: false, call: null,
    handles: [{ id: 'phone:+15550000009', kind: 'phone', network: null, words: '+15550000009', from: null, own: false },
      { id: 'email:person-z@example.com', kind: 'email', network: null, words: 'person-z@example.com', from: null, own: false }] });
  const card = newCard(nameless, [], false);
  assert.equal(card.fields.name, '', 'Name holds no number');
  assert.equal(shownName(card), '+15550000009', 'the number shown as their name');
});
test('N15: Name is the home\'s, never guessed; a name shown in full is restated', () => {
  const shown = editable('person:person-s', 'Person S', { call: 'Person S', full_name: 'Person S', show: /** @type {const} */ ('full_name') });
  assert.equal(newCard(shown, [], false).fields.name, 'Person S');
  assert.equal(answerOf(newCard(shown, [], false)).name, 'Person S', 'its answer restates the name shown');
  assert.equal(newCard({ ...shown, show: 'name', call: 'Sam' }, [], false).fields.name, 'Sam');
});

test('N17: a passive ⏎ declines only what was offered as a choice', () => {
  const offered = (/** @type {string} */ id, /** @type {string} */ kind, /** @type {string} */ value, ticked = false) => ({ id, kind, value, reasons: {}, ticked });
  const person = { ...doorPerson('phone:+15550000171', 'Person K'), suggestions: [
    offered('1111111111111111', 'handle', 'email:person-k@example.com'), offered('2222222222222222', 'same', 'person-k2'),
    offered('3333333333333333', 'entity', 'business'), offered('4444444444444444', 'full_name', 'Person K Example', true),
    offered('5555555555555555', 'full_name', 'Person K Other'),
  ] };
  const group = { id: 'cluster-k', faces: 4, photos: 4, years: null, sample: [], reason: '', crops: {} };
  const action = answerOf(newCard(/** @type {any} */ (person), [group], true));
  assert.deepEqual([action.accept, action.decline], [['4444444444444444'], ['1111111111111111', '2222222222222222', '3333333333333333']]);
  assert.equal('not_groups' in action || 'groups' in action, false, 'a face group left unticked says nothing');
});

test('N18: a birthday is a guess by its tick, never its reasons; left unticked or taken back it says nothing', () => {
  const offered = (/** @type {string} */ id, /** @type {string} */ value, /** @type {Record<string, number>} */ reasons, ticked = false) =>
    ({ id, kind: 'birthday', value, reasons, ticked });
  const agreed = offered('6666666666666666', '1990-08-14', { cards: 1, wished: 2 }, true);
  const card = newCard(/** @type {any} */ ({ ...doorPerson('phone:+15550000181', 'Person L'), suggestions: [agreed] }), [], false);
  assert.deepEqual([card.birthday, card.shows.birthday], [{ month: 8, day: 14, year: 1990 }, true]);
  assert.equal(rowsOf(card).some(row => row.kind === 'guess'), false, 'a ticked birthday shown as a guess');
  assert.deepEqual([answerOf(card).accept, answerOf(card).decline], [[agreed.id], []]);
  const wish = offered('7777777777777777', '09-01', { wished: 3 });
  const guessing = newCard(/** @type {any} */ ({ ...doorPerson('phone:+15550000182', 'Person M'), suggestions: [wish] }), [], false);
  assert.deepEqual([guessing.birthday, rowsOf(guessing).filter(row => row.kind === 'guess').map(row => row.id)], [null, [`o:${wish.id}`]]);
  assert.deepEqual([answerOf(guessing).accept, answerOf(guessing).decline], [[], []]);
  guessing.ticks.set(`o:${wish.id}`, true);
  guessing.birthday = { month: 9, day: 1, year: null };
  assert.deepEqual(answerOf(guessing).accept, [wish.id]);
  guessing.ticks.set(`o:${wish.id}`, false);
  guessing.birthday = null;
  assert.deepEqual([answerOf(guessing).accept, answerOf(guessing).decline], [[], []]);
  assert.deepEqual(rowsOf(guessing).filter(row => row.kind === 'guess').map(row => row.id), [`o:${wish.id}`]);
});

/**
 * @param {string} id
 * @param {string} name
 * @param {any} [more]
 */
const doorPerson = (id, name, more = {}) => editable(id, name, { record: more.record?.slug ?? null });
test('N20: details sent member by member, only those changed', () => {
  const person = { ...doorPerson('person:person-n', 'Person N', { record: { slug: 'person-n', name: 'Person N' } }),
    details: { work: 'Example Co', birthday: { month: 8, day: 14, year: null }, profiles: [{ network: 'x', value: 'person_n' }] } };
  const fresh = () => newCard(/** @type {any} */ (person), [], false);
  assert.equal('details' in answerOf(fresh()), false);
  const working = fresh();
  working.fields.work = '  Other   Co ';
  assert.deepEqual(answerOf(working).details, { work: 'Other Co' });
  const unborn = fresh();
  unborn.birthday = null;
  assert.deepEqual(answerOf(unborn).details, { birthday: null });
  const unlisted = fresh();
  unlisted.unlisted.add('x:person_n');
  assert.deepEqual(answerOf(unlisted).details, { profiles: [] });
  const both = fresh();
  both.added.push({ key: 'profile-github:person-n', kind: 'profile', profile: { network: 'github', value: 'person-n' } });
  both.ticks.set('a:profile-github:person-n', true);
  both.birthday = { month: 8, day: 14, year: 1990 };
  assert.deepEqual(answerOf(both).details, { birthday: { month: 8, day: 14, year: 1990 },
    profiles: [{ network: 'x', value: 'person_n' }, { network: 'github', value: 'person-n' }] });
});


/** @param {string} markup */
const businessRows = markup => ({
  rows: [...markup.matchAll(/aria-checked="(true|false)"[^>]*data-people-business="([^"]+)"/gu)].map(([, on, id]) => [id, on === 'true']),
  mark: /<button[^>]*data-people-businesses-mark[^>]*>(?:<[^>]*>)*([^<]+)/u.exec(markup)?.[1],
});
/**
 * @param {string} id
 * @param {string} name
 * @param {string[]} [handles]
 */
const offer = (id, name, handles = [id]) => ({ id, name, named: true, photo: null, why: 'A company, no person’s name',
  handles: handles.map(each => ({ id: each, words: each.slice(each.indexOf(':') + 1) })) });

const FIXTURES = new URL('../../homelink/Tests/Fixtures/pages/', import.meta.url);
/** @param {string} name */
const fixture = name => JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8'));
/**
 * @param {string} id
 * @param {string} name
 * @param {Record<string, unknown>} [more]
 * @returns {import('../public/ui/people/organise.js').Person}
 */
const editable = (id, name, more = {}) => ({ ...editPersonOf(id, fixture('person.nothing')), id, name, named: true, call: name, ...more });
/**
 * @param {string} markup
 * @param {string} [attribute]
 */
const idsIn = (markup, attribute = 'data-person') => [...markup.matchAll(new RegExp(`${attribute}="([^"]*)"`, 'gu'))].map(([, id]) => id);
/**
 * @param {string} markup
 * @param {string[]} words
 */
const inOrder = (markup, words) => {
  const at = words.map(each => markup.indexOf(esc(each)));
  return at.every((place, index) => place >= 0 && (index === 0 || place > at[index - 1]));
};
const NO_PHOTOS = { total: 0, page: 0, size: 12, photos: [], error: '' };

setIcons(JSON.parse(readFileSync(new URL('../../design/icons.json', import.meta.url), 'utf8')));
/** @param {import('../public/ui/people/organise.js').Card} card */
const bodyOf = card => panelBody({ card, signed: () => '', menu: false, browsing: false, typed: '' });
/**
 * @param {string} id
 * @param {string} from
 * @param {boolean} [own]
 */
const served = (id, from, own = false) => ({ id, kind: /** @type {'phone' | 'email'} */ (id.startsWith('email:') ? 'email' : 'phone'), network: null,
  words: id.slice(id.indexOf(':') + 1), from, own });
const NO_DETAILS = { work: null, birthday: null, profiles: [] };
const riley = editable('person:riley', 'Riley', { record: 'riley', details: NO_DETAILS, suggestions: [],
  handles: [served('phone:+15550000021', 'Contacts'), served('phone:+15550000023', 'You added'), served('email:riley@work.example', 'You added'),
    served('phone:+15550000024', 'Contacts')],
  also_called: [{ name: 'Big Riley', from: 'You added' }, { name: 'Bear', from: 'Contacts' }],
  joined: [
    { id: 'person:riley-work', name: 'Riley Work', photo: null, handles: ['phone:+15550000022', 'phone:+15550000023', 'email:riley@work.example'],
      with: ['Riley Old'] },
    { id: 'person:riley-old', name: 'Riley Old', photo: null, handles: ['phone:+15550000023'], with: [] },
    { id: 'person:riley-b', name: 'Riley B.', photo: null, handles: ['phone:+15550000024'], with: [] }] });
const you = editable('person:sam-example', 'Sam', { record: 'sam-example', full_name: 'Sam Example', me: true,
  details: NO_DETAILS, entity: 'person', relationship: null, also_called: [{ name: 'Sammy', from: 'You added' }], joined: [], suggestions: [],
  handles: [served('phone:+15550000001', 'Your iMessage and WhatsApp', true), served('phone:+15550000002', 'Contacts')] });

test('N24: Edit lists the people joined in; × stages their split, Save ships it, a card opened again has them back', () => {
  const card = newCard(riley, [], false);
  const ids = (/** @type {import('../public/ui/people/organise.js').Card} */ each) => rowsOf(each).map(row => row.id);
  assert.deepEqual(ids(card).filter(id => id.startsWith('j:')), ['j:person:riley-work', 'j:person:riley-old', 'j:person:riley-b'],
    'in the order the home serves');
  assert.match(bodyOf(card), /Joined in[\s\S]*data-o-split="person:riley-work"/u);
  assert.equal('split' in answerOf(card), false, 'nothing staged ships no split');
  card.split.add('person:riley-work');
  assert.deepEqual(ids(card).filter(id => id.startsWith('j:') || id.startsWith('h:')),
    ['h:phone:+15550000021', 'h:phone:+15550000024', 'j:person:riley-old', 'j:person:riley-b']);
  assert.deepEqual(answerOf(card).split, ['person:riley-work']);
  assert.equal(ids(newCard(riley, [], false)).filter(id => id.startsWith('j:')).length, 3);
  const again = cardAgain(newCard({ ...riley, joined: riley.joined?.slice(1) }, [], false), card);
  assert.deepEqual([...again.split], []);
  assert.deepEqual([...cardAgain(newCard(riley, [], false), card).split], ['person:riley-work']);
});

test('N25: Also called: each name with its source, Save ships only what changed, a card read again keeps it, 12 at most', () => {
  const card = newCard(riley, [], false);
  const names = rowsOf(card).flatMap(row => row.kind === 'called' ? [[row.called.name, row.called.from]] : []);
  assert.deepEqual(names, [['Big Riley', 'You added'], ['Bear', 'Contacts']]);
  assert.ok(rowsOf(card).some(row => row.id === 'addname'));
  assert.equal('add_names' in answerOf(card) || 'remove_names' in answerOf(card), false, 'nothing changed ships neither');
  card.called = card.called.filter(each => each.name !== 'Bear');
  card.called.push({ name: 'Ri', from: 'You added' });
  const action = answerOf(card);
  assert.deepEqual([action.add_names, action.remove_names], [['Ri'], ['Bear']]);
  const again = cardAgain(newCard(riley, [], false), card);
  assert.deepEqual(again.called.map(each => each.name), ['Big Riley', 'Ri']);
  const full = newCard({ ...riley, also_called: Array.from({ length: 12 }, (_, at) => ({ name: `Name ${at}`, from: 'Contacts' })) }, [], false);
  assert.match(bodyOf(full), /<input[^>]*placeholder="Add a name"[^>]*disabled/u);
  assert.doesNotMatch(bodyOf(card), /<input[^>]*placeholder="Add a name"[^>]*disabled/u);
});

test('N27: a staged split hides its own row alone, never another of the same name; unlink leaves out what it takes', () => {
  const twins = { ...riley, joined: [
    { id: 'person:riley-work', name: 'Person C', photo: null, handles: ['phone:+15550000023'], with: ['Person C'] },
    { id: 'person:riley-c', name: 'Person C', photo: null, handles: ['phone:+15550000024'], with: [] }] };
  const card = newCard(twins, [], false);
  card.split.add('person:riley-work');
  assert.deepEqual(rowsOf(card).map(row => row.id).filter(id => id.startsWith('j:') || id.startsWith('h:')),
    ['h:phone:+15550000021', 'h:email:riley@work.example', 'h:phone:+15550000024', 'j:person:riley-c']);
  assert.deepEqual(answerOf(card).split, ['person:riley-work']);
  card.removed.add('phone:+15550000023');
  card.removed.add('phone:+15550000021');
  assert.deepEqual(answerOf(card).unlink, ['phone:+15550000021']);
  card.removed.delete('phone:+15550000021');
  assert.equal('unlink' in answerOf(card), false);
});

test('N28: a name is the home\'s one name across accents, case and spaces; a reread at twelve keeps the one staged', () => {
  const accented = { ...riley, also_called: [{ name: 'Alias É', from: 'Contacts' }] };
  const card = newCard(accented, [], false);
  card.called = [{ name: 'alias  e', from: 'You added' }];
  const action = answerOf(card);
  assert.equal('add_names' in action || 'remove_names' in action, false, JSON.stringify(action));
  assert.deepEqual(cardAgain(newCard(accented, [], false), card).called.map(each => each.name), ['Alias É']);
  const eleven = Array.from({ length: 11 }, (_, at) => ({ name: `Name ${at}`, from: 'Contacts' }));
  const staged = newCard({ ...riley, also_called: eleven }, [], false);
  staged.called.push({ name: 'Twelfth', from: 'You added' });
  const again = cardAgain(newCard({ ...riley, also_called: [...eleven, { name: 'Another', from: 'Contacts' }] }, [], false), staged);
  assert.deepEqual(again.called.map(each => each.name).slice(-2), ['Another', 'Twelfth']);
  assert.deepEqual(answerOf(again).add_names, ['Twelfth']);
});

test('N29: Edit says a joined in, places the add row and orders your numbers as the iPhone does', () => {
  const joined = (/** @type {string[]} */ handles, /** @type {string[]} */ along = []) => joinedLine({ id: 'person:riley-x',
    name: 'Riley X', photo: null, handles, with: along });
  assert.equal(joinedLine({ id: 'person:riley-x', name: 'Riley X', photo: null,
    handles: ['phone:+15550000031', 'jid:15550000032@s.whatsapp.net', 'email:riley-x@example.com'], with: [] }), '2\u00a0numbers and an email', 'a count held to its noun');
  assert.equal(joined(['email:riley-x@example.com'], ['Riley Old']), 'An email · with Riley Old');
  assert.equal(joined(['phone:+15550000031', 'telegram:riley-x']), 'A number and an account');
  assert.equal(joined([]), 'Their faces');
  assert.match(bodyOf(newCard(riley, [], false)), /Numbers and emails[\s\S]*data-o-add[\s\S]*Joined in/u);
  assert.doesNotMatch(bodyOf(newCard(riley, [], false)), /Joined in[\s\S]*data-o-add/u);
  const handle = (/** @type {string} */ id, /** @type {string} */ kind, own = false) => ({ id, kind, network: null, words: id, from: 'Contacts', own });
  assert.deepEqual(yourHandles(/** @type {any} */ ([handle('email:sam@example.com', 'email'), handle('telegram:sam', 'telegram'),
    handle('email:own@example.com', 'email', true), handle('jid:15550000005@s.whatsapp.net', 'jid'), handle('phone:+15550000002', 'phone'),
    handle('phone:+15550000001', 'phone', true)])).map(each => each.id),
  ['phone:+15550000001', 'email:own@example.com', 'jid:15550000005@s.whatsapp.net', 'phone:+15550000002', 'email:sam@example.com', 'telegram:sam']);
});

test('N26: Your Edit is no friend\'s: no Relationship, kind or Hide, titled Edit, Yours even empty, your own accounts kept', () => {
  const card = newCard(you, [], false);
  const kinds = new Set(rowsOf(card).map(row => row.id));
  for (const gone of ['f:rel', 'notperson', 'said']) assert.equal(kinds.has(gone), false, gone);
  assert.match(panelHead({ mode: 'edit', count: null, you: true }), />Edit</u);
  assert.match(panelHead({ mode: 'edit', count: null }), />Edit person</u);
  assert.doesNotMatch(panelFoot({ mode: 'edit', said: '', you: true }), /data-o-do="hide"/u);
  const body = bodyOf(card);
  assert.doesNotMatch(body, /data-o-field="rel"|data-o-do="hide"|ck-form pp-last/u);
  assert.match(body, />Numbers and emails</u);
  assert.doesNotMatch(body, /data-o-remove="phone:\+15550000001"/u);
  assert.match(body, /data-o-remove="phone:\+15550000002"/u);
  const first = bodyOf(newCard({ ...you, handles: [], also_called: [] }, [], false));
  assert.match(first, />Numbers and emails<[\s\S]*data-o-add/u);
  const action = answerOf(card);
  for (const gone of ['relationship', 'entity', 'hidden']) assert.equal(gone in action, false, gone);
});

test('N33: Edit is one form grid: keyed rows, Suggested with Add, the rare acts in a last card, plain words', () => {
  const offered = (/** @type {string} */ id, /** @type {string} */ kind, /** @type {string} */ value, reasons = {}, ticked = false) =>
    ({ id, kind, value, reasons, ticked });
  const card = newCard({ ...riley, entity: 'person', suggestions: [offered('1111111111111111', 'birthday', '07-26', { wished: 2 }),
    offered('2222222222222222', 'handle', 'email:riley@mail.example', { mails_from: 4, mails_to: 2 }),
    offered('3333333333333333', 'entity', 'business', { whatsapp: 2 })] }, [], false);
  const body = bodyOf(card);
  const who = /** @type {string} */ (/<div class="ck-form" role="group" aria-label="Who they are">([\s\S]*?)<\/div><section/u.exec(body)?.[1]);
  assert.deepEqual([...who.matchAll(/class="(?:ck-fieldrow__label|ck-namerow__keyword|ck-form__key)[^"]*"[^>]*>([^<]*)</gu)].map(each => each[1]),
    ['Name', 'Full name', 'Relationship', 'Work', 'Birthday', 'Suggested', 'Also called', '', '']);
  assert.match(who, /data-o-field="work"/u);
  assert.match(who, /data-row="addbirthday"[^>]*>[\s\S]*?ck-fieldrow__value mac-body is-empty">Add birthday</u);
  assert.match(who, /data-o-tick="o:1111111111111111"[\s\S]*?>26 July\?<[\s\S]*?>From your messages<[\s\S]*?ck-namerow__add mac-subhead">Add</u);
  const theirs = body.slice(body.indexOf('Numbers and emails'));
  assert.deepEqual([...theirs.matchAll(/class="ck-namerow__keyword mac-body" aria-hidden="true">([^<]*)</gu)].map(each => each[1]).slice(0, 5),
    ['Phone', 'Phone', 'Email', 'Phone', 'Email']);
  assert.match(theirs, />\+15550000021<\/span><span class="ck-namerow__line mac-subhead">From Contacts</u);
  assert.match(theirs, />riley@mail.example<\/span><span class="ck-namerow__line mac-subhead">Mail in their name · 6\smails</u);
  assert.doesNotMatch(body, /You added|added by you|>Theirs<|>Yours<|ck-chip|pp-kind/u);
  const last = body.slice(body.indexOf('ck-form pp-last'));
  assert.match(last, />Suggested<[\s\S]*?>A business\?<[\s\S]*?>Add<[\s\S]*?data-o-do="hide"[\s\S]*?>Hide from People</u);
  assert.equal(body.indexOf('data-o-do="hide"') > body.indexOf('ck-form pp-last'), true);
  assert.doesNotMatch(panelFoot({ mode: 'edit', said: '' }), /data-o-do="hide"/u, 'Hide leaves Edit\'s foot');
  assert.match(panelFoot({ mode: 'organise', said: '' }), /data-o-do="hide"/u, 'Organise answers Hide in its foot');
  const plain = bodyOf(newCard({ ...riley, entity: 'person' }, [], false));
  assert.match(plain.slice(plain.indexOf('ck-form pp-last')), /data-row="notperson" data-o-do="notperson"[^>]*>[\s\S]*?>Mark as not a person</u);
  const said = bodyOf(newCard({ ...riley, entity: 'business', entity_by: 'you' }, [], false));
  assert.match(said, /<button type="button" class="ck-form__act is-said"[^>]*aria-label="Remove A business, you said so"[^>]*data-row="said" data-o-unsay=""[^>]*>[\s\S]*?>A business<[\s\S]*?>You said so<[\s\S]*?<span class="ck-form__x" aria-hidden="true">/u);
  const saidRow = said.slice(said.indexOf('class="ck-form__act is-said"'));
  assert.equal(saidRow.slice(0, saidRow.indexOf('</button>')).includes('<button'), false, 'nothing inside it to tab to or miss');
  assert.deepEqual(handleKey({ id: 'jid:x', kind: 'jid', network: null, words: 'Hidden number', from: 'WhatsApp' }),
    { key: 'Phone', name: 'Number hidden', line: 'From WhatsApp' });
  assert.deepEqual(handleKey({ id: 'jid:x', kind: 'jid', network: null, words: 'Hidden number', from: 'You added' }),
    { key: 'Phone', name: 'Number hidden', line: '' });
  assert.deepEqual(handleKey({ id: 'jid:15550000001@s.whatsapp.net', kind: 'jid', network: null, words: '+15550000001', from: 'Account' }),
    { key: 'Phone', name: '+15550000001', line: 'From Account' });
});

test('N32: Organise draws a same-person suggestion\'s other side as the home sends it, a face you named as a face', () => {
  const page = fixture('person.full');
  const other = { id: 'person:person-q2', name: 'Quinn Other', photo: null, named: true, face: false };
  const same = { id: 'same-1', kind: 'same', value: 'person-q2', reasons: [{ reason: 'named', count: 1 }], ticked: false, other };
  const asked = (/** @type {any} */ suggestion) => editPersonOf('phone:+15550000401', { ...page, edit: { ...page.edit, suggestions: [suggestion] } });
  const card = newCard(asked(same), [], false);
  const row = rowsOf(card).find(each => each.id === 'o:same-1');
  assert.equal(row?.kind, 'suggestion', 'the suggestion is a row of its own');
  assert.match(bodyOf(card), /Same as[\s\S]*Quinn Other[\s\S]*Both named Person K/u, 'the other side\'s name, and why');
  const face = bodyOf(newCard(asked({ ...same, other: { ...other, face: true } }), [], false));
  assert.match(face, /Quinn Other[\s\S]*A face you named · Same person\?/u);
  assert.deepEqual(answerOf(card).decline, ['same-1'], 'left unticked it is declined');
});

test('N34: a person added from the find list is keyed Face or Same as by the row\'s face, as the home sends it', () => {
  const page = fixture('person.full');
  const row = (/** @type {boolean} */ face) => ({ id: 'person:person-f1', name: 'Pat Synthetic', named: true, face, photo: null, when: null, line: null, find: ['Pat Synthetic'] });
  const added = (/** @type {boolean} */ face) => {
    const card = newCard(editPersonOf('phone:+15550000401', page), [], false);
    card.added.push({ key: 'find-person:person-f1', kind: 'find', find: row(face) });
    return bodyOf(card);
  };
  assert.match(added(true), /aria-label="Face, Pat Synthetic"/u, 'a face-only person is keyed Face');
  assert.match(added(false), /aria-label="Same as, Pat Synthetic"/u, 'anyone else is keyed Same as');
});

test('N30: Where you talk counts their messages on every row, the groups the most first, the more row alone', () => {
  const groupChat = (/** @type {number} */ n, /** @type {Record<string, unknown>} */ more = {}) => chat(
    `whatsapp:12036300000000100${n}@g.us`, { group: true, label: `Group ${n}`, total: 900, mine: 40, quiet: null,
      last_ms: NOW - n * DAY, ...more });
  const served = [1, 2, 3, 4, 5, 6].map(n => groupChat(n));
  const quiet = groupChat(7, { label: 'Group Quiet', quiet: { why: 'silent', last_day: null }, mine: 0 });
  const counts = [7, 6, 5, 4, 3, 59];

  const whereRow = (/** @type {{ key: string, label: string, group: boolean, last_ms: number, quiet?: unknown }} */ each,
    /** @type {number} */ count) => ({ chat: each.key, title: each.group ? each.label : networkWords(each.key.split(':')[0]), group: each.group,
    network: networkWords(each.key.split(':')[0]), when: { kind: 'at', at_ms: each.last_ms }, count, line: `${count} messages`,
    quiet: Boolean(each.quiet) });
  const page = { ...fixture('person.full'), head: { ...fixture('person.full').head, name: 'Person Q' },
    where: [whereRow(direct, 50), whereRow(imessage, 3), ...[5, 0, 1, 2, 3, 4].map(at => whereRow(served[at], counts[at])),
      whereRow(quiet, 200)] };
  const side = personSide(page, false, '2026-10-14');
  const rows = side.slice(side.indexOf('Where you talk')).split(/class="ck-side__row(?=[" ])/u).slice(1).map(row => [
    /class="ck-side__icon" aria-hidden="true">([\s\S]*?)<\/span><span class="ck-side__main">/u.exec(row)?.[1],
    /ck-side__name[^>]*>([^<]*)</u.exec(row)?.[1], /ck-side__line[^>]*><span>([^<]*)</u.exec(row)?.[1] ?? null,
    /ck-side__count[^>]*>([^<]*)</u.exec(row)?.[1] ?? null]);
  assert.deepEqual(rows.map(([, name, line, many]) => [name, line, many]), [
    [networkWords('whatsapp'), 'Yesterday', '50'], [networkWords('imessage'), 'Yesterday', '3'],
    ['Group 6', 'Thursday', '59'], ['Group 1', 'Yesterday', '7'], ['Group 2', 'Monday', '6'],
    ['Group 3', 'Sunday', '5'], ['Group 4', 'Saturday', '4'], ['2 more groups', null, null]]);
  assert.deepEqual(rows.map(([lead]) => lead),
    [icon('message'), icon('message'), ...Array(5).fill(icon('meeting')), '']);
  assert.match(side, />From Person Q</u, 'the label says whose messages the rows count');
});

test('N31: an Undo or a word on a group whose answer was lost says so, and offers nothing to press again', async () => {
  const fetched = globalThis.fetch;
  /** @type {string[]} */
  const sent = [];
  globalThis.fetch = (_url, init) => {
    sent.push(JSON.parse(String(init?.body)).request);
    return Promise.reject(new TypeError('fetch failed'));
  };
  /** @type {unknown} */
  let lost;
  try {
    lost = await ownerAct({ of: 'people', kind: 'undo', act: 'act-1' }, 'request-1').then(() => null, error => error);
  } finally {
    globalThis.fetch = fetched;
  }
  assert.deepEqual(sent, ['request-1', 'request-1'], 'a lost answer sent other than once more, as the same request');
  const failure = actSaid(requestState(lost));
  assert.deepEqual(failure, { said: 'unknown', words: UNSAVED });
  const line = savedLine({ said: 'Person B split off', act: 'act-1', undoing: false, failure });
  assert.ok(line.includes(esc(UNSAVED)), line);
  assert.doesNotMatch(line, new RegExp(NOT_SENT, 'u'));
  assert.doesNotMatch(line, /data-people-saved-undo|Try again/u, 'an Undo whose answer was lost offered again');
  const head = fixture('group.full').head;
  const word = groupQuiet(group.key, head, '2026-10-14', { busy: false, failure, value: 'never' });
  assert.ok(word.includes(esc(UNSAVED)), word);
  const saving = actSaid(requestState(Object.assign(new Error(SAVING), { code: 'OUTCOME_UNKNOWN', again: true, began: true })));
  assert.deepEqual(saving, { said: 'saving', words: SAVING });
  const still = savedLine({ said: 'Person B split off', act: 'act-1', undoing: true, failure: saving });
  assert.ok(still.includes(SAVING), still);
  assert.doesNotMatch(still, /data-people-saved-undo|Try again/u, 'an Undo the home is still saving offered again');
  assert.doesNotMatch(word, /data-people-word-again|Try again/u, 'a word whose answer was lost offered again');
  const gone = Object.assign(new Error('Lifestream is starting: it answers in a moment.'), { status: 503, code: 'GONE', retryAfter: 0 });
  const unsent = actSaid(requestState(gone));
  assert.equal(unsent.said, 'not-sent');
  const again = savedLine({ said: 'Person B split off', act: 'act-1', undoing: false, failure: unsent });
  assert.match(again, new RegExp(`${NOT_SENT}[\\s\\S]*data-people-saved-undo[\\s\\S]*Try again`, 'u'));
  assert.match(groupQuiet(group.key, head, '2026-10-14', { busy: false, failure: unsent, value: 'never' }),
    /data-people-word-again="whatsapp:120363000000000001@g\.us" data-value="never"[^>]*>Try again/u);
});

test('N32: an act on People\'s pages that did not land is the kit\'s in-place line: not sent with Try again, else nothing to press', async () => {
  const lost = Object.assign(new Error(UNKNOWN), { code: 'OUTCOME_UNKNOWN' });
  const gone = Object.assign(new Error('Lifestream is starting: it answers in a moment.'), { status: 503, code: 'GONE', retryAfter: 0 });
  const refusal = Object.assign(new Error('They changed since you looked.'), { status: 409, code: 'NOT_OFFERED' });
  assert.deepEqual(notSaved(gone, 'ignored'), { said: 'not-sent', words: NOT_SENT });
  assert.deepEqual(notSaved(lost, 'ignored'), { said: 'unknown', words: UNKNOWN });
  const began = Object.assign(new Error(SAVING), { code: 'OUTCOME_UNKNOWN', again: true, began: true });
  assert.deepEqual(notSaved(began, 'ignored'), { said: 'saving', words: SAVING });
  assert.deepEqual(notSaved(refusal, refusal.message, 'Not undone'), { said: 'refused', words: 'Not undone: They changed since you looked.' });
  const offered = (/** @type {RegExp} */ again, /** @type {string} */ markup) => {
    const button = markup.match(/<button[^>]*>Try again<\/button>/u);
    assert.ok(button && again.test(button[0]), markup);
  };
  const quiet = (/** @type {string} */ markup, /** @type {string} */ words) => {
    assert.ok(markup.includes(esc(words)), markup);
    assert.doesNotMatch(markup, /Try again/u, 'a refusal or an outcome not known offered again');
  };
  const foot = (/** @type {any} */ failure) => panelFoot({ mode: 'organise', said: 'Person A confirmed', failure, undo: true });
  const unsent = foot({ ...notSaved(gone, ''), again: 'resend' });
  assert.match(unsent, new RegExp(`>${NOT_SENT}<`, 'u'));
  offered(/data-o-do="resend"/u, unsent);
  assert.doesNotMatch(unsent, /Person A confirmed|data-o-do="undo"/u);
  quiet(foot({ ...notSaved(refusal, refusal.message), again: 'resend' }), 'Not saved: They changed since you looked.');
  quiet(foot({ ...notSaved(lost, ''), again: 'resend' }), UNKNOWN);
  assert.match(foot(null), /Person A confirmed<\/span><button[^>]*data-o-do="undo"/u, 'the line and its Undo with nothing failed');
  offered(/data-f-again-act/u, namingFoot({ said: '', failure: { ...notSaved(gone, ''), again: true }, back: true }));
  quiet(namingFoot({ said: '', failure: { ...notSaved(lost, ''), again: true }, back: true }), UNKNOWN);
  quiet(namingFoot({ said: '', failure: { ...notSaved(began, ''), again: true }, back: true }), SAVING);
  quiet(foot({ ...notSaved(began, ''), again: 'resend' }), SAVING);
  quiet(namingFoot({ said: '', failure: { ...notSaved(refusal, refusal.message), again: true }, back: true }), 'Not saved: They changed since you looked.');
  quiet(savedLine({ said: 'Saved', act: 'act-1', undoing: false, failure: actSaid(requestState(refusal)) }), refusal.message);
  /** @type {unknown[]} */
  const meets = [gone, lost];
  /** @type {Record<string, unknown>[]} */
  const sent = [];
  const accept = acceptAll({
    act: async action => {
      sent.push(action);
      const met = meets.shift();
      if (met) throw met;
      return { act: action.kind === 'undo' ? null : 'people:local:0001/act-2', id: null, position: '9:2' };
    },
    changed: () => {},
  });
  const cNow = offer('person:person-c', 'Person C', [c.id]);
  let offers = [offer(a.id, 'Person A'), offer(c.id, 'Person C')];
  const offeredNow = () => offers;
  const dialog = () => businessesDialog(/** @type {any} */ (accept.view(offeredNow())));
  accept.open(offeredNow());
  await accept.mark(offeredNow());
  assert.deepEqual(sent, [{ kind: 'businesses', ids: [a.id, c.id] }]);
  assert.match(dialog(), new RegExp(`>${NOT_SENT}<`, 'u'));
  offered(/data-people-businesses-again/u, dialog());
  offers = [offer(a.id, 'Person A'), cNow];
  accept.toggle(offeredNow(), a.id);
  assert.deepEqual(toMark(offeredNow(), /** @type {any} */ (accept.view(offeredNow())).ticks), [cNow.id], 'the dialog moved since');
  await accept.again(offeredNow());
  assert.deepEqual(sent[1], sent[0], 'Try again sent another act');
  quiet(dialog(), UNKNOWN);
  await accept.again(offeredNow());
  assert.equal(sent.length, 2, 'an outcome not known sent again');
  await accept.mark(offeredNow());
  assert.deepEqual(sent[2], { kind: 'businesses', ids: [cNow.id] });
  assert.match(dialog(), /marked as a business<\/span><button[^>]*data-people-businesses-undo/u);
  meets.push(gone);
  await accept.undo();
  offered(/data-people-businesses-again/u, dialog());
  void accept.again(offeredNow());
  assert.deepEqual(sent.slice(3), [{ kind: 'undo', act: 'people:local:0001/act-2' }, { kind: 'undo', act: 'people:local:0001/act-2' }]);
});

test('F1: every list in the home\'s People answers draws in the answer\'s order: rows by section, Most, AI, groups, the new, the businesses, where you talk, the talk, your numbers, who writes most', () => {
  for (const name of ['people.full', 'people.counting', 'people.nothing']) {
    const read = fixture(name);
    const rows = read.sections.flatMap((/** @type {any} */ section) => section.rows);
    const byId = new Map([...read.you ? [read.you] : [], ...rows, ...read.ai].map(row => [row.id, row]));
    const paired = (/** @type {{ id: string, line: string }[]} */ list) => list.map(({ id, line }) => ({ row: byId.get(id), line }));
    assert.deepEqual(idsIn(sectionRows(read.sections, ROWS_SHOWN, read.today)), rows.map(row => row.id), name);
    assert.deepEqual(idsIn(mostRows(paired(read.most))), read.most.map((/** @type {any} */ each) => each.id), name);
    assert.deepEqual(idsIn(flatRows('AI', read.ai, ROWS_SHOWN, row => personRow(row, read.today))),
      read.ai.map((/** @type {any} */ row) => row.id), name);
    assert.deepEqual(idsIn(groupsView(read.groups, { shown: ROWS_SHOWN, today: read.today, open: true })),
      [...read.groups.yours, ...read.groups.quiet].map(chat => `chat:${chat.chat}`), name);
    const tidy = tidyCard({ organise: read.organise.line, businesses: read.businesses?.line ?? null, faces: null, askFaces: false,
      fresh: paired(read.new) });
    assert.deepEqual(idsIn(tidy, 'data-people-organise'), read.new.map((/** @type {any} */ each) => each.id), name);
    assert.ok(inOrder(tidy, [read.organise.line, read.businesses?.line].filter(Boolean)), `${name}: the home's lines, as it said them`);
    const offered = read.businesses?.offered ?? [];
    const accept = acceptAll({ act: async () => ({ act: null, position: read.position }), changed: () => {} });
    accept.open(offered);
    assert.deepEqual(businessRows(businessesDialog(/** @type {any} */ (accept.view(offered)))).rows.map(([id]) => id),
      offered.map((/** @type {any} */ each) => each.id), name);
  }
  for (const name of ['person.full', 'person.nothing', 'person.became']) {
    const read = fixture(name);
    const side = personSide(read, true, read.today);
    assert.deepEqual([...side.matchAll(/ck-side__name mac-headline">([^<]*)</gu)].map(([, words]) => words).filter(words => words !== 'Calls'),
      read.where.map((/** @type {any} */ each) => each.title), name);
    if (read.talk) {
      assert.ok(inOrder(personPage({ page: read, photos: NO_PHOTOS, today: read.today }),
        read.talk.lines.slice(-4).map((/** @type {any} */ line) => line.text)), `${name}: its talk in the answer's order`);
    }
    assert.ok(inOrder(yourPage({ page: read, photos: NO_PHOTOS }), read.handles.map((/** @type {any} */ handle) => handle.words)),
      `${name}: the numbers in the answer's order`);
  }
  const group = fixture('group.full');
  const drawn = groupPage(group.talk.chat, group, group.today);
  assert.deepEqual(idsIn(drawn), group.writers.map((/** @type {any} */ writer) => writer.id));
  assert.ok(inOrder(drawn, group.talk.lines.map((/** @type {any} */ line) => line.text)));
});

test('F2: a person with no contact drawn under the home\'s "No messages yet", a row with no time worded by its line', () => {
  for (const name of ['people.nothing', 'people.full']) {
    const read = fixture(name);
    const none = read.sections.find((/** @type {any} */ section) => section.key === 'none');
    const markup = sectionRows(read.sections, ROWS_SHOWN, read.today);
    const heading = markup.indexOf('>No messages yet<');
    assert.ok(heading >= 0, markup);
    for (const row of none.rows) {
      assert.ok(markup.indexOf(`data-person="${row.id}"`) > heading, `${name}: ${row.id} under No messages yet`);
      if (row.line) assert.ok(markup.includes(esc(row.line)), `${name}: ${row.line}`);
    }
  }
});

test('F3: Last talked is the answer\'s talk: its day the conversation opened, its last line the one opened at, its place the network', () => {
  const read = fixture('person.full');
  const drawn = personPage({ page: read, photos: NO_PHOTOS, today: read.today });
  assert.equal(/data-people-open="([^"]+)"/u.exec(drawn)?.[1], read.talk.day);
  assert.equal(/data-people-focus="([^"]+)"/u.exec(drawn)?.[1], `a${read.talk.lines.at(-1).n}`);
  assert.match(/class="pp-talk__when mac-subhead">([^<]*)</u.exec(drawn)?.[1] ?? '', new RegExp(` · ${read.talk.network}$`, 'u'));
  const group = fixture('group.full');
  assert.equal(/data-people-open="([^"]+)"/u.exec(groupPage(group.talk.chat, group, group.today))?.[1], group.talk.day);
  const nothing = fixture('person.nothing');
  assert.equal(personPage({ page: nothing, photos: NO_PHOTOS, today: nothing.today }).includes('pp-talk'), nothing.talk !== null);
  const counting = fixture('person.counting');
  const held = personPage({ page: { ...counting, counting: true }, photos: NO_PHOTOS, today: counting.today });
  assert.ok(held.includes('ck-counting') && !held.includes('data-people-open'), 'a counting answer drawn as its skeleton');
});

test('F4: AIs in their own section, never among the people; a word typed finds in the answer\'s order', () => {
  const read = fixture('people.full');
  const ai = read.ai.map((/** @type {any} */ row) => row.id);
  assert.ok(ai.length > 0);
  const people = idsIn(sectionRows(read.sections, ROWS_SHOWN, read.today));
  assert.ok(ai.every((/** @type {string} */ id) => !people.includes(id)), 'an AI among the people');
  assert.deepEqual(idsIn(flatRows('AI', read.ai, ROWS_SHOWN, row => personRow(row, read.today))), ai);
  const rows = [read.you, ...read.sections.flatMap((/** @type {any} */ section) => section.rows), ...read.ai];
  const digits = findIn(rows, '1555000030');
  assert.deepEqual(digits.map(row => row.id), rows.filter(row => row.find.some((/** @type {string} */ each) => each.includes('1555000030')))
    .map(row => row.id));
  assert.ok(digits.length > 1, 'a handle\'s digits found');
  assert.deepEqual(findIn(rows, 'nobody-by-this-name'), []);
});

test('every case of filter.json: type-to-filter is the phone\'s rule', () => {
  const { cases } = JSON.parse(readFileSync(new URL('../../homelink/Tests/Fixtures/rules/filter.json', import.meta.url), 'utf8'));
  assert.ok(cases.length > 0);
  for (const each of cases) assert.equal(found(each.find, each.typed), each.shown, each.about);
});
