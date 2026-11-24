import { describe, expect, it } from "vitest";
import type { VoiceAdapter } from "@lifestreamprotocol/core";
import { AT_MS, BLOB, HEX, statedOf } from "../test/stated.js";
import { voiceFaults } from "./faults.js";

const RECORDING = { sha256: HEX, media_type: "audio/mp4", duration_seconds: 12, started_ms: AT_MS, ended_ms: AT_MS + 12_000, location: null };
const recording = (changed: Record<string, unknown>) => voiceFaults(statedOf<VoiceAdapter>({}, "recording", { ...RECORDING, ...changed }));

describe("voiceFaults", () => {
  it("passes a recording that keeps every rule", () => {
    expect(recording({})).toEqual([]);
  });

  it("names each rule a recording breaks", () => {
    expect(recording({ sha256: BLOB })).toEqual([`\`sha256\` is 64 lower-case hex digits, no \`sha256:\`: \`${BLOB}\` is none`]);
    expect(recording({ sha256: HEX.toUpperCase() })).toEqual([`\`sha256\` is 64 lower-case hex digits, no \`sha256:\`: \`${HEX.toUpperCase()}\` is none`]);
    expect(recording({ ended_ms: AT_MS - 1 })).toEqual([`\`ended_ms\` is at or after \`started_ms\`: ${AT_MS - 1} is before ${AT_MS}`]);
  });
});
