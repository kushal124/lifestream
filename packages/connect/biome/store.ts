import type { MacStore } from "@lifestreamprotocol/connect/sdk";

export const appTimelineStore = {
  feeder: "biome-app-in-focus",
  name: "screen_time",
  held: "~/Library/Biome/streams/restricted/App.InFocus/",
  account: "apple-id",
  engine: { kind: "biome", stream: "App.InFocus" },
} satisfies MacStore;

export const nowPlayingStore = {
  feeder: "biome-now-playing",
  name: "now_playing",
  held: "~/Library/Biome/streams/restricted/Media.NowPlaying/",
  account: "apple-id",
  engine: { kind: "biome", stream: "Media.NowPlaying" },
} satisfies MacStore;
