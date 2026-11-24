import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, constants, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { faces } from "@lifestreamprotocol/connect";
import { cipherLoads, compareVersions, HOME_STORE, homeSchema, MIN_SQLITE, openHomeFolder, plainFolder, sqliteVersion, storeStamp, tryLock, type Form, type HomeFolder, type JsonObject, type Schema } from "@lifestreamprotocol/core";
import { ledgerSchema } from "@lifestreamprotocol/model";
import { folderTsconfig, typesOf } from "./conformance.js";
import { homeRegistryModule } from "./programs.js";
import { faceModels } from "./registry-home.js";
import { switchOf, type Switch } from "./catalog.js";
import { connectDigest, readerFor, loadRegistry } from "./registry.js";
import { hand, loadGeneration, SDK_SPECIFIER, waitsOnFolder } from "./folders.js";
import { HOME_FILE, startingSettings } from "./lifecycle.js";
import { effectiveOf, settingsPath } from "./settings.js";
import { checkFile, rootFiles, type RootFile } from "./home-file.js";
import { machine } from "./machine.js";
import { CLI } from "./cli-name.js";
import { RELEASE_KINDS } from "./templates.js";

const MANIFEST = "RELEASE.json";
const RELEASE_FILE = join("packages", "home", "release.json");
const KEEP_RELEASES = 5;
const SELF_CHECK_TIMEOUT_MS = 120_000;
const SMOKE_TIMEOUT_MS = 300_000;
export const RELEASE_ENTRIES = {
  home: "packages/home/cli.ts", door: "packages/home/door-main.ts", helper: "packages/home/helper.ts", reader: "packages/home/reader.ts", writer: "packages/home/writer.ts", copier: "packages/home/copier.ts", scanner: "packages/home/scanner.ts",
  call: "packages/model/call-main.ts", registry: "packages/home/registry-home.ts",
  runner: "packages/runner/main.ts", leash: "packages/runner/leash.ts",
  sdk: "packages/connect/sdk.ts", trial: "packages/home/trial.ts",
} as const;
export const JOBS = ["home", "door", "dashboard", "mcp", "runner"] as const;
const RELEASE_ENGINE = join("faces", ".build", "release", "face-engine");
const ENGINE_SOURCES = ["faces/Package.swift", "faces/Package.resolved", "faces/Sources", "faces/reference"];
const ENGINE_CHECKED = "checked.json";
const META_URL = ["import", "meta", "url"].join(".");
const CIPHER_PACKAGE = "better-sqlite3-multiple-ciphers";
const CIPHER_PLATFORMS = ["darwin-arm64", "darwin-x64"];
const STAMP_FILE = join("config", "stores.json");
const KEYED_SOURCES = "a keyed home's sources are checked when it starts";

export interface ReleaseManifest {
  commit: string;
  generation?: number;
  built_ms: number;
  home_db?: number;
  home_db_base?: number;
  ledger?: number;
  steps?: number;
  sqlite: string;
  platform?: string;
  node?: string;
  engine?: string;
  reads_keyed?: true;
}

export interface SelfCheck {
  sqlite: string;
  home_db: number;
  home_db_base: number;
  ledger: number;
  form: Form | null;
  cipher: { loads: true } | { failed: string };
  found: { home_db: number | null; ledger: number | null };
  sources?: string;
  problems: string[];
}

export interface InitSystem {
  restart(label: string): boolean;
  holds(label: string): boolean;
}

export function jobLabel(job: (typeof JOBS)[number]): string {
  return `org.lifestreamprotocol.${job}`;
}

export interface ReleaseHost {
  dir: string;
  root: string | null;
  init: InitSystem;
}

export interface BuildSteps {
  repo: string;
  commit: string;
  into: string;
  now?: () => number;
  node?: string;
  install?: (release: string) => void;
  compile?: (release: string, stamp: Stamp) => void;
  engine?: (release: string) => void;
}

export interface Stamp {
  commit: string;
  generation: number;
}

export interface Built {
  release: string;
  manifest: ReleaseManifest;
}

export interface Switched {
  release: string;
  previous: string | null;
  extension: string | null;
  self_check: SelfCheck | null;
  faces: JsonObject;
  restarted: string[];
  removed: string[];
}

