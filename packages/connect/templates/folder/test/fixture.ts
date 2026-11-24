import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Files, Fixture, ItemOf, Scenario } from "@lifestreamprotocol/connect/sdk";

export const UNIT = "macbook-pro-0001";
export const SOURCE = `example-folder:local:${UNIT}`;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const OLD_APART = 4 * HOUR;

export const notePath = (n: number) => `notes/note-${String(n).padStart(3, "0")}.md`;
export const noteText = (n: number, edited = false) => `Synthetic note ${n}.\n${edited ? "An edited line.\n" : ""}`;

export const noteWritten = (scenario: Scenario, n: number) =>
  scenario.stamped?.[n] ?? (n < scenario.old ? scenario.start_ms - (scenario.old - n) * OLD_APART : scenario.start_ms + n * MINUTE) + (scenario.edited.includes(n) ? HOUR : 0);

export const dated = noteWritten;

export const files = (scenario: Scenario): Files => Object.fromEntries(
  Array.from({ length: scenario.items }, (_, n) => n)
    .filter((n) => !scenario.removed.includes(n))
    .map((n) => [notePath(n), { bytes: noteText(n, scenario.edited.includes(n)), modified_ms: noteWritten(scenario, n) }]),
);

export const item: ItemOf = ({ key }) => {
  const n = /^notes\/note-(\d+)\.md$/u.exec(key)?.[1];
  return n === undefined ? null : Number(n);
};

export const fixture: Fixture = (folder) => {
  const listed = [
    { path: "daily/2026-09-14.md", file: "files/1", created: "2026-09-14T07:30:00.000Z", modified: "2026-09-14T21:05:00.000Z" },
    { path: "reading-list.md", file: "files/2", created: "2026-09-15T09:00:00.000Z", modified: "2026-09-15T09:00:00.000Z" },
  ];
  mkdirSync(join(folder, "files"));
  writeFileSync(join(folder, "folder.json"), JSON.stringify({ files: listed, gone: ["drafts/old-idea.md"] }));
  writeFileSync(join(folder, "files", "1"), "Morning: a synthetic walk.\nEvening: synthetic reading.\n");
  writeFileSync(join(folder, "files", "2"), "A synthetic book.\nAnother synthetic book.\n");
  return {
    source: SOURCE, facts: { fetched_at: "2026-09-15T12:00:00.000Z" },
    files: {
      "folder.json": "trust",
      "files/1": { alone: [] },
      "files/2": { alone: [] },
    },
  };
};

export const fixtures: Readonly<Record<string, Fixture>> = { "example-folder": fixture };
