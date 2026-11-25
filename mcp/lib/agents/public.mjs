// @ts-check
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openClients } from './clients.mjs';
import { openHome } from './home.mjs';
import { MARK } from '../mark.mjs';
import { SKILL_FILE, SKILL_ROUTE } from '../tools.mjs';


export const PUBLIC_PORT = 4683;
const OFF = "Lifestream's internet address is off on this Mac";
const CODE_MS = 60_000;
const TRANSACTION_MS = 10 * 60_000;
const CONFIRM = /^[0-9]{6}$/u;
const RETRY_MS = 2_000;
const RETRY_FOR_MS = 24 * 60 * 60_000;
const MAX_BODY = 16_384;
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/u;
const CHALLENGE = /^[A-Za-z0-9\-_]{43}$/u;
const REQUEST_ID = /^[A-Za-z0-9\-_]{16,64}$/u;
const SCOPE = 'read';
const CROWDED = 'Too many sign-ins are waiting. Answer them, or wait ten minutes.';
const NOT_READY = 'Lifestream on this Mac can\'t take a sign-in now. Try again in a moment.';

const PAGE = readFileSync(new URL('../../signin.html', import.meta.url), 'utf8').replace('{{MARK}}', () => MARK);
const STYLES = readFileSync(new URL('../../signin.css', import.meta.url), 'utf8');
const SCRIPT = /<script>([\s\S]*?)<\/script>/u.exec(PAGE)?.[1] ?? '';
const POLICY = [
  'default-src \'none\'', 'style-src \'self\'', `script-src 'sha256-${createHash('sha256').update(SCRIPT).digest('base64')}'`, 'connect-src \'self\'',
  'base-uri \'none\'', 'form-action \'none\'', 'frame-ancestors \'none\'',
].join('; ');

/**
 * @typedef {{ id: string, key: string, client_id: string, redirect_uri: string, challenge: string, resource: string, state: string | null, name: string, line: string, confirm: string, at_ms: number, code: string | null }} Transaction
 * @typedef {{ id: string, until_ms: number, state: 'unused' | 'exchanging' | 'granted' | 'refused', grant: string | null, replayed: boolean }} Code
 * @typedef {{ grant: string } | { request: string }} Revoke
 * @typedef {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, public_: { resource: string, challenge: (invalid: boolean) => string }) => void} ServeMcp
 */

/**
 * @param {{ door: string, machine: string, mcp: ServeMcp, now?: () => number, clientDocument?: import('./clients.mjs').ClientDocument, log: (line: Record<string, unknown>) => void }} options
 * @returns {import('node:http').RequestListener}
 */
