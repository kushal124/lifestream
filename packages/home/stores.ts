import type { Connector, MacGrant, MacStore } from "@lifestreamprotocol/connect";
import { digest, isObject, type Json } from "@lifestreamprotocol/core";
import { refuse } from "./refusal.js";
import type { Raised, StoreState } from "./streams-report.js";
import type { Statement } from "./stated.js";
import { STORE_GRANT, storeWords, UNSAFE_LINE } from "./stream-words.js";
import type { ExchangeBodyAdds } from "./wire.js";

export const STORE_STATES: readonly StoreState[] = ["asked", "allowed", "refused", "unsafe"];

export type StoresStated = NonNullable<ExchangeBodyAdds["stores"]>;

export const storeGrant = (connector: string): string => `${STORE_GRANT}${connector}`;
export const isStoreGrant = (grant: unknown): boolean => typeof grant === "string" && grant.startsWith(STORE_GRANT);

export type StoreBlock = { app?: string; grants: readonly MacGrant[]; product: string; store: MacStore };

export function storeDigest(block: StoreBlock): string {
  return digest(block as unknown as Json);
}

export function declaredStores(connectors: readonly Connector[]): { stores: Record<string, StoreBlock>; digest: string } {
  const stores: Record<string, StoreBlock> = {};
  for (const connector of connectors) {
    const { id, mac } = connector;
    if (mac?.store !== undefined) {
      stores[id] = { ...(mac.app === undefined ? {} : { app: mac.app }), grants: [...mac.grants], product: macProduct(connector), store: mac.store };
    }
  }
  return { stores, digest: digest(stores as unknown as Json) };
}

function macProduct(connector: Connector): string {
  const source = connector.sources.find((each) => (typeof each.arrives === "string" ? [each.arrives] : each.arrives).includes("mac"));
  return source?.id.split(":")[0] ?? connector.product;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const CONNECTOR = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const MAX_STORES = 128;

export function storesIn(value: unknown): StoresStated | undefined {
  if (value === undefined) return undefined;
  const bad = (): never => refuse(422, "BAD_REQUEST", `stores states digest (sha256:<hex> or null) and states (per connector id, ${STORE_STATES.join(", ")})`);
  if (!isObject(value as Json)) return bad();
  const { digest: held, states, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || !(held === null || (typeof held === "string" && DIGEST.test(held))) || !isObject(states as Json)) return bad();
  const each = Object.entries(states as Record<string, unknown>);
  if (each.length > MAX_STORES || each.some(([id, state]) => !CONNECTOR.test(id) || !(STORE_STATES as readonly unknown[]).includes(state))) return bad();
  return { digest: held as string | null, states: Object.fromEntries(each) as Record<string, StoreState> };
}

export function storeStateOf(statement: Pick<Statement, "stores"> | undefined, connector: string): StoreState | null {
  return statement?.stores?.states[connector] ?? null;
}

export function storeNeeds(connector: Connector, name: string, macs: readonly { unit: string; own: Statement }[], off: (unit: string) => boolean,
  nameOf: (unit: string) => string): Raised[] {
  if (connector.mac?.store === undefined) return [];
  return macs.flatMap(({ unit, own }): Raised[] => {
    const state = storeStateOf(own, connector.id);
    if (state === null || state === "allowed" || off(unit)) return [];
    const grant = storeGrant(connector.id);
    const base = { connector: connector.id, copy: null, unit, since_ms: null, next_ms: null, detail: null, at: null };
    if (state === "unsafe") {
      return [{ ...base, id: `store:${connector.id}:${unit}`, state: "broken", reason: "failing", acts: [],
        words: storeWords(name, nameOf(unit), true), line: UNSAFE_LINE }];
    }
    return [{ ...base, id: `grant:${grant}:${unit}`, streams: [connector.id], state: "needs-you", reason: "grant",
      words: storeWords(name, nameOf(unit), false), acts: [{ do: "grant", label: "Allow", unit, grant }] }];
  });
}

export function knownStoresSwift(connectors: readonly Connector[]): string {
  const lines = Object.entries(declaredStores(connectors).stores).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, block]) => `        ${JSON.stringify(id)}: ${JSON.stringify(storeDigest(block))},`);
  return [
    "public enum KnownStores {",
    lines.length === 0 ? "    public static let digests: [String: String] = [:]" : `    public static let digests: [String: String] = [\n${lines.join("\n")}\n    ]`,
    "}",
    "",
  ].join("\n");
}
