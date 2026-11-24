import { spawnSync } from "node:child_process";
import { createCipheriv, createHash, hkdfSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  blobData,
  blobSealing,
  blobTree,
  fileData,
  HEADER_BYTES,
  identityOf,
  isTemporary,
  keyedName,
  layoutOf,
  MAX_SEGMENTS,
  nameKey,
  openBlob,
  openWhole,
  openFile,
  OpenStream,
  Positioned,
  readSealedSync,
  sealWhole,
  SealedError,
  SealedReader,
  SealStream,
  SEGMENT,
  segmentNonce,
  sweepTemporaries,
  TAG_BYTES,
  temporaryIn,
  VECTOR_SEGMENT,
  writeSealed,
  writeSealedSync,
  type Sealing,
  type SegmentSize,
} from "./sealed.js";
import { KEY, plain } from "./sealed-vectors/ours.js";

interface Vector {
  segment: SegmentSize;
  associatedData: string;
  plainLength: number;
  sealedLength: number;
  header: string;
  sha256: string;
  file?: string;
}

const VECTORS = new URL("./sealed-vectors/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("tink.json", VECTORS), "utf8")) as { tink: string; key: string; vectors: Vector[] };
const DAY = fileData("day", "2026-11-14");

function sealing(segment: SegmentSize = SEGMENT, associatedData = blobData()): Sealing {
  return { key: KEY, associatedData, segment };
}

function tinkFile(vector: Vector): Buffer {
  return readFileSync(new URL(vector.file!, VECTORS));
}

function hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "lifestream-sealed-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function drain(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(chunk as Buffer);
  return Buffer.concat(parts);
}

async function* positionedRange(path: string, opening: Sealing, start: number, end: number): AsyncGenerator<Buffer> {
  const positioned = await Positioned.open(path, opening, basename(path));
  try {
    yield* positioned.range(start, end);
  } finally {
    await positioned.handle.close();
  }
}

async function drainRange(path: string, opening: Sealing, start: number, end: number): Promise<Buffer> {
  return drain(Readable.from(positionedRange(path, opening, start, end)));
}

async function refusal(work: () => unknown): Promise<SealedError> {
  try {
    await work();
  } catch (error) {
    expect(error).toBeInstanceOf(SealedError);
    return error as SealedError;
  }
  throw new Error("the read was not refused");
}

async function refusedEveryWay(sealed: Buffer, opening: Sealing, code = "SEALED_DAMAGED"): Promise<void> {
  const dir = folder();
  const path = join(dir, "2026-11-14.day.txt.k1");
  writeFileSync(path, sealed);
  const errors = [
    await refusal(() => openWhole(sealed, opening, "2026-11-14.day.txt.k1")),
    await refusal(() => drain(openFile(path, opening))),
    await refusal(() => drainRange(path, opening, 0, wholeEnd(sealed, opening))),
  ];
  for (const error of errors) {
    expect(error.code).toBe(code);
    expect(error.file).toBe("2026-11-14.day.txt.k1");
    expect(error.message).toContain("2026-11-14.day.txt.k1");
  }
}

function wholeEnd(sealed: Buffer, opening: Sealing): number {
  try {
    return layoutOf(sealed.length, opening.segment, "whole").plainLength;
  } catch {
    return 1;
  }
}

function segmentsOf(sealed: Buffer, segment: number): Buffer[] {
  const parts = [sealed.subarray(HEADER_BYTES, Math.min(segment, sealed.length))];
  for (let at = segment; at < sealed.length; at += segment) parts.push(sealed.subarray(at, Math.min(at + segment, sealed.length)));
  return parts;
}

