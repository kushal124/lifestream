// @ts-check
import { esc } from './lib/html.js';
import {
  button, calendarPicker, factChip, factChips, faceCrop, faceCropReading, faceGrid, faceGridReading,
  faceTile, faceTiles, fieldRow, fieldRowMenu, floatList, formAct, formAdd, formCard, icon, installMoveAndScale, meter, moveAndScale, nameRow,
  nameRowCardReading, personFace, personFaceReading, quietRing, rowsAcross, sectionLabel, tileRow, youCard,
} from './ui/kit/index.js';
import { sceneUrl } from './kit-gallery-scenes.js';
import {
  flatRows, groupsView, listBar, listViews, mostRows, pageBar, personRow, ROWS_SHOWN, sectionRows, tidyCard, youCardOf,
} from './ui/people/list.js';
import {
  namingAsk, namingCard, namingCheck, namingFaces, namingFoot, namingLeft, namingPeek, namingReading, namingRows, namingStop,
} from './ui/people/naming.js';
import { groupPage, personPage, yourPage } from './ui/people/person.js';
import { businessesDialog } from './ui/people/businesses.js';
import { counted, shiftDay } from './lib/words.js';
import { productName } from './lib/kinds.js';
import { listWords } from './ui/people/words.js';
import {
  findsList, kindMenu, newCard, panelBody, panelBodyReading, panelFinish, panelFoot, panelHead, rowsOf,
} from './ui/people/organise.js';
import {
  birthdayPane, emailPane, kindPane, morePane, notPersonPane, paneHead, personPane, personPaneReading, photoPane,
  profilePane, relPane, samePane, guessPane,
} from './ui/people/evidence.js';

/** @typedef {import('./ui/kit/face-grid.js').Face} Face */

/** @param {number} n */
const hashOf = n => `face-${n}`;
const SAM = [0, 12, 13, 14, 15, 16, 17, 18, 19];
/** @param {number} at */
const sam = at => SAM[at % SAM.length];
const LOST = 'lost';
const TODAY = '2026-10-15';

/**
 * @param {number} n
 * @param {Partial<Face>} [more]
 * @returns {Face}
 */
const crop = (n, more = {}) => ({ hash: hashOf(n), label: `Photo ${n + 1}`, attrs: {}, ...more });

/**
 * @param {string} label
 * @param {string} html
 * @param {string} [className]
 */
const specimen = (label, html, className = '') => `<div class="gallery__specimen${className ? ` ${className}` : ''}">`
  + `<p class="gallery__label mac-mono-label">${esc(label)}</p>${html}</div>`;
/**
 * @param {string} label
 * @param {string} html
 */
const reading = (label, html) => specimen(label, html, 'ck-reading');
/**
 * @param {string} name
 * @param {string} body
 */
const group = (name, body) => `<section class="gallery__group">${sectionLabel(name)}${body}</section>`;

/**
 * @param {string} bar
 * @param {string} body
 * @param {string} [className]
 */
const frame = (bar, body, className = '') => `<div class="gallery__page ck-page${className ? ` ${className}` : ''}">`
  + `<header class="ck-page__bar">${bar}</header>${body}</div>`;

const GROUP = [0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 7, 0].map((n, at) => crop(n || sam(at), {
  label: `Photo ${at + 1}`, on: at === 4 || at === 10, attrs: {},
}));


/** @typedef {import('./ui/people/organise.js').Person} Person */
/** @typedef {import('./pages.js').Row} Row */
/** @typedef {import('./pages.js').ChatRow} ChatRow */
/** @typedef {import('./pages.js').Person} PersonPage */
/** @typedef {import('./pages.js').Group} GroupPage */
/** @typedef {import('./pages.js').Talk} Talk */
/** @typedef {import('./ui/people/organise.js').Card} OrganiseCard */
/** @typedef {import('./ui/people/organise.js').Group} FaceGroup */
/** @typedef {import('./lib/photo-pages.js').PhotoPagesView<import('./ui/people/words.js').PhotoFace>} PhotosView */

const NOW = Date.parse('2026-10-15T09:41:00Z');
const DAY_MS = 86_400_000;

/** @type {Record<string, { id: string, name: string, photo: string | null, face: boolean }>} */
const OTHERS = {
  'person-samuel-r': { id: 'person:person-samuel-r', name: 'Samuel R.', photo: null, face: false },
  'a-rivera': { id: 'person:a-rivera', name: 'A. Rivera', photo: null, face: false },
};

/** @type {Person['where']} */
const SAM_CHATS = [
  { chat: 'whatsapp:15550000001@s.whatsapp.net', title: 'WhatsApp', group: false, network: 'WhatsApp', when: { kind: 'at', at_ms: NOW - 3_600_000 },
    count: 2122, line: '2,122 messages', quiet: false },
  { chat: 'imessage:+15550000001', title: 'iMessage', group: false, network: 'iMessage', when: { kind: 'at', at_ms: NOW - 5 * DAY_MS },
    count: 312, line: '312 messages', quiet: false },
];

/**
 * @param {Record<string, any> & { id: string, name: string }} given
 * @returns {Person}
 */
function someone(given) {
  /** @type {Record<string, any>} */
  const held = { by: 'contact', person: null, handles: [], networks: ['whatsapp'], received: 0, sent: 0, first_ms: NOW - 900 * DAY_MS,
    last_ms: NOW - 3_600_000, last_30: 0, suggestions: [], names_seen: [], mails_from: 0, mails_to: 0, ...given };
  const mails = held.mails_from + held.mails_to;
  /** @type {Person['suggestions']} */
  const suggestions = held.suggestions.map((/** @type {any} */ each) => ({ ...each, other: each.kind === 'same' ? OTHERS[each.value] ?? null : null }));
  return {
    id: held.id, name: held.name, named: held.by !== 'none', call: held.by === 'none' ? null : held.call_name ?? held.name, full_name: held.full_name ?? null,
    show: 'name', name_from: null, relationship: held.relationship ?? null, details: held.details ?? null, entity: held.entity ?? 'person',
    entity_by: held.entity_by ?? 'you', me: held.me === true, record: held.person, face: Boolean(held.person) && held.handles.length === 0,
    photo: held.photo ? held.photo.crop : null, handles: held.handles.map((/** @type {any} */ each) => ({ own: false, ...each })), suggestions,
    also_called: held.also_called ?? [], joined: (held.joined ?? []).map((/** @type {any} */ each) => ({ ...each, photo: each.photo ? each.photo.crop : null })),
    names_seen: held.names_seen, reach: listWords([...held.networks.map(productName), ...(mails ? ['Mail'] : [])]) || null,
    since: held.first_ms === null ? null : { kind: 'at', at_ms: held.first_ms }, last: held.last_ms === null ? null : { kind: 'at', at_ms: held.last_ms },
    much: [counted(held.received + held.sent, 'message'), mails ? counted(mails, 'mail') : ''].filter(Boolean).join(' · '), month: held.last_30,
    mails: { from: held.mails_from, to: held.mails_to, newest: held.newest ?? [] }, talk: held.talk ?? null, where: held.where ?? [],
  };
}

/**
 * @param {Person} person
 * @returns {import('./ui/people/organise.js').Find}
 */
const foundOf = person => ({ kind: 'person', row: { id: person.id, name: person.name, named: person.named, face: person.face, photo: person.photo, when: person.last,
  line: null, find: [person.name] } });

const SAM_RAW = {
  id: 'phone:+15550000001', name: 'Sam', call_name: 'Sam', by: 'contact', networks: ['whatsapp', 'imessage'],
  chats: [{ key: 'whatsapp:15550000001@s.whatsapp.net', count: 2122 }, { key: 'imessage:+15550000001', count: 312 }],
  received: 2434, sent: 2260, last_30: 184, photo: null, first_ms: Date.parse('2024-11-02T10:00:00Z'),
  handles: [{ id: 'phone:+15550000001', kind: 'phone', network: null, words: '+15550000001', from: 'Contacts' },
    { id: 'jid:15550000001@lid', kind: 'jid', network: null, words: 'Hidden number', from: 'WhatsApp' }],
  names_seen: ['Sam Rivera', 'Samuel Rivera'],
  suggestions: [
    { id: 's1', kind: 'full_name', value: 'Sam Rivera', reasons: { whatsapp: 1, mail: 3 }, ticked: true },
    { id: 's2', kind: 'handle', value: 'email:sam.rivera@example.com', reasons: { mails_from: 9, mails_to: 5 }, ticked: true },
    { id: 's3', kind: 'same', value: 'person-samuel-r', reasons: { linked: 0, named: 1, seen: 0 }, ticked: false },
  ],
  where: SAM_CHATS,
};
const SAM_PERSON = someone(SAM_RAW);
/** @type {FaceGroup} */
const SAM_FACES = { id: 'cluster-a', faces: 214, photos: 198, years: [2019, 2026], sample: [hashOf(0), hashOf(12), hashOf(13)],
  reason: 'They sent you 6 of these photos', crops: { [hashOf(0)]: hashOf(0), [hashOf(12)]: hashOf(12), [hashOf(13)]: hashOf(13) } };
const NAMESAKE = someone({ id: 'person:a-rivera', name: 'A. Rivera', full_name: 'Alex Rivera', person: 'a-rivera', by: 'record',
  networks: ['imessage'], received: 6, sent: 2, handles: [{ id: 'email:a.rivera@example.net', kind: 'email', network: null,
    words: 'a.rivera@example.net', from: 'Contacts' }] });
const signedAs = (/** @type {string} */ address) => ({ 'sam.rivera@example.com': 'Sam Rivera', 'dana.okafor@example.com': 'Dana Okafor',
  'alex.rivera@studio.example.com': 'Alex Rivera' })[address] ?? '';
const ASSISTANT = someone({ id: 'phone:+15550000100', name: 'Synthetic Assistant', call_name: 'Synthetic Assistant', networks: ['imessage'],
  received: 212, sent: 220, last_30: 40, first_ms: Date.parse('2026-06-03T10:00:00Z'),
  handles: [{ id: 'phone:+15550000100', kind: 'phone', network: null, words: '+15550000100', from: 'Contacts' }],
  suggestions: [{ id: 'a1', kind: 'entity', value: 'ai', reasons: { quick: 193, replies: 212 }, ticked: true }] });
