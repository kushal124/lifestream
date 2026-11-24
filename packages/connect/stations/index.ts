import type { Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { stationsHome } from "./reader.js";
import { stations } from "./connector.js";

export { stationsHome, tabClaim, type TabClaim } from "./reader.js";

export const contract = 3;
export const connectors: readonly Connector[] = [stations];
export const readers: Reader[] = [stationsHome];
