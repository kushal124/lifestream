import type { Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { camerasConnector } from "./reader.js";
import { camerasLabeler } from "./labeler.js";
import { cameras } from "./connector.js";

export const contract = 3;
export const connectors: readonly Connector[] = [cameras];
export const readers: Reader[] = [camerasConnector];
export const labelers = { cameras: camerasLabeler };
export { CAMERA_KIND, CAMERAS_FILE, camerasConnector, PHOTO_KIND, type Camera, type CameraPhoto } from "./reader.js";
export { camerasLabeler, type CamerasSettings } from "./labeler.js";