const NUMBER = someone({ id: 'phone:+15550000014', name: '+15550000014', by: 'none', networks: ['whatsapp'], received: 31, sent: 12,
  last_30: 6, first_ms: Date.parse('2026-09-20T10:00:00Z'),
  handles: [{ id: 'phone:+15550000014', kind: 'phone', network: null, words: '+15550000014', from: 'WhatsApp' }] });
const DANA = someone({ id: 'person:person-dana', name: 'Dana Okafor', person: 'person-dana', by: 'record', received: 980, sent: 700,
  photo: { crop: hashOf(1) }, networks: ['whatsapp'], handles: [{ id: 'phone:+15550000002', kind: 'phone', network: null, words: '+15550000002', from: null }] });
const DANA_FACE = someone({ id: 'person:person-dana-face', name: 'Dana O.', person: 'person-dana-face', by: 'record', networks: [],
  photo: { crop: hashOf(1) } });
const DANA_MAIL = someone({ id: 'email:dana.okafor@example.com', name: 'dana.okafor@example.com', by: 'none', networks: [],
  mails_from: 6, mails_to: 2, handles: [{ id: 'email:dana.okafor@example.com', kind: 'email', network: null, words: 'dana.okafor@example.com', from: null }] });


/**
 * @param {string} name
 * @param {number | null} face
 * @param {number | null} last_ms
 * @param {Partial<Row>} [more]
 * @returns {Row}
 */
const listed = (name, face, last_ms, more = {}) => ({ id: `person:${name.toLowerCase().replace(/\W+/gu, '-')}`, name, named: true, face: false,
  photo: face === null ? null : hashOf(face), when: last_ms === null ? null : { kind: 'at', at_ms: last_ms }, line: null, find: [name], ...more });

/**
 * @param {Row | null} you
 * @param {import('./ui/people/list.js').Tidy} tidy
 */
const sideColumn = (you, tidy) => '<aside class="ck-page__side ck-page__side--top pp-side" aria-label="You and what is left to tidy">'
  + `${youCardOf(you)}${tidyCard(tidy)}</aside>`;

/**
 * @param {{ row: Row, line: string }[]} most
 * @param {import('./pages.js').People['sections']} sections
 * @param {{ people: number, ai: number, groups: number }} counts
 * @param {import('./ui/people/list.js').Tidy} tidy
 * @param {Row | null} [you]
 */
const listPage = (most, sections, counts, tidy, you = null) => frame(listBar('', true, true), '<div class="ck-page__body">'
  + `<div class="ck-page__main pp-main pp-cards">${listViews('', counts)}${mostRows(most)}${sectionRows(sections, ROWS_SHOWN, TODAY)}</div>`
  + `${sideColumn(you, tidy)}</div>`);

/** @type {import('./ui/people/list.js').Tidy} */
const FULL_TIDY = {
  organise: '42 organised · 120 more you talk to often', businesses: '166 to accept', faces: { names: 164, people: 3 }, askFaces: false,
  fresh: [{ row: listed('Priya Nair', 10, NOW - DAY_MS), line: 'New · 14 messages' }],
};

/**
 * @param {string} words
 * @param {'phone' | 'email'} kind
 * @param {string} from
 * @param {boolean} [own]
 * @returns {import('./ui/people/words.js').Handle}
 */
const yours = (words, kind, from, own = false) => ({ id: `${kind}:${words.replace(/\s/gu, '')}`, kind, network: null, words, from, own });
const DOZEN = [
  yours('+1 555 0100 003', 'phone', 'Contacts'), yours('+1 555 0100 001', 'phone', 'Your WhatsApp', true),
  yours('a.rivera@example.org', 'email', 'Contacts'), yours('+1 555 0100 002', 'phone', 'Your iMessage', true),
  yours('alex@icloud.example.com', 'email', 'Your iMessage', true), yours('+1 555 0100 004', 'phone', 'Contacts'),
  yours('alex@example.com', 'email', 'Your Gmail', true), yours('alex.rivera@example.com', 'email', 'Your Gmail', true),
  yours('arivera@work.example.com', 'email', 'Contacts'), yours('alex.rivera.2014@example.com', 'email', 'You added'),
  yours('alex.r@example.net', 'email', 'Contacts'), yours('+1 555 0100 005', 'phone', 'You added'),
];
const LONG_NAME = 'Alexandria Konstantinopoulou-Ramaswamy';
const YOU_RAW = { id: 'person:alex-rivera', name: 'Alex', call_name: 'Alex', full_name: 'Alex Rivera', show: 'name',
  by: 'record', person: 'alex-rivera', me: true, organised: true, photo: { crop: hashOf(0) }, handles: DOZEN, last_ms: null,
  first_ms: null, suggested: 2, also_called: [{ name: 'Lexi', from: 'Contacts' }, { name: 'Ali R.', from: 'Contacts' },
    { name: 'Al', from: 'You added' }] };
const YOU = someone(YOU_RAW);
const YOU_DAY_ONE_RAW = { ...YOU_RAW, photo: null, handles: [], also_called: [], suggested: 0 };
const YOU_DAY_ONE = someone(YOU_DAY_ONE_RAW);
/** @type {Row} */
const YOU_ROW = { id: YOU.id, name: 'Alex', named: true, face: false, photo: hashOf(0), when: null, line: '2 suggestions', find: ['Alex'] };

/**
 * @param {string} name
 * @param {number | null} face
 * @param {number} messages
 * @param {number} last_ms
 */
const most = (name, face, messages, last_ms) => ({ row: listed(name, face, last_ms), line: `${messages} messages` });

const LIST_FULL = () => listPage([
  most('Sam Rivera', 0, 388, NOW - 600_000), most('Dana Okafor', 1, 301, NOW - 1_800_000), most('Mira Sen', 2, 288, NOW - 3_600_000),
  most('Theo Lang', null, 201, NOW - 5_400_000), most('Jun Park', 3, 176, NOW - 2 * DAY_MS),
], [{ key: 'month:2026-10', title: null, rows: [
  listed('Leo Brandt', 4, NOW - 3 * DAY_MS), listed('Ines Duarte', 5, NOW - 3 * DAY_MS - 600_000),
  listed('Synthetic Assistant', null, NOW - 4 * DAY_MS),
  listed('+15550000014', null, NOW - 4 * DAY_MS - 600_000, { id: 'phone:+15550000014', named: false }),
] }, { key: 'none', title: 'No messages yet', rows: [listed('Robin Example', null, null, { line: 'Contact card' })] }],
{ people: 248, ai: 2, groups: 41 }, FULL_TIDY, YOU_ROW);

const LIST_LITTLE = () => listPage([], [
  { key: 'month:2026-10', title: null, rows: [listed('Sam Rivera', null, NOW - 2 * DAY_MS), listed('Dana Okafor', null, NOW - 3 * DAY_MS)] },
  { key: 'month:2026-03', title: null, rows: [listed('Mira Sen', null, Date.parse('2026-03-12T12:00:00Z'))] },
  { key: 'month:2026-02', title: null, rows: [listed('Theo Lang', null, Date.parse('2026-02-02T12:00:00Z'))] },
], { people: 4, ai: 0, groups: 0 }, { organise: '0 organised · 4 more', businesses: null, faces: null, askFaces: true, fresh: [] });


/** @type {import('./ui/people/list.js').Tidy} */
const SHORT_TIDY = { ...FULL_TIDY, businesses: null, fresh: [] };
/** @type {import('./ui/people/list.js').Tidy} */
const NOTHING_TO_TIDY = { organise: null, businesses: null, faces: null, askFaces: false, fresh: [] };

/**
 * @param {Row} you
 * @param {import('./ui/people/list.js').Tidy} tidy
 */
const YOU_SIDE = (you, tidy) => sideColumn(you, tidy);

const YOU_FOUND = () => frame(listBar('al', true, true), '<div class="ck-page__body"><div class="ck-page__main pp-main pp-cards">'
  + flatRows('3 found', [{ ...YOU_ROW, line: 'You' }, listed('Alba Ruiz', 5, NOW - 3 * DAY_MS), listed('Alma Ortiz', null, NOW - 12 * DAY_MS)],
    ROWS_SHOWN, row => personRow(row, TODAY)) + `</div>${sideColumn(YOU_ROW, FULL_TIDY)}</div>`);

const YOUR_PHOTOS = {
  total: 86, page: 0, size: 12, error: '',
  photos: Array.from({ length: 12 }, (_, at) => ({ image: hashOf(sam(at)), face: `face-${at}`, box: [], at_ms: null, crop: hashOf(sam(at)) })),
};
const NO_PHOTOS = { total: 0, page: 0, size: 12, error: '', photos: [] };

/** @type {PersonPage['edit']} */
const NO_EDIT = { call: null, full_name: null, name_from: null, record_id: null, face: false, reach: null, last: null,
  much: '0 messages', mails: { from: 0, to: 0, newest: [] }, record: null, details: null, suggestions: [], also_called: [], names_seen: [], joined: [] };

/**
 * @param {PersonPage['head']} head
 * @param {Partial<PersonPage>} [more]
 * @returns {PersonPage}
 */
const personAnswer = (head, more = {}) => ({ position: '1:1', today: TODAY, became: null, me: false, head, handles: [],
  month: { days: [], count: 0, calls: null, line: 'None in the last 30 days', before: null },
  history: { kind: 'facts', total: 0, first: null }, talk: null, where: [], suggestions_line: null, edit: NO_EDIT, counting: false, ...more });

/** @type {PersonPage['head']} */
const YOUR_HEAD = { name: 'Alex', named: true, full_name: 'Alex Rivera', photo: hashOf(0), chips: [], since: null, relationship: null,
  work: null, entity: 'person', entity_by: null };
