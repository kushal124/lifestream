import type { Adapters, Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { applePhotosAdapter } from "./adapter.js";
import { photos as photosPhone } from "./phone.js";
import { photosMac } from "./reader.js";
import { applePhotos } from "./connector.js";

export { photosMac, PHOTOS_MAC_CONNECTOR } from "./reader.js";

export const contract = 3;
export const connectors: readonly Connector[] = [applePhotos];
export const readers: Reader[] = [photosMac, photosPhone];
export const adapters: Readonly<Record<string, Adapters>> = { "apple-photos": { photos: applePhotosAdapter } };
