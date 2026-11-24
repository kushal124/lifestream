import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { HEADER_BYTES, SEGMENT, TAG_BYTES, VECTOR_SEGMENT, writeSealed, type SegmentSize } from "../sealed.js";

export function plain(length: number): Buffer {
  const bytes = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) bytes[i] = (i * 7 + (i >> 8) * 13 + 1) & 0xff;
  return bytes;
}

export const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i));

function* cases(): Generator<{ segment: SegmentSize; associatedData: string; plainLength: number }> {
  for (const segment of [SEGMENT, VECTOR_SEGMENT] as const) {
    const first = segment - HEADER_BYTES - TAG_BYTES;
    const later = segment - TAG_BYTES;
    for (const plainLength of [0, 1, first - 1, first, first + 1, first + later + 1000, first + 2 * later]) {
      yield { segment, associatedData: "lifestream:1:blob", plainLength };
    }
    yield { segment, associatedData: "lifestream:1:day:2026-11-14", plainLength: first + 1 };
  }
}

async function* chunked(bytes: Buffer): AsyncGenerator<Buffer> {
  for (let at = 0; at < bytes.length; at += 10_000) yield bytes.subarray(at, at + 10_000);
}

async function main(folder: string): Promise<void> {
  const vectors = [];
  for (const each of cases()) {
    const file = `ours-${each.segment / 1024}k-${each.associatedData.split(":")[2]}-${each.plainLength}.bin`;
    await writeSealed(join(folder, file), chunked(plain(each.plainLength)), { key: KEY, associatedData: each.associatedData, segment: each.segment });
    vectors.push({ ...each, file });
  }
  writeFileSync(join(folder, "ours.json"), JSON.stringify({ vectors }, null, 2) + "\n");
  process.stdout.write(`sealed.ts wrote ${vectors.length} files into ${folder}\n`);
}

if (process.argv[1]?.endsWith("ours.ts")) await main(process.argv[2]!);
