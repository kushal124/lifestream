import type { Connector } from "@lifestreamprotocol/connect/sdk";

export const devices = {
  id: "devices", product: "devices", name: "Devices", vendor: "lifestream", mentions: false, noun: ["camera", "cameras"],
  records: "Which cameras are yours, and when.",
  sources: [{ id: "devices:local:<home>", read: "devices-home", arrives: "owner" }],
} satisfies Connector;
