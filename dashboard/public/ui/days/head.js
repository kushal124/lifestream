// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { longDay, relativeDay } from '../../lib/words.js';
import { bar, button, icon, iconButton, pageHead } from '../kit/index.js';

/**
 * @param {object} head
 * @param {string} head.day
 * @param {string} head.today
 * @param {string | null} head.previous
 * @param {string | null} head.next
 * @param {boolean} head.picking
 */
export function dayBar({ day, today, previous, next, picking }) {
  const word = day ? relativeDay(day, today) : '';
  return pageHead({ lead: '<div class="dy-lead">'
    + `<button${attributes({ type: 'button', class: `dy-title${picking ? ' is-open' : ''}`, 'data-d-title': '',
      'aria-haspopup': 'dialog', 'aria-expanded': String(picking), disabled: !day,
      'aria-label': day ? `${longDay(day, today.slice(0, 4))}, choose a day` : 'Choose a day' })}>`
    + `<span class="dy-title__words mac-display">${day ? esc(longDay(day, today.slice(0, 4))) : bar(8)}</span>`
    + `${icon('expand', { className: 'dy-title__caret' })}</button>`
    + `<span class="dy-bar__word mac-title-2">${day ? esc(word) : bar(3)}</span></div>`, tools: [
    iconButton('back', 'Previous day', { variant: 'secondary', attrs: { 'data-d-day': previous ?? '', title: 'Previous day  ⌘←' }, disabled: !day || !previous }),
    iconButton('forward', 'Next day', { variant: 'secondary', attrs: { 'data-d-day': next ?? '', title: 'Next day  ⌘→' }, disabled: !day || !next }),
    button('Today', { disabled: !day || day === today, attrs: { 'data-d-today': '', title: 'Today  T' } })] });
}
