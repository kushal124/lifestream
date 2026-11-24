// @ts-check

import { createHash } from 'node:crypto';

/**
 * @typedef {import('../../lib/ask/conversations.mjs').Message} Message
 * @typedef {import('../../lib/ask/conversations.mjs').Conversation} Conversation
 * @typedef {import('../../lib/ask/conversations.mjs').Submitted} Submitted
 */

/** @returns {import('../../lib/ask/ask.mjs').Conversations} */
export function openMemoryConversations() {
  /** @type {Map<string, Conversation>} */
  const held = new Map();
  /** @type {Map<string, Submitted>} */
  const submissions = new Map();

  /** @param {string} chat */
  const conversationOf = chat => {
    const found = held.get(chat);
    if (found !== undefined) return found;
    /** @type {Conversation} */
    const made = { chat, title: '', messages: [], erased: false, running: null, live: null, shown: [], marks: new Map(), words: new Map(), readied: 0 };
    held.set(chat, made);
    return made;
  };

  /** @param {Conversation} conversation @param {Message} message */
  const hold = (conversation, message) => {
    conversation.messages = [...conversation.messages.filter(each => each.n !== message.n), message].sort((left, right) => left.n - right.n);
  };

  return {
    get: chat => held.get(chat),
    all: () => [...held.values()],
    read: async (_door, chat) => {
      const mine = held.get(chat);
      return mine === undefined || mine.messages.length === 0 ? { absent: 'unknown' } : { chat, title: mine.title, messages: [...mine.messages] };
    },
    list: async () => ({
      chats: [...held.values()].flatMap(each => {
        const last = each.messages.at(-1);
        return last === undefined ? [] : [{ chat: each.chat, title: each.title, first_ms: Number(each.chat.slice(0, 13)), last_ms: last.at_ms, messages: last.n }];
      }).sort((left, right) => right.last_ms - left.last_ms),
    }),
    any: async () => [...held.values()].some(each => each.messages.length > 0),
    knowsSource: async () => true,
    sourceId: async () => null,
    keyed: () => false,
    async begin({ title, chat, n, submission, question }) {
      const conversation = conversationOf(chat);
      if (conversation.title === '') conversation.title = title;
      hold(conversation, question);
      submissions.set(submission, { state: 'pending', chat, n: n + 1 });
      return { conversation, question };
    },
    unsealed: () => null,
    landUnsealed: () => undefined,
    resume: async () => {
      throw new Error('nothing is sealed in memory, so no submission waits to resume');
    },
    async finish(conversation, title, reply, pictures = []) {
      const answer = reply.seen === undefined || pictures.length === 0 ? reply : {
        ...reply, seen: { ...reply.seen, photos: pictures.map(picture => (picture === null ? null : `sha256:${createHash('sha256').update(Buffer.from(picture, 'base64')).digest('hex')}`)) },
      };
      hold(conversation, answer);
      if (conversation.title === '') conversation.title = title;
      for (const [submission, made] of submissions) {
        if (made.chat === answer.chat && made.n === answer.n) submissions.set(submission, { ...made, state: 'delivered' });
      }
      return answer;
    },
    submitted: submission => submissions.get(submission) ?? null,
    erasedNow: async () => false,
    settle: async () => true,
    unsavedIn: () => null,
    retitle(conversation, title) {
      if (conversation.messages.length > 0) conversation.title = title;
    },
  };
}
