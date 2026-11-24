import type { Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { facebook } from "./reader.js";
import { facebook as facebookConnector } from "./connector.js";

export { facebook, FILES } from "./reader.js";

export const contract = 3;
export const connectors: readonly Connector[] = [facebookConnector];
export const readers: Reader[] = [facebook];
