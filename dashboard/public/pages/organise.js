// @ts-check
/** @import { Card, Find, Group, Person, Row } from '../ui/people/organise.js' */
/** @import { Album } from '../ui/people/evidence.js' */
/** @import { Photos } from '../ui/people/words.js' */
/** @import { Read } from '../ui/people/person.js' */
/** @import { Card as FaceCard, Deck } from '../lib/faces.js' */
/** @import { Person as PersonPage, PeopleFind, Row as ListRow } from '../pages.js' */
import { fetchFaceGroup, fetchPage, keepPicture, notSaved as unsaved, pictureUrl } from '../lib/api.js';
import { wordsOr } from '../lib/reach.js';
import { installMoveAndScale, reading } from '../ui/kit/index.js';
import { applyGeometry } from '../ui/geometry.js';
import {
  addPane, birthdayPane, emailPane, endPane, facesPane, groupPane, guessPane, handlePane, kindPane, morePane, movePane,
  namedFacePane, namePane, notPersonPane, personPane, personPaneReading, photoPane, photosAPage, profilePane, relPane, samePane,
  UNTYPED, windowBack, workPane,
} from '../ui/people/evidence.js';
import {
  answerOf, cardAgain, cardCopy, cardFace, cardSource, editPersonOf, findsList, firstLight, KINDS, kindMenu, marked,
  NAME_LONGEST, nameFold, NAMES_MOST, newCard, otherId, panelBody, panelBodyReading, panelFinish, panelFoot, panelHead, panelTitle, profileKey, rowsOf,
  savedWords, shownName, todayNow, touchedBy, yours,
} from '../ui/people/organise.js';
import { birthdayMonth } from '../lib/calendar.js';
import { aroundFace, makeSquare, openPicture } from '../ui/people/square.js';
import { birthdayOf, sameProfile, suggestedProfile } from '../lib/details.js';
import { count } from '../lib/words.js';
import { organiseLine } from '../ui/people/words.js';

const FACE_KEY = /^([0-9a-f]{64}):(\d+),(\d+),(\d+),(\d+)$/u;

/**
 * @param {FaceCard[]} groups
 * @returns {import('../ui/people/words.js').PhotoFace[]}
 */
function groupPhotos(groups) {
  /** @type {Map<string, import('../ui/people/words.js').PhotoFace>} */
  const photos = new Map();
  for (const group of groups) {
    for (const face of group.every ?? []) {
      const parts = FACE_KEY.exec(face);
      if (!parts || photos.has(parts[1])) continue;
      photos.set(parts[1], { image: parts[1], face, box: parts.slice(2).map(Number), at_ms: group.times?.[parts[1]] ?? null,
        crop: group.crops?.[face] ?? null });
    }
  }
  return [...photos.values()].sort((left, right) => (right.at_ms ?? -1) - (left.at_ms ?? -1));
}

const AHEAD = 3;
const UNDER = 172;

/**
 * @typedef {object} Options
 * @property {'organise' | 'edit'} mode
 * @property {string} [id]
 * @property {boolean} [first]
 * @property {{ done: Set<string>, skipped: Set<string>, from: string }} sitting
 * @property {() => string[]} queue
 * @property {() => { organised: number, often: number, queue: number }} counts
 * @property {() => string} position
 * @property {() => string | null} you
 * @property {(id: string) => ListRow | undefined} row
 * @property {() => boolean | null} faces
 * @property {() => Deck | null} deck
 * @property {(id: string) => Promise<PersonPage>} page
 * @property {(id: string) => Promise<{ groups: import('../ui/people/organise.js').Group[] }>} likely
 * @property {(id: string, after?: string) => Promise<Photos>} photos
 * @property {(id: string) => void} findFaces
 * @property {(action: Record<string, unknown>, given?: { waiting?: (error: unknown) => void }) => Promise<{ act: string | null, id: string | null, position: string }>} act
 * @property {() => boolean} acting
 * @property {(answered: Left | null) => void} leave
 * @property {(answered: Left) => void} hidden
 */

/** @typedef {{ id: string | null, position: string, saved?: { said: string, act: string | null } }} Left */

/** @param {unknown} error */
const messageOf = error => wordsOr(error, 'This couldn’t be read.');

const thisYear = () => new Date().getUTCFullYear();

/** @param {string} typed */
const yearOf = typed => /^\d{4}$/u.test(typed) && Number(typed) >= 1900 && Number(typed) <= thisYear() ? Number(typed) : null;

/**
 * @param {HTMLElement} stage
 * @param {Options} options
 */
