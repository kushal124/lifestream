// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { floatList } from './float-list.js';
import { icon } from './icon.js';

/** @typedef {import('../../lib/html.js').Attributes} Attributes */
/** @typedef {{ value: string, label: string, icon?: string, count?: number, least?: boolean, tag?: string, parted?: boolean }} FilterChoice */

/**
 * @param {object} menu
 * @param {string} menu.name
 * @param {string} menu.all
 * @param {FilterChoice[]} menu.choices
 * @param {string} menu.value
 * @param {Attributes} [menu.attrs]
 * @param {'start' | 'end'} [menu.align]
 * @param {number} [menu.active]
 * @param {boolean} [menu.waiting]
 */
export function filterMenu({ name, all, choices, value, attrs = {}, align = 'end', active, waiting = false }) {
  /** @type {FilterChoice[]} */
  const items = [{ value: '', label: all, icon: '', count: undefined }, ...waiting ? [] : choices];
  const named = [...items, ...waiting ? choices : []].find(item => item.value === value && item.value !== '');
  const chosen = waiting ? undefined : named;
  const id = `ck-fm-${name.replace(/\W+/gu, '-').toLowerCase()}`;
  const open = active !== undefined;
  return `<div class="ck-fmenu${open ? '' : ' ck-fmenu--float'}${align === 'start' ? ' ck-fmenu--start' : ''}"${attributes(attrs)}>`
    + `<span class="ck-fmenu__pill${chosen ? ' is-chosen' : ''}${waiting ? ' is-waiting' : ''}">`
    + `<button${attributes({
      type: 'button', class: 'ck-fmenu__btn mac-subhead', disabled: waiting, 'aria-haspopup': 'menu',
      'aria-expanded': String(open),
      'aria-controls': `${id}-menu`, 'aria-label': `${name}, ${named?.label ?? all}`,
      'aria-activedescendant': open ? `${id}-${active}` : null,
    })}>${named?.icon ? icon(named.icon) : ''}<span>${esc(named?.label ?? all)}</span>`
    + `${icon('expand', { size: 'xs', className: 'ck-fmenu__caret' })}</button>`
    + (chosen ? `<button${attributes({ type: 'button', class: 'ck-fmenu__clear', 'aria-label': `Clear ${name}` })}>`
      + `${icon('clear', { size: 'sm' })}</button>` : '') + '</span>'
    + floatList({
      label: name, role: 'menu', className: 'ck-fmenu__panel', lit: open ? active : null,
      attrs: { id: `${id}-menu`, hidden: !open },
      items: items.map((item, index) => ({
        name: item.label, icon: item.icon || undefined, count: item.count, least: item.least, tag: item.tag,
        chosen: item.value === value,
        disabled: item.count === 0, parted: index === 0 || item.parted === true,
        attrs: { id: `${id}-${index}`, 'data-value': item.value, class: 'ck-fmenu__item' },
      })),
    }) + '</div>';
}

/** @typedef {{ value: string, label: string, count?: string, spoken?: string }} ChipChoice */

/**
 * @param {object} chips
 * @param {string} chips.label
 * @param {ChipChoice[]} chips.choices
 * @param {string} chips.value
 * @param {string} [chips.end]
 * @param {boolean} [chips.clears]
 * @param {Attributes} [chips.attrs]
 */
export function filterChips({ label, choices, value, end = '', clears = false, attrs = {} }) {
  const chosen = (/** @type {ChipChoice} */ choice) => choice.value === value;
  return `<div${attributes({ class: 'ck-fchips', ...attrs })}>`
    + `<div${attributes({ class: 'ck-fchips__row', role: clears ? 'group' : 'radiogroup', 'aria-label': label,
      'data-chips-clear': clears ? '' : null })}>`
    + choices.map(choice => `<button${attributes({
      type: 'button', class: `ck-fchip mac-subhead${chosen(choice) ? ' is-chosen' : ''}`, role: clears ? null : 'radio',
      'aria-checked': clears ? null : String(chosen(choice)), 'aria-pressed': clears ? String(chosen(choice)) : null,
      'data-value': choice.value, 'aria-label': choice.spoken ? `${choice.label}, ${choice.spoken}` : null,
    })}>${esc(choice.label)}${choice.count ? `<span class="ck-fchip__count">${esc(choice.count)}</span>` : ''}</button>`).join('')
    + `</div>${end}</div>`;
}

