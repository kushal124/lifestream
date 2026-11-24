import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as turn } from "node:timers/promises";
import { OggOpusDecoder, type OggOpusDecodedAudio } from "ogg-opus-decoder";
import { Failed } from "./library.js";


export const MOST_SECONDS = 30 * 60;
const tooLong = (): Failed => new Failed("too_long", `the note is longer than ${MOST_SECONDS} s`, MOST_SECONDS);

const RATE = 16_000;
const WAV_HEAD = 4_096;
const PIECE = 16 * 1024;
const SECOND = RATE;

export async function decodeAudio(media_type: string, bytes: Uint8Array, scratch: string, signal: AbortSignal): Promise<Float32Array> {
  const type = media_type.split(";")[0]!.trim().toLowerCase();
  if (type === "audio/ogg" || type === "audio/opus") return lowPassThird(await decodeOpus(bytes, signal), signal);
  const extension = EXTENSIONS[type];
  if (extension === "wav") {
    const samples = canonicalWav(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    if (samples !== null) return samples;
  }
  if (extension === undefined || process.platform !== "darwin") throw new Failed("unreadable", `a voice note of type ${type} cannot be read here`);
  const dir = mkdtempSync(join(scratch, "note-"));
  try {
    const input = join(dir, `in.${extension}`);
    const output = join(dir, "out.wav");
    writeFileSync(input, bytes);
    await new Promise<void>((resolve, reject) => execFile("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", input, output], { signal }, (error, _out, err) => {
      if (signal.aborted) reject(signal.reason);
      else if (error !== null) reject(new Failed("unreadable", `afconvert could not read the note: ${err || error.message}`));
      else resolve();
    }));
    if (statSync(output).size > WAV_HEAD + MOST_SECONDS * RATE * 2) throw tooLong();
    return readWav(readFileSync(output));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  "audio/x-caf": "caf", "audio/caf": "caf", "audio/mp4": "m4a", "audio/m4a": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/vnd.wave": "wav", "audio/amr": "amr",
};

async function decodeOpus(bytes: Uint8Array, signal: AbortSignal): Promise<Float32Array> {
  const opus = new OggOpusDecoder();
  await opus.ready;
  try {
    const parts: Float32Array[] = [];
    let total = 0;
    let damaged: string | undefined;
    const take = (decoded: OggOpusDecodedAudio): void => {
      damaged ??= decoded.errors[0]?.message;
      const count = decoded.samplesDecoded;
      if (count === 0) return;
      const mono = new Float32Array(count);
      for (const channel of decoded.channelData) for (let at = 0; at < count; at++) mono[at]! += channel[at]! / decoded.channelData.length;
      parts.push(mono);
      total += count;
      if (total > MOST_SECONDS * RATE * 3) throw tooLong();
    };
    for (let at = 0; at < bytes.length; at += PIECE) {
      await turn();
      signal.throwIfAborted();
      take(await opus.decode(bytes.subarray(at, at + PIECE)));
    }
    take(await opus.flush());
    if (total === 0 || damaged !== undefined) throw new Failed("unreadable", `the note did not decode whole as Ogg Opus${damaged === undefined ? "" : `: ${damaged}`}`);
    const whole = new Float32Array(total);
    let at = 0;
    for (const part of parts) {
      whole.set(part, at);
      at += part.length;
    }
    return whole;
  } finally {
    opus.free();
  }
}

const TAPS = 255;
const CUTOFF = 7_600 / 48_000;

const FILTER: Float64Array = (() => {
  const taps = new Float64Array(TAPS);
  const middle = (TAPS - 1) / 2;
  let sum = 0;
  for (let k = 0; k < TAPS; k++) {
    const x = k - middle;
    const sinc = x === 0 ? 2 * CUTOFF : Math.sin(2 * Math.PI * CUTOFF * x) / (Math.PI * x);
    const window = 0.42 - 0.5 * Math.cos((2 * Math.PI * k) / (TAPS - 1)) + 0.08 * Math.cos((4 * Math.PI * k) / (TAPS - 1));
    taps[k] = sinc * window;
    sum += taps[k]!;
  }
  for (let k = 0; k < TAPS; k++) taps[k]! /= sum;
  return taps;
})();

async function lowPassThird(samples: Float32Array, signal: AbortSignal): Promise<Float32Array> {
  const middle = (TAPS - 1) / 2;
  const out = new Float32Array(Math.ceil(samples.length / 3));
  for (let n = 0; n < out.length; n++) {
    if (n % SECOND === 0) {
      await turn();
      signal.throwIfAborted();
    }
    const centre = n * 3;
    let sum = 0;
    const from = Math.max(0, middle - centre);
    const to = Math.min(TAPS, samples.length - centre + middle);
    for (let k = from; k < to; k++) sum += FILTER[k]! * samples[centre + k - middle]!;
    out[n] = sum;
  }
  return out;
}

export function canonicalWav(bytes: Buffer): Float32Array | null {
  const tag = (at: number): string => bytes.toString("latin1", at, at + 4);
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Failed("unreadable", "the note is not a WAV");
  let canonical: boolean | null = null;
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(at + 4);
    if (tag(at) === "fmt ") {
      if (size < 16 || at + 8 + size > bytes.length) throw new Failed("unreadable", "the note's format is cut");
      canonical = bytes.readUInt16LE(at + 8) === 1 && bytes.readUInt16LE(at + 10) === 1 && bytes.readUInt32LE(at + 12) === RATE && bytes.readUInt16LE(at + 22) === 16;
      if (!canonical) return null;
    }
    if (tag(at) === "data") {
      if (canonical === null) throw new Failed("unreadable", "the note's samples come before its format");
      if (size / 2 > MOST_SECONDS * RATE) throw tooLong();
      if (at + 8 + size > bytes.length || size % 2 !== 0) throw new Failed("unreadable", "the note's samples are cut");
      const out = new Float32Array(size / 2);
      for (let i = 0; i < out.length; i++) out[i] = bytes.readInt16LE(at + 8 + i * 2) / 32768;
      return out;
    }
    at += 8 + size + (size % 2);
  }
  throw new Failed("unreadable", "the note holds no samples");
}

function readWav(bytes: Buffer): Float32Array {
  const tag = (at: number): string => bytes.toString("latin1", at, at + 4);
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Failed("unreadable", "the converted note is not a WAV");
  let format: { channels: number; bits: number } | null = null;
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(at + 4);
    if (tag(at) === "fmt ") format = { channels: bytes.readUInt16LE(at + 10), bits: bytes.readUInt16LE(at + 22) };
    if (tag(at) === "data") {
      if (format === null || format.channels !== 1 || format.bits !== 16) throw new Failed("unreadable", "the converted note is not 16-bit mono");
      const count = Math.floor(Math.min(size, bytes.length - at - 8) / 2);
      const out = new Float32Array(count);
      for (let i = 0; i < count; i++) out[i] = bytes.readInt16LE(at + 8 + i * 2) / 32768;
      return out;
    }
    at += 8 + size + (size % 2);
  }
  throw new Failed("unreadable", "the converted note holds no samples");
}
