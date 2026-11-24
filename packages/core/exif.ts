export interface ExifSummary {
  unreadable?: true;
  make?: string;
  model?: string;
  gps?: { latitude: number; longitude: number };
  taken?: { clock: string; offset?: string };
}

const TAG_MAKE = 0x010f;
const TAG_MODEL = 0x0110;
const TAG_GPS_IFD = 0x8825;
const TAG_EXIF_IFD = 0x8769;
const TAG_DATE_TIME_ORIGINAL = 0x9003;
const TAG_OFFSET_TIME_ORIGINAL = 0x9011;
const TAG_SUB_SEC_TIME_ORIGINAL = 0x9291;
const TAG_GPS_LATITUDE_REF = 0x0001;
const TAG_GPS_LATITUDE = 0x0002;
const TAG_GPS_LONGITUDE_REF = 0x0003;
const TAG_GPS_LONGITUDE = 0x0004;
const TAG_GPS_STATUS = 0x0009;
const ASCII = 2;
const LONG = 4;
const RATIONAL = 5;

export function readExif(read: (bytes: number) => Uint8Array): ExifSummary | undefined {
  return windowed(read, 256 * 1024, (bytes, whole) => {
    if (isTiff(bytes)) return summary(bytes, !whole) ?? { unreadable: true };
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      const tiff = jpegExif(bytes);
      return tiff === undefined ? undefined : summary(Buffer.from(tiff), false) ?? { unreadable: true };
    }
    if (ascii(bytes, 4, 4) === "ftyp") {
      const tiff = heicExif(bytes);
      return tiff === undefined ? undefined : summary(Buffer.from(tiff), false);
    }
    return OTHER_IMAGES.some((starts) => starts(bytes)) ? undefined : { unreadable: true };
  }, (bytes) => (isTiff(bytes) || (bytes[0] === 0xff && bytes[1] === 0xd8) ? { unreadable: true } : undefined));
}

const WINDOW = 16 * 1024 * 1024;

function windowed<T>(read: (bytes: number) => Uint8Array, first: number, parse: (bytes: Buffer, whole: boolean) => T, broken: (bytes: Buffer) => T): T | undefined {
  for (let size = first; ;) {
    const got = read(size);
    const bytes = Buffer.from(got.buffer, got.byteOffset, got.byteLength);
    try {
      return parse(bytes, bytes.length < size);
    } catch (error) {
      if (!(error instanceof Short) || bytes.length < size) return broken(bytes);
      if (error.end > WINDOW) return undefined;
      size = Math.min(Math.max(error.end, 2 * size), WINDOW);
    }
  }
}

const OTHER_IMAGES: readonly ((bytes: Uint8Array) => boolean)[] = [
  (bytes) => ascii(bytes, 0, 8) === "\x89PNG\r\n\x1a\n",
  (bytes) => ascii(bytes, 0, 4) === "GIF8",
  (bytes) => ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP",
  (bytes) => ascii(bytes, 0, 2) === "BM",
];

class Short extends Error {
  constructor(readonly end: number) {
    super(`the image's offsets reach byte ${end}`);
  }
}

function within(bytes: Uint8Array, end: number): void {
  if (!Number.isSafeInteger(end) || end < 0) throw new Error("invalid image offset");
  if (end > bytes.length) throw new Short(end);
}

function jpegExif(bytes: Uint8Array): Uint8Array | undefined {
  let at = 2;
  for (;;) {
    within(bytes, at + 4);
    if (bytes[at] !== 0xff) throw new Error(`no JPEG marker at byte ${at}`);
    while (bytes[at] === 0xff) within(bytes, ++at + 3);
    const marker = bytes[at++]!;
    if (marker === 0xd9 || marker === 0xda) return undefined;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = u16be(bytes, at)!;
    if (length < 2) throw new Error(`a JPEG segment of length ${length}`);
    within(bytes, at + length);
    const content = at + 2;
    if (marker === 0xe1 && ascii(bytes, content, 4) === "Exif" && bytes[content + 4] === 0 && bytes[content + 5] === 0) {
      return bytes.subarray(content + 6, at + length);
    }
    at += length;
  }
}

