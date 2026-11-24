// @ts-check
/** @import { Made } from '../../types.js' */
import { attributes, esc } from '../../lib/html.js';
import { icon } from './icon.js';
import { made, sentLine, TRANSCRIBE } from './made.js';
import { inPlaceLine } from './states.js';
import { linked } from './prose.js';
import { shape } from './skeleton.js';
import { picture as renderPicture } from './picture.js';
import { videoTile } from './video.js';
import { installVoice, runs, voiceNote } from './voice.js';

/**
 * @typedef {{ hash: string, alt: string }} Picture
 * @typedef {object} Message
 * @property {number} n
 * @property {number | null} at
 * @property {string} clock
 * @property {string} speaker
 * @property {boolean} mine
 * @property {string} words
 * @property {Picture[]} [pictures]
 * @property {{ hash: string } | null} [video]
 * @property {{ audio: string | null, seconds: number | null, words: string, transcribed?: Made | null, sent?: { words: string, href: string | null } | null } | null} [voice]
 * @property {Picture | null} [sticker]
 * @property {string[]} [missing]
 * @property {{ icon: string, name: string, line?: string }[]} [attachments]
 * @property {{ title: string, href: string }} [link]
 * @property {{ name: string, href: string } | null} [place]
 * @property {{ speaker: string, words: string } | null} [quote]
 * @property {string[]} [reactions]
 * @property {boolean} [forwarded]
 * @property {boolean} [edited]
 * @property {boolean} [gone]
 * @property {string | null} [event]
 */

/** @param {string} href */
export const hostOf = href => {
  try {
    return new URL(href).hostname.replace(/^www\./u, '');
  } catch {
    return href;
  }
};

const BREAK_MS = 5 * 60_000;

/**
 * @param {string} html
 * @param {string[]} terms
 */
function marked(html, terms) {
  const wanted = terms.map(term => term.trim()).filter(term => term.length > 1);
  if (!wanted.length) return html;
  const pattern = new RegExp(`(${wanted.map(term => esc(term).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})`, 'giu');
  return html.split(/(<[^>]+>)/u).map(part => part.startsWith('<') ? part : part.replace(pattern, '<mark>$1</mark>'))
    .join('');
}

/**
 * @param {Picture[]} pictures
 * @param {number} first
 */
function pictureGrid(pictures, first) {
  /** @param {Picture} picture @param {number} index @param {string} [more] */
  const one = (picture, index, more = '') => `<button class="ck-msg__shot"${attributes({
    type: 'button', 'data-ck-picture': first + index, 'data-ck-hash': picture.hash, 'aria-label': `${picture.alt || 'Picture'}, full size` })}>`
    + renderPicture({ ...picture, size: 'tile' }, { attrs: { loading: 'lazy' } })
    + `<span class="ck-msg__lost mac-footnote">${icon('photo', { size: 'xs' })}Can’t show this photo</span>`
    + (more ? `<span class="ck-msg__more">${esc(more)}</span>` : '') + '</button>';
  if (pictures.length === 1) return `<div class="ck-msg__pics is-1">${one(pictures[0], 0)}</div>`;
  const shown = pictures.slice(0, 4);
  return `<div class="ck-msg__pics is-${Math.min(pictures.length, 4)}">${shown.map((picture, index) =>
    one(picture, index, index === 3 && pictures.length > 4 ? `+${pictures.length - 3}` : '')).join('')}</div>`;
}

/**
 * @param {{ audio: string | null, seconds: number | null, words: string }} voice
 * @param {{ owner?: string, mine?: boolean }} [drawn]
 */
export function voiceLine(voice, { owner = '', mine = false } = {}) {
  const player = voice.audio ? voiceNote({ audio: voice.audio, seconds: voice.seconds, mine, owner })
    : `<p class="ck-msg__missing mac-subhead">${icon('voice-note', { size: 'xs' })}Voice note`
      + `${voice.seconds === null ? '' : ` · ${esc(runs(voice.seconds))}`}</p>`;
  return player + (voice.words ? `<p class="ck-msg__said mac-subhead">“${esc(voice.words)}”</p>` : '');
}

/** @typedef {Pick<import('./made.js').MadeActs, 'hosted' | 'busy' | 'refused'>} Transcripts */

/**
 * @param {Made | null | undefined} transcribed
 * @param {Transcripts | null} acts
 */
function transcriptOf(transcribed, acts) {
  if (!transcribed || !acts) return '';
  const item = transcribed.ask?.item ?? '';
  return made({ made: transcribed, verbs: TRANSCRIBE, acts: acts.hosted && item !== '',
    busy: acts.busy(transcribed), id: item || 'voice', attrs: { 'data-ck-transcribe': item } })
    + (acts.refused(transcribed) ? inPlaceLine(acts.refused(transcribed)) : '');
}

/**
 * @param {Message[]} messages
 * @param {{ group?: boolean, marks?: number[], terms?: string[], transcripts?: Transcripts | null, owner?: string }} [options]
 */
