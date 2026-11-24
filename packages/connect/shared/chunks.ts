import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import type { BlobReader } from "@lifestreamprotocol/core";

const CHUNK = 1024 * 1024;

/** A blob's bytes, a mebibyte at a time, read from a copy on disk freed once they end. */
export async function* blobChunks(files: BlobReader, hash: string): AsyncGenerator<Buffer> {
  const copy = await files.materialise(hash);
  try {
    yield* fileChunks(copy.path);
  } finally {
    copy.dispose();
  }
}

export function* fileChunks(path: string): Generator<Buffer> {
  const fd = openSync(path, "r");
  try {
    for (;;) {
      const buffer = Buffer.allocUnsafe(CHUNK);
      const read = readSync(fd, buffer, 0, CHUNK, null);
      if (read === 0) return;
      yield read === CHUNK ? buffer : buffer.subarray(0, read);
    }
  } finally {
    closeSync(fd);
  }
}

/** The SHA-256 of a file on disk, as 64 lowercase hex digits, read a mebibyte at a time. */
export function fileSha256(path: string): string {
  const hash = createHash("sha256");
  for (const chunk of fileChunks(path)) hash.update(chunk);
  return hash.digest("hex");
}
