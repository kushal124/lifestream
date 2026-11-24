// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { duration } from './duration.js';
import { icon } from './icon.js';

/**
 * @typedef {{ start: number, end: number, placeholder: string } | { start: number, end: number, added: string }} SeenSpan
 * @typedef {{ asked: SeenSpan[], spoken?: string, answered: SeenSpan[], photos?: (string | null)[] }} AskSeen
 * @typedef {'held' | 'rest' | 'added' | 'break' | 'cite'} SeenKind
 * @typedef {{ decrypt: number, stagger: number, base: number, fast: number, ease: string }} SeenTiming
 * @typedef {{ start: number, end: number, placeholder: string }} Marked
 */

export const SEEN_CIPHER = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz0123456789#%&*+=/\\<>';
const TICK_MS = 33;
const OPEN = '\uE100';
const CLOSE = '\uE101';
const LOCK_FROM = 0.3;
const FILL_LEAVES = 0.6;
const MARKS = /[\uE100\uE101]/gu;
const MARKED = /[\uE100\uE101]/u;
const MARKS_IN_TAG = /\uE100|\uE101|%EE%84%80|%EE%84%81/giu;
const SPLIT = /([\uE100\uE101])/u;
const TAGS = /(<[^>]*>)/u;
const BRACKETED = /^(\[\[)([\s\S]*)(\]\])$/u;
const PLACEHOLDER = /(\[\[[^[\]\n]+\]\])/u;
const FENCE = /^\s*(```|~~~)/u;
const CODE_OR_TARGET = /(`+)[\s\S]*?\1|\]\([^)]*\)/gu;
const AUTOLINK = /<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>\x00-\x1f]*|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/gu;

/** @param {SeenSpan} span */
const saidOf = span => 'placeholder' in span ? span.placeholder : span.added;

/**
 * @param {string} text
 * @param {SeenSpan[]} spans
 */
export function spansFit(text, spans) {
  let at = 0;
  for (const span of spans) {
    const words = 'placeholder' in span ? typeof span.placeholder === 'string' : typeof span.added === 'string' && span.end === span.start;
    if (!words || !Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < at || span.end < span.start
      || span.end > text.length) return false;
    at = span.end;
  }
  return true;
}

/**
 * @param {string} text
 * @param {SeenSpan[]} spans
 */
const modelText = (text, spans) => {
  let out = '';
  let at = 0;
  for (const span of spans) {
    out += text.slice(at, span.start) + saidOf(span);
    at = span.end;
  }
  return out + text.slice(at);
};

/** @param {string} said */
const standWords = said => BRACKETED.exec(said)?.[2] ?? said;

/** @param {string} words */
export const standIn = words => `<span class="ck-stand">${esc(words)}</span>`;

/** @param {string} text */
export const seenHidden = text => text.split(PLACEHOLDER)
  .map((piece, at) => at % 2 ? standIn(standWords(piece)) : esc(piece)).join('');

/**
 * @param {SeenKind} kind
 * @param {string} words
 * @param {string} said
 * @param {boolean} [more]
 */
const detail = (kind, words, said, more = false) => `<span${attributes({
  class: `ck-seen ck-seen--${kind}${more ? ' is-more' : ''}`, 'data-said': said })}>`
  + `<span class="ck-seen__words">${words}</span>`
  + `<span class="ck-seen__said${kind === 'held' ? ' ck-stand' : ''}">${kind === 'cite' ? '' : esc(kind === 'held' ? standWords(said) : said)}</span>`
  + '<span class="ck-seen__run" aria-hidden="true"></span></span>';

/**
 * @param {string} capsule
 * @param {string} whole
 */
export const seenCite = (capsule, whole) => detail('cite', capsule, whole);

/** @param {string} added */
const addedHtml = added => added.split(/(\n)/u).filter(Boolean)
  .map((line, at) => detail(line === '\n' ? 'break' : 'added', '', line, at > 0)).join('');

/**
 * @param {string} text
 * @param {SeenSpan[] | null} spans
 */
