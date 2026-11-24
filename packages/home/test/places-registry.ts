import { people, places } from "@lifestreamprotocol/connect";
import { labelsFamily, photosFamily, physicalFamily } from "@lifestreamprotocol/families";
import type { Registry } from "../registry.js";
import type { Settings } from "../settings.js";
import { camerasRows, facesRows, fakeRows, phoneReaders } from "./fakes.js";
import { connectors } from "../registry-home.js";
import { RELEASE_FED } from "./fed.js";

const physical = physicalFamily({ photos: RELEASE_FED.photos })(RELEASE_FED.physical);

export default function registry(settings: Settings): Registry {
  return {
    connectors: connectors(), readers: [fakeRows, facesRows, camerasRows, people.peopleHome, ...phoneReaders(), ...places.readers],
    families: [physical, photosFamily({ faces: true })(RELEASE_FED.photos), labelsFamily({ home: settings.unit, messages: RELEASE_FED.messages, mail: RELEASE_FED.mail })(RELEASE_FED.labels)],
  };
}
