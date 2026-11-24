import { execFile } from "node:child_process";
import { statSync } from "node:fs";


export type Encrypted = "encrypted" | "not-encrypted" | "unknown";
export type Owners = "kept" | "ignored" | "unknown";

export interface VolumeRest {
  encrypted: Encrypted;
  filesystem: string | null;
  owners: Owners;
  volume: string | null;
  why: string | null;
}

export type RestCondition = "rest:machine" | "rest:home" | "rest:owners" | "rest:machine-owners";

export interface Occurrence {
  volume: string | null;
  since_ms: number;
}

export interface AtRest {
  at_ms: number;
  platform: string;
  home: VolumeRest;
  machine: VolumeRest;
  same: boolean;
  occurrences: Partial<Record<RestCondition, Occurrence>>;
}

export function restConditions(rest: Omit<AtRest, "occurrences">): Map<RestCondition, string | null> {
  const found = new Map<RestCondition, string | null>();
  if (rest.machine.encrypted === "not-encrypted") found.set("rest:machine", rest.machine.volume);
  if (!rest.same && rest.home.encrypted === "not-encrypted") found.set("rest:home", rest.home.volume);
  if (rest.home.owners === "ignored") found.set("rest:owners", rest.home.volume);
  if (!rest.same && rest.machine.owners === "ignored") found.set("rest:machine-owners", rest.machine.volume);
  return found;
}

export function carry(rest: Omit<AtRest, "occurrences">, was: AtRest | null): AtRest {
  const occurrences: AtRest["occurrences"] = {};
  for (const [condition, volume] of restConditions(rest)) {
    const before = was?.occurrences[condition];
    occurrences[condition] = before !== undefined && before.volume === volume ? before : { volume, since_ms: rest.at_ms };
  }
  return { ...rest, occurrences };
}

export const AT_REST_META = "at-rest";

export type Run = (program: string, args: readonly string[]) => Promise<{ code: number | null; out: string }>;

export interface RestReader {
  platform: NodeJS.Platform;
  run: Run;
  device(path: string): number | null;
}

const RUN_MS = 10_000;

export const systemRest: RestReader = {
  platform: process.platform,
  run: (program, args) => new Promise((done) => {
    execFile(program, [...args], { encoding: "utf8", timeout: RUN_MS, maxBuffer: 1024 * 1024 }, (error, out) => {
      done({ code: error === null ? 0 : typeof error.code === "number" ? error.code : null, out: out ?? "" });
    });
  }),
  device: (path) => {
    try {
      return statSync(path).dev;
    } catch {
      return null;
    }
  },
};

const NO_OWNERS = new Set(["exfat", "msdos", "vfat", "fat", "fat32", "ntfs", "fuseblk"]);
const BLOCK = new Set(["ext2", "ext3", "ext4", "xfs", "btrfs", "f2fs", "vfat", "exfat", "msdos", "ntfs", "ntfs3"]);

const UNKNOWN: Omit<VolumeRest, "volume"> = { encrypted: "unknown", filesystem: null, owners: "unknown", why: null };

export async function readAtRest(root: string, machineDir: string, reader: RestReader, now_ms: number, was: AtRest | null = null): Promise<AtRest> {
  const home = reader.device(root);
  const machine = reader.device(machineDir);
  const same = home !== null && home === machine;
  const byDevice = (volume: Omit<VolumeRest, "volume"> & { volume?: string | null }, device: number | null): VolumeRest =>
    ({ ...volume, volume: volume.volume ?? (device === null ? null : `dev:${device}`) });
  const read = (homeVolume: Omit<VolumeRest, "volume">, machineVolume: Omit<VolumeRest, "volume">): AtRest =>
    carry({ at_ms: now_ms, platform: reader.platform, home: byDevice(homeVolume, home), machine: byDevice(machineVolume, machine), same }, was);
  if (reader.platform === "darwin") {
    const [homeVolume, machineVolume, vault] = await Promise.all([macVolume(root, reader.run), macVolume(machineDir, reader.run), fileVault(reader.run)]);
    const fromVault = vault.encrypted === "unknown" ? { ...machineVolume, encrypted: "unknown" as const, why: join(machineVolume.why, vault.why) } : { ...machineVolume, encrypted: vault.encrypted };
    return read(homeVolume, fromVault);
  }
  if (reader.platform === "linux") {
    const [homeVolume, machineVolume] = await Promise.all([linuxVolume(root, reader.run), linuxVolume(machineDir, reader.run)]);
    return read(homeVolume, machineVolume);
  }
  const why = `no check of a disk on ${reader.platform}`;
  return read({ ...UNKNOWN, why }, { ...UNKNOWN, why });
}

