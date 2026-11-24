// @ts-check
/** @import { Route } from './router.mjs' */
/** @import { LifeReader } from '../life.mjs' */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { reply } from './router.mjs';
import { PAGES } from '../pages.mjs';

const IMMUTABLE = 'private, max-age=31536000, immutable';

/**
 * @param {LifeReader} life
 * @param {() => Promise<unknown>} atlas
 * @returns {Route[]}
 */
export function lifeRoutes(life, atlas) {
  /** @param {URL} url @param {string} name */
  const read = (url, name) => url.searchParams.get(name) || '';
  /**
   * @param {URL} url
   * @param {AbortSignal} signal
   */
  const asked = (url, signal) => ({ settled: read(url, 'settled') === '1', signal });
  /** @param {URL} url */
  const pageParams = url => Object.fromEntries([...url.searchParams].filter(([name]) => name !== 'settled'));
  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {unknown} answer
   */
  const validated = (req, answer) => {
    const etag = `W/"${createHash('sha256').update(JSON.stringify(answer)).digest('base64url')}"`;
    return req.headers['if-none-match'] === etag ? reply(null, 304, { etag }) : reply(answer, 200, { etag });
  };
  /** @param {URL} url */
  const photoPage = url => ({ after: read(url, 'after'), at: read(url, 'at'), limit: read(url, 'limit') });
  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {(signal: AbortSignal) => Promise<unknown>} answer
   * @param {(value: any) => import('./router.mjs').Reply} [send]
   */
  const leaving = async (req, answer, send = reply) => {
    const socket = req.socket;
    const gone = new AbortController();
    const leave = () => gone.abort();
    socket.once('close', leave);
    try {
      if (socket.destroyed) return reply({ error: 'The page left.' }, 499);
      return send(await answer(gone.signal));
    } catch (error) {
      if (gone.signal.aborted) return reply({ error: 'The page left.' }, 499);
      throw error;
    } finally {
      socket.off('close', leave);
    }
  };
  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {URL} url
   */
  const picture = async (req, url) => {
    const going = new AbortController();
    req.once('close', () => going.abort());
    const found = await life.picture(read(url, 'hash'), read(url, 'size'), read(url, 'recipe'),
      String(req.headers['if-none-match'] ?? ''), going.signal);
    return {
      /** @param {import('node:http').ServerResponse} res */
      stream: async res => {
        /** @type {Record<string, string>} */
        const headers = { 'Cache-Control': found.cache ?? 'no-store' };
        if (found.etag) headers.ETag = found.etag;
        if (found.status === 304 || !found.body) {
          res.writeHead(304, headers);
          res.end();
          return;
        }
        res.writeHead(200, { ...headers, 'Content-Type': found.type, 'Content-Disposition': 'inline' });
        await pipeline(Readable.fromWeb(/** @type {import('node:stream/web').ReadableStream} */ (found.body)), res).catch(() => going.abort());
      },
    };
  };
  /**
   * @param {import('node:http').IncomingMessage} req
   * @template {{ status: number, headers: Headers, body: ReadableStream<Uint8Array> | null }} F
   * @param {(signal: AbortSignal) => Promise<F>} read
   * @param {(found: F) => Record<string, string>} headers
   */
  const passed = async (req, read, headers) => {
    const going = new AbortController();
    req.once('close', () => going.abort());
    const found = await read(going.signal);
    return {
      /** @param {import('node:http').ServerResponse} res */
      stream: async res => {
        const sent = headers(found);
        for (const name of ['content-length', 'content-range']) {
          const value = found.headers.get(name);
          if (value) sent[name] = value;
        }
        res.writeHead(found.status, sent);
        await pipeline(Readable.fromWeb(/** @type {import('node:stream/web').ReadableStream} */ (found.body)), res).catch(() => going.abort());
      },
    };
  };
  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {URL} url
   */
  const media = (req, url) => passed(req, signal => life.media(read(url, 'hash'), String(req.headers.range ?? ''), signal),
    found => ({ 'Content-Type': found.type, 'Accept-Ranges': 'bytes', 'Cache-Control': IMMUTABLE, 'Content-Disposition': 'inline' }));
  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {URL} url
   */
  const download = (req, url) => passed(req, signal => life.download(read(url, 'hash'), signal),
    () => ({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment', 'X-Content-Type-Options': 'nosniff',
      'Cache-Control': IMMUTABLE }));
  return [
    {
      method: 'GET',
      path: '/api/life/days',
      handle: async ({ url }) => reply(await life.days({ from: read(url, 'from'), to: read(url, 'to'), limit: read(url, 'limit') })),
    },
    { method: 'GET', path: '/api/clock', handle: async () => reply(await life.clock()) },
    { method: 'GET', path: '/api/life/products', handle: async () => reply(await life.products()) },
    {
      method: 'GET',
      path: '/api/life/record',
      handle: async ({ url }) => reply(await life.record({ source: read(url, 'source'), kind: read(url, 'kind'), key: read(url, 'key') })),
    },
    { method: 'GET', path: '/api/life/read', handle: async ({ url }) => reply(await life.read(read(url, 'ref'))) },
    { method: 'GET', path: '/api/life/describe', handle: async ({ url }) => reply(await life.describe(url.searchParams.getAll('ref'))) },
    {
      method: 'GET',
      path: '/api/life/extract',
      handle: async ({ url }) => reply(await life.extract({ family: read(url, 'family'), unit: read(url, 'unit') })),
    },
    {
      method: 'GET',
      path: '/api/life/conversation',
      handle: async ({ url }) => reply(await life.conversation(read(url, 'chat'), read(url, 'day'))),
    },
    {
      method: 'GET',
      path: '/api/life/places',
      handle: async ({ req, url }) => leaving(req, signal => url.searchParams.has('slug') ? life.onePlace(read(url, 'slug'), asked(url, signal))
        : life.places(asked(url, signal))),
    },
    {
      method: 'GET',
      path: '/api/life/placed',
      handle: async ({ url }) => reply(await life.placed(read(url, 'unit'))),
    },
    {
      method: 'GET',
      path: '/api/life/places/suggest',
      handle: async ({ url }) => {
        const q = url.searchParams.get('q');
        return reply(await life.suggest({ ...Object.fromEntries(['spot', 'latitude', 'longitude', 'from_ms', 'to_ms']
          .map(name => [name, read(url, name)])), ...(q === null ? {} : { q }) }));
      },
    },
    {
      method: 'GET',
      path: '/api/life/places/photos',
      handle: async ({ req, url }) => leaving(req, signal => life.placePhotos(read(url, 'slug'), photoPage(url), signal)),
    },
    { method: 'GET', path: '/api/life/atlas', handle: async () => reply(await atlas()) },
    {
      method: 'GET',
      path: '/api/life/people',
      handle: async ({ req, url }) => leaving(req, signal => life.people(asked(url, signal))),
    },
    {
      method: 'GET',
      path: '/api/life/people/photos',
      handle: async ({ req, url }) => leaving(req, signal => life.personPhotos(read(url, 'id'), photoPage(url), signal)),
    },
    {
      method: 'GET',
      path: '/api/life/where',
      handle: async ({ url }) => reply(await life.where(Object.fromEntries(['at', 'from', 'to', 'grain'].map(name => [name, read(url, name)])))),
    },
    { method: 'GET', path: '/api/life/devices', handle: async () => reply(await life.devices()) },
    { method: 'GET', path: '/api/life/picture', handle: async ({ req, url }) => picture(req, url) },
    { method: 'GET', path: '/api/life/pictures', handle: async () => reply(await life.pictures()) },
    { method: 'GET', path: '/api/life/photos', handle: async ({ req, url }) => leaving(req, signal => life.photo(read(url, 'hash'), signal)) },
    { method: 'GET', path: '/api/life/media', handle: async ({ req, url }) => media(req, url) },
    { method: 'GET', path: '/api/life/download', handle: async ({ req, url }) => download(req, url) },
    ...Object.keys(PAGES).map(name => /** @type {Route} */ ({
      method: 'GET',
      path: `/api/page/${name}`,
      handle: async ({ req, url }) => leaving(req, signal => life.page(name, pageParams(url), asked(url, signal)),
        answer => validated(req, answer)),
    })),
  ];
}
