// @ts-check
/** @import { Handle, Photos } from './words.js' */
/** @import { Profile } from '../../lib/details.js' */
/** @import { Read } from './person.js' */
/** @import { Card, Group, Person, Row, Suggestion } from './organise.js' */
/** @import { Card as FaceCard, Deck } from '../../lib/faces.js' */
/** @import { Talk } from '../../pages.js' */
import { esc } from '../../lib/html.js';
import {
  button, inPlaceLine, faceGrid, faceGridReading, faceTile, faceTiles, figureStrip, figureStripReading, icon, linkButton,
  moveAndScale, noneLine, plain, searchField, sectionLabel, stepper, thread, threadReading,
} from '../kit/index.js';
import { dayAt, today as todayOf } from '../../lib/home-clock.js';
import { clock, count, counted, rowDay, shortDay, sinceWords, whenWords, yearsOf } from '../../lib/words.js';
import { birthdayOf, birthdayWords, NETWORKS, profileHref, profileWords } from '../../lib/details.js';
import { whereRows } from './person.js';
import {
  BUSINESS_SIGNS, cardFace, cardSource, faced, faceOf, fullSource, judgedTag, KIND_LABEL, PHOTO_LABELS, photoNow, shownName, sinceLine,
  suspicionWords, yours,
} from './organise.js';
import { handleFrom, handleIcon, handleWords, networkWords } from './words.js';

const SHOWN = 11;

export const UNTYPED = /** @type {const} */ ({ name: 'No name yet', full: 'No full name yet', rel: 'Who they are to you',
  work: 'No work yet' });

export const windowBack = () => `<div class="pp-window__back">${button('Back', { variant: 'plain', icon: 'back', attrs: { 'data-o-do': 'back' } })}</div>`;

/**
 * @param {string} eyebrow
 * @param {string} title
 * @param {string} line
 * @param {string} [face]
 */
export const paneHead = (eyebrow, title, line, face = '') => '<header class="pp-window__head">'
  + (eyebrow ? sectionLabel(eyebrow) : '')
  + `<div class="pp-window__who">${face}<div class="pp-window__titles"><h1 class="pp-window__title mac-display">${esc(title)}</h1>`
  + (line ? `<p class="pp-window__line mac-body">${esc(line)}</p>` : '') + '</div></div></header>';

/**
 * @param {string} label
 * @param {string} markup
 * @param {{ action?: string, count?: number }} [options]
 */
const part = (label, markup, { action = '', count: many } = {}) => `<section class="pp-part">${sectionLabel(label, { level: 2, action, count: many })}${markup}</section>`;

/**
 * @param {string} meaning
 * @param {string} title
 * @param {string} [line]
 * @param {string} [end]
 */
const li = (meaning, title, line = '', end = '') => `<div class="pp-li">${meaning ? `<span class="pp-li__lead">${icon(meaning, { size: 'md' })}</span>` : '<span></span>'}`
  + `<span class="pp-li__main"><span class="pp-li__title mac-body">${esc(title)}</span>${line ? `<span class="pp-li__line mac-subhead">${esc(line)}</span>` : ''}</span>`
  + `<span class="pp-li__end mac-mono-data">${end}</span></div>`;

/** @param {string[]} rows */
const list = rows => `<div class="pp-list">${rows.join('')}</div>`;


/**
 * @param {Read<unknown>} read
 * @param {string} reading
 */
const pending = (read, reading) => read.state === 'reading' ? reading : read.state === 'failed' ? inPlaceLine(read.message) : null;

/** @param {Person} person */
const figuresOf = person => figureStrip([
  { value: count(person.month), label: 'messages, last 30 days' },
  ...(person.last === null ? [] : [{ value: whenWords(person.last, todayOf()), label: 'last talked' }]),
  ...(person.since === null ? [] : [{ value: sinceWords(person.since), label: 'since' }]),
], { label: 'How much you talk' });

