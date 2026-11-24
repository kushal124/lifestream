// @ts-check
import { attributes, esc } from '../../lib/html.js';

/** @typedef {'s1' | 's2' | 's3' | 's4' | 's5' | 'other' | 'own' | 'uncounted' | 'disk' | 'free'} Tone */

/** @typedef {{ id: string, name: string, tone: Tone, share: number, size: string }} DiskPart */

/** @param {Tone} tone */
export const toneClass = tone => `ck-tone--${tone}`;

/**
 * @param {object} bar
 * @param {string} bar.label
 * @param {DiskPart[]} bar.parts
 * @param {{ id: string, name: string, tone: Tone }[]} bar.key
 * @param {string} [bar.time]
 */
export function diskBar({ label, parts, key, time = '' }) {
  const drawn = parts.map(part => `<i${attributes({
    class: `ck-disk__part ${toneClass(part.tone)}`,
    title: `${part.name} · ${part.size}`,
    'data-part': part.id || null,
    'data-glide': part.tone === 'free' ? null : part.id || part.tone,
    'data-geo': part.tone === 'free' ? null : `flex-basis:${Math.max(0, part.share).toFixed(3)}%`,
  })}></i>`).join('');
  const keyed = key.map(each => `<span${attributes({ class: 'ck-disk__name', 'data-part': each.id || null })}>`
    + `<i class="ck-dot ${toneClass(each.tone)}" aria-hidden="true"></i>${esc(each.name)}</span>`).join('');
  return `<div class="ck-disk">`
    + `<div${attributes({ class: 'ck-disk__bar', role: 'img', 'aria-label': label })}>${drawn}</div>`
    + `<div class="ck-disk__key mac-footnote">${keyed}`
    + (time ? `<span class="ck-disk__time" data-disk-time>${esc(time)}</span>` : '') + '</div></div>';
}

/**
 * @param {ParentNode} root
 * @returns {Map<string, string>}
 */
export const barWidths = root => new Map([...root.querySelectorAll('.ck-disk__part[data-glide]')].map(each => [
  /** @type {HTMLElement} */ (each).dataset.glide ?? '', /** @type {HTMLElement} */ (each).style.flexBasis]));

/**
 * @param {ParentNode} root
 * @param {Map<string, string>} before
 */
export function glide(root, before) {
  if (!before.size) return;
  const moving = [...root.querySelectorAll('.ck-disk__part[data-glide]')].map(each => /** @type {HTMLElement} */ (each))
    .map(part => ({ part, from: before.get(part.dataset.glide ?? '') ?? '', to: part.style.flexBasis }))
    .filter(each => each.from && each.from !== each.to);
  if (!moving.length) return;
  for (const { part, from } of moving) {
    part.classList.add('is-held');
    part.style.flexBasis = from;
  }
  void /** @type {HTMLElement} */ (moving[0].part).offsetWidth;
  for (const { part, to } of moving) {
    part.classList.remove('is-held');
    part.style.flexBasis = to;
  }
}

/**
 * @param {HTMLElement} root
 * @returns {() => void}
 */
export function installLights(root) {
  let pointed = '';
  /** @param {Element} lights @param {string} id */
  const light = (lights, id) => {
    const parts = [...lights.querySelectorAll('[data-part]')].map(each => /** @type {HTMLElement} */ (each));
    const lit = id !== '' && parts.some(each => each.dataset.part === id);
    lights.classList.toggle('is-dimmed', lit);
    for (const each of parts) each.classList.toggle('is-lit', lit && each.dataset.part === id);
  };
  root.addEventListener('pointerover', event => {
    const target = /** @type {Element} */ (event.target);
    const lights = target.closest('[data-lights]');
    const part = /** @type {HTMLElement | null} */ (target.closest('[data-part]'));
    if (!lights) return;
    pointed = part && lights.contains(part) ? part.dataset.part ?? '' : '';
    light(lights, pointed);
  });
  root.addEventListener('pointerout', event => {
    const lights = /** @type {Element} */ (event.target).closest('[data-lights]');
    const into = /** @type {Element | null} */ (event.relatedTarget);
    if (!lights || into?.closest('[data-lights] [data-part]')) return;
    pointed = '';
    light(lights, '');
  });
  return () => {
    if (!pointed) return;
    for (const lights of root.querySelectorAll('[data-lights]')) light(lights, pointed);
  };
}

/** @type {Tone[]} */
const KIND_TONES = ['s1', 's2', 's3', 's4', 's5'];

/**
 * @param {object} figure
 * @param {string} figure.n
 * @param {string} figure.words
 * @param {{ id: string, name: string, n: number }[]} figure.parts
 * @param {string} figure.other
 */
export function amountBar({ n, words, parts, other }) {
  const shown = parts.length > KIND_TONES.length + 1 ? parts.slice(0, KIND_TONES.length) : parts;
  const rest = parts.slice(shown.length);
  const all = [...shown.map((part, at) => ({ ...part, tone: KIND_TONES[at] ?? /** @type {Tone} */ ('other') })),
    ...rest.length ? [{ id: 'other', name: other, n: rest.reduce((sum, part) => sum + part.n, 0), tone: /** @type {Tone} */ ('other') }] : []];
  const total = all.reduce((sum, part) => sum + part.n, 0);
  const named = all.map(part => ({ id: part.id, name: `${part.name} ${part.n.toLocaleString('en-GB')}`, tone: part.tone }));
  return '<div class="ck-amount">'
    + `<p class="ck-amount__figure"><span class="ck-week__n mac-display">${esc(n)}</span>`
    + `<span class="ck-week__unit mac-body">${esc(words)}</span></p>`
    + (total > 0 ? diskBar({ label: `${n} ${words}`, key: named,
      parts: all.map((part, at) => ({ ...part, size: named[at].name, share: part.n / total * 100 })) }) : '') + '</div>';
}
