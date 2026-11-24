import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Guard, Json, ReaderOutput } from "@lifestreamprotocol/core";
import { devices, faces, people, places, type Reader } from "@lifestreamprotocol/connect";
import { labelsFamily, mailFamily, messagesFamily, photosFamily, physicalFamily } from "@lifestreamprotocol/families";
import type { Registry, RegistryHome } from "../registry.js";
import { connectors, facesSettings } from "../registry-home.js";
import type { Settings } from "../settings.js";
import { RELEASE_ADAPTERS, RELEASE_FED } from "./fed.js";

const physical = physicalFamily({ photos: RELEASE_FED.photos })(RELEASE_FED.physical);

const accept: Guard = () => [];

const rows: Reader = {
  name: "dashboard-rows",
  kinds: { msg: accept, chat: accept, pushname: accept, contact: accept, person: accept, fix: accept, mailmsg: accept, img: accept, photo: accept, camera: accept },
  async *read(delivery, files): AsyncIterable<ReaderOutput> {
    const file = delivery.files.find((each) => each.path === "rows.ndjson");
    if (file === undefined) return;
    for (const line of files.text(file.blob).split("\n")) {
      if (line.trim() === "") continue;
      const row = JSON.parse(line) as { kind: string; key: string; content: Json; at?: number; blobs?: string[] };
      yield {
        kind: row.kind, key: row.key, content: row.content,
        ...(row.at === undefined ? {} : { time: { start_ms: row.at, precision: "ms" as const } }),
        ...(row.blobs === undefined ? {} : { blobs: row.blobs }),
      };
    }
  },
};

export default function registry(settings: Settings, home: RegistryHome): Registry {
  const folder = home.root;
  const families = [messagesFamily({ books: RELEASE_FED.labels })(RELEASE_FED.messages), physical, mailFamily({ books: RELEASE_FED.labels })(RELEASE_FED.mail), photosFamily({ faces: true })(RELEASE_FED.photos), labelsFamily({ home: settings.unit, messages: RELEASE_FED.messages, mail: RELEASE_FED.mail })(RELEASE_FED.labels)];
  const engine = join(folder, "engine", "face-engine");
  const labeler = existsSync(engine) ? facesSettings(settings, home, RELEASE_FED) : null;
  const readers = [rows, people.peopleHome, ...places.readers, ...devices.readers, ...faces.readers];
  if (labeler === null) return { connectors: connectors(), readers, families, adapters: RELEASE_ADAPTERS };
  return { connectors: connectors(), readers, families, adapters: RELEASE_ADAPTERS, labelers: [faces.facesLabeler({ ...labeler, engine })] };
}