function join(one: string | null, other: string | null): string | null {
  return one === null ? other : other === null ? one : `${one}; ${other}`;
}

async function macVolume(path: string, run: Run): Promise<Omit<VolumeRest, "volume"> & { volume?: string | null }> {
  const df = await run("df", ["-P", path]);
  const device = df.code === 0 ? df.out.split("\n")[1]?.split(/\s+/u)[0] : undefined;
  if (device === undefined || !device.startsWith("/dev/")) return { ...UNKNOWN, why: `df -P ${path} named no disk${df.code === 0 ? "" : ` (exit ${df.code})`}` };
  const info = await run("diskutil", ["info", "-plist", device]);
  if (info.code !== 0) return { ...UNKNOWN, why: `diskutil info ${device} failed (exit ${info.code})` };
  return diskutilVolume(info.out, device);
}

export function diskutilVolume(plist: string, device: string): Omit<VolumeRest, "volume"> & { volume?: string | null } {
  const filesystem = plistString(plist, "FilesystemType")?.toLowerCase() ?? null;
  const permissions = plistBool(plist, "GlobalPermissionsEnabled");
  const encryption = plistBool(plist, "Encryption") ?? plistBool(plist, "FileVault") ?? plistBool(plist, "CoreStorageEncrypted");
  const noOwners = filesystem !== null && NO_OWNERS.has(filesystem);
  const encrypted: Encrypted = encryption === true ? "encrypted" : encryption === false || noOwners ? "not-encrypted" : "unknown";
  const owners: Owners = noOwners || permissions === false ? "ignored" : permissions === true ? "kept" : "unknown";
  const unread = [encrypted === "unknown" ? "encryption" : null, filesystem === null ? "file system" : null, owners === "unknown" ? "ownership" : null].filter((each) => each !== null);
  return { encrypted, filesystem, owners, volume: plistString(plist, "VolumeUUID"), why: unread.length === 0 ? null : `diskutil info ${device} states no ${unread.join(", ")}` };
}

async function fileVault(run: Run): Promise<{ encrypted: Encrypted; why: string | null }> {
  const status = await run("fdesetup", ["status"]);
  if (status.code === 0 && /FileVault is On/u.test(status.out)) return { encrypted: "encrypted", why: null };
  if (status.code === 0 && /FileVault is Off/u.test(status.out)) return { encrypted: "not-encrypted", why: null };
  return { encrypted: "unknown", why: `fdesetup status said neither On nor Off (exit ${status.code})` };
}

async function linuxVolume(path: string, run: Run): Promise<Omit<VolumeRest, "volume">> {
  const mount = await run("findmnt", ["-n", "-o", "SOURCE,FSTYPE", "-T", path]);
  const [source, type] = mount.code === 0 ? mount.out.trim().split(/\s+/u) : [];
  if (source === undefined || type === undefined) return { ...UNKNOWN, why: `findmnt -T ${path} named no mount${mount.code === 0 ? "" : ` (exit ${mount.code})`}` };
  const filesystem = type.toLowerCase();
  const owners: Owners = NO_OWNERS.has(filesystem) ? "ignored" : "kept";
  if (!BLOCK.has(filesystem) || !source.startsWith("/dev/")) return { encrypted: "unknown", filesystem, owners, why: `${filesystem} on ${source}: no check of its encryption` };
  const chain = await run("lsblk", ["-s", "-n", "-o", "TYPE", source]);
  if (chain.code !== 0) return { encrypted: "unknown", filesystem, owners, why: `lsblk -s ${source} failed (exit ${chain.code})` };
  const types = chain.out.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  return { encrypted: types.includes("crypt") ? "encrypted" : "not-encrypted", filesystem, owners, why: null };
}

function plistString(plist: string, key: string): string | null {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, "u").exec(plist);
  return match === null ? null : match[1]!.replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&amp;/gu, "&");
}

function plistBool(plist: string, key: string): boolean | null {
  const match = new RegExp(`<key>${key}</key>\\s*<(true|false)/>`, "u").exec(plist);
  return match === null ? null : match[1] === "true";
}
