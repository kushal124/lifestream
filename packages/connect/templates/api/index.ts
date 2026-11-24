import type { Acquirer, AcquirerSettings, Adapters, Connector, Dependencies, Reader } from "@lifestreamprotocol/connect/sdk";
import { exampleApiAcquirer, type ExampleApiFields } from "./acquirer.js";
import { notes } from "./adapter.js";
import { exampleApi as exampleApiConnector } from "./connector.js";
import { exampleApi } from "./reader.js";

export const contract = 3;
export const connectors: readonly Connector[] = [exampleApiConnector];
export const readers: Reader[] = [exampleApi];
export const adapters: Record<string, Adapters> = { "example-api": { notes } };
export const acquirers: Record<string, (settings: AcquirerSettings<ExampleApiFields>, dependencies?: Dependencies) => Acquirer> = { "example-api": exampleApiAcquirer };
