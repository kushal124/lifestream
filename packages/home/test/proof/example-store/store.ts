import type { MacStore } from "@lifestreamprotocol/connect/sdk";

export const store = {
  feeder: "example-store-mac",
  name: "example-store",
  held: "~/Library/Application Support/Example Store/store.db",
  account: "local",
  wake: "com.example.store",
  engine: {
    kind: "sqlite",
    stores: [{
      path: "~/Library/Application Support/Example Store/store.db",
      member: "store.sqlite",
      identity: "file",
      file_root: "~/Library/Application Support/Example Store/files",
      attachments: {
        member: "files",
        select: [{ sql: "SELECT path FROM attachment WHERE note_id IN (SELECT t_key FROM temp.touched)", when: "attachment.path" }, { sql: "SELECT NULL" }],
      },
      tables: [
        { name: "note", key: "id", role: { main: { time: "created", rows: "notes" } }, keep: "SELECT * FROM note", touched_by: [["attachment", "SELECT note_id AS k FROM attachment"]] },
        { name: "attachment", key: "id", role: "follows", files: ["path"] },
        { name: "folder", role: "whole", when_declared: true },
      ],
    }],
  },
} satisfies MacStore;
