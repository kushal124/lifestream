import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire, registerHooks, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";
import { admit, admittedNone, FOLDERS, withRoadDefaults, type Admitted, type Connector, type Entry, type Fault, type Whose } from "@lifestreamprotocol/connect";
import { writeDurably } from "@lifestreamprotocol/core";
import { CLI, typed } from "./cli-name.js";
import { repoRoot, sdkModule, trialCommand } from "./programs.js";
import type { Raised } from "./streams-report.js";


export const TRIAL_MS = 5_000;
export const DECLARED_MS = 30_000;
const HANDED = "LIFESTREAM_FOLDERS";
const ENTRIES = ["index.ts", "index.mjs"] as const;

export interface Loaded {
  readonly name: string;
  readonly path: string;
  readonly digest: string;
  readonly entry: string;
  readonly stamp: string;
  readonly ids: readonly string[];
}

export interface Refusal {
  readonly name: string;
  readonly path: string;
  readonly faults: readonly Fault[];
  readonly stamp: string;
  readonly transient?: true;
}

export interface Generation {
  readonly root: string;
  readonly start: string;
  readonly store: string;
  readonly sdk: string;
  readonly folders: readonly Loaded[];
  readonly refused: readonly Refusal[];
}

export function connectorsFolder(root: string): string {
  return join(root, "connectors");
}

export const READ_FOLDER = "read-folder:";

export function waitsOnFolder(root: string, meta: (key: string) => string | undefined, connector: string): boolean {
  const folder = meta(`${READ_FOLDER}${connector}`);
  return folder !== undefined && (handed(root)?.refused.some((each) => each.name === folder) ?? false);
}

const CLASH = /^(.+) is an? (.+?) the folder (\S+) holds already$/u;

export interface Clash {
  readonly name: string;
  readonly what: string;
  readonly holder: string;
  readonly words: string;
}

export function clashOf(root: string, reason: string): Clash | null {
  const clash = CLASH.exec(reason);
  if (clash === null) return null;
  const [, name, what, holder] = clash as unknown as [string, string, string, string];
  const words = homeFolders(root).includes(holder)
    ? `connectors/${holder} holds the ${what} ${name}: rename this folder's ${what}, or remove ${holder} first`
    : `the release's ${holder} holds the ${what} ${name}: rename this folder's ${what}`;
  return { name, what, holder, words };
}

export interface Install {
  readonly from?: string;
  readonly ids: readonly string[];
}

export type Installed = Record<string, Install>;

export const installedFile = (root: string) => join(connectorsFolder(root), ".installed.json");

export function installedOf(root: string): Installed {
  const path = installedFile(root);
  if (!existsSync(path)) return {};
  const broken = (why: string) => new Error(`${path} ${why}: it names each installed folder, where it came from and its ids; remove the file and install each folder again`);
  let read: unknown;
  try {
    read = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw broken(`is not JSON (${(error as Error).message})`);
  }
  const whole = typeof read === "object" && read !== null && !Array.isArray(read) && Object.values(read).every((each: unknown) => typeof each === "object" && each !== null
    && Array.isArray((each as Install).ids) && (each as Install).ids.every((id) => typeof id === "string") && ((each as Install).from === undefined || typeof (each as Install).from === "string"));
  if (!whole) throw broken("does not hold each folder's from and ids");
  return read as Installed;
}

export function generationsFolder(machineDir: string): string {
  return join(machineDir, "generations");
}


function filesOf(dir: string, under = ""): string[] {
  return readdirSync(join(dir, under), { withFileTypes: true }).flatMap((entry) => {
    const path = under === "" ? entry.name : `${under}/${entry.name}`;
    const stat = entry.isSymbolicLink() ? statSync(join(dir, path), { throwIfNoEntry: false }) : entry;
    if (stat === undefined) return [];
    return stat.isDirectory() ? filesOf(dir, path) : stat.isFile() ? [path] : [];
  }).sort();
}

export function folderDigest(dir: string): string {
  const hash = createHash("sha256");
  for (const path of filesOf(dir)) hash.update(`${path}\u0000`).update(readFileSync(join(dir, path))).update("\u0000");
  return `sha256:${hash.digest("hex")}`;
}

