import type { Connector } from "@lifestreamprotocol/connect/sdk";
import { store } from "./store.js";

export const appleCalls = {
  id: "apple-calls", product: "apple-calls", name: "Calls", vendor: "apple", type: "calls", noun: ["call", "calls"],
  gives: "Who you called, when, and for how long.",
  records: "Each call's number or address, direction, time and length.",
  sources: [
    { id: "apple-calls:<account>:<unit>", read: "callhistory-mac", arrives: "mac" },
    { id: "apple-calls:<account>:<unit>", read: "callhistory-mac", arrives: "upload" },
  ],
  backfill: { about: "Collects the calls already in your call history." },
  mac: { app: "FaceTime", grants: ["fullDiskAccess"], store },
  before: ["On your iPhone, turn on Calls on Other Devices."],
  export: { kind: "iphone-backup", product: { id: "apple-calls", name: "Calls" }, recognise: ["**/apple-calls/callhistory.sqlite"] },
} satisfies Connector;
