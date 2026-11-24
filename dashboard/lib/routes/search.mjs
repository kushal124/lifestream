// @ts-check
/** @import { Route } from './router.mjs' */
/** @import { Door } from '../door.mjs' */
import { reply } from './router.mjs';
import { NO_TOKEN, unreached } from '../door.mjs';
import { statusError } from '../errors.mjs';

/**
 * @param {URL} url
 * @returns {Record<string, string[]>}
 */
function asked(url) {
  /** @type {Record<string, string[]>} */
  const params = {};
  for (const name of new Set(url.searchParams.keys())) params[name] = url.searchParams.getAll(name);
  return params;
}

/**
 * @param {Door | null} door
 * @returns {Route[]}
 */
export function searchRoutes(door) {
  /**
   * @param {string} path
   * @param {string} route
   * @returns {Route}
   */
  const passed = (path, route) => ({
    method: 'GET',
    path,
    handle: async ({ req, url }) => {
      if (!door) throw statusError(NO_TOKEN, 503);
      try {
        const validator = req.headers['if-none-match'];
        const answer = await door.text(route, typeof validator === 'string' ? validator : undefined, asked(url));
        const tag = answer.etag ? { etag: answer.etag } : undefined;
        if (answer.status === 304) return reply(null, 304, tag);
        let body;
        try {
          body = JSON.parse(answer.text);
        } catch {
          throw unreached(false);
        }
        return reply(body, 200, tag);
      } catch (error) {
        const { code, message, building, retryAfter } = /** @type {Error & { code?: string, building?: string[], retryAfter?: number }} */ (error);
        if (code !== 'INDEX_BUILDING') throw error;
        return reply({ error: message, code, building: building ?? [] }, 503, retryAfter ? { 'Retry-After': String(retryAfter) } : undefined);
      }
    },
  });
  return [
    passed('/api/search', '/v1/search'),
    passed('/api/search/state', '/v1/search/state'),
    passed('/api/count', '/v1/count'),
  ];
}
