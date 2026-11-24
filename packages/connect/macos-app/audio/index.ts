import type { Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { audioRecordings } from "./reader.js";
import { audio } from "./connector.js";

export const contract = 3;
export const connectors: readonly Connector[] = [audio];
export const readers: Reader[] = [audioRecordings];
