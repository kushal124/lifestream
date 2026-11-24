import { roadsOf, type Accounts, type Acquirer, type Connector, type DeclaredSource, type Road } from "@lifestreamprotocol/connect";
import { sourceName, SourceNameError, type JsonObject, type SourceRow } from "@lifestreamprotocol/core";

export interface Held {
  id: string;
  connector?: string;
  options?: JsonObject;
}

export interface Catalog {
  ofAcquirer(name: string): Connector | undefined;
  readonly twice: ReadonlyMap<string, readonly Connector[]>;
  of(source: Held): Connector | undefined;
  delivered(road: Road, id: string): Connector | undefined;
}

const catalogs = new WeakMap<readonly Connector[], Catalog>();

export function catalogOf(connectors: readonly Connector[]): Catalog {
  let catalog = catalogs.get(connectors);
  if (catalog === undefined) catalogs.set(connectors, catalog = build(connectors));
  return catalog;
}

function build(connectors: readonly Connector[]): Catalog {
  const declaring = new Map<string, Connector[]>();
  const reading = new Map<string, Connector[]>();
  for (const connector of connectors) {
    for (const acquirer of connector.acquirers ?? []) declaring.set(acquirer, [...declaring.get(acquirer) ?? [], connector]);
    for (const source of connector.sources) {
      for (const name of [source.read, ...source.feeders ?? []]) {
        const named = reading.get(name) ?? [];
        if (!named.includes(connector)) reading.set(name, [...named, connector]);
      }
    }
  }
  const patterns = connectors.flatMap((connector) => connector.sources.map((source) => ({ connector, source })))
    .sort((a, b) => Number(a.source.id.startsWith("<")) - Number(b.source.id.startsWith("<")));
  const byPattern = (id: string, road?: Road): Connector | undefined =>
    patterns.find(({ source }) => (road === undefined || roadsOf(source).includes(road)) && copyOf(source.id, id))?.connector;
  return {
    ofAcquirer: (name) => declaring.get(name)?.[0],
    twice: new Map([...declaring].filter(([, named]) => named.length > 1)),
    of(source) {
      if (source.connector === undefined) return byPattern(source.id);
      const named = reading.get(source.connector) ?? [];
      if (named.length === 1) return named[0];
      const lane = source.options?.lane;
      return (typeof lane === "string" ? declaring.get(lane)?.[0] : undefined) ?? named[0] ?? byPattern(source.id);
    },
    delivered: (road, id) => byPattern(id, road),
  };
}

export function copyOf(pattern: string, id: string): boolean {
  const parts = partsOf(id);
  if (parts === null) return false;
  const [product = "", account = "", copy = ""] = pattern.split(":");
  const fits = (declared: string, held: string) => declared.startsWith("<") || declared === held;
  return fits(product, parts.product) && fits(account, parts.account) && fits(copy, parts.copy);
}

export function declaredOf(connector: Connector, row: { connector: string; options: JsonObject }): DeclaredSource {
  const reading = connector.sources.filter((source) => source.read === row.connector || source.feeders?.includes(row.connector) === true);
  const named = reading.length > 0 ? reading : connector.sources;
  const uploaded = typeof row.options.lane === "string" && row.options.lane.startsWith("upload:");
  return named.find((source) => roadsOf(source).includes("upload") === uploaded) ?? named[0]!;
}

export interface Switch {
  source(source: Held): boolean;
  unit(unit: string): boolean;
  poll(acquirer: Pick<Acquirer, "name" | "source">, sources: readonly SourceRow[], fedBy: (lane: string) => readonly string[]): boolean;
}

export function switchOf(connectors: readonly Connector[], off: readonly string[]): Switch {
  const ids = new Set(off);
  const catalog = catalogOf(connectors);
  const source = (held: Held): boolean => {
    if (ids.size === 0) return false;
    if (ids.has(held.id) || ids.has(partsOf(held.id)?.copy ?? "")) return true;
    const connector = catalog.of(held);
    return connector !== undefined && ids.has(connector.id);
  };
  return {
    source,
    unit: (unit) => ids.has(unit),
    poll(acquirer, sources, fedBy) {
      if (ids.size === 0) return false;
      const connector = catalog.ofAcquirer(acquirer.name);
      if (connector !== undefined && ids.has(connector.id)) return true;
      const fed = laneSources(connectors, sources, acquirer.source, fedBy(acquirer.source));
      return fed.length > 0 && fed.every(source);
    },
  };
}

export function laneSources<T extends { id: string; connector?: string; options: JsonObject }>(connectors: readonly Connector[], rows: readonly T[], lane: string, fed: readonly string[]): T[] {
  const declared = siteSources(catalogOf(connectors).ofAcquirer(lane), lane);
  const copy = (row: T) => declared.some((source) => copyOf(source.id, row.id) && (row.connector === undefined || row.connector === source.read || source.feeders?.includes(row.connector) === true));
  return rows.filter((row) => row.id === lane || row.options.lane === lane || fed.includes(row.id) || copy(row));
}

function siteSources(connector: Connector | undefined, lane: string): DeclaredSource[] {
  return (connector?.sources ?? []).filter((source) => roadsOf(source).includes("chrome") && source.feeders?.includes(lane) === true);
}

export function offeredSource(lane: readonly { id: string; connector: string }[], account: { readonly id: string }): { id: string; connector: string } | null {
  const like = lane[0];
  if (like === undefined) return null;
  const { product, copy } = sourceName(like.id);
  return { id: `${product}:${account.id}:${copy}`, connector: like.connector };
}

export function accountsOf(connectors: readonly Connector[], sources: readonly SourceRow[], lanes: readonly string[], off: Switch, fedBy: (lane: string) => readonly string[]): Accounts {
  const fed = [...new Set(lanes.flatMap((lane) => laneSources(connectors, sources, lane, fedBy(lane))))].sort((a, b) => a.added_ms - b.added_ms || (a.id < b.id ? -1 : 1));
  return Object.fromEntries(fed.map((row) => [row.account, !off.source(row)]));
}

export function partsOf(id: string): ReturnType<typeof sourceName> | null {
  try {
    return sourceName(id);
  } catch (error) {
    if (!(error instanceof SourceNameError)) throw error;
    return null;
  }
}
