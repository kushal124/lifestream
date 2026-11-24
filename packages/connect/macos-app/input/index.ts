import type { Adapters, Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { inputScreen } from "./adapter.js";
import { inputEvents } from "./reader.js";
import { input } from "./connector.js";

export const contract = 3;
export const connectors: readonly Connector[] = [input];
export const readers: Reader[] = [inputEvents];
export const adapters: Readonly<Record<string, Adapters>> = { input: { screen: inputScreen } };
