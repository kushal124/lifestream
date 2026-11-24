// @ts-check

/** @param {ParentNode} root */
export function applyGeometry(root) {
  for (const element of root.querySelectorAll('[data-geo]')) {
    const target = /** @type {HTMLElement} */ (element);
    for (const declaration of String(target.dataset.geo).split(';')) {
      const colon = declaration.indexOf(':');
      if (colon > 0) target.style.setProperty(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
    }
    target.removeAttribute('data-geo');
  }
}
