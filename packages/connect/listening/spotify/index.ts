import type { Adapters, Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { spotifyListening } from "./adapter.js";
import { spotifyConnector } from "./reader.js";
import { spotify } from "./connector.js";

export const contract = 3;
export const connectors: readonly Connector[] = [spotify];
export const readers: Reader[] = [spotifyConnector];
export const adapters: Readonly<Record<string, Adapters>> = { spotify: { listening: spotifyListening } };
export { spotifyConnector };
