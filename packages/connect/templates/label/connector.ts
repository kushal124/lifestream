import type { Connector } from "@lifestreamprotocol/connect/sdk";

export const exampleLabel = {
  id: "example-label", product: "example", name: "Example", vendor: "example", noun: ["month", "months"],
  records: "How many notes you wrote each month.",
  sources: [{ id: "example:local:<home>", read: "example-label", arrives: "label" }],
  label: { labeler: "example-label" },
} satisfies Connector;
