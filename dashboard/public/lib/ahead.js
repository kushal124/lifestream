// @ts-check

const REST_MS = 40;
const GOOD_MS = 5_000;

/**
 * @template T
 * @param {(key: string) => Promise<T>} read
 */
export function ahead(read) {
  /** @type {{ key: string, at: number, asked: Promise<T> } | null} */
  let held = null;
  const good = (/** @type {string} */ key) => held?.key === key && performance.now() - held.at < GOOD_MS;
  return {
    /**
     * @param {string} key
     * @returns {Promise<T>}
     */
    begin(key) {
      if (held && good(key)) return held.asked;
      const asked = read(key);
      asked.catch(() => {});
      held = { key, at: performance.now(), asked };
      return asked;
    },
    /** @param {string} key */
    take(key) {
      const kept = good(key) ? held?.asked : undefined;
      held = null;
      return kept ?? read(key);
    },
    forget() {
      held = null;
    },
  };
}

/**
 * @param {Element} root
 * @param {string} selector
 * @param {(on: HTMLElement) => void} begin
 */
export function restOn(root, selector, begin) {
  /** @type {Element | null} */
  let resting = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  root.addEventListener('pointerover', event => {
    const on = event.target instanceof Element ? event.target.closest(selector) : null;
    if (on === resting) return;
    resting = on;
    clearTimeout(timer);
    if (on) timer = setTimeout(() => begin(/** @type {HTMLElement} */ (on)), REST_MS);
  });
}
