// @ts-check
/** @import { IncomingMessage } from 'node:http' */
/** @import { Reply, Route } from './router.mjs' */
/** @import { Door } from '../door.mjs' */
import { reply } from './router.mjs';
import { NO_TOKEN } from '../door.mjs';
import { statusError, withoutPaths } from '../errors.mjs';
import { fromPage, readBody } from '../http.mjs';

const MAX_BODY = 16_384;
const CHAT = /^\d{13}-[0-9a-f]{6}$/u;
const NOTE = /^[0-9a-f]{32}$/u;

/**
 * @param {Door | null} door
 * @returns {Route[]}
 */
export function askRoutes(door) {
  return [...turnRoutes(door), ...fileRoutes(door)];
}

/**
 * @param {Door | null} door
 * @returns {Route[]}
 */
function turnRoutes(door) {
  const relayed = relayer(door);
  /** @param {IncomingMessage} req */
  const pageBody = async req => {
    if (!fromPage(req, { json: true })) throw statusError('Ask is asked from the page.', 403);
    return readBody(req, MAX_BODY, `An ask is at most ${MAX_BODY} bytes.`);
  };
  return [
    {
      method: 'GET',
      path: '/api/ask',
      handle: ({ req, url }) => relayed(req, 'GET', '/v1/ask',
        { params: { model: url.searchParams.get('model') ?? undefined, thinking: url.searchParams.get('thinking') ?? undefined } }),
    },
    { method: 'POST', path: '/api/ask', handle: async ({ req }) => relayed(req, 'POST', '/v1/ask', { body: await pageBody(req) }) },
    {
      method: 'POST',
      path: '/api/ask/stop',
      handle: async ({ req }) => relayed(req, 'POST', '/v1/ask/stop', { body: await pageBody(req) }),
    },
    {
      method: 'GET',
      path: '/api/ask/chats',
      handle: ({ req, url }) => relayed(req, 'GET', '/v1/ask/chats', { params: { after: url.searchParams.get('after') ?? undefined } }),
    },
    { method: 'GET', path: '/api/ask/chat', handle: ({ req, url }) => relayed(req, 'GET', `/v1/ask/chats/${chatOf(url)}`) },
    { method: 'GET', path: '/api/ask/events', handle: ({ req, url }) => relayed(req, 'GET', `/v1/ask/chats/${chatOf(url)}/events`) },
    { method: 'GET', path: '/api/ask/privacy', handle: ({ req, url }) => relayed(req, 'GET', `/v1/privacy/chat/${chatOf(url)}`) },
  ];
}

/**
 * @param {Door | null} door
 * @returns {Route[]}
 */
function fileRoutes(door) {
  const relayed = relayer(door, { doorWords: true });
  /**
   * @param {IncomingMessage} req
   * @returns {import('../door.mjs').Upload}
   */
  const upload = req => {
    if (!fromPage(req, { json: false })) throw statusError('A file is sent from the page.', 403);
    const length = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(length) || length < 1) throw statusError('A file states its length.', 411);
    return { stream: req, type: String(req.headers['content-type'] || 'application/octet-stream'), length };
  };
  /** @param {IncomingMessage} req */
  const pageOnly = req => {
    if (!fromPage(req, { json: false })) throw statusError('A voice note is sent from the page.', 403);
  };
  return [
    { method: 'POST', path: '/api/ask/files', handle: async ({ req }) => relayed(req, 'POST', '/v1/ask/files', { body: upload(req) }) },
    {
      method: 'POST', path: '/api/ask/notes',
      handle: async ({ req, url }) => {
        pageOnly(req);
        return relayed(req, 'POST', `/v1/ask/notes/${noteOf(url)}`);
      },
    },
    {
      method: 'PUT', path: '/api/ask/notes',
      handle: async ({ req, url }) => relayed(req, 'PUT', `/v1/ask/notes/${noteOf(url)}/${secondOf(url)}`, { body: upload(req) }),
    },
    {
      method: 'DELETE', path: '/api/ask/notes',
      handle: async ({ req, url }) => {
        pageOnly(req);
        return relayed(req, 'DELETE', `/v1/ask/notes/${noteOf(url)}`);
      },
    },
  ];
}

