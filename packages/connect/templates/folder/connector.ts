import type { Connector } from "@lifestreamprotocol/connect/sdk";

export const exampleFolder = {
  id: "example-folder", product: "example-folder", name: "Example", vendor: "example", type: "notes", noun: ["note", "notes"],
  records: "Every note in the folder, its title and text.",
  sources: [{ id: "example-folder:local:<unit>", read: "example-folder", arrives: "poll" }],
  acquirers: ["example-folder"],
  refresh: { default: "5m", min: "1m" },
  backfill: { about: "Collects the notes already in the folder, not only those written from now on." },
  fields: {
    folder: { kind: "path", folder: true, label: "Notes folder", about: "The folder Example keeps your notes in, on this Mac." },
  },
} satisfies Connector;
