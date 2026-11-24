import type { Connector } from "@lifestreamprotocol/connect/sdk";
import { store } from "./store.js";

export const appleNotes = {
  id: "apple-notes", product: "apple-notes", name: "Notes", vendor: "apple", type: "notes", noun: ["note", "notes"],
  gives: "Every note you keep, with its folder.",
  records: "Every note's text, folder and attachments.",
  sources: [{ id: "apple-notes:<account>:<unit>", read: "notes-mac", arrives: "mac" }],
  backfill: { about: "Collects the notes you already keep." },
  mac: { app: "Notes", grants: ["fullDiskAccess"], store },
} satisfies Connector;
