import type { Connector } from "@lifestreamprotocol/connect/sdk";
import { store } from "./store.js";

export const wisprFlow = {
  id: "wispr-flow", product: "wispr-flow", name: "Wispr Flow", vendor: "wispr", type: "voice", joins: { name: "Dictation", gives: "What you dictate with Wispr Flow or Aqua Voice.", icon: "voice-note" }, noun: ["dictation", "dictations"],
  gives: "Each dictation, with its app.",
  records: "Each dictation's text, its app, its audio and its screenshot.",
  sources: [{ id: "wispr-flow:<account>:<unit>", read: "wispr-flow-mac", arrives: "mac" }],
  backfill: { about: "Collects the dictations Wispr Flow already keeps." },
  mac: { app: "Wispr Flow", grants: [], store },
} satisfies Connector;
