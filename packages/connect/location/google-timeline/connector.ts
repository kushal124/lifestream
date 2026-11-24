import type { Connector } from "@lifestreamprotocol/connect/sdk";

export const googleTimeline = {
  id: "google-timeline", product: "google-timeline", name: "Google Maps Timeline", vendor: "google", mentions: false, type: "places",
  gives: "Your past visits and trips, from Google Maps.",
  records: "Every visit, trip and path in the export, with its places.",
  sources: [{ id: "google-timeline:<account>:export", read: "google-timeline", arrives: "upload" }],
  export: {
    recognise: ["*.json"],
    takes: "Google Maps exports it at once, on your phone",
    wait: "At once",
    file: "file",
    guide: [
      { title: "Export from Google Maps", words: "On your phone, open Google Maps › Settings › Personal content › Export Timeline data." },
      { title: "Save the file", words: "Save it to Files, then choose it here." },
    ],
  },
} satisfies Connector;