export function currentRelease(dir: string): string | null {
  try {
    return basename(readlinkSync(join(dir, "current")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function readManifest(folder: string): ReleaseManifest | null {
  const path = join(folder, MANIFEST);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw error;
  }
  const manifest = JSON.parse(text) as Partial<ReleaseManifest>;
  if (typeof manifest.commit !== "string" || !Number.isSafeInteger(manifest.built_ms) || typeof manifest.sqlite !== "string" ||
    (manifest.generation !== undefined && !Number.isSafeInteger(manifest.generation)) ||
    (manifest.engine !== undefined && typeof manifest.engine !== "string") || (manifest.reads_keyed !== undefined && manifest.reads_keyed !== true)) {
    fail(`${path} is not a release of this home: move ${folder} aside`);
  }
  const versions = [manifest.home_db, manifest.home_db_base, manifest.ledger];
  if (versions.some((version) => version !== undefined && !Number.isSafeInteger(version)) || (manifest.steps !== undefined && !Number.isSafeInteger(manifest.steps))) {
    fail(`${path} is not a release of this home: move ${folder} aside`);
  }
  if (versions.some((version) => version === undefined) && manifest.steps === undefined) {
    fail(`${path} states neither the home.db and ledger versions it reads nor steps, so nothing can tell whether it reads the home: move ${folder} aside`);
  }
  return manifest as ReleaseManifest;
}

export function readRelease(dir: string, commit: string): ReleaseManifest | null {
  return readManifest(join(dir, "releases", commit));
}

export function builtReleases(dir: string): ReleaseManifest[] {
  const releases = join(dir, "releases");
  if (!existsSync(releases)) return [];
  return readdirSync(releases).flatMap((name) => readRelease(dir, name) ?? []).sort((left, right) =>
    left.generation !== undefined && right.generation !== undefined ? right.generation - left.generation : right.built_ms - left.built_ms);
}

export function platform(): string {
  return `${process.platform}-${process.arch}`;
}

export function buildRelease(steps: BuildSteps): Built {
  const commit = git(steps.repo, ["rev-parse", "--verify", `${steps.commit}^{commit}`]);
  return locked(steps.into, () => build(steps, commit));
}

function build(steps: BuildSteps, commit: string): Built {
  const release = join(steps.into, "releases", commit);
  const built = readManifest(release);
  if (built !== null) return { release, manifest: built };
  const partial = `${release}.partial`;
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { recursive: true });
  try {
    const archive = spawnSync("git", ["-C", steps.repo, "archive", "--format=tar", commit], { maxBuffer: 1 << 30 });
    checked(archive, "git archive");
    checked(spawnSync("tar", ["-x", "-C", partial], { input: archive.stdout }), "tar");
    const generation = Number(git(steps.repo, ["rev-list", "--count", commit]));
    readReleaseFile(partial, commit);
    const wanted = existsSync(join(partial, ".nvmrc")) ? `v${readFileSync(join(partial, ".nvmrc"), "utf8").trim().replace(/^v/u, "")}` : null;
    if (wanted === null) fail(`${commit} has no .nvmrc: a release carries the node it names`);
    const node = steps.node ?? process.execPath;
    const version = spawnSync(node, ["--version"], { encoding: "utf8" }).stdout?.trim() ?? "";
    if (version !== wanted) fail(`${commit}'s .nvmrc names node ${wanted}, and this build runs ${version || "no node"}: build with ${wanted}`);
    (steps.install ?? npmInstall)(partial);
    (steps.compile ?? compile)(partial, { commit, generation });
    const engine = engineHash(steps.repo, commit);
    placeEngine(steps.into, partial, engine, steps.engine ?? buildEngine);
    copyFileSync(node, join(partial, "node"), constants.COPYFILE_FICLONE);
    chmodSync(join(partial, "node"), 0o755);
    const check = runSelfCheck(partial, null);
    smokeTemplates(partial);
    const manifest: ReleaseManifest = {
      commit, generation, built_ms: (steps.now ?? Date.now)(),
      home_db: check.home_db, home_db_base: check.home_db_base, ledger: check.ledger, sqlite: check.sqlite, platform: platform(), node: version, engine, reads_keyed: true,
    };
    writeFileSync(join(partial, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    renameSync(partial, release);
    prune(steps.into, commit);
    return { release, manifest };
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw error;
  }
}

export function install(host: ReleaseHost, release: string): Switched {
  const manifest = readManifest(release) ?? fail(`${release} is not a release: it holds no ${MANIFEST}`);
  if (manifest.platform !== platform()) fail(`release ${manifest.commit} runs on ${manifest.platform ?? "a machine with its own node"}, not on this ${platform()}`);
  return locked(host.dir, () => {
    admit(host.root, manifest, "install");
    const placed = join(host.dir, "releases", manifest.commit);
    if (readManifest(placed) === null) {
      const partial = `${placed}.partial`;
      rmSync(partial, { recursive: true, force: true });
      mkdirSync(dirname(partial), { recursive: true });
      cpSync(release, partial, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
      rmSync(placed, { recursive: true, force: true });
      renameSync(partial, placed);
    }
    return switchTo(host, manifest.commit);
  });
}

export function rollback(host: ReleaseHost, to?: string): Switched {
  return locked(host.dir, () => {
    const previous = currentRelease(host.dir) ?? fail("no current release to roll back from");
    if (to === undefined) {
      const kept = builtReleases(host.dir).map((release) => `${release.commit}${release.commit === previous ? " (current)" : ""}`);
      fail(`deploy --rollback names the release to run: --to <sha>, one of the releases kept, newest first: ${kept.join(", ")}`);
    }
    const chosen = readRelease(host.dir, to) ?? fail(`no release ${to}`);
    admit(host.root, chosen, "rollback");
    if (chosen.node === undefined) fail(`release ${chosen.commit} carries no node of its own: it was built before releases did, and the jobs run the current release's node`);
    return switchTo(host, chosen.commit, false);
  });
}

function stamped(root: string, schema: Schema): number | null {
  return storeStamp(root)?.versions[schema.file] ?? null;
}

function admit(root: string | null, release: ReleaseManifest, by: "install" | "rollback"): void {
  if (release.generation === undefined) fail(`release ${release.commit} carries no generation: it was built before releases did, so nothing can tell whether it reads the home`);
  if (root === null) return;
  const path = join(root, "home.db");
  const folder = plainFolder(root);
  if (folder === null) {
    if (release.reads_keyed !== true) fail(`this home is encrypted, and release ${release.commit} was built before releases read an encrypted home: it would take home.db for a damaged file`);
    const version = stamped(root, homeSchema);
    if (version !== null) return admitAt(version, release);
    if (!existsSync(path)) return;
    if (by === "rollback") fail(`this home is encrypted and ${STAMP_FILE} does not say home.db's version, so no rollback can tell whether release ${release.commit} reads it: install a release, and the home's next start writes the file again`);
    const reads = release.home_db ?? release.steps!;
    if (reads < homeSchema.latest || (release.ledger ?? release.steps!) < ledgerSchema.latest) {
      fail(`this home is encrypted and ${STAMP_FILE} does not say home.db's version, so only a release at least as new as this one is installed: release ${release.commit} reads ${reads}, this one ${homeSchema.latest}`);
    }
    return;
  }
  if (!existsSync(path)) return;
  const db = folder.store(HOME_STORE, path, { mode: "read", mustExist: true, timeout: 5_000 });
  let version: number;
  try {
    version = homeSchema.version(db);
  } finally {
    db.close();
  }
  admitAt(version, release);
}

function admitAt(version: number, release: ReleaseManifest): void {
  const reads = release.home_db ?? release.steps!;
  const base = release.home_db_base ?? release.steps!;
  if (version > reads) fail(`home.db is at version ${version}; release ${release.commit} reads ${reads}: fix forward`);
  if (version !== 0 && version < base) fail(`home.db is at version ${version}; release ${release.commit} reads ${reads} and moves a file forward from ${base} at the oldest: install a release between them first`);
}

function switchTo(host: ReleaseHost, commit: string, check = true): Switched {
  const previous = currentRelease(host.dir);
  const self_check = check ? runSelfCheck(join(host.dir, "releases", commit), host.root) : null;
  const engine = !check ? { skipped: "a rollback runs no checks" } : host.root === null ? { skipped: "this machine holds no home" } : checkFaces(host.dir, commit, host.root);
  const extension = placeExtension(host.dir, commit);
  point(join(host.dir, "current"), join("releases", commit));
  const restarted: string[] = [];
  const failed: string[] = [];
  for (const label of JOBS.map(jobLabel)) {
    try {
      if (host.init.restart(label)) restarted.push(label);
    } catch (error) {
      failed.push(`${label}: ${(error as Error).message}`);
    }
  }
  const removed = prune(host.dir, currentRelease(host.dir));
  if (failed.length > 0) {
    fail(`release ${commit} is current, and a restart failed (${failed.join("; ")}); restarted: ${restarted.join(", ") || "none"}. Fix what it names, then install again`);
  }
  return { release: commit, previous, extension, self_check, faces: engine, restarted, removed };
}

function locked<T>(dir: string, run: () => T): T {
  mkdirSync(join(dir, "releases"), { recursive: true });
  const lock = tryLock(join(dir, "release.lock")) ?? fail(`another build or install holds ${join(dir, "release.lock")}`);
  try {
    return run();
  } finally {
    lock.release();
  }
}

export async function selfCheckHere(root: string | null, registryModule: string = homeRegistryModule().href, cipherProbe: () => string | null = cipherLoads): Promise<SelfCheck> {
  const sqlite = sqliteVersion();
  const problems: string[] = [];
  if (compareVersions(sqlite, MIN_SQLITE) < 0) problems.push(`SQLite ${sqlite} is older than ${MIN_SQLITE}`);
  const plain = root === null ? null : plainFolder(root);
  const form = root === null ? null : plain === null ? "keyed" : "plain";
  const cipher = cipherOf(cipherProbe);
  if (form === "keyed" && "failed" in cipher) problems.push(`this home is encrypted, and this release's cipher engine does not load here: ${cipher.failed}`);
  const found: SelfCheck["found"] = { home_db: null, ledger: null };
  if (root !== null) {
    for (const [name, file] of Object.entries(rootFiles(root)) as [keyof SelfCheck["found"], RootFile][]) {
      const { schema } = file;
      if (plain === null) {
        const version = stamped(root, schema);
        found[name] = version === 0 ? null : version;
        const refused = version === null ? null : stampRefusal(version, schema);
        if (refused !== null) problems.push(refused);
        continue;
      }
      try {
        const { version, refused } = checkFile(plain, file);
        found[name] = version;
        if (refused !== null) problems.push(refused);
      } catch (error) {
        problems.push((error as Error).message);
      }
    }
  }
  const starts = root !== null && existsSync(join(root, HOME_FILE));
  if (starts && root !== null) problems.push(...await startProblems(root, plain, registryModule));
  return { sqlite, home_db: homeSchema.latest, home_db_base: homeSchema.base, ledger: ledgerSchema.latest, form, cipher, found, ...(starts && form === "keyed" ? { sources: KEYED_SOURCES } : {}), problems };
}

function cipherOf(probe: () => string | null): SelfCheck["cipher"] {
  const failed = probe();
  return failed === null ? { loads: true } : { failed };
}

function stampRefusal(version: number, schema: Schema): string | null {
  if (version === 0) return null;
  if (version > schema.latest) return schema.refusal(version);
  if (version < schema.base) return `${schema.name} is at version ${version}; this release reads ${schema.latest} and moves a file forward from ${schema.base} at the oldest: a release between them moves it first`;
  return null;
}

async function startProblems(root: string, folder: HomeFolder | null, registryModule: string): Promise<string[]> {
  const path = join(root, "home.db");
  let registry;
  let off: Switch;
  try {
    const at = machine();
    const { settings } = effectiveOf(startingSettings(folder ?? root, at), settingsPath(root));
    hand(await loadGeneration({ root, machineDir: at.dir }));
    registry = await loadRegistry(registryModule, settings, { root, folder: () => folder ?? openHomeFolder(root) });
    off = switchOf(registry.connectors, settings.sources.off);
  } catch (error) {
    return [`a home of this release cannot start: ${(error as Error).message}`];
  }
  if (folder === null || !existsSync(path)) return [];
  const problems: string[] = [];
  const db = folder.store(HOME_STORE, path, { mode: "read", mustExist: true, timeout: 5_000 });
  try {
    const meta = db.prepare("SELECT value FROM meta WHERE key = ?").pluck();
    const waits = (connector: string) => waitsOnFolder(root, (key) => meta.get(key) as string | undefined, connector);
    for (const source of db.prepare("SELECT id, connector, options FROM sources ORDER BY id").all() as { id: string; connector: string; options: string }[]) {
      const options = JSON.parse(source.options) as JsonObject;
      if (off.source({ id: source.id, connector: source.connector, options })) continue;
      if (readerFor(registry, source) === undefined && !waits(source.connector)) problems.push(`source ${source.id} names connector ${source.connector}, which this release lacks`);
    }
  } finally {
    db.close();
  }
  return problems;
}

function runSelfCheck(release: string, root: string | null): SelfCheck {
  const result = spawnSync(join(release, "node"), [join(release, "dist", "home.mjs"), "self-check", ...(root === null ? [] : ["--root", root])], {
    encoding: "utf8", timeout: SELF_CHECK_TIMEOUT_MS, maxBuffer: 1 << 24,
  });
  const last = result.stdout?.trim().split("\n").at(-1) ?? "";
  let check: SelfCheck | null = null;
  try {
    check = JSON.parse(last) as SelfCheck;
  } catch {
  }
  if (check === null || typeof check !== "object" || !Array.isArray(check.problems)) {
    return fail(`the self-check of ${basename(release)} failed: ${result.error?.message ?? lastWords(result.stderr) ?? lastWords(result.stdout) ?? `exit ${result.status}`}`);
  }
  const problems = [...check.problems];
  if (compareVersions(check.sqlite, MIN_SQLITE) < 0) problems.push(`SQLite ${check.sqlite} is older than ${MIN_SQLITE}`);
  if (result.status !== 0 || problems.length > 0) fail(`the self-check of ${basename(release)} refused: ${[...new Set(problems)].join("; ") || `exit ${result.status}`}`);
  return check;
}

function smokeTemplates(release: string): void {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "lifestream-release-smoke-")));
  try {
    const env = { ...process.env, LIFESTREAM_MACHINE_DIR: join(scratch, "machine") };
    const run = (args: readonly string[]) => spawnSync(join(release, "node"), [join(release, "dist", "home.mjs"), "connectors", ...args], {
      cwd: scratch, env, encoding: "utf8", timeout: SMOKE_TIMEOUT_MS, maxBuffer: 1 << 26,
    });
    const said = (result: ReturnType<typeof run>) => result.error?.message ?? lastWords(`${result.stdout ?? ""}\n${result.stderr ?? ""}`) ?? `exit ${result.status}`;
    const listed = run(["new"]);
    if (listed.error !== undefined || listed.status !== 0) fail(`the pruned release could not list its home templates (${CLI} connectors new): ${said(listed)}`);
    const kinds = listed.stdout.split("\n").flatMap((line) => /^ {2}([a-z][a-z-]*) {2,}\S/u.exec(line)?.[1] ?? []);
    if (kinds.length === 0) fail(`the pruned release lists no home template (${CLI} connectors new printed ${JSON.stringify(listed.stdout.trim())})`);
    for (const kind of kinds) {
      const folder = join(scratch, `smoke-${kind}`);
      const made = run(["new", kind, `smoke-${kind}`, "--into", folder]);
      if (made.error !== undefined || made.status !== 0) fail(`the pruned release could not make its ${kind} template (${CLI} connectors new ${kind}): ${said(made)}`);
      const tested = run(["test", folder]);
      if (tested.error !== undefined || tested.status !== 0) {
        const faults = `${tested.stdout ?? ""}`.split("\n").filter((line) => line.trim() !== "").slice(0, 5);
        fail(`the pruned release's ${kind} template fails its test (${CLI} connectors test, in ${folder}): ${faults.length > 0 ? faults.join("; ") : said(tested)}`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function checkFaces(dir: string, commit: string, root: string): JsonObject {
  const release = join(dir, "releases", commit);
  const engine = join(release, RELEASE_ENGINE);
  if (!existsSync(engine)) return { skipped: "the release carries no face engine" };
  const models = faceModels(root);
  if (!faces.modelsInstalled(models)) return { skipped: `no face models are installed at ${models} (${CLI} faces on)` };
  const hash = readRelease(dir, commit)?.engine;
  const record = hash === undefined ? null : join(dir, "engines", hash, ENGINE_CHECKED);
  const sums: JsonObject = Object.fromEntries(readdirSync(models, { withFileTypes: true }).filter((entry) => entry.isFile()).map(({ name }) => name).sort()
    .map((file) => [file, createHash("sha256").update(readFileSync(join(models, file))).digest("hex")]));
  if (record !== null && existsSync(record) && JSON.stringify((JSON.parse(readFileSync(record, "utf8")) as { models?: unknown }).models) === JSON.stringify(sums)) {
    return { unchanged: hash! };
  }
  let check: JsonObject;
  try {
    check = faces.checkEngine(engine, models, join(release, "faces", "reference"));
  } catch (error) {
    return fail(`the face engine of ${commit} refused: ${(error as Error).message}`);
  }
  if (record !== null) {
    mkdirSync(dirname(record), { recursive: true });
    writeFileSync(`${record}.next`, `${JSON.stringify({ models: sums, check })}\n`);
    renameSync(`${record}.next`, record);
  }
  return check;
}

function engineHash(repo: string, commit: string): string {
  return createHash("sha256").update(git(repo, ["ls-tree", "--full-tree", commit, "--", ...ENGINE_SOURCES])).digest("hex");
}

function placeEngine(into: string, release: string, hash: string, build: (release: string) => void): void {
  const kept = join(into, "engines", hash);
  if (!existsSync(join(kept, "face-engine"))) {
    build(release);
    const partial = `${kept}.partial`;
    rmSync(partial, { recursive: true, force: true });
    mkdirSync(partial, { recursive: true });
    renameSync(join(release, RELEASE_ENGINE), join(partial, "face-engine"));
    rmSync(kept, { recursive: true, force: true });
    renameSync(partial, kept);
  }
  rmSync(join(release, "faces", ".build"), { recursive: true, force: true });
  mkdirSync(join(release, dirname(RELEASE_ENGINE)), { recursive: true });
  copyFileSync(join(kept, "face-engine"), join(release, RELEASE_ENGINE), constants.COPYFILE_FICLONE);
  chmodSync(join(release, RELEASE_ENGINE), 0o755);
}

function readReleaseFile(release: string, commit: string): void {
  const where = `${commit}:${RELEASE_FILE}`;
  const stated = JSON.parse(readFileSync(join(release, RELEASE_FILE), "utf8")) as { floors?: { extension?: unknown }; published?: { extension?: unknown } };
  if (typeof stated !== "object" || stated === null || Object.keys(stated).some((key) => !["floors", "published"].includes(key))) {
    fail(`${where} must be {"floors": {…}, "published": {"extension": "<version>"}}`);
  }
  const extension = stated.floors?.extension;
  if (extension !== undefined) {
    const published = stated.published?.extension;
    if (typeof published !== "string" || !/^\d+(?:\.\d+)*$/u.test(published)) fail(`${where} states an extension floor, so it states published.extension: the newest version the Chrome Web Store serves`);
    if (compareVersions(String(extension), published) > 0) {
      fail(`${where} raises the extension's floor to ${String(extension)}, above ${published}, the newest version the Chrome Web Store serves (published.extension): raise it once the store serves it`);
    }
  }
}

function prune(dir: string, current: string | null): string[] {
  const keep = new Set([...builtReleases(dir).slice(0, KEEP_RELEASES).map((release) => release.commit), current]);
  const removed = readdirSync(join(dir, "releases")).filter((name) => !keep.has(name));
  for (const name of removed) rmSync(join(dir, "releases", name), { recursive: true, force: true });
  const named = new Set(builtReleases(dir).flatMap((release) => release.engine ?? []));
  const engines = existsSync(join(dir, "engines")) ? readdirSync(join(dir, "engines")).filter((name) => !named.has(name)) : [];
  for (const name of engines) rmSync(join(dir, "engines", name), { recursive: true, force: true });
  return [...removed, ...engines.map((name) => `engines/${name}`)];
}


function placeExtension(dir: string, commit: string): string | null {
  const built = join(dir, "releases", commit, "extension", "dist");
  if (!existsSync(join(built, "manifest.json"))) return null;
  const folder = join(dir, "extension");
  const next = `${folder}.next`;
  const old = `${folder}.old`;
  rmSync(next, { recursive: true, force: true });
  rmSync(old, { recursive: true, force: true });
  cpSync(built, next, { recursive: true, mode: constants.COPYFILE_FICLONE });
  if (existsSync(folder)) renameSync(folder, old);
  renameSync(next, folder);
  rmSync(old, { recursive: true, force: true });
  return folder;
}

function point(path: string, target: string): void {
  const next = `${path}.next`;
  rmSync(next, { force: true });
  symlinkSync(target, next);
  renameSync(next, path);
}

function buildEngine(release: string): void {
  const built = spawnSync("swift", ["build", "-c", "release", "--package-path", join(release, "faces")], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 1 << 26 });
  if (built.error === undefined && built.status !== 0) {
    const said = `${built.stdout}\n${built.stderr}`.split("\n").filter((line) => /\berror:/u.test(line)).slice(0, 12);
    fail(`swift build of the face engine failed:\n${said.length === 0 ? `exit ${built.status}` : said.join("\n")}`);
  }
  checked(built, "swift build of the face engine");
  if (!existsSync(join(release, RELEASE_ENGINE))) fail("swift build of the face engine wrote no faces/.build/release/face-engine");
}

function npmInstall(release: string): void {
  const npm = (folder: string, what: string, ...args: string[]) =>
    checked(spawnSync("npm", ["ci", "--prefer-offline", "--no-audit", "--no-fund", ...args], { cwd: join(release, folder), stdio: ["ignore", "ignore", "pipe"], maxBuffer: 1 << 26 }), what);
  npm(".", "npm ci");
  npm("extension", "npm ci of the extension");
  npm("dashboard", "npm ci of the dashboard", "--omit=dev");
  npm("mcp", "npm ci of the MCP server", "--omit=dev");
}

function buildExtension(release: string): void {
  const env = { ...process.env, LIFESTREAM_DEVELOPMENT: "1" };
  checked(spawnSync(process.execPath, [join(release, "extension", "build.mjs")], { cwd: join(release, "extension"), env, encoding: "utf8" }), "building the extension");
}

function compile(release: string, stamp: Stamp): void {
  bundleEntries(release, stamp);
  emitTypes(release);
  buildExtension(release);
  checked(spawnSync("npm", ["prune", "--omit=dev", "--no-audit", "--no-fund"], { cwd: release, stdio: ["ignore", "ignore", "pipe"], maxBuffer: 1 << 26 }), "npm prune");
  rmSync(join(release, "extension", "node_modules"), { recursive: true, force: true });
  builtForThisPlatform(release);
  checkTypes(release);
}

const TYPES_TSCONFIG = join("packages", "home", "tsconfig.types.json");

export function emitTypes(release: string, into = join(release, "dist", "types")): void {
  const tsc = join(release, "node_modules", "typescript", "bin", "tsc");
  const emit = spawnSync(process.execPath, [tsc, "-p", join(release, TYPES_TSCONFIG), "--outDir", into], { cwd: release, encoding: "utf8", maxBuffer: 1 << 26 });
  if (emit.error !== undefined || emit.status !== 0) fail(`the SDK's declarations: ${emit.error?.message ?? (emit.stdout.split("\n").filter((line) => line.startsWith("packages/") || line.startsWith("error ")).slice(0, 5).join("; ") || `exit ${emit.status}`)}`);
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith(".d.ts") ? [join(dir, entry.name)] : []));
  for (const file of walk(into)) {
    const text = readFileSync(file, "utf8");
    const core = relative(dirname(file), join(into, "core", "index.js"));
    const linked = text.replace(/(from |import\()"@lifestreamprotocol\/core"/gu, (_, before: string) => `${before}${JSON.stringify(core.startsWith(".") ? core : `./${core}`)}`);
    if (linked !== text) writeFileSync(file, linked);
  }
  const held = new Set(walk(into).flatMap((file) => [...readFileSync(file, "utf8").matchAll(/(?:from |import\()"(@lifestreamprotocol\/[^"]+)"/gu)].map((match) => match[1]!)));
  const unmapped = [...held].filter((specifier) => specifier !== SDK_SPECIFIER).sort();
  if (unmapped.length > 0) fail(`the SDK's declarations import ${unmapped.join(", ")}, which a home folder cannot reach: its types come through ${SDK_SPECIFIER} alone`);
}

export function checkTypes(release: string, folders: readonly string[] = []): void {
  const templates = join(release, "packages", "connect", "templates");
  const scratch = mkdtempSync(join(tmpdir(), "lifestream-release-types-"));
  try {
    const drafts = readdirSync(templates, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !RELEASE_KINDS.has(entry.name)).map((entry) => {
      const draft = join(scratch, entry.name);
      cpSync(join(templates, entry.name), draft, { recursive: true, filter: (path) => basename(path) !== "e2e.test.ts" });
      return draft;
    });
    const ts = createRequire(join(release, "package.json"))("typescript") as typeof import("typescript");
    const cachedSources = new Map<string, import("typescript").SourceFile>();
    const tsconfig = `${JSON.stringify(folderTsconfig(typesOf(release, true)), null, 2)}\n`;
    const listed = [...drafts, ...folders].map((folder) => {
      if (!existsSync(join(folder, "tsconfig.json"))) writeFileSync(join(folder, "tsconfig.json"), tsconfig);
      const read = ts.readConfigFile(join(folder, "tsconfig.json"), ts.sys.readFile);
      if (read.error !== undefined) fail(`listing ${folder}'s program: ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}`);
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, folder);
      const host = ts.createCompilerHost(parsed.options);
      const own = realpathSync(folder);
      const realGetSourceFile = host.getSourceFile.bind(host);
      host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
        const cacheable = fileName.endsWith(".d.ts");
        const key = `${fileName}\0${typeof languageVersion === "number" ? languageVersion : languageVersion.languageVersion}`;
        if (cacheable) {
          const hit = cachedSources.get(key);
          if (hit !== undefined) return hit;
        }
        const source = realGetSourceFile(fileName, languageVersion, onError, shouldCreate);
        if (cacheable && source !== undefined) cachedSources.set(key, source);
        return source;
      };
      const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true }, host);
      const sources = program.getSourceFiles().map((file) => file.fileName).filter((path) => path !== "" && !path.endsWith(".d.ts") && !realpathSync(path).startsWith(`${own}/`));
      return [basename(folder), sources] as const;
    });
    const faults = listed.filter(([, sources]) => sources.length > 0).map(([name, sources]) => `${name} compiles ${sources.join(", ")}`);
    if (faults.length > 0) fail(`a home folder's program holds the release's source, not its declarations (dist/types): ${faults.join("; ")}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function builtForThisPlatform(release: string): void {
  const built = join(release, "node_modules", "onnxruntime-node", "bin", "napi-v6");
  if (!existsSync(join(built, process.platform, process.arch))) fail(`onnxruntime-node carries no built library for ${platform()}`);
  for (const os of readdirSync(built)) {
    if (os !== process.platform) rmSync(join(built, os), { recursive: true, force: true });
    else for (const arch of readdirSync(join(built, os))) if (arch !== process.arch) rmSync(join(built, os, arch), { recursive: true, force: true });
  }
  pruneCipher(release);
}

export function pruneCipher(release: string, on: string = platform()): void {
  const placed = [join(release, "node_modules", CIPHER_PACKAGE), join(release, "packages", "core", "node_modules", CIPHER_PACKAGE)].filter((folder) => existsSync(folder));
  if (placed.length === 0) fail(`the release carries no ${CIPHER_PACKAGE}: an encrypted home could not open its stores`);
  for (const folder of placed) {
    const prebuilds = join(folder, "prebuilds");
    const kept = existsSync(prebuilds) ? readdirSync(prebuilds).filter((name) => CIPHER_PLATFORMS.includes(name.replace(/\.node$/u, ""))) : [];
    if (!kept.includes(`${on}.node`)) fail(`${CIPHER_PACKAGE} carries no prebuilt engine for ${on}`);
    for (const name of readdirSync(prebuilds)) if (!kept.includes(name)) rmSync(join(prebuilds, name), { recursive: true, force: true });
    for (const sources of ["deps", "src", "build"]) rmSync(join(folder, sources), { recursive: true, force: true });
  }
}

export function bundleEntries(release: string, { commit, generation }: Stamp): void {
  const connect = connectDigest(join(release, "packages", "connect"));
  const script = `
const esbuild = require(${JSON.stringify(createRequire(join(release, "package.json")).resolve("esbuild"))});
const { readFileSync, realpathSync } = require("node:fs");
const { join, relative, sep } = require("node:path");
const root = realpathSync(${JSON.stringify(release)});
const dist = join(root, "dist");
const entries = ${JSON.stringify(RELEASE_ENTRIES)};
const exported = (name, subpath) => {
  const manifest = JSON.parse(readFileSync(join(root, "packages", name, "package.json"), "utf8"));
  const path = manifest.exports && manifest.exports[subpath === undefined ? "." : "./" + subpath];
  if (typeof path !== "string") throw new Error("@lifestreamprotocol/" + name + " exports no " + (subpath ?? "."));
  return join(root, "packages", name, path);
};
Promise.all(Object.entries(entries).map(([name, path]) => {
  const entry = join(root, path);
  return esbuild.build({
    entryPoints: [entry], outfile: join(dist, name + ".mjs"), bundle: true, platform: "node", format: "esm", target: "node22",
    define: { LIFESTREAM_RELEASE: JSON.stringify(${JSON.stringify(commit)}), LIFESTREAM_GENERATION: "${generation}", LIFESTREAM_CONNECT: JSON.stringify(${JSON.stringify(connect)}) }, logLevel: "silent",
    plugins: [{ name: "release", setup(build) {
      build.onResolve({ filter: /^@lifestreamprotocol\\// }, ({ path }) => {
        const [, name, subpath] = /^@lifestreamprotocol\\/([^/]+)(?:\\/(.+))?$/.exec(path);
        return { path: exported(name, subpath) };
      });
      build.onResolve({ filter: /^[^./]/ }, ({ path }) => ({ path, external: true }));
      build.onLoad({ filter: /\\.ts$/ }, ({ path }) => {
        const source = readFileSync(path, "utf8");
        if (realpathSync(path) === entry) return { contents: source, loader: "ts" };
        const at = relative(dist, realpathSync(path)).split(sep).join("/");
        return { contents: source.replaceAll(${JSON.stringify(META_URL)}, "new URL(" + JSON.stringify(at) + ", " + ${JSON.stringify(META_URL)} + ").href"), loader: "ts" };
      });
    } }],
  });
})).catch((error) => { process.stderr.write(String(error && error.message || error) + "\\n"); process.exit(1); });
`;
  checked(spawnSync(process.execPath, ["-e", script], { cwd: release, encoding: "utf8" }), `compiling ${commit}`);
}

function git(repo: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 1 << 26 });
  checked(result, `git ${args[0]}`);
  return result.stdout.trim();
}

function checked(result: ReturnType<typeof spawnSync>, what: string): void {
  if (result.error !== undefined) fail(`${what}: ${result.error.message}`);
  if (result.status !== 0) fail(`${what} failed: ${lastWords(String(result.stderr ?? "")) ?? `exit ${result.status}`}`);
}

function lastWords(output: string | Buffer | null | undefined): string | undefined {
  const lines = String(output ?? "").split("\n").map((line) => line.trimEnd()).filter((line) => line.trim() !== "" && !/^Node\.js v\d/u.test(line));
  return lines.findLast((line) => /^\w*Error\b/u.test(line)) ?? lines.at(-1);
}

export interface Launchd {
  launchctl?: (args: string[]) => { status: number | null; stdout: string; stderr: string };
  alive?: (pid: number) => boolean;
  kill?: (pid: number) => void;
  stopMs?: number;
}

const STOP_MS = 60_000;
const LAUNCHCTL_MS = 70_000;
const NOT_HELD = 113;

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function launchd(options: Launchd = {}): InitSystem {
  const launchctl = options.launchctl ?? ((args: string[]) => {
    const result = spawnSync("launchctl", args, { encoding: "utf8", timeout: LAUNCHCTL_MS });
    const failed = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ? `no answer within ${LAUNCHCTL_MS / 1000} s` : result.error?.message;
    return { status: result.status, stdout: result.stdout ?? "", stderr: failed ?? result.stderr ?? "" };
  });
  const alive = options.alive ?? ((pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  });
  const kill = options.kill ?? ((pid: number) => {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  });
  const stopMs = options.stopMs ?? STOP_MS;
  const ends = (pid: number): boolean => {
    for (let waited = 0; waited < stopMs; waited += 100) {
      if (!alive(pid)) return true;
      pause(100);
    }
    return !alive(pid);
  };
  const domain = `gui/${process.getuid?.() ?? 0}`;
  const run = (args: string[]) => {
    const result = launchctl(args);
    if (result.status !== 0) fail(`launchctl ${args[0]} failed: ${result.stderr.trim().split("\n").at(-1) || `exit ${result.status}`}`);
    return result.stdout;
  };
  return {
    holds(label) {
      const printed = launchctl(["print", `${domain}/${label}`]);
      if (printed.status === NOT_HELD) return false;
      if (printed.status !== 0) fail(`launchctl print failed: ${printed.stderr.trim().split("\n").at(-1) || `exit ${printed.status}`}`);
      return true;
    },
    restart(label) {
      const printed = launchctl(["print", `${domain}/${label}`]);
      if (printed.status === NOT_HELD) return false;
      if (printed.status !== 0) fail(`launchctl print failed: ${printed.stderr.trim().split("\n").at(-1) || `exit ${printed.status}`}`);
      const pid = Number(/^\s*pid = (\d+)$/mu.exec(printed.stdout)?.[1] ?? 0);
      if (pid > 0) {
        run(["kill", "SIGTERM", `${domain}/${label}`]);
        if (!ends(pid)) {
          if (label !== jobLabel("home")) fail(`${label} (pid ${pid}) still runs ${stopMs / 1000} s after SIGTERM`);
          kill(pid);
          if (!ends(pid)) fail(`${label} (pid ${pid}) still runs ${stopMs / 1000} s after SIGKILL`);
        }
      }
      run(["kickstart", `${domain}/${label}`]);
      return true;
    },
  };
}

function fail(message: string): never {
  throw new Error(message);
}
