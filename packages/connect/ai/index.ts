import type { Adapters } from "@lifestreamprotocol/core";
import type { Acquirer, Reader } from "../seams.js";
import { claudeBrowserAcquirer } from "./claude/browser-acquirer.js";
import { claudeBrowserConnector } from "./claude/browser-reader.js";
import { chatgptBrowserAcquirer } from "./chatgpt/browser-acquirer.js";
import { chatgptBrowserConnector } from "./chatgpt/browser-reader.js";
import { chatgptConnector } from "./chatgpt/reader.js";
import { claudeConnector } from "./claude/reader.js";
import type { Connector } from "../declaration.js";
import { aiAdapter as chatgptAdapter } from "./chatgpt/adapter.js";
import { chatgpt } from "./chatgpt/connector.js";
import { aiAdapter as claudeAdapter } from "./claude/adapter.js";
import { claude } from "./claude/connector.js";
import type { BrowserSettings } from "@lifestreamprotocol/connect/sdk";

export const contract = 3;
export const connectors: readonly Connector[] = [chatgpt, claude];
export const readers: Reader[] = [chatgptConnector, claudeConnector, chatgptBrowserConnector, claudeBrowserConnector];
export const adapters: Readonly<Record<string, Adapters>> = { [chatgpt.id]: { ai: chatgptAdapter }, [claude.id]: { ai: claudeAdapter } };
export const acquirers = {
  "claude-browser": claudeBrowserAcquirer,
  "chatgpt-browser": chatgptBrowserAcquirer,
} satisfies Record<string, (settings: never) => Acquirer>;
export { chatgptBrowserAcquirer, chatgptBrowserConnector, chatgptConnector, claudeBrowserAcquirer, claudeBrowserConnector, claudeConnector, type BrowserSettings };
