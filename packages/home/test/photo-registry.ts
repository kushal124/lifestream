import { people, type Labeler } from "@lifestreamprotocol/connect";
import { labelsFamily, messagesFamily, photosFamily, physicalFamily, voiceFamily } from "@lifestreamprotocol/families";
import type { Registry } from "../registry.js";
import type { Settings } from "../settings.js";
import { camerasRows, facesRows, fakeRows, voiceRows } from "./fakes.js";
import { RELEASE_FED } from "./fed.js";
import { connectors } from "../registry-home.js";

const physical = physicalFamily({ photos: RELEASE_FED.photos })(RELEASE_FED.physical);

const drawing: Labeler = {
  name: "synthetic-drawing", source: "audio:local:drawing", inputs: [],
  label: async () => null,
  draw: (photo) => Buffer.from(`synthetic drawing of ${photo}`),
};

export default function registry(settings: Settings): Registry {
  return {
    connectors: connectors(), readers: [fakeRows, facesRows, camerasRows, voiceRows, people.peopleHome],
    feeders: { "photos-ios-bundle": fakeRows.name, "voice-ios-bundle": voiceRows.name },
    families: [physical, photosFamily({ faces: false })(RELEASE_FED.photos), labelsFamily({ home: settings.unit, messages: RELEASE_FED.messages, mail: RELEASE_FED.mail })(RELEASE_FED.labels), messagesFamily({ books: RELEASE_FED.labels })(RELEASE_FED.messages), voiceFamily(RELEASE_FED.voice)],
    labelers: [drawing],
  };
}
