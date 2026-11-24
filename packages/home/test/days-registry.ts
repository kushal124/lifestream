import type { Guard, ReaderOutput } from "@lifestreamprotocol/core";
import type { Reader } from "@lifestreamprotocol/connect";
import { calendarFamily, labelsFamily, messagesFamily, physicalFamily } from "@lifestreamprotocol/families";
import type { Registry } from "../registry.js";
import type { Settings } from "../settings.js";
import { connectors } from "../registry-home.js";
import { RELEASE_FED } from "./fed.js";

const accept: Guard = () => [];

const rows: Reader = {
  name: "days-rows",
  kinds: { msg: accept, chat: accept, fix: accept, event: accept },
  async *read(delivery, files): AsyncIterable<ReaderOutput> {
    const file = delivery.files.find((each) => each.path === "rows.ndjson");
    if (file === undefined) return;
    for (const line of files.text(file.blob).split("\n")) if (line.trim() !== "") yield JSON.parse(line) as ReaderOutput;
  },
};

export default function registry(settings: Settings): Registry {
  return {
    connectors: connectors(),
    readers: [rows],
    families: [
      messagesFamily({ books: RELEASE_FED.labels })(RELEASE_FED.messages),
      physicalFamily({ photos: RELEASE_FED.photos })(RELEASE_FED.physical),
      calendarFamily({ books: RELEASE_FED.labels })(RELEASE_FED.calendar),
      labelsFamily({ home: settings.unit, messages: RELEASE_FED.messages, mail: RELEASE_FED.mail })(RELEASE_FED.labels),
    ],
  };
}
