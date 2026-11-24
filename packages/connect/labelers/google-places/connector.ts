import type { Connector } from "@lifestreamprotocol/connect/sdk";

export const googlePlaces = {
  id: "google-places", product: "google-places", name: "Google Places", vendor: "google", mentions: false, noun: ["answer", "answers"],
  records: "Names for places you haven’t named.",
  sources: [{ id: "google-places:<home>:nearby", read: "google-places", arrives: "label" }],
  label: { labeler: "google-places" },
  fields: { key: { kind: "secret", label: "Google API key", secret: "google-places" } },
} satisfies Connector;
