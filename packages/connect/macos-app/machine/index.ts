import type { Adapters, Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { machineScreen } from "./adapter.js";
import { machineEvents, machineIosBundle } from "./reader.js";
import { machine } from "./connector.js";

export const contract = 3;
export const connectors: readonly Connector[] = [machine];
export const readers: Reader[] = [machineEvents, machineIosBundle];
export const adapters: Readonly<Record<string, Adapters>> = { machine: { screen: machineScreen } };
