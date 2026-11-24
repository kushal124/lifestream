import { closeSync, createReadStream, fstatSync, openSync, readSync } from "node:fs";
import { pipeline, Readable, Transform } from "node:stream";
import { crc32, createInflateRaw, inflateRawSync } from "node:zlib";
import { type BlobReader, type DeliveryFile } from "@lifestreamprotocol/core";
import { CodedRefused, refuseAs } from "./refused.js";

/** One entry a zip's central directory lists. */
export interface ZipEntry {
  /** Its path inside the zip, read as UTF-8, or as Latin-1 when it is not UTF-8. */
  readonly name: string;
  /** Its size in bytes once inflated, as the directory states it. */
  readonly size: number;
  /** Whether it is a folder, its name ending in a slash. */
  readonly directory: boolean;
  /** Its bytes at once, inflated and checked against the directory's size and CRC-32, refused before any is read when it holds more than the limit given, `BYTES_LIMIT` when none is. */
  bytes(limit?: number): Buffer;
  /** Its bytes as a stream, inflated and checked against the directory's size and CRC-32 as they pass. */
  stream(): Readable;
}

/** The bytes a zip is read from: a file on disk, or a file the home keeps sealed. */
export interface ZipSource {
  /** Its length in bytes. */
  readonly size: number;
  /** Reads into the buffer given from the offset given, and answers how many bytes it read. */
  read(into: Buffer, at: number): number;
  /** Its bytes from `start` up to but not including `end`, as a stream. */
  reading(range: { start: number; end: number }): Readable;
  /** Frees what it holds open. */
  close(): void;
}

/** A zip file on disk, opened by its central directory. */
export interface Zip {
  /** The file it was opened from. */
  readonly path: string;
  /** How many entries its central directory lists. */
  readonly count: number;
  /** Its entries, folders included, in the directory's order, each read from the directory as it is reached. */
  entries(): Generator<ZipEntry>;
  /** The entry of the name given, found by walking the directory, or undefined when it has none. */
  entry(name: string): ZipEntry | undefined;
  /** Closes the file and frees the copy it was opened from, if any. */
  close(): void;
}

const CHUNK = 1024 * 1024;
const WINDOW = 4 * CHUNK;
/** The most bytes, 64 MiB, a whole read of one file takes when no other limit is given. */
export const BYTES_LIMIT = 64 * CHUNK;
const U16 = 0xffff;
const U32 = 0xffffffff;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** Opens a zip, ZIP64 included, from the file at `path` or from the source given, named by `path`, refusing one whose central directory is damaged, with `dispose` run once it closes. */
export function openZip(path: string, dispose?: () => void, source?: ZipSource): Zip {
  let from: ZipSource;
  try {
    from = source ?? fileSource(path);
  } catch (error) {
    dispose?.();
    throw error;
  }
  let open = true;
  try {
    const size = from.size;
    const read = (at: number, length: number): Buffer => {
      if (!open) refuseAs(`${path} is closed`, "ZIP");
      if (at < 0 || length < 0 || at + length > size) refuseAs(`${path}: a record lies outside the archive`, "ZIP");
      const buffer = Buffer.allocUnsafe(length);
      for (let done = 0; done < length; ) {
        const count = from.read(buffer.subarray(done), at + done);
        if (count === 0) refuseAs(`${path} was truncated while reading`, "ZIP");
        done += count;
      }
      return buffer;
    };
    const directory = centralDirectory(path, size, read);

    function* entries(): Generator<ZipEntry> {
      const end = directory.offset + directory.length;
      let window: Buffer = Buffer.alloc(0);
      let windowAt = directory.offset;
      const take = (at: number, length: number): Buffer => {
        if (at + length > end) refuseAs(`${path}: the central directory is shorter than its records`, "ZIP");
        if (at < windowAt || at + length > windowAt + window.length) {
          window = read(at, Math.min(Math.max(length, WINDOW), end - at));
          windowAt = at;
        }
        return window.subarray(at - windowAt, at - windowAt + length);
      };
      let at = directory.offset;
      for (let index = 0; index < directory.count; index++) {
        const fixed = Buffer.from(take(at, 46));
        if (fixed.readUInt32LE(0) !== 0x02014b50) refuseAs(`${path}: central record ${index} has no signature`, "ZIP");
        const flags = fixed.readUInt16LE(8);
        const nameLength = fixed.readUInt16LE(28);
        const extraLength = fixed.readUInt16LE(30);
        const commentLength = fixed.readUInt16LE(32);
        const variable = take(at + 46, nameLength + extraLength + commentLength);
        const name = decodeName(variable.subarray(0, nameLength));
        let compressed = fixed.readUInt32LE(20);
        let uncompressed = fixed.readUInt32LE(24);
        let local = fixed.readUInt32LE(42);
        let disk = fixed.readUInt16LE(34);
        if (compressed === U32 || uncompressed === U32 || local === U32 || disk === U16) {
          const wide = zip64Extra(variable.subarray(nameLength, nameLength + extraLength), `${path}: ${name}`);
          if (uncompressed === U32) uncompressed = wide.next("uncompressed size");
          if (compressed === U32) compressed = wide.next("compressed size");
          if (local === U32) local = wide.next("local header offset");
          if (disk === U16) disk = wide.next("disk");
        }
        if (disk !== 0) refuseAs(`${path}: ${name} starts on another disk`, "ZIP");
        yield member(path, read, from, directory.offset, {
          name,
          flags,
          method: fixed.readUInt16LE(10),
          crc: fixed.readUInt32LE(16),
          compressed,
          uncompressed,
          local,
        });
        at += 46 + nameLength + extraLength + commentLength;
      }
      if (at !== end) refuseAs(`${path}: the central directory's length disagrees with its records`, "ZIP");
    }

    return {
      path,
      count: directory.count,
      entries,
      entry(name) {
        for (const entry of entries()) if (entry.name === name) return entry;
        return undefined;
      },
      close() {
        if (!open) return;
        open = false;
        try {
          from.close();
        } finally {
          dispose?.();
        }
      },
    };
  } catch (error) {
    open = false;
    try {
      from.close();
    } finally {
      dispose?.();
    }
    throw error;
  }
}

