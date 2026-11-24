import type { Adapters, Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { appleCallsAdapter } from "./adapter.js";
import { callHistory } from "./reader.js";
import { appleCalls } from "./connector.js";

export const contract = 3;
export const connectors: readonly Connector[] = [appleCalls];
export const readers: Reader[] = [callHistory];
export const adapters: Readonly<Record<string, Adapters>> = { "apple-calls": { calls: appleCallsAdapter } };
