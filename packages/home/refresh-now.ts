import { runningOf, type Connector, type Road } from "@lifestreamprotocol/connect";
import { roomOf, type DaySettings, type ReadTables } from "@lifestreamprotocol/core";
import { latest, targetOf } from "./attempts.js";
import { connectorSettings } from "./settings.js";
import { refreshWords } from "./stream-words.js";
import type { RefreshNow } from "./streams-report.js";
import type { RefreshBlocked } from "./wire.js";

export function macRefreshes(connector: Connector): boolean {
  return connector.mac?.recorder !== true && connector.mac?.sensor !== true;
}

type Block = Parameters<typeof runningOf>[1];

export const POLL_REFRESH = "poll-refresh:";

export type LaneTables = Pick<ReadTables, "polls" | "meta" | "attempts">;

export function homeLanes(connector: Connector, block: Block | undefined, tables: Pick<ReadTables, "polls">): string[] {
  if (connectorSettings(connector, block).refresh_ms === null) return [];
  return runningOf(connector, block).filter((lane) => tables.polls.get(lane) !== undefined);
}

export function laneBlocked(tables: LaneTables, lane: string, now: number): { reason: "running" | "held"; until_ms: number | null } | null {
  if (tables.meta.get(`${POLL_REFRESH}${lane}`) !== undefined) return { reason: "running", until_ms: null };
  const held = tables.polls.get(lane)?.held_ms ?? null;
  return held !== null && held > now ? { reason: "held", until_ms: held } : null;
}

export function lanesBlocked(blocks: readonly ({ reason: "running" | "held"; until_ms: number | null } | null)[]): { reason: "running" | "held"; until_ms: number | null } | null {
  if (blocks.length === 0 || blocks.some((each) => each === null)) return null;
  const all = blocks as { reason: "running" | "held"; until_ms: number | null }[];
  if (all.some((each) => each.reason === "running")) return { reason: "running", until_ms: null };
  return { reason: "held", until_ms: Math.min(...all.map((each) => each.until_ms!)) };
}

export function blockedOf(reason: RefreshBlocked["reason"], facts: { name: string; until_ms?: number | null; devices?: readonly string[]; now: number; day: DaySettings }): RefreshBlocked {
  return { reason, words: refreshWords(reason, facts), until_ms: facts.until_ms ?? null };
}

export interface RefreshFolded {
  connector: Connector;
  name: string;
  on: boolean;
  set_up: boolean;
  pauses: readonly { scope: "all" | "history" }[];
  health: { state: string };
  said: { acts: readonly { do: string }[] };
  live: readonly {
    row: { id: string };
    road: Road;
    unit: string | null;
    facts: { on: boolean; device: { trouble: { state: string } | null } | null };
    said: { acts: readonly { do: string }[] };
  }[];
}

export interface RefreshInput {
  now_ms: number;
  settings: { day: DaySettings; connectors: Readonly<Record<string, Block | undefined>> };
  unit?: string;
  free_bytes: number;
  needs: readonly { id: string }[];
  present: readonly string[];
  asked?: readonly { unit: string; source: string }[];
}

export function refreshOf(tables: LaneTables, folded: RefreshFolded, input: RefreshInput, nameOf: (unit: string) => string): RefreshNow | null {
  const { connector, name } = folded;
  const now = input.now_ms;
  const day = input.settings.day;
  if (!folded.set_up || !folded.on) return null;
  if (folded.health.state === "needs-you" || folded.health.state === "broken") return null;
  if ([folded.said, ...folded.live.map((copy) => copy.said)].some((said) => said.acts.some((act) => act.do === "try"))) return null;
  const lanes = homeLanes(connector, input.settings.connectors[connector.id], tables);
  const copies = folded.live.filter((copy) => copy.facts.on && copy.unit !== null);
  const store = macRefreshes(connector);
  const macs = store ? [...new Set(copies.filter((copy) => copy.road === "mac").map((copy) => copy.unit!))] : [];
  const phone = copies.some((copy) => copy.road === "phone" && copy.unit === input.unit);
  if (lanes.length === 0 && macs.length === 0 && !phone) return null;
  const sources = new Set(store ? copies.filter((copy) => copy.road === "mac").map((copy) => copy.row.id) : []);
  const asked = [...new Set((input.asked ?? []).filter((each) => sources.has(each.source) && each.unit !== input.unit).map((each) => each.unit))]
    .map((unit) => ({ unit, name: nameOf(unit) }));
  const say = (reason: RefreshBlocked["reason"], facts: { until_ms?: number | null; devices?: readonly string[] } = {}) => blockedOf(reason, { name, now, day, ...facts });
  const blocked = ((): RefreshBlocked | null => {
    if (folded.pauses.some((pause) => pause.scope === "all") || folded.health.state === "paused") return say("paused");
    if (roomOf(input.free_bytes) === "full") return say("disk");
    const others = macs.filter((unit) => unit !== input.unit);
    if (lanes.length > 0 && others.length === 0 && !phone && !macs.includes(input.unit ?? "")) {
      const secret = connector.signin !== undefined || Object.values(connector.fields ?? {}).some((field) => field.kind === "secret");
      if (secret && input.needs.some((need) => need.id === "vault:locked")) return say("vault");
      if (connector.chrome !== undefined && input.present.length === 0) return say("chrome");
      const lane = lanesBlocked(lanes.map((each) => laneBlocked(tables, each, now)));
      if (lane !== null) return say(lane.reason, { until_ms: lane.until_ms });
      if (lanes.every((each) => isOffline(tables, each))) return say("offline");
      return null;
    }
    if (lanes.length === 0 && !phone && !macs.includes(input.unit ?? "")) {
      const quiet = others.filter((unit) => copies.some((copy) => copy.unit === unit && copy.facts.device?.trouble?.state === "quiet"));
      if (quiet.length === others.length) return say("device", { devices: quiet.map(nameOf) });
    }
    return null;
  })();
  return { act: { do: "refresh", label: "Check now", of: connector.id }, blocked, asked };
}

function isOffline(tables: Pick<ReadTables, "attempts">, lane: string): boolean {
  const last = latest(tables, targetOf("fetch", lane));
  return last?.outcome === "wait" && last.reason === "offline";
}
