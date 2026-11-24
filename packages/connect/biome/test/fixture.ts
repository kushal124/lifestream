import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { crc32 } from "node:zlib";
import type { Fixture, Spoiled } from "../../test/drive.js";
import { usageFixture } from "../../ios-app/phone.test-support.js";

export const MAC_UNIT = "macbook-pro-0001";
export const SCREEN_TIME_SOURCE = `screen-time:person-a@example.com:${MAC_UNIT}`;
export const NOW_PLAYING_SOURCE = `now-playing:person-a@example.com:${MAC_UNIT}`;
export const MAC_SYNC = "0000AAAA-0000-4000-8000-000000000001";
export const PHONE_SYNC = "0000BBBB-0000-4000-8000-000000000002";
export const FACTS = { snapshot_taken_at: "2026-09-02T00:00:00.000Z", local_device: MAC_SYNC };

export type Field =
  | [number, "varint", number | bigint]
  | [number, "double", number]
  | [number, "text", string]
  | [number, "bytes", Buffer]
  | [number, "message", Field[]]
  | [number, "fixed32", number];

export function protobuf(fields: Field[]): Buffer {
  const parts: Buffer[] = [];
  for (const [number, how, value] of fields) {
    switch (how) {
      case "varint":
        parts.push(varint(BigInt(number) << 3n), varint(BigInt(value)));
        break;
      case "double": {
        const body = Buffer.alloc(8);
        body.writeDoubleLE(value);
        parts.push(varint((BigInt(number) << 3n) | 1n), body);
        break;
      }
      case "fixed32": {
        const body = Buffer.alloc(4);
        body.writeUInt32LE(value);
        parts.push(varint((BigInt(number) << 3n) | 5n), body);
        break;
      }
      default: {
        const body = how === "text" ? Buffer.from(value, "utf8") : how === "bytes" ? value : protobuf(value);
        parts.push(varint((BigInt(number) << 3n) | 2n), varint(BigInt(body.length)), body);
      }
    }
  }
  return Buffer.concat(parts);
}

function varint(value: bigint): Buffer {
  const bytes: number[] = [];
  let rest = BigInt.asUintN(64, value);
  do {
    const low = Number(rest & 0x7fn);
    rest >>= 7n;
    bytes.push(rest === 0n ? low : low | 0x80);
  } while (rest !== 0n);
  return Buffer.from(bytes);
}

export type Written = { state: "written"; fields: Field[]; written?: number; format?: number; crc?: number; body?: Buffer };

export type Entry =
  | Written
  | { state: "deleted"; bytes: number; written: number }
  | { state: "closed"; next: number }
  | { state: "raw"; code: number; end: number; written: number };

export function segment(entries: Entry[], size = 16 * 1024, format = 10): Buffer {
  const file = Buffer.alloc(size);
  file.write("SEGB", 0, "latin1");
  file.writeUInt32LE(entries.length, 4);
  file.writeDoubleLE(810_000_000, 8);
  file.writeUInt32LE(10, 16);
  file.writeUInt32LE(0xffffffff, 20);
  let end = 0;
  entries.forEach((entry, index) => {
    const at = size - 16 * (index + 1);
    const start = 32 + ((end + 3) & ~3);
    if (entry.state === "closed") {
      file.writeUInt32LE(0, at);
      file.writeUInt32LE(4, at + 4);
      file.writeDoubleLE(entry.next / 1e6, at + 8);
      return;
    }
    if (entry.state === "raw") {
      file.writeUInt32LE(entry.end, at);
      file.writeUInt32LE(entry.code, at + 4);
      file.writeDoubleLE(entry.written, at + 8);
      end = entry.end;
      return;
    }
    if (entry.state === "deleted") {
      end = start - 32 + 8 + entry.bytes;
      file.writeUInt32LE(end, at);
      file.writeUInt32LE(3, at + 4);
      file.writeDoubleLE(entry.written, at + 8);
      return;
    }
    const body = entry.body ?? protobuf(entry.fields);
    file.writeUInt32LE(entry.crc ?? crc32(body), start);
    file.writeUInt32LE(entry.format ?? format, start + 4);
    body.copy(file, start + 8);
    end = start - 32 + 8 + body.length;
    file.writeUInt32LE(end, at);
    file.writeUInt32LE(1, at + 4);
    file.writeDoubleLE(entry.written ?? 0, at + 8);
  });
  return file;
}

export function focus(at: number, app: string, starts: boolean, extra: Field[] = []): Written {
  return {
    state: "written",
    written: at,
    fields: [
      [2, "varint", 1], [3, "varint", starts ? 1 : 0], [4, "double", at], [6, "text", app],
      [9, "text", "1.0.0"], [10, "text", "100"], [11, "varint", 1], [12, "varint", 1], [13, "varint", 0], ...extra,
    ],
  };
}