export const GONE = "gone";

export function folderStamp(dir: string): string {
  if (!existsSync(dir)) return GONE;
  const hash = createHash("sha256");
  for (const path of filesOf(dir)) {
    const stat = statSync(join(dir, path));
    hash.update(`${path}\u0000${stat.size}\u0000${stat.mtimeMs}\u0000`);
  }
  return hash.digest("hex");
}

export function homeFolders(root: string): string[] {
  const folder = connectorsFolder(root);
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith(".") && (entry.isDirectory() || (entry.isSymbolicLink() && statSync(join(folder, entry.name), { throwIfNoEntry: false })?.isDirectory() === true)))
    .map((entry) => entry.name).sort();
}

function copyOf(store: string, path: string, digest: string): string {
  const copy = join(store, digest.replace(/^sha256:/u, ""));
  if (existsSync(copy)) return copy;
  mkdirSync(store, { recursive: true });
  const temp = `${copy}.${process.pid}.${Date.now()}`;
  cpSync(path, temp, { recursive: true, dereference: true });
  try {
    renameSync(temp, copy);
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    if (!existsSync(copy)) throw error;
  }
  return copy;
}


const runningFolder = (store: string) => join(store, ".running");
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

function nameCopies(generation: Generation): void {
  const folder = runningFolder(generation.store);
  mkdirSync(folder, { recursive: true });
  const key = createHash("sha256").update(generation.root).digest("hex").slice(0, 12);
  writeFileSync(join(folder, `${process.pid}-${key}.json`), JSON.stringify(generation.folders.map((each) => each.entry)));
}

function sweep(store: string, kept: ReadonlySet<string>): void {
  if (!existsSync(store)) return;
  const named = new Set(kept);
  const running = runningFolder(store);
  for (const name of existsSync(running) ? readdirSync(running) : []) {
    const pid = Number(name.split("-")[0]);
    if (!Number.isInteger(pid) || !alive(pid)) {
      rmSync(join(running, name), { force: true });
      continue;
    }
    try {
      for (const entry of JSON.parse(readFileSync(join(running, name), "utf8")) as string[]) named.add(relative(store, entry).split(sep)[0]!);
    } catch {
    }
  }
  for (const name of readdirSync(store)) {
    if (name.startsWith(".") || named.has(name)) continue;
    rmSync(join(store, name), { recursive: true, force: true });
  }
}


const hookedFolders = new Set<string>();
const hookedModules = new Set<string>();
let hookSdk: string | undefined;

export const SDK_SPECIFIER = "@lifestreamprotocol/connect/sdk";

export const oneDoor = (specifier: string): string | null =>
  specifier !== SDK_SPECIFIER && specifier.startsWith("@lifestreamprotocol/") ? `${specifier}: a home folder imports Lifestream through ${SDK_SPECIFIER} alone` : null;

function bothPaths(path: string): Set<string> {
  return new Set([path, existsSync(path) ? realpathSync(path) : path]);
}

