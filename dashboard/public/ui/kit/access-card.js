// @ts-check
import { askChanges, askChoices } from '../../lib/agents.js';
import { attributes, esc } from '../../lib/html.js';
import { phraseWords } from '../../lib/words.js';
import { boldRuns } from './bold-line.js';
import { button } from './button.js';
import { icon } from './icon.js';
import { signalShape } from './signal.js';

/** @typedef {import('../../types.js').AgentAsk} AgentAsk */
/** @typedef {import('../../types.js').AskAnswer} AskAnswer */
/** @typedef {import('../../lib/html.js').Attributes} Attributes */

/** @param {string} words */
const saidLine = words => words ? `<p class="ck-agent__refused mac-subhead" role="alert">${signalShape('warning')}${esc(words)}</p>` : '';

/**
 * @param {object} card
 * @param {AgentAsk} card.snapshot
 * @param {AgentAsk | null} card.now
 * @param {AskAnswer | null} [card.busy]
 * @param {string} [card.said]
 * @param {boolean} [card.erased]
 * @param {string} [card.gone]
 * @param {(answer: AskAnswer) => Attributes} card.attrs
 * @param {Attributes | null} [card.edit]
 */
export function accessChatCard({ snapshot, now, busy = null, said = '', erased = false, gone = '', attrs, edit = null }) {
  const ended = gone !== '' || (now !== null && now.state !== 'open');
  const offered = now && !ended ? askChoices(now, erased) : [];
  const allow = offered.find(each => each.answer !== 'no');
  const no = offered.find(each => each.answer === 'no');
  const foot = ended
    ? `<p class="ck-access-chat__said mac-subhead">${now?.state === 'allowed' && gone === '' ? icon('done', { size: 'sm' }) : ''}`
      + `<span>${esc(gone || phraseWords(now?.outcome ?? null))}</span></p>`
    : now === null ? ''
      : '<div class="ck-access-chat__answers" role="group" aria-label="Answer">'
        + (allow ? button(allow.words, { variant: 'primary', size: 'sm', busy: busy === allow.answer, disabled: busy !== null, attrs: attrs(allow.answer) }) : '')
        + (no ? button(no.words, { variant: 'secondary', size: 'sm', busy: busy === 'no', disabled: busy !== null, attrs: attrs('no') }) : '')
        + (edit && askChanges(now, erased) ? button('Edit', { variant: 'plain', size: 'sm', disabled: busy !== null, attrs: edit }) : '')
        + '</div>';
  const parts = [...snapshot.adds.map(add => `<span class="ck-access-chat__add"><span aria-hidden="true">+ </span>`
    + `<span class="sr-only">Adds </span>${esc(add)}</span>`), ...snapshot.keeps ? [esc(snapshot.keeps)] : []];
  return `<section${attributes({ class: `ck-access-chat${ended ? ' is-answered' : ''}`, 'aria-label': snapshot.head })}>`
    + `<p class="ck-access-chat__head mac-headline">${esc(snapshot.head)}</p>`
    + (parts.length ? `<p class="ck-access-chat__line mac-subhead">${parts.join(' · ')}</p>` : '')
    + (snapshot.screen ? `<p class="ck-access-chat__screen mac-subhead">${signalShape('caution')}<span>${esc(snapshot.screen)}</span></p>` : '')
    + saidLine(said) + foot + '</section>';
}

/**
 * @param {object} line
 * @param {import('./bold-line.js').Bolded} line.words
 * @param {Attributes | null} line.undo
 * @param {boolean} [line.busy]
 * @param {boolean} [line.undone]
 * @param {string} [line.said]
 */
export const accessNarrowed = ({ words, undo, busy = false, undone = false, said = '' }) => '<section class="ck-access-chat ck-access-line">'
  + `<p class="ck-access-line__words mac-headline">${boldRuns(words)}</p>`
  + (undo && !undone ? button('Undo', { variant: 'secondary', size: 'sm', busy, disabled: busy, attrs: undo, className: 'ck-access-line__undo' }) : '')
  + saidLine(said) + '</section>';
