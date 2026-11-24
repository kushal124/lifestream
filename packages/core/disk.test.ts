import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { BOTTOM_BYTES, diskSpace, fits, freeOf, KEEP_BYTES, lineOf, roomAt, roomOf, spare } from "./disk.js";

describe("the rule for space", () => {
  it("names a disk ok at 5 GB free, low under it, full under 1 GB, and an unknown reading low", () => {
    expect([KEEP_BYTES, BOTTOM_BYTES]).toEqual([5_000_000_000, 1_000_000_000]);
    expect([6e9, 5e9, 5e9 - 1, 4e9, 1e9, 1e9 - 1, 0.5e9, 0, null].map(roomOf))
      .toEqual(["ok", "ok", "low", "low", "low", "full", "full", "full", "low"]);
  });

  it("fits a later write that leaves 5 GB free and a new one that leaves 1 GB; an unknown reading takes new data, never later", () => {
    expect([lineOf("later"), lineOf("new")]).toEqual([KEEP_BYTES, BOTTOM_BYTES]);
    expect([fits(6e9, "later", 1e9), fits(6e9, "later", 1e9 + 1), fits(2e9, "new", 1e9), fits(2e9, "new", 1e9 + 1)]).toEqual([true, false, true, false]);
    expect([fits(4e9, "later", 0), fits(4e9, "new", 2e9), fits(0.5e9, "new", 0)]).toEqual([false, true, false]);
    expect([fits(null, "new", 1e12), fits(null, "later", 0)]).toEqual([true, false]);
  });

  it("reads a test's stated disk, a number or a file it moves, and a path that is not there as unknown", () => {
    const dir = mkdtempSync(join(tmpdir(), "lifestream-disk-"));
    const before = process.env.LIFESTREAM_TEST_FREE!;
    onTestFinished(() => {
      process.env.LIFESTREAM_TEST_FREE = before;
      rmSync(dir, { recursive: true, force: true });
    });
    process.env.LIFESTREAM_TEST_FREE = "6000000000";
    expect([diskSpace(dir).free_bytes, roomAt(dir)]).toEqual([6e9, "ok"]);
    const file = join(dir, "free");
    process.env.LIFESTREAM_TEST_FREE = file;
    const read = [4e9, 0.5e9].map((bytes) => {
      writeFileSync(file, `${bytes}\n`);
      return [freeOf(dir), roomAt(dir)];
    });
    expect(read).toEqual([[4e9, "low"], [0.5e9, "full"]]);
    expect(diskSpace(dir).total_bytes).toBeGreaterThan(0);
    expect([freeOf(join(dir, "gone")), roomAt(join(dir, "gone"))]).toEqual([null, "low"]);
  });

  it("takes of what can be fetched later only what is free above 5 GB", () => {
    expect([spare(6e9), spare(KEEP_BYTES), spare(4e9)]).toEqual([1e9, 0, 0]);
  });
});
