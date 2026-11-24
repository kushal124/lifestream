// @ts-check
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

export const CONTENT_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

/** @typedef {{ body: Buffer, type: string }} StaticFile */

/** @param {string} file */
const typeOf = file => CONTENT_TYPES[/** @type {keyof typeof CONTENT_TYPES} */ (extname(file))] ?? null;

/**
 * @param {string} publicDir
 * @param {Record<string, string>} named
 * @returns {(pathname: string) => Promise<StaticFile | null>}
 */
export function staticFiles(publicDir, named) {
  const root = resolve(publicDir);
  /** @type {Map<string, Promise<StaticFile | null>>} */
  const cached = new Map();
  /**
   * @param {string} file
   * @param {string} type
   * @returns {Promise<StaticFile | null>}
   */
  const load = (file, type) => {
    const held = cached.get(file);
    if (held) return held;
    const reading = readFile(file).then(
      body => ({ body, type }),
      error => {
        cached.delete(file);
        const code = /** @type {NodeJS.ErrnoException} */ (error).code;
        if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') return null;
        throw error;
      },
    );
    cached.set(file, reading);
    return reading;
  };
  return async pathname => {
    const fixed = named[pathname];
    const fixedType = fixed ? typeOf(fixed) : null;
    if (fixed && fixedType) return load(fixed, fixedType);
    let relative;
    try {
      relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    } catch {
      return null;
    }
    if (relative.includes('\0') || relative.split(/[/\\]/).some(segment => segment.startsWith('.'))) return null;
    const file = resolve(root, relative);
    if (!file.startsWith(root + sep)) return null;
    const type = typeOf(file);
    if (!type) return null;
    return load(file, type);
  };
}
