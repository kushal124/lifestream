import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { blobSealing, fileData, SEGMENT, sealWhole } from "../packages/core/sealed.js";
import { inventory, runInventory, SQLITE_HEADER, type Inventory, type Tree } from "./inventory.js";

const CANARY = "ZQX-CANARY-message-7f3a";
const OTHER = "ZQX-CANARY-photo-91c2";
const KEY = randomBytes(32);
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function trees(): { folder: string; machine: string; spool: string; put: (tree: Tree, path: string, bytes: Buffer | string) => void } {
  const top = mkdtempSync(join(tmpdir(), "ls-inventory-"));
  temps.push(top);
  const folder = join(top, "home");
  const machine = join(top, "machine");
  const spool = join(top, "spool");
  mkdirSync(folder);
  mkdirSync(machine);
  mkdirSync(spool);
  return {
    folder, machine, spool,
    put: (tree, path, bytes) => {
      const file = join({ folder, machine, spool }[tree], path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    },
  };
}

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const keyedStore = (bytes = 4096) => Buffer.concat([Buffer.from([0x9c]), randomBytes(bytes - 1)]);
const sealedBlob = (plain: string) => sealWhole(Buffer.concat([Buffer.from(plain), createHash("sha256").update(plain).digest()]), blobSealing(KEY), "a blob");
const sealedFile = (role: string, name: string, plain: string) => sealWhole(Buffer.from(plain), { key: KEY, associatedData: fileData(role, name), segment: SEGMENT }, name);
const plainSqlite = () => Buffer.concat([SQLITE_HEADER, Buffer.alloc(4080)]);
const flagsOf = (report: Inventory) => report.flags.map((flag) => `${flag.kind} ${flag.tree}:${flag.path}`).sort();
const classOf = (report: Inventory, path: string) => report.files.find((file) => file.path === path)?.class;
const MAC_WRITTEN = new URL("../packages/core/sealed-vectors/mac/", import.meta.url);
const macFile = (name: string) => readFileSync(new URL(name, MAC_WRITTEN));
const MAC_WHOLE = macFile("mac-file-132000.bin");
const MAC_SMALL = macFile("mac-file-1.bin");
const MAC_LOG = macFile("mac-log.bin");
const KEYED_NAME = sha("a keyed name");
const KEYED_SOURCE = sha("a keyed source id");

function macTrees(at: ReturnType<typeof trees>): void {
  at.put("machine", "mac-files.json", JSON.stringify({ form: "keyed", key: "0a1b2c3d" }));
  at.put("spool", ".writer.lock", "");
  at.put("spool", "runtime.json", JSON.stringify({ state: "recording" }));
  at.put("spool", "resources/app-2026-11-18.jsonl", MAC_LOG);
  at.put("spool", "resources/diagnostics-2026-11-18.jsonl", "{\"ms\":3}\n");
  at.put("spool", "2026-11-18/bundle-1/observation.lsm", MAC_SMALL);
  at.put("spool", ".video/segment-1.mov", MAC_WHOLE);
  at.put("spool", ".video/.open-segment-2/samples", MAC_LOG);
  at.put("spool", "input-events/current.jsonl", MAC_LOG.subarray(0, 33));
  at.put("spool", "machine-events/current.jsonl", MAC_LOG.subarray(0, MAC_LOG.length - 5));
  for (const name of ["credentials", "answer", "schedule", "settings", "settings-queue", "reach", "stores"]) at.put("machine", `ship/${name}.json`, MAC_SMALL);
  at.put("machine", `ship/ledger/p-1/${KEYED_SOURCE}.json`, MAC_SMALL);
  at.put("machine", `ship/ledger/p-1/${KEYED_SOURCE}/memory-chat`, plainSqlite());
  at.put("machine", `ship/ledger/p-1/${KEYED_SOURCE}/memory-chat-wal`, Buffer.alloc(64));
  at.put("machine", `ship/photos/${KEYED_SOURCE}/entries.sqlite`, plainSqlite());
  at.put("machine", `ship/photos/${KEYED_SOURCE}/blobs/${KEYED_NAME}`, MAC_WHOLE);
  at.put("machine", "ship/pending/bundle-1.zip", MAC_WHOLE);
}

function cleanHome() {
  const at = trees();
  at.put("folder", "HOME.json", JSON.stringify({ id: "home-aa01" }));
  at.put("folder", "home.lock", plainSqlite());
  at.put("folder", "home.lock-journal", "");
  at.put("folder", "replies/calls.lock", plainSqlite());
  at.put("folder", "door/streams.lock", plainSqlite());
  at.put("folder", "home.db", keyedStore());
  at.put("folder", "home.db-wal", keyedStore(8192));
  at.put("folder", "home.db-shm", keyedStore(32768));
  at.put("folder", "replies/replies.db", keyedStore());
  at.put("folder", "door/stated.db", keyedStore());
  at.put("folder", "config/vault.json", JSON.stringify({ version: 2 }));
  at.put("folder", "config/settings.json", "{}");
  at.put("folder", "config/stores.json", "{}");
  at.put("folder", "config/door-tls.pem", "synthetic pem");
  at.put("folder", "logs/home.log", "{\"home\":\"started\"}\n");
  at.put("folder", "connectors/example/index.js", "export default {};\n");
  at.put("folder", `blobs/k1/ab/cd/${sha("an hmac name")}`, sealedBlob(OTHER));
  at.put("folder", `replies/blobs/k1/ef/01/${sha("another hmac name")}`, sealedBlob(CANARY));
  at.put("folder", "inbox/phone:synthetic-iphone-5a49/20260831T100001Z/rows.ndjson.k1", sealedFile("inbox", "rows.ndjson", CANARY));
  at.put("folder", "days/2026-08-31.day.txt.k1", sealedFile("day", "2026-08-31", `${CANARY}\n`.repeat(4000)));
  at.put("machine", "run/door-token", "synthetic-token");
  at.put("machine", "vaults/home-aa01.json", "{}");
  at.put("machine", "codex/auth.json", "{}");
  at.put("machine", "search/home-aa01/index.db", keyedStore());
  at.put("machine", "search/home-aa01/screen.db-wal", keyedStore());
  at.put("machine", "privacy/home-aa01/marks.db", keyedStore());
  at.put("machine", "places/home-aa01/memo.db", keyedStore());
  at.put("machine", "faces/home-aa01/memo.db", keyedStore());
  return at;
}

describe("the inventory of a home's folder and its machine directory", () => {
  it("classes every file of a clean keyed home and flags nothing, a canary in scratch included", () => {
    const at = cleanHome();
    at.put("machine", "scratch/caption-7/IMG_1.JPG", `jpeg ${OTHER}`);
    const report = inventory({ folder: at.folder, machine: at.machine, canaries: [CANARY, OTHER] });
    expect(report.flags).toEqual([]);
    expect(report.counts).toEqual({ "keyed-store": 10, sealed: 4, "mac-encrypted": 0, plain: 14, scratch: 1, unclassified: 0 });
    expect(report.scratch).toEqual(["scratch/caption-7/IMG_1.JPG"]);
    expect(report.files.find((file) => file.path === "scratch/caption-7/IMG_1.JPG")?.canaries).toEqual([OTHER]);
    expect([classOf(report, "home.db-wal"), classOf(report, "days/2026-08-31.day.txt.k1"), classOf(report, "home.lock"), classOf(report, "logs/home.log")])
      .toEqual(["keyed-store", "sealed", "plain", "plain"]);
  });

  it("flags a canary outside scratch, a SQLite header but on a lock file, a blob named by its SHA-256 and an unclassified file", () => {
    const at = cleanHome();
    const photo = Buffer.from(`synthetic jpeg ${OTHER}`);
    at.put("folder", "logs/home.log", `{"fault":"${CANARY}"}\n`);
    at.put("folder", "replies/replies.db", plainSqlite());
    at.put("folder", `blobs/${sha(photo).slice(0, 2)}/${sha(photo).slice(2, 4)}/${sha(photo)}`, photo);
    at.put("folder", `blobs/k1/aa/bb/${sha(photo)}`, sealedBlob("a photo sealed but named by its identity"));
    at.put("folder", "days/2026-09-01.day.txt.k1", Buffer.from(`plain day ${CANARY}`));
    at.put("folder", "door/uploads/upload-1.part", "a cut upload's first bytes");
    at.put("machine", "stray.json", "{}");
    at.put("machine", "scratch/sqlite/etilqs_1", plainSqlite());
    const report = inventory({ folder: at.folder, machine: at.machine, canaries: [CANARY, OTHER], blobs: [`sha256:${sha(photo)}`] });
    expect(flagsOf(report)).toEqual([
      `canary folder:blobs/${sha(photo).slice(0, 2)}/${sha(photo).slice(2, 4)}/${sha(photo)}`,
      "canary folder:days/2026-09-01.day.txt.k1",
      "canary folder:logs/home.log",
      `hash-named-blob folder:blobs/${sha(photo).slice(0, 2)}/${sha(photo).slice(2, 4)}/${sha(photo)}`,
      `hash-named-blob folder:blobs/k1/aa/bb/${sha(photo)}`,
      "sqlite-header folder:replies/replies.db",
      `unclassified folder:blobs/${sha(photo).slice(0, 2)}/${sha(photo).slice(2, 4)}/${sha(photo)}`,
      "unclassified folder:days/2026-09-01.day.txt.k1",
      "unclassified folder:door/uploads/upload-1.part",
      "unclassified folder:replies/replies.db",
      "unclassified machine:stray.json",
    ].sort());
    expect(report.files.find((file) => file.path === "days/2026-09-01.day.txt.k1")?.why).toMatch(/a sealed name, but its first byte is 112/u);
    expect(classOf(report, `blobs/k1/aa/bb/${sha(photo)}`)).toBe("sealed");
    expect(report.scratch).toEqual(["scratch/sqlite/etilqs_1"]);
  });

  it("keeps plain the Mac's code, command record and release lock, and nothing of its shipping state", () => {
    const at = cleanHome();
    at.put("folder", "connectors/.installed.json", JSON.stringify({ example: { from: "/tmp/example", ids: ["example"] } }));
    at.put("machine", "extension/manifest.json", "{}");
    at.put("machine", "extension/assets/background.js", "export {};\n");
    for (const name of ["credentials", "schedule", "settings", "settings-queue", "reach", "stores", "answer"]) at.put("machine", `ship/${name}.json`, "{}");
    at.put("machine", "command.json", "{}");
    at.put("machine", "release.lock", plainSqlite());
    at.put("machine", "ship/ledger/p-1/machine_local_unit-a.json", "{}");
    const report = inventory({ folder: at.folder, machine: at.machine });
    expect(flagsOf(report)).toEqual(["credentials", "schedule", "settings", "settings-queue", "reach", "stores", "answer"].map((name) => `unclassified machine:ship/${name}.json`)
      .concat("unclassified machine:ship/ledger/p-1/machine_local_unit-a.json").sort());
    expect(["connectors/.installed.json", "extension/assets/background.js", "command.json", "release.lock"].map((path) => classOf(report, path))).toEqual(["plain", "plain", "plain", "plain"]);
  });

  it("classes a keyed Mac's spool and shipping folder, written by the Mac's own code, as encrypted, with section 5's plain rows and SQLite files beside them", () => {
    const at = cleanHome();
    macTrees(at);
    const report = inventory({ folder: at.folder, machine: at.machine, spool: at.spool, canaries: [CANARY, OTHER] });
    expect(report.flags).toEqual([]);
    expect(report.spool).toBe(at.spool);
    const mac = report.files.filter((file) => file.tree === "spool" || file.path.startsWith("ship/") || file.path === "mac-files.json");
    expect(Object.fromEntries(mac.map((file) => [`${file.tree}:${file.path}`, file.class]))).toEqual({
      "machine:mac-files.json": "plain",
      ...Object.fromEntries(["answer", "credentials", "reach", "schedule", "settings", "settings-queue", "stores"].map((name) => [`machine:ship/${name}.json`, "mac-encrypted"])),
      [`machine:ship/ledger/p-1/${KEYED_SOURCE}.json`]: "mac-encrypted",
      [`machine:ship/ledger/p-1/${KEYED_SOURCE}/memory-chat`]: "plain",
      [`machine:ship/ledger/p-1/${KEYED_SOURCE}/memory-chat-wal`]: "plain",
      [`machine:ship/photos/${KEYED_SOURCE}/entries.sqlite`]: "plain",
      [`machine:ship/photos/${KEYED_SOURCE}/blobs/${KEYED_NAME}`]: "mac-encrypted",
      "machine:ship/pending/bundle-1.zip": "mac-encrypted",
      "spool:.writer.lock": "plain",
      "spool:runtime.json": "plain",
      "spool:resources/app-2026-11-18.jsonl": "mac-encrypted",
      "spool:resources/diagnostics-2026-11-18.jsonl": "plain",
      "spool:2026-11-18/bundle-1/observation.lsm": "mac-encrypted",
      "spool:.video/segment-1.mov": "mac-encrypted",
      "spool:.video/.open-segment-2/samples": "mac-encrypted",
      "spool:input-events/current.jsonl": "mac-encrypted",
      "spool:machine-events/current.jsonl": "mac-encrypted",
    });
  });

  it("flags a plain or damaged Mac file, a home's sealed name in the Mac's folders, a SQLite file no row names, a source id in a path and a blob named by its SHA-256", () => {
    const at = cleanHome();
    macTrees(at);
    const photo = Buffer.from(`synthetic jpeg ${OTHER}`);
    const handle = "person-a@example.com";
    at.put("spool", "2026-11-18/bundle-2/observation.lsm", `{"title":"${CANARY}"}`);
    at.put("spool", "app-modes.json", "{}");
    at.put("spool", "resources/powerlog/cursor.json", "{}");
    at.put("spool", ".video/segment-3.mov", MAC_WHOLE.subarray(0, 50));
    const torn = Buffer.from(MAC_LOG);
    torn.writeUInt32BE(8, 33);
    at.put("spool", "input-events/batch-1.jsonl", torn);
    at.put("machine", "ship/hash-cache/screen.json.k1", MAC_SMALL);
    at.put("machine", "ship/carried/backups/messages.db", plainSqlite());
    at.put("machine", `ship/ledger/p-1/messages_${handle}.json`, MAC_SMALL);
    at.put("machine", `ship/photos/${KEYED_SOURCE}/blobs/${sha(photo)}`, MAC_WHOLE);
    const report = inventory({ folder: at.folder, machine: at.machine, spool: at.spool, canaries: [CANARY, handle], blobs: [sha(photo)] });
    expect(flagsOf(report)).toEqual([
      "canary spool:2026-11-18/bundle-2/observation.lsm",
      `canary machine:ship/ledger/p-1/messages_${handle}.json`,
      `hash-named-blob machine:ship/photos/${KEYED_SOURCE}/blobs/${sha(photo)}`,
      "sqlite-header machine:ship/carried/backups/messages.db",
      "unclassified machine:ship/carried/backups/messages.db",
      "unclassified machine:ship/hash-cache/screen.json.k1",
      "unclassified spool:.video/segment-3.mov",
      "unclassified spool:2026-11-18/bundle-2/observation.lsm",
      "unclassified spool:app-modes.json",
      "unclassified spool:input-events/batch-1.jsonl",
      "unclassified spool:resources/powerlog/cursor.json",
    ].sort());
    expect(report.files.find((file) => file.path === "input-events/batch-1.jsonl")?.why).toMatch(/record 0 is shorter than its nonce and tag/u);
    expect(report.files.find((file) => file.path === `ship/ledger/p-1/messages_${handle}.json`)?.class).toBe("mac-encrypted");
  });

  it("finds a canary that straddles two reads of a file", () => {
    const at = trees();
    at.put("folder", "notes.bin", Buffer.concat([Buffer.alloc(1024 * 1024 - 5, 0x61), Buffer.from(CANARY), Buffer.alloc(10, 0x61)]));
    const report = inventory({ folder: at.folder, machine: at.machine, canaries: [CANARY] });
    expect(report.files[0]).toMatchObject({ path: "notes.bin", class: "unclassified", canaries: [CANARY] });
  });

  it("flags a socket left under the folder but not one under the machine's run/", async () => {
    const at = trees();
    const sockets = [join(at.folder, "home.sock"), join(at.machine, "run", "home.sock")];
    mkdirSync(join(at.machine, "run"));
    const servers = await Promise.all(sockets.map((path) => new Promise<Server>((resolve) => {
      const server = createServer();
      server.listen(path, () => resolve(server));
    })));
    try {
      expect(flagsOf(inventory({ folder: at.folder, machine: at.machine }))).toEqual(["unclassified folder:home.sock"]);
    } finally {
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    }
  });

  it("prints its report as JSON and exits 0 when clean, 1 on a flag, 2 on a wrong call", () => {
    const at = cleanHome();
    const printed: string[] = [];
    const failed: string[] = [];
    const args = ["--folder", at.folder, "--machine", at.machine, "--canary", CANARY];
    expect(runInventory(args, (line) => printed.push(line), (line) => failed.push(line))).toBe(0);
    expect((JSON.parse(printed.at(-1)!) as Inventory).flags).toEqual([]);
    at.put("folder", "notes.txt", CANARY);
    expect(runInventory(args, (line) => printed.push(line), (line) => failed.push(line))).toBe(1);
    expect(flagsOf(JSON.parse(printed.at(-1)!) as Inventory)).toEqual(["canary folder:notes.txt", "unclassified folder:notes.txt"]);
    expect(runInventory(["--folder", at.folder], (line) => printed.push(line), (line) => failed.push(line))).toBe(2);
    expect(runInventory(["--folder", at.folder, "--machine", at.machine, "--sideways"], (line) => printed.push(line), (line) => failed.push(line))).toBe(2);
    expect(failed.every((line) => line.includes("usage: npx tsx tools/inventory.ts"))).toBe(true);
  });
});
