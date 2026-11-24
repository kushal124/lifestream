import type { Adapters, Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { imessageMessages } from "./adapter-messages.js";
import { imessageConnector } from "./reader.js";
import { imessage } from "./connector.js";

export { imessageConnector } from "./reader.js";
export const contract = 3;
export const connectors: readonly Connector[] = [imessage];
export const readers: Reader[] = [imessageConnector];
export const adapters: Readonly<Record<string, Adapters>> = { imessage: { messages: imessageMessages } };
/** The Mac app and the iPhone backup seal their own deliveries: nothing here polls. */
