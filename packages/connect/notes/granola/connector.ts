import type { Connector } from "@lifestreamprotocol/connect/sdk";

export const granola = {
  id: "granola", product: "granola", name: "Granola", vendor: "granola", type: "notes", icon: "meeting",
  noun: ["meeting", "meetings"], counts: ["note"],
  gives: "Every meeting’s summary and who was there.",
  records: "Every meeting's summary, your notes and who was there.",
  sources: [{ id: "granola:<account>:cloud", read: "granola", arrives: "poll", feeders: ["granola-api", "granola-mcp"] }],
  acquirers: ["granola-api", "granola-mcp"],
  refresh: { default: "5m", min: "1m" },
  backfill: { about: "Collects your past meetings, a batch at a time." },
  fields: {
    account: { kind: "email", label: "Granola email", account: true },
    key: { kind: "secret", label: "API key", secret: "granola" },
    signin: { kind: "secret", label: "Sign-in", secret: "granola.signin" },
  },
  signin: [
    {
      acquirer: "granola-mcp", way: "device", field: "signin", label: "Sign in with Granola",
      about: "Any plan. Free keeps 30 days, no transcripts.",
      note: "Opens Granola in your browser.",
      issuer: "https://mcp-auth.granola.ai", scope: "openid email offline_access", resource: "https://mcp.granola.ai/mcp",
    },
    {
      acquirer: "granola-api", way: "key", fields: ["account", "key"], label: "Use an API key",
      check: { url: "https://public-api.granola.ai/v1/notes?page_size=1" },
      about: "Business or Enterprise. Every meeting, with transcripts.",
      steps: [{ title: "Make an API key", words: "In Granola, open Settings › Connectors › API keys, and make a key with Personal notes only." }],
    },
  ],
} satisfies Connector;
