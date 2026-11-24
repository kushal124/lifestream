import { addressFault, valueAt, wholeAddress, type Connector } from "@lifestreamprotocol/connect";
import type { Json } from "@lifestreamprotocol/core";
import type { Open } from "./wire.js";

type Values = Readonly<Partial<Record<"account" | "key" | "chat", string | null>>> & { readonly content?: Json | undefined };

const CONTENT = "content.";

export function recordOpen(connector: Connector | undefined, kind: string, values: { account: string | null; key: string; content?: Json | undefined }): Open | null {
  const record = connector?.open?.record;
  if (connector === undefined || record === undefined || !record.kinds.includes(kind)) return null;
  return opened(connector, record.url, values);
}

export function chatOpen(connector: Connector | undefined, chat: string, group: boolean): Open | null {
  const template = connector?.open?.chat;
  if (connector === undefined || template === undefined || group) return null;
  return opened(connector, template.url, { chat });
}

function opened(connector: Connector, template: string, values: Values): Open | null {
  const href = filled(template, values);
  return href === null ? null : { label: `Open in ${connector.name}`, href };
}

export function filled(template: string, values: Values): string | null {
  const whole = wholeAddress(template);
  let missing = false;
  const href = template.replace(/\{([^}|]*)(?:\|([^}]*))?\}/gu, (_, name: string, filter: string | undefined) => {
    const value = filtered(valueOf(values, name), filter);
    if (value === null || value === "") missing = true;
    return whole ? value ?? "" : encodeURIComponent(value ?? "");
  });
  return missing || addressFault(href) !== null ? null : new URL(href).href;
}

function valueOf(values: Values, name: string): string | null {
  if (!name.startsWith(CONTENT)) return values[name as "account" | "key" | "chat"] ?? null;
  const stated = valueAt(values.content, name.slice(CONTENT.length));
  return typeof stated === "string" ? stated : typeof stated === "number" && Number.isFinite(stated) ? String(stated) : null;
}

function filtered(value: string | null, filter: string | undefined): string | null {
  if (value === null || filter === undefined) return value;
  if (filter === "hex") return /^\d+$/u.test(value) ? BigInt(value).toString(16) : null;
  const needle = filter.slice(filter.indexOf(":") + 1);
  const at = value.indexOf(needle);
  if (filter.startsWith("before:")) return at < 0 ? value : value.slice(0, at);
  if (filter.startsWith("after:")) return at < 0 ? value : value.slice(at + needle.length);
  return null;
}
