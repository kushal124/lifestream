import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { availableParallelism, homedir, networkInterfaces } from "node:os";
import { isAbsolute, join } from "node:path";
import { writeDurably } from "@lifestreamprotocol/core";
import { UNIT } from "./settings.js";
import { readyBinary, signInFolder, type ProgramName } from "./subscriptions.js";
import { CLI } from "./cli-name.js";

export interface Machine {
  readonly dir: string;
  readonly user: string;
  readonly home: string | null;
  readonly codex: { readonly binary: string; readonly home: string } | null;
  readonly claude: { readonly binary: string; readonly home: string } | null;
  overridden(name: ProgramName): boolean;
  readonly dnssd: string | null;
  readonly tailscale: string | null;
  readonly bonjour: string | null;
  readonly addresses: { readonly lan: readonly string[]; readonly tailnet: readonly string[] };
  readonly helpers: number;
  readonly zone: string;
  readonly unit: string | null;
  readonly macApp: boolean;
  readonly systemdCreds: string | null;
}

export interface MachineOptions {
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
  system?: string;
}

export class MachineError extends Error {
  override name = "MachineError";
}

const POINTER = "home";
const APP = "Lifestream.app";
const OVERRIDES = "machine.json";

export function machine(options: MachineOptions = {}): Machine {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const dir = machineDir(env, home);
  const overrides = readOverrides(join(dir, OVERRIDES));
  const system = (path: string) => join(options.system ?? "/", path);
  return {
    dir,
    user: home,
    home: readPointer(join(dir, POINTER)),
    get codex() {
      return programAt(dir, "codex");
    },
    get claude() {
      return programAt(dir, "claude");
    },
    overridden: (name) => readOverrides(join(dir, OVERRIDES))[name] !== undefined,
    dnssd: overrides.dnssd ?? firstRunnable([system("usr/bin/dns-sd")]),
    get tailscale() {
      const named = readOverrides(join(dir, OVERRIDES)).tailscale;
      if (named !== undefined) return firstRunnable([named]);
      return firstRunnable([system("Applications/Tailscale.app/Contents/MacOS/Tailscale"), ...(env.PATH ?? "").split(":").filter(isAbsolute).map((place) => join(place, "tailscale"))]);
    },
    get bonjour() {
      return readOverrides(join(dir, OVERRIDES)).bonjour ?? localHostName();
    },
    get addresses() {
      const read = readOverrides(join(dir, OVERRIDES));
      return read.addresses !== undefined ? byKind(read.addresses) : read.bonjour === undefined ? addressesOf() : { lan: [], tailnet: [] };
    },
    helpers: helpersFor(availableParallelism()),
    zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    unit: overrides.unit ?? null,
    macApp: [join(home, "Applications", APP), system(join("Applications", APP))].some((path) => existsSync(path)),
    systemdCreds: firstRunnable([system("usr/bin/systemd-creds"), system("bin/systemd-creds")]),
  };
}

export function helpersFor(cores: number): number {
  return Math.max(3, Math.min(4, cores - 2));
}

function programAt(dir: string, name: ProgramName): { binary: string; home: string } | null {
  const binary = readOverrides(join(dir, OVERRIDES))[name] ?? readyBinary(dir, name);
  return binary === null ? null : { binary, home: signInFolder(dir, name) };
}

const TAILNET_RANGE = (address: string): boolean => {
  const [first, second] = address.split(".").map(Number);
  return first === 100 && second! >= 64 && second! < 128;
};

export type Interfaces = ReturnType<typeof networkInterfaces>;

export function addressesOf(interfaces: Interfaces = networkInterfaces()): { lan: string[]; tailnet: string[] } {
  const lan: string[] = [], tailnet: string[] = [];
  for (const [name, each] of Object.entries(interfaces)) {
    for (const address of each ?? []) {
      if (address.family !== "IPv4" || address.internal || address.address.startsWith("169.254.")) continue;
      (name.startsWith("utun") && TAILNET_RANGE(address.address) ? tailnet : lan).push(address.address);
    }
  }
  return { lan: [...new Set(lan)], tailnet: [...new Set(tailnet)] };
}

