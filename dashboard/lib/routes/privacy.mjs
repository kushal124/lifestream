// @ts-check
/** @import { Route } from './router.mjs' */
/** @import { Door } from '../door.mjs' */
import { NO_TOKEN } from '../door.mjs';
import { statusError } from '../errors.mjs';
import { reply } from './router.mjs';

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const SEQ = /^[1-9]\d{0,15}$/u;

/**
 * @param {Door | null} door
 * @returns {Route[]}
 */
export function privacyRoutes(door) {
  const reach = () => {
    if (!door) throw statusError(NO_TOKEN, 503);
    return door;
  };
  return [{
    method: 'GET', path: '/api/privacy',
    handle: async () => reply(await reach().json('/v1/privacy')),
  }, {
    method: 'GET', path: '/api/outbound',
    handle: async ({ url }) => {
      const asked = url.searchParams;
      /** @type {Record<string, string>} */
      const params = {};
      for (const name of ['from', 'to']) {
        const value = asked.get(name);
        if (value !== null && !DAY.test(value)) return reply({ error: `${name} is a day, YYYY-MM-DD.` }, 400);
        if (value !== null) params[name] = value;
      }
      const receiver = asked.get('receiver');
      if (receiver) params.receiver = receiver;
      const item = ['family', 'item'].map(name => asked.get(name));
      if (item.some(value => value !== null)) {
        if (item.some(value => !value)) return reply({ error: 'family and item name one item together.' }, 400);
        ['family', 'item'].forEach((name, at) => { params[name] = /** @type {string} */ (item[at]); });
      }
      const before = asked.get('before');
      if (before !== null && !SEQ.test(before)) return reply({ error: 'before is an outbound row’s number.' }, 400);
      if (before !== null) params.before = before;
      return reply(await reach().json('/v1/outbound', params));
    },
  }, {
    method: 'GET', path: '/api/outbound/row',
    handle: async ({ url }) => {
      const seq = url.searchParams.get('seq') ?? '';
      if (!SEQ.test(seq)) return reply({ error: 'seq is an outbound row’s number.' }, 400);
      return reply(await reach().json(`/v1/outbound/${seq}`));
    },
  }];
}
