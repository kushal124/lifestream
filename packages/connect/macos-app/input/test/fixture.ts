import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Fixture } from "../../../test/drive.js";
export const INPUT_UNIT = "macbook-pro-0001";
export const INPUT_SOURCE = `input:local:${INPUT_UNIT}`;

export interface Chunk {
  at: string;
  until: string;
  apps?: string[];
  sites?: string[];
  events?: unknown[];
  activity?: unknown[];
  lost?: number;
  recovered?: boolean;
}

export function chunkLine(chunk: Chunk): string {
  const members: string[] = [
    `"at":${JSON.stringify(chunk.at)}`,
    `"until":${JSON.stringify(chunk.until)}`,
    `"layout":"com.example.keylayout.US"`,
    `"apps":${JSON.stringify(chunk.apps ?? ["com.example.editor"])}`,
  ];
  if (chunk.sites !== undefined) members.push(`"sites":${JSON.stringify(chunk.sites)}`);
  members.push(`"events":${JSON.stringify(chunk.events ?? [{ e: "key_down", t: 120, k: 4, app: 0 }, { e: "key_up", t: 180, k: 4, app: 0 }])}`);
  if (chunk.activity !== undefined) members.push(`"activity":${JSON.stringify(chunk.activity)}`);
  if (chunk.lost !== undefined) members.push(`"lost":${chunk.lost}`);
  if (chunk.recovered !== undefined) members.push(`"recovered":${chunk.recovered}`);
  return `{${members.join(",")}}`;
}

export function logFile(lines: string[]): Buffer {
  return Buffer.from(lines.map((line) => `${line}\n`).join(""));
}

export function inputFiles(): Record<string, Buffer> {
  return {
    "20260906T230000.000Z.jsonl": logFile([
      chunkLine({ at: "2026-09-06T23:00:00.000Z", until: "2026-09-06T23:01:00.000Z" }),
      chunkLine({
        at: "2026-09-06T23:01:00.000Z",
        until: "2026-09-06T23:02:00.000Z",
        apps: ["com.example.browser", "com.example.editor"],
        sites: ["example.com"],
        events: [
          { e: "activate", t: 5, app: 1 },
          { e: "down", t: 10, x: 0.25, y: 0.5, b: 0, app: 0 },
          { e: "scroll", t: 40, dy: -3.5, app: 0, syn: 1 },
          { e: "site_unknown", t: 50 },
        ],
        activity: [{ app: 0, ms: 41000 }, { app: 1, ms: 12500 }],
      }),
      chunkLine({ at: "2026-09-06T23:02:00.000Z", until: "2026-09-06T23:02:30.125Z", lost: 3, events: [{ e: "log_stop", t: 30125 }] }),
    ]),
    "20260906T233000.000Z.jsonl": logFile([
      chunkLine({ at: "2026-09-06T23:30:00.000Z", until: "2026-09-06T23:31:00.000Z", events: [{ e: "log_start", t: 0 }] }),
      chunkLine({ at: "2026-09-06T23:30:00.000Z", until: "2026-09-06T23:30:40.500Z", recovered: true }),
    ]),
    "current.jsonl": logFile([chunkLine({ at: "2026-09-06T23:40:00.000Z", until: "2026-09-06T23:41:00.000Z" })]),
  };
}

export const INPUT_FACTS = { snapshot_taken_at: "2026-09-06T23:35:00.000Z" };

export const fixture: Fixture = (folder) => {
  const { "current.jsonl": _open, ...sealed } = inputFiles();
  for (const [path, bytes] of Object.entries(sealed)) writeFileSync(join(folder, path), bytes);
  return {
    source: INPUT_SOURCE,
    facts: INPUT_FACTS,
    files: {
      "20260906T230000.000Z.jsonl": { alone: ["input 20260906T230000Z", "input 20260906T230100Z", "input 20260906T230200Z"], prefix: ["input 20260906T230000Z"] },
      "20260906T233000.000Z.jsonl": { alone: ["input 20260906T233000Z", "input 20260906T233000Z:1"], prefix: ["input 20260906T233000Z"] },
    },
  };
};

export const fixtures: Readonly<Record<string, Fixture>> = {
  "input-events": fixture,
};