function hookedAt(parent: string): boolean {
  const module = parent.replace(/[?#].*$/u, "");
  return hookedModules.has(module) || [...hookedFolders].some((under) => module.startsWith(under));
}

export function useHook(store: string, sdk: string): void {
  for (const path of bothPaths(store)) hookedFolders.add(pathToFileURL(join(path, "/")).href);
  registerHook(sdk);
}

export function hookModule(module: string, sdk: string): void {
  for (const path of bothPaths(module)) hookedModules.add(pathToFileURL(path).href);
  registerHook(sdk);
}

function registerHook(sdk: string): void {
  if (hookSdk !== undefined) return;
  hookSdk = pathToFileURL(sdk).href;
  registerHooks({
    resolve(specifier, context, next) {
      const parent = context.parentURL;
      if (parent !== undefined && hookedAt(parent)) {
        if (specifier === SDK_SPECIFIER) return { url: hookSdk!, shortCircuit: true };
        const refused = oneDoor(specifier);
        if (refused !== null) throw new Error(refused);
        if (/^\.\.?\//u.test(specifier) && specifier.endsWith(".js")) {
          const url = new URL(specifier, parent);
          const typed = new URL(url.href.replace(/\.js$/u, ".ts"));
          if (!existsSync(fileURLToPath(url)) && existsSync(fileURLToPath(typed))) return { url: typed.href, shortCircuit: true };
        }
      }
      return next(specifier, context);
    },
  });
}

const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;

export async function importFolder(entry: string, store: string, sdk: string): Promise<unknown> {
  useHook(store, sdk);
  try {
    return await nativeImport(pathToFileURL(entry).href);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING") throw error;
    return createRequire(import.meta.url)(entry) as unknown;
  }
}


function releaseIcons(): ReadonlyMap<string, string | undefined> | undefined {
  const path = join(repoRoot(), "design", "icons.json");
  if (!existsSync(path)) return undefined;
  return new Map(Object.entries((JSON.parse(readFileSync(path, "utf8")) as { icons: Record<string, { phosphor?: string }> }).icons).map(([key, icon]) => [key, icon.phosphor]));
}

function ownFolders(paths: readonly string[], user = process.env.HOME ?? ""): string[] {
  return paths.filter((path) => user !== "" && path.startsWith(`${user}${sep}`)).map((path) => `~/${relative(user, path).split(sep).join("/")}`);
}

export interface AdmittedFolder {
  readonly folder: string;
  readonly whose: Whose;
  readonly entry: Entry;
  readonly digest?: string;
}

let release: { entries: readonly AdmittedFolder[]; admitted: Admitted } | undefined;

export function releaseAdmitted(): { entries: readonly AdmittedFolder[]; admitted: Admitted } {
  if (release !== undefined) return release;
  const admitted = admittedNone();
  const entries = FOLDERS.map(({ folder, module }): AdmittedFolder => {
    const result = admit(module, { folder, whose: "release", admitted });
    if ("faults" in result) throw new TypeError(`the release's folder ${folder} is refused: ${result.faults.map(([member, reason]) => `${member}: ${reason}`).join("; ")}`);
    return { folder, whose: "release", entry: result.entry };
  });
  return (release = { entries, admitted });
}

function cloned(admitted: Admitted): Admitted {
  return Object.fromEntries(Object.entries(admitted).map(([kind, names]) => [kind, new Map(names as Map<string, string>)])) as unknown as Admitted;
}

function admitHome(module: unknown, name: string, admitted: Admitted, lifestream: readonly string[]): { entry: Entry } | { faults: Fault[] } {
  const icons = releaseIcons();
  return admit(module, { folder: name, whose: "home", admitted, lifestream, ...(icons === undefined ? {} : { icons }) });
}

export interface TrialAsk {
  readonly name: string;
  readonly entry: string;
  readonly store: string;
  readonly sdk: string;
  readonly lifestream: readonly string[];
  readonly guarded?: true;
}

export interface TrialAnswer {
  readonly faults: Fault[];
}

export async function trial(ask: TrialAsk): Promise<TrialAnswer> {
  const unstripped = unstrippable(join(ask.entry, ".."));
  if (unstripped !== null) return { faults: [["import", unstripped]] };
  let module: unknown;
  try {
    module = await importFolder(ask.entry, ask.store, ask.sdk);
  } catch (error) {
    return { faults: [["import", firstLine(error)]] };
  }
  const result = admitHome(module, ask.name, cloned(releaseAdmitted().admitted), ask.lifestream);
  return { faults: "faults" in result ? result.faults : [] };
}

export function unstrippable(folder: string, under = ""): string | null {
  for (const entry of readdirSync(join(folder, under), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(under, entry.name);
    if (entry.isDirectory()) {
      const found = entry.name === "node_modules" ? null : unstrippable(folder, path);
      if (found !== null) return found;
    } else if (/\.m?ts$/u.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      try {
        stripTypeScriptTypes(readFileSync(join(folder, path), "utf8"), { mode: "strip" });
      } catch (error) {
        return `${path.split(sep).join("/")}: ${(error as Error).message.split("\n")[0]!.trim()}`;
      }
    }
  }
  return null;
}

const firstLine = (error: unknown) => (error instanceof Error ? `${error.name === "Error" ? "" : `${error.name}: `}${error.message}` : String(error)).split("\n")[0]!.trim();

interface Tried {
  readonly faults: Fault[];
  readonly transient?: true;
}

export const IMPORTING = "importing\n";
export const TRIAL_ANSWER = "\x1e";

export interface TrialWorker {
  readonly child: ChildProcess;
  readonly key: string;
  readonly seen: Set<string>;
  readonly onIdleClose: () => void;
}

const idleTrialWorkers: TrialWorker[] = [];
let trialExitHooked = false;

function setStreamRef(stream: unknown, ref: boolean): void {
  const handle = stream as { ref?: () => void; unref?: () => void } | null | undefined;
  if (ref) handle?.ref?.();
  else handle?.unref?.();
}

function overlapsPath(seen: ReadonlySet<string>, dirs: readonly string[]): boolean {
  for (const dir of dirs) {
    for (const prior of seen) {
      if (dir === prior || dir.startsWith(`${prior}${sep}`) || prior.startsWith(`${dir}${sep}`)) return true;
    }
  }
  return false;
}

function killIdleWorkers(): void {
  while (idleTrialWorkers.length > 0) {
    const worker = idleTrialWorkers.pop()!;
    worker.child.off("close", worker.onIdleClose);
    worker.child.kill("SIGKILL");
  }
}

export function borrowTrialWorker(guarded: boolean, dirs: readonly string[]): TrialWorker {
  if (!trialExitHooked) {
    trialExitHooked = true;
    process.once("exit", killIdleWorkers);
  }
  const [command, ...baseArgs] = trialCommand();
  const args = [...baseArgs, guarded ? "--serve" : "--serve-unguarded"];
  const key = JSON.stringify([command, args, process.env.HOME ?? "", process.env.LIFESTREAM_MACHINE_DIR ?? ""]);
  for (let i = idleTrialWorkers.length - 1; i >= 0; i--) {
    const worker = idleTrialWorkers[i]!;
    if (worker.key !== key) continue;
    if (worker.child.exitCode !== null || worker.child.killed || worker.child.stdin === null || !worker.child.stdin.writable) {
      idleTrialWorkers.splice(i, 1);
      continue;
    }
    if (overlapsPath(worker.seen, dirs)) continue;
    idleTrialWorkers.splice(i, 1);
    worker.child.off("close", worker.onIdleClose);
    worker.child.ref();
    setStreamRef(worker.child.stdin, true);
    setStreamRef(worker.child.stdout, true);
    setStreamRef(worker.child.stderr, true);
    worker.child.stdout?.resume();
    worker.child.stderr?.resume();
    for (const dir of dirs) worker.seen.add(dir);
    return worker;
  }
  const child = spawn(command!, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, [HANDED]: "" } });
  const worker: TrialWorker = {
    child,
    key,
    seen: new Set(dirs),
    onIdleClose: () => {
      const at = idleTrialWorkers.indexOf(worker);
      if (at >= 0) idleTrialWorkers.splice(at, 1);
    },
  };
  return worker;
}

export function releaseTrialWorker(worker: TrialWorker): void {
  if (worker.child.exitCode !== null || worker.child.killed || worker.child.stdin === null || !worker.child.stdin.writable) {
    discardTrialWorker(worker);
    return;
  }
  worker.child.stdout?.pause();
  worker.child.stderr?.pause();
  worker.child.unref();
  setStreamRef(worker.child.stdin, false);
  setStreamRef(worker.child.stdout, false);
  setStreamRef(worker.child.stderr, false);
  worker.child.once("close", worker.onIdleClose);
  idleTrialWorkers.push(worker);
  while (idleTrialWorkers.length > 6) {
    const oldest = idleTrialWorkers.shift()!;
    oldest.child.off("close", oldest.onIdleClose);
    oldest.child.kill("SIGKILL");
  }
}

export function discardTrialWorker(worker: TrialWorker): void {
  worker.child.off("close", worker.onIdleClose);
  worker.child.kill("SIGKILL");
}

type Asked =
  | { readonly answer: unknown }
  | { readonly late: true }
  | { readonly unstarted: string }
  | { readonly ended: string };

function askChild(ask: TrialAsk | DeclareAsk, ms: number): Promise<Asked> {
  return new Promise((done) => {
    const guarded = "declare" in ask || ask.guarded === true;
    const dirs = "declare" in ask ? [ask.declare.store] : [dirname(ask.entry)];
    const worker = borrowTrialWorker(guarded, dirs);
    const { child } = worker;
    let out = "";
    let err = "";
    let timer: NodeJS.Timeout | undefined;
    let ended = false;
    const end = (asked: Asked, reuse = false) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      child.stdout?.off("data", onOut);
      child.stderr?.off("data", onErr);
      child.off("error", onError);
      child.off("close", onClose);
      child.stdin?.off("error", onStdinError);
      if (reuse) releaseTrialWorker(worker);
      else discardTrialWorker(worker);
      done(asked);
    };
    const onOut = (chunk: Buffer) => {
      out += chunk.toString("utf8");
      for (let at = out.indexOf("\n"); at >= 0; at = out.indexOf("\n")) {
        const line = out.slice(0, at);
        out = out.slice(at + 1);
        if (timer === undefined && line === IMPORTING.trim()) timer = setTimeout(() => end({ late: true }), ms);
        else if (line.startsWith(TRIAL_ANSWER)) {
          try {
            end({ answer: JSON.parse(line.slice(TRIAL_ANSWER.length)) as unknown }, true);
          } catch {
            end({ ended: "with malformed answer" });
          }
          return;
        }
      }
    };
    const onErr = (chunk: Buffer) => { err += chunk.toString("utf8"); };
    const onError = (error: Error) => end({ unstarted: error.message });
    const onStdinError = () => undefined;
    const onClose = (code: number | null) => {
      end({ ended: `${code === null ? "killed" : `with ${code}`}: ${err.trim().split("\n").findLast((line) => /\w*Error\b/u.test(line)) ?? err.trim().split("\n").at(-1) ?? "no word"}` });
    };
    child.stdout!.on("data", onOut);
    child.stderr!.on("data", onErr);
    child.on("error", onError);
    child.on("close", onClose);
    child.stdin!.on("error", onStdinError);
    child.stdin!.write(`${JSON.stringify(ask)}\n`);
  });
}

