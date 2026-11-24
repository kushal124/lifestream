// @ts-check
/** @import { Feedback, FeedbackDraft, FeedbackKind } from '../pages.js' */
/** @import { FeedbackAbout, FeedbackSent } from '../lib/api.js' */
/** @import { Host } from '../lib/host.js' */
import { attributes, esc } from '../lib/html.js';
import { NOT_SENT, wordsOr } from '../lib/reach.js';
import { attachmentChip, attachmentChips, button, dialog, dialogHold, inPlaceLine, showToast } from './kit/index.js';
import { seenHidden } from './kit/seen.js';

export const FEEDBACK = 'feedback';

/** @type {Record<FeedbackKind, string>} */
const GLYPHS = { answer: 'chat', connector: 'streams', app: 'info', screenshot: 'photo' };

/**
 * @typedef {object} FeedbackParts
 * @property {() => Promise<Feedback>} page
 * @property {(id: string, about: FeedbackAbout) => Promise<FeedbackDraft>} draft
 * @property {(id: string, jpeg: Uint8Array) => Promise<unknown>} shot
 * @property {(report: FeedbackSent) => Promise<unknown>} send
 * @property {() => string} mint
 * @property {(jpeg: Uint8Array) => string} picture
 * @property {(url: string) => void} forget
 * @property {Pick<Host, 'act'> | null} host
 * @property {() => Element[]} behind
 * @property {() => void} route
 * @property {() => void} closed
 */

/**
 * @typedef {object} FeedbackForm
 * @property {() => string | null} entry
 * @property {(listener: () => void) => () => void} follow
 * @property {() => Promise<void>} read
 * @property {(about: FeedbackAbout, name?: string) => void} open
 * @property {() => Promise<void>} show
 * @property {() => void} hide
 */

/** @param {FeedbackAbout} about */
export const aboutKey = about => about.kind === 'chat' ? `chat:${about.chat}:${about.n}`
  : about.kind === 'connector' ? `connector:${about.connector}` : 'menu';

/**
 * @param {Feedback} page
 * @param {FeedbackAbout} about
 * @param {string} name
 */
export const titleOf = (page, about, name) => about.kind === 'chat' ? page.about.chat
  : about.kind === 'connector' ? page.about.connector.replaceAll('{name}', name) : page.title;

/**
 * @param {Feedback} page
 * @param {string | null} email
 */
export const sentOf = (page, email) => ({ title: page.sent.title,
  line: email && page.sent.line ? page.sent.line.replaceAll('{email}', email) : null });

/** @param {Feedback | null} page */
export const entryOf = page => page?.open ? `${page.title}…` : null;

/**
 * @param {HTMLElement} layer
 * @param {FeedbackParts} parts
 * @returns {FeedbackForm}
 */
