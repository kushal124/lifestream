import type { Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { peopleHome } from "./reader.js";
import { people } from "./connector.js";

export { peopleHome } from "./reader.js";

export const contract = 3;
export const connectors: readonly Connector[] = [people];
export const readers: Reader[] = [peopleHome];
