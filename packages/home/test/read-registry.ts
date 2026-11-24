import { aiFamily, labelsFamily, messagesFamily } from "@lifestreamprotocol/families";
import type { Registry } from "../registry.js";
import { connectors } from "../registry-home.js";
import type { Settings } from "../settings.js";
import { fakeRows, notesFamily, screenFamily } from "./fakes.js";
import { RELEASE_FED } from "./fed.js";

export default function registry(settings: Settings): Registry {
  return {
    connectors: connectors(), readers: [fakeRows],
    families: [
      notesFamily({ text: "1" }), messagesFamily({ books: RELEASE_FED.labels })(RELEASE_FED.messages),
      labelsFamily({ home: settings.unit, messages: RELEASE_FED.messages, mail: RELEASE_FED.mail })(RELEASE_FED.labels),
      { ...aiFamily(RELEASE_FED.ai), adapters: RELEASE_FED.ai }, screenFamily({ index: true }),
    ],
  };
}
