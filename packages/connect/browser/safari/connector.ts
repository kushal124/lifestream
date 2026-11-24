import type { Connector } from "@lifestreamprotocol/connect/sdk";
import { store } from "./store.js";

export const safari = {
  id: "safari", product: "safari", name: "Safari", vendor: "apple", type: "web", noun: ["page", "pages"], counts: ["page-visit"],
  gives: "Every page you visit, your other devices’ too.",
  records: "Every visit, your synced devices' too, and their open tabs.",
  sources: [{ id: "safari:<account>:<unit>", read: "safari-history", arrives: "mac" }],
  backfill: { about: "Collects the history Safari already keeps, as far back as it goes." },
  mac: { app: "Safari", grants: ["fullDiskAccess"], store },
} satisfies Connector;
