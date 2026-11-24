import type { Adapters, Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { exampleBank as exampleBankConnector } from "./connector.js";
import { exampleBank, TXN } from "./reader.js";

export const contract = 3;
export const connectors: readonly Connector[] = [exampleBankConnector];
export const readers: Reader[] = [exampleBank];
export const adapters: Record<string, Adapters> = { "example-bank": { money: { version: "1", kinds: [TXN] } } };
