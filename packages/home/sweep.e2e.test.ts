import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { join, relative } from "node:path";
import { declarations } from "@lifestreamprotocol/connect";
import type { ReadTables } from "@lifestreamprotocol/core";
import { afterEach, describe, expect, it } from "vitest";
import { askHome } from "./socket.js";
import { readReceipt, rehydrate, sweepInbox, type Receipt } from "./sweep.js";
import { ChildHome, makeRoot, readHome, removeRoot, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { DAY, openTestHome, removeDir, sealDelivery, sha256, T0, tempDir, writeArtifact, type TestHome } from "./test/ops-support.js";
import { testSocket } from "./test/folder.js";
import { openHomeFolder, type HomeFolder } from "@lifestreamprotocol/core";
import { keyedFolder } from "@lifestreamprotocol/core/test/keyed";
import { deliveredFile, openSealing } from "./inbox.js";
import { gzipSync } from "node:zlib";
import { filesBeside } from "./import.js";
import { fileOfPath, GONE } from "./imports.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()!();
});

const NOW = T0 + 30 * DAY;
const MAC = "whatsapp:+15550000001:macbook-pro-0001";
const PHOTOS = "apple-photos:local:macbook-pro-0001";
const MiB = 1024 * 1024;
const PHONE = "phone:iphone-aa01";

function index(test: TestHome, id: string, rows: { source: string; state: "imported" | "sealed" | "superseded"; stated_ms: number; refused?: number }[]): void {
  test.db.commit((tx) => {
    for (const row of rows) {
      tx.tables.deliveries.add({ id, source: row.source, sealed_ms: row.stated_ms, stated_ms: row.stated_ms, facts: {} });
      if (row.state === "imported") {
        const run = tx.tables.runs.start({ kind: "import", subject: row.source, started_ms: NOW });
        tx.tables.runs.end(run, { ended_ms: NOW, outcome: "ok", counts: { refused: row.refused ?? 0 } });
        tx.tables.deliveries.move(id, row.source, { move: "begin", run });
        tx.tables.deliveries.move(id, row.source, { move: "land", run, refused: row.refused ?? 0, error: null, code: "sha256:code-1" });
      } else if (row.state === "superseded") tx.tables.deliveries.move(id, row.source, { move: "supersede" });
    }
  });
}

function pass(test: TestHome, root: string, off: string[] = [], blobs = test.blobs, folder: HomeFolder = openHomeFolder(root)) {
  const read = <T>(work: (tables: ReadTables) => T): T => {
    const view = test.db.view();
    try {
      return work(view.tables);
    } finally {
      view.close();
    }
  };
  return sweepInbox({ folder, read, commit: (work) => test.db.commit(work), blobs, now_ms: NOW, off, connectors: declarations() });
}

function tree(inbox: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(inbox, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[relative(inbox, path)] = entry.name === "swept.json" ? readFileSync(path, "utf8").trim() : sha256(readFileSync(path));
  }
  return files;
}

