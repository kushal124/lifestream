import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stations, withRoadDefaults, type Acquirer, type Connector } from "@lifestreamprotocol/connect";
import { acquirers, connectorsWith, feedersOf } from "../registry-home.js";
import type { Registry, RegistryHome } from "../registry.js";
import type { Settings } from "../settings.js";
import { releaseFolder } from "./fed.js";

const whoop = releaseFolder("health/whoop");

export const JOURNEY_FILE = "whoop-journey.json";

export default function registry(settings: Settings, home: RegistryHome): Registry {
  const folder = home.root;
  const now = (): number => (JSON.parse(readFileSync(join(folder, JOURNEY_FILE), "utf8")) as { now_ms: number }).now_ms;
  const declared: readonly Connector[] = whoop.connectors.map(withRoadDefaults);
  const factories: Readonly<Record<string, (settings: never) => Acquirer>> = {
    whoop: (each: Parameters<typeof whoop.whoopAcquirer>[0]) => whoop.whoopAcquirer(each, { now, sleep: async () => undefined }),
  } as never;
  return {
    connectors: connectorsWith(declared), readers: [...whoop.readers, ...stations.readers], feeders: feedersOf(declared), families: [],
    acquirers: acquirers(declared, factories, settings, home),
  };
}
