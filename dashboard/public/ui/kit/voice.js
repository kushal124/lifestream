// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { lifeMediaUrl } from '../../lib/api.js';
import { spinner } from './button.js';
import { icon } from './icon.js';
import { inPlaceLine } from './states.js';

/** @typedef {import('../../lib/html.js').Attributes} Attributes */

/** @typedef {'idle' | 'loading' | 'playing' | 'paused' | 'failed'} VoiceState */

/**
 * @typedef {object} VoiceHooks
 * @property {() => boolean} [refuses]
 * @property {(sound: string, play: number) => void} [failed]
 */

/**
 * @typedef {object} VoiceMedia
 * @property {string} src
 * @property {boolean} paused
 * @property {number} currentTime
 * @property {number} duration
 * @property {() => Promise<void>} play
 * @property {() => void} pause
 * @property {() => void} load
 * @property {(name: string) => void} removeAttribute
 * @property {(name: string, listener: () => void) => void} addEventListener
 */

/**
 * @typedef {object} Voice
 * @property {(sound: string, owner: string, src?: string) => void} toggle
 * @property {(owner?: string) => void} stop
 * @property {(sound: string) => VoiceState} state
 * @property {(sound: string) => { at: number, of: number | null }} time
 * @property {(sound: string) => number} plays
 * @property {(hooks: VoiceHooks) => () => void} hold
 */

const SOUND = /^sha256:[0-9a-f]{64}$/u;

export const DIDNT_PLAY = 'This voice note didn’t play.';

let minted = 0;

/** @param {string} kind */
export const voiceOwner = kind => `${kind}:${minted += 1}`;

/** @param {number} seconds */
export const runs = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

/**
 * @param {() => VoiceMedia} made
 * @param {(sound: string) => void} paint
 * @returns {Voice}
 */
export function voiceController(made, paint) {
  /** @type {VoiceMedia | null} */
  let media = null;
  /** @type {{ sound: string, owner: string, state: 'loading' | 'playing' | 'paused', src: string } | null} */
  let current = null;
  /** @type {Set<string>} */
  const failed = new Set();
  /** @type {Map<string, number>} */
  const lengths = new Map();
  /** @type {Map<string, number>} */
  const plays = new Map();
  /** @type {Set<VoiceHooks>} */
  const hooks = new Set();

  const element = () => {
    if (media) return media;
    const audio = made();
    audio.addEventListener('playing', () => {
      if (!current || current.state === 'playing') return;
      if (current.state === 'loading') performance.mark('voice-playing', { detail: current.sound });
      current.state = 'playing';
      paint(current.sound);
    });
    audio.addEventListener('pause', () => {
      if (current?.state !== 'playing') return;
      current.state = 'paused';
      paint(current.sound);
    });
    audio.addEventListener('loadedmetadata', () => {
      if (!current || !Number.isFinite(audio.duration)) return;
      lengths.set(current.sound, audio.duration);
      paint(current.sound);
    });
    audio.addEventListener('timeupdate', () => {
      if (current) paint(current.sound);
    });
    audio.addEventListener('ended', () => {
      const ended = current;
      if (!ended) return;
      current = null;
      audio.currentTime = 0;
      paint(ended.sound);
    });
    audio.addEventListener('error', () => {
      if (current) fail(current.sound, current.src);
    });
    media = audio;
    return audio;
  };

  const release = () => {
    if (!media) return;
    media.pause();
    media.removeAttribute('src');
    media.load();
  };

  /** @param {string} sound @param {string} src */
  const fail = (sound, src) => {
    if (current?.sound !== sound || current.src !== src) return;
    current = null;
    failed.add(sound);
    release();
    paint(sound);
    const play = plays.get(sound) ?? 0;
    for (const each of [...hooks]) each.failed?.(sound, play);
  };

  /** @param {string} sound @param {string} src */
  const start = (sound, src) => {
    const audio = element();
    audio.play().catch(error => {
      if (/** @type {{ name?: string }} */ (error)?.name !== 'AbortError') fail(sound, src);
    });
  };

  return {
    toggle(sound, owner, src = '') {
      if ([...hooks].some(each => each.refuses?.())) return;
      const audio = element();
      if (current?.sound === sound) {
        const was = current;
        if (was.state === 'loading') {
          current = null;
          release();
        } else if (was.state === 'playing') {
          was.state = 'paused';
          audio.pause();
        } else {
          current = { ...was, owner, state: 'playing' };
          start(sound, was.src);
        }
        return paint(sound);
      }
      const from = src || (SOUND.test(sound) ? lifeMediaUrl(sound) : '');
      if (!from) return;
      const before = current?.sound;
      current = null;
      release();
      if (before) paint(before);
      failed.delete(sound);
      plays.set(sound, (plays.get(sound) ?? 0) + 1);
      performance.mark('voice-tap', { detail: sound });
      current = { sound, owner, state: 'loading', src: from };
      audio.src = from;
      start(sound, from);
      paint(sound);
    },
    stop(owner) {
      if (!current || (owner !== undefined && current.owner !== owner)) return;
      const { sound } = current;
      current = null;
      release();
      paint(sound);
    },
    state: sound => current?.sound === sound ? current.state : failed.has(sound) ? 'failed' : 'idle',
    time: sound => ({ at: current?.sound === sound && media ? media.currentTime : 0, of: lengths.get(sound) ?? null }),
    plays: sound => plays.get(sound) ?? 0,
    hold(each) {
      hooks.add(each);
      return () => void hooks.delete(each);
    },
  };
}

/** @param {string} sound */
const selector = sound => `[data-voice="${sound.replace(/["\\]/gu, '\\$&')}"]`;

