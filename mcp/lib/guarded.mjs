// @ts-check
import { lookup as resolve } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';


const PRIVATE = new BlockList();
for (const [address, prefix] of /** @type {[string, number][]} */ ([['0.0.0.0', 8], ['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12],
  ['192.168.0.0', 16], ['100.64.0.0', 10], ['169.254.0.0', 16], ['224.0.0.0', 3]])) PRIVATE.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of /** @type {[string, number][]} */ ([['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]])) PRIVATE.addSubnet(address, prefix, 'ipv6');

export class Unopened extends Error {}

/**
 * @typedef {{ status: number, headers: import('node:http').IncomingHttpHeaders, body: Buffer }} Answer
 * @typedef {(url: URL, options: { signal: AbortSignal, headers: Record<string, string>, maxBytes: number }) => Promise<Answer>} Get
 */

/**
 * @param {string} first
 * @param {{ hops: number, waitMs: number, maxBytes: number, https?: boolean, headers?: Record<string, string>, hop?: (url: URL) => void, get?: Get }} options
 * @returns {Promise<Answer & { url: URL }>}
 */
export async function guardedOpen(first, { hops, waitMs, maxBytes, https = false, headers = {}, hop, get = guardedGet }) {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), waitMs);
  try {
    let url = new URL(first);
    for (let at = 0; ; at++) {
      if (https && url.protocol !== 'https:') throw new Unopened(`Only an https link is opened, not ${url.protocol}`);
      const answer = await get(url, { signal: stop.signal, headers, maxBytes });
      if (answer.body.length > maxBytes) throw new Unopened(`The link's answer is larger than ${size(maxBytes)}.`);
      const location = answer.headers.location;
      if (answer.status >= 300 && answer.status < 400 && typeof location === 'string') {
        if (at === hops) throw new Unopened(hops === 0 ? 'The link redirected, and is opened only where it is.' : `The link redirected more than ${hops} times.`);
        url = new URL(location, url);
        hop?.(url);
        continue;
      }
      return { ...answer, url };
    }
  } catch (error) {
    if (error instanceof Unopened) throw error;
    throw new Unopened(stop.signal.aborted ? `The link did not answer within ${waitMs / 1000} s.` : `The link could not be opened: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** @type {Get} */
export function guardedGet(url, { signal, headers, maxBytes }) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return Promise.reject(new Unopened(`Only http and https links are opened, not ${url.protocol}`));
  const host = url.hostname.replace(/^\[|\]$/gu, '');
  if (isIP(host) !== 0 && refused(host)) return Promise.reject(new Unopened(`fetch never opens ${host}: it is this Mac's own or its network's address.`));
  return new Promise((done, fail) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      signal,
      headers,
      lookup: (/** @type {string} */ name, /** @type {any} */ options, /** @type {(...args: any[]) => void} */ callback) => {
        resolve(name, { all: true }, (error, addresses) => {
          if (error !== null) return callback(error);
          const blocked = addresses.find(each => refused(each.address));
          if (blocked !== undefined) return callback(new Unopened(`fetch never opens ${name}: it resolves to ${blocked.address}, this Mac's own or its network's address.`));
          if (options?.all) return callback(null, addresses);
          const [chosen] = addresses;
          return callback(null, chosen?.address, chosen?.family);
        });
      },
    }, response => {
      /** @type {Buffer[]} */
      const chunks = [];
      let read = 0;
      response.on('data', chunk => {
        read += chunk.length;
        if (read > maxBytes) {
          response.destroy();
          fail(new Unopened(`The link's answer is larger than ${size(maxBytes)}.`));
        } else chunks.push(chunk);
      });
      response.on('end', () => done({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on('error', fail);
    });
    request.on('error', fail);
    request.end();
  });
}

/** @param {string} address */
function refused(address) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(address)?.[1];
  if (mapped !== undefined) return PRIVATE.check(mapped, 'ipv4');
  return PRIVATE.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
}

/** @param {number} bytes */
const size = bytes => bytes >= 1024 * 1024 ? `${bytes / 1024 / 1024} MB` : `${bytes / 1024} KB`;
