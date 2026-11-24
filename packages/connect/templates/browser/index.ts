import type { Acquirer, AcquirerSettings, Adapters, Connector, Dependencies, Reader } from "@lifestreamprotocol/connect/sdk";
import { exampleBrowserAcquirer } from "./acquirer.js";
import { notes } from "./adapter.js";
import { exampleBrowser as exampleBrowserConnector } from "./connector.js";
import { exampleBrowser } from "./reader.js";

export const contract = 3;
export const connectors: readonly Connector[] = [exampleBrowserConnector];
export const readers: Reader[] = [exampleBrowser];
export const adapters: Record<string, Adapters> = { "example-browser": { notes } };
export const acquirers: Record<string, (settings: AcquirerSettings, dependencies?: Dependencies) => Acquirer> = { "example-browser": exampleBrowserAcquirer };
