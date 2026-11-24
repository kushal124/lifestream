// @ts-check

const WAIT_MS = 30_000;

/**
 * @param {string | (() => string)} what
 * @param {() => Promise<boolean> | boolean} check
 */
export async function until(what, check) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`never came in ${WAIT_MS / 1000} s: ${typeof what === 'string' ? what : what()}`)), WAIT_MS);
  });
  try {
    let polls = 0;
    for (;;) {
      const value = await Promise.race([Promise.resolve().then(check), expired]);
      if (value) return;
      polls += 1;
      await Promise.race([new Promise(done => setTimeout(done, polls <= 20 ? 5 : 20)), expired]);
    }
  } finally {
    clearTimeout(timer);
  }
}