const YOUR_ANSWER = personAnswer(YOUR_HEAD, { handles: DOZEN.map(handle => ({ ...handle, own: handle.own ?? false })),
  edit: { ...NO_EDIT, also_called: [{ name: 'Lexi', from: 'Contacts' }, { name: 'Ali R.', from: 'Contacts' }, { name: 'Al', from: 'You added' }] } });

/**
 * @param {PersonPage} page
 * @param {import('./lib/photo-pages.js').PhotoPagesView<import('./ui/people/words.js').PhotoFace>} photos
 */
const YOUR_PAGE = (page, photos) => frame(pageBar(page.head.name), yourPage({ page, photos }));

/** @type {Talk} */
const TALK_RUN = { day: '2026-10-15', chat: 'whatsapp:15550000001@s.whatsapp.net', title: 'Sam', group: false, network: 'WhatsApp',
  lines: [
    { who: 'phone:+15550000001', name: 'Sam', text: 'Are we still on for Saturday?', forwarded: false, at_ms: NOW - 3_700_000, mine: false, n: 2 },
    { who: YOU.id, name: 'You', text: 'Yes. Ten at the usual place', forwarded: false, at_ms: NOW - 3_650_000, mine: true, n: 3 },
    { who: 'phone:+15550000001', name: 'Sam', text: 'Perfect, bringing the photos', forwarded: false, at_ms: NOW - 3_600_000, mine: false, n: 4 },
  ], folded: [], focus: 'a4' };
/** @type {import('./ui/people/person.js').Read<import('./ui/people/words.js').Photos>} *//** @type {import('./ui/people/person.js').Read<import('./ui/people/words.js').Photos>} */
const SAM_PHOTOS = { state: 'read', value: { position: '', total: 14, photos: Array.from({ length: 14 }, (_, at) => ({
  image: hashOf(sam(at)), face: `face-${at}`, box: [], at_ms: null, crop: hashOf(sam(at)) })) } };

/**
 * @param {object} stage
 * @param {string} stage.panel
 * @param {string} stage.pane
 */
const organiseStage = ({ panel, pane }) => '<div class="gallery__page ck-page pp gallery__stage"><div class="pp-stage">'
  + `${panel}<div class="pp-window"><div class="pp-window__in">${pane}</div></div></div></div>`;

/**
 * @param {string} markup
 * @param {string} row
 */
const lit = (markup, row) => markup.replace(new RegExp(`<(button|div|label)([^>]*?) class="([^"]*)"([^>]*data-row="${row}")`, 'u'),
  (_, tag, before, classes, after) => `<${tag}${before} class="${classes} is-lit"${after}`);

/**
 * @param {object} panel
 * @param {'organise' | 'edit'} panel.mode
 * @param {string} panel.body
 * @param {string} [panel.said]
 * @param {string} [panel.pop]
 * @param {number} [panel.top]
 * @param {string} [panel.foot]
 * @param {boolean} [panel.counted]
 * @param {boolean} [panel.more]
 * @param {boolean} [panel.you]
 */
const organisePanel = ({ mode, body, said = '', pop = '', top = 0, foot, counted = mode === 'organise', more = false, you = false }) => `<section class="pl-card ck-float pp-panel${mode === 'edit' ? ' pp-panel--edit' : ''}${more ? ' has-more' : ''}" aria-label="Organise your people">`
  + panelHead({ mode, count: counted ? { at: 43, of: 162, words: '42 organised · 120 more you talk to often' } : null, you })
  + `<div class="pp-panel__body">${body}</div>${foot ?? panelFoot({ mode, said, undo: Boolean(said), you })}`
  + (pop ? `<div class="pp-pop" data-geo="top:${top}px">${pop}</div>` : '') + '</section>';

const ON_TODAY = { year: 2026, month: 10, day: 15 };

/**
 * @param {OrganiseCard} card
 * @param {{ menu?: boolean, typed?: string, calendar?: import('./ui/people/organise.js').CalendarAt | null }} [more]
 */
const bodyOf = (card, { menu = false, typed = '', calendar = null } = {}) => panelBody({ card, signed: signedAs, menu,
  browsing: false, typed, calendar, today: ON_TODAY });
const samCard = () => newCard(SAM_PERSON, [SAM_FACES], true);
const samPane = () => personPane({ person: { ...SAM_PERSON, talk: TALK_RUN }, name: 'Sam', face: personFace({ name: 'Sam', size: 'head' }),
  photos: SAM_PHOTOS });

const ORGANISE = () => organiseStage({ panel: organisePanel({ mode: 'organise', body: bodyOf(samCard()), said: 'Dana Okafor confirmed', more: true }),
  pane: samPane() });

const ORGANISE_EMAIL = () => {
  const card = samCard();
  return organiseStage({ panel: organisePanel({ mode: 'organise', body: lit(bodyOf(card), 'o:s2'), more: true }),
    pane: emailPane('sam.rivera@example.com', 'Suggested email', { state: 'read', value: someone({ id: 'email:sam.rivera@example.com',
      name: 'sam.rivera@example.com', mails_from: 9, mails_to: 5, names_seen: ['Sam Rivera'], newest: [
        { family: 'mail', title: 'Photos from the weekend', from: 'Sam Rivera', day: '2026-10-12' },
        { family: 'calendar', title: 'Dinner', from: 'Sam Rivera', day: '2026-10-03' },
        { family: 'mail', title: 'Re: Flat viewing', from: 'You', day: '2026-09-28' },
      ] }) }) });
};


const ORGANISE_AI = () => {
  const card = newCard(ASSISTANT, [], false);
  return organiseStage({ panel: organisePanel({ mode: 'organise', body: bodyOf(card) }),
    pane: personPane({ person: ASSISTANT, name: 'Synthetic Assistant', face: personFace({ name: 'Synthetic Assistant', size: 'head' }),
      photos: { state: 'read', value: { position: '', total: 0, photos: [] } } }) });
};

const ORGANISE_MENU = () => {
  const card = newCard(NUMBER, [], true);
  return organiseStage({ panel: organisePanel({ mode: 'organise', body: lit(bodyOf(card, { menu: true }), 'notperson'), pop: kindMenu(0, null), top: 368 }),
    pane: notPersonPane(TALK_RUN) });
};

const ORGANISE_FINDS = () => {
  const card = newCard(NUMBER, [], true);
  return organiseStage({ panel: organisePanel({ mode: 'organise', body: lit(bodyOf(card, { typed: 'dana' }), 'add'),
    pop: findsList([DANA, DANA_FACE, DANA_MAIL].map(foundOf), 0, 'dana'), top: 520 }),
  pane: samePane({ state: 'read', value: DANA }, 'Found') });
};

const EDIT = () => {
  const card = samCard();
  card.said = 'business';
  return organiseStage({ panel: organisePanel({ mode: 'edit', body: lit(bodyOf(card), 'f:rel'), more: true }), pane: relPane(card) });
};

const SAM_DETAILED = someone({ ...SAM_RAW, id: 'person:sam-rivera', person: 'sam-rivera', by: 'record', name: 'Sam Rivera',
  details: { work: 'Designer at a studio', birthday: null, profiles: [{ network: 'instagram', value: 'sam.rivera.example' }] },
  suggestions: [...SAM_RAW.suggestions,
    { id: 's4', kind: 'birthday', value: '08-14', reasons: { wished: 3 }, ticked: false },
    { id: 's5', kind: 'profile', value: 'github:sam-rivera-example', reasons: { cards: 1 }, ticked: false }] });

const ORGANISE_DETAILS = () => {
  const card = newCard(SAM_DETAILED, [], true);
  card.ticks.set('o:s4', true);
  card.birthday = { month: 8, day: 14, year: null };
  card.shows.birthday = true;
  return organiseStage({ panel: organisePanel({ mode: 'edit', body: lit(bodyOf(card, { calendar: { month: 8, year: '', typed: null, at: null } }), 'f:birthday'),
    more: true }), pane: birthdayPane(card) });
};

const ORGANISE_WISH = () => {
  const card = newCard(SAM_DETAILED, [], true);
  const [wish] = rowsOf(card).flatMap(row => row.kind === 'guess' ? [row] : []);
  return organiseStage({ panel: organisePanel({ mode: 'edit', body: lit(bodyOf(card), wish ? wish.id : ''), more: true }),
    pane: wish ? guessPane(wish.suggestion) : '' });
};

const ORGANISE_PROFILE = () => {
  const card = newCard(SAM_DETAILED, [], true);
  return organiseStage({ panel: organisePanel({ mode: 'edit', body: lit(bodyOf(card), 'p:instagram:sam.rivera.example'), more: true }),
    pane: profilePane({ network: 'instagram', value: 'sam.rivera.example' }, 'Theirs') });
};

const ALBUM = () => ({ position: '', photos: Array.from({ length: 60 }, (_, at) => ({ image: hashOf(sam(at)), face: `face-${at}`, box: [],
  at_ms: NOW - at * 9 * DAY_MS, crop: hashOf(sam(at)) })), total: 214, next: 'after-60', reading: false, failed: '' });

const ORGANISE_CHOOSER = () => {
  const card = newCard(SAM_RIVERA, [], true);
  card.page = 1;
  return organiseStage({ panel: organisePanel({ mode: 'edit', body: bodyOf(card), more: true }),
    pane: photoPane(card, ALBUM(), { lit: false }) });
};

const EDIT_MORE = () => {
  const card = newCard(SAM_RIVERA, [SAM_FACES], true);
  card.maybe = 214;
  return organiseStage({ panel: organisePanel({ mode: 'edit', body: lit(bodyOf(card), 'more'), more: true }), pane: morePane(card) });
};

const YOU_EDITING = someone({ ...YOU_RAW, details: { work: null, birthday: null, profiles: [] }, suggestions: [
  { id: 'y1', kind: 'handle', value: 'email:alex.rivera@studio.example.com', reasons: { mails_from: 6, mails_to: 0 }, ticked: true },
  { id: 'y2', kind: 'same', value: 'a-rivera', reasons: { linked: 0, named: 1, seen: 0 }, ticked: false }] });
/** @param {Person} you */
const yourPane = you => personPane({ person: you, name: you.name, face: personFace({ name: you.name, photo: you.photo ? hashOf(0) : '',
  size: 'head' }), photos: SAM_PHOTOS });