export function thread(messages, { group = false, marks = [], terms = [], transcripts = null, owner = '' } = {}) {
  let html = '';
  /** @type {Message | null} */
  let last = null;
  let lastAt = -Infinity;
  let picture = 0;
  for (const message of messages) {
    const at = message.at ?? lastAt;
    if (at - lastAt >= BREAK_MS) {
      html += `<p class="ck-thread__break mac-mono-time">${esc(message.clock)}</p>`;
      last = null;
    }
    lastAt = at;
    if (message.event) {
      html += `<p class="ck-thread__event mac-footnote">${esc(`${message.mine ? 'You' : message.speaker} ${message.event}`)}</p>`;
      last = null;
      continue;
    }
    const newRun = last === null || last.speaker !== message.speaker;
    if (group && newRun && !message.mine && message.speaker) {
      html += `<p class="ck-thread__name mac-footnote">${esc(message.speaker)}</p>`;
    }
    const isMarked = message.n !== undefined && marks.includes(message.n);
    const quote = message.quote ? `<span class="ck-bubble__quote mac-footnote"><b>${esc(message.quote.speaker)}</b>`
      + `${esc(message.quote.words)}</span>` : '';
    const carries = Boolean(message.pictures?.length || message.video || message.sticker || message.voice
      || message.place || message.attachments?.length || message.missing?.length);
    let inner = carries && quote && !message.gone ? `<p class="ck-bubble ck-bubble--quote mac-body">${quote}</p>` : '';
    if (message.pictures?.length) {
      inner += pictureGrid(message.pictures, picture);
      picture += message.pictures.length;
    }
    if (message.video) {
      inner += `<div class="ck-msg__pics is-1">${videoTile({ hash: message.video.hash, className: 'ck-msg__shot',
        attrs: { 'data-ck-picture': picture, 'data-ck-hash': message.video.hash } })}</div>`;
      picture += 1;
    }
    if (message.sticker) inner += renderPicture({ ...message.sticker, size: 'tile' }, { className: 'ck-msg__sticker', attrs: { loading: 'lazy' } });
    for (const what of message.missing ?? []) {
      inner += `<p class="ck-msg__missing mac-subhead">${icon(what === 'Video' ? 'video' : 'photo', { size: 'xs' })}`
        + `${esc(what)} · not in Lifestream</p>`;
    }
    if (message.voice) inner += voiceLine(message.voice, { owner, mine: message.mine }) + transcriptOf(message.voice.transcribed, transcripts) + sentLine(message.voice.sent);
    if (message.place) {
      inner += `<a class="ck-bubble ck-bubble--card mac-body"${attributes({ href: message.place.href, target: '_blank',
        rel: 'noopener noreferrer' })}>${icon('location', { size: 'sm' })}<span class="ck-bubble__card"><span>`
        + `${esc(message.place.name)}</span><span class="ck-bubble__line mac-footnote">Open in Maps</span></span></a>`;
    }
    for (const thing of message.attachments ?? []) {
      inner += `<p class="ck-bubble ck-bubble--card mac-body">${icon(thing.icon, { size: 'sm' })}<span class="ck-bubble__card">`
        + `<span>${esc(thing.name)}</span>${thing.line ? `<span class="ck-bubble__line mac-footnote">${esc(thing.line)}</span>` : ''}</span></p>`;
    }
    const inBubble = carries ? '' : quote;
    const note = [message.forwarded ? 'Forwarded' : '', message.edited ? 'edited' : ''].filter(Boolean);
    if (message.gone) inner += `<p class="ck-bubble ck-bubble--gone mac-body">${message.mine ? 'You deleted this message' : 'This message was deleted'}</p>`;
    else if (message.words || inBubble) {
      const words = isMarked ? marked(linked(message.words), terms) : linked(message.words);
      inner += `<p class="ck-bubble mac-body">${inBubble}${note.includes('Forwarded') ? '<span class="ck-bubble__note mac-footnote">Forwarded</span>' : ''}`
        + `${words}${note.includes('edited') ? ' <span class="ck-bubble__note mac-footnote">edited</span>' : ''}`
        + (message.link ? `<a class="ck-bubble__link"${attributes({ href: message.link.href, target: '_blank', rel: 'noopener noreferrer' })}>`
          + `<span class="mac-headline">${esc(message.link.title)}</span><span class="mac-footnote">${esc(hostOf(message.link.href))}</span></a>` : '')
        + '</p>';
    }
    if (message.reactions?.length) inner += `<p class="ck-msg__reactions mac-footnote">${esc(message.reactions.join('  '))}</p>`;
    if (!inner) continue;
    const classes = ['ck-msg', message.mine ? 'is-mine' : '', newRun && last ? 'is-run' : '', isMarked ? 'is-marked' : '']
      .filter(Boolean).join(' ');
    html += `<div${attributes({ class: classes, 'data-ck-n': message.n, title: message.clock })}>${inner}</div>`;
    last = message;
  }
  return `<div class="ck-thread">${html}</div>`;
}

const BUBBLES = /** @type {const} */ ([[false, 2], [false, 4], [true, 3], [false, 1], [false, 3], [true, 2]]);

export const threadReading = () => '<div class="ck-thread" aria-hidden="true">'
  + BUBBLES.map(([mine, width], at) => `<div class="ck-msg${mine ? ' is-mine' : ''}${at && mine !== BUBBLES[at - 1][0] ? ' is-run' : ''}">`
    + `${shape({ className: `ck-msg__sk ck-msg__sk--${width} mac-body` })}</div>`).join('')
  + '</div>';

/** @param {HTMLElement} root */
export function installThread(root) {
  installVoice();
  root.addEventListener('error', event => {
    const target = /** @type {Element} */ (event.target);
    if (target instanceof HTMLImageElement || target instanceof HTMLVideoElement) {
      target.closest('.ck-msg__shot:not(.ck-video-tile), .ck-msg__sticker')?.classList.add('is-failed');
    }
  }, true);
}
