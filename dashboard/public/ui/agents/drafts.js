// @ts-check

/** @typedef {{ access: import('../../types.js').Access, view: import('../../types.js').AccessView }} Kept */

/** @type {Map<string, Kept>} */
const held = new Map();
/** @type {Set<() => void>} */
const followers = new Set();

const tell = () => {
  for (const follower of followers) follower();
};

export const drafts = {
  /** @returns {string[]} */
  ids: () => [...held.keys()],
  /** @param {string} id */
  of: id => held.get(id) ?? null,
  /**
   * @param {string} id
   * @param {Kept} kept
   */
  keep(id, kept) {
    held.set(id, kept);
    tell();
  },
  /** @param {string} id */
  forget(id) {
    if (held.delete(id)) tell();
  },
  /** @param {() => void} follower */
  follow(follower) {
    followers.add(follower);
  },
};
