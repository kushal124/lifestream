// @ts-check
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { statusError, withoutPaths } from './errors.mjs';


export const DEFAULT_DOOR = 'http://127.0.0.1:4680';
export const TOKEN_FILE = 'door-token';

const SILENCE_MS = 60_000;
export const HOP_MS = 1_000;
const MAX_BYTES = 64 << 20;
const RETRY_MS = 1_000;

/** @typedef {{ kind: 'event', id: string, data: { seq: number, at_ms: number, kind: string, key: string, detail: unknown } } | { kind: 'reset', id: string, data: { seq: number, at_ms: number } } | { kind: 'open', again: boolean }} FeedMessage */

/** @typedef {{ stream: AsyncIterable<Uint8Array>, type: string, length: number }} Upload */

/**
 * @typedef {object} Door
 * @property {(path: string, params?: Record<string, string | string[] | undefined>, signal?: AbortSignal) => Promise<any>} json
 * @property {(path: string, params: Record<string, string | undefined>, member: string) => Promise<{ position: string, items: any[] }>} all
 * @property {(path: string, params: Record<string, string | undefined>, member: string, visit: (items: any[]) => void) => Promise<string>} each
 * @property {(path: string, etag?: string, params?: Record<string, string | string[] | undefined>, signal?: AbortSignal, device?: string) => Promise<{ status: number, etag: string | null, position: string | null, text: string }>} text
 * @property {(path: string, headers?: Record<string, string>, signal?: AbortSignal) => Promise<{ status: number, headers: Headers, body: ReadableStream<Uint8Array> | null }>} stream
 * @property {(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, init?: { params?: Record<string, string | undefined>, body?: string | Upload, signal?: AbortSignal }) => Promise<{ status: number, headers: Headers, body: ReadableStream<Uint8Array> | null }>} relay
 * @property {(status: number, text: string, retryAfter?: string | null) => Error} refused
 * @property {(path: string, body: string, given?: { signal?: AbortSignal, wait?: number }) => Promise<{ status: number, text: string }>} act
 * @property {(token: string) => Promise<boolean>} allows
 * @property {(listener: (message: FeedMessage) => void) => () => void} follow
 * @property {() => string | null} position
 * @property {() => Promise<void>} opened
 * @property {() => void} close
 */

export const NO_TOKEN = 'The dashboard has no read token for Lifestream. README says where it goes.';
const GONE = 'Can\'t reach Lifestream.';

/** @param {boolean} [refused] */
export const unreached = refused => Object.assign(statusError(GONE, 503), { code: 'GONE' }, refused === undefined ? {} : { refused });
const POSITION = 'lifestream-position';

/** @param {unknown} position */
export function seqOf(position) {
  const seq = Number.parseInt(String(position ?? '').split(':')[0] ?? '', 10);
  return Number.isSafeInteger(seq) ? seq : -1;
}

/**
 * @param {string} stateDir
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ url: string, token: () => string | null }}
 */
export function doorSettings(stateDir, env = process.env) {
  const url = (env.LIFESTREAM_DOOR || DEFAULT_DOOR).replace(/\/+$/u, '');
  const given = env.LIFESTREAM_DOOR_TOKEN?.trim() || '';
  const token = () => {
    if (given) return given;
    try {
      return readFileSync(join(stateDir, TOKEN_FILE), 'utf8').trim() || null;
    } catch {
      return null;
    }
  };
  return { url, token };
}

/**
 * @param {string | null} retryAfter
 * @returns {number}
 */
export function retryWait(retryAfter) {
  const seconds = retryAfter === null || !/^\d+$/u.test(retryAfter.trim()) ? NaN : Number(retryAfter.trim());
  return Number.isSafeInteger(seconds) ? seconds * 1_000 : RETRY_MS;
}

/**
 * @param {number} ms
 * @param {AbortSignal} signal
 * @returns {Promise<void>}
 */
