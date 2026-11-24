// @ts-check

/**
 * @param {string} selector
 * @param {ParentNode} [root]
 */
export const $ = (selector, root = document) => /** @type {HTMLElement} */ (root.querySelector(selector));

/**
 * @param {string} selector
 * @param {ParentNode} [root]
 * @returns {HTMLElement | null}
 */
export const find = (selector, root = document) => root.querySelector(selector);

/** @param {string} selector */
export const $input = selector => /** @type {HTMLInputElement} */ ($(selector));

/** @param {string} selector */
export const $select = selector => /** @type {HTMLSelectElement} */ ($(selector));

/** @param {string} selector */
export const $textarea = selector => /** @type {HTMLTextAreaElement} */ ($(selector));

/** @param {string} selector */
export const $dialog = selector => /** @type {HTMLDialogElement} */ ($(selector));

/** @param {string} selector */
export const $button = selector => /** @type {HTMLButtonElement} */ ($(selector));

/** @param {Event} event */
export const targetOf = event => /** @type {Element} */ (event.target);

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** @param {string} text */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}
