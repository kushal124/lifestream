import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JsonObject } from "@lifestreamprotocol/core";
import type { Fixture, Spoiled } from "../../../test/drive.js";
import { writeZip } from "../../../test/drive.js";

export const ACCOUNT = "person-a@example.com";
export const SOURCE = `google-photos:${ACCOUNT}:export`;
export const STAMP = "20260907T030000Z";
export const EXPORTED_AT = "2026-09-07T03:00:00Z";
export const FACTS: JsonObject = { import: { kind: "google-takeout", id: STAMP }, account: ACCOUNT, exported_at: EXPORTED_AT, history: true };
export const MODEL = "Synthetic Phone 9";
export const ALBUM = "Takeout/Google Photos/Photos from 2026";
export const NAMED_ALBUM = "Takeout/Google Photos/Album A";

export const hexOf = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

export function jpeg(model: string | undefined, filler: string): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (model !== undefined) {
    const value = Buffer.from(`${model}\0`, "ascii");
    const tiff = Buffer.alloc(8 + 2 + 12 + 4);
    tiff.write("II", 0, "ascii");
    tiff.writeUInt16LE(42, 2);
    tiff.writeUInt32LE(8, 4);
    tiff.writeUInt16LE(1, 8);
    tiff.writeUInt16LE(272, 10);
    tiff.writeUInt16LE(2, 12);
    tiff.writeUInt32LE(value.length, 14);
    tiff.writeUInt32LE(tiff.length, 18);
    const exif = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff, value]);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(exif.length + 2);
    parts.push(Buffer.from([0xff, 0xe1]), length, exif);
  }
  parts.push(Buffer.from([0xff, 0xd9]), Buffer.from(filler, "utf8"));
  return Buffer.concat(parts);
}

export function iso(brand: string, filler: string): Buffer {
  const box = Buffer.alloc(24);
  box.writeUInt32BE(24, 0);
  box.write("ftyp", 4, "latin1");
  box.write(brand, 8, "latin1");
  box.write(brand, 16, "latin1");
  return Buffer.concat([box, Buffer.from(filler, "utf8")]);
}

export function sidecar(title: string, taken: string | undefined, created = "1788800000", extra: JsonObject = {}): Buffer {
  return Buffer.from(JSON.stringify({
    title,
    description: "",
    imageViews: "3",
    creationTime: { timestamp: created, formatted: "synthetic" },
    ...(taken === undefined ? {} : { photoTakenTime: { timestamp: taken, formatted: "synthetic" } }),
    geoData: { latitude: 1.5, longitude: 2.5, altitude: 0.0, latitudeSpan: 0.0, longitudeSpan: 0.0 },
    geoDataExif: { latitude: 1.5, longitude: 2.5, altitude: 0.0, latitudeSpan: 0.0, longitudeSpan: 0.0 },
    url: `https://photos.google.com/photo/AF1Qip-synthetic-${title}`,
    googlePhotosOrigin: { mobileUpload: { deviceFolder: { localFolderName: "" }, deviceType: "IOS_PHONE" } },
    ...extra,
  }, null, 2));
}

export const MEDIA = {
  plain: jpeg(MODEL, "photo one"),
  split: jpeg(MODEL, "photo two"),
  original: jpeg(MODEL, "photo three"),
  copy: jpeg(MODEL, "photo three, a second upload"),
  edited: jpeg(MODEL, "photo three, edited"),
  motion: jpeg(MODEL, "motion still"),
  motionVideo: iso("isom", "motion video"),
  live: iso("heic", "live still"),
  liveVideo: iso("qt  ", "live video"),
  video: iso("isom", "a video"),
  long: jpeg(undefined, "a long name"),
  lone: jpeg(MODEL, "photo seven"),
} as const;

export const MOTION = "PXL_20260905_101500000.MP";
export const LONG = "PXL_20260906_093000123_LONGNAME.jpg";

export function firstFile(): [string, Buffer][] {
  return [
    [`${ALBUM}/IMG_0001.jpg`, MEDIA.plain],
    [`${ALBUM}/IMG_0001.jpg.supplemental-metadata.json`, sidecar("IMG_0001.jpg", "1788775200")],
    [`${NAMED_ALBUM}/metadata.json`, Buffer.from(JSON.stringify({ title: "Album A", description: "", access: "protected", date: { timestamp: "1788700000", formatted: "synthetic" } }, null, 2))],
    [`${NAMED_ALBUM}/IMG_0001.jpg`, MEDIA.plain],
    [`${NAMED_ALBUM}/IMG_0001.jpg.supplemental-metadata.json`, sidecar("IMG_0001.jpg", "1788775200")],
    [`${ALBUM}/${MOTION}.jpg`, MEDIA.motion],
    [`${ALBUM}/${MOTION}`, MEDIA.motionVideo],
    [`${ALBUM}/${MOTION}.jpg.supplemental-metadata.json`, sidecar(`${MOTION}.jpg`, "1788603300")],
    [`${ALBUM}/${LONG}`, MEDIA.long],
    [`${ALBUM}/${LONG}.supplement.json`, sidecar(LONG, "1788687000")],
    [`${ALBUM}/IMG_0002.jpg`, MEDIA.split],
  ];
}