interface Box { type: string; content: number; end: number }

function boxes(bytes: Uint8Array, start: number, end: number): Box[] {
  const out: Box[] = [];
  for (let at = start; at + 8 <= end;) {
    let size = u32be(bytes, at)!;
    let content = at + 8;
    if (size === 1) {
      const high = u32be(bytes, at + 8)!;
      const low = u32be(bytes, at + 12)!;
      size = high * 2 ** 32 + low;
      content = at + 16;
    } else if (size === 0) size = end - at;
    if (size < content - at || at + size > end) break;
    out.push({ type: ascii(bytes, at + 4, 4), content, end: at + size });
    at += size;
  }
  return out;
}

function metaBox(bytes: Uint8Array): Box | undefined {
  for (let at = 0; ;) {
    within(bytes, at + 16);
    let size = u32be(bytes, at)!;
    let content = at + 8;
    if (size === 1) {
      size = u32be(bytes, at + 8)! * 2 ** 32 + u32be(bytes, at + 12)!;
      content = at + 16;
    }
    if (size === 0 || size < content - at) return undefined;
    if (ascii(bytes, at + 4, 4) === "meta") {
      within(bytes, at + size);
      return { type: "meta", content, end: at + size };
    }
    at += size;
  }
}

function heicExif(bytes: Uint8Array): Uint8Array | undefined {
  const meta = metaBox(bytes);
  if (meta === undefined) return undefined;
  const children = boxes(bytes, meta.content + 4, meta.end);
  const iinf = children.find((box) => box.type === "iinf");
  const iloc = children.find((box) => box.type === "iloc");
  if (iinf === undefined || iloc === undefined) return undefined;
  const id = exifItem(bytes, iinf);
  if (id === undefined) return undefined;
  const item = located(bytes, iloc, id);
  if (item === undefined) return undefined;
  const headerOffset = u32be(item, 0);
  if (headerOffset === undefined || 4 + headerOffset > item.length) return undefined;
  return item.subarray(4 + headerOffset);
}

function exifItem(bytes: Uint8Array, iinf: Box): number | undefined {
  const countSize = bytes[iinf.content] === 0 ? 2 : 4;
  for (const entry of boxes(bytes, iinf.content + 4 + countSize, iinf.end)) {
    if (entry.type !== "infe") continue;
    const version = bytes[entry.content];
    if (version === 2 && ascii(bytes, entry.content + 8, 4) === "Exif") return u16be(bytes, entry.content + 4);
    if (version === 3 && ascii(bytes, entry.content + 10, 4) === "Exif") return u32be(bytes, entry.content + 4);
  }
  return undefined;
}

