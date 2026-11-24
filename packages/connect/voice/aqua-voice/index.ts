import type { Adapters, Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { aquaVoiceVoice } from "./adapter.js";
import { aquaVoice } from "./reader.js";
import { aquaVoice as aquaVoiceConnector } from "./connector.js";

export const contract = 3;
export const connectors: readonly Connector[] = [aquaVoiceConnector];
export const readers: Reader[] = [aquaVoice];
export const adapters: Readonly<Record<string, Adapters>> = { "aqua-voice": { voice: aquaVoiceVoice } };
