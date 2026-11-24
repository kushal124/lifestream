
const WAIT_MS = 30_000;

/**
 * @template T
 * @param {string} what
 * @param {() => T | Promise<T>} ready
 * @returns {Promise<T>}
 */
export async function until(what, ready) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`never came in ${WAIT_MS / 1000} s: ${what}`)), WAIT_MS);
  });
  try {
    for (let polls = 0; ; polls += 1) {
      const value = await Promise.race([Promise.resolve().then(ready).catch(() => undefined), expired]);
      if (value) return value;
      await Promise.race([new Promise(done => setTimeout(done, polls < 20 ? 5 : 20)), expired]);
    }
  } finally {
    clearTimeout(timer);
  }
}
