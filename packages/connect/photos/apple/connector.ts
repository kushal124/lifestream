import { works, type Connector } from "@lifestreamprotocol/connect/sdk";

export const applePhotos = {
  id: "apple-photos", product: "apple-photos", name: "Photos", vendor: "apple", type: "photos", starter: true, noun: ["photo", "photos"], counts: ["img"], mirror: true,
  gives: "Every photo and video, with time and place.",
  records: "Every photo and video with its times, place, files and edits.",
  sources: [
    { id: "apple-photos:<account>:<unit>", read: "photos-mac-bundle", arrives: "mac" },
    { id: "apple-photos:<account>:<unit>", read: "photos-ios-bundle", arrives: "phone" },
  ],
  backfill: { about: "Catches up on the photos already in your library." },
  processing: { photos: works.LIBRARY_PHOTOS },
  mac: { grants: ["photos"], library: true },
  phone: {
    grants: ["photos"], misses: "your photos", domain: "photos", library: true,
    why: "Every photo and video, with when and where you took it. So your days have their pictures.",
  },
} satisfies Connector;