describe("gate G4: Tink's own files", () => {
  it("were made by Tink's library, with our key, both segment sizes and both associated data", () => {
    expect(manifest.tink).toMatch(/^tink-py \d+\.\d+\.\d+$/);
    expect(Buffer.from(manifest.key, "hex").equals(KEY)).toBe(true);
    expect(new Set(manifest.vectors.map((vector) => vector.segment))).toEqual(new Set([SEGMENT, VECTOR_SEGMENT]));
    expect(new Set(manifest.vectors.map((vector) => vector.associatedData))).toEqual(new Set([blobData(), DAY]));
    for (const segment of [SEGMENT, VECTOR_SEGMENT]) {
      const first = segment - HEADER_BYTES - TAG_BYTES;
      const later = segment - TAG_BYTES;
      const lengths = manifest.vectors.filter((vector) => vector.segment === segment && vector.associatedData === blobData()).map((vector) => vector.plainLength);
      expect(lengths).toEqual([0, 1, first - 1, first, first + 1, first + later + 1000, first + 2 * later]);
    }
  });

  it("are sealed.ts's bytes exactly, given Tink's header: so Tink opens what sealed.ts writes", () => {
    for (const vector of manifest.vectors) {
      const sealed = sealWhole(plain(vector.plainLength), sealing(vector.segment, vector.associatedData), "vector", Buffer.from(vector.header, "hex"));
      expect([vector.segment, vector.plainLength, sealed.length, hex(sealed)]).toEqual([vector.segment, vector.plainLength, vector.sealedLength, vector.sha256]);
    }
  });

  it("are written the same by the sealing stream, fed in uneven pieces", async () => {
    for (const vector of manifest.vectors.filter((each) => each.file !== undefined)) {
      const bytes = plain(vector.plainLength);
      const pieces = [bytes.subarray(0, 7), bytes.subarray(7, 40_001), bytes.subarray(40_001)];
      const sealed = await drain(Readable.from(pieces).pipe(new SealStream(sealing(vector.segment, vector.associatedData), "vector", Buffer.from(vector.header, "hex"))));
      expect(sealed.equals(tinkFile(vector))).toBe(true);
    }
  });

  it("open in sealed.ts whole, as a stream and by range", async () => {
    const dir = folder();
    for (const vector of manifest.vectors.filter((each) => each.file !== undefined)) {
      const opening = sealing(vector.segment, vector.associatedData);
      const expected = plain(vector.plainLength);
      const path = join(dir, vector.file!);
      writeFileSync(path, tinkFile(vector));
      expect(openWhole(tinkFile(vector), opening, vector.file!).equals(expected)).toBe(true);
      expect((await drain(openFile(path, opening))).equals(expected)).toBe(true);
      const start = Math.floor(vector.plainLength / 3);
      expect((await drainRange(path, opening, start, vector.plainLength)).equals(expected.subarray(start))).toBe(true);
    }
  });

  it("do not open under the other associated data", async () => {
    const vector = manifest.vectors.find((each) => each.file !== undefined && each.associatedData === DAY)!;
    await refusedEveryWay(tinkFile(vector), sealing(SEGMENT, blobData()));
    await refusedEveryWay(tinkFile(vector), sealing(SEGMENT, fileData("day", "2026-11-15")));
    await refusedEveryWay(tinkFile(vector), sealing(SEGMENT, fileData("days", "2026-11-14")));
  });

  it("place segments where Tink's streaming format says: header 40, then the first segment short by it, a 16-byte tag last", () => {
    const sizes = new Map(manifest.vectors.filter((vector) => vector.segment === SEGMENT).map((vector) => [vector.plainLength, vector.sealedLength]));
    expect([sizes.get(0), sizes.get(1), sizes.get(65_479), sizes.get(65_480), sizes.get(65_481), sizes.get(65_480 + 2 * 65_520)])
      .toEqual([56, 57, 65_535, 65_536, 65_553, 3 * 65_536]);
    for (const vector of manifest.vectors) expect(Buffer.from(vector.header, "hex")[0]).toBe(40);
  });

  it("are the format's layout read by hand: HKDF-SHA256 over the files key, salt and associated data, and the counter nonce", () => {
    const vector = manifest.vectors.find((each) => each.file !== undefined && each.plainLength === 65_481 && each.associatedData === DAY)!;
    const sealed = tinkFile(vector);
    const key = Buffer.from(hkdfSync("sha256", KEY, sealed.subarray(1, 33), Buffer.from(DAY), 32));
    const nonce = Buffer.concat([sealed.subarray(33, 40), Buffer.from([0, 0, 0, 1, 1])]);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const body = Buffer.concat([cipher.update(plain(65_481).subarray(65_480)), cipher.final(), cipher.getAuthTag()]);
    expect(body.equals(sealed.subarray(SEGMENT))).toBe(true);
  });
});

