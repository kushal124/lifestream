import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Fixture, Spoiled } from "../../test/drive.js";
import { openZip } from "../../shared/zip.js";
import { written } from "./fixtures.js";

export const SESSIONS_UNIT = "synthetic-mac-0001";

export interface SessionDelivery {
  files: Record<string, Buffer>;
  facts: { snapshot_taken_at: string };
  feeder: string;
}

export function sealedBundle(url: URL): SessionDelivery {
  const zip = openZip(fileURLToPath(url));
  try {
    const files: Record<string, Buffer> = {};
    let manifest: { feeder: string; facts: { snapshot_taken_at: string } } | undefined;
    for (const entry of zip.entries()) {
      if (entry.name === "manifest.json") manifest = JSON.parse(entry.bytes().toString("utf8")) as typeof manifest;
      else files[entry.name] = entry.bytes();
    }
    return { files, facts: { snapshot_taken_at: manifest!.facts.snapshot_taken_at }, feeder: manifest!.feeder };
  } finally {
    zip.close();
  }
}

export interface PartSpec {
  lines: string[];
  from_line?: number;
  from_byte?: number;
}

export function partsFiles(parts: Record<string, PartSpec>, wholes: Record<string, Buffer> = {}, known: Record<string, Buffer> = {}): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  const index = Object.entries(parts).map(([file, part]) => {
    files[file] = Buffer.from(part.lines.map((line) => `${line}\n`).join(""));
    const from_line = part.from_line ?? 1;
    return { file, from_byte: part.from_byte ?? (from_line === 1 ? 0 : 1000), from_line, lines: part.lines.length };
  });
  const stated = Object.entries({ ...known, ...wholes }).map(([file, bytes]) => ({ file, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length }));
  return { "parts.json": Buffer.from(`${JSON.stringify({ parts: index, files: stated })}\n`), ...files, ...wholes };
}


const SESSION_FACTS = { snapshot_taken_at: "2026-10-01T11:00:00.000Z" };

function log(lines: string[], head: (line: string, index: number) => string | undefined): Spoiled {
  const half = Math.floor(Buffer.byteLength(lines.map((line) => `${line}\n`).join("")) / 2);
  let end = 0;
  const alone: string[] = [];
  const prefix: string[] = [];
  for (const [index, line] of lines.entries()) {
    end += Buffer.byteLength(line) + 1;
    const stated = head(line, index);
    if (stated === undefined) continue;
    alone.push(stated);
    if (end <= half) prefix.push(stated);
  }
  return { alone, prefix };
}

export const claudeCodeFixture: Fixture = (folder) => {
  const session = "00000000-0000-4000-8000-0000000000f1";
  const turn = (n: number, extra: Record<string, unknown> = {}) => JSON.stringify({
    parentUuid: null, type: "user", message: { role: "user", content: `Synthetic prompt ${n}.` }, uuid: `10000000-0000-4000-8000-0000000000${n}`,
    timestamp: `2026-10-01T09:00:${n}.000Z`, entrypoint: "cli", cwd: "/Users/person-a/project", sessionId: session, ...extra,
  });
  const logs = {
    [`${session}.jsonl`]: [turn(10), JSON.stringify({ type: "mode", mode: "plan" }), turn(11), turn(12), turn(13)],
    [`${session}/subagents/agent-a0000000000000001.jsonl`]: [turn(20, { isSidechain: true }), turn(21, { isSidechain: true })],
  };
  const tool = `${session}/tool-results/toolu_01.txt`;
  written(folder, partsFiles(Object.fromEntries(Object.entries(logs).map(([name, lines]) => [name, { lines }])), { [tool]: Buffer.from("Synthetic tool output.") }));
  const uuidOf = (line: string) => (JSON.parse(line) as { uuid?: string }).uuid;
  return {
    source: `claude-code:local:${SESSIONS_UNIT}`,
    facts: SESSION_FACTS,
    files: {
      "parts.json": "trust",
      [tool]: "trust",
      ...Object.fromEntries(Object.entries(logs).map(([name, lines]) => [name, log(lines, (line) => {
        const uuid = uuidOf(line);
        return uuid === undefined ? undefined : `agent-turn ${uuid}`;
      })])),
    },
  };
};

export const codexFixture: Fixture = (folder) => {
  const session = "00000000-0000-7000-8000-0000000000f1";
  const name = `rollout-2026-10-01T10-00-00-${session}.jsonl`;
  const lines = [
    JSON.stringify({ timestamp: "2026-10-01T10:00:00.000Z", type: "session_meta", payload: { session_id: session, id: session, cwd: "/Users/person-a/project", originator: "Codex Desktop", source: "vscode" }, ordinal: 0 }),
    ...[1, 2, 3, 4].map((n) => JSON.stringify({ timestamp: `2026-10-01T10:00:0${n}.000Z`, type: "event_msg", payload: { type: "user_message", message: `Synthetic prompt ${n}.` }, ordinal: n })),
  ];
  written(folder, partsFiles({ [name]: { lines } }));
  return {
    source: `codex:local:${SESSIONS_UNIT}`,
    facts: SESSION_FACTS,
    files: { "parts.json": "trust", [name]: log(lines, (_, index) => `agent-turn ${session}:${index + 1}`) },
  };
};