export function secondFile(): [string, Buffer][] {
  return [
    [`${ALBUM}/IMG_0002.jpg.supplemental-metadata.json`, sidecar("IMG_0002.jpg", "1788778800")],
    [`${ALBUM}/IMG_0003.jpg`, MEDIA.original],
    [`${ALBUM}/IMG_0003.jpg.supplemental-metadata.json`, sidecar("IMG_0003.jpg", "1788782400")],
    [`${ALBUM}/IMG_0003-edited.jpg`, MEDIA.edited],
    [`${ALBUM}/IMG_0003(1).jpg`, MEDIA.copy],
    [`${ALBUM}/IMG_0003.jpg.supplemental-metadata(1).json`, sidecar("IMG_0003.jpg", "1788786000")],
    [`${ALBUM}/IMG_0005.HEIC`, MEDIA.live],
    [`${ALBUM}/IMG_0005.MOV`, MEDIA.liveVideo],
    [`${ALBUM}/IMG_0005.HEIC.supplemental-metadata.json`, sidecar("IMG_0005.HEIC", "0", "1788790000")],
    [`${ALBUM}/VID_0006.mp4`, MEDIA.video],
    [`${ALBUM}/VID_0006.mp4.supplemental-metadata.json`, sidecar("VID_0006.mp4", "1788793600")],
    [`${ALBUM}/IMG_0007.jpg`, MEDIA.lone],
  ];
}

export const zipName = (seq: number): string => `takeout-${STAMP}-3-00${seq}.zip`;

export function takeoutZip(dir: string, seq: number, members: readonly [string, Buffer][]): string {
  const path = join(dir, zipName(seq));
  writeZip(path, members.map(([name, bytes]) => ({ name, bytes, method: "deflate" as const })));
  return path;
}

export const googlePhotosFixture: Fixture = (folder) => {
  const at = (name: string) => `${ALBUM}/${name}`;
  const times: Readonly<Record<string, readonly string[]>> = {
    [at("IMG_0001.jpg.supplemental-metadata.json")]: [],
    [`${NAMED_ALBUM}/IMG_0001.jpg.supplemental-metadata.json`]: [],
    [at(`${MOTION}.jpg.supplemental-metadata.json`)]: [at(`${MOTION}.jpg`), at(MOTION)],
    [at(`${LONG}.supplement.json`)]: [at(LONG)],
    [at("IMG_0003.jpg.supplemental-metadata.json")]: [at("IMG_0003.jpg"), at("IMG_0003-edited.jpg")],
    [at("IMG_0003.jpg.supplemental-metadata(1).json")]: [at("IMG_0003(1).jpg")],
    [at("IMG_0005.HEIC.supplemental-metadata.json")]: [at("IMG_0005.HEIC"), at("IMG_0005.MOV")],
    [at("VID_0006.mp4.supplemental-metadata.json")]: [at("VID_0006.mp4")],
  };
  const twice = new Set([at("IMG_0001.jpg"), `${NAMED_ALBUM}/IMG_0001.jpg`]);
  const members = [...firstFile(), ...secondFile()].filter(([name]) => !name.includes("IMG_0002") && !name.endsWith("IMG_0007.jpg"));
  const bytesOf = new Map(members);
  const head = (bytes: Buffer) => `img ${hexOf(bytes)}`;
  const files: Record<string, Spoiled> = {};
  for (const [name, bytes] of members) {
    mkdirSync(dirname(join(folder, name)), { recursive: true });
    writeFileSync(join(folder, name), bytes);
    const timed = times[name];
    if (timed !== undefined) files[name] = { alone: timed.map((photo) => head(bytesOf.get(photo)!)) };
    else if (name.endsWith(".json")) files[name] = { alone: [] };
    else files[name] = { alone: twice.has(name) ? [] : [head(bytes)], cut: [head(bytes.subarray(0, Math.floor(bytes.length / 2)))] };
  }
  return { source: SOURCE, facts: { exported_at: EXPORTED_AT }, files };
};