export function mountOrganise(stage, options) {
  const { mode, sitting } = options;
  stage.innerHTML = '<div class="pp-window" data-o-window></div>';
  const windowEl = /** @type {HTMLElement} */ (stage.querySelector('[data-o-window]'));
  const began = Date.now();
  const start = options.counts();
  const often = start.often;
  const all = Math.max(start.queue, often);

  /** @type {Map<string, Card>} */
  const cards = new Map();
  /** @type {Map<string, Card>} */
  const kept = new Map();
  /** @type {Map<string, Read<any>>} */
  const reads = new Map();
  /** @type {(({ id: string, what: 'confirm' | 'skip' | 'hide', card: Card } | { id: string, what: 'photo', made: string, before: string | null }) & { sent: Promise<{ act: string | null, position: string } | null> }) | null} */
  let last = null;
  let given = 0;
  let photoSaved = /** @type {Left | null} */ (null);
  let photoSaving = /** @type {Promise<boolean> | null} */ (null);
  /** @param {Promise<boolean>} act */
  const photoAct = act => {
    if (mode !== 'edit') return;
    photoSaving = act;
    void act.then(() => {
      if (photoSaving === act) photoSaving = null;
    });
  };
  let stopped = false;
  /** @type {Card[]} */
  const organised = [];
  let order = /** @type {Promise<unknown>} */ (Promise.resolve());
  /**
   * @template T
   * @param {() => Promise<T>} run
   * @returns {Promise<T>}
   */
  const inOrder = run => {
    const sent = order.then(run);
    order = sent.then(() => undefined, () => undefined);
    return sent;
  };
  let listAt = options.position();

  const S = {
    /** @type {string | null} */
    lit: /** @type {string | null} */ (null),
    /** @type {'photo' | 'faces' | 'move' | null} */
    pane: /** @type {'photo' | 'faces' | 'move' | null} */ (null),
    /** @type {{ file: Blob, picture: import('../ui/kit/move-and-scale.js').Picture | null } | null} */
    moving: /** @type {{ file: Blob, picture: import('../ui/kit/move-and-scale.js').Picture | null } | null} */ (null),
    dropping: false,
    /** @type {{ active: number } | null} */
    menu: /** @type {{ active: number } | null} */ (null),
    typed: '', found: 0, faceTyped: '',
    naming: '',
    said: '', failure: /** @type {{ said: import('../lib/reach.js').Said, words: string, again?: string, resend?: () => void } | null} */ (null),
    saving: false,
    shown: '',
    groups: false,
    /** @type {{ month: number, year: string, at: number | null } | null} */
    calendar: /** @type {{ month: number, year: string, at: number | null } | null} */ (null),
  };
  let drawing = false;
  let pointed = false;
  let pointerAt = { x: -1, y: -1 };

  const unmove = () => {
    if (S.moving?.picture) URL.revokeObjectURL(S.moving.picture.src);
    S.moving = null;
  };
  const calm = () => {
    unmove();
    Object.assign(S, { lit: null, pane: null, menu: null, typed: '', found: 0, faceTyped: '', naming: '', calendar: null });
  };
  /** @type {Set<string>} */
  const touched = new Set();
  const queueNow = () => options.queue().filter(id => !touched.has(id));
  const idNow = () => mode === 'edit' ? /** @type {string} */ (options.id) : queueNow()[0] ?? '';


  const used = { panel: new Set(), window: new Set(), pop: new Set(), ahead: new Set() };
  /** @type {Set<string> | null} */
  let using = null;
  /**
   * @template T
   * @param {Set<string>} keys
   * @param {() => T} make
   * @returns {T}
   */
  function noting(keys, make) {
    const was = using;
    using = keys;
    keys.clear();
    try {
      return make();
    } finally {
      using = was;
    }
  }

  /**
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} load
   * @returns {Read<T>}
   */
  function need(key, load) {
    using?.add(key);
    const held = reads.get(key);
    if (held) return held;
    /** @type {Read<T>} */
    const mine = { state: 'reading' };
    reads.set(key, mine);
    const put = (/** @type {Read<T>} */ read) => {
      if (reads.get(key) !== mine) return;
      reads.set(key, read);
      landed(key);
    };
    load().then(value => put({ state: 'read', value }), error => put({ state: 'failed', message: messageOf(error) }));
    return mine;
  }

  /** @param {string} key */
  const look = key => {
    using?.add(key);
    return reads.get(key);
  };

  /** @param {string} key */
  function landed(key) {
    if (stopped || !stage.isConnected || stage.closest('[hidden]')) return;
    if (used.panel.has(key)) return draw();
    if (used.window.has(key)) drawWindow();
    if (used.pop.has(key)) placeOverlay();
    if (used.ahead.has(key)) readAhead();
  }

  /** @template T @param {Read<T> | undefined} read @returns {T | undefined} */
  const valueOf = read => read?.state === 'read' ? read.value : undefined;

  /**
   * @param {string} id
   * @returns {Read<Person>}
   */
  const personRead = id => need(`person:${id}`, () => options.page(id).then(page => editPersonOf(id, page)));

  /** @param {string} id */
  const other = id => valueOf(look(`person:${id}`));

  /** @param {string} id */
  const photoFor = id => other(id)?.photo ?? options.row(id)?.photo ?? '';

  /** @param {string} id */
  const theirReads = id => [`person:${id}`, `likely:${id}`, `photos:${id}`];

  /** @param {string} id */
  function forget(id) {
    cards.delete(id);
    for (const key of theirReads(id)) reads.delete(key);
  }

  function stale() {
    const shown = idNow();
    const read = [...reads.keys()].flatMap(key => /^(?:person|likely|photos):/u.test(key) ? [key.slice(key.indexOf(':') + 1)] : []);
    for (const id of new Set([...cards.keys(), ...read])) if (id !== shown) forget(id);
  }

  /**
   * @param {string} id
   * @returns {Read<Album>}
   */
  const photosRead = id => need(`photos:${id}`, () => options.photos(id).then(read => /** @type {Album} */ ({
    ...read, photos: [...read.photos], reading: false, failed: '' })));

  /**
   * @param {string} id
   * @param {number} wanted
   * @returns {Album | null}
   */
  function albumOf(id, wanted) {
    const read = photosRead(id);
    if (read.state === 'reading') return null;
    if (read.state === 'failed') return { position: '', photos: [], total: 0, reading: false, failed: read.message };
    const album = read.value;
    const after = album.next;
    if (album.photos.length < wanted && after !== undefined && !album.reading && !album.failed) {
      album.reading = true;
      options.photos(id, after).then(more => {
        album.photos.push(...more.photos);
        album.total = more.total;
        album.next = more.next;
      }, error => {
        album.failed = messageOf(error);
      }).finally(() => {
        album.reading = false;
        if (reads.get(`photos:${id}`) === read && S.pane === 'photo') drawWindow();
      });
    }
    return album;
  }

  /**
   * @param {Card} card
   * @returns {Album | null}
   */
  function chooserAlbum(card) {
    const album = albumOf(card.id, (card.page + 1) * photosAPage(card));
    const groups = marked(card).groups.map(group => groupRead(group.id));
    if (album === null || groups.some(read => read.state === 'reading')) return null;
    const failed = groups.flatMap(read => read.state === 'failed' ? [read.message] : [])[0] ?? '';
    const theirs = new Set(album.photos.map(photo => photo.image));
    const extra = groupPhotos(groups.flatMap(read => read.state === 'read' ? [read.value] : []))
      .filter(photo => !theirs.has(photo.image));
    if (!extra.length && !failed) return album;
    const whole = album.photos.length >= album.total;
    return { ...album, photos: whole ? [...album.photos, ...extra] : album.photos, total: album.total + extra.length,
      failed: album.failed || failed };
  }

  /** @param {string} id */
  function rereadPhotos(id) {
    const read = reads.get(`photos:${id}`);
    if (read?.state === 'failed') reads.delete(`photos:${id}`);
    else if (read?.state === 'read') read.value.failed = '';
    for (const [key, each] of reads) if (key.startsWith('group:') && each.state === 'failed') reads.delete(key);
  }

  /** @param {Card} card */
  const maybeOf = card => mode === 'edit' && card.person.record ? options.deck()?.maybe?.by[`person:${card.person.record}`] ?? 0 : 0;

  /** @type {Set<string>} */
  const unreadShown = new Set();

  /** @param {string} address */
  function addressRead(address) {
    const key = `person:email:${address}`;
    if (unreadShown.delete(key)) reads.delete(key);
    const read = personRead(`email:${address}`);
    if (read.state === 'read' && read.value.mails.newest === null) unreadShown.add(key);
    return read;
  }

  /** @param {string} address */
  const signed = address => other(`email:${address}`)?.names_seen[0] ?? '';

  /**
   * @param {string} id
   * @returns {Card | null}
   */
  function cardFor(id) {
    const held = cards.get(id);
    if (held) return held;
    const person = valueOf(personRead(id));
    const faces = options.faces();
    const likely = faces ? need(`likely:${id}`, () => options.likely(id).then(read => read.groups)) : null;
    if (!person || faces === null || (likely && likely.state === 'reading')) return null;
    const fresh = newCard(person, valueOf(likely ?? undefined) ?? [], faces);
    const before = kept.get(id);
    kept.delete(id);
    const card = before ? cardAgain(fresh, before) : fresh;
    cards.set(id, card);
    return card;
  }

  /** @param {string} id */
  function readWhole(id) {
    photosRead(id);
    const card = cardFor(id);
    if (!card) return;
    for (const suggestion of card.person.suggestions) {
      if (suggestion.kind === 'handle' && suggestion.value.startsWith('email:')) personRead(suggestion.value);
      if (suggestion.kind === 'same') personRead(otherId(suggestion.value));
    }
  }

  function readAhead() {
    const [shownNow, ...after] = mode === 'edit' ? [idNow()] : queueNow().slice(0, AHEAD);
    noting(used.ahead, () => {
      if (shownNow === undefined) return;
      readWhole(shownNow);
      if (!cards.get(shownNow)) return;
      for (const id of after) readWhole(id);
    });
  }


  function countNow() {
    if (mode === 'edit') return null;
    const at = given + 1;
    const of = often > 0 && at <= often ? often : all;
    return { at: Math.min(at, of), of, words: organiseLine(options.counts()) };
  }

  /** @param {boolean} fresh */
  function panelMarkup(fresh) {
    const id = idNow();
    if (!id) {
      const { body, foot } = panelFinish({ people: organised.map(card => ({ name: shownName(card), face: cardFace(card, 'md'),
        line: card.person.reach ?? '' })),
        minutes: Math.round((Date.now() - began) / 60_000), skipped: sitting.skipped.size });
      return `<section class="pl-card ck-float pp-panel" aria-label="Organise your people">${panelHead({ mode, count: null })}`
        + `<div class="pp-panel__body" tabindex="-1">${body}</div>${foot}</section>`;
    }
    const card = cardFor(id);
    if (card) card.maybe = maybeOf(card);
    const body = card ? panelBody({ card, signed, menu: S.menu !== null, browsing: S.pane === 'faces', typed: S.typed,
      naming: S.naming, calendar: S.calendar && { ...S.calendar, typed: yearOf(S.calendar.year) }, today: todayNow() }) : panelBodyReading();
    const you = card ? yours(card) : options.you() === id;
    return `<section class="pl-card ck-float pp-panel${mode === 'edit' ? ' pp-panel--edit' : ''}" aria-label="${mode === 'edit' ? panelTitle(you) : 'Organise your people'}">`
      + panelHead({ mode, count: countNow(), you })
      + `<div class="pp-panel__body${fresh ? ' is-new' : ''}" tabindex="-1">${body}</div>`
      + panelFoot({ mode, said: S.said, failure: S.failure, undo: last !== null && (mode === 'organise' || last.what === 'photo'),
        saving: S.saving, you })
      + '</section>';
  }

  function windowMarkup() {
    const id = idNow();
    if (!id) {
      const line = `${count(organised.length)} organised this visit · ${organiseLine(options.counts())}`;
      return endPane(organised, line);
    }
    const card = cardFor(id);
    if (!card) return personPaneReading();
    const { person } = card;
    if (S.pane === 'photo') return windowBack() + photoPane(card, chooserAlbum(card), { lit: S.dropping });
    if (S.pane === 'move') return windowBack() + movePane(S.moving?.picture ?? null);
    if (S.pane === 'faces') return windowBack() + facesPane({ card, deck: options.deck(), photoOf: photoFor, typed: S.faceTyped });
    const lit = S.lit ?? '';
    const row = rowsOf(card).find(each => each.id === lit);
    const me = () => personPane({ person, name: shownName(card), face: cardFace(card, 'head'), photos: photosRead(id), all: S.groups });
    if (!row) return me();
    if (row.kind === 'field') {
      return lit === 'f:rel' ? relPane(card) : lit === 'f:work' ? workPane(card) : namePane(card, lit === 'f:name' ? 'name' : 'full');
    }
    if (row.kind === 'birthday') return birthdayPane(card);
    if (row.kind === 'pill') return birthdayPane(card);
    if (row.kind === 'guess') return guessPane(row.suggestion);
    if (row.kind === 'profile') return profilePane(row.profile, 'Theirs');
    if (row.kind === 'more') return morePane(card);
    if (row.kind === 'notperson') return notPersonPane(person.talk);
    if (row.kind === 'chip' || row.kind === 'said') return kindPane(card, row);
    if (row.kind === 'faces') return facesPane({ card, deck: options.deck(), photoOf: photoFor, typed: S.faceTyped });
    if (row.kind === 'handle') return handlePane(row.handle, person);
    if (row.kind === 'add') {
      const finds = findsNow();
      return S.typed.trim() && finds?.[S.found] ? findPane(finds[S.found]) : addPane();
    }
    if (row.kind === 'group') return groupPane(row.group, groupRead(row.group.id));
    if (row.kind === 'added') {
      if (row.added.kind === 'group') return groupPane(row.added.group, groupRead(row.added.group.id));
      return row.added.kind === 'profile' ? profilePane(row.added.profile, 'Added by you') : findPane({ kind: 'person', row: row.added.find });
    }
    if (row.kind === 'suggestion') {
      const { kind, value } = row.suggestion;
      if (kind === 'same') return otherPane(otherId(value), 'Same person?');
      const profile = kind === 'profile' ? suggestedProfile(value) : null;
      if (profile) return profilePane(profile, `Where Lifestream found it · ${cardSource(row.suggestion)}`);
      const address = value.slice('email:'.length);
      return emailPane(address, 'Suggested email', addressRead(address));
    }
    return me();
  }

  /**
   * @param {string} id
   * @returns {Read<FaceCard>}
   */
  const groupRead = id => need(`group:${id}`, () => fetchFaceGroup(id));

  /**
   * @param {string} id
   * @param {string} eyebrow
   */
  function otherPane(id, eyebrow) {
    const read = personRead(id);
    const held = valueOf(read);
    if (held?.face) return namedFacePane(held, photosRead(id));
    return samePane(read, eyebrow);
  }

  /** @param {Find} find */
  function findPane(find) {
    if (find.kind === 'profile') return profilePane(find.profile, 'Found in what you typed');
    const { id } = find.row;
    if (id.startsWith('email:')) return emailPane(id.slice('email:'.length), 'Found', addressRead(id.slice('email:'.length)));
    return otherPane(id, 'Found');
  }

  /** @returns {Find[] | null} */
  function findsNow() {
    const words = S.typed.trim();
    const card = cardFor(idNow());
    if (!words || !card) return [];
    const read = need(`finds:${card.id}:${words.toLowerCase()}`, () => /** @type {Promise<PeopleFind>} */ (fetchPage('peopleFind', { q: words, for: card.id })));
    if (read.state === 'reading') return null;
    if (read.state === 'failed') return [];
    const added = card.added.flatMap(each => each.kind === 'profile' ? [each.profile] : []);
    const chosen = new Set(card.added.flatMap(each => each.kind === 'find' ? [each.find.id] : []));
    /** @type {Find[]} */
    const profiles = /** @type {import('../lib/details.js').Profile[]} */ (read.value.profiles).filter(found => !added.some(each => sameProfile(each, found)))
      .map(profile => ({ kind: /** @type {const} */ ('profile'), profile }));
    const rows = read.value.rows.filter(row => !chosen.has(row.id));
    for (const row of rows) if (row.id.startsWith('email:')) personRead(row.id);
    return [...profiles, ...rows.map(row => /** @type {Find} */ ({ kind: 'person', row }))];
  }


  const panelEl = () => /** @type {HTMLElement | null} */ (stage.querySelector('.pp-panel'));
  const bodyEl = () => /** @type {HTMLElement | null} */ (stage.querySelector('.pp-panel__body'));

  function readingNow() {
    const id = idNow();
    const card = id ? cardFor(id) : null;
    if (!id) return false;
    return !card;
  }

  function drawWindow() {
    if (stopped) return;
    const key = `${idNow()}:${S.pane}:${S.lit}:${S.found}`;
    const same = windowEl.dataset.key === key;
    stage.classList.toggle('is-choosing', S.pane !== null && Boolean(idNow()));
    if (S.pane === 'move' && same) return;
    const top = windowEl.scrollTop;
    const held = same ? focusIn(windowEl) : null;
    const { markup, busy } = noting(used.window, () => ({ markup: windowMarkup(), busy: readingNow() }));
    windowEl.innerHTML = `<div class="pp-window__in">${markup}</div>`;
    windowEl.dataset.key = key;
    windowEl.scrollTop = same ? top : 0;
    if (held) {
      const again = /** @type {HTMLElement | null} */ (windowEl.querySelector(held.selector));
      const to = again && !(/** @type {HTMLButtonElement} */ (again).disabled) ? again
        : /** @type {HTMLElement | null} */ (windowEl.querySelector('[data-o-chooser]'));
      to?.focus({ preventScroll: true });
      if (to instanceof HTMLInputElement && to === again && held.at !== null) to.setSelectionRange(held.at, held.at);
    }
    reading(stage, busy, 'Reading who they are');
    const field = /** @type {HTMLInputElement | null} */ (windowEl.querySelector('[data-o-upload]'));
    field?.addEventListener('change', () => void chosen(field.files?.[0]));
    if (S.pane === 'move') {
      const moving = installMoveAndScale(windowEl, { used: square => void use(square), cancelled: unchoose });
      fit();
      moving.focus();
    }
  }

  /**
   * @param {HTMLElement} within
   * @returns {{ selector: string, at: number | null } | null}
   */
  function focusIn(within) {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !within.contains(active)) return null;
    const named = [...active.attributes].find(each => each.name.startsWith('data-o-'));
    if (!named) return null;
    return { selector: `[${named.name}="${CSS.escape(named.value)}"]`,
      at: active instanceof HTMLInputElement ? active.selectionStart : null };
  }

  function fit() {
    const part = /** @type {HTMLElement | null} */ (windowEl.querySelector('.ck-mas'));
    if (!part) return;
    const bottom = windowEl.getBoundingClientRect().bottom - parseFloat(getComputedStyle(windowEl).paddingBottom);
    part.style.setProperty('--ck-mas-room', `${Math.max(0, Math.floor(bottom - part.getBoundingClientRect().top))}px`);
  }
  const fitting = new ResizeObserver(() => {
    fit();
    if (S.calendar) keepInView(stage.querySelector('.pp-cal'));
  });
  fitting.observe(windowEl);

  /** @param {{ fresh?: boolean, focus?: string | null }} [how] */
  function draw({ fresh = false, focus } = {}) {
    if (stopped || !stage.isConnected) return;
    drawing = true;
    const scroll = fresh ? 0 : bodyEl()?.scrollTop ?? 0;
    const active = document.activeElement;
    const was = active instanceof HTMLInputElement && stage.contains(active)
      ? { field: active.dataset.oField, add: active.dataset.oAdd !== undefined, at: active.selectionStart } : null;
    const id = idNow();
    const opening = id ? cardFor(id) : null;
    if (S.shown !== id && (opening || !id)) {
      S.shown = id;
      S.groups = false;
      if (mode === 'organise' && id) sitting.from = id;
      const card = opening;
      if (card && S.lit === null) S.lit = mode === 'edit' && options.first ? rowsOf(card).find(row => row.kind === 'suggestion' || row.kind === 'chip' || row.kind === 'group')?.id ?? null : firstLight(card);
    }
    pointed = false;
    panelEl()?.remove();
    stage.insertAdjacentHTML('afterbegin', noting(used.panel, () => panelMarkup(fresh)));
    applyGeometry(/** @type {HTMLElement} */ (panelEl()));
    const body = bodyEl();
    if (body) body.scrollTop = scroll;
    edges();
    const inWindow = active instanceof HTMLElement && windowEl.contains(active);
    drawWindow();
    const stays = focus === undefined && inWindow && windowEl.contains(document.activeElement);
    const want = stays ? null : focus === undefined ? S.lit : focus;
    if (want) {
      const el = /** @type {HTMLElement | null} */ (stage.querySelector(`.pp-panel [data-row="${CSS.escape(want)}"]`));
      const input = el?.querySelector('input') ?? null;
      (input ?? el)?.focus({ preventScroll: true });
      if (input && was && (was.field === input.dataset.oField || (was.add && input.dataset.oAdd !== undefined))) {
        const at = Math.min(was.at ?? input.value.length, input.value.length);
        input.setSelectionRange(at, at);
      }
      keepInView(el);
    } else if (fresh || !stage.contains(document.activeElement)) body?.focus({ preventScroll: true });
    placeOverlay();
    readAhead();
    drawing = false;
  }

  function placeOverlay() {
    const panel = panelEl();
    const body = bodyEl();
    if (!panel || !body) return;
    pointed = false;
    used.pop.clear();
    panel.querySelector('.pp-pop')?.remove();
    /** @type {Element | null} */
    let anchor = null;
    let markup = '';
    const card = cardFor(idNow());
    if (S.menu && card) {
      anchor = panel.querySelector('[data-row="notperson"]');
      markup = kindMenu(S.menu.active, card.said);
    } else if (card && S.typed.trim() && /** @type {HTMLElement | null} */ (document.activeElement)?.dataset?.oAdd !== undefined) {
      anchor = panel.querySelector('[data-row="add"]');
      markup = noting(used.pop, () => findsList(findsNow(), S.found, S.typed));
    }
    if (!anchor || !markup) return;
    const pop = document.createElement('div');
    pop.className = 'pp-pop';
    pop.innerHTML = markup;
    panel.append(pop);
    const frame = panel.getBoundingClientRect();
    const at = anchor.getBoundingClientRect();
    const top = at.top - frame.top;
    const bottom = at.bottom - frame.top;
    const height = pop.offsetHeight;
    const below = body.getBoundingClientRect().bottom - frame.top - 8 - (bottom + 4);
    const above = top - 4 - 8;
    if (height <= below || below >= UNDER) {
      pop.style.top = `${bottom + 4}px`;
      pop.style.maxHeight = `${Math.max(0, below)}px`;
    } else {
      pop.style.maxHeight = `${Math.max(0, above)}px`;
      pop.style.top = `${top - 4 - Math.min(height, above)}px`;
    }
    const list = pop.querySelector('.ck-flist');
    const lit = /** @type {HTMLElement | null} */ (pop.querySelector('.is-lit'));
    if (lit && list) {
      const litTop = lit.offsetTop - 4;
      const litBottom = litTop + lit.offsetHeight + 8;
      if (litTop < list.scrollTop) list.scrollTop = litTop;
      else if (litBottom > list.scrollTop + list.clientHeight) list.scrollTop = litBottom - list.clientHeight;
    }
  }

  function edges() {
    const panel = panelEl();
    const body = bodyEl();
    if (!panel || !body) return;
    panel.classList.toggle('is-scrolled', body.scrollTop > 0);
    panel.classList.toggle('has-more', body.scrollTop + body.clientHeight < body.scrollHeight - 1);
  }

  /** @param {Element | null} el */
  function keepInView(el) {
    const body = el?.closest('.pp-panel__body');
    if (!el || !(body instanceof HTMLElement)) return;
    const top = el.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
    const bottom = top + /** @type {HTMLElement} */ (el).offsetHeight;
    if (top < body.scrollTop + 8) body.scrollTop = top - 8;
    else if (bottom > body.scrollTop + body.clientHeight - 8) body.scrollTop = bottom - body.clientHeight + 8;
  }


  /** @param {string} id */
  function light(id) {
    S.lit = id;
    pointed = false;
    const el = /** @type {HTMLElement | null} */ (stage.querySelector(`.pp-panel [data-row="${CSS.escape(id)}"]`));
    if (!el) return;
    const input = el.querySelector('input');
    (input ?? el).focus({ preventScroll: true });
    if (input && input.dataset.oAdd === undefined) input.setSelectionRange(input.value.length, input.value.length);
    keepInView(el);
    drawWindow();
  }

  function unlight() {
    S.lit = null;
    bodyEl()?.focus({ preventScroll: true });
    drawWindow();
  }

  /** @param {string} rowId */
  function toggle(rowId) {
    const card = cardFor(idNow());
    if (!card) return;
    const row = rowsOf(card).find(each => each.id === rowId);
    const on = !card.ticks.get(rowId);
    card.ticks.set(rowId, on);
    if (row?.kind === 'guess') fill(card, on ? birthdayOf(row.suggestion.value) : null);
    S.lit = rowId;
    draw();
  }

  /**
   * @param {Card} card
   * @param {import('../lib/details.js').Birthday | null} day
   */
  function fill(card, day) {
    card.birthday = day;
    card.shows.birthday = day !== null;
  }

  /**
   * @param {boolean} open
   * @param {boolean} [keyboard]
   */
  function calendar(open, keyboard = false) {
    const card = cardFor(idNow());
    if (!card) return;
    if (open) {
      card.shows.birthday = true;
      S.calendar = { month: card.birthday?.month ?? todayNow().month, year: card.birthday?.year ? String(card.birthday.year) : '', at: null };
      S.lit = 'f:birthday';
      draw();
      if (keyboard) focusDay();
      keepInView(stage.querySelector('.pp-cal'));
      return;
    }
    if (!S.calendar) return;
    S.calendar = null;
    if (card.birthday === null) {
      card.shows.birthday = false;
      if (S.lit === 'f:birthday') S.lit = 'addbirthday';
    }
    draw({ focus: S.lit });
  }

  /**
   * @param {number} day
   * @param {boolean} [keyboard]
   * @param {number} [out]
   */
  function chooseDay(day, keyboard = false, out = 0) {
    const card = cardFor(idNow());
    if (!card || !S.calendar) return;
    if (out) S.calendar.month = ((S.calendar.month - 1 + out + 12) % 12) + 1;
    const year = yearOf(S.calendar.year);
    const same = card.birthday?.month === S.calendar.month && card.birthday.day === day;
    card.birthday = same ? null : { month: S.calendar.month, day, year };
    S.calendar.at = day;
    draw({ focus: keyboard ? null : 'f:birthday' });
    if (keyboard) focusDay();
  }

  const monthShown = () => birthdayMonth(S.calendar?.month ?? 1, yearOf(S.calendar?.year ?? ''), todayNow().year);

  const daysShown = () => S.calendar ? monthShown().count : 0;

  /**
   * @param {number} by
   * @param {boolean} [keyboard]
   */
  function stepMonth(by, keyboard = false) {
    if (!S.calendar) return;
    S.calendar.month = ((S.calendar.month - 1 + by + 12) % 12) + 1;
    if (S.calendar.at !== null) S.calendar.at = Math.min(S.calendar.at, daysShown());
    draw({ focus: keyboard ? null : 'f:birthday' });
    if (keyboard) focusDay();
  }

  /** @param {number} to */
  function moveDay(to) {
    if (!S.calendar) return;
    if (to < 1) {
      to += monthShown().before;
      S.calendar.month = ((S.calendar.month + 10) % 12) + 1;
    } else if (to > daysShown()) {
      to -= daysShown();
      S.calendar.month = (S.calendar.month % 12) + 1;
    }
    S.calendar.at = to;
    draw({ focus: null });
    focusDay();
  }

  const focusDay = () => /** @type {HTMLElement | null} */ (stage.querySelector('.pp-cal .ck-mgrid__day[tabindex="0"]'))
    ?.focus({ preventScroll: true });

  /** @param {string} kind */
  function say(kind) {
    const card = cardFor(idNow());
    if (!card) return;
    card.said = kind;
    S.menu = null;
    S.lit = 'said';
    draw();
  }

  /**
   * @param {'confirm' | 'skip' | 'hide'} what
   * @param {{ id: string, action: Record<string, unknown>, card: Card } | null} [retry]
   */
  function answer(what, retry = null) {
    const id = retry?.id ?? idNow();
    const card = cardFor(id);
    if (!id || !card) return;
    const was = retry?.card ?? cardCopy(card);
    const name = shownName(card);
    /** @type {Promise<{ act: string | null, position: string } | null>} */
    let sent = Promise.resolve(null);
    if (what === 'skip') sitting.skipped.add(id);
    else {
      sitting.done.add(id);
      if (what === 'confirm') organised.push(card);
      const action = retry?.action ?? (what === 'hide' ? { kind: 'confirm', id, hidden: true } : answerOf(card));
      const others = touchedBy(card, action);
      for (const other of others) {
        forget(other);
        touched.add(other);
      }
      sent = inOrder(() => options.act(action)).then(answered => {
        readAhead();
        return answered;
      }, error => {
        for (const other of others) touched.delete(other);
        refused(id, was, error, what, action);
        return null;
      });
    }
    given++;
    if (sitting.from === id) sitting.from = '';
    last = { id, what, card: was, sent };
    S.said = `${name} ${{ confirm: 'confirmed', skip: 'skipped', hide: 'hidden' }[what]}`;
    S.failure = null;
    calm();
    draw({ fresh: true });
  }

  /**
   * @param {string} id
   * @param {Card} card
   * @param {unknown} error
   * @param {'confirm' | 'hide'} what
   * @param {Record<string, unknown>} action
   */
  function refused(id, card, error, what, action) {
    if (last?.id === id) last = null;
    given--;
    sitting.done.delete(id);
    const confirmed = organised.findIndex(each => each.id === id);
    if (confirmed >= 0) organised.splice(confirmed, 1);
    sitting.from = id;
    if (!movedUnder(id, card, error)) cards.set(id, cardCopy(card));
    S.failure = resent(notSaved(error), () => answer(what, { id, action, card }));
    calm();
    draw({ fresh: true });
  }

  /**
   * @param {string} id
   * @param {Card} card
   * @param {unknown} error
   */
  function movedUnder(id, card, error) {
    const { code } = /** @type {{ code?: string }} */ (error);
    if (code !== 'NOT_OFFERED' && code !== 'NOT_JOINED') return false;
    forget(id);
    kept.set(id, card);
    return true;
  }

  /**
   * @param {unknown} error
   * @returns {{ said: import('../lib/reach.js').Said, words: string }}
   */
  const notSaved = error => {
    const { code } = /** @type {{ code?: string }} */ (error);
    return code === 'NOT_OFFERED' ? { said: 'refused', words: 'Not saved: what Lifestream suggests for them has changed. Here it is as it stands.' }
      : code === 'NOT_JOINED' ? { said: 'refused', words: 'Not saved: someone joined in was split off already. Here it is as it stands.' }
        : unsaved(error, messageOf(error));
  };

  /**
   * @param {{ said: import('../lib/reach.js').Said, words: string }} failure
   * @param {() => void} resend
   */
  const resent = (failure, resend) => failure.said === 'not-sent' ? { ...failure, again: 'resend', resend } : failure;

  function undo() {
    const back = last;
    if (!back) return;
    last = null;
    draw();
    if (back.what === 'skip') return restore(back);
    /** @type {Promise<{ position: string } | null>} */
    const taking = inOrder(async () => {
      const answered = await back.sent;
      if (answered === null) return null;
      return answered.act ? await options.act({ kind: 'undo', act: answered.act }) : answered;
    });
    const undoing = taking.then(undone => {
      if (!undone) return true;
      if (back.what !== 'photo') {
        restore(back);
        return true;
      }
      unused(back);
      const card = cards.get(back.id);
      if (mode === 'edit' && photoSaved && card) photoSaved = { ...photoSaved, position: undone.position };
      return true;
    }, error => {
      const failure = unsaved(error, messageOf(error), 'Not undone');
      const again = failure.said === 'not-sent' && last === null;
      if (again) last = back;
      S.failure = { ...failure, ...again ? { again: 'undo' } : {} };
      draw();
      return false;
    });
    if (back.what === 'photo') photoAct(undoing);
  }

  /** @param {{ id: string, made: string, before: string | null }} back */
  function unused(back) {
    const card = cards.get(back.id);
    if (last?.what === 'photo' && last.id === back.id && last.before === back.made) last.before = back.before;
    if (!card || card.made !== back.made) return;
    card.made = back.before;
    S.said = 'Photo taken back';
    S.failure = null;
    draw();
  }

  /** @param {{ id: string, card: Card }} back */
  function restore(back) {
    given--;
    sitting.done.delete(back.id);
    sitting.skipped.delete(back.id);
    const confirmed = organised.findIndex(each => each.id === back.id);
    if (confirmed >= 0) organised.splice(confirmed, 1);
    sitting.from = back.id;
    cards.set(back.id, back.card);
    S.said = `Back to ${shownName(back.card)}`;
    S.failure = null;
    calm();
    draw({ fresh: true });
  }

  /** @param {Record<string, unknown> | null} [retry] */
  function save(retry = null) {
    const id = idNow();
    const card = cardFor(id);
    if (!card || S.saving) return;
    const action = retry ?? answerOf(card);
    S.saving = true;
    S.said = '';
    S.failure = null;
    draw();
    inOrder(() => options.act(action, { waiting: error => {
      S.failure = notSaved(error);
      draw();
    } })).then(answered => {
      if (!stopped) options.leave({ id: answered.id, position: answered.position, saved: { said: savedWords(card), act: answered.act } });
    }, error => {
      S.saving = false;
      const moved = movedUnder(id, card, error);
      S.failure = resent(notSaved(error), () => save(action));
      draw({ fresh: moved });
    });
  }

  /** @param {Record<string, unknown> | null} [retry] */
  function hide(retry = null) {
    const action = retry ?? { kind: 'confirm', id: idNow(), hidden: true };
    S.saving = true;
    S.failure = null;
    draw();
    options.act(action, { waiting: error => {
      S.failure = unsaved(error, messageOf(error));
      draw();
    } }).then(answered => {
      if (!stopped) options.hidden({ id: answered.id, position: answered.position });
    }, error => {
      S.saving = false;
      S.failure = resent(unsaved(error, messageOf(error)), () => hide(action));
      draw();
    });
  }

  function addName() {
    const card = cardFor(idNow());
    const name = S.naming.replace(/\s+/gu, ' ').trim();
    if (!card || !name || name.length > NAME_LONGEST || card.called.length >= NAMES_MOST) return;
    const fold = nameFold(name);
    if (!card.called.some(each => nameFold(each.name) === fold)) card.called.push({ name, from: 'You added' });
    S.naming = '';
    S.lit = 'addname';
    draw({ focus: 'addname' });
  }

  /** @param {number} at */
  function addFind(at) {
    const find = findsNow()?.[at];
    const card = cardFor(idNow());
    if (!find || !card) return;
    const key = find.kind === 'profile' ? `profile-${profileKey(find.profile)}` : `find-${find.row.id}`;
    card.added.push(find.kind === 'profile' ? { key, kind: 'profile', profile: find.profile } : { key, kind: 'find', find: find.row });
    card.ticks.set(`a:${key}`, true);
    S.typed = '';
    S.found = 0;
    S.lit = `a:${key}`;
    draw();
  }

  /** @param {string} pick */
  async function pickFace(pick) {
    const card = cardFor(idNow());
    if (!card) return;
    /** @type {import('../ui/people/organise.js').Added} */
    let added;
    if (pick.startsWith('group:')) {
      const id = pick.slice('group:'.length);
      const deck = options.deck();
      const found = deck?.cards.find(each => each.id === id);
      if (!deck || !found) return;
      /** @type {Group} */
      const group = { id, faces: found.faces, photos: found.photos, years: found.years, sample: found.sample, reason: '',
        crops: Object.fromEntries(found.sample.flatMap(face => deck.crops[face] ? [[face, deck.crops[face]]] : [])) };
      added = { key: `group-${id}`, kind: 'group', group };
    } else {
      const person = options.row(pick) ?? await options.page(pick).then(page => {
        const { id, name, named, face, photo } = editPersonOf(pick, page);
        return { id, name, named, face, photo, when: null, line: null, find: [] };
      }, () => undefined);
      if (!person) return;
      added = { key: `find-${person.id}`, kind: 'find', find: person };
    }
    card.added.push(added);
    card.ticks.set(`a:${added.key}`, true);
    S.pane = null;
    S.faceTyped = '';
    S.lit = `a:${added.key}`;
    draw();
  }

  /** @param {Blob | undefined} file */
  async function chosen(file) {
    if (!file || S.pane !== 'photo') return;
    const picture = await openPicture(file);
    if (S.pane !== 'photo') {
      if (picture) URL.revokeObjectURL(picture.src);
      return;
    }
    S.moving = { file, picture };
    S.pane = 'move';
    drawWindow();
  }

  /**
   * @param {Card} card
   * @param {number} by
   */
  function page(card, by) {
    rereadPhotos(card.id);
    const album = chooserAlbum(card);
    if (!album) return;
    const lastPage = Math.max(0, Math.ceil(album.total / photosAPage(card)) - 1);
    const shown = Math.min(card.page, lastPage);
    const next = Math.max(0, Math.min(lastPage, shown + by));
    if (next === shown) return;
    card.page = next;
    drawWindow();
    /** @type {HTMLElement | null} */ (windowEl.querySelector(`[data-o-page="${by < 0 ? '-1' : '1'}"]:not(:disabled)`)
      ?? windowEl.querySelector('[data-o-chooser]'))?.focus({ preventScroll: true });
  }

  /**
   * @param {Card} card
   * @param {number} at
   */
  async function frame(card, at) {
    const photo = chooserAlbum(card)?.photos[at];
    if (!photo || S.pane !== 'photo') return;
    /** @type {Blob | null} */
    let file = null;
    try {
      const reply = await fetch(pictureUrl(`sha256:${photo.image}`, 'full'));
      if (reply.ok) file = await reply.blob();
    } catch {
    }
    if (S.pane !== 'photo' || cardFor(idNow()) !== card) return;
    const picture = file ? await openPicture(file) : null;
    if (S.pane !== 'photo' || cardFor(idNow()) !== card) {
      if (picture) URL.revokeObjectURL(picture.src);
      return;
    }
    S.moving = { file: file ?? new Blob(), picture: picture ? { ...picture, square: aroundFace(picture, photo.box) } : null };
    S.pane = 'move';
    drawWindow();
  }

  function unchoose() {
    unmove();
    S.pane = 'photo';
    draw({ focus: null });
    /** @type {HTMLElement | null} */ (windowEl.querySelector('[data-o-upload]'))?.focus({ preventScroll: true });
  }

  let making = false;

  /** @param {import('../ui/kit/move-and-scale.js').Square} square */
  async function use(square) {
    const id = idNow();
    const card = cardFor(id);
    const moving = S.moving;
    if (!card || !moving || making) return;
    making = true;
    /** @type {Awaited<ReturnType<typeof makeSquare>>} */
    let made;
    try {
      made = await makeSquare(moving.file, square);
    } catch {
      if (S.moving === moving) {
        unmove();
        S.moving = { file: moving.file, picture: null };
        windowEl.dataset.key = '';
        drawWindow();
      }
      return;
    } finally {
      making = false;
    }
    if (S.moving !== moving || cardFor(idNow()) !== card) return;
    keepPicture(made.hash, made.jpeg);
    savePhoto(card, id, made);
    unmove();
    S.pane = 'photo';
    draw({ focus: null });
    /** @type {HTMLElement | null} */ (windowEl.querySelector('[data-o-chooser]'))?.focus({ preventScroll: true });
  }

  /**
   * @param {Card} card
   * @param {string} id
   * @param {{ hash: string, base64: string }} made
   */
  function savePhoto(card, id, made) {
    const before = card.made;
    card.made = made.hash;
    const sent = inOrder(() => options.act({ kind: 'photo', id, upload: made.base64 })).then(answered => {
      if (mode === 'edit') photoSaved = { id: answered.id, position: answered.position };
      return answered;
    }, error => {
      if (last?.sent === sent) last = null;
      if (card.made === made.hash) card.made = before;
      const failure = unsaved(error, messageOf(error), cardFor(idNow()) === card ? 'Not saved' : `${shownName(card)}’s photo not saved`);
      S.failure = resent(failure, () => savePhoto(card, id, made));
      draw();
      return null;
    });
    last = { id, what: 'photo', made: made.hash, before, sent };
    photoAct(sent.then(answered => answered !== null));
    S.said = 'Photo saved';
    S.failure = null;
  }

  /** @type {Promise<void> | null} */
  let leaving = null;

  const leave = () => {
    if (photoSaving) {
      if (leaving) return;
      S.saving = true;
      draw();
      leaving = photoSaving.then(taken => {
        leaving = null;
        S.saving = false;
        if (taken) return leave();
        draw();
      });
      return;
    }
    options.leave(mode === 'edit' ? photoSaved : null);
  };

  function again() {
    sitting.skipped.clear();
    S.said = '';
    S.failure = null;
    calm();
    draw({ fresh: true });
  }


  const ROUTED = '[data-o-do], [data-o-tick], [data-o-remove], [data-o-unlist], [data-o-unname], [data-o-split], '
    + '[data-o-unsay], [data-o-kind], [data-o-find], [data-o-use], [data-o-frame], [data-o-page], [data-o-pick], [data-ck-cal-step], [data-ck-cal-day]';

  /** @param {MouseEvent} event */
  const onClick = event => {
    const target = /** @type {HTMLElement} */ (event.target);
    const el = /** @type {HTMLElement | null} */ (target.closest(ROUTED));
    const card = cardFor(idNow());
    if (!el) {
      if (S.menu && !target.closest('.pp-pop')) {
        S.menu = null;
        return draw();
      }
      const row = /** @type {HTMLElement | null} */ (target.closest('.pp-panel [data-row]'));
      if (row && (!target.closest('input') || S.lit !== row.dataset.row)) return light(/** @type {string} */ (row.dataset.row));
      if (target.closest('.pp-panel') && !target.closest('button, input, label, .pp-pop') && S.lit) return unlight();
      return;
    }
    const d = el.dataset;
    if (d.oTick !== undefined) {
      if (target.closest('.ck-namerow__end, .ck-tick')) return toggle(d.oTick);
      return light(d.oTick);
    }
    if (d.oRemove !== undefined && card) {
      event.stopPropagation();
      card.removed.add(d.oRemove);
      S.lit = rowsOf(card).find(row => row.kind === 'handle' || row.kind === 'suggestion')?.id ?? 'add';
      return draw();
    }
    if (d.oUnname !== undefined && card) {
      event.stopPropagation();
      card.called = card.called.filter(each => each.name !== d.oUnname);
      S.lit = rowsOf(card).find(row => row.kind === 'called')?.id ?? 'addname';
      return draw();
    }
    if (d.oSplit !== undefined && card) {
      event.stopPropagation();
      card.split.add(d.oSplit);
      S.lit = rowsOf(card).find(row => row.kind === 'joined')?.id ?? 'add';
      return draw();
    }
    if (d.oUnlist !== undefined && card) {
      event.stopPropagation();
      card.unlisted.add(d.oUnlist);
      S.lit = rowsOf(card).find(row => row.kind === 'profile' || row.kind === 'suggestion')?.id ?? 'add';
      return draw();
    }
    if (d.ckCalStep !== undefined) return stepMonth(Number(d.ckCalStep));
    if (d.ckCalDay !== undefined) return chooseDay(Number(d.ckCalDay), false, Number(d.ckCalOut ?? 0));
    if (d.oPage !== undefined && card) return page(card, Number(d.oPage));
    if (d.oFrame !== undefined && card) return void frame(card, Number(d.oFrame));
    if (d.oUnsay !== undefined && card) {
      card.said = null;
      S.lit = 'notperson';
      return draw();
    }
    if (d.oKind !== undefined) return say(d.oKind);
    if (d.oFind !== undefined) return addFind(Number(d.oFind));
    if (d.oUse !== undefined && card) {
      card.fields[/** @type {'name' | 'full'} */ (d.oUse)] = d.oValue ?? '';
      return draw({ focus: `f:${d.oUse}` });
    }
    if (d.oPick !== undefined) return void pickFace(d.oPick);
    switch (d.oDo) {
      case 'groups':
        S.groups = true;
        return drawWindow();
      case 'confirm': return answer('confirm');
      case 'skip': return answer('skip');
      case 'hide': return mode === 'edit' ? hide() : answer('hide');
      case 'undo': return void undo();
      case 'close': case 'cancel': case 'done': return leave();
      case 'again': return again();
      case 'save': return save();
      case 'resend': {
        const resend = S.failure?.resend;
        S.failure = null;
        resend?.();
        return draw();
      }
      case 'notperson':
        S.menu = S.menu ? null : { active: 0 };
        S.lit = 'notperson';
        return draw({ focus: 'notperson' });
      case 'calendar': return calendar(S.calendar === null, event.detail === 0);
      case 'addbirthday': return calendar(true, event.detail === 0);
      case 'more': return options.findFaces(card?.id ?? idNow());
      case 'back':
        if (S.pane === 'move') return unchoose();
        S.pane = null;
        S.faceTyped = '';
        return draw();
      case 'photo':
        S.pane = S.pane === 'photo' ? null : 'photo';
        if (S.pane && card) rereadPhotos(card.id);
        S.menu = null;
        return draw({ focus: null });
      case 'faces':
        S.pane = S.pane === 'faces' ? null : 'faces';
        S.menu = null;
        draw({ focus: null });
        if (S.pane) /** @type {HTMLElement | null} */ (stage.querySelector('[data-o-face-find]'))?.focus();
        return undefined;
      default: return undefined;
    }
  };

  /** @param {FocusEvent} event */
  const onFocus = event => {
    if (drawing) return;
    const el = /** @type {HTMLElement} */ (event.target).closest('[data-row]');
    if (!(el instanceof HTMLElement) || !el.closest('.pp-panel')) return;
    const id = /** @type {string} */ (el.dataset.row);
    if (S.lit !== id) {
      S.lit = id;
      drawWindow();
    }
    if (S.menu && id !== 'notperson') {
      S.menu = null;
      draw();
    }
  };

  /** @param {PointerEvent} event */
  const onMove = event => {
    if (event.clientX === pointerAt.x && event.clientY === pointerAt.y) return;
    pointerAt = { x: event.clientX, y: event.clientY };
    if (!pointed) {
      pointed = true;
      pointMenu(event);
    }
  };
  /** @param {PointerEvent} event */
  const onOver = event => {
    if (pointed) pointMenu(event);
  };
  /** @param {Event} event */
  function pointMenu(event) {
    const item = /** @type {HTMLElement} */ (event.target).closest('[data-o-menu-at]');
    if (!(item instanceof HTMLElement) || !S.menu) return;
    const at = Number(item.dataset.oMenuAt);
    if (S.menu.active !== at) {
      S.menu.active = at;
      placeOverlay();
    }
  }
  /** @param {Event} event */
  const onScroll = event => {
    if (!/** @type {HTMLElement} */ (event.target).matches?.('.pp-panel__body')) return;
    edges();
    if (stage.querySelector('.pp-pop')) placeOverlay();
  };
  /** @param {FocusEvent} event */
  const onBlur = event => {
    if (drawing) return;
    const target = /** @type {HTMLElement} */ (event.target);
    const into = /** @type {Node | null} */ (event.relatedTarget);
    if (S.calendar && target.closest('.pp-calwrap') && !(into instanceof Node && target.closest('.pp-calwrap')?.contains(into))) {
      setTimeout(() => {
        if (drawing || !S.calendar || stage.querySelector('.pp-calwrap')?.contains(document.activeElement)) return;
        calendar(false);
      }, 0);
    }
    if (target.dataset?.oAdd === undefined) return;
    setTimeout(() => {
      if (!drawing) placeOverlay();
    }, 0);
  };
  /** @param {PointerEvent} event */
  const onDown = event => {
    const target = /** @type {HTMLElement} */ (event.target);
    if (target.closest('.pp-pop') || (target.closest('.ck-mgrid') && !target.closest('[data-ck-cal-year]'))) event.preventDefault();
  };

  /** @param {Event} event */
  const onInput = event => {
    const input = /** @type {HTMLInputElement} */ (event.target);
    const card = cardFor(idNow());
    if (!card) return;
    if (input.dataset.oName !== undefined) {
      S.naming = input.value;
      return;
    }
    if (input.dataset.oAdd !== undefined) {
      S.typed = input.value;
      S.found = 0;
      placeOverlay();
      return drawWindow();
    }
    if (input.dataset.oFaceFind !== undefined) {
      S.faceTyped = input.value;
      const at = input.selectionStart;
      drawWindow();
      const again = /** @type {HTMLInputElement | null} */ (stage.querySelector('[data-o-face-find]'));
      again?.focus();
      again?.setSelectionRange(at, at);
      return;
    }
    if (input.dataset.ckCalYear !== undefined && S.calendar) {
      S.calendar.year = input.value.replace(/\D/gu, '').slice(0, 4);
      const typed = yearOf(S.calendar.year);
      if (card.birthday && (typed !== null || S.calendar.year === '')) {
        const held = new Date(Date.UTC(typed ?? 2000, card.birthday.month, 0)).getUTCDate();
        card.birthday = { ...card.birthday, day: Math.min(card.birthday.day, held), year: typed };
      }
      if (S.calendar.at !== null) S.calendar.at = Math.min(S.calendar.at, daysShown());
      const at = input.selectionStart;
      draw({ focus: null });
      const again = /** @type {HTMLInputElement | null} */ (stage.querySelector('[data-ck-cal-year]'));
      again?.focus({ preventScroll: true });
      again?.setSelectionRange(at, at);
      return;
    }
    const field = /** @type {keyof import('../ui/people/organise.js').Fields | undefined} */ (input.dataset.oField);
    if (!field) return;
    card.fields[field] = input.value;
    const source = /** @type {HTMLElement | null} */ (input.parentElement?.querySelector('.ck-fieldrow__src') ?? null);
    if (source) source.hidden = input.value !== card.opened[field];
    const title = windowEl.querySelector('.pp-window__title');
    if (title && S.lit === `f:${field}`) title.textContent = input.value.trim() || UNTYPED[field];
    if (field === 'rel' || field === 'work') return;
    const shown = stage.querySelector('[data-o-shown]');
    if (shown) shown.textContent = shownName(card);
    const face = stage.querySelector('.pp-hero__face .ck-mono');
    if (face && !face.querySelector('img')) face.outerHTML = cardFace(card, 'tile');
  };

  /** @param {KeyboardEvent} event */
  const onKey = event => {
    if (event.defaultPrevented || !stage.isConnected || stage.closest('[hidden]')) return;
    const active = /** @type {HTMLElement} */ (document.activeElement);
    if (active !== document.body && !stage.contains(active)) return;
    if (S.pane === 'move') {
      if (event.key === 'Escape') unchoose();
      return;
    }
    pointed = false;
    const id = idNow();
    const typing = active instanceof HTMLInputElement;
    const inField = typing && active.dataset.oField !== undefined;
    const inAdd = typing && active.dataset.oAdd !== undefined;
    const inFaceFind = typing && active.dataset.oFaceFind !== undefined;
    const inName = typing && active.dataset.oName !== undefined;
    const meta = event.metaKey || event.ctrlKey;
    const { key } = event;
    if (meta && key.toLowerCase() === 'z' && !typing) {
      event.preventDefault();
      if (mode === 'organise' || last?.what === 'photo') void undo();
      return;
    }
    if (meta && key.toLowerCase() === 's' && mode === 'edit') {
      event.preventDefault();
      return save();
    }
    if (meta || event.altKey) return;
    if (!id) {
      if (key === 'Enter') {
        event.preventDefault();
        leave();
      }
      return;
    }
    const card = cardFor(id);
    if (!card) {
      if (key === 'Escape') {
        event.preventDefault();
        leave();
      }
      return;
    }
    if (S.calendar && key === 'Escape') {
      event.preventDefault();
      return calendar(false);
    }
    if (typing && active.dataset.ckCalYear !== undefined) return;
    if (S.calendar && active.dataset.ckCalDay !== undefined) {
      const at = Number(active.dataset.ckCalDay);
      const by = /** @type {Record<string, number>} */ ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 })[key];
      if (by !== undefined) {
        event.preventDefault();
        return moveDay(at + by);
      }
      if (key === 'PageUp' || key === 'PageDown') {
        event.preventDefault();
        S.calendar.at = at;
        return stepMonth(key === 'PageUp' ? -1 : 1, true);
      }
      if (key === 'Enter' || key === ' ') {
        event.preventDefault();
        return chooseDay(at, true);
      }
      return;
    }
    if (S.calendar && key === 'ArrowDown' && active.dataset.row === 'f:birthday') {
      event.preventDefault();
      return focusDay();
    }
    if (S.pane === 'photo' && !typing && (key === 'ArrowLeft' || key === 'ArrowRight') && windowEl.contains(active)) {
      event.preventDefault();
      return page(card, key === 'ArrowLeft' ? -1 : 1);
    }
    if (S.menu) {
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        event.preventDefault();
        S.menu.active = (S.menu.active + (key === 'ArrowDown' ? 1 : KINDS.length - 1)) % KINDS.length;
        return placeOverlay();
      }
      if (key === 'Enter' || key === ' ') {
        event.preventDefault();
        return say(KINDS[S.menu.active].value);
      }
      if (key === 'Escape' || key === 'Tab') {
        if (key === 'Escape') event.preventDefault();
        S.menu = null;
        return draw({ focus: 'notperson' });
      }
      return;
    }
    if (inFaceFind) {
      if (key !== 'Escape') return;
      event.preventDefault();
      if (active.value) {
        S.faceTyped = '';
        drawWindow();
        /** @type {HTMLElement | null} */ (stage.querySelector('[data-o-face-find]'))?.focus();
      } else {
        S.pane = null;
        draw();
      }
      return;
    }
    if (inName && (key === 'Enter' || (key === 'Escape' && S.naming))) {
      event.preventDefault();
      if (key === 'Enter') return addName();
      S.naming = '';
      return draw({ focus: 'addname' });
    }
    if (inAdd && S.typed.trim()) {
      const finds = findsNow() ?? [];
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        event.preventDefault();
        if (finds.length) {
          S.found = (S.found + (key === 'ArrowDown' ? 1 : finds.length - 1)) % finds.length;
          placeOverlay();
          drawWindow();
        }
        return;
      }
      if (key === 'Enter') {
        event.preventDefault();
        return addFind(S.found);
      }
      if (key === 'Escape') {
        event.preventDefault();
        S.typed = '';
        S.found = 0;
        return draw({ focus: 'add' });
      }
      return;
    }
    const rows = rowsOf(card);
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      const at = rows.findIndex(row => row.id === S.lit);
      const step = key === 'ArrowDown' ? 1 : -1;
      const to = at < 0 ? (step > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, at + step));
      return light(rows[to].id);
    }
    const row = rows.find(each => each.id === S.lit);
    const tickable = row && (row.kind === 'suggestion' || row.kind === 'chip' || row.kind === 'guess' || row.kind === 'group' || row.kind === 'added');
    if (key === ' ' && !typing) {
      if (tickable) {
        event.preventDefault();
        return toggle(row.id);
      }
      if (row?.kind === 'notperson') {
        event.preventDefault();
        S.menu = { active: 0 };
        return draw({ focus: 'notperson' });
      }
      return;
    }
    if (key === 'Enter') {
      if (tickable && !typing) {
        event.preventDefault();
        return toggle(row.id);
      }
      if (active instanceof HTMLButtonElement && (!active.closest('[data-row]') || active.dataset.oDo !== undefined
        || active.dataset.oUnsay !== undefined)) return;
      event.preventDefault();
      return mode === 'edit' ? undefined : answer('confirm');
    }
    if (key === 'Escape') {
      event.preventDefault();
      if (inField) {
        const field = /** @type {keyof import('../ui/people/organise.js').Fields} */ (active.dataset.oField);
        if (card.fields[field] !== card.opened[field]) {
          card.fields[field] = card.opened[field];
          return draw({ focus: S.lit });
        }
      }
      if (inAdd) return unlight();
      if (S.pane) {
        S.pane = null;
        S.faceTyped = '';
        return draw();
      }
      if (S.lit) return unlight();
      return leave();
    }
    if (key === 'ArrowRight' && !typing && mode === 'organise') {
      event.preventDefault();
      return answer('skip');
    }
    if (!typing && key.length === 1 && key !== ' ') {
      const add = /** @type {HTMLInputElement | null} */ (stage.querySelector('[data-o-add]'));
      if (add) {
        S.lit = 'add';
        add.focus();
      }
    }
  };

  let over = 0;
  /** @param {DragEvent} event */
  const carriesFiles = event => [...(event.dataTransfer?.types ?? [])].includes('Files');
  const choosing = () => S.pane === 'photo' && stage.isConnected && !stage.closest('[hidden]');
  /** @param {boolean} on */
  const dropping = on => {
    S.dropping = on;
    windowEl.querySelector('.ck-fcrop--upload')?.classList.toggle('is-lit', on);
  };
  /** @param {DragEvent} event */
  const onDragEnter = event => {
    if (!carriesFiles(event) || !choosing()) return;
    over++;
    dropping(true);
  };
  /** @param {DragEvent} event */
  const onDragLeave = event => {
    if (!carriesFiles(event) || !choosing()) return;
    over = Math.max(0, over - 1);
    if (over === 0) dropping(false);
  };
  /** @param {DragEvent} event */
  const onDragOver = event => {
    if (!carriesFiles(event) || !event.dataTransfer || (!choosing() && !stage.contains(/** @type {Node} */ (event.target)))) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = choosing() ? 'copy' : 'none';
  };
  /** @param {DragEvent} event */
  const onDrop = event => {
    if (!carriesFiles(event) || (!choosing() && !stage.contains(/** @type {Node} */ (event.target)))) return;
    event.preventDefault();
    const taken = choosing();
    over = 0;
    dropping(false);
    if (taken) void chosen(event.dataTransfer?.files[0]);
  };
  /** @param {ClipboardEvent} event */
  const onPaste = event => {
    if (!choosing()) return;
    const file = [...(event.clipboardData?.files ?? [])].find(each => each.type.startsWith('image/'));
    if (!file) return;
    event.preventDefault();
    void chosen(file);
  };

  document.addEventListener('dragenter', onDragEnter);
  document.addEventListener('dragleave', onDragLeave);
  document.addEventListener('dragover', onDragOver);
  document.addEventListener('drop', onDrop);
  document.addEventListener('paste', onPaste);
  stage.addEventListener('click', onClick);
  stage.addEventListener('focusin', onFocus);
  stage.addEventListener('focusout', onBlur);
  stage.addEventListener('pointermove', onMove);
  stage.addEventListener('pointerover', onOver);
  stage.addEventListener('pointerdown', onDown);
  stage.addEventListener('scroll', onScroll, true);
  stage.addEventListener('input', onInput);
  document.addEventListener('keydown', onKey);
  draw({ fresh: true });

  return {
    update() {
      const at = options.position();
      if (!options.acting()) {
        touched.clear();
        if (at !== listAt) {
          listAt = at;
          stale();
        }
      }
      if (idNow() !== S.shown) {
        calm();
        return draw({ fresh: true });
      }
      const card = cardFor(idNow());
      if (card && card.maybe !== maybeOf(card)) return draw();
      const head = stage.querySelector('.pp-panel__top');
      if (head) head.outerHTML = panelHead({ mode, count: countNow() });
      applyGeometry(stage);
      readAhead();
    },
    resume() {
      stale();
      draw();
    },
    stop() {
      stopped = true;
      unmove();
      fitting.disconnect();
      document.removeEventListener('dragenter', onDragEnter);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('drop', onDrop);
      document.removeEventListener('paste', onPaste);
      document.removeEventListener('keydown', onKey);
      stage.removeEventListener('click', onClick);
      stage.removeEventListener('focusin', onFocus);
      stage.removeEventListener('focusout', onBlur);
      stage.removeEventListener('pointermove', onMove);
      stage.removeEventListener('pointerover', onOver);
      stage.removeEventListener('pointerdown', onDown);
      stage.removeEventListener('scroll', onScroll, true);
      stage.removeEventListener('input', onInput);
      reading(stage, false);
      stage.classList.remove('ck-arrive', 'is-choosing');
      stage.innerHTML = '';
    },
  };
}
