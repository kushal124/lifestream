// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { boldLine } from './bold-line.js';
import { button } from './button.js';
import { icon } from './icon.js';
import { settingsSection } from './setting-row.js';
import { signalShape } from './signal.js';

/** @typedef {import('../../lib/html.js').Attributes} Attributes */
/** @typedef {import('./bold-line.js').Bolded} Bolded */

/** @param {string} reason */
export const quoted = reason => `“${reason}”`;

/**
 * @param {object} ask
 * @param {Bolded} ask.today
 * @param {{ title: string, reason: string } | null} [ask.says]
 * @param {string} [ask.screen]
 */
export const askBody = ({ today, says = null, screen = '' }) => boldLine(today, { attrs: { class: 'ck-said' } })
  + (says ? settingsSection({ heading: says.title, body: `<p class="ck-quote">${esc(quoted(says.reason))}</p>` }) : '')
  + (screen ? `<p class="ck-askscreen mac-subhead">${signalShape('caution')}<span>${esc(screen)}</span></p>` : '');

/**
 * @param {object} pick
 * @param {string} pick.label
 * @param {{ n: number, busy: boolean, attrs: Attributes }[]} pick.choices
 */
export const numberPick = ({ label, choices }) => `<div class="ck-picks" role="group"${attributes({ 'aria-label': label })}>`
  + choices.map(choice => button(String(choice.n), { className: 'ck-picks__n', busy: choice.busy,
    disabled: choices.some(each => each.busy), attrs: choice.attrs })).join('') + '</div>';

/**
 * @param {object} pick
 * @param {string} pick.label
 * @param {string} pick.line
 * @param {{ n: number, busy: boolean, attrs: Attributes }[]} pick.choices
 */
export const pickSection = ({ label, line, choices }) => settingsSection({ heading: label, body: numberPick({ label, choices }), note: line });

/**
 * @param {object} card
 * @param {string} card.id
 * @param {string} card.title
 * @param {string} [card.line]
 * @param {string} [card.count]
 * @param {string} [card.body]
 * @param {string} card.foot
 * @param {'dialog' | 'status'} [card.role]
 */
export function agentCard({ id, title, line = '', count = '', body = '', foot, role = 'dialog' }) {
  const titled = `ck-agent-${id}`;
  return `<section${attributes({ class: 'ck-agent', role, 'aria-modal': role === 'dialog' ? 'false' : null, 'aria-labelledby': titled })}>`
    + '<header class="ck-agent__head">'
    + `<span class="ck-agent__mark" aria-hidden="true">${icon('ai-apps', { size: 'md' })}</span>`
    + `<div class="ck-agent__titles"><h2 class="ck-agent__title mac-title-2"${attributes({ id: titled })}>${esc(title)}</h2>`
    + (line ? `<p class="ck-agent__line mac-subhead">${esc(line)}</p>` : '') + '</div>'
    + (count ? `<span class="ck-agent__count">${esc(count)}</span>` : '') + '</header>'
    + (body ? `<div class="ck-agent__body">${body}</div>` : '')
    + `<footer class="ck-agent__foot">${foot}</footer></section>`;
}
