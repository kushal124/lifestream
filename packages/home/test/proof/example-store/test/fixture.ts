import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { feeds } from "@lifestreamprotocol/connect/sdk";

export const SOURCE = "example-store:local:macbook-pro-0001";
const T0 = 1_790_582_400;

export const NOTES = [
  { id: "N-0001", title: "Synthetic note one", body: "Synthetic body one.", created: T0, modified: T0 + 3600 },
  { id: "N-0002", title: "Synthetic note two", body: "Synthetic body two.", created: T0 + 7200, modified: null },
];

export function writeStore(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE note (id TEXT, title TEXT, body TEXT, created REAL, modified REAL, sync_token BLOB)");
    const insert = db.prepare("INSERT INTO note (id, title, body, created, modified, sync_token) VALUES (?, ?, ?, ?, ?, ?)");
    for (const note of NOTES) insert.run(note.id, note.title, note.body, note.created, note.modified, Buffer.from(`sync ${note.id}`));
  } finally {
    db.close();
  }
}

export const fixture = (folder: string) => {
  writeStore(join(folder, "store.sqlite"));
  return { source: SOURCE, facts: { snapshot_taken_at: "2026-09-28T12:00:00.000Z", kind: "snapshot", ...feeds(SOURCE, "example-store") }, files: { "store.sqlite": "trust" as const }, heads: NOTES.map((note) => `note ${note.id}`) };
};

export const fixtures = { "example-store": fixture };
