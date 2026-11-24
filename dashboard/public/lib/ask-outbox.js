// @ts-check

/** @typedef {'sending' | 'named'} Phase */
/**
 * @typedef {{ status?: number, missing?: string[], busy?: boolean, photo?: boolean, events?: string[],
 *   lost?: boolean }} Answer
 */
/**
 * @typedef {{ name: string, phase: Phase, copies: 'drop' | 'keep' | 'purge' | 'none held',
 *   turn: 'named' | 'sending' | 'failed' | 'erased' | 'done' | 'follow', again: string }} Outcome
 */

/** @type {readonly Outcome[]} */
export const OUTCOMES = Object.freeze([
  { name: 'named', phase: 'sending', copies: 'drop', turn: 'named', again: 'none' },
  { name: 'missing', phase: 'sending', copies: 'keep', turn: 'sending', again: 'send what is missing, then the same body' },
  { name: 'voice note gone', phase: 'sending', copies: 'keep', turn: 'failed', again: 'none' },
  { name: 'photo refused', phase: 'sending', copies: 'keep', turn: 'failed', again: 'same, once the photo is removed' },
  { name: 'photo stage full', phase: 'sending', copies: 'keep', turn: 'failed', again: 'same' },
  { name: 'shape refused', phase: 'sending', copies: 'drop', turn: 'failed', again: 'none' },
  { name: 'conversation erased', phase: 'sending', copies: 'purge', turn: 'erased', again: 'none' },
  { name: 'conversation unknown', phase: 'sending', copies: 'keep', turn: 'failed', again: 'same' },
  { name: 'still answering', phase: 'sending', copies: 'keep', turn: 'failed', again: 'same' },
  { name: 'home away', phase: 'sending', copies: 'keep', turn: 'sending', again: 'same, when the home answers' },
  { name: 'refused before it began', phase: 'sending', copies: 'keep', turn: 'failed', again: 'same' },
  { name: 'erased before it began', phase: 'sending', copies: 'purge', turn: 'erased', again: 'none' },
  { name: 'no answer', phase: 'sending', copies: 'keep', turn: 'sending', again: 'same, when the home answers' },
  { name: 'ended before any event', phase: 'sending', copies: 'keep', turn: 'sending', again: 'same, when the home answers' },
  { name: 'answered', phase: 'named', copies: 'none held', turn: 'done', again: 'new' },
  { name: 'failed after it began', phase: 'named', copies: 'none held', turn: 'failed', again: 'new' },
  { name: 'erased while answering', phase: 'named', copies: 'purge', turn: 'erased', again: 'none' },
  { name: 'conversation erased while answering', phase: 'named', copies: 'purge', turn: 'erased', again: 'none' },
  { name: 'not readable yet', phase: 'named', copies: 'none held', turn: 'follow', again: 'none' },
  { name: 'lost while answering', phase: 'named', copies: 'none held', turn: 'follow', again: 'none' },
]);

/**
 * @param {Phase} phase
 * @param {Answer} answer
 * @returns {Outcome}
 */
export function outcome(phase, answer) {
  const name = caseOf(phase, answer);
  return /** @type {Outcome} */ (OUTCOMES.find(each => each.name === name));
}

/** @param {Phase} phase @param {Answer} answer */
function caseOf(phase, { status, missing, photo = false, events = [], lost = false }) {
  if (lost) return phase === 'sending' ? 'no answer' : 'lost while answering';
  if (events.includes('error:erased')) return phase === 'sending' ? 'erased before it began' : 'erased while answering';
  if (status === 410) return phase === 'sending' ? 'conversation erased' : 'conversation erased while answering';
  if (phase === 'named') {
    if (status === 503) return 'not readable yet';
    if (!events.includes('done')) return 'lost while answering';
    return events.includes('error') ? 'failed after it began' : 'answered';
  }
  if (status === undefined) {
    if (events.includes('chat')) return 'named';
    return events.includes('error') ? 'refused before it began' : 'ended before any event';
  }
  if (photo) return status >= 500 ? 'photo stage full' : 'photo refused';
  if (status === 409) return !missing ? 'still answering' : missing.includes('audio') ? 'voice note gone' : 'missing';
  if (status === 422) return 'shape refused';
  if (status === 404) return 'conversation unknown';
  if (status === 503) return 'home away';
  return 'refused before it began';
}

/**
 * @param {{ submission: string, chat: string, pick: { model?: string, thinking?: string }, words: string, photos: string[],
 *   note: { id: string, seconds: number } | null, audio: string }} question
 * @returns {import('./api.js').AskBody}
 */
export function bodyOf({ submission, chat, pick, words, photos, note, audio }) {
  return { submission, ...(chat ? { chat } : {}), ...pick, ...(photos.length ? { photos } : {}),
    ...(note ? { voice: { note: note.id, seconds: note.seconds } } : audio ? { voice: { audio } } : { question: words }) };
}
