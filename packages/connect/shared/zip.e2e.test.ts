import { artifact, exportLines, MiB, temp, writeZip } from "../test/drive.js";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, openSync, readSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodedRefused, Refused } from "./refused.js";
import { openZip, type ZipEntry } from "./zip.js";

const sha = (chunks: Iterable<Buffer>): string => {
  const hash = createHash("sha256");
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest("hex");
};

async function refusalOf(read: () => Promise<unknown>): Promise<string> {
  try {
    await read();
  } catch (error) {
    if (error instanceof Refused) return `${error instanceof CodedRefused ? error.code : undefined} ${error.message}`;
    throw error;
  }
  return "read";
}

async function streamed(entry: ZipEntry): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of entry.stream()) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function refusal(read: () => unknown): string {
  try {
    read();
  } catch (error) {
    if (error instanceof Refused) return `${error instanceof CodedRefused ? error.code : undefined} ${error.message}`;
    throw error;
  }
  return "read";
}

describe("ZIP reading: each of these is impossible", () => {
  it("a member reads other bytes than were stored, by either reader", async () => {
    const dir = temp();
    const path = join(dir, "takeout.zip");
    const small = Buffer.from('{"title":"fake note","from":"person-a@example.com"}\n');
    const large = 12 * MiB;
    const random = randomBytes(3 * MiB);
    writeZip(path, [
      { name: "Takeout/", bytes: Buffer.alloc(0) },
      { name: "Takeout/Keep/note.json", bytes: small, method: "deflate" },
      { name: "Takeout/Mail/All mail.mbox", bytes: () => exportLines(large), method: "deflate" },
      { name: "Takeout/Photos/IMG_0001.jpg", bytes: random },
      { name: "Takeout/empty.txt", bytes: Buffer.alloc(0), method: "deflate" },
    ]);
    const zip = openZip(path);
    try {
      const listed = [...zip.entries()].map((entry) => ({ name: entry.name, size: entry.size, directory: entry.directory }));
      expect(listed.map((entry) => entry.name)).toEqual([
        "Takeout/",
        "Takeout/Keep/note.json",
        "Takeout/Mail/All mail.mbox",
        "Takeout/Photos/IMG_0001.jpg",
        "Takeout/empty.txt",
      ]);
      expect(listed[0]?.directory).toBe(true);
      expect(zip.entry("Takeout/Keep/note.json")?.bytes()).toEqual(small);
      const mbox = zip.entry("Takeout/Mail/All mail.mbox")!;
      expect(mbox.size).toBe(large);
      const expected = sha(exportLines(large));
      expect(await streamed(mbox)).toBe(expected);
      expect(await streamed(zip.entry("Takeout/Photos/IMG_0001.jpg")!)).toBe(sha([random]));
      expect(zip.entry("Takeout/empty.txt")!.bytes().length).toBe(0);
      for await (const chunk of mbox.stream()) {
        expect((chunk as Buffer).length).toBeGreaterThan(0);
        break;
      }
      expect(await streamed(mbox)).toBe(expected);
      artifact(dir, "members.json", { listed, mbox_sha256: expected });
    } finally {
      zip.close();
    }
  });

  it("a ZIP64 archive reads as a plain one", () => {
    const dir = temp();
    const path = join(dir, "bundle.zip");
    const bytes = Buffer.from("fake screen observation from macbook-pro-0001\n");
    writeZip(path, [{ name: "observations.jsonl", bytes }, { name: "blobs/aa", bytes: Buffer.from("fake"), method: "deflate" }], { zip64: true });
    const zip = openZip(path);
    try {
      expect(zip.entry("observations.jsonl")!.bytes()).toEqual(bytes);
      expect(zip.entry("blobs/aa")!.bytes().toString()).toBe("fake");
      artifact(dir, "zip64.json", [...zip.entries()].map((entry) => entry.name));
    } finally {
      zip.close();
    }
  });

  it("a damaged member reads without an error", async () => {
    const dir = temp();
    const stored = join(dir, "stored.zip");
    const deflated = join(dir, "deflated.zip");
    const bytes = Buffer.from("fake message text, sent to person-a@example.com\n".repeat(200));
    writeZip(stored, [{ name: "a.txt", bytes }]);
    writeZip(deflated, [{ name: "a.txt", bytes: () => exportLines(10 * MiB), method: "deflate" }]);
    for (const [path, at] of [[stored, 30 + 5 + 100], [deflated, 30 + 5 + 4096]] as const) {
      const fd = openSync(path, "r+");
      const byte = Buffer.alloc(1);
      readSync(fd, byte, 0, 1, at);
      byte[0] = byte[0]! ^ 0x55;
      writeSync(fd, byte, 0, 1, at);
      closeSync(fd);
    }
    const codes: string[] = [];
    for (const path of [stored, deflated]) {
      const zip = openZip(path);
      try {
        codes.push(await refusalOf(() => streamed(zip.entry("a.txt")!)));
      } finally {
        zip.close();
      }
    }
    const damage = /^ZIP \S+: a\.txt (?:reads as|expands past|does not inflate) /u;
    expect(codes).toEqual([expect.stringMatching(damage), expect.stringMatching(damage)]);
    artifact(dir, "damaged.json", codes);
  });

  it("a member is found under a name its archive did not give it", () => {
    const dir = temp();
    const path = join(dir, "names.zip");
    writeZip(path, [
      { name: "Fotos/Café.jpg", bytes: Buffer.from("a") },
      { name: "Notizen/Grüße.txt", nameBytes: Buffer.from("Notizen/Grüße.txt", "utf8"), bytes: Buffer.from("b") },
      { name: "x", nameBytes: Buffer.from([0x6e, 0x6f, 0x74, 0x65, 0xe9, 0x2e, 0x74, 0x78, 0x74]), bytes: Buffer.from("c") },
    ]);
    const zip = openZip(path);
    try {
      const names = [...zip.entries()].map((entry) => entry.name);
      expect(names).toEqual(["Fotos/Café.jpg", "Notizen/Grüße.txt", "noteé.txt"]);
      expect(zip.entry("Notizen/Grüße.txt")!.bytes().toString()).toBe("b");
      expect(zip.entry("notes.txt")).toBeUndefined();
      artifact(dir, "names.json", names);
    } finally {
      zip.close();
    }
  });

  it("a file that is not a ZIP, or a member it cannot read, reads as bytes", () => {
    const dir = temp();
    const notZip = join(dir, "export.zip");
    writeFileSync(notZip, Buffer.from("fake export, not an archive\n".repeat(10)));
    const odd = join(dir, "odd.zip");
    writeZip(odd, [{ name: "a.bin", bytes: Buffer.from("fake bytes") }, { name: "b.bin", bytes: Buffer.alloc(80 * MiB, 7), method: "deflate" }]);
    const fd = openSync(odd, "r+");
    const end = Buffer.alloc(22);
    readSync(fd, end, 0, 22, statSync(odd).size - 22);
    const start = end.readUInt32LE(16);
    const flags = Buffer.alloc(2);
    readSync(fd, flags, 0, 2, start + 8);
    flags.writeUInt16LE(flags.readUInt16LE(0) | 1, 0);
    writeSync(fd, flags, 0, 2, start + 8);
    const method = Buffer.alloc(2);
    method.writeUInt16LE(14, 0);
    writeSync(fd, method, 0, 2, start + 46 + "a.bin".length + 10);
    closeSync(fd);
    const codes: string[] = [refusal(() => openZip(notZip))];
    const zip = openZip(odd);
    try {
      codes.push(refusal(() => zip.entry("a.bin")!.bytes()));
      codes.push(refusal(() => zip.entry("b.bin")!.bytes()));
    } finally {
      zip.close();
    }
    const big = join(dir, "big.zip");
    writeZip(big, [{ name: "b.bin", bytes: Buffer.alloc(80 * MiB, 7), method: "deflate" }]);
    const bigZip = openZip(big);
    try {
      codes.push(refusal(() => bigZip.entry("b.bin")!.bytes()));
      expect(bigZip.entry("b.bin")!.bytes(100 * MiB).length).toBe(80 * MiB);
    } finally {
      bigZip.close();
    }
    expect(codes).toEqual([
      expect.stringMatching(/^ZIP \S+ has no end-of-central-directory record: not a ZIP archive$/u),
      expect.stringMatching(/^ZIP \S+: a\.bin is encrypted$/u),
      expect.stringMatching(/^ZIP \S+: b\.bin holds 83886080 bytes, past the 67108864 a whole read takes$/u),
      expect.stringMatching(/^ZIP \S+: b\.bin holds 83886080 bytes, past the 67108864 a whole read takes$/u),
    ]);
    artifact(dir, "refusals.json", codes);
  });

  it("a file that does not open is refused as the archive's", () => {
    const dir = temp();
    let disposed = 0;
    let thrown: unknown;
    try {
      openZip(join(dir, "gone.zip"), () => disposed++);
    } catch (error) {
      thrown = error;
    }
    expect([thrown instanceof Refused, (thrown as NodeJS.ErrnoException).code, disposed]).toEqual([false, "ENOENT", 1]);
    const notZip = join(dir, "not.zip");
    writeFileSync(notZip, "fake text, no archive");
    expect(refusal(() => openZip(notZip))).toMatch(/^ZIP \S+ has no end-of-central-directory record: not a ZIP archive$/u);
  });
});
