import type { Labels, NameSpan, PersonLabel } from "../family.js";
import { partyHandle, type Networks } from "../messages/networks.js";
import {
  canonicalEmail, canonicalJid, canonicalPhone, handleId, handleOf, isPhoneShaped, type PartyKind,
} from "@lifestreamprotocol/core";

export const ME = "the user";
export const THE_GROUP = "the group";

export interface Party {
  id: string;
  kind: PartyKind;
  network?: string;
  aliases?: string[];
  provider?: string | null;
  pushName?: string | null;
}

export type NamedBy = "me" | "system" | "registry" | "contact" | "provider" | "push-name" | "none";

export interface Named {
  name: string;
  by: NamedBy;
  person: string | null;
  who: string | null;
}

export interface Printed {
  text: string;
  names: NameSpan[];
}

export type Printable = string | number | Named | Printed;

export function printed(strings: TemplateStringsArray, ...parts: readonly Printable[]): Printed {
  const out: Printed = { text: strings[0]!, names: [] };
  parts.forEach((part, index) => {
    put(out, part);
    out.text += strings[index + 1]!;
  });
  return out;
}

export function joined(parts: readonly Printable[], separator: string): Printed {
  const out: Printed = { text: "", names: [] };
  parts.forEach((part, index) => {
    if (index > 0) out.text += separator;
    put(out, part);
  });
  return out;
}

function put(out: Printed, part: Printable): void {
  const at = out.text.length;
  if (typeof part === "string" || typeof part === "number") {
    out.text += String(part);
  } else if ("by" in part) {
    out.text += part.name;
    const start = at + part.name.length - part.name.trimStart().length;
    const end = at + part.name.trimEnd().length;
    if (part.who !== null && end > start) out.names.push({ start, end, who: part.who });
  } else {
    out.text += part.text;
    for (const name of part.names) out.names.push({ start: name.start + at, end: name.end + at, who: name.who });
  }
}

export function isName(text: string): boolean {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  return letters > 0 && !text.includes("@") && (text.match(/\p{N}/gu)?.length ?? 0) <= letters;
}

export function nameParty(party: Party, labels: Labels): Named {
  if (party.kind === "me") return { name: ME, by: "me", person: null, who: null };
  if (party.kind === "system") return { name: THE_GROUP, by: "system", person: null, who: null };
  let unnamed: PersonLabel | undefined;
  const ids = [party.id, ...(party.aliases ?? [])];
  for (const id of party.kind !== "network" ? ids : party.network === undefined ? [] : ids.map((each) => `${party.network}:${each}`)) {
    const label = labels.person(id);
    if (label?.me === true) return { name: ME, by: "me", person: null, who: null };
    if (label !== undefined && label.by !== "none") return { name: label.name, by: label.by, person: label.slug, who: whoOf(id, label.name, label) };
    unnamed ??= label;
  }
  const person = unnamed?.slug ?? null;
  const provider = party.provider?.trim();
  if (provider !== undefined && provider.length > 0 && !isPhoneShaped(provider)) return { name: provider, by: "provider", person, who: whoOf(party.id, provider, unnamed, party.network) };
  const pushName = party.pushName?.trim();
  if (pushName !== undefined && pushName.length > 0) return { name: pushName, by: "push-name", person, who: whoOf(party.id, pushName, unnamed, party.network) };
  return { name: unnamed?.name ?? unknownName(party.id), by: "none", person, who: null };
}

export function whoOf(id: string, name: string, label?: PersonLabel, network?: string): string | null {
  if (!isName(name)) return null;
  if (label !== undefined) return label.id;
  const handle = network === undefined ? handleOf(id) : partyHandle(network, { id, kind: "network" });
  return handle === null ? id : handleId(handle);
}

export function idKind(id: string): Party["kind"] {
  if (canonicalJid(id) !== null) return "jid";
  if (canonicalPhone(id) !== null) return "phone";
  if (canonicalEmail(id) !== null) return "email";
  return "raw";
}

export function nameId(id: string, labels: Labels, kind: Party["kind"] = idKind(id), network?: string): Named {
  const provider = kind === "jid" ? labels.provider?.(id) : kind === "network" && network !== undefined ? labels.provider?.(id, network) : undefined;
  return nameParty({
    id, kind, ...(kind === "network" && network !== undefined ? { network } : {}),
    ...(provider?.aliases === undefined ? {} : { aliases: provider.aliases }),
    ...(provider?.name === undefined ? {} : { provider: provider.name }),
    ...(provider?.pushName === undefined ? {} : { pushName: provider.pushName }),
  }, labels);
}

export function unknownName(id: string): string {
  const jid = canonicalJid(id);
  if (jid === null) return id;
  const [digits, domain] = jid.split("@") as [string, string];
  return `unknown ${domain === "lid" ? "lid " : ""}…${digits.slice(-5)}`;
}

export function chatName(networks: Networks, product: string, chat: string, labels: Labels, writers: readonly Named[] = []): Printed {
  const network = networks.of(product);
  if (network === undefined) return { text: chat, names: [] };
  const group = network.group(chat);
  const members = network.members(chat);
  const others = members.length > 0 ? members.map((party) => nameId(party.id, labels, party.kind, product)) : writers;
  const name = group ? labels.provider?.(chat, network.labels?.ids === "jid" ? undefined : product)?.name ?? null : null;
  return chatTitle({ id: chat, group, name }, others);
}

export function chatTitle(chat: { id: string; group: boolean; name?: string | null }, others: readonly Named[]): Printed {
  const name = chat.name?.trim();
  if (chat.group && name !== undefined && name.length > 0) return { text: name, names: [] };
  const seen = new Set<string>([ME]);
  const names: Named[] = [];
  for (const other of others) {
    if (seen.has(other.name)) continue;
    seen.add(other.name);
    names.push(other);
  }
  if (names.length > 0) return joined(names, ", ");
  return { text: !chat.group && others.length > 0 ? ME : chat.id, names: [] };
}
