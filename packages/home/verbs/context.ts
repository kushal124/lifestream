import type { DoorStations } from "@lifestreamprotocol/connect";
import type { BlobStore, DaySettings, HomeDb, HomeFolder, JsonObject, SourceRow } from "@lifestreamprotocol/core";
import type { Family } from "@lifestreamprotocol/families";
import type { Ledger, ModelSettings } from "@lifestreamprotocol/model";
import type { Removed } from "../erasable-streams.js";
import type { Machine } from "../machine.js";
import type { Agents } from "../agents.js";
import type { Feedback } from "../feedback.js";
import type { Pairing } from "../pairing.js";
import type { Stated } from "../stated.js";
import type { RefreshAnswer } from "../wire.js";
import { readerOf, type Loaded, type Registry } from "../registry.js";
import { effective, type DoorAddress, type Settings, type SettingsFolder } from "../settings.js";

export interface OpsSettings {
  day: DaySettings;
  history: Settings["history"];
  unit: Settings["unit"];
  connectors: Settings["connectors"];
  clients: Settings["clients"];
  sources: Settings["sources"];
  sites: Settings["sites"];
  model: ModelSettings;
  helpers: Settings["helpers"];
  defaults: Settings["defaults"];
  runners: Settings["runners"];
  door: DoorAddress;
  privacy: Settings["privacy"];
  screen_cutover_ms: Settings["screen_cutover_ms"];
}

export interface VerbContext {
  folder: HomeFolder;
  machine: Machine;
  cwd: string;
  by: string | null;
  db: HomeDb;
  blobs: BlobStore;
  ledger: Ledger;
  settings: OpsSettings;
  registry(): Promise<Loaded>;
  now(): number;
  out(line: string): void;
  going(line: string): void;
  calls?: { limit_ms?: number; signal?: AbortSignal };
  cutStreams?(removed: Removed): Promise<void>;
  background?(): void;
  committed?(): Promise<void>;
  pairing?: Pairing;
  agents?: Agents;
  feedback?: Pick<Feedback, "forget">;
  door?(route: string, body?: JsonObject): Promise<JsonObject>;
  stations?(): DoorStations;
  stated?(): Promise<Stated | null>;
  readModels?(): Promise<void>;
  survey?(): Promise<string[]>;
  refreshAll?(connector: string): Promise<RefreshAnswer>;
  settingsChanged?(keys?: readonly string[]): void;
  hold?<T>(work: () => Promise<T>): Promise<T>;
}

export type ErasureContext = Pick<VerbContext, "folder" | "machine" | "db" | "blobs" | "ledger" | "settings" | "registry" | "now" | "out" | "going" | "calls" | "cutStreams" | "feedback">;

export type Verb = ((ctx: VerbContext, args: readonly string[]) => unknown) & {
  readonly usage: string;
};

export function holdHome<T>(ctx: Pick<VerbContext, "hold">, work: () => Promise<T>): Promise<T> {
  return ctx.hold === undefined ? work() : ctx.hold(work);
}

export class VerbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerbError";
  }
}

export function fail(message: string): never {
  throw new VerbError(message);
}

export function readOpsSettings(folder: SettingsFolder): OpsSettings {
  const { day, history, connectors, clients, sources, sites, unit, model, helpers, defaults, runners, door, privacy, screen_cutover_ms } = effective(folder).settings;
  return { day, history, connectors, clients, sources, sites, unit, model, helpers, defaults, runners, door, privacy, screen_cutover_ms };
}

export async function familyOf(ctx: VerbContext, name: string): Promise<Family> {
  const { families } = await ctx.registry();
  return families.find((family) => family.name === name) ?? fail(`no family ${name}; the home knows ${families.map((family) => family.name).join(", ") || "none"}`);
}

export function readersOf(registry: Registry, source: SourceRow | undefined, kind?: string): Family[] {
  return source === undefined ? [] : registry.families.filter((family) => readerOf(family.inputs, [source])(source.id, kind));
}