/** @param {Element} chip */
export const chipPick = chip => chip.closest('[data-chips-clear]') && chip.classList.contains('is-chosen') ? ''
  : chip.getAttribute('data-value') ?? '';

/** @param {HTMLElement} menu */
const parts = menu => ({
  button: /** @type {HTMLButtonElement} */ (menu.querySelector('.ck-fmenu__btn')),
  panel: /** @type {HTMLElement} */ (menu.querySelector('.ck-fmenu__panel')),
  items: /** @type {HTMLElement[]} */ ([...menu.querySelectorAll('.ck-fmenu__item')]),
  find: /** @type {HTMLInputElement | null} */ (menu.querySelector('.ck-fmenu__find')),
});
/** @param {HTMLElement} item */
const enabled = item => item.getAttribute('aria-disabled') !== 'true' && !item.hidden;

/** @param {HTMLElement} menu */
function room(menu) {
  const view = menu.ownerDocument.defaultView ?? window;
  const frame = menu.closest('.ck-dialog')?.getBoundingClientRect();
  return { top: Math.max(0, frame?.top ?? 0) + 8, bottom: Math.min(view.innerHeight, frame?.bottom ?? view.innerHeight) - 8,
    left: Math.max(0, frame?.left ?? 0) + 8, right: Math.min(view.innerWidth, frame?.right ?? view.innerWidth) - 8 };
}

/** @param {HTMLElement} menu */
function place(menu) {
  const { button, panel } = parts(menu);
  const at = (menu.querySelector('[data-menu-at]') ?? menu.closest('[data-menu-anchor]') ?? button).getBoundingClientRect();
  const box = room(menu);
  panel.style.minWidth = `${Math.max(220, Math.round(at.width))}px`;
  panel.style.maxHeight = '';
  panel.style.top = panel.style.left = '0px';
  const zero = panel.getBoundingClientRect();
  const { offsetWidth: width, offsetHeight: height } = panel;
  const under = box.bottom - at.bottom - 4;
  const over = at.top - 4 - box.top;
  const below = height <= under || under >= over;
  const tall = Math.min(height, below ? under : over);
  if (tall < height) panel.style.maxHeight = `${Math.floor(tall)}px`;
  const left = menu.classList.contains('ck-fmenu--start') && at.left + width <= box.right ? at.left : at.right - width;
  panel.style.top = `${Math.round((below ? at.bottom + 4 : at.top - 4 - tall) - zero.top)}px`;
  panel.style.left = `${Math.round(Math.max(box.left, Math.min(left, box.right - width)) - zero.left)}px`;
}

/**
 * @param {HTMLElement} menu
 * @param {number} index
 */
function activate(menu, index) {
  const { button, items } = parts(menu);
  items.forEach((item, at) => item.classList.toggle('is-lit', at === index));
  if (items[index]) button.setAttribute('aria-activedescendant', items[index].id);
}

/**
 * @param {HTMLElement} menu
 * @param {string | undefined} value
 */
export function relight(menu, value) {
  const { panel, items } = parts(menu);
  if (panel.hidden) return;
  const kept = items.findIndex(item => item.dataset.value === value && enabled(item));
  activate(menu, kept >= 0 ? kept : items.findIndex(enabled));
  if (menu.classList.contains('ck-fmenu--float')) place(menu);
}

