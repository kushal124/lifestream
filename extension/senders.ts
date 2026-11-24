import type { Opened } from "./station.js";
import type { Pressing } from "./wire.js";


export function sentBy(sender: chrome.runtime.MessageSender, pages: readonly string[]): boolean {
  if (sender.id !== chrome.runtime.id || typeof sender.url !== "string") return false;
  let url: URL;
  try {
    url = new URL(sender.url);
  } catch {
    return false;
  }
  url.search = "";
  url.hash = "";
  return pages.some((page) => url.href === chrome.runtime.getURL(page));
}

const text = (value: unknown): value is string => typeof value === "string";
const textOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function needOf(value: unknown): Opened | null {
  if (!record(value) || !text(value.id)) return null;
  const at = value.at;
  if (at === null) return { id: value.id, at: null };
  return record(at) && textOrNull(at.errand) ? { id: value.id, at: { errand: at.errand } } : null;
}

export function pressingOf(value: unknown): Pressing | null {
  if (!record(value) || !text(value.label) || !text(value.need)) return null;
  if (value.do === "try" || value.do === "skip") return value as unknown as Pressing;
  if ((value.do === "read" || value.do === "ignore") && text(value.of)) return value as unknown as Pressing;
  return null;
}

export function idsOf(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(text) ? value : null;
}
