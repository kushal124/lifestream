import type { Connector } from "@lifestreamprotocol/connect/sdk";

export const facebook = {
  id: "facebook", product: "facebook", name: "Facebook", vendor: "meta", type: "social", hidden: true,
  records: "Your posts, comments, likes, follows and Messenger threads.",
  sources: [{ id: "facebook:<account>:export", read: "facebook-export", arrives: "upload" }],
} satisfies Connector;
