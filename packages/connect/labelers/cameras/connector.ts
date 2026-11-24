import type { Connector } from "@lifestreamprotocol/connect/sdk";

export const cameras = {
  id: "cameras", product: "cameras", name: "Cameras", vendor: "lifestream", mentions: false, noun: ["photo", "photos"], counts: ["photo"],
  records: "Which camera took each photo, and how many each one took.",
  sources: [{ id: "cameras:local:<home>", read: "cameras", arrives: "label" }],
  label: { labeler: "cameras" },
} satisfies Connector;
