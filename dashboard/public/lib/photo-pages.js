// @ts-check
export const PHOTO_PAGE_SIZES = [12, 24, 48, 96];
const SIZE_KEY = 'photo-page-size';

const sizeKept = () => {
  try {
    const kept = Number(localStorage.getItem(SIZE_KEY));
    return PHOTO_PAGE_SIZES.includes(kept) ? kept : PHOTO_PAGE_SIZES[0];
  } catch {
    return PHOTO_PAGE_SIZES[0];
  }
};

/**
 * @template P
 * @typedef {{ total: number | null, page: number, size: number, photos: P[] | null, error: string }} PhotoPagesView
 */

/**
 * @template P
 * @typedef {object} PhotoPages
 * @property {() => PhotoPagesView<P>} view
 * @property {(page: number) => void} go
 * @property {(size: number) => void} resize
 * @property {() => void} again
 * @property {(index: number) => P | Promise<P>} photo
 */

/**
 * @template P
 * @param {(at: number, limit: number) => Promise<{ photos: P[], total: number }>} read
 * @param {() => void} changed
 * @returns {PhotoPages<P>}
 */
export function photoPages(read, changed) {
  /** @type {Map<number, P>} */
  let held = new Map();
  /** @type {Map<string, Promise<void>>} */
  let reading = new Map();
  /** @type {number | null} */
  let total = null;
  let page = 0;
  let size = sizeKept();
  let error = '';

  const pages = () => Math.max(1, Math.ceil((total ?? 0) / size));
  /** @param {number} at */
  const indexes = at => Array.from({ length: Math.max(0, Math.min(size, (total ?? size) - at * size)) }, (_, n) => at * size + n);

  /** @param {number} at */
  function fill(at) {
    const key = `${at}:${size}`;
    const under = reading.get(key);
    if (under) return under;
    const into = reading;
    const done = read(at, size).then(answer => {
      if (into !== reading) return;
      total = answer.total;
      answer.photos.forEach((photo, n) => held.set(at + n, photo));
      error = '';
    }, failed => {
      if (into !== reading) return;
      error = failed instanceof Error ? failed.message : String(failed);
    }).finally(() => {
      if (into !== reading) return;
      reading.delete(key);
      if (page >= pages()) {
        page = pages() - 1;
        show();
      }
      changed();
    });
    reading.set(key, done);
    return done;
  }

  function show() {
    if (total === null || indexes(page).some(index => !held.has(index))) void fill(page * size);
  }

  return {
    view: () => {
      const wanted = indexes(page);
      return { total, page, size, error,
        photos: total !== null && wanted.every(index => held.has(index)) ? wanted.map(index => /** @type {P} */ (held.get(index))) : null };
    },
    go: to => {
      page = Math.max(0, Math.min(pages() - 1, to));
      show();
      changed();
    },
    resize: to => {
      if (!PHOTO_PAGE_SIZES.includes(to) || to === size) return;
      const first = page * size;
      size = to;
      page = Math.floor(first / size);
      try {
        localStorage.setItem(SIZE_KEY, String(size));
      } catch {
      }
      show();
      changed();
    },
    again: () => {
      reading = new Map();
      const into = reading;
      void fill(page * size).then(() => {
        if (into === reading) held = new Map([...held].filter(([index]) => indexes(page).includes(index)));
      });
    },
    photo: index => {
      const kept = held.get(index);
      if (kept !== undefined) return kept;
      return fill(Math.floor(index / size) * size).then(() => {
        const landed = held.get(index);
        if (landed === undefined) throw new Error('This photo cannot be read now.');
        return landed;
      });
    },
  };
}