function pause(ms, signal) {
  return new Promise(resolve => {
    if (signal.aborted) return resolve(undefined);
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve(undefined);
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * @param {{ url: string, token: () => string | null, silenceMs?: number, wait?: (ms: number, signal: AbortSignal) => Promise<void> }} settings
 * @returns {Door}
 */
export function openDoor({ url, token, silenceMs = SILENCE_MS, wait = pause }) {
  /** @type {Set<(message: FeedMessage) => void>} */
  const listeners = new Set();
  /** @type {string | null} */
  let last = null;
  let closed = false;
  /** @type {AbortController | null} */
  let feed = null;
  let alive = new AbortController();
  const ending = new AbortController();
  /** @type {Map<string, { read: Promise<{ status: number, etag: string | null, position: string | null, body: Buffer }>, staying: number, end: AbortController }>} */
  const waiting = new Map();
  /** @type {() => void} */
  let markOpened = () => undefined;
  const opened = new Promise(resolve => {
    markOpened = () => resolve(undefined);
  });

  /**
   * @param {string} path
   * @param {Record<string, string | string[] | undefined>} [params]
   */
  const address = (path, params = {}) => {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) {
      for (const each of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(name, each);
    }
    const text = query.toString();
    return `${url}${path}${text ? `?${text}` : ''}`;
  };

  const own = () => {
    const now = token();
    if (now === null) throw statusError(NO_TOKEN, 503);
    return now;
  };

  /**
   * @param {string} target
   * @param {RequestInit} init
   * @param {AbortSignal} [signal]
   * @param {boolean} [live]
   */
  const ask = async (target, init, signal, live = true) => {
    start();
    const ends = [...live ? [alive.signal] : [], ...signal ? [signal] : []];
    try {
      return await fetch(target, { ...init, ...ends.length > 0 ? { signal: AbortSignal.any(ends) } : {} });
    } catch (error) {
      const cause = /** @type {{ cause?: { code?: string } }} */ (error).cause;
      throw unreached(cause?.code === 'ECONNREFUSED');
    }
  };

  /**
   * @param {string} target
   * @param {{ etag?: string | null, as?: string, signal?: AbortSignal, device?: string }} [options]
   */
  const get = (target, { etag = null, as = own(), signal, device = '' } = {}) => {
    const key = JSON.stringify([target, as, etag, device]);
    let shared = waiting.get(key);
    if (!shared) {
      const end = new AbortController();
      const entry = { end, staying: 0, read: whole(target, etag, as, end.signal, device).finally(() => {
        if (waiting.get(key) === entry) waiting.delete(key);
      }) };
      waiting.set(key, entry);
      shared = entry;
    }
    const entry = shared;
    entry.staying += 1;
    if (!signal) return entry.read;
    return new Promise((resolve, reject) => {
      const leave = () => {
        entry.staying -= 1;
        if (entry.staying === 0) {
          entry.end.abort();
          if (waiting.get(key) === entry) waiting.delete(key);
        }
        reject(statusError('The page left.', 499));
      };
      if (signal.aborted) return leave();
      signal.addEventListener('abort', leave, { once: true });
      entry.read.then(resolve, reject).finally(() => signal.removeEventListener('abort', leave));
    });
  };

  /**
   * @param {string} target
   * @param {string | null} etag
   * @param {string} as
   * @param {AbortSignal} [signal]
   * @param {string} [device]
   */
  const whole = async (target, etag, as, signal, device = '') => {
    const response = await ask(target, { headers: { authorization: `Bearer ${as}`, ...(etag ? { 'if-none-match': etag } : {}),
      ...(device ? { 'lifestream-device': device } : {}) } }, signal);
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (response.body ?? [])) {
        size += chunk.length;
        if (size > MAX_BYTES) break;
        chunks.push(chunk);
      }
    } catch {
      throw unreached();
    }
    if (size > MAX_BYTES) throw statusError('Lifestream answered more than the dashboard reads at once.', 502);
    return { status: response.status, etag: response.headers.get('etag'), position: response.headers.get(POSITION),
      retryAfter: response.headers.get('retry-after'), body: Buffer.concat(chunks) };
  };

  /**
   * @param {number} status
   * @param {string} text
   * @param {string | null} [retryAfter]
   */
  const refused = (status, text, retryAfter = null) => {
    const after = status === 503 && Number(retryAfter) > 0 ? { retryAfter: Number(retryAfter) } : {};
    let code = '';
    let message = '';
    /** @type {string[]} */
    let building = [];
    /** @type {string | null} */
    let wait = null;
    let began = false;
    let again = false;
    try {
      const body = JSON.parse(text);
      code = String(body.code ?? '');
      began = body.began === true;
      again = body.again === true;
      message = String(body.message ?? '');
      if (Array.isArray(body.building)) building = body.building.map(String);
      if (code === 'NOT_NOW' && typeof body.wait === 'string') wait = body.wait;
    } catch {}
    if (status === 404 && code === 'SPOT_UNKNOWN') {
      return Object.assign(statusError('That spot is not among your spots now.', 404), { code });
    }
    if (status === 404) return Object.assign(statusError(`Lifestream holds no such thing (${code || 'not found'}).`, 404), code ? { code } : {});
    if (status === 409 && code === 'CURSOR_EXPIRED') return Object.assign(statusError('This count can\'t be opened any more.', 409), { code });
    if (status === 422) return Object.assign(statusError(message ? withoutPaths(message) : 'Lifestream refused a parameter.', 400), code ? { code } : {});
    if (status === 401) return statusError('Lifestream refused the dashboard\'s read token.', 503);
    if (status === 403) return statusError('Lifestream refused the dashboard\'s token for this. README says how to mint one that reads and delivers.', 503);
    if (status === 503 && code === 'INDEX_BUILDING') {
      return Object.assign(statusError('Search is getting ready.', 503), { code, building }, after);
    }
    if (code === 'OUTCOME_UNKNOWN' && status === 503) {
      return Object.assign(statusError(withoutPaths(message) || 'Lifestream didn\'t answer.', 503), { code, began, again });
    }
    if ((code === 'NOT_NOW' || code === 'LOCKED') && status === 503 && message !== '') {
      return Object.assign(statusError(withoutPaths(message), 503), { code }, after, wait === null ? {} : { wait });
    }
    if (code === 'HOME_FAILED' && status === 500 && message !== '') return Object.assign(statusError(withoutPaths(message), 502), { code });
    if (status === 503) return Object.assign(statusError('Lifestream cannot answer now. Try again in a moment.', 503), code === '' ? {} : { code }, after);
    return statusError('Lifestream could not answer.', 502);
  };

  /** @type {Door['json']} */
  const json = async (path, params, signal) => {
    const answer = await get(address(path, params), { signal });
    if (answer.status !== 200) throw refused(answer.status, answer.body.toString('utf8'), answer.retryAfter);
    try {
      return JSON.parse(answer.body.toString('utf8'));
    } catch {
      throw unreached();
    }
  };

  /** @type {Door['each']} */
  const each = async (path, params, member, visit) => {
    /** @type {string | null} */
    let position = null;
    for (let after; ;) {
      const page = await json(path, { ...params, limit: '1024', ...(after === undefined ? {} : { after }) });
      position ??= /** @type {string} */ (page.position);
      visit(page[member]);
      if (page.next === undefined) return position;
      after = /** @type {string} */ (page.next);
    }
  };

  /** @param {Uint8Array} chunk @param {{ text: string, id: string | null, event: string, data: string[] }} state */
  const parse = (chunk, state) => {
    state.text += Buffer.from(chunk).toString('utf8');
    for (let end = state.text.indexOf('\n'); end >= 0; end = state.text.indexOf('\n')) {
      const line = state.text.slice(0, end).replace(/\r$/u, '');
      state.text = state.text.slice(end + 1);
      if (line === '') {
        if (state.data.length > 0) dispatch(state.event, state.id, state.data.join('\n'));
        state.event = '';
        state.data = [];
        continue;
      }
      const colon = line.indexOf(':');
      if (colon === 0) continue;
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /u, '');
      if (field === 'id') state.id = value;
      else if (field === 'event') state.event = value;
      else if (field === 'data') state.data.push(value);
    }
  };

  /** @param {string} event @param {string | null} id @param {string} data */
  const dispatch = (event, id, data) => {
    if (id === null) return;
    last = id;
    /** @type {FeedMessage} */
    const message = event === 'reset' ? { kind: 'reset', id, data: JSON.parse(data) } : { kind: 'event', id, data: JSON.parse(data) };
    for (const listener of listeners) listener(message);
  };

  const gone = () => {
    silence = null;
    feed?.abort();
    alive.abort();
    alive = new AbortController();
  };
  /** @type {NodeJS.Timeout | null} */
  let silence = null;
  const heard = () => {
    (silence ??= setTimeout(gone, silenceMs)).refresh();
  };
  const attempting = () => {
    silence ??= setTimeout(gone, silenceMs);
  };

  const run = async () => {
    let known = false;
    while (!closed) {
      const controller = new AbortController();
      feed = controller;
      attempting();
      let after = RETRY_MS;
      try {
        const response = await fetch(`${url}/v1/feed`, {
          headers: { authorization: `Bearer ${own()}`, ...(last === null ? {} : { 'last-event-id': last }) },
          signal: controller.signal,
        });
        heard();
        if (response.status === 200 && response.body) {
          markOpened();
          for (const listener of listeners) listener({ kind: 'open', again: known });
          known = true;
          const state = { text: '', id: last, event: '', data: /** @type {string[]} */ ([]) };
          for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (response.body)) {
            heard();
            parse(chunk, state);
          }
        } else {
          after = retryWait(response.headers.get('retry-after'));
          if (silence) clearTimeout(silence);
          silence = null;
          await response.body?.cancel();
        }
      } catch {}
      known = true;
      if (!closed) await wait(after, ending.signal);
    }
  };
  let running = false;
  const start = () => {
    if (running || closed) return;
    running = true;
    void run();
  };

  return {
    json,
    refused,
    async all(path, params, member) {
      /** @type {any[]} */
      const items = [];
      const position = await each(path, params, member, page => items.push(...page));
      return { position, items };
    },
    each,
    async text(path, etag, params, signal, device) {
      const answer = await get(address(path, params), { etag: etag || null, signal, device });
      const text = answer.body.toString('utf8');
      if (answer.status !== 200 && answer.status !== 304) throw refused(answer.status, text, answer.retryAfter);
      return { status: answer.status, etag: answer.etag, position: answer.position, text };
    },
    async stream(path, headers = {}, signal) {
      const response = await ask(address(path), { headers: { authorization: `Bearer ${own()}`, ...headers } }, signal);
      if (response.status === 304) return { status: 304, headers: response.headers, body: null };
      if ((response.status !== 200 && response.status !== 206) || !response.body) {
        const text = await response.text();
        if (response.status === 416) throw statusError('That range is outside the file.', 416);
        throw refused(response.status, text, response.headers.get('retry-after'));
      }
      return { status: response.status, headers: response.headers, body: response.body };
    },
    async relay(method, path, { params, body, signal } = {}) {
      /** @type {Record<string, string>} */
      const headers = { authorization: `Bearer ${own()}` };
      /** @type {RequestInit} */
      const sent = { method };
      if (typeof body === 'string') {
        headers['content-type'] = 'application/json';
        sent.body = body;
      } else if (body) {
        headers['content-type'] = body.type;
        headers['content-length'] = String(body.length);
        Object.assign(sent, { body: /** @type {RequestInit['body']} */ (/** @type {unknown} */ (body.stream)), duplex: 'half' });
      }
      const response = await ask(address(path, params), { ...sent, headers }, signal);
      return { status: response.status, headers: response.headers, body: response.body };
    },
    async act(path, body, { signal, wait } = {}) {
      const left = wait === undefined ? null : wait - HOP_MS;
      const ends = [...signal ? [signal] : [], ...left === null ? [] : [AbortSignal.timeout(left)]];
      const response = await ask(address(path), {
        method: 'POST', body,
        headers: { authorization: `Bearer ${own()}`, 'content-type': 'application/json', ...left === null ? {} : { 'lifestream-wait': String(left) } },
      }, ends.length > 0 ? AbortSignal.any(ends) : undefined, false);
      let text;
      try {
        text = await response.text();
      } catch {
        throw unreached(false);
      }
      if (response.status >= 500) throw refused(response.status, text, response.headers.get('retry-after'));
      return { status: response.status, text };
    },
    async allows(visitor) {
      const answer = await get(address('/v1/sources', { limit: '1' }), { as: visitor });
      if (answer.status === 200) return true;
      if (answer.status === 401 || answer.status === 403) return false;
      throw refused(answer.status, answer.body.toString('utf8'));
    },
    follow(listener) {
      listeners.add(listener);
      start();
      return () => listeners.delete(listener);
    },
    position: () => last,
    opened: () => opened,
    close() {
      closed = true;
      ending.abort();
      if (silence) clearTimeout(silence);
      gone();
      listeners.clear();
    },
  };
}
