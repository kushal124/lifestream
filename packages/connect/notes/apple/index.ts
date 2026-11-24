import type { Adapters, Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { notesAdapter } from "./adapter.js";
import { appleNotes } from "./reader.js";
import { appleNotes as notesConnector } from "./connector.js";

export const contract = 3;
export const connectors: readonly Connector[] = [notesConnector];
export const readers: Reader[] = [appleNotes];
export const adapters: Readonly<Record<string, Adapters>> = { [notesConnector.id]: { notes: notesAdapter } };
