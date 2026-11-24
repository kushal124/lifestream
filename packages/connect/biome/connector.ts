import type { Connector } from "@lifestreamprotocol/connect/sdk";
import { appTimelineStore, nowPlayingStore } from "./store.js";

export const appTimeline = {
  id: "screen-time", product: "screen-time", name: "Screen Time", vendor: "apple", type: "device-activity", icon: "phone-screen",
  noun: ["app switch", "app switches"], counts: ["app-focus", "usage"], expect: "1d",
  gives: "Which app you were in, on Mac and iPhone.",
  records: "Each app coming to the front and leaving it, your devices' too.",
  sources: [
    { id: "screen-time:<account>:<unit>", read: "biome-app-in-focus", arrives: "mac" },
    { id: "screen-time:local:<unit>", read: "usage-ios-bundle", arrives: "phone" },
  ],
  backfill: { about: "Collects the app switches your Mac's log already holds." },
  mac: { grants: ["fullDiskAccess"], store: appTimelineStore },
  phone: {
    grants: ["screen-time"], misses: "the apps you used", domain: "usage",
    why: "Which app you were in, and when. So your days show how you spent your time on this iPhone.",
  },
  before: ["On your iPhone, turn on Screen Time › Share Across Devices."],
} satisfies Connector;

export const nowPlaying = {
  id: "now-playing", product: "now-playing", name: "Now playing", vendor: "apple", row: "Listening", type: "listening", noun: ["change", "changes"],
  gives: "Every song and podcast that played.",
  records: "Every play, pause and track change, your other devices' too.",
  sources: [{ id: "now-playing:<account>:<unit>", read: "biome-now-playing", arrives: "mac" }],
  backfill: { about: "Collects the plays your Mac's log already holds." },
  mac: { grants: ["fullDiskAccess"], store: nowPlayingStore },
} satisfies Connector;