export function playing(at: number, state: number, title: string, written = at + 0.002): Written {
  return {
    state: "written",
    written,
    format: 1,
    fields: [
      [2, "double", at], [3, "varint", state], [4, "text", "Synthetic Album"], [5, "text", "Synthetic Artist"],
      [6, "varint", 313], [8, "text", title], [13, "varint", 0],
      [14, "message", [[1, "varint", 2], [2, "varint", 3], [3, "text", "Speaker"]]],
      [15, "text", "com.example.player"], [20, "varint", 0], [21, "varint", 0],
    ],
  };
}

export function focusFiles(): Record<string, Buffer> {
  return {
    "local/810000000000000.segb": segment([
      { state: "deleted", bytes: 40, written: 809_000_000 },
      focus(810_000_000.25, "com.example.mail", true, [[1, "text", "synthetic-reason"]]),
      focus(810_000_060.500001, "com.example.mail", false),
      { state: "closed", next: 810_000_100_000_000 },
    ]),
    "local/810000100000000.segb": segment([
      focus(810_000_100, "com.example.chat", true),
      focus(810_000_100, "com.example.chat", true),
      focus(810_000_160.000123, "com.example.chat", false, [
        [30, "varint", 2n ** 60n], [31, "text", "first"], [31, "text", "second"], [32, "fixed32", 7], [33, "bytes", Buffer.from([0xff, 0xfe])],
      ]),
    ]),
    "local/tombstone/810000050000000.segb": Buffer.from("not a segment: tombstones are never read"),
    [`remote/${PHONE_SYNC}/809990000000000.segb`]: segment([
      focus(809_990_000.75, "com.example.maps", true, [[1, "text", "synthetic-unlock"]]),
      focus(809_990_030, "com.example.maps", false),
    ]),
    [`remote/${PHONE_SYNC}/tombstone/809990050000000.segb`]: Buffer.from("not a segment either"),
  };
}

export function playingFiles(): Record<string, Buffer> {
  return {
    "local/810000000000000.segb": segment([
      playing(810_000_000.5, 1, "Synthetic Song One"),
      playing(810_000_200.5, 2, "Synthetic Song One"),
      playing(810_000_201, 3, "Synthetic Song Two"),
    ], 16 * 1024, 1),
    [`remote/${PHONE_SYNC}/809990000000000.segb`]: segment([playing(809_990_000.125, 1, "Synthetic Episode")], 16 * 1024, 1),
  };
}


function segmentFixture(source: string, segments: Record<string, { bytes: Buffer; heads: string[] }>): Fixture {
  return (folder) => {
    for (const [path, { bytes }] of Object.entries(segments)) {
      mkdirSync(dirname(join(folder, path)), { recursive: true });
      writeFileSync(join(folder, path), bytes);
    }
    return { source, facts: FACTS, files: Object.fromEntries(Object.entries(segments).map(([path, { heads }]) => [path, { alone: heads } satisfies Spoiled])) };
  };
}

export const focusFixture = segmentFixture(SCREEN_TIME_SOURCE, {
  "local/810000000000000.segb": {
    bytes: segment([focus(810_000_000.25, "com.example.mail", true), focus(810_000_060.5, "com.example.mail", false)]),
    heads: [`app-focus ${MAC_SYNC}:20260902T000000.25Z:com.example.mail:in`, `app-focus ${MAC_SYNC}:20260902T000100.5Z:com.example.mail:out`],
  },
  [`remote/${PHONE_SYNC}/809990000000000.segb`]: {
    bytes: segment([focus(809_990_000.75, "com.example.maps", true)]),
    heads: [`app-focus ${PHONE_SYNC}:20260901T211320.75Z:com.example.maps:in`],
  },
});

export const playingFixture = segmentFixture(NOW_PLAYING_SOURCE, {
  "local/810000000000000.segb": {
    bytes: segment([playing(810_000_000.5, 1, "Synthetic Song One"), playing(810_000_200.5, 2, "Synthetic Song One")], 16 * 1024, 1),
    heads: [`now-playing ${MAC_SYNC}:20260902T000000.5Z:1`, `now-playing ${MAC_SYNC}:20260902T000320.5Z:2`],
  },
  [`remote/${PHONE_SYNC}/809990000000000.segb`]: {
    bytes: segment([playing(809_990_000.125, 1, "Synthetic Episode")], 16 * 1024, 1),
    heads: [`now-playing ${PHONE_SYNC}:20260901T211320.125Z:1`],
  },
});

export const fixtures: Readonly<Record<string, Fixture>> = {
  "biome-app-in-focus": focusFixture,
  "biome-now-playing": playingFixture,
  "usage-ios-bundle": usageFixture,
};