function fileSource(path: string): ZipSource {
  const fd = openSync(path, "r");
  try {
    return {
      size: fstatSync(fd).size,
      read: (into, at) => readSync(fd, into, 0, into.length, at),
      reading: ({ start, end }) => createReadStream(path, { start, end: end - 1, highWaterMark: CHUNK }),
      close: () => closeSync(fd),
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Opens a delivered file as a zip from a copy on disk, freed when it closes. */
export async function openDeliveredZip(files: BlobReader, file: DeliveryFile): Promise<Zip> {
  const materialised = await files.materialise(file.blob);
  return openZip(materialised.path, () => materialised.dispose());
}

interface CentralRecord {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressed: number;
  uncompressed: number;
  local: number;
}

function member(path: string, read: (at: number, length: number) => Buffer, from: ZipSource, directoryAt: number, record: CentralRecord): ZipEntry {
  const where = `${path}: ${record.name}`;
  const encrypted = (record.flags & 1) !== 0;
  const dataAt = (): number => {
    if (encrypted) refuseAs(`${where} is encrypted`, "ZIP");
    if (record.method !== 0 && record.method !== 8) refuseAs(`${where} uses compression method ${record.method}`, "ZIP");
    const header = read(record.local, 30);
    if (header.readUInt32LE(0) !== 0x04034b50) refuseAs(`${where} has no local header`, "ZIP");
    const start = record.local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    if (start + record.compressed > directoryAt) refuseAs(`${where}: its data runs into the central directory`, "ZIP");
    return start;
  };
  const damaged = (detail: string): CodedRefused => new CodedRefused(`${where} ${detail}`, "ZIP");

  return {
    name: record.name,
    size: record.uncompressed,
    directory: record.name.endsWith("/"),
    bytes(limit = BYTES_LIMIT) {
      if (record.uncompressed > limit) refuseAs(`${where} holds ${record.uncompressed} bytes, past the ${limit} a whole read takes`, "ZIP");
      const start = dataAt();
      const stored = read(start, record.compressed);
      let bytes = stored;
      if (record.method !== 0) {
        try {
          bytes = inflateRawSync(stored, { maxOutputLength: Math.max(1, record.uncompressed) });
        } catch (error) {
          throw damaged(`does not inflate: ${(error as Error).message}`);
        }
      }
      const crc = crc32(bytes);
      if (bytes.length !== record.uncompressed || crc !== record.crc) {
        throw damaged(`reads as ${bytes.length} bytes with CRC-32 ${crc.toString(16)}; the directory states ${record.uncompressed} and ${record.crc.toString(16)}`);
      }
      return bytes;
    },
    stream() {
      const start = dataAt();
      let size = 0;
      let crc = 0;
      const verify = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          size += chunk.length;
          if (size > record.uncompressed) return done(damaged(`expands past its stated ${record.uncompressed} bytes`));
          crc = crc32(chunk, crc);
          done(null, chunk);
        },
        flush(done) {
          done(size === record.uncompressed && crc === record.crc ? null : damaged(`reads as ${size} bytes with CRC-32 ${crc.toString(16)}`));
        },
      });
      if (record.compressed === 0) return pipeline(Readable.from([]), verify, () => {});
      const source = from.reading({ start, end: start + record.compressed });
      if (record.method === 0) return pipeline(source, verify, () => {});
      const inflate = createInflateRaw({ chunkSize: CHUNK });
      source.on("error", (error) => verify.destroy(error));
      inflate.on("error", (error) => verify.destroy(damaged(`does not inflate: ${error.message}`)));
      verify.on("close", () => {
        source.destroy();
        inflate.destroy();
      });
      source.pipe(inflate).pipe(verify);
      return verify;
    },
  };
}

