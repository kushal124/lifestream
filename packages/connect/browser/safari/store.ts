import type { MacStore } from "@lifestreamprotocol/connect/sdk";

export const store = {
  feeder: "safari-mac",
  name: "safari",
  held: "~/Library/Safari/History.db",
  account: "apple-id",
  engine: {
    kind: "sqlite",
    stores: [
      {
        identity: "file",
        member: "history.sqlite",
        path: "~/Library/Safari/History.db",
        tables: [
          { key: "id", name: "history_tombstones", role: "changes" },
          {
            keep: "EXISTS (SELECT 1 FROM history_tombstones AS tombstone WHERE history_visits.visit_time BETWEEN tombstone.start_time AND tombstone.end_time)",
            key: "id",
            name: "history_visits",
            role: { main: { rows: "visits", time: "NULLIF(visit_time, 0) + 978307200" } },
          },
          {
            keep: "id IN (SELECT history_item FROM history_visits)",
            key: "id",
            name: "history_items",
            role: "follows",
          },
        ],
      },
      {
        identity: "file",
        member: "cloudtabs.sqlite",
        optional: true,
        path: "~/Library/Containers/com.apple.Safari/Data/Library/Safari/CloudTabs.db",
        tables: [
          {
            key: "rowid",
            name: "cloud_tabs",
            role: "changes",
            touched_by: [
              [
                "cloud_tab_devices",
                "SELECT rowid AS k FROM cloud_tabs WHERE device_uuid IN (SELECT device_uuid FROM cloud_tab_devices WHERE rowid IN (SELECT t_key FROM temp.touched WHERE t_name = 'cloud_tab_devices'))",
              ],
              [
                "cloud_tab_close_requests",
                "SELECT rowid AS k FROM cloud_tabs WHERE tab_uuid IN (SELECT tab_uuid FROM cloud_tab_close_requests WHERE rowid IN (SELECT t_key FROM temp.touched WHERE t_name = 'cloud_tab_close_requests'))",
              ],
            ],
          },
          {
            keep: "device_uuid IN (SELECT device_uuid FROM cloud_tabs)",
            key: "rowid",
            name: "cloud_tab_devices",
            role: "follows",
          },
          {
            keep: "tab_uuid IN (SELECT tab_uuid FROM cloud_tabs)",
            key: "rowid",
            name: "cloud_tab_close_requests",
            role: "follows",
          },
        ],
      },
    ],
  },
} satisfies MacStore;
