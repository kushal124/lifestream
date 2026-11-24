import type { Connector } from "@lifestreamprotocol/connect/sdk";

export const groups = {
  id: "groups", product: "groups", name: "Groups", vendor: "lifestream", noun: ["month", "months"],
  records: "Which days each of your groups was yours, a month at a time.",
  sources: [{ id: "groups:local:<home>", read: "groups", arrives: "label" }],
  label: { labeler: "groups" },
} satisfies Connector;
