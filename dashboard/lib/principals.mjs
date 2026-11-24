// @ts-check
/** @import { IncomingMessage, ServerResponse } from 'node:http' */
import { createHash } from 'node:crypto';
import { readBody, setSecurityHeaders } from './http.mjs';


const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export const COOKIE = 'lifestream_token';

const YEAR_SECONDS = 31536000;

/**
 * @typedef {(token: string) => Promise<boolean>} Allows
 * @typedef {{ status: number, type: string, body: string, headers?: Record<string, string>, principal: string }} GuardReply
 */

/** @param {string | undefined} address */
export function isLoopback(address) {
  return address !== undefined && LOOPBACK.has(address);
}

/** @param {string} token */
export const tokenTag = token => `sha256:${createHash('sha256').update(token).digest('hex').slice(0, 12)}`;

/**
 * @param {IncomingMessage} req
 * @returns {string | undefined}
 */
export function requestToken(req) {
  const header = req.headers.authorization;
  const bearer = typeof header === 'string' ? /^Bearer\s+(\S+)$/.exec(header) : null;
  if (bearer) return bearer[1];
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === COOKIE && value.length) return decodeURIComponent(value.join('='));
  }
  return undefined;
}

/**
 * @param {IncomingMessage} req
 * @param {{ allows: Allows }} parts
 * @returns {Promise<GuardReply | null>}
 */
export async function guardRequest(req, { allows }) {
  if (isLoopback(req.socket?.localAddress)) return null;
  const token = requestToken(req);
  const principal = token === undefined ? '-' : tokenTag(token);
  let allowed = false;
  try {
    allowed = token !== undefined && await allows(token);
  } catch {
    return { status: 503, type: 'application/json', body: JSON.stringify({ error: 'Can\'t reach Lifestream.', code: 'GONE' }), principal };
  }
  if (allowed) return null;
  if (String(req.headers.accept ?? '').includes('text/html')) {
    return { status: 303, type: 'text/plain', body: '', headers: { Location: '/login' }, principal };
  }
  return { status: 401, type: 'application/json', body: JSON.stringify({ error: 'A read principal is required.' }), principal };
}

/** @param {string | null} message */
export function loginPage(message) {
  const note = message ? `<p class="note">${message}</p>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lifestream</title>
<style>
:root{color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;line-height:1.5}
body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;background:#090909;color:#e7e7e5}
form{width:300px;padding:28px;background:#141414;border:1px solid #242424;border-radius:12px}
h1{margin:0 0 18px;font-size:15px;font-weight:600;letter-spacing:-.3px}
label{display:block;margin:0 0 6px;color:#969694}
input{width:100%;padding:9px 10px;font:inherit;color:#e7e7e5;background:#090909;border:1px solid #242424;border-radius:9px}
button{width:100%;margin-top:14px;padding:9px 10px;font:inherit;color:#090909;background:#b6d0b4;border:0;border-radius:9px;cursor:pointer}
.note{margin:14px 0 0;color:#efa6a0}
</style></head>
<body><form method="post" action="/login">
<h1>Lifestream</h1>
<label for="token">Reader token</label>
<input id="token" name="token" type="password" placeholder="The token Lifestream gave you" autocomplete="current-password" autofocus>
<button type="submit">Open</button>
${note}
</form></body></html>
`;
}

/**
 * @param {{ allows: Allows, log?: (line: string) => void }} parts
 * @returns {(req: IncomingMessage, res: ServerResponse) => Promise<boolean>}
 */
export function principalGate({ allows, log = line => console.log(line) }) {
  /**
   * @param {ServerResponse} res
   * @param {number} status
   * @param {string} type
   * @param {string} body
   * @param {Record<string, string>} [headers]
   */
  const send = (res, status, type, body, headers = {}) => {
    setSecurityHeaders(res);
    if (type === 'text/html') res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'unsafe-inline'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.writeHead(status, { 'Content-Type': type, ...headers });
    res.end(body);
  };
  /** @param {number} status @param {string} path @param {string} principal */
  const refused = (status, path, principal) => log(`dashboard ${status} ${path} principal ${principal}`);
  return async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (path === '/login') {
      if (req.method === 'GET') {
        send(res, 200, 'text/html', loginPage(null));
        return true;
      }
      if (req.method === 'POST') {
        const body = await readBody(req, 4096, 'Too long.');
        const token = new URLSearchParams(body).get('token') ?? '';
        let allowed = false;
        try {
          allowed = token !== '' && await allows(token);
        } catch {
          send(res, 503, 'text/html', loginPage('Can\'t reach Lifestream. Try again in a moment.'));
          return true;
        }
        if (allowed) {
          const cookie = `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${YEAR_SECONDS}`;
          send(res, 303, 'text/plain', '', { Location: '/', 'Set-Cookie': cookie });
          return true;
        }
        refused(401, path, token ? tokenTag(token) : '-');
        send(res, 401, 'text/html', loginPage('That token does not open this Lifestream.'));
        return true;
      }
      return false;
    }
    const reply = await guardRequest(req, { allows });
    if (!reply) return false;
    refused(reply.status, path, reply.principal);
    send(res, reply.status, reply.type, reply.body, reply.headers);
    return true;
  };
}
