// @ts-check
/** @import { AccessChange, AccessDraft, AgentAddress, AgentAsk, AgentGuides, AnswerReply, AnswerRequest, AskAnswer, MadeKey, SignIn, SignInRead } from '../types.js' */
import { phraseWords } from './words.js';

export const NOT_SURE = 'Not sure this reached Lifestream.';
export const UNREACHED = 'Lifestream didn’t answer, so that change wasn’t made.';

/** @param {unknown} error */
export function refusalWords(error) {
  const { code, status, message } = /** @type {{ code?: unknown, status?: unknown, message?: unknown }} */ (error ?? {});
  if (code === 'OUTCOME_UNKNOWN') return NOT_SURE;
  const refused = typeof code === 'string' && code !== '' && typeof status === 'number' && status >= 400 && status < 500;
  return refused && typeof message === 'string' && message ? message : UNREACHED;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** @param {unknown} value */
const isText = value => typeof value === 'string';
/** @param {unknown} value */
const textOrNull = value => value === null || typeof value === 'string';
/** @param {unknown} value */
const isWhen = value => isRecord(value) && (value.kind === 'day' ? isText(value.day) : value.kind === 'month' ? isText(value.month)
  : (value.kind === 'at' || value.kind === 'clock') && Number.isInteger(value.at_ms));
/** @param {unknown} value */
const isPhrase = value => Array.isArray(value) && value.length > 0
  && value.every(part => isRecord(part) && (part.kind === 'words' ? isText(part.words) : part.kind === 'time' && isWhen(part.time)));
/** @param {unknown} value */
const phraseOrNull = value => value === null || isPhrase(value);
/** @param {unknown} value */
const connectedOrNull = value => value === null || (isRecord(value) && isText(value.reader) && value.reader !== '' && isText(value.line));
/** @param {unknown} value */
const isBolded = value => Array.isArray(value) && value.every(run => isRecord(run) && isText(run.text)
  && (run.bold === undefined || run.bold === true));
/** @param {unknown} value */
const isWhole = value => Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0;

/** @param {unknown} value */
export const isAccess = value => isRecord(value) && ['allow', 'items', 'not', 'only', 'shown'].every(key => Array.isArray(value[key]))
  && 'window' in value && (value.window === null || isRecord(value.window))
  && (typeof value.hide === 'string' || Array.isArray(value.hide));

const ASK_STATES = ['open', 'allowed', 'declined', 'replaced', 'dropped', 'lapsed'];
const ANSWERS = ['once', 'always', 'no'];

/**
 * @param {unknown} value
 * @returns {AgentAsk | null}
 */
export function askOf(value) {
  if (!isRecord(value)) return null;
  const { choices } = value;
  const fits = isText(value.id) && value.id !== '' && isText(value.reader) && isText(value.name)
    && (value.by === 'agent' || value.by === 'chat') && isText(value.head) && isText(value.line) && isText(value.wants)
    && isPhrase(value.asked_line) && isPhrase(value.under_line) && isText(value.says_title) && isBolded(value.today)
    && textOrNull(value.under) && textOrNull(value.reason) && textOrNull(value.screen)
    && textOrNull(value.keeps) && (value.state === 'open' ? value.outcome === null : isPhrase(value.outcome))
    && Array.isArray(value.adds) && value.adds.every(isText)
    && Array.isArray(choices) && choices.length > 0
    && choices.every(each => isRecord(each) && ANSWERS.includes(/** @type {string} */ (each.answer)) && isText(each.words))
    && typeof value.editable === 'boolean' && choices.some(each => each.answer === value.default) && isWhole(value.version) && isAccess(value.proposed)
    && isWhole(value.at_ms) && isWhole(value.until_ms) && ASK_STATES.includes(/** @type {string} */ (value.state));
  return fits ? /** @type {AgentAsk} */ (/** @type {unknown} */ (value)) : null;
}

const REPLY_STATES = ['approved', 'wrong', 'denied', ...ASK_STATES];

/**
 * @param {unknown} value
 * @returns {AnswerReply | null}
 */
export function answerReplyOf(value) {
  if (!isRecord(value)) return null;
  const fits = REPLY_STATES.includes(/** @type {string} */ (value.state)) && (value.version === null || isWhole(value.version))
    && phraseOrNull(value.outcome) && textOrNull(value.reader) && connectedOrNull(value.connected);
  return fits ? /** @type {AnswerReply} */ (/** @type {unknown} */ (value)) : null;
}

/**
 * @param {unknown} value
 * @returns {AccessDraft | null}
 */
export function draftOf(value) {
  if (!isRecord(value)) return null;
  const { view } = value;
  const fits = isAccess(value.access) && (value.expect === null || isWhole(value.expect)) && isRecord(view)
    && isBolded(view.sentence) && Array.isArray(view.times)
    && (view.hide === null || (isRecord(view.hide) && Array.isArray(view.hide.choices)));
  return fits ? /** @type {AccessDraft} */ (/** @type {unknown} */ (value)) : null;
}

/**
 * @param {unknown} value
 * @returns {AgentGuides | null}
 */
export const guidesOf = value => isRecord(value) && isText(value.title) && Array.isArray(value.apps)
  && value.apps.every(each => isRecord(each) && isText(each.app) && Array.isArray(each.steps))
  ? /** @type {AgentGuides} */ (/** @type {unknown} */ (value)) : null;

const FIXES = ['web', 'tailscale', 'turn-on'];

/**
 * @param {unknown} value
 * @returns {AgentAddress | null}
 */
export function addressOf(value) {
  if (!isRecord(value)) return null;
  const { act } = value;
  const fits = value.state === 'on' ? isText(value.url) && isText(value.line)
    : value.state === 'off' ? textOrNull(value.url)
      : value.state === 'fix' && value.url === null && isText(value.words)
        && (act === null || (isRecord(act) && isText(act.label) && FIXES.includes(/** @type {string} */ (act.to)) && textOrNull(act.url)));
  return fits ? /** @type {AgentAddress} */ (/** @type {unknown} */ (value)) : null;
}

/**
 * @param {unknown} value
 * @returns {MadeKey | null}
 */
export const madeKeyOf = value => isRecord(value) && isText(value.reader) && isText(value.name) && connectedOrNull(value.connected)
  && value.connected !== null && Array.isArray(value.rows) && value.rows.every(row => isRecord(row) && isText(row.label) && isText(row.text))
  ? /** @type {MadeKey} */ (/** @type {unknown} */ (value)) : null;

const READ_STATES = ['waiting', 'approved', 'wrong', 'denied', 'gone'];

/**
 * @param {unknown} value
 * @returns {SignInRead | null}
 */
export const signInReadOf = value => isRecord(value) && isText(value.id) && READ_STATES.includes(/** @type {string} */ (value.state))
  && phraseOrNull(value.outcome) && textOrNull(value.reader) && connectedOrNull(value.connected)
  ? /** @type {SignInRead} */ (/** @type {unknown} */ (value)) : null;

export const ERASED = 'AGENT_REQUEST_ERASED';

/**
 * @param {AgentAsk} ask
 * @param {boolean} [erased]
 */
export const askChoices = (ask, erased = false) => erased ? ask.choices.filter(each => each.answer === 'no') : ask.choices;

/**
 * @param {AgentAsk} ask
 * @param {boolean} [erased]
 */
export const askChanges = (ask, erased = false) => askChoices(ask, erased).some(each => each.answer !== 'no');

/**
 * @param {{ answer: AnswerReply } | { refused: { code: string, message: string } }} word
 * @returns {{ words: string, taken: boolean, erased: boolean }}
 */
export const answerWord = word => 'answer' in word ? { words: phraseWords(word.answer.outcome), taken: true, erased: false }
  : { words: word.refused.message, taken: false, erased: word.refused.code === ERASED };

/**
 * @param {unknown} value
 * @returns {SignIn | null}
 */
export function signInOf(value) {
  if (!isRecord(value)) return null;
  const { choices } = value;
  const fits = isText(value.id) && value.id !== '' && isText(value.name) && value.name !== '' && typeof value.checked === 'boolean'
    && textOrNull(value.host) && Array.isArray(choices) && choices.length === 3
    && choices.every(each => Number.isInteger(each) && each >= 10 && each <= 99)
    && isWhole(value.at_ms) && isWhole(value.until_ms) && isText(value.sentence) && isAccess(value.access) && isRecord(value.view)
    && isText(value.head) && value.head !== '' && isPhrase(value.over_line) && isText(value.pick) && value.pick !== ''
    && isText(value.pick_line) && isText(value.over) && value.over !== '' && textOrNull(value.app)
    && isText(value.notice) && value.notice !== '';
  return fits ? /** @type {SignIn} */ (/** @type {unknown} */ (value)) : null;
}

/**
 * @param {unknown} value
 * @returns {AccessChange | null}
 */
export function accessChangeOf(value) {
  if (!isRecord(value) || !isText(value.id) || value.id === '') return null;
  if (value.kind === 'asked') return askOf(value.snapshot) ? /** @type {AccessChange} */ (/** @type {unknown} */ (value)) : null;
  if (value.kind === 'unchanged') {
    return isText(value.reader) && isText(value.words) ? /** @type {AccessChange} */ (/** @type {unknown} */ (value)) : null;
  }
  const { undo } = value;
  const fits = value.kind === 'narrowed' && isText(value.reader) && isBolded(value.words)
    && isRecord(undo) && isAccess(undo.access) && isWhole(undo.expect);
  return fits ? /** @type {AccessChange} */ (/** @type {unknown} */ (value)) : null;
}

/**
 * @param {AgentAsk} ask
 * @param {AskAnswer} answer
 * @param {import('../types.js').AccessDraft | null} [edited]
 * @returns {AnswerRequest}
 */
export function askAnswer(ask, answer, edited = null) {
  if (answer === 'no') return { id: ask.id, answer };
  return edited ? { id: ask.id, answer, expect: edited.expect ?? ask.version, access: edited.access } : { id: ask.id, answer, expect: ask.version };
}

/**
 * @param {string} id
 * @param {number | 'deny'} answer
 * @param {import('../types.js').Access | null} [kept]
 * @returns {AnswerRequest}
 */
export const signInAnswer = (id, answer, kept = null) => answer === 'deny' ? { id, answer }
  : kept ? { id, answer, access: kept } : { id, answer };

/** @param {AnswerRequest} answer */
export const answerKey = answer => `answer:${answer.id}:${answer.answer}`;
