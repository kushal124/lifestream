import type { Adapters, Client, Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { calendarAdapter } from "./adapter.js";
import { gcalApi, gcalExport } from "./reader.js";
import { gcalApiAcquirer } from "./acquirer.js";
import { google } from "./client.js";
import { googleCalendar } from "./connector.js";

export { gcalApi, gcalExport } from "./reader.js";
export { gcalApiAcquirer, type GcalApiSettings, type GcalApiState } from "./acquirer.js";

export const contract = 3;
export const connectors: readonly Connector[] = [googleCalendar];
export const readers: Reader[] = [gcalApi, gcalExport];
export const adapters: Readonly<Record<string, Adapters>> = { [googleCalendar.id]: { calendar: calendarAdapter } };
export const acquirers = { "gcal-api": gcalApiAcquirer };
export const clients: readonly Client[] = [google];
