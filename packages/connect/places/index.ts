import type { Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { googlePlaceNames, placesHome } from "./reader.js";
import { places } from "./connector.js";

export { ALSO_MAX, googlePlaceNames, HIDDEN_RADIUS_M, placesHome } from "./reader.js";

export const contract = 3;
export const connectors: readonly Connector[] = [places];
export const readers: Reader[] = [placesHome, googlePlaceNames];
