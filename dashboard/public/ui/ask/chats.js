// @ts-check
/** @import { ChatSummary } from './turns.js' */
import { fetchChats } from '../../lib/api.js';

/** @typedef {{ list: ChatSummary[] | null, answering: ReadonlySet<string>, failed: boolean, more: boolean }} HeldChats */

/** @type {ChatSummary[] | null} */
let list = null;
/** @type {ReadonlySet<string>} */
let answering = new Set();
let failed = false;
/** @type {string | null} */
let next = null;
let pagesRead = 0;
let pagesWanted = 1;
/** @type {Map<string, { summary: ChatSummary, reads: number }>} */
const begunHere = new Map();
/** @type {Set<(held: HeldChats) => void>} */
const followers = new Set();
let reads = 0;
/** @type {Promise<ChatSummary[] | null> | null} */
let under = null;
/** @type {Promise<ChatSummary[] | null> | null} */
let reading = null;

/** @returns {HeldChats} */
const held = () => ({ list, answering, failed, more: next !== null });
const tell = () => {
  const now = held();
  for (const follower of followers) follower(now);
};

/**
 * @param {(held: HeldChats) => void} follower
 * @returns {() => void}
 */
export function followChats(follower) {
  followers.add(follower);
  follower(held());
  return () => void followers.delete(follower);
}

/** @returns {HeldChats} */
export const heldChats = held;

/**
 * @param {ChatSummary[]} read
 * @param {number} mine
 */
function withBegun(read, mine) {
  const missing = [];
  for (const [chat, { summary, reads: before }] of begunHere) {
    if (mine > before) begunHere.delete(chat);
    else if (!read.some(each => each.chat === chat)) missing.push(summary);
  }
  return missing.length ? [...missing.reverse(), ...read] : read;
}

/**
 * @param {ChatSummary[]} read
 * @param {ChatSummary[]} page
 */
const joined = (read, page) => [...read, ...page.filter(chat => !read.some(each => each.chat === chat.chat))];

/**
 * @param {{ again?: boolean }} [options]
 * @returns {Promise<ChatSummary[] | null>}
 */
export function readChats({ again = false } = {}) {
  if (under && !again) return under;
  const mine = ++reads;
  const read = (async () => {
    try {
      let page = await fetchChats();
      if (mine !== reads) return null;
      let read = page.chats;
      let pages = 1;
      if (!list) {
        list = withBegun(read, mine);
        next = page.next ?? null;
        pagesRead = 1;
        tell();
      }
      while (page.next && pages < pagesWanted) {
        page = await fetchChats(page.next);
        if (mine !== reads) return null;
        read = joined(read, page.chats);
        pages += 1;
      }
      list = withBegun(read, mine);
      next = page.next ?? null;
      pagesRead = pages;
      failed = false;
      tell();
      return list;
    } catch (error) {
      if (mine === reads) {
        failed = true;
        tell();
      }
      throw error;
    }
  })();
  under = read;
  const done = () => {
    if (under === read) under = null;
  };
  read.then(done, done);
  return read;
}

/** @returns {Promise<ChatSummary[] | null>} */
export function more() {
  if (reading) return reading;
  if (!list || next === null) return Promise.resolve(list);
  pagesWanted = pagesRead + 1;
  if (under) return under;
  const mine = reads;
  const after = next;
  const read = (async () => {
    try {
      const page = await fetchChats(after);
      if (mine !== reads || !list) return null;
      list = joined(list, page.chats);
      next = page.next ?? null;
      pagesRead += 1;
      tell();
      return list;
    } catch (error) {
      if (mine === reads) pagesWanted = pagesRead;
      throw error;
    }
  })();
  reading = read;
  const done = () => {
    if (reading === read) reading = null;
  };
  read.then(done, done);
  return read;
}

const NEAR_END = '0px 0px 25% 0px';

/**
 * @param {Element} end
 * @param {Element | null} root
 * @returns {() => void}
 */
export function moreWhenNear(end, root) {
  const watch = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) void more().catch(() => undefined);
  }, { root, rootMargin: NEAR_END });
  watch.observe(end);
  return () => watch.disconnect();
}

/**
 * @param {string} chat
 * @param {string} title
 */
export function began(chat, title) {
  if (!list || list.some(each => each.chat === chat)) return;
  const now = Date.now();
  const summary = { chat, title, first_ms: now, last_ms: now, messages: 1 };
  begunHere.set(chat, { summary, reads });
  list = [summary, ...list];
  tell();
}

/**
 * @param {string} chat
 * @param {string} title
 */
export function titled(chat, title) {
  const begun = begunHere.get(chat);
  if (begun) begun.summary = { ...begun.summary, title };
  if (!list?.some(each => each.chat === chat && each.title !== title)) return;
  list = list.map(each => each.chat === chat ? { ...each, title } : each);
  tell();
}

/** @param {Iterable<string>} chats */
export function answeringIn(chats) {
  const now = new Set(chats);
  if (now.size === answering.size && [...now].every(chat => answering.has(chat))) return;
  answering = now;
  tell();
}
