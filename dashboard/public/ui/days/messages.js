// @ts-check
/** @import { Message } from '../kit/thread.js' */
/** @import { DayMessage, Thread } from '../../pages.js' */
/** @import { Made } from '../../types.js' */
import { clock } from '../../lib/words.js';

/** @param {{ mine: boolean, name: string }} said */
const nameOf = said => said.mine ? 'You' : said.name;

/** @param {{ name: string, latitude: number, longitude: number }} place */
const mapsOf = place => ({ name: place.name,
  href: `https://maps.apple.com/?ll=${place.latitude},${place.longitude}&q=${encodeURIComponent(place.name)}` });

/**
 * @param {DayMessage} message
 * @param {number} n
 * @param {ReadonlyMap<string, Made>} transcribed
 * @returns {Message}
 */
function messageOf(message, n, transcribed) {
  const { voice } = message;
  const made = voice ? transcribed.get(message.key) : undefined;
  return {
    n, at: message.at_ms, clock: clock(message.at_ms), speaker: message.name, mine: message.mine, words: message.text,
    forwarded: message.forwarded, edited: message.edited, gone: message.gone, event: message.event,
    ...message.pictures.length ? { pictures: message.pictures.map(picture => ({ hash: picture.hash, alt: picture.alt })) } : {},
    ...message.video ? { video: { hash: message.video } } : {},
    ...message.sticker ? { sticker: { hash: message.sticker, alt: 'Sticker' } } : {},
    ...message.missing.length ? { missing: message.missing.map(kind => kind === 'photo' ? 'Photo' : 'Video') } : {},
    ...voice ? { voice: { audio: voice.audio, seconds: voice.seconds, words: voice.transcript, ...made ? { transcribed: made } : {} } } : {},
    ...message.attachments.length ? { attachments: message.attachments.map(each => ({ ...each })) } : {},
    ...message.link ? { link: { ...message.link } } : {},
    ...message.location ? { place: mapsOf(message.location) } : {},
    ...message.quote ? { quote: { speaker: nameOf(message.quote), words: message.quote.text } } : {},
    ...message.reactions.length ? { reactions: message.reactions.map(each => `${each.face} ${nameOf(each)}`) } : {},
  };
}

/**
 * @param {Thread} thread
 * @param {ReadonlyMap<string, Made>} [transcribed]
 * @returns {Message[]}
 */
export const messagesOf = (thread, transcribed = new Map()) => thread.messages.map((message, n) => messageOf(message, n, transcribed));

/**
 * @param {{ messages: { key: string, parts?: { transcribed?: Made | null }[] }[] }} said
 * @returns {Map<string, Made>}
 */
export function transcribedOf(said) {
  /** @type {Map<string, Made>} */
  const made = new Map();
  for (const fact of said.messages) {
    const transcribed = fact.parts?.find(part => part.transcribed)?.transcribed;
    if (transcribed) made.set(fact.key, transcribed);
  }
  return made;
}