/** @param {Talk | null} run */
function lastTalkPart(run) {
  if (!run) return '';
  const { day } = run;
  const messages = run.lines.map((line, at) => ({ n: at, at: line.at_ms, clock: clock(line.at_ms),
    speaker: line.name, mine: line.mine, words: line.text, forwarded: line.forwarded }));
  const when = rowDay(day, todayOf());
  return part('Last conversation', `<div class="pp-window__card">${thread(messages, { group: run.group })}</div>`,
    { action: `<span class="pp-tert mac-mono-data">${esc(when)}</span>` });
}

/**
 * @param {Person} person
 * @param {boolean} all
 */
function wherePart(person, all) {
  const rows = whereRows(person.where, { all, today: todayOf(), more: { 'data-o-do': 'groups' }, open: false });
  const whose = `<span class="pp-side-whose mac-subhead">From ${esc(person.name)}</span>`;
  return rows ? part('Where you talk', `<div class="ck-side__rows pp-window__rows">${rows}</div>`, { action: whose }) : '';
}

/**
 * @param {string} name
 * @param {Read<Photos>} photos
 */
function photosPart(name, photos) {
  const waiting = pending(photos, faceGridReading(12));
  if (waiting !== null) return part('Photos', waiting);
  const faces = /** @type {{ value: Photos }} */ (photos).value.photos;
  if (!faces.length) return '';
  const crops = faces.map((photo, at) => ({ hash: photo.crop ?? '', label: `${name}, photo ${at + 1}` }));
  return part('Photos', faceGrid({ label: `${name}’s photos`, faces: crops,
    more: crops.length > SHOWN + 1 ? { count: crops.length - SHOWN, attrs: { tabindex: '-1' } } : null }), { count: faces.length });
}

/**
 * @param {object} pane
 * @param {Person} pane.person
 * @param {string} pane.name
 * @param {string} pane.face
 * @param {Read<Photos>} pane.photos
 * @param {boolean} [pane.all]
 */
export const personPane = ({ person, name, face, photos, all = false }) => person.me
  ? paneHead('', name, person.full_name ?? '', face) + photosPart(name, photos)
  : paneHead('', name, [person.much, person.last === null ? '' : `last talked ${whenWords(person.last, todayOf())}`].filter(Boolean).join(' · '), face)
    + figuresOf(person) + lastTalkPart(person.talk) + wherePart(person, all) + photosPart(name, photos);

export const personPaneReading = () => '<header class="pp-window__head" aria-hidden="true"><div class="pp-window__who">'
  + '<span class="ck-mono ck-mono--head ck-mono--reading"></span><div class="pp-window__titles">'
  + '<h1 class="pp-window__title mac-display"><span class="ck-sk ck-sk--w6"></span></h1></div></div></header>'
  + figureStripReading(3) + part('Last conversation', `<div class="pp-window__card">${threadReading()}</div>`);

/**
 * @param {Card} card
 * @param {'name' | 'full'} field
 */
export function namePane(card, field) {
  const label = field === 'name' ? 'Name' : 'Full name';
  const value = card.fields[field].trim();
  const also = [...new Set(card.person.names_seen)].filter(name => name.trim() && name !== value).slice(0, 8).map(name => li('person', name, 'Another spelling Lifestream saw',
    button('Use this', { size: 'sm', attrs: { 'data-o-use': field, 'data-o-value': name } })));
  if (field === 'full' && card.fill && value === card.fill.value) {
    const { reasons } = card.fill;
    const seen = Object.entries(reasons).filter(([, n]) => n > 0).map(([key, n]) => key === 'mail'
      ? li('mail', `Signed on ${counted(n, 'mail')}`, '') : key === 'photos' ? li('photo', PHOTO_LABELS, 'A label on their faces')
      : li('message', `Their ${networkWords(key)} profile`, 'The name they set'));
    return paneHead('Suggested full name', value, `Where Lifestream saw it · ${fullSource(card.fill)}`) + part('Seen', list([...seen, ...also]));
  }
  const words = field === 'name' ? 'What People shows for them. Type what you call them: Mom, Dev, Dr Webb.'
    : 'A fact Lifestream keeps for matching: mails signed with it, a face you named with it.';
  return paneHead(label, value || UNTYPED[field], words)
    + (also.length ? part('Other spellings', list(also)) : '');
}

