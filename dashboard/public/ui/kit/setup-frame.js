// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { icon } from './icon.js';

/** @typedef {import('../../lib/html.js').Attributes} Attributes */

/**
 * @param {object} frame
 * @param {string} frame.band
 * @param {string} frame.head
 * @param {string} frame.body
 * @param {string} frame.foot
 * @param {string} [frame.className]
 */
export const setupFrame = ({ band, head, body, foot, className = '' }) => `<div${attributes({
  class: `ck-onb${className ? ` ${className}` : ''}` })}>`
  + `<header class="ck-onb__band" data-window-drag>${band}</header>`
  + '<div class="ck-onb__stage"><div class="ck-onb__col">'
  + `<div class="ck-onb__head">${head}</div><div class="ck-onb__body">${body}</div>`
  + `<footer class="ck-onb__foot">${foot}</footer></div></div></div>`;

/**
 * @param {{ brand: boolean, at: number, of: number }} band
 */
export const setupBand = ({ brand, at, of }) => `<span${attributes({ class: `ck-onb__mark ck-onb__brand${brand ? '' : ' is-hidden'}`,
  role: brand ? 'img' : null, 'aria-label': brand ? 'Lifestream' : null, 'aria-hidden': brand ? null : 'true' })}></span>`
  + `<span class="ck-onb__dots" role="img"${attributes({ 'aria-label': `Step ${at + 1} of ${of}` })}>`
  + Array.from({ length: of }, (_, index) => `<i${attributes({ class: index < at ? 'is-done' : index === at ? 'is-here' : null })}></i>`)
    .join('') + '</span>';

/**
 * @param {{ title: string, sub?: string, eyebrow?: string, hero?: boolean, live?: boolean }} head
 */
export const setupHead = ({ title, sub = '', eyebrow = '', hero = false, live = false }) => (eyebrow
  ? `<span class="ck-onb__eyebrow">${esc(eyebrow)}</span>` : '')
  + `<h1${attributes({ class: hero ? 'ck-onb__hero' : 'ck-onb__title', role: live ? 'status' : null })}>${esc(title)}</h1>`
  + (sub ? `<p class="ck-onb__sub">${esc(sub)}</p>` : '');

/**
 * @param {{ back?: string, note?: string, end?: string }} foot
 */
export const setupFoot = ({ back = '', note = '', end = '' }) => `<span class="ck-onb__back">${back}</span>`
  + `<span class="ck-onb__note">${note}</span><span class="ck-onb__end">${end}</span>`;

/**
 * @param {string[]} rows
 * @param {{ label?: string, className?: string, attrs?: Attributes }} [options]
 */
export const setupSheet = (rows, { label = '', className = '', attrs = {} } = {}) => `<ul${attributes({
  class: `ck-onb__sheet${className ? ` ${className}` : ''}`, 'aria-label': label || null, ...attrs })}>${rows.join('')}</ul>`;

/**
 * @param {string} markup
 * @param {{ className?: string, attrs?: Attributes }} [options]
 */
export const setupUnder = (markup, { className = '', attrs = {} } = {}) => `<li${attributes({
  class: `ck-onb__under${className ? ` ${className}` : ''}`, ...attrs })}>${markup}</li>`;

/** @param {string} words */
export const setupGranted = words => `<span class="ck-onb__granted mac-headline">${icon('done', { size: 'xs' })}<span>${esc(words)}</span></span>`;

/**
 * @param {object} chip
 * @param {string} chip.name
 * @param {string} chip.icon
 * @param {boolean} chip.on
 * @param {string} [chip.count]
 * @param {boolean} [chip.disabled]
 * @param {string} [chip.title]
 * @param {Attributes} [chip.attrs]
 */
export const setupChip = ({ name, icon: meaning, on, count = '', disabled = false, title = '', attrs = {} }) => `<button${attributes({
  type: 'button', class: `ck-onb__chip${on ? '' : ' is-off'}`, role: 'checkbox', 'aria-checked': String(on), disabled,
  title: title || null, ...attrs })}>${icon(meaning, { size: 'sm' })}<span class="ck-onb__chip-name">${esc(name)}</span>`
  + (count ? `<span class="ck-onb__chip-count">${esc(count)}</span>` : '') + '</button>';

/** @param {number} at */
export const setupChipReading = at => `<span class="ck-onb__chip is-reading" aria-hidden="true"><i data-geo="width:${
  [64, 48, 56, 72, 52][at % 5]}px"></i></span>`;

/**
 * @param {{ name: string, icon: string }} item
 */
export const setupNever = ({ name, icon: meaning }) => `<li class="ck-onb__never">${icon(meaning, { size: 'xs' })}${esc(name)}</li>`;

/**
 * @param {{ label: string, on: boolean, disabled?: boolean, attrs?: Attributes }} check
 */
export const setupCheck = ({ label, on, disabled = false, attrs = {} }) => `<button${attributes({ type: 'button',
  class: `ck-onb__check${on ? ' is-on' : ''}`, role: 'checkbox', 'aria-checked': String(on), disabled, ...attrs })}>`
  + `<span class="ck-onb__box" aria-hidden="true">${icon('done', { size: 'xs' })}</span><span>${esc(label)}</span></button>`;

/**
 * @param {{ words: string }} wait
 */
export const setupWait = ({ words }) => `<span class="ck-onb__wait" role="status"><span class="ck-spinner" aria-hidden="true">`
  + `</span>${esc(words)}</span>`;
