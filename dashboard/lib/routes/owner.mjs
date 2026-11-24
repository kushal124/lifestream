// @ts-check
/** @import { Route } from './router.mjs' */
/** @import { Door } from '../door.mjs' */
/** @import { FacesReader } from '../faces.mjs' */
/** @import { LifeReader } from '../life.mjs' */
import { reply } from './router.mjs';
import { HOP_MS, NO_TOKEN } from '../door.mjs';
import { statusError, withoutPaths } from '../errors.mjs';
import { fromPage, readBody } from '../http.mjs';
import { isLoopback } from '../principals.mjs';

const BODY_BYTES = 2 * 1024 * 1024;
const WAIT = /^\d{1,6}$/u;
const PRODUCTS = new Set(['people', 'places', 'devices']);

/**
 * @param {Promise<void>} settling
 * @param {number | null} ms
 * @returns {Promise<boolean>}
 */
function settledWithin(settling, ms) {
  if (ms === null) return settling.then(() => true);
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const late = new Promise(done => {
    timer = setTimeout(() => done(false), Math.max(0, ms));
  });
  return /** @type {Promise<boolean>} */ (Promise.race([settling.then(() => true), late])).finally(() => clearTimeout(timer));
}

/** @param {string | string[] | undefined} header */
function waitOf(header) {
  if (header === undefined) return null;
  const ms = typeof header === 'string' && WAIT.test(header) ? Number(header) : NaN;
  return ms > HOP_MS ? ms : NaN;
}

/**
 * @param {Door | null} door
 * @param {LifeReader} life
 * @param {FacesReader} faces
 * @returns {Route[]}
 */
export function ownerRoutes(door, life, faces) {
  return [{
    method: 'POST',
    path: '/api/owner/act',
    handle: async ({ req }) => {
      if (!fromPage(req, { json: true })) return reply({ error: 'Invalid request.' }, 403);
      if (!isLoopback(req.socket?.localAddress)) return reply({ error: 'Edits are made only from this Mac.' }, 403);
      const body = await readBody(req, BODY_BYTES, `That action is larger than the ${BODY_BYTES} bytes Lifestream reads.`);
      /** @type {unknown} */
      let action;
      try {
        action = JSON.parse(body);
      } catch {
        return reply({ error: 'Invalid request.' }, 400);
      }
      const { of, kind } = /** @type {{ of?: unknown, kind?: unknown }} */ (action ?? {});
      if (typeof of !== 'string' || !PRODUCTS.has(of)) {
        return reply({ error: 'An edit names what it changes: people, places or devices.' }, 400);
      }
      const product = /** @type {'people' | 'places' | 'devices'} */ (of);
      const wait = waitOf(req.headers['lifestream-wait']);
      if (Number.isNaN(wait)) return reply({ error: 'Invalid request.' }, 400);
      if (!door) throw statusError(NO_TOKEN, 503);
      const answerBy = wait === null ? null : Date.now() + wait - HOP_MS;
      const socket = req.socket;
      const leaving = new AbortController();
      const leave = () => leaving.abort();
      socket.once('close', leave);
      /** @type {{ status: number, text: string }} */
      let answer;
      try {
        answer = await door.act('/v1/owner/act', body, { signal: leaving.signal, ...wait === null ? {} : { wait } });
      } catch (error) {
        if (leaving.signal.aborted) return reply({ error: 'The page left.' }, 499);
        const { refused, code, began, message } = /** @type {{ refused?: unknown, code?: unknown, began?: unknown, message: string }} */ (error);
        if (code === 'OUTCOME_UNKNOWN' || refused === false) {
          life.acted(product);
          return reply({ error: message, code: 'OUTCOME_UNKNOWN', again: true, began: began === true }, 503);
        }
        if (refused === true) return reply({ error: message, code: 'NOT_NOW' }, 503);
        throw error;
      } finally {
        socket.off('close', leave);
      }
      const text = answer.text;
      /** @type {Record<string, unknown>} */
      let said = {};
      try {
        said = JSON.parse(text);
      } catch {}
      if (answer.status !== 200) {
        if (said.code === 'CHANGED') life.acted(product);
        const words = typeof said.message === 'string' && said.message !== '' ? withoutPaths(said.message) : 'Lifestream could not answer.';
        const refused = Array.isArray(said.refused) ? said.refused.map(each => ({ ...each, message: withoutPaths(String(each?.message ?? '')) })) : null;
        return reply({ error: words, ...(typeof said.code === 'string' ? { code: said.code } : {}), ...(refused ? { refused } : {}) }, answer.status);
      }
      const { act, id, position } = /** @type {{ act: string | null, id: string | null, position: string }} */ (said);
      life.acted(product);
      if (product !== 'people') return reply({ act, id, position });
      faces.acted(position);
      if (kind !== 'name' || typeof id !== 'string' || !id.startsWith('person:')) return reply({ act, id, position });
      let payoff = null;
      try {
        if (await settledWithin(faces.settled(), answerBy === null ? null : answerBy - Date.now())) payoff = faces.payoff(id.slice('person:'.length));
      } catch {}
      return reply({ act, id, position, payoff });
    },
  }];
}
