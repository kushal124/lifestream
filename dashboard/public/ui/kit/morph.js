// @ts-check

/**
 * @param {Element} box
 * @param {Element} next
 */
function roll(box, next) {
  const incoming = next.firstElementChild;
  const current = [...box.children].find(each => !each.classList.contains('is-leaving'));
  if (!incoming) return void box.replaceChildren();
  if (current && current.textContent === incoming.textContent) {
    const entering = current.classList.contains('is-in');
    current.className = incoming.className;
    if (entering) current.classList.add('is-in');
    return;
  }
  for (const gone of box.querySelectorAll(':scope > .is-leaving')) gone.remove();
  if (current) {
    current.classList.remove('is-in');
    current.classList.add('is-leaving');
    current.addEventListener('animationend', () => current.remove(), { once: true });
  }
  incoming.classList.add('is-in');
  box.append(incoming);
}

/** @type {WeakMap<Element, Element>} */
const drawn = new WeakMap();

/** @param {Node} node */
export function adopt(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const element = /** @type {Element} */ (node);
  for (const each of [element, ...element.querySelectorAll('*')]) drawn.set(each, /** @type {Element} */ (each.cloneNode(false)));
}

/** @param {ChildNode} node */
const sourceOf = node => (node.nodeType === Node.ELEMENT_NODE ? /** @type {Element} */ (node).getAttribute('data-src') : null);

/**
 * @param {Element} now
 * @param {Element} next
 */
function attributesOf(now, next) {
  const was = drawn.get(now);
  if (!was) throw new Error('morph met a node no draw adopted');
  for (const { name } of [...was.attributes]) if (!next.hasAttribute(name)) now.removeAttribute(name);
  for (const { name, value } of [...next.attributes]) if (was.getAttribute(name) !== value) now.setAttribute(name, value);
  drawn.set(now, /** @type {Element} */ (next.cloneNode(false)));
}

/**
 * @param {ChildNode} now
 * @param {ChildNode} next
 */
export function morph(now, next) {
  if (now.nodeType !== next.nodeType || now.nodeName !== next.nodeName || sourceOf(now) !== sourceOf(next)) {
    adopt(next);
    return void now.replaceWith(next);
  }
  if (now.nodeType !== Node.ELEMENT_NODE) {
    if (now.nodeValue !== next.nodeValue) now.nodeValue = next.nodeValue;
    return;
  }
  if (now.isEqualNode(next)) return;
  const element = /** @type {Element} */ (now);
  const into = /** @type {Element} */ (next);
  attributesOf(element, into);
  if (element.hasAttribute('data-ck-roll')) return roll(element, into);
  const wanted = [...into.childNodes];
  const held = [...element.childNodes];
  wanted.forEach((child, at) => {
    const kept = held[at];
    if (kept) morph(kept, child);
    else {
      adopt(child);
      element.append(child);
    }
  });
  for (const extra of held.slice(wanted.length)) extra.remove();
}
