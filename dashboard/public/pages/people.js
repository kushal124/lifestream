// @ts-check
/** @import { Mount } from '../ui/route.js' */
/** @import { Group, People, Person as PersonPage, Row } from '../pages.js' */
/** @import { Seg, Tidy } from '../ui/people/list.js' */
/** @import { Deck, Unread } from '../lib/faces.js' */
/** @import { PhotoPages } from '../lib/photo-pages.js' */
/** @import { PhotoFace } from '../ui/people/words.js' */
import {
  actUntilAnswered, fetchConnectors, fetchFaces, fetchFacesLikely, fetchPage, fetchPersonPhotos,
} from '../lib/api.js';
import { readHost } from '../lib/host.js';
import { actSaid, pageReach, requestState, SAVING, wordsOr } from '../lib/reach.js';
import { ahead, restOn } from '../lib/ahead.js';
import { heldProducts } from '../lib/held.js';
import { pageMoved, readMoves } from '../lib/pages.js';
import { applyGeometry } from '../ui/geometry.js';
import { installMomentPanel } from '../ui/panel.js';
import {
  dialogHold, installCardGrid, installFilterMenus, noneLine, openPhotoPages, pageLack, reading, readingAgain, searchWaiting,
  waitLine,
  watchPictures,
} from '../ui/kit/index.js';
import { put } from '../ui/flows/frame.js';
import { acceptAll, businessesDialog } from '../ui/people/businesses.js';
import { atOrPast, onHomeChange } from '../ui/live.js';
import {
  facesTool, findIn, flatRows, groupRow, groupsView, listBar, listReading, listViews, mostRows, pageBar, personRow, ROWS_SHOWN,
  sectionRows, tidyCard, youCardOf,
} from '../ui/people/list.js';
import {
  groupPage, groupPageReading, installRhythm, nobodyThere, nobodyYet, pageFailed, personPage, personPageReading,
  photoHash, savedLine, talkHead, yourPage,
} from '../ui/people/person.js';
import { GROUP_WORDS } from '../ui/people/words.js';
import { readingWords } from '../lib/faces.js';
import { photoPages } from '../lib/photo-pages.js';
import { today as todayOf } from '../lib/home-clock.js';
import { count } from '../lib/words.js';
import { mountFaces } from './faces.js';
import { mountOrganise } from './organise.js';
import { settledReads } from '../ui/settled.js';

/** @typedef {{ state: 'reading' } | { state: 'failed', message: string } | { state: 'gone' } | { state: 'read', value: PersonPage | Group }} PageRead */
/** @typedef {{ id: string, page: PageRead, photos: PhotoPages<PhotoFace> | null, asked: number }} Open */
/** @typedef {import('../lib/api.js').OwnerAnswer} OwnerAnswer */
/** @typedef {{ ids: Set<string>, said: unknown }} Sending */

const STILL_SAVING = Object.freeze(Object.assign(new Error(SAVING), { code: 'OUTCOME_UNKNOWN', again: true, began: true }));

/** @param {Record<string, unknown>} action */
const actedOn = action => new Set(typeof action.id === 'string' ? [action.id] : typeof action.chat === 'string' ? [`chat:${action.chat}`] : []);


/** @param {People} read */
const rowsOf = read => new Map([...read.you ? [read.you] : [], ...read.sections.flatMap(section => section.rows), ...read.ai]
  .map(row => [row.id, row]));

/**
 * @param {string} key
 * @param {import('../lib/api.js').Settled} [asked]
 * @returns {Promise<PersonPage | Group>}
 */
const pageOf = (key, asked = {}) => key.startsWith('chat:') ? fetchPage('group', { chat: key.slice(5) }, asked)
  : fetchPage('person', { id: key }, asked);

/** @param {unknown} error */
const isGone = error => /** @type {{ status?: number }} */ (error).status === 404;

const DECK_POLL_MS = 1000;


const NOT_HERE = 'Your people aren’t on this Mac yet.';
const UNREAD = 'Your people couldn’t be read.';

/** @param {unknown} error */
const messageOf = error => wordsOr(error, 'This couldn’t be read.');
/** @param {unknown} error */
const actFailed = error => actSaid(requestState(error));


