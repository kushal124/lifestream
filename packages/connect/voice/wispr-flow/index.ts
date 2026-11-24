import type { Adapters, Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { wisprFlowVoice } from "./adapter.js";
import { wisprFlow } from "./reader.js";
import { wisprFlow as wisprFlowConnector } from "./connector.js";

export const contract = 3;
export const connectors: readonly Connector[] = [wisprFlowConnector];
export const readers: Reader[] = [wisprFlow];
export const adapters: Readonly<Record<string, Adapters>> = { "wispr-flow": { voice: wisprFlowVoice } };
