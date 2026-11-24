import type { Connector } from "@lifestreamprotocol/connect/sdk";
import { store } from "./store.js";

export const codex = {
  id: "codex", product: "codex", name: "Codex", vendor: "openai", type: "ai", icon: "coding-agent", noun: ["message", "messages"],
  gives: "Every session log, archived ones too.",
  records: "Every line of every session log, archived ones too.",
  sources: [{ id: "codex:local:<unit>", read: "codex-sessions", arrives: "mac" }],
  backfill: { about: "Collects the sessions Codex already keeps, archived ones too." },
  mac: { grants: [], store },
} satisfies Connector;
