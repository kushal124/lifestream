// @ts-check
import { esc } from '../../lib/html.js';
import { icon } from './icon.js';
import { menuButton } from './menu-button.js';
import { settingRowParts } from './setting-row.js';

/** @typedef {{ id: string, label: string, words: string, choices: import('./menu-button.js').MenuChoice[], busy?: boolean }} RowMenu */

/**
 * @param {import('./setting-row.js').SettingRow} row
 * @param {RowMenu} menu
 */
export function settingMenuRow(row, menu) {
  const { item, leading, main } = settingRowParts(row, { menu: true });
  const face = leading + main + `<span class="ck-srow__value" data-menu-at>${esc(menu.words)}</span>`
    + `<span class="ck-srow__chev" aria-hidden="true">${icon('expand', { size: 'xs' })}</span>`;
  return `<li${item}>`
    + menuButton({ ...menu, attrs: { class: 'ck-srow__menu ck-fmenu--start' }, face: { markup: face, className: 'ck-srow__hit' } }) + '</li>';
}
