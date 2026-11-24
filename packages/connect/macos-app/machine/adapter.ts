import type { ScreenAdapter } from "@lifestreamprotocol/connect/sdk";
import { machineEvents } from "./reader.js";

export const machineScreen: ScreenAdapter = { version: "1", kinds: ["machine-event"], role: "machine", plays: (source) => source.connector === machineEvents.name };
