import type { Acquirer, Adapters, Connector, InputRecord, Line, Reader } from "@lifestreamprotocol/connect/sdk";
import { exampleLogAcquirer, type ExampleLogSettings } from "./acquirer.js";
import { exampleLog as exampleLogConnector } from "./connector.js";
import { ENTRY, exampleLog } from "./reader.js";

function line(record: InputRecord): Line | null {
  const content = record.version.content as { text?: unknown; title?: unknown };
  if (typeof content.text !== "string" || content.text === "") return null;
  return { text: content.text, ...(typeof content.title === "string" ? { title: content.title } : {}) };
}

export const contract = 3;
export const connectors: readonly Connector[] = [exampleLogConnector];
export const readers: Reader[] = [exampleLog];
export const acquirers: Record<string, (settings: ExampleLogSettings) => Acquirer> = { "example-log": exampleLogAcquirer };
export const adapters: Record<string, Adapters> = { "example-log": { line: { version: "1", kinds: [ENTRY], line } } };
