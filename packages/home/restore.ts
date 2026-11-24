import { isObject, sourceName, type Json, type JsonObject, type OpenView } from "@lifestreamprotocol/core";
import type { Connector } from "@lifestreamprotocol/connect";
import type { ReadPoint } from "./custody.js";
import type { Principal } from "./principals.js";


function restoring(connectors: readonly Connector[], unit: string, delivers: readonly string[]) {
  const byProduct = new Map(connectors.flatMap((connector) => (connector.phone?.restore === undefined ? [] : [[connector.product, connector] as const])));
  return delivers.flatMap((source) => {
    const parts = sourceName(source);
    const connector = parts.copy === unit ? byProduct.get(parts.product) : undefined;
    return connector === undefined ? [] : [{ source, connector, restore: connector.phone!.restore! }];
  });
}

export const restoredSources = (connectors: readonly Connector[], unit: string, delivers: readonly string[]): string[] =>
  restoring(connectors, unit, delivers).map(({ source }) => source);

export interface Restored extends JsonObject {
  readonly kind: string;
  readonly observed_at: string;
  readonly payload: Json;
}

export function restore(view: OpenView, connectors: readonly Connector[], pass: Principal, delivers: readonly string[], points: Readonly<Record<string, ReadPoint | null>>): JsonObject {
  const since: JsonObject = {};
  const types: JsonObject = {};
  for (const source of delivers) {
    const point = points[source] ?? null;
    since[source] = point?.at_ms ?? null;
    if (point?.types) types[source] = [...point.types];
  }
  const domains: JsonObject = {};
  const contacts: JsonObject = {};
  for (const { source, connector, restore: restored } of restoring(connectors, pass.unit, delivers)) {
    if (restored === "contacts") {
      contacts[source] = [...view.heads(source, "contact")].map((head) => head.key).sort();
      continue;
    }
    const entries: Restored[] = [];
    for (const kind of restored.kinds) {
      for (const { version } of view.records(source, kind)) entries.push(entryOf(version.content));
    }
    domains[connector.phone!.domain ?? connector.product] = entries.sort((a, b) => a.observed_at.localeCompare(b.observed_at));
  }
  return { pass: pass.id, unit: pass.unit, since, types, domains, contacts };
}

function entryOf(content: Json): Restored {
  const line = isObject(content) && isObject(content.content) ? content.content : {};
  return { kind: line.kind as string, observed_at: line.observed_at as string, payload: line.payload ?? null };
}
