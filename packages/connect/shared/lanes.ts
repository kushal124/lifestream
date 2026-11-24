import { isObject, parse, sourceName, type BlobReader, type Delivery, type DeliveryFile, type Json, type JsonObject } from "@lifestreamprotocol/core";
import { blobChunks } from "./chunks.js";
import { rfc3339 } from "./delivery.js";
import { lines } from "./lines.js";
import { refuse, refuseAs, type RefusedCode } from "./refused.js";

/** Writes Unix milliseconds as a UTC instant with no dashes or colons, as in `20240102T030405.6Z`, its fraction's trailing zeros dropped. */
export function basicInstant(ms: number): string {
  const [whole, fraction] = rfc3339(ms).slice(0, -1).split(".") as [string, string];
  const trimmed = fraction.replace(/0+$/u, "");
  return `${whole.replace(/[-:]/gu, "")}${trimmed === "" ? "" : `.${trimmed}`}Z`;
}

export class Ranks {
  readonly #seen = new Map<string, number>();

  key(base: string): string {
    const rank = this.#seen.get(base) ?? 0;
    this.#seen.set(base, rank + 1);
    return rank === 0 ? base : `${base}:${rank}`;
  }
}

/** Whether a delivery holds no file. */
export function carriesNothing(delivery: Delivery): boolean {
  return delivery.files.length === 0;
}

/** The last part of a source's id, which names the device or copy its data came from. */
export function unitOf(source: string): string {
  return sourceName(source).copy;
}

/** A delivered file's lines, streamed from the blob store, each with its line number and its place as the file's path and that number. */
export async function* deliveredLines(files: BlobReader, file: DeliveryFile): AsyncGenerator<{ bytes: Buffer; line: number; where: string }> {
  let line = 0;
  for await (const bytes of lines(blobChunks(files, file.blob))) {
    line++;
    yield { bytes, line, where: `${file.path}:${line}` };
  }
}

/** Parses one line as a JSON object, refusing it, named by the locator given, when it is not one. */
export function parseLine(text: string, locator: string): JsonObject {
  return lineObject(text, locator, refuse);
}

export function parseLineAs(text: string, locator: string, code: RefusedCode): JsonObject {
  return lineObject(text, locator, (message) => refuseAs(message, code));
}

function lineObject(text: string, locator: string, refused: (message: string) => never): JsonObject {
  let value: Json;
  try {
    value = parse(text);
  } catch (error) {
    return refused(`${locator} is not one JSON object: ${(error as Error).message}`);
  }
  if (!isObject(value)) return refused(`${locator} is not one JSON object`);
  return value;
}
