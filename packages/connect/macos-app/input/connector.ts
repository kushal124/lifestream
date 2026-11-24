import type { Connector } from "@lifestreamprotocol/connect/sdk";

export const input = {
  id: "input", product: "input", name: "Keyboard and mouse", vendor: "lifestream", type: "device-activity", icon: "input", noun: ["minute", "minutes"], expect: "1d",
  gives: "What you typed and clicked, and in which app.",
  records: "Your keys, clicks and scrolls, and which app they went to. Password fields are never recorded.",
  sources: [{ id: "input:local:<unit>", read: "input-events", arrives: "mac" }],
  mac: { grants: ["accessibility"], sensor: true },
} satisfies Connector;
