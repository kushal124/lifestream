import type { Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { myActivity } from "./reader.js";
import { google } from "./connector.js";

export { entryKey, FOLDERS, myActivity, VERBS } from "./reader.js";

export const contract = 3;
export const connectors: readonly Connector[] = [google];
export const readers: Reader[] = [myActivity];
