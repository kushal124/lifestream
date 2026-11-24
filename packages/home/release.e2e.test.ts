import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { formOf, homeSchema, openHome, openHomeFolder, tryLock, type Tx } from "@lifestreamprotocol/core";
import { ledgerSchema, openLedger, RUNNER_WIRE_VERSION } from "@lifestreamprotocol/model";
import { buildRelease, builtReleases, bundleEntries, currentRelease, install, JOBS, jobLabel, launchd, platform, pruneCipher, readManifest, rollback, selfCheckHere, type BuildSteps, type ReleaseHost } from "./release.js";
import { removeDir, tempDir, writeArtifact, writeFolder } from "./test/ops-support.js";
import { startHome } from "./home.js";
import { mintPrincipal } from "./principals.js";
import { FAKES, until, TICK_MS } from "./test/harness-root.js";
import { homeRegistryModule, repoRoot } from "./programs.js";
import { declarations, vendorOf } from "@lifestreamprotocol/connect";

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()!();
});

const DRIVER = createRequire(import.meta.url).resolve("better-sqlite3");
const FAKE_ENGINE = fileURLToPath(new URL("../connect/labelers/faces/test/fake-engine.mjs", import.meta.url));
const KEYED_PROBE = fileURLToPath(new URL("../core/test/engine-probe.ts", import.meta.url));
const NVMRC = { ".nvmrc": `${process.version.slice(1)}\n` };
const PAGE_FILES = {
  "design/css/cockpit.css": ":root { --synthetic: 1; }\n",
  "design/river/river-2000.webp": Buffer.from("52494646100000005745425056503820ff00fe80", "hex"),
  "design/river/river-960.webp": Buffer.from("52494646100000005745425056503820000d0a1a", "hex"),
  "design/river/geist.woff2": Buffer.from("774f463200010000ff0080c3", "hex"),
};

