import { execFile } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { flush, flushed, writeDurably } from "@lifestreamprotocol/core";
import { ensureArtifact, oneWriter, removeArtifact, type Artifact } from "./artifacts.js";


export interface Build {
  name: string;
  version: string;
  artifact: Artifact;
  entry: string;
  team: string;
}

export type SignatureCheck = (folder: string, team: string, signal?: AbortSignal) => Promise<readonly string[]>;

export class Refused extends Error {}

export interface ReadyOptions {
  signed: SignatureCheck;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  progress?: (bytes: number) => void;
  failpoint?: (at: "fetched" | "unpacked" | "renamed" | "current") => void;
}

export function readyEntry(folder: string, version: string): string | null {
  const current = readCurrent(folder);
  return current !== null && current.version === version ? current.entry : null;
}

export function lastEntry(folder: string): string | null {
  return (readCurrent(folder) ?? readCurrent(folder, "previous"))?.entry ?? null;
}

export async function makeReady(folder: string, build: Build, options: ReadyOptions): Promise<string> {
  mkdirSync(folder, { recursive: true });
  return oneWriter(`${folder}.lock`, options.signal, () => ready(folder, build, options));
}

async function ready(folder: string, build: Build, { signed, env, signal, progress, failpoint }: ReadyOptions): Promise<string> {
  const made = readyEntry(folder, build.version);
  if (made !== null) {
    await finish(folder, build.version);
    return made;
  }
  const unpacked = join(folder, build.version);
  const partial = `${unpacked}.partial`;
  const tarball = join(folder, `${build.version}.tgz`);
  if (existsSync(join(folder, "current"))) {
    renameSync(join(folder, "current"), join(folder, "previous"));
    flush(folder);
  }
  rmSync(partial, { recursive: true, force: true });
  if (existsSync(unpacked)) {
    await check(folder, build.version, build, signed, env, signal, () => rmSync(unpacked, { recursive: true, force: true }), tarball);
  } else {
    await ensureArtifact(build.artifact, tarball, { ...(signal === undefined ? {} : { signal }), ...(progress === undefined ? {} : { progress }) });
    failpoint?.("fetched");
    mkdirSync(partial);
    await unpack(tarball, partial, signal);
    failpoint?.("unpacked");
    await check(folder, `${build.version}.partial`, build, signed, env, signal, () => rmSync(partial, { recursive: true, force: true }), tarball);
    for (const file of filesIn(partial)) await flushed(file);
    signal?.throwIfAborted();
    flush(partial);
    renameSync(partial, unpacked);
    flush(folder);
    failpoint?.("renamed");
  }
  signal?.throwIfAborted();
  writeDurably(join(folder, "current"), `${[build.version, ...build.entry.split("/")].join("/")}\n`);
  failpoint?.("current");
  await finish(folder, build.version);
  return join(unpacked, ...build.entry.split("/"));
}

export async function removeBuilds(folder: string, signal?: AbortSignal): Promise<void> {
  if (!existsSync(folder)) return;
  await oneWriter(`${folder}.lock`, signal, async () => rmSync(folder, { recursive: true, force: true }));
}

async function finish(folder: string, version: string): Promise<void> {
  rmSync(join(folder, "previous"), { force: true });
  await removeArtifact(join(folder, `${version}.tgz`));
}

export async function checkAgain(folder: string, build: Build, { signed, env, signal }: Pick<ReadyOptions, "signed" | "env" | "signal">): Promise<void> {
  await oneWriter(`${folder}.lock`, signal, async () => {
    if (readyEntry(folder, build.version) === null) return;
    await check(folder, build.version, build, signed, env, signal, () => {
      rmSync(join(folder, "current"), { force: true });
      flush(folder);
      rmSync(join(folder, build.version), { recursive: true, force: true });
    }, join(folder, `${build.version}.tgz`));
  });
}

function readCurrent(folder: string, file: "current" | "previous" = "current"): { entry: string; version: string } | null {
  let line: string;
  try {
    line = readFileSync(join(folder, file), "utf8").trim();
  } catch {
    return null;
  }
  const parts = line.split("/");
  if (line === "" || line.startsWith("/") || parts.includes("..") || parts.includes(".") || parts.length < 2) return null;
  const entry = join(folder, ...parts);
  try {
    if (!ownFile(folder, parts)) return null;
    accessSync(entry, constants.X_OK);
  } catch {
    return null;
  }
  return { entry, version: parts[0]! };
}

