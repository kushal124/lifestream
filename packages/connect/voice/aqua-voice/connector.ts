import type { Connector } from "@lifestreamprotocol/connect/sdk";
import { store } from "./store.js";

export const aquaVoice = {
  id: "aqua-voice", product: "aqua-voice", name: "Aqua Voice", vendor: "aqua", type: "voice", joins: { name: "Dictation", gives: "What you dictate with Wispr Flow or Aqua Voice.", icon: "voice-note" }, noun: ["dictation", "dictations"],
  gives: "Your last 100 dictations, with audio.",
  records: "Your last 100 dictations, as heard and as written, with audio.",
  sources: [{ id: "aqua-voice:<account>:<unit>", read: "aqua-voice-mac", arrives: "mac" }],
  backfill: { about: "Collects the dictations Aqua Voice still keeps, its last 100." },
  mac: { app: "Aqua Voice", grants: [], store },
} satisfies Connector;
