import { works, type Connector } from "@lifestreamprotocol/connect/sdk";

export const coast = {
  id: "coast", product: "coast", name: "Coast", vendor: "coast", type: "device-activity", noun: ["frame", "frames"], counts: ["frame"], hidden: true,
  records: "Every frame Coast recorded, its text and the app in front.",
  sources: [{ id: "coast:local:<unit>", read: "coast", arrives: "poll" }],
  acquirers: ["coast"],
  refresh: { default: "1h", min: "1m" },
  backfill: { about: "Collects the frames Coast recorded before you connected it." },
  processing: { screen: works.SCREEN },
  fields: {
    database: { kind: "path", label: "Coast database" },
    videos: { kind: "path", label: "Coast videos folder" },
  },
} satisfies Connector;
