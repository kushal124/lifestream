import type { Adapters, Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { calendarAdapter } from "./adapter.js";
import { appleReminders } from "./reader.js";
import { appleReminders as reminders } from "./connector.js";

export { appleReminders } from "./reader.js";
export const contract = 3;
export const connectors: readonly Connector[] = [reminders];
export const readers: Reader[] = [appleReminders];
export const adapters: Readonly<Record<string, Adapters>> = { [reminders.id]: { calendar: calendarAdapter } };
