import { isObject, type InputRecord, type Json, type JsonObject, type WebAdapter, type WebItem, type WebVisit } from "@lifestreamprotocol/connect/sdk";

const CORE_MASK = 0xff;
const AUTO_SUBFRAME = 3;
const MANUAL_SUBFRAME = 4;
const CHAIN_START = 0x10000000;
const CHAIN_END = 0x20000000;
const CLIENT_REDIRECT = 0x40000000;
const REDIRECTS = CLIENT_REDIRECT | 0x80000000;
const SOURCE_SYNCED = 0;
const DOWNLOAD_STATES: Readonly<Record<number, string>> = { 0: "under way", 2: "cancelled", 4: "interrupted" };
const STATION_NAME = "Lifestream";

export const chromeWeb: WebAdapter = {
  version: "2",
  kinds: ["page-visit", "search", "download"],
  station: true,
  item({ version }: InputRecord): WebItem | null {
    const content = version.content;
    if (!isObject(content)) return null;
    switch (content.type) {
      case "chrome.visit": {
        const visit = object(content.visit);
        const url = object(content.url);
        const transition = Number(visit.transition ?? 0);
        const core = transition & CORE_MASK;
        const hop = (transition & CHAIN_END) === 0 && (transition & (CHAIN_START | REDIRECTS)) !== 0;
        const href = text(url.url);
        if (core === AUTO_SUBFRAME || core === MANUAL_SUBFRAME || hop || Number(url.hidden ?? 0) === 1 || href?.startsWith("chrome-extension:") === true) return null;
        const synced = object(content.visit_source).source === SOURCE_SYNCED || text(visit.originator_cache_guid) !== null;
        const { tab_id: tab, total_foreground_duration: foreground } = object(content.context_annotations);
        return {
          what: "visit", url: href, title: text(url.title), ...(synced ? { synced: true as const } : {}),
          ...(typeof tab === "number" ? { tab: { id: tab, shown: Number(foreground ?? 0) > 0 } } : {}),
        };
      }
      case "chrome.search": {
        const term = text(object(content.term).term);
        return term === null ? null : { what: "search", url: text(object(content.url).url), title: null, term };
      }
      case "chrome.download": {
        const download = object(content.download);
        if (download.by_ext_name === STATION_NAME) return null;
        const chain = Array.isArray(content.url_chain) ? content.url_chain : [];
        const path = text(download.target_path) ?? text(download.current_path);
        const state = DOWNLOAD_STATES[Number(download.state)];
        return {
          what: "download", url: text(object(chain.at(-1)).url), title: null,
          ...(path === null ? {} : { file: path.split(/[\\/]/u).at(-1)! }), ...(state === undefined ? {} : { state }),
        };
      }
      default:
        return null;
    }
  },
  visit({ version }: InputRecord): WebVisit | null {
    const content = version.content;
    if (!isObject(content) || content.type !== "chrome.visit") return null;
    const visit = object(content.visit);
    const { tab_id: tab } = object(content.context_annotations);
    const from = Number(visit.from_visit ?? 0);
    return {
      url: text(object(content.url).url), ...(typeof tab === "number" ? { tab } : {}),
      ...((Number(visit.transition ?? 0) & CLIENT_REDIRECT) !== 0 && Number.isSafeInteger(from) && from > 0 ? { from: `${from}:` } : {}),
    };
  },
};

function object(value: Json | undefined): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function text(value: Json | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
