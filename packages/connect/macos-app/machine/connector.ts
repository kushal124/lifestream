import type { Connector } from "@lifestreamprotocol/connect/sdk";

export const machine = {
  id: "machine", product: "machine", name: "Mac events", vendor: "lifestream", type: "device-activity", icon: "work-mac", noun: ["event", "events"], expect: "1d",
  gives: "Sleep, wake, power and Wi-Fi.",
  records: "Sleep, wake, power, Wi-Fi, devices in use and what each allows.",
  sources: [
    { id: "machine:local:<unit>", read: "machine-events", arrives: "mac" },
    { id: "machine:local:<unit>", read: "machine-ios-bundle", arrives: "phone" },
  ],
  mac: { grants: [], sensor: true },
} satisfies Connector;
