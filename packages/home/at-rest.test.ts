import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import type { Form } from "@lifestreamprotocol/core";
import { carry, readAtRest, type AtRest, type RestReader, type Run } from "./at-rest.js";
import { stampOf } from "./connectors.js";
import { closeFolders } from "./lifecycle.js";
import { machine } from "./machine.js";
import { looseFound, restFound } from "./status.js";

function plist(members: Record<string, string | boolean>): string {
  const body = Object.entries(members).map(([key, value]) => `\t<key>${key}</key>\n\t${typeof value === "boolean" ? `<${value}/>` : `<string>${value}</string>`}`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;
}

const DATA = plist({ FilesystemType: "apfs", Encryption: true, FileVault: true, GlobalPermissionsEnabled: true, MountPoint: "/System/Volumes/Data" });

function mac(home: string, vault: string, same = false): { reader: RestReader; ran: string[] } {
  const ran: string[] = [];
  const run: Run = async (program, args) => {
    ran.push([program, ...args].join(" "));
    if (program === "df") {
      const device = args[1] === "/home-folder" && !same ? "/dev/disk7s1" : "/dev/disk3s5";
      return { code: 0, out: `Filesystem 512-blocks Used Available Capacity Mounted on\n${device} 100 50 50 50% /Volumes/Somewhere\n` };
    }
    if (program === "diskutil") return { code: 0, out: args[2] === "/dev/disk7s1" ? home : DATA };
    if (program === "fdesetup") return { code: 0, out: vault };
    return { code: 1, out: "" };
  };
  return { reader: { platform: "darwin", run, device: (path) => (path === "/home-folder" && !same ? 7 : 3) }, ran };
}

const read = (reader: RestReader): Promise<AtRest> => readAtRest("/home-folder", "/machine-dir", reader, 1_000);
const ids = (rest: AtRest, form: Form = "plain") => restFound(rest, form).needs.map((need) => [need.id, need.words, need.line]);

describe("the home's disks at rest", () => {
  it("reads an encrypted disk, one not encrypted, an exFAT one, one ignoring ownership, and FileVault on and off", async () => {
    const cases = {
      encrypted: plist({ FilesystemType: "apfs", Encryption: true, FileVault: true, GlobalPermissionsEnabled: true }),
      plain: plist({ FilesystemType: "apfs", Encryption: false, FileVault: false, GlobalPermissionsEnabled: true }),
      exfat: plist({ FilesystemType: "exfat", FilesystemName: "ExFAT" }),
      noOwners: plist({ FilesystemType: "apfs", Encryption: false, FileVault: false, GlobalPermissionsEnabled: false }),
    };
    const found: Record<string, unknown> = {};
    for (const [name, home] of Object.entries(cases)) found[name] = (await read(mac(home, "FileVault is On.\n").reader)).home;
    expect(found).toEqual({
      encrypted: { encrypted: "encrypted", filesystem: "apfs", owners: "kept", volume: "dev:7", why: null },
      plain: { encrypted: "not-encrypted", filesystem: "apfs", owners: "kept", volume: "dev:7", why: null },
      exfat: { encrypted: "not-encrypted", filesystem: "exfat", owners: "ignored", volume: "dev:7", why: null },
      noOwners: { encrypted: "not-encrypted", filesystem: "apfs", owners: "ignored", volume: "dev:7", why: null },
    });
    const on = await read(mac(cases.encrypted, "FileVault is On.\nEncryption in progress: Percent completed = 40\n").reader);
    const off = await read(mac(cases.encrypted, "FileVault is Off.\n").reader);
    expect([on.machine.encrypted, off.machine.encrypted, off.machine.owners, off.same]).toEqual(["encrypted", "not-encrypted", "kept", false]);
  });

  it("raises a need for each disk the person can mend, one for one disk, and none for what it could not tell", async () => {
    const plain = plist({ FilesystemType: "apfs", Encryption: false, GlobalPermissionsEnabled: false });
    expect(ids(await read(mac(plain, "FileVault is Off.\n").reader))).toEqual([
      ["rest:machine", "This Mac's disk isn't encrypted", "Turn on FileVault"],
      ["rest:home", "Lifestream's disk isn't encrypted", "Move Lifestream to an APFS (Encrypted) disk"],
      ["rest:owners", "Other accounts can read Lifestream", "In the disk's Get Info, turn off Ignore ownership"],
    ]);
    expect(ids(await read(mac(plist({ FilesystemType: "exfat" }), "FileVault is On.\n").reader))).toEqual([
      ["rest:home", "Lifestream's disk isn't encrypted", expect.any(String)],
      ["rest:owners", "Other accounts can read Lifestream", "Its ExFAT disk keeps no permissions: move Lifestream to an APFS disk"],
    ]);
    expect(ids(await read(mac(DATA, "FileVault is Off.\n", true).reader)).map(([id]) => id)).toEqual(["rest:machine"]);
    expect(restFound(await read(mac(DATA, "FileVault is On.\n").reader), "plain")).toEqual({ needs: [], notices: [] });
    const silent: RestReader = { platform: "darwin", run: async () => ({ code: 1, out: "" }), device: () => null };
    const unknown = restFound(await read(silent), "plain");
    expect([unknown.needs, unknown.notices.map((notice) => notice.id)]).toEqual([[], ["rest:home:unread", "rest:machine:unread"]]);
    expect(unknown.notices[1]!.what).toMatch(/fdesetup status said neither On nor Off/u);
    expect(restFound(await read(mac(plain, "FileVault is Off.\n").reader), "plain").needs.map((need) => need.since_ms)).toEqual([1_000, 1_000, 1_000]);
  });

  it("on a keyed home, says Lifestream encrypts its files itself and what FileVault still covers; on a disk that is encrypted, nothing", async () => {
    const plain = plist({ FilesystemType: "apfs", Encryption: false, GlobalPermissionsEnabled: false });
    expect(ids(await read(mac(plain, "FileVault is Off.\n").reader), "keyed")).toEqual([
      ["rest:machine", "This Mac's disk isn't encrypted", "Turn on FileVault: Lifestream doesn't encrypt its working copies, temp files, your ChatGPT or Claude sign-in or its logs"],
      ["rest:home", "Lifestream encrypts its files itself", "Move Lifestream to an APFS (Encrypted) disk to cover what was on it before"],
      ["rest:owners", "Other accounts can delete or replace Lifestream's files", "In the disk's Get Info, turn off Ignore ownership"],
    ]);
    expect(ids(await read(mac(plain, "FileVault is On.\n").reader), "keyed").map(([id, words]) => [id, words])).toEqual([
      ["rest:home", "Lifestream encrypts its files itself"],
      ["rest:owners", "Other accounts can delete or replace Lifestream's files"],
    ]);
    expect(ids(await read(mac(DATA, "FileVault is Off.\n", true).reader), "keyed").map(([id, words]) => [id, words])).toEqual([["rest:machine", "This Mac's disk isn't encrypted"]]);
    expect(restFound(await read(mac(DATA, "FileVault is On.\n").reader), "keyed")).toEqual({ needs: [], notices: [] });
    const volume = { encrypted: "not-encrypted" as const, filesystem: "ext4", owners: "kept" as const, why: null };
    const linux: AtRest = { at_ms: 1_000, platform: "linux", home: { ...volume, volume: "dev:1" }, machine: { ...volume, volume: "dev:2" }, same: false, occurrences: {} };
    expect(ids(linux, "keyed")).toEqual([
      ["rest:machine", "This computer's disk isn't encrypted", "Keep your user folder on an encrypted disk: Lifestream doesn't encrypt its working copies, temp files, your ChatGPT or Claude sign-in or its logs"],
      ["rest:home", "Lifestream encrypts its files itself", "Move Lifestream to an encrypted disk to cover what was on it before"],
    ]);
    expect(ids(linux, "plain")).toEqual([
      ["rest:machine", "This computer's disk isn't encrypted", "Keep your user folder on an encrypted disk"],
      ["rest:home", "Lifestream's disk isn't encrypted", "Move Lifestream to an encrypted disk"],
    ]);
  });

  it("on Linux, reads a dm-crypt disk as encrypted, a plain ext4 one as not, and ZFS or another platform as could not tell", async () => {
    const linux = (mounts: Record<string, string>, chains: Record<string, string>): RestReader => ({
      platform: "linux",
      device: (path) => (path === "/home-folder" ? 1 : 2),
      run: async (program, args) => {
        if (program === "findmnt") return { code: 0, out: `${mounts[args.at(-1)!]}\n` };
        if (program === "lsblk") return { code: 0, out: chains[args.at(-1)!] ?? "" };
        return { code: 1, out: "" };
      },
    });
    const rest = await read(linux({ "/home-folder": "/dev/mapper/home ext4", "/machine-dir": "/dev/sda2 ext4" }, { "/dev/mapper/home": "crypt\npart\ndisk\n", "/dev/sda2": "part\ndisk\n" }));
    expect([rest.home, rest.machine]).toEqual([
      { encrypted: "encrypted", filesystem: "ext4", owners: "kept", volume: "dev:1", why: null },
      { encrypted: "not-encrypted", filesystem: "ext4", owners: "kept", volume: "dev:2", why: null },
    ]);
    expect(ids(rest)).toEqual([["rest:machine", "This computer's disk isn't encrypted", expect.any(String)]]);
    const zfs = await read(linux({ "/home-folder": "tank/home zfs", "/machine-dir": "/dev/sdb1 vfat" }, { "/dev/sdb1": "part\ndisk\n" }));
    expect([zfs.home.encrypted, zfs.home.why, zfs.machine]).toEqual(["unknown", "zfs on tank/home: no check of its encryption", { encrypted: "not-encrypted", filesystem: "vfat", owners: "ignored", volume: "dev:2", why: null }]);
    const other = await read({ platform: "win32", run: async () => ({ code: 0, out: "" }), device: () => 1 });
    expect([other.home.encrypted, other.machine.encrypted, restFound(other, "plain").needs]).toEqual(["unknown", "unknown", []]);
  });

  it("names a machine directory's disk that keeps no owners, though both disks are encrypted; one need for one disk", async () => {
    const linux = (machineType: string, same = false): RestReader => ({
      platform: "linux",
      device: (path) => (path === "/home-folder" || same ? 1 : 2),
      run: async (program, args) => {
        if (program === "findmnt") return { code: 0, out: args.at(-1) === "/home-folder" || same ? "/dev/mapper/home ext4\n" : `/dev/mapper/data ${machineType}\n` };
        if (program === "lsblk") return { code: 0, out: "crypt\npart\ndisk\n" };
        return { code: 1, out: "" };
      },
    });
    const rest = await read(linux("vfat"));
    expect([rest.home.encrypted, rest.machine.encrypted, rest.home.owners, rest.machine.owners]).toEqual(["encrypted", "encrypted", "kept", "ignored"]);
    expect(ids(rest)).toEqual([["rest:machine-owners", "Other accounts can read Lifestream's app folder", "Its FAT disk keeps no permissions: set XDG_DATA_HOME to a folder on a Linux disk, then start Lifestream again"]]);
    const ignoring = plist({ FilesystemType: "apfs", Encryption: true, GlobalPermissionsEnabled: false, VolumeUUID: "UUID-DATA" });
    const both: Run = async (program, args) => {
      if (program === "df") return { code: 0, out: `Filesystem\n${args[1] === "/home-folder" ? "/dev/disk7s1" : "/dev/disk3s5"} 1 1 1 1% /x\n` };
      if (program === "diskutil") return { code: 0, out: args[2] === "/dev/disk7s1" ? DATA : ignoring };
      return { code: 0, out: "FileVault is On.\n" };
    };
    const onMac = await read({ platform: "darwin", run: both, device: (path) => (path === "/home-folder" ? 7 : 3) });
    expect(ids(onMac)).toEqual([["rest:machine-owners", "Other accounts can read Lifestream's app folder", "In the disk's Get Info, turn off Ignore ownership"]]);
    expect(ids(await read(linux("ext4", true)))).toEqual([]);
    const oneFat: RestReader = { ...linux("vfat"), device: () => 1, run: async (program) => ({ code: 0, out: program === "findmnt" ? "/dev/sdb1 vfat\n" : "part\ndisk\n" }) };
    expect(ids(await read(oneFat)).map(([id]) => id)).toEqual(["rest:machine", "rest:owners"]);
  });

  it("holds a dismissal while its occurrence stands, and shows it again once it resolved and came back, or moved to another disk", async () => {
    const reading = (uuid: string, ignored: boolean, at: number, was: AtRest | null): Promise<AtRest> => {
      const home = plist({ FilesystemType: "apfs", Encryption: true, GlobalPermissionsEnabled: !ignored, VolumeUUID: uuid });
      return readAtRest("/home-folder", "/machine-dir", mac(home, "FileVault is On.\n").reader, at, was);
    };
    const owners = (rest: AtRest) => restFound(rest, "plain").needs.find((need) => need.id === "rest:owners");
    const first = await reading("UUID-A", true, 1_000, null);
    expect([first.home.volume, first.occurrences]).toEqual(["UUID-A", { "rest:owners": { volume: "UUID-A", since_ms: 1_000 } }]);
    const dismissed = stampOf(owners(first)!);
    const again = await reading("UUID-A", true, 2_000, first);
    expect(stampOf(owners(again)!)).toBe(dismissed);
    const fixed = await reading("UUID-A", false, 3_000, again);
    expect([owners(fixed), fixed.occurrences]).toEqual([undefined, {}]);
    const back = await reading("UUID-A", true, 4_000, fixed);
    expect([owners(back)!.since_ms, stampOf(owners(back)!) === dismissed]).toEqual([4_000, false]);
    const moved = await reading("UUID-B", true, 5_000, again);
    expect([owners(moved)!.since_ms, stampOf(owners(moved)!) === dismissed]).toEqual([5_000, false]);
    expect(carry(again, again)).toEqual(again);
  });
});

describe("the start's closing of a loose folder", () => {
  it("makes a home folder and a machine directory other accounts can enter 0700, and leaves one already closed as it is", () => {
    const root = mkdtempSync(join(tmpdir(), "lifestream-close-"));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const folder = join(root, "home");
    const dir = join(root, "machine");
    mkdirSync(folder);
    mkdirSync(join(folder, "blobs"));
    mkdirSync(dir);
    chmodSync(folder, 0o755);
    chmodSync(join(folder, "blobs"), 0o755);
    chmodSync(dir, 0o711);
    const at = machine({ env: { LIFESTREAM_MACHINE_DIR: dir }, home: join(root, "user") });
    expect(closeFolders(folder, at)).toEqual({ closed: [folder, dir], loose: [] });
    expect([statSync(folder).mode & 0o777, statSync(dir).mode & 0o777, statSync(join(folder, "blobs")).mode & 0o777]).toEqual([0o700, 0o700, 0o755]);
    expect(closeFolders(folder, at)).toEqual({ closed: [], loose: [] });
    expect(closeFolders(join(root, "gone"), at)).toEqual({ closed: [], loose: [] });
  });

  it("names a folder it cannot close, with the command that closes it, on a disk that is encrypted and keeps owners", async () => {
    const at = machine({ env: { LIFESTREAM_MACHINE_DIR: "/machine-dir" }, home: "/user" });
    const modes = new Map([["/home-folder", 0o755], ["/machine-dir", 0o700]]);
    const refused = (code: string) => ({
      mode: (path: string) => modes.get(path)!,
      chmod: () => {
        throw Object.assign(new Error(`${code}: operation not permitted`), { code });
      },
    });
    const { closed, loose } = closeFolders("/home-folder", at, refused("EPERM"));
    expect([closed, loose]).toEqual([[], [{ which: "home", path: "/home-folder", why: "owner" }]]);
    expect(restFound(await read(mac(DATA, "FileVault is On.\n").reader), "plain").needs).toEqual([]);
    const owned = `sudo chown "$USER" "/home-folder" && chmod 700 "/home-folder"`;
    expect(looseFound(loose, true, (path) => modes.get(path)!).map((need) => [need.id, need.words, need.line, need.acts, need.detail])).toEqual([[
      "loose:home", "Other accounts can open Lifestream's folder", "Run the fix in Terminal", [{ do: "copy", label: "Copy fix", text: owned }], owned,
    ]]);
    const other = closeFolders("/home-folder", at, refused("EROFS")).loose;
    expect(looseFound(other, true, (path) => modes.get(path)!).map((need) => need.acts)).toEqual([[{ do: "copy", label: "Copy fix", text: `chmod 700 "/home-folder"` }]]);
    modes.set("/home-folder", 0o700);
    expect(looseFound(loose, true, (path) => modes.get(path)!)).toEqual([]);
  });
});
