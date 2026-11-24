import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { makeUnder, writeDurably } from "./disk.js";
import { openHomeFolder, type StoreKind } from "./home-folder.js";

const KIND: StoreKind = { role: "owner", remade: false };
const truthAt = (path: string, open: { mustExist?: boolean } = {}) => openHomeFolder(dirname(path)).store(KIND, path, open);
const cacheAt = (path: string) => openHomeFolder(dirname(path)).store(KIND, path, { sync: "NORMAL" });
const modeOf = (path: string): number => statSync(path).mode & 0o777;

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "lifestream-owner-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let was = 0;
beforeAll(() => {
  was = process.umask(0o022);
});
afterAll(() => {
  process.umask(was);
});

describe("owner only", () => {
  it("makes a home's directories 0700 and its files 0600, a caller's own mode kept", () => {
    const root = folder();
    makeUnder(root, join(root, "a", "b"));
    writeDurably(join(root, "a", "file.json"), "{}\n");
    makeUnder(root, join(root, "shared"), 0o750);
    writeDurably(join(root, "shared", "named"), "x", 0o640);
    expect([modeOf(join(root, "a")), modeOf(join(root, "a", "b")), modeOf(join(root, "a", "file.json"))]).toEqual([0o700, 0o700, 0o600]);
    expect([modeOf(join(root, "shared")) & ~0o750, modeOf(join(root, "shared", "named")) & ~0o640]).toEqual([0, 0]);
  });

  it("installs a blob 0400 in 0700 folders of the store", async () => {
    const root = folder();
    const store = openHomeFolder(root).blobs(join(root, "blobs"));
    const hash = store.put(Buffer.from("a synthetic photo"));
    const streamed = await store.putChunks(async function* () { yield Buffer.from("a synthetic recording"); }, 21);
    for (const each of [hash, streamed]) {
      const hex = each.slice("sha256:".length);
      const shard = join(root, "blobs", hex.slice(0, 2));
      expect([modeOf(shard), modeOf(join(shard, hex.slice(2, 4))), modeOf(join(shard, hex.slice(2, 4), hex))]).toEqual([0o700, 0o700, 0o400]);
    }
    expect(modeOf(join(root, "blobs"))).toBe(0o700);
    expect(store.bytes(hash).toString()).toBe("a synthetic photo");
  });

  it("makes a SQLite store, its log and its shared memory 0600, and leaves one that is there as it is", () => {
    const root = folder();
    for (const [name, open] of [["truth.db", truthAt], ["cache.db", cacheAt]] as const) {
      const db = open(join(root, name));
      db.exec("CREATE TABLE t (x); INSERT INTO t VALUES (1)");
      expect([name, ...["", "-wal", "-shm"].map((end) => modeOf(join(root, `${name}${end}`)))]).toEqual([name, 0o600, 0o600, 0o600]);
      db.close();
    }
    expect(() => truthAt(join(root, "absent.db"), { mustExist: true })).toThrow();
    expect(existsSync(join(root, "absent.db"))).toBe(false);
    expect(() => truthAt(join(root, "none", "x.db"))).toThrow(/Cannot open database because the directory does not exist/u);
  });

  it("makes a store made looser before, and its log and shared memory, 0600 at its next open", () => {
    const root = folder();
    const path = join(root, "old.db");
    const made = truthAt(path);
    made.exec("CREATE TABLE t (x); INSERT INTO t VALUES (1)");
    made.close();
    writeFileSync(`${path}-wal`, "");
    writeFileSync(`${path}-shm`, "");
    for (const end of ["", "-wal", "-shm"]) chmodSync(`${path}${end}`, 0o644);
    const db = truthAt(path, { mustExist: true });
    expect([db.prepare("SELECT x FROM t").pluck().get(), ...["", "-wal", "-shm"].map((end) => modeOf(`${path}${end}`))]).toEqual([1, 0o600, 0o600, 0o600]);
    db.close();
  });

  it("sets the mask of the program that asks it, so a file made with the system's default mode is its owner's alone", () => {
    const root = folder();
    mkdirSync(join(root, "out"));
    const disk = fileURLToPath(new URL("./disk.ts", import.meta.url));
    const script = `import { ownerOnly } from ${JSON.stringify(disk)}; import { mkdirSync, writeFileSync } from "node:fs";
      ownerOnly(); writeFileSync(${JSON.stringify(join(root, "out", "file"))}, "x"); mkdirSync(${JSON.stringify(join(root, "out", "dir"))});`;
    const ran = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8" });
    expect([ran.status, ran.stderr]).toEqual([0, ""]);
    expect([modeOf(join(root, "out", "file")), modeOf(join(root, "out", "dir"))]).toEqual([0o600, 0o700]);
  });
});
