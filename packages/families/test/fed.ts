import { providers } from "@lifestreamprotocol/connect";
import type { Adapter, Adapters, MoneyAdapter } from "@lifestreamprotocol/core";
import { fedNone, type Fed, type Given } from "../family.js";
import { ownProducts, type Networked } from "../shared/labels.js";

function released(): Fed {
  const fed = fedNone() as unknown as Record<keyof Adapters, Given[]>;
  for (const provider of providers() as readonly (ReturnType<typeof providers>[number] & { adapters?: Readonly<Record<string, Adapters>> })[]) {
    for (const [id, adapters] of Object.entries(provider.adapters ?? {})) {
      const connector = provider.connectors.find((declared) => declared.id === id)!;
      const products = [[connector.product, connector], ...Object.entries(connector.products ?? {})] as const;
      for (const [family, adapter] of Object.entries(adapters) as [keyof Adapters, Adapter][]) {
        for (const [product, { name, vendor }] of products) fed[family].push({ product, name, vendor, type: connector.type ?? null, adapter });
      }
    }
  }
  for (const list of Object.values(fed)) list.sort((left, right) => (left.product < right.product ? -1 : left.product > right.product ? 1 : 0));
  return fed as unknown as Fed;
}

export const FED = released();

export const NETWORKED: Networked = { messages: FED.messages, own: ownProducts([...FED.messages, ...FED.mail]) };

export const PROOF_BANK: readonly Given<MoneyAdapter>[] = [{ product: "example-bank", name: "Example Bank", vendor: "example", type: "money", adapter: { version: "1", kinds: ["txn"] } }];
