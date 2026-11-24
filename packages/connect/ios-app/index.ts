import type { Adapters, Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { physicalAdapters } from "./adapter-physical.js";
import { photosAdapters } from "./adapter-photos.js";
import { voiceAdapters } from "./adapter-voice.js";
import { checkin } from "./checkin.js";
import { notes } from "./notes.js";
import { camera, energy, location, motion, voice } from "./sensors.js";
import { location as locationConnector, motion as motionConnector, voiceNotes, camera as cameraConnector, checkin as checkinConnector, notes as notesConnector, energy as energyConnector } from "./connector.js";

export const contract = 3;
export const connectors: readonly Connector[] = [locationConnector, motionConnector, voiceNotes, cameraConnector, checkinConnector, notesConnector, energyConnector];
export const readers: Reader[] = [location, motion, voice, camera, energy, checkin, notes];

export const adapters: Readonly<Record<string, Adapters>> = merged([physicalAdapters, photosAdapters, voiceAdapters]);

function merged(files: readonly Readonly<Record<string, Adapters>>[]): Record<string, Adapters> {
  const all: Record<string, Adapters> = {};
  for (const file of files) for (const [id, given] of Object.entries(file)) all[id] = { ...all[id], ...given };
  return all;
}
