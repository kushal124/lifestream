import type { Adapters, Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { appleHealthHealth } from "./adapter.js";
import { healthExport } from "./export.js";
import { health as healthPhone } from "./phone.js";
import { appleHealth } from "./connector.js";

export const contract = 3;
export const connectors: readonly Connector[] = [appleHealth];
export const readers: Reader[] = [healthExport, healthPhone];
export const adapters: Readonly<Record<string, Adapters>> = { "apple-health": { health: appleHealthHealth } };
