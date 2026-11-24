import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MEDIA_HEAD, mediaTypeOf } from "./media-type.js";

const REPO = new URL("../../", import.meta.url);
const fixture = (name: string) => readFileSync(new URL(`dashboard/test/fixtures/${name}`, REPO)).subarray(0, MEDIA_HEAD);
const head = (text: string) => Buffer.from(text.padEnd(MEDIA_HEAD, "\0"), "latin1");
const iso = (brand: string) => head(`\0\0\0\x18ftyp${brand}\0\0\0\0`);
const ts = (every: number, lead: number) => {
  const bytes = Buffer.alloc(MEDIA_HEAD);
  for (let at = lead; at < MEDIA_HEAD; at += every) bytes[at] = 0x47;
  return bytes;
};

const QT = "video/quicktime", MP4 = "video/mp4";
const HEADS: [string, Buffer, string | null, string | null][] = [
  ["a Live Photo's motion with no ftyp (dashboard/test/fixtures/motion.mov)", fixture("motion.mov"), QT, QT],
  ["a QuickTime movie opening on mdat", head("\0\0\0\x08mdat"), QT, QT],
  ["a QuickTime movie opening on moov", head("\0\0\0\x08moov"), QT, QT],
  ["a QuickTime movie opening on wide", head("\0\0\0\x08wide"), QT, QT],
  ["QuickTime's brand", iso("qt  "), QT, QT],
  ["MP4's brand (dashboard/test/fixtures/video.mp4)", fixture("video.mp4"), MP4, MP4],
  ["the brand isom", iso("isom"), MP4, MP4],
  ["a WhatsApp GIF, brand mp4v", iso("mp4v"), MP4, MP4],
  ["a DASH file, brand dash", iso("dash"), MP4, MP4],
  ["a 3GPP video, brand 3gp4", iso("3gp4"), MP4, MP4],
  ["a camera's own brand, XAVC", iso("XAVC"), MP4, MP4],
  ["HEIC", iso("heic"), "image/heic", "image/heic"],
  ["HEIF's brand mif1", iso("mif1"), "image/heic", "image/heic"],
  ["HEIF's brand heim", iso("heim"), "image/heic", "image/heic"],
  ["AVIF", iso("avif"), "image/avif", "image/avif"],
  ["an AVIF sequence, avis", iso("avis"), "image/avif", "image/avif"],
  ["MP4 sound, M4A", iso("M4A "), null, "audio/mp4"],
  ["JPEG", head("\xff\xd8\xff\xe0"), "image/jpeg", "image/jpeg"],
  ["PNG", head("\x89PNG\r\n\x1a\n"), "image/png", "image/png"],
  ["GIF89a", head("GIF89a"), "image/gif", "image/gif"],
  ["GIF87a", head("GIF87a"), "image/gif", "image/gif"],
  ["WebP", head("RIFF\0\0\0\0WEBP"), "image/webp", "image/webp"],
  ["AVI", head("RIFF\0\0\0\0AVI "), "video/x-msvideo", null],
  ["WAV", head("RIFF\0\0\0\0WAVE"), null, "audio/wav"],
  ["TIFF, little-endian (a camera's raw among it)", head("II*\0"), "image/tiff", null],
  ["TIFF, big-endian", head("MM\0*"), "image/tiff", null],
  ["BMP", head("BM"), "image/bmp", null],
  ["Matroska", head("\x1a\x45\xdf\xa3"), "video/x-matroska", "video/webm"],
  ["ASF", head("\x30\x26\xb2\x75\x8e\x66\xcf\x11"), "video/x-ms-asf", null],
  ["an MPEG program stream", head("\0\0\x01\xba"), "video/mpeg", null],
  ["an MPEG transport stream (.ts)", ts(188, 0), "video/mp2t", null],
  ["an MPEG transport stream with time codes (.m2ts)", ts(192, 4), "video/mp2t", null],
  ["Ogg sound", head("OggS"), null, "audio/ogg"],
  ["SVG, which can carry script", head("<svg xmlns=\"http://www.w3.org/2000/svg\">"), null, null],
  ["a page", head("<!DOCTYPE html>"), null, null],
  ["no bytes", Buffer.alloc(0), null, null],
];

describe("one head table, fed to core's sniff and the dashboard's", () => {
  it("names each shape as the table says, in both", async () => {
    const dashboard = (await import(new URL("dashboard/lib/life.mjs", REPO).href)) as { mediaType(bytes: Uint8Array): string | null };
    const seen = HEADS.map(([name, bytes]) => [name, mediaTypeOf(bytes), dashboard.mediaType(bytes)]);
    expect(seen).toEqual(HEADS.map(([name, , core, web]) => [name, core, web]));
  });

  it("names a file shorter than its head by the bytes it has", () => {
    expect(mediaTypeOf(Buffer.from([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
    expect(mediaTypeOf(Buffer.from([0x47]))).toBeNull();
  });
});