/** @type {Mount} */
export const mountPeople = (container, context) => {
  const hosted = document.documentElement.classList.contains('hosted');
  /** @type {People | null} */
  let answer = null;
  /** @type {Sending[]} */
  let sending = [];
  /** @type {{ act: string, ids: Set<string> } | null} */
  let newest = null;
  /** @type {Map<string, Row>} */
  let rowsById = new Map();
  /** @type {Map<string, string>} */
  const answeredAs = new Map();
  /** @param {People} read */
  function relist(read) {
    answer = read;
    rowsById = rowsOf(read);
  }
  /** @type {import('../lib/reach.js').Drawn | null} */
  let failed = null;
  const lacking = () => failed?.kind === 'lack' ? failed : null;
  /** @param {string} markup */
  const readingAs = markup => failed && failed.kind !== 'lack' ? markup.replace(waitLine(), readingAgain(failed, NOT_HERE)) : markup;
  const lackLine = () => {
    const lack = lacking();
    return lack ? pageLack(lack.words ?? UNREAD, lack.retry ? { retry: { 'data-people-retry': 'list' } } : {}) : '';
  };
  /** @type {ReturnType<typeof setTimeout> | null} */
  let waiting = null;
  /** @type {{ read: Deck | Unread | null } | null} */
  let deck = null;
  /** @type {import('../types.js').ConnectorReport | null} */
  let facesRow = null;
  /** @type {import('../types.js').StreamsReport | null} */
  let streams = null;
  let facesRowRead = false;
  /** @type {Map<string, Open>} */
  const opened = new Map();
  let typed = '';
  let shown = ROWS_SHOWN;
  let listScroll = 0;
  /** @type {Open | null} */
  let open = null;
  /** @type {ReturnType<typeof mountFaces> | null} */
  let leaveFaces = null;
  /** @type {string | null} */
  let facesOn = null;
  let barKey = '';
  /** @type {{ id: string, first: boolean } | null} */
  let editing = null;
  /** @type {{ ids: Set<string>, said: string, act: string | null, undoing: boolean, failure: import('../ui/people/person.js').ActFailed | null } | null} */
  let saved = null;
  const organising = { done: new Set(), skipped: new Set(), from: '' };
  /** @type {{ key: string, panel: ReturnType<typeof mountOrganise> } | null} */
  let sitting = null;
  let quietOpen = false;
  /** @type {Set<string>} */
  const allGroups = new Set();
  /** @type {Map<string, { busy: boolean, failure: import('../ui/people/person.js').ActFailed | null, value: string }>} */
  const wording = new Map();
  const accept = acceptAll({ act: action => act(action), changed: () => draw() });

  container.innerHTML = '<div class="ck-page pp">'
    + '<header class="ck-page__bar" data-window-drag data-part="bar"></header>'
    + '<div class="ck-under"><div class="ck-page__scroll" data-part="scroll"></div>'
    + '<aside aria-label="Moment" data-part="panel"></aside></div>'
    + '<div class="pp-stage" data-part="stage" hidden></div><div data-part="dialog"></div></div>';
  const root = /** @type {HTMLElement} */ (container.querySelector('.pp'));
  const reach = pageReach(readHost(window), root);
  const listReads = settledReads(container);
  const personReads = settledReads(container);
  /** @param {import('../lib/reach.js').Retry | null} [retry] */
  const readAgain = (retry = null) => void readList(retry);
  const bar = /** @type {HTMLElement} */ (root.querySelector('[data-part="bar"]'));
  const scroll = /** @type {HTMLElement} */ (root.querySelector('[data-part="scroll"]'));
  const stage = /** @type {HTMLElement} */ (root.querySelector('[data-part="stage"]'));
  const under = /** @type {HTMLElement} */ (root.querySelector('.ck-under'));
  const layer = /** @type {HTMLElement} */ (root.querySelector('[data-part="dialog"]'));
  const holdDialog = dialogHold(() => layer, () => [bar, under, stage]);
  installCardGrid(root);
  installFilterMenus(root, (menu, value) => {
    if (menu.dataset.peopleWord !== undefined) sayWord(menu.dataset.peopleWord, value);
    if (menu.dataset.peoplePhotosSize !== undefined) open?.photos?.resize(Number(value));
  });
  installRhythm(scroll);
  watchPictures(root);
  /** @type {HTMLElement | null} */
  let opener = null;
  const panel = installMomentPanel(/** @type {HTMLElement} */ (root.querySelector('[data-part="panel"]')), {
    go: (view, patch) => context.go(view, patch),
    closed: () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
      opener = null;
    },
  });

  const focus = () => context.route.focus;
  const seg = () => /** @type {Seg} */ (['ai', 'groups'].includes(context.route.seg) ? context.route.seg : '');

  /**
   * @param {string} key
   * @param {string} markup
   */
  function putBar(key, markup) {
    if (barKey === key) return;
    barKey = key;
    bar.innerHTML = markup;
  }

  function organiseCounts() {
    const organise = answer?.organise ?? { queue: [], organised: 0, often: 0 };
    const queued = new Set(organise.queue);
    const done = [...organising.done].filter(id => queued.has(id)).length;
    return { organised: organise.organised + done, often: Math.max(0, organise.often - done), queue: queued.size - done };
  }

  /** @returns {Tidy} */
  function tidyOf() {
    const read = facesTurnedOn() ? deck?.read ?? null : null;
    const faces = read?.ready ? { names: read.cards.length, people: read.maybe?.people ?? 0 } : null;
    return {
      organise: answer?.organise.line ?? null,
      businesses: answer?.businesses?.line ?? null,
      faces: faces && (faces.names || faces.people) ? faces : null,
      facesLine: read && !read.ready && read.building && !read.error ? readingWords(read) : '',
      askFaces: facesRow !== null && !facesRow.set_up,
      fresh: (answer?.new ?? []).flatMap(({ id, line }) => {
        const row = rowsById.get(id);
        return row ? [{ row, line }] : [];
      }),
    };
  }

  function drawList() {
    context.title('People');
    const faces = facesRow?.set_up === true;
    putBar('list', listBar(typed, hosted, faces));
    const slot = /** @type {HTMLElement} */ (bar.querySelector('[data-people-faces]'));
    if (slot.childElementCount !== Number(faces)) slot.innerHTML = facesTool(faces);
    searchWaiting(/** @type {HTMLElement} */ (bar.querySelector('[data-people-find]')), answer === null);
    if (answer === null) {
      scroll.innerHTML = readingAs(listReading(seg(), lackLine()));
      return;
    }
    const today = todayOf();
    const words = typed.trim();
    const view = seg();
    const rows = answer.sections.flatMap(section => section.rows);
    const { ai, groups } = answer;
    const empty = !rows.length && !ai.length && !groups.yours.length && !groups.quiet.length;
    /** @type {string} */
    let body;
    if (words) {
      const people = findIn([...answer.you ? [answer.you] : [], ...rows, ...ai], words);
      const groupsFound = findIn([...groups.yours, ...groups.quiet], words);
      body = (people.length ? flatRows(`${count(people.length)} found`, people, shown, row => personRow(row, today)) : '')
        + (groupsFound.length ? flatRows('Groups', groupsFound, shown, chat => groupRow(chat, today)) : '')
        || noneLine(`No one called “${words}”.`);
    } else if (empty) {
      body = nobodyYet(streams);
    } else if (view === 'groups') {
      body = groupsView(groups, { shown, today, open: quietOpen });
    } else if (view === 'ai') {
      body = flatRows('AI', ai, shown, row => personRow(row, today));
    } else {
      const most = answer.most.flatMap(({ id, line }) => {
        const row = rowsById.get(id);
        return row ? [{ row, line }] : [];
      });
      body = mostRows(most) + sectionRows(answer.sections, shown, today);
    }
    const views = words || empty ? '' : listViews(view, { people: rows.length, ai: ai.length, groups: groups.yours.length });
    scroll.innerHTML = '<div class="ck-page__body">'
      + `<div class="ck-page__main pp-main pp-cards">${views}${body}</div>`
      + '<aside class="ck-page__side ck-page__side--top pp-side" aria-label="You and what is left to tidy"'
      + ` data-read="${deck ? 'ready' : 'reading'}">${deck ? youCardOf(answer.you) + tidyCard(tidyOf()) : ''}</aside>`
      + '</div>';
  }

  /**
   * @param {string} id
   * @param {PersonPage} page
   */
  const isYou = (id, page) => answer?.you?.id === id || page.edit.record?.me === true;


  function drawOne() {
    const id = focus();
    const chat = id.startsWith('chat:');
    if (!chat && editing?.id === id) return showStage(`edit ${id}`);
    if (open?.id !== id) void readOne(id);
    const mine = /** @type {Open} */ (open);
    const read = mine.page;
    if (read.state === 'reading') {
      putBar('wait', pageBar(''));
      scroll.innerHTML = chat ? groupPageReading() : personPageReading(todayOf());
      return;
    }
    if (read.state === 'gone') {
      context.title('People');
      putBar(`gone ${id}`, pageBar(''));
      scroll.innerHTML = nobodyThere();
      return;
    }
    if (read.state === 'failed') {
      putBar(`failed ${id}`, pageBar(''));
      scroll.innerHTML = pageFailed(read.message, chat);
      return;
    }
    const today = todayOf();
    const page = read.value;
    if ('writers' in page) {
      context.title(page.head.title);
      putBar(`one ${id} ${page.head.title}`, pageBar(page.head.title));
      scroll.innerHTML = groupPage(id.slice(5), page, today, wording.get(id.slice(5)));
      return;
    }
    context.title(page.head.name);
    putBar(`one ${id} ${page.head.name}`, pageBar(page.head.name));
    const line = savedLine(saved && { ...saved, act: undoable(saved.act) ? saved.act : null });
    const photos = /** @type {PhotoPages<PhotoFace>} */ (mine.photos).view();
    put(scroll, isYou(id, page) ? yourPage({ page, photos, saved: line })
      : personPage({ page, photos, today, groups: allGroups.has(id), saved: line }));
    applyGeometry(scroll);
  }

  function drawFaces() {
    const only = context.route.on || null;
    const back = only ? { label: rowsById.get(only)?.name.split(' ')[0] || 'Back', id: only } : undefined;
    context.title('Faces');
    putBar(`faces ${only ?? ''}`, pageBar('', '', back));
    if (leaveFaces && facesOn === only) return;
    leaveFaces?.stop();
    facesOn = only;
    scroll.innerHTML = '<div class="pp-faces"></div>';
    leaveFaces = mountFaces(/** @type {HTMLElement} */ (scroll.querySelector('.pp-faces')), {
      leave: () => choose(only ?? ''), tools: bar.querySelector('.ck-page__tools'), only,
      deck: deckHanded ? null : deck?.read,
    });
    deckHanded = true;
  }

  function queueNow() {
    const left = (/** @type {string} */ id) => !organising.done.has(id) && !organising.skipped.has(id);
    const queue = (answer?.organise.queue ?? []).filter(left);
    const from = organising.from;
    const someone = (/** @type {string} */ id) => queue.includes(id) || rowsById.has(id);
    const known = someone(from) || someone(answeredAs.get(from) ?? '');
    return from && left(from) && known ? [from, ...queue.filter(id => id !== from)] : queue;
  }

  function drawOrganise() {
    context.title('Organise your people');
    if (answer !== null) return showStage('organise');
    hideStage();
    putBar('organise', pageBar('Organise your people'));
    scroll.innerHTML = lacking() ? `<div class="ck-page__body">${lackLine()}</div>` : readingAs(listReading('', ''));
  }

  /** @param {string} key */
  function showStage(key) {
    const parked = stage.hidden && sitting?.key === key;
    stage.hidden = false;
    bar.hidden = true;
    under.hidden = true;
    if (sitting?.key === key) return parked ? sitting.panel.resume() : sitting.panel.update();
    sitting?.panel.stop();
    const edit = key !== 'organise' ? editing : null;
    sitting = { key, panel: mountOrganise(stage, {
      mode: edit ? 'edit' : 'organise', id: edit?.id, first: edit?.first ?? false, sitting: organising,
      queue: queueNow, counts: organiseCounts, position: () => answer?.position ?? '', you: () => answer?.you?.id ?? null,
      row: id => rowsById.get(id),
      faces: () => facesRowRead ? facesTurnedOn() : null,
      deck: () => deck?.read?.ready ? deck.read : null,
      page: id => /** @type {Promise<PersonPage>} */ (pageAhead.take(id)),
      likely: id => likelyAhead.take(id),
      photos: (id, after) => after === undefined ? photosAhead.take(id) : fetchPersonPhotos(id, { after }),
      findFaces: id => {
        if (panel.isOpen()) panel.close();
        context.set({ focus: 'faces', on: id }, true);
        draw();
      },
      act,
      acting: () => sending.length > 0,
      leave: answered => {
        if (!edit) return choose('');
        editing = null;
        if (answered?.saved) {
          saved = { ids: new Set([edit.id, ...(answered.id ? [answered.id] : [])]), ...answered.saved, undoing: false, failure: null };
        }
        const page = opened.get(edit.id)?.page;
        follow(edit.id, answered?.id ?? (page?.state === 'read' ? becameOf(page.value) : null));
        if (answered) void readOne(focus(), true);
        draw();
      },
      hidden: () => {
        editing = null;
        choose('');
      },
    }) };
  }

  function parkStage() {
    stage.hidden = true;
    bar.hidden = false;
    under.hidden = false;
  }

  function hideStage() {
    if (!sitting) return;
    sitting.panel.stop();
    sitting = null;
    stage.hidden = true;
    bar.hidden = false;
    under.hidden = false;
  }

  function draw() {
    const id = focus();
    const parked = id === 'faces' && editing !== null && context.route.on === editing.id;
    if (id !== 'faces' && leaveFaces) {
      leaveFaces.stop();
      leaveFaces = null;
    }
    if (editing && editing.id !== id && !parked) editing = null;
    if (saved && (editing || !saved.ids.has(id))) saved = null;
    if (id !== 'organise' && !editing) hideStage();
    if (parked) parkStage();
    if (id === 'faces') drawFaces();
    else if (id === 'organise') drawOrganise();
    else if (id) drawOne();
    else drawList();
    personReads.keep(open !== null && open.id === focus() ? open : null);
    reading(root, firstRead(), answer === null && !focus() ? 'Reading everyone you talk with'
      : 'Reading your last conversation');
    drawBusinesses();
  }


  const offeredNow = () => answer?.businesses?.offered ?? [];

  function drawBusinesses() {
    const view = answer ? accept.view(offeredNow()) : null;
    const markup = view ? businessesDialog(view) : '';
    if (layer.dataset.drawn === markup) return;
    put(layer, markup, { keep: '.ck-dialog' });
    layer.dataset.drawn = markup;
    holdDialog(() => /** @type {HTMLElement | null} */ (scroll.querySelector('[data-people-businesses]')));
  }

  function closeBusinesses() {
    if (accept.close()) draw();
  }

  function firstRead() {
    const id = focus();
    if (!id || id === 'faces' || id === 'organise') return answer === null && !lacking();
    return open?.id === id && open.page.state === 'reading';
  }

  /** @param {string} id */
  function openOf(id) {
    /** @type {Open} */
    const mine = opened.get(id) ?? {
      id, page: { state: 'reading' }, asked: 0,
      photos: id.startsWith('chat:') ? null : photoPages((at, limit) => fetchPersonPhotos(mine.id, { at, limit }), () => {
        if (open === mine) draw();
      }),
    };
    opened.set(id, mine);
    open = mine;
    return mine;
  }

  /** @param {string} id */
  function ask(id) {
    const mine = openOf(id);
    const asked = ++mine.asked;
    return { mine, latest: () => mine.asked === asked && opened.get(mine.id) === mine };
  }

  const pageAhead = ahead(pageOf);
  const likelyAhead = ahead(fetchFacesLikely);
  const photosAhead = ahead((/** @type {string} */ id) => fetchPersonPhotos(id, {}));

  /**
   * @param {string} id
   * @param {boolean} [settle]
   * @returns {Promise<void>}
   */
  function readOne(id, settle = false) {
    const { mine, latest } = ask(id);
    const shown = () => latest() && focus() === mine.id;
    if (settle) personReads.want(mine);
    mine.photos?.again();
    return personReads.read(asked => asked.settled ? pageOf(mine.id, asked) : pageAhead.take(mine.id), {
      key: mine,
      counts: read => read.counting,
      land: (read, settled) => {
        if (!latest()) return;
        if (mine.page.state === 'read' && !atOrPast(read.position, mine.page.value.position)) return;
        if (editing?.id !== mine.id) follow(mine.id, becameOf(read));
        mine.page = { state: 'read', value: read };
        if (settled && !read.counting) mine.photos?.again();
        if (shown()) draw();
      },
    }).first.catch(error => {
      if (!latest()) return;
      if (isGone(error)) mine.page = { state: 'gone' };
      else if (mine.page.state !== 'read') mine.page = { state: 'failed', message: messageOf(error) };
      if (shown()) draw();
    });
  }


  /** @param {string} id */
  function choose(id) {
    if (id === focus()) return;
    const deck = focus() === 'faces' ? leaveFaces : null;
    if (deck) {
      void deck.saved().then(left => {
        if (left && leaveFaces === deck && focus() === 'faces') go(id);
      });
      return;
    }
    go(id);
  }

  /** @param {string} id */
  function go(id) {
    if (panel.isOpen()) panel.close();
    if (!focus()) listScroll = scroll.scrollTop;
    context.set({ focus: id, on: '' }, true);
    draw();
    scroll.scrollTop = id ? 0 : listScroll;
  }

  /** @param {string | null} act */
  const undoable = act => act !== null && act === newest?.act && sending.length === 0;

  /**
   * @param {Record<string, unknown>} action
   * @param {{ waiting?: (error: unknown) => void }} [given]
   * @returns {Promise<OwnerAnswer>}
   */
  function act(action, { waiting = () => {} } = {}) {
    const undone = action.kind === 'undo' && newest !== null && newest.act === action.act ? newest : null;
    const ids = undone ? new Set(undone.ids) : actedOn(action);
    const busy = sending.find(entry => [...ids].some(id => entry.ids.has(id)));
    if (busy) return Promise.reject(busy.said ?? STILL_SAVING);
    /** @type {Sending} */
    const entry = { ids, said: null };
    sending.push(entry);
    return actUntilAnswered({ ...action, of: 'people' }, { waiting: error => {
      entry.said = error;
      waiting(error);
    } }).then(async answered => {
      if (answered.id) ids.add(answered.id);
      if (answered.id && typeof action.id === 'string' && action.id !== answered.id) answeredAs.set(action.id, answered.id);
      newest = answered.act ? { act: answered.act, ids } : null;
      pageAhead.forget();
      await readPeople(true);
      return answered;
    }).finally(() => {
      sending = sending.filter(each => each !== entry);
    });
  }

  async function undoSaved() {
    const was = saved;
    if (!was?.act || was.undoing || !undoable(was.act)) return;
    Object.assign(was, { undoing: true, failure: null });
    draw();
    try {
      await act({ kind: 'undo', act: was.act }, { waiting: error => {
        was.failure = actFailed(error);
        draw();
      } });
      if (saved === was) saved = null;
    } catch (error) {
      was.failure = actFailed(error);
    } finally {
      was.undoing = false;
      draw();
    }
  }

  /** @param {boolean} [settle] */
  async function readPeople(settle = false) {
    if (settle) listReads.want();
    const id = focus();
    await Promise.all([readList(), id && id !== 'faces' && id !== 'organise' ? readOne(id, settle) : null]);
  }

  /** @param {PersonPage | Group} read */
  const becameOf = read => 'became' in read ? read.became : null;

  /**
   * @param {string} before
   * @param {string | null} after
   */
  function follow(before, after) {
    if (!after || after === before) return;
    const reads = opened.get(before);
    if (reads) {
      opened.delete(before);
      reads.id = after;
      opened.set(after, reads);
    }
    if (focus() === before) {
      context.set({ focus: after });
      open = opened.get(after) ?? null;
    }
  }

  let listAsked = 0;
  let deckAsked = 0;
  let deckHanded = false;

  /** @param {import('../lib/reach.js').Retry | null} [retry] */
  async function readList(retry = null) {
    const mine = ++listAsked;
    const begun = reach.begin(retry);
    if (waiting !== null) clearTimeout(waiting);
    waiting = null;
    const drawn = () => {
      if (focus() !== 'faces') draw();
      else reading(root, firstRead());
    };
    try {
      await listReads.read(async asked => {
        const [read] = await Promise.all([fetchPage('people', {}, asked), heldProducts.get().catch(() => null)]);
        return read;
      }, {
        counts: read => read.counting,
        land: (read, settled) => {
          if (mine !== listAsked) return;
          if (answer && !atOrPast(read.position, answer.position)) return;
          relist(read);
          failed = null;
          const queued = new Set(read.organise.queue);
          for (const id of [...organising.done]) if (!queued.has(id)) organising.done.delete(id);
          for (const id of [...organising.skipped]) if (!queued.has(id)) organising.skipped.delete(id);
          drawn();
        },
      }).first;
    } catch (error) {
      if (mine !== listAsked) return;
      failed = reach.failed(error, begun, readAgain);
      if (failed.kind === 'wait') waiting = setTimeout(() => readAgain(), Math.max(0, failed.until - Date.now()));
      drawn();
    }
  }

  async function readDeck() {
    const mine = ++deckAsked;
    /** @type {{ read: Deck | Unread | null }} */
    let read;
    try {
      read = { read: await fetchFaces() };
    } catch {
      read = { read: null };
    }
    if (mine !== deckAsked || !container.isConnected) return;
    deck = read;
    deckHanded = false;
    if (read.read && !read.read.ready && read.read.building) setTimeout(() => void readDeck(), DECK_POLL_MS);
    if (!focus()) draw();
    else sitting?.panel.update();
  }

  const facesTurnedOn = () => facesRow?.set_up === true && facesRow.on;

  async function readFacesRow() {
    try {
      streams = await fetchConnectors();
      facesRow = streams.connectors.find(each => each.id === 'faces') ?? null;
    } catch {
      facesRow = null;
    }
    facesRowRead = true;
    if (!focus()) draw();
    else sitting?.panel.update();
  }

  /**
   * @param {string} key
   * @param {string} value
   */
  function sayWord(key, value) {
    const word = GROUP_WORDS.find(each => each.value === value);
    const page = open?.id === `chat:${key}` && open.page.state === 'read' ? open.page.value : null;
    if (!word || !page || !('writers' in page) || wording.get(key)?.busy || page.head.word === word.value) return;
    wording.set(key, { busy: true, failure: null, value });
    draw();
    void act({ kind: 'group', chat: key, quiet: word.quiet }, { waiting: error => {
      wording.set(key, { busy: true, failure: actFailed(error), value });
      if (focus() === `chat:${key}`) draw();
    } })
      .then(() => {
        wording.delete(key);
      }, error => {
        wording.set(key, { busy: false, failure: actFailed(error), value });
      })
      .finally(() => {
        if (focus() === `chat:${key}`) draw();
      });
  }

  /** @type {Record<string, (control: HTMLElement) => void>} */
  const actions = {
    person: control => choose(control.dataset.person ?? ''),
    peopleQuiet: () => {
      quietOpen = true;
      draw();
    },
    peopleGroups: () => {
      allGroups.add(focus());
      draw();
    },
    peopleSeg: control => {
      context.set({ seg: control.dataset.peopleSeg ?? '' });
      shown = ROWS_SHOWN;
      draw();
    },
    peopleMore: () => {
      shown += ROWS_SHOWN * 2;
      const at = scroll.scrollTop;
      draw();
      scroll.scrollTop = at;
    },
    peopleOpen: control => {
      opener = control;
      const page = open?.id === focus() && open.page.state === 'read' ? open.page.value : null;
      const head = page?.talk ? talkHead(page.talk, todayOf(), 'writers' in page ? page.head.title : page.head.name) : undefined;
      panel.show([{ on: String(control.dataset.peopleOpen), focus: control.dataset.peopleFocus ?? '', head }], 0);
    },
    peopleDay: control => {
      if (control.dataset.peopleDay) context.go('days', { on: control.dataset.peopleDay });
    },
    peopleConnect: control => context.dialog(control.dataset.peopleConnect ?? ''),
    peopleBusinesses: () => {
      accept.open(offeredNow());
      draw();
    },
    peopleBusiness: control => {
      accept.toggle(offeredNow(), control.dataset.peopleBusiness ?? '');
      drawBusinesses();
    },
    peopleBusinessesMark: () => void accept.mark(offeredNow()),
    peopleBusinessesUndo: () => void accept.undo(),
    peopleBusinessesAgain: () => void accept.again(offeredNow()),
    peopleBusinessesClose: () => closeBusinesses(),
    peopleOrganise: control => {
      organising.from = control.dataset.peopleOrganise ?? '';
      organising.skipped.delete(organising.from);
      choose('organise');
    },
    peoplePhoto: control => {
      if (!open?.photos) return;
      openPhotoPages(open.photos, Number(control.dataset.peoplePhoto), photoHash,
        at => /** @type {HTMLElement} */ (scroll.querySelector(`[data-people-photo="${at}"]`) ?? control).focus({ preventScroll: true }));
    },
    peoplePhotos: control => {
      const by = control.dataset.peoplePhotos;
      if (!open?.photos) return;
      if (by === 'again') return open.photos.again();
      open.photos.go(open.photos.view().page + Number(by));
      /** @type {HTMLElement | null} */ (scroll.querySelector(`[data-people-photos="${by}"]:not(:disabled)`)
        ?? scroll.querySelector('[data-people-photos]:not(:disabled)'))?.focus({ preventScroll: true });
    },
    peopleEdit: control => {
      editing = { id: focus(), first: control.dataset.peopleEdit === 'first' };
      draw();
    },
    peopleSavedUndo: () => void undoSaved(),
    peopleWordAgain: control => sayWord(control.dataset.peopleWordAgain ?? '', control.dataset.value ?? ''),
    peopleRetry: control => {
      const what = control.dataset.peopleRetry;
      if (what === 'list') {
        failed = null;
        draw();
        void readList();
      } else {
        opened.delete(focus());
        open = null;
        draw();
      }
    },
  };

  const ROUTED = Object.keys(actions).map(name => `[data-${name.replace(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`)}]`).join(',');

  restOn(root, '[data-person]', on => {
    const organise = on.dataset.person === 'organise';
    const id = organise ? answer?.organise.queue[0] : on.dataset.person;
    if (!id || id === 'faces') return;
    if (!organise) {
      pageAhead.begin(id);
      return;
    }
    photosAhead.begin(id);
    if (facesRowRead && facesTurnedOn()) likelyAhead.begin(id);
    pageAhead.begin(id);
  });
  root.addEventListener('click', event => {
    const target = /** @type {Element} */ (event.target);
    if (stage.contains(target)) return;
    if (target.matches('[data-scrim]') && layer.contains(target)) return closeBusinesses();
    const control = /** @type {HTMLElement | null} */ (target.closest(ROUTED));
    if (!control || !root.contains(control) || (control instanceof HTMLButtonElement && control.disabled)) return;
    const name = Object.keys(actions).find(key => control.dataset[key] !== undefined);
    if (name) actions[name](control);
  });

  root.addEventListener('input', event => {
    const input = /** @type {HTMLInputElement} */ (event.target);
    if (!input.matches('[data-people-find]')) return;
    typed = input.value;
    shown = ROWS_SHOWN;
    draw();
  });


  /** @param {KeyboardEvent} event */
  const onKey = event => {
    if (event.defaultPrevented || container.hidden || sitting) return;
    if (accept.isOpen()) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeBusinesses();
      }
      return;
    }
    if (event.key === 'Escape' && panel.isOpen()) {
      event.preventDefault();
      panel.close();
      return;
    }
    const active = document.activeElement;
    const typing = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
    if (focus()) return;
    const field = /** @type {HTMLInputElement | null} */ (bar.querySelector('[data-people-find]'));
    if (!field) return;
    if (active === field) {
      if (event.key === 'Escape') field.blur();
      return;
    }
    if (typing) return;
    if ((hosted && event.metaKey && event.key.toLowerCase() === 'f') || (!event.metaKey && event.key === '/')) {
      event.preventDefault();
      field.focus();
      field.select();
    }
  };
  document.addEventListener('keydown', onKey);

  onHomeChange(change => {
    const moved = pageMoved('people', change, answer?.position);
    if (change.reset) {
      answer = null;
      rowsById = new Map();
      opened.clear();
      open = null;
      draw();
    }
    if (moved) void readList();
    const id = focus();
    const page = open?.id === id && open.page.state === 'read' ? open.page.value : null;
    if (open?.id === id && id !== 'faces' && id !== 'organise'
      && pageMoved(id.startsWith('chat:') ? 'group' : 'person', change, page?.position)) void readOne(id);
    const faced = [...change.imports].some(source => source.startsWith('faces:') || source.startsWith('people:'));
    if (change.reset || faced || moved) void readDeck();
    if (change.reset || faced || change.streams || [...change.imports].some(source => source.startsWith('cameras:'))) {
      void readFacesRow();
    }
  }, container);

  void readMoves();
  draw();
  void readList();
  void readDeck();
  void readFacesRow();

  return {
    update() {
      if (panel.isOpen()) panel.close();
      draw();
    },
  };
};
