import { crc32 } from "node:zlib";
import { refuse, type Json, type JsonObject } from "@lifestreamprotocol/connect/sdk";

const MAGIC = 0x42474553;
const HEADER = 32;
const ENTRY = 16;

export const WRITTEN = 1;
export const DELETED = 3;
export const CLOSED = 4;

export interface SegbRecord {
  index: number;
  format: number;
  written: number;
  protobuf: Buffer;
}

export function* segbRecords(bytes: Buffer, locator: string): Generator<SegbRecord> {
  const bad = (why: string): never => refuse(`${locator} is not a readable SEGB segment: ${why}`);
  if (bytes.length < HEADER || bytes.readUInt32LE(0) !== MAGIC) bad("it does not start with SEGB");
  const count = bytes.readUInt32LE(4);
  const indexStart = bytes.length - count * ENTRY;
  if (indexStart < HEADER) bad(`its ${count} index entries do not fit in ${bytes.length} bytes`);
  let previousEnd = 0;
  for (let index = 0; index < count; index++) {
    const at = bytes.length - ENTRY * (index + 1);
    const end = bytes.readUInt32LE(at);
    const state = bytes.readUInt32LE(at + 4);
    const written = bytes.readDoubleLE(at + 8);
    if (state === CLOSED) continue;
    if (state !== WRITTEN && state !== DELETED) bad(`entry ${index} states ${state}, not 1, 3 or 4`);
    const start = HEADER + align4(previousEnd);
    const stop = HEADER + end;
    if (stop < start + 8 || stop > indexStart) bad(`entry ${index} ends at ${end}, outside its records`);
    previousEnd = end;
    if (state === DELETED) continue;
    const protobuf = bytes.subarray(start + 8, stop);
    if (crc32(protobuf) !== bytes.readUInt32LE(start)) bad(`entry ${index} fails its CRC`);
    if (!Number.isFinite(written)) bad(`entry ${index} states no finite write time`);
    yield { index, format: bytes.readUInt32LE(start + 4), written, protobuf };
  }
}

function align4(offset: number): number {
  return (offset + 3) & ~3;
}

export function protobufFields(bytes: Buffer, messages: ReadonlySet<number>, locator: string): JsonObject {
  const bad = (why: string): never => refuse(`${locator} is not a readable protobuf record: ${why}`);
  const fields: Record<string, Json[]> = {};
  let at = 0;
  const varint = (): bigint => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (at >= bytes.length) bad("a varint runs past the record");
      const byte = bytes[at++]!;
      value |= BigInt(byte & 0x7f) << shift;
      if (byte < 0x80) return value;
    }
    return bad("a varint is longer than ten bytes");
  };
  while (at < bytes.length) {
    const tag = varint();
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (field < 1) bad(`field number ${field}`);
    let value: Json;
    switch (wire) {
      case 0: {
        const read = varint();
        value = read <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(read) : read.toString();
        break;
      }
      case 1: {
        if (at + 8 > bytes.length) bad(`field ${field} runs past the record`);
        const double = bytes.readDoubleLE(at);
        value = Number.isFinite(double) ? double : { fixed64: bytes.subarray(at, at + 8).toString("hex") };
        at += 8;
        break;
      }
      case 5:
        if (at + 4 > bytes.length) bad(`field ${field} runs past the record`);
        value = { fixed32: bytes.readUInt32LE(at) };
        at += 4;
        break;
      case 2: {
        const length = varint();
        if (length > BigInt(bytes.length - at)) bad(`field ${field} runs past the record`);
        const body = bytes.subarray(at, at + Number(length));
        at += Number(length);
        value = messages.has(field) ? protobufFields(body, new Set(), `${locator} field ${field}`) : text(body);
        break;
      }
      default:
        return bad(`field ${field} has wire type ${wire}`);
    }
    (fields[String(field)] ??= []).push(value);
  }
  return Object.fromEntries(Object.entries(fields).map(([field, values]) => [field, values.length === 1 ? values[0]! : values]));
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function text(body: Buffer): Json {
  try {
    return UTF8.decode(body);
  } catch {
    return { base64: body.toString("base64") };
  }
}

export function microsSpelling(seconds: number): string {
  return seconds.toFixed(6);
}

export function basicMicros(seconds: number): string {
  const [whole, fraction] = microsSpelling(seconds).split(".") as [string, string];
  const trimmed = fraction.replace(/0+$/u, "");
  const iso = new Date((Number(whole) + APPLE_EPOCH_S) * 1000).toISOString();
  return `${iso.slice(0, 19).replace(/[-:]/gu, "")}${trimmed === "" ? "" : `.${trimmed}`}Z`;
}

const APPLE_EPOCH_S = 978_307_200;
