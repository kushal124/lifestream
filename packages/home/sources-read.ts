import { selects, type Adapters, type SourceRow } from "@lifestreamprotocol/core";
import type { Family } from "@lifestreamprotocol/families";
import { catalogOf } from "./catalog.js";
import type { Registry } from "./registry.js";

export type HeldAdapters = { readonly adapters?: Readonly<Record<string, Adapters>> };

export function readsSource(family: Pick<Family, "inputs">, row: SourceRow): boolean {
  return family.inputs.some((input) => input.role === "evidence" && selects(input.sources, row));
}

export function ownerOf(registry: (Pick<Registry, "connectors"> & HeldAdapters) | undefined): (row: SourceRow) => boolean {
  if (registry?.adapters === undefined) return () => false;
  const { adapters } = registry;
  const catalog = catalogOf(registry.connectors);
  return (row) => {
    const connector = catalog.of(row);
    return connector !== undefined && Object.values(adapters[connector.id] ?? {}).some((adapter) => (adapter as { owner?: string }).owner === "account");
  };
}
