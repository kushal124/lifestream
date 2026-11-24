import type { Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import type { Labeler } from "../../labeler.js";
import { exampleLabel as exampleLabelConnector } from "./connector.js";
import { exampleLabelLabeler, type ExampleLabelSettings } from "./labeler.js";
import { exampleLabel } from "./reader.js";

export const contract = 3;
export const connectors: readonly Connector[] = [exampleLabelConnector];
export const readers: Reader[] = [exampleLabel];
export const labelers: Record<string, (settings: ExampleLabelSettings) => Labeler> = { "example-label": exampleLabelLabeler };
