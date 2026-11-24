import type { Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { xArchive } from "./reader.js";
import { x } from "./connector.js";

export { FILES, LIKE, MESSAGES, MSG, POST, xArchive } from "./reader.js";

export const contract = 3;
export const connectors: readonly Connector[] = [x];
export const readers: Reader[] = [xArchive];
