import type { Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { facesConnector } from "./reader.js";
import { facesLabeler } from "./labeler.js";
import { faces } from "./connector.js";

export const contract = 3;
export const connectors: readonly Connector[] = [faces];
export const readers: Reader[] = [facesConnector];
export const labelers = { faces: facesLabeler };
export { facesConnector, MODEL_IMAGE_KIND } from "./reader.js";
export { checkEngine, faceAnchors, facesLabeler, GROUP_RULE, modelsInstalled, runEngine, SCAN_NOW, type FaceAnchors, type FacesLabeler, type FacesSettings, type OneMatch } from "./labeler.js";
