import type { MacStore } from "@lifestreamprotocol/connect/sdk";

export const store = {
  feeder: "example-mac-app",
  name: "example",
  held: "~/Library/Application Support/Example/example.sqlite",
  account: { json: "~/Library/Application Support/Example/account.json", at: "email", holds: "@" },
  engine: {
    kind: "sqlite",
    stores: [
      {
        identity: "file",
        member: "example.sqlite",
        path: "~/Library/Application Support/Example/example.sqlite",
        tables: [{ key: "rowid", name: "notes", role: { main: { rows: "notes", time: "CAST(COALESCE(modified, created) AS INTEGER)" } } }],
      },
    ],
  },
} satisfies MacStore;