describe("the rules a reader holds", () => {
  const three = sealWhole(plain(65_480 + 65_520 + 500), sealing(), "three");

  it("refuses a cut file: a byte short, a tag short, a whole segment short, and only its header", async () => {
    await refusedEveryWay(three.subarray(0, three.length - 1), sealing());
    await refusedEveryWay(three.subarray(0, three.length - TAG_BYTES), sealing());
    await refusedEveryWay(three.subarray(0, 2 * SEGMENT), sealing());
    await refusedEveryWay(three.subarray(0, HEADER_BYTES + TAG_BYTES - 1), sealing());
    await refusedEveryWay(Buffer.alloc(0), sealing());
  });

  it("refuses a swapped segment and a repeated one", async () => {
    const big = sealWhole(plain(65_480 + 3 * 65_520), sealing(), "four");
    const [first, second, third, last] = segmentsOf(big, SEGMENT);
    const header = big.subarray(0, HEADER_BYTES);
    await refusedEveryWay(Buffer.concat([header, first!, third!, second!, last!]), sealing());
    await refusedEveryWay(Buffer.concat([header, first!, second!, second!, last!]), sealing());
    await refusedEveryWay(Buffer.concat([header, first!, second!, third!, third!]), sealing());
  });

  it("refuses a file under another role or name", async () => {
    const day = sealWhole(plain(1000), sealing(SEGMENT, DAY), "day");
    await refusedEveryWay(day, sealing(SEGMENT, fileData("day", "2026-11-13")));
    await refusedEveryWay(day, sealing(SEGMENT, fileData("inbox-manifest", "2026-11-14")));
    await refusedEveryWay(day, sealing(SEGMENT, blobData()));
  });

  it("refuses a changed header byte: in the salt and in the nonce prefix", async () => {
    for (const at of [1, 32, 33, 39]) {
      const changed = Buffer.from(three);
      changed[at] = changed[at]! ^ 0x01;
      await refusedEveryWay(changed, sealing());
    }
  });

  it("refuses a header whose length is not 40", async () => {
    for (const length of [0, 32, 39, 41, 255]) {
      const changed = Buffer.from(three);
      changed[0] = length;
      await refusedEveryWay(changed, sealing());
    }
  });

  it("refuses bytes after the end: one, a tag's worth, and a copy of the last segment", async () => {
    const last = segmentsOf(three, SEGMENT).at(-1)!;
    await refusedEveryWay(Buffer.concat([three, Buffer.from([0])]), sealing());
    await refusedEveryWay(Buffer.concat([three, Buffer.alloc(TAG_BYTES)]), sealing());
    await refusedEveryWay(Buffer.concat([three, last]), sealing());
    const one = sealWhole(plain(65_480), sealing(), "one");
    await refusedEveryWay(Buffer.concat([one, Buffer.from([0])]), sealing());
  });

  it("refuses an empty segment after a full one, though its tag is good", async () => {
    const full = plain(65_480);
    const salt = Buffer.alloc(32, 7);
    const prefix = Buffer.alloc(7, 9);
    const key = Buffer.from(hkdfSync("sha256", KEY, salt, Buffer.from(blobData()), 32));
    const segment = (index: number, last: boolean, bytes: Buffer): Buffer => {
      const cipher = createCipheriv("aes-256-gcm", key, segmentNonce(prefix, index, last, "forged"));
      return Buffer.concat([cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
    };
    const forged = Buffer.concat([Buffer.from([40]), salt, prefix, segment(0, false, full), segment(1, true, Buffer.alloc(0))]);
    await refusedEveryWay(forged, sealing());
  });

  it("opens the empty file: the header and one last segment of only its tag", async () => {
    const empty = sealWhole(Buffer.alloc(0), sealing(), "empty");
    expect(empty.length).toBe(HEADER_BYTES + TAG_BYTES);
    expect(openWhole(empty, sealing(), "empty").length).toBe(0);
    const path = join(folder(), "empty");
    writeFileSync(path, empty);
    expect((await drain(openFile(path, sealing()))).length).toBe(0);
    expect((await drainRange(path, sealing(), 0, 0)).length).toBe(0);
  });

  it("seals one byte short of a segment, exactly one, and one over, each at its length, and opens each", () => {
    for (const segment of [SEGMENT, VECTOR_SEGMENT] as const) {
      const first = segment - HEADER_BYTES - TAG_BYTES;
      const lengths = [first - 1, first, first + 1].map((n) => sealWhole(plain(n), sealing(segment), "edge"));
      expect(lengths.map((sealed) => sealed.length)).toEqual([segment - 1, segment, segment + 1 + TAG_BYTES]);
      expect(lengths.map((sealed) => openWhole(sealed, sealing(segment), "edge").length)).toEqual([first - 1, first, first + 1]);
    }
  });

  it("hands on no plain byte of a failed segment, and names the file", async () => {
    const changed = Buffer.from(three);
    changed[SEGMENT + 100] = changed[SEGMENT + 100]! ^ 0xff;
    const path = join(folder(), "2026-11-14.day.txt.k1");
    writeFileSync(path, changed);
    const handed: Buffer[] = [];
    const error = await refusal(async () => {
      for await (const chunk of openFile(path, sealing())) handed.push(chunk as Buffer);
    });
    expect([error.code, error.file]).toEqual(["SEALED_DAMAGED", "2026-11-14.day.txt.k1"]);
    expect(Buffer.concat(handed).equals(plain(65_480))).toBe(true);
    const ranged: Buffer[] = [];
    await refusal(async () => {
      for await (const chunk of positionedRange(path, sealing(), 65_000, 66_000)) ranged.push(chunk);
    });
    expect(Buffer.concat(ranged).equals(plain(65_480).subarray(65_000))).toBe(true);
  });

  it("refuses more than 2^32 − 1 segments", () => {
    expect(MAX_SEGMENTS).toBe(2 ** 32 - 1);
    expect(segmentNonce(Buffer.alloc(7), MAX_SEGMENTS - 1, true, "huge").subarray(7)).toEqual(Buffer.from([0xff, 0xff, 0xff, 0xfe, 1]));
    expect(() => segmentNonce(Buffer.alloc(7), MAX_SEGMENTS, true, "huge")).toThrow(expect.objectContaining({ code: "SEALED_TOO_LARGE" }));
    expect(layoutOf(SEGMENT * MAX_SEGMENTS, SEGMENT, "huge").segments).toBe(MAX_SEGMENTS);
    expect(() => layoutOf(SEGMENT * MAX_SEGMENTS + 100, SEGMENT, "huge")).toThrow(expect.objectContaining({ code: "SEALED_TOO_LARGE" }));
  });

  it("refuses a files key that is not 32 bytes", () => {
    expect(() => sealWhole(plain(1), { ...sealing(), key: Buffer.alloc(16) }, "short")).toThrow(expect.objectContaining({ code: "SEALED_BAD_KEY" }));
  });
});

describe("a blob's identity, its last 32 plain bytes", () => {
  function blob(payloadLength: number): { payload: Buffer; identity: string; stored: Buffer } {
    const payload = plain(payloadLength + 3).subarray(3);
    const id = identityOf(payload);
    return { payload, identity: `sha256:${id.toString("hex")}`, stored: Buffer.concat([payload, id]) };
  }

  it("is read whole, by its tail and by range at every split across the last two segments, both sizes", async () => {
    const dir = folder();
    for (const segment of [SEGMENT, VECTOR_SEGMENT] as const) {
      const first = segment - HEADER_BYTES - TAG_BYTES;
      const later = segment - TAG_BYTES;
      for (const edge of [first, first + later]) {
        for (let inLast = 1; inLast <= 32; inLast += 1) {
          const plainLength = edge + inLast;
          const { payload, identity, stored } = blob(plainLength - 32);
          const path = join(dir, `${segment}-${edge}-${inLast}`);
          writeFileSync(path, sealWhole(stored, { ...blobSealing(KEY), segment }, "blob"));
          const opening = { ...blobSealing(KEY), segment };
          expect(layoutOf(stored.length + HEADER_BYTES + (edge === first ? 2 : 3) * TAG_BYTES, segment, "blob").plainLength).toBe(plainLength);
          const reader = SealedReader.open(path, opening);
          onTestFinished(() => reader.close());
          expect(`sha256:${reader.tail(32).toString("hex")}`).toBe(identity);
          const whole = openBlob(path, opening);
          expect((await drain(whole)).equals(payload)).toBe(true);
          expect(whole.identity).toBe(identity);
          for (const range of [{ start: 0, end: payload.length }, { start: payload.length - 1, end: payload.length }, { start: Math.min(first - 5, payload.length - 1), end: Math.min(first + 5, payload.length) }, { start: 9, end: 9 }]) {
            expect(Buffer.concat([...reader.range(range.start, range.end, payload.length)]).equals(payload.subarray(range.start, range.end))).toBe(true);
            expect((await drainRange(path, opening, range.start, range.end)).equals(payload.subarray(range.start, range.end))).toBe(true);
          }
        }
      }
    }
  });

  it("refuses a range into the identity, and a cut blob", async () => {
    const dir = folder();
    const a = blob(70_000);
    const path = join(dir, "a");
    const sealedA = sealWhole(a.stored, blobSealing(KEY), "a");
    writeFileSync(path, sealedA);
    const reader = SealedReader.open(path, blobSealing(KEY));
    onTestFinished(() => reader.close());
    expect((await refusal(() => [...reader.range(69_990, 70_001, reader.plainLength - 32)])).code).toBe("SEALED_BAD_RANGE");
    writeFileSync(path, sealedA.subarray(0, SEGMENT));
    expect((await refusal(() => drainRange(path, blobSealing(KEY), 0, 10))).code).toBe("SEALED_DAMAGED");
    expect((await refusal(() => drain(openBlob(path, blobSealing(KEY))))).code).toBe("SEALED_DAMAGED");
  });

  it("refuses a blob file that holds fewer plain bytes than an identity", async () => {
    const path = join(folder(), "short");
    writeFileSync(path, sealWhole(plain(31), blobSealing(KEY), "short"));
    expect((await refusal(() => drain(openBlob(path, blobSealing(KEY))))).code).toBe("SEALED_DAMAGED");
  });
});

describe("writing a sealed file", () => {
  it("replaces it whole, written beside its name and renamed over it, leaving nothing beside", async () => {
    const dir = folder();
    const path = join(dir, keyedName("2026-11-14.day.txt", 1));
    writeSealedSync(path, Buffer.from("old day"), sealing(SEGMENT, DAY));
    const written = await writeSealed(path, [Buffer.from("new "), Buffer.from("day")], sealing(SEGMENT, DAY));
    expect(written).toBe(HEADER_BYTES + 7 + TAG_BYTES);
    expect(readSealedSync(path, sealing(SEGMENT, DAY)).toString()).toBe("new day");
    expect(readdirSync(dir)).toEqual(["2026-11-14.day.txt.k1"]);
  });

  it("leaves the old file and nothing beside it when the plain bytes fail half way", async () => {
    const dir = folder();
    const path = join(dir, "principals.json.k1");
    writeSealedSync(path, Buffer.from("kept"), sealing(SEGMENT, fileData("principals", "principals.json")));
    async function* failing(): AsyncGenerator<Buffer> {
      yield plain(200_000);
      throw new Error("the source broke");
    }
    await expect(writeSealed(path, failing(), sealing(SEGMENT, fileData("principals", "principals.json")))).rejects.toThrow("the source broke");
    expect(readSealedSync(path, sealing(SEGMENT, fileData("principals", "principals.json"))).toString()).toBe("kept");
    expect(readdirSync(dir)).toEqual(["principals.json.k1"]);
  });

  it("writes a chunk the disk took only part of until all of it is taken, and refuses a write the disk took none of", async () => {
    const dir = folder();
    const path = join(dir, keyedName("2026-11-14.day.txt", 1));
    const probe = await open(join(dir, "probe"), "w");
    const prototype = Object.getPrototypeOf(probe) as FileHandle;
    await probe.close();
    rmSync(join(dir, "probe"));
    const write = prototype.write as unknown as (this: FileHandle, buffer: Buffer, offset: number, length: number) => Promise<{ bytesWritten: number; buffer: Buffer }>;
    let short = 0;
    const spy = vi.spyOn(prototype, "write").mockImplementation(function (this: FileHandle, buffer: Buffer, offset?: number, length?: number) {
      const from = offset ?? 0;
      const whole = length ?? buffer.length - from;
      const taken = whole > 1 ? Math.floor(whole / 2) : whole;
      if (taken < whole) short += 1;
      return write.call(this, buffer, from, taken);
    } as unknown as typeof prototype.write);
    onTestFinished(() => spy.mockRestore());
    await writeSealed(path, [plain(150_000)], sealing(SEGMENT, DAY));
    expect(short).toBeGreaterThan(0);
    expect(readSealedSync(path, sealing(SEGMENT, DAY)).equals(plain(150_000))).toBe(true);

    spy.mockImplementation((async (buffer: Buffer) => ({ bytesWritten: 0, buffer })) as unknown as typeof prototype.write);
    await expect(writeSealed(path, [plain(10)], sealing(SEGMENT, DAY))).rejects.toThrow("took none");
    spy.mockRestore();
    expect(readSealedSync(path, sealing(SEGMENT, DAY)).equals(plain(150_000))).toBe(true);
    expect(readdirSync(dir)).toEqual(["2026-11-14.day.txt.k1"]);
  });

  it("a sweep removes only a dead writer's temporary, never a live write's or a delivered name that starts alike", async () => {
    const dir = folder();
    const path = join(dir, keyedName("2026-11-14.day.txt", 1));
    const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
    const left = join(dir, `.tmp-${dead}-0a1b2c3d4e5f0a1b2c3d4e5f`);
    const leftFolder = join(dir, `.tmp-${dead}-3d4e5f3d4e5f3d4e5f3d4e5f`);
    const delivered = [".tmp-export", `.tmp-${dead}-0a1b2c`, `.tmp-${dead}-0a1b2c3d4e5f0a1b2c3d4e5f.json`];
    for (const name of delivered) mkdirSync(join(dir, name, "member"), { recursive: true });
    let live: string[] = [];
    async function* watched(): AsyncGenerator<Buffer> {
      yield plain(100_000);
      writeFileSync(left, "a crashed write");
      mkdirSync(join(leftFolder, "deep"), { recursive: true });
      live = readdirSync(dir).filter((name) => name.startsWith(`.tmp-${process.pid}-`));
      sweepTemporaries(dir);
      yield plain(100_000);
    }
    await writeSealed(path, watched(), sealing(SEGMENT, DAY));
    expect(live).toHaveLength(1);
    expect([existsSync(left), existsSync(leftFolder)]).toEqual([false, false]);
    expect(readdirSync(dir).sort()).toEqual([...delivered, "2026-11-14.day.txt.k1"].sort());
    expect(delivered.map(isTemporary)).toEqual([false, false, false]);
    expect(isTemporary(basename(temporaryIn(dir)))).toBe(true);
    expect(readSealedSync(path, sealing(SEGMENT, DAY)).length).toBe(200_000);
    expect(temporaryIn(dir).startsWith(join(dir, `.tmp-${process.pid}-`))).toBe(true);
    sweepTemporaries(join(dir, "not-made"));
  });

  it("names a keyed file by its plain name and key id, and a blob tree by its key", () => {
    expect(keyedName("2026-11-14.day.txt", 1)).toBe("2026-11-14.day.txt.k1");
    expect(nameKey("2026-11-14.day.txt.k12")).toEqual({ plainName: "2026-11-14.day.txt", keyId: 12 });
    expect([nameKey("2026-11-14.day.txt"), nameKey("x.k0"), nameKey(".k1")]).toEqual([undefined, undefined, undefined]);
    expect(() => keyedName("x", 0)).toThrow();
    expect(blobTree("/home/blobs", 2)).toBe(join("/home/blobs", "k2"));
    expect([blobData(), DAY, fileData("principals", "principals.json")]).toEqual(["lifestream:1:blob", "lifestream:1:day:2026-11-14", "lifestream:1:principals:principals.json"]);
    expect(() => fileData("blob", "x")).toThrow();
    expect(() => fileData("a:b", "x")).toThrow();
  });
});

describe("the synchronous reader", () => {
  it("opens a file of another role, or reads its head, tail or a range otherwise than the whole", () => {
    const dir = folder();
    for (const [name, associatedData] of [["2026-11-14.day.txt.k1", DAY], ["blob.k1", blobData()]] as const) {
      const path = join(dir, name);
      const bytes = plain(3 * SEGMENT + 77);
      writeSealedSync(path, bytes, sealing(SEGMENT, associatedData));
      const reader = SealedReader.open(path, sealing(SEGMENT, associatedData));
      try {
        expect(reader.plainLength).toBe(bytes.length);
        expect(reader.head(SEGMENT + 5).equals(bytes.subarray(0, SEGMENT + 5))).toBe(true);
        expect(reader.tail(SEGMENT + 9).equals(bytes.subarray(bytes.length - SEGMENT - 9))).toBe(true);
        expect(Buffer.concat([...reader.range(SEGMENT - 3, 2 * SEGMENT + 4)]).equals(bytes.subarray(SEGMENT - 3, 2 * SEGMENT + 4))).toBe(true);
        expect(() => [...reader.range(5, bytes.length + 1)]).toThrow(SealedError);
      } finally {
        reader.close();
      }
    }
    const wrong = SealedReader.open(join(dir, "2026-11-14.day.txt.k1"), sealing(SEGMENT, blobData()));
    try {
      expect(() => wrong.segment(0)).toThrow(SealedError);
    } finally {
      wrong.close();
    }
  });
});

describe("memory", () => {
  const SEGMENTS = 200;
  const BOUND = 4 * SEGMENT;

  async function* counted(total: number, chunk: number, pulled: { bytes: number }): AsyncGenerator<Buffer> {
    const piece = plain(chunk);
    for (let at = 0; at < total; at += chunk) {
      pulled.bytes += Math.min(chunk, total - at);
      yield piece.subarray(0, Math.min(chunk, total - at));
    }
  }

  function measuring(pulled: { bytes: number }, seen: { bytes: number; most: number }): (source: AsyncIterable<Buffer>) => Promise<void> {
    return async (source) => {
      for await (const chunk of source) {
        seen.bytes += chunk.length;
        seen.most = Math.max(seen.most, pulled.bytes - seen.bytes);
      }
    };
  }

  it("seals a file of many segments holding no more than a few segments", async () => {
    const total = SEGMENTS * (SEGMENT - TAG_BYTES) - HEADER_BYTES;
    const pulled = { bytes: 0 };
    const seen = { bytes: 0, most: 0 };
    await pipeline(counted(total, 10_000, pulled), new SealStream(sealing(), "big"), measuring(pulled, seen));
    expect(pulled.bytes).toBe(total);
    expect(seen.bytes).toBe(total + HEADER_BYTES + SEGMENTS * TAG_BYTES);
    expect(seen.most).toBeLessThan(BOUND);
  });

  it("opens a file of many segments holding no more than a few segments", async () => {
    const dir = folder();
    const path = join(dir, "big");
    const total = SEGMENTS * (SEGMENT - TAG_BYTES) - HEADER_BYTES;
    await writeSealed(path, counted(total, 50_000, { bytes: 0 }), sealing());
    const size = total + HEADER_BYTES + SEGMENTS * TAG_BYTES;
    const sealedPulled = { bytes: 0 };
    async function* sealedChunks(): AsyncGenerator<Buffer> {
      for await (const chunk of Readable.from(readFileChunks(path))) {
        sealedPulled.bytes += (chunk as Buffer).length;
        yield chunk as Buffer;
      }
    }
    const seen = { bytes: 0, most: 0 };
    await pipeline(sealedChunks(), new OpenStream(sealing(), "big"), measuring(sealedPulled, seen));
    expect([sealedPulled.bytes, seen.bytes]).toEqual([size, total]);
    expect(seen.most).toBeLessThan(BOUND);
    const whole = await drain(openFile(path, sealing()));
    expect(whole.length).toBe(total);
  });
});

function* readFileChunks(path: string): Generator<Buffer> {
  const bytes = readFileSync(path);
  for (let at = 0; at < bytes.length; at += 30_000) yield bytes.subarray(at, at + 30_000);
}
