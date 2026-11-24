// @ts-check
import { HANDLE } from '../hiding.mjs';
import { linksIn, unnoticed } from '../shape.mjs';


/** @param {unknown} value @returns {value is string} */
const isHandle = value => typeof value === 'string' && HANDLE.test(value);
/** @param {unknown} value */
const words = value => (typeof value === 'string' && value.trim() !== '' ? value : undefined);

/** @param {Record<string, import('./conversations.mjs').Cited>} [seed] */
export function openHandles(seed = {}) {
  /** @type {Map<string, string>} */
  const named = new Map();
  /** @type {Set<string>} */
  const links = new Set();

  /**
   * @param {unknown} handle
   * @param {unknown} [name]
   */
  const note = (handle, name) => {
    if (!isHandle(handle)) return;
    if (!named.get(handle)) named.set(handle, words(name) ?? '');
  };

  for (const [handle, cited] of Object.entries(seed)) {
    note(handle, 'title' in cited ? cited.title : 'name' in cited ? cited.name : 'asked' in cited ? cited.asked : undefined);
  }

  return {
    /**
     * @param {{ cited: { handle: string, title?: string }[], text: string, links: string[] }} ran
     * @returns {string[]}
     */
    ran(ran) {
      for (const { handle, title } of ran.cited) note(handle, title);
      for (const link of ran.links) links.add(link);
      /** @type {unknown} */
      let parsed;
      try {
        parsed = JSON.parse(unnoticed(ran.text));
      } catch {
        parsed = undefined;
      }
      const given = [...new Set([...givenIn(parsed), ...ran.cited.map(cited => cited.handle).filter(isHandle)])];
      for (const handle of given) note(handle);
      return given;
    },
    /** @param {string} handle */
    name: handle => named.get(handle) || undefined,
    /**
     * @param {number} from
     * @param {number} to
     */
    within: (from, to) => [...named.keys()].map(handle => Number(handle.slice(1))).filter(n => n >= from && n <= to)
      .sort((left, right) => left - right).map(n => `r${n}`),
    /** @param {string} text */
    heard: text => { for (const link of linksIn(text)) links.add(link); },
    /** @param {string} url */
    seen: url => links.has(url),
  };
}

const CURSOR = new Set(['next', 'cursor']);
/**
 * @param {unknown} parsed
 * @returns {string[]}
 */
function givenIn(parsed) {
  /** @type {string[]} */
  const out = [];
  /** @param {unknown} value */
  const walk = value => {
    if (typeof value === 'string') { if (HANDLE.test(value)) out.push(value); return; }
    if (Array.isArray(value)) return value.forEach(walk);
    if (value === null || typeof value !== 'object') return;
    for (const [key, inner] of Object.entries(value)) if (!CURSOR.has(key)) walk(inner);
  };
  walk(parsed);
  return out;
}
