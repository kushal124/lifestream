import type { Connector } from "@lifestreamprotocol/connect/sdk";

export const exampleBrowser = {
  id: "example-browser", product: "example", name: "Example", vendor: "example", type: "notes", noun: ["note", "notes"],
  records: "Every note's title and text, as the site shows them.",
  sources: [{ id: "example:<account>:browser", read: "example-browser", arrives: "chrome" }],
  acquirers: ["example-browser"],
  refresh: { default: "30m", min: "5m" },
  backfill: { pace: { default: "2m", min: "30s", max: "1h" }, about: "Collects the notes already on the site, a batch at a time." },
  chrome: { origin: "https://notes.example.com", probe: { url: "/api/me", has: "id", who: { id: "id", email: "email" } } },
} satisfies Connector;
