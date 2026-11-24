import { describe, expect, it } from "vitest";
import { readExif } from "./exif.js";

const KiB = 1024;
const MiB = 1024 * KiB;

const u16 = (value: number): Buffer => { const bytes = Buffer.alloc(2); bytes.writeUInt16BE(value); return bytes; };
const u32 = (value: number): Buffer => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
const box = (type: string, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(8 + body.length), Buffer.from(type, "latin1"), body]);
};
const full = (type: string, version: number, ...parts: Buffer[]): Buffer => box(type, Buffer.from([version, 0, 0, 0]), ...parts);
const FTYP = box("ftyp", Buffer.from("heic"), u32(0), Buffer.from("mif1heic"));

function tiff(make: string): Buffer {
  const text = Buffer.from(`${make}\0`, "latin1");
  return Buffer.concat([Buffer.from("MM\0*"), u32(8), u16(1), u16(0x010f), u16(2), u32(text.length), u32(26), u32(0), text]);
}

function heif(iloc: (payloadAt: number) => Buffer, payload: Buffer): Buffer {
  const iinf = full("iinf", 0, u16(1), full("infe", 2, u16(1), u16(0), Buffer.from("Exif\0")));
  const meta = (at: number) => full("meta", 0, iinf, iloc(at));
  const payloadAt = FTYP.length + meta(0).length + 8;
  return Buffer.concat([FTYP, meta(payloadAt), box("mdat", payload)]);
}

function counted(file: Buffer, size = file.length): { read: (bytes: number) => Uint8Array; asks: number[] } {
  const asks: number[] = [];
  return {
    asks,
    read: (bytes) => {
      asks.push(bytes);
      const out = Buffer.alloc(Math.min(bytes, size));
      file.copy(out, 0, 0, Math.min(out.length, file.length));
      return out;
    },
  };
}

describe("a photo's facts: each of these is impossible", () => {
  it("a video with no meta box near its start asks for the whole file, or more than its first read", () => {
    const mdat = Buffer.concat([u32(1), Buffer.from("mdat"), u32(0), u32(100 * MiB + 16)]);
    const video = Buffer.concat([box("ftyp", Buffer.from("isom"), u32(0), Buffer.from("isommp41")), mdat]);
    const exif = counted(video, video.length + 100 * MiB);
    expect(readExif(exif.read)).toBeUndefined();
    expect(exif.asks).toEqual([256 * KiB]);
  });

  it("a TIFF whose directory lies past the window reads to it", () => {
    const far = Buffer.concat([Buffer.from("MM\0*"), u32(20 * MiB)]);
    const reads = counted(far, 40 * MiB);
    expect(readExif(reads.read)).toBeUndefined();
    expect(reads.asks).toEqual([256 * KiB]);
  });

  it("a HEIF's Exif item read wrong when it is split, or a long table of it read past its first window", () => {
    const payload = Buffer.concat([u32(0), tiff("Synthetic Camera Co")]);
    const split = heif((at) => full("iloc", 0, Buffer.from([0x44, 0x00]), u16(1),
      u16(1), u16(0), u16(2), u32(at), u32(10), u32(at + 10), u32(payload.length - 10)), payload);
    const reads = counted(split);
    expect(readExif(reads.read)).toEqual({ make: "Synthetic Camera Co" });
    expect(reads.asks).toEqual([256 * KiB]);
  });

  it("an item table whose count runs past its box takes an Exif item from the bytes after it", () => {
    const decoy = Buffer.concat([u32(0), tiff("Decoy Camera Co")]);
    const iinf = full("iinf", 0, u16(1), full("infe", 2, u16(1), u16(0), Buffer.from("Exif\0")));
    const entry = (id: number, at: number) => Buffer.concat([u16(id), u16(0), u16(1), u32(at), u32(decoy.length)]);
    const meta = (at: number) => full("meta", 0, iinf, full("iloc", 0, Buffer.from([0x44, 0x00]), u16(2), entry(2, at)));
    const payloadAt = FTYP.length + meta(0).length + entry(1, 0).length + 8;
    const file = Buffer.concat([FTYP, meta(payloadAt), entry(1, payloadAt), box("mdat", decoy)]);
    expect(readExif(counted(file).read)).toBeUndefined();
  });

  it("the Exif item's extents, overlapping, joined into a buffer larger than the window", () => {
    const payload = Buffer.concat([u32(0), tiff("Synthetic Camera Co"), Buffer.alloc(1_000)]);
    const file = heif((at) => full("iloc", 0, Buffer.from([0x44, 0x00]), u16(1), u16(1), u16(0), u16(65_535),
      Buffer.concat(Array.from({ length: 65_535 }, () => Buffer.concat([u32(at), u32(1_000)])))), payload);
    const reads = counted(file);
    expect(readExif(reads.read)).toBeUndefined();
    expect(reads.asks).toHaveLength(3);
    expect(Math.max(...reads.asks)).toBeLessThanOrEqual(16 * MiB);
  });
});

describe("when a photo was taken", () => {
  function taken(time: string, offset?: string, subsec?: string): Buffer {
    const entry = (tag: number, count: number, value: Buffer) => Buffer.concat([u16(tag), u16(2), u32(count), value]);
    const timeText = Buffer.from(`${time}\0`, "latin1");
    const exifAt = 26;
    const entries = [entry(0x9003, timeText.length, u32(0))];
    if (offset !== undefined) entries.push(entry(0x9011, offset.length + 1, u32(0)));
    if (subsec !== undefined) entries.push(entry(0x9291, subsec.length + 1, Buffer.concat([Buffer.from(`${subsec}\0`, "latin1"), Buffer.alloc(4)]).subarray(0, 4)));
    const dataAt = exifAt + 2 + entries.length * 12 + 4;
    entries[0] = entry(0x9003, timeText.length, u32(dataAt));
    if (offset !== undefined) entries[1] = entry(0x9011, offset.length + 1, u32(dataAt + timeText.length));
    return Buffer.concat([
      Buffer.from("MM\0*"), u32(8), u16(1), u16(0x8769), u16(4), u32(1), u32(exifAt), u32(0),
      u16(entries.length), ...entries, u32(0), timeText, ...(offset === undefined ? [] : [Buffer.from(`${offset}\0`, "latin1")]),
    ]);
  }

  it("states the original time as a wall clock, with its sub-second digits and the offset it was written in", () => {
    expect(readExif(counted(taken("2026:10:23 09:59:07", "+05:30", "123")).read)).toEqual({ taken: { clock: "2026-10-23T09:59:07.123", offset: "+05:30" } });
  });

  it("states a time with no offset as its wall clock alone, and a camera's blank or broken time as none", () => {
    expect(readExif(counted(taken("2026:10:23 09:59:07")).read)).toEqual({ taken: { clock: "2026-10-23T09:59:07" } });
    expect(readExif(counted(taken("0000:00:00 00:00:00", "+05:30")).read)?.taken).toBeUndefined();
    expect(readExif(counted(taken("2026:13:23 09:59:07")).read)?.taken).toBeUndefined();
    expect(readExif(counted(taken("2026:10:23 09:59:07", "local")).read)).toEqual({ taken: { clock: "2026-10-23T09:59:07" } });
  });
});