/**
 * @param {Element} element
 * @param {string} name
 * @param {string | null} value
 */
function setAttribute(element, name, value) {
  if (value === null) element.removeAttribute(name);
  else if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

/**
 * @param {number | null} seconds
 * @param {number | null} loaded
 */
const lengthOf = (seconds, loaded) => seconds !== null ? runs(seconds) : loaded !== null ? runs(Math.round(loaded)) : '–:––';

/**
 * @param {Voice} voice
 * @param {HTMLElement} bar
 */
function paintBar(voice, bar) {
  const sound = bar.dataset.voice ?? '';
  const state = voice.state(sound);
  const { at, of } = voice.time(sound);
  setAttribute(bar, 'data-voice-state', state === 'idle' ? null : state);
  const runsNow = state === 'playing' || state === 'paused';
  const said = runsNow ? runs(at) : bar.dataset.voiceSeconds === undefined && of !== null ? lengthOf(null, of) : null;
  for (const time of bar.querySelectorAll('[data-voice-time]')) setAttribute(time, 'data-voice-said', said);
  const filled = runsNow && of ? `scaleX(${Math.min(1, at / of)})` : '';
  for (const line of bar.querySelectorAll('[data-voice-line]')) {
    const style = /** @type {HTMLElement} */ (line).style;
    if (style.transform !== filled) style.transform = filled;
  }
}

/**
 * @param {Node} node
 * @returns {HTMLElement[]}
 */
const barsIn = node => !(node instanceof Element) ? []
  : [...node.matches('[data-voice]') ? [node] : [], ...node.querySelectorAll('[data-voice]')].map(each => /** @type {HTMLElement} */ (each));

/** @type {Voice | null} */
let shared = null;

/** @returns {Voice} */
function voice() {
  if (shared) return shared;
  /** @type {Voice} */
  const made = voiceController(() => new Audio(), sound => {
    for (const bar of document.querySelectorAll(selector(sound))) paintBar(made, /** @type {HTMLElement} */ (bar));
  });
  shared = made;
  document.addEventListener('click', event => {
    const play = /** @type {Element} */ (event.target).closest('[data-voice-play]');
    const bar = /** @type {HTMLElement | null} */ (play?.closest('[data-voice]') ?? null);
    if (bar) made.toggle(bar.dataset.voice ?? '', bar.dataset.voiceOwner ?? '', bar.dataset.voiceSrc ?? '');
  }, true);
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') paintBar(made, /** @type {HTMLElement} */ (record.target));
      else for (const node of record.addedNodes) for (const bar of barsIn(node)) paintBar(made, bar);
    }
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-voice'] });
  return made;
}

export const installVoice = () => void voice();

/** @param {VoiceHooks} hooks */
export const holdVoice = hooks => voice().hold(hooks);

/** @param {string} [owner] */
export const stop = owner => voice().stop(owner);

/** @param {string} sound */
export const voicePlays = sound => voice().plays(sound);

/** @param {HTMLElement} surface */
export function stopVoiceIn(surface) {
  if (!shared) return;
  for (const bar of surface.querySelectorAll('[data-voice-owner]')) shared.stop(/** @type {HTMLElement} */ (bar).dataset.voiceOwner);
}

/**
 * @param {string} className
 * @param {string} label
 */
export const voiceButton = (className, label) => `<button${attributes({ type: 'button', class: className, 'data-voice-play': true })}>`
  + `<span class="ck-voice-face" data-voice-face="play">${icon('play', { size: 'xs' })}<span class="sr-only">${esc(label)}</span></span>`
  + `<span class="ck-voice-face" data-voice-face="pause">${icon('pause', { size: 'xs' })}<span class="sr-only">Pause</span></span>`
  + `<span class="ck-voice-face" data-voice-face="loading">${spinner()}<span class="sr-only">Cancel</span></span></button>`;

/**
 * @param {string} className
 * @param {number | null} seconds
 */
export const voiceTime = (className, seconds) => `<span class="${className}" data-voice-time><span>${esc(lengthOf(seconds, null))}</span></span>`;

/** @param {string} words */
export const voiceFailed = words => `<div class="ck-voice__failed">${inPlaceLine(words, { retry: { 'data-voice-play': true } })}</div>`;

/**
 * @param {{ sound: string, owner: string, seconds: number | null, src?: string }} bar
 * @returns {Attributes}
 */
export const voiceBar = ({ sound, owner, seconds, src = '' }) => ({ 'data-voice': sound, 'data-voice-owner': owner,
  'data-voice-seconds': seconds === null ? null : String(seconds), 'data-voice-src': src || null });

/**
 * @param {{ audio: string, seconds?: number | null, caption?: string, mine?: boolean, owner: string, open?: Attributes, failed?: string }} note
 */
export function voiceNote({ audio, seconds = null, caption = '', mine = false, owner, open = {}, failed = DIDNT_PLAY }) {
  return `<div${attributes({ class: `ck-voice${caption ? ' ck-voice-cite' : ''}`, ...voiceBar({ sound: audio, owner, seconds }) })}>`
    + `<div class="ck-audio${mine ? ' is-mine' : ''}">${voiceButton('ck-audio__play', 'Play')}`
    + `<span class="ck-audio__line"><i data-voice-line></i></span>${voiceTime('ck-audio__time mac-mono-data', seconds)}</div>`
    + (caption ? `<button${attributes({ type: 'button', class: 'ck-voice-cite__caption mac-subhead', ...open })}>${esc(caption)}</button>` : '')
    + `${voiceFailed(failed)}</div>`;
}
