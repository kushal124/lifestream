// @ts-check
import { readFileSync } from 'node:fs';
import { join } from 'node:path';


/**
 * @typedef {{ status: number, body: any }} Answered
 */

/**
 * @param {{ door: string, machine: string }} options
 */
export function openHome({ door, machine }) {
  const passFile = join(machine, 'mcp', 'door-token');
  /**
   * @param {'GET' | 'POST'} method
   * @param {string} path
   * @param {unknown} [body]
   * @returns {Promise<Answered>}
   */
  const call = async (method, path, body) => {
    let pass;
    try {
      pass = readFileSync(passFile, 'utf8').trim();
    } catch {
      return { status: 0, body: { message: `no pass in ${passFile} yet: the home's start makes it` } };
    }
    /** @returns {Promise<Answered>} */
    const once = async () => {
      try {
        const response = await fetch(`${door}${path}`, {
          method, headers: { authorization: `Bearer ${pass}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await response.text();
        let parsed = {};
        try {
          parsed = JSON.parse(text);
        } catch {}
        return { status: response.status, body: parsed };
      } catch {
        return { status: 0, body: { message: 'Can\'t reach Lifestream.' } };
      }
    };
    const answered = await once();
    return answered.status === 503 && answered.body?.code === 'OUTCOME_UNKNOWN' && answered.body.again === true ? once() : answered;
  };
  return {
    /** @param {import('./clients.mjs').Card} card */
    request: card => call('POST', '/v1/agents/request', card),
    /** @param {string} id */
    state: id => call('GET', `/v1/agents/request/${encodeURIComponent(id)}`),
    /** @param {{ id: string, client_id: string, resource: string }} asked */
    grant: asked => call('POST', '/v1/agents/grant', asked),
    /** @param {{ refresh_token: string, client_id: string, resource: string }} asked */
    refresh: asked => call('POST', '/v1/agents/refresh', asked),
    /** @param {{ grant: string } | { request: string }} by */
    revoke: by => call('POST', '/v1/agents/revoke', by),
  };
}
