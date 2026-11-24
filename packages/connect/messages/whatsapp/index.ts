import type { Adapters, Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { whatsappCalls } from "./adapter-calls.js";
import { whatsappMessages } from "./adapter-messages.js";
import { whatsappConnector } from "./reader.js";
import { whatsapp } from "./connector.js";

export { whatsappConnector } from "./reader.js";
export const contract = 3;
export const connectors: readonly Connector[] = [whatsapp];
export const readers: Reader[] = [whatsappConnector];
export const adapters: Readonly<Record<string, Adapters>> = { whatsapp: { messages: whatsappMessages, calls: whatsappCalls } };
/** The Mac app and the iPhone backup seal their own deliveries: nothing here polls. */
