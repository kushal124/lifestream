// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { icon } from './icon.js';

/** @param {{ label: string, text: string, id?: string }} tip */
export function tip({ label, text, id: key = '' }) {
  const id = `ck-tip-${(key || label).toLowerCase().replace(/[^a-z0-9]+/gu, '-')}`;
  return '<span class="ck-tip">'
    + `<button${attributes({ type: 'button', class: 'ck-tip__mark', 'aria-label': `About ${label}`,
      'aria-describedby': id })}>${icon('info', { size: 'xs' })}</button>`
    + `<span class="ck-tip__bubble mac-subhead" role="tooltip"${attributes({ id })}>${esc(text)}</span></span>`;
}

const GAP = 8;
const EDGE = 8;
const ARROW = 12;
const WIDEST = 260;
let open = /** @type {Element | null} */ (null);

/** @param {Element} tip */
function place(tip) {
  const mark = tip.querySelector('.ck-tip__mark');
  const bubble = tip.querySelector('.ck-tip__bubble');
  if (!mark || !(bubble instanceof HTMLElement) || getComputedStyle(bubble).position !== 'fixed') return;
  open = tip;
  const at = mark.getBoundingClientRect();
  let box = { top: 0, left: 0, right: innerWidth, bottom: innerHeight };
  for (let part = tip.parentElement; part; part = part.parentElement) {
    const style = getComputedStyle(part);
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
    const clip = part.getBoundingClientRect();
    box = { top: Math.max(box.top, clip.top), left: Math.max(box.left, clip.left), right: Math.min(box.right, clip.right),
      bottom: Math.min(box.bottom, clip.bottom) };
  }
  bubble.classList.toggle('is-away', at.bottom <= box.top || at.top >= box.bottom || at.right <= box.left
    || at.left >= box.right);
  bubble.style.maxWidth = `${Math.max(0, Math.min(WIDEST, box.right - box.left - 2 * EDGE))}px`;
  bubble.style.left = '0px';
  bubble.style.top = '0px';
  const origin = bubble.getBoundingClientRect();
  const middle = at.left + at.width / 2;
  const below = at.top - GAP - origin.height < box.top && at.bottom + GAP + origin.height <= box.bottom;
  const left = Math.max(box.left + EDGE, Math.min(middle - origin.width / 2, box.right - EDGE - origin.width));
  const top = below ? at.bottom + GAP : at.top - GAP - origin.height;
  bubble.classList.toggle('is-below', below);
  bubble.style.left = `${Math.round(left - origin.left)}px`;
  bubble.style.top = `${Math.round(top - origin.top)}px`;
  bubble.style.setProperty('--ck-tip-arrow',
    `${Math.round(Math.min(Math.max(middle - left, ARROW), origin.width - ARROW))}px`);
}

function again() {
  if (open?.isConnected && (open.matches(':hover') || open.querySelector('.ck-tip__mark:focus-visible'))) place(open);
}

if (typeof document !== 'undefined') {
  for (const name of ['pointerover', 'focusin']) {
    document.addEventListener(name, event => {
      const tip = event.target instanceof Element ? event.target.closest('.ck-tip') : null;
      if (tip) place(tip);
    });
  }
  document.addEventListener('scroll', again, { capture: true, passive: true });
  document.defaultView?.addEventListener('resize', again);
}
