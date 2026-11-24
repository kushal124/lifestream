import { parse } from "@lifestreamprotocol/core";
import { refuse } from "./refused.js";

const FORMAT = "org.lifestreamprotocol.blob-index/1";
const HEX = /^[0-9a-f]{64}$/u;

/** Reads a blob index a delivery carries, a JSON file naming the blob behind each locator, into each locator's blob hash and size. */
export function blobIndex(bytes: Buffer): Map<string, { blob: string; size: number }> {
  let value: unknown;
  try {
    value = parse(bytes.toString("utf8"));
  } catch (error) {
    return refuse(`the blob index does not parse: ${(error as Error).message}`);
  }
  const index = value as { format?: unknown; entries?: unknown };
  if (index === null || typeof index !== "object" || index.format !== FORMAT) refuse(`the blob index must state format ${FORMAT}`);
  const entries = index.entries;
  if (entries === null || typeof entries !== "object" || Array.isArray(entries)) refuse("the blob index must state entries as an object");
  const out = new Map<string, { blob: string; size: number }>();
  for (const [locator, entry] of Object.entries(entries as Record<string, unknown>)) {
    const stated = entry as { sha256?: unknown; bytes?: unknown };
    const exact = stated !== null && typeof stated === "object" && Object.keys(stated).sort().join(",") === "bytes,sha256";
    if (locator.length === 0 || !exact || typeof stated.sha256 !== "string" || !HEX.test(stated.sha256)) {
      refuse(`blob index entry ${JSON.stringify(locator)} must state exactly sha256 (64 lower-case hex digits) and bytes`);
    }
    if (typeof stated.bytes !== "number" || !Number.isSafeInteger(stated.bytes) || stated.bytes < 0) {
      refuse(`blob index entry ${JSON.stringify(locator)} must state bytes as a non-negative integer`);
    }
    out.set(locator, { blob: `sha256:${stated.sha256}`, size: stated.bytes });
  }
  return out;
}
