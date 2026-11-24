import type { Connector } from "@lifestreamprotocol/connect/sdk";
import { store } from "./store.js";

export const appleReminders = {
  id: "apple-reminders", product: "apple-reminders", name: "Reminders", vendor: "apple", type: "plans", icon: "done", noun: ["reminder", "reminders"],
  gives: "Every reminder, with its list and due date.",
  records: "Every reminder with its list, due date, alerts and subtasks.",
  sources: [{ id: "apple-reminders:<account>:<unit>", read: "reminders-mac", arrives: "mac" }],
  backfill: { about: "Collects the reminders already in your lists." },
  mac: { app: "Reminders", grants: ["fullDiskAccess"], store },
} satisfies Connector;
