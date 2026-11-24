import type { Connector } from "@lifestreamprotocol/connect/sdk";

export const exampleApi = {
  id: "example-api", product: "example", name: "Example", vendor: "example", type: "notes", noun: ["note", "notes"],
  records: "Every note's title and text.",
  sources: [{ id: "example:<account>:cloud", read: "example-api", arrives: "poll" }],
  acquirers: ["example-api"],
  refresh: { default: "5m", min: "1m" },
  backfill: { about: "Collects the notes already in your account, a batch at a time." },
  fields: {
    account: { kind: "email", label: "Example email", account: true },
    key: { kind: "secret", label: "API key", secret: "example-api" },
  },
  signin: [{
    acquirer: "example-api", way: "key", fields: ["key"], label: "Use an API key", check: { url: "https://api.example.com/v1/me", account: "email" },
    steps: [{ title: "Make an API key", words: "In Example, open Settings › API, and make a key that reads your notes." }],
  }],
} satisfies Connector;
