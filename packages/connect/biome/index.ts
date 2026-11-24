import type { Adapters, Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { healthAdapters } from "./adapter-health.js";
import { listeningAdapters } from "./adapter-listening.js";
import { phoneAdapters } from "./adapter-phone.js";
import { biomeAppInFocus, biomeNowPlaying } from "./reader.js";
import { usage } from "./usage.js";
import { appTimeline, nowPlaying } from "./connector.js";

export const contract = 3;
export const connectors: readonly Connector[] = [appTimeline, nowPlaying];
export const readers: Reader[] = [biomeAppInFocus, biomeNowPlaying, usage];

export const adapters: Readonly<Record<string, Adapters>> = merged([healthAdapters, listeningAdapters, phoneAdapters]);

function merged(files: readonly Readonly<Record<string, Adapters>>[]): Record<string, Adapters> {
  const all: Record<string, Adapters> = {};
  for (const file of files) for (const [id, given] of Object.entries(file)) all[id] = { ...all[id], ...given };
  return all;
}
