import type { Connector } from "@lifestreamprotocol/connect/sdk";
import { store } from "./store.js";

export const exampleStore = {
  id: "example-store", product: "example-store", name: "Example Store", vendor: "example", type: "notes", noun: ["note", "notes"],
  records: "Every note's title and text, as the app keeps them.",
  sources: [{ id: "example-store:local:<unit>", read: "example-store", arrives: "mac" }],
  backfill: { about: "Collects the notes the app already keeps." },
  mac: { app: "Example Store", grants: [], store },
} satisfies Connector;
