// @ts-check
import { createProvider } from '@earendil-works/pi-ai/models';
import { cloudflareAIGatewayProvider } from '@earendil-works/pi-ai/providers/cloudflare-ai-gateway';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';


export const CLOUDFLARE = { provider: 'cloudflare-ai-gateway', modelId: 'claude-sonnet-5-5' };
export const CLOUDFLARE_KEY_ROUTE = '/v1/secrets/cloudflare';
export const GATEWAY = 'default';
export const NO_LOGS = /** @type {const} */ ({ 'cf-aig-collect-log-payload': 'false', 'cf-aig-skip-cache': 'true' });
const HELD = /^([0-9a-f]{32}):([\x21-\x7e]+)$/u;
const HIDDEN = '[the Cloudflare token]';

/**
 * @param {string | undefined} value
 * @returns {{ account: string, token: string } | null}
 */
export function cloudflareKey(value) {
  const match = value === undefined ? null : HELD.exec(value);
  return match === null ? null : { account: /** @type {string} */ (match[1]), token: /** @type {string} */ (match[2]) };
}

export function cloudflareProvider() {
  const pi = cloudflareAIGatewayProvider();
  /** @type {Set<string>} */
  const tokens = new Set();
  return createProvider({
    id: CLOUDFLARE.provider, name: 'Cloudflare', baseUrl: pi.baseUrl,
    auth: {
      apiKey: {
        name: 'Cloudflare account ID and API token',
        resolve: async ({ credential }) => {
          const key = cloudflareKey(credential?.key);
          if (key === null) return undefined;
          tokens.add(key.token);
          return {
            auth: { headers: { 'cf-aig-authorization': `Bearer ${key.token}`, Authorization: null, 'x-api-key': null, ...NO_LOGS } },
            env: { CLOUDFLARE_ACCOUNT_ID: key.account, CLOUDFLARE_GATEWAY_ID: GATEWAY },
            source: 'the home\'s key',
          };
        },
      },
    },
    models: [...pi.getModels()],
    api: { stream: hiding(pi.stream.bind(pi), tokens), streamSimple: hiding(pi.streamSimple.bind(pi), tokens) },
  });
}

/**
 * @template {(model: any, context: any, options?: any) => import('@earendil-works/pi-ai').AssistantMessageEventStream} Stream
 * @param {Stream} ask
 * @param {Set<string>} tokens
 * @returns {Stream}
 */
function hiding(ask, tokens) {
  return /** @type {Stream} */ ((model, context, options) => {
    let inner;
    try {
      inner = ask(model, context, options);
    } catch (error) {
      throw new Error(hidden(error instanceof Error ? error.message : String(error), tokens));
    }
    const outer = createAssistantMessageEventStream();
    (async () => {
      for await (const event of inner) {
        if (event.type === 'error') event.error.errorMessage = hidden(event.error.errorMessage ?? 'Cloudflare failed', tokens);
        outer.push(event);
      }
      const result = await inner.result();
      if (result.errorMessage !== undefined) result.errorMessage = hidden(result.errorMessage, tokens);
      outer.end(result);
    })().catch(error => {
      const failed = error instanceof Error ? error.message : String(error);
      outer.push({ type: 'error', reason: 'error', error: { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'error', errorMessage: hidden(failed, tokens), timestamp: Date.now() } });
      outer.end();
    });
    return outer;
  });
}

/**
 * @param {string} text
 * @param {Set<string>} tokens
 */
export function hidden(text, tokens) {
  let said = text;
  for (const token of tokens) said = said.replaceAll(token, HIDDEN).replaceAll(JSON.stringify(token).slice(1, -1), HIDDEN);
  return said;
}
