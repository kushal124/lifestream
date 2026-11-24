// @ts-check
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { guardedOpen, Unopened } from '../guarded.mjs';
import { textHead } from '../shape.mjs';


const DOCUMENT_WAIT_MS = 5_000;
const DOCUMENT_BYTES = 64 * 1024;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_REDIRECTS = 4;
const MAX_REDIRECT = 512;
const MAX_NAME = 80;
const UNNAMED = 'An unnamed app';

/**
 * @typedef {{ name: string, checked: boolean, host: string | null }} Card
 * @typedef {(url: string) => Promise<unknown>} ClientDocument
 */

/**
 * @param {string} url
 * @param {{ get?: import('../guarded.mjs').Get, waitMs?: number }} [options]
 * @returns {Promise<unknown>}
 */
export async function readClientDocument(url, { get, waitMs = DOCUMENT_WAIT_MS } = {}) {
  const answer = await guardedOpen(url, {
    hops: 0, https: true, waitMs, maxBytes: DOCUMENT_BYTES, ...(get === undefined ? {} : { get }),
    headers: { accept: 'application/json', 'user-agent': 'Lifestream/1 (sign-in)' },
  });
  if (answer.status !== 200) throw new Unopened(`${answer.url.host} answered ${answer.status}.`);
  try {
    return JSON.parse(answer.body.toString('utf8'));
  } catch {
    throw new Unopened('It is not JSON.');
  }
}

/**
 * @param {{ machine: string, clientDocument?: ClientDocument }} options
 */
