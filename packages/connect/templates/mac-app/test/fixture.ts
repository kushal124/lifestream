import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Fixture } from "@lifestreamprotocol/connect/sdk";

export const UNIT = "macbook-pro-0001";
export const SOURCE = `example:person-a@example.com:${UNIT}`;

export interface StoredNote {
  id: string;
  title: string;
  body: string;
  created: number | null;
  modified: number | null;
}

export const T0 = 1_788_249_600;

export function createStore(path: string, notes: readonly StoredNote[], options: { extra?: string; without?: string } = {}): void {
  const db = new DatabaseSync(path);
  try {
    const columns = ["id TEXT", "title TEXT", "body TEXT", "created REAL", "modified REAL", "sync_token BLOB", ...(options.extra === undefined ? [] : [`${options.extra} TEXT`])]
      .filter((column) => !column.startsWith(`${options.without} `));
    db.exec(`CREATE TABLE notes (${columns.join(", ")})`);
    const names = columns.map((column) => column.split(" ")[0]!);
    const insert = db.prepare(`INSERT INTO notes (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`);
    for (const note of notes) {
      const values: Record<string, unknown> = { ...note, sync_token: Buffer.from(`sync ${note.id}`), [options.extra ?? ""]: "synthetic" };
      insert.run(...names.map((name) => (values[name] ?? null) as string | number | Uint8Array | null));
    }
  } finally {
    db.close();
  }
}

export const NOTES = (): StoredNote[] => [
  { id: "N-0001", title: "Synthetic note one", body: "Synthetic body one.", created: T0, modified: T0 + 3600 },
  { id: "N-0002", title: "Synthetic note two", body: "Synthetic body two.", created: T0 + 86_400, modified: null },
];

export const fixture: Fixture = (folder) => {
  createStore(join(folder, "example.sqlite"), NOTES());
  return {
    source: SOURCE, facts: { snapshot_taken_at: "2026-09-10T12:00:00.000Z", kind: "snapshot" }, files: { "example.sqlite": "trust" },
    heads: NOTES().map((note) => `note ${note.id}`),
  };
};

export const fixtures: Readonly<Record<string, Fixture>> = { "example-mac-app": fixture };
