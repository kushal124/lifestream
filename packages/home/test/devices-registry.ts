import { cameras, devices } from "@lifestreamprotocol/connect";
import { labelsFamily } from "@lifestreamprotocol/families";
import type { Registry } from "../registry.js";
import type { Settings } from "../settings.js";
import { fakeRows } from "./fakes.js";
import { connectors } from "../registry-home.js";
import { RELEASE_FED } from "./fed.js";

export default function registry(settings: Settings): Registry {
  return {
    connectors: connectors(), readers: [fakeRows, ...cameras.readers, ...devices.readers],
    feeders: { "photos-ios-bundle": fakeRows.name },
    families: [labelsFamily({ home: settings.unit, messages: RELEASE_FED.messages, mail: RELEASE_FED.mail })(RELEASE_FED.labels)],
    labelers: settings.unit === null ? [] : [cameras.camerasLabeler({ unit: settings.unit, photos: RELEASE_FED.photos })],
  };
}
