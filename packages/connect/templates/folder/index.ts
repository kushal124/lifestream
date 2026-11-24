import type { Acquirer, AcquirerSettings, Adapters, Connector, Dependencies, Reader } from "@lifestreamprotocol/connect/sdk";
import { exampleFolderAcquirer, type ExampleFolderFields } from "./acquirer.js";
import { notes } from "./adapter.js";
import { exampleFolder as exampleFolderConnector } from "./connector.js";
import { exampleFolder } from "./reader.js";

export const contract = 3;
export const connectors: readonly Connector[] = [exampleFolderConnector];
export const readers: Reader[] = [exampleFolder];
export const adapters: Record<string, Adapters> = { "example-folder": { notes } };
export const acquirers: Record<string, (settings: AcquirerSettings<ExampleFolderFields>, dependencies?: Dependencies) => Acquirer> = { "example-folder": exampleFolderAcquirer };
