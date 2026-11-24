import type { Adapters, Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { contactsLabels } from "./adapter.js";
import { appleContacts } from "./connector.js";
import { contacts as contactsPhone } from "./phone.js";
import { contactsVcard } from "./reader.js";

export { contactsVcard } from "./reader.js";

export const contract = 3;
export const connectors: readonly Connector[] = [appleContacts];
export const readers: Reader[] = [contactsVcard, contactsPhone];
export const adapters: Readonly<Record<string, Adapters>> = { "apple-contacts": { labels: contactsLabels } };