export function createPublicHandler({ door, machine, mcp, now = Date.now, clientDocument, log }) {
  const publicFile = join(machine, 'mcp', 'public.json');
  const clients = openClients({ machine, ...(clientDocument === undefined ? {} : { clientDocument }) });
  const home = openHome({ door, machine });
  /** @type {Map<string, Transaction>} */
  const transactions = new Map();
  /** @type {Map<string, string>} */
  const asked = new Map();
  /** @type {Map<string, Code>} */
  const codes = new Map();
  /** @type {Map<string, { by: Revoke, since_ms: number }>} */
  const unacknowledged = new Map();
  /** @type {NodeJS.Timeout | null} */
  let retry = null;

  const originOf = () => {
    let text;
    try {
      text = readFileSync(publicFile, 'utf8');
    } catch {
      return null;
    }
    try {
      const { origin } = JSON.parse(text);
      const url = typeof origin === 'string' ? URL.parse(origin) : null;
      if (url !== null && url.protocol === 'https:' && url.origin === origin) return /** @type {string} */ (origin);
    } catch {}
    log({ public: `${publicFile} names no https origin` });
    return null;
  };

  const sweep = () => {
    const at = now();
    for (const [id, transaction] of transactions) {
      if (at - transaction.at_ms > TRANSACTION_MS) {
        transactions.delete(id);
        asked.delete(transaction.key);
      }
    }
    for (const [code, held] of codes) if (at > held.until_ms + TRANSACTION_MS) codes.delete(code);
  };

  /**
   * @param {string} origin
   * @param {string | null} named
   */
  const resourceOf = (origin, named) => {
    const ours = `${origin}/mcp`;
    if (named === null) return ours;
    const url = URL.parse(named);
    if (url === null || url.hash !== '' || url.search !== '') return null;
    return url.href.replace(/\/$/u, '') === ours ? ours : null;
  };

  /**
   * @param {string} origin
   * @param {URLSearchParams} query
   * @param {import('node:http').ServerResponse} response
   */
  const authorize = async (origin, query, response) => {
    const one = (/** @type {string} */ name) => {
      const all = query.getAll(name);
      return all.length === 1 ? /** @type {string} */ (all[0]) : all.length === 0 ? null : undefined;
    };
    const [clientId, redirect, type, challenge, method, resource, state] = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'resource', 'state'].map(one);
    if (clientId === undefined || redirect === undefined || type === undefined || challenge === undefined || method === undefined || resource === undefined || state === undefined) {
      return page(response, 400, { error: 'This sign-in names something twice. Start connecting again.' });
    }
    if (type !== 'code') return page(response, 400, { error: 'This sign-in asks for something other than a code, which is all Lifestream gives.' });
    if (challenge === null || method !== 'S256' || !CHALLENGE.test(challenge)) {
      return page(response, 400, { error: 'This sign-in has no S256 code challenge, which Lifestream requires. The app must sign in with PKCE.' });
    }
    const ours = resourceOf(origin, resource);
    if (ours === null) return page(response, 400, { error: 'This sign-in asks for access to something other than this Lifestream.' });
    if (clientId === null || clientId === '') return page(response, 400, { error: 'This sign-in names no app. Start connecting again.' });
    if (redirect === null) return page(response, 400, { error: 'This sign-in names no address to send access to. Start connecting again.' });
    sweep();
    const key = createHash('sha256').update(JSON.stringify([clientId, redirect, challenge, state, ours])).digest('base64url');
    const again = transactions.get(asked.get(key) ?? '');
    if (again !== undefined) {
      if (again.code !== null) return page(response, 410, { ended: true });
      const { status, body } = await home.state(again.id);
      if (status === 200 && body.state !== 'gone') return page(response, 200, shown(again));
    }
    const known = await clients.identify(clientId, redirect);
    if ('error' in known) return page(response, 400, { error: known.error });
    const made = await home.request(known.card);
    if (made.status === 429) return page(response, 429, { error: CROWDED });
    if (made.status !== 200 || typeof made.body.id !== 'string' || !REQUEST_ID.test(made.body.id) || typeof made.body.code !== 'string' || !CONFIRM.test(made.body.code)
      || typeof made.body.name !== 'string' || made.body.name === '' || typeof made.body.line !== 'string' || made.body.line === '') {
      log({ signin: 'request refused', status: made.status, code: made.body?.code ?? null });
      return page(response, 503, { error: NOT_READY });
    }
    /** @type {Transaction} */
    const transaction = {
      id: made.body.id, key, client_id: clientId, redirect_uri: redirect, challenge, resource: ours, state,
      name: made.body.name, line: made.body.line, confirm: made.body.code, at_ms: now(), code: null,
    };
    transactions.set(transaction.id, transaction);
    asked.set(key, transaction.id);
    log({ signin: 'request', checked: known.card.checked });
    return page(response, 200, shown(transaction));
  };

  /**
   * @param {string} origin
   * @param {string} id
   * @returns {Promise<{ status: number, body: Record<string, unknown> }>}
   */
  const wait = async (origin, id) => {
    const transaction = transactions.get(id);
    if (transaction === undefined || transaction.code !== null) return { status: 200, body: { state: 'gone' } };
    const { status, body } = await home.state(id);
    if (status !== 200) return { status: 503, body: { state: 'waiting' } };
    const state = String(body.state);
    if (state === 'approved') {
      if (transaction.code !== null) return { status: 200, body: { state: 'gone' } };
      const code = randomBytes(32).toString('base64url');
      transaction.code = code;
      codes.set(code, { id, until_ms: now() + CODE_MS, state: 'unused', grant: null, replayed: false });
      log({ signin: 'approved' });
      return { status: 200, body: { state, redirect: sent(transaction, origin, { code }) } };
    }
    if (state === 'denied' || state === 'wrong') return { status: 200, body: { state, redirect: sent(transaction, origin, { error: 'access_denied' }) } };
    if (state === 'waiting') return { status: 200, body: { state } };
    return { status: 200, body: { state: 'gone' } };
  };

  /** @param {string} key */
  const send = async key => {
    const waiting = unacknowledged.get(key);
    if (waiting === undefined) return;
    const by = 'grant' in waiting.by ? 'grant' : 'request';
    const done = await home.revoke(waiting.by);
    if (done.status === 200) {
      if (unacknowledged.delete(key)) log({ signin: 'code used twice: revoked in the home', by });
      return;
    }
    if (now() - waiting.since_ms >= RETRY_FOR_MS) {
      unacknowledged.delete(key);
      return log({ signin: 'code used twice: the home never acknowledged its revoke, given up', by, status: done.status });
    }
    log({ signin: 'code used twice: the home did not acknowledge its revoke, sent again shortly', by, status: done.status });
    if (retry !== null) return;
    retry = setTimeout(() => {
      retry = null;
      void Promise.all([...unacknowledged.keys()].map(send));
    }, RETRY_MS);
    retry.unref();
  };

  /** @param {Code} held */
  const revoke = async held => {
    /** @type {Revoke} */
    const by = held.grant !== null ? { grant: held.grant } : { request: held.id };
    const key = JSON.stringify(by);
    if (!unacknowledged.has(key)) unacknowledged.set(key, { by, since_ms: now() });
    await send(key);
    return oauthError(400, 'invalid_grant', 'This code was used already.');
  };

  /** @param {Code} held */
  const replayed = async held => {
    held.replayed = true;
    if (held.state !== 'exchanging') return revoke(held);
    log({ signin: 'code used twice while exchanging' });
    return oauthError(400, 'invalid_grant', 'This code was used already.');
  };

  /**
   * @param {string} origin
   * @param {URLSearchParams} form
   * @returns {Promise<{ status: number, body: Record<string, unknown> }>}
   */
  const token = async (origin, form) => {
    for (const name of new Set(form.keys())) if (form.getAll(name).length > 1) return oauthError(400, 'invalid_request', `${name} is named twice.`);
    const grantType = form.get('grant_type');
    const clientId = form.get('client_id');
    if (grantType === 'authorization_code') {
      const code = form.get('code');
      if (code === null) return oauthError(400, 'invalid_request', 'code is missing.');
      const held = codes.get(code);
      if (held === undefined) return oauthError(400, 'invalid_grant', 'This code is not one Lifestream gave, or has ended.');
      if (held.state !== 'unused') return replayed(held);
      held.state = 'exchanging';
      /** @param {string} why */
      const refused = why => {
        held.state = 'refused';
        return oauthError(400, 'invalid_grant', why);
      };
      if (now() > held.until_ms) return refused('This code has ended.');
      const transaction = transactions.get(held.id);
      if (transaction === undefined) return refused('This code\'s sign-in has ended.');
      if (clientId !== transaction.client_id) return refused('This code was given to another client.');
      if (form.get('redirect_uri') !== transaction.redirect_uri) return refused('redirect_uri is not the one this code was given for.');
      if (resourceOf(origin, form.get('resource')) !== transaction.resource) return refused('resource is not the one this code was given for.');
      const verifier = form.get('code_verifier');
      if (verifier === null || !VERIFIER.test(verifier) || createHash('sha256').update(verifier).digest('base64url') !== transaction.challenge) {
        return refused('code_verifier does not answer this code\'s challenge.');
      }
      const granted = await home.grant({ id: transaction.id, client_id: transaction.client_id, resource: transaction.resource });
      log({ signin: 'grant', status: granted.status });
      const made = granted.status === 200 && typeof granted.body.grant === 'string';
      held.state = made ? 'granted' : 'refused';
      held.grant = made ? granted.body.grant : null;
      if (held.replayed) return revoke(held);
      return tokens(granted, 'This sign-in is no longer approved.');
    }
    if (grantType === 'refresh_token') {
      const refresh = form.get('refresh_token');
      if (refresh === null || clientId === null) return oauthError(400, 'invalid_request', 'refresh_token and client_id are required.');
      const resource = resourceOf(origin, form.get('resource'));
      if (resource === null) return oauthError(400, 'invalid_grant', 'resource is not this Lifestream.');
      const renewed = await home.refresh({ refresh_token: refresh, client_id: clientId, resource });
      log({ signin: 'refresh', status: renewed.status });
      return tokens(renewed, typeof renewed.body?.message === 'string' && renewed.body.message !== '' ? renewed.body.message : 'This refresh token is not one Lifestream holds.');
    }
    return oauthError(400, grantType === null ? 'invalid_request' : 'unsupported_grant_type', 'grant_type is authorization_code or refresh_token.');
  };

  return (request, response) => {
    const origin = originOf();
    if (origin === null) return text(response, 503, OFF);
    const url = URL.parse(request.url ?? '/', 'http://public');
    if (url === null) return text(response, 400, 'The request names no path.');
    const path = url.pathname;
    const method = request.method ?? '';
    /** @param {string[]} methods */
    const takes = methods => {
      if (methods.includes(method)) return true;
      response.writeHead(405, { allow: methods.join(', '), 'content-type': 'text/plain; charset=utf-8' });
      response.end(`${path} takes ${methods.join(' and ')}.`);
      return false;
    };
    /** @param {Promise<void>} done */
    const handled = done => void done.catch(error => {
      log({ public: `failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`, path });
      if (!response.headersSent) text(response, 500, 'The sign-in failed on this request.');
    });

    if (path === '/mcp') {
      if (!takes(['POST'])) return;
      return mcp(request, response, { resource: `${origin}/mcp`, challenge: invalid => challengeOf(origin, invalid) });
    }
    if (path === SKILL_ROUTE) {
      if (!takes(['GET'])) return;
      response.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
      return void response.end(SKILL_FILE);
    }
    if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
      if (!takes(['GET'])) return;
      return json(response, 200, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: [SCOPE], bearer_methods_supported: ['header'], resource_name: 'Lifestream' });
    }
    if (path === '/.well-known/oauth-authorization-server') {
      if (!takes(['GET'])) return;
      return json(response, 200, {
        issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`, registration_endpoint: `${origin}/oauth/register`,
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'], client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true,
        scopes_supported: [SCOPE],
      });
    }
    if (path === '/oauth/register') {
      if (!takes(['POST'])) return;
      return handled((async () => {
        const read = await bodyOf(request);
        if (read === null) return json(response, 413, { error: 'invalid_client_metadata', error_description: `A registration is at most ${MAX_BODY} bytes.` });
        let body;
        try {
          body = JSON.parse(read);
        } catch {
          return json(response, 400, { error: 'invalid_client_metadata', error_description: 'Send the registration as JSON.' });
        }
        const registered = clients.register(body);
        log({ signin: 'register', status: registered.status });
        return json(response, registered.status, registered.body);
      })());
    }
    if (path === '/oauth/authorize') {
      if (!takes(['GET'])) return;
      return handled(authorize(origin, url.searchParams, response));
    }
    const waiting = /^\/oauth\/wait\/([^/]+)$/u.exec(path);
    if (waiting !== null) {
      if (!takes(['GET'])) return;
      return handled(wait(origin, /** @type {string} */ (waiting[1])).then(({ status, body }) => json(response, status, body)));
    }
    if (path === '/oauth/token') {
      if (!takes(['POST'])) return;
      return handled((async () => {
        const type = String(request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
        const read = await bodyOf(request);
        const { status, body } = read === null ? oauthError(413, 'invalid_request', `A token request is at most ${MAX_BODY} bytes.`)
          : type !== 'application/x-www-form-urlencoded' ? oauthError(400, 'invalid_request', 'Send the token request form-encoded.')
            : await token(origin, new URLSearchParams(read));
        return json(response, status, body, true);
      })());
    }
    if (path === '/oauth/signin.css') {
      if (!takes(['GET'])) return;
      response.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
      return void response.end(STYLES);
    }
    return text(response, 404, 'Not found.');
  };
}

/** @param {Transaction} transaction */
function shown(transaction) {
  return { name: transaction.name, line: transaction.line, confirm: transaction.confirm, wait: `/oauth/wait/${transaction.id}` };
}

/**
 * @param {Transaction} transaction
 * @param {string} origin
 * @param {Record<string, string>} told
 */
function sent(transaction, origin, told) {
  const url = new URL(transaction.redirect_uri);
  for (const [name, value] of Object.entries(told)) url.searchParams.set(name, value);
  url.searchParams.set('iss', origin);
  if (transaction.state !== null) url.searchParams.set('state', transaction.state);
  return url.href;
}

/**
 * @param {string} origin
 * @param {boolean} invalid
 */
function challengeOf(origin, invalid) {
  return `Bearer ${invalid ? 'error="invalid_token", ' : ''}resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="${SCOPE}"`;
}

/**
 * @param {import('./home.mjs').Answered} answered
 * @param {string} refused
 */
function tokens({ status, body }, refused) {
  if (status === 200 && typeof body.access_token === 'string' && typeof body.refresh_token === 'string') {
    return { status: 200, body: { access_token: body.access_token, token_type: 'Bearer', expires_in: body.expires_in, refresh_token: body.refresh_token, scope: SCOPE } };
  }
  if (status === 400 || status === 409) return oauthError(400, 'invalid_grant', refused);
  const said = typeof body?.message === 'string' && body.message !== '' ? body.message : NOT_READY;
  if (status === 503 && body?.code === 'OUTCOME_UNKNOWN') return oauthError(400, 'invalid_grant', said);
  return oauthError(503, 'temporarily_unavailable', status === 0 ? NOT_READY : said);
}

/** @param {number} status @param {string} error @param {string} description */
const oauthError = (status, error, description) => ({ status, body: { error, error_description: description } });

/**
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {Record<string, unknown>} data
 */
function page(response, status, data) {
  const island = JSON.stringify(data).replace(/[<>&\u2028\u2029]/gu, each => `\\u${each.charCodeAt(0).toString(16).padStart(4, '0')}`);
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': POLICY, 'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
  });
  response.end(PAGE.replace('{{DATA}}', () => island));
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {unknown} body
 * @param {boolean} [secret]
 */
function json(response, status, body, secret = false) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...(secret ? { pragma: 'no-cache' } : {}) });
  response.end(JSON.stringify(body));
}

/** @param {import('node:http').ServerResponse} response @param {number} status @param {string} said */
function text(response, status, said) {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  response.end(said);
}

/** @param {import('node:http').IncomingMessage} request */
async function bodyOf(request) {
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
