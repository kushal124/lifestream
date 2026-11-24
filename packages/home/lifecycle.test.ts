import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { adopt, placeRefusal } from "./lifecycle.js";
import { machine } from "./machine.js";
import { effective, runsAt } from "./settings.js";
import { madeStart } from "./start.js";

function place() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lifestream-place-")));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return { at: machine({ env: { LIFESTREAM_MACHINE_DIR: join(root, "machine") }, home: join(root, "user") }), folder: join(root, "home") };
}

const notApfs = (folder: string, type: string) => `${folder} is on a ${type} disk; Lifestream needs APFS: format the disk APFS in Disk Utility`;

describe("a home's disk", () => {
  it("on a Mac, refuses a disk that is not APFS, or one whose file system is not known, and takes APFS", () => {
    const { at, folder } = place();
    expect(placeRefusal(folder, at, () => "hfs", "darwin")).toBe(notApfs(folder, "hfs"));
    expect(placeRefusal(folder, at, () => "exfat", "darwin")).toBe(notApfs(folder, "exfat"));
    expect(placeRefusal(folder, at, () => null, "darwin")).toBe(notApfs(folder, "unknown"));
    expect(placeRefusal(folder, at, () => "apfs", "darwin")).toBeNull();
    expect(placeRefusal(folder, at, () => "smbfs", "darwin")).toMatch(/is on a network volume \(smbfs\)/u);
  });

  it("on Linux, asks nothing of the file system but that it is local", () => {
    const { at, folder } = place();
    for (const type of ["ext4", "xfs", "btrfs", null]) expect(placeRefusal(folder, at, () => type, "linux")).toBeNull();
    expect(placeRefusal(folder, at, () => "nfs", "linux")).toMatch(/is on a network volume \(nfs\)/u);
  });

  it("adopt refuses a Mac's disk that is not APFS in move's words and makes nothing; on Linux it adopts the same folder", async () => {
    const { at, folder } = place();
    await expect(adopt(folder, { machine: at, fileSystem: () => "hfs", platform: "darwin" })).rejects.toThrow(notApfs(folder, "hfs"));
    expect(existsSync(folder)).toBe(false);
    expect((await adopt(folder, { machine: at, fileSystem: () => "ext4", platform: "linux" })).as).toBe("new");
  });
});

describe("a new home's start", () => {
  it("a home is made holding the day six months before the day it is made, in its own zone, and a new home's settings read it", async () => {
    const { at, folder } = place();
    const now = Date.UTC(2026, 10, 19, 12);
    await adopt(folder, { machine: at, fileSystem: () => "ext4", platform: "linux", now: () => now });
    const day = { zone: at.zone, day_start_hour: runsAt(null, "day.day_start_hour") as number };
    expect(runsAt(folder, "history.start")).toBe(madeStart(now, day));
    expect(madeStart(now, day)).toMatch(/^2026-05-(18|19|20)$/u);
    expect(effective(folder).settings.history).toEqual({ start: madeStart(now, day) });
  });
});