/**
 * @param {Door | null} door
 * @param {{ doorWords?: boolean }} [options]
 */
function relayer(door, { doorWords = false } = {}) {
  /**
   * @param {IncomingMessage} req
   * @param {'GET' | 'POST' | 'PUT' | 'DELETE'} method
   * @param {string} path
   * @param {{ params?: Record<string, string | undefined>, body?: string | import('../door.mjs').Upload }} [init]
   * @returns {Promise<Reply>}
   */
  return async (req, method, path, init = {}) => {
    if (!door) throw statusError(NO_TOKEN, 503);
    const socket = req.socket;
    const leaving = new AbortController();
    const leave = () => leaving.abort();
    socket.once('close', leave);
    let streaming = false;
    try {
      if (socket.destroyed) return reply({ error: 'The page left.' }, 499);
      let answer;
      try {
        answer = await door.relay(method, path, { ...init, signal: leaving.signal });
      } catch (error) {
        if (leaving.signal.aborted) return reply({ error: 'The page left.' }, 499);
        throw error;
      }
      const { status, headers, body } = answer;
      if (status === 204 || status < 200 || status >= 300 || !body) {
        const text = body ? await new Response(body).text().catch(() => '') : '';
        if (status === 204) return { stream: async res => void res.writeHead(204).end() };
        if (status === 503 && codeOf(text) !== 'ASK_DOWN') throw door.refused(status, text, headers.get('retry-after'));
        return refusal(status, text, doorWords);
      }
      streaming = true;
      return {
        stream: async res => {
          try {
            res.writeHead(status, { 'Content-Type': headers.get('content-type') ?? 'application/json', 'Cache-Control': 'no-store' });
            for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (/** @type {unknown} */ (body))) res.write(chunk);
          } catch {
          } finally {
            socket.off('close', leave);
            res.end();
          }
        },
      };
    } finally {
      if (!streaming) socket.off('close', leave);
    }
  };
}

/** @param {URL} url */
function chatOf(url) {
  const chat = url.searchParams.get('chat') ?? '';
  if (!CHAT.test(chat)) throw statusError('No such conversation.', 404);
  return chat;
}

/** @param {URL} url */
function noteOf(url) {
  const note = url.searchParams.get('note') ?? '';
  if (!NOTE.test(note)) throw statusError('No such voice note.', 404);
  return note;
}

/** @param {URL} url */
function secondOf(url) {
  const k = Number(url.searchParams.get('k') ?? '');
  if (!Number.isSafeInteger(k) || k < 0) throw statusError('No such second of a voice note.', 404);
  return k;
}

/** @param {string} text */
function codeOf(text) {
  try {
    const { code } = JSON.parse(text) ?? {};
    return typeof code === 'string' ? code : '';
  } catch {
    return '';
  }
}

/**
 * @param {number} status
 * @param {string} text
 * @param {boolean} doorWords
 * @returns {Reply}
 */
function refusal(status, text, doorWords) {
  /** @type {{ error?: unknown, code?: unknown, missing?: unknown, message?: unknown }} */
  let said = {};
  try {
    said = JSON.parse(text) ?? {};
  } catch {}
  const code = typeof said.code === 'string' ? said.code : '';
  if (code === 'ASK_DOWN') return reply({ error: 'Chat isn\'t answering on your Mac', code }, 503);
  if (status === 409 && said.missing && typeof said.missing === 'object') {
    return reply({ error: typeof said.error === 'string' ? said.error : 'Some of the question’s files aren’t in Lifestream.', missing: said.missing }, 409);
  }
  if (status === 401) return reply({ error: 'Lifestream refused the dashboard\'s read token.' }, 503);
  if (status === 403) return reply({ error: 'Lifestream refused the dashboard\'s token for Chat.' }, 503);
  if (doorWords && code && typeof said.message === 'string' && said.message && status !== 500) {
    return reply({ error: withoutPaths(said.message), code }, status);
  }
  if (status === 500) return reply({ error: 'Chat could not answer.' }, 500);
  if (typeof said.error === 'string' && !code) return reply({ error: said.error }, status);
  return reply({ error: 'Lifestream could not answer.' }, 502);
}
