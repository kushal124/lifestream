import type { Adapters, Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { aiAdapter } from "./adapter.js";
import { askHome } from "./reader.js";
import { ask } from "./connector.js";

export { askHome, isPhoto, PHOTO_HEAD, PHOTOS_MAX, VOICE_MS_MAX, voiceMs, WAV_HEADER, wavHeader } from "./reader.js";

export const contract = 3;
export const connectors: readonly Connector[] = [ask];
export const readers: Reader[] = [askHome];
export const adapters: Readonly<Record<string, Adapters>> = { [ask.id]: { ai: aiAdapter } };
