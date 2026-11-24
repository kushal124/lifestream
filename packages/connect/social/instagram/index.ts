import type { Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { instagram } from "./reader.js";
import { instagram as instagramConnector } from "./connector.js";

export { FILES, instagram } from "./reader.js";

export const contract = 3;
export const connectors: readonly Connector[] = [instagramConnector];
export const readers: Reader[] = [instagram];
