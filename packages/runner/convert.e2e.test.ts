import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { decodeAudio } from "./audio.js";

function toneWav(): Buffer {
  const count = 48_000;
  const wav = Buffer.alloc(44 + count * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + count * 2, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48_000, 24);
  wav.writeUInt32LE(96_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(count * 2, 40);
  for (let at = 0; at < count; at++) wav.writeInt16LE(Math.round(16_384 * Math.sin((2 * Math.PI * 1_000 * at) / 48_000)), 44 + at * 2);
  return wav;
}

describe("a note the system converts", () => {
  it("converts a WAV into a 16 kHz WAV beside it, never over it, and leaves nothing in the runner's folder", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "runner-convert-"));
    onTestFinished(() => rmSync(scratch, { recursive: true, force: true }));
    const samples = await decodeAudio("audio/wav", toneWav(), scratch, new AbortController().signal);
    expect(samples).toHaveLength(16_000);
    const peak = Math.max(...samples.subarray(200, samples.length - 200).map(Math.abs));
    expect(peak).toBeGreaterThan(0.45);
    expect(peak).toBeLessThan(0.55);
    expect(readdirSync(scratch)).toEqual([]);
    const notFolder = join(scratch, "not-a-folder");
    writeFileSync(notFolder, "");
    await expect(decodeAudio("audio/wav", toneWav(), notFolder, new AbortController().signal)).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});
