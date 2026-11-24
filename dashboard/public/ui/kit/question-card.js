// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { button } from './button.js';

/**
 * @param {object} question
 * @param {string} question.title
 * @param {string} question.line
 * @param {string} question.yes
 * @param {string} [question.no]
 * @param {(yes: boolean) => import('../../lib/html.js').Attributes} question.answer
 * @param {string} [question.className]
 */
export const questionCard = ({ title, line, yes, no = 'No', answer, className = '' }) => `<section${attributes({
  class: `ck-question${className ? ` ${className}` : ''}`, 'aria-label': title })}>`
  + `<div class="ck-question__words"><h2 class="ck-question__title mac-title-2">${esc(title)}</h2>`
  + `<p class="ck-question__line mac-body">${esc(line)}</p></div>`
  + `<div class="ck-question__answers">${button(yes, { variant: 'primary', attrs: answer(true) })}`
  + `${button(no, { attrs: answer(false) })}</div></section>`;