function git(repo: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", repo, "-c", "user.name=Synthetic", "-c", "user.email=person-a@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function commit(repo: string, files: Record<string, string | Buffer>, message: string): string {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

function compile(release: string): void {
  mkdirSync(join(release, "dist"), { recursive: true });
  writeFileSync(join(release, "dist", "home.mjs"), `
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const Database = createRequire(import.meta.url)(${JSON.stringify(DRIVER)});
const file = (name) => new URL("../" + name, import.meta.url);
const said = process.argv.slice(2);
if (said[0] === "connectors") {
  const kinds = existsSync(file("kinds.txt")) ? readFileSync(file("kinds.txt"), "utf8").split(/\\s+/).filter(Boolean) : ["api"];
  const faulty = existsSync(file("smoke-fault.txt")) ? readFileSync(file("smoke-fault.txt"), "utf8").trim() : null;
  if (said[1] === "new" && said.length === 2) {
    process.stdout.write("usage: lifestream connectors new <kind> <id>, a kind one of:\\n" + kinds.map((kind) => "  " + kind + "  a synthetic kind.\\n").join(""));
  } else if (said[1] === "new" && said[4] === "--into") {
    mkdirSync(said[5], { recursive: true });
    writeFileSync(join(said[5], "kind.txt"), said[2]);
  } else if (said[1] === "test" && existsSync(join(said[2], "kind.txt"))) {
    const kind = readFileSync(join(said[2], "kind.txt"), "utf8");
    if (kind === faulty) {
      process.stdout.write("reader.ts:3:1 a synthetic fault over " + said[2] + " from " + process.cwd() + "\\n");
      process.stderr.write("Error: smoke-" + kind + " fails the conformance run: 1 fault\\n");
      process.exit(1);
    }
    process.stdout.write("smoke-" + kind + " passes the conformance run\\n");
  } else {
    process.stderr.write("Error: no such folder verb: " + said.join(" ") + "\\n");
    process.exit(2);
  }
  process.exit(0);
}
const versions = JSON.parse(readFileSync(file("versions.txt"), "utf8"));
const sqlite = existsSync(file("sqlite.txt")) ? readFileSync(file("sqlite.txt"), "utf8").trim()
  : new Database(":memory:").prepare("SELECT sqlite_version()").pluck().get();
const at = process.argv.indexOf("--root");
// A release that cannot start on the home: it throws, as a module that fails to load does, or ends saying nothing.
if (at > 0 && existsSync(file("crash.txt"))) throw new Error(readFileSync(file("crash.txt"), "utf8").trim());
if (at > 0 && existsSync(file("silent.txt"))) process.exit(3);
const found = { home_db: null, ledger: null };
const header = (path) => existsSync(path) && readFileSync(path).subarray(0, 16).toString("latin1") === "SQLite format 3\\0";
if (at > 0 && header(process.argv[at + 1] + "/home.db")) {
  const db = new Database(process.argv[at + 1] + "/home.db", { readonly: true });
  found.home_db = db.prepare("SELECT user_version FROM pragma_user_version").pluck().get();
  db.close();
}
process.stdout.write(JSON.stringify({ sqlite, ...versions, found, problems: [] }) + "\\n");
`);
  mkdirSync(join(release, "extension", "dist"), { recursive: true });
  writeFileSync(join(release, "extension", "dist", "manifest.json"), JSON.stringify({ name: "Lifestream", built_in: basename(release).replace(/\.partial$/u, "") }));
}

function engine(release: string): void {
  mkdirSync(join(release, "faces", ".build", "release"), { recursive: true });
  writeFileSync(join(release, "faces", ".build", "release", "face-engine"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

function fakeLaunchd(held: readonly string[], app = false, dir?: string, refusing = new Set<string>(), deaf = new Map<string, readonly string[]>()) {
  const running = new Map<string, ChildProcess>();
  const on = new Map<string, string | null>();
  const started: ChildProcess[] = [];
  const calls: string[][] = [];
  const launchctl = (args: string[]) => {
    calls.push(args);
    const [verb] = args;
    const label = args.at(-1)!.split("/").at(-1)!;
    if (!held.includes(label)) return { status: 113, stdout: "", stderr: `Could not find service "${label}" in domain for user gui: 501` };
    if (verb === "print") return { status: 0, stdout: `${label} = {\n${app ? "\tmanaged_by = com.apple.xpc.ServiceManagement\n" : ""}\tstate = ${running.has(label) ? "running" : "not running"}\n${running.has(label) ? `\tpid = ${running.get(label)!.pid}\n` : ""}}\n`, stderr: "" };
    if (verb === "kill" && args[1] === "SIGTERM") {
      if (!deaf.get(label)?.includes("SIGTERM")) {
        running.get(label)?.kill("SIGTERM");
        running.delete(label);
      }
      return { status: 0, stdout: "", stderr: "" };
    }
    if (verb === "kickstart") {
      if (refusing.has(label)) return { status: 5, stdout: "", stderr: "Input/output error" };
      if (!running.has(label)) {
        const child = spawn("/bin/sleep", ["86400"], { stdio: "ignore" });
        started.push(child);
        running.set(label, child);
        if (dir !== undefined) on.set(label, currentRelease(dir));
      }
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 64, stdout: "", stderr: `launchctl ${verb} is not one an install runs` };
  };
  const alive = (pid: number) => [...running.values()].some((child) => child.pid === pid);
  const killed: number[] = [];
  const kill = (pid: number) => {
    killed.push(pid);
    const [label] = [...running].find(([, child]) => child.pid === pid) ?? [];
    if (label === undefined || deaf.get(label)?.includes("SIGKILL")) return;
    running.get(label)!.kill("SIGKILL");
    running.delete(label);
  };
  const kickstarts = (job: string) => calls.filter(([verb, target]) => verb === "kickstart" && target!.endsWith(`/${jobLabel(job as (typeof JOBS)[number])}`)).length;
  const stop = () => { for (const child of started.splice(0)) child.kill("SIGKILL"); };
  return { init: launchd({ launchctl, alive, kill, stopMs: 500 }), running, on, calls, kickstarts, killed, stop };
}

function versions(home_db: number, home_db_base = home_db, ledger = 1): string {
  return JSON.stringify({ home_db, home_db_base, ledger });
}

function setHomeVersion(root: string, version: number): void {
  const db = new Database(join(root, "home.db"));
  db.pragma(`user_version = ${version}`);
  db.close();
}

function setOldScheme(root: string, steps: number): void {
  const db = new Database(join(root, "home.db"));
  db.pragma("user_version = 0");
  db.prepare("INSERT INTO meta (key, value) VALUES ('steps', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(steps));
  db.close();
}

function nodeScript(dir: string): string {
  const path = join(dir, "node");
  writeFileSync(path, `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
  return path;
}

function ticks(): () => number {
  let tick = 0;
  return () => Date.UTC(2026, 9, 1) + 1_000 * tick++;
}

describe("releases", () => {
  it("deploy --rollback across a migration accepted, or refused by the self-check of a release that ran here", async () => {
    const repo = tempDir("release-repo");
    const builds = tempDir("release-builds");
    const dir = tempDir("release-dir");
    const root = tempDir("release-root");
    cleanup.push(() => removeDir(repo), () => removeDir(builds), () => removeDir(dir), () => removeDir(root));
    openHome(openHomeFolder(root), "migrate").close();
    setHomeVersion(root, 1);
    git(repo, "init", "-q");
    const c0 = commit(repo, { ...NVMRC, "versions.txt": versions(1), "README.md": "synthetic\n" }, "c0");
    const c1 = commit(repo, { "packages/home/release.json": "{}" }, "c1: releases state their devices' floors");
    const c2 = commit(repo, { "README.md": "synthetic, again\n" }, "c2");
    const c3 = commit(repo, { "versions.txt": versions(2, 1) }, "c3: a migration");
    const c4 = commit(repo, { "README.md": "synthetic, a fourth time\n" }, "c4");
    const c5 = commit(repo, { "sqlite.txt": "3.40.0" }, "c5: built against an old SQLite");
    git(repo, "reset", "-q", "--hard", c4);
    const c6 = commit(repo, { "README.md": "synthetic, a third time\n" }, "c6");

    writeFolder(root);
    const system = fakeLaunchd([jobLabel("home"), jobLabel("door")]);
    try {
      const host: ReleaseHost = { dir, root, init: system.init };
      const now = ticks();
      const node = nodeScript(builds);
      const build = (revision: string): string => buildRelease({ repo, commit: revision, into: builds, now, node, install: () => undefined, compile, engine }).release;
      const log: Record<string, unknown> = {};
      const attempt = (name: string, run: () => unknown) => {
        try {
          log[name] = run();
          return log[name];
        } catch (error) {
          log[name] = { refused: (error as Error).message };
          throw error;
        }
      };

      const restarts = () => ({ home: system.kickstarts("home"), door: system.kickstarts("door") });
      expect(attempt("install c1", () => install(host, build(c1)))).toMatchObject({
        release: c1, previous: null, self_check: { home_db: 1, found: { home_db: 1 } }, restarted: [jobLabel("home"), jobLabel("door")],
      });
      expect(readlinkSync(join(dir, "current"))).toBe(join("releases", c1));
      for (const where of [join(builds, "releases", c1), join(dir, "releases", c1)]) {
        expect(readFileSync(join(where, "node"), "utf8")).toContain(process.execPath);
        expect(statSync(join(where, "faces", ".build", "release", "face-engine")).isFile()).toBe(true);
        expect(existsSync(join(where, "codex"))).toBe(false);
        expect(readManifest(where)).toMatchObject({ commit: c1, generation: 2, home_db: 1, home_db_base: 1, ledger: 1, platform: platform(), node: process.version, reads_keyed: true });
        expect(readManifest(where)).not.toHaveProperty("codex");
      }
      const extension = () => (JSON.parse(readFileSync(join(dir, "extension", "manifest.json"), "utf8")) as { built_in: string }).built_in;
      expect(log["install c1"]).toMatchObject({ extension: join(dir, "extension") });
      expect(extension()).toBe(c1);
      const first = { home: system.running.get(jobLabel("home"))!, door: system.running.get(jobLabel("door"))! };
      const exited = Promise.all([first.home, first.door].map((child) => new Promise<NodeJS.Signals | null>((resolve) => child.once("exit", (_code, signal) => resolve(signal)))));
      expect(attempt("install c2", () => install(host, build(c2)))).toMatchObject({ release: c2, previous: c1, restarted: [jobLabel("home"), jobLabel("door")] });
      expect(await exited).toEqual(["SIGTERM", "SIGTERM"]);
      expect(system.calls.filter((call) => call[0] !== "print" && !/\.(home|door)$/u.test(call.at(-1)!))).toEqual([]);
      expect(extension()).toBe(c2);
      expect(attempt("install c4", () => install(host, build(c4)))).toMatchObject({ release: c4, previous: c2, self_check: { home_db: 2, found: { home_db: 1 } } });
      setHomeVersion(root, 2);
      expect(restarts()).toEqual({ home: 3, door: 3 });
      expect(builtReleases(dir).find((release) => release.commit === c4)).toMatchObject({ generation: 5, home_db: 2, home_db_base: 1, ledger: 1 });

      expect(() => attempt("rollback with no --to", () => rollback(host))).toThrow(
        `deploy --rollback names the release to run: --to <sha>, one of the releases kept, newest first: ${c4} (current), ${c2}, ${c1}`);
      expect(() => attempt("rollback from c4", () => rollback(host, c2))).toThrow(`home.db is at version 2; release ${c2} reads 1: fix forward`);
      expect(() => attempt("rollback to c1", () => rollback(host, c1))).toThrow(`home.db is at version 2; release ${c1} reads 1: fix forward`);
      expect(currentRelease(dir)).toBe(c4);
      expect(restarts()).toEqual({ home: 3, door: 3 });

      expect(() => attempt("install c5", () => install(host, build(c5)))).toThrow(/SQLite 3\.40\.0 is older than 3\.51\.3/u);
      expect(existsSync(join(builds, "releases", c5))).toBe(false);
      expect(existsSync(join(builds, "releases", `${c5}.partial`))).toBe(false);
      expect(currentRelease(dir)).toBe(c4);

      expect(attempt("install c6", () => install(host, build(c6)))).toMatchObject({ release: c6, previous: c4 });
      writeFileSync(join(dir, "releases", c4, "crash.txt"), "a self-check that refuses what c6 left");
      expect(attempt("rollback from c6", () => rollback(host, c4))).toMatchObject({ release: c4, previous: c6, self_check: null });
      rmSync(join(dir, "releases", c4, "crash.txt"));
      expect(currentRelease(dir)).toBe(c4);
      expect(restarts()).toEqual({ home: 5, door: 5 });

      const old = join(dir, "releases", c3);
      mkdirSync(old, { recursive: true });
      writeFileSync(join(old, "RELEASE.json"), JSON.stringify({ commit: c3, generation: 4, built_ms: 0, home_db: 2, home_db_base: 1, ledger: 1, sqlite: "3.53.4" }));
      expect(() => attempt("rollback to a release with no node", () => rollback(host, c3))).toThrow(new RegExp(`release ${c3} carries no node of its own`, "u"));
      writeFileSync(join(old, "RELEASE.json"), JSON.stringify({ commit: c3, built_ms: 0, home_db: 2, home_db_base: 1, ledger: 1, sqlite: "3.53.4" }));
      expect(() => attempt("rollback to a release with no generation", () => rollback(host, c3))).toThrow(`release ${c3} carries no generation: it was built before releases did, so nothing can tell whether it reads the home`);
      writeFileSync(join(old, "RELEASE.json"), JSON.stringify({ commit: c3, generation: 4, built_ms: 0, sqlite: "3.53.4", node: process.version }));
      expect(() => attempt("rollback to a release stating no versions", () => rollback(host, c3))).toThrow(
        `${join(old, "RELEASE.json")} states neither the home.db and ledger versions it reads nor steps, so nothing can tell whether it reads the home: move ${old} aside`);
      expect(currentRelease(dir)).toBe(c4);
      setOldScheme(root, 2);
      writeFileSync(join(old, "RELEASE.json"), JSON.stringify({ commit: c3, generation: 4, built_ms: 0, steps: 1, sqlite: "3.53.4", node: process.version }));
      expect(() => attempt("rollback to an old-scheme release behind", () => rollback(host, c3))).toThrow(`home.db is at version 2; release ${c3} reads 1: fix forward`);
      writeFileSync(join(old, "RELEASE.json"), JSON.stringify({ commit: c3, generation: 4, built_ms: 0, steps: 2, sqlite: "3.53.4", node: process.version }));
      expect(attempt("rollback to an old-scheme release", () => rollback(host, c3))).toMatchObject({ release: c3, previous: c4, self_check: null });
      writeArtifact("releases", { commits: { c0, c1, c2, c3, c4, c5, c6 }, log, built: builtReleases(dir), calls: system.calls });
    } finally {
      system.stop();
    }
  });

  it("a release built here needs the checkout where it is installed, is copied twice, is installed for another platform, raises the extension's floor above what the store serves, or leaves out a file the Mac app's page serves", () => {
    const repo = tempDir("install-repo");
    const builds = tempDir("install-builds");
    const app = tempDir("install-app");
    const dir = tempDir("install-dir");
    const root = tempDir("install-root");
    cleanup.push(() => removeDir(repo), () => removeDir(builds), () => removeDir(app), () => removeDir(dir), () => removeDir(root));
    git(repo, "init", "-q");
    const c0 = commit(repo, { ...NVMRC, "versions.txt": versions(homeSchema.latest, homeSchema.base, ledgerSchema.latest) }, "c0");
    const c1 = commit(repo, { "packages/home/release.json": "{}", ...PAGE_FILES }, "c1");
    const c2 = commit(repo, { ".nvmrc": "21.0.0\n" }, "c2: another node");
    const floors = (extension: string) => ({ mac: "0", phone: "0", extension });
    const c3 = commit(repo, { ...NVMRC, "packages/home/release.json": JSON.stringify({ floors: floors("0.5.0"), published: { extension: "0.4.0" } }) }, "c3: a floor the store does not serve yet");
    const c4 = commit(repo, { "packages/home/release.json": JSON.stringify({ floors: floors("0.4.0") }) }, "c4: a floor, and no word of what the store serves");
    const system = fakeLaunchd(JOBS.map(jobLabel));
    const none = fakeLaunchd([]);
    const agents = fakeLaunchd(JOBS.map(jobLabel), true);
    try {
      const steps = (revision: string): BuildSteps => ({ repo, commit: revision, into: builds, install: () => undefined, compile, engine });
      const refusals: Record<string, string> = {};
      const refused = (name: string, run: () => unknown, pattern: RegExp) => {
        let message: string | null = null;
        try { run(); } catch (error) { message = (error as Error).message; }
        expect(message, `${name}: no refusal`).toMatch(pattern);
        refusals[name] = message!;
      };
      refused("a build on another node", () => buildRelease(steps(c2)), new RegExp(`${c2}'s \\.nvmrc names node v21\\.0\\.0, and this build runs ${process.version.replace(/\./gu, "\\.")}`, "u"));
      expect(existsSync(join(builds, "releases", c2))).toBe(false);
      refused("a floor above the store's", () => buildRelease(steps(c3)),
        new RegExp(`${c3}:packages/home/release\\.json raises the extension's floor to 0\\.5\\.0, above 0\\.4\\.0, the newest version the Chrome Web Store serves`, "u"));
      refused("a floor with no word of the store's", () => buildRelease(steps(c4)), /states an extension floor, so it states published\.extension/u);
      expect(existsSync(join(builds, "releases", c3)) || existsSync(join(builds, "releases", c4))).toBe(false);

      const built = buildRelease(steps(c1));
      const carried = join(app, "Lifestream.app", "Contents", "Resources", "release");
      mkdirSync(join(carried, ".."), { recursive: true });
      cpSync(built.release, carried, { recursive: true, verbatimSymlinks: true });
      removeDir(repo);
      removeDir(builds);

      refused("a folder that is not a release", () => install({ dir, root: null, init: system.init }, app), /holds no RELEASE\.json/u);
      const foreign = join(app, "foreign");
      cpSync(carried, foreign, { recursive: true, verbatimSymlinks: true });
      writeFileSync(join(foreign, "RELEASE.json"), JSON.stringify({ ...readManifest(carried), platform: "linux-x64" }));
      refused("another platform's release", () => install({ dir, root: null, init: system.init }, foreign), new RegExp(`runs on linux-x64, not on this ${platform()}`, "u"));
      expect(currentRelease(dir)).toBeNull();
      expect(existsSync(join(dir, "releases", c1))).toBe(false);

      const first = install({ dir, root: null, init: none.init }, carried);
      expect(first).toMatchObject({ release: c1, previous: null, restarted: [], faces: { skipped: "this machine holds no home" } });
      expect(currentRelease(dir)).toBe(c1);
      expect(none.calls.filter(([verb]) => verb !== "print")).toEqual([]);
      const installed = statSync(join(dir, "releases", c1, "node")).ino;
      for (const [path, bytes] of Object.entries(PAGE_FILES)) expect(readFileSync(join(dir, "releases", c1, path)).equals(Buffer.from(bytes)), path).toBe(true);

      openHome(openHomeFolder(root), "migrate").close();
      writeFolder(root);
      const again = install({ dir, root, init: system.init }, carried);
      expect(again).toMatchObject({ release: c1, previous: c1, self_check: { found: { home_db: homeSchema.latest } }, restarted: JOBS.map(jobLabel) });
      expect(statSync(join(dir, "releases", c1, "node")).ino).toBe(installed);
      expect(readdirSync(join(dir, "releases"))).toEqual([c1]);

      const renewed = install({ dir, root, init: agents.init }, carried);
      expect(renewed).toMatchObject({ release: c1, restarted: JOBS.map(jobLabel) });
      expect(JOBS.map((job) => agents.kickstarts(job))).toEqual([1, 1, 1, 1, 1]);

      rmSync(join(dir, "releases", c1, "RELEASE.json"));
      mkdirSync(join(dir, "releases", `${c1}.partial`), { recursive: true });
      expect(install({ dir, root, init: system.init }, carried)).toMatchObject({ release: c1 });
      expect(readManifest(join(dir, "releases", c1))).toMatchObject({ commit: c1 });
      expect(readdirSync(join(dir, "releases"))).toEqual([c1]);

      mkdirSync(join(dir, "releases", "old-home"), { recursive: true });
      writeFileSync(join(dir, "releases", "old-home", "RELEASE.json"), JSON.stringify({ commit: "old-home", built_at: "2026-09-01T00:00:00Z", min_rollback: c0, rollback_targets: [] }));
      refused("install beside another home's release", () => install({ dir, root, init: system.init }, carried), /RELEASE\.json is not a release of this home: move .* aside/u);
      writeArtifact("install", { first, again, renewed, calls: system.calls, refusals });
    } finally {
      none.stop();
      agents.stop();
      system.stop();
    }
  });

  it("a build whose pruned release cannot make or pass a home template writes a release, says nothing of which, runs it inside the checkout or leaves its scratch folder", () => {
    const repo = tempDir("smoke-repo");
    const builds = tempDir("smoke-builds");
    cleanup.push(() => removeDir(repo), () => removeDir(builds));
    git(repo, "init", "-q");
    const c0 = commit(repo, { ...NVMRC, "versions.txt": versions(homeSchema.latest, homeSchema.base), "packages/home/release.json": "{}", "kinds.txt": "api folder export\n", "smoke-fault.txt": "folder\n" }, "c0: a folder template that fails its test");
    const c1 = commit(repo, { "kinds.txt": "\n", "smoke-fault.txt": "\n" }, "c1: a release that lists no home template");
    const c2 = commit(repo, { "kinds.txt": "api folder export\n" }, "c2: every template passes");
    const steps = (revision: string): BuildSteps => ({ repo, commit: revision, into: builds, install: () => undefined, compile, engine });
    const refusal = (revision: string) => {
      try {
        buildRelease(steps(revision));
      } catch (error) {
        return (error as Error).message;
      }
      return null;
    };
    const failed = refusal(c0);
    const said = /^the pruned release's folder template fails its test \(lifestream connectors test, in (\S+)\): reader\.ts:3:1 a synthetic fault over (\S+) from (\S+)$/u.exec(failed ?? "");
    const listless = refusal(c1);
    writeArtifact("smoke", { failed, listless });
    expect(said, failed ?? "no refusal").not.toBeNull();
    const [, folder, over, from] = said!;
    expect([over, from === dirname(folder!), folder!.startsWith(`${realpathSync(tmpdir())}/`), folder!.startsWith(realpathSync(builds)), folder!.startsWith(repoRoot())]).toEqual([folder, true, true, false, false]);
    expect([existsSync(dirname(folder!)), existsSync(join(builds, "releases", c0)), existsSync(join(builds, "releases", `${c0}.partial`))]).toEqual([false, false, false]);
    expect(listless).toBe('the pruned release lists no home template (lifestream connectors new printed "usage: lifestream connectors new <kind> <id>, a kind one of:")');
    expect(readManifest(buildRelease(steps(c2)).release)).toMatchObject({ commit: c2 });
  });

  it("an install passes a face engine that fails its self-check on the home's models, rebuilds or rechecks what has not changed, or prunes an engine a kept release runs", () => {
    const repo = tempDir("faces-repo");
    const builds = tempDir("faces-builds");
    const dir = tempDir("faces-dir");
    const root = tempDir("faces-root");
    const config = tempDir("faces-engine");
    cleanup.push(() => removeDir(repo), () => removeDir(builds), () => removeDir(dir), () => removeDir(root), () => removeDir(config));
    openHome(openHomeFolder(root), "migrate").close();
    writeFolder(root);
    git(repo, "init", "-q");
    const sources = (version: string) => ({ "faces/Package.swift": "// synthetic package\n", "faces/Sources/face-engine/main.swift": `// synthetic engine ${version}\n`, "faces/reference/expected.json": "{}\n" });
    const c0 = commit(repo, { ...NVMRC, "versions.txt": versions(homeSchema.latest, homeSchema.base), ...sources("a") }, "c0");
    const c1 = commit(repo, { "packages/home/release.json": "{}" }, "c1: engine a");
    const c2 = commit(repo, { "faces/Sources/face-engine/main.swift": "// synthetic engine b\n" }, "c2: engine b");
    const later = [3, 4, 5, 6].map((n) => commit(repo, { "README.md": `synthetic ${n}\n` }, `c${n}: engine b, unchanged`));
    const c7 = commit(repo, sources("a"), "c7: engine a again");
    const system = fakeLaunchd([jobLabel("home"), jobLabel("door")]);
    try {
      const host: ReleaseHost = { dir, root, init: system.init };
      const now = ticks();
      const built: string[] = [];
      const fakeEngine = (release: string) => {
        built.push(basename(release));
        mkdirSync(join(release, "faces", ".build", "release"), { recursive: true });
        writeFileSync(join(release, "faces", ".build", "release", "face-engine"), `#!/bin/sh\n# ${basename(release)}\nFAKE_ENGINE_DIR='${config}' exec '${process.execPath}' '${FAKE_ENGINE}' "$@"\n`, { mode: 0o755 });
      };
      const selfCheck = (passes: boolean) => writeFileSync(join(config, "engine.json"), JSON.stringify({ selfCheck: passes }));
      const node = nodeScript(config);
      const build = (revision: string): string => buildRelease({ repo, commit: revision, into: builds, now, node, install: () => undefined, compile, engine: fakeEngine }).release;
      const checks = () => (existsSync(join(config, "calls.log")) ? readFileSync(join(config, "calls.log"), "utf8").trim().split("\n").length : 0);
      const engineOf = (revision: string) => builtReleases(dir).find((release) => release.commit === revision)?.engine;
      const carries = (revision: string) => /# (\S+)/u.exec(readFileSync(join(dir, "releases", revision, "faces", ".build", "release", "face-engine"), "utf8"))?.[1];
      selfCheck(true);
      const log: Record<string, unknown> = {};

      const models = join(root, "tools", "faces", "models", "buffalo_l");
      log.unchecked = install(host, build(c1));
      expect(log.unchecked).toMatchObject({ release: c1, faces: { skipped: `no face models are installed at ${models} (lifestream faces on)` } });
      expect(checks()).toBe(0);
      const a = engineOf(c1)!;
      expect(a).toMatch(/^[0-9a-f]{64}$/u);
      expect(carries(c1)).toBe(`${c1}.partial`);
      expect(readdirSync(join(dir, "releases", c1, "faces", ".build"))).toEqual(["release"]);
      expect(readdirSync(join(dir, "releases", c1, "faces", ".build", "release"))).toEqual(["face-engine"]);

      mkdirSync(models, { recursive: true });
      for (const file of ["det_10g.onnx", "w600k_r50.onnx"]) writeFileSync(join(models, file), `synthetic ${file}`);
      log.checked = install(host, build(c1));
      expect(log.checked).toMatchObject({ release: c1, faces: { ok: true, runtimes: [{ runtime: "gpu", ok: true }, { runtime: "cpu", ok: true }] } });
      expect(readFileSync(join(config, "calls.log"), "utf8").trim().split("\n")).toEqual([`self-check ${JSON.stringify({ models, reference: join(dir, "releases", c1, "faces", "reference") })}`]);

      log.unchanged = install(host, build(c1));
      expect(log.unchanged).toMatchObject({ release: c1, faces: { unchanged: a } });
      expect(checks()).toBe(1);

      writeFileSync(join(models, "w600k_r50.onnx"), "synthetic w600k_r50.onnx, fetched again");
      selfCheck(false);
      const restarts = system.kickstarts("home");
      expect(() => install(host, build(c1))).toThrow(new RegExp(`the face engine of ${c1} refused: face-engine self-check did not pass`, "u"));
      try { install(host, build(c1)); } catch (error) { log.refused = (error as Error).message; }
      expect(checks()).toBe(3);
      expect(system.kickstarts("home")).toBe(restarts);
      expect(currentRelease(dir)).toBe(c1);
      selfCheck(true);
      expect(install(host, build(c1))).toMatchObject({ faces: { ok: true } });
      expect(checks()).toBe(4);

      log.changed = install(host, build(c2));
      const b = engineOf(c2)!;
      expect(b).not.toBe(a);
      expect(carries(c2)).toBe(`${c2}.partial`);
      expect(log.changed).toMatchObject({ release: c2, faces: { ok: true } });
      expect(checks()).toBe(5);
      log.same_sources = install(host, build(later[0]!));
      expect(log.same_sources).toMatchObject({ release: later[0], faces: { unchanged: b } });
      expect(engineOf(later[0]!)).toBe(b);
      expect(carries(later[0]!)).toBe(`${c2}.partial`);
      expect(built).toEqual([`${c1}.partial`, `${c2}.partial`]);

      for (const revision of later.slice(1)) log.pruned = install(host, build(revision));
      expect(log.pruned).toMatchObject({ removed: [c1, `engines/${a}`] });
      expect(existsSync(join(dir, "releases", c1))).toBe(false);
      expect(readdirSync(join(dir, "engines"))).toEqual([b]);
      expect(readdirSync(join(builds, "engines"))).toEqual([b]);
      log.again = install(host, build(c7));
      expect(engineOf(c7)).toBe(a);
      expect(built).toEqual([`${c1}.partial`, `${c2}.partial`, `${c7}.partial`]);
      expect(readdirSync(join(builds, "engines")).sort()).toEqual([a, b].sort());
      expect(existsSync(join(dir, "releases", c2))).toBe(false);
      expect(rollback(host, later[3]!)).toMatchObject({ release: later[3], self_check: null, faces: { skipped: "a rollback runs no checks" } });
      log.built = builtReleases(dir);
      log.engines = readdirSync(join(dir, "engines"));
      writeArtifact("install-faces", log);
    } finally {
      system.stop();
    }
  });

  it("an install or a rollback switches to a release that cannot read what the home holds, or refuses one that can", () => {
    const repo = tempDir("versions-repo");
    const builds = tempDir("versions-builds");
    const app = tempDir("versions-app");
    const dir = tempDir("versions-dir");
    const moved = tempDir("versions-moved");
    const root = tempDir("versions-root");
    cleanup.push(() => removeDir(repo), () => removeDir(builds), () => removeDir(app), () => removeDir(dir), () => removeDir(moved), () => removeDir(root));
    openHome(openHomeFolder(root), "migrate").close();
    setHomeVersion(root, 1);
    writeFolder(root);
    git(repo, "init", "-q");
    const c0 = commit(repo, { ...NVMRC, "versions.txt": versions(1), "README.md": "synthetic\n" }, "c0");
    const c1 = commit(repo, { "packages/home/release.json": "{}" }, "c1");
    const c2 = commit(repo, { "README.md": "synthetic 2\n" }, "c2");
    const c3 = commit(repo, { "README.md": "synthetic 3\n" }, "c3");
    const c4 = commit(repo, { "versions.txt": versions(2, 1) }, "c4: a migration");
    const c5 = commit(repo, { "README.md": "synthetic 5\n" }, "c5");
    const c6 = commit(repo, { "README.md": "synthetic 6\n" }, "c6");
    const system = fakeLaunchd([jobLabel("home"), jobLabel("door")]);
    try {
      const host: ReleaseHost = { dir, root, init: system.init };
      const now = ticks();
      const node = nodeScript(builds);
      const steps = (revision: string): BuildSteps => ({ repo, commit: revision, into: builds, now, node, install: () => undefined, compile, engine });
      const built = (revision: string) => join(builds, "releases", revision);
      const manifestOf = (revision: string) => readManifest(built(revision))!;
      const log: Record<string, unknown> = {};
      const switched = (name: string, run: () => unknown) => (log[name] = run());
      const held = (where = dir) => ({
        current: currentRelease(where), installed: existsSync(join(where, "releases")) ? readdirSync(join(where, "releases")).sort() : [],
        extension: existsSync(join(where, "extension")) ? (JSON.parse(readFileSync(join(where, "extension", "manifest.json"), "utf8")) as { built_in: string }).built_in : null,
        signalled: system.calls.filter(([verb]) => verb !== "print").length,
      });
      const refused = (name: string, run: () => unknown, expected: string, where = dir) => {
        const before = held(where);
        let message = "";
        try { run(); } catch (error) { message = (error as Error).message; }
        log[name] = { refused: message };
        expect(message).toBe(expected);
        expect(held(where)).toEqual(before);
      };
      const behind = (release: string, reads: number, at = 2) => `home.db is at version ${at}; release ${release} reads ${reads}: fix forward`;

      for (const revision of [c2, c3, c4, c5]) buildRelease(steps(revision));
      expect([c2, c3, c4, c5].map((revision) => [manifestOf(revision).generation, manifestOf(revision).home_db, manifestOf(revision).home_db_base]))
        .toEqual([[3, 1, 1], [4, 1, 1], [5, 2, 1], [6, 2, 1]]);

      expect(switched("fresh", () => install(host, built(c2)))).toMatchObject({ release: c2, previous: null });
      expect(switched("same", () => install(host, built(c2)))).toMatchObject({ release: c2, previous: c2 });
      expect(switched("newer", () => install(host, built(c3)))).toMatchObject({ release: c3, previous: c2 });
      expect(switched("rollback with no migration between", () => rollback(host, c2))).toMatchObject({ release: c2, previous: c3 });
      expect(switched("newer across a migration", () => install(host, built(c4)))).toMatchObject({ release: c4, previous: c2 });
      setHomeVersion(root, 2);

      refused("install of an older commit", () => install(host, buildRelease(steps(c1)).release), behind(c1, 1));
      expect(existsSync(join(dir, "releases", c1))).toBe(false);
      const carried = join(app, "carried");
      cpSync(built(c1), carried, { recursive: true, verbatimSymlinks: true });
      buildRelease(steps(c6));
      expect(readdirSync(join(builds, "releases")).sort()).toEqual([c2, c3, c4, c5, c6].sort());
      expect(existsSync(buildRelease(steps(c1)).release)).toBe(true);
      removeDir(repo);

      expect(readManifest(carried)!.built_ms).toBeGreaterThan(manifestOf(c4).built_ms);
      refused("install of an older release", () => install(host, carried), behind(c1, 1));
      expect(existsSync(join(dir, "releases", `${c1}.partial`))).toBe(false);
      refused("rollback across the migration", () => rollback(host, c2), behind(c2, 1));

      expect(switched("newer at the version", () => install(host, built(c5)))).toMatchObject({ release: c5, previous: c4 });
      expect(switched("rollback at the version", () => rollback(host, c4))).toMatchObject({ release: c4, previous: c5 });
      expect(switched("rollback to a newer release", () => rollback(host, c5))).toMatchObject({ release: c5, previous: c4 });
      refused("rollback past the release that migrated", () => install(host, built(c3)), behind(c3, 1));

      const there: ReleaseHost = { dir: moved, root, init: system.init };
      refused("install on a new machine behind the folder's version", () => install(there, built(c2)), behind(c2, 1), moved);
      expect(switched("install on a new machine at the version", () => install(there, built(c4)))).toMatchObject({ release: c4, previous: null });

      const ahead = join(app, "ahead");
      cpSync(built(c5), ahead, { recursive: true, verbatimSymlinks: true });
      writeFileSync(join(ahead, "RELEASE.json"), JSON.stringify({ ...readManifest(ahead), home_db: 4, home_db_base: 3 }));
      refused("a release whose baseline is newer", () => install(host, ahead),
        `home.db is at version 2; release ${c5} reads 4 and moves a file forward from 3 at the oldest: install a release between them first`);

      const legacy = join(app, "legacy");
      cpSync(built(c5), legacy, { recursive: true, verbatimSymlinks: true });
      const older = readManifest(legacy)!;
      delete older.generation;
      writeFileSync(join(legacy, "RELEASE.json"), JSON.stringify(older));
      refused("a release with no generation", () => install(host, legacy), `release ${c5} carries no generation: it was built before releases did, so nothing can tell whether it reads the home`);
      writeFileSync(join(legacy, "RELEASE.json"), JSON.stringify({ ...older, generation: "6" }));
      expect(() => install(host, legacy)).toThrow(/RELEASE\.json is not a release of this home/u);
      writeFileSync(join(legacy, "RELEASE.json"), JSON.stringify({ ...older, generation: 6, home_db: "2" }));
      expect(() => install(host, legacy)).toThrow(/RELEASE\.json is not a release of this home/u);
      expect(currentRelease(dir)).toBe(c5);
      writeArtifact("install-versions", { commits: { c0, c1, c2, c3, c4, c5, c6 }, log, built: builtReleases(builds), installed: builtReleases(dir), calls: system.calls });
    } finally {
      system.stop();
    }
  });

  it("an install leaves an agent on the old release, fails over one that does not act on SIGTERM, or a refused one moves anything or says nothing (25, 26)", () => {
    const repo = tempDir("agents-repo");
    const builds = tempDir("agents-builds");
    const dir = tempDir("agents-dir");
    const root = tempDir("agents-root");
    cleanup.push(() => removeDir(repo), () => removeDir(builds), () => removeDir(dir), () => removeDir(root));
    openHome(openHomeFolder(root), "migrate").close();
    writeFolder(root);
    git(repo, "init", "-q");
    const c0 = commit(repo, { ...NVMRC, "versions.txt": versions(homeSchema.latest, homeSchema.base) }, "c0");
    const c1 = commit(repo, { "packages/home/release.json": "{}" }, "c1");
    const c2 = commit(repo, { "README.md": "synthetic 2\n" }, "c2");
    const c3 = commit(repo, { "crash.txt": "the home cannot open its folder\n" }, "c3: a release whose home throws as it starts");
    git(repo, "rm", "-q", "crash.txt");
    const c4 = commit(repo, { "silent.txt": "\n" }, "c4: a release whose home ends saying nothing");
    const refusing = new Set<string>();
    const deaf = new Map<string, readonly string[]>();
    const system = fakeLaunchd(JOBS.map(jobLabel), true, dir, refusing, deaf);
    try {
      const host: ReleaseHost = { dir, root, init: system.init };
      const node = nodeScript(builds);
      const steps = (revision: string): BuildSteps => ({ repo, commit: revision, into: builds, now: ticks(), node, install: () => undefined, compile, engine });
      const log: Record<string, unknown> = {};
      const extension = () => (JSON.parse(readFileSync(join(dir, "extension", "manifest.json"), "utf8")) as { built_in: string }).built_in;
      const pids = () => JOBS.map((job) => system.running.get(jobLabel(job))?.pid);
      const running = () => ({ current: currentRelease(dir), extension: extension(), agents: Object.fromEntries(JOBS.map((job) => [job, system.on.get(jobLabel(job))])) });
      const on = (release: string) => ({ current: release, extension: release, agents: Object.fromEntries(JOBS.map((job) => [job, release])) });

      log.first = install(host, buildRelease(steps(c1)).release);
      expect(log.first).toMatchObject({ release: c1, restarted: JOBS.map(jobLabel) });
      expect(running()).toEqual(on(c1));
      const before = pids();
      log.second = install(host, buildRelease(steps(c2)).release);
      expect(running()).toEqual(on(c2));
      expect(pids().every((pid, index) => pid !== undefined && pid !== before[index])).toBe(true);
      expect(JOBS.map((job) => system.kickstarts(job))).toEqual([2, 2, 2, 2, 2]);

      const held = pids();
      const signalled = () => system.calls.filter(([verb]) => verb !== "print").length;
      const quiet = signalled();
      const refusal = (revision: string): string => {
        const release = buildRelease(steps(revision)).release;
        try {
          install(host, release);
        } catch (error) {
          return (error as Error).message;
        }
        throw new Error(`the install of ${revision} was taken`);
      };
      log.thrown = refusal(c3);
      expect(log.thrown).toBe(`the self-check of ${c3} failed: Error: the home cannot open its folder`);
      log.silent = refusal(c4);
      expect(log.silent).toBe(`the self-check of ${c4} failed: exit 3`);
      expect(running()).toEqual(on(c2));
      expect(pids()).toEqual(held);
      expect(signalled()).toBe(quiet);

      const lock = tryLock(join(builds, "release.lock"))!;
      try {
        expect(() => buildRelease(steps(c0))).toThrow(`another build or install holds ${join(builds, "release.lock")}`);
      } finally {
        lock.release();
      }
      expect(existsSync(join(builds, "releases", `${c0}.partial`))).toBe(false);

      refusing.add(jobLabel("home"));
      git(repo, "rm", "-q", "silent.txt");
      const c6 = commit(repo, { "README.md": "synthetic 6\n" }, "c6");
      let failed = "";
      try {
        install(host, buildRelease(steps(c6)).release);
      } catch (error) {
        failed = (error as Error).message;
      }
      log.failed = failed;
      expect(failed).toBe(`release ${c6} is current, and a restart failed (${jobLabel("home")}: launchctl kickstart failed: Input/output error); restarted: ${["door", "dashboard", "mcp", "runner"].map((job) => jobLabel(job as (typeof JOBS)[number])).join(", ")}. Fix what it names, then install again`);
      expect(currentRelease(dir)).toBe(c6);
      expect(system.running.has(jobLabel("home"))).toBe(false);
      expect(Object.fromEntries(JOBS.map((job) => [job, system.on.get(jobLabel(job))]))).toEqual({ home: c2, door: c6, dashboard: c6, mcp: c6, runner: c6 });

      refusing.delete(jobLabel("home"));
      deaf.set(jobLabel("home"), ["SIGTERM"]);
      const c7 = commit(repo, { "README.md": "synthetic 7\n" }, "c7");
      log.deafStarted = install(host, buildRelease(steps(c7)).release);
      const deafPid = system.running.get(jobLabel("home"))!.pid;
      const c8 = commit(repo, { "README.md": "synthetic 8\n" }, "c8");
      log.deafKilled = install(host, buildRelease(steps(c8)).release);
      expect(log.deafKilled).toMatchObject({ release: c8, restarted: JOBS.map(jobLabel) });
      expect(system.killed).toEqual([deafPid]);
      expect(system.running.get(jobLabel("home"))!.pid).not.toBe(deafPid);
      expect(running()).toEqual(on(c8));

      deaf.set(jobLabel("home"), ["SIGTERM", "SIGKILL"]);
      deaf.set(jobLabel("door"), ["SIGTERM"]);
      const stuckPid = system.running.get(jobLabel("home"))!.pid;
      const doorPid = system.running.get(jobLabel("door"))!.pid;
      const c9 = commit(repo, { "README.md": "synthetic 9\n" }, "c9");
      log.stuck = refusal(c9);
      expect(log.stuck).toBe(`release ${c9} is current, and a restart failed (${jobLabel("home")}: ${jobLabel("home")} (pid ${stuckPid}) still runs 0.5 s after SIGKILL; ${jobLabel("door")}: ${jobLabel("door")} (pid ${doorPid}) still runs 0.5 s after SIGTERM); restarted: ${["dashboard", "mcp", "runner"].map((job) => jobLabel(job as (typeof JOBS)[number])).join(", ")}. Fix what it names, then install again`);
      expect(system.killed).toEqual([deafPid, stuckPid]);
      expect(Object.fromEntries(JOBS.map((job) => [job, system.on.get(jobLabel(job))]))).toEqual({ home: c8, door: c8, dashboard: c9, mcp: c9, runner: c9 });
      writeArtifact("install-agents", { commits: { c0, c1, c2, c3, c4, c6, c7, c8, c9 }, log, running: running(), calls: system.calls });
    } finally {
      system.stop();
    }
  });

  it("the self-check a release runs on itself passes a home.db or a ledger it cannot read, or refuses one it migrates", async () => {
    const root = tempDir("self-check");
    const old = tempDir("self-check-old");
    cleanup.push(() => removeDir(root), () => removeDir(old));
    const at = { home_db: homeSchema.latest, home_db_base: homeSchema.base, ledger: ledgerSchema.latest };
    expect(await selfCheckHere(null)).toMatchObject({ ...at, found: { home_db: null, ledger: null }, problems: [] });
    openHome(openHomeFolder(root), "migrate").close();
    openLedger(openHomeFolder(root), { mode: "migrate" }).close();
    expect(await selfCheckHere(root)).toMatchObject({ found: { home_db: homeSchema.latest, ledger: ledgerSchema.latest }, problems: [] });
    const fixture = JSON.parse(readFileSync(join(repoRoot(), "packages", "core", "test", "home-v22.json"), "utf8")) as { objects: { sql: string }[] };
    const before = new Database(join(old, "home.db"));
    before.exec(fixture.objects.map((object) => `${object.sql};`).join("\n"));
    before.prepare("INSERT INTO meta (key, value) VALUES ('steps', ?), ('writer', '{\"release\":\"a839c1e83\",\"steps\":22}'), ('floor', '3963')").run(String(homeSchema.base));
    before.close();
    expect(await selfCheckHere(old)).toMatchObject({ found: { home_db: homeSchema.base, ledger: null }, problems: [] });
    const alter = (file: string, sql: string) => {
      const db = new Database(file);
      db.exec(sql);
      db.close();
    };
    const ledgerFixture = JSON.parse(readFileSync(join(repoRoot(), "packages", "model", "test", "ledger-v3.json"), "utf8")) as { objects: { sql: string }[] };
    mkdirSync(join(old, "replies"));
    alter(join(old, "replies", "replies.db"), `PRAGMA foreign_keys = OFF;
      ${ledgerFixture.objects.map((object) => `${object.sql};`).join("\n")}
      INSERT INTO meta (key, value) VALUES ('steps', '3');
      INSERT INTO requests (key, unit, model, effort, transport, prompt_hash, input_hash, body, attachments, requested)
        VALUES ('request-a', 'photo:synthetic-1', 'synthetic/model-a', 'none', 'fake', 'sha256:gone', 'sha256:input-a', 'body', '[]', '2026-10-03T06:00:00.000Z')`);
    expect(await selfCheckHere(old)).toMatchObject({ found: { home_db: homeSchema.base, ledger: 3 }, problems: ["the ledger at version 3 has a row of requests whose prompts is gone"] });
    alter(join(root, "home.db"), `PRAGMA user_version = ${homeSchema.latest + 1}`);
    expect((await selfCheckHere(root)).problems).toEqual([`home.db is at version ${homeSchema.latest + 1}; this release reads ${homeSchema.latest}: a newer release wrote it`]);
    alter(join(root, "home.db"), `PRAGMA user_version = ${homeSchema.latest}`);
    alter(join(root, "home.db"), "DROP INDEX dirty_days_set_aside");
    alter(join(root, "replies", "replies.db"), "DROP INDEX requests_unit");
    expect((await selfCheckHere(root)).problems).toEqual([
      `home.db is not this release's at version ${homeSchema.latest} (index dirty_days_set_aside is missing): this release cannot read it`,
      `the ledger is not this release's at version ${ledgerSchema.latest} (index requests_unit is missing): this release cannot read it`,
    ]);
    alter(join(root, "home.db"), "PRAGMA user_version = 0");
    expect(await selfCheckHere(root)).toMatchObject({ found: { home_db: null }, problems: expect.arrayContaining(["home.db holds tables but records no version, so no release can tell what it holds"]) });
  });

  it("the home program runs when named through a link, as the init system names it through `current`", () => {
    const dir = tempDir("linked");
    cleanup.push(() => removeDir(dir));
    const linked = join(dir, "home.ts");
    symlinkSync(join(import.meta.dirname, "cli.ts"), linked);
    const run = spawnSync(process.execPath, ["--import", "tsx", linked, "self-check"], { cwd: import.meta.dirname, encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ home_db: homeSchema.latest, ledger: ledgerSchema.latest, problems: [] });
  });

  it("the self-check passes a release that cannot start on the home's settings, or that lacks a source's connector; or refuses a source its home's own connector folder declares; or refuses an older home naming no unit, which its start gives it", async () => {
    const root = tempDir("self-check-start");
    cleanup.push(() => removeDir(root));
    writeFolder(root, { "day.day_start_hour": 99 });
    const db = openHome(openHomeFolder(root), "migrate");
    db.commit((tx) => tx.tables.sources.add({ id: "apple-notes:local:device-a", vendor: vendorOf(declarations(), "apple-notes:local:device-a"), connector: "no-such-connector", added_ms: 0 }));
    db.close();
    const unstartable = await selfCheckHere(root);
    expect(unstartable.problems).toEqual([expect.stringMatching(/cannot start: .*day\.day_start_hour is a whole hour, 0 to 23/u)]);
    writeFolder(root);
    const lacking = await selfCheckHere(root);
    expect(lacking.problems).toEqual(["source apple-notes:local:device-a names connector no-such-connector, which this release lacks"]);
    writeFolder(root, { "sources.off": ["apple-notes:local:device-a"] });
    const off = await selfCheckHere(root);
    expect(off.problems).toEqual([]);
    cpSync(join(repoRoot(), "packages", "home", "test", "proof", "example-bank"), join(root, "connectors", "example-bank"), { recursive: true });
    const withFolder = openHome(openHomeFolder(root), "migrate");
    withFolder.commit((tx) => tx.tables.sources.add({ id: "example-bank:0001:export", vendor: "example", connector: "example-bank", added_ms: 0 }));
    withFolder.close();
    expect((await selfCheckHere(root)).problems).toEqual([]);
    const { unit: _none, ...older } = JSON.parse(readFileSync(join(root, "config", "settings.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(root, "config", "settings.json"), JSON.stringify(older));
    mintPrincipal(openHomeFolder(root), { unit: "mac-mini-0c11", kind: "mac", scopes: ["deliver"], sources: ["apple-notes:local:mac-mini-0c11"], token: randomBytes(32).toString("base64url"), now_ms: 0 });
    const upgraded = await selfCheckHere(root);
    expect(upgraded.problems).toEqual([]);
    expect(JSON.parse(readFileSync(join(root, "config", "settings.json"), "utf8")).unit, "the check wrote the settings").toBeUndefined();
    const started = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: FAKES, log: () => undefined });
    try {
      expect(started.settings.unit).toBe("mac-mini-0c11");
      expect(JSON.parse(readFileSync(join(root, "config", "settings.json"), "utf8")).unit).toBe("mac-mini-0c11");
    } finally {
      await started.stop();
    }
    writeArtifact("self-check-start", { unstartable, lacking, off, upgraded });
  });

  it("the self-check passes a source whose home folder this release refuses, as the home's start recorded it, and refuses one no folder and no release holds", async () => {
    const root = tempDir("self-check-refused");
    cleanup.push(() => removeDir(root));
    writeFolder(root);
    const folder = join(root, "connectors", "example-bank");
    cpSync(join(repoRoot(), "packages", "home", "test", "proof", "example-bank"), folder, { recursive: true });
    const db = openHome(openHomeFolder(root), "migrate");
    db.commit((tx) => tx.tables.sources.add({ id: "example-bank:0001:export", vendor: "example", connector: "example-bank", added_ms: 0 }));
    db.close();
    const started = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: homeRegistryModule(), log: () => undefined });
    await started.stop();
    const index = join(folder, "index.ts");
    writeFileSync(index, readFileSync(index, "utf8").replace("export const contract = 3;", "export const contract = 1;"));
    const refused = await selfCheckHere(root);
    const typo = openHome(openHomeFolder(root), "migrate");
    typo.commit((tx) => tx.tables.sources.add({ id: "example-bank:0002:export", vendor: "example", connector: "example-bnak", added_ms: 0 }));
    typo.close();
    const lacking = await selfCheckHere(root);
    rmSync(folder, { recursive: true });
    const away = await selfCheckHere(root);
    writeArtifact("self-check-refused", { refused, lacking, away });
    expect(refused.problems).toEqual([]);
    expect(lacking.problems).toEqual(["source example-bank:0002:export names connector example-bnak, which this release lacks"]);
    expect(away.problems).toEqual([
      "source example-bank:0001:export names connector example-bank, which this release lacks",
      "source example-bank:0002:export names connector example-bnak, which this release lacks",
    ]);
  });

  it("the self-check trusts no stale record of a reader's folder: each start drops a reader its admitted folder no longer declares, one whose folder is gone and one the release holds", async () => {
    const root = tempDir("self-check-stale");
    cleanup.push(() => removeDir(root));
    writeFolder(root);
    const folder = join(root, "connectors", "example-bank");
    cpSync(join(repoRoot(), "packages", "home", "test", "proof", "example-bank"), folder, { recursive: true });
    const held = declarations()[0]!.sources[0]!.read;
    const home = (work: (tx: Tx) => void) => {
      const db = openHome(openHomeFolder(root), "migrate");
      db.commit(work);
      db.close();
    };
    const recorded = async () => {
      const started = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: homeRegistryModule(), log: () => undefined });
      await started.stop();
      const read = new Database(join(root, "home.db"), { readonly: true });
      const rows = read.prepare("SELECT key, value FROM meta WHERE substr(key, 1, 12) = 'read-folder:' ORDER BY key").all();
      read.close();
      return rows;
    };
    home((tx) => {
      tx.tables.sources.add({ id: "example-bank:0001:export", vendor: "example", connector: "example-bank", added_ms: 0 });
      tx.tables.sources.add({ id: "example-bank:0002:export", vendor: "example", connector: "example-moved", added_ms: 0 });
      tx.tables.meta.set("read-folder:example-moved", "example-bank");
      tx.tables.meta.set("read-folder:example-gone", "gone");
    });
    const admitted = await recorded();
    const index = join(folder, "index.ts");
    writeFileSync(index, readFileSync(index, "utf8").replace("export const contract = 3;", "export const contract = 1;"));
    home((tx) => tx.tables.meta.set(`read-folder:${held}`, "example-bank"));
    const refused = await recorded();
    const checked = await selfCheckHere(root);
    writeArtifact("self-check-stale", { admitted, refused, checked });
    expect(admitted).toEqual([{ key: "read-folder:example-bank", value: "example-bank" }]);
    expect(refused).toEqual([{ key: "read-folder:example-bank", value: "example-bank" }]);
    expect(checked.problems).toEqual(["source example-bank:0002:export names connector example-moved, which this release lacks"]);
  });

  it("a release's runner does not start from its folder: dist/runner.mjs never dials its door, or runs as a leash on its own arguments; the leash beside it runs no program under its lock", async () => {
    const release = tempDir("release-runner");
    cleanup.push(() => removeDir(release));
    const root = repoRoot();
    cpSync(join(root, "packages"), join(release, "packages"), { recursive: true, filter: (from) => !["node_modules", ".build"].includes(basename(from)) });
    cpSync(join(root, "package.json"), join(release, "package.json"));
    symlinkSync(join(root, "node_modules"), join(release, "node_modules"));
    bundleEntries(release, { commit: "c".repeat(40), generation: 1 });

    const exchanges: { path: string | undefined; device: unknown; runner: { version: string; files: unknown[] } }[] = [];
    const door = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
      request.on("end", () => exchanges.push({ path: request.url, device: request.headers["lifestream-device"], runner: (JSON.parse(body) as { runner: { version: string; files: unknown[] } }).runner }));
      response.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => door.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => {
      door.closeAllConnections();
      door.close();
    });
    writeFileSync(join(release, "door-token"), "synthetic-runner-pass\n");
    const runner = spawn(process.execPath, [join(release, "dist", "runner.mjs"), "serve", "--door", `http://127.0.0.1:${(door.address() as AddressInfo).port}`, "--pass", join(release, "door-token"), "--files", join(release, "models")], { stdio: ["ignore", "ignore", "pipe"] });
    let said = "";
    runner.stderr!.on("data", (chunk: Buffer) => { said += chunk.toString("utf8"); });
    const exited = new Promise<number | null>((resolve) => runner.once("exit", (code) => resolve(code)));
    cleanup.push(() => runner.kill("SIGKILL"));
    await until("the release's runner dials its door", () => exchanges.length > 0).catch((error: Error) => { throw new Error(`${error.message}; it said ${said}`); });
    expect(exchanges[0]).toMatchObject({ path: "/v1/runners/exchange", device: `runner/${RUNNER_WIRE_VERSION}`, runner: { version: RUNNER_WIRE_VERSION } });
    expect(exchanges[0]!.runner.files.length).toBeGreaterThan(0);
    runner.kill("SIGTERM");
    expect(await exited).toBe(0);

    const leash = spawn(process.execPath, [join(release, "dist", "leash.mjs"), join(release, "child.lock"), "/bin/sh", "-c", "exit 7"], { stdio: ["pipe", "ignore", "pipe"] });
    expect(await new Promise<number | null>((resolve) => leash.once("exit", (code) => resolve(code)))).toBe(7);
    writeArtifact("release-runner", { exchanges: exchanges.length, first: exchanges[0]!.path });
  });
  it("a released home does not load a connector folder dropped into its home through its hook and dist/sdk.mjs, or `lifestream connectors test` fails on a proof folder from the release's own node (the release smoke)", () => {
    const machine = tempDir("release-proof");
    cleanup.push(() => removeDir(machine));
    const commit = "d".repeat(40);
    const release = join(machine, "releases", commit);
    const root = repoRoot();
    cpSync(join(root, "packages"), join(release, "packages"), { recursive: true, filter: (from) => !["node_modules", ".build", "proof"].includes(basename(from)) });
    cpSync(join(root, "package.json"), join(release, "package.json"));
    cpSync(join(root, "design", "icons.json"), join(release, "design", "icons.json"));
    symlinkSync(join(root, "node_modules"), join(release, "node_modules"));
    bundleEntries(release, { commit, generation: 1 });
    symlinkSync(release, join(machine, "current"));
    cpSync(join(process.env.LIFESTREAM_MACHINE_DIR!, "machine.json"), join(machine, "machine.json"));
    const env: NodeJS.ProcessEnv = { ...process.env, LIFESTREAM_MACHINE_DIR: machine };
    delete env.LIFESTREAM_TEST_DIST;
    const proof = join(root, "packages", "home", "test", "proof");
    const home = (...args: string[]) => {
      const started = performance.now();
      const run = spawnSync(process.execPath, [join(machine, "current", "dist", "home.mjs"), ...args], { cwd: machine, env, encoding: "utf8" });
      return { status: run.status, out: run.stdout, err: run.stderr, ms: Math.round(performance.now() - started) };
    };
    const homes = { none: join(machine, "home-none"), five: join(machine, "home-five") };
    for (const at of Object.values(homes)) {
      writeFolder(at);
      openHome(openHomeFolder(at), "migrate").close();
      mkdirSync(join(at, "connectors"));
    }
    for (const id of readdirSync(proof)) cpSync(join(proof, id), join(homes.five, "connectors", id), { recursive: true });

    const tested = home("connectors", "test", join(proof, "example-log"));
    const said = (run: { err: string }) => run.err.split("\n").filter((line) => !/ExperimentalWarning|--trace-warnings/u.test(line) && line !== "");
    expect([tested.status, tested.out, said(tested)]).toEqual([0, expect.stringContaining("example-log passes the conformance run"), []]);
    const none = home("connectors", "show", "gmail", "--root", homes.none);
    const five = home("connectors", "show", "example-log", "--root", homes.five);
    expect([none.status, said(none)]).toEqual([0, []]);
    expect([five.status, five.out, said(five)]).toEqual([0, expect.stringContaining("file"), []]);
    expect(readdirSync(join(machine, "generations")).filter((name) => !name.startsWith(".")).length).toBe(5);
    renameSync(join(release, "dist", "sdk.mjs"), join(release, "dist", "sdk.aside"));
    const bare = home("connectors", "test", join(proof, "example-log"));
    renameSync(join(release, "dist", "sdk.aside"), join(release, "dist", "sdk.mjs"));
    expect([bare.status, `${bare.out}${bare.err}`]).toEqual([1, expect.stringMatching(/sdk\.mjs/u)]);
    writeArtifact("release-proof", { start_ms: { none: none.ms, five: five.ms }, tested: tested.out.trim().split("\n").at(-1) });
  });
});

