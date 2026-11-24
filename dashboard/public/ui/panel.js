// @ts-check
/** @import { DayMoment, Moment as MomentAnswer } from '../pages.js' */
/** @import { PlacesAnswer } from './days/viewers.js' */
import { fetchLifeConversation, fetchLifePlaced, fetchLifeRead, fetchLifeRecord, fetchPage } from '../lib/api.js';
import { everyone, heldPeople, heldPlaces } from '../lib/held.js';
import { shortDay } from '../lib/words.js';
import { esc } from '../lib/html.js';
import { wordsOr } from '../lib/reach.js';
import {
  ARRIVES, button, gallery, inPlaceLine, iconButton, inspectorReading, installGalleries, installThread, reading, stepper, stopVoice, voiceOwner,
} from './kit/index.js';
import { chipsFor, inspectorOf, installInspector, outButton, outRecord } from './days/inspector.js';
import { fillViewer } from './days/viewers.js';

/** @typedef {{ on: string, focus: string, whole?: boolean, marks?: string[], head?: { icon: string, title: string, meta: string }, facts?: { token: string, asked: string } }} Moment */

/**
 * @typedef {object} MomentParts
 * @property {(view: string, patch: Record<string, string>) => void} go
 * @property {() => void} closed
 * @property {(on: string, focus: string, id: string) => void} [found]
 * @property {(sentence: string) => void} [again]
 */

/**
 * @param {HTMLElement} panel
 * @param {MomentParts} parts
 */
export const installMomentPanel = (panel, parts) => momentPanel(panel, parts, false);

/**
 * @param {HTMLElement} place
 * @param {Omit<MomentParts, 'closed'>} parts
 */
export const momentPreview = (place, parts) => momentPanel(place, { ...parts, closed: () => undefined }, true);

/**
 * @param {HTMLElement} panel
 * @param {MomentParts} parts
 * @param {boolean} docked
 */
