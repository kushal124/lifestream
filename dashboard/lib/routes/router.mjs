// @ts-check
/** @import { IncomingMessage, ServerResponse } from 'node:http' */
/** @import { StaticFile } from '../static.mjs' */
import { foreignRequest, sendJson, setSecurityHeaders, UNAVAILABLE } from '../http.mjs';

/**
 * @typedef {{ req: IncomingMessage, url: URL }} RouteContext
 * @typedef {{ status: number, body: unknown, headers?: Record<string, string> } | { stream: (res: ServerResponse) => Promise<void> }} Reply
 * @typedef {{ method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, handle: (context: RouteContext) => Promise<Reply> }} Route
 */

/**
 * @param {unknown} body
 * @param {number} [status]
 * @param {Record<string, string>} [headers]
 * @returns {Reply}
 */
export const reply = (body, status = 200, headers) => headers ? { status, body, headers } : { status, body };

/**
 * @param {{ port: () => number, routes: Route[], files: (pathname: string, search?: string) => Promise<StaticFile | null> }} parts
 * @returns {(req: IncomingMessage, res: ServerResponse) => Promise<void>}
 */
export function router({ port, routes, files }) {
  return async (req, res) => {
    setSecurityHeaders(res);
    try {
      const refused = foreignRequest(req, port());
      if (refused) return sendJson(res, { error: refused }, 403);
      const url = new URL(/** @type {string} */ (req.url), `http://127.0.0.1:${port()}`);
      const route = routes.find(each => each.method === req.method && each.path === url.pathname);
      if (route) return await send(res, await route.handle({ req, url }));
      const file = req.method === 'GET' ? await files(url.pathname, url.search) : null;
      if (file) {
        res.setHeader('Content-Type', file.type);
        res.end(file.body);
        return;
      }
      sendJson(res, { error: 'Not found.' }, 404);
    } catch (error) {
      const { status, code, retryAfter, wait } = /** @type {{ status?: number, code?: string, retryAfter?: number,
        wait?: string }} */ (error);
      if (status && retryAfter) res.setHeader('Retry-After', String(retryAfter));
      sendJson(res, { error: status ? /** @type {Error} */ (error).message : UNAVAILABLE,
        ...(status && code ? { code } : {}), ...(status && wait ? { wait } : {}) }, status || 500);
    }
  };
}

/**
 * @param {ServerResponse} res
 * @param {Reply} answer
 */
async function send(res, answer) {
  if ('stream' in answer) return answer.stream(res);
  for (const [name, value] of Object.entries(answer.headers || {})) res.setHeader(name, value);
  sendJson(res, answer.body, answer.status);
}
