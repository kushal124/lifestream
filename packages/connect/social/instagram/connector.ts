import type { Connector } from "@lifestreamprotocol/connect/sdk";

export const instagram = {
  id: "instagram", product: "instagram", name: "Instagram", vendor: "meta", type: "social", hidden: true,
  records: "Your posts, stories, comments, likes, follows and messages.",
  sources: [{ id: "instagram:<account>:export", read: "instagram-export", arrives: "upload" }],
} satisfies Connector;
