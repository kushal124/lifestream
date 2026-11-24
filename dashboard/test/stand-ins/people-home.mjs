// @ts-check
import { createServer } from 'node:http';
import { crc32, deflateSync } from 'node:zlib';
import { until } from '../until.mjs';
import { followDoor, feedOut } from './door-feed.mjs';
import { answerPicture, doorBytes, PICTURE_ROUTE } from './pictures.mjs';

/**
 * @typedef {{ state: 'never-asked' | 'installing' | 'off' | 'waiting-for-power' | 'on', scanned: number | null,
 *   photos: number | null }} FacesIndex
 */

export const GROUND = /** @type {const} */ ([40, 70, 200]);
export const FACE = /** @type {const} */ ([60, 200, 90]);
export const PHOTO = /** @type {const} */ ({ width: 800, height: 600, box: [100, 100, 300, 300] });
const LIBRARY = Buffer.from('synthetic faces photo ');

export const FACES_NEED = 'label:face-engine';

/** @type {Record<FacesIndex['state'], [import('../../public/types.js').State, string, boolean, boolean]>} */
const SAID = { 'never-asked': ['setup', 'Not turned on yet', false, false], off: ['off', 'Off', true, false],
  installing: ['waiting', 'Getting the face models', true, true],
  'waiting-for-power': ['waiting', 'Waiting for power', true, true], on: ['ok', 'Up to date', true, true] };

/** @param {any} way */
const unInstalled = way => ({ ...way, ready: false, requirements: way.requirements.map((/** @type {any} */ each) => each.kind === 'install'
  ? { ...each, met: false, act: { do: 'install', label: 'Install' }, words: 'Get the face models', line: 'Downloads once, then runs on your Mac.' }
  : each) });

const picture = (() => {
  /** @type {Buffer | null} */
  let made = null;
  return () => {
    if (made) return made;
    const { width, height, box: [x1, y1, x2, y2] } = PHOTO;
    const rows = Buffer.alloc((width * 3 + 1) * height);
    for (let y = 0; y < height; y++) {
      const at = y * (width * 3 + 1);
      for (let x = 0; x < width; x++) {
        const [r, g, b] = x >= x1 && x < x2 && y >= y1 && y < y2 ? FACE : GROUND;
        rows.writeUInt8(r, at + 1 + x * 3);
        rows.writeUInt8(g, at + 2 + x * 3);
        rows.writeUInt8(b, at + 3 + x * 3);
      }
    }
    /** @param {string} type @param {Buffer} data */
    const chunk = (type, data) => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(data.length, 0);
      head.write(type, 4, 'latin1');
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
      return Buffer.concat([head, data, crc]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.writeUInt8(8, 8);
    header.writeUInt8(2, 9);
    made = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header),
      chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
    return made;
  };
})();

