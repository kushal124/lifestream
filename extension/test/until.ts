const WAIT_MS = 30_000;

export async function until(what: string, ready: () => boolean | Promise<boolean>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`never came in ${WAIT_MS / 1000} s: ${what}`)), WAIT_MS);
  });
  try {
    for (;;) {
      const value = await Promise.race([Promise.resolve().then(ready), expired]);
      if (value) return;
      await Promise.race([new Promise(done => setTimeout(done, 20)), expired]);
    }
  } finally {
    clearTimeout(timer);
  }
}