/** @param {Card} card */
export const relPane = card => paneHead('Relationship', card.fields.rel.trim() || UNTYPED.rel,
  'A word or two, in your own words: mother, friend from college, dentist. Lifestream uses it when you ask about them.');

/** @param {Card} card */
export const workPane = card => {
  const value = card.fields.work.trim();
  const found = card.fills.work && value === card.fills.work.value;
  return paneHead('Work', value || UNTYPED.work, found ? `Where Lifestream found it · ${cardSource(/** @type {Suggestion} */ (card.fills.work))}`
    : 'What they do, and where: shown under their name. It joins no one and lands nothing on them.');
};

/** @param {Card} card */
export const birthdayPane = card => {
  const found = card.fills.birthday ? birthdayOf(card.fills.birthday.value) : null;
  const theirs = card.birthday !== null && found !== null && found.month === card.birthday.month && found.day === card.birthday.day
    && found.year === card.birthday.year;
  return paneHead('Birthday', card.birthday ? birthdayWords(card.birthday) : 'No birthday yet', theirs
    ? `Where Lifestream found it · ${cardSource(/** @type {Suggestion} */ (card.fills.birthday))}`
    : 'Pick the day on the calendar; the year only if you know it. Their page says when it is near.');
};

/** @param {Suggestion} suggestion */
export function guessPane(suggestion) {
  const day = birthdayOf(suggestion.value);
  const years = suggestion.reasons.wished ?? 0;
  return paneHead('Birthday?', day ? birthdayWords(day) : suggestion.value,
    years > 0 ? `You wished them on this day in ${counted(years, 'year')}.` : `Where Lifestream found it · ${cardSource(suggestion)}`)
    + plain('Lifestream only guesses: tick it to make it theirs, or × to say it is not.');
}

/**
 * @param {Profile} profile
 * @param {string} from
 */
export const profilePane = (profile, from) => paneHead(NETWORKS[profile.network], profileWords(profile, { path: true }), from)
  + `<div class="pp-window__acts">${linkButton(`Open on ${profile.network === 'site' ? 'the web' : NETWORKS[profile.network]}`, profileHref(profile))}</div>`
  + plain('A profile joins no one: no message, mail or photo lands on them by it.');

/** @param {Card} card */
export const morePane = card => paneHead('Faces', `Find more photos of ${yours(card) ? 'you' : 'them'}`,
  `${counted(card.maybe, 'face')} Lifestream isn’t sure are ${shownName(card)}. Faces shows them a screen at a time, and Done comes back here.`);

/** @param {Talk | null} talk */
export const notPersonPane = talk => paneHead('Not a person?', 'Most of your people are people',
  'Say so only when a record is not one: an AI, a business, an automated sender. Its messages then never count as a person’s. Hide is different: hidden, it is not in People at all.')
  + lastTalkPart(talk);

const KIND_WHY = /** @type {Record<string, string>} */ ({
  ai: 'An AI you talk to. Its replies never count as a person’s conversations.',
  business: 'A shop, a clinic, a service: reminders and receipts, not conversations.',
  bot: 'Codes, alerts and notices, never a reply.',
});

const JUDGED_WHY = /** @type {Record<string, string>} */ ({
  business: 'WhatsApp lists every number of theirs as a verified business.',
  bot: 'Every address of theirs is a no-reply one.',
});

/**
 * @param {Card} card
 * @param {Extract<Row, { kind: 'chip' | 'said' }>} row
 */