async function tried(ask: TrialAsk, ms: number): Promise<Tried> {
  const asked = await askChild(ask, ms);
  if ("answer" in asked) return { faults: (asked.answer as TrialAnswer).faults };
  if ("late" in asked) return { faults: [["import", "took too long to load"]], transient: true };
  if ("unstarted" in asked) return { faults: [["trial", `could not be tried: ${asked.unstarted}`]], transient: true };
  return { faults: [["import", `the trial ended ${asked.ended}`]] };
}

export interface Named {
  readonly name: string;
  readonly path: string;
}

export interface LoadOptions {
  readonly root: string;
  readonly machineDir: string;
  readonly trialMs?: number;
  readonly folders?: readonly Named[];
  readonly store?: string;
  readonly guarded?: true;
}

export async function loadGeneration(options: LoadOptions): Promise<Generation> {
  const { root } = options;
  const start = randomUUID();
  const store = options.store ?? generationsFolder(options.machineDir);
  const sdk = sdkModule();
  const lifestream = ownFolders([root, options.machineDir]);
  const refused: Refusal[] = [];
  const named = options.folders ?? homeFolders(root).map((name) => ({ name, path: join(connectorsFolder(root), name) }));
  const found = named.flatMap(({ name, path }) => {
    const stamp = folderStamp(path);
    const entry = ENTRIES.find((file) => existsSync(join(path, file)));
    if (entry === undefined) {
      refused.push({ name, path, stamp, faults: [["folder", "holds no index.ts or index.mjs"]] });
      return [];
    }
    try {
      const digest = folderDigest(path);
      return [{ name, path, stamp, digest, entry: join(copyOf(store, path, digest), entry) }];
    } catch (error) {
      refused.push({ name, path, stamp, faults: [["folder", `could not be copied: ${firstLine(error)}`]], transient: true });
      return [];
    }
  });
  sweep(store, new Set(found.map((each) => relative(store, each.entry).split(sep)[0]!)));
  if (found.length === 0) return { root, start, store, sdk, folders: [], refused };
  const trials = await Promise.all(found.map((each) => tried({ name: each.name, entry: each.entry, store, sdk, lifestream, ...(options.guarded === undefined ? {} : { guarded: true }) }, options.trialMs ?? TRIAL_MS)));
  const admitted = cloned(releaseAdmitted().admitted);
  const folders: Loaded[] = [];
  for (const [index, each] of found.entries()) {
    const trialled = trials[index]!;
    if (trialled.faults.length > 0) {
      refused.push({ name: each.name, path: each.path, stamp: each.stamp, ...trialled });
      continue;
    }
    let module: unknown;
    try {
      module = await importFolder(each.entry, store, sdk);
    } catch (error) {
      refused.push({ name: each.name, path: each.path, stamp: each.stamp, faults: [["import", firstLine(error)]] });
      continue;
    }
    const result = admitHome(module, each.name, admitted, lifestream);
    if ("faults" in result) refused.push({ name: each.name, path: each.path, stamp: each.stamp, faults: result.faults });
    else {
      folders.push({ ...each, ids: result.entry.connectors.map((connector) => connector.id) });
      imported.set(each.entry, result.entry);
    }
  }
  refused.sort((a, b) => a.name.localeCompare(b.name));
  return { root, start, store, sdk, folders, refused };
}


