import type { Connector } from "@lifestreamprotocol/connect/sdk";

export const upload = {
  id: "upload", product: "upload", name: "Files you hand in", vendor: "lifestream", icon: "share", noun: ["file", "files"],
  records: "Each file you hand in, whole, with its name, path and dates.",
  sources: [
    { id: "upload:local:<unit>", read: "upload", arrives: "mac" },
    { id: "upload:local:<unit>", read: "upload", arrives: "phone" },
  ],
  mac: { grants: [] },
  phone: { grants: [] },
} satisfies Connector;
