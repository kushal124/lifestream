import type { MacStore } from "@lifestreamprotocol/connect/sdk";

export const store = {
  feeder: "wispr-flow-mac",
  name: "wispr_flow",
  held: "~/Library/Application Support/Wispr Flow/flow.sqlite",
  account: { at: "prefs.user.email", holds: "@", json: "~/Library/Application Support/Wispr Flow/config.json" },
  engine: {
    kind: "sqlite",
    stores: [
      {
        identity: "file",
        member: "flow.sqlite",
        path: "~/Library/Application Support/Wispr Flow/flow.sqlite",
        tables: [
          {
            key: "rowid",
            name: "History",
            role: { main: { rows: "dictations", time: "CAST(strftime('%s', substr(timestamp, 1, 19)) AS INTEGER)" } },
          },
        ],
      },
    ],
  },
} satisfies MacStore;
