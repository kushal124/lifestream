import type { Acquirer, Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { uploadConnector } from "./reader.js";
import { upload } from "./connector.js";

export const contract = 3;
export const connectors: readonly Connector[] = [upload];
export const readers: Reader[] = [uploadConnector];
export const acquirers: Record<string, (settings: never) => Acquirer> = {};
export { UPLOAD_CONNECTOR, UPLOAD_DOMAIN, UPLOAD_FILES, UPLOAD_INDEX, UPLOAD_INDEX_FORMAT, uploadConnector, uploadedFiles, type UploadedFile } from "./reader.js";