export interface DeclaredFolder extends Loaded {
  readonly connectors: readonly Connector[];
}

export interface DeclaredGeneration {
  readonly folders: readonly DeclaredFolder[];
  readonly refused: readonly Refusal[];
}

export interface DeclareAsk {
  readonly declare: Omit<LoadOptions, "guarded"> & { readonly folders: readonly Named[]; readonly store: string; readonly inline?: true };
}

export async function declaredGeneration(options: Omit<LoadOptions, "guarded" | "store"> & { readonly folders: readonly Named[] }): Promise<DeclaredGeneration> {
  if (options.folders.length === 0) return { folders: [], refused: [] };
  const store = mkdtempSync(join(tmpdir(), "lifestream-declared-"));
  try {
    if (options.folders.length === 1) {
      const [only] = options.folders;
      const asked = await askChild({ declare: { ...options, store, inline: true } }, options.trialMs ?? TRIAL_MS);
      if ("answer" in asked) return asked.answer as DeclaredGeneration;
      const stamp = folderStamp(only!.path);
      if ("late" in asked) return { folders: [], refused: [{ name: only!.name, path: only!.path, stamp, faults: [["import", "took too long to load"]], transient: true }] };
      if ("unstarted" in asked) return { folders: [], refused: [{ name: only!.name, path: only!.path, stamp, faults: [["trial", `could not be tried: ${asked.unstarted}`]], transient: true }] };
      return { folders: [], refused: [{ name: only!.name, path: only!.path, stamp, faults: [["import", `the trial ended ${asked.ended}`]] }] };
    }
    const asked = await askChild({ declare: { ...options, store } }, DECLARED_MS);
    if ("answer" in asked) return asked.answer as DeclaredGeneration;
    const why = "late" in asked ? `they did not load in ${DECLARED_MS / 1000} s, a folder's import hanging`
      : "unstarted" in asked ? `the child did not start: ${asked.unstarted}` : `the child ended ${asked.ended}`;
    throw new Error(`the connector folders ${options.folders.map((each) => each.name).join(", ")} could not be read: ${why}`);
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
}

export async function declaredInChild(ask: DeclareAsk): Promise<DeclaredGeneration> {
  if (ask.declare.inline === true && ask.declare.folders.length === 1) {
    const [only] = ask.declare.folders;
    const { root, machineDir, store } = ask.declare;
    const sdk = sdkModule();
    const lifestream = ownFolders([root, machineDir]);
    const stamp = folderStamp(only!.path);
    const entryName = ENTRIES.find((file) => existsSync(join(only!.path, file)));
    if (entryName === undefined) return { folders: [], refused: [{ name: only!.name, path: only!.path, stamp, faults: [["folder", "holds no index.ts or index.mjs"]] }] };
    let digest: string;
    let entry: string;
    try {
      digest = folderDigest(only!.path);
      entry = join(copyOf(store, only!.path, digest), entryName);
    } catch (error) {
      return { folders: [], refused: [{ name: only!.name, path: only!.path, stamp, faults: [["folder", `could not be copied: ${firstLine(error)}`]], transient: true }] };
    }
    const unstripped = unstrippable(join(entry, ".."));
    if (unstripped !== null) return { folders: [], refused: [{ name: only!.name, path: only!.path, stamp, faults: [["import", unstripped]] }] };
    let module: unknown;
    try {
      module = await importFolder(entry, store, sdk);
    } catch (error) {
      return { folders: [], refused: [{ name: only!.name, path: only!.path, stamp, faults: [["import", firstLine(error)]] }] };
    }
    const result = admitHome(module, only!.name, cloned(releaseAdmitted().admitted), lifestream);
    if ("faults" in result) return { folders: [], refused: [{ name: only!.name, path: only!.path, stamp, faults: result.faults }] };
    return {
      folders: [{ name: only!.name, path: only!.path, stamp, digest, entry, ids: result.entry.connectors.map((connector) => connector.id), connectors: result.entry.connectors }],
      refused: [],
    };
  }
  const generation = await loadGeneration({ ...ask.declare, guarded: true });
  return { folders: generation.folders.map((each) => ({ ...each, connectors: imported.get(each.entry)!.connectors })), refused: generation.refused };
}


const imported = new Map<string, Entry>();

const homesHere = new Set<string>();

export function hand(generation: Generation): void {
  homesHere.add(generation.root);
  put(generation);
}

export function handHeard(generation: Generation): void {
  if (!homesHere.has(generation.root)) put(generation);
}

export function homeLeft(root: string): void {
  homesHere.delete(root);
}

function put(generation: Generation): void {
  const all = { ...handedAll(), [generation.root]: generation };
  process.env[HANDED] = JSON.stringify(all);
  nameCopies(generation);
}

function handedAll(): Record<string, Generation> {
  const text = process.env[HANDED];
  if (text === undefined || text === "") return {};
  try {
    return JSON.parse(text) as Record<string, Generation>;
  } catch {
    return {};
  }
}

export function handed(root: string): Generation | null {
  return handedAll()[root] ?? null;
}

export async function admittedSet(root: string): Promise<readonly AdmittedFolder[]> {
  const base = releaseAdmitted();
  const generation = handed(root);
  if (generation === null || generation.folders.length === 0) return base.entries;
  const key = JSON.stringify(generation.folders);
  const made = sets.get(root);
  if (made !== undefined && made.key === key) return made.set;
  const admitted = cloned(base.admitted);
  const lifestream = ownFolders([root, join(generation.store, "..")]);
  const home: AdmittedFolder[] = [];
  for (const each of generation.folders) {
    let entry = imported.get(each.entry);
    if (entry === undefined) {
      let result: { entry: Entry } | { faults: Fault[] };
      try {
        result = admitHome(await importFolder(each.entry, generation.store, generation.sdk), each.name, admitted, lifestream);
      } catch (error) {
        throw unloaded(each.name, firstLine(error));
      }
      if ("faults" in result) throw unloaded(each.name, result.faults.map(([member, reason]) => `${member}: ${reason}`).join("; "));
      entry = result.entry;
      imported.set(each.entry, entry);
    } else admitHome(entry, each.name, admitted, lifestream);
    home.push({ folder: each.name, whose: "home", entry, digest: each.digest });
  }
  const set = [...base.entries, ...home];
  sets.set(root, { key, set });
  return set;
}

export const FOLDER_UNLOADED = "FOLDER_UNLOADED";

function unloaded(name: string, why: string): Error {
  return Object.assign(new Error(`the connector folder ${name} did not load in ${isMainThread ? "this process" : "a thread"}: ${why}`), { code: FOLDER_UNLOADED });
}

const sets = new Map<string, { key: string; set: readonly AdmittedFolder[] }>();

export function declaredOf(entries: readonly Entry[]): readonly Connector[] {
  return entries.flatMap((entry) => entry.connectors).map(withRoadDefaults).sort((a, b) => a.id.localeCompare(b.id));
}

export function connectorsNow(root: string): readonly Connector[] {
  return declaredOf((sets.get(root)?.set ?? releaseAdmitted().entries).map((each) => each.entry));
}

export function generationCode(root: string): string {
  return (handed(root)?.folders ?? []).map((each) => `${each.name} ${each.digest}`).join("\n");
}


const loadingFile = (root: string) => join(connectorsFolder(root), ".loading.json");

function loadingOf(root: string): Record<string, string> {
  try {
    const read = JSON.parse(readFileSync(loadingFile(root), "utf8")) as unknown;
    if (typeof read !== "object" || read === null || Array.isArray(read)) return {};
    return Object.fromEntries(Object.entries(read).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

export function loading(root: string, name: string, stamp: string | null): void {
  const { [name]: _was, ...rest } = loadingOf(root);
  const next = stamp === null ? rest : { ...rest, [name]: stamp };
  if (Object.keys(next).length === 0) rmSync(loadingFile(root), { force: true });
  else writeDurably(loadingFile(root), `${JSON.stringify(Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`);
}

export function folderFindings(root: string): { needs: Raised[]; notices: { id: string; what: string; since_ms: null }[] } {
  const generation = handed(root);
  if (generation === null) return { needs: [], notices: [] };
  const loaded = loadingOf(root);
  const changed = (name: string, path: string, was?: string) => {
    const now = folderStamp(path);
    return now !== was && loaded[name] !== now;
  };
  const needs: Raised[] = [];
  const notices: { id: string; what: string; since_ms: null }[] = [];
  const raise = (name: string, words: string, line: string, detail: string | null = null, connector: string | null = null) => needs.push({
    id: `folder:${name}`, state: "needs-you", reason: null, words, line, since_ms: null, next_ms: null, acts: [], detail, connector, copy: null, unit: null, at: null,
  });
  const restart = (name: string) => raise(name, `${name} changed`, "Restart Lifestream to load it");
  const known = new Map<string, string>([...generation.folders, ...generation.refused].map((each) => [each.name, each.stamp]));
  const installed = generation.refused.length === 0 ? {} : installedOrNone(root);
  for (const each of generation.refused) {
    for (const [member, reason] of each.faults) notices.push({ id: `folder:${each.name}`, what: `the connector folder ${each.name} did not load: ${member}: ${reason}`, since_ms: null });
    if (changed(each.name, each.path, each.stamp)) restart(each.name);
    else raise(each.name, `${each.name} didn't load`, ...refusedWords(root, each, installed[each.name]?.from), installed[each.name]?.ids[0] ?? null);
  }
  for (const each of generation.folders) if (changed(each.name, each.path, each.stamp)) restart(each.name);
  for (const name of homeFolders(root)) if (!known.has(name) && changed(name, join(connectorsFolder(root), name))) restart(name);
  return { needs, notices };
}

function refusedWords(root: string, refusal: Refusal, from: string | undefined): [line: string, detail: string] {
  const reason = refusal.faults[0]![1];
  if (refusal.transient === true) return ["Restart Lifestream to load it again", reason];
  const clash = clashOf(root, reason);
  if (clash !== null) return [`Another connector holds its ${clash.what}`, clash.words];
  return ["Its code has an error", `${reason}. Fix it, then run ${CLI} connectors install ${typed(from !== undefined && existsSync(from) ? from : refusal.path)}`];
}

function installedOrNone(root: string): Installed {
  try {
    return installedOf(root);
  } catch {
    return {};
  }
}