const YOUR_EDIT = (/** @type {string} */ row = '') => {
  const card = newCard(YOU_EDITING, [], true);
  card.maybe = 40;
  const body = bodyOf(card);
  return organiseStage({ panel: organisePanel({ mode: 'edit', body: row ? lit(body, row) : body, more: true, you: true }),
    pane: row === 'o:y2' ? samePane({ state: 'read', value: NAMESAKE }, 'Same person?') : yourPane(YOU) });
};

const YOUR_EDIT_DAY_ONE = () => organiseStage({ panel: organisePanel({ mode: 'edit', you: true,
  body: bodyOf(newCard(someone({ ...YOU_DAY_ONE_RAW, details: { work: null, birthday: null, profiles: [] } }), [], true)) }),
  pane: yourPane(YOU_DAY_ONE) });

const RILEY = someone({ id: 'person:riley', name: 'Riley', call_name: 'Riley', full_name: 'Riley Example', person: 'riley', by: 'record',
  networks: ['whatsapp', 'imessage'], received: 3, sent: 1, details: { work: null, birthday: null, profiles: [] },
  handles: [
    { id: 'phone:+15550000021', kind: 'phone', network: null, words: '+1 555 000 0021', from: 'Contacts' },
    { id: 'phone:+15550000023', kind: 'phone', network: null, words: '+1 555 000 0023', from: 'You added' },
    { id: 'email:riley@work.example', kind: 'email', network: null, words: 'riley@work.example', from: 'You added' },
    { id: 'phone:+15550000024', kind: 'phone', network: null, words: '+1 555 000 0024', from: 'Contacts' }],
  also_called: [{ name: 'Big Riley', from: 'You added' }, { name: 'Bear', from: 'Contacts' }],
  joined: [
    { id: 'person:riley-work', name: 'Riley Work', photo: null, handles: ['phone:+15550000022', 'phone:+15550000023', 'email:riley@work.example'],
      with: ['Riley Old'] },
    { id: 'person:riley-old', name: 'Riley Old', photo: null, handles: ['phone:+15550000023'], with: [] },
    { id: 'person:riley-b', name: 'Riley B.', photo: { crop: hashOf(4) }, handles: ['phone:+15550000024'], with: [] }] });

const EDIT_JOINED = (/** @type {string[]} */ split = []) => {
  const card = newCard(RILEY, [], true);
  for (const id of split) card.split.add(id);
  return organiseStage({ panel: organisePanel({ mode: 'edit', body: bodyOf(card), more: true }),
    pane: personPane({ person: RILEY, name: 'Riley', face: personFace({ name: 'Riley', size: 'head' }),
      photos: { state: 'read', value: { position: '', total: 0, photos: [] } } }) });
};

const ORGANISE_READING = () => organiseStage({ panel: organisePanel({ mode: 'organise', body: panelBodyReading() }), pane: personPaneReading() })
  .replace('class="pp-stage"', 'class="pp-stage ck-reading"');

const ORGANISE_FINISH = () => {
  const people = [['Sam Rivera', 0, 'WhatsApp'], ['Dana Okafor', 1, 'WhatsApp'], ['Mira Sen', 2, 'iMessage'], ['Theo Lang', null, 'Mail']]
    .map(([name, face, line]) => ({ name: String(name), line: String(line),
      face: personFace({ name: String(name), photo: face === null ? '' : hashOf(Number(face)), size: 'md' }) }));
  const { body, foot } = panelFinish({ people, minutes: 12, skipped: 3 });
  return organiseStage({ panel: organisePanel({ mode: 'organise', body, foot, counted: false }),
    pane: paneHead('People', 'Your people', '4 organised this visit · 46 organised · 116 more you talk to often') });
};


/** @typedef {import('./ui/people/naming.js').NamingRow} NamingRow */

/**
 * @param {string} name
 * @param {number | null} face
 * @param {string} line
 * @returns {NamingRow}
 */
const who = (name, face, line) => ({ lead: personFace({ name, photo: face === null ? '' : hashOf(face) }), name, line });
/** @returns {NamingRow} */
const ASIDE = () => ({ lead: quietRing('close'), name: 'Set aside', line: 'Not someone you’ll name, or not a face' });
/**
 * @param {number} count
 * @param {number[]} [out]
 */
const groupFaces = (count, out = []) => Array.from({ length: count }, (_, at) => crop(sam(at), {
  label: `Face ${at + 1}`, on: out.includes(at) }));
const MIXED = () => groupFaces(12, [4, 9]).map((face, at) => (at === 4 || at === 9
  ? { ...face, hash: hashOf(at === 4 ? 7 : 11) } : face));

/**
 * @param {string} body
 * @param {string | null} [left]
 */
const deck = (body, left = '152 groups left') => '<div class="gallery__page gallery__deck ck-page'
  + `${left === null ? ' ck-reading' : ''}"><header class="ck-page__bar">`
  + pageBar('Name faces', (left === '' ? '' : namingLeft(left)) + button('Done', { variant: 'plain', key: 'Esc' }))
  + `</header><div class="ck-page__scroll"><div class="pp-faces">${body}</div></div></div>`;

/**
 * @param {object} card
 * @param {import('./ui/kit/face-grid.js').Face[]} card.faces
 * @param {NamingRow[]} card.rows
 * @param {number | null} [card.lit]
 * @param {string} [card.field]
 * @param {string} [card.said]
 * @param {{ said: import('./lib/reach.js').Said, words: string, again: boolean } | null} [card.failure]
 * @param {boolean} [card.back]
 * @param {boolean} [card.all]
 * @param {string} [card.span]
 * @param {string} [card.none]
 */
const namingDeck = ({ faces, rows, lit = null, field = '', said = '', failure = null, back = false, all = false,
  span = 'in 95 photos, 2020–2023', none = '' }) => deck(namingCard({
  id: 'gallery', field,
  faces: namingFaces({ faces, all, span,
    more: all ? { label: 'Show 12' } : faces.length >= 12 ? { label: 'Show all 95' } : null }),
  rows: namingRows(rows, lit, none), foot: namingFoot({ said, failure, back }),
}));

/** @param {string} [next] */
const stopActs = next => (next ? button(next, { variant: 'primary', key: '⏎' }) : '')
  + button('Done', { variant: next ? 'plain' : 'primary', key: 'Esc' });

const SURE = () => [
  who('Sam Rivera', 0, 'WhatsApp, 1,240 messages · looks like Sam in 40 named photos'),
  who('Samuel Reyes', 8, 'iMessage, 86 messages · named “Sam” in Google Photos'),
  ASIDE(),
];
const NAMING_SURE = () => namingDeck({ faces: groupFaces(12), rows: SURE(), lit: 0 });
const NAMING_UNSURE = () => namingDeck({ faces: groupFaces(7), span: 'in 31 photos, 2022–2025', rows: [
  who('Dana Okafor', 1, 'WhatsApp, 412 messages · sent you 3 photos with this face'),
  who('Jun Park', 3, 'in your photos on 9 of the days you messaged most'),
  ASIDE(),
] });
const NAMING_NONE = () => namingDeck({ faces: groupFaces(3), span: 'in 12 photos, 2024', rows: [ASIDE()],
  none: 'No suggestion from your messages or Google Photos' });
const NAMING_YOU = () => namingDeck({ faces: groupFaces(12), lit: 0, rows: [
  { lead: personFace({ name: 'Alex', photo: hashOf(0) }), name: 'You · Alex', line: 'the person your own accounts belong to' },
  who('Leo Brandt', 4, 'WhatsApp, 230 messages · looks like Leo in 12 named photos'),
  ASIDE(),
] });
const NAMING_TYPING = () => namingDeck({ faces: groupFaces(7), span: 'in 31 photos, 2022–2025', field: 'Son', lit: 0,
  rows: [
    who('Sonia Lund', null, 'WhatsApp, 2,140 messages; iMessage, 310'),
    who('Sonny Adeyemi', null, 'iMessage, 44 messages'),
    who('Sonja Weber', null, 'in groups only'),
    { lead: quietRing('add'), name: 'New person “Son”', line: 'Not in your people yet' },
    ASIDE(),
  ] });
const NAMING_OUT = () => namingDeck({ faces: MIXED(), rows: SURE(), lit: 0 });
const NAMING_ALL = () => namingDeck({ faces: groupFaces(40), all: true, rows: SURE(), lit: 0 });
const NAMING_ASIDE = () => namingDeck({ faces: groupFaces(4), span: 'in 14 photos, 2019', lit: 1,
  rows: [who('Theo Lang', null, 'iMessage, 6 messages · named “Theo” in Google Photos'), ASIDE()] });
const NAMING_AFTER = () => namingDeck({ faces: groupFaces(12), rows: SURE(), lit: 0, back: true,
  said: 'Mira Sen · now in 135 photos' });
const NAMING_REFUSED = () => namingDeck({ faces: groupFaces(12), rows: SURE(), lit: 0, back: true,
  failure: { said: 'refused', words: 'Not saved: Lifestream refused it.', again: false } });
const NAMING_CHECKPOINT = () => deck(namingStop({ title: 'That’s everyone in 10 or more photos',
  line: '245 smaller groups left', acts: stopActs('Keep going') }));
/** @type {[string, number][]} */
const NAMED = [['Sam Rivera', 0], ['Dana Okafor', 1], ['Mira Sen', 2], ['Jun Park', 3], ['Leo Brandt', 4],
  ['Ines Duarte', 5]];
const NAMING_FINISH = () => deck(namingStop({ title: '6 people named · in 6 m',
  named: NAMED.map(([name, face]) => ({ name, photo: hashOf(face) })), line: '4 set aside · 14 skipped',
  acts: stopActs('Go through the skipped again') }), '');
const NAMING_FINISH_NOBODY = () => deck(namingStop({ title: '4 set aside · 14 skipped',
  acts: stopActs('Go through the skipped again') }), '');
const NAMING_EMPTY = () => deck(namingStop({ title: 'Everyone in your photos is named or set aside',
  line: 'New photos of the people you named are named as they arrive.', acts: stopActs() }), '');
