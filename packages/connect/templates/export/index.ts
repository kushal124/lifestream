import type { Adapters, Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { notes } from "./adapter.js";
import { exampleExport as exampleExportConnector } from "./connector.js";
import { exampleExport } from "./reader.js";

export const contract = 3;
export const connectors: readonly Connector[] = [exampleExportConnector];
export const readers: Reader[] = [exampleExport];
export const adapters: Record<string, Adapters> = { "example-export": { notes } };
