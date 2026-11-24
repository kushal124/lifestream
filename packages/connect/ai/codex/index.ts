import type { Adapters, Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { aiAdapter } from "./adapter.js";
import { codexSessions } from "./reader.js";
import { codex } from "./connector.js";

export const contract = 3;
export const connectors: readonly Connector[] = [codex];
export const readers: Reader[] = [codexSessions];
export const adapters: Readonly<Record<string, Adapters>> = { [codex.id]: { ai: aiAdapter } };
