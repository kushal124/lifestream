// @ts-check
import { mediaType } from '../../lib/life.mjs';

export const PICTURE_ROUTE = /^\/v1\/pictures\/sha256:([0-9a-f]{64})$/u;
export const RECIPE = 2;
const SIZES = ['tile', 'screen', 'full'];

/**
 * @param {string} hex
 * @param {URL} url
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {() => Promise<Uint8Array | null>} bytes
 */
export async function answerPicture(hex, url, request, response, bytes) {
  /** @param {number} status @param {string} code @param {string} message */
  const refuse = (status, code, message) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code, message }));
  };
  const size = String(url.searchParams.get('size'));
  if (!SIZES.includes(size)) return refuse(422, 'BAD_PARAMETER', 'size is tile, screen or full');
  const held = await bytes();
  if (!held) return refuse(404, 'BLOB_UNKNOWN', `no blob sha256:${hex}`);
  const type = mediaType(held);
  if (!type?.startsWith('image/')) return refuse(404, 'NOT_A_PICTURE', `sha256:${hex} is no picture`);
  const etag = `"${hex}-${size}-${RECIPE}"`;
  const named = url.searchParams.get('recipe') === String(RECIPE);
  /** @type {Record<string, string>} */
  const headers = named ? { etag, 'cache-control': 'private, max-age=86400' } : { 'cache-control': 'no-store' };
  if (named && request.headers['if-none-match'] === etag) {
    response.writeHead(304, headers);
    response.end();
    return;
  }
  response.writeHead(200, { ...headers, 'content-type': type, 'content-length': String(held.byteLength) });
  response.end(held);
}

/**
 * @param {string} door
 * @param {string} hex
 * @param {string} authorization
 */
export async function doorBytes(door, hex, authorization) {
  for (const path of [`/v1/blobs/sha256:${hex}`, `/v1/people/card?hash=sha256:${hex}`]) {
    const answer = await fetch(`${door}${path}`, { headers: { authorization } });
    if (answer.ok) return new Uint8Array(await answer.arrayBuffer());
    await answer.body?.cancel();
  }
  return null;
}
