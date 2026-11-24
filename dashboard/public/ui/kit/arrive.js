// @ts-check

/**
 * @param {ParentNode} root
 * @returns {Map<string, string>}
 */
export const arrivals = root => new Map([...root.querySelectorAll('[data-arrive]')].map(each => [
  /** @type {HTMLElement} */ (each).dataset.arrive ?? '', each.textContent ?? '']));

/**
 * @param {ParentNode} root
 * @param {Map<string, string>} before
 */
export function arrive(root, before) {
  if (!before.size) return;
  let at = 0;
  for (const each of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('[data-arrive]'))) {
    const was = before.get(each.dataset.arrive ?? '');
    if (was === undefined || was === each.textContent) continue;
    const fades = /** @type {HTMLElement} */ (each.querySelector(':scope.ck-btn > .ck-btn__label') ?? each);
    fades.classList.add('ck-changed');
    fades.style.setProperty('--ck-at', String(at));
    at += 1;
  }
}