export function kindPane(card, row) {
  const { talk } = card.person;
  const name = shownName(card);
  if (row.kind === 'said') {
    const whose = judgedTag(card) ? `Lifestream thinks so: ${JUDGED_WHY[row.value] ?? ''} × makes ${name} a person.` : 'You said so.';
    return paneHead('Not a person', KIND_LABEL[row.value] ?? row.value, `${whose} ${KIND_WHY[row.value] ?? ''} Hide is different: hidden, they are not in People at all.`)
      + lastTalkPart(talk);
  }
  const { suggestion } = row;
  const { label } = suspicionWords(suggestion);
  const on = card.ticks.get(row.id) === true;
  const n = (/** @type {string} */ key) => suggestion.reasons[key] ?? 0;
  const signs = suggestion.value === 'ai'
    ? [li('time', 'Replies within 20 seconds', `${Math.round((100 * n('quick')) / Math.max(1, n('replies')))}% of ${count(n('replies'))} replies`)]
    : BUSINESS_SIGNS.filter(each => n(each.reason) > 0).map(each => li(each.icon, each.title, each.where));
  return paneHead('Not a person?', label, on ? `Lifestream thinks so, and the tick agrees: Confirm makes ${name} ${label === 'AI' ? 'an AI' : label.toLowerCase()}.`
    : `Lifestream thinks so; the tick says no. Confirm keeps ${name} a person.`)
    + part('Signs', list(signs)) + lastTalkPart(talk);
}

/**
 * @param {string} address
 * @param {string} eyebrow
 * @param {Read<Person>} read
 */
export function emailPane(address, eyebrow, read) {
  const held = read.state === 'read' ? read.value : null;
  const sign = held?.names_seen[0] ?? '';
  const both = held ? [held.mails.from ? `${count(held.mails.from)} from ${sign ? sign.split(' ')[0] : 'them'}` : '',
    held.mails.to ? `${count(held.mails.to)} from you` : ''].filter(Boolean).join(' · ') : '';
  const line = read.state === 'reading' ? '' : [sign ? `Signed “${(held?.names_seen ?? []).slice(0, 3).join('”, “')}”` : '', both].filter(Boolean).join(' · ')
    || 'No mail from this address yet';
  /** @type {string} */
  let body;
  const mails = held?.mails.newest;
  if (read.state === 'failed') body = inPlaceLine(read.message);
  else if (!held) body = `<div class="pp-list" aria-hidden="true">${li('mail', '…')}</div>`;
  else if (!mails) body = noneLine('Your mails are being read. They show here once Lifestream has read them.');
  else body = mails.length ? list(mails.map(hit => li(hit.family === 'calendar' ? 'calendar-event' : 'mail', hit.title ?? '',
    hit.from ?? '', esc(hit.day ? rowDay(hit.day, todayOf()) : '')))) : noneLine('No mail of theirs in Lifestream');
  return paneHead(eyebrow, address, line) + part('Mails', body, held ? { count: held.mails.from + held.mails.to } : {});
}

/**
 * @param {Handle} handle
 * @param {Person} person
 */
export const handlePane = (handle, person) => paneHead(handleKindWords(handle), handleWords(handle), handleFrom(handle))
  + figuresOf(person) + lastTalkPart(person.talk);

/** @param {Handle} handle */
const handleKindWords = handle => handle.kind === 'email' ? 'Email' : handle.network ? networkWords(handle.network) : 'Number';

/**
 * @param {Read<Person>} read
 * @param {string} [eyebrow]
 */
export function samePane(read, eyebrow = 'Same person?') {
  const waiting = pending(read, personPaneReading());
  if (waiting !== null) return waiting;
  const other = /** @type {{ value: Person }} */ (read).value;
  const handles = other.handles.length ? part('Numbers and emails', list(other.handles.map(handle => li(handleIcon(handle),
    handleWords(handle), handleFrom(handle))))) : '';
  return paneHead(eyebrow, other.name, ['Another record', other.much, sinceLine(other.since)]
    .filter(Boolean).join(' · '), faceOf(other, 'head')) + figuresOf(other) + handles + lastTalkPart(other.talk) + wherePart(other, false);
}

/**
 * @param {Person} other
 * @param {Read<Photos>} photos
 */
export const namedFacePane = (other, photos) => paneHead('Face in your photos', `“${other.name}”`, 'A name you typed on these faces')
  + photosPart(other.name, photos);

