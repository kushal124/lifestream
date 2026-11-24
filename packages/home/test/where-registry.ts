import type { Guard, ReaderOutput } from "@lifestreamprotocol/core";
import { places, type Reader } from "@lifestreamprotocol/connect";
import { labelsFamily, photosFamily, physicalFamily } from "@lifestreamprotocol/families";
import type { Registry } from "../registry.js";
import type { Settings } from "../settings.js";
import { connectors } from "../registry-home.js";
import { RELEASE_FED } from "./fed.js";

const physical = physicalFamily({ photos: RELEASE_FED.photos })(RELEASE_FED.physical);

const object: Guard = (content) => typeof content === "object" && content !== null && !Array.isArray(content) ? [] : ["content is an object"];

const rows: Reader = {
  name: "where-rows",
  kinds: { img: object, photo: object, camera: object, "place-visit": object, trip: object, fix: object },
  async *read(delivery, files): AsyncIterable<ReaderOutput> {
    const file = delivery.files.find((each) => each.path === "rows.ndjson");
    if (file === undefined) return;
    for (const line of files.text(file.blob).split("\n")) if (line.trim() !== "") yield JSON.parse(line) as ReaderOutput;
  },
};

export default function registry(settings: Settings): Registry {
  return {
    connectors: connectors(), readers: [rows, ...places.readers],
    families: [physical, labelsFamily({ home: settings.unit, messages: RELEASE_FED.messages, mail: RELEASE_FED.mail })(RELEASE_FED.labels), photosFamily({ faces: true })(RELEASE_FED.photos)],
  };
}
