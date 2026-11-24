import { cameras } from "@lifestreamprotocol/connect";
import { labelsFamily, photosFamily, physicalFamily } from "@lifestreamprotocol/families";
import type { Registry } from "../registry.js";
import { connectors, feedersOf, readers } from "../registry-home.js";
import type { Settings } from "../settings.js";
import { RELEASE_FED } from "./fed.js";

const physical = physicalFamily({ photos: RELEASE_FED.photos })(RELEASE_FED.physical);

export default function registry(settings: Settings): Registry {
  const declared = connectors();
  return {
    connectors: declared,
    readers: readers(),
    feeders: feedersOf(declared),
    families: [physical, labelsFamily({ home: settings.unit, messages: RELEASE_FED.messages, mail: RELEASE_FED.mail })(RELEASE_FED.labels), photosFamily({ faces: true })(RELEASE_FED.photos)],
    labelers: settings.unit === null ? [] : [cameras.camerasLabeler({ unit: settings.unit, photos: RELEASE_FED.photos })],
  };
}
