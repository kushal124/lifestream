import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readModelSettings } from "../settings.js";
import { SendFailed, type SendRequest } from "../transport.js";
import { CLOUDFLARE_MODELS, cloudflareEndpoint, cloudflareKey, cloudflareTransport } from "./cloudflare.js";
import { configured, priced, transportOf, transportSecret } from "./index.js";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "synthetic-cloudflare-token_0001";
const HELD = `${ACCOUNT}:${TOKEN}`;
const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const request = (model: string, extra: Partial<SendRequest> = {}): SendRequest =>
  ({ model, effort: "none", sampling: { temperature: 0 }, input: "a synthetic note", signal: new AbortController().signal, ...extra });

function recorded(reply: () => Response = () => Response.json({ choices: [{ message: { content: "a synthetic answer" } }], usage: { prompt_tokens: 7, completion_tokens: 3, cost: 0.5 } })) {
  const posts: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    posts.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return reply();
  }) as typeof fetch;
  return { posts, fetcher };
}

describe("cloudflare transport", () => {
  it("posts to the account's unified endpoint with the token, and asks Cloudflare to keep no log body and no cache", async () => {
    const { posts, fetcher } = recorded();
    const transport = cloudflareTransport({ held: () => true, key: () => HELD, fetch: fetcher });
    const sent = await transport.send(request("openai/gpt-6-luna"), []);
    expect(sent).toEqual({ text: "a synthetic answer", model: "openai/gpt-6-luna", input_tokens: 7, output_tokens: 3 });
    expect(posts).toHaveLength(1);
    const [post] = posts;
    expect(post!.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/v1/chat/completions`);
    expect(post!.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, "cf-aig-collect-log-payload": "false", "cf-aig-skip-cache": "true" });
    expect(post!.headers).not.toHaveProperty("cf-aig-gateway-id");
    expect(post!.body).toEqual({ model: "openai/gpt-6-luna", temperature: 0, messages: [{ role: "user", content: [{ type: "text", text: "a synthetic note" }] }] });
  });

  it("names the default gateway for a Workers AI model", async () => {
    const { posts, fetcher } = recorded();
    await cloudflareTransport({ held: () => true, key: () => HELD, fetch: fetcher }).send(request("workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast"), []);
    expect(posts[0]!.headers).toMatchObject({ "cf-aig-gateway-id": "default" });
  });

  it("sends a picture as a data URL and refuses audio", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lifestream-cloudflare-"));
    scratch.push(dir);
    const photo = join(dir, "photo.jpg");
    writeFileSync(photo, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    const { posts, fetcher } = recorded();
    const transport = cloudflareTransport({ held: () => true, key: () => HELD, fetch: fetcher });
    await transport.send(request("google-ai-studio/gemini-3.8-flash"), [{ path: photo, media_type: "image/jpeg" }]);
    const content = (posts[0]!.body.messages as { content: unknown[] }[])[0]!.content;
    expect(content[0]).toEqual({ type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/AA==" } });
    await expect(transport.send(request("google-ai-studio/gemini-3.8-flash"), [{ path: photo, media_type: "audio/mp4" }])).rejects.toThrow(/images only/u);
    expect(posts).toHaveLength(1);
  });

  it("sends nothing without a whole key, and says so", async () => {
    const { posts, fetcher } = recorded();
    for (const key of [undefined, "", TOKEN, `not-an-account:${TOKEN}`, `${ACCOUNT}:`, `${ACCOUNT}:two words`]) {
      const transport = cloudflareTransport({ held: () => key !== undefined, key: () => key, fetch: fetcher });
      await expect(transport.send(request("openai/gpt-6-luna"), [])).rejects.toBeInstanceOf(SendFailed);
    }
    expect(posts).toHaveLength(0);
    expect(await cloudflareTransport({ held: () => false, key: () => undefined }).available()).toMatchObject({ ok: false, reason: "no_key" });
  });

  it("keeps the token out of a failure's words", async () => {
    const { fetcher } = recorded(() => { throw new Error(`refused for ${TOKEN}`); });
    const failed = await cloudflareTransport({ held: () => true, key: () => HELD, fetch: fetcher }).send(request("openai/gpt-6-luna"), []).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(SendFailed);
    expect(String((failed as Error).message)).not.toContain(TOKEN);
    expect(JSON.stringify(failed)).not.toContain(TOKEN);
  });

  it("is priced, leaves for Cloudflare, and offers its default models or the ones set", async () => {
    const transport = cloudflareTransport({ held: () => true, key: () => HELD });
    expect([transport.name, transport.provider, transport.cost, transport.leaves]).toEqual(["cloudflare", "Cloudflare", "priced", "Cloudflare"]);
    expect((await transport.offers()).map((offer) => offer.model)).toEqual(CLOUDFLARE_MODELS.map((each) => each.model));
    const set = cloudflareTransport({ held: () => true, key: () => HELD, models: [{ model: "anthropic/claude-haiku-5-5", kinds: ["text"] }] });
    expect(await set.offers()).toEqual([{ model: "anthropic/claude-haiku-5-5", name: "anthropic/claude-haiku-5-5", kinds: ["text"], text_chars: null, ready: true }]);
  });

  it("reads its key as account:token and builds its address only from a real account ID", () => {
    expect(cloudflareKey(HELD)).toEqual({ account: ACCOUNT, token: TOKEN });
    expect(cloudflareKey(`${ACCOUNT.toUpperCase()}:${TOKEN}`)).toBeNull();
    expect(() => cloudflareEndpoint("../../evil")).toThrow(TypeError);
    expect(() => cloudflareEndpoint(`${ACCOUNT}/x`)).toThrow(TypeError);
  });

  it("is a configured, priced transport with its own sealed secret, and takes its models from settings", async () => {
    expect(configured({})).toContain("cloudflare");
    expect(priced({})).toContain("cloudflare");
    expect(transportSecret("cloudflare", {})).toBe("cloudflare");
    const settings = readModelSettings({ cap: 1, transports: { cloudflare: { models: [{ model: "workers-ai/@cf/qwen/qwen3.8-27b", name: "Qwen", kinds: ["pictures", "text"] }] } } });
    const transport = transportOf("cloudflare", settings.transports, { held: (name) => name === "cloudflare", secret: (name) => (name === "cloudflare" ? HELD : undefined) });
    expect(await transport.available()).toEqual({ ok: true });
    expect((await transport.offers()).map((offer) => [offer.model, offer.name])).toEqual([["workers-ai/@cf/qwen/qwen3.8-27b", "Qwen"]]);
  });

  it("refuses settings it cannot use", () => {
    const refused = (models: unknown) => () => readModelSettings({ cap: 1, transports: { cloudflare: { models } } });
    expect(refused([])).toThrow(/list of models/u);
    expect(refused([{ model: "no-provider", kinds: ["text"] }])).toThrow(/provider\/model/u);
    expect(refused([{ model: "openai/gpt-6-luna", kinds: ["audio"] }])).toThrow(/pictures, text/u);
    expect(refused([{ model: "openai/gpt-6-luna", kinds: ["text"], url: "https://elsewhere.example" }])).toThrow(/no such member/u);
    expect(() => readModelSettings({ cap: 1, transports: { cloudflare: { account: ACCOUNT } } })).toThrow(/no such member/u);
  });
});