/**
 * @param {Group} group
 * @param {Read<FaceCard>} read
 */
export function groupPane(group, read) {
  const head = paneHead('Face in your photos', 'A face not named yet',
    [counted(group.photos, 'photo'), yearsOf(group.years)].filter(Boolean).join(' · '));
  const why = group.reason ? part('Why it may be them', list([li('photo', group.reason)])) : '';
  const waiting = pending(read, faceGridReading(12));
  if (waiting !== null) return head + why + part('Photos', waiting, { count: group.photos });
  const whole = /** @type {{ value: FaceCard }} */ (read).value;
  const faces = (whole.every ?? whole.sample).map((key, at) => {
    const crop = whole.crops?.[key] || group.crops[key];
    return { hash: crop ?? '', label: `Face ${at + 1}` };
  });
  return head + why + part('Photos', faceGrid({ label: 'Its faces', faces,
    more: faces.length > 12 ? { count: faces.length - SHOWN, attrs: { tabindex: '-1' } } : null }), { count: whole.faces });
}

export const addPane = () => paneHead('Add', 'Anyone Lifestream knows', 'Type a number, an email, a name, or the name you gave a face; paste a link to them, or an @handle. ⏎ adds the lit one.');

/** @param {Card} card */
export const photosAPage = card => photoNow(card) ? 14 : 15;

/** @typedef {Photos & { reading: boolean, failed: string }} Album */

/**
 * @param {Card} card
 * @param {Album | null} album
 * @param {{ lit: boolean }} chooser
 */
export function photoPane(card, album, { lit }) {
  const head = paneHead('Their photo', 'Choose their photo', 'Upload, drop or paste a picture, or choose one of their photos and frame it.');
  const upload = { lit, attrs: { 'data-o-upload': '' } };
  const now = photoNow(card);
  /** @type {import('../kit/face-grid.js').Face[]} */
  const own = !now ? [] : [{ hash: now, label: card.made ? 'Their photo now, the one you used' : 'Their photo now', on: true,
    attrs: { 'data-o-own': card.made ? 'made' : 'now' } }];
  const page = photosAPage(card);
  /** @param {import('../kit/face-grid.js').Face[]} photos @param {{ reading?: boolean, pad?: boolean }} [how] */
  const grid = (photos, how = {}) => faceGrid({ mode: 'choose', label: 'Their photo', columns: 4, room: 16, upload,
    faces: [...own, ...photos], ...how });
  /**
   * @param {number} at
   * @param {number} pages
   * @param {number | null} total
   */
  const label = (at, pages, total) => sectionLabel('Their photos', { level: 2, ...(total === null ? {} : { count: total }),
    action: total !== null && pages < 2 ? '' : stepper({ label: 'Pages of their photos',
      text: total === null ? '' : `${count(at + 1)} of ${count(pages)}`, attrs: { 'data-o-pager': '' },
      less: { label: 'Newer photos', attrs: { 'data-o-page': '-1' }, disabled: at === 0 },
      more: { label: 'Older photos', attrs: { 'data-o-page': '1' }, disabled: at >= pages - 1 } }) });
  if (album === null) return head + `<section class="pp-part pp-chooser" data-o-chooser tabindex="-1">${label(0, 1, null)}${grid([], { reading: true })}</section>`;
  if (!album.photos.length) {
    if (album.failed) return head + grid([]) + inPlaceLine(album.failed);
    return head + faceGrid({ mode: 'choose', label: 'Their photo', columns: 4, upload, faces: own })
      + `<div class="pp-window__none-photo">${noneLine(yours(card) ? 'No photos of you yet.' : card.faces ? 'No photos of them yet.'
        : 'No photos of them yet. Their photo comes from their contact card, or from their face once faces is on.')}`
      + (card.faces && !faced(card) ? `<div>${button(yours(card) ? 'Mark your face' : 'Mark their face', { variant: 'primary',
        attrs: { 'data-o-do': 'faces' } })}</div>` : '')
      + '</div>';
  }
  const pages = Math.max(1, Math.ceil(album.total / page));
  const at = Math.min(card.page, pages - 1);
  const shown = album.photos.slice(at * page, (at + 1) * page).map((photo, index) => ({ hash: `sha256:${photo.image}`, whole: true,
    label: `Photo ${at * page + index + 1}${photo.at_ms === null ? ''
      : `, ${shortDay(dayAt(photo.at_ms).day, todayOf().slice(0, 4))}`}`,
    attrs: { 'data-o-frame': String(at * page + index) } }));
  const tiles = grid(shown, shown.length < page && album.next !== undefined ? { reading: true } : { pad: true });
  return head + `<section class="pp-part pp-chooser" data-o-chooser tabindex="-1">${label(at, pages, album.total)}${tiles}`
    + (album.failed ? inPlaceLine(album.failed) : '') + '</section>';
}

