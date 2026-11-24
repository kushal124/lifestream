import type { Guard, Json, ReaderOutput } from "@lifestreamprotocol/core";
import { people, type Reader } from "@lifestreamprotocol/connect";
import { aiFamily, labelsFamily, mailFamily, messagesFamily } from "@lifestreamprotocol/families";
import type { Registry } from "../registry.js";
import type { Settings } from "../settings.js";
import { connectors } from "../registry-home.js";
import { RELEASE_FED } from "./fed.js";

const accept: Guard = () => [];
const KINDS = ["msg", "chat", "pushname", "business", "contact", "mailmsg", "cluster", "named", "maybe", "scan"];

const rows: Reader = {
  name: "people-rows",
  kinds: Object.fromEntries(KINDS.map((kind) => [kind, accept])),
  async *read(delivery, files): AsyncIterable<ReaderOutput> {
    const file = delivery.files.find((each) => each.path === "rows.ndjson");
    if (file === undefined) return;
    for (const line of files.text(file.blob).split("\n")) {
      if (line.trim() === "") continue;
      const row = JSON.parse(line) as { kind: string; key: string; content?: Json; at?: number; blobs?: string[]; gone?: true };
      if (row.gone === true) {
        yield { kind: row.kind, key: row.key, content: null, gone: true };
        continue;
      }
      yield {
        kind: row.kind, key: row.key, content: row.content!,
        ...(row.at === undefined ? {} : { time: { start_ms: row.at, precision: "ms" as const } }),
        ...(row.blobs === undefined ? {} : { blobs: row.blobs }),
      };
    }
  },
};

export default function registry(settings: Settings): Registry {
  return { connectors: connectors(), readers: [rows, { ...rows, name: "faces" }, people.peopleHome], families: [messagesFamily({ books: RELEASE_FED.labels })(RELEASE_FED.messages), mailFamily({ books: RELEASE_FED.labels })(RELEASE_FED.mail), labelsFamily({ home: settings.unit, messages: RELEASE_FED.messages, mail: RELEASE_FED.mail })(RELEASE_FED.labels), { ...aiFamily(RELEASE_FED.ai), adapters: RELEASE_FED.ai }] };
}
