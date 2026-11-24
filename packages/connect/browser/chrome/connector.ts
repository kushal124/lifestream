import type { Connector } from "@lifestreamprotocol/connect/sdk";
import { store } from "./store.js";

export const chrome = {
  id: "chrome", product: "chrome", name: "Chrome", vendor: "google", type: "web", noun: ["page", "pages"], counts: ["page-visit"], counted_by: "web",
  gives: "Every page, search and download.",
  records: "Every visit, search and download, in each profile.",
  sources: [{ id: "chrome:<account>:<unit>", read: "chrome-history", arrives: "mac" }],
  backfill: { about: "Catches up on Chrome’s history, as far back as it goes." },
  mac: { app: "Google Chrome", grants: [], store },
} satisfies Connector;
