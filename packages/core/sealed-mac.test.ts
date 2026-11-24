import { createDecipheriv, hkdfSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SEGMENT, openWhole, sealWhole } from "./sealed.js";
import { KEY, plain } from "./sealed-vectors/ours.js";

interface Manifest {
  key: string;
  associatedData: string;
  segment: number;
  header: string;
  files: { file: string; plainLength: number }[];
  log: { file: string; info: string; salt: string; records: { text: string; nonce: string }[] };
}

const FOLDER = new URL("./sealed-vectors/mac/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("mac.json", FOLDER), "utf8")) as Manifest;
const sealing = { key: KEY, associatedData: manifest.associatedData, segment: SEGMENT } as const;

function fixture(file: string): Buffer {
  return readFileSync(new URL(file, FOLDER));
}

function openLog(disk: Buffer): string[] {
  expect(disk[0]).toBe(0x80);
  const key = Buffer.from(hkdfSync("sha256", KEY, disk.subarray(1, 33), Buffer.from(manifest.log.info), 32));
  const texts: string[] = [];
  for (let at = 33, index = 0; at < disk.length; index += 1) {
    const length = disk.readUInt32BE(at);
    const body = disk.subarray(at + 4, at + 4 + length);
    const associated = Buffer.alloc(8);
    associated.writeBigUInt64BE(BigInt(index));
    const decipher = createDecipheriv("aes-256-gcm", key, body.subarray(0, 12));
    decipher.setAAD(associated);
    decipher.setAuthTag(body.subarray(body.length - 16));
    texts.push(Buffer.concat([decipher.update(body.subarray(12, body.length - 16)), decipher.final()]).toString("utf8"));
    at += 4 + length;
  }
  return texts;
}

describe("the files a Mac's DeviceFiles writes", () => {
  it("uses the key and segment sealed.ts names for a Mac file", () => {
    expect(manifest.key).toBe(KEY.toString("hex"));
    expect(manifest.segment).toBe(SEGMENT);
    expect(manifest.associatedData).toBe("lifestream-mac:1:file");
  });

  it.each(manifest.files.map((each) => [each.file, each.plainLength] as const))("opens %s, written whole by the Mac, in sealed.ts", (file, plainLength) => {
    const disk = fixture(file);
    expect(openWhole(disk, sealing, file)).toEqual(plain(plainLength));
    expect(sealWhole(plain(plainLength), sealing, file, Buffer.from(manifest.header, "hex"))).toEqual(disk);
  });

  it("opens a Mac's encrypted log record by record, each bound to its index", () => {
    const disk = fixture(manifest.log.file);
    expect(disk.subarray(1, 33).toString("hex")).toBe(manifest.log.salt);
    expect(openLog(disk)).toEqual(manifest.log.records.map((record) => record.text));
  });

  it("refuses a log whose records are swapped", () => {
    const disk = fixture(manifest.log.file);
    const first = 4 + disk.readUInt32BE(33);
    const second = 4 + disk.readUInt32BE(33 + first);
    const swapped = Buffer.concat([disk.subarray(0, 33), disk.subarray(33 + first, 33 + first + second), disk.subarray(33, 33 + first), disk.subarray(33 + first + second)]);
    expect(() => openLog(swapped)).toThrow();
  });
});
