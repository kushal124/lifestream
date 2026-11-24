import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { brotliCompressSync, constants, createZstdCompress, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { describe, expect, it, onTestFinished } from "vitest";
import { BlobError, diskFailed, homeBlobFault, hostFault, type BlobStore } from "./blobs.js";
import { openHomeFolder } from "./home-folder.js";
import { BOTTOM_BYTES } from "./disk.js";
import { sha256File, temp, writeLargeText } from "./test/large.js";
import { wholeReads } from "./test/whole-reads.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const FIXTURE = join(HERE, "test", "today-blobs");
const GOLDEN = join(HERE, "test", "today-blobs.golden.json");
const MiB = 1024 * 1024;

function sha(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function shard(root: string, hash: string): string {
  const hex = hash.slice("sha256:".length);
  return join(root, hex.slice(0, 2), hex.slice(2, 4), hex);
}

function trailer(hash: string): Buffer {
  const bytes = Buffer.alloc(40);
  bytes.writeUInt32LE(0x184d2a5c, 0);
  bytes.writeUInt32LE(32, 4);
  Buffer.from(hash.slice("sha256:".length), "hex").copy(bytes, 8);
  return bytes;
}

function isCompressedFile(path: string, hash: string): boolean {
  const stored = readFileSync(path);
  return stored.length > 40 && stored.subarray(stored.length - 40).equals(trailer(hash));
}

async function writePreviousStreamed(root: string, chunks: Iterable<Buffer>): Promise<string> {
  const digest = createHash("sha256");
  const parts: Buffer[] = [];
  const compressor = createZstdCompress({ params: { [constants.ZSTD_c_compressionLevel]: 3 } });
  compressor.on("data", (part: Buffer) => parts.push(part));
  const done = new Promise((resolve) => compressor.on("end", resolve));
  for (const chunk of chunks) {
    digest.update(chunk);
    compressor.write(chunk);
  }
  compressor.end();
  await done;
  const hash = `sha256:${digest.digest("hex")}`;
  const path = shard(root, hash);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat([...parts, trailer(hash)]));
  return hash;
}

async function verified(store: BlobStore, hash: string): Promise<boolean> {
  try {
    for await (const _chunk of store.stream(hash)) {
    }
    return true;
  } catch (error) {
    if (error instanceof BlobError && error.code === "BLOB_CORRUPT") return false;
    throw error;
  }
}

async function sizeOf(store: BlobStore, hash: string): Promise<number> {
  let size = 0;
  for await (const chunk of store.stream(hash)) size += (chunk as Buffer).length;
  return size;
}

async function list(store: BlobStore, hashes: string[]): Promise<{ hash: string; path: string; compressed: boolean; size: number }[]> {
  const out = [];
  for (const hash of hashes) {
    out.push({
      hash,
      path: relative(store.root, shard(store.root, hash)),
      compressed: isCompressedFile(shard(store.root, hash), hash),
      size: await sizeOf(store, hash),
    });
  }
  return out;
}

function artifact(dir: string, value: unknown): void {
  writeFileSync(join(dir, "blobs.json"), JSON.stringify(value, null, 2) + "\n");
}

function code(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof BlobError) return error.code;
    throw error;
  }
  return undefined;
}

async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    if (error instanceof BlobError) return error.code;
    throw error;
  }
  return undefined;
}

function childScript(dir: string, body: string): string {
  const path = join(dir, "child.mts");
  writeFileSync(path, `import { openHomeFolder } from ${JSON.stringify(pathToFileURL(join(HERE, "home-folder.ts")).href)};\n${body}\n`);
  return path;
}

