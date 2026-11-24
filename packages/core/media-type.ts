
/** How many first bytes of a file `mediaTypeOf` reads. */
export const MEDIA_HEAD = 200;

const HEIF = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"]);
const AVIF = new Set(["avif", "avis"]);
const AUDIO = new Set(["M4A ", "M4B ", "M4P "]);
const QUICKTIME_ATOMS = new Set(["wide", "mdat", "moov"]);
const PNG = "\x89PNG\r\n\x1a\n";
const MATROSKA = "\x1a\x45\xdf\xa3";
const ASF = "\x30\x26\xb2\x75\x8e\x66\xcf\x11";
const MPEG_PS = "\x00\x00\x01\xba";
const TS_SYNC = 0x47;

/** A photo's or video's media type, read from its first bytes, or null for bytes that are neither. */
export function mediaTypeOf(head: Uint8Array): string | null {
  const text = (from: number, to: number) => Buffer.from(head.subarray(from, to)).toString("latin1");
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (text(0, 8) === PNG) return "image/png";
  if (text(0, 6) === "GIF87a" || text(0, 6) === "GIF89a") return "image/gif";
  if (text(0, 4) === "RIFF" && text(8, 12) === "WEBP") return "image/webp";
  if (text(0, 4) === "RIFF" && text(8, 12) === "AVI ") return "video/x-msvideo";
  if (text(4, 8) === "ftyp") {
    const brand = text(8, 12);
    if (HEIF.has(brand)) return "image/heic";
    if (AVIF.has(brand)) return "image/avif";
    if (AUDIO.has(brand)) return null;
    return brand === "qt  " ? "video/quicktime" : "video/mp4";
  }
  if (QUICKTIME_ATOMS.has(text(4, 8))) return "video/quicktime";
  if (text(0, 4) === "II*\0" || text(0, 4) === "MM\0*") return "image/tiff";
  if (text(0, 4) === MATROSKA) return "video/x-matroska";
  if (text(0, 2) === "BM") return "image/bmp";
  if (text(0, 8) === ASF) return "video/x-ms-asf";
  if (text(0, 4) === MPEG_PS) return "video/mpeg";
  if (head[0] === TS_SYNC && head[188] === TS_SYNC) return "video/mp2t";
  if (head[4] === TS_SYNC && head[196] === TS_SYNC) return "video/mp2t";
  return null;
}
