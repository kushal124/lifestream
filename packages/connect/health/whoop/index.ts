import type { Acquirer, Adapters, Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { whoopHealth } from "./adapter.js";
import { whoopAcquirer, type WhoopSettings } from "./acquirer.js";
import { whoopConnector } from "./reader.js";
import { whoop } from "./connector.js";

export const contract = 3;
export const connectors: readonly Connector[] = [whoop];
export const readers: Reader[] = [whoopConnector];
export const adapters: Readonly<Record<string, Adapters>> = { whoop: { health: whoopHealth } };
export const acquirers: Record<string, (settings: WhoopSettings) => Acquirer> = { whoop: whoopAcquirer };
export { recipes } from "./recipe.js";
export { whoopAcquirer, whoopConnector, type WhoopSettings };
