import type { Adapters, Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { notes } from "./adapter.js";
import { exampleStore as exampleStoreConnector } from "./connector.js";
import { exampleStore } from "./reader.js";

export const contract = 3;
export const connectors: readonly Connector[] = [exampleStoreConnector];
export const readers: Reader[] = [exampleStore];
export const adapters: Record<string, Adapters> = { "example-store": { notes } };