export function seenWords(text, spans) {
  if (!spans || !spansFit(text, spans)) return esc(text);
  let out = '';
  let at = 0;
  for (const span of spans) {
    out += esc(text.slice(at, span.start)) + ('placeholder' in span
      ? detail('held', esc(text.slice(span.start, span.end)), span.placeholder)
      : addedHtml(span.added));
    at = span.end;
  }
  return out + esc(text.slice(at));
}

/** @param {string} text @returns {[number, number][]} */
function targetsOf(text) {
  /** @type {[number, number][]} */
  const targets = [];
  let fenced = false;
  let row = 0;
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) fenced = !fenced;
    else if (!fenced) {
      for (const found of line.matchAll(CODE_OR_TARGET)) {
        if (found[1] === undefined) targets.push([row + (found.index ?? 0), row + (found.index ?? 0) + found[0].length]);
      }
    }
    row += line.length + 1;
  }
  return targets;
}

/**
 * @param {string} text
 * @param {Marked[]} spans
 * @returns {Marked[]}
 */
function widened(text, spans) {
  const links = [...text.matchAll(AUTOLINK)].map(found => [found.index ?? 0, (found.index ?? 0) + found[0].length]);
  /** @type {Marked[]} */
  const out = [];
  for (const span of spans) {
    const link = links.find(([start, end]) => span.start > start && span.end < end);
    if (!link) {
      out.push(span);
      continue;
    }
    const [start, end] = link;
    const last = out.at(-1);
    if (last?.start === start && last.end === end) continue;
    const inside = spans.filter(each => each.start > start && each.end < end)
      .map(each => ({ ...each, start: each.start - start, end: each.end - start }));
    out.push({ start, end, placeholder: modelText(text.slice(start, end), inside) });
  }
  return out;
}

/**
 * @param {string} html
 * @param {Marked[]} spans
 * @returns {string | null}
 */
function detailsIn(html, spans) {
  const drawn = spans.map(() => 0);
  let opened = -1;
  let inside = false;
  const out = html.split(TAGS).map((piece, at) => {
    if (at % 2) return piece.replace(MARKS_IN_TAG, '');
    return piece.split(SPLIT).map((bit, mark) => {
      if (mark % 2) {
        inside = bit === OPEN;
        if (inside) opened += 1;
        return '';
      }
      if (!inside || !bit || !spans[opened]) return bit;
      drawn[opened] += 1;
      const first = drawn[opened] === 1;
      return detail(first ? 'held' : 'rest', bit, first ? spans[opened].placeholder : '', !first);
    }).join('');
  }).join('');
  return opened === spans.length - 1 && drawn.every(Boolean) ? out : null;
}

/**
 * @param {string} text
 * @param {SeenSpan[]} spans
 * @param {(text: string) => string} markdown
 * @returns {string | null}
 */
export function seenAnswer(text, spans, markdown) {
  if (MARKED.test(text) || !spansFit(text, spans)) return null;
  /** @type {Marked[]} */
  const words = [];
  for (const span of spans) {
    if (!('placeholder' in span) || span.end === span.start) return null;
    words.push(span);
  }
  const targets = targetsOf(text);
  const drawn = widened(text, words.filter(span => !targets.some(([start, end]) => span.start >= start && span.end <= end)));
  let marked = '';
  let at = 0;
  for (const span of drawn) {
    marked += text.slice(at, span.start) + OPEN + text.slice(span.start, span.end) + CLOSE;
    at = span.end;
  }
  const html = markdown(marked + text.slice(at));
  const unmarked = html.split(TAGS).map((piece, place) => piece.replace(place % 2 ? MARKS_IN_TAG : MARKS, '')).join('');
  return unmarked === markdown(text) ? detailsIn(html, drawn) : null;
}

/** @param {Element} element @returns {SeenTiming} */
const seenTiming = element => ({ decrypt: duration(element, '--duration-decrypt'),
  stagger: duration(element, '--duration-decrypt-stagger'), base: duration(element, '--duration-base'),
  fast: duration(element, '--duration-fast'), ease: getComputedStyle(element).getPropertyValue('--ease-out').trim() || 'ease-out' });

