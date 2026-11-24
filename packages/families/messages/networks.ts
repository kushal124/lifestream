import { handleFrom, handleOf, type Handle, type MessageParty, type MessagesAdapter } from "@lifestreamprotocol/core";
import type { Family, Given, Labels } from "../family.js";

export interface Networks {
  readonly products: readonly string[];
  of(network: string): MessagesAdapter | undefined;
  name(network: string): string | undefined;
}

export function networksOf(given: readonly Given<MessagesAdapter>[]): Networks {
  const byProduct = new Map(given.map((each) => [each.product, each]));
  const products = [...byProduct.keys()].sort();
  return { products, of: (network) => byProduct.get(network)?.adapter, name: (network) => byProduct.get(network)?.name };
}

export function networksIn(families: readonly Pick<Family, "name" | "adapters">[]): Networks {
  const family = families.find((each) => each.name === "messages");
  return networksOf((family?.adapters ?? []) as readonly Given<MessagesAdapter>[]);
}

export function isGroupChat(networks: Networks, network: string, chat: string): boolean {
  return networks.of(network)?.group(chat) === true;
}

export function chatMembers(networks: Networks, network: string, chat: string): readonly MessageParty[] {
  return networks.of(network)?.members(chat) ?? [];
}

export function resolveChat(networks: Networks, network: string, chat: string, labels: Labels): string {
  const adapter = networks.of(network);
  if (adapter?.shown === undefined) return chat;
  return adapter.shown(chat, () => labels.provider?.(chat)?.aliases ?? []);
}

export function partyHandle(network: string, party: MessageParty): Handle | null {
  if (party.kind === "me" || party.kind === "system") return null;
  if (party.kind !== "network") return handleOf(party.id);
  return handleFrom("network", `${network}:${party.id}`) ?? handleOf(party.id);
}

export function partyWho(network: string, party: MessageParty): string | Handle | null {
  if (party.kind === "me" || party.kind === "system") return null;
  return party.kind === "network" ? partyHandle(network, party) : party.id;
}

export function labelWho(networks: Networks, network: string, id: string): string | Handle | null {
  const adapter = networks.of(network);
  if (adapter === undefined) return null;
  if (adapter.labels?.ids === "jid" || adapter.labelId !== undefined) return id;
  return adapter.group(id) ? null : partyWho(network, { id, kind: "network" });
}

export function labelIdOf(networks: Networks, network: string, handle: Handle): string | null {
  const adapter = networks.of(network);
  if (adapter === undefined) return null;
  if (adapter.labelId !== undefined) return adapter.labelId(handle);
  return handle.kind === "network" && handle.value.startsWith(`${network}:`) ? handle.value.slice(network.length + 1) : null;
}

export function providerUnit(networks: Networks, network: string, id: string): string {
  return networks.of(network)?.labels?.ids === "jid" ? `jid:${id}` : `${network}:${id}`;
}

export function providerHandle(networks: Networks, unit: string): Handle | null {
  const colon = unit.indexOf(":");
  const [network, id] = [unit.slice(0, colon), unit.slice(colon + 1)];
  const adapter = network === "jid" ? undefined : networks.of(network);
  if (adapter === undefined || adapter.group(id) || adapter.labelId !== undefined) return handleOf(id);
  return handleFrom("network", unit);
}
