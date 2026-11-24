// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { icon, iconButton, sectionLabel } from '../kit/index.js';

export const RECENT_KEPT = 5;
const KEY = 'lifestream.search.recent';

/**
 * @param {string[]} recent
 * @param {string} words
 * @returns {string[]}
 */
export function remembered(recent, words) {
  const made = words.replace(/\s+/gu, ' ').trim();
  if (!made) return recent;
  const same = made.toLocaleLowerCase();
  return [made, ...recent.filter(each => each.toLocaleLowerCase() !== same)].slice(0, RECENT_KEPT);
}

/** @returns {string[]} */
export function readRecent() {
  try {
    const kept = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(kept) ? kept.filter(each => typeof each === 'string').slice(0, RECENT_KEPT) : [];
  } catch {
    return [];
  }
}

/** @param {string[]} recent */
export function keepRecent(recent) {
  try {
    localStorage.setItem(KEY, JSON.stringify(recent));
  } catch {
  }
}

/** @param {string[]} recent */
export function recentSearches(recent) {
  if (!recent.length) return '';
  return `<section class="sx-kind">${sectionLabel('Recent')}<div>`
    + recent.map(words => '<div class="sx-recent">'
      + `<button${attributes({ type: 'button', class: 'sx-recent__words', 'data-search-recent': words })}>`
      + `<span class="sx-recent__icon">${icon('time', { size: 'md' })}</span>`
      + `<span class="sx-recent__text mac-body">${esc(words)}</span></button>`
      + iconButton('close', `Remove “${words}”`, { className: 'sx-recent__forget', attrs: { 'data-search-forget': words } })
      + '</div>').join('')
    + '</div></section>';
}
