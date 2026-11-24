// @ts-check
/** @import { Host } from '../lib/host.js' */

const BAND = '[data-window-drag]';
const INTERACTIVE = 'a, button, input, select, textarea, [role=button], [role=switch], [role=tab], [role=option], '
  + '[role^=menu], [data-no-drag]';
const SLOP = 3;

/**
 * @typedef {{ target: EventTarget | null, button: number, buttons: number, clientX: number, clientY: number,
 *   metaKey: boolean, ctrlKey: boolean, altKey: boolean, shiftKey: boolean }} Pointer
 */

/** @param {Pointer} event */
export function onBand(event) {
  const target = /** @type {Element | null} */ (event.target);
  if (typeof target?.closest !== 'function') return false;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  return target.closest(BAND) !== null && target.closest(INTERACTIVE) === null;
}

/**
 * @param {{ addEventListener(type: string, listener: (event: Pointer) => void): void }} doc
 * @param {Pick<Host, 'act'>} host
 */
export function installWindowBands(doc, host) {
  /** @type {{ x: number, y: number } | null} */
  let armed = null;
  /** @param {'drag' | 'zoom'} what */
  const ask = what => void host.act({ act: 'window', do: what }).catch(() => undefined);
  doc.addEventListener('mousedown', event => {
    armed = onBand(event) ? { x: event.clientX, y: event.clientY } : null;
  });
  doc.addEventListener('mousemove', event => {
    if (!armed) return;
    if ((event.buttons & 1) === 0) {
      armed = null;
      return;
    }
    if (Math.hypot(event.clientX - armed.x, event.clientY - armed.y) <= SLOP) return;
    armed = null;
    ask('drag');
  });
  doc.addEventListener('mouseup', () => {
    armed = null;
  });
  doc.addEventListener('dblclick', event => {
    if (onBand(event)) ask('zoom');
  });
}
