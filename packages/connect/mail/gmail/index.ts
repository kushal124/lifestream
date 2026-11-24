import type { Adapters, Connector, Reader, SignedIn } from "@lifestreamprotocol/connect/sdk";
import { mailAdapter } from "./adapter.js";
import { gmail } from "./reader.js";
import { gmailImapAcquirer, gmailSignedIn } from "./acquirer.js";
import { gmail as mailbox } from "./connector.js";

export { gmail } from "./reader.js";
export { gmailImapAcquirer, gmailSignedIn, type FolderCursor, type GmailImapSettings, type GmailImapState } from "./acquirer.js";

export const contract = 3;
export const connectors: readonly Connector[] = [mailbox];
export const readers: Reader[] = [gmail];
export const adapters: Readonly<Record<string, Adapters>> = { [mailbox.id]: { mail: mailAdapter } };
export const acquirers = { "gmail-imap": gmailImapAcquirer };
export const signins: Readonly<Record<string, SignedIn>> = { "gmail-imap": gmailSignedIn };
