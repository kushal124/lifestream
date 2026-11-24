import { works, type Connector } from "@lifestreamprotocol/connect/sdk";

const LIFESTREAM_NOTES = { name: "Lifestream notes", gives: "What you write and snap in Lifestream.", icon: "compose" } as const;

const BEDTIMES = {
  "21:00": "21:00", "21:30": "21:30", "22:00": "22:00", "22:30": "22:30", "23:00": "23:00", "23:30": "23:30",
  "00:00": "00:00", "00:30": "00:30", "01:00": "01:00", "01:30": "01:30", "02:00": "02:00",
};

export const location = {
  id: "location", product: "location", name: "Location", vendor: "lifestream", type: "places", starter: true, noun: ["point", "points"], counts: ["fix"], expect: "1d",
  gives: "Where you go, point by point.",
  records: "Where you go, point by point, and where iOS left a gap.",
  sources: [{ id: "location:local:<unit>", read: "location-ios-bundle", arrives: "phone" }],
  fields: {
    precision: {
      kind: "choice", label: "Precision", options: { precise: "Precise", battery: "Battery saving" }, default: "precise",
      about: "Battery saving: where you stay and each move of a few hundred metres.",
    },
  },
  phone: {
    grants: ["location"], misses: "where you were",
    why: "Where you go, point by point. So your days show your places and the way between them.",
  },
} satisfies Connector;

export const motion = {
  id: "motion", product: "motion", name: "Motion", vendor: "lifestream", type: "places", icon: "walk", noun: ["activity", "activities"], counts: ["motion"], expect: "1d",
  gives: "When you walk, run, drive or stay still.",
  records: "When you walk, run, drive or stay still, and your daily steps.",
  sources: [{ id: "motion:local:<unit>", read: "motion-ios-bundle", arrives: "phone" }],
  phone: {
    grants: ["motion"], misses: "how you moved",
    why: "When you walk, run, drive or stay still, and your steps. So your days show how you moved.",
  },
} satisfies Connector;

export const voiceNotes = {
  id: "voice-notes", product: "voice-notes", name: "Voice notes", vendor: "lifestream", type: "voice", noun: ["voice note", "voice notes"],
  gives: "Each recording you make in Lifestream.",
  records: "Each voice note you start, as sound.",
  sources: [{ id: "voice-notes:local:<unit>", read: "voice-ios-bundle", arrives: "phone" }],
  processing: { voice: works.RECORDINGS },
  phone: { grants: [], domain: "voice" },
} satisfies Connector;

export const camera = {
  id: "camera", product: "camera", name: "Camera", vendor: "lifestream", type: "photos", joins: LIFESTREAM_NOTES, noun: ["photo", "photos"],
  gives: "Each photo you take in the app.",
  records: "Each photo you take with the app or attach to a note.",
  sources: [{ id: "camera:local:<unit>", read: "camera-ios-bundle", arrives: "phone" }],
  processing: { photos: works.LIBRARY_PHOTOS },
  phone: { grants: [] },
} satisfies Connector;

export const checkin = {
  id: "checkin", product: "checkin", name: "Check-ins", vendor: "lifestream", mentions: false, type: "check-ins", noun: ["check-in", "check-ins"], counts: ["report", "vigilance"],
  gives: "How you feel, asked twice a day.",
  records: "Your answers about your day, and your reaction-time tests.",
  sources: [{ id: "checkin:local:<unit>", read: "checkin-ios-bundle", arrives: "phone" }],
  fields: {
    prompts: { kind: "toggle", label: "Ask through the day", default: false, about: "Twice a day, at random, between waking and bedtime." },
    bedtime: { kind: "choice", label: "Bedtime", options: BEDTIMES, default: "23:30", about: "The day's check-in comes at this time." },
  },
  phone: { grants: ["notifications"], restore: { kinds: ["report", "vigilance"] } },
} satisfies Connector;

export const notes = {
  id: "notes", product: "notes", name: "Lifestream notes", vendor: "lifestream", type: "notes", joins: LIFESTREAM_NOTES, noun: ["note", "notes"], counts: ["note"],
  gives: "What you write and snap in Lifestream.",
  records: "Each note and folder you keep in the app, with what you attach.",
  sources: [{ id: "notes:local:<unit>", read: "notes-ios-bundle", arrives: "phone" }],
  phone: { grants: [], restore: { kinds: ["folder", "note"] } },
} satisfies Connector;

export const energy = {
  id: "energy", product: "energy", name: "Battery", vendor: "lifestream", type: "device-activity", hidden: true, noun: ["reading", "readings"], expect: "1d",
  records: "The app's battery cost, and iOS's energy and crash reports.",
  sources: [{ id: "energy:local:<unit>", read: "energy-ios-bundle", arrives: "phone" }],
  phone: { grants: [] },
} satisfies Connector;
