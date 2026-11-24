import type { Adapters, Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { calendarAdapter } from "./adapter.js";
import { appleCalendar } from "./reader.js";
import { appleCalendar as calendar } from "./connector.js";

export { appleCalendar } from "./reader.js";
export const contract = 3;
export const connectors: readonly Connector[] = [calendar];
export const readers: Reader[] = [appleCalendar];
export const adapters: Readonly<Record<string, Adapters>> = { [calendar.id]: { calendar: calendarAdapter } };