function ownFile(folder: string, parts: readonly string[]): boolean {
  const file = join(folder, ...parts);
  try {
    return lstatSync(file).isFile() && realpathSync(file) === join(realpathSync(folder), ...parts);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") return false;
    throw error;
  }
}

const CHECK_MS = 30_000;

async function check(folder: string, name: string, build: Build, signed: SignatureCheck, env: NodeJS.ProcessEnv, signal: AbortSignal | undefined, remove: () => void, tarball: string): Promise<void> {
  const unpacked = join(folder, name);
  const refuse = async (why: string): Promise<never> => {
    remove();
    await removeArtifact(tarball);
    throw new Refused(why);
  };
  const parts = build.entry.split("/");
  const entry = join(unpacked, ...parts);
  if (!ownFile(folder, [name, ...parts])) await refuse(`${build.name} ${build.version} is refused: its entry ${build.entry} is not a file of the build itself`);
  let covered: readonly string[] = [];
  try {
    covered = await signed(unpacked, build.team, signal);
  } catch (error) {
    if (error instanceof Refused) await refuse(`${build.name} ${build.version} is refused: ${error.message}`);
    throw error;
  }
  signal?.throwIfAborted();
  if (!covered.includes(entry)) await refuse(`${build.name} ${build.version} is refused: its entry ${build.entry} is not a native file the signature check covered`);
  const said = await new Promise<{ error: (Error & { code?: unknown }) | null; stdout: string }>((resolve) => {
    execFile(entry, ["--version"], { timeout: CHECK_MS, killSignal: "SIGKILL", env, ...(signal === undefined ? {} : { signal }) },
      (error, stdout) => resolve({ error, stdout: String(stdout) }));
  });
  signal?.throwIfAborted();
  if (said.error !== null && typeof said.error.code !== "number") throw new Error(`${entry} --version could not run: ${said.error.message}`);
  if (said.error !== null || !new RegExp(`(?:^|[^\\d.])${build.version.replaceAll(".", "\\.")}(?:[^\\d.]|$)`, "u").test(said.stdout)) {
    await refuse(`${entry} is not ${build.name} ${build.version}: it says ${JSON.stringify(said.stdout.trim() || said.error?.message || "nothing")}`);
  }
}

function unpack(tarball: string, into: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/tar", ["-xzf", tarball, "-C", into], { maxBuffer: 1 << 24, ...(signal === undefined ? {} : { signal }) }, (error, _stdout, stderr) => {
      if (error === null) return resolve();
      reject(signal?.aborted === true ? signal.reason : new Error(`tar could not unpack ${tarball}: ${String(stderr).trim() || error.message}`));
    });
  });
}

function filesIn(folder: string): string[] {
  return readdirSync(folder, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

const NATIVE_MAGIC = new Set(["feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]);

function nativeFiles(folder: string): string[] {
  const head = Buffer.alloc(4);
  const native = (path: string): boolean => {
    const fd = openSync(path, "r");
    try {
      return readSync(fd, head, 0, 4, 0) === 4 && NATIVE_MAGIC.has(head.toString("hex"));
    } finally {
      closeSync(fd);
    }
  };
  return filesIn(folder).filter(native).sort();
}

export const codesigned: SignatureCheck = async (folder, team, signal) => {
  const requirement = `=anchor apple generic and certificate leaf[subject.OU] = "${team}"`;
  const files = nativeFiles(folder);
  if (files.length === 0) throw new Refused(`${folder} holds no native file`);
  for (const file of files) {
    const refused = await new Promise<string | null>((resolve, reject) => {
      execFile("codesign", ["--verify", "--strict", "-R", requirement, file], { timeout: CHECK_MS, killSignal: "SIGKILL", ...(signal === undefined ? {} : { signal }) }, (error, _stdout, stderr) => {
        if (error === null) return resolve(null);
        if (signal?.aborted === true) return reject(signal.reason);
        if (typeof (error as { code?: unknown }).code === "number") return resolve(String(stderr).trim() || error.message);
        reject(new Error(`codesign could not check ${file}: ${error.message}`));
      });
    });
    if (refused !== null) throw new Refused(`${file}'s signature is not Apple's for team ${team}: ${refused}`);
  }
  return files;
};
