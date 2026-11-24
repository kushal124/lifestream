// @ts-check

export const BLIND_MS = 60_000;

/**
 * @template T
 * @param {() => Promise<T>} read
 * @param {{ open: () => boolean, now: () => number, eager?: boolean }} options
 */
export function readBehind(read, { open, now, eager = false }) {
  /** @type {T | null} */
  let value = null;
  /** @type {Promise<void> | null} */
  let building = null;
  /** @type {string | null} */
  let error = null;
  let owed = true;
  let again = false;
  let blind = false;
  let next_ms = 0;
  let begun = 0;
  let ended = 0;
  /** @type {(() => void)[]} */
  const waiters = [];

  function start() {
    owed = false;
    again = false;
    const mine = ++begun;
    const began = now();
    const unseen = !open();
    building = read().then(read => {
      value = read;
      error = null;
      blind = unseen && !open();
      next_ms = blind ? began + BLIND_MS : 0;
    }, failed => {
      error = /** @type {Error} */ (failed).message;
      owed = true;
      next_ms = began + BLIND_MS;
    }).finally(() => {
      building = null;
      ended = mine;
      for (const done of waiters.splice(0)) done();
      if (again) start();
    });
  }

  function moved() {
    owed = true;
    next_ms = 0;
    if (building) again = true;
    else if (eager) start();
  }

  return {
    /** @returns {T | null} */
    get() {
      if (!building && (owed || (blind && !open())) && now() >= next_ms) start();
      return value;
    },
    moved,
    opened() {
      if (blind) moved();
    },
    /** @returns {Promise<T>} */
    async held() {
      if (value === null && !building) start();
      while (value === null && building) await building;
      if (value === null) throw new Error(error ?? 'It could not be read.');
      return value;
    },
    /** @returns {Promise<T>} */
    async fresh() {
      moved();
      if (!building) start();
      const want = again ? begun + 1 : begun;
      while (ended < want) await new Promise(done => waiters.push(() => done(undefined)));
      if (value === null || error !== null) throw new Error(error ?? 'It could not be read.');
      return value;
    },
    /** @returns {Promise<T | null>} */
    async landed() {
      const want = begun;
      while (ended < want) await new Promise(done => waiters.push(() => done(undefined)));
      if (error !== null) throw new Error(error);
      return value;
    },
    get building() {
      return building !== null;
    },
    get error() {
      return error;
    },
  };
}
