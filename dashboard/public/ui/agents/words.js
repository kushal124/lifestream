// @ts-check

export const PAGE = {
  title: 'Agents',
  connect: 'Connect an agent',
  needs: 'Needs you',
  connected: 'Connected',
  inLifestream: 'In Lifestream',
  disconnected: 'Disconnected',
  review: 'Review',
  asking: 'Asking',
  failed: 'Couldn’t read your agents.',
  reading: 'Reading your agents',
  browser: 'Allow this in Lifestream on your Mac or iPhone.',
};

export const GUIDE = {
  copy: 'Copy',
  edit: 'Edit',
  done: 'Done',
  deny: 'Don’t allow',
  again: 'Start again',
  check: 'Check again',
  connected: 'Connected',
  getting: 'Getting your address…',
  making: 'Making the key…',
  internet: 'From the internet',
};

export const NAME_SLOT = '{name}';
export const HOST_SLOT = '{host}';

export const AGENT = {
  access: 'Access',
  reads: 'Reads',
  far: 'How far back',
  hides: 'Hides',
  history: 'History',
  seeAll: 'See all history',
  connection: 'Connection',
  /** @param {string} name */
  disconnectOpen: name => `Disconnect ${name}…`,
  stops: 'Stops',
  stays: 'Stays',
  unlistOpen: 'Remove from the list…',
  unlist: 'Remove',
  notNow: 'Not now',
  cancel: 'Cancel',
  unreached: 'Can’t reach Lifestream on your Mac.',
  kept: 'Kept from it',
  why: 'Why it could',
  seeExactly: 'See exactly what it saw',
  showMore: 'Show more',
  other: 'Other',
  kinds: 'What it read',
};

export const ASKED = {
  adds: 'It would also see',
  edit: 'Edit',
  /** @param {number} n */
  asks: n => `1 of ${n} asks`,
};

export const SIGNING = {
  sees: 'It will see',
  edit: 'Edit',
  only: 'Only you can let an agent in.',
  deny: 'Don’t allow',
};

export const ACCESS = {
  readsHead: 'Read in 30 days',
  sees: 'What it can see',
  none: '—',
  undo: 'Undo',
  cancel: 'Cancel',
  allow: 'Allow',
  done: 'Done',
  since: 'Since',
  set: 'Set',
  /** @param {string} name */
  hiddenFrom: name => `Hidden from ${name}`,
  /** @param {string} name */
  hide: name => `Hide ${name}`,
};

export const HIDES = { title: 'Hides' };