function centralDirectory(path: string, size: number, read: (at: number, length: number) => Buffer): { offset: number; length: number; count: number } {
  const tailLength = Math.min(size, 22 + 0xffff);
  const tail = read(size - tailLength, tailLength);
  let eocd = -1;
  for (let at = tail.length - 22; at >= 0; at--) {
    if (tail.readUInt32LE(at) === 0x06054b50 && at + 22 + tail.readUInt16LE(at + 20) === tail.length) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) refuseAs(`${path} has no end-of-central-directory record: not a ZIP archive`, "ZIP");
  const record = tail.subarray(eocd, eocd + 22);
  let disk = record.readUInt16LE(4);
  let directoryDisk = record.readUInt16LE(6);
  let onDisk = record.readUInt16LE(8);
  let count = record.readUInt16LE(10);
  let length = record.readUInt32LE(12);
  let offset = record.readUInt32LE(16);
  let limit = size - tailLength + eocd;
  if (disk === U16 || directoryDisk === U16 || onDisk === U16 || count === U16 || length === U32 || offset === U32) {
    if (limit < 20) refuseAs(`${path}: the ZIP64 locator is missing`, "ZIP");
    const locator = read(limit - 20, 20);
    if (locator.readUInt32LE(0) !== 0x07064b50) refuseAs(`${path}: the ZIP64 locator is missing`, "ZIP");
    if (locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) refuseAs(`${path} spans several disks`, "ZIP");
    const at = safe(locator.readBigUInt64LE(8), `${path}: the ZIP64 record offset`);
    const wide = read(at, 56);
    if (wide.readUInt32LE(0) !== 0x06064b50) refuseAs(`${path}: the ZIP64 record has no signature`, "ZIP");
    disk = wide.readUInt32LE(16);
    directoryDisk = wide.readUInt32LE(20);
    onDisk = safe(wide.readBigUInt64LE(24), `${path}: the ZIP64 count`);
    count = safe(wide.readBigUInt64LE(32), `${path}: the ZIP64 count`);
    length = safe(wide.readBigUInt64LE(40), `${path}: the ZIP64 directory length`);
    offset = safe(wide.readBigUInt64LE(48), `${path}: the ZIP64 directory offset`);
    limit = at;
  }
  if (disk !== 0 || directoryDisk !== 0 || onDisk !== count) refuseAs(`${path} spans several disks`, "ZIP");
  if (offset + length > limit) refuseAs(`${path}: the central directory lies outside the archive`, "ZIP");
  return { offset, length, count };
}

function zip64Extra(extra: Buffer, where: string): { next(what: string): number } {
  for (let at = 0; at + 4 <= extra.length; ) {
    const id = extra.readUInt16LE(at);
    const length = extra.readUInt16LE(at + 2);
    if (at + 4 + length > extra.length) break;
    if (id === 0x0001) {
      const field = extra.subarray(at + 4, at + 4 + length);
      let position = 0;
      return {
        next(what) {
          if (what === "disk") {
            if (position + 4 > field.length) refuseAs(`${where}: the ZIP64 field lacks its ${what}`, "ZIP");
            position += 4;
            return field.readUInt32LE(position - 4);
          }
          if (position + 8 > field.length) refuseAs(`${where}: the ZIP64 field lacks its ${what}`, "ZIP");
          position += 8;
          return safe(field.readBigUInt64LE(position - 8), `${where}: the ZIP64 ${what}`);
        },
      };
    }
    at += 4 + length;
  }
  return refuseAs(`${where} needs a ZIP64 field and has none`, "ZIP");
}

function decodeName(bytes: Buffer): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    return bytes.toString("latin1");
  }
}

function safe(value: bigint, what: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) refuseAs(`${what} is past the safe integer range`, "ZIP");
  return Number(value);
}
