import { closeSync, openSync, writeSync } from "node:fs";
import { constants, crc32, deflateRawSync } from "node:zlib";

const MiB = 1024 * 1024;

export interface FixtureMember {
  name: string;
  bytes: Buffer | (() => Iterable<Buffer>);
  method?: "stored" | "deflate";
  nameBytes?: Buffer;
  utf8Flag?: boolean;
}

function* coalesced(chunks: Iterable<Buffer>): Generator<Buffer> {
  let held: Buffer[] = [];
  let size = 0;
  for (const chunk of chunks) {
    held.push(chunk);
    size += chunk.length;
    if (size >= MiB) {
      yield Buffer.concat(held);
      held = [];
      size = 0;
    }
  }
  if (size > 0) yield Buffer.concat(held);
}

export function writeZip(path: string, members: FixtureMember[], options: { zip64?: boolean } = {}): void {
  const fd = openSync(path, "w");
  let offset = 0;
  const write = (buffer: Buffer): void => {
    writeSync(fd, buffer);
    offset += buffer.length;
  };
  const central: Buffer[] = [];
  try {
    for (const member of members) {
      const method = member.method === "deflate" ? 8 : 0;
      const name = member.nameBytes ?? Buffer.from(member.name, "utf8");
      const flags = (member.utf8Flag ?? member.nameBytes === undefined ? 0x0800 : 0) | 0x0008;
      const local = offset;
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(45, 4);
      header.writeUInt16LE(flags, 6);
      header.writeUInt16LE(method, 8);
      header.writeUInt16LE(name.length, 26);
      write(Buffer.concat([header, name]));
      let crc = 0;
      let size = 0;
      let compressed = 0;
      const chunks = typeof member.bytes === "function" ? coalesced(member.bytes()) : [member.bytes];
      if (method === 0) {
        for (const chunk of chunks) {
          crc = crc32(chunk, crc);
          size += chunk.length;
          write(chunk);
        }
        compressed = size;
      } else {
        for (const chunk of chunks) {
          crc = crc32(chunk, crc);
          size += chunk.length;
          const deflated = deflateRawSync(chunk, { level: 1, finishFlush: constants.Z_FULL_FLUSH });
          compressed += deflated.length;
          write(deflated);
        }
        const end = Buffer.from([0x03, 0x00]);
        compressed += end.length;
        write(end);
      }
      const large = options.zip64 === true || size >= 0xffffffff || compressed >= 0xffffffff || local >= 0xffffffff;
      const descriptor = Buffer.alloc(large ? 24 : 16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc >>> 0, 4);
      if (large) {
        descriptor.writeBigUInt64LE(BigInt(compressed), 8);
        descriptor.writeBigUInt64LE(BigInt(size), 16);
      } else {
        descriptor.writeUInt32LE(compressed, 8);
        descriptor.writeUInt32LE(size, 12);
      }
      write(descriptor);
      const extra = large ? Buffer.alloc(28) : Buffer.alloc(0);
      if (large) {
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(24, 2);
        extra.writeBigUInt64LE(BigInt(size), 4);
        extra.writeBigUInt64LE(BigInt(compressed), 12);
        extra.writeBigUInt64LE(BigInt(local), 20);
      }
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE(45, 4);
      record.writeUInt16LE(45, 6);
      record.writeUInt16LE(flags, 8);
      record.writeUInt16LE(method, 10);
      record.writeUInt32LE(crc >>> 0, 16);
      record.writeUInt32LE(large ? 0xffffffff : compressed, 20);
      record.writeUInt32LE(large ? 0xffffffff : size, 24);
      record.writeUInt16LE(name.length, 28);
      record.writeUInt16LE(extra.length, 30);
      record.writeUInt32LE(large ? 0xffffffff : local, 42);
      central.push(Buffer.concat([record, name, extra]));
    }
    const start = offset;
    for (const record of central) write(record);
    const length = offset - start;
    const zip64 = options.zip64 === true || start >= 0xffffffff || members.length >= 0xffff;
    if (zip64) {
      const record = Buffer.alloc(56);
      const at = offset;
      record.writeUInt32LE(0x06064b50, 0);
      record.writeBigUInt64LE(44n, 4);
      record.writeUInt16LE(45, 12);
      record.writeUInt16LE(45, 14);
      record.writeBigUInt64LE(BigInt(members.length), 24);
      record.writeBigUInt64LE(BigInt(members.length), 32);
      record.writeBigUInt64LE(BigInt(length), 40);
      record.writeBigUInt64LE(BigInt(start), 48);
      write(record);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeBigUInt64LE(BigInt(at), 8);
      locator.writeUInt32LE(1, 16);
      write(locator);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(zip64 ? 0xffff : members.length, 8);
    end.writeUInt16LE(zip64 ? 0xffff : members.length, 10);
    end.writeUInt32LE(zip64 ? 0xffffffff : length, 12);
    end.writeUInt32LE(zip64 ? 0xffffffff : start, 16);
    write(end);
  } finally {
    closeSync(fd);
  }
}
