import type { Adapters, Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { safariWeb } from "./adapter.js";
import { safariHistory } from "./reader.js";
import { safari } from "./connector.js";

export const contract = 3;
export const connectors: readonly Connector[] = [safari];
export const readers: Reader[] = [safariHistory];
export const adapters: Readonly<Record<string, Adapters>> = { safari: { web: safariWeb } };
