import type { Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { devicesHome } from "./reader.js";
import { devices } from "./connector.js";

export { devicesHome } from "./reader.js";

export const contract = 3;
export const connectors: readonly Connector[] = [devices];
export const readers: Reader[] = [devicesHome];
