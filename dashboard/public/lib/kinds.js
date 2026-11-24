// @ts-check
import { capital } from './words.js';

/** @typedef {{ label: string, icon: string }} KindWords */

/** @type {Record<string, KindWords>} */
export const FAMILIES = {
  messages: { label: 'Messages', icon: 'message' },
  mail: { label: 'Mail', icon: 'mail' },
  calls: { label: 'Calls', icon: 'call' },
  calendar: { label: 'Calendar', icon: 'calendar-event' },
  notes: { label: 'Notes', icon: 'note' },
  voice: { label: 'Voice notes', icon: 'voice-note' },
  photos: { label: 'Photos', icon: 'photos' },
  physical: { label: 'Places', icon: 'place' },
  screen: { label: 'Mac', icon: 'work-mac' },
  phone: { label: 'Phone', icon: 'phone-screen' },
  web: { label: 'Browsing', icon: 'web' },
  ai: { label: 'AI chats', icon: 'ai' },
  health: { label: 'Health', icon: 'health' },
  listening: { label: 'Listening', icon: 'listening' },
  money: { label: 'Payments', icon: 'money' },
  labels: { label: 'Labels', icon: 'person' },
  plain: { label: 'Other', icon: 'info' },
};

/**
 * @param {string | null} family
 * @returns {KindWords}
 */
export function familyWords(family) {
  const known = family ? FAMILIES[family] : undefined;
  return known ?? { label: family ? capital(family) : 'Other', icon: 'info' };
}

/**
 * @typedef {{ name: string, row: string, icon: string | null }} Product
 * @typedef {Readonly<Record<string, Product>>} Products
 */

/** @param {string} source */
export const productId = source => source.split(':')[0];

let held = /** @type {Products} */ ({});

/** @param {Products} products */
export const holdProducts = products => {
  held = products;
};

/** @param {string} id */
export const productName = id => productOf(held, id).name;

/** @param {string} id */
export const productIcon = id => productOf(held, id).icon ?? 'info';

/** @param {{ id: string, kind: string }} handle */
export const handleValue = handle => handle.kind === 'network' ? handle.id : handle.id.slice(handle.id.indexOf(':') + 1);

/**
 * @param {Products | undefined} products
 * @param {string} id
 * @returns {Product}
 */
export function productOf(products, id) {
  const product = productId(id);
  return products?.[product] ?? { name: product, row: product, icon: 'info' };
}

/** @param {string} name */
export const who = name => name === 'the user' ? 'You' : name;
