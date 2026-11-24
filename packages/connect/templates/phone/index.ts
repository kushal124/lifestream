import type { Adapters, Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { notes } from "./adapter.js";
import { examplePhone as examplePhoneConnector } from "./connector.js";
import { examplePhone } from "./reader.js";

export const contract = 3;
export const connectors: readonly Connector[] = [examplePhoneConnector];
export const readers: Reader[] = [examplePhone];
export const adapters: Record<string, Adapters> = { "example-phone": { notes } };
