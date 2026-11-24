import type { Connector } from "@lifestreamprotocol/connect/sdk";
import { store } from "./store.js";

export const claudeCode = {
  id: "claude-code", product: "claude-code", name: "Claude Code", vendor: "anthropic", type: "ai", icon: "coding-agent", noun: ["message", "messages"],
  gives: "Every session log, with tool output.",
  records: "Every session log line, with tool output and sub-agents' logs.",
  sources: [{ id: "claude-code:local:<unit>", read: "claude-code-sessions", arrives: "mac" }],
  backfill: { about: "Catches up on sessions already on this Mac." },
  mac: { grants: [], store },
} satisfies Connector;
