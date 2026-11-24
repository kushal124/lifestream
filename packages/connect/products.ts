import { digest, notAProduct, sourceName, type JsonObject, type Type } from "@lifestreamprotocol/core";
import { connectorIcon, type Connector } from "./declaration.js";

export interface Product {
  name: string;
  row: string;
  vendor: string;
  icon: string | null;
  type: Type | null;
  connector: string;
  records: string;
}

export interface Products {
  readonly digest: string;
  readonly products: Readonly<Record<string, Product>>;
}

const made = new WeakMap<readonly Connector[], Products>();

export function productsOf(connectors: readonly Connector[]): Products {
  let products = made.get(connectors);
  if (products !== undefined) return products;
  const found = new Map<string, Product>();
  for (const connector of connectors) {
    const icon = connector.icon !== undefined || connector.type !== undefined ? connectorIcon(connector) : null;
    const kind = { icon, type: connector.type ?? null, connector: connector.id, records: connector.records };
    if (!found.has(connector.product)) found.set(connector.product, { name: connector.name, row: connector.row ?? connector.name, vendor: connector.vendor, ...kind });
    for (const [product, { name, vendor }] of Object.entries(connector.products ?? {})) {
      if (!found.has(product)) found.set(product, { name, row: name, vendor, ...kind });
    }
  }
  const sorted = Object.fromEntries([...found].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  products = { digest: digest(sorted as unknown as JsonObject), products: sorted };
  made.set(connectors, products);
  return products;
}

export function productName(connectors: readonly Connector[], product: string): string {
  return productsOf(connectors).products[product]?.name ?? product;
}

export function isLibrary(connectors: readonly Connector[], source: string): boolean {
  let product: string;
  try {
    product = sourceName(source).product;
  } catch {
    return false;
  }
  const declarer = productsOf(connectors).products[product]?.connector;
  const connector = connectors.find((each) => each.id === declarer);
  return connector?.phone?.library === true || connector?.mac?.library === true;
}

export function vendorOf(connectors: readonly Connector[], source: string): string {
  const { product } = sourceName(source);
  const known = productsOf(connectors).products[product];
  if (known === undefined) throw notAProduct(source);
  return known.vendor;
}
