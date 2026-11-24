import { isObject, type Json, type JsonObject } from "@lifestreamprotocol/core";

/** Whether a value names a blob as exactly a `sha256:` hash and a whole number of bytes. */
export function blobRef(value: Json | undefined): value is JsonObject & { hash: string; bytes: number } {
  return isObject(value) && Object.keys(value).sort().join() === "bytes,hash" && typeof value.hash === "string" && /^sha256:[0-9a-f]{64}$/u.test(value.hash)
    && typeof value.bytes === "number" && Number.isSafeInteger(value.bytes) && value.bytes >= 0;
}

/** The hashes, each once and in order, of the blobs a content lists under its `blobs` member. */
export function listedBlobs(content: Json): string[] {
  const list = isObject(content) ? content.blobs : undefined;
  if (!Array.isArray(list)) return [];
  const hashes: string[] = [];
  for (const blob of list) {
    const hash = isObject(blob) ? blob.hash : undefined;
    if (typeof hash === "string" && !hashes.includes(hash)) hashes.push(hash);
  }
  return hashes;
}