/**
 * @param {number} ms
 * @param {{ index: number, length: number, toModel: boolean }} turning
 * @param {Pick<SeenTiming, 'decrypt' | 'stagger'>} timing
 */
export function seenStep(ms, { index, length, toModel }, { decrypt, stagger }) {
  const begins = index * stagger;
  const t = Math.min(1, Math.max(0, (ms - begins) / decrypt));
  const fillFrom = begins + (toModel ? 0 : FILL_LEAVES * decrypt);
  return {
    begun: ms >= begins,
    done: t >= 1,
    locked: Math.floor(Math.max(0, (t - LOCK_FROM) / (1 - LOCK_FROM)) * length),
    fill: ms >= fillFrom === toModel ? 1 : 0,
  };
}

/**
 * @param {string} target
 * @param {number} locked
 * @param {() => number} [random]
 */
export const ciphered = (target, locked, random = Math.random) => [...target.slice(locked)]
  .map(each => each === '\n' ? each : SEEN_CIPHER[Math.floor(random() * SEEN_CIPHER.length)]).join('');

/** @type {WeakMap<Element, number>} */
const running = new WeakMap();

/** @param {Element} piece @param {string} name */
const part = (piece, name) => /** @type {HTMLElement} */ (piece.querySelector(`:scope > .ck-seen__${name}`));

/** @param {HTMLElement} turn */
function detailsOf(turn) {
  /** @type {HTMLElement[][]} */
  const details = [];
  for (const piece of /** @type {NodeListOf<HTMLElement>} */ (turn.querySelectorAll('.ck-seen:not(.ck-seen--cite)'))) {
    if (piece.classList.contains('is-more') && details.length) details[details.length - 1].push(piece);
    else details.push([piece]);
  }
  return details;
}

/**
 * @param {HTMLElement} piece
 * @param {boolean} said
 */
function layerOf(piece, said) {
  const held = piece.classList.contains('ck-seen--held');
  const layer = part(piece, said ? 'said' : 'words');
  return { html: said && held ? standIn(layer.textContent ?? '') : layer.innerHTML,
    text: layer.textContent ?? '', held };
}

/**
 * @param {HTMLElement} piece
 * @param {boolean} said
 */
function pin(piece, said) {
  piece.classList.toggle('is-said', said);
  piece.classList.toggle('is-words', !said);
  if (piece.classList.contains('ck-seen--held')) {
    piece.classList.toggle('is-filled', said);
    piece.classList.toggle('is-unfilled', !said);
  }
}

/** @param {HTMLElement} piece */
function unpin(piece) {
  for (const glide of piece.getAnimations()) glide.cancel();
  piece.classList.remove('is-said', 'is-words', 'is-filled', 'is-unfilled', 'is-turning');
  piece.style.width = '';
  part(piece, 'run').replaceChildren();
}

/**
 * @param {HTMLElement} piece
 * @param {boolean} from
 * @param {boolean} toModel
 * @param {SeenTiming} timing
 */
function begin(piece, from, toModel, { base, ease }) {
  const run = part(piece, 'run');
  const was = layerOf(piece, from);
  const to = layerOf(piece, toModel);
  piece.classList.add('is-turning');
  run.innerHTML = was.html;
  const width = piece.getBoundingClientRect().width;
  run.innerHTML = to.html;
  const target = piece.getBoundingClientRect().width;
  piece.style.width = `${target}px`;
  piece.animate([{ width: `${width}px` }, { width: `${target}px` }], { duration: base, easing: ease });
  piece.classList.remove('is-said', 'is-words');
  return { run, to };
}

/**
 * @param {HTMLElement} turn
 * @param {boolean} on
 */
function flipPhotos(turn, on) {
  if (!on) return;
  for (const covered of /** @type {NodeListOf<HTMLImageElement>} */ (turn.querySelectorAll('.ck-seen-pic__said img'))) {
    if (!covered.getAttribute('src')) covered.src = covered.dataset.src ?? '';
  }
}

/**
 * @param {HTMLElement} turn
 * @param {boolean} on
 */
