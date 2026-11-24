// @ts-check
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProvider } from '@earendil-works/pi-ai/models';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { openDoor } from '../door.mjs';
import { DoorRefusal } from '../errors.mjs';


export const OPENROUTER = { provider: 'openrouter', modelId: 'openai/gpt-6-luna' };
export const KEY_ROUTE = '/v1/secrets/openrouter';
const KEPT_MS = 60_000;
const BEARER = /^[\x21-\x7e]+$/u;
const HIDDEN = '[the OpenRouter key]';

/**
 * @typedef {import('@earendil-works/pi-ai').CredentialStore} KeyStore
 * @param {{ machine: string, door: string, log: (line: Record<string, unknown>) => void }} options
 * @returns {KeyStore}
 */
export function homeKey({ machine, door, log }) {
  /** @type {{ key: string, at: number } | null} */
  let kept = null;
  /** @type {Promise<string | null> | null} */
  let reading = null;

  const fetchKey = async () => {
    let pass;
    try {
      pass = readFileSync(join(machine, 'ask', 'door-token'), 'utf8').trim();
    } catch {
      log({ ask: 'openrouter key unread', why: 'no pass of Ask\'s yet: the home\'s start makes it' });
      return null;
    }
    let answer;
    try {
      answer = await openDoor({ url: door, authorization: `Bearer ${pass}`, log }).json(KEY_ROUTE);
    } catch (error) {
      if (error instanceof DoorRefusal) {
        if (error.status !== 404) log({ ask: 'openrouter key unread', status: error.status, code: error.code });
      } else {
        log({ ask: 'openrouter key unread', why: 'the door did not answer' });
      }
      return null;
    }
    const key = answer?.key;
    if (typeof key === 'string' && BEARER.test(key)) return key;
    log({ ask: 'openrouter key unread', why: 'the home\'s key is not one word of printable ASCII, so it cannot be sent' });
    return null;
  };

  /** @returns {Promise<string | null>} */
  const current = () => {
    if (kept !== null && performance.now() - kept.at < KEPT_MS) return Promise.resolve(kept.key);
    reading ??= fetchKey().then(key => {
      kept = key === null ? null : { key, at: performance.now() };
      return key;
    }).finally(() => { reading = null; });
    return reading;
  };

  const refused = () => Promise.reject(new Error('The OpenRouter key is Lifestream\'s: it is sealed in its vault, on the Mac Lifestream runs on.'));
  return {
    async read(providerId) {
      if (providerId !== OPENROUTER.provider) return undefined;
      const key = await current();
      return key === null ? undefined : { type: 'api_key', key };
    },
    async list() {
      return (await current()) === null ? [] : [{ providerId: OPENROUTER.provider, type: 'api_key' }];
    },
    modify: refused,
    delete: refused,
  };
}

/** @param {string | null} [base] */
export function openRouterProvider(base = null) {
  const pi = openrouterProvider();
  const named = pi.getModels().find(model => model.id === OPENROUTER.modelId);
  if (named === undefined) throw new Error(`pi-ai no longer lists ${OPENROUTER.modelId} on OpenRouter`);
  const model = base === null ? named : { ...named, baseUrl: base };
  return createProvider({
    id: OPENROUTER.provider, name: 'OpenRouter', baseUrl: model.baseUrl,
    auth: {
      apiKey: {
        name: 'OpenRouter key',
        resolve: async ({ credential }) => credential?.key ? { auth: { apiKey: credential.key }, source: 'the home\'s key' } : undefined,
      },
    },
    models: [model],
    api: { stream: withoutKey(pi.stream), streamSimple: withoutKey(pi.streamSimple) },
  });
}

/**
 * @template {(model: any, context: any, options?: any) => import('@earendil-works/pi-ai').AssistantMessageEventStream} Stream
 * @param {Stream} ask
 * @returns {Stream}
 */
function withoutKey(ask) {
  return /** @type {Stream} */ ((model, context, options) => {
    const key = typeof options?.apiKey === 'string' ? options.apiKey : '';
    let inner;
    try {
      inner = ask(model, context, options);
    } catch (error) {
      throw new Error(hidden(error instanceof Error ? error.message : String(error), key));
    }
    const outer = createAssistantMessageEventStream();
    (async () => {
      for await (const event of inner) {
        if (event.type === 'error') event.error.errorMessage = hidden(event.error.errorMessage ?? 'OpenRouter failed', key);
        outer.push(event);
      }
      const result = await inner.result();
      if (result.errorMessage !== undefined) result.errorMessage = hidden(result.errorMessage, key);
      outer.end(result);
    })().catch(error => {
      const failed = error instanceof Error ? error.message : String(error);
      outer.push({ type: 'error', reason: 'error', error: { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'error', errorMessage: hidden(failed, key), timestamp: Date.now() } });
      outer.end();
    });
    return outer;
  });
}

/**
 * @param {string} text
 * @param {string} key
 */
function hidden(text, key) {
  if (key === '') return text;
  return text.replaceAll(key, HIDDEN).replaceAll(JSON.stringify(key).slice(1, -1), HIDDEN);
}
