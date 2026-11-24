import type { Adapters, Registered } from "@lifestreamprotocol/core";
import { providers } from "../index.js";

export function registered<K extends keyof Adapters>(family: K): Registered<NonNullable<Adapters[K]>>[] {
  const found: Registered<NonNullable<Adapters[K]>>[] = [];
  for (const provider of providers()) {
    for (const [id, adapters] of Object.entries((provider as { adapters?: Readonly<Record<string, Adapters>> }).adapters ?? {})) {
      const connector = provider.connectors.find((declared) => declared.id === id);
      const adapter = adapters[family];
      if (connector === undefined || adapter === undefined) continue;
      for (const product of [connector.product, ...Object.keys(connector.products ?? {})]) found.push({ product, adapter: adapter as NonNullable<Adapters[K]> });
    }
  }
  return found.sort((left, right) => (left.product < right.product ? -1 : left.product > right.product ? 1 : 0));
}
