import type { Adapters, Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { messages } from "./adapter.js";
import { exampleChat as exampleChatConnector } from "./connector.js";
import { exampleChat } from "./reader.js";

export const contract = 3;
export const connectors: readonly Connector[] = [exampleChatConnector];
export const readers: Reader[] = [exampleChat];
export const adapters: Record<string, Adapters> = { "example-chat": { messages } };
