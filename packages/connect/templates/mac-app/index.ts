import type { Adapters, Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { notes } from "./adapter.js";
import { exampleMacApp as exampleMacAppConnector } from "./connector.js";
import { exampleMacApp } from "./reader.js";

export const contract = 3;
export const connectors: readonly Connector[] = [exampleMacAppConnector];
export const readers: Reader[] = [exampleMacApp];
export const adapters: Record<string, Adapters> = { "example-mac-app": { notes } };
