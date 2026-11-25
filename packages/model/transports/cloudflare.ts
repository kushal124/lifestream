import { readFileSync } from "node:fs";
import { SendFailed, type Offer, type Transport, type WorkKind } from "../transport.js";
import { complete } from "./completions.js";

export const CLOUDFLARE_SECRET = "cloudflare";
export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4/accounts";
export const ACCOUNT = /^[0-9a-f]{32}$/u;
const HELD = /^([0-9a-f]{32}):([\x21-\x7e]+)$/u;

export const CLOUDFLARE_HEADERS: Readonly<Record<string, string>> = {
  "cf-aig-collect-log-payload": "false",
  "cf-aig-skip-cache": "true",
};

export interface CloudflareModel {
  model: string;
  name?: string;
  kinds: readonly WorkKind[];
}

export const CLOUDFLARE_MODELS: readonly CloudflareModel[] = [
  { model: "google-ai-studio/gemini-3.8-flash", name: "Gemini 3.8 Flash", kinds: ["pictures", "text"] },
  { model: "openai/gpt-6-luna", name: "GPT-6 Luna", kinds: ["text"] },
];

export interface CloudflareKey {
  account: string;
  token: string;
}

export function cloudflareKey(value: string | undefined): CloudflareKey | null {
  const match = value === undefined ? null : HELD.exec(value);
  return match === null ? null : { account: match[1]!, token: match[2]! };
}

export function cloudflareEndpoint(account: string): string {
  if (!ACCOUNT.test(account)) throw new TypeError("a Cloudflare account ID is 32 hexadecimal characters");
  return `${CLOUDFLARE_API}/${account}/ai/v1/chat/completions`;
}

export interface CloudflareOptions {
  held: () => boolean;
  key: () => string | undefined;
  models?: readonly CloudflareModel[];
  fetch?: typeof fetch;
}

export function cloudflareTransport(options: CloudflareOptions): Transport {
  const fetcher = options.fetch ?? fetch;
  const models = options.models === undefined || options.models.length === 0 ? CLOUDFLARE_MODELS : options.models;
  const offers: Offer[] = models.map((each) => ({ model: each.model, name: each.name ?? each.model, kinds: each.kinds, text_chars: null, ready: true }));
  return {
    name: "cloudflare",
    provider: "Cloudflare",
    cost: "priced",
    leaves: "Cloudflare",
    defaults: { effort: "none", sampling: { temperature: 0 }, timeout_ms: 120_000, concurrency: 4 },
    offers: async () => offers.map((offer) => ({ ...offer })),
    async available() {
      return options.held() ? { ok: true } : { ok: false, reason: "no_key", detail: "cloudflare has no account ID and API token" };
    },
    async send(request, attachments) {
      const key = cloudflareKey(options.key());
      if (key === null) throw new SendFailed("cloudflare", "cloudflare has no account ID and API token", null);
      const refused = attachments.find((file) => !file.media_type.startsWith("image/"));
      if (refused !== undefined) throw new Error(`cloudflare takes images only, not ${refused.media_type}`);
      try {
        const answer = await complete({
          transport: "cloudflare", endpoint: cloudflareEndpoint(key.account), fetch: fetcher, signal: request.signal,
          headers: {
            Authorization: `Bearer ${key.token}`,
            ...CLOUDFLARE_HEADERS,
            ...(request.model.startsWith("workers-ai/") ? { "cf-aig-gateway-id": "default" } : {}),
          },
          body: {
            model: request.model,
            ...(request.sampling === undefined ? {} : { temperature: request.sampling.temperature }),
            ...(request.sampling?.seed === undefined ? {} : { seed: request.sampling.seed }),
            ...(request.effort === "none" ? {} : { reasoning_effort: request.effort }),
            messages: [{
              role: "user",
              content: [
                ...attachments.map((file) => ({ type: "image_url", image_url: { url: `data:${file.media_type};base64,${readFileSync(file.path).toString("base64")}` } })),
                { type: "text", text: request.input },
              ],
            }],
          },
        });
        const { cost: _unpriced, ...rest } = answer;
        return { ...rest, model: request.model };
      } catch (error) {
        throw hiddenIn(error, key.token);
      }
    },
  };
}

function hiddenIn(error: unknown, token: string): unknown {
  if (error instanceof Error && error.message.includes(token)) error.message = error.message.replaceAll(token, "[the Cloudflare token]");
  return error;
}
