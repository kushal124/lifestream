import type { Guard, ReaderOutput } from "@lifestreamprotocol/core";
import type { Reader } from "@lifestreamprotocol/connect";
import type { Connector } from "@lifestreamprotocol/connect/sdk";
import { connectorsWith, families, type FolderAdapters } from "../registry-home.js";
import type { Registry, RegistryHome } from "../registry.js";
import type { Settings } from "../settings.js";

const accept: Guard = () => [];
const RELEASE = new Set(["messages", "physical", "calendar", "labels", "calls", "health", "photos", "mail", "voice"]);

const rows: Reader = {
  name: "canned-days-rows",
  kinds: { msg: accept, chat: accept, pushname: accept, contact: accept, fix: accept, place: accept, event: accept, call: accept, sample: accept, workout: accept, txn: accept, img: accept, mailmsg: accept, usage: accept, voice: accept },
  async *read(delivery, files): AsyncIterable<ReaderOutput> {
    const file = delivery.files.find((each) => each.path === "rows.ndjson");
    if (file === undefined) return;
    for (const line of files.text(file.blob).split("\n")) if (line.trim() !== "") yield JSON.parse(line) as ReaderOutput;
  },
};

export const BANK_CONNECTOR = {
  id: "synthetic-bank", product: "synthetic-bank", name: "Synthetic Bank", vendor: "synthetic", type: "money", noun: ["transaction", "transactions"],
  records: "Every synthetic transaction.", sources: [{ id: "synthetic-bank:<account>:export", read: "canned-days-rows", arrives: "upload" }],
} satisfies Connector;

const banked: FolderAdapters = { connectors: [BANK_CONNECTOR], adapters: { "synthetic-bank": { money: { version: "1", kinds: ["txn"] } } } };

export default function registry(settings: Settings, home: RegistryHome): Registry {
  return {
    connectors: connectorsWith([BANK_CONNECTOR]), readers: [rows], feeders: { "voice-ios-bundle": rows.name },
    families: [
      ...families(settings, home.root).filter((family) => RELEASE.has(family.name)),
      ...families(settings, home.root, [banked]).filter((family) => family.name === "money"),
    ],
  };
}
