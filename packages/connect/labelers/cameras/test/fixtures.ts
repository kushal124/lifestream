
export interface Exif {
  make?: string;
  model?: string;
  gps?: { latitude: number; longitude: number; status?: "A" | "V"; hemispheres?: false };
}

export function tiff(options: Exif = {}): Buffer {
  const make = `${options.make ?? "Synthetic Make"}\0`;
  const model = `${options.model ?? "Synthetic Camera"}\0`;
  const ifd0DateTime = "2040:12:31 23:59:59\0";
  const original = "2026:08:24 18:23:00\0";
  const offset = "+05:30\0";
  const gps = options.gps;
  const bytes = Buffer.alloc(gps === undefined ? 512 : 640);
  const entry = (at: number, tag: number, type: number, count: number, value: number): void => {
    bytes.writeUInt16LE(tag, at);
    bytes.writeUInt16LE(type, at + 2);
    bytes.writeUInt32LE(count, at + 4);
    bytes.writeUInt32LE(value, at + 8);
  };
  bytes.write("II", 0, "ascii");
  bytes.writeUInt16LE(42, 2);
  bytes.writeUInt32LE(8, 4);
  bytes.writeUInt16LE(gps === undefined ? 4 : 5, 8);
  entry(10, 0x010f, 2, Buffer.byteLength(make), 128);
  entry(22, 0x0110, 2, Buffer.byteLength(model), 160);
  entry(34, 0x0132, 2, Buffer.byteLength(ifd0DateTime), 208);
  entry(46, 0x8769, 4, 1, 256);
  if (gps !== undefined) entry(58, 0x8825, 4, 1, 448);
  bytes.writeUInt32LE(0, gps === undefined ? 58 : 70);
  if (gps !== undefined) {
    const rationals = (at: number, value: number) => {
      const whole = Math.abs(value);
      const degrees = Math.floor(whole);
      const minutes = Math.floor((whole - degrees) * 60);
      const seconds = Math.round(((whole - degrees) * 60 - minutes) * 60 * 10_000);
      [[degrees, 1], [minutes, 1], [seconds, 10_000]].forEach(([numerator, denominator], index) => {
        bytes.writeUInt32LE(numerator!, at + index * 8);
        bytes.writeUInt32LE(denominator!, at + index * 8 + 4);
      });
    };
    const fields = [
      ...(gps.hemispheres === false ? [] : [{ tag: 1, type: 2, count: 2, inline: gps.latitude < 0 ? "S" : "N" }]),
      { tag: 2, type: 5, count: 3, at: 512 },
      ...(gps.hemispheres === false ? [] : [{ tag: 3, type: 2, count: 2, inline: gps.longitude < 0 ? "W" : "E" }]),
      { tag: 4, type: 5, count: 3, at: 560 },
      ...(gps.status === undefined ? [] : [{ tag: 9, type: 2, count: 2, inline: gps.status }]),
    ];
    bytes.writeUInt16LE(fields.length, 448);
    fields.forEach((field, index) => {
      const at = 450 + index * 12;
      entry(at, field.tag, field.type, field.count, field.at ?? 0);
      if (field.inline !== undefined) bytes.write(`${field.inline}\0`, at + 8, "ascii");
    });
    rationals(512, gps.latitude);
    rationals(560, gps.longitude);
  }
  bytes.write(make, 128, "ascii");
  bytes.write(model, 160, "ascii");
  bytes.write(ifd0DateTime, 208, "ascii");
  const exif = [{ tag: 0x9003, value: original, at: 320 }, { tag: 0x9011, value: offset, at: 384 }];
  bytes.writeUInt16LE(exif.length, 256);
  for (const [index, item] of exif.entries()) {
    entry(258 + index * 12, item.tag, 2, Buffer.byteLength(item.value), item.at);
    bytes.write(item.value, item.at, "ascii");
  }
  bytes.writeUInt32LE(0, 258 + exif.length * 12);
  return bytes;
}

export function jpeg(tiffBytes: Buffer, body = "synthetic scan data"): Buffer {
  const length = tiffBytes.byteLength + 8;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe1, length >>> 8, length & 0xff]),
    Buffer.from("Exif\0\0", "binary"),
    tiffBytes,
    Buffer.from([0xff, 0xda]),
    Buffer.from(body),
    Buffer.from([0xff, 0xd9]),
  ]);
}
