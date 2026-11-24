// @ts-check
import { esc } from '../../lib/html.js';
import { icon } from './icon.js';

/**
 * @param {object} zone
 * @param {string} zone.words
 * @param {string} zone.line
 * @param {string} [zone.act]
 * @param {string} [zone.elsewhere]
 */
export function dropZone({ words, line, act = '', elsewhere = '' }) {
  return `<section class="ck-drop${act ? '' : ' ck-drop--still'}" data-ck-drop>`
    + `<span class="ck-drop__icon" aria-hidden="true">${icon('archive', { size: 'sm' })}</span>`
    + `<div class="ck-drop__foot"><p class="ck-drop__words mac-body">${esc(words)}</p><p class="ck-drop__line mac-subhead">${esc(line)}</p></div>`
    + (act ? `<span class="ck-drop__act">${act}</span>`
      : elsewhere ? `<p class="ck-drop__elsewhere mac-subhead">${esc(elsewhere)}</p>` : '')
    + '</section>';
}

/** @param {HTMLElement} root */
export function installDropZones(root) {
  /** @type {Map<Element, number>} */
  const inside = new Map();
  /** @param {Event} event */
  const zoneOf = event => /** @type {Element | null} */ (event.target instanceof Element ? event.target.closest('[data-ck-drop]') : null);
  /** @param {DragEvent} event */
  const files = event => [...event.dataTransfer?.types ?? []].includes('Files');
  /** @param {Element} zone @param {number} count */
  const set = (zone, count) => {
    if (count > 0) inside.set(zone, count);
    else inside.delete(zone);
    zone.classList.toggle('is-over', count > 0);
  };
  /** @param {DragEvent} event */
  const enter = event => {
    const zone = zoneOf(event);
    if (!zone || zone.classList.contains('ck-drop--still') || !files(event)) return;
    set(zone, (inside.get(zone) ?? 0) + 1);
  };
  /** @param {DragEvent} event */
  const leave = event => {
    const zone = zoneOf(event);
    if (zone && inside.has(zone)) set(zone, (inside.get(zone) ?? 1) - 1);
  };
  /** @param {DragEvent} event */
  const over = event => {
    if (!files(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = zoneOf(event) ? 'copy' : 'none';
  };
  /** @param {DragEvent} event */
  const dropped = event => {
    if (!files(event)) return;
    event.preventDefault();
    for (const zone of [...inside.keys()]) set(zone, 0);
  };
  const listeners = /** @type {const} */ ([['dragenter', enter], ['dragleave', leave], ['dragover', over], ['drop', dropped]]);
  for (const [name, listener] of listeners) root.addEventListener(name, /** @type {EventListener} */ (listener));
  return () => {
    for (const [name, listener] of listeners) root.removeEventListener(name, /** @type {EventListener} */ (listener));
    for (const zone of [...inside.keys()]) set(zone, 0);
  };
}
