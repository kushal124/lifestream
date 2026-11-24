import { works, type Connector } from "@lifestreamprotocol/connect/sdk";

export const googlePhotos = {
  id: "google-photos", product: "google-photos", name: "Google Photos", vendor: "google", type: "photos", noun: ["photo", "photos"],
  gives: "Every photo and video in your Google account.",
  records: "Every photo and video in the export, with Google's metadata.",
  sources: [{ id: "google-photos:<account>:export", read: "google-photos-takeout", arrives: "upload" }],
  export: { recognise: ["Takeout/Google Photos/**"], product: { id: "google-photos", name: "Google Photos" } },
  processing: { photos: works.LIBRARY_PHOTOS },
} satisfies Connector;
