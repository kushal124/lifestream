import type { Connector } from "@lifestreamprotocol/connect/sdk";

export const stations = {
  id: "stations", product: "stations", name: "Stations", vendor: "lifestream", mentions: false, noun: ["tab", "tabs"],
  records: "Which Chrome tabs Lifestream opened to bring your data in.",
  sources: [{ id: "stations:local:<home>", read: "stations-home", arrives: "owner" }],
} satisfies Connector;
