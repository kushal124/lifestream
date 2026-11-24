import type { Connector } from "@lifestreamprotocol/connect/sdk";

export const appleHealth = {
  id: "apple-health", product: "apple-health", name: "Health", vendor: "apple", cloud: "iCloud", type: "health", starter: true, noun: ["sample", "samples"], counts: ["sample"],
  gives: "Sleep, steps, heart, and anything else you allow.",
  records: "Every sample you allow, with State of Mind and medications.",
  sources: [
    { id: "apple-health:<account>:cloud", read: "health-ios-bundle", arrives: "phone" },
    { id: "apple-health:<account>:cloud", read: "health-export", arrives: "upload", lacks: "State of Mind, medication doses, the medication list and deletions" },
  ],
  backfill: { about: "Collects the samples Health already keeps." },
  phone: {
    grants: ["health"], misses: "sleep, steps and heart", domain: "health",
    why: "Sleep, steps, heart and anything else you choose. So your days show how you slept and how you felt.",
  },
} satisfies Connector;
