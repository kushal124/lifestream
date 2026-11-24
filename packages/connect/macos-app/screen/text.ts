import { createHash } from "node:crypto";
import { brotliDecompressSync } from "node:zlib";
import { isObject, parse, refuse, type Json } from "@lifestreamprotocol/connect/sdk";

export const TEXT_FORMAT = "org.lifestreamprotocol.screen-text/1";
const MAX_BODY = 512 * 1024 * 1024;
const SPLICE_BEFORE = /^,?"(nodes|ocr|windows)":$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export interface Splice {
  at: number;
  before: string;
  array: number;
  after: string;
}

export interface TextSegment {
  frames: { bundle: string; observationSHA256: string; splices: Splice[] }[];
  arrays: [number, number][];
  region: Buffer;
}

export function readTextSegment(bytes: Buffer, where: string): TextSegment {
  let body: Buffer;
  try {
    body = brotliDecompressSync(bytes, { maxOutputLength: MAX_BODY });
  } catch (error) {
    return refuse(`${where} is not Brotli of at most ${MAX_BODY} bytes: ${(error as Error).message}`);
  }
  const newline = body.indexOf(0x0a);
  if (newline === -1) refuse(`${where} holds no header line`);
  let header: Json;
  try {
    header = parse(body.subarray(0, newline).toString("utf8"));
  } catch (error) {
    return refuse(`${where} header is not JSON: ${(error as Error).message}`);
  }
  if (!isObject(header) || header.format !== TEXT_FORMAT || !Array.isArray(header.arrays) || !Array.isArray(header.frames)) {
    refuse(`${where} header must state format ${TEXT_FORMAT}, arrays and frames`);
  }
  const region = body.subarray(newline + 1);
  const arrays = header.arrays.map((entry, index): [number, number] => {
    const [offset, length] = Array.isArray(entry) && entry.length === 2 ? entry : [];
    if (!whole(offset) || !whole(length) || offset + length > region.length) {
      return refuse(`${where} arrays[${index}] must be [offset, length] inside its arrays region`);
    }
    return [offset, length];
  });
  const frames = header.frames.map((frame, ordinal) => {
    if (!isObject(frame) || typeof frame.bundle !== "string" || typeof frame.observationSHA256 !== "string" ||
      !SHA256.test(frame.observationSHA256) || !Array.isArray(frame.splices)) {
      return refuse(`${where} frames[${ordinal}] must state bundle, observationSHA256 and splices`);
    }
    const seen = new Set<string>();
    const splices = frame.splices.map((splice, index): Splice => {
      const member = isObject(splice) && typeof splice.before === "string" ? SPLICE_BEFORE.exec(splice.before)?.[1] : undefined;
      if (!isObject(splice) || !whole(splice.at) || !whole(splice.array) || splice.array >= arrays.length || member === undefined ||
        (splice.after !== "" && splice.after !== ",") || ((splice.before as string).startsWith(",") && splice.after === ",") || seen.has(member)) {
        return refuse(`${where} frames[${ordinal}] splices[${index}] must state at, an array and the bytes of one nodes, ocr or windows member`);
      }
      seen.add(member);
      return { at: splice.at, before: splice.before as string, array: splice.array, after: splice.after as string };
    });
    return { bundle: frame.bundle, observationSHA256: frame.observationSHA256, splices };
  });
  return { frames, arrays, region };
}

export function splicedSha256(reduced: Buffer, segment: TextSegment, ordinal: number): string {
  const frame = segment.frames[ordinal]!;
  const order = frame.splices.map((splice, index) => ({ splice, index })).sort((a, b) => a.splice.at - b.splice.at || b.index - a.index);
  const digest = createHash("sha256");
  let cursor = 0;
  for (const { splice } of order) {
    if (splice.at > reduced.length) refuse(`frame ${ordinal} splices past the end of its reduced observation`);
    const [offset, length] = segment.arrays[splice.array]!;
    digest.update(reduced.subarray(cursor, splice.at));
    digest.update(splice.before);
    digest.update(segment.region.subarray(offset, offset + length));
    digest.update(splice.after);
    cursor = splice.at;
  }
  digest.update(reduced.subarray(cursor));
  return digest.digest("hex");
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;

export function memberValueSpan(bytes: Buffer, name: string, where: string): [number, number] {
  const fail = (): never => refuse(`${where} could not be scanned for its ${name} member`);
  let at = space(bytes, 0);
  if (bytes[at] !== OPEN_OBJECT) fail();
  at = space(bytes, at + 1);
  for (;;) {
    if (bytes[at] !== QUOTE) fail();
    const keyEnd = stringEnd(bytes, at);
    if (keyEnd === -1) fail();
    const key = JSON.parse(bytes.toString("utf8", at, keyEnd)) as string;
    at = space(bytes, keyEnd);
    if (bytes[at] !== COLON) fail();
    const start = space(bytes, at + 1);
    const end = valueEnd(bytes, start);
    if (end === -1) fail();
    if (key === name) return [start, end];
    at = space(bytes, end);
    if (bytes[at] !== COMMA) fail();
    at = space(bytes, at + 1);
  }
}

function space(bytes: Buffer, at: number): number {
  while (at < bytes.length && (bytes[at] === 0x20 || bytes[at] === 0x09 || bytes[at] === 0x0a || bytes[at] === 0x0d)) at++;
  return at;
}

function stringEnd(bytes: Buffer, at: number): number {
  for (let cursor = at + 1; ;) {
    const quote = bytes.indexOf(QUOTE, cursor);
    if (quote === -1) return -1;
    let slashes = 0;
    for (let back = quote - 1; back > at && bytes[back] === BACKSLASH; back--) slashes++;
    if (slashes % 2 === 0) return quote + 1;
    cursor = quote + 1;
  }
}

function valueEnd(bytes: Buffer, at: number): number {
  const first = bytes[at];
  if (first === QUOTE) return stringEnd(bytes, at);
  if (first !== OPEN_OBJECT && first !== OPEN_ARRAY) {
    let cursor = at;
    while (cursor < bytes.length && ![COMMA, CLOSE_OBJECT, CLOSE_ARRAY, 0x20, 0x0a, 0x09, 0x0d].includes(bytes[cursor]!)) cursor++;
    return cursor > at ? cursor : -1;
  }
  let depth = 0;
  for (let cursor = at; cursor < bytes.length; cursor++) {
    const byte = bytes[cursor];
    if (byte === QUOTE) {
      const end = stringEnd(bytes, cursor);
      if (end === -1) return -1;
      cursor = end - 1;
    } else if (byte === OPEN_OBJECT || byte === OPEN_ARRAY) depth++;
    else if (byte === CLOSE_OBJECT || byte === CLOSE_ARRAY) {
      depth--;
      if (depth === 0) return cursor + 1;
    }
  }
  return -1;
}

function whole(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