function momentPanel(panel, { go, closed, found: told = () => undefined, again }, docked) {
  /** @type {Moment[]} */
  let moments = [];
  let at = 0;
  let open = false;
  let openDay = true;
  /** @type {string[]} */
  let terms = [];
  /** @type {number | null} */
  let only = null;
  let fresh = false;
  let generation = 0;
  let asking = 0;
  /** @type {{ day: string, moment: DayMoment, opened: Parameters<typeof chipsFor>[1] } | null} */
  let shown = null;
  /** @type {Map<string, string>} */
  let faces = new Map();
  /** @type {Promise<void> | null} */
  let facesRead = null;
  let drawn = '';
  /** @type {Promise<PlacesAnswer> | null} */
  let places = null;
  let pressedOutside = false;
  let opened = false;
  const voice = voiceOwner('panel');

  panel.classList.add('ck-panel');
  panel.classList.toggle('ck-panel--docked', docked);
  panel.tabIndex = -1;
  panel.setAttribute('role', 'complementary');

  const readPlaces = () => {
    places ??= /** @type {Promise<PlacesAnswer>} */ (/** @type {unknown} */ (heldPlaces.get()));
    places.catch(() => {
      places = null;
    });
    return places;
  };

  installInspector(panel, key => shown && shown.moment.key === key ? shown.moment : null);
  installThread(panel);
  installGalleries(panel, holder => {
    if (holder.matches('[data-ck-gallery]') && shown) return shown.moment.pictures;
    return [...holder.querySelectorAll('.ck-msg__shot')].map(shot => ({ hash: /** @type {HTMLElement} */ (shot).dataset.ckHash ?? '',
      alt: shot.querySelector('img')?.alt ?? '' }));
  });

  function readFaces() {
    facesRead ??= heldPeople.get().then(answer => {
      const people = everyone(answer);
      faces = new Map(people.flatMap(person => person.photo ? [[person.id, 'crop' in person.photo ? person.photo.crop : person.photo.card]] : []));
      const chips = panel.querySelector('.ck-inspector__chips');
      if (chips && shown) chips.innerHTML = chipsFor(shown.moment, { ...shown.opened, faces });
    }, () => undefined);
  }

  const moment = () => moments[at];

  /** @param {Moment} asked */
  const readMoment = asked => /** @type {Promise<MomentAnswer>} */ (fetchPage('moment', {
    day: asked.on, focus: asked.focus, ...asked.whole ? { whole: '1' } : {}, ...asked.marks ? { marks: JSON.stringify(asked.marks) } : {},
  }));

  function tools() {
    const steps = moments.length > 1 ? stepper({
      label: 'Sources', text: `${at + 1} of ${moments.length}`,
      less: { label: 'Previous source', attrs: { 'data-panel-step': '-1' }, disabled: at === 0 },
      more: { label: 'Next source', attrs: { 'data-panel-step': '1' }, disabled: at === moments.length - 1 },
    }) : '';
    const opens = openDay && moment().on
      ? button('Open day', { variant: 'plain', size: 'sm', icon: 'days', attrs: { 'data-panel-open-day': '' }, className: 'is-end' })
      : '';
    return { tools: steps, end: opens };
  }

  /** @param {string} inner */
  const waiting = inner => {
    const { tools: lead, end } = tools();
    return '<div class="ck-panel__wait"><div class="ck-panel__wait-head">'
      + `<div class="ck-inspector__tools">${lead}${end}</div>`
      + iconButton('close', 'Close', { attrs: { 'data-d-close': '', title: 'Close  esc' } })
      + `</div>${inner}</div>`;
  };

  /** @param {string} markup */
  function put(markup) {
    drawn = markup;
    const focused = document.activeElement;
    const inside = focused instanceof HTMLElement && panel.contains(focused);
    const step = inside ? focused.dataset.panelStep : undefined;
    panel.innerHTML = markup;
    const body = panel.querySelector('.ck-inspector__body');
    const head = panel.querySelector('.ck-inspector__head');
    body?.addEventListener('scroll', () => head?.classList.toggle('is-scrolled', body.scrollTop > 0), { passive: true });
    if (!inside) return;
    const again = step ? /** @type {HTMLButtonElement | null} */ (panel.querySelector(`[data-panel-step="${step}"]`)) : null;
    if (again && !again.disabled) again.focus({ preventScroll: true });
    else panel.focus({ preventScroll: true });
  }

  /** @param {MomentAnswer} answer */
  function inspected(answer) {
    const found = answer.moment;
    if (!found) return null;
    told(answer.day, moment().focus, found.row);
    if (fresh) {
      fresh = false;
      only = found.letter;
    }
    const opened = { terms, only, faces };
    readFaces();
    return { moment: found, opened, markup: inspectorOf(answer.day, found, { ...opened, day: openDay, ...tools() }) };
  }

  function galleryPicture() {
    const holder = /** @type {HTMLElement | null} */ (panel.querySelector('[data-ck-gallery]'));
    if (!holder || !shown) return null;
    return shown.moment.pictures[Number(holder.dataset.ckGallery)]?.hash ?? null;
  }

  /** @param {string} hash */
  function galleryAt(hash) {
    const holder = panel.querySelector('[data-ck-gallery]');
    const pictures = shown ? shown.moment.pictures : [];
    const at = pictures.findIndex(picture => picture.hash === hash);
    if (holder && at > 0) holder.outerHTML = gallery(pictures, at);
  }

  /**
   * @param {MomentAnswer} answer
   * @param {boolean} [arriving]
   */
  function drawDay(answer, arriving = false) {
    reading(panel, false);
    if (answer.state === 'empty' || answer.state === 'rendering') {
      shown = null;
      put(waiting(`<p class="ck-panel__none mac-body">${shortDay(answer.day)} is not written yet.</p>`));
      return;
    }
    const drawing = inspected(answer);
    if (!drawing) {
      shown = null;
      put(waiting(`<p class="ck-panel__none mac-body">${shortDay(answer.day)} no longer holds it.</p>`));
      return;
    }
    const { moment: found, opened, markup } = drawing;
    const kept = shown?.moment.key === found.key ? galleryPicture() : null;
    shown = { day: answer.day, moment: found, opened };
    put(markup);
    if (kept) galleryAt(kept);
    if (arriving) {
      const known = moment().head ? '' : ', .ck-inspector__tile, .ck-inspector__names';
      for (const part of panel.querySelectorAll(`.ck-inspector__body, .ck-inspector__chips, .ck-source${known}`)) {
        part.classList.add(ARRIVES);
      }
    }
    fill(answer.day, found, opened);
  }

  /**
   * @param {string} day
   * @param {DayMoment} found
   * @param {import('./days/viewers.js').Opened} opened
   */
  function fill(day, found, opened) {
    void putOut(found, opened);
    void fillViewer(/** @type {HTMLElement} */ (panel.querySelector('.ck-inspector__body')), day, found,
      { places: readPlaces, placed: fetchLifePlaced, record: fetchLifeRecord, conversation: fetchLifeConversation,
        thread: (chat, on) => fetchPage('thread', { chat, day: on }) }, showing(), opened, voice);
  }

  /**
   * @param {DayMoment} found
   * @param {{ only?: number | null }} opened
   */
  async function putOut(found, opened) {
    const ref = outRecord(found, opened);
    if (!ref) return;
    const mine = generation;
    const page = await fetchLifeRecord(ref).then(record => /** @type {{ label: string, href: string } | null} */ (record.open ?? null), () => null);
    const holder = panel.querySelector('[data-d-out]');
    if (page && holder && open && mine === generation && shown?.moment === found) holder.outerHTML = outButton(page);
  }

  /**
   * @param {{ token: string, asked: string }} facts
   * @param {number} mine
   */
  async function drawFacts({ token, asked }, mine) {
    shown = null;
    const said = `<p class="ck-panel__none mac-headline">${esc(asked)}</p>`;
    put(waiting(said));
    reading(panel, true);
    try {
      const answer = await fetchLifeRead(token);
      if (!open || mine !== generation) return;
      if (answer.what !== 'row') {
        put(waiting(`${said}<p class="ck-panel__none mac-body">This count can’t be opened any more.</p>${again ? button('Ask again', { variant: 'plain', size: 'sm', attrs: { 'data-panel-again': asked } }) : ''}`));
        return;
      }
      const cell = (/** @type {unknown} */ value) => (value === null || typeof value === 'object' ? '' : String(value));
      const lines = answer.rows.map((/** @type {unknown[]} */ row) => row.slice(0, -1).map(cell).filter(Boolean).join(' · '));
      put(waiting(said + lines.map((/** @type {string} */ line) => `<p class="ck-panel__none mac-body">${esc(line)}</p>`).join('')));
    } catch (error) {
      if (!open || mine !== generation) return;
      put(waiting(said + inPlaceLine(wordsOr(error, 'This number could not be read.'), { retry: { 'data-panel-retry': '' } })));
    } finally {
      if (mine === generation) reading(panel, false);
    }
  }

  async function draw() {
    const mine = ++generation;
    const asked = moment();
    const { on, head, facts } = asked;
    if (facts) return drawFacts(facts, mine);
    if (!on) {
      shown = null;
      reading(panel, false);
      put(waiting(inPlaceLine('This has no day to open it on.')));
      return;
    }
    const ticket = ++asking;
    shown = null;
    const { tools: lead, end } = tools();
    put(inspectorReading({ head, tools: lead + end, close: { 'data-d-close': '', title: 'Close  esc' } }));
    reading(panel, true);
    try {
      const answer = await readMoment(asked);
      if (open && mine === generation && ticket === asking) drawDay(answer, true);
    } catch (error) {
      if (!open || mine !== generation || ticket !== asking) return;
      reading(panel, false);
      put(waiting(inPlaceLine(wordsOr(error, 'The day could not be read.'), { retry: { 'data-panel-retry': '' } })));
    }
  }

  async function redraw() {
    if (!open) return;
    const asked = moment();
    const { on, facts } = asked;
    if (fresh || facts || !on) return void draw();
    const mine = generation;
    const ticket = ++asking;
    /** @type {MomentAnswer} */
    let answer;
    try {
      answer = await readMoment(asked);
    } catch {
      if (open && mine === generation && ticket === asking) void draw();
      return;
    }
    if (!open || mine !== generation || ticket !== asking) return;
    const again = answer.moment ? inspected(answer) : null;
    ++generation;
    if (again?.markup === drawn) {
      shown = { day: answer.day, moment: again.moment, opened: again.opened };
      fill(answer.day, again.moment, again.opened);
      return;
    }
    drawDay(answer);
  }

  function showing() {
    const mine = generation;
    return () => open && mine === generation;
  }

  /** @param {EventTarget | null} target */
  const kept = target => target instanceof Element && (panel.contains(target) || !!target.closest('dialog, [role="dialog"]'));

  /** @param {PointerEvent} event */
  const onPress = event => {
    pressedOutside = !kept(event.target) && !(event.target instanceof Element && event.target.closest('.ck-cites'));
    opened = false;
  };
  /** @param {MouseEvent} event */
  const onClick = event => {
    const outside = pressedOutside && !opened && !!window.getSelection()?.isCollapsed;
    pressedOutside = false;
    if (!panel.isConnected) listen(false);
    else if (panel.closest('[hidden]')) return;
    else if (outside && event.button === 0) close();
  };
  /** @param {KeyboardEvent} event */
  const onKey = event => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (!panel.isConnected) return listen(false);
    if (panel.closest('[hidden]')) return;
    if (kept(event.target) && !panel.contains(/** @type {Node} */ (event.target))) return;
    event.preventDefault();
    close();
  };
  /** @param {boolean} on */
  function listen(on) {
    if (on) {
      document.addEventListener('pointerdown', onPress, true);
      document.addEventListener('click', onClick);
      document.addEventListener('keydown', onKey);
    } else {
      document.removeEventListener('pointerdown', onPress, true);
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
    }
  }

  function close() {
    if (!open) return;
    open = false;
    listen(false);
    generation += 1;
    shown = null;
    reading(panel, false);
    for (const media of panel.querySelectorAll('video')) /** @type {HTMLVideoElement} */ (media).pause();
    stopVoice(voice);
    panel.classList.remove('is-open');
    panel.inert = !docked;
    if (docked) panel.replaceChildren();
    closed();
  }

  /** @type {[string, (element: HTMLElement) => void][]} */
  const actions = [
    ['data-d-close', () => close()],
    ['data-panel-step', element => {
      at = Math.max(0, Math.min(moments.length - 1, at + Number(element.dataset.panelStep)));
      stopVoice(voice);
      only = null;
      fresh = true;
      void draw();
    }],
    ['data-panel-open-day', () => go('days', { on: moment().on, focus: moment().focus })],
    ['data-panel-retry', () => void draw()],
    ['data-panel-again', element => {
      const sentence = String(element.dataset.panelAgain);
      close();
      again?.(sentence);
    }],
    ['data-d-mail', element => {
      only = element.dataset.dMail ? Number(element.dataset.dMail) : null;
      void draw();
      /** @type {HTMLElement | null} */ (panel.querySelector(only === null ? `[data-d-mail]` : '.ck-inspector__back'))?.focus();
    }],
    ['data-ck-more', element => element.closest('.ck-ai__reply')?.classList.add('is-open')],
    ['data-d-person', element => {
      const id = element.dataset.dPerson;
      go(id ? 'people' : 'search', id ? { focus: id } : { q: String(element.dataset.dPersonName) });
    }],
    ['data-d-place', element => go('places', { focus: String(element.dataset.dPlace) })],
    ['data-d-place-unit', element => {
      const still = showing();
      void fetchLifePlaced(String(element.dataset.dPlaceUnit)).then(answer => answer.place?.slug ?? null)
        .catch(() => null).then(slug => {
          if (still()) go('places', slug ? { focus: slug } : {});
        });
    }],
  ];
  const selector = actions.map(([name]) => `[${name}]`).join(',');
  panel.addEventListener('click', event => {
    event.stopPropagation();
    const control = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest(selector));
    if (!control || !panel.contains(control) || control.matches(':disabled')) return;
    actions.find(([name]) => control.hasAttribute(name))?.[1](control);
  });
  panel.inert = !docked;

  return {
    /**
     * @param {Moment[]} list
     * @param {number} index
     * @param {{ openDay?: boolean, terms?: string[] }} [options]
     */
    show(list, index, options = {}) {
      stopVoice(voice);
      moments = list;
      at = Math.max(0, Math.min(list.length - 1, index));
      openDay = options.openDay ?? true;
      terms = options.terms ?? [];
      only = null;
      fresh = true;
      const opening = !open;
      open = true;
      opened = true;
      panel.inert = false;
      panel.classList.add('is-open');
      if (docked) return void draw();
      if (opening) listen(true);
      void draw();
      if (opening || !panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
    },
    close,
    isOpen: () => open,
    redraw: () => void redraw(),
  };
}
