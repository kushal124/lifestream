import type { Connector } from "@lifestreamprotocol/connect/sdk";
import { store } from "./store.js";

export const exampleMacApp = {
  id: "example-mac-app", product: "example", name: "Example", vendor: "example", type: "notes", noun: ["note", "notes"],
  records: "Every note's title and text, as the app keeps them.",
  sources: [{ id: "example:<account>:<unit>", read: "example-mac-app", arrives: "mac" }],
  backfill: { about: "Collects the notes the app already keeps." },
  mac: { app: "Example", grants: ["fullDiskAccess"], store },
} satisfies Connector;
