import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Fixture } from "../../../test/drive.js";

export const AUDIO_UNIT = "macbook-pro-0001";
export const AUDIO_SOURCE = `audio:local:${AUDIO_UNIT}`;

export interface Recording {
  at: string;
  until: string;
  track?: "mic" | "sound";
  part?: number;
  stem?: string;
  override?: Record<string, unknown>;
}

export function stemOf(at: string, track: "mic" | "sound" = "mic"): string {
  return `${at.replaceAll("-", "").replaceAll(":", "")}.${track}`;
}

export function recordingFiles(recording: Recording): Record<string, Buffer> {
  const track = recording.track ?? "mic";
  const stem = recording.stem ?? stemOf(recording.at, track);
  const audio = Buffer.from(`synthetic audio ${stem}`);
  const sidecar: Record<string, unknown> = {
    at: recording.at,
    audio: {
      bit_rate: 32000,
      bytes: audio.length,
      channels: 1,
      codec: "aac",
      duration_ms: Date.parse(recording.until) - Date.parse(recording.at),
      file: `${stem}.m4a`,
      media_type: "audio/mp4",
      sample_rate: 16000,
      sha256: createHash("sha256").update(audio).digest("hex"),
    },
    camera: [],
    detected_at: recording.at,
    ...(track === "mic" ? { device: { chosen: "holder", name: "Synthetic Microphone", transport: "built_in", uid: "synthetic-input-uid" } } : {}),
    ended_by: "holders_gone",
    ...((recording.part ?? 1) === 1 ? { latency_ms: 180 } : {}),
    loudness: { every_ms: 1000, peak_dbfs: [-6, -9, -96], rms_dbfs: [-21, -24, -96] },
    part: recording.part ?? 1,
    room: [{
      at: recording.at,
      holders: ["com.example.meetings"],
      input: { device: { name: "Synthetic Microphone", transport: "built_in", uid: "synthetic-input-uid" }, muted: false, volume: 0.24 },
      output: { device: { name: "Synthetic Speakers", transport: "built_in", uid: "synthetic-output-uid" }, muted: false, volume: 0.5 },
      players: ["com.example.meetings"],
    }],
    session: stem,
    track,
    until: recording.until,
    ...recording.override,
  };
  return { [`${stem}.m4a`]: audio, [`${stem}.json`]: Buffer.from(`${JSON.stringify(sorted(sidecar))}\n`) };
}

export function audioFiles(): Record<string, Buffer> {
  return {
    ...recordingFiles({ at: "2026-09-30T10:00:00.120Z", until: "2026-09-30T10:05:00.120Z" }),
    ...recordingFiles({
      at: "2026-09-30T10:05:00.120Z",
      until: "2026-09-30T10:07:30.000Z",
      part: 2,
      override: { ended_by: "part_limit", session: "20260930T100000.120Z.mic" },
    }),
    ...recordingFiles({ at: "2026-09-30T10:00:01.000Z", until: "2026-09-30T10:07:29.500Z", track: "sound" }),
    ...recordingFiles({
      at: "2026-09-30T10:00:00.120Z",
      until: "2026-09-30T10:00:02.000Z",
      stem: "20260930T100000.120Z.mic-2",
      override: { ended_by: "device_changed", camera: [{ at: "2026-09-30T10:00:00.500Z", until: "2026-09-30T10:00:01.500Z", device: "Synthetic Camera" }] },
    }),
  };
}

export const AUDIO_FACTS = { snapshot_taken_at: "2026-09-30T10:10:00.000Z" };

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted((value as Record<string, unknown>)[key])]));
  }
  return value;
}

export const fixture: Fixture = (folder) => {
  for (const [path, bytes] of Object.entries(audioFiles())) writeFileSync(join(folder, path), bytes);
  const recording = (stem: string, head: string) => ({ [`${stem}.json`]: { alone: [head] }, [`${stem}.m4a`]: { alone: [head] } });
  return {
    source: AUDIO_SOURCE,
    facts: AUDIO_FACTS,
    files: {
      ...recording("20260930T100000.120Z.mic", "mic-recording 20260930T100000.12Z"),
      ...recording("20260930T100500.120Z.mic", "mic-recording 20260930T100500.12Z"),
      ...recording("20260930T100001.000Z.sound", "sound-recording 20260930T100001Z"),
      ...recording("20260930T100000.120Z.mic-2", "mic-recording 20260930T100000.12Z:1"),
    },
  };
};

export const fixtures: Readonly<Record<string, Fixture>> = {
  "audio-recording": fixture,
};
