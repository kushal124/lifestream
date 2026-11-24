import type { Adapters, Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { timelinePhysical } from "./adapter.js";
import { googleTimeline } from "./reader.js";
import { googleTimeline as timeline } from "./connector.js";

export { googleTimeline } from "./reader.js";

export const contract = 3;
export const connectors: readonly Connector[] = [timeline];
export const readers: Reader[] = [googleTimeline];
export const adapters: Readonly<Record<string, Adapters>> = { "google-timeline": { physical: timelinePhysical } };
