import { WORK_KINDS } from "./transport.js";
import type { AddressSettings } from "./transports/address.js";
import type { CloudflareModel } from "./transports/cloudflare.js";
import type { FakeOptions } from "./transports/fake.js";

export interface ModelSettings {
  cap: number;
  transports?: TransportSettings;
}

export interface TransportSettings {
  codex?: Narrowed;
  claude?: Narrowed;
  openrouter?: Narrowed;
  "openrouter-voice"?: Narrowed;
  cloudflare?: Narrowed & { models?: CloudflareModel[] };
  address?: Narrowed & AddressSettings;
  fake?: Narrowed & Omit<FakeOptions, "reply"> & { reply?: string };
}

interface Narrowed {
  concurrency?: number;
}

const MEMBERS: Record<keyof TransportSettings, readonly string[]> = {
  codex: ["concurrency"],
  claude: ["concurrency"],
  openrouter: ["concurrency"],
  "openrouter-voice": ["concurrency"],
  cloudflare: ["concurrency", "models"],
  address: ["concurrency", "url", "model", "kinds", "secret"],
  fake: ["concurrency", "provider", "leaves", "reply", "delay_ms", "cost_usd", "cost", "fail", "status", "unavailable", "reason", "until_ms", "offers", "log"],
};

export const OWN_BLOCKS: readonly string[] = Object.keys(MEMBERS).filter((name) => MEMBERS[name as keyof TransportSettings].some((member) => member !== "concurrency"));

export function readModelSettings(value: unknown): ModelSettings {
  const settings = object(value, "model");
  if (!positive(settings.cap)) throw new TypeError("model.cap is a positive number");
  if (settings.transports !== undefined) readTransportSettings(settings.transports);
  return settings as unknown as ModelSettings;
}

export function readTransportSettings(value: unknown): TransportSettings {
  for (const [name, block] of Object.entries(object(value, "model.transports"))) {
    const label = `model.transports.${name}`;
    const members = Object.hasOwn(MEMBERS, name) ? MEMBERS[name as keyof TransportSettings] : undefined;
    if (members === undefined) throw new TypeError(`${label}: no transport is named ${name}`);
    const each = object(block, label);
    const unknown = Object.keys(each).find((member) => !members.includes(member));
    if (unknown !== undefined) throw new TypeError(`${label}.${unknown}: ${name} takes no such member`);
    if (each.concurrency !== undefined && !(Number.isSafeInteger(each.concurrency) && positive(each.concurrency))) throw new TypeError(`${label}.concurrency is a positive whole number`);
    if (each.secret !== undefined && (typeof each.secret !== "string" || each.secret === "")) throw new TypeError(`${label}.secret names a secret`);
    if (name === "address") checkAddress(each, label);
    if (name === "cloudflare" && each.models !== undefined) checkCloudflareModels(each.models, `${label}.models`);
  }
  return value as TransportSettings;
}

function checkAddress(address: Record<string, unknown>, label: string): void {
  let url: URL | undefined;
  try { url = new URL(String(address.url)); } catch { url = undefined; }
  if (typeof address.url !== "string" || url === undefined || (url.protocol !== "http:" && url.protocol !== "https:")) throw new TypeError(`${label}.url is an http or https address`);
  if (url.username !== "" || url.password !== "" || url.search !== "") throw new TypeError(`${label}.url holds no user name, password or query: a key goes in its secret`);
  if (typeof address.model !== "string" || address.model === "") throw new TypeError(`${label}.model names the model it runs`);
  const kinds = address.kinds;
  if (!Array.isArray(kinds) || kinds.length === 0 || kinds.some((kind) => !(WORK_KINDS as readonly unknown[]).includes(kind))) {
    throw new TypeError(`${label}.kinds is a list of ${WORK_KINDS.join(", ")}`);
  }
  if (kinds.includes("audio")) throw new TypeError(`${label}.kinds: an address takes no audio`);
}

const CLOUDFLARE_MODEL = /^[a-z0-9][a-z0-9-]*\/[\x21-\x7e]+$/u;

function checkCloudflareModels(models: unknown, label: string): void {
  if (!Array.isArray(models) || models.length === 0) throw new TypeError(`${label} is a list of models`);
  for (const [index, entry] of models.entries()) {
    const each = object(entry, `${label}[${index}]`);
    const unknown = Object.keys(each).find((member) => !["model", "name", "kinds"].includes(member));
    if (unknown !== undefined) throw new TypeError(`${label}[${index}].${unknown}: a Cloudflare model takes no such member`);
    if (typeof each.model !== "string" || !CLOUDFLARE_MODEL.test(each.model)) throw new TypeError(`${label}[${index}].model names a model as provider/model, such as openai/gpt-6-luna`);
    if (each.name !== undefined && (typeof each.name !== "string" || each.name === "")) throw new TypeError(`${label}[${index}].name is a word`);
    const kinds = each.kinds;
    if (!Array.isArray(kinds) || kinds.length === 0 || kinds.some((kind) => kind !== "pictures" && kind !== "text")) {
      throw new TypeError(`${label}[${index}].kinds is a list of pictures, text`);
    }
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${label} is an object`);
  return value as Record<string, unknown>;
}

function positive(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
