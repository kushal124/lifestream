import type { Adapters, Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { googlePhotosAdapter } from "./adapter.js";
import { googlePhotosTakeout } from "./reader.js";
import { googlePhotos } from "./connector.js";

export { googlePhotosTakeout } from "./reader.js";

export const contract = 3;
export const connectors: readonly Connector[] = [googlePhotos];
export const readers: Reader[] = [googlePhotosTakeout];
export const adapters: Readonly<Record<string, Adapters>> = { "google-photos": { photos: googlePhotosAdapter } };
