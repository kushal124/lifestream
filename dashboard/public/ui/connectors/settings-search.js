// @ts-check
/** @import { HostAct, MeaningWrite } from '../../lib/host.js' */
/** @import { DetailPart, End, PanelRow } from './dialog.js' */
/** @import { Do } from './words.js' */
import { freeWords } from '../../lib/words.js';
import { rowOf } from './dialog.js';
import { homeSettingKey } from './pending.js';
import { part } from './settings-pages.js';

/** @typedef {{ as_of: string | null, building: { done: number, of: number } | null }} IndexState */

/** @typedef {{ record: IndexState, screen: IndexState & ScreenState }} SearchState */

/** @typedef {{ meaning: 'off' | `runner-${string}`, model: string, power: 'plugged-idle', words_indexed_through: string | null, bytes: number, vectors_bytes: number, queued: number, waits: string | null, waits_line: string | null, embedded: number, named: number, skipped: number }} ScreenState */

export const MEANING_MODEL = { id: 'embeddinggemma-2-q8-512', name: 'EmbeddingGemma 2', size: '303 MB' };

export const MEANING_POWER = { id: /** @type {const} */ ('plugged-idle'), words: 'Only when plugged in and idle' };

export const MEANING_LINE = 'Finds moments on your screen by what they were about, not only by their words. Word search works either way.';

export const MEANING_EXAMPLE = 'Ask for “that article about sleep I read last week” and find it, even when those words were never on the screen.';

export const MEANING_COST = `A ${MEANING_MODEL.size} model, and about 3 minutes of Mac time per day of screen, only when this Mac is plugged in and idle. Nothing leaves this Mac.`;

/** @param {HostAct} act @returns {Do} */
const asking = act => ({ host: act });

/**
 * @param {MeaningWrite} settings
 * @returns {HostAct}
 */
const writing = settings => ({ act: 'home-setting', settings });

/**
 * @param {boolean} on
 * @param {string | null} runner
 * @returns {HostAct | null}
 */
export function meaningAct(on, runner) {
  if (!on) return writing({ 'search.meaning': 'off' });
  return runner ? writing({ 'search.meaning': /** @type {`runner-${string}`} */ (runner) }) : null;
}

export const MEANING_BUSY = homeSettingKey('search.meaning');

/** @param {ScreenState} state */
export const meaningOn = state => state.meaning !== 'off';

/** @param {number} bytes */
const sizeWords = bytes => freeWords(bytes).replace(/ free$/u, '');


/**
 * @param {'search.meaning.model' | 'search.meaning.power'} key
 * @param {string} label
 * @param {{ value: string, words: string, note: string }} only
 * @param {boolean} acts
 * @returns {End}
 */
function oneChoice(key, label, only, acts) {
  if (!acts) return { words: only.words };
  return { menu: { id: `settings.${key}`, busy: homeSettingKey(key), label, words: only.words, find: '', date: null,
    choices: [{ words: only.words, note: only.note, chosen: true, default: true,
      do: asking(writing(/** @type {MeaningWrite} */ ({ [key]: only.value }))) }] } };
}

/** @param {ScreenState} state */
const screenTexts = state => state.embedded + state.queued + state.skipped;

/** @param {ScreenState} state */
export const meaningShare = state => {
  const texts = screenTexts(state);
  return texts > 0 ? Math.floor(Math.min(1, state.embedded / texts) * 100) : 0;
};

/**
 * @param {ScreenState} state
 * @returns {PanelRow}
 */
function reachedRow(state) {
  const texts = screenTexts(state);
  const caught = texts > 0 && state.queued === 0;
  const all = caught && state.skipped === 0;
  const skipped = state.skipped > 0 ? ` ${state.skipped.toLocaleString('en-US')} could not be read.` : '';
  const line = (state.waits_line ? `${state.waits_line.replace(/\.$/u, '')}.`
    : caught ? 'Caught up with your screen.'
      : texts ? 'It reads when this Mac is plugged in and idle.' : 'It starts once this Mac has recorded your screen.') + skipped;
  const share = meaningShare(state);
  return rowOf('Searchable', { line, end: all ? { words: 'All of your screen', done: true } : null,
    progress: all || !texts ? null
      : { label: 'Searchable so far', share: share / 100, words: `${share}% of your screen, newest first` } });
}

/**
 * @param {{ state: ScreenState | null, failed: boolean, acts: boolean, runner: string | null }} read
 * @returns {{ parts: DetailPart[], reading: boolean }}
 */
export function meaningParts({ state, failed, acts, runner }) {
  if (!state) return { parts: [], reading: !failed };
  const on = meaningOn(state);
  const turn = acts ? meaningAct(!on, runner) : null;
  const ask = 'meaning-off';
  const asksFirst = turn !== null && on && state.vectors_bytes > 0;
  const settings = part({ rows: [
    rowOf('Search by meaning', { line: MEANING_LINE,
      end: turn ? { toggle: { on, label: 'Search by meaning', do: asksFirst ? { ask } : asking(turn) } } : { words: on ? 'On' : 'Off' },
      confirm: asksFirst ? { ask, question: 'Turn off meaning search?',
        detail: `What it kept (${sizeWords(state.vectors_bytes)}) is deleted. Word search stays as it is. Turned on again, it reads your screen from the newest day back.`,
        yes: { label: 'Turn off', tone: 'warning', variant: 'primary', do: asking(turn) },
        no: { label: 'Cancel', variant: 'plain', do: { ask: '' } } } : null }),
    rowOf('Model', { tag: 'Runs on this Mac only', line: `${MEANING_MODEL.size} download. Screen text is never sent to a cloud model for this.`,
      end: oneChoice('search.meaning.model', 'Model', { value: MEANING_MODEL.id, words: MEANING_MODEL.name,
        note: `${MEANING_MODEL.size} · runs on this Mac only` }, acts) }),
    rowOf('When it runs', { line: 'So it never slows you down or spends your battery.',
      end: oneChoice('search.meaning.power', 'When it runs', { value: MEANING_POWER.id, words: MEANING_POWER.words, note: '' }, acts) }),
  ] });
  if (!on) return { parts: [settings], reading: false };
  /** @type {PanelRow[]} */
  const rows = [
    reachedRow(state),
    rowOf('On disk', { line: 'What meaning search keeps beside your screen’s words.', end: { words: sizeWords(state.vectors_bytes) } }),
  ];
  return { parts: [settings, part({ label: 'Progress', rows })], reading: false };
}
