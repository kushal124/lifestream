import type { MacStore } from "@lifestreamprotocol/connect/sdk";

export const store = {
  feeder: "aqua-voice-mac",
  name: "aqua_voice",
  held: "~/Library/Application Support/Aqua Voice/",
  account: {
    at: "historyByUserId",
    json_keys: "~/Library/Application Support/Aqua Voice/history.json",
    where: [{ at: "version", equals: 1 }, { at: "historyByUserId", object: true }],
  },
  spelled: false,
  engine: {
    kind: "file",
    files: [{ member: "history.json", path: "~/Library/Application Support/Aqua Voice/history.json" }],
    names: {
      at: "historyByUserId.<account>.[].audioFilePath",
      from: "history.json",
      index: "audio.json",
      root: "~/Library/Application Support/Aqua Voice",
      where: [{ at: "version", equals: 1 }, { at: "historyByUserId", object: true }],
    },
  },
} satisfies MacStore;
