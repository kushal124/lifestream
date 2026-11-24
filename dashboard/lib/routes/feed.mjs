// @ts-check
/** @import { Route } from './router.mjs' */
/** @import { Door } from '../door.mjs' */
import { NO_TOKEN } from '../door.mjs';
import { statusError } from '../errors.mjs';

const KEEPALIVE_MS = 15_000;

/**
 * @param {Door | null} door
 * @returns {Route[]}
 */
export function feedRoutes(door) {
  return [{
    method: 'GET',
    path: '/api/feed',
    handle: async ({ req }) => {
      if (!door) throw statusError(NO_TOKEN, 503);
      return {
        stream: async res => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
          res.write('retry: 1000\n\n');
          const stop = door.follow(message => {
            if (message.kind === 'open' && message.again) res.write('event: reset\ndata: {}\n\n');
            if (message.kind === 'reset') res.write(`event: reset\ndata: ${JSON.stringify(message.data)}\n\n`);
            else if (message.kind === 'event') {
              const { seq, kind, key, detail } = message.data;
              const said = kind === 'people' ? /** @type {{ position?: unknown, changed?: unknown }} */ (detail ?? {}) : {};
              const at = (/** @type {unknown} */ value) => typeof value === 'string' ? value : undefined;
              res.write(`data: ${JSON.stringify({ seq, kind, key, position: at(said.position), changed: at(said.changed) })}\n\n`);
            }
          });
          const keepalive = setInterval(() => res.write(':\n\n'), KEEPALIVE_MS);
          req.on('close', () => {
            stop();
            clearInterval(keepalive);
          });
        },
      };
    },
  }];
}
