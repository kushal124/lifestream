import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Fixture } from "../../../test/drive.js";
import { AUDIO_INDEX_FILE, HISTORY_FILE } from "../reader.js";

export const AQUA_ACCOUNT = "100001";
export const AQUA_SOURCE = `aqua-voice:${AQUA_ACCOUNT}:macbook-pro-0001`;

export interface Entry {
  sessionId: number | null;
  timestamp: string;
  content: string;
  rawText: string | null;
  file: number;
  seconds: number;
}

export function entry(e: Entry): Record<string, unknown> {
  return {
    kind: "transcription", source: "local", timestamp: e.timestamp, content: e.content, rawText: e.rawText,
    sessionId: e.sessionId, audioFilePath: `audio/AQ_${e.file}.wav`, audioDurationSeconds: e.seconds,
  };
}

export function historyFile(users: Record<string, Entry[]>): Buffer {
  return Buffer.from(JSON.stringify({
    version: 1,
    historyByUserId: Object.fromEntries(Object.entries(users).map(([user, entries]) => [user, entries.map(entry)])),
    historySyncCursorByUserId: {},
  }));
}

export function wav(file: number): Buffer {
  return Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from(`WAVEsynthetic recording ${file}`)]);
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function audioIndex(files: number[]): Buffer {
  const entries: Record<string, { sha256: string; bytes: number }> = {};
  for (const file of files) entries[`audio/AQ_${file}.wav`] = { sha256: sha256(wav(file)), bytes: wav(file).length };
  return Buffer.from(JSON.stringify({ format: "org.lifestreamprotocol.blob-index/1", entries }));
}

export const T0 = Date.parse("2026-09-20T08:00:00.000Z");

export function baseEntries(): Entry[] {
  return [
    { sessionId: 190000003, timestamp: "2026-09-20T08:10:00.084Z", content: "Synthetic third, written.", rawText: "synthetic third written", file: T0 + 600_083, seconds: 4.2 },
    { sessionId: 190000002, timestamp: "2026-09-20T08:05:00.500Z", content: "Synthetic second.", rawText: "synthetic second", file: T0 + 300_499, seconds: 13 },
    { sessionId: 190000001, timestamp: "2026-09-20T08:00:00.002Z", content: "", rawText: null, file: T0 + 1, seconds: 0.4 },
  ];
}

export const fixture: Fixture = (folder) => {
  const entries = baseEntries();
  writeFileSync(join(folder, HISTORY_FILE), historyFile({ [AQUA_ACCOUNT]: entries }));
  writeFileSync(join(folder, AUDIO_INDEX_FILE), audioIndex(entries.map((each) => each.file)));
  return { source: AQUA_SOURCE, facts: { snapshot_taken_at: "2026-09-20T08:15:00.000Z" }, files: { [HISTORY_FILE]: { alone: entries.map((each) => `dictation ${each.sessionId}`) }, [AUDIO_INDEX_FILE]: "trust" } };
};

export const fixtures: Readonly<Record<string, Fixture>> = {
  "aqua-voice-mac": fixture,
};