function located(bytes: Uint8Array, iloc: Box, wanted: number): Uint8Array | undefined {
  const version = bytes[iloc.content]!;
  if (version > 2) return undefined;
  const sizes = bytes[iloc.content + 4]!;
  const sizes2 = bytes[iloc.content + 5]!;
  const offsetSize = sizes >>> 4;
  const lengthSize = sizes & 0x0f;
  const baseSize = sizes2 >>> 4;
  const indexSize = version === 0 ? 0 : sizes2 & 0x0f;
  if (![offsetSize, lengthSize, baseSize, indexSize].every((size) => size === 0 || size === 2 || size === 4 || size === 8)) return undefined;
  const extentSize = indexSize + offsetSize + lengthSize;
  const sized = (at: number, size: number): number | undefined =>
    size === 0 ? 0 : size === 2 ? u16be(bytes, at) : size === 4 ? u32be(bytes, at) : size === 8 ? (u32be(bytes, at)! * 2 ** 32 + u32be(bytes, at + 4)!) : undefined;
  let at = iloc.content + 6;
  const count = version < 2 ? u16be(bytes, at) : u32be(bytes, at);
  if (count === undefined) return undefined;
  at += version < 2 ? 2 : 4;
  for (let item = 0; item < count; item++) {
    if (at >= iloc.end) return undefined;
    const id = version < 2 ? u16be(bytes, at) : u32be(bytes, at);
    at += version < 2 ? 2 : 4;
    let method = 0;
    if (version > 0) {
      method = u16be(bytes, at)! & 0x0f;
      at += 2;
    }
    at += 2;
    const base = sized(at, baseSize);
    at += baseSize;
    const extents = u16be(bytes, at);
    if (id === undefined || base === undefined || extents === undefined) return undefined;
    at += 2;
    if (id !== wanted) {
      at += extents * extentSize;
      continue;
    }
    if (method !== 0 || extents === 0) return undefined;
    const parts: Uint8Array[] = [];
    let total = 0;
    for (let extent = 0; extent < extents; extent++) {
      at += indexSize;
      const offset = sized(at, offsetSize);
      at += offsetSize;
      const length = sized(at, lengthSize);
      at += lengthSize;
      if (offset === undefined || length === undefined || length <= 0 || at > iloc.end) return undefined;
      total += length;
      if (total > WINDOW) return undefined;
      const start = base + offset;
      within(bytes, start + length);
      parts.push(bytes.subarray(start, start + length));
    }
    return Buffer.concat(parts);
  }
  return undefined;
}

function isTiff(bytes: Uint8Array): boolean {
  return (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 42 && bytes[3] === 0) ||
    (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && bytes[3] === 42);
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length));
}

function u16be(bytes: Uint8Array, at: number): number | undefined {
  return at + 2 <= bytes.length ? bytes[at]! << 8 | bytes[at + 1]! : undefined;
}

function u32be(bytes: Uint8Array, at: number): number | undefined {
  return at + 4 <= bytes.length ? (bytes[at + 1]! << 16 | bytes[at + 2]! << 8 | bytes[at + 3]!) + bytes[at]! * 2 ** 24 : undefined;
}

