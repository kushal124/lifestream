import type { Connector } from "@lifestreamprotocol/connect/sdk";
import { store } from "./store.js";

export const appleCalendar = {
  id: "apple-calendar", product: "apple-calendar", name: "Calendar", vendor: "apple", type: "plans", starter: true, noun: ["event", "events"],
  gives: "Every event, with its place and people.",
  records: "Every event with its place, people, repeats and alerts.",
  sources: [{ id: "apple-calendar:<account>:<unit>", read: "calendar-mac", arrives: "mac" }],
  backfill: { about: "Collects the events already in your calendars." },
  mac: { app: "Calendar", grants: ["fullDiskAccess"], store },
} satisfies Connector;
