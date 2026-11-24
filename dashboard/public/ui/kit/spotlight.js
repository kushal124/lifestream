// @ts-check
import { button } from './button.js';
import { duration } from './duration.js';

/** @typedef {{ top: number, right: number, bottom: number, left: number }} Bounds */
/** @typedef {{ x: number, y: number, w: number, h: number, r: number }} Box */
/** @typedef {{ x: number, y: number, corner: boolean }} Place */

/** @typedef {{ title: string, line: string, lead: string, icon?: string, pass?: string, aside?: string, held?: boolean }} SpotCard */

/** @typedef {{ clears?: readonly Element[], keeps?: readonly Element[], side?: boolean, start?: boolean, flush?: boolean }} SpotFace */

/** @typedef {{ clip: HTMLElement, edge: HTMLElement, of: readonly Element[] }} Ring */

const OFFSET = 4;
const WIDTH = 328;
const NARROW = 280;
const GAP = 14;
const EDGE = 16;
const RISE = 4;

let made = 0;

/** @param {number} n */
const at = n => Math.round(n * 100) / 100;

/**
 * @param {SpotCard} said
 * @param {boolean} lit
 * @param {boolean} corner
 */
const faceOf = (said, lit, corner) => JSON.stringify([said.title, said.line, said.lead, said.icon ?? '',
  said.pass ?? '', said.aside ?? '', lit, corner]);

/**
 * @param {readonly Element[]} a
 * @param {readonly Element[]} b
 */
const sameList = (a, b) => a.length === b.length && a.every((each, index) => each === b[index]);

/**
 * @param {Bounds} a
 * @param {Bounds} b
 * @param {number} [gap]
 */
const meets = (a, b, gap = 0) => a.left - gap < b.right && a.right + gap > b.left && a.top - gap < b.bottom && a.bottom + gap > b.top;

/**
 * @param {Bounds} outer
 * @param {Bounds} inner
 */
const holds = (outer, inner) => outer.left <= inner.left + 0.5 && outer.top <= inner.top + 0.5 && outer.right >= inner.right - 0.5
  && outer.bottom >= inner.bottom - 0.5;

/** @param {Element} element */
const scrolls = element => /^(auto|scroll)$/u.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight;

/**
 * @param {DOMRect} a
 * @param {DOMRect} b
 */
const fills = (a, b) => Math.abs(a.left - b.left) <= 1.5 && Math.abs(a.top - b.top) <= 1.5 && Math.abs(a.right - b.right) <= 1.5
  && Math.abs(a.bottom - b.bottom) <= 1.5;

/**
 * @param {Element} element
 * @param {DOMRect} box
 */
function cornerOf(element, box) {
  for (let on = /** @type {Element | undefined} */ (element); on;) {
    const said = getComputedStyle(on).borderTopLeftRadius.split(' ')[0] ?? '0';
    const value = said.endsWith('%') ? parseFloat(said) / 100 * box.width : parseFloat(said) || 0;
    if (value > 0) return Math.min(value, box.width / 2, box.height / 2);
    on = [...on.children].find(child => fills(child.getBoundingClientRect(), box));
  }
  return 0;
}

/**
 * @param {HTMLElement} holder
 * @param {object} options
 * @param {() => Bounds} options.bounds
 * @param {() => void} options.lead
 * @param {() => void} options.forward
 * @param {() => void} options.back
 * @param {() => void} options.leave
 * @param {() => void} [options.pass]
 * @param {() => void} [options.aside]
 * @param {boolean} [options.framed]
 */