/**
 * @param {HTMLElement} root
 * @param {(menu: HTMLElement, value: string) => void} pick
 * @returns {() => void}
 */
export function installFilterMenus(root, pick) {
  /** @param {HTMLElement} menu */
  const waits = menu => parts(menu).button.getAttribute('aria-disabled') === 'true';
  const view = root.ownerDocument.defaultView ?? window;

  const placed = new WeakSet();

  /** @param {HTMLElement} menu */
  function narrow(menu) {
    const { find, items } = parts(menu);
    const words = (find?.value ?? '').trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    for (const item of items) {
      const text = (item.textContent ?? '').toLocaleLowerCase();
      item.hidden = !words.every(word => text.includes(word));
    }
    activate(menu, items.findIndex(enabled));
  }

  /** @param {HTMLElement} menu */
  function show(menu) {
    for (const other of root.querySelectorAll('.ck-fmenu')) {
      if (other !== menu) close(/** @type {HTMLElement} */ (other));
    }
    const { button, panel, items, find } = parts(menu);
    const paged = Boolean(panel.querySelector('[data-ck-page-of]'));
    if (paged) turn(menu, '');
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    if (menu.classList.contains('ck-fmenu--float')) {
      place(menu);
      placed.add(menu);
    }
    if (!paged) activate(menu, Math.max(0, items.findIndex(item => item.getAttribute('aria-checked') === 'true')));
    items.find(item => item.classList.contains('is-lit'))?.scrollIntoView({ block: 'nearest' });
    if (find) {
      find.value = '';
      find.focus();
    } else button.focus({ preventScroll: true });
  }

  /** @param {HTMLElement} menu */
  function close(menu) {
    const { button, panel, find } = parts(menu);
    if (panel.hidden) return;
    placed.delete(menu);
    const inside = panel.contains(root.ownerDocument.activeElement);
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    button.removeAttribute('aria-activedescendant');
    if (find) {
      find.value = '';
      for (const item of parts(menu).items) item.hidden = false;
    }
    if (inside) button.focus();
    menu.dispatchEvent(new CustomEvent('ck-fmenu-closed', { bubbles: true }));
  }

  /**
   * @param {HTMLElement} menu
   * @param {string} page
   * @param {string} [on]
   */
  function turn(menu, page, on) {
    const { panel } = parts(menu);
    for (const each of /** @type {NodeListOf<HTMLElement>} */ (panel.querySelectorAll('[data-ck-page-of]'))) {
      each.hidden = each.dataset.ckPageOf !== page;
    }
    const { items } = parts(menu);
    const lit = [items.findIndex(item => enabled(item) && on !== undefined && item.dataset.value === on),
      items.findIndex(item => enabled(item) && item.getAttribute('aria-checked') === 'true'), items.findIndex(enabled)];
    activate(menu, lit.find(at => at >= 0) ?? 0);
    if (menu.classList.contains('ck-fmenu--float') && !panel.hidden) place(menu);
  }

  /**
   * @param {HTMLElement} menu
   * @param {HTMLElement | undefined} item
   */
  function choose(menu, item) {
    if (!item || !enabled(item)) return;
    if (item.dataset.ckPage !== undefined) return turn(menu, item.dataset.ckPage);
    close(menu);
    pick(menu, item.dataset.value ?? '');
  }

  /** @param {MouseEvent} event */
  const onClick = event => {
    const target = /** @type {Element} */ (event.target);
    const menu = /** @type {HTMLElement | null} */ (target.closest('.ck-fmenu'));
    if (!menu || !root.contains(menu)) return;
    const item = /** @type {HTMLElement | null} */ (target.closest('.ck-fmenu__item'));
    if (item) choose(menu, item);
    else if (target.closest('.ck-fmenu__clear')) {
      close(menu);
      pick(menu, '');
    }
    else if (target.closest('.ck-fmenu__btn')) {
      if (parts(menu).panel.hidden) {
        if (!waits(menu)) show(menu);
      }
      else close(menu);
    }
  };

  /** @param {MouseEvent} event */
  const onHover = event => {
    const item = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest('.ck-fmenu__item'));
    const menu = /** @type {HTMLElement | null} */ (item?.closest('.ck-fmenu') ?? null);
    if (item && menu && enabled(item)) activate(menu, parts(menu).items.indexOf(item));
  };

  /** @param {KeyboardEvent} event */
  const onKey = event => {
    const target = /** @type {Element} */ (event.target);
    const button = target.closest('.ck-fmenu__btn') ?? target.closest('.ck-fmenu__find');
    const menu = /** @type {HTMLElement | null} */ (button?.closest('.ck-fmenu') ?? null);
    if (!menu) return;
    const { panel, items } = parts(menu);
    if (panel.hidden) {
      if (['Enter', ' ', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        if (!waits(menu)) show(menu);
      }
      return;
    }
    const at = items.findIndex(item => item.classList.contains('is-lit'));
    if (event.key === 'Escape') {
      event.preventDefault();
      close(menu);
    } else if (event.key === 'Enter' || (event.key === ' ' && !target.matches('.ck-fmenu__find'))) {
      event.preventDefault();
      choose(menu, items[at]);
    } else if (event.key === 'ArrowRight' && items[at]?.dataset.ckPage !== undefined) {
      event.preventDefault();
      choose(menu, items[at]);
    } else if (event.key === 'ArrowLeft' && items[at] && items[at].dataset.ckPageOf) {
      event.preventDefault();
      const back = /** @type {HTMLElement | null} */ (panel.querySelector(`[data-ck-page="${items[at].dataset.ckPageOf}"]`));
      turn(menu, '', back?.dataset.value);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      let next = at + step;
      while (items[next] && !enabled(items[next])) next += step;
      if (items[next]) {
        activate(menu, next);
        items[next].scrollIntoView({ block: 'nearest' });
      }
    }
  };

  /** @param {Event} event */
  const onFind = event => {
    const find = /** @type {Element} */ (event.target).closest('.ck-fmenu__find');
    const menu = /** @type {HTMLElement | null} */ (find?.closest('.ck-fmenu') ?? null);
    if (menu) narrow(menu);
  };

  /** @param {Event} event */
  const onScroll = event => {
    const moved = /** @type {Node} */ (event.target);
    for (const menu of root.querySelectorAll('.ck-fmenu--float')) {
      const { panel } = parts(/** @type {HTMLElement} */ (menu));
      if (placed.has(menu) && !panel.hidden && !panel.contains(moved) && moved.contains?.(menu)) close(/** @type {HTMLElement} */ (menu));
    }
  };

  const onResize = () => {
    for (const menu of root.querySelectorAll('.ck-fmenu--float')) {
      if (placed.has(menu) && !parts(/** @type {HTMLElement} */ (menu)).panel.hidden) place(/** @type {HTMLElement} */ (menu));
    }
  };

  /** @param {PointerEvent} event */
  const onOutside = event => {
    for (const menu of root.querySelectorAll('.ck-fmenu')) {
      if (!menu.contains(/** @type {Node} */ (event.target))) close(/** @type {HTMLElement} */ (menu));
    }
  };

  const doc = root.ownerDocument;
  root.addEventListener('click', onClick);
  root.addEventListener('mouseover', onHover);
  root.addEventListener('keydown', onKey);
  root.addEventListener('input', onFind);
  doc.addEventListener('pointerdown', onOutside);
  doc.addEventListener('scroll', onScroll, true);
  view.addEventListener('resize', onResize);
  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('mouseover', onHover);
    root.removeEventListener('keydown', onKey);
    root.removeEventListener('input', onFind);
    doc.removeEventListener('pointerdown', onOutside);
    doc.removeEventListener('scroll', onScroll, true);
    view.removeEventListener('resize', onResize);
  };
}
