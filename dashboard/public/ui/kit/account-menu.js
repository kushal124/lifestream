// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { floatList } from './float-list.js';
import { icon } from './icon.js';
import { personFace } from './person-face.js';

/** @typedef {import('../../lib/html.js').Attributes} Attributes */

export const ACCOUNT_PROFILE = 'profile';
export const ACCOUNT_SETTINGS = 'settings';
export const ACCOUNT_FINISH = 'finish';
export const ACCOUNT_FEEDBACK = 'feedback';

/**
 * @param {object} account
 * @param {{ id: string, name: string, photo: string } | null} account.you
 * @param {string} [account.shortcut]
 * @param {{ line: string, act: { id: string, label: string } } | null} [account.update]
 * @param {boolean} [account.finish]
 * @param {string | null} [account.feedback]
 * @param {string} [account.id]
 * @param {Attributes} [account.attrs]
 * @param {boolean} [account.open]
 */
export function accountMenu({ you, shortcut = '', update = null, finish = false, feedback = null, id = 'ck-account',
  attrs = {}, open = false }) {
  const name = you?.name ?? 'You';
  const first = you ? `${id}-profile` : `${id}-settings`;
  return `<div${attributes({ class: 'ck-fmenu ck-fmenu--float ck-fmenu--start ck-account', ...attrs })}>`
    + `<button${attributes({
      type: 'button', class: 'ck-fmenu__btn ck-navrow ck-account__btn', 'aria-haspopup': 'menu',
      'aria-label': update ? `${name}: Settings, ${update.line}` : `${name}: Settings`, title: update?.line ?? null,
      'aria-expanded': String(open), 'aria-controls': `${id}-menu`, 'aria-activedescendant': open ? first : null,
    })}>${personFace({ name: you ? you.name : null, photo: you?.photo ?? '', size: 'xs' })}`
    + `<span class="ck-account__name ck-navrow__words">${esc(name)}</span>`
    + (update ? '<span class="ck-account__dot" aria-hidden="true"></span>' : '')
    + `${icon('expand', { size: 'xs', className: 'ck-fmenu__caret' })}</button>`
    + floatList({
      label: name, role: 'menu', className: 'ck-fmenu__panel', lit: open ? 0 : null,
      attrs: { id: `${id}-menu`, hidden: !open },
      items: [
        ...you ? [{ name: 'Profile', attrs: { id: `${id}-profile`, class: 'ck-fmenu__item', role: 'menuitem', 'aria-checked': null,
          'data-value': ACCOUNT_PROFILE } }] : [],
        ...finish ? [{ name: 'Finish setting up', attrs: { id: `${id}-finish`, class: 'ck-fmenu__item', role: 'menuitem',
          'aria-checked': null, 'data-value': ACCOUNT_FINISH } }] : [],
        { name: 'Settings', key: shortcut, parted: Boolean(update || feedback), attrs: { id: `${id}-settings`,
          class: 'ck-fmenu__item', role: 'menuitem', 'aria-checked': null, 'data-value': ACCOUNT_SETTINGS } },
        ...feedback ? [{ name: feedback, parted: Boolean(update), attrs: { id: `${id}-feedback`, class: 'ck-fmenu__item',
          role: 'menuitem', 'aria-checked': null, 'data-value': ACCOUNT_FEEDBACK } }] : [],
        ...update ? [{ name: update.act.label, note: update.line, attrs: { id: `${id}-act`, class: 'ck-fmenu__item',
          role: 'menuitem', 'aria-checked': null, 'data-value': update.act.id } }] : [],
      ],
    }) + '</div>';
}
