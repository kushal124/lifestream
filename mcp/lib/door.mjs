// @ts-check
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DoorRefusal, ToolError } from './errors.mjs';
import { textHead } from './shape.mjs';


export const DEFAULT_DOOR = 'http://127.0.0.1:4680';

const MAX_BYTES = 64 << 20;
export const MAX_URL = 12 * 1024;
export const GONE = 'Can\'t reach Lifestream.';

/**
 * @typedef {Record<string, string | number | readonly string[] | undefined>} Params
 * @typedef {object} Door
 * @property {string} pass
 * @property {(path: string, params?: Params, headers?: Record<string, string>) => Promise<any>} json
 * @property {(path: string, params?: Params, etag?: string | null) => Promise<{ status: number, etag: string | null, text: string }>} text
 * @property {(path: string) => Promise<Buffer>} bytes
 * @property {(path: string, body: Record<string, unknown>) => Promise<any>} post
 * @property {(signal: AbortSignal) => Door} during
 * @property {(chat?: string) => Door} forModel
 */

/**
 * @param {{ url: string, authorization: string, device?: string, reach?: 'public', signal?: AbortSignal,
 *   server?: () => string | null, model?: true, chat?: string, log?: (line: Record<string, unknown>) => void }} options
 * @returns {Door}
 */
export function openDoor(options) {
  const { url, authorization, device, reach, signal, server, model, chat, log } = options;
  const sent = {
    authorization, ...(device === undefined ? {} : { 'lifestream-device': device }), ...(reach === undefined ? {} : { 'lifestream-reach': reach }),
    ...(model === undefined ? {} : { 'lifestream-reader': 'model' }), ...(chat === undefined ? {} : { 'lifestream-chat': chat }),
  };
  const base = url.replace(/\/+$/u, '');

  /** @param {string} path @param {Params} params */
  const address = (path, params) => {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) {
      if (value === undefined) continue;
      for (const each of Array.isArray(value) ? value : [value]) query.append(name, String(each));
    }
    const text = query.toString();
    if (/[?#\\]/u.test(path) || path.split('/').some(segment => /^(?:\.|%2e){1,2}$/iu.test(segment))) throw new ToolError(`Not a route of the home: ${path}`);
    const at = `${base}${path}${text === '' ? '' : `?${text}`}`;
    if (at.length > MAX_URL) throw new Error(`a request to ${path} of ${at.length} characters, past the ${MAX_URL} the door takes: send its lists in parts`);
    return at;
  };

  /**
   * @param {string} path
   * @param {Params} params
   * @param {Record<string, string>} headers
   * @param {string} [posted]
   */
  const send = async (path, params, headers, posted) => {
    const at = address(path, params);
    const once = async () => {
      const chunks = [];
      let size = 0;
      let response;
      try {
        response = await fetch(at, {
          headers: { ...sent, ...serverHeader(server), ...headers, ...(posted === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(posted === undefined ? {} : { method: 'POST', body: posted }), ...(signal === undefined ? {} : { signal }),
        });
        for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (/** @type {unknown} */ (response.body ?? []))) {
          size += chunk.length;
          if (size > MAX_BYTES) break;
          chunks.push(chunk);
        }
      } catch (error) {
        if (signal?.aborted === true) throw new ToolError('Stopped: the person stopped this answer.', { cause: error });
        log?.({ door: path, failed: GONE, cause: causeOf(error) });
        throw new ToolError(GONE, { cause: error });
      }
      if (size > MAX_BYTES) throw new ToolError(`The door's answer to ${path} is larger than this server reads at once.`);
      return { response, body: Buffer.concat(chunks) };
    };
    let { response, body } = await once();
    const refused = () => response.status === 200 || response.status === 304 ? null : refusal(response, body.toString('utf8'));
    let failure = refused();
    if (failure !== null && sendAgain(failure)) {
      ({ response, body } = await once());
      failure = refused();
    }
    if (failure !== null) throw failure;
    return { status: response.status, etag: response.headers.get('etag'), body };
  };

  return {
    pass: createHash('sha256').update(authorization).digest('hex'),
    async json(path, params = {}, headers = {}) {
      return JSON.parse((await send(path, params, headers)).body.toString('utf8'));
    },
    async text(path, params = {}, etag = null) {
      const { status, etag: now, body } = await send(path, params, etag === null ? {} : { 'if-none-match': etag });
      return { status, etag: now, text: body.toString('utf8') };
    },
    async bytes(path) {
      return (await send(path, {}, {})).body;
    },
    async post(path, body) {
      return JSON.parse((await send(path, {}, {}, JSON.stringify(body))).body.toString('utf8'));
    },
    during: during => openDoor({ ...options, signal: signal === undefined ? during : AbortSignal.any([signal, during]) }),
    forModel: chat => openDoor({ ...options, model: true, ...(chat === undefined ? {} : { chat }) }),
  };
}

/** @typedef {{ id: string, kind: string | null, resource: string | null, turn: { chat: string | null, relayed: string | null } | null }} Pass */

/**
 * @param {Door} door
 * @returns {Promise<{ pass: Pass } | { refusal: ToolError }>}
 */
export async function passOf(door) {
  try {
    const { id, kind, resource, turn } = await door.json('/v1/me');
    const turned = turn !== null && typeof turn === 'object' ? {
      chat: typeof turn.chat === 'string' ? turn.chat : null, relayed: typeof turn.relayed === 'string' ? turn.relayed : null,
    } : null;
    return { pass: { id: String(id), kind: typeof kind === 'string' ? kind : null, resource: typeof resource === 'string' ? resource : null, turn: turned } };
  } catch (error) {
    if (error instanceof ToolError) return { refusal: error };
    throw error;
  }
}

/** @param {unknown} error */
function causeOf(error) {
  for (let at = error; at instanceof Error; at = at.cause) {
    const code = /** @type {{ code?: unknown }} */ (at).code;
    if (typeof code === 'string') return code;
  }
  return error instanceof Error ? error.message : String(error);
}

/** @param {DoorRefusal} failure */
export function sendAgain(failure) {
  return failure.status === 503 && failure.code === 'OUTCOME_UNKNOWN' && failure.body?.again === true;
}

/**
 * @param {Response} response
 * @param {string} text
 */
function refusal(response, text) {
  let code = 'NO_CODE';
  let said = textHead(text.trim(), 500) || 'no message';
  /** @type {Record<string, unknown>} */
  let body = {};
  try {
    const parsed = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object') body = parsed;
    if (typeof body.code === 'string') code = body.code;
    if (typeof body.message === 'string') said = body.message;
  } catch {}
  const retry = Number(response.headers.get('retry-after'));
  return new DoorRefusal(response.status, code, said, response.headers.has('retry-after') && Number.isFinite(retry) ? retry : null, body);
}

/**
 * @param {string} machine
 * @returns {() => string | null}
 */
export function serverPass(machine) {
  const file = join(machine, 'mcp', 'door-token');
  return () => {
    try {
      const pass = readFileSync(file, 'utf8').trim();
      return pass === '' ? null : pass;
    } catch {
      return null;
    }
  };
}

/** @param {(() => string | null) | undefined} server @returns {Record<string, string>} */
function serverHeader(server) {
  const pass = server?.() ?? null;
  return pass === null ? {} : { 'lifestream-server': pass };
}