export function spotlight(holder, { bounds, lead: led, forward, back, leave, pass = () => {}, aside = leave, framed = false }) {
  const doc = holder.ownerDocument;
  const win = /** @type {Window} */ (doc.defaultView);
  const id = `ck-spot-${made += 1}`;
  const root = doc.createElement('div');
  root.className = `ck-spot${framed ? ' ck-spot--framed' : ''}`;
  root.dataset.still = '';
  const card = doc.createElement('div');
  card.className = 'ck-spot__card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'false');
  card.setAttribute('aria-labelledby', `${id}-title`);
  card.setAttribute('aria-describedby', `${id}-line`);
  card.innerHTML = '<div class="ck-spot__words">'
    + `<h2 class="ck-spot__title" id="${id}-title"></h2><p class="ck-spot__line" id="${id}-line"></p></div>`
    + '<div class="ck-spot__foot">'
    + button('', { variant: 'plain', size: 'sm', attrs: { 'data-spot': 'aside' } })
    + '<span class="ck-spot__acts">'
    + button('', { variant: 'secondary', size: 'sm', attrs: { 'data-spot': 'pass' } })
    + button('', { variant: 'primary', size: 'sm', icon: 'send', attrs: { 'data-spot': 'lead' } }) + '</span></div>';
  card.hidden = true;
  const twin = /** @type {HTMLElement} */ (card.cloneNode(true));
  twin.className = 'ck-spot__card ck-spot__card--twin';
  twin.hidden = false;
  twin.removeAttribute('role');
  for (const each of [twin, ...twin.querySelectorAll('[id]')]) each.removeAttribute('id');
  twin.setAttribute('aria-hidden', 'true');
  twin.inert = true;
  root.append(card, twin);
  holder.append(root);

  /** @param {HTMLElement} at @param {string} name */
  const part = (at, name) => /** @type {HTMLElement} */ (at.querySelector(name));
  /** @param {string} act */
  const control = act => /** @type {HTMLButtonElement} */ (card.querySelector(`[data-spot="${act}"]`));
  const scroller = part(card, '.ck-spot__words');

  /** @param {string} name */
  const token = name => getComputedStyle(root).getPropertyValue(name).trim();
  /** @param {string} name */
  const ms = name => duration(root, name);
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const lead = () => control('lead');

  /** @type {readonly Element[]} */
  let targets = [];
  /** @type {readonly Element[]} */
  let watched = [];
  /** @type {readonly Element[]} */
  let clears = [];
  /** @type {readonly Element[]} */
  let keeps = [];
  /** @type {Place | null} */
  let placed = null;
  let pinned = false;
  let docked = '';
  let side = false;
  let start = false;
  let offset = OFFSET;
  /** @type {SpotCard | null} */
  let words = null;
  let showing = '';
  /** @type {Ring | null} */
  let ring = null;
  let fading = false;
  let moving = 0;
  let pending = 0;
  let closed = false;
  const resized = new ResizeObserver(() => measure());

  function area() {
    if (!framed) return { x: 0, y: 0, w: doc.documentElement.clientWidth, h: doc.documentElement.clientHeight };
    const box = holder.getBoundingClientRect();
    return { x: box.left, y: box.top, w: holder.clientWidth, h: holder.clientHeight };
  }

  /** @returns {Box | null} */
  function litBox() {
    const shown = targets.filter(each => each.isConnected).map(each => ({ each, box: each.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0 && box.height > 0);
    if (!shown.length) return null;
    const origin = area();
    const left = Math.min(...shown.map(({ box }) => box.left));
    const top = Math.min(...shown.map(({ box }) => box.top));
    const right = Math.max(...shown.map(({ box }) => box.right));
    const bottom = Math.max(...shown.map(({ box }) => box.bottom));
    const x = Math.round(left - origin.x - offset);
    const y = Math.round(top - origin.y - offset);
    const w = Math.round(right - origin.x + offset) - x;
    const h = Math.round(bottom - origin.y + offset) - y;
    return { x, y, w, h, r: Math.min(cornerOf(shown[0].each, shown[0].box) + offset, w / 2, h / 2) };
  }

  function clipOf() {
    const origin = area();
    const room = bounds();
    let { left, top, right, bottom } = room;
    const spare = offset + 1;
    const first = targets.find(each => each.isConnected);
    for (let on = first?.parentElement ?? null; on && on !== holder && on !== doc.body; on = on.parentElement) {
      const style = getComputedStyle(on);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const box = on.getBoundingClientRect();
      const across = /^(auto|scroll)$/u.test(style.overflowX) ? 0 : spare;
      const down = /^(auto|scroll)$/u.test(style.overflowY) ? 0 : spare;
      left = Math.max(left, box.left - origin.x - across);
      top = Math.max(top, box.top - origin.y - down);
      right = Math.min(right, box.right - origin.x + across);
      bottom = Math.min(bottom, box.bottom - origin.y + down);
    }
    return { left: Math.round(left), top: Math.round(top), right: Math.round(right), bottom: Math.round(bottom) };
  }

  /**
   * @param {SpotCard} said
   * @param {number} [widest]
   */
  function sizeOf(said, widest = WIDTH) {
    const room = bounds();
    const w = Math.min(widest, room.right - room.left - 2 * EDGE);
    const most = room.bottom - room.top - 2 * EDGE;
    fill(twin, said);
    twin.style.width = `${w}px`;
    twin.style.maxHeight = `${most}px`;
    return { w, h: Math.min(twin.offsetHeight, most), most };
  }

  /** @param {Element} element */
  function laidOut(element) {
    const box = element.isConnected ? element.getBoundingClientRect() : null;
    if (!box?.width || !box.height || getComputedStyle(element).visibility !== 'visible') return null;
    let x = 0;
    let y = 0;
    for (let at = /** @type {Element | null} */ (element); at; at = at.parentElement) {
      const moved = getComputedStyle(at).transform;
      if (moved !== 'none') {
        const matrix = new DOMMatrix(moved);
        x += matrix.m41;
        y += matrix.m42;
      }
    }
    const origin = area();
    const left = box.left - x - origin.x;
    const top = box.top - y - origin.y;
    return { left, top, right: left + box.width, bottom: top + box.height };
  }

  /**
   * @param {readonly Element[]} list
   * @returns {Bounds[]}
   */
  function seenOf(list) {
    const room = bounds();
    return list.map(laidOut).filter(box => box !== null).map(box => ({ left: Math.max(box.left, room.left),
      top: Math.max(box.top, room.top), right: Math.min(box.right, room.right), bottom: Math.min(box.bottom, room.bottom) }))
      .filter(box => box.right > box.left && box.bottom > box.top);
  }

  /**
   * @param {Box} box
   * @returns {Bounds}
   */
  const boundsOf = box => ({ left: box.x, top: box.y, right: box.x + box.w, bottom: box.y + box.h });

  /** @param {Box} box */
  function anchorOf(box) {
    const ringed = boundsOf(box);
    const kept = [...seenOf(clears), ...seenOf(keeps)];
    const anchor = kept.filter(each => holds(each, ringed)).reduce((all, each) => ({ left: Math.min(all.left, each.left),
      top: Math.min(all.top, each.top), right: Math.max(all.right, each.right), bottom: Math.max(all.bottom, each.bottom) }), ringed);
    return { ringed, anchor, kept };
  }

  /**
   * @param {Box} box
   * @param {{ w: number, h: number }} size
   * @returns {Place | null}
   */
  function beside(box, { w, h }) {
    const room = bounds();
    const { ringed, anchor, kept } = anchorOf(box);
    const others = [ringed, ...kept.filter(each => !holds(each, ringed))];
    /** @param {number} value @param {number} low @param {number} high */
    const held = (value, low, high) => Math.max(low, Math.min(value, high));
    const across = held(start ? anchor.left : (anchor.left + anchor.right) / 2 - w / 2, room.left + EDGE, room.right - EDGE - w);
    const down = held(start ? anchor.top : (anchor.top + anchor.bottom) / 2 - h / 2, room.top + EDGE, room.bottom - EDGE - h);
    const stacked = [{ x: across, y: anchor.bottom + GAP }, { x: across, y: anchor.top - GAP - h }];
    const level = [{ x: anchor.right + GAP, y: down }, { x: anchor.left - GAP - w, y: down }];
    const found = (side ? [...level, ...stacked] : [...stacked, ...level]).find(place => place.x >= room.left + EDGE - 0.5
      && place.x + w <= room.right - EDGE + 0.5 && place.y >= room.top + EDGE - 0.5 && place.y + h <= room.bottom - EDGE + 0.5
      && !others.some(each => meets({ left: place.x, top: place.y, right: place.x + w, bottom: place.y + h }, each, GAP / 2)));
    return found ? { ...found, corner: false } : null;
  }

  /**
   * @param {{ w: number, h: number }} size
   * @param {Box | null} box
   * @returns {Place}
   */
  function cornered({ w, h }, box) {
    const room = bounds();
    const x = room.right - EDGE - w;
    const hard = [...seenOf(clears), ...box ? [boundsOf(box)] : []];
    /** @param {readonly Bounds[]} boxes */
    const lifted = boxes => {
      let bottom = room.bottom - EDGE;
      for (let moved = true; moved;) {
        moved = false;
        for (const each of boxes) {
          if (meets({ left: x, top: bottom - h, right: x + w, bottom }, each, GAP - 0.5)) {
            bottom = each.top - GAP;
            moved = true;
          }
        }
      }
      return bottom - h;
    };
    const free = lifted([...hard, ...seenOf(keeps)]);
    return { x, y: Math.max(room.top + EDGE, free >= room.top + EDGE ? free : lifted(hard)), corner: true };
  }

  /**
   * @param {SpotCard | null} said
   * @returns {{ lit: Box | null, place: Place | null, size: { w: number, h: number, most: number } | null }}
   */
  function layout(said) {
    const box = litBox();
    if (!said) return { lit: box, place: null, size: null };
    const face = faceOf(said, false, false);
    const size = sizeOf(said);
    if (box && docked !== face) {
      const { anchor } = anchorOf(box);
      const across = anchor.right - anchor.left;
      const fitted = across >= NARROW && across < size.w ? sizeOf(said, across) : null;
      const near = fitted && beside(box, fitted);
      if (fitted && near) {
        docked = '';
        return { lit: box, place: near, size: fitted };
      }
      const place = beside(box, size);
      if (place) {
        docked = '';
        return { lit: box, place, size };
      }
    }
    docked = face;
    return { lit: box, place: cornered(size, box), size };
  }

  function bring() {
    const first = targets.find(each => each.isConnected);
    let scroller = first?.parentElement ?? null;
    while (scroller && scroller !== doc.body && !scrolls(scroller)) scroller = scroller.parentElement;
    if (!first || !scroller || scroller === doc.body) return;
    const view = scroller.getBoundingClientRect();
    const box = first.getBoundingClientRect();
    const margin = offset + GAP;
    let floor = view.bottom;
    if (placed?.corner && !card.hidden) {
      const origin = area();
      const left = origin.x + placed.x;
      if (left < view.right && left + card.offsetWidth > view.left) floor = Math.min(floor, origin.y + placed.y);
    }
    const under = view.top + margin - box.top;
    const over = box.bottom + margin - floor;
    const by = under > 0 ? -under : over > 0 ? over : 0;
    if (Math.abs(by) >= 1) scroller.scrollBy({ top: by, behavior: 'instant' });
  }

  /**
   * @param {HTMLElement} into
   * @param {SpotCard} said
   */
  function fill(into, said) {
    part(into, '.ck-spot__words').scrollTop = 0;
    part(into, '.ck-spot__title').textContent = said.title;
    part(into, '.ck-spot__line').textContent = said.line;
    for (const [name, label] of /** @type {const} */ ([['aside', said.aside], ['pass', said.pass], ['lead', said.lead]])) {
      const each = /** @type {HTMLElement} */ (into.querySelector(`[data-spot="${name}"]`));
      each.hidden = !label;
      if (label) part(each, '.ck-btn__label').textContent = label;
    }
    hold(into, said);
    /** @type {SVGElement} */ (into.querySelector('[data-spot="lead"] svg')).toggleAttribute('hidden', said.icon !== 'send');
  }

  /**
   * @param {HTMLElement} into
   * @param {SpotCard} said
   */
  function hold(into, said) {
    /** @type {HTMLButtonElement} */ (part(into, '[data-spot="lead"]')).disabled = Boolean(said.held);
  }

  /**
   * @param {Place} place
   * @param {{ w: number, most: number }} size
   */
  function stand(place, size) {
    placed = place;
    root.classList.toggle('ck-spot--docked', place.corner);
    card.style.left = `${at(place.x)}px`;
    card.style.top = `${at(place.y)}px`;
    card.style.width = `${size.w}px`;
    card.style.maxHeight = `${size.most}px`;
    if (scroller.scrollHeight > scroller.clientHeight + 1) scroller.tabIndex = 0;
    else if (scroller.hasAttribute('tabindex')) {
      const held = doc.activeElement === scroller;
      scroller.removeAttribute('tabindex');
      if (held) lead().focus({ preventScroll: true });
    }
    if (place.corner) holder.style.setProperty('--ck-spot-room', `${Math.ceil(card.offsetHeight + GAP)}px`);
    else holder.style.removeProperty('--ck-spot-room');
    if (pinned) bring();
  }

  function settled() {
    root.toggleAttribute('data-still', !fading && moving === 0 && !pending);
  }

  /**
   * @param {Element} element
   * @param {Keyframe[]} frames
   * @param {KeyframeAnimationOptions} timing
   */
  async function animate(element, frames, timing) {
    moving += 1;
    settled();
    try {
      await element.animate(frames, timing).finished;
    } catch {}
    moving -= 1;
    settled();
  }

  const quick = () => ({ duration: ms('--duration-fast'), easing: still() ? 'linear' : token('--ease-out') });
  const slow = () => ({ duration: ms(still() ? '--duration-fast' : '--duration-open'), easing: still() ? 'linear' : token('--ease-out') });

  /** @param {Ring} gone */
  function retire(gone) {
    void animate(gone.clip, [{ opacity: 1 }, { opacity: 0 }], { ...quick(), fill: 'forwards' }).then(() => gone.clip.remove());
  }

  /** @param {Box | null} box */
  function light(box) {
    if (ring && (!box || !sameList(ring.of, targets))) {
      retire(ring);
      ring = null;
    }
    if (!box) return;
    const clip = clipOf();
    const fresh = !ring;
    if (!ring) {
      const made = doc.createElement('div');
      made.className = 'ck-spot__clip';
      made.setAttribute('aria-hidden', 'true');
      made.innerHTML = '<div class="ck-spot__ring"></div>';
      root.prepend(made);
      ring = { clip: made, edge: part(made, '.ck-spot__ring'), of: targets };
    }
    const { clip: frame, edge } = ring;
    frame.hidden = clip.right <= clip.left || clip.bottom <= clip.top || box.x + offset >= clip.right || box.x + box.w - offset <= clip.left
      || box.y + offset >= clip.bottom || box.y + box.h - offset <= clip.top;
    frame.style.left = `${clip.left}px`;
    frame.style.top = `${clip.top}px`;
    frame.style.width = `${Math.max(0, clip.right - clip.left)}px`;
    frame.style.height = `${Math.max(0, clip.bottom - clip.top)}px`;
    edge.style.left = `${box.x - clip.left}px`;
    edge.style.top = `${box.y - clip.top}px`;
    edge.style.width = `${box.w}px`;
    edge.style.height = `${box.h}px`;
    edge.style.borderRadius = `${at(box.r)}px`;
    if (fresh) void animate(frame, [{ opacity: 0 }, { opacity: 1 }], slow());
  }

  function hide() {
    showing = '';
    placed = null;
    holder.style.removeProperty('--ck-spot-room');
    if (card.hidden || fading) return;
    if (card.contains(doc.activeElement)) /** @type {HTMLElement} */ (doc.activeElement).blur();
    fading = true;
    settled();
    void animate(card, [{ opacity: 1 }, { opacity: 0 }], { ...quick(), fill: 'forwards' }).then(() => {
      fading = false;
      if (closed) return;
      card.hidden = true;
      for (const each of card.getAnimations()) each.cancel();
      settled();
      render();
    });
  }

  function render() {
    if (closed) return;
    const next = layout(words);
    if (!words) {
      light(next.lit);
      hide();
      return;
    }
    const key = faceOf(words, next.lit !== null, Boolean(next.place?.corner));
    if (key === showing || fading) {
      light(next.lit);
      if (!fading && next.place && next.size) {
        hold(card, words);
        stand(next.place, next.size);
      }
      return;
    }
    const first = card.hidden;
    showing = key;
    if (first) {
      card.hidden = false;
      void arrive(next);
      return;
    }
    void swap();
  }

  /** @param {ReturnType<typeof layout>} now */
  async function arrive(now) {
    if (!words || !now.place || !now.size) return;
    const held = doc.activeElement;
    const led = held instanceof HTMLButtonElement && card.contains(held);
    fill(card, words);
    if (led && (held.hidden || held.disabled)) lead().focus({ preventScroll: true });
    stand(now.place, now.size);
    light(now.lit);
    for (const each of card.getAnimations()) each.cancel();
    const rise = still() ? 0 : RISE;
    await animate(card, [{ opacity: 0, transform: `translateY(${rise}px)` }, { opacity: 1, transform: 'none' }], slow());
  }

  async function swap() {
    fading = true;
    settled();
    await animate(card, [{ opacity: 1 }, { opacity: 0 }], { ...quick(), fill: 'forwards' });
    fading = false;
    if (closed) return;
    if (!words) {
      render();
      return;
    }
    const now = layout(words);
    showing = faceOf(words, now.lit !== null, Boolean(now.place?.corner));
    await arrive(now);
  }

  function measure() {
    if (closed) return;
    win.cancelAnimationFrame(pending);
    pending = win.requestAnimationFrame(() => {
      pending = 0;
      render();
      settled();
    });
    settled();
  }

  card.addEventListener('click', event => {
    const pressedOn = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest('[data-spot]'))?.dataset.spot;
    if (pressedOn === 'lead') led();
    else if (pressedOn === 'pass') pass();
    else if (pressedOn === 'aside') aside();
  });
  card.addEventListener('keydown', event => {
    card.dataset.keyed = '';
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    if (event.key === 'ArrowLeft' && plain) back();
    else if (event.key === 'ArrowRight' && plain) forward();
    else if (event.key === 'Escape') leave();
    else return;
    event.preventDefault();
    event.stopPropagation();
  });
  /** @param {Event} event */
  const unpin = event => {
    if (!card.contains(/** @type {Node | null} */ (event.target))) pinned = false;
  };
  const MOVES = /** @type {const} */ (['wheel', 'touchmove', 'pointerdown', 'keydown']);
  doc.addEventListener('scroll', measure, { capture: true, passive: true });
  doc.addEventListener('transitionend', measure, { capture: true, passive: true });
  for (const name of MOVES) doc.addEventListener(name, unpin, { capture: true, passive: true });
  win.addEventListener('resize', measure);
  if (framed) resized.observe(holder);

  return {
    /**
     * @param {Element | readonly Element[] | null} element
     * @param {SpotCard | null} said
     * @param {SpotFace} [face]
     */
    show(element, said, { clears: clear = [], keeps: kept = [], side: railed = false, start: edged = false, flush = false } = {}) {
      const lit = element === null ? [] : 'length' in element ? element : [element];
      const follows = [...lit, ...clear, ...kept];
      for (const each of watched) if (!follows.includes(each)) resized.unobserve(each);
      for (const each of follows) if (!watched.includes(each)) resized.observe(each);
      watched = follows;
      if (!sameList(lit, targets)) docked = '';
      targets = lit;
      clears = clear;
      keeps = kept;
      side = railed;
      start = edged;
      offset = flush ? 0 : OFFSET;
      words = said;
      render();
    },

    measure,

    reveal() {
      pinned = true;
      bring();
    },

    focus() {
      const to = lead();
      const shown = [to, control('pass'), control('aside')].find(each => !each.hidden && !each.disabled);
      shown?.focus({ preventScroll: true });
    },

    async close() {
      if (closed) return;
      closed = true;
      resized.disconnect();
      win.cancelAnimationFrame(pending);
      doc.removeEventListener('scroll', measure, { capture: true });
      doc.removeEventListener('transitionend', measure, { capture: true });
      for (const name of MOVES) doc.removeEventListener(name, unpin, { capture: true });
      holder.style.removeProperty('--ck-spot-room');
      win.removeEventListener('resize', measure);
      root.removeAttribute('data-still');
      root.inert = true;
      try {
        await root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms('--duration-fast'), easing: 'linear',
          fill: 'forwards' }).finished;
      } catch {}
      root.remove();
    },
  };
}