const NAMING_READING = () => deck(namingReading({ value: '61,300 of 106,134', share: 61300 / 106134 }), null);

const NAMING_CHECK = (peek = false) => {
  const faces = Array.from({ length: 36 }, (_, at) => crop(at === 7 || at === 23 ? 9 + (at % 3) : sam(at), {
    label: `Face ${at + 1}`, on: at === 7 || at === 23 }));
  return deck(namingCheck({
    id: 'gallery',
    faces: namingFaces({ faces, all: false, span: 'Best matches first. Click any that aren’t Sam, then ⏎.', more: null,
      label: 'Faces that may be Sam', peek: peek ? namingPeek({ hash: hashOf(0), face: 'gallery', words: 'Space or Esc to close' }) : '' }),
    ask: namingAsk({ face: personFace({ name: 'Sam Rivera', photo: hashOf(0), size: 'tile' }), name: 'Sam', waiting: '1 of 6 screens · 200 faces' }),
    rows: namingRows([
      { lead: personFace({ name: 'Sam Rivera', photo: hashOf(0) }), name: 'Add 34 to Sam', line: 'The 2 you clicked are not Sam' },
      { lead: quietRing('close'), name: 'None of these are Sam', line: 'They leave the list, and stay unnamed' },
    ], 0),
    foot: namingFoot({ said: '', failure: null, back: false }),
  }), '152 groups to name · 3 people to check');
};


const DAYS = Object.fromEntries(Array.from({ length: 730 }, (_, at) => {
  const day = new Date(Date.parse(`${TODAY}T12:00:00Z`) - at * 86_400_000).toISOString().slice(0, 10);
  return [day, at > 520 ? (at % 23 === 0 ? 4 : 0) : (at * 37) % 11 + (at % 7 === 0 ? 0 : 6)];
}));

const PHOTOS = () => faceGrid({ faces: Array.from({ length: 11 }, (_, at) => crop(sam(at), { label: `Sam Rivera, photo ${at + 1}` })),
  label: 'Sam Rivera’s photos', more: { count: 203, attrs: {} } });

const SAM_RIVERA = someone({ ...SAM_RAW, id: 'person:sam-rivera', person: 'sam-rivera', name: 'Sam Rivera', by: 'record',
  relationship: 'Friend from college', photo: { crop: hashOf(0) }, mails_from: 9, mails_to: 5, days_count: 523, days: DAYS,
  details: { work: 'Designer at a studio', birthday: { month: 10, day: 19, year: null },
    profiles: [{ network: 'instagram', value: 'sam.rivera.example' }, { network: 'site', value: 'example.com/sam' }] } });

/** @type {PhotosView} */
const SAM_PAGE_PHOTOS = {
  total: 214, page: 0, size: 12, error: '',
  photos: Array.from({ length: 12 }, (_, at) => ({ image: hashOf(sam(at)), face: `face-${at}`, box: [], at_ms: null,
    crop: hashOf(sam(at)) })),
};

const MONDAY = '2026-10-12';
const BUSIEST_WEEK = 88;
/** @type {PersonPage['head']} */
const SAM_HEAD = { name: 'Sam Rivera', named: true, full_name: null, photo: hashOf(0),
  chips: [{ kind: 'birthday', month: 10, day: 19 },
    { kind: 'profile', network: 'instagram', words: '@sam.rivera.example', href: 'https://www.instagram.com/sam.rivera.example/' },
    { kind: 'profile', network: 'site', words: 'example.com', href: 'https://example.com/sam' }],
  since: { kind: 'at', at_ms: Date.parse('2024-11-02T10:00:00Z') }, relationship: 'Friend from college', work: 'Designer at a studio',
  entity: 'person', entity_by: null };
/** @type {PersonPage['where']} */
const SAM_WHERE = [
  { chat: 'whatsapp:15550000001@s.whatsapp.net', title: 'WhatsApp', group: false, network: 'WhatsApp',
    when: { kind: 'at', at_ms: NOW - 3_600_000 }, count: 2122, line: '2,122 messages', quiet: false },
  { chat: 'imessage:+15550000001', title: 'iMessage', group: false, network: 'iMessage',
    when: { kind: 'at', at_ms: NOW - 5 * DAY_MS }, count: 312, line: '312 messages', quiet: false },
  { chat: null, title: 'Mail', group: false, network: 'Mail', when: null, count: 14, line: '14 mails', quiet: false },
];
const SAM_ANSWER = personAnswer(SAM_HEAD, {
  month: { days: [], count: 184, calls: null, line: '184 messages in the last 30 days', before: null },
  history: { kind: 'weeks', marked: BUSIEST_WEEK, weeks: Array.from({ length: 104 }, (_, at) => ({ start: shiftDay(MONDAY, -7 * (103 - at)),
    count: at === BUSIEST_WEEK ? 90 : at < 30 ? (at % 9 === 0 ? 4 : 0) : (at * 37) % 11 * 6 + 6, day: null })) },
  talk: TALK_RUN, where: SAM_WHERE, suggestions_line: '3 suggestions' });

const PERSON = () => frame(pageBar('Sam Rivera'), personPage({ page: SAM_ANSWER, photos: SAM_PAGE_PHOTOS, today: TODAY }));

const PERSON_PLAIN = () => frame(pageBar('Sam Rivera'), personPage({
  page: { ...SAM_ANSWER, head: { ...SAM_HEAD, chips: [], work: null } }, today: TODAY,
  photos: { ...SAM_PAGE_PHOTOS, total: 47, page: 3, photos: (SAM_PAGE_PHOTOS.photos ?? []).slice(0, 11) } }));

const PERSON_COUNTING = () => frame(pageBar('Sam R.'), personPage({ page: { ...SAM_ANSWER, head: { ...SAM_HEAD, name: 'Sam R.' },
  counting: true }, today: TODAY, photos: SAM_PAGE_PHOTOS }));

/** @type {PersonPage['history']} */
const QUIET_YEARS = { kind: 'years', total: 2946, marked: 0, years: [
  { year: '2021', count: 1330, day: '2021-08-02' }, { year: '2022', count: 1260, day: '2022-05-10' }, { year: '2023', count: 310, day: '2023-01-20' },
  { year: '2024', count: 44, day: '2024-06-11' }, { year: '2025', count: 0, day: null }, { year: '2026', count: 2, day: '2026-10-13' }] };
/** @type {PersonPage['history']} */
const HANDFUL = { kind: 'facts', total: 5, first: '2026-06-02' };

/**
 * @param {PersonPage['history']} history
 * @param {PersonPage['month']} month
 */
const PERSON_SPARSE = (history, month) => frame(pageBar('Sam Rivera'), personPage({ page: { ...SAM_ANSWER, history, month },
  today: TODAY, photos: SAM_PAGE_PHOTOS }));


/**
 * @param {string} id
 * @param {string} label
 * @param {Partial<import('./ui/people/words.js').Chat>} [more]
 * @returns {import('./ui/people/words.js').Chat}
 */
const groupChat = (id, label, more = {}) => ({ key: `whatsapp:${id}@g.us`, network: 'whatsapp', chat: `${id}@g.us`,
  group: true, label, total: 2400, mine: 310, first_ms: NOW - 800 * DAY_MS, last_ms: NOW - DAY_MS, quiet: null,
  word: null, ...more });
const YOUR_GROUPS = ['Climbing crew', 'Family', 'Flat 4B', 'Book club', 'Saturday football', 'Studio']
  .map((label, at) => groupChat(`12036300000000010${at}`, label, { last_ms: NOW - (at + 1) * 3_600_000 }));
const QUIET_GROUPS = [
  groupChat('120363000000000201', 'Neighbourhood deals', { mine: 2,
    quiet: { why: 'archived', last_day: '2025-09-01' } }),
  groupChat('120363000000000202', 'School alumni', { mine: 14, quiet: { why: 'silent', last_day: '2026-06-12' } }),
  groupChat('120363000000000203', 'Conference 2024', { mine: 0, last_ms: NOW - 300 * DAY_MS,
    quiet: { why: 'silent', last_day: null } }),
];
/** @param {import('./ui/people/words.js').Chat} chat */
const chatRow = chat => /** @type {ChatRow} */ ({ chat: chat.key, title: chat.label, photo: null,
  when: { kind: 'at', at_ms: chat.last_ms }, line: null, find: [chat.label] });

/**
 * @param {import('./ui/people/words.js').Chat} chat
 * @param {number} count
 * @returns {PersonPage['where'][number]}
 */
const whereGroup = (chat, count) => ({ chat: chat.key, title: chat.label, group: true, network: 'WhatsApp',
  when: { kind: 'at', at_ms: chat.last_ms }, count, line: `${count} messages`, quiet: Boolean(chat.quiet) });

/** @param {boolean} all */
const PERSON_GROUPS = all => frame(pageBar('Sam Rivera'), personPage({ page: { ...SAM_ANSWER, where: [...SAM_WHERE,
  ...[...YOUR_GROUPS, ...QUIET_GROUPS.slice(0, 2)].map((chat, at) => whereGroup(chat, 400 - at * 40))] },
photos: SAM_PAGE_PHOTOS, today: TODAY, groups: all }));

/** @param {boolean} open */
const GROUPS_VIEW = open => frame(listBar('', true, true), '<div class="ck-page__body"><div class="ck-page__main pp-main pp-cards">'
  + listViews('groups', { people: 248, ai: 2, groups: YOUR_GROUPS.length })
  + groupsView({ yours: YOUR_GROUPS.map(chatRow), quiet: QUIET_GROUPS.map(chatRow), quiet_line: '3 groups' },
    { shown: ROWS_SHOWN, today: TODAY, open })
  + '</div><aside class="ck-page__side pp-side" aria-label="To tidy"></aside></div>');

/**
 * @param {import('./ui/people/words.js').Chat} chat
 * @param {Partial<GroupPage['head']>} head
 * @returns {GroupPage}
 */
