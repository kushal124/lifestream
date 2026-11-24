import type { Connector } from "@lifestreamprotocol/connect/sdk";

export const x = {
  id: "x", product: "x", name: "X", vendor: "x", type: "social", hidden: true,
  records: "Your posts, deleted ones X keeps, likes and direct messages.",
  sources: [{ id: "x:<account>:export", read: "x-archive", arrives: "upload" }],
} satisfies Connector;
