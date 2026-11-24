import type { Connector } from "@lifestreamprotocol/connect/sdk";

export const exampleExport = {
  id: "example-export", product: "example", name: "Example", vendor: "example", type: "notes", noun: ["note", "notes"],
  records: "Every note in the download, with its title and text.",
  sources: [{ id: "example:<account>:export", read: "example-export", arrives: "upload" }],
  export: {
    recognise: ["**/notes*.json"],
    guide: [
      { words: "On Example's Settings page, press Download your data.", open: { label: "Open Example", url: "https://example.com/settings/download" } },
      { words: "Example emails you a link. Download the zip." },
    ],
  },
} satisfies Connector;
