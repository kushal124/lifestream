import type { Guard, Json, JsonObject } from "@lifestreamprotocol/connect/sdk";
import { exact, ownerConnector, type StatementKind } from "../shared/statements.js";

const STATION = /^chrome-[0-9a-f]{8}$/u;
const ERRAND = /^e-[0-9a-f]{8}$/u;

export interface TabClaim {
  readonly station: string;
  readonly tab: number;
  readonly errand: string | null;
  readonly from_ms: number;
  readonly until_ms: number;
}

const keyOf = ({ station, tab, from_ms }: Pick<TabClaim, "station" | "tab" | "from_ms">): string => `${station}:${tab}:${from_ms}`;

export function tabClaim(claim: TabClaim): { kind: "tab"; key: string; content: JsonObject } {
  const { station, tab, errand, from_ms, until_ms } = claim;
  return { kind: "tab", key: keyOf(claim), content: { type: "stations.tab", station, tab, errand, from_ms, until_ms } };
}

const isMs = (value: Json | undefined): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

const tab: Guard = (content) => {
  if (!exact(content, ["type", "station", "tab", "errand", "from_ms", "until_ms"]) || content.type !== "stations.tab") {
    return ["content must hold type stations.tab, station, tab, errand, from_ms and until_ms, and nothing else"];
  }
  const out: string[] = [];
  if (typeof content.station !== "string" || !STATION.test(content.station)) out.push("station must be a station's unit");
  if (!isMs(content.tab)) out.push("tab must be Chrome's id of the tab");
  if (content.errand !== null && (typeof content.errand !== "string" || !ERRAND.test(content.errand))) out.push("errand must be an errand's id, or null");
  if (!isMs(content.from_ms) || !isMs(content.until_ms)) out.push("from_ms and until_ms must be ms since the epoch");
  else if (content.from_ms > content.until_ms) out.push("from_ms must not be after until_ms");
  return out;
};

const TABS: Readonly<Record<string, StatementKind>> = {
  tab: {
    guard: tab, time: "from_ms", ends: "until_ms",
    key: (key, content) => {
      const stated = content as Partial<TabClaim> | null;
      if (stated === null) return /^chrome-[0-9a-f]{8}:\d+:\d+$/u.test(key) ? undefined : `${JSON.stringify(key)} is not <station>:<tab>:<from_ms>`;
      return key === keyOf(stated as TabClaim) ? undefined : `${JSON.stringify(key)} is not this claim's <station>:<tab>:<from_ms>`;
    },
  },
};

export const stationsHome = ownerConnector("stations-home", TABS);