describe("the inbox sweep", () => {
  it("a delivered video written to the disk twice, its inbox name kept past the sweep, or a name the store still holds counted as freed", async () => {
    const root = tempDir("sweep-once");
    const test = openTestHome(root);
    cleanup.push(() => removeDir(root), () => test.close());
    const video = Buffer.alloc(3 * MiB + 17);
    for (let at = 0; at + 4 <= video.length; at += 4) video.writeUInt32LE((at * 2654435761) >>> 0, at);
    const rows = Buffer.from(Array.from({ length: 200 }, (_, n) => `{"asset":"SYNTH-${n}","camera":"macbook-pro-0001"}\n`).join(""));
    const still = Buffer.from("synthetic heic still a device carried in its lane");
    const name = "20260901T080000Z";
    const directory = sealDelivery(root, PHOTOS, name, { "media/clip.mov": video, "rows.jsonl": rows });
    const lane = join(root, "inbox", PHOTOS, "blobs");
    mkdirSync(lane, { recursive: true });
    writeFileSync(join(lane, sha256(still)), still);
    const inbox = { video: join(directory, "media", "clip.mov"), rows: join(directory, "rows.jsonl"), still: join(lane, sha256(still)) };
    const stored = (bytes: Buffer) => join(root, "blobs", sha256(bytes).slice(0, 2), sha256(bytes).slice(2, 4), sha256(bytes));
    const look = (path: string) => (existsSync(path) ? { ino: statSync(path).ino, nlink: statSync(path).nlink } : null);
    const state = () => ({
      video: { inbox: look(inbox.video), store: look(stored(video)) },
      rows: { inbox: look(inbox.rows), store: look(stored(rows)) },
      still: { inbox: look(inbox.still), store: look(stored(still)) },
    });
    const delivered = state();

    await test.blobs.putFile(inbox.video, { expect: `sha256:${sha256(video)}`, mediaType: "video/quicktime" });
    await test.blobs.putFile(inbox.rows, { expect: `sha256:${sha256(rows)}`, mediaType: "application/x-ndjson" });
    await test.blobs.putFile(inbox.still, { expect: `sha256:${sha256(still)}` });
    index(test, `${PHOTOS}/${name}`, [{ source: PHOTOS, state: "imported", stated_ms: T0 }]);
    const imported = state();
    expect(imported.video).toEqual({ inbox: { ino: delivered.video.inbox!.ino, nlink: 2 }, store: { ino: delivered.video.inbox!.ino, nlink: 2 } });
    expect(imported.still).toEqual({ inbox: { ino: delivered.still.inbox!.ino, nlink: 2 }, store: { ino: delivered.still.inbox!.ino, nlink: 2 } });
    expect(imported.rows.inbox).toEqual({ ino: delivered.rows.inbox!.ino, nlink: 1 });
    expect(imported.rows.store?.nlink).toBe(1);
    expect(imported.rows.store?.ino).not.toBe(delivered.rows.inbox!.ino);
    expect(statSync(inbox.video).mode & 0o222).toBe(0);
    expect(statSync(inbox.rows).mode & 0o222).not.toBe(0);

    const report = await pass(test, root);
    expect(report).toMatchObject({ deliveries: 1, files: 2, bytes: rows.length, kept: 0, lane_blobs: 1, lane_bytes: 0, unreadable: [] });
    const swept = state();
    expect(swept.video).toEqual({ inbox: null, store: { ino: delivered.video.inbox!.ino, nlink: 1 } });
    expect(swept.still).toEqual({ inbox: null, store: { ino: delivered.still.inbox!.ino, nlink: 1 } });
    expect(swept.rows).toEqual({ inbox: null, store: imported.rows.store });
    for (const bytes of [video, rows, still]) expect(sha256(test.blobs.bytes(`sha256:${sha256(bytes)}`))).toBe(sha256(bytes));

    mkdirSync(join(directory, "media"), { recursive: true });
    writeFileSync(`${inbox.video}.rehydrating`, video.subarray(0, 1), { mode: 0o444 });
    expect(await rehydrate({ folder: openHomeFolder(root), blobs: test.blobs, delivery: `${PHOTOS}/${name}` })).toMatchObject({ written: 2, bytes: video.length + rows.length });
    const rehydrated = state();
    expect(rehydrated.video.store).toEqual(swept.video.store);
    expect(rehydrated.video.inbox?.nlink).toBe(1);
    expect(rehydrated.video.inbox?.ino).not.toBe(swept.video.store!.ino);
    expect(sha256(readFileSync(inbox.video))).toBe(sha256(video));
    writeArtifact("swept-written-once", { bytes: { video: video.length, rows: rows.length, still: still.length }, delivered, imported, report, swept, rehydrated });
  });

  it("the sweep removing a file whose blob is not in blobs/, and rehydrate writing different bytes", async () => {
    const root = tempDir("sweep");
    const test = openTestHome(root);
    cleanup.push(() => removeDir(root), () => test.close());
    const inbox = join(root, "inbox");
    const snapshot = Buffer.from("synthetic chat database, newest snapshot");
    const wal = Buffer.from("synthetic write-ahead log");
    const unstored = Buffer.from("synthetic file the connector keeps no blob of");
    const damaged = Buffer.from("synthetic attachment whose stored blob is damaged");
    test.blobs.put(snapshot, { mediaType: "application/vnd.sqlite3" });
    test.blobs.put(wal);
    const damagedHash = test.blobs.put(damaged);
    const damagedPath = join(root, "blobs", sha256(damaged).slice(0, 2), sha256(damaged).slice(2, 4), sha256(damaged));
    chmodSync(damagedPath, 0o600);
    writeFileSync(damagedPath, Buffer.from("other bytes entirely"));
    expect(() => test.blobs.bytes(damagedHash)).toThrow(/hash to/u);

    sealDelivery(root, MAC, "20260901T080000Z", { "ChatStorage.sqlite": snapshot, "ChatStorage.sqlite-wal": wal, "notes/unstored.bin": unstored, "media/damaged.jpg": damaged });
    index(test, `${MAC}/20260901T080000Z`, [{ source: MAC, state: "imported", stated_ms: T0 }]);
    sealDelivery(root, MAC, "20260925T080000Z", { "ChatStorage.sqlite": snapshot });
    index(test, `${MAC}/20260925T080000Z`, [{ source: MAC, state: "sealed", stated_ms: T0 + 24 * DAY }]);
    sealDelivery(root, MAC, "20260831T080000Z", { "ChatStorage.sqlite": Buffer.from("synthetic older snapshot") });
    index(test, `${MAC}/20260831T080000Z`, [{ source: MAC, state: "superseded", stated_ms: T0 - DAY }]);
    sealDelivery(root, MAC, "20260920T080000Z", { "ChatStorage.sqlite": Buffer.from("synthetic snapshot superseded by a newer one not yet swept") });
    index(test, `${MAC}/20260920T080000Z`, [{ source: MAC, state: "superseded", stated_ms: T0 + 19 * DAY }]);
    const bundle = `sha256:${sha256("synthetic bundle")}`;
    sealDelivery(root, PHONE, bundle, { "bundle/location.jsonl": snapshot });
    index(test, `${PHONE}/${bundle}`, [
      { source: "location:local:iphone-aa01", state: "imported", stated_ms: T0 },
      { source: "apple-photos:local:iphone-aa01", state: "sealed", stated_ms: T0 },
    ]);
    sealDelivery(root, MAC, "20260902T080000Z", { "ChatStorage.sqlite": snapshot });
    const lane = join(inbox, PHONE, "blobs");
    mkdirSync(lane, { recursive: true });
    for (const bytes of [wal, snapshot, unstored, damaged]) writeFileSync(join(lane, sha256(bytes)), bytes);

    const swept = await pass(test, root);
    expect(swept).toMatchObject({ deliveries: 1, files: 2, kept: 2, superseded: 1, lane_blobs: 0, unreadable: [] });
    const first = join(inbox, MAC, "20260901T080000Z");
    expect(existsSync(join(first, "ChatStorage.sqlite"))).toBe(false);
    expect(existsSync(join(first, "ChatStorage.sqlite-wal"))).toBe(false);
    expect(readFileSync(join(first, "notes", "unstored.bin"))).toEqual(unstored);
    expect(readFileSync(join(first, "media", "damaged.jpg"))).toEqual(damaged);
    const receipt = JSON.parse(readFileSync(join(first, "swept.json"), "utf8")) as Receipt;
    expect(receipt).toMatchObject({ done: true, removed: ["ChatStorage.sqlite", "ChatStorage.sqlite-wal"], kept: ["notes/unstored.bin", "media/damaged.jpg"] });
    expect(existsSync(join(first, "manifest.json"))).toBe(true);
    expect(existsSync(join(inbox, MAC, "20260925T080000Z", "ChatStorage.sqlite"))).toBe(true);
    expect(existsSync(join(inbox, MAC, "20260831T080000Z"))).toBe(false);
    expect(existsSync(join(inbox, MAC, "20260920T080000Z", "manifest.json"))).toBe(true);
    expect(existsSync(join(inbox, PHONE, bundle, "bundle/location.jsonl"))).toBe(true);
    expect(existsSync(join(inbox, MAC, "20260902T080000Z", "ChatStorage.sqlite"))).toBe(true);
    expect(readdirSync(lane)).toHaveLength(4);

    test.db.commit((tx) => {
      const run = tx.tables.runs.start({ kind: "import", subject: "apple-photos:local:iphone-aa01", started_ms: NOW });
      tx.tables.runs.end(run, { ended_ms: NOW, outcome: "ok", counts: { refused: 0 } });
      tx.tables.deliveries.move(`${PHONE}/${bundle}`, "apple-photos:local:iphone-aa01", { move: "begin", run });
      tx.tables.deliveries.move(`${PHONE}/${bundle}`, "apple-photos:local:iphone-aa01", { move: "land", run, refused: 0, error: null, code: "sha256:code-1" });
    });
    expect(await pass(test, root)).toMatchObject({ deliveries: 1, lane_blobs: 2, unreadable: [] });
    expect(readdirSync(lane).sort()).toEqual([sha256(unstored), sha256(damaged)].sort());

    expect(await pass(test, root)).toMatchObject({ deliveries: 0, files: 0, superseded: 0, lane_blobs: 0 });
    const sweptTree = tree(inbox);

    const back = await rehydrate({ folder: openHomeFolder(root), blobs: test.blobs, delivery: `${MAC}/20260901T080000Z` });
    expect(back).toMatchObject({ written: 2, bytes: snapshot.length + wal.length });
    expect(sha256(readFileSync(join(first, "ChatStorage.sqlite")))).toBe(sha256(snapshot));
    expect(sha256(readFileSync(join(first, "ChatStorage.sqlite-wal")))).toBe(sha256(wal));
    expect(existsSync(join(first, "swept.json"))).toBe(false);

    const hurt = sealDelivery(root, MAC, "20260903T080000Z", { "media/damaged.jpg": damaged });
    writeFileSync(join(hurt, "swept.json"), JSON.stringify({ swept_ms: NOW, done: true, removed: ["media/damaged.jpg"], kept: [] }));
    const listed = join(hurt, "media", "damaged.jpg");
    rmSync(listed);
    await expect(rehydrate({ folder: openHomeFolder(root), blobs: test.blobs, delivery: `${MAC}/20260903T080000Z` })).rejects.toThrow();
    expect(existsSync(listed)).toBe(false);
    expect(readdirSync(join(hurt, "media"))).toEqual([]);
    expect(existsSync(join(hurt, "swept.json"))).toBe(true);
    expect(statSync(hurt).isDirectory()).toBe(true);
    writeArtifact("swept-inbox", { report: swept, swept: sweptTree, rehydrated: back });
  });

  it("the sweep reading a stored blob's bytes again, or removing a file whose blob is missing or another size", async () => {
    const root = tempDir("sweep-unread");
    const test = openTestHome(root);
    cleanup.push(() => removeDir(root), () => test.close());
    const stored = Buffer.from("synthetic attachment stored once, as its import stored it");
    const cut = Buffer.from("synthetic attachment whose stored copy lost its tail");
    const missing = Buffer.from("synthetic attachment the store never held");
    const altered = Buffer.from("synthetic attachment whose stored copy changed in place");
    for (const bytes of [stored, cut, altered]) test.blobs.put(bytes);
    const file = (bytes: Buffer) => join(root, "blobs", sha256(bytes).slice(0, 2), sha256(bytes).slice(2, 4), sha256(bytes));
    chmodSync(file(cut), 0o600);
    writeFileSync(file(cut), cut.subarray(0, 10));
    chmodSync(file(altered), 0o600);
    writeFileSync(file(altered), Buffer.from(altered.toString("utf8").toUpperCase()));
    const directory = sealDelivery(root, MAC, "20260901T080000Z", { "media/stored.jpg": stored, "media/cut.jpg": cut, "media/missing.jpg": missing, "media/altered.jpg": altered });
    index(test, `${MAC}/20260901T080000Z`, [{ source: MAC, state: "imported", stated_ms: T0 }]);
    const lane = join(root, "inbox", PHONE, "blobs");
    mkdirSync(lane, { recursive: true });
    for (const bytes of [stored, missing]) writeFileSync(join(lane, sha256(bytes)), bytes);

    const reads: string[] = [];
    const blobs = new Proxy(test.blobs, {
      get(target, name, receiver) {
        const value = Reflect.get(target, name, receiver) as unknown;
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (["bytes", "text", "prefix", "stream", "materialise"].includes(String(name))) reads.push(`${String(name)} ${String(args[0])}`);
          return (value as (...given: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const report = pass(test, root, [], blobs);
    expect(reads).toEqual([]);
    const receipt = JSON.parse(readFileSync(join(directory, "swept.json"), "utf8")) as Receipt;
    expect({ removed: [...receipt.removed].sort(), kept: [...receipt.kept].sort() }).toEqual({
      removed: ["media/altered.jpg", "media/stored.jpg"], kept: ["media/cut.jpg", "media/missing.jpg"],
    });
    expect(readdirSync(lane)).toEqual([sha256(missing)]);
    writeArtifact("swept-unread", { reads, report, receipt });
  });

  it("a delivery in transit kept past the first pass after its import, or one whose import refused a row losing a file", async () => {
    const root = tempDir("sweep-transit");
    const test = openTestHome(root);
    cleanup.push(() => removeDir(root), () => test.close());
    const inbox = join(root, "inbox");
    const EXPORT = "google-activity:person-a@example.com:export";
    const text = Buffer.from("[]");
    const clip = Buffer.from("synthetic clip no record links");
    const imported = sealDelivery(root, EXPORT, "20260901T080000Z", { "activity.json": text, "media/clip.bin": clip }, { transit: true });
    index(test, `${EXPORT}/20260901T080000Z`, [{ source: EXPORT, state: "imported", stated_ms: T0 }]);
    const refused = sealDelivery(root, EXPORT, "20260902T080000Z", { "activity.json": text, "media/clip.bin": Buffer.from("synthetic clip of a delivery with refused rows") }, { transit: true });
    index(test, `${EXPORT}/20260902T080000Z`, [{ source: EXPORT, state: "imported", stated_ms: T0 + DAY, refused: 2 }]);

    const report = await pass(test, root);
    expect(report).toMatchObject({ deliveries: 1, files: 1, bytes: clip.length, kept: 1, unreadable: [] });
    const receipt = JSON.parse(readFileSync(join(imported, "swept.json"), "utf8")) as Receipt;
    expect(receipt).toEqual({ swept_ms: NOW, done: true, removed: ["media/clip.bin"], kept: ["activity.json"] });
    expect(readdirSync(imported).sort()).toEqual(["activity.json", "manifest.json", "swept.json"]);
    expect(test.blobs.has(`sha256:${sha256(clip)}`)).toBe(false);
    expect(readdirSync(refused).sort()).toEqual(["activity.json", "manifest.json", "media"]);
    expect(existsSync(join(refused, "media", "clip.bin"))).toBe(true);
    const left = tree(inbox);
    expect(await pass(test, root)).toMatchObject({ deliveries: 0, files: 0 });
    expect(tree(inbox)).toEqual(left);
    writeArtifact("swept-transit", { report, inbox: left });
  });

  it("an unread transit delivery losing a file before a read clears it, or kept once one has", async () => {
    const root = tempDir("sweep-cleared");
    const test = openTestHome(root);
    cleanup.push(() => removeDir(root), () => test.close());
    const EXPORT = "google-activity:person-a@example.com:export";
    const text = Buffer.from("[]");
    const id = `${EXPORT}/20260902T080000Z`;
    const delivery = sealDelivery(root, EXPORT, "20260902T080000Z", { "activity.json": text, "media/clip.bin": Buffer.from("synthetic clip of an unread delivery") }, { transit: true });
    index(test, id, [{ source: EXPORT, state: "imported", stated_ms: T0, refused: 2 }]);
    const view = test.db.view();
    const refused = view.tables.deliveries.get(id, EXPORT)!.refused;
    view.close();
    expect(refused).toBe(2);
    expect(await pass(test, root)).toMatchObject({ deliveries: 0, files: 0 });
    expect(readdirSync(delivery).sort()).toEqual(["activity.json", "manifest.json", "media"]);
    const kept = tree(join(root, "inbox"));
    test.db.commit((tx) => tx.tables.deliveries.move(id, EXPORT, { move: "reread", code: "sha256:code-2", refused: 0 }));
    expect(await pass(test, root)).toMatchObject({ deliveries: 1, files: 1, kept: 1 });
    expect(readdirSync(delivery).sort()).toEqual(["activity.json", "manifest.json", "swept.json"]);
    writeArtifact("swept-cleared", { refused, kept, cleared: tree(join(root, "inbox")) });
  });

  it("a shipment its sources on imported kept for a source turned off, a transit one swept before that source read it, or one fed only that source keeping what blobs/ holds", async () => {
    const root = tempDir("sweep-off");
    const test = openTestHome(root);
    cleanup.push(() => removeDir(root), () => test.close());
    const inbox = join(root, "inbox");
    const PLACES = "places:person-a@example.com:iphone-aa01";
    const LOCATION = "location:local:iphone-aa01";
    const location = Buffer.from("synthetic location lines");
    const places = Buffer.from("synthetic places lines");
    const unheld = Buffer.from("synthetic lines the store never held");
    for (const bytes of [location, places]) test.blobs.put(bytes);
    const shipment = `sha256:${sha256("synthetic bundle, places off")}`;
    const swept = sealDelivery(root, PHONE, shipment, { "bundle/location.jsonl": location, "bundle/places.jsonl": places, "bundle/notes.jsonl": unheld });
    index(test, `${PHONE}/${shipment}`, [{ source: LOCATION, state: "imported", stated_ms: T0 }, { source: PLACES, state: "sealed", stated_ms: T0 }]);
    const alone = `sha256:${sha256("synthetic bundle only places")}`;
    const aloneDirectory = sealDelivery(root, PHONE, alone, { "bundle/places.jsonl": places });
    index(test, `${PHONE}/${alone}`, [{ source: PLACES, state: "sealed", stated_ms: T0 }]);
    const EXPORT = "google-activity:person-a@example.com:export";
    const COPY = "google-activity:person-a@example.com:copy";
    const transit = sealDelivery(root, EXPORT, "20260901T080000Z", { "activity.json": Buffer.from("[]"), "media/clip.bin": Buffer.from("synthetic clip no record links") }, { transit: true });
    index(test, `${EXPORT}/20260901T080000Z`, [{ source: EXPORT, state: "imported", stated_ms: T0 }, { source: COPY, state: "sealed", stated_ms: T0 }]);

    const before = tree(inbox);
    expect(await pass(test, root)).toMatchObject({ deliveries: 0, files: 0 });
    expect(tree(inbox)).toEqual(before);

    const report = await pass(test, root, [PLACES, COPY]);
    expect(report).toMatchObject({ deliveries: 2, files: 3, kept: 1, unreadable: [] });
    const receipt = JSON.parse(readFileSync(join(swept, "swept.json"), "utf8")) as Receipt;
    expect(receipt).toEqual({ swept_ms: NOW, done: true, removed: ["bundle/location.jsonl", "bundle/places.jsonl"], kept: ["bundle/notes.jsonl"] });
    expect(readdirSync(join(swept, "bundle"))).toEqual(["notes.jsonl"]);
    expect(existsSync(join(swept, "manifest.json"))).toBe(true);
    const view = test.db.view();
    try {
      expect(view.tables.deliveries.get(`${PHONE}/${shipment}`, PLACES)?.state).toBe("sealed");
    } finally {
      view.close();
    }
    expect(test.blobs.has(`sha256:${sha256(places)}`)).toBe(true);
    expect(readdirSync(aloneDirectory).sort()).toEqual(["manifest.json", "swept.json"]);
    expect(readdirSync(transit).sort()).toEqual(["activity.json", "manifest.json", "media"]);
    writeArtifact("swept-off", { report, receipt, inbox: tree(inbox) });
  });

  it("a pass stopped between the receipt and the last removal leaving a delivery the next pass does not finish", async () => {
    const root = tempDir("sweep-crash");
    const test = openTestHome(root);
    const files = { "ChatStorage.sqlite": Buffer.from("synthetic chat database"), "media/a.jpg": Buffer.from("synthetic photo a"), "media/b.jpg": Buffer.from("synthetic photo b") };
    for (const bytes of Object.values(files)) test.blobs.put(bytes);
    const directory = sealDelivery(root, MAC, "20260901T080000Z", files);
    index(test, `${MAC}/20260901T080000Z`, [{ source: MAC, state: "imported", stated_ms: T0 }]);
    const media = join(directory, "media");
    cleanup.push(() => removeDir(root), () => test.close(), () => { if (existsSync(media)) chmodSync(media, 0o755); });

    chmodSync(media, 0o555);
    const stopped = await pass(test, root);
    expect(stopped).toMatchObject({ deliveries: 0, unreadable: [expect.stringContaining(`${MAC}/20260901T080000Z`)] });
    const left = JSON.parse(readFileSync(join(directory, "swept.json"), "utf8")) as Receipt;
    expect(left).toMatchObject({ done: false, removed: Object.keys(files), kept: [] });
    expect(existsSync(join(directory, "ChatStorage.sqlite"))).toBe(false);
    expect(readdirSync(media).sort()).toEqual(["a.jpg", "b.jpg"]);

    chmodSync(media, 0o755);
    expect(await pass(test, root)).toMatchObject({ deliveries: 1, files: 2, kept: 0, unreadable: [] });
    const receipt = JSON.parse(readFileSync(join(directory, "swept.json"), "utf8")) as Receipt;
    expect(receipt).toEqual({ swept_ms: left.swept_ms, done: true, removed: Object.keys(files), kept: [] });
    expect(readdirSync(directory).sort()).toEqual(["manifest.json", "swept.json"]);
    writeArtifact("swept-after-crash", { stopped: left, finished: receipt });
  });
});

describe("the sweep of a plain and of a keyed home", () => {
  it.each(["plain", "keyed"] as const)("a %s home's delivery whose rows are read and whose blobs are held keeping a payload file past the sweep, or a blob it held no longer opening", async (form) => {
    const root = tempDir(`sweep-${form}`);
    const folder = form === "keyed" ? keyedFolder(root) : openHomeFolder(root);
    const test = openTestHome(root, folder);
    cleanup.push(() => removeDir(root), () => test.close());
    const files: Record<string, { bytes: Buffer; mediaType?: string }> = {
      "bundle/health.jsonl": { bytes: Buffer.from(Array.from({ length: 40_000 }, (_, n) => `{"sample":"SYNTH-${n}","unit":"count","value":${n % 97}}\n`).join("")), mediaType: "application/x-ndjson" },
      "bundle/notes.jsonl": { bytes: Buffer.from('{"note":"synthetic small text"}\n'), mediaType: "application/x-ndjson" },
      "media/photo.jpg": { bytes: Buffer.from(Array.from({ length: 5000 }, (_, n) => (n * 2654435761) >>> 24)) },
    };
    const bundle = `sha256:${sha256(`synthetic ${form} bundle`)}`;
    const sealing = openSealing(folder, { source: PHONE, name: bundle, feeder: "synthetic", fetched_at: "2026-09-01T08:00:00.000Z" });
    for (const [file, { bytes }] of Object.entries(files)) sealing.put(file, bytes);
    sealing.seal({});
    const { directory } = sealing;
    for (const [file, { bytes, mediaType }] of Object.entries(files)) {
      await test.blobs.putKept(deliveredFile(folder, directory, file), { expect: `sha256:${sha256(bytes)}`, ...(mediaType === undefined ? {} : { mediaType }) });
    }
    index(test, `${PHONE}/${bundle}`, [{ source: "health:local:iphone-aa01", state: "imported", stated_ms: T0 }]);

    expect(await pass(test, root, [], test.blobs, folder)).toMatchObject({ deliveries: 1, files: 3, kept: 0, unreadable: [] });
    for (const file of Object.keys(files)) expect(deliveredFile(folder, directory, file).exists()).toBe(false);
    const left = readdirSync(directory, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
    expect(left.map((name) => name.replace(/\.k\d+$/u, ""))).toEqual(["manifest.json", "swept.json"]);
    expect(readReceipt(folder, directory)).toMatchObject({ done: true, removed: Object.keys(files), kept: [] });
    for (const { bytes } of Object.values(files)) expect(test.blobs.bytes(`sha256:${sha256(bytes)}`).equals(bytes)).toBe(true);
  });
});

function tgz(members: readonly [string, Buffer][]): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, bytes] of members) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write(`${Math.floor(T0 / 1000).toString(8).padStart(11, "0")}\0`, 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

describe("the sweep's copies of an archive's members on a plain home", () => {
  it("a member named ./a.json not copied where main copied it, its receipt's name not read back beside the import, or a receipt's copied path that is no member failing the read", () => {
    const root = tempDir("sweep-members");
    const folder = openHomeFolder(root);
    const test = openTestHome(root, folder);
    cleanup.push(() => removeDir(root), () => test.close());
    const archive = "files/export/archive.tgz";
    const id = "import/20260901T080001Z";
    const member = Buffer.from('{"title":"synthetic"}');
    const sealing = openSealing(folder, { source: "import", name: "20260901T080001Z", feeder: "synthetic", fetched_at: "2026-09-01T08:00:01.000Z" });
    sealing.put(archive, tgz([["./a.json", member]]));
    sealing.seal({ import: { kind: "whatsapp" }, history: true });
    test.db.commit((tx) => tx.tables.meta.set(`${GONE}${id}`, JSON.stringify([fileOfPath(archive)])));
    const read = <T>(work: (tables: ReadTables) => T): T => {
      const view = test.db.view();
      try {
        return work(view.tables);
      } finally {
        view.close();
      }
    };

    expect(sweepInbox({ folder, read, commit: (work) => test.db.commit(work), blobs: test.blobs, now_ms: NOW, off: [], connectors: declarations() })).toMatchObject({ import_files: 1, unreadable: [] });
    const copied = `members/${archive}/./a.json`;
    const receipt = readReceipt(folder, sealing.directory)!;
    expect(receipt).toMatchObject({ done: true, removed: [archive], copied: [copied] });
    expect(readFileSync(join(sealing.directory, "members", archive, "a.json")).equals(member)).toBe(true);
    writeFileSync(join(sealing.directory, "swept.json"), `${JSON.stringify({ ...receipt, copied: [...receipt.copied!, "members/../../outside.json", "members/x\0y.json"] })}\n`);
    const beside = filesBeside(folder, [{ id, gone: new Set([fileOfPath(archive)]) }]);
    expect(beside.map(({ file }) => file.path)).toEqual([`${id}/${copied}`]);
    expect(beside[0]!.at.read()?.equals(member)).toBe(true);
  });
});

describe("the sweep killed at its receipt", () => {
  it("a home killed after a delivery's receipt and before its first removal losing a file, or leaving a receipt the next pass does not finish; the pass's duration not logged once", async () => {
    const SOURCE = "apple-notes:local:device-a";
    const root = makeRoot("lifestream-sweep-killed-", { sources: { [SOURCE]: "fake-rows" } });
    const child = new ChildHome(root);
    cleanup.push(() => removeRoot(root));
    const sock = testSocket(root);
    const at = Date.now() - 60_000;
    const id = await ship(root, { source: SOURCE, fetched_ms: at, rows: [{ kind: "note", key: "n1", content: { text: "n1", at }, at }] }, false);
    const directory = join(root, "inbox", ...id.split("/"));
    const sweeps = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM events WHERE kind = 'sweep'").pluck().get()) as number;
    const receipt = () => (existsSync(join(directory, "swept.json")) ? JSON.parse(readFileSync(join(directory, "swept.json"), "utf8")) as Receipt : null);

    child.start("sweep.receipt");
    try {
      await child.ready();
      await until("the delivery imported", () => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(id)) === "imported");
      await askHome(sock, "sweep", []).catch(() => undefined);
      expect((await child.exited()).signal).toBe("SIGKILL");
    } finally {
      if (child.alive) await child.stop();
    }
    const atReceipt = receipt();
    expect([atReceipt?.done, atReceipt?.removed, existsSync(join(directory, "rows.ndjson"))]).toEqual([false, ["rows.ndjson"], true]);

    child.start();
    try {
      await child.ready();
      const before = sweeps();
      await askHome(sock, "sweep", []);
      await until("the next pass finished the receipt", () => sweeps() > before);
    } finally {
      await child.stop();
    }
    expect([receipt()?.done, receipt()?.removed, existsSync(join(directory, "rows.ndjson"))]).toEqual([true, ["rows.ndjson"], false]);
    const lines = readFileSync(join(root, "logs", "home.log"), "utf8").split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => "sweep" in line && "ms" in line);
    expect(lines.filter((line) => line.deliveries === 1)).toEqual([{ at: expect.any(String), sweep: expect.any(String), ms: expect.any(Number), deliveries: 1, files: 1, bytes: expect.any(Number) }]);
    writeArtifact("swept-killed-at-receipt", { atReceipt, finished: receipt(), lines });
  });
});