const groupAnswer = (chat, head) => ({ position: '1:1', today: TODAY,
  head: { title: chat.label, photo: null, line: 'WhatsApp group · 7 people', since: { kind: 'at', at_ms: chat.first_ms }, word: 'rule',
    quiet: false, why: null, ...head },
  total: chat.total, writers: [{ id: SAM_PERSON.id, name: 'Sam Rivera', named: true, photo: hashOf(0), share: '400 messages' }],
  yours: `${Math.round((chat.mine / chat.total) * 100)}%`, talk: null, counting: false });

/**
 * @param {import('./ui/people/words.js').Chat} chat
 * @param {Partial<GroupPage['head']>} head
 * @param {{ busy: boolean, failure: import('./ui/people/person.js').ActFailed | null, value?: string }} [acting]
 */
const GROUP_PAGE = (chat, head, acting) => frame(pageBar(chat.label, '', { label: 'People', id: '' }),
  groupPage(chat.key, groupAnswer(chat, head), TODAY, acting));


const PERSON_FACE = () => group('PersonFace', '<div class="gallery__stack">' + [
  specimen('A photo · sm 24 · md 32 · row 36 · tile 56 · head 72', '<p class="gallery__faces">'
    + ['sm', 'md', 'row', 'tile', 'head'].map(size => personFace({ name: 'Sam Rivera',
      photo: hashOf(0), size: /** @type {import('./ui/kit/person-face.js').FaceSize} */ (size) })).join('') + '</p>'),
  specimen('No photo: the monogram', '<p class="gallery__faces">' + ['sm', 'md', 'row', 'tile', 'head'].map(size => personFace({
    name: 'Dana Okafor', size: /** @type {import('./ui/kit/person-face.js').FaceSize} */ (size) })).join('') + '</p>'),
  specimen('A name with no letter in it', '<p class="gallery__faces">'
    + ['sm', 'md', 'row', 'tile', 'head'].map(size => personFace({ name: '+1 555 000 0014',
      size: /** @type {import('./ui/kit/person-face.js').FaceSize} */ (size) })).join('') + '</p>'),
  specimen('No name yet', '<p class="gallery__faces">'
    + ['sm', 'md', 'row', 'tile', 'head'].map(size => personFace({ name: null,
      size: /** @type {import('./ui/kit/person-face.js').FaceSize} */ (size) })).join('') + '</p>'),
  specimen('A photo that cannot be drawn: the initials stay', '<p class="gallery__faces">'
    + ['sm', 'md', 'row', 'tile', 'head'].map(size => personFace({ name: 'Mira Sen', photo: LOST,
      size: /** @type {import('./ui/kit/person-face.js').FaceSize} */ (size) })).join('') + '</p>'),
  reading('Not read yet: its own circle', '<p class="gallery__faces">' + ['sm', 'md', 'row', 'tile', 'head'].map(size =>
    personFaceReading(/** @type {import('./ui/kit/person-face.js').FaceSize} */ (size))).join('') + '</p>'),
].join('') + '</div>');

const FACE_CROP = () => group('FaceCrop', '<div class="gallery__crops">' + [
  specimen('Open', faceCrop(crop(1))),
  specimen('Hover', faceCrop(crop(1, { forced: 'hover' }))),
  specimen('Focus', faceCrop(crop(1, { forced: 'focus' }))),
  specimen('Out', faceCrop(crop(3), 'out')),
  specimen('Out · hover', faceCrop(crop(3, { forced: 'hover' }), 'out')),
  specimen('Moved out', faceCrop(crop(3, { on: true }), 'out')),
  specimen('The photo', faceCrop(crop(2, { on: true }), 'choose')),
  specimen('A whole photo', faceCrop(crop(4, { whole: true }), 'choose')),
  specimen('Disabled', faceCrop(crop(7, { disabled: true }), 'choose')),
  specimen('No crop', faceCrop(crop(0, { hash: '' }))),
  specimen('A whole photo not drawn', faceCrop(crop(0, { hash: LOST, whole: true }), 'choose')),
  specimen('Not drawn', faceCrop(crop(0, { hash: LOST }))),
  reading('Not read yet', faceCropReading()),
].join('') + '</div>');

let pictures = /** @type {{ wide: string, small: string } | null} */ (null);
const PICTURES = () => (pictures ??= { wide: sceneUrl(0, 1200, 900), small: sceneUrl(0, 150, 120) });
const MADE = () => crop(0, { hash: 'scene-0', label: 'The photo you made', on: true });

const FACE_GRID = () => group('FaceGrid', '<div class="gallery__rows gallery__rows--wide">' + [
  specimen('Choose their photo: sixteen, four across; Upload a photo first, the square made second, chosen, then their photos whole',
    faceGrid({ faces: [MADE(), ...Array.from({ length: 14 }, (_, at) => crop(sam(at), { label: `Sam Rivera, photo ${at + 1}`, whole: true }))],
      label: 'Photo', mode: 'choose', upload: {}, room: 16, columns: 4 })),
  specimen('The last page: as tall as the others', faceGrid({ faces: [MADE(), ...Array.from({ length: 5 }, (_, at) => crop(sam(at), {
    label: `Sam Rivera, photo ${at + 1}`, whole: true }))], label: 'Photo', mode: 'choose', upload: {}, room: 16, columns: 4, pad: true })),
  specimen('Upload a photo lit, a file dragged over the chooser', faceGrid({
    faces: Array.from({ length: 5 }, (_, at) => crop(sam(at), { on: at === 0, label: `Sam Rivera, photo ${at + 1}` })),
    label: 'Photo', mode: 'choose', upload: { lit: true } })),
  specimen('No faces: Upload a photo alone', faceGrid({ faces: [], label: 'Photo', mode: 'choose', upload: {} })),
  reading('Their faces read: Upload a photo and the square made stand, the rest their squares',
    faceGrid({ faces: [MADE()], label: 'Photo', mode: 'choose', upload: {}, reading: true })),
  specimen('Open: eleven and how many more', PHOTOS()),
  specimen('Out: a face group, two moved out', faceGrid({ faces: GROUP, label: 'Sam’s photos', mode: 'out' })),
  specimen('Choose: the photo', faceGrid({ faces: Array.from({ length: 6 }, (_, at) => crop(sam(at), { on: at === 2 })),
    label: 'Photo', mode: 'choose' })),
  specimen('Three faces', faceGrid({ faces: [9, 9, 9].map(n => crop(n)), label: 'Ava’s photos' })),
  reading('Not read yet: twelve', faceGridReading(12)),
].join('') + '</div>');

const MOVE_AND_SCALE = () => {
  const { wide, small } = PICTURES();
  const picture = { src: wide, width: 1200, height: 900 };
  return group('MoveAndScale', specimen('At rest: the square across the shorter side, centred. Live: drag it, scroll or '
    + 'pinch over it, the slider, the arrows, + and −, ⏎ and Esc', `<div class="gallery__wide" data-gallery-mas>${moveAndScale(picture)}`
    + '<p class="gallery__quiet mac-mono-data" data-gallery-said>Not used yet</p></div>')
    + '<div class="gallery__rows gallery__rows--wide">' + [
      specimen('Scaled in on the face', moveAndScale({ ...picture, square: { x: 340, y: 130, side: 520 } })),
      specimen('Moved to the picture’s corner: held there', moveAndScale({ ...picture, square: { x: -200, y: -80, side: 640 } })),
      specimen('At the bound: a square of 160 pixels, held there', moveAndScale({ ...picture, square: { x: 520, y: 240, side: 100 } })),
      specimen('A picture under 160 on its shorter side: taken whole, no slider', moveAndScale({ src: small, width: 150, height: 120 })),
      specimen('A picture that can’t be opened', moveAndScale(null)),
    ].join('') + '</div>');
};

/** @param {ParentNode} root */
export function liveMoveAndScale(root) {
  const live = root.querySelector('[data-gallery-mas]');
  const said = live?.querySelector('[data-gallery-said]');
  if (!live || !said) return;
  installMoveAndScale(live, {
    used: ({ x, y, side }) => { said.textContent = `Used: ${side} px square at ${x}, ${y}`; },
    cancelled: () => { said.textContent = 'Cancelled'; },
  });
}

/** @param {string} html */
const onCard = html => `<div class="gallery__surface gallery__panel"><div class="pp-rows">${html}</div></div>`;

const FIELD_ROW = () => group('FieldRow', '<div class="gallery__rows gallery__rows--wide">' + [
  specimen('Filled · its source at its end, while it holds the home’s words', onCard(fieldRow({ label: 'Name', value: 'Sam', placeholder: 'What you call them' })
    + fieldRow({ label: 'Full name', value: 'Sam Rivera', source: 'WhatsApp · 3 mails', sourced: true }))),
  specimen('Empty: its placeholder · lit: the edge in here', onCard(fieldRow({ label: 'Relationship', placeholder: 'Mother, friend from college, dentist' })
    + fieldRow({ label: 'Name', value: 'Mom', lit: true }))),
  specimen('The menu variant: its value and its caret · open', onCard(fieldRowMenu({ label: 'Kind', value: 'A person' })
    + fieldRowMenu({ label: 'Kind', value: 'AI', open: true }))),
  reading('Not read yet: the label stands', onCard(fieldRow({ label: 'Name', input: { disabled: true } }))),
].join('') + '</div>');