function keyedFixture(root: string): void {
  const made = spawnSync(process.execPath, ["--import", "tsx", KEYED_PROBE, root, "keyed"], { encoding: "utf8" });
  if (made.status !== 0) throw new Error(`the keyed fixture: ${made.stderr}`);
}

function withoutReadsKeyed(release: string): void {
  const { reads_keyed: _dropped, ...manifest } = readManifest(release)!;
  writeFileSync(join(release, "RELEASE.json"), JSON.stringify(manifest));
}

describe("a keyed home's update", () => {
  it("installs a newer release with no home running and no key held, refuses an older schema by the stamp, and refuses a release that does not read a keyed home, on install and on rollback", () => {
    const repo = tempDir("keyed-repo");
    const builds = tempDir("keyed-builds");
    const app = tempDir("keyed-app");
    const dir = tempDir("keyed-dir");
    const root = tempDir("keyed-root");
    cleanup.push(() => removeDir(repo), () => removeDir(builds), () => removeDir(app), () => removeDir(dir), () => removeDir(root));
    keyedFixture(root);
    writeFolder(root);
    expect(readFileSync(join(root, "home.db")).subarray(0, 16).toString("latin1")).not.toBe("SQLite format 3\0");
    expect(formOf(root)).toBe("keyed");
    const at = homeSchema.latest;
    git(repo, "init", "-q");
    commit(repo, { ...NVMRC, "versions.txt": versions(at - 1, homeSchema.base, ledgerSchema.latest), "packages/home/release.json": "{}" }, "c0: one schema behind");
    const older = git(repo, "rev-parse", "HEAD");
    const c1 = commit(repo, { "versions.txt": versions(at, homeSchema.base, ledgerSchema.latest) }, "c1: the home's schema");
    const c2 = commit(repo, { "README.md": "synthetic\n" }, "c2: the home's schema, again");
    const system = fakeLaunchd([jobLabel("home"), jobLabel("door")]);
    try {
      const host: ReleaseHost = { dir, root, init: system.init };
      const node = nodeScript(builds);
      const built = (revision: string) => buildRelease({ repo, commit: revision, into: builds, now: ticks(), node, install: () => undefined, compile, engine }).release;
      const refusal = (run: () => unknown) => {
        const before = currentRelease(dir);
        try {
          run();
        } catch (error) {
          expect(currentRelease(dir)).toBe(before);
          return (error as Error).message;
        }
        return "admitted";
      };
      const legacy = join(app, "legacy");
      cpSync(built(c1), legacy, { recursive: true, verbatimSymlinks: true });
      withoutReadsKeyed(legacy);
      const unkeyed = `this home is encrypted, and release ${c1} was built before releases read an encrypted home: it would take home.db for a damaged file`;

      expect(refusal(() => install(host, legacy))).toBe(unkeyed);
      expect(install(host, built(c1))).toMatchObject({ release: c1, previous: null });
      expect(refusal(() => install(host, built(older)))).toBe(`home.db is at version ${at}; release ${older} reads ${at - 1}: fix forward`);
      expect(install(host, built(c2))).toMatchObject({ release: c2, previous: c1 });
      withoutReadsKeyed(join(dir, "releases", c1));
      expect(refusal(() => rollback(host, c1))).toBe(unkeyed);

      const stamp = join(root, "config", "stores.json");
      const kept = readFileSync(stamp, "utf8");
      writeFileSync(stamp, "{");
      expect(refusal(() => install(host, built(older)))).toBe(`this home is encrypted and ${join("config", "stores.json")} does not say home.db's version, so only a release at least as new as this one is installed: release ${older} reads ${at - 1}, this one ${at}`);
      expect(install(host, built(c1))).toMatchObject({ release: c1, previous: c2 });
      expect(refusal(() => rollback(host, c2))).toMatch(/does not say home\.db's version, so no rollback can tell/u);
      writeFileSync(stamp, kept);
      expect(JSON.parse(kept)).toMatchObject({ "home.db": at });
    } finally {
      system.stop();
    }
  });

  it("reads a folder adopted keyed with no store yet as keyed, and a plain home with a damaged vault.json as plain, whose install is today's", () => {
    const repo = tempDir("adopted-repo");
    const builds = tempDir("adopted-builds");
    const dir = tempDir("adopted-dir");
    const adopted = tempDir("adopted-root");
    const plain = tempDir("adopted-plain");
    cleanup.push(() => removeDir(repo), () => removeDir(builds), () => removeDir(dir), () => removeDir(adopted), () => removeDir(plain));
    writeFolder(adopted);
    writeFileSync(join(adopted, "config", "vault.json"), JSON.stringify({ version: 2, counter: 1, key_id: "0a0b0c0d", slots: [], keys: [{ kind: "data", id: 1, made_ms: 0, wrapped: "c3ludGhldGlj" }] }));
    openHome(openHomeFolder(plain), "migrate").close();
    writeFolder(plain);
    writeFileSync(join(plain, "config", "vault.json"), "{\"keys\": [");
    expect([formOf(adopted), formOf(plain)]).toEqual(["keyed", "plain"]);
    git(repo, "init", "-q");
    const c0 = commit(repo, { ...NVMRC, "versions.txt": versions(homeSchema.latest, homeSchema.base, ledgerSchema.latest), "packages/home/release.json": "{}" }, "c0");
    const system = fakeLaunchd([jobLabel("home")]);
    try {
      const release = buildRelease({ repo, commit: c0, into: builds, now: ticks(), node: nodeScript(builds), install: () => undefined, compile, engine }).release;
      withoutReadsKeyed(release);
      expect(() => install({ dir, root: adopted, init: system.init }, release)).toThrow(/this home is encrypted, and release .* was built before releases read an encrypted home/u);
      expect(currentRelease(dir)).toBeNull();
      expect(install({ dir, root: plain, init: system.init }, release)).toMatchObject({ release: c0, previous: null });
    } finally {
      system.stop();
    }
  });

  it("a self-check loads the cipher engine: on a keyed home it reads the versions from the stamp, loads the registry and skips the sources, and an engine that does not load refuses it; on a plain home it is said and never refuses", async () => {
    const keyed = tempDir("self-check-keyed");
    const plain = tempDir("self-check-plain");
    cleanup.push(() => removeDir(keyed), () => removeDir(plain));
    keyedFixture(keyed);
    writeFolder(keyed);
    openHome(openHomeFolder(plain), "migrate").close();
    writeFolder(plain);
    const unloadable = () => "synthetic: the engine's binary does not load on this Mac";

    expect(await selfCheckHere(keyed)).toEqual({
      sqlite: expect.any(String), home_db: homeSchema.latest, home_db_base: homeSchema.base, ledger: ledgerSchema.latest, form: "keyed",
      cipher: { loads: true }, found: { home_db: homeSchema.latest, ledger: null }, sources: "a keyed home's sources are checked when it starts", problems: [],
    });
    expect((await selfCheckHere(keyed, undefined, unloadable)).problems).toEqual(["this home is encrypted, and this release's cipher engine does not load here: synthetic: the engine's binary does not load on this Mac"]);
    const registries = tempDir("self-check-registry");
    cleanup.push(() => removeDir(registries));
    const broken = join(registries, "broken-registry.mjs");
    writeFileSync(broken, "export default () => { throw new Error(\"synthetic: the registry does not load\"); };\n");
    expect((await selfCheckHere(keyed, pathToFileURL(broken).href)).problems).toEqual(["a home of this release cannot start: synthetic: the registry does not load"]);
    const stamp = join(keyed, "config", "stores.json");
    writeFileSync(stamp, JSON.stringify({ ...JSON.parse(readFileSync(stamp, "utf8")), "home.db": homeSchema.latest + 1 }));
    expect((await selfCheckHere(keyed)).problems).toEqual([`home.db is at version ${homeSchema.latest + 1}; this release reads ${homeSchema.latest}: a newer release wrote it`]);

    const said = await selfCheckHere(plain, undefined, unloadable);
    expect(said).toMatchObject({ form: "plain", cipher: { failed: "synthetic: the engine's binary does not load on this Mac" }, found: { home_db: homeSchema.latest }, problems: [] });
    expect(said.sources).toBeUndefined();
  });

  it("a release keeps only this Mac's cipher engines, and refuses to build without one for this machine", () => {
    const release = tempDir("prune-cipher");
    cleanup.push(() => removeDir(release));
    const folder = join(release, "node_modules", "better-sqlite3-multiple-ciphers");
    const names = ["darwin-arm64", "darwin-x64", "linux-x64", "linuxmusl-arm64", "win32-x64"].map((name) => `${name}.node`);
    for (const name of names) writeFolderFile(join(folder, "prebuilds", name));
    for (const file of ["deps/sqlite3/sqlite3.c", "src/addon.cpp", "lib/index.js", "build/Release/better_sqlite3.node"]) writeFolderFile(join(folder, file));
    expect(() => pruneCipher(release, "linux-x64")).toThrow("better-sqlite3-multiple-ciphers carries no prebuilt engine for linux-x64");
    pruneCipher(release, "darwin-arm64");
    expect([readdirSync(join(folder, "prebuilds")).sort(), readdirSync(folder).sort()]).toEqual([["darwin-arm64.node", "darwin-x64.node"], ["lib", "prebuilds"]]);
    removeDir(folder);
    expect(() => pruneCipher(release, "darwin-arm64")).toThrow("the release carries no better-sqlite3-multiple-ciphers: an encrypted home could not open its stores");
  });

  it("a release's manifest says reads_keyed only as true", () => {
    const release = tempDir("reads-keyed");
    cleanup.push(() => removeDir(release));
    const manifest = { commit: "c".repeat(40), generation: 1, built_ms: 0, home_db: 1, home_db_base: 1, ledger: 1, sqlite: "3.53.4" };
    writeFileSync(join(release, "RELEASE.json"), JSON.stringify({ ...manifest, reads_keyed: false }));
    expect(() => readManifest(release)).toThrow(/is not a release of this home/u);
    writeFileSync(join(release, "RELEASE.json"), JSON.stringify(manifest));
    expect(readManifest(release)?.reads_keyed).toBeUndefined();
  });
});

function writeFolderFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "synthetic\n");
}
