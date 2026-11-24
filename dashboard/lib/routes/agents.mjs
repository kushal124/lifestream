// @ts-check
/** @import { Route } from './router.mjs' */
/** @import { Door } from '../door.mjs' */
import { NO_TOKEN } from '../door.mjs';
import { statusError, withoutPaths } from '../errors.mjs';
import { fromPage, readBody } from '../http.mjs';
import { isLoopback } from '../principals.mjs';
import { reply } from './router.mjs';

const READER = /^(ask|p-[0-9a-f]{8})$/u;
const ASK = /^rq-[0-9a-f]{16}$/u;
const SIGN_IN = /^[A-Za-z0-9_-]{22}$/u;
const CURSOR = /^[A-Za-z0-9._:~-]{1,512}$/u;
const KIND = /^[a-z][a-z-]{0,39}$/u;
const READ = /^call-[0-9a-f]{16}$/u;

export const BODY_BYTES = 2 * 1024 * 1024;

/**
 * @param {Door | null} door
 * @returns {Route[]}
 */
export function agentRoutes(door) {
  const reach = () => {
    if (!door) throw statusError(NO_TOKEN, 503);
    return door;
  };

  /**
   * @param {number} status
   * @param {string} text
   */
  const passed = (status, text) => {
    /** @type {any} */
    let said = null;
    try {
      said = JSON.parse(text);
    } catch {}
    if (status >= 200 && status < 300) return reply(said);
    const code = typeof said?.code === 'string' ? said.code : '';
    const words = typeof said?.message === 'string' && said.message ? withoutPaths(said.message) : 'Lifestream did not take that.';
    return reply({ error: words, ...code ? { code } : {} }, status);
  };

  /**
   * @param {string} path
   * @param {Record<string, string>} [params]
   */
  const read = async (path, params) => {
    const answer = await reach().relay('GET', path, { params });
    return passed(answer.status, answer.body ? await new Response(answer.body).text() : '');
  };

  /**
   * @param {string} path
   * @param {unknown} body
   */
  const send = async (path, body) => {
    try {
      const answer = await reach().act(path, JSON.stringify(body));
      return passed(answer.status, answer.text);
    } catch (error) {
      const { refused, status, code } = /** @type {{ refused?: unknown, status?: number, code?: string }} */ (error);
      if (typeof refused === 'boolean') return reply({ error: 'Can’t reach Lifestream.', code: refused ? 'NOT_NOW' : 'OUTCOME_UNKNOWN' }, 503);
      if (status && code) return reply({ error: 'Lifestream did not take that.', code }, status);
      throw error;
    }
  };

  /** @param {import('node:http').IncomingMessage} req */
  const bodyOf = async req => {
    if (!fromPage(req, { json: true })) return { refusal: reply({ error: 'Invalid request.' }, 403) };
    if (!isLoopback(req.socket?.localAddress)) return { refusal: reply({ error: 'An agent’s access is changed only from this Mac.' }, 403) };
    try {
      return { body: JSON.parse(await readBody(req, BODY_BYTES, 'That is larger than Lifestream reads.')) };
    } catch (error) {
      if (/** @type {{ status?: number }} */ (error).status === 413) {
        return { refusal: reply({ error: 'That is larger than Lifestream reads.', code: 'BODY_TOO_LARGE' }, 413) };
      }
      return { refusal: reply({ error: 'Invalid request.' }, 400) };
    }
  };

  /** @param {URL} url */
  const readerOf = url => {
    const id = url.searchParams.get('id') ?? '';
    return READER.test(id) ? id : null;
  };
  const outOfShape = () => reply({ error: 'Invalid request.' }, 400);

  /** @param {'access' | 'propose'} part */
  const ofReader = part => /** @type {Route} */ ({
    method: 'POST', path: `/api/agents/${part}`,
    handle: async ({ req }) => {
      const { body, refusal } = await bodyOf(req);
      if (refusal) return refusal;
      if (typeof body?.id !== 'string' || !READER.test(body.id)) return outOfShape();
      const { id, ...rest } = body;
      return send(`/v1/agents/${id}/${part}`, rest);
    },
  });

  /** @param {'edit' | 'answer'} part */
  const whole = part => /** @type {Route} */ ({
    method: 'POST', path: `/api/agents/${part}`,
    handle: async ({ req }) => {
      const { body, refusal } = await bodyOf(req);
      if (refusal) return refusal;
      if (!body || typeof body !== 'object' || Array.isArray(body)) return outOfShape();
      return send(`/v1/agents/${part}`, body);
    },
  });

  return [
    { method: 'GET', path: '/api/agents', handle: () => read('/v1/agents') },
    { method: 'GET', path: '/api/agents/waiting', handle: () => read('/v1/agents/waiting') },
    {
      method: 'GET', path: '/api/agents/one',
      handle: async ({ url }) => {
        const id = readerOf(url);
        return id ? read(`/v1/agents/${id}`) : outOfShape();
      },
    },
    {
      method: 'GET', path: '/api/agents/history',
      handle: async ({ url }) => {
        const id = readerOf(url);
        const before = url.searchParams.get('before');
        const kind = url.searchParams.get('kind');
        if (!id || (before !== null && !CURSOR.test(before)) || (kind !== null && !KIND.test(kind))) return outOfShape();
        return read(`/v1/agents/${id}/history`, { ...before === null ? {} : { before }, ...kind === null ? {} : { kind } });
      },
    },
    {
      method: 'GET', path: '/api/agents/read',
      handle: async ({ url }) => {
        const id = readerOf(url);
        const call = url.searchParams.get('read') ?? '';
        return id && READ.test(call) ? read(`/v1/agents/${id}/reads/${call}`) : outOfShape();
      },
    },
    {
      method: 'GET', path: '/api/agents/things',
      handle: async ({ url }) => {
        const id = readerOf(url);
        const call = url.searchParams.get('read') ?? '';
        const before = url.searchParams.get('before');
        if (!id || !READ.test(call) || (before !== null && !CURSOR.test(before))) return outOfShape();
        return read(`/v1/agents/${id}/reads/${call}/things`, before === null ? {} : { before });
      },
    },
    {
      method: 'GET', path: '/api/agents/ask',
      handle: async ({ url }) => {
        const id = url.searchParams.get('id') ?? '';
        return ASK.test(id) ? read(`/v1/agents/asks/${id}`) : outOfShape();
      },
    },
    {
      method: 'GET', path: '/api/agents/signin',
      handle: async ({ url }) => {
        const id = url.searchParams.get('id') ?? '';
        return SIGN_IN.test(id) ? read(`/v1/agents/signins/${id}`) : outOfShape();
      },
    },
    whole('edit'),
    ofReader('access'),
    ofReader('propose'),
    whole('answer'),
  ];
}
