// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { button } from './button.js';
import { signalShape } from './signal.js';
import { bar } from './skeleton.js';

/** @typedef {{ label: string, busy?: boolean, attrs: import('../../lib/html.js').Attributes }} PathAct */

/**
 * @typedef {object} PillPopoverOptions
 * @property {string} key
 * @property {string} label
 * @property {number | null} count
 * @property {boolean} open
 * @property {string} body
 * @property {import('../../lib/html.js').Attributes} [attrs]
 */

/** @param {PillPopoverOptions} pill */
export function pillPopover({ key, label, count, open, body, attrs = {} }) {
  const id = `ck-pop-${key}`;
  return `<div class="ck-pillpop" data-pop="${esc(key)}">`
    + `<button${attributes({ type: 'button', class: `ck-pill${open ? ' is-open' : ''}`, 'aria-expanded': String(open),
      'aria-haspopup': 'dialog', 'aria-controls': open ? id : null, ...attrs })}>`
    + `<span class="ck-pill__label mac-headline">${esc(label)}</span>`
    + `<span class="ck-pill__count mac-mono-data">${count === null ? bar(1) : esc(count.toLocaleString('en-US'))}</span></button>`
    + (open ? `<div${attributes({ class: 'ck-popover', id, role: 'dialog', 'aria-label': label, tabindex: '-1' })}>${body}</div>` : '')
    + '</div>';
}

/**
 * @typedef {object} PathLink
 * @property {'done' | 'warning' | 'caution' | 'unchecked'} state
 * @property {string} name
 * @property {string} [value]
 * @property {string} [fix]
 * @property {PathAct} [act]
 */

/** @param {{ title: string, meta?: string, links: PathLink[], foot?: PathAct | null, label?: string, said?: string }} checklist */
export function pathChecklist({ title, meta = '', links, foot = null, label = title, said = '' }) {
  return `<div${attributes({ class: 'ck-popover ck-path', role: 'dialog', 'aria-label': label, tabindex: '-1' })}>`
    + `<div class="ck-path__head"><p class="ck-path__title mac-headline">${esc(title)}</p>`
    + (meta ? `<p class="ck-path__meta mac-footnote">${esc(meta)}</p>` : '') + '</div>'
    + links.map(link => `<div class="ck-path__row">`
      + `<span class="ck-path__mark">${link.state === 'unchecked' ? '<span class="ck-path__ring"></span>'
        : signalShape(link.state, { size: 14 })}</span>`
      + `<span class="ck-path__words"><span class="ck-path__name mac-body">${esc(link.name)}</span>`
      + (link.fix ? `<span class="ck-path__fix mac-footnote">${esc(link.fix)}</span>` : '') + '</span>'
      + `<span class="ck-path__end">${link.act ? button(link.act.label, { size: 'sm', busy: link.act.busy ?? false, attrs: link.act.attrs })
        : `<span class="mac-body">${esc(link.value ?? '')}</span>`}</span></div>`).join('')
    + (said || foot ? `<div class="ck-path__foot">${said}${foot ? button(foot.label, { variant: 'primary', size: 'sm',
      busy: foot.busy ?? false, attrs: foot.attrs }) : ''}</div>` : '')
    + '</div>';
}

/**
 * @param {HTMLElement} root
 * @param {{ close?: () => void }} [options]
 * @returns {() => void}
 */
export function popoverFocus(root, { close } = {}) {
  /** @type {{ panel: HTMLElement, opener: number } | null} */
  let held = null;
  const openers = () => /** @type {HTMLElement[]} */ ([...root.querySelectorAll('[aria-haspopup="dialog"]')]);
  if (close) {
    root.ownerDocument.addEventListener('keydown', event => {
      if (!held || event.key !== 'Escape') return;
      event.preventDefault();
      close();
    });
  }
  return () => {
    const panel = /** @type {HTMLElement | null} */ (root.querySelector('.ck-popover:not(.is-leaving)'));
    const opener = panel ? openers().findIndex(each => each.getAttribute('aria-expanded') === 'true') : -1;
    const active = root.ownerDocument.activeElement;
    if (panel && (!held || held.opener !== opener)) {
      if (!panel.contains(active)) panel.focus({ preventScroll: true });
    } else if (!panel && held) {
      const lost = !active || active === root.ownerDocument.body || !active.isConnected || held.panel.contains(active);
      if (lost) openers()[held.opener]?.focus({ preventScroll: true });
    }
    held = panel ? { panel, opener } : null;
  };
}
