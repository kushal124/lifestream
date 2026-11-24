import type { Adapters, Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { aiAdapter } from "./adapter.js";
import { claudeCodeSessions } from "./reader.js";
import { claudeCode } from "./connector.js";

export const contract = 3;
export const connectors: readonly Connector[] = [claudeCode];
export const readers: Reader[] = [claudeCodeSessions];
export const adapters: Readonly<Record<string, Adapters>> = { [claudeCode.id]: { ai: aiAdapter } };
