import { isObject, type InputRecord, type Json, type JsonObject, type WebAdapter, type WebItem } from "@lifestreamprotocol/connect/sdk";

export const safariWeb: WebAdapter = {
  version: "1",
  kinds: ["page-visit", "tab"],
  item({ version }: InputRecord): WebItem | null {
    const content = version.content;
    if (!isObject(content)) return null;
    switch (content.type) {
      case "safari.visit": {
        const visit = object(content.visit);
        if (typeof visit.redirect_destination === "number") return null;
        return { what: "visit", url: text(object(content.item).url), title: text(visit.title), ...(visit.origin === 1 ? { synced: true as const } : {}) };
      }
      case "safari.tab": {
        const tab = object(content.tab);
        const device = text(object(content.device).device_name);
        return { what: "tab", url: text(tab.url), title: text(tab.title), ...(device === null ? { synced: true as const } : { device }) };
      }
      default:
        return null;
    }
  },
};

function object(value: Json | undefined): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function text(value: Json | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
