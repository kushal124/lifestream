// @ts-check
/** @import { IncomingMessage } from 'node:http' */
/** @import { Reply, Route } from './router.mjs' */
/** @import { Door, Upload } from '../door.mjs' */
import { reply } from './router.mjs';
import { NO_TOKEN } from '../door.mjs';
import { statusError } from '../errors.mjs';
import { fromPage, readBody } from '../http.mjs';

const MAX_BODY = 65_536;
const SHOT_BYTES = 4 * 1024 ** 2;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * @param {Door | null} door
 * @returns {Route[]}
 */
export function feedbackRoutes(door) {
  /**
   * @param {'POST'} method
   * @param {string} path
   * @param {{ params?: Record<string, string>, body: string | Upload }} init
   * @returns {Promise<Reply>}
   */
  const relayed = async (method, path, init) => {
    if (!door) throw statusError(NO_TOKEN, 503);
    const answer = await door.relay(method, path, init);
    const text = answer.body ? await new Response(answer.body).text() : '';
    if (answer.status !== 200) throw door.refused(answer.status, text, answer.headers.get('retry-after'));
    return reply(JSON.parse(text));
  };
  /** @param {IncomingMessage} req */
  const pageBody = async req => {
    if (!fromPage(req, { json: true })) throw statusError('Feedback is sent from the page.', 403);
    return readBody(req, MAX_BODY, `Feedback is at most ${MAX_BODY} bytes.`);
  };
  return [
    {
      method: 'POST', path: '/api/feedback/draft',
      handle: async ({ req }) => relayed('POST', '/v1/feedback/draft', { body: await pageBody(req) }),
    },
    {
      method: 'POST', path: '/api/feedback/send',
      handle: async ({ req }) => relayed('POST', '/v1/feedback/send', { body: await pageBody(req) }),
    },
    {
      method: 'POST', path: '/api/feedback/screenshot',
      handle: async ({ req, url }) => {
        if (!fromPage(req, { json: false })) throw statusError('A screenshot is sent from the page.', 403);
        const id = url.searchParams.get('id') ?? '';
        if (!UUID_V4.test(id)) throw statusError('A screenshot names its report.', 404);
        const length = Number(req.headers['content-length']);
        if (!Number.isSafeInteger(length) || length < 1) throw statusError('A screenshot states its length.', 411);
        if (length > SHOT_BYTES) throw statusError('A screenshot is at most 4 MB.', 413);
        return relayed('POST', '/v1/feedback/screenshot', { params: { id },
          body: { stream: req, type: String(req.headers['content-type'] || 'application/octet-stream'), length } });
      },
    },
  ];
}
