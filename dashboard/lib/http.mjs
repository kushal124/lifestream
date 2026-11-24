// @ts-check
/** @import { IncomingMessage, ServerResponse } from 'node:http' */
import { statusError } from './errors.mjs';

export const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: lifestream-app:; media-src 'self' blob:; connect-src 'self' https://tiles.openfreemap.org; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

export const UNAVAILABLE = 'Could not load or save. Check that the archive drive is connected, then retry.';

/** @param {ServerResponse} res */
export function setSecurityHeaders(res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
}

/**
 * @param {ServerResponse} res
 * @param {unknown} value
 * @param {number} [status]
 */
export function sendJson(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

/** @type {string | null} */
let homeAddress = null;

/** @param {string | null} address */
export function setHomeAddress(address) {
  homeAddress = address;
}

const LOCALHOST_NAME = /^(?:[a-z0-9-]+\.)*localhost(?::\d{1,5})?$/u;

/**
 * @param {string | undefined} host
 * @param {number} port
 */
function thisMachine(host, port) {
  if (host === undefined) return false;
  if (host === `127.0.0.1:${port}`) return true;
  if (homeAddress !== null && host === `${homeAddress}:${port}`) return true;
  return LOCALHOST_NAME.test(host.toLowerCase());
}

/**
 * @param {string} origin
 * @param {number} port
 */
function originOfThisMachine(origin, port) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return thisMachine(url.host, port);
}

const OWN_FETCH = new Set(['same-origin', 'none']);

/**
 * @param {IncomingMessage} req
 * @param {number} port
 * @returns {string | null}
 */
export function foreignRequest(req, port) {
  if (!thisMachine(req.headers.host, port)) return 'This viewer is available only on this Mac.';
  const origin = req.headers.origin;
  if (origin !== undefined && !originOfThisMachine(origin, port)) return 'Origin refused.';
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && !OWN_FETCH.has(String(site))) return 'Another site asked: refused.';
  return null;
}

/**
 * @param {IncomingMessage} req
 * @param {{ json: boolean }} options
 */
export function fromPage(req, { json }) {
  if (json && req.headers['content-type'] !== 'application/json') return false;
  return req.headers['x-viewer-request'] === '1';
}

/**
 * @param {IncomingMessage} req
 * @param {number} limit
 * @param {string} tooLong
 * @returns {Promise<string>}
 */
export async function readBody(req, limit, tooLong) {
  const tooLarge = () => Object.assign(statusError(tooLong, 413), { code: 'BODY_TOO_LARGE' });
  const stated = Number(req.headers['content-length']);
  if (Number.isFinite(stated) && stated > limit) throw tooLarge();
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    const piece = Buffer.from(chunk);
    bytes += piece.length;
    if (bytes > limit) throw tooLarge();
    chunks.push(piece);
  }
  return Buffer.concat(chunks).toString('utf8');
}