function summary(bytes: Buffer, file: boolean): ExifSummary | undefined {
  const has = (end: number): boolean => {
    if (end <= bytes.length) return true;
    if (file) throw new Short(end);
    return false;
  };
  if (!has(8)) return undefined;
  const little = bytes[0] === 0x49 && bytes[1] === 0x49;
  if (!little && !(bytes[0] === 0x4d && bytes[1] === 0x4d)) return undefined;
  const u16 = (at: number): number | undefined => (at < 0 || !has(at + 2) ? undefined : little ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at));
  const u32 = (at: number): number | undefined => (at < 0 || !has(at + 4) ? undefined : little ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at));
  const entries = (offset: number | undefined): number[] | undefined => {
    if (offset === undefined) return undefined;
    const count = u16(offset);
    if (count === undefined || count > 4096 || !has(offset + 2 + count * 12)) return undefined;
    return Array.from({ length: count }, (_, index) => offset + 2 + index * 12);
  };
  const ascii = (entry: number, count: number): string | undefined => {
    if (count < 1 || count > 65_536) return undefined;
    const at = count <= 4 ? entry + 8 : u32(entry + 8);
    if (at === undefined || !has(at + count)) return undefined;
    const raw = bytes.subarray(at, at + count);
    const nul = raw.indexOf(0);
    const value = nul < 0 ? raw : raw.subarray(0, nul);
    return value.length === 0 || value.some((byte) => byte > 0x7f) ? undefined : value.toString("ascii");
  };
  if (u16(2) !== 42) return undefined;
  const ifd0 = entries(u32(4));
  if (ifd0 === undefined) return undefined;
  const degrees = (entry: number): number | undefined => {
    const at = u32(entry + 8);
    if (at === undefined) return undefined;
    let sum = 0;
    for (let part = 0; part < 3; part++) {
      const [numerator, denominator] = [u32(at + part * 8), u32(at + part * 8 + 4)];
      if (numerator === undefined || denominator === undefined || denominator === 0) return undefined;
      sum += numerator / denominator / 60 ** part;
    }
    return sum;
  };
  const found: { [name in Exclude<keyof ExifSummary, "gps" | "unreadable" | "taken">]?: string | undefined } = {};
  let gpsIfd: number | undefined;
  let exifIfd: number | undefined;
  for (const entry of ifd0) {
    const [tag, type, count] = [u16(entry), u16(entry + 2), u32(entry + 4)];
    if (tag === undefined || type === undefined || count === undefined) return undefined;
    if (tag === TAG_MAKE && type === ASCII) found.make ??= ascii(entry, count);
    else if (tag === TAG_MODEL && type === ASCII) found.model ??= ascii(entry, count);
    else if (tag === TAG_GPS_IFD && type === LONG && count === 1) gpsIfd ??= u32(entry + 8);
    else if (tag === TAG_EXIF_IFD && type === LONG && count === 1) exifIfd ??= u32(entry + 8);
  }
  const original: { time?: string | undefined; offset?: string | undefined; subsec?: string | undefined } = {};
  for (const entry of entries(exifIfd) ?? []) {
    const [tag, type, count] = [u16(entry), u16(entry + 2), u32(entry + 4)];
    if (tag === undefined || type !== ASCII || count === undefined) continue;
    if (tag === TAG_DATE_TIME_ORIGINAL) original.time ??= ascii(entry, count);
    else if (tag === TAG_OFFSET_TIME_ORIGINAL) original.offset ??= ascii(entry, count);
    else if (tag === TAG_SUB_SEC_TIME_ORIGINAL) original.subsec ??= ascii(entry, count);
  }
  const gps: { latitudeRef?: string | undefined; latitude?: number | undefined; longitudeRef?: string | undefined; longitude?: number | undefined; status?: string | undefined } = {};
  for (const entry of entries(gpsIfd) ?? []) {
    const [tag, type, count] = [u16(entry), u16(entry + 2), u32(entry + 4)];
    if (tag === undefined || type === undefined || count === undefined) continue;
    if (type === ASCII && tag === TAG_GPS_LATITUDE_REF) gps.latitudeRef ??= ascii(entry, count);
    else if (type === ASCII && tag === TAG_GPS_LONGITUDE_REF) gps.longitudeRef ??= ascii(entry, count);
    else if (type === ASCII && tag === TAG_GPS_STATUS) gps.status ??= ascii(entry, count);
    else if (type === RATIONAL && count === 3 && tag === TAG_GPS_LATITUDE) gps.latitude ??= degrees(entry);
    else if (type === RATIONAL && count === 3 && tag === TAG_GPS_LONGITUDE) gps.longitude ??= degrees(entry);
  }
  const stated: ExifSummary = {};
  for (const name of Object.keys(found) as (keyof typeof found)[]) {
    const value = found[name];
    if (value !== undefined) stated[name] = value;
  }
  const north = gps.latitudeRef === "N" ? 1 : gps.latitudeRef === "S" ? -1 : 0;
  const east = gps.longitudeRef === "E" ? 1 : gps.longitudeRef === "W" ? -1 : 0;
  if (gps.status !== "V" && north !== 0 && east !== 0 && gps.latitude !== undefined && gps.longitude !== undefined && gps.latitude <= 90 && gps.longitude <= 180) {
    stated.gps = { latitude: north * gps.latitude, longitude: east * gps.longitude };
  }
  const taken = takenOf(original.time, original.offset, original.subsec);
  if (taken !== undefined) stated.taken = taken;
  return Object.keys(stated).length === 0 ? undefined : stated;
}

function takenOf(time: string | undefined, offset: string | undefined, subsec: string | undefined): ExifSummary["taken"] {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u.exec(time?.trim() ?? "");
  if (m === null) return undefined;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return undefined;
  const digits = subsec?.trim() ?? "";
  const fraction = /^\d{1,9}$/u.test(digits) ? `.${digits}` : "";
  const clock = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${fraction}`;
  const stated = offset?.trim() ?? "";
  return /^[+-]\d{2}:\d{2}$/u.test(stated) ? { clock, offset: stated } : { clock };
}
