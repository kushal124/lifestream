// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { icon } from './icon.js';
import { monogram } from './person-face.js';

/** @typedef {import('../../lib/html.js').Attributes} Attributes */

/**
 * @typedef {object} Item
 * @property {string} title
 * @property {string} [line]
 * @property {string} [at]
 * @property {string} [face]
 * @property {string} [icon]
 * @property {string} [href]
 * @property {Attributes} [attrs]
 */

/**
 * @param {Item[]} items
 * @param {{ small?: boolean }} [options]
 */
export function items(items, { small = false } = {}) {
  const rows = items.map(item => {
    const lead = item.face ? monogram(item.face, 'md') : icon(item.icon ?? 'info', { size: small ? 'xs' : 'sm' });
    const inner = `<span class="ck-item__lead">${lead}</span>`
      + `<span class="ck-item__main"><span class="ck-item__title mac-headline">${esc(item.title)}</span>`
      + (item.line ? `<span class="ck-item__line mac-subhead">${esc(item.line)}${item.href ? icon('open-out', { size: 'xs' }) : ''}</span>` : '')
      + '</span>'
      + `<span class="ck-item__at mac-mono-time">${esc(item.at ?? '')}</span>`;
    const classes = `ck-item${small ? ' ck-item--sm' : ''}`;
    return item.href
      ? `<li><a${attributes({ class: classes, href: item.href, target: '_blank', rel: 'noopener noreferrer' })}>${inner}</a></li>`
      : `<li><button${attributes({ class: classes, type: 'button', ...item.attrs })}>${inner}</button></li>`;
  });
  return `<ul class="ck-items">${rows.join('')}</ul>`;
}

/** @param {{ name: string, size?: string }[]} files */
export const files = files => `<ul class="ck-files">${files.map(file => '<li class="ck-file">'
  + `<span class="ck-file__tile">${icon('file', { size: 'sm' })}</span>`
  + `<span class="ck-file__names"><span class="ck-file__name mac-headline">${esc(file.name)}</span>`
  + (file.size ? `<span class="ck-file__size mac-mono-data">${esc(file.size)}</span>` : '') + '</span></li>').join('')}</ul>`;

/** @param {[string, string | { text: string, href: string }][]} facts */
export function facts(facts) {
  const shown = facts.filter(([, value]) => typeof value === 'string' ? value : value.text);
  if (!shown.length) return '';
  const rows = shown.map(([name, value]) => `<div class="ck-facts__row"><dt class="mac-body">${esc(name)}</dt>`
    + `<dd class="mac-body">${typeof value === 'string' ? esc(value)
      : `<a href="${esc(value.href)}" target="_blank" rel="noopener noreferrer">${esc(value.text)}</a>`}</dd></div>`);
  return `<dl class="ck-facts">${rows.join('')}</dl>`;
}