/** @param {{ door: { url: string, token: string }, people: string }} options */
export async function peopleHome({ door, people }) {
  /** @type {FacesIndex} */
  let faces = { state: 'never-asked', scanned: null, photos: null };
  const landed = /** @type {string[]} */ ([]);
  let seq = 0;
  /** @type {string[]} */
  const pictures = [];
  /** @type {unknown[]} */
  const acted = [];
  /** @type {Record<string, unknown> | null | undefined} */
  let playing;

  const out = feedOut();
  /** @type {string[] | null} */
  let hushed = null;
  const followed = await followDoor({ url: door.url, token: door.token, heard: (block, event) => {
    if (typeof event?.seq === 'number') seq = Math.max(seq, event.seq);
    if (event?.kind === 'import' && String(event.key).startsWith(`${people}/`)) landed.push(event.key);
    if (hushed) hushed.push(block);
    else out.relay(block);
  } });
  const tell = out.tell;

  /**
   * @param {string} path
   * @param {Record<string, string>} params
   * @param {string} authorization
   */
  const read = async (path, params, authorization) => {
    const response = await fetch(`${door.url}${path}?${new URLSearchParams(params)}`, { headers: { authorization } });
    return response.ok ? response.json() : null;
  };

  /** @param {import('node:http').IncomingMessage} request @param {import('node:http').ServerResponse} response */
  const handle = async (request, response) => {
    const address = new URL(request.url ?? '', 'http://door');
    const path = address.pathname;
    const authorization = String(request.headers.authorization ?? '');
    if (path === '/v1/feed') {
      out.add(response);
      return;
    }
    /** @type {Buffer[]} */
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    /** @param {Buffer | undefined} bytes */
    const pass = bytes => fetch(`${door.url}${request.url}`, {
      method: request.method, headers: { authorization,
        ...(request.headers['content-type'] ? { 'content-type': String(request.headers['content-type']) } : {}) },
      body: bytes,
    });
    /** @param {Response} answer */
    const relay = async answer => {
      response.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') ?? 'application/json' });
      response.end(Buffer.from(await answer.arrayBuffer()));
    };
    /** @param {number} status @param {unknown} value */
    const json = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };

    if (request.method === 'POST' && path === '/v1/act' && body && JSON.parse(body.toString('utf8')).need === FACES_NEED) {
      acted.push(JSON.parse(body.toString('utf8')));
      return json(200, { acted: 'queued' });
    }
    const asking = PICTURE_ROUTE.exec(path);
    if (asking) {
      pictures.push(request.url ?? '');
      return answerPicture(asking[1], address, request, response, async () => {
        const bytes = await doorBytes(door.url, asking[1], authorization);
        return bytes && Buffer.from(bytes.subarray(0, LIBRARY.length)).equals(LIBRARY) ? picture() : bytes;
      });
    }
    const passed = await pass(body);
    if (path === '/v1/connectors' && passed.status === 200) {
      const report = await passed.json();
      const [state, words, setUp, on] = SAID[faces.state];
      return json(200, { ...report, connectors: report.connectors.map((/** @type {any} */ row) => row.id === 'faces'
        ? { ...row, line: words, set_up: setUp, on, ways: setUp ? row.ways : row.ways.map(unInstalled),
          health: { state, reason: null, words, since_ms: null, next_ms: null,
            acts: faces.state === 'waiting-for-power' ? [{ do: 'try', label: 'Scan now', need: FACES_NEED }] : [], detail: null } }
        : row) });
    }
    if (path.startsWith('/v1/blobs/') && passed.status === 200) {
      const bytes = Buffer.from(await passed.arrayBuffer());
      const drawn = bytes.subarray(0, LIBRARY.length).equals(LIBRARY);
      response.writeHead(200, { 'content-type': drawn ? 'image/png' : passed.headers.get('content-type') ?? 'application/octet-stream' });
      response.end(drawn ? picture() : bytes);
      return;
    }
    if (path === '/v1/people' && passed.status === 200 && playing !== undefined) {
      const answer = await passed.json();
      const played = (/** @type {any} */ person) => person?.me ? playing && { ...person, ...playing } : person;
      if (answer.person) return answer.person.me && !playing ? json(404, { error: 'PERSON_UNKNOWN' }) : json(200, { ...answer, person: played(answer.person) });
      return json(200, { ...answer, ...'you' in answer ? { you: played(answer.you) ?? null } : {},
        people: (answer.people ?? []).flatMap((/** @type {any} */ person) => person.me && !playing ? [] : [played(person)]) });
    }
    if (path === '/v1/people/photos' && passed.status === 200) {
      const { maybe: _maybe, ...answer } = await passed.json();
      if (typeof answer.total === 'number') return json(200, answer);
      let total = 0;
      for (let after = ''; ;) {
        const page = await read('/v1/people/photos', { id: address.searchParams.get('id') ?? '', ...(after ? { after } : {}) }, authorization);
        total += page?.photos?.length ?? 0;
        if (!page?.next) break;
        after = page.next;
      }
      return json(200, { ...answer, total });
    }
    return relay(passed);
  };
  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));

  return {
    url: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`,
    /** @param {FacesIndex} next */
    faces(next) {
      faces = next;
    },
    /** @param {Record<string, unknown> | null | undefined} fields */
    you(fields) {
      playing = fields;
    },
    /** @param {number} count */
    landing: count => until(`the people source's landing ${count + 1}`, () => landed[count]),
    landings: () => landed.length,
    hush() {
      hushed ??= [];
    },
    unhush() {
      const held = hushed ?? [];
      hushed = null;
      for (const block of held) out.relay(block);
    },
    pictures,
    acted,
    poke() {
      const at_ms = Date.now();
      tell(`id: 0:${at_ms}\ndata: ${JSON.stringify({ seq: 0, at_ms, kind: 'job', key: 'faces', detail: {} })}\n\n`);
    },
    reset() {
      const at_ms = Date.now();
      tell(`id: ${seq}:${at_ms}\nevent: reset\ndata: ${JSON.stringify({ seq, at_ms })}\n\n`);
    },
    /**
     * @param {string} position
     * @param {string} [changed]
     */
    people(position, changed = position) {
      const at_ms = Date.now();
      tell(`id: ${seq}:${at_ms}\ndata: ${JSON.stringify({ seq, at_ms, kind: 'people', key: 'people', detail: { position, changed } })}\n\n`);
    },
    async close() {
      followed.close();
      out.close();
      server.closeAllConnections();
      await new Promise(done => server.close(() => done(undefined)));
    },
  };
}