function flipEye(turn, on) {
  const eye = turn.querySelector('[data-ck-seen-eye]');
  if (!eye) return;
  eye.setAttribute('aria-pressed', String(on));
  eye.classList.toggle('is-on', on);
  if (on) eye.removeAttribute('title');
  else eye.setAttribute('title', 'Show what the model saw');
}

/**
 * @param {HTMLElement} piece
 * @param {boolean} model
 */
const showsSaid = (piece, model) => piece.classList.contains('is-said') || (model && !piece.classList.contains('is-words'));

/**
 * @param {HTMLElement} turn
 * @param {boolean} on
 */
export function flipSeen(turn, on) {
  cancelAnimationFrame(running.get(turn) ?? 0);
  const was = turn.classList.contains('is-model');
  const details = detailsOf(turn);
  const from = details.map(pieces => pieces.map(piece => showsSaid(piece, was)));
  for (const [at, pieces] of details.entries()) {
    pieces.forEach((piece, place) => {
      unpin(piece);
      if (from[at][place] !== on) pin(piece, from[at][place]);
    });
  }
  turn.classList.toggle('is-model', on);
  flipEye(turn, on);
  flipPhotos(turn, on);
  const timing = seenTiming(turn);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    for (const pieces of details) {
      for (const piece of pieces) {
        const changes = piece.classList.contains('is-said') || piece.classList.contains('is-words');
        unpin(piece);
        if (changes) piece.animate([{ opacity: 0 }, { opacity: 1 }], { duration: timing.fast, easing: 'linear' });
      }
    }
    return;
  }
  const turning = details.map(pieces => pieces.map(piece => piece.classList.contains('is-said') || piece.classList.contains('is-words')));
  /** @type {Map<HTMLElement, { run: HTMLElement, to: { html: string, text: string, held: boolean } }>} */
  const begun = new Map();
  /** @type {Map<HTMLElement, number>} */
  const ticks = new Map();
  const started = performance.now();
  /** @param {number} now */
  const frame = now => {
    const ms = now - started;
    let left = false;
    details.forEach((pieces, index) => pieces.forEach((piece, place) => {
      if (!turning[index][place]) return;
      const to = begun.get(piece)?.to ?? layerOf(piece, on);
      const step = seenStep(ms, { index, length: to.text.length, toModel: on }, timing);
      if (!step.begun) {
        left = true;
        return;
      }
      if (piece.classList.contains('ck-seen--break')) {
        unpin(piece);
        turning[index][place] = false;
        return;
      }
      const turned = begun.get(piece) ?? begun.set(piece, begin(piece, from[index][place], on, timing)).get(piece);
      if (!turned) return;
      if (to.held && step.fill === (on ? 1 : 0)) piece.classList.remove('is-filled', 'is-unfilled');
      if (step.done) {
        turning[index][place] = false;
        unpin(piece);
        return;
      }
      left = true;
      const tick = Math.floor((ms - index * timing.stagger) / TICK_MS);
      if (tick === ticks.get(piece)) return;
      ticks.set(piece, tick);
      const head = esc(to.text.slice(0, step.locked));
      const tail = `<span class="ck-seen__cx">${esc(ciphered(to.text, step.locked))}</span>`;
      turned.run.innerHTML = on && to.held ? `<span class="ck-stand">${head}${tail}</span>` : head + tail;
    }));
    if (left) running.set(turn, requestAnimationFrame(frame));
    else running.delete(turn);
  };
  running.set(turn, requestAnimationFrame(frame));
}

/** @param {{ attrs?: import('../../lib/html.js').Attributes, on?: boolean }} eye */
export const seenEye = ({ attrs = {}, on = false }) => `<button${attributes({ type: 'button',
  class: `ck-seen-eye${on ? ' is-on' : ''}`, 'aria-label': 'What the model saw', 'aria-pressed': String(on),
  title: on ? null : 'Show what the model saw', 'data-ck-seen-eye': '', ...attrs })}>`
  + icon('visible', { className: 'ck-seen-eye__glyph' })
  + '<span class="ck-seen-eye__words mac-body" aria-hidden="true"><span>What the model saw</span></span></button>';
