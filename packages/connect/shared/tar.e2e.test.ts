import { hostFault } from "@lifestreamprotocol/core";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { temp } from "../test/drive.js";
import { Refused } from "./refused.js";
import { openTgz, pieceOf } from "./tar.js";

function thrown(read: () => unknown): unknown {
  try {
    read();
  } catch (error) {
    return error;
  }
  return undefined;
}

function member(name: string, bytes: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000644\0", 100, "latin1");
  header.write(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124, "latin1");
  header.write("0", 156, "latin1");
  header.write("ustar\0" + "00", 257, "latin1");
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return Buffer.concat([header, bytes, Buffer.alloc(Math.ceil(bytes.length / 512) * 512 - bytes.length)]);
}

describe("an inflating thread's answer: each of these is impossible", () => {
  it("a wait that brings no answer refuses the file", () => {
    const error = thrown(() => pieceOf("/home/inbox/takeout.tgz", 4096, undefined));
    expect([error instanceof Refused, hostFault(error), (error as NodeJS.ErrnoException).code]).toEqual([false, true, "ETIMEDOUT"]);
  });

  it("an inflate error the answer states reads as the machine's, or a fault of the machine as the file's", () => {
    const inflate = thrown(() => pieceOf("/home/inbox/takeout.tgz", 4096, { error: "incorrect header check", code: "Z_DATA_ERROR" }));
    expect([inflate instanceof Refused, (inflate as Error).message]).toEqual([true, "/home/inbox/takeout.tgz: its gzip does not inflate after 4096 inflated bytes: incorrect header check"]);
    for (const code of ["EIO", "EACCES", "EMFILE"]) {
      const fault = thrown(() => pieceOf("/home/inbox/takeout.tgz", 0, { error: `read ${code}`, code }));
      expect([code, fault instanceof Refused, (fault as NodeJS.ErrnoException).code]).toEqual([code, false, code]);
    }
    const piece = new ArrayBuffer(3);
    expect(pieceOf("/home/inbox/takeout.tgz", 0, { chunk: piece })).toEqual({ chunk: piece });
    expect(pieceOf("/home/inbox/takeout.tgz", 0, { end: true })).toEqual({ end: true });
  });

  it("a real gzip that does not inflate reads, or a real tar does not", () => {
    const dir = temp();
    const good = join(dir, "good.tgz");
    const bytes = Buffer.from('{"title":"fake note"}\n');
    writeFileSync(good, gzipSync(Buffer.concat([member("Takeout/note.json", bytes), Buffer.alloc(1024)])));
    const tgz = openTgz(good);
    try {
      expect([...tgz.entries()].map((entry) => [entry.name, entry.bytes().toString("utf8")])).toEqual([["Takeout/note.json", bytes.toString("utf8")]]);
    } finally {
      tgz.close();
    }
    const damaged = join(dir, "damaged.tgz");
    writeFileSync(damaged, Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00]), Buffer.alloc(64, 0xff)]));
    const bad = openTgz(damaged);
    try {
      const error = thrown(() => [...bad.entries()]);
      expect([error instanceof Refused, (error as Error).message]).toEqual([true, expect.stringMatching(/^\S+damaged\.tgz: its gzip does not inflate after 0 inflated bytes: /u)]);
    } finally {
      bad.close();
    }
  });
});
