import type { Connector } from "@lifestreamprotocol/connect/sdk";

export const places = {
  id: "places", product: "places", name: "Places", vendor: "lifestream", products: { "google-maps": { name: "Google Maps", vendor: "google" } }, mentions: false,
  records: "The places you name, where each is, and Google's names for them.",
  sources: [
    { id: "places:local:<home>", read: "places-home", arrives: "owner" },
    { id: "google-maps:<account>:lookup", read: "google-place-names", arrives: "owner" },
  ],
} satisfies Connector;