export function installFeedback(layer, parts) {
  layer.innerHTML = '<div data-fb-slot></div><div class="ck-toasts" data-fb-toasts></div>';
  const slot = /** @type {HTMLElement} */ (layer.querySelector('[data-fb-slot]'));
  const toasts = /** @type {HTMLElement} */ (layer.querySelector('[data-fb-toasts]'));
  const hold = dialogHold(() => slot, parts.behind);
  /** @type {Set<() => void>} */
  const listeners = new Set();
  /** @type {Map<string, { text: string, email: string }>} */
  const kept = new Map();
  /** @type {Feedback | null} */
  let page = null;
  /** @type {Promise<void> | null} */
  let reading = null;
  /** @type {{ about: FeedbackAbout, name: string } | null} */
  let pending = null;
  let shown = false;
  /** @type {FeedbackAbout} */
  let about = { kind: 'menu' };
  let name = '';
  let id = '';
  /** @type {FeedbackDraft | null} */
  let draft = null;
  /** @type {Set<FeedbackKind>} */
  const dropped = new Set();
  /** @typedef {'landed' | 'gone' | 'failed'} Landed */
  /** @type {{ jpeg: Uint8Array, url: string, added: boolean, landing: Promise<Landed> | null, for: string } | null} */
  let shot = null;
  let text = '';
  let email = '';
  let said = '';
  let sending = false;
  /** @type {'form' | 'see' | 'picture'} */
  let view = 'form';
  let opening = 0;

  /** @param {string} selector */
  const part = selector => /** @type {HTMLElement | null} */ (slot.querySelector(selector));
  const kinds = () => (draft?.attachments ?? []).map(each => each.kind).filter(kind => !dropped.has(kind));
  const shotKind = () => page?.kinds.find(each => each.kind === 'screenshot') ?? null;
  const typed = () => text.trim() !== '';

  const chipsMarkup = () => {
    const chips = (draft?.attachments ?? []).map(each => attachmentChip({ title: each.title, kept: !dropped.has(each.kind),
      glyph: GLYPHS[each.kind], attrs: { 'data-fb-keep': each.kind } }));
    const kind = shotKind();
    if (shot && kind) {
      chips.push(attachmentChip({ title: kind.title, add: kind.add ?? '', kept: shot.added,
        picture: { src: shot.url, attrs: { 'data-fb-picture': '' } }, attrs: { 'data-fb-keep': 'screenshot' } }));
    }
    return attachmentChips(chips);
  };

  /** @param {Feedback} words */
  const formMarkup = words => dialog({
    plain: true,
    title: titleOf(words, about, name),
    close: { 'data-fb-close': '' },
    body: '<div class="ck-fb">'
      + `<textarea${attributes({ class: 'ck-fb__note mac-body', 'data-fb-text': '', maxlength: String(words.field.max),
        placeholder: words.field.placeholder, 'aria-label': titleOf(words, about, name), rows: '7' })}></textarea>`
      + `<div class="ck-fb__chips" data-fb-chips>${chipsMarkup()}</div>`
      + '<label class="ck-fb__email">'
      + `<span class="ck-fb__email-label mac-body">${esc(words.email.label)}</span>`
      + `<input${attributes({ class: 'ck-fb__email-field mac-body', type: 'email', 'data-fb-email': '', maxlength: '254',
        autocomplete: 'email', spellcheck: 'false', placeholder: words.email.placeholder })}></label>`
      + '<div class="ck-fb__said" data-fb-said></div></div>',
    foot: button(words.see, { variant: 'plain', icon: 'visible', attrs: { 'data-fb-see': '' } })
      + '<span class="ck-fb__sends" data-fb-sends></span>',
  });

  /** @param {Feedback} words */
  const seenMarkup = words => {
    const sections = [`<p class="ck-fb-seen__text mac-body">${esc(text)}</p>`];
    if (email.trim()) sections.push(seenPart(words.email.label, `<p class="ck-fb-seen__text mac-body">${esc(email.trim())}</p>`));
    for (const each of draft?.attachments ?? []) {
      if (dropped.has(each.kind)) continue;
      sections.push(seenPart(each.title, `<pre class="ck-fb-seen__text mac-body">${seenHidden(each.text)}</pre>`));
    }
    const kind = shotKind();
    if (shot?.added && kind) sections.push(seenPart(kind.title, pictureOf(shot.url, kind.title)));
    return dialog({ plain: true, title: words.see, back: { label: titleOf(words, about, name), attrs: { 'data-fb-back': '' } },
      close: { 'data-fb-close': '' },
      body: `<div class="ck-fb-seen"><p class="ck-fb-seen__privacy mac-subhead">${esc(words.privacy)}</p>`
        + `${sections.join('')}</div>` });
  };

  /** @param {Feedback} words */
  const pictureMarkup = words => {
    const title = shotKind()?.title ?? words.title;
    return dialog({ plain: true, title, back: { label: titleOf(words, about, name), attrs: { 'data-fb-back': '' } },
      close: { 'data-fb-close': '' },
      body: shot ? pictureOf(shot.url, title) : '' });
  };

  function drawChips() {
    const chips = part('[data-fb-chips]');
    if (chips) chips.innerHTML = chipsMarkup();
  }

  function drawSaid() {
    const line = part('[data-fb-said]');
    if (line) line.innerHTML = said ? inPlaceLine(said, { shape: said === page?.again ? 'caution' : 'warning' }) : '';
  }

  function drawSends() {
    const sends = part('[data-fb-sends]');
    if (!sends || !page) return;
    sends.innerHTML = (typed() && !sending ? button(page.clear, { variant: 'plain', attrs: { 'data-fb-clear': '' } }) : '')
      + button(page.send, { variant: 'primary', busy: sending, disabled: !typed(), attrs: { 'data-fb-send': '' } });
  }

  function draw() {
    if (!page || !shown) return;
    const markup = view === 'see' ? seenMarkup(page) : view === 'picture' ? pictureMarkup(page) : formMarkup(page);
    slot.innerHTML = `<div class="ck-fb-layer">${markup}</div>`;
    hold();
    if (view !== 'form') {
      part('[data-fb-back]')?.focus();
      return;
    }
    const note = /** @type {HTMLTextAreaElement} */ (part('[data-fb-text]'));
    note.value = text;
    /** @type {HTMLInputElement} */ (part('[data-fb-email]')).value = email;
    drawSaid();
    drawSends();
    note.focus();
    note.setSelectionRange(text.length, text.length);
  }

  function requestDraft() {
    const asked = id;
    void parts.draft(asked, about).then(answer => {
      if (asked !== id) return;
      draft = answer;
      if (!email && answer.email) {
        email = answer.email;
        const field = /** @type {HTMLInputElement | null} */ (part('[data-fb-email]'));
        if (field) field.value = email;
      }
      if (view === 'form') drawChips();
    }, error => {
      if (asked !== id) return;
      said = wordsOr(error, NOT_SENT);
      drawSaid();
    });
  }

  /** @returns {Promise<Landed>} */
  function land() {
    const taking = shot;
    if (!taking) return Promise.resolve('failed');
    if (taking.landing && taking.for === id) return taking.landing;
    const asked = id;
    taking.for = asked;
    taking.landing = parts.shot(asked, taking.jpeg).then(() => /** @type {const} */ ('landed'), error => {
      if (shot !== taking || asked !== id) return 'failed';
      taking.landing = null;
      if (/** @type {{ status?: number }} */ (error).status === 404) return 'gone';
      taking.added = false;
      said = wordsOr(error, NOT_SENT);
      drawChips();
      drawSaid();
      return 'failed';
    });
    return taking.landing;
  }

  function again() {
    id = parts.mint();
    draft = null;
    said = page?.again ?? '';
    if (shot) shot.landing = null;
    drawChips();
    drawSaid();
    requestDraft();
    if (shot?.added) void land();
  }

  async function send() {
    if (!page || sending || !typed()) return;
    const words = page;
    sending = true;
    said = '';
    drawSaid();
    drawSends();
    const asked = id;
    const reply = email.trim() || null;
    const from = aboutKey(about);
    try {
      const pictured = Boolean(shot?.added);
      const landed = pictured ? await land() : 'landed';
      if (asked !== id) return;
      if (landed === 'gone') return again();
      if (landed === 'failed') return;
      /** @type {FeedbackKind[]} */
      const keep = pictured ? [...kinds(), 'screenshot'] : kinds();
      await parts.send({ id: asked, text, email: reply, keep });
      kept.delete(from);
      if (asked === id) {
        text = '';
        email = '';
        if (shown) parts.closed();
      }
      showToast(toasts, sentOf(words, reply));
    } catch (error) {
      if (asked !== id) return;
      if (/** @type {{ status?: number }} */ (error).status === 404) again();
      else {
        said = wordsOr(error, NOT_SENT);
        drawSaid();
      }
    } finally {
      sending = false;
      drawSends();
    }
  }

  /** @param {'form' | 'see' | 'picture'} next */
  function turn(next) {
    view = next;
    draw();
  }

  /** @param {boolean} keep */
  function release(keep) {
    if (keep && (text || email)) kept.set(aboutKey(about), { text, email });
    if (shot) parts.forget(shot.url);
    shot = null;
  }

  slot.addEventListener('input', event => {
    const target = event.target;
    if (target instanceof HTMLTextAreaElement && target.matches('[data-fb-text]')) {
      const was = typed();
      text = target.value;
      if (was !== typed()) drawSends();
    } else if (target instanceof HTMLInputElement && target.matches('[data-fb-email]')) email = target.value;
  });
  slot.addEventListener('click', event => {
    const target = /** @type {Element} */ (event.target);
    if (target.matches('[data-scrim]') || target.closest('[data-fb-close]')) return parts.closed();
    if (target.closest('[data-fb-back]')) return turn('form');
    if (target.closest('[data-fb-see]')) return turn('see');
    if (target.closest('[data-fb-picture]')) return turn('picture');
    if (target.closest('[data-fb-send]')) return void send();
    if (target.closest('[data-fb-clear]')) {
      text = '';
      email = '';
      said = '';
      kept.delete(aboutKey(about));
      return draw();
    }
    const chip = /** @type {HTMLElement | null} */ (target.closest('[data-fb-keep]'));
    if (!chip) return;
    const kind = /** @type {FeedbackKind} */ (chip.dataset.fbKeep);
    if (kind === 'screenshot' && shot) {
      shot.added = !shot.added;
      if (shot.added) void land().then(landed => landed === 'gone' ? again() : undefined);
    } else if (dropped.has(kind)) dropped.delete(kind);
    else dropped.add(kind);
    drawChips();
    /** @type {HTMLElement | null} */ (part(`[data-fb-keep="${kind}"]`))?.focus();
  });
  slot.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (view !== 'form') turn('form');
      else parts.closed();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && view === 'form') {
      event.preventDefault();
      void send();
    }
  });

  /** @returns {Promise<void>} */
  const read = () => {
    reading ??= parts.page().then(answer => {
      page = answer;
    }, () => {
      page = null;
    }).finally(() => {
      reading = null;
      for (const listener of listeners) listener();
    });
    return reading;
  };

  return {
    entry: () => entryOf(page),
    follow(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read,
    open(asked, called = '') {
      pending = { about: asked, name: called };
      if (shown) {
        hideForm(true);
        void showForm();
      } else parts.route();
    },
    show: () => showForm(),
    hide: () => hideForm(true),
  };

  async function showForm() {
    const ask = pending ?? { about: /** @type {FeedbackAbout} */ ({ kind: 'menu' }), name: '' };
    pending = null;
    if (shown) return;
    const now = ++opening;
    if (!page) await (reading ?? read());
    if (now !== opening) return;
    if (!page?.open) return parts.closed();
    about = ask.about;
    name = ask.name;
    id = parts.mint();
    draft = null;
    dropped.clear();
    said = '';
    view = 'form';
    const before = kept.get(aboutKey(about));
    text = before?.text ?? '';
    email = before?.email ?? '';
    requestDraft();
    const jpeg = await taken();
    if (now !== opening) return;
    shot = jpeg ? { jpeg, url: parts.picture(jpeg), added: false, landing: null, for: '' } : null;
    shown = true;
    draw();
  }

  /** @param {boolean} keep */
  function hideForm(keep) {
    opening += 1;
    if (!shown) return;
    shown = false;
    release(keep);
    id = '';
    slot.innerHTML = '';
    hold();
  }

  /** @returns {Promise<Uint8Array | null>} */
  async function taken() {
    if (!parts.host) return null;
    await new Promise(resolve => requestAnimationFrame(resolve));
    try {
      return (await parts.host.act({ act: 'screenshot-take' })).jpeg ?? null;
    } catch {
      return null;
    }
  }
}

/**
 * @param {string} label
 * @param {string} body
 */
const seenPart = (label, body) => '<section class="ck-fb-seen__part">'
  + `<h3 class="ck-fb-seen__label mac-subhead">${esc(label)}</h3>${body}</section>`;

/**
 * @param {string} src
 * @param {string} alt
 */
const pictureOf = (src, alt) => `<img${attributes({ class: 'ck-fb-seen__picture', src, alt })}>`;