const CARD_ROWS = () => group('NameRow · a card’s rows', '<div class="gallery__rows gallery__rows--wide">' + [
  specimen('Theirs: an icon lead, its × on the lit row · lit', onCard(
    nameRow({ lead: { icon: 'call' }, name: '+15550000001', line: 'Contact card', end: { remove: 'Remove', attrs: {} } })
    + nameRow({ lead: { icon: 'message' }, name: 'WhatsApp · hidden number', line: 'WhatsApp pairs it with +15550000001', lit: true,
      end: { remove: 'Remove', attrs: {} } }))),
  specimen('A suggestion with the round tick: not ticked · ticked · lit', onCard(
    nameRow({ lead: { icon: 'mail' }, name: 'sam.rivera@example.com', line: 'Signed “Sam Rivera” · 14 mails', end: { tick: false } })
    + nameRow({ lead: { crop: hashOf(0) }, name: 'A face in your photos', line: 'Not named yet · 198 photos', end: { tick: true } })
    + nameRow({ lead: { face: personFace({ name: 'Samuel R.' }) }, name: 'Samuel R.', line: 'Same person? · Both named Sam Rivera', end: { tick: true }, lit: true }))),
  specimen('Yours that stays, no × (your own account) · an Also called name added by you', onCard(
    nameRow({ lead: { icon: 'call' }, name: '+1 555 0100 001', line: 'Your WhatsApp', end: 'fixed' })
    + nameRow({ lead: { icon: 'person' }, name: 'Al', line: 'You added', end: { remove: 'Remove Al', attrs: {} }, added: true }))),
  specimen('Added by you · a quiet row with its caret', onCard(
    nameRow({ lead: { face: personFace({ name: 'Dana O.', photo: hashOf(1) }) }, name: '“Dana O.” in your photos', line: 'Face · added by you', end: { tick: true }, added: true })
    + nameRow({ lead: { face: quietRing('photo', 'md') }, name: 'Mark their face', line: 'Faces you named, and faces not named yet', quiet: true }))),
  reading('Not read yet: two', onCard([0, 1].map(nameRowCardReading).join(''))),
].join('') + '</div>');

const FORM_CARD = () => group('FormCard · a form on one grid (principle 29)', '<div class="gallery__rows gallery__rows--wide">' + [
  specimen('Fields, Birthday waiting, a Suggested row with its Add, Also called', `<div class="gallery__surface gallery__panel">${formCard(
    fieldRow({ label: 'Name', value: 'Sam', placeholder: 'What you call them' })
    + fieldRow({ label: 'Full name', value: 'Sam Rivera', source: 'WhatsApp · 3 mails', sourced: true })
    + fieldRow({ label: 'Relationship', placeholder: 'Mother, friend from college, dentist' })
    + fieldRow({ label: 'Work', value: 'Designer at a studio', lit: true })
    + fieldRowMenu({ label: 'Birthday', value: 'Add birthday', empty: true })
    + nameRow({ lead: { key: 'Suggested' }, name: '14 August?', line: 'From your messages', end: { add: false } })
    + nameRow({ lead: { key: 'Also called' }, name: 'Sammy', line: 'Contacts', end: { remove: 'Remove Sammy', attrs: {} } })
    + formAdd({ placeholder: 'Add a name' }), { label: 'Who they are' })}</div>`),
  specimen('Numbers and emails: keys, a source at the end, an Add · taken, the add row', `<div class="gallery__surface gallery__panel">${formCard(
    nameRow({ lead: { key: 'Phone' }, name: '+1 555 0100 001', line: 'From Contacts', end: { remove: 'Remove', attrs: {} } })
    + nameRow({ lead: { key: 'WhatsApp' }, name: 'Number hidden', line: '', end: { remove: 'Remove', attrs: {} }, lit: true })
    + nameRow({ lead: { key: 'Email' }, name: 'sam.rivera@example.com', line: 'Signed “Sam Rivera” · 14 mails', end: { add: false } })
    + nameRow({ lead: { key: 'Face' }, name: 'Samuel R.', line: 'A face you named · Same person?', end: { add: true } })
    + nameRow({ lead: { key: '' }, name: 'Find more photos of them', line: '96 the home isn’t sure of', quiet: true })
    + formAdd({ placeholder: 'Add a number, email, link, person or face' }))}</div>`),
  specimen('The last card: Mark as not a person · what was said · Hide from People', `<div class="gallery__surface gallery__panel">${formCard(
    formAct({ words: 'Mark as not a person', menu: true })
    + formAct({ words: 'A business', said: { whose: 'You said so', remove: 'Remove A business', attrs: {} } })
    + formAct({ words: 'Hide from People' }))}</div>`),
].join('') + '</div>');

const YOU_CARD = () => group('YouCard · RowsAcross', '<div class="gallery__rows gallery__rows--wide">' + [
  specimen('YouCard: a photo and a line · the name alone, centred · a long name wraps', `<div class="ck-page__side ck-page__side--top">`
    + youCard({ name: 'Alex', photo: hashOf(0), line: '2 suggestions' }) + youCard({ name: 'Alex' })
    + youCard({ name: LONG_NAME, line: '1 suggestion' }) + '</div>'),
  specimen('RowsAcross of TileRows: a number, an address, one cut at its end', rowsAcross([
    tileRow({ icon: 'call', value: '+1 555 0100 001', line: 'Your WhatsApp' }),
    tileRow({ icon: 'mail', value: 'alex@example.com', line: 'Your Gmail' }),
    tileRow({ icon: 'mail', value: 'alexandria.konstantinopoulou-ramaswamy@work.example.com', line: 'Contacts' }),
  ], 'Numbers and emails')),
].join('') + '</div>');

const FACT_CHIP = () => group('FactChip', '<div class="gallery__rows gallery__rows--wide">' + [
  specimen('A head’s facts: a birthday, a profile (a link), a site', factChips([
    factChip({ label: '14 Aug', glyph: 'calendar-event', title: '14 August' }),
    factChip({ label: '@sam.rivera.example', glyph: 'instagram', href: 'https://www.instagram.com/sam.rivera.example/' }),
    factChip({ label: 'example.com', glyph: 'web', href: 'https://example.com/sam' }),
  ])),
  specimen('Soon · a link under the pointer', factChips([
    factChip({ label: 'Birthday in 3 days', glyph: 'calendar-event' }),
    factChip({ label: 'sam-rivera-example', glyph: 'github', href: 'https://github.com/sam-rivera-example', forced: true }),
    factChip({ label: '@samrivera_example', glyph: 'x', href: 'https://x.com/samrivera_example' }),
    factChip({ label: 'sam-rivera-example', glyph: 'linkedin', href: 'https://www.linkedin.com/in/sam-rivera-example/' }),
    factChip({ label: 'sam.rivera.example', glyph: 'facebook', href: 'https://www.facebook.com/sam.rivera.example' }),
  ])),
].join('') + '</div>');

const CALENDAR = () => group('Calendar', '<div class="gallery__rows">' + [
  specimen('No day yet, no year: this year’s weekdays, today in glacier', calendarPicker({ month: 10, day: null, year: '', typed: null, today: ON_TODAY, label: 'Birthday' })),
  specimen('A day chosen, its year typed; July’s last days and September’s first quiet around August', calendarPicker({ month: 8, day: 14, year: '1993', typed: 1993, today: ON_TODAY, label: 'Birthday' })),
  specimen('February, no year: the next leap year’s, its 29th chosen', calendarPicker({ month: 2, day: 29, year: '', typed: null, today: ON_TODAY, label: 'Birthday' })),
  specimen('February 1993: no 29th', calendarPicker({ month: 2, day: 14, year: '1993', typed: 1993, today: ON_TODAY, label: 'Birthday' })),
  specimen('The keys on a day: its focus ring', calendarPicker({ month: 8, day: 14, year: '', typed: null, today: ON_TODAY, focus: 21, forced: true, label: 'Birthday' })),
].join('') + '</div>');

const FLOAT_LIST = () => group('FloatList', '<div class="gallery__rows gallery__rows--wide">' + [
  specimen('A menu: the light on one, the check on the one chosen', `<div class="gallery__float">${floatList({ label: 'Not a person', lit: 1,
    items: [{ name: 'AI', icon: 'ai', chosen: true }, { name: 'A business', icon: 'work-mac' }, { name: 'An automated sender', icon: 'coding-agent' }] })}</div>`),
  specimen('Finds: rows of 52, the lit one ending in ⏎', `<div class="gallery__float">${findsList([DANA, DANA_FACE, DANA_MAIL].map(foundOf), 0, 'dana')}</div>`),
  specimen('Nothing found · still looking', `<div class="gallery__float">${findsList([], 0, 'zed')}</div>`
    + `<div class="gallery__float">${findsList(null, 0, 'zed')}</div>`),
].join('') + '</div>');

const FACE_TILES = () => group('FaceTile', specimen('Two across: faces you named · a face not named yet, quieter',
  `<div class="gallery__wide">${faceTiles([
    faceTile({ hash: hashOf(1), name: 'Dana O.', line: 'Matches their name' }),
    faceTile({ hash: hashOf(2), name: 'Mira', line: 'A face you named' }),
    faceTile({ hash: hashOf(5), name: 'Not named yet', line: '41 photos · 2021–2026', quiet: true }),
    faceTile({ hash: '', name: 'Not named yet', line: '3 photos · 2024', quiet: true }),
  ])}</div>`));


/** @type {import('./ui/people/businesses.js').Offered[]} */
const OFFERED_BUSINESSES = [
  ['phone:+15550000201', 'Exampleshop Delivery', 'Named like a business you hear from'],
  ['phone:+15550000202', 'Northwind Dental', 'Listed as a business on WhatsApp'],
  ['email:hello@synthetic-bakery.example', 'Synthetic Bakery', 'Mail signed by several people'],
  ['phone:+15550000204', 'Lumen Labs', 'A company, no person’s name'],
  ['phone:+15550000205', 'Jay Exampleshop', 'Named like a business you hear from'],
].map(([id, name, why]) => ({ id, name, named: true, photo: null, why, handles: [{ id, words: id.slice(id.indexOf(':') + 1) }] }));
const offeredBusinesses = (/** @type {Set<string>} */ marked = new Set()) => OFFERED_BUSINESSES.filter(each => !marked.has(each.id));

/** @param {string[]} [off] */
const opened = (off = []) => new Map(OFFERED_BUSINESSES.map(({ id }) => [id, !off.includes(id)]));
/** @param {Partial<Parameters<typeof businessesDialog>[0]>} [state] */
const businesses = (state = {}) => `<div class="gallery__dialog">${businessesDialog({
  offered: offeredBusinesses(), ticks: opened(), busy: '', marked: 0, failure: null, ...state })}</div>`;
const JAY = 'phone:+15550000205';
const UNTICKED = opened([JAY]);
const ALL_MARKED = new Set(OFFERED_BUSINESSES.map(each => each.id));