export function tailnetOf(read: () => Interfaces = networkInterfaces): (address: string) => boolean {
  let known = new Set(addressesOf(read()).tailnet);
  return (address) => {
    if (known.has(address)) return true;
    known = new Set(addressesOf(read()).tailnet);
    return known.has(address);
  };
}

function byKind(all: readonly string[]): { lan: string[]; tailnet: string[] } {
  const unique = [...new Set(all)];
  return { lan: unique.filter((address) => !TAILNET_RANGE(address)), tailnet: unique.filter(TAILNET_RANGE) };
}

export function extensionFolder(dir: string): string {
  return join(dir, "extension");
}

export function pointAt(at: Machine, folder: string): void {
  mkdirSync(at.dir, { recursive: true, mode: 0o700 });
  writeDurably(join(at.dir, POINTER), `${folder}\n`);
}

export function pointedAt(at: Machine): string | null {
  return readPointer(join(at.dir, POINTER));
}

function machineDir(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const named = env.LIFESTREAM_MACHINE_DIR;
  if (named !== undefined && named !== "") {
    if (!isAbsolute(named)) throw new MachineError(`LIFESTREAM_MACHINE_DIR is ${named}: name an absolute path`);
    return named;
  }
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Lifestream");
  const data = env.XDG_DATA_HOME;
  return join(data !== undefined && isAbsolute(data) ? data : join(home, ".local", "share"), "lifestream");
}

function readPointer(path: string): string | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const folder = text.trim();
  if (!isAbsolute(folder)) throw new MachineError(`${path} names ${JSON.stringify(folder)}, not a folder's absolute path: run ${CLI} adopt <folder>`);
  return folder;
}

function readOverrides(path: string): Overrides {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new MachineError(`${path}: ${(error as Error).message}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new MachineError(`${path} is an object`);
  const found: Overrides = {};
  for (const member of ["codex", "claude", "dnssd", "tailscale"] as const) {
    const named = (value as Record<string, unknown>)[member];
    if (named === undefined) continue;
    if (typeof named !== "string" || !isAbsolute(named)) throw new MachineError(`${path}: ${member} is an absolute path`);
    found[member] = named;
  }
  const bonjour = (value as Record<string, unknown>).bonjour;
  if (bonjour !== undefined) {
    if (typeof bonjour !== "string" || !/^[A-Za-z0-9.-]+$/u.test(bonjour)) throw new MachineError(`${path}: bonjour is a host name`);
    found.bonjour = bonjour;
  }
  const addresses = (value as Record<string, unknown>).addresses;
  if (addresses !== undefined) {
    if (!Array.isArray(addresses) || addresses.some((host) => typeof host !== "string" || !/^[A-Za-z0-9.-]+$/u.test(host))) {
      throw new MachineError(`${path}: addresses is a list of hosts`);
    }
    found.addresses = addresses as string[];
  }
  const unit = (value as Record<string, unknown>).unit;
  if (unit !== undefined) {
    if (typeof unit !== "string" || !UNIT.test(unit)) throw new MachineError(`${path}: unit is a unit id`);
    found.unit = unit;
  }
  return found;
}

interface Overrides {
  codex?: string;
  claude?: string;
  dnssd?: string;
  tailscale?: string;
  bonjour?: string;
  addresses?: string[];
  unit?: string;
}

function localHostName(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    const name = execFileSync("/usr/sbin/scutil", ["--get", "LocalHostName"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /^[A-Za-z0-9-]+$/u.test(name) ? `${name}.local` : null;
  } catch {
    return null;
  }
}

function firstRunnable(places: readonly string[]): string | null {
  for (const place of places) {
    try {
      if (!statSync(place).isFile()) continue;
      accessSync(place, constants.X_OK);
      return place;
    } catch {
    }
  }
  return null;
}
