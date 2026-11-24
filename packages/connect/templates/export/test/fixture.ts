import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Files, Fixture, ItemOf, Scenario } from "@lifestreamprotocol/connect/sdk";

export const ACCOUNT = "person-a@example.com";
export const SOURCE = `example:${ACCOUNT}:export`;

export const note = (n: number, created_at: string) => ({ id: `note-${String(n).padStart(3, "0")}`, title: `Synthetic note ${n}`, text: `Synthetic text ${n}.`, created_at });

export function download(account = ACCOUNT): Record<string, Buffer> {
  return {
    "example-export/account.json": Buffer.from(JSON.stringify({ email: account })),
    "example-export/notes.json": Buffer.from(JSON.stringify([note(1, "2026-08-01T08:00:00.000Z"), note(2, "2026-08-02T08:00:00.000Z")])),
    "example-export/notes-2.json": Buffer.from(JSON.stringify([note(3, "2026-08-03T08:00:00.000Z")])),
  };
}

export const files = (scenario: Scenario): Files => ({
  "example-export/account.json": JSON.stringify({ email: ACCOUNT }),
  "example-export/notes.json": JSON.stringify(Array.from({ length: scenario.items }, (_, n) => n).filter((n) => !scenario.removed.includes(n)).map((n) => {
    const written = note(n + 1, new Date(scenario.start_ms - (scenario.items - n) * 3_600_000).toISOString());
    return scenario.edited.includes(n) ? { ...written, title: `${written.title}, edited` } : written;
  })),
});

export const item: ItemOf = ({ key }) => {
  const n = /^note-(\d+)$/u.exec(key)?.[1];
  return n === undefined ? null : Number(n) - 1;
};

export const fixture: Fixture = (folder) => {
  mkdirSync(join(folder, "example-export"));
  for (const [path, bytes] of Object.entries(download())) writeFileSync(join(folder, path), bytes);
  return {
    source: SOURCE, facts: { exported_at: "2026-09-01T00:00:00.000Z" },
    files: {
      "example-export/account.json": "trust",
      "example-export/notes.json": { alone: ["note note-001", "note note-002"] },
      "example-export/notes-2.json": { alone: ["note note-003"] },
    },
  };
};

export const fixtures: Readonly<Record<string, Fixture>> = { "example-export": fixture };