const BUSINESSES = () => group('People · Accept all businesses', '<div class="gallery__dialogs">' + [
  specimen('Opened: every one ticked, Mark all', businesses()),
  specimen('One that is a person unticked: Mark 4', businesses({ ticks: UNTICKED })),
  specimen('Mark under way', businesses({ ticks: UNTICKED, busy: 'mark' })),
  specimen('Marked: the four gone, the one unticked still offered, the Undo in the foot',
    businesses({ offered: offeredBusinesses(new Set([...ALL_MARKED].filter(id => id !== JAY))), ticks: UNTICKED, marked: 4 })),
  specimen('Refused: the one the home could not mark unticked, why on its row; the home’s words in the foot', businesses({
    offered: offeredBusinesses().map(row => row.id === 'phone:+15550000202' ? { ...row, why: 'You said they are not a business.' } : row),
    ticks: opened(['phone:+15550000202']),
    failure: { said: 'refused', words: '1 of them can’t be marked: they changed since you looked.' } })),
  specimen('Never sent: its Try again marking them once more', businesses({ ticks: UNTICKED,
    failure: { said: 'not-sent', words: '' } })),
  specimen('None left: every one marked, its Undo standing', businesses({ offered: offeredBusinesses(ALL_MARKED), marked: 5 })),
].join('') + '</div>');

const PROGRESS = () => group('Meter · progress', '<div class="gallery__rows gallery__rows--wide">' + [
  specimen('How far a scan has come', meter('4,210 of 22,700 photos', 'Newest first', 4210 / 22700, { progress: true })),
].join('') + '</div>');

export const people = () => [
  group('People · the list in the Mac app’s window', specimen('A full home: faces, rows by when, what is left to tidy',
    LIST_FULL())
    + specimen('A home with little set up: its cards’ people, Turn on faces once photos are in', LIST_LITTLE())),
  group('People · You', '<div class="gallery__rows">' + [
    ['Photo · 2 suggestions', YOU_SIDE(YOU_ROW, SHORT_TIDY)],
    ['Photo · no suggestions', YOU_SIDE({ ...YOU_ROW, line: 'You' }, SHORT_TIDY)],
    ['No photo · 1 suggestion', YOU_SIDE({ ...YOU_ROW, photo: null, line: '1 suggestion' }, SHORT_TIDY)],
    ['No photo · no suggestions · nothing to tidy', YOU_SIDE({ ...YOU_ROW, photo: null, line: 'You' }, NOTHING_TO_TIDY)],
    ['Long name · 2 suggestions', YOU_SIDE({ ...YOU_ROW, name: LONG_NAME, photo: null }, SHORT_TIDY)],
    ['Long name with a photo · no suggestions', YOU_SIDE({ ...YOU_ROW, name: LONG_NAME, line: 'You' }, SHORT_TIDY)],
  ].map(([label, html]) => specimen(label, html)).join('') + '</div>'
    + specimen('A search finds You: their line “You”', YOU_FOUND())
    + specimen('Your page: your other names as chips; a dozen numbers and emails two across, your own accounts first; your photos',
      YOUR_PAGE(YOUR_ANSWER, YOUR_PHOTOS))
    + specimen('A long name, no photo, three numbers, no photos', YOUR_PAGE(personAnswer({ ...YOUR_HEAD, name: LONG_NAME,
      full_name: `${LONG_NAME} Jr.`, photo: null }, { handles: YOUR_ANSWER.handles.filter(handle => handle.own).slice(0, 3) }), NO_PHOTOS))
    + specimen('Day one: a name alone, the head alone', YOUR_PAGE(personAnswer({ ...YOUR_HEAD, full_name: null, photo: null }), NO_PHOTOS))),
  group('People · Organise your people', [
    ['One person: nothing lit, the window is them; the full name the home suggests in its field', ORGANISE()],
    ['A suggested email lit: the window is its proof', ORGANISE_EMAIL()],
    ['An AI, its chip ticked; faces off, no Mark their face', ORGANISE_AI()],
    ['A number alone: Not a person’s menu floating over the card', ORGANISE_MENU()],
    ['Typing in the add field: what it finds floats under it', ORGANISE_FINDS()],
    ['Their details: Work, Birthday’s calendar open on the day the wishes say, their profile, a profile the home found', ORGANISE_DETAILS()],
    ['A birthday guessed from your wishes lit: the window is the wishes', ORGANISE_WISH()],
    ['A profile of theirs lit: the window opens it', ORGANISE_PROFILE()],
    ['Choose their photo: sixteen a page, the second of 16', ORGANISE_CHOOSER()],
    ['While the person is read', ORGANISE_READING()],
    ['The finish', ORGANISE_FINISH()],
  ].map(([label, html]) => specimen(label, html)).join('')),
  group('People · Naming faces', [
    ['The card, sure: the first row lit, ending in ⏎', NAMING_SURE()],
    ['Unsure: nothing lit, the field says Type a name', NAMING_UNSURE()],
    ['No suggestion', NAMING_NONE()],
    ['You, the owner’s largest group: it names your face, merging nothing', NAMING_YOU()],
    ['Typing “Son”: the people found, New person, Set aside', NAMING_TYPING()],
    ['Two faces marked not them', NAMING_OUT()],
    ['Show all: every face six across, scrolling inside the faces’ side', NAMING_ALL()],
    ['Set aside lit', NAMING_ASIDE()],
    ['After an answer: the foot says what it did, Back live', NAMING_AFTER()],
    ['A failed save: its card first, the reason after the circled !', NAMING_REFUSED()],
    ['The checkpoint', NAMING_CHECKPOINT()],
    ['The finish', NAMING_FINISH()],
    ['The finish with nobody named: what was done leads', NAMING_FINISH_NOBODY()],
    ['Everyone named or set aside', NAMING_EMPTY()],
    ['Reading: the meter where the card will stand; Waiting for Lifestream. past three seconds', NAMING_READING()],
    ['A check card: Is this Sam? a screen of 36, two clicked out', NAMING_CHECK()],
    ['A face’s whole photo over the screen, the face circled', NAMING_CHECK(true)],
  ].map(([label, html]) => specimen(label, html)).join('')),
  group('People · a person’s page', specimen('Edit in the bar; who they are · work; their birthday and profiles as chips; the last conversation; their photos, twelve of more',
    PERSON()) + specimen('No facts but who they are; the last page of their photos, 4 of 4', PERSON_PLAIN())
    + specimen('Quiet lately, years behind: the chart in years, the present under it', PERSON_SPARSE(QUIET_YEARS,
      { days: [], count: 2, calls: null, line: '2 messages in the last 30 days', before: { day: '2024-06-11', joiner: ' · before that, ' } }))
    + specimen('A handful of messages: no chart, their messages, first contact and calls in one card', PERSON_SPARSE(HANDFUL,
      { days: [], count: 3, calls: { count: 2, words: '2 calls' }, line: '3 messages in the last 30 days', before: { day: '2026-06-02', joiner: ' · before that, ' } }))
    + specimen('Just renamed: the name at once, what is counted from it the skeleton until People has counted', PERSON_COUNTING())),
  group('People · groups you are quiet in', [
    ['Where you talk: their one-to-one chats, five groups of yours by their messages, then 3 more groups',
      PERSON_GROUPS(false)],
    ['3 more groups opened: every group you share, the quiet ones marked Quiet', PERSON_GROUPS(true)],
    ['The Groups view: yours, then Quiet · 3 groups, one row', GROUPS_VIEW(false)],
    ['Quiet opened: the groups you are quiet in, the ones you never wrote in among them', GROUPS_VIEW(true)],
    ['A group you archived: why, and your word on it', GROUP_PAGE(QUIET_GROUPS[0], { quiet: true, why: { words: 'You archived it in WhatsApp', since: null } })],
    ['A group you have not written in since 12 Jun', GROUP_PAGE(QUIET_GROUPS[1],
      { quiet: true, why: { words: 'You last wrote', since: { kind: 'day', day: '2026-06-12' } } })],
    ['A group of yours you set Never quiet', GROUP_PAGE(YOUR_GROUPS[0], { word: 'never', why: { words: 'You set it', since: null } })],
    ['Your word on its way: the menu waits', GROUP_PAGE(YOUR_GROUPS[1], {}, { busy: true, failure: null })],
    ['Your word refused: the home’s words under the row, Try again', GROUP_PAGE(QUIET_GROUPS[2],
      { quiet: true, why: { words: 'You never wrote in it', since: null } },
      { busy: false, failure: { said: 'refused', words: 'This chat is not a group.' }, value: 'never' })],
    ['Your word’s answer lost: the home’s words alone, nothing to press again', GROUP_PAGE(QUIET_GROUPS[2],
      { quiet: true, why: { words: 'You never wrote in it', since: null } },
      { busy: false, failure: { said: 'unknown', words: 'Lifestream didn\'t say whether this was done.' }, value: 'never' })],
  ].map(([label, html]) => specimen(label, html)).join('')),
  group('People · Edit', specimen('The same panel over one person: Cancel, Hide, Save; what you said a tag; Relationship lit', EDIT())
    + specimen('Their Maybe faces waiting: Find more photos of them lit', EDIT_MORE())
    + specimen('Also called from a card and from you; Joined in, one bringing another with them', EDIT_JOINED())
    + specimen('Riley Work split off, staged: their row, Riley Old and the numbers they take gone until Save', EDIT_JOINED(['person:riley-work']))),
  group('People · Your Edit', specimen('Edit: Also called; Yours, your own accounts first with no ×; a signed address; your namesake',
    YOUR_EDIT())
    + specimen('Your namesake lit: Same person? · Both named Alex Rivera', YOUR_EDIT('o:y2'))
    + specimen('Day one: your names alone; Yours its heading and the add field', YOUR_EDIT_DAY_ONE())),
  BUSINESSES(),
  PERSON_FACE(), FACE_CROP(), FACE_GRID(), MOVE_AND_SCALE(), FIELD_ROW(), CARD_ROWS(), FORM_CARD(), FACT_CHIP(), YOU_CARD(), CALENDAR(), FLOAT_LIST(), FACE_TILES(), PROGRESS(),
].join('');
