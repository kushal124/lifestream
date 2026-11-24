import { createHash, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { BlobError, keyedBlobName, type BlobStore, type LeafFile } from "./blobs.js";
import { BLOB_FILE, openHomeFolder, type HomeFolder } from "./home-folder.js";
import { openHome, STORED_MARK, type FileCounted, type Guard, type Leaves } from "./index.js";
import { Keys, keyBytesOf } from "./keys.js";
import { blobSealing, identityOf, openBlob, SEGMENT, SealedError, writeSealed } from "./sealed.js";
import { keyedFolder, TEST_DATA_KEY, testMachine } from "./test/keyed.js";
import { temp } from "./test/large.js";

const KEYS = Keys.derive(TEST_DATA_KEY);
const keyOf = (label: "files" | "names"): Buffer => keyBytesOf(KEYS, label);

const CANARY = "canary-keyed-blobs-4f1e9a";
const MiB = 1024 * 1024;

function sha(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function keyedStore(): { root: string; scratch: string; store: BlobStore; folder: HomeFolder } {
  const home = temp("core-blobs-keyed-");
  const root = join(home, "blobs");
  const folder = keyedFolder(home);
  return { root, scratch: join(testMachine(), "scratch", "home"), store: folder.blobs(root), folder };
}

function copiesIn(scratch: string): string[] {
  return existsSync(scratch) ? readdirSync(scratch) : [];
}

function flip(path: string, at: number): void {
  chmodSync(path, 0o600);
  const sealed = readFileSync(path);
  sealed[at] = sealed[at]! ^ 0x01;
  writeFileSync(path, sealed);
}

function openFiles(): number {
  return readdirSync("/dev/fd").length;
}

async function closedTo(before: number): Promise<number> {
  for (let turn = 0; turn < 10_000 && openFiles() > before; turn++) await new Promise((resolve) => setImmediate(resolve));
  return openFiles();
}

function storageCount(store: BlobStore, blobs: string[]): FileCounted[] {
  const dir = temp("core-blobs-keyed-home-");
  const now = Date.UTC(2026, 10, 2, 12);
  const day = { zone: "UTC", day_start_hour: 0 };
  const db = openHome(openHomeFolder(dir), "migrate", { clock: () => now, day: () => day });
  const object: Guard = (content) => (typeof content === "object" && content !== null && !Array.isArray(content) ? [] : ["not an object"]);
  const run = db.commit((tx) => tx.tables.runs.start({ kind: "import", subject: "notes:person-a@example.com:cloud", started_ms: now }));
  const rows = blobs.map((blob, at) => ({ kind: "note", key: `n${at}`, content: { v: at }, blobs: [blob] }));
  db.commit((tx) => tx.records.land(run, { id: "notes:person-a@example.com:cloud@1", source: "notes:person-a@example.com:cloud", stated_ms: now }, rows, { note: object }, store));
  db.commit((tx) => tx.tables.runs.end(run, { ended_ms: now, outcome: "ok" }));
  db.close();
  const raw = new Database(join(dir, "home.db"));
  const M = raw.prepare("SELECT max(rowid) FROM versions").pluck().get() as number;
  raw.prepare("DELETE FROM stored_files").run();
  raw.prepare("UPDATE meta SET value = ? WHERE key = ?").run(JSON.stringify({ M, blocks: 0, after: null, erasures: 0, slab_ms: 0 }), STORED_MARK);
  raw.close();
  const reader = openHome(openHomeFolder(dir), "read");
  const view = reader.view();
  try {
    const map = view.stored.ownerMap({ settings: day, now_ms: now })!;
    expect(view.stored.mapBatch(map, Number.POSITIVE_INFINITY)).toBe(true);
    return view.stored.files(map, store, { after: null }, { leaves: 0x10000, references: 4096 })!.files;
  } finally {
    view.close();
    reader.close();
  }
}

function fileOf(root: string, hash: string): string {
  const name = keyedBlobName(keyOf("names"), hash);
  return join(root, "k1", name.slice(0, 2), name.slice(2, 4), name);
}

function filesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

async function collect(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(chunk as Buffer);
  return Buffer.concat(parts);
}

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("the read did not fail");
}

function syncFailure(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("the read did not fail");
}

function canaryText(lines: number): Buffer {
  return Buffer.from(Array.from({ length: lines }, (_, at) => `line ${at} ${CANARY}\n`).join(""));
}

function withCanary(size: number): Buffer {
  const bytes = randomBytes(size);
  Buffer.from(CANARY).copy(bytes, Math.floor(size / 2));
  return bytes;
}

function allLeaves(store: BlobStore): LeafFile[] {
  const files: LeafFile[] = [];
  for (let leaf = 0; leaf < 0x10000; leaf++) files.push(...store.leaf(leaf.toString(16).padStart(4, "0")));
  return files;
}

describe("a keyed home's blob store: each of these is impossible", () => {
  it("a file under blobs/ is named by a SHA-256, lies outside its key's tree, or holds a canary", async () => {
    const { root, store } = keyedStore();
    const text = canaryText(5000);
    const raw = withCanary(3 * SEGMENT + 17);
    const chunked = withCanary(2 * MiB);
    const plainFile = join(temp("core-blobs-keyed-src-"), "export.json");
    writeFileSync(plainFile, canaryText(800));
    const hashes = [
      store.put(text, { mediaType: "text/plain" }),
      store.put(raw, { mediaType: "image/jpeg" }),
      await store.putChunks(() => (async function* () {
        for (let at = 0; at < chunked.length; at += 100_000) yield chunked.subarray(at, at + 100_000);
      })(), chunked.length),
      await store.putChunks(() => (async function* () {
        yield canaryText(300);
      })(), canaryText(300).length, { mediaType: "application/json" }),
      await store.putFile(plainFile, { mediaType: "application/json" }),
      await store.putFile(plainFile),
    ];
    const names = new Set(hashes.map((hash) => hash.slice("sha256:".length)));
    const files = filesUnder(root);
    expect(files.length).toBe(new Set(hashes).size);
    for (const path of files) {
      const parts = relative(root, path).split(sep);
      expect(parts[0]).toBe("k1");
      expect(names.has(parts.at(-1)!)).toBe(false);
      expect(readFileSync(path).includes(CANARY)).toBe(false);
      expect(statSync(path).mode & 0o777).toBe(0o400);
    }
    expect(store.bytes(hashes[0]!).equals(text)).toBe(true);
    expect(store.text(hashes[0]!)).toBe(text.toString());
    expect(store.bytes(hashes[1]!).equals(raw)).toBe(true);
    expect((await collect(store.stream(hashes[2]!))).equals(chunked)).toBe(true);
    expect(store.bytes(hashes[4]!).equals(readFileSync(plainFile))).toBe(true);
    expect(hashes[5]).toBe(hashes[4]);
    expect(store.size(hashes[0]!)).toBe(text.length);
    expect(store.size(hashes[1]!)).toBe(raw.length);
    expect(store.prefix(hashes[0]!, 20).equals(text.subarray(0, 20))).toBe(true);
    expect(store.prefix(hashes[1]!, SEGMENT + 3).equals(raw.subarray(0, SEGMENT + 3))).toBe(true);
    expect(store.has(hashes[1]!)).toBe(true);
    expect(store.has(sha(Buffer.from("never put")))).toBe(false);
    expect(store.stored(hashes[1]!)).toBe(statSync(fileOf(root, hashes[1]!)).size);
  });

  it("a blob whose identity crosses into its last segment, or fills a segment exactly, reads back otherwise", async () => {
    const { store } = keyedStore();
    for (const size of [0, 1, 65_448, 65_449, 65_479, 65_480, 65_481, 65_480 + 65_520 - 31, 65_480 + 65_520]) {
      const bytes = randomBytes(size);
      const hash = store.put(bytes);
      expect(store.bytes(hash).equals(bytes)).toBe(true);
      expect(store.size(hash)).toBe(size);
      expect((await collect(store.stream(hash))).equals(bytes)).toBe(true);
      const name = hash.slice("sha256:".length);
      expect(store.leaf(keyedBlobName(keyOf("names"), hash).slice(0, 4)).map((file) => file.blob)).toContain(hash);
      expect(name).toHaveLength(64);
    }
  });

  it("a range reads other bytes than the blob's, or past its end", async () => {
    const { store } = keyedStore();
    const raw = randomBytes(2 * SEGMENT + 5);
    const text = canaryText(20_000);
    const rawHash = store.put(raw);
    const textHash = store.put(text, { mediaType: "text/plain" });
    for (const [start, end] of [[0, 10], [SEGMENT - 100, SEGMENT + 100], [2 * SEGMENT - 50, raw.length], [7, 7], [raw.length - 3, raw.length + 50]] as const) {
      expect((await collect(store.stream(rawHash, { start, end }))).equals(raw.subarray(start, end))).toBe(true);
      expect((await collect(store.stream(textHash, { start, end }))).equals(text.subarray(start, end))).toBe(true);
    }
  });

  it("a delivered raw file reads otherwise through the inbox's name than through the store's, a delivered file that lies is stored, or the store finds a sealed file by its name on disk", async () => {
    const { root, store, folder } = keyedStore();
    const inbox = temp("core-blobs-keyed-inbox-");
    const raw = withCanary(SEGMENT * 3 + 9);
    const delivered = folder.file(BLOB_FILE, join(inbox, "photo.jpg"));
    delivered.write(raw);
    const hash = await store.putKept(delivered, { mediaType: "image/jpeg", expect: sha(raw) });
    expect(hash).toBe(sha(raw));
    const throughInbox = openBlob(`${delivered.path}.k1`, blobSealing(keyOf("files")));
    expect((await collect(throughInbox)).equals(raw)).toBe(true);
    expect(throughInbox.identity).toBe(hash);
    expect(store.bytes(hash).equals(raw)).toBe(true);
    expect((await collect(store.stream(hash))).equals(raw)).toBe(true);
    expect(delivered.stat()?.links).toBe(2);
    expect(readFileSync(fileOf(root, hash)).equals(readFileSync(`${delivered.path}.k1`))).toBe(true);

    const text = canaryText(400);
    const sent = folder.file(BLOB_FILE, join(inbox, "notes.txt"));
    sent.write(text);
    const textHash = await store.putKept(sent, { mediaType: "text/plain" });
    expect(store.bytes(textHash).equals(text)).toBe(true);
    expect(sent.stat()?.links).toBe(1);

    const other = randomBytes(5000);
    const lying = join(inbox, "lie.bin");
    await writeSealed(`${lying}.k1`, [other, identityOf(randomBytes(10))], blobSealing(keyOf("files")));
    const refused = await failure(() => store.putKept(folder.file(BLOB_FILE, lying)));
    expect(refused).toBeInstanceOf(BlobError);
    expect((refused as BlobError).code).toBe("BLOB_CORRUPT");
    expect(store.has(sha(other))).toBe(false);
    const lyingText = join(inbox, "lie.txt");
    await writeSealed(`${lyingText}.k1`, [other, identityOf(randomBytes(10))], blobSealing(keyOf("files")));
    expect(((await failure(() => store.putKept(folder.file(BLOB_FILE, lyingText), { mediaType: "text/plain" }))) as BlobError).code).toBe("BLOB_CORRUPT");

    expect(await failure(() => store.putFile(join(inbox, "photo.jpg")))).toMatchObject({ code: "BLOB_NOT_STORED", message: expect.stringContaining("ENOENT") });
    const day = folder.file({ role: "day" }, join(folder.root, "days", "a.txt"));
    day.write(raw);
    expect(((await failure(() => store.putKept(day))) as BlobError).code).toBe("BLOB_NOT_STORED");
    const plainHome = temp("core-blobs-plain-home-");
    expect(((await failure(() => store.putKept(openHomeFolder(plainHome).file(BLOB_FILE, join(plainHome, "photo.jpg"))))) as BlobError).code).toBe("BLOB_NOT_STORED");
    expect(store.has(sha(other))).toBe(false);
    expect(filesUnder(root).every((path) => !path.includes(".tmp-"))).toBe(true);
  });

  it("a file put where another blob's name is read as that blob, whole or by range", async () => {
    const { root, store } = keyedStore();
    const a = randomBytes(3 * SEGMENT);
    const b = randomBytes(3 * SEGMENT);
    const aHash = store.put(a);
    const bHash = store.put(b);
    const textHash = store.put(canaryText(1000), { mediaType: "text/plain" });
    for (const swapped of [aHash, textHash]) {
      const path = fileOf(root, swapped);
      chmodSync(path, 0o600);
      copyFileSync(fileOf(root, bHash), path);
      const ranged = await failure(() => collect(store.stream(swapped, { start: 0, end: 10 })));
      expect((ranged as BlobError).code).toBe("BLOB_CORRUPT");
      expect((await failure(() => collect(store.stream(swapped)))) as BlobError).toMatchObject({ code: "BLOB_CORRUPT" });
      expect((syncFailure(() => store.bytes(swapped)) as BlobError).code).toBe("BLOB_CORRUPT");
      expect((syncFailure(() => store.prefix(swapped, 4)) as BlobError).code).toBe("BLOB_CORRUPT");
    }
  });

  it("a damaged segment mid-stream ends the read as a short file, or leaves a working copy", async () => {
    const { root, scratch, store } = keyedStore();
    const raw = randomBytes(6 * SEGMENT);
    const hash = store.put(raw);
    const path = fileOf(root, hash);
    chmodSync(path, 0o600);
    const sealed = readFileSync(path);
    sealed[3 * SEGMENT + 100] = sealed[3 * SEGMENT + 100]! ^ 0x01;
    writeFileSync(path, sealed);
    let handed = 0;
    const whole = await failure(async () => {
      for await (const chunk of store.stream(hash)) handed += (chunk as Buffer).length;
    });
    expect(whole).toBeInstanceOf(BlobError);
    expect((whole as BlobError).code).toBe("BLOB_CORRUPT");
    expect((whole as BlobError).cause).toBeInstanceOf(SealedError);
    expect(((whole as BlobError).cause as SealedError).code).toBe("SEALED_DAMAGED");
    expect(handed).toBeLessThan(raw.length);
    const ranged = await failure(() => collect(store.stream(hash, { start: SEGMENT, end: 5 * SEGMENT })));
    expect((ranged as BlobError).code).toBe("BLOB_CORRUPT");
    expect((await collect(store.stream(hash, { start: 0, end: 100 }))).equals(raw.subarray(0, 100))).toBe(true);
    expect(((await failure(() => store.materialise(hash))) as BlobError).code).toBe("BLOB_CORRUPT");
    expect(copiesIn(scratch)).toEqual([]);
    expect((syncFailure(() => store.bytes(hash)) as BlobError).code).toBe("BLOB_CORRUPT");
  });

  it("a working copy is made in the store, or outlives its dispose", async () => {
    const { root, scratch, store } = keyedStore();
    const raw = withCanary(SEGMENT + 77);
    const text = canaryText(100);
    for (const [bytes, mediaType] of [[raw, "image/jpeg"], [text, "text/plain"]] as const) {
      const hash = store.put(bytes, { mediaType });
      const copy = await store.materialise(hash);
      expect(copy.path.startsWith(`${scratch}${sep}`)).toBe(true);
      expect(readFileSync(copy.path).equals(bytes)).toBe(true);
      expect(filesUnder(root).some((path) => readFileSync(path).includes(CANARY))).toBe(false);
      copy.dispose();
      expect(copiesIn(scratch)).toEqual([]);
    }
  });

  it("Storage counts a keyed tree otherwise than the plain tree of the same blobs, or its cursor names a blob's SHA-256", () => {
    const dir = temp("core-blobs-keyed-home-");
    const { store } = keyedStore();
    const now = Date.UTC(2026, 10, 2, 12);
    const day = { zone: "UTC", day_start_hour: 0 };
    const db = openHome(openHomeFolder(dir), "migrate", { clock: () => now, day: () => day });
    const object: Guard = (content) => (typeof content === "object" && content !== null && !Array.isArray(content) ? [] : ["not an object"]);
    const blobs = Array.from({ length: 24 }, (_, at) => store.put(Buffer.from(`synthetic file ${at} ${CANARY}`), at % 3 === 0 ? { mediaType: "text/plain" } : {}));
    const sources = ["notes:person-a@example.com:cloud", "whatsapp:+15550000001:mac-aa01"];
    for (const [index, source] of sources.entries()) {
      const run = db.commit((tx) => tx.tables.runs.start({ kind: "import", subject: source, started_ms: now }));
      const rows = blobs.filter((_, at) => at % 2 === index).map((blob, at) => ({ kind: "note", key: `n${at}`, content: { v: at }, blobs: [blob] }));
      db.commit((tx) => tx.records.land(run, { id: `${source}@1`, source, stated_ms: now }, rows, { note: object }, store));
      db.commit((tx) => tx.tables.runs.end(run, { ended_ms: now, outcome: "ok" }));
    }
    db.close();
    const raw = new Database(join(dir, "home.db"));
    const M = raw.prepare("SELECT max(rowid) FROM versions").pluck().get() as number;
    raw.prepare("DELETE FROM stored_files").run();
    raw.prepare("UPDATE meta SET value = ? WHERE key = ?").run(JSON.stringify({ M, blocks: 0, after: null, erasures: 0, slab_ms: 0 }), STORED_MARK);
    raw.close();

    const keyedFiles = allLeaves(store);
    const plain: Leaves = {
      leaves: () => (prefix) => keyedFiles.filter((file) => file.blob.startsWith(`sha256:${prefix}`)).map(({ blob, bytes, mtime_ms }) => ({ blob, bytes, mtime_ms })).sort((left, right) => (left.blob < right.blob ? -1 : 1)),
    };
    expect(new Set(keyedFiles.map((file) => file.blob))).toEqual(new Set(blobs));

    const reader = openHome(openHomeFolder(dir), "read");
    const view = reader.view();
    try {
      const map = view.stored.ownerMap({ settings: day, now_ms: now })!;
      expect(view.stored.mapBatch(map, Number.POSITIVE_INFINITY)).toBe(true);
      const whole = (leaves: Leaves) => view.stored.files(map, leaves, { after: null }, { leaves: 0x10000, references: 4096 })!;
      const counted = (files: { blob: string; source: string; version: number; bytes: number; day: string }[]) =>
        files.map(({ blob, source, version, bytes, day: on }) => ({ blob, source, version, bytes, day: on })).sort((left, right) => (left.blob < right.blob ? -1 : 1));
      const keyed = whole(store);
      const plainSlab = whole(plain);
      expect(keyed.files.length).toBe(blobs.length);
      expect(counted(keyed.files)).toEqual(counted(plainSlab.files));
      expect(keyed.through).toBe(plainSlab.through);

      const stepped: typeof keyed.files = [];
      let from: { after: string | null; naming?: typeof keyed.naming } = { after: null };
      let slabs = 0;
      for (;;) {
        const slab = view.stored.files(map, store, from, { leaves: 0x10000, references: 1 })!;
        stepped.push(...slab.files);
        slabs++;
        if (slab.through === keyed.through) break;
        if (slab.through !== null) {
          expect(slab.through.startsWith("k1:")).toBe(true);
          expect(blobs).not.toContain(`sha256:${slab.through.slice("k1:".length)}`);
        }
        from = { after: slab.through, ...(slab.naming === undefined ? {} : { naming: slab.naming }) };
      }
      expect(slabs).toBeGreaterThan(blobs.length / 2);
      expect(counted(stepped)).toEqual(counted(keyed.files));

      const leafStepped: typeof keyed.files = [];
      let leafFrom: { after: string | null } = { after: null };
      for (;;) {
        const slab = view.stored.files(map, store, leafFrom, { leaves: 4096, references: 4096 })!;
        leafStepped.push(...slab.files);
        if (slab.through === keyed.through) break;
        expect(slab.through?.startsWith("k1:")).toBe(true);
        leafFrom = { after: slab.through };
      }
      expect(counted(leafStepped)).toEqual(counted(keyed.files));
    } finally {
      view.close();
      reader.close();
    }
  });

  it("a damaged segment in a compressed blob hangs its read, whole, ranged or as a working copy", async () => {
    const { root, scratch, store } = keyedStore();
    const text = Buffer.from(randomBytes(6 * SEGMENT).toString("hex"));
    const hash = store.put(text, { mediaType: "text/plain" });
    expect(store.stored(hash)!).toBeGreaterThan(5 * SEGMENT);
    expect(store.stored(hash)!).toBeLessThan(text.length);
    flip(fileOf(root, hash), 3 * SEGMENT + 100);
    const whole = await failure(() => collect(store.stream(hash)));
    expect((whole as BlobError).code).toBe("BLOB_CORRUPT");
    expect(((whole as BlobError).cause as SealedError).code).toBe("SEALED_DAMAGED");
    const ranged = await failure(() => collect(store.stream(hash, { start: text.length - 100, end: text.length })));
    expect((ranged as BlobError).code).toBe("BLOB_CORRUPT");
    expect(((await failure(() => store.materialise(hash))) as BlobError).code).toBe("BLOB_CORRUPT");
    expect(copiesIn(scratch)).toEqual([]);
  });

  it("a read stopped early, failed or destroyed leaves its file open", async () => {
    const { root, store } = keyedStore();
    const text = Buffer.from(randomBytes(6 * SEGMENT).toString("hex"));
    const raw = randomBytes(4 * SEGMENT);
    const textHash = store.put(text, { mediaType: "text/plain" });
    const rawHash = store.put(raw);
    const before = openFiles();
    for (const hash of [textHash, rawHash]) {
      expect((await collect(store.stream(hash, { start: 0, end: 10 }))).length).toBe(10);
      store.stream(hash).destroy();
      store.stream(hash, { start: 5, end: 3 * SEGMENT }).destroy();
      const reading = store.stream(hash);
      for await (const _chunk of reading) break;
      const part = store.stream(hash, { start: 5, end: 3 * SEGMENT });
      for await (const _chunk of part) break;
    }
    flip(fileOf(root, textHash), 3 * SEGMENT + 100);
    await failure(() => collect(store.stream(textHash)));
    await failure(() => collect(store.stream(textHash, { start: text.length - 100, end: text.length })));
    expect(await closedTo(before)).toBe(before);
  });

  it("a file whose identity cannot be read stops Storage's count, or a file put where another blob's name is listed twice", () => {
    const { root, store } = keyedStore();
    const blobs = Array.from({ length: 12 }, (_, at) => store.put(at % 3 === 0 ? canaryText(40 + at) : randomBytes(2 * SEGMENT + at), at % 3 === 0 ? { mediaType: "text/plain" } : {}));
    const [damaged, swapped, kept] = [blobs[1]!, blobs[2]!, blobs[4]!];
    const path = fileOf(root, damaged);
    flip(path, statSync(path).size - 5);
    chmodSync(fileOf(root, swapped), 0o600);
    copyFileSync(fileOf(root, kept), fileOf(root, swapped));
    const listed = allLeaves(store).map((file) => file.blob);
    expect(listed.filter((blob) => blob === kept)).toHaveLength(1);
    expect(listed).not.toContain(damaged);
    expect(listed).not.toContain(swapped);
    expect(new Set(listed)).toEqual(new Set(blobs.filter((blob) => blob !== damaged && blob !== swapped)));
    const counted = storageCount(store, blobs).map((file) => file.blob).sort();
    expect(counted).toEqual([...blobs].sort());
  });

  it("Storage's count of a keyed tree opens a sealed file", () => {
    const { root, store } = keyedStore();
    const blobs = Array.from({ length: 12 }, (_, at) => store.put(at % 3 === 0 ? canaryText(40 + at) : randomBytes(SEGMENT + at), at % 3 === 0 ? { mediaType: "text/plain" } : {}));
    const unreferenced = store.put(Buffer.from("never linked"));
    for (const blob of [...blobs, unreferenced]) chmodSync(fileOf(root, blob), 0o000);
    const counted = storageCount(store, blobs);
    expect(counted.map((file) => file.blob).sort()).toEqual([...blobs].sort());
    for (const file of counted) expect(file.bytes).toBe(statSync(fileOf(root, file.blob)).size);
  });

  it("a bad range reads as a damaged blob", async () => {
    const { store } = keyedStore();
    const hash = store.put(randomBytes(SEGMENT + 3));
    const refused = await failure(() => collect(store.stream(hash, { start: -1, end: 5 })));
    expect(refused).toBeInstanceOf(RangeError);
    expect(refused).not.toBeInstanceOf(BlobError);
  });

  it("a delivered file named like a sealed one is read as sealed unless the caller says so", async () => {
    const { store } = keyedStore();
    const inbox = temp("core-blobs-keyed-inbox-");
    const bytes = randomBytes(5000);
    const named = join(inbox, "export.zip.k1");
    writeFileSync(named, bytes);
    expect(await store.putFile(named)).toBe(sha(bytes));
    expect(store.bytes(sha(bytes)).equals(bytes)).toBe(true);
  });
});

describe("a store's form comes from its folder: each of these is impossible", () => {
  const code = (run: () => unknown) => (syncFailure(run) as { code?: string }).code;

  it("a keyed folder opened with no keys reads or writes anything, or makes a file", () => {
    const home = temp("core-blobs-locked-");
    keyedFolder(home);
    const before = filesUnder(home);
    expect(code(() => openHomeFolder(home))).toBe("LOCKED");
    expect(code(() => openHomeFolder(home, { machine: testMachine(), program: "home" }))).toBe("LOCKED");
    expect(filesUnder(home)).toEqual(before);
  });

  it("a plain folder handed keys seals what it keeps", () => {
    const home = temp("core-blobs-plain-");
    const root = join(home, "blobs");
    const store = openHomeFolder(home, { machine: testMachine(), program: "home", keys: KEYS }).blobs(root);
    const a = store.put(Buffer.from("synthetic a"));
    expect(store.listing).toBe("sha256:");
    const hex = a.slice("sha256:".length);
    expect(filesUnder(root).map((path) => relative(root, path))).toEqual([join(hex.slice(0, 2), hex.slice(2, 4), hex)]);
    expect(openHomeFolder(home).blobs(root, { reading: true }).bytes(a).toString()).toBe("synthetic a");
  });

  it("a folder that holds both a keyed and a plain tree is opened", () => {
    const home = temp("core-blobs-both-");
    const root = join(home, "blobs");
    mkdirSync(join(root, "ab", "cd"), { recursive: true });
    const folder = keyedFolder(home);
    expect(code(() => folder.blobs(root))).toBe("BLOB_FORM");
    expect(code(() => folder.blobs(root, { reading: true }))).toBe("BLOB_FORM");
    const plain = temp("core-blobs-plain-k1-");
    mkdirSync(join(plain, "other", "k1"), { recursive: true });
    expect(code(() => openHomeFolder(plain).blobs(join(plain, "other")))).toBe("BLOB_FORM");
  });
});
