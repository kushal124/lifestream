import type { Connector } from "@lifestreamprotocol/connect/sdk";

export const people = {
  id: "people", product: "people", name: "People", vendor: "lifestream", mentions: false,
  records: "Who the people you name are, their handles and their faces.",
  sources: [{ id: "people:local:<home>", read: "people-home", arrives: "owner" }],
} satisfies Connector;