/** @param {import('../kit/move-and-scale.js').Picture | null} picture */
export const movePane = picture => paneHead('Their photo', 'Move and scale', '') + moveAndScale(picture);

/**
 * @param {object} browser
 * @param {Card} browser.card
 * @param {Deck | null} browser.deck
 * @param {(id: string) => string} browser.photoOf
 * @param {string} browser.typed
 */
export function facesPane({ card, deck, photoOf, typed }) {
  const head = paneHead('Mark their face', 'Faces in your photos', 'Pick a face and it joins the card, ticked. Faces you named first, then the ones not named yet.')
    + searchField({ placeholder: 'Search a name you gave a face', value: typed, attrs: { 'data-o-face-find': '' } });
  if (!deck) return head + faceGridReading(6);
  const words = `${card.fields.name} ${card.fields.full}`.toLowerCase().split(/\s+/u).filter(word => word.length > 2);
  const on = new Set([...card.likely.map(group => group.id), ...card.added.flatMap(each => each.kind === 'group' ? [each.group.id]
    : each.kind === 'find' ? [each.find.id] : [])]);
  const want = typed.trim().toLowerCase();
  const named = deck.someone.filter(one => (one.named ?? 0) > 0 && one.id !== card.id && !on.has(one.id)
    && (!want || one.name.toLowerCase().includes(want)));
  const likely = named.filter(one => words.some(word => one.name.toLowerCase().includes(word)));
  const tileOf = (/** @type {typeof named[number]} */ one) => {
    return faceTile({ hash: photoOf(one.id), name: one.name, line: likely.includes(one) ? 'Matches their name' : 'A face you named',
      attrs: { 'data-o-pick': one.id } });
  };
  const left = deck.cards.filter(each => !on.has(each.id));
  const unnamed = want ? [] : left.slice(0, 24).map(each => faceTile({ quiet: true, name: 'Not named yet',
    hash: deck.crops[each.sample[0]] ?? '',
    line: [counted(each.photos, 'photo'), yearsOf(each.years)].filter(Boolean).join(' · '),
    attrs: { 'data-o-pick': `group:${each.id}` } }));
  const rest = named.filter(one => !likely.includes(one));
  return head + (likely.length ? part('Likely them', faceTiles(likely.map(tileOf))) : '')
    + (rest.length ? part('Faces you named', faceTiles(rest.map(tileOf)), { count: rest.length }) : '')
    + (unnamed.length ? part('Not named yet', faceTiles(unnamed), { count: left.length }) : '')
    + (!likely.length && !rest.length && !unnamed.length ? noneLine(want ? `No face named “${typed.trim()}”.` : 'No faces to mark yet.') : '');
}

/**
 * @param {Card[]} done
 * @param {string} line
 */
export const endPane = (done, line) => paneHead('People', 'Your people', line)
  + (done.length ? part('Organised', faceTiles(done.map(card => `<div class="ck-ftile pp-window__done">${cardFace(card, 'tile')}`
    + `<span class="ck-ftile__main"><span class="ck-ftile__name mac-headline">${esc(shownName(card))}</span>`
    + `<span class="ck-ftile__line mac-subhead">${esc(card.person.reach ?? '')}</span></span></div>`))) : '');

