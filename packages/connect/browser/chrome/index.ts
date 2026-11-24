import type { Adapters, Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { chromeWeb } from "./adapter.js";
import { chromeHistory } from "./reader.js";
import { chrome } from "./connector.js";

export const contract = 3;
export const connectors: readonly Connector[] = [chrome];
export const readers: Reader[] = [chromeHistory];
export const adapters: Readonly<Record<string, Adapters>> = { chrome: { web: chromeWeb } };
