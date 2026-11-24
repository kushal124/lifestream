import type { Connector } from "@lifestreamprotocol/connect/sdk";

export const examplePhone = {
  id: "example-phone", product: "example", name: "Example", vendor: "example", type: "notes", noun: ["note", "notes"],
  records: "Each note you write in the app, as you wrote it.",
  sources: [{ id: "example:local:<unit>", read: "example-phone", arrives: "phone" }],
  phone: { grants: [] },
} satisfies Connector;
