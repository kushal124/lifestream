// @ts-check
/** @import { IncomingMessage, ServerResponse } from 'node:http' */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sendJson, setSecurityHeaders } from './http.mjs';

export const KEY_FILE = 'viewer-key';
export const KEY_COOKIE = 'lifestream_viewer';
export const KEY_HEADER = 'x-lifestream-viewer-key';
export const KEY_QUERY = 'k';
const KEY = /^[0-9a-f]{64}$/u;
export const NO_KEY = 'This page needs Lifestream\'s key: open it from the Lifestream app.';

/**
 * @param {string} path
 * @returns {string | null}
 */
function readKey(path) {
  try {
    const text = readFileSync(path, 'utf8').trim();
    return KEY.test(text) ? text : null;
  } catch {
    return null;
  }
}

/**
 * The key a page on this Mac shows to read through the dashboard. It lives beside the door token, readable by its owner
 * alone; the Mac app reads the same file, and whichever of the two comes first makes it.
 * @param {string} stateDir
 * @returns {string}
 */
export function viewerKey(stateDir) {
  const path = join(stateDir, KEY_FILE);
  const held = readKey(path);
  if (held !== null) return held;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const draft = join(stateDir, `.${KEY_FILE}-${process.pid}-${randomBytes(6).toString('hex')}`);
  writeFileSync(draft, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
  try {
    linkSync(draft, path);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error;
  } finally {
    rmSync(draft, { force: true });
  }
  const made = readKey(path);
  if (made === null) throw new Error(`${path} holds no viewer key`);
  return made;
}

/**
 * @param {string | undefined} given
 * @param {Buffer} key
 */
function matches(given, key) {
  if (typeof given !== 'string') return false;
  const bytes = Buffer.from(given, 'utf8');
  return bytes.length === key.length && timingSafeEqual(bytes, key);
}

/** @param {IncomingMessage} req */
function cookieOf(req) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === KEY_COOKIE && value.length) return value.join('=');
  }
  return undefined;
}

/**
 * Pages served on 127.0.0.1 answer any program on this Mac, and any account on it. The gate holds every /api/ route
 * shut until a request shows the key: as a header (the app's own relay), or as the cookie a launch address sets.
 * @param {string | null} key null leaves the dashboard open, which only tests and tools ask for
 * @returns {(req: IncomingMessage, res: ServerResponse) => boolean} true when the gate answered
 */
export function viewerKeyGate(key) {
  if (key === null) return () => false;
  const expected = Buffer.from(key, 'utf8');
  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const api = url.pathname.startsWith('/api/');
    if (!api && url.searchParams.has(KEY_QUERY)) {
      setSecurityHeaders(res);
      if (req.method !== 'GET' || !matches(url.searchParams.get(KEY_QUERY) ?? undefined, expected)) {
        sendJson(res, { error: NO_KEY, code: 'VIEWER_KEY' }, 403);
        return true;
      }
      url.searchParams.delete(KEY_QUERY);
      res.writeHead(303, {
        Location: `${url.pathname}${url.search}`,
        'Set-Cookie': `${KEY_COOKIE}=${key}; HttpOnly; SameSite=Strict; Path=/`,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      });
      res.end();
      return true;
    }
    if (!api) return false;
    const header = req.headers[KEY_HEADER];
    if (matches(Array.isArray(header) ? header[0] : header, expected) || matches(cookieOf(req), expected)) return false;
    setSecurityHeaders(res);
    sendJson(res, { error: NO_KEY, code: 'VIEWER_KEY' }, 401);
    return true;
  };
}