describe("the blob store: each of these is impossible", () => {
  it("a blob is stored under a hash that is not the SHA-256 of its bytes", async () => {
    const dir = temp();
    const store = openHomeFolder(dir).blobs(join(dir, "blobs"));
    const json = Buffer.from(JSON.stringify({ from: "person-a@example.com", text: "fake" }));
    const photo = Buffer.from("fake jpeg bytes from iphone-aa01");
    const big = join(dir, "snapshot.sqlite");
    writeLargeText(big, 4 * MiB);
    const small = join(dir, "export.csv");
    writeFileSync(small, "date,amount\n2026-09-03,12.50\n");

    const hashes = [
      store.put(json, { mediaType: "application/json" }),
      store.put(photo),
      await store.putFile(big, { mediaType: "application/vnd.sqlite3" }),
      await store.putFile(small, { mediaType: "text/csv" }),
    ];
    expect(hashes).toEqual([sha(json), sha(photo), sha256File(big), sha256File(small)]);
    for (const hash of hashes) {
      expect(existsSync(shard(store.root, hash))).toBe(true);
      expect(await verified(store, hash)).toBe(true);
    }
    expect(store.bytes(hashes[0]!)).toEqual(json);
    expect(store.bytes(hashes[1]!)).toEqual(photo);
    expect(store.text(hashes[3]!)).toBe("date,amount\n2026-09-03,12.50\n");
    const listed = await list(store, hashes);

    const wrong = sha(Buffer.from("other bytes"));
    expect(code(() => store.put(photo, { expect: wrong }))).toBe("BLOB_HASH_MISMATCH");
    expect(await codeOf(() => store.putFile(big, { mediaType: "application/vnd.sqlite3", expect: wrong }))).toBe("BLOB_HASH_MISMATCH");
    expect(store.has(wrong)).toBe(false);
    expect(readdirSync(store.root).filter((name) => name.startsWith("."))).toEqual([]);

    const tampered = store.put(Buffer.from("fake voice note bytes"), { mediaType: "audio/m4a" });
    chmodSync(shard(store.root, tampered), 0o644);
    writeFileSync(shard(store.root, tampered), "fake voice note byteZ");
    expect(code(() => store.bytes(tampered))).toBe("BLOB_CORRUPT");
    expect(await verified(store, tampered)).toBe(false);
    const truncated = store.put(json, { mediaType: "application/json" });
    const stored = readFileSync(shard(store.root, truncated));
    chmodSync(shard(store.root, truncated), 0o644);
    writeFileSync(shard(store.root, truncated), Buffer.concat([stored.subarray(0, 6), stored.subarray(stored.length - 40)]));
    expect(code(() => store.bytes(truncated))).toBe("BLOB_CORRUPT");
    expect(await verified(store, truncated)).toBe(false);

    expect(code(() => store.has("sha256:ABC"))).toBe("BAD_BLOB_HASH");
    expect(code(() => store.bytes(sha(Buffer.from("never stored"))))).toBe("BLOB_NOT_FOUND");
    artifact(dir, listed);
  });

  it("a compressed blob is named by the hash of its compressed bytes", async () => {
    const dir = temp();
    const store = openHomeFolder(dir).blobs(join(dir, "blobs"));
    const json = Buffer.from(JSON.stringify({ rows: Array.from({ length: 500 }, (_, i) => ({ i, to: "+15550000001" })) }));
    const large = join(dir, "chat.ndjson");
    writeLargeText(large, 4 * MiB);
    const small = join(dir, "message.eml");
    writeLargeText(small, 64 * 1024);
    const hashes = [
      store.put(json, { mediaType: "application/json; charset=utf-8" }),
      await store.putFile(large, { mediaType: "application/x-ndjson" }),
      await store.putFile(small, { mediaType: "message/rfc822" }),
    ];
    for (const [hash, raw] of [[hashes[0]!, json], [hashes[1]!, readFileSync(large)], [hashes[2]!, readFileSync(small)]] as const) {
      const path = shard(store.root, hash);
      const stored = readFileSync(path);
      expect(isCompressedFile(path, hash)).toBe(true);
      expect(stored.length).toBeLessThan(raw.length);
      expect(sha(stored)).not.toBe(hash);
      expect(sha(raw)).toBe(hash);
      expect(zstdDecompressSync(stored.subarray(0, stored.length - 40)).equals(raw)).toBe(true);
      expect(await sizeOf(store, hash)).toBe(raw.length);
      const streamed: Buffer[] = [];
      for await (const chunk of store.stream(hash)) streamed.push(chunk as Buffer);
      expect(sha(Buffer.concat(streamed))).toBe(hash);
      const opened = await store.materialise(hash);
      expect(opened.path).not.toBe(path);
      expect(sha256File(opened.path)).toBe(hash);
      opened.dispose();
      expect(existsSync(opened.path)).toBe(false);
    }
    const photo = store.put(Buffer.from("fake heic bytes ".repeat(100)), { mediaType: "image/heic" });
    expect(isCompressedFile(shard(store.root, photo), photo)).toBe(false);
    const linked = await store.materialise(photo);
    expect(linked.path).not.toBe(shard(store.root, photo));
    expect(statSync(linked.path).ino).toBe(statSync(shard(store.root, photo)).ino);
    linked.dispose();
    expect(existsSync(linked.path)).toBe(false);
    expect(store.bytes(photo).length).toBe(1600);
    expect(statSync(shard(store.root, photo)).mode & 0o222).toBe(0);
    const text = store.put(brotliCompressSync(Buffer.from("synthetic screen text\n".repeat(200))), { mediaType: "application/vnd.lifestreamprotocol.screen-text" });
    expect(isCompressedFile(shard(store.root, text), text)).toBe(false);
    artifact(dir, await list(store, [...hashes, photo, text]));
  });

  it("a file stored raw written a second time, a compressed one taken by its name, or a refused one left changed", async () => {
    const dir = temp();
    const store = openHomeFolder(dir).blobs(join(dir, "blobs"));
    const video = Buffer.alloc(3 * MiB + 17);
    for (let at = 0; at + 4 <= video.length; at += 4) video.writeUInt32LE((at * 2654435761) >>> 0, at);
    const clip = join(dir, "clip.mov");
    writeFileSync(clip, video);
    const before = statSync(clip);
    const hash = await store.putFile(clip, { mediaType: "video/quicktime", expect: sha(video) });
    expect(hash).toBe(sha(video));
    const linked = { caller: statSync(clip), store: statSync(shard(store.root, hash)) };
    expect([linked.caller.ino, linked.caller.nlink, linked.store.ino, linked.store.nlink]).toEqual([before.ino, 2, before.ino, 2]);
    expect(linked.caller.mode & 0o222).toBe(0);
    expect(readdirSync(store.root).filter((name) => name.startsWith("."))).toEqual([]);
    expect(isCompressedFile(shard(store.root, hash), hash)).toBe(false);
    rmSync(clip);
    expect(statSync(shard(store.root, hash)).nlink).toBe(1);
    expect(await verified(store, hash)).toBe(true);

    const lines = join(dir, "rows.ndjson");
    writeLargeText(lines, 2 * MiB);
    const plain = statSync(lines);
    const compressed = await store.putFile(lines, { mediaType: "application/x-ndjson" });
    const copied = { caller: statSync(lines), store: statSync(shard(store.root, compressed)) };
    expect([copied.caller.ino, copied.caller.nlink, copied.caller.mode, copied.store.nlink]).toEqual([plain.ino, 1, plain.mode, 1]);
    expect(copied.store.ino).not.toBe(plain.ino);
    expect(isCompressedFile(shard(store.root, compressed), compressed)).toBe(true);

    const other = join(dir, "other.mov");
    writeFileSync(other, "synthetic video whose bytes are not the name expected");
    const otherBefore = statSync(other);
    expect(await codeOf(() => store.putFile(other, { mediaType: "video/quicktime", expect: sha(Buffer.from("another video")) }))).toBe("BLOB_HASH_MISMATCH");
    const refused = statSync(other);
    expect([refused.nlink, refused.mode]).toEqual([1, otherBefore.mode]);
    expect(store.has(sha(readFileSync(other)))).toBe(false);
    expect(await codeOf(() => store.putFile(join(dir, "never-delivered.mov"), { mediaType: "video/quicktime" }))).toBe("BLOB_NOT_STORED");
    expect(readdirSync(store.root).filter((name) => name.startsWith("."))).toEqual([]);
    artifact(dir, {
      raw: { hash, inode: before.ino, nlink_stored: linked.store.nlink, nlink_after_caller_removed: 1, caller_mode: (linked.caller.mode & 0o777).toString(8) },
      compressed: { hash: compressed, caller_inode: plain.ino, store_inode: copied.store.ino },
      listed: await list(store, [hash, compressed]),
    });
  });

  it("putting a blob that exists rewrites it, or a second spelling replaces the first", async () => {
    const dir = temp();
    const store = openHomeFolder(dir).blobs(join(dir, "blobs"));
    const json = Buffer.from('{"fake":true,"pad":"' + "y".repeat(200) + '"}');
    const hash = store.put(json, { mediaType: "application/json" });
    const before = statSync(shard(store.root, hash));
    const file = join(dir, "same.bin");
    writeFileSync(file, json);
    expect(store.put(json)).toBe(hash);
    expect(await store.putFile(file)).toBe(hash);
    const after = statSync(shard(store.root, hash));
    expect([after.ino, after.mtimeMs, after.size]).toEqual([before.ino, before.mtimeMs, before.size]);
    expect(isCompressedFile(shard(store.root, hash), hash)).toBe(true);
    expect(store.remove(hash)).toBe(true);
    expect(store.has(hash)).toBe(false);
    expect(store.remove(hash)).toBe(false);
    artifact(dir, { hash, inode: before.ino, removed: true });
  });

  it("a crash mid-put leaves a partial file that reads as the blob", async () => {
    const dir = temp();
    const root = join(dir, "blobs");
    const large = join(dir, "snapshot.sqlite");
    writeLargeText(large, 16 * MiB);
    const expected = sha256File(large);
    const script = childScript(dir, `
      import { existsSync, readdirSync, statSync } from "node:fs";
      const root = ${JSON.stringify(root)};
      const put = openHomeFolder(${JSON.stringify(dir)}).blobs(root).putFile(${JSON.stringify(large)}, { mediaType: "application/vnd.sqlite3" });
      const crash = () => {
        const partial = existsSync(root) && readdirSync(root).some((name) => name.startsWith(".tmp-") && statSync(root + "/" + name).size > 0);
        if (partial) process.kill(process.pid, "SIGKILL");
        else setImmediate(crash);
      };
      crash();
      await put;
    `);
    const child = spawn(process.execPath, ["--import", "tsx", script], { cwd: ROOT, stdio: "ignore" });
    const [, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
    expect(signal).toBe("SIGKILL");
    const partial = readdirSync(root).find((name) => name.startsWith(".tmp-") && statSync(join(root, name)).size > 0);
    expect(partial).toBeDefined();

    const store = openHomeFolder(dirname(root)).blobs(root);
    expect(store.has(expected)).toBe(false);
    expect(existsSync(shard(root, expected))).toBe(false);
    expect(readdirSync(root).filter((name) => name.startsWith("."))).toEqual([]);
    expect(await store.putFile(large, { mediaType: "application/vnd.sqlite3" })).toBe(expected);
    expect(await verified(store, expected)).toBe(true);
    artifact(dir, { partial, ...(await list(store, [expected]))[0] });
  });

  it("putFile, materialise or a stream reads a large blob whole into one Buffer", () => {
    const dir = temp();
    const root = join(dir, "blobs");
    const large = join(dir, "large.sqlite");
    writeLargeText(large, 16 * MiB);
    const script = childScript(dir, `
      ${wholeReads([large, root])}
      const store = openHomeFolder(${JSON.stringify(dirname(root))}).blobs(${JSON.stringify(root)});
      const hash = await store.putFile(${JSON.stringify(large)}, { mediaType: "application/vnd.sqlite3" });
      const opened = await store.materialise(hash);
      opened.dispose();
      for await (const _chunk of store.stream(hash)) {
        // Read to its end: the stream checks the bytes against the name there.
      }
      console.log(JSON.stringify({ hash, largest: whole.largest() }));
    `);
    const result = spawnSync(process.execPath, ["--import", "tsx", script], { cwd: ROOT, encoding: "utf8" });
    expect(result.stderr).toBe("");
    const measured = JSON.parse(result.stdout) as { hash: string; largest: number };
    expect(measured.hash).toBe(sha256File(large));
    expect(measured.largest).toBeLessThanOrEqual(2 * MiB);
    artifact(dir, { ...measured, largest_mib: measured.largest / MiB, blob_mib: 16 });
  });

  it("a prefix reads past the bytes asked, or reads a compressed blob's frame as its bytes", () => {
    const dir = temp();
    const store = openHomeFolder(dir).blobs(join(dir, "blobs"));
    const image = Buffer.alloc(4 * MiB);
    for (let at = 0; at < image.length; at += 4) image.writeUInt32LE((at * 2654435761) >>> 0, at);
    const asked = 256 * 1024;
    const photo = store.put(image, { mediaType: "image/jpeg" });
    expect(store.prefix(photo, asked).equals(image.subarray(0, asked))).toBe(true);
    expect(store.prefix(photo, 0).length).toBe(0);
    expect(store.prefix(photo, 8 * MiB).equals(image)).toBe(true);
    const path = shard(store.root, photo);
    chmodSync(path, 0o644);
    truncateSync(path, asked);
    expect(store.prefix(photo, asked).equals(image.subarray(0, asked))).toBe(true);
    expect(code(() => store.bytes(photo))).toBe("BLOB_CORRUPT");
    const text = Buffer.from(Array.from({ length: 20_000 }, (_, n) => `{"n":${n},"from":"macbook-pro-0001","h":"${createHash("sha256").update(String(n)).digest("hex")}"}\n`).join(""));
    const json = store.put(text, { mediaType: "application/x-ndjson" });
    expect(isCompressedFile(shard(store.root, json), json)).toBe(true);
    expect(store.prefix(json, 100)).toEqual(text.subarray(0, 100));
    const jsonPath = shard(store.root, json);
    const frame = readFileSync(jsonPath);
    chmodSync(jsonPath, 0o644);
    frame.fill(0xff, frame.length - 40 - 64, frame.length - 40);
    writeFileSync(jsonPath, frame);
    expect(frame.length).toBeGreaterThan(4 * 4096);
    expect(store.prefix(json, 100)).toEqual(text.subarray(0, 100));
    expect(code(() => store.bytes(json))).toBe("BLOB_CORRUPT");
    expect(code(() => store.prefix(sha(Buffer.from("never stored")), 10))).toBe("BLOB_NOT_FOUND");
    expect(() => store.prefix(json, -1)).toThrow(RangeError);
    artifact(dir, { photo, stored_after_cut: statSync(path).size, asked, json, json_bytes: text.length });
  });

  it("materialise fills the disk, or takes a store its disk will not write in for its content's fault", async () => {
    const dir = temp();
    const root = join(dir, "blobs");
    const lines = Array.from({ length: 64 }, (_, i) => Buffer.from(`{"i":${i},"pad":"${"z".repeat(256 * 1024)}"}\n`));
    const raw = Buffer.concat(lines);
    const before = process.env.LIFESTREAM_TEST_FREE!;
    onTestFinished(() => { process.env.LIFESTREAM_TEST_FREE = before; });
    process.env.LIFESTREAM_TEST_FREE = String(BOTTOM_BYTES + raw.length / 2);

    const store = openHomeFolder(dirname(root)).blobs(root);
    const stated = store.put(raw, { mediaType: "application/x-ndjson" });
    expect(await codeOf(() => store.materialise(stated))).toBe("BLOB_NO_SPACE");
    expect(readdirSync(root).filter((name) => name.startsWith("."))).toEqual([]);

    const unstated = await writePreviousStreamed(join(dir, "today"), lines);
    expect(unstated).toBe(stated);
    rmSync(shard(root, stated));
    cpSync(shard(join(dir, "today"), unstated), shard(root, unstated));
    expect(await codeOf(() => store.materialise(unstated))).toBe("BLOB_NO_SPACE");
    expect(readdirSync(root).filter((name) => name.startsWith("."))).toEqual([]);

    process.env.LIFESTREAM_TEST_FREE = String(BOTTOM_BYTES + raw.length);
    const opened = await store.materialise(unstated);
    expect(sha256File(opened.path)).toBe(unstated);
    opened.dispose();
    expect(readdirSync(root).filter((name) => name.startsWith("."))).toEqual([]);

    chmodSync(root, 0o555);
    try {
      expect(store.bytes(unstated).length).toBe(raw.length);
      expect(await codeOf(() => store.materialise(unstated))).toBe("BLOB_NOT_STORED");
    } finally {
      chmodSync(root, 0o755);
    }
    artifact(dir, await list(store, [unstated]));
  });

  it("a put, a streamed blob or a compressed file is written past the disk's 1 GB bottom, or a link that takes no room is refused", async () => {
    const dir = temp();
    const store = openHomeFolder(dir).blobs(join(dir, "blobs"));
    const bytes = Buffer.from(createHash("sha512").update("one").digest("hex").repeat(64));
    const noise = Buffer.from(Array.from({ length: 4 }, (_, i) => createHash("sha512").update(String(i)).digest("hex")).join(""));
    const file = (name: string, body: Buffer) => {
      const path = join(dir, name);
      writeFileSync(path, body);
      return path;
    };
    const before = process.env.LIFESTREAM_TEST_FREE!;
    onTestFinished(() => { process.env.LIFESTREAM_TEST_FREE = before; });
    process.env.LIFESTREAM_TEST_FREE = String(BOTTOM_BYTES + 100);

    const refused = {
      put: code(() => store.put(bytes)),
      chunks: await codeOf(() => store.putChunks(async function* () { yield noise; yield noise; }, 2 * noise.length)),
      compressed: await codeOf(() => store.putFile(file("notes.txt", noise), { mediaType: "text/plain" })),
    };
    expect(refused).toEqual({ put: "BLOB_NO_SPACE", chunks: "BLOB_NO_SPACE", compressed: "BLOB_NO_SPACE" });
    expect([store.has(sha(bytes)), store.has(sha(noise)), readdirSync(store.root)]).toEqual([false, false, []]);
    const linked = await store.putFile(file("photo.jpg", bytes), { mediaType: "image/jpeg" });
    expect(linked).toBe(sha(bytes));

    process.env.LIFESTREAM_TEST_FREE = String(BOTTOM_BYTES + MiB);
    const kept = [store.put(noise), await store.putChunks(async function* () { yield bytes; }, bytes.length, { mediaType: "application/json" }), await store.putFile(file("more.txt", Buffer.concat([noise, bytes])), { mediaType: "text/plain" })];
    expect(kept.map((hash) => store.has(hash))).toEqual([true, true, true]);
    artifact(dir, { refused, kept: await list(store, [linked, ...kept]) });
  });

  it("a blob whose bytes no longer hash to its name reaches a streamed reader whole", async () => {
    const dir = temp();
    const store = openHomeFolder(dir).blobs(join(dir, "blobs"));
    const taken = async (hash: string): Promise<{ bytes: number; ended: string }> => {
      let bytes = 0;
      try {
        for await (const chunk of store.stream(hash)) bytes += (chunk as Buffer).length;
        return { bytes, ended: "whole" };
      } catch (error) {
        return { bytes, ended: error instanceof BlobError ? error.code : String(error) };
      }
    };
    const damage = (hash: string, body: Buffer): void => {
      const path = shard(store.root, hash);
      chmodSync(path, 0o644);
      writeFileSync(path, body);
    };
    const several = Buffer.alloc(3 * MiB + 100, "synthetic photo bytes ");
    const one = Buffer.from("fake voice note bytes ".repeat(100));
    const json = Buffer.from(JSON.stringify({ rows: Array.from({ length: 50_000 }, (_, i) => ({ i, to: "+15550000001" })) }));
    const [big, small, text] = [store.put(several), store.put(one), store.put(json, { mediaType: "application/json" })];
    const flipped = (bytes: Buffer): Buffer => {
      const copy = Buffer.from(bytes);
      copy[copy.length >> 1] = copy[copy.length >> 1]! ^ 0xff;
      return copy;
    };
    damage(big, flipped(several));
    damage(small, flipped(one));
    const other = Buffer.from(json.toString().replace("+15550000001", "+15550000002"));
    damage(text, Buffer.concat([zstdCompressSync(other), trailer(text)]));
    const read = { big: await taken(big), small: await taken(small), text: await taken(text) };
    expect(read).toEqual({
      big: { bytes: 3 * MiB, ended: "BLOB_CORRUPT" },
      small: { bytes: 0, ended: "BLOB_CORRUPT" },
      text: { bytes: expect.any(Number), ended: "BLOB_CORRUPT" },
    });
    expect(read.text.bytes).toBeLessThan(json.length);
    expect(await taken(store.put(Buffer.alloc(0)))).toEqual({ bytes: 0, ended: "whole" });
    artifact(dir, read);
  });

  it("a blob written from chunks states no size, or chunks of another length than stated are stored", async () => {
    const dir = temp();
    const store = openHomeFolder(dir).blobs(join(dir, "blobs"));
    const json = Buffer.from(JSON.stringify({ rows: Array.from({ length: 80_000 }, (_, i) => ({ i, from: "person-a@example.com" })) }));
    const halves = (bytes: Buffer) => async function* () { yield bytes.subarray(0, bytes.length >> 1); yield bytes.subarray(bytes.length >> 1); };
    const zstd = openHomeFolder(dir).blobs(join(dir, "zstd"));
    const raw = await store.putChunks(halves(json), json.length);
    expect(store.size(raw)).toBe(json.length);
    const compressed = await zstd.putChunks(halves(json), json.length, { mediaType: "application/json" });
    expect(isCompressedFile(shard(zstd.root, compressed), compressed)).toBe(true);
    expect(zstd.size(compressed)).toBe(json.length);
    const wrong = openHomeFolder(dir).blobs(join(dir, "wrong"));
    const other = Buffer.from(json.toString().replace("person-a@example.com", "person-b@example.com"));
    const refused: Record<string, string | undefined> = {};
    for (const mediaType of [undefined, "application/json"]) {
      for (const size of [other.length - 1, other.length + 1]) {
        refused[`${mediaType ?? "raw"} ${size - other.length}`] = await codeOf(() => wrong.putChunks(halves(other), size, mediaType === undefined ? {} : { mediaType }));
      }
    }
    expect(refused).toEqual({ "raw -1": "BLOB_CORRUPT", "raw 1": "BLOB_CORRUPT", "application/json -1": "BLOB_CORRUPT", "application/json 1": "BLOB_CORRUPT" });
    expect(homeBlobFault(new BlobError("BLOB_CORRUPT", "a wrong size"))).toBe(true);
    expect(readdirSync(wrong.root)).toEqual([]);
    artifact(dir, { raw: store.size(raw), compressed: zstd.size(compressed), refused });
  });

  it("stored or a leaf says another length than the file's on disk, lists a file of another leaf or a stray name, or a leaf not made yet throws", () => {
    const dir = temp();
    const store = openHomeFolder(dir).blobs(join(dir, "blobs"));
    const raw = store.put(Buffer.from("raw synthetic bytes"), { mediaType: "image/jpeg" });
    const text = store.put(Buffer.from("synthetic text ".repeat(400)), { mediaType: "text/plain" });
    const leaf = raw.slice(7, 11);
    writeFileSync(join(store.root, leaf.slice(0, 2), leaf.slice(2, 4), "stray"), "x");
    const foreign = `${leaf.slice(0, 3)}${leaf[3] === "0" ? "1" : "0"}${"0".repeat(60)}`;
    writeFileSync(join(store.root, leaf.slice(0, 2), leaf.slice(2, 4), foreign), "y");
    for (const hash of [raw, text]) {
      const stat = statSync(shard(store.root, hash));
      expect(store.stored(hash)).toBe(stat.size);
      const listed = store.leaf(hash.slice(7, 11));
      expect(listed).toContainEqual({ blob: hash, bytes: stat.size, mtime_ms: Math.floor(stat.mtimeMs) });
      expect(listed.every((file) => file.blob.startsWith(`sha256:${hash.slice(7, 11)}`))).toBe(true);
    }
    expect(store.stored(text)).toBeLessThan(store.size(text)!);
    const unmade = ["0000", "0001", "0002"].find((each) => each !== leaf && each !== text.slice(7, 11))!;
    expect(store.leaf(unmade)).toEqual([]);
    expect(store.stored(`sha256:${unmade}${"0".repeat(60)}`)).toBeUndefined();
    expect(() => store.leaf("ABCD")).toThrow(RangeError);
    expect(() => store.leaf("abc")).toThrow(RangeError);
    artifact(dir, { raw: store.leaf(leaf), text: store.leaf(text.slice(7, 11)) });
  });

  it("has says a blob is not stored when its disk fails to say", () => {
    const dir = temp();
    const store = openHomeFolder(dir).blobs(join(dir, "blobs"));
    expect(store.has(sha(Buffer.from("never stored")))).toBe(false);
    const looped = `sha256:${"ab".repeat(32)}`;
    symlinkSync("ab", join(store.root, "ab"));
    let thrown: unknown;
    try {
      store.has(looped);
    } catch (error) {
      thrown = error;
    } finally {
      rmSync(join(store.root, "ab"));
    }
    expect([thrown instanceof BlobError, (thrown as BlobError).code, ((thrown as Error).cause as NodeJS.ErrnoException).code, homeBlobFault(thrown), diskFailed(thrown)])
      .toEqual([true, "BLOB_NOT_STORED", "ELOOP", true, false]);
    expect(["EIO", "ENXIO", "EBADF", "SQLITE_IOERR_READ", "SQLITE_CANTOPEN", "ENOENT", "ENOSPC", "BLOB_CORRUPT"].filter((code) => diskFailed({ code })))
      .toEqual(["EIO", "ENXIO", "EBADF", "SQLITE_IOERR_READ", "SQLITE_CANTOPEN"]);
    expect(diskFailed(new BlobError("BLOB_NOT_STORED", "has", { cause: Object.assign(new Error("EIO"), { code: "EIO" }) }))).toBe(true);
  });

  it("the machine's faults are never the content's: hostFault holds diskFailed and the system's own, on the error or a cause under it", () => {
    const codes = ["EIO", "SQLITE_IOERR_READ", "EMFILE", "ENFILE", "ENOMEM", "EACCES", "EPERM", "ETIMEDOUT", "SQLITE_NOMEM"];
    const caused = (code: string) => new Error("outer", { cause: { code } });
    const deep = (code: string) => new Error("outer", { cause: new Error("middle", { cause: { code } }) });
    expect(codes.filter((code) => hostFault({ code }) && hostFault(caused(code)) && hostFault(deep(code)))).toEqual(codes);
    expect(["ENOENT", "SQLITE_CORRUPT", "SQLITE_NOTADB", "ENOSPC", "BLOB_CORRUPT", "SQLITE_NOMEM_X"].filter((code) => hostFault({ code }) || hostFault(deep(code)))).toEqual([]);
    expect([hostFault(undefined), hostFault(null), hostFault("EMFILE")]).toEqual([false, false, false]);
    expect(["EMFILE", "ENFILE", "ENOMEM", "EACCES", "EPERM", "ETIMEDOUT", "SQLITE_NOMEM"].filter((code) => diskFailed({ code }) || diskFailed(deep(code)))).toEqual([]);
  });

  it("a blob in today's layout is not readable", async () => {
    const dir = temp();
    const root = join(dir, "blobs");
    cpSync(FIXTURE, root, { recursive: true });
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as Awaited<ReturnType<typeof list>>;
    const store = openHomeFolder(dirname(root)).blobs(root);
    for (const entry of golden) {
      expect(store.has(entry.hash)).toBe(true);
      expect(await verified(store, entry.hash)).toBe(true);
      const bytes = store.bytes(entry.hash);
      expect(sha(bytes)).toBe(entry.hash);
      const streamed: Buffer[] = [];
      for await (const chunk of store.stream(entry.hash)) streamed.push(chunk as Buffer);
      expect(Buffer.concat(streamed).equals(bytes)).toBe(true);
      const opened = await store.materialise(entry.hash);
      expect(readFileSync(opened.path).equals(bytes)).toBe(true);
      opened.dispose();
    }
    expect(JSON.parse(store.text(golden.find((entry) => entry.path.startsWith("5b"))!.hash))).toMatchObject({ chat: "+15550000001" });
    const large = await writePreviousStreamed(root, Array.from({ length: 8 }, (_, i) => Buffer.from(`{"n":${i},"pad":"${"q".repeat(MiB)}"}\n`)));
    expect(await verified(store, large)).toBe(true);
    const opened = await store.materialise(large);
    expect(sha256File(opened.path)).toBe(large);
    opened.dispose();

    const found = await list(store, golden.map((entry) => entry.hash));
    expect(found).toEqual(golden);
    artifact(dir, [...found, ...(await list(store, [large]))]);
  });
});