export function openClients({ machine, clientDocument = readClientDocument }) {
  const keyFile = join(machine, 'mcp', 'clients.key');
  /** @type {Buffer | null} */
  let key = null;
  const keyOf = () => {
    if (key !== null) return key;
    try {
      key = readFileSync(keyFile);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
      mkdirSync(dirname(keyFile), { recursive: true });
      try {
        writeFileSync(keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 });
      } catch (made) {
        if (/** @type {NodeJS.ErrnoException} */ (made).code !== 'EEXIST') throw made;
      }
      key = readFileSync(keyFile);
    }
    if (key.length !== 32) {
      key = null;
      throw new Error(`${keyFile} holds no key of 32 bytes`);
    }
    return key;
  };
  /** @param {string} payload */
  const sealOf = payload => createHmac('sha256', keyOf()).update(payload).digest('base64url');

  /**
   * @param {string} clientId
   * @returns {{ name: string, redirect_uris: string[] } | null}
   */
  const unsealed = clientId => {
    const [payload, seal, ...rest] = clientId.split('.');
    if (payload === undefined || seal === undefined || rest.length > 0) return null;
    const expected = Buffer.from(sealOf(payload));
    const given = Buffer.from(seal);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return typeof body.name === 'string' && Array.isArray(body.redirect_uris) ? body : null;
    } catch {
      return null;
    }
  };

  return {
    /**
     * @param {unknown} body
     * @returns {{ status: number, body: Record<string, unknown> }}
     */
    register(body) {
      if (body === null || typeof body !== 'object' || Array.isArray(body)) return refused('invalid_client_metadata', 'Send the registration as a JSON object.');
      const { client_name: named, redirect_uris: stated } = /** @type {Record<string, unknown>} */ (body);
      if (!Array.isArray(stated) || stated.length === 0 || stated.length > MAX_REDIRECTS || !stated.every(each => typeof each === 'string')) {
        return refused('invalid_redirect_uri', `redirect_uris is 1 to ${MAX_REDIRECTS} addresses.`);
      }
      /** @type {string[]} */
      const redirects = [];
      for (const each of stated) {
        const url = redirectOf(each);
        if (url === null) return refused('invalid_redirect_uri', `${each.slice(0, 200)} is no redirect this server sends to: https, or http on localhost or 127.0.0.1, with no fragment.`);
        if (JSON.stringify(url.href).length > MAX_REDIRECT) return refused('invalid_redirect_uri', `A redirect is at most ${MAX_REDIRECT - 2} characters.`);
        redirects.push(url.href);
      }
      if (named !== undefined && typeof named !== 'string') return refused('invalid_client_metadata', 'client_name is a name.');
      const name = nameOf(named) ?? UNNAMED;
      const payload = Buffer.from(JSON.stringify({ name, redirect_uris: redirects })).toString('base64url');
      return {
        status: 201,
        body: {
          client_id: `${payload}.${sealOf(payload)}`, client_name: name, redirect_uris: redirects, token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
        },
      };
    },

    /**
     * @param {string} clientId
     * @param {string} redirect
     * @returns {Promise<{ card: Card } | { error: string }>}
     */
    async identify(clientId, redirect) {
      const asked = redirectOf(redirect);
      if (asked === null) return { error: 'This sign-in names no address to send access to that Lifestream sends to.' };
      const url = documentUrl(clientId);
      if (url === null) {
        const registered = unsealed(clientId);
        if (registered === null) return { error: 'This sign-in names an app Lifestream doesn\'t know. Start connecting again.' };
        if (!registered.redirect_uris.some(stated => same(stated, asked))) return { error: NOT_STATED };
        return { card: { name: registered.name, checked: false, host: hostOf(asked) } };
      }
      /** @type {unknown} */
      let document;
      try {
        document = await clientDocument(url.href);
      } catch (error) {
        return { error: `This app's description at ${url.host} couldn't be read: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (document === null || typeof document !== 'object' || Array.isArray(document)) return { error: `This app's description at ${url.host} is not one Lifestream can read.` };
      const said = /** @type {Record<string, unknown>} */ (document);
      if (said.client_id !== clientId) return { error: `This app's description at ${url.host} names another app.` };
      const name = nameOf(said.client_name);
      if (name === null) return { error: `This app's description at ${url.host} gives no name.` };
      const stated = Array.isArray(said.redirect_uris) ? said.redirect_uris.filter(each => typeof each === 'string') : [];
      if (!stated.some(each => same(each, asked))) return { error: NOT_STATED };
      const methods = Array.isArray(said.token_endpoint_auth_methods_supported) ? said.token_endpoint_auth_methods_supported : [];
      if (said.token_endpoint_auth_method !== 'none' && !methods.includes('none')) return { error: `${name} signs in with a secret, which Lifestream doesn't take.` };
      return { card: { name, checked: true, host: hostOf(asked) } };
    },
  };
}

const NOT_STATED = 'This sign-in would send access to an address the app didn\'t state. Start connecting again.';

/** @param {string} clientId */
function documentUrl(clientId) {
  if (!clientId.startsWith('https://') || clientId.includes('#')) return null;
  const url = URL.parse(clientId);
  return url === null || url.pathname === '/' || url.username !== '' || url.password !== '' ? null : url;
}

/** @param {string} text */
function redirectOf(text) {
  if (text.includes('#')) return null;
  const url = URL.parse(text);
  if (url === null || url.username !== '' || url.password !== '') return null;
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) ? url : null;
}

/**
 * @param {string} stated
 * @param {URL} asked
 */
function same(stated, asked) {
  const url = redirectOf(stated);
  if (url === null) return false;
  if (url.href === asked.href) return true;
  if (!LOOPBACK.has(url.hostname) || !LOOPBACK.has(asked.hostname)) return false;
  return url.protocol === asked.protocol && url.hostname === asked.hostname && url.pathname === asked.pathname && url.search === asked.search;
}

/** @param {URL} redirect */
const hostOf = redirect => LOOPBACK.has(redirect.hostname) ? null : redirect.host;

/** @param {unknown} named */
function nameOf(named) {
  if (typeof named !== 'string') return null;
  const name = named.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return name === '' ? null : name.length > MAX_NAME ? `${textHead(name, MAX_NAME - 1)}…` : name;
}

/** @param {string} error @param {string} description */
const refused = (error, description) => ({ status: 400, body: { error, error_description: description } });
